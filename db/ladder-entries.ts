import {DatabaseSync} from 'node:sqlite';

import * as ratings from '../server/ratings';
import {formatUtcDate} from '../static/util';

import * as stats from './agent-ladder-stats';
import {
  LadderRow,
  LadderSlot,
  LadderStatus,
  SLOT_ORDER_SQL,
  archiveLadderInPlace,
  canSettleLadder,
  getLadder,
} from './ladders';
import {loadPairAggregates, updatePairAggregateLos} from './pair-aggregates';
import {upsertDailyRatingSnapshots} from './rating-snapshots';
import {InfoStatus, MIN_INFO_STATUS_SQL} from './smoke-diagnostics';

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
  isAnchor: boolean;
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
  smokeInfoStatus?: InfoStatus;
}

export interface LeaderboardEntryView {
  ladderId: string;
  versionId: number;
  version: string;
  submittedAt: number;
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
  infoStatus?: InfoStatus;
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
  meanInitMillis: number;
  meanTeamPreviewMillis?: number;
  meanTurnMillis: number;
  meanRam: number;
  peakRam: number;
  meanCpuCores: number;
  cpuMatches: number;
  crashes: number;
  timeouts: number;
  ooms: number;
  invalidChoices: number;
  invalidCantMove: number;
  invalidCantSwitch: number;
  invalidTarget: number;
  invalidOther: number;
  unavailableChoices: number;
  settledAt?: number;
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
      le.is_anchor,
      le.elo,
      le.se,
      le.rank_current,
      le.matches,
      le.ww,
      le.wt,
      le.split,
      le.tl,
      le.ll,
      le.settled_at,
      COALESCE(
        (
          SELECT ${MIN_INFO_STATUS_SQL}
          FROM smoke_diagnostics sd
          WHERE sd.version_id = le.version_id AND sd.ladder_id = le.ladder_id
        ),
        (
          SELECT ${MIN_INFO_STATUS_SQL}
          FROM smoke_diagnostics sd
          WHERE sd.version_id = le.version_id
        )
      ) AS smoke_info_status
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
    isAnchor: (r.is_anchor as number) === 1,
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
    ...(r.smoke_info_status === null || r.smoke_info_status === undefined
      ? {}
      : {smokeInfoStatus: r.smoke_info_status as InfoStatus}),
  }));
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
    version: r.version as string,
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
      le.mean_init_millis,
      le.mean_team_preview_millis,
      le.mean_turn_millis,
      le.mean_ram,
      le.peak_ram,
      le.mean_cpu_cores,
      le.cpu_matches,
      le.crashes,
      le.timeouts,
      le.ooms,
      le.invalid_choices,
      le.invalid_cant_move,
      le.invalid_cant_switch,
      le.invalid_target,
      le.invalid_other,
      le.unavailable_choices,
      le.settled_at,
      COALESCE(
        (
          SELECT ${MIN_INFO_STATUS_SQL}
          FROM smoke_diagnostics sd
          WHERE sd.version_id = le.version_id AND sd.ladder_id = le.ladder_id
        ),
        (
          SELECT ${MIN_INFO_STATUS_SQL}
          FROM smoke_diagnostics sd
          WHERE sd.version_id = le.version_id
        )
      ) AS info_status
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
    meanInitMillis: r.mean_init_millis as number,
    meanTeamPreviewMillis: (r.mean_team_preview_millis as number | null) ?? undefined,
    meanTurnMillis: r.mean_turn_millis as number,
    meanRam: r.mean_ram as number,
    peakRam: r.peak_ram as number,
    meanCpuCores: r.mean_cpu_cores as number,
    cpuMatches: r.cpu_matches as number,
    crashes: r.crashes as number,
    timeouts: r.timeouts as number,
    ooms: r.ooms as number,
    invalidChoices: r.invalid_choices as number,
    invalidCantMove: r.invalid_cant_move as number,
    invalidCantSwitch: r.invalid_cant_switch as number,
    invalidTarget: r.invalid_target as number,
    invalidOther: r.invalid_other as number,
    unavailableChoices: r.unavailable_choices as number,
    settledAt: (r.settled_at as number | null) ?? undefined,
    ...(r.info_status === null || r.info_status === undefined
      ? {}
      : {infoStatus: r.info_status as InfoStatus}),
  }));
}

export interface AgentLadderArtifact {
  package: 'bundle' | 'oci';
  unpackedBytes?: number;
}

export function getLatestAgentLadderArtifact(
  db: DatabaseSync,
  agentId: number
): AgentLadderArtifact | undefined {
  const row = db.prepare(`
    SELECT av.package, av.unpacked_bytes
    FROM ladder_entries le
    JOIN agent_versions av ON av.id = le.version_id
    WHERE av.agent_id = ?
      AND av.smoke_status = 'passed'
      AND le.role IN ('champion', 'challenger', 'retired')
    ORDER BY av.submitted_at DESC, av.id DESC
    LIMIT 1
  `).get(agentId) as {package: 'bundle' | 'oci'; unpacked_bytes: number | null} | undefined;
  if (!row) return undefined;
  return {
    package: row.package,
    unpackedBytes: row.unpacked_bytes ?? undefined,
  };
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
      av.submitted_at,
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
    submittedAt: r.submitted_at as number,
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

export function getQuarantinedVersionIds(db: DatabaseSync): number[] {
  const rows = db.prepare(`
    SELECT DISTINCT version_id
    FROM ladder_entries
    WHERE role = 'quarantined'
    ORDER BY version_id ASC
  `).all() as Array<{version_id: number}>;
  return rows.map(r => r.version_id);
}

export interface LadderVersionIdentity {
  versionId: number;
  version: string;
  agentId: number;
  agentSlug: string;
  agentName: string;
}

export function getVersionIdentitiesByIds(
  db: DatabaseSync,
  versionIds: number[]
): LadderVersionIdentity[] {
  if (versionIds.length === 0) return [];
  const placeholders = versionIds.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT
      av.id AS version_id,
      av.version,
      av.agent_id,
      a.slug AS agent_slug,
      a.name AS agent_name
    FROM agent_versions av
    JOIN agents a ON a.id = av.agent_id
    WHERE av.id IN (${placeholders})
  `).all(...versionIds) as Array<{
    version_id: number;
    version: string;
    agent_id: number;
    agent_slug: string;
    agent_name: string;
  }>;
  return rows.map(r => ({
    versionId: r.version_id,
    version: r.version,
    agentId: r.agent_id,
    agentSlug: r.agent_slug,
    agentName: r.agent_name,
  }));
}

export interface LadderHubWinner {
  slug: string;
  name: string;
  version: string;
  elo: number;
  ci95: number;
  gxe: number;
  wins: number;
  losses: number;
  ties: number;
}

export interface LadderHubSummary {
  entrantCount: number;
  matchCount: number;
  hasActiveEntries: boolean;
  top1?: LadderHubWinner;
}

export function getLadderHubSummaries(db: DatabaseSync): Map<string, LadderHubSummary> {
  const entryRows = db.prepare(`
    SELECT
      le.ladder_id,
      l.status,
      COUNT(DISTINCT av.agent_id) AS any_agents,
      COUNT(DISTINCT CASE
        WHEN le.role IN ('champion', 'challenger') THEN av.agent_id
      END) AS active_agents,
      COUNT(DISTINCT CASE
        WHEN le.rank_current IS NOT NULL THEN av.agent_id
      END) AS ranked_agents,
      SUM(CASE WHEN le.role IN ('champion', 'challenger') THEN 1 ELSE 0 END) AS active_entries,
      COALESCE(SUM(le.matches), 0) AS entry_matches
    FROM ladder_entries le
    JOIN ladders l ON l.id = le.ladder_id
    JOIN agent_versions av ON av.id = le.version_id
    WHERE av.smoke_status = 'passed'
      AND le.role IN ('champion', 'challenger', 'retired')
    GROUP BY le.ladder_id
  `).all() as Array<{
    ladder_id: string;
    status: LadderStatus;
    any_agents: number;
    active_agents: number;
    ranked_agents: number;
    active_entries: number;
    entry_matches: number;
  }>;

  const pairRows = db.prepare(`
    SELECT ladder_id, COALESCE(SUM(ww + wt + split + tl + ll), 0) AS pair_matches
    FROM pair_aggregates
    GROUP BY ladder_id
  `).all() as Array<{ladder_id: string; pair_matches: number}>;
  const pairMatchesByLadder = new Map(pairRows.map(r => [r.ladder_id, r.pair_matches]));

  const winnerRows = db.prepare(`
    SELECT
      le.ladder_id,
      a.slug,
      a.name,
      av.version,
      le.is_anchor,
      le.elo,
      le.se,
      le.gxe,
      le.ww,
      le.wt,
      le.ll,
      le.tl,
      le.split
    FROM ladder_entries le
    JOIN ladders l ON l.id = le.ladder_id
    JOIN agent_versions av ON av.id = le.version_id
    JOIN agents a ON a.id = av.agent_id
    WHERE av.smoke_status = 'passed'
      AND l.status != 'upcoming'
      AND le.rank_current = 1
      AND le.matches >= 10
      AND le.se <= 60
      AND (
        (l.status = 'archived' AND le.role IN ('champion', 'challenger', 'retired'))
        OR le.role IN ('champion', 'challenger')
      )
    ORDER BY le.lcb DESC, le.elo DESC, le.version_id ASC
  `).all() as Array<{
    ladder_id: string;
    slug: string;
    name: string;
    version: string;
    is_anchor: number;
    elo: number;
    se: number;
    gxe: number;
    ww: number;
    wt: number;
    ll: number;
    tl: number;
    split: number;
  }>;

  const top1ByLadder = new Map<string, LadderHubWinner>();
  for (const r of winnerRows) {
    if (top1ByLadder.has(r.ladder_id)) continue;
    top1ByLadder.set(r.ladder_id, {
      slug: r.slug,
      name: r.name,
      version: r.version,
      elo: Math.round(r.elo),
      ci95: r.is_anchor === 1 ? 0 : Math.round(1.96 * r.se),
      gxe: Math.round(r.gxe * 10) / 10,
      wins: r.ww + r.wt,
      losses: r.ll + r.tl,
      ties: r.split,
    });
  }

  const out = new Map<string, LadderHubSummary>();
  for (const r of entryRows) {
    const entrantCount = r.status === 'upcoming'
      ? r.active_agents
      : r.status === 'archived'
        ? (r.ranked_agents || r.any_agents)
        : (r.active_agents || r.any_agents);
    const pairTotal = pairMatchesByLadder.get(r.ladder_id) ?? 0;
    const matchCount = r.status === 'upcoming'
      ? 0
      : pairTotal > 0
        ? pairTotal
        : Math.round(r.entry_matches / 2);
    out.set(r.ladder_id, {
      entrantCount,
      matchCount,
      hasActiveEntries: r.active_entries > 0,
      top1: top1ByLadder.get(r.ladder_id),
    });
  }
  return out;
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
function applyRatingsToEntriesAndFamilies(opts: {
  entries: EditableLadderEntry[];
  pairs: ratings.PairMatchCounts[];
  anchorIndex: number;
  nowSec: number;
  prevMatchSec?: number;
  families: Map<number, stats.AgentLadderStatsRow>;
  warmStartTheta: Float64Array;
}): ratings.RatingResult {
  const {entries, pairs, anchorIndex, nowSec, prevMatchSec, families, warmStartTheta} = opts;
  const M = entries.length;
  // Cap per-match wall-clock increments at 3600s so runner maintenance or downtime never inflates
  // an incumbent's Top-K reign duration.
  const rawElapsed = prevMatchSec !== undefined ? Math.max(0, nowSec - prevMatchSec) : 0;
  const deltaSeconds = Math.min(3600, rawElapsed);
  const uncountedSeconds = rawElapsed - deltaSeconds;
  const tick: ratings.ClockTick = {nowSeconds: nowSec, deltaSeconds, uncountedSeconds};
  const res = ratings.computeDavidsonRatings(M, pairs, {
    anchorIndex,
    warmStartTheta,
  });

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
  const {rankMin, rankMax} = ratings.computeGuaranteedRankBounds(repIndices, res);

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
      {
        enteredAt: v.top1EnteredAt,
        maxStreakSeconds: v.top1MaxStreakSeconds,
        totalSeconds: v.top1TotalSeconds,
      },
      inTop1,
      tick
    );
    v.top1EnteredAt = c1.enteredAt;
    v.top1MaxStreakSeconds = c1.maxStreakSeconds;
    v.top1TotalSeconds = c1.totalSeconds;

    const c10 = ratings.advanceTopKClock(
      {
        enteredAt: v.top10EnteredAt,
        maxStreakSeconds: v.top10MaxStreakSeconds,
        totalSeconds: v.top10TotalSeconds,
      },
      inTop10,
      tick
    );
    v.top10EnteredAt = c10.enteredAt;
    v.top10MaxStreakSeconds = c10.maxStreakSeconds;
    v.top10TotalSeconds = c10.totalSeconds;

    const c100 = ratings.advanceTopKClock(
      {
        enteredAt: v.top100EnteredAt,
        maxStreakSeconds: v.top100MaxStreakSeconds,
        totalSeconds: v.top100TotalSeconds,
      },
      inTop100,
      tick
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
      {
        enteredAt: fam.top1EnteredAt,
        maxStreakSeconds: fam.top1MaxStreakSeconds,
        totalSeconds: fam.top1TotalSeconds,
      },
      inTop1,
      tick
    );
    fam.top1EnteredAt = c1.enteredAt;
    fam.top1MaxStreakSeconds = c1.maxStreakSeconds;
    fam.top1TotalSeconds = c1.totalSeconds;

    const c10 = ratings.advanceTopKClock(
      {
        enteredAt: fam.top10EnteredAt,
        maxStreakSeconds: fam.top10MaxStreakSeconds,
        totalSeconds: fam.top10TotalSeconds,
      },
      inTop10,
      tick
    );
    fam.top10EnteredAt = c10.enteredAt;
    fam.top10MaxStreakSeconds = c10.maxStreakSeconds;
    fam.top10TotalSeconds = c10.totalSeconds;

    const c100 = ratings.advanceTopKClock(
      {
        enteredAt: fam.top100EnteredAt,
        maxStreakSeconds: fam.top100MaxStreakSeconds,
        totalSeconds: fam.top100TotalSeconds,
      },
      inTop100,
      tick
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

  const res = applyRatingsToEntriesAndFamilies({
    entries,
    pairs,
    anchorIndex,
    nowSec,
    prevMatchSec: isArchived ? undefined : prevMatchSec,
    families,
    warmStartTheta: warmStart,
  });

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

  updatePairAggregateLos(db, ladderId, pairKeys, res);
  stats.upsertAgentLadderStatsMap(db, ladderId, families);

  if (dayUtc) {
    upsertDailyRatingSnapshots(
      db,
      ladderId,
      dayUtc,
      entries.filter(v => v.role === 'champion' || v.role === 'challenger')
    );
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
    const entry = db.prepare(`
      SELECT le.role, av.smoke_status, a.status AS agent_status
      FROM ladder_entries le
      JOIN agent_versions av ON av.id = le.version_id
      JOIN agents a ON a.id = av.agent_id
      WHERE le.ladder_id = ? AND le.version_id = ?
    `).get(ladderId, versionId) as {
      role: EntryRole;
      smoke_status: string;
      agent_status: string;
    } | undefined;
    if (!entry) {
      throw new Error(`Version ${versionId} has no entry on ladder "${ladderId}"`);
    }

    const prevAnchors = db.prepare(`
      SELECT DISTINCT av.agent_id
      FROM ladder_entries le
      JOIN agent_versions av ON av.id = le.version_id
      WHERE le.ladder_id = ? AND le.is_anchor = 1
    `).all(ladderId) as Array<{agent_id: number}>;

    db.prepare('UPDATE ladder_entries SET is_anchor = 0 WHERE ladder_id = ?').run(ladderId);
    if (
      entry.role === 'retired' &&
      entry.smoke_status === 'passed' &&
      entry.agent_status !== 'disabled'
    ) {
      db.prepare(`
        UPDATE ladder_entries
        SET is_anchor = 1, role = 'challenger', retired_at = NULL
        WHERE ladder_id = ? AND version_id = ?
      `).run(ladderId, versionId);
    } else {
      db.prepare(
        'UPDATE ladder_entries SET is_anchor = 1 WHERE ladder_id = ? AND version_id = ?'
      ).run(ladderId, versionId);
    }

    // If an agent previously held the anchor alongside 2 other active versions, clearing
    // `is_anchor = 0` leaves 3 non-anchor active versions—trim excess back to the 2-version cap.
    const selectNonAnchorActive = db.prepare(`
      SELECT le.version_id
      FROM ladder_entries le
      JOIN agent_versions av ON av.id = le.version_id
      WHERE le.ladder_id = ?
        AND av.agent_id = ?
        AND le.role IN ('champion', 'challenger')
        AND le.is_anchor = 0
      ORDER BY le.lcb ASC, le.elo ASC, le.version_id ASC
    `);
    const retireExcess = db.prepare(`
      UPDATE ladder_entries
      SET role = 'retired',
          retired_at = ?,
          rank_current = NULL,
          rank_min = NULL,
          rank_max = NULL
      WHERE ladder_id = ? AND version_id = ? AND is_anchor = 0
    `);
    for (const prev of prevAnchors) {
      const nonAnchorActive = selectNonAnchorActive.all(ladderId, prev.agent_id) as Array<{
        version_id: number;
      }>;
      while (nonAnchorActive.length > 2) {
        const weakest = nonAnchorActive.shift()!;
        retireExcess.run(now, ladderId, weakest.version_id);
      }
    }

    const dayUtc = formatUtcDate(now);
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

export interface AdminEntryView {
  ladderId: string;
  slot: LadderSlot;
  ladderName: string;
  ladderStatus: LadderStatus;
  versionId: number;
  version: string;
  smokeInfoStatus?: InfoStatus;
  role: 'champion' | 'challenger' | 'quarantined';
  isAnchor: boolean;
  elo: number;
  se: number;
  lcb: number;
  gxe: number;
  rankCurrent?: number;
  matches: number;
  ww: number;
  wt: number;
  split: number;
  tl: number;
  ll: number;
  settledAt?: number;
  meanTurnMillis: number;
  peakRam: number;
  meanCpuCores: number;
  cpuMatches: number;
  crashes: number;
  timeouts: number;
  ooms: number;
  invalidChoices: number;
  invalidCantMove: number;
  invalidCantSwitch: number;
  invalidTarget: number;
  invalidOther: number;
  unavailableChoices: number;
}

export function getAdminEntriesByAgent(db: DatabaseSync): Map<number, AdminEntryView[]> {
  const rows = db.prepare(`
    SELECT
      av.agent_id,
      le.ladder_id,
      l.slot,
      l.name AS ladder_name,
      l.status AS ladder_status,
      le.version_id,
      av.version,
      COALESCE(
        (
          SELECT ${MIN_INFO_STATUS_SQL}
          FROM smoke_diagnostics sd
          WHERE sd.version_id = le.version_id AND sd.ladder_id = le.ladder_id
        ),
        (
          SELECT ${MIN_INFO_STATUS_SQL}
          FROM smoke_diagnostics sd
          WHERE sd.version_id = le.version_id
        )
      ) AS smoke_info_status,
      le.role,
      le.is_anchor,
      le.elo,
      le.se,
      le.lcb,
      le.gxe,
      le.rank_current,
      le.matches,
      le.ww,
      le.wt,
      le.split,
      le.tl,
      le.ll,
      le.settled_at,
      le.mean_turn_millis,
      le.peak_ram,
      le.mean_cpu_cores,
      le.cpu_matches,
      le.crashes,
      le.timeouts,
      le.ooms,
      le.invalid_choices,
      le.invalid_cant_move,
      le.invalid_cant_switch,
      le.invalid_target,
      le.invalid_other,
      le.unavailable_choices
    FROM ladder_entries le
    JOIN agent_versions av ON av.id = le.version_id
    JOIN ladders l ON l.id = le.ladder_id
    WHERE le.role IN ('champion', 'challenger', 'quarantined')
      AND l.status != 'archived'
    ORDER BY
      av.agent_id ASC,
      ${SLOT_ORDER_SQL.replace(/slot/g, 'l.slot')} ASC,
      CASE le.role WHEN 'champion' THEN 0 WHEN 'challenger' THEN 1 ELSE 2 END ASC,
      le.lcb DESC,
      le.version_id DESC
  `).all() as Array<Record<string, unknown>>;

  const out = new Map<number, AdminEntryView[]>();
  for (const r of rows) {
    const agentId = r.agent_id as number;
    let list = out.get(agentId);
    if (!list) {
      list = [];
      out.set(agentId, list);
    }
    list.push({
      ladderId: r.ladder_id as string,
      slot: r.slot as LadderSlot,
      ladderName: r.ladder_name as string,
      ladderStatus: r.ladder_status as LadderStatus,
      versionId: r.version_id as number,
      version: r.version as string,
      ...(r.smoke_info_status === null || r.smoke_info_status === undefined
        ? {}
        : {smokeInfoStatus: r.smoke_info_status as InfoStatus}),
      role: r.role as 'champion' | 'challenger' | 'quarantined',
      isAnchor: (r.is_anchor as number) === 1,
      elo: r.elo as number,
      se: r.se as number,
      lcb: r.lcb as number,
      gxe: r.gxe as number,
      rankCurrent: (r.rank_current as number | null) ?? undefined,
      matches: r.matches as number,
      ww: r.ww as number,
      wt: r.wt as number,
      split: r.split as number,
      tl: r.tl as number,
      ll: r.ll as number,
      settledAt: (r.settled_at as number | null) ?? undefined,
      meanTurnMillis: r.mean_turn_millis as number,
      peakRam: r.peak_ram as number,
      meanCpuCores: r.mean_cpu_cores as number,
      cpuMatches: r.cpu_matches as number,
      crashes: r.crashes as number,
      timeouts: r.timeouts as number,
      ooms: r.ooms as number,
      invalidChoices: r.invalid_choices as number,
      invalidCantMove: r.invalid_cant_move as number,
      invalidCantSwitch: r.invalid_cant_switch as number,
      invalidTarget: r.invalid_target as number,
      invalidOther: r.invalid_other as number,
      unavailableChoices: r.unavailable_choices as number,
    });
  }
  return out;
}

export interface LadderAdminSummary {
  ladderId: string;
  eligibleAgents: number;
  activeAgents: number;
  activeEntries: number;
  unsettledEntries: number;
  quarantinedEntries: number;
  anchor?: {agentSlug: string; agentName: string; version: string};
  totalMatches: number;
  matches24h: number;
  harvestedTeams: number;
  lockedPools: number;
  savedPools: number;
}

export function getLadderAdminSummaries(
  db: DatabaseSync,
  now = Math.floor(Date.now() / 1000)
): Map<string, LadderAdminSummary> {
  const cutoff24h = now - 86400;
  const entryRows = db.prepare(`
    SELECT
      le.ladder_id,
      COUNT(DISTINCT CASE
        WHEN le.role IN ('champion', 'challenger') THEN av.agent_id
      END) AS active_agents,
      SUM(CASE WHEN le.role IN ('champion', 'challenger') THEN 1 ELSE 0 END) AS active_entries,
      SUM(CASE
        WHEN le.role IN ('champion', 'challenger')
          AND le.settled_at IS NULL
          AND (le.matches < 25 OR le.se > 30.0)
        THEN 1 ELSE 0
      END) AS unsettled_entries,
      SUM(CASE WHEN le.role = 'quarantined' THEN 1 ELSE 0 END) AS quarantined_entries
    FROM ladder_entries le
    JOIN agent_versions av ON av.id = le.version_id
    JOIN ladders l ON l.id = le.ladder_id
    WHERE l.status != 'archived'
    GROUP BY le.ladder_id
  `).all() as Array<{
    ladder_id: string;
    active_agents: number;
    active_entries: number;
    unsettled_entries: number;
    quarantined_entries: number;
  }>;

  const anchorRows = db.prepare(`
    SELECT le.ladder_id, a.slug AS agent_slug, a.name AS agent_name, av.version
    FROM ladder_entries le
    JOIN agent_versions av ON av.id = le.version_id
    JOIN agents a ON a.id = av.agent_id
    JOIN ladders l ON l.id = le.ladder_id
    WHERE le.is_anchor = 1 AND l.status != 'archived'
  `).all() as Array<{
    ladder_id: string;
    agent_slug: string;
    agent_name: string;
    version: string;
  }>;
  const anchorByLadder = new Map(
    anchorRows.map(r => [
      r.ladder_id,
      {agentSlug: r.agent_slug, agentName: r.agent_name, version: r.version},
    ])
  );

  const totalMatchRows = db.prepare(`
    SELECT ladder_id, COALESCE(SUM(ww + wt + split + tl + ll), 0) AS total_matches
    FROM pair_aggregates
    GROUP BY ladder_id
  `).all() as Array<{ladder_id: string; total_matches: number}>;
  const totalMatchesByLadder = new Map(
    totalMatchRows.map(r => [r.ladder_id, r.total_matches])
  );

  // Drive from active ladders so SQLite seeks `idx_matches_ladder_completed` per ladder instead
  // of scanning every historical season's matches in `GROUP BY ladder_id`.
  const recentMatchRows = db.prepare(`
    SELECT
      l.id AS ladder_id,
      (
        SELECT COUNT(*)
        FROM matches m
        WHERE m.ladder_id = l.id AND m.completed_at >= ?
      ) AS matches_24h
    FROM ladders l
    WHERE l.status != 'archived'
  `).all(cutoff24h) as Array<{ladder_id: string; matches_24h: number}>;
  const recentMatchesByLadder = new Map(
    recentMatchRows.map(r => [r.ladder_id, r.matches_24h])
  );

  const harvestedRows = db.prepare(`
    SELECT ladder_id, COUNT(*) AS count
    FROM ladder_teams
    GROUP BY ladder_id
  `).all() as Array<{ladder_id: string; count: number}>;
  const harvestedByLadder = new Map(harvestedRows.map(r => [r.ladder_id, r.count]));

  const poolRows = db.prepare(`
    SELECT
      ladder_id,
      COUNT(DISTINCT CASE WHEN status = 'active' THEN agent_id END) AS locked_pools,
      COUNT(DISTINCT CASE WHEN status = 'saved' THEN agent_id END) AS saved_pools
    FROM agent_ladder_teams
    GROUP BY ladder_id
  `).all() as Array<{ladder_id: string; locked_pools: number; saved_pools: number}>;
  const poolsByLadder = new Map(poolRows.map(r => [r.ladder_id, r]));

  const eligibleRows = db.prepare(`
    SELECT al.slot, COUNT(DISTINCT al.agent_id) AS count
    FROM agent_ladders al
    JOIN agents a ON a.id = al.agent_id
    WHERE a.status != 'disabled'
      AND NOT EXISTS (
        SELECT 1 FROM developers d
        WHERE d.agent_id = a.id AND d.smogon_standing = 'bad'
      )
    GROUP BY al.slot
  `).all() as Array<{slot: LadderSlot; count: number}>;
  const eligibleBySlot = new Map(eligibleRows.map(r => [r.slot, r.count]));

  const ladders = db.prepare("SELECT id, slot FROM ladders WHERE status != 'archived'")
    .all() as Array<{id: string; slot: LadderSlot}>;
  const entriesByLadder = new Map(entryRows.map(r => [r.ladder_id, r]));
  const out = new Map<string, LadderAdminSummary>();

  for (const {id, slot} of ladders) {
    const e = entriesByLadder.get(id);
    const p = poolsByLadder.get(id);
    out.set(id, {
      ladderId: id,
      eligibleAgents: eligibleBySlot.get(slot) ?? 0,
      activeAgents: e?.active_agents ?? 0,
      activeEntries: e?.active_entries ?? 0,
      unsettledEntries: e?.unsettled_entries ?? 0,
      quarantinedEntries: e?.quarantined_entries ?? 0,
      anchor: anchorByLadder.get(id),
      totalMatches: totalMatchesByLadder.get(id) ?? 0,
      matches24h: recentMatchesByLadder.get(id) ?? 0,
      harvestedTeams: harvestedByLadder.get(id) ?? 0,
      lockedPools: p?.locked_pools ?? 0,
      savedPools: p?.saved_pools ?? 0,
    });
  }
  return out;
}

// Retires a single active version on one specific ladder without affecting the project's
// per-ladder qualification grants or entries on other ladders. Historical match edges stay intact
// in the Davidson graph while any remaining challenger is promoted to champion on recompute.
export function retireLadderEntry(
  db: DatabaseSync,
  inTransaction: TransactionRunner,
  ladderId: string,
  versionId: number,
  now = Math.floor(Date.now() / 1000)
) {
  inTransaction(() => {
    const ladder = getLadder(db, ladderId);
    if (!ladder) {
      throw Object.assign(new Error(`Unknown ladder "${ladderId}"`), {status: 404});
    }
    const row = db.prepare(`
      SELECT role, is_anchor
      FROM ladder_entries
      WHERE ladder_id = ? AND version_id = ?
    `).get(ladderId, versionId) as {role: EntryRole; is_anchor: number} | undefined;
    if (!row) {
      throw Object.assign(
        new Error(`No ladder entry found on "${ladderId}" for versionId ${versionId}`),
        {status: 404}
      );
    }
    if (row.is_anchor === 1) {
      throw Object.assign(
        new Error(
          `Cannot retire the 1500 Elo anchor on "${ladderId}" — assign a new anchor first.`
        ),
        {status: 400}
      );
    }
    if (row.role !== 'champion' && row.role !== 'challenger') {
      throw Object.assign(
        new Error(`Entry on "${ladderId}" is not active (current role: ${row.role})`),
        {status: 409}
      );
    }

    db.prepare(`
      UPDATE ladder_entries
      SET role = 'retired',
          retired_at = ?,
          rank_current = NULL,
          rank_min = NULL,
          rank_max = NULL
      WHERE ladder_id = ? AND version_id = ?
    `).run(now, ladderId, versionId);

    db.prepare(`
      UPDATE agent_versions
      SET auth_token_encoding = NULL
      WHERE id = ?
        AND auth_token_encoding IS NOT NULL
        AND smoke_status = 'passed'
        AND NOT EXISTS (
          SELECT 1
          FROM ladder_entries le
          JOIN ladders l ON l.id = le.ladder_id
          WHERE le.version_id = agent_versions.id
            AND le.role IN ('champion', 'challenger')
            AND l.status IN ('upcoming', 'active', 'settling')
        )
    `).run(versionId);

    if (ladder.status !== 'archived') {
      recomputeLadderRatings(db, ladderId, now, undefined, formatUtcDate(now));
    }
    if (ladder.status === 'settling' && !canSettleLadder(db, ladder)) {
      archiveLadderInPlace(db, ladder.id, now);
    }
  });
}
