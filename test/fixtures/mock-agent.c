#define _DEFAULT_SOURCE
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

int main(int argc, char **argv) {
  const char *utm = NULL;
  const char *utm_log = getenv("PKMN_TEST_UTM_LOG");
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--crash") == 0) return 1;
    if (strcmp(argv[i], "--utm") == 0 && i + 1 < argc) utm = argv[++i];
    else if (strcmp(argv[i], "--utm-log") == 0 && i + 1 < argc) utm_log = argv[++i];
  }
  setvbuf(stdout, NULL, _IOLBF, 0);
  struct timespec req = {0, 10000000}, rem = {0, 0};
  while (nanosleep(&req, &rem) < 0 && errno == EINTR) req = rem;
  if (utm) printf("/utm %s\n", utm);
  else puts("/ready");
  char line[65536];
  int sent_chat = 0;
  for (;;) {
    if (!fgets(line, sizeof(line), stdin)) {
      if (ferror(stdin) && errno == EINTR) {
        clearerr(stdin);
        continue;
      }
      break;
    }
    size_t len = strlen(line);
    while (len > 0 && (line[len - 1] == '\n' || line[len - 1] == '\r')) {
      line[--len] = '\0';
    }
    if (utm_log && strncmp(line, "|utm|", 5) == 0) {
      FILE *f = fopen(utm_log, "a");
      if (f) {
        fprintf(f, "%s\t%s\n", argv[0], line + 5);
        fclose(f);
      }
      continue;
    }
    if (strncmp(line, "|request|", 9) != 0) continue;
    const char *raw = line + 9;
    while (*raw == ' ' || *raw == '\t') raw++;
    if (!*raw || strcmp(raw, "null") == 0) continue;
    if (strstr(raw, "\"wait\":true") != NULL) continue;
    if (!utm && !utm_log && !sent_chat) {
      sent_chat = 1;
      puts("hello from agent");
    }
    puts(strstr(raw, "\"teamPreview\":true") != NULL ? "/team 123456" : "default");
  }
  return 0;
}
