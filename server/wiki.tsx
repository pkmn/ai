import {execFile} from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as querystring from 'querystring';
import {promisify} from 'util';

import * as djot from '@djot/djot';
import katex from 'katex';
import polka from 'polka';
import * as yaml from 'yaml';

import * as db from '../db';
import {header, injectLiveBanner, renderErrorPage, renderer} from '../static/build';
import {Project} from '../static/projects';
import {
  Html,
  TABLE_PAGER_SCRIPT,
  TABLE_PAGE_SIZE,
  TablePager,
  escapeHtml,
  installHeadSupport,
  raw,
  root,
  slugify,
  toID,
} from '../static/util';

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
  wiki?: Wiki;
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

function normalizeDecodedSlug(text: string): string {
  return text.normalize('NFC').trim().replace(/[\s_]+/g, '_');
}

export function normalizeSlug(rawText: string): string {
  try {
    return normalizeDecodedSlug(decodeURIComponent(rawText));
  } catch {
    return '';
  }
}

export function isValidSlug(slug: string): boolean {
  if (!slug || slug.length > 200) return false;
  if (slug.startsWith('.') || slug.includes('..')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[/\\<>:"|?*%\x00-\x1f\x7f]/.test(slug)) return false;
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

export function parsePageContent(rawText: string): {content: string; visibility?: PageVisibility} {
  const m = VISIBILITY.exec(rawText);
  if (!m) return {content: rawText};
  return {
    visibility: m[1] as PageVisibility,
    content: rawText.slice(m[0].length),
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
      if (!aliases.has(arenaSlug)) aliases.set(arenaSlug, slug);
      const normArena = normalizeDecodedSlug(arenaSlug).toLowerCase();
      if (!aliases.has(normArena)) aliases.set(normArena, slug);
    }
    const idAlias = toID(name);
    if (idAlias && !RESERVED_SLUGS.has(idAlias) && !aliases.has(idAlias)) {
      aliases.set(idAlias, slug);
    }
  }
  return {projects, aliases};
}

const STYLE = fs.readFileSync(root('static', 'style', 'wiki.css'), 'utf8');

function renderPageHtml(opts: {
  id?: string;
  title: string;
  heading: string;
  path: string;
  nav?: Html | string;
  content: Html | string;
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
    return opts.nav ? withRobots.replace('<footer>', `${String(opts.nav)}<footer>`) : withRobots;
  });
}

function wikiNav(slug: string, active: 'view' | 'edit' | 'history' | 'pages'): Html {
  const item = (key: typeof active, href: string, label: string) =>
    key === active ? <strong>{label}</strong> : <a href={href}>{label}</a>;
  const encoded = encodeSlug(slug);
  const viewHref = slug === 'index' ? '/wiki' : `/wiki/${encoded}`;
  return <nav id='wiki-nav'>
    {item('view', viewHref, 'View')} — {item('edit', `/wiki/${encoded}/edit`, 'Edit')} —{' '}
    {item('history', `/wiki/${encoded}/history`, 'History')} —{' '}
    {item('pages', '/wiki/pages', 'Pages')}
  </nav>;
}

const SMART_PUNCTUATION: Record<djot.SmartPunctuationType, string> = {
  left_single_quote: '\u2018',
  right_single_quote: '\u2019',
  left_double_quote: '\u201c',
  right_double_quote: '\u201d',
  ellipses: '\u2026',
  em_dash: '\u2014',
  en_dash: '\u2013',
};

function decodeHtmlEntities(rawText: string): string {
  return rawText
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '\ufffd';
    })
    .replace(/&#([0-9]+);?/g, (_, dec) => {
      const code = parseInt(dec, 10);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '\ufffd';
    })
    .replace(/&colon;/gi, ':')
    .replace(/&tab;/gi, '\t')
    .replace(/&newline;/gi, '\n');
}

function resolveWikiHref(rawHref: string | undefined): string {
  if (!rawHref) return '#';
  const trimmed = rawHref.trim();
  if (!trimmed) return '#';
  // eslint-disable-next-line no-control-regex
  const decoded = decodeHtmlEntities(trimmed).replace(/[\x00-\x20]+/g, '');
  if (!decoded || decoded.includes('\ufffd')) return '#';
  if (decoded.startsWith('#')) return trimmed;
  if (decoded.startsWith('/')) {
    return decoded.startsWith('//') ? '#' : trimmed;
  }
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(decoded);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    return (scheme === 'https' || scheme === 'http') && /^https?:\/\//i.test(trimmed)
      ? trimmed
      : '#';
  }
  if (decoded.includes(':')) return '#';
  const [p, hash] = trimmed.split('#');
  const clean = normalizeSlug(p.replace(/\.dj$/, ''));
  if (!clean) return hash ? `#${hash}` : '#';
  return `/wiki/${encodeSlug(clean)}${hash ? `#${hash}` : ''}`;
}

const MAX_AST_DEPTH = 64;

function extractPlainText(node: djot.AstNode): string {
  const parts: string[] = [];
  const walk = (cur: djot.AstNode, depth: number) => {
    if (depth > MAX_AST_DEPTH) return;
    if ('text' in cur) {
      parts.push(cur.text);
    } else if (cur.tag === 'soft_break' || cur.tag === 'hard_break') {
      parts.push('\n');
    } else if ('children' in cur) {
      for (const child of cur.children) walk(child, depth + 1);
    }
  };
  walk(node, 0);
  return parts.join('');
}

function extractTopHeadingTitle(body: string): string | undefined {
  try {
    const doc = djot.parse(body);
    for (const child of doc.children) {
      if (child.tag === 'heading' && child.level === 1) {
        return extractPlainText(child).trim() || undefined;
      }
      if (child.tag === 'section') {
        const first = child.children.find(
          (c): c is djot.Heading => c.tag === 'heading' && c.level === 1
        );
        if (first) return extractPlainText(first).trim() || undefined;
      }
    }
  } catch {}
  return undefined;
}

function renderSafeMath(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, {
      output: 'mathml',
      displayMode,
      trust: false,
      strict: 'ignore',
      throwOnError: true,
    });
  } catch {
    return String(<code>{tex}</code>);
  }
}

// Locked-down rich-text Djot AST renderer for user-authored wiki pages:
//   - Drops all raw HTML (`raw_block`, `raw_inline`) and external `<img>` beacons at the AST level
//   - Ignores all user-supplied Djot `{...}` attributes (`id`, `class`, `onclick`, `style`, etc.)
//   - Allows only `https://`, `http://`, `/...`, `#...`, and relative wiki links on `<a>`
//   - Escapes all text and code blocks directly via `escapeHtml` with no post-hoc regex sanitizer
export function renderDjot(rawText: string, save?: {title?: string; summary?: string}): string {
  const {content} = parsePageContent(rawText);
  const doc = djot.parse(content);
  const usedIds = new Set<string>();
  const nextIdIndex = new Map<string, number>();
  const footnoteOrder: string[] = [];
  const footnoteIndex = new Map<string, number>();

  const uniqueHeadingId = (text: string): string | undefined => {
    const base = slugify(text).toLowerCase();
    if (!base) return undefined;
    if (!usedIds.has(base)) {
      usedIds.add(base);
      nextIdIndex.set(base, 2);
      return base;
    }
    let n = nextIdIndex.get(base) ?? 2;
    let candidate = `${base}-${n}`;
    while (usedIds.has(candidate)) {
      n++;
      candidate = `${base}-${n}`;
    }
    usedIds.add(candidate);
    nextIdIndex.set(base, n + 1);
    return candidate;
  };

  const resolveLinkNodeHref = (node: djot.Link): string => {
    if (node.destination !== undefined) return resolveWikiHref(node.destination);
    if (node.reference !== undefined) {
      const ref = doc.references[node.reference] ?? doc.autoReferences[node.reference];
      return resolveWikiHref(ref?.destination);
    }
    return '#';
  };

  const renderInlines = (nodes: djot.Inline[], depth = 0): string =>
    depth > MAX_AST_DEPTH ? '' : nodes.map(n => renderInline(n, depth)).join('');

  const renderInline = (node: djot.Inline, depth = 0): string => {
    if (depth > MAX_AST_DEPTH) return '';
    const nextDepth = depth + 1;
    switch (node.tag) {
      case 'str':
        return escapeHtml(node.text);
      case 'soft_break':
        return '\n';
      case 'hard_break':
        return '<br>\n';
      case 'non_breaking_space':
        return '&nbsp;';
      case 'smart_punctuation':
        return escapeHtml(SMART_PUNCTUATION[node.type] ?? node.text);
      case 'symb':
        return escapeHtml(`:${node.alias}:`);
      case 'verbatim':
        return String(<code>{node.text}</code>);
      case 'raw_inline':
        return '';
      case 'inline_math':
        return renderSafeMath(node.text, false);
      case 'display_math':
        return renderSafeMath(node.text, true);
      case 'url': {
        const href = resolveWikiHref(node.text);
        return String(<a href={href}>{node.text}</a>);
      }
      case 'email':
        return escapeHtml(node.text);
      case 'footnote_reference': {
        if (!doc.footnotes[node.text]) return escapeHtml(`[^${node.text}]`);
        let idx = footnoteIndex.get(node.text);
        if (idx === undefined) {
          footnoteOrder.push(node.text);
          idx = footnoteOrder.length;
          footnoteIndex.set(node.text, idx);
        }
        return String(<sup id={`fnref-${idx}`}><a href={`#fn-${idx}`}>{`[${idx}]`}</a></sup>);
      }
      case 'emph':
        return String(<em>{raw(renderInlines(node.children, nextDepth))}</em>);
      case 'strong':
        return String(<strong>{raw(renderInlines(node.children, nextDepth))}</strong>);
      case 'link':
        return String(
          <a href={resolveLinkNodeHref(node)}>{raw(renderInlines(node.children, nextDepth))}</a>
        );
      case 'image':
        return renderInlines(node.children, nextDepth);
      case 'span':
        return renderInlines(node.children, nextDepth);
      case 'mark':
        return String(<mark>{raw(renderInlines(node.children, nextDepth))}</mark>);
      case 'superscript':
        return String(<sup>{raw(renderInlines(node.children, nextDepth))}</sup>);
      case 'subscript':
        return String(<sub>{raw(renderInlines(node.children, nextDepth))}</sub>);
      case 'insert':
        return String(<ins>{raw(renderInlines(node.children, nextDepth))}</ins>);
      case 'delete':
        return String(<del>{raw(renderInlines(node.children, nextDepth))}</del>);
      case 'double_quoted':
        return `\u201c${renderInlines(node.children, nextDepth)}\u201d`;
      case 'single_quoted':
        return `\u2018${renderInlines(node.children, nextDepth)}\u2019`;
    }
  };

  const renderListItemBlocks = (blocks: djot.Block[], tight: boolean, depth: number): string => {
    if (tight && blocks.length === 1 && blocks[0].tag === 'para') {
      return renderInlines(blocks[0].children, depth);
    }
    return `\n${renderBlocks(blocks, undefined, depth)}`;
  };

  const renderBlocks = (blocks: djot.Block[], sectionId?: string, depth = 0): string =>
    depth > MAX_AST_DEPTH ? '' : blocks.map(b => renderBlock(b, sectionId, depth)).join('');

  const renderBlock = (node: djot.Block, sectionId?: string, depth = 0): string => {
    if (depth > MAX_AST_DEPTH) return '';
    const nextDepth = depth + 1;
    switch (node.tag) {
      case 'para':
        if (save && !save.summary) save.summary = extractPlainText(node).trim();
        return `${String(<p>{raw(renderInlines(node.children, nextDepth))}</p>)}\n`;
      case 'heading': {
        if (node.level === 1 && save && save.title === undefined) {
          save.title = extractPlainText(node).trim();
          return '';
        }
        const level = Math.min(6, Math.max(2, node.level));
        const inner = raw(renderInlines(node.children, nextDepth));
        const anchorId = sectionId ?? uniqueHeadingId(extractPlainText(node));
        const headingChild = anchorId
          ? <a href={`#${anchorId}`} className='subtle'>{inner}</a>
          : inner;
        return `${String(h(`h${level}`, undefined, headingChild))}\n`;
      }
      case 'thematic_break':
        return '<hr>\n';
      case 'section': {
        const firstHeading = node.children.find(
          (c): c is djot.Heading => c.tag === 'heading'
        );
        if (firstHeading?.level === 1) {
          return renderBlocks(node.children, undefined, nextDepth);
        }
        const secId = firstHeading ? uniqueHeadingId(extractPlainText(firstHeading)) : undefined;
        const inner = renderBlocks(node.children, secId, nextDepth);
        return `${String(<section id={secId}>{raw(`\n${inner}`)}</section>)}\n`;
      }
      case 'div':
        return renderBlocks(node.children, undefined, nextDepth);
      case 'code_block':
        return `${String(
          <figure className='code'><pre><code>{node.text.trimEnd()}</code></pre></figure>
        )}\n`;
      case 'raw_block':
        return '';
      case 'block_quote':
        return `${String(
          <figure className='blockquote'>
            <blockquote>{raw(`\n${renderBlocks(node.children, undefined, nextDepth)}`)}</blockquote>
          </figure>
        )}\n`;
      case 'bullet_list':
        return `${String(
          <ul>
            {raw(`\n${node.children.map(
              li => `${String(
                <li>{raw(renderListItemBlocks(li.children, node.tight, nextDepth))}</li>
              )}\n`
            ).join('')}`)}
          </ul>
        )}\n`;
      case 'ordered_list': {
        const start = node.start !== undefined && node.start !== 1
          ? Number(node.start)
          : undefined;
        return `${String(
          <ol start={start}>
            {raw(`\n${node.children.map(
              li => `${String(
                <li>{raw(renderListItemBlocks(li.children, node.tight, nextDepth))}</li>
              )}\n`
            ).join('')}`)}
          </ol>
        )}\n`;
      }
      case 'task_list':
        return `${String(
          <ul className='task-list'>
            {raw(`\n${node.children.map(li => {
              const box = li.checkbox === 'checked' ? '\u2611 ' : '\u2610 ';
              return `${String(
                <li>{box}{raw(renderListItemBlocks(li.children, node.tight, nextDepth))}</li>
              )}\n`;
            }).join('')}`)}
          </ul>
        )}\n`;
      case 'definition_list':
        return `${String(
          <dl>
            {raw(`\n${node.children.map(item => (
              `${String(<dt>{raw(renderInlines(item.children[0].children, nextDepth))}</dt>)}\n` +
              `${String(
                <dd>{raw(`\n${renderBlocks(item.children[1].children, undefined, nextDepth)}`)}</dd>
              )}\n`
            )).join('')}`)}
          </dl>
        )}\n`;
      case 'table': {
        const [caption, ...rows] = node.children;
        const captionHtml = caption.children.length
          ? `${String(<caption>{raw(renderInlines(caption.children, nextDepth))}</caption>)}\n`
          : '';
        const rowsHtml = rows.map(row => {
          const cells = row.children.map(cell => {
            const tag = cell.head ? 'th' : 'td';
            return String(h(tag, undefined, raw(renderInlines(cell.children, nextDepth))));
          }).join('');
          return `${String(<tr>{raw(cells)}</tr>)}\n`;
        }).join('');
        return `${String(<table>{raw(`\n${captionHtml}${rowsHtml}`)}</table>)}\n`;
      }
    }
  };

  let html = renderBlocks(doc.children);
  if (footnoteOrder.length > 0) {
    const items: string[] = [];
    for (let i = 0; i < footnoteOrder.length; i++) {
      const label = footnoteOrder[i];
      const fn = doc.footnotes[label];
      if (!fn) continue;
      const num = i + 1;
      items.push(
        `${String(
          <li id={`fn-${num}`}>
            {raw(`\n${renderBlocks(fn.children)}`)}
            <p><a href={`#fnref-${num}`}>{'\u21a9'}</a></p>
          </li>
        )}\n`
      );
    }
    if (items.length > 0) {
      html += `${String(
        <section className='footnotes'>
          <hr />
          {raw(`\n<ol>\n${items.join('')}</ol>`)}
        </section>
      )}\n`;
    }
  }
  return html;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        settled = true;
        req.resume();
        reject(Object.assign(new Error('Payload Too Large'), {status: 413}));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    req.on('error', err => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
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

export class Wiki {
  readonly wikiDir: string;
  readonly projectsFile: string;
  readonly auth: auth.Auth;
  private readonly db?: db.Database;
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
    this.db = options.db;
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
    } catch {
      if (this.projectsMtime !== -1) return;
    }

    if (pMtime === this.projectsMtime && this.projectsMtime !== -1) {
      return;
    }

    let projectsRaw = '';
    if (pMtime !== -1) {
      try {
        projectsRaw = fs.readFileSync(this.projectsFile, 'utf8');
      } catch {
        if (this.projectsMtime !== -1) return;
      }
    }

    let authorizedUsers: Set<string>;
    let extracted: {projects: Map<string, ProjectPage>; aliases: Map<string, string>};
    try {
      authorizedUsers = extractAuthorizedGitHubUsers(projectsRaw, this.configuredAdmins);
      extracted = extractProjectPages(projectsRaw);
    } catch (err) {
      console.error('Failed parsing projects.yml for wiki metadata:', err);
      if (this.projectsMtime !== -1) return;
      authorizedUsers = new Set(
        this.configuredAdmins.map(a => a.trim().toLowerCase()).filter(Boolean)
      );
      extracted = {projects: new Map(), aliases: new Map()};
    }

    this.adminUsers = new Set(
      this.configuredAdmins.map(a => a.trim().toLowerCase()).filter(Boolean)
    );
    this.authorizedUsers = authorizedUsers;
    this.authorMap = new Map(
      Object.entries(this.configuredAuthors)
        .filter(([gh, name]) => gh.trim() && typeof name === 'string' && name.trim())
        .map(([gh, name]) => [gh.trim().toLowerCase(), name.trim()])
    );
    this.projectPages = extracted.projects;
    this.projectAliases = extracted.aliases;
    this.projectsMtime = pMtime;
  }

  formatAuthor(githubLogin: string): string {
    this.refreshMetadata();
    return this.authorMap.get(githubLogin.toLowerCase()) ?? githubLogin;
  }

  resolveSlug(slug: string, alreadyDecoded = false): string {
    this.refreshMetadata();
    const normalized = alreadyDecoded ? normalizeDecodedSlug(slug) : normalizeSlug(slug);
    const aliased = this.projectAliases.get(normalized.toLowerCase());
    if (aliased) return aliased;
    if (normalized && fs.existsSync(this.wikiDir)) {
      if (fs.existsSync(path.join(this.wikiDir, `${normalized}.dj`))) {
        return normalized;
      }
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

  private isBlockedInDb(lowerLogin: string): boolean {
    if (!this.db) return false;
    const dev = this.db.getDeveloperByGitHub(lowerLogin);
    if (!dev) return false;
    if (dev.smogonStanding === 'bad') return true;
    const agent = this.db.getAgentById(dev.agentId);
    return agent?.status === 'disabled';
  }

  isAdmin(login: string | undefined): boolean {
    if (!login) return false;
    this.refreshMetadata();
    return this.adminUsers.has(login.toLowerCase());
  }

  isDeveloper(login: string | undefined): boolean {
    if (!login) return false;
    this.refreshMetadata();
    const lower = login.toLowerCase();
    if (this.adminUsers.has(lower)) return true;
    if (!this.authorizedUsers.has(lower)) return false;
    return !this.isBlockedInDb(lower);
  }

  getPageVisibility(slug: string): PageVisibility {
    const canonical = this.resolveSlug(slug);
    const isProject = this.isProjectPage(canonical);
    let rawText: string | undefined;
    try {
      rawText = this.readRawPage(canonical);
    } catch {}
    if (rawText === undefined) return isProject ? 'developers' : 'public';
    const explicit = parsePageContent(rawText).visibility;
    if (isProject) return explicit ?? 'developers';
    if (explicit === 'developers' || explicit === 'discord') return explicit;
    return 'public';
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
    if (this.isBlockedInDb(lower)) return false;
    if (!slug) return this.authorizedUsers.has(lower);
    const project = this.getProjectPage(slug);
    if (project) return project.owners.has(lower);
    return this.authorizedUsers.has(lower);
  }

  verifyDiscordAuth(req: http.IncomingMessage): 'authorized' | 'unauthenticated' | 'forbidden' {
    return this.auth.verifyDiscordAuth(req);
  }

  getSessionUser(req: http.IncomingMessage): string | undefined {
    return this.auth.getGitHubUser(req);
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
    const rawText = this.readRawPage(slug);
    return rawText !== undefined ? parsePageContent(rawText).content : undefined;
  }

  pageTitle(slug: string): string {
    const canonical = this.resolveSlug(slug);
    const body = this.readPage(canonical);
    if (body) {
      const h1 = extractTopHeadingTitle(body);
      if (h1) return h1;
    }
    return this.getProjectPage(canonical)?.name ?? formatTitle(canonical);
  }

  getContentFingerprint(slug: string): string {
    const rawText = this.readRawPage(slug);
    if (rawText === undefined) return 'new';
    return crypto.createHash('sha256').update(rawText).digest('hex').slice(0, 16);
  }

  listPages(): string[] {
    if (!fs.existsSync(this.wikiDir)) return [];
    return fs.readdirSync(this.wikiDir)
      .filter(f => f.endsWith('.dj'))
      .map(f => f.slice(0, -3))
      .filter(isValidSlug)
      .sort((a, b) => a.localeCompare(b));
  }

  listPageSummaries(): Array<{slug: string; title: string; visibility: PageVisibility}> {
    this.refreshMetadata();
    const slugs = this.listPages();
    return slugs.map(slug => {
      const canonical = this.projectAliases.get(slug.toLowerCase()) ?? slug;
      const project = this.projectPages.get(canonical);
      let rawText: string | undefined;
      try {
        rawText = fs.readFileSync(path.join(this.wikiDir, `${slug}.dj`), 'utf8');
      } catch {}
      const parsed = rawText !== undefined ? parsePageContent(rawText) : undefined;
      const visibility: PageVisibility = project
        ? (parsed?.visibility ?? 'developers')
        : (parsed?.visibility === 'developers' || parsed?.visibility === 'discord'
          ? parsed.visibility
          : 'public');
      const h1Title = parsed?.content ? extractTopHeadingTitle(parsed.content) : undefined;
      const title = h1Title || project?.name || formatTitle(canonical);
      return {slug, title, visibility};
    });
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
      const file = path.join(this.wikiDir, `${canonical}.dj`);
      const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
      if (prev === content) return false;

      const rel = `${canonical}.dj`;
      const literalRel = `:(literal)${rel}`;
      const defaultMsg = prev === undefined ? `Create ${canonical}` : `Update ${canonical}`;
      // eslint-disable-next-line no-control-regex
      const cleanMessage = message?.replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
      const summary = cleanMessage || defaultMsg;
      // eslint-disable-next-line no-control-regex
      const safeAuthor = author.replace(/[\x00-\x1f\x7f<>"]/g, '').trim() || 'wiki';
      const gitAuthor = `${safeAuthor} <${safeAuthor}@users.noreply.github.com>`;

      fs.writeFileSync(file, content, 'utf8');
      try {
        await execFileAsync('git', ['add', '--', literalRel], {
          cwd: this.wikiDir,
          timeout: 15_000,
        });
        await execFileAsync(
          'git',
          [
            '-c', 'user.name=pkmn.ai',
            '-c', 'user.email=wiki@pkmn.ai',
            'commit',
            `--author=${gitAuthor}`,
            '-m', summary,
            '--', literalRel,
          ],
          {cwd: this.wikiDir, timeout: 15_000}
        );
      } catch (err) {
        try {
          if (prev === undefined) fs.rmSync(file, {force: true});
          else fs.writeFileSync(file, prev, 'utf8');
          await execFileAsync('git', ['reset', '--mixed', '-q', '--', literalRel], {
            cwd: this.wikiDir,
            timeout: 5_000,
          });
        } catch {}
        throw err;
      }

      if (this.shouldPush) {
        await execFileAsync('git', ['push', 'origin', 'HEAD'], {
          cwd: this.wikiDir,
          timeout: 30_000,
        }).catch(err => {
          console.error('Error pushing wiki commit:', err);
        });
      }
      return true;
    });
  }

  async getHistory(slug: string): Promise<Revision[]> {
    const canonical = this.resolveSlug(slug);
    if (!isValidSlug(canonical)) return [];
    const file = path.join(this.wikiDir, `${canonical}.dj`);
    if (!fs.existsSync(file)) return [];
    try {
      const {stdout} = await execFileAsync(
        'git',
        [
          'log',
          '--format=%H%x09%h%x09%an%x09%at%x09%s',
          '--',
          `:(literal)${canonical}.dj`,
        ],
        {cwd: this.wikiDir, timeout: 15_000}
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

  async getRevisionRecord(
    slug: string,
    sha: string,
    parent = false
  ): Promise<{content: string; visibility?: PageVisibility} | undefined> {
    const canonical = this.resolveSlug(slug);
    if (!isValidSlug(canonical) || !SHA_RE.test(sha)) return undefined;
    const commitRef = parent ? `${sha}^{commit}^` : `${sha}^{commit}`;
    try {
      await execFileAsync('git', ['rev-parse', '--verify', '--quiet', commitRef], {
        cwd: this.wikiDir,
        timeout: 5_000,
      });
      const {stdout} = await execFileAsync(
        'git',
        ['show', `${commitRef}:${canonical}.dj`],
        {cwd: this.wikiDir, timeout: 15_000}
      );
      return parsePageContent(stdout);
    } catch {
      return undefined;
    }
  }

  async getRevisionContent(slug: string, sha: string): Promise<string | undefined> {
    const rec = await this.getRevisionRecord(slug, sha);
    return rec?.content;
  }

  async getRevisionDiff(slug: string, sha: string): Promise<string | undefined> {
    const canonical = this.resolveSlug(slug);
    if (!isValidSlug(canonical) || !SHA_RE.test(sha)) return undefined;
    try {
      await execFileAsync('git', ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], {
        cwd: this.wikiDir,
        timeout: 5_000,
      });
      const {stdout} = await execFileAsync(
        'git',
        ['show', '--format=', `${sha}^{commit}`, '--', `:(literal)${canonical}.dj`],
        {cwd: this.wikiDir, timeout: 15_000}
      );
      return stdout || undefined;
    } catch {
      return undefined;
    }
  }
}

export function register(app: polka.Polka, options: Options = {}): Wiki {
  installHeadSupport(app);
  const wiki = options.wiki ?? new Wiki(options);
  wiki.auth.register(app);
  const getLiveTournament = () => options.db?.getRunningTournament();
  const renderPage = (opts: Omit<Parameters<typeof renderPageHtml>[0], 'liveTournament'>) =>
    renderPageHtml({...opts, liveTournament: getLiveTournament()});
  const sendError = (res: http.ServerResponse, status: number) =>
    sendHtml(res, status, renderErrorPage(status, getLiveTournament()));

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
      sendError(res, 404);
      return undefined;
    }
    const canonical = wiki.resolveSlug(rawSlug, true);
    if (canonical !== rawSlug) {
      redirect(res, `/wiki/${encodeSlug(canonical)}${suffix}`);
      return undefined;
    }
    return canonical;
  };

  const stricterVisibility = (a: PageVisibility, b?: PageVisibility): PageVisibility => {
    if (!b) return a;
    const rank: Record<PageVisibility, number> = {public: 0, discord: 1, developers: 2};
    return rank[b] > rank[a] ? b : a;
  };

  const requireReadAuth = (
    req: http.IncomingMessage & {originalUrl?: string},
    res: http.ServerResponse,
    slug = 'index',
    extraVisibility?: PageVisibility
  ): boolean => {
    const visibility = stricterVisibility(wiki.getPageVisibility(slug), extraVisibility);
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
        sendError(res, 403);
        return false;
      }
      const returnTo = encodeURIComponent(req.originalUrl || req.url || '/wiki');
      redirect(res, `/auth/discord?return_to=${returnTo}`);
      return false;
    }

    if (!authCfg?.github && !devAuth) {
      sendError(res, 503);
      return false;
    }
    if (!login) {
      const returnTo = encodeURIComponent(req.originalUrl || req.url || '/wiki');
      redirect(res, `/auth/github?return_to=${returnTo}`);
      return false;
    }
    sendError(res, 403);
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
        sendError(res, 503);
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
      sendError(res, 403);
      return undefined;
    }

    if (slug && !wiki.canEdit(login, slug)) {
      sendError(res, 403);
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

    const rawText = wiki.readPage(slug);
    const encoded = encodeSlug(slug);
    if (rawText === undefined) {
      if (wiki.isProjectPage(slug) && !wiki.canEdit(getEffectiveUser(req), slug)) {
        sendError(res, 404);
        return;
      }
      redirect(res, `/wiki/${encoded}/edit`);
      return;
    }
    const meta: {title?: string; summary?: string} = {};
    const html = renderDjot(rawText, meta);
    const heading = meta.title ?? wiki.getProjectPage(slug)?.name ?? formatTitle(slug);
    sendHtml(res, 200, renderPage({
      title: heading,
      heading,
      path: slug === 'index' ? '/wiki/' : `/wiki/${encoded}/`,
      nav: wikiNav(slug, 'view'),
      content: raw(html),
    }));
  };

  app.get('/wiki', (req, res) => renderPageSlug(req, res, 'index'));

  app.get('/wiki/pages', (req, res) => {
    const summaries = wiki.listPageSummaries();
    const login = getEffectiveUser(req);
    const isDev = wiki.isDeveloper(login);
    const needsDiscordCheck = !isDev && summaries.some(p => p.visibility === 'discord');
    const isDiscord = needsDiscordCheck && wiki.verifyDiscordAuth(req) === 'authorized';
    const pages = summaries.filter(p => (
      p.visibility === 'public' ||
      isDev ||
      (p.visibility === 'discord' && isDiscord)
    ));

    sendHtml(res, 200, renderPage({
      title: 'Pages — Wiki',
      heading: 'Pages',
      path: '/wiki/pages/',
      nav: wikiNav('index', 'pages'),
      content: pages.length ? (
        <ul id='wiki-pages'>
          {pages.map(p => {
            const href = p.slug === 'index' ? '/wiki' : `/wiki/${encodeSlug(p.slug)}`;
            return <li><a href={href}>{p.title}</a></li>;
          })}
        </ul>
      ) : (
        <p>No pages yet.</p>
      ),
    }));
  });

  app.get('/wiki/:page', (req, res) => renderPageSlug(req, res, slugParam(req.params.page)));

  const renderEditor = (
    res: http.ServerResponse,
    slug: string,
    content: string,
    message = '',
    visibility?: PageVisibility,
    previewHtml?: string,
    baseSha = wiki.getContentFingerprint(slug),
    statusCode = 200
  ) => {
    const displayTitle = wiki.getProjectPage(slug)?.name ?? formatTitle(slug);
    const heading = `Edit ${displayTitle}`;
    const encoded = encodeSlug(slug);
    const actionUrl = `/wiki/${encoded}`;
    const radioItem = (val: PageVisibility, label: string) => (
      <li>
        <input
          type='radio'
          name='visibility'
          value={val}
          id={`vis-${val}`}
          checked={visibility === val}
        />
        <label htmlFor={`vis-${val}`}>{label}</label>
      </li>
    );
    const form = (
      <>
        {previewHtml !== undefined && <section id='wiki-preview'>{raw(previewHtml)}</section>}
        <form id='wiki-editor' method='post' action={actionUrl}>
          <input type='hidden' name='baseSha' value={baseSha} />
          <textarea name='content' spellcheck={true} autofocus={true}>{content}</textarea>
          <input
            type='text'
            name='message'
            value={message}
            placeholder='Commit summary (optional)'
            maxLength={120}
          />
          {visibility && (
            <nav id='wiki-visibility'>
              <ul>
                {radioItem('developers', 'Developers')} — {radioItem('discord', 'Discord')} —{' '}
                {radioItem('public', 'Public')}
              </ul>
            </nav>
          )}
          <div id='wiki-actions'>
            <button type='submit' name='action' value='save'>Save</button>
            {' — '}
            <button type='submit' name='action' value='preview'>Preview</button>
          </div>
        </form>
      </>
    );
    sendHtml(res, statusCode, renderPage({
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
      sendError(res, 403);
      return;
    }
    const rawSlug = slugParam(req.params.page);
    if (!isValidSlug(rawSlug)) {
      sendError(res, 404);
      return;
    }
    const slug = wiki.resolveSlug(rawSlug, true);
    if (!isValidSlug(slug)) {
      sendError(res, 404);
      return;
    }
    const login = requireEditAuth(req, res, slug);
    if (!login) return;
    try {
      const body = await readBody(req);
      const parsed = querystring.parse(body);
      if (typeof parsed.content !== 'string') {
        sendError(res, 400);
        return;
      }
      const content = parsed.content;
      const message = typeof parsed.message === 'string' ? parsed.message : '';
      const action = typeof parsed.action === 'string' ? parsed.action : 'save';
      const baseSha = typeof parsed.baseSha === 'string' ? parsed.baseSha.trim() : '';
      const rawVis = typeof parsed.visibility === 'string' ? parsed.visibility : '';
      const visibility = wiki.isProjectPage(slug)
        ? (VISIBILITIES.has(rawVis as PageVisibility)
          ? (rawVis as PageVisibility)
          : wiki.getPageVisibility(slug))
        : undefined;

      if (action === 'preview') {
        const previewHtml = renderDjot(content, {});
        renderEditor(
          res,
          slug,
          content,
          message,
          visibility,
          previewHtml,
          baseSha || wiki.getContentFingerprint(slug)
        );
        return;
      }

      const currentFingerprint = wiki.getContentFingerprint(slug);
      if (baseSha && baseSha !== currentFingerprint) {
        const conflictNote = String(
          <p className='no'>
            Edit conflict: this page was modified by another editor. Review your draft below and
            save again to overwrite.
          </p>
        );
        const previewHtml = `${conflictNote}${renderDjot(content, {})}`;
        renderEditor(res, slug, content, message, visibility, previewHtml, currentFingerprint, 409);
        return;
      }

      await wiki.savePage(slug, content, login, message, visibility);
      redirect(res, slug === 'index' ? '/wiki' : `/wiki/${encodeSlug(slug)}`, 303);
    } catch (err: any) {
      const status = err?.status ?? 500;
      console.error('Error saving wiki page:', err);
      sendError(res, status);
    }
  });

  app.get('/wiki/:page/history', async (req, res) => {
    try {
      const slug = resolveOrRedirect(res, slugParam(req.params.page), '/history');
      if (!slug) return;
      if (!requireReadAuth(req, res, slug)) return;
      const encoded = encodeSlug(slug);
      const revisions = await wiki.getHistory(slug);
      const table = revisions.length ? (
        <>
          <div className='table-wrap'>
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Revision</th>
                  <th>Author</th>
                  <th>Summary</th>
                </tr>
              </thead>
              <tbody>
                {revisions.map((rev, idx) => {
                  const date = new Date(rev.timestamp * 1000).toISOString().slice(0, 10);
                  const revUrl = `/wiki/${encoded}/${rev.sha}`;
                  const ghUrl = `https://github.com/${encodeURIComponent(rev.author)}`;
                  const displayAuthor = wiki.formatAuthor(rev.author);
                  return (
                    <tr className={idx >= TABLE_PAGE_SIZE ? 'hide' : undefined}>
                      <td className='wiki-meta'>{date}</td>
                      <td>
                        <code><a href={revUrl}>{rev.shortSha}</a></code> (
                        <a href={`${revUrl}?diff=1`}>diff</a>)
                      </td>
                      <td>
                        <a href={ghUrl} className='subtle'>{displayAuthor}</a>
                      </td>
                      <td>{rev.subject}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <TablePager
            id='wiki-history-pager'
            label='Revision history pagination'
            total={revisions.length}
            singular='revision'
            plural='revisions'
          />
          <script>
            {`document.addEventListener('DOMContentLoaded', () => {${TABLE_PAGER_SCRIPT}});`}
          </script>
        </>
      ) : (
        <p>No history for this page yet.</p>
      );
      const displayTitle = wiki.getProjectPage(slug)?.name ?? formatTitle(slug);
      const heading = `History — ${displayTitle}`;
      sendHtml(res, 200, renderPage({
        title: heading,
        heading,
        path: `/wiki/${encoded}/history/`,
        nav: wikiNav(slug, 'history'),
        content: table,
      }));
    } catch (err) {
      console.error('Error rendering wiki history:', err);
      if (!res.headersSent) sendError(res, 500);
    }
  });

  app.get('/wiki/:page/:sha', async (req, res) => {
    try {
      const rawSlug = slugParam(req.params.page);
      const sha = param(req.params.sha);
      if (!isValidSlug(rawSlug) || !SHA_RE.test(sha)) {
        sendError(res, 404);
        return;
      }
      const showDiff = req.query.diff === '1';
      const slug = resolveOrRedirect(res, rawSlug, `/${sha}${showDiff ? '?diff=1' : ''}`);
      if (!slug) return;
      if (!requireReadAuth(req, res, slug)) return;

      const isProject = wiki.isProjectPage(slug);
      const revRecord = await wiki.getRevisionRecord(slug, sha);
      const revVis: PageVisibility | undefined = revRecord
        ? (isProject
          ? (revRecord.visibility ?? 'developers')
          : (revRecord.visibility === 'developers' || revRecord.visibility === 'discord'
            ? revRecord.visibility
            : undefined))
        : undefined;

      const encoded = encodeSlug(slug);
      const displayTitle = wiki.getProjectPage(slug)?.name ?? formatTitle(slug);
      if (showDiff) {
        const parentRecord = await wiki.getRevisionRecord(slug, sha, true);
        const parentVis: PageVisibility | undefined = parentRecord
          ? (isProject
            ? (parentRecord.visibility ?? 'developers')
            : (parentRecord.visibility === 'developers' || parentRecord.visibility === 'discord'
              ? parentRecord.visibility
              : undefined))
          : undefined;
        const diffVis = stricterVisibility(revVis ?? 'public', parentVis);
        if (!requireReadAuth(req, res, slug, diffVis)) return;

        const diff = await wiki.getRevisionDiff(slug, sha);
        if (diff === undefined) {
          sendError(res, 404);
          return;
        }
        let maxTicks = 3;
        for (const m of diff.matchAll(/`+/g)) {
          if (m[0].length + 1 > maxTicks) maxTicks = m[0].length + 1;
        }
        const fence = '`'.repeat(maxTicks);
        const renderedDiff = renderDjot(`${fence}diff\n${diff}\n${fence}`);
        const heading = `${displayTitle} @ ${sha.slice(0, 7)}`;
        sendHtml(res, 200, renderPage({
          title: heading,
          heading,
          path: `/wiki/${encoded}/${sha}/`,
          nav: wikiNav(slug, 'history'),
          content: (
            <>
              <p className='wiki-meta'>
                <a href={`/wiki/${encoded}/${sha}`}>View snapshot</a>
              </p>
              {raw(renderedDiff)}
            </>
          ),
        }));
        return;
      }

      if (!revRecord) {
        sendError(res, 404);
        return;
      }
      if (!requireReadAuth(req, res, slug, revVis)) return;
      const rawText = revRecord.content;
      const meta: {title?: string; summary?: string} = {};
      const html = renderDjot(rawText, meta);
      const heading = `${meta.title ?? displayTitle} @ ${sha.slice(0, 7)}`;
      sendHtml(res, 200, renderPage({
        title: heading,
        heading,
        path: `/wiki/${encoded}/${sha}/`,
        nav: wikiNav(slug, 'history'),
        content: (
          <>
            <p className='wiki-meta'>
              <a href={`/wiki/${encoded}/${sha}?diff=1`}>View diff</a>
            </p>
            {raw(html)}
          </>
        ),
      }));
    } catch (err) {
      console.error('Error rendering wiki revision:', err);
      if (!res.headersSent) sendError(res, 500);
    }
  });

  return wiki;
}
