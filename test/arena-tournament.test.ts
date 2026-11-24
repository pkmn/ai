import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import * as tournament from '../arena/tournament';
import * as sim from '../server/sim';
import {sampleRandomPair} from '../server/teams';

import {
  OU_TEAM_ONE,
  TEAM_ONE,
  TEAM_TWO,
  getArenaTestBins,
} from './arena-helpers';

describe('ConcurrentTournamentGame', () => {
  let tmpDir: string;
  let relayBin: string;
  let defaultAgentScript: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-arena-tour-'));
    ({relayBin, defaultAgentScript} = getArenaTestBins());
  }, 30_000);

  afterAll(async () => {
    await sim.closeAllWorkers();
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  test('rewrites blind Agent A/B protocol names to entrant display names', async () => {
    const spectatorChunks: string[] = [];
    const blindRes = await new tournament.ConcurrentGame({
      format: 'gen9customgame',
      seed: '1,2,3,4',
      p1: {
        spec: {
          agentId: 'foul-play',
          displayName: 'Foul Play',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          localCommand: relayBin,
          localArgs: [defaultAgentScript],
        },
        teamPacked: TEAM_ONE,
      },
      p2: {
        spec: {
          agentId: 'pokechamp',
          displayName: 'PokeChamp',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          localCommand: relayBin,
          localArgs: [defaultAgentScript],
        },
        teamPacked: TEAM_TWO,
      },
      maxTurns: 2,
      callbacks: {onSpectatorChunk: chunk => spectatorChunks.push(chunk)},
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
      p1: {
        spec: {
          agentId: 'foul-play',
          displayName: 'Foul Play',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          localCommand: relayBin,
          localArgs: [defaultAgentScript, '--utm', OU_TEAM_ONE],
        },
      },
      p2: {
        spec: {
          agentId: 'pokechamp',
          displayName: 'PokeChamp',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          localCommand: relayBin,
          localArgs: [defaultAgentScript, '--utm', OU_TEAM_ONE],
        },
      },
      maxTurns: 1,
    }).run();
    expect(utmRes.p1.teamPacked).toBeTruthy();
    expect(utmRes.p2.teamPacked).toBeTruthy();
    expect(utmRes.p1.initMillis).toBeGreaterThanOrEqual(1);
    expect(utmRes.p2.initMillis).toBeGreaterThanOrEqual(1);
    expect(utmRes.turns).toBeGreaterThanOrEqual(1);
  });

  test('validates /utm teams on formats with custom @@@ rules', async () => {
    const utmRes = await new tournament.ConcurrentGame({
      format: 'gen9ou@@@Open Team Sheets',
      seed: '1,2,3,4',
      p1: {
        spec: {
          agentId: 'foul-play',
          displayName: 'Foul Play',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          localCommand: relayBin,
          localArgs: [defaultAgentScript, '--utm', OU_TEAM_ONE],
        },
      },
      p2: {
        spec: {
          agentId: 'pokechamp',
          displayName: 'PokeChamp',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          localCommand: relayBin,
          localArgs: [defaultAgentScript, '--utm', OU_TEAM_ONE],
        },
      },
      maxTurns: 1,
    }).run();
    expect(utmRes.p1.teamPacked).toBeTruthy();
    expect(utmRes.p2.teamPacked).toBeTruthy();
    expect(utmRes.turns).toBeGreaterThanOrEqual(1);
    expect(utmRes.omniscientLog).toContain('|showteam|p1|');
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
        'process.stdout.write("/ready\\n");',
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
      p1: {
        spec: {
          agentId: 'foul-play',
          displayName: 'Foul Play',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          localCommand: relayBin,
          localArgs: [process.execPath, probeScript],
        },
        teamPacked: pair.t1Packed,
      },
      p2: {
        spec: {
          agentId: 'pokechamp',
          displayName: 'PokeChamp',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          localCommand: relayBin,
          localArgs: [process.execPath, probeScript],
        },
        teamPacked: pair.t2Packed,
      },
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
      p1: {
        spec: {
          agentId: 'bad-agent',
          displayName: 'Bad Agent',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          localCommand: relayBin,
          localArgs: [process.execPath, badTeamScript],
        },
      },
      p2: {
        spec: {
          agentId: 'pokechamp',
          displayName: 'PokeChamp',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          localCommand: relayBin,
          localArgs: [defaultAgentScript, '--utm', OU_TEAM_ONE],
        },
      },
      maxTurns: 1,
    }).run();
    expect(badRes.winner).toBe('p2');
    expect(badRes.outcome).toBe('L');
    expect(badRes.endReason).toBe('invalid-choice');
    expect(sim.getActiveBattleCount()).toBe(0);
  });

  test('times out BYOT entrant that never sends /utm within ready grace', async () => {
    const readyOnlyScript = path.join(tmpDir, 'byot-ready-only-agent.js');
    fs.writeFileSync(
      readyOnlyScript,
      '#!/usr/bin/env node\n' +
      'process.stdout.write("/ready\\n");\n' +
      'setInterval(() => {}, 1000);\n',
      {mode: 0o755}
    );

    const timeoutRes = await new tournament.ConcurrentGame({
      format: 'gen9ou',
      seed: '1,2,3,4',
      p1: {
        spec: {
          agentId: 'no-utm-agent',
          displayName: 'No Utm Agent',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          localCommand: relayBin,
          localArgs: [process.execPath, readyOnlyScript],
        },
      },
      p2: {
        spec: {
          agentId: 'pokechamp',
          displayName: 'PokeChamp',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          localCommand: relayBin,
          localArgs: [defaultAgentScript, '--utm', OU_TEAM_ONE],
        },
      },
      timers: {readyGraceSeconds: 0.1},
      maxTurns: 1,
    }).run();
    expect(timeoutRes.winner).toBe('p2');
    expect(timeoutRes.outcome).toBe('L');
    expect(timeoutRes.endReason).toBe('timeout');
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
      p1: {
        spec: {
          agentId: 'foul-play',
          displayName: 'Foul Play',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          localCommand: defaultAgentScript,
          localArgs: [],
        },
        teamPacked: TEAM_ONE,
      },
      p2: {
        spec: {
          agentId: 'pokechamp',
          displayName: 'PokeChamp',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          localCommand: process.execPath,
          localArgs: [preemptScript],
        },
        teamPacked: TEAM_TWO,
      },
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
      p1: {
        spec: {
          agentId: 'foul-play',
          displayName: 'Foul Play',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          localCommand: relayBin,
          localArgs: [defaultAgentScript],
        },
        teamPacked: TEAM_ONE,
      },
      p2: {
        spec: {
          agentId: 'pokechamp',
          displayName: 'PokeChamp',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          localCommand: relayBin,
          localArgs: [process.execPath, preemptScript],
        },
        teamPacked: TEAM_TWO,
      },
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
        'process.stdout.write("/ready\\n");',
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
      p1: {
        spec: {
          agentId: 'foul-play',
          displayName: 'Foul Play',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          localCommand: relayBin,
          localArgs: [process.execPath, bo3AgentScript],
        },
        teamPacked: TEAM_ONE,
      },
      p2: {
        spec: {
          agentId: 'pokechamp',
          displayName: 'PokeChamp',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          localCommand: relayBin,
          localArgs: [process.execPath, bo3AgentScript],
        },
        teamPacked: TEAM_TWO,
      },
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
    const p1CommittedGate = path.join(tmpDir, 'p1-committed.gate');
    fs.writeFileSync(
      slowAgentScript,
      [
        '#!/usr/bin/env node',
        'const fs = require("fs");',
        'const readline = require("readline");',
        `const gateFile = ${JSON.stringify(p1CommittedGate)};`,
        'process.stdout.write("/ready\\n");',
        'const rl = readline.createInterface({input: process.stdin, crlfDelay: Infinity});',
        'rl.on("line", line => {',
        '  if (!line.startsWith("|request|")) return;',
        '  const raw = line.slice(9).trim();',
        '  if (!raw || raw === "null") return;',
        '  const req = JSON.parse(raw);',
        '  if (req.wait) return;',
        '  const reply = req.teamPreview ? "/team 1234\\n" : "default\\n";',
        '  const deadline = Date.now() + 2000;',
        '  const waitForGate = () => {',
        '    if (fs.existsSync(gateFile) || Date.now() >= deadline) {',
        '      process.stdout.write(reply);',
        '      return;',
        '    }',
        '    setTimeout(waitForGate, 5);',
        '  };',
        '  waitForGate();',
        '});',
      ].join('\n'),
      {mode: 0o755}
    );

    const chunkSnaps: tournament.TurnBroadcastInfo[] = [];
    const clockChanges: tournament.TurnBroadcastInfo[] = [];

    await new tournament.ConcurrentGame({
      format: 'gen9customgame',
      seed: '1,2,3,4',
      p1: {
        spec: {
          agentId: 'fast-agent',
          displayName: 'Fast Agent',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          localCommand: relayBin,
          localArgs: [defaultAgentScript],
        },
        teamPacked: TEAM_ONE,
      },
      p2: {
        spec: {
          agentId: 'slow-agent',
          displayName: 'Slow Agent',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          localCommand: relayBin,
          localArgs: [process.execPath, slowAgentScript],
        },
        teamPacked: TEAM_TWO,
      },
      maxTurns: 1,
      callbacks: {
        onSpectatorChunk: (_chunk, state) => {
          chunkSnaps.push(structuredClone(state));
        },
        onClockChange: state => {
          clockChanges.push(structuredClone(state));
          if (!state.p1.thinking && state.p2.thinking && !fs.existsSync(p1CommittedGate)) {
            fs.writeFileSync(p1CommittedGate, 'go');
          }
        },
      },
    }).run();

    // At decision wave start, both sides are actively thinking simultaneously
    expect(chunkSnaps.some(s => s.p1.thinking && s.p2.thinking)).toBe(true);
    // When Fast Agent (p1) commits first, onClockChange reports p1 committed while p2 thinks
    expect(clockChanges.some(s => !s.p1.thinking && s.p2.thinking)).toBe(true);
  });

  test('withholds mid-turn increment when both sides force-switch on double KO', async () => {
    const p1Log = path.join(tmpDir, 'double-ko-p1.log');
    const p2Log = path.join(tmpDir, 'double-ko-p2.log');
    fs.writeFileSync(p1Log, '');
    fs.writeFileSync(p2Log, '');
    const makeAgent = (logFile: string, delayMs: number) => {
      const script = path.join(tmpDir, `${path.basename(logFile)}.js`);
      fs.writeFileSync(
        script,
        [
          '#!/usr/bin/env node',
          'const fs = require("fs");',
          'const readline = require("readline");',
          'process.stdout.write("/ready\\n");',
          'const rl = readline.createInterface({input: process.stdin, crlfDelay: Infinity});',
          'let lastReq = null;',
          'rl.on("line", line => {',
          '  if (line.startsWith("|request|")) {',
          '    const raw = line.slice(9).trim();',
          '    if (raw && raw !== "null") lastReq = JSON.parse(raw);',
          '    return;',
          '  }',
          '  if (!line.startsWith("|inactive|Time left:")) return;',
          '  if (!lastReq || lastReq.wait) return;',
          '  const tag = lastReq.teamPreview ? "tp" : lastReq.forceSwitch ? "fs" : "turn";',
          `  fs.appendFileSync(${JSON.stringify(logFile)}, tag + "|" + line + "\\n");`,
          '  const req = lastReq;',
          `  const waitMs = tag === "turn" ? ${delayMs} : 0;`,
          '  const reply = () => process.stdout.write(',
          '    req.teamPreview ? "/team 12\\n" : "default\\n"',
          '  );',
          '  if (waitMs > 0) setTimeout(reply, waitMs);',
          '  else reply();',
          '});',
        ].join('\n'),
        {mode: 0o755}
      );
      return script;
    };
    const boomTeam =
      'Electrode||choiceband|static|explosion|Adamant|,,252,,,252||||100|' +
      ']Pikachu|||static|tackle||||||50|';
    const targetTeam =
      'Caterpie|||shielddust|tackle||||||1|' +
      ']Pikachu|||static|tackle||||||50|';
    const p1Agent = makeAgent(p1Log, 120);
    const p2Agent = makeAgent(p2Log, 120);
    await new tournament.ConcurrentGame({
      format: 'gen9customgame',
      seed: '1,2,3,4',
      timers: {startingBankSeconds: 30, graceSeconds: 0},
      maxTurns: 1,
      p1: {
        spec: {
          agentId: 'boom-p1',
          displayName: 'Boom P1',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          localCommand: relayBin,
          localArgs: [process.execPath, p1Agent],
        },
        teamPacked: boomTeam,
      },
      p2: {
        spec: {
          agentId: 'boom-p2',
          displayName: 'Boom P2',
          vmHost: 'localhost',
          controlSocket: '/tmp/unused',
          localCommand: relayBin,
          localArgs: [process.execPath, p2Agent],
        },
        teamPacked: targetTeam,
      },
    }).run();

    const parseBanks = (file: string) => fs.readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map(l => {
        const [tag, rest] = l.split('|', 2);
        const m = /\|\s*([0-9.]+)\s*sec total/.exec(l.slice(tag.length + 1));
        return {tag, total: m ? Number(m[1]) : NaN, raw: rest};
      });
    for (const file of [p1Log, p2Log]) {
      const entries = parseBanks(file);
      const turnEntry = entries.find(e => e.tag === 'turn');
      const fsEntry = entries.find(e => e.tag === 'fs');
      expect(turnEntry).toBeDefined();
      expect(fsEntry).toBeDefined();
      // Turn 1 spent ~0.4s from 30.0s bank; double-KO forceSwitch must not add +5s back to 30.0s
      expect(fsEntry!.total).toBeLessThan(turnEntry!.total);
    }
  });

  test('ConcurrentGame broadcasts live /info updates and collapses final |ai| logs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-info-tourney-'));
    try {
      const p1Script = path.join(dir, 'p1-tourney.js');
      const p2Script = path.join(dir, 'p2-tourney.js');
      fs.writeFileSync(
        p1Script,
        [
          'const rl = require("readline").createInterface({input: process.stdin});',
          'let step = 0;',
          'process.stdout.write("/ready\\n");',
          'rl.on("line", line => {',
          '  if (!line.startsWith("|request|")) return;',
          '  const req = JSON.parse(line.slice(9));',
          '  if (req.wait) return;',
          '  step++;',
          '  process.stdout.write("/info " + JSON.stringify({win: 0.55, depth: 3}) + "\\n");',
          '  process.stdout.write("/info " + JSON.stringify({win: 0.67, depth: 7, ' +
            'seldepth: 15, nodes: 9500, nps: 45000, policy: {default: 1}}) + "\\n");',
          '  process.stdout.write("default\\n");',
          '});',
        ].join('\n'),
        'utf8'
      );
      fs.writeFileSync(
        p2Script,
        [
          'const rl = require("readline").createInterface({input: process.stdin});',
          'process.stdout.write("/ready\\n");',
          'rl.on("line", line => {',
          '  if (!line.startsWith("|request|")) return;',
          '  const req = JSON.parse(line.slice(9));',
          '  if (req.wait) return;',
          '  process.stdout.write("default\\n");',
          '});',
        ].join('\n'),
        'utf8'
      );

      const pair = sampleRandomPair('gen9randombattle', '1,2,3,4', '5,6,7,8');
      const snaps: tournament.TurnBroadcastInfo[] = [];
      const res = await new tournament.ConcurrentGame({
        format: 'gen9randombattle',
        seed: '1,2,3,4',
        p1: {
          spec: {
            agentId: 'hydra',
            displayName: 'Hydra',
            vmHost: 'localhost',
            controlSocket: path.join(dir, 'p1.sock'),
            localCommand: process.execPath,
            localArgs: [p1Script],
          },
          teamPacked: pair.t1Packed,
        },
        p2: {
          spec: {
            agentId: 'vertex',
            displayName: 'Vertex',
            vmHost: 'localhost',
            controlSocket: path.join(dir, 'p2.sock'),
            localCommand: process.execPath,
            localArgs: [p2Script],
          },
          teamPacked: pair.t2Packed,
        },
        smokeStopAfterTurn: 2,
        callbacks: {
          onSpectatorChunk: (_chunk, snap) => snaps.push(snap),
          onClockChange: snap => snaps.push(snap),
        },
      }).run();

      expect(snaps.some(s => s.p1.info?.win === 0.67 && s.p1.info?.depth === 7)).toBe(true);
      expect(snaps.some(s => (s.winHistory?.length ?? 0) > 0)).toBe(true);
      const aiLines = res.omniscientLog.split('\n').filter(l => l.startsWith('|ai|'));
      expect(aiLines.length).toBeGreaterThanOrEqual(2);
      expect(aiLines.every(l => l.startsWith('|ai|p1|'))).toBe(true);
      expect(aiLines.some(l => l.includes('"depth":3'))).toBe(false);
      expect(aiLines.some(l => l.includes('policy'))).toBe(false);
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });

  test('ConcurrentGame stops cleanly with diagnostic-cap on outer wall cap', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-tourney-wallcap-'));
    try {
      const slowScript = path.join(dir, 'slow-agent.js');
      fs.writeFileSync(
        slowScript,
        [
          'const readline = require("readline");',
          'process.stdout.write("/ready\\n");',
          'const rl = readline.createInterface({input: process.stdin});',
          'rl.on("line", line => {',
          '  if (!line.startsWith("|request|")) return;',
          '  const req = JSON.parse(line.slice(9));',
          '  if (req && req.wait) return;',
          '  setTimeout(() => process.stdout.write("default\\n"), 80);',
          '});',
        ].join('\n'),
        {mode: 0o755}
      );
      const pair = await sim.sampleRandomPair('gen9randombattle', '1,2,3,4', '5,6,7,8');
      const res = await new tournament.ConcurrentGame({
        format: 'gen9randombattle',
        seed: '1,2,3,4',
        bestOf: 1,
        maxWallMillis: 120,
        p1: {
          spec: {
            agentId: 'slow-p1',
            displayName: 'Slow P1',
            vmHost: '127.0.0.1',
            controlSocket: '',
            localCommand: process.execPath,
            localArgs: [slowScript],
          },
          teamPacked: pair.t1Packed,
        },
        p2: {
          spec: {
            agentId: 'slow-p2',
            displayName: 'Slow P2',
            vmHost: '127.0.0.1',
            controlSocket: '',
            localCommand: process.execPath,
            localArgs: [slowScript],
          },
          teamPacked: pair.t2Packed,
        },
      }).run();
      expect(res.endReason).toBe('diagnostic-cap');
      expect(res.outcome).toBe('T');
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });
});
