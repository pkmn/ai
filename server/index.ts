require('source-map-support').install();

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

import polka from 'polka';
import serveStatic from 'serve-static';
import {serve} from 'site';

import {Database} from '../db';
import * as build from '../static/build';
import * as util from '../static/util';

import * as account from './account';
import * as admin from './admin';
import * as arena from './arena';
import {Auth} from './auth';
import * as discord from './discord';
import * as render from './render';
import * as system from './system';
import * as wiki from './wiki';

// Hardcoded port 1234 (no `PORT`/`HOST`/`PUBLIC_URL` env overrides). Production binds loopback
// behind `config/nginx.conf`; non-production boots via `site.serve` for live rebuilds.
const PORT = 1234;
const HOST = '127.0.0.1';
// Exceed nginx `upstream pkmn_node` `keepalive_timeout` (30s) so nginx closes idle pooled sockets
// before Node does, avoiding intermittent 502s from FIN/RST races on reused upstream connections.
export const KEEP_ALIVE_TIMEOUT_MILLIS = 65_000;
export const HEADERS_TIMEOUT_MILLIS = 66_000;

export interface ServerAppOptions {
  db: Database;
  app?: polka.Polka;
  publicDir?: string;
  enableDiscord?: boolean;
  armWatchdogOnStart?: boolean;
}

export interface ServerAppHandle {
  app: polka.Polka;
  arenaHandle: arena.Handle;
  discordHandle?: discord.Handle;
  close: () => void;
}

function resolveSafeHttpStatus(err: unknown): number {
  const status = (err as {status?: unknown} | undefined)?.status;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599) {
    return status;
  }
  return 500;
}

function wantsJsonError(req: http.IncomingMessage): boolean {
  const pathname = (req.url ?? '/').split('?')[0];
  if (pathname.startsWith('/api/') || pathname.endsWith('.json')) return true;
  const accept = String(req.headers.accept ?? '');
  return accept.includes('application/json') && !accept.includes('text/html');
}

export function installSafeErrorHandlers(app: polka.Polka, db?: Database): void {
  type RouteFn = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    next: (err?: unknown) => void
  ) => unknown;

  const router = app as unknown as {
    onError: (
      err: unknown,
      req: http.IncomingMessage,
      res: http.ServerResponse
    ) => void;
    onNoMatch: (req: http.IncomingMessage, res: http.ServerResponse) => void;
    add: (method: string, pattern: string, ...fns: RouteFn[]) => unknown;
  };

  router.onError = (err, req, res) => {
    const status = resolveSafeHttpStatus(err);
    if (status >= 500) {
      console.error('Unhandled request error:', err);
    }
    if (res.headersSent || res.writableEnded || res.destroyed) {
      if (!res.writableEnded && !res.destroyed) res.end();
      return;
    }
    const message = http.STATUS_CODES[status] ?? 'Internal Server Error';
    if (wantsJsonError(req)) {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({error: message}));
      return;
    }
    res.statusCode = status;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(build.renderErrorPage(status, db?.getRunningTournament()));
  };

  router.onNoMatch = (req, res) => {
    if (res.headersSent || res.writableEnded || res.destroyed) return;
    if (wantsJsonError(req)) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({error: 'Not Found'}));
      return;
    }
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader(
      'Cache-Control',
      build.accountContext.getStore()?.authenticated ? 'private, no-cache' : 'no-cache'
    );
    res.setHeader('Vary', 'Cookie');
    res.end(build.renderErrorPage(404, db?.getRunningTournament()));
  };

  const wrapFn = (fn: RouteFn): RouteFn => (req, res, next) => {
    try {
      const out = fn(req, res, next);
      if (out && typeof (out as PromiseLike<unknown>).then === 'function') {
        (out as PromiseLike<unknown>).then(undefined, err => {
          router.onError(err, req, res);
        });
      }
    } catch (err) {
      router.onError(err, req, res);
    }
  };

  const origAdd = router.add.bind(router);
  router.add = (method, pattern, ...fns) => origAdd(method, pattern, ...fns.map(wrapFn));

  for (const verb of ['get', 'post', 'put', 'delete', 'patch', 'head', 'all'] as const) {
    const rec = router as unknown as Record<
      string,
      (pattern: string, ...fns: RouteFn[]) => unknown
    >;
    if (typeof rec[verb] === 'function') {
      const upper = verb === 'all' ? '*' : verb.toUpperCase();
      rec[verb] = (pattern: string, ...fns: RouteFn[]) => router.add(upper, pattern, ...fns);
    }
  }

  const origHandler = (app.handler as (req: http.IncomingMessage, res: http.ServerResponse) => void)
    .bind(app);
  (app as unknown as {handler: http.RequestListener}).handler = (req, res) => {
    try {
      const out = origHandler(req, res) as unknown;
      if (out && typeof (out as PromiseLike<unknown>).then === 'function') {
        (out as PromiseLike<unknown>).then(undefined, err => {
          router.onError(err, req, res);
        });
      }
    } catch (err) {
      router.onError(err, req, res);
    }
  };
}

const STATIC_HTML_SKIP_RE =
  /^\/(?:account|admin|wiki|projects|arena|api|auth|chat|private)(?:\.json|\/|$)/i;
const STATIC_ERROR_HTML_RE = /^\/(?:400|401|403|404|500|502|503|504)\.html$/i;

// Serves pre-built `public/**/*.html` essays inside `accountContext` so `#account-link` renders
// server-side with `Vary: Cookie` and `ETag` (`304`) across every page on the site.
export function createStaticHtmlMiddleware(publicDir: string) {
  const publicRoot = path.resolve(publicDir);
  return (req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    const [rawPath, query] = (req.url ?? '/').split('?', 2);
    if (!rawPath.startsWith('/')) {
      next();
      return;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawPath);
    } catch {
      next();
      return;
    }
    if (decoded.includes('\0')) {
      next();
      return;
    }
    const resolved = path.resolve(publicRoot, `.${decoded}`);
    if (resolved !== publicRoot && !resolved.startsWith(`${publicRoot}${path.sep}`)) {
      next();
      return;
    }
    const rel = path.relative(publicRoot, resolved);
    const canonicalPath = rel ? `/${rel.split(path.sep).join('/')}` : '/';
    if (STATIC_HTML_SKIP_RE.test(canonicalPath) || STATIC_ERROR_HTML_RE.test(canonicalPath)) {
      next();
      return;
    }
    let st: fs.Stats;
    try {
      st = fs.statSync(resolved);
    } catch {
      next();
      return;
    }
    let file = resolved;
    if (st.isDirectory()) {
      const indexFile = path.join(resolved, 'index.html');
      if (!fs.existsSync(indexFile) || fs.statSync(indexFile).size === 0) {
        next();
        return;
      }
      const canonicalDir = rel
        ? `/${rel.split(path.sep).map(encodeURIComponent).join('/')}/`
        : '/';
      if (rawPath !== canonicalDir) {
        res.writeHead(301, {Location: `${canonicalDir}${query ? `?${query}` : ''}`});
        res.end();
        return;
      }
      file = indexFile;
    } else if (!st.isFile() || !resolved.endsWith('.html') || st.size === 0) {
      next();
      return;
    }
    const rawHtml = fs.readFileSync(file, 'utf8');
    const profile = build.accountContext.getStore();
    const body = Buffer.from(build.applyAccountProfile(rawHtml, profile), 'utf8');
    const etag = `"${crypto.createHash('sha1').update(body).digest('hex')}"`;
    res.setHeader('Cache-Control', profile?.authenticated ? 'private, no-cache' : 'no-cache');
    res.setHeader('Vary', 'Cookie');
    res.setHeader('ETag', etag);
    if (util.matchesIfNoneMatch(req.headers['if-none-match'], etag)) {
      res.statusCode = 304;
      res.end();
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(body);
  };
}

function syncBannerFor(db: Database, publicDir: string) {
  try {
    build.syncStaticLiveBanner(publicDir, db.getRunningTournament());
  } catch (err) {
    console.error('Failed syncing static live tournament banner:', err);
  }
}

export function createServerApp(options: ServerAppOptions): ServerAppHandle {
  const {db} = options;
  const publicDir = options.publicDir ?? render.PUBLIC_DIR;
  const isMock = process.env.MOCK === '1';
  const app = options.app ?? polka();
  installSafeErrorHandlers(app, db);
  const traffic = new system.TrafficTracker();
  app.use(traffic.middleware());
  const vpsMonitor = new system.VpsHostMonitor({
    dbPath: db.dbPath,
    traffic,
  });
  const registrationMonitor = new admin.RegistrationIssueMonitor();
  if (!isMock && !process.env.VITEST) {
    vpsMonitor.start();
    registrationMonitor.start();
  }

  // `static/build.tsx` writes 0-byte `index.html` stubs for `/account`, `/arena`, `/projects`, and
  // `/wiki` so `@untitaker/hyperlink` (`hyperlink public --check-anchors`) validates internal `.dj`
  // links. Bypass `serve-static` for dynamic SSR/API routes and gate static ladder archives/logs on
  // the ladder's publication status (`random`, or `pools` strictly after `status === 'archived'`).
  type Middleware = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    next: (err?: unknown) => void
  ) => void;
  const staticWare = serveStatic(publicDir) as unknown as Middleware;
  const gatedStaticWare: Middleware = (req, res, next) => {
    const [pathname, query] = (req.url ?? '/').split('?');
    const ladderAssetMatch = /^\/arena\/ladders\/([^/]+)\/([^/]+)$/.exec(pathname);
    if (ladderAssetMatch && /\.(?:7z|tar|log)$/i.test(ladderAssetMatch[2])) {
      let ladderId = ladderAssetMatch[1];
      try {
        ladderId = decodeURIComponent(ladderId);
      } catch {}
      const ladder = db.getLadder(ladderId);
      const canServe = Boolean(
        ladder && (
          ladder.team === 'random' ||
          (ladder.team === 'pools' && ladder.status === 'archived')
        )
      );
      if (!canServe || (/\.log$/i.test(ladderAssetMatch[2]) && Boolean(query))) {
        next();
        return;
      }
      if (ladder?.team === 'pools') {
        arena.promoteArchivedPoolsLogs(publicDir, ladder.id);
      }
      staticWare(req, res, next);
      return;
    }

    const isStaticArenaAsset =
      pathname === '/arena/viewer' ||
      pathname.startsWith('/arena/viewer/') ||
      (/^\/arena\/tournaments\/[^/]+\/[^/]+\.(?:7z|tar)$/i.test(pathname)) ||
      (/^\/arena\/tournaments\/[^/]+\/[^/]+\.log$/i.test(pathname) && !query);
    const isNonHtmlAsset = /\.[a-z0-9]{1,8}$/i.test(pathname) && !/\.html?$/i.test(pathname);
    if (!isStaticArenaAsset && (!isNonHtmlAsset || STATIC_HTML_SKIP_RE.test(pathname))) {
      next();
      return;
    }
    staticWare(req, res, next);
  };
  const wares = (app as unknown as {wares?: Middleware[]}).wares;
  if (options.app && wares?.[1]) {
    wares[1] = gatedStaticWare;
  } else {
    app.use(gatedStaticWare);
  }

  util.installHeadSupport(app);
  const wikiInstance = new wiki.Wiki({
    db,
    auth: new Auth({
      db,
      isAuthorizedGitHub: (login): boolean => wikiInstance.isDeveloper(login),
    }),
  });
  wikiInstance.auth.register(app);
  app.use(createStaticHtmlMiddleware(publicDir));
  let getArenaLastContactAt = (): number | undefined => undefined;
  let getLiveMatch = (): arena.LiveMatch | undefined => undefined;
  let getLiveTournamentGames = (): arena.LiveTournamentGame[] => [];
  const discordHandle = options.enableDiscord === false
    ? undefined
    : discord.register(app, {
      db,
      getArenaLastContactAt: () => getArenaLastContactAt(),
      getLiveMatch: () => getLiveMatch(),
      getLiveTournamentGames: () => getLiveTournamentGames(),
    });
  let notifyAdminHeartbeat = () => {};
  let notifyAdminSmokeQueue: (immediate?: boolean) => void = () => {};
  const arenaHandle = arena.register(app, {
    db,
    auth: wikiInstance.auth,
    publicDir,
    armWatchdogOnStart: options.armWatchdogOnStart,
    onHeartbeat: () => {
      notifyAdminHeartbeat();
    },
    onDiagnosticLive: (_payload, transition) => {
      notifyAdminSmokeQueue(transition);
    },
    onLiveMatch: discordHandle
      ? async match => {
        await discordHandle.notifyLiveMatch(match);
      }
      : undefined,
    onLiveTournamentGame: discordHandle
      ? async game => {
        await discordHandle.notifyLiveTournamentGame(game);
      }
      : undefined,
    onSubmissionStatus: discordHandle
      ? async result => {
        await discordHandle.notifySubmissionStatus(result);
      }
      : undefined,
    onWatchdogTimeout: discordHandle
      ? async alert => {
        await discordHandle.notifyWatchdogTimeout(alert);
      }
      : undefined,
    onStaffAlert: discordHandle
      ? async alert => {
        if (alert.resolved) {
          await discordHandle.resolveStaffAlert({key: alert.key, message: alert.message});
        } else {
          await discordHandle.notifyStaffAlert(alert);
        }
      }
      : undefined,
    onUpdate: reason => {
      if (reason === 'tournament-status') syncBannerFor(db, publicDir);
      if (reason === 'submission-status') notifyAdminSmokeQueue(true);
    },
  });
  account.register(app, {
    db,
    auth: wikiInstance.auth,
    arena: arenaHandle,
    onSubmissionChanged: () => notifyAdminSmokeQueue(true),
  });
  getArenaLastContactAt = () => arenaHandle.getState().lastContactAt;
  getLiveMatch = () => {
    const state = arenaHandle.getState();
    return state.stale ? undefined : state.live;
  };
  getLiveTournamentGames = () => arenaHandle.getActiveTournamentGames();
  const adminHandle = admin.register(app, {
    db,
    auth: wikiInstance.auth,
    arena: arenaHandle,
    wiki: wikiInstance,
    publicDir,
    vpsMonitor,
    registrationMonitor,
    getDiscordRoleMembers: discordHandle
      ? () => discordHandle.getAgentDiscordMembers()
      : undefined,
  });
  notifyAdminHeartbeat = () => adminHandle.notifyHeartbeat();
  notifyAdminSmokeQueue = immediate => adminHandle.notifySmokeQueue(immediate);

  if (isMock) {
    const mockStateFile = util.root('.mock', 'state.json');
    if (fs.existsSync(mockStateFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(mockStateFile, 'utf8')) as {
          now?: number;
          liveMatch?: arena.LiveMatch;
          liveStale?: boolean;
          tournamentBroadcast?: arena.LiveBroadcast;
        };
        arenaHandle.setLiveState({
          live: raw.liveMatch,
          stale: raw.liveStale,
          updatedAt: raw.now,
        });
        if (raw.tournamentBroadcast?.tournamentId) {
          arenaHandle.setTournamentBroadcast(raw.tournamentBroadcast);
        }
      } catch (err) {
        console.error('Failed hydrating mock Arena state:', err);
      }
    }
  }

  render.register(app, {
    db,
    arena: arenaHandle,
    publicDir,
  });
  wiki.register(app, wikiInstance);

  return {
    app,
    arenaHandle,
    discordHandle,
    close: () => {
      vpsMonitor.stop();
      registrationMonitor.stop();
      adminHandle.close();
      arenaHandle.close();
      discordHandle?.stop();
    },
  };
}

if (require.main === module) {
  const isMock = process.env.MOCK === '1';
  if (isMock && !fs.existsSync(util.root('.mock', 'ladders.yml'))) {
    console.error('Missing .mock/ directory — run "npm run mock -- seed" before MOCK=1.');
    process.exit(1);
  }

  // Reconcile `config/ladders.yml`, local `static/projects.yml`, and the live tournament topbar
  // banner synchronously on boot so SQLite is immediately populated even offline, then refresh
  // Smogon XenForo standings asynchronously in the background when `SMOGON_TOKEN` is configured.
  const db = new Database();
  db.syncLadders();
  try {
    db.syncProjects();
  } catch (err) {
    if (isMock || !process.env.SMOGON_TOKEN) {
      console.error('Offline project sync failed:', err);
    }
  }

  if (!isMock && process.env.SMOGON_TOKEN) {
    db.syncProjectsWithSmogon()
      .then(() => {
        syncBannerFor(db, render.PUBLIC_DIR);
      })
      .catch(err => {
        if (util.isConnectivityError(err)) {
          console.warn('Smogon unreachable; using offline projects.yml sync.');
        } else {
          console.error('Error syncing projects with Smogon:', err);
        }
      });
  }

  const hasPriorMatches = !isMock && db.getRecentMatches(1).length > 0;
  if (process.env.NODE_ENV !== 'production') {
    const dirs = {
      root: util.ROOT,
      out: util.root('build', 'static'),
      static: util.root('static'),
      extra: util.root('private'),
    };
    serve(PORT, dirs, app => {
      syncBannerFor(db, render.PUBLIC_DIR);
      createServerApp({
        app,
        db,
        armWatchdogOnStart: hasPriorMatches,
      });
    });
  } else {
    syncBannerFor(db, render.PUBLIC_DIR);
    if (!fs.existsSync(path.join(render.PUBLIC_DIR, 'index.html'))) {
      console.warn(
        'Warning: public/index.html not found — run "npm run build" to generate static pages.'
      );
    }
    const {app} = createServerApp({
      db,
      armWatchdogOnStart: hasPriorMatches,
    });
    const server = http.createServer((req, res) => {
      (app.handler as http.RequestListener)(req, res);
    });
    server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MILLIS;
    server.headersTimeout = HEADERS_TIMEOUT_MILLIS;
    server.listen(PORT, HOST, () => {
      console.log(`Listening on http://localhost:${PORT}`);
    });
  }
}
