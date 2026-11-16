// /opt/arena/bin/limit.c
// Compile on macOS: clang -O2 -Wall -Wextra -o /opt/arena/bin/limit arena/bin/limit.c
//
// Runs as `root` via sudoers on the Mac mini so `proc_pid_rusage(RUSAGE_INFO_V4)` can measure and
// enforce the 14 GiB XNU `ri_phys_footprint` cap across every process owned by `p1`/`p2`, while
// the forked child clears `PRIO_DARWIN_BG`, drops privileges directly to `p1`/`p2` via
// `initgroups` + `setgid` + `setuid`, scrubs `environ`, and `execvp`s `sandbox-exec` without an
// intermediate `sudo` or `env` wrapper.
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <libproc.h>
#include <pwd.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/stat.h>
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

static uint64_t sum_kinfo_footprint(int mib_kind, int mib_arg) {
  int mib[4] = {CTL_KERN, KERN_PROC, mib_kind, mib_arg};
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
    pid_t p = procs[i].kp_proc.p_pid;
    if (p <= 0 || p == self_pid) continue;

    struct rusage_info_v4 ru;
    if (proc_pid_rusage(p, RUSAGE_INFO_V4, (rusage_info_t *)&ru) == 0) {
      total_bytes += ru.ri_phys_footprint;
    }
  }

  free(procs);
  return total_bytes;
}

// Sum XNU physical footprint across every process belonging to target_uid (or child_pg process
// group when running unprivileged in local tests).
static uint64_t total_target_footprint(uid_t target_uid, pid_t child_pg, int isolated_uid) {
  if (!isolated_uid) {
    if (child_pg <= 0) return 0;
    uint64_t pgrp_bytes = sum_kinfo_footprint(KERN_PROC_PGRP, (int)child_pg);
    if (pgrp_bytes > 0) return pgrp_bytes;
    struct rusage_info_v4 ru;
    if (proc_pid_rusage(child_pg, RUSAGE_INFO_V4, (rusage_info_t *)&ru) == 0) {
      return ru.ri_phys_footprint;
    }
    return 0;
  }
  return sum_kinfo_footprint(KERN_PROC_UID, (int)target_uid);
}

static void kill_all_target_procs(uid_t target_uid, pid_t child_pg, int isolated_uid) {
  if (child_pg > 0) {
    kill(-child_pg, SIGKILL);
  }
  if (!isolated_uid) return;

  pid_t self_pid = getpid();
  for (int pass = 0; pass < 6; pass++) {
    int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_UID, (int)target_uid};
    size_t buf_size = 0;
    if (sysctl(mib, 4, NULL, &buf_size, NULL, 0) < 0 || buf_size == 0) {
      return;
    }
    buf_size += 16 * sizeof(struct kinfo_proc);
    struct kinfo_proc *procs = NULL;
    for (int attempt = 0; attempt < 3; attempt++) {
      procs = malloc(buf_size);
      if (!procs) return;
      size_t req_size = buf_size;
      if (sysctl(mib, 4, procs, &req_size, NULL, 0) == 0) {
        buf_size = req_size;
        break;
      }
      free(procs);
      procs = NULL;
      if (errno != ENOMEM) return;
      buf_size *= 2;
    }
    if (!procs) return;

    size_t count = buf_size / sizeof(struct kinfo_proc);
    size_t alive = 0;
    for (size_t i = 0; i < count; i++) {
      pid_t p = procs[i].kp_proc.p_pid;
      if (p > 0 && p != self_pid) {
        kill(p, SIGKILL);
        alive++;
      }
    }
    free(procs);
    if (alive == 0) return;
    usleep(5000);
  }
}

static void write_peak_fd(int fd, uint64_t peak_bytes) {
  if (fd < 0) return;
  char buf[32];
  unsigned long long mib = (unsigned long long)((peak_bytes + (1024ULL * 1024ULL - 1ULL)) /
                                                (1024ULL * 1024ULL));
  int len = snprintf(buf, sizeof(buf), "%llu\n", mib);
  if (len > 0) {
    (void)write(fd, buf, (size_t)len);
  }
  close(fd);
}

static void write_peak_file_unprivileged(const char *path, uint64_t peak_bytes) {
  unlink(path);
  int fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0644);
  write_peak_fd(fd, peak_bytes);
}

static void write_peak_ram_safe(
  const char *slot,
  const char *override_path,
  uint64_t peak_bytes
) {
  if (override_path && override_path[0] != '\0') {
    write_peak_file_unprivileged(override_path, peak_bytes);
    return;
  }
  if (!slot || (strcmp(slot, "p1") != 0 && strcmp(slot, "p2") != 0)) return;
  // Write authoritative telemetry exclusively to `/opt/arena/state/peak_ram_%s` via `O_DIRECTORY |
  // O_NOFOLLOW` + `openat(..., O_NOFOLLOW)` so symlink swaps on `/opt/arena/state` fail closed.
  int dir_fd = open("/opt/arena/state", O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  if (dir_fd < 0) return;
  char file_name[32];
  snprintf(file_name, sizeof(file_name), "peak_ram_%s", slot);
  (void)unlinkat(dir_fd, file_name, 0);
  int fd = openat(dir_fd, file_name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0644);
  close(dir_fd);
  write_peak_fd(fd, peak_bytes);
}

int main(int argc, char **argv) {
  int is_privileged = (geteuid() == 0 || geteuid() != getuid());
  const char *override_peak_raw = is_privileged ? NULL : getenv("ARENA_PEAK_RAM_FILE");
  char *override_peak_path = override_peak_raw ? strdup(override_peak_raw) : NULL;

  const char *slot = is_privileged ? NULL : getenv("ARENA_SLOT");
  int cmd_idx = 1;
  if (argc >= 3 && (strcmp(argv[1], "p1") == 0 || strcmp(argv[1], "p2") == 0)) {
    slot = argv[1];
    cmd_idx = 2;
  }
  if (argc <= cmd_idx) {
    fprintf(stderr, "Usage: %s [p1|p2] <program> [args...]\n", argv[0]);
    free(override_peak_path);
    return 2;
  }

  int valid_slot = slot && (strcmp(slot, "p1") == 0 || strcmp(slot, "p2") == 0);
  if (slot && !valid_slot) {
    fprintf(stderr, "Invalid slot: %s\n", slot);
    free(override_peak_path);
    return 2;
  }
  struct passwd *target_pw = valid_slot ? getpwnam(slot) : NULL;

  // Fail closed before `fork()` whenever a slot is requested or `limit` runs as root: never exec
  // an agent without resolving an unprivileged role UID (`>= 500`) and enforcing `sandbox.sb`.
  if (valid_slot && target_pw == NULL) {
    fprintf(stderr, "Failed to resolve slot user: %s\n", slot);
    free(override_peak_path);
    return 126;
  }
  if (is_privileged) {
    if (!valid_slot || target_pw == NULL || target_pw->pw_uid < 500) {
      fprintf(stderr, "Privileged limit invocation requires unprivileged slot p1 or p2\n");
      free(override_peak_path);
      return 126;
    }
    if (argc < cmd_idx + 4 ||
        strcmp(argv[cmd_idx], "/usr/bin/sandbox-exec") != 0 ||
        strcmp(argv[cmd_idx + 1], "-f") != 0 ||
        strcmp(argv[cmd_idx + 2], "/opt/arena/etc/sandbox.sb") != 0) {
      fprintf(stderr, "Privileged limit invocation must execute /opt/arena/etc/sandbox.sb\n");
      free(override_peak_path);
      return 126;
    }
  }

  uid_t target_uid = target_pw ? target_pw->pw_uid : getuid();
  int isolated_uid = valid_slot && target_pw != NULL && target_uid != getuid();

  // Clear LaunchDaemon background QoS (`PRIO_DARWIN_BG` / `IOPOL_THROTTLE`) so agents get full
  // M-series P-core scheduling rather than E-core background throttling.
  (void)setpriority(PRIO_DARWIN_PROCESS, 0, 0);
  (void)setiopolicy_np(IOPOL_TYPE_DISK, IOPOL_SCOPE_PROCESS, IOPOL_DEFAULT);

  signal(SIGINT, forward_signal);
  signal(SIGTERM, forward_signal);
  signal(SIGHUP, forward_signal);

  pid_t pid = fork();
  if (pid < 0) {
    perror("fork");
    free(override_peak_path);
    return 1;
  }

  if (pid == 0) {
    setpgid(0, 0);
    (void)setpriority(PRIO_DARWIN_PROCESS, 0, 0);
    (void)setiopolicy_np(IOPOL_TYPE_DISK, IOPOL_SCOPE_PROCESS, IOPOL_DEFAULT);

    if (valid_slot) {
      char scratch[32];
      snprintf(scratch, sizeof(scratch), "/Volumes/%c%c", slot[0] - 32, slot[1]);

      if (target_uid != getuid()) {
        if (geteuid() != 0) {
          fprintf(stderr, "limit must run as root to drop privileges to %s\n", slot);
          _exit(126);
        }
        if (initgroups(target_pw->pw_name, target_pw->pw_gid) != 0 ||
            setgid(target_pw->pw_gid) != 0 ||
            setuid(target_pw->pw_uid) != 0 ||
            getuid() != target_pw->pw_uid ||
            geteuid() != target_pw->pw_uid ||
            setuid(0) == 0) {
          perror("privilege drop failed");
          _exit(126);
        }
      }

      // Apply RLIMIT_NPROC only after dropping to dedicated UID p1/p2 (never on root or a shared
      // developer UID in local dev/test mode).
      struct rlimit rl_nproc = {MAX_PROCS, MAX_PROCS};
      struct rlimit rl_nofile = {MAX_NOFILE, MAX_NOFILE};
      struct rlimit rl_core = {0, 0};
      if ((isolated_uid && setrlimit(RLIMIT_NPROC, &rl_nproc) != 0) ||
          setrlimit(RLIMIT_NOFILE, &rl_nofile) != 0 ||
          setrlimit(RLIMIT_CORE, &rl_core) != 0 ||
          chdir(scratch) != 0) {
        perror("sandbox resource/workdir setup failed");
        _exit(126);
      }

      static char *empty_env[] = {NULL};
      environ = empty_env;
      setenv("HOME", scratch, 1);
      setenv("TMPDIR", scratch, 1);
      setenv("XDG_CACHE_HOME", scratch, 1);
      setenv("PKMN_STATS_DIR", "/opt/arena/stats", 1);
      setenv("PATH", "/opt/homebrew/bin:/usr/bin:/bin", 1);
      setenv("LANG", "C.UTF-8", 1);
      setenv("PYTHONHASHSEED", "0", 1);
      setenv("OMP_NUM_THREADS", "10", 1);
      setenv("MKL_NUM_THREADS", "10", 1);
      setenv("TORCH_NUM_THREADS", "10", 1);
      setenv("RAYON_NUM_THREADS", "10", 1);
      setenv("ARENA_MEMORY_LIMIT_MB", "14336", 1);
    } else {
      struct rlimit rl_nofile = {MAX_NOFILE, MAX_NOFILE};
      struct rlimit rl_core = {0, 0};
      (void)setrlimit(RLIMIT_NOFILE, &rl_nofile);
      (void)setrlimit(RLIMIT_CORE, &rl_core);
      setenv("PKMN_STATS_DIR", "/opt/arena/stats", 1);
      setenv("OMP_NUM_THREADS", "10", 1);
      setenv("MKL_NUM_THREADS", "10", 1);
      setenv("TORCH_NUM_THREADS", "10", 1);
      setenv("RAYON_NUM_THREADS", "10", 1);
      setenv("ARENA_MEMORY_LIMIT_MB", "14336", 1);
    }

    execvp(argv[cmd_idx], &argv[cmd_idx]);
    perror("execvp");
    _exit(127);
  }

  child_pgid = pid;
  setpgid(pid, pid);
  uint64_t peak_bytes = 0;
  uint64_t last_written_mib = 0;

  while (1) {
    if (terminate_requested) {
      kill_all_target_procs(target_uid, child_pgid, isolated_uid);
    }

    int status = 0;
    struct rusage child_ru;
    memset(&child_ru, 0, sizeof(child_ru));
    pid_t w = wait4(pid, &status, terminate_requested ? 0 : WNOHANG, &child_ru);
    if (w == pid) {
      if (child_ru.ru_maxrss > 0 && (uint64_t)child_ru.ru_maxrss > peak_bytes) {
        peak_bytes = (uint64_t)child_ru.ru_maxrss;
      }
      kill_all_target_procs(target_uid, child_pgid, isolated_uid);
      write_peak_ram_safe(slot, override_peak_path, peak_bytes);
      free(override_peak_path);
      if (WIFEXITED(status)) return WEXITSTATUS(status);
      if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
      return 1;
    }

    uint64_t used = total_target_footprint(target_uid, child_pgid, isolated_uid);
    if (used > peak_bytes) {
      peak_bytes = used;
      uint64_t current_mib = (peak_bytes + (1024ULL * 1024ULL - 1ULL)) / (1024ULL * 1024ULL);
      if (current_mib > last_written_mib) {
        last_written_mib = current_mib;
        write_peak_ram_safe(slot, override_peak_path, peak_bytes);
      }
    }
    if (used > MAX_FOOTPRINT_BYTES) {
      fprintf(stderr,
              "ARENA_OOM: UID %u exceeded 14 GiB physical footprint (%llu bytes)\n",
              (unsigned)target_uid, (unsigned long long)used);
      kill_all_target_procs(target_uid, child_pgid, isolated_uid);
      struct rusage oom_ru;
      memset(&oom_ru, 0, sizeof(oom_ru));
      if (wait4(pid, NULL, 0, &oom_ru) == pid &&
          oom_ru.ru_maxrss > 0 &&
          (uint64_t)oom_ru.ru_maxrss > peak_bytes) {
        peak_bytes = (uint64_t)oom_ru.ru_maxrss;
      }
      write_peak_ram_safe(slot, override_peak_path, peak_bytes);
      free(override_peak_path);
      return 137; // Standard SIGKILL / OOM exit code (128 + 9)
    }

    usleep(POLL_INTERVAL_US);
  }
}
