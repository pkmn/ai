import type {DatabaseSync} from 'node:sqlite';

import {
  type GameOutcome,
  type MatchCategory,
  applyMatchOutcomeToStreaks,
  toTernaryMatchOutcome,
} from '../server/ratings';

import {ensureBotLadderStats, updateFamilyStreaksForMatch} from './bot_ladder_stats';
import {getVersionById} from './bot_versions';
import {type LadderStandingOverride, recomputeLadderRatings} from './ladder_entries';
import {type LadderSlot, type LadderStatus, getLadder} from './ladders';
import {upsertPairAggregateForMatch} from './pair_aggregates';

import type {TransactionRunner} from './index';

export interface CompletedMatchPayload {
  id: string;
  ladder_id: string;
  v1_id: number;
  v2_id: number;
  seed: string;
  team1_label?: string | null;
  team2_label?: string | null;
  g1_outcome: GameOutcome;
  g2_outcome: GameOutcome;
  match_category: MatchCategory;
  g1_turns: number;
  g2_turns: number;
  g1_end_reason: string;
  g2_end_reason: string;
  v1_peak_ram_mb: number;
  v2_peak_ram_mb: number;
  v1_g1_bank_s: number;
  v1_g2_bank_s: number;
  v2_g1_bank_s: number;
  v2_g2_bank_s: number;
  v1_avg_turn_ms: number;
  v2_avg_turn_ms: number;
  completed_at: number;
}

export interface RecordMatchInput {
  match: CompletedMatchPayload;
  ladderStatus?: LadderStatus;
  ladderStandings?: LadderStandingOverride[];
}

export interface RecentMatchView {
  id: string;
  ladder_id: string;
  slot: LadderSlot;
  format_id: string;
  p1: {slug: string; name: string; version: string};
  p2: {slug: string; name: string; version: string};
  match_category: MatchCategory;
  g1_turns: number;
  g2_turns: number;
  g1_end_reason: string;
  g2_end_reason: string;
  v1_avg_turn_ms: number;
  v2_avg_turn_ms: number;
  v1_g1_bank_s: number;
  v1_g2_bank_s: number;
  v2_g1_bank_s: number;
  v2_g2_bank_s: number;
  v1_peak_ram_mb: number;
  v2_peak_ram_mb: number;
  completed_at: number;
}

function categoryDeltas(cat: MatchCategory, invert = false) {
  const base = {
    ww: cat === 'WW' ? 1 : 0,
    wt: cat === 'WT' || cat === 'TW' ? 1 : 0,
    split: cat === 'WL' || cat === 'LW' || cat === 'TT' ? 1 : 0,
    tl: cat === 'TL' || cat === 'LT' ? 1 : 0,
    ll: cat === 'LL' ? 1 : 0,
  };
  return invert
    ? {ww: base.ll, wt: base.tl, split: base.split, tl: base.wt, ll: base.ww}
    : base;
}

function countSideFaults(
  lostG1: boolean,
  lostG2: boolean,
  g1Reason: string,
  g2Reason: string
) {
  let crashes = 0;
  let timeouts = 0;
  let ooms = 0;
  if (lostG1) {
    if (g1Reason === 'crash') crashes++;
    else if (g1Reason === 'timeout') timeouts++;
    else if (g1Reason === 'oom') ooms++;
  }
  if (lostG2) {
    if (g2Reason === 'crash') crashes++;
    else if (g2Reason === 'timeout') timeouts++;
    else if (g2Reason === 'oom') ooms++;
  }
  return {crashes, timeouts, ooms};
}

export function recordCompletedMatch(
  db: DatabaseSync,
  inTransaction: TransactionRunner,
  input: RecordMatchInput
): {duplicate: boolean; archivedLadder: boolean} {
  const m = input.match;
  return inTransaction(() => {
    const dup = db.prepare('SELECT 1 FROM matches WHERE id = ?').get(m.id);
    if (dup !== undefined) {
      return {duplicate: true, archivedLadder: false};
    }

    const ladder = getLadder(db, m.ladder_id);
    if (!ladder) {
      throw Object.assign(new Error(`Unknown ladder_id "${m.ladder_id}"`), {status: 404});
    }
    const v1 = getVersionById(db, m.v1_id);
    const v2 = getVersionById(db, m.v2_id);
    if (!v1 || !v2) {
      throw Object.assign(
        new Error(`Unknown version_id in match (${m.v1_id} vs ${m.v2_id})`),
        {status: 404}
      );
    }

    const prevRow = db.prepare(
      'SELECT MAX(completed_at) AS prev FROM matches WHERE ladder_id = ?'
    ).get(m.ladder_id) as {prev: number | null} | undefined;
    const prevMatchSec = prevRow?.prev ?? null;

    db.prepare(`
      INSERT INTO matches (
        id, ladder_id, v1_id, v2_id, seed, team1_label, team2_label,
        g1_outcome, g2_outcome, match_category, g1_turns, g2_turns,
        g1_end_reason, g2_end_reason, v1_peak_ram_mb, v2_peak_ram_mb,
        v1_g1_bank_s, v1_g2_bank_s, v2_g1_bank_s, v2_g2_bank_s,
        v1_avg_turn_ms, v2_avg_turn_ms, completed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      m.id,
      m.ladder_id,
      m.v1_id,
      m.v2_id,
      m.seed,
      m.team1_label ?? null,
      m.team2_label ?? null,
      m.g1_outcome,
      m.g2_outcome,
      m.match_category,
      m.g1_turns,
      m.g2_turns,
      m.g1_end_reason,
      m.g2_end_reason,
      m.v1_peak_ram_mb,
      m.v2_peak_ram_mb,
      m.v1_g1_bank_s,
      m.v1_g2_bank_s,
      m.v2_g1_bank_s,
      m.v2_g2_bank_s,
      m.v1_avg_turn_ms,
      m.v2_avg_turn_ms,
      m.completed_at
    );

    const ensureEntry = db.prepare(`
      INSERT OR IGNORE INTO ladder_entries (ladder_id, version_id, role)
      VALUES (?, ?, 'champion')
    `);
    ensureEntry.run(m.ladder_id, m.v1_id);
    ensureEntry.run(m.ladder_id, m.v2_id);

    ensureBotLadderStats(db, m.ladder_id, v1.bot_id);
    ensureBotLadderStats(db, m.ladder_id, v2.bot_id);

    const ternary = toTernaryMatchOutcome(m.match_category);
    const selectEntryCounters = db.prepare(`
      SELECT matches_played, cur_win_streak, cur_loss_streak,
             max_win_streak, max_loss_streak, avg_turn_ms, peak_ram_mb
      FROM ladder_entries
      WHERE ladder_id = ? AND version_id = ?
    `);
    const updateEntryCounters = db.prepare(`
      UPDATE ladder_entries
      SET matches_played = ?,
          ww = ww + ?,
          wt = wt + ?,
          split = split + ?,
          tl = tl + ?,
          ll = ll + ?,
          cur_win_streak = ?,
          cur_loss_streak = ?,
          max_win_streak = ?,
          max_loss_streak = ?,
          crashes = crashes + ?,
          timeouts = timeouts + ?,
          ooms = ooms + ?,
          avg_turn_ms = ?,
          peak_ram_mb = ?
      WHERE ladder_id = ? AND version_id = ?
    `);

    const applySide = (
      versionId: number,
      invert: boolean,
      outcome: 'W' | 'L' | 'T',
      avgTurnMs: number,
      peakRamMb: number,
      faults: {crashes: number; timeouts: number; ooms: number}
    ) => {
      const cur = selectEntryCounters.get(m.ladder_id, versionId) as {
        matches_played: number;
        cur_win_streak: number;
        cur_loss_streak: number;
        max_win_streak: number;
        max_loss_streak: number;
        avg_turn_ms: number;
        peak_ram_mb: number;
      };
      const streaks = {
        curWinStreak: cur.cur_win_streak,
        curLossStreak: cur.cur_loss_streak,
        maxWinStreak: cur.max_win_streak,
        maxLossStreak: cur.max_loss_streak,
      };
      applyMatchOutcomeToStreaks(streaks, outcome);
      const d = categoryDeltas(m.match_category, invert);
      const nextPlayed = cur.matches_played + 1;
      const nextAvgTurn = (cur.avg_turn_ms * cur.matches_played + avgTurnMs) / nextPlayed;
      const nextPeakRam = Math.max(cur.peak_ram_mb, peakRamMb);

      updateEntryCounters.run(
        nextPlayed,
        d.ww,
        d.wt,
        d.split,
        d.tl,
        d.ll,
        streaks.curWinStreak,
        streaks.curLossStreak,
        streaks.maxWinStreak,
        streaks.maxLossStreak,
        faults.crashes,
        faults.timeouts,
        faults.ooms,
        nextAvgTurn,
        nextPeakRam,
        m.ladder_id,
        versionId
      );
    };

    applySide(
      m.v1_id,
      false,
      ternary.v1,
      m.v1_avg_turn_ms,
      m.v1_peak_ram_mb,
      countSideFaults(
        m.g1_outcome === 'L',
        m.g2_outcome === 'L',
        m.g1_end_reason,
        m.g2_end_reason
      )
    );
    applySide(
      m.v2_id,
      true,
      ternary.v2,
      m.v2_avg_turn_ms,
      m.v2_peak_ram_mb,
      countSideFaults(
        m.g1_outcome === 'W',
        m.g2_outcome === 'W',
        m.g1_end_reason,
        m.g2_end_reason
      )
    );

    if (v1.bot_id !== v2.bot_id) {
      updateFamilyStreaksForMatch(db, m.ladder_id, v1.bot_id, ternary.v1);
      updateFamilyStreaksForMatch(db, m.ladder_id, v2.bot_id, ternary.v2);
    }

    const vLowId = Math.min(m.v1_id, m.v2_id);
    const vHighId = Math.max(m.v1_id, m.v2_id);
    const v1IsLow = m.v1_id === vLowId;
    const pairDelta = categoryDeltas(m.match_category, !v1IsLow);
    const vLowOutcome = v1IsLow ? ternary.v1 : ternary.v2;
    upsertPairAggregateForMatch(db, m.ladder_id, vLowId, vHighId, pairDelta, vLowOutcome);

    if (input.ladderStandings) {
      const updateOverride = db.prepare(`
        UPDATE ladder_entries
        SET role = COALESCE(?, role),
            is_anchor = COALESCE(?, is_anchor)
        WHERE ladder_id = ? AND version_id = ?
      `);
      for (const s of input.ladderStandings) {
        updateOverride.run(s.role ?? null, s.is_anchor ?? null, m.ladder_id, s.version_id);
      }
    }

    const dayUtc = new Date(m.completed_at * 1000).toISOString().slice(0, 10);
    recomputeLadderRatings(db, m.ladder_id, m.completed_at, prevMatchSec, dayUtc);

    let archivedLadder = false;
    if (ladder.status === 'settling' || input.ladderStatus === 'archived') {
      const unsettled = db.prepare(`
        SELECT 1 FROM ladder_entries
        WHERE ladder_id = ?
          AND role IN ('champion', 'challenger')
          AND settled_at IS NULL
        LIMIT 1
      `).get(m.ladder_id);

      if (unsettled === undefined || input.ladderStatus === 'archived') {
        db.prepare(
          "UPDATE ladders SET status = 'archived', archived_at = ? WHERE id = ?"
        ).run(m.completed_at, m.ladder_id);
        db.prepare(`
          UPDATE ladder_entries
          SET role = 'retired', retired_at = ?
          WHERE ladder_id = ? AND role IN ('champion', 'challenger')
        `).run(m.completed_at, m.ladder_id);
        archivedLadder = true;
      }
    }

    return {duplicate: false, archivedLadder};
  });
}

export function getRecentMatches(db: DatabaseSync, limit = 50): RecentMatchView[] {
  const rows = db.prepare(`
    SELECT
      m.id,
      m.ladder_id,
      l.slot,
      l.format_id,
      b1.slug AS p1_slug,
      b1.name AS p1_name,
      v1.version_str AS p1_version,
      b2.slug AS p2_slug,
      b2.name AS p2_name,
      v2.version_str AS p2_version,
      m.match_category,
      m.g1_turns,
      m.g2_turns,
      m.g1_end_reason,
      m.g2_end_reason,
      m.v1_avg_turn_ms,
      m.v2_avg_turn_ms,
      m.v1_g1_bank_s,
      m.v1_g2_bank_s,
      m.v2_g1_bank_s,
      m.v2_g2_bank_s,
      m.v1_peak_ram_mb,
      m.v2_peak_ram_mb,
      m.completed_at
    FROM matches m
    JOIN ladders l ON l.id = m.ladder_id
    JOIN bot_versions v1 ON v1.id = m.v1_id
    JOIN bots b1 ON b1.id = v1.bot_id
    JOIN bot_versions v2 ON v2.id = m.v2_id
    JOIN bots b2 ON b2.id = v2.bot_id
    ORDER BY m.completed_at DESC, m.id DESC
    LIMIT ?
  `).all(limit) as Array<Record<string, unknown>>;

  return rows.map(r => ({
    id: r.id as string,
    ladder_id: r.ladder_id as string,
    slot: r.slot as LadderSlot,
    format_id: r.format_id as string,
    p1: {
      slug: r.p1_slug as string,
      name: r.p1_name as string,
      version: r.p1_version as string,
    },
    p2: {
      slug: r.p2_slug as string,
      name: r.p2_name as string,
      version: r.p2_version as string,
    },
    match_category: r.match_category as MatchCategory,
    g1_turns: r.g1_turns as number,
    g2_turns: r.g2_turns as number,
    g1_end_reason: r.g1_end_reason as string,
    g2_end_reason: r.g2_end_reason as string,
    v1_avg_turn_ms: r.v1_avg_turn_ms as number,
    v2_avg_turn_ms: r.v2_avg_turn_ms as number,
    v1_g1_bank_s: r.v1_g1_bank_s as number,
    v1_g2_bank_s: r.v1_g2_bank_s as number,
    v2_g1_bank_s: r.v2_g1_bank_s as number,
    v2_g2_bank_s: r.v2_g2_bank_s as number,
    v1_peak_ram_mb: r.v1_peak_ram_mb as number,
    v2_peak_ram_mb: r.v2_peak_ram_mb as number,
    completed_at: r.completed_at as number,
  }));
}
