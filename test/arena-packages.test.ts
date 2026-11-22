import {execFileSync} from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';

import * as arenaIndex from '../arena';
import * as arbiter from '../arena/arbiter';
import * as arenaDb from '../arena/db';
import * as packages from '../arena/packages';
import * as unpack from '../arena/unpack';
import * as sim from '../server/sim';
import {root} from '../static/util';

import {
  TEAM_ONE,
  TEAM_TWO,
  buildTestTarGz,
  createValidBundleArchive,
  getArenaTestBins,
} from './arena-helpers';
import {compareDatabaseSchemas} from './schema-helpers';

describe('arena packages & static assets', () => {
  let tmpDir: string;
  let defaultAgentScript: string;
  let validArchivePath: string;
  let validArchiveSha: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-arena-pkg-'));
    ({defaultAgentScript} = getArenaTestBins({relay: false}));
    ({archivePath: validArchivePath, sha256: validArchiveSha} = createValidBundleArchive(
      tmpDir,
      defaultAgentScript
    ));
  }, 30_000);

  afterAll(async () => {
    await sim.closeAllWorkers();
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
      expect(baselineOut).toEqual(['/ready', '/team 1234', '/team 123456', 'default']);
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
      expect(limitC).toContain('renameat(');
      expect(limitC).toContain('PRIO_DARWIN_PROCESS');
      expect(sandbox).toContain('(subpath "/opt/arena/stats")');
      expect(limitC).toContain('setenv("PKMN_STATS_DIR", "/opt/arena/stats", 1)');
      expect(arenaScript).toContain('--env PKMN_STATS_DIR=/opt/arena/stats');
      expect(fs.readFileSync(root('arena', 'bin', 'tourney-agent'), 'utf8'))
        .toContain('--setenv PKMN_STATS_DIR /opt/arena/stats');
      expect(fs.readFileSync(root('arena', 'scripts', 'bake-image.sh'), 'utf8'))
        .toContain('/opt/arena/stats');
      expect(fs.readFileSync(root('arena', 'config', 'ai.pkmn.arena.plist'), 'utf8'))
        .toContain('<key>ExitTimeOut</key>\n  <integer>900</integer>');
      expect(fs.readFileSync(root('arena', 'scripts', 'deploy.sh'), 'utf8'))
        .toContain('launchctl kill SIGUSR1 system/ai.pkmn.arena');
      const deployScript = fs.readFileSync(root('arena', 'scripts', 'deploy.sh'), 'utf8');
      expect(deployScript).toContain('/opt/arena/agents/_baseline/run');
      expect(deployScript).toContain('arena/bin/limit.c');
      expect(deployScript).toContain('arena/scripts/setup-arena.sh');
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

    test('reads rootless Podman user.slice cgroup v2 memory.peak in arena script', () => {
      const arenaScript = fs.readFileSync(root('arena', 'bin', 'arena'), 'utf8');
      expect(arenaScript).toContain(
        '/sys/fs/cgroup/user.slice/user-*.slice/user@*.service/user.slice/libpod-'
      );
      expect(arenaScript).toContain('.scope/memory.peak');
    });

    test('excludes launchd PPID 1 Apple XPC helpers in native_agent_procs', () => {
      const arenaScript = fs.readFileSync(root('arena', 'bin', 'arena'), 'utf8');
      const match = /awk '([\s\S]*?)' \| sort/.exec(arenaScript);
      expect(match).toBeTruthy();
      const mtlHelper =
        '/System/Library/Frameworks/Metal.framework/Versions/A/XPCServices/' +
        'MTLCompilerService.xpc/Contents/MacOS/MTLCompilerService';
      const samplePs = [
        '87719 87718 T    /opt/arena/agents/minikazam/python/bin/python3.12',
        '87720 87719 S    /opt/arena/agents/my bot/worker',
        `87770     1 Ts   ${mtlHelper}`,
        '87771     1 T    /usr/sbin/cfprefsd',
        '87802     1 S    /usr/sbin/distnoted',
        '87803 87719 S    /usr/sbin/distnoted',
      ].join('\n');
      const filtered = execFileSync('awk', [match![1]], {
        input: `${samplePs}\n`,
        encoding: 'utf8',
      }).trim().split('\n').sort();
      expect(filtered).toEqual(['87719:T', '87720:S', '87803:S']);
    });

    test('forfeits slot as crash if pauseSlot fails during pre-battle /ready phase', async () => {
      const game = new arbiter.TimeSlicedArenaGame({
        format: 'gen1ou',
        seed: '1,2,3,4',
        p1: {
          spec: {mode: 'native', target: defaultAgentScript},
          teamPacked: TEAM_ONE,
        },
        p2: {
          spec: {mode: 'native', target: defaultAgentScript},
          teamPacked: TEAM_TWO,
        },
        devMode: true,
      });
      const internal = game as unknown as {
        pauseSlot: (player: {slot: 'p1' | 'p2'}) => void;
        forceLose: (slot: 'p1' | 'p2', reason: string) => void;
      };
      const origPause = internal.pauseSlot.bind(game);
      let p2Pauses = 0;
      internal.pauseSlot = player => {
        if (player.slot === 'p2' && ++p2Pauses === 2) {
          internal.forceLose('p2', 'crash');
          return;
        }
        origPause(player);
      };
      const res = await game.run();
      expect(res.endReason).toBe('crash');
      expect(res.winner).toBe('p1');
      expect(res.turns).toBe(0);
    });
  });

  describe('arena/unpack', () => {
    test('extracts valid native bundles with APFS CoW CAS deduplication', async () => {
      const dirs = packages.dirsForRoot(path.join(tmpDir, 'dedup'));

      const bytes1 = await packages.downloadAndUnpackBundle({
        url: `file://${validArchivePath}`,
        expectedSha256: validArchiveSha,
        agentTargetId: 'agent-v1',
        dirs,
        allowPrivateUrls: true,
      });
      expect(bytes1).toBeGreaterThan(70_000);
      expect(fs.existsSync(path.join(dirs.agents, 'agent-v1', 'run'))).toBe(true);

      const bytes2 = unpack.bundle(
        validArchivePath,
        path.join(dirs.agents, 'agent-v2'),
        dirs.cas
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

      expect(() => unpack.bundle(noRunTar, path.join(tmpDir, 'agent-no-run'), noRunCasDir))
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
      expect(() => unpack.bundle(
        slipTar,
        path.join(slipAgentsDir, 'agent-slip'),
        path.join(tmpDir, 'cas-slip')
      )).toThrow(/traverses symlink|escapes|illegal link target/i);
      expect(fs.existsSync(path.join(slipAgentsDir, 'pwned.txt'))).toBe(false);
    });

    test('rejects hardlink size-amplification archives above 500 MiB', () => {
      const hlBombTar = path.join(tmpDir, 'hardlink-bomb.tar.gz');
      const entries: Parameters<typeof buildTestTarGz>[0] = [
        {name: 'base.bin', type: '0', data: Buffer.alloc(4 * 1024 * 1024, 0)},
      ];
      for (let i = 0; i < 130; i++) {
        entries.push({name: `dup-${i}.bin`, type: '1', linkname: 'base.bin'});
      }
      fs.writeFileSync(hlBombTar, buildTestTarGz(entries));
      const hlDest = path.join(tmpDir, 'agent-hl-bomb');
      expect(() => unpack.bundle(hlBombTar, hlDest, path.join(tmpDir, 'cas-hl')))
        .toThrow(/exceeds 500 MiB cap/i);
      expect(fs.existsSync(hlDest)).toBe(false);
    });

    test('cleans up partial destination directories on corrupt archives', () => {
      const corruptTar = path.join(tmpDir, 'corrupt.tar.gz');
      fs.writeFileSync(corruptTar, fs.readFileSync(validArchivePath).subarray(0, 48));
      const corruptDest = path.join(tmpDir, 'agent-corrupt');
      expect(() => unpack.bundle(corruptTar, corruptDest, path.join(tmpDir, 'cas-corrupt')))
        .toThrow(/UNPACK_ERROR/i);
      expect(fs.existsSync(corruptDest)).toBe(false);
    });

    test('ad-hoc codesigns 0644 Mach-O .so extensions before CAS CoW on Darwin', () => {
      if (process.platform !== 'darwin') return;
      const soSrcDir = path.join(tmpDir, 'macho-so-src');
      fs.mkdirSync(soSrcDir, {recursive: true});
      fs.writeFileSync(
        path.join(soSrcDir, 'run'),
        `#!/bin/sh\nexec ${JSON.stringify(defaultAgentScript)}\n`,
        {mode: 0o755}
      );
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
      unpack.bundle(soTar, soDest, path.join(tmpDir, 'cas-macho'));

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
      unpack.bundle(tarPath, dest);
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
      expect(() => unpack.bundle(fifoTar, path.join(tmpDir, 'agent-fifo')))
        .toThrow(/Disallowed special file/);

      const absTar = path.join(tmpDir, 'abs.tar.gz');
      fs.writeFileSync(
        absTar,
        buildTestTarGz([
          {name: '/etc/passwd', type: '0', data: Buffer.from('x')},
        ])
      );
      expect(() => unpack.bundle(absTar, path.join(tmpDir, 'agent-abs')))
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
      expect(() => unpack.bundle(loopTar, path.join(tmpDir, 'agent-loop')))
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
      expect(() => unpack.bundle(fwdLinkTar, path.join(tmpDir, 'agent-fwd-hl')))
        .toThrow(/does not reference an earlier regular file/);

      const symRunTar = path.join(tmpDir, 'sym-run.tar.gz');
      fs.writeFileSync(
        symRunTar,
        buildTestTarGz([
          {name: 'real-run', type: '0', mode: 0o755, data: Buffer.from('#!/bin/sh\n')},
          {name: 'run', type: '2', linkname: 'real-run'},
        ])
      );
      expect(() => unpack.bundle(symRunTar, path.join(tmpDir, 'agent-sym-run')))
        .toThrow(/missing required executable \.\/run/);

      const nonExecRunTar = path.join(tmpDir, 'nonexec-run.tar.gz');
      fs.writeFileSync(
        nonExecRunTar,
        buildTestTarGz([
          {name: 'run', type: '0', mode: 0o644, data: Buffer.from('#!/bin/sh\n')},
        ])
      );
      expect(() => unpack.bundle(nonExecRunTar, path.join(tmpDir, 'agent-nonexec-run')))
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
      unpack.bundle(linksTar, dest, casDir);

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
      expect(() => unpack.bundle(escapeTar, path.join(agentsSub, 'bundle')))
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
      expect(() => unpack.bundle(fwdSymTar, path.join(tmpDir, 'agent-fwd-sym')))
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
      expect(() => unpack.bundle(caseTar, path.join(tmpDir, 'agent-case-sym')))
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
      unpack.bundle(paxTar, dest);
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
          dirs: packages.dirsForRoot(path.join(tmpDir, 'bad-sha')),
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
          dirs: packages.dirsForRoot(path.join(tmpDir, 'file-blocked')),
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
      const ssrfDirs = packages.dirsForRoot(path.join(tmpDir, 'ssrf'));
      await expect(
        packages.downloadAndUnpackBundle({
          url: 'https://releases.example.com/agent.tar.zst?X-Amz-Signature=123',
          expectedSha256: validArchiveSha,
          agentTargetId: 'agent-unlisted',
          dirs: ssrfDirs,
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
          dirs: ssrfDirs,
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
        dirs: packages.dirsForRoot(path.join(tmpDir, 'redir')),
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

    test('downloadAndUnpackBundle strips leading Authorization prefix from authToken', async () => {
      const seenAuth: Array<string | null> = [];
      const archiveBytes = fs.readFileSync(validArchivePath);
      globalThis.fetch = (_input: string | URL | Request, init?: RequestInit) => {
        seenAuth.push(new Headers(init?.headers).get('authorization'));
        return Promise.resolve(new Response(archiveBytes, {status: 200}));
      };

      await packages.downloadAndUnpackBundle({
        url: 'https://github.com/pkmn/0-error/releases/download/v1/agent.tar.gz',
        expectedSha256: validArchiveSha,
        agentTargetId: 'agent-auth-prefix',
        authToken: 'Authorization: Bearer ghp_prefixed_token',
        dirs: packages.dirsForRoot(path.join(tmpDir, 'auth-prefix')),
      });
      expect(seenAuth).toEqual(['Bearer ghp_prefixed_token']);
    });

    test('unpack.bundle detects zstd compression by magic bytes without a .tar.zst suffix', () => {
      const zstBytes = zlib.zstdCompressSync(zlib.gunzipSync(fs.readFileSync(validArchivePath)));
      const extensionlessPath = path.join(tmpDir, 'magic-zstd-bundle.tar');
      fs.writeFileSync(extensionlessPath, zstBytes);
      const dest = path.join(tmpDir, 'agent-magic-zstd');
      const unpacked = unpack.bundle(extensionlessPath, dest);
      expect(unpacked).toBeGreaterThan(70_000);
      expect(fs.existsSync(path.join(dest, 'run'))).toBe(true);
    });

    test('downloadAndUnpackBundle follows multi-label Hugging Face Xet redirects', async () => {
      const seenHeaders: Array<{url: string; auth: string | null}> = [];
      const zstBytes = zlib.zstdCompressSync(zlib.gunzipSync(fs.readFileSync(validArchivePath)));
      const zstSha = crypto.createHash('sha256').update(zstBytes).digest('hex');
      globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
        const u = typeof input === 'string'
          ? input
          : input instanceof URL ? input.toString() : input.url;
        const hdrs = new Headers(init?.headers);
        seenHeaders.push({url: u, auth: hdrs.get('authorization')});
        if (u.startsWith('https://huggingface.co/')) {
          return Promise.resolve(
            new Response('', {
              status: 302,
              headers: {
                location: 'https://us.aws.cdn.hf.co/xet-bridge-us/abc/def?Signature=signed',
              },
            })
          );
        }
        return Promise.resolve(new Response(zstBytes, {status: 200}));
      };

      const dlBytes = await packages.downloadAndUnpackBundle({
        url: 'https://huggingface.co/pkmn/0-error/resolve/main/agent.tar.zst',
        expectedSha256: zstSha,
        agentTargetId: 'agent-hf-xet',
        authToken: 'hf_private_read_token',
        dirs: packages.dirsForRoot(path.join(tmpDir, 'hf-xet')),
      });
      expect(dlBytes).toBeGreaterThan(70_000);
      expect(seenHeaders).toEqual([
        {
          url: 'https://huggingface.co/pkmn/0-error/resolve/main/agent.tar.zst',
          auth: 'Bearer hf_private_read_token',
        },
        {
          url: 'https://us.aws.cdn.hf.co/xet-bridge-us/abc/def?Signature=signed',
          auth: null,
        },
      ]);
    });

    test('downloadAndUnpackBundle resolves private GitHub releases via API on 404', async () => {
      const calls: Array<{url: string; auth: string | null; accept: string | null}> = [];
      const zstBytes = zlib.zstdCompressSync(zlib.gunzipSync(fs.readFileSync(validArchivePath)));
      const zstSha = crypto.createHash('sha256').update(zstBytes).digest('hex');
      globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
        const u = typeof input === 'string'
          ? input
          : input instanceof URL ? input.toString() : input.url;
        const hdrs = new Headers(init?.headers);
        calls.push({url: u, auth: hdrs.get('authorization'), accept: hdrs.get('accept')});
        if (u === 'https://github.com/pkmn/0-error/releases/download/v1.0.0/agent.tar.zst') {
          return Promise.resolve(new Response('Not Found', {status: 404}));
        }
        if (u === 'https://api.github.com/repos/pkmn/0-error/releases/tags/v1.0.0') {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                assets: [
                  {
                    name: 'agent.tar.zst',
                    url: 'https://api.github.com/repos/pkmn/0-error/releases/assets/4242',
                    browser_download_url:
                      'https://github.com/pkmn/0-error/releases/download/v1.0.0/agent.tar.zst',
                  },
                ],
              }),
              {status: 200, headers: {'content-type': 'application/json'}}
            )
          );
        }
        if (u === 'https://api.github.com/repos/pkmn/0-error/releases/assets/4242') {
          return Promise.resolve(
            new Response('', {
              status: 302,
              headers: {
                location: 'https://release-assets.githubusercontent.com/asset/4242?sig=ok',
              },
            })
          );
        }
        return Promise.resolve(new Response(zstBytes, {status: 200}));
      };

      const dlBytes = await packages.downloadAndUnpackBundle({
        url: 'https://github.com/pkmn/0-error/releases/download/v1.0.0/agent.tar.zst',
        expectedSha256: zstSha,
        agentTargetId: 'agent-gh-private',
        authToken: 'github_pat_private_release_secret',
        dirs: packages.dirsForRoot(path.join(tmpDir, 'gh-private')),
      });
      expect(dlBytes).toBeGreaterThan(70_000);
      expect(calls).toEqual([
        {
          url: 'https://github.com/pkmn/0-error/releases/download/v1.0.0/agent.tar.zst',
          auth: 'Bearer github_pat_private_release_secret',
          accept: null,
        },
        {
          url: 'https://api.github.com/repos/pkmn/0-error/releases/tags/v1.0.0',
          auth: 'Bearer github_pat_private_release_secret',
          accept: 'application/vnd.github+json',
        },
        {
          url: 'https://api.github.com/repos/pkmn/0-error/releases/assets/4242',
          auth: 'Bearer github_pat_private_release_secret',
          accept: 'application/octet-stream',
        },
        {
          url: 'https://release-assets.githubusercontent.com/asset/4242?sig=ok',
          auth: null,
          accept: null,
        },
      ]);
    });

    test('downloadAndUnpackBundle encodes slashed tags in GitHub API fallback', async () => {
      const seenUrls: string[] = [];
      const archiveBytes = fs.readFileSync(validArchivePath);
      globalThis.fetch = (input: string | URL | Request) => {
        const u = typeof input === 'string'
          ? input
          : input instanceof URL ? input.toString() : input.url;
        seenUrls.push(u);
        if (u.startsWith('https://github.com/')) {
          return Promise.resolve(new Response('Not Found', {status: 404}));
        }
        if (u === 'https://api.github.com/repos/pkmn/0-error/releases/tags/pkg%2Fv1') {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                assets: [
                  {
                    name: 'agent.tar.gz',
                    url: 'https://api.github.com/repos/pkmn/0-error/releases/assets/77',
                  },
                ],
              }),
              {status: 200}
            )
          );
        }
        if (u === 'https://api.github.com/repos/pkmn/0-error/releases/assets/77') {
          return Promise.resolve(
            new Response('', {
              status: 302,
              headers: {location: 'https://release-assets.githubusercontent.com/asset/77'},
            })
          );
        }
        return Promise.resolve(new Response(archiveBytes, {status: 200}));
      };

      await packages.downloadAndUnpackBundle({
        url: 'https://github.com/pkmn/0-error/releases/download/pkg/v1/agent.tar.gz',
        expectedSha256: validArchiveSha,
        agentTargetId: 'agent-gh-slash-tag',
        authToken: 'github_pat_slash_tag',
        dirs: packages.dirsForRoot(path.join(tmpDir, 'gh-slash')),
      });
      expect(seenUrls).toContain('https://api.github.com/repos/pkmn/0-error/releases/tags/pkg%2Fv1');
    });

    test('downloadAndUnpackBundle resolves private GitHub latest release downloads', async () => {
      const seenUrls: string[] = [];
      const archiveBytes = fs.readFileSync(validArchivePath);
      globalThis.fetch = (input: string | URL | Request) => {
        const u = typeof input === 'string'
          ? input
          : input instanceof URL ? input.toString() : input.url;
        seenUrls.push(u);
        if (u.startsWith('https://github.com/')) {
          return Promise.resolve(new Response('Not Found', {status: 404}));
        }
        if (u === 'https://api.github.com/repos/pkmn/0-error/releases/latest') {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                assets: [
                  {
                    name: 'agent.tar.gz',
                    url: 'https://api.github.com/repos/pkmn/0-error/releases/assets/88',
                  },
                ],
              }),
              {status: 200}
            )
          );
        }
        if (u === 'https://api.github.com/repos/pkmn/0-error/releases/assets/88') {
          return Promise.resolve(
            new Response('', {
              status: 302,
              headers: {location: 'https://release-assets.githubusercontent.com/asset/88'},
            })
          );
        }
        return Promise.resolve(new Response(archiveBytes, {status: 200}));
      };

      await packages.downloadAndUnpackBundle({
        url: 'https://github.com/pkmn/0-error/releases/latest/download/agent.tar.gz',
        expectedSha256: validArchiveSha,
        agentTargetId: 'agent-gh-latest',
        authToken: 'github_pat_latest',
        dirs: packages.dirsForRoot(path.join(tmpDir, 'gh-latest')),
      });
      expect(seenUrls).toContain('https://api.github.com/repos/pkmn/0-error/releases/latest');
    });

    test('downloadAndUnpackBundle scrubs token if GitHub release API fallback fails', async () => {
      globalThis.fetch = (input: string | URL | Request) => {
        const u = typeof input === 'string'
          ? input
          : input instanceof URL ? input.toString() : input.url;
        if (u.startsWith('https://github.com/')) {
          return Promise.resolve(new Response('Not Found', {status: 404}));
        }
        return Promise.reject(new Error('network error carrying github_pat_leak_check'));
      };

      await expect(
        packages.downloadAndUnpackBundle({
          url: 'https://github.com/pkmn/0-error/releases/download/v1/agent.tar.zst',
          expectedSha256: validArchiveSha,
          agentTargetId: 'agent-gh-fail',
          authToken: 'github_pat_leak_check',
          dirs: packages.dirsForRoot(path.join(tmpDir, 'gh-fail')),
        })
      ).rejects.toThrow('network error carrying [REDACTED]');
    });

    test('downloadAndUnpackBundle resolves private GitHub draft releases via releases list',
      async () => {
        const seenUrls: string[] = [];
        const archiveBytes = fs.readFileSync(validArchivePath);
        globalThis.fetch = (input: string | URL | Request) => {
          const u = typeof input === 'string'
            ? input
            : input instanceof URL ? input.toString() : input.url;
          seenUrls.push(u);
          if (u === 'https://github.com/pkmn/0-error/releases/download/untagged-abc/agent.tar.gz') {
            return Promise.resolve(new Response('Not Found', {status: 404}));
          }
          if (u === 'https://api.github.com/repos/pkmn/0-error/releases/tags/untagged-abc') {
            return Promise.resolve(new Response('Not Found', {status: 404}));
          }
          if (u === 'https://api.github.com/repos/pkmn/0-error/releases?per_page=100') {
            return Promise.resolve(
              new Response(
                JSON.stringify([
                  {
                    tag_name: 'v1.0.0',
                    assets: [
                      {
                        name: 'agent.tar.gz',
                        url: 'https://api.github.com/repos/pkmn/0-error/releases/assets/555',
                        browser_download_url:
                          'https://github.com/pkmn/0-error/releases/download/untagged-abc/agent.tar.gz',
                      },
                    ],
                  },
                ]),
                {status: 200}
              )
            );
          }
          if (u === 'https://api.github.com/repos/pkmn/0-error/releases/assets/555') {
            return Promise.resolve(
              new Response('', {
                status: 302,
                headers: {location: 'https://release-assets.githubusercontent.com/asset/555'},
              })
            );
          }
          return Promise.resolve(new Response(archiveBytes, {status: 200}));
        };

        await packages.downloadAndUnpackBundle({
          url: 'https://github.com/pkmn/0-error/releases/download/untagged-abc/agent.tar.gz',
          expectedSha256: validArchiveSha,
          agentTargetId: 'agent-gh-draft',
          authToken: 'github_pat_draft',
          dirs: packages.dirsForRoot(path.join(tmpDir, 'gh-draft')),
        });
        expect(seenUrls).toContain(
          'https://api.github.com/repos/pkmn/0-error/releases?per_page=100'
        );
      });

    test('downloadAndUnpackBundle rewrites GitHub blob URLs to raw downloads', async () => {
      const seenUrls: string[] = [];
      const archiveBytes = fs.readFileSync(validArchivePath);
      globalThis.fetch = (input: string | URL | Request) => {
        const u = typeof input === 'string'
          ? input
          : input instanceof URL ? input.toString() : input.url;
        seenUrls.push(u);
        if (u === 'https://github.com/pkmn/0-error/raw/main/dist/agent.tar.gz') {
          return Promise.resolve(
            new Response('', {
              status: 302,
              headers: {
                location: 'https://raw.githubusercontent.com/pkmn/0-error/main/dist/agent.tar.gz',
              },
            })
          );
        }
        return Promise.resolve(new Response(archiveBytes, {status: 200}));
      };

      await packages.downloadAndUnpackBundle({
        url: 'https://github.com/pkmn/0-error/blob/main/dist/agent.tar.gz?raw=true',
        expectedSha256: validArchiveSha,
        agentTargetId: 'agent-gh-blob',
        dirs: packages.dirsForRoot(path.join(tmpDir, 'gh-blob')),
      });
      expect(seenUrls).toEqual([
        'https://github.com/pkmn/0-error/raw/main/dist/agent.tar.gz',
        'https://raw.githubusercontent.com/pkmn/0-error/main/dist/agent.tar.gz',
      ]);
    });

    test('downloadAndUnpackBundle resolves private GitHub raw file URLs via Contents API',
      async () => {
        const calls: Array<{url: string; auth: string | null; accept: string | null}> = [];
        const archiveBytes = fs.readFileSync(validArchivePath);
        globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
          const u = typeof input === 'string'
            ? input
            : input instanceof URL ? input.toString() : input.url;
          const hdrs = new Headers(init?.headers);
          calls.push({url: u, auth: hdrs.get('authorization'), accept: hdrs.get('accept')});
          if (u.startsWith('https://raw.githubusercontent.com/')) {
            return Promise.resolve(new Response('Not Found', {status: 404}));
          }
          return Promise.resolve(new Response(archiveBytes, {status: 200}));
        };

        await packages.downloadAndUnpackBundle({
          url: 'https://raw.githubusercontent.com/pkmn/0-error/refs/heads/main/dist/agent.tar.gz',
          expectedSha256: validArchiveSha,
          agentTargetId: 'agent-gh-raw-private',
          authToken: 'github_pat_raw_private',
          dirs: packages.dirsForRoot(path.join(tmpDir, 'gh-raw-private')),
        });
        expect(calls).toEqual([
          {
            url: 'https://raw.githubusercontent.com/pkmn/0-error/refs/heads/main/dist/agent.tar.gz',
            auth: 'Bearer github_pat_raw_private',
            accept: null,
          },
          {
            url: 'https://api.github.com/repos/pkmn/0-error/contents/dist/agent.tar.gz' +
              '?ref=refs%2Fheads%2Fmain',
            auth: 'Bearer github_pat_raw_private',
            accept: 'application/vnd.github.raw+json',
          },
        ]);
      });

    test('downloadAndUnpackBundle sends raw media Accept header for GitHub Contents API URLs',
      async () => {
        let seenAccept: string | null = null;
        const archiveBytes = fs.readFileSync(validArchivePath);
        globalThis.fetch = (_input: string | URL | Request, init?: RequestInit) => {
          seenAccept = new Headers(init?.headers).get('accept');
          return Promise.resolve(new Response(archiveBytes, {status: 200}));
        };

        await packages.downloadAndUnpackBundle({
          url: 'https://api.github.com/repos/pkmn/0-error/contents/dist/agent.tar.gz?ref=main',
          expectedSha256: validArchiveSha,
          agentTargetId: 'agent-gh-contents',
          authToken: 'github_pat_contents',
          dirs: packages.dirsForRoot(path.join(tmpDir, 'gh-contents')),
        });
        expect(seenAccept).toBe('application/vnd.github.raw+json');
      });

    test('downloadAndUnpackBundle resolves GitHub Git LFS pointers via LFS Batch API', async () => {
      const calls: Array<{url: string; method: string; auth: string | null}> = [];
      const zstBytes = zlib.zstdCompressSync(zlib.gunzipSync(fs.readFileSync(validArchivePath)));
      const zstSha = crypto.createHash('sha256').update(zstBytes).digest('hex');
      const lfsPointer =
        'version https://git-lfs.github.com/spec/v1\n' +
        `oid sha256:${zstSha}\n` +
        `size ${zstBytes.byteLength}\n`;

      globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
        const u = typeof input === 'string'
          ? input
          : input instanceof URL ? input.toString() : input.url;
        const hdrs = new Headers(init?.headers);
        calls.push({url: u, method: init?.method ?? 'GET', auth: hdrs.get('authorization')});
        if (u === 'https://github.com/pkmn/0-error/raw/main/agent.tar.zst') {
          return Promise.resolve(new Response('Not Found', {status: 404}));
        }
        if (u === 'https://api.github.com/repos/pkmn/0-error/contents/agent.tar.zst?ref=main') {
          return Promise.resolve(new Response(lfsPointer, {status: 200}));
        }
        if (u === 'https://github.com/pkmn/0-error.git/info/lfs/objects/batch') {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                objects: [
                  {
                    oid: zstSha,
                    size: zstBytes.byteLength,
                    actions: {
                      download: {
                        href: 'https://github-cloud.s3.amazonaws.com/alambic/media/lfs-obj?sig=1',
                      },
                    },
                  },
                ],
              }),
              {status: 200}
            )
          );
        }
        return Promise.resolve(new Response(zstBytes, {status: 200}));
      };

      const dlBytes = await packages.downloadAndUnpackBundle({
        url: 'https://github.com/pkmn/0-error/blob/main/agent.tar.zst',
        expectedSha256: zstSha,
        agentTargetId: 'agent-gh-lfs',
        authToken: 'github_pat_lfs_secret',
        dirs: packages.dirsForRoot(path.join(tmpDir, 'gh-lfs')),
      });
      expect(dlBytes).toBeGreaterThan(70_000);
      expect(calls).toEqual([
        {
          url: 'https://github.com/pkmn/0-error/raw/main/agent.tar.zst',
          method: 'GET',
          auth: 'Bearer github_pat_lfs_secret',
        },
        {
          url: 'https://api.github.com/repos/pkmn/0-error/contents/agent.tar.zst?ref=main',
          method: 'GET',
          auth: 'Bearer github_pat_lfs_secret',
        },
        {
          url: 'https://github.com/pkmn/0-error.git/info/lfs/objects/batch',
          method: 'POST',
          auth: `Basic ${Buffer.from('x-access-token:github_pat_lfs_secret').toString('base64')}`,
        },
        {
          url: 'https://github-cloud.s3.amazonaws.com/alambic/media/lfs-obj?sig=1',
          method: 'GET',
          auth: null,
        },
      ]);
    });

    test('downloadAndUnpackBundle base64-encodes Basic user:pass authToken values', async () => {
      let seenAuth: string | null = null;
      const archiveBytes = fs.readFileSync(validArchivePath);
      globalThis.fetch = (_input: string | URL | Request, init?: RequestInit) => {
        seenAuth = new Headers(init?.headers).get('authorization');
        return Promise.resolve(new Response(archiveBytes, {status: 200}));
      };

      await packages.downloadAndUnpackBundle({
        url: 'https://raw.githubusercontent.com/pkmn/0-error/main/agent.tar.gz',
        expectedSha256: validArchiveSha,
        agentTargetId: 'agent-basic-auth',
        authToken: 'Basic token:github_pat_basic',
        dirs: packages.dirsForRoot(path.join(tmpDir, 'basic-auth')),
      });
      expect(seenAuth).toBe(
        `Basic ${Buffer.from('token:github_pat_basic', 'utf8').toString('base64')}`
      );
    });

    test('downloadAndUnpackBundle downloads direct GitHub API release asset URLs', async () => {
      const calls: Array<{url: string; auth: string | null; accept: string | null}> = [];
      const zstBytes = zlib.zstdCompressSync(zlib.gunzipSync(fs.readFileSync(validArchivePath)));
      const zstSha = crypto.createHash('sha256').update(zstBytes).digest('hex');
      globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
        const u = typeof input === 'string'
          ? input
          : input instanceof URL ? input.toString() : input.url;
        const hdrs = new Headers(init?.headers);
        calls.push({url: u, auth: hdrs.get('authorization'), accept: hdrs.get('accept')});
        if (u === 'https://api.github.com/repos/pkmn/0-error/releases/assets/99') {
          return Promise.resolve(
            new Response('', {
              status: 302,
              headers: {location: 'https://release-assets.githubusercontent.com/asset/99?sig=1'},
            })
          );
        }
        return Promise.resolve(new Response(zstBytes, {status: 200}));
      };

      const dlBytes = await packages.downloadAndUnpackBundle({
        url: 'https://api.github.com/repos/pkmn/0-error/releases/assets/99',
        expectedSha256: zstSha,
        agentTargetId: 'agent-gh-api-direct',
        authToken: 'github_pat_direct_asset',
        dirs: packages.dirsForRoot(path.join(tmpDir, 'gh-direct')),
      });
      expect(dlBytes).toBeGreaterThan(70_000);
      expect(calls).toEqual([
        {
          url: 'https://api.github.com/repos/pkmn/0-error/releases/assets/99',
          auth: 'Bearer github_pat_direct_asset',
          accept: 'application/octet-stream',
        },
        {
          url: 'https://release-assets.githubusercontent.com/asset/99?sig=1',
          auth: null,
          accept: null,
        },
      ]);
    });

    test('writePrivateSkopeoAuthfile selects registry-specific default usernames', () => {
      const authDir = path.join(tmpDir, 'skopeo-registry-defaults');
      fs.mkdirSync(authDir, {recursive: true});
      const readCreds = (imageRef: string, token: string, hostKey: string) => {
        const p = packages.writePrivateSkopeoAuthfile(authDir, imageRef, token);
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as {
          auths: Record<string, {auth: string}>;
        };
        return Buffer.from(parsed.auths[hostKey].auth, 'base64').toString('utf8');
      };

      expect(
        readCreds('us-central1-docker.pkg.dev/p/r/a:1', 'ya29.tok', 'us-central1-docker.pkg.dev')
      ).toBe('oauth2accesstoken:ya29.tok');
      expect(
        readCreds(
          '123456789012.dkr.ecr.us-east-1.amazonaws.com/a:1',
          'ecr_pass',
          '123456789012.dkr.ecr.us-east-1.amazonaws.com'
        )
      ).toBe('AWS:ecr_pass');
      expect(readCreds('quay.io/pkmn/a:1', 'quay_tok', 'quay.io')).toBe('$oauthtoken:quay_tok');
      expect(readCreds('ghcr.io/pkmn/a:1', 'token ghp_abc', 'ghcr.io')).toBe('oauth2:ghp_abc');
    });

    test('downloadAndUnpackBundle blocks Contents API traversal via encoded slashes', async () => {
      const seenUrls: string[] = [];
      globalThis.fetch = (input: string | URL | Request) => {
        const u = typeof input === 'string'
          ? input
          : input instanceof URL ? input.toString() : input.url;
        seenUrls.push(u);
        return Promise.resolve(new Response('Not Found', {status: 404}));
      };

      await expect(
        packages.downloadAndUnpackBundle({
          url: 'https://github.com/pkmn/0-error/raw/main/x%2F..%2F..%2F..%2F..%2F..%2Fuser.tar.zst',
          expectedSha256: validArchiveSha,
          agentTargetId: 'agent-gh-traversal',
          authToken: 'github_pat_traversal_guard',
          dirs: packages.dirsForRoot(path.join(tmpDir, 'gh-traversal')),
        })
      ).rejects.toThrow(/404/);
      expect(seenUrls).toEqual([
        'https://github.com/pkmn/0-error/raw/main/x%2F..%2F..%2F..%2F..%2F..%2Fuser.tar.zst',
      ]);
    });

    test('downloadAndUnpackBundle skips GitHub API fallback after cross-origin redirect',
      async () => {
        const calls: Array<{url: string; auth: string | null}> = [];
        globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
          const u = typeof input === 'string'
            ? input
            : input instanceof URL ? input.toString() : input.url;
          calls.push({url: u, auth: new Headers(init?.headers).get('authorization')});
          if (u.startsWith('https://pub-abc.r2.dev/')) {
            return Promise.resolve(
              new Response('', {
                status: 302,
                headers: {
                  location: 'https://github.com/pkmn/0-error/releases/download/v1/agent.tar.zst',
                },
              })
            );
          }
          return Promise.resolve(new Response('Not Found', {status: 404}));
        };

        await expect(
          packages.downloadAndUnpackBundle({
            url: 'https://pub-abc.r2.dev/agent.tar.zst',
            expectedSha256: validArchiveSha,
            agentTargetId: 'agent-xorigin-404',
            authToken: 'r2_private_secret',
            dirs: packages.dirsForRoot(path.join(tmpDir, 'xorigin-404')),
          })
        ).rejects.toThrow(/404/);
        expect(calls).toEqual([
          {url: 'https://pub-abc.r2.dev/agent.tar.zst', auth: 'Bearer r2_private_secret'},
          {
            url: 'https://github.com/pkmn/0-error/releases/download/v1/agent.tar.zst',
            auth: null,
          },
        ]);
      });

    test('downloadAndUnpackBundle rejects non-allowlisted GitHub LFS download hrefs', async () => {
      const zstBytes = zlib.zstdCompressSync(zlib.gunzipSync(fs.readFileSync(validArchivePath)));
      const zstSha = crypto.createHash('sha256').update(zstBytes).digest('hex');
      const lfsPointer =
        'version https://git-lfs.github.com/spec/v1\n' +
        `oid sha256:${zstSha}\n` +
        `size ${zstBytes.byteLength}\n`;

      globalThis.fetch = (input: string | URL | Request) => {
        const u = typeof input === 'string'
          ? input
          : input instanceof URL ? input.toString() : input.url;
        if (u === 'https://raw.githubusercontent.com/pkmn/0-error/main/agent.tar.zst') {
          return Promise.resolve(new Response(lfsPointer, {status: 200}));
        }
        if (u === 'https://github.com/pkmn/0-error.git/info/lfs/objects/batch') {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                objects: [
                  {
                    oid: zstSha,
                    size: zstBytes.byteLength,
                    actions: {download: {href: 'https://evil.example/agent.tar.zst'}},
                  },
                ],
              }),
              {status: 200}
            )
          );
        }
        throw new Error(`Unexpected fetch to ${u}`);
      };

      await expect(
        packages.downloadAndUnpackBundle({
          url: 'https://raw.githubusercontent.com/pkmn/0-error/main/agent.tar.zst',
          expectedSha256: zstSha,
          agentTargetId: 'agent-lfs-bad-host',
          dirs: packages.dirsForRoot(path.join(tmpDir, 'lfs-bad-host')),
        })
      ).rejects.toThrow(/supported artifact host/);
    });

    test('downloadAndUnpackBundle rejects oversized GitHub LFS pointers before batch POST',
      async () => {
        const seenUrls: string[] = [];
        const lfsPointer =
          'version https://git-lfs.github.com/spec/v1\n' +
          `oid sha256:${validArchiveSha}\n` +
          `size ${packages.MAX_IMAGE_BYTES + 1}\n`;

        globalThis.fetch = (input: string | URL | Request) => {
          const u = typeof input === 'string'
            ? input
            : input instanceof URL ? input.toString() : input.url;
          seenUrls.push(u);
          return Promise.resolve(new Response(lfsPointer, {status: 200}));
        };

        await expect(
          packages.downloadAndUnpackBundle({
            url: 'https://raw.githubusercontent.com/pkmn/0-error/main/agent.tar.gz',
            expectedSha256: validArchiveSha,
            agentTargetId: 'agent-lfs-oversized',
            dirs: packages.dirsForRoot(path.join(tmpDir, 'lfs-oversized')),
          })
        ).rejects.toThrow(/exceeds 500 MiB cap/);
        expect(seenUrls).toEqual([
          'https://raw.githubusercontent.com/pkmn/0-error/main/agent.tar.gz',
        ]);
      });

    test('downloadAndUnpackBundle rejects mismatched GitHub LFS pointer oid before batch POST',
      async () => {
        const seenUrls: string[] = [];
        const otherSha = 'a'.repeat(64);
        const lfsPointer =
          'version https://git-lfs.github.com/spec/v1\n' +
          `oid sha256:${otherSha}\n` +
          'size 1024\n';

        globalThis.fetch = (input: string | URL | Request) => {
          const u = typeof input === 'string'
            ? input
            : input instanceof URL ? input.toString() : input.url;
          seenUrls.push(u);
          return Promise.resolve(new Response(lfsPointer, {status: 200}));
        };

        await expect(
          packages.downloadAndUnpackBundle({
            url: 'https://raw.githubusercontent.com/pkmn/0-error/main/agent.tar.gz',
            expectedSha256: validArchiveSha,
            agentTargetId: 'agent-lfs-sha-mismatch',
            dirs: packages.dirsForRoot(path.join(tmpDir, 'lfs-sha-mismatch')),
          })
        ).rejects.toThrow(/SHA-256 mismatch/);
        expect(seenUrls).toEqual([
          'https://raw.githubusercontent.com/pkmn/0-error/main/agent.tar.gz',
        ]);
      });

    test('downloadAndUnpackBundle forwards explicit user:pass to GitHub LFS without double prefix',
      async () => {
        let lfsAuth: string | null = null;
        const archiveBytes = fs.readFileSync(validArchivePath);
        const lfsPointer =
          'version https://git-lfs.github.com/spec/v1\n' +
          `oid sha256:${validArchiveSha}\n` +
          `size ${archiveBytes.byteLength}\n`;

        globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
          const u = typeof input === 'string'
            ? input
            : input instanceof URL ? input.toString() : input.url;
          if (u === 'https://raw.githubusercontent.com/pkmn/0-error/main/agent.tar.gz') {
            return Promise.resolve(new Response(lfsPointer, {status: 200}));
          }
          if (u === 'https://github.com/pkmn/0-error.git/info/lfs/objects/batch') {
            lfsAuth = new Headers(init?.headers).get('authorization');
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  objects: [
                    {
                      oid: validArchiveSha,
                      size: archiveBytes.byteLength,
                      actions: {
                        download: {
                          href: 'https://github-cloud.githubusercontent.com/alambic/media/obj?s=1',
                        },
                      },
                    },
                  ],
                }),
                {status: 200}
              )
            );
          }
          return Promise.resolve(new Response(archiveBytes, {status: 200}));
        };

        await packages.downloadAndUnpackBundle({
          url: 'https://raw.githubusercontent.com/pkmn/0-error/main/agent.tar.gz',
          expectedSha256: validArchiveSha,
          agentTargetId: 'agent-lfs-userpass',
          authToken: 'myuser:github_pat_lfs_pair',
          dirs: packages.dirsForRoot(path.join(tmpDir, 'lfs-userpass')),
        });
        expect(lfsAuth).toBe(
          `Basic ${Buffer.from('myuser:github_pat_lfs_pair', 'utf8').toString('base64')}`
        );
      });

    test('scrubAuthSecret redacts decoded credentials from base64 Basic tokens', () => {
      const encoded = Buffer.from('myuser:super_secret_pw', 'utf8').toString('base64');
      const token = `Basic ${encoded}`;
      expect(
        packages.scrubAuthSecret('auth failed for myuser:super_secret_pw', token)
      ).toBe('auth failed for [REDACTED]');
      expect(
        packages.scrubAuthSecret('password super_secret_pw rejected', token)
      ).toBe('password [REDACTED] rejected');
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
        expect(compareDatabaseSchemas(migratedDb.db, freshDb.db)).toEqual([]);
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
          dirs: packages.dirsForRoot(path.join(tmpDir, 'evict-containers')),
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
        const dirs = packages.dirsForRoot(path.join(tmpDir, 'evict-native'));
        fs.mkdirSync(path.join(dirs.agents, 'old-v1'), {recursive: true});
        fs.mkdirSync(path.join(dirs.agents, 'new-v2'), {recursive: true});

        const orphanBuf = Buffer.alloc(70_000, 0x11);
        const orphanDigest = crypto.createHash('sha256').update(orphanBuf).digest('hex');
        const orphanShard = path.join(dirs.cas, orphanDigest.slice(0, 2));
        fs.mkdirSync(orphanShard, {recursive: true});
        const orphanBlob = path.join(orphanShard, orphanDigest);
        fs.writeFileSync(orphanBlob, orphanBuf);
        fs.writeFileSync(path.join(dirs.agents, 'old-v1', 'weights.bin'), orphanBuf);
        const oldRefFile = unpack.casRefFileForBundle(dirs.cas, path.join(dirs.agents, 'old-v1'));
        fs.mkdirSync(path.dirname(oldRefFile), {recursive: true});
        fs.writeFileSync(oldRefFile, `${orphanDigest}\n`);

        const sharedBuf = Buffer.alloc(70_000, 0x22);
        const sharedDigest = crypto.createHash('sha256').update(sharedBuf).digest('hex');
        const sharedShard = path.join(dirs.cas, sharedDigest.slice(0, 2));
        fs.mkdirSync(sharedShard, {recursive: true});
        const sharedBlob = path.join(sharedShard, sharedDigest);
        fs.writeFileSync(sharedBlob, sharedBuf);
        fs.writeFileSync(path.join(dirs.agents, 'new-v2', 'weights.bin'), sharedBuf);
        const newRefFile = unpack.casRefFileForBundle(dirs.cas, path.join(dirs.agents, 'new-v2'));
        fs.writeFileSync(newRefFile, `${sharedDigest}\n`);

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
          dirs,
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
        const dirs = packages.dirsForRoot(path.join(tmpDir, 'evict-retired'));
        const retiredDir = path.join(dirs.agents, 'retired-v1');
        const activeDir = path.join(dirs.agents, 'active-v2');
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
          dirs,
          activeVersionIds: new Set([2]),
        });
        expect(evicted).toEqual([1]);
        expect(stateDb.getLocalAgent(1)?.residency).toBe('cold');
        expect(stateDb.getLocalAgent(2)?.residency).toBe('hot');
        expect(fs.existsSync(retiredDir)).toBe(false);
        expect(fs.existsSync(path.join(dirs.cold, 'retired-v1.tar.zst'))).toBe(true);

        const restored = packages.ensureAgentResident(stateDb, 1, {
          dirs,
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
        const dirs = packages.dirsForRoot(path.join(tmpDir, 'missing-cold'));
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
        expect(() => packages.ensureAgentResident(stateDb, 77, {dirs}))
          .toThrow(/Cold archive missing/);
        expect(stateDb.getLocalAgent(77)?.residency).toBe('cold');
        expect(fs.existsSync(path.join(dirs.agents, 'ghost-1.0.0-v77'))).toBe(false);
      } finally {
        stateDb.close();
      }
    });
  });
});
