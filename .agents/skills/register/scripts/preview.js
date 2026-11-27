#!/usr/bin/env node
'use strict';
// Isolated Playwright preview renderer for `/register` skill.
// Renders light & dark desktop screenshots and checks mobile overflow without touching repo files.
const fs = require('fs');
const {createRequire} = require('module');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const repoRequire = createRequire(path.join(REPO_ROOT, 'package.json'));

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function parseArgs(argv) {
  const args = {positional: [], ladders: []};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--entry-file') {
      args.entryFile = argv[++i];
    } else if (a === '--projects-yml') {
      args.projectsYml = argv[++i];
    } else if (a === '--replace') {
      args.replace = argv[++i];
    } else if (a === '--logo') {
      args.logo = argv[++i];
    } else if (a === '--out') {
      args.out = argv[++i];
    } else if (a === '--ladders') {
      const raw = argv[++i] || '';
      args.ladders = raw.split(',').map(s => s.trim()).filter(Boolean);
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    } else if (a.startsWith('--')) {
      throw new Error(`Unknown flag: ${a}`);
    } else {
      args.positional.push(a);
    }
  }
  return args;
}

function usage() {
  console.error([
    'Usage: node .agents/skills/register/scripts/preview.js <slug> --out <dir> [options]',
    '',
    'Options:',
    '  --entry-file <path>    YAML file with one project item (`- name: ...`) to append/replace',
    '  --projects-yml <path>  Full projects.yml override (defaults to static/projects.yml)',
    '  --replace <name>       Existing project name to remove before inserting --entry-file',
    '  --logo <path>          Optional logo file to copy into isolated avatars dir',
    '  --ladders <a,b>        Comma-separated ladder slots to qualify in temp SQLite (e.g. vgc)',
    '  --out <dir>            Output directory for <slug>-{light,dark}.png',
  ].join('\n'));
}

function buildTempProjectsYml(basePath, entryFile, replaceName) {
  let content = fs.readFileSync(basePath, 'utf8');
  if (replaceName) {
    const escaped = replaceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const blockRe = new RegExp(`(^|\\n)- name: ['"]?${escaped}['"]?\\n(?:  .*(?:\\n|$)|\\n)*`, 'm');
    if (!blockRe.test(content)) {
      throw new Error(`--replace target "${replaceName}" not found in ${basePath}`);
    }
    content = content.replace(blockRe, '$1');
  }
  if (entryFile) {
    const entry = fs.readFileSync(entryFile, 'utf8').trim();
    content = `${content.trimEnd()}\n${entry}\n`;
  }
  return content;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const slug = args.positional[0];
  if (args.help || !slug || !args.out) {
    usage();
    process.exit(args.help ? 0 : 2);
  }

  const buildRenderPath = path.join(REPO_ROOT, 'build/server/render.js');
  const publicDir = path.join(REPO_ROOT, 'public');
  if (!fs.existsSync(buildRenderPath) || !fs.existsSync(path.join(publicDir, 'index.html'))) {
    console.error('Missing build/ or public/ artifacts. Run `npm run build` first.');
    process.exit(1);
  }

  const polka = repoRequire('polka');
  const {chromium} = repoRequire('playwright-core');
  const {Database} = repoRequire(path.join(REPO_ROOT, 'build/db'));
  const arena = repoRequire(path.join(REPO_ROOT, 'build/server/arena'));
  const {Auth} = repoRequire(path.join(REPO_ROOT, 'build/server/auth'));
  const render = repoRequire(buildRenderPath);

  const outDir = path.resolve(args.out);
  fs.mkdirSync(outDir, {recursive: true});

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-reg-preview-'));
  let db;
  let arenaHandle;
  let server;
  let browser;
  try {
    const tmpStatic = path.join(tmpDir, 'static');
    const tmpAvatars = path.join(tmpStatic, 'avatars');
    fs.mkdirSync(tmpAvatars, {recursive: true});

    const repoAvatars = path.join(REPO_ROOT, 'static/avatars');
    if (fs.existsSync(repoAvatars)) {
      for (const f of fs.readdirSync(repoAvatars)) {
        fs.copyFileSync(path.join(repoAvatars, f), path.join(tmpAvatars, f));
      }
    }
    if (args.logo) {
      const logoSrc = path.resolve(args.logo);
      const ext = path.extname(logoSrc) || '.png';
      fs.copyFileSync(logoSrc, path.join(tmpAvatars, `${slug}${ext}`));
    }

    fs.copyFileSync(
      path.join(REPO_ROOT, 'static/projects.bib'),
      path.join(tmpStatic, 'projects.bib')
    );

    const baseProjectsPath = args.projectsYml
      ? path.resolve(args.projectsYml)
      : path.join(REPO_ROOT, 'static/projects.yml');
    const tmpProjectsYml = path.join(tmpStatic, 'projects.yml');
    fs.writeFileSync(
      tmpProjectsYml,
      buildTempProjectsYml(
        baseProjectsPath,
        args.entryFile && path.resolve(args.entryFile),
        args.replace
      )
    );

    db = new Database(path.join(tmpDir, 'arena.sqlite'));
    db.syncProjects(tmpProjectsYml, tmpAvatars);
    const agent = db.getAgentBySlug(slug);
    if (!agent) {
      throw new Error(
        `Slug "${slug}" was not created by syncProjects() — check arena.owners and project name.`
      );
    }
    if (args.ladders.length > 0 && !(args.ladders.length === 1 && args.ladders[0] === 'none')) {
      db.setAgentLadders(slug, args.ladders);
    }

    const app = polka();
    const auth = new Auth(db);
    app.use((req, res, next) => {
      const pathname = (req.url || '/').split('?')[0];
      const isDynamic =
        /^(?:\/(?:account|admin|wiki|projects|arena)(?:\.json|\/|$)|\/api(?:\/|$))/.test(pathname);
      if (isDynamic) {
        next();
        return;
      }
      const fp = path.join(publicDir, pathname.replace(/^\/+/, ''));
      if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
        const mime = MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream';
        res.setHeader('Content-Type', mime);
        res.end(fs.readFileSync(fp));
        return;
      }
      next();
    });

    arenaHandle = arena.register(app, {db, auth, publicDir, armWatchdogOnStart: false});
    render.register(
      app,
      {db, arena: arenaHandle, publicDir, staticDir: tmpStatic, avatarsDir: tmpAvatars}
    );

    await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
    server = app.server;
    const base = `http://127.0.0.1:${server.address().port}`;

    const jsonRes = await fetch(`${base}/projects/${slug}.json`);
    const projectJson = jsonRes.ok ? await jsonRes.json() : {error: `HTTP ${jsonRes.status}`};

    browser = await chromium.launch();
    const consoleErrors = [];
    const pageErrors = [];
    const results = {};

    for (const scheme of ['light', 'dark']) {
      const ctx = await browser.newContext({
        viewport: {width: 1200, height: 780},
        colorScheme: scheme,
      });
      const page = await ctx.newPage();
      page.on('console', m => {
        if (m.type() === 'error') consoleErrors.push(`${scheme}: ${m.text()}`);
      });
      page.on('pageerror', e => pageErrors.push(`${scheme}: ${e.message}`));
      const res = await page.goto(`${base}/projects/${slug}/`, {waitUntil: 'networkidle'});
      const metrics = await page.evaluate(() => {
        const doc = globalThis.document;
        const win = globalThis.window;
        const img = doc.querySelector('img.project-logo');
        const rect = img ? img.getBoundingClientRect() : null;
        return {
          overflowDesktop: doc.documentElement.scrollWidth > win.innerWidth,
          logoSrc: img ? img.getAttribute('src') : null,
          logoNatural: img ? [img.naturalWidth, img.naturalHeight] : null,
          logoBox: rect ? [Math.round(rect.width), Math.round(rect.height)] : null,
        };
      });
      const shotPath = path.join(outDir, `${slug}-${scheme}.png`);
      await page.screenshot({path: shotPath});
      await ctx.close();

      const mobCtx = await browser.newContext({
        viewport: {width: 375, height: 700},
        colorScheme: scheme,
      });
      const mobPage = await mobCtx.newPage();
      await mobPage.goto(`${base}/projects/${slug}/`, {waitUntil: 'networkidle'});
      const overflowMobile = await mobPage.evaluate(
        () => globalThis.document.documentElement.scrollWidth > globalThis.window.innerWidth
      );
      await mobCtx.close();

      results[scheme] = {
        httpStatus: res ? res.status() : 0,
        ...metrics,
        overflowMobile,
        screenshot: shotPath,
      };
    }

    const summary = {slug, projectJson, results, consoleErrors, pageErrors};
    console.log(JSON.stringify(summary, null, 2));
    const failed =
      consoleErrors.length > 0 ||
      pageErrors.length > 0 ||
      Object.values(results).some(
        r => r.httpStatus !== 200 || r.overflowDesktop || r.overflowMobile ||
          (r.logoSrc && (!r.logoNatural || r.logoNatural[0] === 0))
      );
    if (failed) process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (arenaHandle) arenaHandle.close();
    if (server) server.close();
    if (db) db.close();
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
