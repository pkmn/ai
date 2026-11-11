import type {DatabaseSync} from 'node:sqlite';

import {type TernaryMatchOutcome, applyMatchOutcomeToStreaks} from '../server/ratings';

export interface BotLadderStatsRow {
  botId: number;
  bestRank: number | null;
  bestRankAt: number | null;
  maxRatingLcb: number | null;
  maxElo: number | null;
  maxEloSe: number | null;
  maxGxe: number | null;
  maxEloVersionId: number | null;
  curWinStreak: number;
  curLossStreak: number;
  maxWinStreak: number;
  maxLossStreak: number;
  top1EnteredAt: number | null;
  top1MaxStreakS: number;
  top1TotalS: number;
  top10EnteredAt: number | null;
  top10MaxStreakS: number;
  top10TotalS: number;
  top100EnteredAt: number | null;
  top100MaxStreakS: number;
  top100TotalS: number;
}

export function createEmptyBotLadderStats(botId: number): BotLadderStatsRow {
  return {
    botId,
    bestRank: null,
    bestRankAt: null,
    maxRatingLcb: null,
    maxElo: null,
    maxEloSe: null,
    maxGxe: null,
    maxEloVersionId: null,
    curWinStreak: 0,
    curLossStreak: 0,
    maxWinStreak: 0,
    maxLossStreak: 0,
    top1EnteredAt: null,
    top1MaxStreakS: 0,
    top1TotalS: 0,
    top10EnteredAt: null,
    top10MaxStreakS: 0,
    top10TotalS: 0,
    top100EnteredAt: null,
    top100MaxStreakS: 0,
    top100TotalS: 0,
  };
}

export function ensureBotLadderStats(db: DatabaseSync, ladderId: string, botId: number) {
  db.prepare('INSERT OR IGNORE INTO bot_ladder_stats (ladder_id, bot_id) VALUES (?, ?)')
    .run(ladderId, botId);
}

export function updateFamilyStreaksForMatch(
  db: DatabaseSync,
  ladderId: string,
  botId: number,
  outcome: TernaryMatchOutcome
) {
  const cur = db.prepare(`
    SELECT cur_win_streak, cur_loss_streak, max_win_streak, max_loss_streak
    FROM bot_ladder_stats
    WHERE ladder_id = ? AND bot_id = ?
  `).get(ladderId, botId) as {
    cur_win_streak: number;
    cur_loss_streak: number;
    max_win_streak: number;
    max_loss_streak: number;
  };
  const streaks = {
    curWinStreak: cur.cur_win_streak,
    curLossStreak: cur.cur_loss_streak,
    maxWinStreak: cur.max_win_streak,
    maxLossStreak: cur.max_loss_streak,
  };
  applyMatchOutcomeToStreaks(streaks, outcome);
  db.prepare(`
    UPDATE bot_ladder_stats
    SET cur_win_streak = ?, cur_loss_streak = ?,
        max_win_streak = ?, max_loss_streak = ?
    WHERE ladder_id = ? AND bot_id = ?
  `).run(
    streaks.curWinStreak,
    streaks.curLossStreak,
    streaks.maxWinStreak,
    streaks.maxLossStreak,
    ladderId,
    botId
  );
}

export function loadBotLadderStatsMap(
  db: DatabaseSync,
  ladderId: string
): Map<number, BotLadderStatsRow> {
  const rawFamilies = db.prepare(
    'SELECT * FROM bot_ladder_stats WHERE ladder_id = ?'
  ).all(ladderId) as Array<Record<string, unknown>>;
  const families = new Map<number, BotLadderStatsRow>();
  for (const f of rawFamilies) {
    const botId = f.bot_id as number;
    families.set(botId, {
      botId,
      bestRank: (f.best_rank as number | null) ?? null,
      bestRankAt: (f.best_rank_at as number | null) ?? null,
      maxRatingLcb: (f.max_rating_lcb as number | null) ?? null,
      maxElo: (f.max_elo as number | null) ?? null,
      maxEloSe: (f.max_elo_se as number | null) ?? null,
      maxGxe: (f.max_gxe as number | null) ?? null,
      maxEloVersionId: (f.max_elo_version_id as number | null) ?? null,
      curWinStreak: f.cur_win_streak as number,
      curLossStreak: f.cur_loss_streak as number,
      maxWinStreak: f.max_win_streak as number,
      maxLossStreak: f.max_loss_streak as number,
      top1EnteredAt: (f.top1_entered_at as number | null) ?? null,
      top1MaxStreakS: f.top1_max_streak_s as number,
      top1TotalS: f.top1_total_s as number,
      top10EnteredAt: (f.top10_entered_at as number | null) ?? null,
      top10MaxStreakS: f.top10_max_streak_s as number,
      top10TotalS: f.top10_total_s as number,
      top100EnteredAt: (f.top100_entered_at as number | null) ?? null,
      top100MaxStreakS: f.top100_max_streak_s as number,
      top100TotalS: f.top100_total_s as number,
    });
  }
  return families;
}

export function getBotLadderStats(
  db: DatabaseSync,
  ladderId: string,
  botId: number
): BotLadderStatsRow | undefined {
  return loadBotLadderStatsMap(db, ladderId).get(botId);
}

export function upsertBotLadderStatsMap(
  db: DatabaseSync,
  ladderId: string,
  families: Map<number, BotLadderStatsRow>
) {
  const upsert = db.prepare(`
    INSERT INTO bot_ladder_stats (
      ladder_id, bot_id, best_rank, best_rank_at, max_rating_lcb,
      max_elo, max_elo_se, max_gxe, max_elo_version_id,
      cur_win_streak, cur_loss_streak, max_win_streak, max_loss_streak,
      top1_entered_at, top1_max_streak_s, top1_total_s,
      top10_entered_at, top10_max_streak_s, top10_total_s,
      top100_entered_at, top100_max_streak_s, top100_total_s
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ladder_id, bot_id) DO UPDATE SET
      best_rank = excluded.best_rank,
      best_rank_at = excluded.best_rank_at,
      max_rating_lcb = excluded.max_rating_lcb,
      max_elo = excluded.max_elo,
      max_elo_se = excluded.max_elo_se,
      max_gxe = excluded.max_gxe,
      max_elo_version_id = excluded.max_elo_version_id,
      cur_win_streak = excluded.cur_win_streak,
      cur_loss_streak = excluded.cur_loss_streak,
      max_win_streak = excluded.max_win_streak,
      max_loss_streak = excluded.max_loss_streak,
      top1_entered_at = excluded.top1_entered_at,
      top1_max_streak_s = excluded.top1_max_streak_s,
      top1_total_s = excluded.top1_total_s,
      top10_entered_at = excluded.top10_entered_at,
      top10_max_streak_s = excluded.top10_max_streak_s,
      top10_total_s = excluded.top10_total_s,
      top100_entered_at = excluded.top100_entered_at,
      top100_max_streak_s = excluded.top100_max_streak_s,
      top100_total_s = excluded.top100_total_s
  `);
  for (const fam of families.values()) {
    upsert.run(
      ladderId,
      fam.botId,
      fam.bestRank,
      fam.bestRankAt,
      fam.maxRatingLcb,
      fam.maxElo,
      fam.maxEloSe,
      fam.maxGxe,
      fam.maxEloVersionId,
      fam.curWinStreak,
      fam.curLossStreak,
      fam.maxWinStreak,
      fam.maxLossStreak,
      fam.top1EnteredAt,
      fam.top1MaxStreakS,
      fam.top1TotalS,
      fam.top10EnteredAt,
      fam.top10MaxStreakS,
      fam.top10TotalS,
      fam.top100EnteredAt,
      fam.top100MaxStreakS,
      fam.top100TotalS
    );
  }
}
