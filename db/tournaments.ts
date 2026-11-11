import type {DatabaseSync} from 'node:sqlite';

export type TournamentStatus = 'scheduled' | 'running' | 'completed';

export interface TournamentRow {
  id: string;
  name: string;
  format_id: string;
  custom_rules_json: string;
  games_per_matchup: number;
  batch_size: number;
  parallel_tables: number;
  hardware_desc: string;
  status: TournamentStatus;
  starts_at: number;
  completed_at: number | null;
}

export interface UpsertTournamentInput {
  id: string;
  name: string;
  format_id: string;
  custom_rules_json?: string;
  games_per_matchup: number;
  batch_size?: number;
  parallel_tables: number;
  hardware_desc: string;
  status?: TournamentStatus;
  starts_at: number;
  completed_at?: number | null;
}

export function upsertTournament(db: DatabaseSync, input: UpsertTournamentInput) {
  db.prepare(`
    INSERT INTO tournaments (
      id, name, format_id, custom_rules_json, games_per_matchup,
      batch_size, parallel_tables, hardware_desc, status, starts_at, completed_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      format_id = excluded.format_id,
      custom_rules_json = excluded.custom_rules_json,
      games_per_matchup = excluded.games_per_matchup,
      batch_size = excluded.batch_size,
      parallel_tables = excluded.parallel_tables,
      hardware_desc = excluded.hardware_desc,
      status = excluded.status,
      starts_at = excluded.starts_at,
      completed_at = excluded.completed_at
  `).run(
    input.id,
    input.name,
    input.format_id,
    input.custom_rules_json ?? '[]',
    input.games_per_matchup,
    input.batch_size ?? 10,
    input.parallel_tables,
    input.hardware_desc,
    input.status ?? 'scheduled',
    input.starts_at,
    input.completed_at ?? null
  );
}

export function getTournaments(db: DatabaseSync): TournamentRow[] {
  return db.prepare(`
    SELECT *
    FROM tournaments
    ORDER BY
      CASE status
        WHEN 'running' THEN 0
        WHEN 'completed' THEN 1
        ELSE 2
      END ASC,
      starts_at DESC,
      id ASC
  `).all() as unknown as TournamentRow[];
}

export function getTournament(db: DatabaseSync, id: string): TournamentRow | undefined {
  return db.prepare('SELECT * FROM tournaments WHERE id = ?')
    .get(id) as unknown as TournamentRow | undefined;
}
