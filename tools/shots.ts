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
import * as arena from '../server/arena';
import * as auth from '../server/auth';
import * as render from '../server/render';
import * as wiki from '../server/wiki';
import {ROOT, root} from '../static/util';

import * as mock from './mock';

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
  click?: string;
  githubUser?: string;
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

function buildScenarios(wikiSha: string): Scenario[] {
  return [
    {name: 'home', path: '/'},
    {name: 'arena', path: '/arena/'},
    {name: 'arena-ladder-rby', path: '/arena/ladders/rby/'},
    {name: 'arena-ladder-vgc', path: '/arena/ladders/vgc/'},
    {name: 'arena-tournament-1', path: '/arena/tournaments/1/'},
    {name: 'arena-tournament-2', path: '/arena/tournaments/2/'},
    {name: 'arena-tournament-3', path: '/arena/tournaments/3/'},
    {name: 'arena-battles', path: '/arena/battles/'},
    {
      name: 'arena-battles-expanded',
      path: '/arena/battles/',
      click: '#battles-tbody tr.battle-row td:first-child',
    },
    {name: 'account', path: '/account/'},
    {name: 'account-tournament', path: '/account/', githubUser: 'pmariglia'},
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
  cookies: Record<string, string>;
  sha: string;
  publicDir: string;
  close: () => Promise<void>;
}

function copyStaticPublicHtml(srcPublic: string, dstPublic: string) {
  const indexHtml = path.join(srcPublic, 'index.html');
  if (fs.existsSync(indexHtml)) {
    fs.copyFileSync(indexHtml, path.join(dstPublic, 'index.html'));
  }
  for (const dir of [
    'background',
    'concepts',
    'glossary',
    'release',
    'research',
    'rules',
  ]) {
    const srcDir = path.join(srcPublic, dir);
    if (fs.existsSync(srcDir)) {
      fs.cpSync(srcDir, path.join(dstPublic, dir), {recursive: true});
    }
  }
}

async function startFixture(): Promise<Fixture> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-shots-'));
  const wikiDir = path.join(tmpDir, 'wiki');
  const staticDir = path.join(tmpDir, 'static');
  const avatarsDir = path.join(staticDir, 'avatars');
  const publicDir = path.join(tmpDir, 'public');
  const laddersFile = path.join(tmpDir, 'ladders.yml');
  fs.mkdirSync(publicDir, {recursive: true});
  copyStaticPublicHtml(PUBLIC, publicDir);

  const nowSeconds = Math.floor(NOW / 1000);
  const db = new Database(':memory:', {now: nowSeconds});
  const seeded = await mock.seed({
    db,
    publicDir,
    staticDir,
    avatarsDir,
    wikiDir,
    laddersFile,
    now: nowSeconds,
    render: true,
  });
  const projectsFile = path.join(staticDir, 'projects.yml');

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
  const arenaHandle = arena.register(app, {
    db,
    auth: wikiInstance.auth,
    publicDir,
    now: () => nowSeconds,
  });
  arenaHandle.setLiveState({
    live: seeded.liveDoc.live,
    stale: seeded.liveDoc.stale,
    updatedAt: seeded.liveDoc.updatedAt,
  });
  if (seeded.tournamentBroadcast) {
    arenaHandle.setTournamentBroadcast(seeded.tournamentBroadcast);
  }
  render.register(app, {
    db,
    arena: arenaHandle,
    publicDir,
    staticDir,
    avatarsDir,
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
  const mintCookie = (id: number, login: string, discordId: string, discordUser: string) => {
    const token = auth.signToken(
      {
        github: {id, login},
        discord: {id: discordId, username: discordUser},
        exp,
      },
      SHOTS_AUTH.sessionSecret
    );
    return `${auth.SESSION_COOKIE}=${encodeURIComponent(token)}`;
  };

  return {
    origin: `http://127.0.0.1:${addr.port}`,
    cookies: {
      scheibo: mintCookie(1, 'scheibo', '513513270670262284', 'scheibo'),
      pmariglia: mintCookie(2, 'pmariglia', '283674461268344832', 'pmariglia'),
    },
    sha,
    publicDir,
    close: async () => {
      arenaHandle.close();
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

async function serve(route: Route, fixture: Fixture, cookie: string): Promise<void> {
  const url = new URL(route.request().url());
  if (url.origin !== ORIGIN) {
    if (url.pathname.endsWith('.png')) {
      await route.fulfill({status: 200, contentType: 'image/png', body: TRANSPARENT_PNG});
      return;
    }
    await route.fulfill({status: 204, body: ''});
    return;
  }
  if (
    url.pathname === '/api/battles/stream' ||
    /^\/api\/tournaments\/[^/]+\/stream$/.test(url.pathname)
  ) {
    await route.fulfill({status: 204, contentType: 'text/event-stream', body: ''});
    return;
  }
  const isStaticArenaAsset = (
    url.pathname === '/arena/viewer' ||
    url.pathname.startsWith('/arena/viewer/') ||
    /\.(?:7z|log)$/i.test(url.pathname)
  );
  const isDynamic = !isStaticArenaAsset && (
    url.pathname === '/wiki' ||
    url.pathname.startsWith('/wiki/') ||
    url.pathname === '/account' ||
    url.pathname.startsWith('/account/') ||
    url.pathname === '/projects' ||
    url.pathname.startsWith('/projects/') ||
    url.pathname === '/arena' ||
    url.pathname.startsWith('/arena/') ||
    url.pathname === '/arena.json' ||
    url.pathname.startsWith('/api/')
  );
  if (isDynamic) {
    const req = route.request();
    const body = req.postDataBuffer();
    const reqHeaders = req.headers();
    const res = await fetch(`${fixture.origin}${url.pathname}${url.search}`, {
      method: req.method(),
      headers: {
        ...reqHeaders,
        ...(reqHeaders.origin === ORIGIN ? {origin: fixture.origin} : {}),
        cookie,
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
  const cookie = fixture.cookies[scenario.githubUser ?? 'scheibo'] ?? fixture.cookies.scheibo;
  await context.route('**/*', route => serve(route, fixture, cookie));
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', error => problems.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') problems.push(message.text());
  });
  await page.clock.setFixedTime(NOW);

  await page.goto(scenario.path);
  await page.waitForLoadState('networkidle');
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
  if (errors.length > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  run().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
