import {DatabaseSync} from 'node:sqlite';

import {recomputeTournamentStandings} from './tournament-entrants';

import {TransactionRunner} from './index';

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

export function getRunningTournament(db: DatabaseSync): TournamentRow | undefined {
  const raw = db.prepare(`
    SELECT *
    FROM tournaments
    WHERE status = 'running'
    ORDER BY starts_at DESC, id ASC
    LIMIT 1
  `).get() as unknown as RawTournamentRow | undefined;
  return raw ? mapTournamentRow(raw) : undefined;
}

export function getScheduledTournaments(db: DatabaseSync): TournamentRow[] {
  const rows = db.prepare(`
    SELECT *
    FROM tournaments
    WHERE status = 'scheduled'
    ORDER BY starts_at ASC, id ASC
  `).all() as unknown as RawTournamentRow[];
  return rows.map(mapTournamentRow);
}

export function setTournamentStatus(
  db: DatabaseSync,
  inTransaction: TransactionRunner,
  id: string,
  status: TournamentStatus,
  now = Math.floor(Date.now() / 1000)
): TournamentRow {
  return inTransaction(() => {
    const existing = getTournament(db, id);
    if (!existing) {
      throw new Error(`Unknown tournament "${id}"`);
    }
    if (status !== 'scheduled' && status !== 'running' && status !== 'completed') {
      throw new Error(`Invalid tournament status "${String(status)}"`);
    }
    const completedAt = status === 'completed' ? (existing.completedAt ?? now) : null;
    db.prepare('UPDATE tournaments SET status = ?, completed_at = ? WHERE id = ?')
      .run(status, completedAt, id);
    if (status === 'completed') {
      const completedGames = db.prepare(
        `SELECT COUNT(*) AS count FROM tournament_games
         WHERE tournament_id = ? AND status = 'completed'`
      ).get(id) as {count: number};
      // Only recompute from `tournament_games` when game rows exist so manual fixture tests that
      // seed pre-aggregated `tournament_entrants` rows without game rows keep their seeded scores.
      if (completedGames.count > 0) {
        recomputeTournamentStandings(db, id, true);
      }
    }
    return getTournament(db, id)!;
  });
}

// Re-assigns 1-based tournament seeds ordered by pre-tournament conservative ladder rating (`lcb`)
// on the matching format (falling back to registration order when an entrant has not played that
// format on the continuous ladder).
export function seedTournamentEntrants(
  db: DatabaseSync,
  inTransaction: TransactionRunner,
  tournamentId: string
): number {
  const tournament = getTournament(db, tournamentId);
  if (!tournament) {
    throw new Error(`Unknown tournament "${tournamentId}"`);
  }
  return inTransaction(() => {
    const rows = db.prepare(`
      SELECT
        te.version_id,
        te.seed,
        (
          SELECT MAX(le.lcb)
          FROM ladder_entries le
          JOIN agent_versions av ON av.id = le.version_id
          JOIN ladders l ON l.id = le.ladder_id
          WHERE av.agent_id = te.agent_id
            AND l.format = ?
            AND le.role IN ('champion', 'challenger')
        ) AS best_lcb
      FROM tournament_entrants te
      WHERE te.tournament_id = ?
      ORDER BY
        CASE WHEN best_lcb IS NOT NULL THEN 0 ELSE 1 END ASC,
        best_lcb DESC,
        te.seed ASC,
        te.version_id ASC
    `).all(tournament.format, tournamentId) as Array<{version_id: number}>;

    const update = db.prepare(
      'UPDATE tournament_entrants SET seed = ? WHERE tournament_id = ? AND version_id = ?'
    );
    rows.forEach((row, idx) => {
      update.run(idx + 1, tournamentId, row.version_id);
    });
    return rows.length;
  });
}
