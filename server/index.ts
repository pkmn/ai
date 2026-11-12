require('source-map-support').install();

import * as fs from 'fs';

import {serve} from 'site';

import {Database} from '../db';
import {syncStaticLiveBanner} from '../static/build';
import {ROOT, root} from '../static/util';

import * as account from './account';
import * as arena from './arena';
import {Auth} from './auth';
import * as discord from './discord';
import * as render from './render';
import * as wiki from './wiki';

const isMock = process.env.MOCK === '1';
if (isMock && !fs.existsSync(root('.mock', 'ladders.yml'))) {
  console.error('Missing .mock/ directory — run "npm run mock -- seed" before MOCK=1.');
  process.exit(1);
}

const syncBanner = () => {
  try {
    syncStaticLiveBanner(render.PUBLIC_DIR, db.getRunningTournament());
  } catch (err) {
    console.error('Failed syncing static live tournament banner:', err);
  }
};

// Reconcile `config/ladders.yml` synchronously on boot, then refresh `static/projects.yml` owner
// standings from Smogon XenForo HTML profiles (falling back to offline YAML sync if Smogon is
// unreachable) before syncing the live tournament topbar banner onto pre-built static `.dj` pages.
const db = new Database();
db.syncLadders();
if (isMock) {
  db.syncProjects();
  syncBanner();
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
      syncBanner();
    });
}

const dirs = {
  root: ROOT,
  out: root('build', 'static'),
  static: root('static'),
  extra: root('private'),
};
serve(Number(process.env.PORT) || 1234, dirs, app => {
  // `static/build.ts` writes 0-byte `index.html` stubs for `/account`, `/arena`, and `/projects`
  // so `@untitaker/hyperlink` (`hyperlink public --check-anchors`) validates internal `.dj` links.
  // Meanwhile, `site.serve()` registers `morgan` (`wares[0]`) and `serve-static(public)`
  // (`wares[1]`) *before* invoking this callback (`fn(app)`). Bypass `serve-static` for all
  // dynamic SSR and API routes while still serving `/arena/viewer/` and static `.7z`/`.log`
  // archives directly from `public/`.
  type Middleware = (req: {url: string}, res: unknown, next: () => void) => void;
  const wares = (app as unknown as {wares?: Middleware[]}).wares;
  const staticWare = wares?.[1];
  if (wares && staticWare) {
    wares[1] = (req, res, next) => {
      const pathname = req.url.split('?')[0];
      const isStaticArenaAsset =
        pathname === '/arena/viewer' ||
        pathname.startsWith('/arena/viewer/') ||
        /\.(?:7z|log)$/i.test(pathname);
      if (
        !isStaticArenaAsset &&
        /^(?:\/(?:account|wiki|projects|arena)(?:\.json|\/|$)|\/api(?:\/|$))/.test(pathname)
      ) {
        next();
        return;
      }
      staticWare(req, res, next);
    };
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
  const arenaHandle = arena.register(app, {
    db,
    auth: wikiInstance.auth,
    onSubmissionStatus: async result => {
      await discordHandle.notifySubmissionStatus(result);
    },
    onWatchdogTimeout: async alert => {
      await discordHandle.notifyWatchdogTimeout(alert);
    },
    onUpdate: reason => {
      if (reason === 'tournament-status') syncBanner();
    },
  });
  if (isMock) {
    const mockStateFile = root('.mock', 'state.json');
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
    avatarsDir: isMock ? root('.mock', 'static', 'avatars') : undefined,
  });
  wiki.register(app, {auth: wikiInstance.auth, db});
});
