import {DatabaseSync} from 'node:sqlite';

export type TournamentGameStage = 'Round Robin' | 'Superfinal';
export type TournamentGameStatus = 'pending' | 'running' | 'completed';

export interface TournamentGameRow {
  id: string;
  tournamentId: string;
  stage: TournamentGameStage;
  cycle: number;
  matchupGame: number;
  p1VersionId: number;
  p2VersionId: number;
  seed: string;
  status: TournamentGameStatus;
  preemptions: number;
  p1Team?: string;
  p2Team?: string;
  outcome?: 'W' | 'L' | 'T';
  turns?: number;
  endReason?: string;
  p1BankSeconds?: number;
  p2BankSeconds?: number;
  completedAt?: number;
}

export interface TournamentGameView extends TournamentGameRow {
  p1Slug: string;
  p1Name: string;
  p1Version: string;
  p2Slug: string;
  p2Name: string;
  p2Version: string;
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
  p1VersionId: number;
  p2VersionId: number;
  seed: string;
  status?: TournamentGameStatus;
  preemptions?: number;
  p1Team?: string;
  p2Team?: string;
  outcome?: 'W' | 'L' | 'T';
  turns?: number;
  endReason?: string;
  p1BankSeconds?: number;
  p2BankSeconds?: number;
  completedAt?: number;
}

export function upsertTournamentGame(db: DatabaseSync, input: UpsertTournamentGameInput) {
  db.prepare(`
    INSERT INTO tournament_games (
      id, tournament_id, stage, cycle, matchup_game,
      p1_version_id, p2_version_id, seed, status, preemptions,
      p1_team, p2_team, outcome, turns, end_reason,
      p1_bank_seconds, p2_bank_seconds, completed_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      stage = excluded.stage,
      cycle = excluded.cycle,
      matchup_game = excluded.matchup_game,
      p1_version_id = excluded.p1_version_id,
      p2_version_id = excluded.p2_version_id,
      seed = excluded.seed,
      status = excluded.status,
      preemptions = excluded.preemptions,
      p1_team = excluded.p1_team,
      p2_team = excluded.p2_team,
      outcome = excluded.outcome,
      turns = excluded.turns,
      end_reason = excluded.end_reason,
      p1_bank_seconds = excluded.p1_bank_seconds,
      p2_bank_seconds = excluded.p2_bank_seconds,
      completed_at = excluded.completed_at
  `).run(
    input.id,
    input.tournamentId,
    input.stage ?? 'Round Robin',
    input.cycle,
    input.matchupGame,
    input.p1VersionId,
    input.p2VersionId,
    input.seed,
    input.status ?? 'pending',
    input.preemptions ?? 0,
    input.p1Team ?? null,
    input.p2Team ?? null,
    input.outcome ?? null,
    input.turns ?? null,
    input.endReason ?? null,
    input.p1BankSeconds ?? null,
    input.p2BankSeconds ?? null,
    input.completedAt ?? null
  );
}

export function getTournamentGames(
  db: DatabaseSync,
  tournamentId: string,
  limit = 50
): TournamentGameView[] {
  const rows = db.prepare(`
    SELECT
      tg.*,
      a1.slug AS p1_slug,
      a1.name AS p1_name,
      v1.version AS p1_version,
      a2.slug AS p2_slug,
      a2.name AS p2_name,
      v2.version AS p2_version
    FROM tournament_games tg
    JOIN agent_versions v1 ON v1.id = tg.p1_version_id
    JOIN agents a1 ON a1.id = v1.agent_id
    JOIN agent_versions v2 ON v2.id = tg.p2_version_id
    JOIN agents a2 ON a2.id = v2.agent_id
    WHERE tg.tournament_id = ?
      AND tg.status = 'completed'
    ORDER BY tg.completed_at DESC, tg.id DESC
    LIMIT ?
  `).all(tournamentId, limit) as Array<Record<string, unknown>>;

  return rows.map(r => ({
    id: r.id as string,
    tournamentId: r.tournament_id as string,
    stage: r.stage as TournamentGameStage,
    cycle: r.cycle as number,
    matchupGame: r.matchup_game as number,
    p1VersionId: r.p1_version_id as number,
    p2VersionId: r.p2_version_id as number,
    seed: r.seed as string,
    status: r.status as TournamentGameStatus,
    preemptions: r.preemptions as number,
    p1Team: (r.p1_team as string | null) ?? undefined,
    p2Team: (r.p2_team as string | null) ?? undefined,
    outcome: (r.outcome as 'W' | 'L' | 'T' | null) ?? undefined,
    turns: (r.turns as number | null) ?? undefined,
    endReason: (r.end_reason as string | null) ?? undefined,
    p1BankSeconds: (r.p1_bank_seconds as number | null) ?? undefined,
    p2BankSeconds: (r.p2_bank_seconds as number | null) ?? undefined,
    completedAt: (r.completed_at as number | null) ?? undefined,
    p1Slug: r.p1_slug as string,
    p1Name: r.p1_name as string,
    p1Version: r.p1_version as string,
    p2Slug: r.p2_slug as string,
    p2Name: r.p2_name as string,
    p2Version: r.p2_version as string,
  }));
}

export function getTournamentCrosstable(
  db: DatabaseSync,
  tournamentId: string,
  stage: TournamentGameStage = 'Round Robin'
): TournamentPairRecord[] {
  const rows = db.prepare(`
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
    FROM tournament_games
    WHERE tournament_id = ?
      AND stage = ?
      AND status = 'completed'
    GROUP BY MIN(p1_version_id, p2_version_id), MAX(p1_version_id, p2_version_id)
  `).all(tournamentId, stage) as Array<Record<string, unknown>>;

  return rows.map(r => ({
    lowVersionId: r.low_version_id as number,
    highVersionId: r.high_version_id as number,
    lowWins: r.low_wins as number,
    highWins: r.high_wins as number,
    ties: r.ties as number,
  }));
}
