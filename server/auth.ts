import * as crypto from 'crypto';
import * as http from 'http';

import polka from 'polka';

import * as db from '../db';
import {header, renderErrorPage, renderer} from '../static/build';
import {escapeHtml} from '../static/util';

export const SESSION_COOKIE = 'pkmn_session';
export const STATE_COOKIE = 'pkmn_oauth_state';
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const STATE_TTL_SECONDS = 10 * 60;
export const REGISTER_ISSUE_URL = 'https://github.com/pkmn/ai/issues/new?template=register.yml';
export const ADMINS: readonly string[] = ['scheibo'];

const ADMIN_SET = new Set(ADMINS.map(a => a.toLowerCase()));

export function isAdmin(login: string | undefined): boolean {
  return Boolean(login && ADMIN_SET.has(login.trim().toLowerCase()));
}

const DISCORD_API = 'https://discord.com/api/v10';

// Ephemeral fallback secret used only when `DEV_AUTH=1` in non-production so `DEV_AUTH=1 npm start`
// can mint and verify `pkmn_session` cookies out of the box with an unpopulated `.env`.
const EPHEMERAL_DEV_SECRET = crypto.randomBytes(32).toString('hex');

export interface OAuthProvider {
  clientId: string;
  clientSecret: string;
}

export interface Config {
  sessionSecret: string;
  github?: OAuthProvider;
  discord?: OAuthProvider;
}

// Unified HMAC-signed cookie payload shared across every authenticated surface on pkmn.ai:
//   - `github`: authorizes `/account/`, `/api/submissions`, and developer `/wiki` edits
//   - `discord`: authorizes Nginx `auth_request` on `/chat/logs/` (guild members), `/private/`
//     (`?guild=0`), Discord-visibility `/wiki` pages, and CLI Bearer tokens via `/chat/logs/token`
// Signing into GitHub or Discord merges into any existing session rather than overwriting the
// other provider's claim.
export interface Session {
  github?: {id: number; login: string};
  discord?: {id: string; username: string; avatar?: string};
  exp: number;
}

export interface Profile {
  authenticated: boolean;
  username?: string;
  avatarUrl?: string;
}

export function githubAvatarUrl(githubId: number): string {
  return `https://avatars.githubusercontent.com/u/${githubId}?s=64`;
}

export function sanitizeDiscordAvatarHash(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return /^(?:a_)?[0-9a-f]{1,64}$/i.test(trimmed) ? trimmed : undefined;
}

export function discordAvatarUrl(discordId: string, avatar?: string): string {
  const hash = sanitizeDiscordAvatarHash(avatar);
  if (hash) {
    return `https://cdn.discordapp.com/avatars/${discordId}/${hash}.png?size=64`;
  }
  const index = Number((BigInt(discordId) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

interface OAuthStatePayload {
  provider: 'github' | 'discord';
  intent?: 'login' | 'link';
  githubLogin?: string;
  nonce: string;
  returnTo: string;
  redirectUri: string;
  exp: number;
}

export interface Options {
  config?: Config;
  db?: db.Database;
  devAuth?: boolean;
  isAuthorizedGitHub?: (login: string) => boolean;
  isDiscordMember?: (discordId: string) => boolean;
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

export function parseCookieValues(cookieHeader: string | undefined, name: string): string[] {
  const values: string[] = [];
  if (!cookieHeader) return values;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const val = part.slice(eq + 1).trim();
    try {
      values.push(decodeURIComponent(val));
    } catch {
      values.push(val);
    }
  }
  return values;
}

export function serializeCookie(name: string, value: string, maxAgeSeconds: number): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const encoded = value ? encodeURIComponent(value) : '';
  return `${name}=${encoded}; HttpOnly; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax${secure}`;
}

function isAccountReturnTo(returnTo: string): boolean {
  const pathname = sanitizeReturnTo(returnTo, '/').split(/[?#]/, 1)[0];
  return pathname === '/account' || pathname === '/account/';
}

export function sanitizeReturnTo(raw: unknown, fallback = '/'): string {
  if (typeof raw !== 'string') return fallback;
  // eslint-disable-next-line no-control-regex
  if (!raw.startsWith('/') || raw.startsWith('//') || /[\\\x00-\x1f\x7f]/.test(raw)) {
    return fallback;
  }
  try {
    const parsed = new URL(raw, 'http://pkmn.local');
    if (parsed.origin !== 'http://pkmn.local') return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

// Accepts either `Authorization: Bearer <token>` (for headless CLI / script access to
// `/chat/logs/` via `/chat/logs/token`) or all browser `pkmn_session` cookies (browsers can send
// duplicate cookies when host-only and `Domain=.pkmn.ai` cookies coexist).
export function extractSessionTokens(headers: http.IncomingHttpHeaders): string[] {
  const auth = headers.authorization;
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
    if (m) return [m[1]];
  }
  return parseCookieValues(headers.cookie, SESSION_COOKIE);
}

export function extractSessionToken(headers: http.IncomingHttpHeaders): string | undefined {
  const tokens = extractSessionTokens(headers);
  return tokens[tokens.length - 1];
}

export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  return (
    remoteAddress === '127.0.0.1' ||
    remoteAddress === '::1' ||
    remoteAddress === '::ffff:127.0.0.1'
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config | undefined {
  const devAuth = env.DEV_AUTH === '1' && env.NODE_ENV !== 'production';
  const sessionSecret = env.SESSION_SECRET?.trim() || (devAuth ? EPHEMERAL_DEV_SECRET : undefined);
  if (!sessionSecret) return undefined;

  // When `DEV_AUTH=1` (`DEV_AUTH=1 npm start`), ignore `.env` OAuth credentials so `/auth/github`
  // and `/auth/discord` on loopback route to `/auth/dev` instead of redirecting out to github.com
  // or discord.com (which breaks offline and against production redirect URIs).
  const ghClientId = env.GITHUB_CLIENT_ID?.trim();
  const ghClientSecret = env.GITHUB_CLIENT_SECRET?.trim();
  const github = !devAuth && ghClientId && ghClientSecret
    ? {clientId: ghClientId, clientSecret: ghClientSecret}
    : undefined;

  const discordClientId = env.DISCORD_CLIENT_ID?.trim();
  const discordClientSecret = env.DISCORD_CLIENT_SECRET?.trim();
  const discord = !devAuth && discordClientId && discordClientSecret
    ? {clientId: discordClientId, clientSecret: discordClientSecret}
    : undefined;

  return {sessionSecret, github, discord};
}

function sendHtml(
  res: http.ServerResponse,
  status: number,
  html: string,
  cookies?: string[]
) {
  const headers: http.OutgoingHttpHeaders = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'private, no-store',
  };
  if (cookies?.length) headers['Set-Cookie'] = cookies;
  res.writeHead(status, headers);
  res.end(html);
}

function redirect(
  res: http.ServerResponse,
  location: string,
  status = 302,
  cookies?: string[]
) {
  const headers: http.OutgoingHttpHeaders = {
    Location: location,
    'Cache-Control': 'private, no-store',
  };
  if (cookies?.length) headers['Set-Cookie'] = cookies;
  res.writeHead(status, headers);
  res.end();
}

function inferOrigin(req: http.IncomingMessage): string {
  if (process.env.NODE_ENV === 'production') {
    return 'https://pkmn.ai';
  }
  const rawHost = typeof req.headers.host === 'string' ? req.headers.host.trim() : '';
  const host = /^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(rawHost) ? rawHost : '127.0.0.1:1234';
  return `http://${host}`;
}

export function isCrossSiteRequest(req: http.IncomingMessage): boolean {
  const fetchSite = req.headers['sec-fetch-site'];
  if (typeof fetchSite === 'string' && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return true;
  }
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== inferOrigin(req)) return true;
  return false;
}

export class Auth {
  readonly db?: db.Database;
  private readonly explicitConfig?: Config;
  private readonly explicitDevAuth?: boolean;
  private readonly customAuthorizedGitHub?: (login: string) => boolean;
  private readonly customDiscordMember?: (discordId: string) => boolean;

  constructor(options: Options = {}) {
    this.explicitConfig = options.config;
    this.db = options.db;
    this.explicitDevAuth = options.devAuth;
    this.customAuthorizedGitHub = options.isAuthorizedGitHub;
    this.customDiscordMember = options.isDiscordMember;
  }

  isDevAuthEnabled(): boolean {
    if (process.env.NODE_ENV === 'production') return false;
    return this.explicitDevAuth ?? (process.env.DEV_AUTH === '1');
  }

  getConfig(): Config | undefined {
    if (this.explicitConfig) return this.explicitConfig;
    const env = this.explicitDevAuth
      ? {...process.env, DEV_AUTH: '1'}
      : process.env;
    return loadConfig(env);
  }

  private resolveSession(
    req: http.IncomingMessage
  ): {session: Session; token: string} | undefined {
    const cfg = this.getConfig();
    if (!cfg) return undefined;
    let best: {session: Session; token: string} | undefined;
    for (const token of extractSessionTokens(req.headers)) {
      const session = verifyToken<Session>(token, cfg.sessionSecret);
      if (!session) continue;
      if (!best || session.exp >= best.session.exp) {
        best = {session, token};
      }
    }
    return best;
  }

  getSession(req: http.IncomingMessage): Session | undefined {
    return this.resolveSession(req)?.session;
  }

  private resolveGitHubSession(
    session: Session
  ): {login: string; githubId: number} | undefined {
    if (!session.github) return undefined;
    if (this.db) {
      if (session.github.id > 0) {
        const byId = this.db.getDeveloperByGitHubId(session.github.id);
        if (byId) return {login: byId.githubLogin, githubId: byId.githubId ?? session.github.id};
      }
      const byLogin = this.db.getDeveloperByGitHub(session.github.login);
      if (byLogin?.githubId !== undefined && byLogin.githubId !== session.github.id) {
        return undefined;
      }
      if (byLogin) {
        return {login: session.github.login, githubId: byLogin.githubId ?? session.github.id};
      }
    }
    return {login: session.github.login, githubId: session.github.id};
  }

  getGitHubUser(req: http.IncomingMessage): string | undefined {
    const session = this.getSession(req);
    return session ? this.resolveGitHubSession(session)?.login : undefined;
  }

  isAuthorizedGitHub(login: string | undefined): boolean {
    if (!login) return false;
    const lower = login.trim().toLowerCase();
    if (!lower) return false;
    if (this.customAuthorizedGitHub) return this.customAuthorizedGitHub(lower);
    return isAdmin(lower) || Boolean(this.db?.getDeveloperByGitHub(lower));
  }

  isDiscordGuildMember(discordId: string | undefined): boolean {
    if (!discordId) return false;
    if (this.customDiscordMember) return this.customDiscordMember(discordId);
    return Boolean(this.db?.isDiscordMember(discordId));
  }

  verifyDiscordAuth(req: http.IncomingMessage): 'authorized' | 'unauthenticated' | 'forbidden' {
    const session = this.getSession(req);
    if (!session?.discord?.id) return 'unauthenticated';
    return this.isDiscordGuildMember(session.discord.id) ? 'authorized' : 'forbidden';
  }

  getProfile(req: http.IncomingMessage): Profile {
    const session = this.getSession(req);
    if (!session?.github && !session?.discord) {
      return {authenticated: false};
    }
    const gh = this.resolveGitHubSession(session);
    if (gh) {
      const avatarUrl = isAdmin(gh.login)
        ? `https://github.com/${encodeURIComponent(gh.login.toLowerCase())}.png?size=64`
        : gh.githubId > 0 ? githubAvatarUrl(gh.githubId) : undefined;
      return {
        authenticated: true,
        username: gh.login,
        ...(avatarUrl ? {avatarUrl} : {}),
      };
    }
    if (session.discord && /^\d+$/.test(session.discord.id)) {
      return {
        authenticated: true,
        username: session.discord.username,
        avatarUrl: discordAvatarUrl(session.discord.id, session.discord.avatar),
      };
    }
    return {authenticated: false};
  }

  issueSessionCookie(session: Omit<Session, 'exp'>): string {
    const cfg = this.getConfig();
    if (!cfg) throw new Error('SESSION_SECRET is not configured');
    const now = Math.floor(Date.now() / 1000);
    const token = signToken({...session, exp: now + SESSION_TTL_SECONDS}, cfg.sessionSecret);
    return serializeCookie(SESSION_COOKIE, token, SESSION_TTL_SECONDS);
  }

  register(app: polka.Polka): this {
    const sendError = (res: http.ServerResponse, status: number, cookies?: string[]) =>
      sendHtml(res, status, renderErrorPage(status, this.db?.getRunningTournament()), cookies);

    // Local-only persona switcher enabled strictly when `DEV_AUTH=1` (and never in production or
    // from non-loopback sockets, nor proxied by Nginx). Mints real HMAC-signed `pkmn_session`
    // cookies so developers can test admin, competitor, stranger, and logged-out states
    // side-by-side in normal and incognito browser windows without touching `.env`.
    if (this.isDevAuthEnabled()) {
      app.get('/auth/dev', (req, res) => {
        if (!isLoopbackAddress(req.socket.remoteAddress) || req.headers['x-forwarded-for']) {
          sendError(res, 403);
          return;
        }
        const returnTo = sanitizeReturnTo(req.query.return_to, '/account/');
        if (req.query.clear === '1') {
          const clear = serializeCookie(SESSION_COOKIE, '', 0);
          redirect(res, returnTo, 302, [clear]);
          return;
        }

        const github = typeof req.query.github === 'string' ? req.query.github.trim() : '';
        const discord = typeof req.query.discord === 'string' ? req.query.discord.trim() : '';
        const avatar = sanitizeDiscordAvatarHash(req.query.avatar);
        const username = typeof req.query.username === 'string' && req.query.username.trim()
          ? req.query.username.trim()
          : (github || 'dev');

        if (!github && !discord) {
          const current = this.getSession(req);
          const currentDesc = current
            ? escapeHtml(JSON.stringify({github: current.github, discord: current.discord}))
            : 'unauthenticated';
          const ret = encodeURIComponent(returnTo);
          const body =
            `<p class="muted">Current session: <code>${currentDesc}</code></p>` +
            '<p><a href="/auth/dev?github=scheibo&amp;discord=513513270670262284' +
            `&amp;username=scheibo&amp;return_to=${ret}">Sign in as admin (scheibo)</a></p>` +
            `<p><a href="/auth/dev?github=pmariglia&amp;return_to=${ret}">` +
            'Sign in as competitor (pmariglia)</a></p>' +
            `<p><a href="/auth/dev?github=stranger&amp;return_to=${ret}">` +
            'Sign in as unregistered GitHub user (stranger)</a></p>' +
            '<p><a href="/auth/dev?discord=999999999999999999&amp;username=outsider' +
            `&amp;return_to=${ret}">Sign in as non-guild Discord user</a></p>` +
            `<p><a href="/auth/dev?clear=1&amp;return_to=${ret}">Clear session</a></p>`;
          sendHtml(res, 200, renderer.render({
            id: 'dev-auth',
            title: 'Dev Auth | pkmn.ai',
            header: header('Dev Auth'),
            path: '/auth/dev',
            content: body,
            style: 'main { max-width: 65ch; margin: 2rem auto; text-align: center; }',
          }));
          return;
        }

        const existing = this.getSession(req);
        const devRow = github ? this.db?.getDeveloperByGitHub(github) : undefined;
        const cookie = this.issueSessionCookie({
          ...(github
            ? {github: {id: devRow?.githubId ?? 0, login: github}}
            : existing?.github ? {github: existing.github} : {}),
          ...(discord
            ? {discord: {id: discord, username, ...(avatar ? {avatar} : {})}}
            : existing?.discord ? {discord: existing.discord} : {}),
        });
        const target =
          github && isAccountReturnTo(returnTo) && isAdmin(github) && !devRow
            ? '/admin/'
            : returnTo;
        redirect(res, target, 302, [cookie]);
      });
    }

    app.get('/auth/github', (req, res) => {
      const cfg = this.getConfig();
      const returnTo = sanitizeReturnTo(req.query.return_to, '/account/');
      if (!cfg?.github) {
        if (this.isDevAuthEnabled() && isLoopbackAddress(req.socket.remoteAddress)) {
          redirect(res, `/auth/dev?return_to=${encodeURIComponent(returnTo)}`);
          return;
        }
        sendError(res, 503);
        return;
      }
      const redirectUri = `${inferOrigin(req)}/auth/github/callback`;
      const nonce = crypto.randomBytes(16).toString('hex');
      const exp = Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS;
      const statePayload: OAuthStatePayload = {
        provider: 'github',
        nonce,
        returnTo,
        redirectUri,
        exp,
      };
      const stateToken = signToken(statePayload, cfg.sessionSecret);
      const cookie = serializeCookie(STATE_COOKIE, stateToken, STATE_TTL_SECONDS);

      const params = new URLSearchParams({
        client_id: cfg.github.clientId,
        redirect_uri: redirectUri,
        scope: 'read:user',
        state: nonce,
      });
      redirect(res, `https://github.com/login/oauth/authorize?${params.toString()}`, 302, [cookie]);
    });

    app.get('/auth/github/callback', async (req, res) => {
      const cfg = this.getConfig();
      if (!cfg?.github) {
        sendError(res, 503);
        return;
      }
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      const state = typeof req.query.state === 'string' ? req.query.state : '';
      const saved = parseCookieValues(req.headers.cookie, STATE_COOKIE)
        .map(v => verifyToken<OAuthStatePayload>(v, cfg.sessionSecret))
        .find(s => s?.provider === 'github' && s.nonce === state);
      const clearState = serializeCookie(STATE_COOKIE, '', 0);

      if (!code || !state || !saved) {
        sendError(res, 400, [clearState]);
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
            client_id: cfg.github.clientId,
            client_secret: cfg.github.clientSecret,
            code,
            redirect_uri: saved.redirectUri,
          }),
          signal: AbortSignal.timeout(15_000),
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
          signal: AbortSignal.timeout(15_000),
        });
        if (!userRes.ok) throw new Error(`GitHub user fetch failed (${userRes.status})`);
        const userData = await userRes.json() as {id?: number; login?: string};
        if (
          !userData.login ||
          typeof userData.id !== 'number' ||
          !Number.isInteger(userData.id) ||
          userData.id <= 0
        ) {
          throw new Error('Missing or invalid id/login from GitHub user API');
        }

        const githubId = userData.id;
        const byId = this.db?.getDeveloperByGitHubId(githubId);
        const login = byId?.githubLogin ?? userData.login;
        const byLogin = this.db?.getDeveloperByGitHub(login);
        const isSquatter = byLogin?.githubId !== undefined && byLogin.githubId !== githubId;
        if (!this.isAuthorizedGitHub(login) || isSquatter) {
          // Send unregistered visitors (including former owners whose `arena:` block was removed
          // from `projects.yml` and whose developer rows were pruned) straight to the GitHub
          // registration issue when returning to `/account/`, while keeping generic 403s for
          // registered developers on blocked/disabled records, handle squatters, and `/wiki/*`.
          if (!byId && !byLogin && !isSquatter && isAccountReturnTo(saved.returnTo)) {
            redirect(res, REGISTER_ISSUE_URL, 302, [clearState]);
            return;
          }
          sendError(res, 403, [clearState]);
          return;
        }

        this.db?.linkDeveloperGitHubId(login, githubId);

        const existing = this.getSession(req);
        const sessionCookie = this.issueSessionCookie({
          github: {id: githubId, login},
          ...(existing?.discord ? {discord: existing.discord} : {}),
        });
        const rawTarget = sanitizeReturnTo(saved.returnTo, '/account/');
        const target =
          isAccountReturnTo(rawTarget) && isAdmin(login) && !byId && !byLogin
            ? '/admin/'
            : rawTarget;
        redirect(res, target, 302, [
          sessionCookie,
          clearState,
        ]);
      } catch (err) {
        console.error('GitHub OAuth error:', err);
        sendError(res, 502, [clearState]);
      }
    });

    app.get('/auth/discord', (req, res) => {
      const cfg = this.getConfig();
      const intent: 'login' | 'link' = req.query.intent === 'link' ? 'link' : 'login';
      const returnTo = sanitizeReturnTo(
        req.query.return_to,
        intent === 'link' ? '/account/' : '/'
      );
      if (!cfg?.discord) {
        if (this.isDevAuthEnabled() && isLoopbackAddress(req.socket.remoteAddress)) {
          redirect(res, `/auth/dev?return_to=${encodeURIComponent(returnTo)}`);
          return;
        }
        sendError(res, 503);
        return;
      }

      let linkGitHubLogin: string | undefined;
      if (intent === 'link') {
        const ghLogin = this.getGitHubUser(req);
        if (!ghLogin) {
          const resume = `/auth/discord?intent=link&return_to=${encodeURIComponent(returnTo)}`;
          redirect(res, `/auth/github?return_to=${encodeURIComponent(resume)}`);
          return;
        }
        if (!this.isAuthorizedGitHub(ghLogin)) {
          sendError(res, 403);
          return;
        }
        linkGitHubLogin = ghLogin.toLowerCase();
      }

      const redirectUri = `${inferOrigin(req)}/auth/discord/callback`;
      const nonce = crypto.randomBytes(16).toString('hex');
      const exp = Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS;
      const statePayload: OAuthStatePayload = {
        provider: 'discord',
        intent,
        ...(linkGitHubLogin ? {githubLogin: linkGitHubLogin} : {}),
        nonce,
        returnTo,
        redirectUri,
        exp,
      };
      const stateToken = signToken(statePayload, cfg.sessionSecret);
      const cookie = serializeCookie(STATE_COOKIE, stateToken, STATE_TTL_SECONDS);

      const params = new URLSearchParams({
        client_id: cfg.discord.clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        scope: 'identify',
        state: nonce,
      });
      redirect(res, `https://discord.com/oauth2/authorize?${params.toString()}`, 302, [cookie]);
    });

    app.get('/auth/discord/callback', async (req, res) => {
      const cfg = this.getConfig();
      if (!cfg?.discord) {
        sendError(res, 503);
        return;
      }
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      const state = typeof req.query.state === 'string' ? req.query.state : '';
      const saved = parseCookieValues(req.headers.cookie, STATE_COOKIE)
        .map(v => verifyToken<OAuthStatePayload>(v, cfg.sessionSecret))
        .find(s => s?.provider === 'discord' && s.nonce === state);
      const clearState = serializeCookie(STATE_COOKIE, '', 0);

      if (!code || !state || !saved) {
        sendError(res, 400, [clearState]);
        return;
      }

      try {
        const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
          method: 'POST',
          headers: {'Content-Type': 'application/x-www-form-urlencoded'},
          body: new URLSearchParams({
            client_id: cfg.discord.clientId,
            client_secret: cfg.discord.clientSecret,
            grant_type: 'authorization_code',
            code,
            redirect_uri: saved.redirectUri,
          }).toString(),
          signal: AbortSignal.timeout(15_000),
        });
        if (!tokenRes.ok) throw new Error(`Discord token exchange failed (${tokenRes.status})`);
        const tokenData = await tokenRes.json() as {access_token?: string};
        if (!tokenData.access_token) throw new Error('Missing access_token from Discord');

        const userRes = await fetch(`${DISCORD_API}/users/@me`, {
          headers: {Authorization: `Bearer ${tokenData.access_token}`},
          signal: AbortSignal.timeout(15_000),
        });
        if (!userRes.ok) throw new Error(`Discord user fetch failed (${userRes.status})`);
        const userData = await userRes.json() as {
          id?: string;
          username?: string;
          avatar?: string | null;
        };
        if (!userData.id || !/^\d+$/.test(userData.id) || !userData.username) {
          throw new Error('Invalid user profile returned by Discord');
        }
        const avatar = sanitizeDiscordAvatarHash(userData.avatar);

        const existing = this.getSession(req);
        if (saved.intent === 'link') {
          const ghLogin = this.getGitHubUser(req);
          if (
            !ghLogin ||
            !this.isAuthorizedGitHub(ghLogin) ||
            (saved.githubLogin && saved.githubLogin !== ghLogin.toLowerCase())
          ) {
            sendError(res, 403, [clearState]);
            return;
          }
          if (this.db) {
            const conflict = this.db.getDeveloperByDiscordId(userData.id);
            if (conflict && conflict.githubLogin !== ghLogin.toLowerCase()) {
              sendError(res, 409, [clearState]);
              return;
            }
            this.db.linkDeveloperDiscord(ghLogin, userData.id, userData.username);
          }
        }

        const sessionCookie = this.issueSessionCookie({
          ...(existing?.github ? {github: existing.github} : {}),
          discord: {
            id: userData.id,
            username: userData.username,
            ...(avatar ? {avatar} : {}),
          },
        });
        redirect(res, sanitizeReturnTo(saved.returnTo, '/'), 302, [sessionCookie, clearState]);
      } catch (err) {
        console.error('Discord OAuth error:', err);
        sendError(res, 502, [clearState]);
      }
    });

    app.post('/api/account/discord/unlink', (req, res) => {
      if (isCrossSiteRequest(req)) {
        res.writeHead(403, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'private, no-store',
        });
        res.end(JSON.stringify({error: 'Cross-site requests are not allowed.'}));
        return;
      }
      const ghLogin = this.getGitHubUser(req);
      if (!ghLogin || !this.isAuthorizedGitHub(ghLogin)) {
        res.writeHead(401, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'private, no-store',
        });
        res.end(JSON.stringify({error: 'Unauthorized'}));
        return;
      }

      this.db?.unlinkDeveloperDiscord(ghLogin);

      if (req.headers.accept?.includes('application/json')) {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'private, no-store',
        });
        res.end(JSON.stringify({ok: true}));
        return;
      }
      redirect(res, '/account/', 303);
    });

    app.get('/api/me', (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'private, no-store',
      });
      res.end(JSON.stringify(this.getProfile(req)));
    });

    app.post('/auth/logout', (req, res) => {
      if (isCrossSiteRequest(req)) {
        res.writeHead(403, {'Cache-Control': 'private, no-store'});
        res.end();
        return;
      }
      const clearSession = serializeCookie(SESSION_COOKIE, '', 0);
      redirect(res, sanitizeReturnTo(req.query.return_to, '/'), 303, [clearSession]);
    });

    // Subrequest endpoint called by Nginx `auth_request` on `/chat/logs/` (requires Discord guild
    // membership) and `/private/` (`?guild=0`, accepts any signed-in Discord identity).
    app.get('/auth/discord/validate', (req, res) => {
      const session = this.getSession(req);
      if (!session?.discord?.id) {
        res.writeHead(401, {'Cache-Control': 'private, no-store'});
        res.end();
        return;
      }
      const skipGuild = req.query.guild === '0';
      if (!skipGuild && !this.isDiscordGuildMember(session.discord.id)) {
        res.writeHead(403, {'Cache-Control': 'private, no-store'});
        res.end();
        return;
      }
      res.writeHead(200, {
        'Cache-Control': 'private, no-store',
        'X-Auth-User': session.discord.id,
      });
      res.end();
    });

    app.get('/chat/logs/token', (req, res) => {
      // Reject cross-site requests and cross-origin fetches so external pages cannot read
      // session tokens even if SameSite cookie policies are bypassed.
      if (isCrossSiteRequest(req)) {
        res.writeHead(403, {'Cache-Control': 'private, no-store'});
        res.end();
        return;
      }
      const resolved = this.resolveSession(req);
      const session = resolved?.session;
      const token = resolved?.token;
      if (!session?.discord?.id || !token) {
        if (req.headers.authorization) {
          res.writeHead(401, {'Cache-Control': 'private, no-store'});
          res.end();
          return;
        }
        redirect(res, '/auth/discord?return_to=%2Fchat%2Flogs%2Ftoken');
        return;
      }
      if (!this.isDiscordGuildMember(session.discord.id)) {
        sendError(res, 403);
        return;
      }
      // Mint a Discord-scoped token if the session also carries a GitHub developer claim so
      // CLI tokens for `/chat/logs/` cannot be used to authenticate GitHub-gated mutations.
      const cfg = this.getConfig()!;
      const cliToken = session.github
        ? signToken({discord: session.discord, exp: session.exp}, cfg.sessionSecret)
        : token;
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'private, no-store',
      });
      res.end(`${cliToken}\n`);
    });

    return this;
  }
}
