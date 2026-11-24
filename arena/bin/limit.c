// /opt/arena/bin/limit.c
// Compile on macOS: clang -O2 -Wall -Wextra -o /opt/arena/bin/limit arena/bin/limit.c
//
// Runs strictly as `root` via sudoers on the Mac mini (intentionally fail-closed exit 126 with no
// unprivileged dev/test mode) so `proc_pid_rusage(RUSAGE_INFO_V4)` can measure and enforce the
// 14 GiB XNU `ri_phys_footprint` cap across every process owned by `p1`/`p2`, while the forked
// child clears `PRIO_DARWIN_BG`, drops privileges directly to `p1`/`p2` via `initgroups` +
// `setgid` + `setuid`, scrubs `environ`, and `execvp`s `sandbox-exec` without an intermediate
// `sudo` or `env` wrapper.
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <libproc.h>
#include <mach/mach_time.h>
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

static mach_timebase_info_data_t timebase_info = {0, 0};

static uint64_t mach_ticks_to_millis(uint64_t ticks) {
  if (timebase_info.denom == 0) {
    mach_timebase_info(&timebase_info);
  }
  if (timebase_info.denom == 0) return 0;
  __uint128_t nanos = ((__uint128_t)ticks * (__uint128_t)timebase_info.numer) /
                      (__uint128_t)timebase_info.denom;
  return (uint64_t)(nanos / 1000000ULL);
}

static uint64_t rusage_cpu_millis(const struct rusage *ru) {
  uint64_t user_ms = (uint64_t)ru->ru_utime.tv_sec * 1000ULL +
                     (uint64_t)ru->ru_utime.tv_usec / 1000ULL;
  uint64_t sys_ms = (uint64_t)ru->ru_stime.tv_sec * 1000ULL +
                    (uint64_t)ru->ru_stime.tv_usec / 1000ULL;
  return user_ms + sys_ms;
}

static void sum_uid_usage(uid_t target_uid, uint64_t *out_bytes, uint64_t *out_cpu_millis) {
  *out_bytes = 0;
  *out_cpu_millis = 0;
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_UID, (int)target_uid};
  size_t buf_size = 0;
  if (sysctl(mib, 4, NULL, &buf_size, NULL, 0) < 0 || buf_size == 0) {
    return;
  }

  // Allocate with headroom and retry with doubled buffer if child forks between sysctl calls
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
  uint64_t total_bytes = 0;
  uint64_t total_cpu_ticks = 0;
  pid_t self_pid = getpid();

  for (size_t i = 0; i < count; i++) {
    pid_t p = procs[i].kp_proc.p_pid;
    if (p <= 0 || p == self_pid) continue;

    struct rusage_info_v4 ru;
    if (proc_pid_rusage(p, RUSAGE_INFO_V4, (rusage_info_t *)&ru) == 0) {
      total_bytes += ru.ri_phys_footprint;
      // Include reaped child CPU time (`ri_child_*`) so short-lived worker subprocesses
      // spawned and waited between 50ms polls are still accounted for without double-counting
      // live children (XNU only folds child ticks into `ri_child_*` upon `wait`).
      total_cpu_ticks += ru.ri_user_time + ru.ri_system_time +
                         ru.ri_child_user_time + ru.ri_child_system_time;
    }
  }

  free(procs);
  *out_bytes = total_bytes;
  *out_cpu_millis = mach_ticks_to_millis(total_cpu_ticks);
}

static void kill_all_target_procs(uid_t target_uid, pid_t child_pg) {
  if (child_pg > 0) {
    kill(-child_pg, SIGKILL);
  }

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

static void write_state_u64(const char *prefix, const char *slot, unsigned long long value) {
  // Write authoritative telemetry atomically to `/opt/arena/state/peak_ram_%s` and
  // `/opt/arena/state/cpu_millis_%s` via `O_DIRECTORY | O_NOFOLLOW`, a temp file, and `renameat`
  // so symlink swaps fail closed and `arbiter.ts` never observes an ENOENT or truncated gap.
  int dir_fd = open("/opt/arena/state", O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  if (dir_fd < 0) return;
  char file_name[48];
  char tmp_name[80];
  snprintf(file_name, sizeof(file_name), "%s_%s", prefix, slot);
  snprintf(tmp_name, sizeof(tmp_name), "%s_%s.tmp.%ld", prefix, slot, (long)getpid());
  (void)unlinkat(dir_fd, tmp_name, 0);
  int fd = openat(dir_fd, tmp_name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0644);
  if (fd < 0) {
    close(dir_fd);
    return;
  }
  char buf[32];
  int len = snprintf(buf, sizeof(buf), "%llu\n", value);
  int ok = 0;
  if (len > 0) {
    ssize_t written = write(fd, buf, (size_t)len);
    ok = (written == (ssize_t)len);
  }
  close(fd);
  if (!ok || renameat(dir_fd, tmp_name, dir_fd, file_name) != 0) {
    (void)unlinkat(dir_fd, tmp_name, 0);
  }
  close(dir_fd);
}

static void write_peak_ram(const char *slot, uint64_t peak_bytes) {
  unsigned long long mib = (unsigned long long)((peak_bytes + (1024ULL * 1024ULL - 1ULL)) /
                                                (1024ULL * 1024ULL));
  write_state_u64("peak_ram", slot, mib);
}

static void write_cpu_millis(const char *slot, uint64_t cpu_millis) {
  write_state_u64("cpu_millis", slot, (unsigned long long)cpu_millis);
}

int main(int argc, char **argv) {
  // Fail closed before `fork()`: require root, dedicated slot `p1`/`p2` (UID >= 500), and
  // `/usr/bin/sandbox-exec -f /opt/arena/etc/sandbox.sb`.
  if (geteuid() != 0) {
    fprintf(stderr, "limit must run as root via sudoers\n");
    return 126;
  }
  if (argc < 6 || (strcmp(argv[1], "p1") != 0 && strcmp(argv[1], "p2") != 0)) {
    fprintf(
      stderr,
      "Usage: %s <p1|p2> /usr/bin/sandbox-exec -f /opt/arena/etc/sandbox.sb <args...>\n",
      argv[0]
    );
    return 126;
  }
  const char *slot = argv[1];
  struct passwd *target_pw = getpwnam(slot);
  if (target_pw == NULL || target_pw->pw_uid < 500) {
    fprintf(stderr, "Failed to resolve unprivileged slot user: %s\n", slot);
    return 126;
  }
  if (strcmp(argv[2], "/usr/bin/sandbox-exec") != 0 ||
      strcmp(argv[3], "-f") != 0 ||
      strcmp(argv[4], "/opt/arena/etc/sandbox.sb") != 0) {
    fprintf(stderr, "limit must execute /usr/bin/sandbox-exec -f /opt/arena/etc/sandbox.sb\n");
    return 126;
  }

  uid_t target_uid = target_pw->pw_uid;

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
    return 1;
  }

  if (pid == 0) {
    setpgid(0, 0);
    (void)setpriority(PRIO_DARWIN_PROCESS, 0, 0);
    (void)setiopolicy_np(IOPOL_TYPE_DISK, IOPOL_SCOPE_PROCESS, IOPOL_DEFAULT);

    char scratch[64];
    snprintf(scratch, sizeof(scratch), "/Volumes/%c%c/scratch", slot[0] - 32, slot[1]);

    if (initgroups(target_pw->pw_name, target_pw->pw_gid) != 0 ||
        setgid(target_pw->pw_gid) != 0 ||
        setuid(target_pw->pw_uid) != 0 ||
        getuid() != target_pw->pw_uid ||
        geteuid() != target_pw->pw_uid ||
        setuid(0) == 0) {
      perror("privilege drop failed");
      _exit(126);
    }

    struct rlimit rl_nproc = {MAX_PROCS, MAX_PROCS};
    struct rlimit rl_nofile = {MAX_NOFILE, MAX_NOFILE};
    struct rlimit rl_core = {0, 0};
    if (setrlimit(RLIMIT_NPROC, &rl_nproc) != 0 ||
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

    execvp(argv[2], &argv[2]);
    perror("execvp");
    _exit(127);
  }

  child_pgid = pid;
  setpgid(pid, pid);
  uint64_t peak_bytes = 0;
  uint64_t last_written_mib = 0;
  uint64_t peak_cpu_millis = 0;
  uint64_t last_written_cpu = 0;

  while (1) {
    if (terminate_requested) {
      kill_all_target_procs(target_uid, child_pgid);
    }

    int status = 0;
    struct rusage child_ru;
    memset(&child_ru, 0, sizeof(child_ru));
    pid_t w = wait4(pid, &status, terminate_requested ? 0 : WNOHANG, &child_ru);
    if (w < 0) {
      if (errno == EINTR) continue;
      kill_all_target_procs(target_uid, child_pgid);
      write_peak_ram(slot, peak_bytes);
      write_cpu_millis(slot, peak_cpu_millis);
      return 1;
    }
    if (w == pid) {
      if (child_ru.ru_maxrss > 0 && (uint64_t)child_ru.ru_maxrss > peak_bytes) {
        peak_bytes = (uint64_t)child_ru.ru_maxrss;
      }
      uint64_t exit_cpu = rusage_cpu_millis(&child_ru);
      if (exit_cpu > peak_cpu_millis) peak_cpu_millis = exit_cpu;
      kill_all_target_procs(target_uid, child_pgid);
      write_peak_ram(slot, peak_bytes);
      write_cpu_millis(slot, peak_cpu_millis);
      if (WIFEXITED(status)) return WEXITSTATUS(status);
      if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
      return 1;
    }

    uint64_t used = 0;
    uint64_t cpu_ms = 0;
    sum_uid_usage(target_uid, &used, &cpu_ms);
    if (used > peak_bytes) {
      peak_bytes = used;
      uint64_t current_mib = (peak_bytes + (1024ULL * 1024ULL - 1ULL)) / (1024ULL * 1024ULL);
      if (current_mib > last_written_mib) {
        last_written_mib = current_mib;
        write_peak_ram(slot, peak_bytes);
      }
    }
    if (cpu_ms > peak_cpu_millis) {
      peak_cpu_millis = cpu_ms;
      if (peak_cpu_millis >= last_written_cpu + 50) {
        last_written_cpu = peak_cpu_millis;
        write_cpu_millis(slot, peak_cpu_millis);
      }
    }
    if (used > MAX_FOOTPRINT_BYTES) {
      fprintf(stderr,
              "ARENA_OOM: UID %u exceeded 14 GiB physical footprint (%llu bytes)\n",
              (unsigned)target_uid, (unsigned long long)used);
      kill_all_target_procs(target_uid, child_pgid);
      struct rusage oom_ru;
      memset(&oom_ru, 0, sizeof(oom_ru));
      if (wait4(pid, NULL, 0, &oom_ru) == pid) {
        if (oom_ru.ru_maxrss > 0 && (uint64_t)oom_ru.ru_maxrss > peak_bytes) {
          peak_bytes = (uint64_t)oom_ru.ru_maxrss;
        }
        uint64_t oom_cpu = rusage_cpu_millis(&oom_ru);
        if (oom_cpu > peak_cpu_millis) peak_cpu_millis = oom_cpu;
      }
      write_peak_ram(slot, peak_bytes);
      write_cpu_millis(slot, peak_cpu_millis);
      return 137; // Standard SIGKILL / OOM exit code (128 + 9)
    }

    usleep(POLL_INTERVAL_US);
  }
}
