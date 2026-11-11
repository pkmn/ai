import * as fs from 'fs';
import * as path from 'path';

import type {Renderer} from 'site/build/page';

import {
  AVATARS_DIR,
  type ArenaDB,
  type BotLadderProfileEntry,
  type BotLadderStatsRow,
  type BotRow,
  type LadderRow,
  type LadderSnapshotHistoryRow,
  type LeaderboardEntryView,
  type PairAggregateRow,
  type RecentMatchView,
} from '../db';
import {header} from '../static/build';
import {escapeHtml, renderTemplate, root} from '../static/util';

import {
  ELO_SCALE,
  type PairMatchCounts,
  computeDavidsonRatings,
  computeLOS,
  expectedMatchScore,
  toTernaryMatchOutcome,
} from './ratings';
import {
  ARENA_STYLE,
  EXT_ICON,
  type ProjectMeta,
  computeAdjacentLosMap,
  copyFileAtomic,
  formatBotLink,
  formatRelativeTime,
  formatShortDay,
  resolveBotHref,
  safeInlineJson,
  writeFileAtomic,
} from './render';

const PROFILE_STYLE = fs.readFileSync(root('static', 'profile.css'), 'utf8');
const PROFILE_TEMPLATE = fs.readFileSync(root('static', 'profile.html'), 'utf8');

interface VersionDynamicStats {
  rank: string;
  elo: string;
  gxe: string;
  peak: string;
  record: string;
  streak: string;
  telemetry: string;
}

interface LadderProfileClientData {
  optionsHtml: string;
  vstats: Record<string, VersionDynamicStats>;
  reign: Record<string, string>;
}

function formatIsoDate(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

function formatIsoDateTimeUtc(sec: number): string {
  return new Date(sec * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function formatDurationCell(seconds: number, boldDays = false): string {
  if (seconds <= 0) {
    return '<span class="muted">—</span>';
  }
  const days = (seconds / 86400).toFixed(1) + 'd';
  const hours = Math.round(seconds / 3600).toLocaleString('en-US') + 'h';
  const dayHtml = boldDays ? `<strong>${days}</strong>` : days;
  return `${dayHtml} <span class="muted">(${hours})</span>`;
}

function buildReignRowsHtml(
  stats: {
    top1EnteredAt: number | null;
    top1MaxStreakS: number;
    top1TotalS: number;
    top10EnteredAt: number | null;
    top10MaxStreakS: number;
    top10TotalS: number;
    top100EnteredAt: number | null;
    top100MaxStreakS: number;
    top100TotalS: number;
  },
  nowSec: number
): string {
  const cur1 = stats.top1EnteredAt !== null
    ? Math.max(0, nowSec - stats.top1EnteredAt)
    : 0;
  const max1 = Math.max(stats.top1MaxStreakS, cur1);
  const tot1 = stats.top1TotalS;

  const cur10 = stats.top10EnteredAt !== null
    ? Math.max(0, nowSec - stats.top10EnteredAt)
    : 0;
  const max10 = Math.max(stats.top10MaxStreakS, cur10);
  const tot10 = stats.top10TotalS;

  const cur100 = stats.top100EnteredAt !== null
    ? Math.max(0, nowSec - stats.top100EnteredAt)
    : 0;
  const max100 = Math.max(stats.top100MaxStreakS, cur100);
  const tot100 = stats.top100TotalS;

  const t1Tip = 'Guaranteed #1 (rank = 1 & settled)';
  const t10Tip = 'Guaranteed Top 10 at 95% confidence (rank_max <= 10)';
  const t100Tip = 'Guaranteed Top 100 at 95% confidence (rank_max <= 100)';

  return [
    `<tr><td title="${escapeHtml(t1Tip)}"><strong>Top 1</strong></td>` +
      `<td class="num">${formatDurationCell(cur1, cur1 > 0)}</td>` +
      `<td class="num">${formatDurationCell(max1)}</td>` +
      `<td class="num">${formatDurationCell(tot1)}</td></tr>`,
    `<tr><td title="${escapeHtml(t10Tip)}"><strong>Top 10</strong></td>` +
      `<td class="num">${formatDurationCell(cur10, cur10 > 0)}</td>` +
      `<td class="num">${formatDurationCell(max10)}</td>` +
      `<td class="num">${formatDurationCell(tot10)}</td></tr>`,
    `<tr><td title="${escapeHtml(t100Tip)}"><strong>Top 100</strong></td>` +
      `<td class="num">${formatDurationCell(cur100, cur100 > 0)}</td>` +
      `<td class="num">${formatDurationCell(max100)}</td>` +
      `<td class="num">${formatDurationCell(tot100)}</td></tr>`,
  ].join('');
}

function formatCurStreakHtml(winStreak: number, lossStreak: number, played: number): string {
  if (winStreak >= 3) return `<span class="yes">W${winStreak}</span>`;
  if (winStreak >= 1) return `W${winStreak}`;
  if (lossStreak >= 3) return `<span class="no">L${lossStreak}</span>`;
  if (lossStreak >= 1) return `L${lossStreak}`;
  if (played > 0) return 'T1';
  return '<span class="muted">—</span>';
}

function buildVersionDynamicStats(
  entry: BotLadderProfileEntry,
  adjacentLos: ReadonlyMap<number, number>
): VersionDynamicStats {
  const isProvisional =
    entry.role !== 'retired' && (entry.matches_played < 10 || entry.rating_se > 60);
  let rank: string;
  if (entry.role === 'retired') {
    const retDate = entry.retired_at ? ` ${formatIsoDate(entry.retired_at)}` : '';
    rank = `<span class="muted">— (retired${retDate})</span>`;
  } else if (entry.rank_current !== null && !isProvisional) {
    const nextRank = entry.rank_current + 1;
    const los = adjacentLos.get(entry.version_id);
    const rangeNote =
      entry.rank_min !== null && entry.rank_max !== null && entry.rank_min < entry.rank_max
        ? ` [${entry.rank_min}–${entry.rank_max}]`
        : '';
    const losNote = los !== undefined
      ? ` · LOS ${(los * 100).toFixed(1)}% vs. #${nextRank}`
      : '';
    const suffix = rangeNote || losNote
      ? ` <span class="muted">${rangeNote}${losNote}</span>`
      : '';
    rank = `<strong>#${entry.rank_current}</strong>${suffix}`;
  } else if (isProvisional) {
    rank = '<span class="muted">Provisional</span>';
  } else {
    rank = '<span class="muted">— (active)</span>';
  }

  const eloRounded = Math.round(entry.rating_elo);
  const ci = entry.is_anchor === 1 ? 0 : Math.round(1.96 * entry.rating_se);
  const elo = `<strong>${eloRounded}</strong> <span class="muted">±${ci}</span>`;
  const gxe = `${entry.gxe.toFixed(1)}%`;

  let peak: string;
  if (entry.settled_at !== null && entry.max_elo !== null) {
    const pRank = entry.best_rank !== null ? `<strong>#${entry.best_rank}</strong> · ` : '';
    const pCi = entry.is_anchor === 1
      ? 0
      : Math.round(1.96 * (entry.max_elo_se ?? entry.rating_se));
    const pGxe = (entry.max_gxe ?? entry.gxe).toFixed(1);
    peak = `${pRank}${Math.round(entry.max_elo)} ` +
      `<span class="muted">±${pCi} (${pGxe}% GXE)</span>`;
  } else {
    peak = '<span class="muted">Unsettled</span>';
  }

  const wins = entry.ww + entry.wt;
  const losses = entry.ll + entry.tl;
  const ties = entry.split;
  const record = `${wins}–${losses}–${ties}`;

  const curHtml = formatCurStreakHtml(
    entry.cur_win_streak,
    entry.cur_loss_streak,
    entry.matches_played
  );
  const streak =
    `${curHtml} <span class="muted">(max ${entry.max_win_streak}W / ` +
    `${entry.max_loss_streak}L)</span>`;

  const turnMs = Math.round(entry.avg_turn_ms);
  const ramText = Math.round(entry.peak_ram_mb).toLocaleString('en-US');
  const telemetry = `${turnMs} ms/turn <span class="muted">· ${ramText} MiB peak</span>`;

  return {rank, elo, gxe, peak, record, streak, telemetry};
}

function buildAllVersionsDynamicStats(
  entries: BotLadderProfileEntry[],
  familyStats: BotLadderStatsRow | undefined,
  adjacentLos: ReadonlyMap<number, number>
): VersionDynamicStats {
  const activeEntries = entries
    .filter(e => e.role === 'champion' || e.role === 'challenger')
    .sort((a, b) => b.rating_lcb - a.rating_lcb || b.rating_elo - a.rating_elo);
  const rep = activeEntries[0] ?? entries[0];
  const base = buildVersionDynamicStats(rep, adjacentLos);

  let totalW = 0;
  let totalL = 0;
  let totalT = 0;
  let totalPlayed = 0;
  for (const e of entries) {
    totalW += e.ww + e.wt;
    totalL += e.ll + e.tl;
    totalT += e.split;
    totalPlayed += e.matches_played;
  }

  let peak = base.peak;
  if (familyStats && familyStats.maxElo !== null) {
    const pRank = familyStats.bestRank !== null
      ? `<strong>#${familyStats.bestRank}</strong> · `
      : '';
    const pCi = Math.round(1.96 * (familyStats.maxEloSe ?? rep.rating_se));
    const pGxe = (familyStats.maxGxe ?? rep.gxe).toFixed(1);
    peak = `${pRank}${Math.round(familyStats.maxElo)} ` +
      `<span class="muted">±${pCi} (${pGxe}% GXE)</span>`;
  }

  let streak = base.streak;
  if (familyStats) {
    const curHtml = formatCurStreakHtml(
      familyStats.curWinStreak,
      familyStats.curLossStreak,
      totalPlayed
    );
    streak =
      `${curHtml} <span class="muted">(max ${familyStats.maxWinStreak}W / ` +
      `${familyStats.maxLossStreak}L)</span>`;
  }

  return {
    rank: base.rank,
    elo: base.elo,
    gxe: base.gxe,
    peak,
    record: `${totalW}–${totalL}–${totalT}`,
    streak,
    telemetry: base.telemetry,
  };
}

function renderVersionsLineageSvg(
  botName: string,
  entriesDesc: BotLadderProfileEntry[],
  snapshots: LadderSnapshotHistoryRow[],
  nowSec: number
): string {
  const entriesChron = [...entriesDesc].reverse();
  const todayUtc = formatIsoDate(nowSec);
  const snapsByVer = new Map<number, LadderSnapshotHistoryRow[]>();
  for (const s of snapshots) {
    if (s.bot_id === undefined) continue;
    const list = snapsByVer.get(s.version_id) ?? [];
    list.push(s);
    snapsByVer.set(s.version_id, list);
  }

  const allDaysSet = new Set<string>();
  const ptsByVer = new Map<number, Array<{day: string; elo: number; se: number}>>();

  for (const e of entriesChron) {
    const raw = (snapsByVer.get(e.version_id) ?? []).filter(r => r.matches_played > 0);
    const pts = raw.map(r => ({day: r.day_utc, elo: r.rating_elo, se: r.rating_se}));
    const startDay = formatIsoDate(e.created_at);
    if (pts.length === 0) {
      pts.push({day: startDay, elo: e.rating_elo, se: e.rating_se});
      if (e.role !== 'retired' && todayUtc > startDay) {
        pts.push({day: todayUtc, elo: e.rating_elo, se: e.rating_se});
      }
    } else if (e.role !== 'retired' && pts[pts.length - 1].day < todayUtc) {
      pts.push({day: todayUtc, elo: e.rating_elo, se: e.rating_se});
    }
    for (const pt of pts) allDaysSet.add(pt.day);
    ptsByVer.set(e.version_id, pts);
  }

  const allDays = [...allDaysSet].sort((a, b) => a.localeCompare(b));
  const dayIdx = new Map<string, number>();
  for (let i = 0; i < allDays.length; i++) dayIdx.set(allDays[i], i);

  let minElo = 1500;
  let maxElo = 1750;
  for (const pts of ptsByVer.values()) {
    for (const pt of pts) {
      if (pt.elo - 40 < minElo) minElo = pt.elo - 40;
      if (pt.elo + 40 > maxElo) maxElo = pt.elo + 40;
    }
  }
  const axisMin = Math.min(1400, Math.floor(minElo / 100) * 100);
  const axisMax = Math.max(1800, Math.ceil(maxElo / 100) * 100);
  const xLeft = 45;
  const xRight = 720;
  const yTop = 25;
  const yBottom = 185;

  const mapX = (day: string): number => {
    if (allDays.length <= 1) return xRight;
    const idx = dayIdx.get(day) ?? 0;
    return Math.round((xLeft + (idx / (allDays.length - 1)) * (xRight - xLeft)) * 10) / 10;
  };
  const mapY = (elo: number): number => {
    const clamped = Math.max(axisMin, Math.min(axisMax, elo));
    const frac = (axisMax - clamped) / Math.max(1, axisMax - axisMin);
    return Math.round((yTop + frac * (yBottom - yTop)) * 10) / 10;
  };

  const gridLines: string[] = [];
  const yLabels: string[] = [];
  const step = axisMax - axisMin > 500 ? 150 : 100;
  for (let tick = axisMax; tick >= axisMin; tick -= step) {
    const y = mapY(tick);
    const attrs = tick === 1500 ? ' stroke-opacity="0.3" stroke-dasharray="3,3"' : '';
    gridLines.push(`<line x1="${xLeft}" y1="${y}" x2="${xRight}" y2="${y}"${attrs} />`);
    yLabels.push(`<text x="38" y="${y + 4}">${tick}</text>`);
  }

  const activeEntries = entriesChron
    .filter(e => e.role === 'champion' || e.role === 'challenger')
    .sort((a, b) => b.rating_lcb - a.rating_lcb);
  const primaryVerId = (activeEntries[0] ?? entriesChron[entriesChron.length - 1])?.version_id;

  const releaseDividers: string[] = [];
  const xLabels: string[] = [];
  const seenLabelX = new Set<number>();

  for (let i = 0; i < entriesChron.length; i++) {
    const e = entriesChron[i];
    const pts = ptsByVer.get(e.version_id) ?? [];
    if (pts.length === 0) continue;
    const x0 = pts.length === 1 && entriesChron.length === 1 ? xLeft : mapX(pts[0].day);
    if (i > 0 && x0 > xLeft + 25 && x0 < xRight - 25) {
      releaseDividers.push(`<line x1="${x0}" y1="18" x2="${x0}" y2="195" />`);
    }
    const nearExisting = [...seenLabelX].some(prevX => Math.abs(prevX - x0) < 75);
    if (!nearExisting && x0 < xRight - 55) {
      seenLabelX.add(x0);
      const dayLabel = `${formatShortDay(pts[0].day)} (${e.version_str})`;
      xLabels.push(`<text x="${x0}" y="212">${escapeHtml(dayLabel)}</text>`);
    }
  }
  xLabels.push(`<text x="${xRight}" y="212">Today</text>`);

  const seriesEls: string[] = [];
  const pendingLabels: Array<{
    x: number;
    y: number;
    text: string;
    isPrimary: boolean;
  }> = [];

  for (const e of entriesChron) {
    const pts = ptsByVer.get(e.version_id) ?? [];
    if (pts.length === 0) continue;
    const coords = pts.length === 1
      ? [
        {x: xLeft, y: mapY(pts[0].elo), pt: pts[0]},
        {x: xRight, y: mapY(pts[0].elo), pt: pts[0]},
      ]
      : pts.map(pt => ({x: mapX(pt.day), y: mapY(pt.elo), pt}));

    const isPrimary = e.version_id === primaryVerId;
    const ci = e.is_anchor === 1 ? 0 : Math.round(1.96 * e.rating_se);
    const upper = coords.map(c => `${c.x},${mapY(c.pt.elo + (e.is_anchor ? 0 : 1.96 * c.pt.se))}`);
    const lower = [...coords]
      .reverse()
      .map(c => `${c.x},${mapY(c.pt.elo - (e.is_anchor ? 0 : 1.96 * c.pt.se))}`);
    const polyPts = [...upper, ...lower].join(' ');
    const linePts = coords.map(c => `${c.x},${c.y}`).join(' ');
    const last = coords[coords.length - 1];
    const labelText = `${e.version_str} (${Math.round(e.rating_elo)} ±${ci})`;
    const labelX = Math.min(xRight - 115, Math.max(xLeft + 10, last.x - 110));
    const labelY = Math.max(22, last.y - 10);

    if (isPrimary) {
      const lcbPts = coords
        .map(c => `${c.x},${mapY(c.pt.elo - (e.is_anchor ? 0 : 1.96 * c.pt.se))}`)
        .join(' ');
      seriesEls.push(
        `<polygon points="${polyPts}" fill="var(--hl-symbol)" fill-opacity="0.1" />`,
        '<polyline fill="none" stroke="var(--hl-symbol)" stroke-opacity="0.75" ' +
          `stroke-width="1.25" stroke-dasharray="3,2" points="${lcbPts}" />`,
        '<polyline fill="none" stroke="var(--hl-symbol)" stroke-width="2.25" ' +
          `points="${linePts}" />`,
        `<circle cx="${last.x}" cy="${last.y}" r="3" fill="var(--hl-symbol)" />`
      );
    } else {
      const op = e.role === 'retired' ? '0.45' : '0.65';
      seriesEls.push(
        `<polygon points="${polyPts}" fill="currentColor" fill-opacity="0.06" />`,
        `<polyline fill="none" stroke="currentColor" stroke-opacity="${op}" ` +
          `stroke-width="1.6" points="${linePts}" />`,
        `<circle cx="${last.x}" cy="${last.y}" r="2.5" fill="currentColor" ` +
          `fill-opacity="${op}" />`
      );
    }
    pendingLabels.push({x: labelX, y: labelY, text: labelText, isPrimary});
  }

  pendingLabels.sort((a, b) => a.y - b.y || Number(b.isPrimary) - Number(a.isPrimary));
  for (let i = 1; i < pendingLabels.length; i++) {
    const cur = pendingLabels[i];
    for (let j = 0; j < i; j++) {
      const prev = pendingLabels[j];
      if (Math.abs(cur.x - prev.x) < 115 && cur.y - prev.y < 14) {
        cur.y = Math.min(yBottom + 4, prev.y + 14);
      }
    }
  }
  for (const lbl of pendingLabels) {
    if (lbl.isPrimary) {
      seriesEls.push(
        `<text x="${lbl.x}" y="${lbl.y}" fill="var(--hl-symbol)" font-size="11" ` +
          `font-weight="bold">${escapeHtml(lbl.text)}</text>`
      );
    } else {
      seriesEls.push(
        `<text x="${lbl.x}" y="${lbl.y}" fill="currentColor" fill-opacity="0.6" ` +
          `font-size="11">${escapeHtml(lbl.text)}</text>`
      );
    }
  }

  const aria = `${escapeHtml(botName)} Version Lineage and Rating Convergence`;
  const dividersGroup = releaseDividers.length > 0
    ? `<g stroke="currentColor" stroke-opacity="0.2" stroke-width="1" stroke-dasharray="2,3">
        ${releaseDividers.join('\n        ')}
      </g>`
    : '';

  return `<figure class="chart">
    <svg viewBox="0 0 760 220" role="img" aria-label="${aria}">
      <g stroke="currentColor" stroke-opacity="0.12" stroke-width="1">
        ${gridLines.join('\n        ')}
      </g>
      ${dividersGroup}
      <g fill="currentColor" fill-opacity="0.5" font-size="11" text-anchor="end">
        ${yLabels.join('\n        ')}
      </g>
      <g fill="currentColor" fill-opacity="0.5" font-size="11" text-anchor="middle">
        ${xLabels.join('\n        ')}
      </g>
      ${seriesEls.join('\n      ')}
    </svg>
  </figure>`;
}

function renderVersionsPane(
  botName: string,
  ladderKey: string,
  isDefault: boolean,
  entriesDesc: BotLadderProfileEntry[],
  snapshots: LadderSnapshotHistoryRow[],
  nowSec: number
): string {
  const hideCls = isDefault ? '' : ' hide';
  const entriesChron = [...entriesDesc].reverse();
  const prevEloByVer = new Map<number, number>();
  for (let i = 1; i < entriesChron.length; i++) {
    prevEloByVer.set(entriesChron[i].version_id, entriesChron[i - 1].rating_elo);
  }

  const activePrimary = entriesDesc
    .filter(e => e.role === 'champion' || e.role === 'challenger')
    .sort((a, b) => b.rating_lcb - a.rating_lcb)[0];

  const rowsHtml = entriesDesc.map(e => {
    const isPrimary = activePrimary?.version_id === e.version_id;
    const isRetired = e.role === 'retired';
    const verInner = isPrimary
      ? `<code><strong>${escapeHtml(e.version_str)}</strong></code>`
      : `<code>${escapeHtml(e.version_str)}</code>`;
    const retLabel = isRetired ? ' <span class="muted">(retired)</span>' : '';

    const eloRounded = Math.round(e.rating_elo);
    const ci = e.is_anchor === 1 ? 0 : Math.round(1.96 * e.rating_se);
    const eloInner = isPrimary ? `<strong>${eloRounded}</strong>` : `${eloRounded}`;

    const prevElo = prevEloByVer.get(e.version_id);
    let deltaCell: string;
    if (prevElo === undefined) {
      deltaCell = '<td class="num muted">—</td>';
    } else {
      const diff = Math.round(e.rating_elo) - Math.round(prevElo);
      if (diff > 0) {
        deltaCell = `<td class="num"><span class="yes">+${diff}</span></td>`;
      } else if (diff < 0) {
        deltaCell = `<td class="num"><span class="no">${diff}</span></td>`;
      } else {
        deltaCell = '<td class="num muted">0</td>';
      }
    }

    const wins = e.ww + e.wt;
    const losses = e.ll + e.tl;
    const ties = e.split;
    const turnText = `${Math.round(e.avg_turn_ms)} ms`;
    const ramText = `${Math.round(e.peak_ram_mb).toLocaleString('en-US')} MiB`;
    const clsAttr = isRetired ? ' class="secondary"' : '';

    return `<tr${clsAttr} data-vrow="${escapeHtml(e.version_str)}">` +
      `<td>${verInner}${retLabel}</td>` +
      `<td class="num">${eloInner} <span class="muted">±${ci}</span></td>` +
      deltaCell +
      `<td class="num">${e.gxe.toFixed(1)}%</td>` +
      `<td class="num">${wins}–${losses}–${ties}</td>` +
      `<td class="num">${turnText}</td>` +
      `<td class="num">${ramText}</td>` +
      `<td class="num muted">${formatIsoDate(e.created_at)}</td>` +
      '</tr>';
  }).join('');

  const svgHtml = renderVersionsLineageSvg(botName, entriesDesc, snapshots, nowSec);
  return `<div class="profile-pane${hideCls}" data-ladder="${escapeHtml(ladderKey)}">
    ${svgHtml}
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Version</th>
            <th class="num">Elo</th>
            <th class="num" title="Elo improvement over previous version">&Delta; Elo</th>
            <th class="num">GXE</th>
            <th class="num">W–L–T</th>
            <th class="num">Turn</th>
            <th class="num">Peak RAM</th>
            <th class="num">Submitted</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  </div>`;
}

function renderHeadToHeadPane(opts: {
  botId: number;
  ladderKey: string;
  isDefault: boolean;
  botEntries: BotLadderProfileEntry[];
  allEntries: LeaderboardEntryView[];
  pairs: PairAggregateRow[];
  publicDir: string;
  projectMeta: ReadonlyMap<string, ProjectMeta>;
  profileSlugs: ReadonlySet<string>;
}): string {
  const {
    botId,
    ladderKey,
    isDefault,
    botEntries,
    allEntries,
    pairs,
    publicDir,
    projectMeta,
    profileSlugs,
  } = opts;
  const hideCls = isDefault ? '' : ' hide';

  const activeEntries = botEntries
    .filter(e => e.role === 'champion' || e.role === 'challenger')
    .sort((a, b) => b.rating_lcb - a.rating_lcb);
  const rep = activeEntries[0] ?? botEntries[0];
  if (!rep) {
    return `<div class="table-wrap profile-pane${hideCls}" ` +
      `data-ladder="${escapeHtml(ladderKey)}" data-empty="true">` +
      '<p class="empty-state muted">No head-to-head matches yet.</p></div>';
  }

  const pairMap = new Map<string, PairAggregateRow>();
  for (const p of pairs) {
    pairMap.set(`${p.v_low_id}:${p.v_high_id}`, p);
  }

  // Pick each opponent bot's primary active (or top) version that has played against `rep`
  const oppCandidates = allEntries.filter(e => e.bot_id !== botId);
  const seenOppBots = new Set<number>();
  const h2hRows: string[] = [];

  let fallbackSolve: {
    indexByVer: Map<number, number>;
    theta: Float64Array;
    covariance: Float64Array;
  } | null = null;
  const ensureSolve = () => {
    if (fallbackSolve) return fallbackSolve;
    const indexByVer = new Map<number, number>();
    let anchorIdx = -1;
    for (let i = 0; i < allEntries.length; i++) {
      indexByVer.set(allEntries[i].version_id, i);
      if (allEntries[i].is_anchor === 1 && anchorIdx === -1) anchorIdx = i;
    }
    const indexedPairs: PairMatchCounts[] = [];
    for (const p of pairs) {
      const iLow = indexByVer.get(p.v_low_id);
      const iHigh = indexByVer.get(p.v_high_id);
      if (iLow === undefined || iHigh === undefined) continue;
      indexedPairs.push({
        i: iLow,
        j: iHigh,
        ww: p.ww,
        wt: p.wt,
        split: p.split,
        tl: p.tl,
        ll: p.ll,
      });
    }
    const warm = new Float64Array(allEntries.map(e => (e.rating_elo - 1500) / ELO_SCALE));
    const res = computeDavidsonRatings(allEntries.length, indexedPairs, anchorIdx, 1500, warm);
    fallbackSolve = {indexByVer, theta: res.theta, covariance: res.covariance};
    return fallbackSolve;
  };

  for (const opp of oppCandidates) {
    if (seenOppBots.has(opp.bot_id)) continue;
    const lowId = Math.min(rep.version_id, opp.version_id);
    const highId = Math.max(rep.version_id, opp.version_id);
    const pair = pairMap.get(`${lowId}:${highId}`);
    if (!pair) continue;

    const isLow = rep.version_id === lowId;
    const wins = isLow ? pair.ww + pair.wt : pair.ll + pair.tl;
    const losses = isLow ? pair.ll + pair.tl : pair.ww + pair.wt;
    const ties = pair.split;
    const total = wins + losses + ties;
    if (total === 0) continue;

    seenOppBots.add(opp.bot_id);

    const oppHref = resolveBotHref(
      publicDir,
      projectMeta,
      opp.bot_slug,
      opp.bot_name,
      profileSlugs
    );
    const oppLink = formatBotLink(opp.bot_name, oppHref, true);
    const oppElo = Math.round(opp.rating_elo);
    const oppCi = opp.is_anchor === 1 ? 0 : Math.round(1.96 * opp.rating_se);

    const scorePct = ((wins + 0.5 * ties) / total) * 100;
    const deltaTheta = (rep.rating_elo - opp.rating_elo) / ELO_SCALE;
    const expPct = expectedMatchScore(deltaTheta) * 100;
    const resid = scorePct - expPct;
    const residSign = resid > 0 ? '+' : '';
    const residText = `${residSign}${resid.toFixed(1)}%`;
    let residHtml = residText;
    let residTip = '';
    if (resid >= 4.5) {
      residHtml = `<span class="yes">${residText}</span>`;
      residTip = ` title="Best Matchup (${residText} over Davidson expectation)"`;
    } else if (resid <= -4.5) {
      residHtml = `<span class="no">${residText}</span>`;
      residTip = ` title="Relative underperformance vs. expectation (${residText})"`;
    }

    const signedCur = isLow ? pair.cur_streak : -pair.cur_streak;
    const maxW = isLow ? pair.v_low_max_win_streak : pair.v_high_max_win_streak;
    const maxL = isLow ? pair.v_high_max_win_streak : pair.v_low_max_win_streak;
    let curStrHtml: string;
    if (signedCur >= 3) curStrHtml = `<span class="yes">W${signedCur}</span>`;
    else if (signedCur >= 1) curStrHtml = `W${signedCur}`;
    else if (signedCur <= -3) curStrHtml = `<span class="no">L${-signedCur}</span>`;
    else if (signedCur <= -1) curStrHtml = `L${-signedCur}`;
    else curStrHtml = 'T1';

    let losVal = pair.los_low !== null
      ? (isLow ? pair.los_low : 1 - pair.los_low)
      : null;
    if (losVal === null) {
      const s = ensureSolve();
      const idxUs = s.indexByVer.get(rep.version_id);
      const idxOpp = s.indexByVer.get(opp.version_id);
      if (idxUs !== undefined && idxOpp !== undefined) {
        losVal = computeLOS(s.theta, s.covariance, allEntries.length, idxUs, idxOpp);
      }
    }
    const losPct = losVal !== null ? losVal * 100 : 50;

    const wltTip = `${wins} W, ${ties} Split (WL/LW/TT), ${losses} L`;
    const scoreHtml = scorePct >= 50
      ? `<strong>${scorePct.toFixed(1)}%</strong>`
      : `${scorePct.toFixed(1)}%`;

    h2hRows.push(
      '<tr>' +
      `<td data-val="${escapeHtml(opp.bot_name)}">${oppLink} ` +
        `<code>${escapeHtml(opp.version_str)}</code></td>` +
      `<td class="num" data-val="${oppElo}">${oppElo} <span class="muted">±${oppCi}</span></td>` +
      `<td class="num" data-val="${wins}" title="${escapeHtml(wltTip)}">` +
        `${wins}–${losses}–${ties}</td>` +
      `<td class="num" data-val="${scorePct.toFixed(1)}">${scoreHtml}</td>` +
      `<td class="num muted" data-val="${expPct.toFixed(1)}">${expPct.toFixed(1)}%</td>` +
      `<td class="num" data-val="${resid.toFixed(1)}"${residTip}>${residHtml}</td>` +
      `<td class="center" data-val="${signedCur}">${curStrHtml} ` +
        `<span class="muted">(${maxW}W/${maxL}L)</span></td>` +
      `<td class="num" data-val="${losPct.toFixed(1)}">${losPct.toFixed(1)}%</td>` +
      '</tr>'
    );
  }

  if (h2hRows.length === 0) {
    return `<div class="table-wrap profile-pane${hideCls}" ` +
      `data-ladder="${escapeHtml(ladderKey)}" data-empty="true">` +
      '<p class="empty-state muted">No head-to-head matches yet.</p></div>';
  }

  const thWlt = 'Match Wins – Losses – Ties (underlying WW / Split / LL in tooltip)';
  const thExp = 'Expected score % under Generalized Davidson model E[S | delta]';
  const thDelta =
    'Davidson Matchup Residual (Actual Score % - Expected Score %): ' +
    'identifies stylistic Best Matchup (+) and Nemesis (-)';
  const thStr = 'Current streak (Longest Win / Loss streak vs. opponent)';
  const thLos = 'Pairwise Likelihood of Superiority';

  return `<div class="table-wrap profile-pane${hideCls}" data-ladder="${escapeHtml(ladderKey)}">
    <table class="h2h-table">
      <thead>
        <tr>
          <th class="sortable" data-col="0" data-type="str">Opponent</th>
          <th class="num sortable" data-col="1" data-type="num">Elo</th>
          <th class="num sortable" data-col="2" data-type="num" title="${thWlt}">W–L–T</th>
          <th class="num sortable" data-col="3" data-type="num">Score</th>
          <th class="num sortable" data-col="4" data-type="num" title="${thExp}">Expected</th>
          <th class="num sortable" data-col="5" data-type="num" title="${thDelta}">&Delta;</th>
          <th class="center sortable" data-col="6" data-type="num" title="${thStr}">Streak</th>
          <th class="num sortable" data-col="7" data-type="num" title="${thLos}">LOS</th>
        </tr>
      </thead>
      <tbody>${h2hRows.join('')}</tbody>
    </table>
  </div>`;
}

function invertCategory(cat: RecentMatchView['match_category']): string {
  const flip = (c: string) => (c === 'W' ? 'L' : c === 'L' ? 'W' : 'T');
  return `${flip(cat[0])}${flip(cat[1])}`;
}

function renderRecentMatchesPane(opts: {
  botSlug: string;
  botName: string;
  ladderKey: string;
  isDefault: boolean;
  matches: RecentMatchView[];
  renderedBattleIds: ReadonlySet<string>;
  publicDir: string;
  projectMeta: ReadonlyMap<string, ProjectMeta>;
  profileSlugs: ReadonlySet<string>;
  nowSec: number;
}): string {
  const {
    botSlug,
    botName,
    ladderKey,
    isDefault,
    matches,
    renderedBattleIds,
    publicDir,
    projectMeta,
    profileSlugs,
    nowSec,
  } = opts;
  const hideCls = isDefault ? '' : ' hide';

  const rowsHtml = matches.length === 0
    ? '<tr><td colspan="8" class="center muted">No completed matches yet.</td></tr>'
    : matches.map(m => {
      const weAreP1 = m.p1.slug === botSlug;
      const ourSide = weAreP1 ? m.p1 : m.p2;
      const oppSide = weAreP1 ? m.p2 : m.p1;
      const ternary = toTernaryMatchOutcome(m.match_category);
      const ourOutcome = weAreP1 ? ternary.v1 : ternary.v2;
      const ourCat = weAreP1 ? m.match_category : invertCategory(m.match_category);

      let resHtml: string;
      if (ourOutcome === 'W') {
        resHtml = `<span class="yes">W</span> <span class="muted">(${ourCat})</span>`;
      } else if (ourOutcome === 'L') {
        resHtml = `<span class="no">L</span> <span class="muted">(${ourCat})</span>`;
      } else {
        resHtml = `T <span class="muted">(${ourCat})</span>`;
      }

      const g1Bank = Math.round(weAreP1 ? m.v1_g1_bank_s : m.v2_g1_bank_s);
      const g2Bank = Math.round(weAreP1 ? m.v1_g2_bank_s : m.v2_g2_bank_s);
      const peakRam = Math.round(weAreP1 ? m.v1_peak_ram_mb : m.v2_peak_ram_mb);

      const oppHref = resolveBotHref(
        publicDir,
        projectMeta,
        oppSide.slug,
        oppSide.name,
        profileSlugs
      );
      const oppCell = `${formatBotLink(oppSide.name, oppHref, false)} ` +
        `<code>${escapeHtml(oppSide.version)}</code>`;

      const idEsc = escapeHtml(m.id);
      const battleHref = renderedBattleIds.has(m.id)
        ? `/arena/battles/#${idEsc}`
        : '/arena/battles/';
      const tsTitle = formatIsoDateTimeUtc(m.completed_at);
      const rel = formatRelativeTime(nowSec, m.completed_at);

      return `<tr data-ver="${escapeHtml(ourSide.version)}">` +
        `<td><a href="${battleHref}" class="subtle"><code>${idEsc}</code></a></td>` +
        `<td><code>${escapeHtml(ourSide.version)}</code></td>` +
        `<td>${oppCell}</td>` +
        `<td class="center">${resHtml}</td>` +
        `<td class="num">${m.g1_turns} / ${m.g2_turns}</td>` +
        `<td class="num">${g1Bank}s / ${g2Bank}s</td>` +
        `<td class="num">${peakRam.toLocaleString('en-US')}M</td>` +
        `<td class="num muted" title="${escapeHtml(tsTitle)}">${rel}</td>` +
        '</tr>';
    }).join('');

  const bankTitle = `Remaining ${botName} time bank in Game 1 / Game 2 (Showdown timer: 150s cap)`;
  return `<div class="table-wrap profile-pane${hideCls}" data-ladder="${escapeHtml(ladderKey)}">
    <table class="matches-table">
      <thead>
        <tr>
          <th>Match</th>
          <th>Ver.</th>
          <th>Opponent</th>
          <th class="center" title="Match Outcome (Game 1 / Game 2 outcomes)">Result</th>
          <th class="num" title="Turns in Game 1 / Game 2">Turns</th>
          <th class="num" title="${escapeHtml(bankTitle)}">Bank</th>
          <th class="num" title="Peak XNU phys_footprint RAM across the 2-game match">RAM</th>
          <th class="num">Completed</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  </div>`;
}

function buildProjectMetaRows(
  db: ArenaDB,
  bot: BotRow,
  meta: ProjectMeta | undefined,
  latestEntry: BotLadderProfileEntry | undefined
): string {
  const rows: string[] = [];
  const devs = db.getDevelopersForBot(bot.id);
  if (devs.length > 0) {
    const links = devs.map(d => (
      `<a href="https://github.com/${encodeURIComponent(d.github_login)}" ` +
      `class="subtle">${escapeHtml(d.github_login)}</a>`
    )).join(', ');
    rows.push(`<tr><td><strong>Author</strong></td><td>${links}</td></tr>`);
  }

  if (meta?.active !== undefined) {
    const activeHtml = Array.isArray(meta.active)
      ? (meta.active[0] === meta.active[1]
        ? `${meta.active[0]}`
        : `${meta.active[0]} – ${meta.active[1]}`)
      : `${meta.active} – <em>present</em>`;
    rows.push(`<tr><td><strong>Active</strong></td><td>${activeHtml}</td></tr>`);
  }

  if (meta?.license) {
    rows.push(
      `<tr><td><strong>License</strong></td><td><tt>${escapeHtml(meta.license)}</tt></td></tr>`
    );
  } else if (meta?.source) {
    rows.push('<tr><td><strong>License</strong></td><td>None</td></tr>');
  }

  if (meta?.source) {
    const identifier = /^https:\/\/git(hub|lab)\.com\//.test(meta.source)
      ? meta.source.slice(19)
      : meta.source;
    const srcHtml = `<a href="${escapeHtml(meta.source)}">${escapeHtml(identifier)}</a>`;
    rows.push(`<tr><td><strong>Source</strong></td><td>${srcHtml}</td></tr>`);
  }

  if (meta?.engine) {
    const engHtml = Array.isArray(meta.engine)
      ? meta.engine.map(e => (
        `<a href="${escapeHtml(e.url)}" class="subtle">${escapeHtml(e.name)}</a>`
      )).join(', ')
      : escapeHtml(meta.engine);
    rows.push(`<tr><td><strong>Engine</strong></td><td>${engHtml}</td></tr>`);
  }

  if (meta?.language) {
    const langText = Array.isArray(meta.language)
      ? meta.language.join(', ')
      : meta.language;
    rows.push(`<tr><td><strong>Language</strong></td><td>${escapeHtml(langText)}</td></tr>`);
  }

  if (latestEntry) {
    const pkgLabel = latestEntry.format_type === 'bundle'
      ? '<tt>darwin/arm64</tt> bundle'
      : '<tt>linux/arm64</tt> OCI';
    const sizeNote = latestEntry.unpacked_bytes !== null
      ? ` <span class="muted">(${Math.round(latestEntry.unpacked_bytes / (1024 * 1024))} MB)</span>`
      : '';
    rows.push(`<tr><td><strong>Artifact</strong></td><td>${pkgLabel}${sizeNote}</td></tr>`);
  }

  return rows.join('\n      ');
}

export function renderBotProfiles(opts: {
  db: ArenaDB;
  renderer: Renderer;
  publicDir: string;
  avatarsDir?: string;
  projectMeta: ReadonlyMap<string, ProjectMeta>;
  profileBots: BotRow[];
  profileSlugs: ReadonlySet<string>;
  renderedBattleIds: ReadonlySet<string>;
  nowSec: number;
}) {
  const {
    db,
    renderer,
    publicDir,
    projectMeta,
    profileBots,
    profileSlugs,
    renderedBattleIds,
    nowSec,
  } = opts;
  const avatarsDir = opts.avatarsDir ?? AVATARS_DIR;
  const projectsDir = path.join(publicDir, 'projects');
  fs.mkdirSync(projectsDir, {recursive: true});

  const expectedLogoFiles = new Set<string>();
  for (const bot of profileBots) {
    if (!bot.logo_file) continue;
    const srcLogo = path.join(avatarsDir, bot.logo_file);
    if (fs.existsSync(srcLogo)) {
      const ext = path.extname(bot.logo_file) || '.png';
      expectedLogoFiles.add(`${bot.slug}${ext}`);
    }
  }

  // Remove stale bot profile directories or logos when a project is disabled/removed
  for (const entry of fs.readdirSync(projectsDir, {withFileTypes: true})) {
    if (entry.isDirectory()) {
      if (!profileSlugs.has(entry.name)) {
        fs.rmSync(path.join(projectsDir, entry.name), {recursive: true, force: true});
      }
    } else if (
      entry.isFile() &&
      entry.name !== 'index.html' &&
      !entry.name.includes('.tmp.') &&
      !expectedLogoFiles.has(entry.name)
    ) {
      fs.rmSync(path.join(projectsDir, entry.name), {force: true});
    }
  }

  for (const bot of profileBots) {
    const ladders: LadderRow[] = db.getBotParticipatedLadders(bot.id);

    let logoHtml = '';
    if (bot.logo_file) {
      const srcLogo = path.join(avatarsDir, bot.logo_file);
      if (fs.existsSync(srcLogo)) {
        const ext = path.extname(bot.logo_file) || '.png';
        const destFile = `${bot.slug}${ext}`;
        copyFileAtomic(srcLogo, path.join(projectsDir, destFile));
        logoHtml = `<img class="bot-logo" src="/projects/${encodeURIComponent(destFile)}" ` +
          `alt="${escapeHtml(bot.name)}">`;
      }
    }

    const meta = projectMeta.get(bot.name);
    const siteLink = meta?.site
      ? `<a href="${escapeHtml(meta.site)}" class="subtle" title="Project Homepage">${EXT_ICON}</a>`
      : '';
    const profileHeader = header(`${escapeHtml(bot.name)}${siteLink}`);

    if (ladders.length === 0) {
      const statusNote = bot.status === 'pending' ? 'Pending qualification' : 'No active entries';
      const emptyReign = buildReignRowsHtml(
        {
          top1EnteredAt: null,
          top1MaxStreakS: 0,
          top1TotalS: 0,
          top10EnteredAt: null,
          top10MaxStreakS: 0,
          top10TotalS: 0,
          top100EnteredAt: null,
          top100MaxStreakS: 0,
          top100TotalS: 0,
        },
        nowSec
      );
      const content = renderTemplate(PROFILE_TEMPLATE, {
        logoHtml,
        controlsInitialClass: ' hide',
        formatNavItems: '<li><span class="muted">—</span></li>',
        initialVerOptions: '<option value="all">All (0)</option>',
        projectMetaRows: buildProjectMetaRows(db, bot, meta, undefined),
        initialStatRank: `<span class="muted">— (${statusNote})</span>`,
        initialStatElo: '<span class="muted">—</span>',
        initialStatGxe: '<span class="muted">—</span>',
        initialStatPeak: '<span class="muted">—</span>',
        initialStatRecord: '<span class="muted">0–0–0</span>',
        initialStatStreak: '<span class="muted">—</span>',
        initialStatTelemetry: '<span class="muted">—</span>',
        reignInitialClass: ' hide',
        initialReignRows: emptyReign,
        emptyProfileNotice: '<p class="empty-state muted">No Arena ladder entries yet.</p>',
        versionsInitialClass: ' class="hide"',
        versionsPanes: '<p class="empty-state muted">No versions yet.</p>',
        matchupsInitialClass: ' class="hide"',
        matchupsPanes: '<p class="empty-state muted">No head-to-head matches yet.</p>',
        matchesInitialClass: ' class="hide"',
        matchesPanes: '<p class="empty-state muted">No completed matches yet.</p>',
        profileDataJson: '{}',
        defaultLadderKeyJson: '""',
      });
      const html = renderer.render({
        id: 'bot-profile',
        title: `${bot.name} | pkmn.ai`,
        header: profileHeader,
        path: `/projects/${bot.slug}/`,
        style: `${ARENA_STYLE}\n${PROFILE_STYLE}`,
        content,
      });
      writeFileAtomic(path.join(projectsDir, bot.slug, 'index.html'), html);
      continue;
    }

    const profileDataMap: Record<string, LadderProfileClientData> = {};
    const formatNavParts: string[] = [];
    const versionsPanes: string[] = [];
    const matchupsPanes: string[] = [];
    const matchesPanes: string[] = [];

    const usedKeys = new Set<string>();
    const ladderKeys = ladders.map(l => {
      const base = l.status !== 'archived' ? l.slot : l.id.toLowerCase();
      const key = usedKeys.has(base) ? l.id.toLowerCase() : base;
      usedKeys.add(key);
      return key;
    });

    const defaultLadderKey = ladderKeys[0];
    let latestOverallEntry: BotLadderProfileEntry | undefined;
    let defaultMatchupsEmpty = true;

    for (let i = 0; i < ladders.length; i++) {
      const l = ladders[i];
      const lKey = ladderKeys[i];
      const isDefault = i === 0;

      const botEntries = db.getBotLadderProfileEntries(bot.id, l.id);
      if (!latestOverallEntry || (
        botEntries[0] && botEntries[0].created_at > latestOverallEntry.created_at
      )) {
        latestOverallEntry = botEntries[0];
      }

      const allEntries = db.getLeaderboardEntries(l.id);
      const pairs = db.getPairAggregatesForLadder(l.id);
      const snapshots = db.getRatingSnapshotsForLadder(l.id);
      const familyStats = db.getBotLadderStats(l.id, bot.id);
      const recentMatches = db.getRecentMatchesForBotOnLadder(bot.id, l.id, 30);
      const adjacentLos = computeAdjacentLosMap(allEntries, pairs);

      const sep = i > 0 ? '\n      —\n      ' : '';
      const checked = isDefault ? ' checked' : '';
      formatNavParts.push(
        `${sep}<li id="${escapeHtml(lKey)}">` +
        `<input type="radio" name="ladder" id="lad-${escapeHtml(lKey)}" ` +
        `value="${escapeHtml(lKey)}"${checked}>` +
        `<label for="lad-${escapeHtml(lKey)}">${escapeHtml(l.display_name)}</label></li>`
      );

      const optList = [
        `<option value="all" selected>All (${botEntries.length})</option>`,
        ...botEntries.map(e => {
          const stateTag = e.role === 'retired' ? 'retired' : 'active';
          const vEsc = escapeHtml(e.version_str);
          return `<option value="${vEsc}">${vEsc} (${stateTag})</option>`;
        }),
      ];

      const vstats: Record<string, VersionDynamicStats> = {
        all: buildAllVersionsDynamicStats(botEntries, familyStats, adjacentLos),
      };
      const reign: Record<string, string> = {
        all: buildReignRowsHtml(
          familyStats ?? {
            top1EnteredAt: null,
            top1MaxStreakS: 0,
            top1TotalS: 0,
            top10EnteredAt: null,
            top10MaxStreakS: 0,
            top10TotalS: 0,
            top100EnteredAt: null,
            top100MaxStreakS: 0,
            top100TotalS: 0,
          },
          nowSec
        ),
      };

      for (const e of botEntries) {
        vstats[e.version_str] = buildVersionDynamicStats(e, adjacentLos);
        reign[e.version_str] = buildReignRowsHtml(
          {
            top1EnteredAt: e.top1_entered_at,
            top1MaxStreakS: e.top1_max_streak_s,
            top1TotalS: e.top1_total_s,
            top10EnteredAt: e.top10_entered_at,
            top10MaxStreakS: e.top10_max_streak_s,
            top10TotalS: e.top10_total_s,
            top100EnteredAt: e.top100_entered_at,
            top100MaxStreakS: e.top100_max_streak_s,
            top100TotalS: e.top100_total_s,
          },
          nowSec
        );
      }

      profileDataMap[lKey] = {
        optionsHtml: optList.join(''),
        vstats,
        reign,
      };

      versionsPanes.push(
        renderVersionsPane(bot.name, lKey, isDefault, botEntries, snapshots, nowSec)
      );
      const h2hPane = renderHeadToHeadPane({
        botId: bot.id,
        ladderKey: lKey,
        isDefault,
        botEntries,
        allEntries,
        pairs,
        publicDir,
        projectMeta,
        profileSlugs,
      });
      matchupsPanes.push(h2hPane);
      if (isDefault) {
        defaultMatchupsEmpty = h2hPane.includes('data-empty="true"');
      }

      matchesPanes.push(
        renderRecentMatchesPane({
          botSlug: bot.slug,
          botName: bot.name,
          ladderKey: lKey,
          isDefault,
          matches: recentMatches,
          renderedBattleIds,
          publicDir,
          projectMeta,
          profileSlugs,
          nowSec,
        })
      );
    }

    const initialData = profileDataMap[defaultLadderKey];
    const initStats = initialData.vstats.all;
    const content = renderTemplate(PROFILE_TEMPLATE, {
      logoHtml,
      controlsInitialClass: '',
      formatNavItems: formatNavParts.join(''),
      initialVerOptions: initialData.optionsHtml,
      projectMetaRows: buildProjectMetaRows(db, bot, meta, latestOverallEntry),
      initialStatRank: initStats.rank,
      initialStatElo: initStats.elo,
      initialStatGxe: initStats.gxe,
      initialStatPeak: initStats.peak,
      initialStatRecord: initStats.record,
      initialStatStreak: initStats.streak,
      initialStatTelemetry: initStats.telemetry,
      reignInitialClass: '',
      initialReignRows: initialData.reign.all,
      emptyProfileNotice: '',
      versionsInitialClass: '',
      versionsPanes: versionsPanes.join('\n  '),
      matchupsInitialClass: defaultMatchupsEmpty ? ' class="hide"' : '',
      matchupsPanes: matchupsPanes.join('\n  '),
      matchesInitialClass: '',
      matchesPanes: matchesPanes.join('\n  '),
      profileDataJson: safeInlineJson(profileDataMap),
      defaultLadderKeyJson: safeInlineJson(defaultLadderKey),
    });

    const html = renderer.render({
      id: 'bot-profile',
      title: `${bot.name} | pkmn.ai`,
      header: profileHeader,
      path: `/projects/${bot.slug}/`,
      style: `${ARENA_STYLE}\n${PROFILE_STYLE}`,
      content,
    });

    writeFileAtomic(path.join(projectsDir, bot.slug, 'index.html'), html);
  }
}
