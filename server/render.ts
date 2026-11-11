import * as fs from 'fs';
import * as path from 'path';

import * as site from 'site';
import * as yaml from 'yaml';

import type * as db from '../db';
import {Renderer, header, renderer as siteRenderer} from '../static/build';
import * as projects from '../static/projects';
import {escapeHtml, renderTemplate, root} from '../static/util';

import * as arena from './arena';
import {renderAgentProfiles} from './profile';
import * as ratings from './ratings';
import * as tournaments from './tournaments';

export const PUBLIC_DIR = root('public');
export const STATIC_DIR = root('static');

export const ARENA_STYLE = fs.readFileSync(root('static', 'arena.css'), 'utf8');
const ARENA_TEMPLATE = fs.readFileSync(root('static', 'arena.html'), 'utf8');
const LADDER_TEMPLATE = fs.readFileSync(root('static', 'ladder.html'), 'utf8');
const BATTLES_TEMPLATE = fs.readFileSync(root('static', 'battles.html'), 'utf8');

export const EXT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
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

export interface StandingsEntry {
  rank?: number;
  rankMin?: number;
  rankMax?: number;
  slug: string;
  name: string;
  version: string;
  role: 'champion' | 'challenger' | 'retired';
  isAnchor: boolean;
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
  losNext?: number;
}

export interface StandingsLadder {
  id: string;
  slot: db.LadderSlot;
  name: string;
  format: string;
  status: string;
  standings: StandingsEntry[];
}

export interface StandingsDocument {
  updatedAt: number;
  ladders: Record<string, StandingsLadder>;
}

export interface Options {
  db: db.Database;
  renderer?: Renderer;
  publicDir?: string;
  staticDir?: string;
  avatarsDir?: string;
  liveDoc?: arena.LiveDocument;
  tournamentBroadcast?: tournaments.LiveBroadcast;
  recentMatchesLimit?: number;
  now?: number;
}

export interface ProjectMeta {
  id: string;
  site?: string;
  active?: number | [number, number];
  license?: string;
  source?: string;
  engine?: string | Array<{name: string; url: string}>;
  language?: string | string[];
}

export function writeFileAtomic(filePath: string, contents: string) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, contents, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

export function copyFileAtomic(srcPath: string, destPath: string) {
  fs.mkdirSync(path.dirname(destPath), {recursive: true});
  const tmpPath = `${destPath}.tmp.${process.pid}.${Date.now()}`;
  fs.copyFileSync(srcPath, tmpPath);
  fs.renameSync(tmpPath, destPath);
}

// Escapes `<` as `\u003c` so inline `<script>` JSON payloads can never break out via `</script>`.
export function safeInlineJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function loadProjectMetaMap(staticDir: string): Map<string, ProjectMeta> {
  const file = path.join(staticDir, 'projects.yml');
  const map = new Map<string, ProjectMeta>();
  if (!fs.existsSync(file)) return map;
  const parsed = yaml.parse(fs.readFileSync(file, 'utf8')) as projects.Project[] | undefined;
  if (!Array.isArray(parsed)) return map;
  for (const p of parsed) {
    if (!p.name) continue;
    const id = p.name.replaceAll(' ', '');
    map.set(p.name, {
      id,
      site: p.site,
      active: p.active,
      license: p.license,
      source: p.source,
      engine: p.engine as ProjectMeta['engine'],
      language: p.language,
    });
  }
  return map;
}

export function resolveAgentHref(
  publicDir: string,
  projectMeta: ReadonlyMap<string, ProjectMeta>,
  slug: string,
  name: string,
  profileSlugs?: ReadonlySet<string>
): string | undefined {
  if (
    profileSlugs?.has(slug) ||
    fs.existsSync(path.join(publicDir, 'projects', slug, 'index.html'))
  ) {
    return `/projects/${encodeURIComponent(slug)}/`;
  }
  const meta = projectMeta.get(name);
  if (meta) {
    return `/projects/#${meta.id}`;
  }
  return undefined;
}

export function formatAgentLink(
  name: string,
  href: string | undefined,
  bold: boolean
): string {
  const inner = bold ? `<strong>${escapeHtml(name)}</strong>` : escapeHtml(name);
  if (!href) return inner;
  return `<a href="${escapeHtml(href)}" class="subtle">${inner}</a>`;
}

export function formatRelativeTime(nowSec: number, completedAt: number): string {
  const diff = Math.max(0, nowSec - completedAt);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function formatShortDay(dayUtc: string): string {
  const parts = dayUtc.split('-');
  if (parts.length !== 3) return dayUtc;
  const monthIdx = Number(parts[1]) - 1;
  const dayNum = Number(parts[2]);
  const m = MONTHS[monthIdx];
  if (!m || !Number.isFinite(dayNum)) return dayUtc;
  return `${m} ${dayNum}`;
}

function parseUtcDayMillis(dayUtc: string): number {
  return Date.parse(`${dayUtc}T00:00:00Z`);
}

function computeStreakLabel(entry: db.LeaderboardEntryView): {
  text: string;
  html: string;
} {
  if (entry.currentWinStreak >= 3) {
    const s = `W${entry.currentWinStreak}`;
    return {text: s, html: `<span class="yes">${s}</span>`};
  }
  if (entry.currentWinStreak >= 1) {
    const s = `W${entry.currentWinStreak}`;
    return {text: s, html: s};
  }
  if (entry.currentLossStreak >= 3) {
    const s = `L${entry.currentLossStreak}`;
    return {text: s, html: `<span class="no">${s}</span>`};
  }
  if (entry.currentLossStreak >= 1) {
    const s = `L${entry.currentLossStreak}`;
    return {text: s, html: s};
  }
  if (entry.matches > 0) {
    return {text: 'T1', html: 'T1'};
  }
  return {text: '—', html: '<span class="muted">—</span>'};
}

// Computes pairwise Likelihood of Superiority (LOS) for each ranked entrant against the entrant
// ranked immediately below them (`#r` vs `#(r+1)`). Uses precomputed `pair_aggregates.low_los`
// when the two versions have already faced each other, falling back to a single warm-started
// Davidson covariance solve when an adjacent pair has 0 direct head-to-head games.
export function computeAdjacentLosMap(
  entries: db.LeaderboardEntryView[],
  pairs: db.PairAggregateRow[]
): Map<number, number> {
  const ranked = entries
    .filter(e => (e.role === 'champion' || e.role === 'challenger') && e.rankCurrent !== undefined)
    .sort((a, b) => a.rankCurrent! - b.rankCurrent!);

  const result = new Map<number, number>();
  if (ranked.length < 2) return result;

  const pairMap = new Map<string, db.PairAggregateRow>();
  for (const p of pairs) {
    pairMap.set(`${p.lowVersionId}:${p.highVersionId}`, p);
  }

  let fallbackSolve: {
    indexByVer: Map<number, number>;
    theta: Float64Array;
    covariance: Float64Array;
  } | undefined;

  const ensureFallbackSolve = () => {
    if (fallbackSolve) return fallbackSolve;
    const indexByVer = new Map<number, number>();
    let anchorIdx = -1;
    for (let i = 0; i < entries.length; i++) {
      indexByVer.set(entries[i].versionId, i);
      if (entries[i].isAnchor && anchorIdx === -1) anchorIdx = i;
    }
    const indexedPairs: ratings.PairMatchCounts[] = [];
    for (const p of pairs) {
      const idxLow = indexByVer.get(p.lowVersionId);
      const idxHigh = indexByVer.get(p.highVersionId);
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
    const warm = new Float64Array(entries.map(e => (e.elo - 1500) / ratings.ELO_SCALE));
    const solved = ratings.computeDavidsonRatings(
      entries.length,
      indexedPairs,
      anchorIdx,
      1500,
      warm
    );
    fallbackSolve = {indexByVer, theta: solved.theta, covariance: solved.covariance};
    return fallbackSolve;
  };

  for (let r = 0; r < ranked.length - 1; r++) {
    const cur = ranked[r];
    const next = ranked[r + 1];
    const lowId = Math.min(cur.versionId, next.versionId);
    const highId = Math.max(cur.versionId, next.versionId);
    const pair = pairMap.get(`${lowId}:${highId}`);
    if (pair?.lowLos !== undefined) {
      const los = cur.versionId === lowId ? pair.lowLos : 1 - pair.lowLos;
      result.set(cur.versionId, los);
    } else {
      const solved = ensureFallbackSolve();
      const idxCur = solved.indexByVer.get(cur.versionId);
      const idxNext = solved.indexByVer.get(next.versionId);
      if (idxCur !== undefined && idxNext !== undefined) {
        const los = ratings.computeLOS(
          solved.theta,
          solved.covariance,
          entries.length,
          idxCur,
          idxNext
        );
        result.set(cur.versionId, los);
      }
    }
  }

  return result;
}

export function heatmapClass(scorePct: number): string {
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

function renderHistorySectionHtml(
  ladder: db.LadderRow,
  entries: db.LeaderboardEntryView[],
  snapshots: db.LadderSnapshotHistoryRow[],
  nowSec: number
): {html: string; isEmpty: boolean} {
  const bestActiveByAgent = new Map<number, db.LeaderboardEntryView>();
  for (const e of entries) {
    if (e.role !== 'champion' && e.role !== 'challenger') continue;
    if (e.matches <= 0) continue;
    if (!bestActiveByAgent.has(e.agentId)) {
      bestActiveByAgent.set(e.agentId, e);
    }
  }

  const topAgents = [...bestActiveByAgent.values()]
    .sort((a, b) => {
      if (a.rankCurrent !== undefined && b.rankCurrent !== undefined) {
        return a.rankCurrent - b.rankCurrent;
      }
      if (a.rankCurrent !== undefined) return -1;
      if (b.rankCurrent !== undefined) return 1;
      return b.lcb - a.lcb || b.elo - a.elo;
    })
    .slice(0, SERIES_COLORS.length);

  if (topAgents.length === 0) {
    return {
      html: '<p class="empty-state muted">No rating history yet.</p>',
      isEmpty: true,
    };
  }

  const todayUtc = new Date(nowSec * 1000).toISOString().slice(0, 10);
  const snapsByAgent = new Map<number, db.LadderSnapshotHistoryRow[]>();
  for (const s of snapshots) {
    if (s.matches <= 0) continue;
    const list = snapsByAgent.get(s.agentId) ?? [];
    list.push(s);
    snapsByAgent.set(s.agentId, list);
  }

  interface PlottedPoint {
    day: string;
    versionId: number;
    version: string;
    elo: number;
    se: number;
  }

  const seriesByAgent = new Map<number, PlottedPoint[]>();
  const allDaysSet = new Set<string>();

  for (const agent of topAgents) {
    const raw = snapsByAgent.get(agent.agentId) ?? [];
    const hasSettledDay = raw.some(r => r.matches >= 10 || r.se <= 60);
    const filtered = hasSettledDay
      ? raw.filter(r => r.matches >= 10 || r.se <= 60)
      : raw;

    const byDay = new Map<string, PlottedPoint>();
    for (const r of filtered) {
      const prev = byDay.get(r.dayUtc);
      if (!prev || r.elo > prev.elo) {
        byDay.set(r.dayUtc, {
          day: r.dayUtc,
          versionId: r.versionId,
          version: r.version,
          elo: r.elo,
          se: r.se,
        });
      }
    }

    if (!byDay.has(todayUtc)) {
      byDay.set(todayUtc, {
        day: todayUtc,
        versionId: agent.versionId,
        version: agent.version,
        elo: agent.elo,
        se: agent.se,
      });
    }

    const pts = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
    for (const pt of pts) allDaysSet.add(pt.day);
    seriesByAgent.set(agent.agentId, pts);
  }

  const allDays = [...allDaysSet].sort((a, b) => a.localeCompare(b));
  const minDayMillis = allDays.length > 0 ? parseUtcDayMillis(allDays[0]) : 0;
  const maxDayMillis = allDays.length > 0 ? parseUtcDayMillis(allDays[allDays.length - 1]) : 0;

  let minElo = 1350;
  let maxElo = 1800;
  for (const pts of seriesByAgent.values()) {
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

  // Map YYYY-MM-DD dates proportionally by UTC timestamp so irregular snapshot gaps reflect true
  // elapsed days rather than stretching sparse early days to equal pixel widths.
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
  for (let tick = axisMax; tick >= axisMin; tick -= 150) {
    const y = mapY(tick);
    const attrs = tick === 1500 ? ' stroke-opacity="0.28" stroke-dasharray="3,3"' : '';
    gridLines.push(`<line x1="${xLeft}" y1="${y}" x2="${xRight}" y2="${y}"${attrs} />`);
    yLabels.push(`<text x="38" y="${y + 4}">${tick}</text>`);
  }
  gridLines.push(`<line x1="${xLeft}" y1="215" x2="${xRight}" y2="215" />`);

  const xLabels: string[] = [];
  if (maxDayMillis <= minDayMillis) {
    xLabels.push(`<text x="${xLeft}" y="234">${escapeHtml(formatShortDay(allDays[0]))}</text>`);
    xLabels.push(`<text x="${xRight}" y="234">Today</text>`);
  } else {
    const seenTickX = new Set<number>();
    const tickCount = Math.min(5, allDays.length);
    for (let k = 0; k < tickCount; k++) {
      const targetMillis = minDayMillis + (k / (tickCount - 1)) * (maxDayMillis - minDayMillis);
      let bestDay = allDays[0];
      let bestDist = Infinity;
      for (const d of allDays) {
        const dist = Math.abs(parseUtcDayMillis(d) - targetMillis);
        if (dist < bestDist) {
          bestDist = dist;
          bestDay = d;
        }
      }
      const x = mapX(bestDay);
      if ([...seenTickX].some(prevX => Math.abs(prevX - x) < 55)) continue;
      seenTickX.add(x);
      const label = bestDay === todayUtc && bestDay === allDays[allDays.length - 1]
        ? 'Today'
        : formatShortDay(bestDay);
      xLabels.push(`<text x="${x}" y="234">${escapeHtml(label)}</text>`);
    }
  }

  interface LabelSpec {
    agentIndex: number;
    y: number;
    text: string;
    color: string;
    bold: boolean;
  }

  const labelSpecs: LabelSpec[] = [];
  const svgElements: string[] = [];

  for (let aIdx = topAgents.length - 1; aIdx >= 0; aIdx--) {
    const agent = topAgents[aIdx];
    const color = SERIES_COLORS[aIdx];
    const pts = seriesByAgent.get(agent.agentId) ?? [];
    if (pts.length === 0) continue;

    const coords = pts.length === 1
      ? [
        {x: xLeft, y: mapY(pts[0].elo), pt: pts[0]},
        {x: xRight, y: mapY(pts[0].elo), pt: pts[0]},
      ]
      : pts.map(pt => ({x: mapX(pt.day), y: mapY(pt.elo), pt}));

    if (aIdx === 0 && coords.length >= 2) {
      const upper = coords.map(c => `${c.x},${mapY(c.pt.elo + 1.96 * c.pt.se)}`);
      const lower = [...coords].reverse().map(c => `${c.x},${mapY(c.pt.elo - 1.96 * c.pt.se)}`);
      svgElements.push(
        `<polygon points="${[...upper, ...lower].join(' ')}" ` +
        `fill="${color}" fill-opacity="0.1" />`
      );
    }

    const strokeW = aIdx === 0 ? '2.25' : aIdx === 1 ? '1.85' : '1.75';
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
          `title="${escapeHtml(pts[k].version)}" />`
        );
      }
    }

    const lastCoord = coords[coords.length - 1];
    if (aIdx === 0) {
      svgElements.push(
        `<circle cx="${lastCoord.x}" cy="${lastCoord.y}" r="3" fill="${color}" />`
      );
    }

    labelSpecs.push({
      agentIndex: aIdx,
      y: lastCoord.y + 3,
      text: `${agent.agentName} (${Math.round(agent.elo)})`,
      color,
      bold: aIdx <= 1,
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

  const ariaLabel = `${escapeHtml(ladder.name)} Top Agent Rating History`;
  return {
    html: `<figure class="chart">
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
    </figure>`,
    isEmpty: false,
  };
}

function renderMatchupsSectionHtml(
  entries: db.LeaderboardEntryView[],
  pairs: db.PairAggregateRow[],
  publicDir: string,
  projectMeta: ReadonlyMap<string, ProjectMeta>,
  profileSlugs: ReadonlySet<string>
): {html: string; isEmpty: boolean} {
  const ranked = entries
    .filter(e => (e.role === 'champion' || e.role === 'challenger') && e.rankCurrent !== undefined)
    .sort((a, b) => a.rankCurrent! - b.rankCurrent!)
    .slice(0, 20);

  const participants = ranked.length >= 2
    ? ranked
    : entries
      .filter(e => e.role === 'champion' && e.matches > 0)
      .slice(0, 20);

  if (participants.length < 2) {
    return {
      html: '<p class="empty-state muted">Not enough entrants for matchups yet.</p>',
      isEmpty: true,
    };
  }

  const pairMap = new Map<string, db.PairAggregateRow>();
  for (const p of pairs) {
    pairMap.set(`${p.lowVersionId}:${p.highVersionId}`, p);
  }

  // Note: `&nbsp;` prevents `site`'s `html-minifier` (`removeEmptyElements: true`)
  // from stripping the top-left corner `<th>` cell.
  const colHeaders = participants
    .map(p => `<th>${escapeHtml(p.agentName)}</th>`)
    .join('');

  const bodyRows = participants.map(rowEntry => {
    const rowHref = resolveAgentHref(
      publicDir,
      projectMeta,
      rowEntry.agentSlug,
      rowEntry.agentName,
      profileSlugs
    );
    const rowLabel = `${formatAgentLink(rowEntry.agentName, rowHref, true)} ` +
      `<code>${escapeHtml(rowEntry.version)}</code>`;

    const cells = participants.map(colEntry => {
      if (rowEntry.versionId === colEntry.versionId) {
        return '<td class="diag">—</td>';
      }
      const lowId = Math.min(rowEntry.versionId, colEntry.versionId);
      const highId = Math.max(rowEntry.versionId, colEntry.versionId);
      const pair = pairMap.get(`${lowId}:${highId}`);
      if (!pair) {
        return '<td class="muted">—</td>';
      }
      const isLow = rowEntry.versionId === lowId;
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
      const losPart = pair.lowLos !== undefined
        ? ` · LOS ${((isLow ? pair.lowLos : 1 - pair.lowLos) * 100).toFixed(1)}%`
        : '';
      const tip = `${wins}W–${losses}L–${ties}T (${total} matches)${losPart}`;
      const clsAttr = cls ? ` class="${cls}"` : '';
      return `<td${clsAttr} title="${escapeHtml(tip)}">${scoreHtml}` +
        `<span class="sub">${wins}–${losses}–${ties}</span></td>`;
    }).join('');

    return `<tr><td>${rowLabel}</td>${cells}</tr>`;
  }).join('');

  return {
    html: `<div class="table-wrap">
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
  </div>`,
    isEmpty: false,
  };
}

export function renderArenaAndLadderArtifacts(opts: {
  db: db.Database;
  renderer: Renderer;
  publicDir: string;
  staticDir: string;
  projectMeta: ReadonlyMap<string, ProjectMeta>;
  profileSlugs: ReadonlySet<string>;
  nowSec: number;
}): {
  arenaHtml: string;
  ladderHtmlBySlot: Record<string, string>;
  standingsJson: StandingsDocument;
} {
  const {db, renderer, publicDir, staticDir, projectMeta, profileSlugs, nowSec} = opts;
  const ladders = db.getCurrentLadders();

  const ladderHtmlBySlot: Record<string, string> = {};
  const jsonLadders: Record<string, StandingsLadder> = {};
  const ladderSummaryRows: string[] = [];

  for (const l of ladders) {
    const entries = db.getLeaderboardEntries(l.id);
    const pairs = db.getPairAggregatesForLadder(l.id);
    const snapshots = db.getRatingSnapshotsForLadder(l.id);
    const adjacentLos = computeAdjacentLosMap(entries, pairs);

    const formatNavItems = ladders.map((other, idx) => {
      const sep = idx > 0 ? '\n    —\n    ' : '';
      const href = `/arena/ladders/${encodeURIComponent(other.slot)}/`;
      const isCurrent = other.slot === l.slot;
      const label = isCurrent
        ? `<strong>${escapeHtml(other.name)}</strong>`
        : escapeHtml(other.name);
      const curAttr = isCurrent ? ' aria-current="page"' : '';
      return `${sep}<li id="${escapeHtml(other.slot)}">` +
        `<a href="${escapeHtml(href)}" class="subtle"${curAttr}>${label}</a></li>`;
    }).join('');

    const seenBestActiveAgent = new Set<number>();
    const jsonRows: StandingsEntry[] = [];
    let top1SummaryCells: string | undefined;
    let standingsPane: string;

    if (entries.length === 0) {
      const msg = l.status === 'upcoming'
        ? `${escapeHtml(l.name)} ladder is upcoming — submissions are not open yet.`
        : `No active entries on ${escapeHtml(l.name)} yet.`;
      standingsPane = `<p class="empty-state muted">${msg}</p>`;
    } else {
      const rowsHtml = entries.map(e => {
        const isRetired = e.role === 'retired';
        const isActive = e.role === 'champion' || e.role === 'challenger';
        const isProvisional = isActive && (e.matches < 10 || e.se > 60);
        const isBestActive = isActive && !seenBestActiveAgent.has(e.agentId);
        if (isBestActive) seenBestActiveAgent.add(e.agentId);
        const isSecondaryActive = isActive && !isBestActive;
        const isRankedPrimary =
          isActive && !isProvisional && isBestActive && e.rankCurrent !== undefined;

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
          rankCell = `<td><strong>${e.rankCurrent}</strong></td>`;
        } else if (isRetired) {
          rankCell = '<td class="muted" title="Retired version">—</td>';
        } else if (isSecondaryActive) {
          const anchorNote = e.isAnchor ? ' (1500 Elo anchor)' : '';
          rankCell = `<td class="muted" title="Secondary active version${anchorNote}">—</td>`;
        } else {
          rankCell = '<td class="muted">—</td>';
        }

        const href = resolveAgentHref(
          publicDir,
          projectMeta,
          e.agentSlug,
          e.agentName,
          profileSlugs
        );
        const nameHtml = formatAgentLink(e.agentName, href, isRankedPrimary);
        const meta = projectMeta.get(e.agentName);
        const repoIcon = isBestActive && meta?.source
          ? ` <a href="${escapeHtml(meta.source)}" class="subtle ext" ` +
            `title="Source">${EXT_ICON}</a>`
          : '';
        const retiredTag = isRetired ? ' <span class="muted">(retired)</span>' : '';
        const agentCell = `<td>${nameHtml} <code>${escapeHtml(e.version)}</code>` +
          `${repoIcon}${retiredTag}</td>`;

        const eloRounded = Math.round(e.elo);
        const ci95 = e.isAnchor ? 0 : Math.round(1.96 * e.se);
        const eloInner = isRankedPrimary ? `<strong>${eloRounded}</strong>` : `${eloRounded}`;
        const eloCell = `<td class="num">${eloInner} <span class="muted">±${ci95}</span></td>`;

        const gxeCell = `<td class="num">${e.gxe.toFixed(1)}%</td>`;
        const wins = e.ww + e.wt;
        const losses = e.ll + e.tl;
        const ties = e.split;
        const wltCell = `<td class="num">${wins}–${losses}–${ties}</td>`;

        const streak = computeStreakLabel(e);
        const streakCell = `<td class="center">${streak.html}</td>`;

        const adjLos = isRankedPrimary ? adjacentLos.get(e.versionId) : undefined;
        const losPct = adjLos !== undefined ? Math.round(adjLos * 1000) / 10 : undefined;
        const losCell = adjLos !== undefined
          ? `<td class="num">${(adjLos * 100).toFixed(1)}%</td>`
          : '<td class="num muted">—</td>';

        if (isRankedPrimary && e.rankCurrent === 1 && top1SummaryCells === undefined) {
          top1SummaryCells = `${agentCell}${eloCell}${gxeCell}${wltCell}${streakCell}${losCell}`;
        }

        jsonRows.push({
          rank: isRankedPrimary ? e.rankCurrent : undefined,
          rankMin: isRankedPrimary ? e.rankMin : undefined,
          rankMax: isRankedPrimary ? e.rankMax : undefined,
          slug: e.agentSlug,
          name: e.agentName,
          version: e.version,
          role: e.role,
          isAnchor: e.isAnchor,
          provisional: isProvisional,
          settled: e.settledAt !== undefined,
          elo: eloRounded,
          se: Math.round(e.se * 10) / 10,
          ci95,
          lcb: Math.round(e.lcb),
          gxe: Math.round(e.gxe * 10) / 10,
          wins,
          losses,
          ties,
          matches: e.matches,
          streak: streak.text,
          losNext: losPct,
        });

        const clsAttr = classes.length > 0 ? ` class="${classes.join(' ')}"` : '';
        const dAttrs = dataAttrs.length > 0 ? ` ${dataAttrs.join(' ')}` : '';
        return `<tr${clsAttr}${dAttrs}${rowTitle}>` +
          `${rankCell}${agentCell}${eloCell}${gxeCell}${wltCell}${streakCell}${losCell}</tr>`;
      }).join('');

      const thGxe = 'Expected win percentage against prior N(1500, 350^2)';
      const thWlt = '2-game blind-pair Match Wins – Losses – Ties (1-1 splits)';
      const thStreak = 'Current consecutive outright match win/loss streak';
      const thLos = 'Pairwise Likelihood of Superiority over the next-ranked settled agent';
      standingsPane = `<div class="table-wrap">
        <table class="standings-table">
          <thead>
            <tr>
              <th title="Official rank by Conservative Rating (Elo - 1.96 * SE)">#</th>
              <th>Agent</th>
              <th class="num" title="MAP Davidson Elo ± 95% Confidence Interval">Elo</th>
              <th class="num" title="${thGxe}">GXE</th>
              <th class="num" title="${thWlt}">W–L–T</th>
              <th class="center" title="${thStreak}">Streak</th>
              <th class="num" title="${thLos}">LOS</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>`;
    }

    const fmtTitle = FORMAT_TITLES[l.format] ?? l.format;
    const ladderHref = `/arena/ladders/${encodeURIComponent(l.slot)}/`;
    const ladderCell =
      `<td><a href="${escapeHtml(ladderHref)}" class="subtle" ` +
      `title="${escapeHtml(fmtTitle)}"><strong><tt>${escapeHtml(l.name)}</tt></strong>` +
      '</a></td>';

    if (top1SummaryCells !== undefined) {
      ladderSummaryRows.push(`<tr>${ladderCell}${top1SummaryCells}</tr>`);
    } else {
      const stateLabel = l.status === 'upcoming'
        ? 'Upcoming'
        : entries.some(e => e.role === 'champion' || e.role === 'challenger')
          ? 'Provisional'
          : 'No entries yet';
      ladderSummaryRows.push(
        `<tr>${ladderCell}` +
        `<td class="muted">${stateLabel}</td>` +
        '<td class="num muted">—</td>' +
        '<td class="num muted">—</td>' +
        '<td class="num muted">—</td>' +
        '<td class="center muted">—</td>' +
        '<td class="num muted">—</td></tr>'
      );
    }

    const historyRes = renderHistorySectionHtml(l, entries, snapshots, nowSec);
    const matchupsRes = renderMatchupsSectionHtml(
      entries,
      pairs,
      publicDir,
      projectMeta,
      profileSlugs
    );

    const ladderContent = renderTemplate(LADDER_TEMPLATE, {
      formatNavItems,
      standingsPane,
      historyInitialClass: historyRes.isEmpty ? ' class="hide"' : '',
      historyPane: historyRes.html,
      matchupsInitialClass: matchupsRes.isEmpty ? ' class="hide"' : '',
      matchupsPane: matchupsRes.html,
    });

    ladderHtmlBySlot[l.slot] = renderer.render({
      id: 'leaderboard',
      title: `Arena — ${l.name} | pkmn.ai`,
      header: header('<a href="/arena/" class="subtle">Ladders</a>'),
      path: `/arena/ladders/${l.slot}/`,
      style: ARENA_STYLE,
      content: ladderContent,
    });

    jsonLadders[l.slot] = {
      id: l.id,
      slot: l.slot,
      name: l.name,
      format: l.format,
      status: l.status,
      standings: jsonRows,
    };
  }

  const arenaDjPath = path.join(staticDir, 'arena.dj');
  const blurbDj = fs.existsSync(arenaDjPath) ? fs.readFileSync(arenaDjPath, 'utf8') : '';
  const blurbHtml = site.html.render(blurbDj);
  const tournamentsSummaryHtml = tournaments.renderArenaTournamentsSummaryHtml({
    db,
    publicDir,
    projectMeta,
    profileSlugs,
  });

  const arenaContent = renderTemplate(ARENA_TEMPLATE, {
    blurbHtml,
    ladderSummaryRows: ladderSummaryRows.join(''),
    tournamentsSummaryHtml,
  });

  const arenaHtml = renderer.render({
    id: 'arena',
    title: 'Arena | pkmn.ai',
    header: header('Arena'),
    path: '/arena/',
    style: ARENA_STYLE,
    content: arenaContent,
  });

  return {
    arenaHtml,
    ladderHtmlBySlot,
    standingsJson: {
      updatedAt: nowSec,
      ladders: jsonLadders,
    },
  };
}

function renderLiveSlotCard(
  key: 'p1' | 'p2',
  slotData: arena.LiveSlot,
  live: arena.LiveMatch,
  nowSec: number,
  publicDir: string,
  projectMeta: ReadonlyMap<string, ProjectMeta>
): string {
  const isRunning = live.activeSlot === key;
  const otherKey = key === 'p1' ? 'p2' : 'p1';
  const elapsed = isRunning ? Math.max(0, nowSec - live.turnStartedAt) : 0;
  const budget = isRunning
    ? Math.round(live.turnBudgetSeconds)
    : Math.round(slotData.bankSeconds);
  const bank = isRunning
    ? Math.max(0, Math.round(slotData.bankSeconds - elapsed))
    : Math.round(slotData.bankSeconds);
  const inc = Math.round(live.incrementSeconds);
  const ramPct = ((slotData.ram / 14336) * 100).toFixed(1);
  const href = resolveAgentHref(publicDir, projectMeta, slotData.slug, slotData.name);
  const agentHtml = `${formatAgentLink(slotData.name, href, true)} ` +
    `<code>${escapeHtml(slotData.version)}</code>`;

  const badge = isRunning
    ? `<span class="state-running" id="state-${key}" ` +
      'title="Currently executing (SIGCONT)">&#9679; RUNNING</span>'
    : `<span class="state-paused" id="state-${key}" ` +
      `title="Frozen by kernel SIGSTOP while ${otherKey} computes">PAUSED</span>`;

  const timerTitle =
    `Pokémon Showdown RoomBattleTimer: 150s max bank (+60s Turn 1 grace), +${inc}s/turn`;

  const turnCls = isRunning ? 'yes' : 'muted';
  const ramText = `${Math.round(slotData.ram).toLocaleString('en-US')} MiB`;
  return `<div class="slot-card ${isRunning ? 'running' : 'paused'}" id="slot-${key}">
    <div class="slot-top">
      <span><tt>${key}</tt> ${agentHtml}</span>
      ${badge}
    </div>
    <div class="slot-timers" title="${escapeHtml(timerTitle)}">
      <span>Turn: <strong id="turn-${key}" class="${turnCls}">${elapsed}s</strong> ` +
        `<span class="muted">/ ${budget}s</span></span>
      <span>Bank: <strong id="bank-${key}">${bank}s</strong> ` +
        `<span class="muted">(+${inc}s/turn)</span></span>
    </div>
    <div class="slot-telemetry">
      <span>Last: <tt>${Math.round(slotData.lastTurnMillis)} ms</tt></span>
      <span>Mean: <tt>${Math.round(slotData.meanTurnMillis)} ms/turn</tt></span>
      <span title="XNU ri_phys_footprint (14 GiB limit)">RAM: ` +
        `<tt>${ramText}</tt> (${ramPct}%)</span>
    </div>
  </div>`;
}

function renderLivePanelInner(
  liveDoc: arena.LiveDocument | undefined,
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
  const fmtTitle = FORMAT_TITLES[l.format] ?? l.format;
  let g1Html = '';
  if (l.game1Summary) {
    const g1Res = l.game1Summary.winnerSlot === 'p1'
      ? `${escapeHtml(l.p1.name)} 1–0`
      : l.game1Summary.winnerSlot === 'p2'
        ? `${escapeHtml(l.p2.name)} 1–0`
        : 'Tie';
    g1Html = ` <span class="muted">(<tt>G1</tt>: ${g1Res}, ${l.game1Summary.turns} turns)</span>`;
  }
  const hbAge = Math.max(0, nowSec - liveDoc.updatedAt);
  const gameText = `<strong>Game ${l.game} / 2</strong>, Turn ${l.turn}${g1Html}`;

  return `<div class="live-header">
    <span>
      <code>${escapeHtml(l.matchId)}</code> · <tt>${escapeHtml(fmtTitle)}</tt> · ${gameText}
    </span>
    <span class="muted">
      Heartbeat <tt>#${l.heartbeatSeq}</tt> (<tt id="hb-age">${hbAge}s</tt> ago)
    </span>
  </div>
  <div class="slots-grid">
    ${renderLiveSlotCard('p1', l.p1, l, nowSec, publicDir, projectMeta)}
    ${renderLiveSlotCard('p2', l.p2, l, nowSec, publicDir, projectMeta)}
  </div>`;
}

function renderMatchOutcomeDisplay(cat: db.RecentMatchView['category']): {
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
  db: db.Database;
  renderer: Renderer;
  publicDir: string;
  projectMeta: ReadonlyMap<string, ProjectMeta>;
  liveDoc?: arena.LiveDocument;
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
      <label for="bf-${slotEsc}">${escapeHtml(l.name)}</label>
    </li>`;
  }).join('\n    ');

  const agentLinks: Record<string, string> = {};
  for (const s of db.getProjectArenaSummaries()) {
    const href = resolveAgentHref(publicDir, projectMeta, s.slug, s.name);
    if (href) agentLinks[s.slug] = href;
  }
  for (const m of recentMatches) {
    for (const side of [m.p1, m.p2]) {
      if (!agentLinks[side.slug]) {
        const href = resolveAgentHref(publicDir, projectMeta, side.slug, side.name);
        if (href) agentLinks[side.slug] = href;
      }
    }
  }
  if (liveDoc?.live) {
    for (const side of [liveDoc.live.p1, liveDoc.live.p2]) {
      if (!agentLinks[side.slug]) {
        const href = resolveAgentHref(publicDir, projectMeta, side.slug, side.name);
        if (href) agentLinks[side.slug] = href;
      }
    }
  }

  const historyRows = recentMatches.length === 0
    ? '<tr class="empty-row"><td colspan="6" class="center muted">' +
      'No completed battles yet.</td></tr>'
    : recentMatches.map(m => {
      const r = renderMatchOutcomeDisplay(m.category);
      const p1Href = agentLinks[m.p1.slug];
      const p2Href = agentLinks[m.p2.slug];
      const p1Cell = `${formatAgentLink(m.p1.name, p1Href, r.p1Win)} ` +
        `<code>${escapeHtml(m.p1.version)}</code>`;
      const p2Cell = `${formatAgentLink(m.p2.name, p2Href, r.p2Win)} ` +
        `<code>${escapeHtml(m.p2.version)}</code>`;

      const b1 = Math.round(Math.min(m.p1Game1BankSeconds, m.p1Game2BankSeconds));
      const b2 = Math.round(Math.min(m.p2Game1BankSeconds, m.p2Game2BankSeconds));
      const tip =
        `${m.category} · ${Math.round(m.p1MeanTurnMillis)}ms/` +
        `${Math.round(m.p2MeanTurnMillis)}ms · Bank ${b1}s/${b2}s · RAM ` +
        `${Math.round(m.p1PeakRam).toLocaleString('en-US')}M/` +
        `${Math.round(m.p2PeakRam).toLocaleString('en-US')}M`;

      const idEsc = escapeHtml(m.id);
      const rel = formatRelativeTime(nowSec, m.completedAt);
      return `<tr id="${idEsc}" data-fmt="${escapeHtml(m.slot)}">
        <td><a href="#${idEsc}" class="subtle"><code>${idEsc}</code></a></td>
        <td>${p1Cell}</td>
        <td>${p2Cell}</td>
        <td class="center" title="${escapeHtml(tip)}">${r.html}</td>
        <td class="num">${m.game1Turns} / ${m.game2Turns}</td>
        <td class="num muted" data-ts="${m.completedAt}">${rel}</td>
      </tr>`;
    }).join('\n        ');

  const initialState: arena.LiveDocument = liveDoc ?? {
    updatedAt: nowSec,
    stale: false,
    recentMatches,
  };

  const content = renderTemplate(BATTLES_TEMPLATE, {
    formatFilterItems,
    livePanelInner: renderLivePanelInner(liveDoc, nowSec, publicDir, projectMeta),
    historyRows,
    initialLiveJson: safeInlineJson(initialState),
    agentLinksJson: safeInlineJson(agentLinks),
    formatTitlesJson: safeInlineJson(FORMAT_TITLES),
  });

  return renderer.render({
    id: 'battles',
    title: 'Arena — Battles | pkmn.ai',
    header: header('<a href="/arena/" class="subtle">Battles</a>'),
    path: '/arena/battles/',
    style: ARENA_STYLE,
    content,
  });
}

function readExistingLiveJson(publicDir: string): arena.LiveDocument | undefined {
  const filePath = path.join(publicDir, 'api', 'live.json');
  if (!fs.existsSync(filePath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as arena.LiveDocument;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {}
  return undefined;
}

// Statically pre-renders all public Arena HTML + JSON surfaces (`/arena/`, `/arena/ladders/*`,
// `/arena/battles/`, `/arena/tournaments/*`, `/projects/<slug>/`, and `/projects/`) atomically to
// `public/` after every completed match or submission status change so Nginx serves spectator
// traffic directly from disk without hitting Node or SQLite.
export function renderArenaPages(options: Options) {
  const publicDir = options.publicDir ?? PUBLIC_DIR;
  const staticDir = options.staticDir ?? STATIC_DIR;
  const nowSec = options.now ?? Math.floor(Date.now() / 1000);
  const recentMatchesLimit = options.recentMatchesLimit ?? 50;

  const renderer = options.renderer ?? (
    publicDir === PUBLIC_DIR
      ? siteRenderer
      : new Renderer({
        public: publicDir,
        analytics: 'G-LQ8TW28Z7Q',
        description: 'The home of competitive Pokémon artificial intelligence',
        url: 'https://pkmn.ai',
        stylesheet: path.join(staticDir, 'index.css'),
        highlight: true,
      })
  );

  const projectMeta = loadProjectMetaMap(staticDir);
  const profileAgents = options.db.getAllActiveAgents();
  const profileSlugs = new Set(profileAgents.map(a => a.slug));
  const recentBattles = options.db.getRecentMatches(recentMatchesLimit);
  const renderedBattleIds = new Set(recentBattles.map(m => m.id));

  renderAgentProfiles({
    db: options.db,
    renderer,
    publicDir,
    avatarsDir: options.avatarsDir,
    projectMeta,
    profileAgents,
    profileSlugs,
    renderedBattleIds,
    nowSec,
  });

  const summaries = options.db.getProjectArenaSummaries();
  const arenaByName = new Map<string, projects.ArenaInfo>();
  for (const s of summaries) {
    const profileHref = `/projects/${encodeURIComponent(s.slug)}/`;
    arenaByName.set(s.name, {
      slug: s.slug,
      name: s.name,
      profileHref,
      bestRank: s.bestRank,
      bestLcb: s.bestLcb,
      ladders: s.ladders.map(b => ({
        slot: b.slot,
        name: b.ladderName,
        rank: b.rank,
        provisional: b.provisional,
      })),
    });
  }

  const projectsPage = projects.page(staticDir, arenaByName);
  const projectsHtml = renderer.render({id: 'projects', ...projectsPage});
  writeFileAtomic(path.join(publicDir, 'projects', 'index.html'), projectsHtml);

  const {arenaHtml, ladderHtmlBySlot, standingsJson} = renderArenaAndLadderArtifacts({
    db: options.db,
    renderer,
    publicDir,
    staticDir,
    projectMeta,
    profileSlugs,
    nowSec,
  });
  writeFileAtomic(path.join(publicDir, 'arena', 'index.html'), arenaHtml);
  writeFileAtomic(
    path.join(publicDir, 'arena', 'index.json'),
    `${JSON.stringify(standingsJson, undefined, 2)}\n`
  );

  const laddersDir = path.join(publicDir, 'arena', 'ladders');
  fs.mkdirSync(laddersDir, {recursive: true});
  const validSlots = new Set(Object.keys(ladderHtmlBySlot));
  for (const entry of fs.readdirSync(laddersDir, {withFileTypes: true})) {
    if (entry.isDirectory() && !validSlots.has(entry.name)) {
      fs.rmSync(path.join(laddersDir, entry.name), {recursive: true, force: true});
    }
  }
  for (const [slot, ladderHtml] of Object.entries(ladderHtmlBySlot)) {
    writeFileAtomic(path.join(laddersDir, slot, 'index.html'), ladderHtml);
    writeFileAtomic(
      path.join(laddersDir, slot, 'index.json'),
      `${JSON.stringify(standingsJson.ladders[slot], undefined, 2)}\n`
    );
  }

  const liveJsonPath = path.join(publicDir, 'api', 'live.json');
  const hasExplicitLiveDoc = Object.prototype.hasOwnProperty.call(options, 'liveDoc');
  const liveDoc = hasExplicitLiveDoc
    ? options.liveDoc
    : readExistingLiveJson(publicDir);
  if (hasExplicitLiveDoc || !fs.existsSync(liveJsonPath)) {
    const docToWrite: arena.LiveDocument = liveDoc ?? {
      updatedAt: nowSec,
      stale: false,
      recentMatches: recentBattles,
    };
    writeFileAtomic(liveJsonPath, `${JSON.stringify(docToWrite)}\n`);
  }
  const battlesHtml = renderBattlesPage({
    db: options.db,
    renderer,
    publicDir,
    projectMeta,
    liveDoc,
    recentMatchesLimit,
    nowSec,
  });
  writeFileAtomic(path.join(publicDir, 'arena', 'battles', 'index.html'), battlesHtml);

  const hasExplicitBroadcast = Object.prototype.hasOwnProperty.call(
    options,
    'tournamentBroadcast'
  );
  tournaments.renderTournamentsPages({
    db: options.db,
    renderer,
    publicDir,
    projectMeta,
    profileSlugs,
    tournamentBroadcast: options.tournamentBroadcast,
    includeDiskBroadcast: !hasExplicitBroadcast,
  });
}
