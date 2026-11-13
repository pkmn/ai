import * as fs from 'fs';
import * as path from 'path';

import {PRNGSeed} from '@pkmn/sim';

import * as arena from '../server/arena';
import * as ratings from '../server/ratings';
import * as teams from '../server/teams';
import {toID} from '../static/util';

import {AgentLaunchSpec, ArenaGameResult, TimeSlicedArenaGame} from './arbiter';
import {MatchCheckpoint, StateDatabase} from './db';
import {
  AGENTS_DIR,
  COLD_AGENTS_DIR,
  STAGING_DIR,
  UNPACK_BIN,
  downloadAndUnpackBundle,
  ensureAgentResident,
  evictColdAgentsIfNeeded,
  formatAgentTargetId,
  pullAndVerifyOciImage,
  toExecutionMode,
} from './packages';
import {synthesizeFallbackPackedTeam} from './tournament';

function safeSampleRandomPair(
  format: string,
  seed1: PRNGSeed,
  seed2: PRNGSeed
): {t1Packed: string; t2Packed: string} {
  try {
    return teams.sampleRandomPair(format, seed1, seed2);
  } catch {
    return {
      t1Packed: synthesizeFallbackPackedTeam(format, 0),
      t2Packed: synthesizeFallbackPackedTeam(format, 1),
    };
  }
}

export interface ActiveRosterEntry {
  agentId: number;
  agentName: string;
  teams: string[];
}

export interface LadderSnapshot {
  id: string;
  slot: string;
  format: string;
  team: 'random' | 'harvested' | 'pools';
  status: 'upcoming' | 'active' | 'settling' | 'archived';
  min: number;
  entries: Array<{
    versionId: number;
    agentId: number;
    agentSlug: string;
    agentName: string;
    version: string;
    elo: number;
    se: number;
    lcb: number;
    matches: number;
    settledAt?: number;
    role: 'champion' | 'challenger' | 'retired' | 'quarantined';
  }>;
  pairAggregates: Array<{
    lowVersionId: number;
    highVersionId: number;
    ww: number;
    wt: number;
    split: number;
    tl: number;
    ll: number;
  }>;
  roster?: ActiveRosterEntry[];
}

export interface CoordinatorOptions {
  client: arena.Client;
  stateDb: StateDatabase;
  baselineSpec: AgentLaunchSpec;
  agentsDir?: string;
  stagingDir?: string;
  coldDir?: string;
  teamsDir?: string;
  archiveLogsDir?: string;
  unpackBin?: string;
  casDir?: string;
  devMode?: boolean;
  maxTurns?: number;
  exploitProbability?: number;
  formatByLadderId?: ReadonlyMap<string, string>;
  randomInt?: (max: number) => number;
}

const FAULT_REASONS = new Set(['crash', 'oom', 'timeout', 'invalid_choice_limit']);

function isPlayerFault(
  result: ArenaGameResult,
  slot: 'p1' | 'p2'
): boolean {
  if (!FAULT_REASONS.has(result.endReason)) return false;
  return (slot === 'p1' && result.winner === 'p2') ||
    (slot === 'p2' && result.winner === 'p1');
}

function combineMatchCategory(
  g1: ratings.GameOutcome,
  g2: ratings.GameOutcome
): ratings.MatchCategory {
  const s1 = g1 === 'W' ? 1 : g1 === 'T' ? 0.5 : 0;
  const s2 = g2 === 'W' ? 1 : g2 === 'T' ? 0.5 : 0;
  const sum = s1 + s2;
  if (sum === 2) return 'WW';
  if (sum === 1.5) return 'WT';
  if (sum === 1) return g1 === 'T' ? 'TT' : 'WL';
  if (sum === 0.5) return 'TL';
  return 'LL';
}

export class Coordinator {
  readonly client: arena.Client;
  readonly stateDb: StateDatabase;
  private readonly baselineSpec: AgentLaunchSpec;
  private readonly agentsDir: string;
  private readonly stagingDir: string;
  private readonly coldDir: string;
  private readonly teamsDir: string;
  private readonly archiveLogsDir: string;
  private readonly unpackBin: string;
  private readonly casDir?: string;
  private readonly devMode: boolean;
  private readonly maxTurns?: number;
  private readonly exploitProbability: number;
  private readonly formatByLadderId: Map<string, string>;
  private readonly randomInt: (max: number) => number;
  private readonly harvestedCache = new Map<string, teams.HarvestedPoolEntry[]>();
  private heartbeatSeq = 0;

  constructor(options: CoordinatorOptions) {
    this.client = options.client;
    this.stateDb = options.stateDb;
    this.baselineSpec = options.baselineSpec;
    this.agentsDir = options.agentsDir ?? AGENTS_DIR;
    this.stagingDir = options.stagingDir ?? STAGING_DIR;
    this.coldDir = options.coldDir ?? COLD_AGENTS_DIR;
    this.teamsDir = options.teamsDir ?? '/opt/arena/teams';
    this.archiveLogsDir = options.archiveLogsDir ?? '/Volumes/Archive/logs';
    this.unpackBin = options.unpackBin ?? UNPACK_BIN;
    this.casDir = options.casDir;
    this.devMode = options.devMode ?? process.env.ARENA_DEV === '1';
    this.maxTurns = options.maxTurns;
    this.exploitProbability = options.exploitProbability ?? 0.45;
    this.formatByLadderId = new Map(options.formatByLadderId ?? []);
    this.randomInt = options.randomInt ?? (max => Math.floor(Math.random() * max));
  }

  registerLadderFormat(ladderId: string, format: string) {
    this.formatByLadderId.set(ladderId, format);
  }

  private resolveLaunchSpec(mode: 'container' | 'native', target: string): AgentLaunchSpec {
    if (mode === 'native' && this.devMode && !path.isAbsolute(target)) {
      return {
        mode: 'native',
        target: path.join(this.agentsDir, target, 'run'),
      };
    }
    return {mode, target};
  }

  async flushOutbox(): Promise<number> {
    const entries = this.stateDb.listOutbox();
    let flushed = 0;
    for (const entry of entries) {
      try {
        if (entry.endpoint === 'match-complete') {
          const payload = JSON.parse(entry.payloadJson) as arena.MatchCompletePayload;
          await this.client.completeMatch(payload);
        } else {
          const payload = JSON.parse(entry.payloadJson) as arena.SubmissionStatusPayload;
          await this.client.reportSubmissionStatus(payload);
        }
        this.stateDb.deleteOutboxEntry(entry.id);
        flushed++;
      } catch {
        // Tunnel still unreachable; preserve remaining FIFO entries for next retry
        break;
      }
    }
    return flushed;
  }

  async recoverIncompleteMatches(): Promise<{
    aborted: string[];
    resumed: string[];
  }> {
    const incomplete = this.stateDb.getIncompleteMatches();
    const aborted: string[] = [];
    const resumed: string[] = [];

    for (const cp of incomplete) {
      if (cp.status === 'in_progress') {
        this.stateDb.markMatchStatus(cp.id, 'aborted');
        aborted.push(cp.id);
      } else if (cp.status === 'g1_complete') {
        await this.resumeAndCompleteGame2(cp);
        resumed.push(cp.id);
      }
    }

    return {aborted, resumed};
  }

  async processPendingSubmissions(
    laddersById?: ReadonlyMap<string, LadderSnapshot>
  ): Promise<number> {
    const {submissions} = await this.client.getPendingSubmissions();
    let processed = 0;

    for (const sub of submissions) {
      processed++;
      const mode = toExecutionMode(sub.package);
      const targetId = formatAgentTargetId(sub.agentSlug, sub.version, sub.versionId);
      const target = mode === 'container' ? sub.url : targetId;

      let unpackedBytes: number;
      try {
        if (mode === 'container') {
          unpackedBytes = pullAndVerifyOciImage(
            sub.url,
            targetId,
            sub.authToken,
            this.stagingDir
          );
        } else {
          unpackedBytes = await downloadAndUnpackBundle({
            url: sub.url,
            expectedSha256: sub.sha256,
            agentTargetId: targetId,
            authToken: sub.authToken,
            stagingDir: this.stagingDir,
            agentsDir: this.agentsDir,
            unpackBin: this.unpackBin,
            casDir: this.casDir,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.reportSubmissionOrOutbox({
          versionId: sub.versionId,
          smokeStatus: 'failed',
          smokeError: `Package unpack/verification failed: ${msg}`,
        });
        continue;
      }

      // Run a Turn-1 smoke test in each subscribed ladder's format
      const candidateSpec = this.resolveLaunchSpec(mode, target);
      const formatsToTest = new Set<string>();
      for (const lid of sub.ladders) {
        const fmt = laddersById?.get(lid)?.format ?? this.formatByLadderId.get(lid) ?? lid;
        formatsToTest.add(fmt);
      }
      if (formatsToTest.size === 0) {
        formatsToTest.add('gen9ou');
      }

      const smokeStartMs = Date.now();
      let maxTurnMillis = 0;
      let maxPeakRam = 64;
      let smokeError: string | undefined;

      for (const format of formatsToTest) {
        const {t1Packed, t2Packed} = safeSampleRandomPair(
          format,
          '1,2,3,4',
          '5,6,7,8'
        );
        const game = new TimeSlicedArenaGame({
          format,
          seed: '1,2,3,4',
          p1Spec: candidateSpec,
          p2Spec: this.baselineSpec,
          p1TeamPacked: t1Packed,
          p2TeamPacked: t2Packed,
          smokeStopAfterTurn: 1,
          startingBankSeconds: 30,
          firstTurnGraceSeconds: 30,
          maxTurnSeconds: 30,
          devMode: this.devMode,
        });
        const res = await game.run();
        if (isPlayerFault(res, 'p1')) {
          smokeError = `Smoke test failed in ${format}: ${res.endReason}`;
          break;
        }
        if (res.p1MeanTurnMillis > maxTurnMillis) maxTurnMillis = res.p1MeanTurnMillis;
        if (res.p1PeakRam > maxPeakRam) maxPeakRam = res.p1PeakRam;
      }

      const smokeDurationMillis = Math.max(1, Date.now() - smokeStartMs);

      if (smokeError) {
        if (mode === 'native') {
          fs.rmSync(path.join(this.agentsDir, targetId), {recursive: true, force: true});
        }
        await this.reportSubmissionOrOutbox({
          versionId: sub.versionId,
          smokeStatus: 'failed',
          smokeError,
        });
        continue;
      }

      this.stateDb.upsertLocalAgent({
        versionId: sub.versionId,
        agentId: sub.agentId,
        slug: sub.agentSlug,
        version: sub.version,
        mode,
        target,
        residency: 'hot',
        unpackedBytes,
      });

      evictColdAgentsIfNeeded(this.stateDb, {
        agentsDir: this.agentsDir,
        coldDir: this.coldDir,
        pinnedVersionIds: new Set([sub.versionId]),
      });

      // Compute 3rd-version retirement per subscribed ladder
      const retiredVersionIdsByLadder: Record<string, number> = {};
      if (laddersById) {
        for (const lid of sub.ladders) {
          const snap = laddersById.get(lid);
          if (!snap) continue;
          const activeForAgent = snap.entries
            .filter(
              e =>
                e.agentId === sub.agentId &&
                e.role !== 'retired' &&
                e.versionId !== sub.versionId
            )
            .sort((a, b) => a.lcb - b.lcb || a.versionId - b.versionId);
          if (activeForAgent.length >= 2) {
            retiredVersionIdsByLadder[lid] = activeForAgent[0].versionId;
          }
        }
      }

      await this.reportSubmissionOrOutbox({
        versionId: sub.versionId,
        smokeStatus: 'passed',
        unpackedBytes,
        smokeDurationMillis,
        smokeTurnMillis: Math.max(1, maxTurnMillis),
        smokePeakRam: maxPeakRam,
        ...(Object.keys(retiredVersionIdsByLadder).length > 0
          ? {retiredVersionIdsByLadder}
          : {}),
      });
    }

    return processed;
  }

  private async reportSubmissionOrOutbox(payload: arena.SubmissionStatusPayload) {
    try {
      await this.client.reportSubmissionStatus(payload);
    } catch {
      this.stateDb.enqueueOutbox('submission-status', payload);
    }
  }

  private async completeMatchOrOutbox(
    payload: arena.MatchCompletePayload
  ): Promise<{archivedLadder: boolean}> {
    try {
      return await this.client.completeMatch(payload);
    } catch {
      this.stateDb.enqueueOutbox('match-complete', payload);
      return {archivedLadder: false};
    }
  }

  private toHarvestedEntries(
    packedTeams: readonly string[],
    format: string
  ): teams.HarvestedPoolEntry[] {
    const clean = toID(format);
    return packedTeams.map((packed, idx) => ({
      id: `team-${idx + 1}`,
      canonicalPacked: packed.trim(),
      speciesIds: teams.extractSpeciesIdsFromPacked(packed.trim(), clean),
    }));
  }

  private async loadHarvestedTeamsForLadder(
    ladderId: string,
    format: string
  ): Promise<teams.HarvestedPoolEntry[]> {
    const cached = this.harvestedCache.get(ladderId);
    if (cached) return cached;

    const localFile = path.join(this.teamsDir, `${ladderId}.txt`);
    if (fs.existsSync(localFile)) {
      const lines = fs.readFileSync(localFile, 'utf8')
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(Boolean);
      const entries = this.toHarvestedEntries(lines, format);
      this.harvestedCache.set(ladderId, entries);
      return entries;
    }

    const remote = await this.client.getLadderTeams(ladderId);
    if (remote.teams.length < 2) {
      throw new Error(`Ladder "${ladderId}" returned fewer than 2 harvested teams`);
    }
    fs.mkdirSync(this.teamsDir, {recursive: true});
    fs.writeFileSync(localFile, `${remote.teams.join('\n')}\n`, 'utf8');
    const entries = this.toHarvestedEntries(remote.teams, format);
    this.harvestedCache.set(ladderId, entries);
    return entries;
  }

  private async sampleMatchTeams(
    ladder: LadderSnapshot,
    p1AgentId: number,
    p2AgentId: number,
    seq: number
  ): Promise<{
    t1: string;
    t2: string;
    t1Label?: string;
    t2Label?: string;
  }> {
    if (ladder.team === 'pools') {
      const pool = teams.buildCanonicalTeamPool(ladder.roster ?? [], ladder.format);
      const sampled = teams.samplePoolsPair(
        pool,
        p1AgentId,
        p2AgentId,
        this.randomInt,
        ladder.min
      );
      return {
        t1: sampled.t1Packed,
        t2: sampled.t2Packed,
        t1Label: sampled.t1Label,
        t2Label: sampled.t2Label,
      };
    }
    if (ladder.team === 'harvested') {
      const pool = await this.loadHarvestedTeamsForLadder(ladder.id, ladder.format);
      const {t1Packed, t2Packed} = teams.sampleHarvestedPair(pool, this.randomInt);
      return {t1: t1Packed, t2: t2Packed};
    }
    const seed1: PRNGSeed = `${(seq * 17 + 3) & 0xffff},${(seq * 31 + 5) & 0xffff},101,202`;
    const seed2: PRNGSeed = `${(seq * 43 + 9) & 0xffff},${(seq * 59 + 13) & 0xffff},303,404`;
    const {t1Packed, t2Packed} = safeSampleRandomPair(ladder.format, seed1, seed2);
    return {t1: t1Packed, t2: t2Packed};
  }

  private writeArchivedBattleLogs(
    ladderId: string,
    matchId: string,
    logA: string,
    logB: string,
    nowSeconds: number
  ) {
    try {
      const day = new Date(nowSeconds * 1000).toISOString().slice(0, 10);
      const dir = path.join(this.archiveLogsDir, ladderId, day);
      fs.mkdirSync(dir, {recursive: true});
      fs.writeFileSync(path.join(dir, `${matchId}a.log`), logA, 'utf8');
      fs.writeFileSync(path.join(dir, `${matchId}b.log`), logB, 'utf8');
    } catch {}
  }

  private async checkAndQuarantineIfFaulty(versionId: number, lastReason: string) {
    const row = this.stateDb.getLocalAgent(versionId);
    if (!row) return;

    const faultRate = row.totalGames > 0 ? row.totalFaults / row.totalGames : 0;
    if (row.consecutiveFaults >= 5 || (row.totalGames >= 10 && faultRate > 0.20)) {
      await this.reportSubmissionOrOutbox({
        versionId,
        smokeStatus: 'quarantined',
        smokeError:
          `Auto-quarantined (${row.totalFaults}/${row.totalGames} faults, ` +
          `${row.consecutiveFaults} consecutive; last=${lastReason})`,
      });
    }
  }

  private parsePrngSeed(seedStr: string): PRNGSeed {
    const nums = seedStr.split(',').map(s => Number(s.trim()));
    if (nums.length === 4 && nums.every(n => Number.isFinite(n))) {
      return `${nums[0]},${nums[1]},${nums[2]},${nums[3]}`;
    }
    return '1,2,3,4';
  }

  private async resumeAndCompleteGame2(cp: MatchCheckpoint): Promise<string> {
    ensureAgentResident(this.stateDb, cp.p1VersionId, {
      agentsDir: this.agentsDir,
      coldDir: this.coldDir,
    });
    ensureAgentResident(this.stateDb, cp.p2VersionId, {
      agentsDir: this.agentsDir,
      coldDir: this.coldDir,
    });

    const p1Spec = this.resolveLaunchSpec(cp.p1Mode, cp.p1Target);
    const p2Spec = this.resolveLaunchSpec(cp.p2Mode, cp.p2Target);
    const seed = this.parsePrngSeed(cp.seed);

    // Game 2 swaps sides and teams: P2 sits in slot p1 with T1, P1 sits in slot p2 with T2
    const g2Game = new TimeSlicedArenaGame({
      format: cp.format,
      seed,
      p1Spec: p2Spec,
      p2Spec: p1Spec,
      p1TeamPacked: cp.p1TeamPacked,
      p2TeamPacked: cp.p2TeamPacked,
      maxTurns: this.maxTurns,
      devMode: this.devMode,
    });
    const g2Res = await g2Game.run();
    const g2OutcomeForP1: ratings.GameOutcome =
      g2Res.winner === 'p2' ? 'W' : g2Res.winner === 'p1' ? 'L' : 'T';

    const g1Outcome = cp.game1Outcome ?? 'T';
    const category = combineMatchCategory(g1Outcome, g2OutcomeForP1);
    const now = Math.floor(Date.now() / 1000);

    const p1PeakRam = Math.max(cp.p1Game1Ram ?? 64, g2Res.p2PeakRam);
    const p2PeakRam = Math.max(cp.p2Game1Ram ?? 64, g2Res.p1PeakRam);
    const p1MeanTurnMillis = Math.round(
      ((cp.p1Game1TurnMillis ?? 0) + g2Res.p2MeanTurnMillis) / 2
    );
    const p2MeanTurnMillis = Math.round(
      ((cp.p2Game1TurnMillis ?? 0) + g2Res.p1MeanTurnMillis) / 2
    );

    const payload: arena.MatchCompletePayload = {
      match: {
        id: cp.id,
        ladderId: cp.ladderId,
        p1VersionId: cp.p1VersionId,
        p2VersionId: cp.p2VersionId,
        seed: cp.seed,
        ...(cp.p1TeamLabel ? {p1TeamLabel: cp.p1TeamLabel} : {}),
        ...(cp.p2TeamLabel ? {p2TeamLabel: cp.p2TeamLabel} : {}),
        game1Outcome: g1Outcome,
        game2Outcome: g2OutcomeForP1,
        category,
        game1Turns: cp.game1Turns ?? 1,
        game2Turns: g2Res.turns,
        game1EndReason: cp.game1EndReason ?? 'win',
        game2EndReason: g2Res.endReason,
        p1PeakRam,
        p2PeakRam,
        p1Game1BankSeconds: cp.p1Game1BankSeconds ?? 0,
        p1Game2BankSeconds: g2Res.p2BankSeconds,
        p2Game1BankSeconds: cp.p2Game1BankSeconds ?? 0,
        p2Game2BankSeconds: g2Res.p1BankSeconds,
        p1MeanTurnMillis,
        p2MeanTurnMillis,
        completedAt: now,
      },
    };

    await this.completeMatchOrOutbox(payload);
    this.stateDb.markMatchStatus(cp.id, 'complete', now);
    return cp.id;
  }

  async playNextScheduledMatch(
    ladders: readonly LadderSnapshot[]
  ): Promise<{matchId: string; ladderId: string; archivedLadder: boolean} | undefined> {
    await this.flushOutbox();

    const candidates: Array<{
      ladder: LadderSnapshot;
      state: ratings.LadderMatchState;
    }> = [];

    for (const ladder of ladders) {
      if (ladder.status !== 'active' && ladder.status !== 'settling') continue;
      const rosterIds = ladder.team === 'pools' && ladder.roster
        ? new Set(ladder.roster.map(r => r.agentId))
        : undefined;
      const isPlayable = (e: LadderSnapshot['entries'][number]) =>
        e.role !== 'retired' && e.role !== 'quarantined' &&
        (!rosterIds || rosterIds.has(e.agentId));
      const activeEntries = ladder.entries.filter(isPlayable);
      const uniqueAgents = new Set(activeEntries.map(e => e.agentId));
      if (uniqueAgents.size < Math.max(2, ladder.min)) continue;

      const M = ladder.entries.length;
      const indexByVersion = new Map<number, number>();
      const activeIndices: number[] = [];
      const agentIds = new Int32Array(M);
      const theta = new Float64Array(M);
      const sigma = new Float64Array(M);
      const agentMatches = new Int32Array(M);
      const pairMatches = new Int32Array(M * M);

      for (let i = 0; i < M; i++) {
        const e = ladder.entries[i];
        indexByVersion.set(e.versionId, i);
        if (isPlayable(e)) activeIndices.push(i);
        agentIds[i] = e.agentId;
        theta[i] = (e.elo - 1500) / ratings.ELO_SCALE;
        sigma[i] = e.se / ratings.ELO_SCALE;
        agentMatches[i] = e.matches;
      }

      for (const p of ladder.pairAggregates) {
        const i = indexByVersion.get(p.lowVersionId);
        const j = indexByVersion.get(p.highVersionId);
        if (i !== undefined && j !== undefined) {
          const count = p.ww + p.wt + p.split + p.tl + p.ll;
          pairMatches[i * M + j] = count;
          pairMatches[j * M + i] = count;
        }
      }

      const state: ratings.LadderMatchState = {
        id: ladder.id,
        activeAgentIndices: activeIndices,
        agentIds,
        minAgents: ladder.min,
        theta,
        sigma,
        agentMatches,
        pairMatches,
        lastMatchNumber: this.stateDb.getMatchSequence(ladder.id),
      };
      candidates.push({ladder, state});
    }

    if (candidates.length === 0) return undefined;

    const globalSeq =
      candidates.reduce((sum, c) => sum + c.state.lastMatchNumber, 0) + 1;
    const choice = ratings.selectNextArenaMatch(
      candidates.map(c => c.state),
      globalSeq,
      this.exploitProbability
    );

    const chosen = candidates.find(c => c.ladder.id === choice.ladderId)!;
    const e1 = chosen.ladder.entries[choice.agentI];
    const e2 = chosen.ladder.entries[choice.agentJ];

    return this.executeMirrorPair(chosen.ladder, e1, e2);
  }

  async executeMirrorPair(
    ladder: LadderSnapshot,
    e1: LadderSnapshot['entries'][number],
    e2: LadderSnapshot['entries'][number]
  ): Promise<{matchId: string; ladderId: string; archivedLadder: boolean}> {
    const a1 = ensureAgentResident(this.stateDb, e1.versionId, {
      agentsDir: this.agentsDir,
      coldDir: this.coldDir,
    });
    const a2 = ensureAgentResident(this.stateDb, e2.versionId, {
      agentsDir: this.agentsDir,
      coldDir: this.coldDir,
    });
    if (!a1 || !a2) {
      throw new Error(
        `Missing local agent registration for versionId ${e1.versionId} or ${e2.versionId}`
      );
    }

    const seq = this.stateDb.nextMatchSequence(ladder.id);
    const prefix = ladder.slot === 'vgc' ? 'vgc' : ladder.format;
    const matchId = `${prefix}-${String(seq).padStart(7, '0')}`;
    const s0 = (seq * 13 + 7) & 0xffff;
    const s1 = (seq * 29 + 11) & 0xffff;
    const s2 = (seq * 47 + 19) & 0xffff;
    const s3 = (seq * 61 + 23) & 0xffff;
    const seedStr: PRNGSeed = `${s0},${s1},${s2},${s3}`;
    const sampled = await this.sampleMatchTeams(ladder, e1.agentId, e2.agentId, seq);
    const now = Math.floor(Date.now() / 1000);

    this.stateDb.createMatchCheckpoint({
      id: matchId,
      ladderId: ladder.id,
      format: ladder.format,
      teamMode: ladder.team,
      p1VersionId: e1.versionId,
      p1AgentId: e1.agentId,
      p1Slug: e1.agentSlug,
      p1Name: e1.agentName,
      p1Version: e1.version,
      p1Mode: a1.mode,
      p1Target: a1.target,
      p2VersionId: e2.versionId,
      p2AgentId: e2.agentId,
      p2Slug: e2.agentSlug,
      p2Name: e2.agentName,
      p2Version: e2.version,
      p2Mode: a2.mode,
      p2Target: a2.target,
      seed: seedStr,
      p1TeamPacked: sampled.t1,
      p2TeamPacked: sampled.t2,
      p1TeamLabel: sampled.t1Label,
      p2TeamLabel: sampled.t2Label,
      startedAt: now,
    });

    const p1Spec = this.resolveLaunchSpec(a1.mode, a1.target);
    const p2Spec = this.resolveLaunchSpec(a2.mode, a2.target);

    // Game 1: P1 in slot p1 with T1, P2 in slot p2 with T2
    const g1Game = new TimeSlicedArenaGame({
      format: ladder.format,
      seed: seedStr,
      p1Spec,
      p2Spec,
      p1TeamPacked: sampled.t1,
      p2TeamPacked: sampled.t2,
      maxTurns: this.maxTurns,
      devMode: this.devMode,
      onTurn: async info => {
        this.heartbeatSeq++;
        await this.client.sendHeartbeat({
          heartbeatSeq: this.heartbeatSeq,
          matchId,
          ladderId: ladder.id,
          format: ladder.format,
          game: 1,
          turn: info.turn,
          activeSlot: info.activeSlot,
          turnStartedAt: info.turnStartedAt,
          turnBudgetSeconds: info.turnBudgetSeconds,
          incrementSeconds: info.incrementSeconds,
          p1: {
            slug: e1.agentSlug,
            name: e1.agentName,
            version: e1.version,
            bankSeconds: info.p1BankSeconds,
            lastTurnMillis: info.p1LastTurnMillis,
            meanTurnMillis: info.p1MeanTurnMillis,
            ram: 64,
            ...(sampled.t1Label ? {team: sampled.t1Label} : {}),
          },
          p2: {
            slug: e2.agentSlug,
            name: e2.agentName,
            version: e2.version,
            bankSeconds: info.p2BankSeconds,
            lastTurnMillis: info.p2LastTurnMillis,
            meanTurnMillis: info.p2MeanTurnMillis,
            ram: 64,
            ...(sampled.t2Label ? {team: sampled.t2Label} : {}),
          },
        }).catch(() => undefined);
      },
    });
    const g1Res = await g1Game.run();

    this.stateDb.checkpointGame1Complete({
      id: matchId,
      outcome: g1Res.outcome,
      turns: g1Res.turns,
      endReason: g1Res.endReason,
      p1BankSeconds: g1Res.p1BankSeconds,
      p2BankSeconds: g1Res.p2BankSeconds,
      p1Ram: g1Res.p1PeakRam,
      p2Ram: g1Res.p2PeakRam,
      p1TurnMillis: g1Res.p1MeanTurnMillis,
      p2TurnMillis: g1Res.p2MeanTurnMillis,
    });

    // Game 2: P2 in slot p1 with T1, P1 in slot p2 with T2
    const g2Game = new TimeSlicedArenaGame({
      format: ladder.format,
      seed: seedStr,
      p1Spec: p2Spec,
      p2Spec: p1Spec,
      p1TeamPacked: sampled.t1,
      p2TeamPacked: sampled.t2,
      maxTurns: this.maxTurns,
      devMode: this.devMode,
      onTurn: async info => {
        this.heartbeatSeq++;
        await this.client.sendHeartbeat({
          heartbeatSeq: this.heartbeatSeq,
          matchId,
          ladderId: ladder.id,
          format: ladder.format,
          game: 2,
          turn: info.turn,
          activeSlot: info.activeSlot === 'p1' ? 'p2' : 'p1',
          turnStartedAt: info.turnStartedAt,
          turnBudgetSeconds: info.turnBudgetSeconds,
          incrementSeconds: info.incrementSeconds,
          game1Summary: {
            ...(g1Res.winner === 'p1'
              ? {winnerSlot: 'p1' as const}
              : g1Res.winner === 'p2'
                ? {winnerSlot: 'p2' as const}
                : {}),
            turns: g1Res.turns,
          },
          p1: {
            slug: e1.agentSlug,
            name: e1.agentName,
            version: e1.version,
            bankSeconds: info.p2BankSeconds,
            lastTurnMillis: info.p2LastTurnMillis,
            meanTurnMillis: info.p2MeanTurnMillis,
            ram: g1Res.p1PeakRam,
            ...(sampled.t2Label ? {team: sampled.t2Label} : {}),
          },
          p2: {
            slug: e2.agentSlug,
            name: e2.agentName,
            version: e2.version,
            bankSeconds: info.p1BankSeconds,
            lastTurnMillis: info.p1LastTurnMillis,
            meanTurnMillis: info.p1MeanTurnMillis,
            ram: g1Res.p2PeakRam,
            ...(sampled.t1Label ? {team: sampled.t1Label} : {}),
          },
        }).catch(() => undefined);
      },
    });
    const g2Res = await g2Game.run();
    const g2OutcomeForP1: ratings.GameOutcome =
      g2Res.winner === 'p2' ? 'W' : g2Res.winner === 'p1' ? 'L' : 'T';
    const category = combineMatchCategory(g1Res.outcome, g2OutcomeForP1);
    const completedAt = Math.floor(Date.now() / 1000);

    this.writeArchivedBattleLogs(
      ladder.id,
      matchId,
      g1Res.omniscientLog,
      g2Res.omniscientLog,
      completedAt
    );

    const p1PeakRam = Math.max(g1Res.p1PeakRam, g2Res.p2PeakRam);
    const p2PeakRam = Math.max(g1Res.p2PeakRam, g2Res.p1PeakRam);
    const p1MeanTurnMillis = Math.round(
      (g1Res.p1MeanTurnMillis + g2Res.p2MeanTurnMillis) / 2
    );
    const p2MeanTurnMillis = Math.round(
      (g1Res.p2MeanTurnMillis + g2Res.p1MeanTurnMillis) / 2
    );

    const completePayload: arena.MatchCompletePayload = {
      match: {
        id: matchId,
        ladderId: ladder.id,
        p1VersionId: e1.versionId,
        p2VersionId: e2.versionId,
        seed: seedStr,
        ...(sampled.t1Label ? {p1TeamLabel: sampled.t1Label} : {}),
        ...(sampled.t2Label ? {p2TeamLabel: sampled.t2Label} : {}),
        game1Outcome: g1Res.outcome,
        game2Outcome: g2OutcomeForP1,
        category,
        game1Turns: g1Res.turns,
        game2Turns: g2Res.turns,
        game1EndReason: g1Res.endReason,
        game2EndReason: g2Res.endReason,
        p1PeakRam,
        p2PeakRam,
        p1Game1BankSeconds: g1Res.p1BankSeconds,
        p1Game2BankSeconds: g2Res.p2BankSeconds,
        p2Game1BankSeconds: g1Res.p2BankSeconds,
        p2Game2BankSeconds: g2Res.p1BankSeconds,
        p1MeanTurnMillis,
        p2MeanTurnMillis,
        completedAt,
      },
    };

    const {archivedLadder} = await this.completeMatchOrOutbox(completePayload);
    this.stateDb.markMatchStatus(matchId, 'complete', completedAt);

    // Update fault counters for Game 1 and Game 2 and auto-quarantine on threshold breach
    const p1FaultG1 = isPlayerFault(g1Res, 'p1');
    const p1FaultG2 = isPlayerFault(g2Res, 'p2');
    const p2FaultG1 = isPlayerFault(g1Res, 'p2');
    const p2FaultG2 = isPlayerFault(g2Res, 'p1');

    this.stateDb.recordAgentGameResult(e1.versionId, p1FaultG1, completedAt);
    this.stateDb.recordAgentGameResult(e1.versionId, p1FaultG2, completedAt);
    this.stateDb.recordAgentGameResult(e2.versionId, p2FaultG1, completedAt);
    this.stateDb.recordAgentGameResult(e2.versionId, p2FaultG2, completedAt);

    if (p1FaultG1 || p1FaultG2) {
      await this.checkAndQuarantineIfFaulty(
        e1.versionId,
        p1FaultG2 ? g2Res.endReason : g1Res.endReason
      );
    }
    if (p2FaultG1 || p2FaultG2) {
      await this.checkAndQuarantineIfFaulty(
        e2.versionId,
        p2FaultG2 ? g2Res.endReason : g1Res.endReason
      );
    }

    return {matchId, ladderId: ladder.id, archivedLadder};
  }
}
