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

// Applied in `<head>` before first paint so a saved `localStorage` theme choice never flashes the
// OS default. Defaults to `'system'` (tracking `prefers-color-scheme`) when unset or unavailable.
export const EARLY_THEME_SCRIPT =
  '(function(){try{' +
  "var t=localStorage.getItem('theme');" +
  "var m=t==='light'||t==='dark'?t:'system';" +
  "var d=m==='dark'||(m==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);" +
  "document.documentElement.setAttribute('data-theme',d?'dark':'light');" +
  "document.documentElement.setAttribute('data-theme-mode',m);" +
  '}catch(e){}})();';

// `site`'s `layout.html` registers `pref.addEventListener('change', e => setTheme(...))` in its
// outer `<script>` block without defining `setTheme`, expecting each page's `{{{ script }}}`
// payload to supply it. Injecting `SET_THEME` inside `Renderer.render` wires up manual
// switching (persisted in `localStorage`, starting opposite the current OS theme so the first
// click always produces a visible change), live OS updates when in `system` mode, cross-tab sync,
// battle viewer iframe theme updates, and the top-right account avatar via `/api/me` across every
// static and dynamic page in one place.
export const SET_THEME = [
  "var THEME_KEY='theme';",
  "var THEME_LABELS={system:'Theme: System',light:'Theme: Light',dark:'Theme: Dark'};",
  'var readThemeMode=function(){try{var v=localStorage.getItem(THEME_KEY);',
  "return v==='light'||v==='dark'?v:'system';}catch(e){return 'system';}};",
  'var applyThemeMode=function(mode){',
  "var m=mode==='light'||mode==='dark'?mode:'system';",
  "var dark=m==='dark'||(m==='system'&&pref.matches);",
  "document.documentElement.setAttribute('data-theme',dark?'dark':'light');",
  "document.documentElement.setAttribute('data-theme-mode',m);",
  "var btn=document.getElementById('theme-toggle');",
  'if(btn){var lbl=THEME_LABELS[m];',
  "btn.setAttribute('title',lbl);btn.setAttribute('aria-label',lbl);}",
  "var frames=document.querySelectorAll('iframe.viewer-frame');",
  'for(var i=0;i<frames.length;i++){',
  "if(frames[i].contentWindow)frames[i].contentWindow.postMessage({type:'theme',dark:dark},'*');",
  '}',
  '};',
  "var setTheme=function(){if(readThemeMode()==='system')applyThemeMode('system');};",
  'applyThemeMode(readThemeMode());',
  '(function(){',
  "var btn=document.getElementById('theme-toggle');",
  "if(btn){btn.addEventListener('click',function(){",
  'var cur=readThemeMode();',
  "var order=pref.matches?['system','light','dark']:['system','dark','light'];",
  'var next=order[(order.indexOf(cur)+1)%order.length];',
  "try{if(next==='system')localStorage.removeItem(THEME_KEY);",
  'else localStorage.setItem(THEME_KEY,next);}catch(e){}',
  'applyThemeMode(next);',
  '});}',
  "window.addEventListener('storage',function(ev){",
  'if(ev.key===THEME_KEY||ev.key===null)applyThemeMode(readThemeMode());',
  '});',
  "var acc=document.getElementById('account-link');",
  'if(acc&&window.fetch){',
  "fetch('/api/me',{credentials:'same-origin'})",
  '.then(function(r){return r.ok?r.json():null;})',
  '.then(function(data){',
  'if(!data||!data.authenticated)return;',
  "if(data.username){var lbl='Account (@'+data.username+')';",
  "acc.setAttribute('title',lbl);acc.setAttribute('aria-label',lbl);}",
  'if(!data.avatarUrl)return;',
  "var img=document.createElement('img');",
  "img.alt='';",
  "img.referrerPolicy='no-referrer';",
  "img.decoding='async';",
  'img.onload=function(){',
  "acc.textContent='';",
  'acc.appendChild(img);',
  "acc.classList.add('has-avatar');",
  '};',
  'img.src=data.avatarUrl;',
  '})',
  '.catch(function(){});',
  '}',
  '})();',
].join('');

export const TOP_CONTROLS = String(
  <div id='top-controls'>
    <button
      type='button'
      id='theme-toggle'
      aria-label='Theme: System'
      title='Theme: System'
    >
      <svg className='theme-icon theme-icon-system' viewBox='0 0 20 20' aria-hidden='true'>
        <circle cx='10' cy='10' r='7.5' fill='none' stroke='currentColor' strokeWidth='2' />
        <path d='M10 2.5a7.5 7.5 0 0 0 0 15Z' fill='currentColor' />
      </svg>
      <svg className='theme-icon theme-icon-light' viewBox='0 0 20 20' aria-hidden='true'>
        <circle cx='10' cy='10' r='4' fill='currentColor' />
        <path
          d={
            'M10 1v2.5M10 16.5V19M1 10h2.5M16.5 10H19' +
            'M3.6 3.6l1.8 1.8M14.6 14.6l1.8 1.8M3.6 16.4l1.8-1.8M14.6 5.4l1.8-1.8'
          }
          fill='none'
          stroke='currentColor'
          strokeWidth='2'
          strokeLinecap='round'
        />
      </svg>
      <svg className='theme-icon theme-icon-dark' viewBox='0 0 20 20' aria-hidden='true'>
        <path d='M16.5 12.2A7 7 0 0 1 7.8 3.5a7 7 0 1 0 8.7 8.7z' fill='currentColor' />
      </svg>
    </button>
    <a
      id='account-link'
      href='/account/'
      className='subtle'
      aria-label='Account'
      title='Account'
    >
      <svg className='account-icon' viewBox='0 0 20 20' aria-hidden='true'>
        <circle cx='10' cy='10' r='7.5' fill='none' stroke='currentColor' strokeWidth='2' />
        <circle cx='10' cy='7.5' r='2.5' fill='currentColor' />
        <path
          d='M4.5 15.1C5.3 12.5 7.4 11.3 10 11.3s4.7 1.2 5.5 3.8a7.5 7.5 0 0 1-11 0Z'
          fill='currentColor'
        />
      </svg>
    </a>
  </div>
);

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

const BUILT_STYLESHEET_RE = /^index\.[0-9a-f]{8}\.css$/;

function findBuiltStylesheet(publicDir: string, stylesheetPath: string): string | undefined {
  if (!nodeFs.existsSync(publicDir)) return undefined;
  const styleMtime = nodeFs.statSync(stylesheetPath).mtimeMs;
  let newestFile: string | undefined;
  let newestMtime = -1;
  for (const entry of nodeFs.readdirSync(publicDir)) {
    if (!BUILT_STYLESHEET_RE.test(entry)) continue;
    const mtime = nodeFs.statSync(path.join(publicDir, entry)).mtimeMs;
    if (mtime >= styleMtime && mtime > newestMtime) {
      newestMtime = mtime;
      newestFile = entry;
    }
  }
  return newestFile ? `/${newestFile}` : undefined;
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
      this.stylesheetHref = findBuiltStylesheet(
        this.siteConfig.public,
        this.siteConfig.stylesheet
      );
      if (!this.stylesheetHref) {
        const shell = super.render({title: '', path: '', content: ''});
        const match = /href="(\/index\.[^"]+\.css)"/.exec(shell);
        if (!match) throw new Error('Failed to initialize site base stylesheet');
        this.stylesheetHref = match[1];
      }
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
    const withBanner = banner && !rawHeader?.includes('id="topbar"')
      ? (rawHeader ? `${banner}\n  ${rawHeader}` : banner)
      : rawHeader;
    const headerHtml = withBanner?.includes('id="top-controls"')
      ? withBanner
      : (withBanner ? `${withBanner}\n  ${TOP_CONTROLS}` : TOP_CONTROLS);

    if (this.minify) {
      const transform = (s: string) => {
        const cleaned = IS_PRODUCTION ? s : s.replace(GTAG_RE, '');
        const withTheme = cleaned.replace(
          '</head>',
          `<script>${EARLY_THEME_SCRIPT}</script></head>`
        );
        return replace ? replace(withTheme) : withTheme;
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
    const headerTag = `<header>${headerHtml}</header>`;
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
      `<script>${EARLY_THEME_SCRIPT}</script>`,
      `</head>${bodyTag}`,
      `${headerTag}<main>${String(page.content)}</main>`,
      '<footer><a href="https://creativecommons.org/licenses/by-sa/4.0/">',
      '<img src="/cc.svg" alt="CC"><img src="/by.svg" alt="BY">',
      '<img src="/sa.svg" alt="SA"></a></footer>',
      '</body><script>',
      "const pref=window.matchMedia('(prefers-color-scheme: dark)');",
      "pref.addEventListener('change',e=>setTheme(e.matches?'dark':'light'));",
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
