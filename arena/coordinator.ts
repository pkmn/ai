import {execFileSync} from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {PRNGSeed} from '@pkmn/sim';

import * as arena from '../server/arena';
import * as ratings from '../server/ratings';
import * as teams from '../server/teams';
import {root, toID} from '../static/util';

import * as arbiter from './arbiter';
import * as db from './db';
import * as packages from './packages';

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

export interface Options {
  client: arena.Client;
  stateDb: db.Database;
  baselineSpec?: arbiter.AgentLaunchSpec;
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

const FAULT_REASONS = new Set(['crash', 'oom', 'timeout', 'invalid-choice']);

function isPlayerFault(result: arbiter.ArenaGameResult, slot: 'p1' | 'p2'): boolean {
  if (!FAULT_REASONS.has(result.endReason)) return false;
  return (slot === 'p1' && result.winner === 'p2') ||
    (slot === 'p2' && result.winner === 'p1');
}

function isPermanentClientError(err: unknown): boolean {
  const explicitStatus = (err as {status?: unknown} | undefined)?.status;
  let status = typeof explicitStatus === 'number' ? explicitStatus : undefined;
  if (status === undefined && err instanceof Error) {
    const m = /\((\d{3})\):/.exec(err.message);
    if (m) status = Number(m[1]);
  }
  return status !== undefined &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429;
}

export function parsePrngSeed(seedStr: string): PRNGSeed {
  const parts = seedStr.split(',').map(s => s.trim());
  if (parts.length !== 4 || parts.some(p => !/^\d+$/.test(p))) {
    throw new Error(`Invalid PRNG seed "${seedStr}" (expected 4 comma-separated uint16 integers)`);
  }
  const nums = parts.map(Number);
  if (nums.some(n => !Number.isInteger(n) || n < 0 || n > 0xffff)) {
    throw new Error(`Invalid PRNG seed "${seedStr}" (expected 4 comma-separated uint16 integers)`);
  }
  return `${nums[0]},${nums[1]},${nums[2]},${nums[3]}`;
}

export class Coordinator {
  readonly client: arena.Client;
  readonly stateDb: db.Database;
  private readonly baselineSpec: arbiter.AgentLaunchSpec;
  private readonly agentsDir: string;
  private readonly stagingDir: string;
  private readonly coldDir: string;
  private readonly teamsDir: string;
  private readonly archiveLogsDir: string;
  private readonly unpackBin?: string;
  private readonly casDir?: string;
  private readonly devMode: boolean;
  private readonly maxTurns?: number;
  private readonly exploitProbability: number;
  private readonly formatByLadderId: Map<string, string>;
  private readonly randomInt: (max: number) => number;
  private readonly harvestedCache = new Map<string, teams.HarvestedPoolEntry[]>();
  private heartbeatSeq = 0;

  constructor(options: Options) {
    this.client = options.client;
    this.stateDb = options.stateDb;
    this.baselineSpec = options.baselineSpec ?? {
      mode: 'native',
      target: fs.existsSync('/opt/arena/bin/baseline')
        ? '/opt/arena/bin/baseline'
        : root('arena', 'bin', 'baseline'),
    };
    this.agentsDir = options.agentsDir ?? packages.AGENTS_DIR;
    this.stagingDir = options.stagingDir ?? packages.STAGING_DIR;
    this.coldDir = options.coldDir ?? packages.COLD_AGENTS_DIR;
    this.teamsDir = options.teamsDir ?? '/opt/arena/teams';
    this.archiveLogsDir = options.archiveLogsDir ?? '/Volumes/Archive/logs';
    this.unpackBin = options.unpackBin;
    this.casDir = options.casDir;
    this.devMode = options.devMode ?? process.env.ARENA_DEV === '1';
    this.maxTurns = options.maxTurns;
    this.exploitProbability = options.exploitProbability ?? 0.45;
    this.formatByLadderId = new Map(options.formatByLadderId ?? []);
    this.randomInt = options.randomInt ?? (max => crypto.randomInt(0, max));
  }

  private randomPrngSeed(): PRNGSeed {
    const s0 = this.randomInt(0x10000);
    const s1 = this.randomInt(0x10000);
    const s2 = this.randomInt(0x10000);
    const s3 = this.randomInt(0x10000);
    return `${s0},${s1},${s2},${s3}`;
  }

  private resolveLaunchSpec(mode: db.ExecutionMode, target: string): arbiter.AgentLaunchSpec {
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
        this.stateDb.deleteOutbox(entry.id);
        flushed++;
      } catch (err) {
        if (isPermanentClientError(err)) {
          console.error(`Dropping permanently rejected outbox entry #${entry.id}:`, err);
          this.stateDb.deleteOutbox(entry.id);
          continue;
        }
        // Tunnel still unreachable or transient error; preserve FIFO order for next retry
        break;
      }
    }
    return flushed;
  }

  async recoverIncompleteMatches(): Promise<{
    aborted: string[];
    resumed: string[];
  }> {
    if (!this.devMode) {
      for (const slot of ['p1', 'p2'] as const) {
        try {
          execFileSync('/opt/arena/bin/arena', ['cleanup', slot], {timeout: 15_000});
        } catch {}
      }
    }
    const incomplete = this.stateDb.listIncompleteMatchCheckpoints();
    const aborted: string[] = [];
    const resumed: string[] = [];

    for (const cp of incomplete) {
      if (cp.status === 'in-progress') {
        this.stateDb.markMatchCheckpointStatus(cp.id, 'aborted');
        aborted.push(cp.id);
      } else if (cp.status === 'g1-complete') {
        await this.resumeAndCompleteGame2(cp);
        resumed.push(cp.id);
      }
    }

    return {aborted, resumed};
  }

  async processPendingSubmissions(
    laddersById?: ReadonlyMap<string, LadderSnapshot>
  ): Promise<number> {
    const {ladders, submissions} = await this.client.getPendingSubmissions({target: 'ladder'});
    const pendingMetaById = new Map<string, {format: string; team: db.TeamMode}>();
    for (const l of ladders) {
      pendingMetaById.set(l.id, {format: l.format, team: l.team});
      this.formatByLadderId.set(l.id, l.format);
    }
    let processed = 0;

    for (const sub of submissions) {
      // Tournament-only submissions target GCP linux/amd64 Spot GPU workers, not Mac mini arm64.
      if (sub.ladders.length === 0 && sub.tournaments.length > 0) continue;
      processed++;
      const mode = packages.toExecutionMode(sub.package);
      const targetId = packages.formatAgentTargetId(sub.agentSlug, sub.version, sub.versionId);
      const target = targetId;

      let unpackedBytes: number;
      try {
        if (mode === 'container') {
          unpackedBytes = packages.pullAndVerifyOciImage(
            sub.url,
            targetId,
            sub.authToken,
            this.stagingDir,
            sub.sha256
          );
        } else {
          unpackedBytes = await packages.downloadAndUnpackBundle({
            url: sub.url,
            expectedSha256: sub.sha256,
            agentTargetId: targetId,
            authToken: sub.authToken,
            stagingDir: this.stagingDir,
            agentsDir: this.agentsDir,
            unpackBin: this.unpackBin,
            casDir: this.casDir,
            allowPrivateUrls: this.devMode,
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

      const candidateSpec = this.resolveLaunchSpec(mode, target);
      const targetsToTest: Array<{ladderId: string; format: string; team: db.TeamMode}> = [];
      const seenFormats = new Set<string>();
      for (const lid of sub.ladders) {
        const pendingMeta = pendingMetaById.get(lid);
        const snapMeta = laddersById?.get(lid);
        const format = pendingMeta?.format ??
          snapMeta?.format ??
          this.formatByLadderId.get(lid) ??
          lid;
        const team = pendingMeta?.team ?? snapMeta?.team ?? 'random';
        if (!seenFormats.has(format)) {
          seenFormats.add(format);
          targetsToTest.push({ladderId: lid, format, team});
        }
      }
      if (targetsToTest.length === 0) {
        targetsToTest.push({
          ladderId: 'gen9randombattle',
          format: 'gen9randombattle',
          team: 'random',
        });
      }

      const smokeStartMillis = Date.now();
      let maxTurnMillis = 0;
      let maxPeakRam = 64;
      let smokeError: string | undefined;

      for (const item of targetsToTest) {
        let t1Packed: string;
        let t2Packed: string;
        const subTeams = sub.teamsByLadder?.[item.ladderId];
        if (item.team === 'pools' && subTeams && subTeams.length >= 2) {
          t1Packed = subTeams[0];
          t2Packed = subTeams[1];
        } else if (item.team === 'harvested') {
          const pool = await this.loadHarvestedTeamsForLadder(item.ladderId, item.format);
          t1Packed = pool[0].canonicalPacked;
          t2Packed = pool[1 % pool.length].canonicalPacked;
        } else {
          const pair = teams.sampleRandomPair(item.format, '1,2,3,4', '5,6,7,8');
          t1Packed = pair.t1Packed;
          t2Packed = pair.t2Packed;
        }

        const game = new arbiter.TimeSlicedArenaGame({
          format: item.format,
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
        if (isPlayerFault(res, 'p1') || res.endReason === 'arbiter-stall') {
          smokeError = `Smoke test failed in ${item.format}: ${res.endReason}`;
          break;
        }
        if (res.p1MeanTurnMillis > maxTurnMillis) maxTurnMillis = res.p1MeanTurnMillis;
        if (res.p1PeakRam > maxPeakRam) maxPeakRam = res.p1PeakRam;
      }

      const smokeDurationMillis = Math.max(1, Date.now() - smokeStartMillis);

      if (smokeError) {
        if (mode === 'native') {
          fs.rmSync(path.join(this.agentsDir, targetId), {recursive: true, force: true});
        } else {
          try {
            execFileSync('podman', ['rmi', '-f', targetId], {timeout: 30_000});
          } catch {}
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

      packages.evictColdAgentsIfNeeded(this.stateDb, {
        agentsDir: this.agentsDir,
        coldDir: this.coldDir,
        pinnedVersionIds: new Set([sub.versionId]),
      });

      await this.reportSubmissionOrOutbox({
        versionId: sub.versionId,
        smokeStatus: 'passed',
        unpackedBytes,
        smokeDurationMillis,
        smokeTurnMillis: Math.max(1, maxTurnMillis),
        smokePeakRam: maxPeakRam,
      });
    }

    return processed;
  }

  private async reportSubmissionOrOutbox(payload: arena.SubmissionStatusPayload) {
    try {
      await this.client.reportSubmissionStatus(payload);
    } catch (err) {
      if (isPermanentClientError(err)) {
        console.error('Submission status permanently rejected by server:', err);
        return;
      }
      this.stateDb.enqueueOutbox('submission-status', payload);
    }
  }

  private async completeMatchOrOutbox(
    payload: arena.MatchCompletePayload
  ): Promise<{archivedLadder: boolean}> {
    try {
      return await this.client.completeMatch(payload);
    } catch (err) {
      if (isPermanentClientError(err)) {
        console.error('Match completion permanently rejected by server:', err);
        return {archivedLadder: false};
      }
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
    p2AgentId: number
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
    const seed1 = this.randomPrngSeed();
    const seed2 = this.randomPrngSeed();
    const {t1Packed, t2Packed} = teams.sampleRandomPair(ladder.format, seed1, seed2);
    return {t1: t1Packed, t2: t2Packed};
  }

  private writeArchivedGameLog(
    ladderId: string,
    matchId: string,
    suffix: 'a' | 'b',
    log: string,
    daySeconds: number
  ) {
    try {
      const day = new Date(daySeconds * 1000).toISOString().slice(0, 10);
      const dir = path.join(this.archiveLogsDir, ladderId, day);
      fs.mkdirSync(dir, {recursive: true});
      fs.writeFileSync(path.join(dir, `${matchId}${suffix}.log`), log, 'utf8');
    } catch {}
  }

  private async checkAndQuarantineIfFaulty(versionId: number, lastReason: string) {
    const row = this.stateDb.getLocalAgent(versionId);
    if (!row) return;

    const faultRate = row.totalGames > 0 ? row.totalFaults / row.totalGames : 0;
    // 5 consecutive matches = 10 consecutive games (`recordAgentGameResult` is per-game).
    if (row.consecutiveFaults >= 10 || (row.totalGames >= 10 && faultRate > 0.20)) {
      await this.reportSubmissionOrOutbox({
        versionId,
        smokeStatus: 'quarantined',
        smokeError:
          `Auto-quarantined (${row.totalFaults}/${row.totalGames} faults, ` +
          `${row.consecutiveFaults} consecutive; last=${lastReason})`,
      });
    }
  }

  private async resumeAndCompleteGame2(cp: db.LocalMatchCheckpoint): Promise<string> {
    packages.ensureAgentResident(this.stateDb, cp.p1VersionId, {
      agentsDir: this.agentsDir,
      coldDir: this.coldDir,
    });
    packages.ensureAgentResident(this.stateDb, cp.p2VersionId, {
      agentsDir: this.agentsDir,
      coldDir: this.coldDir,
    });
    packages.evictColdAgentsIfNeeded(this.stateDb, {
      agentsDir: this.agentsDir,
      coldDir: this.coldDir,
      pinnedVersionIds: new Set([cp.p1VersionId, cp.p2VersionId]),
    });

    const p1Spec = this.resolveLaunchSpec(cp.p1Mode, cp.p1Target);
    const p2Spec = this.resolveLaunchSpec(cp.p2Mode, cp.p2Target);
    const seed = parsePrngSeed(cp.seed);
    const g1Outcome = cp.g1Outcome ?? 'T';

    // Game 2 swaps sides and teams: P2 sits in slot p1 with T1, P1 sits in slot p2 with T2
    const g2Game = new arbiter.TimeSlicedArenaGame({
      format: cp.format,
      seed,
      p1Spec: p2Spec,
      p2Spec: p1Spec,
      p1TeamPacked: cp.p1TeamPacked,
      p2TeamPacked: cp.p2TeamPacked,
      maxTurns: this.maxTurns,
      devMode: this.devMode,
      onTurn: async info => {
        this.heartbeatSeq++;
        await this.client.sendHeartbeat({
          heartbeatSeq: this.heartbeatSeq,
          matchId: cp.id,
          ladderId: cp.ladderId,
          format: cp.format,
          game: 2,
          turn: info.turn,
          activeSlot: info.activeSlot === 'p1' ? 'p2' : 'p1',
          turnStartedAt: info.turnStartedAt,
          turnBudgetSeconds: info.turnBudgetSeconds,
          incrementSeconds: info.incrementSeconds,
          game1Summary: {
            ...(g1Outcome === 'W'
              ? {winnerSlot: 'p1' as const}
              : g1Outcome === 'L'
                ? {winnerSlot: 'p2' as const}
                : {}),
            turns: cp.g1Turns ?? 1,
          },
          p1: {
            slug: cp.p1Slug,
            name: cp.p1Name,
            version: cp.p1Version,
            bankSeconds: info.p2BankSeconds,
            lastTurnMillis: info.p2LastTurnMillis,
            meanTurnMillis: info.p2MeanTurnMillis,
            ram: cp.g1P1Ram ?? 64,
            ...(cp.p2TeamLabel ? {team: cp.p2TeamLabel} : {}),
          },
          p2: {
            slug: cp.p2Slug,
            name: cp.p2Name,
            version: cp.p2Version,
            bankSeconds: info.p1BankSeconds,
            lastTurnMillis: info.p1LastTurnMillis,
            meanTurnMillis: info.p1MeanTurnMillis,
            ram: cp.g1P2Ram ?? 64,
            ...(cp.p1TeamLabel ? {team: cp.p1TeamLabel} : {}),
          },
        }).catch(() => undefined);
      },
    });
    const g2Res = await g2Game.run();
    const g2OutcomeForP1: ratings.GameOutcome =
      g2Res.winner === 'p2' ? 'W' : g2Res.winner === 'p1' ? 'L' : 'T';

    const category: ratings.MatchCategory = `${g1Outcome}${g2OutcomeForP1}`;
    const now = Math.floor(Date.now() / 1000);
    this.writeArchivedGameLog(cp.ladderId, cp.id, 'b', g2Res.omniscientLog, cp.startedAt || now);

    const p1PeakRam = Math.max(cp.g1P1Ram ?? 64, g2Res.p2PeakRam);
    const p2PeakRam = Math.max(cp.g1P2Ram ?? 64, g2Res.p1PeakRam);
    const p1MeanTurnMillis = Math.round(
      ((cp.g1P1TurnMillis ?? 0) + g2Res.p2MeanTurnMillis) / 2
    );
    const p2MeanTurnMillis = Math.round(
      ((cp.g1P2TurnMillis ?? 0) + g2Res.p1MeanTurnMillis) / 2
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
        game1Turns: cp.g1Turns ?? 1,
        game2Turns: g2Res.turns,
        game1EndReason: cp.g1EndReason ?? 'win',
        game2EndReason: g2Res.endReason,
        p1PeakRam,
        p2PeakRam,
        p1Game1BankSeconds: cp.g1P1BankSeconds ?? 0,
        p1Game2BankSeconds: g2Res.p2BankSeconds,
        p2Game1BankSeconds: cp.g1P2BankSeconds ?? 0,
        p2Game2BankSeconds: g2Res.p1BankSeconds,
        p1MeanTurnMillis,
        p2MeanTurnMillis,
        completedAt: now,
      },
    };

    await this.completeMatchOrOutbox(payload);
    this.stateDb.markMatchCheckpointStatus(cp.id, 'complete', now);

    const g1EndReason = cp.g1EndReason ?? 'win';
    const g1Fault = FAULT_REASONS.has(g1EndReason);
    const p1FaultG1 = g1Fault && g1Outcome === 'L';
    const p2FaultG1 = g1Fault && g1Outcome === 'W';
    const p1FaultG2 = isPlayerFault(g2Res, 'p2');
    const p2FaultG2 = isPlayerFault(g2Res, 'p1');

    this.stateDb.recordAgentGameResult(cp.p1VersionId, p1FaultG1, now);
    this.stateDb.recordAgentGameResult(cp.p1VersionId, p1FaultG2, now);
    this.stateDb.recordAgentGameResult(cp.p2VersionId, p2FaultG1, now);
    this.stateDb.recordAgentGameResult(cp.p2VersionId, p2FaultG2, now);

    if (p1FaultG1 || p1FaultG2) {
      await this.checkAndQuarantineIfFaulty(
        cp.p1VersionId,
        p1FaultG2 ? g2Res.endReason : g1EndReason
      );
    }
    if (p2FaultG1 || p2FaultG2) {
      await this.checkAndQuarantineIfFaulty(
        cp.p2VersionId,
        p2FaultG2 ? g2Res.endReason : g1EndReason
      );
    }

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
      const rosterIds = ladder.team === 'pools' && ladder.roster
        ? new Set(ladder.roster.map(r => r.agentId))
        : undefined;
      const state = arena.buildLadderMatchState(
        ladder,
        ladder.entries,
        ladder.pairAggregates,
        this.stateDb.getLastGlobalMatchSequence(ladder.id),
        rosterIds,
        packages.computeResidencyMultipliers(
          ladder.entries.map(e => e.versionId),
          this.stateDb
        )
      );
      if (state) candidates.push({ladder, state});
    }

    if (candidates.length === 0) return undefined;

    const globalSeq = this.stateDb.getGlobalMatchCount();
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
    const a1 = packages.ensureAgentResident(this.stateDb, e1.versionId, {
      agentsDir: this.agentsDir,
      coldDir: this.coldDir,
    });
    const a2 = packages.ensureAgentResident(this.stateDb, e2.versionId, {
      agentsDir: this.agentsDir,
      coldDir: this.coldDir,
    });
    if (!a1 || !a2) {
      throw new Error(
        `Missing local agent registration for versionId ${e1.versionId} or ${e2.versionId}`
      );
    }
    packages.evictColdAgentsIfNeeded(this.stateDb, {
      agentsDir: this.agentsDir,
      coldDir: this.coldDir,
      pinnedVersionIds: new Set([e1.versionId, e2.versionId]),
    });

    const seq = this.stateDb.nextMatchSequence(ladder.id);
    const prefix = ladder.slot === 'vgc' ? 'vgc' : ladder.format;
    const matchId = `${prefix}-${String(seq).padStart(7, '0')}`;
    const seedStr = this.randomPrngSeed();
    const sampled = await this.sampleMatchTeams(ladder, e1.agentId, e2.agentId);
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
    const g1Game = new arbiter.TimeSlicedArenaGame({
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
    this.writeArchivedGameLog(ladder.id, matchId, 'a', g1Res.omniscientLog, now);

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
    const g2Game = new arbiter.TimeSlicedArenaGame({
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
    const category: ratings.MatchCategory = `${g1Res.outcome}${g2OutcomeForP1}`;
    const completedAt = Math.floor(Date.now() / 1000);
    this.writeArchivedGameLog(ladder.id, matchId, 'b', g2Res.omniscientLog, now);

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
    this.stateDb.markMatchCheckpointStatus(matchId, 'complete', completedAt);

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
