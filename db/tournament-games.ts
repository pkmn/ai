import type {DatabaseSync} from 'node:sqlite';

export type TournamentGameStage = 'rr' | 'sf';
export type TournamentGameStatus = 'pending' | 'running' | 'completed';

export interface TournamentGameRow {
  id: string;
  tournament_id: string;
  stage: TournamentGameStage;
  macro_cycle: number;
  h2h_game_num: number;
  p1_version_id: number;
  p2_version_id: number;
  seed: string;
  status: TournamentGameStatus;
  preempt_count: number;
  p1_team_packed: string | null;
  p2_team_packed: string | null;
  outcome: 'W' | 'L' | 'T' | null;
  turns: number | null;
  end_reason: string | null;
  p1_bank_left_s: number | null;
  p2_bank_left_s: number | null;
  completed_at: number | null;
}

export interface TournamentGameView extends TournamentGameRow {
  p1_slug: string;
  p1_name: string;
  p1_version: string;
  p2_slug: string;
  p2_name: string;
  p2_version: string;
}

export interface TournamentPairRecord {
  v_low_id: number;
  v_high_id: number;
  low_wins: number;
  high_wins: number;
  ties: number;
}

export interface UpsertTournamentGameInput {
  id: string;
  tournament_id: string;
  stage?: TournamentGameStage;
  macro_cycle: number;
  h2h_game_num: number;
  p1_version_id: number;
  p2_version_id: number;
  seed: string;
  status?: TournamentGameStatus;
  preempt_count?: number;
  p1_team_packed?: string | null;
  p2_team_packed?: string | null;
  outcome?: 'W' | 'L' | 'T' | null;
  turns?: number | null;
  end_reason?: string | null;
  p1_bank_left_s?: number | null;
  p2_bank_left_s?: number | null;
  completed_at?: number | null;
}

export function upsertTournamentGame(db: DatabaseSync, input: UpsertTournamentGameInput) {
  db.prepare(`
    INSERT INTO tournament_games (
      id, tournament_id, stage, macro_cycle, h2h_game_num,
      p1_version_id, p2_version_id, seed, status, preempt_count,
      p1_team_packed, p2_team_packed, outcome, turns, end_reason,
      p1_bank_left_s, p2_bank_left_s, completed_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      stage = excluded.stage,
      macro_cycle = excluded.macro_cycle,
      h2h_game_num = excluded.h2h_game_num,
      p1_version_id = excluded.p1_version_id,
      p2_version_id = excluded.p2_version_id,
      seed = excluded.seed,
      status = excluded.status,
      preempt_count = excluded.preempt_count,
      p1_team_packed = excluded.p1_team_packed,
      p2_team_packed = excluded.p2_team_packed,
      outcome = excluded.outcome,
      turns = excluded.turns,
      end_reason = excluded.end_reason,
      p1_bank_left_s = excluded.p1_bank_left_s,
      p2_bank_left_s = excluded.p2_bank_left_s,
      completed_at = excluded.completed_at
  `).run(
    input.id,
    input.tournament_id,
    input.stage ?? 'rr',
    input.macro_cycle,
    input.h2h_game_num,
    input.p1_version_id,
    input.p2_version_id,
    input.seed,
    input.status ?? 'pending',
    input.preempt_count ?? 0,
    input.p1_team_packed ?? null,
    input.p2_team_packed ?? null,
    input.outcome ?? null,
    input.turns ?? null,
    input.end_reason ?? null,
    input.p1_bank_left_s ?? null,
    input.p2_bank_left_s ?? null,
    input.completed_at ?? null
  );
}

export function getTournamentGames(
  db: DatabaseSync,
  tournamentId: string,
  limit = 50
): TournamentGameView[] {
  return db.prepare(`
    SELECT
      tg.*,
      b1.slug AS p1_slug,
      b1.name AS p1_name,
      v1.version_str AS p1_version,
      b2.slug AS p2_slug,
      b2.name AS p2_name,
      v2.version_str AS p2_version
    FROM tournament_games tg
    JOIN bot_versions v1 ON v1.id = tg.p1_version_id
    JOIN bots b1 ON b1.id = v1.bot_id
    JOIN bot_versions v2 ON v2.id = tg.p2_version_id
    JOIN bots b2 ON b2.id = v2.bot_id
    WHERE tg.tournament_id = ?
      AND tg.status = 'completed'
    ORDER BY tg.completed_at DESC, tg.id DESC
    LIMIT ?
  `).all(tournamentId, limit) as unknown as TournamentGameView[];
}

export function getTournamentCrosstable(
  db: DatabaseSync,
  tournamentId: string,
  stage: TournamentGameStage = 'rr'
): TournamentPairRecord[] {
  return db.prepare(`
    SELECT
      MIN(p1_version_id, p2_version_id) AS v_low_id,
      MAX(p1_version_id, p2_version_id) AS v_high_id,
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
  `).all(tournamentId, stage) as unknown as TournamentPairRecord[];
}
