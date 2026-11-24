import * as http from 'http';

import polka from 'polka';

import {Database} from '../db';
import type * as db from '../db';
import * as auth from '../server/auth';

const AUTH_CFG: auth.Config = {
  sessionSecret: 'test-unified-session-secret',
  github: {
    clientId: 'gh-client-id',
    clientSecret: 'gh-client-secret',
  },
  discord: {
    clientId: '689315793569447954',
    clientSecret: 'discord-client-secret',
  },
};

const PROJECTS_YAML = `
- name: 0 ERROR
  active: 2026
  arena:
    owners:
      pre: pre.10544
      coauthor: coauthor.20001
- name: Foul Play
  active: 2026
  arena:
    owners:
      pmariglia: pmariglia.535629
`;

function extractCookieMap(res: Response): Record<string, string> {
  const getSetCookie = (res.headers as unknown as {getSetCookie?: () => string[]}).getSetCookie;
  const rawCookies = getSetCookie
    ? getSetCookie.call(res.headers)
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')!] : []);
  const out: Record<string, string> = {};
  for (const raw of rawCookies) {
    const first = raw.split(';')[0];
    const eq = first.indexOf('=');
    if (eq > 0) {
      out[first.slice(0, eq).trim()] = decodeURIComponent(first.slice(eq + 1).trim());
    }
  }
  return out;
}

describe('auth config helpers', () => {
  test('sanitizeReturnTo preserves relative local paths', () => {
    expect(auth.sanitizeReturnTo('/account/', '/')).toBe('/account/');
    expect(auth.sanitizeReturnTo('/wiki/projects/0_ERROR?diff=1', '/')).toBe(
      '/wiki/projects/0_ERROR?diff=1'
    );
    expect(auth.sanitizeReturnTo(undefined, '/fallback')).toBe('/fallback');
  });

  test('sanitizeReturnTo blocks external redirects or CRLF header injection', () => {
    expect(auth.sanitizeReturnTo('//evil.example/phish', '/')).toBe('/');
    expect(auth.sanitizeReturnTo('https://evil.example', '/')).toBe('/');
    expect(auth.sanitizeReturnTo('/bad\r\nSet-Cookie: x=1', '/')).toBe('/');
  });

  test('sanitizeReturnTo blocks backslash-prefixed scheme-relative paths', () => {
    expect(auth.sanitizeReturnTo('/\\evil.example/phish', '/')).toBe('/');
    expect(auth.sanitizeReturnTo('/foo\\bar', '/')).toBe('/');
  });

  test('loadConfig returns undefined without SESSION_SECRET or DEV_AUTH', () => {
    expect(auth.loadConfig({})).toBeUndefined();
  });

  test('loadConfig generates ephemeral session secret in DEV_AUTH mode', () => {
    const devCfg = auth.loadConfig({DEV_AUTH: '1'});
    expect(devCfg?.sessionSecret).toBeTruthy();
  });

  test('loadConfig parses flat OAuth environment variables', () => {
    expect(auth.loadConfig({
      SESSION_SECRET: 'sec-1',
      GITHUB_CLIENT_ID: 'gh-id',
    })).toEqual({
      sessionSecret: 'sec-1',
      github: undefined,
      discord: undefined,
    });

    expect(auth.loadConfig({
      SESSION_SECRET: 'sec-2',
      GITHUB_CLIENT_ID: 'gh-id',
      GITHUB_CLIENT_SECRET: 'gh-sec',
      DISCORD_CLIENT_ID: '689315793569447954',
      DISCORD_CLIENT_SECRET: 'disc-sec',
    })).toEqual({
      sessionSecret: 'sec-2',
      github: {clientId: 'gh-id', clientSecret: 'gh-sec'},
      discord: {clientId: '689315793569447954', clientSecret: 'disc-sec'},
    });
  });

  test('loadConfig ignores env OAuth credentials in DEV_AUTH mode', () => {
    const devCfg = auth.loadConfig({
      DEV_AUTH: '1',
      SESSION_SECRET: 'sec-dev',
      GITHUB_CLIENT_ID: 'gh-id',
      GITHUB_CLIENT_SECRET: 'gh-sec',
      DISCORD_CLIENT_ID: '689315793569447954',
      DISCORD_CLIENT_SECRET: 'disc-sec',
    });
    expect(devCfg).toEqual({
      sessionSecret: 'sec-dev',
      github: undefined,
      discord: undefined,
    });
  });
});

describe('server/auth.ts routes', () => {
  let db: db.Database;
  let server: http.Server;
  let baseUrl: string;
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.syncProjectsFromYaml(PROJECTS_YAML);
    db.syncDiscordMembers([
      {id: '513513270670262284', username: 'scheibo'},
      {id: '283674461268344832', username: 'pmariglia'},
    ]);

    const app = polka();
    new auth.Auth({config: AUTH_CFG, db, devAuth: true}).register(app);

    server = http.createServer((req, res) => app.handler(req as polka.Request, res));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as {port: number};
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
  });

  const signSession = (payload: Omit<auth.Session, 'exp'>) =>
    auth.signToken(
      {...payload, exp: Math.floor(Date.now() / 1000) + 3600},
      AUTH_CFG.sessionSecret
    );

  const mockGitHubUser = (ghUser: {id: number; login: string}) => {
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://github.com/login/oauth/access_token') {
        return new Response(JSON.stringify({access_token: 'gho_123'}), {status: 200});
      }
      if (url === 'https://api.github.com/user') {
        return new Response(JSON.stringify(ghUser), {status: 200});
      }
      return realFetch(input, init);
    };
  };

  const mockDiscordUser = (
    profile: {id: string; username: string; avatar?: string | null},
    onTokenBody?: (body: string) => void
  ) => {
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://discord.com/api/v10/oauth2/token') {
        onTokenBody?.(typeof init?.body === 'string' ? init.body : '');
        return new Response(JSON.stringify({access_token: 'disc_tok'}), {status: 200});
      }
      if (url === 'https://discord.com/api/v10/users/@me') {
        return new Response(JSON.stringify(profile), {status: 200});
      }
      return realFetch(input, init);
    };
  };

  const beginGitHubOAuth = async (returnTo = '/account/') => {
    const startRes = await realFetch(
      `${baseUrl}/auth/github?return_to=${encodeURIComponent(returnTo)}`,
      {redirect: 'manual'}
    );
    expect(startRes.status).toBe(302);
    const ghAuthorize = new URL(startRes.headers.get('location')!);
    return {
      origin: ghAuthorize.origin,
      state: ghAuthorize.searchParams.get('state')!,
      stateCookie: extractCookieMap(startRes).pkmn_oauth_state,
    };
  };

  const beginDiscordLink = async (ghSessionToken: string) => {
    const startRes = await realFetch(`${baseUrl}/auth/discord?intent=link`, {
      headers: {Cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(ghSessionToken)}`},
      redirect: 'manual',
    });
    expect(startRes.status).toBe(302);
    const discordAuthUrl = new URL(startRes.headers.get('location')!);
    return {
      url: discordAuthUrl,
      state: discordAuthUrl.searchParams.get('state')!,
      stateCookie: extractCookieMap(startRes).pkmn_oauth_state,
    };
  };

  test('rejects GitHub OAuth callbacks with tampered state', async () => {
    const {origin, stateCookie} = await beginGitHubOAuth();
    expect(origin).toBe('https://github.com');

    const badState = await realFetch(`${baseUrl}/auth/github/callback?code=c1&state=wrong`, {
      headers: {Cookie: `pkmn_oauth_state=${encodeURIComponent(stateCookie)}`},
      redirect: 'manual',
    });
    expect(badState.status).toBe(400);
  });

  test('redirects unregistered GitHub OAuth callbacks for /account/ to the registration issue',
    async () => {
      const {state, stateCookie} = await beginGitHubOAuth('/account/');
      mockGitHubUser({id: 99999, login: 'unregistered_user'});

      const strangerCb = await realFetch(
        `${baseUrl}/auth/github/callback?code=c1&state=${encodeURIComponent(state)}`,
        {
          headers: {Cookie: `pkmn_oauth_state=${encodeURIComponent(stateCookie)}`},
          redirect: 'manual',
        }
      );
      expect(strangerCb.status).toBe(302);
      expect(strangerCb.headers.get('location')).toBe(auth.REGISTER_ISSUE_URL);
      const cookies = extractCookieMap(strangerCb);
      expect(cookies[auth.STATE_COOKIE]).toBe('');
      expect(cookies[auth.SESSION_COOKIE]).toBeUndefined();
    });

  test('rejects unregistered GitHub OAuth callbacks for /wiki/ with 403', async () => {
    const {state, stateCookie} = await beginGitHubOAuth('/wiki/projects/0_ERROR');
    mockGitHubUser({id: 99999, login: 'unregistered_user'});

    const strangerCb = await realFetch(
      `${baseUrl}/auth/github/callback?code=c1&state=${encodeURIComponent(state)}`,
      {
        headers: {Cookie: `pkmn_oauth_state=${encodeURIComponent(stateCookie)}`},
        redirect: 'manual',
      }
    );
    expect(strangerCb.status).toBe(403);
    const strangerHtml = await strangerCb.text();
    expect(strangerHtml).toContain('<h2>403</h2>');
    expect(strangerHtml).toContain('<p>Forbidden</p>');
  });

  test('binds immutable githubId on GitHub OAuth login while keeping Discord claim', async () => {
    const existingDiscordToken = signSession({
      discord: {id: '513513270670262284', username: 'scheibo'},
    });
    const {state, stateCookie} = await beginGitHubOAuth();
    mockGitHubUser({id: 105440, login: 'pre'});

    const okCb = await realFetch(
      `${baseUrl}/auth/github/callback?code=c2&state=${encodeURIComponent(state)}`,
      {
        headers: {
          Cookie: [
            `pkmn_oauth_state=${encodeURIComponent(stateCookie)}`,
            `${auth.SESSION_COOKIE}=${encodeURIComponent(existingDiscordToken)}`,
          ].join('; '),
        },
        redirect: 'manual',
      }
    );
    expect(okCb.status).toBe(302);
    expect(okCb.headers.get('location')).toBe('/account/');

    const session = auth.verifyToken<auth.Session>(
      extractCookieMap(okCb)[auth.SESSION_COOKIE],
      AUTH_CFG.sessionSecret
    )!;
    expect(session.github).toEqual({id: 105440, login: 'pre'});
    expect(session.discord).toEqual({id: '513513270670262284', username: 'scheibo'});
    expect(db.getDeveloperByGitHub('pre')!.githubId).toBe(105440);
    expect(db.getDeveloperByGitHubId(105440)!.githubLogin).toBe('pre');
  });

  test('rejects handle squatters claiming a bound GitHub login with a different ID', async () => {
    db.linkDeveloperGitHubId('pre', 105440);
    const {state, stateCookie} = await beginGitHubOAuth();
    mockGitHubUser({id: 777777, login: 'pre'});

    const squatterCb = await realFetch(
      `${baseUrl}/auth/github/callback?code=c3&state=${encodeURIComponent(state)}`,
      {
        headers: {Cookie: `pkmn_oauth_state=${encodeURIComponent(stateCookie)}`},
        redirect: 'manual',
      }
    );
    expect(squatterCb.status).toBe(403);
    expect(db.getDeveloperByGitHub('pre')!.githubId).toBe(105440);
    expect(db.linkDeveloperGitHubId('pre', 777777)).toBe(false);
  });

  test('redirects unauthenticated Discord link requests to GitHub login', async () => {
    const unauthLink = await realFetch(`${baseUrl}/auth/discord?intent=link`, {redirect: 'manual'});
    expect(unauthLink.status).toBe(302);
    expect(unauthLink.headers.get('location')).toContain('/auth/github?return_to=');
  });

  test('links Discord account strictly to the authenticated developer', async () => {
    const preGhToken = signSession({github: {id: 10, login: 'pre'}});
    const {url, state, stateCookie} = await beginDiscordLink(preGhToken);
    expect(url.origin).toBe('https://discord.com');
    expect(url.searchParams.get('scope')).toBe('identify');

    let lastTokenBody = '';
    mockDiscordUser({id: '513513270670262284', username: 'scheibo'}, b => {
      lastTokenBody = b;
    });

    const linkCb = await realFetch(
      `${baseUrl}/auth/discord/callback?code=dc1&state=${encodeURIComponent(state)}`,
      {
        headers: {
          Cookie: [
            `pkmn_oauth_state=${encodeURIComponent(stateCookie)}`,
            `${auth.SESSION_COOKIE}=${encodeURIComponent(preGhToken)}`,
          ].join('; '),
        },
        redirect: 'manual',
      }
    );
    expect(linkCb.status).toBe(302);
    expect(linkCb.headers.get('location')).toBe('/account/');
    const tokenParams = auth.parseCookies(lastTokenBody.replace(/&/g, ';'));
    expect(tokenParams.redirect_uri).toBe(`${baseUrl}/auth/discord/callback`);

    expect(db.getDeveloperByGitHub('pre')!.discordId).toBe('513513270670262284');
    expect(db.getDeveloperByGitHub('pre')!.discordUsername).toBe('scheibo');
    expect(db.getDeveloperByGitHub('coauthor')!.discordId).toBeUndefined();

    const mergedSession = auth.verifyToken<auth.Session>(
      extractCookieMap(linkCb)[auth.SESSION_COOKIE],
      AUTH_CFG.sessionSecret
    )!;
    expect(mergedSession.github).toEqual({id: 10, login: 'pre'});
    expect(mergedSession.discord).toEqual({id: '513513270670262284', username: 'scheibo'});
  });

  test('rejects linking a Discord account already claimed by another developer', async () => {
    db.linkDeveloperDiscord('pre', '513513270670262284', 'scheibo');
    mockDiscordUser({id: '513513270670262284', username: 'scheibo'});

    const pmarToken = signSession({github: {id: 20, login: 'pmariglia'}});
    const {state, stateCookie} = await beginDiscordLink(pmarToken);

    const dupCb = await realFetch(
      `${baseUrl}/auth/discord/callback?code=dc2&state=${encodeURIComponent(state)}`,
      {
        headers: {
          Cookie: [
            `pkmn_oauth_state=${encodeURIComponent(stateCookie)}`,
            `${auth.SESSION_COOKIE}=${encodeURIComponent(pmarToken)}`,
          ].join('; '),
        },
        redirect: 'manual',
      }
    );
    expect(dupCb.status).toBe(409);
    expect(await dupCb.text()).toContain('<p>Conflict</p>');
  });

  test('rejects replaying another developer OAuth link state cookie', async () => {
    mockDiscordUser({id: '513513270670262284', username: 'scheibo'});
    const preGhToken = signSession({github: {id: 10, login: 'pre'}});
    const pmarToken = signSession({github: {id: 20, login: 'pmariglia'}});
    const {state, stateCookie} = await beginDiscordLink(pmarToken);

    const crossAccountCb = await realFetch(
      `${baseUrl}/auth/discord/callback?code=dc2&state=${encodeURIComponent(state)}`,
      {
        headers: {
          Cookie: [
            `pkmn_oauth_state=${encodeURIComponent(stateCookie)}`,
            `${auth.SESSION_COOKIE}=${encodeURIComponent(preGhToken)}`,
          ].join('; '),
        },
        redirect: 'manual',
      }
    );
    expect(crossAccountCb.status).toBe(403);
  });

  test('rejects cross-site POST requests to unlink or logout', async () => {
    const preGhToken = signSession({github: {id: 10, login: 'pre'}});

    const csrfUnlink = await realFetch(`${baseUrl}/api/account/discord/unlink`, {
      method: 'POST',
      headers: {
        Cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(preGhToken)}`,
        'Sec-Fetch-Site': 'cross-site',
        Accept: 'application/json',
      },
    });
    expect(csrfUnlink.status).toBe(403);

    const csrfLogout = await realFetch(`${baseUrl}/auth/logout`, {
      method: 'POST',
      headers: {
        Cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(preGhToken)}`,
        Origin: 'https://evil.example',
      },
      redirect: 'manual',
    });
    expect(csrfLogout.status).toBe(403);
  });

  test('unlinks Discord identity from developer account', async () => {
    db.linkDeveloperDiscord('pre', '513513270670262284', 'scheibo');
    const preGhToken = signSession({github: {id: 10, login: 'pre'}});

    const unlinkRes = await realFetch(`${baseUrl}/api/account/discord/unlink`, {
      method: 'POST',
      headers: {
        Cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(preGhToken)}`,
        Accept: 'application/json',
      },
    });
    expect(unlinkRes.status).toBe(200);
    expect(await unlinkRes.json()).toEqual({ok: true});
    expect(db.getDeveloperByGitHub('pre')!.discordId).toBeUndefined();
    expect(db.getDeveloperByGitHub('pre')!.discordUsername).toBeUndefined();
  });

  test('clears pkmn_session cookie on POST /auth/logout', async () => {
    const logoutRes = await realFetch(`${baseUrl}/auth/logout?return_to=%2Farena%2F`, {
      method: 'POST',
      redirect: 'manual',
    });
    expect(logoutRes.status).toBe(303);
    expect(logoutRes.headers.get('location')).toBe('/arena/');
    expect(logoutRes.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  test('renders dev persona switcher on loopback', async () => {
    const switcher = await realFetch(`${baseUrl}/auth/dev`);
    expect(switcher.status).toBe(200);
    expect(await switcher.text()).toContain('Sign in as admin (scheibo)');
  });

  test('rejects proxied X-Forwarded-For requests to /auth/dev', async () => {
    const proxied = await realFetch(`${baseUrl}/auth/dev`, {
      headers: {'X-Forwarded-For': '203.0.113.10'},
    });
    expect(proxied.status).toBe(403);
  });

  test('mints dev persona cookies on loopback', async () => {
    const mintRes = await realFetch(
      `${baseUrl}/auth/dev?github=pmariglia&return_to=%2Faccount%2F`,
      {redirect: 'manual'}
    );
    expect(mintRes.status).toBe(302);
    expect(mintRes.headers.get('location')).toBe('/account/');
    const minted = auth.verifyToken<auth.Session>(
      extractCookieMap(mintRes)[auth.SESSION_COOKIE],
      AUTH_CFG.sessionSecret
    )!;
    expect(minted.github?.login).toBe('pmariglia');
  });

  test('clears session cookie via /auth/dev?clear=1', async () => {
    const clearRes = await realFetch(`${baseUrl}/auth/dev?clear=1`, {redirect: 'manual'});
    expect(clearRes.status).toBe(302);
    expect(clearRes.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  test('rejects unauthenticated requests on /auth/discord/validate', async () => {
    const unauthVal = await realFetch(`${baseUrl}/auth/discord/validate`);
    expect(unauthVal.status).toBe(401);
  });

  test('redirects unauthenticated browser requests on /chat/logs/token', async () => {
    const unauthTokBrowser = await realFetch(`${baseUrl}/chat/logs/token`, {redirect: 'manual'});
    expect(unauthTokBrowser.status).toBe(302);
    expect(unauthTokBrowser.headers.get('location')).toBe(
      '/auth/discord?return_to=%2Fchat%2Flogs%2Ftoken'
    );
  });

  test('rejects invalid Bearer tokens on /chat/logs/token', async () => {
    const unauthTokBearer = await realFetch(`${baseUrl}/chat/logs/token`, {
      headers: {Authorization: 'Bearer invalid-token'},
      redirect: 'manual',
    });
    expect(unauthTokBearer.status).toBe(401);
  });

  test('denies non-guild Discord sessions on /chat/logs while allowing ?guild=0', async () => {
    const outsiderToken = signSession({
      discord: {id: '192823042433482752', username: 'chaos'},
    });
    const guildDenied = await realFetch(`${baseUrl}/auth/discord/validate`, {
      headers: {Cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(outsiderToken)}`},
    });
    expect(guildDenied.status).toBe(403);

    const privateAllowed = await realFetch(`${baseUrl}/auth/discord/validate?guild=0`, {
      headers: {Cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(outsiderToken)}`},
    });
    expect(privateAllowed.status).toBe(200);
    expect(privateAllowed.headers.get('x-auth-user')).toBe('192823042433482752');
  });

  test('validates Discord guild member Bearer tokens minted by /chat/logs/token', async () => {
    const memberToken = signSession({
      discord: {id: '513513270670262284', username: 'scheibo'},
    });
    const tokenEndpoint = await realFetch(`${baseUrl}/chat/logs/token`, {
      headers: {Cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(memberToken)}`},
    });
    expect(tokenEndpoint.status).toBe(200);
    const cliToken = (await tokenEndpoint.text()).trim();
    expect(cliToken).toBe(memberToken);

    const bearerValidate = await realFetch(`${baseUrl}/auth/discord/validate`, {
      headers: {Authorization: `Bearer ${cliToken}`},
    });
    expect(bearerValidate.status).toBe(200);
    expect(bearerValidate.headers.get('x-auth-user')).toBe('513513270670262284');
  });

  test('rejects cross-origin requests on /chat/logs/token', async () => {
    const memberToken = signSession({
      discord: {id: '513513270670262284', username: 'scheibo'},
    });
    const crossOriginAttempt = await realFetch(`${baseUrl}/chat/logs/token`, {
      headers: {
        Cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(memberToken)}`,
        Origin: 'https://evil.example',
      },
    });
    expect(crossOriginAttempt.status).toBe(403);
  });

  test('strips GitHub claims when minting a scoped CLI token on /chat/logs/token', async () => {
    const dualToken = signSession({
      github: {id: 1, login: 'scheibo'},
      discord: {id: '513513270670262284', username: 'scheibo'},
    });
    const dualRes = await realFetch(`${baseUrl}/chat/logs/token`, {
      headers: {Cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(dualToken)}`},
    });
    expect(dualRes.status).toBe(200);
    const scopedCliToken = (await dualRes.text()).trim();
    const decodedScoped = auth.verifyToken<auth.Session>(scopedCliToken, AUTH_CFG.sessionSecret);
    expect(decodedScoped?.discord?.id).toBe('513513270670262284');
    expect(decodedScoped?.github).toBeUndefined();
  });

  test('rejects Sec-Fetch-Site same-site POST requests', async () => {
    const preGhToken = signSession({github: {id: 10, login: 'pre'}});
    const res = await realFetch(`${baseUrl}/api/account/discord/unlink`, {
      method: 'POST',
      headers: {
        Cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(preGhToken)}`,
        'Sec-Fetch-Site': 'same-site',
        Accept: 'application/json',
      },
    });
    expect(res.status).toBe(403);
  });

  test('rejects GitHub OAuth callbacks with non-positive numeric user IDs', async () => {
    const {state, stateCookie} = await beginGitHubOAuth();
    mockGitHubUser({id: 0, login: 'pre'});

    const origError = console.error;
    console.error = () => undefined;
    try {
      const badCb = await realFetch(
        `${baseUrl}/auth/github/callback?code=c0&state=${encodeURIComponent(state)}`,
        {
          headers: {Cookie: `pkmn_oauth_state=${encodeURIComponent(stateCookie)}`},
          redirect: 'manual',
        }
      );
      expect(badCb.status).toBe(502);
    } finally {
      console.error = origError;
    }
  });

  test('clears stale githubId when projects.yml changes an owner handle', () => {
    db.linkDeveloperGitHubId('pre', 105440);
    expect(db.getDeveloperByGitHub('pre')!.githubId).toBe(105440);

    db.syncProjectsFromYaml(PROJECTS_YAML.replace('pre: pre.10544', 'pre-new: pre.10544'));
    expect(db.getDeveloperByGitHub('pre-new')!.githubId).toBeUndefined();
    expect(db.linkDeveloperGitHubId('pre-new', 909090)).toBe(true);
  });

  test('honors false return from custom isAuthorizedGitHub even when developer is in db', () => {
    const customAuth = new auth.Auth({
      config: AUTH_CFG,
      db,
      isAuthorizedGitHub: login => login === 'coauthor',
    });
    expect(customAuth.isAuthorizedGitHub('coauthor')).toBe(true);
    expect(customAuth.isAuthorizedGitHub('pre')).toBe(false);
  });

  test('ignores invalid duplicate pkmn_session cookies when a valid one exists', async () => {
    const validToken = signSession({discord: {id: '513513270670262284', username: 'pre'}});
    const res = await realFetch(`${baseUrl}/auth/discord/validate`, {
      headers: {
        Cookie:
          `${auth.SESSION_COOKIE}=${encodeURIComponent(validToken)}; ` +
          `${auth.SESSION_COOKIE}=invalid.token`,
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-auth-user')).toBe('513513270670262284');
  });

  test('prefers newer session exp when duplicate valid pkmn_session cookies coexist', async () => {
    const now = Math.floor(Date.now() / 1000);
    const older = auth.signToken(
      {github: {id: 10, login: 'pre'}, exp: now + 3600},
      AUTH_CFG.sessionSecret
    );
    const newer = auth.signToken(
      {discord: {id: '513513270670262284', username: 'pre'}, exp: now + 7200},
      AUTH_CFG.sessionSecret
    );
    const res = await realFetch(`${baseUrl}/auth/discord/validate`, {
      headers: {
        Cookie:
          `${auth.SESSION_COOKIE}=${encodeURIComponent(newer)}; ` +
          `${auth.SESSION_COOKIE}=${encodeURIComponent(older)}`,
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-auth-user')).toBe('513513270670262284');
  });

  test('returns matching resolved token from /chat/logs/token with duplicate cookies', async () => {
    const now = Math.floor(Date.now() / 1000);
    const older = auth.signToken(
      {github: {id: 10, login: 'pre'}, exp: now + 3600},
      AUTH_CFG.sessionSecret
    );
    const newer = auth.signToken(
      {discord: {id: '513513270670262284', username: 'pre'}, exp: now + 7200},
      AUTH_CFG.sessionSecret
    );
    const res = await realFetch(`${baseUrl}/chat/logs/token`, {
      headers: {
        Cookie:
          `${auth.SESSION_COOKIE}=${encodeURIComponent(newer)}; ` +
          `${auth.SESSION_COOKIE}=${encodeURIComponent(older)}`,
      },
    });
    expect(res.status).toBe(200);
    expect((await res.text()).trim()).toBe(newer);
  });

  test('resolves /api/me with GitHub avatar first and Discord avatar for Discord-only sessions',
    async () => {
      expect(auth.githubAvatarUrl(117249)).toBe(
        'https://avatars.githubusercontent.com/u/117249?s=64'
      );
      expect(auth.sanitizeDiscordAvatarHash('a_0123abcd')).toBe('a_0123abcd');
      expect(auth.sanitizeDiscordAvatarHash('../evil')).toBeUndefined();
      expect(auth.discordAvatarUrl('513513270670262284', 'a_0123abcd')).toBe(
        'https://cdn.discordapp.com/avatars/513513270670262284/a_0123abcd.png?size=64'
      );
      const defaultIdx = Number((BigInt('513513270670262284') >> 22n) % 6n);
      expect(auth.discordAvatarUrl('513513270670262284')).toBe(
        `https://cdn.discordapp.com/embed/avatars/${defaultIdx}.png`
      );

      const anonRes = await realFetch(`${baseUrl}/api/me`);
      expect(anonRes.status).toBe(200);
      expect(anonRes.headers.get('cache-control')).toBe('private, no-store');
      expect(await anonRes.json()).toEqual({authenticated: false});

      // GitHub-only session uses GitHub avatar even without linked Discord
      const preGhToken = signSession({github: {id: 10, login: 'pre'}});
      const ghOnlyRes = await realFetch(`${baseUrl}/api/me`, {
        headers: {Cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(preGhToken)}`},
      });
      expect(await ghOnlyRes.json()).toEqual({
        authenticated: true,
        username: 'pre',
        avatarUrl: 'https://avatars.githubusercontent.com/u/10?s=64',
      });

      // Linking Discord still prefers GitHub avatar when signed into both GitHub and Discord,
      // while capturing the Discord avatar hash in the session cookie
      const {state, stateCookie} = await beginDiscordLink(preGhToken);
      mockDiscordUser({id: '513513270670262284', username: 'scheibo', avatar: 'deadbeef01'});
      const linkCb = await realFetch(
        `${baseUrl}/auth/discord/callback?code=dc-av&state=${encodeURIComponent(state)}`,
        {
          headers: {
            Cookie: [
              `pkmn_oauth_state=${encodeURIComponent(stateCookie)}`,
              `${auth.SESSION_COOKIE}=${encodeURIComponent(preGhToken)}`,
            ].join('; '),
          },
          redirect: 'manual',
        }
      );
      expect(linkCb.status).toBe(302);
      const mergedCookie = extractCookieMap(linkCb)[auth.SESSION_COOKIE];
      const mergedSession = auth.verifyToken<auth.Session>(mergedCookie, AUTH_CFG.sessionSecret)!;
      expect(mergedSession.discord?.avatar).toBe('deadbeef01');

      const bothRes = await realFetch(`${baseUrl}/api/me`, {
        headers: {Cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(mergedCookie)}`},
      });
      expect(await bothRes.json()).toEqual({
        authenticated: true,
        username: 'pre',
        avatarUrl: 'https://avatars.githubusercontent.com/u/10?s=64',
      });

      // Discord-only session (no GitHub) uses session Discord avatar hash or default embed avatar
      const discordCustomToken = signSession({
        discord: {id: '513513270670262284', username: 'scheibo', avatar: 'deadbeef01'},
      });
      const discordCustomRes = await realFetch(`${baseUrl}/api/me`, {
        headers: {Cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(discordCustomToken)}`},
      });
      expect(await discordCustomRes.json()).toEqual({
        authenticated: true,
        username: 'scheibo',
        avatarUrl: 'https://cdn.discordapp.com/avatars/513513270670262284/deadbeef01.png?size=64',
      });

      const discordDefaultToken = signSession({
        discord: {id: '999999999999999999', username: 'outsider'},
      });
      const discordDefaultRes = await realFetch(`${baseUrl}/api/me`, {
        headers: {Cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(discordDefaultToken)}`},
      });
      const outsiderIdx = Number((BigInt('999999999999999999') >> 22n) % 6n);
      expect(await discordDefaultRes.json()).toEqual({
        authenticated: true,
        username: 'outsider',
        avatarUrl: `https://cdn.discordapp.com/embed/avatars/${outsiderIdx}.png`,
      });
    });
});
