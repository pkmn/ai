// /usr/local/bin/tourney-relay.c
// Compile: gcc -O2 -Wall -Wextra -o /usr/local/bin/tourney-relay arena/bin/tourney-relay.c
//
// Measures exact local agent thinking time on the Worker VM using CLOCK_MONOTONIC,
// completely eliminating SSH / WAN network round-trip latency from turn clock accounting:
//   1. Forwards stdin lines from sshd -> agent stdin.
//   2. The instant a `|request|` line (that is not `"wait":true`) is written to the agent's stdin,
//      starts a local monotonic stopwatch (`timer_active = 1`).
//   3. Forwards stdout lines from agent -> sshd stdout.
//   4. The instant the agent outputs a non-empty line while `timer_active == 1`, stops the
//      local stopwatch and emits `ARENA_TURN_MS=<elapsed_ms>\n` on stderr BEFORE forwarding
//      the choice line on stdout.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define LINE_BUF_CAP 65536

struct line_buf {
  char data[LINE_BUF_CAP];
  size_t len;
};

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
  if (strncmp(line, "|tournament|byot|", 17) == 0) {
    return 1;
  }
  if (
    strncmp(line, "|error|[Invalid choice]", 23) == 0 ||
    strncmp(line, "|error|[Unavailable choice]", 27) == 0
  ) {
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

static volatile pid_t child_pgid = 0;

static void handle_term_signal(int sig) {
  (void)sig;
  if (child_pgid > 0) {
    kill(-child_pgid, SIGKILL);
  }
  _exit(1);
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "Usage: %s <program> [args...]\n", argv[0]);
    return 2;
  }

  int in_pipe[2], out_pipe[2];
  if (pipe(in_pipe) < 0 || pipe(out_pipe) < 0) {
    perror("pipe");
    return 1;
  }

  signal(SIGINT, handle_term_signal);
  signal(SIGTERM, handle_term_signal);
  signal(SIGHUP, handle_term_signal);

  pid_t pid = fork();
  if (pid < 0) {
    perror("fork");
    return 1;
  }

  if (pid == 0) {
    setpgid(0, 0);
    dup2(in_pipe[0], STDIN_FILENO);
    dup2(out_pipe[1], STDOUT_FILENO);
    int devnull = open("/dev/null", O_WRONLY);
    if (devnull >= 0) {
      dup2(devnull, STDERR_FILENO);
      if (devnull > STDERR_FILENO) close(devnull);
    } else {
      close(STDERR_FILENO);
    }
    close(in_pipe[0]);
    close(in_pipe[1]);
    close(out_pipe[0]);
    close(out_pipe[1]);
    execvp(argv[1], &argv[1]);
    _exit(127);
  }

  child_pgid = pid;
  setpgid(pid, pid);

  close(in_pipe[0]);
  close(out_pipe[1]);

  int timer_active = 0;
  uint64_t turn_start_ns = 0;

  struct pollfd fds[2];
  fds[0].fd = STDIN_FILENO;
  fds[0].events = POLLIN;
  fds[1].fd = out_pipe[0];
  fds[1].events = POLLIN;

  struct line_buf in_buf = {{0}, 0};
  struct line_buf out_buf = {{0}, 0};
  char chunk[4096];

  while (poll(fds, 2, -1) > 0) {
    // 1. Arbiter -> Agent stdin (unbuffered read so poll() never misses batched lines)
    if (fds[0].fd >= 0 && (fds[0].revents & (POLLIN | POLLHUP))) {
      ssize_t n = read(STDIN_FILENO, chunk, sizeof(chunk));
      if (n <= 0) {
        close(in_pipe[1]);
        fds[0].fd = -1;
      } else {
        if (in_buf.len + (size_t)n >= LINE_BUF_CAP) {
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
            turn_start_ns = monotonic_ns();
            timer_active = 1;
          }
          in_buf.data[line_len] = saved;
          if (write_all(in_pipe[1], in_buf.data, line_len) < 0) goto done;
          memmove(in_buf.data, in_buf.data + line_len, in_buf.len - line_len);
          in_buf.len -= line_len;
        }
      }
    }

    // 2. Agent stdout -> Arbiter
    if (fds[1].revents & (POLLIN | POLLHUP)) {
      ssize_t n = read(out_pipe[0], chunk, sizeof(chunk));
      if (n <= 0) break;
      if (out_buf.len + (size_t)n >= LINE_BUF_CAP) {
        out_buf.len = 0;
      }
      memcpy(out_buf.data + out_buf.len, chunk, (size_t)n);
      out_buf.len += (size_t)n;

      char *nl = NULL;
      while ((nl = memchr(out_buf.data, '\n', out_buf.len)) != NULL) {
        size_t line_len = (size_t)(nl - out_buf.data) + 1;
        size_t content_len = line_len - 1;
        if (content_len > 0 && out_buf.data[content_len - 1] == '\r') {
          content_len--;
        }
        if (timer_active && content_len > 0) {
          uint64_t now_ns = monotonic_ns();
          uint64_t elapsed_ns = now_ns > turn_start_ns ? now_ns - turn_start_ns : 1ULL;
          uint64_t elapsed_ms = (elapsed_ns + 999999ULL) / 1000000ULL;
          fprintf(stderr, "ARENA_TURN_MS=%llu\n", (unsigned long long)elapsed_ms);
          fflush(stderr);
          turn_start_ns = now_ns;
        }
        if (write_all(STDOUT_FILENO, out_buf.data, line_len) < 0) goto done;
        memmove(out_buf.data, out_buf.data + line_len, out_buf.len - line_len);
        out_buf.len -= line_len;
      }
    }
  }

  int status = 0;
done:
  if (child_pgid > 0) {
    kill(-child_pgid, SIGKILL);
  }
  waitpid(pid, &status, 0);
  if (WIFEXITED(status)) {
    int code = WEXITSTATUS(status);
    // Reserve exit code 255 exclusively for OpenSSH transport errors so an agent calling
    // `exit(255)` cannot spoof a Spot VM preemption / SSH disconnect.
    return code == 255 ? 1 : code;
  }
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return 1;
}
