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
  casDir?: string;
  devMode?: boolean;
  maxTurns?: number;
  exploitProbability?: number;
  formatByLadderId?: ReadonlyMap<string, string>;
  randomInt?: (max: number) => number;
}

interface LadderFaultCounter {
  totalGames: number;
  totalFaults: number;
  consecutiveFaults: number;
}

const FAULT_REASONS = new Set(['crash', 'oom', 'timeout', 'invalid-choice']);
const INFRA_VOID_REASONS = new Set(['arbiter-stall', 'sim-error', 'arena-error']);
const BROKEN_AGENT_COOLDOWN_SECONDS = 300;

function isPlayerFault(result: arbiter.ArenaGameResult, slot: 'p1' | 'p2'): boolean {
  if (!FAULT_REASONS.has(result.endReason)) return false;
  return (slot === 'p1' && result.winner === 'p2') ||
    (slot === 'p2' && result.winner === 'p1');
}

function getHttpErrorStatus(err: unknown): number | undefined {
  const explicitStatus = (err as {status?: unknown} | undefined)?.status;
  if (typeof explicitStatus === 'number') return explicitStatus;
  if (err instanceof Error) {
    const m = /\((\d{3})\):/.exec(err.message);
    if (m) return Number(m[1]);
  }
  return undefined;
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
  private readonly agentsDir: string;
  private readonly stagingDir: string;
  private readonly coldDir: string;
  private readonly teamsDir: string;
  private readonly archiveLogsDir: string;
  private readonly casDir?: string;
  private readonly devMode: boolean;
  private readonly maxTurns?: number;
  private readonly exploitProbability: number;
  private readonly formatByLadderId: Map<string, string>;
  private readonly randomInt: (max: number) => number;
  private readonly customRandomInt: boolean;
  private readonly harvestedCache = new Map<
    string,
    {sha256: string; entries: teams.HarvestedPoolEntry[]}
  >();
  private readonly lastRandomArchiveDayByLadder = new Map<string, string>();
  private readonly ladderFaults = new Map<string, LadderFaultCounter>();
  private readonly quarantinedOnLadder = new Set<string>();
  private readonly brokenUntilByVersion = new Map<number, number>();
  private heartbeatSeq = 0;
  private draining = false;

  constructor(options: Options) {
    this.client = options.client;
    this.stateDb = options.stateDb;
    this.baselineSpec = options.baselineSpec ?? {
      mode: 'native',
      target: fs.existsSync('/opt/arena/bin/baseline')
        ? '/opt/arena/bin/baseline'
        : root('arena', 'bin', 'baseline'),
    };
    this.devMode = options.devMode ?? process.env.ARENA_DEV === '1';
    this.agentsDir = options.agentsDir ?? packages.AGENTS_DIR;
    this.stagingDir = options.stagingDir ?? packages.STAGING_DIR;
    this.coldDir = options.coldDir ?? (
      this.devMode && !fs.existsSync('/Volumes/Archive')
        ? path.join(path.dirname(this.agentsDir), `${path.basename(this.agentsDir)}-cold`)
        : packages.COLD_AGENTS_DIR
    );
    this.teamsDir = options.teamsDir ?? '/opt/arena/teams';
    this.archiveLogsDir = options.archiveLogsDir ?? '/Volumes/Archive/logs';
    this.casDir = options.casDir;
    this.maxTurns = options.maxTurns;
    this.exploitProbability = options.exploitProbability ?? 0.45;
    this.formatByLadderId = new Map(options.formatByLadderId ?? []);
    this.customRandomInt = options.randomInt !== undefined;
    this.randomInt = options.randomInt ?? (max => crypto.randomInt(0, max));
  }

  requestDrain() {
    this.draining = true;
  }

  isDraining(): boolean {
    return this.draining;
  }

  private randomPrngSeed(): PRNGSeed {
    if (this.customRandomInt) {
      const s0 = this.randomInt(0x10000);
      const s1 = this.randomInt(0x10000);
      const s2 = this.randomInt(0x10000);
      const s3 = this.randomInt(0x10000);
      return `${s0},${s1},${s2},${s3}`;
    }
    return `sodium,${crypto.randomBytes(32).toString('hex')}`;
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

  async flushOutbox(): Promise<number> {
    const entries = this.stateDb.listOutbox();
    let flushed = 0;
    for (const entry of entries) {
      try {
        if (entry.endpoint === 'match-complete') {
          const payload = JSON.parse(entry.payloadJson) as arena.MatchCompletePayload;
          await this.sendMatchComplete(payload);
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
    laddersById?: ReadonlyMap<string, LadderSnapshot>
  ): Promise<number> {
    if (this.draining) return 0;
    const {ladders, submissions} = await this.client.getPendingSubmissions({target: 'ladder'});
    const pendingMetaById = new Map<string, {format: string; team: db.TeamMode}>();
    for (const l of ladders) {
      pendingMetaById.set(l.id, {format: l.format, team: l.team});
      this.formatByLadderId.set(l.id, l.format);
    }
    let processed = 0;

    for (const sub of submissions) {
      if (this.draining) break;
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
        try {
          const subTeams = sub.teamsByLadder?.[item.ladderId];
          if (item.team === 'pools') {
            if (!subTeams || subTeams.length < 2) {
              smokeError =
                `Smoke test failed in ${item.format}: missing validated team roster for ` +
                `${item.ladderId}`;
              break;
            }
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
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          smokeError = `Smoke test setup failed in ${item.format}: ${msg}`;
          break;
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
          includeSpectatorState: false,
        });
        const res = await game.run();
        if (isPlayerFault(res, 'p1') || INFRA_VOID_REASONS.has(res.endReason)) {
          const stderrSnippet = res.p1Stderr
            ? ` (${res.p1Stderr.trim().replace(/\s+/g, ' ').slice(0, 240)})`
            : '';
          smokeError = `Smoke test failed in ${item.format}: ${res.endReason}${stderrSnippet}`;
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
      this.brokenUntilByVersion.delete(sub.versionId);

      if (mode === 'native' || !this.devMode) {
        packages.archiveColdAgent(
          {mode, target},
          {agentsDir: this.agentsDir, coldDir: this.coldDir}
        );
      }

      packages.evictColdAgentsIfNeeded(this.stateDb, {
        agentsDir: this.agentsDir,
        coldDir: this.coldDir,
        casDir: this.casDir,
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
    if (this.stateDb.listOutbox(1).length > 0) {
      await this.flushOutbox();
      if (this.stateDb.listOutbox(1).length > 0) {
        this.stateDb.enqueueOutbox('submission-status', payload);
        return;
      }
    }
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
    if (cached && cached.entries.length >= 2) return cached.entries;

    const localFile = path.join(this.teamsDir, `${ladderId}.txt`);
    const shaFile = `${localFile}.sha256`;
    if (fs.existsSync(localFile)) {
      const rawText = fs.readFileSync(localFile, 'utf8');
      const lines = rawText
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(Boolean);
      const computedSha = crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
      const storedSha = fs.existsSync(shaFile)
        ? fs.readFileSync(shaFile, 'utf8').trim()
        : undefined;
      if (lines.length >= 2 && (!storedSha || storedSha === computedSha)) {
        const entries = this.toHarvestedEntries(lines, format);
        this.harvestedCache.set(ladderId, {sha256: computedSha, entries});
        return entries;
      }
      fs.rmSync(localFile, {force: true});
      fs.rmSync(shaFile, {force: true});
    }

    const remote = await this.client.getLadderTeams(ladderId);
    if (remote.teams.length < 2) {
      throw new Error(`Ladder '${ladderId}' returned fewer than 2 harvested teams`);
    }
    const cleanTeams = remote.teams.map(t => t.trim()).filter(Boolean);
    if (cleanTeams.length < 2) {
      throw new Error(`Ladder '${ladderId}' returned fewer than 2 non-empty harvested teams`);
    }
    fs.mkdirSync(this.teamsDir, {recursive: true, mode: 0o700});
    const tmpFile = `${localFile}.tmp.${process.pid}`;
    fs.writeFileSync(tmpFile, `${cleanTeams.join('\n')}\n`, {encoding: 'utf8', mode: 0o600});
    fs.renameSync(tmpFile, localFile);
    const sha256 = remote.sha256 ||
      crypto.createHash('sha256').update(cleanTeams.join('\n')).digest('hex');
    fs.writeFileSync(shaFile, `${sha256}\n`, {encoding: 'utf8', mode: 0o600});
    const entries = this.toHarvestedEntries(cleanTeams, format);
    this.harvestedCache.set(ladderId, {sha256, entries});
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
      const day = new Date(daySeconds * 1000).toISOString().slice(0, 10);
      const file = path.join(this.archiveLogsDir, ladderId, day, `${matchId}${suffix}.log`);
      if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
    } catch {}
    return undefined;
  }

  async publishLadderArchive(ladderId: string, excludeDay?: string): Promise<boolean> {
    const ladderDir = path.join(this.archiveLogsDir, ladderId);
    if (!fs.existsSync(ladderDir)) return false;

    for (const entry of fs.readdirSync(ladderDir, {withFileTypes: true})) {
      if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
      if (excludeDay && entry.name === excludeDay) continue;
      const day = entry.name;
      const yearMonth = day.slice(0, 7);
      const dayDir = path.join(ladderDir, day);
      const logFiles = fs
        .readdirSync(dayDir)
        .filter(f => f.endsWith('.log'))
        .sort()
        .map(f => path.join(dayDir, f));
      if (logFiles.length === 0) continue;

      const monthDir = path.join(ladderDir, yearMonth);
      fs.mkdirSync(monthDir, {recursive: true, mode: 0o700});
      const dayArchive = path.join(monthDir, `${day}.7z`);
      const tmpDayArchive = `${dayArchive}.tmp.${process.pid}`;
      fs.rmSync(tmpDayArchive, {force: true});
      try {
        execFileSync(
          '7z',
          ['a', '-t7z', '-m0=lzma2', '-mx=9', '-ms=on', tmpDayArchive, ...logFiles],
          {stdio: 'ignore', timeout: 60_000}
        );
        execFileSync('7z', ['t', tmpDayArchive], {stdio: 'ignore', timeout: 30_000});
        fs.renameSync(tmpDayArchive, dayArchive);
        fs.rmSync(dayDir, {recursive: true, force: true});
      } catch (err) {
        fs.rmSync(tmpDayArchive, {force: true});
        console.error(`Failed to compress daily archive ${dayArchive}:`, err);
      }
    }

    const archiveMembers: string[] = [];
    for (const entry of fs.readdirSync(ladderDir, {withFileTypes: true})) {
      if (entry.isFile() && /^\d{4}-\d{2}\.tar$/.test(entry.name)) {
        archiveMembers.push(entry.name);
        continue;
      }
      if (!entry.isDirectory() || !/^\d{4}-\d{2}$/.test(entry.name)) continue;
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
      return true;
    } catch (err) {
      fs.rmSync(tmpTar, {force: true});
      console.error(`Failed to build/upload ${ladderId}-logs.tar:`, err);
      return false;
    }
  }

  async publishRandomLadderArchive(ladderId: string, excludeDay?: string): Promise<boolean> {
    return this.publishLadderArchive(ladderId, excludeDay);
  }

  private async maybePublishDailyRandomArchive(
    ladderId: string,
    nowSeconds: number
  ): Promise<boolean> {
    const today = new Date(nowSeconds * 1000).toISOString().slice(0, 10);
    const prev = this.lastRandomArchiveDayByLadder.get(ladderId);
    this.lastRandomArchiveDayByLadder.set(ladderId, today);
    if (prev !== undefined && prev !== today) {
      return this.publishLadderArchive(ladderId, today);
    }
    return false;
  }

  private recordLadderGameFault(
    ladderId: string,
    versionId: number,
    faulted: boolean,
    nowSeconds: number
  ): LadderFaultCounter {
    this.stateDb.recordAgentGameResult(versionId, faulted, nowSeconds);
    const key = `${ladderId}:${versionId}`;
    let counter = this.ladderFaults.get(key);
    if (!counter) {
      counter = {totalGames: 0, totalFaults: 0, consecutiveFaults: 0};
      this.ladderFaults.set(key, counter);
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
    const key = `${ladderId}:${versionId}`;
    const counter = this.ladderFaults.get(key);
    const row = this.stateDb.getLocalAgent(versionId);
    const totalGames = counter ? counter.totalGames : (row?.totalGames ?? 0);
    const totalFaults = counter ? counter.totalFaults : (row?.totalFaults ?? 0);
    const consecutiveFaults = counter
      ? counter.consecutiveFaults
      : (row?.consecutiveFaults ?? 0);

    const faultRate = totalGames > 0 ? totalFaults / totalGames : 0;
    // 5 consecutive matches = 10 consecutive games (`recordLadderGameFault` is per-game).
    if (consecutiveFaults >= 10 || (totalGames >= 10 && faultRate > 0.20)) {
      this.quarantinedOnLadder.add(key);
      await this.reportSubmissionOrOutbox({
        versionId,
        smokeStatus: 'quarantined',
        smokeError:
          `Auto-quarantined on ${ladderId} (${totalFaults}/${totalGames} faults, ` +
          `${consecutiveFaults} consecutive; last=${lastReason})`,
      });
    }
  }

  private syncQuarantineResets(ladders: readonly LadderSnapshot[]) {
    for (const ladder of ladders) {
      for (const e of ladder.entries) {
        const key = `${ladder.id}:${e.versionId}`;
        if (e.role === 'quarantined') {
          this.quarantinedOnLadder.add(key);
        } else if (this.quarantinedOnLadder.has(key)) {
          // Admin ran `unquarantine`: clear local fault history so a single subsequent hiccup
          // does not immediately re-trigger the 20% historical fault-rate threshold.
          this.quarantinedOnLadder.delete(key);
          this.ladderFaults.delete(key);
          this.stateDb.resetAgentFaults(e.versionId);
        }
      }
    }
  }

  private async runGame2AndFinalize(params: {
    matchId: string;
    ladderId: string;
    format: string;
    teamMode: db.TeamMode;
    seed: PRNGSeed;
    startedAt: number;
    p1VersionId: number;
    p1Slug: string;
    p1Name: string;
    p1Version: string;
    p1Spec: arbiter.AgentLaunchSpec;
    p2VersionId: number;
    p2Slug: string;
    p2Name: string;
    p2Version: string;
    p2Spec: arbiter.AgentLaunchSpec;
    t1Packed: string;
    t2Packed: string;
    t1Label?: string;
    t2Label?: string;
    g1Outcome: ratings.GameOutcome;
    g1Turns: number;
    g1EndReason: string;
    g1P1BankSeconds: number;
    g1P2BankSeconds: number;
    g1P1PeakRam: number;
    g1P2PeakRam: number;
    g1P1MeanTurnMillis: number;
    g1P2MeanTurnMillis: number;
    g1Log?: string;
  }): Promise<{archivedLadder: boolean; aborted: boolean}> {
    const g1WinnerSlot = params.g1Outcome === 'W'
      ? ('p1' as const)
      : params.g1Outcome === 'L'
        ? ('p2' as const)
        : undefined;

    // Game 2 swaps sides and teams: P2 sits in slot p1 with T1, P1 sits in slot p2 with T2
    const g2Game = new arbiter.TimeSlicedArenaGame({
      format: params.format,
      seed: params.seed,
      p1Spec: params.p2Spec,
      p2Spec: params.p1Spec,
      p1TeamPacked: params.t1Packed,
      p2TeamPacked: params.t2Packed,
      maxTurns: this.maxTurns,
      devMode: this.devMode,
      includeSpectatorState: params.teamMode === 'random',
      onTurn: async info => {
        this.heartbeatSeq++;
        const lines = params.teamMode === 'random'
          ? arbiter.rewriteBlindPlayerNames(info.omniscientLog, params.p2Name, params.p1Name)
            .split('\n')
          : undefined;
        await this.client.sendHeartbeat({
          heartbeatSeq: this.heartbeatSeq,
          matchId: params.matchId,
          ladderId: params.ladderId,
          format: params.format,
          game: 2,
          turn: info.turn,
          activeSlot: info.activeSlot === 'p1' ? 'p2' : 'p1',
          turnStartedAt: info.turnStartedAt,
          turnBudgetSeconds: info.turnBudgetSeconds,
          incrementSeconds: info.incrementSeconds,
          game1Summary: {
            ...(g1WinnerSlot ? {winnerSlot: g1WinnerSlot} : {}),
            turns: params.g1Turns,
          },
          p1: {
            slug: params.p1Slug,
            name: params.p1Name,
            version: params.p1Version,
            bankSeconds: info.p2BankSeconds,
            lastTurnMillis: info.p2LastTurnMillis,
            meanTurnMillis: info.p2MeanTurnMillis,
            ram: Math.max(params.g1P1PeakRam, info.p2Ram),
            ...(params.t2Label ? {team: params.t2Label} : {}),
          },
          p2: {
            slug: params.p2Slug,
            name: params.p2Name,
            version: params.p2Version,
            bankSeconds: info.p1BankSeconds,
            lastTurnMillis: info.p1LastTurnMillis,
            meanTurnMillis: info.p1MeanTurnMillis,
            ram: Math.max(params.g1P2PeakRam, info.p1Ram),
            ...(params.t1Label ? {team: params.t1Label} : {}),
          },
          ...(lines
            ? {
              lines,
              ...(info.p1Pokemon ? {p1Pokemon: info.p1Pokemon} : {}),
              ...(info.p2Pokemon ? {p2Pokemon: info.p2Pokemon} : {}),
            }
            : {}),
        }).catch(() => undefined);
      },
    });
    const g2Res = await g2Game.run();
    if (INFRA_VOID_REASONS.has(g2Res.endReason)) {
      this.stateDb.markMatchCheckpointStatus(params.matchId, 'aborted');
      return {archivedLadder: false, aborted: true};
    }

    const g2OutcomeForP1: ratings.GameOutcome =
      g2Res.winner === 'p2' ? 'W' : g2Res.winner === 'p1' ? 'L' : 'T';
    const category: ratings.MatchCategory = `${params.g1Outcome}${g2OutcomeForP1}`;
    const completedAt = Math.floor(Date.now() / 1000);
    const g2Log = arbiter.rewriteBlindPlayerNames(
      g2Res.omniscientLog,
      params.p2Name,
      params.p1Name
    );
    this.writeArchivedGameLog(params.ladderId, params.matchId, 'b', g2Log, params.startedAt);

    if (params.teamMode === 'random') {
      this.heartbeatSeq++;
      await this.client.sendHeartbeat({
        heartbeatSeq: this.heartbeatSeq,
        matchId: params.matchId,
        ladderId: params.ladderId,
        format: params.format,
        game: 2,
        turn: g2Res.turns,
        activeSlot: 'p1',
        turnStartedAt: completedAt,
        turnBudgetSeconds: arena.MAX_TURN_SECONDS,
        incrementSeconds: arena.turnIncrementSeconds(params.format),
        game1Summary: {
          ...(g1WinnerSlot ? {winnerSlot: g1WinnerSlot} : {}),
          turns: params.g1Turns,
        },
        p1: {
          slug: params.p1Slug,
          name: params.p1Name,
          version: params.p1Version,
          bankSeconds: g2Res.p2BankSeconds,
          lastTurnMillis: g2Res.p2LastTurnMillis,
          meanTurnMillis: g2Res.p2MeanTurnMillis,
          ram: Math.max(params.g1P1PeakRam, g2Res.p2PeakRam),
          ...(params.t2Label ? {team: params.t2Label} : {}),
        },
        p2: {
          slug: params.p2Slug,
          name: params.p2Name,
          version: params.p2Version,
          bankSeconds: g2Res.p1BankSeconds,
          lastTurnMillis: g2Res.p1LastTurnMillis,
          meanTurnMillis: g2Res.p1MeanTurnMillis,
          ram: Math.max(params.g1P2PeakRam, g2Res.p1PeakRam),
          ...(params.t1Label ? {team: params.t1Label} : {}),
        },
        lines: g2Log.split('\n'),
        ...(g2Res.p1Pokemon ? {p1Pokemon: g2Res.p1Pokemon} : {}),
        ...(g2Res.p2Pokemon ? {p2Pokemon: g2Res.p2Pokemon} : {}),
      }).catch(() => undefined);
    }

    const g1Log = params.teamMode === 'random'
      ? (params.g1Log ??
        this.readArchivedGameLog(params.ladderId, params.matchId, 'a', params.startedAt))
      : undefined;

    const p1Game1PeakRam = params.g1P1PeakRam;
    const p1Game2PeakRam = g2Res.p2PeakRam;
    const p2Game1PeakRam = params.g1P2PeakRam;
    const p2Game2PeakRam = g2Res.p1PeakRam;
    const p1PeakRam = Math.max(p1Game1PeakRam, p1Game2PeakRam);
    const p2PeakRam = Math.max(p2Game1PeakRam, p2Game2PeakRam);
    const p1Game1MeanTurnMillis = Math.round(params.g1P1MeanTurnMillis);
    const p1Game2MeanTurnMillis = Math.round(g2Res.p2MeanTurnMillis);
    const p2Game1MeanTurnMillis = Math.round(params.g1P2MeanTurnMillis);
    const p2Game2MeanTurnMillis = Math.round(g2Res.p1MeanTurnMillis);
    const p1MeanTurnMillis = Math.round((p1Game1MeanTurnMillis + p1Game2MeanTurnMillis) / 2);
    const p2MeanTurnMillis = Math.round((p2Game1MeanTurnMillis + p2Game2MeanTurnMillis) / 2);

    const payload: arena.MatchCompletePayload = {
      match: {
        id: params.matchId,
        ladderId: params.ladderId,
        p1VersionId: params.p1VersionId,
        p2VersionId: params.p2VersionId,
        seed: params.seed,
        ...(params.t1Label ? {p1TeamLabel: params.t1Label} : {}),
        ...(params.t2Label ? {p2TeamLabel: params.t2Label} : {}),
        game1Outcome: params.g1Outcome,
        game2Outcome: g2OutcomeForP1,
        category,
        game1Turns: params.g1Turns,
        game2Turns: g2Res.turns,
        game1EndReason: params.g1EndReason,
        game2EndReason: g2Res.endReason,
        p1PeakRam,
        p2PeakRam,
        p1Game1PeakRam,
        p1Game2PeakRam,
        p2Game1PeakRam,
        p2Game2PeakRam,
        p1Game1BankSeconds: params.g1P1BankSeconds,
        p1Game2BankSeconds: g2Res.p2BankSeconds,
        p2Game1BankSeconds: params.g1P2BankSeconds,
        p2Game2BankSeconds: g2Res.p1BankSeconds,
        p1MeanTurnMillis,
        p2MeanTurnMillis,
        p1Game1MeanTurnMillis,
        p1Game2MeanTurnMillis,
        p2Game1MeanTurnMillis,
        p2Game2MeanTurnMillis,
        completedAt,
      },
      ...(params.teamMode === 'random'
        ? {
          ...(g1Log !== undefined ? {game1Log: g1Log} : {}),
          game2Log: g2Log,
        }
        : {}),
    };

    const {archivedLadder} = await this.completeMatchOrOutbox(payload);
    // Mark checkpoint complete BEFORE archive compression/upload so an archive hiccup never
    // replays Game 2 on restart.
    this.stateDb.markMatchCheckpointStatus(params.matchId, 'complete', completedAt);

    if (archivedLadder) {
      await this.publishLadderArchive(params.ladderId);
    } else if (params.teamMode === 'random') {
      await this.maybePublishDailyRandomArchive(params.ladderId, completedAt);
    }

    const g1Fault = FAULT_REASONS.has(params.g1EndReason);
    const p1FaultG1 = g1Fault && params.g1Outcome === 'L';
    const p2FaultG1 = g1Fault && params.g1Outcome === 'W';
    const p1FaultG2 = isPlayerFault(g2Res, 'p2');
    const p2FaultG2 = isPlayerFault(g2Res, 'p1');

    this.recordLadderGameFault(params.ladderId, params.p1VersionId, p1FaultG1, completedAt);
    this.recordLadderGameFault(params.ladderId, params.p1VersionId, p1FaultG2, completedAt);
    this.recordLadderGameFault(params.ladderId, params.p2VersionId, p2FaultG1, completedAt);
    this.recordLadderGameFault(params.ladderId, params.p2VersionId, p2FaultG2, completedAt);

    if (p1FaultG1 || p1FaultG2) {
      await this.checkAndQuarantineIfFaulty(
        params.ladderId,
        params.p1VersionId,
        p1FaultG2 ? g2Res.endReason : params.g1EndReason
      );
    }
    if (p2FaultG1 || p2FaultG2) {
      await this.checkAndQuarantineIfFaulty(
        params.ladderId,
        params.p2VersionId,
        p2FaultG2 ? g2Res.endReason : params.g1EndReason
      );
    }

    return {archivedLadder, aborted: false};
  }

  private async resumeAndCompleteGame2(
    cp: db.LocalMatchCheckpoint
  ): Promise<'resumed' | 'aborted'> {
    packages.ensureAgentResident(this.stateDb, cp.p1VersionId, {
      agentsDir: this.agentsDir,
      coldDir: this.coldDir,
      casDir: this.casDir,
    });
    packages.ensureAgentResident(this.stateDb, cp.p2VersionId, {
      agentsDir: this.agentsDir,
      coldDir: this.coldDir,
      casDir: this.casDir,
    });
    packages.evictColdAgentsIfNeeded(this.stateDb, {
      agentsDir: this.agentsDir,
      coldDir: this.coldDir,
      casDir: this.casDir,
      pinnedVersionIds: new Set([cp.p1VersionId, cp.p2VersionId]),
    });

    const p1Spec = this.resolveLaunchSpec(cp.p1Mode, cp.p1Target);
    const p2Spec = this.resolveLaunchSpec(cp.p2Mode, cp.p2Target);
    const seed = parsePrngSeed(cp.seed);
    const g1Outcome = cp.g1Outcome ?? 'T';
    if (INFRA_VOID_REASONS.has(cp.g1EndReason ?? '')) {
      this.stateDb.markMatchCheckpointStatus(cp.id, 'aborted');
      return 'aborted';
    }

    const {aborted} = await this.runGame2AndFinalize({
      matchId: cp.id,
      ladderId: cp.ladderId,
      format: cp.format,
      teamMode: cp.teamMode,
      seed,
      startedAt: cp.startedAt || Math.floor(Date.now() / 1000),
      p1VersionId: cp.p1VersionId,
      p1Slug: cp.p1Slug,
      p1Name: cp.p1Name,
      p1Version: cp.p1Version,
      p1Spec,
      p2VersionId: cp.p2VersionId,
      p2Slug: cp.p2Slug,
      p2Name: cp.p2Name,
      p2Version: cp.p2Version,
      p2Spec,
      t1Packed: cp.p1TeamPacked,
      t2Packed: cp.p2TeamPacked,
      t1Label: cp.p1TeamLabel,
      t2Label: cp.p2TeamLabel,
      g1Outcome,
      g1Turns: cp.g1Turns ?? 1,
      g1EndReason: cp.g1EndReason ?? 'win',
      g1P1BankSeconds: cp.g1P1BankSeconds ?? 0,
      g1P2BankSeconds: cp.g1P2BankSeconds ?? 0,
      g1P1PeakRam: cp.g1P1Ram ?? 64,
      g1P2PeakRam: cp.g1P2Ram ?? 64,
      g1P1MeanTurnMillis: cp.g1P1TurnMillis ?? 0,
      g1P2MeanTurnMillis: cp.g1P2TurnMillis ?? 0,
    });
    return aborted ? 'aborted' : 'resumed';
  }

  async playNextScheduledMatch(
    ladders: readonly LadderSnapshot[]
  ): Promise<{matchId: string; ladderId: string; archivedLadder: boolean} | undefined> {
    await this.flushOutbox();
    if (this.draining) return undefined;

    this.syncQuarantineResets(ladders);
    const nowSeconds = Math.floor(Date.now() / 1000);

    if (ladders.some(l => l.status === 'active' || l.status === 'settling')) {
      const activeVersionIds = new Set<number>();
      for (const ladder of ladders) {
        if (ladder.status !== 'active' && ladder.status !== 'settling') continue;
        for (const e of ladder.entries) {
          if (e.role === 'champion' || e.role === 'challenger') {
            activeVersionIds.add(e.versionId);
          }
        }
      }
      packages.evictColdAgentsIfNeeded(this.stateDb, {
        agentsDir: this.agentsDir,
        coldDir: this.coldDir,
        casDir: this.casDir,
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
        return this.stateDb.getLocalAgent(e.versionId) !== undefined;
      });
      const rosterIds = ladder.team === 'pools' && ladder.roster
        ? new Set(ladder.roster.map(r => r.agentId))
        : undefined;
      const state = arena.buildLadderMatchState(
        ladder,
        availableEntries,
        ladder.pairAggregates,
        this.stateDb.getLastGlobalMatchSequence(ladder.id),
        rosterIds,
        packages.computeResidencyMultipliers(
          availableEntries.map(e => e.versionId),
          this.stateDb
        )
      );
      if (state) candidates.push({ladder, entries: availableEntries, state});
    }

    if (candidates.length === 0) return undefined;

    const globalSeq = this.stateDb.getGlobalMatchCount();
    const choice = ratings.selectNextArenaMatch(
      candidates.map(c => c.state),
      globalSeq,
      this.exploitProbability
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
      a1 = packages.ensureAgentResident(this.stateDb, e1.versionId, {
        agentsDir: this.agentsDir,
        coldDir: this.coldDir,
        casDir: this.casDir,
      });
    } catch (err) {
      this.brokenUntilByVersion.set(e1.versionId, now + BROKEN_AGENT_COOLDOWN_SECONDS);
      throw err;
    }
    let a2: db.LocalAgentRow | undefined;
    try {
      a2 = packages.ensureAgentResident(this.stateDb, e2.versionId, {
        agentsDir: this.agentsDir,
        coldDir: this.coldDir,
        casDir: this.casDir,
      });
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
      agentsDir: this.agentsDir,
      coldDir: this.coldDir,
      casDir: this.casDir,
      pinnedVersionIds: new Set([e1.versionId, e2.versionId]),
    });

    const seq = this.stateDb.nextMatchSequence(ladder.id);
    const matchId = `${ladder.id}-${String(seq).padStart(7, '0')}`;
    const seedStr = this.randomPrngSeed();
    const sampled = await this.sampleMatchTeams(ladder, e1.agentId, e2.agentId);

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
    let g1Checkpointed = false;

    try {
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
        includeSpectatorState: ladder.team === 'random',
        onTurn: async info => {
          this.heartbeatSeq++;
          const lines = ladder.team === 'random'
            ? arbiter.rewriteBlindPlayerNames(info.omniscientLog, e1.agentName, e2.agentName)
              .split('\n')
            : undefined;
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
              ram: info.p1Ram,
              ...(sampled.t1Label ? {team: sampled.t1Label} : {}),
            },
            p2: {
              slug: e2.agentSlug,
              name: e2.agentName,
              version: e2.version,
              bankSeconds: info.p2BankSeconds,
              lastTurnMillis: info.p2LastTurnMillis,
              meanTurnMillis: info.p2MeanTurnMillis,
              ram: info.p2Ram,
              ...(sampled.t2Label ? {team: sampled.t2Label} : {}),
            },
            ...(lines
              ? {
                lines,
                ...(info.p1Pokemon ? {p1Pokemon: info.p1Pokemon} : {}),
                ...(info.p2Pokemon ? {p2Pokemon: info.p2Pokemon} : {}),
              }
              : {}),
          }).catch(() => undefined);
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
      if (ladder.team === 'random') {
        this.heartbeatSeq++;
        await this.client.sendHeartbeat({
          heartbeatSeq: this.heartbeatSeq,
          matchId,
          ladderId: ladder.id,
          format: ladder.format,
          game: 1,
          turn: g1Res.turns,
          activeSlot: 'p1',
          turnStartedAt: Math.floor(Date.now() / 1000),
          turnBudgetSeconds: arena.MAX_TURN_SECONDS,
          incrementSeconds: arena.turnIncrementSeconds(ladder.format),
          p1: {
            slug: e1.agentSlug,
            name: e1.agentName,
            version: e1.version,
            bankSeconds: g1Res.p1BankSeconds,
            lastTurnMillis: g1Res.p1LastTurnMillis,
            meanTurnMillis: g1Res.p1MeanTurnMillis,
            ram: g1Res.p1PeakRam,
            ...(sampled.t1Label ? {team: sampled.t1Label} : {}),
          },
          p2: {
            slug: e2.agentSlug,
            name: e2.agentName,
            version: e2.version,
            bankSeconds: g1Res.p2BankSeconds,
            lastTurnMillis: g1Res.p2LastTurnMillis,
            meanTurnMillis: g1Res.p2MeanTurnMillis,
            ram: g1Res.p2PeakRam,
            ...(sampled.t2Label ? {team: sampled.t2Label} : {}),
          },
          lines: g1Log.split('\n'),
          ...(g1Res.p1Pokemon ? {p1Pokemon: g1Res.p1Pokemon} : {}),
          ...(g1Res.p2Pokemon ? {p2Pokemon: g1Res.p2Pokemon} : {}),
        }).catch(() => undefined);
      }

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
      g1Checkpointed = true;

      const {archivedLadder} = await this.runGame2AndFinalize({
        matchId,
        ladderId: ladder.id,
        format: ladder.format,
        teamMode: ladder.team,
        seed: seedStr,
        startedAt: now,
        p1VersionId: e1.versionId,
        p1Slug: e1.agentSlug,
        p1Name: e1.agentName,
        p1Version: e1.version,
        p1Spec,
        p2VersionId: e2.versionId,
        p2Slug: e2.agentSlug,
        p2Name: e2.agentName,
        p2Version: e2.version,
        p2Spec,
        t1Packed: sampled.t1,
        t2Packed: sampled.t2,
        t1Label: sampled.t1Label,
        t2Label: sampled.t2Label,
        g1Outcome: g1Res.outcome,
        g1Turns: g1Res.turns,
        g1EndReason: g1Res.endReason,
        g1P1BankSeconds: g1Res.p1BankSeconds,
        g1P2BankSeconds: g1Res.p2BankSeconds,
        g1P1PeakRam: g1Res.p1PeakRam,
        g1P2PeakRam: g1Res.p2PeakRam,
        g1P1MeanTurnMillis: g1Res.p1MeanTurnMillis,
        g1P2MeanTurnMillis: g1Res.p2MeanTurnMillis,
        g1Log,
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
