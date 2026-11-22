#include <fcntl.h>
#include <mach/mach.h>
#include <netinet/in.h>
#include <servers/bootstrap.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <sys/xattr.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc < 2) return 2;
  if (strcmp(argv[1], "allow") == 0 && argc == 4) {
    char buf[256] = {0};
    int fd = open(argv[2], O_RDONLY);
    if (fd < 0 || read(fd, buf, sizeof(buf) - 32) <= 0) return 1;
    close(fd);
    strcat(buf, "-scratch");
    int out = open(argv[3], O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (out < 0 || write(out, buf, strlen(buf)) < 0) return 1;
    close(out);
    memset(buf, 0, sizeof(buf));
    fd = open(argv[3], O_RDONLY);
    if (fd < 0 || read(fd, buf, sizeof(buf) - 1) <= 0) return 1;
    close(fd);
    FILE *p = popen("/bin/bash -c 'cat <(echo -fd)'", "r");
    if (!p) return 1;
    char fd_buf[64] = {0};
    if (!fgets(fd_buf, sizeof(fd_buf), p)) return 1;
    pclose(p);
    fd_buf[strcspn(fd_buf, "\r\n")] = '\0';
    printf("%s%s\n", buf, fd_buf);
    return 0;
  }
  if (strcmp(argv[1], "deny-all") == 0 && argc == 5) {
    int fd = open(argv[2], O_RDONLY);
    if (fd >= 0) {
      close(fd);
      return 10;
    }
    int s = socket(AF_INET, SOCK_STREAM, 0);
    if (s >= 0) {
      struct sockaddr_in addr = {0};
      addr.sin_family = AF_INET;
      addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
      int rc = bind(s, (struct sockaddr *)&addr, sizeof(addr));
      close(s);
      if (rc == 0) return 11;
    }
    int mib_all[3] = {CTL_KERN, KERN_PROC, KERN_PROC_ALL};
    size_t sz = 0;
    if (sysctl(mib_all, 3, NULL, &sz, NULL, 0) == 0) return 12;
    int mib_uid[4] = {CTL_KERN, KERN_PROC, KERN_PROC_UID, (int)getuid()};
    sz = 0;
    if (sysctl(mib_uid, 4, NULL, &sz, NULL, 0) == 0) return 13;
    mach_port_t port = MACH_PORT_NULL;
    kern_return_t kr = bootstrap_look_up(
      bootstrap_port, "com.apple.system.notification_center", &port
    );
    if (kr == KERN_SUCCESS) return 14;
    if (setxattr(argv[3], "user.arena", "x", 1, 0, 0) == 0) return 15;
    if (chflags(argv[4], UF_IMMUTABLE) == 0) return 16;
    return 0;
  }
  return 2;
}
