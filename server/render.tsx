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
import * as build from '../static/build';
import * as projects from '../static/projects';
import * as util from '../static/util';
import {getDex, hashTeam} from '../teams';

import * as arena from './arena';
import * as profile from './profile';
import * as ratings from './ratings';
import * as tournaments from './tournaments';

export const PUBLIC_DIR = util.root('public');
export const STATIC_DIR =
  process.env.MOCK === '1' ? util.root('.mock', 'static') : util.root('static');

export const AI_PANEL_STYLE = fs.readFileSync(
  util.root('static', 'style', 'ai-panel.css'),
  'utf8'
);
export const ARENA_STYLE =
  `${AI_PANEL_STYLE}\n${fs.readFileSync(util.root('static', 'style', 'arena.css'), 'utf8')}`;

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

const LADDER_SCRIPT = `
  document.addEventListener('DOMContentLoaded', () => {
    ${util.UPDATE_TABLE_PAGER_SCRIPT}
    const verRadios = document.querySelectorAll('input[name="versions"]');
    const rows = Array.from(document.querySelectorAll('.standings-table tbody tr'));
    const pager = document.getElementById('standings-pager');
    const prevBtn = document.getElementById('standings-pager-prev');
    const nextBtn = document.getElementById('standings-pager-next');
    const pageSize = (pager && Number(pager.dataset.pageSize)) || ${util.TABLE_PAGE_SIZE};
    let mode = 'active';
    let page = 1;

    const applyStandings = () => {
      const matching = rows.filter(row => {
        if (mode === 'all') return true;
        if (mode === 'best') return Boolean(row.dataset.best);
        return Boolean(row.dataset.active);
      });
      const state = updateTablePager(pager, page, matching.length, pageSize);
      page = state.page;
      const start = (page - 1) * pageSize;
      const visible = new Set(matching.slice(start, start + pageSize));
      rows.forEach(row => {
        row.classList.toggle('hide', !visible.has(row));
      });
    };

    verRadios.forEach(r => r.addEventListener('change', () => {
      mode = r.value;
      page = 1;
      applyStandings();
    }));

    if (prevBtn) {
      prevBtn.addEventListener('click', () => {
        if (page > 1) {
          page--;
          applyStandings();
        }
      });
    }
    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        page++;
        applyStandings();
      });
    }

    const seasonSelect = document.getElementById('season-select');
    if (seasonSelect) {
      seasonSelect.addEventListener('change', () => {
        if (seasonSelect.value) {
          window.location.href = seasonSelect.value;
        }
      });
    }
  });
`;

function formatCompactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function formatWinPct(win: number): string {
  return `${(win * 100).toFixed(1)}%`;
}

export function renderAiStatsHtml(
  slot: 'p1' | 'p2',
  info: arena.PublicAgentInfo | undefined
): string {
  if (!info) return '<span class="ai-silent">no /info telemetry</span>';
  const parts: string[] = [];
  if (info.win !== undefined) {
    parts.push(`<span>Win <span class="ai-win-${slot}">${formatWinPct(info.win)}</span></span>`);
  }
  if (info.depth !== undefined) {
    const depthText = info.seldepth !== undefined
      ? `${info.depth}/${info.seldepth}`
      : `${info.depth}`;
    parts.push(`<span>Depth <span class="ai-stat-val">${depthText}</span></span>`);
  } else if (info.seldepth !== undefined) {
    parts.push(`<span>Seldepth <span class="ai-stat-val">${info.seldepth}</span></span>`);
  }
  if (info.nodes !== undefined) {
    const count = formatCompactCount(info.nodes);
    parts.push(`<span>Nodes <span class="ai-stat-val">${count}</span></span>`);
  }
  if (info.nps !== undefined) {
    parts.push(`<span>NPS <span class="ai-stat-val">${formatCompactCount(info.nps)}</span></span>`);
  }
  if (parts.length === 0) return '<span class="ai-silent">no /info telemetry</span>';
  return parts.join('<span class="muted">·</span>');
}

export function renderAiWinBarHtml(
  p1Name: string,
  p2Name: string,
  p1Info: arena.PublicAgentInfo | undefined,
  p2Info: arena.PublicAgentInfo | undefined
): string {
  const p1WinRaw = p1Info?.win;
  const p2WinRaw = p2Info?.win;
  if (p1WinRaw === undefined && p2WinRaw === undefined) return '';
  const p1Win = p1WinRaw ?? (1 - p2WinRaw!);
  const p2ViewOfP1 = p2WinRaw !== undefined ? 1 - p2WinRaw : undefined;
  const fillPct = Math.max(3, Math.min(97, p1Win * 100));
  const tipParts: string[] = [];
  if (p1WinRaw !== undefined) tipParts.push(`${p1Name} (P1): ${formatWinPct(p1WinRaw)}`);
  if (p2WinRaw !== undefined) tipParts.push(`${p2Name} (P2): ${formatWinPct(p2WinRaw)}`);
  const markHtml = p1WinRaw !== undefined && p2ViewOfP1 !== undefined
    ? `<div class="ai-winbar-mark" style="left:calc(${(p2ViewOfP1 * 100).toFixed(1)}% - 1.5px)" ` +
      `title="${util.escapeHtml(p2Name)} estimate of ${util.escapeHtml(p1Name)} win%: ` +
      `${formatWinPct(p2ViewOfP1)}"></div>`
    : '';
  return `<div class="ai-winbar-track" title="${util.escapeHtml(tipParts.join(' · '))}">` +
    `<div class="ai-winbar-fill" style="width:${fillPct.toFixed(1)}%"></div>` +
    '<div class="ai-winbar-mid" title="50%"></div>' +
    markHtml +
  '</div>';
}

export function renderAiWinChartHtml(
  points: readonly arena.WinHistoryPoint[] | undefined,
  opts?: {activeTurn?: number; interactive?: boolean}
): string {
  if (!points || points.length === 0) return '';
  const hasP1 = points.some(pt => pt.p1 !== undefined);
  const hasP2 = points.some(pt => pt.p2 !== undefined);
  if (!hasP1 && !hasP2) return '';

  const W = 560;
  const H = 84;
  const padL = 28;
  const padR = 8;
  const padT = 8;
  const padB = 18;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const xFor = (i: number) =>
    padL + (points.length <= 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const yFor = (w: number) => padT + (1 - Math.max(0, Math.min(1, w))) * plotH;

  const buildPath = (pick: (pt: arena.WinHistoryPoint) => number | undefined): string => {
    let d = '';
    let open = false;
    for (let i = 0; i < points.length; i++) {
      const val = pick(points[i]);
      if (val === undefined) {
        open = false;
        continue;
      }
      d += `${open ? 'L' : 'M'}${xFor(i).toFixed(1)},${yFor(val).toFixed(1)}`;
      open = true;
    }
    return d;
  };

  const p1Path = hasP1 ? buildPath(pt => pt.p1) : '';
  const p2Path = hasP2 ? buildPath(pt => (pt.p2 !== undefined ? 1 - pt.p2 : undefined)) : '';

  let activeIdx = points.length - 1;
  if (opts?.activeTurn !== undefined) {
    activeIdx = 0;
    for (let i = 0; i < points.length; i++) {
      if (points[i].turn <= opts.activeTurn) activeIdx = i;
    }
  }
  const curPt = points[activeIdx];
  const curX = xFor(activeIdx);

  const legendParts: string[] = [];
  if (hasP1) {
    legendParts.push(
      '<span class="ai-legend-item"><span class="ai-swatch-p1"></span>P1 win%</span>'
    );
  }
  if (hasP2) {
    legendParts.push(
      '<span class="ai-legend-item"><span class="ai-swatch-p2"></span>1−P2 win%</span>'
    );
  }
  const heading = 'Win probability';

  let hits = '';
  if (opts?.interactive) {
    const step = points.length <= 1 ? plotW : plotW / (points.length - 1);
    for (let i = 0; i < points.length; i++) {
      const pt = points[i];
      const rx = Math.max(padL, xFor(i) - step / 2);
      const tipParts = [`Turn ${pt.turn}`];
      if (pt.p1 !== undefined) tipParts.push(`P1 ${formatWinPct(pt.p1)}`);
      if (pt.p2 !== undefined) tipParts.push(`P2 ${formatWinPct(pt.p2)}`);
      hits += `<rect class="ai-chart-hit" x="${rx.toFixed(1)}" y="${padT}" ` +
        `width="${step.toFixed(1)}" height="${plotH}" fill="transparent" ` +
        `data-seek-turn="${pt.turn}"><title>${tipParts.join(' · ')}</title></rect>`;
    }
  }

  const firstLabel = `T${points[0].turn}`;
  const lastLabel = `T${points[points.length - 1].turn}`;
  const curLabel = `T${curPt.turn}`;
  const showCurLabel = points.length > 2 && activeIdx > 0 && activeIdx < points.length - 1;

  return '<div class="ai-chart">' +
    '<div class="ai-chart-head">' +
      `<span>${heading}</span>` +
      `<span class="ai-chart-legend">${legendParts.join('')}</span>` +
    '</div>' +
    `<svg class="ai-chart-svg" viewBox="0 0 ${W} ${H}" role="img" ` +
      'aria-label="Win probability by turn">' +
      `<line x1="${padL}" y1="${yFor(1)}" x2="${W - padR}" y2="${yFor(1)}" ` +
        'stroke="currentColor" stroke-opacity="0.14" stroke-width="1" />' +
      `<line x1="${padL}" y1="${yFor(0.5)}" x2="${W - padR}" y2="${yFor(0.5)}" ` +
        'stroke="currentColor" stroke-opacity="0.28" stroke-dasharray="3 3" stroke-width="1" />' +
      `<line x1="${padL}" y1="${yFor(0)}" x2="${W - padR}" y2="${yFor(0)}" ` +
        'stroke="currentColor" stroke-opacity="0.14" stroke-width="1" />' +
      `<text x="${padL - 4}" y="${yFor(1) + 3}" text-anchor="end" fill="currentColor" ` +
        'fill-opacity="0.55" font-size="9" font-family="monospace">100</text>' +
      `<text x="${padL - 4}" y="${yFor(0.5) + 3}" text-anchor="end" fill="currentColor" ` +
        'fill-opacity="0.55" font-size="9" font-family="monospace">50</text>' +
      `<text x="${padL - 4}" y="${yFor(0) + 3}" text-anchor="end" fill="currentColor" ` +
        'fill-opacity="0.55" font-size="9" font-family="monospace">0</text>' +
      (p1Path
        ? `<path d="${p1Path}" fill="none" stroke="var(--ai-p1)" stroke-width="2" ` +
          'stroke-linejoin="round" />'
        : '') +
      (p2Path
        ? `<path d="${p2Path}" fill="none" stroke="var(--ai-p2)" stroke-width="1.75" ` +
          'stroke-dasharray="4 3" stroke-linejoin="round" />'
        : '') +
      `<line x1="${curX.toFixed(1)}" y1="${padT}" x2="${curX.toFixed(1)}" y2="${H - padB}" ` +
        'stroke="currentColor" stroke-opacity="0.35" stroke-width="1" />' +
      (curPt.p1 !== undefined
        ? `<circle cx="${curX.toFixed(1)}" cy="${yFor(curPt.p1).toFixed(1)}" r="3.5" ` +
          'fill="var(--ai-p1)" />'
        : '') +
      (curPt.p2 !== undefined
        ? `<circle cx="${curX.toFixed(1)}" cy="${yFor(1 - curPt.p2).toFixed(1)}" r="3" ` +
          'fill="var(--ai-p2)" />'
        : '') +
      `<text x="${padL}" y="${H - 4}" fill="currentColor" fill-opacity="0.55" ` +
        `font-size="9" font-family="monospace">${firstLabel}</text>` +
      (showCurLabel
        ? `<text x="${curX.toFixed(1)}" y="${H - 4}" text-anchor="middle" fill="currentColor" ` +
          `font-size="9" font-family="monospace">${curLabel}</text>`
        : '') +
      (points.length > 1
        ? `<text x="${W - padR}" y="${H - 4}" text-anchor="end" fill="currentColor" ` +
          `fill-opacity="0.55" font-size="9" font-family="monospace">${lastLabel}</text>`
        : '') +
      hits +
    '</svg>' +
  '</div>';
}

export function renderAiPanelHtml(
  p1Name: string,
  p2Name: string,
  p1Info: arena.PublicAgentInfo | undefined,
  p2Info: arena.PublicAgentInfo | undefined,
  winHistory: readonly arena.WinHistoryPoint[] | undefined,
  opts?: {showStrip?: boolean; activeTurn?: number; interactive?: boolean}
): string {
  const showStrip = opts?.showStrip !== false;
  const hasInfo = Boolean(p1Info || p2Info);
  const hasChart = Boolean(winHistory && winHistory.length > 0);
  if (!hasInfo && !hasChart) return '';
  const stripHtml = showStrip && hasInfo
    ? '<div class="ai-strip">' +
        '<div class="ai-strip-side"><span class="ai-slot-tag">P1</span>' +
          `${renderAiStatsHtml('p1', p1Info)}</div>` +
        '<div class="ai-strip-side"><span class="ai-slot-tag">P2</span>' +
          `${renderAiStatsHtml('p2', p2Info)}</div>` +
      '</div>'
    : '';
  const barHtml = renderAiWinBarHtml(p1Name, p2Name, p1Info, p2Info);
  const chartHtml = renderAiWinChartHtml(winHistory, opts);
  return stripHtml + barHtml + chartHtml;
}

export function buildAiPanelClientJs(): string {
  return `
    const escAi = s => String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

    const formatCompactCount = n => {
      if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
      return String(Math.round(n));
    };

    const formatWinPct = w => (w * 100).toFixed(1) + '%';

    const renderAiStatsHtml = (slot, info) => {
      if (!info) return '<span class="ai-silent">no /info telemetry</span>';
      const parts = [];
      if (typeof info.win === 'number') {
        parts.push(
          '<span>Win <span class="ai-win-' + slot + '">' + formatWinPct(info.win) + '</span></span>'
        );
      }
      if (typeof info.depth === 'number') {
        const dText = typeof info.seldepth === 'number'
          ? (info.depth + '/' + info.seldepth)
          : String(info.depth);
        parts.push('<span>Depth <span class="ai-stat-val">' + dText + '</span></span>');
      } else if (typeof info.seldepth === 'number') {
        parts.push('<span>Seldepth <span class="ai-stat-val">' + info.seldepth + '</span></span>');
      }
      if (typeof info.nodes === 'number') {
        parts.push(
          '<span>Nodes <span class="ai-stat-val">' + formatCompactCount(info.nodes) +
          '</span></span>'
        );
      }
      if (typeof info.nps === 'number') {
        parts.push(
          '<span>NPS <span class="ai-stat-val">' + formatCompactCount(info.nps) + '</span></span>'
        );
      }
      if (parts.length === 0) return '<span class="ai-silent">no /info telemetry</span>';
      return parts.join('<span class="muted">·</span>');
    };

    const renderAiWinBarHtml = (p1Name, p2Name, p1Info, p2Info) => {
      const hasP1 = Boolean(p1Info && typeof p1Info.win === 'number');
      const hasP2 = Boolean(p2Info && typeof p2Info.win === 'number');
      if (!hasP1 && !hasP2) return '';
      const p1Win = hasP1 ? p1Info.win : (1 - p2Info.win);
      const p2ViewOfP1 = hasP2 ? (1 - p2Info.win) : undefined;
      const fillPct = Math.max(3, Math.min(97, p1Win * 100));
      const tipParts = [];
      if (hasP1) tipParts.push(p1Name + ' (P1): ' + formatWinPct(p1Info.win));
      if (hasP2) tipParts.push(p2Name + ' (P2): ' + formatWinPct(p2Info.win));
      const markHtml = (hasP1 && hasP2 && p2ViewOfP1 !== undefined)
        ? '<div class="ai-winbar-mark" style="left:calc(' + (p2ViewOfP1 * 100).toFixed(1) +
          '% - 1.5px)" title="' + escAi(p2Name) + ' estimate of ' + escAi(p1Name) + ' win%: ' +
          formatWinPct(p2ViewOfP1) + '"></div>'
        : '';
      return '<div class="ai-winbar-track" title="' + escAi(tipParts.join(' · ')) + '">' +
        '<div class="ai-winbar-fill" style="width:' + fillPct.toFixed(1) + '%"></div>' +
        '<div class="ai-winbar-mid" title="50%"></div>' +
        markHtml +
      '</div>';
    };

    const renderAiWinChartHtml = (points, opts) => {
      if (!Array.isArray(points) || points.length === 0) return '';
      const hasP1 = points.some(pt => typeof pt.p1 === 'number');
      const hasP2 = points.some(pt => typeof pt.p2 === 'number');
      if (!hasP1 && !hasP2) return '';
      const W = 560, H = 84, padL = 28, padR = 8, padT = 8, padB = 18;
      const plotW = W - padL - padR;
      const plotH = H - padT - padB;
      const xFor = i => padL + (points.length <= 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
      const yFor = w => padT + (1 - Math.max(0, Math.min(1, w))) * plotH;
      const buildPath = pick => {
        let d = '';
        let open = false;
        for (let i = 0; i < points.length; i++) {
          const val = pick(points[i]);
          if (typeof val !== 'number') {
            open = false;
            continue;
          }
          d += (open ? 'L' : 'M') + xFor(i).toFixed(1) + ',' + yFor(val).toFixed(1);
          open = true;
        }
        return d;
      };
      const p1Path = hasP1 ? buildPath(pt => pt.p1) : '';
      const p2Path = hasP2
        ? buildPath(pt => (typeof pt.p2 === 'number' ? 1 - pt.p2 : undefined))
        : '';
      let activeIdx = points.length - 1;
      if (opts && typeof opts.activeTurn === 'number') {
        activeIdx = 0;
        for (let i = 0; i < points.length; i++) {
          if (points[i].turn <= opts.activeTurn) activeIdx = i;
        }
      }
      const curPt = points[activeIdx];
      const curX = xFor(activeIdx);
      const legendParts = [];
      if (hasP1) {
        legendParts.push(
          '<span class="ai-legend-item"><span class="ai-swatch-p1"></span>P1 win%</span>'
        );
      }
      if (hasP2) {
        legendParts.push(
          '<span class="ai-legend-item"><span class="ai-swatch-p2"></span>1−P2 win%</span>'
        );
      }
      const interactive = Boolean(opts && opts.interactive);
      const heading = 'Win probability';
      let hits = '';
      if (interactive) {
        const step = points.length <= 1 ? plotW : plotW / (points.length - 1);
        for (let i = 0; i < points.length; i++) {
          const pt = points[i];
          const rx = Math.max(padL, xFor(i) - step / 2);
          const tips = ['Turn ' + pt.turn];
          if (typeof pt.p1 === 'number') tips.push('P1 ' + formatWinPct(pt.p1));
          if (typeof pt.p2 === 'number') tips.push('P2 ' + formatWinPct(pt.p2));
          hits += '<rect class="ai-chart-hit" x="' + rx.toFixed(1) + '" y="' + padT +
            '" width="' + step.toFixed(1) + '" height="' + plotH +
            '" fill="transparent" data-seek-turn="' + pt.turn + '"><title>' +
            escAi(tips.join(' · ')) + '</title></rect>';
        }
      }
      const showCurLabel = points.length > 2 && activeIdx > 0 && activeIdx < points.length - 1;
      return '<div class="ai-chart">' +
        '<div class="ai-chart-head">' +
          '<span>' + heading + '</span>' +
          '<span class="ai-chart-legend">' + legendParts.join('') + '</span>' +
        '</div>' +
        '<svg class="ai-chart-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" ' +
          'aria-label="Win probability by turn">' +
          '<line x1="' + padL + '" y1="' + yFor(1) + '" x2="' + (W - padR) + '" y2="' + yFor(1) +
            '" stroke="currentColor" stroke-opacity="0.14" stroke-width="1" />' +
          '<line x1="' + padL + '" y1="' + yFor(0.5) + '" x2="' + (W - padR) + '" y2="' +
            yFor(0.5) + '" stroke="currentColor" stroke-opacity="0.28" stroke-dasharray="3 3" ' +
            'stroke-width="1" />' +
          '<line x1="' + padL + '" y1="' + yFor(0) + '" x2="' + (W - padR) + '" y2="' + yFor(0) +
            '" stroke="currentColor" stroke-opacity="0.14" stroke-width="1" />' +
          '<text x="' + (padL - 4) + '" y="' + (yFor(1) + 3) + '" text-anchor="end" ' +
            'fill="currentColor" fill-opacity="0.55" font-size="9" ' +
            'font-family="monospace">100</text>' +
          '<text x="' + (padL - 4) + '" y="' + (yFor(0.5) + 3) + '" text-anchor="end" ' +
            'fill="currentColor" fill-opacity="0.55" font-size="9" ' +
            'font-family="monospace">50</text>' +
          '<text x="' + (padL - 4) + '" y="' + (yFor(0) + 3) + '" text-anchor="end" ' +
            'fill="currentColor" fill-opacity="0.55" font-size="9" ' +
            'font-family="monospace">0</text>' +
          (p1Path
            ? '<path d="' + p1Path + '" fill="none" stroke="var(--ai-p1)" stroke-width="2" ' +
              'stroke-linejoin="round" />'
            : '') +
          (p2Path
            ? '<path d="' + p2Path + '" fill="none" stroke="var(--ai-p2)" stroke-width="1.75" ' +
              'stroke-dasharray="4 3" stroke-linejoin="round" />'
            : '') +
          '<line x1="' + curX.toFixed(1) + '" y1="' + padT + '" x2="' + curX.toFixed(1) +
            '" y2="' + (H - padB) + '" stroke="currentColor" stroke-opacity="0.35" ' +
            'stroke-width="1" />' +
          (typeof curPt.p1 === 'number'
            ? '<circle cx="' + curX.toFixed(1) + '" cy="' + yFor(curPt.p1).toFixed(1) +
              '" r="3.5" fill="var(--ai-p1)" />'
            : '') +
          (typeof curPt.p2 === 'number'
            ? '<circle cx="' + curX.toFixed(1) + '" cy="' + yFor(1 - curPt.p2).toFixed(1) +
              '" r="3" fill="var(--ai-p2)" />'
            : '') +
          '<text x="' + padL + '" y="' + (H - 4) + '" fill="currentColor" fill-opacity="0.55" ' +
            'font-size="9" font-family="monospace">T' + points[0].turn + '</text>' +
          (showCurLabel
            ? '<text x="' + curX.toFixed(1) + '" y="' + (H - 4) + '" text-anchor="middle" ' +
              'fill="currentColor" font-size="9" font-family="monospace">T' + curPt.turn + '</text>'
            : '') +
          (points.length > 1
            ? '<text x="' + (W - padR) + '" y="' + (H - 4) + '" text-anchor="end" ' +
              'fill="currentColor" fill-opacity="0.55" font-size="9" font-family="monospace">T' +
              points[points.length - 1].turn + '</text>'
            : '') +
          hits +
        '</svg>' +
      '</div>';
    };

    const renderAiPanelHtml = (p1Name, p2Name, p1Info, p2Info, winHistory, opts) => {
      const showStrip = !opts || opts.showStrip !== false;
      const hasInfo = Boolean(p1Info || p2Info);
      const hasChart = Array.isArray(winHistory) && winHistory.length > 0;
      if (!hasInfo && !hasChart) return '';
      const stripHtml = (showStrip && hasInfo)
        ? '<div class="ai-strip">' +
            '<div class="ai-strip-side"><span class="ai-slot-tag">P1</span>' +
              renderAiStatsHtml('p1', p1Info) + '</div>' +
            '<div class="ai-strip-side"><span class="ai-slot-tag">P2</span>' +
              renderAiStatsHtml('p2', p2Info) + '</div>' +
          '</div>'
        : '';
      return stripHtml +
        renderAiWinBarHtml(p1Name, p2Name, p1Info, p2Info) +
        renderAiWinChartHtml(winHistory, opts);
    };

    const extractAiTelemetryFromLines = lines => {
      if (!Array.isArray(lines) || lines.length === 0) return [];
      const byTurn = new Map();
      let curTurn = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = String(lines[i] || '');
        if (line.indexOf('|turn|') === 0) {
          const n = parseInt(line.slice(6), 10);
          if (Number.isInteger(n) && n >= 0) curTurn = n;
          continue;
        }
        if (line.indexOf('|ai|') !== 0) continue;
        const slot = line.slice(4, 6);
        if ((slot !== 'p1' && slot !== 'p2') || line[6] !== '|') continue;
        try {
          const info = JSON.parse(line.slice(7));
          if (!info || typeof info !== 'object' || Array.isArray(info)) continue;
          let entry = byTurn.get(curTurn);
          if (!entry) {
            entry = {turn: curTurn};
            byTurn.set(curTurn, entry);
          }
          entry[slot] = info;
        } catch {}
      }
      return Array.from(byTurn.values()).sort((a, b) => a.turn - b.turn);
    };
  `;
}

export function buildBattleDetailClientJs(): string {
  return `
    const esc = s => String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

    const relTime = (nowSec, ts) => {
      const diff = Math.max(0, nowSec - ts);
      if (diff < 60) return diff + 's ago';
      if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
      if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
      return Math.floor(diff / 86400) + 'd ago';
    };

    const localTimestamp = ts => pkmnTime.timestamp(ts);

    const resolveAgentHref = slug => {
      if (!slug) return '';
      if (Object.prototype.hasOwnProperty.call(agentLinks, slug)) return agentLinks[slug];
      return '/projects/' + encodeURIComponent(slug) + '/';
    };

    const renderAgent = (agent, bold) => {
      const inner = bold ? '<strong>' + esc(agent.name) + '</strong>' : esc(agent.name);
      const href = resolveAgentHref(agent.slug);
      const link = href ? '<a href="' + esc(href) + '" class="subtle">' + inner + '</a>' : inner;
      return link + ' <code class="muted">' + esc(agent.version) + '</code>';
    };

    const isFaultReason = r => {
      const norm = String(r || '').trim().toLowerCase();
      return Boolean(norm) &&
        norm !== 'normal' &&
        norm !== 'win' &&
        norm !== 'tie' &&
        norm !== 'turn-limit' &&
        !/^tie-\\d+-turns$/.test(norm);
    };

    const formatEndReason = reason => {
      const norm = String(reason || '').trim().toLowerCase();
      if (!norm || norm === 'normal' || norm === 'win') {
        return {
          html: '<span class="muted">Normal</span>',
          label: 'Normal',
          abnormal: false,
          show: false,
        };
      }
      if (norm === 'tie') {
        return {
          html: '<span class="muted">Tie</span>',
          label: 'Tie',
          abnormal: false,
          show: false,
        };
      }
      if (norm === 'turn-limit' || /^tie-\\d+-turns$/.test(norm)) {
        return {
          html: '<span class="muted">Turn limit</span>',
          label: 'Turn limit',
          abnormal: false,
          show: true,
        };
      }
      if (norm === 'timeout') {
        return {
          html: '<span class="no">Timeout</span>',
          label: 'Timeout',
          abnormal: true,
          show: true,
        };
      }
      if (norm === 'crash') {
        return {
          html: '<span class="no">Crash</span>',
          label: 'Crash',
          abnormal: true,
          show: true,
        };
      }
      if (norm === 'oom') {
        return {
          html: '<span class="no">OOM</span>',
          label: 'OOM',
          abnormal: true,
          show: true,
        };
      }
      if (norm === 'invalid-choice') {
        return {
          html: '<span class="no">3&times; Invalid Choice</span>',
          label: '3x Invalid Choice',
          abnormal: true,
          show: true,
        };
      }
      return {
        html: '<span class="no">' + esc(reason) + '</span>',
        label: reason,
        abnormal: true,
        show: true,
      };
    };

    const formatPoolCode = (label, p1Name, p2Name) => {
      if (!label) return '<span class="muted">—</span>';
      let tip;
      if (label.startsWith('P1:')) {
        tip = 'Known to P1 (' + p1Name + ') — drawn from ' + p1Name +
          "'s submitted seasonal pool (unknown to " + p2Name + ')';
      } else if (label.startsWith('P2:')) {
        tip = 'Known to P2 (' + p2Name + ') — drawn from ' + p2Name +
          "'s submitted seasonal pool (unknown to " + p1Name + ')';
      } else {
        tip = 'Unknown to both players — drawn from a third-party competitor seasonal pool';
      }
      return '<code title="' + esc(tip) + '">' + esc(label) + '</code>';
    };

    const resultParts = cat => {
      if (cat === 'WW') return {p1Win: true, p2Win: false, html: '<strong>2</strong>–0'};
      if (cat === 'WT' || cat === 'TW') {
        return {p1Win: true, p2Win: false, html: '<strong>1.5</strong>–0.5'};
      }
      if (cat === 'LL') return {p1Win: false, p2Win: true, html: '0–<strong>2</strong>'};
      if (cat === 'LT' || cat === 'TL') {
        return {p1Win: false, p2Win: true, html: '0.5–<strong>1.5</strong>'};
      }
      return {p1Win: false, p2Win: false, html: '1–1'};
    };

    const formatGameOutcomeHtml = outcome => {
      if (outcome === 'W') return '<span class="yes" title="Player 1 won">W</span>';
      if (outcome === 'L') return '<span class="no" title="Player 2 won">L</span>';
      return '<span class="muted" title="Tie">T</span>';
    };

    const formatGamePlayerTelemetryHtml = p => {
      const meanMillis = Math.round(p.meanTurnMillis || 0);
      const bankSeconds = Math.round(p.bankSeconds || 0);
      const ramStr = Math.round(p.peakRam || 0).toLocaleString('en-US') + ' MiB';
      const cpuHtml = (typeof p.cpuCores === 'number' && p.cpuCores > 0)
        ? ' · <span title="Host-measured CPU utilization (effective cores)"><tt>' +
          p.cpuCores.toFixed(1) + '</tt> CPU</span>'
        : '';
      const parenParts = [];
      if (p.initMillis !== undefined) {
        parenParts.push('<tt>' + Math.round(p.initMillis) + ' ms</tt> init');
      }
      if (p.teamPreviewMillis !== undefined) {
        parenParts.push('<tt>' + Math.round(p.teamPreviewMillis) + ' ms</tt> preview');
      }
      const parenHtml = parenParts.length > 0
        ? ' <span class="muted">(' + parenParts.join(' · ') + ')</span>'
        : '';
      return '<span><tt>' + meanMillis + ' ms/turn</tt>' + parenHtml +
        ' · Bank <tt>' + bankSeconds + 's</tt> · RAM <tt>' + ramStr + '</tt>' +
        cpuHtml + '</span>';
    };

    const renderMatchDetailHtml = (m, perspectiveSlug) => {
      const omitOutcome = Boolean(perspectiveSlug);
      const p1IsUs = Boolean(perspectiveSlug && m.p1 && m.p1.slug === perspectiveSlug);
      const p2IsUs = Boolean(perspectiveSlug && m.p2 && m.p2.slug === perspectiveSlug);
      const p1Label = p1IsUs ? '(P1)' : 'P1';
      const p2Label = p2IsUs ? '(P2)' : 'P2';

      const [g1, g2] = m.games;
      const end1 = formatEndReason(g1.endReason);
      const end2 = formatEndReason(g2.endReason);

      const showPools = m.teamMode === 'pools' || Boolean(m.p1.teamLabel || m.p2.teamLabel);
      const t1Code = formatPoolCode(m.p1.teamLabel, m.p1.name, m.p2.name);
      const t2Code = formatPoolCode(m.p2.teamLabel, m.p1.name, m.p2.name);

      const replayAttrs = (g1.logHref || g2.logHref)
        ? ' data-match-id="' + esc(m.id) +
          '" data-p1-name="' + esc(m.p1.name) +
          '" data-p2-name="' + esc(m.p2.name) + '"' +
          (g1.logHref ? ' data-g1-log="' + esc(g1.logHref) + '"' : '') +
          (g2.logHref ? ' data-g2-log="' + esc(g2.logHref) + '"' : '')
        : '';

      const g1OutcomePrefix = omitOutcome ? '' : (formatGameOutcomeHtml(g1.outcome) + ' · ');
      const g2OutcomePrefix = omitOutcome ? '' : (formatGameOutcomeHtml(g2.outcome) + ' · ');
      const g1EndSuffix = end1.show ? (' · ' + end1.html) : '';
      const g2EndSuffix = end2.show ? (' · ' + end2.html) : '';

      return '<div class="battle-detail"' + replayAttrs + '>' +
        '<div class="battle-detail-meta">' +
          '<time class="muted" data-epoch="' + m.completedAt + '">' +
            esc(localTimestamp(m.completedAt)) +
          '</time>' +
          '<span><span class="muted">Seed:</span> <code>' + esc(m.seed) + '</code></span>' +
        '</div>' +
        '<div class="battle-detail-grid">' +
          '<div class="battle-detail-card">' +
            '<div class="battle-detail-title">' +
              '<span>Game 1</span>' +
              '<span class="battle-detail-sub">' + g1OutcomePrefix +
                '<tt>' + g1.turns + ' turns</tt>' + g1EndSuffix +
              '</span>' +
            '</div>' +
            '<div class="battle-detail-line">' +
              '<span><tt>' + p1Label + '</tt>' + (showPools ? ' ' + t1Code : '') + '</span>' +
              formatGamePlayerTelemetryHtml(g1.p1) +
            '</div>' +
            '<div class="battle-detail-line">' +
              '<span><tt>' + p2Label + '</tt>' + (showPools ? ' ' + t2Code : '') + '</span>' +
              formatGamePlayerTelemetryHtml(g1.p2) +
            '</div>' +
          '</div>' +
          '<div class="battle-detail-card">' +
            '<div class="battle-detail-title">' +
              '<span>Game 2</span>' +
              '<span class="battle-detail-sub">' + g2OutcomePrefix +
                '<tt>' + g2.turns + ' turns</tt>' + g2EndSuffix +
              '</span>' +
            '</div>' +
            '<div class="battle-detail-line">' +
              '<span><tt>' + p1Label + '</tt>' + (showPools ? ' ' + t2Code : '') + '</span>' +
              formatGamePlayerTelemetryHtml(g2.p1) +
            '</div>' +
            '<div class="battle-detail-line">' +
              '<span><tt>' + p2Label + '</tt>' + (showPools ? ' ' + t1Code : '') + '</span>' +
              formatGamePlayerTelemetryHtml(g2.p2) +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    };

    ${buildAiPanelClientJs()}

    const renderReplayAiPanel = (slot, activeTurn) => {
      const panel = slot && slot.querySelector('.replay-ai-panel');
      if (!panel) return;
      const tele = Array.isArray(slot._aiTelemetry) ? slot._aiTelemetry : [];
      if (tele.length === 0) {
        panel.innerHTML = '';
        panel.classList.add('hide');
        return;
      }
      let snap = tele[0];
      const target = typeof activeTurn === 'number' ? activeTurn : tele[0].turn;
      for (let i = 0; i < tele.length; i++) {
        if (tele[i].turn <= target) snap = tele[i];
      }
      const winHistory = [];
      for (let i = 0; i < tele.length; i++) {
        const p1w = tele[i].p1 && typeof tele[i].p1.win === 'number' ? tele[i].p1.win : undefined;
        const p2w = tele[i].p2 && typeof tele[i].p2.win === 'number' ? tele[i].p2.win : undefined;
        if (p1w !== undefined || p2w !== undefined) {
          winHistory.push({turn: tele[i].turn, p1: p1w, p2: p2w});
        }
      }
      const html = renderAiPanelHtml(
        slot._aiSeat1 || 'P1',
        slot._aiSeat2 || 'P2',
        snap.p1,
        snap.p2,
        winHistory,
        {activeTurn: snap.turn, interactive: true}
      );
      panel.innerHTML = html;
      panel.classList.toggle('hide', !html);
    };

    const SPEED_KEY = 'pkmn-viewer-speed';
    const VALID_SPEEDS = {slow: 1, normal: 1, fast: 1, hyperfast: 1};

    const postToFrame = (frameEl, msg) => {
      if (frameEl && frameEl.contentWindow) {
        frameEl.contentWindow.postMessage(msg, '*');
      }
    };

    const syncFramePrefs = frameEl => {
      const dark = document.documentElement.getAttribute('data-theme') === 'dark';
      postToFrame(frameEl, {type: 'theme', dark});
      try {
        const saved = localStorage.getItem(SPEED_KEY);
        if (saved && Object.prototype.hasOwnProperty.call(VALID_SPEEDS, saved)) {
          postToFrame(frameEl, {type: 'speed', speed: saved});
        }
      } catch {}
    };

    window.addEventListener('message', ev => {
      const data = ev.data;
      if (!data || typeof data !== 'object') return;
      const frames = document.querySelectorAll('iframe.viewer-frame');
      let fromViewer = false;
      for (let i = 0; i < frames.length; i++) {
        if (ev.source === frames[i].contentWindow) {
          fromViewer = true;
          break;
        }
      }
      if (!fromViewer) return;
      if (
        data.type === 'speed' &&
        typeof data.speed === 'string' &&
        Object.prototype.hasOwnProperty.call(VALID_SPEEDS, data.speed)
      ) {
        try {
          localStorage.setItem(SPEED_KEY, data.speed);
        } catch {}
        return;
      }
      if (data.type === 'playback' && typeof data.turn === 'number') {
        document.querySelectorAll('.battle-detail[data-match-id]').forEach(slot => {
          const f = slot.querySelector('iframe.replay-viewer-frame');
          if (f && ev.source === f.contentWindow) {
            renderReplayAiPanel(slot, data.turn);
          }
        });
        return;
      }
      if (data.type !== 'ready') return;
      document.querySelectorAll('.battle-detail[data-match-id]').forEach(slot => {
        const f = slot.querySelector('iframe.replay-viewer-frame');
        if (f && ev.source === f.contentWindow) {
          slot._viewerReady = true;
          syncFramePrefs(f);
          if (Array.isArray(slot._pendingLines) && slot._pendingLines.length > 0) {
            postToFrame(f, {
              type: 'load',
              lines: slot._pendingLines,
              p1Lines: slot._pendingP1Lines,
              p2Lines: slot._pendingP2Lines,
              live: false,
              side: 'p1',
            });
          }
        }
      });
    });

    const loadRowReplay = async (slot, gameNum) => {
      if (!slot) return;
      const matchId = slot.getAttribute('data-match-id') || '';
      const p1Name = slot.getAttribute('data-p1-name') || 'P1';
      const p2Name = slot.getAttribute('data-p2-name') || 'P2';
      const isSingleGame = slot.getAttribute('data-single-game') === '1';
      const sameSeats = slot.getAttribute('data-same-seats') === '1';
      const totalGames = Math.max(1, Number(slot.getAttribute('data-total-games')) || 2);
      const logUrls = [];
      for (let i = 1; i <= totalGames; i++) {
        logUrls.push(slot.getAttribute('data-g' + i + '-log') || '');
      }
      const reqGame = Number(gameNum) || 1;
      const activeGame = (reqGame >= 1 && reqGame <= totalGames && logUrls[reqGame - 1])
        ? reqGame
        : Math.max(1, logUrls.findIndex(Boolean) + 1);
      const logUrl = logUrls[activeGame - 1] || '';
      if (!logUrl) return;

      let wrap = slot.querySelector('.battle-replay-wrap');
      if (!wrap) {
        wrap = document.createElement('div');
        wrap.className = 'battle-replay-wrap';
        wrap.innerHTML =
          '<div class="series-bar">' +
            '<span class="replay-bar-left"></span>' +
            '<span class="replay-bar-right"></span>' +
          '</div>' +
          '<div class="ai-panel replay-ai-panel hide"></div>' +
          '<div class="viewer-wrap">' +
            '<iframe class="viewer-frame replay-viewer-frame" src="/arena/viewer/" ' +
              'title="Pokémon Showdown replay viewer" ' +
              'sandbox="allow-scripts"></iframe>' +
          '</div>';
        wrap.addEventListener('click', ev => {
          const hit = ev.target && ev.target.closest
            ? ev.target.closest('[data-seek-turn]')
            : null;
          if (!hit) return;
          const turn = Number(hit.getAttribute('data-seek-turn'));
          if (!Number.isFinite(turn)) return;
          const f = slot.querySelector('iframe.replay-viewer-frame');
          if (f) postToFrame(f, {type: 'seek', turn});
          renderReplayAiPanel(slot, turn);
        });
        slot.appendChild(wrap);
      }
      const leftEl = slot.querySelector('.replay-bar-left');
      const rightEl = slot.querySelector('.replay-bar-right');
      const seat1 = (!sameSeats && activeGame === 2) ? p2Name : p1Name;
      const seat2 = (!sameSeats && activeGame === 2) ? p1Name : p2Name;
      if (leftEl) {
        if (isSingleGame) {
          leftEl.innerHTML = '<strong>Replay</strong> · <code>' + esc(matchId) + '</code> ' +
            '<span class="muted">(<tt>P1</tt> ' + esc(p1Name) +
            ' vs <tt>P2</tt> ' + esc(p2Name) + ')</span>';
        } else {
          leftEl.innerHTML = '<strong>Replay</strong> · <code>' + esc(matchId) +
            '</code> · <strong>Game ' + activeGame + ' / ' + totalGames + '</strong> ' +
            '<span class="muted">(<tt>P1</tt> ' + esc(seat1) +
            ' vs <tt>P2</tt> ' + esc(seat2) + ')</span>';
        }
      }
      if (rightEl) {
        const pills = [];
        if (!isSingleGame) {
          for (let i = 0; i < totalGames; i++) {
            const u = logUrls[i];
            if (!u) continue;
            const gIdx = i + 1;
            pills.push(
              '<a href="' + esc(u) + '" data-replay-log="' + esc(u) +
              '" data-replay-match="' + esc(matchId) +
              '" data-replay-game="' + gIdx + '">' +
              '<svg class="inline-icon" viewBox="0 0 24 24" aria-hidden="true">' +
              '<path d="M7 5l12 7-12 7z"/></svg>Game ' + gIdx + '</a>'
            );
          }
        }
        rightEl.innerHTML = pills.join(' · ');
      }

      if (slot._loadedLogUrl === logUrl && Array.isArray(slot._pendingLines)) {
        return;
      }
      slot._loadedLogUrl = logUrl;
      try {
        const fetchUrl = logUrl + (logUrl.indexOf('?') >= 0 ? '&' : '?') + 'side=both';
        const res = await fetch(fetchUrl);
        if (!res.ok) return;
        const ct = String(res.headers.get('content-type') || '');
        let lines = [];
        let p1Lines = undefined;
        let p2Lines = undefined;
        if (ct.indexOf('application/json') >= 0) {
          const parsed = await res.json();
          lines = Array.isArray(parsed.lines) ? parsed.lines : [];
          p1Lines = Array.isArray(parsed.p1Lines) ? parsed.p1Lines : undefined;
          p2Lines = Array.isArray(parsed.p2Lines) ? parsed.p2Lines : undefined;
        } else {
          const text = await res.text();
          lines = text.split('\\n');
        }
        if (slot._loadedLogUrl !== logUrl) return;
        slot._pendingLines = lines;
        slot._pendingP1Lines = p1Lines;
        slot._pendingP2Lines = p2Lines;
        slot._aiSeat1 = seat1;
        slot._aiSeat2 = seat2;
        slot._aiTelemetry = extractAiTelemetryFromLines(lines);
        renderReplayAiPanel(slot, slot._aiTelemetry[0] ? slot._aiTelemetry[0].turn : 0);
        const f = slot.querySelector('iframe.replay-viewer-frame');
        if (slot._viewerReady && f) {
          postToFrame(f, {type: 'load', lines, p1Lines, p2Lines, live: false, side: 'p1'});
        }
      } catch {}
    };
  `;
}

function buildBattlesScript(
  initialLiveJson: string,
  agentLinksJson: string
): string {
  return `
  (() => {
    const HP_PCT_KEY = 'pkmn-live-hp-percent';
    const wrap = document.getElementById('live-panel-wrap');
    const toggle = document.getElementById('live-hp-pct');
    let show = false;
    try {
      show = localStorage.getItem(HP_PCT_KEY) === '1';
    } catch {}
    if (wrap) wrap.classList.toggle('show-hp-pct', show);
    if (toggle) toggle.checked = show;
  })();
  document.addEventListener('DOMContentLoaded', () => {
    let state = ${initialLiveJson} || {};
    const agentLinks = ${agentLinksJson};
    const HP_PCT_KEY = 'pkmn-live-hp-percent';
    const livePanelWrap = document.getElementById('live-panel-wrap');
    const liveHpToggle = document.getElementById('live-hp-pct');
    const livePanel = document.getElementById('live-panel');
    const setShowHpPercent = show => {
      if (livePanelWrap) livePanelWrap.classList.toggle('show-hp-pct', show);
      if (liveHpToggle) liveHpToggle.checked = show;
      try {
        if (show) localStorage.setItem(HP_PCT_KEY, '1');
        else localStorage.removeItem(HP_PCT_KEY);
      } catch {}
    };
    if (liveHpToggle) {
      liveHpToggle.addEventListener('change', () => {
        setShowHpPercent(liveHpToggle.checked);
      });
    }
    if (livePanel) {
      livePanel.addEventListener('click', e => {
        if (e.target.closest('.hp-orbs')) {
          setShowHpPercent(!(livePanelWrap && livePanelWrap.classList.contains('show-hp-pct')));
        }
      });
    }
    const battleViewerWrap = document.getElementById('battle-viewer-wrap');
    const liveViewerFrame = document.getElementById('ps-viewer-frame');
    ${util.UPDATE_TABLE_PAGER_SCRIPT}
    const tbody = document.getElementById('battles-tbody');
    const pager = document.getElementById('battles-pager');
    const prevBtn = document.getElementById('battles-pager-prev');
    const nextBtn = document.getElementById('battles-pager-next');
    const radios = document.querySelectorAll('input[name="bformat"]');
    const pageSize = (state && state.pageSize) || ${util.TABLE_PAGE_SIZE};
    const historyEndpoint = (state && state.historyEndpoint) || '/api/battles.json';
    let currentFmt = 'all';
    let currentPage = 1;
    let fetchSeq = 0;
    let liveViewerReady = false;
    let viewerPlaybackState = 'waiting';
    let shownLive = (
      state &&
      state.live &&
      !state.stale &&
      state.live.viewer &&
      Array.isArray(state.live.viewer.lines) &&
      state.live.viewer.lines.length > 0
    )
      ? {...state.live, ended: false, seekEnd: true}
      : undefined;
    let queuedLive = undefined;
    let sentLineCount = 0;
    let sentP1Count = 0;
    let sentP2Count = 0;
    let sentEnd = false;

    ${buildBattleDetailClientJs()}

    const ensureLiveViewer = () => {
      if (liveViewerFrame && !liveViewerFrame.getAttribute('src')) {
        liveViewerFrame.setAttribute('src', '/arena/viewer/');
      }
    };

    const loadShownIntoViewer = () => {
      if (!shownLive || !shownLive.viewer) return;
      if (battleViewerWrap) battleViewerWrap.classList.remove('hide');
      ensureLiveViewer();
      const v = shownLive.viewer;
      const lines = Array.isArray(v.lines) ? v.lines : [];
      const p1Lines = v.p1 && Array.isArray(v.p1.lines) ? v.p1.lines : undefined;
      const p2Lines = v.p2 && Array.isArray(v.p2.lines) ? v.p2.lines : undefined;
      sentLineCount = lines.length;
      sentP1Count = p1Lines ? p1Lines.length : 0;
      sentP2Count = p2Lines ? p2Lines.length : 0;
      sentEnd = false;
      if (!liveViewerReady) return;
      postToFrame(liveViewerFrame, {
        type: 'load',
        lines,
        p1Lines,
        p2Lines,
        p1Pokemon: v.p1 ? v.p1.pokemon : undefined,
        p2Pokemon: v.p2 ? v.p2.pokemon : undefined,
        live: true,
        seekEnd: shownLive.seekEnd !== false,
        side: 'p1',
      });
      if (shownLive.ended) {
        postToFrame(liveViewerFrame, {type: 'end'});
        sentEnd = true;
      }
    };

    const appendShownToViewer = () => {
      if (!shownLive || !shownLive.viewer) return;
      if (battleViewerWrap) battleViewerWrap.classList.remove('hide');
      ensureLiveViewer();
      const v = shownLive.viewer;
      const lines = Array.isArray(v.lines) ? v.lines : [];
      const p1Lines = v.p1 && Array.isArray(v.p1.lines) ? v.p1.lines : undefined;
      const p2Lines = v.p2 && Array.isArray(v.p2.lines) ? v.p2.lines : undefined;
      if (liveViewerReady && lines.length > sentLineCount) {
        postToFrame(liveViewerFrame, {
          type: 'append',
          lines: lines.slice(sentLineCount),
          p1Lines: p1Lines ? p1Lines.slice(sentP1Count) : undefined,
          p2Lines: p2Lines ? p2Lines.slice(sentP2Count) : undefined,
          p1Pokemon: v.p1 ? v.p1.pokemon : undefined,
          p2Pokemon: v.p2 ? v.p2.pokemon : undefined,
        });
      }
      sentLineCount = lines.length;
      sentP1Count = p1Lines ? p1Lines.length : 0;
      sentP2Count = p2Lines ? p2Lines.length : 0;
      if (shownLive.ended && liveViewerReady && !sentEnd) {
        postToFrame(liveViewerFrame, {type: 'end'});
        sentEnd = true;
      }
    };

    window.addEventListener('message', ev => {
      const data = ev.data;
      if (!data || typeof data !== 'object') return;
      if (
        data.type === 'playback' &&
        liveViewerFrame &&
        ev.source === liveViewerFrame.contentWindow
      ) {
        viewerPlaybackState = data.state || 'waiting';
        if (viewerPlaybackState === 'finished') {
          if (queuedLive) {
            shownLive = queuedLive;
            queuedLive = undefined;
            loadShownIntoViewer();
          } else if (
            state &&
            state.live &&
            !(state.live.viewer && Array.isArray(state.live.viewer.lines))
          ) {
            if (battleViewerWrap) battleViewerWrap.classList.add('hide');
            shownLive = undefined;
          }
        }
        return;
      }
      if (data.type !== 'ready') return;
      if (liveViewerFrame && ev.source === liveViewerFrame.contentWindow) {
        liveViewerReady = true;
        syncFramePrefs(liveViewerFrame);
        if (shownLive) {
          loadShownIntoViewer();
        }
      }
    });

    const renderTeamSpanHtml = team => {
      if (!team) return '';
      const teamTip = team.startsWith('P1:')
        ? 'Known to Match P1 (drawn from P1 seasonal pool)'
        : team.startsWith('P2:')
          ? 'Known to Match P2 (drawn from P2 seasonal pool)'
          : 'Unknown to both players (drawn from a third-party competitor pool)';
      return '<span title="' + esc(teamTip) + '">Team: <code>' + esc(team) + '</code></span>';
    };

    const renderPokemonOrbsHtml = pokemon => {
      if (!Array.isArray(pokemon) || pokemon.length === 0) return '';
      let orbs = '';
      for (let i = 0; i < pokemon.length; i++) {
        const m = pokemon[i];
        if (!m || typeof m !== 'object') continue;
        const pct = Math.max(0, Math.min(100, Math.round(Number(m.percent) || 0)));
        const color = (
          m.color === 'yellow' || m.color === 'red' || m.color === 'fainted'
        )
          ? m.color
          : 'green';
        const tip = pct + '%';
        orbs += '<span class="hp-orb-item"><span class="hp-orb ' + color + '" title="' + tip +
          '" role="img" aria-label="' + tip + '">&#9679;</span>' +
          '<span class="hp-pct" aria-hidden="true">' + tip + '</span></span>';
      }
      return orbs ? '<span class="hp-orbs" aria-label="Pokémon health">' + orbs + '</span>' : '';
    };

    const renderGame1SideHtml = (key, slotMeta, side, won) => {
      const orbs = renderPokemonOrbsHtml(side.pokemon);
      const teamHtml = renderTeamSpanHtml(side.team);
      const parenParts = [];
      if (side.initMillis !== undefined) {
        parenParts.push('<tt>' + Math.round(side.initMillis) + ' ms</tt> init');
      }
      if (side.teamPreviewMillis !== undefined) {
        parenParts.push('<tt>' + Math.round(side.teamPreviewMillis) + ' ms</tt> preview');
      }
      const parenHtml = parenParts.length > 0
        ? ' <span class="muted">(' + parenParts.join(' · ') + ')</span>'
        : '';
      return '<div class="live-g1-side">' +
        '<div class="live-g1-top">' +
        '<span><tt>' + key.toUpperCase() + '</tt> ' + renderAgent(slotMeta, won) + '</span>' +
        orbs +
        '</div>' +
        '<div class="live-g1-telemetry">' +
        '<span><tt>' + Math.round(side.meanTurnMillis) + ' ms/turn</tt>' + parenHtml + '</span>' +
        '<span>Bank: <tt>' + Math.round(side.bankSeconds) + 's</tt></span>' +
        '<span title="XNU ri_phys_footprint (14 GiB limit)">RAM: <tt>' +
        Math.round(side.ram).toLocaleString('en-US') + ' MiB</tt></span>' +
        ((typeof side.cpuCores === 'number' && side.cpuCores > 0)
          ? '<span title="Host-measured CPU utilization (effective cores)"><tt>' +
            side.cpuCores.toFixed(1) + '</tt> CPU</span>'
          : '') +
        teamHtml +
        '</div></div>';
    };

    const renderGame1SummaryHtml = l => {
      const g1 = l.game1Summary;
      if (!g1) return '';
      const winnerHtml = g1.winnerSlot === 'p1'
        ? '<span class="yes">' + esc(l.p1.name) + '</span> won'
        : g1.winnerSlot === 'p2'
          ? '<span class="yes">' + esc(l.p2.name) + '</span> won'
          : '<span class="muted">Tie</span>';
      const end = g1.endReason ? formatEndReason(g1.endReason) : undefined;
      const endSuffix = (end && end.show) ? (' · ' + end.html) : '';
      const sidesHtml = (g1.p1 && g1.p2)
        ? '<div class="live-g1-grid">' +
          renderGame1SideHtml('p1', l.p1, g1.p1, g1.winnerSlot === 'p1') +
          renderGame1SideHtml('p2', l.p2, g1.p2, g1.winnerSlot === 'p2') +
          '</div>'
        : '';
      return '<div class="live-g1" id="live-g1">' +
        '<div class="live-g1-head">' +
        '<span class="live-g1-label">Game 1</span>' +
        '<span>' + winnerHtml + ' · <tt>' + g1.turns + ' turns</tt>' + endSuffix + '</span>' +
        '</div>' +
        sidesHtml +
        '</div>';
    };

    const renderSlot = (key, slotData, live, nowSec) => {
      const isInit = live.phase === 'init';
      const isPreview = live.phase === 'preview';
      const isRunning = live.activeSlot === key;
      const otherKey = key === 'p1' ? 'p2' : 'p1';
      const fmtId = String(live.format || '').toLowerCase();
      const isVgcTimer = fmtId.includes('vgc') || fmtId.includes('bss');
      const maxTurnSec = isVgcTimer ? 55 : 150;
      const maxFirstTurnSec = isVgcTimer ? 90 : 150;
      const elapsed = isRunning ? Math.max(0, nowSec - live.turnStartedAt) : 0;
      const budget = isRunning
        ? Math.round(live.turnBudgetSeconds)
        : (isInit ? 60 : Math.min(
          Math.round(slotData.bankSeconds),
          isPreview ? maxFirstTurnSec : maxTurnSec
        ));
      const bank = isRunning && !isInit && !(isVgcTimer && isPreview)
        ? Math.max(0, Math.round(slotData.bankSeconds - elapsed))
        : Math.round(slotData.bankSeconds);
      const inc = Math.round(live.incrementSeconds);
      const ramPct = ((slotData.ram / 14336) * 100).toFixed(1);
      const badge = isRunning
        ? '<span class="state-running" id="state-' + key + '" title="' +
          (isInit
            ? 'Initializing (waiting for /ready within 60s grace)'
            : 'Currently executing (SIGCONT)') +
          '">&#9679; ' + (isInit ? 'INITIALIZING' : 'RUNNING') + '</span>'
        : '<span class="state-paused" id="state-' + key +
          '" title="Frozen by kernel SIGSTOP while ' + otherKey.toUpperCase() +
          ' computes">PAUSED</span>';
      const timerTitle = isVgcTimer
        ? '60s /ready init grace + Pokémon Showdown VGC Timer: 420s Your Time, 90s preview, ' +
          '55s/turn'
        : '60s /ready init grace + Pokémon Showdown RoomBattleTimer: 150s max bank, ' +
          '60s grace, +' + inc + 's/turn';
      const bankMeta = inc > 0 ? ('(+' + inc + 's/turn)') : ('(' + maxTurnSec + 's/turn)');
      const stepLabel = isInit ? 'Init' : 'Turn';
      const teamHtml = renderTeamSpanHtml(slotData.team);
      const orbsHtml = renderPokemonOrbsHtml(slotData.pokemon);
      const showAi = Boolean((live.p1 && live.p1.info) || (live.p2 && live.p2.info));
      const aiHtml = showAi
        ? '<div class="slot-ai">' + renderAiStatsHtml(key, slotData.info) + '</div>'
        : '';
      return '<div class="slot-card ' + (isRunning ? 'running' : 'paused') +
        '" id="slot-' + key + '">' +
        '<div class="slot-top"><span><tt>' + key.toUpperCase() + '</tt> ' +
        renderAgent(slotData, true) + '</span>' +
        orbsHtml +
        badge + '</div>' +
        '<div class="slot-timers" title="' + esc(timerTitle) + '">' +
        '<span>' + stepLabel + ': <strong id="turn-' + key + '" class="' +
        (isRunning ? 'yes' : 'muted') + '">' +
        elapsed + 's</strong> <span class="muted">/ ' + budget + 's</span></span>' +
        '<span>Bank: <strong id="bank-' + key + '">' + bank + 's</strong> ' +
        '<span class="muted">' + bankMeta + '</span></span></div>' +
        '<div class="slot-telemetry">' +
        '<span>Last: <tt>' + Math.round(slotData.lastTurnMillis) + ' ms</tt></span>' +
        '<span>Mean: <tt>' + Math.round(slotData.meanTurnMillis) + ' ms/turn</tt></span>' +
        '<span title="XNU ri_phys_footprint (14 GiB limit)">RAM: <tt>' +
        Math.round(slotData.ram).toLocaleString('en-US') + ' MiB</tt> (' + ramPct + '%)</span>' +
        ((typeof slotData.cpuCores === 'number' && slotData.cpuCores > 0)
          ? '<span title="Host-measured CPU utilization (effective cores)"><tt>' +
            slotData.cpuCores.toFixed(1) + '</tt> CPU</span>'
          : '') +
        teamHtml +
        '</div>' + aiHtml + '</div>';
    };

    const renderLive = nowSec => {
      if (!livePanel) return;
      if (!state || !state.live || state.stale) {
        let idleBody;
        if (state && state.stale) {
          idleBody = 'No active heartbeat — Arena is offline or idle.';
        } else if (state && state.smokeTesting && state.smokeTesting.name) {
          const href = resolveAgentHref(state.smokeTesting.slug);
          const nameHtml = '<strong>' + esc(state.smokeTesting.name) + '</strong>';
          const agentHtml = href
            ? '<a href="' + esc(href) + '" class="subtle">' + nameHtml + '</a>'
            : nameHtml;
          idleBody = '<span class="yes">&#9679;</span> Testing a submission for ' +
            agentHtml + ' — ladder battles will resume shortly.';
        } else {
          idleBody = 'No battle currently running — Arena is idle.';
        }
        const tourSuffix = state && state.runningTournament
          ? ' · <a href="' + esc(state.runningTournament.href) + '" class="subtle">' +
            '<strong>&#9679; Watch ' + esc(state.runningTournament.name) + ' live</strong></a>'
          : '';
        livePanel.innerHTML = '<div class="live-idle muted">' + idleBody + tourSuffix + '</div>';
        if (state && state.stale) {
          if (battleViewerWrap) battleViewerWrap.classList.add('hide');
          shownLive = undefined;
          queuedLive = undefined;
          return;
        }
        if (shownLive) {
          shownLive.ended = true;
          if (liveViewerReady && !sentEnd) {
            postToFrame(liveViewerFrame, {type: 'end'});
            sentEnd = true;
          }
          if (queuedLive && viewerPlaybackState === 'finished') {
            shownLive = {...queuedLive, ended: true};
            queuedLive = undefined;
            loadShownIntoViewer();
          } else if (battleViewerWrap) {
            battleViewerWrap.classList.remove('hide');
          }
        } else if (battleViewerWrap) {
          battleViewerWrap.classList.add('hide');
        }
        return;
      }
      const l = state.live;
      const hbAge = Math.max(0, nowSec - state.updatedAt);
      const stepText = l.phase === 'init'
        ? ' · Initializing (<code>/ready</code>)'
        : (l.phase === 'preview' || l.turn === 0)
          ? ' · Team Preview'
          : ', Turn ' + l.turn;
      const liveAiHtml = renderAiPanelHtml(
        l.p1.name,
        l.p2.name,
        l.p1.info,
        l.p2.info,
        l.winHistory,
        {showStrip: false, activeTurn: l.turn}
      );
      const livePanelAiHtml = liveAiHtml
        ? '<div class="ai-panel">' + liveAiHtml + '</div>'
        : '';
      livePanel.innerHTML = '<div class="live-header"><span><code>' + esc(l.matchId) +
        '</code> · <strong>Game ' + l.game +
        ' / 2</strong>' + stepText + '</span>' +
        '<span class="muted">Heartbeat <tt>#' + l.heartbeatSeq + '</tt> (<tt id="hb-age">' +
        hbAge + 's</tt> ago)</span></div>' +
        renderGame1SummaryHtml(l) +
        '<div class="slots-grid">' +
        renderSlot('p1', l.p1, l, nowSec) +
        renderSlot('p2', l.p2, l, nowSec) +
        '</div>' + livePanelAiHtml;

      if (l.viewer && Array.isArray(l.viewer.lines) && l.viewer.lines.length > 0) {
        const gameKey = l.matchId + ':' + l.game;
        const shownKey = shownLive ? (shownLive.matchId + ':' + shownLive.game) : '';
        if (!shownLive) {
          shownLive = {...l, ended: false, seekEnd: true};
          queuedLive = undefined;
          loadShownIntoViewer();
        } else if (gameKey === shownKey) {
          const prevLen = shownLive.viewer && Array.isArray(shownLive.viewer.lines)
            ? shownLive.viewer.lines.length
            : 0;
          shownLive = {...l, ended: false, seekEnd: shownLive.seekEnd};
          if (l.viewer.lines.length < prevLen) {
            loadShownIntoViewer();
          } else {
            appendShownToViewer();
          }
        } else {
          shownLive.ended = true;
          if (liveViewerReady && !sentEnd) {
            postToFrame(liveViewerFrame, {type: 'end'});
            sentEnd = true;
          }
          if (viewerPlaybackState === 'watching') {
            queuedLive = {...l, ended: false, seekEnd: false};
            if (battleViewerWrap) battleViewerWrap.classList.remove('hide');
          } else {
            shownLive = {...l, ended: false, seekEnd: false};
            queuedLive = undefined;
            loadShownIntoViewer();
          }
        }
      } else if (shownLive && viewerPlaybackState === 'watching') {
        shownLive.ended = true;
        if (liveViewerReady && !sentEnd) {
          postToFrame(liveViewerFrame, {type: 'end'});
          sentEnd = true;
        }
        if (battleViewerWrap) battleViewerWrap.classList.remove('hide');
      } else {
        if (battleViewerWrap) battleViewerWrap.classList.add('hide');
        shownLive = undefined;
        queuedLive = undefined;
      }
    };

    const renderMatchPair = (m, nowSec, expanded) => {
      const r = resultParts(m.category);
      const [g1, g2] = m.games;
      const b1 = Math.round(Math.min(g1.p1.bankSeconds, g2.p1.bankSeconds));
      const b2 = Math.round(Math.min(g1.p2.bankSeconds, g2.p2.bankSeconds));
      const reasons = (isFaultReason(g1.endReason) || isFaultReason(g2.endReason))
        ? ' · End: ' + g1.endReason + '/' + g2.endReason
        : '';
      const cpuSuffix = (typeof m.p1.cpuCores === 'number' && typeof m.p2.cpuCores === 'number')
        ? ' · ' + m.p1.cpuCores.toFixed(1) + '/' + m.p2.cpuCores.toFixed(1) + ' CPU'
        : '';
      const tip = m.category + ' · ' + Math.round(m.p1.meanTurnMillis) + 'ms/' +
        Math.round(m.p2.meanTurnMillis) + 'ms · Bank ' + b1 + 's/' + b2 + 's · RAM ' +
        Math.round(m.p1.peakRam).toLocaleString('en-US') + 'M/' +
        Math.round(m.p2.peakRam).toLocaleString('en-US') + 'M' + cpuSuffix + reasons;

      const tr = document.createElement('tr');
      tr.id = m.id;
      tr.className = 'battle-row' + (expanded ? ' expanded' : '');
      tr.dataset.fmt = m.slot;
      tr.tabIndex = 0;
      tr.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      tr.innerHTML = '<td><span class="battle-toggle" aria-hidden="true">&#9656;</span><code>' +
        esc(m.id) + '</code></td>' +
        '<td>' + renderAgent(m.p1, r.p1Win) + '</td>' +
        '<td>' + renderAgent(m.p2, r.p2Win) + '</td>' +
        '<td class="center" title="' + esc(tip) + '">' + r.html + '</td>' +
        '<td class="num muted" title="' + esc(localTimestamp(m.completedAt)) +
        '" data-ts="' + m.completedAt + '">' +
        relTime(nowSec, m.completedAt) + '</td>';

      const detailTr = document.createElement('tr');
      detailTr.className = 'battle-detail-row' + (expanded ? '' : ' hide');
      detailTr.dataset.detailFor = m.id;
      detailTr.innerHTML = '<td colspan="5">' + renderMatchDetailHtml(m) + '</td>';
      if (expanded) {
        const slot = detailTr.querySelector('.battle-detail[data-match-id]');
        if (slot) void loadRowReplay(slot, 1);
      }

      return [tr, detailTr];
    };

    const toggleRow = (row, forceOpen) => {
      const detail = row.nextElementSibling;
      if (!detail || !detail.classList.contains('battle-detail-row')) return;
      const open = forceOpen !== undefined ? forceOpen : detail.classList.contains('hide');
      detail.classList.toggle('hide', !open);
      row.classList.toggle('expanded', open);
      row.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) {
        const slot = detail.querySelector('.battle-detail[data-match-id]');
        if (slot && !slot._loadedLogUrl) {
          void loadRowReplay(slot, 1);
        }
      }
    };

    if (tbody) {
      tbody.addEventListener('click', e => {
        const replayLink = e.target.closest('a[data-replay-log]');
        if (replayLink) {
          const detailRow = replayLink.closest('tr.battle-detail-row');
          const slot = detailRow
            ? detailRow.querySelector('.battle-detail[data-match-id]')
            : undefined;
          if (slot) {
            e.preventDefault();
            const gNum = Number(replayLink.getAttribute('data-replay-game')) || 1;
            void loadRowReplay(slot, gNum);
            return;
          }
        }
        if (e.target.closest('a')) return;
        const row = e.target.closest('tr.battle-row');
        if (row) toggleRow(row);
      });
      tbody.addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const row = e.target.closest('tr.battle-row');
        if (row && e.target === row) {
          e.preventDefault();
          toggleRow(row);
        }
      });
    }

    const updatePager = (page, total) => {
      updateTablePager(pager, page, total, pageSize);
    };

    const trimHistoryRows = () => {
      if (!tbody) return;
      const summaryRows = tbody.querySelectorAll('tr.battle-row');
      for (let i = summaryRows.length - 1; i >= pageSize; i--) {
        const row = summaryRows[i];
        if (row.classList.contains('expanded')) continue;
        const detail = row.nextElementSibling;
        if (detail && detail.classList.contains('battle-detail-row')) detail.remove();
        row.remove();
      }
    };

    const refreshTimestamps = nowSec => {
      if (!tbody) return;
      tbody.querySelectorAll('td[data-ts]').forEach(td => {
        const ts = Number(td.getAttribute('data-ts'));
        if (Number.isFinite(ts)) td.textContent = relTime(nowSec, ts);
      });
    };

    const refreshCurrentPagerCount = () => {
      if (!state) return;
      const counts = state.countsBySlot;
      if (currentFmt === 'all') {
        const total = (counts && counts.all !== undefined)
          ? counts.all
          : (state.totalMatches || (state.recentMatches ? state.recentMatches.length : 0));
        updatePager(currentPage, total);
      } else if (counts && counts[currentFmt] !== undefined) {
        updatePager(currentPage, counts[currentFmt]);
      }
    };

    const prependMatchIfVisible = (m, nowSec) => {
      if (!m || !m.id) return;
      if (!Array.isArray(state.recentMatches)) state.recentMatches = [];
      if (!state.recentMatches.some(existing => existing.id === m.id)) {
        state.recentMatches.unshift(m);
        if (state.recentMatches.length > pageSize) {
          state.recentMatches.length = pageSize;
        }
      }
      if (
        tbody &&
        currentPage === 1 &&
        (currentFmt === 'all' || m.slot === currentFmt) &&
        !document.getElementById(m.id)
      ) {
        const emptyRow = tbody.querySelector('.empty-row');
        if (emptyRow) emptyRow.remove();
        const pair = renderMatchPair(m, nowSec, false);
        tbody.insertBefore(pair[1], tbody.firstChild);
        tbody.insertBefore(pair[0], pair[1]);
        trimHistoryRows();
      }
    };

    const renderHistoryList = (matches, nowSec) => {
      if (!tbody) return;
      const expandedIds = new Set();
      tbody.querySelectorAll('tr.battle-row.expanded').forEach(r => {
        if (r.id) expandedIds.add(r.id);
      });
      if (!matches || matches.length === 0) {
        tbody.innerHTML = '<tr class="empty-row"><td colspan="5" class="center muted">' +
          'No completed battles yet.</td></tr>';
        return;
      }
      const frag = document.createDocumentFragment();
      for (const m of matches) {
        const pair = renderMatchPair(m, nowSec, expandedIds.has(m.id));
        frag.appendChild(pair[0]);
        frag.appendChild(pair[1]);
      }
      tbody.innerHTML = '';
      tbody.appendChild(frag);
    };

    const loadHistoryPage = async (fmt, page, scrollHistory) => {
      currentFmt = fmt;
      currentPage = page;
      const seq = ++fetchSeq;
      const nowSec = Math.floor(Date.now() / 1000);

      if (fmt === 'all' && page === 1 && state && Array.isArray(state.recentMatches)) {
        renderHistoryList(state.recentMatches, nowSec);
        const total = (state.countsBySlot && state.countsBySlot.all !== undefined)
          ? state.countsBySlot.all
          : (state.totalMatches || state.recentMatches.length);
        updatePager(1, total);
        if (scrollHistory) {
          const hist = document.getElementById('history');
          if (hist) hist.scrollIntoView();
        }
        return;
      }

      try {
        const qs = '?slot=' + encodeURIComponent(fmt) + '&page=' + page + '&limit=' + pageSize;
        const res = await fetch(historyEndpoint + qs, {
          cache: 'no-cache',
          headers: {Accept: 'application/json'},
        });
        if (!res.ok) throw new Error('status ' + res.status);
        const data = await res.json();
        if (seq !== fetchSeq) return;
        if (state && data.countsBySlot) state.countsBySlot = data.countsBySlot;
        renderHistoryList(data.matches || [], Math.floor(Date.now() / 1000));
        updatePager(data.page || page, data.total || 0);
        if (scrollHistory) {
          const hist = document.getElementById('history');
          if (hist) hist.scrollIntoView();
        }
      } catch {
        if (seq !== fetchSeq) return;
        if (page === 1 && state && Array.isArray(state.recentMatches)) {
          const filtered = fmt === 'all'
            ? state.recentMatches
            : state.recentMatches.filter(m => m.slot === fmt);
          renderHistoryList(filtered, nowSec);
          const fallbackTotal = (state.countsBySlot && state.countsBySlot[fmt] !== undefined)
            ? state.countsBySlot[fmt]
            : filtered.length;
          updatePager(1, fallbackTotal);
        }
      }
    };

    radios.forEach(r => r.addEventListener('change', () => {
      loadHistoryPage(r.value, 1, false);
    }));

    if (prevBtn) {
      prevBtn.addEventListener('click', () => {
        if (currentPage > 1) loadHistoryPage(currentFmt, currentPage - 1, true);
      });
    }
    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        loadHistoryPage(currentFmt, currentPage + 1, true);
      });
    }

    const checkHash = async () => {
      if (!location.hash) return;
      const id = decodeURIComponent(location.hash.slice(1));
      if (!id || id === 'live' || id === 'history') return;
      const el = document.getElementById(id);
      if (el && el.tagName === 'TR') {
        el.classList.remove('hide');
        toggleRow(el, true);
        el.scrollIntoView();
        return;
      }
      try {
        const res = await fetch(historyEndpoint + '?id=' + encodeURIComponent(id), {
          cache: 'no-cache',
          headers: {Accept: 'application/json'},
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!data || !data.match || !tbody) return;
        const existing = document.getElementById(data.match.id);
        if (existing && existing.tagName === 'TR') {
          toggleRow(existing, true);
          existing.scrollIntoView();
          return;
        }
        const emptyRow = tbody.querySelector('.empty-row');
        if (emptyRow) emptyRow.remove();
        const pair = renderMatchPair(data.match, Math.floor(Date.now() / 1000), true);
        tbody.insertBefore(pair[1], tbody.firstChild);
        tbody.insertBefore(pair[0], pair[1]);
        pair[0].scrollIntoView();
      } catch {}
    };
    window.addEventListener('hashchange', checkHash);
    checkHash();
    refreshTimestamps(Math.floor(Date.now() / 1000));

    let tickCount = 0;
    setInterval(() => {
      tickCount++;
      const nowSec = Math.floor(Date.now() / 1000);
      const hbEl = document.getElementById('hb-age');
      if (hbEl && state) {
        hbEl.textContent = Math.max(0, nowSec - state.updatedAt) + 's';
      }
      if (state && state.live && !state.stale && state.live.activeSlot) {
        const key = state.live.activeSlot;
        const slot = state.live[key];
        if (slot) {
          const dt = Math.max(0, nowSec - state.live.turnStartedAt);
          const turnEl = document.getElementById('turn-' + key);
          const bankEl = document.getElementById('bank-' + key);
          const fmtId = String(state.live.format || '').toLowerCase();
          const isVgcPreview =
            state.live.phase === 'preview' &&
            (fmtId.includes('vgc') || fmtId.includes('bss'));
          if (turnEl) turnEl.textContent = dt + 's';
          if (bankEl && state.live.phase !== 'init' && !isVgcPreview) {
            bankEl.textContent = Math.max(0, Math.round(slot.bankSeconds - dt)) + 's';
          }
        }
      }
      if (tickCount % 15 === 0) {
        refreshTimestamps(nowSec);
      }
    }, 1000);

    const restartBannerText = ${safeInlineJson(build.ARENA_RESTART_BANNER_TEXT)};
    const syncRestartBanner = () => {
      const show = Boolean(
        state && state.restarting && !state.stale &&
        !(state.runningTournament && state.runningTournament.id)
      );
      const existing = document.getElementById('topbar');
      if (show) {
        if (!existing) {
          const hdr = document.querySelector('header');
          if (hdr) {
            const bar = document.createElement('div');
            bar.id = 'topbar';
            bar.className = 'restarting';
            bar.textContent = restartBannerText;
            hdr.insertBefore(bar, hdr.firstChild);
          }
        }
      } else if (existing && existing.classList.contains('restarting')) {
        existing.remove();
      }
    };

    const liveKey = doc => {
      const tourId = (doc && doc.runningTournament && doc.runningTournament.id) || '';
      if (doc && doc.live && !doc.stale) {
        return doc.live.matchId + ':' + doc.live.heartbeatSeq + ':' + doc.stale + ':' + tourId;
      }
      const smokeKey = (
        doc && doc.smokeTesting && (doc.smokeTesting.slug || doc.smokeTesting.name)
      ) || '';
      return 'idle:' + Boolean(doc && doc.stale) + ':' + smokeKey + ':' + tourId;
    };

    const applySnapshot = next => {
      if (!next) return;
      const nowSec = Math.floor(Date.now() / 1000);
      const prevKey = liveKey(state);
      const nextKey = liveKey(next);
      state = next;
      syncRestartBanner();
      if (prevKey !== nextKey) {
        renderLive(nowSec);
      }
      if (Array.isArray(next.recentMatches) && next.recentMatches.length > 0) {
        for (let i = next.recentMatches.length - 1; i >= 0; i--) {
          prependMatchIfVisible(next.recentMatches[i], nowSec);
        }
      }
      refreshCurrentPagerCount();
      refreshTimestamps(nowSec);
    };

    if (typeof EventSource !== 'undefined') {
      const es = new EventSource('/api/battles/stream');
      es.addEventListener('snapshot', ev => {
        try {
          applySnapshot(JSON.parse(ev.data));
        } catch {}
      });
      es.addEventListener('live', ev => {
        try {
          const data = JSON.parse(ev.data);
          const nowSec = Math.floor(Date.now() / 1000);
          state.updatedAt = data.updatedAt || nowSec;
          state.stale = Boolean(data.stale);
          state.restarting = !state.stale && Boolean(data.restarting);
          state.smokeTesting = state.stale ? undefined : data.smokeTesting;
          state.live = state.stale ? undefined : data.live;
          state.runningTournament = data.runningTournament;
          syncRestartBanner();
          renderLive(nowSec);
        } catch {}
      });
      es.addEventListener('match', ev => {
        try {
          const data = JSON.parse(ev.data);
          const nowSec = Math.floor(Date.now() / 1000);
          state.updatedAt = data.updatedAt || nowSec;
          state.stale = Boolean(data.stale);
          state.restarting = !state.stale && Boolean(data.restarting);
          state.smokeTesting = state.stale ? undefined : data.smokeTesting;
          state.live = state.stale ? undefined : data.live;
          state.runningTournament = data.runningTournament;
          if (data.totalMatches !== undefined) state.totalMatches = data.totalMatches;
          if (data.countsBySlot) state.countsBySlot = data.countsBySlot;
          syncRestartBanner();
          renderLive(nowSec);
          if (data.match) {
            prependMatchIfVisible(data.match, nowSec);
          }
          refreshCurrentPagerCount();
          refreshTimestamps(nowSec);
        } catch {}
      });
    } else {
      const pollLive = async () => {
        try {
          const res = await fetch('/api/live.json', {
            cache: 'no-cache',
            headers: {Accept: 'application/json'},
          });
          if (!res.ok) return;
          applySnapshot(await res.json());
        } catch {}
      };
      pollLive();
      setInterval(pollLive, 3000);
    }
  });
`;
}

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

export interface PairingAgentSummary {
  slug?: string;
  name?: string;
  version?: string;
}

export interface LadderPairingSummary {
  low: PairingAgentSummary;
  high: PairingAgentSummary;
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
  publicDir?: string;
  staticDir?: string;
  avatarsDir?: string;
  now?: () => number;
}

export interface ProjectMeta {
  id: string;
  site?: string;
  company?: projects.Project['company'];
  active?: number | [number, number];
  license?: string;
  source?: string;
  engine?: projects.Project['engine'];
  language?: string | string[];
}

// Escapes `<` as `\u003c` so inline `<script>` JSON payloads can never break out via `</script>`.
export function safeInlineJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  return JSON.stringify(value).replace(/</g, '\\u003c');
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

export interface LogoSize {
  width: number;
  height: number;
}

const projectMetaCache = new Map<
  string,
  {mtimeMs: number; meta: Map<string, ProjectMeta>; logoSizes: Map<string, LogoSize>}
>();

function loadProjectCatalog(
  staticDir: string
): {meta: Map<string, ProjectMeta>; logoSizes: Map<string, LogoSize>} {
  const file = path.join(staticDir, 'projects.yml');
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return {meta: new Map(), logoSizes: new Map()};
  }
  const hit = projectMetaCache.get(file);
  if (hit?.mtimeMs === mtimeMs) return {meta: hit.meta, logoSizes: hit.logoSizes};

  const meta = new Map<string, ProjectMeta>();
  const logoSizes = new Map<string, LogoSize>();
  const parsed = yaml.parse(fs.readFileSync(file, 'utf8')) as projects.Project[] | undefined;
  if (Array.isArray(parsed)) {
    for (const p of parsed) {
      if (!p.name) continue;
      const id = p.name.replaceAll(' ', '');
      meta.set(p.name, {
        id,
        site: p.site,
        company: p.company,
        active: p.active,
        license: p.license,
        source: p.source,
        engine: p.engine,
        language: p.language,
      });
      const logo = p.arena?.logo;
      if (
        logo &&
        typeof logo === 'object' &&
        Number.isInteger(logo.width) &&
        logo.width > 0 &&
        Number.isInteger(logo.height) &&
        logo.height > 0
      ) {
        logoSizes.set(p.name, {width: logo.width, height: logo.height});
      }
    }
  }
  projectMetaCache.set(file, {mtimeMs, meta, logoSizes});
  return {meta, logoSizes};
}

const arenaBlurbCache = new Map<string, {mtimeMs: number; html: string}>();

function loadArenaBlurbHtml(staticDir: string): string {
  const file = path.join(staticDir, 'arena.dj');
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return '';
  }
  const hit = arenaBlurbCache.get(file);
  if (hit?.mtimeMs === mtimeMs) return hit.html;
  const html = site.html.render(fs.readFileSync(file, 'utf8'));
  arenaBlurbCache.set(file, {mtimeMs, html});
  return html;
}

export interface AgentLinkContext {
  publicDir: string;
  projectMeta: ReadonlyMap<string, ProjectMeta>;
  logoSizes?: ReadonlyMap<string, LogoSize>;
  profileSlugs?: ReadonlySet<string>;
}

export function resolveAgentHref(
  links: AgentLinkContext,
  slug: string,
  name: string
): string | undefined {
  const {projectMeta, profileSlugs} = links;
  if (profileSlugs?.has(slug)) {
    return `/projects/${encodeURIComponent(slug)}/`;
  }
  const meta = projectMeta.get(name);
  if (meta) {
    return `/projects/#${meta.id}`;
  }
  return undefined;
}

function renderAgentLink(
  name: string,
  href: string | undefined,
  bold: boolean
): util.Child {
  const inner = bold ? <strong>{name}</strong> : name;
  if (!href) return inner;
  return <a href={href} className='subtle'>{inner}</a>;
}

export function formatAgentLink(
  name: string,
  href: string | undefined,
  bold: boolean
): string {
  return String(<>{renderAgentLink(name, href, bold)}</>);
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

function computeStreakLabel(entry: db.LeaderboardEntryView): {
  text: string;
  node: util.Child;
} {
  if (entry.currentWinStreak >= 3) {
    const s = `W${entry.currentWinStreak}`;
    return {text: s, node: <span className='yes'>{s}</span>};
  }
  if (entry.currentWinStreak >= 1) {
    const s = `W${entry.currentWinStreak}`;
    return {text: s, node: s};
  }
  if (entry.currentLossStreak >= 3) {
    const s = `L${entry.currentLossStreak}`;
    return {text: s, node: <span className='no'>{s}</span>};
  }
  if (entry.currentLossStreak >= 1) {
    const s = `L${entry.currentLossStreak}`;
    return {text: s, node: s};
  }
  if (entry.matches > 0) {
    return {text: 'T1', node: 'T1'};
  }
  return {text: '—', node: <span className='muted'>—</span>};
}

export interface AdjacentLosOptions {
  targetVersionIds?: ReadonlySet<number>;
  loadAllPairs?: () => db.PairAggregateRow[];
}

// Computes pairwise Likelihood of Superiority (LOS) for each ranked entrant against the entrant
// ranked immediately below them (`#r` vs `#(r+1)`). Uses precomputed `pair_aggregates.low_los`
// when the two versions have already faced each other, falling back to a single warm-started
// Davidson covariance solve over the full ladder graph when an adjacent pair has 0 direct games.
export function computeAdjacentLosMap(
  entries: db.LeaderboardEntryView[],
  pairs: db.PairAggregateRow[],
  ladderStatus?: db.LadderStatus,
  opts?: AdjacentLosOptions
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

  let fallbackSolve: ReturnType<typeof ratings.solveIndexedDavidson> | undefined;

  for (let r = 0; r < ranked.length - 1; r++) {
    const cur = ranked[r];
    if (opts?.targetVersionIds && !opts.targetVersionIds.has(cur.versionId)) continue;
    const next = ranked[r + 1];
    const lowId = Math.min(cur.versionId, next.versionId);
    const highId = Math.max(cur.versionId, next.versionId);
    const pair = pairMap.get(`${lowId}:${highId}`);
    if (pair?.lowLos !== undefined) {
      const los = cur.versionId === lowId ? pair.lowLos : 1 - pair.lowLos;
      result.set(cur.versionId, los);
    } else {
      fallbackSolve ??= ratings.solveIndexedDavidson(
        entries,
        opts?.loadAllPairs ? opts.loadAllPairs() : pairs
      );
      const idxCur = fallbackSolve.indexByVer.get(cur.versionId);
      const idxNext = fallbackSolve.indexByVer.get(next.versionId);
      if (idxCur !== undefined && idxNext !== undefined) {
        const los = ratings.computeLOS(
          fallbackSolve.theta,
          fallbackSolve.covariance,
          fallbackSolve.indexByVer.size,
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

function selectTopHistoryAgents(
  ladder: db.LadderRow,
  entries: db.LeaderboardEntryView[]
): db.LeaderboardEntryView[] {
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

  return [...bestActiveByAgent.values()]
    .sort((a, b) => {
      if (a.rankCurrent !== undefined && b.rankCurrent !== undefined) {
        return a.rankCurrent - b.rankCurrent;
      }
      if (a.rankCurrent !== undefined) return -1;
      if (b.rankCurrent !== undefined) return 1;
      return b.lcb - a.lcb || b.elo - a.elo;
    })
    .slice(0, SERIES_COLORS.length);
}

function renderHistorySection(
  ladder: db.LadderRow,
  topAgents: db.LeaderboardEntryView[],
  snapshots: db.LadderSnapshotHistoryRow[],
  nowSec: number
): {node: util.Child; isEmpty: boolean} {
  const isArchived = ladder.status === 'archived';
  if (topAgents.length === 0) {
    return {
      node: <p className='empty-state muted'>No rating history yet.</p>,
      isEmpty: true,
    };
  }

  const endRefSec = isArchived ? (ladder.archivedAt ?? nowSec) : nowSec;
  const todayUtc = util.formatUtcDate(endRefSec);
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
  const minDayMillis = allDays.length > 0 ? util.parseUtcDayMillis(allDays[0]) : 0;
  const maxDayMillis =
    allDays.length > 0 ? util.parseUtcDayMillis(allDays[allDays.length - 1]) : 0;

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
    const frac = (util.parseUtcDayMillis(day) - minDayMillis) / (maxDayMillis - minDayMillis);
    return Math.round((xLeft + frac * (xRight - xLeft)) * 10) / 10;
  };
  const mapY = (elo: number): number => {
    const clamped = Math.max(axisMin, Math.min(axisMax, elo));
    const frac = (axisMax - clamped) / Math.max(1, axisMax - axisMin);
    return Math.round((yTop + frac * (yBottom - yTop)) * 10) / 10;
  };

  const gridLines: util.Child[] = [];
  const yLabels: util.Child[] = [];
  for (let tick = axisMax; tick >= axisMin; tick -= 150) {
    const y = mapY(tick);
    gridLines.push(
      tick === 1500 ? (
        <line
          x1={xLeft}
          y1={y}
          x2={xRight}
          y2={y}
          stroke-opacity='0.28'
          stroke-dasharray='3,3'
        />
      ) : (
        <line x1={xLeft} y1={y} x2={xRight} y2={y} />
      )
    );
    yLabels.push(<text x='38' y={y + 4}>{tick}</text>);
  }
  gridLines.push(<line x1={xLeft} y1='215' x2={xRight} y2='215' />);

  const xLabels: util.Child[] = [];
  if (maxDayMillis <= minDayMillis) {
    xLabels.push(<text x={xLeft} y='234'>{formatShortDay(allDays[0])}</text>);
    const endLabel = isArchived ? formatShortDay(todayUtc) : 'Today';
    xLabels.push(<text x={xRight} y='234'>{endLabel}</text>);
  } else {
    const seenTickX = new Set<number>();
    const tickCount = Math.min(5, allDays.length);
    for (let k = 0; k < tickCount; k++) {
      const targetMillis = minDayMillis + (k / (tickCount - 1)) * (maxDayMillis - minDayMillis);
      let bestDay = allDays[0];
      let bestDist = Infinity;
      for (const d of allDays) {
        const dist = Math.abs(util.parseUtcDayMillis(d) - targetMillis);
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
      xLabels.push(<text x={x} y='234'>{label}</text>);
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
  const svgElements: util.Child[] = [];

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

    if (aIdx === 0 && coords.length >= 2 && !agent.isAnchor) {
      const upper = coords.map(c => `${c.x},${mapY(c.pt.elo + 1.96 * c.pt.se)}`);
      const lower = [...coords].reverse().map(c => `${c.x},${mapY(c.pt.elo - 1.96 * c.pt.se)}`);
      svgElements.push(
        <polygon points={[...upper, ...lower].join(' ')} fill={color} fill-opacity='0.1' />
      );
    }

    const strokeW = aIdx === 0 ? '2.25' : aIdx === 1 ? '1.85' : '1.75';
    const polyPts = coords.map(c => `${c.x},${c.y}`).join(' ');
    svgElements.push(
      <polyline fill='none' stroke={color} stroke-width={strokeW} points={polyPts} />
    );

    for (let k = 1; k < pts.length; k++) {
      if (pts[k].versionId !== pts[k - 1].versionId) {
        const cx = mapX(pts[k].day);
        const cy = mapY(pts[k].elo);
        svgElements.push(
          <circle cx={cx} cy={cy} r='2.5' fill={color} title={pts[k].version} />
        );
      }
    }

    const lastCoord = coords[coords.length - 1];
    if (aIdx === 0) {
      svgElements.push(<circle cx={lastCoord.x} cy={lastCoord.y} r='3' fill={color} />);
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
    <text
      x='632'
      y={Math.round(l.y * 10) / 10}
      fill={l.color}
      font-size='11'
      font-weight={l.bold ? 'bold' : undefined}
    >
      {l.text}
    </text>
  ));

  const ariaLabel = `${ladder.name} Top Agent Rating History`;
  return {
    node: (
      <figure className='chart'>
        <svg viewBox='0 0 760 245' role='img' aria-label={ariaLabel}>
          <g stroke='currentColor' stroke-opacity='0.12' stroke-width='1'>
            {gridLines}
          </g>
          <g fill='currentColor' fill-opacity='0.5' font-size='11' text-anchor='end'>
            {yLabels}
          </g>
          <g fill='currentColor' fill-opacity='0.5' font-size='11' text-anchor='middle'>
            {xLabels}
          </g>
          {svgElements}
          {labelEls}
        </svg>
      </figure>
    ),
    isEmpty: false,
  };
}

function renderMatchupsSection(
  entries: db.LeaderboardEntryView[],
  pairs: db.PairAggregateRow[],
  links: AgentLinkContext,
  ladderStatus?: db.LadderStatus
): {node: util.Child; isEmpty: boolean} {
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
      node: <p className='empty-state muted'>Not enough entrants for matchups yet.</p>,
      isEmpty: true,
    };
  }

  const pairMap = new Map<string, db.PairAggregateRow>();
  for (const p of pairs) {
    pairMap.set(`${p.lowVersionId}:${p.highVersionId}`, p);
  }

  // Note: `&nbsp;` prevents `site`'s `html-minifier` (`removeEmptyElements: true`)
  // from stripping the top-left corner `<th>` cell.
  const colHeaders = participants.map(p => <th>{p.agentName}</th>);

  const bodyRows = participants.map(rowEntry => {
    const rowHref = resolveAgentHref(links, rowEntry.agentSlug, rowEntry.agentName);

    const cells = participants.map(colEntry => {
      if (rowEntry.versionId === colEntry.versionId) {
        return <td className='diag'>—</td>;
      }
      const lowId = Math.min(rowEntry.versionId, colEntry.versionId);
      const highId = Math.max(rowEntry.versionId, colEntry.versionId);
      const pair = pairMap.get(`${lowId}:${highId}`);
      if (!pair) {
        return <td className='muted'>—</td>;
      }
      const isLow = rowEntry.versionId === lowId;
      const wins = isLow ? pair.ww + pair.wt : pair.ll + pair.tl;
      const losses = isLow ? pair.ll + pair.tl : pair.ww + pair.wt;
      const ties = pair.split;
      const total = wins + losses + ties;
      if (total === 0) {
        return <td className='muted'>—</td>;
      }
      const scorePct = ((wins + 0.5 * ties) / total) * 100;
      const scoreStr = `${scorePct.toFixed(1)}%`;
      const cls = heatmapClass(scorePct);
      const losPart = pair.lowLos !== undefined
        ? ` · LOS ${((isLow ? pair.lowLos : 1 - pair.lowLos) * 100).toFixed(1)}%`
        : '';
      const tip = `${wins}W–${losses}L–${ties}T (${total} matches)${losPart}`;
      return (
        <td className={cls || undefined} title={tip}>
          {scorePct > 50 ? <strong>{scoreStr}</strong> : scoreStr}
          <span className='sub'>{wins}–{losses}–{ties}</span>
        </td>
      );
    });

    return (
      <tr>
        <td>
          {renderAgentLink(rowEntry.agentName, rowHref, true)}{' '}
          <code className='muted'>{rowEntry.version}</code>
        </td>
        {cells}
      </tr>
    );
  });

  return {
    node: (
      <div className='table-wrap'>
        <table className='matrix'>
          <thead>
            <tr>
              <th>{util.raw('&nbsp;')}</th>
              {colHeaders}
            </tr>
          </thead>
          <tbody>
            {bodyRows}
          </tbody>
        </table>
      </div>
    ),
    isEmpty: false,
  };
}

function buildStandingsLadder(
  l: db.LadderRow,
  entries: db.LeaderboardEntryView[],
  pairs: db.PairAggregateRow[],
  urlKey: string,
  publicDir: string
): StandingsLadder {
  const adjacentLos = computeAdjacentLosMap(entries, pairs, l.status);
  const isArchived = l.status === 'archived';
  const hasFrozenRanked = isArchived && entries.some(e => e.rankCurrent !== undefined);
  const jsonRows: StandingsEntry[] = [];

  if (l.status === 'upcoming') {
    const activeEntrants = entries
      .filter(e => e.role === 'champion' || e.role === 'challenger')
      .sort((a, b) => a.submittedAt - b.submittedAt || a.versionId - b.versionId);
    for (const e of activeEntrants) {
      jsonRows.push({
        slug: e.agentSlug,
        name: e.agentName,
        version: e.version,
        role: e.role,
        isAnchor: e.isAnchor,
        provisional: true,
        settled: false,
        elo: Math.round(e.elo),
        se: Math.round(e.se * 10) / 10,
        ci95: e.isAnchor ? 0 : Math.round(1.96 * e.se),
        lcb: Math.round(e.lcb),
        gxe: Math.round(e.gxe * 10) / 10,
        wins: e.ww + e.wt,
        losses: e.ll + e.tl,
        ties: e.split,
        matches: e.matches,
        streak: '—',
      });
    }
  } else {
    const seenPrimaryAgent = new Set<number>();
    const seenAnyAgent = new Set<number>();
    for (const e of entries) {
      const isFirstForAgent = !seenAnyAgent.has(e.agentId);
      if (isFirstForAgent) seenAnyAgent.add(e.agentId);
      const isEffectiveActive = isArchived
        ? (hasFrozenRanked ? e.rankCurrent !== undefined : isFirstForAgent)
        : (e.role === 'champion' || e.role === 'challenger');
      const isProvisional = isEffectiveActive && (e.matches < 10 || e.se > 60);
      const isBestActive = isEffectiveActive && !seenPrimaryAgent.has(e.agentId);
      if (isBestActive) seenPrimaryAgent.add(e.agentId);
      const isRankedPrimary =
        isEffectiveActive && !isProvisional && isBestActive && e.rankCurrent !== undefined;
      const streak = computeStreakLabel(e);
      const adjLos = isRankedPrimary ? adjacentLos.get(e.versionId) : undefined;
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
        elo: Math.round(e.elo),
        se: Math.round(e.se * 10) / 10,
        ci95: e.isAnchor ? 0 : Math.round(1.96 * e.se),
        lcb: Math.round(e.lcb),
        gxe: Math.round(e.gxe * 10) / 10,
        wins: e.ww + e.wt,
        losses: e.ll + e.tl,
        ties: e.split,
        matches: e.matches,
        streak: streak.text,
        losNext: adjLos !== undefined ? Math.round(adjLos * 1000) / 10 : undefined,
      });
    }
  }

  const archive = arena.resolveLadderArchive(publicDir, l);
  const urlEnc = encodeURIComponent(urlKey);
  const teamsHref = l.team === 'pools' && l.status === 'archived'
    ? `/arena/ladders/${urlEnc}/teams.json`
    : undefined;

  return {
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
}

function buildLadderDocument(opts: {
  ladder: db.LadderRow;
  urlKey: string;
  db: db.Database;
  publicDir: string;
}): LadderDocument {
  const {ladder: l, urlKey, db, publicDir} = opts;
  const entries = db.getLeaderboardEntries(l.id);
  const pairs = db.getPairAggregatesForLadder(l.id);
  const snapshots = db.getRatingSnapshotsForLadder(l.id).sort((a, b) => (
    a.dayUtc < b.dayUtc ? -1 : a.dayUtc > b.dayUtc ? 1 : a.versionId - b.versionId
  ));
  const standingsLadder = buildStandingsLadder(l, entries, pairs, urlKey, publicDir);
  const entryByVer = new Map(entries.map(e => [e.versionId, e]));
  return {
    ...standingsLadder,
    pairings: pairs.map(p => {
      const low = entryByVer.get(p.lowVersionId);
      const high = entryByVer.get(p.highVersionId);
      return {
        low: {
          slug: low?.agentSlug,
          name: low?.agentName,
          version: low?.version,
        },
        high: {
          slug: high?.agentSlug,
          name: high?.agentName,
          version: high?.version,
        },
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
}

function renderLadderHtml(opts: {
  ladder: db.LadderRow;
  currentLadders: db.LadderRow[];
  allLadders: db.LadderRow[];
  urlKey: string;
  db: db.Database;
  renderer: build.Renderer;
  links: AgentLinkContext;
  restarting?: boolean;
  nowSec: number;
}): string {
  const {
    ladder: l,
    currentLadders,
    allLadders,
    urlKey,
    db,
    renderer,
    links,
    restarting,
    nowSec,
  } = opts;
  const {publicDir, projectMeta} = links;
  const entries = db.getLeaderboardEntries(l.id);
  const pairs = db.getPairAggregatesForLadder(l.id);
  const topHistoryAgents = selectTopHistoryAgents(l, entries);
  const snapshots = topHistoryAgents.length > 0
    ? db.getRatingSnapshotsForLadder(l.id, topHistoryAgents.map(a => a.agentId))
    : [];
  const adjacentLos = computeAdjacentLosMap(entries, pairs, l.status);
  const isArchived = l.status === 'archived';
  const hasFrozenRanked = isArchived && entries.some(e => e.rankCurrent !== undefined);

  const seasonRank: Record<db.LadderStatus, number> = {
    active: 0,
    upcoming: 0,
    settling: 1,
    archived: 2,
  };
  const slotSeasons = allLadders
    .filter(s => s.slot === l.slot)
    .sort(
      (a, b) =>
        seasonRank[a.status] - seasonRank[b.status] ||
        b.createdAt - a.createdAt ||
        b.id.localeCompare(a.id)
    );
  const multiSeason = slotSeasons.length > 1;

  const formatNavItems: util.Child[] = [];
  currentLadders.forEach((other, idx) => {
    if (idx > 0) formatNavItems.push(' — ');
    const href = `/arena/ladders/${encodeURIComponent(other.slot)}/`;
    const isCurrent = other.slot === l.slot;
    formatNavItems.push(
      <li id={other.slot}>
        <a href={href} className='subtle' aria-current={isCurrent ? 'page' : undefined}>
          {isCurrent ? <strong>{other.name}</strong> : other.name}
        </a>
      </li>
    );
  });

  const seenPrimaryAgent = new Set<number>();
  const seenAnyAgent = new Set<number>();
  let standingsPane: util.Child;

  const upcomingEmptyMsg =
    `The ${l.name} ladder is upcoming — accepting initial entries before matchmaking begins.`;
  if (entries.length === 0) {
    const msg = l.status === 'upcoming'
      ? upcomingEmptyMsg
      : isArchived
        ? `The ${l.name} ladder was archived with no completed entries.`
        : `No active entries on the ${l.name} ladder yet.`;
    standingsPane = <p className='empty-state muted'>{msg}</p>;
  } else if (l.status === 'upcoming') {
    const activeEntrants = entries
      .filter(e => e.role === 'champion' || e.role === 'challenger')
      .sort((a, b) => a.submittedAt - b.submittedAt || a.versionId - b.versionId);
    standingsPane = activeEntrants.length === 0 ? (
      <p className='empty-state muted'>{upcomingEmptyMsg}</p>
    ) : (
      <util.PaginatedTable
        className='standings-table'
        head={(
          <tr>
            <th>#</th>
            <th>Agent</th>
            <th className='num'>Submitted</th>
          </tr>
        )}
        pager={{
          id: 'standings-pager',
          label: 'Entrants pagination',
          total: activeEntrants.length,
          singular: 'entrant',
          plural: 'entrants',
        }}
      >
        {activeEntrants.map((e, idx) => {
          const href = resolveAgentHref(links, e.agentSlug, e.agentName);
          return (
            <tr
              data-active='true'
              className={idx >= util.TABLE_PAGE_SIZE ? 'hide' : undefined}
            >
              <td><strong>{idx + 1}</strong></td>
              <td>
                {renderAgentLink(e.agentName, href, true)}{' '}
                <code className='muted'>{e.version}</code>
              </td>
              <td className='num muted'>
                <util.Time
                  epoch={e.submittedAt}
                  format='date'
                  title={[{prefix: 'Submitted ', epoch: e.submittedAt}]}
                />
              </td>
            </tr>
          );
        })}
      </util.PaginatedTable>
    );
  } else {
    let activeCount = 0;
    const rows = entries.map(e => {
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
      let rowTitle: string | undefined;

      if (isRetired) {
        classes.push('secondary', 'hide');
      } else {
        activeCount++;
        if (isProvisional) {
          classes.push('provisional');
          if (isSecondaryActive) classes.push('secondary');
          rowTitle = 'Provisional (< 10 matches or SE > 60 Elo)';
        } else if (isSecondaryActive) {
          classes.push('secondary');
        }
        if (activeCount > util.TABLE_PAGE_SIZE) {
          classes.push('hide');
        }
      }

      let rankCell: util.Child;
      if (isRankedPrimary) {
        rankCell = <td><strong>{e.rankCurrent}</strong></td>;
      } else if (isRetired) {
        rankCell = <td className='muted' title='Retired version'>—</td>;
      } else if (isSecondaryActive) {
        const anchorNote = e.isAnchor ? ' (1500 Elo anchor)' : '';
        rankCell = <td className='muted' title={`Secondary active version${anchorNote}`}>—</td>;
      } else {
        rankCell = <td className='muted'>—</td>;
      }

      const href = resolveAgentHref(links, e.agentSlug, e.agentName);
      const meta = projectMeta.get(e.agentName);
      const agentCell = (
        <td>
          {renderAgentLink(e.agentName, href, isRankedPrimary)}{' '}
          <code className='muted'>{e.version}</code>
          {isBestActive && meta?.source ? (
            <>
              {' '}
              <a href={meta.source} className='subtle ext' title='Source'>
                {util.raw(util.EXT_ICON)}
              </a>
            </>
          ) : undefined}
          {isRetired ? (
            <>
              {' '}
              <span className='muted'>(retired)</span>
            </>
          ) : undefined}
        </td>
      );

      const eloRounded = Math.round(e.elo);
      const ci95 = e.isAnchor ? 0 : Math.round(1.96 * e.se);
      const eloCell = (
        <td className='num'>
          {isRankedPrimary ? <strong>{eloRounded}</strong> : eloRounded}{' '}
          <span className='muted'>±{ci95}</span>
        </td>
      );

      const gxeCell = <td className='num'>{e.gxe.toFixed(1)}%</td>;
      const wins = e.ww + e.wt;
      const losses = e.ll + e.tl;
      const ties = e.split;
      const wltCell = <td className='num'>{wins}–{losses}–{ties}</td>;

      const streak = computeStreakLabel(e);
      const streakCell = <td className='center'>{streak.node}</td>;

      const adjLos = isRankedPrimary ? adjacentLos.get(e.versionId) : undefined;
      const losCell = adjLos !== undefined
        ? <td className='num'>{(adjLos * 100).toFixed(1)}%</td>
        : <td className='num muted'>—</td>;

      return (
        <tr
          className={classes.length > 0 ? classes.join(' ') : undefined}
          data-retired={isRetired ? 'true' : undefined}
          data-active={!isRetired ? 'true' : undefined}
          data-best={isBestOverall ? 'true' : undefined}
          title={rowTitle}
        >
          {rankCell}
          {agentCell}
          {eloCell}
          {gxeCell}
          {wltCell}
          {streakCell}
          {losCell}
        </tr>
      );
    });

    const thGxe = 'Expected win percentage against prior N(1500, 350^2)';
    const thWlt = '2-game blind-pair Match Wins – Losses – Ties';
    const thStreak = 'Current consecutive outright match win/loss streak';
    const thLos = 'Pairwise Likelihood of Superiority over the next-ranked settled agent';
    standingsPane = (
      <util.PaginatedTable
        className='standings-table'
        head={(
          <tr>
            <th title='Official rank by Conservative Rating (Elo - 1.96 * SE)'>#</th>
            <th>Agent</th>
            <th className='num' title='MAP Davidson Elo ± 95% Confidence Interval'>Elo</th>
            <th className='num' title={thGxe}>GXE</th>
            <th className='num' title={thWlt}>W–L–T</th>
            <th className='center' title={thStreak}>Streak</th>
            <th className='num' title={thLos}>LOS</th>
          </tr>
        )}
        pager={{
          id: 'standings-pager',
          label: 'Standings pagination',
          total: activeCount,
          singular: 'entry',
          plural: 'entries',
        }}
      >
        {rows}
      </util.PaginatedTable>
    );
  }

  const archive = arena.resolveLadderArchive(publicDir, l);

  let ladderBottomNote: util.Child;
  if (((l.team === 'pools' && l.status === 'archived') || l.team === 'random') && archive) {
    ladderBottomNote = (
      <p className='battle-note muted'>
        Data:{' '}
        <a href={archive.href}>
          <code>{archive.name}</code>
        </a>
      </p>
    );
  }

  const historyRes = renderHistorySection(l, topHistoryAgents, snapshots, nowSec);
  const matchupsRes = renderMatchupsSection(entries, pairs, links, l.status);

  const isUpcoming = l.status === 'upcoming';
  const ladderContent = String(
    <>
      <nav aria-label='Format'>
        <ul>
          {formatNavItems}
        </ul>
      </nav>
      <div
        id='season-picker'
        className={multiSeason ? 'season-bar' : 'season-bar hide'}
      >
        <label htmlFor='season-select' className='muted'>Season</label>
        <select id='season-select' className='min-select' aria-label='Season'>
          {slotSeasons.map(s => {
            const isCurrentSlot = s.status === 'active' || s.status === 'upcoming';
            const sHref = isCurrentSlot
              ? `/arena/ladders/${encodeURIComponent(s.slot)}/`
              : `/arena/ladders/${encodeURIComponent(s.id)}/`;
            return (
              <option value={sHref} selected={s.id === l.id}>
                {s.name}
              </option>
            );
          })}
        </select>
      </div>
      <nav className={`subnav${isUpcoming ? ' hide' : ''}`} aria-label='Version filter'>
        <ul>
          <li>
            <input type='radio' name='versions' id='ver-active' value='active' checked />
            <label htmlFor='ver-active'>Active</label>
          </li>
          {' — '}
          <li>
            <input type='radio' name='versions' id='ver-best' value='best' />
            <label htmlFor='ver-best'>Best</label>
          </li>
          {' — '}
          <li>
            <input type='radio' name='versions' id='ver-all' value='all' />
            <label htmlFor='ver-all'>All</label>
          </li>
        </ul>
      </nav>
      <section id='standings'>
        {standingsPane}
      </section>
      <section id='history' className={historyRes.isEmpty || isUpcoming ? 'hide' : undefined}>
        <h3><a href='#history' className='subtle'>History</a></h3>
        {historyRes.node}
      </section>
      <section id='matchups' className={matchupsRes.isEmpty || isUpcoming ? 'hide' : undefined}>
        <h3><a href='#matchups' className='subtle'>Matchups</a></h3>
        {matchupsRes.node}
      </section>
      {ladderBottomNote}
      <script>{util.raw(LADDER_SCRIPT)}</script>
    </>
  );

  const liveTournament = db.getRunningTournament();
  const ladderHeader = build.injectLiveBanner(
    build.header('Ladders'),
    liveTournament,
    restarting
  );
  return renderer.render({
    id: 'leaderboard',
    title: `Arena — ${l.name} | pkmn.ai`,
    header: ladderHeader,
    path: `/arena/ladders/${urlKey}/`,
    style: ARENA_STYLE,
    content: ladderContent,
  });
}

function getSortedPastLadders(allLadders: db.LadderRow[]): db.LadderRow[] {
  return allLadders
    .filter(l => l.status === 'settling' || l.status === 'archived')
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === 'settling' ? -1 : 1;
      return b.createdAt - a.createdAt || b.id.localeCompare(a.id);
    });
}

function buildStandingsDocument(opts: {
  db: db.Database;
  publicDir: string;
  nowSec: number;
}): StandingsDocument {
  const {db, publicDir, nowSec} = opts;
  const ladders = db.getCurrentLadders();
  const allLadders = db.getLadders();
  const pastLadders = getSortedPastLadders(allLadders);
  const hubSummaries = db.getLadderHubSummaries();
  const lastCompletedByLadder = db.getLastCompletedAtByLadder();

  let latestDataAt: number | undefined;
  const bumpLatest = (ts?: number) => {
    if (ts !== undefined && (latestDataAt === undefined || ts > latestDataAt)) latestDataAt = ts;
  };
  for (const ts of lastCompletedByLadder.values()) bumpLatest(ts);

  const jsonLadders: Record<string, StandingsLadder> = {};
  for (const l of ladders) {
    const entries = db.getLeaderboardEntries(l.id);
    const pairs = db.getPairAggregatesForLadder(l.id);
    for (const e of entries) bumpLatest(e.submittedAt);
    jsonLadders[l.slot] = buildStandingsLadder(l, entries, pairs, l.slot, publicDir);
  }

  const archivedLadderSummaries: ArchivedLadderSummary[] = pastLadders.map(l => {
    bumpLatest(l.archivedAt);
    const urlEnc = encodeURIComponent(l.id);
    const archive = arena.resolveLadderArchive(publicDir, l);
    const teamsHref = l.team === 'pools' && l.status === 'archived'
      ? `/arena/ladders/${urlEnc}/teams.json`
      : undefined;
    return {
      id: l.id,
      slot: l.slot,
      name: l.name,
      format: l.format,
      team: l.team,
      status: l.status as 'settling' | 'archived',
      archivedAt: l.archivedAt,
      href: `/arena/ladders/${urlEnc}/`,
      archiveHref: archive?.href,
      teamsHref,
      winner: hubSummaries.get(l.id)?.top1,
    };
  });

  const allTournaments = db.getTournaments();
  const tournamentSummaries: ArenaTournamentSummary[] = allTournaments.map(t => {
    bumpLatest(t.completedAt);
    const entrants = db.getTournamentEntrants(t.id);
    const top = entrants.find(e => e.finalRank === 1) ?? entrants[0];
    const archive = arena.resolveTournamentArchive(publicDir, t.id);
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
      winner: top && t.status === 'completed'
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

  return {
    updatedAt: latestDataAt ?? nowSec,
    ladders: jsonLadders,
    archivedLadders: archivedLadderSummaries,
    tournaments: tournamentSummaries,
  };
}

function renderArenaHubHtml(opts: {
  db: db.Database;
  renderer: build.Renderer;
  links: AgentLinkContext;
  staticDir: string;
  liveMatch?: arena.LiveMatch;
  restarting?: boolean;
  nowSec: number;
}): string {
  const {db, renderer, links, staticDir, liveMatch, restarting, nowSec} = opts;
  const ladders = db.getCurrentLadders();
  const allLadders = db.getLadders();
  const pastLadders = getSortedPastLadders(allLadders);
  const hubSummaries = db.getLadderHubSummaries();
  const lastCompletedByLadder = db.getLastCompletedAtByLadder();

  const pastBySlot = new Map<string, db.LadderRow[]>();
  for (const l of pastLadders) {
    const list = pastBySlot.get(l.slot) ?? [];
    list.push(l);
    pastBySlot.set(l.slot, list);
  }

  const ladderSummaryRows: util.Child[] = [];
  for (const l of ladders) {
    const summary = hubSummaries.get(l.id);
    const slotPast = pastBySlot.get(l.slot) ?? [];
    const hasPast = slotPast.length > 0;
    const fmtTitle = FORMAT_TITLES[l.format] ?? l.format;
    const ladderHref = `/arena/ladders/${encodeURIComponent(l.slot)}/`;
    const ladderCell = (
      <td>
        {hasPast && <span className='battle-toggle' aria-hidden='true'>{'\u25b8'}</span>}
        <a href={ladderHref} className='subtle' title={fmtTitle}>
          <strong><tt>{l.name}</tt></strong>
        </a>
      </td>
    );

    let leaderCell: util.Child;
    if (summary?.top1 !== undefined) {
      const w = summary.top1;
      const wHref = `/projects/${encodeURIComponent(w.slug)}/`;
      leaderCell = (
        <td>
          {renderAgentLink(w.name, wHref, true)}{' '}
          <code className='muted'>{w.version}</code>
        </td>
      );
    } else {
      const stateLabel = l.status === 'upcoming'
        ? 'Upcoming'
        : summary?.hasActiveEntries
          ? 'Provisional'
          : 'No entries yet';
      leaderCell = <td className='muted'>{stateLabel}</td>;
    }

    const isLive = l.status !== 'upcoming' &&
      liveMatch !== undefined &&
      (liveMatch.ladderId === l.id || liveMatch.slot === l.slot);
    let lastCell: util.Child = <td className='num muted'>—</td>;
    if (isLive) {
      lastCell = (
        <td className='num'>
          <a href='/arena/battles/' className='live-pill'>{'\u25cf'} LIVE</a>
        </td>
      );
    } else if (l.status !== 'upcoming') {
      const lastTs = lastCompletedByLadder.get(l.id);
      if (lastTs !== undefined) {
        lastCell = (
          <td
            className='num muted'
            data-ts={lastTs}
            {...util.localizedTitle([{epoch: lastTs}])}
          >
            {formatRelativeTime(nowSec, lastTs)}
          </td>
        );
      }
    }

    ladderSummaryRows.push(
      <tr
        className={hasPast ? 'battle-row' : undefined}
        data-slot={hasPast ? l.slot : undefined}
        tabIndex={hasPast ? 0 : undefined}
        aria-expanded={hasPast ? 'false' : undefined}
      >
        {ladderCell}
        {leaderCell}
        <td className='num'>{(summary?.entrantCount ?? 0).toLocaleString('en-US')}</td>
        <td className='num'>{(summary?.matchCount ?? 0).toLocaleString('en-US')}</td>
        {lastCell}
      </tr>
    );

    for (const past of slotPast) {
      const pastSummary = hubSummaries.get(past.id);
      const pastHref = `/arena/ladders/${encodeURIComponent(past.id)}/`;
      const pastFmtTitle = FORMAT_TITLES[past.format] ?? past.format;
      const endTs = past.archivedAt ?? nowSec;
      const pastW = pastSummary?.top1;
      const pastLeaderCell = pastW ? (
        <td>
          {renderAgentLink(pastW.name, `/projects/${encodeURIComponent(pastW.slug)}/`, true)}{' '}
          <code className='muted'>{pastW.version}</code>
        </td>
      ) : (
        <td className='muted'>—</td>
      );
      const pastLastTs = lastCompletedByLadder.get(past.id);
      const pastLastCell = pastLastTs !== undefined ? (
        <td
          className='num muted'
          data-ts={pastLastTs}
          {...util.localizedTitle([{epoch: pastLastTs}])}
        >
          {formatRelativeTime(nowSec, pastLastTs)}
        </td>
      ) : (
        <td className='num muted'>—</td>
      );

      ladderSummaryRows.push(
        <tr className='season-detail-row hide' data-season-for={l.slot}>
          <td className='season-name-cell'>
            <a href={pastHref} className='subtle' title={pastFmtTitle}>
              <strong><tt>{past.name}</tt></strong>
            </a>{' '}
            <span className='muted'>
              (<util.Time epoch={past.createdAt} format='date' />{' \u2013 '}
              <util.Time epoch={endTs} format='date' />)
            </span>
          </td>
          {pastLeaderCell}
          <td className='num'>{(pastSummary?.entrantCount ?? 0).toLocaleString('en-US')}</td>
          <td className='num'>{(pastSummary?.matchCount ?? 0).toLocaleString('en-US')}</td>
          {pastLastCell}
        </tr>
      );
    }
  }

  const allTournaments = db.getTournaments();
  const entrantsByTournament = new Map(
    allTournaments.map(t => [t.id, db.getTournamentEntrants(t.id)])
  );
  const blurbHtml = loadArenaBlurbHtml(staticDir);
  const tournamentsSummaryHtml = tournaments.renderArenaTournamentsSummaryHtml({
    db,
    links,
    tournaments: allTournaments,
    entrantsByTournament,
  });

  const arenaContent = String(
    <>
      <section id='overview' className='arena-blurb'>
        {util.raw(blurbHtml)}
      </section>
      <section id='ladders'>
        <h3><a href='#ladders' className='subtle'>Ladders</a></h3>
        <div className='table-wrap'>
          <table className='standings-table'>
            <thead>
              <tr>
                <th>Ladder</th>
                <th>Leader</th>
                <th className='num'>Entrants</th>
                <th className='num'>Matches</th>
                <th className='num'>Last</th>
              </tr>
            </thead>
            <tbody>{ladderSummaryRows}</tbody>
          </table>
        </div>
      </section>
      <section id='tournaments'>
        <h3><a href='#tournaments' className='subtle'>Tournaments</a></h3>
        {util.raw(tournamentsSummaryHtml)}
      </section>
      <script>{util.raw(`
  ${util.TABLE_PAGER_SCRIPT}
  document.addEventListener('DOMContentLoaded', () => {
    const laddersSec = document.getElementById('ladders');
    if (!laddersSec) return;
    const toggleSlot = row => {
      const slot = row.getAttribute('data-slot');
      if (!slot) return;
      const open = !row.classList.contains('expanded');
      row.classList.toggle('expanded', open);
      row.setAttribute('aria-expanded', open ? 'true' : 'false');
      laddersSec.querySelectorAll('tr[data-season-for="' + slot + '"]').forEach(sub => {
        sub.classList.toggle('hide', !open);
      });
    };
    laddersSec.addEventListener('click', ev => {
      const t = ev.target;
      if (t && t.closest && t.closest('a, button, input, select, label')) return;
      const row = t && t.closest ? t.closest('tr.battle-row[data-slot]') : undefined;
      if (row) toggleSlot(row);
    });
    laddersSec.addEventListener('keydown', ev => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      const t = ev.target;
      if (t && t.closest && t.closest('a, button, input, select, label')) return;
      const row = t && t.closest ? t.closest('tr.battle-row[data-slot]') : undefined;
      if (row) {
        ev.preventDefault();
        toggleSlot(row);
      }
    });
  });
`)}</script>
    </>
  );

  return renderer.render({
    id: 'arena',
    title: 'Arena | pkmn.ai',
    header: build.injectLiveBanner(build.header('Arena'), db.getRunningTournament(), restarting),
    path: '/arena/',
    style: ARENA_STYLE,
    content: arenaContent,
  });
}

function renderTeamSpanNode(team: string | undefined): util.Child {
  if (!team) return undefined;
  const teamTip = team.startsWith('P1:')
    ? 'Known to Match P1 (drawn from P1 seasonal pool)'
    : team.startsWith('P2:')
      ? 'Known to Match P2 (drawn from P2 seasonal pool)'
      : 'Unknown to both players (drawn from a third-party competitor pool)';
  return (
    <span title={teamTip}>
      Team: <code>{team}</code>
    </span>
  );
}

function renderPokemonOrbsNode(pokemon: readonly arena.PokemonHealth[] | undefined): util.Child {
  if (!pokemon || pokemon.length === 0) return undefined;
  return (
    <span className='hp-orbs' aria-label='Pokémon health'>
      {pokemon.map(m => {
        const tip = `${Math.max(0, Math.min(100, Math.round(m.percent)))}%`;
        return (
          <span className='hp-orb-item'>
            <span className={`hp-orb ${m.color}`} title={tip} role='img' aria-label={tip}>
              {'\u25cf'}
            </span>
            <span className='hp-pct' aria-hidden='true'>{tip}</span>
          </span>
        );
      })}
    </span>
  );
}

function renderLiveGame1Side(
  key: 'p1' | 'p2',
  slotMeta: arena.LiveSlot,
  side: arena.LiveGameSummarySide,
  won: boolean,
  links: AgentLinkContext
): util.Child {
  const ramText = `${Math.round(side.ram).toLocaleString('en-US')} MiB`;
  const href = resolveAgentHref(links, slotMeta.slug, slotMeta.name);
  const hasInit = side.initMillis !== undefined;
  const hasTp = side.teamPreviewMillis !== undefined;
  return (
    <div className='live-g1-side'>
      <div className='live-g1-top'>
        <span>
          <tt>{key.toUpperCase()}</tt> {renderAgentLink(slotMeta.name, href, won)}{' '}
          <code className='muted'>{slotMeta.version}</code>
        </span>
        {renderPokemonOrbsNode(side.pokemon)}
      </div>
      <div className='live-g1-telemetry'>
        <span>
          <tt>{Math.round(side.meanTurnMillis)} ms/turn</tt>
          {(hasInit || hasTp) && (
            <>
              {' '}
              <span className='muted'>
                (
                {hasInit && <><tt>{Math.round(side.initMillis!)} ms</tt> init</>}
                {hasInit && hasTp && ' · '}
                {hasTp && <><tt>{Math.round(side.teamPreviewMillis!)} ms</tt> preview</>}
                )
              </span>
            </>
          )}
        </span>
        <span>Bank: <tt>{Math.round(side.bankSeconds)}s</tt></span>
        <span title='XNU ri_phys_footprint (14 GiB limit)'>
          RAM: <tt>{ramText}</tt>
        </span>
        {side.cpuCores !== undefined && side.cpuCores > 0 && (
          <span title='Host-measured CPU utilization (effective cores)'>
            <tt>{side.cpuCores.toFixed(1)}</tt> CPU
          </span>
        )}
        {renderTeamSpanNode(side.team)}
      </div>
    </div>
  );
}

function renderLiveGame1Summary(live: arena.LiveMatch, links: AgentLinkContext): util.Child {
  const g1 = live.game1Summary;
  if (!g1) return undefined;
  const winnerNode = g1.winnerSlot === 'p1' ? (
    <><span className='yes'>{live.p1.name}</span> won</>
  ) : g1.winnerSlot === 'p2' ? (
    <><span className='yes'>{live.p2.name}</span> won</>
  ) : (
    <span className='muted'>Tie</span>
  );
  const end = g1.endReason ? formatEndReasonNode(g1.endReason) : undefined;
  return (
    <div className='live-g1' id='live-g1'>
      <div className='live-g1-head'>
        <span className='live-g1-label'>Game 1</span>
        <span>
          {winnerNode} · <tt>{g1.turns} turns</tt>
          {end?.show ? <> · {end.node}</> : undefined}
        </span>
      </div>
      {g1.p1 && g1.p2 ? (
        <div className='live-g1-grid'>
          {renderLiveGame1Side('p1', live.p1, g1.p1, g1.winnerSlot === 'p1', links)}
          {renderLiveGame1Side('p2', live.p2, g1.p2, g1.winnerSlot === 'p2', links)}
        </div>
      ) : undefined}
    </div>
  );
}

function renderLiveSlotCard(
  key: 'p1' | 'p2',
  slotData: arena.LiveSlot,
  live: arena.LiveMatch,
  nowSec: number,
  links: AgentLinkContext
): util.Child {
  const isInit = live.phase === 'init';
  const isPreview = live.phase === 'preview';
  const isRunning = live.activeSlot === key;
  const otherKey = key === 'p1' ? 'p2' : 'p1';
  const timer = arena.timerSettingsForFormat(live.format);
  const elapsed = isRunning ? Math.max(0, nowSec - live.turnStartedAt) : 0;
  const pausedTurnMax = isPreview ? timer.maxFirstTurnSeconds : timer.maxPerTurnSeconds;
  const budget = isRunning
    ? Math.round(live.turnBudgetSeconds)
    : (isInit ? 60 : Math.min(Math.round(slotData.bankSeconds), pausedTurnMax));
  const bank = isRunning && !isInit && !(timer.timeoutAutoChoose && isPreview)
    ? Math.max(0, Math.round(slotData.bankSeconds - elapsed))
    : Math.round(slotData.bankSeconds);
  const inc = Math.round(live.incrementSeconds);
  const ramPct = ((slotData.ram / 14336) * 100).toFixed(1);
  const href = resolveAgentHref(links, slotData.slug, slotData.name);

  const badge = isRunning ? (
    <span
      className='state-running'
      id={`state-${key}`}
      title={isInit
        ? 'Initializing (waiting for /ready within 60s grace)'
        : 'Currently executing (SIGCONT)'}
    >
      {'\u25cf'} {isInit ? 'INITIALIZING' : 'RUNNING'}
    </span>
  ) : (
    <span
      className='state-paused'
      id={`state-${key}`}
      title={`Frozen by kernel SIGSTOP while ${otherKey.toUpperCase()} computes`}
    >
      PAUSED
    </span>
  );

  const timerTitle = timer.timeoutAutoChoose
    ? `60s /ready init grace + Pokémon Showdown VGC Timer: ${timer.startingSeconds}s Your Time, ` +
      `${timer.maxFirstTurnSeconds}s preview, ${timer.maxPerTurnSeconds}s/turn`
    : `60s /ready init grace + Pokémon Showdown RoomBattleTimer: ${timer.startingSeconds}s ` +
      `max bank, ${timer.graceSeconds}s grace, +${inc}s/turn`;
  const bankMeta = inc > 0 ? `(+${inc}s/turn)` : `(${timer.maxPerTurnSeconds}s/turn)`;
  const stepLabel = isInit ? 'Init' : 'Turn';

  const turnCls = isRunning ? 'yes' : 'muted';
  const ramText = `${Math.round(slotData.ram).toLocaleString('en-US')} MiB`;
  return (
    <div className={`slot-card ${isRunning ? 'running' : 'paused'}`} id={`slot-${key}`}>
      <div className='slot-top'>
        <span>
          <tt>{key.toUpperCase()}</tt> {renderAgentLink(slotData.name, href, true)}{' '}
          <code className='muted'>{slotData.version}</code>
        </span>
        {renderPokemonOrbsNode(slotData.pokemon)}
        {badge}
      </div>
      <div className='slot-timers' title={timerTitle}>
        <span>
          {stepLabel}: <strong id={`turn-${key}`} className={turnCls}>{elapsed}s</strong>{' '}
          <span className='muted'>/ {budget}s</span>
        </span>
        <span>
          Bank: <strong id={`bank-${key}`}>{bank}s</strong>{' '}
          <span className='muted'>{bankMeta}</span>
        </span>
      </div>
      <div className='slot-telemetry'>
        <span>Last: <tt>{Math.round(slotData.lastTurnMillis)} ms</tt></span>
        <span>Mean: <tt>{Math.round(slotData.meanTurnMillis)} ms/turn</tt></span>
        <span title='XNU ri_phys_footprint (14 GiB limit)'>
          RAM: <tt>{ramText}</tt> ({ramPct}%)
        </span>
        {slotData.cpuCores !== undefined && slotData.cpuCores > 0 && (
          <span title='Host-measured CPU utilization (effective cores)'>
            <tt>{slotData.cpuCores.toFixed(1)}</tt> CPU
          </span>
        )}
        {renderTeamSpanNode(slotData.team)}
      </div>
      {(live.p1.info || live.p2.info) && (
        <div className='slot-ai'>{util.raw(renderAiStatsHtml(key, slotData.info))}</div>
      )}
    </div>
  );
}

function renderLivePanelInner(
  liveDoc: arena.LiveDocument | undefined,
  nowSec: number,
  links: AgentLinkContext
): util.Child {
  if (!liveDoc?.live || liveDoc.stale) {
    const smoke = liveDoc?.smokeTesting;
    const idleBody: util.Child = liveDoc?.stale
      ? 'No active heartbeat — Arena is offline or idle.'
      : smoke
        ? (
          <>
            <span className='yes'>{'\u25cf'}</span> Testing a submission for{' '}
            {renderAgentLink(smoke.name, resolveAgentHref(links, smoke.slug, smoke.name), true)}
            {' — ladder battles will resume shortly.'}
          </>
        )
        : 'No battle currently running — Arena is idle.';
    return (
      <div className='live-idle muted'>
        {idleBody}
        {liveDoc?.runningTournament ? (
          <>
            {' · '}
            <a href={liveDoc.runningTournament.href} className='subtle'>
              <strong>{'\u25cf'} Watch {liveDoc.runningTournament.name} live</strong>
            </a>
          </>
        ) : undefined}
      </div>
    );
  }

  const l = liveDoc.live;
  const hbAge = Math.max(0, nowSec - liveDoc.updatedAt);

  return (
    <>
      <div className='live-header'>
        <span>
          <code>{l.matchId}</code> · <strong>Game {l.game} / 2</strong>
          {l.phase === 'init'
            ? <> · Initializing (<code>/ready</code>)</>
            : (l.phase === 'preview' || l.turn === 0)
              ? <> · Team Preview</>
              : <>, Turn {l.turn}</>}
        </span>
        <span className='muted'>
          Heartbeat <tt>#{l.heartbeatSeq}</tt> (<tt id='hb-age'>{hbAge}s</tt> ago)
        </span>
      </div>
      {renderLiveGame1Summary(l, links)}
      <div className='slots-grid'>
        {renderLiveSlotCard('p1', l.p1, l, nowSec, links)}
        {renderLiveSlotCard('p2', l.p2, l, nowSec, links)}
      </div>
      {(() => {
        const liveAiHtml = renderAiPanelHtml(
          l.p1.name,
          l.p2.name,
          l.p1.info,
          l.p2.info,
          l.winHistory,
          {showStrip: false, activeTurn: l.turn}
        );
        return liveAiHtml ? <div className='ai-panel'>{util.raw(liveAiHtml)}</div> : undefined;
      })()}
    </>
  );
}

function renderMatchOutcomeDisplay(cat: db.RecentMatchView['category']): {
  p1Win: boolean;
  p2Win: boolean;
  node: util.Child;
} {
  if (cat === 'WW') return {p1Win: true, p2Win: false, node: <><strong>2</strong>–0</>};
  if (cat === 'WT' || cat === 'TW') {
    return {p1Win: true, p2Win: false, node: <><strong>1.5</strong>–0.5</>};
  }
  if (cat === 'LL') return {p1Win: false, p2Win: true, node: <>0–<strong>2</strong></>};
  if (cat === 'LT' || cat === 'TL') {
    return {p1Win: false, p2Win: true, node: <>0.5–<strong>1.5</strong></>};
  }
  return {p1Win: false, p2Win: false, node: '1–1'};
}

function isAbnormalEndReason(reason: string): boolean {
  const norm = reason.trim().toLowerCase();
  return Boolean(norm) &&
    norm !== 'normal' &&
    norm !== 'win' &&
    norm !== 'tie' &&
    norm !== 'turn-limit' &&
    !/^tie-\d+-turns$/.test(norm);
}

export function formatEndReasonNode(reason: string): {
  node: util.Child;
  label: string;
  abnormal: boolean;
  show: boolean;
} {
  const norm = reason.trim().toLowerCase();
  if (!norm || norm === 'normal' || norm === 'win') {
    return {
      node: <span className='muted'>Normal</span>,
      label: 'Normal',
      abnormal: false,
      show: false,
    };
  }
  if (norm === 'tie') {
    return {
      node: <span className='muted'>Tie</span>,
      label: 'Tie',
      abnormal: false,
      show: false,
    };
  }
  if (norm === 'turn-limit' || /^tie-\d+-turns$/.test(norm)) {
    return {
      node: <span className='muted'>Turn limit</span>,
      label: 'Turn limit',
      abnormal: false,
      show: true,
    };
  }
  if (norm === 'timeout') {
    return {
      node: <span className='no'>Timeout</span>,
      label: 'Timeout',
      abnormal: true,
      show: true,
    };
  }
  if (norm === 'crash') {
    return {
      node: <span className='no'>Crash</span>,
      label: 'Crash',
      abnormal: true,
      show: true,
    };
  }
  if (norm === 'oom') {
    return {
      node: <span className='no'>OOM</span>,
      label: 'OOM',
      abnormal: true,
      show: true,
    };
  }
  if (norm === 'invalid-choice') {
    return {
      node: <span className='no'>3{'\u00d7'} Invalid Choice</span>,
      label: '3x Invalid Choice',
      abnormal: true,
      show: true,
    };
  }
  return {
    node: <span className='no'>{reason}</span>,
    label: reason,
    abnormal: true,
    show: true,
  };
}

function formatPoolTeamCode(
  label: string | undefined,
  p1Name: string,
  p2Name: string
): util.Child {
  if (!label) return <span className='muted'>—</span>;
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
  return <code title={tip}>{label}</code>;
}

export function formatGameOutcomeNode(outcome: 'W' | 'L' | 'T'): util.Child {
  if (outcome === 'W') return <span className='yes' title='Player 1 won'>W</span>;
  if (outcome === 'L') return <span className='no' title='Player 2 won'>L</span>;
  return <span className='muted' title='Tie'>T</span>;
}

export interface GamePlayerTelemetry {
  meanTurnMillis?: number;
  bankSeconds?: number;
  peakRam?: number;
  cpuCores?: number;
  initMillis?: number;
  teamPreviewMillis?: number;
}

export function formatGamePlayerTelemetryNode(p: GamePlayerTelemetry): util.Child {
  const meanMillis = Math.round(p.meanTurnMillis ?? 0);
  const bankSeconds = Math.round(p.bankSeconds ?? 0);
  const ramStr = `${Math.round(p.peakRam ?? 0).toLocaleString('en-US')} MiB`;
  const hasInit = p.initMillis !== undefined;
  const hasTp = p.teamPreviewMillis !== undefined;
  const hasCpu = p.cpuCores !== undefined && p.cpuCores > 0;
  return (
    <span>
      <tt>{meanMillis} ms/turn</tt>
      {(hasInit || hasTp) && (
        <>
          {' '}
          <span className='muted'>
            (
            {hasInit && <><tt>{Math.round(p.initMillis!)} ms</tt> init</>}
            {hasInit && hasTp && ' · '}
            {hasTp && <><tt>{Math.round(p.teamPreviewMillis!)} ms</tt> preview</>}
            )
          </span>
        </>
      )}
      {' · '}Bank <tt>{bankSeconds}s</tt> · RAM <tt>{ramStr}</tt>
      {hasCpu && (
        <>
          {' · '}
          <span title='Host-measured CPU utilization (effective cores)'>
            <tt>{p.cpuCores!.toFixed(1)}</tt> CPU
          </span>
        </>
      )}
    </span>
  );
}

// Renders the inline expandable detail panel inside a battle history table row.
// Both Game 1 and Game 2 keep `P1`/`P2` aligned with Match Player 1 and Match Player 2 from the
// parent table row (matching the live slot cards and `W`/`L` game outcomes). Because Game 2 swaps
// seats and teams under the identical `@pkmn/sim` PRNG seed (to cancel team matchup bias to first
// order), Match P1 plays Team 2 (`p2TeamLabel`) and Match P2 plays Team 1 (`p1TeamLabel`) in
// Game 2.
export function battleInlineDetailHtml(
  m: arena.BattleHistoryEntry,
  perspectiveSlug?: string
): string {
  const omitOutcome = Boolean(perspectiveSlug);
  const p1IsUs = Boolean(perspectiveSlug && m.p1.slug === perspectiveSlug);
  const p2IsUs = Boolean(perspectiveSlug && m.p2.slug === perspectiveSlug);
  const p1Label = p1IsUs ? '(P1)' : 'P1';
  const p2Label = p2IsUs ? '(P2)' : 'P2';

  const [g1, g2] = m.games;
  const end1 = formatEndReasonNode(g1.endReason);
  const end2 = formatEndReasonNode(g2.endReason);

  const showPools = m.teamMode === 'pools' || Boolean(m.p1.teamLabel || m.p2.teamLabel);
  const t1Code = formatPoolTeamCode(m.p1.teamLabel, m.p1.name, m.p2.name);
  const t2Code = formatPoolTeamCode(m.p2.teamLabel, m.p1.name, m.p2.name);

  const hasReplay = Boolean(g1.logHref || g2.logHref);

  return String(
    <div
      className='battle-detail'
      data-match-id={hasReplay ? m.id : undefined}
      data-p1-name={hasReplay ? m.p1.name : undefined}
      data-p2-name={hasReplay ? m.p2.name : undefined}
      data-g1-log={g1.logHref}
      data-g2-log={g2.logHref}
    >
      <div className='battle-detail-meta'>
        <util.Time epoch={m.completedAt} className='muted' />
        <span>
          <span className='muted'>Seed:</span> <code>{m.seed}</code>
        </span>
      </div>
      <div className='battle-detail-grid'>
        <div className='battle-detail-card'>
          <div className='battle-detail-title'>
            <span>Game 1</span>
            <span className='battle-detail-sub'>
              {!omitOutcome ? <>{formatGameOutcomeNode(g1.outcome)} · </> : undefined}
              <tt>{g1.turns} turns</tt>
              {end1.show ? <> · {end1.node}</> : undefined}
            </span>
          </div>
          <div className='battle-detail-line'>
            <span>
              <tt>{p1Label}</tt>
              {showPools ? <> {t1Code}</> : undefined}
            </span>
            {formatGamePlayerTelemetryNode(g1.p1)}
          </div>
          <div className='battle-detail-line'>
            <span>
              <tt>{p2Label}</tt>
              {showPools ? <> {t2Code}</> : undefined}
            </span>
            {formatGamePlayerTelemetryNode(g1.p2)}
          </div>
        </div>
        <div className='battle-detail-card'>
          <div className='battle-detail-title'>
            <span>Game 2</span>
            <span className='battle-detail-sub'>
              {!omitOutcome ? <>{formatGameOutcomeNode(g2.outcome)} · </> : undefined}
              <tt>{g2.turns} turns</tt>
              {end2.show ? <> · {end2.node}</> : undefined}
            </span>
          </div>
          <div className='battle-detail-line'>
            <span>
              <tt>{p1Label}</tt>
              {showPools ? <> {t2Code}</> : undefined}
            </span>
            {formatGamePlayerTelemetryNode(g2.p1)}
          </div>
          <div className='battle-detail-line'>
            <span>
              <tt>{p2Label}</tt>
              {showPools ? <> {t1Code}</> : undefined}
            </span>
            {formatGamePlayerTelemetryNode(g2.p2)}
          </div>
        </div>
      </div>
    </div>
  );
}

function renderBattlesPage(opts: {
  db: db.Database;
  renderer: build.Renderer;
  links: AgentLinkContext;
  liveDoc?: arena.LiveDocument;
  recentMatchesLimit: number;
  nowSec: number;
}): string {
  const {
    db,
    renderer,
    links,
    liveDoc,
    recentMatchesLimit,
    nowSec,
  } = opts;
  const {publicDir} = links;
  const countsBySlot = liveDoc?.countsBySlot ?? db.getMatchCountsBySlot();
  const currentBySlot = new Map(db.getCurrentLadders().map(l => [l.slot, l]));
  const filterSlots: Array<{slot: db.LadderSlot; name: string}> = [];
  const seenSlots = new Set<db.LadderSlot>();
  for (const l of db.getLadders()) {
    if (seenSlots.has(l.slot)) continue;
    const current = currentBySlot.get(l.slot);
    if (!current && !(countsBySlot[l.slot] > 0)) continue;
    seenSlots.add(l.slot);
    filterSlots.push({
      slot: l.slot,
      name: current ? current.name : l.slot.toUpperCase(),
    });
  }
  const recentMatches = liveDoc && (liveDoc.pageSize ?? recentMatchesLimit) === recentMatchesLimit
    ? liveDoc.recentMatches
    : db.getRecentMatches(recentMatchesLimit).map(m => arena.enrichMatchView(publicDir, m));
  const totalMatches = countsBySlot.all ?? recentMatches.length;

  const formatFilterItems = filterSlots.map(s => (
    <>
      {' — '}
      <li>
        <input type='radio' name='bformat' id={`bf-${s.slot}`} value={s.slot} />
        <label htmlFor={`bf-${s.slot}`}>{s.name}</label>
      </li>
    </>
  ));

  const agentLinks: Record<string, string> = {};
  for (const s of db.getProjectArenaSummaries()) {
    const href = resolveAgentHref(links, s.slug, s.name);
    if (href) agentLinks[s.slug] = href;
  }
  for (const m of recentMatches) {
    for (const side of [m.p1, m.p2]) {
      if (!agentLinks[side.slug]) {
        const href = resolveAgentHref(links, side.slug, side.name);
        if (href) agentLinks[side.slug] = href;
      }
    }
  }
  if (liveDoc?.live) {
    for (const side of [liveDoc.live.p1, liveDoc.live.p2]) {
      if (!agentLinks[side.slug]) {
        const href = resolveAgentHref(links, side.slug, side.name);
        if (href) agentLinks[side.slug] = href;
      }
    }
  }
  if (liveDoc?.smokeTesting && !agentLinks[liveDoc.smokeTesting.slug]) {
    const href = resolveAgentHref(links, liveDoc.smokeTesting.slug, liveDoc.smokeTesting.name);
    if (href) agentLinks[liveDoc.smokeTesting.slug] = href;
  }

  const historyRows = recentMatches.length === 0 ? (
    <tr className='empty-row'>
      <td colSpan={5} className='center muted'>No completed battles yet.</td>
    </tr>
  ) : (
    recentMatches.map(m => {
      const r = renderMatchOutcomeDisplay(m.category);
      const p1Href = agentLinks[m.p1.slug];
      const p2Href = agentLinks[m.p2.slug];

      const [g1, g2] = m.games;
      const b1 = Math.round(Math.min(g1.p1.bankSeconds, g2.p1.bankSeconds));
      const b2 = Math.round(Math.min(g1.p2.bankSeconds, g2.p2.bankSeconds));
      const reasonSuffix =
        isAbnormalEndReason(g1.endReason) || isAbnormalEndReason(g2.endReason)
          ? ` · End: ${g1.endReason}/${g2.endReason}`
          : '';
      const cpuSuffix = m.p1.cpuCores !== undefined && m.p2.cpuCores !== undefined
        ? ` · ${m.p1.cpuCores.toFixed(1)}/${m.p2.cpuCores.toFixed(1)} CPU`
        : '';
      const tip =
        `${m.category} · ${Math.round(m.p1.meanTurnMillis)}ms/` +
        `${Math.round(m.p2.meanTurnMillis)}ms · Bank ${b1}s/${b2}s · RAM ` +
        `${Math.round(m.p1.peakRam).toLocaleString('en-US')}M/` +
        `${Math.round(m.p2.peakRam).toLocaleString('en-US')}M${cpuSuffix}${reasonSuffix}`;

      const rel = formatRelativeTime(nowSec, m.completedAt);
      const detailHtml = battleInlineDetailHtml(m);
      return (
        <>
          <tr
            id={m.id}
            className='battle-row'
            data-fmt={m.slot}
            tabIndex={0}
            aria-expanded='false'
          >
            <td>
              <span className='battle-toggle' aria-hidden='true'>{'\u25b8'}</span>
              <code>{m.id}</code>
            </td>
            <td>
              {renderAgentLink(m.p1.name, p1Href, r.p1Win)}{' '}
              <code className='muted'>{m.p1.version}</code>
            </td>
            <td>
              {renderAgentLink(m.p2.name, p2Href, r.p2Win)}{' '}
              <code className='muted'>{m.p2.version}</code>
            </td>
            <td className='center' title={tip}>{r.node}</td>
            <td
              className='num muted'
              data-ts={m.completedAt}
              {...util.localizedTitle([{epoch: m.completedAt}])}
            >
              {rel}
            </td>
          </tr>
          <tr className='battle-detail-row hide' data-detail-for={m.id}>
            <td colSpan={5}>{util.raw(detailHtml)}</td>
          </tr>
        </>
      );
    })
  );

  const initialState: arena.LiveDocument = liveDoc
    ? {
      ...liveDoc,
      pageSize: liveDoc.pageSize ?? recentMatchesLimit,
      totalMatches: liveDoc.totalMatches ?? totalMatches,
      countsBySlot: liveDoc.countsBySlot ?? countsBySlot,
      historyEndpoint: liveDoc.historyEndpoint ?? '/api/battles.json',
      recentMatches: liveDoc.recentMatches,
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

  const liveMatchWithLines =
    liveDoc && !liveDoc.stale && (liveDoc.live?.viewer?.lines.length ?? 0) > 0
      ? liveDoc.live
      : undefined;

  const content = String(
    <>
      <nav aria-label='Format filter'>
        <ul>
          <li>
            <input type='radio' name='bformat' id='bf-all' value='all' checked />
            <label htmlFor='bf-all'>All</label>
          </li>
          {formatFilterItems}
        </ul>
      </nav>
      <section id='live'>
        <div className='section-head'>
          <h3><a href='#live' className='subtle'>Live</a></h3>
          <label className='live-hp-toggle muted'>
            <input type='checkbox' id='live-hp-pct' />
            <span>Show HP %</span>
          </label>
        </div>
        <div className='live-panel' id='live-panel-wrap'>
          <div id='live-panel'>
            {renderLivePanelInner(liveDoc, nowSec, links)}
          </div>
          <div
            className={`battle-viewer-wrap${liveMatchWithLines ? '' : ' hide'}`}
            id='battle-viewer-wrap'
          >
            <div className='viewer-wrap'>
              <iframe
                id='ps-viewer-frame'
                className='viewer-frame'
                src={liveMatchWithLines ? '/arena/viewer/' : undefined}
                title='Pokémon Showdown battle viewer'
                sandbox='allow-scripts'
              />
            </div>
          </div>
        </div>
      </section>
      <section id='history'>
        <h3><a href='#history' className='subtle'>History</a></h3>
        <util.PaginatedTable
          id='battles-table'
          tbodyId='battles-tbody'
          head={(
            <tr>
              <th>Battle</th>
              <th>Player 1</th>
              <th>Player 2</th>
              <th className='center' title='2-game blind-pair outcome (Game 1 / Game 2)'>
                Result
              </th>
              <th className='num'>Completed</th>
            </tr>
          )}
          pager={{
            id: 'battles-pager',
            label: 'Battle history pagination',
            total: totalMatches,
            singular: 'battle',
            plural: 'battles',
            pageSize: recentMatchesLimit,
            prevLabel: '\u2190 Newer',
            nextLabel: 'Older \u2192',
            server: true,
          }}
        >
          {historyRows}
        </util.PaginatedTable>
      </section>
      <script>
        {util.raw(buildBattlesScript(
          safeInlineJson(initialState),
          safeInlineJson(agentLinks)
        ))}
      </script>
    </>
  );

  return renderer.render({
    id: 'battles',
    title: 'Arena — Battles | pkmn.ai',
    header: build.injectLiveBanner(
      build.header('Battles'),
      db.getRunningTournament(),
      Boolean(liveDoc && !liveDoc.stale && liveDoc.restarting)
    ),
    path: '/arena/battles/',
    style: ARENA_STYLE,
    preconnect: [util.SHOWDOWN_ORIGIN],
    content,
  });
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
// with `Cache-Control: no-cache` + stateless `ETag` (`304 Not Modified`).
export function register(app: polka.Polka, options: Options) {
  util.installHeadSupport(app);
  const {db, arena: arenaHandle} = options;
  const publicDir = options.publicDir ?? PUBLIC_DIR;
  const staticDir = options.staticDir ?? STATIC_DIR;
  const avatarsDir = options.avatarsDir ?? AVATARS_DIR;
  const recentMatchesLimit = util.TABLE_PAGE_SIZE;
  const getNowSec = options.now ?? (() => Math.floor(Date.now() / 1000));

  const renderer = build.renderer;

  const getLinks = (): AgentLinkContext => {
    const {meta, logoSizes} = loadProjectCatalog(staticDir);
    return {
      publicDir,
      projectMeta: meta,
      logoSizes,
      profileSlugs: new Set(db.getAllActiveAgents().map(a => a.slug)),
    };
  };

  const sendWithEtag = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    opts: {body: string | Buffer; contentType: string; cacheControl?: string}
  ) => {
    const body = Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body, 'utf8');
    const etag = `"${crypto.createHash('sha1').update(body).digest('hex')}"`;
    const isHtml = opts.contentType.startsWith('text/html');
    const defaultCacheControl = isHtml && build.accountContext.getStore()?.authenticated
      ? 'private, no-cache'
      : 'no-cache';
    res.setHeader('Cache-Control', opts.cacheControl ?? defaultCacheControl);
    if (isHtml) res.setHeader('Vary', 'Cookie');
    res.setHeader('ETag', etag);
    if (opts.contentType === 'image/svg+xml') {
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; sandbox"
      );
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }
    if (util.matchesIfNoneMatch(req.headers['if-none-match'], etag)) {
      res.statusCode = 304;
      res.end();
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', opts.contentType);
    res.end(body);
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
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(build.renderErrorPage(404, db.getRunningTournament()));
  };

  const paramStr = (val: string | string[] | undefined): string => {
    const rawVal = typeof val === 'string' ? val : '';
    try {
      return decodeURIComponent(rawVal).trim();
    } catch {
      return rawVal.trim();
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
    if (asJson) {
      const doc = buildStandingsDocument({db, publicDir, nowSec});
      sendWithEtag(req, res, {
        body: `${JSON.stringify(doc, undefined, 2)}\n`,
        contentType: 'application/json; charset=utf-8',
      });
      return;
    }
    const state = arenaHandle.getState();
    sendWithEtag(req, res, {
      body: renderArenaHubHtml({
        db,
        renderer,
        links: getLinks(),
        staticDir,
        liveMatch: !state.stale ? state.live : undefined,
        restarting: !state.stale && state.restarting,
        nowSec,
      }),
      contentType: 'text/html; charset=utf-8',
    });
  };

  app.get('/arena', (req, res) => handleArenaHub(req, res, false));
  app.get('/arena.json', (req, res) => handleArenaHub(req, res, true));
  app.get('/arena/index.json', (req, res) => handleArenaHub(req, res, true));

  const handleBattles = (req: http.IncomingMessage, res: http.ServerResponse, asJson: boolean) => {
    const nowSec = getNowSec();
    const liveDoc = arenaHandle.getLiveDocument(nowSec);
    if (asJson) {
      sendWithEtag(req, res, {
        body: `${JSON.stringify(liveDoc, undefined, 2)}\n`,
        contentType: 'application/json; charset=utf-8',
      });
      return;
    }
    sendWithEtag(req, res, {
      body: renderBattlesPage({
        db,
        renderer,
        links: getLinks(),
        liveDoc,
        recentMatchesLimit,
        nowSec,
      }),
      contentType: 'text/html; charset=utf-8',
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
    sendWithEtag(req, res, {
      body: `${JSON.stringify(buildLadderTeamsDocument(db, ladder), undefined, 2)}\n`,
      contentType: 'application/json; charset=utf-8',
    });
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
    const allLadders = db.getLadders();
    const currentLadders = db.getCurrentLadders();
    const currentLadder = currentLadders.find(l => l.slot === key);
    const pastLadder = !currentLadder
      ? allLadders.find(l => l.id === key && (l.status === 'settling' || l.status === 'archived'))
      : undefined;
    const ladder = currentLadder ?? pastLadder;
    if (!ladder) {
      if (isJson) sendJsonNotFound(res, `Unknown ladder "${key}".`);
      else sendHtmlNotFound(res);
      return;
    }
    if (isJson) {
      const doc = buildLadderDocument({ladder, urlKey: key, db, publicDir});
      sendWithEtag(req, res, {
        body: `${JSON.stringify(doc, undefined, 2)}\n`,
        contentType: 'application/json; charset=utf-8',
      });
      return;
    }
    const state = arenaHandle.getState();
    sendWithEtag(req, res, {
      body: renderLadderHtml({
        ladder,
        currentLadders,
        allLadders,
        urlKey: key,
        db,
        renderer,
        links: getLinks(),
        restarting: !state.stale && state.restarting,
        nowSec: getNowSec(),
      }),
      contentType: 'text/html; charset=utf-8',
    });
  };

  const serveBattleLogFile = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    subdir: 'ladders' | 'tournaments',
    rawId: string,
    rawFile: string
  ) => {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(rawId) ||
      rawId.includes('..') ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.log$/.test(rawFile) ||
      rawFile.includes('..')
    ) {
      sendHtmlNotFound(res);
      return;
    }
    if (subdir === 'ladders') {
      const ladder = db.getLadder(rawId);
      const canServe = Boolean(
        ladder && (
          ladder.team === 'random' ||
          (ladder.team === 'pools' && ladder.status === 'archived')
        )
      );
      if (!canServe) {
        sendHtmlNotFound(res);
        return;
      }
      if (ladder?.team === 'pools') {
        arena.promoteArchivedPoolsLogs(publicDir, ladder.id);
      }
    } else if (!db.getTournament(rawId)) {
      sendHtmlNotFound(res);
      return;
    }
    const logPath = path.join(publicDir, 'arena', subdir, rawId, rawFile);
    if (!fs.existsSync(logPath)) {
      sendHtmlNotFound(res);
      return;
    }
    const rawText = fs.readFileSync(logPath, 'utf8');
    const side = new URL(req.url ?? '/', 'http://localhost').searchParams.get('side');
    if (side === 'both') {
      const lines = rawText.replace(/\n$/, '').split('\n');
      const {p1Lines, p2Lines} = arena.extractPerspectiveLogs(lines);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.end(JSON.stringify({lines, p1Lines, p2Lines}));
      return;
    }
    if (side === 'p1' || side === 'p2') {
      const lines = rawText.replace(/\n$/, '').split('\n');
      const {p1Lines, p2Lines} = arena.extractPerspectiveLogs(lines);
      const chosen = side === 'p2' ? p2Lines : p1Lines;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.end(`${chosen.join('\n')}\n`);
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.end(rawText);
  };

  app.get('/arena/ladders/:key/index.json', (req, res) => {
    handleLadder(req, res, paramStr(req.params.key), true);
  });
  app.get('/arena/ladders/:id/:file', (req, res) => {
    serveBattleLogFile(req, res, 'ladders', paramStr(req.params.id), paramStr(req.params.file));
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
    if (isJson) {
      const doc = arena.buildTournamentDocument(db, publicDir, tournament, 10_000);
      sendWithEtag(req, res, {
        body: `${JSON.stringify(doc, undefined, 2)}\n`,
        contentType: 'application/json; charset=utf-8',
      });
      return;
    }
    const state = arenaHandle.getState();
    sendWithEtag(req, res, {
      body: tournaments.renderTournamentPage({
        db,
        renderer,
        tournament,
        links: getLinks(),
        staticDir,
        tournamentBroadcast: arenaHandle.getTournamentBroadcast(tournament.id),
        liveTournament: db.getRunningTournament(),
        arenaRestarting: !state.stale && state.restarting,
        nowSec: getNowSec(),
      }).html,
      contentType: 'text/html; charset=utf-8',
    });
  };

  app.get('/arena/tournaments/:id/index.json', (req, res) => {
    handleTournament(req, res, paramStr(req.params.id), true);
  });
  app.get('/arena/tournaments/:id/:file', (req, res) => {
    serveBattleLogFile(req, res, 'tournaments', paramStr(req.params.id), paramStr(req.params.file));
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
    const summaries = db.getProjectArenaSummaries();
    const arenaByName = new Map<string, projects.ArenaInfo>();
    for (const s of summaries) {
      arenaByName.set(s.name, {
        slug: s.slug,
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
    sendWithEtag(req, res, {
      body: renderer.render({
        id: 'projects',
        ...projectsPage,
        header: build.injectLiveBanner(projectsPage.header, db.getRunningTournament()),
      }),
      contentType: 'text/html; charset=utf-8',
    });
  });

  const handleProjectProfile = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    rawParam: string,
    forceJson: boolean
  ) => {
    if (!rawParam) {
      if (forceJson) sendJsonNotFound(res);
      else sendHtmlNotFound(res);
      return;
    }

    const isJson = forceJson || rawParam.endsWith('.json');
    if (isJson) {
      const slug = rawParam.endsWith('.json') ? rawParam.slice(0, -5) : rawParam;
      const agent = db.getAgentBySlug(slug);
      if (!agent || agent.status === 'disabled') {
        sendJsonNotFound(res, `Unknown Arena agent "${slug}".`);
        return;
      }
      const doc = profile.buildAgentProfileDocument({db, agent, links: getLinks(), avatarsDir});
      sendWithEtag(req, res, {
        body: `${JSON.stringify(doc, undefined, 2)}\n`,
        contentType: 'application/json; charset=utf-8',
      });
      return;
    }

    // Fallback for agent logo assets (`/projects/<slug>.<ext>`) when running without Nginx
    // (local dev / tests); production Nginx serves built files from `public/projects/` directly.
    const dot = rawParam.lastIndexOf('.');
    if (dot > 0) {
      const logoAgent = db.getAgentBySlug(rawParam.slice(0, dot));
      if (logoAgent && logoAgent.status !== 'disabled') {
        const logo = profile.resolveAgentLogo(logoAgent, avatarsDir);
        if (logo?.fileName === rawParam) {
          const query = (req.url ?? '').split('?', 2)[1];
          const v = query ? new URLSearchParams(query).get('v') : undefined;
          const cacheControl = v === logo.hash
            ? 'public, max-age=31536000, immutable'
            : 'public, max-age=604800';
          sendWithEtag(req, res, {
            body: fs.readFileSync(logo.filePath),
            contentType: logo.contentType,
            cacheControl,
          });
          return;
        }
      }
    }

    const agent = db.getAgentBySlug(rawParam);
    if (agent && agent.status !== 'disabled') {
      sendWithEtag(req, res, {
        body: profile.renderAgentProfileHtml({
          db,
          renderer,
          agent,
          links: getLinks(),
          avatarsDir,
          liveTournament: db.getRunningTournament(),
          nowSec: getNowSec(),
        }),
        contentType: 'text/html; charset=utf-8',
      });
      return;
    }

    if (ASSET_EXT_RE.test(rawParam)) {
      sendHtmlNotFound(res);
      return;
    }

    res.writeHead(302, {Location: `/projects/#${encodeURIComponent(rawParam)}`});
    res.end();
  };

  app.get('/projects/:slug/ladders/:key', (req, res) => {
    const slug = paramStr(req.params.slug);
    const rawKey = paramStr(req.params.key);
    if (!rawKey.endsWith('.json')) {
      sendHtmlNotFound(res);
      return;
    }
    const ladderKey = rawKey.slice(0, -5);
    const agent = db.getAgentBySlug(slug);
    if (!agent || agent.status === 'disabled') {
      sendJsonNotFound(res, `Unknown Arena agent "${slug}".`);
      return;
    }
    const payload = profile.buildAgentProfileLadderPayload({
      db,
      agent,
      ladderKey,
      links: getLinks(),
      nowSec: getNowSec(),
    });
    if (!payload) {
      sendJsonNotFound(res, `Unknown ladder "${ladderKey}" for agent "${slug}".`);
      return;
    }
    sendWithEtag(req, res, {
      body: JSON.stringify(payload),
      contentType: 'application/json; charset=utf-8',
    });
  });

  app.get('/projects/:slug/index.json', (req, res) => {
    handleProjectProfile(req, res, paramStr(req.params.slug), true);
  });
  app.get('/projects/:param', (req, res) => {
    handleProjectProfile(req, res, paramStr(req.params.param), false);
  });
}
