import {DatabaseSync} from 'node:sqlite';

export type TournamentStatus = 'scheduled' | 'running' | 'completed';

export interface TournamentRow {
  id: string;
  name: string;
  format: string;
  rulesJson: string;
  gamesPerMatchup: number;
  batchSize: number;
  parallelTables: number;
  hardware: string;
  status: TournamentStatus;
  startsAt: number;
  completedAt?: number;
}

export interface UpsertTournamentInput {
  id: string;
  name: string;
  format: string;
  rulesJson?: string;
  gamesPerMatchup: number;
  batchSize?: number;
  parallelTables: number;
  hardware: string;
  status?: TournamentStatus;
  startsAt: number;
  completedAt?: number;
}

interface RawTournamentRow {
  id: string;
  name: string;
  format: string;
  rules_json: string;
  games_per_matchup: number;
  batch_size: number;
  parallel_tables: number;
  hardware: string;
  status: TournamentStatus;
  starts_at: number;
  completed_at: number | null;
}

function mapTournamentRow(raw: RawTournamentRow): TournamentRow {
  return {
    id: raw.id,
    name: raw.name,
    format: raw.format,
    rulesJson: raw.rules_json,
    gamesPerMatchup: raw.games_per_matchup,
    batchSize: raw.batch_size,
    parallelTables: raw.parallel_tables,
    hardware: raw.hardware,
    status: raw.status,
    startsAt: raw.starts_at,
    completedAt: raw.completed_at ?? undefined,
  };
}

export function upsertTournament(db: DatabaseSync, input: UpsertTournamentInput) {
  db.prepare(`
    INSERT INTO tournaments (
      id, name, format, rules_json, games_per_matchup,
      batch_size, parallel_tables, hardware, status, starts_at, completed_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      format = excluded.format,
      rules_json = excluded.rules_json,
      games_per_matchup = excluded.games_per_matchup,
      batch_size = excluded.batch_size,
      parallel_tables = excluded.parallel_tables,
      hardware = excluded.hardware,
      status = excluded.status,
      starts_at = excluded.starts_at,
      completed_at = excluded.completed_at
  `).run(
    input.id,
    input.name,
    input.format,
    input.rulesJson ?? '[]',
    input.gamesPerMatchup,
    input.batchSize ?? 10,
    input.parallelTables,
    input.hardware,
    input.status ?? 'scheduled',
    input.startsAt,
    input.completedAt ?? null
  );
}

export function getTournaments(db: DatabaseSync): TournamentRow[] {
  const rows = db.prepare(`
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
  `).all() as unknown as RawTournamentRow[];
  return rows.map(mapTournamentRow);
}

export function getTournament(db: DatabaseSync, id: string): TournamentRow | undefined {
  const raw = db.prepare('SELECT * FROM tournaments WHERE id = ?')
    .get(id) as unknown as RawTournamentRow | undefined;
  return raw ? mapTournamentRow(raw) : undefined;
}
