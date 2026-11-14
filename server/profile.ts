import * as fs from 'fs';
import * as path from 'path';

import {AVATARS_DIR} from '../db';
import type * as db from '../db';
import {Renderer, header, injectLiveBanner} from '../static/build';
import {
  EXT_ICON,
  escapeHtml,
  formatUtcDate,
  parseUtcDayMillis,
  renderTemplate,
  root,
} from '../static/util';

import * as arena from './arena';
import * as ratings from './ratings';
import * as render from './render';

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
  oppOptionsHtml: string;
  vstats: Record<string, VersionDynamicStats>;
  reign: Record<string, string>;
}

function formatIsoDateTimeUtc(sec: number): string {
  return `${new Date(sec * 1000).toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

function formatDurationCell(seconds: number, boldDays = false): string {
  if (seconds <= 0) {
    return '<span class="muted">—</span>';
  }
  const days = `${(seconds / 86400).toFixed(1)}d`;
  const hours = `${Math.round(seconds / 3600).toLocaleString('en-US')}h`;
  const dayHtml = boldDays ? `<strong>${days}</strong>` : days;
  return `${dayHtml} <span class="muted">(${hours})</span>`;
}

// Computes live, longest, and cumulative Top 1 / Top 10 / Top 100 reign durations.
// If the entrant currently occupies a tier (`top*_entered_at` is set), the ongoing reign since the
// last match (`nowSec - enteredAt`) is compared against `maxStreakSeconds`; `totalSeconds` already
// accumulates elapsed intervals on every `recomputeLadderRatings` pass.
function buildReignRowsHtml(
  stats: {
    top1EnteredAt?: number;
    top1MaxStreakSeconds: number;
    top1TotalSeconds: number;
    top10EnteredAt?: number;
    top10MaxStreakSeconds: number;
    top10TotalSeconds: number;
    top100EnteredAt?: number;
    top100MaxStreakSeconds: number;
    top100TotalSeconds: number;
  },
  nowSec: number
): string {
  const cur1 = stats.top1EnteredAt !== undefined
    ? Math.max(0, nowSec - stats.top1EnteredAt)
    : 0;
  const max1 = Math.max(stats.top1MaxStreakSeconds, cur1);
  const tot1 = stats.top1TotalSeconds;

  const cur10 = stats.top10EnteredAt !== undefined
    ? Math.max(0, nowSec - stats.top10EnteredAt)
    : 0;
  const max10 = Math.max(stats.top10MaxStreakSeconds, cur10);
  const tot10 = stats.top10TotalSeconds;

  const cur100 = stats.top100EnteredAt !== undefined
    ? Math.max(0, nowSec - stats.top100EnteredAt)
    : 0;
  const max100 = Math.max(stats.top100MaxStreakSeconds, cur100);
  const tot100 = stats.top100TotalSeconds;

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
  entry: db.AgentLadderProfileEntry,
  adjacentLos: ReadonlyMap<number, number>
): VersionDynamicStats {
  const isProvisional =
    entry.role !== 'retired' && (entry.matches < 10 || entry.se > 60);
  let rank: string;
  if (entry.role === 'retired') {
    const retDate = entry.retiredAt ? ` ${formatUtcDate(entry.retiredAt)}` : '';
    rank = `<span class="muted">— (retired${retDate})</span>`;
  } else if (entry.rankCurrent !== undefined && !isProvisional) {
    const nextRank = entry.rankCurrent + 1;
    const los = adjacentLos.get(entry.versionId);
    const rangeNote = (
      entry.rankMin !== undefined &&
      entry.rankMax !== undefined &&
      entry.rankMin < entry.rankMax
    )
      ? ` [${entry.rankMin}–${entry.rankMax}]`
      : '';
    const losNote = los !== undefined
      ? ` · LOS ${(los * 100).toFixed(1)}% vs. #${nextRank}`
      : '';
    const suffix = rangeNote || losNote
      ? ` <span class="muted">${rangeNote}${losNote}</span>`
      : '';
    rank = `<strong>#${entry.rankCurrent}</strong>${suffix}`;
  } else if (isProvisional) {
    rank = '<span class="muted">Provisional</span>';
  } else {
    rank = '<span class="muted">— (active)</span>';
  }

  const eloRounded = Math.round(entry.elo);
  const ci = entry.isAnchor ? 0 : Math.round(1.96 * entry.se);
  const elo = `<strong>${eloRounded}</strong> <span class="muted">±${ci}</span>`;
  const gxe = `${entry.gxe.toFixed(1)}%`;

  let peak: string;
  if (entry.settledAt !== undefined && entry.maxElo !== undefined) {
    const pRank = entry.bestRank !== undefined ? `<strong>#${entry.bestRank}</strong> · ` : '';
    const pCi = entry.isAnchor
      ? 0
      : Math.round(1.96 * (entry.maxEloSe ?? entry.se));
    const pGxe = (entry.maxGxe ?? entry.gxe).toFixed(1);
    peak = `${pRank}${Math.round(entry.maxElo)} ` +
      `<span class="muted">±${pCi} (${pGxe}% GXE)</span>`;
  } else {
    peak = '<span class="muted">Unsettled</span>';
  }

  const wins = entry.ww + entry.wt;
  const losses = entry.ll + entry.tl;
  const ties = entry.split;
  const record = `${wins}–${losses}–${ties}`;

  const curHtml = formatCurStreakHtml(
    entry.currentWinStreak,
    entry.currentLossStreak,
    entry.matches
  );
  const streak =
    `${curHtml} <span class="muted">(max ${entry.maxWinStreak}W / ` +
    `${entry.maxLossStreak}L)</span>`;

  const turnMillis = Math.round(entry.meanTurnMillis);
  const ramText = Math.round(entry.peakRam).toLocaleString('en-US');
  const telemetry = `${turnMillis} ms/turn <span class="muted">· ${ramText} MiB peak</span>`;

  return {rank, elo, gxe, peak, record, streak, telemetry};
}

function buildAllVersionsDynamicStats(
  entries: db.AgentLadderProfileEntry[],
  familyStats: db.AgentLadderStatsRow | undefined,
  adjacentLos: ReadonlyMap<number, number>
): VersionDynamicStats {
  const activeEntries = entries
    .filter(e => e.role === 'champion' || e.role === 'challenger')
    .sort((a, b) => b.lcb - a.lcb || b.elo - a.elo);
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
    totalPlayed += e.matches;
  }

  let peak = base.peak;
  if (familyStats?.maxElo !== undefined) {
    const pRank = familyStats.bestRank !== undefined
      ? `<strong>#${familyStats.bestRank}</strong> · `
      : '';
    const pCi = Math.round(1.96 * (familyStats.maxEloSe ?? rep.se));
    const pGxe = (familyStats.maxGxe ?? rep.gxe).toFixed(1);
    peak = `${pRank}${Math.round(familyStats.maxElo)} ` +
      `<span class="muted">±${pCi} (${pGxe}% GXE)</span>`;
  }

  let streak = base.streak;
  if (familyStats) {
    const curHtml = formatCurStreakHtml(
      familyStats.currentWinStreak,
      familyStats.currentLossStreak,
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
  agentName: string,
  entriesDesc: db.AgentLadderProfileEntry[],
  snapshots: db.LadderSnapshotHistoryRow[],
  nowSec: number
): string {
  const entriesChron = [...entriesDesc].reverse();
  const todayUtc = formatUtcDate(nowSec);
  const snapsByVer = new Map<number, db.LadderSnapshotHistoryRow[]>();
  for (const s of snapshots) {
    const list = snapsByVer.get(s.versionId) ?? [];
    list.push(s);
    snapsByVer.set(s.versionId, list);
  }

  const allDaysSet = new Set<string>();
  const ptsByVer = new Map<number, Array<{day: string; elo: number; se: number}>>();

  for (const e of entriesChron) {
    const raw = (snapsByVer.get(e.versionId) ?? []).filter(r => r.matches > 0);
    const pts = raw.map(r => ({day: r.dayUtc, elo: r.elo, se: r.se}));
    const startDay = formatUtcDate(e.submittedAt);
    if (pts.length === 0) {
      pts.push({day: startDay, elo: e.elo, se: e.se});
      if (e.role !== 'retired' && todayUtc > startDay) {
        pts.push({day: todayUtc, elo: e.elo, se: e.se});
      }
    } else if (e.role !== 'retired' && pts[pts.length - 1].day < todayUtc) {
      pts.push({day: todayUtc, elo: e.elo, se: e.se});
    }
    for (const pt of pts) allDaysSet.add(pt.day);
    ptsByVer.set(e.versionId, pts);
  }

  const allDays = [...allDaysSet].sort((a, b) => a.localeCompare(b));
  const minDayMillis = allDays.length > 0 ? parseUtcDayMillis(allDays[0]) : 0;
  const maxDayMillis = allDays.length > 0 ? parseUtcDayMillis(allDays[allDays.length - 1]) : 0;

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

  // Map YYYY-MM-DD dates proportionally by UTC timestamp rather than array index so irregular
  // release cadence (e.g. rapid patch followed by weeks of steady play) is true to calendar time.
  const mapX = (day: string): number => {
    if (maxDayMillis <= minDayMillis) return xRight;
    const frac = (parseUtcDayMillis(day) - minDayMillis) / (maxDayMillis - minDayMillis);
    return Math.round((xLeft + frac * (xRight - xLeft)) * 10) / 10;
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
    .sort((a, b) => b.lcb - a.lcb);
  const primaryVerId = (activeEntries[0] ?? entriesChron[entriesChron.length - 1])?.versionId;

  const releaseDividers: string[] = [];
  const xLabels: string[] = [];
  const seenLabelX = new Set<number>();

  for (let i = 0; i < entriesChron.length; i++) {
    const e = entriesChron[i];
    const pts = ptsByVer.get(e.versionId) ?? [];
    if (pts.length === 0) continue;
    const x0 = pts.length === 1 && entriesChron.length === 1 ? xLeft : mapX(pts[0].day);
    if (i > 0 && x0 > xLeft + 25 && x0 < xRight - 25) {
      releaseDividers.push(`<line x1="${x0}" y1="18" x2="${x0}" y2="195" />`);
    }
    const nearExisting = [...seenLabelX].some(prevX => Math.abs(prevX - x0) < 75);
    if (!nearExisting && x0 < xRight - 55) {
      seenLabelX.add(x0);
      const dayLabel = `${render.formatShortDay(pts[0].day)} (${e.version})`;
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
    const pts = ptsByVer.get(e.versionId) ?? [];
    if (pts.length === 0) continue;
    const coords = pts.length === 1
      ? [
        {x: xLeft, y: mapY(pts[0].elo), pt: pts[0]},
        {x: xRight, y: mapY(pts[0].elo), pt: pts[0]},
      ]
      : pts.map(pt => ({x: mapX(pt.day), y: mapY(pt.elo), pt}));

    const isPrimary = e.versionId === primaryVerId;
    const ci = e.isAnchor ? 0 : Math.round(1.96 * e.se);
    const upper = coords.map(c => `${c.x},${mapY(c.pt.elo + (e.isAnchor ? 0 : 1.96 * c.pt.se))}`);
    const lower = [...coords]
      .reverse()
      .map(c => `${c.x},${mapY(c.pt.elo - (e.isAnchor ? 0 : 1.96 * c.pt.se))}`);
    const polyPts = [...upper, ...lower].join(' ');
    const linePts = coords.map(c => `${c.x},${c.y}`).join(' ');
    const last = coords[coords.length - 1];
    const labelText = `${e.version} (${Math.round(e.elo)} ±${ci})`;
    const labelX = Math.min(xRight - 115, Math.max(xLeft + 10, last.x - 110));
    const labelY = Math.max(22, last.y - 10);

    if (isPrimary) {
      const lcbPts = coords
        .map(c => `${c.x},${mapY(c.pt.elo - (e.isAnchor ? 0 : 1.96 * c.pt.se))}`)
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

  const aria = `${escapeHtml(agentName)} Version Lineage and Rating Convergence`;
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
  agentName: string,
  ladderKey: string,
  isDefault: boolean,
  entriesDesc: db.AgentLadderProfileEntry[],
  snapshots: db.LadderSnapshotHistoryRow[],
  nowSec: number
): string {
  const hideCls = isDefault ? '' : ' hide';
  const entriesChron = [...entriesDesc].reverse();
  const prevEloByVer = new Map<number, number>();
  for (let i = 1; i < entriesChron.length; i++) {
    prevEloByVer.set(entriesChron[i].versionId, entriesChron[i - 1].elo);
  }

  const activePrimary = entriesDesc
    .filter(e => e.role === 'champion' || e.role === 'challenger')
    .sort((a, b) => b.lcb - a.lcb)[0];

  const rowsHtml = entriesDesc.map(e => {
    const isPrimary = activePrimary?.versionId === e.versionId;
    const isRetired = e.role === 'retired';
    const verInner = isPrimary
      ? `<code><strong>${escapeHtml(e.version)}</strong></code>`
      : `<code>${escapeHtml(e.version)}</code>`;
    const retLabel = isRetired ? ' <span class="muted">(retired)</span>' : '';

    const eloRounded = Math.round(e.elo);
    const ci = e.isAnchor ? 0 : Math.round(1.96 * e.se);
    const eloInner = isPrimary ? `<strong>${eloRounded}</strong>` : `${eloRounded}`;

    const prevElo = prevEloByVer.get(e.versionId);
    let deltaCell: string;
    if (prevElo === undefined) {
      deltaCell = '<td class="num muted">—</td>';
    } else {
      const diff = Math.round(e.elo) - Math.round(prevElo);
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
    const turnText = `${Math.round(e.meanTurnMillis)} ms`;
    const ramText = `${Math.round(e.peakRam).toLocaleString('en-US')} MiB`;
    const clsAttr = isRetired ? ' class="secondary"' : '';

    return `<tr${clsAttr} data-vrow="${escapeHtml(e.version)}">` +
      `<td>${verInner}${retLabel}</td>` +
      `<td class="num">${eloInner} <span class="muted">±${ci}</span></td>` +
      deltaCell +
      `<td class="num">${e.gxe.toFixed(1)}%</td>` +
      `<td class="num">${wins}–${losses}–${ties}</td>` +
      `<td class="num">${turnText}</td>` +
      `<td class="num">${ramText}</td>` +
      `<td class="num muted">${formatUtcDate(e.submittedAt)}</td>` +
      '</tr>';
  }).join('');

  const svgHtml = renderVersionsLineageSvg(agentName, entriesDesc, snapshots, nowSec);
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
  agentId: number;
  ladderKey: string;
  isDefault: boolean;
  agentEntries: db.AgentLadderProfileEntry[];
  allEntries: db.LeaderboardEntryView[];
  pairs: db.PairAggregateRow[];
  publicDir: string;
  projectMeta: ReadonlyMap<string, render.ProjectMeta>;
  profileSlugs: ReadonlySet<string>;
}): string {
  const {
    agentId,
    ladderKey,
    isDefault,
    agentEntries,
    allEntries,
    pairs,
    publicDir,
    projectMeta,
    profileSlugs,
  } = opts;
  const hideCls = isDefault ? '' : ' hide';

  const activeEntries = agentEntries
    .filter(e => e.role === 'champion' || e.role === 'challenger')
    .sort((a, b) => b.lcb - a.lcb);
  const rep = activeEntries[0] ?? agentEntries[0];
  if (!rep) {
    return `<div class="table-wrap profile-pane${hideCls}" ` +
      `data-ladder="${escapeHtml(ladderKey)}" data-empty="true">` +
      '<p class="empty-state muted">No head-to-head matches yet.</p></div>';
  }

  const pairMap = new Map<string, db.PairAggregateRow>();
  for (const p of pairs) {
    pairMap.set(`${p.lowVersionId}:${p.highVersionId}`, p);
  }

  // Pick each opponent agent's primary active (or top) version that has played against `rep`.
  const oppCandidates = allEntries.filter(e => e.agentId !== agentId);
  const seenOppAgents = new Set<number>();
  const h2hRows: string[] = [];

  let fallbackSolve: ReturnType<typeof ratings.solveIndexedDavidson> | undefined;

  for (const opp of oppCandidates) {
    if (seenOppAgents.has(opp.agentId)) continue;
    const lowId = Math.min(rep.versionId, opp.versionId);
    const highId = Math.max(rep.versionId, opp.versionId);
    const pair = pairMap.get(`${lowId}:${highId}`);
    if (!pair) continue;

    const isLow = rep.versionId === lowId;
    const wins = isLow ? pair.ww + pair.wt : pair.ll + pair.tl;
    const losses = isLow ? pair.ll + pair.tl : pair.ww + pair.wt;
    const ties = pair.split;
    const total = wins + losses + ties;
    if (total === 0) continue;

    seenOppAgents.add(opp.agentId);

    const oppHref = render.resolveAgentHref(
      publicDir,
      projectMeta,
      opp.agentSlug,
      opp.agentName,
      profileSlugs
    );
    const oppLink = render.formatAgentLink(opp.agentName, oppHref, true);
    const oppElo = Math.round(opp.elo);
    const oppCi = opp.isAnchor ? 0 : Math.round(1.96 * opp.se);

    const scorePct = ((wins + 0.5 * ties) / total) * 100;
    const deltaTheta = (rep.elo - opp.elo) / ratings.ELO_SCALE;
    const expPct = ratings.expectedMatchScore(deltaTheta) * 100;
    const resid = scorePct - expPct;
    const residSign = resid > 0 ? '+' : '';
    const residText = `${residSign}${resid.toFixed(1)}%`;
    let residHtml = residText;
    let residTip = '';
    // Gate stylistic Best Matchup / Nemesis highlighting on >= 10 paired matches so tiny early
    // samples (e.g. 1-0 = +50% over expectation) don't masquerade as non-transitive counterpicks.
    if (total >= 10 && resid >= 4.5) {
      residHtml = `<span class="yes">${residText}</span>`;
      residTip = ` title="Best Matchup (${residText} over Davidson expectation)"`;
    } else if (total >= 10 && resid <= -4.5) {
      residHtml = `<span class="no">${residText}</span>`;
      residTip = ` title="Relative underperformance vs. expectation (${residText})"`;
    }

    const signedCur = isLow ? pair.currentStreak : -pair.currentStreak;
    const maxW = isLow ? pair.lowMaxWinStreak : pair.highMaxWinStreak;
    const maxL = isLow ? pair.highMaxWinStreak : pair.lowMaxWinStreak;
    let curStrHtml: string;
    if (signedCur >= 3) curStrHtml = `<span class="yes">W${signedCur}</span>`;
    else if (signedCur >= 1) curStrHtml = `W${signedCur}`;
    else if (signedCur <= -3) curStrHtml = `<span class="no">L${-signedCur}</span>`;
    else if (signedCur <= -1) curStrHtml = `L${-signedCur}`;
    else curStrHtml = 'T1';

    let losVal = pair.lowLos !== undefined
      ? (isLow ? pair.lowLos : 1 - pair.lowLos)
      : undefined;
    if (losVal === undefined) {
      fallbackSolve ??= ratings.solveIndexedDavidson(allEntries, pairs);
      const idxUs = fallbackSolve.indexByVer.get(rep.versionId);
      const idxOpp = fallbackSolve.indexByVer.get(opp.versionId);
      if (idxUs !== undefined && idxOpp !== undefined) {
        losVal = ratings.computeLOS(
          fallbackSolve.theta,
          fallbackSolve.covariance,
          allEntries.length,
          idxUs,
          idxOpp
        );
      }
    }
    const losPct = losVal !== undefined ? losVal * 100 : 50;

    const wltTip = `${wins} W, ${ties} Split (WL/LW/TT), ${losses} L`;
    const scoreHtml = scorePct >= 50
      ? `<strong>${scorePct.toFixed(1)}%</strong>`
      : `${scorePct.toFixed(1)}%`;

    h2hRows.push(
      `<tr class="opp-row" data-opp="${escapeHtml(opp.agentSlug)}" ` +
        `title="Click to filter Recent Matches vs. ${escapeHtml(opp.agentName)}">` +
      `<td data-val="${escapeHtml(opp.agentName)}">${oppLink} ` +
        `<code>${escapeHtml(opp.version)}</code></td>` +
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

function invertCategory(cat: db.RecentMatchView['category']): string {
  const flip = (c: string) => (c === 'W' ? 'L' : c === 'L' ? 'W' : 'T');
  return `${flip(cat[0])}${flip(cat[1])}`;
}

function renderRecentMatchesPane(opts: {
  agentSlug: string;
  agentName: string;
  ladderKey: string;
  isDefault: boolean;
  matches: db.RecentMatchView[];
  publicDir: string;
  projectMeta: ReadonlyMap<string, render.ProjectMeta>;
  profileSlugs: ReadonlySet<string>;
  nowSec: number;
}): string {
  const {
    agentSlug,
    agentName,
    ladderKey,
    isDefault,
    matches,
    publicDir,
    projectMeta,
    profileSlugs,
    nowSec,
  } = opts;
  const hideCls = isDefault ? '' : ' hide';

  const agentLinks: Record<string, string> = {};
  for (const m of matches) {
    for (const side of [m.p1, m.p2]) {
      if (!agentLinks[side.slug]) {
        const href = render.resolveAgentHref(
          publicDir,
          projectMeta,
          side.slug,
          side.name,
          profileSlugs
        );
        if (href) agentLinks[side.slug] = href;
      }
    }
  }

  const rowsHtml = matches.length === 0
    ? '<tr><td colspan="8" class="center muted">No completed matches yet.</td></tr>'
    : matches.map(m => {
      const weAreP1 = m.p1.slug === agentSlug;
      const ourSide = weAreP1 ? m.p1 : m.p2;
      const oppSide = weAreP1 ? m.p2 : m.p1;
      const ternary = ratings.toTernaryMatchOutcome(m.category);
      const ourOutcome = weAreP1 ? ternary.p1 : ternary.p2;
      const ourCat = weAreP1 ? m.category : invertCategory(m.category);

      let resHtml: string;
      if (ourOutcome === 'W') {
        resHtml = `<span class="yes">W</span> <span class="muted">(${ourCat})</span>`;
      } else if (ourOutcome === 'L') {
        resHtml = `<span class="no">L</span> <span class="muted">(${ourCat})</span>`;
      } else {
        resHtml = `T <span class="muted">(${ourCat})</span>`;
      }

      const g1Bank = Math.round(weAreP1 ? m.p1Game1BankSeconds : m.p2Game1BankSeconds);
      const g2Bank = Math.round(weAreP1 ? m.p1Game2BankSeconds : m.p2Game2BankSeconds);
      const peakRam = Math.round(weAreP1 ? m.p1PeakRam : m.p2PeakRam);

      const oppHref = agentLinks[oppSide.slug];
      const oppCell = `${render.formatAgentLink(oppSide.name, oppHref, false)} ` +
        `<code>${escapeHtml(oppSide.version)}</code>`;

      const idEsc = escapeHtml(m.id);
      const tsTitle = formatIsoDateTimeUtc(m.completedAt);
      const rel = render.formatRelativeTime(nowSec, m.completedAt);
      const detailHtml = render.renderBattleInlineDetailHtml(
        arena.enrichMatchView(publicDir, m),
        agentLinks
      );

      return `<tr class="battle-row" data-ver="${escapeHtml(ourSide.version)}" ` +
        `data-opp="${escapeHtml(oppSide.slug)}" tabindex="0" aria-expanded="false">` +
        '<td><span class="battle-toggle" aria-hidden="true">&#9656;</span>' +
          `<code>${idEsc}</code></td>` +
        `<td><code>${escapeHtml(ourSide.version)}</code></td>` +
        `<td>${oppCell}</td>` +
        `<td class="center">${resHtml}</td>` +
        `<td class="num">${m.game1Turns} / ${m.game2Turns}</td>` +
        `<td class="num">${g1Bank}s / ${g2Bank}s</td>` +
        `<td class="num">${peakRam.toLocaleString('en-US')}M</td>` +
        `<td class="num muted" title="${escapeHtml(tsTitle)}">${rel}</td>` +
        '</tr>' +
        `<tr class="battle-detail-row hide" data-detail-for="${idEsc}">` +
        `<td colspan="8">${detailHtml}</td>` +
        '</tr>';
    }).join('');

  const filterEmptyRow = matches.length > 0
    ? '<tr class="empty-filter-row hide">' +
      '<td colspan="8" class="center muted">No matching battles in recent history.</td></tr>'
    : '';
  const bankTitle =
    `Remaining ${agentName} time bank in Game 1 / Game 2 (Showdown timer: 150s cap)`;
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
      <tbody>${rowsHtml}${filterEmptyRow}</tbody>
    </table>
  </div>`;
}

function buildProjectMetaRows(
  db: db.Database,
  agent: db.AgentRow,
  meta: render.ProjectMeta | undefined,
  latestEntry: db.AgentLadderProfileEntry | undefined
): string {
  const rows: string[] = [];
  const devs = db.getDevelopersForAgent(agent.id);
  if (devs.length > 0) {
    const links = devs.map(d => (
      `<a href="https://github.com/${encodeURIComponent(d.githubLogin)}" ` +
      `class="subtle">${escapeHtml(d.githubLogin)}</a>`
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
    const pkgLabel = latestEntry.package === 'bundle'
      ? '<tt>darwin/arm64</tt> bundle'
      : '<tt>linux/arm64</tt> OCI';
    const sizeNote = latestEntry.unpackedBytes !== undefined
      ? ` <span class="muted">(${Math.round(latestEntry.unpackedBytes / (1024 * 1024))} MB)</span>`
      : '';
    rows.push(`<tr><td><strong>Artifact</strong></td><td>${pkgLabel}${sizeNote}</td></tr>`);
  }

  return rows.join('\n      ');
}

export interface AgentProfileDocument {
  slug: string;
  name: string;
  status: db.AgentRow['status'];
  logoHref?: string;
  owners: Array<{github: string; smogon?: string; smogonId?: number}>;
  metadata?: render.ProjectMeta;
  ladders: unknown[];
}

const LOGO_CONTENT_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export function resolveAgentLogo(
  agent: Pick<db.AgentRow, 'slug' | 'logo'>,
  avatarsDir = AVATARS_DIR
): {filePath: string; fileName: string; href: string; contentType: string} | undefined {
  if (!agent.logo) return undefined;
  const filePath = path.join(avatarsDir, agent.logo);
  if (!fs.existsSync(filePath)) return undefined;
  const ext = (path.extname(agent.logo) || '.png').toLowerCase();
  const fileName = `${agent.slug}${ext}`;
  return {
    filePath,
    fileName,
    href: `/projects/${encodeURIComponent(fileName)}`,
    contentType: LOGO_CONTENT_TYPES[ext] ?? 'application/octet-stream',
  };
}

export function renderAgentProfile(opts: {
  db: db.Database;
  renderer: Renderer;
  agent: db.AgentRow;
  publicDir: string;
  avatarsDir?: string;
  projectMeta: ReadonlyMap<string, render.ProjectMeta>;
  profileSlugs: ReadonlySet<string>;
  liveTournament?: {id: string; name: string};
  nowSec: number;
}): {html: string; json: AgentProfileDocument} {
  const {
    db,
    renderer,
    agent,
    publicDir,
    avatarsDir = AVATARS_DIR,
    projectMeta,
    profileSlugs,
    liveTournament,
    nowSec,
  } = opts;

  const ladders = db.getAgentParticipatedLadders(agent.id);
  const resolvedLogo = resolveAgentLogo(agent, avatarsDir);
  const logoHref = resolvedLogo?.href;
  const logoHtml = logoHref
    ? `<img class="project-logo" src="${logoHref}" alt="${escapeHtml(agent.name)}">`
    : '';

  const owners = db.getDevelopersForAgent(agent.id).map(d => ({
    github: d.githubLogin,
    smogon: d.smogonUsername,
    smogonId: d.smogonId,
  }));
  const meta = projectMeta.get(agent.name);
  const siteLink = meta?.site
    ? `<a href="${escapeHtml(meta.site)}" class="subtle" ` +
      `title="Project Homepage">${EXT_ICON}</a>`
    : '';
  const profileHeader = injectLiveBanner(
    header(`${escapeHtml(agent.name)}${siteLink}`),
    liveTournament ?? db.getRunningTournament()
  );

  if (ladders.length === 0) {
    const statusNote = agent.status === 'pending' ? 'Pending qualification' : 'No active entries';
    const emptyReign = buildReignRowsHtml(
      {
        top1MaxStreakSeconds: 0,
        top1TotalSeconds: 0,
        top10MaxStreakSeconds: 0,
        top10TotalSeconds: 0,
        top100MaxStreakSeconds: 0,
        top100TotalSeconds: 0,
      },
      nowSec
    );
    const content = renderTemplate(PROFILE_TEMPLATE, {
      logoHtml,
      controlsInitialClass: ' hide',
      formatNavItems: '<li><span class="muted">—</span></li>',
      initialVerOptions: '<option value="all">All (0)</option>',
      initialOppOptions: '<option value="all">All (0)</option>',
      projectMetaRows: buildProjectMetaRows(db, agent, meta, undefined),
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
      id: 'agent-profile',
      title: `${agent.name} | pkmn.ai`,
      header: profileHeader,
      path: `/projects/${agent.slug}/`,
      style: `${render.ARENA_STYLE}\n${PROFILE_STYLE}`,
      content,
    });
    return {
      html,
      json: {
        slug: agent.slug,
        name: agent.name,
        status: agent.status,
        logoHref,
        owners,
        metadata: meta,
        ladders: [],
      },
    };
  }

  const profileDataMap: Record<string, LadderProfileClientData> = {};
  const ladderJsonList: unknown[] = [];
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
  let latestOverallEntry: db.AgentLadderProfileEntry | undefined;
  let defaultMatchupsEmpty = true;

  for (let i = 0; i < ladders.length; i++) {
    const l = ladders[i];
    const lKey = ladderKeys[i];
    const isDefault = i === 0;

    const agentEntries = db.getAgentLadderProfileEntries(agent.id, l.id);
    if (!latestOverallEntry || (
      agentEntries[0] && agentEntries[0].submittedAt > latestOverallEntry.submittedAt
    )) {
      latestOverallEntry = agentEntries[0];
    }

    const allEntries = db.getLeaderboardEntries(l.id);
    const pairs = db.getPairAggregatesForLadder(l.id);
    const snapshots = db.getRatingSnapshotsForLadder(l.id, agent.id);
    const familyStats = db.getAgentLadderStats(l.id, agent.id);
    const recentMatches = db.getRecentMatchesForAgentOnLadder(agent.id, l.id, 30);
    const adjacentLos = render.computeAdjacentLosMap(allEntries, pairs, l.status);

    ladderJsonList.push({
      key: lKey,
      id: l.id,
      slot: l.slot,
      name: l.name,
      format: l.format,
      team: l.team,
      status: l.status,
      familyStats,
      versions: agentEntries.map(e => ({
        version: e.version,
        package: e.package,
        role: e.role,
        isAnchor: e.isAnchor,
        elo: Math.round(e.elo),
        se: Math.round(e.se * 10) / 10,
        lcb: Math.round(e.lcb),
        gxe: Math.round(e.gxe * 10) / 10,
        rankCurrent: e.rankCurrent,
        bestRank: e.bestRank,
        maxElo: e.maxElo !== undefined ? Math.round(e.maxElo) : undefined,
        matches: e.matches,
        wins: e.ww + e.wt,
        losses: e.ll + e.tl,
        ties: e.split,
        meanTurnMillis: Math.round(e.meanTurnMillis),
        peakRam: Math.round(e.peakRam),
        maxWinStreak: e.maxWinStreak,
        maxLossStreak: e.maxLossStreak,
        submittedAt: e.submittedAt,
        settledAt: e.settledAt,
        retiredAt: e.retiredAt,
      })),
      recentMatches,
    });

    const sep = i > 0 ? '\n      —\n      ' : '';
    const checked = isDefault ? ' checked' : '';
    formatNavParts.push(
      `${sep}<li id="${escapeHtml(lKey)}">` +
      `<input type="radio" name="ladder" id="lad-${escapeHtml(lKey)}" ` +
      `value="${escapeHtml(lKey)}"${checked}>` +
      `<label for="lad-${escapeHtml(lKey)}">${escapeHtml(l.name)}</label></li>`
    );

    const optList = [
      `<option value="all" selected>All (${agentEntries.length})</option>`,
      ...agentEntries.map(e => {
        const stateTag = e.role === 'retired' ? 'retired' : 'active';
        const vEsc = escapeHtml(e.version);
        return `<option value="${vEsc}">${vEsc} (${stateTag})</option>`;
      }),
    ];

    const oppMap = new Map<string, {slug: string; name: string; count: number}>();
    for (const m of recentMatches) {
      const opp = m.p1.slug === agent.slug ? m.p2 : m.p1;
      const cur = oppMap.get(opp.slug);
      if (cur) cur.count++;
      else oppMap.set(opp.slug, {slug: opp.slug, name: opp.name, count: 1});
    }
    for (const e of allEntries) {
      if (e.agentId === agent.id || oppMap.has(e.agentSlug)) continue;
      oppMap.set(e.agentSlug, {slug: e.agentSlug, name: e.agentName, count: 0});
    }
    const sortedOpps = [...oppMap.values()].sort(
      (a, b) => b.count - a.count || a.name.localeCompare(b.name)
    );
    const oppOptList = [
      `<option value="all" selected>All (${recentMatches.length})</option>`,
      ...sortedOpps.map(o => {
        const sEsc = escapeHtml(o.slug);
        const nEsc = escapeHtml(o.name);
        return `<option value="${sEsc}">${nEsc} (${o.count})</option>`;
      }),
    ];

    const vstats: Record<string, VersionDynamicStats> = {
      all: buildAllVersionsDynamicStats(agentEntries, familyStats, adjacentLos),
    };
    const reign: Record<string, string> = {
      all: buildReignRowsHtml(
        familyStats ?? {
          top1MaxStreakSeconds: 0,
          top1TotalSeconds: 0,
          top10MaxStreakSeconds: 0,
          top10TotalSeconds: 0,
          top100MaxStreakSeconds: 0,
          top100TotalSeconds: 0,
        },
        nowSec
      ),
    };

    for (const e of agentEntries) {
      vstats[e.version] = buildVersionDynamicStats(e, adjacentLos);
      reign[e.version] = buildReignRowsHtml(
        {
          top1EnteredAt: e.top1EnteredAt,
          top1MaxStreakSeconds: e.top1MaxStreakSeconds,
          top1TotalSeconds: e.top1TotalSeconds,
          top10EnteredAt: e.top10EnteredAt,
          top10MaxStreakSeconds: e.top10MaxStreakSeconds,
          top10TotalSeconds: e.top10TotalSeconds,
          top100EnteredAt: e.top100EnteredAt,
          top100MaxStreakSeconds: e.top100MaxStreakSeconds,
          top100TotalSeconds: e.top100TotalSeconds,
        },
        nowSec
      );
    }

    profileDataMap[lKey] = {
      optionsHtml: optList.join(''),
      oppOptionsHtml: oppOptList.join(''),
      vstats,
      reign,
    };

    versionsPanes.push(
      renderVersionsPane(agent.name, lKey, isDefault, agentEntries, snapshots, nowSec)
    );
    const h2hPane = renderHeadToHeadPane({
      agentId: agent.id,
      ladderKey: lKey,
      isDefault,
      agentEntries,
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
        agentSlug: agent.slug,
        agentName: agent.name,
        ladderKey: lKey,
        isDefault,
        matches: recentMatches,
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
    initialOppOptions: initialData.oppOptionsHtml,
    projectMetaRows: buildProjectMetaRows(db, agent, meta, latestOverallEntry),
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
    profileDataJson: render.safeInlineJson(profileDataMap),
    defaultLadderKeyJson: render.safeInlineJson(defaultLadderKey),
  });

  const html = renderer.render({
    id: 'agent-profile',
    title: `${agent.name} | pkmn.ai`,
    header: profileHeader,
    path: `/projects/${agent.slug}/`,
    style: `${render.ARENA_STYLE}\n${PROFILE_STYLE}`,
    content,
  });

  return {
    html,
    json: {
      slug: agent.slug,
      name: agent.name,
      status: agent.status,
      logoHref,
      owners,
      metadata: meta,
      ladders: ladderJsonList,
    },
  };
}
