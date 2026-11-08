import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import {parseArgs} from 'util';

import {Browser, BrowserContext, Route, chromium} from 'playwright-core';

const ROOT = path.basename(path.dirname(__dirname)) === 'build'
  ? path.join(__dirname, '..', '..')
  : path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const SHOTS_DIR = path.join(ROOT, '.shots');

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

const SCENARIOS: Scenario[] = [
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
];

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

async function serve(route: Route): Promise<void> {
  const url = new URL(route.request().url());
  if (url.origin !== ORIGIN) {
    await route.fulfill({status: 204, body: ''});
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

async function shoot(context: BrowserContext, scenario: Scenario, file: string): Promise<string[]> {
  await context.route('**/*', route => serve(route));
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

  const newDir = `${SHOTS_DIR}.new`;
  const scenarios = SCENARIOS.filter(scenario => scenario.name.includes(values.only ?? ''));
  const browser = await launch();
  await fsp.rm(newDir, {recursive: true, force: true});
  await fsp.mkdir(newDir, {recursive: true});

  const shotNames: string[] = [];
  const errors: string[] = [];
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
          const problems = await shoot(context, scenario, path.join(newDir, name));
          shotNames.push(name);
          errors.push(...problems.map(problem => `${scenario.name} (${device}): ${problem}`));
        } finally {
          await context.close();
        }
      }));
    await Promise.all(shots);
    console.log(`  ${scenario.name}`);
  }
  await browser.close();

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
