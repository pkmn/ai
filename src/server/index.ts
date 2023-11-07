import 'source-map-support/register';

import {execFileSync} from 'child_process';
import * as os from 'os';
import * as path from 'path';

import chokidar from 'chokidar';
import morgan from 'morgan';
import polka from 'polka';
import serve from 'serve-static';

import {render, topbar} from '../static/build';

const ROOT = path.join(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const STATIC = path.join(ROOT, 'src', 'static');

const PORT = process.env.PORT || 1234;

const app = polka();

if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
  app.use(serve(PUBLIC));

  chokidar.watch(STATIC).on('change', () => {
    console.log('\x1b[2mRebuilding static...\x1b[0m');
    const begin = process.hrtime.bigint();
    try {
      execFileSync('npm', ['run', 'build'], {encoding: 'utf8', stdio: 'pipe'});
      const duration = (Number(process.hrtime.bigint() - begin) / 1e9).toFixed(2);
      console.log(`\x1b[2mRebuilt static in ${duration} s\x1b[0m`);
    } catch (err: any) {
      const duration = (Number(process.hrtime.bigint() - begin) / 1e9).toFixed(2);
      console.error(`\x1b[31m${err.message.split('\n').slice(1, -1).join('\n')}\x1b[0m`);
      console.log(`\x1b[2mFailed build after ${duration} s\x1b[0m`);
    }
  });
}

// TODO: this should be pre-rendered
app.get('/leaderboard', (_, res) => {
  res.end(render('leaderboard', {
    topbar,
    title: 'Leaderboard | pkmn.ai',
    header: '<h2>Leaderboard</h2>',
    // TODO: links to rules, history, battles, etc
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
    edit: 'https://github.com/pkmn/ai',
  }));
});

app.listen(PORT, () => {
  if (process.env.NODE_ENV !== 'development') return;

  console.log('\x1b[33mAvailable on:\x1b[0m');
  const interfaces = os.networkInterfaces();
  for (const dev in interfaces) {
    for (const details of interfaces[dev]!) {
      if (details.family === 'IPv4') {
        console.log(`  http://${details.address}:\x1b[32m${PORT}\x1b[0m`);
      }
    }
  }
  console.log();
});
