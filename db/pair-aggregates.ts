import {DatabaseSync} from 'node:sqlite';

import * as ratings from '../server/ratings';

export interface PairAggregateRow {
  ladderId: string;
  lowVersionId: number;
  highVersionId: number;
  ww: number;
  wt: number;
  split: number;
  tl: number;
  ll: number;
  currentStreak: number;
  lowMaxWinStreak: number;
  highMaxWinStreak: number;
  lowLos?: number;
}

export interface IndexedPairKey {
  lowVersionId: number;
  highVersionId: number;
  i: number;
  j: number;
}

export function loadPairAggregates(
  db: DatabaseSync,
  ladderId: string,
  indexByVersionId: Map<number, number>
): {pairs: ratings.PairMatchCounts[]; pairKeys: IndexedPairKey[]} {
  const rawPairs = db.prepare(`
    SELECT low_version_id, high_version_id, ww, wt, split, tl, ll
    FROM pair_aggregates
    WHERE ladder_id = ?
    ORDER BY low_version_id ASC, high_version_id ASC
  `).all(ladderId) as Array<{
    low_version_id: number;
    high_version_id: number;
    ww: number;
    wt: number;
    split: number;
    tl: number;
    ll: number;
  }>;

  const pairs: ratings.PairMatchCounts[] = [];
  const pairKeys: IndexedPairKey[] = [];
  for (const p of rawPairs) {
    const i = indexByVersionId.get(p.low_version_id);
    const j = indexByVersionId.get(p.high_version_id);
    if (i === undefined || j === undefined) continue;
    pairs.push({i, j, ww: p.ww, wt: p.wt, split: p.split, tl: p.tl, ll: p.ll});
    pairKeys.push({lowVersionId: p.low_version_id, highVersionId: p.high_version_id, i, j});
  }
  return {pairs, pairKeys};
}

// Updates canonical unordered pair `(low_version_id < high_version_id)` 5-category sufficient
// statistics so `recomputeLadderRatings` never has to scan the `matches` ledger.
export function upsertPairAggregateForMatch(
  db: DatabaseSync,
  ladderId: string,
  lowVersionId: number,
  highVersionId: number,
  delta: {ww: number; wt: number; split: number; tl: number; ll: number},
  lowOutcome: ratings.TernaryMatchOutcome
) {
  const existingPair = db.prepare(`
    SELECT current_streak, low_max_win_streak, high_max_win_streak
    FROM pair_aggregates
    WHERE ladder_id = ? AND low_version_id = ? AND high_version_id = ?
  `).get(ladderId, lowVersionId, highVersionId) as {
    current_streak: number;
    low_max_win_streak: number;
    high_max_win_streak: number;
  } | undefined;

  const pairStreaks: ratings.PairwiseStreakState = {
    currentStreak: existingPair?.current_streak ?? 0,
    lowMaxWinStreak: existingPair?.low_max_win_streak ?? 0,
    highMaxWinStreak: existingPair?.high_max_win_streak ?? 0,
  };
  ratings.applyPairwiseStreakUpdate(pairStreaks, lowOutcome);

  db.prepare(`
    INSERT INTO pair_aggregates (
      ladder_id, low_version_id, high_version_id, ww, wt, split, tl, ll,
      current_streak, low_max_win_streak, high_max_win_streak
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ladder_id, low_version_id, high_version_id) DO UPDATE SET
      ww = pair_aggregates.ww + excluded.ww,
      wt = pair_aggregates.wt + excluded.wt,
      split = pair_aggregates.split + excluded.split,
      tl = pair_aggregates.tl + excluded.tl,
      ll = pair_aggregates.ll + excluded.ll,
      current_streak = excluded.current_streak,
      low_max_win_streak = excluded.low_max_win_streak,
      high_max_win_streak = excluded.high_max_win_streak
  `).run(
    ladderId,
    lowVersionId,
    highVersionId,
    delta.ww,
    delta.wt,
    delta.split,
    delta.tl,
    delta.ll,
    pairStreaks.currentStreak,
    pairStreaks.lowMaxWinStreak,
    pairStreaks.highMaxWinStreak
  );
}

export function updatePairAggregateLos(
  db: DatabaseSync,
  ladderId: string,
  pairKeys: IndexedPairKey[],
  theta: Float64Array,
  covariance: Float64Array,
  M: number
) {
  const updatePairLos = db.prepare(`
    UPDATE pair_aggregates
    SET low_los = ?
    WHERE ladder_id = ? AND low_version_id = ? AND high_version_id = ?
  `);
  for (const pk of pairKeys) {
    const lowLos = ratings.computeLOS(theta, covariance, M, pk.i, pk.j);
    updatePairLos.run(lowLos, ladderId, pk.lowVersionId, pk.highVersionId);
  }
}

export function getPairAggregatesForLadder(
  db: DatabaseSync,
  ladderId: string
): PairAggregateRow[] {
  const rows = db.prepare(`
    SELECT
      ladder_id,
      low_version_id,
      high_version_id,
      ww,
      wt,
      split,
      tl,
      ll,
      current_streak,
      low_max_win_streak,
      high_max_win_streak,
      low_los
    FROM pair_aggregates
    WHERE ladder_id = ?
    ORDER BY low_version_id ASC, high_version_id ASC
  `).all(ladderId) as Array<Record<string, unknown>>;

  return rows.map(r => ({
    ladderId: r.ladder_id as string,
    lowVersionId: r.low_version_id as number,
    highVersionId: r.high_version_id as number,
    ww: r.ww as number,
    wt: r.wt as number,
    split: r.split as number,
    tl: r.tl as number,
    ll: r.ll as number,
    currentStreak: r.current_streak as number,
    lowMaxWinStreak: r.low_max_win_streak as number,
    highMaxWinStreak: r.high_max_win_streak as number,
    lowLos: (r.low_los as number | null) ?? undefined,
  }));
}
