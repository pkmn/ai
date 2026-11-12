import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

import {Team} from '@pkmn/sets';
import polka from 'polka';
import * as site from 'site';
import * as yaml from 'yaml';

import {AVATARS_DIR} from '../db';
import type * as db from '../db';
import {
  Renderer,
  header,
  injectLiveBanner,
  renderer as siteRenderer,
} from '../static/build';
import * as projects from '../static/projects';
import {escapeHtml, renderTemplate, root} from '../static/util';
import {getDex, hashTeam} from '../teams';

import * as arena from './arena';
import {renderAgentProfile, resolveAgentLogo} from './profile';
import * as ratings from './ratings';
import * as tournaments from './tournaments';

export const PUBLIC_DIR = root('public');
export const STATIC_DIR = process.env.MOCK === '1' ? root('.mock', 'static') : root('static');

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
  gen9championsvgc2026regmd: '[Gen 9 Champions] VGC 2026 Reg M-D',
  gen9championsvgc2026regmdbo3: '[Gen 9 Champions] VGC 2026 Reg M-D (Bo3)',
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
  team: db.TeamMode;
  status: db.LadderStatus;
  archivedAt?: number;
  archiveHref?: string;
  teamsHref?: string;
  standings: StandingsEntry[];
}

export interface LadderPairingSummary {
  lowSlug?: string;
  lowName?: string;
  lowVersion?: string;
  highSlug?: string;
  highName?: string;
  highVersion?: string;
  ww: number;
  wt: number;
  split: number;
  tl: number;
  ll: number;
  matches: number;
  lowLos?: number;
}

export interface LadderSnapshotPoint {
  dayUtc: string;
  slug: string;
  name: string;
  version: string;
  elo: number;
  se: number;
  lcb: number;
  matches: number;
}

export interface LadderDocument extends StandingsLadder {
  pairings: LadderPairingSummary[];
  snapshots: LadderSnapshotPoint[];
}

export interface ArchivedLadderSummary {
  id: string;
  slot: db.LadderSlot;
  name: string;
  format: string;
  team: db.TeamMode;
  status: 'settling' | 'archived';
  archivedAt?: number;
  href: string;
  archiveHref?: string;
  teamsHref?: string;
  winner?: {
    slug: string;
    name: string;
    version: string;
    elo: number;
    ci95: number;
    gxe: number;
    wins: number;
    losses: number;
    ties: number;
  };
}

export interface ArenaTournamentSummary {
  id: string;
  name: string;
  format: string;
  status: db.TournamentStatus;
  startsAt: number;
  closesAt: number;
  completedAt?: number;
  href: string;
  archiveHref?: string;
  winner?: {
    slug: string;
    name: string;
    version: string;
    elo: number;
    ci95: number;
    points: number;
    wins: number;
    losses: number;
    ties: number;
  };
}

export interface StandingsDocument {
  updatedAt: number;
  ladders: Record<string, StandingsLadder>;
  archivedLadders: ArchivedLadderSummary[];
  tournaments: ArenaTournamentSummary[];
}

export interface LadderTeamsDocument {
  ladderId: string;
  name: string;
  format: string;
  archivedAt?: number;
  entrants: Array<{
    slug: string;
    name: string;
    submittedAt: number;
    teams: Array<{
      index: number;
      hash: string;
      packed: string;
      paste: string;
    }>;
  }>;
}

export interface Options {
  db: db.Database;
  arena: arena.Handle;
  renderer?: Renderer;
  publicDir?: string;
  staticDir?: string;
  avatarsDir?: string;
  recentMatchesLimit?: number;
  now?: () => number;
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

// Full battle logs (containing unpacked team sheets, real agent identities, and telemetry) are
// published exclusively for competitor team-pool (`pools`) ladders strictly AFTER the ladder has
// been retired (`status === 'archived'`).
export function resolveLadderArchive(
  publicDir: string,
  ladder: Pick<db.LadderRow, 'id' | 'team' | 'status'>
): {name: string; href: string} | undefined {
  if (ladder.team !== 'pools' || ladder.status !== 'archived') return undefined;
  const idEnc = encodeURIComponent(ladder.id);
  const defaultName = `${ladder.id}-logs.7z`;
  const candidates = [
    {
      diskPath: path.join(publicDir, 'arena', 'ladders', ladder.id, defaultName),
      name: defaultName,
      href: `/arena/ladders/${idEnc}/${encodeURIComponent(defaultName)}`,
    },
    {
      diskPath: path.join(publicDir, 'arena', 'ladders', ladder.id, 'logs.7z'),
      name: 'logs.7z',
      href: `/arena/ladders/${idEnc}/logs.7z`,
    },
  ];
  for (const c of candidates) {
    if (fs.existsSync(c.diskPath)) return {name: c.name, href: c.href};
  }
  return undefined;
}

function buildLadderTeamsDocument(
  db: db.Database,
  ladder: db.LadderRow
): LadderTeamsDocument {
  const dex = getDex(ladder.format);
  const roster = db.getActiveRosterForLadder(ladder.id);
  return {
    ladderId: ladder.id,
    name: ladder.name,
    format: ladder.format,
    archivedAt: ladder.archivedAt,
    entrants: roster.map(r => ({
      slug: r.agentSlug,
      name: r.agentName,
      submittedAt: r.submittedAt,
      teams: r.teams.map(t => ({
        index: t.index,
        hash: hashTeam(t.packed),
        packed: t.packed,
        paste: Team.unpack(t.packed, dex)?.export() ?? '',
      })),
    })),
  };
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
  pairs: db.PairAggregateRow[],
  ladderStatus?: db.LadderStatus
): Map<number, number> {
  const ranked = entries
    .filter(e => (
      ladderStatus === 'archived'
        ? e.rankCurrent !== undefined
        : (e.role === 'champion' || e.role === 'challenger') && e.rankCurrent !== undefined
    ))
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
  const isArchived = ladder.status === 'archived';
  const hasFrozenRanked = isArchived && entries.some(e => e.rankCurrent !== undefined);
  const bestActiveByAgent = new Map<number, db.LeaderboardEntryView>();
  for (const e of entries) {
    if (isArchived) {
      if (hasFrozenRanked && e.rankCurrent === undefined) continue;
    } else if (e.role !== 'champion' && e.role !== 'challenger') {
      continue;
    }
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

  const endRefSec = isArchived ? (ladder.archivedAt ?? nowSec) : nowSec;
  const todayUtc = new Date(endRefSec * 1000).toISOString().slice(0, 10);
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
    const endLabel = isArchived ? escapeHtml(formatShortDay(todayUtc)) : 'Today';
    xLabels.push(`<text x="${xRight}" y="234">${endLabel}</text>`);
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
      const label = !isArchived && bestDay === todayUtc && bestDay === allDays[allDays.length - 1]
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
  profileSlugs: ReadonlySet<string>,
  ladderStatus?: db.LadderStatus
): {html: string; isEmpty: boolean} {
  const isArchived = ladderStatus === 'archived';
  const ranked = entries
    .filter(e => (
      isArchived
        ? e.rankCurrent !== undefined
        : (e.role === 'champion' || e.role === 'challenger') && e.rankCurrent !== undefined
    ))
    .sort((a, b) => a.rankCurrent! - b.rankCurrent!)
    .slice(0, 20);

  let participants = ranked;
  if (participants.length < 2) {
    if (isArchived) {
      const seenAgent = new Set<number>();
      participants = [];
      for (const e of entries) {
        if (e.matches <= 0 || seenAgent.has(e.agentId)) continue;
        seenAgent.add(e.agentId);
        participants.push(e);
        if (participants.length >= 20) break;
      }
    } else {
      participants = entries
        .filter(e => e.role === 'champion' && e.matches > 0)
        .slice(0, 20);
    }
  }

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

function renderSingleLadderArtifact(opts: {
  ladder: db.LadderRow;
  currentLadders: db.LadderRow[];
  urlKey: string;
  db: db.Database;
  renderer: Renderer;
  publicDir: string;
  projectMeta: ReadonlyMap<string, ProjectMeta>;
  profileSlugs: ReadonlySet<string>;
  nowSec: number;
}): {
  html: string;
  standingsLadder: StandingsLadder;
  ladderDoc: LadderDocument;
  top1SummaryCells?: string;
  top1Entry?: StandingsEntry;
  hasActiveEntries: boolean;
} {
  const {
    ladder: l,
    currentLadders,
    urlKey,
    db,
    renderer,
    publicDir,
    projectMeta,
    profileSlugs,
    nowSec,
  } = opts;
  const entries = db.getLeaderboardEntries(l.id);
  const pairs = db.getPairAggregatesForLadder(l.id);
  const snapshots = db.getRatingSnapshotsForLadder(l.id);
  const adjacentLos = computeAdjacentLosMap(entries, pairs, l.status);
  const isArchived = l.status === 'archived';
  const isPastSeason = l.status === 'settling' || l.status === 'archived';
  const hasFrozenRanked = isArchived && entries.some(e => e.rankCurrent !== undefined);

  let formatNavItems = currentLadders.map((other, idx) => {
    const sep = idx > 0 ? '\n    —\n    ' : '';
    const href = `/arena/ladders/${encodeURIComponent(other.slot)}/`;
    const isCurrent = !isPastSeason && other.slot === l.slot;
    const label = isCurrent
      ? `<strong>${escapeHtml(other.name)}</strong>`
      : escapeHtml(other.name);
    const curAttr = isCurrent ? ' aria-current="page"' : '';
    return `${sep}<li id="${escapeHtml(other.slot)}">` +
      `<a href="${escapeHtml(href)}" class="subtle"${curAttr}>${label}</a></li>`;
  }).join('');
  if (isPastSeason) {
    const selfHref = `/arena/ladders/${encodeURIComponent(l.id)}/`;
    const sep = formatNavItems ? '\n    —\n    ' : '';
    formatNavItems += `${sep}<li id="${escapeHtml(l.id)}">` +
      `<a href="${escapeHtml(selfHref)}" class="subtle" aria-current="page">` +
      `<strong>${escapeHtml(l.name)}</strong></a> ` +
      `<span class="muted">(${escapeHtml(l.status)})</span></li>`;
  }

  const seenPrimaryAgent = new Set<number>();
  const seenAnyAgent = new Set<number>();
  const jsonRows: StandingsEntry[] = [];
  let top1SummaryCells: string | undefined;
  let top1Entry: StandingsEntry | undefined;
  let standingsPane: string;

  if (entries.length === 0) {
    const msg = l.status === 'upcoming'
      ? `${escapeHtml(l.name)} ladder is upcoming — accepting initial entries before matchmaking ` +
        'begins.'
      : isArchived
        ? `${escapeHtml(l.name)} archived with no completed entries.`
        : `No active entries on ${escapeHtml(l.name)} yet.`;
    standingsPane = `<p class="empty-state muted">${msg}</p>`;
  } else {
    const rowsHtml = entries.map(e => {
      const isFirstForAgent = !seenAnyAgent.has(e.agentId);
      if (isFirstForAgent) seenAnyAgent.add(e.agentId);

      const isEffectiveActive = isArchived
        ? (hasFrozenRanked ? e.rankCurrent !== undefined : isFirstForAgent)
        : (e.role === 'champion' || e.role === 'challenger');
      const isRetired = !isEffectiveActive;
      const isProvisional = isEffectiveActive && (e.matches < 10 || e.se > 60);
      const isBestActive = isEffectiveActive && !seenPrimaryAgent.has(e.agentId);
      if (isBestActive) seenPrimaryAgent.add(e.agentId);
      const isBestOverall = isBestActive || (isArchived && isFirstForAgent);
      const isSecondaryActive = isEffectiveActive && !isBestActive;
      const isRankedPrimary =
        isEffectiveActive && !isProvisional && isBestActive && e.rankCurrent !== undefined;

      const classes: string[] = [];
      const dataAttrs: string[] = [];
      let rowTitle = '';

      if (isRetired) {
        classes.push('secondary', 'hide');
        dataAttrs.push('data-retired="true"');
        if (isBestOverall) dataAttrs.push('data-best="true"');
      } else {
        dataAttrs.push('data-active="true"');
        if (isBestOverall) dataAttrs.push('data-best="true"');
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

      const entryObj: StandingsEntry = {
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
      };
      jsonRows.push(entryObj);

      if (isRankedPrimary && e.rankCurrent === 1 && top1SummaryCells === undefined) {
        top1SummaryCells = `${agentCell}${eloCell}${gxeCell}${wltCell}${streakCell}${losCell}`;
        top1Entry = entryObj;
      }

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

  const archive = resolveLadderArchive(publicDir, l);
  const urlEnc = encodeURIComponent(urlKey);
  const teamsHref = l.team === 'pools' && l.status === 'archived'
    ? `/arena/ladders/${urlEnc}/teams.json`
    : undefined;
  const jsonHref = `/arena/ladders/${urlEnc}/index.json`;

  let ladderArchiveHtml = '';
  if (l.team === 'pools' && l.status === 'archived') {
    if (archive) {
      ladderArchiveHtml = '\n  <p class="battle-note muted">Retired season archive: ' +
        `<a href="${escapeHtml(archive.href)}" class="subtle">` +
        `<code>${escapeHtml(archive.name)}</code></a> ` +
        '(full Showdown battle logs &amp; unpacked teams) · ' +
        `<a href="${escapeHtml(teamsHref!)}" class="subtle"><code>teams.json</code></a> · ` +
        `<a href="${escapeHtml(jsonHref)}" class="subtle"><code>index.json</code></a></p>`;
    } else {
      ladderArchiveHtml = '\n  <p class="battle-note muted">Retired season data: ' +
        `<a href="${escapeHtml(teamsHref!)}" class="subtle"><code>teams.json</code></a> · ` +
        `<a href="${escapeHtml(jsonHref)}" class="subtle"><code>index.json</code></a> · ` +
        `full battle log archive (<code>${escapeHtml(`${l.id}-logs.7z`)}</code>) ` +
        'pending upload.</p>';
    }
  } else if (l.team === 'pools' && l.status === 'settling') {
    ladderArchiveHtml = '\n  <p class="battle-note muted">Season settling — full battle log ' +
      `archive (<code>${escapeHtml(`${l.id}-logs.7z`)}</code>) and <code>teams.json</code> ` +
      'will be published once remaining provisional entries settle and the ladder is retired.</p>';
  }

  const historyRes = renderHistorySectionHtml(l, entries, snapshots, nowSec);
  const matchupsRes = renderMatchupsSectionHtml(
    entries,
    pairs,
    publicDir,
    projectMeta,
    profileSlugs,
    l.status
  );

  const ladderContent = renderTemplate(LADDER_TEMPLATE, {
    formatNavItems,
    standingsPane,
    ladderArchiveHtml,
    historyInitialClass: historyRes.isEmpty ? ' class="hide"' : '',
    historyPane: historyRes.html,
    matchupsInitialClass: matchupsRes.isEmpty ? ' class="hide"' : '',
    matchupsPane: matchupsRes.html,
  });

  const liveTournament = db.getRunningTournament();
  const ladderHeader = injectLiveBanner(
    header('<a href="/arena/" class="subtle">Ladders</a>'),
    liveTournament
  );
  const html = renderer.render({
    id: 'leaderboard',
    title: `Arena — ${l.name} | pkmn.ai`,
    header: ladderHeader,
    path: `/arena/ladders/${urlKey}/`,
    style: ARENA_STYLE,
    content: ladderContent,
  });

  const entryByVer = new Map(entries.map(e => [e.versionId, e]));
  const standingsLadder: StandingsLadder = {
    id: l.id,
    slot: l.slot,
    name: l.name,
    format: l.format,
    team: l.team,
    status: l.status,
    archivedAt: l.archivedAt,
    archiveHref: archive?.href,
    teamsHref,
    standings: jsonRows,
  };

  const ladderDoc: LadderDocument = {
    ...standingsLadder,
    pairings: pairs.map(p => {
      const low = entryByVer.get(p.lowVersionId);
      const high = entryByVer.get(p.highVersionId);
      return {
        lowSlug: low?.agentSlug,
        lowName: low?.agentName,
        lowVersion: low?.version,
        highSlug: high?.agentSlug,
        highName: high?.agentName,
        highVersion: high?.version,
        ww: p.ww,
        wt: p.wt,
        split: p.split,
        tl: p.tl,
        ll: p.ll,
        matches: p.ww + p.wt + p.split + p.tl + p.ll,
        lowLos: p.lowLos !== undefined ? Math.round(p.lowLos * 1000) / 10 : undefined,
      };
    }),
    snapshots: snapshots.map(s => ({
      dayUtc: s.dayUtc,
      slug: s.agentSlug,
      name: s.agentName,
      version: s.version,
      elo: Math.round(s.elo),
      se: Math.round(s.se * 10) / 10,
      lcb: Math.round(s.lcb),
      matches: s.matches,
    })),
  };

  return {
    html,
    standingsLadder,
    ladderDoc,
    top1SummaryCells,
    top1Entry,
    hasActiveEntries: entries.some(e => e.role === 'champion' || e.role === 'challenger'),
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
  ladderJsonBySlot: Record<string, LadderDocument>;
  archivedLadderHtmlById: Record<string, string>;
  archivedLadderJsonById: Record<string, LadderDocument>;
  archivedTeamsJsonById: Record<string, LadderTeamsDocument>;
  standingsJson: StandingsDocument;
} {
  const {db, renderer, publicDir, staticDir, projectMeta, profileSlugs, nowSec} = opts;
  const ladders = db.getCurrentLadders();
  const pastLadders = db.getLadders().filter(
    l => l.status === 'settling' || l.status === 'archived'
  );

  const ladderHtmlBySlot: Record<string, string> = {};
  const ladderJsonBySlot: Record<string, LadderDocument> = {};
  const archivedLadderHtmlById: Record<string, string> = {};
  const archivedLadderJsonById: Record<string, LadderDocument> = {};
  const archivedTeamsJsonById: Record<string, LadderTeamsDocument> = {};
  const jsonLadders: Record<string, StandingsLadder> = {};
  const archivedLadderSummaries: ArchivedLadderSummary[] = [];
  const ladderSummaryRows: string[] = [];

  for (const l of ladders) {
    const rendered = renderSingleLadderArtifact({
      ladder: l,
      currentLadders: ladders,
      urlKey: l.slot,
      db,
      renderer,
      publicDir,
      projectMeta,
      profileSlugs,
      nowSec,
    });
    ladderHtmlBySlot[l.slot] = rendered.html;
    ladderJsonBySlot[l.slot] = rendered.ladderDoc;
    jsonLadders[l.slot] = rendered.standingsLadder;

    const fmtTitle = FORMAT_TITLES[l.format] ?? l.format;
    const ladderHref = `/arena/ladders/${encodeURIComponent(l.slot)}/`;
    const ladderCell =
      `<td><a href="${escapeHtml(ladderHref)}" class="subtle" ` +
      `title="${escapeHtml(fmtTitle)}"><strong><tt>${escapeHtml(l.name)}</tt></strong>` +
      '</a></td>';

    if (rendered.top1SummaryCells !== undefined) {
      ladderSummaryRows.push(`<tr>${ladderCell}${rendered.top1SummaryCells}</tr>`);
    } else {
      const stateLabel = l.status === 'upcoming'
        ? 'Upcoming'
        : rendered.hasActiveEntries
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
  }

  const pastSeasonRows: string[] = [];
  for (const l of pastLadders) {
    if (l.team === 'pools' && l.status === 'archived') {
      archivedTeamsJsonById[l.id] = buildLadderTeamsDocument(db, l);
    }
    const rendered = renderSingleLadderArtifact({
      ladder: l,
      currentLadders: ladders,
      urlKey: l.id,
      db,
      renderer,
      publicDir,
      projectMeta,
      profileSlugs,
      nowSec,
    });
    archivedLadderHtmlById[l.id] = rendered.html;
    archivedLadderJsonById[l.id] = rendered.ladderDoc;

    const href = `/arena/ladders/${encodeURIComponent(l.id)}/`;
    const archiveHref = rendered.standingsLadder.archiveHref;
    const teamsHref = rendered.standingsLadder.teamsHref;
    const w = rendered.top1Entry;

    archivedLadderSummaries.push({
      id: l.id,
      slot: l.slot,
      name: l.name,
      format: l.format,
      team: l.team,
      status: l.status as 'settling' | 'archived',
      archivedAt: l.archivedAt,
      href,
      archiveHref,
      teamsHref,
      winner: w
        ? {
          slug: w.slug,
          name: w.name,
          version: w.version,
          elo: w.elo,
          ci95: w.ci95,
          gxe: w.gxe,
          wins: w.wins,
          losses: w.losses,
          ties: w.ties,
        }
        : undefined,
    });

    const fmtTitle = FORMAT_TITLES[l.format] ?? l.format;
    const seasonCell =
      `<td><a href="${escapeHtml(href)}" class="subtle" ` +
      `title="${escapeHtml(fmtTitle)}"><strong><tt>${escapeHtml(l.name)}</tt></strong>` +
      '</a></td>';
    const dlLinks: string[] = [];
    if (archiveHref) {
      const archiveName = path.basename(archiveHref);
      dlLinks.push(
        `<a href="${escapeHtml(archiveHref)}" class="subtle">` +
        `<code>${escapeHtml(archiveName)}</code></a>`
      );
    }
    if (teamsHref) {
      dlLinks.push(`<a href="${escapeHtml(teamsHref)}" class="subtle"><code>teams.json</code></a>`);
    }
    const statusText = l.status === 'settling' ? 'Settling' : 'Archived';
    const statusCell = dlLinks.length > 0
      ? `<td><span class="muted">${statusText}</span> · ${dlLinks.join(' · ')}</td>`
      : `<td class="muted">${statusText}</td>`;

    if (w) {
      const wHref = resolveAgentHref(publicDir, projectMeta, w.slug, w.name, profileSlugs);
      const wLink = formatAgentLink(w.name, wHref, true);
      pastSeasonRows.push(
        `<tr>${seasonCell}${statusCell}` +
        `<td>${wLink} <code>${escapeHtml(w.version)}</code></td>` +
        `<td class="num"><strong>${w.elo}</strong> <span class="muted">±${w.ci95}</span></td>` +
        `<td class="num">${w.gxe.toFixed(1)}%</td>` +
        `<td class="num">${w.wins}–${w.losses}–${w.ties}</td></tr>`
      );
    } else {
      pastSeasonRows.push(
        `<tr>${seasonCell}${statusCell}` +
        '<td class="muted">—</td>' +
        '<td class="num muted">—</td>' +
        '<td class="num muted">—</td>' +
        '<td class="num muted">—</td></tr>'
      );
    }
  }

  const pastSeasonsSectionHtml = pastSeasonRows.length > 0
    ? `\n<section id="seasons">
  <h3><a href="#seasons" class="subtle">Past Seasons</a></h3>
  <div class="table-wrap">
    <table class="standings-table">
      <thead>
        <tr>
          <th>Season</th>
          <th>Status</th>
          <th>Champion</th>
          <th class="num">Elo</th>
          <th class="num">GXE</th>
          <th class="num">W–L–T</th>
        </tr>
      </thead>
      <tbody>${pastSeasonRows.join('')}</tbody>
    </table>
  </div>
</section>\n`
    : '';

  const tournamentSummaries: ArenaTournamentSummary[] = db.getTournaments().map(t => {
    const entrants = db.getTournamentEntrants(t.id);
    const top = entrants.find(e => e.finalRank === 1) ?? entrants[0];
    const archive = tournaments.resolveTournamentArchive(publicDir, t.id);
    return {
      id: t.id,
      name: t.name,
      format: t.format,
      status: t.status,
      startsAt: t.startsAt,
      closesAt: db.getTournamentClosesAt(t.startsAt),
      completedAt: t.completedAt,
      href: `/arena/tournaments/${encodeURIComponent(t.id)}/`,
      archiveHref: archive?.href,
      winner: top && t.status !== 'scheduled'
        ? {
          slug: top.agentSlug,
          name: top.agentName,
          version: top.version,
          elo: Math.round(top.elo),
          ci95: Math.round(1.96 * top.se),
          points: top.points,
          wins: top.gameWins,
          losses: top.gameLosses,
          ties: top.gameTies,
        }
        : undefined,
    };
  });

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
    pastSeasonsSectionHtml,
    tournamentsSummaryHtml,
  });

  const arenaHtml = renderer.render({
    id: 'arena',
    title: 'Arena | pkmn.ai',
    header: injectLiveBanner(header('Arena'), db.getRunningTournament()),
    path: '/arena/',
    style: ARENA_STYLE,
    content: arenaContent,
  });

  return {
    arenaHtml,
    ladderHtmlBySlot,
    ladderJsonBySlot,
    archivedLadderHtmlById,
    archivedLadderJsonById,
    archivedTeamsJsonById,
    standingsJson: {
      updatedAt: nowSec,
      ladders: jsonLadders,
      archivedLadders: archivedLadderSummaries,
      tournaments: tournamentSummaries,
    },
  };
}

function renderLiveSlotCard(
  key: 'p1' | 'p2',
  slotData: arena.LiveSlot,
  live: arena.LiveMatch,
  nowSec: number,
  publicDir: string,
  projectMeta: ReadonlyMap<string, ProjectMeta>,
  profileSlugs?: ReadonlySet<string>
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
  const href = resolveAgentHref(publicDir, projectMeta, slotData.slug, slotData.name, profileSlugs);
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
  let teamSpan = '';
  if (slotData.team) {
    const teamTip = slotData.team.startsWith('P1:')
      ? 'Known to Match P1 (drawn from P1 seasonal pool)'
      : slotData.team.startsWith('P2:')
        ? 'Known to Match P2 (drawn from P2 seasonal pool)'
        : 'Unknown to both players (drawn from a third-party competitor pool)';
    teamSpan = `\n      <span title="${escapeHtml(teamTip)}">Team: ` +
      `<code>${escapeHtml(slotData.team)}</code></span>`;
  }
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
        `<tt>${ramText}</tt> (${ramPct}%)</span>${teamSpan}
    </div>
  </div>`;
}

function renderLivePanelInner(
  liveDoc: arena.LiveDocument | undefined,
  nowSec: number,
  publicDir: string,
  projectMeta: ReadonlyMap<string, ProjectMeta>,
  profileSlugs?: ReadonlySet<string>
): string {
  if (!liveDoc?.live || liveDoc.stale) {
    const idleMsg = liveDoc?.stale
      ? 'No active heartbeat — Arena is offline or idle.'
      : 'No battle currently running — Arena is idle.';
    const tourSuffix = liveDoc?.runningTournament
      ? ` · <a href="${escapeHtml(liveDoc.runningTournament.href)}" class="subtle">` +
        `<strong>&#9679; Watch ${escapeHtml(liveDoc.runningTournament.name)} live</strong></a>`
      : '';
    return `<div class="live-idle muted">${idleMsg}${tourSuffix}</div>`;
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
    ${renderLiveSlotCard('p1', l.p1, l, nowSec, publicDir, projectMeta, profileSlugs)}
    ${renderLiveSlotCard('p2', l.p2, l, nowSec, publicDir, projectMeta, profileSlugs)}
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

function isAbnormalEndReason(reason: string): boolean {
  return Boolean(reason) &&
    reason !== 'normal' &&
    reason !== 'win' &&
    reason !== 'tie' &&
    reason !== 'turn_limit';
}

function formatEndReasonHtml(reason: string): {html: string; label: string; abnormal: boolean} {
  const norm = reason.trim().toLowerCase();
  if (!norm || norm === 'normal' || norm === 'win') {
    return {html: '<span class="muted">Normal</span>', label: 'Normal', abnormal: false};
  }
  if (norm === 'tie') {
    return {html: '<span class="muted">Tie</span>', label: 'Tie', abnormal: false};
  }
  if (norm === 'turn_limit') {
    return {html: '<span class="muted">Turn limit</span>', label: 'Turn limit', abnormal: false};
  }
  if (norm === 'timeout') {
    return {html: '<span class="no">Timeout</span>', label: 'Timeout', abnormal: true};
  }
  if (norm === 'crash') {
    return {html: '<span class="no">Crash</span>', label: 'Crash', abnormal: true};
  }
  if (norm === 'oom') {
    return {html: '<span class="no">OOM</span>', label: 'OOM', abnormal: true};
  }
  if (norm === 'forfeit') {
    return {html: '<span class="no">Forfeit</span>', label: 'Forfeit', abnormal: true};
  }
  if (norm === 'invalid_choice_3x') {
    return {
      html: '<span class="no">3&times; Invalid Choice</span>',
      label: '3x Invalid Choice',
      abnormal: true,
    };
  }
  return {
    html: `<span class="no">${escapeHtml(reason)}</span>`,
    label: reason,
    abnormal: true,
  };
}

function formatPoolTeamCode(
  label: string | undefined,
  p1Name: string,
  p2Name: string
): string {
  if (!label) return '<span class="muted">—</span>';
  let tip: string;
  if (label.startsWith('P1:')) {
    tip = `Known to P1 (${p1Name}) — drawn from ${p1Name}'s submitted seasonal pool ` +
      `(unknown to ${p2Name})`;
  } else if (label.startsWith('P2:')) {
    tip = `Known to P2 (${p2Name}) — drawn from ${p2Name}'s submitted seasonal pool ` +
      `(unknown to ${p1Name})`;
  } else {
    tip = 'Unknown to both players — drawn from a third-party competitor seasonal pool';
  }
  return `<code title="${escapeHtml(tip)}">${escapeHtml(label)}</code>`;
}

// Renders the inline expandable detail panel inside a battle history table row.
// Note on blind-pair seat swapping: in Game 1, Match P1 sits in Showdown slot `p1` with Team 1
// (`p1TeamLabel`) and Match P2 sits in slot `p2` with Team 2 (`p2TeamLabel`); in Game 2, the two
// agents swap seats (`p1` = Match P2 with Team 1, `p2` = Match P1 with Team 2) under the identical
// `@pkmn/sim` PRNG seed so simultaneous residual/switch ordering and speed-tie PRNG consumption
// stay coupled to the teams while canceling team matchup bias to first order.
export function renderBattleInlineDetailHtml(
  m: arena.BattleHistoryEntry,
  agentLinks: Readonly<Record<string, string>>
): string {
  const r = renderMatchOutcomeDisplay(m.category);
  const p1Href = agentLinks[m.p1.slug];
  const p2Href = agentLinks[m.p2.slug];
  const p1Bold = `${formatAgentLink(m.p1.name, p1Href, r.p1Win)} ` +
    `<code>${escapeHtml(m.p1.version)}</code>`;
  const p2Bold = `${formatAgentLink(m.p2.name, p2Href, r.p2Win)} ` +
    `<code>${escapeHtml(m.p2.version)}</code>`;
  const p1Plain = `${formatAgentLink(m.p1.name, p1Href, false)} ` +
    `<code>${escapeHtml(m.p1.version)}</code>`;
  const p2Plain = `${formatAgentLink(m.p2.name, p2Href, false)} ` +
    `<code>${escapeHtml(m.p2.version)}</code>`;

  const fmtTitle = FORMAT_TITLES[m.format] ?? m.format;
  const completedIso = new Date(m.completedAt * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const completedUtc = `${completedIso} UTC`;

  const end1 = formatEndReasonHtml(m.game1EndReason);
  const end2 = formatEndReasonHtml(m.game2EndReason);
  const faultLabels = [...new Set(
    [end1, end2].filter(e => e.abnormal).map(e => e.label)
  )];
  const faultBadgeHtml = faultLabels.length > 0
    ? ' <span class="no" title="Abnormal game termination">' +
      `[${escapeHtml(faultLabels.join(', '))}]</span>`
    : '';

  const showPools = m.teamMode === 'pools' || Boolean(m.p1TeamLabel || m.p2TeamLabel);
  const t1Code = formatPoolTeamCode(m.p1TeamLabel, m.p1.name, m.p2.name);
  const t2Code = formatPoolTeamCode(m.p2TeamLabel, m.p1.name, m.p2.name);
  const poolSummaryHtml = showPools
    ? '<div class="battle-detail-pool" title="12-char pkmn/teams SHA-256 short hashes; P1:/P2: ' +
      'prefix indicates a team submitted by that player in this match (at most one team per ' +
      `match can belong to either player)">Teams: Player 1 ${t1Code} · Player 2 ${t2Code}</div>`
    : '';

  const g1Winner = m.game1Outcome === 'W'
    ? `<strong>${escapeHtml(m.p1.name)}</strong> <span class="muted">(P1)</span>`
    : m.game1Outcome === 'L'
      ? `<strong>${escapeHtml(m.p2.name)}</strong> <span class="muted">(P2)</span>`
      : '<span class="muted">Tie</span>';
  const g2Winner = m.game2Outcome === 'W'
    ? `<strong>${escapeHtml(m.p1.name)}</strong> <span class="muted">(P1)</span>`
    : m.game2Outcome === 'L'
      ? `<strong>${escapeHtml(m.p2.name)}</strong> <span class="muted">(P2)</span>`
      : '<span class="muted">Tie</span>';

  const g1Banks = `${Math.round(m.p1Game1BankSeconds)}s / ${Math.round(m.p2Game1BankSeconds)}s`;
  // In Game 2, Seat `p1` is Match P2 and Seat `p2` is Match P1.
  const g2Banks = `${Math.round(m.p2Game2BankSeconds)}s / ${Math.round(m.p1Game2BankSeconds)}s`;

  const p1RamPct = ((m.p1PeakRam / 14336) * 100).toFixed(1);
  const p2RamPct = ((m.p2PeakRam / 14336) * 100).toFixed(1);
  const p1RamStr = `${Math.round(m.p1PeakRam).toLocaleString('en-US')} MiB`;
  const p2RamStr = `${Math.round(m.p2PeakRam).toLocaleString('en-US')} MiB`;
  const p1Banks = `${Math.round(m.p1Game1BankSeconds)}s / ${Math.round(m.p1Game2BankSeconds)}s`;
  const p2Banks = `${Math.round(m.p2Game1BankSeconds)}s / ${Math.round(m.p2Game2BankSeconds)}s`;
  const p1Teams = showPools ? ` · Teams ${t1Code} / ${t2Code}` : '';
  const p2Teams = showPools ? ` · Teams ${t2Code} / ${t1Code}` : '';

  let archiveNoteHtml = '';
  if (m.teamMode === 'pools' && m.ladderStatus === 'archived') {
    const links: string[] = [];
    if (m.archiveHref) {
      links.push(
        `<a href="${escapeHtml(m.archiveHref)}" class="subtle">` +
        `<code>${escapeHtml(`${m.ladderId}-logs.7z`)}</code></a>`
      );
    }
    if (m.teamsHref) {
      links.push(
        `<a href="${escapeHtml(m.teamsHref)}" class="subtle"><code>teams.json</code></a>`
      );
    }
    if (links.length > 0) {
      archiveNoteHtml = '<div class="battle-detail-note muted">Retired pool archives: ' +
        `${links.join(' · ')}</div>`;
    }
  }

  return `<div class="battle-detail">
    <div class="battle-detail-meta">
      <span>
        <a href="${escapeHtml(m.ladderHref)}" class="subtle">` +
          `<strong>${escapeHtml(m.ladderName)}</strong></a>
        <span class="muted">(<tt>${escapeHtml(fmtTitle)}</tt>)</span> ·
        <span class="muted">${escapeHtml(completedUtc)}</span>
      </span>
      <span>
        <span class="muted">Outcome:</span> <code>${escapeHtml(m.category)}</code>
        <span class="muted">(${m.game1Turns + m.game2Turns} turns)</span>${faultBadgeHtml} ·
        <span class="muted">Seed:</span> <code>${escapeHtml(m.seed)}</code>
      </span>
    </div>
    ${poolSummaryHtml}
    <div class="battle-detail-grid">
      <div class="battle-detail-card">
        <div class="battle-detail-title">Games</div>
        <div class="battle-detail-line">
          <span><strong>Game 1</strong> · <tt>p1</tt> ${p1Plain} vs <tt>p2</tt> ${p2Plain}</span>
          <span>${g1Winner} · ${end1.html} · ${m.game1Turns}t · ` +
            `Bank <tt>${g1Banks}</tt></span>
        </div>
        <div class="battle-detail-line">
          <span><strong>Game 2</strong> <span class="muted">(swapped)</span> · ` +
            `<tt>p1</tt> ${p2Plain} vs <tt>p2</tt> ${p1Plain}</span>
          <span>${g2Winner} · ${end2.html} · ${m.game2Turns}t · ` +
            `Bank <tt>${g2Banks}</tt></span>
        </div>
      </div>
      <div class="battle-detail-card">
        <div class="battle-detail-title">Client Telemetry</div>
        <div class="battle-detail-line">
          <span><tt>P1</tt> ${p1Bold}</span>
          <span>Mean <tt>${Math.round(m.p1MeanTurnMillis)} ms/turn</tt> · ` +
            `Peak RAM <tt>${p1RamStr}</tt> <span class="muted">(${p1RamPct}%)</span> · ` +
            `Banks <tt>${p1Banks}</tt>${p1Teams}</span>
        </div>
        <div class="battle-detail-line">
          <span><tt>P2</tt> ${p2Bold}</span>
          <span>Mean <tt>${Math.round(m.p2MeanTurnMillis)} ms/turn</tt> · ` +
            `Peak RAM <tt>${p2RamStr}</tt> <span class="muted">(${p2RamPct}%)</span> · ` +
            `Banks <tt>${p2Banks}</tt>${p2Teams}</span>
        </div>
      </div>
    </div>
    ${archiveNoteHtml}
  </div>`;
}

export function renderBattlesPage(opts: {
  db: db.Database;
  renderer: Renderer;
  publicDir: string;
  projectMeta: ReadonlyMap<string, ProjectMeta>;
  profileSlugs?: ReadonlySet<string>;
  liveDoc?: arena.LiveDocument;
  recentMatchesLimit: number;
  nowSec: number;
}): string {
  const {
    db,
    renderer,
    publicDir,
    projectMeta,
    profileSlugs,
    liveDoc,
    recentMatchesLimit,
    nowSec,
  } = opts;
  const ladders = db.getCurrentLadders();
  const countsBySlot = db.getMatchCountsBySlot();
  const recentMatches = db.getRecentMatches(recentMatchesLimit)
    .map(m => arena.enrichMatchView(publicDir, m));
  const totalMatches = countsBySlot.all ?? recentMatches.length;
  const totalPages = Math.max(1, Math.ceil(totalMatches / recentMatchesLimit));

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
    const href = resolveAgentHref(publicDir, projectMeta, s.slug, s.name, profileSlugs);
    if (href) agentLinks[s.slug] = href;
  }
  for (const m of recentMatches) {
    for (const side of [m.p1, m.p2]) {
      if (!agentLinks[side.slug]) {
        const href = resolveAgentHref(publicDir, projectMeta, side.slug, side.name, profileSlugs);
        if (href) agentLinks[side.slug] = href;
      }
    }
  }
  if (liveDoc?.live) {
    for (const side of [liveDoc.live.p1, liveDoc.live.p2]) {
      if (!agentLinks[side.slug]) {
        const href = resolveAgentHref(publicDir, projectMeta, side.slug, side.name, profileSlugs);
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
      const reasonSuffix =
        isAbnormalEndReason(m.game1EndReason) || isAbnormalEndReason(m.game2EndReason)
          ? ` · End: ${m.game1EndReason}/${m.game2EndReason}`
          : '';
      const tip =
        `${m.category} · ${Math.round(m.p1MeanTurnMillis)}ms/` +
        `${Math.round(m.p2MeanTurnMillis)}ms · Bank ${b1}s/${b2}s · RAM ` +
        `${Math.round(m.p1PeakRam).toLocaleString('en-US')}M/` +
        `${Math.round(m.p2PeakRam).toLocaleString('en-US')}M${reasonSuffix}`;

      const idEsc = escapeHtml(m.id);
      const rel = formatRelativeTime(nowSec, m.completedAt);
      const detailHtml = renderBattleInlineDetailHtml(m, agentLinks);
      return `<tr id="${idEsc}" class="battle-row" data-fmt="${escapeHtml(m.slot)}" ` +
        'tabindex="0" aria-expanded="false">\n' +
        '        <td><span class="battle-toggle" aria-hidden="true">&#9656;</span>' +
        `<code>${idEsc}</code></td>\n` +
        `        <td>${p1Cell}</td>\n` +
        `        <td>${p2Cell}</td>\n` +
        `        <td class="center" title="${escapeHtml(tip)}">${r.html}</td>\n` +
        `        <td class="num">${m.game1Turns} / ${m.game2Turns}</td>\n` +
        `        <td class="num muted" data-ts="${m.completedAt}">${rel}</td>\n` +
        '      </tr>\n' +
        `      <tr class="battle-detail-row hide" data-detail-for="${idEsc}">\n` +
        `        <td colspan="6">${detailHtml}</td>\n` +
        '      </tr>';
    }).join('\n      ');

  const initialState: arena.LiveDocument = liveDoc
    ? {
      ...liveDoc,
      pageSize: liveDoc.pageSize ?? recentMatchesLimit,
      totalMatches: liveDoc.totalMatches ?? totalMatches,
      countsBySlot: liveDoc.countsBySlot ?? countsBySlot,
      historyEndpoint: liveDoc.historyEndpoint ?? '/api/battles.json',
      recentMatches: liveDoc.recentMatches.map(m => arena.enrichMatchView(publicDir, m)),
    }
    : {
      updatedAt: nowSec,
      stale: false,
      pageSize: recentMatchesLimit,
      totalMatches,
      countsBySlot,
      historyEndpoint: '/api/battles.json',
      recentMatches,
    };

  const pagerInitialClass = totalPages <= 1 ? ' hide' : '';
  const battleWord = totalMatches === 1 ? 'battle' : 'battles';
  const pagerInitialInfo =
    `Page 1 of ${totalPages} (${totalMatches.toLocaleString('en-US')} ${battleWord})`;
  const pagerNextDisabled = totalPages <= 1 ? ' disabled' : '';

  const content = renderTemplate(BATTLES_TEMPLATE, {
    formatFilterItems,
    livePanelInner: renderLivePanelInner(liveDoc, nowSec, publicDir, projectMeta, profileSlugs),
    historyRows,
    pagerInitialClass,
    pagerInitialInfo,
    pagerNextDisabled,
    initialLiveJson: safeInlineJson(initialState),
    agentLinksJson: safeInlineJson(agentLinks),
    formatTitlesJson: safeInlineJson(FORMAT_TITLES),
  });

  return renderer.render({
    id: 'battles',
    title: 'Arena — Battles | pkmn.ai',
    header: injectLiveBanner(
      header('<a href="/arena/" class="subtle">Battles</a>'),
      db.getRunningTournament()
    ),
    path: '/arena/battles/',
    style: ARENA_STYLE,
    content,
  });
}

function getFileMtimeToken(filePath: string): string {
  try {
    return fs.statSync(filePath, {bigint: true}).mtimeNs.toString(36);
  } catch {
    return '0';
  }
}

const HUB_REDIRECT_ALIASES = [
  '/ladder',
  '/ladders',
  '/leaderboard',
  '/leaderboards',
  '/ranking',
  '/rankings',
  '/rating',
  '/ratings',
  '/tournament',
  '/tournaments',
  '/tour',
  '/tours',
  '/arena/ladder',
  '/arena/ladders',
  '/arena/leaderboard',
  '/arena/leaderboards',
  '/arena/ranking',
  '/arena/rankings',
  '/arena/rating',
  '/arena/ratings',
  '/arena/tournament',
  '/arena/tournaments',
  '/arena/tour',
  '/arena/tours',
];

const BATTLE_REDIRECT_ALIASES = [
  '/battles',
  '/battle',
  '/matches',
  '/match',
  '/games',
  '/game',
  '/arena/battle',
  '/arena/matches',
  '/arena/match',
  '/arena/games',
  '/arena/game',
];

const ASSET_EXT_RE = /\.[a-z0-9]{1,8}$/i;

// Dynamically serves all SQLite-backed Arena & Project HTML and `.json` surfaces (`/arena`,
// `/arena/ladders/*`, `/arena/battles`, `/arena/tournaments/*`, `/projects`, `/projects/:slug`)
// with `Cache-Control: no-cache` + `ETag` (`304 Not Modified`), backed by an in-memory cache that
// invalidates automatically on SQLite writes (`PRAGMA data_version` + `total_changes()`) and live
// Arena worker sequence updates.
export function register(app: polka.Polka, options: Options) {
  const {db, arena: arenaHandle} = options;
  const publicDir = options.publicDir ?? PUBLIC_DIR;
  const staticDir = options.staticDir ?? STATIC_DIR;
  const avatarsDir = options.avatarsDir ?? AVATARS_DIR;
  const recentMatchesLimit = options.recentMatchesLimit ?? 50;
  const getNowSec = options.now ?? (() => Math.floor(Date.now() / 1000));

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

  interface CacheEntry {
    token: string;
    body: Buffer;
    etag: string;
    contentType: string;
  }

  const responseCache = new Map<string, CacheEntry>();

  const getArchiveDiskToken = (): string => {
    const parts: string[] = [];
    for (const sub of ['ladders', 'tournaments']) {
      const base = path.join(publicDir, 'arena', sub);
      if (!fs.existsSync(base)) continue;
      for (const entry of fs.readdirSync(base)) {
        parts.push(`${sub}/${entry}:${getFileMtimeToken(path.join(base, entry))}`);
      }
    }
    return parts.join(',');
  };

  const getDbToken = (): string => {
    const state = arenaHandle.getState();
    const projMtime = getFileMtimeToken(path.join(staticDir, 'projects.yml'));
    const djMtime = getFileMtimeToken(path.join(staticDir, 'arena.dj'));
    return `${db.getChangeToken()}:${state.archiveSeq}:${projMtime}:${djMtime}:` +
      getArchiveDiskToken();
  };

  let cachedContext: {
    token: string;
    projectMeta: Map<string, ProjectMeta>;
    profileAgents: db.AgentRow[];
    profileBySlug: Map<string, db.AgentRow>;
    profileSlugs: Set<string>;
    liveTournament?: db.TournamentRow;
  } | undefined;

  const getContext = (dbToken: string) => {
    if (cachedContext?.token === dbToken) return cachedContext;
    const projectMeta = loadProjectMetaMap(staticDir);
    const profileAgents = db.getAllActiveAgents();
    const profileBySlug = new Map(profileAgents.map(a => [a.slug, a]));
    const profileSlugs = new Set(profileAgents.map(a => a.slug));
    const liveTournament = db.getRunningTournament();
    cachedContext = {
      token: dbToken,
      projectMeta,
      profileAgents,
      profileBySlug,
      profileSlugs,
      liveTournament,
    };
    return cachedContext;
  };

  let cachedArenaBundle: {
    token: string;
    bundle: ReturnType<typeof renderArenaAndLadderArtifacts>;
  } | undefined;

  const getArenaBundle = (dbToken: string, nowSec: number) => {
    const timeBucket = Math.floor(nowSec / 15);
    const bundleToken = `${dbToken}:${timeBucket}`;
    if (cachedArenaBundle?.token === bundleToken) return cachedArenaBundle.bundle;
    const ctx = getContext(dbToken);
    const bundle = renderArenaAndLadderArtifacts({
      db,
      renderer,
      publicDir,
      staticDir,
      projectMeta: ctx.projectMeta,
      profileSlugs: ctx.profileSlugs,
      nowSec,
    });
    cachedArenaBundle = {token: bundleToken, bundle};
    return bundle;
  };

  const sendCached = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    cacheKey: string,
    token: string,
    contentType: string,
    compute: () => string | Buffer,
    cacheControl = 'no-cache'
  ) => {
    let entry = responseCache.get(cacheKey);
    if (entry?.token !== token) {
      const raw = compute();
      const body = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
      const etag = `"${crypto.createHash('sha1').update(body).digest('hex')}"`;
      entry = {token, body, etag, contentType};
      if (responseCache.size >= 256) {
        const oldest = responseCache.keys().next().value;
        if (oldest !== undefined) responseCache.delete(oldest);
      }
      responseCache.set(cacheKey, entry);
    }
    res.setHeader('Cache-Control', cacheControl);
    res.setHeader('ETag', entry.etag);
    if (req.headers['if-none-match'] === entry.etag) {
      res.statusCode = 304;
      res.end();
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', entry.contentType);
    res.end(entry.body);
  };

  const sendJsonNotFound = (res: http.ServerResponse, message = 'Not found.') => {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({error: message}));
  };

  const sendHtmlNotFound = (res: http.ServerResponse) => {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    const static404 = path.join(publicDir, '404.html');
    if (fs.existsSync(static404)) {
      res.end(fs.readFileSync(static404));
      return;
    }
    const html = renderer.render({
      title: '404 | pkmn.ai',
      header: injectLiveBanner(header('404'), db.getRunningTournament()),
      path: '',
      id: 'error',
      content: '<p>Not Found</p>',
    });
    res.end(html);
  };

  const paramStr = (val: string | string[] | undefined): string => {
    const raw = Array.isArray(val) ? val[0] : val;
    try {
      return decodeURIComponent(raw ?? '').trim();
    } catch {
      return (raw ?? '').trim();
    }
  };

  for (const prefix of HUB_REDIRECT_ALIASES) {
    app.get(prefix, (_req, res) => {
      res.writeHead(302, {Location: '/arena/'});
      res.end();
    });
  }

  for (const prefix of BATTLE_REDIRECT_ALIASES) {
    app.get(prefix, (_req, res) => {
      res.writeHead(302, {Location: '/arena/battles/'});
      res.end();
    });
    app.get(`${prefix}.json`, (_req, res) => {
      res.writeHead(302, {Location: '/arena/battles.json'});
      res.end();
    });
  }

  const handleArenaHub = (req: http.IncomingMessage, res: http.ServerResponse, asJson: boolean) => {
    const nowSec = getNowSec();
    const dbToken = getDbToken();
    const token = `${dbToken}:${Math.floor(nowSec / 15)}`;
    if (asJson) {
      sendCached(
        req,
        res,
        'arena:json',
        token,
        'application/json; charset=utf-8',
        () => `${JSON.stringify(getArenaBundle(dbToken, nowSec).standingsJson, undefined, 2)}\n`
      );
      return;
    }
    sendCached(
      req,
      res,
      'arena:html',
      token,
      'text/html; charset=utf-8',
      () => getArenaBundle(dbToken, nowSec).arenaHtml
    );
  };

  app.get('/arena', (req, res) => handleArenaHub(req, res, false));
  app.get('/arena.json', (req, res) => handleArenaHub(req, res, true));
  app.get('/arena/index.json', (req, res) => handleArenaHub(req, res, true));

  const handleBattles = (req: http.IncomingMessage, res: http.ServerResponse, asJson: boolean) => {
    const nowSec = getNowSec();
    const state = arenaHandle.getState();
    const dbToken = getDbToken();
    const token = `${dbToken}:${state.liveSeq}:${Math.floor(nowSec / 5)}`;
    if (asJson) {
      sendCached(
        req,
        res,
        'battles:json',
        token,
        'application/json; charset=utf-8',
        () => `${JSON.stringify(arenaHandle.getLiveDocument(nowSec), undefined, 2)}\n`
      );
      return;
    }
    sendCached(req, res, 'battles:html', token, 'text/html; charset=utf-8', () => {
      const ctx = getContext(dbToken);
      return renderBattlesPage({
        db,
        renderer,
        publicDir,
        projectMeta: ctx.projectMeta,
        profileSlugs: ctx.profileSlugs,
        liveDoc: arenaHandle.getLiveDocument(nowSec),
        recentMatchesLimit,
        nowSec,
      });
    });
  };

  app.get('/arena/battles', (req, res) => handleBattles(req, res, false));
  app.get('/arena/battles.json', (req, res) => handleBattles(req, res, true));
  app.get('/arena/battles/index.json', (req, res) => handleBattles(req, res, true));

  app.get('/arena/ladders/:id/teams.json', (req, res) => {
    const id = paramStr(req.params.id);
    const ladder = db.getLadder(id);
    if (ladder?.team !== 'pools' || ladder.status !== 'archived') {
      sendJsonNotFound(res, `Published teams.json is not available for "${id}".`);
      return;
    }
    const nowSec = getNowSec();
    const dbToken = getDbToken();
    sendCached(
      req,
      res,
      `ladder-teams:${ladder.id}`,
      dbToken,
      'application/json; charset=utf-8',
      () => {
        const doc = getArenaBundle(dbToken, nowSec).archivedTeamsJsonById[ladder.id] ??
          buildLadderTeamsDocument(db, ladder);
        return `${JSON.stringify(doc, undefined, 2)}\n`;
      }
    );
  });

  const handleLadder = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    rawKey: string,
    forceJson: boolean
  ) => {
    const isJson = forceJson || rawKey.endsWith('.json');
    const key = rawKey.endsWith('.json') ? rawKey.slice(0, -5) : rawKey;
    if (!key) {
      if (isJson) sendJsonNotFound(res);
      else sendHtmlNotFound(res);
      return;
    }
    const nowSec = getNowSec();
    const dbToken = getDbToken();
    const token = `${dbToken}:${Math.floor(nowSec / 15)}`;
    const bundle = getArenaBundle(dbToken, nowSec);
    const jsonDoc = bundle.ladderJsonBySlot[key] ?? bundle.archivedLadderJsonById[key];
    const htmlDoc = bundle.ladderHtmlBySlot[key] ?? bundle.archivedLadderHtmlById[key];
    if (!jsonDoc || !htmlDoc) {
      if (isJson) sendJsonNotFound(res, `Unknown ladder "${key}".`);
      else sendHtmlNotFound(res);
      return;
    }
    if (isJson) {
      sendCached(
        req,
        res,
        `ladder:json:${key}`,
        token,
        'application/json; charset=utf-8',
        () => `${JSON.stringify(jsonDoc, undefined, 2)}\n`
      );
      return;
    }
    sendCached(req, res, `ladder:html:${key}`, token, 'text/html; charset=utf-8', () => htmlDoc);
  };

  app.get('/arena/ladders/:key/index.json', (req, res) => {
    handleLadder(req, res, paramStr(req.params.key), true);
  });
  app.get('/arena/ladders/:key', (req, res) => {
    handleLadder(req, res, paramStr(req.params.key), false);
  });

  const handleTournament = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    rawId: string,
    forceJson: boolean
  ) => {
    const isJson = forceJson || rawId.endsWith('.json');
    const id = rawId.endsWith('.json') ? rawId.slice(0, -5) : rawId;
    const tournament = id ? db.getTournament(id) : undefined;
    if (!tournament) {
      if (isJson) sendJsonNotFound(res, `Unknown tournament "${id}".`);
      else sendHtmlNotFound(res);
      return;
    }
    const state = arenaHandle.getState();
    const dbToken = getDbToken();
    const rulesMtime = getFileMtimeToken(path.join(staticDir, 'tours', `${tournament.id}.dj`));
    const token = `${dbToken}:${state.liveSeq}:${rulesMtime}`;
    if (isJson) {
      sendCached(
        req,
        res,
        `tournament:json:${tournament.id}`,
        dbToken,
        'application/json; charset=utf-8',
        () => {
          const doc = arena.buildTournamentDocument(db, publicDir, tournament, 10_000);
          return `${JSON.stringify(doc, undefined, 2)}\n`;
        }
      );
      return;
    }
    sendCached(
      req,
      res,
      `tournament:html:${tournament.id}`,
      token,
      'text/html; charset=utf-8',
      () => {
        const ctx = getContext(dbToken);
        return tournaments.renderTournamentPage({
          db,
          renderer,
          tournament,
          publicDir,
          staticDir,
          projectMeta: ctx.projectMeta,
          profileSlugs: ctx.profileSlugs,
          tournamentBroadcast: arenaHandle.getTournamentBroadcast(tournament.id),
          liveTournament: ctx.liveTournament,
        }).html;
      }
    );
  };

  app.get('/arena/tournaments/:id/index.json', (req, res) => {
    handleTournament(req, res, paramStr(req.params.id), true);
  });
  app.get('/arena/tournaments/:id', (req, res) => {
    handleTournament(req, res, paramStr(req.params.id), false);
  });

  // `/projects` is a static-YAML-backed directory page (augmented with Arena badges), so per
  // repository rules it must NEVER expose `/projects.json` or `/projects/index.json` (only
  // database-backed `/projects/:slug.json` is exposed).
  app.get('/projects.json', (_req, res) => sendJsonNotFound(res));
  app.get('/projects/index.json', (_req, res) => sendJsonNotFound(res));

  app.get('/projects', (req, res) => {
    const dbToken = getDbToken();
    sendCached(req, res, 'projects:html', dbToken, 'text/html; charset=utf-8', () => {
      const ctx = getContext(dbToken);
      const summaries = db.getProjectArenaSummaries();
      const arenaByName = new Map<string, projects.ArenaInfo>();
      for (const s of summaries) {
        arenaByName.set(s.name, {
          slug: s.slug,
          name: s.name,
          profileHref: `/projects/${encodeURIComponent(s.slug)}/`,
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
      return renderer.render({
        id: 'projects',
        ...projectsPage,
        header: injectLiveBanner(projectsPage.header, ctx.liveTournament),
      });
    });
  });

  const handleProjectProfile = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    rawParam: string,
    forceJson: boolean
  ) => {
    if (!rawParam || rawParam === 'index.json') {
      if (forceJson || rawParam === 'index.json') sendJsonNotFound(res);
      else sendHtmlNotFound(res);
      return;
    }

    const dbToken = getDbToken();
    const ctx = getContext(dbToken);

    const isJson = forceJson || rawParam.endsWith('.json');
    if (isJson) {
      const slug = rawParam.endsWith('.json') ? rawParam.slice(0, -5) : rawParam;
      const agent = ctx.profileBySlug.get(slug);
      if (!agent) {
        sendJsonNotFound(res, `Unknown Arena agent "${slug}".`);
        return;
      }
      const nowSec = getNowSec();
      const token = `${dbToken}:${Math.floor(nowSec / 15)}`;
      sendCached(
        req,
        res,
        `profile:json:${agent.slug}`,
        token,
        'application/json; charset=utf-8',
        () => {
          const {json} = renderAgentProfile({
            db,
            renderer,
            agent,
            publicDir,
            avatarsDir,
            projectMeta: ctx.projectMeta,
            profileSlugs: ctx.profileSlugs,
            liveTournament: ctx.liveTournament,
            nowSec,
          });
          return `${JSON.stringify(json, undefined, 2)}\n`;
        }
      );
      return;
    }

    // Serve agent logo assets (`/projects/<slug>.<ext>`) directly from `avatarsDir`.
    for (const agent of ctx.profileAgents) {
      const logo = resolveAgentLogo(agent, avatarsDir);
      if (logo?.fileName === rawParam) {
        const mtime = getFileMtimeToken(logo.filePath);
        sendCached(
          req,
          res,
          `logo:${logo.fileName}`,
          mtime,
          logo.contentType,
          () => fs.readFileSync(logo.filePath),
          'public, max-age=86400'
        );
        return;
      }
    }

    const agent = ctx.profileBySlug.get(rawParam);
    if (agent) {
      const nowSec = getNowSec();
      const token = `${dbToken}:${Math.floor(nowSec / 15)}`;
      sendCached(
        req,
        res,
        `profile:html:${agent.slug}`,
        token,
        'text/html; charset=utf-8',
        () => renderAgentProfile({
          db,
          renderer,
          agent,
          publicDir,
          avatarsDir,
          projectMeta: ctx.projectMeta,
          profileSlugs: ctx.profileSlugs,
          liveTournament: ctx.liveTournament,
          nowSec,
        }).html
      );
      return;
    }

    if (ASSET_EXT_RE.test(rawParam)) {
      sendHtmlNotFound(res);
      return;
    }

    res.writeHead(302, {Location: `/projects/#${encodeURIComponent(rawParam)}`});
    res.end();
  };

  app.get('/projects/:slug/index.json', (req, res) => {
    handleProjectProfile(req, res, paramStr(req.params.slug), true);
  });
  app.get('/projects/:param', (req, res) => {
    handleProjectProfile(req, res, paramStr(req.params.param), false);
  });
}
