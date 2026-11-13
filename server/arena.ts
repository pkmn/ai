import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

import polka from 'polka';

import type * as db from '../db';
import {
  VERSION_RE,
  escapeHtml,
  installHeadSupport,
  root,
  validateAgentName,
  writeFileAtomic,
} from '../static/util';

import {decryptSecret} from './account';
import {Auth} from './auth';
import * as ratings from './ratings';
import {validateHarvestedTeams} from './teams';

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

function decodeRouteParam(param: string | string[] | undefined): string {
  const raw = Array.isArray(param) ? param[0] : param;
  if (!raw) return '';
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    return raw.trim();
  }
}

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
  runningTournament?: {id: string; name: string; href: string};
  pageSize?: number;
  totalMatches?: number;
  countsBySlot?: Record<string, number>;
  historyEndpoint?: string;
  recentMatches: BattleHistoryEntry[];
}

export interface BroadcastClock {
  name: string;
  bankSeconds: number;
  thinking: boolean;
  incrementSeconds: number;
}

export interface BroadcastPlayer extends BroadcastClock {
  slug?: string;
  version?: string;
  team?: string;
}

export interface BroadcastTable {
  table: number;
  label: string;
  idle?: boolean;
  gameId?: string;
  stage?: db.TournamentGameStage;
  cycle?: number;
  matchupGame?: number;
  seriesLeftHtml?: string;
  seriesRightHtml?: string;
  p1?: BroadcastPlayer;
  p2?: BroadcastPlayer;
  lines?: string[];
  live?: boolean;
  updatedAt?: number;
}

// Unlike the 24/7 continuous ladders (which enforce a zero-log anti-scouting policy), scheduled
// Championship Tournaments use locked submitted binaries and open team sheets, so full Showdown
// battle logs and live multi-table spectator broadcasts are streamed in real time.
export interface LiveBroadcast {
  tournamentId: string;
  updatedAt?: number;
  tables: BroadcastTable[];
  seriesLeftHtml: string;
  seriesRightHtml: string;
  p1: BroadcastClock;
  p2: BroadcastClock;
  lines: string[];
  live?: boolean;
}

export interface TournamentStandingEntry {
  rank: number;
  versionId: number;
  slug: string;
  name: string;
  version: string;
  elo: number;
  ci95: number;
  wins: number;
  losses: number;
  ties: number;
  points: number;
  sonnebornBerger: number;
}

export interface TournamentCrosstableEntry {
  stage: db.TournamentGameStage;
  lowVersionId: number;
  highVersionId: number;
  lowSlug?: string;
  lowName?: string;
  lowVersion?: string;
  highSlug?: string;
  highName?: string;
  highVersion?: string;
  lowWins: number;
  highWins: number;
  ties: number;
}

export interface TournamentGameEntry {
  id: string;
  stage: db.TournamentGameStage;
  cycle: number;
  matchupGame: number;
  seed: string;
  outcome?: ratings.GameOutcome;
  endReason?: string;
  turns?: number;
  completedAt?: number;
  logHref?: string;
  p1: {
    versionId: number;
    slug: string;
    name: string;
    version: string;
    team?: string;
    bankSeconds?: number;
  };
  p2: {
    versionId: number;
    slug: string;
    name: string;
    version: string;
    team?: string;
    bankSeconds?: number;
  };
}

export interface TournamentDocument {
  id: string;
  name: string;
  format: string;
  rules: string[];
  status: db.TournamentStatus;
  gamesPerMatchup: number;
  batchSize: number;
  parallelTables: number;
  hardware: string;
  startsAt: number;
  closesAt: number;
  completedAt?: number;
  completedGames: number;
  archiveHref?: string;
  standings: TournamentStandingEntry[];
  crosstable: TournamentCrosstableEntry[];
  games: TournamentGameEntry[];
}

// Full battle logs (containing unpacked team sheets, real agent identities, and telemetry) are
// published exclusively for competitor team-pool (`pools`) ladders strictly AFTER the ladder has
// been retired (`status === 'archived'`).
export function resolveLadderArchive(
  publicDir: string,
  ladder: Pick<db.LadderRow, 'id' | 'team' | 'status'>
): {name: string; href: string} | undefined {
  if (ladder.team !== 'pools' || ladder.status !== 'archived') return undefined;
  const idEnc = encodeURIComponent(ladder.id);
  const defaultName = `${ladder.id}-logs.7z`;
  const candidates = [
    {
      diskPath: path.join(publicDir, 'arena', 'ladders', ladder.id, defaultName),
      name: defaultName,
      href: `/arena/ladders/${idEnc}/${encodeURIComponent(defaultName)}`,
    },
    {
      diskPath: path.join(publicDir, 'arena', 'ladders', ladder.id, 'logs.7z'),
      name: 'logs.7z',
      href: `/arena/ladders/${idEnc}/logs.7z`,
    },
  ];
  for (const c of candidates) {
    if (fs.existsSync(c.diskPath)) return {name: c.name, href: c.href};
  }
  return undefined;
}

export function resolveTournamentArchive(
  publicDir: string,
  tournamentId: string
): {name: string; href: string} | undefined {
  const idEnc = encodeURIComponent(tournamentId);
  const defaultName = `${tournamentId}-replays.7z`;
  const candidates = [
    {
      diskPath: path.join(publicDir, 'arena', 'tournaments', tournamentId, defaultName),
      name: defaultName,
      href: `/arena/tournaments/${idEnc}/${encodeURIComponent(defaultName)}`,
    },
    {
      diskPath: path.join(publicDir, 'arena', 'tournaments', tournamentId, 'replays.7z'),
      name: 'replays.7z',
      href: `/arena/tournaments/${idEnc}/replays.7z`,
    },
    {
      diskPath: path.join(publicDir, 'arena', 'tournaments', defaultName),
      name: defaultName,
      href: `/arena/tournaments/${encodeURIComponent(defaultName)}`,
    },
  ];
  for (const c of candidates) {
    if (fs.existsSync(c.diskPath)) return {name: c.name, href: c.href};
  }
  return undefined;
}

export function listTournamentLogFiles(publicDir: string, tournamentId: string): Set<string> {
  const dir = path.join(publicDir, 'arena', 'tournaments', tournamentId);
  if (!fs.existsSync(dir)) return new Set();
  try {
    return new Set(fs.readdirSync(dir).filter(f => f.endsWith('.log')));
  } catch {
    return new Set();
  }
}

export function enrichTournamentGame(
  publicDir: string,
  tournamentId: string,
  g: db.TournamentGameView,
  logFiles?: ReadonlySet<string>
): TournamentGameEntry {
  const logRel = `${g.id}.log`;
  const hasLog = logFiles
    ? logFiles.has(logRel)
    : fs.existsSync(path.join(publicDir, 'arena', 'tournaments', tournamentId, logRel));
  const logHref = hasLog
    ? `/arena/tournaments/${encodeURIComponent(tournamentId)}/${encodeURIComponent(logRel)}`
    : undefined;
  return {
    id: g.id,
    stage: g.stage,
    cycle: g.cycle,
    matchupGame: g.matchupGame,
    seed: g.seed,
    outcome: g.outcome,
    endReason: g.endReason,
    turns: g.turns,
    completedAt: g.completedAt,
    logHref,
    p1: {
      versionId: g.p1VersionId,
      slug: g.p1Slug,
      name: g.p1Name,
      version: g.p1Version,
      team: g.p1Team,
      bankSeconds: g.p1BankSeconds,
    },
    p2: {
      versionId: g.p2VersionId,
      slug: g.p2Slug,
      name: g.p2Name,
      version: g.p2Version,
      team: g.p2Team,
      bankSeconds: g.p2BankSeconds,
    },
  };
}

export interface PreloadedTournamentData {
  entrants?: db.TournamentEntrantView[];
  rrPairs?: db.TournamentPairRecord[];
  sfPairs?: db.TournamentPairRecord[];
  logFiles?: ReadonlySet<string>;
}

export function buildTournamentDocument(
  db: db.Database,
  publicDir: string,
  tournament: db.TournamentRow,
  gamesLimit = 10_000,
  preloaded?: PreloadedTournamentData
): TournamentDocument {
  const entrants = preloaded?.entrants ?? db.getTournamentEntrants(tournament.id);
  const games = db.getTournamentGames(tournament.id, gamesLimit);
  const rrPairs = preloaded?.rrPairs ?? db.getTournamentCrosstable(tournament.id, 'Round Robin');
  const sfPairs = preloaded?.sfPairs ?? db.getTournamentCrosstable(tournament.id, 'Superfinal');
  const logFiles = preloaded?.logFiles ?? listTournamentLogFiles(publicDir, tournament.id);

  let completedGames = 0;
  for (const p of rrPairs) completedGames += p.lowWins + p.highWins + p.ties;
  for (const p of sfPairs) completedGames += p.lowWins + p.highWins + p.ties;

  const archive = resolveTournamentArchive(publicDir, tournament.id);
  const entrantByVer = new Map(entrants.map(e => [e.versionId, e]));
  let rules: string[] = [];
  try {
    const rawRules = JSON.parse(tournament.rulesJson || '[]') as unknown;
    if (Array.isArray(rawRules)) rules = rawRules.map(String);
  } catch {}

  const mapPair = (
    stage: db.TournamentGameStage,
    p: db.TournamentPairRecord
  ): TournamentCrosstableEntry => {
    const low = entrantByVer.get(p.lowVersionId);
    const high = entrantByVer.get(p.highVersionId);
    return {
      stage,
      lowVersionId: p.lowVersionId,
      highVersionId: p.highVersionId,
      lowSlug: low?.agentSlug,
      lowName: low?.agentName,
      lowVersion: low?.version,
      highSlug: high?.agentSlug,
      highName: high?.agentName,
      highVersion: high?.version,
      lowWins: p.lowWins,
      highWins: p.highWins,
      ties: p.ties,
    };
  };

  return {
    id: tournament.id,
    name: tournament.name,
    format: tournament.format,
    rules,
    status: tournament.status,
    gamesPerMatchup: tournament.gamesPerMatchup,
    batchSize: tournament.batchSize,
    parallelTables: tournament.parallelTables,
    hardware: tournament.hardware,
    startsAt: tournament.startsAt,
    closesAt: db.getTournamentClosesAt(tournament.startsAt),
    completedAt: tournament.completedAt,
    completedGames,
    archiveHref: archive?.href,
    standings: entrants.map((e, idx) => ({
      rank: e.finalRank ?? idx + 1,
      versionId: e.versionId,
      slug: e.agentSlug,
      name: e.agentName,
      version: e.version,
      elo: Math.round(e.elo),
      ci95: Math.round(1.96 * e.se),
      wins: e.gameWins,
      losses: e.gameLosses,
      ties: e.gameTies,
      points: e.points,
      sonnebornBerger: e.sonnebornBerger,
    })),
    crosstable: [
      ...rrPairs.map(p => mapPair('Round Robin', p)),
      ...sfPairs.map(p => mapPair('Superfinal', p)),
    ],
    games: games.map(g => enrichTournamentGame(publicDir, tournament.id, g, logFiles)),
  };
}

export function normalizeLiveBroadcast(
  raw: LiveBroadcast,
  nowSec = Math.floor(Date.now() / 1000)
): LiveBroadcast {
  const updatedAt = raw.updatedAt ?? nowSec;
  const tables: BroadcastTable[] = raw.tables.map((tb, idx) => {
    const tableNum = tb.table ?? idx + 1;
    const isPrimaryFallback = idx === 0 && !tb.p1 && !tb.lines;
    return {
      table: tableNum,
      label: tb.label || `Table ${tableNum}`,
      idle: Boolean(tb.idle),
      gameId: tb.gameId,
      stage: tb.stage,
      cycle: tb.cycle,
      matchupGame: tb.matchupGame,
      seriesLeftHtml: tb.seriesLeftHtml ?? (isPrimaryFallback ? raw.seriesLeftHtml : undefined),
      seriesRightHtml: tb.seriesRightHtml ?? (isPrimaryFallback ? raw.seriesRightHtml : undefined),
      p1: tb.p1 ?? (isPrimaryFallback ? {...raw.p1} : undefined),
      p2: tb.p2 ?? (isPrimaryFallback ? {...raw.p2} : undefined),
      lines: tb.lines ? tb.lines.slice() : (isPrimaryFallback ? raw.lines.slice() : []),
      live: tb.idle ? false : (tb.live ?? (isPrimaryFallback ? raw.live !== false : true)),
      updatedAt: tb.updatedAt ?? updatedAt,
    };
  });
  const primary = tables.find(tb => !tb.idle && tb.p1 && tb.p2) ??
    tables.find(tb => tb.p1 && tb.p2) ??
    undefined;
  return {
    tournamentId: raw.tournamentId,
    updatedAt,
    tables,
    seriesLeftHtml: primary?.seriesLeftHtml ?? raw.seriesLeftHtml,
    seriesRightHtml: primary?.seriesRightHtml ?? raw.seriesRightHtml,
    p1: primary?.p1 ?? raw.p1,
    p2: primary?.p2 ?? raw.p2,
    lines: primary?.lines ?? raw.lines,
    live: primary ? primary.live !== false : raw.live,
  };
}

export function enrichMatchView(publicDir: string, m: db.RecentMatchView): BattleHistoryEntry {
  const ladderHref = m.ladderStatus === 'archived'
    ? `/arena/ladders/${encodeURIComponent(m.ladderId)}/`
    : `/arena/ladders/${encodeURIComponent(m.slot)}/`;
  if (m.teamMode !== 'pools' || m.ladderStatus !== 'archived') {
    return {...m, ladderHref};
  }
  const idEnc = encodeURIComponent(m.ladderId);
  const archiveHref = resolveLadderArchive(publicDir, {
    id: m.ladderId,
    team: m.teamMode,
    status: m.ladderStatus,
  })?.href;
  const teamsHref = `/arena/ladders/${idEnc}/teams.json`;
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
    reason:
      'submission-status' |
      'match-complete' |
      'archive-published' |
      'ladder-teams' |
      'tournament-game-complete' |
      'tournament-status'
  ) => void | Promise<void>;
}

export interface Handle {
  close: () => void;
  getLiveDocument: (nowSeconds?: number) => LiveDocument;
  writeLiveJson: (nowSeconds?: number) => LiveDocument;
  setLiveState: (state: {live?: LiveMatch; stale?: boolean; updatedAt?: number}) => void;
  getTournamentBroadcast: (tournamentId?: string) => LiveBroadcast | undefined;
  setTournamentBroadcast: (broadcast?: LiveBroadcast, tournamentId?: string) => void;
  notifyTournamentStatus: (tournamentId: string) => void;
  getState: () => {
    lastSeenAt?: number;
    watchdogTriggered: boolean;
    live?: LiveMatch;
    liveSeq: number;
    archiveSeq: number;
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

export interface PendingTournament {
  id: string;
  name: string;
  format: string;
  rulesJson: string;
  status: db.TournamentStatus;
  startsAt: number;
}

export interface PendingSubmissionsResponse {
  ladders: PendingLadder[];
  tournaments?: PendingTournament[];
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

export interface LadderTeamsUploadResponse {
  ok: true;
  ladderId: string;
  format: string;
  count: number;
  sha256: string;
}

export interface LadderTeamsResponse {
  ladderId: string;
  format: string;
  count: number;
  sha256: string;
  teams: string[];
}

export interface TournamentArchiveResponse {
  ok: true;
  tournamentId: string;
  archiveHref: string;
  bytes: number;
  sha256: string;
}

export type TournamentBroadcastPayload =
  {off: true} |
  {table: number; idle: true; label?: string} |
  {
    table: number;
    mode?: 'load' | 'append';
    label?: string;
    gameId?: string;
    stage?: db.TournamentGameStage;
    cycle?: number;
    matchupGame?: number;
    seriesLeftHtml?: string;
    seriesRightHtml?: string;
    p1?: BroadcastPlayer;
    p2?: BroadcastPlayer;
    lines?: string[];
    live?: boolean;
  } |
  LiveBroadcast;

export interface TournamentGameCompletePayload {
  game: Omit<db.CompletedTournamentGamePayload, 'tournamentId'>;
  table?: number;
  log?: string;
  tournamentStatus?: db.TournamentStatus;
}

export interface TournamentGameCompleteResponse {
  ok: true;
  duplicate: boolean;
  gameId: string;
  logHref?: string;
}

export interface TournamentStateResponse {
  tournament: {
    id: string;
    name: string;
    format: string;
    customRules: string[];
    gamesPerMatchup: number;
    batchSize: number;
    parallelTables: number;
    hardware: string;
    status: db.TournamentStatus;
    startsAt: number;
    completedAt?: number;
  };
  entrants: Array<{
    versionId: number;
    agentId: number;
    agentSlug: string;
    agentName: string;
    version: string;
    seed?: number;
    finalRank?: number;
    points: number;
    sonnebornBerger: number;
    url: string;
    sha256: string;
  }>;
  games: Array<{
    id: string;
    stage: db.TournamentGameStage;
    cycle: number;
    matchupGame: number;
    p1VersionId: number;
    p2VersionId: number;
    outcome?: 'W' | 'L' | 'T';
    turns?: number;
    endReason?: string;
  }>;
  teamPool: string[];
}

export interface ClientOptions {
  serverUrl: string;
  arenaSecret: string;
  fetch?: typeof globalThis.fetch;
}

export function buildLadderMatchState(
  ladder: Pick<db.LadderRow, 'id' | 'status' | 'min'>,
  entries: ReadonlyArray<{
    versionId: number;
    agentId: number;
    role: string;
    elo: number;
    se: number;
    matches: number;
    settledAt?: number;
  }>,
  pairs: ReadonlyArray<{
    lowVersionId: number;
    highVersionId: number;
    ww: number;
    wt: number;
    split: number;
    tl: number;
    ll: number;
  }>,
  lastMatchNumber = 0,
  rosterAgentIds?: ReadonlySet<number>,
  residencyMultipliers?: Float64Array
): ratings.LadderMatchState | undefined {
  if (ladder.status !== 'active' && ladder.status !== 'settling') return undefined;
  const isPlayableEntry = (e: (typeof entries)[number]) =>
    e.role !== 'retired' && e.role !== 'quarantined' &&
    (!rosterAgentIds || rosterAgentIds.has(e.agentId));
  const activeEntries = entries.filter(isPlayableEntry);
  const distinctAgents = new Set(activeEntries.map(e => e.agentId));
  const minActiveAgents = ladder.status === 'settling' ? 2 : Math.max(2, ladder.min);
  if (distinctAgents.size < minActiveAgents) return undefined;
  if (rosterAgentIds && rosterAgentIds.size < Math.max(2, ladder.min)) return undefined;
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
    minAgents: minActiveAgents,
    theta,
    sigma,
    agentMatches,
    pairMatches,
    lastMatchNumber,
    residencyMultipliers,
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
    method: 'GET' | 'POST' | 'PUT',
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
      throw Object.assign(
        new Error(`${method} ${endpoint} failed (${res.status}): ${errMsg}`),
        {status: res.status}
      );
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
      throw Object.assign(
        new Error(`PUT ${endpoint} failed (${res.status}): ${errMsg}`),
        {status: res.status}
      );
    }
    return parsed as T;
  }

  getPendingSubmissions(opts?: {
    target?: 'ladder' | 'tournament';
    tournamentId?: string;
  }): Promise<PendingSubmissionsResponse> {
    const params = new URLSearchParams();
    if (opts?.target) params.set('target', opts.target);
    if (opts?.tournamentId) params.set('tournament', opts.tournamentId);
    const qs = params.toString();
    return this.requestJson<PendingSubmissionsResponse>(
      'GET',
      `/api/arena/pending-submissions${qs ? `?${qs}` : ''}`
    );
  }

  getPlayableLadders(): Promise<{
    ladders: Array<{
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
      roster?: Array<{
        agentId: number;
        agentName: string;
        teams: string[];
      }>;
    }>;
  }> {
    return this.requestJson('GET', '/api/arena/ladders');
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

  uploadLadderTeams(
    ladderId: string,
    teams: string | string[]
  ): Promise<LadderTeamsUploadResponse> {
    return this.requestJson<LadderTeamsUploadResponse>(
      'PUT',
      `/api/arena/ladders/${encodeURIComponent(ladderId)}/teams`,
      {teams}
    );
  }

  getLadderTeams(ladderId: string): Promise<LadderTeamsResponse> {
    return this.requestJson<LadderTeamsResponse>(
      'GET',
      `/api/arena/ladders/${encodeURIComponent(ladderId)}/teams`
    );
  }

  getTournamentState(tournamentId: string): Promise<TournamentStateResponse> {
    return this.requestJson<TournamentStateResponse>(
      'GET',
      `/api/arena/tournaments/${encodeURIComponent(tournamentId)}/state`
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

  sendTournamentBroadcast(
    tournamentId: string,
    payload: TournamentBroadcastPayload
  ): Promise<{ok: true; updatedAt: number}> {
    return this.requestJson<{ok: true; updatedAt: number}>(
      'POST',
      `/api/arena/tournaments/${encodeURIComponent(tournamentId)}/broadcast`,
      payload
    );
  }

  completeTournamentGame(
    tournamentId: string,
    payload: TournamentGameCompletePayload
  ): Promise<TournamentGameCompleteResponse> {
    return this.requestJson<TournamentGameCompleteResponse>(
      'POST',
      `/api/arena/tournaments/${encodeURIComponent(tournamentId)}/game-complete`,
      payload
    );
  }
}

function sendJson(res: http.ServerResponse, status: number, data: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

function sendCachedJson(req: http.IncomingMessage, res: http.ServerResponse, data: unknown) {
  const payload = JSON.stringify(data);
  const etag = `"${crypto.createHash('sha1').update(payload).digest('hex')}"`;
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('ETag', etag);
  if (req.headers['if-none-match'] === etag) {
    res.statusCode = 304;
    res.end();
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(payload);
}

function openSse(res: http.ServerResponse) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
}

function sendSse(res: http.ServerResponse, event: string, data: unknown) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const MAX_TEAMS_BODY_BYTES = 8 * 1024 * 1024;

function readTeamsBody(
  req: http.IncomingMessage,
  maxBytes = MAX_TEAMS_BODY_BYTES
): Promise<string | string[]> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        reject(Object.assign(new Error('Teams body exceeds 8 MiB limit.'), {status: 413}));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
      if (contentType.includes('application/json')) {
        try {
          const parsed = raw ? (JSON.parse(raw) as unknown) : {};
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            reject(Object.assign(new Error('Request body must be a JSON object.'), {status: 400}));
            return;
          }
          const rawTeams = (parsed as Record<string, unknown>).teams;
          if (typeof rawTeams === 'string') {
            resolve(rawTeams);
            return;
          }
          if (Array.isArray(rawTeams)) {
            resolve(rawTeams.map(String));
            return;
          }
          reject(Object.assign(
            new Error('JSON body must include a string or array "teams" field.'),
            {status: 400}
          ));
          return;
        } catch {
          reject(Object.assign(new Error('Invalid JSON request body.'), {status: 400}));
          return;
        }
      }
      resolve(raw);
    });
    req.on('error', err => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
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

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VALID_TOURNAMENT_STAGES = new Set<db.TournamentGameStage>(['Round Robin', 'Superfinal']);
const VALID_TOURNAMENT_STATUSES = new Set<db.TournamentStatus>([
  'scheduled',
  'running',
  'completed',
]);
const SSE_KEEPALIVE_MILLIS = 25_000;
const MAX_TABLE_LINES = 10_000;
const MAX_TOURNAMENT_LOG_BYTES = 512 * 1024;

function parseBroadcastPlayer(raw: unknown, label: string): BroadcastPlayer {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw Object.assign(new Error(`Invalid ${label} clock object.`), {status: 400});
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== 'string' || !obj.name.trim()) {
    throw Object.assign(new Error(`Invalid ${label}.name.`), {status: 400});
  }
  if (!isFiniteNonNeg(obj.bankSeconds)) {
    throw Object.assign(new Error(`Invalid ${label}.bankSeconds.`), {status: 400});
  }
  if (typeof obj.thinking !== 'boolean') {
    throw Object.assign(new Error(`Invalid ${label}.thinking.`), {status: 400});
  }
  if (!isFiniteNonNeg(obj.incrementSeconds)) {
    throw Object.assign(new Error(`Invalid ${label}.incrementSeconds.`), {status: 400});
  }
  return {
    name: obj.name.trim(),
    bankSeconds: obj.bankSeconds,
    thinking: obj.thinking,
    incrementSeconds: obj.incrementSeconds,
    slug: typeof obj.slug === 'string' && obj.slug.trim() ? obj.slug.trim() : undefined,
    version: typeof obj.version === 'string' && obj.version.trim() ? obj.version.trim() : undefined,
    team: typeof obj.team === 'string' && obj.team.trim() ? obj.team.trim() : undefined,
  };
}

function buildDefaultTableHeaders(tb: BroadcastTable): {left: string; right: string} {
  const left = tb.p1 && tb.p2
    ? `<span class="font-semibold">${escapeHtml(tb.p1.name)}</span>` +
      (tb.p1.version ? ` <span class="ver">v${escapeHtml(tb.p1.version)}</span>` : '') +
      ` vs <span class="font-semibold">${escapeHtml(tb.p2.name)}</span>` +
      (tb.p2.version ? ` <span class="ver">v${escapeHtml(tb.p2.version)}</span>` : '')
    : escapeHtml(tb.label);
  const parts: string[] = [tb.stage ?? 'Round Robin'];
  if (tb.cycle !== undefined) parts.push(`Cycle ${tb.cycle}`);
  if (tb.matchupGame !== undefined) parts.push(`Game ${tb.matchupGame}`);
  parts.push(tb.label);
  return {left, right: escapeHtml(parts.join(' · '))};
}

function parseCompletedTournamentGame(
  raw: unknown,
  tournamentId: string
): db.CompletedTournamentGamePayload {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw Object.assign(new Error('Missing or invalid "game" object.'), {status: 400});
  }
  const g = raw as Record<string, unknown>;
  if (typeof g.id !== 'string' || !SAFE_ID_RE.test(g.id.trim())) {
    throw Object.assign(new Error('Invalid game.id.'), {status: 400});
  }
  if (
    typeof g.stage !== 'string' ||
    !VALID_TOURNAMENT_STAGES.has(g.stage as db.TournamentGameStage)
  ) {
    throw Object.assign(new Error('Invalid game.stage.'), {status: 400});
  }
  if (!isPosInt(g.cycle) || !isPosInt(g.matchupGame)) {
    throw Object.assign(
      new Error('game.cycle and game.matchupGame must be positive integers.'),
      {status: 400}
    );
  }
  if (!isPosInt(g.p1VersionId) || !isPosInt(g.p2VersionId) || g.p1VersionId === g.p2VersionId) {
    throw Object.assign(
      new Error('game.p1VersionId and game.p2VersionId must be distinct positive integers.'),
      {status: 400}
    );
  }
  if (typeof g.seed !== 'string' || !g.seed.trim()) {
    throw Object.assign(new Error('Invalid game.seed.'), {status: 400});
  }
  if (
    typeof g.outcome !== 'string' ||
    !VALID_GAME_OUTCOMES.has(g.outcome as ratings.GameOutcome)
  ) {
    throw Object.assign(new Error('Invalid game.outcome.'), {status: 400});
  }
  if (typeof g.endReason !== 'string' || !g.endReason.trim()) {
    throw Object.assign(new Error('Invalid game.endReason.'), {status: 400});
  }
  if (!isNonNegInt(g.turns)) {
    throw Object.assign(new Error('Invalid game.turns.'), {status: 400});
  }
  if (!isFiniteNonNeg(g.p1BankSeconds)) {
    throw Object.assign(new Error('Invalid game.p1BankSeconds.'), {status: 400});
  }
  if (!isFiniteNonNeg(g.p2BankSeconds)) {
    throw Object.assign(new Error('Invalid game.p2BankSeconds.'), {status: 400});
  }
  if (!isPosInt(g.completedAt)) {
    throw Object.assign(new Error('Invalid game.completedAt.'), {status: 400});
  }

  return {
    id: g.id.trim(),
    tournamentId,
    stage: g.stage as db.TournamentGameStage,
    cycle: g.cycle,
    matchupGame: g.matchupGame,
    p1VersionId: g.p1VersionId,
    p2VersionId: g.p2VersionId,
    p1Team: typeof g.p1Team === 'string' && g.p1Team.trim() ? g.p1Team.trim() : undefined,
    p2Team: typeof g.p2Team === 'string' && g.p2Team.trim() ? g.p2Team.trim() : undefined,
    seed: g.seed.trim(),
    outcome: g.outcome as ratings.GameOutcome,
    endReason: g.endReason.trim(),
    turns: g.turns,
    p1BankSeconds: g.p1BankSeconds,
    p2BankSeconds: g.p2BankSeconds,
    completedAt: g.completedAt,
  };
}

// Registers the outbound-only Arena worker control-plane endpoints (/api/arena/*) and live
// spectator SSE / JSON feeds (/api/live.json, /api/battles/stream, /api/tournaments/:id/stream).
// The Mac Mini Arena host initiates all connections to the Linode web server authenticated by
// Bearer $ARENA_SECRET, so the public VPS holds zero inbound credentials to the execution host.
export function register(app: polka.Polka, options: Options): Handle {
  installHeadSupport(app);
  const {db} = options;
  const publicDir = options.publicDir ?? PUBLIC_DIR;
  const watchdogMillis = options.watchdogTimeoutMillis ?? WATCHDOG_TIMEOUT_MILLIS;
  const recentLimit = options.recentMatchesLimit ?? RECENT_MATCHES_LIMIT;
  const getNowSec = options.now ?? (() => Math.floor(Date.now() / 1000));

  let currentLive: LiveMatch | undefined;
  let liveUpdatedAt: number | undefined;
  let liveStale = false;
  let lastSeenAt: number | undefined;
  let lastMatchId: string | undefined;
  let watchdogTriggered = false;
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  let liveSeq = 0;
  let archiveSeq = 0;

  const broadcastsByTournament = new Map<string, LiveBroadcast>();
  const battleStreamClients = new Set<http.ServerResponse>();
  const tournamentStreamClients = new Map<string, Set<http.ServerResponse>>();

  const keepaliveTimer = setInterval(() => {
    for (const client of battleStreamClients) {
      if (!client.writableEnded && !client.destroyed) client.write(': keepalive\n\n');
    }
    for (const clients of tournamentStreamClients.values()) {
      for (const client of clients) {
        if (!client.writableEnded && !client.destroyed) client.write(': keepalive\n\n');
      }
    }
  }, SSE_KEEPALIVE_MILLIS);
  keepaliveTimer.unref();

  const pushBattleEvent = (event: string, data: unknown) => {
    for (const client of battleStreamClients) {
      sendSse(client, event, data);
    }
  };

  const pushTournamentEvent = (tournamentId: string, event: string, data: unknown) => {
    const clients = tournamentStreamClients.get(tournamentId);
    if (!clients) return;
    for (const client of clients) {
      sendSse(client, event, data);
    }
  };

  const getRunningTournamentInfo = () => {
    const running = db.getRunningTournament();
    if (!running) return undefined;
    return {
      id: running.id,
      name: running.name,
      href: `/arena/tournaments/${encodeURIComponent(running.id)}/`,
    };
  };

  const getArenaSecret = (): string | undefined =>
    options.arenaSecret ?? options.auth?.getConfig()?.arenaSecret ?? process.env.ARENA_SECRET;

  const getSessionSecret = (): string | undefined =>
    options.sessionSecret ?? options.auth?.getConfig()?.sessionSecret ?? process.env.SESSION_SECRET;

  const getLiveDocument = (nowSec = getNowSec()): LiveDocument => {
    const countsBySlot = db.getMatchCountsBySlot();
    const recentMatches = db.getRecentMatches(recentLimit).map(m => enrichMatchView(publicDir, m));
    return {
      updatedAt: liveUpdatedAt ?? nowSec,
      stale: liveStale,
      live: liveStale ? undefined : currentLive,
      runningTournament: getRunningTournamentInfo(),
      pageSize: recentLimit,
      totalMatches: countsBySlot.all ?? recentMatches.length,
      countsBySlot,
      historyEndpoint: '/api/battles.json',
      recentMatches,
    };
  };

  const clearWatchdog = () => {
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = undefined;
    }
  };

  const closeAll = () => {
    clearWatchdog();
    clearInterval(keepaliveTimer);
    for (const client of battleStreamClients) {
      if (!client.writableEnded && !client.destroyed) client.end();
    }
    battleStreamClients.clear();
    for (const clients of tournamentStreamClients.values()) {
      for (const client of clients) {
        if (!client.writableEnded && !client.destroyed) client.end();
      }
    }
    tournamentStreamClients.clear();
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
      liveStale = true;
      liveUpdatedAt = getNowSec();
      liveSeq++;
      pushBattleEvent('live', {
        updatedAt: liveUpdatedAt,
        stale: true,
        runningTournament: getRunningTournamentInfo(),
      });
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
      const targetFilter = typeof req.query.target === 'string' ? req.query.target : '';
      const tourneyFilter = typeof req.query.tournament === 'string'
        ? req.query.tournament.trim()
        : '';

      const ladders = db.getLadders().filter(l => l.status !== 'archived').map(l => ({
        id: l.id,
        slot: l.slot,
        name: l.name,
        format: l.format,
        team: l.team,
        min: l.min,
        teams: l.teams,
        status: l.status,
      }));
      const tournaments = db.getTournaments()
        .filter(t => t.status !== 'completed')
        .map(t => ({
          id: t.id,
          name: t.name,
          format: t.format,
          rulesJson: t.rulesJson,
          status: t.status,
          startsAt: t.startsAt,
        }));
      const sessionSecret = getSessionSecret();
      const rawPending = db.getPendingSubmissions().filter(sub => {
        if (targetFilter === 'ladder') return sub.ladders.length > 0;
        if (targetFilter === 'tournament') return sub.tournaments.length > 0;
        return true;
      }).filter(sub => !tourneyFilter || sub.tournaments.includes(tourneyFilter));

      const submissions = rawPending.map(sub => {
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
      sendJson(res, 200, {ladders, tournaments, submissions});
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
        liveStale = false;
        liveUpdatedAt = nowSec;
        liveSeq++;
        armWatchdog(nowSec);
        pushBattleEvent('live', {
          updatedAt: nowSec,
          stale: false,
          runningTournament: getRunningTournamentInfo(),
        });
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
      liveStale = false;
      liveUpdatedAt = nowSec;
      liveSeq++;

      armWatchdog(nowSec);
      pushBattleEvent('live', {
        updatedAt: nowSec,
        stale: false,
        live: currentLive,
        runningTournament: getRunningTournamentInfo(),
      });
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
      const clearedLive = currentLive?.matchId === match.id;
      if (clearedLive) {
        currentLive = undefined;
      }
      liveStale = false;
      liveUpdatedAt = nowSec;
      liveSeq++;
      armWatchdog(nowSec);

      if (!duplicate) {
        const saved = db.getMatch(match.id);
        const countsBySlot = db.getMatchCountsBySlot();
        pushBattleEvent('match', {
          updatedAt: nowSec,
          stale: false,
          live: currentLive,
          runningTournament: getRunningTournamentInfo(),
          match: saved ? enrichMatchView(publicDir, saved) : undefined,
          totalMatches: countsBySlot.all ?? 0,
          countsBySlot,
        });
        Promise.resolve(options.onMatchComplete?.({match, duplicate, archivedLadder})).catch(
          err => {
            console.error('Error in onMatchComplete callback:', err);
          }
        );
        Promise.resolve(options.onUpdate?.('match-complete')).catch(err => {
          console.error('Error in onUpdate callback:', err);
        });
      } else if (clearedLive) {
        pushBattleEvent('live', {
          updatedAt: nowSec,
          stale: false,
          live: currentLive,
          runningTournament: getRunningTournamentInfo(),
        });
      }

      sendJson(res, 200, {ok: true, duplicate, archivedLadder});
    } catch (err) {
      const status = (err as {status?: number}).status ?? 500;
      const message = err instanceof Error ? err.message : 'Match completion failed.';
      sendJson(res, status, {error: message});
    }
  });

  app.post('/api/arena/tournaments/:id/broadcast', async (req, res) => {
    if (!authenticateArena(req, res)) return;

    const rawId = decodeRouteParam(req.params.id);
    const tournament = db.getTournament(rawId);
    if (!tournament) {
      sendJson(res, 404, {error: `Unknown tournament "${rawId}".`});
      return;
    }

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
      if (body.off === true) {
        broadcastsByTournament.delete(tournament.id);
        liveSeq++;
        pushTournamentEvent(tournament.id, 'broadcast-end', {
          tournamentId: tournament.id,
          updatedAt: nowSec,
        });
        sendJson(res, 200, {ok: true, updatedAt: nowSec});
        return;
      }

      if (Array.isArray(body.tables)) {
        const rawBroadcast: LiveBroadcast = {
          tournamentId: tournament.id,
          updatedAt: nowSec,
          tables: body.tables as BroadcastTable[],
          seriesLeftHtml: typeof body.seriesLeftHtml === 'string' ? body.seriesLeftHtml : '',
          seriesRightHtml: typeof body.seriesRightHtml === 'string' ? body.seriesRightHtml : '',
          p1: body.p1
            ? parseBroadcastPlayer(body.p1, 'p1')
            : {name: '—', bankSeconds: 0, thinking: false, incrementSeconds: 10},
          p2: body.p2
            ? parseBroadcastPlayer(body.p2, 'p2')
            : {name: '—', bankSeconds: 0, thinking: false, incrementSeconds: 10},
          lines: Array.isArray(body.lines) ? body.lines.map(String) : [],
          live: typeof body.live === 'boolean' ? body.live : true,
        };
        const normalized = normalizeLiveBroadcast(rawBroadcast, nowSec);
        broadcastsByTournament.set(tournament.id, normalized);
        liveSeq++;
        pushTournamentEvent(tournament.id, 'broadcast', normalized);
        sendJson(res, 200, {ok: true, updatedAt: nowSec});
        return;
      }

      if (!isPosInt(body.table)) {
        sendJson(res, 400, {error: 'table must be a positive integer.'});
        return;
      }
      const tableNum = body.table;
      const maxTables = Math.max(tournament.parallelTables, tableNum);
      let existing = broadcastsByTournament.get(tournament.id);
      if (!existing) {
        const defaultInc = turnIncrementSeconds(tournament.format);
        existing = normalizeLiveBroadcast(
          {
            tournamentId: tournament.id,
            updatedAt: nowSec,
            tables: Array.from({length: maxTables}, (_, idx) => ({
              table: idx + 1,
              label: `Table ${idx + 1}`,
              idle: true,
              live: false,
            })),
            seriesLeftHtml: '',
            seriesRightHtml: '',
            p1: {name: '—', bankSeconds: 0, thinking: false, incrementSeconds: defaultInc},
            p2: {name: '—', bankSeconds: 0, thinking: false, incrementSeconds: defaultInc},
            lines: [],
            live: false,
          },
          nowSec
        );
      }

      const tables = existing.tables.slice();
      while (tables.length < maxTables) {
        const nextNum = tables.length + 1;
        tables.push({table: nextNum, label: `Table ${nextNum}`, idle: true, live: false});
      }
      const idx = tables.findIndex(tb => tb.table === tableNum);
      const prev = idx >= 0
        ? tables[idx]
        : {table: tableNum, label: `Table ${tableNum}`, idle: true, live: false};
      const label = typeof body.label === 'string' && body.label.trim()
        ? body.label.trim()
        : prev.label;

      if (body.idle === true) {
        const idleTable: BroadcastTable = {
          table: tableNum,
          label,
          idle: true,
          live: false,
          updatedAt: nowSec,
        };
        if (idx >= 0) tables[idx] = idleTable;
        else tables.push(idleTable);
        const normalized = normalizeLiveBroadcast({...existing, updatedAt: nowSec, tables}, nowSec);
        broadcastsByTournament.set(tournament.id, normalized);
        liveSeq++;
        pushTournamentEvent(tournament.id, 'table-idle', {
          table: tableNum,
          label,
          updatedAt: nowSec,
          broadcast: normalized,
        });
        sendJson(res, 200, {ok: true, updatedAt: nowSec});
        return;
      }

      const mode = body.mode === 'append' ? 'append' : 'load';
      if (mode !== 'append' && (!body.p1 || !body.p2)) {
        sendJson(res, 400, {error: 'p1 and p2 clock objects are required for mode="load".'});
        return;
      }
      if (mode === 'append' && (!prev.p1 || !prev.p2) && (!body.p1 || !body.p2)) {
        sendJson(res, 400, {error: 'Cannot append to an uninitialized table without p1 and p2.'});
        return;
      }

      const p1 = body.p1 !== undefined ? parseBroadcastPlayer(body.p1, 'p1') : prev.p1!;
      const p2 = body.p2 !== undefined ? parseBroadcastPlayer(body.p2, 'p2') : prev.p2!;
      const incomingLines = Array.isArray(body.lines) ? body.lines.map(String) : [];

      let stage = prev.stage;
      if (body.stage !== undefined) {
        if (
          typeof body.stage !== 'string' ||
          !VALID_TOURNAMENT_STAGES.has(body.stage as db.TournamentGameStage)
        ) {
          sendJson(res, 400, {error: 'Invalid stage.'});
          return;
        }
        stage = body.stage as db.TournamentGameStage;
      }
      const cycle = body.cycle !== undefined
        ? (isPosInt(body.cycle) ? body.cycle : undefined)
        : (mode === 'append' ? prev.cycle : undefined);
      const matchupGame = body.matchupGame !== undefined
        ? (isPosInt(body.matchupGame) ? body.matchupGame : undefined)
        : (mode === 'append' ? prev.matchupGame : undefined);
      const gameId = typeof body.gameId === 'string' && body.gameId.trim()
        ? body.gameId.trim()
        : (mode === 'append' ? prev.gameId : undefined);

      const mergedLines = mode === 'append'
        ? [...(prev.lines ?? []), ...incomingLines].slice(-MAX_TABLE_LINES)
        : incomingLines.slice(-MAX_TABLE_LINES);

      const nextTable: BroadcastTable = {
        table: tableNum,
        label,
        idle: false,
        gameId,
        stage,
        cycle,
        matchupGame,
        p1,
        p2,
        lines: mergedLines,
        live: typeof body.live === 'boolean' ? body.live : true,
        updatedAt: nowSec,
      };
      const defaults = buildDefaultTableHeaders(nextTable);
      nextTable.seriesLeftHtml = typeof body.seriesLeftHtml === 'string'
        ? body.seriesLeftHtml
        : (mode === 'append' && prev.seriesLeftHtml ? prev.seriesLeftHtml : defaults.left);
      nextTable.seriesRightHtml = typeof body.seriesRightHtml === 'string'
        ? body.seriesRightHtml
        : (mode === 'append' && prev.seriesRightHtml ? prev.seriesRightHtml : defaults.right);

      if (idx >= 0) tables[idx] = nextTable;
      else tables.push(nextTable);
      const normalized = normalizeLiveBroadcast({...existing, updatedAt: nowSec, tables}, nowSec);
      broadcastsByTournament.set(tournament.id, normalized);
      liveSeq++;

      if (mode === 'append') {
        pushTournamentEvent(tournament.id, 'table-append', {
          table: tableNum,
          lines: incomingLines,
          p1: nextTable.p1,
          p2: nextTable.p2,
          live: nextTable.live,
          updatedAt: nowSec,
        });
      } else {
        pushTournamentEvent(tournament.id, 'table-load', {
          table: nextTable,
          broadcast: normalized,
        });
      }

      sendJson(res, 200, {ok: true, updatedAt: nowSec});
    } catch (err) {
      const status = (err as {status?: number}).status ?? 500;
      const message = err instanceof Error ? err.message : 'Tournament broadcast update failed.';
      sendJson(res, status, {error: message});
    }
  });

  app.post('/api/arena/tournaments/:id/game-complete', async (req, res) => {
    if (!authenticateArena(req, res)) return;

    const rawId = decodeRouteParam(req.params.id);
    const tournament = db.getTournament(rawId);
    if (!tournament) {
      sendJson(res, 404, {error: `Unknown tournament "${rawId}".`});
      return;
    }

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
      const game = parseCompletedTournamentGame(body.game, tournament.id);

      let nextStatus: db.TournamentStatus | undefined;
      if (body.tournamentStatus !== undefined) {
        if (
          typeof body.tournamentStatus !== 'string' ||
          !VALID_TOURNAMENT_STATUSES.has(body.tournamentStatus as db.TournamentStatus)
        ) {
          sendJson(res, 400, {error: 'Invalid tournamentStatus.'});
          return;
        }
        nextStatus = body.tournamentStatus as db.TournamentStatus;
      }

      let rawLog: string | undefined;
      if (body.log !== undefined) {
        if (typeof body.log !== 'string') {
          sendJson(res, 400, {error: 'log must be a string.'});
          return;
        }
        if (Buffer.byteLength(body.log, 'utf8') > MAX_TOURNAMENT_LOG_BYTES) {
          sendJson(res, 413, {error: 'Tournament game log exceeds 512 KiB limit.'});
          return;
        }
        rawLog = body.log;
      }

      const {duplicate} = db.recordCompletedTournamentGame(game);

      const logPath = path.join(publicDir, 'arena', 'tournaments', tournament.id, `${game.id}.log`);
      if (rawLog !== undefined && (!duplicate || !fs.existsSync(logPath))) {
        writeFileAtomic(logPath, rawLog.endsWith('\n') ? rawLog : `${rawLog}\n`);
      }

      const statusChanged = nextStatus !== undefined && nextStatus !== tournament.status;
      if (statusChanged && nextStatus) {
        db.setTournamentStatus(tournament.id, nextStatus, game.completedAt);
      }

      if (nextStatus === 'completed') {
        broadcastsByTournament.delete(tournament.id);
      } else {
        const existing = broadcastsByTournament.get(tournament.id);
        if (existing) {
          const tableNum = isPosInt(body.table) ? body.table : undefined;
          const tables = existing.tables.map(tb => {
            if ((tableNum && tb.table === tableNum) || (tb.gameId && tb.gameId === game.id)) {
              return {
                ...tb,
                live: false,
                p1: tb.p1
                  ? {
                    ...tb.p1,
                    thinking: false,
                    bankSeconds: game.p1BankSeconds ?? tb.p1.bankSeconds,
                  }
                  : undefined,
                p2: tb.p2
                  ? {
                    ...tb.p2,
                    thinking: false,
                    bankSeconds: game.p2BankSeconds ?? tb.p2.bankSeconds,
                  }
                  : undefined,
                updatedAt: game.completedAt,
              };
            }
            return tb;
          });
          broadcastsByTournament.set(
            tournament.id,
            normalizeLiveBroadcast({...existing, updatedAt: game.completedAt, tables}, getNowSec())
          );
        }
      }

      liveSeq++;
      archiveSeq++;

      const updatedRow = db.getTournament(tournament.id)!;
      const doc = buildTournamentDocument(db, publicDir, updatedRow, 50);
      const savedGame = db.getTournamentGame(game.id);
      const enrichedGame = savedGame
        ? enrichTournamentGame(publicDir, tournament.id, savedGame)
        : undefined;

      pushTournamentEvent(tournament.id, 'game-complete', {
        duplicate,
        game: enrichedGame,
        completedGames: doc.completedGames,
        status: doc.status,
        completedAt: doc.completedAt,
        archiveHref: doc.archiveHref,
        standings: doc.standings,
        crosstable: doc.crosstable,
        broadcast: broadcastsByTournament.get(tournament.id),
      });

      if (statusChanged) {
        pushBattleEvent('live', {
          updatedAt: getNowSec(),
          stale: liveStale,
          live: liveStale ? undefined : currentLive,
          runningTournament: getRunningTournamentInfo(),
        });
        Promise.resolve(options.onUpdate?.('tournament-status')).catch(err => {
          console.error('Error in onUpdate callback:', err);
        });
      }

      if (!duplicate) {
        Promise.resolve(options.onUpdate?.('tournament-game-complete')).catch(err => {
          console.error('Error in onUpdate callback:', err);
        });
      }

      sendJson(res, 200, {
        ok: true,
        duplicate,
        gameId: game.id,
        logHref: enrichedGame?.logHref,
      });
    } catch (err) {
      const status = (err as {status?: number}).status ?? 500;
      const message = err instanceof Error ? err.message : 'Tournament game completion failed.';
      sendJson(res, status, {error: message});
    }
  });

  app.put('/api/arena/tournaments/:id/archive', async (req, res) => {
    if (!authenticateArena(req, res)) return;

    const rawId = decodeRouteParam(req.params.id);
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
      archiveSeq++;
      const idEnc = encodeURIComponent(tournament.id);
      const archiveHref = `/arena/tournaments/${idEnc}/${encodeURIComponent(fileName)}`;
      pushTournamentEvent(tournament.id, 'status', {
        tournamentId: tournament.id,
        status: tournament.status,
        completedAt: tournament.completedAt,
        archiveHref,
      });
      await Promise.resolve(options.onUpdate?.('archive-published'));
      sendJson(res, 200, {
        ok: true,
        tournamentId: tournament.id,
        archiveHref,
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

    const rawId = decodeRouteParam(req.params.id);
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
      archiveSeq++;
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

  app.put('/api/arena/ladders/:id/teams', async (req, res) => {
    if (!authenticateArena(req, res)) return;

    const rawId = decodeRouteParam(req.params.id);
    const ladder = db.getLadder(rawId);
    if (!ladder) {
      req.resume();
      sendJson(res, 404, {error: `Unknown ladder "${rawId}".`});
      return;
    }
    if (ladder.team !== 'harvested') {
      req.resume();
      sendJson(res, 400, {
        error: `Harvested teams can only be uploaded to "harvested" ladders ("${ladder.id}" ` +
          `has team="${ladder.team}").`,
      });
      return;
    }

    let rawTeams: string | string[];
    try {
      rawTeams = await readTeamsBody(req);
    } catch (err) {
      const status = (err as {status?: number}).status ?? 400;
      const message = err instanceof Error ? err.message : 'Invalid request body.';
      sendJson(res, status, {error: message});
      return;
    }

    let packed: string[];
    try {
      packed = validateHarvestedTeams(rawTeams, ladder.format);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Harvested team validation failed.';
      sendJson(res, 400, {error: message});
      return;
    }

    const count = db.replaceLadderTeams(ladder.id, packed, getNowSec());
    const sha256 = crypto.createHash('sha256').update(packed.join('\n')).digest('hex');
    await Promise.resolve(options.onUpdate?.('ladder-teams'));
    sendJson(res, 200, {
      ok: true,
      ladderId: ladder.id,
      format: ladder.format,
      count,
      sha256,
    });
  });

  app.get('/api/arena/ladders', (req, res) => {
    if (!authenticateArena(req, res)) return;

    const ladders = db.getPlayableLadders().map(l => {
      const entries = db.getLeaderboardEntries(l.id).map(e => ({
        versionId: e.versionId,
        agentId: e.agentId,
        agentSlug: e.agentSlug,
        agentName: e.agentName,
        version: e.version,
        elo: e.elo,
        se: e.se,
        lcb: e.lcb,
        matches: e.matches,
        ...(e.settledAt !== undefined ? {settledAt: e.settledAt} : {}),
        role: e.role,
      }));
      const playableAgents = new Set(
        entries
          .filter(e => e.role !== 'retired')
          .map(e => e.agentId)
      );
      const roster = l.team === 'pools'
        ? db.getActiveRosterForLadder(l.id)
          .filter(r => playableAgents.has(r.agentId))
          .map(r => ({
            agentId: r.agentId,
            agentName: r.agentName,
            teams: r.teams.map(t => t.packed),
          }))
        : undefined;

      return {
        id: l.id,
        slot: l.slot,
        format: l.format,
        team: l.team,
        status: l.status,
        min: l.min,
        entries,
        pairAggregates: db.getPairAggregatesForLadder(l.id).map(p => ({
          lowVersionId: p.lowVersionId,
          highVersionId: p.highVersionId,
          ww: p.ww,
          wt: p.wt,
          split: p.split,
          tl: p.tl,
          ll: p.ll,
        })),
        ...(roster !== undefined ? {roster} : {}),
      };
    });

    sendJson(res, 200, {ladders});
  });

  app.get('/api/arena/tournaments/:id/state', (req, res) => {
    if (!authenticateArena(req, res)) return;

    const rawId = decodeRouteParam(req.params.id);
    const tournament = db.getTournament(rawId);
    if (!tournament) {
      sendJson(res, 404, {error: `Unknown tournament "${rawId}".`});
      return;
    }

    let customRules: string[] = [];
    try {
      const parsed = JSON.parse(tournament.rulesJson) as unknown;
      if (Array.isArray(parsed)) {
        customRules = parsed.filter((r): r is string => typeof r === 'string');
      }
    } catch {}

    const entrants = db.getTournamentEntrants(tournament.id).map(e => {
      const ver = db.getVersionById(e.versionId);
      return {
        versionId: e.versionId,
        agentId: e.agentId,
        agentSlug: e.agentSlug,
        agentName: e.agentName,
        version: e.version,
        ...(e.seed !== undefined ? {seed: e.seed} : {}),
        ...(e.finalRank !== undefined ? {finalRank: e.finalRank} : {}),
        points: e.points,
        sonnebornBerger: e.sonnebornBerger,
        url: ver?.url ?? '',
        sha256: ver?.sha256 ?? '',
      };
    });

    const games = db.getTournamentGames(tournament.id).map(g => ({
      id: g.id,
      stage: g.stage,
      cycle: g.cycle,
      matchupGame: g.matchupGame,
      p1VersionId: g.p1VersionId,
      p2VersionId: g.p2VersionId,
      ...(g.outcome !== undefined ? {outcome: g.outcome} : {}),
      ...(g.turns !== undefined ? {turns: g.turns} : {}),
      ...(g.endReason !== undefined ? {endReason: g.endReason} : {}),
    }));

    let teamPool: string[] = [];
    const matchingLadder = db.getLadders().find(
      l => l.format === tournament.format && l.status !== 'archived'
    ) ?? db.getLadders().find(l => l.format === tournament.format);
    if (matchingLadder) {
      if (matchingLadder.team === 'harvested') {
        teamPool = db.getLadderTeams(matchingLadder.id);
      } else if (matchingLadder.team === 'pools') {
        const seen = new Set<string>();
        for (const r of db.getActiveRosterForLadder(matchingLadder.id)) {
          for (const t of r.teams) {
            if (!seen.has(t.packed)) {
              seen.add(t.packed);
              teamPool.push(t.packed);
            }
          }
        }
      }
    }

    sendJson(res, 200, {
      tournament: {
        id: tournament.id,
        name: tournament.name,
        format: tournament.format,
        customRules,
        gamesPerMatchup: tournament.gamesPerMatchup,
        batchSize: tournament.batchSize,
        parallelTables: tournament.parallelTables,
        hardware: tournament.hardware,
        status: tournament.status,
        startsAt: tournament.startsAt,
        ...(tournament.completedAt !== undefined ? {completedAt: tournament.completedAt} : {}),
      },
      entrants,
      games,
      teamPool,
    });
  });

  app.get('/api/arena/ladders/:id/teams', (req, res) => {
    if (!authenticateArena(req, res)) return;

    const rawId = decodeRouteParam(req.params.id);
    const ladder = db.getLadder(rawId);
    if (!ladder) {
      sendJson(res, 404, {error: `Unknown ladder "${rawId}".`});
      return;
    }
    if (ladder.team !== 'harvested') {
      sendJson(res, 400, {
        error: `Ladder "${ladder.id}" does not use harvested teams (team="${ladder.team}").`,
      });
      return;
    }

    const teams = db.getLadderTeams(ladder.id);
    if (teams.length === 0) {
      sendJson(res, 404, {error: `No harvested teams uploaded for ladder "${ladder.id}".`});
      return;
    }

    const sha256 = crypto.createHash('sha256').update(teams.join('\n')).digest('hex');
    const etag = `"${sha256}"`;
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) {
      res.statusCode = 304;
      res.end();
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({
      ladderId: ladder.id,
      format: ladder.format,
      count: teams.length,
      sha256,
      teams,
    }));
  });

  let cachedLiveJson: {key: string; payload: string; etag: string} | undefined;

  const getLadderArchiveToken = (): string => {
    const base = path.join(publicDir, 'arena', 'ladders');
    if (!fs.existsSync(base)) return '';
    const parts: string[] = [];
    for (const entry of fs.readdirSync(base)) {
      try {
        parts.push(`${entry}:${fs.statSync(path.join(base, entry), {bigint: true}).mtimeNs}`);
      } catch {}
    }
    return parts.join(',');
  };

  app.get('/api/live.json', (req, res) => {
    const nowSec = getNowSec();
    const liveTimeKey = liveUpdatedAt !== undefined
      ? String(liveUpdatedAt)
      : String(Math.floor(nowSec / 5));
    const liveKey = `${db.getChangeToken()}:${liveSeq}:${archiveSeq}:${liveStale ? 1 : 0}:` +
      `${liveTimeKey}:${getLadderArchiveToken()}`;
    if (cachedLiveJson?.key !== liveKey) {
      const payload = JSON.stringify(getLiveDocument(nowSec));
      const etag = `"${crypto.createHash('sha1').update(payload).digest('hex')}"`;
      cachedLiveJson = {key: liveKey, payload, etag};
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('ETag', cachedLiveJson.etag);
    if (req.headers['if-none-match'] === cachedLiveJson.etag) {
      res.statusCode = 304;
      res.end();
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(cachedLiveJson.payload);
  });

  app.get('/api/battles/stream', (req, res) => {
    const parsedUrl = new URL(req.url ?? '/api/battles/stream', 'http://localhost');
    const once = parsedUrl.searchParams.get('once');
    openSse(res);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    sendSse(res, 'snapshot', getLiveDocument());
    if (once === '1' || once === 'true') {
      res.end();
      return;
    }
    battleStreamClients.add(res);
    req.on('close', () => {
      battleStreamClients.delete(res);
    });
  });

  app.get('/api/tournament-live.json', (req, res) => {
    const parsedUrl = new URL(req.url ?? '/api/tournament-live.json', 'http://localhost');
    const requestedId = parsedUrl.searchParams.get('tournament')?.trim() ||
      db.getRunningTournament()?.id;
    const broadcast = requestedId ? broadcastsByTournament.get(requestedId) : undefined;
    if (!broadcast) {
      sendJson(res, 404, {error: 'No active tournament broadcast.'});
      return;
    }
    sendCachedJson(req, res, broadcast);
  });

  app.get('/api/tournaments/:id/stream', (req, res) => {
    const rawId = decodeRouteParam(req.params.id);
    const tournament = db.getTournament(rawId);
    if (!tournament) {
      sendJson(res, 404, {error: `Unknown tournament "${rawId}".`});
      return;
    }
    const parsedUrl = new URL(req.url ?? '/', 'http://localhost');
    const once = parsedUrl.searchParams.get('once');
    openSse(res);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const doc = buildTournamentDocument(db, publicDir, tournament, 50);
    sendSse(res, 'snapshot', {
      ...doc,
      broadcast: broadcastsByTournament.get(tournament.id),
    });
    if (once === '1' || once === 'true') {
      res.end();
      return;
    }
    let set = tournamentStreamClients.get(tournament.id);
    if (!set) {
      set = new Set();
      tournamentStreamClients.set(tournament.id, set);
    }
    set.add(res);
    req.on('close', () => {
      const cur = tournamentStreamClients.get(tournament.id);
      if (cur) {
        cur.delete(res);
        if (cur.size === 0) tournamentStreamClients.delete(tournament.id);
      }
    });
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
    close: closeAll,
    getLiveDocument,
    writeLiveJson: (nowSec?: number) => getLiveDocument(nowSec),
    setLiveState: state => {
      currentLive = state.live;
      liveStale = state.stale ?? false;
      liveUpdatedAt = state.updatedAt ?? getNowSec();
      liveSeq++;
      pushBattleEvent('live', {
        updatedAt: liveUpdatedAt,
        stale: liveStale,
        live: liveStale ? undefined : currentLive,
        runningTournament: getRunningTournamentInfo(),
      });
    },
    getTournamentBroadcast: (tournamentId?: string) => {
      const id = tournamentId ?? db.getRunningTournament()?.id;
      return id ? broadcastsByTournament.get(id) : undefined;
    },
    setTournamentBroadcast: (broadcast?: LiveBroadcast, tournamentId?: string) => {
      const id = broadcast?.tournamentId ?? tournamentId ?? db.getRunningTournament()?.id;
      if (!id) return;
      if (!broadcast) {
        broadcastsByTournament.delete(id);
        liveSeq++;
        pushTournamentEvent(id, 'broadcast-end', {tournamentId: id, updatedAt: getNowSec()});
        return;
      }
      const normalized = normalizeLiveBroadcast(broadcast, getNowSec());
      broadcastsByTournament.set(id, normalized);
      liveSeq++;
      pushTournamentEvent(id, 'broadcast', normalized);
    },
    notifyTournamentStatus: (tournamentId: string) => {
      const t = db.getTournament(tournamentId);
      if (t?.status === 'completed') {
        broadcastsByTournament.delete(tournamentId);
      }
      liveSeq++;
      if (t) {
        const doc = buildTournamentDocument(db, publicDir, t, 50);
        pushTournamentEvent(tournamentId, 'status', {
          tournamentId,
          status: doc.status,
          completedAt: doc.completedAt,
          archiveHref: doc.archiveHref,
          standings: doc.standings,
          crosstable: doc.crosstable,
          broadcast: broadcastsByTournament.get(tournamentId),
        });
      }
      pushBattleEvent('live', {
        updatedAt: getNowSec(),
        stale: liveStale,
        live: liveStale ? undefined : currentLive,
        runningTournament: getRunningTournamentInfo(),
      });
      Promise.resolve(options.onUpdate?.('tournament-status')).catch(err => {
        console.error('Error in onUpdate callback:', err);
      });
    },
    getState: () => ({
      lastSeenAt,
      watchdogTriggered,
      live: currentLive,
      liveSeq,
      archiveSeq,
    }),
  };
}
