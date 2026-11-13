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
  test('extractAuthorizedGitHubUsers normalizes owner logins with admins', () => {
    const users = wiki.extractAuthorizedGitHubUsers(PROJECTS_YAML, ['Scheibo']);
    expect([...users].sort()).toEqual(['pairdev', 'pmariglia', 'pre', 'scheibo']);
  });

  test('extractProjectPages maps active arena projects to owners', () => {
    const {projects} = wiki.extractProjectPages(PROJECTS_YAML);
    expect([...projects.keys()]).toEqual(['0_ERROR', 'Foul_Play']);
    expect([...projects.get('0_ERROR')!.owners].sort()).toEqual(['pairdev', 'pre']);
    expect([...projects.get('Foul_Play')!.owners]).toEqual(['pmariglia']);
  });

  test('extractProjectPages registers slugify aliases for project pages', () => {
    const {aliases} = wiki.extractProjectPages(PROJECTS_YAML);
    expect(aliases.get('0-error')).toBe('0_ERROR');
    expect(aliases.get('0_error')).toBe('0_ERROR');
    expect(aliases.get('0error')).toBe('0_ERROR');
    expect(aliases.get('foul-play')).toBe('Foul_Play');
    expect(aliases.get('foulplay')).toBe('Foul_Play');
    expect(slugify("Mew's Truck").toLowerCase()).toBe('mews-truck');
  });

  test('normalizeSlug normalizes percent-encoding into NFC underscores', () => {
    expect(wiki.normalizeSlug('Mew%27s%20Truck')).toBe("Mew's_Truck");
    expect(wiki.normalizeSlug('Poke\u0301Champ')).toBe('PokéChamp');
  });

  test('formatTitle converts underscored slugs into display titles', () => {
    expect(wiki.formatTitle("Mew's_Truck")).toBe("Mew's Truck");
  });

  test('serializePageContent prepends visibility directive header', () => {
    const serialized = wiki.serializePageContent('# 0 ERROR\n\nAgent notes.', 'discord');
    expect(serialized).toBe('{% visibility: discord %}\n# 0 ERROR\n\nAgent notes.\n');
  });

  test('parsePageContent extracts optional visibility directive', () => {
    expect(wiki.parsePageContent('{% visibility: discord %}\n# 0 ERROR\n\nAgent notes.\n')).toEqual(
      {
        visibility: 'discord',
        content: '# 0 ERROR\n\nAgent notes.\n',
      }
    );
    expect(wiki.parsePageContent('# Plain\n')).toEqual({content: '# Plain\n'});
  });

  test('signToken roundtrips valid unexpired payload via verifyToken', () => {
    const token = auth.signToken({login: 'pre', exp: 2000}, 'secret');
    expect(auth.verifyToken<{login: string; exp: number}>(token, 'secret', 1500)).toEqual({
      login: 'pre',
      exp: 2000,
    });
  });

  test('verifyToken rejects mismatched secrets', () => {
    const token = auth.signToken({login: 'pre', exp: 2000}, 'secret');
    expect(auth.verifyToken(token, 'wrong-secret', 1500)).toBeUndefined();
  });

  test('verifyToken rejects tampered signatures', () => {
    const token = auth.signToken({login: 'pre', exp: 2000}, 'secret');
    expect(auth.verifyToken(`${token}x`, 'secret', 1500)).toBeUndefined();
  });

  test('verifyToken rejects expired payloads', () => {
    const token = auth.signToken({login: 'pre', exp: 2000}, 'secret');
    expect(auth.verifyToken(token, 'secret', 2500)).toBeUndefined();
  });

  test('isValidSlug accepts Wikipedia-style page names', () => {
    expect(wiki.isValidSlug("Mew's_Truck")).toBe(true);
    expect(wiki.isValidSlug('PokéChamp')).toBe(true);
    expect(wiki.isValidSlug('index')).toBe(true);
    expect(wiki.isValidSlug('gen9-ou_notes')).toBe(true);
  });

  test('isValidSlug rejects reserved routes or path traversal', () => {
    expect(wiki.isValidSlug('pages')).toBe(false);
    expect(wiki.isValidSlug('edit')).toBe(false);
    expect(wiki.isValidSlug('history')).toBe(false);
    expect(wiki.isValidSlug('../secret')).toBe(false);
    expect(wiki.isValidSlug('a/b')).toBe(false);
    expect(wiki.isValidSlug('.hidden')).toBe(false);
  });

  test('renderDjot strips raw HTML blocks or inline raw HTML', () => {
    const raw = [
      '# <script>alert(0)</script>',
      '',
      '```=html',
      '<script>fetch("/chat/logs/token")</script>',
      '<iframe src="https://evil.example"></iframe>',
      '```',
      '',
      'Inline `<img src=x onerror=alert(1)>`{=html}.',
    ].join('\n');
    const meta: {title?: string; summary?: string} = {};
    const html = wiki.renderDjot(raw, meta);
    expect(meta.title).toBe('<script>alert(0)</script>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('onerror');
  });

  test('renderDjot HTML-escapes code blocks across known or unknown languages', () => {
    const raw = [
      '```console',
      '$ <script>alert("console")</script>',
      '```',
      '',
      '```nonexistentlang',
      '<svg onload="evil()">',
      '```',
    ].join('\n');
    const html = wiki.renderDjot(raw);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<svg');
    expect(html).toContain('&lt;script&gt;alert(&quot;console&quot;)&lt;/script&gt;');
    expect(html).toContain('&lt;svg onload=&quot;evil()&quot;&gt;');
  });

  test('renderDjot neutralizes unsafe link schemes or inline event attributes', () => {
    const raw = [
      '[JS](javascript:alert(1))',
      '[Slash tag](/wiki/gen9ou){onclick="alert(1)" onmouseover="alert(2)" style="color:red"}',
      '[Angle attr](/wiki/gen9ou){title="a>b" onclick="alert(4)"}',
      '[Bad entity](javascript&#x110000;:alert(5))',
      '[Proto-rel](//evil.example/x)',
    ].join('\n\n');
    const html = wiki.renderDjot(raw);
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('onmouseover');
    expect(html).not.toContain('style=');
    expect(html).not.toContain('evil.example');
    expect(html).toContain('href="#"');
    expect(html).toContain('<a href="/wiki/gen9ou">Slash tag</a>');
  });

  test('renderDjot strips external image beacons to alt text', () => {
    const html = wiki.renderDjot('![Tracking beacon](https://evil.example/pixel.png)');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('evil.example');
    expect(html).toContain('Tracking beacon');
  });

  test('renderDjot renders safe math expressions while blocking TeX hrefs', () => {
    const raw = [
      '{.aside title="`<img/src=x/onerror=alert(3)>`{=html}"}',
      ':::',
      'Safe body with math $`x^2` plus blocked $`\\href{not-tex}{x}`.',
      ':::',
    ].join('\n');
    const html = wiki.renderDjot(raw);
    expect(html).not.toContain('onerror');
    expect(html).toContain('<math');
  });

  test('renderDjot renders GFM-style tables with inline formatting', () => {
    const raw = [
      '| Move | Accuracy |',
      '|:---|---:|',
      '| _Thunderbolt_ | `100%` |',
    ].join('\n');
    const html = wiki.renderDjot(raw);
    expect(html).toContain('<table>');
    expect(html).toContain('<th>Move</th><th>Accuracy</th>');
    expect(html).toContain('<td><em>Thunderbolt</em></td><td><code>100%</code></td>');
  });
});

describe('wiki server routes', () => {
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
    let h = 2166136261;
    for (let i = 0; i < login.length; i++) {
      h = Math.imul(h ^ login.charCodeAt(i), 16777619) >>> 0;
    }
    const id = (h % 900_000_000) + 10_000;
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = auth.signToken({github: {id, login}, exp}, AUTH_CFG.sessionSecret);
    return `${auth.SESSION_COOKIE}=${encodeURIComponent(token)}`;
  };

  const discordCookie = (id: string, username = 'member') => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = auth.signToken({discord: {id, username}, exp}, AUTH_CFG.sessionSecret);
    return `${auth.SESSION_COOKIE}=${encodeURIComponent(token)}`;
  };

  const postWiki = (slug: string, login: string, fields: Record<string, string>) =>
    realFetch(`${baseUrl}/wiki/${slug}`, {
      method: 'POST',
      headers: {
        Cookie: sessionCookie(login),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(fields).toString(),
      redirect: 'manual',
    });

  test('serves general wiki pages publicly with noindex metadata', async () => {
    const res = await realFetch(`${baseUrl}/wiki`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Welcome to <a href="/wiki/gen9ou">Gen 9</a>');
    expect(html).toContain('<meta content="noindex" name="robots">');
  });

  test('redirects unauthenticated edit requests to GitHub OAuth', async () => {
    const res = await realFetch(`${baseUrl}/wiki/gen9ou/edit`, {redirect: 'manual'});
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/auth/github?return_to=%2Fwiki%2Fgen9ou%2Fedit');
  });

  test('rejects edit requests from unregistered GitHub accounts', async () => {
    const res = await realFetch(`${baseUrl}/wiki/gen9ou/edit`, {
      headers: {Cookie: sessionCookie('stranger')},
      redirect: 'manual',
    });
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toContain('stranger');
    expect(body).toContain('not registered');
  });

  test('completes GitHub OAuth callback for registered competitors', async () => {
    const loginStart = await realFetch(`${baseUrl}/auth/github?return_to=%2Fwiki%2Fgen9ou`, {
      redirect: 'manual',
    });
    expect(loginStart.status).toBe(302);
    const ghUrl = new URL(loginStart.headers.get('location')!);
    expect(ghUrl.origin).toBe('https://github.com');
    const state = ghUrl.searchParams.get('state')!;
    const stateCookie = loginStart.headers.get('set-cookie')!.split(';')[0];

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
      {headers: {Cookie: stateCookie}, redirect: 'manual'}
    );
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe('/wiki/gen9ou');
    expect(cb.headers.get('set-cookie')).toContain('pkmn_session=');
  });

  test('redirects missing page views to the editor with normalized slug', async () => {
    const mewRes = await realFetch(`${baseUrl}/wiki/Mew%27s%20Truck/`, {
      headers: {Cookie: sessionCookie('pre')},
      redirect: 'manual',
    });
    expect(mewRes.status).toBe(302);
    expect(mewRes.headers.get('location')).toBe("/wiki/Mew's_Truck/edit");
  });

  test('renders live preview without writing page file to disk', async () => {
    const res = await postWiki('gen9ou', 'pre', {
      content: '# Gen 9 OU\n\nPreview *content*.',
      message: 'Initial notes',
      action: 'preview',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Preview <strong>content</strong>.');
    expect(fs.existsSync(path.join(wikiDir, 'gen9ou.dj'))).toBe(false);
  });

  test('commits saved edits to git with mapped display author history', async () => {
    const saveRes = await postWiki('gen9ou', 'scheibo', {
      content: '# Gen 9 OU\n\nFirst version.',
      message: 'Add Gen 9 OU page',
      action: 'save',
    });
    expect(saveRes.status).toBe(303);
    expect(saveRes.headers.get('location')).toBe('/wiki/gen9ou');

    await postWiki('gen9ou', 'pmariglia', {
      content: '# Gen 9 OU\n\nSecond version with math $`x^2`.',
      message: 'Add math example',
      action: 'save',
    });

    const histRes = await realFetch(`${baseUrl}/wiki/gen9ou/history`);
    expect(histRes.status).toBe(200);
    const histHtml = await histRes.text();
    expect(histHtml).toContain('Add Gen 9 OU page');
    expect(histHtml).toContain('Add math example');
    expect(histHtml).toContain('<a href="https://github.com/scheibo" class="subtle">pre</a>');
    expect(histHtml).toContain(
      '<a href="https://github.com/pmariglia" class="subtle">pmariglia</a>'
    );
  });

  test('serves historical revision snapshots by commit SHA', async () => {
    await postWiki('gen9ou', 'scheibo', {
      content: '# Gen 9 OU\n\nSnapshot version.',
      message: 'Create snapshot',
      action: 'save',
    });
    const histHtml = await (await realFetch(`${baseUrl}/wiki/gen9ou/history`)).text();
    const sha = /href="\/wiki\/gen9ou\/([0-9a-f]{40})"/.exec(histHtml)![1];

    const snapRes = await realFetch(`${baseUrl}/wiki/gen9ou/${sha}`);
    expect(snapRes.status).toBe(200);
    expect(await snapRes.text()).toContain('Snapshot version.');
  });

  test('serves historical unified diffs by commit SHA', async () => {
    await postWiki('gen9ou', 'scheibo', {
      content: '# Gen 9 OU\n\nFirst line.',
      message: 'v1',
      action: 'save',
    });
    await postWiki('gen9ou', 'pmariglia', {
      content: '# Gen 9 OU\n\nUpdated line.',
      message: 'v2',
      action: 'save',
    });
    const histHtml = await (await realFetch(`${baseUrl}/wiki/gen9ou/history`)).text();
    const sha = /href="\/wiki\/gen9ou\/([0-9a-f]{40})"/.exec(histHtml)![1];

    const diffRes = await realFetch(`${baseUrl}/wiki/gen9ou/${sha}?diff=1`);
    expect(diffRes.status).toBe(200);
    expect(await diffRes.text()).toContain('+Updated line.');
  });

  test('lists visible wiki pages on /wiki/pages', async () => {
    await postWiki('gen9ou', 'scheibo', {
      content: '# Gen 9 OU\n\nTier notes.',
      message: 'Add Gen 9 OU',
      action: 'save',
    });
    const pagesRes = await realFetch(`${baseUrl}/wiki/pages`);
    expect(pagesRes.status).toBe(200);
    const pagesHtml = await pagesRes.text();
    expect(pagesHtml).toContain('<ul id="wiki-pages">');
    expect(pagesHtml).toContain('<a href="/wiki">Home</a>');
    expect(pagesHtml).toContain('<a href="/wiki/gen9ou">Gen 9 OU</a>');
  });

  test('redirects project slug aliases to canonical project wiki URL', async () => {
    const res = await realFetch(`${baseUrl}/wiki/0-error`, {redirect: 'manual'});
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/wiki/0_ERROR');
  });

  test('redirects unauthenticated project page requests to GitHub OAuth', async () => {
    const res = await realFetch(`${baseUrl}/wiki/0_ERROR`, {redirect: 'manual'});
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/auth/github?return_to=%2Fwiki%2F0_ERROR');
  });

  test('hides uncreated project pages from non-owner developers with 404', async () => {
    const res = await realFetch(`${baseUrl}/wiki/0_ERROR`, {
      headers: {Cookie: sessionCookie('pmariglia')},
      redirect: 'manual',
    });
    expect(res.status).toBe(404);
  });

  test('rejects non-owner developer edits on another project page with 403', async () => {
    const editRes = await realFetch(`${baseUrl}/wiki/0_ERROR/edit`, {
      headers: {Cookie: sessionCookie('pmariglia')},
    });
    expect(editRes.status).toBe(403);
    expect(await editRes.text()).toContain(
      'not a registered developer of <strong>0 ERROR</strong>'
    );

    const postRes = await postWiki('0-error', 'pmariglia', {content: 'hacked', action: 'save'});
    expect(postRes.status).toBe(403);
  });

  test('allows project owners to create developers-visible project pages', async () => {
    const ownerView = await realFetch(`${baseUrl}/wiki/0_ERROR`, {
      headers: {Cookie: sessionCookie('pre')},
      redirect: 'manual',
    });
    expect(ownerView.status).toBe(302);
    expect(ownerView.headers.get('location')).toBe('/wiki/0_ERROR/edit');

    const editorHtml = await (await realFetch(`${baseUrl}/wiki/0_ERROR/edit`, {
      headers: {Cookie: sessionCookie('pre')},
    })).text();
    expect(editorHtml).toContain('id="wiki-visibility"');
    expect(editorHtml).toContain('value="developers"');

    const saveRes = await postWiki('0_ERROR', 'pre', {
      content: '# 0 ERROR\n\nSecret search architecture.',
      message: 'Create 0 ERROR page',
      action: 'save',
    });
    expect(saveRes.status).toBe(303);

    const pubPages = await (await realFetch(`${baseUrl}/wiki/pages`)).text();
    expect(pubPages).not.toContain('0 ERROR');
  });

  test('allows other registered developers to read developers-visible project pages', async () => {
    await postWiki('0_ERROR', 'pre', {
      content: '# 0 ERROR\n\nSecret search architecture.',
      message: 'Create 0 ERROR page',
      action: 'save',
    });

    const viewRes = await realFetch(`${baseUrl}/wiki/0_ERROR`, {
      headers: {Cookie: sessionCookie('pmariglia')},
    });
    expect(viewRes.status).toBe(200);
    const html = await viewRes.text();
    expect(html).toContain('Secret search architecture.');
    expect(html).not.toContain('visibility:');

    const devPages = await (await realFetch(`${baseUrl}/wiki/pages`, {
      headers: {Cookie: sessionCookie('pmariglia')},
    })).text();
    expect(devPages).toContain('0 ERROR');
  });

  test('restricts discord-visible project pages to verified Discord guild members', async () => {
    await postWiki('0_ERROR', 'PairDev', {
      content: '# 0 ERROR\n\nDiscord-shared notes.',
      visibility: 'discord',
      message: 'Share with Discord',
      action: 'save',
    });

    const noDiscord = await realFetch(`${baseUrl}/wiki/0_ERROR`, {redirect: 'manual'});
    expect(noDiscord.status).toBe(302);
    expect(noDiscord.headers.get('location')).toBe('/auth/discord?return_to=%2Fwiki%2F0_ERROR');

    const memberRes = await realFetch(`${baseUrl}/wiki/0_ERROR`, {
      headers: {Cookie: discordCookie('513513270670262284')},
    });
    expect(memberRes.status).toBe(200);
    expect(await memberRes.text()).toContain('Discord-shared notes.');

    const outsiderRes = await realFetch(`${baseUrl}/wiki/0_ERROR`, {
      headers: {Cookie: discordCookie('999999999999999999', 'outsider')},
    });
    expect(outsiderRes.status).toBe(403);
    expect(await outsiderRes.text()).toContain('not a member of the pkmn.ai Discord');
  });

  test('exposes public project pages to unauthenticated visitors', async () => {
    await postWiki('0_ERROR', 'scheibo', {
      content: '# 0 ERROR\n\nPublic project profile.',
      visibility: 'public',
      message: 'Make public',
      action: 'save',
    });

    const pubRes = await realFetch(`${baseUrl}/wiki/0_ERROR`);
    expect(pubRes.status).toBe(200);
    expect(await pubRes.text()).toContain('Public project profile.');

    const pubPages = await (await realFetch(`${baseUrl}/wiki/pages`)).text();
    expect(pubPages).toContain('0 ERROR');
  });

  test('blocks non-owners from editing public project pages across all aliases', async () => {
    await postWiki('0_ERROR', 'scheibo', {
      content: '# 0 ERROR\n\nPublic project profile.',
      visibility: 'public',
      message: 'Make public',
      action: 'save',
    });

    const editRes = await realFetch(`${baseUrl}/wiki/0_ERROR/edit`, {
      headers: {Cookie: sessionCookie('pmariglia')},
    });
    expect(editRes.status).toBe(403);

    for (const alias of ['0_ERROR', '0-error', '0error']) {
      for (const action of ['preview', 'save']) {
        const res = await postWiki(alias, 'pmariglia', {content: 'hijacked', action});
        expect(res.status).toBe(403);
      }
    }
    expect(fs.readFileSync(path.join(wikiDir, '0_ERROR.dj'), 'utf8')).toContain(
      'Public project profile.'
    );
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

  test('rejects oversized wiki edit payloads with 413', async () => {
    const res = await realFetch(`${baseUrl}/wiki/oversize`, {
      method: 'POST',
      headers: {
        Cookie: sessionCookie('scheibo'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `action=save&content=${'x'.repeat(300_000)}`,
    });
    expect(res.status).toBe(413);
  });

  test('HTML-escapes H1 headings rendered inside the page header', async () => {
    const saveRes = await postWiki('xss_check', 'scheibo', {
      content: '# <img src=x onerror=alert(1)>\n\nSafe text.',
      message: 'Test heading escape',
      action: 'save',
    });
    expect(saveRes.status).toBe(303);

    const viewHtml = await (await realFetch(`${baseUrl}/wiki/xss_check`)).text();
    expect(viewHtml).toContain('<h2>&lt;img src=x onerror=alert(1)');
    expect(viewHtml).not.toContain('<img src=x');
  });

  test('renders diffs with over 130,000 backtick runs without stack overflow', async () => {
    await postWiki('backticks', 'scheibo', {
      content: '# Heading\n\nInitial.',
      message: 'Init',
      action: 'save',
    });
    fs.writeFileSync(
      path.join(wikiDir, 'backticks.dj'),
      `# Heading\n\n${'`a` '.repeat(130_000)}\n`
    );
    execFileSync('git', ['commit', '-am', 'Dense backticks'], {cwd: wikiDir});
    const histHtml = await (await realFetch(`${baseUrl}/wiki/backticks/history`)).text();
    const sha = /href="\/wiki\/backticks\/([0-9a-f]{40})"/.exec(histHtml)![1];
    const diffRes = await realFetch(`${baseUrl}/wiki/backticks/${sha}?diff=1`);
    expect(diffRes.status).toBe(200);
  });
});

describe('wiki database standing checks', () => {
  let tmpDir: string;
  let db: Database;
  let dbServer: http.Server;
  let dbUrl: string;
  let devId: number;
  let agentId: number;

  const mintCookie = (id: number, login: string) => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const tok = auth.signToken({github: {id, login}, exp}, AUTH_CFG.sessionSecret);
    return `${auth.SESSION_COOKIE}=${encodeURIComponent(tok)}`;
  };

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-wiki-db-test-'));
    const wikiDir = path.join(tmpDir, 'wiki');
    const projectsFile = path.join(tmpDir, 'projects.yml');
    fs.mkdirSync(wikiDir, {recursive: true});
    fs.writeFileSync(projectsFile, PROJECTS_YAML, 'utf8');
    execFileSync('git', ['init', '-b', 'main'], {cwd: wikiDir});
    execFileSync('git', ['config', 'user.name', 'test'], {cwd: wikiDir});
    execFileSync('git', ['config', 'user.email', 'test@pkmn.ai'], {cwd: wikiDir});

    db = new Database(':memory:');
    db.syncProjectsFromYaml([
      '- name: Foul Play',
      '  active: 2026',
      '  arena:',
      '    qualified: true',
      '    owners:',
      '      pmariglia: pmariglia.535629',
    ].join('\n'));
    db.linkDeveloperGitHubId('pmariglia', 4242);
    agentId = db.getAgentBySlug('foul-play')!.id;
    devId = db.getDeveloperByGitHub('pmariglia')!.id;

    const app = polka();
    wiki.register(app, {wikiDir, projectsFile, db, authConfig: AUTH_CFG, push: false});
    dbServer = http.createServer((req, res) => app.handler(req as polka.Request, res));
    await new Promise<void>(resolve => dbServer.listen(0, '127.0.0.1', resolve));
    dbUrl = `http://127.0.0.1:${(dbServer.address() as {port: number}).port}`;
  });

  afterEach(async () => {
    dbServer.closeAllConnections();
    await new Promise<void>(resolve => dbServer.close(() => resolve()));
    db.close();
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  test('redirects sessions whose numeric GitHub ID disagrees with the database', async () => {
    const res = await fetch(`${dbUrl}/wiki/Foul_Play/edit`, {
      headers: {Cookie: mintCookie(9999, 'pmariglia')},
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
  });

  test('preserves wiki access across GitHub handle renames via numeric ID', async () => {
    const res = await fetch(`${dbUrl}/wiki/Foul_Play/edit`, {
      headers: {Cookie: mintCookie(4242, 'old-pmariglia-handle')},
    });
    expect(res.status).toBe(200);
  });

  test('blocks wiki edits with 403 when developer Smogon standing is bad', async () => {
    db.db.prepare("UPDATE developers SET smogon_standing = 'bad' WHERE id = ?").run(devId);
    const res = await fetch(`${dbUrl}/wiki/Foul_Play/edit`, {
      headers: {Cookie: mintCookie(4242, 'pmariglia')},
    });
    expect(res.status).toBe(403);
  });

  test('blocks wiki edits with 403 when the project status is disabled', async () => {
    db.db.prepare("UPDATE agents SET status = 'disabled' WHERE id = ?").run(agentId);
    const res = await fetch(`${dbUrl}/wiki/Foul_Play/edit`, {
      headers: {Cookie: mintCookie(4242, 'pmariglia')},
    });
    expect(res.status).toBe(403);
  });
});
