import * as crypto from 'crypto';
import * as http from 'http';

import type polka from 'polka';

import {header, renderer} from '../static/build';
import {escapeHtml} from '../static/util';

import type {ArenaDB} from './db';

export const SESSION_COOKIE = 'pkmn_session';
export const STATE_COOKIE = 'pkmn_oauth_state';
export const SESSION_TTL_S = 30 * 24 * 60 * 60;
export const STATE_TTL_S = 10 * 60;

const REGISTER_ISSUE_URL = 'https://github.com/pkmn/ai/issues/new?template=register.yml';
const DISCORD_API = 'https://discord.com/api/v10';

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
}

export interface AuthConfig {
  sessionSecret: string;
  arenaSecret?: string;
  github?: OAuthProviderConfig;
  discord?: OAuthProviderConfig;
}

export interface Session {
  github?: {id: number; login: string};
  discord?: {id: string; username: string};
  exp: number;
}

interface OAuthStatePayload {
  provider: 'github' | 'discord';
  intent?: 'login' | 'link';
  nonce: string;
  returnTo: string;
  redirectUri: string;
  exp: number;
}

export interface AuthOptions {
  config?: AuthConfig;
  db?: ArenaDB;
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

export function serializeCookie(name: string, value: string, maxAgeSeconds: number): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const encoded = value ? encodeURIComponent(value) : '';
  return `${name}=${encoded}; HttpOnly; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax${secure}`;
}

export function sanitizeReturnTo(raw: unknown, fallback = '/'): string {
  if (typeof raw !== 'string') return fallback;
  if (!raw.startsWith('/') || raw.startsWith('//') || /[\r\n]/.test(raw)) return fallback;
  return raw;
}

export function extractSessionToken(headers: http.IncomingHttpHeaders): string | undefined {
  const auth = headers.authorization;
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
    if (m) return m[1];
  }
  return parseCookies(headers.cookie)[SESSION_COOKIE];
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig | undefined {
  const sessionSecret = env.SESSION_SECRET?.trim();
  if (!sessionSecret) return undefined;

  const ghClientId = env.GITHUB_CLIENT_ID?.trim();
  const ghClientSecret = env.GITHUB_CLIENT_SECRET?.trim();
  const github = ghClientId && ghClientSecret
    ? {clientId: ghClientId, clientSecret: ghClientSecret}
    : undefined;

  const discordClientId = env.DISCORD_CLIENT_ID?.trim();
  const discordClientSecret = env.DISCORD_CLIENT_SECRET?.trim();
  const discord = discordClientId && discordClientSecret
    ? {clientId: discordClientId, clientSecret: discordClientSecret}
    : undefined;

  const arenaSecret = env.ARENA_SECRET?.trim() || undefined;

  return {sessionSecret, arenaSecret, github, discord};
}

function renderAuthError(status: number, content: string, pagePath = '/account/'): string {
  return renderer.render({
    id: 'error',
    title: `${status} | pkmn.ai`,
    header: header(String(status)),
    path: pagePath,
    content,
    style: `
      #error h2 {
        text-decoration: none;
        font-size: 20vh;
        margin: 0;
      }
      #error main {
        font-size: 1.2em;
        position: relative;
        top: -4vh;
        text-align: center;
      }`,
  }).replace('<meta content="pkmn.ai" name="author">',
    '<meta content="pkmn.ai" name="author">\n<meta content="noindex" name="robots">');
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
  const forwardedProto = req.headers['x-forwarded-proto'];
  const proto = typeof forwardedProto === 'string' && forwardedProto.startsWith('https')
    ? 'https'
    : process.env.NODE_ENV === 'production' ? 'https' : 'http';
  const host = req.headers.host || '127.0.0.1:1234';
  return `${proto}://${host}`;
}

export class Auth {
  readonly db?: ArenaDB;
  private readonly explicitConfig?: AuthConfig;
  private readonly customAuthorizedGitHub?: (login: string) => boolean;
  private readonly customDiscordMember?: (discordId: string) => boolean;
  private registeredApps = new Set<polka.Polka>();

  constructor(options: AuthOptions = {}) {
    this.explicitConfig = options.config;
    this.db = options.db;
    this.customAuthorizedGitHub = options.isAuthorizedGitHub;
    this.customDiscordMember = options.isDiscordMember;
  }

  getConfig(): AuthConfig | undefined {
    return this.explicitConfig ?? loadAuthConfig();
  }

  getSession(req: http.IncomingMessage): Session | undefined {
    const cfg = this.getConfig();
    if (!cfg) return undefined;
    const token = extractSessionToken(req.headers);
    return verifyToken<Session>(token, cfg.sessionSecret);
  }

  getGitHubUser(req: http.IncomingMessage): string | undefined {
    const cfg = this.getConfig();
    if (!cfg?.github) {
      return process.env.NODE_ENV === 'development'
        ? process.env.WIKI_DEV_USER || 'scheibo'
        : undefined;
    }
    return this.getSession(req)?.github?.login;
  }

  isAuthorizedGitHub(login: string | undefined): boolean {
    if (!login) return false;
    const lower = login.trim().toLowerCase();
    if (!lower) return false;
    if (this.customAuthorizedGitHub?.(lower)) return true;
    return Boolean(this.db?.getDeveloperByGitHub(lower));
  }

  isDiscordGuildMember(discordId: string | undefined): boolean {
    if (!discordId) return false;
    if (this.customDiscordMember) return this.customDiscordMember(discordId);
    return Boolean(this.db?.isDiscordMember(discordId));
  }

  verifyDiscordAuth(req: http.IncomingMessage): 'authorized' | 'unauthenticated' | 'forbidden' {
    const cfg = this.getConfig();
    if (!cfg && process.env.NODE_ENV === 'development') return 'authorized';
    const session = this.getSession(req);
    if (!session?.discord?.id) return 'unauthenticated';
    return this.isDiscordGuildMember(session.discord.id) ? 'authorized' : 'forbidden';
  }

  issueSessionCookie(session: Omit<Session, 'exp'>, now = Math.floor(Date.now() / 1000)): string {
    const cfg = this.getConfig();
    if (!cfg) throw new Error('SESSION_SECRET is not configured');
    const token = signToken({...session, exp: now + SESSION_TTL_S}, cfg.sessionSecret);
    return serializeCookie(SESSION_COOKIE, token, SESSION_TTL_S);
  }

  register(app: polka.Polka): this {
    if (this.registeredApps.has(app)) return this;
    this.registeredApps.add(app);

    app.get('/auth/github', (req, res) => {
      const cfg = this.getConfig();
      if (!cfg?.github) {
        sendHtml(res, 503, renderAuthError(503, '<p>GitHub OAuth is not configured.</p>'));
        return;
      }
      const returnTo = sanitizeReturnTo(req.query.return_to, '/account/');
      const redirectUri = `${inferOrigin(req)}/auth/github/callback`;
      const nonce = crypto.randomBytes(16).toString('hex');
      const exp = Math.floor(Date.now() / 1000) + STATE_TTL_S;
      const statePayload: OAuthStatePayload = {
        provider: 'github',
        nonce,
        returnTo,
        redirectUri,
        exp,
      };
      const stateToken = signToken(statePayload, cfg.sessionSecret);
      const cookie = serializeCookie(STATE_COOKIE, stateToken, STATE_TTL_S);

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
        sendHtml(res, 503, renderAuthError(503, '<p>GitHub OAuth is not configured.</p>'));
        return;
      }
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      const state = typeof req.query.state === 'string' ? req.query.state : '';
      const cookies = parseCookies(req.headers.cookie);
      const saved = verifyToken<OAuthStatePayload>(cookies[STATE_COOKIE], cfg.sessionSecret);
      const clearState = serializeCookie(STATE_COOKIE, '', 0);

      if (!code || !state || saved?.provider !== 'github' || saved.nonce !== state) {
        sendHtml(
          res,
          400,
          renderAuthError(400, '<p>Invalid or expired OAuth state.</p>'),
          [clearState]
        );
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
        const userData = await userRes.json() as {id?: number; login?: string};
        if (!userData.login) throw new Error('Missing login from GitHub user API');

        const login = userData.login;
        if (!this.isAuthorizedGitHub(login)) {
          sendHtml(
            res,
            403,
            renderAuthError(
              403,
              `<p>GitHub account <code>${escapeHtml(login)}</code> ` +
              'is not registered for pkmn.ai competitions.</p>' +
              `<p><a href="${REGISTER_ISSUE_URL}">Register a project on GitHub</a>.</p>`
            ),
            [clearState]
          );
          return;
        }

        const githubId = typeof userData.id === 'number' ? userData.id : 0;
        if (githubId > 0) {
          this.db?.linkDeveloperGitHubId(login, githubId);
        }

        const existing = this.getSession(req);
        const sessionCookie = this.issueSessionCookie({
          github: {id: githubId, login},
          ...(existing?.discord ? {discord: existing.discord} : {}),
        });
        redirect(res, sanitizeReturnTo(saved.returnTo, '/account/'), 302, [
          sessionCookie,
          clearState,
        ]);
      } catch (err) {
        console.error('GitHub OAuth error:', err);
        sendHtml(
          res,
          502,
          renderAuthError(502, '<p>Failed to authenticate with GitHub.</p>'),
          [clearState]
        );
      }
    });

    app.get('/auth/discord', (req, res) => {
      const cfg = this.getConfig();
      if (!cfg?.discord) {
        sendHtml(res, 503, renderAuthError(503, '<p>Discord OAuth is not configured.</p>'));
        return;
      }
      const intent: 'login' | 'link' = req.query.intent === 'link' ? 'link' : 'login';
      const returnTo = sanitizeReturnTo(
        req.query.return_to,
        intent === 'link' ? '/account/' : '/'
      );

      if (intent === 'link') {
        const session = this.getSession(req);
        if (!session?.github?.login) {
          const resume = `/auth/discord?intent=link&return_to=${encodeURIComponent(returnTo)}`;
          redirect(res, `/auth/github?return_to=${encodeURIComponent(resume)}`);
          return;
        }
        if (!this.isAuthorizedGitHub(session.github.login)) {
          sendHtml(
            res,
            403,
            renderAuthError(
              403,
              `<p>GitHub account <code>${escapeHtml(session.github.login)}</code> ` +
              'is not registered for pkmn.ai competitions.</p>'
            )
          );
          return;
        }
      }

      const redirectUri = `${inferOrigin(req)}/auth/discord/callback`;
      const nonce = crypto.randomBytes(16).toString('hex');
      const exp = Math.floor(Date.now() / 1000) + STATE_TTL_S;
      const statePayload: OAuthStatePayload = {
        provider: 'discord',
        intent,
        nonce,
        returnTo,
        redirectUri,
        exp,
      };
      const stateToken = signToken(statePayload, cfg.sessionSecret);
      const cookie = serializeCookie(STATE_COOKIE, stateToken, STATE_TTL_S);

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
        sendHtml(res, 503, renderAuthError(503, '<p>Discord OAuth is not configured.</p>'));
        return;
      }
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      const state = typeof req.query.state === 'string' ? req.query.state : '';
      const cookies = parseCookies(req.headers.cookie);
      const saved = verifyToken<OAuthStatePayload>(cookies[STATE_COOKIE], cfg.sessionSecret);
      const clearState = serializeCookie(STATE_COOKIE, '', 0);

      if (!code || !state || saved?.provider !== 'discord' || saved.nonce !== state) {
        sendHtml(
          res,
          400,
          renderAuthError(400, '<p>Invalid or expired OAuth state.</p>'),
          [clearState]
        );
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
        });
        if (!tokenRes.ok) throw new Error(`Discord token exchange failed (${tokenRes.status})`);
        const tokenData = await tokenRes.json() as {access_token?: string};
        if (!tokenData.access_token) throw new Error('Missing access_token from Discord');

        const userRes = await fetch(`${DISCORD_API}/users/@me`, {
          headers: {Authorization: `Bearer ${tokenData.access_token}`},
        });
        if (!userRes.ok) throw new Error(`Discord user fetch failed (${userRes.status})`);
        const userData = await userRes.json() as {id?: string; username?: string};
        if (!userData.id || !/^\d+$/.test(userData.id) || !userData.username) {
          throw new Error('Invalid user profile returned by Discord');
        }

        const existing = this.getSession(req);
        if (saved.intent === 'link') {
          const ghLogin = existing?.github?.login;
          if (!ghLogin || !this.isAuthorizedGitHub(ghLogin)) {
            sendHtml(
              res,
              403,
              renderAuthError(403, '<p>GitHub developer session required to link Discord.</p>'),
              [clearState]
            );
            return;
          }
          if (this.db) {
            const conflict = this.db.getDeveloperByDiscordId(userData.id);
            if (conflict && conflict.github_login !== ghLogin.toLowerCase()) {
              sendHtml(
                res,
                409,
                renderAuthError(
                  409,
                  `<p>Discord account <code>@${escapeHtml(userData.username)}</code> ` +
                  'is already linked to another developer.</p>'
                ),
                [clearState]
              );
              return;
            }
            this.db.linkDeveloperDiscord(ghLogin, userData.id, userData.username);
          }
        }

        const sessionCookie = this.issueSessionCookie({
          ...(existing?.github ? {github: existing.github} : {}),
          discord: {id: userData.id, username: userData.username},
        });
        redirect(res, sanitizeReturnTo(saved.returnTo, '/'), 302, [sessionCookie, clearState]);
      } catch (err) {
        console.error('Discord OAuth error:', err);
        sendHtml(
          res,
          502,
          renderAuthError(502, '<p>Failed to authenticate with Discord.</p>'),
          [clearState]
        );
      }
    });

    app.post('/api/account/discord/unlink', (req, res) => {
      const session = this.getSession(req);
      const ghLogin = session?.github?.login;
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

    app.post('/auth/logout', (req, res) => {
      const clearSession = serializeCookie(SESSION_COOKIE, '', 0);
      redirect(res, sanitizeReturnTo(req.query.return_to, '/'), 303, [clearSession]);
    });

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
      const token = extractSessionToken(req.headers);
      const session = this.getSession(req);
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
        sendHtml(
          res,
          403,
          renderAuthError(
            403,
            '<p>Your Discord account is not a member of the pkmn.ai Discord server.</p>',
            '/chat/logs/'
          )
        );
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'private, no-store',
      });
      res.end(`${token}\n`);
    });

    return this;
  }
}

export function register(app: polka.Polka, options: AuthOptions = {}): Auth {
  const auth = new Auth(options);
  return auth.register(app);
}
