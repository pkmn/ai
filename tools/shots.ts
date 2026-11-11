// Visual regression & layout verifier (`npm run shots [-- --only <filter>]`).
//
// Renders every static and dynamic page across 4 viewports (`small`, `phone`, `tablet`, `desktop`)
// and both color schemes (`light`, `dark`) into `.shots/<viewport>/<theme>/<scenario>.png`,
// asserting zero runtime console/page errors and zero horizontal overflow on every combination.

import {execFileSync} from 'child_process';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import {parseArgs} from 'util';

import {Browser, BrowserContext, Route, chromium} from 'playwright-core';
import polka from 'polka';

import {Database} from '../db';
import * as account from '../server/account';
import * as auth from '../server/auth';
import * as wiki from '../server/wiki';
import {ROOT, root} from '../static/util';

import {prepareMockStaticDir, seedMockArena} from './mock';

const PUBLIC = root('public');
const SHOTS_DIR = root('.shots');

const ORIGIN = 'http://pkmn.test';
const NOW = Date.parse('2026-10-20T12:00:00Z');
const VIEWPORTS = {
  small: {width: 375, height: 667}, // iPhone SE (3rd generation)
  phone: {width: 390, height: 844}, // iPhone 14
  tablet: {width: 744, height: 1133}, // iPad mini (6th generation, portrait)
  desktop: {width: 1280, height: 900},
};
const THEMES = ['light', 'dark'] as const;
const SETTLE_MILLIS = 200;

interface Scenario {
  name: string;
  path: string;
  waitFor?: string;
  click?: string;
}

const SHOTS_AUTH: auth.Config = {
  sessionSecret: 'shots-session-secret',
  github: {
    clientId: 'shots-client-id',
    clientSecret: 'shots-client-secret',
  },
  discord: {
    clientId: '689315793569447954',
    clientSecret: 'shots-discord-secret',
  },
};

const WIKI_INDEX_DJ = `# Wiki

Shared documentation, format notes, and project profiles for the \`pkmn.ai\` community.

## Pages

- [0 ERROR](0_ERROR) — Gen 9 OU search & evaluation agent by *pre*.
- [Gen 9 OU](Gen_9_OU) — Metagame overview, team structures, and benchmark baselines.
`;

const WIKI_GEN9OU_DJ = [
  '# Gen 9 OU',
  '',
  'Standard Smogon Singles format used for the `pkmn.ai` ladder and tournament benchmarks.',
  '',
  '## Evaluation',
  '',
  'Agents are evaluated across 2-game blind-pair matches using Davidson MAP ratings:',
  '',
  '$$`P(i \\text{ beats } j) = ' +
    '\\frac{\\gamma_i}{\\gamma_i + \\gamma_j + \\nu \\sqrt{\\gamma_i \\gamma_j}}`',
  '',
].join('\n');

const WIKI_PROJECT_V1_DJ = `{% visibility: developers %}
# 0 ERROR

\`0 ERROR\` is a Gen 9 OU battle agent developed by *pre*.

## Architecture

- Depth-limited Nash equilibrium search over packed battle states.
- Move ordering guided by damage calculator bounds.
`;

const WIKI_PROJECT_V2_DJ = `{% visibility: developers %}
# 0 ERROR

\`0 ERROR\` is a Gen 9 OU battle agent developed by *pre*.

## Architecture

- Depth-limited Nash equilibrium search over packed battle states.
- Neural leaf evaluation network trained via self-play trajectories.
- Team preview policy conditioned on revealed opponent archetypes.
`;

function buildScenarios(wikiSha: string): Scenario[] {
  return [
    {name: 'home', path: '/'},
    {name: 'arena', path: '/arena/'},
    {name: 'arena-ladder-rby', path: '/arena/ladders/rby/'},
    {name: 'arena-ladder-vgc', path: '/arena/ladders/vgc/'},
    {name: 'arena-tournament-1', path: '/arena/tournaments/1/'},
    {name: 'arena-tournament-2', path: '/arena/tournaments/2/'},
    {name: 'arena-battles', path: '/arena/battles/'},
    {name: 'account', path: '/account/'},
    {name: 'background', path: '/background/'},
    {name: 'concepts', path: '/concepts/'},
    {name: 'concepts-baselines', path: '/concepts/baselines/'},
    {name: 'concepts-complexity', path: '/concepts/complexity/'},
    {name: 'concepts-engines', path: '/concepts/engines/'},
    {name: 'concepts-protocol', path: '/concepts/protocol/'},
    {name: 'concepts-variants', path: '/concepts/variants/'},
    {name: 'glossary', path: '/glossary/'},
    {name: 'projects', path: '/projects/'},
    {name: 'projects-arena', path: '/projects/', click: 'label[for="arena"]'},
    {name: 'project-profile', path: '/projects/0-error/'},
    {name: 'release', path: '/release/'},
    {name: 'research', path: '/research/'},
    {name: 'rules', path: '/rules/'},
    {name: 'wiki', path: '/wiki'},
    {name: 'wiki-pages', path: '/wiki/pages'},
    {name: 'wiki-project', path: '/wiki/0_ERROR'},
    {name: 'wiki-edit', path: '/wiki/Gen_9_OU/edit'},
    {name: 'wiki-edit-project', path: '/wiki/0_ERROR/edit'},
    {
      name: 'wiki-preview',
      path: '/wiki/0_ERROR/edit',
      click: '#wiki-actions button[value="preview"]',
    },
    {name: 'wiki-history', path: '/wiki/0_ERROR/history'},
    {name: 'wiki-revision', path: `/wiki/0_ERROR/${wikiSha}`},
    {name: 'wiki-diff', path: `/wiki/0_ERROR/${wikiSha}?diff=1`},
  ];
}

interface Fixture {
  origin: string;
  cookie: string;
  sha: string;
  publicDir: string;
  close: () => Promise<void>;
}

async function startFixture(): Promise<Fixture> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-shots-'));
  const wikiDir = path.join(tmpDir, 'wiki');
  const staticDir = path.join(tmpDir, 'static');
  const avatarsDir = path.join(staticDir, 'avatars');
  const publicDir = path.join(tmpDir, 'public');
  fs.mkdirSync(wikiDir, {recursive: true});
  fs.mkdirSync(publicDir, {recursive: true});

  const projectsFile = prepareMockStaticDir(staticDir, avatarsDir);
  const nowSeconds = Math.floor(NOW / 1000);
  const db = new Database(':memory:', {now: nowSeconds});
  seedMockArena({
    db,
    publicDir,
    staticDir,
    avatarsDir,
    now: nowSeconds,
    render: true,
  });

  const git = (args: string[], date?: string) =>
    execFileSync('git', args, {
      cwd: wikiDir,
      env: date
        ? {
          ...process.env,
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
        }
        : process.env,
    });

  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'pkmn.ai']);
  git(['config', 'user.email', 'wiki@pkmn.ai']);

  fs.writeFileSync(path.join(wikiDir, 'index.dj'), WIKI_INDEX_DJ, 'utf8');
  fs.writeFileSync(path.join(wikiDir, 'Gen_9_OU.dj'), WIKI_GEN9OU_DJ, 'utf8');
  fs.writeFileSync(path.join(wikiDir, '0_ERROR.dj'), WIKI_PROJECT_V1_DJ, 'utf8');
  git(['add', 'index.dj', 'Gen_9_OU.dj', '0_ERROR.dj']);
  git(
    [
      'commit',
      '--author=scheibo <scheibo@users.noreply.github.com>',
      '-m', 'Create initial wiki pages',
    ],
    '2026-10-18T12:00:00Z'
  );

  fs.writeFileSync(path.join(wikiDir, '0_ERROR.dj'), WIKI_PROJECT_V2_DJ, 'utf8');
  git(['add', '0_ERROR.dj']);
  git(
    [
      'commit',
      '--author=pmariglia <pmariglia@users.noreply.github.com>',
      '-m', 'Document neural value network',
    ],
    '2026-10-20T12:00:00Z'
  );

  const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: wikiDir,
    encoding: 'utf8',
  }).trim();

  const app = polka();
  const wikiInstance = new wiki.Wiki({
    wikiDir,
    projectsFile,
    db,
    push: false,
    auth: new auth.Auth({
      config: SHOTS_AUTH,
      db,
      isAuthorizedGitHub: (login): boolean => wikiInstance.isDeveloper(login),
    }),
  });
  wikiInstance.auth.register(app);
  account.register(app, {
    db,
    auth: wikiInstance.auth,
    now: () => nowSeconds,
  });
  wiki.register(app, {
    wikiDir,
    projectsFile,
    db,
    auth: wikiInstance.auth,
    push: false,
  });

  const server = http.createServer((req, res) => app.handler(req as polka.Request, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as {port: number};
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = auth.signToken(
    {
      github: {id: 1, login: 'scheibo'},
      discord: {id: '513513270670262284', username: 'scheibo'},
      exp,
    },
    SHOTS_AUTH.sessionSecret
  );

  return {
    origin: `http://127.0.0.1:${addr.port}`,
    cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(token)}`,
    sha,
    publicDir,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      db.close();
      fs.rmSync(tmpDir, {recursive: true, force: true});
    },
  };
}

async function launch(): Promise<Browser> {
  try {
    return await chromium.launch({
      args: [
        '--disable-gpu',
        '--disable-gpu-rasterization',
        '--disable-partial-raster',
        '--num-raster-threads=1',
        '--force-color-profile=srgb',
      ],
    });
  } catch (error) {
    console.error(
      'Could not start Chromium. Install the one playwright-core expects with\n' +
      '  npx playwright-core install chromium\n'
    );
    throw error;
  }
}

function resolveFileInDir(baseDir: string, urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  const candidate = path.resolve(baseDir, `.${decoded}`);
  if (candidate !== baseDir && !candidate.startsWith(`${baseDir}${path.sep}`)) {
    return undefined;
  }
  if (fs.existsSync(candidate)) {
    const stat = fs.statSync(candidate);
    if (stat.isFile()) return candidate;
    if (stat.isDirectory()) {
      const index = path.join(candidate, 'index.html');
      if (fs.existsSync(index) && fs.statSync(index).isFile()) return index;
    }
  }
  return undefined;
}

const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAYAAABe3VzdAAAAIElEQVR4nO3BAQ0AAADCoPdPbQ8HF' +
  'AAAAAAAAAAAAADwZEC4AAFe72zRAAAAAElFTkSuQmCC',
  'base64'
);

async function serve(route: Route, fixture: Fixture): Promise<void> {
  const url = new URL(route.request().url());
  if (url.origin !== ORIGIN) {
    if (url.pathname.endsWith('.png')) {
      await route.fulfill({status: 200, contentType: 'image/png', body: TRANSPARENT_PNG});
      return;
    }
    await route.fulfill({status: 204, body: ''});
    return;
  }
  const isDynamic = (
    url.pathname === '/wiki' ||
    url.pathname.startsWith('/wiki/') ||
    url.pathname === '/account' ||
    url.pathname.startsWith('/account/')
  );
  if (isDynamic) {
    const req = route.request();
    const body = req.postDataBuffer();
    const res = await fetch(`${fixture.origin}${url.pathname}${url.search}`, {
      method: req.method(),
      headers: {
        ...req.headers(),
        cookie: fixture.cookie,
      },
      body: body ? new Uint8Array(body) : undefined,
    });
    const buffer = Buffer.from(await res.arrayBuffer());
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    await route.fulfill({status: res.status, headers, body: buffer});
    return;
  }
  const file = (
    resolveFileInDir(fixture.publicDir, url.pathname) ??
    resolveFileInDir(PUBLIC, url.pathname)
  );
  if (file) {
    await route.fulfill({path: file});
    return;
  }
  const notFound = path.join(PUBLIC, '404.html');
  if (fs.existsSync(notFound)) {
    await route.fulfill({status: 404, path: notFound});
    return;
  }
  await route.fulfill({status: 404, contentType: 'text/plain', body: 'Not Found'});
}

async function shoot(
  context: BrowserContext,
  scenario: Scenario,
  file: string,
  fixture: Fixture
): Promise<string[]> {
  await context.route('**/*', route => serve(route, fixture));
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', error => problems.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') problems.push(message.text());
  });
  await page.clock.setFixedTime(NOW);

  await page.goto(scenario.path);
  if (scenario.waitFor) await page.waitForSelector(scenario.waitFor);
  else await page.waitForLoadState('networkidle');
  await page.waitForTimeout(SETTLE_MILLIS);
  if (scenario.click) {
    await page.click(scenario.click);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(SETTLE_MILLIS);
  }
  await page.evaluate(`(async () => {
    for (const image of document.querySelectorAll("img")) image.loading = "eager";
    await document.fonts.ready;
    const pending = [...document.images].filter((image) => !image.complete);
    await Promise.all(
      pending.map((image) => new Promise((done) => (image.onload = image.onerror = done)))
    );
  })()`);
  await page.waitForTimeout(SETTLE_MILLIS / 2);
  const overflow = await page.evaluate<number>(
    'document.documentElement.scrollWidth - window.innerWidth'
  );
  if (overflow > 0) {
    problems.push(`horizontal overflow: +${overflow}px`);
  }
  await page.screenshot({path: file, fullPage: true, animations: 'disabled', caret: 'hide'});
  return problems;
}

async function run(): Promise<void> {
  const {values} = parseArgs({
    options: {
      only: {type: 'string'},
    },
  });

  if (!fs.existsSync(path.join(PUBLIC, 'index.html'))) {
    console.error('There is no build to screenshot: run `npm run build` first.');
    process.exit(1);
  }

  const fixture = await startFixture();
  const newDir = `${SHOTS_DIR}.new`;
  const scenarios = buildScenarios(fixture.sha).filter(
    scenario => scenario.name.includes(values.only ?? '')
  );
  const browser = await launch();
  await fsp.rm(newDir, {recursive: true, force: true});
  for (const device of Object.keys(VIEWPORTS)) {
    for (const theme of THEMES) {
      await fsp.mkdir(path.join(newDir, device, theme), {recursive: true});
    }
  }

  const shotPaths: string[] = [];
  const errors: string[] = [];
  try {
    for (const scenario of scenarios) {
      const shots = Object.entries(VIEWPORTS).flatMap(([device, viewport]) =>
        THEMES.map(async theme => {
          const context = await browser.newContext({
            viewport,
            colorScheme: theme,
            deviceScaleFactor: 1,
            baseURL: ORIGIN,
            timezoneId: 'UTC',
            locale: 'en-US',
          });
          try {
            const relPath = path.join(device, theme, `${scenario.name}.png`);
            const problems = await shoot(context, scenario, path.join(newDir, relPath), fixture);
            shotPaths.push(relPath);
            errors.push(
              ...problems.map(problem => `${scenario.name} (${device}/${theme}): ${problem}`)
            );
          } finally {
            await context.close();
          }
        }));
      await Promise.all(shots);
      console.log(`  ${scenario.name}`);
    }
  } finally {
    await browser.close();
    await fixture.close();
  }

  if (values.only === undefined) await fsp.rm(SHOTS_DIR, {recursive: true, force: true});
  for (const relPath of shotPaths) {
    const dest = path.join(SHOTS_DIR, relPath);
    await fsp.mkdir(path.dirname(dest), {recursive: true});
    await fsp.rename(path.join(newDir, relPath), dest);
  }
  await fsp.rm(newDir, {recursive: true, force: true});

  console.log(
    `Screenshots of ${scenarios.length} scenarios in ${path.relative(ROOT, SHOTS_DIR)}.`
  );
  for (const error of new Set(errors)) console.warn(`  error: ${error}`);
}

if (require.main === module) {
  run().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
