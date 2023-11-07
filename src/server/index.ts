import 'source-map-support/register';

import {execFileSync} from 'child_process';
import * as os from 'os';
import * as path from 'path';

import polka from 'polka';

import {render, topbar} from '../static/build';

const ROOT = path.join(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const STATIC = path.join(ROOT, 'src', 'static');

const PORT = process.env.PORT || 1234;

const app = polka();

if (process.env.NODE_ENV === 'development') {
  const chokidar = require('chokidar');
  const esbuild = require('esbuild');
  const morgan = require('morgan');
  const serve = require('serve-static');

  app.use(morgan('dev'));
  app.use(serve(PUBLIC));

  chokidar.watch(STATIC).on('change', (file: string) => {
    console.log(`\x1b[2mRebuilding static after change to ${path.relative(ROOT, file)} ...\x1b[0m`);
    const begin = process.hrtime.bigint();
    try {
      esbuild.buildSync({
        entryPoints: [path.join(STATIC, '*.ts')],
        outdir: path.join(ROOT, 'build', 'static'),
        bundle: false,
        platform: 'node',
        format: 'cjs',
      });
      const compile = `${(Math.round(Number(process.hrtime.bigint() - begin) / 1e6))} ms`;
      execFileSync('node', ['build/static/build.js', '--rebuild'], {
        encoding: 'utf8',
        stdio: 'pipe',
        cwd: ROOT,
      });
      const duration = (Number(process.hrtime.bigint() - begin) / 1e9).toFixed(2);
      console.log(`\x1b[2mRebuilt static in ${duration} s (${compile})\x1b[0m`);
    } catch (err: any) {
      const duration = (Number(process.hrtime.bigint() - begin) / 1e9).toFixed(2);
      console.error(`\x1b[31m${err.message.split('\n').slice(1, -1).join('\n')}\x1b[0m`);
      console.log(`\x1b[2mFailed build after ${duration} s\x1b[0m`);
    }
  });
}

// TODO: this should be partly pre-rendered
app.get('/battles', (_, res) => {
  res.end(render('leaderboard', {
    topbar,
    title: 'Battles | pkmn.ai',
    header: '<h2>Battles TODO</h2>',
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
