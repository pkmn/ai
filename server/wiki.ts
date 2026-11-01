import {execFile} from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as querystring from 'querystring';
import {promisify} from 'util';

import type polka from 'polka';
import * as site from 'site';
import * as yaml from 'yaml';

import {header, renderer} from '../static/build';

const execFileAsync = promisify(execFile);

const ROOT = path.basename(path.dirname(__dirname)) === 'build'
  ? path.join(__dirname, '..', '..')
  : path.join(__dirname, '..');
const DEFAULT_WIKI_DIR = path.join(ROOT, 'wiki');
const DEFAULT_PROJECTS_FILE = path.join(ROOT, 'static', 'projects.yml');
const DEFAULT_CONFIG_FILE = path.join(ROOT, 'config', 'wiki.yml');
const DEFAULT_OAUTH_FILE = path.join(ROOT, 'private', 'github.yml');

const SESSION_COOKIE = 'pkmn_wiki_session';
const STATE_COOKIE = 'pkmn_wiki_state';
const SESSION_TTL_S = 30 * 24 * 60 * 60;
const STATE_TTL_S = 10 * 60;
const MAX_BODY_BYTES = 256 * 1024;

const SHA_RE = /^[0-9a-f]{7,40}$/;
const RESERVED_SLUGS = new Set(['pages', 'edit', 'history']);

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  sessionSecret: string;
  callbackUrl?: string;
  admins?: string[];
  authors?: {[github: string]: string};
}

export interface WikiConfig {
  admins?: string[];
  authors?: {[github: string]: string};
}

export interface WikiOptions {
  wikiDir?: string;
  projectsFile?: string;
  configFile?: string;
  oauthFile?: string;
  oauth?: OAuthConfig;
  push?: boolean;
}

interface ProjectEntry {
  arena?: {
    author?: string;
    github?: string | string[];
  };
}

export interface Revision {
  sha: string;
  shortSha: string;
  author: string;
  timestamp: number;
  subject: string;
}

export function normalizeSlug(raw: string): string {
  try {
    return decodeURIComponent(raw).trim().replace(/[\s_]+/g, '_');
  } catch {
    return '';
  }
}

export function isValidSlug(slug: string): boolean {
  if (!slug || slug.length > 200) return false;
  if (slug.startsWith('.') || slug.includes('..')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[/\\<>:"|?*\x00-\x1f\x7f]/.test(slug)) return false;
  return !RESERVED_SLUGS.has(slug.toLowerCase());
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatTitle(slug: string): string {
  if (slug === 'index') return 'Wiki';
  const spaced = slug.replace(/_/g, ' ');
  return spaced ? spaced[0].toUpperCase() + spaced.slice(1) : spaced;
}

export function encodeSlug(slug: string): string {
  return encodeURIComponent(slug);
}

export function signToken(payload: object, secret: string): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function verifyToken<T extends {exp?: number}>(
  token: string | undefined,
  secret: string,
  now = Math.floor(Date.now() / 1000)
): T | undefined {
  if (!token || !secret) return undefined;
  const dot = token.indexOf('.');
  if (dot <= 0) return undefined;
  const data = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as T;
    if (typeof parsed.exp === 'number' && parsed.exp < now) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

export function extractAuthorizedGitHubUsers(
  projectsYaml: string,
  admins: Iterable<string> = []
): Set<string> {
  const users = new Set<string>();
  for (const admin of admins) {
    const clean = admin.trim().toLowerCase();
    if (clean) users.add(clean);
  }
  const entries = (yaml.parse(projectsYaml) ?? []) as ProjectEntry[];
  if (!Array.isArray(entries)) return users;
  for (const entry of entries) {
    const gh = entry?.arena?.github;
    if (!gh) continue;
    const list = Array.isArray(gh) ? gh : [gh];
    for (const u of list) {
      if (typeof u === 'string' && u.trim()) {
        users.add(u.trim().toLowerCase());
      }
    }
  }
  return users;
}

export function extractAuthorMap(
  projectsYaml: string,
  overrides: {[github: string]: string} = {}
): Map<string, string> {
  const map = new Map<string, string>();
  const entries = (yaml.parse(projectsYaml) ?? []) as ProjectEntry[];
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      const author = entry?.arena?.author?.trim();
      const gh = entry?.arena?.github;
      if (!author || !gh) continue;
      const list = Array.isArray(gh) ? gh : [gh];
      if (list.length === 1 && typeof list[0] === 'string' && list[0].trim()) {
        map.set(list[0].trim().toLowerCase(), author);
      }
    }
  }
  for (const [gh, name] of Object.entries(overrides)) {
    if (gh.trim() && typeof name === 'string' && name.trim()) {
      map.set(gh.trim().toLowerCase(), name.trim());
    }
  }
  return map;
}

export function loadOAuthConfig(file = DEFAULT_OAUTH_FILE): OAuthConfig | undefined {
  let fileCfg: Partial<Record<string, any>> = {};
  if (fs.existsSync(file)) {
    fileCfg = (yaml.parse(fs.readFileSync(file, 'utf8')) ?? {}) as Record<string, any>;
  }
  const clientId = process.env.GITHUB_CLIENT_ID ?? fileCfg.client_id ?? fileCfg.clientId;
  const clientSecret =
    process.env.GITHUB_CLIENT_SECRET ?? fileCfg.client_secret ?? fileCfg.clientSecret;
  const sessionSecret =
    process.env.SESSION_SECRET ?? fileCfg.session_secret ?? fileCfg.sessionSecret;
  const callbackUrl =
    process.env.GITHUB_CALLBACK_URL ?? fileCfg.callback_url ?? fileCfg.callbackUrl;
  const envAdmins = process.env.GITHUB_ADMINS
    ? process.env.GITHUB_ADMINS.split(',').map(s => s.trim()).filter(Boolean)
    : undefined;
  const admins: string[] | undefined = envAdmins ?? fileCfg.admins;
  const authors: {[github: string]: string} | undefined = fileCfg.authors;
  if (!clientId || !clientSecret || !sessionSecret) return undefined;
  return {
    clientId: String(clientId),
    clientSecret: String(clientSecret),
    sessionSecret: String(sessionSecret),
    callbackUrl: callbackUrl ? String(callbackUrl) : undefined,
    admins: Array.isArray(admins) ? admins.map(String) : undefined,
    authors: authors && typeof authors === 'object' ? authors : undefined,
  };
}

const WIKI_STYLE = `
  main {
    width: 100%;
  }
  #wiki-nav {
    margin-top: auto;
    padding-top: 2rem;
    text-align: center;
  }
  #wiki-nav + footer {
    margin-top: 0;
  }
  #wiki-editor textarea {
    display: block;
    width: 100%;
    min-height: 24rem;
    padding: 1.5ch;
    color: var(--fg-color);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.95em;
    line-height: 1.45;
    background-color: var(--code-bg-color);
    border: 1px solid var(--code-border-color);
    border-radius: var(--border-radius);
    resize: vertical;
  }
  #wiki-editor input {
    display: block;
    width: 100%;
    margin: 0.75rem 0;
    padding: 0.5rem 1.5ch;
    color: var(--fg-color);
    background-color: var(--code-bg-color);
    border: 1px solid var(--code-border-color);
    border-radius: var(--border-radius);
  }
  #wiki-actions {
    margin-top: 0.5rem;
    font-size: 1.1em;
    text-align: center;
  }
  #wiki-actions button {
    padding: 0;
    color: var(--link-color);
    background: none;
    border: none;
    cursor: pointer;
  }
  #wiki-actions button:hover,
  #wiki-actions button:focus,
  #wiki-actions button:active {
    text-decoration: underline;
  }
  #wiki-preview {
    margin-bottom: 2rem;
    padding: 1rem 2ch;
    border: 1px dashed var(--aside-border-color);
    border-radius: var(--border-radius);
  }
  #wiki-pages {
    margin-top: 3em;
    padding: 0;
    text-align: center;
  }
  #wiki-pages li {
    margin-bottom: 0.5rem;
    line-height: 1.15;
    list-style: none;
  }
  .wiki-meta {
    color: rgb(var(--fg-base) / 60%);
    font-size: 0.9em;
  }
  [id] { scroll-margin-top: 2rem; }
`;

function renderWikiPage(opts: {
  id?: string;
  title: string;
  heading: string;
  path: string;
  nav?: string;
  content: string;
}) {
  return renderer.render({
    id: opts.id ?? 'wiki',
    title: `${opts.title} | pkmn.ai`,
    header: header(opts.heading),
    path: opts.path,
    style: WIKI_STYLE,
    content: opts.content,
  }, s => {
    const withRobots = s.replace('</title>', '</title><meta name="robots" content="noindex">');
    return opts.nav ? withRobots.replace('<footer>', `${opts.nav}<footer>`) : withRobots;
  });
}

function wikiNav(slug: string, active: 'view' | 'edit' | 'history' | 'pages'): string {
  const item = (key: typeof active, href: string, label: string) =>
    key === active ? `<strong>${label}</strong>` : `<a href="${href}">${label}</a>`;
  const encoded = encodeSlug(slug);
  const viewHref = slug === 'index' ? '/wiki' : `/wiki/${encoded}`;
  return `<nav id="wiki-nav">
    ${item('view', viewHref, 'View')} —
    ${item('edit', `/wiki/${encoded}/edit`, 'Edit')} —
    ${item('history', `/wiki/${encoded}/history`, 'History')} —
    ${item('pages', '/wiki/pages', 'Pages')}
  </nav>`;
}

export function renderDjot(raw: string, save?: {title?: string; summary?: string}): string {
  return site.html.render(raw, {
    save,
    overrides: {
      link: (node, r) => {
        const dest = node.destination;
        if (dest && !dest.startsWith('/') && !dest.startsWith('#') && !/^[a-zA-Z]+:/.test(dest)) {
          const [p, hash] = dest.split('#');
          const clean = normalizeSlug(p.replace(/\.dj$/, ''));
          node.destination = `/wiki/${encodeSlug(clean)}${hash ? `#${hash}` : ''}`;
        }
        return r.renderAstNodeDefault(node);
      },
    },
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(Object.assign(new Error('Payload Too Large'), {status: 413}));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendHtml(res: http.ServerResponse, status: number, html: string) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'private, no-store',
  });
  res.end(html);
}

function redirect(res: http.ServerResponse, location: string, status = 302, cookies?: string[]) {
  const headers: http.OutgoingHttpHeaders = {
    Location: location,
    'Cache-Control': 'private, no-store',
  };
  if (cookies?.length) headers['Set-Cookie'] = cookies;
  res.writeHead(status, headers);
  res.end();
}

export class WikiService {
  readonly wikiDir: string;
  readonly projectsFile: string;
  readonly configFile: string;
  readonly oauthFile: string;
  private readonly explicitOAuth?: OAuthConfig;
  private readonly shouldPush: boolean;
  private projectsMtime = -1;
  private configMtime = -1;
  private authorizedUsers = new Set<string>();
  private authorMap = new Map<string, string>();
  private gitQueue: Promise<any> = Promise.resolve();

  constructor(options: WikiOptions = {}) {
    this.wikiDir = options.wikiDir ?? DEFAULT_WIKI_DIR;
    this.projectsFile = options.projectsFile ?? DEFAULT_PROJECTS_FILE;
    this.configFile = options.configFile ?? DEFAULT_CONFIG_FILE;
    this.oauthFile = options.oauthFile ?? DEFAULT_OAUTH_FILE;
    this.explicitOAuth = options.oauth;
    this.shouldPush = options.push ?? (
      process.env.WIKI_PUSH === '1' || process.env.NODE_ENV === 'production'
    );
  }

  getOAuthConfig(): OAuthConfig | undefined {
    return this.explicitOAuth ?? loadOAuthConfig(this.oauthFile);
  }

  private refreshMetadata() {
    let pMtime = -1;
    let cMtime = -1;
    try {
      pMtime = fs.statSync(this.projectsFile).mtimeMs;
    } catch {}
    try {
      cMtime = fs.statSync(this.configFile).mtimeMs;
    } catch {}

    if (pMtime === this.projectsMtime && cMtime === this.configMtime && this.projectsMtime !== -1) {
      return;
    }

    let projectsRaw = '';
    if (pMtime !== -1) {
      try {
        projectsRaw = fs.readFileSync(this.projectsFile, 'utf8');
      } catch {}
    }

    let wikiCfg: WikiConfig = {};
    if (cMtime !== -1) {
      try {
        wikiCfg = (yaml.parse(fs.readFileSync(this.configFile, 'utf8')) ?? {}) as WikiConfig;
      } catch {}
    }

    const oauth = this.getOAuthConfig();
    const admins = [...(wikiCfg.admins ?? []), ...(oauth?.admins ?? [])];
    const authors = {...(wikiCfg.authors ?? {}), ...(oauth?.authors ?? {})};

    this.authorizedUsers = extractAuthorizedGitHubUsers(projectsRaw, admins);
    this.authorMap = extractAuthorMap(projectsRaw, authors);
    this.projectsMtime = pMtime;
    this.configMtime = cMtime;
  }

  formatAuthor(githubLogin: string): string {
    this.refreshMetadata();
    return this.authorMap.get(githubLogin.toLowerCase()) ?? githubLogin;
  }

  canRead(login: string | undefined): boolean {
    if (!login) return false;
    this.refreshMetadata();
    return this.authorizedUsers.has(login.toLowerCase());
  }

  canEdit(login: string | undefined): boolean {
    if (!login) return false;
    this.refreshMetadata();
    return this.authorizedUsers.has(login.toLowerCase());
  }

  getSessionUser(req: http.IncomingMessage): string | undefined {
    const oauth = this.getOAuthConfig();
    if (!oauth) return undefined;
    const cookies = parseCookies(req.headers.cookie);
    const verified = verifyToken<{login: string; exp: number}>(
      cookies[SESSION_COOKIE],
      oauth.sessionSecret
    );
    return verified?.login;
  }

  pagePath(slug: string): string {
    if (!isValidSlug(slug)) throw new Error(`Invalid slug: ${slug}`);
    return path.join(this.wikiDir, `${slug}.dj`);
  }

  readPage(slug: string): string | undefined {
    const file = this.pagePath(slug);
    if (!fs.existsSync(file)) return undefined;
    return fs.readFileSync(file, 'utf8');
  }

  pageTitle(slug: string): string {
    const raw = this.readPage(slug);
    if (raw) {
      const m = /^#\s+(.+)$/m.exec(raw);
      if (m) return m[1].trim();
    }
    return formatTitle(slug);
  }

  listPages(): string[] {
    if (!fs.existsSync(this.wikiDir)) return [];
    return fs.readdirSync(this.wikiDir)
      .filter(f => f.endsWith('.dj'))
      .map(f => f.slice(0, -3))
      .filter(isValidSlug)
      .sort((a, b) => a.localeCompare(b));
  }

  private enqueueGit<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.gitQueue.then(fn, fn);
    this.gitQueue = next.catch(() => undefined);
    return next;
  }

  async savePage(
    slug: string,
    rawContent: string,
    author: string,
    message?: string
  ): Promise<boolean> {
    if (!isValidSlug(slug)) throw new Error(`Invalid slug: ${slug}`);
    const normalized = rawContent.replace(/\r\n/g, '\n');
    const content = normalized.endsWith('\n') ? normalized : `${normalized}\n`;

    return this.enqueueGit(async () => {
      fs.mkdirSync(this.wikiDir, {recursive: true});
      const file = this.pagePath(slug);
      const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
      if (prev === content) return false;

      fs.writeFileSync(file, content, 'utf8');
      const rel = `${slug}.dj`;
      const summary = message?.trim() || (prev === undefined ? `Create ${slug}` : `Update ${slug}`);
      const safeAuthor = author.replace(/[<>"]/g, '').trim() || 'wiki';
      const gitAuthor = `${safeAuthor} <${safeAuthor}@users.noreply.github.com>`;

      await execFileAsync('git', ['add', '--', rel], {cwd: this.wikiDir});
      await execFileAsync(
        'git',
        [
          '-c', 'user.name=pkmn.ai',
          '-c', 'user.email=wiki@pkmn.ai',
          'commit',
          `--author=${gitAuthor}`,
          '-m', summary,
          '--', rel,
        ],
        {cwd: this.wikiDir}
      );

      if (this.shouldPush) {
        execFileAsync('git', ['push', 'origin', 'HEAD'], {cwd: this.wikiDir}).catch(err => {
          console.error('Error pushing wiki commit:', err);
        });
      }
      return true;
    });
  }

  async getHistory(slug: string): Promise<Revision[]> {
    if (!isValidSlug(slug)) return [];
    const file = this.pagePath(slug);
    if (!fs.existsSync(file)) return [];
    try {
      const {stdout} = await execFileAsync(
        'git',
        ['log', '--follow', '--format=%H%x09%h%x09%an%x09%at%x09%s', '--', `${slug}.dj`],
        {cwd: this.wikiDir}
      );
      return stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => {
          const [sha, shortSha, author, ts, ...rest] = line.split('\t');
          return {
            sha,
            shortSha,
            author,
            timestamp: Number(ts),
            subject: rest.join('\t'),
          };
        });
    } catch {
      return [];
    }
  }

  async getRevisionContent(slug: string, sha: string): Promise<string | undefined> {
    if (!isValidSlug(slug) || !SHA_RE.test(sha)) return undefined;
    try {
      const {stdout} = await execFileAsync(
        'git',
        ['show', `${sha}:${slug}.dj`],
        {cwd: this.wikiDir}
      );
      return stdout;
    } catch {
      return undefined;
    }
  }

  async getRevisionDiff(slug: string, sha: string): Promise<string | undefined> {
    if (!isValidSlug(slug) || !SHA_RE.test(sha)) return undefined;
    try {
      const {stdout} = await execFileAsync(
        'git',
        ['show', '--format=', sha, '--', `${slug}.dj`],
        {cwd: this.wikiDir}
      );
      return stdout;
    } catch {
      return undefined;
    }
  }
}

export function registerWiki(app: polka.Polka, options: WikiOptions = {}): WikiService {
  const wiki = new WikiService(options);
  const param = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
  const slugParam = (v: string | string[] | undefined) => normalizeSlug(param(v));

  const requireAuth = (
    req: http.IncomingMessage & {originalUrl?: string},
    res: http.ServerResponse,
    mode: 'read' | 'edit' = 'read'
  ): string | undefined => {
    const oauth = wiki.getOAuthConfig();
    if (!oauth) {
      if (process.env.NODE_ENV === 'development') {
        return process.env.WIKI_DEV_USER || 'scheibo';
      }
      sendHtml(res, 503, renderWikiPage({
        id: 'error',
        title: '503',
        heading: '503',
        path: '/wiki/',
        content: '<p>GitHub OAuth is not configured on this server.</p>',
      }));
      return undefined;
    }
    const login = wiki.getSessionUser(req);
    if (!login) {
      const returnTo = encodeURIComponent(req.originalUrl || req.url || '/wiki');
      redirect(res, `/auth/github?return_to=${returnTo}`);
      return undefined;
    }
    const allowed = mode === 'edit' ? wiki.canEdit(login) : wiki.canRead(login);
    if (!allowed) {
      const msg =
        `<p>GitHub account <code>${escapeHtml(login)}</code> ` +
        'is not registered for pkmn.ai competitions.</p>';
      sendHtml(res, 403, renderWikiPage({
        id: 'error',
        title: '403',
        heading: '403',
        path: '/wiki/',
        content: msg,
      }));
      return undefined;
    }
    return login;
  };

  app.get('/auth/github', (req, res) => {
    const oauth = wiki.getOAuthConfig();
    if (!oauth) {
      sendHtml(res, 503, '<p>GitHub OAuth is not configured.</p>');
      return;
    }
    const rawReturn = typeof req.query.return_to === 'string' ? req.query.return_to : '/wiki';
    const returnTo = rawReturn.startsWith('/') && !rawReturn.startsWith('//') ? rawReturn : '/wiki';
    const nonce = crypto.randomBytes(16).toString('hex');
    const exp = Math.floor(Date.now() / 1000) + STATE_TTL_S;
    const stateToken = signToken({nonce, returnTo, exp}, oauth.sessionSecret);
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    const cookie =
      `${STATE_COOKIE}=${encodeURIComponent(stateToken)}; ` +
      `HttpOnly; Path=/; Max-Age=${STATE_TTL_S}; SameSite=Lax${secure}`;

    const params = new URLSearchParams({
      client_id: oauth.clientId,
      scope: 'read:user',
      state: nonce,
    });
    if (oauth.callbackUrl) params.set('redirect_uri', oauth.callbackUrl);
    redirect(res, `https://github.com/login/oauth/authorize?${params.toString()}`, 302, [cookie]);
  });

  app.get('/auth/github/callback', async (req, res) => {
    const oauth = wiki.getOAuthConfig();
    if (!oauth) {
      sendHtml(res, 503, '<p>GitHub OAuth is not configured.</p>');
      return;
    }
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const cookies = parseCookies(req.headers.cookie);
    const saved = verifyToken<{nonce: string; returnTo: string; exp: number}>(
      cookies[STATE_COOKIE],
      oauth.sessionSecret
    );
    if (!code || !state || saved?.nonce !== state) {
      sendHtml(res, 400, renderWikiPage({
        id: 'error',
        title: '400',
        heading: '400',
        path: '/wiki/',
        content: '<p>Invalid or expired OAuth state.</p>',
      }));
      return;
    }

    try {
      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          client_id: oauth.clientId,
          client_secret: oauth.clientSecret,
          code,
        }),
      });
      if (!tokenRes.ok) throw new Error(`GitHub token exchange failed (${tokenRes.status})`);
      const tokenData = await tokenRes.json() as {access_token?: string};
      if (!tokenData.access_token) throw new Error('Missing access_token from GitHub');

      const userRes = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'pkmn.ai',
        },
      });
      if (!userRes.ok) throw new Error(`GitHub user fetch failed (${userRes.status})`);
      const userData = await userRes.json() as {login?: string};
      if (!userData.login) throw new Error('Missing login from GitHub user API');

      const login = userData.login;
      if (!wiki.canRead(login)) {
        const msg =
          `<p>GitHub account <code>${escapeHtml(login)}</code> ` +
          'is not registered for pkmn.ai competitions.</p>';
        sendHtml(res, 403, renderWikiPage({
          id: 'error',
          title: '403',
          heading: '403',
          path: '/wiki/',
          content: msg,
        }));
        return;
      }

      const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
      const sessionToken = signToken({login, exp}, oauth.sessionSecret);
      const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
      const setCookies = [
        `${SESSION_COOKIE}=${encodeURIComponent(sessionToken)}; ` +
          `HttpOnly; Path=/; Max-Age=${SESSION_TTL_S}; SameSite=Lax${secure}`,
        `${STATE_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secure}`,
      ];
      redirect(res, saved.returnTo || '/wiki', 302, setCookies);
    } catch (err) {
      console.error('GitHub OAuth error:', err);
      sendHtml(res, 502, renderWikiPage({
        id: 'error',
        title: '502',
        heading: '502',
        path: '/wiki/',
        content: '<p>Failed to authenticate with GitHub.</p>',
      }));
    }
  });

  const renderPageSlug = (
    req: http.IncomingMessage & {originalUrl?: string},
    res: http.ServerResponse,
    slug: string
  ) => {
    if (!requireAuth(req, res, 'read')) return;
    if (!isValidSlug(slug)) {
      sendHtml(res, 404, renderWikiPage({
        id: 'error',
        title: '404',
        heading: '404',
        path: '/wiki/',
        content: '<p>Invalid wiki page name.</p>',
      }));
      return;
    }
    const raw = wiki.readPage(slug);
    const encoded = encodeSlug(slug);
    if (raw === undefined) {
      redirect(res, `/wiki/${encoded}/edit`);
      return;
    }
    const meta: {title?: string; summary?: string} = {};
    const html = renderDjot(raw, meta);
    const heading = meta.title ?? formatTitle(slug);
    sendHtml(res, 200, renderWikiPage({
      title: heading,
      heading,
      path: slug === 'index' ? '/wiki/' : `/wiki/${encoded}/`,
      nav: wikiNav(slug, 'view'),
      content: html,
    }));
  };

  app.get('/wiki', (req, res) => renderPageSlug(req, res, 'index'));

  app.get('/wiki/pages', (req, res) => {
    if (!requireAuth(req, res, 'read')) return;
    const pages = wiki.listPages();
    const items = pages.map(p => {
      const href = p === 'index' ? '/wiki' : `/wiki/${encodeSlug(p)}`;
      const title = escapeHtml(wiki.pageTitle(p));
      return `<li><a href="${href}">${title}</a></li>`;
    }).join('');
    sendHtml(res, 200, renderWikiPage({
      title: 'Pages — Wiki',
      heading: 'Pages',
      path: '/wiki/pages/',
      nav: wikiNav('index', 'pages'),
      content: pages.length ? `<ul id="wiki-pages">${items}</ul>` : '<p>No pages yet.</p>',
    }));
  });

  app.get('/wiki/:page', (req, res) => renderPageSlug(req, res, slugParam(req.params.page)));

  const renderEditor = (
    res: http.ServerResponse,
    slug: string,
    content: string,
    message = '',
    previewHtml?: string
  ) => {
    const heading = `Edit ${formatTitle(slug)}`;
    const previewBlock = previewHtml !== undefined
      ? `<section id="wiki-preview">${previewHtml}</section>`
      : '';
    const encoded = encodeSlug(slug);
    const actionUrl = `/wiki/${escapeHtml(encoded)}`;
    const summaryInput =
      `<input type="text" name="message" value="${escapeHtml(message)}" ` +
      'placeholder="Commit summary (optional)" maxlength="120" />';
    const form = `${previewBlock}<form id="wiki-editor" method="post" action="${actionUrl}">
      <textarea name="content" spellcheck="true" autofocus>${escapeHtml(content)}</textarea>
      ${summaryInput}
      <div id="wiki-actions">
        <button type="submit" name="action" value="save">Save</button>
        —
        <button type="submit" name="action" value="preview">Preview</button>
      </div>
    </form>`;
    sendHtml(res, 200, renderWikiPage({
      title: heading,
      heading,
      path: `/wiki/${encoded}/edit/`,
      nav: wikiNav(slug, 'edit'),
      content: form,
    }));
  };

  app.get('/wiki/:page/edit', (req, res) => {
    if (!requireAuth(req, res, 'edit')) return;
    const slug = slugParam(req.params.page);
    if (!isValidSlug(slug)) {
      sendHtml(res, 404, renderWikiPage({
        id: 'error',
        title: '404',
        heading: '404',
        path: '/wiki/',
        content: '<p>Invalid wiki page name.</p>',
      }));
      return;
    }
    const existing = wiki.readPage(slug) ?? '';
    renderEditor(res, slug, existing);
  });

  app.post('/wiki/:page', async (req, res) => {
    const login = requireAuth(req, res, 'edit');
    if (!login) return;
    const slug = slugParam(req.params.page);
    if (!isValidSlug(slug)) {
      sendHtml(res, 404, renderWikiPage({
        id: 'error',
        title: '404',
        heading: '404',
        path: '/wiki/',
        content: '<p>Invalid wiki page name.</p>',
      }));
      return;
    }
    try {
      const body = await readBody(req);
      const parsed = querystring.parse(body);
      const content = typeof parsed.content === 'string' ? parsed.content : '';
      const message = typeof parsed.message === 'string' ? parsed.message : '';
      const action = typeof parsed.action === 'string' ? parsed.action : 'save';

      if (action === 'preview') {
        const previewHtml = renderDjot(content);
        renderEditor(res, slug, content, message, previewHtml);
        return;
      }

      await wiki.savePage(slug, content, login, message);
      redirect(res, slug === 'index' ? '/wiki' : `/wiki/${encodeSlug(slug)}`, 303);
    } catch (err: any) {
      const status = err?.status ?? 500;
      console.error('Error saving wiki page:', err);
      sendHtml(res, status, renderWikiPage({
        id: 'error',
        title: String(status),
        heading: String(status),
        path: `/wiki/${encodeSlug(slug)}/`,
        content: `<p>${escapeHtml(http.STATUS_CODES[status] ?? 'Internal Server Error')}</p>`,
      }));
    }
  });

  app.get('/wiki/:page/history', async (req, res) => {
    if (!requireAuth(req, res, 'read')) return;
    const slug = slugParam(req.params.page);
    if (!isValidSlug(slug)) {
      sendHtml(res, 404, renderWikiPage({
        id: 'error',
        title: '404',
        heading: '404',
        path: '/wiki/',
        content: '<p>Invalid wiki page name.</p>',
      }));
      return;
    }
    const encoded = encodeSlug(slug);
    const revisions = await wiki.getHistory(slug);
    const rows = revisions.map(rev => {
      const date = new Date(rev.timestamp * 1000).toISOString().slice(0, 10);
      const revUrl = `/wiki/${escapeHtml(encoded)}/${rev.sha}`;
      const revLink = `<code><a href="${revUrl}">${rev.shortSha}</a></code>`;
      const ghUrl = `https://github.com/${encodeURIComponent(rev.author)}`;
      const displayAuthor = escapeHtml(wiki.formatAuthor(rev.author));
      const authorLink = `<a href="${ghUrl}" class="subtle">${displayAuthor}</a>`;
      return `<tr>
        <td class="wiki-meta">${date}</td>
        <td>${revLink} (<a href="${revUrl}?diff=1">diff</a>)</td>
        <td>${authorLink}</td>
        <td>${escapeHtml(rev.subject)}</td>
      </tr>`;
    }).join('');
    const headerRow = '<tr><th>Date</th><th>Revision</th><th>Author</th><th>Summary</th></tr>';
    const table = revisions.length
      ? `<table>${headerRow}${rows}</table>`
      : '<p>No history for this page yet.</p>';
    const heading = `History — ${formatTitle(slug)}`;
    sendHtml(res, 200, renderWikiPage({
      title: heading,
      heading,
      path: `/wiki/${encoded}/history/`,
      nav: wikiNav(slug, 'history'),
      content: table,
    }));
  });

  app.get('/wiki/:page/:sha', async (req, res) => {
    if (!requireAuth(req, res, 'read')) return;
    const slug = slugParam(req.params.page);
    const sha = param(req.params.sha);
    if (!isValidSlug(slug) || !SHA_RE.test(sha)) {
      sendHtml(res, 404, renderWikiPage({
        id: 'error',
        title: '404',
        heading: '404',
        path: '/wiki/',
        content: '<p>Revision not found.</p>',
      }));
      return;
    }
    const encoded = encodeSlug(slug);
    const showDiff = req.query.diff === '1';
    if (showDiff) {
      const diff = await wiki.getRevisionDiff(slug, sha);
      if (diff === undefined) {
        sendHtml(res, 404, renderWikiPage({
          id: 'error',
          title: '404',
          heading: '404',
          path: '/wiki/',
          content: '<p>Revision not found.</p>',
        }));
        return;
      }
      const renderedDiff = renderDjot(`\`\`\`diff\n${diff}\n\`\`\``);
      const heading = `${formatTitle(slug)} @ ${sha.slice(0, 7)}`;
      const snapLink =
        `<p class="wiki-meta"><a href="/wiki/${escapeHtml(encoded)}/${sha}">View snapshot</a></p>`;
      sendHtml(res, 200, renderWikiPage({
        title: heading,
        heading,
        path: `/wiki/${encoded}/${sha}/`,
        nav: wikiNav(slug, 'history'),
        content: `${snapLink}${renderedDiff}`,
      }));
      return;
    }

    const raw = await wiki.getRevisionContent(slug, sha);
    if (raw === undefined) {
      sendHtml(res, 404, renderWikiPage({
        id: 'error',
        title: '404',
        heading: '404',
        path: '/wiki/',
        content: '<p>Revision not found.</p>',
      }));
      return;
    }
    const meta: {title?: string; summary?: string} = {};
    const html = renderDjot(raw, meta);
    const heading = `${meta.title ?? formatTitle(slug)} @ ${sha.slice(0, 7)}`;
    const diffLink =
      `<p class="wiki-meta"><a href="/wiki/${escapeHtml(encoded)}/${sha}?diff=1">View diff</a></p>`;
    sendHtml(res, 200, renderWikiPage({
      title: heading,
      heading,
      path: `/wiki/${encoded}/${sha}/`,
      nav: wikiNav(slug, 'history'),
      content: `${diffLink}${html}`,
    }));
  });

  return wiki;
}
