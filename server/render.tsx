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
import {renderAgentProfile, resolveAgentLogo} from './profile';
import * as ratings from './ratings';
import * as tournaments from './tournaments';

export const PUBLIC_DIR = util.root('public');
export const STATIC_DIR =
  process.env.MOCK === '1' ? util.root('.mock', 'static') : util.root('static');

export const ARENA_STYLE = fs.readFileSync(util.root('static', 'style', 'arena.css'), 'utf8');

export const EXT_ICON = util.EXT_ICON;
export const copyFileAtomic = util.copyFileAtomic;
export const writeFileAtomic = util.writeFileAtomic;
export const resolveLadderArchive = arena.resolveLadderArchive;

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
    const verRadios = document.querySelectorAll('input[name="versions"]');
    const rows = Array.from(document.querySelectorAll('.standings-table tbody tr'));
    const pager = document.getElementById('standings-pager');
    const prevBtn = document.getElementById('standings-pager-prev');
    const nextBtn = document.getElementById('standings-pager-next');
    const infoEl = document.getElementById('standings-pager-info');
    const pageSize = 25;
    let mode = 'active';
    let page = 1;

    const applyStandings = () => {
      const matching = rows.filter(row => {
        if (mode === 'all') return true;
        if (mode === 'best') return Boolean(row.dataset.best);
        return Boolean(row.dataset.active);
      });
      const total = matching.length;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      if (page > totalPages) page = totalPages;
      if (page < 1) page = 1;
      const start = (page - 1) * pageSize;
      const visible = new Set(matching.slice(start, start + pageSize));
      rows.forEach(row => {
        row.classList.toggle('hide', !visible.has(row));
      });
      if (pager && prevBtn && nextBtn && infoEl) {
        pager.classList.toggle('hide', totalPages <= 1);
        prevBtn.disabled = page <= 1;
        nextBtn.disabled = page >= totalPages;
        const word = total === 1 ? 'entry' : 'entries';
        infoEl.textContent =
          'Page ' + page + ' of ' + totalPages +
          ' (' + total.toLocaleString('en-US') + ' ' + word + ')';
      }
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
  });
`;

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

    const utcStr = ts =>
      new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

    const resolveAgentHref = slug => {
      if (!slug) return '';
      if (Object.prototype.hasOwnProperty.call(agentLinks, slug)) return agentLinks[slug];
      return '/projects/' + encodeURIComponent(slug) + '/';
    };

    const renderAgent = (agent, bold) => {
      const inner = bold ? '<strong>' + esc(agent.name) + '</strong>' : esc(agent.name);
      const href = resolveAgentHref(agent.slug);
      const link = href ? '<a href="' + esc(href) + '" class="subtle">' + inner + '</a>' : inner;
      return link + ' <code>' + esc(agent.version) + '</code>';
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

    const formatGamePlayerTelemetryHtml = (meanMillis, bankSeconds, peakRam, maxRamMib) => {
      const cap = maxRamMib || 14336;
      const ramStr = Math.round(peakRam).toLocaleString('en-US') + ' MiB';
      const ramPct = ((peakRam / cap) * 100).toFixed(1);
      return '<span>Mean <tt>' + Math.round(meanMillis) + ' ms/turn</tt> · Bank <tt>' +
        Math.round(bankSeconds) + 's</tt> · RAM <tt>' + ramStr +
        '</tt> <span class="muted">(' + ramPct + '%)</span></span>';
    };

    const renderMatchDetailHtml = (m, perspectiveSlug) => {
      const omitOutcome = Boolean(perspectiveSlug);
      const p1IsUs = Boolean(perspectiveSlug && m.p1 && m.p1.slug === perspectiveSlug);
      const p2IsUs = Boolean(perspectiveSlug && m.p2 && m.p2.slug === perspectiveSlug);
      const g1P1Label = p1IsUs ? '(P1)' : 'P1';
      const g1P2Label = p2IsUs ? '(P2)' : 'P2';
      const g2P1Label = p2IsUs ? '(P1)' : 'P1';
      const g2P2Label = p1IsUs ? '(P2)' : 'P2';

      const end1 = formatEndReason(m.game1EndReason);
      const end2 = formatEndReason(m.game2EndReason);

      const showPools = m.teamMode === 'pools' || Boolean(m.p1TeamLabel || m.p2TeamLabel);
      const t1Code = formatPoolCode(m.p1TeamLabel, m.p1.name, m.p2.name);
      const t2Code = formatPoolCode(m.p2TeamLabel, m.p1.name, m.p2.name);

      const g1P1Mean = m.p1Game1MeanTurnMillis !== undefined
        ? m.p1Game1MeanTurnMillis
        : m.p1MeanTurnMillis;
      const g1P2Mean = m.p2Game1MeanTurnMillis !== undefined
        ? m.p2Game1MeanTurnMillis
        : m.p2MeanTurnMillis;
      const g2P1Mean = m.p2Game2MeanTurnMillis !== undefined
        ? m.p2Game2MeanTurnMillis
        : m.p2MeanTurnMillis;
      const g2P2Mean = m.p1Game2MeanTurnMillis !== undefined
        ? m.p1Game2MeanTurnMillis
        : m.p1MeanTurnMillis;

      const g1P1Bank = m.p1Game1BankSeconds;
      const g1P2Bank = m.p2Game1BankSeconds;
      const g2P1Bank = m.p2Game2BankSeconds;
      const g2P2Bank = m.p1Game2BankSeconds;

      const g1P1Ram = m.p1Game1PeakRam !== undefined ? m.p1Game1PeakRam : m.p1PeakRam;
      const g1P2Ram = m.p2Game1PeakRam !== undefined ? m.p2Game1PeakRam : m.p2PeakRam;
      const g2P1Ram = m.p2Game2PeakRam !== undefined ? m.p2Game2PeakRam : m.p2PeakRam;
      const g2P2Ram = m.p1Game2PeakRam !== undefined ? m.p1Game2PeakRam : m.p1PeakRam;

      const replayAttrs = (m.game1LogHref || m.game2LogHref)
        ? ' data-match-id="' + esc(m.id) +
          '" data-p1-name="' + esc(m.p1.name) +
          '" data-p2-name="' + esc(m.p2.name) + '"' +
          (m.game1LogHref ? ' data-g1-log="' + esc(m.game1LogHref) + '"' : '') +
          (m.game2LogHref ? ' data-g2-log="' + esc(m.game2LogHref) + '"' : '')
        : '';

      let archiveNote = '';
      if (m.teamMode === 'pools' && m.ladderStatus === 'archived') {
        const links = [];
        if (m.archiveHref) {
          links.push(
            '<a href="' + esc(m.archiveHref) + '" class="subtle"><code>' +
            esc(m.ladderId + '-logs.7z') + '</code></a>'
          );
        }
        if (m.teamsHref) {
          links.push(
            '<a href="' + esc(m.teamsHref) + '" class="subtle"><code>teams.json</code></a>'
          );
        }
        if (links.length > 0) {
          archiveNote = '<div class="battle-detail-note muted">Retired pool archives: ' +
            links.join(' · ') + '</div>';
        }
      }

      const g1OutcomePrefix = omitOutcome ? '' : (formatGameOutcomeHtml(m.game1Outcome) + ' · ');
      const g2OutcomePrefix = omitOutcome ? '' : (formatGameOutcomeHtml(m.game2Outcome) + ' · ');
      const g1EndSuffix = end1.show ? (' · ' + end1.html) : '';
      const g2EndSuffix = end2.show ? (' · ' + end2.html) : '';

      return '<div class="battle-detail"' + replayAttrs + '>' +
        '<div class="battle-detail-meta">' +
          '<span class="muted">' + esc(utcStr(m.completedAt)) + '</span>' +
          '<span><span class="muted">Seed:</span> <code>' + esc(m.seed) + '</code></span>' +
        '</div>' +
        '<div class="battle-detail-grid">' +
          '<div class="battle-detail-card">' +
            '<div class="battle-detail-title">' +
              '<span>Game 1</span>' +
              '<span class="battle-detail-sub">' + g1OutcomePrefix +
                '<tt>' + m.game1Turns + ' turns</tt>' + g1EndSuffix +
              '</span>' +
            '</div>' +
            '<div class="battle-detail-line">' +
              '<span><tt>' + g1P1Label + '</tt>' + (showPools ? ' ' + t1Code : '') + '</span>' +
              formatGamePlayerTelemetryHtml(g1P1Mean, g1P1Bank, g1P1Ram) +
            '</div>' +
            '<div class="battle-detail-line">' +
              '<span><tt>' + g1P2Label + '</tt>' + (showPools ? ' ' + t2Code : '') + '</span>' +
              formatGamePlayerTelemetryHtml(g1P2Mean, g1P2Bank, g1P2Ram) +
            '</div>' +
          '</div>' +
          '<div class="battle-detail-card">' +
            '<div class="battle-detail-title">' +
              '<span>Game 2</span>' +
              '<span class="battle-detail-sub">' + g2OutcomePrefix +
                '<tt>' + m.game2Turns + ' turns</tt>' + g2EndSuffix +
              '</span>' +
            '</div>' +
            '<div class="battle-detail-line">' +
              '<span><tt>' + g2P1Label + '</tt>' + (showPools ? ' ' + t1Code : '') + '</span>' +
              formatGamePlayerTelemetryHtml(g2P1Mean, g2P1Bank, g2P1Ram) +
            '</div>' +
            '<div class="battle-detail-line">' +
              '<span><tt>' + g2P2Label + '</tt>' + (showPools ? ' ' + t2Code : '') + '</span>' +
              formatGamePlayerTelemetryHtml(g2P2Mean, g2P2Bank, g2P2Ram) +
            '</div>' +
          '</div>' +
        '</div>' +
        archiveNote +
      '</div>';
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

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
      document.querySelectorAll('iframe.replay-viewer-frame').forEach(f => {
        postToFrame(f, {type: 'theme', dark: e.matches});
      });
    });

    window.addEventListener('message', ev => {
      const data = ev.data;
      if (!data || typeof data !== 'object') return;
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
      const g1Log = slot.getAttribute('data-g1-log') || '';
      const g2Log = slot.getAttribute('data-g2-log') || '';
      const isSingleGame = slot.getAttribute('data-single-game') === '1';
      const activeGame = (gameNum === 2 && g2Log) ? 2 : 1;
      const logUrl = activeGame === 2 ? g2Log : (g1Log || g2Log);
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
          '<div class="viewer-wrap">' +
            '<iframe class="viewer-frame replay-viewer-frame" src="/arena/viewer/" ' +
              'title="Pokémon Showdown replay viewer" ' +
              'sandbox="allow-scripts allow-same-origin"></iframe>' +
          '</div>';
        slot.insertBefore(wrap, slot.querySelector('.battle-detail-note'));
      }
      const leftEl = slot.querySelector('.replay-bar-left');
      const rightEl = slot.querySelector('.replay-bar-right');
      const seat1 = activeGame === 2 ? p2Name : p1Name;
      const seat2 = activeGame === 2 ? p1Name : p2Name;
      if (leftEl) {
        if (isSingleGame) {
          leftEl.innerHTML = '<strong>Replay</strong> · <code>' + esc(matchId) + '</code> ' +
            '<span class="muted">(<tt>p1</tt> ' + esc(p1Name) +
            ' vs <tt>p2</tt> ' + esc(p2Name) + ')</span>';
        } else {
          leftEl.innerHTML = '<strong>Replay</strong> · <code>' + esc(matchId) +
            '</code> · <strong>Game ' + activeGame + ' / 2</strong> ' +
            '<span class="muted">(<tt>p1</tt> ' + esc(seat1) +
            ' vs <tt>p2</tt> ' + esc(seat2) + ')</span>';
        }
      }
      if (rightEl) {
        const pills = [];
        if (!isSingleGame) {
          if (g1Log) {
            pills.push(
              '<a href="' + esc(g1Log) + '" class="live-pill' +
              (activeGame === 1 ? ' active' : '') + '" data-replay-log="' + esc(g1Log) +
              '" data-replay-match="' + esc(matchId) +
              '" data-replay-game="1">&#9654; Game 1</a>'
            );
          }
          if (g2Log) {
            pills.push(
              '<a href="' + esc(g2Log) + '" class="live-pill' +
              (activeGame === 2 ? ' active' : '') + '" data-replay-log="' + esc(g2Log) +
              '" data-replay-match="' + esc(matchId) +
              '" data-replay-game="2">&#9654; Game 2</a>'
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
  agentLinksJson: string,
  formatTitlesJson: string
): string {
  return `
  document.addEventListener('DOMContentLoaded', () => {
    let state = ${initialLiveJson} || {};
    const agentLinks = ${agentLinksJson};
    const formatTitles = ${formatTitlesJson};
    const livePanel = document.getElementById('live-panel');
    const battleViewerWrap = document.getElementById('battle-viewer-wrap');
    const battleViewerLeft = document.getElementById('battle-viewer-left');
    const battleViewerRight = document.getElementById('battle-viewer-right');
    const liveViewerFrame = document.getElementById('ps-viewer-frame');
    const tbody = document.getElementById('battles-tbody');
    const pager = document.getElementById('battles-pager');
    const prevBtn = document.getElementById('battles-prev');
    const nextBtn = document.getElementById('battles-next');
    const pageInfo = document.getElementById('battles-page-info');
    const radios = document.querySelectorAll('input[name="bformat"]');
    const pageSize = (state && state.pageSize) || 25;
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
      Array.isArray(state.live.lines) &&
      state.live.lines.length > 0
    )
      ? {...state.live, ended: false, seekEnd: true}
      : undefined;
    let queuedLive = undefined;
    let sentLineCount = 0;
    let sentP1Count = 0;
    let sentP2Count = 0;
    let sentEnd = false;

    ${buildBattleDetailClientJs()}

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
      postToFrame(liveViewerFrame, {type: 'theme', dark: e.matches});
    });

    const renderShownHeader = () => {
      if (!shownLive) return;
      if (battleViewerWrap) battleViewerWrap.classList.remove('hide');
      const seat1 = shownLive.game === 2 ? shownLive.p2 : shownLive.p1;
      const seat2 = shownLive.game === 2 ? shownLive.p1 : shownLive.p2;
      if (battleViewerLeft) {
        const badge = shownLive.ended
          ? '<span class="muted">Finished</span>'
          : '<span class="yes">&#9679; Live</span>';
        battleViewerLeft.innerHTML = badge + ' · <code>' +
          esc(shownLive.matchId) + '</code> · <strong>Game ' + shownLive.game + ' / 2</strong>';
      }
      if (battleViewerRight) {
        battleViewerRight.innerHTML = '<tt>p1</tt> ' + renderAgent(seat1, true) +
          ' vs <tt>p2</tt> ' + renderAgent(seat2, true);
      }
    };

    const loadShownIntoViewer = () => {
      if (!shownLive) return;
      renderShownHeader();
      const lines = Array.isArray(shownLive.lines) ? shownLive.lines : [];
      const p1Lines = Array.isArray(shownLive.p1Lines) ? shownLive.p1Lines : undefined;
      const p2Lines = Array.isArray(shownLive.p2Lines) ? shownLive.p2Lines : undefined;
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
        p1Pokemon: shownLive.p1Pokemon,
        p2Pokemon: shownLive.p2Pokemon,
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
      if (!shownLive) return;
      renderShownHeader();
      const lines = Array.isArray(shownLive.lines) ? shownLive.lines : [];
      const p1Lines = Array.isArray(shownLive.p1Lines) ? shownLive.p1Lines : undefined;
      const p2Lines = Array.isArray(shownLive.p2Lines) ? shownLive.p2Lines : undefined;
      if (liveViewerReady && lines.length > sentLineCount) {
        postToFrame(liveViewerFrame, {
          type: 'append',
          lines: lines.slice(sentLineCount),
          p1Lines: p1Lines ? p1Lines.slice(sentP1Count) : undefined,
          p2Lines: p2Lines ? p2Lines.slice(sentP2Count) : undefined,
          p1Pokemon: shownLive.p1Pokemon,
          p2Pokemon: shownLive.p2Pokemon,
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
          } else if (state && state.live && !Array.isArray(state.live.lines)) {
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

    const renderSlot = (key, slotData, live, nowSec) => {
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
      const badge = isRunning
        ? '<span class="state-running" id="state-' + key +
          '" title="Currently executing (SIGCONT)">&#9679; RUNNING</span>'
        : '<span class="state-paused" id="state-' + key +
          '" title="Frozen by kernel SIGSTOP while ' + otherKey + ' computes">PAUSED</span>';
      const timerTitle =
        'Pokémon Showdown RoomBattleTimer: 150s max bank (+60s Turn 1 grace), +' +
        inc + 's/turn';
      let teamHtml = '';
      if (slotData.team) {
        const teamTip = slotData.team.startsWith('P1:')
          ? 'Known to Match P1 (drawn from P1 seasonal pool)'
          : slotData.team.startsWith('P2:')
            ? 'Known to Match P2 (drawn from P2 seasonal pool)'
            : 'Unknown to both players (drawn from a third-party competitor pool)';
        teamHtml = '<span title="' + esc(teamTip) + '">Team: <code>' +
          esc(slotData.team) + '</code></span>';
      }
      return '<div class="slot-card ' + (isRunning ? 'running' : 'paused') +
        '" id="slot-' + key + '">' +
        '<div class="slot-top"><span><tt>' + key + '</tt> ' +
        renderAgent(slotData, true) + '</span>' +
        badge + '</div>' +
        '<div class="slot-timers" title="' + esc(timerTitle) + '">' +
        '<span>Turn: <strong id="turn-' + key + '" class="' +
        (isRunning ? 'yes' : 'muted') + '">' +
        elapsed + 's</strong> <span class="muted">/ ' + budget + 's</span></span>' +
        '<span>Bank: <strong id="bank-' + key + '">' + bank + 's</strong> ' +
        '<span class="muted">(+' + inc + 's/turn)</span></span></div>' +
        '<div class="slot-telemetry">' +
        '<span>Last: <tt>' + Math.round(slotData.lastTurnMillis) + ' ms</tt></span>' +
        '<span>Mean: <tt>' + Math.round(slotData.meanTurnMillis) + ' ms/turn</tt></span>' +
        '<span title="XNU ri_phys_footprint (14 GiB limit)">RAM: <tt>' +
        Math.round(slotData.ram).toLocaleString('en-US') + ' MiB</tt> (' + ramPct + '%)</span>' +
        teamHtml +
        '</div></div>';
    };

    const renderLive = nowSec => {
      if (!livePanel) return;
      if (!state || !state.live || state.stale) {
        const idleMsg = state && state.stale
          ? 'No active heartbeat — Arena is offline or idle.'
          : 'No battle currently running — Arena is idle.';
        const tourSuffix = state && state.runningTournament
          ? ' · <a href="' + esc(state.runningTournament.href) + '" class="subtle">' +
            '<strong>&#9679; Watch ' + esc(state.runningTournament.name) + ' live</strong></a>'
          : '';
        livePanel.innerHTML = '<div class="live-idle muted">' + idleMsg + tourSuffix + '</div>';
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
          } else {
            renderShownHeader();
          }
        } else if (battleViewerWrap) {
          battleViewerWrap.classList.add('hide');
        }
        return;
      }
      const l = state.live;
      const fmtTitle = formatTitles[l.format] || l.format;
      let g1Html = '';
      if (l.game1Summary) {
        const g1Res = l.game1Summary.winnerSlot === 'p1'
          ? esc(l.p1.name) + ' 1–0'
          : l.game1Summary.winnerSlot === 'p2'
            ? esc(l.p2.name) + ' 1–0'
            : 'Tie';
        g1Html = ' <span class="muted">(<tt>G1</tt>: ' + g1Res + ', ' +
          l.game1Summary.turns + ' turns)</span>';
      }
      const hbAge = Math.max(0, nowSec - state.updatedAt);
      livePanel.innerHTML = '<div class="live-header"><span><code>' + esc(l.matchId) +
        '</code> · <tt>' + esc(fmtTitle) + '</tt> · <strong>Game ' + l.game +
        ' / 2</strong>, Turn ' + l.turn + g1Html + '</span>' +
        '<span class="muted">Heartbeat <tt>#' + l.heartbeatSeq + '</tt> (<tt id="hb-age">' +
        hbAge + 's</tt> ago)</span></div>' +
        '<div class="slots-grid">' +
        renderSlot('p1', l.p1, l, nowSec) +
        renderSlot('p2', l.p2, l, nowSec) +
        '</div>';

      if (Array.isArray(l.lines) && l.lines.length > 0) {
        const gameKey = l.matchId + ':' + l.game;
        const shownKey = shownLive ? (shownLive.matchId + ':' + shownLive.game) : '';
        if (!shownLive) {
          shownLive = {...l, ended: false, seekEnd: true};
          queuedLive = undefined;
          loadShownIntoViewer();
        } else if (gameKey === shownKey) {
          const prevLen = Array.isArray(shownLive.lines) ? shownLive.lines.length : 0;
          shownLive = {...l, ended: false, seekEnd: shownLive.seekEnd};
          if (l.lines.length < prevLen) {
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
            renderShownHeader();
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
        renderShownHeader();
      } else {
        if (battleViewerWrap) battleViewerWrap.classList.add('hide');
        shownLive = undefined;
        queuedLive = undefined;
      }
    };

    const renderMatchPair = (m, nowSec, expanded) => {
      const r = resultParts(m.category);
      const b1 = Math.round(Math.min(m.p1Game1BankSeconds, m.p1Game2BankSeconds));
      const b2 = Math.round(Math.min(m.p2Game1BankSeconds, m.p2Game2BankSeconds));
      const reasons = (isFaultReason(m.game1EndReason) || isFaultReason(m.game2EndReason))
        ? ' · End: ' + m.game1EndReason + '/' + m.game2EndReason
        : '';
      const tip = m.category + ' · ' + Math.round(m.p1MeanTurnMillis) + 'ms/' +
        Math.round(m.p2MeanTurnMillis) + 'ms · Bank ' + b1 + 's/' + b2 + 's · RAM ' +
        Math.round(m.p1PeakRam).toLocaleString('en-US') + 'M/' +
        Math.round(m.p2PeakRam).toLocaleString('en-US') + 'M' + reasons;

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
        '<td class="num muted" data-ts="' + m.completedAt + '">' +
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
      if (!pager || !prevBtn || !nextBtn || !pageInfo) return;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      pager.classList.toggle('hide', total === 0 || (totalPages <= 1 && page <= 1));
      prevBtn.disabled = page <= 1;
      nextBtn.disabled = page >= totalPages;
      pageInfo.textContent = 'Page ' + page + ' of ' + totalPages + ' (' +
        total.toLocaleString('en-US') + ' ' + (total === 1 ? 'battle' : 'battles') + ')';
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
          if (turnEl) turnEl.textContent = dt + 's';
          if (bankEl) bankEl.textContent = Math.max(0, Math.round(slot.bankSeconds - dt)) + 's';
        }
      }
      if (tickCount % 15 === 0) {
        refreshTimestamps(nowSec);
      }
    }, 1000);

    const liveKey = doc => {
      const tourId = (doc && doc.runningTournament && doc.runningTournament.id) || '';
      if (doc && doc.live && !doc.stale) {
        return doc.live.matchId + ':' + doc.live.heartbeatSeq + ':' + doc.stale + ':' + tourId;
      }
      return 'idle:' + Boolean(doc && doc.stale) + ':' + tourId;
    };

    const applySnapshot = next => {
      if (!next) return;
      const nowSec = Math.floor(Date.now() / 1000);
      const prevKey = liveKey(state);
      const nextKey = liveKey(next);
      state = next;
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
          state.live = state.stale ? undefined : data.live;
          state.runningTournament = data.runningTournament;
          renderLive(nowSec);
        } catch {}
      });
      es.addEventListener('match', ev => {
        try {
          const data = JSON.parse(ev.data);
          const nowSec = Math.floor(Date.now() / 1000);
          state.updatedAt = data.updatedAt || nowSec;
          state.stale = Boolean(data.stale);
          state.live = state.stale ? undefined : data.live;
          state.runningTournament = data.runningTournament;
          if (data.totalMatches !== undefined) state.totalMatches = data.totalMatches;
          if (data.countsBySlot) state.countsBySlot = data.countsBySlot;
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
  renderer?: build.Renderer;
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

  let fallbackSolve: ReturnType<typeof ratings.solveIndexedDavidson> | undefined;

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
      fallbackSolve ??= ratings.solveIndexedDavidson(entries, pairs);
      const idxCur = fallbackSolve.indexByVer.get(cur.versionId);
      const idxNext = fallbackSolve.indexByVer.get(next.versionId);
      if (idxCur !== undefined && idxNext !== undefined) {
        const los = ratings.computeLOS(
          fallbackSolve.theta,
          fallbackSolve.covariance,
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

function renderHistorySection(
  ladder: db.LadderRow,
  entries: db.LeaderboardEntryView[],
  snapshots: db.LadderSnapshotHistoryRow[],
  nowSec: number
): {node: util.Child; isEmpty: boolean} {
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
      node: <p className='empty-state muted'>No rating history yet.</p>,
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

    if (aIdx === 0 && coords.length >= 2) {
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
  publicDir: string,
  projectMeta: ReadonlyMap<string, ProjectMeta>,
  profileSlugs: ReadonlySet<string>,
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
    const rowHref = resolveAgentHref(
      publicDir,
      projectMeta,
      rowEntry.agentSlug,
      rowEntry.agentName,
      profileSlugs
    );

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
          <code>{rowEntry.version}</code>
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

function renderSingleLadderArtifact(opts: {
  ladder: db.LadderRow;
  currentLadders: db.LadderRow[];
  urlKey: string;
  db: db.Database;
  renderer: build.Renderer;
  publicDir: string;
  projectMeta: ReadonlyMap<string, ProjectMeta>;
  profileSlugs: ReadonlySet<string>;
  nowSec: number;
}): {
  html: string;
  standingsLadder: StandingsLadder;
  ladderDoc: LadderDocument;
  top1Entry?: StandingsEntry;
  entrantCount: number;
  matchCount: number;
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

  const formatNavItems: util.Child[] = [];
  currentLadders.forEach((other, idx) => {
    if (idx > 0) formatNavItems.push(' — ');
    const href = `/arena/ladders/${encodeURIComponent(other.slot)}/`;
    const isCurrent = !isPastSeason && other.slot === l.slot;
    formatNavItems.push(
      <li id={other.slot}>
        <a href={href} className='subtle' aria-current={isCurrent ? 'page' : undefined}>
          {isCurrent ? <strong>{other.name}</strong> : other.name}
        </a>
      </li>
    );
  });
  if (isPastSeason) {
    const selfHref = `/arena/ladders/${encodeURIComponent(l.id)}/`;
    if (formatNavItems.length > 0) formatNavItems.push(' — ');
    formatNavItems.push(
      <li id={l.id}>
        <a href={selfHref} className='subtle' aria-current='page'>
          <strong>{l.name}</strong>
        </a>{' '}
        <span className='muted'>({l.status})</span>
      </li>
    );
  }

  const seenPrimaryAgent = new Set<number>();
  const seenAnyAgent = new Set<number>();
  const jsonRows: StandingsEntry[] = [];
  let top1Entry: StandingsEntry | undefined;
  let standingsPane: util.Child;

  if (entries.length === 0) {
    const msg = l.status === 'upcoming'
      ? `${l.name} ladder is upcoming — accepting initial entries before matchmaking begins.`
      : isArchived
        ? `${l.name} archived with no completed entries.`
        : `No active entries on ${l.name} yet.`;
    standingsPane = <p className='empty-state muted'>{msg}</p>;
  } else if (l.status === 'upcoming') {
    const activeEntrants = entries
      .filter(e => e.role === 'champion' || e.role === 'challenger')
      .sort((a, b) => a.submittedAt - b.submittedAt || a.versionId - b.versionId);
    for (const e of activeEntrants) {
      seenPrimaryAgent.add(e.agentId);
      seenAnyAgent.add(e.agentId);
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
    standingsPane = activeEntrants.length === 0 ? (
      <p className='empty-state muted'>
        {`${l.name} ladder is upcoming — accepting initial entries before matchmaking begins.`}
      </p>
    ) : (
      <>
        <div className='table-wrap'>
          <table className='standings-table'>
            <thead>
              <tr>
                <th>#</th>
                <th>Agent</th>
                <th className='num'>Submitted</th>
              </tr>
            </thead>
            <tbody>
              {activeEntrants.map((e, idx) => {
                const href = resolveAgentHref(
                  publicDir,
                  projectMeta,
                  e.agentSlug,
                  e.agentName,
                  profileSlugs
                );
                return (
                  <tr className={idx >= util.TABLE_PAGE_SIZE ? 'hide' : undefined}>
                    <td><strong>{idx + 1}</strong></td>
                    <td>
                      {renderAgentLink(e.agentName, href, true)} <code>{e.version}</code>
                    </td>
                    <td className='num muted'>{util.formatUtcDate(e.submittedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <util.TablePager
          id='standings-pager'
          label='Entrants pagination'
          total={activeEntrants.length}
          singular='entrant'
          plural='entrants'
        />
      </>
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

      const href = resolveAgentHref(
        publicDir,
        projectMeta,
        e.agentSlug,
        e.agentName,
        profileSlugs
      );
      const meta = projectMeta.get(e.agentName);
      const agentCell = (
        <td>
          {renderAgentLink(e.agentName, href, isRankedPrimary)}{' '}
          <code>{e.version}</code>
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
      const losPct = adjLos !== undefined ? Math.round(adjLos * 1000) / 10 : undefined;
      const losCell = adjLos !== undefined
        ? <td className='num'>{(adjLos * 100).toFixed(1)}%</td>
        : <td className='num muted'>—</td>;

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

      if (isRankedPrimary && e.rankCurrent === 1 && top1Entry === undefined) {
        top1Entry = entryObj;
      }

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
    const thWlt = '2-game blind-pair Match Wins – Losses – Ties (1-1 splits)';
    const thStreak = 'Current consecutive outright match win/loss streak';
    const thLos = 'Pairwise Likelihood of Superiority over the next-ranked settled agent';
    standingsPane = (
      <>
        <div className='table-wrap'>
          <table className='standings-table'>
            <thead>
              <tr>
                <th title='Official rank by Conservative Rating (Elo - 1.96 * SE)'>#</th>
                <th>Agent</th>
                <th className='num' title='MAP Davidson Elo ± 95% Confidence Interval'>Elo</th>
                <th className='num' title={thGxe}>GXE</th>
                <th className='num' title={thWlt}>W–L–T</th>
                <th className='center' title={thStreak}>Streak</th>
                <th className='num' title={thLos}>LOS</th>
              </tr>
            </thead>
            <tbody>{rows}</tbody>
          </table>
        </div>
        <util.TablePager
          id='standings-pager'
          label='Standings pagination'
          total={activeCount}
          singular='entry'
          plural='entries'
        />
      </>
    );
  }

  const archive = resolveLadderArchive(publicDir, l);
  const urlEnc = encodeURIComponent(urlKey);
  const teamsHref = l.team === 'pools' && l.status === 'archived'
    ? `/arena/ladders/${urlEnc}/teams.json`
    : undefined;
  const jsonHref = `/arena/ladders/${urlEnc}/index.json`;

  let ladderArchiveNote: util.Child;
  let ladderBottomNote: util.Child;
  if (l.team === 'pools' && l.status === 'archived') {
    if (archive) {
      ladderArchiveNote = (
        <p className='battle-note muted'>
          Retired season archive:{' '}
          <a href={archive.href} className='subtle'>
            <code>{archive.name}</code>
          </a>{' '}
          (full Showdown battle logs &amp; unpacked teams) ·{' '}
          <a href={teamsHref!} className='subtle'><code>teams.json</code></a> ·{' '}
          <a href={jsonHref} className='subtle'><code>index.json</code></a>
        </p>
      );
    } else {
      ladderArchiveNote = (
        <p className='battle-note muted'>
          Retired season data:{' '}
          <a href={teamsHref!} className='subtle'><code>teams.json</code></a> ·{' '}
          <a href={jsonHref} className='subtle'><code>index.json</code></a> ·{' '}
          full battle log archive (<code>{`${l.id}-logs.7z`}</code>) pending upload.
        </p>
      );
    }
  } else if (l.team === 'pools' && l.status === 'settling') {
    ladderArchiveNote = (
      <p className='battle-note muted'>
        Season settling — full battle log archive (<code>{`${l.id}-logs.7z`}</code>) and{' '}
        <code>teams.json</code> will be published once remaining provisional entries settle and
        the ladder is retired.
      </p>
    );
  } else if (l.team === 'random' && archive) {
    ladderBottomNote = (
      <p className='battle-note muted'>
        Battle log archive (updated daily):{' '}
        <a href={archive.href} className='subtle'>
          <code>{archive.name}</code>
        </a>{' '}
        (full Showdown battle logs) ·{' '}
        <a href={jsonHref} className='subtle'><code>index.json</code></a>
      </p>
    );
  }

  const historyRes = renderHistorySection(l, entries, snapshots, nowSec);
  const matchupsRes = renderMatchupsSection(
    entries,
    pairs,
    publicDir,
    projectMeta,
    profileSlugs,
    l.status
  );

  const isUpcoming = l.status === 'upcoming';
  const ladderContent = String(
    <>
      <nav aria-label='Format'>
        <ul>
          {formatNavItems}
        </ul>
      </nav>
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
        {ladderArchiveNote}
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
    build.header(<a href='/arena/' className='subtle'>Ladders</a>),
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

  let pairMatchTotal = 0;
  for (const p of pairs) {
    pairMatchTotal += p.ww + p.wt + p.split + p.tl + p.ll;
  }
  let entryMatchSum = 0;
  for (const e of entries) {
    entryMatchSum += e.matches;
  }
  const matchCount = l.status === 'upcoming'
    ? 0
    : pairMatchTotal > 0
      ? pairMatchTotal
      : Math.round(entryMatchSum / 2);
  const entrantCount = seenPrimaryAgent.size || seenAnyAgent.size;

  return {
    html,
    standingsLadder,
    ladderDoc,
    top1Entry,
    entrantCount,
    matchCount,
    hasActiveEntries: entries.some(e => e.role === 'champion' || e.role === 'challenger'),
  };
}

export function renderArenaAndLadderArtifacts(opts: {
  db: db.Database;
  renderer: build.Renderer;
  publicDir: string;
  staticDir: string;
  projectMeta: ReadonlyMap<string, ProjectMeta>;
  profileSlugs: ReadonlySet<string>;
  liveMatch?: arena.LiveMatch;
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
  const {
    db,
    renderer,
    publicDir,
    staticDir,
    projectMeta,
    profileSlugs,
    liveMatch,
    nowSec,
  } = opts;
  const ladders = db.getCurrentLadders();
  const pastLadders = db.getLadders().filter(
    l => l.status === 'settling' || l.status === 'archived'
  );
  const lastCompletedByLadder = db.getLastCompletedAtByLadder();

  const ladderHtmlBySlot: Record<string, string> = {};
  const ladderJsonBySlot: Record<string, LadderDocument> = {};
  const archivedLadderHtmlById: Record<string, string> = {};
  const archivedLadderJsonById: Record<string, LadderDocument> = {};
  const archivedTeamsJsonById: Record<string, LadderTeamsDocument> = {};
  const jsonLadders: Record<string, StandingsLadder> = {};
  const archivedLadderSummaries: ArchivedLadderSummary[] = [];
  const pastBySlot = new Map<string, Array<{
    ladder: db.LadderRow;
    rendered: ReturnType<typeof renderSingleLadderArtifact>;
  }>>();

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

    const list = pastBySlot.get(l.slot) ?? [];
    list.push({ladder: l, rendered});
    pastBySlot.set(l.slot, list);
  }

  const ladderSummaryRows: util.Child[] = [];

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
    if (rendered.top1Entry !== undefined) {
      const w = rendered.top1Entry;
      const wHref = `/projects/${encodeURIComponent(w.slug)}/`;
      leaderCell = (
        <td>
          {renderAgentLink(w.name, wHref, true)} <code>{w.version}</code>
        </td>
      );
    } else {
      const stateLabel = l.status === 'upcoming'
        ? 'Upcoming'
        : rendered.hasActiveEntries
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
          <a href='/arena/battles/' className='live-pill'>{'\u25cf'} Live</a>
        </td>
      );
    } else if (l.status !== 'upcoming') {
      const lastTs = lastCompletedByLadder.get(l.id);
      if (lastTs !== undefined) {
        lastCell = (
          <td className='num muted' data-ts={lastTs}>
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
        <td className='num'>{rendered.entrantCount.toLocaleString('en-US')}</td>
        <td className='num'>{rendered.matchCount.toLocaleString('en-US')}</td>
        {lastCell}
      </tr>
    );

    for (const {ladder: past, rendered: pastRendered} of slotPast) {
      const pastHref = `/arena/ladders/${encodeURIComponent(past.id)}/`;
      const pastFmtTitle = FORMAT_TITLES[past.format] ?? past.format;
      const startDate = util.formatUtcDate(past.createdAt);
      const endDate = past.archivedAt !== undefined
        ? util.formatUtcDate(past.archivedAt)
        : util.formatUtcDate(nowSec);
      const dateRange = `${startDate} – ${endDate}`;
      const pastW = pastRendered.top1Entry;
      const pastLeaderCell = pastW ? (
        <td>
          {renderAgentLink(pastW.name, `/projects/${encodeURIComponent(pastW.slug)}/`, true)}{' '}
          <code>{pastW.version}</code>
        </td>
      ) : (
        <td className='muted'>—</td>
      );
      const pastLastTs = lastCompletedByLadder.get(past.id);
      const pastLastCell = pastLastTs !== undefined ? (
        <td className='num muted' data-ts={pastLastTs}>
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
            <span className='muted'>({past.status} · {dateRange})</span>
          </td>
          {pastLeaderCell}
          <td className='num'>{pastRendered.entrantCount.toLocaleString('en-US')}</td>
          <td className='num'>{pastRendered.matchCount.toLocaleString('en-US')}</td>
          {pastLastCell}
        </tr>
      );
    }
  }

  const allTournaments = db.getTournaments();
  const entrantsByTournament = new Map(
    allTournaments.map(t => [t.id, db.getTournamentEntrants(t.id)])
  );
  const tournamentSummaries: ArenaTournamentSummary[] = allTournaments.map(t => {
    const entrants = entrantsByTournament.get(t.id) ?? [];
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

  const arenaHtml = renderer.render({
    id: 'arena',
    title: 'Arena | pkmn.ai',
    header: build.injectLiveBanner(build.header('Arena'), db.getRunningTournament()),
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
): util.Child {
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

  const badge = isRunning ? (
    <span className='state-running' id={`state-${key}`} title='Currently executing (SIGCONT)'>
      {'\u25cf'} RUNNING
    </span>
  ) : (
    <span
      className='state-paused'
      id={`state-${key}`}
      title={`Frozen by kernel SIGSTOP while ${otherKey} computes`}
    >
      PAUSED
    </span>
  );

  const timerTitle =
    `Pokémon Showdown RoomBattleTimer: 150s max bank (+60s Turn 1 grace), +${inc}s/turn`;

  const turnCls = isRunning ? 'yes' : 'muted';
  const ramText = `${Math.round(slotData.ram).toLocaleString('en-US')} MiB`;
  let teamSpan: util.Child;
  if (slotData.team) {
    const teamTip = slotData.team.startsWith('P1:')
      ? 'Known to Match P1 (drawn from P1 seasonal pool)'
      : slotData.team.startsWith('P2:')
        ? 'Known to Match P2 (drawn from P2 seasonal pool)'
        : 'Unknown to both players (drawn from a third-party competitor pool)';
    teamSpan = (
      <span title={teamTip}>
        Team: <code>{slotData.team}</code>
      </span>
    );
  }
  return (
    <div className={`slot-card ${isRunning ? 'running' : 'paused'}`} id={`slot-${key}`}>
      <div className='slot-top'>
        <span>
          <tt>{key}</tt> {renderAgentLink(slotData.name, href, true)}{' '}
          <code>{slotData.version}</code>
        </span>
        {badge}
      </div>
      <div className='slot-timers' title={timerTitle}>
        <span>
          Turn: <strong id={`turn-${key}`} className={turnCls}>{elapsed}s</strong>{' '}
          <span className='muted'>/ {budget}s</span>
        </span>
        <span>
          Bank: <strong id={`bank-${key}`}>{bank}s</strong>{' '}
          <span className='muted'>(+{inc}s/turn)</span>
        </span>
      </div>
      <div className='slot-telemetry'>
        <span>Last: <tt>{Math.round(slotData.lastTurnMillis)} ms</tt></span>
        <span>Mean: <tt>{Math.round(slotData.meanTurnMillis)} ms/turn</tt></span>
        <span title='XNU ri_phys_footprint (14 GiB limit)'>
          RAM: <tt>{ramText}</tt> ({ramPct}%)
        </span>
        {teamSpan}
      </div>
    </div>
  );
}

function renderLivePanelInner(
  liveDoc: arena.LiveDocument | undefined,
  nowSec: number,
  publicDir: string,
  projectMeta: ReadonlyMap<string, ProjectMeta>,
  profileSlugs?: ReadonlySet<string>
): util.Child {
  if (!liveDoc?.live || liveDoc.stale) {
    const idleMsg = liveDoc?.stale
      ? 'No active heartbeat — Arena is offline or idle.'
      : 'No battle currently running — Arena is idle.';
    return (
      <div className='live-idle muted'>
        {idleMsg}
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
  const fmtTitle = FORMAT_TITLES[l.format] ?? l.format;
  let g1Node: util.Child;
  if (l.game1Summary) {
    const g1Res = l.game1Summary.winnerSlot === 'p1'
      ? `${l.p1.name} 1–0`
      : l.game1Summary.winnerSlot === 'p2'
        ? `${l.p2.name} 1–0`
        : 'Tie';
    g1Node = (
      <>
        {' '}
        <span className='muted'>
          (<tt>G1</tt>: {g1Res}, {l.game1Summary.turns} turns)
        </span>
      </>
    );
  }
  const hbAge = Math.max(0, nowSec - liveDoc.updatedAt);

  return (
    <>
      <div className='live-header'>
        <span>
          <code>{l.matchId}</code> · <tt>{fmtTitle}</tt> ·{' '}
          <strong>Game {l.game} / 2</strong>, Turn {l.turn}{g1Node}
        </span>
        <span className='muted'>
          Heartbeat <tt>#{l.heartbeatSeq}</tt> (<tt id='hb-age'>{hbAge}s</tt> ago)
        </span>
      </div>
      <div className='slots-grid'>
        {renderLiveSlotCard('p1', l.p1, l, nowSec, publicDir, projectMeta, profileSlugs)}
        {renderLiveSlotCard('p2', l.p2, l, nowSec, publicDir, projectMeta, profileSlugs)}
      </div>
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

function formatGameOutcomeNode(outcome: 'W' | 'L' | 'T'): util.Child {
  if (outcome === 'W') return <span className='yes' title='Player 1 won'>W</span>;
  if (outcome === 'L') return <span className='no' title='Player 2 won'>L</span>;
  return <span className='muted' title='Tie'>T</span>;
}

export function formatGamePlayerTelemetryNode(
  meanMillis: number,
  bankSeconds: number,
  peakRam: number,
  maxRamMib = 14336
): util.Child {
  const ramStr = `${Math.round(peakRam).toLocaleString('en-US')} MiB`;
  const ramPct = ((peakRam / maxRamMib) * 100).toFixed(1);
  return (
    <span>
      Mean <tt>{Math.round(meanMillis)} ms/turn</tt> · Bank{' '}
      <tt>{Math.round(bankSeconds)}s</tt> · RAM <tt>{ramStr}</tt>{' '}
      <span className='muted'>({ramPct}%)</span>
    </span>
  );
}

// Renders the inline expandable detail panel inside a battle history table row.
// Note on blind-pair seat swapping: in Game 1, Match P1 sits in Showdown slot `p1` with Team 1
// (`p1TeamLabel`) and Match P2 sits in slot `p2` with Team 2 (`p2TeamLabel`); in Game 2, the two
// agents swap seats (`p1` = Match P2 with Team 1, `p2` = Match P1 with Team 2) under the identical
// `@pkmn/sim` PRNG seed so simultaneous residual/switch ordering and speed-tie PRNG consumption
// stay coupled to the teams while canceling team matchup bias to first order.
export function renderBattleInlineDetailHtml(
  m: arena.BattleHistoryEntry,
  _agentLinks: Readonly<Record<string, string>>,
  perspectiveSlug?: string
): string {
  const omitOutcome = Boolean(perspectiveSlug);
  const p1IsUs = Boolean(perspectiveSlug && m.p1.slug === perspectiveSlug);
  const p2IsUs = Boolean(perspectiveSlug && m.p2.slug === perspectiveSlug);
  const g1P1Label = p1IsUs ? '(P1)' : 'P1';
  const g1P2Label = p2IsUs ? '(P2)' : 'P2';
  const g2P1Label = p2IsUs ? '(P1)' : 'P1';
  const g2P2Label = p1IsUs ? '(P2)' : 'P2';

  const completedIso = new Date(m.completedAt * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const completedUtc = `${completedIso} UTC`;

  const end1 = formatEndReasonNode(m.game1EndReason);
  const end2 = formatEndReasonNode(m.game2EndReason);

  const showPools = m.teamMode === 'pools' || Boolean(m.p1TeamLabel || m.p2TeamLabel);
  const t1Code = formatPoolTeamCode(m.p1TeamLabel, m.p1.name, m.p2.name);
  const t2Code = formatPoolTeamCode(m.p2TeamLabel, m.p1.name, m.p2.name);

  const hasReplay = Boolean(m.game1LogHref || m.game2LogHref);

  let archiveNote: util.Child;
  if (m.teamMode === 'pools' && m.ladderStatus === 'archived') {
    const links: util.Child[] = [];
    if (m.archiveHref) {
      links.push(
        <a href={m.archiveHref} className='subtle'>
          <code>{`${m.ladderId}-logs.7z`}</code>
        </a>
      );
    }
    if (m.teamsHref) {
      if (links.length > 0) links.push(' · ');
      links.push(<a href={m.teamsHref} className='subtle'><code>teams.json</code></a>);
    }
    if (links.length > 0) {
      archiveNote = <div className='battle-detail-note muted'>Retired pool archives: {links}</div>;
    }
  }

  return String(
    <div
      className='battle-detail'
      data-match-id={hasReplay ? m.id : undefined}
      data-p1-name={hasReplay ? m.p1.name : undefined}
      data-p2-name={hasReplay ? m.p2.name : undefined}
      data-g1-log={m.game1LogHref}
      data-g2-log={m.game2LogHref}
    >
      <div className='battle-detail-meta'>
        <span className='muted'>{completedUtc}</span>
        <span>
          <span className='muted'>Seed:</span> <code>{m.seed}</code>
        </span>
      </div>
      <div className='battle-detail-grid'>
        <div className='battle-detail-card'>
          <div className='battle-detail-title'>
            <span>Game 1</span>
            <span className='battle-detail-sub'>
              {!omitOutcome ? <>{formatGameOutcomeNode(m.game1Outcome)} · </> : undefined}
              <tt>{m.game1Turns} turns</tt>
              {end1.show ? <> · {end1.node}</> : undefined}
            </span>
          </div>
          <div className='battle-detail-line'>
            <span>
              <tt>{g1P1Label}</tt>
              {showPools ? <> {t1Code}</> : undefined}
            </span>
            {formatGamePlayerTelemetryNode(
              m.p1Game1MeanTurnMillis,
              m.p1Game1BankSeconds,
              m.p1Game1PeakRam
            )}
          </div>
          <div className='battle-detail-line'>
            <span>
              <tt>{g1P2Label}</tt>
              {showPools ? <> {t2Code}</> : undefined}
            </span>
            {formatGamePlayerTelemetryNode(
              m.p2Game1MeanTurnMillis,
              m.p2Game1BankSeconds,
              m.p2Game1PeakRam
            )}
          </div>
        </div>
        <div className='battle-detail-card'>
          <div className='battle-detail-title'>
            <span>Game 2</span>
            <span className='battle-detail-sub'>
              {!omitOutcome ? <>{formatGameOutcomeNode(m.game2Outcome)} · </> : undefined}
              <tt>{m.game2Turns} turns</tt>
              {end2.show ? <> · {end2.node}</> : undefined}
            </span>
          </div>
          <div className='battle-detail-line'>
            <span>
              <tt>{g2P1Label}</tt>
              {showPools ? <> {t1Code}</> : undefined}
            </span>
            {formatGamePlayerTelemetryNode(
              m.p2Game2MeanTurnMillis,
              m.p2Game2BankSeconds,
              m.p2Game2PeakRam
            )}
          </div>
          <div className='battle-detail-line'>
            <span>
              <tt>{g2P2Label}</tt>
              {showPools ? <> {t2Code}</> : undefined}
            </span>
            {formatGamePlayerTelemetryNode(
              m.p1Game2MeanTurnMillis,
              m.p1Game2BankSeconds,
              m.p1Game2PeakRam
            )}
          </div>
        </div>
      </div>
      {archiveNote}
    </div>
  );
}

export function renderBattlesPage(opts: {
  db: db.Database;
  renderer: build.Renderer;
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

  const formatFilterItems = ladders.map(l => (
    <>
      {' — '}
      <li>
        <input type='radio' name='bformat' id={`bf-${l.slot}`} value={l.slot} />
        <label htmlFor={`bf-${l.slot}`}>{l.name}</label>
      </li>
    </>
  ));

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

  const historyRows = recentMatches.length === 0 ? (
    <tr className='empty-row'>
      <td colSpan={5} className='center muted'>No completed battles yet.</td>
    </tr>
  ) : (
    recentMatches.map(m => {
      const r = renderMatchOutcomeDisplay(m.category);
      const p1Href = agentLinks[m.p1.slug];
      const p2Href = agentLinks[m.p2.slug];

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

      const rel = formatRelativeTime(nowSec, m.completedAt);
      const detailHtml = renderBattleInlineDetailHtml(m, agentLinks);
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
            <td>{renderAgentLink(m.p1.name, p1Href, r.p1Win)} <code>{m.p1.version}</code></td>
            <td>{renderAgentLink(m.p2.name, p2Href, r.p2Win)} <code>{m.p2.version}</code></td>
            <td className='center' title={tip}>{r.node}</td>
            <td className='num muted' data-ts={m.completedAt}>{rel}</td>
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

  const battleWord = totalMatches === 1 ? 'battle' : 'battles';
  const pagerInitialInfo =
    `Page 1 of ${totalPages} (${totalMatches.toLocaleString('en-US')} ${battleWord})`;

  const liveMatchWithLines =
    liveDoc && !liveDoc.stale && liveDoc.live?.lines && liveDoc.live.lines.length > 0
      ? liveDoc.live
      : undefined;
  let initialViewerLeft: util.Child = <span className='muted'>—</span>;
  let initialViewerRight: util.Child = <span className='muted'>—</span>;
  if (liveMatchWithLines) {
    const l = liveMatchWithLines;
    const seat1 = l.game === 2 ? l.p2 : l.p1;
    const seat2 = l.game === 2 ? l.p1 : l.p2;
    const s1Href = agentLinks[seat1.slug];
    const s2Href = agentLinks[seat2.slug];
    initialViewerLeft = (
      <>
        <span className='yes'>{'\u25cf'} Live</span> · <code>{l.matchId}</code> ·{' '}
        <strong>Game {l.game} / 2</strong>
      </>
    );
    initialViewerRight = (
      <>
        <tt>p1</tt> {renderAgentLink(seat1.name, s1Href, true)} <code>{seat1.version}</code>
        {' vs '}
        <tt>p2</tt> {renderAgentLink(seat2.name, s2Href, true)} <code>{seat2.version}</code>
      </>
    );
  }

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
        <h3><a href='#live' className='subtle'>Live</a></h3>
        <div className='live-panel' id='live-panel'>
          {renderLivePanelInner(liveDoc, nowSec, publicDir, projectMeta, profileSlugs)}
        </div>
        <div
          className={`battle-viewer-wrap${liveMatchWithLines ? '' : ' hide'}`}
          id='battle-viewer-wrap'
        >
          <div className='series-bar' id='battle-viewer-bar'>
            <span id='battle-viewer-left'>{initialViewerLeft}</span>
            <span id='battle-viewer-right'>{initialViewerRight}</span>
          </div>
          <div className='viewer-wrap'>
            <iframe
              id='ps-viewer-frame'
              className='viewer-frame'
              src='/arena/viewer/'
              title='Pokémon Showdown battle viewer'
              sandbox='allow-scripts allow-same-origin'
            />
          </div>
        </div>
      </section>
      <section id='history'>
        <h3><a href='#history' className='subtle'>History</a></h3>
        <div className='table-wrap'>
          <table id='battles-table'>
            <thead>
              <tr>
                <th>Battle</th>
                <th>Player 1</th>
                <th>Player 2</th>
                <th className='center' title='2-game blind-pair outcome (Game 1 / Game 2)'>
                  Result
                </th>
                <th className='num'>Completed</th>
              </tr>
            </thead>
            <tbody id='battles-tbody'>
              {historyRows}
            </tbody>
          </table>
        </div>
        <div
          className={`pager${totalPages <= 1 ? ' hide' : ''}`}
          id='battles-pager'
          aria-label='Battle history pagination'
        >
          <button type='button' className='pager-btn' id='battles-prev' disabled>
            {'\u2190'} Newer
          </button>
          <span className='pager-info muted' id='battles-page-info'>{pagerInitialInfo}</span>
          <button
            type='button'
            className='pager-btn'
            id='battles-next'
            disabled={totalPages <= 1}
          >
            Older {'\u2192'}
          </button>
        </div>
      </section>
      <script>
        {util.raw(buildBattlesScript(
          safeInlineJson(initialState),
          safeInlineJson(agentLinks),
          safeInlineJson(FORMAT_TITLES)
        ))}
      </script>
    </>
  );

  return renderer.render({
    id: 'battles',
    title: 'Arena — Battles | pkmn.ai',
    header: build.injectLiveBanner(
      build.header(<a href='/arena/' className='subtle'>Battles</a>),
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
  util.installHeadSupport(app);
  const {db, arena: arenaHandle} = options;
  const publicDir = options.publicDir ?? PUBLIC_DIR;
  const staticDir = options.staticDir ?? STATIC_DIR;
  const avatarsDir = options.avatarsDir ?? AVATARS_DIR;
  const recentMatchesLimit = options.recentMatchesLimit ?? util.TABLE_PAGE_SIZE;
  const getNowSec = options.now ?? (() => Math.floor(Date.now() / 1000));

  const renderer = options.renderer ?? (
    publicDir === PUBLIC_DIR
      ? build.renderer
      : new build.Renderer({
        public: publicDir,
        analytics: 'G-LQ8TW28Z7Q',
        description: 'The home of competitive Pokémon artificial intelligence',
        url: 'https://pkmn.ai',
        stylesheet: path.join(staticDir, 'style', 'index.css'),
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
    const avatarsMtime = getFileMtimeToken(avatarsDir);
    return `${db.getChangeToken()}:${state.archiveSeq}:${projMtime}:${djMtime}:` +
      `${avatarsMtime}:${getArchiveDiskToken()}`;
  };

  let cachedContext: {
    token: string;
    projectMeta: Map<string, ProjectMeta>;
    profileAgents: db.AgentRow[];
    profileBySlug: Map<string, db.AgentRow>;
    profileSlugs: Set<string>;
    logoByFileName: Map<string, NonNullable<ReturnType<typeof resolveAgentLogo>>>;
    liveTournament?: db.TournamentRow;
  } | undefined;

  const getContext = (dbToken: string) => {
    if (cachedContext?.token === dbToken) return cachedContext;
    const projectMeta = loadProjectMetaMap(staticDir);
    const profileAgents = db.getAllActiveAgents();
    const profileBySlug = new Map(profileAgents.map(a => [a.slug, a]));
    const profileSlugs = new Set(profileAgents.map(a => a.slug));
    const logoByFileName = new Map<string, NonNullable<ReturnType<typeof resolveAgentLogo>>>();
    for (const a of profileAgents) {
      const logo = resolveAgentLogo(a, avatarsDir);
      if (logo) logoByFileName.set(logo.fileName, logo);
    }
    const liveTournament = db.getRunningTournament();
    cachedContext = {
      token: dbToken,
      projectMeta,
      profileAgents,
      profileBySlug,
      profileSlugs,
      logoByFileName,
      liveTournament,
    };
    return cachedContext;
  };

  let cachedArenaBundle: {
    token: string;
    bundle: ReturnType<typeof renderArenaAndLadderArtifacts>;
  } | undefined;

  const getArenaBundle = (dbToken: string, nowSec: number) => {
    const liveDoc = arenaHandle.getLiveDocument(nowSec);
    const activeLive = !liveDoc.stale ? liveDoc.live : undefined;
    const liveKey = activeLive ? `${activeLive.ladderId}:${activeLive.slot ?? ''}` : '';
    const bundleToken = `${dbToken}:${util.formatUtcDate(nowSec)}:${liveKey}`;
    if (cachedArenaBundle?.token === bundleToken) return cachedArenaBundle.bundle;
    const ctx = getContext(dbToken);
    const bundle = renderArenaAndLadderArtifacts({
      db,
      renderer,
      publicDir,
      staticDir,
      projectMeta: ctx.projectMeta,
      profileSlugs: ctx.profileSlugs,
      liveMatch: activeLive,
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
    if (entry.contentType === 'image/svg+xml') {
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; sandbox"
      );
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }
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
    res.end(build.renderErrorPage(404, db.getRunningTournament(), renderer));
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
    const liveDoc = arenaHandle.getLiveDocument(nowSec);
    const activeLive = !liveDoc.stale ? liveDoc.live : undefined;
    const liveKey = activeLive ? `${activeLive.ladderId}:${activeLive.slot ?? ''}` : '';
    const token = `${dbToken}:${util.formatUtcDate(nowSec)}:${liveKey}`;
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
    const bundle = getArenaBundle(dbToken, nowSec);
    const isArchivedOnly = !(key in bundle.ladderJsonBySlot) &&
      key in bundle.archivedLadderJsonById &&
      bundle.archivedLadderJsonById[key].status === 'archived';
    const token = isArchivedOnly ? dbToken : `${dbToken}:${util.formatUtcDate(nowSec)}`;
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

  const serveBattleLogFile = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    subdir: 'ladders' | 'tournaments',
    rawId: string,
    rawFile: string
  ) => {
    if (!/^[A-Za-z0-9._-]+$/.test(rawId) || !/^[A-Za-z0-9._-]+\.log$/.test(rawFile)) {
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
          nowSec: getNowSec(),
        }).html;
      }
    );
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
        header: build.injectLiveBanner(projectsPage.header, ctx.liveTournament),
      });
    });
  });

  const cachedProfiles = new Map<string, {
    token: string;
    rendered: ReturnType<typeof renderAgentProfile>;
  }>();

  const getAgentProfile = (
    agent: db.AgentRow,
    ctx: ReturnType<typeof getContext>,
    token: string,
    nowSec: number
  ) => {
    const existing = cachedProfiles.get(agent.slug);
    if (existing?.token === token) return existing.rendered;
    const rendered = renderAgentProfile({
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
    if (cachedProfiles.size >= 64) {
      const oldest = cachedProfiles.keys().next().value;
      if (oldest !== undefined) cachedProfiles.delete(oldest);
    }
    cachedProfiles.set(agent.slug, {token, rendered});
    return rendered;
  };

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
        () => `${JSON.stringify(getAgentProfile(agent, ctx, token, nowSec).json, undefined, 2)}\n`
      );
      return;
    }

    // Serve agent logo assets (`/projects/<slug>.<ext>`) directly from `avatarsDir`.
    const logo = ctx.logoByFileName.get(rawParam);
    if (logo) {
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
        () => getAgentProfile(agent, ctx, token, nowSec).html
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
