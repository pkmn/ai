import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {Teams} from '@pkmn/sim';

import * as arbiter from '../arena/arbiter';
import * as coordinator from '../arena/coordinator';
import * as tournament from '../arena/tournament';
import * as serverArena from '../server/arena';
import * as sim from '../server/sim';
import {sampleRandomPair} from '../server/teams';

import {
  OU_TEAM_ONE,
  TEAM_ONE,
  TEAM_TWO,
  getArenaTestBins,
} from './arena-helpers';

describe('TimeSlicedArenaGame', () => {
  let tmpDir: string;
  let defaultAgentScript: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-arena-arb-'));
    ({defaultAgentScript} = getArenaTestBins({relay: false}));
  }, 30_000);

  afterAll(async () => {
    await sim.closeAllWorkers();
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  test('runs sequential @pkmn/sim battles with chat elision plus smoke stop', async () => {
    const heartbeats: arbiter.TurnHeartbeatInfo[] = [];
    const game = new arbiter.TimeSlicedArenaGame({
      format: 'gen9customgame',
      seed: '1,2,3,4',
      p1: {
        spec: {mode: 'native', target: defaultAgentScript},
        teamPacked: TEAM_ONE,
      },
      p2: {
        spec: {mode: 'native', target: defaultAgentScript},
        teamPacked: TEAM_TWO,
      },
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
        'process.stdout.write("/ready\\n");',
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
      p1: {
        spec: {mode: 'native', target: process.execPath, args: [probeScript]},
        teamPacked: pair.t1Packed,
      },
      p2: {
        spec: {mode: 'native', target: process.execPath, args: [probeScript]},
        teamPacked: pair.t2Packed,
      },
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
        'process.stdout.write("/ready\\n");',
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
      p1: {
        spec: {mode: 'native', target: process.execPath, args: [crInjectScript]},
        teamPacked: TEAM_ONE,
      },
      p2: {
        spec: {mode: 'native', target: defaultAgentScript},
        teamPacked: TEAM_TWO,
      },
      smokeStopAfterTurn: 1,
      devMode: true,
    }).run();
    expect(res.endReason).toBe('smoke-complete');
    expect(res.winner).toBe('tie');
  });

  test('forfeits agents after 3 consecutive invalid choices promptly without stalling opponent',
    async () => {
      const threeStrikesScript = path.join(tmpDir, 'three-strikes-fast.js');
      const hangingOpponentScript = path.join(tmpDir, 'hanging-opponent.js');
      fs.writeFileSync(
        threeStrikesScript,
        [
          '#!/usr/bin/env node',
          'const readline = require("readline");',
          'process.stdout.write("/ready\\n");',
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
      fs.writeFileSync(
        hangingOpponentScript,
        [
          '#!/usr/bin/env node',
          'const readline = require("readline");',
          'process.stdout.write("/ready\\n");',
          'const rl = readline.createInterface({input: process.stdin, crlfDelay: Infinity});',
          'rl.on("line", line => {',
          '  if (!line.startsWith("|request|")) return;',
          '  const raw = line.slice(9).trim();',
          '  if (!raw || raw === "null") return;',
          '  const req = JSON.parse(raw);',
          '  if (req.teamPreview) process.stdout.write("/team 123456\\n");',
          '});',
        ].join('\n'),
        {mode: 0o755}
      );
      const started = Date.now();
      const res = await new arbiter.TimeSlicedArenaGame({
        format: 'gen9customgame',
        seed: '1,2,3,4',
        // Turn 1 is wave 2 (`requestCount = 2`), so p2 acts first and triggers strike #3
        // before p1's hanging turn would otherwise stall for 15s.
        p1: {
          spec: {mode: 'native', target: process.execPath, args: [hangingOpponentScript]},
          teamPacked: TEAM_ONE,
        },
        p2: {
          spec: {mode: 'native', target: process.execPath, args: [threeStrikesScript]},
          teamPacked: TEAM_TWO,
        },
        timers: {startingBankSeconds: 15, maxTurnSeconds: 15},
        devMode: true,
      }).run();
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(res.winner).toBe('p1');
      expect(res.endReason).toBe('invalid-choice');
      expect(res.omniscientLog).toContain('|win|Agent A');
      expect(res.omniscientLog).not.toMatch(/\n\|tie(?:\n|$)/);
    });

  test('forfeits crashing agents immediately with crash', async () => {
    const res = await new arbiter.TimeSlicedArenaGame({
      format: 'gen9customgame',
      seed: '1,2,3,4',
      p1: {
        spec: {mode: 'native', target: defaultAgentScript, args: ['--crash']},
        teamPacked: TEAM_ONE,
      },
      p2: {
        spec: {mode: 'native', target: defaultAgentScript},
        teamPacked: TEAM_TWO,
      },
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
        'process.stdout.write("/ready\\n");',
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
      p1: {
        spec: {mode: 'native', target: process.execPath, args: [undoAgentScript]},
        teamPacked: TEAM_ONE,
      },
      p2: {
        spec: {mode: 'native', target: defaultAgentScript},
        teamPacked: TEAM_TWO,
      },
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
      p1: {
        spec: {mode: 'native', target: defaultAgentScript},
        teamPacked: TEAM_ONE,
      },
      p2: {
        spec: {mode: 'native', target: defaultAgentScript},
        teamPacked: TEAM_TWO,
      },
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
      format: 'gen9championsvgc2026regmc@@@Open Team Sheets',
      seed: '1,2,3,4',
      p1: {
        spec: {mode: 'native', target: defaultAgentScript},
        teamPacked: TEAM_ONE,
      },
      p2: {
        spec: {mode: 'native', target: defaultAgentScript},
        teamPacked: TEAM_TWO,
      },
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
        'process.stdout.write("/ready\\n");',
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
      p1: {
        spec: {mode: 'native', target: process.execPath, args: [invalidRetryScript]},
        teamPacked: TEAM_ONE,
      },
      p2: {
        spec: {mode: 'native', target: defaultAgentScript},
        teamPacked: TEAM_TWO,
      },
      timers: {startingBankSeconds: 100, maxTurnSeconds: 150},
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
      p1: {
        spec: {mode: 'native', target: process.execPath, args: [floodScript]},
        teamPacked: TEAM_ONE,
      },
      p2: {
        spec: {mode: 'native', target: defaultAgentScript},
        teamPacked: TEAM_TWO,
      },
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

  test('resolves VGC Timer ruleset from @pkmn/sim format tables', async () => {
    const settings = await sim.getTimerSettings('gen9championsvgc2026regmc@@@!Open Team Sheets');
    expect(settings).toEqual({
      startingSeconds: 420,
      graceSeconds: 90,
      addPerTurnSeconds: 0,
      midTurnIncrementSeconds: 0,
      maxPerTurnSeconds: 55,
      maxFirstTurnSeconds: 90,
      timeoutAutoChoose: true,
      accelerate: false,
    });
  });

  test('resolves standard Singles timer settings from @pkmn/sim format tables', async () => {
    const settings = await sim.getTimerSettings('gen9ou');
    expect(settings).toEqual({
      startingSeconds: 150,
      graceSeconds: 60,
      addPerTurnSeconds: 10,
      midTurnIncrementSeconds: 5,
      maxPerTurnSeconds: 150,
      maxFirstTurnSeconds: 150,
      timeoutAutoChoose: false,
      accelerate: true,
    });
  });

  test('resolves standard Doubles timer settings from @pkmn/sim format tables', async () => {
    const settings = await sim.getTimerSettings('gen9doublesou');
    expect(settings).toEqual({
      startingSeconds: 150,
      graceSeconds: 60,
      addPerTurnSeconds: 25,
      midTurnIncrementSeconds: 5,
      maxPerTurnSeconds: 150,
      maxFirstTurnSeconds: 150,
      timeoutAutoChoose: false,
      accelerate: true,
    });
  });

  test('applies initial grace before draining total bank on first turn', () => {
    const timers = arbiter.resolveClockTimers(
      serverArena.timerSettingsForFormat('gen9championsvgc2026regmc')
    );
    const lastRewarded = {p1: -1, p2: -1};
    const player: arbiter.PlayerClockState = {
      slot: 'p1',
      bankMillis: timers.startingBankMillis + timers.graceMillis,
      hasTakenFirstDecision: false,
      retryingInvalidChoice: false,
    };

    const preview = arbiter.beginTurnClockStep(player, 0, lastRewarded, timers);
    expect(preview.turnAllowanceMillis).toBe(90_000);
    expect(preview.inactiveLine).toBe(
      '|inactive|Time left: 90.0 sec this turn | 420.0 sec total | 90.0 sec grace\n'
    );

    player.bankMillis -= 40_000;
    const turn1 = arbiter.beginTurnClockStep(player, 1, lastRewarded, timers);
    expect(player.bankMillis).toBe(420_000);
    expect(turn1.turnAllowanceMillis).toBe(55_000);
    expect(turn1.inactiveLine).toBe(
      '|inactive|Time left: 55.0 sec this turn | 420.0 sec total | 0.0 sec grace\n'
    );
  });

  test('preserves remaining turn budget across invalid choice retries', () => {
    const timers = arbiter.resolveClockTimers(
      serverArena.timerSettingsForFormat('gen9championsvgc2026regmc')
    );
    const lastRewarded = {p1: -1, p2: -1};
    const player: arbiter.PlayerClockState = {
      slot: 'p1',
      bankMillis: timers.startingBankMillis + timers.graceMillis,
      hasTakenFirstDecision: false,
      retryingInvalidChoice: false,
    };

    const first = arbiter.beginTurnClockStep(player, 0, lastRewarded, timers);
    expect(first.turnAllowanceMillis).toBe(90_000);

    player.bankMillis -= 20_000;
    player.turnRemainingMillis = (player.turnRemainingMillis ?? 0) - 20_000;
    player.retryingInvalidChoice = true;

    const retry = arbiter.beginTurnClockStep(player, 0, lastRewarded, timers);
    expect(retry.turnAllowanceMillis).toBe(70_000);
    expect(retry.inactiveLine).toBe(
      '|inactive|Time left: 70.0 sec this turn | 420.0 sec total | 70.0 sec grace\n'
    );
  });

  test('auto-chooses default on VGC turn timeout while total bank remains', async () => {
    const stallPreviewScript = path.join(tmpDir, 'vgc-stall-preview-agent.js');
    fs.writeFileSync(
      stallPreviewScript,
      [
        '#!/usr/bin/env node',
        'const readline = require("readline");',
        'process.stdout.write("/ready\\n");',
        'const rl = readline.createInterface({input: process.stdin});',
        'rl.on("line", line => {',
        '  if (!line.startsWith("|request|")) return;',
        '  const req = JSON.parse(line.slice("|request|".length));',
        '  if (req.wait || req.teamPreview) return;',
        '  process.stdout.write("default\\n");',
        '});',
      ].join('\n'),
      {mode: 0o755}
    );

    const res = await new arbiter.TimeSlicedArenaGame({
      format: 'gen9championsvgc2026regmc',
      seed: '1,2,3,4',
      p1: {
        spec: {mode: 'native', target: process.execPath, args: [stallPreviewScript]},
        teamPacked: TEAM_ONE,
      },
      p2: {
        spec: {mode: 'native', target: defaultAgentScript},
        teamPacked: TEAM_TWO,
      },
      timers: {startingBankSeconds: 2, maxTurnSeconds: 0.15},
      smokeStopAfterTurn: 1,
      devMode: true,
    }).run();
    expect(res.endReason).toBe('smoke-complete');
    expect(res.turns).toBeGreaterThanOrEqual(2);
  });

  test('forfeits VGC game on timeout when total bank reaches zero', async () => {
    const stallAllScript = path.join(tmpDir, 'vgc-stall-all-agent.js');
    fs.writeFileSync(
      stallAllScript,
      [
        '#!/usr/bin/env node',
        'process.stdout.write("/ready\\n");',
        'setInterval(() => {}, 1000);',
      ].join('\n'),
      {mode: 0o755}
    );

    const res = await new arbiter.TimeSlicedArenaGame({
      format: 'gen9championsvgc2026regmc',
      seed: '1,2,3,4',
      p1: {
        spec: {mode: 'native', target: process.execPath, args: [stallAllScript]},
        teamPacked: TEAM_ONE,
      },
      p2: {
        spec: {mode: 'native', target: defaultAgentScript},
        teamPacked: TEAM_TWO,
      },
      timers: {startingBankSeconds: 0.15, maxTurnSeconds: 0.15},
      devMode: true,
    }).run();
    expect(res.winner).toBe('p2');
    expect(res.endReason).toBe('timeout');
    expect(res.p1.bankSeconds).toBe(0);
  });

  test('alternates first CPU slice across waves', async () => {
    const heartbeats: arbiter.TurnHeartbeatInfo[] = [];
    const res = await new arbiter.TimeSlicedArenaGame({
      format: 'gen9customgame',
      seed: '1,2,3,4',
      p1: {
        spec: {mode: 'native', target: defaultAgentScript},
        teamPacked: TEAM_ONE,
      },
      p2: {
        spec: {mode: 'native', target: defaultAgentScript},
        teamPacked: TEAM_TWO,
      },
      smokeStopAfterTurn: 1,
      devMode: true,
      onTurn: info => {
        heartbeats.push(info);
      },
    }).run();
    expect(res.endReason).toBe('smoke-complete');
    expect(heartbeats.slice(0, 2).map(h => h.phase)).toEqual(['init', 'init']);
    expect(heartbeats.filter(h => h.phase !== 'init').slice(0, 4).map(h => h.activeSlot))
      .toEqual(['p1', 'p2', 'p2', 'p1']);
    expect(heartbeats[0].p1.ram).toBe(64);
    expect(res.p1.peakRam).toBe(64);
  });

  test('forfeits agent that fails to send /ready within grace period', async () => {
    const slowReadyScript = path.join(tmpDir, 'slow-ready-agent.js');
    fs.writeFileSync(
      slowReadyScript,
      '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n',
      {mode: 0o755}
    );
    const heartbeats: arbiter.TurnHeartbeatInfo[] = [];
    const res = await new arbiter.TimeSlicedArenaGame({
      format: 'gen9customgame',
      seed: '1,2,3,4',
      p1: {
        spec: {mode: 'native', target: process.execPath, args: [slowReadyScript]},
        teamPacked: TEAM_ONE,
      },
      p2: {
        spec: {mode: 'native', target: defaultAgentScript},
        teamPacked: TEAM_TWO,
      },
      timers: {readyGraceSeconds: 0.1},
      devMode: true,
      onTurn: info => {
        heartbeats.push(info);
      },
    }).run();
    expect(res.winner).toBe('p2');
    expect(res.endReason).toBe('timeout');
    expect(res.turns).toBe(0);
    expect(heartbeats[0].phase).toBe('init');
    expect(heartbeats[0].activeSlot).toBe('p1');
    expect(sim.getActiveBattleCount()).toBe(0);
  });

  test('records teamPreviewMillis separately from initMillis on team-preview formats',
    async () => {
      const timedScript = path.join(tmpDir, 'timed-telemetry-agent.js');
      const utmOrderLog = path.join(tmpDir, 'utm-order.log');
      fs.writeFileSync(utmOrderLog, '');
      fs.writeFileSync(
        timedScript,
        [
          '#!/usr/bin/env node',
          'const fs = require("fs");',
          'const readline = require("readline");',
          'let readySent = false;',
          'const rl = readline.createInterface({input: process.stdin, crlfDelay: Infinity});',
          'rl.on("line", line => {',
          '  if (line.startsWith("|utm|")) {',
          '    const tag = readySent ? "after\\n" : "before\\n";',
          `    fs.appendFileSync(${JSON.stringify(utmOrderLog)}, tag);`,
          '    return;',
          '  }',
          '  if (!line.startsWith("|request|")) return;',
          '  const raw = line.slice(9).trim();',
          '  if (!raw || raw === "null") return;',
          '  const req = JSON.parse(raw);',
          '  if (req.wait) return;',
          '  if (req.teamPreview) {',
          '    setTimeout(() => process.stdout.write("/team 123456\\n"), 40);',
          '  } else {',
          '    process.stdout.write("default\\n");',
          '  }',
          '});',
          'setTimeout(() => { readySent = true; process.stdout.write("/ready\\n"); }, 35);',
        ].join('\n'),
        {mode: 0o755}
      );

      const ouRes = await new arbiter.TimeSlicedArenaGame({
        format: 'gen9ou',
        seed: '1,2,3,4',
        p1: {
          spec: {mode: 'native', target: process.execPath, args: [timedScript]},
          teamPacked: OU_TEAM_ONE,
        },
        p2: {
          spec: {mode: 'native', target: defaultAgentScript},
          teamPacked: OU_TEAM_ONE,
        },
        smokeStopAfterTurn: 1,
        devMode: true,
      }).run();
      expect(ouRes.endReason).toBe('smoke-complete');
      expect(fs.readFileSync(utmOrderLog, 'utf8').trim()).toBe('after');
      expect(ouRes.p1.initMillis).toBeGreaterThanOrEqual(25);
      expect(ouRes.p1.teamPreviewMillis).toBeGreaterThanOrEqual(30);
      expect(ouRes.p1.meanTurnMillis).toBeLessThan(30);
    });

  test('omits teamPreviewMillis on formats without team preview', async () => {
    const noTpRes = await new arbiter.TimeSlicedArenaGame({
      format: 'gen9randombattle',
      seed: '1,2,3,4',
      p1: {spec: {mode: 'native', target: defaultAgentScript}},
      p2: {spec: {mode: 'native', target: defaultAgentScript}},
      smokeStopAfterTurn: 1,
      devMode: true,
    }).run();
    expect(noTpRes.p1.initMillis).toBeGreaterThan(0);
    expect(noTpRes.p1.teamPreviewMillis).toBeUndefined();
    expect(noTpRes.p1.meanTurnMillis).toBeGreaterThan(0);
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
