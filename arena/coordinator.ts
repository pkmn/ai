import {execFileSync} from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type {PRNGSeed} from '@pkmn/sim';

import {
  SMOKE_TESTS_PER_CYCLE,
  SMOKE_TEST_CYCLE_INTERVAL,
  SmokeCadence,
} from '../db/config';
import {Input as SmokeDiagnosticInput} from '../db/smoke-diagnostics';
import * as arena from '../server/arena';
import * as ratings from '../server/ratings';
import * as sim from '../server/sim';
import type * as system from '../server/system';
import * as teams from '../server/teams';
import {copyFileAtomic, formatUtcDate, root, toID, writeFileAtomic} from '../static/util';

import * as arbiter from './arbiter';
import * as db from './db';
import * as engine from './engine';
import * as packages from './packages';

export type ActiveRosterEntry = arena.ActiveRosterEntry;
export type LadderSnapshot = arena.PlayableLadderSnapshot;

export class SmokeCadenceTracker {
  private cyclesSinceSmoke: number;

  constructor() {
    // Start ready so the first pending submission after daemon startup runs immediately
    // without waiting `everyCycles` matches.
    this.cyclesSinceSmoke = Number.MAX_SAFE_INTEGER;
  }

  budgetForCycle(cadence?: SmokeCadence): number {
    const maxPerCycle = cadence?.maxPerCycle ?? SMOKE_TESTS_PER_CYCLE;
    const everyCycles = cadence?.everyCycles ?? SMOKE_TEST_CYCLE_INTERVAL;
    if (maxPerCycle <= 0) return 0;
    return this.cyclesSinceSmoke >= everyCycles ? maxPerCycle : 0;
  }

  recordCycle(ingested: number, playedMatch: boolean) {
    if (ingested > 0) {
      this.cyclesSinceSmoke = playedMatch ? 1 : Number.MAX_SAFE_INTEGER;
    } else if (playedMatch) {
      this.cyclesSinceSmoke = Math.min(Number.MAX_SAFE_INTEGER, this.cyclesSinceSmoke + 1);
    } else {
      this.cyclesSinceSmoke = Number.MAX_SAFE_INTEGER;
    }
  }
}

interface MirrorPlayer {
  versionId: number;
  agentId: number;
  slug: string;
  name: string;
  version: string;
  spec: arbiter.AgentLaunchSpec;
  teamPacked: string;
  teamLabel?: string;
}

interface MirrorGameStats {
  bankSeconds: number;
  peakRam: number;
  cpuCores?: number;
  initMillis?: number;
  teamPreviewMillis?: number;
  meanTurnMillis: number;
  errors?: engine.ProtocolErrorCounts;
  pokemon?: unknown[];
}

function summarizeGameStats(g: MirrorGameStats) {
  return {
    bankSeconds: g.bankSeconds,
    peakRam: g.peakRam,
    cpuCores: g.cpuCores,
    initMillis: Math.round(g.initMillis ?? 0),
    teamPreviewMillis: g.teamPreviewMillis,
    meanTurnMillis: Math.round(g.meanTurnMillis),
    errors: g.errors,
  };
}

function meanOptionalCores(a?: number, b?: number): number | undefined {
  if (a !== undefined && b !== undefined) return Math.round(((a + b) / 2) * 10) / 10;
  return a ?? b;
}

function sumProtocolErrors(
  a?: engine.ProtocolErrorCounts,
  b?: engine.ProtocolErrorCounts
): engine.ProtocolErrorCounts | undefined {
  if (!a && !b) return undefined;
  const merged: engine.ProtocolErrorCounts = {
    invalidCantMove: (a?.invalidCantMove ?? 0) + (b?.invalidCantMove ?? 0),
    invalidCantSwitch: (a?.invalidCantSwitch ?? 0) + (b?.invalidCantSwitch ?? 0),
    invalidTarget: (a?.invalidTarget ?? 0) + (b?.invalidTarget ?? 0),
    invalidOther: (a?.invalidOther ?? 0) + (b?.invalidOther ?? 0),
    unavailableChoices: (a?.unavailableChoices ?? 0) + (b?.unavailableChoices ?? 0),
  };
  const total = merged.invalidCantMove + merged.invalidCantSwitch +
    merged.invalidTarget + merged.invalidOther + merged.unavailableChoices;
  return total > 0 ? merged : undefined;
}

interface MirrorGame1Summary {
  outcome: ratings.GameOutcome;
  turns: number;
  endReason: string;
  p1: MirrorGameStats;
  p2: MirrorGameStats;
  log?: string;
}

interface MirrorMatchContext {
  id: string;
  ladderId: string;
  format: string;
  version?: string;
  teamMode: db.TeamMode;
  seed: PRNGSeed;
  startedAt: number;
  p1: MirrorPlayer;
  p2: MirrorPlayer;
}

interface MirrorHeartbeatSide {
  bankSeconds: number;
  initMillis?: number;
  teamPreviewMillis?: number;
  lastTurnMillis: number;
  meanTurnMillis: number;
  ram: number;
  cpuCores?: number;
  team?: string;
  info?: arena.PublicAgentInfo;
}

interface MirrorHeartbeatFrame {
  game: 1 | 2;
  phase?: arena.LivePhase;
  turn: number;
  activeSlot: 'p1' | 'p2';
  turnStartedAt: number;
  turnBudgetSeconds: number;
  incrementSeconds: number;
  midTurnInfo?: boolean;
  game1Summary?: arena.LiveGameSummaryInput;
  p1: MirrorHeartbeatSide;
  p2: MirrorHeartbeatSide;
  viewer?: {
    lines?: string[];
    p1Pokemon?: unknown[];
    p2Pokemon?: unknown[];
  };
  winHistory?: arena.WinHistoryPoint[];
}

function swapWinHistory(
  history: readonly arena.WinHistoryPoint[] | undefined
): arena.WinHistoryPoint[] | undefined {
  if (!history || history.length === 0) return undefined;
  return history.map(pt => ({
    turn: pt.turn,
    ...(pt.p2 !== undefined ? {p1: pt.p2} : {}),
    ...(pt.p1 !== undefined ? {p2: pt.p1} : {}),
  }));
}

export interface Options {
  client: arena.Client;
  stateDb: db.Database;
  baselineSpec?: arbiter.AgentLaunchSpec;
  rootDir?: string;
  devMode?: boolean;
  maxTurns?: number;
  getSystemInfo?: () =>
    Promise<system.ArenaSystemInfo | undefined> | system.ArenaSystemInfo | undefined;
  diagnosticWallCapMillis?: number;
}

interface LadderFaultCounter {
  totalGames: number;
  totalFaults: number;
  consecutiveFaults: number;
}

const {FAULT_REASONS, INFRA_VOID_REASONS} = engine;
const BROKEN_AGENT_COOLDOWN_SECONDS = 300;
const EXPLOIT_PROBABILITY = 0.45;
const randomInt = (max: number) => crypto.randomInt(0, max);

function isPlayerFault(result: arbiter.ArenaGameResult, slot: 'p1' | 'p2'): boolean {
  if (!FAULT_REASONS.has(result.endReason)) return false;
  return (slot === 'p1' && result.winner === 'p2') ||
    (slot === 'p2' && result.winner === 'p1');
}

function getHttpErrorStatus(err: unknown): number | undefined {
  const status = (err as {status?: unknown} | undefined)?.status;
  return typeof status === 'number' ? status : undefined;
}

// Only drop outbox payloads on definitive schema/duplicate rejections (`400`, `409`, `422`).
// Auth/tunnel/proxy errors (`401`, `403`, `404`), timeouts (`408`), rate limits (`429`), and 5xx
// errors remain queued so transient Nginx reloads, Cloudflare Tunnel flaps, or secret rotations
// never lose completed matches or smoke-test reports.
function isPermanentClientError(err: unknown): boolean {
  const status = getHttpErrorStatus(err);
  return status === 400 || status === 409 || status === 422;
}

export function parsePrngSeed(seedStr: string): PRNGSeed {
  const trimmed = seedStr.trim();
  if (/^sodium,[0-9a-f]{64}$/i.test(trimmed)) {
    return `sodium,${trimmed.slice(7).toLowerCase()}`;
  }
  const parts = trimmed.split(',').map(s => s.trim());
  if (parts.length !== 4 || parts.some(p => !/^\d+$/.test(p))) {
    throw new Error(
      `Invalid PRNG seed '${seedStr}' (expected 'sodium,<64-hex>' or 4 uint16 integers)`
    );
  }
  const nums = parts.map(Number);
  if (nums.some(n => !Number.isInteger(n) || n < 0 || n > 0xffff)) {
    throw new Error(
      `Invalid PRNG seed '${seedStr}' (expected 'sodium,<64-hex>' or 4 uint16 integers)`
    );
  }
  return `${nums[0]},${nums[1]},${nums[2]},${nums[3]}`;
}

export class Coordinator {
  readonly client: arena.Client;
  readonly stateDb: db.Database;
  private readonly baselineSpec: arbiter.AgentLaunchSpec;
  private readonly dirs: packages.Dirs;
  private readonly devMode: boolean;
  private readonly maxTurns?: number;
  private readonly getSystemInfo?: () =>
    Promise<system.ArenaSystemInfo | undefined> | system.ArenaSystemInfo | undefined;
  private readonly diagnosticWallCapMillis?: number;
  private readonly versionByLadderId = new Map<string, string>();
  private readonly teamModeByLadderId = new Map<string, db.TeamMode>();
  private readonly harvestedCache = new Map<string, teams.HarvestedPoolEntry[]>();
  private readonly lastArchivedDayByLadder = new Map<string, string>();
  private readonly archivePublishCooldownByLadder = new Map<string, number>();
  private readonly faultCounters = new Map<number, LadderFaultCounter>();
  private readonly quarantinedVersions = new Set<number>();
  private readonly brokenUntilByVersion = new Map<number, number>();
  private heartbeatSeq = 0;
  private draining = false;

  constructor(options: Options) {
    this.client = options.client;
    this.stateDb = options.stateDb;
    this.baselineSpec = options.baselineSpec ?? {
      mode: 'native',
      target: root('arena', 'bin', 'baseline'),
    };
    this.devMode = options.devMode ?? process.env.ARENA_DEV === '1';
    this.dirs = options.rootDir ? packages.dirsForRoot(options.rootDir) : packages.PROD_DIRS;
    this.maxTurns = options.maxTurns;
    this.getSystemInfo = options.getSystemInfo;
    this.diagnosticWallCapMillis = options.diagnosticWallCapMillis;
  }

  private cleanupUnpackedAgent(mode: db.ExecutionMode, targetId: string) {
    if (mode === 'native') {
      fs.rmSync(path.join(this.dirs.agents, targetId), {recursive: true, force: true});
      if (fs.existsSync(this.dirs.cas)) {
        packages.pruneUnreferencedCasBlobs(this.dirs.cas, this.dirs.agents);
      }
    } else {
      try {
        execFileSync('podman', ['rmi', '-f', targetId], {timeout: 30_000});
      } catch {}
    }
  }

  private isLocalArtifactPresent(mode: db.ExecutionMode, targetId: string): boolean {
    if (mode === 'native') {
      return fs.existsSync(path.join(this.dirs.agents, targetId, 'run'));
    }
    if (this.devMode) return true;
    try {
      execFileSync('podman', ['image', 'exists', targetId], {timeout: 15_000});
      return true;
    } catch {
      return false;
    }
  }

  private getOutboxSubmissionVersionIds(): Set<number> {
    const ids = new Set<number>();
    for (const entry of this.stateDb.listOutbox()) {
      if (entry.endpoint !== 'submission-status') continue;
      try {
        const parsed = JSON.parse(entry.payloadJson) as {versionId?: number};
        if (typeof parsed.versionId === 'number') ids.add(parsed.versionId);
      } catch {}
    }
    return ids;
  }

  // Promotes locally staged builds to hot + cold-archived once activated (avoiding a second pull
  // and allowing one-time auth tokens to be scrubbed right after the diagnostic fetch), falls back
  // to fetching activated artifacts if a staged copy is absent on disk, prunes discarded local
  // staged builds, and deletes local/archived bundles for versions wiped from the server DB.
  async syncActivatedAgents(
    versionIds: readonly number[],
    opts: {
      stagedVersionIds?: readonly number[];
      knownVersionIds?: readonly number[];
      shouldYield?: () => boolean;
    } = {}
  ): Promise<number> {
    if (this.draining || opts.shouldYield?.()) return 0;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const activatedSet = new Set(versionIds);
    let installed = 0;

    for (const versionId of activatedSet) {
      if (this.draining || opts.shouldYield?.()) break;
      const local = this.stateDb.getLocalAgent(versionId);
      if (local && local.residency !== 'staged') continue;
      const brokenUntil = this.brokenUntilByVersion.get(versionId);
      if (brokenUntil !== undefined && nowSeconds < brokenUntil) continue;

      if (local?.residency === 'staged' && this.isLocalArtifactPresent(local.mode, local.target)) {
        try {
          if (local.mode === 'native' || !this.devMode) {
            packages.archiveColdAgent({mode: local.mode, target: local.target}, {dirs: this.dirs});
          }
          this.stateDb.setAgentResidency(versionId, 'hot', nowSeconds);
          this.brokenUntilByVersion.delete(versionId);
          try {
            packages.evictColdAgentsIfNeeded(this.stateDb, {
              dirs: this.dirs,
              pinnedVersionIds: new Set([versionId]),
            });
          } catch (evictErr) {
            console.error(
              `Failed evicting cold agents after archiving version ${versionId}:`,
              evictErr
            );
          }
          await this.client.markArtifactArchived?.(versionId).catch(() => undefined);
          installed++;
        } catch (err) {
          this.brokenUntilByVersion.set(versionId, nowSeconds + BROKEN_AGENT_COOLDOWN_SECONDS);
          const msg = err instanceof Error ? err.message : String(err);
          this.notifyAlert({
            key: `activation-pull-${versionId}`,
            message: `Failed archiving activated version ${local.slug} ${local.version}`,
            detail: msg,
          });
        }
        continue;
      }

      if (!this.client.getActivatedArtifact) continue;

      let artifact: arena.ActivatedArtifact;
      try {
        artifact = await this.client.getActivatedArtifact(versionId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.brokenUntilByVersion.set(versionId, nowSeconds + BROKEN_AGENT_COOLDOWN_SECONDS);
        this.notifyAlert({
          key: `activation-fetch-${versionId}`,
          message: `Failed fetching activated artifact metadata for version ${versionId}`,
          detail: msg,
        });
        continue;
      }

      const mode = packages.toExecutionMode(artifact.package);
      const targetId = packages.formatAgentTargetId(
        artifact.agentSlug,
        artifact.version,
        artifact.versionId
      );
      try {
        const unpackedBytes = mode === 'container'
          ? packages.pullAndVerifyOciImage({
            imageRef: artifact.url,
            agentTargetId: targetId,
            expectedSha256: artifact.sha256,
            creds: artifact.authToken,
            dirs: this.dirs,
          })
          : await packages.downloadAndUnpackBundle({
            url: artifact.url,
            expectedSha256: artifact.sha256,
            agentTargetId: targetId,
            authToken: artifact.authToken,
            dirs: this.dirs,
            allowPrivateUrls: this.devMode,
          });
        if (mode === 'native' || !this.devMode) {
          packages.archiveColdAgent({mode, target: targetId}, {dirs: this.dirs});
        }
        this.stateDb.upsertLocalAgent({
          versionId: artifact.versionId,
          agentId: artifact.agentId,
          slug: artifact.agentSlug,
          version: artifact.version,
          mode,
          target: targetId,
          residency: 'hot',
          unpackedBytes,
        });
        this.brokenUntilByVersion.delete(versionId);
        try {
          packages.evictColdAgentsIfNeeded(this.stateDb, {
            dirs: this.dirs,
            pinnedVersionIds: new Set([artifact.versionId]),
          });
        } catch (evictErr) {
          console.error(
            `Failed evicting cold agents after archiving version ${versionId}:`,
            evictErr
          );
        }
        await this.client.markArtifactArchived?.(artifact.versionId).catch(() => undefined);
        installed++;
      } catch (err) {
        this.stateDb.deleteLocalAgent(artifact.versionId);
        this.cleanupUnpackedAgent(mode, targetId);
        this.brokenUntilByVersion.set(versionId, nowSeconds + BROKEN_AGENT_COOLDOWN_SECONDS);
        const msg = err instanceof Error ? err.message : String(err);
        this.notifyAlert({
          key: `activation-pull-${versionId}`,
          message: `Failed archiving activated version ${artifact.agentSlug} ${artifact.version}`,
          detail: msg,
        });
      }
    }

    if (opts.stagedVersionIds !== undefined && !this.draining && !opts.shouldYield?.()) {
      const stagedSet = new Set(opts.stagedVersionIds);
      const outboxIds = this.getOutboxSubmissionVersionIds();
      for (const row of this.stateDb.listLocalAgents('staged')) {
        if (
          activatedSet.has(row.versionId) ||
          stagedSet.has(row.versionId) ||
          outboxIds.has(row.versionId)
        ) {
          continue;
        }
        this.cleanupUnpackedAgent(row.mode, row.target);
        this.stateDb.deleteLocalAgent(row.versionId);
      }
    }

    if (opts.knownVersionIds !== undefined && !this.draining && !opts.shouldYield?.()) {
      const knownSet = new Set(opts.knownVersionIds);
      const outboxIds = this.getOutboxSubmissionVersionIds();
      for (const row of this.stateDb.listLocalAgents()) {
        if (
          knownSet.has(row.versionId) ||
          activatedSet.has(row.versionId) ||
          outboxIds.has(row.versionId)
        ) {
          continue;
        }
        try {
          if (row.residency !== 'staged') {
            packages.deleteColdAgentArchive(row.target, {dirs: this.dirs});
          }
          this.cleanupUnpackedAgent(row.mode, row.target);
          this.stateDb.deleteLocalAgent(row.versionId);
          this.faultCounters.delete(row.versionId);
          this.quarantinedVersions.delete(row.versionId);
          this.brokenUntilByVersion.delete(row.versionId);
        } catch (err) {
          console.error(`Failed pruning wiped version ${row.versionId} (${row.target}):`, err);
        }
      }
    }

    return installed;
  }

  requestDrain() {
    this.draining = true;
  }

  isDraining(): boolean {
    return this.draining;
  }

  private randomPrngSeed(): PRNGSeed {
    return `sodium,${crypto.randomBytes(32).toString('hex')}`;
  }

  private notifyAlert(alert: arena.StaffAlertPayload) {
    Promise.resolve(this.client.sendAlert?.(alert)).catch(() => undefined);
  }

  private resolveLaunchSpec(mode: db.ExecutionMode, target: string): arbiter.AgentLaunchSpec {
    if (mode === 'native' && this.devMode && !path.isAbsolute(target)) {
      return {
        mode: 'native',
        target: path.join(this.dirs.agents, target, 'run'),
      };
    }
    return {mode, target};
  }

  private async sendMatchComplete(
    payload: arena.MatchCompletePayload
  ): Promise<{archivedLadder: boolean}> {
    try {
      return await this.client.completeMatch(payload);
    } catch (err) {
      // If oversized replay logs hit `413 Payload Too Large`, retry once with logs stripped so the
      // authoritative match rating result is still recorded.
      if (
        getHttpErrorStatus(err) === 413 &&
        (payload.game1Log !== undefined || payload.game2Log !== undefined)
      ) {
        return this.client.completeMatch({match: payload.match});
      }
      throw err;
    }
  }

  private async sendSubmissionStatus(payload: arena.SubmissionStatusPayload): Promise<void> {
    try {
      await this.client.reportSubmissionStatus(payload);
    } catch (err) {
      // If oversized diagnostic logs/stderr hit `413 Payload Too Large`, retry once with
      // `diagnostics` stripped so the authoritative submission status never deadlocks the outbox.
      if (getHttpErrorStatus(err) === 413 && payload.diagnostics?.length) {
        const stripped = {...payload};
        delete stripped.diagnostics;
        await this.client.reportSubmissionStatus(stripped);
        return;
      }
      throw err;
    }
  }

  async flushOutbox(): Promise<number> {
    const entries = this.stateDb.listOutbox();
    let flushed = 0;
    for (const entry of entries) {
      try {
        let publishArchivedLadderId: string | undefined;
        if (entry.endpoint === 'match-complete') {
          const payload = JSON.parse(entry.payloadJson) as arena.MatchCompletePayload;
          const res = await this.sendMatchComplete(payload);
          if (res.archivedLadder) {
            const mode = this.teamModeByLadderId.get(payload.match.ladderId);
            if (
              mode === 'random' ||
              mode === 'pools' ||
              (mode === undefined && payload.game2Log !== undefined)
            ) {
              publishArchivedLadderId = payload.match.ladderId;
            }
          }
        } else {
          const payload = JSON.parse(entry.payloadJson) as arena.SubmissionStatusPayload;
          await this.sendSubmissionStatus(payload);
        }
        this.stateDb.deleteOutbox(entry.id);
        flushed++;
        if (publishArchivedLadderId) {
          await this.publishLadderArchive(publishArchivedLadderId);
        }
      } catch (err) {
        if (isPermanentClientError(err)) {
          console.error(`Dropping permanently rejected outbox entry #${entry.id}:`, err);
          this.stateDb.deleteOutbox(entry.id);
          continue;
        }
        const msg = err instanceof Error ? err.message : String(err);
        this.stateDb.recordOutboxFailure(entry.id, msg);
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
        try {
          const outcome = await this.resumeAndCompleteGame2(cp);
          if (outcome === 'aborted') {
            aborted.push(cp.id);
          } else {
            resumed.push(cp.id);
          }
        } catch (err) {
          console.error(`Failed to recover g1-complete match ${cp.id}; aborting checkpoint:`, err);
          this.stateDb.markMatchCheckpointStatus(cp.id, 'aborted');
          aborted.push(cp.id);
        }
      }
    }

    return {aborted, resumed};
  }

  async processPendingSubmissions(
    laddersById?: ReadonlyMap<string, LadderSnapshot>,
    maxSubmissions = SMOKE_TESTS_PER_CYCLE,
    shouldYield?: () => boolean
  ): Promise<number> {
    if (this.draining || maxSubmissions <= 0 || shouldYield?.()) return 0;
    const {ladders, submissions} = await this.client.getPendingSubmissions({target: 'ladder'});
    const pendingMetaById = new Map<
      string,
      {
        name: string;
        format: string;
        version?: string;
        team: db.TeamMode;
        smokeTeams?: [string, string];
      }
    >();
    for (const l of ladders) {
      pendingMetaById.set(l.id, {
        name: l.name,
        format: l.format,
        version: l.version,
        team: l.team,
        smokeTeams: l.smokeTeams,
      });
      if (l.version) this.versionByLadderId.set(l.id, l.version);
    }
    let processed = 0;

    for (const sub of submissions) {
      if (this.draining || processed >= maxSubmissions || shouldYield?.()) break;
      // Refresh the 15m server watchdog between submissions so large launch queues stay non-stale.
      const sysInfo = await this.getSystemInfo?.();
      await this.client.sendHeartbeat({
        idle: true,
        ...(sysInfo ? {system: sysInfo} : {}),
      }).catch(() => undefined);
      processed++;
      const mode = packages.toExecutionMode(sub.package);
      const targetId = packages.formatAgentTargetId(sub.agentSlug, sub.version, sub.versionId);
      const target = targetId;

      let unpackedBytes: number;
      try {
        if (mode === 'container') {
          unpackedBytes = packages.pullAndVerifyOciImage({
            imageRef: sub.url,
            agentTargetId: targetId,
            expectedSha256: sub.sha256,
            creds: sub.authToken,
            dirs: this.dirs,
          });
        } else {
          unpackedBytes = await packages.downloadAndUnpackBundle({
            url: sub.url,
            expectedSha256: sub.sha256,
            agentTargetId: targetId,
            authToken: sub.authToken,
            dirs: this.dirs,
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
      const targetsToTest: Array<{
        ladderId: string;
        name: string;
        format: string;
        version?: string;
        team: db.TeamMode;
        smokeTeams?: [string, string];
      }> = [];
      const seenFormats = new Set<string>();
      for (const lid of sub.ladders) {
        const pendingMeta = pendingMetaById.get(lid);
        const meta = pendingMeta ?? laddersById?.get(lid);
        const format = meta?.format ?? lid;
        const version = meta?.version;
        const team = meta?.team ?? 'random';
        const formatKey = `${format}::${version ?? ''}`;
        if (!seenFormats.has(formatKey)) {
          seenFormats.add(formatKey);
          targetsToTest.push({
            ladderId: lid,
            name: pendingMeta?.name ?? format,
            format,
            version,
            team,
            smokeTeams: pendingMeta?.smokeTeams,
          });
        }
      }

      const smokeStartMillis = Date.now();
      const smokeTelemetry: engine.SmokeTelemetry = {
        maxInitMillis: 0,
        maxTurnMillis: 0,
        maxPeakRam: 0,
      };
      const diagnostics: SmokeDiagnosticInput[] = [];
      let smokeError: string | undefined;

      let keepStaged = false;
      try {
        for (const item of targetsToTest) {
          let t1Packed: string;
          let t2Packed: string;
          const subTeams = sub.teamsByLadder?.[item.ladderId];
          if (item.team === 'pools') {
            if (!subTeams || subTeams.length < 2) {
              smokeError =
                `Diagnostic test failed in ${item.format}: missing validated team roster for ` +
                `${item.ladderId}`;
              break;
            }
            t1Packed = subTeams[0];
            t2Packed = subTeams.find(t => t !== t1Packed) ?? subTeams[1];
          } else {
            try {
              if (item.team === 'harvested') {
                // Never fall back to harvested ladder pools in diagnostic tests so private
                // harvested teams cannot leak into exposed diagnostic logs.
                if (!item.smokeTeams || item.smokeTeams.length < 2) {
                  throw new Error(
                    `missing sample team pool for ${item.format} (requires >= 2 teams)`
                  );
                }
                [t1Packed, t2Packed] = item.smokeTeams;
              } else {
                ({t1Packed, t2Packed} = await sim.sampleRandomPair(
                  item.format,
                  '1,2,3,4',
                  '5,6,7,8',
                  item.version
                ));
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              const detail = `Diagnostic test setup fault in ${item.format}: ${msg}`;
              this.notifyAlert({
                key: 'smoke-infra',
                message:
                  `Diagnostic test infrastructure error for ${sub.agentSlug} ${sub.version}`,
                detail,
              });
              throw err;
            }
          }

          const gameStartMillis = Date.now();
          const game = new arbiter.TimeSlicedArenaGame({
            format: item.format,
            version: item.version,
            seed: '1,2,3,4',
            p1: {spec: candidateSpec, teamPacked: t1Packed},
            p2: {spec: candidateSpec, teamPacked: t2Packed},
            sendUtm: item.team !== 'random',
            recordAiLogs: true,
            liveInfo: true,
            maxTurns: this.maxTurns,
            maxWallMillis:
              this.diagnosticWallCapMillis ?? engine.diagnosticWallCapMillis(item.format),
            stderrCapture: engine.DIAGNOSTIC_STDERR_LIMITS,
            devMode: this.devMode,
            onTurn: info => {
              if (!this.client.sendDiagnosticLive) return;
              const p1Label = `${sub.agentName} (P1)`;
              const p2Label = `${sub.agentName} (P2)`;
              const lines = arbiter
                .rewriteBlindPlayerNames(info.omniscientLog, p1Label, p2Label)
                .split('\n');
              return this.client.sendDiagnosticLive({
                versionId: sub.versionId,
                agentId: sub.agentId,
                agentSlug: sub.agentSlug,
                agentName: sub.agentName,
                version: sub.version,
                format: item.format,
                targetName: item.name,
                phase: info.phase,
                turn: info.turn,
                activeSlot: info.activeSlot,
                turnStartedAt: info.turnStartedAt,
                turnBudgetSeconds: info.turnBudgetSeconds,
                incrementSeconds: info.incrementSeconds,
                p1: {
                  name: p1Label,
                  version: sub.version,
                  bankSeconds: info.p1.bankSeconds,
                  thinking: info.activeSlot === 'p1',
                  peakRam: info.p1.ram,
                  ...(info.p1.info !== undefined ? {info: info.p1.info} : {}),
                },
                p2: {
                  name: p2Label,
                  version: sub.version,
                  bankSeconds: info.p2.bankSeconds,
                  thinking: info.activeSlot === 'p2',
                  peakRam: info.p2.ram,
                  ...(info.p2.info !== undefined ? {info: info.p2.info} : {}),
                },
                lines,
                ...(info.winHistory?.length ? {winHistory: info.winHistory} : {}),
              }).then(() => undefined).catch(() => undefined);
            },
          });
          const res = await game.run();
          const gameDurationMillis = Math.max(1, Date.now() - gameStartMillis);
          const diagLog = arbiter.rewriteBlindPlayerNames(
            res.omniscientLog,
            `${sub.agentName} (P1)`,
            `${sub.agentName} (P2)`
          );
          const infoStatus = engine.classifyInfoStatus(
            engine.mergeInfoCompliance(res.p1.infoCompliance, res.p2.infoCompliance)
          );
          diagnostics.push({
            ladderId: item.ladderId,
            format: item.format,
            turns: res.turns,
            endReason: res.endReason,
            durationMillis: gameDurationMillis,
            battleLog: engine.truncateDiagnosticLog(diagLog),
            infoStatus,
            ...(res.p1.stderr ? {p1Stderr: res.p1.stderr} : {}),
            ...(res.p2.stderr ? {p2Stderr: res.p2.stderr} : {}),
            ...(res.p1.cpuCores !== undefined ? {p1CpuCores: res.p1.cpuCores} : {}),
            ...(res.p2.cpuCores !== undefined ? {p2CpuCores: res.p2.cpuCores} : {}),
            ...(res.p1.peakRam > 0 ? {p1PeakRam: Math.round(res.p1.peakRam)} : {}),
            ...(res.p2.peakRam > 0 ? {p2PeakRam: Math.round(res.p2.peakRam)} : {}),
          });

          const verdict = engine.classifySmokeGame(res, {
            label: 'Diagnostic test',
            format: item.format,
            selfPlay: true,
            p1Stderr: res.p1.stderr,
            p2Stderr: res.p2.stderr,
          });
          if (verdict.kind === 'infra') {
            this.notifyAlert({
              key: 'smoke-infra',
              message:
                `Diagnostic test infrastructure error for ${sub.agentSlug} ${sub.version}`,
              detail: verdict.message,
            });
            throw new Error(verdict.message);
          }
          if (verdict.kind === 'fail') {
            smokeError = verdict.message;
            break;
          }
          engine.recordSmokeTelemetry(smokeTelemetry, res.p1);
          engine.recordSmokeTelemetry(smokeTelemetry, res.p2);
        }
        keepStaged = smokeError === undefined;
      } finally {
        // Keep passed ladder builds staged locally on SSD (not yet archived to `/Volumes/Archive`)
        // so Activation archives directly without re-downloading and one-time auth tokens can be
        // scrubbed immediately after diagnostic fetch. Delete failed/errored builds immediately.
        if (!keepStaged) {
          this.cleanupUnpackedAgent(mode, targetId);
        }
        if (this.client.sendDiagnosticLive) {
          await this.client.sendDiagnosticLive({
            done: true,
            agentId: sub.agentId,
            versionId: sub.versionId,
          }).catch(() => undefined);
        }
      }

      const smokeDurationMillis = Math.max(1, Date.now() - smokeStartMillis);

      if (smokeError) {
        await this.reportSubmissionOrOutbox({
          versionId: sub.versionId,
          smokeStatus: 'failed',
          smokeError,
          ...(diagnostics.length ? {diagnostics} : {}),
        });
        continue;
      }

      this.stateDb.upsertLocalAgent({
        versionId: sub.versionId,
        agentId: sub.agentId,
        slug: sub.agentSlug,
        version: sub.version,
        mode,
        target: targetId,
        residency: 'staged',
        unpackedBytes,
      });

      await this.reportSubmissionOrOutbox({
        versionId: sub.versionId,
        smokeStatus: 'staged',
        unpackedBytes,
        smokeDurationMillis,
        smokeInitMillis: Math.max(1, smokeTelemetry.maxInitMillis),
        ...(smokeTelemetry.maxTeamPreviewMillis !== undefined
          ? {smokeTeamPreviewMillis: Math.max(1, smokeTelemetry.maxTeamPreviewMillis)}
          : {}),
        smokeTurnMillis: Math.max(1, smokeTelemetry.maxTurnMillis),
        ...(smokeTelemetry.maxPeakRam > 0 ? {smokePeakRam: smokeTelemetry.maxPeakRam} : {}),
        ...(diagnostics.length ? {diagnostics} : {}),
      });
    }

    return processed;
  }

  private async reportSubmissionOrOutbox(payload: arena.SubmissionStatusPayload) {
    if (this.stateDb.listOutbox(1).length > 0) {
      await this.flushOutbox();
      if (this.stateDb.listOutbox(1).length > 0) {
        this.stateDb.enqueueOutbox('submission-status', payload);
        return;
      }
    }
    try {
      await this.sendSubmissionStatus(payload);
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
    if (this.stateDb.listOutbox(1).length > 0) {
      await this.flushOutbox();
      if (this.stateDb.listOutbox(1).length > 0) {
        this.stateDb.enqueueOutbox('match-complete', payload);
        return {archivedLadder: false};
      }
    }
    try {
      return await this.sendMatchComplete(payload);
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
    if (cached && cached.length >= 2) return cached;

    const localFile = path.join(this.dirs.teams, `${ladderId}.txt`);
    if (fs.existsSync(localFile)) {
      const lines = fs.readFileSync(localFile, 'utf8')
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(Boolean);
      if (lines.length >= 2) {
        const entries = this.toHarvestedEntries(lines, format);
        this.harvestedCache.set(ladderId, entries);
        return entries;
      }
      fs.rmSync(localFile, {force: true});
    }

    const remote = await this.client.getLadderTeams(ladderId);
    const cleanTeams = remote.teams.map(t => t.trim()).filter(Boolean);
    if (cleanTeams.length < 2) {
      throw new Error(`Ladder '${ladderId}' returned fewer than 2 harvested teams`);
    }
    fs.mkdirSync(this.dirs.teams, {recursive: true, mode: 0o700});
    writeFileAtomic(localFile, `${cleanTeams.join('\n')}\n`);
    fs.chmodSync(localFile, 0o600);
    const entries = this.toHarvestedEntries(cleanTeams, format);
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
        randomInt,
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
      const {t1Packed, t2Packed} = teams.sampleHarvestedPair(pool, randomInt);
      return {t1: t1Packed, t2: t2Packed};
    }
    const seed1 = this.randomPrngSeed();
    const seed2 = this.randomPrngSeed();
    const {t1Packed, t2Packed} = await sim.sampleRandomPair(
      ladder.format,
      seed1,
      seed2,
      ladder.version
    );
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
      packages.assertArchiveVolumeMounted(this.dirs.logs);
      const day = formatUtcDate(daySeconds);
      const dir = path.join(this.dirs.logs, ladderId, day);
      fs.mkdirSync(dir, {recursive: true, mode: 0o700});
      fs.writeFileSync(path.join(dir, `${matchId}${suffix}.log`), log, {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch {}
  }

  private readArchivedGameLog(
    ladderId: string,
    matchId: string,
    suffix: 'a' | 'b',
    daySeconds: number
  ): string | undefined {
    try {
      const day = formatUtcDate(daySeconds);
      const file = path.join(this.dirs.logs, ladderId, day, `${matchId}${suffix}.log`);
      if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
    } catch {}
    return undefined;
  }

  // The coordinator owns daily `.7z` log compression for all ladders on UTC day rollover (plus
  // `<ladderId>-logs.tar` assembly/upload for `random` and retired `pools`). `archive.sh` owns
  // only `/Volumes/Archive` mount checks, SQLite `.backup`/zstd, monthly `.tar` rollups, and GCS.
  compressCompletedDays(ladderId: string, excludeDay?: string): boolean {
    const ladderDir = path.join(this.dirs.logs, ladderId);
    if (!fs.existsSync(ladderDir)) return false;

    let compressedAny = false;
    for (const entry of fs.readdirSync(ladderDir, {withFileTypes: true})) {
      if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
      if (excludeDay && entry.name === excludeDay) continue;
      const day = entry.name;
      const yearMonth = day.slice(0, 7);
      const dayDir = path.join(ladderDir, day);
      const logFiles = fs.readdirSync(dayDir).filter(f => f.endsWith('.log'));
      if (!logFiles.length) {
        fs.rmSync(dayDir, {recursive: true, force: true});
        continue;
      }

      const monthDir = path.join(ladderDir, yearMonth);
      fs.mkdirSync(monthDir, {recursive: true, mode: 0o700});
      const dayArchive = path.join(monthDir, `${day}.7z`);
      // Stage `.log` files in internal `this.dirs.staging` so non-Apple Homebrew `7z` never
      // opens external USB `/Volumes/Archive` directly under macOS TCC.
      const stageDir = path.join(this.dirs.staging, `7z-${process.pid}-${Date.now()}`);
      const stageArchive = path.join(stageDir, `${day}.7z`);
      fs.rmSync(stageDir, {recursive: true, force: true});
      try {
        fs.mkdirSync(stageDir, {recursive: true, mode: 0o700});
        for (const f of logFiles) {
          fs.copyFileSync(path.join(dayDir, f), path.join(stageDir, f));
        }
        const sevenZipArgs = this.devMode
          ? ['a', '-t7z', '-m0=lzma2', '-mx=1', '-md=64k', stageArchive, '*.log']
          : [
            'a', '-t7z', '-m0=lzma2', '-mx=9', '-mfb=64', '-md=64m', '-ms=on',
            stageArchive, '*.log',
          ];
        execFileSync('7z', sevenZipArgs, {cwd: stageDir, stdio: 'ignore', timeout: 60_000});
        execFileSync('7z', ['t', stageArchive], {stdio: 'ignore', timeout: 30_000});
        copyFileAtomic(stageArchive, dayArchive);
        fs.rmSync(dayDir, {recursive: true, force: true});
        compressedAny = true;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`Failed to compress daily archive ${dayArchive}:`, err);
        this.notifyAlert({
          key: `archive-7z:${ladderId}`,
          message: `Daily log compression failed for ${ladderId} (${day})`,
          detail: errMsg,
        });
      } finally {
        fs.rmSync(stageDir, {recursive: true, force: true});
      }
    }
    return compressedAny;
  }

  async publishLadderArchive(ladderId: string, excludeDay?: string): Promise<boolean> {
    const ladderDir = path.join(this.dirs.logs, ladderId);
    if (!fs.existsSync(ladderDir)) return false;

    this.compressCompletedDays(ladderId, excludeDay);

    const entries = fs.readdirSync(ladderDir, {withFileTypes: true});
    const archivedMonths = new Set<string>();
    const archiveMembers: string[] = [];
    for (const entry of entries) {
      if (entry.isFile() && /^\d{4}-\d{2}\.tar$/.test(entry.name)) {
        archivedMonths.add(entry.name.slice(0, 7));
        archiveMembers.push(entry.name);
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\d{4}-\d{2}$/.test(entry.name)) continue;
      if (archivedMonths.has(entry.name)) continue;
      const monthDir = path.join(ladderDir, entry.name);
      for (const f of fs.readdirSync(monthDir).sort()) {
        if (f.endsWith('.7z')) archiveMembers.push(path.join(entry.name, f));
      }
    }
    if (archiveMembers.length === 0) return false;
    archiveMembers.sort();

    const tarPath = path.join(ladderDir, `${ladderId}-logs.tar`);
    const tmpTar = `${tarPath}.tmp.${process.pid}`;
    try {
      fs.rmSync(tmpTar, {force: true});
      execFileSync(
        'tar',
        ['-cf', tmpTar, '-C', ladderDir, ...archiveMembers],
        {stdio: 'ignore', timeout: 60_000}
      );
      fs.renameSync(tmpTar, tarPath);
      const bytes = fs.readFileSync(tarPath);
      await this.client.uploadLadderArchive(ladderId, bytes);
      this.archivePublishCooldownByLadder.delete(ladderId);
      return true;
    } catch (err) {
      fs.rmSync(tmpTar, {force: true});
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to build/upload ${ladderId}-logs.tar:`, err);
      this.notifyAlert({
        key: `archive-upload:${ladderId}`,
        message: `Ladder archive upload failed for ${ladderId}`,
        detail: errMsg,
      });
      return false;
    }
  }

  async publishArchivedPoolsLadders(
    ladderIds: readonly string[],
    nowSeconds = Math.floor(Date.now() / 1000)
  ): Promise<number> {
    let published = 0;
    for (const ladderId of ladderIds) {
      const retryAfter = this.archivePublishCooldownByLadder.get(ladderId);
      if (retryAfter !== undefined && nowSeconds < retryAfter) continue;
      const ok = await this.publishLadderArchive(ladderId);
      if (ok) {
        published++;
      } else {
        this.archivePublishCooldownByLadder.set(
          ladderId,
          nowSeconds + BROKEN_AGENT_COOLDOWN_SECONDS
        );
      }
    }
    return published;
  }

  private async maybeArchiveOnDayRollover(
    ladderId: string,
    teamMode: db.TeamMode,
    nowSeconds: number
  ): Promise<void> {
    const today = formatUtcDate(nowSeconds);
    const prev = this.lastArchivedDayByLadder.get(ladderId);
    if (prev === today) return;
    this.lastArchivedDayByLadder.set(ladderId, today);
    const compressed = this.compressCompletedDays(ladderId, today);
    if (teamMode === 'random' && (compressed || prev !== undefined)) {
      await this.publishLadderArchive(ladderId, today);
    }
  }

  private static isFaultThresholdExceeded(counter: LadderFaultCounter): boolean {
    const faultRate = counter.totalGames > 0 ? counter.totalFaults / counter.totalGames : 0;
    // 5 consecutive matches = 10 consecutive games (`recordAgentGameFault` is per-game).
    return counter.consecutiveFaults >= 10 || (counter.totalGames >= 10 && faultRate > 0.20);
  }

  private recordAgentGameFault(
    versionId: number,
    faulted: boolean,
    nowSeconds: number
  ): LadderFaultCounter {
    const persisted = this.stateDb.recordAgentGameResult(versionId, faulted, nowSeconds);
    if (persisted) {
      const counter: LadderFaultCounter = {
        totalGames: persisted.totalGames,
        totalFaults: persisted.totalFaults,
        consecutiveFaults: persisted.consecutiveFaults,
      };
      this.faultCounters.set(versionId, counter);
      return counter;
    }
    let counter = this.faultCounters.get(versionId);
    if (!counter) {
      counter = {totalGames: 0, totalFaults: 0, consecutiveFaults: 0};
      this.faultCounters.set(versionId, counter);
    }
    counter.totalGames++;
    if (faulted) {
      counter.totalFaults++;
      counter.consecutiveFaults++;
    } else {
      counter.consecutiveFaults = 0;
    }
    return counter;
  }

  private async checkAndQuarantineIfFaulty(
    ladderId: string,
    versionId: number,
    lastReason: string
  ) {
    const row = this.stateDb.getLocalAgent(versionId);
    const counter = row
      ? {
        totalGames: row.totalGames,
        totalFaults: row.totalFaults,
        consecutiveFaults: row.consecutiveFaults,
      }
      : (this.faultCounters.get(versionId) ?? {
        totalGames: 0,
        totalFaults: 0,
        consecutiveFaults: 0,
      });

    if (Coordinator.isFaultThresholdExceeded(counter)) {
      this.quarantinedVersions.add(versionId);
      await this.reportSubmissionOrOutbox({
        versionId,
        smokeStatus: 'quarantined',
        smokeError:
          `Auto-quarantined on ${ladderId} (${counter.totalFaults}/${counter.totalGames} faults, ` +
          `${counter.consecutiveFaults} consecutive; last=${lastReason})`,
      });
    }
  }

  private pendingQuarantineVersionIds(): Set<number> {
    const pending = new Set<number>();
    for (const item of this.stateDb.listOutbox()) {
      if (item.endpoint !== 'submission-status') continue;
      try {
        const parsed = JSON.parse(item.payloadJson) as arena.SubmissionStatusPayload;
        if (parsed.smokeStatus === 'quarantined') pending.add(parsed.versionId);
      } catch {}
    }
    return pending;
  }

  private syncQuarantineResets(
    ladders: readonly LadderSnapshot[],
    quarantinedVersionIds: readonly number[] = []
  ) {
    const serverQuarantined = new Set<number>(quarantinedVersionIds);
    for (const ladder of ladders) {
      for (const e of ladder.entries) {
        if (e.role === 'quarantined') serverQuarantined.add(e.versionId);
      }
    }
    for (const vid of serverQuarantined) {
      this.quarantinedVersions.add(vid);
    }

    const pendingOutboxQuarantine = this.pendingQuarantineVersionIds();
    const seenActive = new Set<number>();
    for (const ladder of ladders) {
      for (const e of ladder.entries) {
        if (e.role !== 'champion' && e.role !== 'challenger') continue;
        if (seenActive.has(e.versionId)) continue;
        seenActive.add(e.versionId);
        if (serverQuarantined.has(e.versionId) || pendingOutboxQuarantine.has(e.versionId)) {
          continue;
        }
        const row = this.stateDb.getLocalAgent(e.versionId);
        const exceededBeforeRestart = row !== undefined && Coordinator.isFaultThresholdExceeded({
          totalGames: row.totalGames,
          totalFaults: row.totalFaults,
          consecutiveFaults: row.consecutiveFaults,
        });
        if (this.quarantinedVersions.has(e.versionId) || exceededBeforeRestart) {
          // Admin ran `unquarantine`: clear local fault history so a single subsequent hiccup
          // does not immediately re-trigger the 20% historical fault-rate threshold.
          this.quarantinedVersions.delete(e.versionId);
          this.faultCounters.delete(e.versionId);
          this.stateDb.resetAgentFaults(e.versionId);
        }
      }
    }
  }

  private async sendMatchHeartbeat(
    match: MirrorMatchContext,
    frame: MirrorHeartbeatFrame
  ): Promise<void> {
    this.heartbeatSeq++;
    // Never spawn host probe subprocesses during mid-turn `/info` broadcasts while an agent
    // is actively thinking on the clock.
    const sysInfo = frame.midTurnInfo ? undefined : await this.getSystemInfo?.();
    await this.client.sendHeartbeat({
      heartbeatSeq: this.heartbeatSeq,
      matchId: match.id,
      ladderId: match.ladderId,
      format: match.format,
      game: frame.game,
      ...(frame.phase ? {phase: frame.phase} : {}),
      turn: frame.turn,
      activeSlot: frame.activeSlot,
      turnStartedAt: frame.turnStartedAt,
      turnBudgetSeconds: frame.turnBudgetSeconds,
      incrementSeconds: frame.incrementSeconds,
      ...(frame.game1Summary ? {game1Summary: frame.game1Summary} : {}),
      p1: {
        slug: match.p1.slug,
        name: match.p1.name,
        version: match.p1.version,
        bankSeconds: frame.p1.bankSeconds,
        ...(frame.p1.initMillis !== undefined ? {initMillis: frame.p1.initMillis} : {}),
        ...(frame.p1.teamPreviewMillis !== undefined
          ? {teamPreviewMillis: frame.p1.teamPreviewMillis}
          : {}),
        lastTurnMillis: frame.p1.lastTurnMillis,
        meanTurnMillis: frame.p1.meanTurnMillis,
        ram: frame.p1.ram,
        ...(frame.p1.cpuCores !== undefined ? {cpuCores: frame.p1.cpuCores} : {}),
        ...(frame.p1.team ? {team: frame.p1.team} : {}),
        ...(frame.p1.info ? {info: frame.p1.info} : {}),
      },
      p2: {
        slug: match.p2.slug,
        name: match.p2.name,
        version: match.p2.version,
        bankSeconds: frame.p2.bankSeconds,
        ...(frame.p2.initMillis !== undefined ? {initMillis: frame.p2.initMillis} : {}),
        ...(frame.p2.teamPreviewMillis !== undefined
          ? {teamPreviewMillis: frame.p2.teamPreviewMillis}
          : {}),
        lastTurnMillis: frame.p2.lastTurnMillis,
        meanTurnMillis: frame.p2.meanTurnMillis,
        ram: frame.p2.ram,
        ...(frame.p2.cpuCores !== undefined ? {cpuCores: frame.p2.cpuCores} : {}),
        ...(frame.p2.team ? {team: frame.p2.team} : {}),
        ...(frame.p2.info ? {info: frame.p2.info} : {}),
      },
      ...(frame.viewer
        ? {
          viewer: {
            ...(frame.viewer.lines ? {lines: frame.viewer.lines} : {}),
            ...(frame.viewer.p1Pokemon ? {p1: {pokemon: frame.viewer.p1Pokemon}} : {}),
            ...(frame.viewer.p2Pokemon ? {p2: {pokemon: frame.viewer.p2Pokemon}} : {}),
          },
        }
        : {}),
      ...(frame.winHistory && frame.winHistory.length > 0 ? {winHistory: frame.winHistory} : {}),
      ...(sysInfo ? {system: sysInfo} : {}),
    }).catch(() => undefined);
  }

  private async runGame2AndFinalize(
    match: MirrorMatchContext,
    game1: MirrorGame1Summary
  ): Promise<{archivedLadder: boolean; aborted: boolean}> {
    const g1WinnerSlot = game1.outcome === 'W'
      ? ('p1' as const)
      : game1.outcome === 'L'
        ? ('p2' as const)
        : undefined;
    const game1Summary: arena.LiveGameSummaryInput = {
      ...(g1WinnerSlot ? {winnerSlot: g1WinnerSlot} : {}),
      turns: game1.turns,
      endReason: game1.endReason,
      p1: {
        bankSeconds: game1.p1.bankSeconds,
        ...(game1.p1.initMillis !== undefined ? {initMillis: Math.round(game1.p1.initMillis)} : {}),
        ...(game1.p1.teamPreviewMillis !== undefined
          ? {teamPreviewMillis: Math.round(game1.p1.teamPreviewMillis)}
          : {}),
        meanTurnMillis: Math.round(game1.p1.meanTurnMillis),
        ram: game1.p1.peakRam,
        ...(game1.p1.cpuCores !== undefined ? {cpuCores: game1.p1.cpuCores} : {}),
        ...(match.p1.teamLabel ? {team: match.p1.teamLabel} : {}),
      },
      p2: {
        bankSeconds: game1.p2.bankSeconds,
        ...(game1.p2.initMillis !== undefined ? {initMillis: Math.round(game1.p2.initMillis)} : {}),
        ...(game1.p2.teamPreviewMillis !== undefined
          ? {teamPreviewMillis: Math.round(game1.p2.teamPreviewMillis)}
          : {}),
        meanTurnMillis: Math.round(game1.p2.meanTurnMillis),
        ram: game1.p2.peakRam,
        ...(game1.p2.cpuCores !== undefined ? {cpuCores: game1.p2.cpuCores} : {}),
        ...(match.p2.teamLabel ? {team: match.p2.teamLabel} : {}),
      },
      ...(game1.p1.pokemon || game1.p2.pokemon
        ? {
          viewer: {
            ...(game1.p1.pokemon ? {p1: {pokemon: game1.p1.pokemon}} : {}),
            ...(game1.p2.pokemon ? {p2: {pokemon: game1.p2.pokemon}} : {}),
          },
        }
        : {}),
    };

    // Game 2 swaps sides and teams: P2 sits in slot p1 with T1, P1 sits in slot p2 with T2
    const isRandom = match.teamMode === 'random';
    const g2Game = new arbiter.TimeSlicedArenaGame({
      format: match.format,
      version: match.version ?? this.versionByLadderId.get(match.ladderId),
      seed: match.seed,
      p1: {spec: match.p2.spec, teamPacked: match.p1.teamPacked},
      p2: {spec: match.p1.spec, teamPacked: match.p2.teamPacked},
      sendUtm: !isRandom,
      recordAiLogs: match.teamMode !== 'harvested',
      liveInfo: isRandom,
      maxTurns: this.maxTurns,
      devMode: this.devMode,
      onTurn: async info => {
        const lines = isRandom && info.omniscientLog
          ? arbiter.rewriteBlindPlayerNames(info.omniscientLog, match.p2.name, match.p1.name)
            .split('\n')
          : undefined;
        const winHistory = isRandom ? swapWinHistory(info.winHistory) : undefined;
        await this.sendMatchHeartbeat(match, {
          game: 2,
          phase: info.phase,
          turn: info.turn,
          activeSlot: info.activeSlot === 'p1' ? 'p2' : 'p1',
          turnStartedAt: info.turnStartedAt,
          turnBudgetSeconds: info.turnBudgetSeconds,
          incrementSeconds: info.incrementSeconds,
          ...(info.midTurnInfo ? {midTurnInfo: true} : {}),
          game1Summary,
          p1: {
            bankSeconds: info.p2.bankSeconds,
            initMillis: info.p2.initMillis,
            teamPreviewMillis: info.p2.teamPreviewMillis,
            lastTurnMillis: info.p2.lastTurnMillis,
            meanTurnMillis: info.p2.meanTurnMillis,
            ram: info.p2.ram,
            ...(info.p2.cpuCores !== undefined ? {cpuCores: info.p2.cpuCores} : {}),
            team: match.p2.teamLabel,
            ...(isRandom && info.p2.info ? {info: info.p2.info} : {}),
          },
          p2: {
            bankSeconds: info.p1.bankSeconds,
            initMillis: info.p1.initMillis,
            teamPreviewMillis: info.p1.teamPreviewMillis,
            lastTurnMillis: info.p1.lastTurnMillis,
            meanTurnMillis: info.p1.meanTurnMillis,
            ram: info.p1.ram,
            ...(info.p1.cpuCores !== undefined ? {cpuCores: info.p1.cpuCores} : {}),
            team: match.p1.teamLabel,
            ...(isRandom && info.p1.info ? {info: info.p1.info} : {}),
          },
          ...(lines || info.p1.pokemon || info.p2.pokemon
            ? {
              viewer: {
                ...(lines ? {lines} : {}),
                p1Pokemon: info.p1.pokemon,
                p2Pokemon: info.p2.pokemon,
              },
            }
            : {}),
          ...(winHistory ? {winHistory} : {}),
        });
      },
    });
    const g2Res = await g2Game.run();
    if (INFRA_VOID_REASONS.has(g2Res.endReason)) {
      this.stateDb.markMatchCheckpointStatus(match.id, 'aborted');
      return {archivedLadder: false, aborted: true};
    }

    const g2OutcomeForP1: ratings.GameOutcome =
      g2Res.winner === 'p2' ? 'W' : g2Res.winner === 'p1' ? 'L' : 'T';
    const category: ratings.MatchCategory = `${game1.outcome}${g2OutcomeForP1}`;
    const completedAt = Math.floor(Date.now() / 1000);
    const g2Log = arbiter.rewriteBlindPlayerNames(
      g2Res.omniscientLog,
      match.p2.name,
      match.p1.name
    );
    this.writeArchivedGameLog(match.ladderId, match.id, 'b', g2Log, match.startedAt);

    const matchTimers = await sim.getTimerSettings(match.format, match.version);
    const g2WinHistory = isRandom ? swapWinHistory(g2Res.winHistory) : undefined;
    await this.sendMatchHeartbeat(match, {
      game: 2,
      turn: g2Res.turns,
      activeSlot: 'p1',
      turnStartedAt: completedAt,
      turnBudgetSeconds: matchTimers.maxPerTurnSeconds,
      incrementSeconds: matchTimers.addPerTurnSeconds,
      game1Summary,
      p1: {
        bankSeconds: g2Res.p2.bankSeconds,
        lastTurnMillis: g2Res.p2.lastTurnMillis,
        meanTurnMillis: g2Res.p2.meanTurnMillis,
        ram: g2Res.p2.peakRam,
        ...(g2Res.p2.cpuCores !== undefined ? {cpuCores: g2Res.p2.cpuCores} : {}),
        team: match.p2.teamLabel,
        ...(isRandom && g2Res.p2.info ? {info: g2Res.p2.info} : {}),
      },
      p2: {
        bankSeconds: g2Res.p1.bankSeconds,
        lastTurnMillis: g2Res.p1.lastTurnMillis,
        meanTurnMillis: g2Res.p1.meanTurnMillis,
        ram: g2Res.p1.peakRam,
        ...(g2Res.p1.cpuCores !== undefined ? {cpuCores: g2Res.p1.cpuCores} : {}),
        team: match.p1.teamLabel,
        ...(isRandom && g2Res.p1.info ? {info: g2Res.p1.info} : {}),
      },
      ...(isRandom || g2Res.p1.pokemon || g2Res.p2.pokemon
        ? {
          viewer: {
            ...(isRandom ? {lines: g2Log.split('\n')} : {}),
            p1Pokemon: g2Res.p1.pokemon,
            p2Pokemon: g2Res.p2.pokemon,
          },
        }
        : {}),
      ...(g2WinHistory ? {winHistory: g2WinHistory} : {}),
    });

    const sendLogs = match.teamMode === 'random' || match.teamMode === 'pools';
    const g1Log = sendLogs
      ? (game1.log ?? this.readArchivedGameLog(match.ladderId, match.id, 'a', match.startedAt))
      : undefined;

    const p1 = {g1: summarizeGameStats(game1.p1), g2: summarizeGameStats(g2Res.p2)};
    const p2 = {g1: summarizeGameStats(game1.p2), g2: summarizeGameStats(g2Res.p1)};
    const p1CpuCores = meanOptionalCores(p1.g1.cpuCores, p1.g2.cpuCores);
    const p2CpuCores = meanOptionalCores(p2.g1.cpuCores, p2.g2.cpuCores);
    const p1Errors = sumProtocolErrors(p1.g1.errors, p1.g2.errors);
    const p2Errors = sumProtocolErrors(p2.g1.errors, p2.g2.errors);

    const payload: arena.MatchCompletePayload = {
      match: {
        id: match.id,
        ladderId: match.ladderId,
        p1VersionId: match.p1.versionId,
        p2VersionId: match.p2.versionId,
        seed: String(match.seed),
        ...(match.p1.teamLabel ? {p1TeamLabel: match.p1.teamLabel} : {}),
        ...(match.p2.teamLabel ? {p2TeamLabel: match.p2.teamLabel} : {}),
        game1Outcome: game1.outcome,
        game2Outcome: g2OutcomeForP1,
        category,
        game1Turns: game1.turns,
        game2Turns: g2Res.turns,
        game1EndReason: game1.endReason,
        game2EndReason: g2Res.endReason,
        p1Game1PeakRam: p1.g1.peakRam,
        p1Game2PeakRam: p1.g2.peakRam,
        p2Game1PeakRam: p2.g1.peakRam,
        p2Game2PeakRam: p2.g2.peakRam,
        p1Game1BankSeconds: p1.g1.bankSeconds,
        p1Game2BankSeconds: p1.g2.bankSeconds,
        p2Game1BankSeconds: p2.g1.bankSeconds,
        p2Game2BankSeconds: p2.g2.bankSeconds,
        p1Game1InitMillis: p1.g1.initMillis,
        p1Game2InitMillis: p1.g2.initMillis,
        p2Game1InitMillis: p2.g1.initMillis,
        p2Game2InitMillis: p2.g2.initMillis,
        ...(p1.g1.teamPreviewMillis !== undefined
          ? {p1Game1TeamPreviewMillis: p1.g1.teamPreviewMillis}
          : {}),
        ...(p1.g2.teamPreviewMillis !== undefined
          ? {p1Game2TeamPreviewMillis: p1.g2.teamPreviewMillis}
          : {}),
        ...(p2.g1.teamPreviewMillis !== undefined
          ? {p2Game1TeamPreviewMillis: p2.g1.teamPreviewMillis}
          : {}),
        ...(p2.g2.teamPreviewMillis !== undefined
          ? {p2Game2TeamPreviewMillis: p2.g2.teamPreviewMillis}
          : {}),
        p1Game1MeanTurnMillis: p1.g1.meanTurnMillis,
        p1Game2MeanTurnMillis: p1.g2.meanTurnMillis,
        p2Game1MeanTurnMillis: p2.g1.meanTurnMillis,
        p2Game2MeanTurnMillis: p2.g2.meanTurnMillis,
        ...(p1.g1.cpuCores !== undefined ? {p1Game1CpuCores: p1.g1.cpuCores} : {}),
        ...(p1.g2.cpuCores !== undefined ? {p1Game2CpuCores: p1.g2.cpuCores} : {}),
        ...(p2.g1.cpuCores !== undefined ? {p2Game1CpuCores: p2.g1.cpuCores} : {}),
        ...(p2.g2.cpuCores !== undefined ? {p2Game2CpuCores: p2.g2.cpuCores} : {}),
        ...(p1CpuCores !== undefined ? {p1CpuCores} : {}),
        ...(p2CpuCores !== undefined ? {p2CpuCores} : {}),
        ...(p1Errors ? {p1Errors} : {}),
        ...(p2Errors ? {p2Errors} : {}),
        completedAt,
      },
      ...(sendLogs
        ? {
          ...(g1Log !== undefined ? {game1Log: g1Log} : {}),
          game2Log: g2Log,
        }
        : {}),
    };

    const {archivedLadder} = await this.completeMatchOrOutbox(payload);
    // Mark checkpoint complete BEFORE archive compression/upload so an archive hiccup never
    // replays Game 2 on restart.
    this.stateDb.markMatchCheckpointStatus(match.id, 'complete', completedAt);

    if (archivedLadder && sendLogs) {
      await this.publishLadderArchive(match.ladderId);
    } else {
      await this.maybeArchiveOnDayRollover(match.ladderId, match.teamMode, completedAt);
    }

    const g1Fault = FAULT_REASONS.has(game1.endReason);
    const p1FaultG1 = g1Fault && game1.outcome === 'L';
    const p2FaultG1 = g1Fault && game1.outcome === 'W';
    const p1FaultG2 = isPlayerFault(g2Res, 'p2');
    const p2FaultG2 = isPlayerFault(g2Res, 'p1');

    this.recordAgentGameFault(match.p1.versionId, p1FaultG1, completedAt);
    this.recordAgentGameFault(match.p1.versionId, p1FaultG2, completedAt);
    this.recordAgentGameFault(match.p2.versionId, p2FaultG1, completedAt);
    this.recordAgentGameFault(match.p2.versionId, p2FaultG2, completedAt);

    if (p1FaultG1 || p1FaultG2) {
      await this.checkAndQuarantineIfFaulty(
        match.ladderId,
        match.p1.versionId,
        p1FaultG2 ? g2Res.endReason : game1.endReason
      );
    }
    if (p2FaultG1 || p2FaultG2) {
      await this.checkAndQuarantineIfFaulty(
        match.ladderId,
        match.p2.versionId,
        p2FaultG2 ? g2Res.endReason : game1.endReason
      );
    }

    return {archivedLadder, aborted: false};
  }

  private async resumeAndCompleteGame2(
    cp: db.LocalMatchCheckpoint
  ): Promise<'resumed' | 'aborted'> {
    packages.ensureAgentResident(this.stateDb, cp.p1.versionId, {dirs: this.dirs});
    packages.ensureAgentResident(this.stateDb, cp.p2.versionId, {dirs: this.dirs});
    packages.evictColdAgentsIfNeeded(this.stateDb, {
      dirs: this.dirs,
      pinnedVersionIds: new Set([cp.p1.versionId, cp.p2.versionId]),
    });

    const g1 = cp.g1;
    if (!g1 || INFRA_VOID_REASONS.has(g1.endReason)) {
      this.stateDb.markMatchCheckpointStatus(cp.id, 'aborted');
      return 'aborted';
    }

    const match: MirrorMatchContext = {
      id: cp.id,
      ladderId: cp.ladderId,
      format: cp.format,
      version: cp.version,
      teamMode: cp.teamMode,
      seed: parsePrngSeed(cp.seed),
      startedAt: cp.startedAt || Math.floor(Date.now() / 1000),
      p1: {
        versionId: cp.p1.versionId,
        agentId: cp.p1.agentId,
        slug: cp.p1.slug,
        name: cp.p1.name,
        version: cp.p1.version,
        spec: this.resolveLaunchSpec(cp.p1.mode, cp.p1.target),
        teamPacked: cp.p1.teamPacked,
        teamLabel: cp.p1.teamLabel,
      },
      p2: {
        versionId: cp.p2.versionId,
        agentId: cp.p2.agentId,
        slug: cp.p2.slug,
        name: cp.p2.name,
        version: cp.p2.version,
        spec: this.resolveLaunchSpec(cp.p2.mode, cp.p2.target),
        teamPacked: cp.p2.teamPacked,
        teamLabel: cp.p2.teamLabel,
      },
    };

    const {aborted} = await this.runGame2AndFinalize(match, {
      outcome: g1.outcome,
      turns: g1.turns,
      endReason: g1.endReason,
      p1: {
        bankSeconds: g1.p1.bankSeconds,
        peakRam: g1.p1.ram,
        initMillis: g1.p1.initMillis,
        teamPreviewMillis: g1.p1.teamPreviewMillis,
        meanTurnMillis: g1.p1.turnMillis,
      },
      p2: {
        bankSeconds: g1.p2.bankSeconds,
        peakRam: g1.p2.ram,
        initMillis: g1.p2.initMillis,
        teamPreviewMillis: g1.p2.teamPreviewMillis,
        meanTurnMillis: g1.p2.turnMillis,
      },
    });
    return aborted ? 'aborted' : 'resumed';
  }

  async playNextScheduledMatch(
    ladders: readonly LadderSnapshot[],
    quarantinedVersionIds: readonly number[] = []
  ): Promise<{matchId: string; ladderId: string; archivedLadder: boolean} | undefined> {
    for (const ladder of ladders) {
      if (ladder.version) this.versionByLadderId.set(ladder.id, ladder.version);
      this.teamModeByLadderId.set(ladder.id, ladder.team);
    }
    await this.flushOutbox();
    if (this.draining) return undefined;

    this.syncQuarantineResets(ladders, quarantinedVersionIds);
    const nowSeconds = Math.floor(Date.now() / 1000);

    if (ladders.some(l => l.status === 'active' || l.status === 'settling')) {
      const activeVersionIds = new Set<number>();
      for (const ladder of ladders) {
        if (ladder.status !== 'active' && ladder.status !== 'settling') continue;
        await this.maybeArchiveOnDayRollover(ladder.id, ladder.team, nowSeconds);
        for (const e of ladder.entries) {
          if (e.role === 'champion' || e.role === 'challenger') {
            activeVersionIds.add(e.versionId);
          }
        }
      }
      packages.evictColdAgentsIfNeeded(this.stateDb, {
        dirs: this.dirs,
        activeVersionIds,
      });
    }

    const candidates: Array<{
      ladder: LadderSnapshot;
      entries: LadderSnapshot['entries'];
      state: ratings.LadderMatchState;
    }> = [];

    for (const ladder of ladders) {
      // Filter out playable entries that are not yet registered in `local_agents` on this runner
      // or are cooling down after a broken cold-archive restore so a single missing artifact
      // cannot wedge scheduling across all other healthy competitors and ladders.
      const availableEntries = ladder.entries.filter(e => {
        if (e.role !== 'champion' && e.role !== 'challenger') return true;
        const brokenUntil = this.brokenUntilByVersion.get(e.versionId);
        if (brokenUntil !== undefined) {
          if (nowSeconds < brokenUntil) return false;
          this.brokenUntilByVersion.delete(e.versionId);
        }
        const local = this.stateDb.getLocalAgent(e.versionId);
        return local !== undefined && local.residency !== 'staged';
      });
      const rosterIds = ladder.team === 'pools' && ladder.roster
        ? new Set(ladder.roster.map(r => r.agentId))
        : undefined;
      const state = arena.buildLadderMatchState({
        ladder,
        entries: availableEntries,
        pairs: ladder.pairAggregates,
        lastMatchNumber: this.stateDb.getLastGlobalMatchSequence(ladder.id),
        rosterAgentIds: rosterIds,
        residencyMultipliers: packages.computeResidencyMultipliers(
          availableEntries.map(e => e.versionId),
          this.stateDb
        ),
      });
      if (state) candidates.push({ladder, entries: availableEntries, state});
    }

    if (candidates.length === 0) return undefined;

    const globalSeq = this.stateDb.getGlobalMatchCount();
    const choice = ratings.selectNextArenaMatch(
      candidates.map(c => c.state),
      globalSeq,
      EXPLOIT_PROBABILITY
    );

    const chosen = candidates.find(c => c.ladder.id === choice.ladderId)!;
    const e1 = chosen.entries[choice.agentI];
    const e2 = chosen.entries[choice.agentJ];

    return this.executeMirrorPair(chosen.ladder, e1, e2);
  }

  async executeMirrorPair(
    ladder: LadderSnapshot,
    e1: LadderSnapshot['entries'][number],
    e2: LadderSnapshot['entries'][number]
  ): Promise<{matchId: string; ladderId: string; archivedLadder: boolean}> {
    const now = Math.floor(Date.now() / 1000);
    let a1: db.LocalAgentRow | undefined;
    try {
      a1 = packages.ensureAgentResident(this.stateDb, e1.versionId, {dirs: this.dirs});
    } catch (err) {
      this.brokenUntilByVersion.set(e1.versionId, now + BROKEN_AGENT_COOLDOWN_SECONDS);
      throw err;
    }
    let a2: db.LocalAgentRow | undefined;
    try {
      a2 = packages.ensureAgentResident(this.stateDb, e2.versionId, {dirs: this.dirs});
    } catch (err) {
      this.brokenUntilByVersion.set(e2.versionId, now + BROKEN_AGENT_COOLDOWN_SECONDS);
      throw err;
    }
    if (!a1 || !a2) {
      if (!a1) this.brokenUntilByVersion.set(e1.versionId, now + BROKEN_AGENT_COOLDOWN_SECONDS);
      if (!a2) this.brokenUntilByVersion.set(e2.versionId, now + BROKEN_AGENT_COOLDOWN_SECONDS);
      throw new Error(
        `Missing local agent registration for versionId ${e1.versionId} or ${e2.versionId}`
      );
    }
    packages.evictColdAgentsIfNeeded(this.stateDb, {
      dirs: this.dirs,
      pinnedVersionIds: new Set([e1.versionId, e2.versionId]),
    });

    const seq = this.stateDb.nextMatchSequence(ladder.id);
    const matchId = `${ladder.id}-${String(seq).padStart(7, '0')}`;
    const seedStr = this.randomPrngSeed();
    const sampled = await this.sampleMatchTeams(ladder, e1.agentId, e2.agentId);

    const p1Spec = this.resolveLaunchSpec(a1.mode, a1.target);
    const p2Spec = this.resolveLaunchSpec(a2.mode, a2.target);
    const match: MirrorMatchContext = {
      id: matchId,
      ladderId: ladder.id,
      format: ladder.format,
      version: ladder.version,
      teamMode: ladder.team,
      seed: seedStr,
      startedAt: now,
      p1: {
        versionId: e1.versionId,
        agentId: e1.agentId,
        slug: e1.agentSlug,
        name: e1.agentName,
        version: e1.version,
        spec: p1Spec,
        teamPacked: sampled.t1,
        teamLabel: sampled.t1Label,
      },
      p2: {
        versionId: e2.versionId,
        agentId: e2.agentId,
        slug: e2.agentSlug,
        name: e2.agentName,
        version: e2.version,
        spec: p2Spec,
        teamPacked: sampled.t2,
        teamLabel: sampled.t2Label,
      },
    };

    this.stateDb.createMatchCheckpoint({
      id: matchId,
      ladderId: ladder.id,
      format: ladder.format,
      version: ladder.version,
      teamMode: ladder.team,
      seed: seedStr,
      p1: {
        versionId: e1.versionId,
        agentId: e1.agentId,
        slug: e1.agentSlug,
        name: e1.agentName,
        version: e1.version,
        mode: a1.mode,
        target: a1.target,
        teamPacked: sampled.t1,
        teamLabel: sampled.t1Label,
      },
      p2: {
        versionId: e2.versionId,
        agentId: e2.agentId,
        slug: e2.agentSlug,
        name: e2.agentName,
        version: e2.version,
        mode: a2.mode,
        target: a2.target,
        teamPacked: sampled.t2,
        teamLabel: sampled.t2Label,
      },
      startedAt: now,
    });

    let g1Checkpointed = false;

    try {
      // Game 1: P1 in slot p1 with T1, P2 in slot p2 with T2
      const isRandom = ladder.team === 'random';
      const g1Game = new arbiter.TimeSlicedArenaGame({
        format: ladder.format,
        version: ladder.version,
        seed: seedStr,
        p1: {spec: p1Spec, teamPacked: sampled.t1},
        p2: {spec: p2Spec, teamPacked: sampled.t2},
        sendUtm: !isRandom,
        recordAiLogs: ladder.team !== 'harvested',
        liveInfo: isRandom,
        maxTurns: this.maxTurns,
        devMode: this.devMode,
        onTurn: async info => {
          const lines = isRandom && info.omniscientLog
            ? arbiter.rewriteBlindPlayerNames(info.omniscientLog, e1.agentName, e2.agentName)
              .split('\n')
            : undefined;
          await this.sendMatchHeartbeat(match, {
            game: 1,
            phase: info.phase,
            turn: info.turn,
            activeSlot: info.activeSlot,
            turnStartedAt: info.turnStartedAt,
            turnBudgetSeconds: info.turnBudgetSeconds,
            incrementSeconds: info.incrementSeconds,
            ...(info.midTurnInfo ? {midTurnInfo: true} : {}),
            p1: {
              bankSeconds: info.p1.bankSeconds,
              initMillis: info.p1.initMillis,
              teamPreviewMillis: info.p1.teamPreviewMillis,
              lastTurnMillis: info.p1.lastTurnMillis,
              meanTurnMillis: info.p1.meanTurnMillis,
              ram: info.p1.ram,
              ...(info.p1.cpuCores !== undefined ? {cpuCores: info.p1.cpuCores} : {}),
              team: sampled.t1Label,
              ...(isRandom && info.p1.info ? {info: info.p1.info} : {}),
            },
            p2: {
              bankSeconds: info.p2.bankSeconds,
              initMillis: info.p2.initMillis,
              teamPreviewMillis: info.p2.teamPreviewMillis,
              lastTurnMillis: info.p2.lastTurnMillis,
              meanTurnMillis: info.p2.meanTurnMillis,
              ram: info.p2.ram,
              ...(info.p2.cpuCores !== undefined ? {cpuCores: info.p2.cpuCores} : {}),
              team: sampled.t2Label,
              ...(isRandom && info.p2.info ? {info: info.p2.info} : {}),
            },
            ...(lines || info.p1.pokemon || info.p2.pokemon
              ? {
                viewer: {
                  ...(lines ? {lines} : {}),
                  p1Pokemon: info.p1.pokemon,
                  p2Pokemon: info.p2.pokemon,
                },
              }
              : {}),
            ...(isRandom && info.winHistory ? {winHistory: info.winHistory} : {}),
          });
        },
      });
      const g1Res = await g1Game.run();
      if (INFRA_VOID_REASONS.has(g1Res.endReason)) {
        this.stateDb.markMatchCheckpointStatus(matchId, 'aborted');
        return {matchId, ladderId: ladder.id, archivedLadder: false};
      }

      const g1Log = arbiter.rewriteBlindPlayerNames(
        g1Res.omniscientLog,
        e1.agentName,
        e2.agentName
      );
      this.writeArchivedGameLog(ladder.id, matchId, 'a', g1Log, now);
      const ladderTimers = await sim.getTimerSettings(ladder.format, ladder.version);
      await this.sendMatchHeartbeat(match, {
        game: 1,
        turn: g1Res.turns,
        activeSlot: 'p1',
        turnStartedAt: Math.floor(Date.now() / 1000),
        turnBudgetSeconds: ladderTimers.maxPerTurnSeconds,
        incrementSeconds: ladderTimers.addPerTurnSeconds,
        p1: {
          bankSeconds: g1Res.p1.bankSeconds,
          lastTurnMillis: g1Res.p1.lastTurnMillis,
          meanTurnMillis: g1Res.p1.meanTurnMillis,
          ram: g1Res.p1.peakRam,
          ...(g1Res.p1.cpuCores !== undefined ? {cpuCores: g1Res.p1.cpuCores} : {}),
          team: sampled.t1Label,
          ...(isRandom && g1Res.p1.info ? {info: g1Res.p1.info} : {}),
        },
        p2: {
          bankSeconds: g1Res.p2.bankSeconds,
          lastTurnMillis: g1Res.p2.lastTurnMillis,
          meanTurnMillis: g1Res.p2.meanTurnMillis,
          ram: g1Res.p2.peakRam,
          ...(g1Res.p2.cpuCores !== undefined ? {cpuCores: g1Res.p2.cpuCores} : {}),
          team: sampled.t2Label,
          ...(isRandom && g1Res.p2.info ? {info: g1Res.p2.info} : {}),
        },
        ...(isRandom || g1Res.p1.pokemon || g1Res.p2.pokemon
          ? {
            viewer: {
              ...(isRandom ? {lines: g1Log.split('\n')} : {}),
              p1Pokemon: g1Res.p1.pokemon,
              p2Pokemon: g1Res.p2.pokemon,
            },
          }
          : {}),
        ...(isRandom && g1Res.winHistory ? {winHistory: g1Res.winHistory} : {}),
      });

      this.stateDb.checkpointGame1Complete({
        id: matchId,
        outcome: g1Res.outcome,
        turns: g1Res.turns,
        endReason: g1Res.endReason,
        p1: {
          bankSeconds: g1Res.p1.bankSeconds,
          ram: g1Res.p1.peakRam,
          initMillis: g1Res.p1.initMillis,
          teamPreviewMillis: g1Res.p1.teamPreviewMillis,
          turnMillis: g1Res.p1.meanTurnMillis,
        },
        p2: {
          bankSeconds: g1Res.p2.bankSeconds,
          ram: g1Res.p2.peakRam,
          initMillis: g1Res.p2.initMillis,
          teamPreviewMillis: g1Res.p2.teamPreviewMillis,
          turnMillis: g1Res.p2.meanTurnMillis,
        },
      });
      g1Checkpointed = true;

      const {archivedLadder} = await this.runGame2AndFinalize(match, {
        outcome: g1Res.outcome,
        turns: g1Res.turns,
        endReason: g1Res.endReason,
        p1: {
          bankSeconds: g1Res.p1.bankSeconds,
          peakRam: g1Res.p1.peakRam,
          ...(g1Res.p1.cpuCores !== undefined ? {cpuCores: g1Res.p1.cpuCores} : {}),
          initMillis: g1Res.p1.initMillis,
          teamPreviewMillis: g1Res.p1.teamPreviewMillis,
          meanTurnMillis: g1Res.p1.meanTurnMillis,
          pokemon: g1Res.p1.pokemon,
          ...(g1Res.p1.errors ? {errors: g1Res.p1.errors} : {}),
        },
        p2: {
          bankSeconds: g1Res.p2.bankSeconds,
          peakRam: g1Res.p2.peakRam,
          ...(g1Res.p2.cpuCores !== undefined ? {cpuCores: g1Res.p2.cpuCores} : {}),
          initMillis: g1Res.p2.initMillis,
          teamPreviewMillis: g1Res.p2.teamPreviewMillis,
          meanTurnMillis: g1Res.p2.meanTurnMillis,
          pokemon: g1Res.p2.pokemon,
          ...(g1Res.p2.errors ? {errors: g1Res.p2.errors} : {}),
        },
        log: g1Log,
      });
      return {matchId, ladderId: ladder.id, archivedLadder};
    } catch (err) {
      if (!g1Checkpointed) {
        this.stateDb.markMatchCheckpointStatus(matchId, 'aborted');
      }
      throw err;
    }
  }
}
