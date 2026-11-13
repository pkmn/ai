// Smogon XenForo profile resolution and ban-status verification.
//
// Smogon AI Policy requires every Arena competitor to be tied to a non-banned Smogon forum
// account. Because Smogon usernames can be renamed on XenForo while numeric member IDs are
// immutable, `pkmn register` resolves usernames/URLs to their numeric `smogon_id` once and
// stores `smogon_id` in `agents`, periodically refreshing display names and ban flags via the
// lightweight `?tooltip=true&_xfResponseType=json` XenForo endpoint.

const SMOGON_BASE = 'https://www.smogon.com';
const MEMBER_URL_RE =
  /^(?:https?:\/\/(?:www\.)?smogon\.com)?\/forums\/members\/(?:([^/?#]+)\.)?(\d+)\/?$/i;
const SLUG_ID_RE = /^([^/?#]+)\.(\d+)$/;

export interface User {
  id: number;
  username: string;
  slug: string;
  url: string;
  banned: boolean;
}

function safeDecodeURIComponent(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function parseIdentifier(raw: string | number): {id?: number; username?: string} {
  const assertSafeSmogonId = (id: number, label: string | number): number => {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error(`Invalid Smogon user ID: ${String(label)}`);
    }
    return id;
  };

  if (typeof raw === 'number') {
    return {id: assertSafeSmogonId(raw, raw)};
  }

  const trimmed = String(raw ?? '').trim();
  if (!trimmed) {
    throw new Error('Empty Smogon account identifier');
  }

  if (/^\d+$/.test(trimmed)) {
    return {id: assertSafeSmogonId(Number(trimmed), trimmed)};
  }

  const urlMatch = MEMBER_URL_RE.exec(trimmed);
  if (urlMatch) {
    const id = assertSafeSmogonId(Number(urlMatch[2]), trimmed);
    const slug = urlMatch[1] ? safeDecodeURIComponent(urlMatch[1]) : undefined;
    return {id, username: slug};
  }

  const slugMatch = SLUG_ID_RE.exec(trimmed);
  if (slugMatch) {
    return {id: assertSafeSmogonId(Number(slugMatch[2]), trimmed), username: slugMatch[1]};
  }

  return {username: trimmed};
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = Number(dec);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const code = parseInt(hex, 16);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '';
    })
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Smogon's Cloudflare/WAF layer blocks automated XenForo requests unless the authorized
// `__scraper-token` query parameter is attached on every hop (including 301/303 redirects
// when canonicalizing `/forums/members/<id>/` -> `/forums/members/<slug>.<id>/`).
function withToken(rawUrl: string, token: string): URL {
  const u = new URL(rawUrl, SMOGON_BASE);
  if (u.protocol !== 'https:' || (u.hostname !== 'smogon.com' && u.hostname !== 'www.smogon.com')) {
    throw new Error(`Refusing to send Smogon token to non-Smogon URL: ${u.origin}`);
  }
  u.hash = '';
  u.searchParams.set('__scraper-token', token);
  return u;
}

async function fetchFollowingRedirects(rawUrl: string, token: string): Promise<Response> {
  const signal = AbortSignal.timeout(15_000);
  let current = rawUrl;
  for (let hops = 0; hops < 8; hops++) {
    const res = await fetch(withToken(current, token), {redirect: 'manual', signal});
    const location = res.headers.get('location');
    if (location && res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      current = new URL(location, current).toString();
      continue;
    }
    return res;
  }
  throw new Error(`Too many redirects fetching Smogon URL: ${rawUrl}`);
}

export async function lookupUser(
  raw: string | number,
  token = process.env.SMOGON_TOKEN
): Promise<User> {
  if (!token) {
    throw new Error('SMOGON_TOKEN is required to look up Smogon accounts');
  }

  const parsed = parseIdentifier(raw);
  let id = parsed.id;
  let fallbackSlug = parsed.username;

  // Username-only inputs resolve via XenForo's `/forums/members/?username=...` 303 redirect,
  // which points at `/forums/members/<slug>.<id>/` when an exact account exists.
  if (id === undefined) {
    const encoded = encodeURIComponent(parsed.username!);
    const findUrl = `${SMOGON_BASE}/forums/members/?username=${encoded}`;
    const res = await fetch(withToken(findUrl, token), {
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    const location = res.headers.get('location');
    if (!location || res.status < 300 || res.status >= 400) {
      throw new Error(`Smogon account "${raw}" not found`);
    }
    const locUrl = new URL(location, SMOGON_BASE);
    if (
      locUrl.protocol !== 'https:' ||
      (locUrl.hostname !== 'smogon.com' && locUrl.hostname !== 'www.smogon.com')
    ) {
      throw new Error(`Unexpected redirect "${location}" looking up Smogon user "${raw}"`);
    }
    const m = MEMBER_URL_RE.exec(locUrl.pathname);
    if (!m) {
      throw new Error(`Unexpected redirect "${location}" looking up Smogon user "${raw}"`);
    }
    id = Number(m[2]);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error(`Invalid Smogon user ID in redirect: ${m[2]}`);
    }
    if (m[1]) fallbackSlug = safeDecodeURIComponent(m[1]);
  }

  const tooltipUrl =
    `${SMOGON_BASE}/forums/members/${id}/?tooltip=true&_xfResponseType=json`;
  const res = await fetchFollowingRedirects(tooltipUrl, token);
  if (!res.ok) {
    throw new Error(`Smogon member ID ${id} not found (HTTP ${res.status})`);
  }

  const data = await res.json() as {status?: string; html?: {content?: string}};
  const html = data.html?.content ?? '';
  if (data.status !== 'ok' || !html) {
    throw new Error(`Smogon member ID ${id} returned invalid profile payload`);
  }

  const nameRe = new RegExp(
    '<h4[^>]*class="[^"]*memberTooltip-name[^"]*"[^>]*>[\\s\\S]*?' +
    `<a[^>]*href="/forums/members/(?:([^"/?#]+)\\.)?${id}/"[^>]*>([\\s\\S]*?)</a>`,
    'i'
  );
  const nameMatch = nameRe.exec(html);
  const slug = nameMatch?.[1]
    ? safeDecodeURIComponent(nameMatch[1])
    : (fallbackSlug ?? String(id));
  const rawName = nameMatch?.[2]
    ? decodeHtmlEntities(nameMatch[2].replace(/<[^>]+>/g, '')).trim()
    : '';
  const username = rawName || slug;

  // XenForo marks banned members either with `username--banned` on the display name span or
  // with a `Banned` userTitle banner in the tooltip card.
  const banned =
    /username--banned/i.test(html) ||
    /<span[^>]*class="[^"]*userTitle[^"]*"[^>]*>\s*Banned\s*<\/span>/i.test(html);

  const memberSegment = nameMatch?.[1] ? `${nameMatch[1]}.${id}` : String(id);
  return {
    id,
    username,
    slug,
    url: `${SMOGON_BASE}/forums/members/${memberSegment}/`,
    banned,
  };
}
