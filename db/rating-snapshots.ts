import {DatabaseSync} from 'node:sqlite';

export interface RatingSnapshotRow {
  ladderId: string;
  versionId: number;
  dayUtc: string;
  matches: number;
  elo: number;
  se: number;
  lcb: number;
  gxe: number;
  rankCurrent?: number;
  rankMin?: number;
  rankMax?: number;
  rankBest?: number;
}

export interface RatingSnapshotInput {
  versionId: number;
  matches: number;
  elo: number;
  se: number;
  lcb: number;
  gxe: number;
  rankCurrent?: number;
  rankMin?: number;
  rankMax?: number;
  bestRank?: number;
}

export interface LadderSnapshotHistoryRow {
  ladderId: string;
  versionId: number;
  agentId: number;
  agentSlug: string;
  agentName: string;
  version: string;
  dayUtc: string;
  matches: number;
  elo: number;
  se: number;
  lcb: number;
  gxe: number;
  rankCurrent?: number;
}

export function getRatingSnapshotsForLadder(
  db: DatabaseSync,
  ladderId: string,
  agentId?: number
): LadderSnapshotHistoryRow[] {
  const agentFilter = agentId !== undefined ? 'AND av.agent_id = ?' : '';
  const params: Array<string | number> = agentId !== undefined ? [ladderId, agentId] : [ladderId];
  const rows = db.prepare(`
    SELECT
      rs.ladder_id,
      rs.version_id,
      av.agent_id,
      a.slug AS agent_slug,
      a.name AS agent_name,
      av.version,
      rs.day_utc,
      rs.matches,
      rs.elo,
      rs.se,
      rs.lcb,
      rs.gxe,
      rs.rank_current
    FROM rating_snapshots rs
    JOIN agent_versions av ON av.id = rs.version_id
    JOIN agents a ON a.id = av.agent_id
    WHERE rs.ladder_id = ?
      AND av.smoke_status = 'passed'
      ${agentFilter}
    ORDER BY rs.day_utc ASC, rs.version_id ASC
  `).all(...params) as Array<Record<string, unknown>>;

  return rows.map(r => ({
    ladderId: r.ladder_id as string,
    versionId: r.version_id as number,
    agentId: r.agent_id as number,
    agentSlug: r.agent_slug as string,
    agentName: r.agent_name as string,
    version: r.version as string,
    dayUtc: r.day_utc as string,
    matches: r.matches as number,
    elo: r.elo as number,
    se: r.se as number,
    lcb: r.lcb as number,
    gxe: r.gxe as number,
    rankCurrent: (r.rank_current as number | null) ?? undefined,
  }));
}

// Overwrites each version's row for `dayUtc` on every post-match solve so historical SVG charts
// retain end-of-day UTC ratings without storing per-match snapshots.
export function upsertDailyRatingSnapshots(
  db: DatabaseSync,
  ladderId: string,
  dayUtc: string,
  entries: RatingSnapshotInput[]
) {
  const upsert = db.prepare(`
    INSERT INTO rating_snapshots (
      ladder_id, version_id, day_utc, matches,
      elo, se, lcb, gxe,
      rank_current, rank_min, rank_max, rank_best
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ladder_id, version_id, day_utc) DO UPDATE SET
      matches = excluded.matches,
      elo = excluded.elo,
      se = excluded.se,
      lcb = excluded.lcb,
      gxe = excluded.gxe,
      rank_current = excluded.rank_current,
      rank_min = excluded.rank_min,
      rank_max = excluded.rank_max,
      rank_best = excluded.rank_best
  `);
  for (const v of entries) {
    upsert.run(
      ladderId,
      v.versionId,
      dayUtc,
      v.matches,
      v.elo,
      v.se,
      v.lcb,
      v.gxe,
      v.rankCurrent ?? null,
      v.rankMin ?? null,
      v.rankMax ?? null,
      v.bestRank ?? null
    );
  }
}
