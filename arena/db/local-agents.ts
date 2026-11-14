import {DatabaseSync} from 'node:sqlite';

export type ExecutionMode = 'native' | 'container';
export type ResidencyState = 'hot' | 'cold';

export interface LocalAgentRow {
  versionId: number;
  agentId: number;
  slug: string;
  version: string;
  mode: ExecutionMode;
  target: string;
  residency: ResidencyState;
  unpackedBytes: number;
  consecutiveFaults: number;
  totalGames: number;
  totalFaults: number;
  lastPlayedAt: number;
  createdAt: number;
}

export interface UpsertLocalAgentInput {
  versionId: number;
  agentId: number;
  slug: string;
  version: string;
  mode: ExecutionMode;
  target: string;
  residency?: ResidencyState;
  unpackedBytes: number;
  now?: number;
}

interface RawLocalAgentRow {
  version_id: number;
  agent_id: number;
  slug: string;
  version: string;
  mode: ExecutionMode;
  target: string;
  residency: ResidencyState;
  unpacked_bytes: number;
  consecutive_faults: number;
  total_games: number;
  total_faults: number;
  last_played_at: number;
  created_at: number;
}

function mapLocalAgentRow(raw: RawLocalAgentRow): LocalAgentRow {
  return {
    versionId: raw.version_id,
    agentId: raw.agent_id,
    slug: raw.slug,
    version: raw.version,
    mode: raw.mode,
    target: raw.target,
    residency: raw.residency,
    unpackedBytes: raw.unpacked_bytes,
    consecutiveFaults: raw.consecutive_faults,
    totalGames: raw.total_games,
    totalFaults: raw.total_faults,
    lastPlayedAt: raw.last_played_at,
    createdAt: raw.created_at,
  };
}

export function upsertLocalAgent(db: DatabaseSync, input: UpsertLocalAgentInput) {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO local_agents (
      version_id, agent_id, slug, version, mode, target, residency,
      unpacked_bytes, consecutive_faults, total_games, total_faults,
      last_played_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)
    ON CONFLICT(version_id) DO UPDATE SET
      agent_id = excluded.agent_id,
      slug = excluded.slug,
      version = excluded.version,
      mode = excluded.mode,
      target = excluded.target,
      residency = excluded.residency,
      unpacked_bytes = excluded.unpacked_bytes,
      last_played_at = excluded.last_played_at
  `).run(
    input.versionId,
    input.agentId,
    input.slug,
    input.version,
    input.mode,
    input.target,
    input.residency ?? 'hot',
    input.unpackedBytes,
    now,
    now
  );
}

export function getLocalAgent(db: DatabaseSync, versionId: number): LocalAgentRow | undefined {
  const raw = db.prepare(
    'SELECT * FROM local_agents WHERE version_id = ?'
  ).get(versionId) as RawLocalAgentRow | undefined;
  return raw ? mapLocalAgentRow(raw) : undefined;
}

export function listLocalAgents(db: DatabaseSync, residency?: ResidencyState): LocalAgentRow[] {
  const rows = residency
    ? (db.prepare(
      'SELECT * FROM local_agents WHERE residency = ? ORDER BY last_played_at DESC'
    ).all(residency) as unknown as RawLocalAgentRow[])
    : (db.prepare(
      'SELECT * FROM local_agents ORDER BY last_played_at DESC'
    ).all() as unknown as RawLocalAgentRow[]);
  return rows.map(mapLocalAgentRow);
}

export function setAgentResidency(
  db: DatabaseSync,
  versionId: number,
  residency: ResidencyState,
  now = Math.floor(Date.now() / 1000)
) {
  db.prepare(`
    UPDATE local_agents
    SET residency = ?,
        last_played_at = CASE WHEN ? = 'hot' THEN ? ELSE last_played_at END
    WHERE version_id = ?
  `).run(residency, residency, now, versionId);
}

export function recordAgentGameResult(
  db: DatabaseSync,
  versionId: number,
  faulted: boolean,
  now = Math.floor(Date.now() / 1000)
): LocalAgentRow | undefined {
  db.prepare(`
    UPDATE local_agents
    SET total_games = total_games + 1,
        total_faults = total_faults + ?,
        consecutive_faults = CASE WHEN ? = 1 THEN consecutive_faults + 1 ELSE 0 END,
        last_played_at = ?
    WHERE version_id = ?
  `).run(faulted ? 1 : 0, faulted ? 1 : 0, now, versionId);
  return getLocalAgent(db, versionId);
}

export function totalHotUnpackedBytes(db: DatabaseSync, mode?: ExecutionMode): number {
  const row = mode
    ? (db.prepare(`
      SELECT COALESCE(SUM(unpacked_bytes), 0) AS total
      FROM local_agents
      WHERE residency = 'hot' AND mode = ?
    `).get(mode) as {total: number})
    : (db.prepare(`
      SELECT COALESCE(SUM(unpacked_bytes), 0) AS total
      FROM local_agents
      WHERE residency = 'hot'
    `).get() as {total: number});
  return row.total;
}

export function listColdEvictionCandidates(
  db: DatabaseSync,
  mode?: ExecutionMode
): LocalAgentRow[] {
  const rows = mode
    ? (db.prepare(`
      SELECT * FROM local_agents
      WHERE residency = 'hot' AND mode = ?
      ORDER BY last_played_at ASC, version_id ASC
    `).all(mode) as unknown as RawLocalAgentRow[])
    : (db.prepare(`
      SELECT * FROM local_agents
      WHERE residency = 'hot'
      ORDER BY last_played_at ASC, version_id ASC
    `).all() as unknown as RawLocalAgentRow[]);
  return rows.map(mapLocalAgentRow);
}
