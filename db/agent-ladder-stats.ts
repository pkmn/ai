import {DatabaseSync} from 'node:sqlite';

import * as ratings from '../server/ratings';

export interface AgentLadderStatsRow {
  agentId: number;
  bestRank?: number;
  bestRankAt?: number;
  maxLcb?: number;
  maxElo?: number;
  maxEloSe?: number;
  maxEloAt?: number;
  maxEloVersionId?: number;
  maxGxe?: number;
  maxGxeAt?: number;
  currentWinStreak: number;
  currentLossStreak: number;
  maxWinStreak: number;
  maxLossStreak: number;
  top1EnteredAt?: number;
  top1MaxStreakSeconds: number;
  top1TotalSeconds: number;
  top10EnteredAt?: number;
  top10MaxStreakSeconds: number;
  top10TotalSeconds: number;
  top100EnteredAt?: number;
  top100MaxStreakSeconds: number;
  top100TotalSeconds: number;
}

export function createEmptyAgentLadderStats(agentId: number): AgentLadderStatsRow {
  return {
    agentId,
    currentWinStreak: 0,
    currentLossStreak: 0,
    maxWinStreak: 0,
    maxLossStreak: 0,
    top1MaxStreakSeconds: 0,
    top1TotalSeconds: 0,
    top10MaxStreakSeconds: 0,
    top10TotalSeconds: 0,
    top100MaxStreakSeconds: 0,
    top100TotalSeconds: 0,
  };
}

export function ensureAgentLadderStats(db: DatabaseSync, ladderId: string, agentId: number) {
  db.prepare('INSERT OR IGNORE INTO agent_ladder_stats (ladder_id, agent_id) VALUES (?, ?)')
    .run(ladderId, agentId);
}

// Advances cross-version project streaks after an inter-project match so upgrading from v1.0 to
// v1.1 continues an unbroken win/loss streak on `/projects/<slug>`. Intra-project matches between
// an agent's own Champion and Challenger never update project-level streaks.
export function updateFamilyStreaksForMatch(
  db: DatabaseSync,
  ladderId: string,
  agentId: number,
  outcome: ratings.TernaryMatchOutcome
) {
  const cur = db.prepare(`
    SELECT current_win_streak, current_loss_streak, max_win_streak, max_loss_streak
    FROM agent_ladder_stats
    WHERE ladder_id = ? AND agent_id = ?
  `).get(ladderId, agentId) as {
    current_win_streak: number;
    current_loss_streak: number;
    max_win_streak: number;
    max_loss_streak: number;
  };
  const streaks: ratings.StreakState = {
    currentWinStreak: cur.current_win_streak,
    currentLossStreak: cur.current_loss_streak,
    maxWinStreak: cur.max_win_streak,
    maxLossStreak: cur.max_loss_streak,
  };
  ratings.applyMatchOutcomeToStreaks(streaks, outcome);
  db.prepare(`
    UPDATE agent_ladder_stats
    SET current_win_streak = ?, current_loss_streak = ?,
        max_win_streak = ?, max_loss_streak = ?
    WHERE ladder_id = ? AND agent_id = ?
  `).run(
    streaks.currentWinStreak,
    streaks.currentLossStreak,
    streaks.maxWinStreak,
    streaks.maxLossStreak,
    ladderId,
    agentId
  );
}

export function loadAgentLadderStatsMap(
  db: DatabaseSync,
  ladderId: string
): Map<number, AgentLadderStatsRow> {
  const rawFamilies = db.prepare(
    'SELECT * FROM agent_ladder_stats WHERE ladder_id = ?'
  ).all(ladderId) as Array<Record<string, unknown>>;
  const families = new Map<number, AgentLadderStatsRow>();
  for (const f of rawFamilies) {
    const agentId = f.agent_id as number;
    families.set(agentId, {
      agentId,
      bestRank: (f.best_rank as number | null) ?? undefined,
      bestRankAt: (f.best_rank_at as number | null) ?? undefined,
      maxLcb: (f.max_lcb as number | null) ?? undefined,
      maxElo: (f.max_elo as number | null) ?? undefined,
      maxEloSe: (f.max_elo_se as number | null) ?? undefined,
      maxEloAt: (f.max_elo_at as number | null) ?? undefined,
      maxEloVersionId: (f.max_elo_version_id as number | null) ?? undefined,
      maxGxe: (f.max_gxe as number | null) ?? undefined,
      maxGxeAt: (f.max_gxe_at as number | null) ?? undefined,
      currentWinStreak: f.current_win_streak as number,
      currentLossStreak: f.current_loss_streak as number,
      maxWinStreak: f.max_win_streak as number,
      maxLossStreak: f.max_loss_streak as number,
      top1EnteredAt: (f.top1_entered_at as number | null) ?? undefined,
      top1MaxStreakSeconds: f.top1_max_streak_seconds as number,
      top1TotalSeconds: f.top1_total_seconds as number,
      top10EnteredAt: (f.top10_entered_at as number | null) ?? undefined,
      top10MaxStreakSeconds: f.top10_max_streak_seconds as number,
      top10TotalSeconds: f.top10_total_seconds as number,
      top100EnteredAt: (f.top100_entered_at as number | null) ?? undefined,
      top100MaxStreakSeconds: f.top100_max_streak_seconds as number,
      top100TotalSeconds: f.top100_total_seconds as number,
    });
  }
  return families;
}

export function getAgentLadderStats(
  db: DatabaseSync,
  ladderId: string,
  agentId: number
): AgentLadderStatsRow | undefined {
  return loadAgentLadderStatsMap(db, ladderId).get(agentId);
}

export function upsertAgentLadderStatsMap(
  db: DatabaseSync,
  ladderId: string,
  families: Map<number, AgentLadderStatsRow>
) {
  const upsert = db.prepare(`
    INSERT INTO agent_ladder_stats (
      ladder_id, agent_id, best_rank, best_rank_at, max_lcb,
      max_elo, max_elo_se, max_elo_at, max_elo_version_id, max_gxe, max_gxe_at,
      current_win_streak, current_loss_streak, max_win_streak, max_loss_streak,
      top1_entered_at, top1_max_streak_seconds, top1_total_seconds,
      top10_entered_at, top10_max_streak_seconds, top10_total_seconds,
      top100_entered_at, top100_max_streak_seconds, top100_total_seconds
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ladder_id, agent_id) DO UPDATE SET
      best_rank = excluded.best_rank,
      best_rank_at = excluded.best_rank_at,
      max_lcb = excluded.max_lcb,
      max_elo = excluded.max_elo,
      max_elo_se = excluded.max_elo_se,
      max_elo_at = excluded.max_elo_at,
      max_elo_version_id = excluded.max_elo_version_id,
      max_gxe = excluded.max_gxe,
      max_gxe_at = excluded.max_gxe_at,
      current_win_streak = excluded.current_win_streak,
      current_loss_streak = excluded.current_loss_streak,
      max_win_streak = excluded.max_win_streak,
      max_loss_streak = excluded.max_loss_streak,
      top1_entered_at = excluded.top1_entered_at,
      top1_max_streak_seconds = excluded.top1_max_streak_seconds,
      top1_total_seconds = excluded.top1_total_seconds,
      top10_entered_at = excluded.top10_entered_at,
      top10_max_streak_seconds = excluded.top10_max_streak_seconds,
      top10_total_seconds = excluded.top10_total_seconds,
      top100_entered_at = excluded.top100_entered_at,
      top100_max_streak_seconds = excluded.top100_max_streak_seconds,
      top100_total_seconds = excluded.top100_total_seconds
  `);
  for (const fam of families.values()) {
    upsert.run(
      ladderId,
      fam.agentId,
      fam.bestRank ?? null,
      fam.bestRankAt ?? null,
      fam.maxLcb ?? null,
      fam.maxElo ?? null,
      fam.maxEloSe ?? null,
      fam.maxEloAt ?? null,
      fam.maxEloVersionId ?? null,
      fam.maxGxe ?? null,
      fam.maxGxeAt ?? null,
      fam.currentWinStreak,
      fam.currentLossStreak,
      fam.maxWinStreak,
      fam.maxLossStreak,
      fam.top1EnteredAt ?? null,
      fam.top1MaxStreakSeconds,
      fam.top1TotalSeconds,
      fam.top10EnteredAt ?? null,
      fam.top10MaxStreakSeconds,
      fam.top10TotalSeconds,
      fam.top100EnteredAt ?? null,
      fam.top100MaxStreakSeconds,
      fam.top100TotalSeconds
    );
  }
}
