import {DatabaseSync} from 'node:sqlite';

import * as ratings from '../server/ratings';

import {recomputeTournamentStandings} from './tournament-entrants';
import * as tournamentGames from './tournament-games';
import {getTournament} from './tournaments';

import {TransactionRunner} from './index';

export type TournamentGameStage = 'Round Robin' | 'Superfinal';
export type TournamentGameStatus = 'pending' | 'running' | 'completed';

export interface TournamentGamePlayer {
  versionId: number;
  team?: string;
}

export interface TournamentGamePlayerView extends TournamentGamePlayer {
  slug: string;
  name: string;
  version: string;
}

export interface TournamentMatchRow {
  id: string;
  tournamentId: string;
  stage: TournamentGameStage;
  cycle: number;
  matchupGame: number;
  status: TournamentGameStatus;
  preemptions: number;
  outcome?: ratings.GameOutcome;
  p1: TournamentGamePlayer;
  p2: TournamentGamePlayer;
  games: tournamentGames.TournamentGameRow[];
  completedAt?: number;
}

export interface TournamentGameView extends TournamentMatchRow {
  p1: TournamentGamePlayerView;
  p2: TournamentGamePlayerView;
}

export interface TournamentPairRecord {
  lowVersionId: number;
  highVersionId: number;
  lowWins: number;
  highWins: number;
  ties: number;
}

export interface UpsertTournamentGameInput {
  id: string;
  tournamentId: string;
  stage?: TournamentGameStage;
  cycle: number;
  matchupGame: number;
  status?: TournamentGameStatus;
  preemptions?: number;
  outcome?: ratings.GameOutcome;
  p1: TournamentGamePlayer;
  p2: TournamentGamePlayer;
  games?: readonly tournamentGames.TournamentGameInput[];
  completedAt?: number;
}

export interface CompletedTournamentGamePayload {
  id: string;
  tournamentId: string;
  stage?: TournamentGameStage;
  cycle: number;
  matchupGame: number;
  preemptions?: number;
  outcome: ratings.GameOutcome;
  p1: TournamentGamePlayer;
  p2: TournamentGamePlayer;
  games: readonly tournamentGames.TournamentGameInput[];
  completedAt: number;
}

export function upsertTournamentGame(db: DatabaseSync, input: UpsertTournamentGameInput) {
  db.prepare(
    `
    INSERT INTO tournament_matches (
      id, tournament_id, stage, cycle, matchup_game,
      p1_version_id, p2_version_id, status, preemptions,
      p1_team, p2_team, outcome, completed_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      stage = excluded.stage,
      cycle = excluded.cycle,
      matchup_game = excluded.matchup_game,
      p1_version_id = excluded.p1_version_id,
      p2_version_id = excluded.p2_version_id,
      status = excluded.status,
      preemptions = excluded.preemptions,
      p1_team = excluded.p1_team,
      p2_team = excluded.p2_team,
      outcome = excluded.outcome,
      completed_at = excluded.completed_at
    `
  ).run(
    input.id,
    input.tournamentId,
    input.stage ?? 'Round Robin',
    input.cycle,
    input.matchupGame,
    input.p1.versionId,
    input.p2.versionId,
    input.status ?? 'pending',
    input.preemptions ?? 0,
    input.p1.team ?? null,
    input.p2.team ?? null,
    input.outcome ?? null,
    input.completedAt ?? null
  );

  if (input.games !== undefined) {
    tournamentGames.replaceTournamentMatchGames(db, input.id, input.games);
  }
}

function mapTournamentGameView(
  r: Record<string, unknown>,
  games: tournamentGames.TournamentGameRow[]
): TournamentGameView {
  return {
    id: r.id as string,
    tournamentId: r.tournament_id as string,
    stage: r.stage as TournamentGameStage,
    cycle: r.cycle as number,
    matchupGame: r.matchup_game as number,
    status: r.status as TournamentGameStatus,
    preemptions: r.preemptions as number,
    outcome: (r.outcome as ratings.GameOutcome | null) ?? undefined,
    p1: {
      versionId: r.p1_version_id as number,
      slug: r.p1_slug as string,
      name: r.p1_name as string,
      version: r.p1_version as string,
      team: (r.p1_team as string | null) ?? undefined,
    },
    p2: {
      versionId: r.p2_version_id as number,
      slug: r.p2_slug as string,
      name: r.p2_name as string,
      version: r.p2_version as string,
      team: (r.p2_team as string | null) ?? undefined,
    },
    games,
    completedAt: (r.completed_at as number | null) ?? undefined,
  };
}

export function getTournamentGame(
  db: DatabaseSync,
  matchId: string
): TournamentGameView | undefined {
  const row = db
    .prepare(
      `
      SELECT
        tm.*,
        a1.slug AS p1_slug,
        a1.name AS p1_name,
        v1.version AS p1_version,
        a2.slug AS p2_slug,
        a2.name AS p2_name,
        v2.version AS p2_version
      FROM tournament_matches tm
      JOIN agent_versions v1 ON v1.id = tm.p1_version_id
      JOIN agents a1 ON a1.id = v1.agent_id
      JOIN agent_versions v2 ON v2.id = tm.p2_version_id
      JOIN agents a2 ON a2.id = v2.agent_id
      WHERE tm.id = ?
      `
    )
    .get(matchId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const games = tournamentGames.getTournamentMatchGames(db, matchId);
  return mapTournamentGameView(row, games);
}

export function recordCompletedTournamentGame(
  db: DatabaseSync,
  inTransaction: TransactionRunner,
  match: CompletedTournamentGamePayload
): {duplicate: boolean; game: TournamentGameView} {
  return inTransaction(() => {
    const tournament = getTournament(db, match.tournamentId);
    if (!tournament) {
      throw Object.assign(new Error(`Unknown tournament "${match.tournamentId}".`), {status: 404});
    }
    const existing = getTournamentGame(db, match.id);
    if (existing?.status === 'completed') {
      return {duplicate: true, game: existing};
    }

    const entrantRows = db
      .prepare(
        `
        SELECT version_id
        FROM tournament_entrants
        WHERE tournament_id = ? AND version_id IN (?, ?)
        `
      )
      .all(match.tournamentId, match.p1.versionId, match.p2.versionId) as Array<{
      version_id: number;
    }>;
    if (match.p1.versionId === match.p2.versionId || entrantRows.length !== 2) {
      throw Object.assign(
        new Error(
          'Both p1VersionId and p2VersionId must be distinct registered tournament entrants.'
        ),
        {status: 400}
      );
    }

    upsertTournamentGame(db, {
      id: match.id,
      tournamentId: match.tournamentId,
      stage: match.stage ?? existing?.stage ?? 'Round Robin',
      cycle: match.cycle,
      matchupGame: match.matchupGame,
      status: 'completed',
      preemptions: match.preemptions ?? existing?.preemptions ?? 0,
      outcome: match.outcome,
      p1: {
        versionId: match.p1.versionId,
        team: match.p1.team ?? existing?.p1.team,
      },
      p2: {
        versionId: match.p2.versionId,
        team: match.p2.team ?? existing?.p2.team,
      },
      games: match.games,
      completedAt: match.completedAt,
    });

    recomputeTournamentStandings(db, match.tournamentId, tournament.status === 'completed');
    return {duplicate: false, game: getTournamentGame(db, match.id)!};
  });
}

export function getTournamentGames(
  db: DatabaseSync,
  tournamentId: string,
  limit = 50
): TournamentGameView[] {
  const rows = db
    .prepare(
      `
      SELECT
        tm.*,
        a1.slug AS p1_slug,
        a1.name AS p1_name,
        v1.version AS p1_version,
        a2.slug AS p2_slug,
        a2.name AS p2_name,
        v2.version AS p2_version
      FROM tournament_matches tm
      JOIN agent_versions v1 ON v1.id = tm.p1_version_id
      JOIN agents a1 ON a1.id = v1.agent_id
      JOIN agent_versions v2 ON v2.id = tm.p2_version_id
      JOIN agents a2 ON a2.id = v2.agent_id
      WHERE tm.tournament_id = ?
        AND tm.status = 'completed'
      ORDER BY tm.completed_at DESC, tm.id DESC
      LIMIT ?
      `
    )
    .all(tournamentId, limit) as Array<Record<string, unknown>>;

  const gamesByMatch = rows.length <= 500
    ? tournamentGames.getTournamentMatchGamesForMatches(db, rows.map(row => row.id as string))
    : tournamentGames.getTournamentMatchGamesByTournament(db, tournamentId);
  return rows.map(row => mapTournamentGameView(row, gamesByMatch.get(row.id as string) ?? []));
}

export function getTournamentCrosstable(
  db: DatabaseSync,
  tournamentId: string,
  stage: TournamentGameStage = 'Round Robin'
): TournamentPairRecord[] {
  const rows = db
    .prepare(
      `
      SELECT
        MIN(p1_version_id, p2_version_id) AS low_version_id,
        MAX(p1_version_id, p2_version_id) AS high_version_id,
        SUM(CASE
          WHEN p1_version_id < p2_version_id AND outcome = 'W' THEN 1
          WHEN p2_version_id < p1_version_id AND outcome = 'L' THEN 1
          ELSE 0
        END) AS low_wins,
        SUM(CASE
          WHEN p1_version_id < p2_version_id AND outcome = 'L' THEN 1
          WHEN p2_version_id < p1_version_id AND outcome = 'W' THEN 1
          ELSE 0
        END) AS high_wins,
        SUM(CASE WHEN outcome = 'T' THEN 1 ELSE 0 END) AS ties
      FROM tournament_matches
      WHERE tournament_id = ?
        AND stage = ?
        AND status = 'completed'
      GROUP BY MIN(p1_version_id, p2_version_id), MAX(p1_version_id, p2_version_id)
      `
    )
    .all(tournamentId, stage) as Array<Record<string, unknown>>;

  return rows.map(r => ({
    lowVersionId: r.low_version_id as number,
    highVersionId: r.high_version_id as number,
    lowWins: r.low_wins as number,
    highWins: r.high_wins as number,
    ties: r.ties as number,
  }));
}
