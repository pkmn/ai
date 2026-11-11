import type {DatabaseSync} from 'node:sqlite';

export interface RatingSnapshotRow {
  ladder_id: string;
  version_id: number;
  day_utc: string;
  matches_played: number;
  rating_elo: number;
  rating_se: number;
  rating_lcb: number;
  gxe: number;
  rank_current: number | null;
  rank_min: number | null;
  rank_max: number | null;
  rank_best: number | null;
}

export interface RatingSnapshotInput {
  versionId: number;
  matchesPlayed: number;
  ratingElo: number;
  ratingSe: number;
  ratingLcb: number;
  gxe: number;
  rankCurrent: number | null;
  rankMin: number | null;
  rankMax: number | null;
  bestRank: number | null;
}

export interface LadderSnapshotHistoryRow {
  ladder_id: string;
  version_id: number;
  bot_id: number;
  bot_slug: string;
  bot_name: string;
  version_str: string;
  day_utc: string;
  matches_played: number;
  rating_elo: number;
  rating_se: number;
  rating_lcb: number;
  gxe: number;
  rank_current: number | null;
}

export function getRatingSnapshotsForLadder(
  db: DatabaseSync,
  ladderId: string
): LadderSnapshotHistoryRow[] {
  return db.prepare(`
    SELECT
      rs.ladder_id,
      rs.version_id,
      bv.bot_id,
      b.slug AS bot_slug,
      b.name AS bot_name,
      bv.version_str,
      rs.day_utc,
      rs.matches_played,
      rs.rating_elo,
      rs.rating_se,
      rs.rating_lcb,
      rs.gxe,
      rs.rank_current
    FROM rating_snapshots rs
    JOIN bot_versions bv ON bv.id = rs.version_id
    JOIN bots b ON b.id = bv.bot_id
    WHERE rs.ladder_id = ?
      AND bv.smoke_status = 'passed'
    ORDER BY rs.day_utc ASC, rs.version_id ASC
  `).all(ladderId) as unknown as LadderSnapshotHistoryRow[];
}

export function upsertDailyRatingSnapshots(
  db: DatabaseSync,
  ladderId: string,
  dayUtc: string,
  entries: RatingSnapshotInput[]
) {
  const upsert = db.prepare(`
    INSERT INTO rating_snapshots (
      ladder_id, version_id, day_utc, matches_played,
      rating_elo, rating_se, rating_lcb, gxe,
      rank_current, rank_min, rank_max, rank_best
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ladder_id, version_id, day_utc) DO UPDATE SET
      matches_played = excluded.matches_played,
      rating_elo = excluded.rating_elo,
      rating_se = excluded.rating_se,
      rating_lcb = excluded.rating_lcb,
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
      v.matchesPlayed,
      v.ratingElo,
      v.ratingSe,
      v.ratingLcb,
      v.gxe,
      v.rankCurrent,
      v.rankMin,
      v.rankMax,
      v.bestRank
    );
  }
}
