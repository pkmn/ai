import * as fs from 'fs';
import * as path from 'path';

import * as site from 'site';

import type * as db from '../db';
import {Renderer, header, injectLiveBanner} from '../static/build';
import * as util from '../static/util';

import * as arena from './arena';
import * as render from './render';

export type LiveBroadcast = arena.LiveBroadcast;

const TOURNAMENTS_STYLE = fs.readFileSync(util.root('static', 'style', 'tournaments.css'), 'utf8');
const VIEWER_STYLE = fs.readFileSync(util.root('static', 'style', 'viewer.css'), 'utf8');

const VIEWER_SCRIPT = `
  (() => {
    'use strict';

    const makeMemStorage = () => {
      const m = new Map();
      return {
        get length() { return m.size; },
        key: i => Array.from(m.keys())[i] ?? null,
        getItem: k => (m.has(String(k)) ? m.get(String(k)) : null),
        setItem: (k, v) => { m.set(String(k), String(v)); },
        removeItem: k => { m.delete(String(k)); },
        clear: () => { m.clear(); },
      };
    };
    for (const prop of ['localStorage', 'sessionStorage']) {
      try {
        void window[prop];
      } catch {
        Object.defineProperty(window, prop, {value: makeMemStorage(), configurable: true});
      }
    }
    try {
      void document.cookie;
    } catch {
      let jar = '';
      Object.defineProperty(document, 'cookie', {
        get: () => jar,
        set: v => { jar = String(v); },
        configurable: true,
      });
    }

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
    const ASSET_TIMEOUT_MILLIS = 4000;
    const appOrigin = new URL(location.href).origin;
    const externalNodes = [];

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
    let offline = false;
    let offlineEnded = false;
    let offlineTurn = 0;
    let live = false;
    let muted = true;
    let controlsBound = false;
    let sideLines = {p1: [], p2: []};
    let sidePokemon = {p1: null, p2: null};
    let currentSide = 'p1';

    const escLog = str => String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    const formatIdent = rawIdent => {
      const s = String(rawIdent || '').trim();
      const colon = s.indexOf(':');
      if (colon < 0) return escLog(s);
      const slot = s.slice(0, colon).trim();
      const nick = s.slice(colon + 1).trim();
      return '<tt>' + escLog(slot) + '</tt> ' + escLog(nick);
    };

    const renderOfflineLog = lines => {
      let turn = 0;
      let ended = false;
      const rows = [];
      for (const line of lines) {
        if (!line || line[0] !== '|') continue;
        const parts = line.split('|');
        const cmd = parts[1] || '';
        if (cmd === 'turn') {
          const n = Number(parts[2]);
          if (Number.isInteger(n) && n >= 0) turn = n;
          rows.push('<h2 class="battle-history">Turn ' + escLog(parts[2]) + '</h2>');
        } else if (cmd === 'tier' && parts[2]) {
          rows.push('<div class="battle-history"><strong>' + escLog(parts[2]) + '</strong></div>');
        } else if (cmd === 'player' && parts[2] && parts[3]) {
          rows.push(
            '<div class="battle-history"><tt>' + escLog(parts[2]) + '</tt> <strong>' +
            escLog(parts[3]) + '</strong></div>'
          );
        } else if (cmd === 'poke' && parts[2] && parts[3]) {
          const species = parts[3].split(',')[0].trim();
          rows.push(
            '<div class="battle-history"><em><tt>' + escLog(parts[2]) + '</tt> ' +
            escLog(species) + '</em></div>'
          );
        } else if ((cmd === 'switch' || cmd === 'drag' || cmd === 'replace') && parts[2]) {
          const species = (parts[3] || '').split(',')[0].trim();
          const hp = (parts[4] || '').trim();
          rows.push(
            '<div class="battle-history">' + formatIdent(parts[2]) +
            (species ? ' — <strong>' + escLog(species) + '</strong>' : '') +
            (hp ? ' <em>(' + escLog(hp) + ')</em>' : '') + '</div>'
          );
        } else if (cmd === 'move' && parts[2] && parts[3]) {
          const target = (parts[4] || '').trim();
          rows.push(
            '<div class="battle-history">' + formatIdent(parts[2]) +
            ' used <strong>' + escLog(parts[3]) + '</strong>' +
            (target && target !== parts[2] ? ' on ' + formatIdent(target) : '') + '!</div>'
          );
        } else if ((cmd === '-damage' || cmd === '-heal') && parts[2] && parts[3]) {
          rows.push(
            '<div class="battle-history"><em>(' + formatIdent(parts[2]) + ': ' +
            escLog(parts[3]) + ')</em></div>'
          );
        } else if (cmd === 'faint' && parts[2]) {
          rows.push(
            '<div class="battle-history"><strong>' + formatIdent(parts[2]) +
            ' fainted!</strong></div>'
          );
        } else if (cmd === 'win' && parts[2]) {
          ended = true;
          rows.push(
            '<div class="battle-history"><strong>' + escLog(parts[2]) +
            ' won the battle!</strong></div>'
          );
        } else if (cmd === 'tie') {
          ended = true;
          rows.push('<div class="battle-history"><strong>Tie between players!</strong></div>');
        }
      }
      offlineTurn = turn;
      offlineEnded = ended;
      el.log.innerHTML = rows.length ? '<div class="inner">' + rows.join('') + '</div>' : '';
      el.log.scrollTop = live ? el.log.scrollHeight : 0;
    };

    const readable = line => !line.startsWith('|request|');

    const ownPokemon = requested => {
      const pokemon = {...requested};
      const name = pokemon.ident.slice(pokemon.ident.indexOf(':') + 1).trim();
      battle.parseDetails(name, pokemon.ident, pokemon.details, pokemon);
      battle.parseHealth(pokemon.condition, pokemon);
      return pokemon;
    };

    const applyTeam = () => {
      if (!battle) return;
      const list = sidePokemon[currentSide];
      battle.myPokemon = Array.isArray(list) ? list.map(ownPokemon) : null;
    };

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
      externalNodes.push(link);
      const styleAnchor = document.getElementById('viewer-style');
      document.head.insertBefore(link, styleAnchor);
    };

    const loadScript = scriptPath => new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = ASSETS + scriptPath;
      script.async = false;
      externalNodes.push(script);
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        script.remove();
        reject(new Error('Timed out loading ' + scriptPath));
      }, ASSET_TIMEOUT_MILLIS);
      script.onload = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      script.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        script.remove();
        reject(new Error('Could not load ' + scriptPath));
      };
      document.head.appendChild(script);
    });

    const clearExternalNodes = () => {
      while (externalNodes.length > 0) {
        const node = externalNodes.pop();
        if (node && node.parentNode) node.parentNode.removeChild(node);
      }
    };

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
      try {
        if (window.BattleSound) window.BattleSound.setMute(muted);
      } catch {}
      if (battle) battle.setMute(muted);
      el.sound.setAttribute('aria-pressed', String(!muted));
      el.sound.title = muted ? 'Sound is off' : 'Sound is on';
    };

    const describeTurn = () => {
      if (offline) {
        if (sideLines.p1.length === 0 && sideLines.p2.length === 0) return '';
        if (offlineEnded && !live) return 'Finished';
        if (offlineTurn > 0) return 'Turn ' + offlineTurn;
        return live ? 'Starting' : 'Start';
      }
      if (!battle) return '';
      if (battle.ended && battle.atQueueEnd) return 'Finished';
      if (battle.turn > 0) return 'Turn ' + battle.turn;
      if (live) return 'Starting';
      return battle.stepQueue.some(line => line.startsWith('|teampreview'))
        ? 'Team preview'
        : 'Start';
    };

    const playbackState = () => {
      if (offline) {
        if (sideLines.p1.length === 0 && sideLines.p2.length === 0) return 'waiting';
        if (offlineEnded && !live) return 'finished';
        return 'watching';
      }
      if (!battle) return 'waiting';
      if (battle.ended && battle.atQueueEnd) return 'finished';
      return battle.started ? 'watching' : 'waiting';
    };

    const render = () => {
      if (offline) {
        el.turn.textContent = describeTurn();
        el.live.hidden = !live;
        el.live.dataset.following = 'true';
        el.start.hidden = true;
        notifyApp({type: 'playback', state: playbackState()});
        return;
      }
      if (!battle) return;
      const playing = isPlaying();
      el.toggle.innerHTML = playing ? '&#9208;' : '&#9654;';
      el.toggle.title = playing ? 'Pause' : 'Play';
      el.turn.textContent = describeTurn();
      el.live.hidden = !live;
      el.live.dataset.following = String(!battle.paused && battle.seeking === null);
      if (battle.started) el.start.hidden = true;
      notifyApp({type: 'playback', state: playbackState()});
    };

    const play = () => {
      if (!battle) return;
      if (battle.ended && battle.atQueueEnd) {
        battle.reset();
        applyTeam();
      }
      battle.play();
    };

    const actions = {
      start: () => {
        if (!battle) return;
        battle.reset();
        applyTeam();
      },
      previous: () => battle && battle.seekBy(-1),
      next: () => battle && battle.seekBy(1),
      end: () => {
        if (!battle) return;
        battle.seekTurn(Infinity);
        if (live && battle.paused) battle.play();
      },
      toggle: () => (isPlaying() ? battle.pause() : play()),
      switch: () => {
        if (offline) {
          if (sideLines.p1.length === 0 && sideLines.p2.length === 0) return;
          currentSide = currentSide === 'p2' ? 'p1' : 'p2';
          renderOfflineLog(sideLines[currentSide]);
          return;
        }
        if (!battle) return;
        currentSide = currentSide === 'p2' ? 'p1' : 'p2';
        battle.stepQueue = sideLines[currentSide].slice();
        if (!battle.started) {
          battle.setViewpoint(currentSide);
          applyTeam();
          return;
        }
        const turn = battle.ended && battle.atQueueEnd ? Infinity : battle.turn;
        const wasPaused = battle.paused;
        battle.reset();
        battle.setViewpoint(currentSide);
        applyTeam();
        battle.seekTurn(turn);
        if (!wasPaused && !(battle.ended && battle.atQueueEnd)) battle.play();
      },
      sound: () => {
        muted = !muted;
        applySound();
      },
    };

    const bindControlEvents = () => {
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

    const enableControls = () => {
      for (const control of el.controls.querySelectorAll('button, select')) {
        control.disabled = false;
      }
      bindControlEvents();
    };

    const enableOfflineControls = () => {
      for (const control of el.controls.querySelectorAll('button, select')) {
        control.disabled = control.getAttribute('data-action') !== 'switch';
      }
      bindControlEvents();
    };

    const isLines = val => Array.isArray(val) && val.every(x => typeof x === 'string');

    const loadBattle = msg => {
      if (battle) {
        battle.destroy();
        el.battle.innerHTML = '';
        el.log.innerHTML = '';
      }
      live = Boolean(msg.live);
      currentSide = msg.side === 'p2' ? 'p2' : 'p1';
      const fallback = isLines(msg.lines) ? msg.lines.filter(readable) : [];
      sideLines = {
        p1: isLines(msg.p1Lines) ? msg.p1Lines.filter(readable) : fallback.slice(),
        p2: isLines(msg.p2Lines) ? msg.p2Lines.filter(readable) : fallback.slice(),
      };
      if (sideLines.p1.length === 0 && sideLines.p2.length === 0) {
        battle = null;
        offlineTurn = 0;
        offlineEnded = false;
        delete document.documentElement.dataset.hasLog;
        el.log.innerHTML = '';
        el.start.hidden = true;
        for (const control of el.controls.querySelectorAll('button, select')) {
          control.disabled = true;
        }
        el.turn.textContent = '';
        el.live.hidden = true;
        showStatus('Waiting for battle…');
        if (offline) document.body.dataset.settled = 'true';
        notifyApp({type: 'playback', state: 'waiting'});
        return;
      }
      if (offline) {
        document.documentElement.dataset.hasLog = 'true';
        renderOfflineLog(sideLines[currentSide]);
        enableOfflineControls();
        showStatus('Battle viewer offline — showing battle log.');
        document.body.dataset.settled = 'true';
        render();
        return;
      }
      sidePokemon = {
        p1: Array.isArray(msg.p1Pokemon)
          ? msg.p1Pokemon
          : (currentSide === 'p1' && Array.isArray(msg.pokemon) ? msg.pokemon : null),
        p2: Array.isArray(msg.p2Pokemon)
          ? msg.p2Pokemon
          : (currentSide === 'p2' && Array.isArray(msg.pokemon) ? msg.pokemon : null),
      };
      let hash = 0;
      for (const line of sideLines.p1) {
        for (let i = 0; i < line.length; i++) {
          hash = ((hash << 5) - hash + line.charCodeAt(i)) | 0;
        }
      }
      const battleId = 'battle-' + ((Math.abs(hash) % 999999) + 1);
      window.BattleSound.setMute(muted);
      battle = new window.Battle({
        id: battleId,
        $frame: window.$(el.battle),
        $logFrame: window.$(el.log),
        log: sideLines[currentSide].slice(),
        paused: !live,
      });
      battle.subscribe(render);
      if (currentSide === 'p2') battle.setViewpoint('p2');
      applyTeam();
      applySound();
      applySpeed();
      enableControls();
      showStatus('');
      el.start.hidden = live;
      if (live && msg.seekEnd !== false) battle.seekTurn(Infinity);
      render();
    };

    const onMessage = event => {
      if (event.source !== window.parent || event.origin !== appOrigin) return;
      const msg = event.data;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'load' && (isLines(msg.lines) || isLines(msg.p1Lines))) {
        loadBattle(msg);
      } else if (msg.type === 'append' && (battle || offline) && live) {
        const fallback = isLines(msg.lines) ? msg.lines.filter(readable) : [];
        const addP1 = isLines(msg.p1Lines) ? msg.p1Lines.filter(readable) : fallback;
        const addP2 = isLines(msg.p2Lines) ? msg.p2Lines.filter(readable) : fallback;
        sideLines.p1.push(...addP1);
        sideLines.p2.push(...addP2);
        if (Array.isArray(msg.p1Pokemon)) sidePokemon.p1 = msg.p1Pokemon;
        if (Array.isArray(msg.p2Pokemon)) sidePokemon.p2 = msg.p2Pokemon;
        if (offline) {
          renderOfflineLog(sideLines[currentSide]);
          if (sideLines[currentSide].length > 0) {
            document.documentElement.dataset.hasLog = 'true';
            enableOfflineControls();
            showStatus('Battle viewer offline — showing battle log.');
          }
          render();
          return;
        }
        applyTeam();
        const toAdd = currentSide === 'p2' ? addP2 : addP1;
        toAdd.forEach(line => battle.add(line));
        render();
      } else if (msg.type === 'end' && (battle || offline)) {
        live = false;
        render();
      } else if (msg.type === 'theme' && typeof msg.dark === 'boolean') {
        applyTheme(msg.dark);
        if (offline) {
          setTimeout(() => {
            document.body.dataset.settled = 'true';
          }, 0);
        }
      } else if (msg.type === 'speed' && Object.hasOwn(SPEEDS, msg.speed)) {
        el.speed.value = msg.speed;
        applySpeed();
      } else if (msg.type === 'team' && battle) {
        if (Array.isArray(msg.p1Pokemon)) sidePokemon.p1 = msg.p1Pokemon;
        if (Array.isArray(msg.p2Pokemon)) sidePokemon.p2 = msg.p2Pokemon;
        if (Array.isArray(msg.pokemon)) sidePokemon[currentSide] = msg.pokemon;
        applyTeam();
      }
    };

    const boot = async () => {
      window.exports = window;
      applyTheme(window.matchMedia('(prefers-color-scheme: dark)').matches);
      STYLES.forEach(loadStyle);
      new ResizeObserver(fitScene).observe(el.stage);
      fitScene();
      window.addEventListener('message', onMessage);

      const enterOfflineMode = () => {
        clearExternalNodes();
        offline = true;
        document.documentElement.dataset.offline = 'true';
        el.status.dataset.offline = 'true';
        showStatus('Battle viewer offline (play.pokemonshowdown.com unreachable).');
        notifyApp({type: 'ready'});
        setTimeout(() => {
          document.body.dataset.settled = 'true';
        }, 50);
      };

      try {
        await Promise.all(SCRIPTS.map(loadScript));
      } catch {
        enterOfflineMode();
        return;
      }
      if (typeof window.Battle !== 'function' || typeof window.$ !== 'function') {
        enterOfflineMode();
        return;
      }
      if (window.Dex) {
        window.Dex.resourcePrefix = ASSETS + '/';
        window.Dex.fxPrefix = ASSETS + '/fx/';
      }
      if (window.BattleEffects) {
        for (const fx of Object.values(window.BattleEffects)) {
          if (fx && typeof fx.url === 'string' && fx.url.startsWith('//')) {
            fx.url = 'https:' + fx.url;
          }
        }
      }
      if (window.BattleScene && window.BattleScene.prototype) {
        window.BattleScene.prototype.preloadEffects = () => {};
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

function speciesToMinispriteAbbr(species: string): string {
  return species.replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase() || '?';
}

function renderPartyMinisprites(packed?: string): util.Child {
  const speciesList = parsePackedTeamSpecies(packed);
  if (speciesList.length === 0) return undefined;
  return (
    <span className='party-minisprites'>
      {speciesList.slice(0, 6).map(sp => {
        const slug = speciesToMinispriteSlug(sp);
        if (!slug) return undefined;
        const abbr = speciesToMinispriteAbbr(sp);
        const src = `https://www.smogon.com/forums/media/minisprites/${slug}.png`;
        return (
          <span title={sp} data-mon={abbr}>
            <img src={src} alt={sp} title={sp} />
          </span>
        );
      })}
    </span>
  );
}

function renderClockSide(
  slot: 'p1' | 'p2',
  clock: arena.BroadcastClock,
  timer: arena.TimerSettings,
  committed = false
): util.Html {
  const pillCls = clock.thinking
    ? 'clock-pill thinking'
    : committed
      ? 'clock-pill committed'
      : 'clock-pill';
  const timeCls = clock.thinking ? 'clock-time yes' : 'clock-time';
  const incLabel = clock.incrementSeconds > 0
    ? `+${clock.incrementSeconds}s/turn`
    : `${timer.maxPerTurnSeconds}s/turn`;
  const subText = clock.thinking
    ? 'thinking…'
    : committed
      ? 'committed'
      : incLabel;
  const rem = Math.round(clock.bankSeconds);
  const bankTip = `${rem}s remaining in ${timer.startingSeconds}s bank`;
  const tip = clock.thinking
    ? `${bankTip} (currently thinking)`
    : committed
      ? `${bankTip} (choice committed, waiting for opponent)`
      : `${bankTip} (${incLabel})`;
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
  broadcast?: arena.LiveBroadcast
): arena.BroadcastTable[] {
  if (broadcast?.tournamentId !== tournamentId) return [];
  const norm = arena.normalizeLiveBroadcast(broadcast);
  return norm.tables.filter(tb => !tb.idle && tb.live !== false && Boolean(tb.p1 && tb.p2));
}

function renderBroadcastSectionHtml(
  tournament: db.TournamentRow,
  broadcast?: arena.LiveBroadcast
): {
  node: util.Html;
  isActive: boolean;
  normalized?: arena.LiveBroadcast;
  selectedTable?: number;
  viewerInit?: {
    lines: string[];
    p1Lines?: string[];
    p2Lines?: string[];
    p1Pokemon?: unknown[];
    p2Pokemon?: unknown[];
    live: boolean;
    side: 'p1';
  };
} {
  const isActive = broadcast?.tournamentId === tournament.id;
  const norm = isActive && broadcast ? arena.normalizeLiveBroadcast(broadcast) : undefined;
  const selected = norm?.tables.find(tb => !tb.idle && tb.p1 && tb.p2) ??
    norm?.tables.find(tb => tb.p1 && tb.p2) ??
    norm?.tables[0];

  const p1Clock = selected?.p1 ?? norm?.p1;
  const p2Clock = selected?.p2 ?? norm?.p2;
  const timer = arena.timerSettingsForFormat(tournament.format, tournament.rules);
  const isLive = selected
    ? (!selected.idle && selected.live !== false)
    : Boolean(norm && norm.live !== false);
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
          <span id='series-left'>{util.raw(seriesLeft)}</span>
          <span id='series-right'>{util.raw(seriesRight)}</span>
        </div>
        {norm && p1Clock && p2Clock ? (
          <div className='clock-bar' id='clock-bar'>
            {renderClockSide('p1', p1Clock, timer, isLive && !p1Clock.thinking && p2Clock.thinking)}
            {renderClockSide('p2', p2Clock, timer, isLive && !p2Clock.thinking && p1Clock.thinking)}
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
  const p1Lines = selected?.p1Lines ?? norm.p1Lines;
  const p2Lines = selected?.p2Lines ?? norm.p2Lines;
  const p1Pokemon = selected?.p1?.pokemon;
  const p2Pokemon = selected?.p2?.pokemon;

  return {
    node,
    isActive: true,
    normalized: norm,
    selectedTable: selected?.table ?? 1,
    viewerInit: {
      lines,
      p1Lines,
      p2Lines,
      p1Pokemon,
      p2Pokemon,
      live: isLive,
      side: 'p1',
    },
  };
}

function findLiveTableForEntrant(
  liveTables: arena.BroadcastTable[],
  slug: string,
  name: string
): arena.BroadcastTable | undefined {
  return liveTables.find(tb => (
    tb.p1?.slug === slug ||
    tb.p2?.slug === slug ||
    tb.p1?.name === name ||
    tb.p2?.name === name
  ));
}

function findLiveTableForPair(
  liveTables: arena.BroadcastTable[],
  a: {slug: string; name: string},
  b: {slug: string; name: string}
): arena.BroadcastTable | undefined {
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
  liveTables: arena.BroadcastTable[];
  links: render.AgentLinkContext;
}): util.Html {
  const {
    tournament,
    entrants,
    hasSuperfinal,
    liveTables,
    links,
  } = opts;
  if (entrants.length === 0) {
    return (
      <div id='standings-body'>
        <p className='empty-state muted'>No entrants registered yet.</p>
      </div>
    );
  }

  if (tournament.status === 'scheduled') {
    const ordered = [...entrants].sort(
      (a, b) => a.submittedAt - b.submittedAt || a.seed - b.seed
    );
    return (
      <div id='standings-body'>
        <div className='table-wrap'>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Agent</th>
                <th className='num'>Submitted</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((e, idx) => {
                const href = render.resolveAgentHref(links, e.agentSlug, e.agentName);
                return (
                  <tr className={idx >= util.TABLE_PAGE_SIZE ? 'hide' : undefined}>
                    <td><strong>{idx + 1}</strong></td>
                    <td>
                      {util.raw(render.formatAgentLink(e.agentName, href, true))}{' '}
                      <code>{e.version}</code>
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
          total={ordered.length}
          singular='entrant'
          plural='entrants'
        />
      </div>
    );
  }

  const isMultiGame = tournament.bestOf > 1;
  const unitPlural = isMultiGame ? 'matches' : 'games';
  const maxRrGames = Math.max(1, (entrants.length - 1) * tournament.gamesPerMatchup);
  const ptsTitle =
    `Round-Robin points out of ${maxRrGames} ${unitPlural} (+1.0 per win, +0.5 per tie)`;
  const wltTitle = isMultiGame
    ? `Best-of-${tournament.bestOf} match Wins – Losses – Ties`
    : 'Standalone individual game Wins – Losses – Ties';

  return (
    <div id='standings-body'>
      <div className='table-wrap'>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Agent</th>
              <th className='num' title='Tournament MAP Elo ± 95% CI'>Elo</th>
              <th className='num' title={wltTitle}>
                W–L–T
              </th>
              <th className='num' title={ptsTitle}>Points</th>
              <th className='num' title='Sonneborn-Berger tiebreak score'>S–B</th>
            </tr>
          </thead>
          <tbody>
            {entrants.map((e, idx) => {
              const rankNum = e.finalRank ?? idx + 1;
              const href = render.resolveAgentHref(links, e.agentSlug, e.agentName);
              const liveTb = findLiveTableForEntrant(liveTables, e.agentSlug, e.agentName);
              const elo = Math.round(e.elo);
              const ci = Math.round(1.96 * e.se);
              const ptsStr = e.points.toFixed(1);
              const sbStr = Math.round(e.sonnebornBerger).toLocaleString('en-US');

              return (
                <tr className={idx >= util.TABLE_PAGE_SIZE ? 'hide' : undefined}>
                  <td>
                    <strong>{rankNum}</strong>
                    {hasSuperfinal && rankNum <= 2 && <> <span className='muted'>SF</span></>}
                  </td>
                  <td>
                    {util.raw(render.formatAgentLink(e.agentName, href, true))}{' '}
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
      <util.TablePager
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
  bestOf?: number;
  entrants: db.TournamentEntrantView[];
  pairs: db.TournamentPairRecord[];
  liveTables: arena.BroadcastTable[];
  links: render.AgentLinkContext;
}): {node: util.Html; isEmpty: boolean} {
  const {bestOf, entrants, pairs, liveTables, links} = opts;
  const unitPlural = (bestOf ?? 1) > 1 ? 'matches' : 'games';
  const rrLiveTables = liveTables.filter(tb => tb.stage !== 'Superfinal');
  if (entrants.length < 2 || (pairs.length === 0 && rrLiveTables.length === 0)) {
    return {
      node: (
        <div id='crosstable-body'>
          <p className='empty-state muted'>No round-robin {unitPlural} completed yet.</p>
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
                const rowHref = render.resolveAgentHref(links, rowEnt.agentSlug, rowEnt.agentName);
                return (
                  <tr>
                    <td>
                      {util.raw(render.formatAgentLink(rowEnt.agentName, rowHref, true))}{' '}
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

function renderTournamentResultNode(
  g: db.TournamentGameView,
  bestOf = 1
): {
  p1Won: boolean;
  p2Won: boolean;
  node: util.Child;
} {
  const p1Won = g.outcome === 'W';
  const p2Won = g.outcome === 'L';
  if (bestOf > 1 || g.games.length > 1) {
    let s1 = 0;
    let s2 = 0;
    for (const gm of g.games) {
      if (gm.outcome === 'W') {
        s1 += 1;
      } else if (gm.outcome === 'L') {
        s2 += 1;
      } else if (gm.outcome === 'T') {
        s1 += 0.5;
        s2 += 0.5;
      }
    }
    const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
    const s1Str = fmt(s1);
    const s2Str = fmt(s2);
    const node = p1Won
      ? <><strong>{s1Str}</strong>–{s2Str}</>
      : p2Won
        ? <>{s1Str}–<strong>{s2Str}</strong></>
        : `${s1Str}–${s2Str}`;
    return {p1Won, p2Won, node};
  }
  const node = p1Won
    ? <><strong>1</strong>–0</>
    : p2Won
      ? <>0–<strong>1</strong></>
      : '½–½';
  return {p1Won, p2Won, node};
}

function renderSeriesGameCardNode(gm: db.TournamentGameRow, showGameNum: boolean): util.Html {
  const end = render.formatEndReasonNode(gm.endReason ?? 'normal');
  return (
    <div className='battle-detail-card'>
      <div className='battle-detail-title'>
        <span>{showGameNum ? `Game ${gm.gameNumber}` : 'Game'}</span>
        <span className='battle-detail-sub'>
          {showGameNum ? <>{render.formatGameOutcomeNode(gm.outcome ?? 'T')} · </> : undefined}
          <tt>{gm.turns ?? 0} turns</tt>
          {end.show ? <> · {end.node}</> : undefined}
        </span>
      </div>
      <div className='battle-detail-line'>
        <span><tt>P1</tt></span>
        {render.formatGamePlayerTelemetryNode(gm.p1)}
      </div>
      <div className='battle-detail-line'>
        <span><tt>P2</tt></span>
        {render.formatGamePlayerTelemetryNode(gm.p2)}
      </div>
    </div>
  );
}

function renderTournamentGameDetailNode(
  g: db.TournamentGameView,
  bestOf: number,
  gameLogUrls: ReadonlyArray<string | undefined>
): util.Html {
  const completedAt = g.completedAt ?? 0;
  const completedIso = new Date(completedAt * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const completedUtc = `${completedIso} UTC`;
  const isMulti = bestOf > 1 || g.games.length > 1;
  const hasReplay = gameLogUrls.some(Boolean);
  const logAttrs: Record<string, string | undefined> = {};
  if (hasReplay) {
    gameLogUrls.forEach((url, idx) => {
      if (url) logAttrs[`data-g${idx + 1}-log`] = url;
    });
  }

  return (
    <div
      className='battle-detail'
      data-match-id={hasReplay ? g.id : undefined}
      data-p1-name={hasReplay ? g.p1.name : undefined}
      data-p2-name={hasReplay ? g.p2.name : undefined}
      {...logAttrs}
      data-total-games={hasReplay && isMulti ? String(g.games.length) : undefined}
      data-same-seats={hasReplay && isMulti ? '1' : undefined}
      data-single-game={hasReplay && !isMulti ? '1' : undefined}
    >
      <div className='battle-detail-meta'>
        <span className='muted'>{completedUtc}</span>
        <span>
          {g.preemptions > 0 ? (
            <>
              <span className='muted'>Preemptions:</span> <code>{g.preemptions}</code> ·{' '}
            </>
          ) : undefined}
          <span className='muted'>{isMulti ? 'Seeds:' : 'Seed:'}</span>{' '}
          {g.games.map((gm, idx) => (
            <>
              {idx > 0 ? ' · ' : undefined}
              <code>{gm.seed}</code>
            </>
          ))}
        </span>
      </div>
      {isMulti ? (
        <div className={g.games.length >= 3 ? 'battle-detail-grid bo3-grid' : 'battle-detail-grid'}>
          {g.games.map(gm => renderSeriesGameCardNode(gm, true))}
        </div>
      ) : (
        g.games[0] ? renderSeriesGameCardNode(g.games[0], false) : undefined
      )}
    </div>
  );
}

function renderTournamentGamesNode(opts: {
  tournament: db.TournamentRow;
  games: db.TournamentGameView[];
  liveTables: arena.BroadcastTable[];
  totalCompletedCount: number;
  links: render.AgentLinkContext;
  logFiles?: ReadonlySet<string>;
  nowSec: number;
}): util.Html {
  const {
    tournament,
    games,
    liveTables,
    totalCompletedCount,
    links,
    logFiles,
    nowSec,
  } = opts;
  const {publicDir} = links;
  const isMultiGame = tournament.bestOf > 1;
  const unitSingular = isMultiGame ? 'match' : 'game';
  const unitPlural = isMultiGame ? 'matches' : 'games';
  const resolvedLogs = logFiles ?? arena.listTournamentLogFiles(publicDir, tournament.id);
  const tourPrefix = `/arena/tournaments/${encodeURIComponent(tournament.id)}/`;

  const liveRows = liveTables.map((tb, idx) => {
    const p1 = tb.p1!;
    const p2 = tb.p2!;
    const codePrefix = tb.stage === 'Superfinal' ? 'SF' : 'RR';
    const codeNum = tb.stage === 'Superfinal' ? (tb.matchupGame ?? 1) : (tb.cycle ?? 1);
    const gameCode = `${codePrefix}${codeNum}`;
    const p1Href = p1.slug ? render.resolveAgentHref(links, p1.slug, p1.name) : undefined;
    const p2Href = p2.slug ? render.resolveAgentHref(links, p2.slug, p2.name) : undefined;
    const turn = parseLatestTurnFromLines(tb.lines);
    const tip = turn !== undefined
      ? `Spectate live on ${tb.label} (Turn ${turn})`
      : `Spectate live on ${tb.label}`;
    const rowCls = idx >= util.TABLE_PAGE_SIZE ? 'live-game-row hide' : 'live-game-row';

    return (
      <tr className={rowCls} data-live-game-table={tb.table}>
        <td>
          <a href='#live' className='subtle' data-live-table={tb.table} title={tip}>
            <code>{gameCode}</code>
          </a>
        </td>
        <td>{util.raw(render.formatAgentLink(p1.name, p1Href, false))}</td>
        <td>{renderPartyMinisprites(p1.team) ?? '\u00a0'}</td>
        <td>{util.raw(render.formatAgentLink(p2.name, p2Href, false))}</td>
        <td>{renderPartyMinisprites(p2.team) ?? '\u00a0'}</td>
        <td className='center'>
          <a href='#live' className='live-pill' data-live-table={tb.table} title={tip}>
            {'\u25cf'} T{tb.table}
          </a>
        </td>
        <td className='num muted'>—</td>
      </tr>
    );
  });

  const completedRows = games.map((g, idx) => {
    const codePrefix = g.stage === 'Superfinal' ? 'SF' : 'RR';
    const codeNum = g.stage === 'Superfinal' ? g.matchupGame : g.cycle;
    const gameCode = `${codePrefix}${codeNum}`;
    const singleLogRel = `${g.id}.log`;
    const singleLogUrl = resolvedLogs.has(singleLogRel)
      ? `${tourPrefix}${encodeURIComponent(singleLogRel)}`
      : undefined;
    const gameLogUrls = g.games.map(gm => {
      const gRel = `${g.id}-g${gm.gameNumber}.log`;
      if (resolvedLogs.has(gRel)) return `${tourPrefix}${encodeURIComponent(gRel)}`;
      return gm.gameNumber === 1 && g.games.length === 1 ? singleLogUrl : undefined;
    });

    const {p1Won, p2Won, node: resNode} = renderTournamentResultNode(g, tournament.bestOf);

    const p1Href = render.resolveAgentHref(links, g.p1.slug, g.p1.name);
    const p2Href = render.resolveAgentHref(links, g.p2.slug, g.p2.name);
    const completedAt = g.completedAt ?? 0;
    const completedIso = new Date(completedAt * 1000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);
    const completedUtc = `${completedIso} UTC`;
    const rel = render.formatRelativeTime(nowSec, completedAt);
    const rowCls = liveTables.length + idx >= util.TABLE_PAGE_SIZE
      ? 'battle-row hide'
      : 'battle-row';

    return (
      <>
        <tr
          className={rowCls}
          data-game-id={g.id}
          tabIndex={0}
          aria-expanded='false'
        >
          <td>
            <span className='battle-toggle' aria-hidden='true'>{'\u25b8'}</span>
            <code title={g.id}>{gameCode}</code>
          </td>
          <td>{util.raw(render.formatAgentLink(g.p1.name, p1Href, p1Won))}</td>
          <td>{renderPartyMinisprites(g.p1.team) ?? '\u00a0'}</td>
          <td>{util.raw(render.formatAgentLink(g.p2.name, p2Href, p2Won))}</td>
          <td>{renderPartyMinisprites(g.p2.team) ?? '\u00a0'}</td>
          <td className='center'>{resNode}</td>
          <td className='num muted' title={completedUtc} data-ts={g.completedAt}>{rel}</td>
        </tr>
        <tr className='battle-detail-row hide' data-detail-for={g.id}>
          <td colSpan={7}>
            {renderTournamentGameDetailNode(g, tournament.bestOf, gameLogUrls)}
          </td>
        </tr>
      </>
    );
  });

  const archive = arena.resolveTournamentArchive(publicDir, tournament.id);
  const jsonHref = `/arena/tournaments/${encodeURIComponent(tournament.id)}/index.json`;
  const countStr = totalCompletedCount.toLocaleString('en-US');
  const totalGameRows = liveTables.length + games.length;

  return (
    <>
      <div className='table-wrap'>
        <table>
          <thead>
            <tr>
              <th>{isMultiGame ? 'Match' : 'Game'}</th>
              <th>Player 1</th>
              <th>{'\u00a0'}</th>
              <th>Player 2</th>
              <th>{'\u00a0'}</th>
              <th className='center'>Result</th>
              <th className='num'>Completed</th>
            </tr>
          </thead>
          <tbody id='games-tbody'>
            {liveRows.length === 0 && completedRows.length === 0 ? (
              <tr className='empty-row'>
                <td colSpan={7} className='center muted'>
                  No completed {unitPlural} yet.
                </td>
              </tr>
            ) : (
              [...liveRows, ...completedRows]
            )}
          </tbody>
        </table>
      </div>
      <util.TablePager
        id='games-pager'
        label={isMultiGame ? 'Matches pagination' : 'Games pagination'}
        total={totalGameRows}
        singular={unitSingular}
        plural={unitPlural}
        prevLabel={'\u2190 Newer'}
        nextLabel={'Older \u2192'}
      />
      <p className='meta meta-archive' id='games-archive-meta'>
        {archive ? (
          <>
            Archive: <a href={archive.href}><code>{archive.name}</code></a> (
            <span id='games-count'>{countStr}</span> {unitPlural}) ·{' '}
            <a href={jsonHref}><code>index.json</code></a>
          </>
        ) : (
          <>
            Data: <a href={jsonHref}><code>index.json</code></a> (
            <span id='games-count'>{countStr}</span> {unitPlural}
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
          <span className='arena-live' id='live' hidden={true}>{'\u25cf'} LIVE</span>

          <div className='arena-group arena-end'>
            <button
              type='button'
              className='arena-btn'
              data-action='switch'
              aria-label='Switch viewpoint'
              title='Switch viewpoint'
              disabled={true}
            >
              <svg viewBox='0 0 24 24' aria-hidden='true'>
                <path
                  className='stroke'
                  d='M4 7.5h15M15.5 4L19 7.5 15.5 11M20 16.5H5M8.5 13L5 16.5 8.5 20'
                />
              </svg>
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
              aria-label='Sound'
              aria-pressed='false'
              title='Sound is off'
              disabled={true}
            >
              <svg className='icon-muted' viewBox='0 0 24 24' aria-hidden='true'>
                <path d='M4 9.5v5h3.5L12 19V5L7.5 9.5z' />
                <path className='stroke' d='M15.5 9.5l5 5m0-5l-5 5' />
              </svg>
              <svg className='icon-sound' viewBox='0 0 24 24' aria-hidden='true'>
                <path d='M4 9.5v5h3.5L12 19V5L7.5 9.5z' />
                <path
                  className='stroke'
                  d='M15 9a4.2 4.2 0 0 1 0 6m2.6-8.6a8 8 0 0 1 0 11.2'
                />
              </svg>
            </button>
          </div>
        </div>

        <div className='battle-log' id='log' aria-label='Battle log' />

        <script>{VIEWER_SCRIPT}</script>
      </body>
    </html>
  );
  util.writeFileAtomic(
    path.join(publicDir, 'arena', 'viewer', 'index.html'),
    `<!doctype html>\n${String(viewerDoc)}`
  );
}

export function formatTournamentName(name: string): string {
  return name
    .replace(/^Tournament #\d+:\s*/i, '')
    .replace(/\(?\bBO(\d+)\b\)?/gi, '(Bo$1)');
}

export function renderArenaTournamentsSummaryHtml(opts: {
  db: db.Database;
  links: render.AgentLinkContext;
  tournaments?: db.TournamentRow[];
  entrantsByTournament?: ReadonlyMap<string, db.TournamentEntrantView[]>;
}): string {
  const {db, links, entrantsByTournament} = opts;
  const tournaments = opts.tournaments ?? db.getTournaments();
  if (tournaments.length === 0) {
    return String(<p className='empty-state muted'>No tournaments scheduled yet.</p>);
  }

  const sorted = [...tournaments].sort(
    (a, b) => a.startsAt - b.startsAt || a.id.localeCompare(b.id)
  );

  return String(
    <>
      <div className='table-wrap'>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Name</th>
              <th>Winner</th>
              <th className='num'>Entrants</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((t, idx) => {
              const tourHref = `/arena/tournaments/${encodeURIComponent(t.id)}/`;
              const entrants =
                entrantsByTournament?.get(t.id) ?? db.getTournamentEntrants(t.id);
              const hideCls = idx >= util.TABLE_PAGE_SIZE ? 'hide' : undefined;
              const dateCell = t.status === 'running' ? (
                <td>
                  <a href={tourHref} className='live-pill'>{'\u25cf'} LIVE</a>
                </td>
              ) : (
                <td>{util.formatUtcDate(t.startsAt)}</td>
              );
              const displayName = formatTournamentName(t.name);

              let winnerCell: util.Child = <td className='muted'>-</td>;
              if (t.status === 'completed') {
                const winner = entrants.find(e => e.finalRank === 1) ?? entrants[0];
                if (winner) {
                  const wHref = render.resolveAgentHref(links, winner.agentSlug, winner.agentName);
                  winnerCell = (
                    <td>
                      {util.raw(render.formatAgentLink(winner.agentName, wHref, true))}{' '}
                      <code>{winner.version}</code>
                    </td>
                  );
                }
              }

              return (
                <tr className={hideCls}>
                  {dateCell}
                  <td>
                    <a href={tourHref} className='subtle'><strong>{displayName}</strong></a>
                  </td>
                  {winnerCell}
                  <td className='num'>{entrants.length}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <util.TablePager
        id='tournaments-pager'
        label='Tournaments pagination'
        total={sorted.length}
        singular='tournament'
        plural='tournaments'
      />
    </>
  );
}

function renderTournamentRulesNode(staticDir: string, tournamentId: string): util.Child {
  if (!/^[A-Za-z0-9_-]+$/.test(tournamentId)) return undefined;
  const rulesPath = path.join(staticDir, 'tours', `${tournamentId}.dj`);
  if (!fs.existsSync(rulesPath)) return undefined;
  const body = site.html.render(fs.readFileSync(rulesPath, 'utf8')).trim();
  if (!body) return undefined;
  return <section className='tour-rules'>{util.raw(body)}</section>;
}

function buildTournamentScript(viewerInit: unknown, pageInit: unknown): string {
  return `
  (() => {
    const fallbackMinisprite = img => {
      if (!(img instanceof HTMLImageElement)) return;
      const slot = img.closest('.party-minisprites span[data-mon]');
      if (!slot) return;
      slot.classList.add('sprite-fallback');
      img.removeAttribute('src');
      img.remove();
    };

    document.addEventListener('error', ev => {
      fallbackMinisprite(ev.target);
    }, true);

    const sweepMinisprites = rootEl => {
      const imgs = (rootEl || document).querySelectorAll('.party-minisprites img');
      imgs.forEach(img => {
        if (img.complete && img.naturalWidth === 0) {
          fallbackMinisprite(img);
        }
      });
      if (!imgs.length) return;
      setTimeout(() => {
        imgs.forEach(img => {
          if (img.isConnected && (!img.complete || img.naturalWidth === 0)) {
            fallbackMinisprite(img);
          }
        });
      }, 4000);
    };
    sweepMinisprites(document);
    window.__sweepMinisprites = sweepMinisprites;
  })();

  document.addEventListener('DOMContentLoaded', () => {
    if (window.__sweepMinisprites) window.__sweepMinisprites(document);
    const eventSelect = document.getElementById('event-select');
    const liveSec = document.getElementById('live');
    let tableNavWrap = document.getElementById('table-nav-wrap');
    const seriesLeftEl = document.getElementById('series-left');
    const seriesRightEl = document.getElementById('series-right');
    let clockBarEl = document.getElementById('clock-bar');
    const standingsSec = document.getElementById('standings');
    const crosstableSec = document.getElementById('crosstable');
    const gamesSec = document.getElementById('games');
    const gamesTbody = document.getElementById('games-tbody');
    const gamesArchiveMeta = document.getElementById('games-archive-meta');
    const frame = document.getElementById('ps-viewer-frame');

    // Recreate empty broadcast containers if stripped by html-minifier's removeEmptyElements.
    const ensureTableNavWrap = () => {
      if (tableNavWrap) return tableNavWrap;
      if (!liveSec) return null;
      const el = document.createElement('div');
      el.id = 'table-nav-wrap';
      const bcastEl = liveSec.querySelector('.broadcast');
      if (bcastEl) liveSec.insertBefore(el, bcastEl);
      else liveSec.prepend(el);
      tableNavWrap = el;
      return el;
    };
    const ensureClockBarEl = () => {
      if (clockBarEl) return clockBarEl;
      if (!liveSec) return null;
      const bcastEl = liveSec.querySelector('.broadcast');
      if (!bcastEl) return null;
      const el = document.createElement('div');
      el.id = 'clock-bar';
      el.className = 'clock-bar hide';
      const viewerWrap = bcastEl.querySelector('.viewer-wrap');
      if (viewerWrap) bcastEl.insertBefore(el, viewerWrap);
      else bcastEl.appendChild(el);
      clockBarEl = el;
      return el;
    };

    const initialViewer = ${render.safeInlineJson(viewerInit)};
    const pageInit = ${render.safeInlineJson(pageInit)} || {};

    const tournamentId = String(pageInit.tournamentId || '');
    const bestOf = Math.max(1, Number(pageInit.bestOf) || 1);
    const isMultiGame = bestOf > 1;
    const unitSingular = isMultiGame ? 'match' : 'game';
    const unitPlural = isMultiGame ? 'matches' : 'games';
    const gamesPerMatchup = Number(pageInit.gamesPerMatchup) || 1;
    const startingBankSeconds = Number(pageInit.startingBankSeconds) || 150;
    const maxTurnSeconds = Number(pageInit.maxTurnSeconds) || 150;
    const isVgcTimer = Boolean(pageInit.isVgcTimer);
    const agentLinks = pageInit.agentLinks || {};
    let status = pageInit.status || 'scheduled';
    let hasSuperfinal = Boolean(pageInit.hasSuperfinal);
    let completedGames = Number(pageInit.completedGames) || 0;
    let archiveHref = pageInit.archiveHref;
    let standings = Array.isArray(pageInit.standings) ? pageInit.standings : [];
    let crosstable = Array.isArray(pageInit.crosstable) ? pageInit.crosstable : [];
    let broadcast = pageInit.broadcast;
    let selectedTable = Number(pageInit.selectedTable) || 1;
    let viewerReady = false;
    let pendingPayload = initialViewer;
    const clockStateByTable = new Map();

    ${render.buildBattleDetailClientJs()}

    const formatClockMmSs = seconds => {
      const s = Math.max(0, Math.round(seconds));
      const mm = String(Math.floor(s / 60)).padStart(2, '0');
      const ss = String(s % 60).padStart(2, '0');
      return mm + ':' + ss;
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

    const speciesToAbbr = species =>
      String(species || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase() || '?';

    const renderPartyMinisprites = packed => {
      const list = parsePackedSpecies(packed);
      if (list.length === 0) return '';
      const spans = list.slice(0, 6).map(sp => {
        const slug = speciesToSlug(sp);
        if (!slug) return '';
        const abbr = speciesToAbbr(sp);
        const src = 'https://www.smogon.com/forums/media/minisprites/' + slug + '.png';
        return '<span title="' + esc(sp) + '" data-mon="' + esc(abbr) + '">' +
          '<img src="' + esc(src) + '" alt="' + esc(sp) + '" title="' + esc(sp) + '"></span>';
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
            p1Lines: pendingPayload.p1Lines,
            p2Lines: pendingPayload.p2Lines,
            p1Pokemon: pendingPayload.p1Pokemon,
            p2Pokemon: pendingPayload.p2Pokemon,
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

    const syncSideClock = (prevSide, clock, sameDecision, nowMillis) => {
      if (!clock || !clock.thinking) return undefined;
      const bank = Number(clock.bankSeconds) || 0;
      if (sameDecision && prevSide && prevSide.bankSeconds === bank) {
        return prevSide;
      }
      return {bankSeconds: bank, syncMillis: nowMillis};
    };

    const syncTableClock = (tb, nowMillis, forceReset) => {
      if (!tb || typeof tb.table !== 'number') return;
      const isLive = !tb.idle && tb.live !== false && Boolean(tb.p1 && tb.p2);
      if (!isLive) {
        clockStateByTable.delete(tb.table);
        return;
      }
      const turn = parseLatestTurn(tb.lines);
      const pauseBank = isVgcTimer && (turn === undefined || turn === 0);
      const lineCount = Array.isArray(tb.lines) ? tb.lines.length : 0;
      const prev = clockStateByTable.get(tb.table);
      const sameDecision = Boolean(
        !forceReset &&
        prev &&
        (prev.gameId || '') === (tb.gameId || '') &&
        (prev.game || 1) === (tb.game || 1) &&
        prev.turn === turn &&
        prev.lineCount === lineCount
      );
      clockStateByTable.set(tb.table, {
        gameId: tb.gameId || '',
        game: tb.game || 1,
        turn,
        lineCount,
        p1: pauseBank ? undefined : syncSideClock(prev && prev.p1, tb.p1, sameDecision, nowMillis),
        p2: pauseBank ? undefined : syncSideClock(prev && prev.p2, tb.p2, sameDecision, nowMillis),
      });
    };

    const syncAllTableClocks = (nowMillis, forceReset) => {
      const seen = new Set();
      for (const tb of getTables()) {
        seen.add(tb.table);
        syncTableClock(tb, nowMillis, forceReset);
      }
      for (const tableNum of Array.from(clockStateByTable.keys())) {
        if (!seen.has(tableNum)) clockStateByTable.delete(tableNum);
      }
    };

    syncAllTableClocks(Date.now(), false);

    const displayedBankSeconds = (tableState, slot, clock, nowMillis) => {
      const active = tableState && tableState[slot];
      if (!active || !clock || !clock.thinking) return Number(clock.bankSeconds) || 0;
      const elapsed = Math.floor((nowMillis - active.syncMillis) / 1000);
      return Math.max(0, Math.round(active.bankSeconds - elapsed));
    };

    const renderClockSideHtml = (slot, clock, committed, bankSeconds) => {
      const pillCls = clock.thinking
        ? 'clock-pill thinking'
        : committed
          ? 'clock-pill committed'
          : 'clock-pill';
      const timeCls = clock.thinking ? 'clock-time yes' : 'clock-time';
      const incLabel = clock.incrementSeconds > 0
        ? ('+' + clock.incrementSeconds + 's/turn')
        : (maxTurnSeconds + 's/turn');
      const subText = clock.thinking
        ? 'thinking…'
        : committed
          ? 'committed'
          : incLabel;
      const rem = Math.round(bankSeconds);
      const tip = clock.thinking
        ? (rem + 's remaining in ' + startingBankSeconds + 's bank (currently thinking)')
        : committed
          ? (rem + 's remaining in ' + startingBankSeconds +
            's bank (choice committed, waiting for opponent)')
          : (rem + 's remaining in ' + startingBankSeconds + 's bank (' + incLabel + ')');
      return '<div class="clock-side" id="clock-side-' + slot + '">' +
        '<span><tt>' + slot + '</tt> <strong id="clock-name-' + slot + '">' +
        esc(clock.name) + '</strong></span>' +
        '<span class="' + pillCls + '" id="clock-pill-' + slot + '" title="' + esc(tip) + '">' +
        '<span class="' + timeCls + '" id="clock-' + slot + '">' +
        formatClockMmSs(bankSeconds) + '</span>' +
        '<span class="clock-sub" id="clock-sub-' + slot + '">' + esc(subText) + '</span>' +
        '</span></div>';
    };

    const renderClocks = (tb, nowMillis = Date.now()) => {
      const bar = ensureClockBarEl();
      if (!bar) return;
      if (!tb || tb.idle || !tb.p1 || !tb.p2) {
        bar.classList.add('hide');
        bar.innerHTML = '';
        return;
      }
      const isLive = tb.live !== false;
      const state = isLive ? clockStateByTable.get(tb.table) : undefined;
      const p1Bank = displayedBankSeconds(state, 'p1', tb.p1, nowMillis);
      const p2Bank = displayedBankSeconds(state, 'p2', tb.p2, nowMillis);
      const p1Committed = isLive && !tb.p1.thinking && Boolean(tb.p2.thinking);
      const p2Committed = isLive && !tb.p2.thinking && Boolean(tb.p1.thinking);
      bar.classList.remove('hide');
      bar.innerHTML =
        renderClockSideHtml('p1', tb.p1, p1Committed, p1Bank) +
        renderClockSideHtml('p2', tb.p2, p2Committed, p2Bank);
    };

    const renderTableNav = () => {
      const wrap = ensureTableNavWrap();
      if (!wrap) return;
      const tables = getTables();
      if (tables.length === 0) {
        wrap.innerHTML = '';
        return;
      }
      const items = tables.map((tb, idx) => {
        const sep = idx > 0 ? '\\n        —\\n        ' : '';
        const checked = tb.table === selectedTable ? ' checked' : '';
        const tbId = 'tb-' + esc(tournamentId) + '-' + tb.table;
        const labelHtml = tb.idle
          ? (esc(tb.label) + ' <span class="muted">(idle)</span>')
          : esc(tb.label);
        return sep + '<li><input type="radio" name="table-' + esc(tournamentId) +
          '" id="' + tbId + '" value="' + tb.table + '" data-table-num="' +
          tb.table + '"' + checked + '><label for="' + tbId + '">' + labelHtml + '</label></li>';
      }).join('');
      wrap.innerHTML = '<nav class="subnav" aria-label="Broadcast table"><ul>' +
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
      selectedTable = tb.table;
      liveSec.classList.remove('hide');
      renderTableNav();
      if (seriesLeftEl) {
        seriesLeftEl.innerHTML = tb.seriesLeftHtml || esc(tb.label);
      }
      if (seriesRightEl) {
        seriesRightEl.innerHTML = renderSeriesRightForTable(tb);
      }
      renderClocks(tb);
      const lines = Array.isArray(tb.lines) ? tb.lines : [];
      const p1Lines = Array.isArray(tb.p1Lines) ? tb.p1Lines : undefined;
      const p2Lines = Array.isArray(tb.p2Lines) ? tb.p2Lines : undefined;
      const p1Pokemon = tb.p1 && Array.isArray(tb.p1.pokemon) ? tb.p1.pokemon : undefined;
      const p2Pokemon = tb.p2 && Array.isArray(tb.p2.pokemon) ? tb.p2.pokemon : undefined;
      const isLive = !tb.idle && tb.live !== false;
      pendingPayload = {lines, p1Lines, p2Lines, p1Pokemon, p2Pokemon, live: isLive, side: 'p1'};
      if (viewerReady) {
        sendToViewer({type: 'load', ...pendingPayload});
      }
      if (scroll) {
        liveSec.scrollIntoView({behavior: 'smooth'});
      }
    };

    const pageSize = 25;
    let standingsPage = 1;
    let gamesPage = 1;

    const formatUtcDateStr = ts => {
      if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return '—';
      return new Date(ts * 1000).toISOString().slice(0, 10);
    };
    const entrantSubmittedByVer = new Map();
    if (Array.isArray(pageInit.entrants)) {
      for (const e of pageInit.entrants) {
        if (e && e.versionId && e.submittedAt) {
          entrantSubmittedByVer.set(e.versionId, e.submittedAt);
        }
      }
    }

    const renderStandings = () => {
      if (standingsSec) {
        const h3Link = standingsSec.querySelector('h3 a');
        if (h3Link) h3Link.textContent = status === 'scheduled' ? 'Entrants' : 'Standings';
      }
      if (gamesSec) {
        gamesSec.classList.toggle('hide', status === 'scheduled');
      }
      const bodyEl = document.getElementById('standings-body');
      if (!bodyEl || !Array.isArray(standings) || standings.length === 0) return;
      const total = standings.length;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      if (standingsPage > totalPages) standingsPage = totalPages;
      if (standingsPage < 1) standingsPage = 1;
      const start = (standingsPage - 1) * pageSize;
      const hideCls = totalPages <= 1 ? ' hide' : '';
      const prevDis = standingsPage <= 1 ? ' disabled' : '';
      const nextDis = standingsPage >= totalPages ? ' disabled' : '';
      const word = total === 1 ? 'entrant' : 'entrants';
      const info = 'Page ' + standingsPage + ' of ' + totalPages +
        ' (' + total.toLocaleString('en-US') + ' ' + word + ')';

      if (status === 'scheduled') {
        const ordered = [...standings].sort((a, b) => {
          const sa = a.submittedAt || entrantSubmittedByVer.get(a.versionId) || 0;
          const sb = b.submittedAt || entrantSubmittedByVer.get(b.versionId) || 0;
          return sa - sb || (a.rank || 0) - (b.rank || 0);
        });
        const rows = ordered.map((e, idx) => {
          const hideAttr = (idx < start || idx >= start + pageSize) ? ' class="hide"' : '';
          const subTs = e.submittedAt || entrantSubmittedByVer.get(e.versionId);
          return '<tr' + hideAttr + '>' +
            '<td><strong>' + (idx + 1) + '</strong></td>' +
            '<td>' + formatAgentLink(e.name, e.slug, true) +
            ' <code>' + esc(e.version) + '</code></td>' +
            '<td class="num muted">' + esc(formatUtcDateStr(subTs)) + '</td>' +
            '</tr>';
        }).join('');
        bodyEl.innerHTML = '<div class="table-wrap"><table><thead><tr>' +
          '<th>#</th><th>Agent</th><th class="num">Submitted</th>' +
          '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
          '<div class="pager' + hideCls +
          '" id="standings-pager" aria-label="Entrants pagination" ' +
          'data-table-pager data-page-size="25" data-singular="entrant" data-plural="entrants">' +
          '<button type="button" class="pager-btn" id="standings-pager-prev" ' +
          'data-pager-prev' + prevDis + '>&larr; Prev</button>' +
          '<span class="pager-info muted" id="standings-pager-info" data-pager-info>' +
          esc(info) + '</span>' +
          '<button type="button" class="pager-btn" id="standings-pager-next" ' +
          'data-pager-next' + nextDis + '>Next &rarr;</button></div>';
        return;
      }

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
        ' ' + unitPlural + ' (+1.0 per win, +0.5 per tie)';
      const wltTitle = isMultiGame
        ? ('Best-of-' + bestOf + ' match Wins – Losses – Ties')
        : 'Standalone individual game Wins – Losses – Ties';
      bodyEl.innerHTML = '<div class="table-wrap"><table><thead><tr>' +
        '<th>#</th><th>Agent</th>' +
        '<th class="num" title="Tournament MAP Elo ± 95% CI">Elo</th>' +
        '<th class="num" title="' + esc(wltTitle) + '">W–L–T</th>' +
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
        bodyEl.innerHTML = '<p class="empty-state muted">No round-robin ' + unitPlural +
          ' completed yet.</p>';
        return;
      }

      crosstableSec.classList.remove('hide');
      const pairMap = new Map();
      for (const p of rrPairs) {
        pairMap.set(p.low.versionId + ':' + p.high.versionId, p);
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
          const wins = pair ? (isLow ? pair.low.wins : pair.high.wins) : 0;
          const losses = pair ? (isLow ? pair.high.wins : pair.low.wins) : 0;
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
      const p1NameHtml = formatAgentLink(p1.name, p1.slug, false);
      const p1SpritesHtml = renderPartyMinisprites(p1.team) || '&nbsp;';
      const p2NameHtml = formatAgentLink(p2.name, p2.slug, false);
      const p2SpritesHtml = renderPartyMinisprites(p2.team) || '&nbsp;';
      const turn = parseLatestTurn(tb.lines);
      const tip = turn !== undefined
        ? ('Spectate live on ' + tb.label + ' (Turn ' + turn + ')')
        : ('Spectate live on ' + tb.label);

      const tr = document.createElement('tr');
      tr.className = 'live-game-row';
      tr.setAttribute('data-live-game-table', String(tb.table));
      tr.innerHTML =
        '<td><a href="#live" class="subtle" data-live-table="' + tb.table +
          '" title="' + esc(tip) + '"><code>' + esc(gameCode) + '</code></a></td>' +
        '<td>' + p1NameHtml + '</td>' +
        '<td>' + p1SpritesHtml + '</td>' +
        '<td>' + p2NameHtml + '</td>' +
        '<td>' + p2SpritesHtml + '</td>' +
        '<td class="center"><a href="#live" class="live-pill" data-live-table="' + tb.table +
          '" title="' + esc(tip) + '">&#9679; T' + tb.table + '</a></td>' +
        '<td class="num muted">—</td>';
      return tr;
    };

    const renderSeriesGameCardHtml = (gm, showGameNum) => {
      const end = formatEndReason(gm.endReason || 'normal');
      const endSuffix = end.show ? (' · ' + end.html) : '';
      const p1 = gm.p1 || {};
      const p2 = gm.p2 || {};
      const outcomePrefix = showGameNum ? (formatGameOutcomeHtml(gm.outcome || 'T') + ' · ') : '';
      return '<div class="battle-detail-card">' +
        '<div class="battle-detail-title">' +
          '<span>' + (showGameNum ? ('Game ' + gm.gameNumber) : 'Game') + '</span>' +
          '<span class="battle-detail-sub">' +
            outcomePrefix + '<tt>' + (gm.turns || 0) + ' turns</tt>' + endSuffix +
          '</span>' +
        '</div>' +
        '<div class="battle-detail-line">' +
          '<span><tt>P1</tt></span>' +
          formatGamePlayerTelemetryHtml(p1) +
        '</div>' +
        '<div class="battle-detail-line">' +
          '<span><tt>P2</tt></span>' +
          formatGamePlayerTelemetryHtml(p2) +
        '</div>' +
      '</div>';
    };

    const renderTournamentGameDetailHtml = g => {
      const preemptPrefix = g.preemptions > 0
        ? '<span class="muted">Preemptions:</span> <code>' + g.preemptions + '</code> · '
        : '';
      const games = Array.isArray(g.games) ? g.games : [];
      const isMulti = isMultiGame || games.length > 1;
      const logUrls = games.map((gm, idx) => gm.logHref || (idx === 0 ? g.logHref : '') || '');
      const hasReplay = logUrls.some(Boolean);

      let replayAttrs = '';
      if (hasReplay) {
        replayAttrs = ' data-match-id="' + esc(g.id) +
          '" data-p1-name="' + esc(g.p1.name) +
          '" data-p2-name="' + esc(g.p2.name) + '"';
        logUrls.forEach((u, idx) => {
          if (u) replayAttrs += ' data-g' + (idx + 1) + '-log="' + esc(u) + '"';
        });
        if (isMulti) {
          replayAttrs += ' data-total-games="' + games.length + '" data-same-seats="1"';
        } else {
          replayAttrs += ' data-single-game="1"';
        }
      }

      const seedsHtml = games.map(gm => '<code>' + esc(gm.seed) + '</code>').join(' · ');
      const cardsHtml = games.map(gm => renderSeriesGameCardHtml(gm, isMulti)).join('');
      const gridCls = games.length >= 3 ? 'battle-detail-grid bo3-grid' : 'battle-detail-grid';
      const bodyHtml = isMulti ? '<div class="' + gridCls + '">' + cardsHtml + '</div>' : cardsHtml;

      return '<div class="battle-detail"' + replayAttrs + '>' +
        '<div class="battle-detail-meta">' +
          '<span class="muted">' + esc(utcStr(g.completedAt)) + '</span>' +
          '<span>' + preemptPrefix +
            '<span class="muted">' + (isMulti ? 'Seeds:' : 'Seed:') + '</span> ' + seedsHtml +
          '</span>' +
        '</div>' +
        bodyHtml +
      '</div>';
    };

    const formatTournamentResultHtml = g => {
      const p1Won = g.outcome === 'W';
      const p2Won = g.outcome === 'L';
      const games = Array.isArray(g.games) ? g.games : [];
      if (isMultiGame || games.length > 1) {
        let s1 = 0;
        let s2 = 0;
        for (const gm of games) {
          if (gm.outcome === 'W') s1 += 1;
          else if (gm.outcome === 'L') s2 += 1;
          else if (gm.outcome === 'T') {
            s1 += 0.5;
            s2 += 0.5;
          }
        }
        const fmt = v => (Number.isInteger(v) ? String(v) : v.toFixed(1));
        const s1Str = fmt(s1);
        const s2Str = fmt(s2);
        return p1Won
          ? '<strong>' + s1Str + '</strong>–' + s2Str
          : p2Won
            ? s1Str + '–<strong>' + s2Str + '</strong>'
            : s1Str + '–' + s2Str;
      }
      return p1Won
        ? '<strong>1</strong>–0'
        : p2Won
          ? '0–<strong>1</strong>'
          : '½–½';
    };

    const buildCompletedGameRowEl = (g, nowSec) => {
      const codePrefix = g.stage === 'Superfinal' ? 'SF' : 'RR';
      const codeNum = g.stage === 'Superfinal' ? g.matchupGame : g.cycle;
      const gameCode = codePrefix + codeNum;

      const p1Won = g.outcome === 'W';
      const p2Won = g.outcome === 'L';
      const resHtml = formatTournamentResultHtml(g);

      const p1NameHtml = formatAgentLink(g.p1.name, g.p1.slug, p1Won);
      const p1SpritesHtml = renderPartyMinisprites(g.p1.team) || '&nbsp;';
      const p2NameHtml = formatAgentLink(g.p2.name, g.p2.slug, p2Won);
      const p2SpritesHtml = renderPartyMinisprites(g.p2.team) || '&nbsp;';

      const tsTitle = utcStr(g.completedAt);
      const rel = relTime(nowSec, g.completedAt);

      const tr = document.createElement('tr');
      tr.className = 'battle-row';
      tr.setAttribute('data-game-id', g.id);
      tr.tabIndex = 0;
      tr.setAttribute('aria-expanded', 'false');
      tr.innerHTML =
        '<td><span class="battle-toggle" aria-hidden="true">&#9656;</span><code title="' +
          esc(g.id) + '">' + esc(gameCode) + '</code></td>' +
        '<td>' + p1NameHtml + '</td>' +
        '<td>' + p1SpritesHtml + '</td>' +
        '<td>' + p2NameHtml + '</td>' +
        '<td>' + p2SpritesHtml + '</td>' +
        '<td class="center">' + resHtml + '</td>' +
        '<td class="num muted" title="' + esc(tsTitle) + '" data-ts="' + g.completedAt + '">' +
          esc(rel) + '</td>';

      const detailTr = document.createElement('tr');
      detailTr.className = 'battle-detail-row hide';
      detailTr.dataset.detailFor = g.id;
      detailTr.innerHTML = '<td colspan="7">' + renderTournamentGameDetailHtml(g) + '</td>';
      return [tr, detailTr];
    };

    const applyGamesPager = () => {
      if (!gamesTbody) return;
      if (window.__sweepMinisprites) window.__sweepMinisprites(gamesTbody);
      const rows = Array.from(
        gamesTbody.querySelectorAll('tr:not(.empty-row):not(.battle-detail-row)')
      );
      const total = rows.length;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      if (gamesPage > totalPages) gamesPage = totalPages;
      if (gamesPage < 1) gamesPage = 1;
      const start = (gamesPage - 1) * pageSize;
      rows.forEach((row, idx) => {
        const hidden = idx < start || idx >= start + pageSize;
        row.classList.toggle('hide', hidden);
        const detail = row.nextElementSibling;
        if (detail && detail.classList.contains('battle-detail-row') && hidden) {
          detail.classList.add('hide');
          row.classList.remove('expanded');
          row.setAttribute('aria-expanded', 'false');
        }
      });
      const pager = document.getElementById('games-pager');
      const prevBtn = document.getElementById('games-pager-prev');
      const nextBtn = document.getElementById('games-pager-next');
      const infoEl = document.getElementById('games-pager-info');
      if (pager && prevBtn && nextBtn && infoEl) {
        pager.classList.toggle('hide', totalPages <= 1);
        prevBtn.disabled = gamesPage <= 1;
        nextBtn.disabled = gamesPage >= totalPages;
        const word = total === 1 ? unitSingular : unitPlural;
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
        gamesTbody.innerHTML = '<tr class="empty-row"><td colspan="7" class="center muted">' +
          'No completed ' + unitPlural + ' yet.</td></tr>';
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
        const games = Array.isArray(g.games) ? g.games : [];
        const logUrls = games.map((gm, idx) => gm.logHref || (idx === 0 ? g.logHref : '') || '');
        if (logUrls.some(Boolean)) {
          const detail = existing.nextElementSibling;
          if (detail && detail.classList.contains('battle-detail-row')) {
            const slot = detail.querySelector('.battle-detail');
            if (slot && !slot.getAttribute('data-g1-log')) {
              slot.setAttribute('data-match-id', g.id);
              slot.setAttribute('data-p1-name', g.p1.name);
              slot.setAttribute('data-p2-name', g.p2.name);
              logUrls.forEach((u, idx) => {
                if (u) slot.setAttribute('data-g' + (idx + 1) + '-log', u);
              });
              if (isMultiGame || games.length > 1) {
                slot.setAttribute('data-total-games', String(games.length));
                slot.setAttribute('data-same-seats', '1');
              } else {
                slot.setAttribute('data-single-game', '1');
              }
            }
          }
        }
        return;
      }
      const emptyRow = gamesTbody.querySelector('.empty-row');
      if (emptyRow) emptyRow.remove();
      const nowSec = Math.floor(Date.now() / 1000);
      const pair = buildCompletedGameRowEl(g, nowSec);
      let anchor = gamesTbody.firstElementChild;
      while (anchor && anchor.classList.contains('live-game-row')) {
        anchor = anchor.nextElementSibling;
      }
      gamesTbody.insertBefore(pair[1], anchor);
      gamesTbody.insertBefore(pair[0], pair[1]);
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
          '</span> ' + unitPlural + ') · <a href="' + esc(jsonHref) +
          '"><code>index.json</code></a>';
      } else {
        gamesArchiveMeta.innerHTML = 'Data: <a href="' + esc(jsonHref) +
          '"><code>index.json</code></a> (<span id="games-count">' + countStr + '</span> ' +
          unitPlural +
          (status !== 'completed' ? '; replay archive published upon completion' : '') + ')';
      }
    };

    if (liveSec) {
      liveSec.addEventListener('change', ev => {
        const target = ev.target instanceof Element ? ev.target : undefined;
        const radio = target ? target.closest('input[data-table-num]') : undefined;
        if (!radio) return;
        const num = Number(radio.getAttribute('data-table-num')) || 1;
        showLiveTable(num, false);
      });
    }

    const toggleGameRow = (row, forceOpen) => {
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

    if (gamesTbody) {
      gamesTbody.addEventListener('keydown', ev => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        const target = ev.target instanceof Element ? ev.target : undefined;
        const row = target ? target.closest('tr.battle-row') : undefined;
        if (row && target === row) {
          ev.preventDefault();
          toggleGameRow(row);
        }
      });
    }

    document.addEventListener('click', ev => {
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

      const replayLink = target.closest('a[data-replay-log]');
      if (replayLink) {
        const detailRow = replayLink.closest('tr.battle-detail-row');
        const slot = detailRow
          ? detailRow.querySelector('.battle-detail[data-match-id]')
          : undefined;
        if (slot) {
          ev.preventDefault();
          const gNum = Number(replayLink.getAttribute('data-replay-game')) || 1;
          void loadRowReplay(slot, gNum);
          return;
        }
      }

      if (target.closest('a')) return;
      const gameRow = target.closest('#games-tbody tr.battle-row');
      if (gameRow) {
        toggleGameRow(gameRow);
      }
    });

    setInterval(() => {
      const state = clockStateByTable.get(selectedTable);
      if (!state) return;
      const nowMillis = Date.now();
      for (const slot of ['p1', 'p2']) {
        const side = state[slot];
        if (!side) continue;
        const clockEl = document.getElementById('clock-' + slot);
        if (!clockEl) continue;
        const elapsed = Math.floor((nowMillis - side.syncMillis) / 1000);
        const rem = Math.max(0, Math.round(side.bankSeconds - elapsed));
        clockEl.textContent = formatClockMmSs(rem);
        const pillEl = document.getElementById('clock-pill-' + slot);
        if (pillEl) {
          pillEl.title = rem + 's remaining in ' + startingBankSeconds +
            's bank (currently thinking)';
        }
      }
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
          syncAllTableClocks(Date.now(), false);
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
            const cur = getTable(selectedTable);
            const liveTbs = getLiveTables();
            const targetNum = (cur && !cur.idle && cur.live !== false)
              ? selectedTable
              : (liveTbs[0] ? liveTbs[0].table : getTables()[0].table);
            showLiveTable(targetNum, false);
          } else if (liveSec) {
            liveSec.classList.add('hide');
            renderClocks(undefined);
          }

          if (status === 'completed' && !broadcast) {
            es.close();
          }
        } catch {}
      });

      es.addEventListener('broadcast', ev => {
        try {
          broadcast = JSON.parse(ev.data);
          syncAllTableClocks(Date.now(), false);
          if (getLiveTables().some(tb => tb.stage === 'Superfinal')) hasSuperfinal = true;
          syncLiveGameRows();
          renderStandings();
          renderCrosstable();
          const cur = getTable(selectedTable);
          const liveTbs = getLiveTables();
          const targetNum = (cur && !cur.idle && cur.live !== false)
            ? selectedTable
            : (liveTbs[0] ? liveTbs[0].table : (getTables()[0] ? getTables()[0].table : 1));
          showLiveTable(targetNum, false);
        } catch {}
      });

      es.addEventListener('table-load', ev => {
        try {
          const data = JSON.parse(ev.data);
          if (!data) return;
          if (data.broadcast) broadcast = data.broadcast;
          const loaded = data.table;
          const nowMillis = Date.now();
          syncAllTableClocks(nowMillis, false);
          if (loaded) {
            syncTableClock(getTable(loaded.table) || loaded, nowMillis, true);
            if (loaded.stage === 'Superfinal') hasSuperfinal = true;
          }
          syncLiveGameRows();
          renderStandings();
          renderCrosstable();
          const cur = getTable(selectedTable);
          const wasHidden = !liveSec || liveSec.classList.contains('hide');
          const curInactive = !cur || cur.idle || cur.live === false;
          if (loaded && (loaded.table === selectedTable || wasHidden || curInactive)) {
            showLiveTable(loaded.table, false);
          } else {
            renderTableNav();
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
          const newP1Lines = Array.isArray(data.p1Lines) ? data.p1Lines : undefined;
          const newP2Lines = Array.isArray(data.p2Lines) ? data.p2Lines : undefined;
          tb.lines = (Array.isArray(tb.lines) ? tb.lines : []).concat(newLines).slice(-10000);
          if (newP1Lines) {
            tb.p1Lines = (Array.isArray(tb.p1Lines) ? tb.p1Lines : [])
              .concat(newP1Lines)
              .slice(-10000);
          }
          if (newP2Lines) {
            tb.p2Lines = (Array.isArray(tb.p2Lines) ? tb.p2Lines : [])
              .concat(newP2Lines)
              .slice(-10000);
          }
          if (data.p1) tb.p1 = data.p1;
          if (data.p2) tb.p2 = data.p2;
          if (typeof data.live === 'boolean') tb.live = data.live;
          if (data.updatedAt) tb.updatedAt = data.updatedAt;
          const nowMillis = Date.now();
          syncTableClock(tb, nowMillis, newLines.length > 0);

          if (gamesTbody) {
            const liveRow = gamesTbody.querySelector(
              'tr.live-game-row[data-live-game-table="' + tb.table + '"]'
            );
            if (liveRow) {
              const turn = parseLatestTurn(tb.lines);
              if (turn !== undefined) {
                const tip = 'Spectate live on ' + tb.label + ' (Turn ' + turn + ')';
                liveRow.querySelectorAll('[data-live-table]').forEach(el => {
                  el.setAttribute('title', tip);
                });
              }
            }
          }

          if (tb.table === selectedTable) {
            if (tb.p1 && tb.p2) {
              renderClocks(tb, nowMillis);
            }
            const p1Pokemon = tb.p1 && Array.isArray(tb.p1.pokemon) ? tb.p1.pokemon : undefined;
            const p2Pokemon = tb.p2 && Array.isArray(tb.p2.pokemon) ? tb.p2.pokemon : undefined;
            if (pendingPayload && Array.isArray(pendingPayload.lines)) {
              pendingPayload.lines = tb.lines;
              pendingPayload.p1Lines = tb.p1Lines;
              pendingPayload.p2Lines = tb.p2Lines;
              pendingPayload.p1Pokemon = p1Pokemon;
              pendingPayload.p2Pokemon = p2Pokemon;
              pendingPayload.live = tb.live !== false;
            }
            if (viewerReady && newLines.length > 0) {
              sendToViewer({
                type: 'append',
                lines: newLines,
                p1Lines: newP1Lines,
                p2Lines: newP2Lines,
                p1Pokemon,
                p2Pokemon,
              });
            }
          }
        } catch {}
      });

      es.addEventListener('table-idle', ev => {
        try {
          const data = JSON.parse(ev.data);
          if (!data) return;
          if (data.broadcast) broadcast = data.broadcast;
          syncAllTableClocks(Date.now(), false);
          syncLiveGameRows();
          renderStandings();
          renderCrosstable();
          renderTableNav();
          if (data.table === selectedTable) {
            renderClocks(undefined);
            const tb = getTable(selectedTable);
            if (seriesRightEl && tb) {
              seriesRightEl.innerHTML = renderSeriesRightForTable(tb);
            }
          }
        } catch {}
      });

      es.addEventListener('broadcast-end', ev => {
        try {
          const data = JSON.parse(ev.data);
          if (data && data.status) status = data.status;
        } catch {}
        broadcast = undefined;
        clockStateByTable.clear();
        renderClocks(undefined);
        syncLiveGameRows();
        renderArchiveMeta();
        renderStandings();
        renderCrosstable();
        renderTableNav();
        if (status === 'completed') {
          es.close();
        }
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
          const nowMillis = Date.now();
          syncAllTableClocks(nowMillis, false);
          if (data.game && data.game.stage === 'Superfinal') hasSuperfinal = true;

          syncLiveGameRows();
          if (data.game) {
            prependCompletedGameRow(data.game);
          }
          renderArchiveMeta();
          renderStandings();
          renderCrosstable();
          renderTableNav();

          const tb = getTable(selectedTable);
          if (tb && tb.p1 && tb.p2 && !tb.idle) {
            renderClocks(tb, nowMillis);
            if (seriesRightEl) {
              seriesRightEl.innerHTML = renderSeriesRightForTable(tb);
            }
          } else {
            renderClocks(undefined);
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
          renderStandings();
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
  links: render.AgentLinkContext;
  staticDir?: string;
  tournamentBroadcast?: arena.LiveBroadcast;
  liveTournament?: {id: string; name: string};
  nowSec?: number;
}): {html: string; json: arena.TournamentDocument} {
  const {
    db,
    renderer,
    tournament: t,
    links,
    staticDir = util.root('static'),
    tournamentBroadcast,
    liveTournament,
    nowSec = Math.floor(Date.now() / 1000),
  } = opts;
  const {publicDir} = links;

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

  const isMultiGame = t.bestOf > 1;
  const n = entrants.length;
  const rrTotal = n >= 2 ? ((n * (n - 1)) / 2) * t.gamesPerMatchup : 0;
  const fmtTitle = render.FORMAT_TITLES[t.format] ?? t.format;
  const timer = arena.timerSettingsForFormat(t.format, t.rules);
  const rrUnit = isMultiGame ? `Bo${t.bestOf} matches` : 'games';
  const sfSuffix = hasSf
    ? (isMultiGame ? ' + 100-match Superfinal' : ' + 100-game Superfinal')
    : '';

  const closesAt = db.getTournamentClosesAt(t.startsAt);
  const scheduleLine = t.status === 'scheduled'
    ? `Starts ${util.formatUtcDateTime(t.startsAt)} · ` +
      `Entries close ${util.formatUtcDateTime(closesAt)}`
    : t.completedAt
      ? `Started ${util.formatUtcDate(t.startsAt)} · Completed ${util.formatUtcDate(t.completedAt)}`
      : `Started ${util.formatUtcDateTime(t.startsAt)}`;

  const standingsNode = renderTournamentStandingsNode({
    tournament: t,
    entrants,
    hasSuperfinal: hasSf,
    liveTables,
    links,
  });
  const crossRes = renderTournamentCrosstableNode({
    bestOf: t.bestOf,
    entrants,
    pairs: rrPairs,
    liveTables,
    links,
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
    links,
    logFiles,
    nowSec,
  });

  const agentLinks: Record<string, string> = {};
  for (const e of entrants) {
    const href = render.resolveAgentHref(links, e.agentSlug, e.agentName);
    if (href) agentLinks[e.agentSlug] = href;
  }

  const json = arena.buildTournamentDocument(db, publicDir, t, 10_000, {
    entrants,
    games,
    rrPairs,
    sfPairs,
    logFiles,
  });

  const pageInit = {
    tournamentId: t.id,
    format: t.format,
    bestOf: t.bestOf,
    gamesPerMatchup: t.gamesPerMatchup,
    startingBankSeconds: timer.startingSeconds,
    maxTurnSeconds: timer.maxPerTurnSeconds,
    isVgcTimer: timer.timeoutAutoChoose,
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
      submittedAt: e.submittedAt,
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
        {rrTotal.toLocaleString('en-US')} {rrUnit}){sfSuffix}<br />
        {scheduleLine}<br />
        {t.hardware} · {timer.addPerTurnSeconds > 0 ? (
          <>
            <tt>{timer.startingSeconds}s</tt> bank (<tt>+{timer.addPerTurnSeconds}s/turn</tt>)
          </>
        ) : (
          <>
            <tt>{timer.startingSeconds}s</tt> Your Time (<tt>{timer.maxFirstTurnSeconds}s</tt>{' '}
            preview, <tt>{timer.maxPerTurnSeconds}s/turn</tt>)
          </>
        )}
      </p>

      {renderTournamentRulesNode(staticDir, t.id)}

      <section id='live' className={broadcastRes.isActive ? undefined : 'hide'}>
        {broadcastRes.node}
      </section>

      <section id='standings'>
        <h3>
          <a href='#standings' className='subtle'>
            {t.status === 'scheduled' ? 'Entrants' : 'Standings'}
          </a>
        </h3>
        {standingsNode}
      </section>

      <section id='crosstable' className={crossRes.isEmpty ? 'hide' : undefined}>
        <h3><a href='#crosstable' className='subtle'>Crosstable</a></h3>
        {crossRes.node}
      </section>

      <section id='games' className={t.status === 'scheduled' ? 'hide' : undefined}>
        <h3><a href='#games' className='subtle'>{isMultiGame ? 'Matches' : 'Games'}</a></h3>
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
