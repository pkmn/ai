import * as crypto from 'crypto';
import * as fs from 'fs';
import type * as http from 'http';
import * as path from 'path';

import type polka from 'polka';

import type {
  ApplySubmissionStatusResult,
  ArenaDB,
  CompletedMatchPayload,
  EntryRole,
  LadderSlot,
  LadderStandingOverride,
  LadderStatus,
  RecentMatchView,
  SmokeStatus,
} from '../db';
import {root} from '../static/util';

import {decryptSecret} from './account';
import type {Auth} from './auth';
import type {GameOutcome, MatchCategory} from './ratings';

export const PUBLIC_DIR = root('public');
export const WATCHDOG_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;
const RECENT_MATCHES_LIMIT = 50;

const VALID_SMOKE_UPDATES = new Set<Exclude<SmokeStatus, 'pending_pull'>>([
  'passed',
  'failed_smoke_test',
  'quarantined',
]);
const VALID_GAME_OUTCOMES = new Set<GameOutcome>(['W', 'L', 'T']);
const VALID_MATCH_CATEGORIES = new Set<MatchCategory>([
  'WW', 'WT', 'TW', 'WL', 'LW', 'TT', 'TL', 'LT', 'LL',
]);
const VALID_ROLES = new Set<EntryRole>(['champion', 'challenger', 'retired', 'quarantined']);
const VALID_LADDER_STATUSES = new Set<LadderStatus>([
  'upcoming', 'active', 'settling', 'archived',
]);

export interface LiveSlotTelemetry {
  slug: string;
  name: string;
  version: string;
  bank_s: number;
  last_turn_ms: number;
  mean_turn_ms: number;
  ram_mb: number;
}

export interface LiveMatchTelemetry {
  heartbeat_seq: number;
  match_id: string;
  ladder_id: string;
  slot?: LadderSlot;
  format_id: string;
  game_num: 1 | 2;
  turn: number;
  active_slot: 'p1' | 'p2' | null;
  turn_started_at: number;
  turn_budget_s: number;
  increment_s: number;
  g1_summary: {winner_slot: 'p1' | 'p2' | null; turns: number} | null;
  p1: LiveSlotTelemetry;
  p2: LiveSlotTelemetry;
}

export interface LiveJsonDocument {
  updated_at: number;
  stale: boolean;
  live: LiveMatchTelemetry | null;
  recent_matches: RecentMatchView[];
}

export interface WatchdogAlert {
  lastSeenAt: number;
  lastMatchId: string | null;
}

export interface ArenaControllerOptions {
  db: ArenaDB;
  auth?: Auth;
  arenaSecret?: string;
  sessionSecret?: string;
  publicDir?: string;
  watchdogTimeoutMs?: number;
  recentMatchesLimit?: number;
  now?: () => number;
  onSubmissionStatus?: (result: ApplySubmissionStatusResult) => void | Promise<void>;
  onMatchComplete?: (event: {
    match: CompletedMatchPayload;
    duplicate: boolean;
    archivedLadder: boolean;
  }) => void | Promise<void>;
  onWatchdogTimeout?: (alert: WatchdogAlert) => void | Promise<void>;
  onUpdate?: (reason: 'submission-status' | 'match-complete') => void | Promise<void>;
}

export interface ArenaControllerHandle {
  close: () => void;
  writeLiveJson: (nowSec?: number) => LiveJsonDocument;
  getState: () => {
    lastSeenAt: number | null;
    watchdogTriggered: boolean;
    live: LiveMatchTelemetry | null;
  };
}

function sendJson(res: http.ServerResponse, status: number, data: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        reject(Object.assign(new Error('Request body exceeds 1 MB limit.'), {status: 413}));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const parsed = raw ? (JSON.parse(raw) as unknown) : {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(Object.assign(new Error('Request body must be a JSON object.'), {status: 400}));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(Object.assign(new Error('Invalid JSON request body.'), {status: 400}));
      }
    });
    req.on('error', err => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

function safeSecretEquals(provided: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function writeFileAtomic(filePath: string, contents: string) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, contents, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function isFiniteNonNeg(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function isPosInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

function parseSlotTelemetry(raw: unknown, label: string): LiveSlotTelemetry {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw Object.assign(new Error(`Invalid ${label} telemetry object.`), {status: 400});
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.slug !== 'string' || !obj.slug.trim()) {
    throw Object.assign(new Error(`Invalid ${label}.slug.`), {status: 400});
  }
  if (typeof obj.name !== 'string' || !obj.name.trim()) {
    throw Object.assign(new Error(`Invalid ${label}.name.`), {status: 400});
  }
  if (typeof obj.version !== 'string' || !obj.version.trim()) {
    throw Object.assign(new Error(`Invalid ${label}.version.`), {status: 400});
  }
  if (!isFiniteNonNeg(obj.bank_s)) {
    throw Object.assign(new Error(`Invalid ${label}.bank_s.`), {status: 400});
  }
  if (!isFiniteNonNeg(obj.last_turn_ms)) {
    throw Object.assign(new Error(`Invalid ${label}.last_turn_ms.`), {status: 400});
  }
  if (!isFiniteNonNeg(obj.mean_turn_ms)) {
    throw Object.assign(new Error(`Invalid ${label}.mean_turn_ms.`), {status: 400});
  }
  if (!isFiniteNonNeg(obj.ram_mb)) {
    throw Object.assign(new Error(`Invalid ${label}.ram_mb.`), {status: 400});
  }
  return {
    slug: obj.slug.trim(),
    name: obj.name.trim(),
    version: obj.version.trim(),
    bank_s: obj.bank_s,
    last_turn_ms: obj.last_turn_ms,
    mean_turn_ms: obj.mean_turn_ms,
    ram_mb: obj.ram_mb,
  };
}

function parseCompletedMatch(raw: unknown): CompletedMatchPayload {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw Object.assign(new Error('Missing or invalid "match" object.'), {status: 400});
  }
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== 'string' || !m.id.trim()) {
    throw Object.assign(new Error('Invalid match.id.'), {status: 400});
  }
  if (typeof m.ladder_id !== 'string' || !m.ladder_id.trim()) {
    throw Object.assign(new Error('Invalid match.ladder_id.'), {status: 400});
  }
  if (!isPosInt(m.v1_id) || !isPosInt(m.v2_id) || m.v1_id === m.v2_id) {
    throw Object.assign(
      new Error('match.v1_id and match.v2_id must be distinct positive integers.'),
      {status: 400}
    );
  }
  if (typeof m.seed !== 'string' || !m.seed.trim()) {
    throw Object.assign(new Error('Invalid match.seed.'), {status: 400});
  }
  if (typeof m.g1_outcome !== 'string' || !VALID_GAME_OUTCOMES.has(m.g1_outcome as GameOutcome)) {
    throw Object.assign(new Error('Invalid match.g1_outcome.'), {status: 400});
  }
  if (typeof m.g2_outcome !== 'string' || !VALID_GAME_OUTCOMES.has(m.g2_outcome as GameOutcome)) {
    throw Object.assign(new Error('Invalid match.g2_outcome.'), {status: 400});
  }
  const expectedCat = `${m.g1_outcome}${m.g2_outcome}` as MatchCategory;
  if (
    typeof m.match_category !== 'string' ||
    !VALID_MATCH_CATEGORIES.has(m.match_category as MatchCategory) ||
    m.match_category !== expectedCat
  ) {
    throw Object.assign(
      new Error(`match.match_category must equal "${expectedCat}".`),
      {status: 400}
    );
  }
  if (!isNonNegInt(m.g1_turns) || !isNonNegInt(m.g2_turns)) {
    throw Object.assign(new Error('Invalid match turn counts.'), {status: 400});
  }
  if (typeof m.g1_end_reason !== 'string' || !m.g1_end_reason.trim()) {
    throw Object.assign(new Error('Invalid match.g1_end_reason.'), {status: 400});
  }
  if (typeof m.g2_end_reason !== 'string' || !m.g2_end_reason.trim()) {
    throw Object.assign(new Error('Invalid match.g2_end_reason.'), {status: 400});
  }
  if (!isNonNegInt(m.v1_peak_ram_mb) || !isNonNegInt(m.v2_peak_ram_mb)) {
    throw Object.assign(new Error('Invalid peak RAM telemetry.'), {status: 400});
  }
  if (
    !isFiniteNonNeg(m.v1_g1_bank_s) ||
    !isFiniteNonNeg(m.v1_g2_bank_s) ||
    !isFiniteNonNeg(m.v2_g1_bank_s) ||
    !isFiniteNonNeg(m.v2_g2_bank_s)
  ) {
    throw Object.assign(new Error('Invalid bank telemetry.'), {status: 400});
  }
  if (!isNonNegInt(m.v1_avg_turn_ms) || !isNonNegInt(m.v2_avg_turn_ms)) {
    throw Object.assign(new Error('Invalid avg_turn_ms telemetry.'), {status: 400});
  }
  if (!isPosInt(m.completed_at)) {
    throw Object.assign(new Error('Invalid match.completed_at.'), {status: 400});
  }

  return {
    id: m.id.trim(),
    ladder_id: m.ladder_id.trim(),
    v1_id: m.v1_id,
    v2_id: m.v2_id,
    seed: m.seed.trim(),
    team1_label: typeof m.team1_label === 'string' ? m.team1_label : null,
    team2_label: typeof m.team2_label === 'string' ? m.team2_label : null,
    g1_outcome: m.g1_outcome as GameOutcome,
    g2_outcome: m.g2_outcome as GameOutcome,
    match_category: m.match_category,
    g1_turns: m.g1_turns,
    g2_turns: m.g2_turns,
    g1_end_reason: m.g1_end_reason.trim(),
    g2_end_reason: m.g2_end_reason.trim(),
    v1_peak_ram_mb: m.v1_peak_ram_mb,
    v2_peak_ram_mb: m.v2_peak_ram_mb,
    v1_g1_bank_s: m.v1_g1_bank_s,
    v1_g2_bank_s: m.v1_g2_bank_s,
    v2_g1_bank_s: m.v2_g1_bank_s,
    v2_g2_bank_s: m.v2_g2_bank_s,
    v1_avg_turn_ms: m.v1_avg_turn_ms,
    v2_avg_turn_ms: m.v2_avg_turn_ms,
    completed_at: m.completed_at,
  };
}

export function register(app: polka.Polka, options: ArenaControllerOptions): ArenaControllerHandle {
  const {db} = options;
  const publicDir = options.publicDir ?? PUBLIC_DIR;
  const liveJsonPath = path.join(publicDir, 'api', 'live.json');
  const watchdogMs = options.watchdogTimeoutMs ?? WATCHDOG_TIMEOUT_MS;
  const recentLimit = options.recentMatchesLimit ?? RECENT_MATCHES_LIMIT;
  const getNowSec = options.now ?? (() => Math.floor(Date.now() / 1000));

  let currentLive: LiveMatchTelemetry | null = null;
  let lastSeenAt: number | null = null;
  let lastMatchId: string | null = null;
  let watchdogTriggered = false;
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;

  const getArenaSecret = (): string | undefined =>
    options.arenaSecret ?? options.auth?.getConfig()?.arenaSecret ?? process.env.ARENA_SECRET;

  const getSessionSecret = (): string | undefined =>
    options.sessionSecret ?? options.auth?.getConfig()?.sessionSecret ?? process.env.SESSION_SECRET;

  const writeLiveJson = (nowSec = getNowSec(), stale = false): LiveJsonDocument => {
    const doc: LiveJsonDocument = {
      updated_at: nowSec,
      stale,
      live: stale ? null : currentLive,
      recent_matches: db.getRecentMatches(recentLimit),
    };
    writeFileAtomic(liveJsonPath, `${JSON.stringify(doc)}\n`);
    return doc;
  };

  const clearWatchdog = () => {
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
  };

  const armWatchdog = (seenAtSec: number) => {
    lastSeenAt = seenAtSec;
    watchdogTriggered = false;
    clearWatchdog();
    if (watchdogMs <= 0) return;

    watchdogTimer = setTimeout(() => {
      watchdogTimer = null;
      if (watchdogTriggered || lastSeenAt === null) return;
      watchdogTriggered = true;
      const stalledMatchId = currentLive?.match_id ?? lastMatchId;
      currentLive = null;
      try {
        writeLiveJson(getNowSec(), true);
      } catch (err) {
        console.error('Failed writing stale live.json on watchdog timeout:', err);
      }
      Promise.resolve(
        options.onWatchdogTimeout?.({lastSeenAt, lastMatchId: stalledMatchId})
      ).catch(err => {
        console.error('Error in onWatchdogTimeout callback:', err);
      });
    }, watchdogMs);
    watchdogTimer.unref();
  };

  const authenticateArena = (req: http.IncomingMessage, res: http.ServerResponse): boolean => {
    const expected = getArenaSecret();
    if (!expected) {
      sendJson(res, 503, {error: 'ARENA_SECRET is not configured on the server.'});
      return false;
    }
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer\s+(\S+)$/i.exec(header.trim()) : null;
    if (!match || !safeSecretEquals(match[1], expected)) {
      sendJson(res, 401, {error: 'Unauthorized.'});
      return false;
    }
    return true;
  };

  app.get('/api/arena/pending-submissions', (req, res) => {
    if (!authenticateArena(req, res)) return;
    try {
      const ladders = db.getPlayableLadders().map(l => ({
        id: l.id,
        slot: l.slot,
        display_name: l.display_name,
        format_id: l.format_id,
        team_mode: l.team_mode,
        min_bots: l.min_bots,
        team_count: l.team_count,
        status: l.status,
      }));
      const sessionSecret = getSessionSecret();
      const submissions = db.getPendingSubmissions().map(sub => {
        let authToken: string | null = null;
        if (sub.auth_token_enc) {
          if (!sessionSecret) {
            throw new Error('SESSION_SECRET is required to decrypt pending submission auth_token');
          }
          authToken = decryptSecret(sub.auth_token_enc, sessionSecret);
        }
        return {
          version_id: sub.version_id,
          bot_id: sub.bot_id,
          bot_slug: sub.bot_slug,
          bot_name: sub.bot_name,
          version_str: sub.version_str,
          format_type: sub.format_type,
          download_url: sub.download_url,
          sha256: sub.sha256,
          auth_token: authToken,
          ladders: sub.ladders,
          teams_by_ladder: sub.teams_by_ladder,
        };
      });
      sendJson(res, 200, {ladders, submissions});
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error.';
      sendJson(res, 500, {error: message});
    }
  });

  app.post('/api/arena/submission-status', async (req, res) => {
    if (!authenticateArena(req, res)) return;

    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      const status = (err as {status?: number}).status ?? 400;
      const message = err instanceof Error ? err.message : 'Invalid request body.';
      sendJson(res, status, {error: message});
      return;
    }

    const versionId = body.version_id;
    const smokeStatus = body.smoke_status;
    if (!isPosInt(versionId)) {
      sendJson(res, 400, {error: 'version_id must be a positive integer.'});
      return;
    }
    if (
      typeof smokeStatus !== 'string' ||
      !VALID_SMOKE_UPDATES.has(smokeStatus as Exclude<SmokeStatus, 'pending_pull'>)
    ) {
      sendJson(
        res,
        400,
        {error: 'smoke_status must be "passed", "failed_smoke_test", or "quarantined".'}
      );
      return;
    }

    const optInt = (val: unknown, field: string): number | null | undefined => {
      if (val === undefined) return undefined;
      if (val === null) return null;
      if (!isNonNegInt(val)) {
        throw Object.assign(
          new Error(`${field} must be a non-negative integer or null.`),
          {status: 400}
        );
      }
      return val;
    };

    try {
      const unpackedBytes = optInt(body.unpacked_bytes, 'unpacked_bytes');
      const smokeDurationMs = optInt(body.smoke_duration_ms, 'smoke_duration_ms');
      const smokeTurnMs = optInt(body.smoke_turn_ms, 'smoke_turn_ms');
      const smokePeakRamMb = optInt(body.smoke_peak_ram_mb, 'smoke_peak_ram_mb');
      const smokeErrorLog = body.smoke_error_log === undefined
        ? undefined
        : body.smoke_error_log === null
          ? null
          : typeof body.smoke_error_log === 'string'
            ? body.smoke_error_log.slice(0, 16_384)
            : (() => {
              throw Object.assign(
                new Error('smoke_error_log must be a string or null.'),
                {status: 400}
              );
            })();

      let retiredMap: Record<string, number> | undefined;
      if (
        body.retired_version_ids_by_ladder !== undefined &&
        body.retired_version_ids_by_ladder !== null
      ) {
        if (
          typeof body.retired_version_ids_by_ladder !== 'object' ||
          Array.isArray(body.retired_version_ids_by_ladder)
        ) {
          sendJson(res, 400, {error: 'retired_version_ids_by_ladder must be an object.'});
          return;
        }
        retiredMap = {};
        for (const [k, v] of Object.entries(
          body.retired_version_ids_by_ladder as Record<string, unknown>
        )) {
          if (!isPosInt(v)) {
            sendJson(
              res,
              400,
              {error: `retired_version_ids_by_ladder["${k}"] must be a positive integer.`}
            );
            return;
          }
          retiredMap[k] = v;
        }
      }

      const nowSec = getNowSec();
      const result = db.applySubmissionStatus({
        versionId,
        smokeStatus: smokeStatus as Exclude<SmokeStatus, 'pending_pull'>,
        unpackedBytes,
        smokeDurationMs,
        smokeTurnMs,
        smokePeakRamMb,
        smokeErrorLog,
        retiredVersionIdsByLadder: retiredMap,
        now: nowSec,
      });

      Promise.resolve(options.onSubmissionStatus?.(result)).catch(err => {
        console.error('Error in onSubmissionStatus callback:', err);
      });
      Promise.resolve(options.onUpdate?.('submission-status')).catch(err => {
        console.error('Error in onUpdate callback:', err);
      });

      sendJson(res, 200, {
        ok: true,
        version_id: result.version.id,
        smoke_status: result.version.smoke_status,
        retired_by_ladder: result.retiredByLadder,
      });
    } catch (err) {
      const status = (err as {status?: number}).status ?? 500;
      const message = err instanceof Error ? err.message : 'Submission status update failed.';
      sendJson(res, status, {error: message});
    }
  });

  app.post('/api/arena/heartbeat', async (req, res) => {
    if (!authenticateArena(req, res)) return;

    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      const status = (err as {status?: number}).status ?? 400;
      const message = err instanceof Error ? err.message : 'Invalid request body.';
      sendJson(res, status, {error: message});
      return;
    }

    const nowSec = getNowSec();
    try {
      if (body.idle === true || body.live === null) {
        currentLive = null;
        armWatchdog(nowSec);
        writeLiveJson(nowSec, false);
        sendJson(res, 200, {ok: true, updated_at: nowSec});
        return;
      }

      if (!isNonNegInt(body.heartbeat_seq)) {
        sendJson(res, 400, {error: 'heartbeat_seq must be a non-negative integer.'});
        return;
      }
      if (typeof body.match_id !== 'string' || !body.match_id.trim()) {
        sendJson(res, 400, {error: 'match_id is required.'});
        return;
      }
      if (typeof body.ladder_id !== 'string' || !body.ladder_id.trim()) {
        sendJson(res, 400, {error: 'ladder_id is required.'});
        return;
      }
      if (typeof body.format_id !== 'string' || !body.format_id.trim()) {
        sendJson(res, 400, {error: 'format_id is required.'});
        return;
      }
      if (body.game_num !== 1 && body.game_num !== 2) {
        sendJson(res, 400, {error: 'game_num must be 1 or 2.'});
        return;
      }
      if (!isNonNegInt(body.turn)) {
        sendJson(res, 400, {error: 'turn must be a non-negative integer.'});
        return;
      }
      if (body.active_slot !== 'p1' && body.active_slot !== 'p2' && body.active_slot !== null) {
        sendJson(res, 400, {error: 'active_slot must be "p1", "p2", or null.'});
        return;
      }
      if (!isFiniteNonNeg(body.turn_budget_s) || !isFiniteNonNeg(body.increment_s)) {
        sendJson(res, 400, {error: 'turn_budget_s and increment_s must be non-negative numbers.'});
        return;
      }

      let g1Summary: {winner_slot: 'p1' | 'p2' | null; turns: number} | null = null;
      if (body.g1_summary !== undefined && body.g1_summary !== null) {
        if (typeof body.g1_summary !== 'object' || Array.isArray(body.g1_summary)) {
          sendJson(res, 400, {error: 'Invalid g1_summary.'});
          return;
        }
        const g1 = body.g1_summary as Record<string, unknown>;
        if (g1.winner_slot !== 'p1' && g1.winner_slot !== 'p2' && g1.winner_slot !== null) {
          sendJson(res, 400, {error: 'g1_summary.winner_slot must be "p1", "p2", or null.'});
          return;
        }
        if (!isNonNegInt(g1.turns)) {
          sendJson(res, 400, {error: 'g1_summary.turns must be a non-negative integer.'});
          return;
        }
        g1Summary = {winner_slot: g1.winner_slot, turns: g1.turns};
      }

      const p1 = parseSlotTelemetry(body.p1, 'p1');
      const p2 = parseSlotTelemetry(body.p2, 'p2');
      const matchId = body.match_id.trim();
      const ladderId = body.ladder_id.trim();
      const ladder = db.getLadder(ladderId);

      const sameActiveTurn = (
        currentLive !== null &&
        currentLive.match_id === matchId &&
        currentLive.game_num === body.game_num &&
        currentLive.turn === body.turn &&
        currentLive.active_slot === body.active_slot
      );
      const turnStartedAt = isPosInt(body.turn_started_at)
        ? body.turn_started_at
        : sameActiveTurn
          ? currentLive!.turn_started_at
          : nowSec;

      currentLive = {
        heartbeat_seq: body.heartbeat_seq,
        match_id: matchId,
        ladder_id: ladderId,
        slot: ladder?.slot,
        format_id: body.format_id.trim(),
        game_num: body.game_num,
        turn: body.turn,
        active_slot: body.active_slot,
        turn_started_at: turnStartedAt,
        turn_budget_s: body.turn_budget_s,
        increment_s: body.increment_s,
        g1_summary: g1Summary,
        p1,
        p2,
      };
      lastMatchId = matchId;

      armWatchdog(nowSec);
      writeLiveJson(nowSec, false);
      sendJson(res, 200, {ok: true, updated_at: nowSec});
    } catch (err) {
      const status = (err as {status?: number}).status ?? 500;
      const message = err instanceof Error ? err.message : 'Heartbeat processing failed.';
      sendJson(res, status, {error: message});
    }
  });

  app.post('/api/arena/match-complete', async (req, res) => {
    if (!authenticateArena(req, res)) return;

    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      const status = (err as {status?: number}).status ?? 400;
      const message = err instanceof Error ? err.message : 'Invalid request body.';
      sendJson(res, status, {error: message});
      return;
    }

    try {
      const match = parseCompletedMatch(body.match);

      let ladderStatus: LadderStatus | undefined;
      if (body.ladder_status !== undefined && body.ladder_status !== null) {
        if (
          typeof body.ladder_status !== 'string' ||
          !VALID_LADDER_STATUSES.has(body.ladder_status as LadderStatus)
        ) {
          sendJson(res, 400, {error: 'Invalid ladder_status.'});
          return;
        }
        ladderStatus = body.ladder_status as LadderStatus;
      }

      let ladderStandings: LadderStandingOverride[] | undefined;
      if (body.ladder_standings !== undefined && body.ladder_standings !== null) {
        if (!Array.isArray(body.ladder_standings)) {
          sendJson(res, 400, {error: 'ladder_standings must be an array.'});
          return;
        }
        ladderStandings = [];
        for (const item of body.ladder_standings as unknown[]) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            sendJson(res, 400, {error: 'Invalid entry in ladder_standings.'});
            return;
          }
          const s = item as Record<string, unknown>;
          if (!isPosInt(s.version_id)) {
            sendJson(res, 400, {error: 'ladder_standings[].version_id must be a positive int.'});
            return;
          }
          if (s.role !== undefined && (
            typeof s.role !== 'string' || !VALID_ROLES.has(s.role as EntryRole)
          )) {
            sendJson(res, 400, {error: 'Invalid ladder_standings[].role.'});
            return;
          }
          if (s.is_anchor !== undefined && s.is_anchor !== 0 && s.is_anchor !== 1) {
            sendJson(res, 400, {error: 'ladder_standings[].is_anchor must be 0 or 1.'});
            return;
          }
          ladderStandings.push({
            version_id: s.version_id,
            role: s.role as EntryRole | undefined,
            is_anchor: s.is_anchor,
          });
        }
      }

      const {duplicate, archivedLadder} = db.recordCompletedMatch({
        match,
        ladderStatus,
        ladderStandings,
      });

      const nowSec = getNowSec();
      lastMatchId = match.id;
      if (currentLive?.match_id === match.id) {
        currentLive = null;
      }
      armWatchdog(nowSec);
      writeLiveJson(nowSec, false);

      if (!duplicate) {
        Promise.resolve(options.onMatchComplete?.({match, duplicate, archivedLadder})).catch(
          err => {
            console.error('Error in onMatchComplete callback:', err);
          }
        );
        Promise.resolve(options.onUpdate?.('match-complete')).catch(err => {
          console.error('Error in onUpdate callback:', err);
        });
      }

      sendJson(res, 200, {ok: true, duplicate, archived_ladder: archivedLadder});
    } catch (err) {
      const status = (err as {status?: number}).status ?? 500;
      const message = err instanceof Error ? err.message : 'Match completion failed.';
      sendJson(res, status, {error: message});
    }
  });

  return {
    close: clearWatchdog,
    writeLiveJson: (nowSec?: number) => writeLiveJson(nowSec, false),
    getState: () => ({
      lastSeenAt,
      watchdogTriggered,
      live: currentLive,
    }),
  };
}
