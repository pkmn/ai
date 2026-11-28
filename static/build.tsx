// Based on the MIT licensed matklad/matklad.github.io:
// https://github.com/matklad/matklad.github.io/blob/master/LICENSE-MIT

require('source-map-support').install();

import {AsyncLocalStorage} from 'async_hooks';
import * as nodeFs from 'fs';
import * as http from 'http';
import * as path from 'path';

import favicons from 'favicons';
import * as site from 'site';

import {DB_PATH, Database, parseArenaProjects} from '../db';
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
// battle viewer iframe theme updates, and SSR account avatar error fallback across every page in
// one place.
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
  "var img=document.querySelector('#account-link img');",
  'if(img){',
  'var onErr=function(){',
  'if(img.parentNode)img.parentNode.removeChild(img);',
  "var a=document.getElementById('account-link');",
  "if(a)a.classList.remove('has-avatar');",
  '};',
  "img.addEventListener('error',onErr);",
  'if(img.complete&&img.naturalWidth===0)onErr();',
  '}',
  "var menu=document.getElementById('site-menu');",
  'if(menu){',
  "document.addEventListener('click',function(ev){",
  'if(menu.open&&!menu.contains(ev.target))menu.open=false;',
  '});',
  "document.addEventListener('keydown',function(ev){",
  "if(ev.key==='Escape'&&menu.open){",
  'menu.open=false;',
  "var sum=menu.querySelector('summary');",
  'if(sum)sum.focus();',
  '}',
  '});',
  '}',
  '})();',
].join('');

// Converts SSR UTC `<time data-epoch>` elements and `[data-title-tmpl][data-title-epochs]`
// tooltips into the viewer's local timezone immediately after `<body>`, and exposes `pkmnTime`
// for dynamic client-rendered rows and API messages. Written in ES5 for `html-minifier`/UglifyJS.
export const LOCALIZE_TIME = [
  'var pkmnTime=(function(){',
  "var pad=function(n){return n<10?'0'+n:String(n);};",
  "var ymd=function(d){return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());};",
  'var tzFmt=null;',
  'try{if(typeof Intl!=="undefined"&&Intl.DateTimeFormat)',
  "tzFmt=new Intl.DateTimeFormat(undefined,{timeZoneName:'short'});}catch(e){}",
  'var tzOf=function(d){if(!tzFmt)return "";try{',
  'var ps=tzFmt.formatToParts(d);',
  "for(var i=0;i<ps.length;i++)if(ps[i].type==='timeZoneName')return ps[i].value;",
  "}catch(e){}return '';};",
  'var date=function(s){return ymd(new Date(s*1000));};',
  'var dateTime=function(s){var d=new Date(s*1000);var z=tzOf(d);',
  "return ymd(d)+' '+pad(d.getHours())+':'+pad(d.getMinutes())+(z?' '+z:'');};",
  'var timestamp=function(s){var d=new Date(s*1000);var z=tzOf(d);',
  "return ymd(d)+' '+pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds())",
  "+(z?' '+z:'');};",
  'var fmtBy=function(s,f){',
  "return f==='date'?date(s):f==='datetime'?dateTime(s):timestamp(s);};",
  'var text=function(str){if(!str)return str;',
  'return String(str).replace(',
  '/\\b(\\d{4})-(\\d{2})-(\\d{2}) (\\d{2}):(\\d{2})(?::(\\d{2}))? UTC\\b/g,',
  'function(_,y,mo,da,h,mi,sc){',
  'var s=Math.floor(Date.UTC(',
  'Number(y),Number(mo)-1,Number(da),Number(h),Number(mi),sc?Number(sc):0)/1000);',
  'return sc?timestamp(s):dateTime(s);});};',
  "var applyTime=function(el){var raw=el.getAttribute('data-epoch');",
  'if(!raw)return;var s=Number(raw);',
  "if(isFinite(s))el.textContent=fmtBy(s,el.getAttribute('data-fmt'));};",
  'var applyTitle=function(el){',
  "var tmpl=el.getAttribute('data-title-tmpl');",
  "var raw=el.getAttribute('data-title-epochs');",
  'if(!tmpl||!raw)return;',
  "var eps=raw.split(',');",
  'el.title=tmpl.replace(/\\{(\\d+)(?::(date|datetime))?\\}/g,function(_,i,f){',
  "var r=eps[Number(i)];var s=r?Number(r):NaN;return isFinite(s)?fmtBy(s,f):'';});};",
  'var localize=function(root){var sc=root||document;',
  "if(sc!==document&&sc.getAttribute){if(sc.tagName==='TIME'&&sc.hasAttribute('data-epoch'))",
  'applyTime(sc);',
  "if(sc.hasAttribute('data-title-tmpl'))applyTitle(sc);}",
  "var ts=sc.querySelectorAll('time[data-epoch]');for(var i=0;i<ts.length;i++)applyTime(ts[i]);",
  "var tt=sc.querySelectorAll('[data-title-tmpl][data-title-epochs]');",
  'for(var j=0;j<tt.length;j++)applyTitle(tt[j]);};',
  'return {date:date,dateTime:dateTime,timestamp:timestamp,text:text,localize:localize};',
  '})();',
  'window.pkmnTime=pkmnTime;',
  'pkmnTime.localize(document);',
].join('');

export interface AccountProfile {
  authenticated: boolean;
  username?: string;
  avatarUrl?: string;
}

export const accountContext = new AsyncLocalStorage<AccountProfile>();

const ACCOUNT_LINK_RE = /<a\b[^>]*\bid="account-link"[^>]*>([\s\S]*?<\/svg>)<\/a>/;

// Injects the authenticated user's avatar and tooltip directly into SSR HTML (both dynamic
// `Renderer.render` output and pre-built `public/**/*.html` pages served by Node), leaving
// signed-out pages untouched.
export function applyAccountProfile(html: string, account?: AccountProfile): string {
  if (!account?.authenticated || !ACCOUNT_LINK_RE.test(html)) return html;
  const label = account.username ? `Account (@${account.username})` : 'Account';
  const avatarUrl = account.avatarUrl;
  let out = html;
  if (avatarUrl) {
    const preload =
      `<link rel="preload" as="image" href="${escapeHtml(avatarUrl)}"` +
      ' referrerpolicy="no-referrer">';
    out = out.replace('</head>', `${preload}</head>`);
  }
  return out.replace(ACCOUNT_LINK_RE, (_, svg: string) => {
    const cls = avatarUrl ? 'subtle has-avatar' : 'subtle';
    const img = avatarUrl
      ? `<img src="${escapeHtml(avatarUrl)}" alt="" referrerpolicy="no-referrer">`
      : '';
    return (
      `<a id="account-link" href="/account/" class="${cls}"` +
      ` aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${svg}${img}</a>`
    );
  });
}

export interface BackLink {
  href: string;
  label: string;
}

interface SiteMenuItem {
  href: string;
  label: string;
  match: (normalizedPath: string) => boolean;
}

const SITE_MENU_PRIMARY: readonly SiteMenuItem[] = [
  {
    href: '/arena/',
    label: 'Arena',
    match: p =>
      p === '/arena' || p.startsWith('/arena/ladders/') || p.startsWith('/arena/tournaments/'),
  },
  {
    href: '/arena/battles/',
    label: 'Battles',
    match: p => p === '/arena/battles' || p.startsWith('/arena/battles/'),
  },
  {
    href: '/projects/',
    label: 'Projects',
    match: p => p === '/projects' || p.startsWith('/projects/'),
  },
  {
    href: '/rules/',
    label: 'Rules',
    match: p => p === '/rules',
  },
];

const SITE_MENU_SECONDARY: readonly SiteMenuItem[] = [
  {
    href: '/wiki/',
    label: 'Wiki',
    match: p => p === '/wiki' || p.startsWith('/wiki/'),
  },
  {
    href: '/research/',
    label: 'Research',
    match: p => p === '/research',
  },
  {
    href: '/glossary/',
    label: 'Glossary',
    match: p => p === '/glossary',
  },
  {
    href: '/chat/',
    label: 'Discord',
    match: () => false,
  },
];

export function resolveBackLink(pagePath: string): BackLink | undefined {
  const p = pagePath.replace(/\/+$/, '') || '/';
  if (p.startsWith('/arena/')) return {href: '/arena/', label: 'Arena'};
  if (p.startsWith('/projects/')) return {href: '/projects/', label: 'Projects'};
  if (p.startsWith('/concepts/')) return {href: '/concepts/', label: 'Concepts'};
  if (p.startsWith('/wiki/')) return {href: '/wiki/', label: 'Wiki'};
  return undefined;
}

export function formatTopNav(pagePath: string, backLink?: BackLink | false): string {
  const normalized = pagePath.replace(/\/+$/, '') || '/';
  const resolvedBack = backLink === false
    ? undefined
    : (backLink ?? resolveBackLink(pagePath));
  const renderItem = (item: SiteMenuItem) => {
    const active = item.match(normalized);
    return (
      <a
        href={item.href}
        className='subtle'
        aria-current={active ? 'page' : undefined}
      >
        {active ? <strong>{item.label}</strong> : item.label}
      </a>
    );
  };
  return String(
    <div id='top-nav'>
      <details id='site-menu'>
        <summary aria-label='Navigation menu' title='Menu'>
          <svg className='menu-icon' viewBox='0 0 20 20' aria-hidden='true'>
            <path
              d='M3 5.5h14M3 10h14M3 14.5h14'
              fill='none'
              stroke='currentColor'
              strokeWidth='2'
              strokeLinecap='round'
            />
          </svg>
        </summary>
        <div className='site-menu-panel' role='navigation' aria-label='Site navigation'>
          {SITE_MENU_PRIMARY.map(renderItem)}
          <hr />
          {SITE_MENU_SECONDARY.map(renderItem)}
        </div>
      </details>
      {resolvedBack && (
        <a href={resolvedBack.href} className='subtle back-link'>
          <span aria-hidden='true'>{'\u2039'}</span> {resolvedBack.label}
        </a>
      )}
    </div>
  );
}

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

export const ARENA_RESTART_BANNER_TEXT =
  'Arena is restarting — match scheduling will resume shortly';

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

export function formatArenaRestartBanner(restarting?: boolean): string {
  if (!restarting) return '';
  return String(<div id='topbar' className='restarting'>{ARENA_RESTART_BANNER_TEXT}</div>);
}

export function injectLiveBanner(
  headerHtml: Html | string | undefined,
  tournament?: {id: string; name: string},
  restarting?: boolean
): string | undefined {
  const headerStr = headerHtml !== undefined ? String(headerHtml) : undefined;
  const banner = formatLiveTournamentBanner(tournament) || formatArenaRestartBanner(restarting);
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
  preconnect?: readonly string[];
  preloadImages?: readonly string[];
  topControls?: boolean;
  backLink?: BackLink | false;
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
    const baseScript = `${SET_THEME}\n${LOCALIZE_TIME}`;
    const script = page.script ? `${baseScript}\n${page.script}` : baseScript;
    const banner = this.liveBannerProvider?.() ?? '';
    const rawHeader = page.header !== undefined ? String(page.header) : undefined;
    const withBanner = banner && !rawHeader?.includes('id="topbar"')
      ? (rawHeader ? `${banner}\n  ${rawHeader}` : banner)
      : rawHeader;
    let headerHtml = withBanner;
    if (page.topControls !== false) {
      if (!headerHtml?.includes('id="top-nav"')) {
        const topNav = formatTopNav(page.path, page.backLink);
        headerHtml = headerHtml ? `${headerHtml}\n  ${topNav}` : topNav;
      }
      if (!headerHtml?.includes('id="top-controls"')) {
        headerHtml = headerHtml ? `${headerHtml}\n  ${TOP_CONTROLS}` : TOP_CONTROLS;
      }
    }

    const preconnectTags = (page.preconnect ?? [])
      .map(origin => `<link rel="preconnect" href="${escapeHtml(origin)}">`)
      .join('');
    const preloadTags = (page.preloadImages ?? [])
      .map(
        href => `<link rel="preload" as="image" href="${escapeHtml(href)}" fetchpriority="high">`
      )
      .join('');

    if (this.minify) {
      const transform = (s: string) => {
        const cleaned = IS_PRODUCTION ? s : s.replace(GTAG_RE, '');
        const withHead = cleaned.replace(
          '</head>',
          `${preconnectTags}${preloadTags}<script>${EARLY_THEME_SCRIPT}</script></head>`
        );
        return replace ? replace(withHead) : withHead;
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
      preconnectTags,
      preloadTags,
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
    const withAccount = applyAccountProfile(rendered, accountContext.getStore());
    return replace ? replace(withAccount) : withAccount;
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
    for (const placeholder of ['chat', 'account', 'arena', 'arena/battles', 'projects', 'wiki']) {
      const file = path.join(PUBLIC, placeholder, 'index.html');
      fs.mkdir(path.dirname(file));
      fs.write(file, '');
    }
    // Copy resolved Arena project logos into `public/projects/<slug><ext>` so Nginx serves them
    // directly from disk (with immutable 1-year caching on `?v=<hash>`) without hitting Node.
    const avatarsDir = path.join(STATIC, 'avatars');
    const projectsYmlPath = path.join(STATIC, 'projects.yml');
    if (nodeFs.existsSync(avatarsDir) && nodeFs.existsSync(projectsYmlPath)) {
      const projectsYaml = nodeFs.readFileSync(projectsYmlPath, 'utf8');
      for (const proj of parseArenaProjects(projectsYaml, avatarsDir)) {
        if (!proj.logo) continue;
        const src = path.join(avatarsDir, proj.logo);
        if (!nodeFs.existsSync(src)) continue;
        const ext = (path.extname(proj.logo) || '.png').toLowerCase();
        fs.copy(src, path.join(projectsDir, `${proj.slug}${ext}`));
      }
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
          rel === 'battles/index.html' ||
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
