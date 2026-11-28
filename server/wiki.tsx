import {execFile} from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as querystring from 'querystring';
import {promisify} from 'util';

import * as djot from '@djot/djot';
import hljs from 'highlight.js';
import katex from 'katex';
import polka from 'polka';
import * as yaml from 'yaml';

import * as db from '../db';
import {header, injectLiveBanner, renderErrorPage, renderer} from '../static/build';
import {Project} from '../static/projects';
import * as util from '../static/util';

import * as auth from './auth';

const execFileAsync = promisify(execFile);

const WIKI_DIR = process.env.MOCK === '1' ? util.root('.mock', 'wiki') : util.root('wiki');
const MAX_BODY_BYTES = 256 * 1024;

// Hardcoded site-wide wiki administrators (`auth.ADMINS`) and GitHub -> display-name overrides.
// Admins can edit any project wiki page regardless of project ownership; `AUTHORS` maps GitHub
// commit authors to their Smogon handle in revision history.
const ADMINS = auth.ADMINS;
const AUTHORS: Record<string, string> = {scheibo: 'pre'};
const ADMIN_USERS = new Set(ADMINS.map(a => a.toLowerCase()));
const AUTHOR_MAP = new Map(Object.entries(AUTHORS).map(([gh, name]) => [gh.toLowerCase(), name]));

const SHA_RE = /^[0-9a-f]{7,40}$/;
const PROJECTS_PREFIX = 'projects/';
const RESERVED_SLUGS = new Set(['pages', 'edit', 'history', 'projects']);

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
  auth?: auth.Auth;
  db?: db.Database;
  push?: boolean;
  now?: () => number;
}

export interface Revision {
  sha: string;
  shortSha: string;
  author: string;
  timestamp: number;
  subject: string;
  deleted?: boolean;
}

export interface RecentEdit extends Revision {
  slug: string;
  title: string;
  displayAuthor: string;
  pageHref: string;
  historyHref: string;
  revisionHref: string;
  diffHref: string;
}

function isProjectNamespace(slug: string): boolean {
  return slug.startsWith(PROJECTS_PREFIX);
}

function normalizeDecodedSegment(text: string): string {
  return text.normalize('NFC').trim().replace(/[\s_]+/g, '_');
}

function normalizeDecodedSlug(text: string): string {
  const trimmed = text.normalize('NFC').trim();
  const match = /^projects\/(.*)$/i.exec(trimmed);
  if (match) {
    const rest = normalizeDecodedSegment(match[1]);
    return rest ? `${PROJECTS_PREFIX}${rest}` : '';
  }
  return normalizeDecodedSegment(trimmed);
}

export function normalizeSlug(rawText: string): string {
  try {
    return normalizeDecodedSlug(decodeURIComponent(rawText));
  } catch {
    return '';
  }
}

function isValidSegment(seg: string, reserved?: ReadonlySet<string>): boolean {
  if (!seg || seg.length > 200) return false;
  if (seg.startsWith('.') || seg.includes('..')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[/\\<>:"|?*%\x00-\x1f\x7f]/.test(seg)) return false;
  return !reserved?.has(seg.toLowerCase());
}

export function isValidSlug(slug: string): boolean {
  if (isProjectNamespace(slug)) {
    return isValidSegment(slug.slice(PROJECTS_PREFIX.length));
  }
  return isValidSegment(slug, RESERVED_SLUGS);
}

export function formatTitle(slug: string): string {
  if (slug === 'index') return 'Wiki';
  const base = isProjectNamespace(slug) ? slug.slice(PROJECTS_PREFIX.length) : slug;
  const spaced = base.replace(/_/g, ' ');
  return spaced ? spaced[0].toUpperCase() + spaced.slice(1) : spaced;
}

export function encodeSlug(slug: string): string {
  if (isProjectNamespace(slug)) {
    return `${PROJECTS_PREFIX}${encodeURIComponent(slug.slice(PROJECTS_PREFIX.length))}`;
  }
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

function foldDiacritics(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function addProjectAliases(aliases: Map<string, string>, name: string, slug: string) {
  const addVariant = (variant: string) => {
    const seg = normalizeDecodedSegment(variant).toLowerCase();
    if (seg && !aliases.has(seg)) aliases.set(seg, slug);
    const arenaSlug = util.slugify(variant).toLowerCase();
    if (arenaSlug) {
      if (!aliases.has(arenaSlug)) aliases.set(arenaSlug, slug);
      const normArena = normalizeDecodedSegment(arenaSlug).toLowerCase();
      if (!aliases.has(normArena)) aliases.set(normArena, slug);
    }
    const idAlias = util.toID(variant);
    if (idAlias && !aliases.has(idAlias)) aliases.set(idAlias, slug);
  };
  addVariant(name);
  const folded = foldDiacritics(name);
  if (folded !== name) addVariant(folded);
}

export function extractProjectPages(projectsYaml: string): {
  projects: Map<string, ProjectPage>;
  aliases: Map<string, string>;
  reservedAliases: Map<string, string>;
} {
  const projects = new Map<string, ProjectPage>();
  const aliases = new Map<string, string>();
  const reservedAliases = new Map<string, string>();
  const entries = (yaml.parse(projectsYaml) ?? []) as Project[];
  if (!Array.isArray(entries)) return {projects, aliases, reservedAliases};
  for (const entry of entries) {
    const name = entry?.name?.trim();
    if (!name) continue;
    const segment = normalizeDecodedSegment(name);
    if (!isValidSegment(segment)) continue;
    const slug = `${PROJECTS_PREFIX}${segment}`;
    addProjectAliases(reservedAliases, name, slug);
    if (!entry.arena) continue;
    const owners = new Set<string>();
    if (entry.arena.owners && typeof entry.arena.owners === 'object') {
      for (const u of Object.keys(entry.arena.owners)) {
        const clean = u.trim().toLowerCase();
        if (clean) owners.add(clean);
      }
    }
    projects.set(slug, {slug, name, owners});
    addProjectAliases(aliases, name, slug);
  }
  return {projects, aliases, reservedAliases};
}

const STYLE = fs.readFileSync(util.root('static', 'style', 'wiki.css'), 'utf8');

function renderPageHtml(opts: {
  id?: string;
  title: string;
  heading: util.Html | string;
  path: string;
  nav?: util.Html | string;
  content: util.Html | string;
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

function wikiNav(
  slug: string,
  active?: 'view' | 'edit' | 'history' | 'pages',
  loggedIn = false,
  returnTo = '/wiki',
  showEdit = true
): util.Html {
  const item = (key: NonNullable<typeof active>, href: string, label: string) =>
    key === active ? <strong>{label}</strong> : <a href={href}>{label}</a>;
  const encoded = encodeSlug(slug);
  const viewHref = slug === 'index' ? '/wiki' : `/wiki/${encoded}`;
  return <nav id='wiki-nav'>
    {item('view', viewHref, 'View')}
    {showEdit && <>{' — '}{item('edit', `/wiki/${encoded}/edit`, 'Edit')}</>}
    {' — '}{item('history', `/wiki/${encoded}/history`, 'History')}
    {' — '}{item('pages', '/wiki/pages', 'Pages')}
    {loggedIn && <>
      {' — '}
      <form
        method='POST'
        action={`/auth/logout?return_to=${encodeURIComponent(returnTo)}`}
        className='inline-form'
      >
        <button type='submit' className='link-btn'>Logout</button>
      </form>
    </>}
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

const ALLOWED_IMAGE_HOSTS = new Map<string, RegExp | true>([
  ['avatars.githubusercontent.com', true],
  ['gist.githubusercontent.com', true],
  ['media.githubusercontent.com', true],
  ['private-user-images.githubusercontent.com', true],
  ['raw.githubusercontent.com', true],
  ['user-images.githubusercontent.com', true],
  ['github.com', /^\/(?:user-attachments|[^/]+\/[^/]+)\/assets\//],
]);

function resolveImageSrc(rawSrc: string | undefined): string | undefined {
  if (!rawSrc) return undefined;
  const trimmed = rawSrc.trim();
  if (!trimmed) return undefined;
  // eslint-disable-next-line no-control-regex
  const decoded = decodeHtmlEntities(trimmed).replace(/[\x00-\x20]+/g, '');
  if (!decoded || decoded.includes('\ufffd')) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' || parsed.port !== '' || parsed.username || parsed.password) {
    return undefined;
  }
  const rule = ALLOWED_IMAGE_HOSTS.get(parsed.hostname.toLowerCase());
  if (rule === true || rule?.test(parsed.pathname)) return parsed.href;
  return undefined;
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

const INLINE_MARKUP_RE = /[*_`[{$<~^"'-]|\\/;

// Scans lines outside fenced code blocks for the first level-1 ATX heading without parsing the
// entire document AST (only invoking `djot.parse` on that single heading line when it contains
// inline Djot markup).
function extractTopHeadingTitle(body: string): string | undefined {
  let fenceChar = '';
  let fenceLen = 0;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trimEnd();
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceMatch) {
      const ch = fenceMatch[1][0];
      const len = fenceMatch[1].length;
      if (!fenceChar) {
        if (ch === '~' || !fenceMatch[2].includes('`')) {
          fenceChar = ch;
          fenceLen = len;
        }
        continue;
      }
      if (ch === fenceChar && len >= fenceLen && fenceMatch[2].trim() === '') {
        fenceChar = '';
        fenceLen = 0;
      }
      continue;
    }
    if (fenceChar) continue;
    const h1 = /^ {0,3}# +(.+?)\s*$/.exec(line);
    if (!h1) continue;
    const headingText = h1[1];
    if (!INLINE_MARKUP_RE.test(headingText)) {
      return headingText.trim() || undefined;
    }
    try {
      const doc = djot.parse(`# ${headingText}`);
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
    return headingText.trim() || undefined;
  }
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

hljs.configure({classPrefix: 'hl-'});
// Avoid blocking the event loop synchronously on huge code blocks or `?diff=1` git diffs.
const MAX_HIGHLIGHT_CHARS = 64 * 1024;

function renderSafeCode(source: string, lang?: string): string {
  const trimmed = source.trimEnd();
  if (!lang || trimmed.length > MAX_HIGHLIGHT_CHARS) return util.escapeHtml(trimmed);
  if (lang === 'console') {
    let cont = false;
    return trimmed.split('\n').map(line => {
      if (cont) {
        cont = line.endsWith('\\');
        return util.escapeHtml(line);
      }
      if (line.startsWith('$ ')) {
        cont = line.endsWith('\\');
        const prompt = String(<span className='hl-title function_'>$</span>);
        return `${prompt} ${util.escapeHtml(line.slice(2))}`;
      }
      if (line.startsWith('#')) return String(<span className='hl-comment'>{line}</span>);
      return String(<span className='hl-output'>{line}</span>);
    }).join('\n');
  }
  if (!hljs.getLanguage(lang)) return util.escapeHtml(trimmed);
  try {
    return hljs.highlight(trimmed, {language: lang, ignoreIllegals: true}).value;
  } catch {
    return util.escapeHtml(trimmed);
  }
}

// Locked-down rich-text Djot AST renderer for user-authored wiki pages:
//   - Drops all raw HTML (`raw_block`, `raw_inline`) and non-allowlisted `<img>` tags at the AST
//   - Allows `<img>` only for `https://` GitHub user-attachment and `*.githubusercontent.com` URLs
//   - Supports `::: aside` and `{title="..."}` captions, ignoring all other `{...}` attributes
//   - Allows only `https://`, `http://`, `/...`, `#...`, and relative wiki links on `<a>`
//   - Escapes all text and syntax-highlighted code blocks with no post-hoc regex sanitizer
export function renderDjot(rawText: string, save?: {title?: string; summary?: string}): string {
  const {content} = parsePageContent(rawText);
  const doc = djot.parse(content);
  const usedIds = new Set<string>();
  const nextIdIndex = new Map<string, number>();
  const footnoteOrder: string[] = [];
  const footnoteIndex = new Map<string, number>();

  const uniqueHeadingId = (text: string): string | undefined => {
    const base = util.slugify(text).toLowerCase();
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

  const resolveNodeTarget = (node: djot.Link | djot.Image): string | undefined => {
    if (node.destination !== undefined) return node.destination;
    if (node.reference !== undefined) {
      const ref = doc.references[node.reference] ?? doc.autoReferences[node.reference];
      return ref?.destination;
    }
    return undefined;
  };

  const renderInlines = (nodes: djot.Inline[], depth = 0): string =>
    depth > MAX_AST_DEPTH ? '' : nodes.map(n => renderInline(n, depth)).join('');

  const renderInline = (node: djot.Inline, depth = 0): string => {
    if (depth > MAX_AST_DEPTH) return '';
    const nextDepth = depth + 1;
    switch (node.tag) {
      case 'str':
        return util.escapeHtml(node.text);
      case 'soft_break':
        return '\n';
      case 'hard_break':
        return '<br>\n';
      case 'non_breaking_space':
        return '&nbsp;';
      case 'smart_punctuation':
        return util.escapeHtml(SMART_PUNCTUATION[node.type] ?? node.text);
      case 'symb':
        return util.escapeHtml(`:${node.alias}:`);
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
        return util.escapeHtml(node.text);
      case 'footnote_reference': {
        if (!doc.footnotes[node.text]) return util.escapeHtml(`[^${node.text}]`);
        let idx = footnoteIndex.get(node.text);
        if (idx === undefined) {
          footnoteOrder.push(node.text);
          idx = footnoteOrder.length;
          footnoteIndex.set(node.text, idx);
        }
        return String(<sup id={`fnref-${idx}`}><a href={`#fn-${idx}`}>{`[${idx}]`}</a></sup>);
      }
      case 'emph':
        return String(<em>{util.raw(renderInlines(node.children, nextDepth))}</em>);
      case 'strong':
        return String(<strong>{util.raw(renderInlines(node.children, nextDepth))}</strong>);
      case 'link':
        return String(
          <a href={resolveWikiHref(resolveNodeTarget(node))}>
            {util.raw(renderInlines(node.children, nextDepth))}
          </a>
        );
      case 'image': {
        const src = resolveImageSrc(resolveNodeTarget(node));
        if (!src) return renderInlines(node.children, nextDepth);
        const alt = extractPlainText(node);
        return String(<img src={src} alt={alt} loading='lazy' referrerpolicy='no-referrer' />);
      }
      case 'span':
        return renderInlines(node.children, nextDepth);
      case 'mark':
        return String(<mark>{util.raw(renderInlines(node.children, nextDepth))}</mark>);
      case 'superscript':
        return String(<sup>{util.raw(renderInlines(node.children, nextDepth))}</sup>);
      case 'subscript':
        return String(<sub>{util.raw(renderInlines(node.children, nextDepth))}</sub>);
      case 'insert':
        return String(<ins>{util.raw(renderInlines(node.children, nextDepth))}</ins>);
      case 'delete':
        return String(<del>{util.raw(renderInlines(node.children, nextDepth))}</del>);
      case 'double_quoted':
        return `\u201c${renderInlines(node.children, nextDepth)}\u201d`;
      case 'single_quoted':
        return `\u2018${renderInlines(node.children, nextDepth)}\u2019`;
    }
  };

  const renderSafeTitle = (rawTitle: string | undefined, depth: number): string => {
    const trimmed = rawTitle?.trim();
    if (!trimmed || depth > MAX_AST_DEPTH) return '';
    const parsed = djot.parse(trimmed);
    const paras = parsed.children.filter((b): b is djot.Para => b.tag === 'para');
    if (paras.length !== parsed.children.length) return util.escapeHtml(trimmed);
    return paras.map(p => renderInlines(p.children, depth + 1)).join(' ').trim();
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
        return `${String(<p>{util.raw(renderInlines(node.children, nextDepth))}</p>)}\n`;
      case 'heading': {
        if (node.level === 1 && save && save.title === undefined) {
          save.title = extractPlainText(node).trim();
          return '';
        }
        const level = Math.min(6, Math.max(2, node.level));
        const inner = util.raw(renderInlines(node.children, nextDepth));
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
        return `${String(<section id={secId}>{util.raw(`\n${inner}`)}</section>)}\n`;
      }
      case 'div': {
        const classes = node.attributes?.class?.split(/\s+/) ?? [];
        if (classes.includes('aside')) {
          const title = renderSafeTitle(node.attributes?.title, nextDepth);
          const body = renderBlocks(node.children, undefined, nextDepth);
          return `${String(
            <aside>
              {title ? <div className='title'>{util.raw(title)}</div> : ''}
              {util.raw(`\n${body}`)}
            </aside>
          )}\n`;
        }
        return renderBlocks(node.children, undefined, nextDepth);
      }
      case 'code_block': {
        const title = renderSafeTitle(node.attributes?.title, nextDepth);
        return `${String(
          <figure className='code'>
            {title ? <figcaption className='title'>{util.raw(title)}</figcaption> : ''}
            <pre><code>{util.raw(renderSafeCode(node.text, node.lang))}</code></pre>
          </figure>
        )}\n`;
      }
      case 'raw_block':
        return '';
      case 'block_quote':
        return `${String(
          <figure className='blockquote'>
            <blockquote>
              {util.raw(`\n${renderBlocks(node.children, undefined, nextDepth)}`)}
            </blockquote>
          </figure>
        )}\n`;
      case 'bullet_list':
        return `${String(
          <ul>
            {util.raw(`\n${node.children.map(
              li => `${String(
                <li>{util.raw(renderListItemBlocks(li.children, node.tight, nextDepth))}</li>
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
            {util.raw(`\n${node.children.map(
              li => `${String(
                <li>{util.raw(renderListItemBlocks(li.children, node.tight, nextDepth))}</li>
              )}\n`
            ).join('')}`)}
          </ol>
        )}\n`;
      }
      case 'task_list':
        return `${String(
          <ul className='task-list'>
            {util.raw(`\n${node.children.map(li => {
              const checked = li.checkbox === 'checked';
              return `${String(
                <li>
                  <input type='checkbox' disabled={true} checked={checked} />{' '}
                  {util.raw(renderListItemBlocks(li.children, node.tight, nextDepth))}
                </li>
              )}\n`;
            }).join('')}`)}
          </ul>
        )}\n`;
      case 'definition_list':
        return `${String(
          <dl>
            {util.raw(`\n${node.children.map(item => {
              const dt = renderInlines(item.children[0].children, nextDepth);
              const dd = renderBlocks(item.children[1].children, undefined, nextDepth);
              return `${String(<dt>{util.raw(dt)}</dt>)}\n` +
                `${String(<dd>{util.raw(`\n${dd}`)}</dd>)}\n`;
            }).join('')}`)}
          </dl>
        )}\n`;
      case 'table': {
        const [caption, ...rows] = node.children;
        const captionHtml = caption.children.length
          ? `${String(<caption>{util.raw(renderInlines(caption.children, nextDepth))}</caption>)}\n`
          : '';
        const rowsHtml = rows.map(row => {
          const cells = row.children.map(cell => {
            const tag = cell.head ? 'th' : 'td';
            return String(h(tag, undefined, util.raw(renderInlines(cell.children, nextDepth))));
          }).join('');
          return `${String(<tr>{util.raw(cells)}</tr>)}\n`;
        }).join('');
        return `${String(<table>{util.raw(`\n${captionHtml}${rowsHtml}`)}</table>)}\n`;
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
            {util.raw(`\n${renderBlocks(fn.children)}`)}
            <p>
              <a href={`#fnref-${num}`} className='fn-back' aria-label='Back to reference'>
                <svg viewBox='0 0 24 24' aria-hidden='true'>
                  <path d='M9 8L4 13l5 5M4 13h11a5 5 0 0 0 0-10h-2' />
                </svg>
              </a>
            </p>
          </li>
        )}\n`
      );
    }
    if (items.length > 0) {
      html += `${String(
        <section className='footnotes'>
          <hr />
          {util.raw(`\n<ol>\n${items.join('')}</ol>`)}
        </section>
      )}\n`;
    }
  }
  return html;
}

function sendHtml(res: http.ServerResponse, status: number, html: string) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'private, no-store',
  });
  res.end(html);
}

function sendWikiHtml(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  html: string,
  isPublicCacheable: boolean
) {
  if (!isPublicCacheable) {
    sendHtml(res, 200, html);
    return;
  }
  const body = Buffer.from(html, 'utf8');
  const etag = `"${crypto.createHash('sha1').update(body).digest('hex')}"`;
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Vary', 'Cookie, Authorization');
  res.setHeader('ETag', etag);
  if (util.matchesIfNoneMatch(req.headers['if-none-match'], etag)) {
    res.statusCode = 304;
    res.end();
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(body);
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

export interface PageRecord {
  rawText: string;
  visibility?: PageVisibility;
  content: string;
}

export class Wiki {
  readonly wikiDir: string;
  readonly projectsFile: string;
  readonly auth: auth.Auth;
  readonly db?: db.Database;
  private readonly shouldPush: boolean;
  private readonly now?: () => number;
  private projectsMtime = -1;
  private authorizedUsers = new Set<string>();
  private projectPages = new Map<string, ProjectPage>();
  private projectAliases = new Map<string, string>();
  private reservedProjectAliases = new Map<string, string>();
  private deletedFilesToken?: string;
  private deletedFiles = new Set<string>();
  // Serializes git `add`/`commit` operations in-process so concurrent edits cannot collide on
  // `.git/index.lock` inside the backing wiki repository.
  private gitQueue: Promise<any> = Promise.resolve();
  private pushQueue: Promise<any> = Promise.resolve();

  constructor(options: Options = {}) {
    this.wikiDir = options.wikiDir ?? WIKI_DIR;
    this.projectsFile = options.projectsFile ?? db.PROJECTS_FILE;
    this.db = options.db;
    this.auth = options.auth ?? new auth.Auth({
      db: options.db,
      isAuthorizedGitHub: login => this.isDeveloper(login),
    });
    this.shouldPush = options.push ?? (process.env.NODE_ENV === 'production');
    this.now = options.now;
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
    let extracted: {
      projects: Map<string, ProjectPage>;
      aliases: Map<string, string>;
      reservedAliases: Map<string, string>;
    };
    try {
      authorizedUsers = extractAuthorizedGitHubUsers(projectsRaw, ADMINS);
      extracted = extractProjectPages(projectsRaw);
    } catch (err) {
      console.error('Failed parsing projects.yml for wiki metadata:', err);
      if (this.projectsMtime !== -1) return;
      authorizedUsers = new Set(ADMIN_USERS);
      extracted = {projects: new Map(), aliases: new Map(), reservedAliases: new Map()};
    }

    this.authorizedUsers = authorizedUsers;
    this.projectPages = extracted.projects;
    this.projectAliases = extracted.aliases;
    this.reservedProjectAliases = extracted.reservedAliases;
    this.projectsMtime = pMtime;
  }

  formatAuthor(githubLogin: string): string {
    return AUTHOR_MAP.get(githubLogin.toLowerCase()) ?? githubLogin;
  }

  resolveSlug(slug: string, alreadyDecoded = false): string {
    this.refreshMetadata();
    const normalized = alreadyDecoded ? normalizeDecodedSlug(slug) : normalizeSlug(slug);
    if (isProjectNamespace(normalized)) {
      const tail = normalized.slice(PROJECTS_PREFIX.length);
      return this.projectAliases.get(tail.toLowerCase()) ?? normalized;
    }
    if (normalized.toLowerCase() === 'index') return 'index';
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
    if (normalized) {
      const lower = normalized.toLowerCase();
      const reserved = this.projectAliases.get(lower) ?? this.reservedProjectAliases.get(lower);
      if (reserved) return reserved;
    }
    return normalized;
  }

  getProjectPage(slug: string): ProjectPage | undefined {
    this.refreshMetadata();
    const canonical = this.resolveSlug(slug);
    return isProjectNamespace(canonical) ? this.projectPages.get(canonical) : undefined;
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

  isDeveloper(login: string | undefined): boolean {
    if (!login) return false;
    this.refreshMetadata();
    const lower = login.toLowerCase();
    if (ADMIN_USERS.has(lower)) return true;
    if (!this.authorizedUsers.has(lower)) return false;
    return !this.isBlockedInDb(lower);
  }

  private readCanonicalRecord(canonical: string): PageRecord | undefined {
    const file = path.join(this.wikiDir, `${canonical}.dj`);
    let rawText: string;
    try {
      rawText = fs.readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
    const parsed = parsePageContent(rawText);
    return {rawText, visibility: parsed.visibility, content: parsed.content};
  }

  resolveVisibility(slug: string, rawVis?: PageVisibility): PageVisibility {
    const isProject = this.isProjectPage(slug);
    if (isProject) return rawVis ?? 'developers';
    if (rawVis === 'developers' || rawVis === 'discord') return rawVis;
    return 'public';
  }

  getPageVisibility(slug: string): PageVisibility {
    const canonical = this.resolveSlug(slug);
    const record = isValidSlug(canonical) ? this.readCanonicalRecord(canonical) : undefined;
    return this.resolveVisibility(canonical, record?.visibility);
  }

  getVisibleProjectWikiHref(agentName: string, req?: http.IncomingMessage): string | undefined {
    const canonical = this.resolveSlug(`${PROJECTS_PREFIX}${agentName}`, true);
    if (!isProjectNamespace(canonical) || !this.projectPages.has(canonical)) return undefined;
    const record = this.readCanonicalRecord(canonical);
    if (!record) return undefined;
    const vis: PageVisibility = record.visibility ?? 'developers';
    if (vis !== 'public') {
      if (!req) return undefined;
      const login = this.getSessionUser(req);
      const isDev = this.isDeveloper(login);
      if (vis === 'developers' && !isDev) return undefined;
      if (vis === 'discord' && !isDev && this.verifyDiscordAuth(req) !== 'authorized') {
        return undefined;
      }
    }
    return `/wiki/${encodeSlug(canonical)}`;
  }

  canEdit(login: string | undefined, slug?: string): boolean {
    if (!login) return false;
    this.refreshMetadata();
    const lower = login.toLowerCase();
    if (slug) {
      const canonical = this.resolveSlug(slug);
      if (canonical === 'index') return ADMIN_USERS.has(lower);
      if (isProjectNamespace(canonical)) {
        const project = this.projectPages.get(canonical);
        if (!project) return false;
        if (ADMIN_USERS.has(lower)) return true;
        if (this.isBlockedInDb(lower)) return false;
        return project.owners.has(lower);
      }
    }
    if (ADMIN_USERS.has(lower)) return true;
    if (this.isBlockedInDb(lower)) return false;
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

  readPageRecord(slug: string): PageRecord | undefined {
    const canonical = this.resolveSlug(slug);
    if (!isValidSlug(canonical)) throw new Error(`Invalid slug: ${slug}`);
    return this.readCanonicalRecord(canonical);
  }

  readRawPage(slug: string): string | undefined {
    return this.readPageRecord(slug)?.rawText;
  }

  readPage(slug: string): string | undefined {
    return this.readPageRecord(slug)?.content;
  }

  getContentFingerprint(slug: string): string {
    const rawText = this.readRawPage(slug);
    if (rawText === undefined) return 'new';
    return crypto.createHash('sha256').update(rawText).digest('hex').slice(0, 16);
  }

  listPages(): string[] {
    if (!fs.existsSync(this.wikiDir)) return [];
    const general = fs.readdirSync(this.wikiDir)
      .filter(f => f.endsWith('.dj'))
      .map(f => f.slice(0, -3))
      .filter(s => isValidSegment(s, RESERVED_SLUGS))
      .sort((a, b) => a.localeCompare(b));
    const projectsDir = path.join(this.wikiDir, 'projects');
    const projects = fs.existsSync(projectsDir)
      ? fs.readdirSync(projectsDir)
        .filter(f => f.endsWith('.dj'))
        .map(f => `${PROJECTS_PREFIX}${f.slice(0, -3)}`)
        .filter(isValidSlug)
        .sort((a, b) => a.localeCompare(b))
      : [];
    return [...general, ...projects];
  }

  listPageSummaries(): Array<{
    slug: string;
    title: string;
    visibility: PageVisibility;
    project: boolean;
  }> {
    this.refreshMetadata();
    const summaries: Array<{
      slug: string;
      title: string;
      visibility: PageVisibility;
      project: boolean;
    }> = [];
    for (const slug of this.listPages()) {
      const inProjects = isProjectNamespace(slug);
      const project = inProjects ? this.projectPages.get(slug) : undefined;
      if (inProjects && !project) continue;
      const record = this.readCanonicalRecord(slug);
      const visibility: PageVisibility = project
        ? (record?.visibility ?? 'developers')
        : (record?.visibility === 'developers' || record?.visibility === 'discord'
          ? record.visibility
          : 'public');
      const heading = record?.content ? extractTopHeadingTitle(record.content) : undefined;
      const title = heading || project?.name || formatTitle(slug);
      summaries.push({slug, title, visibility, project: Boolean(project)});
    }
    return summaries;
  }

  private enqueueGit<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.gitQueue.then(fn, fn);
    this.gitQueue = next.catch(() => undefined);
    return next;
  }

  private schedulePush() {
    if (!this.shouldPush) return;
    // Push asynchronously via a serialized queue so wiki saves redirect immediately once
    // the local commit succeeds instead of blocking the HTTP response on GitHub network RTT.
    this.pushQueue = this.pushQueue.then(
      () => execFileAsync('git', ['push', 'origin', 'HEAD'], {
        cwd: this.wikiDir,
        timeout: 30_000,
      }).catch(err => {
        console.error('Error pushing wiki commit:', err);
      })
    );
  }

  private gitCommitMeta(author: string, message: string | undefined, defaultMsg: string) {
    // eslint-disable-next-line no-control-regex
    const cleanMessage = message?.replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
    const summary = cleanMessage || defaultMsg;
    // eslint-disable-next-line no-control-regex
    const safeAuthor = author.replace(/[\x00-\x1f\x7f<>"]/g, '').trim() || 'wiki';
    const gitAuthor = `${safeAuthor} <${safeAuthor}@users.noreply.github.com>`;
    const isoDate = this.now ? new Date(this.now() * 1000).toISOString() : undefined;
    const env = isoDate
      ? {...process.env, GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate}
      : undefined;
    return {summary, gitAuthor, env};
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
    if (isProjectNamespace(canonical) && !isProject) {
      throw new Error(`Unknown project wiki page: ${canonical}`);
    }
    const vis = isProject
      ? (visibility && VISIBILITIES.has(visibility)
        ? visibility
        : this.getPageVisibility(canonical))
      : undefined;
    const content = serializePageContent(rawContent, vis);

    return this.enqueueGit(async () => {
      const file = path.join(this.wikiDir, `${canonical}.dj`);
      fs.mkdirSync(path.dirname(file), {recursive: true});
      const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
      if (prev === content) return false;

      const rel = `${canonical}.dj`;
      const literalRel = `:(literal)${rel}`;
      const defaultMsg = prev === undefined ? `Create ${canonical}` : `Update ${canonical}`;
      const {summary, gitAuthor, env} = this.gitCommitMeta(author, message, defaultMsg);

      fs.writeFileSync(file, content, 'utf8');
      try {
        await execFileAsync('git', ['add', '--', literalRel], {
          cwd: this.wikiDir,
          env,
          timeout: 15_000,
        });
        await execFileAsync(
          'git',
          [
            '-c', 'user.name=pkmn.ai',
            '-c', 'user.email=wiki@pkmn.ai',
            '-c', 'commit.gpgsign=false',
            'commit',
            `--author=${gitAuthor}`,
            '-m', summary,
            '--', literalRel,
          ],
          {cwd: this.wikiDir, env, timeout: 15_000}
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

      this.schedulePush();
      return true;
    });
  }

  async deletePage(slug: string, author: string, message?: string): Promise<boolean> {
    const canonical = this.resolveSlug(slug);
    if (!isValidSlug(canonical)) throw new Error(`Invalid slug: ${slug}`);
    if (canonical === 'index') throw new Error('Cannot delete protected wiki page: index');
    if (isProjectNamespace(canonical) && !this.isProjectPage(canonical)) {
      throw new Error(`Unknown project wiki page: ${canonical}`);
    }

    return this.enqueueGit(async () => {
      const file = path.join(this.wikiDir, `${canonical}.dj`);
      if (!fs.existsSync(file)) return false;
      const prev = fs.readFileSync(file, 'utf8');

      const rel = `${canonical}.dj`;
      const literalRel = `:(literal)${rel}`;
      const {summary, gitAuthor, env} = this.gitCommitMeta(author, message, `Delete ${canonical}`);

      try {
        await execFileAsync('git', ['rm', '-f', '--', literalRel], {
          cwd: this.wikiDir,
          env,
          timeout: 15_000,
        });
        await execFileAsync(
          'git',
          [
            '-c', 'user.name=pkmn.ai',
            '-c', 'user.email=wiki@pkmn.ai',
            '-c', 'commit.gpgsign=false',
            'commit',
            `--author=${gitAuthor}`,
            '-m', summary,
            '--', literalRel,
          ],
          {cwd: this.wikiDir, env, timeout: 15_000}
        );
      } catch (err) {
        try {
          fs.mkdirSync(path.dirname(file), {recursive: true});
          fs.writeFileSync(file, prev, 'utf8');
          await execFileAsync('git', ['reset', '--mixed', '-q', '--', literalRel], {
            cwd: this.wikiDir,
            timeout: 5_000,
          });
        } catch {}
        throw err;
      }

      this.schedulePush();
      return true;
    });
  }

  private readGitHeadToken(): string | undefined {
    try {
      const gitDir = path.join(this.wikiDir, '.git');
      const reftableList = path.join(gitDir, 'reftable', 'tables.list');
      if (fs.existsSync(reftableList)) {
        return fs.readFileSync(reftableList, 'utf8').trim() || undefined;
      }
      const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
      if (!head.startsWith('ref:')) return head || undefined;
      const ref = head.slice(4).trim();
      const loosePath = path.join(gitDir, ref);
      if (fs.existsSync(loosePath)) {
        return fs.readFileSync(loosePath, 'utf8').trim() || undefined;
      }
      const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
      for (const line of packed.split('\n')) {
        if (line.startsWith('#') || line.startsWith('^')) continue;
        const space = line.indexOf(' ');
        if (space > 0 && line.slice(space + 1).trim() === ref) {
          return line.slice(0, space);
        }
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  // Keyed on the current git ref state (`reftable/tables.list` or `HEAD`/ref SHA) so requests to
  // `/wiki/<random>/history` for never-created pages avoid spawning `git log` per request while
  // still serving history for deleted pages.
  private async hasDeletedHistory(relPath: string): Promise<boolean> {
    if (!fs.existsSync(path.join(this.wikiDir, '.git'))) return false;
    const token = this.readGitHeadToken();
    if (!token) return true;
    if (token !== this.deletedFilesToken) {
      try {
        const {stdout} = await execFileAsync(
          'git',
          ['log', '--no-renames', '--diff-filter=D', '--name-only', '--pretty=format:', '-z'],
          {cwd: this.wikiDir, timeout: 15_000}
        );
        const files = new Set<string>();
        for (const entry of stdout.split('\0')) {
          if (entry.endsWith('.dj')) files.add(entry);
        }
        this.deletedFiles = files;
        this.deletedFilesToken = token;
      } catch {
        return false;
      }
    }
    return this.deletedFiles.has(relPath);
  }

  async getHistory(slug: string): Promise<Revision[]> {
    const canonical = this.resolveSlug(slug);
    if (!isValidSlug(canonical)) return [];
    const relPath = `${canonical}.dj`;
    const file = path.join(this.wikiDir, relPath);
    if (!fs.existsSync(file) && !(await this.hasDeletedHistory(relPath))) {
      return [];
    }
    try {
      const {stdout} = await execFileAsync(
        'git',
        [
          'log',
          '--no-renames',
          '--name-status',
          '--format=%x1e%H%x09%h%x09%an%x09%at%x09%s',
          '--',
          `:(literal)${canonical}.dj`,
        ],
        {cwd: this.wikiDir, timeout: 15_000}
      );
      const revisions: Revision[] = [];
      for (const block of stdout.split('\x1e')) {
        const lines = block.split('\n').filter(Boolean);
        if (!lines.length) continue;
        const [sha, shortSha, author, ts, ...rest] = lines[0].split('\t');
        const deleted = lines.slice(1).some(l => l.startsWith('D\t'));
        revisions.push({
          sha,
          shortSha,
          author,
          timestamp: Number(ts),
          subject: rest.join('\t'),
          ...(deleted ? {deleted: true} : {}),
        });
      }
      return revisions;
    } catch {
      return [];
    }
  }

  async getRecentEditsPage(
    limit = util.TABLE_PAGE_SIZE,
    offset = 0
  ): Promise<{edits: RecentEdit[]; total: number}> {
    if (limit <= 0 || offset < 0 || !fs.existsSync(this.wikiDir)) return {edits: [], total: 0};
    this.refreshMetadata();
    try {
      const {stdout} = await execFileAsync(
        'git',
        [
          '-c',
          'core.quotePath=false',
          'log',
          '--no-renames',
          '--name-status',
          '--format=%x1e%H%x09%h%x09%an%x09%at%x09%s',
          '--',
          '*.dj',
        ],
        {cwd: this.wikiDir, timeout: 15_000, maxBuffer: 16 * 1024 * 1024}
      );
      const edits: RecentEdit[] = [];
      let total = 0;
      const end = offset + limit;
      for (const block of stdout.split('\x1e')) {
        const lines = block.split('\n').filter(Boolean);
        if (lines.length < 2) continue;
        let commit: {
          sha: string;
          shortSha: string;
          author: string;
          timestamp: number;
          subject: string;
          displayAuthor: string;
        } | undefined;
        for (const fileLine of lines.slice(1)) {
          const tab = fileLine.indexOf('\t');
          if (tab < 0) continue;
          const relPath = fileLine.slice(tab + 1).trim();
          if (!relPath.endsWith('.dj')) continue;
          const slug = relPath.slice(0, -3);
          if (!isValidSlug(slug)) continue;
          const idx = total++;
          if (idx < offset || idx >= end) continue;
          if (!commit) {
            const [sha, shortSha, author, ts, ...rest] = lines[0].split('\t');
            commit = {
              sha,
              shortSha,
              author,
              timestamp: Number(ts),
              subject: rest.join('\t'),
              displayAuthor: this.formatAuthor(author),
            };
          }
          const status = fileLine.slice(0, tab);
          const encoded = encodeSlug(slug);
          const revisionHref = `/wiki/${encoded}/${commit.sha}`;
          const deleted = status === 'D';
          edits.push({
            sha: commit.sha,
            shortSha: commit.shortSha,
            author: commit.author,
            displayAuthor: commit.displayAuthor,
            timestamp: commit.timestamp,
            subject: commit.subject,
            ...(deleted ? {deleted: true} : {}),
            slug,
            title: this.projectPages.get(slug)?.name ?? formatTitle(slug),
            pageHref: slug === 'index' ? '/wiki' : `/wiki/${encoded}`,
            historyHref: `/wiki/${encoded}/history`,
            revisionHref,
            diffHref: `${revisionHref}?diff=1`,
          });
        }
      }
      return {edits, total};
    } catch {
      return {edits: [], total: 0};
    }
  }

  async getRecentEdits(limit = util.TABLE_PAGE_SIZE): Promise<RecentEdit[]> {
    return (await this.getRecentEditsPage(limit, 0)).edits;
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

  async getRevisionDiff(slug: string, sha: string): Promise<string | undefined> {
    const canonical = this.resolveSlug(slug);
    if (!isValidSlug(canonical) || !SHA_RE.test(sha)) return undefined;
    try {
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

export function register(app: polka.Polka, wiki: Wiki): Wiki {
  util.installHeadSupport(app);
  const getLiveTournament = () => wiki.db?.getRunningTournament();
  const renderPage = (opts: Omit<Parameters<typeof renderPageHtml>[0], 'liveTournament'>) =>
    renderPageHtml({...opts, liveTournament: getLiveTournament()});
  const sendError = (res: http.ServerResponse, status: number) =>
    sendHtml(res, status, renderErrorPage(status, getLiveTournament()));

  const generalSlugParam = (v: string | string[] | undefined): string => {
    if (typeof v !== 'string') return '';
    let decoded: string;
    try {
      decoded = decodeURIComponent(v);
    } catch {
      return '';
    }
    const normalized = normalizeDecodedSegment(decoded);
    return isValidSegment(normalized, RESERVED_SLUGS) ? normalized : '';
  };

  const projectSlugParam = (v: string | string[] | undefined): string => {
    if (typeof v !== 'string') return '';
    let decoded: string;
    try {
      decoded = decodeURIComponent(v);
    } catch {
      return '';
    }
    const normalized = normalizeDecodedSegment(decoded);
    return isValidSegment(normalized) ? `${PROJECTS_PREFIX}${normalized}` : '';
  };

  const getEffectiveUser = (req: http.IncomingMessage): string | undefined =>
    wiki.auth.getGitHubUser(req);

  // Logged-in users only see `Edit` when `canEdit` permits it; logged-out visitors see `Edit` on
  // general/project pages (to trigger OAuth login) but not on the admin-locked `index` home page.
  const canShowEdit = (slug: string, req: http.IncomingMessage, loggedIn: boolean): boolean => (
    loggedIn ? wiki.canEdit(getEffectiveUser(req), slug) : slug !== 'index'
  );

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
    if (isProjectNamespace(canonical) && !wiki.isProjectPage(canonical)) {
      sendError(res, 404);
      return undefined;
    }
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

  // Redirect logout to public `/wiki` whenever the current page/revision requires auth,
  // avoiding an immediate `requireReadAuth` -> `/auth/github` silent OAuth re-login loop.
  const logoutReturnTo = (candidate: string, visibility: PageVisibility): string => (
    visibility === 'public' ? candidate : '/wiki'
  );

  const requireReadAuth = (
    req: http.IncomingMessage & {originalUrl?: string},
    res: http.ServerResponse,
    visibility: PageVisibility
  ): boolean => {
    if (visibility === 'public') return true;

    const authCfg = wiki.auth.getConfig();
    const devAuth = wiki.auth.isDevAuthEnabled();

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
    if (!authCfg?.github && !devAuth) {
      sendError(res, 503);
      return undefined;
    }
    const login = wiki.getSessionUser(req);
    if (!login) {
      const returnTo = encodeURIComponent(req.originalUrl || req.url || '/wiki');
      redirect(res, `/auth/github?return_to=${returnTo}`);
      return undefined;
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
    // Read the backing `.dj` file once and reuse its parsed visibility and body throughout.
    const record = wiki.readPageRecord(slug);
    const vis = wiki.resolveVisibility(slug, record?.visibility);
    if (!requireReadAuth(req, res, vis)) return;

    const encoded = encodeSlug(slug);
    if (!record) {
      if (wiki.isProjectPage(slug) && !wiki.canEdit(getEffectiveUser(req), slug)) {
        sendError(res, 404);
        return;
      }
      redirect(res, `/wiki/${encoded}/edit`);
      return;
    }
    const meta: {title?: string; summary?: string} = {};
    const renderedHtml = renderDjot(record.content, meta);
    const projectPage = wiki.getProjectPage(slug);
    const titleText = meta.title ?? projectPage?.name ?? formatTitle(slug);
    let heading: util.Html | string = titleText;
    if (projectPage) {
      const profileSlug = util.slugify(projectPage.name).toLowerCase();
      const agent = wiki.db?.getAgentBySlug(profileSlug);
      if (profileSlug && (!wiki.db || (agent && agent.status !== 'disabled'))) {
        heading = (
          <a href={`/projects/${encodeURIComponent(profileSlug)}/`} className='subtle'>
            {titleText}
          </a>
        );
      }
    }
    const viewPath = slug === 'index' ? '/wiki' : `/wiki/${encoded}`;
    const loggedIn = Boolean(getEffectiveUser(req) || wiki.auth.getSession(req));
    const isPublic = vis === 'public' && !loggedIn;
    sendWikiHtml(req, res, renderPage({
      title: titleText,
      heading,
      path: slug === 'index' ? '/wiki/' : `/wiki/${encoded}/`,
      nav: wikiNav(
        slug,
        'view',
        loggedIn,
        logoutReturnTo(viewPath, vis),
        canShowEdit(slug, req, loggedIn)
      ),
      content: util.raw(renderedHtml),
    }), isPublic);
  };

  app.get('/wiki', (req, res) => renderPageSlug(req, res, 'index'));

  const getVisibleSummaries = (req: http.IncomingMessage) => {
    const summaries = wiki.listPageSummaries();
    const login = getEffectiveUser(req);
    const isDev = wiki.isDeveloper(login);
    const needsDiscordCheck = !isDev && summaries.some(p => p.visibility === 'discord');
    const isDiscord = needsDiscordCheck && wiki.verifyDiscordAuth(req) === 'authorized';
    const visible = summaries.filter(p => (
      p.visibility === 'public' ||
      isDev ||
      (p.visibility === 'discord' && isDiscord)
    ));
    const loggedIn = Boolean(login || wiki.auth.getSession(req));
    const isPublic = !loggedIn && !isDev && !isDiscord;
    return {visible, loggedIn, isPublic};
  };

  app.get('/wiki/pages', (req, res) => {
    const {visible, loggedIn, isPublic} = getVisibleSummaries(req);
    const generalPages = visible.filter(p => !p.project);
    const projectPages = visible.filter(p => p.project);
    sendWikiHtml(req, res, renderPage({
      title: 'Pages — Wiki',
      heading: 'Pages',
      path: '/wiki/pages/',
      nav: wikiNav('index', 'pages', loggedIn, '/wiki/pages', false),
      content: visible.length ? (
        <>
          {generalPages.length > 0 && (
            <ul id='wiki-pages'>
              {generalPages.map(p => {
                const href = p.slug === 'index' ? '/wiki' : `/wiki/${encodeSlug(p.slug)}`;
                return <li><a href={href}>{p.title}</a></li>;
              })}
            </ul>
          )}
          {projectPages.length > 0 && (
            <section id='projects'>
              <h2><a href='/wiki/projects' className='subtle'>Projects</a></h2>
              <ul id='wiki-project-pages'>
                {projectPages.map(p => (
                  <li><a href={`/wiki/${encodeSlug(p.slug)}`}>{p.title}</a></li>
                ))}
              </ul>
            </section>
          )}
        </>
      ) : (
        <p>No pages yet.</p>
      ),
    }), isPublic);
  });

  app.get('/wiki/projects', (req, res) => {
    const {visible, loggedIn, isPublic} = getVisibleSummaries(req);
    const projectPages = visible.filter(p => p.project);
    sendWikiHtml(req, res, renderPage({
      title: 'Projects — Wiki',
      heading: 'Projects',
      path: '/wiki/projects/',
      nav: wikiNav('index', undefined, loggedIn, '/wiki/projects', false),
      content: projectPages.length ? (
        <ul id='wiki-pages'>
          {projectPages.map(p => (
            <li><a href={`/wiki/${encodeSlug(p.slug)}`}>{p.title}</a></li>
          ))}
        </ul>
      ) : (
        <p>No project pages yet.</p>
      ),
    }), isPublic);
  });

  interface EditorViewOptions {
    slug: string;
    content: string;
    message?: string;
    visibility?: PageVisibility;
    previewHtml?: string;
    baseSha?: string;
    statusCode?: number;
  }

  const renderEditor = (res: http.ServerResponse, opts: EditorViewOptions) => {
    const {
      slug,
      content,
      message = '',
      visibility,
      previewHtml,
      baseSha = wiki.getContentFingerprint(slug),
      statusCode = 200,
    } = opts;
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
        {previewHtml !== undefined && <section id='wiki-preview'>{util.raw(previewHtml)}</section>}
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
    const viewPath = slug === 'index' ? '/wiki' : `/wiki/${encoded}`;
    const existingRecord = wiki.readPageRecord(slug);
    const returnTo = existingRecord !== undefined
      ? logoutReturnTo(
        viewPath,
        stricterVisibility(wiki.resolveVisibility(slug, existingRecord.visibility), visibility)
      )
      : '/wiki';
    sendHtml(res, statusCode, renderPage({
      title: heading,
      heading,
      path: `/wiki/${encoded}/edit/`,
      nav: wikiNav(slug, 'edit', true, returnTo),
      content: form,
    }));
  };

  const renderEditSlug = (
    req: http.IncomingMessage & {originalUrl?: string},
    res: http.ServerResponse,
    rawSlug: string
  ) => {
    const slug = resolveOrRedirect(res, rawSlug, '/edit');
    if (!slug) return;
    if (!requireEditAuth(req, res, slug)) return;
    const existing = wiki.readPage(slug) ?? '';
    const visibility = wiki.isProjectPage(slug) ? wiki.getPageVisibility(slug) : undefined;
    renderEditor(res, {slug, content: existing, visibility});
  };

  const handlePostSlug = async (
    req: http.IncomingMessage & {originalUrl?: string},
    res: http.ServerResponse,
    rawSlug: string
  ) => {
    if (auth.isCrossSiteRequest(req)) {
      sendError(res, 403);
      return;
    }
    if (!isValidSlug(rawSlug)) {
      sendError(res, 404);
      return;
    }
    const slug = wiki.resolveSlug(rawSlug, true);
    if (!isValidSlug(slug) || (isProjectNamespace(slug) && !wiki.isProjectPage(slug))) {
      sendError(res, 404);
      return;
    }
    const login = requireEditAuth(req, res, slug);
    if (!login) return;
    try {
      const body = await util.readBody(req, MAX_BODY_BYTES, 'Payload Too Large');
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

      const isEmpty = parsePageContent(content).content.trim() === '';

      if (action === 'preview') {
        let previewHtml: string;
        if (isEmpty && slug === 'index') {
          previewHtml = String(<p className='no'>The wiki home page cannot be deleted.</p>);
        } else if (isEmpty && wiki.readPageRecord(slug) !== undefined) {
          previewHtml = String(
            <p className='wiki-meta'>Saving empty content will delete this page.</p>
          );
        } else {
          previewHtml = renderDjot(content, {});
        }
        renderEditor(res, {
          slug,
          content,
          message,
          visibility,
          previewHtml,
          baseSha: baseSha || wiki.getContentFingerprint(slug),
        });
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
        renderEditor(res, {
          slug,
          content,
          message,
          visibility,
          previewHtml,
          baseSha: currentFingerprint,
          statusCode: 409,
        });
        return;
      }

      if (isEmpty) {
        if (slug === 'index') {
          renderEditor(res, {
            slug,
            content,
            message,
            visibility,
            previewHtml: String(<p className='no'>The wiki home page cannot be deleted.</p>),
            baseSha: currentFingerprint,
            statusCode: 400,
          });
          return;
        }
        await wiki.deletePage(slug, login, message);
        redirect(res, '/wiki/pages', 303);
        return;
      }

      await wiki.savePage(slug, content, login, message, visibility);
      redirect(res, slug === 'index' ? '/wiki' : `/wiki/${encodeSlug(slug)}`, 303);
    } catch (err: any) {
      const status = err?.status ?? 500;
      console.error('Error saving wiki page:', err);
      sendError(res, status);
    }
  };

  const handleHistorySlug = async (
    req: http.IncomingMessage & {originalUrl?: string},
    res: http.ServerResponse,
    rawSlug: string
  ) => {
    try {
      const slug = resolveOrRedirect(res, rawSlug, '/history');
      if (!slug) return;
      const currentVis = wiki.getPageVisibility(slug);
      if (!requireReadAuth(req, res, currentVis)) return;
      const encoded = encodeSlug(slug);
      const revisions = await wiki.getHistory(slug);
      const table = revisions.length ? (
        <>
          <util.PaginatedTable
            head={(
              <tr>
                <th>Date</th>
                <th>Revision</th>
                <th>Author</th>
                <th>Summary</th>
              </tr>
            )}
            pager={{
              id: 'wiki-history-pager',
              label: 'Revision history pagination',
              total: revisions.length,
              singular: 'revision',
              plural: 'revisions',
            }}
          >
            {revisions.map((rev, idx) => {
              const revUrl = `/wiki/${encoded}/${rev.sha}`;
              const ghUrl = `https://github.com/${encodeURIComponent(rev.author)}`;
              const displayAuthor = wiki.formatAuthor(rev.author);
              return (
                <tr className={idx >= util.TABLE_PAGE_SIZE ? 'hide' : undefined}>
                  <td className='wiki-meta'>
                    <util.Time epoch={rev.timestamp} format='date' />
                  </td>
                  <td>
                    {rev.deleted
                      ? <code>{rev.shortSha}</code>
                      : <code><a href={revUrl}>{rev.shortSha}</a></code>}{' '}
                    (<a href={`${revUrl}?diff=1`}>diff</a>)
                  </td>
                  <td>
                    <a href={ghUrl} className='subtle'>{displayAuthor}</a>
                  </td>
                  <td>{rev.subject}</td>
                </tr>
              );
            })}
          </util.PaginatedTable>
          <script>
            {`document.addEventListener('DOMContentLoaded', () => {${util.TABLE_PAGER_SCRIPT}});`}
          </script>
        </>
      ) : (
        <p>No history for this page yet.</p>
      );
      const displayTitle = wiki.getProjectPage(slug)?.name ?? formatTitle(slug);
      const heading = `History — ${displayTitle}`;
      const loggedIn = Boolean(getEffectiveUser(req) || wiki.auth.getSession(req));
      const isPublic = currentVis === 'public' && !loggedIn;
      sendWikiHtml(req, res, renderPage({
        title: heading,
        heading,
        path: `/wiki/${encoded}/history/`,
        nav: wikiNav(
          slug,
          'history',
          loggedIn,
          logoutReturnTo(`/wiki/${encoded}/history`, currentVis),
          canShowEdit(slug, req, loggedIn)
        ),
        content: table,
      }), isPublic);
    } catch (err) {
      console.error('Error rendering wiki history:', err);
      if (!res.headersSent) sendError(res, 500);
    }
  };

  const handleRevisionSlug = async (
    req: http.IncomingMessage & {originalUrl?: string; query: Record<string, unknown>},
    res: http.ServerResponse,
    rawSlug: string,
    rawSha: string | string[] | undefined
  ) => {
    try {
      const sha = typeof rawSha === 'string' ? rawSha : '';
      if (!isValidSlug(rawSlug) || !SHA_RE.test(sha)) {
        sendError(res, 404);
        return;
      }
      const showDiff = req.query.diff === '1';
      const slug = resolveOrRedirect(res, rawSlug, `/${sha}${showDiff ? '?diff=1' : ''}`);
      if (!slug) return;
      const currentVis = wiki.getPageVisibility(slug);
      if (!requireReadAuth(req, res, currentVis)) return;

      const isProject = wiki.isProjectPage(slug);
      const encoded = encodeSlug(slug);
      const displayTitle = wiki.getProjectPage(slug)?.name ?? formatTitle(slug);
      if (showDiff) {
        const [revRecord, parentRecord, diff] = await Promise.all([
          wiki.getRevisionRecord(slug, sha),
          wiki.getRevisionRecord(slug, sha, true),
          wiki.getRevisionDiff(slug, sha),
        ]);
        const revVis: PageVisibility | undefined = revRecord
          ? (isProject
            ? (revRecord.visibility ?? 'developers')
            : (revRecord.visibility === 'developers' || revRecord.visibility === 'discord'
              ? revRecord.visibility
              : undefined))
          : undefined;
        const parentVis: PageVisibility | undefined = parentRecord
          ? (isProject
            ? (parentRecord.visibility ?? 'developers')
            : (parentRecord.visibility === 'developers' || parentRecord.visibility === 'discord'
              ? parentRecord.visibility
              : undefined))
          : undefined;
        const diffVis = stricterVisibility(revVis ?? 'public', parentVis);
        const effectiveVis = stricterVisibility(currentVis, diffVis);
        if (!requireReadAuth(req, res, effectiveVis)) return;

        if (diff === undefined) {
          sendError(res, 404);
          return;
        }
        const heading = `${displayTitle} @ ${sha.slice(0, 7)}`;
        const loggedIn = Boolean(getEffectiveUser(req) || wiki.auth.getSession(req));
        const isPublic = effectiveVis === 'public' && !loggedIn;
        sendWikiHtml(req, res, renderPage({
          title: heading,
          heading,
          path: `/wiki/${encoded}/${sha}/`,
          nav: wikiNav(
            slug,
            'history',
            loggedIn,
            logoutReturnTo(`/wiki/${encoded}/${sha}?diff=1`, effectiveVis),
            canShowEdit(slug, req, loggedIn)
          ),
          content: (
            <>
              {revRecord && (
                <p className='wiki-meta'>
                  <a href={`/wiki/${encoded}/${sha}`}>View snapshot</a>
                </p>
              )}
              <figure className='code'>
                <pre><code>{util.raw(renderSafeCode(diff, 'diff'))}</code></pre>
              </figure>
            </>
          ),
        }), isPublic);
        return;
      }

      const revRecord = await wiki.getRevisionRecord(slug, sha);
      const revVis: PageVisibility | undefined = revRecord
        ? (isProject
          ? (revRecord.visibility ?? 'developers')
          : (revRecord.visibility === 'developers' || revRecord.visibility === 'discord'
            ? revRecord.visibility
            : undefined))
        : undefined;
      if (!revRecord) {
        sendError(res, 404);
        return;
      }
      const effectiveVis = stricterVisibility(currentVis, revVis);
      if (!requireReadAuth(req, res, effectiveVis)) return;
      const rawText = revRecord.content;
      const meta: {title?: string; summary?: string} = {};
      const html = renderDjot(rawText, meta);
      const heading = `${meta.title ?? displayTitle} @ ${sha.slice(0, 7)}`;
      const loggedIn = Boolean(getEffectiveUser(req) || wiki.auth.getSession(req));
      const isPublic = effectiveVis === 'public' && !loggedIn;
      sendWikiHtml(req, res, renderPage({
        title: heading,
        heading,
        path: `/wiki/${encoded}/${sha}/`,
        nav: wikiNav(
          slug,
          'history',
          loggedIn,
          logoutReturnTo(`/wiki/${encoded}/${sha}`, effectiveVis),
          canShowEdit(slug, req, loggedIn)
        ),
        content: (
          <>
            <p className='wiki-meta'>
              <a href={`/wiki/${encoded}/${sha}?diff=1`}>View diff</a>
            </p>
            {util.raw(html)}
          </>
        ),
      }), isPublic);
    } catch (err) {
      console.error('Error rendering wiki revision:', err);
      if (!res.headersSent) sendError(res, 500);
    }
  };

  app.get('/wiki/projects/:page/edit', (req, res) =>
    renderEditSlug(req, res, projectSlugParam(req.params.page)));
  app.get('/wiki/projects/:page/history', (req, res) =>
    handleHistorySlug(req, res, projectSlugParam(req.params.page)));
  app.get('/wiki/projects/:page/:sha', (req, res) =>
    handleRevisionSlug(req, res, projectSlugParam(req.params.page), req.params.sha));
  app.get('/wiki/projects/:page', (req, res) =>
    renderPageSlug(req, res, projectSlugParam(req.params.page)));
  app.post('/wiki/projects/:page', (req, res) =>
    handlePostSlug(req, res, projectSlugParam(req.params.page)));

  app.get('/wiki/:page/edit', (req, res) =>
    renderEditSlug(req, res, generalSlugParam(req.params.page)));
  app.get('/wiki/:page/history', (req, res) =>
    handleHistorySlug(req, res, generalSlugParam(req.params.page)));
  app.get('/wiki/:page/:sha', (req, res) =>
    handleRevisionSlug(req, res, generalSlugParam(req.params.page), req.params.sha));
  app.get('/wiki/:page', (req, res) =>
    renderPageSlug(req, res, generalSlugParam(req.params.page)));
  app.post('/wiki/:page', (req, res) =>
    handlePostSlug(req, res, generalSlugParam(req.params.page)));

  return wiki;
}
