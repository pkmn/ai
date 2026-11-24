import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {Teams} from '@pkmn/sim';

import * as arbiter from '../arena/arbiter';
import * as coordinator from '../arena/coordinator';
import * as engine from '../arena/engine';
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

  test('InfoCoalescer throttles live updates to 1 Hz and collapses turn snapshots', async () => {
    let nowMillis = 10_000;
    const broadcasts: Array<{slot: engine.PlayerSlot; win?: number; nodes?: number}> = [];
    const coalescer = new engine.InfoCoalescer({
      intervalMillis: 50,
      now: () => nowMillis,
      onBroadcast: (slot, info) => broadcasts.push({slot, win: info.win, nodes: info.nodes}),
    });

    const interceptP1 = engine.createInfoLineInterceptor('p1', coalescer);
    expect(interceptP1('move 1')).toBe(false);
    expect(interceptP1('/info {"policy":{"move 1":1}}')).toBe(true);
    expect(broadcasts).toEqual([]);

    expect(interceptP1('/info {"win":0.52,"nodes":1000}')).toBe(true);
    expect(broadcasts).toEqual([{slot: 'p1', win: 0.52, nodes: 1000}]);

    nowMillis += 10;
    expect(interceptP1('/info {"win":0.58,"nodes":2500}')).toBe(true);
    expect(interceptP1('/info {"win":0.64,"nodes":5000,"policy":{"move 1":0.9}}')).toBe(true);
    expect(broadcasts).toHaveLength(1);

    nowMillis += 55;
    await new Promise(r => setTimeout(r, 65));
    expect(broadcasts).toEqual([
      {slot: 'p1', win: 0.52, nodes: 1000},
      {slot: 'p1', win: 0.64, nodes: 5000},
    ]);

    const committed = coalescer.commitTurn('p1', 1);
    expect(committed).toEqual({win: 0.64, nodes: 5000});
    expect(coalescer.getWinHistory()).toEqual([{turn: 1, p1: 0.64}]);

    nowMillis += 100;
    expect(interceptP1('/info {"win":0.61,"depth":6,"seldepth":14}')).toBe(true);
    expect(coalescer.commitTurn('p1', 1)).toEqual({win: 0.61, depth: 6, seldepth: 14});
    expect(coalescer.getCommittedByTurn().get(1)?.p1).toEqual({
      win: 0.61,
      depth: 6,
      seldepth: 14,
    });

    coalescer.reset();
    expect(coalescer.getLive('p1')).toBeUndefined();
    expect(coalescer.getWinHistory()).toEqual([]);
    coalescer.dispose();
  });

  test('TimeSlicedArenaGame collapses /info per turn and honors recordAiLogs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-info-arbiter-'));
    try {
      const p1Script = path.join(dir, 'p1-info.js');
      const p2Script = path.join(dir, 'p2-silent.js');
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
          '  const w1 = Math.min(0.9, 0.5 + step * 0.05);',
          '  const w2 = Math.min(0.95, w1 + 0.02);',
          '  process.stdout.write("/info " + ' +
            'JSON.stringify({win: w1, depth: 4, nodes: 500}) + "\\n");',
          '  process.stdout.write("/info " + JSON.stringify({win: w2, depth: 6, seldepth: 12, ' +
            'nodes: 2000, nps: 10000, policy: {default: 1}}) + "\\n");',
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

      const commonOpts = {
        format: 'gen9randombattle',
        seed: '1,2,3,4' as const,
        p1: {spec: {mode: 'native' as const, target: process.execPath, args: [p1Script]}},
        p2: {spec: {mode: 'native' as const, target: process.execPath, args: [p2Script]}},
        smokeStopAfterTurn: 2,
        devMode: true,
      };

      const recorded = await new arbiter.TimeSlicedArenaGame({
        ...commonOpts,
        recordAiLogs: true,
        liveInfo: true,
      }).run();
      const aiLines = recorded.omniscientLog.split('\n').filter(l => l.startsWith('|ai|'));
      expect(aiLines.length).toBeGreaterThanOrEqual(2);
      expect(aiLines.every(l => l.startsWith('|ai|p1|'))).toBe(true);
      expect(aiLines.some(l => l.includes('"depth":4'))).toBe(false);
      expect(aiLines.some(l => l.includes('policy'))).toBe(false);
      expect(aiLines[0]).toContain('"depth":6,"seldepth":12,"nodes":2000,"nps":10000');
      expect(recorded.p1.info?.depth).toBe(6);
      expect(recorded.p2.info).toBeUndefined();
      expect(recorded.winHistory?.length).toBeGreaterThanOrEqual(2);

      const stripped = await new arbiter.TimeSlicedArenaGame({
        ...commonOpts,
        recordAiLogs: false,
        liveInfo: false,
      }).run();
      expect(stripped.omniscientLog).not.toContain('|ai|');
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });

  test('BoundedStderrBuffer preserves head and tail with truncation marker', () => {
    const small = new engine.BoundedStderrBuffer({headBytes: 16, tailBytes: 32});
    small.append('boot ok\nturn 1 ok\n');
    expect(small.truncatedBytes).toBe(0);
    expect(small.format()).toBe('boot ok\nturn 1 ok\n');

    const capped = new engine.BoundedStderrBuffer({headBytes: 16, tailBytes: 24});
    capped.append('HEAD-STARTUP-LOG\n');
    capped.append('M'.repeat(200));
    capped.append('\nTAIL-TRACEBACK-END');
    expect(capped.truncatedBytes).toBeGreaterThan(150);
    const out = capped.format();
    expect(out.startsWith('HEAD-STARTUP-LOG\n... [')).toBe(true);
    expect(out).toContain('bytes truncated] ...');
    expect(out.endsWith('TAIL-TRACEBACK-END')).toBe(true);

    const tailOnly = new engine.BoundedStderrBuffer({headBytes: 0, tailBytes: 12});
    tailOnly.append('0123456789ABCDEF');
    expect(tailOnly.format()).toBe('456789ABCDEF');
  });

  test('BoundedStderrBuffer strips non-whitespace control characters', () => {
    const buf = new engine.BoundedStderrBuffer({headBytes: 32, tailBytes: 32});
    buf.append('ok\x00\x01\x1b[31merr\tval\nnext\r\n');
    expect(buf.format()).toBe('ok[31merr\tval\nnext\r\n');
  });

  test('truncateDiagnosticLog bounds oversized battle logs on newline boundaries', () => {
    const log = 'line-one\nline-two\nline-three\n';
    expect(engine.truncateDiagnosticLog(log, 64)).toBe(log);
    expect(engine.truncateDiagnosticLog(log, 20)).toBe('line-one\nline-two');
  });

  test('createInfoLineInterceptor rejects malformed /info lines', () => {
    const coalescer = new engine.InfoCoalescer({maxIngestsPerTurn: 2});
    const intercept = engine.createInfoLineInterceptor('p1', coalescer);
    expect(intercept('/info not-json')).toBe(false);
    expect(coalescer.getLive('p1')).toBeUndefined();
  });

  test('createInfoLineInterceptor stops intercepting after per-turn cap', () => {
    const coalescer = new engine.InfoCoalescer({maxIngestsPerTurn: 2});
    const intercept = engine.createInfoLineInterceptor('p1', coalescer);
    expect(intercept('/info {"win":0.5}')).toBe(true);
    expect(intercept('/info {"policy":{"move 1":1}}')).toBe(true);
    expect(intercept('/info {"win":0.7}')).toBe(false);
    coalescer.commitTurn('p1', 1);
    expect(intercept('/info {"win":0.8}')).toBe(true);
  });

  test('diagnosticWallCapMillis and protocol error classifier handle formats and buckets', () => {
    expect(engine.diagnosticWallCapMillis('gen1ou')).toBe(10 * 60 * 1000);
    expect(engine.diagnosticWallCapMillis('gen3ou')).toBe(8 * 60 * 1000);
    expect(engine.diagnosticWallCapMillis('gen9ou')).toBe(6 * 60 * 1000);
    expect(engine.diagnosticWallCapMillis('gen9randombattle')).toBe(6 * 60 * 1000);
    expect(engine.diagnosticWallCapMillis('gen9championsvgc2026regmc')).toBe(6 * 60 * 1000);

    const errors = engine.emptyProtocolErrorCounts();
    const state: engine.ProtocolStrikeState = {
      retryingInvalidChoice: false,
      invalidStrikes: 0,
      lastRequestJson: '{"active":[{}]}',
    };
    engine.inspectPlayerProtocolChunk(
      [
        "|error|[Invalid choice] Can't move: Garchomp's Earthquake is disabled",
        "|error|[Invalid choice] Can't switch: You can't switch to a fainted Pokémon",
        '|error|[Invalid choice] Need a target for Dragon Claw',
        '|error|[Invalid choice] Nothing matches "foo"',
        '|error|[Unavailable choice] Encore forces you to use Protect',
      ].join('\n'),
      state,
      false,
      errors
    );
    expect(errors).toEqual({
      invalidCantMove: 1,
      invalidCantSwitch: 1,
      invalidTarget: 1,
      invalidOther: 1,
      unavailableChoices: 1,
    });
  });

  test('classifySmokeGame treats self-play faults on either slot as failure and caps as ok', () => {
    expect(engine.classifySmokeGame(
      {winner: 'tie', endReason: 'diagnostic-cap'},
      {label: 'Diagnostic', format: 'gen1ou', selfPlay: true}
    )).toEqual({kind: 'ok'});

    const p2Fault = engine.classifySmokeGame(
      {winner: 'p1', endReason: 'crash'},
      {label: 'Diagnostic', format: 'gen1ou', selfPlay: true, p2Stderr: 'p2 segfault'}
    );
    expect(p2Fault).toEqual({
      kind: 'fail',
      message: 'Diagnostic failed in gen1ou: crash\np2 segfault',
    });
  });

  test('TimeSlicedArenaGame stops cleanly with diagnostic-cap on outer wall cap', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-diag-cap-'));
    try {
      const slowScript = path.join(dir, 'slow.js');
      fs.writeFileSync(
        slowScript,
        [
          'const rl = require("readline").createInterface({input: process.stdin});',
          'process.stderr.write("PRE_READY_INIT\\n");',
          'process.stdout.write("/ready\\n");',
          'let n = 0;',
          'rl.on("line", line => {',
          '  if (!line.startsWith("|request|")) return;',
          '  const req = JSON.parse(line.slice(9));',
          '  if (req.wait) return;',
          '  n++;',
          '  process.stderr.write("TURN_" + n + "\\n");',
          '  setTimeout(() => process.stdout.write("default\\n"), n === 1 ? 5 : 150);',
          '});',
        ].join('\n'),
        'utf8'
      );
      const spec: arbiter.AgentLaunchSpec = {
        mode: 'native',
        target: process.execPath,
        args: [slowScript],
      };
      const res = await new arbiter.TimeSlicedArenaGame({
        format: 'gen9randombattle',
        seed: '1,2,3,4',
        p1: {spec},
        p2: {spec},
        maxWallMillis: 80,
        stderrCapture: engine.DIAGNOSTIC_STDERR_LIMITS,
        devMode: true,
      }).run();
      expect(res.endReason).toBe('diagnostic-cap');
      expect(res.winner).toBe('tie');
      expect(res.turns).toBeGreaterThanOrEqual(1);
      expect(res.p1.stderr).toContain('PRE_READY_INIT');
      expect(res.p2.stderr).toContain('PRE_READY_INIT');
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });

  test('BoundedStderrBuffer seals head at multi-byte UTF-8 boundary', () => {
    const buf = new engine.BoundedStderrBuffer({headBytes: 6, tailBytes: 10});
    // 'abcd' (4 bytes) + 'é' (2 bytes) = 6, vs 'abcde' (5 bytes) + 'é' (2 bytes) = 7:
    // head only takes 'abcde' (5 bytes) and must seal so later ASCII never leaks before marker.
    buf.append('abcdeé');
    buf.append('1234567890');
    buf.append('Z');
    const out = buf.format();
    expect(out.startsWith('abcde\n... [')).toBe(true);
    expect(out.endsWith('\n234567890Z')).toBe(true);
    expect(buf.truncatedBytes).toBe(3);
  });

  test('InfoCoalescer.clearPending discards uncommitted turn telemetry', () => {
    const coalescer = new engine.InfoCoalescer();
    coalescer.ingest('p1', {win: 0.72, depth: 5});
    coalescer.clearPending('p1');
    expect(coalescer.commitTurn('p1', 1)).toBeUndefined();
    expect(coalescer.getCommittedByTurn().size).toBe(0);
  });
});
