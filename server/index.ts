require('source-map-support').install();

import {serve} from 'site';

import {header, renderer, style} from '../static/build';
import {ROOT, root} from '../static/util';

import {Auth} from './auth';
import {ArenaDB} from './db';
import * as discord from './discord';
import * as wiki from './wiki';

const db = new ArenaDB();
db.syncLadders();
db.syncProjectsWithSmogon().catch(err => {
  console.error('Error syncing projects with Smogon:', err);
  try {
    db.syncProjects();
  } catch (fallbackErr) {
    console.error('Offline project sync failed:', fallbackErr);
  }
});

const dirs = {
  root: ROOT,
  out: root('build', 'static'),
  static: root('static'),
  extra: root('private'),
};
serve(Number(process.env.PORT) || 1234, dirs, app => {
  const wikiInstance = new wiki.Wiki({
    db,
    auth: new Auth({
      db,
      isAuthorizedGitHub: (login): boolean => wikiInstance.isDeveloper(login),
    }),
  });
  wikiInstance.auth.register(app);

  // TODO: this should be partly pre-rendered
  app.get('/battles', (_, res) => {
    res.end(renderer.render({
      id: 'leaderboard',
      path: '/leaderboard/',
      title: 'Battles | pkmn.ai',
      style,
      header: header('<h2>Battles</h2>', true),
      // TODO: this nav is from /leaderboard and links to rules, history, battles, etc
      content: `<nav>
      <ul>
        <li>
          <input type="radio" value="controlled" name="radio" id="controlled" checked="checked" />
          <label for="controlled">Controlled</label>
        </li>
        —
        <li>
          <input type="radio" value="open" name="radio" id="open" />
        <label for="open">Open</label>
        </li>
      </ul>
    </nav>`,
    }));
  });

  wiki.register(app, {auth: wikiInstance.auth, db});
  discord.register(app, {db});
});

