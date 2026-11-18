import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

import {extractChannelMessages} from '@pkmn/sim';
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
export const READY_GRACE_SECONDS = 60;
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
const RECENT_MATCHES_LIMIT = 25;

const VALID_SMOKE_UPDATES = new Set<Exclude<db.SmokeStatus, 'pending'>>([
  'passed',
  'failed',
  'quarantined',
]);
const VALID_GAME_OUTCOMES = new Set<ratings.GameOutcome>(['W', 'L', 'T']);
const VALID_MATCH_CATEGORIES = new Set<ratings.MatchCategory>([
  'WW', 'WT', 'TW', 'WL', 'LW', 'TT', 'TL', 'LT', 'LL',
]);
const VALID_LADDER_STATUSES = new Set<db.LadderStatus>([
  'upcoming', 'active', 'settling', 'archived',
]);
const VALID_SLOTS = new Set<string>(['rby', 'adv', 'sv', 'rand', 'vgc']);
const VALID_POKEMON_COLORS = new Set<PokemonColor>(['green', 'yellow', 'red', 'fainted']);

export type PokemonColor = 'green' | 'yellow' | 'red' | 'fainted';

export interface PokemonHealth {
  percent: number;
  color: PokemonColor;
}

export type LivePhase = 'init' | 'preview' | 'battle';

export interface LiveSlot {
  slug: string;
  name: string;
  version: string;
  bankSeconds: number;
  initMillis?: number;
  teamPreviewMillis?: number;
  lastTurnMillis: number;
  meanTurnMillis: number;
  ram: number;
  team?: string;
  pokemon?: PokemonHealth[];
}

export interface LiveGameSummarySide {
  bankSeconds: number;
  initMillis?: number;
  teamPreviewMillis?: number;
  meanTurnMillis: number;
  ram: number;
  team?: string;
  pokemon?: PokemonHealth[];
}

export interface LiveGameSummary {
  winnerSlot?: 'p1' | 'p2';
  turns: number;
  endReason?: string;
  p1?: LiveGameSummarySide;
  p2?: LiveGameSummarySide;
}

export interface LiveGameSummaryInput extends LiveGameSummary {
  viewer?: LiveViewerInput;
}

export interface LiveViewerSide {
  lines: string[];
  pokemon?: unknown[];
}

export interface LiveViewerState {
  lines: string[];
  p1: LiveViewerSide;
  p2: LiveViewerSide;
}

export interface LiveViewerInput {
  lines?: string[];
  p1?: {lines?: string[]; pokemon?: unknown[]};
  p2?: {lines?: string[]; pokemon?: unknown[]};
}

// Live telemetry enforces a strict zero-log anti-scouting policy on `harvested` and `pools`
// ladders (spectators see turn numbers, Showdown chess clocks, SIGSTOP/SIGCONT slot state,
// XNU physical footprint RAM, and sanitized per-Pokémon HP% + bar color — never teams, Pokémon
// species, move choices, raw max HP, or battle logs). On `random` ladders, `viewer` streams the
// live Showdown battle log because teams are generated randomly per game and agents execute in an
// airgapped sandbox without internet access.
export interface LiveMatch {
  heartbeatSeq: number;
  matchId: string;
  ladderId: string;
  slot?: db.LadderSlot;
  format: string;
  game: 1 | 2;
  phase?: LivePhase;
  turn: number;
  activeSlot?: 'p1' | 'p2';
  turnStartedAt: number;
  turnBudgetSeconds: number;
  incrementSeconds: number;
  game1Summary?: LiveGameSummary;
  p1: LiveSlot;
  p2: LiveSlot;
  viewer?: LiveViewerState;
}

export type LiveMatchInput = Omit<LiveMatch, 'viewer' | 'game1Summary'> & {
  game1Summary?: LiveGameSummaryInput;
  viewer?: LiveViewerInput;
};

export interface BattleHistoryGameEntry extends db.RecentMatchGame {
  logHref?: string;
}

export interface BattleHistoryEntry extends Omit<db.RecentMatchView, 'games'> {
  ladderHref: string;
  games: [BattleHistoryGameEntry, BattleHistoryGameEntry];
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
  pokemon?: unknown[];
}

export interface SeriesGameSummary {
  winnerSlot?: 'p1' | 'p2';
  turns: number;
}

export interface BroadcastTable {
  table: number;
  label: string;
  idle?: boolean;
  gameId?: string;
  stage?: db.TournamentGameStage;
  cycle?: number;
  matchupGame?: number;
  game?: number;
  bestOf?: number;
  summaries?: SeriesGameSummary[];
  seriesLeftHtml?: string;
  seriesRightHtml?: string;
  p1?: BroadcastPlayer;
  p2?: BroadcastPlayer;
  lines?: string[];
  p1Lines?: string[];
  p2Lines?: string[];
  live?: boolean;
  updatedAt?: number;
}

// Unlike the 24/7 continuous ladders (which enforce a zero-log anti-scouting policy), scheduled
// Tournaments use locked submitted binaries and open team sheets, so full Showdown
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
  p1Lines?: string[];
  p2Lines?: string[];
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

export interface TournamentCrosstableSide {
  versionId: number;
  slug?: string;
  name?: string;
  version?: string;
  wins: number;
}

export interface TournamentCrosstableEntry {
  stage: db.TournamentGameStage;
  low: TournamentCrosstableSide;
  high: TournamentCrosstableSide;
  ties: number;
}

export interface TournamentGameDetailEntry extends db.TournamentGameRow {
  logHref?: string;
}

export interface TournamentGameEntry {
  id: string;
  stage: db.TournamentGameStage;
  cycle: number;
  matchupGame: number;
  preemptions?: number;
  outcome?: ratings.GameOutcome;
  completedAt?: number;
  logHref?: string;
  p1: db.TournamentGamePlayerView;
  p2: db.TournamentGamePlayerView;
  games: TournamentGameDetailEntry[];
}

export interface TournamentDocument {
  id: string;
  name: string;
  format: string;
  bestOf: number;
  team?: db.TeamMode;
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
// published as `<ladder_id>-logs.tar` (wrapping daily `.7z` archives and monthly `.tar` rollups)
// for random-battle (`random`) ladders (updated daily, as there are no proprietary team rosters)
// and for competitor team-pool (`pools`) ladders strictly AFTER the ladder has been retired
// (`status === 'archived'`).
export function resolveLadderArchive(
  publicDir: string,
  ladder: Pick<db.LadderRow, 'id' | 'team' | 'status'>
): {name: string; href: string} | undefined {
  const canExpose =
    ladder.team === 'random' ||
    (ladder.team === 'pools' && ladder.status === 'archived');
  if (!canExpose) return undefined;
  const idEnc = encodeURIComponent(ladder.id);
  const defaultName = `${ladder.id}-logs.tar`;
  const fallbackName = 'logs.tar';
  const candidates = [
    {
      diskPath: path.join(publicDir, 'arena', 'ladders', ladder.id, defaultName),
      name: defaultName,
      href: `/arena/ladders/${idEnc}/${encodeURIComponent(defaultName)}`,
    },
    {
      diskPath: path.join(publicDir, 'arena', 'ladders', ladder.id, fallbackName),
      name: fallbackName,
      href: `/arena/ladders/${idEnc}/${fallbackName}`,
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

export function resolveTournamentTeamPool(
  db: db.Database,
  tournament: Pick<db.TournamentRow, 'format' | 'team'>
): string[] {
  if (tournament.team !== 'harvested' && tournament.team !== 'pools') return [];
  const allLadders = db.getLadders().filter(l => l.format === tournament.format);
  if (tournament.team === 'harvested') {
    const harvestedLadder =
      allLadders.find(l => l.team === 'harvested' && l.status !== 'archived') ??
      allLadders.find(l => l.team === 'harvested');
    return harvestedLadder ? db.getLadderTeams(harvestedLadder.id) : [];
  }
  // Competitor-submitted `pools` rosters remain private while a ladder is active/settling/upcoming;
  // only retired (`status === 'archived'`) ladder pools may be reused in live-replay tournaments.
  const archivedPoolsLadder = allLadders.find(
    l => l.team === 'pools' && l.status === 'archived'
  );
  if (!archivedPoolsLadder) return [];
  const seen = new Set<string>();
  const pool: string[] = [];
  for (const r of db.getActiveRosterForLadder(archivedPoolsLadder.id)) {
    for (const t of r.teams) {
      if (!seen.has(t.packed)) {
        seen.add(t.packed);
        pool.push(t.packed);
      }
    }
  }
  return pool.length > 0 ? pool : db.getLadderTeams(archivedPoolsLadder.id);
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
  const idEnc = encodeURIComponent(tournamentId);
  const tourDir = path.join(publicDir, 'arena', 'tournaments', tournamentId);
  const checkLog = (rel: string): string | undefined => {
    const exists = logFiles ? logFiles.has(rel) : fs.existsSync(path.join(tourDir, rel));
    return exists ? `/arena/tournaments/${idEnc}/${encodeURIComponent(rel)}` : undefined;
  };
  const singleHref = checkLog(`${g.id}.log`);
  const games: TournamentGameDetailEntry[] = g.games.map(gm => {
    const gNumHref = checkLog(`${g.id}-g${gm.gameNumber}.log`);
    const fallbackHref = gm.gameNumber === 1 && g.games.length === 1 ? singleHref : undefined;
    const logHref = gNumHref ?? fallbackHref;
    return {
      ...gm,
      ...(logHref !== undefined ? {logHref} : {}),
    };
  });
  const logHref = games[0]?.logHref ?? singleHref;
  return {
    id: g.id,
    stage: g.stage,
    cycle: g.cycle,
    matchupGame: g.matchupGame,
    preemptions: g.preemptions,
    outcome: g.outcome,
    completedAt: g.completedAt,
    logHref,
    p1: g.p1,
    p2: g.p2,
    games,
  };
}

export interface PreloadedTournamentData {
  entrants?: db.TournamentEntrantView[];
  games?: db.TournamentGameView[];
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
  const games = preloaded?.games ?? db.getTournamentGames(tournament.id, gamesLimit);
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
      low: {
        versionId: p.lowVersionId,
        slug: low?.agentSlug,
        name: low?.agentName,
        version: low?.version,
        wins: p.lowWins,
      },
      high: {
        versionId: p.highVersionId,
        slug: high?.agentSlug,
        name: high?.agentName,
        version: high?.version,
        wins: p.highWins,
      },
      ties: p.ties,
    };
  };

  return {
    id: tournament.id,
    name: tournament.name,
    format: tournament.format,
    bestOf: tournament.bestOf,
    ...(tournament.team ? {team: tournament.team} : {}),
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

// Computes integer HP percentage (`0..100`) and HP bar color matching Pokémon Showdown
// (`@pkmn/sim` `Pokemon#getHealth` and `pokemon-showdown-client` `Pokemon#getHPColor` / `hpWidth`)
// without exposing exact `maxhp`, species, or moves. Color carries exact-ratio boundary information
// (`hp * 2 > maxhp` green, `hp * 5 > maxhp` yellow, `<= 1/5` red) that integer rounding alone
// loses (e.g. `101/201` -> `50%` green vs `100/200` -> `50%` yellow).
export function computePokemonHealth(
  hp: number,
  maxhp: number,
  format = '',
  explicitColor?: 'g' | 'y' | 'r'
): PokemonHealth {
  if (!Number.isFinite(hp) || !Number.isFinite(maxhp) || hp <= 0 || maxhp <= 0) {
    return {percent: 0, color: 'fainted'};
  }
  if (hp >= maxhp) {
    return {percent: 100, color: 'green'};
  }
  const color: PokemonColor = explicitColor === 'g'
    ? 'green'
    : explicitColor === 'y'
      ? 'yellow'
      : explicitColor === 'r'
        ? 'red'
        : hp * 2 > maxhp
          ? 'green'
          : hp * 5 > maxhp
            ? 'yellow'
            : 'red';

  const lowerFmt = format.toLowerCase();
  let percent: number;
  if (lowerFmt.includes('champions')) {
    percent = Math.max(1, Math.min(99, Math.floor((100 * hp) / maxhp) || 1));
  } else {
    const genMatch = /^gen(\d+)/.exec(lowerFmt);
    const gen = genMatch ? Number(genMatch[1]) : 9;
    if (gen >= 7) {
      const ceil = Math.ceil((100 * hp) / maxhp);
      percent = ceil >= 100 ? 99 : Math.max(1, ceil);
    } else {
      const rounded = Math.round((100 * hp) / maxhp) || 1;
      percent = rounded >= 100 ? 99 : Math.max(1, rounded);
    }
  }
  return {percent, color};
}

export function parseHealthCondition(condition: string, format = ''): PokemonHealth | undefined {
  const trimmed = condition.trim();
  if (!trimmed) return undefined;
  const token = trimmed.split(/\s+/)[0];
  if (token === '0' || token === '0.0' || trimmed.endsWith(' fnt') || trimmed === 'fnt') {
    return {percent: 0, color: 'fainted'};
  }
  const slash = token.indexOf('/');
  if (slash > 0) {
    const curStr = token.slice(0, slash);
    let maxStr = token.slice(slash + 1);
    const tail = maxStr.slice(-1);
    let explicitColor: 'g' | 'y' | 'r' | undefined;
    if (tail === 'g' || tail === 'y' || tail === 'r') {
      explicitColor = tail;
      maxStr = maxStr.slice(0, -1);
    }
    const hp = Number(curStr);
    const maxhp = Number(maxStr);
    if (!Number.isFinite(hp) || !Number.isFinite(maxhp) || maxhp <= 0) return undefined;
    return computePokemonHealth(hp, maxhp, format, explicitColor);
  }
  const pct = Number(token.endsWith('%') ? token.slice(0, -1) : token);
  if (Number.isFinite(pct)) {
    return computePokemonHealth(pct, 100, format);
  }
  return undefined;
}

function isSanitizedPokemonHealth(item: unknown): item is PokemonHealth {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const obj = item as Record<string, unknown>;
  return (
    typeof obj.percent === 'number' &&
    Number.isInteger(obj.percent) &&
    obj.percent >= 0 &&
    obj.percent <= 100 &&
    typeof obj.color === 'string' &&
    VALID_POKEMON_COLORS.has(obj.color as PokemonColor)
  );
}

function extractRequestPokemonFromLines(
  lines: readonly string[] | undefined
): {p1?: unknown[]; p2?: unknown[]} {
  if (!lines || lines.length === 0) return {};
  let p1: unknown[] | undefined;
  let p2: unknown[] | undefined;
  for (const line of lines) {
    if (!line.startsWith('|request|')) continue;
    const rawJson = line.slice('|request|'.length).trim();
    if (!rawJson || rawJson === 'null') continue;
    try {
      const parsed = JSON.parse(rawJson) as {
        side?: {id?: string; pokemon?: unknown[]};
      };
      const sideId = parsed.side?.id;
      const mons = parsed.side?.pokemon;
      if (Array.isArray(mons) && (sideId === 'p1' || sideId === 'p2')) {
        if (sideId === 'p1') p1 = mons;
        else p2 = mons;
      }
    } catch {}
  }
  return {p1, p2};
}

function projectPokemonHealthOrder(
  entries: ReadonlyArray<{health: PokemonHealth; active: boolean}>,
  finished = false
): PokemonHealth[] {
  const activeSlots = entries.filter(e => e.active).map(e => e.health);
  const benchSlots = entries.filter(e => !e.active).map(e => e.health);
  const aliveBench = benchSlots.filter(m => m.color !== 'fainted');
  const faintedBench = benchSlots.filter(m => m.color === 'fainted');
  if (!finished && aliveBench.length > 0) {
    return [...activeSlots, ...aliveBench, ...faintedBench];
  }
  const aliveActives = activeSlots.filter(m => m.color !== 'fainted');
  const faintedActives = activeSlots.filter(m => m.color === 'fainted');
  return [...aliveActives, ...aliveBench, ...faintedActives, ...faintedBench];
}

// Sanitizes `@pkmn/sim` `side.getRequestData().pokemon` (`|request|<json>` `side.pokemon`) into
// `{percent, color}` health indicators without battle-log replay. Keeps `active` slot(s) in front
// (so a newly fainted active stays grey in-place during `forceSwitch`), swaps active and alive
// bench circles 1-for-1 across switches, and excludes fainted bench Pokémon (plus unreplaceable
// fainted actives when the bench is empty or `finished` is set) to the rightmost slots.
export function extractBattlePokemonHealth(opts: {
  lines?: readonly string[];
  format?: string;
  p1Pokemon?: readonly unknown[];
  p2Pokemon?: readonly unknown[];
  finished?: boolean;
}): {p1: PokemonHealth[]; p2: PokemonHealth[]} {
  const format = opts.format ?? '';
  const lowerFmt = format.toLowerCase();
  const defaultActiveCount = lowerFmt.includes('doubles') || lowerFmt.includes('vgc') ? 2 : 1;
  const fromLines = (!opts.p1Pokemon || !opts.p2Pokemon)
    ? extractRequestPokemonFromLines(opts.lines)
    : {};

  const buildSide = (rawMonList: readonly unknown[] | undefined): PokemonHealth[] => {
    if (!rawMonList || rawMonList.length === 0) return [];
    const entries: Array<{health: PokemonHealth; active: boolean}> = [];
    rawMonList.slice(0, 6).forEach((raw, idx) => {
      if (isSanitizedPokemonHealth(raw)) {
        entries.push({
          health: {percent: raw.percent, color: raw.color},
          active: idx < defaultActiveCount,
        });
        return;
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      const obj = raw as Record<string, unknown>;
      const cond = obj.condition;
      const health: PokemonHealth = typeof cond === 'string'
        ? (parseHealthCondition(cond, format) ?? {percent: 100, color: 'green'})
        : {percent: 100, color: 'green'};
      const active = typeof obj.active === 'boolean' ? obj.active : idx < defaultActiveCount;
      entries.push({health, active});
    });
    if (entries.length === 0) return [];
    return projectPokemonHealthOrder(entries, opts.finished);
  };

  return {
    p1: buildSide(opts.p1Pokemon ?? fromLines.p1),
    p2: buildSide(opts.p2Pokemon ?? fromLines.p2),
  };
}

function isViewerSeatSwapped(
  lines: readonly string[],
  game: 1 | 2,
  matchP1Name: string,
  matchP2Name: string
): boolean {
  let logP1: string | undefined;
  let logP2: string | undefined;
  for (const line of lines) {
    if (line.startsWith('|player|p1|')) {
      logP1 = line.split('|')[3]?.trim() || undefined;
    } else if (line.startsWith('|player|p2|')) {
      logP2 = line.split('|')[3]?.trim() || undefined;
    }
    if (logP1 && logP2) break;
  }
  if (logP1 && logP2 && logP1 !== logP2 && matchP1Name !== matchP2Name) {
    if (logP1 === matchP2Name && logP2 === matchP1Name) return true;
    if (logP1 === matchP1Name && logP2 === matchP2Name) return false;
  }
  return game === 2;
}

export function extractPerspectiveLogs(
  lines: readonly string[]
): {p1Lines: string[]; p2Lines: string[]} {
  if (lines.length === 0) return {p1Lines: [], p2Lines: []};
  const ch = extractChannelMessages(lines.join('\n'), [1, 2]);
  return {p1Lines: ch[1], p2Lines: ch[2]};
}

export function normalizeLiveBroadcast(
  raw: LiveBroadcast,
  nowSec = Math.floor(Date.now() / 1000)
): LiveBroadcast {
  const updatedAt = raw.updatedAt ?? nowSec;
  const tables: BroadcastTable[] = raw.tables.map((tb, idx) => {
    const tableNum = tb.table ?? idx + 1;
    const isPrimaryFallback = idx === 0 && !tb.p1 && !tb.lines;
    const lines = tb.lines ? tb.lines.slice() : (isPrimaryFallback ? raw.lines.slice() : []);
    const persp = tb.p1Lines && tb.p2Lines && (tb.lines === undefined || lines.length > 0)
      ? {p1Lines: tb.p1Lines.slice(), p2Lines: tb.p2Lines.slice()}
      : extractPerspectiveLogs(lines);
    return {
      table: tableNum,
      label: tb.label || `Table ${tableNum}`,
      idle: Boolean(tb.idle),
      gameId: tb.gameId,
      stage: tb.stage,
      cycle: tb.cycle,
      matchupGame: tb.matchupGame,
      ...(tb.game !== undefined ? {game: tb.game} : {}),
      ...(tb.bestOf !== undefined ? {bestOf: tb.bestOf} : {}),
      ...(tb.summaries !== undefined ? {summaries: tb.summaries.slice()} : {}),
      seriesLeftHtml: tb.seriesLeftHtml ?? (isPrimaryFallback ? raw.seriesLeftHtml : undefined),
      seriesRightHtml: tb.seriesRightHtml ?? (isPrimaryFallback ? raw.seriesRightHtml : undefined),
      p1: tb.p1 ?? (isPrimaryFallback ? {...raw.p1} : undefined),
      p2: tb.p2 ?? (isPrimaryFallback ? {...raw.p2} : undefined),
      lines,
      p1Lines: persp.p1Lines,
      p2Lines: persp.p2Lines,
      live: tb.idle ? false : (tb.live ?? (isPrimaryFallback ? raw.live !== false : true)),
      updatedAt: tb.updatedAt ?? updatedAt,
    };
  });
  const primary = tables.find(tb => !tb.idle && tb.p1 && tb.p2) ??
    tables.find(tb => tb.p1 && tb.p2) ??
    undefined;
  const primaryLines = primary?.lines ?? raw.lines;
  const primaryPersp = primary?.p1Lines && primary?.p2Lines
    ? {p1Lines: primary.p1Lines, p2Lines: primary.p2Lines}
    : extractPerspectiveLogs(primaryLines);
  return {
    tournamentId: raw.tournamentId,
    updatedAt,
    tables,
    seriesLeftHtml: primary?.seriesLeftHtml ?? raw.seriesLeftHtml,
    seriesRightHtml: primary?.seriesRightHtml ?? raw.seriesRightHtml,
    p1: primary?.p1 ?? raw.p1,
    p2: primary?.p2 ?? raw.p2,
    lines: primaryLines,
    p1Lines: primaryPersp.p1Lines,
    p2Lines: primaryPersp.p2Lines,
    live: primary ? primary.live !== false : raw.live,
  };
}

export function normalizeLiveViewer(input?: LiveViewerInput): LiveViewerState | undefined {
  if (!input || !Array.isArray(input.lines)) return undefined;
  const lines = input.lines.slice();
  const hasPersp = Array.isArray(input.p1?.lines) && Array.isArray(input.p2?.lines);
  const persp = hasPersp
    ? {p1Lines: input.p1!.lines!.slice(), p2Lines: input.p2!.lines!.slice()}
    : extractPerspectiveLogs(lines);
  const p1Pokemon = Array.isArray(input.p1?.pokemon) ? input.p1.pokemon.slice(0, 6) : undefined;
  const p2Pokemon = Array.isArray(input.p2?.pokemon) ? input.p2.pokemon.slice(0, 6) : undefined;
  return {
    lines,
    p1: {
      lines: persp.p1Lines,
      ...(p1Pokemon !== undefined ? {pokemon: p1Pokemon} : {}),
    },
    p2: {
      lines: persp.p2Lines,
      ...(p2Pokemon !== undefined ? {pokemon: p2Pokemon} : {}),
    },
  };
}

export function enrichMatchView(publicDir: string, m: db.RecentMatchView): BattleHistoryEntry {
  const ladderHref = m.ladderStatus === 'archived'
    ? `/arena/ladders/${encodeURIComponent(m.ladderId)}/`
    : `/arena/ladders/${encodeURIComponent(m.slot)}/`;
  const [g1, g2] = m.games;
  const canExposeLogs =
    m.teamMode === 'random' ||
    (m.teamMode === 'pools' && m.ladderStatus === 'archived');
  if (!canExposeLogs) {
    return {
      ...m,
      ladderHref,
      games: [{...g1}, {...g2}],
    };
  }
  if (m.teamMode === 'pools') {
    promoteArchivedPoolsLogs(publicDir, m.ladderId);
  }
  const idEnc = encodeURIComponent(m.ladderId);
  const ladderDir = path.join(publicDir, 'arena', 'ladders', m.ladderId);
  const g1Rel = `${m.id}a.log`;
  const g2Rel = `${m.id}b.log`;
  const game1LogHref = fs.existsSync(path.join(ladderDir, g1Rel))
    ? `/arena/ladders/${idEnc}/${encodeURIComponent(g1Rel)}`
    : undefined;
  const game2LogHref = fs.existsSync(path.join(ladderDir, g2Rel))
    ? `/arena/ladders/${idEnc}/${encodeURIComponent(g2Rel)}`
    : undefined;
  return {
    ...m,
    ladderHref,
    games: [
      {...g1, ...(game1LogHref !== undefined ? {logHref: game1LogHref} : {})},
      {...g2, ...(game2LogHref !== undefined ? {logHref: game2LogHref} : {})},
    ],
  };
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
  armWatchdogOnStart?: boolean;
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
  setLiveState: (state: {live?: LiveMatchInput; stale?: boolean; updatedAt?: number}) => void;
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
  version?: string;
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
  version?: string;
  team?: db.TeamMode;
  teamPool?: string[];
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
  smokeInitMillis?: number;
  smokeTeamPreviewMillis?: number;
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

export type HeartbeatPayload = LiveMatchInput | {idle: true};

export interface HeartbeatResponse {
  ok: true;
  updatedAt: number;
}

export interface MatchCompletePayload {
  match: db.CompletedMatchPayload;
  game1Log?: string;
  game2Log?: string;
  ladderStatus?: db.LadderStatus;
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
  teamsHref?: string;
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
  {off: true; tournamentStatus?: 'completed'} |
  {table: number; idle: true; label?: string} |
  {
    table: number;
    mode?: 'load' | 'append';
    label?: string;
    gameId?: string;
    stage?: db.TournamentGameStage;
    cycle?: number;
    matchupGame?: number;
    game?: number;
    bestOf?: number;
    summaries?: SeriesGameSummary[];
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
  logs?: string[];
  tournamentStatus?: db.TournamentStatus;
}

export interface TournamentGameCompleteResponse {
  ok: true;
  duplicate: boolean;
  gameId: string;
  logHref?: string;
  gameLogHrefs?: Array<string | undefined>;
}

export interface TournamentStateResponse {
  tournament: {
    id: string;
    name: string;
    format: string;
    version?: string;
    bestOf: number;
    team?: db.TeamMode;
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
    p1: db.TournamentGamePlayer;
    p2: db.TournamentGamePlayer;
    outcome?: 'W' | 'L' | 'T';
    games: db.TournamentGameRow[];
  }>;
  teamPool: string[];
}

export interface ClientOptions {
  serverUrl: string;
  arenaSecret: string;
  fetch?: typeof globalThis.fetch;
  timeoutMillis?: number;
  allowInsecureHttp?: boolean;
}

export interface LadderMatchStateInput {
  ladder: Pick<db.LadderRow, 'id' | 'status' | 'min'>;
  entries: ReadonlyArray<{
    versionId: number;
    agentId: number;
    role: string;
    elo: number;
    se: number;
    matches: number;
    settledAt?: number;
  }>;
  pairs: ReadonlyArray<{
    lowVersionId: number;
    highVersionId: number;
    ww: number;
    wt: number;
    split: number;
    tl: number;
    ll: number;
  }>;
  lastMatchNumber?: number;
  rosterAgentIds?: ReadonlySet<number>;
  residencyMultipliers?: Float64Array;
}

export function buildLadderMatchState(
  input: LadderMatchStateInput
): ratings.LadderMatchState | undefined {
  const {
    ladder,
    entries,
    pairs,
    lastMatchNumber = 0,
    rosterAgentIds,
    residencyMultipliers,
  } = input;
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

function validateControlPlaneServerUrl(rawUrl: string, allowInsecureHttp = false): string {
  const trimmed = rawUrl.replace(/\/+$/, '');
  const parsed = new URL(trimmed);
  if (parsed.protocol === 'https:') return trimmed;
  if (parsed.protocol !== 'http:') {
    throw new Error(`Unsupported control-plane URL scheme "${parsed.protocol}"`);
  }
  const host = parsed.hostname.toLowerCase();
  const isLoopback =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]';
  if (!isLoopback && !allowInsecureHttp && process.env.ARENA_DEV !== '1') {
    throw new Error(
      `Refusing cleartext HTTP control-plane URL "${trimmed}" (use https:// or loopback tunnel)`
    );
  }
  return trimmed;
}

// Outbound worker control-plane HTTP client used by the Mac Mini Arena coordinator (and `--server`
// mock scenarios) to communicate with `/api/arena/*` using `Bearer $ARENA_SECRET`.
export class Client {
  readonly serverUrl: string;
  private readonly arenaSecret: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMillis: number;

  constructor(options: ClientOptions) {
    this.serverUrl = validateControlPlaneServerUrl(options.serverUrl, options.allowInsecureHttp);
    this.arenaSecret = options.arenaSecret;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMillis = options.timeoutMillis ?? 30_000;
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
      signal: AbortSignal.timeout(this.timeoutMillis),
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
    sha256?: string,
    contentType = 'application/octet-stream'
  ): Promise<T> {
    const digest = sha256 ?? crypto.createHash('sha256').update(archive).digest('hex');
    const bodyView = Buffer.isBuffer(archive)
      ? archive
      : Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
    const uploadTimeout = Math.max(this.timeoutMillis, 300_000);
    const res = await this.fetchImpl(`${this.serverUrl}${endpoint}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${this.arenaSecret}`,
        'content-type': contentType,
        'x-content-sha256': digest,
      },
      body: bodyView as unknown as BodyInit,
      signal: AbortSignal.timeout(uploadTimeout),
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
      version?: string;
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
    unpublishedArchivedPoolsLadders?: string[];
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
      sha256,
      'application/x-7z-compressed'
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

const MAX_SSE_BUFFER_BYTES = 4 * 1024 * 1024;

function sendSse(res: http.ServerResponse, event: string, data: unknown) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcastSseFrame(
  clients: Set<http.ServerResponse>,
  event: string,
  data: unknown
) {
  if (clients.size === 0) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    if (client.writableEnded || client.destroyed) {
      clients.delete(client);
      continue;
    }
    if (client.writableLength > MAX_SSE_BUFFER_BYTES) {
      client.destroy();
      clients.delete(client);
      continue;
    }
    client.write(frame);
  }
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
      if (!out.write(chunk)) {
        req.pause();
        out.once('drain', () => {
          if (!settled) req.resume();
        });
      }
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

function parsePokemonHealthArray(raw: unknown, label: string): PokemonHealth[] {
  if (!Array.isArray(raw) || raw.length > 6) {
    throw Object.assign(
      new Error(`${label} must be an array of at most 6 Pokémon health entries.`),
      {status: 400}
    );
  }
  return raw.map((entry, idx) => {
    if (!isSanitizedPokemonHealth(entry)) {
      throw Object.assign(new Error(`Invalid ${label}[${idx}].`), {status: 400});
    }
    return {percent: entry.percent, color: entry.color};
  });
}

function parseTeamHashLabel(raw: unknown, label: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !/^(?:P[12]:)?[0-9a-f]{12}$/i.test(raw.trim())) {
    throw Object.assign(new Error(`Invalid ${label}.`), {status: 400});
  }
  return raw.trim();
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
  if (obj.initMillis !== undefined && !isFiniteNonNeg(obj.initMillis)) {
    throw Object.assign(new Error(`Invalid ${label}.initMillis.`), {status: 400});
  }
  if (obj.teamPreviewMillis !== undefined && !isFiniteNonNeg(obj.teamPreviewMillis)) {
    throw Object.assign(new Error(`Invalid ${label}.teamPreviewMillis.`), {status: 400});
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
  const team = parseTeamHashLabel(obj.team, `${label}.team`);
  const pokemon = obj.pokemon !== undefined
    ? parsePokemonHealthArray(obj.pokemon, `${label}.pokemon`)
    : undefined;
  return {
    slug: obj.slug.trim(),
    name: obj.name.trim(),
    version: obj.version.trim(),
    bankSeconds: obj.bankSeconds,
    ...(obj.initMillis !== undefined ? {initMillis: obj.initMillis} : {}),
    ...(obj.teamPreviewMillis !== undefined ? {teamPreviewMillis: obj.teamPreviewMillis} : {}),
    lastTurnMillis: obj.lastTurnMillis,
    meanTurnMillis: obj.meanTurnMillis,
    ram: obj.ram,
    team,
    ...(pokemon && pokemon.length > 0 ? {pokemon} : {}),
  };
}

function parseLiveGameSummarySide(raw: unknown, label: string): LiveGameSummarySide {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw Object.assign(new Error(`Invalid ${label}.`), {status: 400});
  }
  const obj = raw as Record<string, unknown>;
  if (!isFiniteNonNeg(obj.bankSeconds)) {
    throw Object.assign(new Error(`Invalid ${label}.bankSeconds.`), {status: 400});
  }
  if (obj.initMillis !== undefined && !isFiniteNonNeg(obj.initMillis)) {
    throw Object.assign(new Error(`Invalid ${label}.initMillis.`), {status: 400});
  }
  if (obj.teamPreviewMillis !== undefined && !isFiniteNonNeg(obj.teamPreviewMillis)) {
    throw Object.assign(new Error(`Invalid ${label}.teamPreviewMillis.`), {status: 400});
  }
  if (!isFiniteNonNeg(obj.meanTurnMillis)) {
    throw Object.assign(new Error(`Invalid ${label}.meanTurnMillis.`), {status: 400});
  }
  if (!isFiniteNonNeg(obj.ram)) {
    throw Object.assign(new Error(`Invalid ${label}.ram.`), {status: 400});
  }
  const team = parseTeamHashLabel(obj.team, `${label}.team`);
  const pokemon = obj.pokemon !== undefined
    ? parsePokemonHealthArray(obj.pokemon, `${label}.pokemon`)
    : undefined;
  return {
    bankSeconds: obj.bankSeconds,
    ...(obj.initMillis !== undefined ? {initMillis: obj.initMillis} : {}),
    ...(obj.teamPreviewMillis !== undefined ? {teamPreviewMillis: obj.teamPreviewMillis} : {}),
    meanTurnMillis: obj.meanTurnMillis,
    ram: obj.ram,
    ...(team !== undefined ? {team} : {}),
    ...(pokemon && pokemon.length > 0 ? {pokemon} : {}),
  };
}

function parseLiveGameSummary(raw: unknown, format: string): LiveGameSummary {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw Object.assign(new Error('Invalid game1Summary.'), {status: 400});
  }
  const g1 = raw as Record<string, unknown>;
  if (g1.winnerSlot !== 'p1' && g1.winnerSlot !== 'p2' && g1.winnerSlot !== undefined) {
    throw Object.assign(
      new Error('game1Summary.winnerSlot must be "p1", "p2", or omitted.'),
      {status: 400}
    );
  }
  if (!isNonNegInt(g1.turns)) {
    throw Object.assign(
      new Error('game1Summary.turns must be a non-negative integer.'),
      {status: 400}
    );
  }
  let endReason: string | undefined;
  if (g1.endReason !== undefined) {
    if (typeof g1.endReason !== 'string' || !g1.endReason.trim()) {
      throw Object.assign(new Error('Invalid game1Summary.endReason.'), {status: 400});
    }
    endReason = g1.endReason.trim().slice(0, 64);
  }
  let p1 = g1.p1 !== undefined ? parseLiveGameSummarySide(g1.p1, 'game1Summary.p1') : undefined;
  let p2 = g1.p2 !== undefined ? parseLiveGameSummarySide(g1.p2, 'game1Summary.p2') : undefined;

  if (g1.viewer !== undefined) {
    if (!g1.viewer || typeof g1.viewer !== 'object' || Array.isArray(g1.viewer)) {
      throw Object.assign(new Error('Invalid game1Summary.viewer.'), {status: 400});
    }
    const rv = g1.viewer as Record<string, unknown>;
    if (rv.lines !== undefined && !Array.isArray(rv.lines)) {
      throw Object.assign(
        new Error('game1Summary.viewer.lines must be an array of strings.'),
        {status: 400}
      );
    }
    const lines = Array.isArray(rv.lines)
      ? rv.lines.slice(-MAX_TABLE_LINES).map(l => String(l).slice(0, 4096))
      : [];
    const rawP1 = rv.p1 && typeof rv.p1 === 'object'
      ? (rv.p1 as Record<string, unknown>)
      : undefined;
    const rawP2 = rv.p2 && typeof rv.p2 === 'object'
      ? (rv.p2 as Record<string, unknown>)
      : undefined;
    const g1Health = extractBattlePokemonHealth({
      lines,
      format,
      p1Pokemon: Array.isArray(rawP1?.pokemon) ? rawP1.pokemon : undefined,
      p2Pokemon: Array.isArray(rawP2?.pokemon) ? rawP2.pokemon : undefined,
      finished: true,
    });
    if (p1 && !p1.pokemon && g1Health.p1.length > 0) p1 = {...p1, pokemon: g1Health.p1};
    if (p2 && !p2.pokemon && g1Health.p2.length > 0) p2 = {...p2, pokemon: g1Health.p2};
  }
  if (p1?.pokemon || p2?.pokemon) {
    const projected = extractBattlePokemonHealth({
      format,
      p1Pokemon: p1?.pokemon,
      p2Pokemon: p2?.pokemon,
      finished: true,
    });
    if (p1?.pokemon) p1 = {...p1, pokemon: projected.p1};
    if (p2?.pokemon) p2 = {...p2, pokemon: projected.p2};
  }

  return {
    ...(g1.winnerSlot !== undefined ? {winnerSlot: g1.winnerSlot} : {}),
    turns: g1.turns,
    ...(endReason !== undefined ? {endReason} : {}),
    ...(p1 !== undefined ? {p1} : {}),
    ...(p2 !== undefined ? {p2} : {}),
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
  const hasMatchRam = isNonNegInt(m.p1PeakRam) && isNonNegInt(m.p2PeakRam);
  const hasGameRam =
    isNonNegInt(m.p1Game1PeakRam) &&
    isNonNegInt(m.p1Game2PeakRam) &&
    isNonNegInt(m.p2Game1PeakRam) &&
    isNonNegInt(m.p2Game2PeakRam);
  if (!hasMatchRam && !hasGameRam) {
    throw Object.assign(new Error('Invalid peak RAM telemetry.'), {status: 400});
  }
  if (
    (m.p1PeakRam !== undefined && !isNonNegInt(m.p1PeakRam)) ||
    (m.p2PeakRam !== undefined && !isNonNegInt(m.p2PeakRam)) ||
    (m.p1Game1PeakRam !== undefined && !isNonNegInt(m.p1Game1PeakRam)) ||
    (m.p1Game2PeakRam !== undefined && !isNonNegInt(m.p1Game2PeakRam)) ||
    (m.p2Game1PeakRam !== undefined && !isNonNegInt(m.p2Game1PeakRam)) ||
    (m.p2Game2PeakRam !== undefined && !isNonNegInt(m.p2Game2PeakRam))
  ) {
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
  const hasMatchTurnMs = isNonNegInt(m.p1MeanTurnMillis) && isNonNegInt(m.p2MeanTurnMillis);
  const hasGameTurnMs =
    isNonNegInt(m.p1Game1MeanTurnMillis) &&
    isNonNegInt(m.p1Game2MeanTurnMillis) &&
    isNonNegInt(m.p2Game1MeanTurnMillis) &&
    isNonNegInt(m.p2Game2MeanTurnMillis);
  if (!hasMatchTurnMs && !hasGameTurnMs) {
    throw Object.assign(new Error('Invalid meanTurnMillis telemetry.'), {status: 400});
  }
  if (
    (m.p1MeanTurnMillis !== undefined && !isNonNegInt(m.p1MeanTurnMillis)) ||
    (m.p2MeanTurnMillis !== undefined && !isNonNegInt(m.p2MeanTurnMillis)) ||
    (m.p1Game1MeanTurnMillis !== undefined && !isNonNegInt(m.p1Game1MeanTurnMillis)) ||
    (m.p1Game2MeanTurnMillis !== undefined && !isNonNegInt(m.p1Game2MeanTurnMillis)) ||
    (m.p2Game1MeanTurnMillis !== undefined && !isNonNegInt(m.p2Game1MeanTurnMillis)) ||
    (m.p2Game2MeanTurnMillis !== undefined && !isNonNegInt(m.p2Game2MeanTurnMillis))
  ) {
    throw Object.assign(new Error('Invalid meanTurnMillis telemetry.'), {status: 400});
  }
  const optInitFields = [
    m.p1InitMillis,
    m.p2InitMillis,
    m.p1Game1InitMillis,
    m.p1Game2InitMillis,
    m.p2Game1InitMillis,
    m.p2Game2InitMillis,
  ];
  if (optInitFields.some(v => v !== undefined && !isFiniteNonNeg(v))) {
    throw Object.assign(new Error('Invalid initMillis telemetry.'), {status: 400});
  }
  const optTpFields = [
    m.p1TeamPreviewMillis,
    m.p2TeamPreviewMillis,
    m.p1Game1TeamPreviewMillis,
    m.p1Game2TeamPreviewMillis,
    m.p2Game1TeamPreviewMillis,
    m.p2Game2TeamPreviewMillis,
  ];
  if (optTpFields.some(v => v !== undefined && !isFiniteNonNeg(v))) {
    throw Object.assign(new Error('Invalid teamPreviewMillis telemetry.'), {status: 400});
  }
  if (!isPosInt(m.completedAt)) {
    throw Object.assign(new Error('Invalid match.completedAt.'), {status: 400});
  }

  const p1G1Ram = m.p1Game1PeakRam ?? m.p1PeakRam ?? 0;
  const p1G2Ram = m.p1Game2PeakRam ?? m.p1PeakRam ?? 0;
  const p2G1Ram = m.p2Game1PeakRam ?? m.p2PeakRam ?? 0;
  const p2G2Ram = m.p2Game2PeakRam ?? m.p2PeakRam ?? 0;
  const p1G1InitMs = (m.p1Game1InitMillis as number | undefined) ??
    (m.p1InitMillis as number | undefined) ?? 0;
  const p1G2InitMs = (m.p1Game2InitMillis as number | undefined) ??
    (m.p1InitMillis as number | undefined) ?? 0;
  const p2G1InitMs = (m.p2Game1InitMillis as number | undefined) ??
    (m.p2InitMillis as number | undefined) ?? 0;
  const p2G2InitMs = (m.p2Game2InitMillis as number | undefined) ??
    (m.p2InitMillis as number | undefined) ?? 0;
  const p1G1TpMs = (m.p1Game1TeamPreviewMillis as number | undefined) ??
    (m.p1TeamPreviewMillis as number | undefined);
  const p1G2TpMs = (m.p1Game2TeamPreviewMillis as number | undefined) ??
    (m.p1TeamPreviewMillis as number | undefined);
  const p2G1TpMs = (m.p2Game1TeamPreviewMillis as number | undefined) ??
    (m.p2TeamPreviewMillis as number | undefined);
  const p2G2TpMs = (m.p2Game2TeamPreviewMillis as number | undefined) ??
    (m.p2TeamPreviewMillis as number | undefined);
  const p1G1TurnMs = m.p1Game1MeanTurnMillis ?? m.p1MeanTurnMillis ?? 0;
  const p1G2TurnMs = m.p1Game2MeanTurnMillis ?? m.p1MeanTurnMillis ?? 0;
  const p2G1TurnMs = m.p2Game1MeanTurnMillis ?? m.p2MeanTurnMillis ?? 0;
  const p2G2TurnMs = m.p2Game2MeanTurnMillis ?? m.p2MeanTurnMillis ?? 0;

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
    p1PeakRam: m.p1PeakRam ?? Math.max(p1G1Ram, p1G2Ram),
    p2PeakRam: m.p2PeakRam ?? Math.max(p2G1Ram, p2G2Ram),
    p1Game1PeakRam: p1G1Ram,
    p1Game2PeakRam: p1G2Ram,
    p2Game1PeakRam: p2G1Ram,
    p2Game2PeakRam: p2G2Ram,
    p1Game1BankSeconds: m.p1Game1BankSeconds,
    p1Game2BankSeconds: m.p1Game2BankSeconds,
    p2Game1BankSeconds: m.p2Game1BankSeconds,
    p2Game2BankSeconds: m.p2Game2BankSeconds,
    p1InitMillis: (m.p1InitMillis as number | undefined) ??
      Math.round((p1G1InitMs + p1G2InitMs) / 2),
    p2InitMillis: (m.p2InitMillis as number | undefined) ??
      Math.round((p2G1InitMs + p2G2InitMs) / 2),
    p1Game1InitMillis: p1G1InitMs,
    p1Game2InitMillis: p1G2InitMs,
    p2Game1InitMillis: p2G1InitMs,
    p2Game2InitMillis: p2G2InitMs,
    ...(p1G1TpMs !== undefined ? {p1Game1TeamPreviewMillis: p1G1TpMs} : {}),
    ...(p1G2TpMs !== undefined ? {p1Game2TeamPreviewMillis: p1G2TpMs} : {}),
    ...(p2G1TpMs !== undefined ? {p2Game1TeamPreviewMillis: p2G1TpMs} : {}),
    ...(p2G2TpMs !== undefined ? {p2Game2TeamPreviewMillis: p2G2TpMs} : {}),
    p1MeanTurnMillis: m.p1MeanTurnMillis ?? Math.round((p1G1TurnMs + p1G2TurnMs) / 2),
    p2MeanTurnMillis: m.p2MeanTurnMillis ?? Math.round((p2G1TurnMs + p2G2TurnMs) / 2),
    p1Game1MeanTurnMillis: p1G1TurnMs,
    p1Game2MeanTurnMillis: p1G2TurnMs,
    p2Game1MeanTurnMillis: p2G1TurnMs,
    p2Game2MeanTurnMillis: p2G2TurnMs,
    completedAt: m.completedAt,
  };
}

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_LOG_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.log$/;
const VALID_TOURNAMENT_STAGES = new Set<db.TournamentGameStage>(['Round Robin', 'Superfinal']);
const VALID_TOURNAMENT_STATUSES = new Set<db.TournamentStatus>([
  'scheduled',
  'running',
  'completed',
]);
const SSE_KEEPALIVE_MILLIS = 25_000;
const MAX_TABLE_LINES = 10_000;
const MAX_TOURNAMENT_LOG_BYTES = 512 * 1024;

// Moves staged per-game `.log` files for a `pools` ladder from `public/arena/ladders/.private/<id>`
// (blocked by nginx's dot-path rule while the season is live) into `public/arena/ladders/<id>`
// once the ladder transitions to `status === 'archived'`.
export function promoteArchivedPoolsLogs(publicDir: string, ladderId: string): boolean {
  if (!SAFE_ID_RE.test(ladderId)) return false;
  const privateRoot = path.join(publicDir, 'arena', 'ladders', '.private');
  const stagedDir = path.join(privateRoot, ladderId);
  if (!fs.existsSync(stagedDir)) return false;
  const publicLadderDir = path.join(publicDir, 'arena', 'ladders', ladderId);
  if (!fs.existsSync(publicLadderDir)) {
    fs.mkdirSync(path.dirname(publicLadderDir), {recursive: true});
    try {
      fs.renameSync(stagedDir, publicLadderDir);
      try {
        if (fs.readdirSync(privateRoot).length === 0) fs.rmdirSync(privateRoot);
      } catch {}
      return true;
    } catch {}
  }
  fs.mkdirSync(publicLadderDir, {recursive: true});
  let moved = false;
  for (const name of fs.readdirSync(stagedDir)) {
    if (!SAFE_LOG_FILE_RE.test(name)) continue;
    const src = path.join(stagedDir, name);
    const dst = path.join(publicLadderDir, name);
    if (!fs.existsSync(dst)) {
      fs.renameSync(src, dst);
      moved = true;
    } else {
      fs.rmSync(src, {force: true});
    }
  }
  try {
    fs.rmdirSync(stagedDir);
    if (fs.readdirSync(privateRoot).length === 0) fs.rmdirSync(privateRoot);
  } catch {}
  return moved;
}

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
    pokemon: Array.isArray(obj.pokemon) ? obj.pokemon.slice(0, 6) : undefined,
  };
}

function formatSeriesSummaryPill(
  label: string,
  summary: SeriesGameSummary,
  p1Name?: string,
  p2Name?: string
): string {
  const winner = summary.winnerSlot === 'p1'
    ? escapeHtml(p1Name ?? 'P1')
    : summary.winnerSlot === 'p2'
      ? escapeHtml(p2Name ?? 'P2')
      : 'Tie';
  return `<span class="muted"><tt>${label}</tt>: ${winner} (${summary.turns}t)</span>`;
}

function parseSeriesGameSummary(raw: unknown, label: string): SeriesGameSummary {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw Object.assign(new Error(`Invalid ${label}.`), {status: 400});
  }
  const s = raw as Record<string, unknown>;
  if (s.winnerSlot !== 'p1' && s.winnerSlot !== 'p2' && s.winnerSlot !== undefined) {
    throw Object.assign(
      new Error(`${label}.winnerSlot must be "p1", "p2", or omitted.`),
      {status: 400}
    );
  }
  if (!isNonNegInt(s.turns)) {
    throw Object.assign(
      new Error(`${label}.turns must be a non-negative integer.`),
      {status: 400}
    );
  }
  return {winnerSlot: s.winnerSlot, turns: s.turns};
}

function buildDefaultTableHeaders(tb: BroadcastTable): {left: string; right: string} {
  const left = tb.p1 && tb.p2
    ? `<span class="font-semibold">${escapeHtml(tb.p1.name)}</span>` +
      (tb.p1.version ? ` <span class="ver">v${escapeHtml(tb.p1.version)}</span>` : '') +
      ` vs <span class="font-semibold">${escapeHtml(tb.p2.name)}</span>` +
      (tb.p2.version ? ` <span class="ver">v${escapeHtml(tb.p2.version)}</span>` : '')
    : escapeHtml(tb.label);
  const parts: string[] = [escapeHtml(tb.stage ?? 'Round Robin')];
  if (tb.cycle !== undefined) parts.push(`Cycle ${tb.cycle}`);
  if (tb.bestOf && tb.bestOf > 1) {
    if (tb.matchupGame !== undefined) parts.push(`Match ${tb.matchupGame}`);
    parts.push(`<strong>Game ${tb.game ?? 1} / ${tb.bestOf}</strong>`);
    if (tb.summaries) {
      tb.summaries.forEach((s, idx) => {
        parts.push(formatSeriesSummaryPill(`G${idx + 1}`, s, tb.p1?.name, tb.p2?.name));
      });
    }
  } else if (tb.matchupGame !== undefined) {
    parts.push(`Game ${tb.matchupGame}`);
  }
  parts.push(escapeHtml(tb.label));
  return {left, right: parts.join(' · ')};
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
  const parsePlayer = (val: unknown, label: string): db.TournamentGamePlayer => {
    if (!val || typeof val !== 'object' || Array.isArray(val)) {
      throw Object.assign(new Error(`Invalid game.${label}.`), {status: 400});
    }
    const obj = val as Record<string, unknown>;
    if (!isPosInt(obj.versionId)) {
      throw Object.assign(new Error(`Invalid game.${label}.versionId.`), {status: 400});
    }
    let team: string | undefined;
    if (obj.team !== undefined) {
      if (typeof obj.team !== 'string') {
        throw Object.assign(new Error(`Invalid game.${label}.team.`), {status: 400});
      }
      if (obj.team.trim()) team = obj.team.trim();
    }
    return {versionId: obj.versionId, team};
  };
  const p1 = parsePlayer(g.p1, 'p1');
  const p2 = parsePlayer(g.p2, 'p2');
  if (p1.versionId === p2.versionId) {
    throw Object.assign(
      new Error('game.p1.versionId and game.p2.versionId must be distinct positive integers.'),
      {status: 400}
    );
  }
  if (
    typeof g.outcome !== 'string' ||
    !VALID_GAME_OUTCOMES.has(g.outcome as ratings.GameOutcome)
  ) {
    throw Object.assign(new Error('Invalid game.outcome.'), {status: 400});
  }
  if (g.preemptions !== undefined && !isNonNegInt(g.preemptions)) {
    throw Object.assign(new Error('Invalid game.preemptions.'), {status: 400});
  }
  if (!isPosInt(g.completedAt)) {
    throw Object.assign(new Error('Invalid game.completedAt.'), {status: 400});
  }
  if (!Array.isArray(g.games) || g.games.length === 0) {
    throw Object.assign(
      new Error('game.games must be a non-empty array.'),
      {status: 400}
    );
  }

  const parseGamePlayerStats = (
    val: unknown,
    label: string
  ): db.TournamentGamePlayerStats | undefined => {
    if (val === undefined) return undefined;
    if (!val || typeof val !== 'object' || Array.isArray(val)) {
      throw Object.assign(new Error(`Invalid ${label}.`), {status: 400});
    }
    const s = val as Record<string, unknown>;
    if (s.bankSeconds !== undefined && !isFiniteNonNeg(s.bankSeconds)) {
      throw Object.assign(new Error(`Invalid ${label}.bankSeconds.`), {status: 400});
    }
    if (s.initMillis !== undefined && !isFiniteNonNeg(s.initMillis)) {
      throw Object.assign(new Error(`Invalid ${label}.initMillis.`), {status: 400});
    }
    if (s.teamPreviewMillis !== undefined && !isFiniteNonNeg(s.teamPreviewMillis)) {
      throw Object.assign(new Error(`Invalid ${label}.teamPreviewMillis.`), {status: 400});
    }
    if (s.meanTurnMillis !== undefined && !isFiniteNonNeg(s.meanTurnMillis)) {
      throw Object.assign(new Error(`Invalid ${label}.meanTurnMillis.`), {status: 400});
    }
    if (s.peakRam !== undefined && !isPosInt(s.peakRam)) {
      throw Object.assign(new Error(`Invalid ${label}.peakRam.`), {status: 400});
    }
    return {
      bankSeconds: s.bankSeconds,
      initMillis: s.initMillis,
      teamPreviewMillis: s.teamPreviewMillis,
      meanTurnMillis: s.meanTurnMillis,
      peakRam: s.peakRam,
    };
  };

  const games: db.TournamentGameInput[] = g.games.map((rawGm, idx) => {
    const label = `game.games[${idx}]`;
    if (!rawGm || typeof rawGm !== 'object' || Array.isArray(rawGm)) {
      throw Object.assign(new Error(`Invalid ${label}.`), {status: 400});
    }
    const gm = rawGm as Record<string, unknown>;
    if (gm.gameNumber !== undefined && !isPosInt(gm.gameNumber)) {
      throw Object.assign(new Error(`Invalid ${label}.gameNumber.`), {status: 400});
    }
    if (typeof gm.seed !== 'string' || !gm.seed.trim()) {
      throw Object.assign(new Error(`Invalid ${label}.seed.`), {status: 400});
    }
    if (
      gm.outcome !== undefined &&
      (typeof gm.outcome !== 'string' ||
        !VALID_GAME_OUTCOMES.has(gm.outcome as ratings.GameOutcome))
    ) {
      throw Object.assign(new Error(`Invalid ${label}.outcome.`), {status: 400});
    }
    if (gm.turns !== undefined && !isNonNegInt(gm.turns)) {
      throw Object.assign(new Error(`Invalid ${label}.turns.`), {status: 400});
    }
    if (gm.endReason !== undefined && (typeof gm.endReason !== 'string' || !gm.endReason.trim())) {
      throw Object.assign(new Error(`Invalid ${label}.endReason.`), {status: 400});
    }
    return {
      gameNumber: gm.gameNumber ?? idx + 1,
      seed: gm.seed.trim(),
      outcome: gm.outcome as ratings.GameOutcome | undefined,
      turns: gm.turns,
      endReason: typeof gm.endReason === 'string' ? gm.endReason.trim() : undefined,
      p1: parseGamePlayerStats(gm.p1, `${label}.p1`),
      p2: parseGamePlayerStats(gm.p2, `${label}.p2`),
    };
  });

  return {
    id: g.id.trim(),
    tournamentId,
    stage: g.stage as db.TournamentGameStage,
    cycle: g.cycle,
    matchupGame: g.matchupGame,
    preemptions: g.preemptions,
    outcome: g.outcome as ratings.GameOutcome,
    p1,
    p2,
    games,
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
    broadcastSseFrame(battleStreamClients, event, data);
  };

  const pushTournamentEvent = (tournamentId: string, event: string, data: unknown) => {
    const clients = tournamentStreamClients.get(tournamentId);
    if (!clients) return;
    broadcastSseFrame(clients, event, data);
    if (clients.size === 0) tournamentStreamClients.delete(tournamentId);
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

  if (options.armWatchdogOnStart) {
    armWatchdog(getNowSec());
  }

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
        version: l.version,
        team: l.team,
        min: l.min,
        teams: l.teams,
        status: l.status,
      }));
      const tournaments = db.getTournaments()
        .filter(t => t.status !== 'completed')
        .map(t => {
          const teamPool = resolveTournamentTeamPool(db, t);
          return {
            id: t.id,
            name: t.name,
            format: t.format,
            version: t.version,
            ...(t.team ? {team: t.team} : {}),
            ...(teamPool.length > 0 ? {teamPool} : {}),
            rulesJson: t.rulesJson,
            status: t.status,
            startsAt: t.startsAt,
          };
        });
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
          try {
            authToken = decryptSecret(sub.authTokenEncoding, sessionSecret);
          } catch (decryptErr) {
            console.error(
              `Failed decrypting authToken for pending version ${sub.versionId}:`,
              decryptErr
            );
          }
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
      const smokeInitMillis = optInt(body.smokeInitMillis, 'smokeInitMillis');
      const smokeTeamPreviewMillis = optInt(
        body.smokeTeamPreviewMillis,
        'smokeTeamPreviewMillis'
      );
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
        smokeInitMillis,
        smokeTeamPreviewMillis,
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

      const format = body.format.trim();
      let game1Summary = body.game1Summary !== undefined
        ? parseLiveGameSummary(body.game1Summary, format)
        : undefined;

      let p1 = parseLiveSlot(body.p1, 'p1');
      let p2 = parseLiveSlot(body.p2, 'p2');
      if (p1.pokemon || p2.pokemon) {
        const projected = extractBattlePokemonHealth({
          format,
          p1Pokemon: p1.pokemon,
          p2Pokemon: p2.pokemon,
        });
        if (p1.pokemon) p1 = {...p1, pokemon: projected.p1};
        if (p2.pokemon) p2 = {...p2, pokemon: projected.p2};
      }
      const matchId = body.matchId.trim();
      const ladderId = body.ladderId.trim();
      const ladder = db.getLadder(ladderId);

      if (currentLive?.matchId === matchId && body.heartbeatSeq < currentLive.heartbeatSeq) {
        armWatchdog(nowSec);
        sendJson(res, 200, {ok: true, updatedAt: liveUpdatedAt ?? nowSec});
        return;
      }

      if (game1Summary && currentLive?.matchId === matchId) {
        if (currentLive.game === 1) {
          const prevG1Pokemon = extractBattlePokemonHealth({
            format,
            p1Pokemon: currentLive.p1.pokemon,
            p2Pokemon: currentLive.p2.pokemon,
            finished: true,
          });
          game1Summary = {
            ...game1Summary,
            p1: game1Summary.p1 ?? {
              bankSeconds: currentLive.p1.bankSeconds,
              ...(currentLive.p1.initMillis !== undefined
                ? {initMillis: currentLive.p1.initMillis}
                : {}),
              ...(currentLive.p1.teamPreviewMillis !== undefined
                ? {teamPreviewMillis: currentLive.p1.teamPreviewMillis}
                : {}),
              meanTurnMillis: currentLive.p1.meanTurnMillis,
              ram: currentLive.p1.ram,
              ...(currentLive.p1.team ? {team: currentLive.p1.team} : {}),
              ...(prevG1Pokemon.p1.length > 0 ? {pokemon: prevG1Pokemon.p1} : {}),
            },
            p2: game1Summary.p2 ?? {
              bankSeconds: currentLive.p2.bankSeconds,
              ...(currentLive.p2.initMillis !== undefined
                ? {initMillis: currentLive.p2.initMillis}
                : {}),
              ...(currentLive.p2.teamPreviewMillis !== undefined
                ? {teamPreviewMillis: currentLive.p2.teamPreviewMillis}
                : {}),
              meanTurnMillis: currentLive.p2.meanTurnMillis,
              ram: currentLive.p2.ram,
              ...(currentLive.p2.team ? {team: currentLive.p2.team} : {}),
              ...(prevG1Pokemon.p2.length > 0 ? {pokemon: prevG1Pokemon.p2} : {}),
            },
          };
        } else if (currentLive.game1Summary) {
          game1Summary = {
            ...currentLive.game1Summary,
            ...game1Summary,
            p1: game1Summary.p1 ?? currentLive.game1Summary.p1,
            p2: game1Summary.p2 ?? currentLive.game1Summary.p2,
          };
        }
      }

      let viewer: LiveViewerState | undefined;
      if (body.viewer !== undefined) {
        if (
          !body.viewer ||
          typeof body.viewer !== 'object' ||
          Array.isArray(body.viewer)
        ) {
          sendJson(res, 400, {error: 'Invalid viewer object.'});
          return;
        }
        const rawViewer = body.viewer as Record<string, unknown>;
        if (rawViewer.lines !== undefined && !Array.isArray(rawViewer.lines)) {
          sendJson(res, 400, {error: 'viewer.lines must be an array of strings.'});
          return;
        }
        const lines = Array.isArray(rawViewer.lines)
          ? rawViewer.lines.slice(-MAX_TABLE_LINES).map(l => String(l).slice(0, 4096))
          : [];
        const rawP1 = rawViewer.p1 && typeof rawViewer.p1 === 'object'
          ? (rawViewer.p1 as Record<string, unknown>)
          : undefined;
        const rawP2 = rawViewer.p2 && typeof rawViewer.p2 === 'object'
          ? (rawViewer.p2 as Record<string, unknown>)
          : undefined;
        const rawP1Pokemon = Array.isArray(rawP1?.pokemon) ? rawP1.pokemon : undefined;
        const rawP2Pokemon = Array.isArray(rawP2?.pokemon) ? rawP2.pokemon : undefined;

        const health = extractBattlePokemonHealth({
          lines,
          format,
          p1Pokemon: rawP1Pokemon,
          p2Pokemon: rawP2Pokemon,
        });
        const swapped = isViewerSeatSwapped(lines, body.game, p1.name, p2.name);
        const matchP1Health = swapped ? health.p2 : health.p1;
        const matchP2Health = swapped ? health.p1 : health.p2;
        if (!p1.pokemon && matchP1Health.length > 0) {
          p1 = {...p1, pokemon: matchP1Health};
        }
        if (!p2.pokemon && matchP2Health.length > 0) {
          p2 = {...p2, pokemon: matchP2Health};
        }

        if (ladder?.team === 'random' && lines.length > 0) {
          viewer = normalizeLiveViewer({
            lines,
            p1: rawP1Pokemon ? {pokemon: rawP1Pokemon} : undefined,
            p2: rawP2Pokemon ? {pokemon: rawP2Pokemon} : undefined,
          });
        }
      }

      const phase = body.phase as LivePhase | undefined;
      if (
        phase !== undefined &&
        phase !== 'init' &&
        phase !== 'preview' &&
        phase !== 'battle'
      ) {
        sendJson(res, 400, {error: 'Invalid phase.'});
        return;
      }

      // Preserve the turn start timestamp across mid-turn telemetry heartbeats so spectator
      // countdown clocks don't jump backward if the runner omits turnStartedAt on repeats.
      const sameActiveTurn = (
        currentLive?.matchId === matchId &&
        currentLive.game === body.game &&
        currentLive.phase === phase &&
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
        format,
        game: body.game,
        ...(phase !== undefined ? {phase} : {}),
        turn: body.turn,
        activeSlot: body.activeSlot,
        turnStartedAt,
        turnBudgetSeconds: body.turnBudgetSeconds,
        incrementSeconds: body.incrementSeconds,
        game1Summary,
        p1,
        p2,
        ...(viewer !== undefined ? {viewer} : {}),
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
      const targetLadder = db.getLadder(match.ladderId);
      if (targetLadder?.status === 'upcoming') {
        sendJson(res, 409, {
          error: `Ladder "${match.ladderId}" is upcoming and does not accept completed matches.`,
        });
        return;
      }

      let rawG1Log: string | undefined;
      let rawG2Log: string | undefined;
      for (const [key, val] of [
        ['game1Log', body.game1Log],
        ['game2Log', body.game2Log],
      ] as const) {
        if (val !== undefined) {
          if (typeof val !== 'string') {
            sendJson(res, 400, {error: `${key} must be a string.`});
            return;
          }
          if (Buffer.byteLength(val, 'utf8') > MAX_TOURNAMENT_LOG_BYTES) {
            console.warn(
              `Skipping oversized ${key} on match "${match.id}" (> 512 KiB) while preserving rating`
            );
            continue;
          }
          if (key === 'game1Log') rawG1Log = val;
          else rawG2Log = val;
        }
      }

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

      const {duplicate, archivedLadder} = db.recordCompletedMatch({
        match,
        ladderStatus,
      });

      const ladderRow = db.getLadder(match.ladderId);
      if (
        (ladderRow?.team === 'random' || ladderRow?.team === 'pools') &&
        SAFE_ID_RE.test(match.id)
      ) {
        const isPublic = ladderRow.team === 'random' || ladderRow.status === 'archived';
        if (ladderRow.team === 'pools' && isPublic) {
          if (promoteArchivedPoolsLogs(publicDir, ladderRow.id)) archiveSeq++;
        }
        const ladderDir = isPublic
          ? path.join(publicDir, 'arena', 'ladders', ladderRow.id)
          : path.join(publicDir, 'arena', 'ladders', '.private', ladderRow.id);
        const g1Path = path.join(ladderDir, `${match.id}a.log`);
        const g2Path = path.join(ladderDir, `${match.id}b.log`);
        let wroteLog = false;
        if (rawG1Log !== undefined && (!duplicate || !fs.existsSync(g1Path))) {
          writeFileAtomic(g1Path, rawG1Log.endsWith('\n') ? rawG1Log : `${rawG1Log}\n`);
          wroteLog = true;
        }
        if (rawG2Log !== undefined && (!duplicate || !fs.existsSync(g2Path))) {
          writeFileAtomic(g2Path, rawG2Log.endsWith('\n') ? rawG2Log : `${rawG2Log}\n`);
          wroteLog = true;
        }
        if (wroteLog && isPublic) archiveSeq++;
      }

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
        if (body.tournamentStatus === 'completed' && tournament.status !== 'completed') {
          db.setTournamentStatus(tournament.id, 'completed', nowSec);
        }
        broadcastsByTournament.delete(tournament.id);
        liveSeq++;
        pushTournamentEvent(tournament.id, 'broadcast-end', {
          tournamentId: tournament.id,
          updatedAt: nowSec,
        });
        sendJson(res, 200, {ok: true, updatedAt: nowSec});
        return;
      }

      if (tournament.status === 'completed') {
        sendJson(res, 409, {
          error: `Tournament "${tournament.id}" is already completed.`,
        });
        return;
      }

      if (Array.isArray(body.tables)) {
        if (body.tables.length > 64) {
          sendJson(res, 400, {error: 'tables cannot exceed 64 entries.'});
          return;
        }
        const parsedTables: BroadcastTable[] = body.tables.map((rawTb, tIdx) => {
          if (!rawTb || typeof rawTb !== 'object' || Array.isArray(rawTb)) {
            throw Object.assign(new Error(`Invalid tables[${tIdx}].`), {status: 400});
          }
          const tb = rawTb as Record<string, unknown>;
          const tbNum = isPosInt(tb.table) ? tb.table : tIdx + 1;
          if (tbNum > 64) {
            throw Object.assign(new Error('table cannot exceed 64.'), {status: 400});
          }
          const tbLabel = typeof tb.label === 'string' && tb.label.trim()
            ? tb.label.trim().slice(0, 128)
            : `Table ${tbNum}`;
          const idle = tb.idle === true;
          const tbP1 = tb.p1 !== undefined
            ? parseBroadcastPlayer(tb.p1, `tables[${tIdx}].p1`)
            : undefined;
          const tbP2 = tb.p2 !== undefined
            ? parseBroadcastPlayer(tb.p2, `tables[${tIdx}].p2`)
            : undefined;
          const tbLines = Array.isArray(tb.lines)
            ? tb.lines.slice(-MAX_TABLE_LINES).map(l => String(l).slice(0, 4096))
            : [];
          const built: BroadcastTable = {
            table: tbNum,
            label: tbLabel,
            idle,
            gameId: typeof tb.gameId === 'string' && tb.gameId.trim()
              ? tb.gameId.trim()
              : undefined,
            stage: typeof tb.stage === 'string' &&
              VALID_TOURNAMENT_STAGES.has(tb.stage as db.TournamentGameStage)
              ? (tb.stage as db.TournamentGameStage)
              : undefined,
            cycle: isPosInt(tb.cycle) ? tb.cycle : undefined,
            matchupGame: isPosInt(tb.matchupGame) ? tb.matchupGame : undefined,
            ...(isPosInt(tb.game) ? {game: tb.game} : {}),
            ...(isPosInt(tb.bestOf) ? {bestOf: tb.bestOf} : {}),
            p1: tbP1,
            p2: tbP2,
            lines: tbLines,
            live: idle ? false : (typeof tb.live === 'boolean' ? tb.live : true),
            updatedAt: nowSec,
          };
          const hdr = buildDefaultTableHeaders(built);
          built.seriesLeftHtml = hdr.left;
          built.seriesRightHtml = hdr.right;
          return built;
        });
        const rawBroadcast: LiveBroadcast = {
          tournamentId: tournament.id,
          updatedAt: nowSec,
          tables: parsedTables,
          seriesLeftHtml: '',
          seriesRightHtml: '',
          p1: body.p1
            ? parseBroadcastPlayer(body.p1, 'p1')
            : {name: '—', bankSeconds: 0, thinking: false, incrementSeconds: 10},
          p2: body.p2
            ? parseBroadcastPlayer(body.p2, 'p2')
            : {name: '—', bankSeconds: 0, thinking: false, incrementSeconds: 10},
          lines: Array.isArray(body.lines)
            ? body.lines.slice(-MAX_TABLE_LINES).map(l => String(l).slice(0, 4096))
            : [],
          live: typeof body.live === 'boolean' ? body.live : true,
        };
        const normalized = normalizeLiveBroadcast(rawBroadcast, nowSec);
        broadcastsByTournament.set(tournament.id, normalized);
        liveSeq++;
        pushTournamentEvent(tournament.id, 'broadcast', normalized);
        sendJson(res, 200, {ok: true, updatedAt: nowSec});
        return;
      }

      if (!isPosInt(body.table) || body.table > 64) {
        sendJson(res, 400, {error: 'table must be an integer between 1 and 64.'});
        return;
      }
      const tableNum = body.table;
      const maxTables = Math.min(64, Math.max(tournament.parallelTables, tableNum));
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
      if (mode === 'append') {
        if (!p1.pokemon && prev.p1?.pokemon) p1.pokemon = prev.p1.pokemon;
        if (!p2.pokemon && prev.p2?.pokemon) p2.pokemon = prev.p2.pokemon;
      }
      const incomingLines = Array.isArray(body.lines)
        ? body.lines.slice(-MAX_TABLE_LINES).map(l => String(l).slice(0, 4096))
        : [];

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
      const game = isPosInt(body.game)
        ? body.game
        : (mode === 'append' ? prev.game : undefined);
      const bestOf = isPosInt(body.bestOf)
        ? body.bestOf
        : (mode === 'append' ? prev.bestOf : tournament.bestOf);
      let summaries: SeriesGameSummary[] | undefined;
      if (body.summaries !== undefined) {
        if (!Array.isArray(body.summaries)) {
          sendJson(res, 400, {error: 'Invalid summaries.'});
          return;
        }
        summaries = body.summaries.map((s, i) => parseSeriesGameSummary(s, `summaries[${i}]`));
      } else if (mode === 'append') {
        summaries = prev.summaries;
      }

      const prevLines = prev.lines ?? [];
      const mergedLines = mode === 'append'
        ? [...prevLines, ...incomingLines].slice(-MAX_TABLE_LINES)
        : incomingLines.slice(-MAX_TABLE_LINES);
      const chunkPersp = mode === 'append' ? extractPerspectiveLogs(incomingLines) : undefined;
      const canAppendPersp = Boolean(
        chunkPersp &&
        prev.p1Lines &&
        prev.p2Lines &&
        prevLines.length + incomingLines.length <= MAX_TABLE_LINES &&
        !incomingLines[incomingLines.length - 1]?.startsWith('|split|')
      );
      const mergedPersp = canAppendPersp && chunkPersp
        ? {
          p1Lines: [...prev.p1Lines!, ...chunkPersp.p1Lines],
          p2Lines: [...prev.p2Lines!, ...chunkPersp.p2Lines],
        }
        : extractPerspectiveLogs(mergedLines);

      const nextTable: BroadcastTable = {
        table: tableNum,
        label,
        idle: false,
        gameId,
        stage,
        cycle,
        matchupGame,
        ...(game !== undefined ? {game} : {}),
        ...(bestOf !== undefined && bestOf > 1 ? {bestOf} : {}),
        ...(summaries !== undefined ? {summaries} : {}),
        p1,
        p2,
        lines: mergedLines,
        p1Lines: mergedPersp.p1Lines,
        p2Lines: mergedPersp.p2Lines,
        live: typeof body.live === 'boolean' ? body.live : true,
        updatedAt: nowSec,
      };
      const defaults = buildDefaultTableHeaders(nextTable);
      nextTable.seriesLeftHtml = mode === 'append' && prev.seriesLeftHtml
        ? prev.seriesLeftHtml
        : defaults.left;
      nextTable.seriesRightHtml = mode === 'append' && prev.seriesRightHtml
        ? prev.seriesRightHtml
        : defaults.right;

      if (idx >= 0) tables[idx] = nextTable;
      else tables.push(nextTable);
      const normalized = normalizeLiveBroadcast({...existing, updatedAt: nowSec, tables}, nowSec);
      broadcastsByTournament.set(tournament.id, normalized);
      liveSeq++;

      if (mode === 'append' && chunkPersp) {
        pushTournamentEvent(tournament.id, 'table-append', {
          table: tableNum,
          lines: incomingLines,
          p1Lines: chunkPersp.p1Lines,
          p2Lines: chunkPersp.p2Lines,
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
        if (
          (tournament.status === 'completed' && nextStatus !== 'completed') ||
          (tournament.status === 'running' && nextStatus === 'scheduled')
        ) {
          sendJson(res, 409, {
            error: `Cannot regress tournament status from "${tournament.status}" ` +
              `to "${nextStatus}".`,
          });
          return;
        }
      }

      const parseLogField = (raw: unknown, field: string): string | undefined => {
        if (raw === undefined) return undefined;
        if (typeof raw !== 'string') {
          throw Object.assign(new Error(`${field} must be a string.`), {status: 400});
        }
        if (Buffer.byteLength(raw, 'utf8') > MAX_TOURNAMENT_LOG_BYTES) {
          throw Object.assign(
            new Error(`Tournament game ${field} exceeds 512 KiB limit.`),
            {status: 413}
          );
        }
        return raw;
      };
      const rawLog = parseLogField(body.log, 'log');
      let rawLogs: string[] | undefined;
      if (body.logs !== undefined) {
        if (!Array.isArray(body.logs) || body.logs.length > 9) {
          throw Object.assign(
            new Error('logs must be an array of at most 9 strings.'),
            {status: 400}
          );
        }
        rawLogs = body.logs.map((entry, idx) => parseLogField(entry, `logs[${idx}]`) ?? '');
      }

      const {duplicate} = db.recordCompletedTournamentGame(game);

      const tourDir = path.join(publicDir, 'arena', 'tournaments', tournament.id);
      const writeLogIfNeeded = (fileName: string, content: string | undefined) => {
        if (content === undefined) return;
        const p = path.join(tourDir, fileName);
        if (!duplicate || !fs.existsSync(p)) {
          writeFileAtomic(p, content.endsWith('\n') ? content : `${content}\n`);
        }
      };
      if (rawLogs) {
        if (rawLogs.length === 1 && game.games.length <= 1) {
          writeLogIfNeeded(`${game.id}.log`, rawLogs[0]);
        } else {
          rawLogs.forEach((content, idx) => {
            writeLogIfNeeded(`${game.id}-g${idx + 1}.log`, content);
          });
        }
      }
      writeLogIfNeeded(`${game.id}.log`, rawLog);

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
          const lastGame = game.games[game.games.length - 1];
          const tables = existing.tables.map(tb => {
            if ((tableNum && tb.table === tableNum) || (tb.gameId && tb.gameId === game.id)) {
              return {
                ...tb,
                live: false,
                p1: tb.p1
                  ? {
                    ...tb.p1,
                    thinking: false,
                    bankSeconds: lastGame?.p1?.bankSeconds ?? tb.p1.bankSeconds,
                  }
                  : undefined,
                p2: tb.p2
                  ? {
                    ...tb.p2,
                    thinking: false,
                    bankSeconds: lastGame?.p2?.bankSeconds ?? tb.p2.bankSeconds,
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
        gameLogHrefs: enrichedGame?.games.map(gm => gm.logHref),
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
    if (ladder.team !== 'pools' && ladder.team !== 'random') {
      req.resume();
      sendJson(res, 400, {
        error:
          'Full battle log archives are only published for random or team-pool (pools) ladders.',
      });
      return;
    }
    if (ladder.team === 'pools' && ladder.status !== 'archived') {
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

    const fileName = `${ladder.id}-logs.tar`;
    const destPath = path.join(publicDir, 'arena', 'ladders', ladder.id, fileName);
    try {
      if (ladder.team === 'pools') {
        promoteArchivedPoolsLogs(publicDir, ladder.id);
      }
      const {bytes, sha256} = await streamBinaryArchive(req, destPath, expectedSha);
      archiveSeq++;
      await Promise.resolve(options.onUpdate?.('archive-published'));
      const idEnc = encodeURIComponent(ladder.id);
      sendJson(res, 200, {
        ok: true,
        ladderId: ladder.id,
        archiveHref: `/arena/ladders/${idEnc}/${encodeURIComponent(fileName)}`,
        ...(ladder.team === 'pools' ? {teamsHref: `/arena/ladders/${idEnc}/teams.json`} : {}),
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
        version: l.version,
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

    const unpublishedArchivedPoolsLadders = db.getLadders()
      .filter(l => {
        if (l.team !== 'pools' || l.status !== 'archived') return false;
        promoteArchivedPoolsLogs(publicDir, l.id);
        return !resolveLadderArchive(publicDir, l);
      })
      .map(l => l.id);

    sendJson(res, 200, {ladders, unpublishedArchivedPoolsLadders});
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

    const games = db.getTournamentGames(tournament.id, 1_000_000).map(g => ({
      id: g.id,
      stage: g.stage,
      cycle: g.cycle,
      matchupGame: g.matchupGame,
      p1: {versionId: g.p1.versionId, ...(g.p1.team ? {team: g.p1.team} : {})},
      p2: {versionId: g.p2.versionId, ...(g.p2.team ? {team: g.p2.team} : {})},
      ...(g.outcome !== undefined ? {outcome: g.outcome} : {}),
      games: g.games,
    }));

    const teamPool = resolveTournamentTeamPool(db, tournament);

    sendJson(res, 200, {
      tournament: {
        id: tournament.id,
        name: tournament.name,
        format: tournament.format,
        version: tournament.version,
        ...(tournament.team ? {team: tournament.team} : {}),
        customRules,
        bestOf: tournament.bestOf,
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
      if (entry.startsWith('.')) continue;
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
    if (!Number.isSafeInteger(parsedPage) || parsedPage < 1 || parsedPage > 100_000) {
      sendJson(res, 400, {error: 'page must be an integer between 1 and 100000.'});
      return;
    }

    const rawLimit = parsedUrl.searchParams.get('limit');
    const parsedLimit = rawLimit ? Number(rawLimit) : recentLimit;
    if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      sendJson(res, 400, {error: 'limit must be an integer between 1 and 100.'});
      return;
    }

    const ladderId = parsedUrl.searchParams.get('ladder')?.trim() || undefined;
    const agentSlug = parsedUrl.searchParams.get('agent')?.trim() || undefined;
    const agentVersion = parsedUrl.searchParams.get('version')?.trim() || undefined;
    const opponentSlug = parsedUrl.searchParams.get('vs')?.trim() || undefined;
    const offset = (parsedPage - 1) * parsedLimit;
    const countsBySlot = db.getMatchCountsBySlot();
    const {matches, total} = db.getMatchesPage({
      slot: rawSlot,
      ladderId,
      agentSlug,
      agentVersion,
      opponentSlug,
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
      agentVersion,
      opponentSlug,
      countsBySlot,
      matches: matches.map(m => enrichMatchView(publicDir, m)),
    });
  };

  app.get('/api/battles.json', handleBattlesHistory);
  app.get('/api/battles', handleBattlesHistory);

  return {
    close: closeAll,
    getLiveDocument,
    setLiveState: state => {
      if (state.live) {
        const {viewer: rawViewer, ...rest} = state.live;
        const normalizedViewer = normalizeLiveViewer(rawViewer);
        let p1 = rest.p1;
        let p2 = rest.p2;
        if (p1.pokemon || p2.pokemon) {
          const projected = extractBattlePokemonHealth({
            format: rest.format,
            p1Pokemon: p1.pokemon,
            p2Pokemon: p2.pokemon,
          });
          if (p1.pokemon) p1 = {...p1, pokemon: projected.p1};
          if (p2.pokemon) p2 = {...p2, pokemon: projected.p2};
        }
        let game1Summary = rest.game1Summary;
        if (game1Summary && (game1Summary.p1?.pokemon || game1Summary.p2?.pokemon)) {
          const g1Proj = extractBattlePokemonHealth({
            format: rest.format,
            p1Pokemon: game1Summary.p1?.pokemon,
            p2Pokemon: game1Summary.p2?.pokemon,
            finished: true,
          });
          game1Summary = {
            ...game1Summary,
            ...(game1Summary.p1
              ? {
                p1: {
                  ...game1Summary.p1,
                  ...(game1Summary.p1.pokemon ? {pokemon: g1Proj.p1} : {}),
                },
              }
              : {}),
            ...(game1Summary.p2
              ? {
                p2: {
                  ...game1Summary.p2,
                  ...(game1Summary.p2.pokemon ? {pokemon: g1Proj.p2} : {}),
                },
              }
              : {}),
          };
        }
        if (rawViewer && (!p1.pokemon || !p2.pokemon)) {
          const health = extractBattlePokemonHealth({
            lines: rawViewer.lines,
            format: rest.format,
            p1Pokemon: rawViewer.p1?.pokemon,
            p2Pokemon: rawViewer.p2?.pokemon,
          });
          const swapped = isViewerSeatSwapped(
            rawViewer.lines ?? [],
            rest.game,
            p1.name,
            p2.name
          );
          const matchP1Health = swapped ? health.p2 : health.p1;
          const matchP2Health = swapped ? health.p1 : health.p2;
          if (!p1.pokemon && matchP1Health.length > 0) p1 = {...p1, pokemon: matchP1Health};
          if (!p2.pokemon && matchP2Health.length > 0) p2 = {...p2, pokemon: matchP2Health};
        }
        currentLive = {
          ...rest,
          ...(game1Summary !== undefined ? {game1Summary} : {}),
          p1,
          p2,
          ...(normalizedViewer !== undefined ? {viewer: normalizedViewer} : {}),
        };
      } else {
        currentLive = undefined;
      }
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
