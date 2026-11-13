import {execFileSync} from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import polka from 'polka';

import {Database} from '../db';
import * as auth from '../server/auth';
import * as wiki from '../server/wiki';
import {slugify} from '../static/util';
import * as mock from '../tools/mock';

const AUTH_CFG: auth.Config = {
  sessionSecret: 'test-session-secret',
  github: {
    clientId: 'client-id',
    clientSecret: 'client-secret',
  },
  discord: {
    clientId: 'discord-client-id',
    clientSecret: 'discord-client-secret',
  },
};

const PROJECTS_YAML = `
- name: 0 ERROR
  active: 2026
  arena:
    owners:
      pre: pre
      PairDev: pairdev
- name: Foul Play
  active: 2026
  arena:
    owners:
      pmariglia: pmariglia
- name: Inactive Project
  active: [2020, 2021]
`;

describe('wiki helpers', () => {
  test('extractAuthorizedGitHubUsers normalizes owners and admin entries', () => {
    const users = wiki.extractAuthorizedGitHubUsers(PROJECTS_YAML, ['Scheibo']);
    expect([...users].sort()).toEqual(['pairdev', 'pmariglia', 'pre', 'scheibo']);
  });

  test('extractProjectPages maps registered arena projects, owners, and slugify/ID aliases', () => {
    const {projects, aliases} = wiki.extractProjectPages(PROJECTS_YAML);
    expect([...projects.keys()]).toEqual(['0_ERROR', 'Foul_Play']);
    expect([...projects.get('0_ERROR')!.owners].sort()).toEqual(['pairdev', 'pre']);
    expect([...projects.get('Foul_Play')!.owners]).toEqual(['pmariglia']);
    expect(aliases.get('0-error')).toBe('0_ERROR');
    expect(aliases.get('0_error')).toBe('0_ERROR');
    expect(aliases.get('0error')).toBe('0_ERROR');
    expect(aliases.get('foul-play')).toBe('Foul_Play');
    expect(aliases.get('foulplay')).toBe('Foul_Play');
    expect(slugify("Mew's Truck").toLowerCase()).toBe('mews-truck');
    expect(wiki.normalizeSlug('Poke\u0301Champ')).toBe('PokéChamp');
  });

  test('parsePageContent and serializePageContent handle visibility directives', () => {
    const serialized = wiki.serializePageContent('# 0 ERROR\n\nAgent notes.', 'discord');
    expect(serialized).toBe('{% visibility: discord %}\n# 0 ERROR\n\nAgent notes.\n');
    expect(wiki.parsePageContent(serialized)).toEqual({
      visibility: 'discord',
      content: '# 0 ERROR\n\nAgent notes.\n',
    });
    expect(wiki.parsePageContent('# Plain\n')).toEqual({content: '# Plain\n'});
  });

  test('signToken and verifyToken validate HMAC and expiry', () => {
    const token = auth.signToken({login: 'pre', exp: 2000}, 'secret');
    expect(auth.verifyToken<{login: string; exp: number}>(token, 'secret', 1500)).toEqual({
      login: 'pre',
      exp: 2000,
    });
    expect(auth.verifyToken(token, 'wrong-secret', 1500)).toBeUndefined();
    expect(auth.verifyToken(`${token}x`, 'secret', 1500)).toBeUndefined();
    expect(auth.verifyToken(token, 'secret', 2500)).toBeUndefined();
  });

  test('isValidSlug and normalizeSlug support Wikipedia-style names and reject traversal', () => {
    expect(wiki.normalizeSlug('Mew%27s%20Truck')).toBe("Mew's_Truck");
    expect(wiki.formatTitle("Mew's_Truck")).toBe("Mew's Truck");
    expect(wiki.isValidSlug("Mew's_Truck")).toBe(true);
    expect(wiki.isValidSlug('PokéChamp')).toBe(true);
    expect(wiki.isValidSlug('index')).toBe(true);
    expect(wiki.isValidSlug('gen9-ou_notes')).toBe(true);
    expect(wiki.isValidSlug('pages')).toBe(false);
    expect(wiki.isValidSlug('edit')).toBe(false);
    expect(wiki.isValidSlug('history')).toBe(false);
    expect(wiki.isValidSlug('../secret')).toBe(false);
    expect(wiki.isValidSlug('a/b')).toBe(false);
    expect(wiki.isValidSlug('.hidden')).toBe(false);
  });

  test('renderDjot strips raw HTML blocks, inline HTML, event handlers, and unsafe URIs', () => {
    const raw = [
      '# Security Test',
      '',
      '```=html',
      '<script>fetch("/chat/logs/token")</script>',
      '<iframe src="https://evil.example"></iframe>',
      '```',
      '',
      'Inline `<img src=x onerror=alert(1)>`{=html} and [link](javascript:alert(1)).',
      '',
      '[Attr link](/wiki/gen9ou){onclick="alert(1)" onmouseover="alert(2)" style="color:red"}',
      '',
      '[Angle attr](/wiki/gen9ou){title="a>b" onclick="alert(4)"}',
      '',
      '[Bad entity](javascript&#x110000;:alert(5))',
      '',
      '{.aside title="`<script>alert(3)</script>`{=html}"}',
      ':::',
      'Safe body with math $`x^2`.',
      ':::',
    ].join('\n');
    const html = wiki.renderDjot(raw);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('onmouseover');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('style=');
    expect(html).toContain('href="#"');
    expect(html).toContain('<a href="/wiki/gen9ou">Attr link</a>');
    expect(html).toContain('<math');
  });
});

describe('wiki server routes & git history', () => {
  let tmpDir: string;
  let wikiDir: string;
  let projectsFile: string;
  let server: http.Server;
  let baseUrl: string;
  let discordMembers: Set<string>;
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-wiki-test-'));
    wikiDir = path.join(tmpDir, 'wiki');
    projectsFile = path.join(tmpDir, 'projects.yml');
    discordMembers = new Set(['513513270670262284']);
    fs.mkdirSync(wikiDir, {recursive: true});
    fs.writeFileSync(projectsFile, PROJECTS_YAML, 'utf8');

    execFileSync('git', ['init', '-b', 'main'], {cwd: wikiDir});
    execFileSync('git', ['config', 'user.name', 'test'], {cwd: wikiDir});
    execFileSync('git', ['config', 'user.email', 'test@pkmn.ai'], {cwd: wikiDir});
    fs.writeFileSync(path.join(wikiDir, 'index.dj'), '# Home\n\nWelcome to [Gen 9](gen9ou).\n');
    execFileSync('git', ['add', 'index.dj'], {cwd: wikiDir});
    execFileSync('git', ['commit', '-m', 'Initial commit'], {cwd: wikiDir});

    const app = polka();
    wiki.register(app, {
      wikiDir,
      projectsFile,
      authConfig: AUTH_CFG,
      isDiscordMember: id => discordMembers.has(id),
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
    const token = auth.signToken({github: {id: 1, login}, exp}, AUTH_CFG.sessionSecret);
    return `${auth.SESSION_COOKIE}=${encodeURIComponent(token)}`;
  };

  const discordCookie = (id: string, username = 'member') => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = auth.signToken({discord: {id, username}, exp}, AUTH_CFG.sessionSecret);
    return `${auth.SESSION_COOKIE}=${encodeURIComponent(token)}`;
  };

  test('allows public reading of general pages and requires registered auth to edit', async () => {
    // Public visitors can read general wiki pages without authentication
    const publicHome = await realFetch(`${baseUrl}/wiki`);
    expect(publicHome.status).toBe(200);
    expect(await publicHome.text()).toContain('Welcome to <a href="/wiki/gen9ou">Gen 9</a>');

    // Editing redirects unauthenticated requests and rejects non-registered GitHub users
    const unauthEdit = await realFetch(`${baseUrl}/wiki/gen9ou/edit`, {redirect: 'manual'});
    expect(unauthEdit.status).toBe(302);
    expect(unauthEdit.headers.get('location')).toBe(
      '/auth/github?return_to=%2Fwiki%2Fgen9ou%2Fedit'
    );

    const forbiddenEdit = await realFetch(`${baseUrl}/wiki/gen9ou/edit`, {
      headers: {Cookie: sessionCookie('stranger')},
      redirect: 'manual',
    });
    expect(forbiddenEdit.status).toBe(403);
    const body = await forbiddenEdit.text();
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
    expect(cb.headers.get('set-cookie')).toContain('pkmn_session=');
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
    const histRes = await realFetch(`${baseUrl}/wiki/gen9ou/history`);
    expect(histRes.status).toBe(200);
    const histHtml = await histRes.text();
    expect(histHtml).toContain('Add Gen 9 OU page');
    expect(histHtml).toContain('Add math example');
    expect(histHtml).toContain('<a href="https://github.com/scheibo" class="subtle">pre</a>');
    expect(histHtml).toContain(
      '<a href="https://github.com/pmariglia" class="subtle">pmariglia</a>'
    );
    expect(histHtml).toContain('</nav><footer>');

    // 7. View revision snapshot and diff publicly
    const shaMatch = /href="\/wiki\/gen9ou\/([0-9a-f]{40})"/.exec(histHtml);
    expect(shaMatch).toBeTruthy();
    const latestSha = shaMatch![1];

    const snapRes = await realFetch(`${baseUrl}/wiki/gen9ou/${latestSha}`);
    expect(snapRes.status).toBe(200);
    expect(await snapRes.text()).toContain('Second version with math');

    const diffRes = await realFetch(`${baseUrl}/wiki/gen9ou/${latestSha}?diff=1`);
    expect(diffRes.status).toBe(200);
    expect(await diffRes.text()).toContain('+Second version with math');

    // 8. Pages index lists Home and Gen 9 OU in centered list
    const pagesRes = await realFetch(`${baseUrl}/wiki/pages`);
    expect(pagesRes.status).toBe(200);
    const pagesHtml = await pagesRes.text();
    expect(pagesHtml).toContain('<ul id="wiki-pages">');
    expect(pagesHtml).toContain('<a href="/wiki">Home</a>');
    expect(pagesHtml).toContain('<a href="/wiki/gen9ou">Gen 9 OU</a>');
  });

  test('enforces project page ownership and supports developers, discord, and public', async () => {
    // 1. Alias redirects (/wiki/0-error -> /wiki/0_ERROR)
    const aliasRes = await realFetch(`${baseUrl}/wiki/0-error`, {redirect: 'manual'});
    expect(aliasRes.status).toBe(302);
    expect(aliasRes.headers.get('location')).toBe('/wiki/0_ERROR');

    // 2. Uncreated project page defaults to developers visibility and only owners/admins can edit
    const unauthProject = await realFetch(`${baseUrl}/wiki/0_ERROR`, {redirect: 'manual'});
    expect(unauthProject.status).toBe(302);
    expect(unauthProject.headers.get('location')).toBe('/auth/github?return_to=%2Fwiki%2F0_ERROR');

    // Other project's developer (pmariglia) sees 404 on uncreated 0_ERROR and 403 on /edit or POST
    const otherDevView = await realFetch(`${baseUrl}/wiki/0_ERROR`, {
      headers: {Cookie: sessionCookie('pmariglia')},
      redirect: 'manual',
    });
    expect(otherDevView.status).toBe(404);

    const otherDevEdit = await realFetch(`${baseUrl}/wiki/0_ERROR/edit`, {
      headers: {Cookie: sessionCookie('pmariglia')},
    });
    expect(otherDevEdit.status).toBe(403);
    expect(await otherDevEdit.text()).toContain(
      'not a registered developer of <strong>0 ERROR</strong>'
    );

    const otherDevPost = await realFetch(`${baseUrl}/wiki/0-error`, {
      method: 'POST',
      headers: {
        Cookie: sessionCookie('pmariglia'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({content: 'hacked', action: 'save'}).toString(),
    });
    expect(otherDevPost.status).toBe(403);

    // 3. Owner (pre) visiting uncreated /wiki/0_ERROR redirects to /edit with visibility selector
    const ownerView = await realFetch(`${baseUrl}/wiki/0_ERROR`, {
      headers: {Cookie: sessionCookie('pre')},
      redirect: 'manual',
    });
    expect(ownerView.status).toBe(302);
    expect(ownerView.headers.get('location')).toBe('/wiki/0_ERROR/edit');

    const editorRes = await realFetch(`${baseUrl}/wiki/0_ERROR/edit`, {
      headers: {Cookie: sessionCookie('pre')},
    });
    expect(editorRes.status).toBe(200);
    const editorHtml = await editorRes.text();
    expect(editorHtml).toContain('id="wiki-visibility"');
    expect(editorHtml).toContain('value="developers"');

    // 4. Owner saves project page with default (developers) visibility
    const saveDev = await realFetch(`${baseUrl}/wiki/0_ERROR`, {
      method: 'POST',
      headers: {
        Cookie: sessionCookie('pre'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        content: '# 0 ERROR\n\nSecret search architecture.',
        message: 'Create 0 ERROR page',
        action: 'save',
      }).toString(),
      redirect: 'manual',
    });
    expect(saveDev.status).toBe(303);

    // Public cannot view developers-only project page or see it in /wiki/pages
    const pubDenied = await realFetch(`${baseUrl}/wiki/0_ERROR`, {redirect: 'manual'});
    expect(pubDenied.status).toBe(302);
    expect(pubDenied.headers.get('location')).toBe('/auth/github?return_to=%2Fwiki%2F0_ERROR');

    const pubPages = await (await realFetch(`${baseUrl}/wiki/pages`)).text();
    expect(pubPages).not.toContain('0 ERROR');

    // Other registered developer (pmariglia) CAN view developers-only project page
    const otherDevAllowed = await realFetch(`${baseUrl}/wiki/0_ERROR`, {
      headers: {Cookie: sessionCookie('pmariglia')},
    });
    expect(otherDevAllowed.status).toBe(200);
    const devPageHtml = await otherDevAllowed.text();
    expect(devPageHtml).toContain('Secret search architecture.');
    expect(devPageHtml).not.toContain('visibility:');

    const devPages = await (await realFetch(`${baseUrl}/wiki/pages`, {
      headers: {Cookie: sessionCookie('pmariglia')},
    })).text();
    expect(devPages).toContain('0 ERROR');

    // 5. Co-owner (PairDev) updates visibility to 'discord'
    await realFetch(`${baseUrl}/wiki/0_ERROR`, {
      method: 'POST',
      headers: {
        Cookie: sessionCookie('PairDev'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        content: '# 0 ERROR\n\nDiscord-shared notes.',
        visibility: 'discord',
        message: 'Share with Discord',
        action: 'save',
      }).toString(),
      redirect: 'manual',
    });

    // Unauthenticated visitor redirects to /auth/discord
    const noDiscord = await realFetch(`${baseUrl}/wiki/0_ERROR`, {redirect: 'manual'});
    expect(noDiscord.status).toBe(302);
    expect(noDiscord.headers.get('location')).toBe('/auth/discord?return_to=%2Fwiki%2F0_ERROR');

    // Verified Discord guild member can read the page and see it in /wiki/pages
    const discordOk = await realFetch(`${baseUrl}/wiki/0_ERROR`, {
      headers: {Cookie: discordCookie('513513270670262284')},
    });
    expect(discordOk.status).toBe(200);
    expect(await discordOk.text()).toContain('Discord-shared notes.');

    const discordPages = await (await realFetch(`${baseUrl}/wiki/pages`, {
      headers: {Cookie: discordCookie('513513270670262284')},
    })).text();
    expect(discordPages).toContain('0 ERROR');

    // Non-guild Discord user gets 403
    const discordForbidden = await realFetch(`${baseUrl}/wiki/0_ERROR`, {
      headers: {Cookie: discordCookie('999999999999999999', 'outsider')},
    });
    expect(discordForbidden.status).toBe(403);
    expect(await discordForbidden.text()).toContain('not a member of the pkmn.ai Discord');

    // 6. Admin (scheibo) updates visibility to 'public'
    await realFetch(`${baseUrl}/wiki/0_ERROR`, {
      method: 'POST',
      headers: {
        Cookie: sessionCookie('scheibo'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        content: '# 0 ERROR\n\nPublic project profile.',
        visibility: 'public',
        message: 'Make public',
        action: 'save',
      }).toString(),
      redirect: 'manual',
    });

    // Public visitor (no cookies) can now read /wiki/0_ERROR and see it in /wiki/pages
    const pubAllowed = await realFetch(`${baseUrl}/wiki/0_ERROR`);
    expect(pubAllowed.status).toBe(200);
    expect(await pubAllowed.text()).toContain('Public project profile.');

    const pubPagesAfter = await (await realFetch(`${baseUrl}/wiki/pages`)).text();
    expect(pubPagesAfter).toContain('0 ERROR');

    // 7. Non-owner registered developer (pmariglia) still cannot edit 0_ERROR (or its aliases)
    // once the page exists and is public, though pmariglia CAN edit their own project & general
    // wiki pages.
    expect(
      (await realFetch(`${baseUrl}/wiki/0_ERROR/edit`, {
        headers: {Cookie: sessionCookie('pmariglia')},
      })).status
    ).toBe(403);

    for (const alias of ['0_ERROR', '0-error', '0error']) {
      for (const action of ['preview', 'save']) {
        const res = await realFetch(`${baseUrl}/wiki/${alias}`, {
          method: 'POST',
          headers: {
            Cookie: sessionCookie('pmariglia'),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({content: 'hijacked', action}).toString(),
        });
        expect(res.status).toBe(403);
      }
    }
    expect(fs.readFileSync(path.join(wikiDir, '0_ERROR.dj'), 'utf8')).toContain(
      'Public project profile.'
    );

    expect(
      (await realFetch(`${baseUrl}/wiki/Foul_Play/edit`, {
        headers: {Cookie: sessionCookie('pmariglia')},
      })).status
    ).toBe(200);
    const ownSave = await realFetch(`${baseUrl}/wiki/Foul_Play`, {
      method: 'POST',
      headers: {
        Cookie: sessionCookie('pmariglia'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        content: '# Foul Play\n\nAlpha-beta search.',
        message: 'Create Foul Play page',
        action: 'save',
      }).toString(),
      redirect: 'manual',
    });
    expect(ownSave.status).toBe(303);

    const generalSave = await realFetch(`${baseUrl}/wiki/gen9ou`, {
      method: 'POST',
      headers: {
        Cookie: sessionCookie('pmariglia'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        content: '# Gen 9 OU\n\nCommunity benchmark notes.',
        message: 'Add notes',
        action: 'save',
      }).toString(),
      redirect: 'manual',
    });
    expect(generalSave.status).toBe(303);
  });

  test('mock runner rejects unauthorized edits to another project wiki page', async () => {
    const db = new Database(':memory:');
    try {
      const mockRoot = path.join(tmpDir, 'mock-acl');
      const runner = new mock.Runner({
        db,
        mockDir: mockRoot,
        staticDir: path.join(mockRoot, 'static'),
        avatarsDir: path.join(mockRoot, 'static', 'avatars'),
        wikiDir: path.join(mockRoot, 'wiki'),
        laddersFile: path.join(mockRoot, 'ladders.yml'),
      });
      await runner.runScript([
        'reset --seed 1 --now 2026-10-20T12:00:00Z',
        'register "0 ERROR" --owner scheibo:pre.10544 --owner coauthor:coauthor.20001',
        'register "Foul Play" --owner pmariglia:pmariglia.535629',
        'wiki index --by pmariglia --content "# Wiki"',
        'wiki 0_ERROR --by coauthor --visibility developers --content "# 0 ERROR"',
      ].join('\n'));
      await expect(
        runner.execLine('wiki 0_ERROR --by pmariglia --content "# Hijacked"')
      ).rejects.toThrow(/not authorized to edit project wiki page "0_ERROR"/);
      await expect(
        runner.execLine('wiki 0error --by pmariglia --content "# Hijacked"')
      ).rejects.toThrow(/not authorized to edit project wiki page "0_ERROR"/);
    } finally {
      db.close();
    }
  });
});
