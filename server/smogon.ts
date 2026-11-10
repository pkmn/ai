const SMOGON_BASE = 'https://www.smogon.com';
const MEMBER_URL_RE =
  /^(?:https?:\/\/(?:www\.)?smogon\.com)?\/forums\/members\/(?:([^/?#]+)\.)?(\d+)\/?$/i;
const SLUG_ID_RE = /^([^/?#]+)\.(\d+)$/;

export interface SmogonUser {
  id: number;
  username: string;
  slug: string;
  url: string;
  banned: boolean;
}

export function parseSmogonIdentifier(raw: string | number): {id?: number; username?: string} {
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw <= 0) {
      throw new Error(`Invalid Smogon user ID: ${raw}`);
    }
    return {id: raw};
  }

  const trimmed = String(raw ?? '').trim();
  if (!trimmed) {
    throw new Error('Empty Smogon account identifier');
  }

  if (/^\d+$/.test(trimmed)) {
    const id = Number(trimmed);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error(`Invalid Smogon user ID: ${trimmed}`);
    }
    return {id};
  }

  const urlMatch = MEMBER_URL_RE.exec(trimmed);
  if (urlMatch) {
    const id = Number(urlMatch[2]);
    const slug = urlMatch[1] ? decodeURIComponent(urlMatch[1]) : undefined;
    return {id, username: slug};
  }

  const slugMatch = SLUG_ID_RE.exec(trimmed);
  if (slugMatch) {
    return {id: Number(slugMatch[2]), username: slugMatch[1]};
  }

  return {username: trimmed};
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function withToken(rawUrl: string, token: string): URL {
  const u = new URL(rawUrl, SMOGON_BASE);
  u.hash = '';
  if (u.hostname.endsWith('smogon.com')) {
    u.searchParams.set('__scraper-token', token);
  }
  return u;
}

async function fetchSmogonFollowingRedirects(rawUrl: string, token: string): Promise<Response> {
  let current = rawUrl;
  for (let hops = 0; hops < 8; hops++) {
    const res = await fetch(withToken(current, token), {redirect: 'manual'});
    const location = res.headers.get('location');
    if (location && res.status >= 300 && res.status < 400) {
      current = new URL(location, current).toString();
      continue;
    }
    return res;
  }
  throw new Error(`Too many redirects fetching Smogon URL: ${rawUrl}`);
}

export async function lookupSmogonUser(
  raw: string | number,
  token = process.env.SMOGON_TOKEN
): Promise<SmogonUser> {
  if (!token) {
    throw new Error('SMOGON_TOKEN is required to look up Smogon accounts');
  }

  const parsed = parseSmogonIdentifier(raw);
  let id = parsed.id;
  let fallbackSlug = parsed.username;

  if (id === undefined) {
    const encoded = encodeURIComponent(parsed.username!);
    const findUrl = `${SMOGON_BASE}/forums/members/?username=${encoded}`;
    const res = await fetch(withToken(findUrl, token), {redirect: 'manual'});
    const location = res.headers.get('location');
    if (!location || res.status < 300 || res.status >= 400) {
      throw new Error(`Smogon account "${raw}" not found`);
    }
    const locPath = new URL(location, SMOGON_BASE).pathname;
    const m = MEMBER_URL_RE.exec(locPath);
    if (!m) {
      throw new Error(`Unexpected redirect "${location}" looking up Smogon user "${raw}"`);
    }
    id = Number(m[2]);
    if (m[1]) fallbackSlug = decodeURIComponent(m[1]);
  }

  const tooltipUrl =
    `${SMOGON_BASE}/forums/members/${id}/?tooltip=true&_xfResponseType=json`;
  const res = await fetchSmogonFollowingRedirects(tooltipUrl, token);
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
    ? decodeURIComponent(nameMatch[1])
    : (fallbackSlug ?? String(id));
  const rawName = nameMatch?.[2]
    ? decodeHtmlEntities(nameMatch[2].replace(/<[^>]+>/g, '')).trim()
    : '';
  const username = rawName || slug;

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
