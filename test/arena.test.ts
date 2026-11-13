import {execFileSync, spawn} from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {Teams} from '@pkmn/sim';
import {afterAll, beforeAll, describe, expect, test} from 'vitest';

import * as arenaIndex from '../arena';
import {TimeSlicedArenaGame, TurnHeartbeatInfo} from '../arena/arbiter';
import {Coordinator, LadderSnapshot} from '../arena/coordinator';
import {StateDatabase} from '../arena/db';
import {
  HarvestedSideCandidate,
  extractRevealedTeamsFromLog,
  filterAndRankHarvestedTeams,
} from '../arena/harvest';
import {
  computeResidencyMultipliers,
  downloadAndUnpackBundle,
  unpackLocalTarArchive,
} from '../arena/packages';
import {
  ConcurrentTournamentGame,
  buildStratifiedTournamentBook,
  rewriteBlindPlayerNames,
  selectNextTournamentBatch,
} from '../arena/tournament';
import * as serverArena from '../server/arena';
import {sampleRandomPair} from '../server/teams';
import {root} from '../static/util';

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
    execFileSync('clang', [
      '-O2', '-Wall', '-Wextra', '-Werror',
      '-o', limitBin,
      root('arena', 'bin', 'limit.c'),
    ]);

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
        'arena/config/ai.pkmn.arena.plist',
        'arena/config/ai.pkmn.pf.plist',
        'arena/config/ai.pkmn.tunnel.plist',
        'arena/config/pf.anchor',
        'arena/config/sandbox.sb',
        'arena/config/sshd-arena.conf',
        'arena/config/sshd-tunnel.conf',
        'arena/config/storage.conf',
        'arena/config/sudoers',
        'arena/bin/arena',
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
      execFileSync('python3', ['-m', 'py_compile', root('arena/bin/unpack')]);
      expect(typeof arenaIndex.runDaemon).toBe('function');
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
    expect(stderrLines.join('')).toMatch(/ARENA_TURN_MS=\d+/);
    expect(stdoutLines.join('')).toContain('default');
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

      // Reject bundle missing './run'
      const noRunSrc = path.join(tmpDir, 'no-run-src');
      fs.mkdirSync(noRunSrc, {recursive: true});
      fs.writeFileSync(path.join(noRunSrc, 'README.txt'), 'missing run');
      const noRunTar = path.join(tmpDir, 'no-run.tar.gz');
      execFileSync('tar', ['-czf', noRunTar, '-C', noRunSrc, '.']);
      expect(() => unpackLocalTarArchive({
        archivePath: noRunTar,
        destDir: path.join(agentsDir, 'agent-no-run'),
        casDir,
      })).toThrow(/missing required executable/i);
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
    'filterAndRankHarvestedTeams & extractRevealedTeamsFromLog enforce legality and core cap',
    () => {
      const sets1 = Teams.unpack(TEAM_ONE)!;
      const sets2 = Teams.unpack(TEAM_TWO)!;

      const candidates: HarvestedSideCandidate[] = [
      // Below rating floor (1500 < 1650) -> filtered out
        {sets: sets1, elo: 1500, won: true},
        // Duplicate observations of TEAM_ONE above rating floor
        {sets: sets1, elo: 1750, won: true},
        {sets: sets1, elo: 1810, won: true},
        // Observation of TEAM_TWO
        {sets: sets2, elo: 1720, won: false},
        // Incomplete 5-Pokemon team -> filtered out
        {sets: sets1.slice(0, 5), elo: 1900, won: true},
      ];

      const ranked = filterAndRankHarvestedTeams(candidates, {
        formatId: 'gen9customgame',
        gen: 9,
        minElo: 1650,
        targetPoolSize: 20,
      });
      expect(ranked).toHaveLength(2);

      // Pass 1 log extraction test on a synthetic full-reveal Showdown log
      const rawLog = [
        '|player|p1|Alice|1|1780',
        '|player|p2|Bob|2|1740',
        ...sets1.flatMap((s, idx) => [
          `|poke|p1|${s.species}|`,
          `|switch|p1a: ${s.species}|${s.species}, L100|100/100`,
          `|-ability|p1a: ${s.species}|${s.ability}`,
          `|-item|p1a: ${s.species}|${s.item}`,
          ...s.moves.map(m => `|move|p1a: ${s.species}|${m}|p2a: Target`),
          ...(idx === 0 ? ['|-terastallize|p1a: Pikachu|Electric'] : []),
        ]),
        '|win|Alice',
      ].join('\n');

      const extracted = extractRevealedTeamsFromLog(rawLog, 'gen9customgame');
      expect(extracted).toHaveLength(1);
      expect(extracted[0].elo).toBe(1780);
      expect(extracted[0].won).toBe(true);
      expect(extracted[0].sets).toHaveLength(6);
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
      expect(result.omniscientLog).toContain('hello from agent');
      expect(result.omniscientLog).toContain('|player|p1|Agent A|');
      expect(result.omniscientLog).toContain('|player|p2|Agent B|');

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

      // Verify gen9championsvgc2026regmc runs as Doubles with Open Team Sheets and
      // gen9randombattle generates 6-Pokemon teams via @pkmn/randoms
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
      expect(vgcRes.omniscientLog).toContain('|showteam|p1|');
      expect(vgcRes.omniscientLog).toContain('|showteam|p2|');

      // Verify retrying invalid choices does not farm extra bank increments
      const invalidRetryScript = path.join(tmpDir, 'invalid-retry-agent.js');
      fs.writeFileSync(
        invalidRetryScript,
        [
          '#!/usr/bin/env node',
          'const readline = require("readline");',
          'const rl = readline.createInterface({input: process.stdin, crlfDelay: Infinity});',
          'let badCount = 0;',
          'rl.on("line", line => {',
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

      // Verify v30 received T1 in Game 1 and T2 (swapped team) in Game 2
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
});
