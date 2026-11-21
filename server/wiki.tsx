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

// Hardcoded site-wide wiki administrators and GitHub -> display-name overrides (replaces the
// two-line `config/wiki.yml`). Admins can edit any project wiki page regardless of project
// ownership; `AUTHORS` maps GitHub commit authors to their Smogon handle in revision history.
const ADMINS = ['scheibo'];
const AUTHORS: Record<string, string> = {scheibo: 'pre'};
const ADMIN_USERS = new Set(ADMINS.map(a => a.toLowerCase()));
const AUTHOR_MAP = new Map(Object.entries(AUTHORS).map(([gh, name]) => [gh.toLowerCase(), name]));

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
    const arenaSlug = util.slugify(name).toLowerCase();
    if (arenaSlug) {
      if (!aliases.has(arenaSlug)) aliases.set(arenaSlug, slug);
      const normArena = normalizeDecodedSlug(arenaSlug).toLowerCase();
      if (!aliases.has(normArena)) aliases.set(normArena, slug);
    }
    const idAlias = util.toID(name);
    if (idAlias && !RESERVED_SLUGS.has(idAlias) && !aliases.has(idAlias)) {
      aliases.set(idAlias, slug);
    }
  }
  return {projects, aliases};
}

const STYLE = fs.readFileSync(util.root('static', 'style', 'wiki.css'), 'utf8');

function renderPageHtml(opts: {
  id?: string;
  title: string;
  heading: string;
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
  active: 'view' | 'edit' | 'history' | 'pages',
  loggedIn = false,
  returnTo = '/wiki'
): util.Html {
  const item = (key: typeof active, href: string, label: string) =>
    key === active ? <strong>{label}</strong> : <a href={href}>{label}</a>;
  const encoded = encodeSlug(slug);
  const viewHref = slug === 'index' ? '/wiki' : `/wiki/${encoded}`;
  return <nav id='wiki-nav'>
    {item('view', viewHref, 'View')} — {item('edit', `/wiki/${encoded}/edit`, 'Edit')} —{' '}
    {item('history', `/wiki/${encoded}/history`, 'History')} —{' '}
    {item('pages', '/wiki/pages', 'Pages')}
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
              const box = li.checkbox === 'checked' ? '\u2611 ' : '\u2610 ';
              return `${String(
                <li>{box}{util.raw(renderListItemBlocks(li.children, node.tight, nextDepth))}</li>
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
            <p><a href={`#fnref-${num}`}>{'\u21a9'}</a></p>
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
  res.setHeader('ETag', etag);
  if (req.headers['if-none-match'] === etag) {
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
    let extracted: {projects: Map<string, ProjectPage>; aliases: Map<string, string>};
    try {
      authorizedUsers = extractAuthorizedGitHubUsers(projectsRaw, ADMINS);
      extracted = extractProjectPages(projectsRaw);
    } catch (err) {
      console.error('Failed parsing projects.yml for wiki metadata:', err);
      if (this.projectsMtime !== -1) return;
      authorizedUsers = new Set(ADMIN_USERS);
      extracted = {projects: new Map(), aliases: new Map()};
    }

    this.authorizedUsers = authorizedUsers;
    this.projectPages = extracted.projects;
    this.projectAliases = extracted.aliases;
    this.projectsMtime = pMtime;
  }

  formatAuthor(githubLogin: string): string {
    return AUTHOR_MAP.get(githubLogin.toLowerCase()) ?? githubLogin;
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

  canEdit(login: string | undefined, slug?: string): boolean {
    if (!login) return false;
    this.refreshMetadata();
    const lower = login.toLowerCase();
    if (ADMIN_USERS.has(lower)) return true;
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
      const record = this.readCanonicalRecord(slug);
      const visibility: PageVisibility = project
        ? (record?.visibility ?? 'developers')
        : (record?.visibility === 'developers' || record?.visibility === 'discord'
          ? record.visibility
          : 'public');
      const heading = record?.content ? extractTopHeadingTitle(record.content) : undefined;
      const title = heading || project?.name || formatTitle(canonical);
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
      const isoDate = this.now ? new Date(this.now() * 1000).toISOString() : undefined;
      const env = isoDate
        ? {...process.env, GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate}
        : undefined;
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

      if (this.shouldPush) {
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

  const slugParam = (v: string | string[] | undefined) =>
    normalizeSlug(typeof v === 'string' ? v : '');

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

  // Redirect logout to public `/wiki` whenever the current page/revision requires auth,
  // avoiding an immediate `requireReadAuth` -> `/auth/github` silent OAuth re-login loop.
  const logoutReturnTo = (
    slug: string,
    candidate: string,
    extraVisibility?: PageVisibility
  ): string => (
    stricterVisibility(wiki.getPageVisibility(slug), extraVisibility) === 'public'
      ? candidate
      : '/wiki'
  );

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
    if (!requireReadAuth(req, res, slug, vis)) return;

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
    const heading = meta.title ?? wiki.getProjectPage(slug)?.name ?? formatTitle(slug);
    const viewPath = slug === 'index' ? '/wiki' : `/wiki/${encoded}`;
    const loggedIn = Boolean(getEffectiveUser(req) || wiki.auth.getSession(req));
    const isPublic = vis === 'public' && !loggedIn;
    sendWikiHtml(req, res, renderPage({
      title: heading,
      heading,
      path: slug === 'index' ? '/wiki/' : `/wiki/${encoded}/`,
      nav: wikiNav(slug, 'view', loggedIn, logoutReturnTo(slug, viewPath, vis)),
      content: util.raw(renderedHtml),
    }), isPublic);
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

    const loggedIn = Boolean(login || wiki.auth.getSession(req));
    const isPublic = !loggedIn && !isDev && !isDiscord;
    sendWikiHtml(req, res, renderPage({
      title: 'Pages — Wiki',
      heading: 'Pages',
      path: '/wiki/pages/',
      nav: wikiNav('index', 'pages', loggedIn, '/wiki/pages'),
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
    }), isPublic);
  });

  app.get('/wiki/:page', (req, res) => renderPageSlug(req, res, slugParam(req.params.page)));

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
    const returnTo = wiki.readPage(slug) !== undefined
      ? logoutReturnTo(slug, viewPath, visibility)
      : '/wiki';
    sendHtml(res, statusCode, renderPage({
      title: heading,
      heading,
      path: `/wiki/${encoded}/edit/`,
      nav: wikiNav(slug, 'edit', true, returnTo),
      content: form,
    }));
  };

  app.get('/wiki/:page/edit', (req, res) => {
    const slug = resolveOrRedirect(res, slugParam(req.params.page), '/edit');
    if (!slug) return;
    if (!requireEditAuth(req, res, slug)) return;
    const existing = wiki.readPage(slug) ?? '';
    const visibility = wiki.isProjectPage(slug) ? wiki.getPageVisibility(slug) : undefined;
    renderEditor(res, {slug, content: existing, visibility});
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

      if (action === 'preview') {
        const previewHtml = renderDjot(content, {});
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
      const currentVis = wiki.getPageVisibility(slug);
      if (!requireReadAuth(req, res, slug, currentVis)) return;
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
                  const date = util.formatUtcDate(rev.timestamp);
                  const revUrl = `/wiki/${encoded}/${rev.sha}`;
                  const ghUrl = `https://github.com/${encodeURIComponent(rev.author)}`;
                  const displayAuthor = wiki.formatAuthor(rev.author);
                  return (
                    <tr className={idx >= util.TABLE_PAGE_SIZE ? 'hide' : undefined}>
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
          <util.TablePager
            id='wiki-history-pager'
            label='Revision history pagination'
            total={revisions.length}
            singular='revision'
            plural='revisions'
          />
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
          logoutReturnTo(slug, `/wiki/${encoded}/history`, currentVis)
        ),
        content: table,
      }), isPublic);
    } catch (err) {
      console.error('Error rendering wiki history:', err);
      if (!res.headersSent) sendError(res, 500);
    }
  });

  app.get('/wiki/:page/:sha', async (req, res) => {
    try {
      const rawSlug = slugParam(req.params.page);
      const sha = typeof req.params.sha === 'string' ? req.params.sha : '';
      if (!isValidSlug(rawSlug) || !SHA_RE.test(sha)) {
        sendError(res, 404);
        return;
      }
      const showDiff = req.query.diff === '1';
      const slug = resolveOrRedirect(res, rawSlug, `/${sha}${showDiff ? '?diff=1' : ''}`);
      if (!slug) return;
      const currentVis = wiki.getPageVisibility(slug);
      if (!requireReadAuth(req, res, slug, currentVis)) return;

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
        if (!requireReadAuth(req, res, slug, diffVis)) return;

        if (diff === undefined) {
          sendError(res, 404);
          return;
        }
        const heading = `${displayTitle} @ ${sha.slice(0, 7)}`;
        const loggedIn = Boolean(getEffectiveUser(req) || wiki.auth.getSession(req));
        const isPublic = stricterVisibility(currentVis, diffVis) === 'public' && !loggedIn;
        sendWikiHtml(req, res, renderPage({
          title: heading,
          heading,
          path: `/wiki/${encoded}/${sha}/`,
          nav: wikiNav(
            slug,
            'history',
            loggedIn,
            logoutReturnTo(slug, `/wiki/${encoded}/${sha}?diff=1`, diffVis)
          ),
          content: (
            <>
              <p className='wiki-meta'>
                <a href={`/wiki/${encoded}/${sha}`}>View snapshot</a>
              </p>
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
      if (!requireReadAuth(req, res, slug, revVis)) return;
      const rawText = revRecord.content;
      const meta: {title?: string; summary?: string} = {};
      const html = renderDjot(rawText, meta);
      const heading = `${meta.title ?? displayTitle} @ ${sha.slice(0, 7)}`;
      const loggedIn = Boolean(getEffectiveUser(req) || wiki.auth.getSession(req));
      const isPublic =
        stricterVisibility(currentVis, revVis) === 'public' && !loggedIn;
      sendWikiHtml(req, res, renderPage({
        title: heading,
        heading,
        path: `/wiki/${encoded}/${sha}/`,
        nav: wikiNav(
          slug,
          'history',
          loggedIn,
          logoutReturnTo(slug, `/wiki/${encoded}/${sha}`, revVis)
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
  });

  return wiki;
}
