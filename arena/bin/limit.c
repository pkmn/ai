// /opt/arena/bin/limit.c
// Compile on macOS: clang -O2 -Wall -Wextra -o /opt/arena/bin/limit arena/bin/limit.c
#include <errno.h>
#include <libproc.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/sysctl.h>
#include <sys/wait.h>
#include <unistd.h>

#define MAX_FOOTPRINT_BYTES (14ULL * 1024ULL * 1024ULL * 1024ULL) // 14 GiB
#define MAX_PROCS           256
#define MAX_NOFILE          1024
#define POLL_INTERVAL_US    50000 // 50 ms

static volatile pid_t child_pgid = 0;

static void forward_signal(int sig) {
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

  // Allocate with headroom in case child forks between the two sysctl calls
  buf_size += 16 * sizeof(struct kinfo_proc);
  struct kinfo_proc *procs = malloc(buf_size);
  if (!procs) return 0;

  if (sysctl(mib, 4, procs, &buf_size, NULL, 0) < 0) {
    free(procs);
    return 0;
  }

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

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "Usage: %s <program> [args...]\n", argv[0]);
    return 2;
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

    execvp(argv[1], &argv[1]);
    perror("execvp");
    _exit(127);
  }

  child_pgid = pid;
  setpgid(pid, pid);
  uid_t target_uid = getuid();
  uint64_t peak_bytes = 0;

  while (1) {
    int status = 0;
    pid_t w = waitpid(pid, &status, WNOHANG);
    if (w == pid) {
      // Child exited normally or via signal; write peak RAM to scratch file for telemetry
      const char *slot = getenv("ARENA_SLOT");
      if (slot && (strcmp(slot, "p1") == 0 || strcmp(slot, "p2") == 0)) {
        char path[64];
        snprintf(path, sizeof(path), "/Volumes/%c%c/.peak_ram",
                 slot[0] - 32, slot[1]); // /Volumes/P1/.peak_ram or /Volumes/P2/.peak_ram
        FILE *f = fopen(path, "w");
        if (f) {
          fprintf(f, "%llu\n", (unsigned long long)(peak_bytes / (1024ULL * 1024ULL)));
          fclose(f);
        }
      }
      kill(-child_pgid, SIGKILL);
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
      kill(-child_pgid, SIGKILL);
      waitpid(pid, NULL, 0);
      return 137; // Standard SIGKILL / OOM exit code (128 + 9)
    }

    usleep(POLL_INTERVAL_US);
  }
}
