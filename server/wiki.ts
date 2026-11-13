import {execFile} from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as querystring from 'querystring';
import {promisify} from 'util';

import polka from 'polka';
import * as site from 'site';
import * as yaml from 'yaml';

import * as db from '../db';
import {header, injectLiveBanner, renderer} from '../static/build';
import {Project} from '../static/projects';
import {escapeHtml, root, slugify, toID} from '../static/util';

import * as auth from './auth';

const execFileAsync = promisify(execFile);

const WIKI_DIR = process.env.MOCK === '1' ? root('.mock', 'wiki') : root('wiki');
const PROJECTS = process.env.MOCK === '1'
  ? root('.mock', 'static', 'projects.yml')
  : root('static', 'projects.yml');
const MAX_BODY_BYTES = 256 * 1024;

// Hardcoded site-wide wiki administrators and GitHub -> display-name overrides (replaces the
// two-line `config/wiki.yml`). Admins can edit any project wiki page regardless of project
// ownership; `AUTHORS` maps GitHub commit authors to their Smogon handle in revision history.
export const ADMINS = ['scheibo'];
export const AUTHORS: Record<string, string> = {scheibo: 'pre'};

const SHA_RE = /^[0-9a-f]{7,40}$/;
const RESERVED_SLUGS = new Set(['pages', 'edit', 'history']);

// Three-tier read visibility for registered project wiki pages (`{% visibility: ... %}` header):
//   - `developers` (default for project pages): readable only by registered Arena developers
//   - `discord`: readable by developers and verified pkmn.ai Discord guild members
//   - `public` (always used for general non-project pages): readable by everyone
export type PageVisibility = 'developers' | 'discord' | 'public';
const VISIBILITIES = new Set<PageVisibility>(['developers', 'discord', 'public']);
const VISIBILITY = /^\{%\s*visibility:\s*(developers|discord|public)\s*%\}\r?\n?/;

export interface ProjectPage {
  slug: string;
  name: string;
  owners: Set<string>;
}

export interface Options {
  wikiDir?: string;
  projectsFile?: string;
  admins?: string[];
  authors?: Record<string, string>;
  auth?: auth.Auth;
  authConfig?: auth.Config;
  db?: db.Database;
  isDiscordMember?: (discordId: string) => boolean;
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
    return decodeURIComponent(raw).normalize('NFC').trim().replace(/[\s_]+/g, '_');
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

// All registered `arena.owners` in `static/projects.yml` are intentionally granted wiki access
// regardless of whether `arena.qualified` is true (`qualified` only gates ladder competition).
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
    const owners = entry?.arena?.owners;
    if (!owners || typeof owners !== 'object') continue;
    for (const u of Object.keys(owners)) {
      const clean = u.trim().toLowerCase();
      if (clean) users.add(clean);
    }
  }
  return users;
}

export function extractProjectPages(projectsYaml: string): {
  projects: Map<string, ProjectPage>;
  aliases: Map<string, string>;
} {
  const projects = new Map<string, ProjectPage>();
  const aliases = new Map<string, string>();
  const entries = (yaml.parse(projectsYaml) ?? []) as Project[];
  if (!Array.isArray(entries)) return {projects, aliases};
  for (const entry of entries) {
    const name = entry?.name?.trim();
    if (!name || !entry.arena) continue;
    const slug = normalizeSlug(name);
    if (!isValidSlug(slug)) continue;
    const owners = new Set<string>();
    if (entry.arena.owners && typeof entry.arena.owners === 'object') {
      for (const u of Object.keys(entry.arena.owners)) {
        const clean = u.trim().toLowerCase();
        if (clean) owners.add(clean);
      }
    }
    projects.set(slug, {slug, name, owners});
    aliases.set(slug.toLowerCase(), slug);
    const arenaSlug = slugify(name).toLowerCase();
    if (arenaSlug) {
      aliases.set(arenaSlug, slug);
      aliases.set(normalizeSlug(arenaSlug).toLowerCase(), slug);
    }
    const idAlias = toID(name);
    if (idAlias && !RESERVED_SLUGS.has(idAlias) && !aliases.has(idAlias)) {
      aliases.set(idAlias, slug);
    }
  }
  return {projects, aliases};
}

const STYLE = fs.readFileSync(root('static', 'wiki.css'), 'utf8');

function renderPageHtml(opts: {
  id?: string;
  title: string;
  heading: string;
  path: string;
  nav?: string;
  content: string;
  liveTournament?: {id: string; name: string};
}) {
  return renderer.render({
    id: opts.id ?? 'wiki',
    title: `${opts.title} | pkmn.ai`,
    header: injectLiveBanner(header(opts.heading), opts.liveTournament),
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

const UNSAFE_URI_SCHEME = /^(?:javascript|vbscript|data):/i;
const DANGEROUS_ATTR_NAMES = new Set([
  'srcdoc',
  'formaction',
  'style',
  'ping',
  'background',
  'dynsrc',
  'lowsrc',
]);

function decodeHtmlEntities(raw: string): string {
  return raw
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '';
    })
    .replace(/&#([0-9]+);?/g, (_, dec) => {
      const code = parseInt(dec, 10);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '';
    })
    .replace(/&colon;/gi, ':')
    .replace(/&tab;/gi, '\t')
    .replace(/&newline;/gi, '\n');
}

function isSafeWikiUri(raw: string | undefined): boolean {
  if (!raw) return true;
  // eslint-disable-next-line no-control-regex
  const normalized = decodeHtmlEntities(raw).replace(/[\x00-\x20]+/g, '');
  return !UNSAFE_URI_SCHEME.test(normalized);
}

export function sanitizeWikiHtml(html: string): string {
  const withoutBlocks = html
    .replace(
      /<(script|iframe|object|embed|style|svg|form|applet|template)\b[^>]*>[\s\S]*?<\/\1>/gi,
      ''
    )
    .replace(
      // eslint-disable-next-line max-len
      /<\/?(?:script|iframe|object|embed|style|svg|form|applet|template|base|meta|link|input|button|textarea|select)\b(?:\s+(?:[^>"']|"[^"]*"|'[^']*'))*\s*\/?>/gi,
      ''
    );

  return withoutBlocks.replace(
    /<([a-zA-Z][a-zA-Z0-9:-]*)(\s(?:[^>"']|"[^"]*"|'[^']*')*)?>/g,
    (full, tag: string, attrs: string | undefined) => {
      if (!attrs) return full;
      const selfClose = attrs.trimEnd().endsWith('/') ? '/' : '';
      const attrBody = selfClose ? attrs.replace(/\/\s*$/, '') : attrs;
      const cleaned = attrBody.replace(
        /\s+([a-zA-Z_:][a-zA-Z0-9_.:-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g,
        (_attrMatch, name: string, dq?: string, sq?: string, uq?: string) => {
          const lower = name.toLowerCase();
          if (lower.startsWith('on') || DANGEROUS_ATTR_NAMES.has(lower)) return '';
          const rawVal = dq ?? sq ?? uq;
          if (rawVal === undefined) return ` ${name}`;
          if (lower === 'href' || lower === 'src' || lower === 'xlink:href' || lower === 'action') {
            if (!isSafeWikiUri(rawVal)) return ` ${name}="#"`;
          }
          const safeVal = rawVal
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
          return ` ${name}="${safeVal}"`;
        }
      );
      return `<${tag}${cleaned}${selfClose}>`;
    }
  );
}

export function renderDjot(raw: string, save?: {title?: string; summary?: string}): string {
  const {content} = parsePageContent(raw);
  const rendered = site.html.render(content, {
    save,
    overrides: {
      raw_block: () => '',
      raw_inline: () => '',
      image: (node, r) => {
        if (!isSafeWikiUri(node.destination)) node.destination = '';
        return r.renderAstNodeDefault(node);
      },
      link: (node, r) => {
        const dest = node.destination;
        if (!isSafeWikiUri(dest)) {
          node.destination = '#';
        } else if (
          dest &&
          !dest.startsWith('/') &&
          !dest.startsWith('#') &&
          !/^[a-zA-Z]+:/.test(dest)
        ) {
          const [p, hash] = dest.split('#');
          const clean = normalizeSlug(p.replace(/\.dj$/, ''));
          node.destination = `/wiki/${encodeSlug(clean)}${hash ? `#${hash}` : ''}`;
        }
        return r.renderAstNodeDefault(node);
      },
    },
  });
  return sanitizeWikiHtml(rendered);
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

function sendErrorHtml(
  res: http.ServerResponse,
  status: number,
  content: string,
  pagePath = '/wiki/',
  liveTournament?: {id: string; name: string}
) {
  sendHtml(res, status, renderPageHtml({
    id: 'error',
    title: String(status),
    heading: String(status),
    path: pagePath,
    content,
    liveTournament,
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

export class Wiki {
  readonly wikiDir: string;
  readonly projectsFile: string;
  readonly auth: auth.Auth;
  private readonly configuredAdmins: string[];
  private readonly configuredAuthors: Record<string, string>;
  private readonly shouldPush: boolean;
  private projectsMtime = -1;
  private adminUsers = new Set<string>();
  private authorizedUsers = new Set<string>();
  private authorMap = new Map<string, string>();
  private projectPages = new Map<string, ProjectPage>();
  private projectAliases = new Map<string, string>();
  // Serializes git `add`/`commit` operations in-process so concurrent edits cannot collide on
  // `.git/index.lock` inside the backing wiki repository.
  private gitQueue: Promise<any> = Promise.resolve();

  constructor(options: Options = {}) {
    this.wikiDir = options.wikiDir ?? WIKI_DIR;
    this.projectsFile = options.projectsFile ?? PROJECTS;
    this.configuredAdmins = options.admins ?? ADMINS;
    this.configuredAuthors = options.authors ?? AUTHORS;
    this.auth = options.auth ?? new auth.Auth({
      config: options.authConfig,
      db: options.db,
      isDiscordMember: options.isDiscordMember,
      isAuthorizedGitHub: login => this.isDeveloper(login),
    });
    this.shouldPush = options.push ?? (
      process.env.WIKI_PUSH === '1' || process.env.NODE_ENV === 'production'
    );
  }

  private refreshMetadata() {
    let pMtime = -1;
    try {
      pMtime = fs.statSync(this.projectsFile).mtimeMs;
    } catch {}

    if (pMtime === this.projectsMtime && this.projectsMtime !== -1) {
      return;
    }

    let projectsRaw = '';
    if (pMtime !== -1) {
      try {
        projectsRaw = fs.readFileSync(this.projectsFile, 'utf8');
      } catch {}
    }

    this.adminUsers = new Set(
      this.configuredAdmins.map(a => a.trim().toLowerCase()).filter(Boolean)
    );
    this.authorizedUsers = extractAuthorizedGitHubUsers(projectsRaw, this.configuredAdmins);
    this.authorMap = new Map(
      Object.entries(this.configuredAuthors)
        .filter(([gh, name]) => gh.trim() && typeof name === 'string' && name.trim())
        .map(([gh, name]) => [gh.trim().toLowerCase(), name.trim()])
    );
    const {projects, aliases} = extractProjectPages(projectsRaw);
    this.projectPages = projects;
    this.projectAliases = aliases;
    this.projectsMtime = pMtime;
  }

  formatAuthor(githubLogin: string): string {
    this.refreshMetadata();
    return this.authorMap.get(githubLogin.toLowerCase()) ?? githubLogin;
  }

  resolveSlug(slug: string): string {
    this.refreshMetadata();
    const normalized = normalizeSlug(slug);
    const aliased = this.projectAliases.get(normalized.toLowerCase());
    if (aliased) return aliased;
    if (normalized && fs.existsSync(this.wikiDir)) {
      const lowerTarget = `${normalized.toLowerCase()}.dj`;
      try {
        for (const entry of fs.readdirSync(this.wikiDir)) {
          if (entry.toLowerCase() === lowerTarget && entry.endsWith('.dj')) {
            return entry.slice(0, -3);
          }
        }
      } catch {}
    }
    return normalized;
  }

  getProjectPage(slug: string): ProjectPage | undefined {
    this.refreshMetadata();
    return this.projectPages.get(this.resolveSlug(slug));
  }

  isProjectPage(slug: string): boolean {
    return this.getProjectPage(slug) !== undefined;
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
    if (!this.isProjectPage(canonical)) return 'public';
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
    const project = this.getProjectPage(slug);
    if (project) return project.owners.has(lower);
    return this.authorizedUsers.has(lower);
  }

  verifyDiscordAuth(req: http.IncomingMessage): 'authorized' | 'unauthenticated' | 'forbidden' {
    return this.auth.verifyDiscordAuth(req);
  }

  getSessionUser(req: http.IncomingMessage): string | undefined {
    return this.auth.getSession(req)?.github?.login;
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
    return this.getProjectPage(canonical)?.name ?? formatTitle(canonical);
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
    const isProject = this.isProjectPage(canonical);
    const vis = isProject
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
  wiki.auth.register(app);
  const getLiveTournament = () => options.db?.getRunningTournament();
  const renderPage = (opts: Omit<Parameters<typeof renderPageHtml>[0], 'liveTournament'>) =>
    renderPageHtml({...opts, liveTournament: getLiveTournament()});
  const sendError = (
    res: http.ServerResponse,
    status: number,
    content: string,
    pagePath = '/wiki/'
  ) => sendErrorHtml(res, status, content, pagePath, getLiveTournament());

  const param = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
  const slugParam = (v: string | string[] | undefined) => normalizeSlug(param(v));

  const getEffectiveUser = (req: http.IncomingMessage): string | undefined =>
    wiki.auth.getGitHubUser(req);

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

  const requireReadAuth = (
    req: http.IncomingMessage & {originalUrl?: string},
    res: http.ServerResponse,
    slug = 'index'
  ): boolean => {
    const visibility = wiki.getPageVisibility(slug);
    if (visibility === 'public') return true;

    const authCfg = wiki.auth.getConfig();
    const devAuth = wiki.auth.isDevAuthEnabled();
    if (!authCfg?.github && !devAuth && process.env.NODE_ENV === 'development') return true;

    const login = wiki.getSessionUser(req);
    if (wiki.isDeveloper(login)) return true;

    if (visibility === 'discord') {
      const status = wiki.verifyDiscordAuth(req);
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
      redirect(res, `/auth/discord?return_to=${returnTo}`);
      return false;
    }

    if (!authCfg?.github && !devAuth) {
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
    const authCfg = wiki.auth.getConfig();
    const devAuth = wiki.auth.isDevAuthEnabled();
    let login: string | undefined;
    if (!authCfg?.github && !devAuth) {
      if (process.env.NODE_ENV === 'development') {
        login = 'scheibo';
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
      const project = wiki.getProjectPage(slug);
      const target = escapeHtml(project ? project.name : formatTitle(slug));
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

  const renderPageSlug = (
    req: http.IncomingMessage & {originalUrl?: string},
    res: http.ServerResponse,
    rawSlug: string
  ) => {
    const slug = resolveOrRedirect(res, rawSlug);
    if (!slug) return;
    if (!requireReadAuth(req, res, slug)) return;

    const raw = wiki.readPage(slug);
    const encoded = encodeSlug(slug);
    if (raw === undefined) {
      if (wiki.isProjectPage(slug) && !wiki.canEdit(getEffectiveUser(req), slug)) {
        sendError(
          res,
          404,
          '<p>This project page has not been created yet.</p>',
          `/wiki/${encoded}/`
        );
        return;
      }
      redirect(res, `/wiki/${encoded}/edit`);
      return;
    }
    const meta: {title?: string; summary?: string} = {};
    const html = renderDjot(raw, meta);
    const heading = meta.title ?? wiki.getProjectPage(slug)?.name ?? formatTitle(slug);
    sendHtml(res, 200, renderPage({
      title: heading,
      heading,
      path: slug === 'index' ? '/wiki/' : `/wiki/${encoded}/`,
      nav: wikiNav(slug, 'view'),
      content: html,
    }));
  };

  app.get('/wiki', (req, res) => renderPageSlug(req, res, 'index'));

  app.get('/wiki/pages', (req, res) => {
    const allPages = wiki.listPages();
    const login = getEffectiveUser(req);
    const needsDiscordCheck = !wiki.isDeveloper(login) &&
      allPages.some(p => wiki.getPageVisibility(p) === 'discord');
    const isDiscord = needsDiscordCheck && wiki.verifyDiscordAuth(req) === 'authorized';
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
    const displayTitle = wiki.getProjectPage(slug)?.name ?? formatTitle(slug);
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
    const visibility = wiki.isProjectPage(slug) ? wiki.getPageVisibility(slug) : undefined;
    renderEditor(res, slug, existing, '', visibility);
  });

  app.post('/wiki/:page', async (req, res) => {
    if (auth.isCrossSiteRequest(req)) {
      sendError(res, 403, '<p>Cross-site requests are not allowed.</p>');
      return;
    }
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
      const visibility = wiki.isProjectPage(slug)
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
    if (!requireReadAuth(req, res, slug)) return;
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
    const displayTitle = wiki.getProjectPage(slug)?.name ?? formatTitle(slug);
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
    if (!requireReadAuth(req, res, slug)) return;

    const encoded = encodeSlug(slug);
    const displayTitle = wiki.getProjectPage(slug)?.name ?? formatTitle(slug);
    if (showDiff) {
      const diff = await wiki.getRevisionDiff(slug, sha);
      if (diff === undefined) {
        sendError(res, 404, '<p>Revision not found.</p>');
        return;
      }
      const maxTicks = Math.max(
        3,
        ...Array.from(diff.matchAll(/`+/g), m => m[0].length + 1)
      );
      const fence = '`'.repeat(maxTicks);
      const renderedDiff = renderDjot(`${fence}diff\n${diff}\n${fence}`);
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
