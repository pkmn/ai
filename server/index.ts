require('source-map-support').install();

import {serve} from 'site';

import {ArenaDB} from '../db';
import {ROOT, root} from '../static/util';

import * as account from './account';
import * as arena from './arena';
import {Auth} from './auth';
import * as discord from './discord';
import {renderArenaPages} from './render';
import * as wiki from './wiki';

const safeRender = () => {
  try {
    renderArenaPages({db});
  } catch (err) {
    console.error('Failed rendering static Arena pages:', err);
  }
};

const db = new ArenaDB();
db.syncLadders();
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
    wares[1] = (req, res, next) =>
      /^\/account(?:\/|$|\?)/.test(req.url) ? next() : staticWare(req, res, next);
  }

  const wikiInstance = new wiki.Wiki({
    db,
    auth: new Auth({
      db,
      isAuthorizedGitHub: (login): boolean => wikiInstance.isDeveloper(login),
    }),
  });
  wikiInstance.auth.register(app);
  account.register(app, {db, auth: wikiInstance.auth});
  arena.register(app, {
    db,
    auth: wikiInstance.auth,
    onUpdate: () => {
      safeRender();
    },
  });

  wiki.register(app, {auth: wikiInstance.auth, db});
  discord.register(app, {db});
});

