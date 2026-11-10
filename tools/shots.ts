import {execFileSync} from 'child_process';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import {parseArgs} from 'util';

import {Browser, BrowserContext, Route, chromium} from 'playwright-core';
import polka from 'polka';

import {type AuthConfig, SESSION_COOKIE, signToken} from '../server/auth';
import {register} from '../server/wiki';
import {ROOT, root} from '../static/util';

const PUBLIC = root('public');
const SHOTS_DIR = root('.shots');

const ORIGIN = 'http://pkmn.test';
const NOW = Date.parse('2026-10-20T12:00:00Z');
const VIEWPORTS = {
  phone: {width: 390, height: 844},
  desktop: {width: 1280, height: 900},
};
const THEMES = ['light', 'dark'] as const;
const SETTLE_MS = 200;

interface Scenario {
  name: string;
  path: string;
  waitFor?: string;
  click?: string;
}

const WIKI_AUTH: AuthConfig = {
  sessionSecret: 'shots-session-secret',
  github: {
    clientId: 'shots-client-id',
    clientSecret: 'shots-client-secret',
  },
};

const WIKI_PROJECTS_YAML = `
- name: 0 ERROR
  active: 2026
  arena:
    owners:
      scheibo: pre.10544
- name: Foul Play
  active: 2026
  arena:
    owners:
      pmariglia: pmariglia.535629
`;

const WIKI_INDEX_DJ = `# Wiki

Shared documentation, format notes, and bot profiles for the \`pkmn.ai\` community.

## Pages

- [0 ERROR](0_ERROR) — Gen 9 OU search & evaluation bot by *pre*.
- [Gen 9 OU](Gen_9_OU) — Metagame overview, team structures, and benchmark baselines.
`;

const WIKI_GEN9OU_DJ = [
  '# Gen 9 OU',
  '',
  'Standard Smogon Singles format used for the `pkmn.ai` ladder and tournament benchmarks.',
  '',
  '## Evaluation',
  '',
  'Bots are evaluated across 2-game blind-pair matches using Davidson MAP ratings:',
  '',
  '$$`P(i \\text{ beats } j) = ' +
    '\\frac{\\gamma_i}{\\gamma_i + \\gamma_j + \\nu \\sqrt{\\gamma_i \\gamma_j}}`',
  '',
].join('\n');

const WIKI_BOT_V1_DJ = `{% visibility: developers %}
# 0 ERROR

\`0 ERROR\` is a Gen 9 OU battle agent developed by *pre*.

## Architecture

- Depth-limited Nash equilibrium search over packed battle states.
- Move ordering guided by damage calculator bounds.
`;

const WIKI_BOT_V2_DJ = `{% visibility: developers %}
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
    {name: 'background', path: '/background/'},
    {name: 'concepts', path: '/concepts/'},
    {name: 'concepts-baselines', path: '/concepts/baselines/'},
    {name: 'concepts-complexity', path: '/concepts/complexity/'},
    {name: 'concepts-engines', path: '/concepts/engines/'},
    {name: 'concepts-protocol', path: '/concepts/protocol/'},
    {name: 'concepts-variants', path: '/concepts/variants/'},
    {name: 'glossary', path: '/glossary/'},
    {name: 'projects', path: '/projects/'},
    {name: 'release', path: '/release/'},
    {name: 'research', path: '/research/'},
    {name: 'rules', path: '/rules/'},
    {name: 'wiki', path: '/wiki'},
    {name: 'wiki-pages', path: '/wiki/pages'},
    {name: 'wiki-bot', path: '/wiki/0_ERROR'},
    {name: 'wiki-edit', path: '/wiki/Gen_9_OU/edit'},
    {name: 'wiki-edit-bot', path: '/wiki/0_ERROR/edit'},
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

interface WikiFixture {
  origin: string;
  cookie: string;
  sha: string;
  close: () => Promise<void>;
}

async function startWiki(): Promise<WikiFixture> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-shots-wiki-'));
  const wikiDir = path.join(tmpDir, 'wiki');
  const projectsFile = path.join(tmpDir, 'projects.yml');
  fs.mkdirSync(wikiDir, {recursive: true});
  fs.writeFileSync(projectsFile, WIKI_PROJECTS_YAML, 'utf8');

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
  fs.writeFileSync(path.join(wikiDir, '0_ERROR.dj'), WIKI_BOT_V1_DJ, 'utf8');
  git(['add', 'index.dj', 'Gen_9_OU.dj', '0_ERROR.dj']);
  git(
    [
      'commit',
      '--author=scheibo <scheibo@users.noreply.github.com>',
      '-m', 'Create initial wiki pages',
    ],
    '2026-10-18T12:00:00Z'
  );

  fs.writeFileSync(path.join(wikiDir, '0_ERROR.dj'), WIKI_BOT_V2_DJ, 'utf8');
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
  register(app, {
    wikiDir,
    projectsFile,
    authConfig: WIKI_AUTH,
    push: false,
  });

  const server = http.createServer((req, res) => app.handler(req as polka.Request, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as {port: number};
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = signToken({github: {id: 1, login: 'scheibo'}, exp}, WIKI_AUTH.sessionSecret);

  return {
    origin: `http://127.0.0.1:${addr.port}`,
    cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    sha,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
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

function resolvePublicFile(urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  const candidate = path.resolve(PUBLIC, `.${decoded}`);
  if (candidate !== PUBLIC && !candidate.startsWith(`${PUBLIC}${path.sep}`)) {
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

async function serve(route: Route, wiki: WikiFixture): Promise<void> {
  const url = new URL(route.request().url());
  if (url.origin !== ORIGIN) {
    await route.fulfill({status: 204, body: ''});
    return;
  }
  if (url.pathname === '/wiki' || url.pathname.startsWith('/wiki/')) {
    const req = route.request();
    const body = req.postDataBuffer();
    const res = await fetch(`${wiki.origin}${url.pathname}${url.search}`, {
      method: req.method(),
      headers: {
        ...req.headers(),
        cookie: wiki.cookie,
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
  const file = resolvePublicFile(url.pathname);
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
  wiki: WikiFixture
): Promise<string[]> {
  await context.route('**/*', route => serve(route, wiki));
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
  await page.waitForTimeout(SETTLE_MS);
  if (scenario.click) {
    await page.click(scenario.click);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(SETTLE_MS);
  }
  await page.evaluate(`(async () => {
    for (const image of document.querySelectorAll("img")) image.loading = "eager";
    await document.fonts.ready;
    const pending = [...document.images].filter((image) => !image.complete);
    await Promise.all(
      pending.map((image) => new Promise((done) => (image.onload = image.onerror = done)))
    );
  })()`);
  await page.waitForTimeout(SETTLE_MS / 2);
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

  const wiki = await startWiki();
  const newDir = `${SHOTS_DIR}.new`;
  const scenarios = buildScenarios(wiki.sha).filter(
    scenario => scenario.name.includes(values.only ?? '')
  );
  const browser = await launch();
  await fsp.rm(newDir, {recursive: true, force: true});
  await fsp.mkdir(newDir, {recursive: true});

  const shotNames: string[] = [];
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
            const name = `${scenario.name}.${device}.${theme}.png`;
            const problems = await shoot(context, scenario, path.join(newDir, name), wiki);
            shotNames.push(name);
            errors.push(...problems.map(problem => `${scenario.name} (${device}): ${problem}`));
          } finally {
            await context.close();
          }
        }));
      await Promise.all(shots);
      console.log(`  ${scenario.name}`);
    }
  } finally {
    await browser.close();
    await wiki.close();
  }

  if (values.only === undefined) await fsp.rm(SHOTS_DIR, {recursive: true, force: true});
  await fsp.mkdir(SHOTS_DIR, {recursive: true});
  for (const name of shotNames) {
    await fsp.rename(path.join(newDir, name), path.join(SHOTS_DIR, name));
  }
  await fsp.rm(newDir, {recursive: true, force: true});

  console.log(`Screenshots of ${scenarios.length} scenarios in ${path.relative(ROOT, SHOTS_DIR)}.`);
  for (const error of new Set(errors)) console.warn(`  error: ${error}`);
}

if (require.main === module) {
  run().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
