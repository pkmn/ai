import type {DatabaseSync} from 'node:sqlite';

import {
  type PairMatchCounts,
  type TernaryMatchOutcome,
  applyPairwiseStreakUpdate,
  computeLOS,
} from '../server/ratings';

export interface PairAggregateRow {
  ladder_id: string;
  v_low_id: number;
  v_high_id: number;
  ww: number;
  wt: number;
  split: number;
  tl: number;
  ll: number;
  cur_streak: number;
  v_low_max_win_streak: number;
  v_high_max_win_streak: number;
  los_low: number | null;
}

export interface IndexedPairKey {
  vLowId: number;
  vHighId: number;
  i: number;
  j: number;
}

export function loadPairAggregates(
  db: DatabaseSync,
  ladderId: string,
  indexByVersionId: Map<number, number>
): {pairs: PairMatchCounts[]; pairKeys: IndexedPairKey[]} {
  const rawPairs = db.prepare(`
    SELECT v_low_id, v_high_id, ww, wt, split, tl, ll
    FROM pair_aggregates
    WHERE ladder_id = ?
    ORDER BY v_low_id ASC, v_high_id ASC
  `).all(ladderId) as Array<{
    v_low_id: number;
    v_high_id: number;
    ww: number;
    wt: number;
    split: number;
    tl: number;
    ll: number;
  }>;

  const pairs: PairMatchCounts[] = [];
  const pairKeys: IndexedPairKey[] = [];
  for (const p of rawPairs) {
    const i = indexByVersionId.get(p.v_low_id);
    const j = indexByVersionId.get(p.v_high_id);
    if (i === undefined || j === undefined) continue;
    pairs.push({i, j, ww: p.ww, wt: p.wt, split: p.split, tl: p.tl, ll: p.ll});
    pairKeys.push({vLowId: p.v_low_id, vHighId: p.v_high_id, i, j});
  }
  return {pairs, pairKeys};
}

export function upsertPairAggregateForMatch(
  db: DatabaseSync,
  ladderId: string,
  vLowId: number,
  vHighId: number,
  delta: {ww: number; wt: number; split: number; tl: number; ll: number},
  vLowOutcome: TernaryMatchOutcome
) {
  const existingPair = db.prepare(`
    SELECT cur_streak, v_low_max_win_streak, v_high_max_win_streak
    FROM pair_aggregates
    WHERE ladder_id = ? AND v_low_id = ? AND v_high_id = ?
  `).get(ladderId, vLowId, vHighId) as {
    cur_streak: number;
    v_low_max_win_streak: number;
    v_high_max_win_streak: number;
  } | undefined;

  const pairStreaks = {
    curStreak: existingPair?.cur_streak ?? 0,
    vLowMaxWinStreak: existingPair?.v_low_max_win_streak ?? 0,
    vHighMaxWinStreak: existingPair?.v_high_max_win_streak ?? 0,
  };
  applyPairwiseStreakUpdate(pairStreaks, vLowOutcome);

  db.prepare(`
    INSERT INTO pair_aggregates (
      ladder_id, v_low_id, v_high_id, ww, wt, split, tl, ll,
      cur_streak, v_low_max_win_streak, v_high_max_win_streak
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ladder_id, v_low_id, v_high_id) DO UPDATE SET
      ww = pair_aggregates.ww + excluded.ww,
      wt = pair_aggregates.wt + excluded.wt,
      split = pair_aggregates.split + excluded.split,
      tl = pair_aggregates.tl + excluded.tl,
      ll = pair_aggregates.ll + excluded.ll,
      cur_streak = excluded.cur_streak,
      v_low_max_win_streak = excluded.v_low_max_win_streak,
      v_high_max_win_streak = excluded.v_high_max_win_streak
  `).run(
    ladderId,
    vLowId,
    vHighId,
    delta.ww,
    delta.wt,
    delta.split,
    delta.tl,
    delta.ll,
    pairStreaks.curStreak,
    pairStreaks.vLowMaxWinStreak,
    pairStreaks.vHighMaxWinStreak
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
    SET los_low = ?
    WHERE ladder_id = ? AND v_low_id = ? AND v_high_id = ?
  `);
  for (const pk of pairKeys) {
    const losLow = computeLOS(theta, covariance, M, pk.i, pk.j);
    updatePairLos.run(losLow, ladderId, pk.vLowId, pk.vHighId);
  }
}
