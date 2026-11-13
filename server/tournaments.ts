import * as fs from 'fs';
import * as path from 'path';

import * as site from 'site';

import type * as db from '../db';
import {Renderer, header, injectLiveBanner} from '../static/build';
import {
  escapeHtml,
  formatUtcDate,
  formatUtcDateTime,
  renderTemplate,
  root,
} from '../static/util';

import * as arena from './arena';
import {
  BroadcastClock,
  BroadcastPlayer,
  BroadcastTable,
  LiveBroadcast,
  resolveTournamentArchive,
} from './arena';
import * as render from './render';

export {resolveTournamentArchive};
export type {
  BroadcastClock,
  BroadcastPlayer,
  BroadcastTable,
  LiveBroadcast,
};

const TOURNAMENTS_STYLE = fs.readFileSync(root('static', 'tournaments.css'), 'utf8');
const TOURNAMENTS_TEMPLATE = fs.readFileSync(root('static', 'tournaments.html'), 'utf8');
const VIEWER_STYLE = fs.readFileSync(root('static', 'viewer.css'), 'utf8');
const VIEWER_TEMPLATE = fs.readFileSync(root('static', 'viewer.html'), 'utf8');

export function speciesToMinispriteSlug(species: string): string {
  return species
    .trim()
    .toLowerCase()
    .replace(/♀/g, '-f')
    .replace(/♂/g, '-m')
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function parsePackedTeamSpecies(packed?: string): string[] {
  if (!packed?.trim()) return [];
  const out: string[] = [];
  for (const chunk of packed.split(']')) {
    if (!chunk.trim()) continue;
    const fields = chunk.split('|');
    const species = fields[1]?.trim() || fields[0]?.trim() || '';
    if (species) out.push(species);
  }
  return out;
}

function formatClockMmSs(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function parseLatestTurnFromLines(lines?: string[]): number | undefined {
  if (!lines || lines.length === 0) return undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.startsWith('|turn|')) {
      const n = Number(line.slice(6).trim());
      if (Number.isInteger(n) && n >= 0) return n;
    }
  }
  return undefined;
}

function renderPartyMinisprites(packed?: string): string {
  const speciesList = parsePackedTeamSpecies(packed);
  if (speciesList.length === 0) return '';
  const spans = speciesList.slice(0, 6).map(sp => {
    const slug = speciesToMinispriteSlug(sp);
    if (!slug) return '';
    const src = `https://www.smogon.com/forums/media/minisprites/${slug}.png`;
    const spEsc = escapeHtml(sp);
    return `<span><img src="${escapeHtml(src)}" alt="${spEsc}" title="${spEsc}"></span>`;
  }).join('');
  return `<span class="party-minisprites">${spans}</span>`;
}

function renderClockSide(slot: 'p1' | 'p2', clock: BroadcastClock): string {
  const pillCls = clock.thinking ? 'clock-pill thinking' : 'clock-pill';
  const timeCls = clock.thinking ? 'clock-time yes' : 'clock-time';
  const subText = clock.thinking ? 'thinking…' : `+${clock.incrementSeconds}s/turn`;
  const rem = Math.round(clock.bankSeconds);
  const tip = clock.thinking
    ? `${rem}s remaining in 150s bank (currently thinking)`
    : `${rem}s remaining in 150s bank (+${clock.incrementSeconds}s/turn)`;
  return `<div class="clock-side" id="clock-side-${slot}">` +
    `<span><tt>${slot}</tt> <strong id="clock-name-${slot}">` +
      `${escapeHtml(clock.name)}</strong></span>` +
    `<span class="${pillCls}" id="clock-pill-${slot}" title="${escapeHtml(tip)}">` +
      `<span class="${timeCls}" id="clock-${slot}">${formatClockMmSs(clock.bankSeconds)}</span>` +
      `<span class="clock-sub" id="clock-sub-${slot}">${escapeHtml(subText)}</span>` +
    '</span></div>';
}

function extractLiveTables(
  tournamentId: string,
  broadcast?: LiveBroadcast
): BroadcastTable[] {
  if (broadcast?.tournamentId !== tournamentId) return [];
  const norm = arena.normalizeLiveBroadcast(broadcast);
  return norm.tables.filter(tb => !tb.idle && tb.live !== false && Boolean(tb.p1 && tb.p2));
}

function renderBroadcastSectionHtml(
  tournament: db.TournamentRow,
  broadcast?: LiveBroadcast
): {
  html: string;
  isActive: boolean;
  normalized?: LiveBroadcast;
  selectedTable?: number;
  viewerInit?: {
    lines: string[];
    live: boolean;
    side: 'p1';
    thinkingSlot?: 'p1' | 'p2';
    thinkingBankSeconds?: number;
  };
} {
  const isActive = broadcast?.tournamentId === tournament.id;
  const norm = isActive && broadcast ? arena.normalizeLiveBroadcast(broadcast) : undefined;
  const selected = norm?.tables.find(tb => !tb.idle && tb.p1 && tb.p2) ??
    norm?.tables.find(tb => tb.p1 && tb.p2) ??
    norm?.tables[0];

  const tableNavHtml = norm && norm.tables.length > 0
    ? `<nav class="subnav" aria-label="Broadcast table">
      <ul>
        ${norm.tables.map((tb, idx) => {
          const sep = idx > 0 ? '\n        —\n        ' : '';
          const checked = tb.table === (selected?.table ?? 1) ? ' checked' : '';
          const tbId = `tb-${escapeHtml(tournament.id)}-${tb.table}`;
          const labelHtml = tb.idle
            ? `${escapeHtml(tb.label)} <span class="muted">(idle)</span>`
            : escapeHtml(tb.label);
          return `${sep}<li><input type="radio" name="table-${escapeHtml(tournament.id)}" ` +
            `id="${tbId}" value="${tb.table}" data-table-num="${tb.table}"${checked}>` +
            `<label for="${tbId}">${labelHtml}</label></li>`;
        }).join('')}
      </ul>
    </nav>`
    : '';

  const p1Clock = selected?.p1 ?? norm?.p1;
  const p2Clock = selected?.p2 ?? norm?.p2;
  const seriesLeft = selected?.seriesLeftHtml ?? norm?.seriesLeftHtml ?? '<strong>Replay</strong>';
  const seriesRight = selected?.seriesRightHtml ??
    norm?.seriesRightHtml ??
    '<span class="muted">—</span>';
  const clockBarHtml = norm && p1Clock && p2Clock
    ? `<div class="clock-bar" id="clock-bar">
        ${renderClockSide('p1', p1Clock)}
        ${renderClockSide('p2', p2Clock)}
      </div>`
    : '<div class="clock-bar hide" id="clock-bar"></div>';

  // Sandboxed Showdown replay iframe (`sandbox="allow-scripts"` without `allow-same-origin`)
  // isolates third-party battle client DOM/scripts from `pkmn.ai` session cookies.
  const html = `<div id="table-nav-wrap">${tableNavHtml}</div>
    <div class="broadcast">
      <div class="series-bar">
        <span id="series-left">${seriesLeft}</span>
        <span id="series-right">${seriesRight}</span>
      </div>
      ${clockBarHtml}
      <div class="viewer-wrap">
        <iframe
          id="ps-viewer-frame"
          class="viewer-frame"
          src="/arena/viewer/"
          title="Pokémon Showdown battle viewer"
          sandbox="allow-scripts"
        ></iframe>
      </div>
    </div>`;

  if (!norm || !p1Clock || !p2Clock) {
    return {html, isActive: false};
  }

  const lines = selected?.lines ?? norm.lines;
  const isLive = selected ? selected.live !== false : norm.live !== false;
  const thinkingSlot = p1Clock.thinking ? 'p1' : p2Clock.thinking ? 'p2' : undefined;
  const thinkingBankSeconds = thinkingSlot
    ? (thinkingSlot === 'p1' ? p1Clock.bankSeconds : p2Clock.bankSeconds)
    : undefined;

  return {
    html,
    isActive: true,
    normalized: norm,
    selectedTable: selected?.table ?? 1,
    viewerInit: {
      lines,
      live: isLive,
      side: 'p1',
      thinkingSlot,
      thinkingBankSeconds,
    },
  };
}

function findLiveTableForEntrant(
  liveTables: BroadcastTable[],
  slug: string,
  name: string
): BroadcastTable | undefined {
  return liveTables.find(tb => (
    tb.p1?.slug === slug ||
    tb.p2?.slug === slug ||
    tb.p1?.name === name ||
    tb.p2?.name === name
  ));
}

function findLiveTableForPair(
  liveTables: BroadcastTable[],
  a: {slug: string; name: string},
  b: {slug: string; name: string}
): BroadcastTable | undefined {
  return liveTables.find(tb => {
    if (!tb.p1 || !tb.p2) return false;
    const p1MatchesA = tb.p1.slug === a.slug || tb.p1.name === a.name;
    const p2MatchesB = tb.p2.slug === b.slug || tb.p2.name === b.name;
    if (p1MatchesA && p2MatchesB) return true;
    const p1MatchesB = tb.p1.slug === b.slug || tb.p1.name === b.name;
    const p2MatchesA = tb.p2.slug === a.slug || tb.p2.name === a.name;
    return p1MatchesB && p2MatchesA;
  });
}

function renderTournamentStandingsHtml(opts: {
  tournament: db.TournamentRow;
  entrants: db.TournamentEntrantView[];
  hasSuperfinal: boolean;
  liveTables: BroadcastTable[];
  publicDir: string;
  projectMeta: ReadonlyMap<string, render.ProjectMeta>;
  profileSlugs: ReadonlySet<string>;
}): string {
  const {
    tournament,
    entrants,
    hasSuperfinal,
    liveTables,
    publicDir,
    projectMeta,
    profileSlugs,
  } = opts;
  if (entrants.length === 0) {
    return '<div id="standings-body">' +
      '<p class="empty-state muted">No entrants registered yet.</p></div>';
  }

  const maxRrGames = Math.max(1, (entrants.length - 1) * tournament.gamesPerMatchup);
  const rowsHtml = entrants.map((e, idx) => {
    const rankNum = e.finalRank ?? idx + 1;
    const sfBadge = hasSuperfinal && rankNum <= 2 ? ' <span class="muted">SF</span>' : '';
    const href = render.resolveAgentHref(
      publicDir,
      projectMeta,
      e.agentSlug,
      e.agentName,
      profileSlugs
    );
    const liveTb = findLiveTableForEntrant(liveTables, e.agentSlug, e.agentName);
    const liveBadge = liveTb
      ? ` <a href="#live" class="live-pill" data-live-table="${liveTb.table}" ` +
        `title="Spectate live on ${escapeHtml(liveTb.label)}">&#9679; T${liveTb.table}</a>`
      : '';
    const agentHtml = `${render.formatAgentLink(e.agentName, href, true)} ` +
      `<code>${escapeHtml(e.version)}</code>${liveBadge}`;
    const elo = Math.round(e.elo);
    const ci = Math.round(1.96 * e.se);
    const ptsStr = e.points.toFixed(1);
    const sbStr = Math.round(e.sonnebornBerger).toLocaleString('en-US');

    return '<tr>' +
      `<td><strong>${rankNum}</strong>${sfBadge}</td>` +
      `<td>${agentHtml}</td>` +
      `<td class="num"><strong>${elo}</strong> <span class="muted">±${ci}</span></td>` +
      `<td class="num">${e.gameWins}–${e.gameLosses}–${e.gameTies}</td>` +
      `<td class="num"><strong>${ptsStr}</strong> <span class="muted">/ ${maxRrGames}</span></td>` +
      `<td class="num">${sbStr}</td>` +
      '</tr>';
  }).join('');

  const ptsTitle =
    `Round-Robin points out of ${maxRrGames} games (+1.0 per win, +0.5 per tie)`;
  return `<div id="standings-body"><div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Agent</th>
          <th class="num" title="Tournament MAP Elo ± 95% CI">Elo</th>
          <th class="num" title="Standalone individual BYOT game Wins – Losses – Ties">W–L–T</th>
          <th class="num" title="${escapeHtml(ptsTitle)}">Points</th>
          <th class="num" title="Sonneborn-Berger tiebreak score">S–B</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  </div></div>`;
}

function renderTournamentCrosstableHtml(opts: {
  entrants: db.TournamentEntrantView[];
  pairs: db.TournamentPairRecord[];
  liveTables: BroadcastTable[];
  publicDir: string;
  projectMeta: ReadonlyMap<string, render.ProjectMeta>;
  profileSlugs: ReadonlySet<string>;
}): {html: string; isEmpty: boolean} {
  const {entrants, pairs, liveTables, publicDir, projectMeta, profileSlugs} = opts;
  const rrLiveTables = liveTables.filter(tb => tb.stage !== 'Superfinal');
  if (entrants.length < 2 || (pairs.length === 0 && rrLiveTables.length === 0)) {
    return {
      html: '<div id="crosstable-body">' +
        '<p class="empty-state muted">No round-robin games completed yet.</p></div>',
      isEmpty: true,
    };
  }

  const pairMap = new Map<string, db.TournamentPairRecord>();
  for (const p of pairs) {
    pairMap.set(`${p.lowVersionId}:${p.highVersionId}`, p);
  }

  const colHeaders = entrants.map(e => `<th>${escapeHtml(e.agentName)}</th>`).join('');
  const bodyRows = entrants.map(rowEnt => {
    const rowHref = render.resolveAgentHref(
      publicDir,
      projectMeta,
      rowEnt.agentSlug,
      rowEnt.agentName,
      profileSlugs
    );
    const rowLabel = `${render.formatAgentLink(rowEnt.agentName, rowHref, true)} ` +
      `<code>${escapeHtml(rowEnt.version)}</code>`;

    const cells = entrants.map(colEnt => {
      if (rowEnt.versionId === colEnt.versionId) {
        return '<td class="diag">—</td>';
      }
      const liveTb = findLiveTableForPair(
        rrLiveTables,
        {slug: rowEnt.agentSlug, name: rowEnt.agentName},
        {slug: colEnt.agentSlug, name: colEnt.agentName}
      );
      const livePill = liveTb
        ? `<a href="#live" class="live-pill" data-live-table="${liveTb.table}" ` +
          `title="Spectate live on ${escapeHtml(liveTb.label)}">&#9679; T${liveTb.table}</a>`
        : '';

      const lowId = Math.min(rowEnt.versionId, colEnt.versionId);
      const highId = Math.max(rowEnt.versionId, colEnt.versionId);
      const pair = pairMap.get(`${lowId}:${highId}`);
      const isLow = rowEnt.versionId === lowId;
      const wins = pair ? (isLow ? pair.lowWins : pair.highWins) : 0;
      const losses = pair ? (isLow ? pair.highWins : pair.lowWins) : 0;
      const ties = pair ? pair.ties : 0;
      const total = wins + losses + ties;

      if (total === 0) {
        if (livePill) {
          return `<td class="center">${livePill}</td>`;
        }
        return '<td class="muted">—</td>';
      }

      const pts = wins + 0.5 * ties;
      const scorePct = (pts / total) * 100;
      const scoreStr = `${scorePct.toFixed(1)}%`;
      const scoreHtml = scorePct > 50 ? `<strong>${scoreStr}</strong>` : scoreStr;
      const cls = render.heatmapClass(scorePct);
      const clsAttr = cls ? ` class="${cls}"` : '';
      const tip = `${pts.toFixed(1)} / ${total} pts`;
      const subInner = livePill
        ? `${wins}–${losses}–${ties} · ${livePill}`
        : `${wins}–${losses}–${ties}`;

      return `<td${clsAttr} title="${escapeHtml(tip)}">${scoreHtml}` +
        `<span class="sub">${subInner}</span></td>`;
    }).join('');

    return `<tr><td>${rowLabel}</td>${cells}</tr>`;
  }).join('');

  return {
    html: `<div id="crosstable-body"><div class="table-wrap">
    <table class="matrix">
      <thead>
        <tr>
          <th>&nbsp;</th>
          ${colHeaders}
        </tr>
      </thead>
      <tbody>${bodyRows}</tbody>
    </table>
  </div></div>`,
    isEmpty: false,
  };
}

function renderTournamentGamesHtml(opts: {
  tournament: db.TournamentRow;
  games: db.TournamentGameView[];
  liveTables: BroadcastTable[];
  totalCompletedCount: number;
  publicDir: string;
  projectMeta: ReadonlyMap<string, render.ProjectMeta>;
  profileSlugs: ReadonlySet<string>;
  logFiles?: ReadonlySet<string>;
}): string {
  const {
    tournament,
    games,
    liveTables,
    totalCompletedCount,
    publicDir,
    projectMeta,
    profileSlugs,
    logFiles,
  } = opts;
  const resolvedLogs = logFiles ?? arena.listTournamentLogFiles(publicDir, tournament.id);

  const liveRowsHtml = liveTables.map(tb => {
    const p1 = tb.p1!;
    const p2 = tb.p2!;
    const codePrefix = tb.stage === 'Superfinal' ? 'SF' : 'RR';
    const codeNum = tb.stage === 'Superfinal' ? (tb.matchupGame ?? 1) : (tb.cycle ?? 1);
    const gameCode = `${codePrefix}${codeNum}`;
    const p1Href = p1.slug
      ? render.resolveAgentHref(publicDir, projectMeta, p1.slug, p1.name, profileSlugs)
      : undefined;
    const p2Href = p2.slug
      ? render.resolveAgentHref(publicDir, projectMeta, p2.slug, p2.name, profileSlugs)
      : undefined;
    const p1Cell = `<div class="player-cell">${render.formatAgentLink(p1.name, p1Href, false)}` +
      `${renderPartyMinisprites(p1.team)}</div>`;
    const p2Cell = `<div class="player-cell">${render.formatAgentLink(p2.name, p2Href, false)}` +
      `${renderPartyMinisprites(p2.team)}</div>`;
    const turn = parseLatestTurnFromLines(tb.lines);
    const turnsStr = turn !== undefined ? String(turn) : '—';
    const b1 = Math.round(p1.bankSeconds);
    const b2 = Math.round(p2.bankSeconds);
    const tip = `Spectate live on ${tb.label}`;

    return `<tr class="live-game-row" data-live-game-table="${tb.table}">` +
      `<td><a href="#live" class="subtle" data-live-table="${tb.table}" ` +
        `title="${escapeHtml(tip)}"><code>${escapeHtml(gameCode)}</code></a></td>` +
      `<td>${p1Cell}</td>` +
      `<td>${p2Cell}</td>` +
      `<td class="center"><a href="#live" class="live-pill" data-live-table="${tb.table}" ` +
        `title="${escapeHtml(tip)}">&#9679; T${tb.table}</a></td>` +
      `<td class="num">${turnsStr}</td>` +
      `<td class="num">${b1}s / ${b2}s</td>` +
      '</tr>';
  }).join('');

  const completedRowsHtml = games.map(g => {
    const codePrefix = g.stage === 'Superfinal' ? 'SF' : 'RR';
    const codeNum = g.stage === 'Superfinal' ? g.matchupGame : g.cycle;
    const gameCode = `${codePrefix}${codeNum}`;
    const logRel = `${g.id}.log`;
    const hasLog = resolvedLogs.has(logRel);
    const logUrl = `/arena/tournaments/${encodeURIComponent(tournament.id)}/` +
      encodeURIComponent(logRel);
    const gameHref = hasLog ? logUrl : '#games';
    const replayAttr = hasLog ? ` data-replay-log="${escapeHtml(logUrl)}"` : '';

    const p1Won = g.outcome === 'W';
    const p2Won = g.outcome === 'L';
    const resHtml = p1Won
      ? '<strong>1</strong>–0'
      : p2Won
        ? '0–<strong>1</strong>'
        : '½–½';

    const p1Href = render.resolveAgentHref(
      publicDir,
      projectMeta,
      g.p1Slug,
      g.p1Name,
      profileSlugs
    );
    const p2Href = render.resolveAgentHref(
      publicDir,
      projectMeta,
      g.p2Slug,
      g.p2Name,
      profileSlugs
    );
    const p1Party = renderPartyMinisprites(g.p1Team);
    const p2Party = renderPartyMinisprites(g.p2Team);

    const p1Cell = `<div class="player-cell">${render.formatAgentLink(g.p1Name, p1Href, p1Won)}` +
      `${p1Party}</div>`;
    const p2Cell = `<div class="player-cell">${render.formatAgentLink(g.p2Name, p2Href, p2Won)}` +
      `${p2Party}</div>`;

    const turnsStr = g.turns !== undefined ? String(g.turns) : '—';
    const b1 = Math.round(g.p1BankSeconds ?? 0);
    const b2 = Math.round(g.p2BankSeconds ?? 0);

    return `<tr data-game-id="${escapeHtml(g.id)}">` +
      `<td><a href="${escapeHtml(gameHref)}" class="subtle"${replayAttr} ` +
        `title="${escapeHtml(g.id)}"><code>${escapeHtml(gameCode)}</code></a></td>` +
      `<td>${p1Cell}</td>` +
      `<td>${p2Cell}</td>` +
      `<td class="center">${resHtml}</td>` +
      `<td class="num">${turnsStr}</td>` +
      `<td class="num">${b1}s / ${b2}s</td>` +
      '</tr>';
  }).join('');

  const rowsHtml = !liveRowsHtml && !completedRowsHtml
    ? '<tr class="empty-row"><td colspan="6" class="center muted">' +
      'No completed games yet.</td></tr>'
    : `${liveRowsHtml}${completedRowsHtml}`;

  const archive = resolveTournamentArchive(publicDir, tournament.id);
  const jsonHref = `/arena/tournaments/${encodeURIComponent(tournament.id)}/index.json`;
  const bankTip = 'Remaining time bank for Player 1 / Player 2 (150s cap, +10s/turn)';
  const countStr = totalCompletedCount.toLocaleString('en-US');
  const archiveLine = archive
    ? `Archive: <a href="${escapeHtml(archive.href)}"><code>${escapeHtml(archive.name)}</code>` +
      `</a> (<span id="games-count">${countStr}</span> games) · ` +
      `<a href="${escapeHtml(jsonHref)}"><code>index.json</code></a>`
    : `Data: <a href="${escapeHtml(jsonHref)}"><code>index.json</code></a> ` +
      `(<span id="games-count">${countStr}</span> games` +
      (tournament.status !== 'completed' ? '; replay archive published upon completion' : '') +
      ')';

  return `<div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Game</th>
            <th>Player 1</th>
            <th>Player 2</th>
            <th class="center">Result</th>
            <th class="num">Turns</th>
            <th class="num" title="${bankTip}">Bank</th>
          </tr>
        </thead>
        <tbody id="games-tbody">${rowsHtml}</tbody>
      </table>
    </div>
    <p class="meta meta-archive" id="games-archive-meta">${archiveLine}</p>`;
}

export function renderBattleViewerPage(publicDir: string) {
  const viewerHtml = renderTemplate(VIEWER_TEMPLATE, {
    viewerStyle: VIEWER_STYLE,
  });
  render.writeFileAtomic(path.join(publicDir, 'arena', 'viewer', 'index.html'), viewerHtml);
}

export function renderArenaTournamentsSummaryHtml(opts: {
  db: db.Database;
  publicDir: string;
  projectMeta: ReadonlyMap<string, render.ProjectMeta>;
  profileSlugs: ReadonlySet<string>;
  tournaments?: db.TournamentRow[];
  entrantsByTournament?: ReadonlyMap<string, db.TournamentEntrantView[]>;
}): string {
  const {db, publicDir, projectMeta, profileSlugs, entrantsByTournament} = opts;
  const tournaments = opts.tournaments ?? db.getTournaments();
  if (tournaments.length === 0) {
    return '<p class="empty-state muted">No championship tournaments scheduled yet.</p>';
  }

  const ongoing = tournaments.filter(t => t.status === 'running' || t.status === 'scheduled');
  const completed = tournaments
    .filter(t => t.status === 'completed')
    .sort((a, b) => (b.completedAt ?? b.startsAt) - (a.completedAt ?? a.startsAt));

  const parts: string[] = [];

  if (ongoing.length > 0) {
    const items = ongoing.map(t => {
      const tourHref = `/arena/tournaments/${encodeURIComponent(t.id)}/`;
      const fmtTitle = render.FORMAT_TITLES[t.format] ?? t.format;
      const entrants = entrantsByTournament?.get(t.id) ?? db.getTournamentEntrants(t.id);
      const badge = t.status === 'running'
        ? '<span class="yes">&#9679; Live</span>'
        : '<span class="muted">Scheduled</span>';
      let leaderSuffix = '';
      if (t.status === 'running' && entrants.length > 0) {
        const leader = entrants[0];
        const lHref = render.resolveAgentHref(
          publicDir,
          projectMeta,
          leader.agentSlug,
          leader.agentName,
          profileSlugs
        );
        leaderSuffix = ` · Leader: ${render.formatAgentLink(leader.agentName, lHref, true)} ` +
          `<code>${escapeHtml(leader.version)}</code>`;
      }
      let timingSuffix = '';
      if (t.status === 'scheduled') {
        const closesAt = db.getTournamentClosesAt(t.startsAt);
        timingSuffix =
          ` · starts ${escapeHtml(formatUtcDateTime(t.startsAt))}` +
          ` (entries close ${escapeHtml(formatUtcDateTime(closesAt))})`;
      }
      return `<li>${badge} <a href="${escapeHtml(tourHref)}" class="subtle">` +
        `<strong>${escapeHtml(t.name)}</strong></a> · <tt>${escapeHtml(fmtTitle)}</tt> ` +
        `(${entrants.length} entrants)${leaderSuffix}${timingSuffix}</li>`;
    }).join('\n    ');
    parts.push(`<ul class="tour-ongoing">\n    ${items}\n  </ul>`);
  }

  if (completed.length > 0) {
    const rows = completed.map(t => {
      const tourHref = `/arena/tournaments/${encodeURIComponent(t.id)}/`;
      const fmtTitle = render.FORMAT_TITLES[t.format] ?? t.format;
      const entrants = entrantsByTournament?.get(t.id) ?? db.getTournamentEntrants(t.id);
      const winner = entrants.find(e => e.finalRank === 1) ?? entrants[0];
      const maxRrGames = entrants.length >= 2
        ? (entrants.length - 1) * t.gamesPerMatchup
        : t.gamesPerMatchup;

      if (!winner) {
        return '<tr>' +
          `<td><a href="${escapeHtml(tourHref)}" class="subtle">` +
            `<strong>${escapeHtml(t.name)}</strong></a></td>` +
          `<td><tt>${escapeHtml(fmtTitle)}</tt></td>` +
          '<td class="muted">—</td>' +
          '<td class="num muted">—</td>' +
          '<td class="num muted">—</td>' +
          '<td class="num muted">—</td>' +
          '</tr>';
      }

      const wHref = render.resolveAgentHref(
        publicDir,
        projectMeta,
        winner.agentSlug,
        winner.agentName,
        profileSlugs
      );
      const winnerCell = `${render.formatAgentLink(winner.agentName, wHref, true)} ` +
        `<code>${escapeHtml(winner.version)}</code>`;
      const elo = Math.round(winner.elo);
      const ci = Math.round(1.96 * winner.se);
      const ptsStr = winner.points.toFixed(1);

      return '<tr>' +
        `<td><a href="${escapeHtml(tourHref)}" class="subtle">` +
          `<strong>${escapeHtml(t.name)}</strong></a></td>` +
        `<td><tt>${escapeHtml(fmtTitle)}</tt></td>` +
        `<td>${winnerCell}</td>` +
        `<td class="num"><strong>${elo}</strong> <span class="muted">±${ci}</span></td>` +
        `<td class="num">${winner.gameWins}–${winner.gameLosses}–${winner.gameTies}</td>` +
        `<td class="num"><strong>${ptsStr}</strong> ` +
          `<span class="muted">/ ${maxRrGames}</span></td>` +
        '</tr>';
    }).join('');

    parts.push(`<div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Tournament</th>
          <th>Format</th>
          <th>Winner</th>
          <th class="num" title="Tournament MAP Elo ± 95% CI">Elo</th>
          <th class="num" title="Individual game Wins – Losses – Ties">W–L–T</th>
          <th class="num" title="Round-Robin points">Points</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`);
  } else if (ongoing.length > 0) {
    parts.push('<p class="muted">No completed past tournaments yet.</p>');
  }

  return parts.join('\n  ');
}

function renderTournamentRulesHtml(staticDir: string, tournamentId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(tournamentId)) return '';
  const rulesPath = path.join(staticDir, 'tours', `${tournamentId}.dj`);
  if (!fs.existsSync(rulesPath)) return '';
  const body = site.html.render(fs.readFileSync(rulesPath, 'utf8')).trim();
  if (!body) return '';
  return `<section class="tour-rules">\n${body}\n</section>`;
}

export function renderTournamentPage(opts: {
  db: db.Database;
  renderer: Renderer;
  tournament: db.TournamentRow;
  publicDir: string;
  staticDir?: string;
  projectMeta: ReadonlyMap<string, render.ProjectMeta>;
  profileSlugs: ReadonlySet<string>;
  tournamentBroadcast?: LiveBroadcast;
  liveTournament?: {id: string; name: string};
}): {html: string; json: arena.TournamentDocument} {
  const {
    db,
    renderer,
    tournament: t,
    publicDir,
    staticDir = root('static'),
    projectMeta,
    profileSlugs,
    tournamentBroadcast,
    liveTournament,
  } = opts;

  const allTournaments = db.getTournaments();
  const eventOptions = allTournaments.map(other => {
    const sel = other.id === t.id ? ' selected' : '';
    const href = `/arena/tournaments/${encodeURIComponent(other.id)}/`;
    return `<option value="${escapeHtml(href)}"${sel}>${escapeHtml(other.name)}</option>`;
  }).join('');

  const entrants = db.getTournamentEntrants(t.id);
  const games = db.getTournamentGames(t.id, 50);
  const rrPairs = db.getTournamentCrosstable(t.id, 'Round Robin');
  const sfPairs = db.getTournamentCrosstable(t.id, 'Superfinal');
  const broadcastRes = renderBroadcastSectionHtml(t, tournamentBroadcast);
  const liveTables = extractLiveTables(t.id, tournamentBroadcast);
  const hasSf = sfPairs.length > 0 ||
    games.some(g => g.stage === 'Superfinal') ||
    liveTables.some(tb => tb.stage === 'Superfinal') ||
    Boolean(broadcastRes.normalized?.seriesLeftHtml.includes('Superfinal'));

  const n = entrants.length;
  const rrTotal = n >= 2 ? ((n * (n - 1)) / 2) * t.gamesPerMatchup : 0;
  const fmtTitle = render.FORMAT_TITLES[t.format] ?? t.format;
  const isDoubles = t.format.includes('vgc') || t.format.includes('doubles');
  const inc = isDoubles ? 25 : 10;
  const sfSuffix = hasSf ? ' + 100-game Superfinal' : '';

  const closesAt = db.getTournamentClosesAt(t.startsAt);
  const scheduleLine = t.status === 'scheduled'
    ? `Starts ${escapeHtml(formatUtcDateTime(t.startsAt))} · ` +
      `Entries close ${escapeHtml(formatUtcDateTime(closesAt))}<br>`
    : t.completedAt
      ? `Started ${escapeHtml(formatUtcDate(t.startsAt))} · ` +
        `Completed ${escapeHtml(formatUtcDate(t.completedAt))}<br>`
      : `Started ${escapeHtml(formatUtcDateTime(t.startsAt))}<br>`;

  const metaHtml =
    `<p class="meta"><tt>${escapeHtml(fmtTitle)}</tt> · ${n} Entrants · ` +
    `<tt>G=${t.gamesPerMatchup}</tt> Double Round-Robin ` +
    `(${rrTotal.toLocaleString('en-US')} games)${sfSuffix}<br>` +
    `${scheduleLine}` +
    `${escapeHtml(t.hardware)} · <tt>150s</tt> bank (<tt>+${inc}s/turn</tt>)</p>`;

  const standingsHtml = renderTournamentStandingsHtml({
    tournament: t,
    entrants,
    hasSuperfinal: hasSf,
    liveTables,
    publicDir,
    projectMeta,
    profileSlugs,
  });
  const crossRes = renderTournamentCrosstableHtml({
    entrants,
    pairs: rrPairs,
    liveTables,
    publicDir,
    projectMeta,
    profileSlugs,
  });

  let completedCount = 0;
  for (const p of rrPairs) completedCount += p.lowWins + p.highWins + p.ties;
  for (const p of sfPairs) completedCount += p.lowWins + p.highWins + p.ties;

  const logFiles = arena.listTournamentLogFiles(publicDir, t.id);

  const gamesHtml = renderTournamentGamesHtml({
    tournament: t,
    games,
    liveTables,
    totalCompletedCount: completedCount,
    publicDir,
    projectMeta,
    profileSlugs,
    logFiles,
  });

  const agentLinks: Record<string, string> = {};
  for (const e of entrants) {
    const href = render.resolveAgentHref(
      publicDir,
      projectMeta,
      e.agentSlug,
      e.agentName,
      profileSlugs
    );
    if (href) agentLinks[e.agentSlug] = href;
  }

  const json = arena.buildTournamentDocument(db, publicDir, t, 10_000, {
    entrants,
    rrPairs,
    sfPairs,
    logFiles,
  });

  const pageInit = {
    tournamentId: t.id,
    format: t.format,
    gamesPerMatchup: t.gamesPerMatchup,
    status: t.status,
    hasSuperfinal: hasSf,
    selectedTable: broadcastRes.selectedTable ?? 1,
    completedGames: json.completedGames,
    archiveHref: json.archiveHref,
    entrants: entrants.map(e => ({
      versionId: e.versionId,
      slug: e.agentSlug,
      name: e.agentName,
      version: e.version,
    })),
    standings: json.standings,
    crosstable: json.crosstable,
    agentLinks,
    broadcast: broadcastRes.normalized,
  };

  const rulesHtml = renderTournamentRulesHtml(staticDir, t.id);

  const content = renderTemplate(TOURNAMENTS_TEMPLATE, {
    eventOptions,
    metaHtml,
    rulesHtml,
    liveInitialClass: broadcastRes.isActive ? '' : ' class="hide"',
    liveHtml: broadcastRes.html,
    standingsHtml,
    crosstableInitialClass: crossRes.isEmpty ? ' class="hide"' : '',
    crosstableHtml: crossRes.html,
    gamesHtml,
    viewerInitJson: render.safeInlineJson(broadcastRes.viewerInit),
    pageInitJson: render.safeInlineJson(pageInit),
  });

  const pageHeader = injectLiveBanner(
    header('<a href="/arena/" class="subtle">Tournaments</a>'),
    liveTournament ?? db.getRunningTournament()
  );
  const html = renderer.render({
    id: 'tournaments',
    title: `${t.name} | pkmn.ai`,
    header: pageHeader,
    path: `/arena/tournaments/${t.id}/`,
    style: `${render.ARENA_STYLE}\n${TOURNAMENTS_STYLE}`,
    content,
  });

  return {html, json};
}
