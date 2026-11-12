import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

import polka from 'polka';

import type * as db from '../db';
import {VERSION_RE, root, validateAgentName} from '../static/util';

import {decryptSecret} from './account';
import {Auth} from './auth';
import * as ratings from './ratings';

export const PUBLIC_DIR = root('public');
// If the Mac Mini Arena worker stops heartbeating for 15 minutes (network drop, power loss,
// or wedged supervisor), mark public/api/live.json stale so spectators aren't shown a frozen
// turn clock and alert staff on Discord.
export const WATCHDOG_TIMEOUT_MILLIS = 15 * 60 * 1000;
export const STARTING_BANK_SECONDS = 150;
export const FIRST_TURN_GRACE_SECONDS = 60;
export const MAX_TURN_SECONDS = 150;
export const MID_TURN_INCREMENT_SECONDS = 5;
export const SINGLES_INCREMENT_SECONDS = 10;
export const DOUBLES_INCREMENT_SECONDS = 25;
export const MAX_BATTLE_TURNS = 1000;

export function turnIncrementSeconds(format: string): number {
  return format.includes('doubles') || format.includes('vgc')
    ? DOUBLES_INCREMENT_SECONDS
    : SINGLES_INCREMENT_SECONDS;
}

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const RECENT_MATCHES_LIMIT = 50;

const VALID_SMOKE_UPDATES = new Set<Exclude<db.SmokeStatus, 'pending'>>([
  'passed',
  'failed',
  'quarantined',
]);
const VALID_GAME_OUTCOMES = new Set<ratings.GameOutcome>(['W', 'L', 'T']);
const VALID_MATCH_CATEGORIES = new Set<ratings.MatchCategory>([
  'WW', 'WT', 'TW', 'WL', 'LW', 'TT', 'TL', 'LT', 'LL',
]);
const VALID_ROLES = new Set<db.EntryRole>([
  'champion', 'challenger', 'retired', 'quarantined',
]);
const VALID_LADDER_STATUSES = new Set<db.LadderStatus>([
  'upcoming', 'active', 'settling', 'archived',
]);
const VALID_SLOTS = new Set<string>(['rby', 'adv', 'sv', 'rand', 'vgc']);

export interface LiveSlot {
  slug: string;
  name: string;
  version: string;
  bankSeconds: number;
  lastTurnMillis: number;
  meanTurnMillis: number;
  ram: number;
  team?: string;
}

// Live telemetry intentionally enforces a strict zero-log anti-scouting policy: spectators see
// turn numbers, Showdown chess clocks, SIGSTOP/SIGCONT slot state, and XNU physical footprint
// RAM, never teams, Pokémon species, move choices, or battle protocol logs.
export interface LiveMatch {
  heartbeatSeq: number;
  matchId: string;
  ladderId: string;
  slot?: db.LadderSlot;
  format: string;
  game: 1 | 2;
  turn: number;
  activeSlot?: 'p1' | 'p2';
  turnStartedAt: number;
  turnBudgetSeconds: number;
  incrementSeconds: number;
  game1Summary?: {winnerSlot?: 'p1' | 'p2'; turns: number};
  p1: LiveSlot;
  p2: LiveSlot;
}

export interface BattleHistoryEntry extends db.RecentMatchView {
  ladderHref: string;
  archiveHref?: string;
  teamsHref?: string;
}

export interface LiveDocument {
  updatedAt: number;
  stale: boolean;
  live?: LiveMatch;
  pageSize?: number;
  totalMatches?: number;
  countsBySlot?: Record<string, number>;
  historyEndpoint?: string;
  recentMatches: BattleHistoryEntry[];
}

export function enrichMatchView(publicDir: string, m: db.RecentMatchView): BattleHistoryEntry {
  const ladderHref = m.ladderStatus === 'archived'
    ? `/arena/ladders/${encodeURIComponent(m.ladderId)}/`
    : `/arena/ladders/${encodeURIComponent(m.slot)}/`;
  if (m.teamMode !== 'pools' || m.ladderStatus !== 'archived') {
    return {...m, ladderHref};
  }
  const ladderDir = path.join(publicDir, 'arena', 'ladders', m.ladderId);
  const archiveFile = `${m.ladderId}-logs.7z`;
  const idEnc = encodeURIComponent(m.ladderId);
  const archiveHref = fs.existsSync(path.join(ladderDir, archiveFile))
    ? `/arena/ladders/${idEnc}/${encodeURIComponent(archiveFile)}`
    : undefined;
  const teamsHref = fs.existsSync(path.join(ladderDir, 'teams.json'))
    ? `/arena/ladders/${idEnc}/teams.json`
    : undefined;
  return {...m, ladderHref, archiveHref, teamsHref};
}

export interface WatchdogAlert {
  lastSeenAt: number;
  lastMatchId?: string;
}

export interface Options {
  db: db.Database;
  auth?: Auth;
  arenaSecret?: string;
  sessionSecret?: string;
  publicDir?: string;
  watchdogTimeoutMillis?: number;
  recentMatchesLimit?: number;
  now?: () => number;
  onSubmissionStatus?: (result: db.ApplySubmissionStatusResult) => void | Promise<void>;
  onMatchComplete?: (event: {
    match: db.CompletedMatchPayload;
    duplicate: boolean;
    archivedLadder: boolean;
  }) => void | Promise<void>;
  onWatchdogTimeout?: (alert: WatchdogAlert) => void | Promise<void>;
  onUpdate?: (
    reason: 'submission-status' | 'match-complete' | 'archive-published'
  ) => void | Promise<void>;
}

export interface Handle {
  close: () => void;
  writeLiveJson: (nowSeconds?: number) => LiveDocument;
  getState: () => {
    lastSeenAt?: number;
    watchdogTriggered: boolean;
    live?: LiveMatch;
  };
}

export interface PendingLadder {
  id: string;
  slot: db.LadderSlot;
  name: string;
  format: string;
  team: db.TeamMode;
  min: number;
  teams?: number;
  status: db.LadderStatus;
}

export interface PendingSubmission {
  versionId: number;
  agentId: number;
  agentSlug: string;
  agentName: string;
  version: string;
  package: db.PackageFormat;
  url: string;
  sha256: string;
  authToken?: string;
  ladders: string[];
  tournaments: string[];
  teamsByLadder: Record<string, string[]>;
}

export interface PendingSubmissionsResponse {
  ladders: PendingLadder[];
  submissions: PendingSubmission[];
}

export interface SubmissionStatusPayload {
  versionId: number;
  smokeStatus: Exclude<db.SmokeStatus, 'pending'>;
  unpackedBytes?: number;
  smokeDurationMillis?: number;
  smokeTurnMillis?: number;
  smokePeakRam?: number;
  smokeError?: string;
  retiredVersionIdsByLadder?: Record<string, number>;
}

export interface SubmissionStatusResponse {
  ok: true;
  versionId: number;
  smokeStatus: db.SmokeStatus;
  retiredByLadder: Record<string, number>;
}

export type HeartbeatPayload = LiveMatch | {idle: true};

export interface HeartbeatResponse {
  ok: true;
  updatedAt: number;
}

export interface MatchCompletePayload {
  match: db.CompletedMatchPayload;
  ladderStatus?: db.LadderStatus;
  ladderStandings?: db.LadderStandingOverride[];
}

export interface MatchCompleteResponse {
  ok: true;
  duplicate: boolean;
  archivedLadder: boolean;
}

export interface LadderArchiveResponse {
  ok: true;
  ladderId: string;
  archiveHref: string;
  teamsHref: string;
  bytes: number;
  sha256: string;
}

export interface TournamentArchiveResponse {
  ok: true;
  tournamentId: string;
  archiveHref: string;
  bytes: number;
  sha256: string;
}

export interface ClientOptions {
  serverUrl: string;
  arenaSecret: string;
  fetch?: typeof globalThis.fetch;
}

export function buildLadderMatchState(
  ladder: db.LadderRow,
  entries: db.LeaderboardEntryView[],
  pairs: db.PairAggregateRow[],
  lastMatchNumber = 0,
  rosterAgentIds?: ReadonlySet<number>
): ratings.LadderMatchState | undefined {
  if (ladder.status !== 'active' && ladder.status !== 'settling') return undefined;
  const isPlayableEntry = (e: db.LeaderboardEntryView) =>
    e.role !== 'retired' && (!rosterAgentIds || rosterAgentIds.has(e.agentId));
  const activeEntries = entries.filter(isPlayableEntry);
  const distinctAgents = new Set(activeEntries.map(e => e.agentId));
  if (distinctAgents.size < Math.max(2, ladder.min)) return undefined;
  if (ladder.status === 'settling' && activeEntries.every(e => e.settledAt !== undefined)) {
    return undefined;
  }

  const M = entries.length;
  const indexByVersion = new Map<number, number>();
  const activeIndices: number[] = [];
  const agentIds = new Int32Array(M);
  const theta = new Float64Array(M);
  const sigma = new Float64Array(M);
  const agentMatches = new Int32Array(M);
  const pairMatches = new Int32Array(M * M);

  for (let i = 0; i < M; i++) {
    const e = entries[i];
    indexByVersion.set(e.versionId, i);
    if (isPlayableEntry(e)) activeIndices.push(i);
    agentIds[i] = e.agentId;
    theta[i] = (e.elo - 1500) / ratings.ELO_SCALE;
    sigma[i] = e.se / ratings.ELO_SCALE;
    agentMatches[i] = e.matches;
  }

  for (const pair of pairs) {
    const i = indexByVersion.get(pair.lowVersionId);
    const j = indexByVersion.get(pair.highVersionId);
    if (i !== undefined && j !== undefined) {
      const count = pair.ww + pair.wt + pair.split + pair.tl + pair.ll;
      pairMatches[i * M + j] = count;
      pairMatches[j * M + i] = count;
    }
  }

  return {
    id: ladder.id,
    activeAgentIndices: activeIndices,
    agentIds,
    minAgents: ladder.min,
    theta,
    sigma,
    agentMatches,
    pairMatches,
    lastMatchNumber,
  };
}

// Outbound worker control-plane HTTP client used by the Mac Mini Arena coordinator (and `--server`
// mock scenarios) to communicate with `/api/arena/*` using `Bearer $ARENA_SECRET`.
export class Client {
  readonly serverUrl: string;
  private readonly arenaSecret: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: ClientOptions) {
    this.serverUrl = options.serverUrl.replace(/\/+$/, '');
    this.arenaSecret = options.arenaSecret;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  private async requestJson<T>(
    method: 'GET' | 'POST',
    endpoint: string,
    body?: unknown
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.arenaSecret}`,
    };
    let serialized: string | undefined;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      serialized = JSON.stringify(body);
    }
    const res = await this.fetchImpl(`${this.serverUrl}${endpoint}`, {
      method,
      headers,
      body: serialized,
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? (JSON.parse(text) as unknown) : {};
    } catch {
      parsed = {error: text};
    }
    if (!res.ok) {
      const errMsg = parsed && typeof parsed === 'object' && 'error' in parsed
        ? String(parsed.error)
        : text;
      throw new Error(`${method} ${endpoint} failed (${res.status}): ${errMsg}`);
    }
    return parsed as T;
  }

  private async uploadArchive<T>(
    endpoint: string,
    archive: Uint8Array,
    sha256?: string
  ): Promise<T> {
    const digest = sha256 ?? crypto.createHash('sha256').update(archive).digest('hex');
    const res = await this.fetchImpl(`${this.serverUrl}${endpoint}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${this.arenaSecret}`,
        'content-type': 'application/x-7z-compressed',
        'x-content-sha256': digest,
      },
      body: Buffer.from(archive),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? (JSON.parse(text) as unknown) : {};
    } catch {
      parsed = {error: text};
    }
    if (!res.ok) {
      const errMsg = parsed && typeof parsed === 'object' && 'error' in parsed
        ? String(parsed.error)
        : text;
      throw new Error(`PUT ${endpoint} failed (${res.status}): ${errMsg}`);
    }
    return parsed as T;
  }

  getPendingSubmissions(): Promise<PendingSubmissionsResponse> {
    return this.requestJson<PendingSubmissionsResponse>('GET', '/api/arena/pending-submissions');
  }

  reportSubmissionStatus(payload: SubmissionStatusPayload): Promise<SubmissionStatusResponse> {
    return this.requestJson<SubmissionStatusResponse>(
      'POST',
      '/api/arena/submission-status',
      payload
    );
  }

  sendHeartbeat(payload: HeartbeatPayload): Promise<HeartbeatResponse> {
    return this.requestJson<HeartbeatResponse>('POST', '/api/arena/heartbeat', payload);
  }

  completeMatch(payload: MatchCompletePayload): Promise<MatchCompleteResponse> {
    return this.requestJson<MatchCompleteResponse>('POST', '/api/arena/match-complete', payload);
  }

  uploadLadderArchive(
    ladderId: string,
    archive: Uint8Array,
    sha256?: string
  ): Promise<LadderArchiveResponse> {
    return this.uploadArchive<LadderArchiveResponse>(
      `/api/arena/ladders/${encodeURIComponent(ladderId)}/archive`,
      archive,
      sha256
    );
  }

  uploadTournamentArchive(
    tournamentId: string,
    archive: Uint8Array,
    sha256?: string
  ): Promise<TournamentArchiveResponse> {
    return this.uploadArchive<TournamentArchiveResponse>(
      `/api/arena/tournaments/${encodeURIComponent(tournamentId)}/archive`,
      archive,
      sha256
    );
  }
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

function streamBinaryArchive(
  req: http.IncomingMessage,
  destPath: string,
  expectedSha256?: string
): Promise<{bytes: number; sha256: string}> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destPath), {recursive: true});
    const tmpPath = `${destPath}.tmp.${process.pid}.${Date.now()}`;
    const out = fs.createWriteStream(tmpPath);
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    let settled = false;

    const cleanupFail = (err: Error) => {
      if (settled) return;
      settled = true;
      out.destroy();
      try {
        fs.rmSync(tmpPath, {force: true});
      } catch {}
      reject(err);
    };

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > MAX_ARCHIVE_BYTES) {
        req.resume();
        cleanupFail(
          Object.assign(new Error('Archive exceeds 512 MiB limit.'), {status: 413})
        );
        return;
      }
      hash.update(chunk);
      out.write(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      out.end(() => {
        if (settled) return;
        if (bytes === 0) {
          cleanupFail(Object.assign(new Error('Archive body must not be empty.'), {status: 400}));
          return;
        }
        const sha256 = hash.digest('hex');
        if (expectedSha256 && sha256 !== expectedSha256.toLowerCase()) {
          const msg = `SHA-256 mismatch: expected ${expectedSha256.toLowerCase()}, got ${sha256}.`;
          cleanupFail(Object.assign(new Error(msg), {status: 400}));
          return;
        }
        try {
          fs.renameSync(tmpPath, destPath);
          settled = true;
          resolve({bytes, sha256});
        } catch (err) {
          cleanupFail(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });

    req.on('error', err => {
      cleanupFail(err instanceof Error ? err : new Error(String(err)));
    });
    out.on('error', err => {
      cleanupFail(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

// Hash both secrets with SHA-256 before timingSafeEqual so secret length isn't leaked via timing.
function safeSecretEquals(provided: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// Write to a sibling temp file and rename(2) atomically so Nginx serving /api/live.json directly
// from disk never observes a half-written JSON payload during concurrent spectator polling.
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

function parseLiveSlot(raw: unknown, label: string): LiveSlot {
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
  try {
    validateAgentName(obj.name);
  } catch {
    throw Object.assign(new Error(`Invalid ${label}.name.`), {status: 400});
  }
  if (typeof obj.version !== 'string' || !VERSION_RE.test(obj.version.trim())) {
    throw Object.assign(new Error(`Invalid ${label}.version.`), {status: 400});
  }
  if (!isFiniteNonNeg(obj.bankSeconds)) {
    throw Object.assign(new Error(`Invalid ${label}.bankSeconds.`), {status: 400});
  }
  if (!isFiniteNonNeg(obj.lastTurnMillis)) {
    throw Object.assign(new Error(`Invalid ${label}.lastTurnMillis.`), {status: 400});
  }
  if (!isFiniteNonNeg(obj.meanTurnMillis)) {
    throw Object.assign(new Error(`Invalid ${label}.meanTurnMillis.`), {status: 400});
  }
  if (!isFiniteNonNeg(obj.ram)) {
    throw Object.assign(new Error(`Invalid ${label}.ram.`), {status: 400});
  }
  let team: string | undefined;
  if (obj.team !== undefined) {
    if (typeof obj.team !== 'string' || !obj.team.trim() || obj.team.trim().length > 32) {
      throw Object.assign(new Error(`Invalid ${label}.team.`), {status: 400});
    }
    team = obj.team.trim();
  }
  return {
    slug: obj.slug.trim(),
    name: obj.name.trim(),
    version: obj.version.trim(),
    bankSeconds: obj.bankSeconds,
    lastTurnMillis: obj.lastTurnMillis,
    meanTurnMillis: obj.meanTurnMillis,
    ram: obj.ram,
    team,
  };
}

function parseCompletedMatch(raw: unknown): db.CompletedMatchPayload {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw Object.assign(new Error('Missing or invalid "match" object.'), {status: 400});
  }
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== 'string' || !m.id.trim()) {
    throw Object.assign(new Error('Invalid match.id.'), {status: 400});
  }
  if (typeof m.ladderId !== 'string' || !m.ladderId.trim()) {
    throw Object.assign(new Error('Invalid match.ladderId.'), {status: 400});
  }
  if (!isPosInt(m.p1VersionId) || !isPosInt(m.p2VersionId) || m.p1VersionId === m.p2VersionId) {
    throw Object.assign(
      new Error('match.p1VersionId and match.p2VersionId must be distinct positive integers.'),
      {status: 400}
    );
  }
  if (typeof m.seed !== 'string' || !m.seed.trim()) {
    throw Object.assign(new Error('Invalid match.seed.'), {status: 400});
  }
  if (
    typeof m.game1Outcome !== 'string' ||
    !VALID_GAME_OUTCOMES.has(m.game1Outcome as ratings.GameOutcome)
  ) {
    throw Object.assign(new Error('Invalid match.game1Outcome.'), {status: 400});
  }
  if (
    typeof m.game2Outcome !== 'string' ||
    !VALID_GAME_OUTCOMES.has(m.game2Outcome as ratings.GameOutcome)
  ) {
    throw Object.assign(new Error('Invalid match.game2Outcome.'), {status: 400});
  }
  const expectedCat = `${m.game1Outcome}${m.game2Outcome}` as ratings.MatchCategory;
  if (
    typeof m.category !== 'string' ||
    !VALID_MATCH_CATEGORIES.has(m.category as ratings.MatchCategory) ||
    m.category !== expectedCat
  ) {
    throw Object.assign(
      new Error(`match.category must equal "${expectedCat}".`),
      {status: 400}
    );
  }
  if (!isNonNegInt(m.game1Turns) || !isNonNegInt(m.game2Turns)) {
    throw Object.assign(new Error('Invalid match turn counts.'), {status: 400});
  }
  if (typeof m.game1EndReason !== 'string' || !m.game1EndReason.trim()) {
    throw Object.assign(new Error('Invalid match.game1EndReason.'), {status: 400});
  }
  if (typeof m.game2EndReason !== 'string' || !m.game2EndReason.trim()) {
    throw Object.assign(new Error('Invalid match.game2EndReason.'), {status: 400});
  }
  if (!isNonNegInt(m.p1PeakRam) || !isNonNegInt(m.p2PeakRam)) {
    throw Object.assign(new Error('Invalid peak RAM telemetry.'), {status: 400});
  }
  if (
    !isFiniteNonNeg(m.p1Game1BankSeconds) ||
    !isFiniteNonNeg(m.p1Game2BankSeconds) ||
    !isFiniteNonNeg(m.p2Game1BankSeconds) ||
    !isFiniteNonNeg(m.p2Game2BankSeconds)
  ) {
    throw Object.assign(new Error('Invalid bank telemetry.'), {status: 400});
  }
  if (!isNonNegInt(m.p1MeanTurnMillis) || !isNonNegInt(m.p2MeanTurnMillis)) {
    throw Object.assign(new Error('Invalid meanTurnMillis telemetry.'), {status: 400});
  }
  if (!isPosInt(m.completedAt)) {
    throw Object.assign(new Error('Invalid match.completedAt.'), {status: 400});
  }

  return {
    id: m.id.trim(),
    ladderId: m.ladderId.trim(),
    p1VersionId: m.p1VersionId,
    p2VersionId: m.p2VersionId,
    seed: m.seed.trim(),
    p1TeamLabel: typeof m.p1TeamLabel === 'string' ? m.p1TeamLabel : undefined,
    p2TeamLabel: typeof m.p2TeamLabel === 'string' ? m.p2TeamLabel : undefined,
    game1Outcome: m.game1Outcome as ratings.GameOutcome,
    game2Outcome: m.game2Outcome as ratings.GameOutcome,
    category: m.category,
    game1Turns: m.game1Turns,
    game2Turns: m.game2Turns,
    game1EndReason: m.game1EndReason.trim(),
    game2EndReason: m.game2EndReason.trim(),
    p1PeakRam: m.p1PeakRam,
    p2PeakRam: m.p2PeakRam,
    p1Game1BankSeconds: m.p1Game1BankSeconds,
    p1Game2BankSeconds: m.p1Game2BankSeconds,
    p2Game1BankSeconds: m.p2Game1BankSeconds,
    p2Game2BankSeconds: m.p2Game2BankSeconds,
    p1MeanTurnMillis: m.p1MeanTurnMillis,
    p2MeanTurnMillis: m.p2MeanTurnMillis,
    completedAt: m.completedAt,
  };
}

// Registers the outbound-only Arena worker control-plane endpoints (/api/arena/*).
// The Mac Mini Arena host initiates all connections to the Linode web server authenticated by
// Bearer $ARENA_SECRET, so the public VPS holds zero inbound credentials to the execution host.
export function register(app: polka.Polka, options: Options): Handle {
  const {db} = options;
  const publicDir = options.publicDir ?? PUBLIC_DIR;
  const liveJsonPath = path.join(publicDir, 'api', 'live.json');
  const watchdogMillis = options.watchdogTimeoutMillis ?? WATCHDOG_TIMEOUT_MILLIS;
  const recentLimit = options.recentMatchesLimit ?? RECENT_MATCHES_LIMIT;
  const getNowSec = options.now ?? (() => Math.floor(Date.now() / 1000));

  let currentLive: LiveMatch | undefined;
  let lastSeenAt: number | undefined;
  let lastMatchId: string | undefined;
  let watchdogTriggered = false;
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;

  const getArenaSecret = (): string | undefined =>
    options.arenaSecret ?? options.auth?.getConfig()?.arenaSecret ?? process.env.ARENA_SECRET;

  const getSessionSecret = (): string | undefined =>
    options.sessionSecret ?? options.auth?.getConfig()?.sessionSecret ?? process.env.SESSION_SECRET;

  const writeLiveJson = (nowSec = getNowSec(), stale = false): LiveDocument => {
    const countsBySlot = db.getMatchCountsBySlot();
    const recentMatches = db.getRecentMatches(recentLimit).map(m => enrichMatchView(publicDir, m));
    const doc: LiveDocument = {
      updatedAt: nowSec,
      stale,
      live: stale ? undefined : currentLive,
      pageSize: recentLimit,
      totalMatches: countsBySlot.all ?? recentMatches.length,
      countsBySlot,
      historyEndpoint: '/api/battles.json',
      recentMatches,
    };
    writeFileAtomic(liveJsonPath, `${JSON.stringify(doc)}\n`);
    const battlesDir = path.join(publicDir, 'arena', 'battles');
    if (fs.existsSync(battlesDir)) {
      writeFileAtomic(
        path.join(battlesDir, 'index.json'),
        `${JSON.stringify(doc, undefined, 2)}\n`
      );
    }
    return doc;
  };

  const clearWatchdog = () => {
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = undefined;
    }
  };

  const armWatchdog = (seenAtSec: number) => {
    lastSeenAt = seenAtSec;
    watchdogTriggered = false;
    clearWatchdog();
    if (watchdogMillis <= 0) return;

    watchdogTimer = setTimeout(() => {
      watchdogTimer = undefined;
      if (watchdogTriggered || lastSeenAt === undefined) return;
      watchdogTriggered = true;
      const stalledMatchId = currentLive?.matchId ?? lastMatchId;
      currentLive = undefined;
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
    }, watchdogMillis);
    watchdogTimer.unref();
  };

  const authenticateArena = (req: http.IncomingMessage, res: http.ServerResponse): boolean => {
    const expected = getArenaSecret();
    if (!expected) {
      sendJson(res, 503, {error: 'ARENA_SECRET is not configured on the server.'});
      return false;
    }
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer\s+(\S+)$/i.exec(header.trim()) : undefined;
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
        name: l.name,
        format: l.format,
        team: l.team,
        min: l.min,
        teams: l.teams,
        status: l.status,
      }));
      const sessionSecret = getSessionSecret();
      const submissions = db.getPendingSubmissions().map(sub => {
        let authToken: string | undefined;
        // Private artifact pull tokens are encrypted at rest with HKDF(SESSION_SECRET) and
        // decrypted only in-memory while serving the authenticated Arena worker pull queue;
        // applySubmissionStatus wipes auth_token_encoding from SQLite once pulled.
        if (sub.authTokenEncoding) {
          if (!sessionSecret) {
            throw new Error('SESSION_SECRET is required to decrypt pending submission authToken');
          }
          authToken = decryptSecret(sub.authTokenEncoding, sessionSecret);
        }
        return {
          versionId: sub.versionId,
          agentId: sub.agentId,
          agentSlug: sub.agentSlug,
          agentName: sub.agentName,
          version: sub.version,
          package: sub.package,
          url: sub.url,
          sha256: sub.sha256,
          authToken,
          ladders: sub.ladders,
          tournaments: sub.tournaments,
          teamsByLadder: sub.teamsByLadder,
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

    const versionId = body.versionId;
    const smokeStatus = body.smokeStatus;
    if (!isPosInt(versionId)) {
      sendJson(res, 400, {error: 'versionId must be a positive integer.'});
      return;
    }
    if (
      typeof smokeStatus !== 'string' ||
      !VALID_SMOKE_UPDATES.has(smokeStatus as Exclude<db.SmokeStatus, 'pending'>)
    ) {
      sendJson(
        res,
        400,
        {error: 'smokeStatus must be "passed", "failed", or "quarantined".'}
      );
      return;
    }

    const optInt = (val: unknown, field: string): number | undefined => {
      if (val === undefined) return undefined;
      if (!isNonNegInt(val)) {
        throw Object.assign(
          new Error(`${field} must be a non-negative integer.`),
          {status: 400}
        );
      }
      return val;
    };

    try {
      const unpackedBytes = optInt(body.unpackedBytes, 'unpackedBytes');
      const smokeDurationMillis = optInt(body.smokeDurationMillis, 'smokeDurationMillis');
      const smokeTurnMillis = optInt(body.smokeTurnMillis, 'smokeTurnMillis');
      const smokePeakRam = optInt(body.smokePeakRam, 'smokePeakRam');
      let smokeError: string | undefined;
      if (body.smokeError !== undefined) {
        if (typeof body.smokeError !== 'string') {
          throw Object.assign(new Error('smokeError must be a string.'), {status: 400});
        }
        smokeError = body.smokeError.slice(0, 16_384);
      }

      let retiredMap: Record<string, number> | undefined;
      if (body.retiredVersionIdsByLadder !== undefined) {
        if (
          !body.retiredVersionIdsByLadder ||
          typeof body.retiredVersionIdsByLadder !== 'object' ||
          Array.isArray(body.retiredVersionIdsByLadder)
        ) {
          sendJson(res, 400, {error: 'retiredVersionIdsByLadder must be an object.'});
          return;
        }
        retiredMap = {};
        for (const [k, v] of Object.entries(
          body.retiredVersionIdsByLadder as Record<string, unknown>
        )) {
          if (!isPosInt(v)) {
            sendJson(
              res,
              400,
              {error: `retiredVersionIdsByLadder["${k}"] must be a positive integer.`}
            );
            return;
          }
          retiredMap[k] = v;
        }
      }

      const nowSec = getNowSec();
      const result = db.applySubmissionStatus({
        versionId,
        smokeStatus: smokeStatus as Exclude<db.SmokeStatus, 'pending'>,
        unpackedBytes,
        smokeDurationMillis,
        smokeTurnMillis,
        smokePeakRam,
        smokeError,
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
        versionId: result.version.id,
        smokeStatus: result.version.smokeStatus,
        retiredByLadder: result.retiredByLadder,
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
      if (body.idle === true) {
        currentLive = undefined;
        armWatchdog(nowSec);
        writeLiveJson(nowSec, false);
        sendJson(res, 200, {ok: true, updatedAt: nowSec});
        return;
      }

      if (!isNonNegInt(body.heartbeatSeq)) {
        sendJson(res, 400, {error: 'heartbeatSeq must be a non-negative integer.'});
        return;
      }
      if (typeof body.matchId !== 'string' || !body.matchId.trim()) {
        sendJson(res, 400, {error: 'matchId is required.'});
        return;
      }
      if (typeof body.ladderId !== 'string' || !body.ladderId.trim()) {
        sendJson(res, 400, {error: 'ladderId is required.'});
        return;
      }
      if (typeof body.format !== 'string' || !body.format.trim()) {
        sendJson(res, 400, {error: 'format is required.'});
        return;
      }
      if (body.game !== 1 && body.game !== 2) {
        sendJson(res, 400, {error: 'game must be 1 or 2.'});
        return;
      }
      if (!isNonNegInt(body.turn)) {
        sendJson(res, 400, {error: 'turn must be a non-negative integer.'});
        return;
      }
      if (
        body.activeSlot !== 'p1' &&
        body.activeSlot !== 'p2' &&
        body.activeSlot !== undefined
      ) {
        sendJson(res, 400, {error: 'activeSlot must be "p1", "p2", or omitted.'});
        return;
      }
      if (!isFiniteNonNeg(body.turnBudgetSeconds) || !isFiniteNonNeg(body.incrementSeconds)) {
        sendJson(
          res,
          400,
          {error: 'turnBudgetSeconds and incrementSeconds must be non-negative numbers.'}
        );
        return;
      }

      let game1Summary: {winnerSlot?: 'p1' | 'p2'; turns: number} | undefined;
      if (body.game1Summary !== undefined) {
        if (
          !body.game1Summary ||
          typeof body.game1Summary !== 'object' ||
          Array.isArray(body.game1Summary)
        ) {
          sendJson(res, 400, {error: 'Invalid game1Summary.'});
          return;
        }
        const g1 = body.game1Summary as Record<string, unknown>;
        if (
          g1.winnerSlot !== 'p1' &&
          g1.winnerSlot !== 'p2' &&
          g1.winnerSlot !== undefined
        ) {
          sendJson(res, 400, {error: 'game1Summary.winnerSlot must be "p1", "p2", or omitted.'});
          return;
        }
        if (!isNonNegInt(g1.turns)) {
          sendJson(res, 400, {error: 'game1Summary.turns must be a non-negative integer.'});
          return;
        }
        game1Summary = {winnerSlot: g1.winnerSlot, turns: g1.turns};
      }

      const p1 = parseLiveSlot(body.p1, 'p1');
      const p2 = parseLiveSlot(body.p2, 'p2');
      const matchId = body.matchId.trim();
      const ladderId = body.ladderId.trim();
      const ladder = db.getLadder(ladderId);

      // Preserve the turn start timestamp across mid-turn telemetry heartbeats so spectator
      // countdown clocks don't jump backward if the runner omits turnStartedAt on repeats.
      const sameActiveTurn = (
        currentLive?.matchId === matchId &&
        currentLive.game === body.game &&
        currentLive.turn === body.turn &&
        currentLive.activeSlot === body.activeSlot
      );
      const turnStartedAt = isPosInt(body.turnStartedAt)
        ? body.turnStartedAt
        : sameActiveTurn
          ? currentLive!.turnStartedAt
          : nowSec;

      currentLive = {
        heartbeatSeq: body.heartbeatSeq,
        matchId,
        ladderId,
        slot: ladder?.slot,
        format: body.format.trim(),
        game: body.game,
        turn: body.turn,
        activeSlot: body.activeSlot,
        turnStartedAt,
        turnBudgetSeconds: body.turnBudgetSeconds,
        incrementSeconds: body.incrementSeconds,
        game1Summary,
        p1,
        p2,
      };
      lastMatchId = matchId;

      armWatchdog(nowSec);
      writeLiveJson(nowSec, false);
      sendJson(res, 200, {ok: true, updatedAt: nowSec});
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

      let ladderStatus: db.LadderStatus | undefined;
      if (body.ladderStatus !== undefined) {
        if (
          typeof body.ladderStatus !== 'string' ||
          !VALID_LADDER_STATUSES.has(body.ladderStatus as db.LadderStatus)
        ) {
          sendJson(res, 400, {error: 'Invalid ladderStatus.'});
          return;
        }
        ladderStatus = body.ladderStatus as db.LadderStatus;
      }

      let ladderStandings: db.LadderStandingOverride[] | undefined;
      if (body.ladderStandings !== undefined) {
        if (!Array.isArray(body.ladderStandings)) {
          sendJson(res, 400, {error: 'ladderStandings must be an array.'});
          return;
        }
        ladderStandings = [];
        for (const item of body.ladderStandings as unknown[]) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            sendJson(res, 400, {error: 'Invalid entry in ladderStandings.'});
            return;
          }
          const s = item as Record<string, unknown>;
          if (!isPosInt(s.versionId)) {
            sendJson(res, 400, {error: 'ladderStandings[].versionId must be a positive int.'});
            return;
          }
          if (s.role !== undefined && (
            typeof s.role !== 'string' || !VALID_ROLES.has(s.role as db.EntryRole)
          )) {
            sendJson(res, 400, {error: 'Invalid ladderStandings[].role.'});
            return;
          }
          let isAnchor: number | undefined;
          if (s.isAnchor !== undefined) {
            if (typeof s.isAnchor === 'boolean') {
              isAnchor = s.isAnchor ? 1 : 0;
            } else if (s.isAnchor === 0 || s.isAnchor === 1) {
              isAnchor = s.isAnchor;
            } else {
              sendJson(res, 400, {error: 'ladderStandings[].isAnchor must be a boolean or 0/1.'});
              return;
            }
          }
          ladderStandings.push({
            versionId: s.versionId,
            role: s.role as db.EntryRole | undefined,
            isAnchor,
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
      if (currentLive?.matchId === match.id) {
        currentLive = undefined;
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

      sendJson(res, 200, {ok: true, duplicate, archivedLadder});
    } catch (err) {
      const status = (err as {status?: number}).status ?? 500;
      const message = err instanceof Error ? err.message : 'Match completion failed.';
      sendJson(res, status, {error: message});
    }
  });

  app.put('/api/arena/tournaments/:id/archive', async (req, res) => {
    if (!authenticateArena(req, res)) return;

    const paramId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const rawId = decodeURIComponent(paramId ?? '').trim();
    const tournament = db.getTournament(rawId);
    if (!tournament) {
      req.resume();
      sendJson(res, 404, {error: `Unknown tournament "${rawId}".`});
      return;
    }
    if (tournament.status !== 'completed') {
      req.resume();
      sendJson(res, 409, {
        error: 'Tournament replay archives can only be published after status is "completed".',
      });
      return;
    }

    const expectedSha = typeof req.headers['x-content-sha256'] === 'string'
      ? req.headers['x-content-sha256'].trim()
      : undefined;
    if (expectedSha && !/^[0-9a-fA-F]{64}$/.test(expectedSha)) {
      req.resume();
      sendJson(res, 400, {error: 'x-content-sha256 must be a 64-character hex string.'});
      return;
    }

    const fileName = `${tournament.id}-replays.7z`;
    const destPath = path.join(publicDir, 'arena', 'tournaments', tournament.id, fileName);
    try {
      const {bytes, sha256} = await streamBinaryArchive(req, destPath, expectedSha);
      await Promise.resolve(options.onUpdate?.('archive-published'));
      const idEnc = encodeURIComponent(tournament.id);
      sendJson(res, 200, {
        ok: true,
        tournamentId: tournament.id,
        archiveHref: `/arena/tournaments/${idEnc}/${encodeURIComponent(fileName)}`,
        bytes,
        sha256,
      });
    } catch (err) {
      const status = (err as {status?: number}).status ?? 500;
      const message = err instanceof Error ? err.message : 'Tournament archive upload failed.';
      sendJson(res, status, {error: message});
    }
  });

  app.put('/api/arena/ladders/:id/archive', async (req, res) => {
    if (!authenticateArena(req, res)) return;

    const paramId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const rawId = decodeURIComponent(paramId ?? '').trim();
    const ladder = db.getLadder(rawId);
    if (!ladder) {
      req.resume();
      sendJson(res, 404, {error: `Unknown ladder "${rawId}".`});
      return;
    }
    if (ladder.team !== 'pools') {
      req.resume();
      sendJson(res, 400, {
        error: 'Full battle log archives are only published for team-pool (pools) ladders.',
      });
      return;
    }
    if (ladder.status !== 'archived') {
      req.resume();
      sendJson(res, 409, {
        error: 'Full battle log archives can only be published after the ladder is archived.',
      });
      return;
    }

    const expectedSha = typeof req.headers['x-content-sha256'] === 'string'
      ? req.headers['x-content-sha256'].trim()
      : undefined;
    if (expectedSha && !/^[0-9a-fA-F]{64}$/.test(expectedSha)) {
      req.resume();
      sendJson(res, 400, {error: 'x-content-sha256 must be a 64-character hex string.'});
      return;
    }

    const fileName = `${ladder.id}-logs.7z`;
    const destPath = path.join(publicDir, 'arena', 'ladders', ladder.id, fileName);
    try {
      const {bytes, sha256} = await streamBinaryArchive(req, destPath, expectedSha);
      await Promise.resolve(options.onUpdate?.('archive-published'));
      const idEnc = encodeURIComponent(ladder.id);
      sendJson(res, 200, {
        ok: true,
        ladderId: ladder.id,
        archiveHref: `/arena/ladders/${idEnc}/${encodeURIComponent(fileName)}`,
        teamsHref: `/arena/ladders/${idEnc}/teams.json`,
        bytes,
        sha256,
      });
    } catch (err) {
      const status = (err as {status?: number}).status ?? 500;
      const message = err instanceof Error ? err.message : 'Ladder archive upload failed.';
      sendJson(res, status, {error: message});
    }
  });

  const handleBattlesHistory = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const parsedUrl = new URL(req.url ?? '/api/battles.json', 'http://localhost');
    const nowSec = getNowSec();

    const idParam = parsedUrl.searchParams.get('id')?.trim();
    if (idParam) {
      const match = db.getMatch(idParam);
      if (!match) {
        sendJson(res, 404, {error: `Unknown match "${idParam}".`});
        return;
      }
      sendJson(res, 200, {
        updatedAt: nowSec,
        match: enrichMatchView(publicDir, match),
      });
      return;
    }

    const rawSlot = (parsedUrl.searchParams.get('slot') ?? 'all').trim().toLowerCase();
    if (rawSlot !== 'all' && !VALID_SLOTS.has(rawSlot)) {
      sendJson(res, 400, {error: `Unknown slot filter "${rawSlot}".`});
      return;
    }

    const rawPage = parsedUrl.searchParams.get('page');
    const parsedPage = rawPage ? Number(rawPage) : 1;
    if (!Number.isInteger(parsedPage) || parsedPage < 1) {
      sendJson(res, 400, {error: 'page must be a positive integer.'});
      return;
    }

    const rawLimit = parsedUrl.searchParams.get('limit');
    const parsedLimit = rawLimit ? Number(rawLimit) : recentLimit;
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      sendJson(res, 400, {error: 'limit must be an integer between 1 and 100.'});
      return;
    }

    const ladderId = parsedUrl.searchParams.get('ladder')?.trim() || undefined;
    const agentSlug = parsedUrl.searchParams.get('agent')?.trim() || undefined;
    const offset = (parsedPage - 1) * parsedLimit;
    const countsBySlot = db.getMatchCountsBySlot();
    const {matches, total} = db.getMatchesPage({
      slot: rawSlot,
      ladderId,
      agentSlug,
      limit: parsedLimit,
      offset,
    });
    const totalPages = Math.max(1, Math.ceil(total / parsedLimit));

    sendJson(res, 200, {
      updatedAt: nowSec,
      page: parsedPage,
      pageSize: parsedLimit,
      total,
      totalPages,
      hasPrev: parsedPage > 1,
      hasNext: parsedPage < totalPages,
      slot: rawSlot,
      ladderId,
      agentSlug,
      countsBySlot,
      matches: matches.map(m => enrichMatchView(publicDir, m)),
    });
  };

  app.get('/api/battles.json', handleBattlesHistory);
  app.get('/api/battles', handleBattlesHistory);

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
