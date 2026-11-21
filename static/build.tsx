// Based on the MIT licensed matklad/matklad.github.io:
// https://github.com/matklad/matklad.github.io/blob/master/LICENSE-MIT

require('source-map-support').install();

import * as nodeFs from 'fs';
import * as http from 'http';
import * as path from 'path';

import favicons from 'favicons';
import * as site from 'site';

import {DB_PATH, Database} from '../db';
import {renderBattleViewerPage} from '../server/tournaments';

import * as glossary from './glossary';
import * as research from './research';
import {Html, copyFileAtomic, escapeHtml, raw, root, writeFileAtomic} from './util';

const fs = site.fs;

// `site.fs` stages temp files in `${process.cwd()}/build/.tmp-*` before `fs.renameSync`ing into
// `public/`. Under systemd `ReadWritePaths=/var/lib/pkmn -/home/pkmn/ai/public`, those paths live
// on separate Linux VFS bind mounts (`EXDEV` on `rename`). Staging adjacent to the target file
// keeps every atomic rename on the destination mount.
(fs as {write: typeof fs.write; copy: typeof fs.copy}).write = (file, data) => {
  const content = typeof data === 'string' || Buffer.isBuffer(data)
    ? data
    : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  writeFileAtomic(file, content);
};
(fs as {write: typeof fs.write; copy: typeof fs.copy}).copy = (src, dst) => {
  copyFileAtomic(src, dst);
};

const PUBLIC = root('public');
const STATIC = root('static');
const IS_PRODUCTION =
  process.env.NODE_ENV === 'production' || nodeFs.existsSync('/var/lib/pkmn');
const GTAG_RE = new RegExp(
  '\\s*<script async src="https://www\\.googletagmanager\\.com/gtag/js\\?id=[^"]*"></script>' +
  "\\s*<script>[\\s\\S]*?gtag\\('config',\\s*'[^']*'\\);\\s*</script>"
);

// `site`'s `layout.html` registers `pref.addEventListener('change', e => setTheme(...))` in its
// outer `<script>` block without defining `setTheme`, expecting each page's `{{{ script }}}`
// payload to supply it so live OS dark/light switches work. Injecting `SET_THEME` inside
// `Renderer.render` satisfies that listener across every static and dynamic page in one place.
export const SET_THEME =
  "const setTheme = t => document.documentElement.setAttribute('data-theme', t);";

export function formatLiveTournamentBanner(tournament?: {id: string; name: string}): string {
  if (!tournament) return '';
  const href = `/arena/tournaments/${encodeURIComponent(tournament.id)}/`;
  return String(
    <div id='topbar'>
      <a href={href} className='subtle'>
        <span>{'\u25cf'} LIVE</span> {tournament.name}
      </a>
    </div>
  );
}

export function injectLiveBanner(
  headerHtml: Html | string | undefined,
  tournament?: {id: string; name: string}
): string | undefined {
  const headerStr = headerHtml !== undefined ? String(headerHtml) : undefined;
  const banner = formatLiveTournamentBanner(tournament);
  if (!banner || headerStr?.includes('id="topbar"')) return headerStr;
  return headerStr ? `${banner}\n  ${headerStr}` : banner;
}

const LIVE_TOPBAR_RE =
  /<div id="topbar"><a [^>]*>[\s\S]*?<\/a><\/div>\s*/g;

// Keeps pre-built static `.dj` pages in `publicDir` (`index.html`, `rules/`, `glossary/`, etc.)
// synchronized when a tournament transitions into or out of `status = 'running'` at runtime
// without requiring a full `npm run build` — skipping pages with the permanent Under Construction
// `#topbar` banner and 0-byte hyperlink stubs.
export function syncStaticLiveBanner(
  publicDir: string,
  tournament?: {id: string; name: string}
) {
  if (!nodeFs.existsSync(publicDir)) return;
  const banner = formatLiveTournamentBanner(tournament);

  if (tournament) {
    const stub = path.join(publicDir, 'arena', 'tournaments', tournament.id, 'index.html');
    if (!nodeFs.existsSync(stub)) {
      nodeFs.mkdirSync(path.dirname(stub), {recursive: true});
      nodeFs.writeFileSync(stub, '', 'utf8');
    }
  }

  const visitDir = (dir: string, relDir: string) => {
    for (const entry of nodeFs.readdirSync(dir, {withFileTypes: true})) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          rel === 'arena' ||
          rel === 'api' ||
          rel === 'chat' ||
          rel === 'account' ||
          rel === 'projects' ||
          rel === 'wiki'
        ) {
          continue;
        }
        visitDir(full, rel);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.html')) continue;
      const rawHtml = nodeFs.readFileSync(full, 'utf8');
      if (!rawHtml || rawHtml.includes('Under Construction:')) continue;
      if (!rawHtml.includes('<header>')) continue;

      const stripped = rawHtml.replace(LIVE_TOPBAR_RE, '');
      const updated = banner
        ? stripped.replace('<header>', `<header>${banner}\n  `)
        : stripped;
      if (updated !== rawHtml) {
        writeFileAtomic(full, updated);
      }
    }
  };

  visitDir(publicDir, '');
}

export interface Page extends Omit<site.page.Page, 'content' | 'header'> {
  header?: Html | string;
  content: Html | string;
}

export class Renderer extends site.page.Renderer {
  private readonly siteConfig: site.page.Site;
  private stylesheetHref: string | undefined;
  liveBannerProvider?: () => string;
  minify: boolean;

  constructor(options: site.page.Site) {
    super(options);
    this.siteConfig = options;
    this.stylesheetHref = undefined;
    this.liveBannerProvider = undefined;
    this.minify = false;
  }

  private ensureStylesheetHref(): string {
    if (!this.stylesheetHref) {
      const shell = super.render({title: '', path: '', content: ''});
      const match = /href="(\/index\.[^"]+\.css)"/.exec(shell);
      if (!match) throw new Error('Failed to initialize site base stylesheet');
      this.stylesheetHref = match[1];
    }
    return this.stylesheetHref;
  }

  override create(name: string, page: Page, replace?: (s: string) => string) {
    const headerStr = page.header !== undefined ? String(page.header) : undefined;
    super.create(name, {...page, header: headerStr, content: String(page.content)}, replace);
  }

  // `site.page.Renderer.render` runs `html-minifier` (`minifyJS` / UglifyJS + `minifyCSS` /
  // CleanCSS) synchronously on every call, which is fine for build-time static output
  // (`minify = true`) but blocks the event loop for >1s per cache miss on large dynamic SSR pages.
  override render(page: Page, replace?: (s: string) => string) {
    const script = page.script ? `${SET_THEME}\n${page.script}` : SET_THEME;
    const banner = this.liveBannerProvider?.() ?? '';
    const rawHeader = page.header !== undefined ? String(page.header) : undefined;
    const headerHtml = banner && !rawHeader?.includes('id="topbar"')
      ? (rawHeader ? `${banner}\n  ${rawHeader}` : banner)
      : rawHeader;

    if (this.minify) {
      const transform = IS_PRODUCTION
        ? replace
        : (s: string) => {
          const clean = s.replace(GTAG_RE, '');
          return replace ? replace(clean) : clean;
        };
      return super.render({
        ...page,
        header: headerHtml,
        content: String(page.content),
        script,
      }, transform);
    }

    const stylesheetHref = this.ensureStylesheetHref();
    const id = this.siteConfig.analytics;
    const analytics = IS_PRODUCTION && id
      ? `<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>` +
        '<script>window.dataLayer=window.dataLayer||[];' +
        'function gtag(){dataLayer.push(arguments)}' +
        `gtag('js',new Date());gtag('config','${id}');</script>`
      : '';
    const styleTag = page.style ? `<style>${page.style}</style>` : '';
    const bodyTag = page.id ? `<body id="${escapeHtml(page.id)}">` : '<body>';
    const headerTag = headerHtml ? `<header>${headerHtml}</header>` : '';
    const rendered = [
      '<!doctype html><html lang="en"><head>',
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      `<title>${escapeHtml(page.title)}</title>`,
      `<meta name="description" content="${this.siteConfig.description}">`,
      '<link rel="icon" type="image/svg+xml" href="/favicon.svg">',
      '<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">',
      '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">',
      `<link rel="canonical" href="${this.siteConfig.url}${page.path}">`,
      analytics,
      `<link rel="stylesheet" href="${stylesheetHref}">`,
      styleTag,
      `</head>${bodyTag}`,
      `${headerTag}<main>${String(page.content)}</main>`,
      '<footer><a href="https://creativecommons.org/licenses/by-sa/4.0/">',
      '<img src="/cc.svg" alt="CC"><img src="/by.svg" alt="BY">',
      '<img src="/sa.svg" alt="SA"></a></footer>',
      '</body><script>',
      "const pref=window.matchMedia('(prefers-color-scheme: dark)');",
      "pref.addEventListener('change',e=>setTheme(e.matches?'dark':'light'));",
      "document.documentElement.setAttribute('data-theme',pref.matches?'dark':'light');",
      `\n${script}\n</script></html>`,
    ].join('');
    return replace ? replace(rendered) : rendered;
  }
}

export const renderer = new Renderer({
  public: PUBLIC,
  analytics: 'G-LQ8TW28Z7Q',
  description: 'The home of competitive Pokémon artificial intelligence',
  url: 'https://pkmn.ai',
  stylesheet: path.join(STATIC, 'style', 'index.css'),
  highlight: true,
});

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export const cite = (title: string, date: Date, p?: string) => {
  const t = title.slice(title.lastIndexOf(' ') + 1).toLowerCase();
  const year = date.getUTCFullYear();
  const bib = `\n@online{pkmn${year}${t},\n` +
    `  title  = "Competitive Pokémon Artificial Intelligence ${title}",\n` +
    '  author = "pkmn.ai",\n' +
    `  month  = "${MONTHS[date.getUTCMonth()]}",\n` +
    `  year   = "${year}",\n` +
    `  url    = "https://pkmn.ai/${p ?? t}/"\n` +
    '}\n';
  return String(
    <section id='citation'>
      <figure className='code'><code><pre>{bib}</pre></code></figure>
    </section>
  );
};

export const header = (title: Html | string, wip = false) => String(<>
  {wip && <div id='topbar'>Under Construction: please excuse any temporary placeholders</div>}
  <h1><a href='/' className='subtle'>pkmn.ai</a></h1>
  <h2>{title}</h2>
</>);

export const style = ' [id] { scroll-margin-top: 2rem; }';

export function renderErrorPage(
  code: number,
  liveTournament?: {id: string; name: string}
): string {
  return renderer.render({
    title: `${code} | pkmn.ai`,
    header: injectLiveBanner(header(`${code}`), liveTournament),
    path: '',
    id: 'error',
    content: <p>{http.STATUS_CODES[code] ?? 'Error'}</p>,
    style: `
      #error h2 {
        text-decoration: none;
        font-size: 20vh;
        margin: 0;
      }
      #error main {
        font-size: 1.5em;
        position: relative;
        top: -6vh;
      }`,
  }).replace(/<link\b[^>]*rel="canonical"[^>]*>/, '');
}

const build = async (rebuild?: boolean) => {
  fs.mkdir(path.join(PUBLIC));

  let actual = fs.list(PUBLIC);
  let expected = new Set([
    'projects', 'research', 'concepts', 'glossary', 'rules', 'release', 'chat', 'arena',
    'account', 'wiki', 'background', 'index.html', 'favicon.svg',
    'cc.svg', 'by.svg', 'sa.svg', 'projects.bib', 'research.bib', 'llms.txt',
  ]);
  if (!rebuild) {
    const icons = await favicons(path.join(STATIC, 'favicon.svg'), {path: PUBLIC});
    for (const icon of icons.images) {
      if (/(yandex|apple)/.test(icon.name)) continue;
      fs.write(path.join(PUBLIC, icon.name), icon.contents);
      expected.add(icon.name);
    }
  }

  const hasExistingDb = nodeFs.existsSync(DB_PATH);
  const db = hasExistingDb ? new Database(DB_PATH, {readOnly: true}) : undefined;
  const getRunning = () => {
    if (!db) return undefined;
    try {
      return db.getRunningTournament();
    } catch {
      return undefined;
    }
  };
  try {
    renderer.minify = true;
    renderer.liveBannerProvider = () => formatLiveTournamentBanner(getRunning());

    for (const code of [400, 401, 403, 404, 500, 502, 503, 504]) {
      const page = `${code}.html`;
      fs.write(path.join(PUBLIC, page), renderErrorPage(code));
      expected.add(page);
    }

    // `@untitaker/hyperlink` (`hyperlink public --check-anchors`) has no CLI flag or config option
    // to ignore non-static routes (`--help` only exposes `--check-anchors`, `--sources`, `-j`, and
    // `--github-actions`). Routes linked from `.dj` content that are Nginx redirects (`/chat`) or
    // dynamic SSR routes (`/account`, `/arena`, `/projects`, `/wiki`, and any active live
    // tournament banner target) therefore get 0-byte `index.html` stubs on disk so `npm run lint`
    // does not report broken links, while Nginx and Polka's `serve-static` wrapper bypass them at
    // runtime.
    const projectsDir = path.join(PUBLIC, 'projects');
    if (fs.exists(projectsDir)) fs.remove(projectsDir);
    for (const placeholder of ['chat', 'account', 'arena', 'projects', 'wiki']) {
      const file = path.join(PUBLIC, placeholder, 'index.html');
      fs.mkdir(path.dirname(file));
      fs.write(file, '');
    }
    const runningTournament = getRunning();
    if (runningTournament) {
      const tourStub = path.join(
        PUBLIC,
        'arena',
        'tournaments',
        runningTournament.id,
        'index.html'
      );
      fs.mkdir(path.dirname(tourStub));
      fs.write(tourStub, '');
    }

    const files = [
      'favicon.svg', 'cc.svg', 'by.svg', 'sa.svg', 'projects.bib', 'research.bib', 'llms.txt',
    ];
    for (const file of files) {
      fs.copy(path.join(STATIC, file), path.join(PUBLIC, file));
    }
    fs.write(path.join(PUBLIC, 'index.html'), renderer.render({
      id: 'home',
      title: 'pkmn.ai',
      header: <h1>pkmn.ai</h1>,
      path: '',
      content: raw(
        site.html.render(fs.read(path.join(STATIC, 'index.dj')).replace('<a', '<a class="subtle"'))
      ),
    }));

    renderer.create('glossary', glossary.page(STATIC));
    renderer.create('research', research.page(STATIC));

    renderBattleViewerPage(PUBLIC);
    const pruneArena = (dir: string, relDir: string) => {
      for (const entry of nodeFs.readdirSync(dir, {withFileTypes: true})) {
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (rel === 'viewer') continue;
          pruneArena(full, rel);
          if (nodeFs.readdirSync(full).length === 0) nodeFs.rmdirSync(full);
          continue;
        }
        const keep =
          rel === 'index.html' ||
          (runningTournament !== undefined &&
            rel === `tournaments/${runningTournament.id}/index.html`) ||
          /\.(?:7z|log|tar)$/i.test(entry.name);
        if (!keep) nodeFs.unlinkSync(full);
      }
    };
    pruneArena(path.join(PUBLIC, 'arena'), '');

    const pages: {[page: string]: string} = {
      background: 'Background',
      rules: 'Rules',
      release: 'Responsible Release',
    };
    for (const [page, title] of Object.entries(pages)) {
      const file = path.join(STATIC, `${page}.dj`);
      const citation = page === 'background' ? cite(title, fs.stat(file).mtime) : '';
      const rendered = site.html.render(fs.read(file));
      const body = page === 'rules'
        ? rendered.replaceAll('href="/llms.txt/"', 'href="/llms.txt"')
        : rendered;
      renderer.create(page, {
        path: `/${page}/`,
        style: page === 'release' ? `
          span.email b { display: none; }
          span.email { font-family: monospace; }
      ` : page === 'rules' ? `
          p.note { color: rgb(var(--fg-base) / 50%); font-size: smaller; }
      ` : page === 'background' ? style : '',
        title: `${title} | pkmn.ai`,
        header: header(title, page === 'background'),
        content: <>{raw(body)}{raw(citation)}</>,
      });
    }

    const priv = root('private', 'build.js');
    if (fs.exists(priv)) require(priv)(renderer, expected);

    renderer.create('concepts', {
      path: '/concepts/',
      title: 'Concepts | pkmn.ai',
      style: `
      ul {
        margin-top: 3em;
        padding: 0;
        text-align: center;
      }
      li {
        margin-bottom: 0.5rem;
        line-height: 1.15;
        list-style: none;
      }`,
      header: header('Concepts'),
      content: raw(site.html.render(fs.read(path.join(STATIC, 'concepts.dj')))),
    });

    if (!rebuild) {
      const now = new Date();
      for (const file of actual) {
        const full = path.join(PUBLIC, file);
        if (!expected.has(file) && !renderer.retain(full, now)) {
          fs.remove(full);
        }
      }
    }

    actual = fs.list(path.join(PUBLIC, 'concepts'));
    expected = new Set(['index.html']);

    const titles = ['Baselines', 'Complexity', 'Engines', 'Protocol', 'Variants'];
    for (const title of titles) {
      const page = title.toLowerCase();
      expected.add(page);
      const wip = title !== 'Variants';
      const file = path.join(STATIC, 'concepts', `${page}.dj`);
      const citation = cite(`Concepts — ${title}`, fs.stat(file).mtime, `concepts/${page}`);
      renderer.create(`concepts/${page}`, {
        path: `/concepts/${page}/`,
        title: `Concepts — ${title} | pkmn.ai`,
        style: wip ? style : '',
        header: header(title, wip),
        content: <>{raw(site.html.render(fs.read(file)))}{raw(citation)}</>,
      });
    }

    for (const file of actual) {
      if (!expected.has(file)) fs.remove(path.join(PUBLIC, 'concepts', file));
    }
  } finally {
    renderer.minify = false;
    renderer.liveBannerProvider = undefined;
    db?.close();
  }
};

if (require.main === module) {
  (async () => {
    await build(process.argv[2] === '--rebuild');
  })().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
