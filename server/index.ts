require('source-map-support').install();

import {serve} from 'site';

import {header, renderer, style} from '../static/build';
import {ROOT, root} from '../static/util';

import * as wiki from './wiki';

const dirs = {
  root: ROOT,
  out: root('build', 'static'),
  static: root('static'),
  extra: root('private'),
};
serve(Number(process.env.PORT) || 1234, dirs, app => {
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

  wiki.register(app);
});

