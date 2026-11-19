import {DatabaseSync} from 'node:sqlite';

import * as ratings from '../server/ratings';

import {ensureAgentLadderStats, updateFamilyStreaksForMatch} from './agent-ladder-stats';
import {getVersionById} from './agent-versions';
import {recomputeLadderRatings} from './ladder-entries';
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
  p1Game1PeakRam: number;
  p1Game2PeakRam: number;
  p2Game1PeakRam: number;
  p2Game2PeakRam: number;
  p1Game1BankSeconds: number;
  p1Game2BankSeconds: number;
  p2Game1BankSeconds: number;
  p2Game2BankSeconds: number;
  p1Game1MeanTurnMillis: number;
  p1Game2MeanTurnMillis: number;
  p2Game1MeanTurnMillis: number;
  p2Game2MeanTurnMillis: number;
  p1Game1InitMillis?: number;
  p1Game2InitMillis?: number;
  p2Game1InitMillis?: number;
  p2Game2InitMillis?: number;
  p1Game1TeamPreviewMillis?: number;
  p1Game2TeamPreviewMillis?: number;
  p2Game1TeamPreviewMillis?: number;
  p2Game2TeamPreviewMillis?: number;
  completedAt: number;
}

export interface RecordMatchInput {
  match: CompletedMatchPayload;
}

export interface RecentMatchPlayer {
  slug: string;
  name: string;
  version: string;
  teamLabel?: string;
  initMillis: number;
  teamPreviewMillis?: number;
  meanTurnMillis: number;
  peakRam: number;
}

export interface RecentMatchGameStats {
  initMillis: number;
  teamPreviewMillis?: number;
  meanTurnMillis: number;
  bankSeconds: number;
  peakRam: number;
}

export interface RecentMatchGame {
  gameNumber: 1 | 2;
  outcome: ratings.GameOutcome;
  turns: number;
  endReason: string;
  p1: RecentMatchGameStats;
  p2: RecentMatchGameStats;
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
  category: ratings.MatchCategory;
  p1: RecentMatchPlayer;
  p2: RecentMatchPlayer;
  games: [RecentMatchGame, RecentMatchGame];
  completedAt: number;
}

export interface MatchesPageQuery {
  slot?: string;
  ladderId?: string;
  agentSlug?: string;
  agentVersion?: string;
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

function meanOptional(a: number | undefined, b: number | undefined): number | undefined {
  if (a !== undefined && b !== undefined) return (a + b) / 2;
  return a ?? b;
}

function resolvePayloadSideTelemetry(m: CompletedMatchPayload, side: 'p1' | 'p2') {
  const g1Ram = side === 'p1' ? m.p1Game1PeakRam : m.p2Game1PeakRam;
  const g2Ram = side === 'p1' ? m.p1Game2PeakRam : m.p2Game2PeakRam;
  const g1Init = (side === 'p1' ? m.p1Game1InitMillis : m.p2Game1InitMillis) ?? 0;
  const g2Init = (side === 'p1' ? m.p1Game2InitMillis : m.p2Game2InitMillis) ?? 0;
  const g1Tp = side === 'p1' ? m.p1Game1TeamPreviewMillis : m.p2Game1TeamPreviewMillis;
  const g2Tp = side === 'p1' ? m.p1Game2TeamPreviewMillis : m.p2Game2TeamPreviewMillis;
  const g1Turn = side === 'p1' ? m.p1Game1MeanTurnMillis : m.p2Game1MeanTurnMillis;
  const g2Turn = side === 'p1' ? m.p1Game2MeanTurnMillis : m.p2Game2MeanTurnMillis;
  return {
    g1: {ram: g1Ram, initMillis: g1Init, teamPreviewMillis: g1Tp, meanTurnMillis: g1Turn},
    g2: {ram: g2Ram, initMillis: g2Init, teamPreviewMillis: g2Tp, meanTurnMillis: g2Turn},
    peakRam: Math.max(g1Ram, g2Ram),
    meanRam: (g1Ram + g2Ram) / 2,
    initMillis: Math.round((g1Init + g2Init) / 2),
    teamPreviewMillis: meanOptional(g1Tp, g2Tp),
    meanTurnMillis: Math.round((g1Turn + g2Turn) / 2),
  };
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

    const p1 = resolvePayloadSideTelemetry(m, 'p1');
    const p2 = resolvePayloadSideTelemetry(m, 'p2');

    db.prepare(`
      INSERT INTO matches (
        id, ladder_id, p1_version_id, p2_version_id, seed, p1_team_label, p2_team_label,
        game1_outcome, game2_outcome, category, game1_turns, game2_turns,
        game1_end_reason, game2_end_reason,
        p1_game1_peak_ram, p1_game2_peak_ram, p2_game1_peak_ram, p2_game2_peak_ram,
        p1_game1_bank_seconds, p1_game2_bank_seconds, p2_game1_bank_seconds, p2_game2_bank_seconds,
        p1_game1_init_millis, p1_game2_init_millis, p2_game1_init_millis, p2_game2_init_millis,
        p1_game1_team_preview_millis, p1_game2_team_preview_millis,
        p2_game1_team_preview_millis, p2_game2_team_preview_millis,
        p1_game1_mean_turn_millis, p1_game2_mean_turn_millis,
        p2_game1_mean_turn_millis, p2_game2_mean_turn_millis,
        completed_at
      )
      VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?
      )
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
      p1.g1.ram,
      p1.g2.ram,
      p2.g1.ram,
      p2.g2.ram,
      m.p1Game1BankSeconds,
      m.p1Game2BankSeconds,
      m.p2Game1BankSeconds,
      m.p2Game2BankSeconds,
      p1.g1.initMillis,
      p1.g2.initMillis,
      p2.g1.initMillis,
      p2.g2.initMillis,
      p1.g1.teamPreviewMillis ?? null,
      p1.g2.teamPreviewMillis ?? null,
      p2.g1.teamPreviewMillis ?? null,
      p2.g2.teamPreviewMillis ?? null,
      p1.g1.meanTurnMillis,
      p1.g2.meanTurnMillis,
      p2.g1.meanTurnMillis,
      p2.g2.meanTurnMillis,
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
             max_win_streak, max_loss_streak,
             mean_init_millis, mean_team_preview_millis, team_preview_matches,
             mean_turn_millis, mean_ram, peak_ram
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
          mean_init_millis = ?,
          mean_team_preview_millis = ?,
          team_preview_matches = ?,
          mean_turn_millis = ?,
          mean_ram = ?,
          peak_ram = ?
      WHERE ladder_id = ? AND version_id = ?
    `);

    const applySide = (side: {
      versionId: number;
      invert: boolean;
      outcome: 'W' | 'L' | 'T';
      initMillis: number;
      teamPreviewMillis?: number;
      meanTurnMillis: number;
      meanRam: number;
      peakRam: number;
      faults: {crashes: number; timeouts: number; ooms: number};
    }) => {
      const {
        versionId,
        invert,
        outcome,
        initMillis,
        teamPreviewMillis,
        meanTurnMillis,
        meanRam,
        peakRam,
        faults,
      } = side;
      const cur = selectEntryCounters.get(m.ladderId, versionId) as {
        matches: number;
        current_win_streak: number;
        current_loss_streak: number;
        max_win_streak: number;
        max_loss_streak: number;
        mean_init_millis: number;
        mean_team_preview_millis: number | null;
        team_preview_matches: number;
        mean_turn_millis: number;
        mean_ram: number;
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
      const nextMeanInit = (cur.mean_init_millis * cur.matches + initMillis) / nextPlayed;
      const nextTpMatches = teamPreviewMillis !== undefined
        ? cur.team_preview_matches + 1
        : cur.team_preview_matches;
      const nextMeanTp = teamPreviewMillis !== undefined
        ? ((cur.mean_team_preview_millis ?? 0) * cur.team_preview_matches + teamPreviewMillis) /
          nextTpMatches
        : cur.mean_team_preview_millis;
      const nextMeanTurn = (cur.mean_turn_millis * cur.matches + meanTurnMillis) / nextPlayed;
      const nextMeanRam = (cur.mean_ram * cur.matches + meanRam) / nextPlayed;
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
        nextMeanInit,
        nextMeanTp,
        nextTpMatches,
        nextMeanTurn,
        nextMeanRam,
        nextPeakRam,
        m.ladderId,
        versionId
      );
    };

    applySide({
      versionId: m.p1VersionId,
      invert: false,
      outcome: ternary.p1,
      initMillis: p1.initMillis,
      teamPreviewMillis: p1.teamPreviewMillis,
      meanTurnMillis: p1.meanTurnMillis,
      meanRam: p1.meanRam,
      peakRam: p1.peakRam,
      faults: countSideFaults(
        m.game1Outcome === 'L',
        m.game2Outcome === 'L',
        m.game1EndReason,
        m.game2EndReason
      ),
    });
    applySide({
      versionId: m.p2VersionId,
      invert: true,
      outcome: ternary.p2,
      initMillis: p2.initMillis,
      teamPreviewMillis: p2.teamPreviewMillis,
      meanTurnMillis: p2.meanTurnMillis,
      meanRam: p2.meanRam,
      peakRam: p2.peakRam,
      faults: countSideFaults(
        m.game1Outcome === 'W',
        m.game2Outcome === 'W',
        m.game1EndReason,
        m.game2EndReason
      ),
    });

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

    const dayUtc = new Date(m.completedAt * 1000).toISOString().slice(0, 10);
    recomputeLadderRatings(db, m.ladderId, m.completedAt, prevMatchSec, dayUtc);

    let archivedLadder = false;
    if (ladder.status === 'settling' && !ladders.canSettleLadder(db, ladder)) {
      ladders.archiveLadderInPlace(db, m.ladderId, m.completedAt);
      archivedLadder = true;
    }

    return {duplicate: false, archivedLadder};
  });
}

function mapRecentMatchRow(r: Record<string, unknown>): RecentMatchView {
  const p1G1InitMs = r.p1_game1_init_millis as number;
  const p1G2InitMs = r.p1_game2_init_millis as number;
  const p2G1InitMs = r.p2_game1_init_millis as number;
  const p2G2InitMs = r.p2_game2_init_millis as number;
  const p1G1TpMs = (r.p1_game1_team_preview_millis as number | null) ?? undefined;
  const p1G2TpMs = (r.p1_game2_team_preview_millis as number | null) ?? undefined;
  const p2G1TpMs = (r.p2_game1_team_preview_millis as number | null) ?? undefined;
  const p2G2TpMs = (r.p2_game2_team_preview_millis as number | null) ?? undefined;
  const p1TpMs = meanOptional(p1G1TpMs, p1G2TpMs);
  const p2TpMs = meanOptional(p2G1TpMs, p2G2TpMs);
  const p1G1TurnMs = r.p1_game1_mean_turn_millis as number;
  const p1G2TurnMs = r.p1_game2_mean_turn_millis as number;
  const p2G1TurnMs = r.p2_game1_mean_turn_millis as number;
  const p2G2TurnMs = r.p2_game2_mean_turn_millis as number;
  const p1G1Ram = r.p1_game1_peak_ram as number;
  const p1G2Ram = r.p1_game2_peak_ram as number;
  const p2G1Ram = r.p2_game1_peak_ram as number;
  const p2G2Ram = r.p2_game2_peak_ram as number;
  const p1TeamLabel = (r.p1_team_label as string | null) ?? undefined;
  const p2TeamLabel = (r.p2_team_label as string | null) ?? undefined;
  return {
    id: r.id as string,
    ladderId: r.ladder_id as string,
    ladderName: r.ladder_name as string,
    ladderStatus: r.ladder_status as ladders.LadderStatus,
    slot: r.slot as ladders.LadderSlot,
    format: r.format as string,
    teamMode: r.team_mode as ladders.TeamMode,
    seed: r.seed as string,
    category: r.category as ratings.MatchCategory,
    p1: {
      slug: r.p1_slug as string,
      name: r.p1_name as string,
      version: r.p1_version as string,
      ...(p1TeamLabel !== undefined ? {teamLabel: p1TeamLabel} : {}),
      initMillis: Math.round((p1G1InitMs + p1G2InitMs) / 2),
      ...(p1TpMs !== undefined ? {teamPreviewMillis: Math.round(p1TpMs)} : {}),
      meanTurnMillis: Math.round((p1G1TurnMs + p1G2TurnMs) / 2),
      peakRam: Math.max(p1G1Ram, p1G2Ram),
    },
    p2: {
      slug: r.p2_slug as string,
      name: r.p2_name as string,
      version: r.p2_version as string,
      ...(p2TeamLabel !== undefined ? {teamLabel: p2TeamLabel} : {}),
      initMillis: Math.round((p2G1InitMs + p2G2InitMs) / 2),
      ...(p2TpMs !== undefined ? {teamPreviewMillis: Math.round(p2TpMs)} : {}),
      meanTurnMillis: Math.round((p2G1TurnMs + p2G2TurnMs) / 2),
      peakRam: Math.max(p2G1Ram, p2G2Ram),
    },
    games: [
      {
        gameNumber: 1,
        outcome: r.game1_outcome as ratings.GameOutcome,
        turns: r.game1_turns as number,
        endReason: r.game1_end_reason as string,
        p1: {
          initMillis: p1G1InitMs,
          ...(p1G1TpMs !== undefined ? {teamPreviewMillis: p1G1TpMs} : {}),
          meanTurnMillis: p1G1TurnMs,
          bankSeconds: r.p1_game1_bank_seconds as number,
          peakRam: p1G1Ram,
        },
        p2: {
          initMillis: p2G1InitMs,
          ...(p2G1TpMs !== undefined ? {teamPreviewMillis: p2G1TpMs} : {}),
          meanTurnMillis: p2G1TurnMs,
          bankSeconds: r.p2_game1_bank_seconds as number,
          peakRam: p2G1Ram,
        },
      },
      {
        gameNumber: 2,
        outcome: r.game2_outcome as ratings.GameOutcome,
        turns: r.game2_turns as number,
        endReason: r.game2_end_reason as string,
        p1: {
          initMillis: p1G2InitMs,
          ...(p1G2TpMs !== undefined ? {teamPreviewMillis: p1G2TpMs} : {}),
          meanTurnMillis: p1G2TurnMs,
          bankSeconds: r.p1_game2_bank_seconds as number,
          peakRam: p1G2Ram,
        },
        p2: {
          initMillis: p2G2InitMs,
          ...(p2G2TpMs !== undefined ? {teamPreviewMillis: p2G2TpMs} : {}),
          meanTurnMillis: p2G2TurnMs,
          bankSeconds: r.p2_game2_bank_seconds as number,
          peakRam: p2G2Ram,
        },
      },
    ],
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
    m.p1_game1_init_millis,
    m.p1_game2_init_millis,
    m.p2_game1_init_millis,
    m.p2_game2_init_millis,
    m.p1_game1_team_preview_millis,
    m.p1_game2_team_preview_millis,
    m.p2_game1_team_preview_millis,
    m.p2_game2_team_preview_millis,
    m.p1_game1_mean_turn_millis,
    m.p1_game2_mean_turn_millis,
    m.p2_game1_mean_turn_millis,
    m.p2_game2_mean_turn_millis,
    m.p1_game1_bank_seconds,
    m.p1_game2_bank_seconds,
    m.p2_game1_bank_seconds,
    m.p2_game2_bank_seconds,
    m.p1_game1_peak_ram,
    m.p1_game2_peak_ram,
    m.p2_game1_peak_ram,
    m.p2_game2_peak_ram,
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

function resolveVersionIdsForSlug(
  db: DatabaseSync,
  slug: string,
  version?: string
): number[] {
  const rows = version !== undefined
    ? (db.prepare(`
        SELECT av.id
        FROM agent_versions av
        JOIN agents a ON a.id = av.agent_id
        WHERE a.slug = ? AND av.version = ?
        ORDER BY av.id ASC
      `).all(slug, version) as Array<{id: number}>)
    : (db.prepare(`
        SELECT av.id
        FROM agent_versions av
        JOIN agents a ON a.id = av.agent_id
        WHERE a.slug = ?
        ORDER BY av.id ASC
      `).all(slug) as Array<{id: number}>);
  return rows.map(r => r.id);
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

  // Pre-resolve `agent_versions.id` lists so SQLite can apply its `MULTI-INDEX OR` planner over
  // `idx_matches_p1_*` + `idx_matches_p2_*` instead of scanning `matches` across joined aliases.
  const primaryIds = query.agentSlug
    ? resolveVersionIdsForSlug(db, query.agentSlug, query.agentVersion)
    : undefined;
  const oppIds = query.opponentSlug
    ? resolveVersionIdsForSlug(db, query.opponentSlug)
    : undefined;

  if (primaryIds?.length === 0 || oppIds?.length === 0) {
    return {matches: [], total: 0};
  }

  const inPlaceholders = (ids: number[]) => ids.map(() => '?').join(', ');

  if (primaryIds && oppIds) {
    const pIn = inPlaceholders(primaryIds);
    const oIn = inPlaceholders(oppIds);
    where.push(
      `((m.p1_version_id IN (${pIn}) AND m.p2_version_id IN (${oIn})) OR ` +
      `(m.p2_version_id IN (${pIn}) AND m.p1_version_id IN (${oIn})))`
    );
    params.push(...primaryIds, ...oppIds, ...primaryIds, ...oppIds);
  } else if (primaryIds) {
    const pIn = inPlaceholders(primaryIds);
    where.push(`(m.p1_version_id IN (${pIn}) OR m.p2_version_id IN (${pIn}))`);
    params.push(...primaryIds, ...primaryIds);
  } else if (oppIds) {
    const oIn = inPlaceholders(oppIds);
    where.push(`(m.p1_version_id IN (${oIn}) OR m.p2_version_id IN (${oIn}))`);
    params.push(...oppIds, ...oppIds);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const countFromSql = query.slot && query.slot !== 'all'
    ? 'FROM matches m JOIN ladders l ON l.id = m.ladder_id'
    : 'FROM matches m';

  const countRow = db.prepare(`
    SELECT COUNT(*) AS count
    ${countFromSql}
    ${whereSql}
  `).get(...params) as {count: number};

  const limit = Math.max(1, Math.min(200, Math.trunc(query.limit ?? 25)));
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

export function getLastCompletedAtByLadder(db: DatabaseSync): Map<string, number> {
  const rows = db.prepare(`
    SELECT ladder_id, MAX(completed_at) AS last_completed_at
    FROM matches
    GROUP BY ladder_id
  `).all() as Array<{ladder_id: string; last_completed_at: number | null}>;
  const map = new Map<string, number>();
  for (const r of rows) {
    if (r.last_completed_at !== null) map.set(r.ladder_id, r.last_completed_at);
  }
  return map;
}

export function getRecentMatches(db: DatabaseSync, limit = 25): RecentMatchView[] {
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
  limit = 25
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
