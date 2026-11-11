import * as fs from 'fs';
import * as path from 'path';

import type {Renderer} from 'site/build/page';

import type {
  ArenaDB,
  TournamentEntrantView,
  TournamentGameView,
  TournamentPairRecord,
  TournamentRow,
} from '../db';
import {header} from '../static/build';
import {escapeHtml, renderTemplate, root} from '../static/util';

import {
  ARENA_STYLE,
  FORMAT_TITLES,
  type ProjectMeta,
  formatBotLink,
  heatmapClass,
  resolveBotHref,
  safeInlineJson,
  writeFileAtomic,
} from './render';

const TOURNAMENTS_STYLE = fs.readFileSync(root('static', 'tournaments.css'), 'utf8');
const TOURNAMENTS_TEMPLATE = fs.readFileSync(root('static', 'tournaments.html'), 'utf8');
const VIEWER_STYLE = fs.readFileSync(root('static', 'viewer.css'), 'utf8');
const VIEWER_TEMPLATE = fs.readFileSync(root('static', 'viewer.html'), 'utf8');

export interface TournamentBroadcastClock {
  name: string;
  bankSeconds: number;
  thinking: boolean;
  incrementSeconds: number;
}

export interface TournamentLiveBroadcast {
  tournamentId: string;
  tables: Array<{label: string; idle?: boolean}>;
  seriesLeftHtml: string;
  seriesRightHtml: string;
  p1: TournamentBroadcastClock;
  p2: TournamentBroadcastClock;
  lines: string[];
  live?: boolean;
}

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

export function parsePackedTeamSpecies(packed: string | null): string[] {
  if (!packed?.trim()) return [];
  const out: string[] = [];
  for (const chunk of packed.split(']')) {
    if (!chunk.trim()) continue;
    const fields = chunk.split('|');
    const species = (fields[1]?.trim() || fields[0]?.trim() || '');
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

function renderPartyMinisprites(packed: string | null): string {
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

function renderClockSide(slot: 'p1' | 'p2', clock: TournamentBroadcastClock): string {
  const pillCls = clock.thinking ? 'clock-pill thinking' : 'clock-pill';
  const timeCls = clock.thinking ? 'clock-time yes' : 'clock-time';
  const subText = clock.thinking ? 'thinking…' : `+${clock.incrementSeconds}s/turn`;
  const rem = Math.round(clock.bankSeconds);
  const tip = clock.thinking
    ? `${rem}s remaining in 150s bank (currently thinking)`
    : `${rem}s remaining in 150s bank (+${clock.incrementSeconds}s/turn)`;
  return '<div class="clock-side">' +
    `<span><tt>${slot}</tt> <strong>${escapeHtml(clock.name)}</strong></span>` +
    `<span class="${pillCls}" title="${escapeHtml(tip)}">` +
      `<span class="${timeCls}" id="clock-${slot}">${formatClockMmSs(clock.bankSeconds)}</span>` +
      `<span class="clock-sub">${escapeHtml(subText)}</span>` +
    '</span></div>';
}

function renderBroadcastSectionHtml(
  tournament: TournamentRow,
  broadcast: TournamentLiveBroadcast | undefined
): {
  html: string;
  isActive: boolean;
  viewerInit: {
    lines: string[];
    live: boolean;
    side: 'p1';
    thinkingSlot?: 'p1' | 'p2';
    thinkingBankSeconds?: number;
  } | null;
} {
  const isActive = broadcast?.tournamentId === tournament.id;
  const tableNavHtml = isActive && broadcast.tables.length > 0
    ? `<nav class="subnav" aria-label="Broadcast table">
      <ul>
        ${broadcast.tables.map((tb, idx) => {
          const sep = idx > 0 ? '\n        —\n        ' : '';
          const checked = idx === 0 ? ' checked' : '';
          const tbId = `tb-${escapeHtml(tournament.id)}-${idx + 1}`;
          const labelHtml = tb.idle
            ? `${escapeHtml(tb.label)} <span class="muted">(idle)</span>`
            : escapeHtml(tb.label);
          return `${sep}<li><input type="radio" name="table-${escapeHtml(tournament.id)}" ` +
            `id="${tbId}"${checked}><label for="${tbId}">${labelHtml}</label></li>`;
        }).join('')}
      </ul>
    </nav>`
    : '';

  const seriesLeft = isActive ? broadcast.seriesLeftHtml : '<strong>Replay</strong>';
  const seriesRight = isActive ? broadcast.seriesRightHtml : '<span class="muted">—</span>';
  const clockBarHtml = isActive
    ? `<div class="clock-bar">
        ${renderClockSide('p1', broadcast.p1)}
        ${renderClockSide('p2', broadcast.p2)}
      </div>`
    : '';

  const html = `${tableNavHtml}
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

  if (!isActive) {
    return {html, isActive: false, viewerInit: null};
  }

  const isLive = broadcast.live !== false;
  const thinkingSlot = broadcast.p1.thinking
    ? 'p1'
    : broadcast.p2.thinking ? 'p2' : undefined;
  const thinkingBankSeconds = thinkingSlot ? broadcast[thinkingSlot].bankSeconds : undefined;

  return {
    html,
    isActive: true,
    viewerInit: {
      lines: broadcast.lines,
      live: isLive,
      side: 'p1',
      thinkingSlot,
      thinkingBankSeconds,
    },
  };
}

function renderTournamentStandingsHtml(opts: {
  tournament: TournamentRow;
  entrants: TournamentEntrantView[];
  hasSuperfinal: boolean;
  publicDir: string;
  projectMeta: ReadonlyMap<string, ProjectMeta>;
  profileSlugs: ReadonlySet<string>;
}): string {
  const {
    tournament,
    entrants,
    hasSuperfinal,
    publicDir,
    projectMeta,
    profileSlugs,
  } = opts;
  if (entrants.length === 0) {
    return '<p class="empty-state muted">No entrants registered yet.</p>';
  }

  const maxRrGames = Math.max(1, (entrants.length - 1) * tournament.games_per_matchup);
  const rowsHtml = entrants.map((e, idx) => {
    const rankNum = e.final_rank ?? idx + 1;
    const sfBadge = hasSuperfinal && rankNum <= 2 ? ' <span class="muted">SF</span>' : '';
    const href = resolveBotHref(publicDir, projectMeta, e.bot_slug, e.bot_name, profileSlugs);
    const botHtml = `${formatBotLink(e.bot_name, href, true)} ` +
      `<code>${escapeHtml(e.version_str)}</code>`;
    const elo = Math.round(e.tourney_elo);
    const ci = Math.round(1.96 * e.tourney_se);
    const ptsStr = e.points.toFixed(1);
    const sbStr = Math.round(e.sb_score).toLocaleString('en-US');

    return '<tr>' +
      `<td><strong>${rankNum}</strong>${sfBadge}</td>` +
      `<td>${botHtml}</td>` +
      `<td class="num"><strong>${elo}</strong> <span class="muted">±${ci}</span></td>` +
      `<td class="num">${e.game_wins}–${e.game_losses}–${e.game_ties}</td>` +
      `<td class="num"><strong>${ptsStr}</strong> <span class="muted">/ ${maxRrGames}</span></td>` +
      `<td class="num">${sbStr}</td>` +
      '</tr>';
  }).join('');

  const ptsTitle =
    `Round-Robin points out of ${maxRrGames} games (+1.0 per win, +0.5 per tie)`;
  return `<div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Bot</th>
          <th class="num" title="Tournament MAP Elo ± 95% CI">Elo</th>
          <th class="num" title="Standalone individual BYOT game Wins – Losses – Ties">W–L–T</th>
          <th class="num" title="${escapeHtml(ptsTitle)}">Points</th>
          <th class="num" title="Sonneborn-Berger tiebreak score">S–B</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  </div>`;
}

function renderTournamentCrosstableHtml(opts: {
  entrants: TournamentEntrantView[];
  pairs: TournamentPairRecord[];
  publicDir: string;
  projectMeta: ReadonlyMap<string, ProjectMeta>;
  profileSlugs: ReadonlySet<string>;
}): {html: string; isEmpty: boolean} {
  const {entrants, pairs, publicDir, projectMeta, profileSlugs} = opts;
  if (entrants.length < 2 || pairs.length === 0) {
    return {
      html: '<p class="empty-state muted">No round-robin games completed yet.</p>',
      isEmpty: true,
    };
  }

  const pairMap = new Map<string, TournamentPairRecord>();
  for (const p of pairs) {
    pairMap.set(`${p.v_low_id}:${p.v_high_id}`, p);
  }

  const colHeaders = entrants.map(e => `<th>${escapeHtml(e.bot_name)}</th>`).join('');
  const bodyRows = entrants.map(rowEnt => {
    const rowHref = resolveBotHref(
      publicDir,
      projectMeta,
      rowEnt.bot_slug,
      rowEnt.bot_name,
      profileSlugs
    );
    const rowLabel = `${formatBotLink(rowEnt.bot_name, rowHref, true)} ` +
      `<code>${escapeHtml(rowEnt.version_str)}</code>`;

    const cells = entrants.map(colEnt => {
      if (rowEnt.version_id === colEnt.version_id) {
        return '<td class="diag">—</td>';
      }
      const lowId = Math.min(rowEnt.version_id, colEnt.version_id);
      const highId = Math.max(rowEnt.version_id, colEnt.version_id);
      const pair = pairMap.get(`${lowId}:${highId}`);
      if (!pair) return '<td class="muted">—</td>';

      const isLow = rowEnt.version_id === lowId;
      const wins = isLow ? pair.low_wins : pair.high_wins;
      const losses = isLow ? pair.high_wins : pair.low_wins;
      const ties = pair.ties;
      const total = wins + losses + ties;
      if (total === 0) return '<td class="muted">—</td>';

      const pts = wins + 0.5 * ties;
      const scorePct = (pts / total) * 100;
      const scoreStr = `${scorePct.toFixed(1)}%`;
      const scoreHtml = scorePct > 50 ? `<strong>${scoreStr}</strong>` : scoreStr;
      const cls = heatmapClass(scorePct);
      const clsAttr = cls ? ` class="${cls}"` : '';
      const tip = `${pts.toFixed(1)} / ${total} pts`;

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
      <tbody>${bodyRows}</tbody>
    </table>
  </div>`,
    isEmpty: false,
  };
}

function renderTournamentGamesHtml(opts: {
  tournament: TournamentRow;
  games: TournamentGameView[];
  totalCompletedCount: number;
  publicDir: string;
  projectMeta: ReadonlyMap<string, ProjectMeta>;
  profileSlugs: ReadonlySet<string>;
}): string {
  const {
    tournament,
    games,
    totalCompletedCount,
    publicDir,
    projectMeta,
    profileSlugs,
  } = opts;

  const rowsHtml = games.length === 0
    ? '<tr><td colspan="6" class="center muted">No completed games yet.</td></tr>'
    : games.map(g => {
      const codePrefix = g.stage === 'sf' ? 'SF' : 'RR';
      const codeNum = g.stage === 'sf' ? g.h2h_game_num : g.macro_cycle;
      const gameCode = `${codePrefix}${codeNum}`;
      const logRel = `${g.id}.log`;
      const perTourLog = path.join(publicDir, 'arena', 'tournaments', tournament.id, logRel);
      const hasLog = fs.existsSync(perTourLog);
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

      const p1Href = resolveBotHref(publicDir, projectMeta, g.p1_slug, g.p1_name, profileSlugs);
      const p2Href = resolveBotHref(publicDir, projectMeta, g.p2_slug, g.p2_name, profileSlugs);
      const p1Party = renderPartyMinisprites(g.p1_team_packed);
      const p2Party = renderPartyMinisprites(g.p2_team_packed);

      const p1Cell = `<div class="player-cell">${formatBotLink(g.p1_name, p1Href, p1Won)}` +
        `${p1Party}</div>`;
      const p2Cell = `<div class="player-cell">${formatBotLink(g.p2_name, p2Href, p2Won)}` +
        `${p2Party}</div>`;

      const turnsStr = g.turns !== null ? String(g.turns) : '—';
      const b1 = Math.round(g.p1_bank_left_s ?? 0);
      const b2 = Math.round(g.p2_bank_left_s ?? 0);

      return '<tr>' +
        `<td><a href="${escapeHtml(gameHref)}" class="subtle"${replayAttr} ` +
          `title="${escapeHtml(g.id)}"><code>${escapeHtml(gameCode)}</code></a></td>` +
        `<td>${p1Cell}</td>` +
        `<td>${p2Cell}</td>` +
        `<td class="center">${resHtml}</td>` +
        `<td class="num">${turnsStr}</td>` +
        `<td class="num">${b1}s / ${b2}s</td>` +
        '</tr>';
    }).join('');

  const archiveName = `${tournament.id}-replays.7z`;
  const perTourArchive = path.join(publicDir, 'arena', 'tournaments', tournament.id, archiveName);
  const sharedArchive = path.join(publicDir, 'arena', 'tournaments', archiveName);
  const archiveHref = fs.existsSync(perTourArchive)
    ? `/arena/tournaments/${encodeURIComponent(tournament.id)}/${encodeURIComponent(archiveName)}`
    : fs.existsSync(sharedArchive)
      ? `/arena/tournaments/${encodeURIComponent(archiveName)}`
      : '#games';
  const jsonHref = `/arena/tournaments/${encodeURIComponent(tournament.id)}/index.json`;
  const bankTip = 'Remaining time bank for Player 1 / Player 2 (150s cap, +10s/turn)';

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
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
    <p class="meta meta-archive">
      Archive: <a href="${escapeHtml(archiveHref)}"><code>${escapeHtml(archiveName)}</code></a> ` +
      `(${totalCompletedCount.toLocaleString('en-US')} games) · ` +
      `<a href="${escapeHtml(jsonHref)}"><code>index.json</code></a>` +
    '</p>';
}

function readExistingTournamentBroadcast(publicDir: string): TournamentLiveBroadcast | undefined {
  const filePath = path.join(publicDir, 'api', 'tournament-live.json');
  if (!fs.existsSync(filePath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as TournamentLiveBroadcast;
    if (parsed && typeof parsed === 'object' && typeof parsed.tournamentId === 'string') {
      return parsed;
    }
  } catch {}
  return undefined;
}

export function renderBattleViewerPage(publicDir: string) {
  const viewerHtml = renderTemplate(VIEWER_TEMPLATE, {
    viewerStyle: VIEWER_STYLE,
  });
  writeFileAtomic(path.join(publicDir, 'arena', 'viewer', 'index.html'), viewerHtml);
}

export function renderArenaTournamentsSummaryHtml(opts: {
  db: ArenaDB;
  publicDir: string;
  projectMeta: ReadonlyMap<string, ProjectMeta>;
  profileSlugs: ReadonlySet<string>;
}): string {
  const {db, publicDir, projectMeta, profileSlugs} = opts;
  const tournaments = db.getTournaments();
  if (tournaments.length === 0) {
    return '<p class="empty-state muted">No championship tournaments scheduled yet.</p>';
  }

  const ongoing = tournaments.filter(t => t.status === 'running' || t.status === 'scheduled');
  const completed = tournaments
    .filter(t => t.status === 'completed')
    .sort((a, b) => (b.completed_at ?? b.starts_at) - (a.completed_at ?? a.starts_at));

  const parts: string[] = [];

  if (ongoing.length > 0) {
    const items = ongoing.map(t => {
      const tourHref = `/arena/tournaments/${encodeURIComponent(t.id)}/`;
      const fmtTitle = FORMAT_TITLES[t.format_id] ?? t.format_id;
      const entrants = db.getTournamentEntrants(t.id);
      const badge = t.status === 'running'
        ? '<span class="yes">&#9679; Live</span>'
        : '<span class="muted">Scheduled</span>';
      let leaderSuffix = '';
      if (t.status === 'running' && entrants.length > 0) {
        const leader = entrants[0];
        const lHref = resolveBotHref(
          publicDir,
          projectMeta,
          leader.bot_slug,
          leader.bot_name,
          profileSlugs
        );
        leaderSuffix = ` · Leader: ${formatBotLink(leader.bot_name, lHref, true)} ` +
          `<code>${escapeHtml(leader.version_str)}</code>`;
      }
      return `<li>${badge} <a href="${escapeHtml(tourHref)}" class="subtle">` +
        `<strong>${escapeHtml(t.name)}</strong></a> · <tt>${escapeHtml(fmtTitle)}</tt> ` +
        `(${entrants.length} entrants)${leaderSuffix}</li>`;
    }).join('\n    ');
    parts.push(`<ul class="tour-ongoing">\n    ${items}\n  </ul>`);
  }

  if (completed.length > 0) {
    const rows = completed.map(t => {
      const tourHref = `/arena/tournaments/${encodeURIComponent(t.id)}/`;
      const fmtTitle = FORMAT_TITLES[t.format_id] ?? t.format_id;
      const entrants = db.getTournamentEntrants(t.id);
      const winner = entrants.find(e => e.final_rank === 1) ?? entrants[0];
      const maxRrGames = entrants.length >= 2
        ? (entrants.length - 1) * t.games_per_matchup
        : t.games_per_matchup;

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

      const wHref = resolveBotHref(
        publicDir,
        projectMeta,
        winner.bot_slug,
        winner.bot_name,
        profileSlugs
      );
      const winnerCell = `${formatBotLink(winner.bot_name, wHref, true)} ` +
        `<code>${escapeHtml(winner.version_str)}</code>`;
      const elo = Math.round(winner.tourney_elo);
      const ci = Math.round(1.96 * winner.tourney_se);
      const ptsStr = winner.points.toFixed(1);

      return '<tr>' +
        `<td><a href="${escapeHtml(tourHref)}" class="subtle">` +
          `<strong>${escapeHtml(t.name)}</strong></a></td>` +
        `<td><tt>${escapeHtml(fmtTitle)}</tt></td>` +
        `<td>${winnerCell}</td>` +
        `<td class="num"><strong>${elo}</strong> <span class="muted">±${ci}</span></td>` +
        `<td class="num">${winner.game_wins}–${winner.game_losses}–${winner.game_ties}</td>` +
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

export function renderTournamentsPages(opts: {
  db: ArenaDB;
  renderer: Renderer;
  publicDir: string;
  projectMeta: ReadonlyMap<string, ProjectMeta>;
  profileSlugs: ReadonlySet<string>;
  tournamentBroadcast?: TournamentLiveBroadcast | null;
}) {
  const {db, renderer, publicDir, projectMeta, profileSlugs} = opts;
  renderBattleViewerPage(publicDir);

  const tournaments = db.getTournaments();
  const tourneysDir = path.join(publicDir, 'arena', 'tournaments');

  if (fs.existsSync(tourneysDir)) {
    const validIds = new Set(tournaments.map(t => t.id));
    for (const entry of fs.readdirSync(tourneysDir, {withFileTypes: true})) {
      if (entry.isDirectory() && !validIds.has(entry.name)) {
        fs.rmSync(path.join(tourneysDir, entry.name), {recursive: true, force: true});
      }
    }
  }

  if (tournaments.length === 0) return;

  const broadcast = opts.tournamentBroadcast === undefined
    ? readExistingTournamentBroadcast(publicDir)
    : opts.tournamentBroadcast ?? undefined;

  for (const t of tournaments) {
    const eventOptions = tournaments.map(other => {
      const sel = other.id === t.id ? ' selected' : '';
      const href = `/arena/tournaments/${encodeURIComponent(other.id)}/`;
      return `<option value="${escapeHtml(href)}"${sel}>${escapeHtml(other.name)}</option>`;
    }).join('');

    const entrants = db.getTournamentEntrants(t.id);
    const games = db.getTournamentGames(t.id, 50);
    const rrPairs = db.getTournamentCrosstable(t.id, 'rr');
    const sfPairs = db.getTournamentCrosstable(t.id, 'sf');
    const hasSf = sfPairs.length > 0 || games.some(g => g.stage === 'sf') ||
      (broadcast?.tournamentId === t.id && broadcast.seriesLeftHtml.includes('Superfinal'));

    const n = entrants.length;
    const rrTotal = n >= 2 ? ((n * (n - 1)) / 2) * t.games_per_matchup : 0;
    const fmtTitle = FORMAT_TITLES[t.format_id] ?? t.format_id;
    const isDoubles = t.format_id.includes('vgc') || t.format_id.includes('doubles');
    const inc = isDoubles ? 25 : 10;
    const sfSuffix = hasSf ? ' + 100-game Superfinal' : '';

    const metaHtml =
      `<p class="meta"><tt>${escapeHtml(fmtTitle)}</tt> · ${n} Entrants · ` +
      `<tt>G=${t.games_per_matchup}</tt> Double Round-Robin ` +
      `(${rrTotal.toLocaleString('en-US')} games)${sfSuffix}<br>` +
      `${escapeHtml(t.hardware_desc)} · <tt>150s</tt> bank (<tt>+${inc}s/turn</tt>)</p>`;

    const broadcastRes = renderBroadcastSectionHtml(t, broadcast);
    const standingsHtml = renderTournamentStandingsHtml({
      tournament: t,
      entrants,
      hasSuperfinal: hasSf,
      publicDir,
      projectMeta,
      profileSlugs,
    });
    const crossRes = renderTournamentCrosstableHtml({
      entrants,
      pairs: rrPairs,
      publicDir,
      projectMeta,
      profileSlugs,
    });

    let completedCount = 0;
    for (const p of rrPairs) completedCount += p.low_wins + p.high_wins + p.ties;
    for (const p of sfPairs) completedCount += p.low_wins + p.high_wins + p.ties;

    const gamesHtml = renderTournamentGamesHtml({
      tournament: t,
      games,
      totalCompletedCount: completedCount,
      publicDir,
      projectMeta,
      profileSlugs,
    });

    const content = renderTemplate(TOURNAMENTS_TEMPLATE, {
      eventOptions,
      metaHtml,
      liveInitialClass: broadcastRes.isActive ? '' : ' class="hide"',
      liveHtml: broadcastRes.html,
      standingsHtml,
      crosstableInitialClass: crossRes.isEmpty ? ' class="hide"' : '',
      crosstableHtml: crossRes.html,
      gamesHtml,
      viewerInitJson: safeInlineJson(broadcastRes.viewerInit),
    });

    const html = renderer.render({
      id: 'tournaments',
      title: `${t.name} | pkmn.ai`,
      header: header('<a href="/arena/" class="subtle">Tournaments</a>'),
      path: `/arena/tournaments/${t.id}/`,
      style: `${ARENA_STYLE}\n${TOURNAMENTS_STYLE}`,
      content,
    });

    const tourneyJson = {
      id: t.id,
      name: t.name,
      format_id: t.format_id,
      status: t.status,
      games_per_matchup: t.games_per_matchup,
      starts_at: t.starts_at,
      completed_at: t.completed_at,
      completed_games: completedCount,
      standings: entrants.map((e, idx) => ({
        rank: e.final_rank ?? idx + 1,
        bot_slug: e.bot_slug,
        bot_name: e.bot_name,
        version: e.version_str,
        elo: Math.round(e.tourney_elo),
        ci95: Math.round(1.96 * e.tourney_se),
        wins: e.game_wins,
        losses: e.game_losses,
        ties: e.game_ties,
        points: e.points,
        sb_score: e.sb_score,
      })),
    };

    writeFileAtomic(path.join(tourneysDir, t.id, 'index.html'), html);
    writeFileAtomic(
      path.join(tourneysDir, t.id, 'index.json'),
      `${JSON.stringify(tourneyJson, null, 2)}\n`
    );
  }
}
