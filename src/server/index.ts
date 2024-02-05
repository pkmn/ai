require('source-map-support').install();

import * as path from 'path';

import {serve} from 'site';

import {header, renderer, style} from '../static/build';

const root = path.join(__dirname, '..', '..');
const dirs =
  {root, out: path.join(root, 'build', 'static'), static: path.join(root, 'src', 'static')};
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
});

