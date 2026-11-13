import {DatabaseSync} from 'node:sqlite';

import * as ratings from '../server/ratings';

import * as stats from './agent-ladder-stats';
import {LadderRow, LadderSlot, LadderStatus, getLadder} from './ladders';
import {loadPairAggregates, updatePairAggregateLos} from './pair-aggregates';
import {upsertDailyRatingSnapshots} from './rating-snapshots';

import {TransactionRunner} from './index';

export type EntryRole = 'champion' | 'challenger' | 'retired' | 'quarantined';

export interface ActiveEntryView {
  ladderId: string;
  slot: LadderSlot;
  ladderName: string;
  ladderStatus: LadderStatus;
  versionId: number;
  version: string;
  role: 'champion' | 'challenger';
  elo: number;
  se: number;
  rankCurrent?: number;
  matches: number;
  ww: number;
  wt: number;
  split: number;
  tl: number;
  ll: number;
  settledAt?: number;
}

export interface LeaderboardEntryView {
  ladderId: string;
  versionId: number;
  version: string;
  agentId: number;
  agentSlug: string;
  agentName: string;
  role: 'champion' | 'challenger' | 'retired';
  isAnchor: boolean;
  retiredAt?: number;
  elo: number;
  se: number;
  lcb: number;
  gxe: number;
  rankCurrent?: number;
  rankMin?: number;
  rankMax?: number;
  matches: number;
  ww: number;
  wt: number;
  split: number;
  tl: number;
  ll: number;
  currentWinStreak: number;
  currentLossStreak: number;
  settledAt?: number;
}

export interface ProjectArenaLadderBadge {
  ladderId: string;
  slot: LadderSlot;
  ladderName: string;
  rank?: number;
  lcb: number;
  provisional: boolean;
}

export interface ProjectArenaSummary {
  agentId: number;
  slug: string;
  name: string;
  status: 'pending' | 'qualified' | 'disabled';
  bestRank?: number;
  bestLcb?: number;
  ladders: ProjectArenaLadderBadge[];
}

export interface AgentLadderProfileEntry {
  ladderId: string;
  versionId: number;
  version: string;
  package: 'bundle' | 'oci';
  unpackedBytes?: number;
  submittedAt: number;
  role: 'champion' | 'challenger' | 'retired';
  isAnchor: boolean;
  retiredAt?: number;
  elo: number;
  se: number;
  lcb: number;
  gxe: number;
  rankCurrent?: number;
  rankMin?: number;
  rankMax?: number;
  matches: number;
  ww: number;
  wt: number;
  split: number;
  tl: number;
  ll: number;
  currentWinStreak: number;
  currentLossStreak: number;
  maxWinStreak: number;
  maxLossStreak: number;
  bestRank?: number;
  bestRankAt?: number;
  maxLcb?: number;
  maxElo?: number;
  maxEloSe?: number;
  maxEloAt?: number;
  maxGxe?: number;
  maxGxeAt?: number;
  top1EnteredAt?: number;
  top1MaxStreakSeconds: number;
  top1TotalSeconds: number;
  top10EnteredAt?: number;
  top10MaxStreakSeconds: number;
  top10TotalSeconds: number;
  top100EnteredAt?: number;
  top100MaxStreakSeconds: number;
  top100TotalSeconds: number;
  meanTurnMillis: number;
  peakRam: number;
  settledAt?: number;
}

export interface LadderStandingOverride {
  versionId: number;
  role?: EntryRole;
  isAnchor?: number;
}

export interface ArenaLadderRoleTarget {
  ladderId: string;
  slot: LadderSlot;
  ladderName: string;
  discordRole: string;
  agentId?: number;
  agentSlug?: string;
  agentName?: string;
  discordIds: string[];
}

interface EditableLadderEntry {
  versionId: number;
  agentId: number;
  role: EntryRole;
  isAnchor: number;
  elo: number;
  se: number;
  lcb: number;
  gxe: number;
  rankCurrent?: number;
  rankMin?: number;
  rankMax?: number;
  matches: number;
  bestRank?: number;
  bestRankAt?: number;
  maxLcb?: number;
  maxElo?: number;
  maxEloSe?: number;
  maxEloAt?: number;
  maxGxe?: number;
  maxGxeAt?: number;
  top1EnteredAt?: number;
  top1MaxStreakSeconds: number;
  top1TotalSeconds: number;
  top10EnteredAt?: number;
  top10MaxStreakSeconds: number;
  top10TotalSeconds: number;
  top100EnteredAt?: number;
  top100MaxStreakSeconds: number;
  top100TotalSeconds: number;
  settledAt?: number;
}

const SLOT_ORDER: Record<LadderSlot, number> = {
  rby: 0,
  adv: 1,
  sv: 2,
  rand: 3,
  vgc: 4,
};

export function getActiveEntriesForAgent(db: DatabaseSync, agentId: number): ActiveEntryView[] {
  const rows = db.prepare(`
    SELECT
      le.ladder_id,
      l.slot,
      l.name AS ladder_name,
      l.status AS ladder_status,
      le.version_id,
      av.version,
      le.role,
      le.elo,
      le.se,
      le.rank_current,
      le.matches,
      le.ww,
      le.wt,
      le.split,
      le.tl,
      le.ll,
      le.settled_at
    FROM ladder_entries le
    JOIN agent_versions av ON av.id = le.version_id
    JOIN ladders l ON l.id = le.ladder_id
    WHERE av.agent_id = ?
      AND av.smoke_status = 'passed'
      AND le.role IN ('champion', 'challenger')
      AND l.status IN ('upcoming', 'active', 'settling')
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
      le.elo DESC
  `).all(agentId) as Array<Record<string, unknown>>;

  return rows.map(r => ({
    ladderId: r.ladder_id as string,
    slot: r.slot as LadderSlot,
    ladderName: r.ladder_name as string,
    ladderStatus: r.ladder_status as LadderStatus,
    versionId: r.version_id as number,
    version: r.version as string,
    role: r.role as 'champion' | 'challenger',
    elo: r.elo as number,
    se: r.se as number,
    rankCurrent: (r.rank_current as number | null) ?? undefined,
    matches: r.matches as number,
    ww: r.ww as number,
    wt: r.wt as number,
    split: r.split as number,
    tl: r.tl as number,
    ll: r.ll as number,
    settledAt: (r.settled_at as number | null) ?? undefined,
  }));
}

export function hasAnyLeaderboardEntry(db: DatabaseSync, agentId: number): boolean {
  const row = db.prepare(`
    SELECT 1
    FROM ladder_entries le
    JOIN agent_versions av ON av.id = le.version_id
    WHERE av.agent_id = ?
      AND av.smoke_status = 'passed'
      AND le.role IN ('champion', 'challenger', 'retired')
    LIMIT 1
  `).get(agentId);
  return row !== undefined;
}

export function getAgentParticipatedLadders(db: DatabaseSync, agentId: number): LadderRow[] {
  const rows = db.prepare(`
    SELECT DISTINCT l.*
    FROM ladders l
    JOIN ladder_entries le ON le.ladder_id = l.id
    JOIN agent_versions av ON av.id = le.version_id
    WHERE av.agent_id = ?
      AND av.smoke_status = 'passed'
      AND le.role IN ('champion', 'challenger', 'retired')
    ORDER BY
      CASE l.status
        WHEN 'active' THEN 0
        WHEN 'settling' THEN 1
        WHEN 'upcoming' THEN 2
        ELSE 3
      END ASC,
      CASE l.slot
        WHEN 'rby' THEN 0
        WHEN 'adv' THEN 1
        WHEN 'sv' THEN 2
        WHEN 'rand' THEN 3
        WHEN 'vgc' THEN 4
        ELSE 5
      END ASC,
      l.created_at DESC
  `).all(agentId) as Array<Record<string, unknown>>;

  return rows.map(r => ({
    id: r.id as string,
    slot: r.slot as LadderSlot,
    name: r.name as string,
    format: r.format as string,
    team: r.team as LadderRow['team'],
    min: r.min as number,
    teams: (r.teams as number | null) ?? undefined,
    discord: (r.discord as string | null) ?? undefined,
    status: r.status as LadderRow['status'],
    createdAt: r.created_at as number,
    archivedAt: (r.archived_at as number | null) ?? undefined,
  }));
}

export function getAgentLadderProfileEntries(
  db: DatabaseSync,
  agentId: number,
  ladderId: string
): AgentLadderProfileEntry[] {
  const rows = db.prepare(`
    SELECT
      le.ladder_id,
      le.version_id,
      av.version,
      av.package,
      av.unpacked_bytes,
      av.submitted_at,
      le.role,
      le.is_anchor,
      le.retired_at,
      le.elo,
      le.se,
      le.lcb,
      le.gxe,
      le.rank_current,
      le.rank_min,
      le.rank_max,
      le.matches,
      le.ww,
      le.wt,
      le.split,
      le.tl,
      le.ll,
      le.current_win_streak,
      le.current_loss_streak,
      le.max_win_streak,
      le.max_loss_streak,
      le.best_rank,
      le.best_rank_at,
      le.max_lcb,
      le.max_elo,
      le.max_elo_se,
      le.max_elo_at,
      le.max_gxe,
      le.max_gxe_at,
      le.top1_entered_at,
      le.top1_max_streak_seconds,
      le.top1_total_seconds,
      le.top10_entered_at,
      le.top10_max_streak_seconds,
      le.top10_total_seconds,
      le.top100_entered_at,
      le.top100_max_streak_seconds,
      le.top100_total_seconds,
      le.mean_turn_millis,
      le.peak_ram,
      le.settled_at
    FROM ladder_entries le
    JOIN agent_versions av ON av.id = le.version_id
    WHERE av.agent_id = ?
      AND le.ladder_id = ?
      AND av.smoke_status = 'passed'
      AND le.role IN ('champion', 'challenger', 'retired')
    ORDER BY av.submitted_at DESC, av.id DESC
  `).all(agentId, ladderId) as Array<Record<string, unknown>>;

  return rows.map(r => ({
    ladderId: r.ladder_id as string,
    versionId: r.version_id as number,
    version: r.version as string,
    package: r.package as 'bundle' | 'oci',
    unpackedBytes: (r.unpacked_bytes as number | null) ?? undefined,
    submittedAt: r.submitted_at as number,
    role: r.role as 'champion' | 'challenger' | 'retired',
    isAnchor: (r.is_anchor as number) === 1,
    retiredAt: (r.retired_at as number | null) ?? undefined,
    elo: r.elo as number,
    se: r.se as number,
    lcb: r.lcb as number,
    gxe: r.gxe as number,
    rankCurrent: (r.rank_current as number | null) ?? undefined,
    rankMin: (r.rank_min as number | null) ?? undefined,
    rankMax: (r.rank_max as number | null) ?? undefined,
    matches: r.matches as number,
    ww: r.ww as number,
    wt: r.wt as number,
    split: r.split as number,
    tl: r.tl as number,
    ll: r.ll as number,
    currentWinStreak: r.current_win_streak as number,
    currentLossStreak: r.current_loss_streak as number,
    maxWinStreak: r.max_win_streak as number,
    maxLossStreak: r.max_loss_streak as number,
    bestRank: (r.best_rank as number | null) ?? undefined,
    bestRankAt: (r.best_rank_at as number | null) ?? undefined,
    maxLcb: (r.max_lcb as number | null) ?? undefined,
    maxElo: (r.max_elo as number | null) ?? undefined,
    maxEloSe: (r.max_elo_se as number | null) ?? undefined,
    maxEloAt: (r.max_elo_at as number | null) ?? undefined,
    maxGxe: (r.max_gxe as number | null) ?? undefined,
    maxGxeAt: (r.max_gxe_at as number | null) ?? undefined,
    top1EnteredAt: (r.top1_entered_at as number | null) ?? undefined,
    top1MaxStreakSeconds: r.top1_max_streak_seconds as number,
    top1TotalSeconds: r.top1_total_seconds as number,
    top10EnteredAt: (r.top10_entered_at as number | null) ?? undefined,
    top10MaxStreakSeconds: r.top10_max_streak_seconds as number,
    top10TotalSeconds: r.top10_total_seconds as number,
    top100EnteredAt: (r.top100_entered_at as number | null) ?? undefined,
    top100MaxStreakSeconds: r.top100_max_streak_seconds as number,
    top100TotalSeconds: r.top100_total_seconds as number,
    meanTurnMillis: r.mean_turn_millis as number,
    peakRam: r.peak_ram as number,
    settledAt: (r.settled_at as number | null) ?? undefined,
  }));
}

export function getLeaderboardEntries(
  db: DatabaseSync,
  ladderId: string
): LeaderboardEntryView[] {
  const rows = db.prepare(`
    SELECT
      le.ladder_id,
      le.version_id,
      av.version,
      av.agent_id,
      a.slug AS agent_slug,
      a.name AS agent_name,
      le.role,
      le.is_anchor,
      le.retired_at,
      le.elo,
      le.se,
      le.lcb,
      le.gxe,
      le.rank_current,
      le.rank_min,
      le.rank_max,
      le.matches,
      le.ww,
      le.wt,
      le.split,
      le.tl,
      le.ll,
      le.current_win_streak,
      le.current_loss_streak,
      le.settled_at
    FROM ladder_entries le
    JOIN agent_versions av ON av.id = le.version_id
    JOIN agents a ON a.id = av.agent_id
    WHERE le.ladder_id = ?
      AND av.smoke_status = 'passed'
      AND le.role IN ('champion', 'challenger', 'retired')
    ORDER BY
      le.lcb DESC,
      le.elo DESC,
      le.version_id ASC
  `).all(ladderId) as Array<Record<string, unknown>>;

  return rows.map(r => ({
    ladderId: r.ladder_id as string,
    versionId: r.version_id as number,
    version: r.version as string,
    agentId: r.agent_id as number,
    agentSlug: r.agent_slug as string,
    agentName: r.agent_name as string,
    role: r.role as 'champion' | 'challenger' | 'retired',
    isAnchor: (r.is_anchor as number) === 1,
    retiredAt: (r.retired_at as number | null) ?? undefined,
    elo: r.elo as number,
    se: r.se as number,
    lcb: r.lcb as number,
    gxe: r.gxe as number,
    rankCurrent: (r.rank_current as number | null) ?? undefined,
    rankMin: (r.rank_min as number | null) ?? undefined,
    rankMax: (r.rank_max as number | null) ?? undefined,
    matches: r.matches as number,
    ww: r.ww as number,
    wt: r.wt as number,
    split: r.split as number,
    tl: r.tl as number,
    ll: r.ll as number,
    currentWinStreak: r.current_win_streak as number,
    currentLossStreak: r.current_loss_streak as number,
    settledAt: (r.settled_at as number | null) ?? undefined,
  }));
}

export function getProjectArenaSummaries(db: DatabaseSync): ProjectArenaSummary[] {
  const agentRows = db.prepare(`
    SELECT id, slug, name, status
    FROM agents
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
      av.agent_id,
      le.ladder_id,
      l.slot,
      l.name AS ladder_name,
      le.rank_current,
      le.lcb,
      le.elo,
      le.se,
      le.matches
    FROM ladder_entries le
    JOIN agent_versions av ON av.id = le.version_id
    JOIN ladders l ON l.id = le.ladder_id
    JOIN agents a ON a.id = av.agent_id
    WHERE a.status != 'disabled'
      AND av.smoke_status = 'passed'
      AND le.role IN ('champion', 'challenger')
      AND l.status IN ('active', 'settling')
    ORDER BY
      le.lcb DESC,
      le.elo DESC,
      le.version_id ASC
  `).all() as Array<{
    agent_id: number;
    ladder_id: string;
    slot: LadderSlot;
    ladder_name: string;
    rank_current: number | null;
    lcb: number;
    elo: number;
    se: number;
    matches: number;
  }>;

  const seenAgentLadder = new Set<string>();
  const badgesByAgent = new Map<number, ProjectArenaLadderBadge[]>();
  for (const r of activeRows) {
    const key = `${r.agent_id}:${r.ladder_id}`;
    if (seenAgentLadder.has(key)) continue;
    seenAgentLadder.add(key);

    const provisional = r.rank_current === null || r.matches < 10 || r.se > 60;
    const list = badgesByAgent.get(r.agent_id) ?? [];
    list.push({
      ladderId: r.ladder_id,
      slot: r.slot,
      ladderName: r.ladder_name,
      rank: provisional ? undefined : (r.rank_current ?? undefined),
      lcb: r.lcb,
      provisional,
    });
    badgesByAgent.set(r.agent_id, list);
  }

  return agentRows.map(a => {
    const ladders = badgesByAgent.get(a.id) ?? [];
    ladders.sort((x, y) => {
      if (x.rank !== undefined && y.rank !== undefined) {
        return x.rank - y.rank || (SLOT_ORDER[x.slot] ?? 99) - (SLOT_ORDER[y.slot] ?? 99);
      }
      if (x.rank !== undefined) return -1;
      if (y.rank !== undefined) return 1;
      return (SLOT_ORDER[x.slot] ?? 99) - (SLOT_ORDER[y.slot] ?? 99);
    });

    let bestRank: number | undefined;
    let bestRankedLcb: number | undefined;
    let bestAnyLcb: number | undefined;
    for (const item of ladders) {
      if (bestAnyLcb === undefined || item.lcb > bestAnyLcb) {
        bestAnyLcb = item.lcb;
      }
      if (item.rank !== undefined) {
        if (bestRank === undefined || item.rank < bestRank) {
          bestRank = item.rank;
        }
        if (bestRankedLcb === undefined || item.lcb > bestRankedLcb) {
          bestRankedLcb = item.lcb;
        }
      }
    }

    return {
      agentId: a.id,
      slug: a.slug,
      name: a.name,
      status: a.status,
      bestRank,
      bestLcb: bestRankedLcb ?? bestAnyLcb,
      ladders,
    };
  });
}

export function promoteRemainingActiveToChampion(
  db: DatabaseSync,
  ladderId: string,
  agentId: number
) {
  const active = db.prepare(`
    SELECT le.version_id
    FROM ladder_entries le
    JOIN agent_versions av ON av.id = le.version_id
    WHERE le.ladder_id = ?
      AND av.agent_id = ?
      AND le.role IN ('champion', 'challenger')
    ORDER BY le.lcb DESC, le.elo DESC, le.version_id ASC
  `).all(ladderId, agentId) as Array<{version_id: number}>;

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

// Applies a single Generalized Davidson MAP solve across all entries on a ladder (active AND
// retired—retired entries remain in the graph so cross-version calibration and retired 1500-Elo
// anchors never drift), then updates Champion/Challenger roles, official conservative LCB ranks,
// 95% confidence rank intervals, peak stats, and Top-1 / Top-10 / Top-100 reign clocks.
function applyRatingsToEntriesAndFamilies(
  entries: EditableLadderEntry[],
  pairs: ratings.PairMatchCounts[],
  anchorIndex: number,
  nowSec: number,
  prevMatchSec: number | undefined,
  families: Map<number, stats.AgentLadderStatsRow>,
  warmStartTheta: Float64Array
): ratings.RatingResult {
  const M = entries.length;
  // Cap per-match wall-clock increments at 3600s so runner maintenance or downtime never inflates
  // an incumbent's Top-K reign duration.
  const deltaSeconds = prevMatchSec !== undefined
    ? Math.min(3600, Math.max(0, nowSec - prevMatchSec))
    : 0;
  const res = ratings.computeDavidsonRatings(M, pairs, anchorIndex, 1500, warmStartTheta);

  const activeIndicesByAgent = new Map<number, number[]>();
  for (let i = 0; i < M; i++) {
    const v = entries[i];
    v.elo = res.elo[i];
    v.se = res.eloStd[i];
    v.lcb = res.eloLcb[i];
    v.gxe = res.gxe[i];
    if (v.settledAt === undefined && v.matches >= 25 && v.se <= 30.0) {
      v.settledAt = nowSec;
    }
    if (v.role === 'champion' || v.role === 'challenger') {
      const list = activeIndicesByAgent.get(v.agentId) ?? [];
      list.push(i);
      activeIndicesByAgent.set(v.agentId, list);
    }
  }

  for (const indices of activeIndicesByAgent.values()) {
    indices.sort((a, b) => (
      entries[b].lcb - entries[a].lcb ||
      entries[b].elo - entries[a].elo ||
      entries[a].versionId - entries[b].versionId
    ));
    entries[indices[0]].role = 'champion';
    for (let k = 1; k < indices.length; k++) {
      entries[indices[k]].role = 'challenger';
    }
  }

  // Only one representative active version per agent (highest LCB meeting the 10-match / SE <= 60
  // provisional gate) receives an official rank so an agent's Challenger cannot occupy a second
  // leaderboard rank slot.
  const repByAgent = new Map<number, number>();
  for (let i = 0; i < M; i++) {
    const v = entries[i];
    const isActive = v.role === 'champion' || v.role === 'challenger';
    const passesProvisionalGate = v.matches >= 10 && v.se <= 60.0;
    if (!isActive || !passesProvisionalGate) {
      v.rankCurrent = undefined;
      v.rankMin = undefined;
      v.rankMax = undefined;
      continue;
    }
    const prevIdx = repByAgent.get(v.agentId);
    if (prevIdx === undefined || v.lcb > entries[prevIdx].lcb) {
      if (prevIdx !== undefined) {
        entries[prevIdx].rankCurrent = undefined;
        entries[prevIdx].rankMin = undefined;
        entries[prevIdx].rankMax = undefined;
      }
      repByAgent.set(v.agentId, i);
    } else {
      v.rankCurrent = undefined;
      v.rankMin = undefined;
      v.rankMax = undefined;
    }
  }

  const repIndices = [...repByAgent.values()].sort(
    (a, b) => entries[b].lcb - entries[a].lcb
  );
  const {rankMin, rankMax} = ratings.computeGuaranteedRankBounds(
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

  const agentIds = new Set<number>();
  for (const v of entries) {
    agentIds.add(v.agentId);

    if (v.matches >= 10 && (v.maxLcb === undefined || v.lcb > v.maxLcb)) {
      v.maxLcb = v.lcb;
    }

    if (v.settledAt !== undefined) {
      if (v.maxElo === undefined || v.elo > v.maxElo) {
        v.maxElo = v.elo;
        v.maxEloSe = v.se;
        v.maxEloAt = nowSec;
      }
      if (v.maxGxe === undefined || v.gxe > v.maxGxe) {
        v.maxGxe = v.gxe;
        v.maxGxeAt = nowSec;
      }
      if (v.rankCurrent !== undefined && (v.bestRank === undefined || v.rankCurrent < v.bestRank)) {
        v.bestRank = v.rankCurrent;
        v.bestRankAt = nowSec;
      }
    }

    // Reign clock asymmetry: Top-1 requires `settledAt !== undefined && rankCurrent === 1`
    // (otherwise two close contenders with overlapping 95% CIs would leave #1 permanently empty),
    // whereas Top-10 and Top-100 require guaranteed 95% confidence (`rankMax <= K`).
    const inTop1 = v.settledAt !== undefined && v.rankCurrent === 1;
    const inTop10 = v.rankMax !== undefined && v.rankMax <= 10;
    const inTop100 = v.rankMax !== undefined && v.rankMax <= 100;

    const c1 = ratings.advanceTopKClock(
      v.top1EnteredAt,
      v.top1MaxStreakSeconds,
      v.top1TotalSeconds,
      inTop1,
      nowSec,
      deltaSeconds
    );
    v.top1EnteredAt = c1.enteredAt;
    v.top1MaxStreakSeconds = c1.maxStreakSeconds;
    v.top1TotalSeconds = c1.totalSeconds;

    const c10 = ratings.advanceTopKClock(
      v.top10EnteredAt,
      v.top10MaxStreakSeconds,
      v.top10TotalSeconds,
      inTop10,
      nowSec,
      deltaSeconds
    );
    v.top10EnteredAt = c10.enteredAt;
    v.top10MaxStreakSeconds = c10.maxStreakSeconds;
    v.top10TotalSeconds = c10.totalSeconds;

    const c100 = ratings.advanceTopKClock(
      v.top100EnteredAt,
      v.top100MaxStreakSeconds,
      v.top100TotalSeconds,
      inTop100,
      nowSec,
      deltaSeconds
    );
    v.top100EnteredAt = c100.enteredAt;
    v.top100MaxStreakSeconds = c100.maxStreakSeconds;
    v.top100TotalSeconds = c100.totalSeconds;
  }

  for (const agentId of agentIds) {
    let fam = families.get(agentId);
    if (!fam) {
      fam = stats.createEmptyAgentLadderStats(agentId);
      families.set(agentId, fam);
    }

    for (const v of entries) {
      if (v.agentId !== agentId) continue;
      if (v.maxLcb !== undefined && (fam.maxLcb === undefined || v.maxLcb > fam.maxLcb)) {
        fam.maxLcb = v.maxLcb;
      }
      if (v.maxElo !== undefined && (fam.maxElo === undefined || v.maxElo > fam.maxElo)) {
        fam.maxElo = v.maxElo;
        fam.maxEloSe = v.maxEloSe;
        fam.maxEloAt = v.maxEloAt;
        fam.maxEloVersionId = v.versionId;
      }
      if (v.maxGxe !== undefined && (fam.maxGxe === undefined || v.maxGxe > fam.maxGxe)) {
        fam.maxGxe = v.maxGxe;
        fam.maxGxeAt = v.maxGxeAt;
      }
      if (v.bestRank !== undefined && (fam.bestRank === undefined || v.bestRank < fam.bestRank)) {
        fam.bestRank = v.bestRank;
        fam.bestRankAt = v.bestRankAt;
      }
    }

    const repIdx = repByAgent.get(agentId);
    const rep = repIdx !== undefined ? entries[repIdx] : undefined;
    const inTop1 = rep?.settledAt !== undefined && rep.rankCurrent === 1;
    const inTop10 = rep?.rankMax !== undefined && rep.rankMax <= 10;
    const inTop100 = rep?.rankMax !== undefined && rep.rankMax <= 100;

    const c1 = ratings.advanceTopKClock(
      fam.top1EnteredAt,
      fam.top1MaxStreakSeconds,
      fam.top1TotalSeconds,
      inTop1,
      nowSec,
      deltaSeconds
    );
    fam.top1EnteredAt = c1.enteredAt;
    fam.top1MaxStreakSeconds = c1.maxStreakSeconds;
    fam.top1TotalSeconds = c1.totalSeconds;

    const c10 = ratings.advanceTopKClock(
      fam.top10EnteredAt,
      fam.top10MaxStreakSeconds,
      fam.top10TotalSeconds,
      inTop10,
      nowSec,
      deltaSeconds
    );
    fam.top10EnteredAt = c10.enteredAt;
    fam.top10MaxStreakSeconds = c10.maxStreakSeconds;
    fam.top10TotalSeconds = c10.totalSeconds;

    const c100 = ratings.advanceTopKClock(
      fam.top100EnteredAt,
      fam.top100MaxStreakSeconds,
      fam.top100TotalSeconds,
      inTop100,
      nowSec,
      deltaSeconds
    );
    fam.top100EnteredAt = c100.enteredAt;
    fam.top100MaxStreakSeconds = c100.maxStreakSeconds;
    fam.top100TotalSeconds = c100.totalSeconds;
  }

  return res;
}

export function recomputeLadderRatings(
  db: DatabaseSync,
  ladderId: string,
  nowSec = Math.floor(Date.now() / 1000),
  prevMatchSec?: number,
  dayUtc?: string
): ratings.RatingResult {
  const ladder = getLadder(db, ladderId);
  const isArchived = ladder?.status === 'archived';
  const rawEntries = db.prepare(`
    SELECT
      le.version_id,
      av.agent_id,
      le.role,
      le.is_anchor,
      le.elo,
      le.se,
      le.lcb,
      le.gxe,
      le.rank_current,
      le.rank_min,
      le.rank_max,
      le.matches,
      le.best_rank,
      le.best_rank_at,
      le.max_lcb,
      le.max_elo,
      le.max_elo_se,
      le.max_elo_at,
      le.max_gxe,
      le.max_gxe_at,
      le.top1_entered_at,
      le.top1_max_streak_seconds,
      le.top1_total_seconds,
      le.top10_entered_at,
      le.top10_max_streak_seconds,
      le.top10_total_seconds,
      le.top100_entered_at,
      le.top100_max_streak_seconds,
      le.top100_total_seconds,
      le.settled_at
    FROM ladder_entries le
    JOIN agent_versions av ON av.id = le.version_id
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
      agentId: r.agent_id as number,
      role: r.role as EntryRole,
      isAnchor,
      elo: r.elo as number,
      se: r.se as number,
      lcb: r.lcb as number,
      gxe: r.gxe as number,
      rankCurrent: (r.rank_current as number | null) ?? undefined,
      rankMin: (r.rank_min as number | null) ?? undefined,
      rankMax: (r.rank_max as number | null) ?? undefined,
      matches: r.matches as number,
      bestRank: (r.best_rank as number | null) ?? undefined,
      bestRankAt: (r.best_rank_at as number | null) ?? undefined,
      maxLcb: (r.max_lcb as number | null) ?? undefined,
      maxElo: (r.max_elo as number | null) ?? undefined,
      maxEloSe: (r.max_elo_se as number | null) ?? undefined,
      maxEloAt: (r.max_elo_at as number | null) ?? undefined,
      maxGxe: (r.max_gxe as number | null) ?? undefined,
      maxGxeAt: (r.max_gxe_at as number | null) ?? undefined,
      top1EnteredAt: (r.top1_entered_at as number | null) ?? undefined,
      top1MaxStreakSeconds: r.top1_max_streak_seconds as number,
      top1TotalSeconds: r.top1_total_seconds as number,
      top10EnteredAt: (r.top10_entered_at as number | null) ?? undefined,
      top10MaxStreakSeconds: r.top10_max_streak_seconds as number,
      top10TotalSeconds: r.top10_total_seconds as number,
      top100EnteredAt: (r.top100_entered_at as number | null) ?? undefined,
      top100MaxStreakSeconds: r.top100_max_streak_seconds as number,
      top100TotalSeconds: r.top100_total_seconds as number,
      settledAt: (r.settled_at as number | null) ?? undefined,
    });
  }

  const {pairs, pairKeys} = loadPairAggregates(db, ladderId, indexByVersionId);
  const families = stats.loadAgentLadderStatsMap(db, ladderId);
  const warmStart = new Float64Array(entries.map(v => (v.elo - 1500) / ratings.ELO_SCALE));

  const frozenStandings = isArchived
    ? new Map(
      entries.map(v => [
        v.versionId,
        {
          role: v.role,
          rankCurrent: v.rankCurrent,
          rankMin: v.rankMin,
          rankMax: v.rankMax,
          bestRank: v.bestRank,
          bestRankAt: v.bestRankAt,
        },
      ])
    )
    : undefined;

  const res = applyRatingsToEntriesAndFamilies(
    entries,
    pairs,
    anchorIndex,
    nowSec,
    isArchived ? undefined : prevMatchSec,
    families,
    warmStart
  );

  if (frozenStandings) {
    for (const v of entries) {
      const snap = frozenStandings.get(v.versionId);
      if (!snap) continue;
      v.role = snap.role;
      v.rankCurrent = snap.rankCurrent;
      v.rankMin = snap.rankMin;
      v.rankMax = snap.rankMax;
      v.bestRank = snap.bestRank;
      v.bestRankAt = snap.bestRankAt;
    }
  }

  const updateEntry = db.prepare(`
    UPDATE ladder_entries
    SET role = ?,
        elo = ?,
        se = ?,
        lcb = ?,
        gxe = ?,
        rank_current = ?,
        rank_min = ?,
        rank_max = ?,
        best_rank = ?,
        best_rank_at = ?,
        max_lcb = ?,
        max_elo = ?,
        max_elo_se = ?,
        max_elo_at = ?,
        max_gxe = ?,
        max_gxe_at = ?,
        top1_entered_at = ?,
        top1_max_streak_seconds = ?,
        top1_total_seconds = ?,
        top10_entered_at = ?,
        top10_max_streak_seconds = ?,
        top10_total_seconds = ?,
        top100_entered_at = ?,
        top100_max_streak_seconds = ?,
        top100_total_seconds = ?,
        settled_at = ?
    WHERE ladder_id = ? AND version_id = ?
  `);

  for (const v of entries) {
    updateEntry.run(
      v.role,
      v.elo,
      v.se,
      v.lcb,
      v.gxe,
      v.rankCurrent ?? null,
      v.rankMin ?? null,
      v.rankMax ?? null,
      v.bestRank ?? null,
      v.bestRankAt ?? null,
      v.maxLcb ?? null,
      v.maxElo ?? null,
      v.maxEloSe ?? null,
      v.maxEloAt ?? null,
      v.maxGxe ?? null,
      v.maxGxeAt ?? null,
      v.top1EnteredAt ?? null,
      v.top1MaxStreakSeconds,
      v.top1TotalSeconds,
      v.top10EnteredAt ?? null,
      v.top10MaxStreakSeconds,
      v.top10TotalSeconds,
      v.top100EnteredAt ?? null,
      v.top100MaxStreakSeconds,
      v.top100TotalSeconds,
      v.settledAt ?? null,
      ladderId,
      v.versionId
    );
  }

  updatePairAggregateLos(db, ladderId, pairKeys, res.theta, res.covariance, entries.length);
  stats.upsertAgentLadderStatsMap(db, ladderId, families);

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
    if (ladder.status === 'archived') {
      throw new Error(`Cannot change anchor on archived ladder "${ladderId}"`);
    }
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
    recomputeLadderRatings(db, ladderId, now, undefined, dayUtc);
  });
}

// Resolves the settled #1-ranked active agent on each active ladder with a configured `discord`
// role Snowflake so `server/discord.ts` can synchronize #1 crown roles automatically.
export function getArenaLadderRoleTargets(db: DatabaseSync): ArenaLadderRoleTarget[] {
  const ladders = db.prepare(`
    SELECT id, slot, name, discord, status
    FROM ladders
    WHERE discord IS NOT NULL
    ORDER BY
      CASE status
        WHEN 'active' THEN 0
        WHEN 'settling' THEN 1
        WHEN 'upcoming' THEN 2
        ELSE 3
      END ASC,
      CASE slot
        WHEN 'rby' THEN 0
        WHEN 'adv' THEN 1
        WHEN 'sv' THEN 2
        WHEN 'rand' THEN 3
        WHEN 'vgc' THEN 4
        ELSE 5
      END ASC,
      created_at DESC,
      id ASC
  `).all() as Array<{
    id: string;
    slot: LadderSlot;
    name: string;
    discord: string;
    status: string;
  }>;

  const selectLeader = db.prepare(`
    SELECT a.id AS agent_id, a.slug AS agent_slug, a.name AS agent_name
    FROM ladder_entries le
    JOIN agent_versions av ON av.id = le.version_id
    JOIN agents a ON a.id = av.agent_id
    WHERE le.ladder_id = ?
      AND le.rank_current = 1
      AND le.settled_at IS NOT NULL
      AND le.role IN ('champion', 'challenger')
      AND av.smoke_status = 'passed'
      AND a.status != 'disabled'
    ORDER BY le.lcb DESC, le.elo DESC, le.version_id ASC
    LIMIT 1
  `);
  const selectOwnerDiscordIds = db.prepare(`
    SELECT DISTINCT discord_id
    FROM developers
    WHERE agent_id = ? AND discord_id IS NOT NULL AND smogon_standing != 'bad'
    ORDER BY discord_id ASC
  `);

  const seenRoles = new Set<string>();
  const targets: ArenaLadderRoleTarget[] = [];

  for (const l of ladders) {
    if (seenRoles.has(l.discord)) continue;
    seenRoles.add(l.discord);

    if (l.status !== 'active') {
      targets.push({
        ladderId: l.id,
        slot: l.slot,
        ladderName: l.name,
        discordRole: l.discord,
        discordIds: [],
      });
      continue;
    }

    const leader = selectLeader.get(l.id) as {
      agent_id: number;
      agent_slug: string;
      agent_name: string;
    } | undefined;
    if (!leader) {
      targets.push({
        ladderId: l.id,
        slot: l.slot,
        ladderName: l.name,
        discordRole: l.discord,
        discordIds: [],
      });
      continue;
    }

    const discordIds = (
      selectOwnerDiscordIds.all(leader.agent_id) as Array<{discord_id: string}>
    ).map(r => r.discord_id);
    targets.push({
      ladderId: l.id,
      slot: l.slot,
      ladderName: l.name,
      discordRole: l.discord,
      agentId: leader.agent_id,
      agentSlug: leader.agent_slug,
      agentName: leader.agent_name,
      discordIds,
    });
  }

  targets.sort((a, b) => (SLOT_ORDER[a.slot] ?? 99) - (SLOT_ORDER[b.slot] ?? 99));
  return targets;
}
