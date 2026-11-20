import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

import {extractChannelMessages} from '@pkmn/sim';
import polka from 'polka';

import type * as db from '../db';
import {
  escapeHtml,
  installHeadSupport,
  readBody,
  root,
  toID,
  writeFileAtomic,
} from '../static/util';

import {decryptSecret} from './account';
import {Auth} from './auth';
import * as ratings from './ratings';
import * as simOps from './sim-ops';

export const PUBLIC_DIR = root('public');
// If the Mac Mini Arena worker stops heartbeating for 15 minutes (network drop, power loss,
// or wedged supervisor), mark public/api/live.json stale so spectators aren't shown a frozen
// turn clock and alert staff on Discord.
export const WATCHDOG_TIMEOUT_MILLIS = 15 * 60 * 1000;
export const STARTING_BANK_SECONDS = simOps.STARTING_BANK_SECONDS;
export const STARTING_GRACE_SECONDS = simOps.STARTING_GRACE_SECONDS;
export const READY_GRACE_SECONDS = 60;
export const MAX_TURN_SECONDS = simOps.MAX_TURN_SECONDS;
export const MID_TURN_INCREMENT_SECONDS = simOps.MID_TURN_INCREMENT_SECONDS;
export const SINGLES_INCREMENT_SECONDS = simOps.SINGLES_INCREMENT_SECONDS;
export const DOUBLES_INCREMENT_SECONDS = simOps.DOUBLES_INCREMENT_SECONDS;
export const VGC_STARTING_BANK_SECONDS = simOps.VGC_STARTING_BANK_SECONDS;
export const VGC_GRACE_SECONDS = simOps.VGC_GRACE_SECONDS;
export const VGC_MAX_TURN_SECONDS = simOps.VGC_MAX_TURN_SECONDS;
export const VGC_MAX_FIRST_TURN_SECONDS = simOps.VGC_MAX_FIRST_TURN_SECONDS;
export const MAX_BATTLE_TURNS = 1000;

export type TimerSettings = simOps.TimerSettings;

function decodeRouteParam(param: string | string[] | undefined): string {
  if (typeof param !== 'string' || !param) return '';
  try {
    return decodeURIComponent(param).trim();
  } catch {
    return param.trim();
  }
}

export function timerSettingsForFormat(format: string): TimerSettings {
  const id = toID(format);
  if (id.includes('vgc') || id.includes('bss') || id.includes('vgctimer')) {
    return {
      startingSeconds: VGC_STARTING_BANK_SECONDS,
      graceSeconds: VGC_GRACE_SECONDS,
      addPerTurnSeconds: 0,
      midTurnIncrementSeconds: 0,
      maxPerTurnSeconds: VGC_MAX_TURN_SECONDS,
      maxFirstTurnSeconds: VGC_MAX_FIRST_TURN_SECONDS,
      timeoutAutoChoose: true,
      accelerate: false,
    };
  }
  const addPerTurnSeconds = id.includes('doubles')
    ? DOUBLES_INCREMENT_SECONDS
    : SINGLES_INCREMENT_SECONDS;
  return {
    startingSeconds: STARTING_BANK_SECONDS,
    graceSeconds: STARTING_GRACE_SECONDS,
    addPerTurnSeconds,
    midTurnIncrementSeconds: MID_TURN_INCREMENT_SECONDS,
    maxPerTurnSeconds: MAX_TURN_SECONDS,
    maxFirstTurnSeconds: MAX_TURN_SECONDS,
    timeoutAutoChoose: false,
    accelerate: true,
  };
}

export function turnIncrementSeconds(format: string): number {
  return timerSettingsForFormat(format).addPerTurnSeconds;
}

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const RECENT_MATCHES_LIMIT = 25;

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
  const name = `${ladder.id}-logs.tar`;
  const diskPath = path.join(publicDir, 'arena', 'ladders', ladder.id, name);
  if (!fs.existsSync(diskPath)) return undefined;
  return {
    name,
    href: `/arena/ladders/${encodeURIComponent(ladder.id)}/${encodeURIComponent(name)}`,
  };
}

export function resolveTournamentArchive(
  publicDir: string,
  tournamentId: string
): {name: string; href: string} | undefined {
  const name = `${tournamentId}-replays.7z`;
  const diskPath = path.join(publicDir, 'arena', 'tournaments', tournamentId, name);
  if (!fs.existsSync(diskPath)) return undefined;
  return {
    name,
    href: `/arena/tournaments/${encodeURIComponent(tournamentId)}/${encodeURIComponent(name)}`,
  };
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
  return pool;
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
  const rules = tournament.rules;

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
  now?: () => number;
  onSubmissionStatus?: (result: db.ApplySubmissionStatusResult) => void | Promise<void>;
  onWatchdogTimeout?: (alert: WatchdogAlert) => void | Promise<void>;
  onUpdate?: (
    reason:
      'submission-status' |
      'match-complete' |
      'archive-published' |
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
  customRules: string[];
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

export interface LadderTeamsResponse {
  ladderId: string;
  format: string;
  count: number;
  sha256: string;
  teams: string[];
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
  };

export interface TournamentGameCompletePayload {
  game: Omit<db.CompletedTournamentGamePayload, 'tournamentId'>;
  table?: number;
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

function validateControlPlaneServerUrl(rawUrl: string): string {
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
  if (!isLoopback && process.env.ARENA_DEV !== '1') {
    throw new Error(
      `Refusing cleartext HTTP control-plane URL "${trimmed}" (use https:// or loopback tunnel)`
    );
  }
  return trimmed;
}

const CLIENT_TIMEOUT_MILLIS = 30_000;
const UPLOAD_TIMEOUT_MILLIS = 300_000;

// Outbound worker control-plane HTTP client used by the Mac Mini Arena coordinator (and `--server`
// mock scenarios) to communicate with `/api/arena/*` using `Bearer $ARENA_SECRET`.
export class Client {
  readonly serverUrl: string;
  private readonly arenaSecret: string;

  constructor(options: ClientOptions) {
    this.serverUrl = validateControlPlaneServerUrl(options.serverUrl);
    this.arenaSecret = options.arenaSecret;
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
    const res = await fetch(`${this.serverUrl}${endpoint}`, {
      method,
      headers,
      body: serialized,
      signal: AbortSignal.timeout(CLIENT_TIMEOUT_MILLIS),
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
    const res = await fetch(`${this.serverUrl}${endpoint}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${this.arenaSecret}`,
        'content-type': contentType,
        'x-content-sha256': digest,
      },
      body: bodyView as unknown as BodyInit,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MILLIS),
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

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  const raw = await readBody(req, MAX_BODY_BYTES, 'Request body exceeds 1 MB limit.');
  try {
    return (raw ? JSON.parse(raw) : {}) as T;
  } catch {
    throw Object.assign(new Error('Invalid JSON request body.'), {status: 400});
  }
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

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_LOG_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.log$/;
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

// Projects raw `@pkmn/sim` party telemetry into anti-scouting `{percent, color}` health pips and
// strips spectator log lines on non-`random` ladders so private/harvested sets are never exposed.
function sanitizeLiveMatch(
  input: LiveMatchInput,
  allowViewer: boolean,
  slot?: db.LadderSlot
): LiveMatch {
  const {viewer: rawViewer, game1Summary: rawG1, ...rest} = input;
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

  let game1Summary: LiveGameSummary | undefined;
  if (rawG1) {
    const {viewer: g1Viewer, ...g1Rest} = rawG1;
    let g1P1 = g1Rest.p1;
    let g1P2 = g1Rest.p2;
    if (g1Viewer) {
      const g1Health = extractBattlePokemonHealth({
        lines: g1Viewer.lines ?? [],
        format: rest.format,
        p1Pokemon: g1Viewer.p1?.pokemon,
        p2Pokemon: g1Viewer.p2?.pokemon,
        finished: true,
      });
      if (g1P1 && !g1P1.pokemon && g1Health.p1.length > 0) g1P1 = {...g1P1, pokemon: g1Health.p1};
      if (g1P2 && !g1P2.pokemon && g1Health.p2.length > 0) g1P2 = {...g1P2, pokemon: g1Health.p2};
    }
    if (g1P1?.pokemon || g1P2?.pokemon) {
      const projected = extractBattlePokemonHealth({
        format: rest.format,
        p1Pokemon: g1P1?.pokemon,
        p2Pokemon: g1P2?.pokemon,
        finished: true,
      });
      if (g1P1?.pokemon) g1P1 = {...g1P1, pokemon: projected.p1};
      if (g1P2?.pokemon) g1P2 = {...g1P2, pokemon: projected.p2};
    }
    game1Summary = {
      ...g1Rest,
      ...(g1P1 !== undefined ? {p1: g1P1} : {}),
      ...(g1P2 !== undefined ? {p2: g1P2} : {}),
    };
  }

  let viewer: LiveViewerState | undefined;
  if (rawViewer) {
    const lines = rawViewer.lines?.slice(-MAX_TABLE_LINES) ?? [];
    const health = extractBattlePokemonHealth({
      lines,
      format: rest.format,
      p1Pokemon: rawViewer.p1?.pokemon,
      p2Pokemon: rawViewer.p2?.pokemon,
    });
    const swapped = isViewerSeatSwapped(lines, rest.game, p1.name, p2.name);
    const matchP1Health = swapped ? health.p2 : health.p1;
    const matchP2Health = swapped ? health.p1 : health.p2;
    if (!p1.pokemon && matchP1Health.length > 0) p1 = {...p1, pokemon: matchP1Health};
    if (!p2.pokemon && matchP2Health.length > 0) p2 = {...p2, pokemon: matchP2Health};
    if (allowViewer && lines.length > 0) {
      viewer = normalizeLiveViewer({
        lines,
        p1: rawViewer.p1?.pokemon ? {pokemon: rawViewer.p1.pokemon} : undefined,
        p2: rawViewer.p2?.pokemon ? {pokemon: rawViewer.p2.pokemon} : undefined,
      });
    }
  }

  return {
    ...rest,
    slot: slot ?? rest.slot,
    ...(game1Summary !== undefined ? {game1Summary} : {}),
    p1,
    p2,
    ...(viewer !== undefined ? {viewer} : {}),
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
    options.arenaSecret ?? process.env.ARENA_SECRET;

  const getSessionSecret = (): string | undefined =>
    options.sessionSecret ?? options.auth?.getConfig()?.sessionSecret ?? process.env.SESSION_SECRET;

  const getLiveDocument = (nowSec = getNowSec()): LiveDocument => {
    const countsBySlot = db.getMatchCountsBySlot();
    const recentMatches = db.getRecentMatches(RECENT_MATCHES_LIMIT)
      .map(m => enrichMatchView(publicDir, m));
    return {
      updatedAt: liveUpdatedAt ?? nowSec,
      stale: liveStale,
      live: liveStale ? undefined : currentLive,
      runningTournament: getRunningTournamentInfo(),
      pageSize: RECENT_MATCHES_LIMIT,
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

  // `/api/arena/*` is a trusted internal control plane authenticated by `ARENA_SECRET` where both
  // the server and the Mac mini / GCP Arena coordinators live in this repo and share TypeScript
  // wire types. Routes intentionally omit defensive field-by-field schema parsers on authenticated
  // payloads, enforcing only Bearer auth, body caps, lifecycle gates, `SAFE_ID_RE` path guards,
  // SHA-256 archive checks, and `pools` log/viewer privacy sanitization.
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
            customRules: t.rules,
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

    try {
      const body = await readJsonBody<SubmissionStatusPayload>(req);
      const result = db.applySubmissionStatus({
        ...body,
        smokeError: body.smokeError?.slice(0, 16_384),
        now: getNowSec(),
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

    const nowSec = getNowSec();
    try {
      const body = await readJsonBody<HeartbeatPayload>(req);
      if ('idle' in body && body.idle === true) {
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

      const frame = body as LiveMatchInput;
      if (currentLive?.matchId === frame.matchId && frame.heartbeatSeq < currentLive.heartbeatSeq) {
        armWatchdog(nowSec);
        sendJson(res, 200, {ok: true, updatedAt: liveUpdatedAt ?? nowSec});
        return;
      }

      const ladder = db.getLadder(frame.ladderId);
      const sameActiveTurn = (
        currentLive?.matchId === frame.matchId &&
        currentLive.game === frame.game &&
        currentLive.phase === frame.phase &&
        currentLive.turn === frame.turn &&
        currentLive.activeSlot === frame.activeSlot
      );
      const turnStartedAt = frame.turnStartedAt && frame.turnStartedAt > 0
        ? frame.turnStartedAt
        : sameActiveTurn
          ? currentLive!.turnStartedAt
          : nowSec;

      currentLive = sanitizeLiveMatch(
        {...frame, turnStartedAt},
        ladder?.team === 'random',
        ladder?.slot
      );
      lastMatchId = frame.matchId;
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

    try {
      const body = await readJsonBody<MatchCompletePayload>(req);
      const match = body.match;
      if (!match?.id || !match.ladderId) {
        sendJson(res, 400, {error: 'Invalid match payload.'});
        return;
      }
      const targetLadder = db.getLadder(match.ladderId);
      if (targetLadder?.status === 'upcoming') {
        sendJson(res, 409, {
          error: `Ladder "${match.ladderId}" is upcoming and does not accept completed matches.`,
        });
        return;
      }

      const checkLog = (key: string, val?: string) => {
        if (val === undefined) return undefined;
        if (Buffer.byteLength(val, 'utf8') > MAX_TOURNAMENT_LOG_BYTES) {
          console.warn(
            `Skipping oversized ${key} on match "${match.id}" (> 512 KiB) while preserving rating`
          );
          return undefined;
        }
        return val;
      };
      const rawG1Log = checkLog('game1Log', body.game1Log);
      const rawG2Log = checkLog('game2Log', body.game2Log);

      const {duplicate, archivedLadder} = db.recordCompletedMatch({match});

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

    const nowSec = getNowSec();
    try {
      const body = await readJsonBody<TournamentBroadcastPayload>(req);
      if ('off' in body && body.off === true) {
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

      const tableUpdate = body as Exclude<TournamentBroadcastPayload, {off: true}>;
      const tableNum = tableUpdate.table;
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
      const label = tableUpdate.label?.trim() || prev.label;

      if ('idle' in tableUpdate && tableUpdate.idle === true) {
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

      const active = tableUpdate as Extract<TournamentBroadcastPayload, {mode?: 'load' | 'append'}>;
      const mode = active.mode === 'append' ? 'append' : 'load';
      const p1 = active.p1 ? {...active.p1} : prev.p1!;
      const p2 = active.p2 ? {...active.p2} : prev.p2!;
      if (mode === 'append') {
        if (!p1.pokemon && prev.p1?.pokemon) p1.pokemon = prev.p1.pokemon;
        if (!p2.pokemon && prev.p2?.pokemon) p2.pokemon = prev.p2.pokemon;
      }
      const incomingLines = active.lines?.slice(-MAX_TABLE_LINES) ?? [];
      const stage = active.stage ?? prev.stage;
      const cycle = active.cycle ?? (mode === 'append' ? prev.cycle : undefined);
      const matchupGame = active.matchupGame ?? (mode === 'append' ? prev.matchupGame : undefined);
      const gameId = active.gameId ?? (mode === 'append' ? prev.gameId : undefined);
      const game = active.game ?? (mode === 'append' ? prev.game : undefined);
      const bestOf = active.bestOf ?? (mode === 'append' ? prev.bestOf : tournament.bestOf);
      const summaries = active.summaries ?? (mode === 'append' ? prev.summaries : undefined);

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
        live: active.live ?? true,
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

    try {
      const body = await readJsonBody<TournamentGameCompletePayload>(req);
      const game: db.CompletedTournamentGamePayload = {
        ...body.game,
        tournamentId: tournament.id,
      };

      const nextStatus = body.tournamentStatus;
      if (
        nextStatus !== undefined &&
        ((tournament.status === 'completed' && nextStatus !== 'completed') ||
          (tournament.status === 'running' && nextStatus === 'scheduled'))
      ) {
        sendJson(res, 409, {
          error: `Cannot regress tournament status from "${tournament.status}" ` +
            `to "${nextStatus}".`,
        });
        return;
      }

      if (body.logs) {
        for (const entry of body.logs) {
          if (Buffer.byteLength(entry, 'utf8') > MAX_TOURNAMENT_LOG_BYTES) {
            sendJson(res, 413, {error: 'Tournament game log exceeds 512 KiB limit.'});
            return;
          }
        }
      }

      const {duplicate} = db.recordCompletedTournamentGame(game);

      const tourDir = path.join(publicDir, 'arena', 'tournaments', tournament.id);
      const writeLogIfNeeded = (fileName: string, content: string) => {
        const p = path.join(tourDir, fileName);
        if (!duplicate || !fs.existsSync(p)) {
          writeFileAtomic(p, content.endsWith('\n') ? content : `${content}\n`);
        }
      };
      if (body.logs) {
        if (body.logs.length === 1 && game.games.length <= 1) {
          writeLogIfNeeded(`${game.id}.log`, body.logs[0]);
        } else {
          body.logs.forEach((content, idx) => {
            writeLogIfNeeded(`${game.id}-g${idx + 1}.log`, content);
          });
        }
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
          const tableNum = body.table;
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
      // On a `settling` `pools` ladder, retain all locked seasonal rosters in `agent_ladder_teams`
      // (matching `canSettleLadder`) so 2-3 remaining active agents can finish settling without
      // deadlocking when another competitor is quarantined or disabled.
      const roster = l.team === 'pools'
        ? db.getActiveRosterForLadder(l.id)
          .filter(r => l.status === 'settling' || playableAgents.has(r.agentId))
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

    const customRules = tournament.rules;

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
    const parsedLimit = rawLimit ? Number(rawLimit) : RECENT_MATCHES_LIMIT;
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

  return {
    close: closeAll,
    getLiveDocument,
    setLiveState: state => {
      currentLive = state.live ? sanitizeLiveMatch(state.live, true) : undefined;
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
    getState: () => ({
      lastSeenAt,
      watchdogTriggered,
      live: currentLive,
      liveSeq,
      archiveSeq,
    }),
  };
}
