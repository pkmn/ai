import * as fs from 'fs';
import * as path from 'path';

import * as site from 'site';

import type * as db from '../db';
import {Renderer, header, injectLiveBanner} from '../static/build';
import {
  Child,
  Html,
  TABLE_PAGE_SIZE,
  TablePager,
  formatUtcDate,
  formatUtcDateTime,
  raw,
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
const VIEWER_STYLE = fs.readFileSync(root('static', 'viewer.css'), 'utf8');

const VIEWER_SCRIPT = `
  (() => {
    'use strict';

    const ASSETS = 'https://play.pokemonshowdown.com';
    const STYLES = ['/style/battle.css?a7', '/style/utilichart.css?a7'];
    const SCRIPTS = [
      '/js/lib/ps-polyfill.js',
      '/config/config.js?a7',
      '/js/lib/jquery-1.11.0.min.js',
      '/js/lib/html-sanitizer-minified.js',
      '/js/battle-sound.js',
      '/js/battledata.js?a7',
      '/data/pokedex-mini.js?a7',
      '/data/pokedex-mini-bw.js?a7',
      '/data/graphics.js?a7',
      '/data/pokedex.js?a7',
      '/data/moves.js?a7',
      '/data/abilities.js?a7',
      '/data/items.js?a7',
      '/data/teambuilder-tables.js?a7',
      '/js/battle-tooltips.js?a7',
      '/js/battle.js?a7',
    ];

    const SPEEDS = {
      slow: {fade: 500, shown: 1000},
      normal: {fade: 300, shown: 1},
      fast: {fade: 50, shown: 1},
      hyperfast: {fade: 40, shown: 1},
    };

    const SCENE_WIDTH = 640;
    const appOrigin = new URL(location.href).origin;

    document.addEventListener('error', event => {
      const image = event.target;
      if (!(image instanceof HTMLImageElement) || image.dataset.arenaRetried) return;
      const sprite = /^(.*\\/sprites\\/[^/]+\\/)([a-z0-9]+)-[^/.]+(\\.[a-z]+)$/.exec(image.src);
      if (!sprite) return;
      image.dataset.arenaRetried = 'true';
      image.src = sprite[1] + sprite[2] + sprite[3];
    }, true);

    const el = {
      stage: document.getElementById('stage'),
      battle: document.getElementById('battle'),
      log: document.getElementById('log'),
      start: document.getElementById('start'),
      status: document.getElementById('status'),
      controls: document.getElementById('controls'),
      toggle: document.getElementById('toggle'),
      turn: document.getElementById('turn'),
      live: document.getElementById('live'),
      speed: document.getElementById('speed'),
      sound: document.getElementById('sound'),
    };

    let battle = null;
    let live = false;
    let muted = true;
    let controlsBound = false;

    const notifyApp = msg => {
      if (window.parent !== window) {
        window.parent.postMessage(msg, appOrigin);
      }
    };

    const showStatus = text => {
      el.status.textContent = text;
      el.status.hidden = text === '';
    };

    const applyTheme = dark => {
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
      document.documentElement.classList.toggle('dark', dark);
    };

    const fitScene = () => {
      if (!el.stage.clientWidth) return;
      el.stage.style.setProperty('--scene-scale', String(el.stage.clientWidth / SCENE_WIDTH));
    };

    const loadStyle = stylePath => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = ASSETS + stylePath;
      const styleAnchor = document.getElementById('viewer-style');
      document.head.insertBefore(link, styleAnchor);
    };

    const loadScript = scriptPath => new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = ASSETS + scriptPath;
      script.async = false;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Could not load ' + scriptPath));
      document.head.appendChild(script);
    });

    const isPlaying = () =>
      Boolean(battle && !battle.paused && !(battle.ended && battle.atQueueEnd));

    const applySpeed = () => {
      if (!battle) return;
      const s = SPEEDS[el.speed.value] || SPEEDS.normal;
      battle.messageFadeTime = s.fade;
      battle.messageShownTime = s.shown;
      battle.scene.updateAcceleration();
    };

    const applySound = () => {
      if (!battle) return;
      battle.setMute(muted);
      el.sound.setAttribute('aria-pressed', String(!muted));
      el.sound.textContent = muted ? 'Mute' : 'Sound';
    };

    const describeTurn = () => {
      if (!battle) return '';
      if (battle.ended && battle.atQueueEnd) return 'Finished';
      if (battle.turn > 0) return 'Turn ' + battle.turn;
      if (live) return 'Starting';
      return battle.stepQueue.some(line => line.startsWith('|teampreview'))
        ? 'Team preview'
        : 'Start';
    };

    const render = () => {
      if (!battle) return;
      const playing = isPlaying();
      el.toggle.innerHTML = playing ? '&#9208;' : '&#9654;';
      el.toggle.title = playing ? 'Pause' : 'Play';
      el.turn.textContent = describeTurn();
      el.live.hidden = !live;
      el.live.dataset.following = String(!battle.paused && battle.seeking === null);
      if (battle.started) el.start.hidden = true;
    };

    const play = () => {
      if (!battle) return;
      if (battle.ended && battle.atQueueEnd) battle.reset();
      battle.play();
    };

    const actions = {
      start: () => battle && battle.reset(),
      previous: () => battle && battle.seekBy(-1),
      next: () => battle && battle.seekBy(1),
      end: () => {
        if (!battle) return;
        battle.seekTurn(Infinity);
        if (live && battle.paused) battle.play();
      },
      toggle: () => (isPlaying() ? battle.pause() : play()),
      switch: () => battle && battle.switchViewpoint(),
      sound: () => {
        muted = !muted;
        applySound();
      },
    };

    const enableControls = () => {
      for (const control of el.controls.querySelectorAll('button, select')) {
        control.disabled = false;
      }
      if (controlsBound) return;
      controlsBound = true;
      el.controls.addEventListener('click', event => {
        const btn = event.target instanceof Element ? event.target.closest('button') : null;
        const act = btn ? actions[btn.dataset.action] : undefined;
        if (!act) return;
        act();
        render();
      });
      el.speed.addEventListener('change', () => {
        applySpeed();
        notifyApp({type: 'speed', speed: el.speed.value});
      });
      el.start.addEventListener('click', () => {
        play();
        render();
      });
    };

    const loadBattle = (lines, isLive, side) => {
      if (battle) {
        battle.destroy();
        el.battle.innerHTML = '';
        el.log.innerHTML = '';
      }
      live = Boolean(isLive);
      window.BattleSound.setMute(muted);
      battle = new window.Battle({
        id: '',
        $frame: window.$(el.battle),
        $logFrame: window.$(el.log),
        log: lines,
        paused: !live,
      });
      battle.subscribe(render);
      if (side === 'p2') battle.setViewpoint('p2');
      applySound();
      applySpeed();
      enableControls();
      showStatus('');
      el.start.hidden = live;
      if (live) battle.seekTurn(Infinity);
      render();
    };

    const ownPokemon = requested => {
      const mon = {...requested};
      if (typeof mon.ident !== 'string' || typeof mon.details !== 'string') return mon;
      const name = mon.ident.slice(mon.ident.indexOf(':') + 1).trim();
      battle.parseDetails(name, mon.ident, mon.details, mon);
      if (typeof mon.condition === 'string') battle.parseHealth(mon.condition, mon);
      return mon;
    };

    const isLines = val => Array.isArray(val) && val.every(x => typeof x === 'string');

    const onMessage = event => {
      if (event.source !== window.parent || event.origin !== appOrigin) return;
      const msg = event.data;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'load' && isLines(msg.lines)) {
        loadBattle(msg.lines, msg.live, msg.side);
      } else if (msg.type === 'append' && battle && live && isLines(msg.lines)) {
        for (const line of msg.lines) battle.add(line);
        render();
      } else if (msg.type === 'end' && battle) {
        live = false;
        render();
      } else if (msg.type === 'theme' && typeof msg.dark === 'boolean') {
        applyTheme(msg.dark);
      } else if (msg.type === 'speed' && Object.hasOwn(SPEEDS, msg.speed)) {
        el.speed.value = msg.speed;
        applySpeed();
      } else if (msg.type === 'team' && battle && Array.isArray(msg.pokemon)) {
        battle.myPokemon = msg.pokemon.map(ownPokemon);
      }
    };

    const boot = async () => {
      window.exports = window;
      applyTheme(window.matchMedia('(prefers-color-scheme: dark)').matches);
      STYLES.forEach(loadStyle);
      new ResizeObserver(fitScene).observe(el.stage);
      fitScene();
      window.addEventListener('message', onMessage);

      try {
        await Promise.all(SCRIPTS.map(loadScript));
      } catch {
        showStatus('Battle viewer offline (play.pokemonshowdown.com unreachable).');
        notifyApp({type: 'error', message: 'offline'});
        return;
      }
      if (typeof window.Battle !== 'function' || typeof window.$ !== 'function') {
        showStatus('Battle viewer unavailable offline.');
        notifyApp({type: 'error', message: 'init'});
        return;
      }

      showStatus('Waiting for battle…');
      notifyApp({type: 'ready'});
    };

    void boot();
  })();
`;

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

function renderPartyMinisprites(packed?: string): Child {
  const speciesList = parsePackedTeamSpecies(packed);
  if (speciesList.length === 0) return undefined;
  return (
    <span className='party-minisprites'>
      {speciesList.slice(0, 6).map(sp => {
        const slug = speciesToMinispriteSlug(sp);
        if (!slug) return undefined;
        const src = `https://www.smogon.com/forums/media/minisprites/${slug}.png`;
        return <span><img src={src} alt={sp} title={sp} /></span>;
      })}
    </span>
  );
}

function renderClockSide(slot: 'p1' | 'p2', clock: BroadcastClock): Html {
  const pillCls = clock.thinking ? 'clock-pill thinking' : 'clock-pill';
  const timeCls = clock.thinking ? 'clock-time yes' : 'clock-time';
  const subText = clock.thinking ? 'thinking…' : `+${clock.incrementSeconds}s/turn`;
  const rem = Math.round(clock.bankSeconds);
  const tip = clock.thinking
    ? `${rem}s remaining in 150s bank (currently thinking)`
    : `${rem}s remaining in 150s bank (+${clock.incrementSeconds}s/turn)`;
  return (
    <div className='clock-side' id={`clock-side-${slot}`}>
      <span><tt>{slot}</tt> <strong id={`clock-name-${slot}`}>{clock.name}</strong></span>
      <span className={pillCls} id={`clock-pill-${slot}`} title={tip}>
        <span className={timeCls} id={`clock-${slot}`}>{formatClockMmSs(clock.bankSeconds)}</span>
        <span className='clock-sub' id={`clock-sub-${slot}`}>{subText}</span>
      </span>
    </div>
  );
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
  node: Html;
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

  const p1Clock = selected?.p1 ?? norm?.p1;
  const p2Clock = selected?.p2 ?? norm?.p2;
  const seriesLeft = selected?.seriesLeftHtml ?? norm?.seriesLeftHtml ?? '<strong>Replay</strong>';
  const seriesRight = selected?.seriesRightHtml ??
    norm?.seriesRightHtml ??
    '<span class="muted">—</span>';

  // Sandboxed Showdown replay iframe (`sandbox="allow-scripts"` without `allow-same-origin`)
  // isolates third-party battle client DOM/scripts from `pkmn.ai` session cookies.
  const node = (
    <>
      <div id='table-nav-wrap'>
        {norm && norm.tables.length > 0 && (
          <nav className='subnav' aria-label='Broadcast table'>
            <ul>
              {norm.tables.map((tb, idx) => {
                const tbId = `tb-${tournament.id}-${tb.table}`;
                return [
                  idx > 0 && ' — ',
                  <li>
                    <input
                      type='radio'
                      name={`table-${tournament.id}`}
                      id={tbId}
                      value={tb.table}
                      data-table-num={tb.table}
                      checked={tb.table === (selected?.table ?? 1)}
                    />
                    <label htmlFor={tbId}>
                      {tb.label}
                      {tb.idle && <> <span className='muted'>(idle)</span></>}
                    </label>
                  </li>,
                ];
              })}
            </ul>
          </nav>
        )}
      </div>
      <div className='broadcast'>
        <div className='series-bar'>
          <span id='series-left'>{raw(seriesLeft)}</span>
          <span id='series-right'>{raw(seriesRight)}</span>
        </div>
        {norm && p1Clock && p2Clock ? (
          <div className='clock-bar' id='clock-bar'>
            {renderClockSide('p1', p1Clock)}
            {renderClockSide('p2', p2Clock)}
          </div>
        ) : (
          <div className='clock-bar hide' id='clock-bar' />
        )}
        <div className='viewer-wrap'>
          <iframe
            id='ps-viewer-frame'
            className='viewer-frame'
            src='/arena/viewer/'
            title='Pokémon Showdown battle viewer'
            sandbox='allow-scripts'
          />
        </div>
      </div>
    </>
  );

  if (!norm || !p1Clock || !p2Clock) {
    return {node, isActive: false};
  }

  const lines = selected?.lines ?? norm.lines;
  const isLive = selected ? selected.live !== false : norm.live !== false;
  const thinkingSlot = p1Clock.thinking ? 'p1' : p2Clock.thinking ? 'p2' : undefined;
  const thinkingBankSeconds = thinkingSlot
    ? (thinkingSlot === 'p1' ? p1Clock.bankSeconds : p2Clock.bankSeconds)
    : undefined;

  return {
    node,
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

function renderTournamentStandingsNode(opts: {
  tournament: db.TournamentRow;
  entrants: db.TournamentEntrantView[];
  hasSuperfinal: boolean;
  liveTables: BroadcastTable[];
  publicDir: string;
  projectMeta: ReadonlyMap<string, render.ProjectMeta>;
  profileSlugs: ReadonlySet<string>;
}): Html {
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
    return (
      <div id='standings-body'>
        <p className='empty-state muted'>No entrants registered yet.</p>
      </div>
    );
  }

  const maxRrGames = Math.max(1, (entrants.length - 1) * tournament.gamesPerMatchup);
  const ptsTitle =
    `Round-Robin points out of ${maxRrGames} games (+1.0 per win, +0.5 per tie)`;

  return (
    <div id='standings-body'>
      <div className='table-wrap'>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Agent</th>
              <th className='num' title='Tournament MAP Elo ± 95% CI'>Elo</th>
              <th className='num' title='Standalone individual BYOT game Wins – Losses – Ties'>
                W–L–T
              </th>
              <th className='num' title={ptsTitle}>Points</th>
              <th className='num' title='Sonneborn-Berger tiebreak score'>S–B</th>
            </tr>
          </thead>
          <tbody>
            {entrants.map((e, idx) => {
              const rankNum = e.finalRank ?? idx + 1;
              const href = render.resolveAgentHref(
                publicDir,
                projectMeta,
                e.agentSlug,
                e.agentName,
                profileSlugs
              );
              const liveTb = findLiveTableForEntrant(liveTables, e.agentSlug, e.agentName);
              const elo = Math.round(e.elo);
              const ci = Math.round(1.96 * e.se);
              const ptsStr = e.points.toFixed(1);
              const sbStr = Math.round(e.sonnebornBerger).toLocaleString('en-US');

              return (
                <tr className={idx >= TABLE_PAGE_SIZE ? 'hide' : undefined}>
                  <td>
                    <strong>{rankNum}</strong>
                    {hasSuperfinal && rankNum <= 2 && <> <span className='muted'>SF</span></>}
                  </td>
                  <td>
                    {raw(render.formatAgentLink(e.agentName, href, true))}{' '}
                    <code>{e.version}</code>
                    {liveTb && (
                      <>
                        {' '}
                        <a
                          href='#live'
                          className='live-pill'
                          data-live-table={liveTb.table}
                          title={`Spectate live on ${liveTb.label}`}
                        >
                          {'\u25cf'} T{liveTb.table}
                        </a>
                      </>
                    )}
                  </td>
                  <td className='num'>
                    <strong>{elo}</strong> <span className='muted'>±{ci}</span>
                  </td>
                  <td className='num'>{e.gameWins}–{e.gameLosses}–{e.gameTies}</td>
                  <td className='num'>
                    <strong>{ptsStr}</strong> <span className='muted'>/ {maxRrGames}</span>
                  </td>
                  <td className='num'>{sbStr}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <TablePager
        id='standings-pager'
        label='Standings pagination'
        total={entrants.length}
        singular='entrant'
        plural='entrants'
      />
    </div>
  );
}

function renderTournamentCrosstableNode(opts: {
  entrants: db.TournamentEntrantView[];
  pairs: db.TournamentPairRecord[];
  liveTables: BroadcastTable[];
  publicDir: string;
  projectMeta: ReadonlyMap<string, render.ProjectMeta>;
  profileSlugs: ReadonlySet<string>;
}): {node: Html; isEmpty: boolean} {
  const {entrants, pairs, liveTables, publicDir, projectMeta, profileSlugs} = opts;
  const rrLiveTables = liveTables.filter(tb => tb.stage !== 'Superfinal');
  if (entrants.length < 2 || (pairs.length === 0 && rrLiveTables.length === 0)) {
    return {
      node: (
        <div id='crosstable-body'>
          <p className='empty-state muted'>No round-robin games completed yet.</p>
        </div>
      ),
      isEmpty: true,
    };
  }

  const pairMap = new Map<string, db.TournamentPairRecord>();
  for (const p of pairs) {
    pairMap.set(`${p.lowVersionId}:${p.highVersionId}`, p);
  }

  return {
    isEmpty: false,
    node: (
      <div id='crosstable-body'>
        <div className='table-wrap'>
          <table className='matrix'>
            <thead>
              <tr>
                <th>{'\u00a0'}</th>
                {entrants.map(e => <th>{e.agentName}</th>)}
              </tr>
            </thead>
            <tbody>
              {entrants.map(rowEnt => {
                const rowHref = render.resolveAgentHref(
                  publicDir,
                  projectMeta,
                  rowEnt.agentSlug,
                  rowEnt.agentName,
                  profileSlugs
                );
                return (
                  <tr>
                    <td>
                      {raw(render.formatAgentLink(rowEnt.agentName, rowHref, true))}{' '}
                      <code>{rowEnt.version}</code>
                    </td>
                    {entrants.map(colEnt => {
                      if (rowEnt.versionId === colEnt.versionId) {
                        return <td className='diag'>—</td>;
                      }
                      const liveTb = findLiveTableForPair(
                        rrLiveTables,
                        {slug: rowEnt.agentSlug, name: rowEnt.agentName},
                        {slug: colEnt.agentSlug, name: colEnt.agentName}
                      );
                      const livePill = liveTb ? (
                        <a
                          href='#live'
                          className='live-pill'
                          data-live-table={liveTb.table}
                          title={`Spectate live on ${liveTb.label}`}
                        >
                          {'\u25cf'} T{liveTb.table}
                        </a>
                      ) : undefined;

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
                          return <td className='center'>{livePill}</td>;
                        }
                        return <td className='muted'>—</td>;
                      }

                      const pts = wins + 0.5 * ties;
                      const scorePct = (pts / total) * 100;
                      const scoreStr = `${scorePct.toFixed(1)}%`;
                      const cls = render.heatmapClass(scorePct) || undefined;
                      const tip = `${pts.toFixed(1)} / ${total} pts`;

                      return (
                        <td className={cls} title={tip}>
                          {scorePct > 50 ? <strong>{scoreStr}</strong> : scoreStr}
                          <span className='sub'>
                            {wins}–{losses}–{ties}
                            {livePill && <> · {livePill}</>}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    ),
  };
}

function renderTournamentGamesNode(opts: {
  tournament: db.TournamentRow;
  games: db.TournamentGameView[];
  liveTables: BroadcastTable[];
  totalCompletedCount: number;
  publicDir: string;
  projectMeta: ReadonlyMap<string, render.ProjectMeta>;
  profileSlugs: ReadonlySet<string>;
  logFiles?: ReadonlySet<string>;
}): Html {
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

  const liveRows = liveTables.map((tb, idx) => {
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
    const turn = parseLatestTurnFromLines(tb.lines);
    const turnsStr = turn !== undefined ? String(turn) : '—';
    const b1 = Math.round(p1.bankSeconds);
    const b2 = Math.round(p2.bankSeconds);
    const tip = `Spectate live on ${tb.label}`;
    const rowCls = idx >= TABLE_PAGE_SIZE ? 'live-game-row hide' : 'live-game-row';

    return (
      <tr className={rowCls} data-live-game-table={tb.table}>
        <td>
          <a href='#live' className='subtle' data-live-table={tb.table} title={tip}>
            <code>{gameCode}</code>
          </a>
        </td>
        <td>
          <div className='player-cell'>
            {raw(render.formatAgentLink(p1.name, p1Href, false))}
            {renderPartyMinisprites(p1.team)}
          </div>
        </td>
        <td>
          <div className='player-cell'>
            {raw(render.formatAgentLink(p2.name, p2Href, false))}
            {renderPartyMinisprites(p2.team)}
          </div>
        </td>
        <td className='center'>
          <a href='#live' className='live-pill' data-live-table={tb.table} title={tip}>
            {'\u25cf'} T{tb.table}
          </a>
        </td>
        <td className='num'>{turnsStr}</td>
        <td className='num'>{b1}s / {b2}s</td>
      </tr>
    );
  });

  const completedRows = games.map((g, idx) => {
    const codePrefix = g.stage === 'Superfinal' ? 'SF' : 'RR';
    const codeNum = g.stage === 'Superfinal' ? g.matchupGame : g.cycle;
    const gameCode = `${codePrefix}${codeNum}`;
    const logRel = `${g.id}.log`;
    const hasLog = resolvedLogs.has(logRel);
    const logUrl = `/arena/tournaments/${encodeURIComponent(tournament.id)}/` +
      encodeURIComponent(logRel);
    const gameHref = hasLog ? logUrl : '#games';

    const p1Won = g.outcome === 'W';
    const p2Won = g.outcome === 'L';
    const resNode = p1Won
      ? <><strong>1</strong>–0</>
      : p2Won
        ? <>0–<strong>1</strong></>
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
    const turnsStr = g.turns !== undefined ? String(g.turns) : '—';
    const b1 = Math.round(g.p1BankSeconds ?? 0);
    const b2 = Math.round(g.p2BankSeconds ?? 0);

    return (
      <tr
        className={liveTables.length + idx >= TABLE_PAGE_SIZE ? 'hide' : undefined}
        data-game-id={g.id}
      >
        <td>
          <a
            href={gameHref}
            className='subtle'
            data-replay-log={hasLog ? logUrl : undefined}
            title={g.id}
          >
            <code>{gameCode}</code>
          </a>
        </td>
        <td>
          <div className='player-cell'>
            {raw(render.formatAgentLink(g.p1Name, p1Href, p1Won))}
            {renderPartyMinisprites(g.p1Team)}
          </div>
        </td>
        <td>
          <div className='player-cell'>
            {raw(render.formatAgentLink(g.p2Name, p2Href, p2Won))}
            {renderPartyMinisprites(g.p2Team)}
          </div>
        </td>
        <td className='center'>{resNode}</td>
        <td className='num'>{turnsStr}</td>
        <td className='num'>{b1}s / {b2}s</td>
      </tr>
    );
  });

  const archive = resolveTournamentArchive(publicDir, tournament.id);
  const jsonHref = `/arena/tournaments/${encodeURIComponent(tournament.id)}/index.json`;
  const bankTip = 'Remaining time bank for Player 1 / Player 2 (150s cap, +10s/turn)';
  const countStr = totalCompletedCount.toLocaleString('en-US');
  const totalGameRows = liveTables.length + games.length;

  return (
    <>
      <div className='table-wrap'>
        <table>
          <thead>
            <tr>
              <th>Game</th>
              <th>Player 1</th>
              <th>Player 2</th>
              <th className='center'>Result</th>
              <th className='num'>Turns</th>
              <th className='num' title={bankTip}>Bank</th>
            </tr>
          </thead>
          <tbody id='games-tbody'>
            {liveRows.length === 0 && completedRows.length === 0 ? (
              <tr className='empty-row'>
                <td colSpan={6} className='center muted'>No completed games yet.</td>
              </tr>
            ) : (
              [...liveRows, ...completedRows]
            )}
          </tbody>
        </table>
      </div>
      <TablePager
        id='games-pager'
        label='Games pagination'
        total={totalGameRows}
        singular='game'
        plural='games'
        prevLabel={'\u2190 Newer'}
        nextLabel={'Older \u2192'}
      />
      <p className='meta meta-archive' id='games-archive-meta'>
        {archive ? (
          <>
            Archive: <a href={archive.href}><code>{archive.name}</code></a> (
            <span id='games-count'>{countStr}</span> games) ·{' '}
            <a href={jsonHref}><code>index.json</code></a>
          </>
        ) : (
          <>
            Data: <a href={jsonHref}><code>index.json</code></a> (
            <span id='games-count'>{countStr}</span> games
            {tournament.status !== 'completed' && '; replay archive published upon completion'}
            )
          </>
        )}
      </p>
    </>
  );
}

export function renderBattleViewerPage(publicDir: string) {
  const csp =
    "default-src 'none'; script-src 'unsafe-inline' https://play.pokemonshowdown.com; " +
    "style-src 'unsafe-inline' https://play.pokemonshowdown.com; " +
    'img-src https://play.pokemonshowdown.com data:; ' +
    'media-src https://play.pokemonshowdown.com;';
  const viewerDoc = (
    <html lang='en'>
      <head>
        <meta charset='utf-8' />
        <meta name='viewport' content='width=device-width, initial-scale=1' />
        <meta name='robots' content='noindex' />
        <meta http-equiv='Content-Security-Policy' content={csp} />
        <title>Battle Viewer | pkmn.ai</title>
        <style id='viewer-style'>{VIEWER_STYLE}</style>
      </head>
      <body>
        <div className='arena-stage' id='stage'>
          <div className='battle' id='battle' />
          <button className='arena-start' id='start' type='button' hidden={true}>
            {'\u25b6'} Play replay
          </button>
          <p className='arena-status' id='status' role='status'>Loading battle viewer…</p>
        </div>

        <div className='arena-controls' id='controls' role='toolbar' aria-label='Playback controls'>
          <div className='arena-group'>
            <button
              type='button'
              className='arena-btn'
              data-action='start'
              title='First turn'
              disabled={true}
            >
              |{'\u25c0'}
            </button>
            <button
              type='button'
              className='arena-btn'
              data-action='previous'
              title='Previous turn'
              disabled={true}
            >
              {'\u25c0'}
            </button>
            <button
              type='button'
              className='arena-btn'
              data-action='toggle'
              id='toggle'
              title='Play'
              disabled={true}
            >
              {'\u25b6'}
            </button>
            <button
              type='button'
              className='arena-btn'
              data-action='next'
              title='Next turn'
              disabled={true}
            >
              {'\u25b6'}
            </button>
            <button
              type='button'
              className='arena-btn'
              data-action='end'
              title='Jump to end'
              disabled={true}
            >
              {'\u25b6'}|
            </button>
          </div>

          <p className='arena-turn' id='turn' />
          <span className='arena-live' id='live' hidden={true}>{'\u25cf'} Live</span>

          <div className='arena-group arena-end'>
            <button
              type='button'
              className='arena-btn'
              data-action='switch'
              title='Switch viewpoint'
              disabled={true}
            >
              Switch
            </button>
            <select className='arena-speed' id='speed' aria-label='Playback speed' disabled={true}>
              <option value='slow'>Slow</option>
              <option value='normal' selected={true}>Normal</option>
              <option value='fast'>Fast</option>
              <option value='hyperfast'>Hyperfast</option>
            </select>
            <button
              type='button'
              className='arena-btn'
              data-action='sound'
              id='sound'
              aria-pressed='false'
              title='Toggle sound'
              disabled={true}
            >
              Mute
            </button>
          </div>
        </div>

        <div className='battle-log' id='log' aria-label='Battle log' />

        <script>{VIEWER_SCRIPT}</script>
      </body>
    </html>
  );
  render.writeFileAtomic(
    path.join(publicDir, 'arena', 'viewer', 'index.html'),
    `<!doctype html>\n${String(viewerDoc)}`
  );
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
    return String(<p className='empty-state muted'>No championship tournaments scheduled yet.</p>);
  }

  const ongoing = tournaments.filter(t => t.status === 'running' || t.status === 'scheduled');
  const completed = tournaments
    .filter(t => t.status === 'completed')
    .sort((a, b) => (b.completedAt ?? b.startsAt) - (a.completedAt ?? a.startsAt));

  return String(
    <>
      {ongoing.length > 0 && (
        <ul className='tour-ongoing'>
          {ongoing.map(t => {
            const tourHref = `/arena/tournaments/${encodeURIComponent(t.id)}/`;
            const fmtTitle = render.FORMAT_TITLES[t.format] ?? t.format;
            const entrants = entrantsByTournament?.get(t.id) ?? db.getTournamentEntrants(t.id);
            const badge = t.status === 'running'
              ? <span className='yes'>{'\u25cf'} Live</span>
              : <span className='muted'>Scheduled</span>;
            let leaderSuffix: Child = undefined;
            if (t.status === 'running' && entrants.length > 0) {
              const leader = entrants[0];
              const lHref = render.resolveAgentHref(
                publicDir,
                projectMeta,
                leader.agentSlug,
                leader.agentName,
                profileSlugs
              );
              leaderSuffix = (
                <>
                  {' · Leader: '}
                  {raw(render.formatAgentLink(leader.agentName, lHref, true))}{' '}
                  <code>{leader.version}</code>
                </>
              );
            }
            let timingSuffix: Child = undefined;
            if (t.status === 'scheduled') {
              const closesAt = db.getTournamentClosesAt(t.startsAt);
              timingSuffix = (
                <>
                  {` · starts ${formatUtcDateTime(t.startsAt)}` +
                    ` (entries close ${formatUtcDateTime(closesAt)})`}
                </>
              );
            }
            return (
              <li>
                {badge}{' '}
                <a href={tourHref} className='subtle'><strong>{t.name}</strong></a>
                {' · '}
                <tt>{fmtTitle}</tt> ({entrants.length} entrants)
                {leaderSuffix}
                {timingSuffix}
              </li>
            );
          })}
        </ul>
      )}
      {completed.length > 0 ? (
        <>
          <div className='table-wrap'>
            <table>
              <thead>
                <tr>
                  <th>Tournament</th>
                  <th>Format</th>
                  <th>Winner</th>
                  <th className='num' title='Tournament MAP Elo ± 95% CI'>Elo</th>
                  <th className='num' title='Individual game Wins – Losses – Ties'>W–L–T</th>
                  <th className='num' title='Round-Robin points'>Points</th>
                </tr>
              </thead>
              <tbody>
                {completed.map((t, idx) => {
                  const tourHref = `/arena/tournaments/${encodeURIComponent(t.id)}/`;
                  const fmtTitle = render.FORMAT_TITLES[t.format] ?? t.format;
                  const entrants =
                    entrantsByTournament?.get(t.id) ?? db.getTournamentEntrants(t.id);
                  const winner = entrants.find(e => e.finalRank === 1) ?? entrants[0];
                  const maxRrGames = entrants.length >= 2
                    ? (entrants.length - 1) * t.gamesPerMatchup
                    : t.gamesPerMatchup;
                  const hideCls = idx >= TABLE_PAGE_SIZE ? 'hide' : undefined;

                  if (!winner) {
                    return (
                      <tr className={hideCls}>
                        <td>
                          <a href={tourHref} className='subtle'><strong>{t.name}</strong></a>
                        </td>
                        <td><tt>{fmtTitle}</tt></td>
                        <td className='muted'>—</td>
                        <td className='num muted'>—</td>
                        <td className='num muted'>—</td>
                        <td className='num muted'>—</td>
                      </tr>
                    );
                  }

                  const wHref = render.resolveAgentHref(
                    publicDir,
                    projectMeta,
                    winner.agentSlug,
                    winner.agentName,
                    profileSlugs
                  );
                  const elo = Math.round(winner.elo);
                  const ci = Math.round(1.96 * winner.se);
                  const ptsStr = winner.points.toFixed(1);

                  return (
                    <tr className={hideCls}>
                      <td>
                        <a href={tourHref} className='subtle'><strong>{t.name}</strong></a>
                      </td>
                      <td><tt>{fmtTitle}</tt></td>
                      <td>
                        {raw(render.formatAgentLink(winner.agentName, wHref, true))}{' '}
                        <code>{winner.version}</code>
                      </td>
                      <td className='num'>
                        <strong>{elo}</strong> <span className='muted'>±{ci}</span>
                      </td>
                      <td className='num'>
                        {winner.gameWins}–{winner.gameLosses}–{winner.gameTies}
                      </td>
                      <td className='num'>
                        <strong>{ptsStr}</strong> <span className='muted'>/ {maxRrGames}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <TablePager
            id='tournaments-pager'
            label='Completed tournaments pagination'
            total={completed.length}
            singular='tournament'
            plural='tournaments'
          />
        </>
      ) : (
        ongoing.length > 0 && <p className='muted'>No completed past tournaments yet.</p>
      )}
    </>
  );
}

function renderTournamentRulesNode(staticDir: string, tournamentId: string): Child {
  if (!/^[A-Za-z0-9_-]+$/.test(tournamentId)) return undefined;
  const rulesPath = path.join(staticDir, 'tours', `${tournamentId}.dj`);
  if (!fs.existsSync(rulesPath)) return undefined;
  const body = site.html.render(fs.readFileSync(rulesPath, 'utf8')).trim();
  if (!body) return undefined;
  return <section className='tour-rules'>{raw(body)}</section>;
}

function buildTournamentScript(viewerInit: unknown, pageInit: unknown): string {
  return `
  document.addEventListener('DOMContentLoaded', () => {
    const eventSelect = document.getElementById('event-select');
    const liveSec = document.getElementById('live');
    const tableNavWrap = document.getElementById('table-nav-wrap');
    const seriesLeftEl = document.getElementById('series-left');
    const seriesRightEl = document.getElementById('series-right');
    const clockBarEl = document.getElementById('clock-bar');
    const standingsSec = document.getElementById('standings');
    const crosstableSec = document.getElementById('crosstable');
    const gamesTbody = document.getElementById('games-tbody');
    const gamesArchiveMeta = document.getElementById('games-archive-meta');
    const frame = document.getElementById('ps-viewer-frame');

    const initialViewer = ${render.safeInlineJson(viewerInit)};
    const pageInit = ${render.safeInlineJson(pageInit)} || {};

    const tournamentId = String(pageInit.tournamentId || '');
    const gamesPerMatchup = Number(pageInit.gamesPerMatchup) || 1;
    const agentLinks = pageInit.agentLinks || {};
    let status = pageInit.status || 'scheduled';
    let hasSuperfinal = Boolean(pageInit.hasSuperfinal);
    let completedGames = Number(pageInit.completedGames) || 0;
    let archiveHref = pageInit.archiveHref;
    let standings = Array.isArray(pageInit.standings) ? pageInit.standings : [];
    let crosstable = Array.isArray(pageInit.crosstable) ? pageInit.crosstable : [];
    let broadcast = pageInit.broadcast;
    let selectedTable = Number(pageInit.selectedTable) || 1;
    let mode = 'live';
    let viewerReady = false;
    let pendingPayload = initialViewer;
    let activeClock = (
      initialViewer &&
      initialViewer.live &&
      initialViewer.thinkingSlot
    )
      ? {
        slot: initialViewer.thinkingSlot,
        bankSeconds: Number(initialViewer.thinkingBankSeconds) || 0,
        syncMillis: Date.now(),
      }
      : undefined;

    const esc = s => String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

    const formatClockMmSs = seconds => {
      const s = Math.max(0, Math.round(seconds));
      const mm = String(Math.floor(s / 60)).padStart(2, '0');
      const ss = String(s % 60).padStart(2, '0');
      return mm + ':' + ss;
    };

    const resolveAgentHref = slug => {
      if (!slug) return '';
      if (Object.prototype.hasOwnProperty.call(agentLinks, slug)) return agentLinks[slug];
      return '/projects/' + encodeURIComponent(slug) + '/';
    };

    const formatAgentLink = (name, slug, bold) => {
      const inner = bold ? '<strong>' + esc(name) + '</strong>' : esc(name);
      const href = resolveAgentHref(slug);
      return href ? '<a href="' + esc(href) + '" class="subtle">' + inner + '</a>' : inner;
    };

    const speciesToSlug = species => String(species || '')
      .trim()
      .toLowerCase()
      .replace(/♀/g, '-f')
      .replace(/♂/g, '-m')
      .replace(/['’.]/g, '')
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    const parsePackedSpecies = packed => {
      if (!packed || !String(packed).trim()) return [];
      const out = [];
      for (const chunk of String(packed).split(']')) {
        if (!chunk.trim()) continue;
        const fields = chunk.split('|');
        const sp = (fields[1] && fields[1].trim()) || (fields[0] && fields[0].trim()) || '';
        if (sp) out.push(sp);
      }
      return out;
    };

    const renderPartyMinisprites = packed => {
      const list = parsePackedSpecies(packed);
      if (list.length === 0) return '';
      const spans = list.slice(0, 6).map(sp => {
        const slug = speciesToSlug(sp);
        if (!slug) return '';
        const src = 'https://www.smogon.com/forums/media/minisprites/' + slug + '.png';
        return '<span><img src="' + esc(src) + '" alt="' + esc(sp) +
          '" title="' + esc(sp) + '"></span>';
      }).join('');
      return '<span class="party-minisprites">' + spans + '</span>';
    };

    const heatmapClass = scorePct => {
      if (scorePct > 80) return 'hm-w4';
      if (scorePct > 70) return 'hm-w3';
      if (scorePct > 60) return 'hm-w2';
      if (scorePct > 50) return 'hm-w1';
      if (scorePct < 20) return 'hm-l4';
      if (scorePct < 30) return 'hm-l3';
      if (scorePct < 40) return 'hm-l2';
      if (scorePct < 50) return 'hm-l1';
      return '';
    };

    const parseLatestTurn = lines => {
      if (!Array.isArray(lines) || lines.length === 0) return undefined;
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = String(lines[i] || '');
        if (line.indexOf('|turn|') === 0) {
          const n = Number(line.slice(6).trim());
          if (Number.isInteger(n) && n >= 0) return n;
        }
      }
      return undefined;
    };

    const getTables = () =>
      (broadcast && Array.isArray(broadcast.tables)) ? broadcast.tables : [];

    const getLiveTables = () =>
      getTables().filter(tb => !tb.idle && tb.live !== false && tb.p1 && tb.p2);

    const getTable = num => getTables().find(tb => tb.table === num);

    const findLiveTableForEntrant = (liveTbs, slug, name) =>
      liveTbs.find(tb => (
        (tb.p1 && (tb.p1.slug === slug || tb.p1.name === name)) ||
        (tb.p2 && (tb.p2.slug === slug || tb.p2.name === name))
      ));

    const findLiveTableForPair = (liveTbs, a, b) =>
      liveTbs.find(tb => {
        if (!tb.p1 || !tb.p2) return false;
        const p1A = tb.p1.slug === a.slug || tb.p1.name === a.name;
        const p2B = tb.p2.slug === b.slug || tb.p2.name === b.name;
        if (p1A && p2B) return true;
        const p1B = tb.p1.slug === b.slug || tb.p1.name === b.name;
        const p2A = tb.p2.slug === a.slug || tb.p2.name === a.name;
        return p1B && p2A;
      });

    const SPEED_KEY = 'pkmn-viewer-speed';
    const VALID_SPEEDS = {slow: 1, normal: 1, fast: 1, hyperfast: 1};

    const sendToViewer = msg => {
      if (frame && frame.contentWindow) {
        frame.contentWindow.postMessage(msg, '*');
      }
    };

    const syncTheme = () => {
      const dark = document.documentElement.getAttribute('data-theme') === 'dark';
      sendToViewer({type: 'theme', dark});
    };

    const syncSpeed = () => {
      try {
        const saved = localStorage.getItem(SPEED_KEY);
        if (saved && Object.prototype.hasOwnProperty.call(VALID_SPEEDS, saved)) {
          sendToViewer({type: 'speed', speed: saved});
        }
      } catch {}
    };

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
      sendToViewer({type: 'theme', dark: e.matches});
    });

    window.addEventListener('message', ev => {
      if (!frame || ev.source !== frame.contentWindow) return;
      const data = ev.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'ready') {
        viewerReady = true;
        syncTheme();
        syncSpeed();
        if (
          pendingPayload &&
          Array.isArray(pendingPayload.lines) &&
          pendingPayload.lines.length > 0
        ) {
          sendToViewer({
            type: 'load',
            lines: pendingPayload.lines,
            live: Boolean(pendingPayload.live),
            side: pendingPayload.side || 'p1',
          });
        }
      } else if (
        data.type === 'speed' &&
        typeof data.speed === 'string' &&
        Object.prototype.hasOwnProperty.call(VALID_SPEEDS, data.speed)
      ) {
        try {
          localStorage.setItem(SPEED_KEY, data.speed);
        } catch {}
      }
    });

    const renderClockSideHtml = (slot, clock) => {
      const pillCls = clock.thinking ? 'clock-pill thinking' : 'clock-pill';
      const timeCls = clock.thinking ? 'clock-time yes' : 'clock-time';
      const subText = clock.thinking ? 'thinking…' : ('+' + clock.incrementSeconds + 's/turn');
      const rem = Math.round(clock.bankSeconds);
      const tip = clock.thinking
        ? (rem + 's remaining in 150s bank (currently thinking)')
        : (rem + 's remaining in 150s bank (+' + clock.incrementSeconds + 's/turn)');
      return '<div class="clock-side" id="clock-side-' + slot + '">' +
        '<span><tt>' + slot + '</tt> <strong id="clock-name-' + slot + '">' +
        esc(clock.name) + '</strong></span>' +
        '<span class="' + pillCls + '" id="clock-pill-' + slot + '" title="' + esc(tip) + '">' +
        '<span class="' + timeCls + '" id="clock-' + slot + '">' +
        formatClockMmSs(clock.bankSeconds) + '</span>' +
        '<span class="clock-sub" id="clock-sub-' + slot + '">' + esc(subText) + '</span>' +
        '</span></div>';
    };

    const renderClocks = (p1, p2, isLive) => {
      if (!clockBarEl) return;
      if (!p1 || !p2) {
        clockBarEl.classList.add('hide');
        clockBarEl.innerHTML = '';
        activeClock = undefined;
        return;
      }
      clockBarEl.classList.remove('hide');
      clockBarEl.innerHTML = renderClockSideHtml('p1', p1) + renderClockSideHtml('p2', p2);
      if (isLive && (p1.thinking || p2.thinking)) {
        const slot = p1.thinking ? 'p1' : 'p2';
        const bank = slot === 'p1' ? p1.bankSeconds : p2.bankSeconds;
        activeClock = {slot, bankSeconds: Number(bank) || 0, syncMillis: Date.now()};
      } else {
        activeClock = undefined;
      }
    };

    const renderTableNav = () => {
      if (!tableNavWrap) return;
      const tables = getTables();
      if (tables.length === 0) {
        tableNavWrap.innerHTML = '';
        return;
      }
      const items = tables.map((tb, idx) => {
        const sep = idx > 0 ? '\\n        —\\n        ' : '';
        const checked = (mode === 'live' && tb.table === selectedTable) ? ' checked' : '';
        const tbId = 'tb-' + esc(tournamentId) + '-' + tb.table;
        const labelHtml = tb.idle
          ? (esc(tb.label) + ' <span class="muted">(idle)</span>')
          : esc(tb.label);
        return sep + '<li><input type="radio" name="table-' + esc(tournamentId) +
          '" id="' + tbId + '" value="' + tb.table + '" data-table-num="' +
          tb.table + '"' + checked + '><label for="' + tbId + '">' + labelHtml + '</label></li>';
      }).join('');
      tableNavWrap.innerHTML = '<nav class="subnav" aria-label="Broadcast table"><ul>' +
        items + '</ul></nav>';
    };

    const renderSeriesRightForTable = tb => {
      const base = (tb && tb.seriesRightHtml) ? tb.seriesRightHtml : '<span class="muted">—</span>';
      if (tb && (tb.idle || tb.live === false)) {
        const other = getLiveTables().find(x => x.table !== tb.table);
        if (other) {
          return base + ' · <a href="#live" class="live-pill" data-live-table="' +
            other.table + '">&#9679; Watch T' + other.table + '</a>';
        }
      }
      return base;
    };

    const showLiveTable = (tableNum, scroll) => {
      const tables = getTables();
      if (tables.length === 0 || !liveSec) return;
      const tb = getTable(tableNum) || tables[0];
      if (!tb) return;
      mode = 'live';
      selectedTable = tb.table;
      liveSec.classList.remove('hide');
      renderTableNav();
      if (seriesLeftEl) {
        seriesLeftEl.innerHTML = tb.seriesLeftHtml || esc(tb.label);
      }
      if (seriesRightEl) {
        seriesRightEl.innerHTML = renderSeriesRightForTable(tb);
      }
      if (!tb.idle && tb.p1 && tb.p2) {
        renderClocks(tb.p1, tb.p2, tb.live !== false);
      } else {
        renderClocks(undefined, undefined, false);
      }
      const lines = Array.isArray(tb.lines) ? tb.lines : [];
      const isLive = !tb.idle && tb.live !== false;
      pendingPayload = {lines, live: isLive, side: 'p1'};
      if (viewerReady) {
        sendToViewer({type: 'load', lines, live: isLive, side: 'p1'});
      }
      if (scroll) {
        liveSec.scrollIntoView({behavior: 'smooth'});
      }
    };

    const refreshReplayHeaderRight = () => {
      if (mode !== 'replay' || !seriesRightEl) return;
      if (getLiveTables().length > 0) {
        seriesRightEl.innerHTML =
          '<a href="#live" class="live-pill" data-return-live="1">&#9679; Return to Live</a>';
      } else {
        seriesRightEl.innerHTML = '<span class="muted">Completed game</span>';
      }
    };

    const pageSize = 25;
    let standingsPage = 1;
    let gamesPage = 1;

    const renderStandings = () => {
      const bodyEl = document.getElementById('standings-body');
      if (!bodyEl || !Array.isArray(standings) || standings.length === 0) return;
      const total = standings.length;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      if (standingsPage > totalPages) standingsPage = totalPages;
      if (standingsPage < 1) standingsPage = 1;
      const start = (standingsPage - 1) * pageSize;
      const liveTbs = getLiveTables();
      const maxRrGames = Math.max(1, (standings.length - 1) * gamesPerMatchup);
      const rows = standings.map((e, idx) => {
        const rankNum = e.rank || (idx + 1);
        const sfBadge = (hasSuperfinal && rankNum <= 2) ? ' <span class="muted">SF</span>' : '';
        const liveTb = findLiveTableForEntrant(liveTbs, e.slug, e.name);
        const liveBadge = liveTb
          ? ' <a href="#live" class="live-pill" data-live-table="' + liveTb.table +
            '" title="Spectate live on ' + esc(liveTb.label) + '">&#9679; T' +
            liveTb.table + '</a>'
          : '';
        const agentHtml = formatAgentLink(e.name, e.slug, true) +
          ' <code>' + esc(e.version) + '</code>' + liveBadge;
        const elo = Math.round(e.elo);
        const ci = Math.round(e.ci95);
        const ptsStr = Number(e.points || 0).toFixed(1);
        const sbStr = Math.round(e.sonnebornBerger || 0).toLocaleString('en-US');
        const hideAttr = (idx < start || idx >= start + pageSize) ? ' class="hide"' : '';
        return '<tr' + hideAttr + '>' +
          '<td><strong>' + rankNum + '</strong>' + sfBadge + '</td>' +
          '<td>' + agentHtml + '</td>' +
          '<td class="num"><strong>' + elo +
          '</strong> <span class="muted">±' + ci + '</span></td>' +
          '<td class="num">' + e.wins + '–' + e.losses + '–' + e.ties + '</td>' +
          '<td class="num"><strong>' + ptsStr + '</strong> <span class="muted">/ ' +
          maxRrGames + '</span></td>' +
          '<td class="num">' + sbStr + '</td>' +
          '</tr>';
      }).join('');

      const ptsTitle = 'Round-Robin points out of ' + maxRrGames +
        ' games (+1.0 per win, +0.5 per tie)';
      const hideCls = totalPages <= 1 ? ' hide' : '';
      const prevDis = standingsPage <= 1 ? ' disabled' : '';
      const nextDis = standingsPage >= totalPages ? ' disabled' : '';
      const word = total === 1 ? 'entrant' : 'entrants';
      const info = 'Page ' + standingsPage + ' of ' + totalPages +
        ' (' + total.toLocaleString('en-US') + ' ' + word + ')';
      bodyEl.innerHTML = '<div class="table-wrap"><table><thead><tr>' +
        '<th>#</th><th>Agent</th>' +
        '<th class="num" title="Tournament MAP Elo ± 95% CI">Elo</th>' +
        '<th class="num" title="Standalone individual BYOT game Wins – Losses – Ties">W–L–T</th>' +
        '<th class="num" title="' + esc(ptsTitle) + '">Points</th>' +
        '<th class="num" title="Sonneborn-Berger tiebreak score">S–B</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '<div class="pager' + hideCls +
        '" id="standings-pager" aria-label="Standings pagination" ' +
        'data-table-pager data-page-size="25" data-singular="entrant" data-plural="entrants">' +
        '<button type="button" class="pager-btn" id="standings-pager-prev" ' +
        'data-pager-prev' + prevDis + '>&larr; Prev</button>' +
        '<span class="pager-info muted" id="standings-pager-info" data-pager-info>' +
        esc(info) + '</span>' +
        '<button type="button" class="pager-btn" id="standings-pager-next" ' +
        'data-pager-next' + nextDis + '>Next &rarr;</button></div>';
    };

    const renderCrosstable = () => {
      const bodyEl = document.getElementById('crosstable-body');
      if (!bodyEl || !crosstableSec) return;
      const rrPairs = Array.isArray(crosstable)
        ? crosstable.filter(p => p.stage !== 'Superfinal')
        : [];
      const rrLiveTbs = getLiveTables().filter(tb => tb.stage !== 'Superfinal');
      const order = standings.length >= 2 ? standings : (pageInit.entrants || []);
      if (order.length < 2 || (rrPairs.length === 0 && rrLiveTbs.length === 0)) {
        crosstableSec.classList.add('hide');
        bodyEl.innerHTML = '<p class="empty-state muted">No round-robin games completed yet.</p>';
        return;
      }

      crosstableSec.classList.remove('hide');
      const pairMap = new Map();
      for (const p of rrPairs) {
        pairMap.set(p.lowVersionId + ':' + p.highVersionId, p);
      }

      const colHeaders = order.map(e => '<th>' + esc(e.name) + '</th>').join('');
      const bodyRows = order.map(rowEnt => {
        const rowLabel = formatAgentLink(rowEnt.name, rowEnt.slug, true) +
          ' <code>' + esc(rowEnt.version) + '</code>';
        const cells = order.map(colEnt => {
          if (rowEnt.versionId === colEnt.versionId) {
            return '<td class="diag">—</td>';
          }
          const liveTb = findLiveTableForPair(
            rrLiveTbs,
            {slug: rowEnt.slug, name: rowEnt.name},
            {slug: colEnt.slug, name: colEnt.name}
          );
          const livePill = liveTb
            ? '<a href="#live" class="live-pill" data-live-table="' + liveTb.table +
              '" title="Spectate live on ' + esc(liveTb.label) + '">&#9679; T' +
              liveTb.table + '</a>'
            : '';

          const lowId = Math.min(rowEnt.versionId, colEnt.versionId);
          const highId = Math.max(rowEnt.versionId, colEnt.versionId);
          const pair = pairMap.get(lowId + ':' + highId);
          const isLow = rowEnt.versionId === lowId;
          const wins = pair ? (isLow ? pair.lowWins : pair.highWins) : 0;
          const losses = pair ? (isLow ? pair.highWins : pair.lowWins) : 0;
          const ties = pair ? pair.ties : 0;
          const total = wins + losses + ties;

          if (total === 0) {
            return livePill
              ? '<td class="center">' + livePill + '</td>'
              : '<td class="muted">—</td>';
          }

          const pts = wins + 0.5 * ties;
          const scorePct = (pts / total) * 100;
          const scoreStr = scorePct.toFixed(1) + '%';
          const scoreHtml = scorePct > 50 ? '<strong>' + scoreStr + '</strong>' : scoreStr;
          const cls = heatmapClass(scorePct);
          const clsAttr = cls ? ' class="' + cls + '"' : '';
          const tip = pts.toFixed(1) + ' / ' + total + ' pts';
          const subInner = livePill
            ? (wins + '–' + losses + '–' + ties + ' · ' + livePill)
            : (wins + '–' + losses + '–' + ties);
          return '<td' + clsAttr + ' title="' + esc(tip) + '">' + scoreHtml +
            '<span class="sub">' + subInner + '</span></td>';
        }).join('');
        return '<tr><td>' + rowLabel + '</td>' + cells + '</tr>';
      }).join('');

      bodyEl.innerHTML = '<div class="table-wrap"><table class="matrix"><thead><tr>' +
        '<th>&nbsp;</th>' + colHeaders +
        '</tr></thead><tbody>' + bodyRows + '</tbody></table></div>';
    };

    const buildLiveGameRowEl = tb => {
      const p1 = tb.p1;
      const p2 = tb.p2;
      const codePrefix = tb.stage === 'Superfinal' ? 'SF' : 'RR';
      const codeNum = tb.stage === 'Superfinal' ? (tb.matchupGame || 1) : (tb.cycle || 1);
      const gameCode = codePrefix + codeNum;
      const p1Cell = '<div class="player-cell">' +
        formatAgentLink(p1.name, p1.slug, false) +
        renderPartyMinisprites(p1.team) + '</div>';
      const p2Cell = '<div class="player-cell">' +
        formatAgentLink(p2.name, p2.slug, false) +
        renderPartyMinisprites(p2.team) + '</div>';
      const turn = parseLatestTurn(tb.lines);
      const turnsStr = turn !== undefined ? String(turn) : '—';
      const b1 = Math.round(p1.bankSeconds);
      const b2 = Math.round(p2.bankSeconds);
      const tip = 'Spectate live on ' + tb.label;

      const tr = document.createElement('tr');
      tr.className = 'live-game-row';
      tr.setAttribute('data-live-game-table', String(tb.table));
      tr.innerHTML =
        '<td><a href="#live" class="subtle" data-live-table="' + tb.table +
          '" title="' + esc(tip) + '"><code>' + esc(gameCode) + '</code></a></td>' +
        '<td>' + p1Cell + '</td>' +
        '<td>' + p2Cell + '</td>' +
        '<td class="center"><a href="#live" class="live-pill" data-live-table="' + tb.table +
          '" title="' + esc(tip) + '">&#9679; T' + tb.table + '</a></td>' +
        '<td class="num" data-live-turns>' + turnsStr + '</td>' +
        '<td class="num" data-live-banks>' + b1 + 's / ' + b2 + 's</td>';
      return tr;
    };

    const buildCompletedGameRowEl = g => {
      const codePrefix = g.stage === 'Superfinal' ? 'SF' : 'RR';
      const codeNum = g.stage === 'Superfinal' ? g.matchupGame : g.cycle;
      const gameCode = codePrefix + codeNum;
      const hasLog = Boolean(g.logHref);
      const gameHref = hasLog ? g.logHref : '#games';
      const replayAttr = hasLog ? ' data-replay-log="' + esc(g.logHref) + '"' : '';

      const p1Won = g.outcome === 'W';
      const p2Won = g.outcome === 'L';
      const resHtml = p1Won
        ? '<strong>1</strong>–0'
        : p2Won
          ? '0–<strong>1</strong>'
          : '½–½';

      const p1Cell = '<div class="player-cell">' +
        formatAgentLink(g.p1.name, g.p1.slug, p1Won) +
        renderPartyMinisprites(g.p1.team) + '</div>';
      const p2Cell = '<div class="player-cell">' +
        formatAgentLink(g.p2.name, g.p2.slug, p2Won) +
        renderPartyMinisprites(g.p2.team) + '</div>';

      const turnsStr = g.turns !== undefined ? String(g.turns) : '—';
      const b1 = Math.round(g.p1.bankSeconds || 0);
      const b2 = Math.round(g.p2.bankSeconds || 0);

      const tr = document.createElement('tr');
      tr.setAttribute('data-game-id', g.id);
      tr.innerHTML =
        '<td><a href="' + esc(gameHref) + '" class="subtle"' + replayAttr +
          ' title="' + esc(g.id) + '"><code>' + esc(gameCode) + '</code></a></td>' +
        '<td>' + p1Cell + '</td>' +
        '<td>' + p2Cell + '</td>' +
        '<td class="center">' + resHtml + '</td>' +
        '<td class="num">' + turnsStr + '</td>' +
        '<td class="num">' + b1 + 's / ' + b2 + 's</td>';
      return tr;
    };

    const applyGamesPager = () => {
      if (!gamesTbody) return;
      const rows = Array.from(gamesTbody.querySelectorAll('tr:not(.empty-row)'));
      const total = rows.length;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      if (gamesPage > totalPages) gamesPage = totalPages;
      if (gamesPage < 1) gamesPage = 1;
      const start = (gamesPage - 1) * pageSize;
      rows.forEach((row, idx) => {
        row.classList.toggle('hide', idx < start || idx >= start + pageSize);
      });
      const pager = document.getElementById('games-pager');
      const prevBtn = document.getElementById('games-pager-prev');
      const nextBtn = document.getElementById('games-pager-next');
      const infoEl = document.getElementById('games-pager-info');
      if (pager && prevBtn && nextBtn && infoEl) {
        pager.classList.toggle('hide', totalPages <= 1);
        prevBtn.disabled = gamesPage <= 1;
        nextBtn.disabled = gamesPage >= totalPages;
        const word = total === 1 ? 'game' : 'games';
        infoEl.textContent =
          'Page ' + gamesPage + ' of ' + totalPages +
          ' (' + total.toLocaleString('en-US') + ' ' + word + ')';
      }
    };

    const syncLiveGameRows = () => {
      if (!gamesTbody) return;
      gamesTbody.querySelectorAll('tr.live-game-row').forEach(el => el.remove());
      const liveTbs = getLiveTables();
      if (liveTbs.length > 0) {
        const emptyRow = gamesTbody.querySelector('.empty-row');
        if (emptyRow) emptyRow.remove();
        const frag = document.createDocumentFragment();
        for (const tb of liveTbs) {
          frag.appendChild(buildLiveGameRowEl(tb));
        }
        gamesTbody.insertBefore(frag, gamesTbody.firstChild);
      } else if (gamesTbody.children.length === 0) {
        gamesTbody.innerHTML = '<tr class="empty-row"><td colspan="6" class="center muted">' +
          'No completed games yet.</td></tr>';
      }
      applyGamesPager();
    };

    const prependCompletedGameRow = g => {
      if (!gamesTbody || !g || !g.id) return;
      let existing = null;
      gamesTbody.querySelectorAll('tr[data-game-id]').forEach(row => {
        if (row.getAttribute('data-game-id') === g.id) existing = row;
      });
      if (existing) {
        if (g.logHref) {
          const link = existing.querySelector('td a');
          if (link && !link.getAttribute('data-replay-log')) {
            link.setAttribute('href', g.logHref);
            link.setAttribute('data-replay-log', g.logHref);
          }
        }
        return;
      }
      const emptyRow = gamesTbody.querySelector('.empty-row');
      if (emptyRow) emptyRow.remove();
      const tr = buildCompletedGameRowEl(g);
      let anchor = gamesTbody.firstElementChild;
      while (anchor && anchor.classList.contains('live-game-row')) {
        anchor = anchor.nextElementSibling;
      }
      gamesTbody.insertBefore(tr, anchor);
      applyGamesPager();
    };

    const renderArchiveMeta = () => {
      if (!gamesArchiveMeta) return;
      const jsonHref = '/arena/tournaments/' + encodeURIComponent(tournamentId) + '/index.json';
      const countStr = completedGames.toLocaleString('en-US');
      if (archiveHref) {
        const parts = archiveHref.split('/');
        const archiveName = decodeURIComponent(
          parts[parts.length - 1] || (tournamentId + '-replays.7z')
        );
        gamesArchiveMeta.innerHTML = 'Archive: <a href="' + esc(archiveHref) + '"><code>' +
          esc(archiveName) + '</code></a> (<span id="games-count">' + countStr +
          '</span> games) · <a href="' + esc(jsonHref) + '"><code>index.json</code></a>';
      } else {
        gamesArchiveMeta.innerHTML = 'Data: <a href="' + esc(jsonHref) +
          '"><code>index.json</code></a> (<span id="games-count">' + countStr + '</span> games' +
          (status !== 'completed' ? '; replay archive published upon completion' : '') + ')';
      }
    };

    if (tableNavWrap) {
      tableNavWrap.addEventListener('change', ev => {
        const target = ev.target instanceof Element ? ev.target : undefined;
        const radio = target ? target.closest('input[data-table-num]') : undefined;
        if (!radio) return;
        const num = Number(radio.getAttribute('data-table-num')) || 1;
        showLiveTable(num, false);
      });
    }

    document.addEventListener('click', async ev => {
      const target = ev.target instanceof Element ? ev.target : undefined;
      if (!target) return;
      if (target.closest('#standings-pager-prev')) {
        if (standingsPage > 1) {
          standingsPage--;
          renderStandings();
        }
        return;
      }
      if (target.closest('#standings-pager-next')) {
        standingsPage++;
        renderStandings();
        return;
      }
      if (target.closest('#games-pager-prev')) {
        if (gamesPage > 1) {
          gamesPage--;
          applyGamesPager();
        }
        return;
      }
      if (target.closest('#games-pager-next')) {
        gamesPage++;
        applyGamesPager();
        return;
      }
      const liveBtn = target.closest('[data-live-table]');
      if (liveBtn) {
        ev.preventDefault();
        const num = Number(liveBtn.getAttribute('data-live-table')) || 1;
        showLiveTable(num, true);
        return;
      }

      const returnBtn = target.closest('[data-return-live]');
      if (returnBtn) {
        ev.preventDefault();
        const cur = getTable(selectedTable);
        const liveTbs = getLiveTables();
        const nextNum = (cur && !cur.idle && cur.live !== false)
          ? selectedTable
          : (liveTbs[0] ? liveTbs[0].table : selectedTable);
        showLiveTable(nextNum, false);
        return;
      }

      const replayLink = target.closest('a[data-replay-log]');
      if (replayLink) {
        const logUrl = replayLink.getAttribute('data-replay-log');
        if (!logUrl || !frame || !liveSec) return;
        ev.preventDefault();
        try {
          const res = await fetch(logUrl);
          if (!res.ok) return;
          const text = await res.text();
          const lines = text.split('\\n');
          mode = 'replay';
          renderClocks(undefined, undefined, false);
          renderTableNav();
          liveSec.classList.remove('hide');
          if (seriesLeftEl) {
            seriesLeftEl.innerHTML = '<strong>Replay</strong> · <code>' +
              esc(replayLink.textContent || '') + '</code>';
          }
          refreshReplayHeaderRight();
          pendingPayload = {lines, live: false, side: 'p1'};
          if (viewerReady) {
            sendToViewer({type: 'load', lines, live: false, side: 'p1'});
          }
          liveSec.scrollIntoView({behavior: 'smooth'});
        } catch {}
      }
    });

    setInterval(() => {
      if (mode !== 'live' || !activeClock) return;
      const clockEl = document.getElementById('clock-' + activeClock.slot);
      if (!clockEl) return;
      const elapsed = Math.floor((Date.now() - activeClock.syncMillis) / 1000);
      const rem = Math.max(0, Math.round(activeClock.bankSeconds - elapsed));
      clockEl.textContent = formatClockMmSs(rem);
    }, 1000);

    if (eventSelect) {
      eventSelect.addEventListener('change', () => {
        if (eventSelect.value) {
          window.location.href = eventSelect.value;
        }
      });
    }

    if (typeof EventSource !== 'undefined' && tournamentId && status !== 'completed') {
      const es = new EventSource(
        '/api/tournaments/' + encodeURIComponent(tournamentId) + '/stream'
      );

      es.addEventListener('snapshot', ev => {
        try {
          const doc = JSON.parse(ev.data);
          if (!doc) return;
          status = doc.status || status;
          completedGames = Number(doc.completedGames) || 0;
          archiveHref = doc.archiveHref;
          if (Array.isArray(doc.standings)) standings = doc.standings;
          if (Array.isArray(doc.crosstable)) crosstable = doc.crosstable;
          broadcast = doc.broadcast;
          if (
            crosstable.some(c => c.stage === 'Superfinal') ||
            (Array.isArray(doc.games) && doc.games.some(g => g.stage === 'Superfinal')) ||
            getLiveTables().some(tb => tb.stage === 'Superfinal')
          ) {
            hasSuperfinal = true;
          }
          if (Array.isArray(doc.games)) {
            for (let i = doc.games.length - 1; i >= 0; i--) {
              prependCompletedGameRow(doc.games[i]);
            }
          }
          syncLiveGameRows();
          renderArchiveMeta();
          renderStandings();
          renderCrosstable();

          if (broadcast && getTables().length > 0) {
            if (mode === 'live') {
              const cur = getTable(selectedTable);
              const liveTbs = getLiveTables();
              const targetNum = (cur && !cur.idle && cur.live !== false)
                ? selectedTable
                : (liveTbs[0] ? liveTbs[0].table : getTables()[0].table);
              showLiveTable(targetNum, false);
            } else {
              renderTableNav();
              refreshReplayHeaderRight();
            }
          } else if (mode === 'live' && liveSec) {
            liveSec.classList.add('hide');
            renderClocks(undefined, undefined, false);
          }

          if (status === 'completed' && !broadcast) {
            es.close();
          }
        } catch {}
      });

      es.addEventListener('broadcast', ev => {
        try {
          broadcast = JSON.parse(ev.data);
          if (getLiveTables().some(tb => tb.stage === 'Superfinal')) hasSuperfinal = true;
          syncLiveGameRows();
          renderStandings();
          renderCrosstable();
          if (mode === 'live') {
            const cur = getTable(selectedTable);
            const liveTbs = getLiveTables();
            const targetNum = (cur && !cur.idle && cur.live !== false)
              ? selectedTable
              : (liveTbs[0] ? liveTbs[0].table : (getTables()[0] ? getTables()[0].table : 1));
            showLiveTable(targetNum, false);
          } else {
            renderTableNav();
            refreshReplayHeaderRight();
          }
        } catch {}
      });

      es.addEventListener('table-load', ev => {
        try {
          const data = JSON.parse(ev.data);
          if (!data) return;
          if (data.broadcast) broadcast = data.broadcast;
          const loaded = data.table;
          if (loaded && loaded.stage === 'Superfinal') hasSuperfinal = true;
          syncLiveGameRows();
          renderStandings();
          renderCrosstable();
          if (mode === 'live') {
            const cur = getTable(selectedTable);
            const wasHidden = !liveSec || liveSec.classList.contains('hide');
            const curInactive = !cur || cur.idle || cur.live === false;
            if (loaded && (loaded.table === selectedTable || wasHidden || curInactive)) {
              showLiveTable(loaded.table, false);
            } else {
              renderTableNav();
            }
          } else {
            renderTableNav();
            refreshReplayHeaderRight();
          }
        } catch {}
      });

      es.addEventListener('table-append', ev => {
        try {
          const data = JSON.parse(ev.data);
          if (!data || !broadcast || !Array.isArray(broadcast.tables)) return;
          const tb = getTable(data.table);
          if (!tb) return;
          const newLines = Array.isArray(data.lines) ? data.lines : [];
          tb.lines = (Array.isArray(tb.lines) ? tb.lines : []).concat(newLines).slice(-10000);
          if (data.p1) tb.p1 = data.p1;
          if (data.p2) tb.p2 = data.p2;
          if (typeof data.live === 'boolean') tb.live = data.live;
          if (data.updatedAt) tb.updatedAt = data.updatedAt;

          if (gamesTbody) {
            const liveRow = gamesTbody.querySelector(
              'tr.live-game-row[data-live-game-table="' + tb.table + '"]'
            );
            if (liveRow) {
              const turn = parseLatestTurn(tb.lines);
              const turnsTd = liveRow.querySelector('[data-live-turns]') || liveRow.children[4];
              const banksTd = liveRow.querySelector('[data-live-banks]') || liveRow.children[5];
              if (turnsTd && turn !== undefined) turnsTd.textContent = String(turn);
              if (banksTd && tb.p1 && tb.p2) {
                banksTd.textContent =
                  Math.round(tb.p1.bankSeconds) + 's / ' + Math.round(tb.p2.bankSeconds) + 's';
              }
            }
          }

          if (mode === 'live' && tb.table === selectedTable) {
            if (tb.p1 && tb.p2) {
              renderClocks(tb.p1, tb.p2, tb.live !== false);
            }
            if (pendingPayload && Array.isArray(pendingPayload.lines)) {
              pendingPayload.lines = tb.lines;
              pendingPayload.live = tb.live !== false;
            }
            if (viewerReady && newLines.length > 0) {
              sendToViewer({type: 'append', lines: newLines});
            }
          }
        } catch {}
      });

      es.addEventListener('table-idle', ev => {
        try {
          const data = JSON.parse(ev.data);
          if (!data) return;
          if (data.broadcast) broadcast = data.broadcast;
          syncLiveGameRows();
          renderStandings();
          renderCrosstable();
          renderTableNav();
          if (mode === 'live' && data.table === selectedTable) {
            renderClocks(undefined, undefined, false);
            const tb = getTable(selectedTable);
            if (seriesRightEl && tb) {
              seriesRightEl.innerHTML = renderSeriesRightForTable(tb);
            }
          } else if (mode === 'replay') {
            refreshReplayHeaderRight();
          }
        } catch {}
      });

      es.addEventListener('broadcast-end', () => {
        broadcast = undefined;
        renderClocks(undefined, undefined, false);
        syncLiveGameRows();
        renderStandings();
        renderCrosstable();
        renderTableNav();
        refreshReplayHeaderRight();
      });

      es.addEventListener('game-complete', ev => {
        try {
          const data = JSON.parse(ev.data);
          if (!data) return;
          if (data.status) status = data.status;
          if (data.completedGames !== undefined) completedGames = Number(data.completedGames) || 0;
          if (data.archiveHref !== undefined) archiveHref = data.archiveHref;
          if (Array.isArray(data.standings)) standings = data.standings;
          if (Array.isArray(data.crosstable)) crosstable = data.crosstable;
          broadcast = data.broadcast;
          if (data.game && data.game.stage === 'Superfinal') hasSuperfinal = true;

          syncLiveGameRows();
          if (data.game) {
            prependCompletedGameRow(data.game);
          }
          renderArchiveMeta();
          renderStandings();
          renderCrosstable();
          renderTableNav();

          if (mode === 'live') {
            const tb = getTable(selectedTable);
            if (tb && tb.p1 && tb.p2 && !tb.idle) {
              renderClocks(tb.p1, tb.p2, tb.live !== false);
              if (seriesRightEl) {
                seriesRightEl.innerHTML = renderSeriesRightForTable(tb);
              }
            } else {
              renderClocks(undefined, undefined, false);
            }
          } else {
            refreshReplayHeaderRight();
          }

          if (status === 'completed' && !broadcast) {
            es.close();
          }
        } catch {}
      });

      es.addEventListener('status', ev => {
        try {
          const data = JSON.parse(ev.data);
          if (!data) return;
          if (data.status) status = data.status;
          if (data.archiveHref !== undefined) archiveHref = data.archiveHref;
          renderArchiveMeta();
          if (status === 'completed' && !broadcast) {
            es.close();
          }
        } catch {}
      });
    }
  });
`;
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
  const entrants = db.getTournamentEntrants(t.id);
  const games = db.getTournamentGames(t.id, 10_000);
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
    ? `Starts ${formatUtcDateTime(t.startsAt)} · Entries close ${formatUtcDateTime(closesAt)}`
    : t.completedAt
      ? `Started ${formatUtcDate(t.startsAt)} · Completed ${formatUtcDate(t.completedAt)}`
      : `Started ${formatUtcDateTime(t.startsAt)}`;

  const standingsNode = renderTournamentStandingsNode({
    tournament: t,
    entrants,
    hasSuperfinal: hasSf,
    liveTables,
    publicDir,
    projectMeta,
    profileSlugs,
  });
  const crossRes = renderTournamentCrosstableNode({
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

  const gamesNode = renderTournamentGamesNode({
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

  const content = (
    <>
      <div className='event-bar'>
        <select id='event-select' className='min-select' aria-label='Tournament event'>
          {allTournaments.map(other => {
            const href = `/arena/tournaments/${encodeURIComponent(other.id)}/`;
            return (
              <option value={href} selected={other.id === t.id}>
                {other.name}
              </option>
            );
          })}
        </select>
      </div>

      <p className='meta'>
        <tt>{fmtTitle}</tt> · {n} Entrants · <tt>G={t.gamesPerMatchup}</tt> Double Round-Robin (
        {rrTotal.toLocaleString('en-US')} games){sfSuffix}<br />
        {scheduleLine}<br />
        {t.hardware} · <tt>150s</tt> bank (<tt>+{inc}s/turn</tt>)
      </p>

      {renderTournamentRulesNode(staticDir, t.id)}

      <section id='live' className={broadcastRes.isActive ? undefined : 'hide'}>
        {broadcastRes.node}
      </section>

      <section id='standings'>
        <h3><a href='#standings' className='subtle'>Standings</a></h3>
        {standingsNode}
      </section>

      <section id='crosstable' className={crossRes.isEmpty ? 'hide' : undefined}>
        <h3><a href='#crosstable' className='subtle'>Crosstable</a></h3>
        {crossRes.node}
      </section>

      <section id='games'>
        <h3><a href='#games' className='subtle'>Games</a></h3>
        {gamesNode}
      </section>

      <script>{buildTournamentScript(broadcastRes.viewerInit, pageInit)}</script>
    </>
  );

  const pageHeader = injectLiveBanner(
    header(<a href='/arena/' className='subtle'>Tournaments</a>),
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
