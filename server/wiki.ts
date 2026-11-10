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

import {header, renderer, slugify} from '../static/build';
import type {Project} from '../static/projects';

const execFileAsync = promisify(execFile);

const ROOT = path.basename(path.dirname(__dirname)) === 'build'
  ? path.join(__dirname, '..', '..')
  : path.join(__dirname, '..');
const WIKI_DIR = path.join(ROOT, 'wiki');
const PROJECTS = path.join(ROOT, 'static', 'projects.yml');
const CONFIG = path.join(ROOT, 'config', 'wiki.yml');
const OAUTH = path.join(ROOT, 'private', 'github.yml');
const VOUCH_VALIDATE_URL = 'http://127.0.0.1:9091/vouch/validate';

const SESSION_COOKIE = 'pkmn_wiki_session';
const STATE_COOKIE = 'pkmn_wiki_state';
const SESSION_TTL_S = 30 * 24 * 60 * 60;
const STATE_TTL_S = 10 * 60;
const MAX_BODY_BYTES = 256 * 1024;

const SHA_RE = /^[0-9a-f]{7,40}$/;
const RESERVED_SLUGS = new Set(['pages', 'edit', 'history']);

export type PageVisibility = 'developers' | 'discord' | 'public';
const VISIBILITIES = new Set<PageVisibility>(['developers', 'discord', 'public']);
const VISIBILITY = /^\{%\s*visibility:\s*(developers|discord|public)\s*%\}\r?\n?/;

export interface BotPage {
  slug: string;
  name: string;
  owners: Set<string>;
}

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  sessionSecret: string;
  callbackUrl?: string;
  admins?: string[];
  authors?: {[github: string]: string};
}

export interface Config {
  admins?: string[];
  authors?: {[github: string]: string};
}

export interface Options {
  wikiDir?: string;
  projectsFile?: string;
  configFile?: string;
  oauthFile?: string;
  oauth?: OAuthConfig;
  vouchValidateUrl?: string;
  push?: boolean;
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

export function parsePageContent(raw: string): {content: string; visibility?: PageVisibility} {
  const m = VISIBILITY.exec(raw);
  if (!m) return {content: raw};
  return {
    visibility: m[1] as PageVisibility,
    content: raw.slice(m[0].length),
  };
}

export function serializePageContent(rawContent: string, visibility?: PageVisibility): string {
  const stripped = parsePageContent(rawContent.replace(/\r\n/g, '\n')).content;
  const body = stripped.endsWith('\n') ? stripped : `${stripped}\n`;
  return visibility ? `{% visibility: ${visibility} %}\n${body}` : body;
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
  const entries = (yaml.parse(projectsYaml) ?? []) as Project[];
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

export function extractBotPages(projectsYaml: string): {
  bots: Map<string, BotPage>;
  aliases: Map<string, string>;
} {
  const bots = new Map<string, BotPage>();
  const aliases = new Map<string, string>();
  const entries = (yaml.parse(projectsYaml) ?? []) as Project[];
  if (!Array.isArray(entries)) return {bots, aliases};
  for (const entry of entries) {
    const name = entry?.name?.trim();
    if (!name || !entry.arena) continue;
    const slug = normalizeSlug(name);
    if (!isValidSlug(slug)) continue;
    const owners = new Set<string>();
    const gh = entry.arena.github;
    const list = Array.isArray(gh) ? gh : gh ? [gh] : [];
    for (const u of list) {
      if (typeof u === 'string' && u.trim()) {
        owners.add(u.trim().toLowerCase());
      }
    }
    bots.set(slug, {slug, name, owners});
    aliases.set(slug.toLowerCase(), slug);
    const arenaSlug = slugify(name).toLowerCase();
    if (arenaSlug) {
      aliases.set(arenaSlug, slug);
      aliases.set(normalizeSlug(arenaSlug).toLowerCase(), slug);
    }
  }
  return {bots, aliases};
}

export function loadOAuthConfig(file = OAUTH): OAuthConfig | undefined {
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

const STYLE = fs.readFileSync(path.join(ROOT, 'static', 'wiki.css'), 'utf8');

function renderPage(opts: {
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
    style: STYLE,
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
  const {content} = parsePageContent(raw);
  return site.html.render(content, {
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

function sendError(res: http.ServerResponse, status: number, content: string, pagePath = '/wiki/') {
  sendHtml(res, status, renderPage({
    id: 'error',
    title: String(status),
    heading: String(status),
    path: pagePath,
    content,
  }));
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

function hasVouchToken(headers: http.IncomingHttpHeaders): boolean {
  const auth = headers.authorization;
  if (typeof auth === 'string' && /^Bearer\s+\S+/i.test(auth.trim())) return true;
  const vouchToken = headers['x-vouch-token'];
  if (typeof vouchToken === 'string' && vouchToken.trim()) return true;
  return Boolean(parseCookies(headers.cookie).VouchCookie);
}

export class Wiki {
  readonly wikiDir: string;
  readonly projectsFile: string;
  readonly configFile: string;
  readonly oauthFile: string;
  readonly vouchValidateUrl: string;
  private readonly explicitOAuth?: OAuthConfig;
  private readonly shouldPush: boolean;
  private projectsMtime = -1;
  private configMtime = -1;
  private adminUsers = new Set<string>();
  private authorizedUsers = new Set<string>();
  private authorMap = new Map<string, string>();
  private botPages = new Map<string, BotPage>();
  private botAliases = new Map<string, string>();
  private gitQueue: Promise<any> = Promise.resolve();

  constructor(options: Options = {}) {
    this.wikiDir = options.wikiDir ?? WIKI_DIR;
    this.projectsFile = options.projectsFile ?? PROJECTS;
    this.configFile = options.configFile ?? CONFIG;
    this.oauthFile = options.oauthFile ?? OAUTH;
    this.vouchValidateUrl = options.vouchValidateUrl ?? VOUCH_VALIDATE_URL;
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

    let wikiCfg: Config = {};
    if (cMtime !== -1) {
      try {
        wikiCfg = (yaml.parse(fs.readFileSync(this.configFile, 'utf8')) ?? {}) as Config;
      } catch {}
    }

    const oauth = this.getOAuthConfig();
    const admins = [...(wikiCfg.admins ?? []), ...(oauth?.admins ?? [])];
    const authors = {...(wikiCfg.authors ?? {}), ...(oauth?.authors ?? {})};

    this.adminUsers = new Set(admins.map(a => a.trim().toLowerCase()).filter(Boolean));
    this.authorizedUsers = extractAuthorizedGitHubUsers(projectsRaw, admins);
    this.authorMap = new Map(
      Object.entries(authors)
        .filter(([gh, name]) => gh.trim() && typeof name === 'string' && name.trim())
        .map(([gh, name]) => [gh.trim().toLowerCase(), name.trim()])
    );
    const {bots, aliases} = extractBotPages(projectsRaw);
    this.botPages = bots;
    this.botAliases = aliases;
    this.projectsMtime = pMtime;
    this.configMtime = cMtime;
  }

  formatAuthor(githubLogin: string): string {
    this.refreshMetadata();
    return this.authorMap.get(githubLogin.toLowerCase()) ?? githubLogin;
  }

  resolveSlug(slug: string): string {
    this.refreshMetadata();
    return this.botAliases.get(slug.toLowerCase()) ?? slug;
  }

  getBotPage(slug: string): BotPage | undefined {
    this.refreshMetadata();
    return this.botPages.get(this.resolveSlug(slug));
  }

  isBotPage(slug: string): boolean {
    return this.getBotPage(slug) !== undefined;
  }

  isAdmin(login: string | undefined): boolean {
    if (!login) return false;
    this.refreshMetadata();
    return this.adminUsers.has(login.toLowerCase());
  }

  isDeveloper(login: string | undefined): boolean {
    if (!login) return false;
    this.refreshMetadata();
    return this.authorizedUsers.has(login.toLowerCase());
  }

  getPageVisibility(slug: string): PageVisibility {
    const canonical = this.resolveSlug(slug);
    if (!this.isBotPage(canonical)) return 'public';
    const raw = this.readRawPage(canonical);
    if (raw === undefined) return 'developers';
    return parsePageContent(raw).visibility ?? 'developers';
  }

  canRead(login: string | undefined, slug = 'index', isDiscordMember = false): boolean {
    const visibility = this.getPageVisibility(slug);
    if (visibility === 'public') return true;
    if (this.isDeveloper(login)) return true;
    if (visibility === 'discord') return isDiscordMember;
    return false;
  }

  canEdit(login: string | undefined, slug?: string): boolean {
    if (!login) return false;
    this.refreshMetadata();
    const lower = login.toLowerCase();
    if (this.adminUsers.has(lower)) return true;
    if (!slug) return this.authorizedUsers.has(lower);
    const bot = this.getBotPage(slug);
    if (bot) return bot.owners.has(lower);
    return this.authorizedUsers.has(lower);
  }

  async verifyDiscordAuth(
    req: http.IncomingMessage
  ): Promise<'authorized' | 'unauthenticated' | 'forbidden'> {
    if (!hasVouchToken(req.headers)) return 'unauthenticated';
    const forwarded: Record<string, string> = {};
    for (const key of ['cookie', 'authorization', 'x-vouch-token', 'host']) {
      const val = req.headers[key];
      if (typeof val === 'string') forwarded[key] = val;
    }
    try {
      const res = await fetch(this.vouchValidateUrl, {headers: forwarded});
      if (res.status === 200) return 'authorized';
      if (res.status === 403) return 'forbidden';
      return 'unauthenticated';
    } catch {
      return 'unauthenticated';
    }
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
    const canonical = this.resolveSlug(slug);
    if (!isValidSlug(canonical)) throw new Error(`Invalid slug: ${slug}`);
    return path.join(this.wikiDir, `${canonical}.dj`);
  }

  readRawPage(slug: string): string | undefined {
    const file = this.pagePath(slug);
    if (!fs.existsSync(file)) return undefined;
    return fs.readFileSync(file, 'utf8');
  }

  readPage(slug: string): string | undefined {
    const raw = this.readRawPage(slug);
    return raw !== undefined ? parsePageContent(raw).content : undefined;
  }

  pageTitle(slug: string): string {
    const canonical = this.resolveSlug(slug);
    const body = this.readPage(canonical);
    if (body) {
      const m = /^#\s+(.+)$/m.exec(body);
      if (m) return m[1].trim();
    }
    return this.getBotPage(canonical)?.name ?? formatTitle(canonical);
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
    message?: string,
    visibility?: PageVisibility
  ): Promise<boolean> {
    const canonical = this.resolveSlug(slug);
    if (!isValidSlug(canonical)) throw new Error(`Invalid slug: ${slug}`);
    const isBot = this.isBotPage(canonical);
    const vis = isBot
      ? (visibility && VISIBILITIES.has(visibility)
        ? visibility
        : this.getPageVisibility(canonical))
      : undefined;
    const content = serializePageContent(rawContent, vis);

    return this.enqueueGit(async () => {
      fs.mkdirSync(this.wikiDir, {recursive: true});
      const file = this.pagePath(canonical);
      const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
      if (prev === content) return false;

      fs.writeFileSync(file, content, 'utf8');
      const rel = `${canonical}.dj`;
      const defaultMsg = prev === undefined ? `Create ${canonical}` : `Update ${canonical}`;
      const summary = message?.trim() || defaultMsg;
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
    const canonical = this.resolveSlug(slug);
    if (!isValidSlug(canonical)) return [];
    const file = this.pagePath(canonical);
    if (!fs.existsSync(file)) return [];
    try {
      const {stdout} = await execFileAsync(
        'git',
        ['log', '--follow', '--format=%H%x09%h%x09%an%x09%at%x09%s', '--', `${canonical}.dj`],
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
    const canonical = this.resolveSlug(slug);
    if (!isValidSlug(canonical) || !SHA_RE.test(sha)) return undefined;
    try {
      const {stdout} = await execFileAsync(
        'git',
        ['show', `${sha}:${canonical}.dj`],
        {cwd: this.wikiDir}
      );
      return parsePageContent(stdout).content;
    } catch {
      return undefined;
    }
  }

  async getRevisionDiff(slug: string, sha: string): Promise<string | undefined> {
    const canonical = this.resolveSlug(slug);
    if (!isValidSlug(canonical) || !SHA_RE.test(sha)) return undefined;
    try {
      const {stdout} = await execFileAsync(
        'git',
        ['show', '--format=', sha, '--', `${canonical}.dj`],
        {cwd: this.wikiDir}
      );
      return stdout;
    } catch {
      return undefined;
    }
  }
}

export function register(app: polka.Polka, options: Options = {}): Wiki {
  const wiki = new Wiki(options);
  const param = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
  const slugParam = (v: string | string[] | undefined) => normalizeSlug(param(v));

  const getEffectiveUser = (req: http.IncomingMessage): string | undefined => {
    const oauth = wiki.getOAuthConfig();
    if (!oauth) {
      return process.env.NODE_ENV === 'development'
        ? process.env.WIKI_DEV_USER || 'scheibo'
        : undefined;
    }
    return wiki.getSessionUser(req);
  };

  const resolveOrRedirect = (
    res: http.ServerResponse,
    rawSlug: string,
    suffix = ''
  ): string | undefined => {
    if (!isValidSlug(rawSlug)) {
      sendError(res, 404, '<p>Invalid wiki page name.</p>');
      return undefined;
    }
    const canonical = wiki.resolveSlug(rawSlug);
    if (canonical !== rawSlug) {
      redirect(res, `/wiki/${encodeSlug(canonical)}${suffix}`);
      return undefined;
    }
    return canonical;
  };

  const requireReadAuth = async (
    req: http.IncomingMessage & {originalUrl?: string},
    res: http.ServerResponse,
    slug = 'index'
  ): Promise<boolean> => {
    const visibility = wiki.getPageVisibility(slug);
    if (visibility === 'public') return true;

    const oauth = wiki.getOAuthConfig();
    if (!oauth && process.env.NODE_ENV === 'development') return true;

    const login = wiki.getSessionUser(req);
    if (wiki.isDeveloper(login)) return true;

    if (visibility === 'discord') {
      const status = await wiki.verifyDiscordAuth(req);
      if (status === 'authorized') return true;
      if (status === 'forbidden') {
        sendError(
          res,
          403,
          '<p>Your Discord account is not a member of the pkmn.ai Discord server.</p>'
        );
        return false;
      }
      const returnTo = encodeURIComponent(req.originalUrl || req.url || '/wiki');
      redirect(res, `/vouch/login?url=${returnTo}`);
      return false;
    }

    if (!oauth) {
      sendError(res, 503, '<p>GitHub OAuth is not configured on this server.</p>');
      return false;
    }
    if (!login) {
      const returnTo = encodeURIComponent(req.originalUrl || req.url || '/wiki');
      redirect(res, `/auth/github?return_to=${returnTo}`);
      return false;
    }
    sendError(
      res,
      403,
      `<p>GitHub account <code>${escapeHtml(login)}</code> ` +
        'is not registered for pkmn.ai competitions.</p>'
    );
    return false;
  };

  const requireEditAuth = (
    req: http.IncomingMessage & {originalUrl?: string},
    res: http.ServerResponse,
    slug?: string
  ): string | undefined => {
    const oauth = wiki.getOAuthConfig();
    let login: string | undefined;
    if (!oauth) {
      if (process.env.NODE_ENV === 'development') {
        login = process.env.WIKI_DEV_USER || 'scheibo';
      } else {
        sendError(res, 503, '<p>GitHub OAuth is not configured on this server.</p>');
        return undefined;
      }
    } else {
      login = wiki.getSessionUser(req);
      if (!login) {
        const returnTo = encodeURIComponent(req.originalUrl || req.url || '/wiki');
        redirect(res, `/auth/github?return_to=${returnTo}`);
        return undefined;
      }
    }

    if (!wiki.isDeveloper(login)) {
      sendError(
        res,
        403,
        `<p>GitHub account <code>${escapeHtml(login)}</code> ` +
          'is not registered for pkmn.ai competitions.</p>'
      );
      return undefined;
    }

    if (slug && !wiki.canEdit(login, slug)) {
      const bot = wiki.getBotPage(slug);
      const target = escapeHtml(bot ? bot.name : formatTitle(slug));
      sendError(
        res,
        403,
        `<p>GitHub account <code>${escapeHtml(login)}</code> ` +
          `is not a registered developer of <strong>${target}</strong>.</p>`
      );
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
      sendError(res, 400, '<p>Invalid or expired OAuth state.</p>');
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
      if (!wiki.isDeveloper(login)) {
        sendError(
          res,
          403,
          `<p>GitHub account <code>${escapeHtml(login)}</code> ` +
            'is not registered for pkmn.ai competitions.</p>'
        );
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
      sendError(res, 502, '<p>Failed to authenticate with GitHub.</p>');
    }
  });

  const renderPageSlug = async (
    req: http.IncomingMessage & {originalUrl?: string},
    res: http.ServerResponse,
    rawSlug: string
  ) => {
    const slug = resolveOrRedirect(res, rawSlug);
    if (!slug) return;
    if (!(await requireReadAuth(req, res, slug))) return;

    const raw = wiki.readPage(slug);
    const encoded = encodeSlug(slug);
    if (raw === undefined) {
      if (wiki.isBotPage(slug) && !wiki.canEdit(getEffectiveUser(req), slug)) {
        sendError(res, 404, '<p>This bot page has not been created yet.</p>', `/wiki/${encoded}/`);
        return;
      }
      redirect(res, `/wiki/${encoded}/edit`);
      return;
    }
    const meta: {title?: string; summary?: string} = {};
    const html = renderDjot(raw, meta);
    const heading = meta.title ?? wiki.getBotPage(slug)?.name ?? formatTitle(slug);
    sendHtml(res, 200, renderPage({
      title: heading,
      heading,
      path: slug === 'index' ? '/wiki/' : `/wiki/${encoded}/`,
      nav: wikiNav(slug, 'view'),
      content: html,
    }));
  };

  app.get('/wiki', (req, res) => renderPageSlug(req, res, 'index'));

  app.get('/wiki/pages', async (req, res) => {
    const allPages = wiki.listPages();
    const login = getEffectiveUser(req);
    const needsDiscordCheck = !wiki.isDeveloper(login) &&
      allPages.some(p => wiki.getPageVisibility(p) === 'discord');
    const isDiscord = needsDiscordCheck && (await wiki.verifyDiscordAuth(req)) === 'authorized';
    const pages = allPages.filter(p => wiki.canRead(login, p, isDiscord));

    const items = pages.map(p => {
      const href = p === 'index' ? '/wiki' : `/wiki/${encodeSlug(p)}`;
      const title = escapeHtml(wiki.pageTitle(p));
      return `<li><a href="${href}">${title}</a></li>`;
    }).join('');
    sendHtml(res, 200, renderPage({
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
    visibility?: PageVisibility,
    previewHtml?: string
  ) => {
    const displayTitle = wiki.getBotPage(slug)?.name ?? formatTitle(slug);
    const heading = `Edit ${displayTitle}`;
    const previewBlock = previewHtml !== undefined
      ? `<section id="wiki-preview">${previewHtml}</section>`
      : '';
    const encoded = encodeSlug(slug);
    const actionUrl = `/wiki/${escapeHtml(encoded)}`;
    const summaryInput =
      `<input type="text" name="message" value="${escapeHtml(message)}" ` +
      'placeholder="Commit summary (optional)" maxlength="120" />';
    const radioItem = (val: PageVisibility, label: string) => {
      const checked = visibility === val ? ' checked="checked"' : '';
      return `<li><input type="radio" name="visibility" value="${val}" id="vis-${val}"${checked}>` +
        `<label for="vis-${val}">${label}</label></li>`;
    };
    const visibilityNav = visibility
      ? `<nav id="wiki-visibility"><ul>${radioItem('developers', 'Developers')} — ` +
        `${radioItem('discord', 'Discord')} — ${radioItem('public', 'Public')}</ul></nav>`
      : '';
    const form = `${previewBlock}<form id="wiki-editor" method="post" action="${actionUrl}">
      <textarea name="content" spellcheck="true" autofocus>${escapeHtml(content)}</textarea>
      ${summaryInput}
      ${visibilityNav}
      <div id="wiki-actions">
        <button type="submit" name="action" value="save">Save</button>
        —
        <button type="submit" name="action" value="preview">Preview</button>
      </div>
    </form>`;
    sendHtml(res, 200, renderPage({
      title: heading,
      heading,
      path: `/wiki/${encoded}/edit/`,
      nav: wikiNav(slug, 'edit'),
      content: form,
    }));
  };

  app.get('/wiki/:page/edit', (req, res) => {
    const slug = resolveOrRedirect(res, slugParam(req.params.page), '/edit');
    if (!slug) return;
    if (!requireEditAuth(req, res, slug)) return;
    const existing = wiki.readPage(slug) ?? '';
    const visibility = wiki.isBotPage(slug) ? wiki.getPageVisibility(slug) : undefined;
    renderEditor(res, slug, existing, '', visibility);
  });

  app.post('/wiki/:page', async (req, res) => {
    const rawSlug = slugParam(req.params.page);
    if (!isValidSlug(rawSlug)) {
      sendError(res, 404, '<p>Invalid wiki page name.</p>');
      return;
    }
    const slug = wiki.resolveSlug(rawSlug);
    const login = requireEditAuth(req, res, slug);
    if (!login) return;
    try {
      const body = await readBody(req);
      const parsed = querystring.parse(body);
      const content = typeof parsed.content === 'string' ? parsed.content : '';
      const message = typeof parsed.message === 'string' ? parsed.message : '';
      const action = typeof parsed.action === 'string' ? parsed.action : 'save';
      const rawVis = typeof parsed.visibility === 'string' ? parsed.visibility : '';
      const visibility = wiki.isBotPage(slug)
        ? (VISIBILITIES.has(rawVis as PageVisibility)
          ? (rawVis as PageVisibility)
          : wiki.getPageVisibility(slug))
        : undefined;

      if (action === 'preview') {
        const previewHtml = renderDjot(content, {});
        renderEditor(res, slug, content, message, visibility, previewHtml);
        return;
      }

      await wiki.savePage(slug, content, login, message, visibility);
      redirect(res, slug === 'index' ? '/wiki' : `/wiki/${encodeSlug(slug)}`, 303);
    } catch (err: any) {
      const status = err?.status ?? 500;
      console.error('Error saving wiki page:', err);
      sendError(
        res,
        status,
        `<p>${escapeHtml(http.STATUS_CODES[status] ?? 'Internal Server Error')}</p>`,
        `/wiki/${encodeSlug(slug)}/`
      );
    }
  });

  app.get('/wiki/:page/history', async (req, res) => {
    const slug = resolveOrRedirect(res, slugParam(req.params.page), '/history');
    if (!slug) return;
    if (!(await requireReadAuth(req, res, slug))) return;
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
    const displayTitle = wiki.getBotPage(slug)?.name ?? formatTitle(slug);
    const heading = `History — ${displayTitle}`;
    sendHtml(res, 200, renderPage({
      title: heading,
      heading,
      path: `/wiki/${encoded}/history/`,
      nav: wikiNav(slug, 'history'),
      content: table,
    }));
  });

  app.get('/wiki/:page/:sha', async (req, res) => {
    const rawSlug = slugParam(req.params.page);
    const sha = param(req.params.sha);
    if (!isValidSlug(rawSlug) || !SHA_RE.test(sha)) {
      sendError(res, 404, '<p>Revision not found.</p>');
      return;
    }
    const showDiff = req.query.diff === '1';
    const slug = resolveOrRedirect(res, rawSlug, `/${sha}${showDiff ? '?diff=1' : ''}`);
    if (!slug) return;
    if (!(await requireReadAuth(req, res, slug))) return;

    const encoded = encodeSlug(slug);
    const displayTitle = wiki.getBotPage(slug)?.name ?? formatTitle(slug);
    if (showDiff) {
      const diff = await wiki.getRevisionDiff(slug, sha);
      if (diff === undefined) {
        sendError(res, 404, '<p>Revision not found.</p>');
        return;
      }
      const renderedDiff = renderDjot(`\`\`\`diff\n${diff}\n\`\`\``);
      const heading = `${displayTitle} @ ${sha.slice(0, 7)}`;
      const snapLink =
        `<p class="wiki-meta"><a href="/wiki/${escapeHtml(encoded)}/${sha}">View snapshot</a></p>`;
      sendHtml(res, 200, renderPage({
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
      sendError(res, 404, '<p>Revision not found.</p>');
      return;
    }
    const meta: {title?: string; summary?: string} = {};
    const html = renderDjot(raw, meta);
    const heading = `${meta.title ?? displayTitle} @ ${sha.slice(0, 7)}`;
    const diffLink =
      `<p class="wiki-meta"><a href="/wiki/${escapeHtml(encoded)}/${sha}?diff=1">View diff</a></p>`;
    sendHtml(res, 200, renderPage({
      title: heading,
      heading,
      path: `/wiki/${encoded}/${sha}/`,
      nav: wikiNav(slug, 'history'),
      content: `${diffLink}${html}`,
    }));
  });

  return wiki;
}
