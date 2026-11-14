import {DatabaseSync} from 'node:sqlite';

import * as ratings from '../server/ratings';

import {ensureAgentLadderStats, updateFamilyStreaksForMatch} from './agent-ladder-stats';
import {getVersionById} from './agent-versions';
import {LadderStandingOverride, recomputeLadderRatings} from './ladder-entries';
import * as ladders from './ladders';
import {upsertPairAggregateForMatch} from './pair-aggregates';

import {TransactionRunner} from './index';

export interface CompletedMatchPayload {
  id: string;
  ladderId: string;
  p1VersionId: number;
  p2VersionId: number;
  seed: string;
  p1TeamLabel?: string;
  p2TeamLabel?: string;
  game1Outcome: ratings.GameOutcome;
  game2Outcome: ratings.GameOutcome;
  category: ratings.MatchCategory;
  game1Turns: number;
  game2Turns: number;
  game1EndReason: string;
  game2EndReason: string;
  p1PeakRam: number;
  p2PeakRam: number;
  p1Game1BankSeconds: number;
  p1Game2BankSeconds: number;
  p2Game1BankSeconds: number;
  p2Game2BankSeconds: number;
  p1MeanTurnMillis: number;
  p2MeanTurnMillis: number;
  completedAt: number;
}

export interface RecordMatchInput {
  match: CompletedMatchPayload;
  ladderStatus?: ladders.LadderStatus;
  ladderStandings?: LadderStandingOverride[];
}

export interface RecentMatchView {
  id: string;
  ladderId: string;
  ladderName: string;
  ladderStatus: ladders.LadderStatus;
  slot: ladders.LadderSlot;
  format: string;
  teamMode: ladders.TeamMode;
  seed: string;
  p1TeamLabel?: string;
  p2TeamLabel?: string;
  p1: {slug: string; name: string; version: string};
  p2: {slug: string; name: string; version: string};
  game1Outcome: ratings.GameOutcome;
  game2Outcome: ratings.GameOutcome;
  category: ratings.MatchCategory;
  game1Turns: number;
  game2Turns: number;
  game1EndReason: string;
  game2EndReason: string;
  p1MeanTurnMillis: number;
  p2MeanTurnMillis: number;
  p1Game1BankSeconds: number;
  p1Game2BankSeconds: number;
  p2Game1BankSeconds: number;
  p2Game2BankSeconds: number;
  p1PeakRam: number;
  p2PeakRam: number;
  completedAt: number;
}

export interface MatchesPageQuery {
  slot?: string;
  ladderId?: string;
  agentSlug?: string;
  opponentSlug?: string;
  limit?: number;
  offset?: number;
}

export interface MatchesPageResult {
  matches: RecentMatchView[];
  total: number;
}

function categoryDeltas(cat: ratings.MatchCategory, invert = false) {
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

// Atomically ingests a completed 2-game blind-pair match in a single `BEGIN IMMEDIATE` SQLite
// transaction: deduplicates by `match.id` (so runner outbox retries after tunnel reconnects are
// idempotent), updates per-version and pairwise sufficient statistics, runs the warm-started
// Newton-Raphson Generalized Davidson rating solve, and auto-archives `'settling'` seasons once
// their final unsettled entry finishes settling.
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

    const ladder = ladders.getLadder(db, m.ladderId);
    if (!ladder) {
      throw Object.assign(new Error(`Unknown ladderId "${m.ladderId}"`), {status: 404});
    }
    if (ladder.status === 'archived') {
      throw Object.assign(
        new Error(`Ladder "${m.ladderId}" is archived and no longer accepts matches.`),
        {status: 409}
      );
    }
    const v1 = getVersionById(db, m.p1VersionId);
    const v2 = getVersionById(db, m.p2VersionId);
    if (!v1 || !v2) {
      throw Object.assign(
        new Error(`Unknown versionId in match (${m.p1VersionId} vs ${m.p2VersionId})`),
        {status: 404}
      );
    }

    const prevRow = db.prepare(
      'SELECT MAX(completed_at) AS prev FROM matches WHERE ladder_id = ?'
    ).get(m.ladderId) as {prev: number | null} | undefined;
    const prevMatchSec = prevRow?.prev ?? undefined;

    db.prepare(`
      INSERT INTO matches (
        id, ladder_id, p1_version_id, p2_version_id, seed, p1_team_label, p2_team_label,
        game1_outcome, game2_outcome, category, game1_turns, game2_turns,
        game1_end_reason, game2_end_reason, p1_peak_ram, p2_peak_ram,
        p1_game1_bank_seconds, p1_game2_bank_seconds, p2_game1_bank_seconds, p2_game2_bank_seconds,
        p1_mean_turn_millis, p2_mean_turn_millis, completed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      m.id,
      m.ladderId,
      m.p1VersionId,
      m.p2VersionId,
      m.seed,
      m.p1TeamLabel ?? null,
      m.p2TeamLabel ?? null,
      m.game1Outcome,
      m.game2Outcome,
      m.category,
      m.game1Turns,
      m.game2Turns,
      m.game1EndReason,
      m.game2EndReason,
      m.p1PeakRam,
      m.p2PeakRam,
      m.p1Game1BankSeconds,
      m.p1Game2BankSeconds,
      m.p2Game1BankSeconds,
      m.p2Game2BankSeconds,
      m.p1MeanTurnMillis,
      m.p2MeanTurnMillis,
      m.completedAt
    );

    const ensureEntry = db.prepare(`
      INSERT OR IGNORE INTO ladder_entries (ladder_id, version_id, role, started_at)
      VALUES (?, ?, 'champion', ?)
    `);
    ensureEntry.run(m.ladderId, m.p1VersionId, m.completedAt);
    ensureEntry.run(m.ladderId, m.p2VersionId, m.completedAt);

    ensureAgentLadderStats(db, m.ladderId, v1.agentId);
    ensureAgentLadderStats(db, m.ladderId, v2.agentId);

    const ternary = ratings.toTernaryMatchOutcome(m.category);
    const selectEntryCounters = db.prepare(`
      SELECT matches, current_win_streak, current_loss_streak,
             max_win_streak, max_loss_streak, mean_turn_millis, peak_ram
      FROM ladder_entries
      WHERE ladder_id = ? AND version_id = ?
    `);
    const updateEntryCounters = db.prepare(`
      UPDATE ladder_entries
      SET matches = ?,
          ww = ww + ?,
          wt = wt + ?,
          split = split + ?,
          tl = tl + ?,
          ll = ll + ?,
          current_win_streak = ?,
          current_loss_streak = ?,
          max_win_streak = ?,
          max_loss_streak = ?,
          crashes = crashes + ?,
          timeouts = timeouts + ?,
          ooms = ooms + ?,
          mean_turn_millis = ?,
          peak_ram = ?
      WHERE ladder_id = ? AND version_id = ?
    `);

    const applySide = (
      versionId: number,
      invert: boolean,
      outcome: 'W' | 'L' | 'T',
      meanTurnMillis: number,
      peakRam: number,
      faults: {crashes: number; timeouts: number; ooms: number}
    ) => {
      const cur = selectEntryCounters.get(m.ladderId, versionId) as {
        matches: number;
        current_win_streak: number;
        current_loss_streak: number;
        max_win_streak: number;
        max_loss_streak: number;
        mean_turn_millis: number;
        peak_ram: number;
      };
      const streaks: ratings.StreakState = {
        currentWinStreak: cur.current_win_streak,
        currentLossStreak: cur.current_loss_streak,
        maxWinStreak: cur.max_win_streak,
        maxLossStreak: cur.max_loss_streak,
      };
      ratings.applyMatchOutcomeToStreaks(streaks, outcome);
      const d = categoryDeltas(m.category, invert);
      const nextPlayed = cur.matches + 1;
      const nextMeanTurn = (cur.mean_turn_millis * cur.matches + meanTurnMillis) / nextPlayed;
      const nextPeakRam = Math.max(cur.peak_ram, peakRam);

      updateEntryCounters.run(
        nextPlayed,
        d.ww,
        d.wt,
        d.split,
        d.tl,
        d.ll,
        streaks.currentWinStreak,
        streaks.currentLossStreak,
        streaks.maxWinStreak,
        streaks.maxLossStreak,
        faults.crashes,
        faults.timeouts,
        faults.ooms,
        nextMeanTurn,
        nextPeakRam,
        m.ladderId,
        versionId
      );
    };

    applySide(
      m.p1VersionId,
      false,
      ternary.p1,
      m.p1MeanTurnMillis,
      m.p1PeakRam,
      countSideFaults(
        m.game1Outcome === 'L',
        m.game2Outcome === 'L',
        m.game1EndReason,
        m.game2EndReason
      )
    );
    applySide(
      m.p2VersionId,
      true,
      ternary.p2,
      m.p2MeanTurnMillis,
      m.p2PeakRam,
      countSideFaults(
        m.game1Outcome === 'W',
        m.game2Outcome === 'W',
        m.game1EndReason,
        m.game2EndReason
      )
    );

    if (v1.agentId !== v2.agentId) {
      updateFamilyStreaksForMatch(db, m.ladderId, v1.agentId, ternary.p1);
      updateFamilyStreaksForMatch(db, m.ladderId, v2.agentId, ternary.p2);
    }

    const lowVersionId = Math.min(m.p1VersionId, m.p2VersionId);
    const highVersionId = Math.max(m.p1VersionId, m.p2VersionId);
    const p1IsLow = m.p1VersionId === lowVersionId;
    const pairDelta = categoryDeltas(m.category, !p1IsLow);
    const lowOutcome = p1IsLow ? ternary.p1 : ternary.p2;
    upsertPairAggregateForMatch(
      db,
      m.ladderId,
      lowVersionId,
      highVersionId,
      pairDelta,
      lowOutcome
    );

    if (input.ladderStandings) {
      const updateOverride = db.prepare(`
        UPDATE ladder_entries
        SET role = COALESCE(?, role),
            is_anchor = COALESCE(?, is_anchor)
        WHERE ladder_id = ? AND version_id = ?
      `);
      for (const s of input.ladderStandings) {
        updateOverride.run(s.role ?? null, s.isAnchor ?? null, m.ladderId, s.versionId);
      }
    }

    const dayUtc = new Date(m.completedAt * 1000).toISOString().slice(0, 10);
    recomputeLadderRatings(db, m.ladderId, m.completedAt, prevMatchSec, dayUtc);

    let archivedLadder = false;
    if (ladder.status === 'settling' || input.ladderStatus === 'archived') {
      if (input.ladderStatus === 'archived' || !ladders.canSettleLadder(db, ladder)) {
        ladders.archiveLadderInPlace(db, m.ladderId, m.completedAt);
        archivedLadder = true;
      }
    }

    return {duplicate: false, archivedLadder};
  });
}

function mapRecentMatchRow(r: Record<string, unknown>): RecentMatchView {
  return {
    id: r.id as string,
    ladderId: r.ladder_id as string,
    ladderName: r.ladder_name as string,
    ladderStatus: r.ladder_status as ladders.LadderStatus,
    slot: r.slot as ladders.LadderSlot,
    format: r.format as string,
    teamMode: r.team_mode as ladders.TeamMode,
    seed: r.seed as string,
    p1TeamLabel: (r.p1_team_label as string | null) ?? undefined,
    p2TeamLabel: (r.p2_team_label as string | null) ?? undefined,
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
    game1Outcome: r.game1_outcome as ratings.GameOutcome,
    game2Outcome: r.game2_outcome as ratings.GameOutcome,
    category: r.category as ratings.MatchCategory,
    game1Turns: r.game1_turns as number,
    game2Turns: r.game2_turns as number,
    game1EndReason: r.game1_end_reason as string,
    game2EndReason: r.game2_end_reason as string,
    p1MeanTurnMillis: r.p1_mean_turn_millis as number,
    p2MeanTurnMillis: r.p2_mean_turn_millis as number,
    p1Game1BankSeconds: r.p1_game1_bank_seconds as number,
    p1Game2BankSeconds: r.p1_game2_bank_seconds as number,
    p2Game1BankSeconds: r.p2_game1_bank_seconds as number,
    p2Game2BankSeconds: r.p2_game2_bank_seconds as number,
    p1PeakRam: r.p1_peak_ram as number,
    p2PeakRam: r.p2_peak_ram as number,
    completedAt: r.completed_at as number,
  };
}

const RECENT_MATCH_SELECT_SQL = `
  SELECT
    m.id,
    m.ladder_id,
    l.name AS ladder_name,
    l.status AS ladder_status,
    l.slot,
    l.format,
    l.team AS team_mode,
    m.seed,
    m.p1_team_label,
    m.p2_team_label,
    a1.slug AS p1_slug,
    a1.name AS p1_name,
    v1.version AS p1_version,
    a2.slug AS p2_slug,
    a2.name AS p2_name,
    v2.version AS p2_version,
    m.game1_outcome,
    m.game2_outcome,
    m.category,
    m.game1_turns,
    m.game2_turns,
    m.game1_end_reason,
    m.game2_end_reason,
    m.p1_mean_turn_millis,
    m.p2_mean_turn_millis,
    m.p1_game1_bank_seconds,
    m.p1_game2_bank_seconds,
    m.p2_game1_bank_seconds,
    m.p2_game2_bank_seconds,
    m.p1_peak_ram,
    m.p2_peak_ram,
    m.completed_at
  FROM matches m
  JOIN ladders l ON l.id = m.ladder_id
  JOIN agent_versions v1 ON v1.id = m.p1_version_id
  JOIN agents a1 ON a1.id = v1.agent_id
  JOIN agent_versions v2 ON v2.id = m.p2_version_id
  JOIN agents a2 ON a2.id = v2.agent_id
`;

export function getMatch(db: DatabaseSync, id: string): RecentMatchView | undefined {
  const row = db.prepare(`${RECENT_MATCH_SELECT_SQL} WHERE m.id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  return row ? mapRecentMatchRow(row) : undefined;
}

export function getMatchesPage(
  db: DatabaseSync,
  query: MatchesPageQuery = {}
): MatchesPageResult {
  const where: string[] = [];
  const params: Array<string | number> = [];

  if (query.slot && query.slot !== 'all') {
    where.push('l.slot = ?');
    params.push(query.slot);
  }
  if (query.ladderId) {
    where.push('m.ladder_id = ?');
    params.push(query.ladderId);
  }
  if (query.agentSlug && query.opponentSlug) {
    where.push('((a1.slug = ? AND a2.slug = ?) OR (a1.slug = ? AND a2.slug = ?))');
    params.push(query.agentSlug, query.opponentSlug, query.opponentSlug, query.agentSlug);
  } else if (query.agentSlug) {
    where.push('(a1.slug = ? OR a2.slug = ?)');
    params.push(query.agentSlug, query.agentSlug);
  } else if (query.opponentSlug) {
    where.push('(a1.slug = ? OR a2.slug = ?)');
    params.push(query.opponentSlug, query.opponentSlug);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const countFromSql = (query.agentSlug || query.opponentSlug)
    ? `FROM matches m
       JOIN ladders l ON l.id = m.ladder_id
       JOIN agent_versions v1 ON v1.id = m.p1_version_id
       JOIN agents a1 ON a1.id = v1.agent_id
       JOIN agent_versions v2 ON v2.id = m.p2_version_id
       JOIN agents a2 ON a2.id = v2.agent_id`
    : query.slot && query.slot !== 'all'
      ? 'FROM matches m JOIN ladders l ON l.id = m.ladder_id'
      : 'FROM matches m';

  const countRow = db.prepare(`
    SELECT COUNT(*) AS count
    ${countFromSql}
    ${whereSql}
  `).get(...params) as {count: number};

  const limit = Math.max(1, Math.min(200, Math.trunc(query.limit ?? 50)));
  const offset = Math.max(0, Math.trunc(query.offset ?? 0));

  const rows = db.prepare(`
    ${RECENT_MATCH_SELECT_SQL}
    ${whereSql}
    ORDER BY m.completed_at DESC, m.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as Array<Record<string, unknown>>;

  return {
    matches: rows.map(mapRecentMatchRow),
    total: countRow.count,
  };
}

export function getMatchCountsBySlot(db: DatabaseSync): Record<string, number> {
  const rows = db.prepare(`
    SELECT l.slot AS slot, COUNT(*) AS count
    FROM matches m
    JOIN ladders l ON l.id = m.ladder_id
    GROUP BY l.slot
  `).all() as Array<{slot: string; count: number}>;

  const counts: Record<string, number> = {all: 0};
  for (const row of rows) {
    counts[row.slot] = row.count;
    counts.all += row.count;
  }
  return counts;
}

export function getRecentMatches(db: DatabaseSync, limit = 50): RecentMatchView[] {
  const rows = db.prepare(`
    ${RECENT_MATCH_SELECT_SQL}
    ORDER BY m.completed_at DESC, m.id DESC
    LIMIT ?
  `).all(limit) as Array<Record<string, unknown>>;
  return rows.map(mapRecentMatchRow);
}

export function getRecentMatchesForAgentOnLadder(
  db: DatabaseSync,
  agentId: number,
  ladderId: string,
  limit = 30
): RecentMatchView[] {
  const rows = db.prepare(`
    ${RECENT_MATCH_SELECT_SQL}
    WHERE m.ladder_id = ?
      AND (v1.agent_id = ? OR v2.agent_id = ?)
    ORDER BY m.completed_at DESC, m.id DESC
    LIMIT ?
  `).all(ladderId, agentId, agentId, limit) as Array<Record<string, unknown>>;
  return rows.map(mapRecentMatchRow);
}
