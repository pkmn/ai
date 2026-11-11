import type {DatabaseSync} from 'node:sqlite';

import {
  ELO_SCALE,
  type PairMatchCounts,
  type RatingResult,
  advanceTopKClock,
  computeDavidsonRatings,
  computeGuaranteedRankBounds,
} from '../server/ratings';

import {
  type BotLadderStatsRow,
  createEmptyBotLadderStats,
  loadBotLadderStatsMap,
  upsertBotLadderStatsMap,
} from './bot_ladder_stats';
import {type LadderSlot, getLadder} from './ladders';
import {loadPairAggregates, updatePairAggregateLos} from './pair_aggregates';
import {upsertDailyRatingSnapshots} from './rating_snapshots';

import type {TransactionRunner} from './index';

export type EntryRole = 'champion' | 'challenger' | 'retired' | 'quarantined';

export interface ActiveEntryView {
  ladder_id: string;
  slot: LadderSlot;
  display_name: string;
  version_id: number;
  version_str: string;
  role: 'champion' | 'challenger';
  rating_elo: number;
  rating_se: number;
  rank_current: number | null;
  matches_played: number;
  ww: number;
  wt: number;
  split: number;
  tl: number;
  ll: number;
  settled_at: number | null;
}

export interface LeaderboardEntryView {
  ladder_id: string;
  version_id: number;
  version_str: string;
  bot_id: number;
  bot_slug: string;
  bot_name: string;
  role: 'champion' | 'challenger' | 'retired';
  is_anchor: number;
  retired_at: number | null;
  rating_elo: number;
  rating_se: number;
  rating_lcb: number;
  gxe: number;
  rank_current: number | null;
  rank_min: number | null;
  rank_max: number | null;
  matches_played: number;
  ww: number;
  wt: number;
  split: number;
  tl: number;
  ll: number;
  cur_win_streak: number;
  cur_loss_streak: number;
  settled_at: number | null;
}

export interface ProjectArenaLadderBadge {
  ladder_id: string;
  slot: LadderSlot;
  display_name: string;
  rank: number | null;
  rating_lcb: number;
  provisional: boolean;
}

export interface ProjectArenaSummary {
  bot_id: number;
  slug: string;
  name: string;
  status: 'pending' | 'qualified' | 'disabled';
  best_rank: number | null;
  best_lcb: number | null;
  ladders: ProjectArenaLadderBadge[];
}

export interface LadderStandingOverride {
  version_id: number;
  role?: EntryRole;
  is_anchor?: number;
}

interface EditableLadderEntry {
  versionId: number;
  botId: number;
  role: EntryRole;
  isAnchor: number;
  ratingElo: number;
  ratingSe: number;
  ratingLcb: number;
  gxe: number;
  rankCurrent: number | null;
  rankMin: number | null;
  rankMax: number | null;
  matchesPlayed: number;
  bestRank: number | null;
  bestRankAt: number | null;
  maxRatingLcb: number | null;
  maxElo: number | null;
  maxEloSe: number | null;
  maxGxe: number | null;
  maxEloAt: number | null;
  top1EnteredAt: number | null;
  top1MaxStreakS: number;
  top1TotalS: number;
  top10EnteredAt: number | null;
  top10MaxStreakS: number;
  top10TotalS: number;
  top100EnteredAt: number | null;
  top100MaxStreakS: number;
  top100TotalS: number;
  settledAt: number | null;
}

export function getActiveEntriesForBot(db: DatabaseSync, botId: number): ActiveEntryView[] {
  return db.prepare(`
    SELECT
      le.ladder_id,
      l.slot,
      l.display_name,
      le.version_id,
      bv.version_str,
      le.role,
      le.rating_elo,
      le.rating_se,
      le.rank_current,
      le.matches_played,
      le.ww,
      le.wt,
      le.split,
      le.tl,
      le.ll,
      le.settled_at
    FROM ladder_entries le
    JOIN bot_versions bv ON bv.id = le.version_id
    JOIN ladders l ON l.id = le.ladder_id
    WHERE bv.bot_id = ?
      AND bv.smoke_status = 'passed'
      AND le.role IN ('champion', 'challenger')
      AND l.status IN ('active', 'settling')
    ORDER BY
      CASE l.slot
        WHEN 'rby' THEN 0
        WHEN 'adv' THEN 1
        WHEN 'sv' THEN 2
        WHEN 'rand' THEN 3
        WHEN 'vgc' THEN 4
        ELSE 5
      END ASC,
      CASE le.role WHEN 'champion' THEN 0 ELSE 1 END ASC,
      le.rating_elo DESC
  `).all(botId) as unknown as ActiveEntryView[];
}

export function hasAnyLeaderboardEntry(db: DatabaseSync, botId: number): boolean {
  const row = db.prepare(`
    SELECT 1
    FROM ladder_entries le
    JOIN bot_versions bv ON bv.id = le.version_id
    WHERE bv.bot_id = ?
    LIMIT 1
  `).get(botId);
  return row !== undefined;
}

const SLOT_ORDER: Record<LadderSlot, number> = {
  rby: 0,
  adv: 1,
  sv: 2,
  rand: 3,
  vgc: 4,
};

export function getLeaderboardEntries(
  db: DatabaseSync,
  ladderId: string
): LeaderboardEntryView[] {
  return db.prepare(`
    SELECT
      le.ladder_id,
      le.version_id,
      bv.version_str,
      bv.bot_id,
      b.slug AS bot_slug,
      b.name AS bot_name,
      le.role,
      le.is_anchor,
      le.retired_at,
      le.rating_elo,
      le.rating_se,
      le.rating_lcb,
      le.gxe,
      le.rank_current,
      le.rank_min,
      le.rank_max,
      le.matches_played,
      le.ww,
      le.wt,
      le.split,
      le.tl,
      le.ll,
      le.cur_win_streak,
      le.cur_loss_streak,
      le.settled_at
    FROM ladder_entries le
    JOIN bot_versions bv ON bv.id = le.version_id
    JOIN bots b ON b.id = bv.bot_id
    WHERE le.ladder_id = ?
      AND bv.smoke_status = 'passed'
      AND le.role IN ('champion', 'challenger', 'retired')
    ORDER BY
      le.rating_lcb DESC,
      le.rating_elo DESC,
      le.version_id ASC
  `).all(ladderId) as unknown as LeaderboardEntryView[];
}

export function getProjectArenaSummaries(db: DatabaseSync): ProjectArenaSummary[] {
  const botRows = db.prepare(`
    SELECT id, slug, name, status
    FROM bots
    WHERE status != 'disabled'
    ORDER BY id ASC
  `).all() as Array<{
    id: number;
    slug: string;
    name: string;
    status: 'pending' | 'qualified' | 'disabled';
  }>;

  const activeRows = db.prepare(`
    SELECT
      bv.bot_id,
      le.ladder_id,
      l.slot,
      l.display_name,
      le.rank_current,
      le.rating_lcb,
      le.rating_elo,
      le.rating_se,
      le.matches_played
    FROM ladder_entries le
    JOIN bot_versions bv ON bv.id = le.version_id
    JOIN ladders l ON l.id = le.ladder_id
    JOIN bots b ON b.id = bv.bot_id
    WHERE b.status != 'disabled'
      AND bv.smoke_status = 'passed'
      AND le.role IN ('champion', 'challenger')
      AND l.status IN ('active', 'settling')
    ORDER BY
      le.rating_lcb DESC,
      le.rating_elo DESC,
      le.version_id ASC
  `).all() as Array<{
    bot_id: number;
    ladder_id: string;
    slot: LadderSlot;
    display_name: string;
    rank_current: number | null;
    rating_lcb: number;
    rating_elo: number;
    rating_se: number;
    matches_played: number;
  }>;

  const seenBotLadder = new Set<string>();
  const badgesByBot = new Map<number, ProjectArenaLadderBadge[]>();
  for (const r of activeRows) {
    const key = `${r.bot_id}:${r.ladder_id}`;
    if (seenBotLadder.has(key)) continue;
    seenBotLadder.add(key);

    const provisional = r.rank_current === null || r.matches_played < 10 || r.rating_se > 60;
    const list = badgesByBot.get(r.bot_id) ?? [];
    list.push({
      ladder_id: r.ladder_id,
      slot: r.slot,
      display_name: r.display_name,
      rank: provisional ? null : r.rank_current,
      rating_lcb: r.rating_lcb,
      provisional,
    });
    badgesByBot.set(r.bot_id, list);
  }

  return botRows.map(b => {
    const ladders = badgesByBot.get(b.id) ?? [];
    ladders.sort((x, y) => {
      if (x.rank !== null && y.rank !== null) {
        return x.rank - y.rank || (SLOT_ORDER[x.slot] ?? 99) - (SLOT_ORDER[y.slot] ?? 99);
      }
      if (x.rank !== null) return -1;
      if (y.rank !== null) return 1;
      return (SLOT_ORDER[x.slot] ?? 99) - (SLOT_ORDER[y.slot] ?? 99);
    });

    let bestRank: number | null = null;
    let bestRankedLcb: number | null = null;
    let bestAnyLcb: number | null = null;
    for (const item of ladders) {
      if (bestAnyLcb === null || item.rating_lcb > bestAnyLcb) {
        bestAnyLcb = item.rating_lcb;
      }
      if (item.rank !== null) {
        if (bestRank === null || item.rank < bestRank) {
          bestRank = item.rank;
        }
        if (bestRankedLcb === null || item.rating_lcb > bestRankedLcb) {
          bestRankedLcb = item.rating_lcb;
        }
      }
    }

    return {
      bot_id: b.id,
      slug: b.slug,
      name: b.name,
      status: b.status,
      best_rank: bestRank,
      best_lcb: bestRankedLcb ?? bestAnyLcb,
      ladders,
    };
  });
}

export function promoteRemainingActiveToChampion(
  db: DatabaseSync,
  ladderId: string,
  botId: number
) {
  const active = db.prepare(`
    SELECT le.version_id
    FROM ladder_entries le
    JOIN bot_versions bv ON bv.id = le.version_id
    WHERE le.ladder_id = ?
      AND bv.bot_id = ?
      AND le.role IN ('champion', 'challenger')
    ORDER BY le.rating_lcb DESC, le.rating_elo DESC, le.version_id ASC
  `).all(ladderId, botId) as Array<{version_id: number}>;

  if (active.length >= 1) {
    db.prepare(
      "UPDATE ladder_entries SET role = 'champion' WHERE ladder_id = ? AND version_id = ?"
    ).run(ladderId, active[0].version_id);
    for (let i = 1; i < active.length; i++) {
      db.prepare(
        "UPDATE ladder_entries SET role = 'challenger' WHERE ladder_id = ? AND version_id = ?"
      ).run(ladderId, active[i].version_id);
    }
  }
}

function applyRatingsToEntriesAndFamilies(
  entries: EditableLadderEntry[],
  pairs: PairMatchCounts[],
  anchorIndex: number,
  nowSec: number,
  prevMatchSec: number | null,
  families: Map<number, BotLadderStatsRow>,
  warmStartTheta: Float64Array
): RatingResult {
  const M = entries.length;
  const deltaSec = prevMatchSec !== null ? Math.min(3600, Math.max(0, nowSec - prevMatchSec)) : 0;
  const res = computeDavidsonRatings(M, pairs, anchorIndex, 1500, warmStartTheta);

  const activeIndicesByBot = new Map<number, number[]>();
  for (let i = 0; i < M; i++) {
    const v = entries[i];
    v.ratingElo = res.elo[i];
    v.ratingSe = res.eloStd[i];
    v.ratingLcb = res.eloLcb[i];
    v.gxe = res.gxe[i];
    if (v.settledAt === null && v.matchesPlayed >= 25 && v.ratingSe <= 30.0) {
      v.settledAt = nowSec;
    }
    if (v.role === 'champion' || v.role === 'challenger') {
      const list = activeIndicesByBot.get(v.botId) ?? [];
      list.push(i);
      activeIndicesByBot.set(v.botId, list);
    }
  }

  for (const indices of activeIndicesByBot.values()) {
    indices.sort((a, b) => (
      entries[b].ratingLcb - entries[a].ratingLcb ||
      entries[b].ratingElo - entries[a].ratingElo ||
      entries[a].versionId - entries[b].versionId
    ));
    entries[indices[0]].role = 'champion';
    for (let k = 1; k < indices.length; k++) {
      entries[indices[k]].role = 'challenger';
    }
  }

  const repByBot = new Map<number, number>();
  for (let i = 0; i < M; i++) {
    const v = entries[i];
    const isActive = v.role === 'champion' || v.role === 'challenger';
    const passesProvisionalGate = v.matchesPlayed >= 10 && v.ratingSe <= 60.0;
    if (!isActive || !passesProvisionalGate) {
      v.rankCurrent = null;
      v.rankMin = null;
      v.rankMax = null;
      continue;
    }
    const prevIdx = repByBot.get(v.botId);
    if (prevIdx === undefined || v.ratingLcb > entries[prevIdx].ratingLcb) {
      if (prevIdx !== undefined) {
        entries[prevIdx].rankCurrent = null;
        entries[prevIdx].rankMin = null;
        entries[prevIdx].rankMax = null;
      }
      repByBot.set(v.botId, i);
    } else {
      v.rankCurrent = null;
      v.rankMin = null;
      v.rankMax = null;
    }
  }

  const repIndices = [...repByBot.values()].sort(
    (a, b) => entries[b].ratingLcb - entries[a].ratingLcb
  );
  const {rankMin, rankMax} = computeGuaranteedRankBounds(
    repIndices,
    res.theta,
    res.covariance,
    res.eloLcb,
    res.eloUcb,
    M,
    0.95
  );

  for (let r = 0; r < repIndices.length; r++) {
    const idx = repIndices[r];
    entries[idx].rankCurrent = r + 1;
    entries[idx].rankMin = rankMin[r];
    entries[idx].rankMax = rankMax[r];
  }

  const botIds = new Set<number>();
  for (const v of entries) {
    botIds.add(v.botId);

    if (v.matchesPlayed >= 10 && (v.maxRatingLcb === null || v.ratingLcb > v.maxRatingLcb)) {
      v.maxRatingLcb = v.ratingLcb;
    }

    if (v.settledAt !== null) {
      if (v.maxElo === null || v.ratingElo > v.maxElo) {
        v.maxElo = v.ratingElo;
        v.maxEloSe = v.ratingSe;
        v.maxEloAt = nowSec;
      }
      if (v.maxGxe === null || v.gxe > v.maxGxe) {
        v.maxGxe = v.gxe;
      }
      if (v.rankCurrent !== null && (v.bestRank === null || v.rankCurrent < v.bestRank)) {
        v.bestRank = v.rankCurrent;
        v.bestRankAt = nowSec;
      }
    }

    const inTop1 = v.settledAt !== null && v.rankCurrent === 1;
    const inTop10 = v.rankMax !== null && v.rankMax <= 10;
    const inTop100 = v.rankMax !== null && v.rankMax <= 100;

    const c1 = advanceTopKClock(
      v.top1EnteredAt, v.top1MaxStreakS, v.top1TotalS, inTop1, nowSec, deltaSec
    );
    v.top1EnteredAt = c1.enteredAt;
    v.top1MaxStreakS = c1.maxStreakS;
    v.top1TotalS = c1.totalS;

    const c10 = advanceTopKClock(
      v.top10EnteredAt, v.top10MaxStreakS, v.top10TotalS, inTop10, nowSec, deltaSec
    );
    v.top10EnteredAt = c10.enteredAt;
    v.top10MaxStreakS = c10.maxStreakS;
    v.top10TotalS = c10.totalS;

    const c100 = advanceTopKClock(
      v.top100EnteredAt, v.top100MaxStreakS, v.top100TotalS, inTop100, nowSec, deltaSec
    );
    v.top100EnteredAt = c100.enteredAt;
    v.top100MaxStreakS = c100.maxStreakS;
    v.top100TotalS = c100.totalS;
  }

  for (const botId of botIds) {
    let fam = families.get(botId);
    if (!fam) {
      fam = createEmptyBotLadderStats(botId);
      families.set(botId, fam);
    }

    for (const v of entries) {
      if (v.botId !== botId) continue;
      if (v.maxRatingLcb !== null && (
        fam.maxRatingLcb === null || v.maxRatingLcb > fam.maxRatingLcb
      )) {
        fam.maxRatingLcb = v.maxRatingLcb;
      }
      if (v.settledAt !== null) {
        if (fam.maxElo === null || v.ratingElo > fam.maxElo) {
          fam.maxElo = v.ratingElo;
          fam.maxEloSe = v.ratingSe;
          fam.maxEloVersionId = v.versionId;
        }
        if (fam.maxGxe === null || v.gxe > fam.maxGxe) {
          fam.maxGxe = v.gxe;
        }
        if (v.rankCurrent !== null && (
          fam.bestRank === null || v.rankCurrent < fam.bestRank
        )) {
          fam.bestRank = v.rankCurrent;
          fam.bestRankAt = nowSec;
        }
      }
    }

    const repIdx = repByBot.get(botId);
    const rep = repIdx !== undefined ? entries[repIdx] : undefined;
    const inTop1 = rep !== undefined && rep.settledAt !== null && rep.rankCurrent === 1;
    const inTop10 = rep !== undefined && rep.rankMax !== null && rep.rankMax <= 10;
    const inTop100 = rep !== undefined && rep.rankMax !== null && rep.rankMax <= 100;

    const c1 = advanceTopKClock(
      fam.top1EnteredAt, fam.top1MaxStreakS, fam.top1TotalS, inTop1, nowSec, deltaSec
    );
    fam.top1EnteredAt = c1.enteredAt;
    fam.top1MaxStreakS = c1.maxStreakS;
    fam.top1TotalS = c1.totalS;

    const c10 = advanceTopKClock(
      fam.top10EnteredAt, fam.top10MaxStreakS, fam.top10TotalS, inTop10, nowSec, deltaSec
    );
    fam.top10EnteredAt = c10.enteredAt;
    fam.top10MaxStreakS = c10.maxStreakS;
    fam.top10TotalS = c10.totalS;

    const c100 = advanceTopKClock(
      fam.top100EnteredAt, fam.top100MaxStreakS, fam.top100TotalS, inTop100, nowSec, deltaSec
    );
    fam.top100EnteredAt = c100.enteredAt;
    fam.top100MaxStreakS = c100.maxStreakS;
    fam.top100TotalS = c100.totalS;
  }

  return res;
}

export function recomputeLadderRatings(
  db: DatabaseSync,
  ladderId: string,
  nowSec = Math.floor(Date.now() / 1000),
  prevMatchSec: number | null = null,
  dayUtc?: string
): RatingResult {
  const rawEntries = db.prepare(`
    SELECT
      le.version_id,
      bv.bot_id,
      le.role,
      le.is_anchor,
      le.rating_elo,
      le.rating_se,
      le.rating_lcb,
      le.gxe,
      le.rank_current,
      le.rank_min,
      le.rank_max,
      le.matches_played,
      le.best_rank,
      le.best_rank_at,
      le.max_rating_lcb,
      le.max_elo,
      le.max_elo_se,
      le.max_gxe,
      le.max_elo_at,
      le.top1_entered_at,
      le.top1_max_streak_s,
      le.top1_total_s,
      le.top10_entered_at,
      le.top10_max_streak_s,
      le.top10_total_s,
      le.top100_entered_at,
      le.top100_max_streak_s,
      le.top100_total_s,
      le.settled_at
    FROM ladder_entries le
    JOIN bot_versions bv ON bv.id = le.version_id
    WHERE le.ladder_id = ?
    ORDER BY le.version_id ASC
  `).all(ladderId) as Array<Record<string, unknown>>;

  const entries: EditableLadderEntry[] = [];
  const indexByVersionId = new Map<number, number>();
  let anchorIndex = -1;

  for (let i = 0; i < rawEntries.length; i++) {
    const r = rawEntries[i];
    const versionId = r.version_id as number;
    const isAnchor = r.is_anchor as number;
    indexByVersionId.set(versionId, i);
    if (isAnchor === 1 && anchorIndex === -1) anchorIndex = i;
    entries.push({
      versionId,
      botId: r.bot_id as number,
      role: r.role as EntryRole,
      isAnchor,
      ratingElo: r.rating_elo as number,
      ratingSe: r.rating_se as number,
      ratingLcb: r.rating_lcb as number,
      gxe: r.gxe as number,
      rankCurrent: (r.rank_current as number | null) ?? null,
      rankMin: (r.rank_min as number | null) ?? null,
      rankMax: (r.rank_max as number | null) ?? null,
      matchesPlayed: r.matches_played as number,
      bestRank: (r.best_rank as number | null) ?? null,
      bestRankAt: (r.best_rank_at as number | null) ?? null,
      maxRatingLcb: (r.max_rating_lcb as number | null) ?? null,
      maxElo: (r.max_elo as number | null) ?? null,
      maxEloSe: (r.max_elo_se as number | null) ?? null,
      maxGxe: (r.max_gxe as number | null) ?? null,
      maxEloAt: (r.max_elo_at as number | null) ?? null,
      top1EnteredAt: (r.top1_entered_at as number | null) ?? null,
      top1MaxStreakS: r.top1_max_streak_s as number,
      top1TotalS: r.top1_total_s as number,
      top10EnteredAt: (r.top10_entered_at as number | null) ?? null,
      top10MaxStreakS: r.top10_max_streak_s as number,
      top10TotalS: r.top10_total_s as number,
      top100EnteredAt: (r.top100_entered_at as number | null) ?? null,
      top100MaxStreakS: r.top100_max_streak_s as number,
      top100TotalS: r.top100_total_s as number,
      settledAt: (r.settled_at as number | null) ?? null,
    });
  }

  const {pairs, pairKeys} = loadPairAggregates(db, ladderId, indexByVersionId);
  const families = loadBotLadderStatsMap(db, ladderId);
  const warmStart = new Float64Array(entries.map(v => (v.ratingElo - 1500) / ELO_SCALE));

  const res = applyRatingsToEntriesAndFamilies(
    entries,
    pairs,
    anchorIndex,
    nowSec,
    prevMatchSec,
    families,
    warmStart
  );

  const updateEntry = db.prepare(`
    UPDATE ladder_entries
    SET role = ?,
        rating_elo = ?,
        rating_se = ?,
        rating_lcb = ?,
        gxe = ?,
        rank_current = ?,
        rank_min = ?,
        rank_max = ?,
        best_rank = ?,
        best_rank_at = ?,
        max_rating_lcb = ?,
        max_elo = ?,
        max_elo_se = ?,
        max_gxe = ?,
        max_elo_at = ?,
        top1_entered_at = ?,
        top1_max_streak_s = ?,
        top1_total_s = ?,
        top10_entered_at = ?,
        top10_max_streak_s = ?,
        top10_total_s = ?,
        top100_entered_at = ?,
        top100_max_streak_s = ?,
        top100_total_s = ?,
        settled_at = ?
    WHERE ladder_id = ? AND version_id = ?
  `);

  for (const v of entries) {
    updateEntry.run(
      v.role,
      v.ratingElo,
      v.ratingSe,
      v.ratingLcb,
      v.gxe,
      v.rankCurrent,
      v.rankMin,
      v.rankMax,
      v.bestRank,
      v.bestRankAt,
      v.maxRatingLcb,
      v.maxElo,
      v.maxEloSe,
      v.maxGxe,
      v.maxEloAt,
      v.top1EnteredAt,
      v.top1MaxStreakS,
      v.top1TotalS,
      v.top10EnteredAt,
      v.top10MaxStreakS,
      v.top10TotalS,
      v.top100EnteredAt,
      v.top100MaxStreakS,
      v.top100TotalS,
      v.settledAt,
      ladderId,
      v.versionId
    );
  }

  updatePairAggregateLos(db, ladderId, pairKeys, res.theta, res.covariance, entries.length);
  upsertBotLadderStatsMap(db, ladderId, families);

  if (dayUtc) {
    upsertDailyRatingSnapshots(db, ladderId, dayUtc, entries);
  }

  return res;
}

export function setLadderAnchor(
  db: DatabaseSync,
  inTransaction: TransactionRunner,
  ladderId: string,
  versionId: number,
  now = Math.floor(Date.now() / 1000)
) {
  inTransaction(() => {
    const ladder = getLadder(db, ladderId);
    if (!ladder) throw new Error(`Ladder "${ladderId}" not found`);
    const entry = db.prepare(
      'SELECT 1 FROM ladder_entries WHERE ladder_id = ? AND version_id = ?'
    ).get(ladderId, versionId);
    if (!entry) {
      throw new Error(`Version ${versionId} has no entry on ladder "${ladderId}"`);
    }

    db.prepare('UPDATE ladder_entries SET is_anchor = 0 WHERE ladder_id = ?').run(ladderId);
    db.prepare(
      'UPDATE ladder_entries SET is_anchor = 1 WHERE ladder_id = ? AND version_id = ?'
    ).run(ladderId, versionId);

    const dayUtc = new Date(now * 1000).toISOString().slice(0, 10);
    recomputeLadderRatings(db, ladderId, now, null, dayUtc);
  });
}
