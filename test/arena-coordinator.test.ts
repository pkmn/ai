import {execFileSync} from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import * as arenaIndex from '../arena';
import * as arbiter from '../arena/arbiter';
import * as coordinator from '../arena/coordinator';
import * as arenaDb from '../arena/db';
import * as engine from '../arena/engine';
import * as packages from '../arena/packages';
import * as tournament from '../arena/tournament';
import * as serverArena from '../server/arena';
import * as sim from '../server/sim';
import * as serverTeams from '../server/teams';
import {root} from '../static/util';

import {
  OU_TEAM_ONE,
  OU_TEAM_TWO,
  TEAM_ONE,
  TEAM_TWO,
  createCoordBundleArchive,
  getArenaTestBins,
  linkOrCopyExecutable,
} from './arena-helpers';

describe('Coordinator', () => {
  let tmpDir: string;
  let defaultAgentScript: string;
  let utmLogFile: string;
  let bundleTar: string;
  let bundleSha: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-arena-coord-'));
    ({defaultAgentScript} = getArenaTestBins({relay: false}));
    utmLogFile = path.join(tmpDir, 'v30-utm.log');
    ({bundleTar, bundleSha} = createCoordBundleArchive(tmpDir, defaultAgentScript, utmLogFile));
  }, 30_000);

  afterAll(async () => {
    await sim.closeAllWorkers();
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  function createMockCoordHarness(
    prefix: string,
    opts?: {
      baselineSpec?: arbiter.AgentLaunchSpec;
      omitSmokeTeams?: boolean;
      recyclePodmanVm?: () =>
        Promise<coordinator.PodmanRecycleResult | void> | coordinator.PodmanRecycleResult | void;
    }
  ) {
    const reportedStatuses: serverArena.SubmissionStatusPayload[] = [];
    const completedMatches: serverArena.MatchCompletePayload[] = [];
    const heartbeats: serverArena.HeartbeatPayload[] = [];
    const alerts: serverArena.StaffAlertPayload[] = [];
    let getLadderTeamsCalls = 0;

    const mockClient = {
      getPendingSubmissions: () => Promise.resolve({
        ladders: opts?.omitSmokeTeams
          ? []
          : [{
            id: 'gen9customgame',
            slot: 'sv' as const,
            name: 'SV',
            format: 'gen9ou',
            team: 'harvested' as const,
            min: 2,
            status: 'active' as const,
            smokeTeams: [OU_TEAM_ONE, OU_TEAM_TWO] as [string, string],
          }],
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
          retiredByLadder: {},
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
      sendAlert: (payload: serverArena.StaffAlertPayload) => {
        alerts.push(payload);
        return Promise.resolve({ok: true as const});
      },
      getLadderTeams: () => {
        getLadderTeamsCalls++;
        return Promise.resolve({
          ladderId: 'gen9customgame',
          format: 'gen9customgame',
          count: 2,
          sha256: 'abc',
          teams: [TEAM_ONE, TEAM_TWO],
        });
      },
    } as unknown as serverArena.Client;

    const stateDb = new arenaDb.Database(':memory:');
    const rootDir = path.join(tmpDir, prefix);
    const dirs = packages.dirsForRoot(rootDir);
    const coord = new coordinator.Coordinator({
      client: mockClient,
      stateDb,
      baselineSpec: opts?.baselineSpec ?? {
        mode: 'native',
        target: defaultAgentScript,
      },
      rootDir,
      devMode: true,
      maxTurns: 1,
      recyclePodmanVm: opts?.recyclePodmanVm,
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
      dirs,
      agentsDir: dirs.agents,
      archiveLogsDir: dirs.logs,
      ladderSnap,
      reportedStatuses,
      completedMatches,
      heartbeats,
      alerts,
      getLadderTeamsCalls: () => getLadderTeamsCalls,
    };
  }

  test('parsePrngSeed throws on malformed or out-of-range PRNG seeds', () => {
    expect(coordinator.parsePrngSeed('1, 2, 3, 4')).toBe('1,2,3,4');
    expect(() => coordinator.parsePrngSeed('bad-seed')).toThrow(/Invalid PRNG seed/);
    expect(() => coordinator.parsePrngSeed('1,2,3')).toThrow(/Invalid PRNG seed/);
    expect(() => coordinator.parsePrngSeed('1,2,3,70000')).toThrow(/Invalid PRNG seed/);
  });

  test('ingests pending bundle submissions through self-play diagnostic smoke test', async () => {
    const h = createMockCoordHarness('smoke');
    try {
      fs.writeFileSync(utmLogFile, '');
      const processed = await h.coord.processPendingSubmissions(
        new Map([['gen9customgame', {...h.ladderSnap, format: 'gen9ou'}]])
      );
      expect(processed).toBe(1);
      expect(h.getLadderTeamsCalls()).toBe(0);
      expect(h.heartbeats).toContainEqual({
        idle: true,
        smokeTesting: {slug: 'foul-play', name: 'Foul Play'},
      });
      expect(h.reportedStatuses).toHaveLength(1);
      expect(h.reportedStatuses[0].smokeStatus).toBe('staged');
      expect(h.reportedStatuses[0].diagnostics).toHaveLength(1);
      expect(h.reportedStatuses[0].diagnostics?.[0].battleLog).toContain('|turn|1');
      const receivedUtms = fs.readFileSync(utmLogFile, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(l => l.split('\t')[1]);
      expect(receivedUtms).toHaveLength(2);
      expect(receivedUtms[0]).not.toBe(receivedUtms[1]);
      expect(serverTeams.extractSpeciesIdsFromPacked(receivedUtms[0], 'gen9ou')).toHaveLength(6);
      expect(serverTeams.extractSpeciesIdsFromPacked(receivedUtms[1], 'gen9ou')).toHaveLength(6);
      // Passed builds stay staged on local SSD (not yet archived in `/Volumes/Archive`).
      expect(h.stateDb.getLocalAgent(30)?.residency).toBe('staged');
      expect(h.stateDb.getLocalAgent(30)?.target).toBe('foul-play-3.0.0-v30');
      expect(
        fs.existsSync(path.join(h.dirs.agents, 'foul-play-3.0.0-v30', 'run'))
      ).toBe(true);
      expect(
        fs.existsSync(path.join(h.dirs.cold, 'foul-play-3.0.0-v30.tar.zst'))
      ).toBe(false);

      // Once activated, syncActivatedAgents promotes & cold-archives locally without re-pulling.
      let artifactFetchCalls = 0;
      const archivedIds: number[] = [];
      (h.coord.client as unknown as {
        getActivatedArtifact: (id: number) => Promise<serverArena.ActivatedArtifact>;
        markArtifactArchived: (id: number) => Promise<{ok: true}>;
      }).getActivatedArtifact = () => {
        artifactFetchCalls++;
        return Promise.reject(new Error('should not re-fetch locally staged bundle'));
      };
      (h.coord.client as unknown as {
        markArtifactArchived: (id: number) => Promise<{ok: true}>;
      }).markArtifactArchived = id => {
        archivedIds.push(id);
        return Promise.resolve({ok: true});
      };
      expect(await h.coord.syncActivatedAgents([30])).toBe(1);
      expect(artifactFetchCalls).toBe(0);
      expect(h.stateDb.getLocalAgent(30)?.residency).toBe('hot');
      expect(
        fs.existsSync(path.join(h.dirs.cold, 'foul-play-3.0.0-v30.tar.zst'))
      ).toBe(true);
      expect(archivedIds).toEqual([30]);
    } finally {
      h.stateDb.close();
    }
  }, 15_000);

  test('aborts harvested smoke test without falling back to harvested ladder pools', async () => {
    const h = createMockCoordHarness('smoke-no-fallback', {omitSmokeTeams: true});
    try {
      await expect(
        h.coord.processPendingSubmissions(
          new Map([['gen9customgame', h.ladderSnap]])
        )
      ).rejects.toThrow(/missing sample team pool/);
      expect(h.getLadderTeamsCalls()).toBe(0);
      expect(h.heartbeats).toEqual([
        {idle: true, smokeTesting: {slug: 'foul-play', name: 'Foul Play'}},
        {idle: true},
      ]);
      expect(h.reportedStatuses).toHaveLength(0);
      expect(h.alerts).toHaveLength(1);
      expect(h.alerts[0].key).toBe('smoke-infra');
      expect(h.alerts[0].detail).toContain('missing sample team pool');
    } finally {
      h.stateDb.close();
    }
  });

  test('clears smokeTesting heartbeat when staging fails after smoke game completes', async () => {
    const h = createMockCoordHarness('smoke-stage-fail');
    h.stateDb.upsertLocalAgent = () => {
      throw new Error('simulated sqlite write failure');
    };
    try {
      await expect(
        h.coord.processPendingSubmissions(
          new Map([['gen9customgame', {...h.ladderSnap, format: 'gen9ou'}]])
        )
      ).rejects.toThrow(/simulated sqlite write failure/);
      expect(h.heartbeats).toEqual([
        {idle: true, smokeTesting: {slug: 'foul-play', name: 'Foul Play'}},
        {idle: true},
      ]);
    } finally {
      h.stateDb.close();
    }
  }, 15_000);

  test('caps processPendingSubmissions to maxSubmissions (default 1) in FIFO order', async () => {
    const rootDir = path.join(tmpDir, 'smoke-cap');
    const stateDb = new arenaDb.Database(':memory:');
    const reported: number[] = [];
    let pendingCalls = 0;
    const queued = [31, 32, 33].map((versionId, idx) => ({
      versionId,
      agentId: idx + 1,
      agentSlug: `agent-${idx + 1}`,
      agentName: `Agent ${idx + 1}`,
      version: '1.0.0',
      package: 'bundle' as const,
      url: `file://${bundleTar}`,
      sha256: bundleSha,
      ladders: ['gen9customgame'],
      tournaments: [],
      teamsByLadder: {},
    }));
    const remaining = [...queued];
    const fakeClient = {
      getPendingSubmissions: () => {
        pendingCalls++;
        return Promise.resolve({ladders: [], submissions: [...remaining]});
      },
      reportSubmissionStatus: (payload: serverArena.SubmissionStatusPayload) => {
        reported.push(payload.versionId);
        const idx = remaining.findIndex(s => s.versionId === payload.versionId);
        if (idx >= 0) remaining.splice(idx, 1);
        return Promise.resolve({
          ok: true as const,
          versionId: payload.versionId,
          smokeStatus: payload.smokeStatus,
          retiredByLadder: {},
        });
      },
      sendHeartbeat: () => Promise.resolve({ok: true as const, updatedAt: 0}),
    } as unknown as serverArena.Client;
    const ladderSnap: coordinator.LadderSnapshot = {
      id: 'gen9customgame',
      slot: 'rand',
      format: 'gen9randombattle',
      team: 'random',
      status: 'active',
      min: 2,
      entries: [],
      pairAggregates: [],
    };
    const coord = new coordinator.Coordinator({
      client: fakeClient,
      stateDb,
      baselineSpec: {mode: 'native', target: defaultAgentScript},
      rootDir,
      devMode: true,
    });
    try {
      // Paused budget skips polling completely.
      expect(await coord.processPendingSubmissions(new Map([['gen9customgame', ladderSnap]]), 0))
        .toBe(0);
      expect(pendingCalls).toBe(0);

      // Default limit processes at most 1 pending submission per call in FIFO order.
      expect(await coord.processPendingSubmissions(new Map([['gen9customgame', ladderSnap]])))
        .toBe(1);
      expect(reported).toEqual([31]);

      // Explicit burst limit processes up to N pending submissions.
      expect(await coord.processPendingSubmissions(new Map([['gen9customgame', ladderSnap]]), 2))
        .toBe(2);
      expect(reported).toEqual([31, 32, 33]);
    } finally {
      stateDb.close();
    }
  });

  test('SmokeCadenceTracker enforces per-cycle limits, N-cycle intervals, or pauses', () => {
    const tracker = new coordinator.SmokeCadenceTracker();

    // Default 1 per 1 cycle runs every tick.
    expect(tracker.budgetForCycle()).toBe(1);
    tracker.recordCycle(1, true);
    expect(tracker.budgetForCycle()).toBe(1);

    // Throttled 1 every 3 cycles: smoke on cycle 1, skip cycles 2-3, smoke on cycle 4.
    const throttled = {maxPerCycle: 1, everyCycles: 3};
    const t2 = new coordinator.SmokeCadenceTracker();
    expect(t2.budgetForCycle(throttled)).toBe(1);
    t2.recordCycle(1, true); // cycle 1
    expect(t2.budgetForCycle(throttled)).toBe(0);
    t2.recordCycle(0, true); // cycle 2
    expect(t2.budgetForCycle(throttled)).toBe(0);
    t2.recordCycle(0, true); // cycle 3
    expect(t2.budgetForCycle(throttled)).toBe(1); // cycle 4

    // When queue was empty on an eligible cycle, next cycle remains immediately eligible.
    t2.recordCycle(0, true);
    expect(t2.budgetForCycle(throttled)).toBe(1);

    // When no ladder match is playable (e.g. pre-launch upcoming), do not delay smoke tests.
    t2.recordCycle(1, false);
    expect(t2.budgetForCycle(throttled)).toBe(1);

    // Paused cadence (0 per cycle) returns 0 even when idle.
    expect(t2.budgetForCycle({maxPerCycle: 0, everyCycles: 1})).toBe(0);

    // Burst cadence returns the dialed-up limit.
    expect(t2.budgetForCycle({maxPerCycle: 4, everyCycles: 1})).toBe(4);
  });

  test('does not floor ladder smoke-test maxPeakRam at 64 MiB', () => {
    const src = fs.readFileSync(root('arena', 'coordinator.ts'), 'utf8');
    expect(src).toContain('maxPeakRam: 0,');
    expect(src).not.toContain('maxPeakRam: 64,');
    const acc: engine.SmokeTelemetry = {maxInitMillis: 0, maxTurnMillis: 0, maxPeakRam: 0};
    engine.recordSmokeTelemetry(acc, {
      initMillis: 25,
      teamPreviewMillis: undefined,
      meanTurnMillis: 3,
      peakRam: 5,
    });
    expect(acc.maxPeakRam).toBe(5);
  });

  test('stages self-play diagnostic without requiring baseline agent', async () => {
    const brokenBaseline = path.join(tmpDir, 'broken-baseline.js');
    fs.writeFileSync(brokenBaseline, 'process.exit(1);\n');
    const h = createMockCoordHarness('selfplay-no-baseline', {
      baselineSpec: {
        mode: 'native',
        target: process.execPath,
        args: [brokenBaseline],
      },
    });
    try {
      expect(
        await h.coord.processPendingSubmissions(
          new Map([['gen9customgame', {...h.ladderSnap, format: 'gen9ou'}]])
        )
      ).toBe(1);
      expect(h.reportedStatuses).toHaveLength(1);
      expect(h.reportedStatuses[0].smokeStatus).toBe('staged');
      expect(h.reportedStatuses[0].diagnostics?.[0].turns).toBeGreaterThanOrEqual(1);
    } finally {
      h.stateDb.close();
    }
  });

  function installLocalAgent(
    h: ReturnType<typeof createMockCoordHarness>,
    opts: {
      versionId: number;
      agentId: number;
      slug: string;
      version: string;
    }
  ): string {
    const target = `${opts.slug}-${opts.version}-v${opts.versionId}`;
    const dir = path.join(h.agentsDir, target);
    fs.mkdirSync(dir, {recursive: true});
    linkOrCopyExecutable(defaultAgentScript, path.join(dir, 'run'));
    h.stateDb.upsertLocalAgent({
      versionId: opts.versionId,
      agentId: opts.agentId,
      slug: opts.slug,
      version: opts.version,
      mode: 'native',
      target,
      residency: 'hot',
      unpackedBytes: 1024,
    });
    return target;
  }

  test('swaps seats plus teams across a 2-game mirror match', async () => {
    const h = createMockCoordHarness('mirror');
    const prevUtmLog = process.env.PKMN_TEST_UTM_LOG;
    process.env.PKMN_TEST_UTM_LOG = utmLogFile;
    try {
      installLocalAgent(h, {
        versionId: 30,
        agentId: 1,
        slug: 'foul-play',
        version: '3.0.0',
      });
      installLocalAgent(h, {versionId: 25, agentId: 2, slug: 'pokechamp', version: '1.0.0'});

      fs.writeFileSync(utmLogFile, '');
      const played = await h.coord.playNextScheduledMatch([h.ladderSnap]);
      expect(played?.ladderId).toBe('gen9customgame');
      expect(h.completedMatches).toHaveLength(1);
      expect(h.completedMatches[0].match.seed).toMatch(/^sodium,[0-9a-f]{64}$/);
      expect(h.heartbeats.length).toBeGreaterThan(0);

      const v30UtmLines = fs.readFileSync(utmLogFile, 'utf8')
        .trim()
        .split('\n')
        .filter(l => l.includes('foul-play-3.0.0-v30'))
        .map(l => l.split('\t')[1]);
      expect(v30UtmLines).toHaveLength(2);
      expect(v30UtmLines[0]).not.toBe(v30UtmLines[1]);

      const g1Beats = h.heartbeats.filter(
        hb => !('idle' in hb) && hb.game === 1
      ) as serverArena.LiveMatchInput[];
      const g2Beats = h.heartbeats.filter(
        hb => !('idle' in hb) && hb.game === 2
      ) as serverArena.LiveMatchInput[];
      expect(g1Beats.length).toBeGreaterThan(0);
      expect(g2Beats.length).toBeGreaterThan(0);
      expect(g1Beats[0].phase).toBe('init');
      expect(g2Beats[0].phase).toBe('init');
      const g1BattleBeats = g1Beats.filter(hb => hb.phase !== 'init');
      const g2BattleBeats = g2Beats.filter(hb => hb.phase !== 'init');
      expect(g1BattleBeats[0].viewer?.lines).toBeUndefined();
      expect(g1BattleBeats[0].viewer?.p1?.pokemon).toHaveLength(6);
      expect(g2BattleBeats[0].viewer?.lines).toBeUndefined();
      expect(g2BattleBeats[0].viewer?.p1?.pokemon).toHaveLength(6);
      expect(g2Beats[0].game1Summary?.endReason).toBeDefined();
      expect(g2Beats[0].game1Summary?.p1?.bankSeconds).toBeGreaterThanOrEqual(0);
      expect(g2Beats[0].game1Summary?.p1?.initMillis).toBeGreaterThan(0);
      expect(g2Beats[0].game1Summary?.p2?.bankSeconds).toBeGreaterThanOrEqual(0);
      expect(g2Beats[0].game1Summary?.viewer?.p1?.pokemon).toHaveLength(6);
    } finally {
      if (prevUtmLog === undefined) delete process.env.PKMN_TEST_UTM_LOG;
      else process.env.PKMN_TEST_UTM_LOG = prevUtmLog;
      h.stateDb.close();
    }
  });

  test('omits |utm| across a 2-game random ladder mirror match', async () => {
    const h = createMockCoordHarness('rand-mirror');
    const prevUtmLog = process.env.PKMN_TEST_UTM_LOG;
    process.env.PKMN_TEST_UTM_LOG = utmLogFile;
    try {
      installLocalAgent(h, {
        versionId: 30,
        agentId: 1,
        slug: 'foul-play',
        version: '3.0.0',
      });
      installLocalAgent(h, {versionId: 25, agentId: 2, slug: 'pokechamp', version: '1.0.0'});

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
      if (prevUtmLog === undefined) delete process.env.PKMN_TEST_UTM_LOG;
      else process.env.PKMN_TEST_UTM_LOG = prevUtmLog;
      h.stateDb.close();
    }
  });

  test('aborts in-progress checkpoints while resuming g1-complete Game 2 with telemetry',
    async () => {
      const h = createMockCoordHarness('recover');
      try {
        const v30Target = installLocalAgent(h, {
          versionId: 30,
          agentId: 1,
          slug: 'foul-play',
          version: '3.0.0',
        });
        const v25Target = installLocalAgent(h, {
          versionId: 25,
          agentId: 2,
          slug: 'pokechamp',
          version: '1.0.0',
        });

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
            target: v30Target,
            teamPacked: TEAM_ONE,
          },
          p2: {
            versionId: 25,
            agentId: 2,
            slug: 'pokechamp',
            name: 'PokeChamp',
            version: '1.0.0',
            mode: 'native',
            target: v25Target,
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
            target: v30Target,
            teamPacked: TEAM_ONE,
          },
          p2: {
            versionId: 25,
            agentId: 2,
            slug: 'pokechamp',
            name: 'PokeChamp',
            version: '1.0.0',
            mode: 'native',
            target: v25Target,
            teamPacked: TEAM_TWO,
          },
          startedAt: 1001,
        });
        h.stateDb.checkpointGame1Complete({
          id: 'gen9customgame-0000099',
          outcome: 'W',
          turns: 2,
          endReason: 'win',
          p1: {
            bankSeconds: 140,
            ram: 64,
            initMillis: 345,
            teamPreviewMillis: 812,
            turnMillis: 15,
          },
          p2: {
            bankSeconds: 138,
            ram: 64,
            initMillis: 456,
            teamPreviewMillis: 923,
            turnMillis: 15,
          },
        });

        const recovered = await h.coord.recoverIncompleteMatches();
        expect(recovered.aborted).toEqual(['gen9customgame-0000098']);
        expect(recovered.resumed).toEqual(['gen9customgame-0000099']);
        expect(h.completedMatches).toHaveLength(1);
        expect(h.completedMatches[0].match.p1Game1InitMillis).toBe(345);
        expect(h.completedMatches[0].match.p1Game1TeamPreviewMillis).toBe(812);
        expect(h.completedMatches[0].match.p2Game1InitMillis).toBe(456);
        expect(h.completedMatches[0].match.p2Game1TeamPreviewMillis).toBe(923);
        expect(h.heartbeats.length).toBeGreaterThan(0);
        expect(
          fs.existsSync(path.join(
            h.archiveLogsDir, 'gen9customgame', '1970-01', '1970-01-01.7z'
          ))
        ).toBe(true);
        expect(h.stateDb.getMatchCheckpoint('gen9customgame-0000098')?.status).toBe('aborted');
        expect(h.stateDb.getMatchCheckpoint('gen9customgame-0000099')?.status).toBe('complete');
      } finally {
        h.stateDb.close();
      }
    });

  test('compressCompletedDays compresses past days into YYYY-MM/YYYY-MM-DD.7z', () => {
    const h = createMockCoordHarness('compress-days');
    try {
      const pastDayDir = path.join(h.archiveLogsDir, 'gen1ou', '2026-11-18');
      const todayDir = path.join(h.archiveLogsDir, 'gen1ou', '2026-11-19');
      fs.mkdirSync(pastDayDir, {recursive: true});
      fs.mkdirSync(todayDir, {recursive: true});
      fs.writeFileSync(path.join(pastDayDir, 'gen1ou-0000001a.log'), '|start\n|win|A\n');
      fs.writeFileSync(path.join(todayDir, 'gen1ou-0000002a.log'), '|start\n|win|B\n');

      expect(h.coord.compressCompletedDays('gen1ou', '2026-11-19')).toBe(true);
      expect(
        fs.existsSync(path.join(h.archiveLogsDir, 'gen1ou', '2026-11', '2026-11-18.7z'))
      ).toBe(true);
      expect(fs.existsSync(pastDayDir)).toBe(false);
      expect(fs.existsSync(path.join(todayDir, 'gen1ou-0000002a.log'))).toBe(true);
    } finally {
      h.stateDb.close();
    }
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

  test('persists auto-quarantine fault counters across coordinator restarts', async () => {
    const h = createMockCoordHarness('fault-restart');
    try {
      const v30Dir = path.join(h.agentsDir, 'foul-play-3.0.0-v30');
      const v25Dir = path.join(h.agentsDir, 'pokechamp-1.0.0-v25');
      fs.mkdirSync(v30Dir, {recursive: true});
      fs.mkdirSync(v25Dir, {recursive: true});
      fs.writeFileSync(path.join(v30Dir, 'run'), '#!/usr/bin/env node\nprocess.exit(1);\n', {
        mode: 0o755,
      });
      linkOrCopyExecutable(defaultAgentScript, path.join(v25Dir, 'run'));
      h.stateDb.upsertLocalAgent({
        versionId: 30,
        agentId: 1,
        slug: 'foul-play',
        version: '3.0.0',
        mode: 'native',
        target: 'foul-play-3.0.0-v30',
        residency: 'hot',
        unpackedBytes: 1024,
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
      // Seed 8 prior consecutive faults persisted before a daemon restart.
      for (let i = 0; i < 8; i++) {
        h.stateDb.recordAgentGameResult(30, true, 1_760_000_000 + i);
      }

      // Instantiate a brand-new Coordinator sharing stateDb (simulating restart/deploy).
      const restartedCoord = new coordinator.Coordinator({
        client: h.coord.client,
        stateDb: h.stateDb,
        rootDir: path.dirname(h.dirs.agents),
        devMode: true,
        maxTurns: 2,
      });
      const played = await restartedCoord.playNextScheduledMatch([h.ladderSnap]);
      expect(played).toBeDefined();

      // Games 9 and 10 both crash -> hits 10 consecutive faults -> auto-quarantined!
      const quarantineReport = h.reportedStatuses.find(
        s => s.versionId === 30 && s.smokeStatus === 'quarantined'
      );
      expect(quarantineReport).toBeDefined();
      expect(quarantineReport?.smokeError).toContain('10/10 faults');
    } finally {
      h.stateDb.close();
    }
  });

  test('resets persisted fault counters after admin unquarantine', async () => {
    const h = createMockCoordHarness('unquarantine-reset');
    try {
      const v30Dir = path.join(h.agentsDir, 'foul-play-3.0.0-v30');
      fs.mkdirSync(v30Dir, {recursive: true});
      linkOrCopyExecutable(defaultAgentScript, path.join(v30Dir, 'run'));
      h.stateDb.upsertLocalAgent({
        versionId: 30,
        agentId: 1,
        slug: 'foul-play',
        version: '3.0.0',
        mode: 'native',
        target: 'foul-play-3.0.0-v30',
        residency: 'hot',
        unpackedBytes: 1024,
      });
      for (let i = 0; i < 10; i++) {
        h.stateDb.recordAgentGameResult(30, true, 1_760_000_000 + i);
      }
      expect(h.stateDb.getLocalAgent(30)?.consecutiveFaults).toBe(10);

      // First poll observes version 30 in server's quarantinedVersionIds (while absent from
      // leaderboard entries, matching GET /api/arena/ladders).
      const snapWithoutV30: coordinator.LadderSnapshot = {
        ...h.ladderSnap,
        entries: h.ladderSnap.entries.filter(e => e.versionId !== 30),
      };
      await h.coord.playNextScheduledMatch([snapWithoutV30], [30]);
      expect(h.stateDb.getLocalAgent(30)?.consecutiveFaults).toBe(10);

      // Admin runs `pkmn unquarantine`: version 30 leaves quarantinedVersionIds and reappears
      // as active (with only 1 local agent installed, no match runs, but faults reset).
      await h.coord.playNextScheduledMatch([h.ladderSnap], []);
      const after = h.stateDb.getLocalAgent(30)!;
      expect(after.totalGames).toBe(0);
      expect(after.totalFaults).toBe(0);
      expect(after.consecutiveFaults).toBe(0);
    } finally {
      h.stateDb.close();
    }
  });

  test('recoverIncompleteMatches resumes Game 2 on persisted custom sim version', async () => {
    const customVer = '0.99.3-resume';
    const customSimDir = root('sim', customVer);
    const simPkgDir = path.join(customSimDir, 'node_modules', '@pkmn', 'sim');
    fs.mkdirSync(simPkgDir, {recursive: true});
    fs.writeFileSync(path.join(customSimDir, 'package.json'), JSON.stringify({name: 'sim-res'}));
    fs.writeFileSync(
      path.join(simPkgDir, 'package.json'),
      JSON.stringify({name: '@pkmn/sim', version: customVer, main: 'index.js'})
    );
    const rootSimEntry = JSON.stringify(root('node_modules', '@pkmn', 'sim'));
    fs.writeFileSync(
      path.join(simPkgDir, 'index.js'),
      [
        `const realSim = require(${rootSimEntry});`,
        "realSim.Dex.formats.extend([{name: '[Gen 9] Resume Custom', mod: 'gen9', " +
          "ruleset: ['Cancel Mod']}]);",
        'module.exports = realSim;',
      ].join('\n')
    );

    const h = createMockCoordHarness('recover-version');
    try {
      const v30Target = installLocalAgent(h, {
        versionId: 30,
        agentId: 1,
        slug: 'foul-play',
        version: '3.0.0',
      });
      const v25Target = installLocalAgent(h, {
        versionId: 25,
        agentId: 2,
        slug: 'pokechamp',
        version: '1.0.0',
      });

      h.stateDb.createMatchCheckpoint({
        id: 'gen9resumecustom-0000001',
        ladderId: 'gen9resumecustom20261109',
        format: 'gen9resumecustom',
        version: customVer,
        teamMode: 'harvested',
        seed: '1,2,3,4',
        p1: {
          versionId: 30,
          agentId: 1,
          slug: 'foul-play',
          name: 'Foul Play',
          version: '3.0.0',
          mode: 'native',
          target: v30Target,
          teamPacked: TEAM_ONE,
        },
        p2: {
          versionId: 25,
          agentId: 2,
          slug: 'pokechamp',
          name: 'PokeChamp',
          version: '1.0.0',
          mode: 'native',
          target: v25Target,
          teamPacked: TEAM_TWO,
        },
        startedAt: 1000,
      });
      h.stateDb.checkpointGame1Complete({
        id: 'gen9resumecustom-0000001',
        outcome: 'W',
        turns: 2,
        endReason: 'win',
        p1: {bankSeconds: 140, ram: 200, turnMillis: 50},
        p2: {bankSeconds: 140, ram: 200, turnMillis: 50},
      });

      // Fresh Coordinator with empty versionByLadderId must resume Game 2 using cp.version.
      const freshCoord = new coordinator.Coordinator({
        client: h.coord.client,
        stateDb: h.stateDb,
        rootDir: path.dirname(h.dirs.agents),
        devMode: true,
        maxTurns: 2,
      });
      const rec = await freshCoord.recoverIncompleteMatches();
      expect(rec).toEqual({aborted: [], resumed: ['gen9resumecustom-0000001']});
      expect(h.completedMatches).toHaveLength(1);
    } finally {
      h.stateDb.close();
      await sim.closeWorker(customVer);
      fs.rmSync(customSimDir, {recursive: true, force: true});
    }
  });

  test('completeGameWithRetry strips logs on 413 Payload Too Large', async () => {
    const received: serverArena.TournamentGameCompletePayload[] = [];
    const fakeClient = {
      completeTournamentGame: (
        _id: string,
        payload: serverArena.TournamentGameCompletePayload
      ) => {
        received.push(payload);
        if (payload.logs !== undefined) {
          return Promise.reject(Object.assign(new Error('Payload Too Large'), {status: 413}));
        }
        return Promise.resolve({ok: true, duplicate: false, completedGames: 1});
      },
    } as unknown as serverArena.Client;
    const tourCoord = new tournament.Coordinator({
      client: fakeClient,
      baselineSpec: {
        agentId: '_baseline',
        displayName: 'Baseline',
        vmHost: '127.0.0.1',
        controlSocket: '',
        localCommand: defaultAgentScript,
        localArgs: [],
      },
    });
    const res = await tourCoord.completeGameWithRetry('1', {
      game: {
        id: 'tour1-g0001',
        stage: 'Round Robin',
        cycle: 1,
        matchupGame: 1,
        outcome: 'W',
        p1: {versionId: 1},
        p2: {versionId: 2},
        games: [{
          gameNumber: 1,
          seed: '1,2,3,4',
          outcome: 'W',
          turns: 5,
          endReason: 'win',
          p1: {bankSeconds: 140, meanTurnMillis: 100, peakRam: 128},
          p2: {bankSeconds: 140, meanTurnMillis: 100, peakRam: 128},
        }],
        completedAt: 1_760_000_000,
      },
      logs: ['|turn|1\n'],
    });
    expect(res.ok).toBe(true);
    expect(received).toHaveLength(2);
    expect(received[0].logs).toEqual(['|turn|1\n']);
    expect(received[1].logs).toBeUndefined();
  });

  test('prunes orphaned CAS blobs and surfaces 4 KiB stderr tail on failed smoke tests',
    async () => {
      const srcDir = path.join(tmpDir, 'bad-cas-src');
      fs.mkdirSync(srcDir, {recursive: true});
      const prefix = 'x'.repeat(400);
      const sentinel = 'RuntimeError: final traceback line preserved';
      fs.writeFileSync(
        path.join(srcDir, 'run'),
        `#!/bin/sh\nprintf '%s\\n%s\\n' '${prefix}' '${sentinel}' >&2\nexit 1\n`,
        {mode: 0o755}
      );
      fs.writeFileSync(path.join(srcDir, 'weights.bin'), Buffer.alloc(96 * 1024, 0x5a));
      const badTar = path.join(tmpDir, 'bad-cas.tar.gz');
      execFileSync('tar', ['-czf', badTar, '-C', srcDir, '.']);
      const badSha = crypto.createHash('sha256').update(fs.readFileSync(badTar)).digest('hex');

      const h = createMockCoordHarness('cas-prune-smoke');
      try {
        (h.coord.client as unknown as {
          getPendingSubmissions: () => Promise<serverArena.PendingSubmissionsResponse>;
        }).getPendingSubmissions = () => Promise.resolve({
          ladders: [{
            id: 'gen9customgame',
            slot: 'sv' as const,
            name: 'SV',
            format: 'gen9ou',
            team: 'harvested' as const,
            min: 2,
            status: 'active' as const,
            smokeTeams: [OU_TEAM_ONE, OU_TEAM_TWO],
          }],
          submissions: [{
            versionId: 31,
            agentId: 1,
            agentSlug: 'foul-play',
            agentName: 'Foul Play',
            version: '3.1.0',
            package: 'bundle' as const,
            url: `file://${badTar}`,
            sha256: badSha,
            ladders: ['gen9customgame'],
            tournaments: [],
            teamsByLadder: {},
          }],
        });
        await h.coord.processPendingSubmissions(
          new Map([['gen9customgame', {...h.ladderSnap, format: 'gen9ou'}]])
        );
        expect(h.reportedStatuses).toHaveLength(1);
        expect(h.reportedStatuses[0].smokeStatus).toBe('failed');
        expect(h.reportedStatuses[0].smokeError).toContain(sentinel);
        expect(fs.readdirSync(h.dirs.agents)).toEqual([]);
        const refsDir = path.join(h.dirs.cas, 'refs');
        expect(fs.existsSync(refsDir) ? fs.readdirSync(refsDir) : []).toEqual([]);
        const shardDirs = fs.existsSync(h.dirs.cas)
          ? fs.readdirSync(h.dirs.cas).filter(name => name !== 'refs')
          : [];
        expect(shardDirs).toEqual([]);
      } finally {
        h.stateDb.close();
      }
    });

  test('flushOutbox publishes ladder archive when match-complete archives ladder', async () => {
    const h = createMockCoordHarness('outbox-archive');
    const uploaded: string[] = [];
    try {
      const dayDir = path.join(h.archiveLogsDir, 'gen9rand', '2026-11-18');
      fs.mkdirSync(dayDir, {recursive: true});
      fs.writeFileSync(path.join(dayDir, 'gen9rand-0000001a.log'), '|start\n|win|A\n');

      (h.coord.client as unknown as {
        completeMatch: () => Promise<{ok: true; duplicate: false; archivedLadder: boolean}>;
        uploadLadderArchive: (id: string, bytes: Buffer) => Promise<{ok: true}>;
      }).completeMatch = () => Promise.resolve({
        ok: true,
        duplicate: false,
        archivedLadder: true,
      });
      (h.coord.client as unknown as {
        uploadLadderArchive: (id: string, bytes: Buffer) => Promise<{ok: true}>;
      }).uploadLadderArchive = (id: string) => {
        uploaded.push(id);
        return Promise.resolve({ok: true});
      };

      h.stateDb.enqueueOutbox('match-complete', {
        match: {
          id: 'gen9rand-0000001',
          ladderId: 'gen9rand',
          p1VersionId: 30,
          p2VersionId: 25,
          seed: '1,2,3,4',
          game1Outcome: 'W',
          game2Outcome: 'W',
          category: 'WW',
          game1Turns: 5,
          game2Turns: 5,
          game1EndReason: 'win',
          game2EndReason: 'win',
          p1Game1PeakRam: 64,
          p1Game2PeakRam: 64,
          p2Game1PeakRam: 64,
          p2Game2PeakRam: 64,
          p1Game1BankSeconds: 140,
          p1Game2BankSeconds: 140,
          p2Game1BankSeconds: 140,
          p2Game2BankSeconds: 140,
          p1Game1InitMillis: 10,
          p1Game2InitMillis: 10,
          p2Game1InitMillis: 10,
          p2Game2InitMillis: 10,
          p1Game1MeanTurnMillis: 10,
          p1Game2MeanTurnMillis: 10,
          p2Game1MeanTurnMillis: 10,
          p2Game2MeanTurnMillis: 10,
          completedAt: 1_760_000_000,
        },
        game1Log: '|start\n|win|A\n',
        game2Log: '|start\n|win|A\n',
      });

      expect(await h.coord.flushOutbox()).toBe(1);
      expect(uploaded).toEqual(['gen9rand']);
    } finally {
      h.stateDb.close();
    }
  });

  test('playNextScheduledMatch compresses completed days on idle active ladders', async () => {
    const h = createMockCoordHarness('idle-day-rollover');
    try {
      const pastDayDir = path.join(h.archiveLogsDir, 'gen9customgame', '2020-01-01');
      fs.mkdirSync(pastDayDir, {recursive: true});
      fs.writeFileSync(path.join(pastDayDir, 'gen9customgame-0000001a.log'), '|start\n|win|A\n');

      // Zero local agents registered -> ladder is idle and schedules no match.
      const played = await h.coord.playNextScheduledMatch([h.ladderSnap]);
      expect(played).toBeUndefined();
      expect(
        fs.existsSync(path.join(h.archiveLogsDir, 'gen9customgame', '2020-01', '2020-01-01.7z'))
      ).toBe(true);
      expect(fs.existsSync(pastDayDir)).toBe(false);
    } finally {
      h.stateDb.close();
    }
  });

  test('archive.sh writes monthly tarballs atomically via temporary file', () => {
    const script = fs.readFileSync(root('arena', 'scripts', 'archive.sh'), 'utf8');
    const tmpIdx = script.search(/TMP_TAR=".*TAR_PATH.*\.tmp\.\$\$"/);
    const tarIdx = script.indexOf('tar -cf "$TMP_TAR" -C "$LADDER_DIR" "$PREV_MONTH"');
    const mvIdx = script.indexOf('mv -f "$TMP_TAR" "$TAR_PATH"');
    const rmIdx = script.search(/rm -rf ".*LADDER_DIR.*PREV_MONTH.*"/);
    expect(tmpIdx).toBeGreaterThan(0);
    expect(tarIdx).toBeGreaterThan(tmpIdx);
    expect(mvIdx).toBeGreaterThan(tarIdx);
    expect(rmIdx).toBeGreaterThan(mvIdx);
  });

  test('archive.sh stages SQLite backup and zstd compression outside /Volumes/Archive', () => {
    const script = fs.readFileSync(root('arena', 'scripts', 'archive.sh'), 'utf8');
    const stageIdx = script.indexOf('STAGE_DIR="/Volumes/Staging"');
    const backupIdx = script.search(/\.backup '.*ESCAPED_TMP_DB.*'/);
    const zstdIdx = script.indexOf('zstd -19 --rm -f "$TMP_DB"');
    const cpIdx = script.search(/cp ".*TMP_DB.*\.zst" "\$TMP_ZST"/);
    const mvIdx = script.indexOf('mv -f "$TMP_ZST" "$OUT_ZST"');
    expect(stageIdx).toBeGreaterThan(0);
    expect(backupIdx).toBeGreaterThan(stageIdx);
    expect(zstdIdx).toBeGreaterThan(backupIdx);
    expect(cpIdx).toBeGreaterThan(zstdIdx);
    expect(mvIdx).toBeGreaterThan(cpIdx);
  });

  test('archive.sh verifies today backup reached GCS after gcloud storage rsync', () => {
    const script = fs.readFileSync(root('arena', 'scripts', 'archive.sh'), 'utf8');
    const rsyncIdx = script.search(/gcloud storage rsync -r "\$BACKUP_DIR"/);
    const lsIdx = script.search(
      /gcloud storage ls ".*GCS_BUCKET.*\/db-backups\/.*BACKUP_NAME.*"/
    );
    expect(rsyncIdx).toBeGreaterThan(0);
    expect(lsIdx).toBeGreaterThan(rsyncIdx);
  });

  test('archive.sh posts failure alert to /api/arena/alert on non-zero exit', () => {
    const script = fs.readFileSync(root('arena', 'scripts', 'archive.sh'), 'utf8');
    expect(script).toContain('trap on_exit EXIT');
    expect(script).toContain('/api/arena/alert');
    expect(script).toContain('key: "arena-archive"');
  });

  test('maintenance.sh coordinates maintenance.lock against match.lock before archiving', () => {
    const script = fs.readFileSync(root('arena', 'scripts', 'maintenance.sh'), 'utf8');
    const maintIdx = script.search(/mv -f ".*MAINT_LOCK.*\.tmp\.\$\$" "\$MAINT_LOCK"/);
    const waitIdx = script.indexOf('while [[ -f "$MATCH_LOCK" ]]; do');
    const archiveIdx = script.search(/".*SCRIPT_DIR.*\/archive\.sh"/);
    const swIdx = script.indexOf('"/usr/sbin/softwareupdate"');
    expect(maintIdx).toBeGreaterThan(0);
    expect(waitIdx).toBeGreaterThan(maintIdx);
    expect(archiveIdx).toBeGreaterThan(waitIdx);
    expect(swIdx).toBeGreaterThan(archiveIdx);
    expect(script).toContain('timeout: 120_000');
    expect(script).toContain("trap 'exit 143' TERM");
    expect(script).not.toContain('ARENA_STATE_DIR');
    expect(script).not.toContain('ARENA_MAINT_WAIT_SECONDS');

    const setupScript = fs.readFileSync(root('arena', 'scripts', 'setup-arena.sh'), 'utf8');
    expect(setupScript).toContain('launchctl bootout system/ai.pkmn.archive');
    const deployScript = fs.readFileSync(root('arena', 'scripts', 'deploy.sh'), 'utf8');
    expect(deployScript).toContain('[ ! -f "$dst" ] || ! cmp -s "$src" "$dst"');
    expect(deployScript).toContain('ai.pkmn.archive.plist');

    const archiveScript = fs.readFileSync(root('arena', 'scripts', 'archive.sh'), 'utf8');
    expect(archiveScript).not.toContain('softwareupdate');

    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-maint-lock-'));
    try {
      expect(arenaIndex.isMaintenanceLockActive(stateDir)).toBe(false);
      fs.writeFileSync(path.join(stateDir, 'maintenance.lock'), `${process.pid}\n`);
      expect(arenaIndex.isMaintenanceLockActive(stateDir)).toBe(true);

      // Stale lock from a dead PID is cleared automatically.
      fs.writeFileSync(path.join(stateDir, 'maintenance.lock'), '99999999\n');
      expect(arenaIndex.isMaintenanceLockActive(stateDir)).toBe(false);
      expect(fs.existsSync(path.join(stateDir, 'maintenance.lock'))).toBe(false);

      // Match lock writes current PID and releases only for its own PID.
      arenaIndex.acquireMatchLock(stateDir, process.pid);
      expect(fs.readFileSync(path.join(stateDir, 'match.lock'), 'utf8').trim())
        .toBe(String(process.pid));
      arenaIndex.releaseMatchLock(stateDir, process.pid + 1);
      expect(fs.existsSync(path.join(stateDir, 'match.lock'))).toBe(true);
      arenaIndex.releaseMatchLock(stateDir, process.pid);
      expect(fs.existsSync(path.join(stateDir, 'match.lock'))).toBe(false);
    } finally {
      fs.rmSync(stateDir, {recursive: true, force: true});
    }
  });

  test('timerSettingsForFormat respects custom VGC Timer rules', () => {
    const customVgc = serverArena.timerSettingsForFormat('gen9doublesou', ['VGC Timer']);
    expect(customVgc.startingSeconds).toBe(420);
    expect(customVgc.addPerTurnSeconds).toBe(0);
    expect(customVgc.timeoutAutoChoose).toBe(true);

    const negatedVgc = serverArena.timerSettingsForFormat(
      'gen9championsvgc2026regmc',
      ['!VGC Timer']
    );
    expect(negatedVgc.startingSeconds).toBe(150);
    expect(negatedVgc.addPerTurnSeconds).toBe(25);
    expect(negatedVgc.timeoutAutoChoose).toBe(false);
  });

  test('flushOutbox strips diagnostics on 413 for submission-status', async () => {
    const h = createMockCoordHarness('outbox-413');
    const seen: serverArena.SubmissionStatusPayload[] = [];
    const origReport = h.coord.client.reportSubmissionStatus.bind(h.coord.client);
    h.coord.client.reportSubmissionStatus = (payload: serverArena.SubmissionStatusPayload) => {
      seen.push(payload);
      if (payload.diagnostics?.length) {
        return Promise.reject(Object.assign(new Error('Payload Too Large'), {status: 413}));
      }
      return origReport(payload);
    };
    try {
      h.stateDb.enqueueOutbox('submission-status', {
        versionId: 42,
        smokeStatus: 'staged',
        diagnostics: [{
          ladderId: 'gen1ou20261109',
          format: 'gen1ou',
          turns: 10,
          endReason: 'win',
          durationMillis: 500,
          battleLog: '|turn|1\n',
        }],
      });
      const flushed = await h.coord.flushOutbox();
      expect(flushed).toBe(1);
      expect(h.stateDb.listOutbox()).toHaveLength(0);
      expect(seen).toHaveLength(2);
      expect(seen[0].diagnostics).toHaveLength(1);
      expect(seen[1].diagnostics).toBeUndefined();
    } finally {
      h.stateDb.close();
    }
  });

  test('syncActivatedAgents omits local_agents row when cold archival fails', async () => {
    const h = createMockCoordHarness('sync-cold-fail');
    try {
      // Replace cold dir with a regular file so archiveColdAgent throws.
      fs.mkdirSync(path.dirname(h.dirs.cold), {recursive: true});
      fs.rmSync(h.dirs.cold, {recursive: true, force: true});
      fs.writeFileSync(h.dirs.cold, 'not-a-directory');

      let archivedCalls = 0;
      h.coord.client.getActivatedArtifact = (versionId: number) => Promise.resolve({
        versionId,
        agentId: 10,
        agentSlug: 'alpha',
        agentName: 'Alpha',
        version: '1.0',
        package: 'bundle',
        url: `file://${bundleTar}`,
        sha256: bundleSha,
      });
      h.coord.client.markArtifactArchived = () => {
        archivedCalls++;
        return Promise.resolve({ok: true as const});
      };

      const installed = await h.coord.syncActivatedAgents([99]);
      expect(installed).toBe(0);
      expect(archivedCalls).toBe(0);
      expect(h.stateDb.getLocalAgent(99)).toBeUndefined();
      expect(fs.existsSync(path.join(h.dirs.agents, 'alpha-1.0-v99'))).toBe(false);
    } finally {
      h.stateDb.close();
    }
  });

  test('tryAcquireMatchLock yields without leaving match.lock when maintenance is active', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-dekker-lock-'));
    try {
      expect(arenaIndex.tryAcquireMatchLock(stateDir, process.pid)).toBe(true);
      expect(fs.existsSync(path.join(stateDir, 'match.lock'))).toBe(true);
      arenaIndex.releaseMatchLock(stateDir, process.pid);

      fs.writeFileSync(path.join(stateDir, 'maintenance.lock'), `${process.pid}\n`);
      expect(arenaIndex.tryAcquireMatchLock(stateDir, process.pid)).toBe(false);
      expect(fs.existsSync(path.join(stateDir, 'match.lock'))).toBe(false);
    } finally {
      fs.rmSync(stateDir, {recursive: true, force: true});
    }
  });

  test('isDeployLockActive reports live deploy.lock PID', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-deploy-lock-'));
    try {
      expect(arenaIndex.isDeployLockActive(stateDir)).toBe(false);
      fs.writeFileSync(path.join(stateDir, 'deploy.lock'), `${process.pid}\n`);
      expect(arenaIndex.isDeployLockActive(stateDir)).toBe(true);
      expect(arenaIndex.isPauseLockActive(stateDir)).toBe(true);
    } finally {
      fs.rmSync(stateDir, {recursive: true, force: true});
    }
  });

  test('isDeployLockActive clears stale deploy.lock PID', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-deploy-stale-'));
    try {
      fs.writeFileSync(path.join(stateDir, 'deploy.lock'), '99999999\n');
      expect(arenaIndex.isDeployLockActive(stateDir)).toBe(false);
      expect(fs.existsSync(path.join(stateDir, 'deploy.lock'))).toBe(false);
    } finally {
      fs.rmSync(stateDir, {recursive: true, force: true});
    }
  });

  test('tryAcquireMatchLock yields without leaving match.lock when deploy.lock is active', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-deploy-dekker-'));
    try {
      fs.writeFileSync(path.join(stateDir, 'deploy.lock'), `${process.pid}\n`);
      expect(arenaIndex.tryAcquireMatchLock(stateDir, process.pid)).toBe(false);
      expect(fs.existsSync(path.join(stateDir, 'match.lock'))).toBe(false);
    } finally {
      fs.rmSync(stateDir, {recursive: true, force: true});
    }
  });

  test('deploy.sh waits for active locks under deploy.lock before mutating', () => {
    const script = fs.readFileSync(root('arena', 'scripts', 'deploy.sh'), 'utf8');
    const fetchIdx = script.indexOf('git fetch origin main');
    const lockIdx = script.search(/mv -f ".*DEPLOY_LOCK.*\.tmp\.\$\$" "\$DEPLOY_LOCK"/);
    const matchWaitIdx = script.indexOf('if [[ -f "$MATCH_LOCK" ]]; then');
    const maintWaitIdx = script.indexOf('if [[ -z "$BLOCKER" && -f "$MAINT_LOCK" ]]; then');
    const mergeIdx = script.indexOf('git merge --ff-only origin/main');
    const compileIdx = script.indexOf('npm run compile');
    const sigIdx = script.indexOf('launchctl kill SIGUSR1 system/ai.pkmn.arena');
    expect(fetchIdx).toBeGreaterThan(0);
    expect(lockIdx).toBeGreaterThan(fetchIdx);
    expect(matchWaitIdx).toBeGreaterThan(lockIdx);
    expect(maintWaitIdx).toBeGreaterThan(matchWaitIdx);
    expect(mergeIdx).toBeGreaterThan(maintWaitIdx);
    expect(compileIdx).toBeGreaterThan(mergeIdx);
    expect(sigIdx).toBeGreaterThan(compileIdx);
    expect(script).toContain('trap cleanup EXIT');
    expect(script).toContain("trap 'exit 143' TERM");
    expect(script).toContain("trap 'exit 130' INT");
    expect(script).toContain("trap 'exit 129' HUP");
    expect(script).not.toContain('ARENA_STATE_DIR');
  });

  test('deploy.sh gates compilation on NEEDS_COMPILE including transitive Arena files', () => {
    const script = fs.readFileSync(root('arena', 'scripts', 'deploy.sh'), 'utf8');
    const restartBlockStart = script.indexOf('NEEDS_RESTART=0');
    const compileCheckIdx = script.indexOf('NEEDS_COMPILE=0');
    const restartBlock = script.slice(restartBlockStart, compileCheckIdx);
    expect(restartBlock).toContain('static/dom.ts');
    expect(restartBlock).toContain('static/build.tsx');
    expect(restartBlock).toContain('tsconfig.json');
    const compileGateIdx = script.lastIndexOf('if [ "$NEEDS_COMPILE" -ne 0 ]; then');
    const compileIdx = script.indexOf('npm run compile');
    expect(compileGateIdx).toBeGreaterThan(compileCheckIdx);
    expect(compileIdx).toBeGreaterThan(compileGateIdx);
  });

  test('deploy.sh recommends SIGUSR1 rather than kickstart -k after setup-arena.sh', () => {
    const script = fs.readFileSync(root('arena', 'scripts', 'deploy.sh'), 'utf8');
    expect(script).toContain(
      './arena/scripts/setup-arena.sh && sudo launchctl kill SIGUSR1 system/ai.pkmn.arena'
    );
    expect(script).not.toContain('kickstart -k system/ai.pkmn.arena');
  });

  test('publishArchivedPoolsLadders skips upload when coordinator is draining', async () => {
    const h = createMockCoordHarness('publish-drain');
    try {
      const ladderDir = path.join(h.dirs.logs, 'gen9vgc2026regf20260401');
      fs.mkdirSync(ladderDir, {recursive: true});
      fs.writeFileSync(path.join(ladderDir, '2026-04.tar'), 'dummy-tar');
      h.coord.requestDrain();
      expect(await h.coord.publishArchivedPoolsLadders(
        ['gen9vgc2026regf20260401'],
        1_760_000_000
      )).toBe(0);
      expect(fs.existsSync(path.join(ladderDir, 'gen9vgc2026regf20260401-logs.tar'))).toBe(false);
    } finally {
      h.stateDb.close();
    }
  });

  test('publishArchivedPoolsLadders stops when shouldYield returns true', async () => {
    const h = createMockCoordHarness('publish-pause');
    try {
      const ladderDir = path.join(h.dirs.logs, 'gen9vgc2026regf20260402');
      fs.mkdirSync(ladderDir, {recursive: true});
      fs.writeFileSync(path.join(ladderDir, '2026-04.tar'), 'dummy-tar');
      expect(await h.coord.publishArchivedPoolsLadders(
        ['gen9vgc2026regf20260402'],
        1_760_000_000,
        () => true
      )).toBe(0);
      expect(fs.existsSync(path.join(ladderDir, 'gen9vgc2026regf20260402-logs.tar'))).toBe(false);
    } finally {
      h.stateDb.close();
    }
  });

  test('syncActivatedAgents prunes discarded staged builds while keeping outbox-pending ones',
    async () => {
      const h = createMockCoordHarness('prune-staged');
      try {
        const stagedDir = path.join(h.dirs.agents, 'alpha-1.0-v41');
        const outboxDir = path.join(h.dirs.agents, 'alpha-1.1-v42');
        fs.mkdirSync(stagedDir, {recursive: true});
        fs.mkdirSync(outboxDir, {recursive: true});
        fs.writeFileSync(path.join(stagedDir, 'run'), '#!/bin/sh\n', {mode: 0o755});
        fs.writeFileSync(path.join(outboxDir, 'run'), '#!/bin/sh\n', {mode: 0o755});

        h.stateDb.upsertLocalAgent({
          versionId: 41,
          agentId: 1,
          slug: 'alpha',
          version: '1.0',
          mode: 'native',
          target: 'alpha-1.0-v41',
          residency: 'staged',
          unpackedBytes: 1024,
        });
        h.stateDb.upsertLocalAgent({
          versionId: 42,
          agentId: 1,
          slug: 'alpha',
          version: '1.1',
          mode: 'native',
          target: 'alpha-1.1-v42',
          residency: 'staged',
          unpackedBytes: 1024,
        });
        h.stateDb.enqueueOutbox('submission-status', {versionId: 42, smokeStatus: 'staged'});

        await h.coord.syncActivatedAgents([], {stagedVersionIds: []});
        expect(h.stateDb.getLocalAgent(41)).toBeUndefined();
        expect(fs.existsSync(stagedDir)).toBe(false);
        expect(h.stateDb.getLocalAgent(42)?.residency).toBe('staged');
        expect(fs.existsSync(outboxDir)).toBe(true);
      } finally {
        h.stateDb.close();
      }
    });

  test('syncActivatedAgents deletes wiped hot or cold bundles while preserving archived ones',
    async () => {
      const h = createMockCoordHarness('prune-wiped');
      try {
        const wipedDir = path.join(h.dirs.agents, 'mocca-0.1-v51');
        const wipedArchive = path.join(h.dirs.cold, 'mocca-0.1-v51.tar.zst');
        const keptArchive = path.join(h.dirs.cold, 'legacy-1.0-v52.tar.zst');
        fs.mkdirSync(wipedDir, {recursive: true});
        fs.mkdirSync(h.dirs.cold, {recursive: true});
        fs.writeFileSync(path.join(wipedDir, 'run'), '#!/bin/sh\n', {mode: 0o755});
        fs.writeFileSync(wipedArchive, 'fake-zst');
        fs.writeFileSync(keptArchive, 'fake-zst');

        h.stateDb.upsertLocalAgent({
          versionId: 51,
          agentId: 1,
          slug: 'mocca',
          version: '0.1',
          mode: 'native',
          target: 'mocca-0.1-v51',
          residency: 'hot',
          unpackedBytes: 1024,
        });
        h.stateDb.upsertLocalAgent({
          versionId: 52,
          agentId: 2,
          slug: 'legacy',
          version: '1.0',
          mode: 'native',
          target: 'legacy-1.0-v52',
          residency: 'cold',
          unpackedBytes: 2048,
        });

        await h.coord.syncActivatedAgents([], {stagedVersionIds: [], knownVersionIds: [52]});
        expect(h.stateDb.getLocalAgent(51)).toBeUndefined();
        expect(fs.existsSync(wipedDir)).toBe(false);
        expect(fs.existsSync(wipedArchive)).toBe(false);
        expect(h.stateDb.getLocalAgent(52)?.residency).toBe('cold');
        expect(fs.existsSync(keptArchive)).toBe(true);
      } finally {
        h.stateDb.close();
      }
    });

  test('flushOutbox drops 409 match-complete for wiped version without blocking later items',
    async () => {
      const stateDb = new arenaDb.Database(':memory:');
      try {
        const delivered: string[] = [];
        const fakeClient = {
          completeMatch: (payload: serverArena.MatchCompletePayload) => {
            if (payload.match.id === 'wiped-m1') {
              return Promise.reject(
                Object.assign(new Error('Unknown versionId in match (51 vs 52)'), {status: 409})
              );
            }
            delivered.push(payload.match.id);
            return Promise.resolve({ok: true, duplicate: false, archivedLadder: false});
          },
        } as unknown as serverArena.Client;
        const coord = new coordinator.Coordinator({
          client: fakeClient,
          stateDb,
          baselineSpec: {mode: 'native', target: '_baseline'},
        });
        stateDb.enqueueOutbox(
          'match-complete',
          {
            match: {id: 'wiped-m1', ladderId: 'gen1ou', p1VersionId: 51, p2VersionId: 52},
          } as unknown as serverArena.MatchCompletePayload
        );
        stateDb.enqueueOutbox(
          'match-complete',
          {
            match: {id: 'healthy-m2', ladderId: 'gen1ou', p1VersionId: 52, p2VersionId: 53},
          } as unknown as serverArena.MatchCompletePayload
        );

        const flushed = await coord.flushOutbox();
        expect(flushed).toBe(1);
        expect(delivered).toEqual(['healthy-m2']);
        expect(stateDb.listOutbox()).toEqual([]);
      } finally {
        stateDb.close();
      }
    });

  test('arena DB migration 0001-staged-local-agents upgrades existing local_agents rows', () => {
    const migTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-arena-mig-0001-'));
    try {
      const preSchemaDir = path.join(migTmp, 'pre-schema');
      const emptyMigDir = path.join(migTmp, 'empty-mig');
      fs.mkdirSync(preSchemaDir, {recursive: true});
      fs.mkdirSync(emptyMigDir, {recursive: true});
      for (const file of fs.readdirSync(arenaDb.SCHEMA_DIR)) {
        if (!file.endsWith('.sql')) continue;
        let sql = fs.readFileSync(path.join(arenaDb.SCHEMA_DIR, file), 'utf8');
        if (file === 'local-agents.sql') {
          sql = sql.replace(
            "CHECK (residency IN ('staged', 'hot', 'cold'))",
            "CHECK (residency IN ('hot', 'cold'))"
          );
        }
        fs.writeFileSync(path.join(preSchemaDir, file), sql, 'utf8');
      }

      const dbPath = path.join(migTmp, 'arena.sqlite');
      const legacy = new arenaDb.Database(dbPath, {
        schemaDir: preSchemaDir,
        migrationDir: emptyMigDir,
        now: 1_760_000_000,
      });
      legacy.upsertLocalAgent({
        versionId: 7,
        agentId: 1,
        slug: 'alpha',
        version: '1.0',
        mode: 'native',
        target: 'alpha-1.0-v7',
        residency: 'hot',
        unpackedBytes: 2048,
        now: 1_760_000_000,
      });
      legacy.close();

      const migrated = new arenaDb.Database(dbPath, {now: 1_760_000_010});
      try {
        expect(migrated.getLocalAgent(7)?.residency).toBe('hot');
        migrated.upsertLocalAgent({
          versionId: 8,
          agentId: 1,
          slug: 'alpha',
          version: '1.1',
          mode: 'native',
          target: 'alpha-1.1-v8',
          residency: 'staged',
          unpackedBytes: 4096,
          now: 1_760_000_010,
        });
        expect(migrated.getLocalAgent(8)?.residency).toBe('staged');
      } finally {
        migrated.close();
      }
    } finally {
      fs.rmSync(migTmp, {recursive: true, force: true});
    }
  });

  test('recyclePodmanVm polls podman info until restarted VM socket is ready', async () => {
    const calls: string[] = [];
    let infoChecks = 0;
    let sleeps = 0;
    await coordinator.recyclePodmanVm({
      exec: (file, args) => {
        calls.push(`${file} ${args.join(' ')}`);
        if (file === 'podman' && args[0] === 'info') {
          infoChecks++;
          if (infoChecks < 2) return Promise.reject(new Error('socket not ready'));
        }
        return Promise.resolve();
      },
      sleep: () => {
        sleeps++;
        return Promise.resolve();
      },
    });
    expect(calls).toEqual([
      'podman machine stop podman-machine-default',
      'sudo -n /bin/launchctl kickstart -k system/ai.pkmn.podman',
      'podman info --format {{.Host.OS}}',
      'podman info --format {{.Host.OS}}',
    ]);
    expect(sleeps).toBe(1);
  });

  test('recyclePodmanVm still restarts service when podman machine stop fails', async () => {
    const calls: string[] = [];
    const origError = console.error;
    console.error = () => undefined;
    try {
      await coordinator.recyclePodmanVm({
        exec: (file, args) => {
          calls.push(`${file} ${args.join(' ')}`);
          if (file === 'podman' && args[0] === 'machine') {
            return Promise.reject(new Error('already stopped'));
          }
          return Promise.resolve();
        },
        sleep: () => Promise.resolve(),
      });
    } finally {
      console.error = origError;
    }
    expect(calls).toEqual([
      'podman machine stop podman-machine-default',
      'sudo -n /bin/launchctl kickstart -k system/ai.pkmn.podman',
      'podman info --format {{.Host.OS}}',
    ]);
  });

  test('playNextScheduledMatch recycles Podman VM after a container match', async () => {
    let recycles = 0;
    const h = createMockCoordHarness('recycle-container-match', {
      recyclePodmanVm: () => {
        recycles++;
      },
    });
    const fakeResult: arbiter.ArenaGameResult = {
      outcome: 'W',
      winner: 'p1',
      turns: 1,
      endReason: 'win',
      omniscientLog: '|turn|1\n|win|Agent A\n',
      p1: {
        bankSeconds: 120,
        peakRam: 128,
        initMillis: 50,
        lastTurnMillis: 10,
        meanTurnMillis: 10,
      },
      p2: {
        bankSeconds: 120,
        peakRam: 64,
        initMillis: 40,
        lastTurnMillis: 10,
        meanTurnMillis: 10,
      },
    };
    const origRunDesc = Object.getOwnPropertyDescriptor(
      arbiter.TimeSlicedArenaGame.prototype,
      'run'
    )!;
    Object.defineProperty(arbiter.TimeSlicedArenaGame.prototype, 'run', {
      ...origRunDesc,
      value: () => Promise.resolve(fakeResult),
    });
    try {
      h.stateDb.upsertLocalAgent({
        versionId: 30,
        agentId: 1,
        slug: 'foul-play',
        version: '3.0.0',
        mode: 'container',
        target: 'foul-play-3.0.0-v30',
        residency: 'hot',
        unpackedBytes: 1024,
      });
      installLocalAgent(h, {versionId: 25, agentId: 2, slug: 'pokechamp', version: '1.0.0'});
      const played = await h.coord.playNextScheduledMatch([h.ladderSnap]);
      expect(played?.ladderId).toBe('gen9customgame');
      expect(recycles).toBe(1);
    } finally {
      Object.defineProperty(arbiter.TimeSlicedArenaGame.prototype, 'run', origRunDesc);
      h.stateDb.close();
    }
  });

  test('playNextScheduledMatch skips Podman VM recycle after a native-only match', async () => {
    let recycles = 0;
    const h = createMockCoordHarness('skip-recycle-native-match', {
      recyclePodmanVm: () => {
        recycles++;
      },
    });
    try {
      installLocalAgent(h, {versionId: 30, agentId: 1, slug: 'foul-play', version: '3.0.0'});
      installLocalAgent(h, {versionId: 25, agentId: 2, slug: 'pokechamp', version: '1.0.0'});
      const played = await h.coord.playNextScheduledMatch([h.ladderSnap]);
      expect(played?.ladderId).toBe('gen9customgame');
      expect(recycles).toBe(0);
    } finally {
      h.stateDb.close();
    }
  });

  test('recyclePodmanVm skips stop when already draining', async () => {
    const calls: string[] = [];
    await coordinator.recyclePodmanVm({
      isDraining: () => true,
      exec: (file, args) => {
        calls.push(`${file} ${args.join(' ')}`);
        return Promise.resolve();
      },
      sleep: () => Promise.resolve(),
    });
    expect(calls).toEqual([]);
  });

  test('recyclePodmanVm still kickstarts service if drain begins during stop', async () => {
    const calls: string[] = [];
    let draining = false;
    await coordinator.recyclePodmanVm({
      isDraining: () => draining,
      exec: (file, args) => {
        calls.push(`${file} ${args.join(' ')}`);
        if (file === 'podman' && args[0] === 'machine') {
          draining = true;
        }
        return Promise.resolve();
      },
      sleep: () => Promise.resolve(),
    });
    expect(calls).toEqual([
      'podman machine stop podman-machine-default',
      'sudo -n /bin/launchctl kickstart -k system/ai.pkmn.podman',
    ]);
  });

  test('processPendingSubmissions reports OCI status before recycling Podman VM', async () => {
    const events: string[] = [];
    const rootDir = path.join(tmpDir, 'smoke-oci-order');
    const stateDb = new arenaDb.Database(':memory:');
    const fakeResult: arbiter.ArenaGameResult = {
      outcome: 'W',
      winner: 'p1',
      turns: 1,
      endReason: 'win',
      omniscientLog: '|turn|1\n|win|Agent A\n',
      p1: {
        bankSeconds: 120,
        peakRam: 128,
        initMillis: 50,
        lastTurnMillis: 10,
        meanTurnMillis: 10,
      },
      p2: {
        bankSeconds: 120,
        peakRam: 64,
        initMillis: 40,
        lastTurnMillis: 10,
        meanTurnMillis: 10,
      },
    };
    const origPullDesc = Object.getOwnPropertyDescriptor(packages, 'pullAndVerifyOciImage')!;
    const origRunDesc = Object.getOwnPropertyDescriptor(
      arbiter.TimeSlicedArenaGame.prototype,
      'run'
    )!;
    Object.defineProperty(packages, 'pullAndVerifyOciImage', {
      configurable: true,
      enumerable: true,
      get: () => (): packages.UnpackResult => ({sha256: 'a'.repeat(64), unpackedBytes: 2048}),
    });
    Object.defineProperty(arbiter.TimeSlicedArenaGame.prototype, 'run', {
      ...origRunDesc,
      value: () => Promise.resolve(fakeResult),
    });
    const fakeClient = {
      getPendingSubmissions: () => Promise.resolve({
        ladders: [],
        submissions: [{
          versionId: 99,
          agentId: 1,
          agentSlug: 'foul-play',
          agentName: 'Foul Play',
          version: '4.0.0',
          package: 'oci' as const,
          url: 'ghcr.io/pmariglia/foul-play:4.0.0',
          sha256: 'a'.repeat(64),
          ladders: ['gen9customgame'],
          tournaments: [],
          teamsByLadder: {},
        }],
      }),
      reportSubmissionStatus: (payload: serverArena.SubmissionStatusPayload) => {
        events.push(`status:${payload.smokeStatus}`);
        return Promise.resolve({
          ok: true as const,
          versionId: payload.versionId,
          smokeStatus: payload.smokeStatus,
          retiredByLadder: {},
        });
      },
      sendHeartbeat: () => Promise.resolve({ok: true as const, updatedAt: 0}),
    } as unknown as serverArena.Client;
    const ladderSnap: coordinator.LadderSnapshot = {
      id: 'gen9customgame',
      slot: 'rand',
      format: 'gen9randombattle',
      team: 'random',
      status: 'active',
      min: 2,
      entries: [],
      pairAggregates: [],
    };
    const coord = new coordinator.Coordinator({
      client: fakeClient,
      stateDb,
      baselineSpec: {mode: 'native', target: defaultAgentScript},
      rootDir,
      devMode: true,
      recyclePodmanVm: () => {
        events.push('recycle');
      },
    });
    try {
      const count = await coord.processPendingSubmissions(
        new Map([['gen9customgame', ladderSnap]])
      );
      expect(count).toBe(1);
      expect(events).toEqual(['status:staged', 'recycle']);
    } finally {
      Object.defineProperty(packages, 'pullAndVerifyOciImage', origPullDesc);
      Object.defineProperty(arbiter.TimeSlicedArenaGame.prototype, 'run', origRunDesc);
      stateDb.close();
    }
  });

  test('recyclePodmanVm returns error when launchctl kickstart fails', async () => {
    const origError = console.error;
    console.error = () => undefined;
    try {
      const res = await coordinator.recyclePodmanVm({
        exec: file => file === 'sudo'
          ? Promise.reject(new Error('launchctl failed'))
          : Promise.resolve(),
        sleep: () => Promise.resolve(),
      });
      expect(res).toEqual({ok: false, error: 'launchctl kickstart failed: launchctl failed'});
    } finally {
      console.error = origError;
    }
  });

  test('recyclePodmanVm returns error when readiness poll times out', async () => {
    let fakeNow = 1_000;
    const origError = console.error;
    console.error = () => undefined;
    try {
      const res = await coordinator.recyclePodmanVm({
        exec: (file, args) => file === 'podman' && args[0] === 'info'
          ? Promise.reject(new Error('socket not ready'))
          : Promise.resolve(),
        now: () => fakeNow,
        sleep: millis => {
          fakeNow += millis;
          return Promise.resolve();
        },
        readyTimeoutMillis: 1_000,
        readyPollMillis: 500,
      });
      expect(res).toEqual({
        ok: false,
        error: 'Timed out waiting for Podman VM API socket after recycle',
      });
    } finally {
      console.error = origError;
    }
  });

  test('playNextScheduledMatch alerts on Podman recycle failure then resolves', async () => {
    const results: coordinator.PodmanRecycleResult[] = [
      {ok: false, error: 'socket timeout'},
      {ok: true},
    ];
    const h = createMockCoordHarness('recycle-alert', {
      recyclePodmanVm: () => results.shift(),
    });
    const fakeResult: arbiter.ArenaGameResult = {
      outcome: 'W',
      winner: 'p1',
      turns: 1,
      endReason: 'win',
      omniscientLog: '|turn|1\n|win|Agent A\n',
      p1: {
        bankSeconds: 120,
        peakRam: 128,
        initMillis: 50,
        lastTurnMillis: 10,
        meanTurnMillis: 10,
      },
      p2: {
        bankSeconds: 120,
        peakRam: 64,
        initMillis: 40,
        lastTurnMillis: 10,
        meanTurnMillis: 10,
      },
    };
    const origRunDesc = Object.getOwnPropertyDescriptor(
      arbiter.TimeSlicedArenaGame.prototype,
      'run'
    )!;
    Object.defineProperty(arbiter.TimeSlicedArenaGame.prototype, 'run', {
      ...origRunDesc,
      value: () => Promise.resolve(fakeResult),
    });
    try {
      h.stateDb.upsertLocalAgent({
        versionId: 30,
        agentId: 1,
        slug: 'foul-play',
        version: '3.0.0',
        mode: 'container',
        target: 'foul-play-3.0.0-v30',
        residency: 'hot',
        unpackedBytes: 1024,
      });
      installLocalAgent(h, {versionId: 25, agentId: 2, slug: 'pokechamp', version: '1.0.0'});

      await h.coord.playNextScheduledMatch([h.ladderSnap]);
      expect(h.alerts).toEqual([{
        key: 'podman-recycle',
        message: 'Podman VM recycle failed on Arena runner',
        detail: 'socket timeout',
      }]);

      await h.coord.playNextScheduledMatch([h.ladderSnap]);
      expect(h.alerts[1]).toEqual({
        key: 'podman-recycle',
        message: 'Podman VM recycle recovered on Arena runner',
        resolved: true,
      });
    } finally {
      Object.defineProperty(arbiter.TimeSlicedArenaGame.prototype, 'run', origRunDesc);
      h.stateDb.close();
    }
  });
});
