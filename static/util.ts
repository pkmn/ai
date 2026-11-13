import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as path from 'path';

export const ROOT = path.basename(path.dirname(__dirname)) === 'build'
  ? path.join(__dirname, '..', '..')
  : path.join(__dirname, '..');

export const root = (...paths: string[]) => path.join(ROOT, ...paths);

export const slugify = (s: string) =>
  s.replace(/\s+/g, '-')
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
export function validateAgentName(raw: string): string {
  const name = raw.trim();
  if (!name || name.length > 18) {
    throw new Error(`Agent name "${raw}" must be 1–18 characters`);
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

export function validateVersion(raw: string): string {
  const version = raw.trim();
  if (!VERSION_RE.test(version)) {
    throw new Error(
      `Version "${raw}" must be 1–12 characters matching ^[A-Za-z0-9][A-Za-z0-9._-]{0,11}$`
    );
  }
  return version;
}

export const escapeHtml = (str: string) =>
  str.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export const renderTemplate = (
  template: string,
  vars: Record<string, string | number | undefined>
) =>
  template.replace(
    /\{\{\{(\w+)\}\}\}|\{\{(\w+)\}\}/g,
    (_, rawKey?: string, escapedKey?: string) =>
      rawKey !== undefined
        ? String(vars[rawKey] ?? '')
        : escapeHtml(String(vars[escapedKey!] ?? ''))
  );

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

export function writeFileAtomic(filePath: string, contents: string) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, contents, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

export function copyFileAtomic(srcPath: string, destPath: string) {
  fs.mkdirSync(path.dirname(destPath), {recursive: true});
  const tmpPath = `${destPath}.tmp.${process.pid}.${Date.now()}`;
  fs.copyFileSync(srcPath, tmpPath);
  fs.renameSync(tmpPath, destPath);
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

function isPrivateIpv4Nums(a: number, b: number, c: number): boolean {
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT / Tailscale
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC1918
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24, 192.0.2.0/24
  if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24 6to4 relay
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmark
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

function parseIpv6Words(addr: string): number[] | undefined {
  let normalized = addr;
  const lastColon = normalized.lastIndexOf(':');
  if (lastColon >= 0 && normalized.slice(lastColon + 1).includes('.')) {
    const ipv4Parts = normalized.slice(lastColon + 1).split('.').map(Number);
    if (
      ipv4Parts.length !== 4 ||
      ipv4Parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)
    ) {
      return undefined;
    }
    const hi = ((ipv4Parts[0] << 8) | ipv4Parts[1]).toString(16);
    const lo = ((ipv4Parts[2] << 8) | ipv4Parts[3]).toString(16);
    normalized = `${normalized.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const dbl = normalized.split('::');
  if (dbl.length > 2) return undefined;
  const head = dbl[0] ? dbl[0].split(':') : [];
  const tail = dbl.length === 2 && dbl[1] ? dbl[1].split(':') : [];
  const fill = dbl.length === 2 ? 8 - head.length - tail.length : 0;
  if ((dbl.length === 1 && head.length !== 8) || fill < 0) return undefined;

  const groups = [...head, ...Array<string>(fill).fill('0'), ...tail];
  if (groups.length !== 8) return undefined;
  const words: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
    words.push(parseInt(g, 16));
  }
  return words;
}

// Rejects loopback, unspecified, link-local (AWS/GCP/Linode 169.254.169.254 metadata), CGNAT,
// RFC1918, IPv6 ULA/multicast, and IPv4-in-IPv6 transition prefixes (`::ffff:0:0/96`, `::/96`,
// `64:ff9b::/96`, `2002::/16`, `2001::/32`) so a competitor cannot trick the runner into fetching
// from its LAN, SSH tunnels, or cloud metadata endpoints.
export function isPrivateOrLoopbackHost(hostname: string): boolean {
  const trimmed = hostname.trim();
  if (!trimmed || trimmed.includes('%')) return true;

  const unbracketed = trimmed.replace(/^\[|\]$/g, '').toLowerCase();
  if (!unbracketed) return true;

  let host: string;
  try {
    const parsedUrl = unbracketed.includes(':')
      ? new URL(`http://[${unbracketed}]/`)
      : new URL(`http://${unbracketed}/`);
    host = parsedUrl.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return true;
  }

  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return true;
  }

  const ipVer = net.isIP(host);
  if (ipVer === 4) {
    const [a, b, c] = host.split('.').map(Number);
    return isPrivateIpv4Nums(a, b, c);
  }

  if (ipVer === 6) {
    const w = parseIpv6Words(host);
    if (!w) return true;
    const embeddedPrivate = (hi: number, lo: number) =>
      isPrivateIpv4Nums(hi >> 8, hi & 0xff, lo >> 8);

    // `::/96` covers unspecified `::`, loopback `::1`, and IPv4-compatible `::w.x.y.z`
    if (w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0) {
      return true;
    }
    // `::ffff:0:0/96` IPv4-mapped (WHATWG URL canonicalizes `::ffff:127.0.0.1` -> `::ffff:7f00:1`)
    if (w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0xffff) {
      return embeddedPrivate(w[6], w[7]);
    }
    // `::ffff:0:0:0/96` IPv4-translated
    if (w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0xffff && w[5] === 0) {
      return embeddedPrivate(w[6], w[7]);
    }
    if (w[0] === 0x0064 && w[1] === 0xff9b) return true; // 64:ff9b::/96 & 64:ff9b:1::/48 NAT64
    if (w[0] === 0x0100 && w[1] === 0 && w[2] === 0 && w[3] === 0) return true; // 100::/64 discard
    if (
      w[0] === 0x2001 &&
      (w[1] === 0x0000 || (w[1] === 0x0002 && w[2] === 0) || w[1] === 0x0db8)
    ) {
      return true; // Teredo 2001::/32, benchmark 2001:2::/48, documentation 2001:db8::/32
    }
    if (w[0] === 0x2002) return true; // 6to4 2002::/16
    if ((w[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
    if ((w[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((w[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 deprecated site-local
    if ((w[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    return false;
  }

  return false;
}
