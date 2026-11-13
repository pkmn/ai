import {execFileSync, spawn} from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import {Teams} from '@pkmn/sim';
import polka from 'polka';
import {afterAll, beforeAll, describe, expect, test} from 'vitest';

import * as arenaIndex from '../arena';
import {TimeSlicedArenaGame, TurnHeartbeatInfo} from '../arena/arbiter';
import {Coordinator, LadderSnapshot} from '../arena/coordinator';
import {StateDatabase} from '../arena/db';
import {
  computeResidencyMultipliers,
  downloadAndUnpackBundle,
  unpackLocalTarArchive,
  verifyOciManifestDigest,
} from '../arena/packages';
import {
  ConcurrentTournamentGame,
  TournamentCoordinator,
  buildStratifiedTournamentBook,
  rewriteBlindPlayerNames,
  selectNextTournamentBatch,
} from '../arena/tournament';
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

describe('arena/ — Mac mini & GCP Championship Tournament infrastructure', () => {
  let tmpDir: string;
  let relayBin: string;
  let limitBin: string;
  let defaultAgentScript: string;
  let crashingAgentScript: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-arena-test-'));
    relayBin = path.join(tmpDir, 'tourney-relay');
    limitBin = path.join(tmpDir, 'limit');

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
        '  if (line.startsWith("|tournament|byot|")) {',
        `    process.stdout.write("/utm ${TEAM_ONE}\\n");`,
        '    return;',
        '  }',
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

    crashingAgentScript = path.join(tmpDir, 'crashing-agent.js');
    fs.writeFileSync(
      crashingAgentScript,
      '#!/usr/bin/env node\nprocess.exit(1);\n',
      {mode: 0o755}
    );
  });

  afterAll(() => {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  test(
    'validates syntax and presence of all arena/config, arena/bin, and arena/scripts files',
    () => {
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
        'arena/config/storage.conf',
        'arena/config/sudoers',
        'arena/bin/arena',
        'arena/bin/baseline',
        'arena/bin/limit.c',
        'arena/bin/unpack',
        'arena/bin/tourney-agent',
        'arena/bin/tourney-relay.c',
        'arena/scripts/setup-arena.sh',
        'arena/scripts/bake-image.sh',
        'arena/scripts/archive.sh',
      ];
      for (const rel of expectedFiles) {
        expect(fs.existsSync(root(rel))).toBe(true);
      }

      execFileSync('bash', [
        '-n',
        root('arena/bin/arena'),
        root('arena/bin/tourney-agent'),
        root('arena/scripts/setup-arena.sh'),
        root('arena/scripts/bake-image.sh'),
        root('arena/scripts/archive.sh'),
      ]);
      execFileSync('sh', ['-n', root('arena/bin/baseline')]);
      const baselineOut = execFileSync(root('arena/bin/baseline'), [], {
        input: [
          '|tournament|byot|{"format":"[Gen 9] OU"}',
          '|request|{"wait":true}',
          '|request|{"teamPreview":true,"maxChosenTeamSize":4}',
          '|request|{"teamPreview":true}',
          '|request|{"active":[{"moves":[{"id":"tackle"}]}]}',
        ].join('\n') + '\n',
        encoding: 'utf8',
      })
        .trim()
        .split('\n');
      expect(baselineOut[0]?.startsWith('/utm ')).toBe(true);
      expect(baselineOut.slice(1)).toEqual(['/team 1234', '/team 123456', 'default']);
      execFileSync('python3', ['-m', 'py_compile', root('arena/bin/unpack')]);
      expect(typeof arenaIndex.runDaemon).toBe('function');

      const sudoersText = fs.readFileSync(root('arena/config/sudoers'), 'utf8');
      expect(sudoersText).toContain('/usr/bin/killall -STOP -u p1');
      expect(sudoersText).toContain('/usr/bin/killall -CONT -u p1');
      expect(sudoersText).toContain('/usr/bin/find /Volumes/P1 -mindepth 1 -delete');

      const sandboxText = fs.readFileSync(root('arena/config/sandbox.sb'), 'utf8');
      expect(sandboxText).toContain('(allow signal (target same-sandbox))');
      expect(sandboxText).toContain('(global-name "com.apple.MTLCompilerService")');
    }
  );

  test('tourney-relay C binary measures local CLOCK_MONOTONIC turn time on stderr', async () => {
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
        if (stdoutLines.join('').includes('default')) {
          resolve();
        } else {
          setTimeout(check, 5);
        }
      };
      check();
    });

    proc.kill('SIGTERM');
    expect(stderrLines.join('')).toMatch(/ARENA_TURN_MS=[1-9]\d*\t1/);
    expect(stdoutLines.join('')).toContain('default');

    // Verify stdin EOF kills hung/ignoring child process groups within ~100ms (no GPU orphans)
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

  test(
    'arena/bin/unpack extracts valid bundles with CAS dedup and rejects bad archives',
    async () => {
      const bundleSrc = path.join(tmpDir, 'bundle-src');
      fs.mkdirSync(bundleSrc, {recursive: true});
      fs.writeFileSync(path.join(bundleSrc, 'run'), fs.readFileSync(defaultAgentScript), {
        mode: 0o755,
      });
      // Write a >64 KB weight file to exercise APFS CoW CAS deduplication
      fs.writeFileSync(path.join(bundleSrc, 'weights.bin'), Buffer.alloc(70_000, 0x42));

      const archivePath = path.join(tmpDir, 'valid-agent.tar.gz');
      execFileSync('tar', ['-czf', archivePath, '-C', bundleSrc, '.']);

      const sha256 = crypto.createHash('sha256')
        .update(fs.readFileSync(archivePath))
        .digest('hex');

      const casDir = path.join(tmpDir, 'cas');
      const agentsDir = path.join(tmpDir, 'agents');
      const stagingDir = path.join(tmpDir, 'staging');

      const bytes1 = await downloadAndUnpackBundle({
        url: `file://${archivePath}`,
        expectedSha256: sha256,
        agentTargetId: 'agent-v1',
        stagingDir,
        agentsDir,
        casDir,
      });
      expect(bytes1).toBeGreaterThan(70_000);
      expect(fs.existsSync(path.join(agentsDir, 'agent-v1', 'run'))).toBe(true);

      // Unpack a second version sharing the identical 70 KB blob to exercise CAS hit
      const bytes2 = unpackLocalTarArchive({
        archivePath,
        destDir: path.join(agentsDir, 'agent-v2'),
        casDir,
      });
      expect(bytes2).toBe(bytes1);

      // Reject SHA-256 mismatch
      await expect(
        downloadAndUnpackBundle({
          url: `file://${archivePath}`,
          expectedSha256: '0'.repeat(64),
          agentTargetId: 'agent-bad-sha',
          stagingDir,
          agentsDir,
          casDir,
        })
      ).rejects.toThrow(/SHA-256 mismatch/);

      // Reject bundle missing './run' without polluting CAS store
      const noRunSrc = path.join(tmpDir, 'no-run-src');
      const noRunCasDir = path.join(tmpDir, 'cas-no-run');
      fs.mkdirSync(noRunSrc, {recursive: true});
      fs.writeFileSync(path.join(noRunSrc, 'README.txt'), 'missing run');
      fs.writeFileSync(path.join(noRunSrc, 'big.bin'), Buffer.alloc(70_000, 0x99));
      const noRunTar = path.join(tmpDir, 'no-run.tar.gz');
      execFileSync('tar', ['-czf', noRunTar, '-C', noRunSrc, '.']);
      expect(() => unpackLocalTarArchive({
        archivePath: noRunTar,
        destDir: path.join(agentsDir, 'agent-no-run'),
        casDir: noRunCasDir,
      })).toThrow(/missing required executable/i);
      expect(fs.existsSync(noRunCasDir)).toBe(false);

      // Reject chained-symlink Tar Slip attempting to escape destDir
      const slipTar = path.join(tmpDir, 'chained-symlink-slip.tar.gz');
      execFileSync('python3', [
        '-c',
        [
          'import io, tarfile, sys',
          'with tarfile.open(sys.argv[1], "w:gz") as tf:',
          '    s1 = tarfile.TarInfo("a/b")',
          '    s1.type = tarfile.SYMTYPE',
          '    s1.linkname = ".."',
          '    tf.addfile(s1)',
          '    s2 = tarfile.TarInfo("a/b/escape")',
          '    s2.type = tarfile.SYMTYPE',
          '    s2.linkname = ".."',
          '    tf.addfile(s2)',
          '    f = tarfile.TarInfo("escape/pwned.txt")',
          '    f.size = 5',
          '    tf.addfile(f, io.BytesIO(b"pwned"))',
        ].join('\n'),
        slipTar,
      ]);
      expect(() => unpackLocalTarArchive({
        archivePath: slipTar,
        destDir: path.join(agentsDir, 'agent-slip'),
        casDir,
      })).toThrow(/traverses symlink|escapes|illegal link target/i);
      expect(fs.existsSync(path.join(agentsDir, 'pwned.txt'))).toBe(false);

      // Verify OCI manifest SHA-256 and config digest checks
      const sampleManifest = JSON.stringify({
        config: {digest: `sha256:${'a'.repeat(64)}`},
        layers: [{size: 1024}, {size: 2048}],
      });
      const manifestSha = crypto.createHash('sha256').update(sampleManifest).digest('hex');
      expect(verifyOciManifestDigest(sampleManifest, manifestSha).layerCount).toBe(2);
      expect(verifyOciManifestDigest(sampleManifest, 'a'.repeat(64)).compressedBytes).toBe(3072);
      expect(() => verifyOciManifestDigest(sampleManifest, 'b'.repeat(64)))
        .toThrow(/OCI digest mismatch/);
    }
  );

  test(
    'StateDatabase & computeResidencyMultipliers track checkpoints, outbox, and LRU',
    () => {
      const stateDb = new StateDatabase(':memory:');
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

      const mult = computeResidencyMultipliers([10, 20], stateDb);
      expect(mult[0 * 2 + 1]).toBeCloseTo(1.05, 5);
      stateDb.setAgentResidency(20, 'hot');
      const multBothHot = computeResidencyMultipliers([10, 20], stateDb);
      expect(multBothHot[0 * 2 + 1]).toBeCloseTo(1.15, 5);

      expect(stateDb.nextMatchSequence('gen9ou')).toBe(1);
      expect(stateDb.nextMatchSequence('gen9ou')).toBe(2);
      expect(stateDb.getMatchSequence('gen9ou')).toBe(2);
      expect(stateDb.getLastGlobalMatchSequence('gen9ou')).toBe(2);
      expect(stateDb.nextMatchSequence('gen1ou')).toBe(1);
      expect(stateDb.getLastGlobalMatchSequence('gen1ou')).toBe(3);
      expect(stateDb.getGlobalMatchCount()).toBe(3);

      stateDb.recordAgentGameResult(10, true, 1000);
      stateDb.recordAgentGameResult(10, true, 1005);
      expect(stateDb.getLocalAgent(10)?.consecutiveFaults).toBe(2);
      stateDb.recordAgentGameResult(10, false, 1010);
      expect(stateDb.getLocalAgent(10)?.consecutiveFaults).toBe(0);
      expect(stateDb.getLocalAgent(10)?.totalGames).toBe(3);
      expect(stateDb.getLocalAgent(10)?.totalFaults).toBe(2);

      stateDb.close();
    }
  );

  test(
    'TimeSlicedArenaGame runs sequential @pkmn/sim battles with chat elision and smoke stop',
    async () => {
      const heartbeats: TurnHeartbeatInfo[] = [];
      const game = new TimeSlicedArenaGame({
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
      expect(result.endReason).toBe('smoke_complete');
      expect(result.turns).toBe(2);
      expect(heartbeats.length).toBeGreaterThanOrEqual(2);
      expect(result.omniscientLog).not.toContain('hello from agent');
      expect(result.omniscientLog).toContain('|player|p1|Agent A|');
      expect(result.omniscientLog).toContain('|player|p2|Agent B|');

      // Verify embedded \r protocol injection attempts in chat/choices are dropped harmlessly
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
      const crInjectGame = new TimeSlicedArenaGame({
        format: 'gen9customgame',
        seed: '1,2,3,4',
        p1Spec: {mode: 'native', target: process.execPath, args: [crInjectScript]},
        p2Spec: {mode: 'native', target: process.execPath, args: [defaultAgentScript]},
        p1TeamPacked: TEAM_ONE,
        p2TeamPacked: TEAM_TWO,
        smokeStopAfterTurn: 1,
        devMode: true,
      });
      const crInjectRes = await crInjectGame.run();
      expect(crInjectRes.endReason).toBe('smoke_complete');
      expect(crInjectRes.winner).toBe('tie');

      // Verify 3 consecutive invalid choices forfeit with canonical invalid_choice_3x reason
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
      const strikesGame = new TimeSlicedArenaGame({
        format: 'gen9customgame',
        seed: '1,2,3,4',
        p1Spec: {mode: 'native', target: process.execPath, args: [threeStrikesScript]},
        p2Spec: {mode: 'native', target: process.execPath, args: [defaultAgentScript]},
        p1TeamPacked: TEAM_ONE,
        p2TeamPacked: TEAM_TWO,
        devMode: true,
      });
      const strikesRes = await strikesGame.run();
      expect(strikesRes.winner).toBe('p2');
      expect(strikesRes.endReason).toBe('invalid_choice_3x');

      // Verify crashing agent forfeits immediately
      const crashGame = new TimeSlicedArenaGame({
        format: 'gen9customgame',
        seed: '1,2,3,4',
        p1Spec: {mode: 'native', target: process.execPath, args: [crashingAgentScript]},
        p2Spec: {mode: 'native', target: process.execPath, args: [defaultAgentScript]},
        p1TeamPacked: TEAM_ONE,
        p2TeamPacked: TEAM_TWO,
        devMode: true,
      });
      const crashRes = await crashGame.run();
      expect(crashRes.winner).toBe('p2');
      expect(crashRes.endReason).toBe('crash');

      // Verify emitting undo / /undo / /choose undo does not deadlock the arbiter
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
      const undoGame = new TimeSlicedArenaGame({
        format: 'gen9customgame',
        seed: '1,2,3,4',
        p1Spec: {mode: 'native', target: process.execPath, args: [undoAgentScript]},
        p2Spec: {mode: 'native', target: process.execPath, args: [defaultAgentScript]},
        p1TeamPacked: TEAM_ONE,
        p2TeamPacked: TEAM_TWO,
        smokeStopAfterTurn: 1,
        devMode: true,
      });
      const undoRes = await undoGame.run();
      expect(undoRes.endReason).toBe('smoke_complete');

      // Verify gen9championsvgc2026regmc defaults to Closed Team Sheets on the ladder,
      // supports Open Team Sheets via customRules for tournaments, and gen9randombattle
      // generates 6-Pokemon teams via @pkmn/randoms
      const randTeams = sampleRandomPair('gen9randombattle', '1,2,3,4', '5,6,7,8');
      expect(Teams.unpack(randTeams.t1Packed)).toHaveLength(6);
      expect(Teams.unpack(randTeams.t2Packed)).toHaveLength(6);
      expect(randTeams.t1Packed).not.toBe(randTeams.t2Packed);

      const vgcGame = new TimeSlicedArenaGame({
        format: 'gen9championsvgc2026regmc',
        seed: '1,2,3,4',
        p1Spec: {mode: 'native', target: process.execPath, args: [defaultAgentScript]},
        p2Spec: {mode: 'native', target: process.execPath, args: [defaultAgentScript]},
        p1TeamPacked: TEAM_ONE,
        p2TeamPacked: TEAM_TWO,
        smokeStopAfterTurn: 1,
        devMode: true,
      });
      const vgcRes = await vgcGame.run();
      expect(vgcRes.endReason).toBe('smoke_complete');
      expect(vgcRes.omniscientLog).toContain('|gametype|doubles');
      expect(vgcRes.omniscientLog).toContain('|teampreview|4');
      expect(vgcRes.omniscientLog).not.toContain('|showteam|');

      const vgcOtsGame = new TimeSlicedArenaGame({
        format: 'gen9championsvgc2026regmc',
        customRules: ['Open Team Sheets'],
        seed: '1,2,3,4',
        p1Spec: {mode: 'native', target: process.execPath, args: [defaultAgentScript]},
        p2Spec: {mode: 'native', target: process.execPath, args: [defaultAgentScript]},
        p1TeamPacked: TEAM_ONE,
        p2TeamPacked: TEAM_TWO,
        smokeStopAfterTurn: 1,
        devMode: true,
      });
      const vgcOtsRes = await vgcOtsGame.run();
      expect(vgcOtsRes.endReason).toBe('smoke_complete');
      expect(vgcOtsRes.omniscientLog).toContain('|showteam|p1|');
      expect(vgcOtsRes.omniscientLog).toContain('|showteam|p2|');

      // Verify retrying invalid choices does not farm extra bank increments
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
          '  if (!sawInactive && !req.teamPreview) {',
          '    process.exit(2);',
          '  }',
          '  process.stdout.write(req.teamPreview ? "/team 123456\\n" : "default\\n");',
          '});',
        ].join('\n'),
        {mode: 0o755}
      );
      const retryGame = new TimeSlicedArenaGame({
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
      });
      const retryRes = await retryGame.run();
      expect(retryRes.endReason).toBe('smoke_complete');
      expect(retryRes.p1BankSeconds).toBeLessThanOrEqual(retryRes.p2BankSeconds);

      // Verify an agent writing >64 KiB without a newline forfeits immediately with crash
      const floodScript = path.join(tmpDir, 'flood-agent.js');
      fs.writeFileSync(
        floodScript,
        '#!/usr/bin/env node\nprocess.stdout.write("A".repeat(100000));\n',
        {mode: 0o755}
      );
      const floodGame = new TimeSlicedArenaGame({
        format: 'gen9customgame',
        seed: '1,2,3,4',
        p1Spec: {mode: 'native', target: process.execPath, args: [floodScript]},
        p2Spec: {mode: 'native', target: process.execPath, args: [defaultAgentScript]},
        p1TeamPacked: TEAM_ONE,
        p2TeamPacked: TEAM_TWO,
        devMode: true,
      });
      const floodRes = await floodGame.run();
      expect(floodRes.winner).toBe('p2');
      expect(floodRes.endReason).toBe('crash');
    }
  );

  test(
    'ConcurrentTournamentGame supports Blind-Pair mode, BYOT mode, and Spot preemption',
    async () => {
      const spectatorChunks: string[] = [];
      const blindGame = new ConcurrentTournamentGame({
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
        byot: false,
        p1TeamPacked: TEAM_ONE,
        p2TeamPacked: TEAM_TWO,
        maxTurns: 2,
        onSpectatorChunk: chunk => spectatorChunks.push(chunk),
      });

      const blindRes = await blindGame.run();
      expect(blindRes.turns).toBeGreaterThanOrEqual(2);
      expect(blindRes.omniscientLog).toContain('|player|p1|Foul Play|');
      expect(blindRes.omniscientLog).toContain('|player|p2|PokeChamp|');
      expect(blindRes.omniscientLog).not.toContain('|player|p1|Agent A|');
      expect(spectatorChunks.length).toBeGreaterThan(0);

      // BYOT mode test
      const byotGame = new ConcurrentTournamentGame({
        format: 'gen9customgame',
        seed: '1,2,3,4',
        p1Spec: {
          agentId: 'foul-play',
          displayName: 'Foul Play',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          staticTeam: TEAM_ONE,
          localCommand: relayBin,
          localArgs: [process.execPath, defaultAgentScript],
        },
        p2Spec: {
          agentId: 'pokechamp',
          displayName: 'PokeChamp',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          staticTeam: TEAM_TWO,
          localCommand: relayBin,
          localArgs: [process.execPath, defaultAgentScript],
        },
        byot: true,
        maxTurns: 1,
      });
      const byotRes = await byotGame.run();
      expect(byotRes.p1TeamPacked).toBeTruthy();
      expect(byotRes.p2TeamPacked).toBeTruthy();

      // Spot preemption test (zero-penalty abort on ARENA_SPOT_PREEMPTED)
      const preemptScript = path.join(tmpDir, 'preempt-agent.js');
      fs.writeFileSync(
        preemptScript,
        [
          '#!/usr/bin/env node',
          'process.stderr.write("ARENA_SPOT_PREEMPTED\\n");',
          'process.exit(143);',
        ].join('\n'),
        {mode: 0o755}
      );

      const preemptGame = new ConcurrentTournamentGame({
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
        byot: false,
        p1TeamPacked: TEAM_ONE,
        p2TeamPacked: TEAM_TWO,
      });
      const preemptRes = await preemptGame.run();
      expect(preemptRes.winner).toBe('preempted');
      expect(preemptRes.preemptedSlot).toBe('p2');
      expect(preemptRes.endReason).toBe('spot_preemption');

      // When wrapped by tourney-relay, child stderr is isolated to /dev/null so an agent
      // cannot spoof ARENA_SPOT_PREEMPTED to dodge a loss.
      const spoofedPreemptGame = new ConcurrentTournamentGame({
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
        byot: false,
        p1TeamPacked: TEAM_ONE,
        p2TeamPacked: TEAM_TWO,
      });
      const spoofedRes = await spoofedPreemptGame.run();
      expect(spoofedRes.winner).toBe('p1');
      expect(spoofedRes.endReason).toBe('crash');
      expect(rewriteBlindPlayerNames('|win|Agent A', 'Alpha', 'Beta')).toBe('|win|Alpha');
    }
  );

  test(
    'buildStratifiedTournamentBook & selectNextTournamentBatch schedule sticky-VM waves',
    () => {
      let seed = 42;
      const rng = (max: number) => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed % max;
      };

      const book = buildStratifiedTournamentBook([TEAM_ONE, TEAM_TWO], 8, rng);
      expect(book).toHaveLength(4);
      for (const pair of book) {
        expect(pair.team1Packed).not.toBe(pair.team2Packed);
      }

      const matchups = [
        {agentA: 1, agentB: 2, gamesPlayed: 10, gamesTarget: 20, inFlight: false},
        {agentA: 1, agentB: 3, gamesPlayed: 0, gamesTarget: 20, inFlight: false},
        {agentA: 2, agentB: 4, gamesPlayed: 0, gamesTarget: 20, inFlight: false},
      ];
      const totals = new Map<number, number>([
        [1, 10],
        [2, 10],
        [3, 0],
        [4, 0],
      ]);

      // With VM A holding agent 1 and VM B holding agent 2, both (1,3) and (2,4) are in wave 0
      // with 1 resident agent each; (1,3) is selected and keeps agent 1 on VM A.
      const batch = selectNextTournamentBatch(
        matchups,
        totals,
        {vmAAgent: 1, vmBAgent: 2},
        10
      );
      expect(batch).toEqual({
        agentOnVmA: 1,
        agentOnVmB: 3,
        gamesToPlay: 10,
        startingGameIndex: 0,
      });
    }
  );

  test(
    'Coordinator handles crash recovery, smoke tests, 3rd-version retirement, and matches',
    async () => {
      const utmLogFile = path.join(tmpDir, 'v30-utm.log');
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
      const bundleTar = path.join(tmpDir, 'coord-agent.tar.gz');
      execFileSync('tar', ['-czf', bundleTar, '-C', bundleDir, '.']);
      const bundleSha = crypto.createHash('sha256')
        .update(fs.readFileSync(bundleTar))
        .digest('hex');

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

      const stateDb = new StateDatabase(':memory:');
      const agentsDir = path.join(tmpDir, 'coord-agents');
      const stagingDir = path.join(tmpDir, 'coord-staging');
      const casDir = path.join(tmpDir, 'coord-cas');

      const coord = new Coordinator({
        client: mockClient,
        stateDb,
        baselineSpec: {mode: 'native', target: process.execPath, args: [defaultAgentScript]},
        agentsDir,
        stagingDir,
        casDir,
        devMode: true,
        maxTurns: 1,
      });

      const ladderSnap: LadderSnapshot = {
        id: 'gen9customgame',
        slot: 'sv',
        format: 'gen9customgame',
        team: 'random',
        status: 'active',
        min: 2,
        entries: [
          {
            versionId: 10,
            agentId: 1,
            agentSlug: 'foul-play',
            agentName: 'Foul Play',
            version: '1.0.0',
            elo: 1480,
            se: 40,
            lcb: 1400,
            matches: 20,
            settledAt: 100,
            role: 'challenger',
          },
          {
            versionId: 20,
            agentId: 1,
            agentSlug: 'foul-play',
            agentName: 'Foul Play',
            version: '2.0.0',
            elo: 1550,
            se: 35,
            lcb: 1480,
            matches: 25,
            settledAt: 100,
            role: 'champion',
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

      // 1. Ingest pending submission v30 -> passes Turn-1 smoke test and retires v10 (lowest LCB)
      const processed = await coord.processPendingSubmissions(
        new Map([['gen9customgame', ladderSnap]])
      );
      expect(processed).toBe(1);
      expect(reportedStatuses).toHaveLength(1);
      expect(reportedStatuses[0].smokeStatus).toBe('passed');
      expect(reportedStatuses[0].retiredVersionIdsByLadder).toEqual({gen9customgame: 10});

      // 2. Register v25 locally with defaultAgentScript and run a scheduled 2-game mirror match
      const v30Local = stateDb.getLocalAgent(30)!;
      const v25Dir = path.join(agentsDir, 'pokechamp-1.0.0-v25');
      fs.mkdirSync(v25Dir, {recursive: true});
      fs.writeFileSync(path.join(v25Dir, 'run'), fs.readFileSync(defaultAgentScript), {
        mode: 0o755,
      });
      stateDb.upsertLocalAgent({
        versionId: 25,
        agentId: 2,
        slug: 'pokechamp',
        version: '1.0.0',
        mode: 'native',
        target: 'pokechamp-1.0.0-v25',
        residency: 'hot',
        unpackedBytes: v30Local.unpackedBytes,
      });

      fs.writeFileSync(utmLogFile, '');
      const matchLadder: LadderSnapshot = {
        ...ladderSnap,
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
          ladderSnap.entries[2],
        ],
      };

      const played = await coord.playNextScheduledMatch([matchLadder]);
      expect(played?.ladderId).toBe('gen9customgame');
      expect(completedMatches).toHaveLength(1);
      expect(completedMatches[0].match.seed).toMatch(/^\d+,\d+,\d+,\d+$/);
      expect(completedMatches[0].match.seed).not.toBe('20,40,66,84');
      expect(heartbeats.length).toBeGreaterThan(0);

      // Verify v30 swapped seats from slot p1 (with T1) in Game 1 to slot p2 (with T2) in Game 2
      const v30UtmLines = fs.readFileSync(utmLogFile, 'utf8').trim().split('\n');
      expect(v30UtmLines).toHaveLength(2);
      expect(v30UtmLines[0]).not.toBe(v30UtmLines[1]);

      // 3. Verify crash recovery: in_progress is aborted, g1_complete resumes Game 2
      stateDb.createMatchCheckpoint({
        id: 'gen9customgame-0000098',
        ladderId: 'gen9customgame',
        format: 'gen9customgame',
        teamMode: 'random',
        p1VersionId: 30,
        p1AgentId: 1,
        p1Slug: 'foul-play',
        p1Name: 'Foul Play',
        p1Version: '3.0.0',
        p1Mode: 'native',
        p1Target: v30Local.target,
        p2VersionId: 25,
        p2AgentId: 2,
        p2Slug: 'pokechamp',
        p2Name: 'PokeChamp',
        p2Version: '1.0.0',
        p2Mode: 'native',
        p2Target: v30Local.target,
        seed: '1,2,3,4',
        p1TeamPacked: TEAM_ONE,
        p2TeamPacked: TEAM_TWO,
        startedAt: 1000,
      });

      stateDb.createMatchCheckpoint({
        id: 'gen9customgame-0000099',
        ladderId: 'gen9customgame',
        format: 'gen9customgame',
        teamMode: 'random',
        p1VersionId: 30,
        p1AgentId: 1,
        p1Slug: 'foul-play',
        p1Name: 'Foul Play',
        p1Version: '3.0.0',
        p1Mode: 'native',
        p1Target: v30Local.target,
        p2VersionId: 25,
        p2AgentId: 2,
        p2Slug: 'pokechamp',
        p2Name: 'PokeChamp',
        p2Version: '1.0.0',
        p2Mode: 'native',
        p2Target: v30Local.target,
        seed: '1,2,3,4',
        p1TeamPacked: TEAM_ONE,
        p2TeamPacked: TEAM_TWO,
        startedAt: 1001,
      });
      stateDb.checkpointGame1Complete({
        id: 'gen9customgame-0000099',
        outcome: 'W',
        turns: 2,
        endReason: 'win',
        p1BankSeconds: 140,
        p2BankSeconds: 138,
        p1Ram: 64,
        p2Ram: 64,
        p1TurnMillis: 15,
        p2TurnMillis: 15,
      });

      const recovered = await coord.recoverIncompleteMatches();
      expect(recovered.aborted).toEqual(['gen9customgame-0000098']);
      expect(recovered.resumed).toEqual(['gen9customgame-0000099']);
      expect(completedMatches).toHaveLength(2);
      expect(stateDb.getMatchCheckpoint('gen9customgame-0000098')?.status).toBe('aborted');
      expect(stateDb.getMatchCheckpoint('gen9customgame-0000099')?.status).toBe('complete');

      stateDb.close();
    }
  );

  test(
    'Coordinator records LW splits against real server HTTP API and evicts 4xx outbox entries',
    async () => {
      const db = new Database(':memory:');
      const stateDb = new StateDatabase(':memory:');
      const app = polka();
      let server: http.Server | undefined;
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
          '  arena:',
          '    qualified: true',
          '    owners:',
          '      scheibo: pre.10544',
          '- name: Foul Play',
          '  active: 2026',
          '  arena:',
          '    qualified: true',
          '    owners:',
          '      pmariglia: pmariglia.535629',
        ].join('\n'));
        const a1 = db.getAgentBySlug('0-error')!;
        const a2 = db.getAgentBySlug('foul-play')!;
        const sub1 = db.createSubmission({
          agentId: a1.id,
          version: '1.0.0',
          package: 'bundle',
          url: 'https://example.com/a1.tar.zst',
          sha256: 'a'.repeat(64),
          ladderIds: ['gen9randombattle202611'],
          tournamentIds: [],
        });
        const sub2 = db.createSubmission({
          agentId: a2.id,
          version: '1.0.0',
          package: 'bundle',
          url: 'https://example.com/a2.tar.zst',
          sha256: 'b'.repeat(64),
          ladderIds: ['gen9randombattle202611'],
          tournamentIds: [],
        });
        db.applySubmissionStatus({versionId: sub1.id, smokeStatus: 'passed', unpackedBytes: 1024});
        db.applySubmissionStatus({versionId: sub2.id, smokeStatus: 'passed', unpackedBytes: 1024});

        const secret = 'real-http-arena-secret-32-bytes-ok';
        const authInst = new auth.Auth({
          config: {sessionSecret: 'session-secret-32-bytes-minimum-ok', arenaSecret: secret},
          db,
        });
        const publicDir = path.join(tmpDir, 'real-http-public');
        fs.mkdirSync(publicDir, {recursive: true});
        serverArena.register(app, {db, auth: authInst, publicDir});

        server = http.createServer((req, res) => app.handler(req as polka.Request, res));
        await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
        const serverUrl = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
        const client = new serverArena.Client({serverUrl, arenaSecret: secret});

        // Script exits 1 in slot p1 and plays legally in slot p2 -> Game 1 = L, Game 2 = W ('LW')
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

        const coord = new Coordinator({
          client,
          stateDb,
          baselineSpec: {mode: 'native', target: process.execPath, args: [defaultAgentScript]},
          agentsDir: path.join(tmpDir, 'lose-as-p1-agents'),
          stagingDir: path.join(tmpDir, 'lose-as-p1-staging'),
          archiveLogsDir: path.join(tmpDir, 'lose-as-p1-logs'),
          devMode: true,
        });

        // Enqueue a permanently malformed 400 outbox entry ahead of match execution to verify
        // flushOutbox evicts permanent 4xx errors instead of wedging the FIFO queue.
        stateDb.enqueueOutbox(
          'match-complete',
          {match: {id: 'bad'}} as unknown as serverArena.MatchCompletePayload
        );

        const snapRes = await fetch(`${serverUrl}/api/arena/ladders`, {
          headers: {Authorization: `Bearer ${secret}`},
        });
        const {ladders} = await snapRes.json() as {ladders: LadderSnapshot[]};
        const played = await coord.playNextScheduledMatch(ladders);
        expect(played?.ladderId).toBe('gen9randombattle202611');
        expect(stateDb.listOutbox()).toHaveLength(0);

        const recorded = db.getRecentMatches(5);
        expect(recorded).toHaveLength(1);
        expect(recorded[0].game1Outcome).toBe('L');
        expect(recorded[0].game2Outcome).toBe('W');
        expect(recorded[0].category).toBe('LW');

        // Also verify `pools` ladder roster serialization (`teams: string[]`) end-to-end via
        // `runDaemon({once: true})` so VGC matches never fail with `rawTeam.trim is not a function`
        db.setLadderStatus('gen9randombattle202611', 'archived');
        db.refundCooldown('0-error');
        db.refundCooldown('foul-play');
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

        const seedStateDb = new StateDatabase(daemonStatePath);
        const slugs = ['0-error', 'foul-play', 'metamon', 'pokechamp'];
        for (let idx = 0; idx < slugs.length; idx++) {
          const ag = db.getAgentBySlug(slugs[idx])!;
          const rawTwenty = mock.generateValidVgcTeams(20, idx);
          const validated = validateCompetitorTeamsIncremental(rawTwenty, {
            format: 'gen9championsvgc2026regmc',
            pools: [],
            teams: 20,
          });
          const sub = db.createSubmission({
            agentId: ag.id,
            version: '2.0.0',
            package: 'bundle',
            url: `https://example.com/${slugs[idx]}.tar.zst`,
            sha256: String(idx + 1).repeat(64),
            ladderIds: ['gen9championsvgc2026regmc'],
            tournamentIds: [],
            teamsByLadder: {gen9championsvgc2026regmc: validated.allSaved},
          });
          db.applySubmissionStatus({
            versionId: sub.id,
            smokeStatus: 'passed',
            unpackedBytes: 1024,
          });
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

        const vgcMatches = db.getRecentMatches(10)
          .filter(m => m.ladderId === 'gen9championsvgc2026regmc');
        expect(vgcMatches).toHaveLength(1);
        expect(vgcMatches[0].p1TeamLabel).toMatch(/^(?:P[12]:)?[0-9a-f]{12}$/);
        expect(vgcMatches[0].p2TeamLabel).toMatch(/^(?:P[12]:)?[0-9a-f]{12}$/);

        // Verify upcoming ladder smoke tests resolve the real format (`gen1ou`, not Gen 9 Custom
        // Game) and tournament-only OCI submissions stay queued for GCP (`target=tournament`).
        db.syncLaddersFromYaml([
          '- name: VGC',
          '  id: gen9championsvgc2026regmc',
          '  format: gen9championsvgc2026regmc',
          '  team: pools',
          '  status: active',
          '  min: 4',
          '  teams: 20',
          '- name: RBY',
          '  id: gen1ou20261109',
          '  format: gen1ou',
          '  team: random',
          '  status: upcoming',
          '  min: 2',
        ].join('\n'));
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
        const gen1Sha = crypto.createHash('sha256').update(fs.readFileSync(gen1Tar)).digest('hex');

        const upcomingSub = db.createSubmission({
          agentId: mewAgent.id,
          version: '3.0.0',
          package: 'bundle',
          url: `file://${gen1Tar}`,
          sha256: gen1Sha,
          ladderIds: ['gen1ou20261109'],
          tournamentIds: [],
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

        const processedUpcoming = await coord.processPendingSubmissions();
        expect(processedUpcoming).toBe(1);
        expect(db.getVersionById(upcomingSub.id)?.smokeStatus).toBe('passed');
        expect(db.getVersionById(tourneySub.id)?.smokeStatus).toBe('pending');

        // GCP TournamentCoordinator validates pending tournament OCI submissions and runs full
        // Round-Robin + Superfinal with live `.log` publication.
        const tourneySubA1 = db.createSubmission({
          agentId: a1.id,
          version: '3.0.0-t9',
          package: 'oci',
          url: 'ghcr.io/pkmn/0-error:3.0.0-t9',
          sha256: 'd'.repeat(64),
          ladderIds: [],
          tournamentIds: ['9'],
        });
        const tourneySubA2 = db.createSubmission({
          agentId: a2.id,
          version: '3.0.0-t9',
          package: 'oci',
          url: 'ghcr.io/pkmn/foul-play:3.0.0-t9',
          sha256: 'e'.repeat(64),
          ladderIds: [],
          tournamentIds: ['9'],
        });
        db.db.prepare('UPDATE tournaments SET games_per_matchup = 2, batch_size = 2 WHERE id = ?')
          .run('9');

        const tourCoord = new TournamentCoordinator({
          client,
          baselineSpec: {
            agentId: '_baseline',
            displayName: 'Baseline',
            vmHost: '127.0.0.1',
            controlSocket: '',
            localCommand: relayBin,
            localArgs: [process.execPath, defaultAgentScript],
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
            localArgs: [process.execPath, defaultAgentScript],
          }),
        });

        const validatedCount = await tourCoord.processPendingSubmissions('9');
        expect(validatedCount).toBe(3);
        expect(db.getVersionById(tourneySub.id)?.smokeStatus).toBe('passed');
        expect(db.getVersionById(tourneySubA1.id)?.smokeStatus).toBe('passed');
        expect(db.getVersionById(tourneySubA2.id)?.smokeStatus).toBe('passed');
        expect(db.getTournamentEntrants('9')).toHaveLength(3);

        db.seedTournamentEntrants('9');
        const tourRun = await tourCoord.runTournament('9');
        expect(tourRun.roundRobinGames).toBe(6);
        expect(tourRun.superfinalGames).toBe(2);
        expect(db.getTournament('9')?.status).toBe('completed');
        const finalEntrants = db.getTournamentEntrants('9');
        expect(finalEntrants.map(e => e.finalRank)).toEqual([1, 2, 3]);
        const tourLogDir = path.join(publicDir, 'arena', 'tournaments', '9');
        expect(fs.readdirSync(tourLogDir).filter(f => f.endsWith('.log'))).toHaveLength(8);
      } finally {
        if (server) {
          server.closeAllConnections();
          await new Promise<void>(resolve => server!.close(() => resolve()));
        }
        stateDb.close();
        db.close();
      }
    }
  );

  test('clears uchg/schg immutable flags and runs limit as pkmn in arena/bin/arena', () => {
    const arenaScript = fs.readFileSync(root('arena', 'bin', 'arena'), 'utf8');
    const setupScript = fs.readFileSync(root('arena', 'scripts', 'setup-arena.sh'), 'utf8');
    const sudoers = fs.readFileSync(root('arena', 'config', 'sudoers'), 'utf8');
    const sandbox = fs.readFileSync(root('arena', 'config', 'sandbox.sb'), 'utf8');
    const limitC = fs.readFileSync(root('arena', 'bin', 'limit.c'), 'utf8');
    expect(arenaScript).toContain('/usr/bin/chflags -R nouchg,nouappend,noschg "$SCRATCH_VOL"');
    expect(arenaScript).toContain('wipe_scratch');
    expect(arenaScript).toContain('exec /opt/arena/bin/limit "$SLOT"');
    expect(arenaScript).toContain('--cpus=10');
    expect(arenaScript).toContain('--memory=14g');
    expect(arenaScript).toContain('--memory-swap=14g');
    expect(setupScript).toContain('--cpus 10');
    expect(setupScript).toContain('--memory 30720');
    expect(setupScript).not.toContain('swapfile');
    expect(sudoers).toContain('/usr/bin/chflags -R nouchg\\,nouappend\\,noschg /Volumes/P1');
    expect(sudoers).toContain('/usr/bin/chflags -R nouchg\\,nouappend\\,noschg /Volumes/P2');
    expect(sandbox).toContain('(deny file-write-flags');
    expect(limitC).toContain('/opt/arena/state/peak_ram_%s');
  });
});
