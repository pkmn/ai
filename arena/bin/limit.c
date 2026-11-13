// /opt/arena/bin/limit.c
// Compile on macOS: clang -O2 -Wall -Wextra -o /opt/arena/bin/limit arena/bin/limit.c
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <pwd.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/sysctl.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

#define MAX_FOOTPRINT_BYTES (14ULL * 1024ULL * 1024ULL * 1024ULL) // 14 GiB
#define MAX_PROCS           256
#define MAX_NOFILE          1024
#define POLL_INTERVAL_US    50000 // 50 ms

static volatile pid_t child_pgid = 0;
static volatile sig_atomic_t terminate_requested = 0;

static void forward_signal(int sig) {
  terminate_requested = sig;
  if (child_pgid > 0) {
    kill(-child_pgid, sig);
  }
}

// Sum XNU physical footprint across every process belonging to target_uid
static uint64_t total_uid_footprint(uid_t target_uid) {
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_UID, (int)target_uid};
  size_t buf_size = 0;
  if (sysctl(mib, 4, NULL, &buf_size, NULL, 0) < 0 || buf_size == 0) {
    return 0;
  }

  // Allocate with headroom and retry with doubled buffer if child forks between sysctl calls
  buf_size += 16 * sizeof(struct kinfo_proc);
  struct kinfo_proc *procs = NULL;
  for (int attempt = 0; attempt < 3; attempt++) {
    procs = malloc(buf_size);
    if (!procs) return 0;
    size_t req_size = buf_size;
    if (sysctl(mib, 4, procs, &req_size, NULL, 0) == 0) {
      buf_size = req_size;
      break;
    }
    free(procs);
    procs = NULL;
    if (errno != ENOMEM) return 0;
    buf_size *= 2;
  }
  if (!procs) return 0;

  size_t count = buf_size / sizeof(struct kinfo_proc);
  uint64_t total_bytes = 0;
  pid_t self_pid = getpid();

  for (size_t i = 0; i < count; i++) {
    pid_t pid = procs[i].kp_proc.p_pid;
    if (pid <= 0 || pid == self_pid) continue;

    struct rusage_info_v4 ru;
    if (proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)&ru) == 0) {
      total_bytes += ru.ri_phys_footprint;
    }
  }

  free(procs);
  return total_bytes;
}

static void kill_all_uid_procs(const char *slot, uid_t target_uid, pid_t child_pg) {
  if (child_pg > 0) {
    kill(-child_pg, SIGKILL);
  }
  if (slot && target_uid != getuid()) {
    pid_t kpid = fork();
    if (kpid == 0) {
      int devnull = open("/dev/null", O_WRONLY);
      if (devnull >= 0) {
        dup2(devnull, STDOUT_FILENO);
        dup2(devnull, STDERR_FILENO);
        close(devnull);
      }
      execl("/usr/bin/sudo", "sudo", "-n", "/usr/bin/killall", "-9", "-u", slot, (char *)NULL);
      _exit(127);
    }
    if (kpid > 0) {
      waitpid(kpid, NULL, 0);
    }
    return;
  }
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_UID, (int)target_uid};
  size_t buf_size = 0;
  if (sysctl(mib, 4, NULL, &buf_size, NULL, 0) < 0 || buf_size == 0) {
    return;
  }
  buf_size += 16 * sizeof(struct kinfo_proc);
  struct kinfo_proc *procs = malloc(buf_size);
  if (!procs) return;
  if (sysctl(mib, 4, procs, &buf_size, NULL, 0) == 0) {
    size_t count = buf_size / sizeof(struct kinfo_proc);
    pid_t self_pid = getpid();
    for (size_t i = 0; i < count; i++) {
      pid_t p = procs[i].kp_proc.p_pid;
      if (p > 0 && p != self_pid) {
        kill(p, SIGKILL);
      }
    }
  }
  free(procs);
}

static void write_peak_file(const char *path, uint64_t peak_bytes) {
  unlink(path);
  int fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  if (fd < 0) return;
  char buf[32];
  unsigned long long mib = (unsigned long long)(peak_bytes / (1024ULL * 1024ULL));
  int len = snprintf(buf, sizeof(buf), "%llu\n", mib);
  if (len > 0) {
    (void)write(fd, buf, (size_t)len);
  }
  close(fd);
}

static void write_peak_ram_safe(const char *slot, uint64_t peak_bytes) {
  if (!slot || (strcmp(slot, "p1") != 0 && strcmp(slot, "p2") != 0)) return;
  // Write authoritative telemetry to pkmn-owned state dir (inaccessible to p1/p2)
  char state_path[64];
  snprintf(state_path, sizeof(state_path), "/opt/arena/state/peak_ram_%s", slot);
  write_peak_file(state_path, peak_bytes);

  char vol_path[64];
  snprintf(vol_path, sizeof(vol_path), "/Volumes/%c%c/.peak_ram", slot[0] - 32, slot[1]);
  write_peak_file(vol_path, peak_bytes);
}

int main(int argc, char **argv) {
  const char *slot = getenv("ARENA_SLOT");
  int cmd_idx = 1;
  if (argc >= 3 && (strcmp(argv[1], "p1") == 0 || strcmp(argv[1], "p2") == 0)) {
    slot = argv[1];
    cmd_idx = 2;
  }
  if (argc <= cmd_idx) {
    fprintf(stderr, "Usage: %s [p1|p2] <program> [args...]\n", argv[0]);
    return 2;
  }

  uid_t target_uid = getuid();
  if (slot && (strcmp(slot, "p1") == 0 || strcmp(slot, "p2") == 0)) {
    struct passwd *pw = getpwnam(slot);
    if (pw) {
      target_uid = pw->pw_uid;
    }
  }

  signal(SIGINT, forward_signal);
  signal(SIGTERM, forward_signal);

  pid_t pid = fork();
  if (pid < 0) {
    perror("fork");
    return 1;
  }

  if (pid == 0) {
    // Put child in its own process group so `kill(-child_pgid, SIGKILL)` kills the whole tree
    setpgid(0, 0);

    // Apply POSIX resource limits inside the child before exec
    struct rlimit rl_nproc = {MAX_PROCS, MAX_PROCS};
    setrlimit(RLIMIT_NPROC, &rl_nproc);

    struct rlimit rl_nofile = {MAX_NOFILE, MAX_NOFILE};
    setrlimit(RLIMIT_NOFILE, &rl_nofile);

    struct rlimit rl_core = {0, 0};
    setrlimit(RLIMIT_CORE, &rl_core);

    if (slot && (strcmp(slot, "p1") == 0 || strcmp(slot, "p2") == 0)) {
      char scratch[32];
      snprintf(scratch, sizeof(scratch), "/Volumes/%c%c", slot[0] - 32, slot[1]);
      if (target_uid != getuid()) {
        // Supervisor runs as `pkmn`; drop child to role account `p1`/`p2` with scrubbed env
        int rem = argc - cmd_idx;
        char **sudo_argv = calloc((size_t)(rem + 12), sizeof(char *));
        if (!sudo_argv) _exit(127);
        char home_kv[64], tmp_kv[64];
        snprintf(home_kv, sizeof(home_kv), "HOME=%s", scratch);
        snprintf(tmp_kv, sizeof(tmp_kv), "TMPDIR=%s", scratch);
        int k = 0;
        sudo_argv[k++] = "/usr/bin/sudo";
        sudo_argv[k++] = "-n";
        sudo_argv[k++] = "-u";
        sudo_argv[k++] = (char *)slot;
        sudo_argv[k++] = "/usr/bin/env";
        sudo_argv[k++] = "-i";
        sudo_argv[k++] = home_kv;
        sudo_argv[k++] = tmp_kv;
        sudo_argv[k++] = "PATH=/usr/bin:/bin";
        sudo_argv[k++] = "LANG=C.UTF-8";
        sudo_argv[k++] = "PYTHONHASHSEED=0";
        for (int i = 0; i < rem; i++) {
          sudo_argv[k++] = argv[cmd_idx + i];
        }
        sudo_argv[k] = NULL;
        execv("/usr/bin/sudo", sudo_argv);
        perror("execv sudo");
        _exit(127);
      }
      static char *empty_env[] = {NULL};
      environ = empty_env;
      setenv("HOME", scratch, 1);
      setenv("TMPDIR", scratch, 1);
      setenv("PATH", "/usr/bin:/bin", 1);
      setenv("LANG", "C.UTF-8", 1);
      setenv("PYTHONHASHSEED", "0", 1);
    }

    execvp(argv[cmd_idx], &argv[cmd_idx]);
    perror("execvp");
    _exit(127);
  }

  child_pgid = pid;
  setpgid(pid, pid);
  uint64_t peak_bytes = 0;

  while (1) {
    if (terminate_requested) {
      if (slot && (strcmp(slot, "p1") == 0 || strcmp(slot, "p2") == 0)) {
        kill_all_uid_procs(slot, target_uid, child_pgid);
      } else {
        kill(-child_pgid, SIGKILL);
      }
    }

    int status = 0;
    struct rusage child_ru;
    memset(&child_ru, 0, sizeof(child_ru));
    pid_t w = wait4(pid, &status, terminate_requested ? 0 : WNOHANG, &child_ru);
    if (w == pid) {
      // On Darwin, ru_maxrss is reported in bytes
      if (child_ru.ru_maxrss > 0 && (uint64_t)child_ru.ru_maxrss > peak_bytes) {
        peak_bytes = (uint64_t)child_ru.ru_maxrss;
      }
      if (slot && (strcmp(slot, "p1") == 0 || strcmp(slot, "p2") == 0)) {
        kill_all_uid_procs(slot, target_uid, child_pgid);
      } else {
        kill(-child_pgid, SIGKILL);
      }
      write_peak_ram_safe(slot, peak_bytes);
      if (WIFEXITED(status)) return WEXITSTATUS(status);
      if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
      return 1;
    }

    uint64_t used = total_uid_footprint(target_uid);
    if (used > peak_bytes) peak_bytes = used;
    if (used > MAX_FOOTPRINT_BYTES) {
      fprintf(stderr,
              "ARENA_OOM: UID %u exceeded 14 GiB physical footprint (%llu bytes)\n",
              (unsigned)target_uid, (unsigned long long)used);
      if (slot && (strcmp(slot, "p1") == 0 || strcmp(slot, "p2") == 0)) {
        kill_all_uid_procs(slot, target_uid, child_pgid);
      } else {
        kill(-child_pgid, SIGKILL);
      }
      struct rusage oom_ru;
      memset(&oom_ru, 0, sizeof(oom_ru));
      if (wait4(pid, NULL, 0, &oom_ru) == pid &&
          oom_ru.ru_maxrss > 0 &&
          (uint64_t)oom_ru.ru_maxrss > peak_bytes) {
        peak_bytes = (uint64_t)oom_ru.ru_maxrss;
      }
      write_peak_ram_safe(slot, peak_bytes);
      return 137; // Standard SIGKILL / OOM exit code (128 + 9)
    }

    usleep(POLL_INTERVAL_US);
  }
}
