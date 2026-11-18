import {execFileSync, spawn} from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';

import {Teams} from '@pkmn/sim';
import polka from 'polka';

import * as arenaIndex from '../arena';
import * as arbiter from '../arena/arbiter';
import * as coordinator from '../arena/coordinator';
import * as arenaDb from '../arena/db';
import * as packages from '../arena/packages';
import * as tournament from '../arena/tournament';
import * as unpack from '../arena/unpack';
import {Database} from '../db';
import * as serverArena from '../server/arena';
import * as auth from '../server/auth';
import {sampleRandomPair, validateCompetitorTeamsIncremental} from '../server/teams';
import {root} from '../static/util';
import * as mock from '../tools/mock';

const TEAM_ONE =
  'Pikachu||lightball|static|thunderbolt,quickattack,irontail,volttackle|' +
  'Jolly|,252,,,4,252|||||' +
  ']Charizard||heavydutyboots|blaze|flamethrower,airslash,roost,willowisp|' +
  'Timid|,4,,,252,252|||||' +
  ']Blastoise||leftovers|torrent|scald,icebeam,rapidspin,toxic|Bold|252,252,,,,4|||||' +
  ']Venusaur||blacksludge|overgrow|gigadrain,sludgebomb,synthesis,sleeppowder|' +
  'Calm|252,,,4,252,|||||' +
  ']Snorlax||leftovers|thickfat|bodyslam,earthquake,rest,sleeptalk|' +
  'Careful|252,4,252,,,|||||' +
  ']Gengar||focussash|cursedbody|shadowball,sludgewave,focusblast,destinybond|' +
  'Timid|,,,252,4,252|||||';

const TEAM_TWO =
  'Dragonite||heavydutyboots|multiscale|extremespeed,earthquake,roost,dragondance|' +
  'Adamant|,252,4,,,252|||||' +
  ']Tyranitar||leftovers|sandstream|stoneedge,crunch,stealthrock,earthquake|' +
  'Careful|252,4,252,,,|||||' +
  ']Garchomp||rockyhelmet|roughskin|earthquake,outrage,stealthrock,swordsdance|' +
  'Jolly|,252,,,4,252|||||' +
  ']Scizor||choiceband|technician|bulletpunch,uturn,closecombat,knockoff|' +
  'Adamant|248,252,,,8,|||||' +
  ']Rotom-Wash||leftovers|levitate|hydropump,voltswitch,willowisp,painsplit|' +
  'Bold|252,,252,,4,|||||' +
  ']Clefable||leftovers|magicguard|moonblast,softboiled,stealthrock,thunderwave|' +
  'Calm|252,,4,,252,|||||';

const OU_TEAM_ONE =
  'Great Tusk||BoosterEnergy|Protosynthesis|HeadlongRush,IceSpinner,RapidSpin,KnockOff|' +
  'Jolly|,252,4,,,252|||||' +
  ']Kingambit||Leftovers|SupremeOverlord|KowtowCleave,SuckerPunch,IronHead,SwordsDance|' +
  'Adamant|212,252,,,,44|M||||' +
  ']Gholdengo||ChoiceScarf|GoodasGold|MakeItRain,ShadowBall,Trick,Recover|' +
  'Timid|,,4,252,,252||,0,,,,|||' +
  ']Dragapult||ChoiceSpecs|Infiltrator|DracoMeteor,ShadowBall,Uturn,Flamethrower|' +
  'Timid|,,4,252,,252|M||||' +
  ']Glimmora||FocusSash|ToxicDebris|StealthRock,MortalSpin,PowerGem,EarthPower|' +
  'Timid|,,4,252,,252|F|,0,,,,|||' +
  ']Iron Valiant||BoosterEnergy|QuarkDrive|Moonblast,CloseCombat,KnockOff,Encore|' +
  'Naive|,4,,252,,252|||||';

function buildTestTarGz(entries: Array<{
  name: string;
  type: '0' | '1' | '2' | '5' | '6' | 'L' | 'K' | 'x';
  linkname?: string;
  prefix?: string;
  data?: Buffer;
  mode?: number;
  base256Size?: boolean;
}>): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512, 0);
    header.write(entry.name, 0, 100, 'utf8');
    const mode = entry.mode ?? (entry.type === '2' ? 0o777 : 0o644);
    header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    const size = entry.data?.length ?? 0;
    if (entry.base256Size) {
      header[124] = 0x80;
      let rem = size;
      for (let i = 135; i >= 125; i--) {
        header[i] = rem & 0xff;
        rem = Math.floor(rem / 256);
      }
    } else {
      header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    }
    header.write('00000000000\0', 136, 12, 'ascii');
    header.fill(0x20, 148, 156);
    header.write(entry.type, 156, 1, 'ascii');
    if (entry.linkname) header.write(entry.linkname, 157, 100, 'utf8');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    if (entry.prefix) header.write(entry.prefix, 345, 155, 'utf8');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i];
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    blocks.push(header);
    if (size > 0 && entry.data) {
      blocks.push(entry.data);
      const rem = size % 512;
      if (rem > 0) blocks.push(Buffer.alloc(512 - rem, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(blocks));
}

describe('arena infrastructure', () => {
  let tmpDir: string;
  let relayBin: string;
  let limitBin: string;
  let sandboxProbeBin: string;
  let defaultAgentScript: string;
  let tourneyUtmAgentScript: string;
  let crashingAgentScript: string;
  let validArchivePath: string;
  let validArchiveSha: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-arena-test-'));
    relayBin = path.join(tmpDir, 'tourney-relay');
    limitBin = path.join(tmpDir, 'limit');
    sandboxProbeBin = path.join(tmpDir, 'sandbox-probe');

    execFileSync('clang', [
      '-O2', '-Wall', '-Wextra', '-Werror',
      '-o', relayBin,
      root('arena', 'bin', 'tourney-relay.c'),
    ]);
    if (process.platform === 'darwin') {
      execFileSync('clang', [
        '-O2', '-Wall', '-Wextra', '-Werror',
        '-o', limitBin,
        root('arena', 'bin', 'limit.c'),
      ]);
      const probeSrc = path.join(tmpDir, 'sandbox-probe.c');
      fs.writeFileSync(
        probeSrc,
        [
          '#include <fcntl.h>',
          '#include <mach/mach.h>',
          '#include <netinet/in.h>',
          '#include <servers/bootstrap.h>',
          '#include <stdio.h>',
          '#include <string.h>',
          '#include <sys/socket.h>',
          '#include <sys/sysctl.h>',
          '#include <sys/xattr.h>',
          '#include <unistd.h>',
          'int main(int argc, char **argv) {',
          '  if (argc < 2) return 2;',
          '  if (strcmp(argv[1], "allow") == 0 && argc == 4) {',
          '    char buf[256] = {0};',
          '    int fd = open(argv[2], O_RDONLY);',
          '    if (fd < 0 || read(fd, buf, sizeof(buf) - 32) <= 0) return 1;',
          '    close(fd);',
          '    strcat(buf, "-scratch");',
          '    int out = open(argv[3], O_WRONLY | O_CREAT | O_TRUNC, 0644);',
          '    if (out < 0 || write(out, buf, strlen(buf)) < 0) return 1;',
          '    close(out);',
          '    memset(buf, 0, sizeof(buf));',
          '    fd = open(argv[3], O_RDONLY);',
          '    if (fd < 0 || read(fd, buf, sizeof(buf) - 1) <= 0) return 1;',
          '    close(fd);',
          '    FILE *p = popen("/bin/bash -c \'cat <(echo -fd)\'", "r");',
          '    if (!p) return 1;',
          '    char fd_buf[64] = {0};',
          '    if (!fgets(fd_buf, sizeof(fd_buf), p)) return 1;',
          '    pclose(p);',
          '    fd_buf[strcspn(fd_buf, "\\r\\n")] = \'\\0\';',
          '    printf("%s%s\\n", buf, fd_buf);',
          '    return 0;',
          '  }',
          '  if (strcmp(argv[1], "read") == 0 && argc == 3) {',
          '    int fd = open(argv[2], O_RDONLY);',
          '    if (fd < 0) return 1;',
          '    close(fd);',
          '    return 0;',
          '  }',
          '  if (strcmp(argv[1], "socket") == 0) {',
          '    int s = socket(AF_INET, SOCK_STREAM, 0);',
          '    if (s < 0) return 1;',
          '    struct sockaddr_in addr = {0};',
          '    addr.sin_family = AF_INET;',
          '    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);',
          '    int rc = bind(s, (struct sockaddr *)&addr, sizeof(addr));',
          '    close(s);',
          '    return rc == 0 ? 0 : 1;',
          '  }',
          '  if (strcmp(argv[1], "kernproc") == 0) {',
          '    int mib[3] = {CTL_KERN, KERN_PROC, KERN_PROC_ALL};',
          '    size_t sz = 0;',
          '    return sysctl(mib, 3, NULL, &sz, NULL, 0) == 0 ? 0 : 1;',
          '  }',
          '  if (strcmp(argv[1], "kernprocuid") == 0) {',
          '    int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_UID, (int)getuid()};',
          '    size_t sz = 0;',
          '    return sysctl(mib, 4, NULL, &sz, NULL, 0) == 0 ? 0 : 1;',
          '  }',
          '  if (strcmp(argv[1], "notifyd") == 0) {',
          '    mach_port_t port = MACH_PORT_NULL;',
          '    kern_return_t kr = bootstrap_look_up(',
          '      bootstrap_port, "com.apple.system.notification_center", &port',
          '    );',
          '    return kr == KERN_SUCCESS ? 0 : 1;',
          '  }',
          '  if (strcmp(argv[1], "xattr") == 0 && argc == 3) {',
          '    return setxattr(argv[2], "user.arena", "x", 1, 0, 0) == 0 ? 0 : 1;',
          '  }',
          '  return 2;',
          '}',
        ].join('\n')
      );
      execFileSync('clang', [
        '-O2', '-Wall', '-Wextra', '-Werror',
        '-o', sandboxProbeBin,
        probeSrc,
      ]);
    }

    defaultAgentScript = path.join(tmpDir, 'default-agent.js');
    fs.writeFileSync(
      defaultAgentScript,
      [
        '#!/usr/bin/env node',
        'const readline = require("readline");',
        'const rl = readline.createInterface({input: process.stdin, crlfDelay: Infinity});',
        'let sentChat = false;',
        'rl.on("line", line => {',
        '  if (!line.startsWith("|request|")) return;',
        '  const raw = line.slice(9).trim();',
        '  if (!raw || raw === "null") return;',
        '  const req = JSON.parse(raw);',
        '  if (req.wait) return;',
        '  if (!sentChat) {',
        '    sentChat = true;',
        '    process.stdout.write("hello from agent\\n");',
        '  }',
        '  if (req.teamPreview) {',
        '    process.stdout.write("/team 123456\\n");',
        '  } else {',
        '    process.stdout.write("default\\n");',
        '  }',
        '});',
      ].join('\n'),
      {mode: 0o755}
    );

    tourneyUtmAgentScript = path.join(tmpDir, 'tourney-utm-agent.js');
    fs.writeFileSync(
      tourneyUtmAgentScript,
      [
        '#!/usr/bin/env node',
        'const readline = require("readline");',
        `process.stdout.write("/utm ${OU_TEAM_ONE}\\n");`,
        'const rl = readline.createInterface({input: process.stdin, crlfDelay: Infinity});',
        'rl.on("line", line => {',
        '  if (!line.startsWith("|request|")) return;',
        '  const raw = line.slice(9).trim();',
        '  if (!raw || raw === "null") return;',
        '  const req = JSON.parse(raw);',
        '  if (req.wait) return;',
        '  if (req.teamPreview) {',
        '    process.stdout.write("/team 123456\\n");',
        '  } else {',
        '    process.stdout.write("default\\n");',
        '  }',
        '});',
      ].join('\n'),
      {mode: 0o755}
    );

    crashingAgentScript = path.join(tmpDir, 'crashing-agent.js');
    fs.writeFileSync(
      crashingAgentScript,
      '#!/usr/bin/env node\nprocess.exit(1);\n',
      {mode: 0o755}
    );

    const bundleSrc = path.join(tmpDir, 'bundle-src');
    fs.mkdirSync(bundleSrc, {recursive: true});
    fs.writeFileSync(path.join(bundleSrc, 'run'), fs.readFileSync(defaultAgentScript), {
      mode: 0o755,
    });
    fs.writeFileSync(path.join(bundleSrc, 'weights.bin'), Buffer.alloc(70_000, 0x42));
    validArchivePath = path.join(tmpDir, 'valid-agent.tar.gz');
    execFileSync('tar', ['-czf', validArchivePath, '-C', bundleSrc, '.']);
    validArchiveSha = crypto.createHash('sha256')
      .update(fs.readFileSync(validArchivePath))
      .digest('hex');
  }, 30_000);

  afterAll(() => {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  describe('arena static assets', () => {
    test('includes all required arena/config, arena/bin, or arena/scripts files', () => {
      const expectedFiles = [
        'arena/SETUP.md',
        'arena/config/ai.pkmn.arena.plist',
        'arena/config/ai.pkmn.archive.plist',
        'arena/config/ai.pkmn.pf.plist',
        'arena/config/ai.pkmn.podman.plist',
        'arena/config/ai.pkmn.tunnel.plist',
        'arena/config/pf.anchor',
        'arena/config/sandbox.sb',
        'arena/config/sshd-arena.conf',
        'arena/config/sshd-tunnel.conf',
        'arena/config/sudoers',
        'arena/bin/arena',
        'arena/bin/baseline',
        'arena/bin/limit.c',
        'arena/bin/tourney-agent',
        'arena/bin/tourney-relay.c',
        'arena/scripts/setup-arena.sh',
        'arena/scripts/bake-image.sh',
        'arena/scripts/archive.sh',
        'arena/scripts/deploy.sh',
      ];
      for (const rel of expectedFiles) {
        expect(fs.existsSync(root(rel))).toBe(true);
      }
      expect(typeof arenaIndex.runDaemon).toBe('function');
    });

    test('passes shell syntax checks across arena scripts', () => {
      expect(() => {
        execFileSync('bash', [
          '-n',
          root('deploy'),
          root('arena/bin/arena'),
          root('arena/bin/tourney-agent'),
          root('arena/scripts/setup-arena.sh'),
          root('arena/scripts/bake-image.sh'),
          root('arena/scripts/archive.sh'),
          root('arena/scripts/deploy.sh'),
        ]);
        execFileSync('sh', ['-n', root('arena/bin/baseline')]);
      }).not.toThrow();
    });

    test('baseline agent responds to team preview or battle requests', () => {
      const baselineOut = execFileSync(root('arena/bin/baseline'), [], {
        input: [
          '|request|{"wait":true}',
          '|request|{"teamPreview":true,"maxChosenTeamSize":4}',
          '|request|{"teamPreview":true}',
          '|request|{"active":[{"moves":[{"id":"tackle"}]}]}',
        ].join('\n') + '\n',
        encoding: 'utf8',
      }).trim().split('\n');
      expect(baselineOut).toEqual(['/team 1234', '/team 123456', 'default']);
    });

    test('configures strict sudoers, scratch chown, Podman RAM, or Seatbelt flags', () => {
      const arenaScript = fs.readFileSync(root('arena', 'bin', 'arena'), 'utf8');
      const setupScript = fs.readFileSync(root('arena', 'scripts', 'setup-arena.sh'), 'utf8');
      const sudoers = fs.readFileSync(root('arena', 'config', 'sudoers'), 'utf8');
      const sandbox = fs.readFileSync(root('arena', 'config', 'sandbox.sb'), 'utf8');
      const limitC = fs.readFileSync(root('arena', 'bin', 'limit.c'), 'utf8');

      expect(arenaScript).toContain(
        'sudo -n /usr/bin/chflags -R nouchg,nouappend,noschg "$SCRATCH_DIR"'
      );
      expect(arenaScript).toContain('sudo -n /usr/bin/ipcs -m');
      expect(arenaScript).toContain('--device /dev/dri');
      expect(arenaScript).toContain('exec sudo -n /opt/arena/bin/limit "$SLOT"');
      expect(arenaScript).toContain('--cpus=10');
      expect(arenaScript).toContain('--memory=14g');
      expect(arenaScript).toContain('--memory-swap=14g');

      expect(setupScript).toContain(
        'sudo chown root:wheel /Volumes/P1 /Volumes/P2 /Volumes/P1/scratch /Volumes/P2/scratch'
      );
      expect(setupScript).toContain('-quota 4G');
      expect(setupScript).toContain('-quota 6G');
      expect(setupScript).toContain('--cpus 10');
      expect(setupScript).toContain('--memory 30720');
      expect(setupScript).toContain('--disk-size 48');
      expect(setupScript).not.toContain('swapfile');

      expect(sudoers).not.toContain('/usr/bin/env -i *');
      expect(sudoers).not.toContain('/usr/sbin/ipcs');
      expect(sudoers).toContain('/usr/bin/ipcs -m');
      expect(sudoers).toContain('pkmn ALL=(root) NOPASSWD: /opt/arena/bin/limit p1');
      expect(sudoers).toContain('/usr/bin/killall -STOP -u p1');
      expect(sudoers).toContain('/usr/bin/killall -CONT -u p1');
      expect(sudoers).toContain('/usr/bin/find /Volumes/P1/scratch -mindepth 1 -delete');

      expect(sandbox).toContain('(allow signal (target same-sandbox))');
      expect(sandbox).toContain('(global-name "com.apple.MTLCompilerService")');
      expect(sandbox).toContain('(deny file-write-flags');

      expect(limitC).toContain('/opt/arena/state/peak_ram_%s');
      expect(limitC).not.toContain('.peak_ram');
      expect(limitC).toContain('PRIO_DARWIN_PROCESS');
      expect(limitC).toContain('setenv("PKMN_STATS_DIR", "/opt/arena/stats", 1)');
      expect(arenaScript).toContain('--env PKMN_STATS_DIR=/opt/arena/stats');
      expect(fs.readFileSync(root('arena', 'bin', 'tourney-agent'), 'utf8'))
        .toContain('--setenv PKMN_STATS_DIR /opt/arena/stats');
      expect(fs.readFileSync(root('arena', 'config', 'ai.pkmn.arena.plist'), 'utf8'))
        .toContain('<key>ExitTimeOut</key>\n  <integer>900</integer>');
      expect(fs.readFileSync(root('arena', 'scripts', 'deploy.sh'), 'utf8'))
        .toContain('launchctl kill SIGUSR1 system/ai.pkmn.arena');
      expect(sudoers).toContain('/bin/launchctl kill SIGUSR1 system/ai.pkmn.arena');
    });

    test('blocks kernel socket module auto-loading inside Podman VM in setup-arena.sh', () => {
      const setupScript = fs.readFileSync(root('arena', 'scripts', 'setup-arena.sh'), 'utf8');
      expect(setupScript).toContain('/etc/modprobe.d/arena-blacklist.conf');
      expect(setupScript).toContain('install sctp /bin/false');
      expect(setupScript).toContain('blacklist sctp');
      expect(setupScript).toContain('sudo modprobe -r sctp dccp rds tipc');
    });

    test('blocks kernel socket module auto-loading prior to smoke tests in bake-image.sh', () => {
      const bakeScript = fs.readFileSync(root('arena', 'scripts', 'bake-image.sh'), 'utf8');
      const blacklistPos = bakeScript.indexOf('/etc/modprobe.d/arena-blacklist.conf');
      const smokePos = bakeScript.indexOf('/usr/local/bin/tourney-agent');
      expect(blacklistPos).toBeGreaterThan(0);
      expect(smokePos).toBeGreaterThan(blacklistPos);
      expect(bakeScript).toContain('install sctp /bin/false');
      expect(bakeScript).toContain('blacklist sctp');
    });
  });

  describe('tourney-relay binary', () => {
    test('emits local CLOCK_MONOTONIC turn duration on stderr', async () => {
      const proc = spawn(relayBin, [process.execPath, defaultAgentScript], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];
      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');
      proc.stdout.on('data', chunk => stdoutLines.push(String(chunk)));
      proc.stderr.on('data', chunk => stderrLines.push(String(chunk)));

      proc.stdin.write('|request|{"wait":true}\n');
      proc.stdin.write('|request|{"active":[{"moves":[{"id":"tackle"}]}]}\n');

      await new Promise<void>(resolve => {
        const check = () => {
          if (stdoutLines.join('').includes('default')) resolve();
          else setTimeout(check, 5);
        };
        check();
      });

      proc.kill('SIGTERM');
      expect(stderrLines.join('')).toMatch(/ARENA_TURN_MS=[1-9]\d*\t1/);
      expect(stdoutLines.join('')).toContain('default');
    });

    test('terminates hung child process groups promptly on stdin EOF', async () => {
      const hungScript = path.join(tmpDir, 'hung-gpu-agent.js');
      fs.writeFileSync(
        hungScript,
        '#!/usr/bin/env node\nsetInterval(() => {}, 10000);\n',
        {mode: 0o755}
      );
      const hungRelay = spawn(relayBin, [process.execPath, hungScript], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const exitedPromise = new Promise<number | null>(resolve => {
        hungRelay.on('exit', code => resolve(code));
      });
      hungRelay.stdin.end();
      const exitStart = Date.now();
      await exitedPromise;
      expect(Date.now() - exitStart).toBeLessThan(1500);
    });

    test('exits promptly on stdin EOF when child never reads flooded stdin', async () => {
      const noReadScript = path.join(tmpDir, 'noread-agent.js');
      fs.writeFileSync(
        noReadScript,
        '#!/usr/bin/env node\nconst b = Buffer.alloc(16 * 1024 * 1024, 3);' +
          'setInterval(() => b[0], 10000);\n',
        {mode: 0o755}
      );
      const relay = spawn(relayBin, [process.execPath, noReadScript], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      relay.stdin.on('error', () => undefined);
      let stderrOut = '';
      relay.stderr.setEncoding('utf8');
      relay.stderr.on('data', chunk => {
        stderrOut += String(chunk);
      });
      const exitedPromise = new Promise<number | null>(resolve => {
        relay.on('close', code => resolve(code));
      });
      const line = `|c|~|${'x'.repeat(4000)}\n`;
      for (let i = 0; i < 80; i++) {
        relay.stdin.write(line);
      }
      relay.stdin.end();
      const start = Date.now();
      await exitedPromise;
      expect(Date.now() - start).toBeLessThan(1500);
      const ramMatch = /ARENA_PEAK_RAM=(\d+)/.exec(stderrOut);
      expect(ramMatch).toBeTruthy();
      const peakMib = Number(ramMatch![1]);
      expect(peakMib).toBeGreaterThanOrEqual(16);
      expect(peakMib).toBeLessThan(4096);
    });

    test('closes inherited file descriptors above stderr before exec', async () => {
      const relay = spawn(
        relayBin,
        ['/bin/sh', '-c', 'if echo leaked >&3 2>/dev/null; then echo OPEN; else echo CLOSED; fi'],
        {stdio: ['pipe', 'pipe', 'pipe', 'pipe']}
      );
      let out = '';
      relay.stdout.setEncoding('utf8');
      relay.stdout.on('data', chunk => {
        out += String(chunk);
      });
      await new Promise<void>(resolve => {
        relay.on('close', () => resolve());
      });
      expect(out.trim()).toBe('CLOSED');
    });

    test('emits ARENA_TURN_MS on empty stdout lines to keep turn clocks aligned', async () => {
      const emptyLineScript = path.join(tmpDir, 'empty-line-agent.js');
      fs.writeFileSync(
        emptyLineScript,
        '#!/usr/bin/env node\nconst readline = require("readline");' +
          'const rl = readline.createInterface({input: process.stdin});' +
          'rl.on("line", line => {' +
          '  if (!line.startsWith("|request|")) return;' +
          '  process.stdout.write("\\n");' +
          '  setTimeout(() => process.stdout.write("default\\n"), 25);' +
          '});\n',
        {mode: 0o755}
      );
      const res = await new tournament.ConcurrentGame({
        format: 'gen9customgame',
        seed: '1,2,3,4',
        smokeStopAfterTurn: 1,
        p1Spec: {
          agentId: 'empty-p1',
          displayName: 'Empty P1',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          localCommand: relayBin,
          localArgs: [process.execPath, emptyLineScript],
        },
        p2Spec: {
          agentId: 'default-p2',
          displayName: 'Default P2',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          localCommand: relayBin,
          localArgs: [process.execPath, defaultAgentScript],
        },
        p1TeamPacked: TEAM_ONE,
        p2TeamPacked: TEAM_TWO,
      }).run();
      expect(res.p1.meanTurnMillis).toBeGreaterThanOrEqual(20);
      expect(res.p1.peakRam).toBeGreaterThan(1);
    });
  });

  describe('arena/unpack', () => {
    test('extracts valid native bundles with APFS CoW CAS deduplication', async () => {
      const casDir = path.join(tmpDir, 'cas-dedup');
      const agentsDir = path.join(tmpDir, 'agents-dedup');
      const stagingDir = path.join(tmpDir, 'staging-dedup');

      const bytes1 = await packages.downloadAndUnpackBundle({
        url: `file://${validArchivePath}`,
        expectedSha256: validArchiveSha,
        agentTargetId: 'agent-v1',
        stagingDir,
        agentsDir,
        casDir,
        allowPrivateUrls: true,
      });
      expect(bytes1).toBeGreaterThan(70_000);
      expect(fs.existsSync(path.join(agentsDir, 'agent-v1', 'run'))).toBe(true);

      const bytes2 = unpack.unpackBundle(
        validArchivePath,
        path.join(agentsDir, 'agent-v2'),
        casDir
      );
      expect(bytes2).toBe(bytes1);
    });

    test('rejects bundles missing executable ./run without polluting CAS', () => {
      const noRunSrc = path.join(tmpDir, 'no-run-src');
      const noRunCasDir = path.join(tmpDir, 'cas-no-run');
      fs.mkdirSync(noRunSrc, {recursive: true});
      fs.writeFileSync(path.join(noRunSrc, 'README.txt'), 'missing run');
      fs.writeFileSync(path.join(noRunSrc, 'big.bin'), Buffer.alloc(70_000, 0x99));
      const noRunTar = path.join(tmpDir, 'no-run.tar.gz');
      execFileSync('tar', ['-czf', noRunTar, '-C', noRunSrc, '.']);

      expect(() => unpack.unpackBundle(noRunTar, path.join(tmpDir, 'agent-no-run'), noRunCasDir))
        .toThrow(/missing required executable/i);
      expect(fs.existsSync(noRunCasDir)).toBe(false);
    });

    test('rejects chained-symlink Tar Slip archives escaping destination', () => {
      const slipTar = path.join(tmpDir, 'chained-symlink-slip.tar.gz');
      fs.writeFileSync(
        slipTar,
        buildTestTarGz([
          {name: 'a/b', type: '2', linkname: '..'},
          {name: 'a/b/escape', type: '2', linkname: '..'},
          {name: 'escape/pwned.txt', type: '0', data: Buffer.from('pwned', 'utf8')},
        ])
      );
      const slipAgentsDir = path.join(tmpDir, 'agents-slip');
      expect(() => unpack.unpackBundle(
        slipTar,
        path.join(slipAgentsDir, 'agent-slip'),
        path.join(tmpDir, 'cas-slip')
      )).toThrow(/traverses symlink|escapes|illegal link target/i);
      expect(fs.existsSync(path.join(slipAgentsDir, 'pwned.txt'))).toBe(false);
    });

    test('rejects hardlink size-amplification archives above 500 MB', () => {
      const hlBombTar = path.join(tmpDir, 'hardlink-bomb.tar.gz');
      const entries: Parameters<typeof buildTestTarGz>[0] = [
        {name: 'base.bin', type: '0', data: Buffer.alloc(4 * 1024 * 1024, 0)},
      ];
      for (let i = 0; i < 130; i++) {
        entries.push({name: `dup-${i}.bin`, type: '1', linkname: 'base.bin'});
      }
      fs.writeFileSync(hlBombTar, buildTestTarGz(entries));
      const hlDest = path.join(tmpDir, 'agent-hl-bomb');
      expect(() => unpack.unpackBundle(hlBombTar, hlDest, path.join(tmpDir, 'cas-hl')))
        .toThrow(/exceeds 500 MB cap/i);
      expect(fs.existsSync(hlDest)).toBe(false);
    });

    test('cleans up partial destination directories on corrupt archives', () => {
      const corruptTar = path.join(tmpDir, 'corrupt.tar.gz');
      fs.writeFileSync(corruptTar, fs.readFileSync(validArchivePath).subarray(0, 48));
      const corruptDest = path.join(tmpDir, 'agent-corrupt');
      expect(() => unpack.unpackBundle(corruptTar, corruptDest, path.join(tmpDir, 'cas-corrupt')))
        .toThrow(/UNPACK_ERROR/i);
      expect(fs.existsSync(corruptDest)).toBe(false);
    });

    test('ad-hoc codesigns 0644 Mach-O .so extensions before CAS CoW on Darwin', () => {
      if (process.platform !== 'darwin') return;
      const soSrcDir = path.join(tmpDir, 'macho-so-src');
      fs.mkdirSync(soSrcDir, {recursive: true});
      fs.writeFileSync(path.join(soSrcDir, 'run'), fs.readFileSync(defaultAgentScript), {
        mode: 0o755,
      });
      const cFile = path.join(tmpDir, 'ext.c');
      fs.writeFileSync(cFile, 'int pkmn_ext_answer(void) { return 42; }\n');
      const soFile = path.join(soSrcDir, 'ext.cpython-312-darwin.so');
      execFileSync('cc', ['-dynamiclib', '-o', soFile, cFile]);
      execFileSync('/usr/bin/codesign', ['--remove-signature', soFile]);
      fs.chmodSync(soFile, 0o644);
      expect(() => execFileSync('/usr/bin/codesign', ['-v', soFile], {stdio: 'pipe'})).toThrow();

      const soTar = path.join(tmpDir, 'macho-so.tar.gz');
      execFileSync('tar', ['-czf', soTar, '-C', soSrcDir, '.']);
      const soDest = path.join(tmpDir, 'agent-macho-so');
      unpack.unpackBundle(soTar, soDest, path.join(tmpDir, 'cas-macho'));

      const unpackedSo = path.join(soDest, 'ext.cpython-312-darwin.so');
      expect(fs.statSync(unpackedSo).mode & 0o777).toBe(0o644);
      execFileSync('/usr/bin/codesign', ['-v', unpackedSo], {stdio: 'pipe'});
    });

    test('parses PAX extended headers, GNU LongLink, ustar prefix, or base-256 sizes', () => {
      const paxKv = 'path=pax-dir/deep-weights.bin\n';
      const paxRecord = `${paxKv.length + 3} ${paxKv}`;
      const tarPath = path.join(tmpDir, 'formats.tar.gz');
      fs.writeFileSync(
        tarPath,
        buildTestTarGz([
          {name: 'run', type: '0', mode: 0o755, data: Buffer.from('#!/bin/sh\nexit 0\n')},
          {name: 'PaxHeader/deep', type: 'x', data: Buffer.from(paxRecord, 'utf8')},
          {name: 'ignored-short-name', type: '0', data: Buffer.from('pax-payload')},
          {
            name: '././@LongLink',
            type: 'L',
            data: Buffer.from('gnu-long/nested/model.bin\0', 'utf8'),
          },
          {
            name: 'truncated',
            type: '0',
            data: Buffer.from('gnu-base256-payload'),
            base256Size: true,
          },
          {
            name: 'config.json',
            prefix: 'ustar-prefix/sub',
            type: '0',
            data: Buffer.from('{"ok":true}'),
          },
        ])
      );
      const dest = path.join(tmpDir, 'agent-formats');
      unpack.unpackBundle(tarPath, dest);
      expect(fs.readFileSync(path.join(dest, 'pax-dir/deep-weights.bin'), 'utf8'))
        .toBe('pax-payload');
      expect(fs.readFileSync(path.join(dest, 'gnu-long/nested/model.bin'), 'utf8'))
        .toBe('gnu-base256-payload');
      expect(fs.readFileSync(path.join(dest, 'ustar-prefix/sub/config.json'), 'utf8'))
        .toBe('{"ok":true}');
    });

    test('rejects special FIFO entries, absolute paths, or symlink loops', () => {
      const fifoTar = path.join(tmpDir, 'fifo.tar.gz');
      fs.writeFileSync(
        fifoTar,
        buildTestTarGz([
          {name: 'run', type: '0', mode: 0o755, data: Buffer.from('#!/bin/sh\n')},
          {name: 'pipe.fifo', type: '6'},
        ])
      );
      expect(() => unpack.unpackBundle(fifoTar, path.join(tmpDir, 'agent-fifo')))
        .toThrow(/Disallowed special file/);

      const absTar = path.join(tmpDir, 'abs.tar.gz');
      fs.writeFileSync(
        absTar,
        buildTestTarGz([
          {name: '/etc/passwd', type: '0', data: Buffer.from('x')},
        ])
      );
      expect(() => unpack.unpackBundle(absTar, path.join(tmpDir, 'agent-abs')))
        .toThrow(/Illegal path in archive/);

      const loopTar = path.join(tmpDir, 'loop.tar.gz');
      fs.writeFileSync(
        loopTar,
        buildTestTarGz([
          {name: 'a', type: '2', linkname: 'b'},
          {name: 'b', type: '2', linkname: 'a'},
          {name: 'a/file.txt', type: '0', data: Buffer.from('x')},
        ])
      );
      expect(() => unpack.unpackBundle(loopTar, path.join(tmpDir, 'agent-loop')))
        .toThrow(/Symlink loop detected/);
    });

    test('rejects forward hardlinks, symlinked ./run, or non-executable ./run', () => {
      const fwdLinkTar = path.join(tmpDir, 'fwd-hardlink.tar.gz');
      fs.writeFileSync(
        fwdLinkTar,
        buildTestTarGz([
          {name: 'run', type: '0', mode: 0o755, data: Buffer.from('#!/bin/sh\n')},
          {name: 'dup.bin', type: '1', linkname: 'later.bin'},
          {name: 'later.bin', type: '0', data: Buffer.from('later')},
        ])
      );
      expect(() => unpack.unpackBundle(fwdLinkTar, path.join(tmpDir, 'agent-fwd-hl')))
        .toThrow(/does not reference an earlier regular file/);

      const symRunTar = path.join(tmpDir, 'sym-run.tar.gz');
      fs.writeFileSync(
        symRunTar,
        buildTestTarGz([
          {name: 'real-run', type: '0', mode: 0o755, data: Buffer.from('#!/bin/sh\n')},
          {name: 'run', type: '2', linkname: 'real-run'},
        ])
      );
      expect(() => unpack.unpackBundle(symRunTar, path.join(tmpDir, 'agent-sym-run')))
        .toThrow(/missing required executable \.\/run/);

      const nonExecRunTar = path.join(tmpDir, 'nonexec-run.tar.gz');
      fs.writeFileSync(
        nonExecRunTar,
        buildTestTarGz([
          {name: 'run', type: '0', mode: 0o644, data: Buffer.from('#!/bin/sh\n')},
        ])
      );
      expect(() => unpack.unpackBundle(nonExecRunTar, path.join(tmpDir, 'agent-nonexec-run')))
        .toThrow(/missing required executable \.\/run/);
    });

    test('preserves internal links while skipping CAS on multi-linked files', () => {
      const linksTar = path.join(tmpDir, 'links-cas.tar.gz');
      const sharedBuf = Buffer.alloc(70_000, 0x41);
      const uniqueBuf = Buffer.alloc(70_000, 0x42);
      fs.writeFileSync(
        linksTar,
        buildTestTarGz([
          {name: 'run', type: '0', mode: 0o755, data: Buffer.from('#!/bin/sh\nexit 0\n')},
          {name: 'shared.bin', type: '0', mode: 0o644, data: sharedBuf},
          {name: 'shared-hl.bin', type: '1', linkname: 'shared.bin'},
          {name: 'shared-sym.bin', type: '2', linkname: 'shared.bin'},
          {name: 'unique.bin', type: '0', mode: 0o644, data: uniqueBuf},
        ])
      );
      const dest = path.join(tmpDir, 'agent-links-cas');
      const casDir = path.join(tmpDir, 'cas-links-only');
      unpack.unpackBundle(linksTar, dest, casDir);

      const stShared = fs.lstatSync(path.join(dest, 'shared.bin'));
      const stHard = fs.lstatSync(path.join(dest, 'shared-hl.bin'));
      const stSym = fs.lstatSync(path.join(dest, 'shared-sym.bin'));
      expect(stShared.ino).toBe(stHard.ino);
      expect(stShared.nlink).toBe(2);
      expect(stSym.isSymbolicLink()).toBe(true);

      const sharedDigest = crypto.createHash('sha256').update(sharedBuf).digest('hex');
      const uniqueDigest = crypto.createHash('sha256').update(uniqueBuf).digest('hex');
      expect(fs.existsSync(path.join(casDir, sharedDigest.slice(0, 2), sharedDigest))).toBe(false);
      expect(fs.existsSync(path.join(casDir, uniqueDigest.slice(0, 2), uniqueDigest))).toBe(true);
    });

    test('rejects lexical dot-dot collapse through prefix symlinks', () => {
      const victimPath = path.join(tmpDir, 'victim-lexical-collapse.txt');
      fs.rmSync(victimPath, {force: true});
      const escapeTar = path.join(tmpDir, 'lexical-collapse.tar.gz');
      fs.writeFileSync(
        escapeTar,
        buildTestTarGz([
          {name: 'run', type: '0', mode: 0o755, data: Buffer.from('#!/bin/sh\nexit 0\n')},
          {name: 'd1/d2/d3/d4/a', type: '2', linkname: '../../../..'},
          {name: 'd1/d2/d3/d4/s', type: '2', linkname: 'a/../../victim-lexical-collapse.txt'},
        ])
      );
      const agentsSub = path.join(tmpDir, 'agents-lex');
      expect(() => unpack.unpackBundle(escapeTar, path.join(agentsSub, 'bundle')))
        .toThrow(/illegal link target|escapes/i);
      expect(fs.existsSync(victimPath)).toBe(false);
    });

    test('rejects forward-referenced symlink chains escaping destination', () => {
      const fwdSymTar = path.join(tmpDir, 'forward-sym-escape.tar.gz');
      fs.writeFileSync(
        fwdSymTar,
        buildTestTarGz([
          {name: 'run', type: '0', mode: 0o755, data: Buffer.from('#!/bin/sh\nexit 0\n')},
          {name: 's', type: '2', linkname: 't/../../outside.txt'},
          {name: 't', type: '2', linkname: 'sub'},
        ])
      );
      expect(() => unpack.unpackBundle(fwdSymTar, path.join(tmpDir, 'agent-fwd-sym')))
        .toThrow(/illegal link target|escapes/i);
    });

    test('rejects case-variant or trailing-slash symlink directory collisions', () => {
      const caseTar = path.join(tmpDir, 'case-sym-escape.tar.gz');
      fs.writeFileSync(
        caseTar,
        buildTestTarGz([
          {name: 'run', type: '0', mode: 0o755, data: Buffer.from('#!/bin/sh\nexit 0\n')},
          {name: 'Link/', type: '2', linkname: '.'},
          {name: 'link/pwned.txt', type: '0', data: Buffer.from('x')},
        ])
      );
      expect(() => unpack.unpackBundle(caseTar, path.join(tmpDir, 'agent-case-sym')))
        .toThrow(/traverses symlinked|colliding/i);
    });

    test('parses multi-byte UTF-8 PAX extended header paths by byte length', () => {
      const utf8Rel = 'modèles/pokémon-weights.txt';
      const kv = `path=${utf8Rel}\n`;
      const kvBytes = Buffer.byteLength(kv, 'utf8');
      let totalLen = kvBytes + 3;
      const prefixStr = `${totalLen} `;
      if (Buffer.byteLength(prefixStr, 'utf8') + kvBytes !== totalLen) {
        totalLen = Buffer.byteLength(`${kvBytes + 4} `, 'utf8') + kvBytes;
      }
      const paxPayload = Buffer.from(`${totalLen} ${kv}14 comment=ok\n`, 'utf8');
      const paxTar = path.join(tmpDir, 'pax-utf8.tar.gz');
      fs.writeFileSync(
        paxTar,
        buildTestTarGz([
          {name: 'run', type: '0', mode: 0o755, data: Buffer.from('#!/bin/sh\nexit 0\n')},
          {name: 'PaxHeader/utf8', type: 'x', data: paxPayload},
          {name: 'fallback.txt', type: '0', data: Buffer.from('utf8-ok', 'utf8')},
        ])
      );
      const dest = path.join(tmpDir, 'agent-pax-utf8');
      unpack.unpackBundle(paxTar, dest);
      expect(fs.readFileSync(path.join(dest, utf8Rel), 'utf8')).toBe('utf8-ok');
    });
  });

  describe('artifact fetch & OCI digest verification', () => {
    const realFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    test('rejects bundle downloads whose SHA-256 disagrees with expected digest', async () => {
      await expect(
        packages.downloadAndUnpackBundle({
          url: `file://${validArchivePath}`,
          expectedSha256: '0'.repeat(64),
          agentTargetId: 'agent-bad-sha',
          stagingDir: path.join(tmpDir, 'staging-sha'),
          agentsDir: path.join(tmpDir, 'agents-sha'),
          allowPrivateUrls: true,
        })
      ).rejects.toThrow(/SHA-256 mismatch/);
    });

    test('downloadAndUnpackBundle rejects file:// URLs when allowPrivateUrls is omitted', async () => {
      await expect(
        packages.downloadAndUnpackBundle({
          url: `file://${validArchivePath}`,
          expectedSha256: validArchiveSha,
          agentTargetId: 'agent-file-blocked',
          stagingDir: path.join(tmpDir, 'staging-file-blocked'),
          agentsDir: path.join(tmpDir, 'agents-file-blocked'),
        })
      ).rejects.toThrow(/file:\/\/ URLs are disallowed/);
    });

    test('verifyOciManifestDigest rejects foreign-layer URLs or invalid layer sizes', () => {
      const foreignManifest = JSON.stringify({
        config: {digest: `sha256:${'a'.repeat(64)}`},
        layers: [{size: 1024, urls: ['https://169.254.169.254/latest/meta-data/']}],
      });
      expect(() => packages.verifyOciManifestDigest(foreignManifest))
        .toThrow(/foreign layers/i);

      const missingSizeManifest = JSON.stringify({
        config: {digest: `sha256:${'a'.repeat(64)}`},
        layers: [{}],
      });
      expect(() => packages.verifyOciManifestDigest(missingSizeManifest))
        .toThrow(/Invalid OCI layer size/);
    });

    test('formatAgentTargetId normalizes uppercase or repeated separators for OCI refs', () => {
      expect(packages.formatAgentTargetId('0_ERROR', '1.0.0-RC1..beta', 42))
        .toBe('0_error-1.0.0-rc1-beta-v42');
    });

    test('scrubError redacts base64 credentials from Buffer stderr properties', () => {
      const token = 'Bearer ghp_supersecret999';
      const b64 = Buffer.from('oauth2:ghp_supersecret999', 'utf8').toString('base64');
      const err = Object.assign(new Error(`Auth failed: ${b64}`), {
        stderr: Buffer.from(`header=${b64} raw=ghp_supersecret999`, 'utf8'),
      });
      const scrubbed = packages.scrubError(err, token) as Error & {stderr: Buffer};
      expect(scrubbed.message).not.toContain(b64);
      expect(scrubbed.stderr.toString('utf8')).toBe('header=[REDACTED] raw=[REDACTED]');
    });

    test('verifyOciManifestDigest pins full manifest digest rather than config digest', () => {
      const sampleManifest = JSON.stringify({
        config: {digest: `sha256:${'a'.repeat(64)}`},
        layers: [{size: 1024}, {size: 2048}],
      });
      const manifestSha = crypto.createHash('sha256').update(sampleManifest).digest('hex');
      expect(packages.verifyOciManifestDigest(sampleManifest, manifestSha).layerCount).toBe(2);
      expect(() => packages.verifyOciManifestDigest(sampleManifest, 'a'.repeat(64)))
        .toThrow(/OCI digest mismatch/);
      expect(() => packages.verifyOciManifestDigest(sampleManifest, 'b'.repeat(64)))
        .toThrow(/OCI digest mismatch/);
    });

    test('writePrivateSkopeoAuthfile writes 0600 Docker Hub credentials', () => {
      const authDir = path.join(tmpDir, 'skopeo-auth');
      fs.mkdirSync(authDir, {recursive: true});
      const authFile = packages.writePrivateSkopeoAuthfile(
        authDir,
        'pkmn/0-error:1.0.0',
        'Bearer ghp_supersecret999'
      );
      expect(fs.statSync(authFile).mode & 0o777).toBe(0o600);
      const authJson = JSON.parse(fs.readFileSync(authFile, 'utf8')) as {
        auths: Record<string, {auth: string}>;
      };
      expect(Buffer.from(authJson.auths['docker.io'].auth, 'base64').toString('utf8'))
        .toBe('oauth2:ghp_supersecret999');
    });

    test('scrubAuthSecret redacts bearer tokens from error messages', () => {
      expect(
        packages.scrubAuthSecret('Failed with ghp_supersecret999', 'Bearer ghp_supersecret999')
      ).toBe('Failed with [REDACTED]');
    });

    test('downloadAndUnpackBundle blocks unlisted hosts or off-allowlist redirects', async () => {
      await expect(
        packages.downloadAndUnpackBundle({
          url: 'https://releases.example.com/agent.tar.zst?X-Amz-Signature=123',
          expectedSha256: validArchiveSha,
          agentTargetId: 'agent-unlisted',
          stagingDir: path.join(tmpDir, 'staging-ssrf'),
          agentsDir: path.join(tmpDir, 'agents-ssrf'),
        })
      ).rejects.toThrow(/supported artifact host/);

      globalThis.fetch = () =>
        Promise.resolve(
          new Response('', {
            status: 302,
            headers: {location: 'https://169.254.169.254/latest/meta-data/'},
          })
        );
      await expect(
        packages.downloadAndUnpackBundle({
          url: 'https://github.com/pkmn/0-error/releases/download/v1/agent.tar.gz',
          expectedSha256: validArchiveSha,
          agentTargetId: 'agent-redirect-ssrf',
          stagingDir: path.join(tmpDir, 'staging-ssrf'),
          agentsDir: path.join(tmpDir, 'agents-ssrf'),
        })
      ).rejects.toThrow(/supported artifact host/);
    });

    test('downloadAndUnpackBundle strips Authorization across cross-origin redirects', async () => {
      const seenHeaders: Array<{url: string; auth: string | null}> = [];
      const archiveBytes = fs.readFileSync(validArchivePath);
      globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
        const u = typeof input === 'string'
          ? input
          : input instanceof URL ? input.toString() : input.url;
        const hdrs = new Headers(init?.headers);
        seenHeaders.push({url: u, auth: hdrs.get('authorization')});
        if (u.startsWith('https://github.com/')) {
          return Promise.resolve(
            new Response('', {
              status: 302,
              headers: {
                location:
                  'https://objects.githubusercontent.com/asset/agent.tar.gz?X-Amz-Signature=xyz#dl',
              },
            })
          );
        }
        return Promise.resolve(new Response(archiveBytes, {status: 200}));
      };

      const dlBytes = await packages.downloadAndUnpackBundle({
        url: 'https://github.com/pkmn/0-error/releases/download/v1/agent.tar.gz?token=1',
        expectedSha256: validArchiveSha,
        agentTargetId: 'agent-presigned',
        authToken: 'ghp_secret_redirect_token',
        stagingDir: path.join(tmpDir, 'staging-redir'),
        agentsDir: path.join(tmpDir, 'agents-redir'),
        casDir: path.join(tmpDir, 'cas-redir'),
      });
      expect(dlBytes).toBeGreaterThan(70_000);
      expect(seenHeaders).toEqual([
        {
          url: 'https://github.com/pkmn/0-error/releases/download/v1/agent.tar.gz?token=1',
          auth: 'Bearer ghp_secret_redirect_token',
        },
        {
          url: 'https://objects.githubusercontent.com/asset/agent.tar.gz?X-Amz-Signature=xyz#dl',
          auth: null,
        },
      ]);
    });
  });

  describe('arena/db Database', () => {
    test('loads individual .sql table definitions from arena/db/schema/', () => {
      expect(arenaDb.SCHEMA_FILES).toEqual([
        'ladder-counters.sql',
        'local-agents.sql',
        'local-matches.sql',
        'outbox.sql',
        'schema-migrations.sql',
      ]);
    });

    test('validates arena/db migrations against declarative schema definitions', () => {
      const schemaDir = path.join(tmpDir, 'arena-schema-eq');
      const migrationDir = path.join(tmpDir, 'arena-migration-eq');
      fs.mkdirSync(schemaDir, {recursive: true});
      fs.mkdirSync(migrationDir, {recursive: true});
      for (const file of arenaDb.SCHEMA_FILES) {
        fs.copyFileSync(
          path.join(arenaDb.SCHEMA_DIR, file),
          path.join(schemaDir, file)
        );
      }

      const migratedFile = path.join(tmpDir, 'arena-migrated.sqlite');
      const initDb = new arenaDb.Database(migratedFile, {schemaDir, migrationDir, now: 1000});
      initDb.close();

      fs.writeFileSync(
        path.join(migrationDir, '0001-mixed.sql'),
        'ALTER TABLE outbox ADD COLUMN note TEXT; DROP TABLE ladder_counters;'
      );
      expect(() => new arenaDb.Database(migratedFile, {schemaDir, migrationDir, now: 2000}))
        .toThrow(/mixes additive and destructive SQL statements/);

      fs.writeFileSync(
        path.join(migrationDir, '0001-add-outbox-note.sql'),
        'ALTER TABLE outbox ADD COLUMN note TEXT;'
      );
      fs.rmSync(path.join(migrationDir, '0001-mixed.sql'));
      const outboxSql = fs.readFileSync(path.join(schemaDir, 'outbox.sql'), 'utf8')
        .replace(
          '  updated_at INTEGER\n);',
          '  updated_at INTEGER,\n  note TEXT\n);'
        );
      fs.writeFileSync(path.join(schemaDir, 'outbox.sql'), outboxSql);

      const migratedDb = new arenaDb.Database(migratedFile, {schemaDir, migrationDir, now: 2000});
      const freshDb = new arenaDb.Database(':memory:', {schemaDir, migrationDir, now: 2000});
      try {
        expect(arenaDb.compareDatabaseSchemas(migratedDb.db, freshDb.db)).toEqual([]);
      } finally {
        migratedDb.close();
        freshDb.close();
      }
    });

    test('computeResidencyMultipliers boosts warm pairs over cold pairs', () => {
      const stateDb = new arenaDb.Database(':memory:');
      try {
        stateDb.upsertLocalAgent({
          versionId: 10,
          agentId: 1,
          slug: 'alpha',
          version: '1.0.0',
          mode: 'native',
          target: 'alpha-1.0.0-v10',
          residency: 'hot',
          unpackedBytes: 1024,
        });
        stateDb.upsertLocalAgent({
          versionId: 20,
          agentId: 2,
          slug: 'beta',
          version: '1.0.0',
          mode: 'native',
          target: 'beta-1.0.0-v20',
          residency: 'cold',
          unpackedBytes: 2048,
        });

        expect(packages.computeResidencyMultipliers([10, 20], stateDb)[1]).toBeCloseTo(1.05, 5);
        stateDb.setAgentResidency(20, 'hot');
        expect(packages.computeResidencyMultipliers([10, 20], stateDb)[1]).toBeCloseTo(1.15, 5);
      } finally {
        stateDb.close();
      }
    });

    test('tracks per-format plus global match sequence numbers', () => {
      const stateDb = new arenaDb.Database(':memory:');
      try {
        expect(stateDb.nextMatchSequence('gen9ou')).toBe(1);
        expect(stateDb.nextMatchSequence('gen9ou')).toBe(2);
        expect(stateDb.getMatchSequence('gen9ou')).toBe(2);
        expect(stateDb.getLastGlobalMatchSequence('gen9ou')).toBe(2);
        expect(stateDb.nextMatchSequence('gen1ou')).toBe(1);
        expect(stateDb.getLastGlobalMatchSequence('gen1ou')).toBe(3);
        expect(stateDb.getGlobalMatchCount()).toBe(3);
      } finally {
        stateDb.close();
      }
    });

    test('resets consecutive fault counters after a clean game', () => {
      const stateDb = new arenaDb.Database(':memory:');
      try {
        stateDb.upsertLocalAgent({
          versionId: 10,
          agentId: 1,
          slug: 'alpha',
          version: '1.0.0',
          mode: 'native',
          target: 'alpha-1.0.0-v10',
          residency: 'hot',
          unpackedBytes: 1024,
        });
        stateDb.recordAgentGameResult(10, true, 1000);
        stateDb.recordAgentGameResult(10, true, 1005);
        expect(stateDb.getLocalAgent(10)?.consecutiveFaults).toBe(2);
        stateDb.recordAgentGameResult(10, false, 1010);
        expect(stateDb.getLocalAgent(10)?.consecutiveFaults).toBe(0);
        expect(stateDb.getLocalAgent(10)?.totalGames).toBe(3);
        expect(stateDb.getLocalAgent(10)?.totalFaults).toBe(2);
      } finally {
        stateDb.close();
      }
    });

    test('evictColdAgentsIfNeeded evicts oldest hot container without touching native', () => {
      const stateDb = new arenaDb.Database(':memory:');
      try {
        stateDb.upsertLocalAgent({
          versionId: 10,
          agentId: 1,
          slug: 'alpha',
          version: '1.0.0',
          mode: 'native',
          target: 'alpha-1.0.0-v10',
          residency: 'hot',
          unpackedBytes: 1024,
        });
        stateDb.upsertLocalAgent({
          versionId: 30,
          agentId: 3,
          slug: 'gamma',
          version: '1.0.0',
          mode: 'container',
          target: 'gamma-1.0.0-v30',
          residency: 'hot',
          unpackedBytes: 6000,
        });
        stateDb.upsertLocalAgent({
          versionId: 40,
          agentId: 4,
          slug: 'delta',
          version: '1.0.0',
          mode: 'container',
          target: 'delta-1.0.0-v40',
          residency: 'hot',
          unpackedBytes: 6000,
        });
        stateDb.setAgentResidency(30, 'hot', 1000);
        stateDb.setAgentResidency(40, 'hot', 2000);

        const evictedTargets: string[] = [];
        const evicted = packages.evictColdAgentsIfNeeded(stateDb, {
          containerHighWaterBytes: 10_000,
          containerLowWaterBytes: 7_000,
          coldDir: path.join(tmpDir, 'cold-containers'),
          evictContainerFn: target => evictedTargets.push(target),
        });
        expect(evicted).toEqual([30]);
        expect(evictedTargets).toEqual(['gamma-1.0.0-v30']);
        expect(stateDb.getLocalAgent(30)?.residency).toBe('cold');
        expect(stateDb.getLocalAgent(10)?.residency).toBe('hot');
      } finally {
        stateDb.close();
      }
    });

    test('sizes default hot-cache watermarks within the 256 GB Mac mini SSD', () => {
      expect(packages.HOT_AGENTS_HIGH_WATER_BYTES).toBe(110_000_000_000);
      expect(packages.HOT_AGENTS_LOW_WATER_BYTES).toBe(85_000_000_000);
      expect(packages.HOT_CONTAINERS_HIGH_WATER_BYTES).toBe(32_000_000_000);
      expect(packages.HOT_CONTAINERS_LOW_WATER_BYTES).toBe(24_000_000_000);
    });

    test('evictColdAgentsIfNeeded prunes orphaned CAS blobs on native eviction', () => {
      const stateDb = new arenaDb.Database(':memory:');
      try {
        const agentsDir = path.join(tmpDir, 'evict-native-agents');
        const casRoot = path.join(tmpDir, 'evict-native-cas');
        fs.mkdirSync(path.join(agentsDir, 'old-v1'), {recursive: true});
        fs.mkdirSync(path.join(agentsDir, 'new-v2'), {recursive: true});

        const orphanBuf = Buffer.alloc(70_000, 0x11);
        const orphanDigest = crypto.createHash('sha256').update(orphanBuf).digest('hex');
        const orphanShard = path.join(casRoot, orphanDigest.slice(0, 2));
        fs.mkdirSync(orphanShard, {recursive: true});
        const orphanBlob = path.join(orphanShard, orphanDigest);
        fs.writeFileSync(orphanBlob, orphanBuf);
        fs.writeFileSync(path.join(agentsDir, 'old-v1', 'weights.bin'), orphanBuf);

        const sharedBuf = Buffer.alloc(70_000, 0x22);
        const sharedDigest = crypto.createHash('sha256').update(sharedBuf).digest('hex');
        const sharedShard = path.join(casRoot, sharedDigest.slice(0, 2));
        fs.mkdirSync(sharedShard, {recursive: true});
        const sharedBlob = path.join(sharedShard, sharedDigest);
        fs.writeFileSync(sharedBlob, sharedBuf);
        fs.writeFileSync(path.join(agentsDir, 'new-v2', 'weights.bin'), sharedBuf);

        stateDb.upsertLocalAgent({
          versionId: 1,
          agentId: 1,
          slug: 'old',
          version: '1.0.0',
          mode: 'native',
          target: 'old-v1',
          residency: 'hot',
          unpackedBytes: 70_000,
        });
        stateDb.upsertLocalAgent({
          versionId: 2,
          agentId: 2,
          slug: 'new',
          version: '1.0.0',
          mode: 'native',
          target: 'new-v2',
          residency: 'hot',
          unpackedBytes: 70_000,
        });
        stateDb.setAgentResidency(1, 'hot', 100);
        stateDb.setAgentResidency(2, 'hot', 200);

        const evicted = packages.evictColdAgentsIfNeeded(stateDb, {
          highWaterBytes: 100_000,
          lowWaterBytes: 80_000,
          agentsDir,
          coldDir: path.join(tmpDir, 'evict-native-cold'),
          casDir: casRoot,
        });
        expect(evicted).toEqual([1]);
        expect(fs.existsSync(orphanBlob)).toBe(false);
        expect(fs.existsSync(sharedBlob)).toBe(true);
      } finally {
        stateDb.close();
      }
    });

    test('evictColdAgentsIfNeeded eagerly evicts retired versions below watermark', () => {
      const stateDb = new arenaDb.Database(':memory:');
      try {
        const agentsDir = path.join(tmpDir, 'evict-retired-agents');
        const coldDir = path.join(tmpDir, 'evict-retired-cold');
        const retiredDir = path.join(agentsDir, 'retired-v1');
        const activeDir = path.join(agentsDir, 'active-v2');
        fs.mkdirSync(retiredDir, {recursive: true});
        fs.mkdirSync(activeDir, {recursive: true});
        fs.writeFileSync(path.join(retiredDir, 'run'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
        fs.writeFileSync(path.join(activeDir, 'run'), '#!/bin/sh\nexit 0\n', {mode: 0o755});

        stateDb.upsertLocalAgent({
          versionId: 1,
          agentId: 1,
          slug: 'retired',
          version: '1.0.0',
          mode: 'native',
          target: 'retired-v1',
          residency: 'hot',
          unpackedBytes: 1024,
        });
        stateDb.upsertLocalAgent({
          versionId: 2,
          agentId: 2,
          slug: 'active',
          version: '2.0.0',
          mode: 'native',
          target: 'active-v2',
          residency: 'hot',
          unpackedBytes: 1024,
        });

        const evicted = packages.evictColdAgentsIfNeeded(stateDb, {
          agentsDir,
          coldDir,
          activeVersionIds: new Set([2]),
        });
        expect(evicted).toEqual([1]);
        expect(stateDb.getLocalAgent(1)?.residency).toBe('cold');
        expect(stateDb.getLocalAgent(2)?.residency).toBe('hot');
        expect(fs.existsSync(retiredDir)).toBe(false);
        expect(fs.existsSync(path.join(coldDir, 'retired-v1.tar.zst'))).toBe(true);

        const restored = packages.ensureAgentResident(stateDb, 1, {
          agentsDir,
          coldDir,
          casDir: path.join(tmpDir, 'evict-retired-cas'),
          now: 9000,
        });
        expect(restored?.residency).toBe('hot');
        expect(fs.existsSync(path.join(retiredDir, 'run'))).toBe(true);
      } finally {
        stateDb.close();
      }
    });

    test('ensureAgentResident throws when cold archive is missing', () => {
      const stateDb = new arenaDb.Database(':memory:');
      try {
        const agentsDir = path.join(tmpDir, 'missing-cold-agents');
        const coldDir = path.join(tmpDir, 'missing-cold-dir');
        stateDb.upsertLocalAgent({
          versionId: 77,
          agentId: 7,
          slug: 'ghost',
          version: '1.0.0',
          mode: 'native',
          target: 'ghost-1.0.0-v77',
          residency: 'cold',
          unpackedBytes: 1024,
        });
        expect(() => packages.ensureAgentResident(stateDb, 77, {agentsDir, coldDir}))
          .toThrow(/Cold archive missing/);
        expect(stateDb.getLocalAgent(77)?.residency).toBe('cold');
        expect(fs.existsSync(path.join(agentsDir, 'ghost-1.0.0-v77'))).toBe(false);
      } finally {
        stateDb.close();
      }
    });
  });

  describe('TimeSlicedArenaGame', () => {
    test('runs sequential @pkmn/sim battles with chat elision plus smoke stop', async () => {
      const heartbeats: arbiter.TurnHeartbeatInfo[] = [];
      const game = new arbiter.TimeSlicedArenaGame({
        format: 'gen9customgame',
        seed: '1,2,3,4',
        p1Spec: {mode: 'native', target: process.execPath, args: [defaultAgentScript]},
        p2Spec: {mode: 'native', target: process.execPath, args: [defaultAgentScript]},
        p1TeamPacked: TEAM_ONE,
        p2TeamPacked: TEAM_TWO,
        smokeStopAfterTurn: 1,
        devMode: true,
        onTurn: info => {
          heartbeats.push(info);
        },
      });

      const result = await game.run();
      expect(result.endReason).toBe('smoke-complete');
      expect(result.turns).toBe(2);
      expect(heartbeats.length).toBeGreaterThanOrEqual(2);
      expect(result.omniscientLog).not.toContain('hello from agent');
      expect(result.omniscientLog).toContain('|player|p1|Agent A|');
      expect(result.omniscientLog).toContain('|player|p2|Agent B|');
    });

    test('omits |utm| on stdin for Random Battle formats', async () => {
      const randUtmLog = path.join(tmpDir, 'arbiter-rand-utm.log');
      const probeScript = path.join(tmpDir, 'arbiter-rand-probe.js');
      fs.writeFileSync(randUtmLog, '');
      fs.writeFileSync(
        probeScript,
        [
          '#!/usr/bin/env node',
          'const fs = require("fs");',
          'const readline = require("readline");',
          'const rl = readline.createInterface({input: process.stdin, crlfDelay: Infinity});',
          'rl.on("line", line => {',
          '  if (line.startsWith("|utm|")) {',
          `    fs.appendFileSync(${JSON.stringify(randUtmLog)}, line + "\\n");`,
          '    return;',
          '  }',
          '  if (!line.startsWith("|request|")) return;',
          '  const raw = line.slice(9).trim();',
          '  if (!raw || raw === "null") return;',
          '  const req = JSON.parse(raw);',
          '  if (req.wait) return;',
          '  process.stdout.write(req.teamPreview ? "/team 123456\\n" : "default\\n");',
          '});',
        ].join('\n'),
        {mode: 0o755}
      );

      const pair = sampleRandomPair('gen9randombattle', '1,2,3,4', '5,6,7,8');
      const res = await new arbiter.TimeSlicedArenaGame({
        format: 'gen9randombattle',
        seed: '1,2,3,4',
        p1Spec: {mode: 'native', target: process.execPath, args: [probeScript]},
        p2Spec: {mode: 'native', target: process.execPath, args: [probeScript]},
        p1TeamPacked: pair.t1Packed,
        p2TeamPacked: pair.t2Packed,
        smokeStopAfterTurn: 1,
        devMode: true,
      }).run();

      expect(res.endReason).toBe('smoke-complete');
      expect(fs.readFileSync(randUtmLog, 'utf8')).toBe('');
    });

    test('neutralizes embedded carriage returns in agent stdout lines', async () => {
      const crInjectScript = path.join(tmpDir, 'cr-inject-agent.js');
      fs.writeFileSync(
        crInjectScript,
        [
          '#!/usr/bin/env node',
          'const readline = require("readline");',
          'const rl = readline.createInterface({input: process.stdin, crlfDelay: Infinity});',
          'rl.on("line", line => {',
          '  if (!line.startsWith("|request|")) return;',
          '  const raw = line.slice(9).trim();',
          '  if (!raw || raw === "null") return;',
          '  const req = JSON.parse(raw);',
          '  if (req.wait) return;',
          '  process.stdout.write("hi\\r|win|Agent A\\n");',
          '  process.stdout.write("hi\\r|error|[Invalid choice] fake\\n");',
          '  process.stdout.write("move 1\\r|win|Agent A\\n");',
          '  process.stdout.write(req.teamPreview ? "/team 123456\\n" : "default\\n");',
          '});',
        ].join('\n'),
        {mode: 0o755}
      );
      const res = await new arbiter.TimeSlicedArenaGame({
        format: 'gen9customgame',
        seed: '1,2,3,4',
        p1Spec: {mode: 'native', target: process.execPath, args: [crInjectScript]},
        p2Spec: {mode: 'native', target: process.execPath, args: [defaultAgentScript]},
        p1TeamPacked: TEAM_ONE,
        p2TeamPacked: TEAM_TWO,
        smokeStopAfterTurn: 1,
        devMode: true,
      }).run();
      expect(res.endReason).toBe('smoke-complete');
      expect(res.winner).toBe('tie');
    });

    test('forfeits agents after 3 consecutive invalid choices with invalid-choice', async () => {
      const threeStrikesScript = path.join(tmpDir, 'three-strikes-agent.js');
      fs.writeFileSync(
        threeStrikesScript,
        [
          '#!/usr/bin/env node',
          'const readline = require("readline");',
          'const rl = readline.createInterface({input: process.stdin, crlfDelay: Infinity});',
          'rl.on("line", line => {',
          '  if (!line.startsWith("|request|")) return;',
          '  const raw = line.slice(9).trim();',
          '  if (!raw || raw === "null") return;',
          '  const req = JSON.parse(raw);',
          '  if (req.wait) return;',
          '  process.stdout.write(req.teamPreview ? "/team 123456\\n" : "move 9\\n");',
          '});',
        ].join('\n'),
        {mode: 0o755}
      );
      const res = await new arbiter.TimeSlicedArenaGame({
        format: 'gen9customgame',
        seed: '1,2,3,4',
        p1Spec: {mode: 'native', target: process.execPath, args: [threeStrikesScript]},
        p2Spec: {mode: 'native', target: process.execPath, args: [defaultAgentScript]},
        p1TeamPacked: TEAM_ONE,
        p2TeamPacked: TEAM_TWO,
        devMode: true,
      }).run();
      expect(res.winner).toBe('p2');
      expect(res.endReason).toBe('invalid-choice');
      expect(res.omniscientLog).toContain('|win|Agent B');
      expect(res.omniscientLog).not.toMatch(/\n\|tie(?:\n|$)/);
    });

    test('forfeits crashing agents immediately with crash', async () => {
      const res = await new arbiter.TimeSlicedArenaGame({
        format: 'gen9customgame',
        seed: '1,2,3,4',
        p1Spec: {mode: 'native', target: process.execPath, args: [crashingAgentScript]},
        p2Spec: {mode: 'native', target: process.execPath, args: [defaultAgentScript]},
        p1TeamPacked: TEAM_ONE,
        p2TeamPacked: TEAM_TWO,
        devMode: true,
      }).run();
      expect(res.winner).toBe('p2');
      expect(res.endReason).toBe('crash');
    });

    test('ignores undo choices without deadlocking the battle loop', async () => {
      const undoAgentScript = path.join(tmpDir, 'undo-agent.js');
      fs.writeFileSync(
        undoAgentScript,
        [
          '#!/usr/bin/env node',
          'const readline = require("readline");',
          'const rl = readline.createInterface({input: process.stdin, crlfDelay: Infinity});',
          'rl.on("line", line => {',
          '  if (!line.startsWith("|request|")) return;',
          '  const raw = line.slice(9).trim();',
          '  if (!raw || raw === "null") return;',
          '  const req = JSON.parse(raw);',
          '  if (req.wait) return;',
          '  process.stdout.write("undo\\n/undo\\n/choose undo\\n");',
          '  process.stdout.write(req.teamPreview ? "/team 123456\\n" : "default\\n");',
          '});',
        ].join('\n'),
        {mode: 0o755}
      );
      const res = await new arbiter.TimeSlicedArenaGame({
        format: 'gen9customgame',
        seed: '1,2,3,4',
        p1Spec: {mode: 'native', target: process.execPath, args: [undoAgentScript]},
        p2Spec: {mode: 'native', target: process.execPath, args: [defaultAgentScript]},
        p1TeamPacked: TEAM_ONE,
        p2TeamPacked: TEAM_TWO,
        smokeStopAfterTurn: 1,
        devMode: true,
      }).run();
      expect(res.endReason).toBe('smoke-complete');
    });

    test('sampleRandomPair generates distinct 6-Pokémon Gen 9 Random Battle teams', () => {
      const randTeams = sampleRandomPair('gen9randombattle', '1,2,3,4', '5,6,7,8');
      expect(Teams.unpack(randTeams.t1Packed)).toHaveLength(6);
      expect(Teams.unpack(randTeams.t2Packed)).toHaveLength(6);
      expect(randTeams.t1Packed).not.toBe(randTeams.t2Packed);
    });

    test('runs VGC ladder games under Closed Team Sheets by default', async () => {
      const res = await new arbiter.TimeSlicedArenaGame({
        format: 'gen9championsvgc2026regmc',
        seed: '1,2,3,4',
        p1Spec: {mode: 'native', target: process.execPath, args: [defaultAgentScript]},
        p2Spec: {mode: 'native', target: process.execPath, args: [defaultAgentScript]},
        p1TeamPacked: TEAM_ONE,
        p2TeamPacked: TEAM_TWO,
        smokeStopAfterTurn: 1,
        devMode: true,
      }).run();
      expect(res.endReason).toBe('smoke-complete');
      expect(res.omniscientLog).toContain('|gametype|doubles');
      expect(res.omniscientLog).toContain('|teampreview|4');
      expect(res.omniscientLog).not.toContain('|showteam|');
    });

    test('reveals |showteam| when Open Team Sheets custom rule is enabled', async () => {
      const res = await new arbiter.TimeSlicedArenaGame({
        format: 'gen9championsvgc2026regmc',
        customRules: ['Open Team Sheets'],
        seed: '1,2,3,4',
        p1Spec: {mode: 'native', target: process.execPath, args: [defaultAgentScript]},
        p2Spec: {mode: 'native', target: process.execPath, args: [defaultAgentScript]},
        p1TeamPacked: TEAM_ONE,
        p2TeamPacked: TEAM_TWO,
        smokeStopAfterTurn: 1,
        devMode: true,
      }).run();
      expect(res.endReason).toBe('smoke-complete');
      expect(res.omniscientLog).toContain('|showteam|p1|');
      expect(res.omniscientLog).toContain('|showteam|p2|');
    });

    test('withholds extra bank increments when retrying invalid choices', async () => {
      const invalidRetryScript = path.join(tmpDir, 'invalid-retry-agent.js');
      fs.writeFileSync(
        invalidRetryScript,
        [
          '#!/usr/bin/env node',
          'const readline = require("readline");',
          'const rl = readline.createInterface({input: process.stdin, crlfDelay: Infinity});',
          'let badCount = 0;',
          'let sawInactive = false;',
          'rl.on("line", line => {',
          '  if (line.startsWith("|inactive|Time left:")) sawInactive = true;',
          '  if (!line.startsWith("|request|")) return;',
          '  const raw = line.slice(9).trim();',
          '  if (!raw || raw === "null") return;',
          '  const req = JSON.parse(raw);',
          '  if (req.wait) return;',
          '  if (!req.teamPreview && badCount < 2) {',
          '    badCount++;',
          '    process.stdout.write("move 9\\n");',
          '    return;',
          '  }',
          '  if (!sawInactive && !req.teamPreview) process.exit(2);',
          '  process.stdout.write(req.teamPreview ? "/team 123456\\n" : "default\\n");',
          '});',
        ].join('\n'),
        {mode: 0o755}
      );
      const res = await new arbiter.TimeSlicedArenaGame({
        format: 'gen9customgame',
        seed: '1,2,3,4',
        p1Spec: {mode: 'native', target: process.execPath, args: [invalidRetryScript]},
        p2Spec: {mode: 'native', target: process.execPath, args: [defaultAgentScript]},
        p1TeamPacked: TEAM_ONE,
        p2TeamPacked: TEAM_TWO,
        startingBankSeconds: 100,
        maxTurnSeconds: 150,
        smokeStopAfterTurn: 1,
        devMode: true,
      }).run();
      expect(res.endReason).toBe('smoke-complete');
      expect(res.p1.bankSeconds).toBeLessThanOrEqual(res.p2.bankSeconds);
    });

    test('forfeits agents writing over 64 KiB without a newline', async () => {
      const floodScript = path.join(tmpDir, 'flood-agent.js');
      fs.writeFileSync(
        floodScript,
        '#!/usr/bin/env node\nprocess.stdout.write("A".repeat(100000));\n',
        {mode: 0o755}
      );
      const res = await new arbiter.TimeSlicedArenaGame({
        format: 'gen9customgame',
        seed: '1,2,3,4',
        p1Spec: {mode: 'native', target: process.execPath, args: [floodScript]},
        p2Spec: {mode: 'native', target: process.execPath, args: [defaultAgentScript]},
        p1TeamPacked: TEAM_ONE,
        p2TeamPacked: TEAM_TWO,
        devMode: true,
      }).run();
      expect(res.winner).toBe('p2');
      expect(res.endReason).toBe('crash');
    });

    test('decays non-VGC turn increments after Turn 100 or Turn 200', () => {
      const lastRewarded = {p1: 100, p2: 100};
      const player: arbiter.PlayerClockState = {
        slot: 'p1',
        bankMillis: 50_000,
        hasTakenFirstDecision: true,
        retryingInvalidChoice: false,
      };
      const baseTimers = {
        firstTurnGraceMillis: 60_000,
        maxTurnMillis: 150_000,
        fullTurnIncrementMillis: 10_000,
        midTurnIncrementMillis: 5_000,
      };

      const step101 = arbiter.beginTurnClockStep(player, 101, lastRewarded, {
        ...baseTimers,
        accelerate: true,
        requestCount: 202,
      });
      expect(step101.incrementMillis).toBe(5_000);
      expect(player.bankMillis).toBe(55_000);

      lastRewarded.p1 = 200;
      const step201Zero = arbiter.beginTurnClockStep(player, 201, lastRewarded, {
        ...baseTimers,
        accelerate: true,
        requestCount: 402,
      });
      expect(step201Zero.incrementMillis).toBe(0);
      expect(player.bankMillis).toBe(55_000);

      const step202Five = arbiter.beginTurnClockStep(player, 202, lastRewarded, {
        ...baseTimers,
        accelerate: true,
        requestCount: 404,
      });
      expect(step202Five.incrementMillis).toBe(5_000);
      expect(player.bankMillis).toBe(60_000);

      const vgcStep = arbiter.beginTurnClockStep(player, 203, lastRewarded, {
        ...baseTimers,
        fullTurnIncrementMillis: 15_000,
        accelerate: false,
        requestCount: 406,
      });
      expect(vgcStep.incrementMillis).toBe(15_000);
      expect(player.bankMillis).toBe(75_000);
    });

    test('grants mid-turn switch increments only when a single side acts', () => {
      const lastRewarded = {p1: 5, p2: 5};
      const player: arbiter.PlayerClockState = {
        slot: 'p1',
        bankMillis: 50_000,
        hasTakenFirstDecision: true,
        retryingInvalidChoice: false,
      };
      const timers = {
        firstTurnGraceMillis: 60_000,
        maxTurnMillis: 150_000,
        fullTurnIncrementMillis: 10_000,
        midTurnIncrementMillis: 5_000,
      };

      const bothSwitch = arbiter.beginTurnClockStep(player, 5, lastRewarded, {
        ...timers,
        activeSidesCount: 2,
      });
      expect(bothSwitch.incrementMillis).toBe(0);
      expect(player.bankMillis).toBe(50_000);

      const singleSwitch = arbiter.beginTurnClockStep(player, 5, lastRewarded, {
        ...timers,
        activeSidesCount: 1,
      });
      expect(singleSwitch.incrementMillis).toBe(5_000);
      expect(player.bankMillis).toBe(55_000);
    });

    test('alternates first CPU slice across waves while reporting live RAM', async () => {
      const p1PeakFile = path.join(tmpDir, 'live-ram-p1.txt');
      fs.writeFileSync(p1PeakFile, '128\n');
      const heartbeats: arbiter.TurnHeartbeatInfo[] = [];
      const res = await new arbiter.TimeSlicedArenaGame({
        format: 'gen9customgame',
        seed: '1,2,3,4',
        p1Spec: {
          mode: 'native',
          target: process.execPath,
          args: [defaultAgentScript],
          env: {ARENA_PEAK_RAM_FILE: p1PeakFile},
        },
        p2Spec: {mode: 'native', target: process.execPath, args: [defaultAgentScript]},
        p1TeamPacked: TEAM_ONE,
        p2TeamPacked: TEAM_TWO,
        smokeStopAfterTurn: 1,
        devMode: true,
        onTurn: info => {
          heartbeats.push(info);
        },
      }).run();
      expect(res.endReason).toBe('smoke-complete');
      expect(heartbeats.slice(0, 4).map(h => h.activeSlot)).toEqual(['p1', 'p2', 'p2', 'p1']);
      expect(heartbeats[0].p1.ram).toBe(128);
      expect(res.p1.peakRam).toBe(128);
    });

    test('inspectPlayerProtocolChunk exempts Unavailable choice from strike counter', () => {
      const state: arbiter.ProtocolStrikeState = {
        retryingInvalidChoice: false,
        invalidStrikes: 0,
        lastRequestJson: '{"active":[{"moves":[{"id":"tackle"}]}]}',
      };
      for (let i = 0; i < 4; i++) {
        const res = arbiter.inspectPlayerProtocolChunk(
          '|error|[Unavailable choice] Can\'t switch: The active Pokémon is trapped',
          state,
          false
        );
        expect(res.forfeitedInvalidChoice).toBe(false);
        expect(res.resendLastRequest).toBe(false);
        expect(state.invalidStrikes).toBe(0);
        expect(state.retryingInvalidChoice).toBe(true);
      }
    });

    test('formatChoiceCommand preserves default or auto keywords on team preview', () => {
      expect(arbiter.formatChoiceCommand('default', true)).toBe('default');
      expect(arbiter.formatChoiceCommand('auto', true)).toBe('auto');
      expect(arbiter.formatChoiceCommand('1234', true)).toBe('team 1234');
      expect(arbiter.formatChoiceCommand('team 1234', true)).toBe('team 1234');
    });

    test('rewriteBlindPlayerNames substitutes display names in a single pass', () => {
      const raw = '|player|p1|Agent A|101|\n|player|p2|Agent B|102|\n|win|Agent A';
      const out = arbiter.rewriteBlindPlayerNames(raw, 'Agent B', 'Rival');
      expect(out).toBe('|player|p1|Agent B|101|\n|player|p2|Rival|102|\n|win|Agent B');
    });

    test('parsePrngSeed accepts 256-bit sodium seeds alongside legacy 4-uint16 seeds', () => {
      const hex = 'a1'.repeat(32);
      const parsed = coordinator.parsePrngSeed(`sodium,${hex.toUpperCase()}`);
      expect(parsed).toBe(`sodium,${hex}`);
      const derived = tournament.deriveGameSeed(parsed, 2);
      expect(String(derived)).toMatch(/^sodium,[0-9a-f]{64}$/);
      expect(derived).not.toBe(parsed);
      expect(coordinator.parsePrngSeed('1, 2, 3, 4')).toBe('1,2,3,4');
    });
  });

  describe('ConcurrentTournamentGame', () => {
    test('rewrites blind Agent A/B protocol names to entrant display names', async () => {
      const spectatorChunks: string[] = [];
      const blindRes = await new tournament.ConcurrentGame({
        format: 'gen9customgame',
        seed: '1,2,3,4',
        p1Spec: {
          agentId: 'foul-play',
          displayName: 'Foul Play',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          localCommand: relayBin,
          localArgs: [process.execPath, defaultAgentScript],
        },
        p2Spec: {
          agentId: 'pokechamp',
          displayName: 'PokeChamp',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          localCommand: relayBin,
          localArgs: [process.execPath, defaultAgentScript],
        },
        p1TeamPacked: TEAM_ONE,
        p2TeamPacked: TEAM_TWO,
        maxTurns: 2,
        onSpectatorChunk: chunk => spectatorChunks.push(chunk),
      }).run();

      expect(blindRes.turns).toBeGreaterThanOrEqual(2);
      expect(blindRes.omniscientLog).toContain('|player|p1|Foul Play|');
      expect(blindRes.omniscientLog).toContain('|player|p2|PokeChamp|');
      expect(blindRes.omniscientLog).not.toContain('|player|p1|Agent A|');
      expect(spectatorChunks.length).toBeGreaterThan(0);
      expect(tournament.rewriteBlindPlayerNames('|win|Agent A', 'Alpha', 'Beta'))
        .toBe('|win|Alpha');
    });

    test('reads initial /utm line from agents when teams are not pre-assigned', async () => {
      const utmRes = await new tournament.ConcurrentGame({
        format: 'gen9ou',
        seed: '1,2,3,4',
        p1Spec: {
          agentId: 'foul-play',
          displayName: 'Foul Play',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          localCommand: relayBin,
          localArgs: [process.execPath, tourneyUtmAgentScript],
        },
        p2Spec: {
          agentId: 'pokechamp',
          displayName: 'PokeChamp',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          localCommand: relayBin,
          localArgs: [process.execPath, tourneyUtmAgentScript],
        },
        maxTurns: 1,
      }).run();
      expect(utmRes.p1.teamPacked).toBeTruthy();
      expect(utmRes.p2.teamPacked).toBeTruthy();
      expect(utmRes.turns).toBeGreaterThanOrEqual(1);
    });

    test('omits |utm| on stdin for Random Battle tournament games', async () => {
      const tourneyRandUtmLog = path.join(tmpDir, 'tourney-rand-utm.log');
      const probeScript = path.join(tmpDir, 'tourney-rand-probe.js');
      fs.writeFileSync(tourneyRandUtmLog, '');
      fs.writeFileSync(
        probeScript,
        [
          '#!/usr/bin/env node',
          'const fs = require("fs");',
          'const readline = require("readline");',
          'const rl = readline.createInterface({input: process.stdin, crlfDelay: Infinity});',
          'rl.on("line", line => {',
          '  if (line.startsWith("|utm|")) {',
          `    fs.appendFileSync(${JSON.stringify(tourneyRandUtmLog)}, line + "\\n");`,
          '    return;',
          '  }',
          '  if (!line.startsWith("|request|")) return;',
          '  const raw = line.slice(9).trim();',
          '  if (!raw || raw === "null") return;',
          '  const req = JSON.parse(raw);',
          '  if (req.wait) return;',
          '  process.stdout.write(req.teamPreview ? "/team 123456\\n" : "default\\n");',
          '});',
        ].join('\n'),
        {mode: 0o755}
      );

      const pair = sampleRandomPair('gen9randombattle', '1,2,3,4', '5,6,7,8');
      const randRes = await new tournament.ConcurrentGame({
        format: 'gen9randombattle',
        seed: '1,2,3,4',
        p1Spec: {
          agentId: 'foul-play',
          displayName: 'Foul Play',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          localCommand: relayBin,
          localArgs: [process.execPath, probeScript],
        },
        p2Spec: {
          agentId: 'pokechamp',
          displayName: 'PokeChamp',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          localCommand: relayBin,
          localArgs: [process.execPath, probeScript],
        },
        p1TeamPacked: pair.t1Packed,
        p2TeamPacked: pair.t2Packed,
        maxTurns: 1,
      }).run();

      expect(randRes.turns).toBeGreaterThanOrEqual(1);
      expect(fs.readFileSync(tourneyRandUtmLog, 'utf8')).toBe('');
    });

    test('forfeits entrant immediately when first stdout line is an invalid team', async () => {
      const badTeamScript = path.join(tmpDir, 'bad-team-agent.js');
      fs.writeFileSync(
        badTeamScript,
        '#!/usr/bin/env node\n' +
        'process.stdout.write("/utm Mewtwo||leftovers|pressure|recover|||\\n");\n',
        {mode: 0o755}
      );

      const badRes = await new tournament.ConcurrentGame({
        format: 'gen9ou',
        seed: '1,2,3,4',
        p1Spec: {
          agentId: 'bad-agent',
          displayName: 'Bad Agent',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          localCommand: relayBin,
          localArgs: [process.execPath, badTeamScript],
        },
        p2Spec: {
          agentId: 'pokechamp',
          displayName: 'PokeChamp',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          localCommand: relayBin,
          localArgs: [process.execPath, tourneyUtmAgentScript],
        },
        maxTurns: 1,
      }).run();
      expect(badRes.winner).toBe('p2');
      expect(badRes.outcome).toBe('L');
      expect(badRes.endReason).toBe('invalid-choice');
    });

    test('aborts without penalty on trusted ARENA_SPOT_PREEMPTED signal', async () => {
      const preemptScript = path.join(tmpDir, 'preempt-agent.js');
      fs.writeFileSync(
        preemptScript,
        '#!/usr/bin/env node\n' +
        'process.stderr.write("ARENA_SPOT_PREEMPTED\\n");\nprocess.exit(143);\n',
        {mode: 0o755}
      );

      const preemptRes = await new tournament.ConcurrentGame({
        format: 'gen9customgame',
        seed: '1,2,3,4',
        p1Spec: {
          agentId: 'foul-play',
          displayName: 'Foul Play',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          localCommand: process.execPath,
          localArgs: [defaultAgentScript],
        },
        p2Spec: {
          agentId: 'pokechamp',
          displayName: 'PokeChamp',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          localCommand: process.execPath,
          localArgs: [preemptScript],
        },
        p1TeamPacked: TEAM_ONE,
        p2TeamPacked: TEAM_TWO,
      }).run();
      expect(preemptRes.winner).toBe('preempted');
      expect(preemptRes.preemptedSlot).toBe('p2');
      expect(preemptRes.endReason).toBe('spot-preemption');
    });

    test('isolates child stderr inside tourney-relay against spoofed preemption', async () => {
      const preemptScript = path.join(tmpDir, 'spoof-preempt-agent.js');
      fs.writeFileSync(
        preemptScript,
        '#!/usr/bin/env node\n' +
        'process.stderr.write("ARENA_SPOT_PREEMPTED\\n");\nprocess.exit(143);\n',
        {mode: 0o755}
      );

      const spoofedRes = await new tournament.ConcurrentGame({
        format: 'gen9customgame',
        seed: '1,2,3,4',
        p1Spec: {
          agentId: 'foul-play',
          displayName: 'Foul Play',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          localCommand: relayBin,
          localArgs: [process.execPath, defaultAgentScript],
        },
        p2Spec: {
          agentId: 'pokechamp',
          displayName: 'PokeChamp',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          localCommand: relayBin,
          localArgs: [process.execPath, preemptScript],
        },
        p1TeamPacked: TEAM_ONE,
        p2TeamPacked: TEAM_TWO,
      }).run();
      expect(spoofedRes.winner).toBe('p1');
      expect(spoofedRes.endReason).toBe('crash');
    });

    test('finalizeUnpackedOciRootfs synthesizes /.arena-run when /run is an FHS directory', () => {
      const bundleDir = path.join(tmpDir, 'oci-fhs-run');
      const rootfsDir = path.join(bundleDir, 'rootfs');
      fs.mkdirSync(path.join(rootfsDir, 'run'), {recursive: true});
      fs.mkdirSync(path.join(rootfsDir, 'app'), {recursive: true});
      fs.writeFileSync(path.join(rootfsDir, 'app', 'agent.py'), 'print("default")\n');
      fs.writeFileSync(
        path.join(bundleDir, 'config.json'),
        JSON.stringify({
          process: {
            cwd: '/app',
            env: ['HOME=/root', 'TMPDIR=/tmp', 'CUSTOM_VAR=ok'],
            args: ['python3', '/app/agent.py'],
          },
        })
      );

      const bytes = tournament.finalizeUnpackedOciRootfs(bundleDir);
      expect(bytes).toBeGreaterThan(0);
      expect(fs.statSync(path.join(rootfsDir, 'run')).isDirectory()).toBe(true);
      const launcher = fs.readFileSync(path.join(rootfsDir, '.arena-run'), 'utf8');
      expect(launcher).toContain('export \'CUSTOM_VAR=ok\'');
      expect(launcher).not.toContain('HOME=/root');
      expect(launcher).not.toContain('TMPDIR=/tmp');
      expect(launcher).toContain('exec \'python3\' \'/app/agent.py\' "$@"');
    });

    test('finalizeUnpackedOciRootfs rejects symlinked mountpoint or NVIDIA bind targets', () => {
      const bundleDir = path.join(tmpDir, 'oci-symlink-escape');
      const rootfsDir = path.join(bundleDir, 'rootfs');
      const outsideDir = path.join(tmpDir, 'oci-outside-host');
      fs.mkdirSync(rootfsDir, {recursive: true});
      fs.mkdirSync(outsideDir, {recursive: true});
      fs.writeFileSync(path.join(rootfsDir, 'run'), '#!/bin/sh\necho default\n', {mode: 0o755});
      fs.symlinkSync(outsideDir, path.join(rootfsDir, 'tmp'));

      expect(() => tournament.finalizeUnpackedOciRootfs(bundleDir)).toThrow(/unsafe symlink/i);
    });

    test('selectNextBatch schedules sticky-VM matchup waves', () => {
      const matchups = [
        {agentA: 1, agentB: 2, gamesPlayed: 10, gamesTarget: 20, inFlight: false},
        {agentA: 1, agentB: 3, gamesPlayed: 0, gamesTarget: 20, inFlight: false},
        {agentA: 2, agentB: 4, gamesPlayed: 0, gamesTarget: 20, inFlight: false},
      ];
      const totals = new Map<number, number>([[1, 10], [2, 10], [3, 0], [4, 0]]);
      const batch = tournament.selectNextBatch(matchups, totals, {vmAAgent: 1, vmBAgent: 2}, 10);
      expect(batch).toEqual({
        agentOnVmA: 1,
        agentOnVmB: 3,
        gamesToPlay: 10,
        startingGameIndex: 0,
      });
    });

    test('buildLockedTournamentTeamBook selects pairwise-distinct teams via teamDistance', () => {
      const teamOneVariant = TEAM_ONE.replace('thunderbolt', 'discharge');
      const book = tournament.buildLockedTournamentTeamBook(
        [TEAM_ONE, teamOneVariant, TEAM_TWO, OU_TEAM_ONE],
        1,
        'gen9ou',
        '7'
      );
      expect(book).toHaveLength(1);
      expect(book[0].p1Team).not.toBe(book[0].p2Team);
      // Either TEAM_ONE or teamOneVariant (1 move diff < THRESHOLD 1.30) is skipped on Pass 1
      expect([book[0].p1Team, book[0].p2Team]).not.toEqual([TEAM_ONE, teamOneVariant]);
      expect([book[0].p1Team, book[0].p2Team]).not.toEqual([teamOneVariant, TEAM_ONE]);
    });

    test('computeSeriesOutcome scores sweeps, splits, or ties for any Best-of-N series', () => {
      expect(tournament.computeSeriesOutcome(['W', 'W'])).toEqual({
        outcome: 'W',
        p1Score: 2,
        p2Score: 0,
      });
      expect(tournament.computeSeriesOutcome(['L', 'L'])).toEqual({
        outcome: 'L',
        p1Score: 0,
        p2Score: 2,
      });
      expect(tournament.computeSeriesOutcome(['W', 'L', 'W'])).toEqual({
        outcome: 'W',
        p1Score: 2,
        p2Score: 1,
      });
      expect(tournament.computeSeriesOutcome(['W', 'L', 'L'])).toEqual({
        outcome: 'L',
        p1Score: 1,
        p2Score: 2,
      });
      expect(tournament.computeSeriesOutcome(['W', 'T', 'T'])).toEqual({
        outcome: 'W',
        p1Score: 2,
        p2Score: 1,
      });
      expect(tournament.computeSeriesOutcome(['W', 'L', 'T'])).toEqual({
        outcome: 'T',
        p1Score: 1.5,
        p2Score: 1.5,
      });
      expect(tournament.computeSeriesOutcome(['T', 'T', 'T'])).toEqual({
        outcome: 'T',
        p1Score: 1.5,
        p2Score: 1.5,
      });
      expect(tournament.computeSeriesOutcome(['W', 'L', 'W', 'L', 'W'])).toEqual({
        outcome: 'W',
        p1Score: 3,
        p2Score: 2,
      });
    });

    test('ConcurrentGame plays Best-of-N games in the same agent subprocesses', async () => {
      const pidRecordFile = path.join(tmpDir, 'bo3-pids.txt');
      fs.writeFileSync(pidRecordFile, '');
      const bo3AgentScript = path.join(tmpDir, 'bo3-agent.js');
      fs.writeFileSync(
        bo3AgentScript,
        [
          '#!/usr/bin/env node',
          'const fs = require("fs");',
          'const readline = require("readline");',
          'const rl = readline.createInterface({input: process.stdin, crlfDelay: Infinity});',
          'let gameNum = 0;',
          'rl.on("line", line => {',
          '  if (line === "|start") {',
          '    gameNum++;',
          `    fs.appendFileSync(${JSON.stringify(pidRecordFile)}, `,
          '      String(process.pid) + ":" + String(gameNum) + "\\n");',
          '  }',
          '  if (!line.startsWith("|request|")) return;',
          '  const raw = line.slice(9).trim();',
          '  if (!raw || raw === "null") return;',
          '  const req = JSON.parse(raw);',
          '  if (req.wait) return;',
          '  process.stdout.write(req.teamPreview ? "/team 1234\\n" : "default\\n");',
          '});',
        ].join('\n'),
        {mode: 0o755}
      );

      const bo3Res = await new tournament.ConcurrentGame({
        format: 'gen9customgame',
        seed: '1,2,3,4',
        bestOf: 3,
        p1Spec: {
          agentId: 'foul-play',
          displayName: 'Foul Play',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          localCommand: relayBin,
          localArgs: [process.execPath, bo3AgentScript],
        },
        p2Spec: {
          agentId: 'pokechamp',
          displayName: 'PokeChamp',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          localCommand: relayBin,
          localArgs: [process.execPath, bo3AgentScript],
        },
        p1TeamPacked: TEAM_ONE,
        p2TeamPacked: TEAM_TWO,
        maxTurns: 1,
      }).run();

      expect(bo3Res.games.length).toBeGreaterThanOrEqual(2);
      expect(bo3Res.games[0].outcome).toBeDefined();
      expect(bo3Res.games[1].outcome).toBeDefined();
      expect(bo3Res.games[1].seed).toBeDefined();
      expect(bo3Res.games[0].omniscientLog).toContain('|player|p1|Foul Play|');
      expect(bo3Res.games[1].omniscientLog).toContain('|player|p1|Foul Play|');

      const pidEntries = fs.readFileSync(pidRecordFile, 'utf8').trim().split('\n');
      const uniquePids = new Set(pidEntries.map(e => e.split(':')[0]));
      // Only 2 processes (one for P1, one for P2) were spawned across all games in the Bo3 set
      expect(uniquePids.size).toBe(2);
      expect(pidEntries.length).toBeGreaterThanOrEqual(4);
    });

    test('ConcurrentGame emits simultaneous thinking clocks with mid-turn commit', async () => {
      const slowAgentScript = path.join(tmpDir, 'slow-tourney-agent.js');
      fs.writeFileSync(
        slowAgentScript,
        [
          '#!/usr/bin/env node',
          'const readline = require("readline");',
          'const rl = readline.createInterface({input: process.stdin, crlfDelay: Infinity});',
          'rl.on("line", line => {',
          '  if (!line.startsWith("|request|")) return;',
          '  const raw = line.slice(9).trim();',
          '  if (!raw || raw === "null") return;',
          '  const req = JSON.parse(raw);',
          '  if (req.wait) return;',
          '  setTimeout(() => {',
          '    process.stdout.write(req.teamPreview ? "/team 1234\\n" : "default\\n");',
          '  }, 90);',
          '});',
        ].join('\n'),
        {mode: 0o755}
      );

      const chunkSnaps: tournament.TurnBroadcastInfo[] = [];
      const clockChanges: tournament.TurnBroadcastInfo[] = [];

      await new tournament.ConcurrentGame({
        format: 'gen9customgame',
        seed: '1,2,3,4',
        p1Spec: {
          agentId: 'fast-agent',
          displayName: 'Fast Agent',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          localCommand: relayBin,
          localArgs: [process.execPath, defaultAgentScript],
        },
        p2Spec: {
          agentId: 'slow-agent',
          displayName: 'Slow Agent',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          localCommand: relayBin,
          localArgs: [process.execPath, slowAgentScript],
        },
        p1TeamPacked: TEAM_ONE,
        p2TeamPacked: TEAM_TWO,
        maxTurns: 2,
        onSpectatorChunk: (_chunk, state) => {
          chunkSnaps.push(structuredClone(state));
        },
        onClockChange: state => {
          clockChanges.push(structuredClone(state));
        },
      }).run();

      // At decision wave start, both sides are actively thinking simultaneously
      expect(chunkSnaps.some(s => s.p1.thinking && s.p2.thinking)).toBe(true);
      // When Fast Agent (p1) commits first, onClockChange reports p1 committed while p2 thinks
      expect(clockChanges.some(s => !s.p1.thinking && s.p2.thinking)).toBe(true);
    });
  });

  describe('Coordinator', () => {
    let utmLogFile: string;
    let bundleTar: string;
    let bundleSha: string;

    beforeAll(() => {
      utmLogFile = path.join(tmpDir, 'v30-utm.log');
      const bundleDir = path.join(tmpDir, 'coord-bundle');
      fs.mkdirSync(bundleDir, {recursive: true});
      fs.writeFileSync(
        path.join(bundleDir, 'run'),
        [
          '#!/usr/bin/env node',
          'const fs = require("fs");',
          'const readline = require("readline");',
          'const rl = readline.createInterface({input: process.stdin, crlfDelay: Infinity});',
          'rl.on("line", line => {',
          '  if (line.startsWith("|utm|")) {',
          `    fs.appendFileSync(${JSON.stringify(utmLogFile)}, line.slice(5) + "\\n");`,
          '    return;',
          '  }',
          '  if (!line.startsWith("|request|")) return;',
          '  const raw = line.slice(9).trim();',
          '  if (!raw || raw === "null") return;',
          '  const req = JSON.parse(raw);',
          '  if (req.wait) return;',
          '  process.stdout.write(req.teamPreview ? "/team 123456\\n" : "default\\n");',
          '});',
        ].join('\n'),
        {mode: 0o755}
      );
      bundleTar = path.join(tmpDir, 'coord-agent.tar.gz');
      execFileSync('tar', ['-czf', bundleTar, '-C', bundleDir, '.']);
      bundleSha = crypto.createHash('sha256').update(fs.readFileSync(bundleTar)).digest('hex');
    });

    function createMockCoordHarness(prefix: string) {
      const reportedStatuses: serverArena.SubmissionStatusPayload[] = [];
      const completedMatches: serverArena.MatchCompletePayload[] = [];
      const heartbeats: serverArena.HeartbeatPayload[] = [];

      const mockClient = {
        getPendingSubmissions: () => Promise.resolve({
          ladders: [],
          submissions: [
            {
              versionId: 30,
              agentId: 1,
              agentSlug: 'foul-play',
              agentName: 'Foul Play',
              version: '3.0.0',
              package: 'bundle' as const,
              url: `file://${bundleTar}`,
              sha256: bundleSha,
              ladders: ['gen9customgame'],
              tournaments: [],
              teamsByLadder: {},
            },
          ],
        }),
        reportSubmissionStatus: (payload: serverArena.SubmissionStatusPayload) => {
          reportedStatuses.push(payload);
          return Promise.resolve({
            ok: true as const,
            versionId: payload.versionId,
            smokeStatus: payload.smokeStatus,
            retiredByLadder: payload.retiredVersionIdsByLadder ?? {},
          });
        },
        completeMatch: (payload: serverArena.MatchCompletePayload) => {
          completedMatches.push(payload);
          return Promise.resolve({ok: true as const, duplicate: false, archivedLadder: false});
        },
        sendHeartbeat: (payload: serverArena.HeartbeatPayload) => {
          heartbeats.push(payload);
          return Promise.resolve({ok: true as const, updatedAt: 1000});
        },
        getLadderTeams: () => Promise.resolve({
          ladderId: 'gen9customgame',
          format: 'gen9customgame',
          count: 2,
          sha256: 'abc',
          teams: [TEAM_ONE, TEAM_TWO],
        }),
      } as unknown as serverArena.Client;

      const stateDb = new arenaDb.Database(':memory:');
      const agentsDir = path.join(tmpDir, `${prefix}-agents`);
      const archiveLogsDir = path.join(tmpDir, `${prefix}-logs`);
      const coord = new coordinator.Coordinator({
        client: mockClient,
        stateDb,
        baselineSpec: {mode: 'native', target: process.execPath, args: [defaultAgentScript]},
        agentsDir,
        stagingDir: path.join(tmpDir, `${prefix}-staging`),
        teamsDir: path.join(tmpDir, `${prefix}-teams`),
        casDir: path.join(tmpDir, `${prefix}-cas`),
        archiveLogsDir,
        devMode: true,
        maxTurns: 1,
      });

      const ladderSnap: coordinator.LadderSnapshot = {
        id: 'gen9customgame',
        slot: 'sv',
        format: 'gen9customgame',
        team: 'harvested',
        status: 'active',
        min: 2,
        entries: [
          {
            versionId: 30,
            agentId: 1,
            agentSlug: 'foul-play',
            agentName: 'Foul Play',
            version: '3.0.0',
            elo: 1500,
            se: 350,
            lcb: 814,
            matches: 0,
            role: 'challenger',
          },
          {
            versionId: 25,
            agentId: 2,
            agentSlug: 'pokechamp',
            agentName: 'PokeChamp',
            version: '1.0.0',
            elo: 1520,
            se: 35,
            lcb: 1450,
            matches: 25,
            settledAt: 100,
            role: 'champion',
          },
        ],
        pairAggregates: [],
      };

      return {
        coord,
        stateDb,
        agentsDir,
        archiveLogsDir,
        ladderSnap,
        reportedStatuses,
        completedMatches,
        heartbeats,
      };
    }

    test('parsePrngSeed throws on malformed or out-of-range PRNG seeds', () => {
      expect(coordinator.parsePrngSeed('1, 2, 3, 4')).toBe('1,2,3,4');
      expect(() => coordinator.parsePrngSeed('bad-seed')).toThrow(/Invalid PRNG seed/);
      expect(() => coordinator.parsePrngSeed('1,2,3')).toThrow(/Invalid PRNG seed/);
      expect(() => coordinator.parsePrngSeed('1,2,3,70000')).toThrow(/Invalid PRNG seed/);
    });

    test('ingests pending bundle submissions through Turn-1 smoke test', async () => {
      const h = createMockCoordHarness('smoke');
      try {
        const processed = await h.coord.processPendingSubmissions(
          new Map([['gen9customgame', h.ladderSnap]])
        );
        expect(processed).toBe(1);
        expect(h.heartbeats).toContainEqual({idle: true});
        expect(h.reportedStatuses).toHaveLength(1);
        expect(h.reportedStatuses[0].smokeStatus).toBe('passed');
        expect(
          fs.existsSync(path.join(`${h.agentsDir}-cold`, 'foul-play-3.0.0-v30.tar.zst'))
        ).toBe(true);
      } finally {
        h.stateDb.close();
      }
    });

    test('swaps seats plus teams across a 2-game mirror match', async () => {
      const h = createMockCoordHarness('mirror');
      try {
        await h.coord.processPendingSubmissions(new Map([['gen9customgame', h.ladderSnap]]));
        const v25Dir = path.join(h.agentsDir, 'pokechamp-1.0.0-v25');
        fs.mkdirSync(v25Dir, {recursive: true});
        fs.writeFileSync(path.join(v25Dir, 'run'), fs.readFileSync(defaultAgentScript), {
          mode: 0o755,
        });
        h.stateDb.upsertLocalAgent({
          versionId: 25,
          agentId: 2,
          slug: 'pokechamp',
          version: '1.0.0',
          mode: 'native',
          target: 'pokechamp-1.0.0-v25',
          residency: 'hot',
          unpackedBytes: 1024,
        });

        fs.writeFileSync(utmLogFile, '');
        const played = await h.coord.playNextScheduledMatch([h.ladderSnap]);
        expect(played?.ladderId).toBe('gen9customgame');
        expect(h.completedMatches).toHaveLength(1);
        expect(h.completedMatches[0].match.seed).toMatch(/^sodium,[0-9a-f]{64}$/);
        expect(h.heartbeats.length).toBeGreaterThan(0);

        const v30UtmLines = fs.readFileSync(utmLogFile, 'utf8').trim().split('\n');
        expect(v30UtmLines).toHaveLength(2);
        expect(v30UtmLines[0]).not.toBe(v30UtmLines[1]);
      } finally {
        h.stateDb.close();
      }
    });

    test('omits |utm| across a 2-game random ladder mirror match', async () => {
      const h = createMockCoordHarness('rand-mirror');
      try {
        await h.coord.processPendingSubmissions(new Map([['gen9customgame', h.ladderSnap]]));
        const v25Dir = path.join(h.agentsDir, 'pokechamp-1.0.0-v25');
        fs.mkdirSync(v25Dir, {recursive: true});
        fs.writeFileSync(path.join(v25Dir, 'run'), fs.readFileSync(defaultAgentScript), {
          mode: 0o755,
        });
        h.stateDb.upsertLocalAgent({
          versionId: 25,
          agentId: 2,
          slug: 'pokechamp',
          version: '1.0.0',
          mode: 'native',
          target: 'pokechamp-1.0.0-v25',
          residency: 'hot',
          unpackedBytes: 1024,
        });

        const randSnap: coordinator.LadderSnapshot = {
          ...h.ladderSnap,
          id: 'gen9randombattle20261109',
          slot: 'rand',
          format: 'gen9randombattle',
          team: 'random',
        };
        fs.writeFileSync(utmLogFile, '');
        const played = await h.coord.playNextScheduledMatch([randSnap]);
        expect(played?.ladderId).toBe('gen9randombattle20261109');
        expect(h.completedMatches).toHaveLength(1);
        expect(fs.readFileSync(utmLogFile, 'utf8')).toBe('');
      } finally {
        h.stateDb.close();
      }
    });

    test('aborts in-progress checkpoints while resuming g1-complete Game 2', async () => {
      const h = createMockCoordHarness('recover');
      try {
        await h.coord.processPendingSubmissions(new Map([['gen9customgame', h.ladderSnap]]));
        const v30Local = h.stateDb.getLocalAgent(30)!;

        h.stateDb.createMatchCheckpoint({
          id: 'gen9customgame-0000098',
          ladderId: 'gen9customgame',
          format: 'gen9customgame',
          teamMode: 'harvested',
          seed: '1,2,3,4',
          p1: {
            versionId: 30,
            agentId: 1,
            slug: 'foul-play',
            name: 'Foul Play',
            version: '3.0.0',
            mode: 'native',
            target: v30Local.target,
            teamPacked: TEAM_ONE,
          },
          p2: {
            versionId: 25,
            agentId: 2,
            slug: 'pokechamp',
            name: 'PokeChamp',
            version: '1.0.0',
            mode: 'native',
            target: v30Local.target,
            teamPacked: TEAM_TWO,
          },
          startedAt: 1000,
        });

        h.stateDb.createMatchCheckpoint({
          id: 'gen9customgame-0000099',
          ladderId: 'gen9customgame',
          format: 'gen9customgame',
          teamMode: 'harvested',
          seed: '1,2,3,4',
          p1: {
            versionId: 30,
            agentId: 1,
            slug: 'foul-play',
            name: 'Foul Play',
            version: '3.0.0',
            mode: 'native',
            target: v30Local.target,
            teamPacked: TEAM_ONE,
          },
          p2: {
            versionId: 25,
            agentId: 2,
            slug: 'pokechamp',
            name: 'PokeChamp',
            version: '1.0.0',
            mode: 'native',
            target: v30Local.target,
            teamPacked: TEAM_TWO,
          },
          startedAt: 1001,
        });
        h.stateDb.checkpointGame1Complete({
          id: 'gen9customgame-0000099',
          outcome: 'W',
          turns: 2,
          endReason: 'win',
          p1: {bankSeconds: 140, ram: 64, turnMillis: 15},
          p2: {bankSeconds: 138, ram: 64, turnMillis: 15},
        });

        const recovered = await h.coord.recoverIncompleteMatches();
        expect(recovered.aborted).toEqual(['gen9customgame-0000098']);
        expect(recovered.resumed).toEqual(['gen9customgame-0000099']);
        expect(h.completedMatches).toHaveLength(1);
        expect(h.heartbeats.length).toBeGreaterThan(0);
        expect(
          fs.existsSync(path.join(
            h.archiveLogsDir, 'gen9customgame', '1970-01-01', 'gen9customgame-0000099b.log'
          ))
        ).toBe(true);
        expect(h.stateDb.getMatchCheckpoint('gen9customgame-0000098')?.status).toBe('aborted');
        expect(h.stateDb.getMatchCheckpoint('gen9customgame-0000099')?.status).toBe('complete');
      } finally {
        h.stateDb.close();
      }
    });

    async function withRealArenaServer<T>(
      prefix: string,
      fn: (ctx: {
        db: Database;
        client: serverArena.Client;
        serverUrl: string;
        secret: string;
        publicDir: string;
      }) => Promise<T>
    ): Promise<T> {
      const db = new Database(':memory:');
      const app = polka();
      const secret = 'real-http-arena-secret-32-bytes-ok';
      const authInst = new auth.Auth({
        config: {sessionSecret: 'session-secret-32-bytes-minimum-ok', arenaSecret: secret},
        db,
      });
      const publicDir = path.join(tmpDir, `${prefix}-public`);
      fs.mkdirSync(publicDir, {recursive: true});
      const ctrl = serverArena.register(app, {db, auth: authInst, publicDir});
      const server = http.createServer((req, res) => app.handler(req as polka.Request, res));
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const serverUrl = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
      const client = new serverArena.Client({serverUrl, arenaSecret: secret});

      try {
        return await fn({db, client, serverUrl, secret, publicDir});
      } finally {
        ctrl.close();
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        db.close();
      }
    }

    test('records LW split category over HTTP while evicting 4xx outbox items', async () => {
      await withRealArenaServer('lw-split', async ({db, client, serverUrl, secret, publicDir}) => {
        const stateDb = new arenaDb.Database(':memory:');
        try {
          db.syncLaddersFromYaml([
            '- name: RAND',
            '  id: gen9randombattle202611',
            '  format: gen9randombattle',
            '  team: random',
            '  status: active',
            '  min: 2',
          ].join('\n'));
          db.syncProjectsFromYaml([
            '- name: 0 ERROR',
            '  active: 2026',
            '  arena: {qualified: true, owners: {scheibo: pre.10544}}',
            '- name: Foul Play',
            '  active: 2026',
            '  arena: {qualified: true, owners: {pmariglia: pmariglia.535629}}',
          ].join('\n'));
          const a1 = db.getAgentBySlug('0-error')!;
          const a2 = db.getAgentBySlug('foul-play')!;
          const sub1 = db.createSubmission({
            agentId: a1.id,
            version: '1.0.0',
            package: 'bundle',
            url: 'https://github.com/pkmn/a1.tar.zst',
            sha256: 'a'.repeat(64),
            ladderIds: ['gen9randombattle202611'],
          });
          const sub2 = db.createSubmission({
            agentId: a2.id,
            version: '1.0.0',
            package: 'bundle',
            url: 'https://github.com/pkmn/a2.tar.zst',
            sha256: 'b'.repeat(64),
            ladderIds: ['gen9randombattle202611'],
          });
          db.applySubmissionStatus({versionId: sub1.id, smokeStatus: 'passed'});
          db.applySubmissionStatus({versionId: sub2.id, smokeStatus: 'passed'});

          const loseAsP1Dir = path.join(tmpDir, 'lose-as-p1-agents', 'lose-p1');
          fs.mkdirSync(loseAsP1Dir, {recursive: true});
          fs.writeFileSync(
            path.join(loseAsP1Dir, 'run'),
            [
              '#!/usr/bin/env node',
              'const readline = require("readline");',
              'const rl = readline.createInterface({input: process.stdin, crlfDelay: Infinity});',
              'rl.on("line", line => {',
              '  if (line.startsWith("|player|p1|")) process.exit(1);',
              '  if (!line.startsWith("|request|")) return;',
              '  const raw = line.slice(9).trim();',
              '  if (!raw || raw === "null") return;',
              '  const req = JSON.parse(raw);',
              '  if (!req.wait) process.stdout.write("default\\n");',
              '});',
            ].join('\n'),
            {mode: 0o755}
          );

          for (const [vid, aid, slug] of [
            [sub1.id, a1.id, '0-error'],
            [sub2.id, a2.id, 'foul-play'],
          ] as const) {
            stateDb.upsertLocalAgent({
              versionId: vid,
              agentId: aid,
              slug,
              version: '1.0.0',
              mode: 'native',
              target: 'lose-p1',
              residency: 'hot',
              unpackedBytes: 1024,
            });
          }

          const coord = new coordinator.Coordinator({
            client,
            stateDb,
            baselineSpec: {mode: 'native', target: process.execPath, args: [defaultAgentScript]},
            agentsDir: path.join(tmpDir, 'lose-as-p1-agents'),
            stagingDir: path.join(tmpDir, 'lose-as-p1-staging'),
            archiveLogsDir: path.join(tmpDir, 'lose-as-p1-logs'),
            devMode: true,
          });

          stateDb.enqueueOutbox(
            'match-complete',
            {match: {id: 'bad'}} as unknown as serverArena.MatchCompletePayload
          );

          const snapRes = await fetch(`${serverUrl}/api/arena/ladders`, {
            headers: {Authorization: `Bearer ${secret}`},
          });
          const {ladders} = await snapRes.json() as {ladders: coordinator.LadderSnapshot[]};
          const played = await coord.playNextScheduledMatch(ladders);
          expect(played?.ladderId).toBe('gen9randombattle202611');
          expect(stateDb.listOutbox()).toHaveLength(0);

          const recorded = db.getRecentMatches(5);
          expect(recorded).toHaveLength(1);
          expect(recorded[0].games[0].outcome).toBe('L');
          expect(recorded[0].games[1].outcome).toBe('W');
          expect(recorded[0].category).toBe('LW');
          const randLogDir = path.join(publicDir, 'arena', 'ladders', 'gen9randombattle202611');
          const g1Published = fs.readFileSync(
            path.join(randLogDir, `${recorded[0].id}a.log`),
            'utf8'
          );
          const g2Published = fs.readFileSync(
            path.join(randLogDir, `${recorded[0].id}b.log`),
            'utf8'
          );
          expect(g1Published).toContain('|player|p1|');
          expect(g1Published).toContain('|split|p1\n');
          expect(g1Published).toContain('|split|p2\n');
          expect(g1Published).not.toContain('Agent A');
          expect(g1Published).not.toContain('Agent B');
          expect(g2Published).toContain('|player|p1|');
          expect(g2Published).not.toContain('Agent A');

          expect(await coord.publishRandomLadderArchive('gen9randombattle202611')).toBe(true);
          expect(
            fs.existsSync(path.join(randLogDir, 'gen9randombattle202611-logs.tar'))
          ).toBe(true);
        } finally {
          stateDb.close();
        }
      });
    });

    test('executes pools ladder VGC matches via runDaemon({once: true})', async () => {
      await withRealArenaServer('daemon-pools', async ({db, serverUrl, secret}) => {
        db.syncLaddersFromYaml([
          '- name: VGC',
          '  id: gen9championsvgc2026regmc',
          '  format: gen9championsvgc2026regmc',
          '  team: pools',
          '  status: active',
          '  min: 4',
          '  teams: 20',
        ].join('\n'));
        db.syncProjectsFromYaml([
          '- name: 0 ERROR',
          '  active: 2026',
          '  arena: {qualified: true, owners: {scheibo: pre.10544}}',
          '- name: Foul Play',
          '  active: 2026',
          '  arena: {qualified: true, owners: {pmariglia: pmariglia.535629}}',
          '- name: Metamon',
          '  active: 2026',
          '  arena: {qualified: true, owners: {jake: jake.10001}}',
          '- name: PokeChamp',
          '  active: 2026',
          '  arena: {qualified: true, owners: {seth: seth.10002}}',
        ].join('\n'));

        const daemonStatePath = path.join(tmpDir, 'daemon-pools.sqlite');
        const daemonAgentsDir = path.join(tmpDir, 'daemon-pools-agents');
        const defaultRunDir = path.join(daemonAgentsDir, 'default-vgc');
        fs.mkdirSync(defaultRunDir, {recursive: true});
        fs.copyFileSync(defaultAgentScript, path.join(defaultRunDir, 'run'));
        fs.chmodSync(path.join(defaultRunDir, 'run'), 0o755);

        const seedStateDb = new arenaDb.Database(daemonStatePath);
        const slugs = ['0-error', 'foul-play', 'metamon', 'pokechamp'];
        for (let idx = 0; idx < slugs.length; idx++) {
          const ag = db.getAgentBySlug(slugs[idx])!;
          const validated = validateCompetitorTeamsIncremental(
            mock.generateValidVgcTeams(20, idx),
            {format: 'gen9championsvgc2026regmc', pools: [], teams: 20}
          );
          const sub = db.createSubmission({
            agentId: ag.id,
            version: '2.0.0',
            package: 'bundle',
            url: `https://github.com/pkmn/${slugs[idx]}.tar.zst`,
            sha256: String(idx + 1).repeat(64),
            ladderIds: ['gen9championsvgc2026regmc'],
            teamsByLadder: {gen9championsvgc2026regmc: validated.allSaved},
          });
          db.applySubmissionStatus({versionId: sub.id, smokeStatus: 'passed', unpackedBytes: 1024});
          seedStateDb.upsertLocalAgent({
            versionId: sub.id,
            agentId: ag.id,
            slug: ag.slug,
            version: '2.0.0',
            mode: 'native',
            target: 'default-vgc',
            residency: 'hot',
            unpackedBytes: 1024,
          });
        }
        seedStateDb.close();

        const prevDev = process.env.ARENA_DEV;
        process.env.ARENA_DEV = '1';
        try {
          await arenaIndex.runDaemon({
            serverUrl,
            arenaSecret: secret,
            stateDbPath: daemonStatePath,
            agentsDir: daemonAgentsDir,
            stagingDir: path.join(tmpDir, 'daemon-pools-staging'),
            archiveLogsDir: path.join(tmpDir, 'daemon-pools-logs'),
            maxTurns: 1,
            once: true,
          });
        } finally {
          if (prevDev === undefined) delete process.env.ARENA_DEV;
          else process.env.ARENA_DEV = prevDev;
        }

        const vgcMatches = db.getRecentMatches(10);
        expect(vgcMatches).toHaveLength(1);
        expect(vgcMatches[0].id).toBe('gen9championsvgc2026regmc-0000001');
        expect(vgcMatches[0].p1.teamLabel).toMatch(/^(?:P[12]:)?[0-9a-f]{12}$/);
        expect(vgcMatches[0].p2.teamLabel).toMatch(/^(?:P[12]:)?[0-9a-f]{12}$/);
      });
    });

    test('publishes retired pools ladder tar archive via runDaemon({once: true})', async () => {
      await withRealArenaServer('pools-arch', async ({db, serverUrl, secret, publicDir}) => {
        db.syncLaddersFromYaml([
          '- name: VGC',
          '  id: gen9championsvgc2026regmc',
          '  format: gen9championsvgc2026regmc',
          '  team: pools',
          '  status: active',
          '  min: 4',
          '  teams: 20',
        ].join('\n'));
        db.syncProjectsFromYaml([
          '- name: 0 ERROR',
          '  active: 2026',
          '  arena: {qualified: true, owners: {scheibo: pre.10544}}',
          '- name: Foul Play',
          '  active: 2026',
          '  arena: {qualified: true, owners: {pmariglia: pmariglia.535629}}',
          '- name: Metamon',
          '  active: 2026',
          '  arena: {qualified: true, owners: {jake: jake.10001}}',
          '- name: PokeChamp',
          '  active: 2026',
          '  arena: {qualified: true, owners: {seth: seth.10002}}',
        ].join('\n'));

        const daemonStatePath = path.join(tmpDir, 'daemon-pools-arch.sqlite');
        const daemonAgentsDir = path.join(tmpDir, 'daemon-pools-arch-agents');
        const daemonLogsDir = path.join(tmpDir, 'daemon-pools-arch-logs');
        const defaultRunDir = path.join(daemonAgentsDir, 'default-vgc');
        fs.mkdirSync(defaultRunDir, {recursive: true});
        fs.copyFileSync(defaultAgentScript, path.join(defaultRunDir, 'run'));
        fs.chmodSync(path.join(defaultRunDir, 'run'), 0o755);

        const seedStateDb = new arenaDb.Database(daemonStatePath);
        const slugs = ['0-error', 'foul-play', 'metamon', 'pokechamp'];
        for (let idx = 0; idx < slugs.length; idx++) {
          const ag = db.getAgentBySlug(slugs[idx])!;
          const validated = validateCompetitorTeamsIncremental(
            mock.generateValidVgcTeams(20, idx),
            {format: 'gen9championsvgc2026regmc', pools: [], teams: 20}
          );
          const sub = db.createSubmission({
            agentId: ag.id,
            version: '1.0.0',
            package: 'bundle',
            url: `https://github.com/pkmn/${slugs[idx]}.tar.zst`,
            sha256: String(idx + 1).repeat(64),
            ladderIds: ['gen9championsvgc2026regmc'],
            teamsByLadder: {gen9championsvgc2026regmc: validated.allSaved},
          });
          db.applySubmissionStatus({versionId: sub.id, smokeStatus: 'passed', unpackedBytes: 1024});
          seedStateDb.upsertLocalAgent({
            versionId: sub.id,
            agentId: ag.id,
            slug: ag.slug,
            version: '1.0.0',
            mode: 'native',
            target: 'default-vgc',
            residency: 'hot',
            unpackedBytes: 1024,
          });
        }
        seedStateDb.close();

        const prevDev = process.env.ARENA_DEV;
        process.env.ARENA_DEV = '1';
        try {
          await arenaIndex.runDaemon({
            serverUrl,
            arenaSecret: secret,
            stateDbPath: daemonStatePath,
            agentsDir: daemonAgentsDir,
            stagingDir: path.join(tmpDir, 'daemon-pools-arch-staging'),
            archiveLogsDir: daemonLogsDir,
            maxTurns: 1,
            once: true,
          });

          const vgcPubDir = path.join(publicDir, 'arena', 'ladders', 'gen9championsvgc2026regmc');
          const vgcPrivDir = path.join(
            publicDir,
            'arena',
            'ladders',
            '.private',
            'gen9championsvgc2026regmc'
          );
          expect(fs.existsSync(vgcPubDir)).toBe(false);
          expect(
            fs.existsSync(path.join(vgcPrivDir, 'gen9championsvgc2026regmc-0000001a.log'))
          ).toBe(true);
          expect(
            fs.existsSync(path.join(vgcPrivDir, 'gen9championsvgc2026regmc-0000001b.log'))
          ).toBe(true);

          db.setLadderStatus(
            'gen9championsvgc2026regmc',
            'archived',
            Math.floor(Date.now() / 1000)
          );
          await arenaIndex.runDaemon({
            serverUrl,
            arenaSecret: secret,
            stateDbPath: daemonStatePath,
            agentsDir: daemonAgentsDir,
            stagingDir: path.join(tmpDir, 'daemon-pools-arch-staging'),
            archiveLogsDir: daemonLogsDir,
            maxTurns: 1,
            once: true,
          });

          expect(fs.existsSync(vgcPrivDir)).toBe(false);
          expect(
            fs.existsSync(path.join(vgcPubDir, 'gen9championsvgc2026regmc-logs.tar'))
          ).toBe(true);
          expect(
            fs.existsSync(path.join(vgcPubDir, 'gen9championsvgc2026regmc-0000001a.log'))
          ).toBe(true);
          expect(
            fs.existsSync(path.join(vgcPubDir, 'gen9championsvgc2026regmc-0000001b.log'))
          ).toBe(true);
        } finally {
          if (prevDev === undefined) delete process.env.ARENA_DEV;
          else process.env.ARENA_DEV = prevDev;
        }
      });
    });

    test('reuses locked active pools team roster when smoke testing a new version', async () => {
      await withRealArenaServer('locked-active-teams', async ({db, client}) => {
        const stateDb = new arenaDb.Database(':memory:');
        try {
          db.syncLaddersFromYaml([
            '- name: VGC',
            '  id: gen9championsvgc2026regmc',
            '  format: gen9championsvgc2026regmc',
            '  team: pools',
            '  status: active',
            '  min: 4',
            '  teams: 20',
          ].join('\n'));
          db.syncProjectsFromYaml([
            '- name: Foul Play',
            '  active: 2026',
            '  arena: {qualified: true, owners: {pmariglia: pmariglia.535629}}',
          ].join('\n'));
          const ag = db.getAgentBySlug('foul-play')!;
          const validated = validateCompetitorTeamsIncremental(
            mock.generateValidVgcTeams(20, 0),
            {format: 'gen9championsvgc2026regmc', pools: [], teams: 20}
          );
          const first = db.createSubmission({
            agentId: ag.id,
            version: '1.0.0',
            package: 'bundle',
            url: `file://${bundleTar}`,
            sha256: bundleSha,
            ladderIds: ['gen9championsvgc2026regmc'],
            teamsByLadder: {gen9championsvgc2026regmc: validated.allSaved},
            now: 1000,
          });
          db.applySubmissionStatus({
            versionId: first.id,
            smokeStatus: 'passed',
            unpackedBytes: 1024,
            now: 1001,
          });
          db.db.prepare(
            'UPDATE ladder_entries SET se = 35, matches = 25, settled_at = 1002 ' +
              'WHERE version_id = ?'
          ).run(first.id);

          // Subsequent version omits `teamsByLadder` to reuse the locked active 20-team roster
          const next = db.createSubmission({
            agentId: ag.id,
            version: '1.0.1',
            package: 'bundle',
            url: `file://${bundleTar}`,
            sha256: bundleSha,
            ladderIds: ['gen9championsvgc2026regmc'],
            now: 1000 + 15 * 86400,
          });
          const pending = await client.getPendingSubmissions({target: 'ladder'});
          expect(pending.submissions[0]?.teamsByLadder?.gen9championsvgc2026regmc).toHaveLength(20);

          const coord = new coordinator.Coordinator({
            client,
            stateDb,
            baselineSpec: {mode: 'native', target: process.execPath, args: [defaultAgentScript]},
            agentsDir: path.join(tmpDir, 'locked-active-agents'),
            stagingDir: path.join(tmpDir, 'locked-active-staging'),
            devMode: true,
          });
          await coord.processPendingSubmissions();
          expect(db.getVersionById(next.id)?.smokeStatus).toBe('passed');
        } finally {
          stateDb.close();
        }
      });
    });

    test('retains 401 outbox items while skipping unregistered local agents', async () => {
      const stateDb = new arenaDb.Database(':memory:');
      try {
        const fakeClient = {
          completeMatch: () =>
            Promise.reject(
              Object.assign(new Error('Unauthorized (401): tunnel flap'), {status: 401})
            ),
        } as unknown as serverArena.Client;
        const coord = new coordinator.Coordinator({
          client: fakeClient,
          stateDb,
          baselineSpec: {mode: 'native', target: '_baseline'},
          devMode: true,
        });
        stateDb.enqueueOutbox(
          'match-complete',
          {match: {id: 'm1'}} as unknown as serverArena.MatchCompletePayload
        );
        const flushed = await coord.flushOutbox();
        expect(flushed).toBe(0);
        const queued = stateDb.listOutbox();
        expect(queued).toHaveLength(1);
        expect(queued[0].attempts).toBe(1);
        expect(queued[0].lastError).toContain('401');

        // Unregistered local agents are skipped rather than throwing in playNextScheduledMatch
        const scheduled = await coord.playNextScheduledMatch([{
          id: 'gen9ou',
          slot: 'ou',
          format: 'gen9ou',
          team: 'harvested',
          status: 'active',
          min: 2,
          entries: [
            {
              versionId: 901,
              agentId: 1,
              agentSlug: 'missing-a',
              agentName: 'Missing A',
              version: '1.0.0',
              elo: 1500,
              se: 350,
              lcb: 814,
              matches: 0,
              role: 'challenger',
            },
            {
              versionId: 902,
              agentId: 2,
              agentSlug: 'missing-b',
              agentName: 'Missing B',
              version: '1.0.0',
              elo: 1500,
              se: 350,
              lcb: 814,
              matches: 0,
              role: 'challenger',
            },
          ],
          pairAggregates: [],
        }]);
        expect(scheduled).toBeUndefined();
      } finally {
        stateDb.close();
      }
    });

    test('resolves upcoming ladder formats while leaving tournament OCI queued', async () => {
      await withRealArenaServer('upcoming-fmt', async ({db, client}) => {
        const stateDb = new arenaDb.Database(':memory:');
        try {
          db.syncLaddersFromYaml([
            '- name: RBY',
            '  id: gen1ou20261109',
            '  format: gen1ou',
            '  team: harvested',
            '  status: upcoming',
            '  min: 2',
          ].join('\n'));
          db.replaceLadderTeams('gen1ou20261109', [
            'Tauros|||NoAbility|BodySlam,HyperBeam,Blizzard,Earthquake|||||||',
            'Snorlax|||NoAbility|BodySlam,Reflect,Rest,Amnesia|||||||',
          ]);
          db.syncProjectsFromYaml([
            '- name: Mew\'s Truck',
            '  active: 2026',
            '  arena: {qualified: true, owners: {truckdev: truckdev.10003}}',
          ].join('\n'));
          const mewAgent = db.getAgentBySlug('mews-truck')!;
          db.upsertTournament({
            id: '9',
            name: 'Tournament #9',
            format: 'gen9ou',
            gamesPerMatchup: 8,
            parallelTables: 2,
            hardware: 'GCP L4',
            status: 'scheduled',
            startsAt: Math.floor(Date.now() / 1000) + 86400 * 7,
          });

          const gen1OnlyDir = path.join(tmpDir, 'gen1-strict-bundle');
          fs.mkdirSync(gen1OnlyDir, {recursive: true});
          fs.writeFileSync(
            path.join(gen1OnlyDir, 'run'),
            [
              '#!/usr/bin/env node',
              'const readline = require("readline");',
              'const rl = readline.createInterface({input: process.stdin, crlfDelay: Infinity});',
              'let sawGen1Tier = false;',
              'rl.on("line", line => {',
              '  if (line === "|tier|[Gen 1] OU") sawGen1Tier = true;',
              '  if (line.startsWith("|tier|") && line !== "|tier|[Gen 1] OU") process.exit(2);',
              '  if (!line.startsWith("|request|")) return;',
              '  const raw = line.slice(9).trim();',
              '  if (!raw || raw === "null") return;',
              '  const req = JSON.parse(raw);',
              '  if (req.wait) return;',
              '  if (!sawGen1Tier) process.exit(3);',
              '  process.stdout.write("default\\n");',
              '});',
            ].join('\n'),
            {mode: 0o755}
          );
          const gen1Tar = path.join(tmpDir, 'gen1-strict.tar.gz');
          execFileSync('tar', ['-czf', gen1Tar, '-C', gen1OnlyDir, '.']);
          const gen1Sha = crypto.createHash('sha256')
            .update(fs.readFileSync(gen1Tar))
            .digest('hex');

          const upcomingSub = db.createSubmission({
            agentId: mewAgent.id,
            version: '3.0.0',
            package: 'bundle',
            url: `file://${gen1Tar}`,
            sha256: gen1Sha,
            ladderIds: ['gen1ou20261109'],
          });
          const tourneySub = db.createSubmission({
            agentId: mewAgent.id,
            version: '3.0.0-t9',
            package: 'oci',
            url: 'ghcr.io/pkmn/mews-truck:3.0.0-t9',
            sha256: 'c'.repeat(64),
            ladderIds: [],
            tournamentIds: ['9'],
          });

          const ladderPending = await client.getPendingSubmissions({target: 'ladder'});
          expect(ladderPending.submissions.map(s => s.versionId)).toEqual([upcomingSub.id]);
          const tourneyPending = await client.getPendingSubmissions({
            target: 'tournament',
            tournamentId: '9',
          });
          expect(tourneyPending.submissions.map(s => s.versionId)).toEqual([tourneySub.id]);

          const coord = new coordinator.Coordinator({
            client,
            stateDb,
            baselineSpec: {mode: 'native', target: process.execPath, args: [defaultAgentScript]},
            agentsDir: path.join(tmpDir, 'upcoming-agents'),
            stagingDir: path.join(tmpDir, 'upcoming-staging'),
            teamsDir: path.join(tmpDir, 'upcoming-teams'),
            archiveLogsDir: path.join(tmpDir, 'upcoming-logs'),
            devMode: true,
          });
          expect(await coord.processPendingSubmissions()).toBe(1);
          expect(db.getVersionById(upcomingSub.id)?.smokeStatus).toBe('passed');
          expect(db.getVersionById(tourneySub.id)?.smokeStatus).toBe('pending');
        } finally {
          stateDb.close();
        }
      });
    });

    test('TournamentCoordinator validates OCI entrants then runs RR plus Superfinal', async () => {
      await withRealArenaServer('tour-coord', async ({db, client, publicDir}) => {
        db.syncProjectsFromYaml([
          '- name: 0 ERROR',
          '  active: 2026',
          '  arena: {qualified: true, owners: {scheibo: pre.10544}}',
          '- name: Foul Play',
          '  active: 2026',
          '  arena: {qualified: true, owners: {pmariglia: pmariglia.535629}}',
          '- name: Mew\'s Truck',
          '  active: 2026',
          '  arena: {qualified: true, owners: {truckdev: truckdev.10003}}',
        ].join('\n'));
        db.upsertTournament({
          id: '9',
          name: 'Tournament #9',
          format: 'gen9ou',
          gamesPerMatchup: 2,
          batchSize: 2,
          parallelTables: 2,
          hardware: 'GCP L4',
          status: 'scheduled',
          startsAt: Math.floor(Date.now() / 1000) + 86400 * 7,
        });

        for (const [idx, slug] of ['0-error', 'foul-play', 'mews-truck'].entries()) {
          const ag = db.getAgentBySlug(slug)!;
          db.createSubmission({
            agentId: ag.id,
            version: '3.0.0-t9',
            package: 'oci',
            url: `ghcr.io/pkmn/${slug}:3.0.0-t9`,
            sha256: String(idx + 3).repeat(64),
            ladderIds: [],
            tournamentIds: ['9'],
          });
        }

        const tourCoord = new tournament.Coordinator({
          client,
          baselineSpec: {
            agentId: '_baseline',
            displayName: 'Baseline',
            vmHost: '127.0.0.1',
            controlSocket: '',
            localCommand: relayBin,
            localArgs: [root('arena', 'bin', 'baseline')],
          },
          agentsDir: path.join(tmpDir, 'gcp-tourney-agents'),
          superfinalGames: 2,
          maxTurns: 1,
          prepareSubmissionRootfs: () => 2048,
          resolveEntrantSpec: entrant => ({
            agentId: `${entrant.agentSlug}-${entrant.versionId}`,
            displayName: entrant.agentName,
            vmHost: '127.0.0.1',
            controlSocket: '',
            localCommand: relayBin,
            localArgs: [process.execPath, tourneyUtmAgentScript],
          }),
        });

        expect(await tourCoord.processPendingSubmissions('9')).toBe(3);
        expect(db.getTournamentEntrants('9')).toHaveLength(3);

        db.seedTournamentEntrants('9');
        const tourRun = await tourCoord.runTournament('9');
        expect(tourRun.roundRobinGames).toBe(6);
        expect(tourRun.superfinalGames).toBe(2);
        expect(db.getTournament('9')?.status).toBe('completed');
        expect(db.getTournamentEntrants('9').map(e => e.finalRank)).toEqual([1, 2, 3]);
        const tourLogDir = path.join(publicDir, 'arena', 'tournaments', '9');
        expect(fs.readdirSync(tourLogDir).filter(f => f.endsWith('.log'))).toHaveLength(8);

        // Verify a harvested tournament locks the identical CRN team pair across all RR pairings
        db.syncLaddersFromYaml([
          '- name: SV',
          '  id: gen9customgame',
          '  format: gen9customgame',
          '  team: harvested',
          '  status: active',
          '  min: 2',
        ].join('\n'));
        db.replaceLadderTeams('gen9customgame', [TEAM_ONE, TEAM_TWO]);
        db.upsertTournament({
          id: '10',
          name: 'Tournament #10',
          format: 'gen9customgame',
          team: 'harvested',
          gamesPerMatchup: 2,
          batchSize: 2,
          parallelTables: 2,
          hardware: 'GCP L4',
          status: 'scheduled',
          startsAt: Math.floor(Date.now() / 1000) + 86400 * 7,
        });
        for (const [idx, slug] of ['0-error', 'foul-play', 'mews-truck'].entries()) {
          const ag = db.getAgentBySlug(slug)!;
          db.createSubmission({
            agentId: ag.id,
            version: '3.0.0-t10',
            package: 'oci',
            url: `ghcr.io/pkmn/${slug}:3.0.0-t10`,
            sha256: String(idx + 6).repeat(64),
            ladderIds: [],
            tournamentIds: ['10'],
          });
        }
        expect(await tourCoord.processPendingSubmissions('10')).toBe(3);
        db.seedTournamentEntrants('10');
        await tourCoord.runTournament('10');
        const t10Games = db.getTournamentGames('10').filter(g => g.stage === 'Round Robin');
        expect(t10Games).toHaveLength(6);
        const oddSeeds = new Set(
          t10Games.filter(g => g.matchupGame === 1).map(g => g.games[0].seed)
        );
        const evenSeeds = new Set(
          t10Games.filter(g => g.matchupGame === 2).map(g => g.games[0].seed)
        );
        expect(oddSeeds.size).toBe(1);
        expect(evenSeeds).toEqual(oddSeeds);
        expect(() => db.seedTournamentEntrants('10')).toThrow(/status 'completed'/);

        // Verify `superfinalGames === 0` still finalizes tournament status to 'completed'
        db.upsertTournament({
          id: '11',
          name: 'Tournament #11',
          format: 'gen9customgame',
          team: 'harvested',
          gamesPerMatchup: 2,
          batchSize: 2,
          parallelTables: 1,
          hardware: 'GCP L4',
          status: 'scheduled',
          startsAt: Math.floor(Date.now() / 1000) + 86400 * 7,
        });
        for (const [idx, slug] of ['0-error', 'foul-play'].entries()) {
          const ag = db.getAgentBySlug(slug)!;
          const v = db.createSubmission({
            agentId: ag.id,
            version: '3.0.0-t11',
            package: 'oci',
            url: `ghcr.io/pkmn/${slug}:3.0.0-t11`,
            sha256: String(idx + 8).repeat(64),
            ladderIds: [],
            tournamentIds: ['11'],
          });
          db.applySubmissionStatus({versionId: v.id, smokeStatus: 'passed', unpackedBytes: 2048});
        }
        const noSfCoord = new tournament.Coordinator({
          client,
          baselineSpec: {
            agentId: '_baseline',
            displayName: 'Baseline',
            vmHost: '127.0.0.1',
            controlSocket: '',
            localCommand: relayBin,
            localArgs: [root('arena', 'bin', 'baseline')],
          },
          superfinalGames: 0,
          maxTurns: 1,
          resolveEntrantSpec: entrant => ({
            agentId: `${entrant.agentSlug}-${entrant.versionId}`,
            displayName: entrant.agentName,
            vmHost: '127.0.0.1',
            controlSocket: '',
            localCommand: relayBin,
            localArgs: [process.execPath, tourneyUtmAgentScript],
          }),
        });
        const noSfRes = await noSfCoord.runTournament('11');
        expect(noSfRes).toEqual({roundRobinGames: 2, superfinalGames: 0});
        expect(db.getTournament('11')?.status).toBe('completed');
      });
    });

    test('requestDrain halts new coordinator scheduling while still flushing outbox', async () => {
      const stateDb = new arenaDb.Database(':memory:');
      try {
        let submittedCount = 0;
        const fakeClient = {
          getPendingSubmissions: () => Promise.resolve({ladders: [], submissions: []}),
          reportSubmissionStatus: () => {
            submittedCount++;
            return Promise.resolve();
          },
          completeMatch: () => Promise.resolve({archivedLadder: false}),
          sendHeartbeat: () => Promise.resolve(undefined),
        } as unknown as serverArena.Client;

        stateDb.enqueueOutbox('submission-status', {versionId: 1, smokeStatus: 'passed'});
        const coord = new coordinator.Coordinator({
          client: fakeClient,
          stateDb,
          baselineSpec: {mode: 'native', target: '_baseline'},
          devMode: true,
        });

        expect(coord.isDraining()).toBe(false);
        coord.requestDrain();
        expect(coord.isDraining()).toBe(true);

        const processed = await coord.processPendingSubmissions();
        expect(processed).toBe(0);

        const scheduled = await coord.playNextScheduledMatch([]);
        expect(scheduled).toBeUndefined();
        expect(submittedCount).toBe(1);
        expect(stateDb.listOutbox()).toHaveLength(0);
      } finally {
        stateDb.close();
      }
    });

    test('runDaemon wakes immediately from idle poll sleep on SIGUSR1 drain signal', async () => {
      await withRealArenaServer('drain-sleep', async ({serverUrl, secret}) => {
        const start = Date.now();
        const daemonPromise = arenaIndex.runDaemon({
          serverUrl,
          arenaSecret: secret,
          stateDbPath: ':memory:',
          pollIntervalMillis: 60_000,
        });
        setTimeout(() => {
          process.emit('SIGUSR1');
        }, 50);
        await daemonPromise;
        expect(Date.now() - start).toBeLessThan(2000);
      });
    });
  });

  describe('Darwin sandbox enforcement', () => {
    test('limit binary records child XNU physical memory footprint', () => {
      if (process.platform !== 'darwin') return;
      const peakFile = path.join(tmpDir, 'darwin-limit-peak.txt');
      const out = execFileSync(
        limitBin,
        [
          process.execPath,
          '-e',
          'const b = Buffer.alloc(36 * 1024 * 1024, 7); ' +
            'setTimeout(() => console.log([b[0], process.env.PKMN_STATS_DIR].join(":")), 80);',
        ],
        {encoding: 'utf8', env: {...process.env, ARENA_PEAK_RAM_FILE: peakFile}}
      ).trim();
      expect(out).toBe('7:/opt/arena/stats');
      expect(Number(fs.readFileSync(peakFile, 'utf8').trim())).toBeGreaterThanOrEqual(36);
    });

    test('validates LaunchDaemon plists plus PF anchor ruleset syntax', () => {
      if (process.platform !== 'darwin') return;
      expect(() => {
        execFileSync('plutil', [
          '-lint',
          root('arena/config/ai.pkmn.arena.plist'),
          root('arena/config/ai.pkmn.archive.plist'),
          root('arena/config/ai.pkmn.pf.plist'),
          root('arena/config/ai.pkmn.podman.plist'),
          root('arena/config/ai.pkmn.tunnel.plist'),
        ]);
        execFileSync('/sbin/pfctl', ['-nf', root('arena/config/pf.anchor')]);
      }).not.toThrow();
    });

    test('sandbox.sb permits bundle reads, scratch writes, or /dev/fd substitution', () => {
      if (process.platform !== 'darwin') return;
      const realTmp = fs.realpathSync(tmpDir);
      const sbRo = path.join(realTmp, 'sb-allow-ro');
      const sbScratch = path.join(realTmp, 'sb-allow-scratch');
      fs.mkdirSync(sbRo, {recursive: true});
      fs.mkdirSync(sbScratch, {recursive: true});
      const probe = path.join(sbRo, 'probe');
      fs.copyFileSync(sandboxProbeBin, probe);
      fs.chmodSync(probe, 0o755);
      fs.writeFileSync(path.join(sbRo, 'weights.txt'), 'ok-weights');

      const sandboxEnv = {
        HOME: sbScratch,
        TMPDIR: sbScratch,
        PATH: '/opt/homebrew/bin:/usr/bin:/bin',
        LANG: 'C.UTF-8',
        PYTHONHASHSEED: '0',
      };
      const out = execFileSync(
        '/usr/bin/sandbox-exec',
        [
          '-f', root('arena/config/sandbox.sb'),
          '-D', `AGENT_RO_DIR=${sbRo}`,
          '-D', `AGENT_SCRATCH_DIR=${sbScratch}`,
          probe,
          'allow',
          path.join(sbRo, 'weights.txt'),
          path.join(sbScratch, 'out.txt'),
        ],
        {cwd: sbScratch, env: sandboxEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}
      ).trim();
      expect(out).toBe('ok-weights-scratch-fd');
    });

    test('sandbox.sb blocks sibling agent reads, network sockets, kern.proc, or uchg', () => {
      if (process.platform !== 'darwin') return;
      const realTmp = fs.realpathSync(tmpDir);
      const sbRo = path.join(realTmp, 'sb-deny-ro');
      const sbSibling = path.join(realTmp, 'sb-deny-sibling');
      const sbScratch = path.join(realTmp, 'sb-deny-scratch');
      fs.mkdirSync(sbRo, {recursive: true});
      fs.mkdirSync(sbSibling, {recursive: true});
      fs.mkdirSync(sbScratch, {recursive: true});
      const probe = path.join(sbRo, 'probe');
      fs.copyFileSync(sandboxProbeBin, probe);
      fs.chmodSync(probe, 0o755);
      fs.writeFileSync(path.join(sbSibling, 'secret.txt'), 'rival-secret');
      fs.writeFileSync(path.join(sbScratch, 'out.txt'), 'scratch-file');

      const sandboxEnv = {
        HOME: sbScratch,
        TMPDIR: sbScratch,
        PATH: '/opt/homebrew/bin:/usr/bin:/bin',
        LANG: 'C.UTF-8',
        PYTHONHASHSEED: '0',
      };
      const runSandboxed = (...args: string[]) =>
        execFileSync(
          '/usr/bin/sandbox-exec',
          [
            '-f', root('arena/config/sandbox.sb'),
            '-D', `AGENT_RO_DIR=${sbRo}`,
            '-D', `AGENT_SCRATCH_DIR=${sbScratch}`,
            probe,
            ...args,
          ],
          {cwd: sbScratch, env: sandboxEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}
        );

      expect(() => runSandboxed('read', path.join(sbSibling, 'secret.txt'))).toThrow();
      expect(() => runSandboxed('socket')).toThrow();
      expect(() => runSandboxed('kernproc')).toThrow();
      expect(() => runSandboxed('kernprocuid')).toThrow();
      expect(() => runSandboxed('notifyd')).toThrow();
      expect(() => runSandboxed('xattr', sbScratch)).toThrow();

      expect(() => execFileSync(
        '/usr/bin/sandbox-exec',
        [
          '-f', root('arena/config/sandbox.sb'),
          '-D', `AGENT_RO_DIR=${sbRo}`,
          '-D', `AGENT_SCRATCH_DIR=${sbScratch}`,
          '/usr/bin/chflags',
          'uchg',
          path.join(sbScratch, 'out.txt'),
        ],
        {cwd: sbScratch, env: sandboxEnv, stdio: 'pipe'}
      )).toThrow();
    });

    test('limit binary fails closed when slot privilege drop is unavailable', () => {
      if (process.platform !== 'darwin') return;
      let status: number | undefined;
      try {
        execFileSync(limitBin, ['p1', '/usr/bin/true'], {stdio: 'pipe'});
      } catch (err) {
        status = (err as {status?: number}).status;
      }
      expect(status).toBe(126);
    });

    test('limit binary sums physical memory footprint across forked child workers', () => {
      if (process.platform !== 'darwin') return;
      const peakFile = path.join(tmpDir, 'darwin-limit-fork-peak.txt');
      execFileSync(
        limitBin,
        [
          process.execPath,
          '-e',
          'const {spawn} = require("child_process");' +
            'const c = spawn(process.execPath, ["-e", ' +
            '"const b = Buffer.alloc(48 * 1024 * 1024, 9); setTimeout(() => b[0], 120);"]);' +
            'c.on("exit", () => process.exit(0));',
        ],
        {encoding: 'utf8', env: {...process.env, ARENA_PEAK_RAM_FILE: peakFile}}
      );
      expect(Number(fs.readFileSync(peakFile, 'utf8').trim())).toBeGreaterThanOrEqual(48);
    });
  });
});
