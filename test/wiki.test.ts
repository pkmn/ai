import {execFileSync} from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import polka from 'polka';

import {
  type OAuthConfig,
  extractAuthorMap,
  extractAuthorizedGitHubUsers,
  formatTitle,
  isValidSlug,
  normalizeSlug,
  registerWiki,
  signToken,
  verifyToken,
} from '../server/wiki';

const OAUTH: OAuthConfig = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  sessionSecret: 'test-session-secret',
  callbackUrl: 'https://pkmn.ai/auth/github/callback',
  admins: ['scheibo'],
  authors: {scheibo: 'pre'},
};

const PROJECTS_YAML = `
- name: 0 ERROR
  active: 2026
  arena:
    author: pre
    github: [pre, PairDev]
- name: Foul Play
  active: 2026
  arena:
    author: pmariglia
    github: pmariglia
- name: Inactive Bot
  active: [2020, 2021]
`;

describe('wiki helpers', () => {
  test('extractAuthorizedGitHubUsers normalizes string, array, and admin entries', () => {
    const users = extractAuthorizedGitHubUsers(PROJECTS_YAML, ['Scheibo']);
    expect([...users].sort()).toEqual(['pairdev', 'pmariglia', 'pre', 'scheibo']);
  });

  test('extractAuthorMap maps single-github project authors and explicit overrides', () => {
    const map = extractAuthorMap(PROJECTS_YAML, {scheibo: 'pre'});
    expect(map.get('scheibo')).toBe('pre');
    expect(map.get('pmariglia')).toBe('pmariglia');
  });

  test('signToken and verifyToken validate HMAC and expiry', () => {
    const token = signToken({login: 'pre', exp: 2000}, 'secret');
    expect(verifyToken<{login: string; exp: number}>(token, 'secret', 1500)).toEqual({
      login: 'pre',
      exp: 2000,
    });
    expect(verifyToken(token, 'wrong-secret', 1500)).toBeUndefined();
    expect(verifyToken(`${token}x`, 'secret', 1500)).toBeUndefined();
    expect(verifyToken(token, 'secret', 2500)).toBeUndefined();
  });

  test('isValidSlug and normalizeSlug support Wikipedia-style names and reject traversal', () => {
    expect(normalizeSlug('Mew%27s%20Truck')).toBe("Mew's_Truck");
    expect(formatTitle("Mew's_Truck")).toBe("Mew's Truck");
    expect(isValidSlug("Mew's_Truck")).toBe(true);
    expect(isValidSlug('PokéChamp')).toBe(true);
    expect(isValidSlug('index')).toBe(true);
    expect(isValidSlug('gen9-ou_notes')).toBe(true);
    expect(isValidSlug('pages')).toBe(false);
    expect(isValidSlug('edit')).toBe(false);
    expect(isValidSlug('history')).toBe(false);
    expect(isValidSlug('../secret')).toBe(false);
    expect(isValidSlug('a/b')).toBe(false);
    expect(isValidSlug('.hidden')).toBe(false);
  });
});

describe('wiki server routes & git history', () => {
  let tmpDir: string;
  let wikiDir: string;
  let projectsFile: string;
  let server: http.Server;
  let baseUrl: string;
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-wiki-test-'));
    wikiDir = path.join(tmpDir, 'wiki');
    projectsFile = path.join(tmpDir, 'projects.yml');
    fs.mkdirSync(wikiDir, {recursive: true});
    fs.writeFileSync(projectsFile, PROJECTS_YAML, 'utf8');

    execFileSync('git', ['init', '-b', 'main'], {cwd: wikiDir});
    execFileSync('git', ['config', 'user.name', 'test'], {cwd: wikiDir});
    execFileSync('git', ['config', 'user.email', 'test@pkmn.ai'], {cwd: wikiDir});
    fs.writeFileSync(path.join(wikiDir, 'index.dj'), '# Home\n\nWelcome to [Gen 9](gen9ou).\n');
    execFileSync('git', ['add', 'index.dj'], {cwd: wikiDir});
    execFileSync('git', ['commit', '-m', 'Initial commit'], {cwd: wikiDir});

    const app = polka();
    registerWiki(app, {
      wikiDir,
      projectsFile,
      oauth: OAUTH,
      push: false,
    });

    server = http.createServer((req, res) => app.handler(req as polka.Request, res));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as {port: number};
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  const sessionCookie = (login: string) => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = signToken({login, exp}, OAUTH.sessionSecret);
    return `pkmn_wiki_session=${encodeURIComponent(token)}`;
  };

  test('redirects unauthenticated requests and rejects unauthorized users', async () => {
    const unauth = await realFetch(`${baseUrl}/wiki`, {redirect: 'manual'});
    expect(unauth.status).toBe(302);
    expect(unauth.headers.get('location')).toBe('/auth/github?return_to=%2Fwiki');

    const forbidden = await realFetch(`${baseUrl}/wiki`, {
      headers: {Cookie: sessionCookie('stranger')},
      redirect: 'manual',
    });
    expect(forbidden.status).toBe(403);
    const body = await forbidden.text();
    expect(body).toContain('stranger');
    expect(body).toContain('not registered');
  });

  test('completes GitHub OAuth flow for authorized competitor in projects.yml', async () => {
    const loginStart = await realFetch(`${baseUrl}/auth/github?return_to=%2Fwiki%2Fgen9ou`, {
      redirect: 'manual',
    });
    expect(loginStart.status).toBe(302);
    const ghUrl = new URL(loginStart.headers.get('location')!);
    expect(ghUrl.origin).toBe('https://github.com');
    const state = ghUrl.searchParams.get('state')!;
    const setCookie = loginStart.headers.get('set-cookie')!;
    const stateCookie = setCookie.split(';')[0];

    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://github.com/login/oauth/access_token') {
        return new Response(JSON.stringify({access_token: 'gho_test'}), {status: 200});
      }
      if (url === 'https://api.github.com/user') {
        return new Response(JSON.stringify({login: 'pmariglia'}), {status: 200});
      }
      return realFetch(input, init);
    };

    const cb = await realFetch(
      `${baseUrl}/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`,
      {
        headers: {Cookie: stateCookie},
        redirect: 'manual',
      }
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe('/wiki/gen9ou');
    expect(cb.headers.get('set-cookie')).toContain('pkmn_wiki_session=');
  });

  test('renders pages, redirects missing pages, previews, saves, and tracks history', async () => {
    const cookie = sessionCookie('pre');

    // 1. View home page
    const homeRes = await realFetch(`${baseUrl}/wiki`, {headers: {Cookie: cookie}});
    expect(homeRes.status).toBe(200);
    const homeHtml = await homeRes.text();
    expect(homeHtml).toContain('Welcome to <a href="/wiki/gen9ou">Gen 9</a>');
    expect(homeHtml).toContain('<meta content="noindex" name="robots">');

    // 2. Missing page (including URL-encoded spaces/apostrophes) redirects to /edit
    const mewRes = await realFetch(`${baseUrl}/wiki/Mew%27s%20Truck/`, {
      headers: {Cookie: cookie},
      redirect: 'manual',
    });
    expect(mewRes.status).toBe(302);
    expect(mewRes.headers.get('location')).toBe("/wiki/Mew's_Truck/edit");

    const missingRes = await realFetch(`${baseUrl}/wiki/gen9ou`, {
      headers: {Cookie: cookie},
      redirect: 'manual',
    });
    expect(missingRes.status).toBe(302);
    expect(missingRes.headers.get('location')).toBe('/wiki/gen9ou/edit');

    // 3. Preview does not write file
    const previewRes = await realFetch(`${baseUrl}/wiki/gen9ou`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        content: '# Gen 9 OU\n\nPreview *content*.',
        message: 'Initial notes',
        action: 'preview',
      }).toString(),
    });
    expect(previewRes.status).toBe(200);
    expect(await previewRes.text()).toContain('Preview <strong>content</strong>.');
    expect(fs.existsSync(path.join(wikiDir, 'gen9ou.dj'))).toBe(false);

    // 4. Save creates file and commits to git with author attribution
    const saveRes = await realFetch(`${baseUrl}/wiki/gen9ou`, {
      method: 'POST',
      headers: {
        Cookie: sessionCookie('scheibo'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        content: '# Gen 9 OU\n\nFirst version.',
        message: 'Add Gen 9 OU page',
        action: 'save',
      }).toString(),
      redirect: 'manual',
    });
    expect(saveRes.status).toBe(303);
    expect(saveRes.headers.get('location')).toBe('/wiki/gen9ou');

    // 5. Second edit by another authorized user
    await realFetch(`${baseUrl}/wiki/gen9ou`, {
      method: 'POST',
      headers: {
        Cookie: sessionCookie('pmariglia'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        content: '# Gen 9 OU\n\nSecond version with math $`x^2`.',
        message: 'Add math example',
        action: 'save',
      }).toString(),
      redirect: 'manual',
    });

    // 6. History lists both revisions with mapped display name and subtle GitHub link
    const histRes = await realFetch(`${baseUrl}/wiki/gen9ou/history`, {
      headers: {Cookie: cookie},
    });
    expect(histRes.status).toBe(200);
    const histHtml = await histRes.text();
    expect(histHtml).toContain('Add Gen 9 OU page');
    expect(histHtml).toContain('Add math example');
    expect(histHtml).toContain('<a href="https://github.com/scheibo" class="subtle">pre</a>');
    expect(histHtml).toContain(
      '<a href="https://github.com/pmariglia" class="subtle">pmariglia</a>'
    );
    expect(histHtml).toContain('</nav><footer>');

    // 7. View revision snapshot and diff
    const shaMatch = /href="\/wiki\/gen9ou\/([0-9a-f]{40})"/.exec(histHtml);
    expect(shaMatch).not.toBeNull();
    const latestSha = shaMatch![1];

    const snapRes = await realFetch(`${baseUrl}/wiki/gen9ou/${latestSha}`, {
      headers: {Cookie: cookie},
    });
    expect(snapRes.status).toBe(200);
    expect(await snapRes.text()).toContain('Second version with math');

    const diffRes = await realFetch(`${baseUrl}/wiki/gen9ou/${latestSha}?diff=1`, {
      headers: {Cookie: cookie},
    });
    expect(diffRes.status).toBe(200);
    expect(await diffRes.text()).toContain('+Second version with math');

    // 8. Pages index lists Home and Gen 9 OU in centered list
    const pagesRes = await realFetch(`${baseUrl}/wiki/pages`, {
      headers: {Cookie: cookie},
    });
    expect(pagesRes.status).toBe(200);
    const pagesHtml = await pagesRes.text();
    expect(pagesHtml).toContain('<ul id="wiki-pages">');
    expect(pagesHtml).toContain('<a href="/wiki">Home</a>');
    expect(pagesHtml).toContain('<a href="/wiki/gen9ou">Gen 9 OU</a>');
  });
});
