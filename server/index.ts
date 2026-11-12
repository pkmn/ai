require('source-map-support').install();

import * as fs from 'fs';

import {serve} from 'site';

import {Database} from '../db';
import {ROOT, root} from '../static/util';

import * as account from './account';
import * as arena from './arena';
import {Auth} from './auth';
import * as discord from './discord';
import {PUBLIC_DIR, renderArenaPages, resolveStaticJsonUrl} from './render';
import * as wiki from './wiki';

const isMock = process.env.MOCK === '1';
if (isMock && !fs.existsSync(root('.mock', 'ladders.yml'))) {
  console.error('Missing .mock/ directory — run "npm run mock -- seed" before MOCK=1.');
  process.exit(1);
}

const safeRender = () => {
  try {
    renderArenaPages({db});
  } catch (err) {
    console.error('Failed rendering static Arena pages:', err);
  }
};

// Reconcile `config/ladders.yml` synchronously on boot, then refresh `static/projects.yml` owner
// standings from Smogon XenForo HTML profiles (falling back to offline YAML sync if Smogon is
// unreachable) before writing fresh static Arena pages to `public/`.
const db = new Database();
db.syncLadders();
if (isMock) {
  db.syncProjects();
  safeRender();
} else {
  db.syncProjectsWithSmogon()
    .catch(err => {
      console.error('Error syncing projects with Smogon:', err);
      try {
        db.syncProjects();
      } catch (fallbackErr) {
        console.error('Offline project sync failed:', fallbackErr);
      }
    })
    .finally(() => {
      safeRender();
    });
}

const dirs = {
  root: ROOT,
  out: root('build', 'static'),
  static: root('static'),
  extra: root('private'),
};
serve(Number(process.env.PORT) || 1234, dirs, app => {
  // `static/build.ts` writes a 0-byte `public/account/index.html` stub because `static/rules.dj`
  // links to `/account` and `@untitaker/hyperlink` has no ignore option. Meanwhile, `site.serve()`
  // registers `morgan` (`wares[0]`) and `serve-static(public)` (`wares[1]`) *before* invoking this
  // callback (`fn(app)`). Unlike `/chat` (handled by an Nginx redirect) or `/wiki` (not linked from
  // static `.dj` pages, so no stub exists in `public/`), `/account` is proxied by Nginx to Polka
  // for authenticated SSR. Without skipping `wares[1]` for `/account`, `serve-static` intercepts
  // `GET /account` / `GET /account/` and serves the empty 0-byte stub before `account.register`
  // can run.
  type Middleware = (req: {url: string}, res: unknown, next: () => void) => void;
  const wares = (app as unknown as {wares?: Middleware[]}).wares;
  const staticWare = wares?.[1];
  if (wares && staticWare) {
    wares[1] = (req, res, next) => {
      if (/^(?:\/account(?:\.json|\/|$|\?)|\/wiki(?:\/|$|\?))/.test(req.url)) {
        next();
        return;
      }
      req.url = resolveStaticJsonUrl(PUBLIC_DIR, req.url);
      staticWare(req, res, next);
    };
  }

  const battleAliases = [
    '/battles',
    '/battle',
    '/matches',
    '/match',
    '/games',
    '/arena/battle',
    '/arena/matches',
    '/arena/match',
    '/arena/games',
  ];
  for (const prefix of battleAliases) {
    app.get(prefix, (_req, res) => {
      res.writeHead(302, {Location: '/arena/battles/'});
      res.end();
    });
    app.get(`${prefix}.json`, (_req, res) => {
      res.writeHead(302, {Location: '/arena/battles.json'});
      res.end();
    });
  }

  const wikiInstance = new wiki.Wiki({
    db,
    auth: new Auth({
      db,
      isAuthorizedGitHub: (login): boolean => wikiInstance.isDeveloper(login),
    }),
  });
  wikiInstance.auth.register(app);
  const discordHandle = discord.register(app, {db});
  account.register(app, {db, auth: wikiInstance.auth});
  arena.register(app, {
    db,
    auth: wikiInstance.auth,
    onSubmissionStatus: async result => {
      await discordHandle.notifySubmissionStatus(result);
    },
    onWatchdogTimeout: async alert => {
      await discordHandle.notifyWatchdogTimeout(alert);
    },
    onUpdate: () => {
      safeRender();
    },
  });

  wiki.register(app, {auth: wikiInstance.auth, db});
});
