import * as http from 'http';

import polka from 'polka';

import {Database} from '../db';
import type * as db from '../db';
import * as auth from '../server/auth';

const AUTH_CFG: auth.Config = {
  sessionSecret: 'test-unified-session-secret',
  arenaSecret: 'test-arena-secret',
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

describe('auth config & helpers', () => {
  test('sanitizeReturnTo allows local paths and blocks open redirects', () => {
    expect(auth.sanitizeReturnTo('/account/', '/')).toBe('/account/');
    expect(auth.sanitizeReturnTo('/wiki/0_ERROR?diff=1', '/')).toBe('/wiki/0_ERROR?diff=1');
    expect(auth.sanitizeReturnTo('//evil.example/phish', '/')).toBe('/');
    expect(auth.sanitizeReturnTo('https://evil.example', '/')).toBe('/');
    expect(auth.sanitizeReturnTo('/bad\r\nSet-Cookie: x=1', '/')).toBe('/');
    expect(auth.sanitizeReturnTo(undefined, '/fallback')).toBe('/fallback');
  });

  test('loadConfig reads flat environment variables cleanly and supports DEV_AUTH', () => {
    expect(auth.loadConfig({})).toBeUndefined();

    const devCfg = auth.loadConfig({DEV_AUTH: '1'});
    expect(devCfg?.sessionSecret).toBeTruthy();

    expect(auth.loadConfig({
      SESSION_SECRET: 'sec-1',
      GITHUB_CLIENT_ID: 'gh-id',
    })).toEqual({
      sessionSecret: 'sec-1',
      arenaSecret: undefined,
      github: undefined,
      discord: undefined,
    });

    expect(auth.loadConfig({
      SESSION_SECRET: 'sec-2',
      ARENA_SECRET: 'arena-2',
      GITHUB_CLIENT_ID: 'gh-id',
      GITHUB_CLIENT_SECRET: 'gh-sec',
      DISCORD_CLIENT_ID: '689315793569447954',
      DISCORD_CLIENT_SECRET: 'disc-sec',
    })).toEqual({
      sessionSecret: 'sec-2',
      arenaSecret: 'arena-2',
      github: {clientId: 'gh-id', clientSecret: 'gh-sec'},
      discord: {clientId: '689315793569447954', clientSecret: 'disc-sec'},
    });
  });
});

describe('unified server/auth.ts OAuth, linking, dev switcher, and Nginx validation', () => {
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
    auth.register(app, {config: AUTH_CFG, db, devAuth: true});

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

  test('GitHub OAuth records githubId, keeps Discord claim, and blocks strangers', async () => {
    const existingDiscordToken = auth.signToken(
      {
        discord: {id: '513513270670262284', username: 'scheibo'},
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      AUTH_CFG.sessionSecret
    );

    const startRes = await realFetch(`${baseUrl}/auth/github?return_to=%2Faccount%2F`, {
      redirect: 'manual',
    });
    expect(startRes.status).toBe(302);
    const ghAuthorize = new URL(startRes.headers.get('location')!);
    expect(ghAuthorize.origin).toBe('https://github.com');
    const state = ghAuthorize.searchParams.get('state')!;
    const startCookies = extractCookieMap(startRes);

    // Tampered state is rejected
    const badState = await realFetch(
      `${baseUrl}/auth/github/callback?code=c1&state=wrong`,
      {
        headers: {Cookie: `pkmn_oauth_state=${encodeURIComponent(startCookies.pkmn_oauth_state)}`},
        redirect: 'manual',
      }
    );
    expect(badState.status).toBe(400);

    let ghUser = {id: 99999, login: 'unregistered_user'};
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

    // Unregistered GitHub user gets 403 with registration link
    const strangerCb = await realFetch(
      `${baseUrl}/auth/github/callback?code=c1&state=${encodeURIComponent(state)}`,
      {
        headers: {Cookie: `pkmn_oauth_state=${encodeURIComponent(startCookies.pkmn_oauth_state)}`},
        redirect: 'manual',
      }
    );
    expect(strangerCb.status).toBe(403);
    const strangerHtml = await strangerCb.text();
    expect(strangerHtml).toContain('unregistered_user');
    expect(strangerHtml).toContain('template=register.yml');

    // Registered developer logs in, records githubId, and keeps existing Discord session claim
    ghUser = {id: 105440, login: 'pre'};
    const okCb = await realFetch(
      `${baseUrl}/auth/github/callback?code=c2&state=${encodeURIComponent(state)}`,
      {
        headers: {
          Cookie: [
            `pkmn_oauth_state=${encodeURIComponent(startCookies.pkmn_oauth_state)}`,
            `${auth.SESSION_COOKIE}=${encodeURIComponent(existingDiscordToken)}`,
          ].join('; '),
        },
        redirect: 'manual',
      }
    );
    expect(okCb.status).toBe(302);
    expect(okCb.headers.get('location')).toBe('/account/');

    const cbCookies = extractCookieMap(okCb);
    const session = auth.verifyToken<auth.Session>(
      cbCookies[auth.SESSION_COOKIE],
      AUTH_CFG.sessionSecret
    )!;
    expect(session.github).toEqual({id: 105440, login: 'pre'});
    expect(session.discord).toEqual({id: '513513270670262284', username: 'scheibo'});
    expect(db.getDeveloperByGitHub('pre')!.githubId).toBe(105440);
  });

  test('Discord OAuth links per-developer Discord ID, blocks collisions, and unlinks', async () => {
    // Unauthenticated ?intent=link redirects to GitHub login first
    const unauthLink = await realFetch(`${baseUrl}/auth/discord?intent=link`, {redirect: 'manual'});
    expect(unauthLink.status).toBe(302);
    expect(unauthLink.headers.get('location')).toContain('/auth/github?return_to=');

    const preGhToken = auth.signToken(
      {github: {id: 10, login: 'pre'}, exp: Math.floor(Date.now() / 1000) + 3600},
      AUTH_CFG.sessionSecret
    );
    const linkStart = await realFetch(`${baseUrl}/auth/discord?intent=link`, {
      headers: {Cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(preGhToken)}`},
      redirect: 'manual',
    });
    expect(linkStart.status).toBe(302);
    const discordAuthUrl = new URL(linkStart.headers.get('location')!);
    expect(discordAuthUrl.origin).toBe('https://discord.com');
    expect(discordAuthUrl.searchParams.get('scope')).toBe('identify');
    const state = discordAuthUrl.searchParams.get('state')!;
    const stateCookie = extractCookieMap(linkStart).pkmn_oauth_state;

    const discordProfile = {id: '513513270670262284', username: 'scheibo'};
    let lastTokenBody = '';
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://discord.com/api/v10/oauth2/token') {
        lastTokenBody = typeof init?.body === 'string' ? init.body : '';
        return new Response(JSON.stringify({access_token: 'disc_tok'}), {status: 200});
      }
      if (url === 'https://discord.com/api/v10/users/@me') {
        return new Response(JSON.stringify(discordProfile), {status: 200});
      }
      return realFetch(input, init);
    };

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

    // Linked strictly to 'pre', leaving 'coauthor' on the same project untouched
    expect(db.getDeveloperByGitHub('pre')!.discordId).toBe('513513270670262284');
    expect(db.getDeveloperByGitHub('pre')!.discordUsername).toBe('scheibo');
    expect(db.getDeveloperByGitHub('coauthor')!.discordId).toBeUndefined();

    const mergedCookies = extractCookieMap(linkCb);
    const mergedSession = auth.verifyToken<auth.Session>(
      mergedCookies[auth.SESSION_COOKIE],
      AUTH_CFG.sessionSecret
    )!;
    expect(mergedSession.github).toEqual({id: 10, login: 'pre'});
    expect(mergedSession.discord).toEqual({id: '513513270670262284', username: 'scheibo'});

    // Second developer ('pmariglia') attempting to link the same Discord ID gets 409 Conflict
    const pmarToken = auth.signToken(
      {github: {id: 20, login: 'pmariglia'}, exp: Math.floor(Date.now() / 1000) + 3600},
      AUTH_CFG.sessionSecret
    );
    const dupStart = await realFetch(`${baseUrl}/auth/discord?intent=link`, {
      headers: {Cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(pmarToken)}`},
      redirect: 'manual',
    });
    const dupState = new URL(dupStart.headers.get('location')!).searchParams.get('state')!;
    const dupStateCookie = extractCookieMap(dupStart).pkmn_oauth_state;

    const dupCb = await realFetch(
      `${baseUrl}/auth/discord/callback?code=dc2&state=${encodeURIComponent(dupState)}`,
      {
        headers: {
          Cookie: [
            `pkmn_oauth_state=${encodeURIComponent(dupStateCookie)}`,
            `${auth.SESSION_COOKIE}=${encodeURIComponent(pmarToken)}`,
          ].join('; '),
        },
        redirect: 'manual',
      }
    );
    expect(dupCb.status).toBe(409);
    expect(await dupCb.text()).toContain('already linked to another developer');

    // Unlink clears Discord fields on 'pre'
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

    // Logout clears pkmn_session
    const logoutRes = await realFetch(`${baseUrl}/auth/logout?return_to=%2Farena%2F`, {
      method: 'POST',
      redirect: 'manual',
    });
    expect(logoutRes.status).toBe(303);
    expect(logoutRes.headers.get('location')).toBe('/arena/');
    expect(logoutRes.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  test('dev persona switcher mints cookies on loopback and rejects proxied requests', async () => {
    const switcher = await realFetch(`${baseUrl}/auth/dev`);
    expect(switcher.status).toBe(200);
    expect(await switcher.text()).toContain('Sign in as admin (scheibo)');

    const proxied = await realFetch(`${baseUrl}/auth/dev`, {
      headers: {'X-Forwarded-For': '203.0.113.10'},
    });
    expect(proxied.status).toBe(403);

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

    const clearRes = await realFetch(`${baseUrl}/auth/dev?clear=1`, {redirect: 'manual'});
    expect(clearRes.status).toBe(302);
    expect(clearRes.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  test('validates Discord sessions for /chat/logs and ?guild=0 /private routes', async () => {
    // 1. Unauthenticated requests
    const unauthVal = await realFetch(`${baseUrl}/auth/discord/validate`);
    expect(unauthVal.status).toBe(401);

    const unauthTokBrowser = await realFetch(`${baseUrl}/chat/logs/token`, {redirect: 'manual'});
    expect(unauthTokBrowser.status).toBe(302);
    expect(unauthTokBrowser.headers.get('location')).toBe(
      '/auth/discord?return_to=%2Fchat%2Flogs%2Ftoken'
    );

    const unauthTokBearer = await realFetch(`${baseUrl}/chat/logs/token`, {
      headers: {Authorization: 'Bearer invalid-token'},
      redirect: 'manual',
    });
    expect(unauthTokBearer.status).toBe(401);

    // 2. Non-guild Discord user -> 403 for guild, 200 for ?guild=0 (/private)
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const outsiderToken = auth.signToken(
      {discord: {id: '192823042433482752', username: 'chaos'}, exp},
      AUTH_CFG.sessionSecret
    );
    const guildDenied = await realFetch(`${baseUrl}/auth/discord/validate`, {
      headers: {Cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(outsiderToken)}`},
    });
    expect(guildDenied.status).toBe(403);

    const privateAllowed = await realFetch(`${baseUrl}/auth/discord/validate?guild=0`, {
      headers: {Cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(outsiderToken)}`},
    });
    expect(privateAllowed.status).toBe(200);
    expect(privateAllowed.headers.get('x-auth-user')).toBe('192823042433482752');

    // 3. Authenticated Discord guild member -> 200 + X-Auth-User + CLI Bearer token workflow
    const memberToken = auth.signToken(
      {discord: {id: '513513270670262284', username: 'scheibo'}, exp},
      AUTH_CFG.sessionSecret
    );
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
});
