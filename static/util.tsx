import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

import {Child, Component, Fragment, Html, escapeHtml, h, raw} from './dom';

export type {Child, Component};
export {Fragment, Html, escapeHtml, h, raw};

export const ROOT = path.basename(path.dirname(__dirname)) === 'build'
  ? path.join(__dirname, '..', '..')
  : path.join(__dirname, '..');

export const root = (...paths: string[]) => path.join(ROOT, ...paths);

export const slugify = (s: string) =>
  s.normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^\w-]+/g, '')
    .replace(/--+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');

export const toID = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '');

// Version labels are capped at 12 characters and must start with an ASCII alphanumeric character
// (preventing `.` / `..` path traversal segments when mounting version directories on the runner).
export const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,11}$/;

const PS_ZALGO_RE = new RegExp(
  '[\\u0300-\\u036f\\u0483-\\u0489\\u0610-\\u0615\\u064B-\\u065F\\u0670\\u06D6-\\u06DC' +
  '\\u06DF-\\u06ED\\u0E31\\u0E34-\\u0E3A\\u0E47-\\u0E4E]{3,}|[\\u239b-\\u23b9]'
);
const PS_LEADING_RANK_RE = /^[~&@%+*!#/\-§]/;

function hasControlOrBidiChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (
      c <= 0x1f ||
      (c >= 0x7f && c <= 0x9f) ||
      c === 0x200e ||
      c === 0x200f ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069)
    ) {
      return true;
    }
  }
  return false;
}

// Validates that an Arena agent display name conforms to Pokémon Showdown username conventions
// (`Dex.getName` + `Users.NameValidator`): 1..18 characters, protocol-safe (`|`, `[`, `]`, `,`
// forbidden), no consecutive/non-ASCII whitespace or control/bidi/zalgo characters, no leading
// rank/command prefix, and a non-`guest` `toID` containing at least one ASCII letter.
export function validateAgentName(rawName: string): string {
  const name = rawName.trim();
  if (!name || name.length > 18) {
    throw new Error(`Agent name "${rawName}" must be 1–18 characters`);
  }
  if (
    /[|[\],]/.test(name) ||
    /\s{2,}/.test(name) ||
    /[^\S ]/.test(name) ||
    hasControlOrBidiChar(name) ||
    PS_ZALGO_RE.test(name)
  ) {
    throw new Error(
      `Agent name "${name}" contains disallowed Pokémon Showdown username characters`
    );
  }
  if (PS_LEADING_RANK_RE.test(name)) {
    throw new Error(
      `Agent name "${name}" cannot start with a Pokémon Showdown rank or command symbol`
    );
  }
  const id = toID(name);
  if (!id || id.length > 18 || !/[a-z]/.test(id)) {
    throw new Error(`Agent name "${name}" must contain at least one ASCII letter`);
  }
  if (id.startsWith('guest')) {
    throw new Error(`Agent name "${name}" cannot use reserved Pokémon Showdown "Guest" prefix`);
  }
  return name;
}

export function validateVersion(rawVersion: string): string {
  const version = rawVersion.trim();
  if (!VERSION_RE.test(version)) {
    throw new Error(
      `Version "${rawVersion}" must be 1–12 characters matching ^[A-Za-z0-9][A-Za-z0-9._-]{0,11}$`
    );
  }
  return version;
}

const HEAD_SUPPORT = Symbol('pkmn.headSupport');

// Polka (`trouter`) only matches routes registered for the exact HTTP method, returning 404 on
// `HEAD` requests to `app.get(...)` routes. Installing this idempotent shim falls back to `GET`
// route lookup when no explicit `HEAD` route exists and suppresses response body bytes while
// preserving status codes, `ETag` / `304`, redirects, and `Content-Length`.
export function installHeadSupport(app: object) {
  const tagged = app as Record<symbol, boolean>;
  if (tagged[HEAD_SUPPORT]) return;
  Object.defineProperty(tagged, HEAD_SUPPORT, {value: true, enumerable: false});

  const router = app as {
    find: (method: string, pathname: string) => unknown;
    use: (
      fn: (req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void
    ) => unknown;
  };
  const origFind = router.find.bind(router);
  router.find = (method: string, pathname: string) => {
    const found = origFind(method, pathname);
    if (method === 'HEAD' && !found) {
      return origFind('GET', pathname);
    }
    return found;
  };

  router.use((req, res, next) => {
    if (req.method === 'HEAD') {
      let wroteChunks = false;
      const origEnd = res.end.bind(res);
      res.write = (() => {
        wroteChunks = true;
        return true;
      }) as typeof res.write;
      res.end = ((chunk?: unknown, ...rest: unknown[]) => {
        if (
          !wroteChunks &&
          !res.headersSent &&
          res.statusCode !== 204 &&
          res.statusCode !== 304 &&
          !res.hasHeader('Content-Length') &&
          (typeof chunk === 'string' || Buffer.isBuffer(chunk))
        ) {
          res.setHeader('Content-Length', String(Buffer.byteLength(chunk)));
        }
        const cb = typeof chunk === 'function'
          ? chunk
          : typeof rest[0] === 'function'
            ? rest[0]
            : typeof rest[1] === 'function'
              ? rest[1]
              : undefined;
        return cb ? origEnd(cb as () => void) : origEnd();
      }) as typeof res.end;
    }
    next();
  });
}

export const EXT_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3"/>' +
  '</svg>';

export function readBodyBuffer(
  req: http.IncomingMessage,
  maxBytes: number,
  limitMessage = 'Payload too large.'
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        req.resume();
        reject(Object.assign(new Error(limitMessage), {status: 413}));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', err => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

export async function readBody(
  req: http.IncomingMessage,
  maxBytes: number,
  limitMessage = 'Payload too large.'
): Promise<string> {
  return (await readBodyBuffer(req, maxBytes, limitMessage)).toString('utf8');
}

// RFC 9110 §13.1.2 weak ETag comparison for `If-None-Match`. Nginx weakens strong ETags to
// `W/"..."` whenever `gzip on` compresses a proxied response, so exact `===` misses `304`.
export function matchesIfNoneMatch(
  header: string | string[] | undefined,
  etag: string
): boolean {
  if (!header) return false;
  const headerStr = Array.isArray(header) ? header.join(',') : header;
  if (headerStr.trim() === '*') return true;
  const target = etag.startsWith('W/') ? etag.slice(2) : etag;
  for (const part of headerStr.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const candidate = trimmed.startsWith('W/') ? trimmed.slice(2) : trimmed;
    if (candidate === target) return true;
  }
  return false;
}

export function writeFileAtomic(filePath: string, contents: string | Buffer) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  const tmpPath = `${filePath}.tmp.${process.pid}.${crypto.randomBytes(8).toString('hex')}`;
  try {
    fs.writeFileSync(tmpPath, contents, {flag: 'wx'});
    fs.renameSync(tmpPath, filePath);
  } finally {
    fs.rmSync(tmpPath, {force: true});
  }
}

export function copyFileAtomic(srcPath: string, destPath: string) {
  fs.mkdirSync(path.dirname(destPath), {recursive: true});
  const tmpPath = `${destPath}.tmp.${process.pid}.${crypto.randomBytes(8).toString('hex')}`;
  try {
    fs.copyFileSync(srcPath, tmpPath, fs.constants.COPYFILE_EXCL);
    fs.renameSync(tmpPath, destPath);
  } finally {
    fs.rmSync(tmpPath, {force: true});
  }
}

export function parseUtcDayMillis(dayUtc: string): number {
  return Date.parse(`${dayUtc}T00:00:00Z`);
}

export function formatUtcDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

export function formatUtcDateTime(epochSeconds: number): string {
  const iso = new Date(epochSeconds * 1000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export function formatUtcTimestamp(epochSeconds: number): string {
  const iso = new Date(epochSeconds * 1000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

export type TimeFormat = 'date' | 'datetime' | 'timestamp';

export function formatUtc(epochSeconds: number, format: TimeFormat = 'timestamp'): string {
  if (format === 'date') return formatUtcDate(epochSeconds);
  if (format === 'datetime') return formatUtcDateTime(epochSeconds);
  return formatUtcTimestamp(epochSeconds);
}

export interface LocalizedTitleAttrs {
  title: string;
  'data-title-tmpl'?: string;
  'data-title-epochs'?: string;
}

export type LocalizedTitlePart =
  string |
  {prefix?: string; epoch: number; suffix?: string; format?: TimeFormat};

export function localizedTitle(
  parts: readonly LocalizedTitlePart[],
  separator = ' · '
): LocalizedTitleAttrs | Record<string, never> {
  if (parts.length === 0) return {};
  const fallback: string[] = [];
  const tmpl: string[] = [];
  const epochs: number[] = [];
  for (const part of parts) {
    if (typeof part === 'string') {
      fallback.push(part);
      tmpl.push(part);
    } else {
      const idx = epochs.length;
      const fmt = part.format ?? 'timestamp';
      epochs.push(part.epoch);
      const pre = part.prefix ?? '';
      const suf = part.suffix ?? '';
      const token = fmt === 'timestamp' ? `{${idx}}` : `{${idx}:${fmt}}`;
      fallback.push(`${pre}${formatUtc(part.epoch, fmt)}${suf}`);
      tmpl.push(`${pre}${token}${suf}`);
    }
  }
  if (epochs.length === 0) return {title: fallback.join(separator)};
  return {
    title: fallback.join(separator),
    'data-title-tmpl': tmpl.join(separator),
    'data-title-epochs': epochs.join(','),
  };
}

export interface TimeProps {
  epoch: number;
  format?: TimeFormat;
  className?: string;
  title?: readonly LocalizedTitlePart[];
}

export const Time = (opts: TimeProps) => {
  const fmt = opts.format ?? 'timestamp';
  const titleParts = opts.title ?? (fmt === 'date' ? [{epoch: opts.epoch}] : undefined);
  const titleAttrs = titleParts ? localizedTitle(titleParts) : {};
  return (
    <time
      datetime={new Date(opts.epoch * 1000).toISOString()}
      data-epoch={String(opts.epoch)}
      data-fmt={fmt === 'timestamp' ? undefined : fmt}
      className={opts.className}
      {...titleAttrs}
    >
      {formatUtc(opts.epoch, fmt)}
    </time>
  );
};

const UTC_TEXT_RE = /\b(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))? UTC\b/g;

function parseUtcTextMatch(m: RegExpExecArray): {epoch: number; format: 'datetime' | 'timestamp'} {
  const epoch = Math.floor(Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    m[6] ? Number(m[6]) : 0
  ) / 1000);
  return {epoch, format: m[6] ? 'timestamp' : 'datetime'};
}

// Splits plain prose containing server-formatted `YYYY-MM-DD HH:MM[:SS] UTC` timestamps into text
// segments and `<Time>` elements so client-side localization converts them to the viewer's zone.
export function renderLocalizedText(text: string): Child {
  UTC_TEXT_RE.lastIndex = 0;
  let m = UTC_TEXT_RE.exec(text);
  if (!m) return text;
  const out: Child[] = [];
  let cursor = 0;
  while (m) {
    if (m.index > cursor) out.push(text.slice(cursor, m.index));
    const parsed = parseUtcTextMatch(m);
    out.push(<Time epoch={parsed.epoch} format={parsed.format} />);
    cursor = m.index + m[0].length;
    m = UTC_TEXT_RE.exec(text);
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

export function localizedTitleFromText(text: string): LocalizedTitleAttrs {
  UTC_TEXT_RE.lastIndex = 0;
  let m = UTC_TEXT_RE.exec(text);
  if (!m) return {title: text};
  const parts: LocalizedTitlePart[] = [];
  let cursor = 0;
  while (m) {
    const prefix = text.slice(cursor, m.index);
    const parsed = parseUtcTextMatch(m);
    parts.push({prefix, epoch: parsed.epoch, format: parsed.format});
    cursor = m.index + m[0].length;
    m = UTC_TEXT_RE.exec(text);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return localizedTitle(parts, '') as LocalizedTitleAttrs;
}

const CONNECTIVITY_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

// Detects offline DNS/socket errors, AbortSignal timeouts, and captive-portal non-JSON hijacks so
// startup hooks and background loops can short-circuit cleanly instead of stalling per request.
export function isConnectivityError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const rec = err as {
    connectivity?: unknown;
    name?: unknown;
    code?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  if (rec.connectivity === true) return true;
  if (rec.name === 'TimeoutError' || rec.name === 'AbortError') return true;
  if (typeof rec.code === 'string' && CONNECTIVITY_CODES.has(rec.code)) return true;
  if (
    rec.name === 'TypeError' &&
    typeof rec.message === 'string' &&
    /fetch failed/i.test(rec.message)
  ) {
    return true;
  }
  return rec.cause !== undefined && rec.cause !== err && isConnectivityError(rec.cause);
}

export async function parseJsonResponse<T>(res: Response, label: string): Promise<T> {
  const contentType = res.headers?.get?.('content-type') ?? '';
  if (/text\/html/i.test(contentType)) {
    throw Object.assign(
      new Error(`${label} returned HTML instead of JSON (captive portal or outage)`),
      {connectivity: true}
    );
  }
  try {
    return await res.json() as T;
  } catch (err) {
    throw Object.assign(
      new Error(`${label} returned invalid JSON (captive portal or outage)`),
      {connectivity: true, cause: err}
    );
  }
}

export const TABLE_PAGE_SIZE = 25;

export type InfoStatus = 'none' | 'partial' | 'full';

export function renderInfoDot(status?: InfoStatus): Child {
  if (status === undefined) return undefined;
  if (status === 'full') {
    return (
      <span
        className='info-dot full yes'
        title='Emits /info with win and policy before every choice'
        aria-label='Full /info telemetry (win and policy before every choice)'
      >
        <svg viewBox='0 0 12 12' aria-hidden='true'>
          <circle cx='6' cy='6' r='5' fill='currentColor' />
        </svg>
      </span>
    );
  }
  if (status === 'partial') {
    return (
      <span
        className='info-dot partial yes'
        title='Emits /info before every choice (add win and policy for full status)'
        aria-label='Partial /info telemetry (missing win or policy)'
      >
        <svg viewBox='0 0 12 12' aria-hidden='true'>
          <circle cx='6' cy='6' r='4.15' fill='none' stroke='currentColor' strokeWidth='1.7' />
          <path d='M6 1.85a4.15 4.15 0 0 1 0 8.3Z' fill='currentColor' />
        </svg>
      </span>
    );
  }
  return (
    <span
      className='info-dot none muted'
      title='No consistent /info telemetry before every choice'
      aria-label='No consistent /info telemetry'
    >
      <svg viewBox='0 0 12 12' aria-hidden='true'>
        <circle cx='6' cy='6' r='4.15' fill='none' stroke='currentColor' strokeWidth='1.7' />
      </svg>
    </span>
  );
}

export interface TablePagerProps {
  id?: string;
  label: string;
  total: number;
  singular: string;
  plural: string;
  pageSize?: number;
  prevLabel?: string;
  nextLabel?: string;
  server?: boolean;
}

export const TablePager = (opts: TablePagerProps) => {
  const pageSize = opts.pageSize ?? TABLE_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(opts.total / pageSize));
  const singlePage = totalPages <= 1;
  const word = opts.total === 1 ? opts.singular : opts.plural;
  const info = `Page 1 of ${totalPages} (${opts.total.toLocaleString('en-US')} ${word})`;
  const prevLabel = opts.prevLabel ?? '\u2190 Prev';
  const nextLabel = opts.nextLabel ?? 'Next \u2192';
  return <div
    className={singlePage ? 'pager hide' : 'pager'}
    id={opts.id}
    aria-label={opts.label}
    data-table-pager={true}
    data-server-pager={opts.server ? true : undefined}
    data-page-size={pageSize}
    data-singular={opts.singular}
    data-plural={opts.plural}
  >
    <button
      type='button'
      className='pager-btn'
      id={opts.id ? `${opts.id}-prev` : undefined}
      data-pager-prev={true}
      disabled={true}
    >{prevLabel}</button>
    <span
      className='pager-info muted'
      id={opts.id ? `${opts.id}-info` : undefined}
      data-pager-info={true}
    >{info}</span>
    <button
      type='button'
      className='pager-btn'
      id={opts.id ? `${opts.id}-next` : undefined}
      data-pager-next={true}
      disabled={singlePage}
    >{nextLabel}</button>
  </div>;
};

export interface PaginatedTableProps {
  id?: string;
  className?: string;
  tbodyId?: string;
  head: Child;
  children?: Child;
  pager: TablePagerProps;
}

export const PaginatedTable = (opts: PaginatedTableProps) => (
  <>
    <div className='table-wrap'>
      <table id={opts.id} className={opts.className}>
        <thead>{opts.head}</thead>
        <tbody id={opts.tbodyId}>{opts.children}</tbody>
      </table>
    </div>
    <TablePager {...opts.pager} />
  </>
);

export const UPDATE_TABLE_PAGER_SCRIPT = `
  const updateTablePager = (pager, page, total, overridePageSize) => {
    if (!pager) return {page: 1, totalPages: 1};
    const pageSize = Number(overridePageSize || pager.dataset.pageSize) || ${TABLE_PAGE_SIZE};
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const clamped = Math.min(Math.max(1, page), totalPages);
    const prevBtn = pager.querySelector('[data-pager-prev]');
    const nextBtn = pager.querySelector('[data-pager-next]');
    const infoEl = pager.querySelector('[data-pager-info]');
    const singular = pager.dataset.singular || 'row';
    const plural = pager.dataset.plural || 'rows';
    pager.classList.toggle('hide', totalPages <= 1);
    if (prevBtn) prevBtn.disabled = clamped <= 1;
    if (nextBtn) nextBtn.disabled = clamped >= totalPages;
    if (infoEl) {
      const word = total === 1 ? singular : plural;
      infoEl.textContent =
        'Page ' + clamped + ' of ' + totalPages +
        ' (' + total.toLocaleString('en-US') + ' ' + word + ')';
    }
    return {page: clamped, totalPages};
  };
`;

export const TABLE_PAGER_SCRIPT = `
  (() => {
    ${UPDATE_TABLE_PAGER_SCRIPT}
    document
      .querySelectorAll('.pager[data-table-pager]:not([data-server-pager])')
      .forEach(pager => {
      const pageSize = Number(pager.dataset.pageSize) || ${TABLE_PAGE_SIZE};
      const wrap = pager.previousElementSibling;
      const tbody = wrap ? wrap.querySelector('tbody') : undefined;
      if (!tbody) return;
      const rows = Array.from(tbody.querySelectorAll('tr')).filter(
        r => !r.classList.contains('diag-replay-row') && !r.classList.contains('battle-detail-row')
      );
      const prevBtn = pager.querySelector('[data-pager-prev]');
      const nextBtn = pager.querySelector('[data-pager-next]');
      let page = 1;
      const apply = () => {
        const total = rows.length;
        const state = updateTablePager(pager, page, total, pageSize);
        page = state.page;
        const start = (page - 1) * pageSize;
        rows.forEach((row, idx) => {
          const hidden = idx < start || idx >= start + pageSize;
          row.classList.toggle('hide', hidden);
          if (hidden) {
            const next = row.nextElementSibling;
            if (next && next.classList.contains('diag-replay-row')) {
              next.remove();
              row.classList.remove('expanded');
              row.setAttribute('aria-expanded', 'false');
            } else if (next && next.classList.contains('battle-detail-row')) {
              next.classList.add('hide');
              row.classList.remove('expanded');
              row.setAttribute('aria-expanded', 'false');
            }
          }
        });
      };
      if (prevBtn) {
        prevBtn.addEventListener('click', () => {
          if (page > 1) {
            page--;
            apply();
          }
        });
      }
      if (nextBtn) {
        nextBtn.addEventListener('click', () => {
          page++;
          apply();
        });
      }
    });
  })();
`;
