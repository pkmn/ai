import * as fs from 'fs';
import * as path from 'path';

import * as site from 'site';
import type {Renderer} from 'site/build/page';
import * as yaml from 'yaml';

import type {
  ArenaDB,
  LadderRow,
  LadderSlot,
  LadderSnapshotHistoryRow,
  LeaderboardEntryView,
  PairAggregateRow,
  RecentMatchView,
} from '../db';
import {header, renderer as siteRenderer} from '../static/build';
import * as projects from '../static/projects';
import {escapeHtml, renderTemplate, root} from '../static/util';

import type {LiveJsonDocument, LiveMatchTelemetry, LiveSlotTelemetry} from './arena';
import {
  ELO_SCALE,
  type PairMatchCounts,
  computeDavidsonRatings,
  computeLOS,
} from './ratings';

export const PUBLIC_DIR = root('public');
export const STATIC_DIR = root('static');

const ARENA_STYLE = fs.readFileSync(root('static', 'arena.css'), 'utf8');
const LEADERBOARD_TEMPLATE = fs.readFileSync(root('static', 'leaderboard.html'), 'utf8');
const BATTLES_TEMPLATE = fs.readFileSync(root('static', 'battles.html'), 'utf8');

const EXT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3"/>' +
  '</svg>';

const SERIES_COLORS = [
  'var(--hl-symbol)',
  'var(--hl-string)',
  'var(--hl-name)',
  'var(--hl-keyword)',
  'var(--hl-number)',
  'var(--hl-literal)',
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const FORMAT_TITLES: Record<string, string> = {
  gen1ou: '[Gen 1] OU',
  gen3ou: '[Gen 3] OU',
  gen9ou: '[Gen 9] OU',
  gen9randombattle: '[Gen 9] Random Battle',
  gen9championsvgc2026regmc: '[Gen 9 Champions] VGC 2026 Reg M-C',
};

export interface StandingsJsonEntry {
  rank: number | null;
  rank_min: number | null;
  rank_max: number | null;
  bot_slug: string;
  bot_name: string;
  version: string;
  role: 'champion' | 'challenger' | 'retired';
  is_anchor: boolean;
  provisional: boolean;
  settled: boolean;
  elo: number;
  se: number;
  ci95: number;
  lcb: number;
  gxe: number;
  wins: number;
  losses: number;
  ties: number;
  matches: number;
  streak: string;
  los_next: number | null;
}

export interface StandingsJsonLadder {
  id: string;
  slot: LadderSlot;
  display_name: string;
  format_id: string;
  status: string;
  standings: StandingsJsonEntry[];
}

export interface StandingsJsonDocument {
  updated_at: number;
  ladders: Record<string, StandingsJsonLadder>;
}

export interface RenderArenaOptions {
  db: ArenaDB;
  renderer?: Renderer;
  publicDir?: string;
  staticDir?: string;
  liveDoc?: LiveJsonDocument | null;
  recentMatchesLimit?: number;
  now?: number;
}

interface ProjectMeta {
  id: string;
  source?: string;
}

function writeFileAtomic(filePath: string, contents: string) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, contents, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function safeInlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function loadProjectMetaMap(staticDir: string): Map<string, ProjectMeta> {
  const file = path.join(staticDir, 'projects.yml');
  const map = new Map<string, ProjectMeta>();
  if (!fs.existsSync(file)) return map;
  const parsed = yaml.parse(fs.readFileSync(file, 'utf8')) as projects.Project[] | null;
  if (!Array.isArray(parsed)) return map;
  for (const p of parsed) {
    if (!p.name) continue;
    const id = p.name.replaceAll(' ', '');
    map.set(p.name, {id, source: p.source});
  }
  return map;
}

function resolveBotHref(
  publicDir: string,
  projectMeta: ReadonlyMap<string, ProjectMeta>,
  slug: string,
  name: string
): string | undefined {
  if (fs.existsSync(path.join(publicDir, 'leaderboard', slug, 'index.html'))) {
    return `/leaderboard/${encodeURIComponent(slug)}/`;
  }
  const meta = projectMeta.get(name);
  if (meta) {
    return `/projects/#${meta.id}`;
  }
  return undefined;
}

function formatBotLink(
  name: string,
  href: string | undefined,
  bold: boolean
): string {
  const inner = bold ? `<strong>${escapeHtml(name)}</strong>` : escapeHtml(name);
  if (!href) return inner;
  return `<a href="${escapeHtml(href)}" class="subtle">${inner}</a>`;
}

function formatRelativeTime(nowSec: number, completedAt: number): string {
  const diff = Math.max(0, nowSec - completedAt);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function formatShortDay(dayUtc: string): string {
  const parts = dayUtc.split('-');
  if (parts.length !== 3) return dayUtc;
  const monthIdx = Number(parts[1]) - 1;
  const dayNum = Number(parts[2]);
  const m = MONTHS[monthIdx];
  if (!m || !Number.isFinite(dayNum)) return dayUtc;
  return `${m} ${dayNum}`;
}

function computeStreakLabel(entry: LeaderboardEntryView): {
  text: string;
  html: string;
} {
  if (entry.cur_win_streak >= 3) {
    const s = `W${entry.cur_win_streak}`;
    return {text: s, html: `<span class="yes">${s}</span>`};
  }
  if (entry.cur_win_streak >= 1) {
    const s = `W${entry.cur_win_streak}`;
    return {text: s, html: s};
  }
  if (entry.cur_loss_streak >= 3) {
    const s = `L${entry.cur_loss_streak}`;
    return {text: s, html: `<span class="no">${s}</span>`};
  }
  if (entry.cur_loss_streak >= 1) {
    const s = `L${entry.cur_loss_streak}`;
    return {text: s, html: s};
  }
  if (entry.matches_played > 0) {
    return {text: 'T1', html: 'T1'};
  }
  return {text: '—', html: '<span class="muted">—</span>'};
}

function computeAdjacentLosMap(
  entries: LeaderboardEntryView[],
  pairs: PairAggregateRow[]
): Map<number, number> {
  const ranked = entries
    .filter(e => (e.role === 'champion' || e.role === 'challenger') && e.rank_current !== null)
    .sort((a, b) => a.rank_current! - b.rank_current!);

  const result = new Map<number, number>();
  if (ranked.length < 2) return result;

  const pairMap = new Map<string, PairAggregateRow>();
  for (const p of pairs) {
    pairMap.set(`${p.v_low_id}:${p.v_high_id}`, p);
  }

  let fallbackSolve: {
    indexByVer: Map<number, number>;
    theta: Float64Array;
    covariance: Float64Array;
  } | null = null;

  const ensureFallbackSolve = () => {
    if (fallbackSolve) return fallbackSolve;
    const indexByVer = new Map<number, number>();
    let anchorIdx = -1;
    for (let i = 0; i < entries.length; i++) {
      indexByVer.set(entries[i].version_id, i);
      if (entries[i].is_anchor === 1 && anchorIdx === -1) anchorIdx = i;
    }
    const indexedPairs: PairMatchCounts[] = [];
    for (const p of pairs) {
      const idxLow = indexByVer.get(p.v_low_id);
      const idxHigh = indexByVer.get(p.v_high_id);
      if (idxLow === undefined || idxHigh === undefined) continue;
      indexedPairs.push({
        i: idxLow,
        j: idxHigh,
        ww: p.ww,
        wt: p.wt,
        split: p.split,
        tl: p.tl,
        ll: p.ll,
      });
    }
    const warm = new Float64Array(entries.map(e => (e.rating_elo - 1500) / ELO_SCALE));
    const solved = computeDavidsonRatings(entries.length, indexedPairs, anchorIdx, 1500, warm);
    fallbackSolve = {indexByVer, theta: solved.theta, covariance: solved.covariance};
    return fallbackSolve;
  };

  for (let r = 0; r < ranked.length - 1; r++) {
    const cur = ranked[r];
    const next = ranked[r + 1];
    const lowId = Math.min(cur.version_id, next.version_id);
    const highId = Math.max(cur.version_id, next.version_id);
    const pair = pairMap.get(`${lowId}:${highId}`);
    if (pair && pair.los_low !== null) {
      const los = cur.version_id === lowId ? pair.los_low : 1 - pair.los_low;
      result.set(cur.version_id, los);
    } else {
      const solved = ensureFallbackSolve();
      const idxCur = solved.indexByVer.get(cur.version_id);
      const idxNext = solved.indexByVer.get(next.version_id);
      if (idxCur !== undefined && idxNext !== undefined) {
        const los = computeLOS(
          solved.theta,
          solved.covariance,
          entries.length,
          idxCur,
          idxNext
        );
        result.set(cur.version_id, los);
      }
    }
  }

  return result;
}

function heatmapClass(scorePct: number): string {
  if (scorePct > 80) return 'hm-w4';
  if (scorePct > 70) return 'hm-w3';
  if (scorePct > 60) return 'hm-w2';
  if (scorePct > 50) return 'hm-w1';
  if (scorePct < 20) return 'hm-l4';
  if (scorePct < 30) return 'hm-l3';
  if (scorePct < 40) return 'hm-l2';
  if (scorePct < 50) return 'hm-l1';
  return '';
}

function renderHistoryPane(
  ladder: LadderRow,
  isDefault: boolean,
  entries: LeaderboardEntryView[],
  snapshots: LadderSnapshotHistoryRow[],
  nowSec: number
): string {
  const hideCls = isDefault ? '' : ' hide';
  const bestActiveByBot = new Map<number, LeaderboardEntryView>();
  for (const e of entries) {
    if (e.role !== 'champion' && e.role !== 'challenger') continue;
    if (e.matches_played <= 0) continue;
    if (!bestActiveByBot.has(e.bot_id)) {
      bestActiveByBot.set(e.bot_id, e);
    }
  }

  const topBots = [...bestActiveByBot.values()]
    .sort((a, b) => {
      if (a.rank_current !== null && b.rank_current !== null) {
        return a.rank_current - b.rank_current;
      }
      if (a.rank_current !== null) return -1;
      if (b.rank_current !== null) return 1;
      return b.rating_lcb - a.rating_lcb || b.rating_elo - a.rating_elo;
    })
    .slice(0, SERIES_COLORS.length);

  if (topBots.length === 0) {
    return `<div class="ladder-pane${hideCls}" data-ladder="${escapeHtml(ladder.slot)}" ` +
      'data-empty="true"><p class="empty-state muted">No rating history yet.</p></div>';
  }

  const todayUtc = new Date(nowSec * 1000).toISOString().slice(0, 10);
  const snapsByBot = new Map<number, LadderSnapshotHistoryRow[]>();
  for (const s of snapshots) {
    if (s.matches_played <= 0) continue;
    const list = snapsByBot.get(s.bot_id) ?? [];
    list.push(s);
    snapsByBot.set(s.bot_id, list);
  }

  interface PlottedPoint {
    day: string;
    versionId: number;
    versionStr: string;
    elo: number;
    se: number;
  }

  const seriesByBot = new Map<number, PlottedPoint[]>();
  const allDaysSet = new Set<string>();

  for (const bot of topBots) {
    const raw = snapsByBot.get(bot.bot_id) ?? [];
    const hasSettledDay = raw.some(r => r.matches_played >= 10 || r.rating_se <= 60);
    const filtered = hasSettledDay
      ? raw.filter(r => r.matches_played >= 10 || r.rating_se <= 60)
      : raw;

    const byDay = new Map<string, PlottedPoint>();
    for (const r of filtered) {
      const prev = byDay.get(r.day_utc);
      if (!prev || r.rating_elo > prev.elo) {
        byDay.set(r.day_utc, {
          day: r.day_utc,
          versionId: r.version_id,
          versionStr: r.version_str,
          elo: r.rating_elo,
          se: r.rating_se,
        });
      }
    }

    if (!byDay.has(todayUtc)) {
      byDay.set(todayUtc, {
        day: todayUtc,
        versionId: bot.version_id,
        versionStr: bot.version_str,
        elo: bot.rating_elo,
        se: bot.rating_se,
      });
    }

    const pts = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
    for (const pt of pts) allDaysSet.add(pt.day);
    seriesByBot.set(bot.bot_id, pts);
  }

  const allDays = [...allDaysSet].sort((a, b) => a.localeCompare(b));
  const dayIndex = new Map<string, number>();
  for (let i = 0; i < allDays.length; i++) dayIndex.set(allDays[i], i);

  let minElo = 1350;
  let maxElo = 1800;
  for (const pts of seriesByBot.values()) {
    for (const pt of pts) {
      if (pt.elo - 40 < minElo) minElo = pt.elo - 40;
      if (pt.elo + 40 > maxElo) maxElo = pt.elo + 40;
    }
  }
  const axisMin = Math.min(1350, Math.floor(minElo / 150) * 150);
  const axisMax = Math.max(1800, Math.ceil(maxElo / 150) * 150);
  const yTop = 25;
  const yBottom = 205;
  const xLeft = 45;
  const xRight = 625;

  const mapX = (day: string): number => {
    if (allDays.length <= 1) return xRight;
    const idx = dayIndex.get(day) ?? 0;
    return Math.round((xLeft + (idx / (allDays.length - 1)) * (xRight - xLeft)) * 10) / 10;
  };
  const mapY = (elo: number): number => {
    const clamped = Math.max(axisMin, Math.min(axisMax, elo));
    const frac = (axisMax - clamped) / Math.max(1, axisMax - axisMin);
    return Math.round((yTop + frac * (yBottom - yTop)) * 10) / 10;
  };

  const gridLines: string[] = [];
  const yLabels: string[] = [];
  for (let tick = axisMax; tick >= axisMin; tick -= 150) {
    const y = mapY(tick);
    const attrs = tick === 1500 ? ' stroke-opacity="0.28" stroke-dasharray="3,3"' : '';
    gridLines.push(`<line x1="${xLeft}" y1="${y}" x2="${xRight}" y2="${y}"${attrs} />`);
    yLabels.push(`<text x="38" y="${y + 4}">${tick}</text>`);
  }
  gridLines.push(`<line x1="${xLeft}" y1="215" x2="${xRight}" y2="215" />`);

  const xLabels: string[] = [];
  if (allDays.length === 1) {
    xLabels.push(`<text x="${xLeft}" y="234">${escapeHtml(formatShortDay(allDays[0]))}</text>`);
    xLabels.push(`<text x="${xRight}" y="234">Today</text>`);
  } else {
    const tickCount = Math.min(5, allDays.length);
    const chosenIndices = new Set<number>();
    for (let k = 0; k < tickCount; k++) {
      chosenIndices.add(Math.round((k / (tickCount - 1)) * (allDays.length - 1)));
    }
    const sortedTickIndices = [...chosenIndices].sort((a, b) => a - b);
    for (const idx of sortedTickIndices) {
      const d = allDays[idx];
      const x = mapX(d);
      const label = idx === allDays.length - 1 && d === todayUtc
        ? 'Today'
        : formatShortDay(d);
      xLabels.push(`<text x="${x}" y="234">${escapeHtml(label)}</text>`);
    }
  }

  interface LabelSpec {
    botIndex: number;
    y: number;
    text: string;
    color: string;
    bold: boolean;
  }

  const labelSpecs: LabelSpec[] = [];
  const svgElements: string[] = [];

  for (let bIdx = topBots.length - 1; bIdx >= 0; bIdx--) {
    const bot = topBots[bIdx];
    const color = SERIES_COLORS[bIdx];
    const pts = seriesByBot.get(bot.bot_id) ?? [];
    if (pts.length === 0) continue;

    const coords = pts.length === 1
      ? [
        {x: xLeft, y: mapY(pts[0].elo), pt: pts[0]},
        {x: xRight, y: mapY(pts[0].elo), pt: pts[0]},
      ]
      : pts.map(pt => ({x: mapX(pt.day), y: mapY(pt.elo), pt}));

    if (bIdx === 0 && coords.length >= 2) {
      const upper = coords.map(c => `${c.x},${mapY(c.pt.elo + 1.96 * c.pt.se)}`);
      const lower = [...coords].reverse().map(c => `${c.x},${mapY(c.pt.elo - 1.96 * c.pt.se)}`);
      svgElements.push(
        `<polygon points="${[...upper, ...lower].join(' ')}" ` +
        `fill="${color}" fill-opacity="0.1" />`
      );
    }

    const strokeW = bIdx === 0 ? '2.25' : bIdx === 1 ? '1.85' : '1.75';
    const polyPts = coords.map(c => `${c.x},${c.y}`).join(' ');
    svgElements.push(
      `<polyline fill="none" stroke="${color}" stroke-width="${strokeW}" points="${polyPts}" />`
    );

    for (let k = 1; k < pts.length; k++) {
      if (pts[k].versionId !== pts[k - 1].versionId) {
        const cx = mapX(pts[k].day);
        const cy = mapY(pts[k].elo);
        svgElements.push(
          `<circle cx="${cx}" cy="${cy}" r="2.5" fill="${color}" ` +
          `title="${escapeHtml(pts[k].versionStr)}" />`
        );
      }
    }

    const lastCoord = coords[coords.length - 1];
    if (bIdx === 0) {
      svgElements.push(
        `<circle cx="${lastCoord.x}" cy="${lastCoord.y}" r="3" fill="${color}" />`
      );
    }

    labelSpecs.push({
      botIndex: bIdx,
      y: lastCoord.y + 3,
      text: `${bot.bot_name} (${Math.round(bot.rating_elo)})`,
      color,
      bold: bIdx <= 1,
    });
  }

  labelSpecs.sort((a, b) => a.y - b.y);
  const minGap = 13;
  for (let i = 1; i < labelSpecs.length; i++) {
    if (labelSpecs[i].y - labelSpecs[i - 1].y < minGap) {
      labelSpecs[i].y = labelSpecs[i - 1].y + minGap;
    }
  }
  if (labelSpecs.length > 0 && labelSpecs[labelSpecs.length - 1].y > 214) {
    labelSpecs[labelSpecs.length - 1].y = 214;
    for (let i = labelSpecs.length - 2; i >= 0; i--) {
      if (labelSpecs[i + 1].y - labelSpecs[i].y < minGap) {
        labelSpecs[i].y = Math.max(20, labelSpecs[i + 1].y - minGap);
      }
    }
  }

  const labelEls = labelSpecs.map(l => (
    `<text x="632" y="${Math.round(l.y * 10) / 10}" fill="${l.color}" font-size="11"` +
    `${l.bold ? ' font-weight="bold"' : ''}>${escapeHtml(l.text)}</text>`
  ));

  const ariaLabel = `${escapeHtml(ladder.display_name)} Top Bot Rating History`;
  return `<div class="ladder-pane${hideCls}" data-ladder="${escapeHtml(ladder.slot)}">
    <figure class="chart">
      <svg viewBox="0 0 760 245" role="img" aria-label="${ariaLabel}">
        <g stroke="currentColor" stroke-opacity="0.12" stroke-width="1">
          ${gridLines.join('\n          ')}
        </g>
        <g fill="currentColor" fill-opacity="0.5" font-size="11" text-anchor="end">
          ${yLabels.join('\n          ')}
        </g>
        <g fill="currentColor" fill-opacity="0.5" font-size="11" text-anchor="middle">
          ${xLabels.join('\n          ')}
        </g>
        ${svgElements.join('\n        ')}
        ${labelEls.join('\n        ')}
      </svg>
    </figure>
  </div>`;
}

function renderMatchupsPane(
  ladder: LadderRow,
  isDefault: boolean,
  entries: LeaderboardEntryView[],
  pairs: PairAggregateRow[],
  publicDir: string,
  projectMeta: ReadonlyMap<string, ProjectMeta>
): string {
  const hideCls = isDefault ? '' : ' hide';
  const ranked = entries
    .filter(e => (e.role === 'champion' || e.role === 'challenger') && e.rank_current !== null)
    .sort((a, b) => a.rank_current! - b.rank_current!)
    .slice(0, 20);

  const participants = ranked.length >= 2
    ? ranked
    : entries
      .filter(e => e.role === 'champion' && e.matches_played > 0)
      .slice(0, 20);

  if (participants.length < 2) {
    return `<div class="table-wrap ladder-pane${hideCls}" ` +
      `data-ladder="${escapeHtml(ladder.slot)}" data-empty="true">` +
      '<p class="empty-state muted">Not enough entrants for matchups yet.</p></div>';
  }

  const pairMap = new Map<string, PairAggregateRow>();
  for (const p of pairs) {
    pairMap.set(`${p.v_low_id}:${p.v_high_id}`, p);
  }

  // Note: `&nbsp;` prevents `site`'s `html-minifier` (`removeEmptyElements: true`)
  // from stripping the top-left corner `<th>` cell.
  const colHeaders = participants
    .map(p => `<th>${escapeHtml(p.bot_name)}</th>`)
    .join('');

  const bodyRows = participants.map(rowEntry => {
    const rowHref = resolveBotHref(publicDir, projectMeta, rowEntry.bot_slug, rowEntry.bot_name);
    const rowLabel = `${formatBotLink(rowEntry.bot_name, rowHref, true)} ` +
      `<code>${escapeHtml(rowEntry.version_str)}</code>`;

    const cells = participants.map(colEntry => {
      if (rowEntry.version_id === colEntry.version_id) {
        return '<td class="diag">—</td>';
      }
      const lowId = Math.min(rowEntry.version_id, colEntry.version_id);
      const highId = Math.max(rowEntry.version_id, colEntry.version_id);
      const pair = pairMap.get(`${lowId}:${highId}`);
      if (!pair) {
        return '<td class="muted">—</td>';
      }
      const isLow = rowEntry.version_id === lowId;
      const wins = isLow ? pair.ww + pair.wt : pair.ll + pair.tl;
      const losses = isLow ? pair.ll + pair.tl : pair.ww + pair.wt;
      const ties = pair.split;
      const total = wins + losses + ties;
      if (total === 0) {
        return '<td class="muted">—</td>';
      }
      const scorePct = ((wins + 0.5 * ties) / total) * 100;
      const scoreStr = `${scorePct.toFixed(1)}%`;
      const scoreHtml = scorePct > 50 ? `<strong>${scoreStr}</strong>` : scoreStr;
      const cls = heatmapClass(scorePct);
      const losPart = pair.los_low !== null
        ? ` · LOS ${((isLow ? pair.los_low : 1 - pair.los_low) * 100).toFixed(1)}%`
        : '';
      const tip = `${wins}W–${losses}L–${ties}T (${total} matches)${losPart}`;
      const clsAttr = cls ? ` class="${cls}"` : '';
      return `<td${clsAttr} title="${escapeHtml(tip)}">${scoreHtml}` +
        `<span class="sub">${wins}–${losses}–${ties}</span></td>`;
    }).join('');

    return `<tr><td>${rowLabel}</td>${cells}</tr>`;
  }).join('');

  return `<div class="table-wrap ladder-pane${hideCls}" data-ladder="${escapeHtml(ladder.slot)}">
    <table class="matrix">
      <thead>
        <tr>
          <th>&nbsp;</th>
          ${colHeaders}
        </tr>
      </thead>
      <tbody>
        ${bodyRows}
      </tbody>
    </table>
  </div>`;
}

export function renderLeaderboardArtifacts(opts: {
  db: ArenaDB;
  renderer: Renderer;
  publicDir: string;
  projectMeta: ReadonlyMap<string, ProjectMeta>;
  nowSec: number;
}): {html: string; standingsJson: StandingsJsonDocument} {
  const {db, renderer, publicDir, projectMeta, nowSec} = opts;
  const ladders = db.getCurrentLadders();

  const entriesByLadder = new Map<string, LeaderboardEntryView[]>();
  for (const l of ladders) {
    entriesByLadder.set(l.id, db.getLeaderboardEntries(l.id));
  }

  let defaultLadder = ladders.find(l => (entriesByLadder.get(l.id)?.length ?? 0) > 0);
  if (!defaultLadder) {
    defaultLadder = ladders.find(l => l.status === 'active') ?? ladders[0];
  }
  const defaultSlot = defaultLadder?.slot ?? 'rby';

  const formatNavItems = ladders.map((l, idx) => {
    const sep = idx > 0 ? '\n    —\n    ' : '';
    const checked = l.slot === defaultSlot ? ' checked' : '';
    return `${sep}<li id="${escapeHtml(l.slot)}">
      <input type="radio" name="ladder" id="lad-${escapeHtml(l.slot)}" ` +
      `value="${escapeHtml(l.slot)}"${checked}>
      <label for="lad-${escapeHtml(l.slot)}">${escapeHtml(l.display_name)}</label>
    </li>`;
  }).join('');

  const standingsPanes: string[] = [];
  const historyPanes: string[] = [];
  const matchupsPanes: string[] = [];
  const jsonLadders: Record<string, StandingsJsonLadder> = {};

  let defaultHistoryEmpty = true;
  let defaultMatchupsEmpty = true;

  for (const l of ladders) {
    const isDefault = l.slot === defaultSlot;
    const hideCls = isDefault ? '' : ' hide';
    const entries = entriesByLadder.get(l.id) ?? [];
    const pairs = db.getPairAggregatesForLadder(l.id);
    const snapshots = db.getRatingSnapshotsForLadder(l.id);
    const adjacentLos = computeAdjacentLosMap(entries, pairs);

    const seenBestActiveBot = new Set<number>();
    const jsonRows: StandingsJsonEntry[] = [];

    if (entries.length === 0) {
      const msg = l.status === 'upcoming'
        ? `${escapeHtml(l.display_name)} ladder is upcoming — submissions are not open yet.`
        : `No active entries on ${escapeHtml(l.display_name)} yet.`;
      standingsPanes.push(
        `<div class="ladder-pane${hideCls}" data-ladder="${escapeHtml(l.slot)}">` +
        `<p class="empty-state muted">${msg}</p></div>`
      );
    } else {
      const rowsHtml = entries.map(e => {
        const isRetired = e.role === 'retired';
        const isActive = e.role === 'champion' || e.role === 'challenger';
        const isProvisional = isActive && (e.matches_played < 10 || e.rating_se > 60);
        const isBestActive = isActive && !seenBestActiveBot.has(e.bot_id);
        if (isBestActive) seenBestActiveBot.add(e.bot_id);
        const isSecondaryActive = isActive && !isBestActive;
        const isRankedPrimary =
          isActive && !isProvisional && isBestActive && e.rank_current !== null;

        const classes: string[] = [];
        const dataAttrs: string[] = [];
        let rowTitle = '';

        if (isRetired) {
          classes.push('secondary', 'hide');
          dataAttrs.push('data-retired="true"');
        } else {
          dataAttrs.push('data-active="true"');
          if (isBestActive) dataAttrs.push('data-best="true"');
          if (isProvisional) {
            classes.push('provisional');
            if (isSecondaryActive) classes.push('secondary');
            rowTitle = ' title="Provisional (&lt; 10 matches or SE &gt; 60 Elo)"';
          } else if (isSecondaryActive) {
            classes.push('secondary');
          }
        }

        let rankCell: string;
        if (isRankedPrimary) {
          rankCell = `<td><strong>${e.rank_current}</strong></td>`;
        } else if (isRetired) {
          rankCell = '<td class="muted" title="Retired version">—</td>';
        } else if (isSecondaryActive) {
          const anchorNote = e.is_anchor === 1 ? ' (1500 Elo anchor)' : '';
          rankCell = `<td class="muted" title="Secondary active version${anchorNote}">—</td>`;
        } else {
          rankCell = '<td class="muted">—</td>';
        }

        const href = resolveBotHref(publicDir, projectMeta, e.bot_slug, e.bot_name);
        const nameHtml = formatBotLink(e.bot_name, href, isRankedPrimary);
        const meta = projectMeta.get(e.bot_name);
        const repoIcon = isBestActive && meta?.source
          ? ` <a href="${escapeHtml(meta.source)}" class="subtle ext" ` +
            `title="Source">${EXT_ICON}</a>`
          : '';
        const retiredTag = isRetired ? ' <span class="muted">(retired)</span>' : '';
        const botCell = `<td>${nameHtml} <code>${escapeHtml(e.version_str)}</code>` +
          `${repoIcon}${retiredTag}</td>`;

        const eloRounded = Math.round(e.rating_elo);
        const ci95 = e.is_anchor === 1 ? 0 : Math.round(1.96 * e.rating_se);
        const eloInner = isRankedPrimary ? `<strong>${eloRounded}</strong>` : `${eloRounded}`;
        const eloCell = `<td class="num">${eloInner} <span class="muted">±${ci95}</span></td>`;

        const gxeCell = `<td class="num">${e.gxe.toFixed(1)}%</td>`;
        const wins = e.ww + e.wt;
        const losses = e.ll + e.tl;
        const ties = e.split;
        const wltCell = `<td class="num">${wins}–${losses}–${ties}</td>`;

        const streak = computeStreakLabel(e);
        const streakCell = `<td class="center">${streak.html}</td>`;

        const adjLos = isRankedPrimary ? adjacentLos.get(e.version_id) : undefined;
        const losPct = adjLos !== undefined ? Math.round(adjLos * 1000) / 10 : null;
        const losCell = adjLos !== undefined
          ? `<td class="num">${(adjLos * 100).toFixed(1)}%</td>`
          : '<td class="num muted">—</td>';

        jsonRows.push({
          rank: isRankedPrimary ? e.rank_current : null,
          rank_min: isRankedPrimary ? e.rank_min : null,
          rank_max: isRankedPrimary ? e.rank_max : null,
          bot_slug: e.bot_slug,
          bot_name: e.bot_name,
          version: e.version_str,
          role: e.role,
          is_anchor: e.is_anchor === 1,
          provisional: isProvisional,
          settled: e.settled_at !== null,
          elo: eloRounded,
          se: Math.round(e.rating_se * 10) / 10,
          ci95,
          lcb: Math.round(e.rating_lcb),
          gxe: Math.round(e.gxe * 10) / 10,
          wins,
          losses,
          ties,
          matches: e.matches_played,
          streak: streak.text,
          los_next: losPct,
        });

        const clsAttr = classes.length > 0 ? ` class="${classes.join(' ')}"` : '';
        const dAttrs = dataAttrs.length > 0 ? ` ${dataAttrs.join(' ')}` : '';
        return `<tr${clsAttr}${dAttrs}${rowTitle}>` +
          `${rankCell}${botCell}${eloCell}${gxeCell}${wltCell}${streakCell}${losCell}</tr>`;
      }).join('');

      const thGxe = 'Expected win percentage against prior N(1500, 350^2)';
      const thWlt = '2-game blind-pair Match Wins – Losses – Ties (1-1 splits)';
      const thStreak = 'Current consecutive outright match win/loss streak';
      const thLos = 'Pairwise Likelihood of Superiority over the next-ranked settled bot';
      standingsPanes.push(
        `<div class="table-wrap ladder-pane${hideCls}" data-ladder="${escapeHtml(l.slot)}">
          <table class="standings-table">
            <thead>
              <tr>
                <th title="Official rank by Conservative Rating (Elo - 1.96 * SE)">#</th>
                <th>Bot</th>
                <th class="num" title="MAP Davidson Elo ± 95% Confidence Interval">Elo</th>
                <th class="num" title="${thGxe}">GXE</th>
                <th class="num" title="${thWlt}">W–L–T</th>
                <th class="center" title="${thStreak}">Streak</th>
                <th class="num" title="${thLos}">LOS</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>`
      );
    }

    const hPane = renderHistoryPane(l, isDefault, entries, snapshots, nowSec);
    const mPane = renderMatchupsPane(l, isDefault, entries, pairs, publicDir, projectMeta);
    historyPanes.push(hPane);
    matchupsPanes.push(mPane);

    if (isDefault) {
      defaultHistoryEmpty = hPane.includes('data-empty="true"');
      defaultMatchupsEmpty = mPane.includes('data-empty="true"');
    }

    jsonLadders[l.slot] = {
      id: l.id,
      slot: l.slot,
      display_name: l.display_name,
      format_id: l.format_id,
      status: l.status,
      standings: jsonRows,
    };
  }

  const content = renderTemplate(LEADERBOARD_TEMPLATE, {
    formatNavItems,
    standingsPanes: standingsPanes.join('\n  '),
    historyInitialClass: defaultHistoryEmpty ? ' class="hide"' : '',
    historyPanes: historyPanes.join('\n  '),
    matchupsInitialClass: defaultMatchupsEmpty ? ' class="hide"' : '',
    matchupsPanes: matchupsPanes.join('\n  '),
  });

  const html = renderer.render({
    id: 'leaderboard',
    title: 'Leaderboard | pkmn.ai',
    header: header('Leaderboard'),
    path: '/leaderboard/',
    style: ARENA_STYLE,
    content,
  });

  return {
    html,
    standingsJson: {
      updated_at: nowSec,
      ladders: jsonLadders,
    },
  };
}

function renderLiveSlotCard(
  key: 'p1' | 'p2',
  slotData: LiveSlotTelemetry,
  live: LiveMatchTelemetry,
  nowSec: number,
  publicDir: string,
  projectMeta: ReadonlyMap<string, ProjectMeta>
): string {
  const isRunning = live.active_slot === key;
  const otherKey = key === 'p1' ? 'p2' : 'p1';
  const elapsed = isRunning ? Math.max(0, nowSec - live.turn_started_at) : 0;
  const budget = isRunning ? Math.round(live.turn_budget_s) : Math.round(slotData.bank_s);
  const bank = isRunning
    ? Math.max(0, Math.round(slotData.bank_s - elapsed))
    : Math.round(slotData.bank_s);
  const inc = Math.round(live.increment_s);
  const ramPct = ((slotData.ram_mb / 14336) * 100).toFixed(1);
  const href = resolveBotHref(publicDir, projectMeta, slotData.slug, slotData.name);
  const botHtml = `${formatBotLink(slotData.name, href, true)} ` +
    `<code>${escapeHtml(slotData.version)}</code>`;

  const badge = isRunning
    ? `<span class="state-running" id="state-${key}" ` +
      'title="Currently executing (SIGCONT)">&#9679; RUNNING</span>'
    : `<span class="state-paused" id="state-${key}" ` +
      `title="Frozen by kernel SIGSTOP while ${otherKey} computes">PAUSED</span>`;

  const timerTitle =
    `Pokémon Showdown RoomBattleTimer: 150s max bank (+60s Turn 1 grace), +${inc}s/turn`;

  const turnCls = isRunning ? 'yes' : 'muted';
  const ramText = `${Math.round(slotData.ram_mb).toLocaleString('en-US')} MiB`;
  return `<div class="slot-card ${isRunning ? 'running' : 'paused'}" id="slot-${key}">
    <div class="slot-top">
      <span><tt>${key}</tt> ${botHtml}</span>
      ${badge}
    </div>
    <div class="slot-timers" title="${escapeHtml(timerTitle)}">
      <span>Turn: <strong id="turn-${key}" class="${turnCls}">${elapsed}s</strong> ` +
        `<span class="muted">/ ${budget}s</span></span>
      <span>Bank: <strong id="bank-${key}">${bank}s</strong> ` +
        `<span class="muted">(+${inc}s/turn)</span></span>
    </div>
    <div class="slot-telemetry">
      <span>Last: <tt>${Math.round(slotData.last_turn_ms)} ms</tt></span>
      <span>Mean: <tt>${Math.round(slotData.mean_turn_ms)} ms/turn</tt></span>
      <span title="XNU ri_phys_footprint (14 GiB limit)">RAM: ` +
        `<tt>${ramText}</tt> (${ramPct}%)</span>
    </div>
  </div>`;
}

function renderLivePanelInner(
  liveDoc: LiveJsonDocument | null,
  nowSec: number,
  publicDir: string,
  projectMeta: ReadonlyMap<string, ProjectMeta>
): string {
  if (!liveDoc?.live || liveDoc.stale) {
    const idleMsg = liveDoc?.stale
      ? 'No active heartbeat — Arena is offline or idle.'
      : 'No battle currently running — Arena is idle.';
    return `<div class="live-idle muted">${idleMsg}</div>`;
  }

  const l = liveDoc.live;
  const fmtTitle = FORMAT_TITLES[l.format_id] ?? l.format_id;
  let g1Html = '';
  if (l.g1_summary) {
    const g1Res = l.g1_summary.winner_slot === 'p1'
      ? `${escapeHtml(l.p1.name)} 1–0`
      : l.g1_summary.winner_slot === 'p2'
        ? `${escapeHtml(l.p2.name)} 1–0`
        : 'Tie';
    g1Html = ` <span class="muted">(<tt>G1</tt>: ${g1Res}, ${l.g1_summary.turns} turns)</span>`;
  }
  const hbAge = Math.max(0, nowSec - liveDoc.updated_at);
  const gameText = `<strong>Game ${l.game_num} / 2</strong>, Turn ${l.turn}${g1Html}`;

  return `<div class="live-header">
    <span>
      <code>${escapeHtml(l.match_id)}</code> · <tt>${escapeHtml(fmtTitle)}</tt> · ${gameText}
    </span>
    <span class="muted">
      Heartbeat <tt>#${l.heartbeat_seq}</tt> (<tt id="hb-age">${hbAge}s</tt> ago)
    </span>
  </div>
  <div class="slots-grid">
    ${renderLiveSlotCard('p1', l.p1, l, nowSec, publicDir, projectMeta)}
    ${renderLiveSlotCard('p2', l.p2, l, nowSec, publicDir, projectMeta)}
  </div>`;
}

function renderMatchOutcomeDisplay(cat: RecentMatchView['match_category']): {
  p1Win: boolean;
  p2Win: boolean;
  html: string;
} {
  if (cat === 'WW') return {p1Win: true, p2Win: false, html: '<strong>2</strong>–0'};
  if (cat === 'WT' || cat === 'TW') {
    return {p1Win: true, p2Win: false, html: '<strong>1.5</strong>–0.5'};
  }
  if (cat === 'LL') return {p1Win: false, p2Win: true, html: '0–<strong>2</strong>'};
  if (cat === 'LT' || cat === 'TL') {
    return {p1Win: false, p2Win: true, html: '0.5–<strong>1.5</strong>'};
  }
  return {p1Win: false, p2Win: false, html: '1–1'};
}

export function renderBattlesPage(opts: {
  db: ArenaDB;
  renderer: Renderer;
  publicDir: string;
  projectMeta: ReadonlyMap<string, ProjectMeta>;
  liveDoc: LiveJsonDocument | null;
  recentMatchesLimit: number;
  nowSec: number;
}): string {
  const {db, renderer, publicDir, projectMeta, liveDoc, recentMatchesLimit, nowSec} = opts;
  const ladders = db.getCurrentLadders();
  const recentMatches = db.getRecentMatches(recentMatchesLimit);

  const formatFilterItems = ladders.map(l => {
    const slotEsc = escapeHtml(l.slot);
    return `—
    <li>
      <input type="radio" name="bformat" id="bf-${slotEsc}" value="${slotEsc}">
      <label for="bf-${slotEsc}">${escapeHtml(l.display_name)}</label>
    </li>`;
  }).join('\n    ');

  const botLinks: Record<string, string> = {};
  for (const s of db.getProjectArenaSummaries()) {
    const href = resolveBotHref(publicDir, projectMeta, s.slug, s.name);
    if (href) botLinks[s.slug] = href;
  }
  for (const m of recentMatches) {
    for (const side of [m.p1, m.p2]) {
      if (!botLinks[side.slug]) {
        const href = resolveBotHref(publicDir, projectMeta, side.slug, side.name);
        if (href) botLinks[side.slug] = href;
      }
    }
  }
  if (liveDoc?.live) {
    for (const side of [liveDoc.live.p1, liveDoc.live.p2]) {
      if (!botLinks[side.slug]) {
        const href = resolveBotHref(publicDir, projectMeta, side.slug, side.name);
        if (href) botLinks[side.slug] = href;
      }
    }
  }

  const historyRows = recentMatches.length === 0
    ? '<tr class="empty-row"><td colspan="6" class="center muted">' +
      'No completed battles yet.</td></tr>'
    : recentMatches.map(m => {
      const r = renderMatchOutcomeDisplay(m.match_category);
      const p1Href = botLinks[m.p1.slug];
      const p2Href = botLinks[m.p2.slug];
      const p1Cell = `${formatBotLink(m.p1.name, p1Href, r.p1Win)} ` +
        `<code>${escapeHtml(m.p1.version)}</code>`;
      const p2Cell = `${formatBotLink(m.p2.name, p2Href, r.p2Win)} ` +
        `<code>${escapeHtml(m.p2.version)}</code>`;

      const b1 = Math.round(Math.min(m.v1_g1_bank_s, m.v1_g2_bank_s));
      const b2 = Math.round(Math.min(m.v2_g1_bank_s, m.v2_g2_bank_s));
      const tip =
        `${m.match_category} · ${Math.round(m.v1_avg_turn_ms)}ms/` +
        `${Math.round(m.v2_avg_turn_ms)}ms · Bank ${b1}s/${b2}s · RAM ` +
        `${Math.round(m.v1_peak_ram_mb).toLocaleString('en-US')}M/` +
        `${Math.round(m.v2_peak_ram_mb).toLocaleString('en-US')}M`;

      const idEsc = escapeHtml(m.id);
      const rel = formatRelativeTime(nowSec, m.completed_at);
      return `<tr id="${idEsc}" data-fmt="${escapeHtml(m.slot)}">
        <td><a href="#${idEsc}" class="subtle"><code>${idEsc}</code></a></td>
        <td>${p1Cell}</td>
        <td>${p2Cell}</td>
        <td class="center" title="${escapeHtml(tip)}">${r.html}</td>
        <td class="num">${m.g1_turns} / ${m.g2_turns}</td>
        <td class="num muted" data-ts="${m.completed_at}">${rel}</td>
      </tr>`;
    }).join('\n        ');

  const initialState: LiveJsonDocument = liveDoc ?? {
    updated_at: nowSec,
    stale: false,
    live: null,
    recent_matches: recentMatches,
  };

  const content = renderTemplate(BATTLES_TEMPLATE, {
    formatFilterItems,
    livePanelInner: renderLivePanelInner(liveDoc, nowSec, publicDir, projectMeta),
    historyRows,
    initialLiveJson: safeInlineJson(initialState),
    botLinksJson: safeInlineJson(botLinks),
    formatTitlesJson: safeInlineJson(FORMAT_TITLES),
  });

  return renderer.render({
    id: 'battles',
    title: 'Battles | pkmn.ai',
    header: header('Battles'),
    path: '/battles/',
    style: ARENA_STYLE,
    content,
  });
}

function readExistingLiveJson(publicDir: string): LiveJsonDocument | null {
  const filePath = path.join(publicDir, 'api', 'live.json');
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as LiveJsonDocument;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {}
  return null;
}

export function renderArenaPages(options: RenderArenaOptions) {
  const publicDir = options.publicDir ?? PUBLIC_DIR;
  const staticDir = options.staticDir ?? STATIC_DIR;
  const nowSec = options.now ?? Math.floor(Date.now() / 1000);
  const recentMatchesLimit = options.recentMatchesLimit ?? 50;

  const renderer = options.renderer ?? (
    publicDir === PUBLIC_DIR
      ? siteRenderer
      : new site.page.Renderer({
        public: publicDir,
        analytics: 'G-LQ8TW28Z7Q',
        description: 'The home of competitive Pokémon artificial intelligence',
        url: 'https://pkmn.ai',
        stylesheet: path.join(staticDir, 'index.css'),
        highlight: true,
      })
  );

  const projectMeta = loadProjectMetaMap(staticDir);
  const summaries = options.db.getProjectArenaSummaries();

  const arenaByName = new Map<string, projects.ProjectArenaInfo>();
  for (const s of summaries) {
    const hasProfile = fs.existsSync(
      path.join(publicDir, 'leaderboard', s.slug, 'index.html')
    );
    const meta = projectMeta.get(s.name);
    const profileHref = hasProfile
      ? `/leaderboard/${encodeURIComponent(s.slug)}/`
      : meta
        ? `#${meta.id}`
        : undefined;
    arenaByName.set(s.name, {
      slug: s.slug,
      name: s.name,
      profileHref,
      bestRank: s.best_rank,
      bestLcb: s.best_lcb,
      ladders: s.ladders.map(b => ({
        slot: b.slot,
        displayName: b.display_name,
        rank: b.rank,
        provisional: b.provisional,
      })),
    });
  }

  const projectsPage = projects.page(staticDir, arenaByName);
  const projectsHtml = renderer.render({id: 'projects', ...projectsPage});
  writeFileAtomic(path.join(publicDir, 'projects', 'index.html'), projectsHtml);

  const {html: leaderboardHtml, standingsJson} = renderLeaderboardArtifacts({
    db: options.db,
    renderer,
    publicDir,
    projectMeta,
    nowSec,
  });
  writeFileAtomic(path.join(publicDir, 'leaderboard', 'index.html'), leaderboardHtml);
  writeFileAtomic(
    path.join(publicDir, 'leaderboard', 'standings.json'),
    `${JSON.stringify(standingsJson, null, 2)}\n`
  );

  const liveDoc = options.liveDoc !== undefined
    ? options.liveDoc
    : readExistingLiveJson(publicDir);
  const battlesHtml = renderBattlesPage({
    db: options.db,
    renderer,
    publicDir,
    projectMeta,
    liveDoc,
    recentMatchesLimit,
    nowSec,
  });
  writeFileAtomic(path.join(publicDir, 'battles', 'index.html'), battlesHtml);
}
