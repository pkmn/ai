// /usr/local/bin/tourney-relay.c
// Compile: gcc -O2 -Wall -Wextra -o /usr/local/bin/tourney-relay arena/bin/tourney-relay.c
//
// Measures exact local agent thinking time on the Worker VM using CLOCK_MONOTONIC,
// completely eliminating SSH / WAN network round-trip latency from turn clock accounting:
//   1. Forwards stdin lines from sshd -> agent stdin over a non-blocking pipe so an agent that
//      never reads stdin cannot wedge disconnect or EOF cleanup.
//   2. Each actionable `|request|` (non-wait) line increments `req_seq`
//      and starts a local monotonic stopwatch (`timer_active = 1`).
//   3. Forwards stdout lines from agent -> sshd stdout, tagging every newline (including empty
//      and `/info` lines) on stderr as `ARENA_TURN_MS=<cumulative_ms>\t<req_seq>\t<stdout_seq>\n`
//      measuring cumulative monotonic elapsed time since the active `|request|` arrival so
//      out-of-band `/info` interception can never desync or reset turn clock accounting.
//   4. Captures child stderr over a dedicated pipe and forwards bounded head+tail lines prefixed
//      with `ARENA_AGENT_STDERR=` so diagnostics preserve agent tracebacks without allowing an
//      untrusted child to spoof `ARENA_TURN_MS=`, `ARENA_PEAK_RAM=`, `ARENA_SPOT_PREEMPTED`, or
//      `TOURNEY_ERROR:` control lines or flood SSH.
//   5. Places the child in a dedicated session (`setsid()`), closes all inherited FDs >= 3, and
//      terminates `-child_pgid` with `SIGKILL` immediately if stdout breaks (`POLLHUP`/`POLLERR`)
//      or within 100ms of stdin EOF so SSH disconnects never orphan GPU processes.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define IN_BUF_CAP       262144
#define OUT_BUF_CAP      65536
#define PIPE_OUT_BUF_CAP 524288
#define ERR_HEAD_CAP     16384
#define ERR_TAIL_CAP     49152
#define ERR_LINE_MAX     2048

struct in_line_buf {
  char data[IN_BUF_CAP];
  size_t len;
};

struct out_line_buf {
  char data[OUT_BUF_CAP];
  size_t len;
};

struct pipe_out_buf {
  char data[PIPE_OUT_BUF_CAP];
  size_t len;
};

struct err_capture {
  size_t head_sent;
  size_t dropped;
  char tail[ERR_TAIL_CAP];
  size_t tail_pos;
  size_t tail_len;
  char line[ERR_LINE_MAX];
  size_t line_len;
};

static void flush_err_line(struct err_capture *cap) {
  if (cap->line_len == 0) return;
  fwrite("ARENA_AGENT_STDERR=", 1, 19, stderr);
  fwrite(cap->line, 1, cap->line_len, stderr);
  fputc('\n', stderr);
  cap->line_len = 0;
}

static void emit_err_chunk(struct err_capture *cap, const char *buf, size_t len) {
  for (size_t i = 0; i < len; i++) {
    unsigned char ch = (unsigned char)buf[i];
    if (ch == '\r' || ch == '\0') continue;
    if (ch == '\n') {
      fwrite("ARENA_AGENT_STDERR=", 1, 19, stderr);
      if (cap->line_len > 0) {
        fwrite(cap->line, 1, cap->line_len, stderr);
        cap->line_len = 0;
      }
      fputc('\n', stderr);
      continue;
    }
    cap->line[cap->line_len++] = (char)ch;
    if (cap->line_len >= ERR_LINE_MAX) {
      flush_err_line(cap);
    }
  }
  fflush(stderr);
}

static void feed_err_capture(struct err_capture *cap, const char *buf, size_t len) {
  if (len == 0) return;
  if (cap->head_sent < ERR_HEAD_CAP) {
    size_t take = ERR_HEAD_CAP - cap->head_sent;
    if (take > len) take = len;
    emit_err_chunk(cap, buf, take);
    cap->head_sent += take;
    buf += take;
    len -= take;
    if (len > 0 && cap->line_len > 0) {
      flush_err_line(cap);
      fflush(stderr);
    }
  }
  if (len == 0) return;
  if (len >= ERR_TAIL_CAP) {
    cap->dropped += cap->tail_len + (len - ERR_TAIL_CAP);
    memcpy(cap->tail, buf + (len - ERR_TAIL_CAP), ERR_TAIL_CAP);
    cap->tail_pos = 0;
    cap->tail_len = ERR_TAIL_CAP;
    return;
  }
  if (cap->tail_len + len > ERR_TAIL_CAP) {
    size_t overflow = cap->tail_len + len - ERR_TAIL_CAP;
    cap->dropped += overflow;
    cap->tail_pos = (cap->tail_pos + overflow) % ERR_TAIL_CAP;
    cap->tail_len -= overflow;
  }
  size_t write_pos = (cap->tail_pos + cap->tail_len) % ERR_TAIL_CAP;
  size_t first = ERR_TAIL_CAP - write_pos;
  if (first > len) first = len;
  memcpy(cap->tail + write_pos, buf, first);
  if (len > first) {
    memcpy(cap->tail, buf + first, len - first);
  }
  cap->tail_len += len;
}

static void finish_err_capture(struct err_capture *cap) {
  if (cap->line_len > 0) {
    flush_err_line(cap);
  }
  if (cap->tail_len > 0) {
    if (cap->dropped > 0) {
      fprintf(stderr, "ARENA_AGENT_STDERR=... [truncated %zu bytes] ...\n", cap->dropped);
    }
    size_t first = ERR_TAIL_CAP - cap->tail_pos;
    if (first > cap->tail_len) first = cap->tail_len;
    emit_err_chunk(cap, cap->tail + cap->tail_pos, first);
    if (cap->tail_len > first) {
      emit_err_chunk(cap, cap->tail, cap->tail_len - first);
    }
    if (cap->line_len > 0) {
      flush_err_line(cap);
    }
    cap->tail_len = 0;
    cap->dropped = 0;
  }
  fflush(stderr);
}

static uint64_t monotonic_ns(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
}

static int is_actionable_request(const char *line) {
  if (strncmp(line, "|request|", 9) == 0) {
    const char *json = line + 9;
    while (*json == ' ' || *json == '\t' || *json == '\r' || *json == '\n') json++;
    if (*json == '\0' || strncmp(json, "null", 4) == 0) return 0;
    if (strstr(json, "\"wait\":true") != NULL || strstr(json, "\"wait\": true") != NULL) {
      return 0;
    }
    return 1;
  }
  return 0;
}

static int write_all(int fd, const char *buf, size_t len) {
  size_t off = 0;
  while (off < len) {
    ssize_t w = write(fd, buf + off, len - off);
    if (w < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    off += (size_t)w;
  }
  return 0;
}

static void flush_to_agent(int *fd_ptr, struct pipe_out_buf *buf) {
  int fd = *fd_ptr;
  if (fd < 0 || buf->len == 0) return;
  size_t off = 0;
  while (off < buf->len) {
    ssize_t w = write(fd, buf->data + off, buf->len - off);
    if (w < 0) {
      if (errno == EINTR) continue;
      if (errno == EAGAIN || errno == EWOULDBLOCK) break;
      close(fd);
      *fd_ptr = -1;
      buf->len = 0;
      return;
    }
    off += (size_t)w;
  }
  if (off > 0) {
    if (off < buf->len) {
      memmove(buf->data, buf->data + off, buf->len - off);
    }
    buf->len -= off;
  }
}

static void queue_to_agent(
  int *fd_ptr,
  struct pipe_out_buf *buf,
  const char *src,
  size_t len
) {
  if (*fd_ptr < 0 || len == 0) return;
  flush_to_agent(fd_ptr, buf);
  if (*fd_ptr < 0) return;

  size_t off = 0;
  if (buf->len == 0) {
    while (off < len) {
      ssize_t w = write(*fd_ptr, src + off, len - off);
      if (w < 0) {
        if (errno == EINTR) continue;
        if (errno == EAGAIN || errno == EWOULDBLOCK) break;
        close(*fd_ptr);
        *fd_ptr = -1;
        return;
      }
      off += (size_t)w;
    }
  }

  size_t rem = len - off;
  if (rem == 0) return;
  if (buf->len + rem > PIPE_OUT_BUF_CAP) {
    close(*fd_ptr);
    *fd_ptr = -1;
    buf->len = 0;
    return;
  }
  memcpy(buf->data + buf->len, src + off, rem);
  buf->len += rem;
}

static volatile pid_t child_pgid = 0;
static volatile sig_atomic_t term_requested = 0;

static void handle_term_signal(int sig) {
  (void)sig;
  term_requested = 1;
  if (child_pgid > 0) {
    kill(-child_pgid, SIGKILL);
    kill(child_pgid, SIGKILL);
  }
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "Usage: %s <program> [args...]\n", argv[0]);
    return 2;
  }

  int in_pipe[2], out_pipe[2], err_pipe[2];
  if (pipe(in_pipe) < 0 || pipe(out_pipe) < 0 || pipe(err_pipe) < 0) {
    perror("pipe");
    return 1;
  }

  signal(SIGINT, handle_term_signal);
  signal(SIGTERM, handle_term_signal);
  signal(SIGHUP, handle_term_signal);
  signal(SIGPIPE, SIG_IGN);

  pid_t pid = fork();
  if (pid < 0) {
    perror("fork");
    return 1;
  }

  if (pid == 0) {
    (void)setsid();
    dup2(in_pipe[0], STDIN_FILENO);
    dup2(out_pipe[1], STDOUT_FILENO);
    dup2(err_pipe[1], STDERR_FILENO);
    close(in_pipe[0]);
    close(in_pipe[1]);
    close(out_pipe[0]);
    close(out_pipe[1]);
    close(err_pipe[0]);
    close(err_pipe[1]);
    long max_fd = sysconf(_SC_OPEN_MAX);
    if (max_fd < 0 || max_fd > 65536) max_fd = 4096;
    for (int fd = 3; fd < (int)max_fd; fd++) {
      close(fd);
    }
    execvp(argv[1], &argv[1]);
    _exit(127);
  }

  child_pgid = pid;

  close(in_pipe[0]);
  close(out_pipe[1]);
  close(err_pipe[1]);

  int in_flags = fcntl(in_pipe[1], F_GETFL, 0);
  if (in_flags >= 0) {
    (void)fcntl(in_pipe[1], F_SETFL, in_flags | O_NONBLOCK);
  }

  int timer_active = 0;
  int stdin_eof = 0;
  uint64_t req_seq = 0;
  uint64_t stdout_seq = 0;
  uint64_t turn_start_ns = 0;
  uint64_t eof_deadline_ns = 0;

  struct pollfd fds[5];
  fds[0].fd = STDIN_FILENO;
  fds[0].events = POLLIN;
  fds[1].fd = out_pipe[0];
  fds[1].events = POLLIN;
  fds[2].fd = STDOUT_FILENO;
  fds[2].events = 0;
  fds[3].fd = -1;
  fds[3].events = POLLOUT;
  fds[4].fd = err_pipe[0];
  fds[4].events = POLLIN;

  static struct in_line_buf in_buf;
  static struct out_line_buf out_buf;
  static struct pipe_out_buf pipe_out;
  static struct err_capture err_cap;
  char chunk[4096];

  for (;;) {
    if (term_requested) goto done;
    int timeout_ms = -1;
    if (stdin_eof) {
      uint64_t now_ns = monotonic_ns();
      if (now_ns >= eof_deadline_ns) goto done;
      timeout_ms = (int)((eof_deadline_ns - now_ns + 999999ULL) / 1000000ULL);
    }

    fds[3].fd = (in_pipe[1] >= 0 && pipe_out.len > 0) ? in_pipe[1] : -1;
    fds[4].fd = err_pipe[0];

    int pr = poll(fds, 5, timeout_ms);
    if (pr < 0) {
      if (errno == EINTR) continue;
      goto done;
    }
    if (pr == 0 && stdin_eof) {
      goto done;
    }

    if (fds[2].revents & (POLLERR | POLLHUP | POLLNVAL)) {
      goto done;
    }

    if (fds[3].fd >= 0 && (fds[3].revents & (POLLOUT | POLLERR | POLLHUP))) {
      flush_to_agent(&in_pipe[1], &pipe_out);
      if (stdin_eof && pipe_out.len == 0 && in_pipe[1] >= 0) {
        close(in_pipe[1]);
        in_pipe[1] = -1;
      }
    }

    // 1. Arbiter -> Agent stdin
    if (fds[0].fd >= 0 && (fds[0].revents & (POLLIN | POLLHUP | POLLERR))) {
      ssize_t n = read(STDIN_FILENO, chunk, sizeof(chunk));
      if (n <= 0) {
        if (in_buf.len > 0) {
          queue_to_agent(&in_pipe[1], &pipe_out, in_buf.data, in_buf.len);
          in_buf.len = 0;
        }
        flush_to_agent(&in_pipe[1], &pipe_out);
        if (pipe_out.len == 0 && in_pipe[1] >= 0) {
          close(in_pipe[1]);
          in_pipe[1] = -1;
        }
        fds[0].fd = -1;
        stdin_eof = 1;
        eof_deadline_ns = monotonic_ns() + 100000000ULL;
      } else {
        if (in_buf.len + (size_t)n >= IN_BUF_CAP) {
          queue_to_agent(&in_pipe[1], &pipe_out, in_buf.data, in_buf.len);
          in_buf.len = 0;
        }
        memcpy(in_buf.data + in_buf.len, chunk, (size_t)n);
        in_buf.len += (size_t)n;

        char *nl = NULL;
        while ((nl = memchr(in_buf.data, '\n', in_buf.len)) != NULL) {
          size_t line_len = (size_t)(nl - in_buf.data) + 1;
          char saved = in_buf.data[line_len];
          in_buf.data[line_len] = '\0';
          if (is_actionable_request(in_buf.data)) {
            req_seq++;
            turn_start_ns = monotonic_ns();
            timer_active = 1;
          }
          in_buf.data[line_len] = saved;
          queue_to_agent(&in_pipe[1], &pipe_out, in_buf.data, line_len);
          memmove(in_buf.data, in_buf.data + line_len, in_buf.len - line_len);
          in_buf.len -= line_len;
        }
      }
    }

    // 2. Agent stdout -> Arbiter
    if (fds[1].revents & (POLLIN | POLLHUP | POLLERR)) {
      ssize_t n = read(out_pipe[0], chunk, sizeof(chunk));
      if (n <= 0) break;
      if (out_buf.len + (size_t)n >= OUT_BUF_CAP) {
        // Forward oversized partial line so the arbiter's >64 KiB flood guard kills cleanly.
        if (write_all(STDOUT_FILENO, out_buf.data, out_buf.len) < 0) goto done;
        out_buf.len = 0;
      }
      memcpy(out_buf.data + out_buf.len, chunk, (size_t)n);
      out_buf.len += (size_t)n;

      char *nl = NULL;
      while ((nl = memchr(out_buf.data, '\n', out_buf.len)) != NULL) {
        size_t line_len = (size_t)(nl - out_buf.data) + 1;
        stdout_seq++;
        if (timer_active) {
          uint64_t now_ns = monotonic_ns();
          uint64_t elapsed_ns = now_ns > turn_start_ns ? now_ns - turn_start_ns : 1ULL;
          uint64_t elapsed_ms = (elapsed_ns + 999999ULL) / 1000000ULL;
          fprintf(
            stderr,
            "ARENA_TURN_MS=%llu\t%llu\t%llu\n",
            (unsigned long long)elapsed_ms,
            (unsigned long long)req_seq,
            (unsigned long long)stdout_seq
          );
          fflush(stderr);
        }
        if (write_all(STDOUT_FILENO, out_buf.data, line_len) < 0) goto done;
        memmove(out_buf.data, out_buf.data + line_len, out_buf.len - line_len);
        out_buf.len -= line_len;
      }
    }

    // 3. Agent stderr -> prefixed relay stderr (bounded head+tail)
    if (fds[4].fd >= 0 && (fds[4].revents & (POLLIN | POLLHUP | POLLERR))) {
      ssize_t n = read(err_pipe[0], chunk, sizeof(chunk));
      if (n <= 0) {
        close(err_pipe[0]);
        err_pipe[0] = -1;
        finish_err_capture(&err_cap);
      } else {
        feed_err_capture(&err_cap, chunk, (size_t)n);
      }
    }
  }

  int status = 0;
done:
  if (in_pipe[1] >= 0) {
    close(in_pipe[1]);
  }
  if (child_pgid > 0) {
    kill(-child_pgid, SIGKILL);
    kill(child_pgid, SIGKILL);
  }
  waitpid(pid, &status, 0);
  if (err_pipe[0] >= 0) {
    int err_flags = fcntl(err_pipe[0], F_GETFL, 0);
    if (err_flags >= 0) {
      (void)fcntl(err_pipe[0], F_SETFL, err_flags | O_NONBLOCK);
    }
    for (;;) {
      ssize_t n = read(err_pipe[0], chunk, sizeof(chunk));
      if (n > 0) {
        feed_err_capture(&err_cap, chunk, (size_t)n);
      } else if (n < 0 && errno == EINTR) {
        continue;
      } else {
        break;
      }
    }
    close(err_pipe[0]);
    err_pipe[0] = -1;
    finish_err_capture(&err_cap);
  }
  struct rusage ru;
  if (getrusage(RUSAGE_CHILDREN, &ru) == 0 && ru.ru_maxrss > 0) {
#ifdef __APPLE__
    unsigned long long peak_mib =
      (unsigned long long)((ru.ru_maxrss + (1024ULL * 1024ULL - 1ULL)) / (1024ULL * 1024ULL));
#else
    unsigned long long peak_mib = (unsigned long long)((ru.ru_maxrss + 1023ULL) / 1024ULL);
#endif
    if (peak_mib < 1ULL) peak_mib = 1ULL;
    fprintf(stderr, "ARENA_PEAK_RAM=%llu\n", peak_mib);
    fflush(stderr);
  }
  if (WIFEXITED(status)) {
    int code = WEXITSTATUS(status);
    // Reserve exit code 255 exclusively for OpenSSH transport errors so an agent calling
    // `exit(255)` cannot spoof a Spot VM preemption / SSH disconnect.
    return code == 255 ? 1 : code;
  }
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return 1;
}
