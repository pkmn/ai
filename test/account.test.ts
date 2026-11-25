import {execFileSync} from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import {Team} from '@pkmn/sets';
import polka from 'polka';

import {ALL_SLOTS, COOLDOWN_SECONDS, Database} from '../db';
import type * as db from '../db';
import * as account from '../server/account';
import * as arena from '../server/arena';
import * as auth from '../server/auth';
import {clearReferencePoolCache, splitSubmittedTeams} from '../server/teams';
import * as wiki from '../server/wiki';
import {generateValidVgcTeams} from '../tools/mock';
import {runPkmnCli} from '../tools/pkmn';

const AUTH_CFG: auth.Config = {
  sessionSecret: 'test-account-session-secret',
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
- name: Newcomer
  active: 2026
  arena:
    owners:
      rookie: rookie.999999
`;

const SHA_A = '8f4ac91e0000000000000000000000000000000000000000000000008f4ac91e';
const SHA_B = '2b1904fa0000000000000000000000000000000000000000000000002b1904fa';
const TWENTY_ONE_VGC_TEAMS = generateValidVgcTeams(21);
const VALID_TWENTY_VGC = TWENTY_ONE_VGC_TEAMS.slice(0, 20);
const PUBLIC_CLONE_VGC = TWENTY_ONE_VGC_TEAMS[20];

describe('submission helpers', () => {
  test('deducePackageFormat distinguishes native archive bundles from OCI refs', () => {
    expect(account.deducePackageFormat('https://github.com/pkmn/agent.tar.gz?sig=1')).toBe('bundle');
    expect(account.deducePackageFormat('https://github.com/pkmn/agent.tgz')).toBe('bundle');
    expect(account.deducePackageFormat('https://github.com/pkmn/agent.tar.xz')).toBe('bundle');
    expect(account.deducePackageFormat('https://github.com/pkmn/agent.txz')).toBe('bundle');
    expect(account.deducePackageFormat('https://github.com/pkmn/agent.tar.zst')).toBe('bundle');
    expect(account.deducePackageFormat('https://github.com/pkmn/agent.tar.zst#v1')).toBe('bundle');
    expect(account.deducePackageFormat('https://github.com/pkmn/agent.tzst')).toBe('bundle');
    expect(account.deducePackageFormat('ghcr.io/pkmn/0-error:1.2.0')).toBe('oci');
    expect(account.deducePackageFormat('docker.io/library/agent@sha256:' + SHA_A)).toBe('oci');
  });

  test('deducePackageFormat classifies GitHub release asset API URLs as bundles', () => {
    expect(
      account.deducePackageFormat('https://api.github.com/repos/pkmn/0-error/releases/assets/12345')
    ).toBe('bundle');
  });

  test('validateArtifactUrl accepts allowlisted HTTPS bundle hosts', () => {
    const allowedBundles = [
      'https://github.com/pkmn/0-error.tar.zst',
      'https://objects.githubusercontent.com/asset/0-error.tar.gz?X-Amz-Signature=abc',
      'https://huggingface.co/pkmn/0-error/resolve/main/agent.tar.zst',
      'https://cdn-lfs-us-1.hf.co/repos/agent.tar.zst',
      'https://acct123.r2.cloudflarestorage.com/agents/0-error.tar.zst',
      'https://pub-abc123.r2.dev/0-error.tar.zst',
      'https://my-bucket.s3.us-east-1.amazonaws.com/0-error.tar.zst',
      'https://storage.googleapis.com/my-bucket/0-error.tar.zst',
      'https://f005.backblazeb2.com/file/my-bucket/0-error.tar.zst',
    ];
    for (const url of allowedBundles) {
      expect(account.validateArtifactUrl(url, 'bundle')).toBeUndefined();
    }
  });

  test('validateArtifactUrl accepts multi-label Hugging Face Xet subdomains', () => {
    expect(
      account.validateArtifactUrl('https://us.aws.cdn.hf.co/xet-bridge-us/agent.tar.zst', 'bundle')
    ).toBeUndefined();
    expect(
      account.validateArtifactUrl('https://cas-bridge.xethub.hf.co/obj/agent.tar.zst', 'bundle')
    ).toBeUndefined();
  });

  test('validateArtifactUrl accepts S3 dualstack or hyphenated regional endpoints', () => {
    expect(
      account.validateArtifactUrl(
        'https://my-bucket.s3.dualstack.us-east-1.amazonaws.com/agent.tar.zst',
        'bundle'
      )
    ).toBeUndefined();
    expect(
      account.validateArtifactUrl(
        'https://my-bucket.s3-us-west-2.amazonaws.com/agent.tar.zst',
        'bundle'
      )
    ).toBeUndefined();
  });

  test('validateArtifactUrl accepts GitHub REST API release asset URLs', () => {
    expect(
      account.validateArtifactUrl(
        'https://api.github.com/repos/pkmn/0-error/releases/assets/987654321',
        'bundle'
      )
    ).toBeUndefined();
  });

  test('validateArtifactUrl rejects non-asset api.github.com bundle URLs', () => {
    expect(
      account.validateArtifactUrl(
        'https://api.github.com/repos/pkmn/0-error/releases/tags/v1.0.0',
        'bundle'
      )
    ).toBeTruthy();
  });

  test('validateArtifactUrl accepts raw.githubusercontent.com or media.githubusercontent.com URLs',
    () => {
      expect(
        account.validateArtifactUrl(
          'https://raw.githubusercontent.com/pkmn/0-error/main/dist/agent.tar.zst',
          'bundle'
        )
      ).toBeUndefined();
      expect(
        account.validateArtifactUrl(
          'https://media.githubusercontent.com/media/pkmn/0-error/main/agent.tar.zst',
          'bundle'
        )
      ).toBeUndefined();
    });

  test('validateArtifactUrl accepts GitHub Contents API bundle URLs', () => {
    expect(
      account.validateArtifactUrl(
        'https://api.github.com/repos/pkmn/0-error/contents/dist/agent.tar.zst?ref=main',
        'bundle'
      )
    ).toBeUndefined();
  });

  test('isAllowedBundleHost rejects empty-label hf.co hostnames', () => {
    expect(account.isAllowedBundleHost('..hf.co')).toBe(false);
    expect(account.isAllowedBundleHost('.hf.co')).toBe(false);
    expect(account.isAllowedBundleHost('evilhf.co')).toBe(false);
  });

  test('isAllowedBundleHost accepts GitHub LFS storage hosts', () => {
    expect(account.isAllowedBundleHost('github-cloud.githubusercontent.com')).toBe(true);
    expect(account.isAllowedBundleHost('objects-origin.githubusercontent.com')).toBe(true);
  });

  test('isGitHubReleaseAssetApiUrl rejects URLs with embedded credentials', () => {
    expect(
      account.isGitHubReleaseAssetApiUrl(
        'https://user:pass@api.github.com/repos/pkmn/0-error/releases/assets/12345'
      )
    ).toBe(false);
  });

  test('validateArtifactUrl accepts allowlisted OCI registries', () => {
    const allowedOci = [
      'ghcr.io/pkmn/0-error:1.2.0',
      'pkmn/0-error:1.2.0',
      'docker.io/pkmn/0-error:1.2.0',
      'quay.io/pkmn/0-error:1.2.0',
      'us-central1-docker.pkg.dev/my-proj/repo/agent:1.2.0',
      '123456789012.dkr.ecr.us-east-1.amazonaws.com/agent:1.2.0',
    ];
    for (const ref of allowedOci) {
      expect(account.validateArtifactUrl(ref, 'oci')).toBeUndefined();
    }
  });

  test('validateArtifactUrl blocks non-allowlisted, HTTP, custom-port, or IP URLs', () => {
    const blockedBundles = [
      'https://evil.example.com/agent.tar.zst',
      'https://github.com:8443/pkmn/agent.tar.zst',
      'http://github.com/pkmn/agent.tar.zst',
      'https://127.0.0.1/agent.tar.zst',
      'https://169.254.169.254/latest/agent.tar.zst',
      'https://[::1]/agent.tar.zst',
      'https://[::ffff:127.0.0.1]/agent.tar.zst',
      'https://localhost/agent.tar.zst',
    ];
    for (const url of blockedBundles) {
      expect(account.validateArtifactUrl(url, 'bundle')).toBeTruthy();
    }
    expect(account.validateArtifactUrl('evil.example.com/pkmn/agent:1.0.0', 'oci')).toBeTruthy();
    expect(account.validateArtifactUrl('ghcr.io:5000/pkmn/agent:1.0.0', 'oci')).toBeTruthy();
    expect(account.validateArtifactUrl('127.0.0.1:5000/pkmn/agent:1.0.0', 'oci')).toBeTruthy();
    expect(account.validateArtifactUrl('intranet:5000/pkmn/agent:1.0.0', 'oci')).toBeTruthy();
  });

  test('validateArtifactUrl permits private loopback URLs only when opted in', () => {
    expect(account.validateArtifactUrl('http://127.0.0.1:8080/agent.tar.zst', 'bundle', true))
      .toBeUndefined();
  });

  test('encryptSecret roundtrips secrets via decryptSecret', () => {
    const enc = account.encryptSecret('Bearer ghp_secret123', 'session-secret-1');
    expect(enc).not.toContain('ghp_secret123');
    expect(account.decryptSecret(enc, 'session-secret-1')).toBe('Bearer ghp_secret123');
  });

  test('decryptSecret rejects wrong secrets or tampered ciphertexts', () => {
    const enc = account.encryptSecret('Bearer ghp_secret123', 'session-secret-1');
    expect(() => account.decryptSecret(enc, 'wrong-secret')).toThrow();
    expect(() => account.decryptSecret(`${enc}x`, 'session-secret-1')).toThrow();
  });

  test('decryptSecret rejects truncated GCM authentication tags', () => {
    const enc = account.encryptSecret('Bearer ghp_secret123', 'session-secret-1');
    const [ver, iv, tag, ct] = enc.split('.');
    const truncatedTag = Buffer.from(tag, 'base64url').subarray(0, 4).toString('base64url');
    expect(() => account.decryptSecret(`${ver}.${iv}.${truncatedTag}.${ct}`, 'session-secret-1'))
      .toThrow();
  });

  test('validateArtifactUrl blocks embedded URL credentials', () => {
    expect(account.validateArtifactUrl('https://user:pass@github.com/pkmn/a.tar.zst', 'bundle'))
      .toBeTruthy();
  });

  test('splitSubmittedTeams parses Showdown === headers, packed lines, arrays, or 6-block pastes',
    () => {
      const twoTeams = VALID_TWENTY_VGC.slice(0, 2);
      const withHeaders =
        `=== [gen9championsvgc2026regmc] Team 1 ===\n${twoTeams[0]}\n\n` +
        `=== [gen9championsvgc2026regmc] Team 2 ===\n${twoTeams[1]}`;
      expect(splitSubmittedTeams(withHeaders)).toHaveLength(2);
      expect(splitSubmittedTeams(twoTeams)).toHaveLength(2);
      expect(splitSubmittedTeams(`${twoTeams[0]}\n\n${twoTeams[1]}`)).toHaveLength(2);
      const packedOne = Team.import(twoTeams[0])!.pack();
      const packedTwo = Team.import(twoTeams[1])!.pack();
      expect(splitSubmittedTeams(`${packedOne}\n${packedTwo}`)).toEqual([packedOne, packedTwo]);
      expect(splitSubmittedTeams(`${packedOne}\ncorrupted-line`)).toEqual([
        packedOne,
        'corrupted-line',
      ]);
    });
});

function copyDirSync(src: string, dst: string) {
  fs.mkdirSync(dst, {recursive: true});
  for (const entry of fs.readdirSync(src, {withFileTypes: true})) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, dstPath);
    } else if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(srcPath), dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

describe('account routes', () => {
  let suiteTmpDir: string;
  let templateWikiDir: string;
  let tmpDir: string;
  let poolDir: string;
  let wikiDir: string;
  let projectsFile: string;
  let db: db.Database;
  let server: http.Server | undefined;
  let baseUrl: string;
  let currentNow: number;
  let wikiDirty = false;
  const realFetch = globalThis.fetch;

  beforeAll(() => {
    suiteTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-account-suite-'));
    templateWikiDir = path.join(suiteTmpDir, 'wiki-template');
    fs.mkdirSync(templateWikiDir, {recursive: true});
    const gitEnv = {...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'};
    execFileSync('git', ['init', '--template=', '-b', 'main'], {cwd: templateWikiDir, env: gitEnv});
    execFileSync('git', ['config', 'user.name', 'test'], {cwd: templateWikiDir, env: gitEnv});
    execFileSync('git', ['config', 'user.email', 'test@pkmn.ai'], {
      cwd: templateWikiDir,
      env: gitEnv,
    });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], {cwd: templateWikiDir, env: gitEnv});
    execFileSync('git', ['config', 'gc.auto', '0'], {cwd: templateWikiDir, env: gitEnv});
    execFileSync('git', ['config', 'maintenance.auto', 'false'], {
      cwd: templateWikiDir,
      env: gitEnv,
    });
    fs.writeFileSync(path.join(templateWikiDir, 'index.dj'), '# Home\n');
    execFileSync('git', ['add', 'index.dj'], {cwd: templateWikiDir, env: gitEnv});
    execFileSync('git', ['commit', '-m', 'Init'], {cwd: templateWikiDir, env: gitEnv});

    tmpDir = path.join(suiteTmpDir, 'shared');
    poolDir = path.join(tmpDir, 'vgc-pool');
    wikiDir = path.join(tmpDir, 'wiki');
    projectsFile = path.join(tmpDir, 'projects.yml');
    fs.mkdirSync(poolDir, {recursive: true});
    copyDirSync(templateWikiDir, wikiDir);
    fs.writeFileSync(projectsFile, PROJECTS_YAML, 'utf8');
    fs.writeFileSync(path.join(poolDir, 'public000001'), PUBLIC_CLONE_VGC, 'utf8');
    clearReferencePoolCache();
  });

  afterAll(() => {
    clearReferencePoolCache();
    if (suiteTmpDir) fs.rmSync(suiteTmpDir, {recursive: true, force: true});
  });

  const openLadders = (ids: string[]) => {
    const stmt = db!.db.prepare("UPDATE ladders SET status = 'active' WHERE id = ?");
    for (const id of ids) stmt.run(id);
  };

  beforeEach(async () => {
    if (wikiDirty) {
      fs.rmSync(wikiDir, {recursive: true, force: true});
      copyDirSync(templateWikiDir, wikiDir);
      fs.writeFileSync(projectsFile, PROJECTS_YAML, 'utf8');
      wikiDirty = false;
    }

    currentNow = 1_760_000_000;
    const nextDb = new Database(':memory:');
    db = nextDb;
    nextDb.syncLadders();
    nextDb.syncProjectsFromYaml(PROJECTS_YAML, path.join(tmpDir, 'avatars'), currentNow);
    nextDb.setAgentLadders('0-error', ALL_SLOTS, currentNow);
    nextDb.setAgentLadders('foul-play', ALL_SLOTS, currentNow);
    nextDb.linkDeveloperDiscord('pre', '513513270670262284', 'scheibo', currentNow);

    const wikiInstance = new wiki.Wiki({
      wikiDir,
      projectsFile,
      db: nextDb,
      auth: new auth.Auth({
        config: AUTH_CFG,
        db: nextDb,
        isAuthorizedGitHub: (login): boolean => wikiInstance.isDeveloper(login),
      }),
      push: false,
    });
    const app = polka();
    wikiInstance.auth.register(app);
    account.register(app, {
      db: nextDb,
      auth: wikiInstance.auth,
      poolsByLadder: new Map([['gen9championsvgc2026regmc', [poolDir]]]),
      now: () => currentNow,
    });
    wiki.register(app, wikiInstance);

    const nextServer = http.createServer((req, res) => app.handler(req as polka.Request, res));
    server = nextServer;
    await new Promise<void>(resolve => nextServer.listen(0, '127.0.0.1', resolve));
    const addr = nextServer.address() as {port: number};
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    if (server) {
      server.closeAllConnections();
      if (server.listening) {
        await new Promise<void>(resolve => server!.close(() => resolve()));
      }
      server = undefined;
    }
    (db as db.Database | undefined)?.close();
  });

  const githubIdFor = (login: string): number => {
    const existing = db.getDeveloperByGitHub(login)?.githubId;
    if (existing !== undefined) return existing;
    let h = 2166136261;
    for (let i = 0; i < login.length; i++) {
      h = Math.imul(h ^ login.charCodeAt(i), 16777619) >>> 0;
    }
    return (h % 900_000_000) + 10_000;
  };

  const cookieFor = (login: string, id = githubIdFor(login)) => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const tok = auth.signToken({github: {id, login}, exp}, AUTH_CFG.sessionSecret);
    return `${auth.SESSION_COOKIE}=${encodeURIComponent(tok)}`;
  };

  const postSubmission = (login: string, body: Record<string, unknown>) =>
    realFetch(`${baseUrl}/api/submissions`, {
      method: 'POST',
      headers: {
        Cookie: cookieFor(login),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });

  describe('account portal qualification lifecycle', () => {
    test('redirects unauthenticated /account requests to GitHub OAuth', async () => {
      const unauth = await realFetch(`${baseUrl}/account`, {redirect: 'manual'});
      expect(unauth.status).toBe(302);
      expect(unauth.headers.get('location')).toBe('/auth/github?return_to=%2Faccount%2F');
    });

    test('redirects unregistered GitHub users on /account to the registration issue', async () => {
      const stranger = await realFetch(`${baseUrl}/account`, {
        headers: {Cookie: cookieFor('stranger')},
        redirect: 'manual',
      });
      expect(stranger.status).toBe(302);
      expect(stranger.headers.get('location')).toBe(auth.REGISTER_ISSUE_URL);
    });

    test('redirects unregistered admin on /account to /admin/', async () => {
      const adminRes = await realFetch(`${baseUrl}/account`, {
        headers: {Cookie: cookieFor('scheibo')},
        redirect: 'manual',
      });
      expect(adminRes.status).toBe(302);
      expect(adminRes.headers.get('location')).toBe('/admin/');
    });

    test('rejects disabled projects on /account with 403', async () => {
      db.db.prepare("UPDATE agents SET status = 'disabled' WHERE slug = '0-error'").run();
      const disabled = await realFetch(`${baseUrl}/account`, {
        headers: {Cookie: cookieFor('pre')},
        redirect: 'manual',
      });
      expect(disabled.status).toBe(403);
      const html = await disabled.text();
      expect(html).toContain('<h2>403</h2>');
      expect(html).toContain('<p>Forbidden</p>');
    });

    test('rejects disabled projects on /auth/github/callback with 403', async () => {
      db.db.prepare("UPDATE agents SET status = 'disabled' WHERE slug = '0-error'").run();
      const startRes = await realFetch(`${baseUrl}/auth/github?return_to=%2Faccount%2F`, {
        redirect: 'manual',
      });
      expect(startRes.status).toBe(302);
      const state = new URL(startRes.headers.get('location')!).searchParams.get('state')!;
      const rawCookie = startRes.headers.get('set-cookie')!;
      const stateCookie = rawCookie.split(';')[0];

      globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string'
          ? input
          : input instanceof URL ? input.toString() : input.url;
        if (url === 'https://github.com/login/oauth/access_token') {
          return new Response(JSON.stringify({access_token: 'gho_123'}), {status: 200});
        }
        if (url === 'https://api.github.com/user') {
          return new Response(JSON.stringify({id: 105440, login: 'pre'}), {status: 200});
        }
        return realFetch(input, init);
      };

      const cb = await realFetch(
        `${baseUrl}/auth/github/callback?code=c1&state=${encodeURIComponent(state)}`,
        {
          headers: {Cookie: stateCookie},
          redirect: 'manual',
        }
      );
      expect(cb.status).toBe(403);
      const html = await cb.text();
      expect(html).toContain('<h2>403</h2>');
      expect(html).toContain('<p>Forbidden</p>');
    });

    test('redirects sessions whose numeric GitHub ID disagrees with the database', async () => {
      db.linkDeveloperGitHubId('pre', githubIdFor('pre'), currentNow);
      const res = await realFetch(`${baseUrl}/account`, {
        headers: {Cookie: cookieFor('pre', 999_999)},
        redirect: 'manual',
      });
      expect(res.status).toBe(302);
    });

    test('preserves /account access across GitHub handle renames via numeric ID', async () => {
      db.linkDeveloperGitHubId('pre', githubIdFor('pre'), currentNow);
      const res = await realFetch(`${baseUrl}/account`, {
        headers: {Cookie: cookieFor('pre-renamed', githubIdFor('pre'))},
      });
      expect(res.status).toBe(200);
    });

    test('renders Pending status with disabled submission form for unqualified projects',
      async () => {
        const res = await realFetch(`${baseUrl}/account`, {
          headers: {Cookie: cookieFor('rookie')},
        });
        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain('>Pending<');
        expect(html).toContain('<fieldset class="form-fieldset" disabled>');
        expect(html).toContain(
          '<link rel="preconnect" href="https://play.pokemonshowdown.com">'
        );
      });

    test('blocks ladder submissions from Pending projects with 403', async () => {
      openLadders(['gen1ou20261109']);
      const res = await postSubmission('rookie', {
        version: '0.1.0',
        package: 'bundle',
        url: 'https://github.com/pkmn/newcomer.tar.zst',
        sha256: SHA_A,
        ladders: ['RBY'],
      });
      expect(res.status).toBe(403);
      expect((await res.json() as {error: string}).error).toContain('pending');
    });

    test('allows Pending project owners to edit wiki pages before qualification', async () => {
      wikiDirty = true;
      const wikiSave = await realFetch(`${baseUrl}/wiki/Newcomer`, {
        method: 'POST',
        headers: {
          Cookie: cookieFor('rookie'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          content: '# Newcomer\n\nWork in progress.',
          message: 'Initial project notes',
          action: 'save',
        }).toString(),
        redirect: 'manual',
      });
      expect(wikiSave.status).toBe(303);
    });

    test('allows Qualified projects to submit to upcoming ladders pre-launch', async () => {
      const preHtml = await (await realFetch(`${baseUrl}/account`, {
        headers: {Cookie: cookieFor('pre')},
      })).text();
      expect(preHtml).toContain('>Eligible<');
      expect(preHtml).toContain('(upcoming)');
      expect(preHtml).not.toContain('<fieldset class="form-fieldset" disabled>');
      expect(preHtml).toContain('<label for="sub-ver">Version<span class="req">*</span></label>');
      expect(preHtml).toContain(
        '<label for="sub-url">Artifact URL<span class="req">*</span></label>'
      );
      expect(preHtml).toContain('<label for="sub-sha">SHA-256<span class="req">*</span></label>');
      expect(preHtml).toContain('<label for="sub-auth">Auth Header</label>');
      expect(preHtml).toContain(
        '<label for="sub-teams" class="pool-teams-field hide">' +
          'Teams<span class="req">*</span></label>'
      );
      expect(preHtml).toContain('<label>Target<span class="req">*</span></label>');
      expect(preHtml).toContain('placeholder="1.0.0"');
      expect(preHtml).toContain(
        'placeholder="Private release/registry header ' +
          '(scrubbed after ladder fetch; keep valid through tournament)"'
      );
      expect(preHtml).toContain(
        'Paste up to 20 teams (one packed team per line or exportable with '
      );
      expect(preHtml).not.toContain('validate-teams-btn');
      expect(preHtml).not.toContain('clear-teams-btn');
      expect(preHtml).not.toContain('sub-teams-file');
      expect(preHtml).toMatch(/<button(?=[^>]*\bid="sub-btn")(?=[^>]*\bdisabled\b)[^>]*>/);

      const sub = await postSubmission('pre', {
        version: '0.9.0',
        package: 'bundle',
        url: 'https://github.com/pkmn/0-error-0.9.0.tar.zst',
        sha256: SHA_A,
        ladders: ['ADV'],
      });
      expect(sub.status).toBe(201);
      const {versionId} = await sub.json() as {versionId: number};
      db.applySubmissionStatus({versionId, smokeStatus: 'passed', now: currentNow});
      db.refundCooldown('0-error');
      expect(db.computeAgentSubmissionStatus(db.getAgentBySlug('0-error')!.id, currentNow)).toEqual(
        {label: 'Eligible', canSubmit: true}
      );
    });

    test('renders Qualified status with disabled form when all ladders are settling', async () => {
      db.db.prepare("UPDATE ladders SET status = 'settling'").run();
      const html = await (await realFetch(`${baseUrl}/account`, {
        headers: {Cookie: cookieFor('pre')},
      })).text();
      expect(html).toContain('>Qualified<');
      expect(html).toContain('<fieldset class="form-fieldset" disabled>');

      const closedSub = await postSubmission('pre', {
        version: '1.0.0',
        package: 'bundle',
        url: 'https://github.com/pkmn/0-error-1.0.0.tar.zst',
        sha256: SHA_A,
        ladders: ['RBY'],
      });
      expect(closedSub.status).toBe(403);
    });

    test('rejects submissions targeting a settling ladder with 400', async () => {
      db.db.prepare("UPDATE ladders SET status = 'settling'").run();
      openLadders(['gen1ou20261109', 'gen9ou20261109']);
      const html = await (await realFetch(`${baseUrl}/account`, {
        headers: {Cookie: cookieFor('pre')},
      })).text();
      expect(html).not.toContain('value="gen3ou20261109"');

      const settlingSub = await postSubmission('pre', {
        version: '1.0.0',
        package: 'bundle',
        url: 'https://github.com/pkmn/0-error.tar.zst',
        sha256: SHA_A,
        ladders: ['ADV'],
      });
      expect(settlingSub.status).toBe(400);
    });

    test('scopes Discord link per developer while sharing project Active or History tables',
      async () => {
        openLadders(['gen1ou20261109', 'gen3ou20261109']);
        const agent = db.getAgentBySlug('0-error')!;

        const v1 = db.createSubmission({
          agentId: agent.id,
          developerId: db.getDeveloperByGitHub('pre')!.id,
          version: '1.0.0',
          package: 'bundle',
          url: 'https://github.com/pkmn/0-error-1.0.0.tar.zst',
          sha256: SHA_A,
          ladderIds: ['gen1ou20261109', 'gen3ou20261109'],
          now: currentNow - 40 * 86400,
        });
        db.db.prepare(
          `UPDATE agent_versions
           SET smoke_status = 'passed', unpacked_bytes = 276824064,
               smoke_duration_millis = 3800, smoke_turn_millis = 375, smoke_peak_ram = 930
           WHERE id = ?`
        ).run(v1.id);
        db.db.prepare(
          `INSERT INTO ladder_entries (
             ladder_id, version_id, role, elo, se, rank_current,
             matches, ww, wt, split, tl, ll, settled_at
           ) VALUES (?, ?, 'retired', 1650, 22, NULL, 60, 30, 0, 15, 0, 15, ?)`
        ).run('gen1ou20261109', v1.id, currentNow - 30 * 86400);

        const vFail = db.createSubmission({
          agentId: agent.id,
          developerId: db.getDeveloperByGitHub('pre')!.id,
          version: '1.1.0-rc1',
          package: 'bundle',
          url: 'https://github.com/pkmn/0-error-1.1.0-rc1.tar.zst',
          sha256: SHA_B,
          ladderIds: ['gen1ou20261109'],
          now: currentNow - 20 * 86400,
        });
        db.db.prepare(
          `UPDATE agent_versions
           SET smoke_status = 'failed', notified = 1,
               smoke_error = 'Seatbelt EPERM: denied read outside $AGENT_DIR'
           WHERE id = ?`
        ).run(vFail.id);

        const v2 = db.createSubmission({
          agentId: agent.id,
          developerId: db.getDeveloperByGitHub('coauthor')!.id,
          version: '1.1.0',
          package: 'bundle',
          url: 'https://github.com/pkmn/0-error-1.1.0.tar.zst',
          sha256: SHA_A,
          ladderIds: ['gen1ou20261109', 'gen3ou20261109'],
          now: currentNow - 16 * 86400,
        });
        db.db.prepare(
          `UPDATE agent_versions
           SET smoke_status = 'passed', unpacked_bytes = 312475648,
               smoke_duration_millis = 4100, smoke_turn_millis = 402, smoke_peak_ram = 1140
           WHERE id = ?`
        ).run(v2.id);
        db.db.prepare(
          `INSERT INTO ladder_entries (
             ladder_id, version_id, role, elo, se, rank_current,
             matches, ww, wt, split, tl, ll, settled_at
           ) VALUES (?, ?, 'champion', 1748, 14.3, 1, 180, 118, 0, 38, 0, 24, ?)`
        ).run('gen1ou20261109', v2.id, currentNow - 10 * 86400);

        const preHtml = await (await realFetch(`${baseUrl}/account`, {
          headers: {Cookie: cookieFor('pre')},
        })).text();
        expect(preHtml).toContain('<strong>pre</strong>');
        expect(preHtml).toContain('href="/projects/0-error/"');
        expect(preHtml).toContain('@scheibo');
        expect(preHtml).toContain('118–24–38');
        expect(preHtml).toContain('Seatbelt EPERM');
        expect(preHtml).toContain('(DM sent)');
        expect(preHtml).toContain('>Retired<');

        const coHtml = await (await realFetch(`${baseUrl}/account`, {
          headers: {Cookie: cookieFor('coauthor')},
        })).text();
        expect(coHtml).toContain('<strong>coauthor</strong>');
        expect(coHtml).not.toContain('@scheibo');
        expect(coHtml).toContain('>link<');
        expect(coHtml).toContain('118–24–38');
        expect(coHtml).toContain('1.1.0-rc1');
      });

    test('renders anchor active entries as 1500 ±0 on /account', async () => {
      openLadders(['gen1ou20261109']);
      const agent = db.getAgentBySlug('0-error')!;
      const v1 = db.createSubmission({
        agentId: agent.id,
        developerId: db.getDeveloperByGitHub('pre')!.id,
        version: '1.0.0',
        package: 'bundle',
        url: 'https://github.com/pkmn/0-error-1.0.0.tar.zst',
        sha256: SHA_A,
        ladderIds: ['gen1ou20261109'],
        now: currentNow - 16 * 86400,
      });
      db.db.prepare(
        'UPDATE agent_versions SET smoke_status = ? WHERE id = ?'
      ).run('passed', v1.id);
      db.db.prepare(
        `INSERT INTO ladder_entries (
           ladder_id, version_id, role, is_anchor, elo, se, rank_current,
           matches, ww, wt, split, tl, ll, settled_at
         ) VALUES (?, ?, 'champion', 1, 1500, 18.5, 2, 100, 50, 0, 0, 0, 50, ?)`
      ).run('gen1ou20261109', v1.id, currentNow - 10 * 86400);

      const html = await (await realFetch(`${baseUrl}/account`, {
        headers: {Cookie: cookieFor('pre')},
      })).text();
      expect(html).toContain('<strong>1500</strong> <span class="muted">±0</span>');
    });

    test('updates project ownership across /account or wiki on developer reassignment',
      async () => {
        wikiDirty = true;
        openLadders(['gen1ou20261109']);
        const commentedYaml = `# Arena projects registry
- name: 0 ERROR # flagship search agent
  active: 2026
  arena:
    owners:
      pre: pre.10544
- name: Foul Play
  active: 2026
  arena:
    owners:
      pmariglia: pmariglia.535629
`;
        fs.writeFileSync(projectsFile, commentedYaml, 'utf8');
        db.syncProjects(projectsFile, path.join(tmpDir, 'avatars'), currentNow);

        const zeroAgent = db.getAgentBySlug('0-error')!;
        const vZero = db.createSubmission({
          agentId: zeroAgent.id,
          developerId: db.getDeveloperByGitHub('pre')!.id,
          version: '1.0.0',
          package: 'bundle',
          url: 'https://github.com/pkmn/0-error-1.0.0.tar.zst',
          sha256: SHA_A,
          ladderIds: ['gen1ou20261109'],
          now: currentNow,
        });
        db.applySubmissionStatus({versionId: vZero.id, smokeStatus: 'passed', now: currentNow + 5});

        const postWiki = (slug: string, login: string, content: string) =>
          realFetch(`${baseUrl}/wiki/${slug}`, {
            method: 'POST',
            headers: {
              Cookie: cookieFor(login),
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
              content,
              message: `Update ${slug}`,
              action: 'save',
            }).toString(),
            redirect: 'manual',
          });

        expect(
          (await postWiki('projects/0_ERROR', 'pre', '{% visibility: developers %}\n# 0 ERROR\n'))
            .status
        ).toBe(303);
        expect(
          (await postWiki(
            'projects/Foul_Play',
            'pmariglia',
            '{% visibility: developers %}\n# Foul Play\n'
          )).status
        ).toBe(303);

        await runPkmnCli(
          ['reassign-developer', 'pre', 'Foul Play', '--projects', projectsFile, '--offline'],
          {db, now: currentNow + 20, log: () => undefined}
        );

        const updatedYaml = fs.readFileSync(projectsFile, 'utf8');
        expect(updatedYaml).toContain('# Arena projects registry');
        expect(updatedYaml).toContain('# flagship search agent');
        expect(db.getActiveEntriesForAgent(zeroAgent.id)).toHaveLength(1);
        expect(db.getDevelopersForAgent(zeroAgent.id)).toEqual([]);

        const movedAccount = await (await realFetch(`${baseUrl}/account`, {
          headers: {Cookie: cookieFor('pre')},
        })).text();
        expect(movedAccount).toContain('href="/projects/foul-play/"');
        expect(
          (await postWiki('projects/0_ERROR', 'pre', '{% visibility: developers %}\n# Nope\n'))
            .status
        ).toBe(403);
        expect(
          (await postWiki('projects/Foul_Play', 'pre', '{% visibility: developers %}\n# Joined!\n'))
            .status
        ).toBe(303);

        await runPkmnCli(
          ['reassign-developer', 'pre', '0 ERROR', '--projects', projectsFile, '--offline'],
          {db, now: currentNow + 40, log: () => undefined}
        );

        const returnedAccount = await (await realFetch(`${baseUrl}/account`, {
          headers: {Cookie: cookieFor('pre')},
        })).text();
        expect(returnedAccount).toContain('href="/projects/0-error/"');
        expect(
          (await postWiki('projects/Foul_Play', 'pre', '{% visibility: developers %}\n# Nope\n'))
            .status
        ).toBe(403);
        expect(
          (await postWiki('projects/0_ERROR', 'pre', '{% visibility: developers %}\n# Back!\n'))
            .status
        ).toBe(303);
      });
  });

  describe('ladder submission gates', () => {
    beforeEach(() => {
      openLadders(['gen1ou20261109', 'gen9ou20261109']);
    });

    test('rejects invalid version strings or mismatched package formats with 400', async () => {
      const badVer = await postSubmission('pmariglia', {
        version: 'bad version string!!',
        package: 'bundle',
        url: 'https://github.com/pkmn/fp.tar.xz',
        sha256: SHA_A,
        ladders: ['RBY'],
      });
      expect(badVer.status).toBe(400);

      const badType = await postSubmission('pmariglia', {
        version: '1.0.0',
        package: 'oci',
        url: 'https://github.com/pkmn/fp.tar.xz',
        sha256: SHA_A,
        ladders: ['RBY'],
      });
      expect(badType.status).toBe(400);

      const badSha = await postSubmission('pmariglia', {
        version: '1.0.0',
        package: 'bundle',
        url: 'https://github.com/pkmn/fp.tar.xz',
        sha256: 'not-a-sha256',
        ladders: ['RBY'],
      });
      expect(badSha.status).toBe(400);
      expect(await badSha.json()).toEqual({
        error: 'Invalid SHA-256 (must be a 64-character hex digest).',
      });
    });

    test('rejects version strings longer than 12 characters with 400', async () => {
      const tooLong = await postSubmission('pre', {
        version: '1.2.3-toolong',
        url: 'https://github.com/pkmn/0-error.tar.zst',
        sha256: SHA_A,
        ladders: ['gen1ou20261109'],
      });
      expect(tooLong.status).toBe(400);
      expect((await tooLong.json() as {error: string}).error).toMatch(/1[–-]12 chars/);
    });

    test('rejects oversized submission payloads above 512 KB with 413', async () => {
      const oversized = await postSubmission('pre', {
        version: '1.0.0',
        url: 'https://github.com/pkmn/0-error.tar.zst',
        sha256: SHA_A,
        ladders: ['gen1ou20261109'],
        padding: 'x'.repeat(600_000),
      });
      expect(oversized.status).toBe(413);
    });

    test('encrypts private auth tokens while normalizing SHA-256 digests', async () => {
      const okSub = await postSubmission('pmariglia', {
        version: '1.0.0',
        package: 'oci',
        url: 'ghcr.io/pmariglia/foul-play:1.0.0',
        sha256: SHA_A.toUpperCase(),
        authToken: 'Bearer ghcr_pat_123',
        ladders: ['RBY', 'SV'],
      });
      expect(okSub.status).toBe(201);
      const createdJson = await okSub.json() as {versionId: number; smokeStatus: string};
      expect(createdJson.smokeStatus).toBe('pending');

      const stored = db.getVersionsForAgent(db.getAgentBySlug('foul-play')!.id)[0];
      expect(stored.sha256).toBe(SHA_A);
      expect(stored.ladders).toEqual(['gen1ou20261109', 'gen9ou20261109']);
      expect(account.decryptSecret(stored.authTokenEncoding!, AUTH_CFG.sessionSecret)).toBe(
        'Bearer ghcr_pat_123'
      );
    });

    test('rejects authToken containing NUL or ASCII control characters with 400', async () => {
      const nulRes = await postSubmission('pmariglia', {
        version: '1.0.0',
        package: 'oci',
        url: 'ghcr.io/pmariglia/foul-play:1.0.0',
        sha256: SHA_A,
        authToken: 'Bearer ghcr_pat\x00evil',
        ladders: ['RBY'],
      });
      expect(nulRes.status).toBe(400);

      const tabRes = await postSubmission('pmariglia', {
        version: '1.0.0',
        package: 'oci',
        url: 'ghcr.io/pmariglia/foul-play:1.0.0',
        sha256: SHA_A,
        authToken: 'Bearer ghcr_pat\x1f',
        ladders: ['RBY'],
      });
      expect(tabRes.status).toBe(400);
    });

    test('blocks concurrent submissions with 429 while a smoke test is pending', async () => {
      const sub1 = await postSubmission('pmariglia', {
        version: '1.0.0',
        package: 'oci',
        url: 'ghcr.io/pmariglia/foul-play:1.0.0',
        sha256: SHA_A,
        ladders: ['RBY'],
      });
      expect(sub1.status).toBe(201);

      const blockedPending = await postSubmission('pmariglia', {
        version: '1.0.1',
        package: 'oci',
        url: 'ghcr.io/pmariglia/foul-play:1.0.1',
        sha256: SHA_B,
        ladders: ['RBY'],
      });
      expect(blockedPending.status).toBe(429);
    });

    test('refunds submission cooldown automatically when a smoke test fails', async () => {
      const agent = db.getAgentBySlug('foul-play')!;
      const sub = await postSubmission('pmariglia', {
        version: '1.0.0',
        package: 'oci',
        url: 'ghcr.io/pmariglia/foul-play:1.0.0',
        sha256: SHA_A,
        ladders: ['RBY'],
      });
      const {versionId} = await sub.json() as {versionId: number};
      db.applySubmissionStatus({versionId, smokeStatus: 'failed', now: currentNow + 5});
      expect(db.computeAgentSubmissionStatus(agent.id, currentNow + 10).label).toBe('Eligible');
    });

    test('enforces 14-day cooldown plus rating settlement after smoke pass', async () => {
      const agent = db.getAgentBySlug('foul-play')!;
      const sub = await postSubmission('pmariglia', {
        version: '1.0.0',
        package: 'oci',
        url: 'ghcr.io/pmariglia/foul-play:1.0.0',
        sha256: SHA_A,
        ladders: ['RBY'],
      });
      const {versionId} = await sub.json() as {versionId: number};
      db.applySubmissionStatus({versionId, smokeStatus: 'passed', now: currentNow + 5});

      expect(db.computeAgentSubmissionStatus(agent.id, currentNow + 86400).label)
        .toBe('Ineligible');

      currentNow += COOLDOWN_SECONDS + 60;
      const unsettledStatus = db.computeAgentSubmissionStatus(agent.id, currentNow);
      expect(unsettledStatus.canSubmit).toBe(false);
      expect(unsettledStatus.reason).toContain('has not settled');

      db.db.prepare(
        'UPDATE ladder_entries SET se = 24, matches = 30 WHERE version_id = ?'
      ).run(versionId);
      expect(db.computeAgentSubmissionStatus(agent.id, currentNow)).toEqual({
        label: 'Eligible',
        canSubmit: true,
      });
    });
  });

  describe('VGC pools team validation', () => {
    beforeEach(() => {
      openLadders(['gen9championsvgc2026regmc']);
    });

    const postVgc = (version: string, teams?: string | string[]) =>
      postSubmission('pre', {
        version,
        package: 'bundle',
        url: `https://github.com/pkmn/0-error-${version}.tar.zst`,
        sha256: SHA_A,
        ladders: ['VGC'],
        ...(teams !== undefined ? {teams} : {}),
      });

    test('rejects VGC submissions missing required 20 teams', async () => {
      const res = await postVgc('1.0.0');
      expect(res.status).toBe(400);
      expect((await res.json() as {error: string}).error).toContain('requires 20 valid teams');
    });

    test('saves valid subset while rejecting incomplete team counts', async () => {
      const res = await postVgc('1.0.0', VALID_TWENTY_VGC.slice(0, 19));
      expect(res.status).toBe(400);
      const body = await res.json() as {
        error: string;
        savedCount: number;
        remainingCount: number;
      };
      expect(body.error).toContain('Expected 20 teams for gen9championsvgc2026regmc, received 19');
      expect(body.savedCount).toBe(19);
      expect(body.remainingCount).toBe(1);
    });

    test('rejects illegal sets while preserving the valid teams in the batch', async () => {
      const withIllegal = [...VALID_TWENTY_VGC];
      withIllegal[4] = VALID_TWENTY_VGC[4].replace(/^[A-Za-z-]+ @/, 'Mewtwo @');
      const res = await postVgc('1.0.0', withIllegal);
      expect(res.status).toBe(400);
      const body = await res.json() as {error: string; savedCount: number};
      expect(body.error).toContain('Team #5');
      expect(body.savedCount).toBe(19);
    });

    test('rejects clones of public reference pool teams', async () => {
      const withPublicClone = [...VALID_TWENTY_VGC];
      withPublicClone[2] = PUBLIC_CLONE_VGC;
      const res = await postVgc('1.0.0', withPublicClone);
      expect(res.status).toBe(400);
      const body = await res.json() as {error: string; savedCount: number};
      expect(body.error).toContain('Team #3 failed uniqueness check');
      expect(body.error).toContain('closest=public000001');
      expect(body.savedCount).toBe(19);
    });

    test('rejects duplicate teams within the same submission batch', async () => {
      const withSelfClone = [...VALID_TWENTY_VGC];
      withSelfClone[7] = VALID_TWENTY_VGC[1];
      const res = await postVgc('1.0.0', withSelfClone);
      expect(res.status).toBe(400);
      const body = await res.json() as {error: string; savedCount: number};
      expect(body.error).toContain('Team #8 failed uniqueness check');
      expect(body.error).toContain('closest=submitted-team-2');
      expect(body.savedCount).toBe(19);
    });

    test('rate-limits rapid /api/submissions calls after 5 attempts per minute', async () => {
      for (let i = 0; i < 5; i++) {
        expect((await postVgc('1.0.0')).status).toBe(400);
      }
      const throttled = await postVgc('1.0.0', VALID_TWENTY_VGC);
      expect(throttled.status).toBe(429);
      expect(throttled.headers.get('retry-after')).toBe('60');
    });

    test('locks seasonal VGC team roster after smoke pass while allowing reuse', async () => {
      const backupPaste = VALID_TWENTY_VGC
        .map((t, i) => `=== [gen9championsvgc2026regmc] Team ${i + 1} ===\n${t}`)
        .join('\n\n');
      const okRes = await postVgc('1.0.0', backupPaste);
      expect(okRes.status).toBe(201);
      const {versionId} = await okRes.json() as {versionId: number};

      const agent = db.getAgentBySlug('0-error')!;
      expect(db.getTeamsForAgentLadder('gen9championsvgc2026regmc', agent.id, 'pending'))
        .toHaveLength(20);

      db.applySubmissionStatus({versionId, smokeStatus: 'passed', now: currentNow + 5});
      db.db.prepare(
        `UPDATE ladder_entries SET se = 20, matches = 35, settled_at = ?
         WHERE version_id = ?`
      ).run(currentNow + 86400, versionId);
      currentNow += COOLDOWN_SECONDS + 3600;

      const overwriteAttempt = await postVgc('1.1.0', backupPaste);
      expect(overwriteAttempt.status).toBe(400);
      expect((await overwriteAttempt.json() as {error: string}).error).toContain('already locked');

      const reuseOk = await postVgc('1.1.0');
      expect(reuseOk.status).toBe(201);
      expect(db.getTeamsForAgentLadder('gen9championsvgc2026regmc', agent.id, 'active'))
        .toHaveLength(20);
    });

    test('incrementally saves valid pool teams across batches up to 20/20', async () => {
      const illegalTeam = VALID_TWENTY_VGC[4].replace(/^[A-Za-z-]+ @/, 'Mewtwo @');
      const batchOne = [
        ...VALID_TWENTY_VGC.slice(0, 14),
        illegalTeam,
        illegalTeam,
        PUBLIC_CLONE_VGC,
        PUBLIC_CLONE_VGC,
        VALID_TWENTY_VGC[0],
        VALID_TWENTY_VGC[1],
      ];
      const res1 = await postVgc('1.0.0', batchOne);
      expect(res1.status).toBe(400);
      expect(await res1.json()).toMatchObject({
        savedCount: 14,
        newlySavedCount: 14,
        requiredCount: 20,
        remainingCount: 6,
      });

      const acctHtml = await (await realFetch(`${baseUrl}/account`, {
        headers: {Cookie: cookieFor('pre')},
      })).text();
      expect(acctHtml).toContain(
        '<span id="pool-progress-text"><strong>14/20</strong> distinct teams saved</span>'
      );
      expect(acctHtml).not.toContain('more needed');
      expect(acctHtml).not.toContain('1-NN');
      expect(acctHtml).toContain('data-saved-teams="14"');

      const acctJson = await (await realFetch(`${baseUrl}/account.json`, {
        headers: {Cookie: cookieFor('pre')},
      })).json() as {savedTeams: Record<string, unknown>};
      expect(acctJson.savedTeams.gen9championsvgc2026regmc).toEqual({
        savedCount: 14,
        requiredCount: 20,
        remainingCount: 6,
        complete: false,
        locked: false,
      });

      const incompleteSub = await postVgc('1.0.0');
      expect(incompleteSub.status).toBe(400);
      const incompleteErr = (await incompleteSub.json() as {error: string}).error;
      expect(incompleteErr).toContain('(14/20 distinct teams saved)');
      expect(incompleteErr).not.toContain('more needed');

      const res2 = await postVgc(
        '1.0.0',
        [...VALID_TWENTY_VGC.slice(0, 17), illegalTeam, PUBLIC_CLONE_VGC, VALID_TWENTY_VGC[2]]
      );
      expect(res2.status).toBe(400);
      expect(await res2.json()).toMatchObject({
        savedCount: 17,
        newlySavedCount: 3,
        remainingCount: 3,
      });

      const res3 = await postVgc('1.0.0', VALID_TWENTY_VGC.slice(17, 20));
      expect(res3.status).toBe(201);
      const agent = db.getAgentBySlug('0-error')!;
      expect(db.getTeamsForAgentLadder('gen9championsvgc2026regmc', agent.id, 'pending'))
        .toHaveLength(20);
    });

    test('accepts 20 packed teams separated by newlines', async () => {
      const packedPaste = VALID_TWENTY_VGC
        .map(t => Team.import(t)!.pack())
        .join('\n');
      const res = await postVgc('1.0.0', packedPaste);
      expect(res.status).toBe(201);
      const agent = db.getAgentBySlug('0-error')!;
      expect(db.getTeamsForAgentLadder('gen9championsvgc2026regmc', agent.id, 'pending'))
        .toHaveLength(20);
    });

    test('promotes saved 20/20 draft teams to pending when submitting without teams', async () => {
      const saveAllWithExtraDup = await postVgc(
        '1.0.0',
        [...VALID_TWENTY_VGC, VALID_TWENTY_VGC[0]]
      );
      expect(saveAllWithExtraDup.status).toBe(400);
      expect(await saveAllWithExtraDup.json()).toMatchObject({
        savedCount: 20,
        requiredCount: 20,
        remainingCount: 0,
      });

      const finalSub = await postVgc('1.0.0');
      expect(finalSub.status).toBe(201);
      const agent = db.getAgentBySlug('0-error')!;
      expect(db.getTeamsForAgentLadder('gen9championsvgc2026regmc', agent.id, 'saved'))
        .toHaveLength(0);
      expect(db.getTeamsForAgentLadder('gen9championsvgc2026regmc', agent.id, 'pending'))
        .toHaveLength(20);
    });
  });

  describe('tournament submissions', () => {
    beforeEach(() => {
      db.upsertTournament({
        id: '2',
        name: 'Tournament #2: VGC 2026 Reg M-C OTS BO3',
        format: 'gen9championsvgc2026regmc',
        version: '0.11.0',
        gamesPerMatchup: 8,
        parallelTables: 2,
        hardware: 'GCP L4 Spot',
        status: 'running',
        startsAt: currentNow - 3600,
      });
      db.upsertTournament({
        id: '3',
        name: 'Tournament #3: VGC 2026 Reg M-D OTS BO3',
        format: 'gen9championsvgc2026regmc',
        version: '0.11.0',
        gamesPerMatchup: 8,
        parallelTables: 2,
        hardware: 'GCP L4 Spot',
        status: 'scheduled',
        startsAt: currentNow + 86400 * 7,
      });
    });

    test('renders live tournament #topbar banner across /account or /wiki', async () => {
      const expectedBanner =
        '<div id="topbar"><a href="/arena/tournaments/2/" class="subtle">' +
        '<span>\u25cf LIVE</span> Tournament #2: VGC 2026 Reg M-C OTS BO3</a></div>';

      const acctHtml = await (await realFetch(`${baseUrl}/account`, {
        headers: {Cookie: cookieFor('pre')},
      })).text();
      expect(acctHtml).toContain(expectedBanner);
      expect(acctHtml).toContain('type="checkbox" name="tournaments" value="3"');
      expect(acctHtml).toContain('OCI image required (linux/amd64)');
      expect(acctHtml).toContain('<label>Target<span class="req">*</span></label>');

      const wikiHtml = await (await realFetch(`${baseUrl}/wiki`)).text();
      expect(wikiHtml).toContain(expectedBanner);
    });

    test('allows Pending projects to submit OCI images to scheduled tournaments', async () => {
      const pendingAcctHtml = await (await realFetch(`${baseUrl}/account`, {
        headers: {Cookie: cookieFor('rookie')},
      })).text();
      expect(pendingAcctHtml).not.toContain('<fieldset class="form-fieldset" disabled>');
      expect(pendingAcctHtml).toContain('type="checkbox" name="tournaments" value="3"');

      const res = await postSubmission('rookie', {
        version: '0.1.0-t3',
        package: 'oci',
        url: 'ghcr.io/rookie/newcomer:0.1.0-t3',
        sha256: SHA_A,
        tournaments: ['3'],
      });
      expect(res.status).toBe(201);
    });

    test('rejects native bundle packages for tournament entries with 400', async () => {
      const res = await postSubmission('pre', {
        version: '1.0.0-t3',
        package: 'bundle',
        url: 'https://github.com/pkmn/0-error-t3.tar.zst',
        sha256: SHA_A,
        tournaments: ['3'],
      });
      expect(res.status).toBe(400);
      expect((await res.json() as {error: string}).error).toContain('OCI image');
    });

    test('blocks duplicate entries into the same scheduled tournament with 409', async () => {
      const first = await postSubmission('pre', {
        version: '1.0.0-t3',
        package: 'oci',
        url: 'ghcr.io/pkmn/0-error:1.0.0-t3',
        sha256: SHA_A,
        tournaments: ['3'],
      });
      expect(first.status).toBe(201);

      const dup = await postSubmission('pre', {
        version: '1.0.1-t3',
        package: 'oci',
        url: 'ghcr.io/pkmn/0-error:1.0.1-t3',
        sha256: SHA_B,
        tournaments: ['3'],
      });
      expect(dup.status).toBe(409);
    });

    test('rejects mixed submissions combining ladders with tournaments', async () => {
      openLadders(['gen1ou20261109']);
      const mixed = await postSubmission('pre', {
        version: '1.0.1-mix',
        package: 'oci',
        url: 'ghcr.io/pkmn/0-error:1.0.1-mix',
        sha256: SHA_B,
        ladders: ['gen1ou20261109'],
        tournaments: ['3'],
      });
      expect(mixed.status).toBe(400);
    });

    test('unlocks tournament entry slot immediately when smoke validation fails', async () => {
      const first = await postSubmission('pre', {
        version: '1.0.0-t3',
        package: 'oci',
        url: 'ghcr.io/pkmn/0-error:1.0.0-t3',
        sha256: SHA_A,
        tournaments: ['3'],
      });
      const {versionId} = await first.json() as {versionId: number};
      db.applySubmissionStatus({versionId, smokeStatus: 'failed', now: currentNow + 5});

      const retry = await postSubmission('pre', {
        version: '1.0.2-t3',
        package: 'oci',
        url: 'ghcr.io/pkmn/0-error:1.0.2-t3',
        sha256: SHA_B,
        tournaments: ['3'],
      });
      expect(retry.status).toBe(201);
    });

    test('enrolls tournament entrant on smoke pass without triggering ladder cooldown',
      async () => {
        openLadders(['gen1ou20261109']);
        const sub = await postSubmission('pre', {
          version: '1.0.2-t3',
          package: 'oci',
          url: 'ghcr.io/pkmn/0-error:1.0.2-t3',
          sha256: SHA_B,
          tournaments: ['3'],
        });
        const {versionId} = await sub.json() as {versionId: number};
        db.applySubmissionStatus({versionId, smokeStatus: 'passed', now: currentNow + 10});

        expect(db.getTournamentEntrants('3').map(e => e.agentSlug)).toEqual(['0-error']);
        const zeroAgent = db.getAgentBySlug('0-error')!;
        expect(db.computeAgentSubmissionStatus(zeroAgent.id, currentNow + 20)).toEqual({
          label: 'Eligible',
          canSubmit: true,
        });

        const afterEnteredHtml = await (await realFetch(`${baseUrl}/account`, {
          headers: {Cookie: cookieFor('pre')},
        })).text();
        expect(afterEnteredHtml).toContain('(entered: 1.0.2-t3)');
        expect(afterEnteredHtml).toContain('>Entered<');
      });

    test('allows tournament OCI submissions while project is on 14-day ladder cooldown',
      async () => {
        openLadders(['gen1ou20261109']);
        const ladderSub = await postSubmission('pre', {
          version: '1.1.0',
          package: 'bundle',
          url: 'https://github.com/pkmn/0-error-1.1.0.tar.zst',
          sha256: SHA_A,
          ladders: ['RBY'],
        });
        const {versionId} = await ladderSub.json() as {versionId: number};
        db.applySubmissionStatus({versionId, smokeStatus: 'passed', now: currentNow + 5});
        const zeroAgent = db.getAgentBySlug('0-error')!;
        expect(db.computeAgentSubmissionStatus(zeroAgent.id, currentNow + 10).canSubmit)
          .toBe(false);

        const tourSub = await postSubmission('pre', {
          version: '1.1.0-t3',
          package: 'oci',
          url: 'ghcr.io/pkmn/0-error:1.1.0-t3',
          sha256: SHA_B,
          tournaments: ['3'],
        });
        expect(tourSub.status).toBe(201);
      });

    test('closes tournament entries at 00:00 UTC strictly before startsAt', async () => {
      const t5ClosesAt = (Math.floor(currentNow / 86400) + 1) * 86400;
      const t5StartsAt = t5ClosesAt + 18 * 3600;
      db.upsertTournament({
        id: '5',
        name: 'Tournament #5: Midnight Cutoff Test',
        format: 'gen9ou',
        version: '0.11.0',
        gamesPerMatchup: 8,
        parallelTables: 2,
        hardware: 'GCP L4 Spot',
        status: 'scheduled',
        startsAt: t5StartsAt,
      });

      currentNow = t5ClosesAt - 1;
      const beforeCutoffJson = await (await realFetch(`${baseUrl}/account.json`, {
        headers: {Cookie: cookieFor('pmariglia')},
      })).json() as {
        tournamentStatuses: Array<{
          tournamentId: string;
          closesAt: number;
          canSubmit: boolean;
        }>;
      };
      const t5Before = beforeCutoffJson.tournamentStatuses.find(t => t.tournamentId === '5');
      expect(t5Before?.closesAt).toBe(t5ClosesAt);
      expect(t5Before?.canSubmit).toBe(true);
      expect((await postSubmission('pmariglia', {
        version: '1.0.0-t5',
        package: 'oci',
        url: 'ghcr.io/pmariglia/foul-play:1.0.0-t5',
        sha256: SHA_A,
        tournaments: ['5'],
      })).status).toBe(201);

      currentNow = t5ClosesAt;
      const afterCutoffHtml = await (await realFetch(`${baseUrl}/account`, {
        headers: {Cookie: cookieFor('pre')},
      })).text();
      expect(afterCutoffHtml).toContain('(entries closed)');

      const afterCutoffSub = await postSubmission('pre', {
        version: '1.1.0-t5',
        package: 'oci',
        url: 'ghcr.io/pkmn/0-error:1.1.0-t5',
        sha256: SHA_B,
        tournaments: ['5'],
      });
      expect(afterCutoffSub.status).toBe(400);
      expect((await afterCutoffSub.json() as {error: string}).error).toContain('closed at');
    });
  });

  describe('account JSON API', () => {
    beforeEach(() => {
      openLadders(['gen1ou20261109']);
    });

    test('returns 401 JSON instead of HTML redirect for unauthenticated /account.json',
      async () => {
        const res = await realFetch(`${baseUrl}/account.json`, {redirect: 'manual'});
        expect(res.status).toBe(401);
        expect(res.headers.get('content-type')).toContain('application/json');
      });

    test('returns 403 JSON for unregistered GitHub users on /account.json', async () => {
      const res = await realFetch(`${baseUrl}/account.json`, {
        headers: {Cookie: cookieFor('outsider', 777)},
      });
      expect(res.status).toBe(403);
    });

    test('serves identical JSON across /account.json, /account/index.json, or Accept header',
      async () => {
        const cookie = cookieFor('pre');
        const r1 = await realFetch(`${baseUrl}/account.json`, {headers: {Cookie: cookie}});
        const r2 = await realFetch(`${baseUrl}/account/index.json`, {headers: {Cookie: cookie}});
        const r3 = await realFetch(`${baseUrl}/account/`, {
          headers: {Cookie: cookie, Accept: 'application/json'},
        });
        expect(r1.status).toBe(200);
        expect(r2.status).toBe(200);
        expect(r3.status).toBe(200);
        const j1 = await r1.json() as Record<string, unknown>;
        const j2 = await r2.json() as Record<string, unknown>;
        const j3 = await r3.json() as Record<string, unknown>;
        expect(j1).toEqual(j2);
        expect(j1).toEqual(j3);
        expect((j1.agent as {slug: string}).slug).toBe('0-error');
        expect((j1.submissionStatus as {label: string}).label).toBe('Eligible');
      });

    test('redacts authTokenEncoding, artifact URL, developerId, or notified from /account.json',
      async () => {
        const validSub = await postSubmission('pre', {
          version: '1.0.0',
          package: 'bundle',
          url: 'https://objects.githubusercontent.com/pkmn/0-error.tar.zst?X-Amz-Signature=secret',
          sha256: SHA_A,
          authToken: 'ghp_supersecret_token',
          ladders: ['gen1ou20261109'],
        });
        expect(validSub.status).toBe(201);

        const afterSubJson = await (await realFetch(`${baseUrl}/account.json`, {
          headers: {Cookie: cookieFor('pre')},
        })).json() as {versions: Array<Record<string, unknown>>};
        expect(afterSubJson.versions).toHaveLength(1);
        expect(afterSubJson.versions[0].version).toBe('1.0.0');
        expect(afterSubJson.versions[0].ladders).toEqual(['gen1ou20261109']);
        expect(afterSubJson.versions[0].smoke).toEqual({status: 'pending', queueAhead: 0});
        expect(afterSubJson.versions[0].authTokenEncoding).toBeUndefined();
        expect(afterSubJson.versions[0].url).toBeUndefined();
        expect(afterSubJson.versions[0].developerId).toBeUndefined();
        expect(afterSubJson.versions[0].notified).toBeUndefined();
      });

    test('supports HTTP HEAD requests on /account.json with empty body', async () => {
      const headJson = await realFetch(`${baseUrl}/account.json`, {
        method: 'HEAD',
        headers: {Cookie: cookieFor('pre')},
      });
      expect(headJson.status).toBe(200);
      expect(await headJson.text()).toBe('');
    });

    test('paginates version history on /account/ at 25 rows per page', async () => {
      const agent = db.getAgentBySlug('0-error')!;
      const dev = db.getDeveloperByGitHub('pre')!;
      for (let i = 1; i <= 27; i++) {
        const submittedAt = 1_760_000_000 + i * 15 * 86400;
        const sub = db.createSubmission({
          agentId: agent.id,
          developerId: dev.id,
          version: `1.0.${i}`,
          package: 'bundle',
          url: `https://github.com/pkmn/0-error-${i}.tar.zst`,
          sha256: SHA_A,
          ladderIds: ['gen1ou20261109'],
          now: submittedAt,
        });
        db.applySubmissionStatus({
          versionId: sub.id,
          smokeStatus: 'passed',
          now: submittedAt + 1,
        });
        db.db.prepare('UPDATE ladder_entries SET settled_at = ? WHERE version_id = ?')
          .run(submittedAt + 2, sub.id);
      }

      const res = await realFetch(`${baseUrl}/account`, {
        headers: {Cookie: cookieFor('pre')},
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('id="history-pager"');
      expect(html).toContain('Page 1 of 2 (27 versions)');
    });

    test('renders POST logout button returning to /arena on /account/', async () => {
      const res = await realFetch(`${baseUrl}/account`, {
        headers: {Cookie: cookieFor('pre')},
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('action="/auth/logout?return_to=%2Farena%2F"');
      expect(html).toContain('>Logout<');
    });

    test('disables unqualified ladder checkboxes on /account and rejects 403 on submit',
      async () => {
        openLadders([
          'gen1ou20261109',
          'gen3ou20261109',
          'gen9ou20261109',
          'gen9randombattle20261109',
          'gen9championsvgc2026regmc',
        ]);
        db.setAgentLadders('0-error', ['rby', 'adv'], currentNow);

        const html = await (await realFetch(`${baseUrl}/account`, {
          headers: {Cookie: cookieFor('pre')},
        })).text();
        expect(html).toContain('>Eligible<');
        expect(html).toMatch(
          /<input type="checkbox" name="ladders" value="gen1ou20261109">/
        );
        expect(html).toMatch(
          /<input type="checkbox" name="ladders" value="gen3ou20261109">/
        );
        expect(html).toMatch(
          /<input type="checkbox" name="ladders" value="gen9ou20261109" disabled>/
        );
        expect(html).toMatch(
          /<input type="checkbox" name="ladders" value="gen9randombattle20261109" disabled>/
        );
        expect(html).toMatch(
          /<input type="checkbox" name="ladders" value="gen9championsvgc2026regmc" disabled>/
        );
        expect(html).not.toContain('id="pool-teams-panel"');

        const accountJson = await (await realFetch(`${baseUrl}/account.json`, {
          headers: {Cookie: cookieFor('pre')},
        })).json() as {
          agent: {qualifiedLadders: string[]};
          currentLadders: Array<{slot: string; qualified: boolean}>;
        };
        expect(accountJson.agent.qualifiedLadders).toEqual(['rby', 'adv']);
        const bySlot = new Map(accountJson.currentLadders.map(l => [l.slot, l.qualified]));
        expect(bySlot.get('rby')).toBe(true);
        expect(bySlot.get('adv')).toBe(true);
        expect(bySlot.get('sv')).toBe(false);
        expect(bySlot.get('rand')).toBe(false);
        expect(bySlot.get('vgc')).toBe(false);

        const blocked = await postSubmission('pre', {
          version: '1.0.0',
          package: 'bundle',
          url: 'https://github.com/pkmn/0-error.tar.zst',
          sha256: SHA_A,
          ladders: ['RBY', 'SV'],
        });
        expect(blocked.status).toBe(403);
        expect((await blocked.json() as {error: string}).error).toContain('SV');

        const allowed = await postSubmission('pre', {
          version: '1.0.0',
          package: 'bundle',
          url: 'https://github.com/pkmn/0-error.tar.zst',
          sha256: SHA_A,
          ladders: ['RBY', 'ADV'],
        });
        expect(allowed.status).toBe(201);
      });

    test('renders Qualified status when only unqualified ladders are open', async () => {
      db.db.prepare("UPDATE ladders SET status = 'settling'").run();
      openLadders(['gen9ou20261109']);
      db.setAgentLadders('0-error', ['rby', 'adv'], currentNow);

      const html = await (await realFetch(`${baseUrl}/account`, {
        headers: {Cookie: cookieFor('pre')},
      })).text();
      expect(html).toContain('>Qualified<');
      expect(html).toContain('<fieldset class="form-fieldset" disabled>');
    });

    test('rate-limits projects after 3 failed smoke tests in 24h across scopes',
      async () => {
        openLadders(['gen1ou20261109']);
        db.setAgentLadders('0-error', ['rby'], currentNow);
        db.upsertTournament({
          id: 't-budget',
          name: 'Budget Tour',
          format: 'gen9ou',
          version: '0.11.0',
          gamesPerMatchup: 10,
          parallelTables: 2,
          hardware: 'L4',
          startsAt: currentNow + 7 * 86400,
          status: 'scheduled',
        });

        for (let i = 1; i <= 3; i++) {
          const res = await postSubmission('pre', {
            version: `0.1.${i}`,
            package: 'bundle',
            url: `https://github.com/pkmn/0-error-${i}.tar.zst`,
            sha256: SHA_A,
            ladders: ['RBY'],
          });
          expect(res.status).toBe(201);
          const {versionId} = await res.json() as {versionId: number};
          db.applySubmissionStatus({
            versionId,
            smokeStatus: 'failed',
            smokeError: 'segfault',
            now: currentNow + i,
          });
        }

        const blockedLadder = await postSubmission('pre', {
          version: '0.1.4',
          package: 'bundle',
          url: 'https://github.com/pkmn/0-error-4.tar.zst',
          sha256: SHA_A,
          ladders: ['RBY'],
        });
        expect(blockedLadder.status).toBe(429);
        expect((await blockedLadder.json() as {error: string}).error).toContain(
          'Failed smoke test limit reached'
        );

        const htmlAfterLadder = await (await realFetch(`${baseUrl}/account`, {
          headers: {Cookie: cookieFor('pre')},
        })).text();
        expect(htmlAfterLadder).toContain('Failed smoke test limit reached');

        // Advance past the 60s HTTP burst window and verify tournament budget independently.
        currentNow += 120;
        for (let i = 1; i <= 3; i++) {
          const res = await postSubmission('pre', {
            version: `t0.${i}`,
            package: 'oci',
            url: `ghcr.io/pkmn/0-error:t0.${i}`,
            sha256: SHA_B,
            ladders: [],
            tournaments: ['t-budget'],
          });
          expect(res.status).toBe(201);
          const {versionId} = await res.json() as {versionId: number};
          db.applySubmissionStatus({
            versionId,
            smokeStatus: 'failed',
            smokeError: 'oom',
            now: currentNow + i,
          });
        }

        const blockedTour = await postSubmission('pre', {
          version: 't0.4',
          package: 'oci',
          url: 'ghcr.io/pkmn/0-error:t0.4',
          sha256: SHA_B,
          ladders: [],
          tournaments: ['t-budget'],
        });
        expect(blockedTour.status).toBe(429);
        expect((await blockedTour.json() as {error: string}).error).toContain(
          'Failed smoke test limit reached'
        );

        const htmlAfterTour = await (await realFetch(`${baseUrl}/account`, {
          headers: {Cookie: cookieFor('pre')},
        })).text();
        expect(htmlAfterTour).toContain('retry after ');
      });

    test('allows submissions past 3 failed smoke tests when unlimitedSmokeTests is enabled',
      async () => {
        openLadders(['gen1ou20261109']);
        db.setAgentLadders('0-error', ['rby'], currentNow);
        db.setUnlimitedSmokeTests('0-error', true, currentNow);

        for (let i = 1; i <= 4; i++) {
          const res = await postSubmission('pre', {
            version: `0.2.${i}`,
            package: 'bundle',
            url: `https://github.com/pkmn/0-error-0.2.${i}.tar.zst`,
            sha256: SHA_A,
            ladders: ['RBY'],
          });
          expect(res.status).toBe(201);
          const {versionId} = await res.json() as {versionId: number};
          db.applySubmissionStatus({
            versionId,
            smokeStatus: 'failed',
            smokeError: 'segfault',
            now: currentNow + i,
          });
        }

        const acctJson = await (await realFetch(`${baseUrl}/account.json`, {
          headers: {Cookie: cookieFor('pre')},
        })).json() as {
          agent: {unlimitedSmokeTests: boolean};
          submissionStatus: {label: string; canSubmit: boolean};
        };
        expect(acctJson.agent.unlimitedSmokeTests).toBe(true);
        expect(acctJson.submissionStatus).toEqual({label: 'Eligible', canSubmit: true});
      });

    test('omits 3-per-24h discard warning on /account when unlimitedSmokeTests is enabled',
      async () => {
        openLadders(['gen1ou20261109']);
        db.setAgentLadders('0-error', ['rby'], currentNow);
        db.setUnlimitedSmokeTests('0-error', true, currentNow);
        const zero = db.getAgentBySlug('0-error')!;
        const v1 = db.createSubmission({
          agentId: zero.id,
          version: '1.0.0',
          package: 'bundle',
          url: 'https://github.com/pkmn/0-error-1.0.0.tar.zst',
          sha256: SHA_A,
          ladderIds: ['gen1ou20261109'],
          now: currentNow,
        });
        db.applySubmissionStatus({versionId: v1.id, smokeStatus: 'staged', now: currentNow + 5});

        const html = await (await realFetch(`${baseUrl}/account`, {
          headers: {Cookie: cookieFor('pre')},
        })).text();
        expect(html).toContain('data-unlimited="true"');
        expect(html).toContain('discarding deletes the staged build and frees the version label.');
        expect(html).not.toContain('frees the version label, and counts toward the 3-per-24h');
      });

    test('exposes anonymized smoke-test queue position on /account routes', async () => {
      openLadders(['gen1ou20261109']);
      db.setAgentLadders('foul-play', ['rby'], currentNow);
      db.setAgentLadders('0-error', ['rby'], currentNow);

      const first = await postSubmission('pmariglia', {
        version: '2.0.0',
        package: 'bundle',
        url: 'https://github.com/pmariglia/fp-2.tar.zst',
        sha256: SHA_A,
        ladders: ['RBY'],
      });
      expect(first.status).toBe(201);

      currentNow += 5;
      const second = await postSubmission('pre', {
        version: '2.0.0',
        package: 'bundle',
        url: 'https://github.com/pkmn/0-error-2.tar.zst',
        sha256: SHA_B,
        ladders: ['RBY'],
      });
      expect(second.status).toBe(201);

      const html = await (await realFetch(`${baseUrl}/account`, {
        headers: {Cookie: cookieFor('pre')},
      })).text();
      expect(html).toContain('1 ahead in queue');
      expect(html).toContain('(1 ahead)');
      expect(html).not.toContain('Foul Play');

      const json = await (await realFetch(`${baseUrl}/account.json`, {
        headers: {Cookie: cookieFor('pre')},
      })).json() as {
        submissionStatus: {queueAhead?: number};
        versions: Array<{smoke: {status: string; queueAhead?: number}}>;
      };
      expect(json.submissionStatus.queueAhead).toBe(1);
      expect(json.versions[0].smoke.queueAhead).toBe(1);
    });

    test('serves private staged diagnostics with activate/discard lifecycle gating',
      async () => {
        openLadders(['gen1ou20261109', 'gen9championsvgc2026regmc']);
        db.setAgentLadders('0-error', ['rby', 'vgc'], currentNow);
        db.setAgentLadders('foul-play', ['rby'], currentNow);

        const zero = db.getAgentBySlug('0-error')!;
        const v1 = db.createSubmission({
          agentId: zero.id,
          version: '2.1.0',
          package: 'bundle',
          url: 'https://github.com/pkmn/0-error-2.1.0.tar.zst',
          sha256: SHA_A,
          ladderIds: ['gen1ou20261109', 'gen9championsvgc2026regmc'],
          teamsByLadder: {gen9championsvgc2026regmc: ['TeamOne', 'TeamTwo']},
          now: currentNow,
        });
        db.applySubmissionStatus({
          versionId: v1.id,
          smokeStatus: 'staged',
          smokeDurationMillis: 5200,
          smokeInitMillis: 120,
          smokeTurnMillis: 35,
          smokePeakRam: 312,
          diagnostics: [{
            ladderId: 'gen1ou20261109',
            format: 'gen1ou',
            turns: 14,
            endReason: 'win',
            durationMillis: 5200,
            battleLog: '|turn|1\n|ai|p1|{"win":0.62,"depth":8}\n|win|0 ERROR',
            infoStatus: 'full',
            p1Stderr: 'p1 trace line',
            p2Stderr: 'p2 trace line',
            p1CpuCores: 3.2,
            p2CpuCores: 3.1,
            p1PeakRam: 312,
            p2PeakRam: 290,
          }],
          now: currentNow + 30,
        });
        const diagId = db.getSmokeDiagnosticsForVersion(v1.id)[0].id;

        // Unauthenticated and other-project developers are blocked (401 / 403).
        expect((await realFetch(`${baseUrl}/api/account/diagnostics/${diagId}/log`)).status)
          .toBe(401);
        expect((await realFetch(`${baseUrl}/api/account/diagnostics/${diagId}/stderr`)).status)
          .toBe(401);
        expect((await realFetch(`${baseUrl}/api/account/diagnostic/stream`)).status).toBe(401);
        expect((await realFetch(`${baseUrl}/api/account/diagnostics/${diagId}/log`, {
          headers: {Cookie: cookieFor('pmariglia')},
        })).status).toBe(403);
        expect((await realFetch(`${baseUrl}/api/account/diagnostics/${diagId}/stderr`, {
          headers: {Cookie: cookieFor('pmariglia')},
        })).status).toBe(403);
        expect((await realFetch(`${baseUrl}/api/account/versions/${v1.id}/activate`, {
          method: 'POST',
          headers: {Cookie: cookieFor('pmariglia')},
        })).status).toBe(403);

        // Owning developer sees staged activation UI, diagnostics JSON, log, and stderr downloads.
        const html = await (await realFetch(`${baseUrl}/account`, {
          headers: {Cookie: cookieFor('pre')},
        })).text();
        expect(html).toContain('id="staged-review"');
        expect(html).toContain('Activate');
        expect(html).toContain('Discard');
        expect(html).toContain('class="battle-toggle"');
        expect(html).toContain(`/api/account/diagnostics/${diagId}/stderr`);
        expect(html).toContain('>STDERR</a>');
        expect(html).toContain('>log</a>');
        expect(html).toContain('class="info-dot full yes"');
        expect(html).not.toContain('>/info</span>');
        expect(html).not.toContain('gen1ou (14t');
        expect(html).not.toContain('>Close</button>');

        const acctJson = await (await realFetch(`${baseUrl}/account.json`, {
          headers: {Cookie: cookieFor('pre')},
        })).json() as {
          versions: Array<{
            id: number;
            smoke: {infoStatus?: string};
            diagnostics: Array<{infoStatus: string}>;
          }>;
        };
        const stagedJson = acctJson.versions.find(v => v.id === v1.id)!;
        expect(stagedJson.smoke.infoStatus).toBe('full');
        expect(stagedJson.diagnostics[0].infoStatus).toBe('full');

        // Uploading while a staged submission awaits review is blocked with 429.
        const dupStaged = await postSubmission('pre', {
          version: '2.1.0',
          package: 'bundle',
          url: 'https://github.com/pkmn/0-error-2.1.0-retry.tar.zst',
          sha256: SHA_B,
          ladders: ['RBY'],
        });
        expect(dupStaged.status).toBe(429);

        const logJson = await (await realFetch(`${baseUrl}/api/account/diagnostics/${diagId}/log`, {
          headers: {Cookie: cookieFor('pre')},
        })).json() as {format: string; lines: string[]; p1CpuCores?: number};
        expect(logJson.format).toBe('gen1ou');
        expect(logJson.lines).toContain('|ai|p1|{"win":0.62,"depth":8}');
        expect(logJson.p1CpuCores).toBe(3.2);

        const dlRes = await realFetch(
          `${baseUrl}/api/account/diagnostics/${diagId}/log?download=1`,
          {headers: {Cookie: cookieFor('pre')}}
        );
        expect(dlRes.headers.get('content-disposition')).toContain('attachment;');
        expect(await dlRes.text()).toContain('|win|0 ERROR');

        const stderrAll = await (await realFetch(
          `${baseUrl}/api/account/diagnostics/${diagId}/stderr`,
          {headers: {Cookie: cookieFor('pre')}}
        )).text();
        expect(stderrAll).toContain('=== P1 stderr ===\np1 trace line');
        expect(stderrAll).toContain('=== P2 stderr ===\np2 trace line');
        expect(await (await realFetch(
          `${baseUrl}/api/account/diagnostics/${diagId}/stderr?slot=p1`,
          {headers: {Cookie: cookieFor('pre')}}
        )).text()).toBe('p1 trace line');

        // Cross-site POST to discard/activate is blocked with 403.
        const crossSite = await realFetch(`${baseUrl}/api/account/versions/${v1.id}/discard`, {
          method: 'POST',
          headers: {Cookie: cookieFor('pre'), 'Sec-Fetch-Site': 'cross-site'},
        });
        expect(crossSite.status).toBe(403);

        // Discard transitions to discarded and reverts VGC pending teams back to saved.
        const discardRes = await realFetch(`${baseUrl}/api/account/versions/${v1.id}/discard`, {
          method: 'POST',
          headers: {Cookie: cookieFor('pre'), Accept: 'application/json'},
        });
        expect(discardRes.status).toBe(200);
        expect(db.getVersionById(v1.id)?.smokeStatus).toBe('discarded');
        expect(
          db.getTeamsForAgentLadder('gen9championsvgc2026regmc', zero.id, 'saved')
        ).toEqual(['TeamOne', 'TeamTwo']);

        // After discarding, the same version label can be reused across retries until activated.
        const retryAfterDiscard = await postSubmission('pre', {
          version: '2.1.0',
          package: 'bundle',
          url: 'https://github.com/pkmn/0-error-2.1.0-r2.tar.zst',
          sha256: SHA_B,
          ladders: ['RBY'],
        });
        expect(retryAfterDiscard.status).toBe(201);
        const retryId = (await retryAfterDiscard.json() as {versionId: number}).versionId;
        db.applySubmissionStatus({
          versionId: retryId,
          smokeStatus: 'failed',
          smokeError: 'Exit 1',
          diagnostics: [{
            ladderId: 'gen1ou20261109',
            format: 'gen1ou',
            turns: 3,
            endReason: 'crash',
            durationMillis: 900,
            battleLog: '|turn|1\n|turn|3',
          }],
          now: currentNow + 45,
        });
        const noInfoHtml = await (await realFetch(`${baseUrl}/account`, {
          headers: {Cookie: cookieFor('pre')},
        })).text();
        expect(noInfoHtml).toContain('class="info-dot none muted"');
        expect(noInfoHtml).not.toContain('smoke-log');
        expect(noInfoHtml).not.toContain('Sandbox');

        // Reusing 2.1.0 again after failure succeeds, then activating permanently claims it.
        const retryAfterFail = await postSubmission('pre', {
          version: '2.1.0',
          package: 'bundle',
          url: 'https://github.com/pkmn/0-error-2.1.0-r3.tar.zst',
          sha256: SHA_B,
          ladders: ['RBY'],
        });
        expect(retryAfterFail.status).toBe(201);
        const v2Id = (await retryAfterFail.json() as {versionId: number}).versionId;
        db.applySubmissionStatus({
          versionId: v2Id,
          smokeStatus: 'staged',
          diagnostics: [{
            ladderId: 'gen1ou20261109',
            format: 'gen1ou',
            turns: 10,
            endReason: 'win',
            durationMillis: 4000,
            battleLog: '|turn|1\n|ai|p1|{"win":0.55}\n|win|0 ERROR',
            infoStatus: 'partial',
          }],
          now: currentNow + 90,
        });
        const actRes = await realFetch(`${baseUrl}/api/account/versions/${v2Id}/activate`, {
          method: 'POST',
          headers: {Cookie: cookieFor('pre'), Accept: 'application/json'},
        });
        expect(actRes.status).toBe(200);
        expect(db.getVersionById(v2Id)?.smokeStatus).toBe('passed');
        const activeAfter = db.getActiveEntriesForAgent(zero.id);
        expect(activeAfter).toHaveLength(1);
        expect(activeAfter[0].smokeInfoStatus).toBe('partial');

        // Once activated, reusing 2.1.0 is permanently rejected even after eligibility is restored.
        db.db.prepare(
          'UPDATE ladder_entries SET se = 20, matches = 30, settled_at = ? WHERE version_id = ?'
        ).run(currentNow + 95, v2Id);
        currentNow += 15 * 86_400;
        const dupActivated = await postSubmission('pre', {
          version: '2.1.0',
          package: 'bundle',
          url: 'https://github.com/pkmn/0-error-2.1.0-r4.tar.zst',
          sha256: SHA_A,
          ladders: ['RBY'],
        });
        expect(dupActivated.status).toBe(409);
      });

    test('HEAD /api/account/diagnostic/stream closes with private no-store', async () => {
      const res = await realFetch(`${baseUrl}/api/account/diagnostic/stream`, {
        method: 'HEAD',
        headers: {Cookie: cookieFor('pre')},
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      expect(res.headers.get('cache-control')).toBe('private, no-store, no-transform');
    });

    test('diagnostic downloads send nosniff header', async () => {
      openLadders(['gen1ou20261109']);
      const zero = db.getAgentBySlug('0-error')!;
      const v = db.createSubmission({
        agentId: zero.id,
        version: '3.0.0',
        package: 'bundle',
        url: 'https://github.com/pkmn/0-error-3.0.0.tar.zst',
        sha256: SHA_A,
        ladderIds: ['gen1ou20261109'],
        now: currentNow,
      });
      db.applySubmissionStatus({
        versionId: v.id,
        smokeStatus: 'staged',
        diagnostics: [{
          ladderId: 'gen1ou20261109',
          format: 'gen1ou',
          turns: 2,
          endReason: 'win',
          durationMillis: 500,
          battleLog: '|turn|1\n|win|0 ERROR',
        }],
        now: currentNow + 5,
      });
      const diagId = db.getSmokeDiagnosticsForVersion(v.id)[0].id;
      const dlRes = await realFetch(
        `${baseUrl}/api/account/diagnostics/${diagId}/log?download=1`,
        {headers: {Cookie: cookieFor('pre')}}
      );
      expect(dlRes.headers.get('x-content-type-options')).toBe('nosniff');
      const errRes = await realFetch(
        `${baseUrl}/api/account/diagnostics/${diagId}/stderr`,
        {headers: {Cookie: cookieFor('pre')}}
      );
      expect(errRes.headers.get('x-content-type-options')).toBe('nosniff');

      // Diagnostic without stderr omits the STDERR link while keeping log download.
      const html = await (await realFetch(`${baseUrl}/account`, {
        headers: {Cookie: cookieFor('pre')},
      })).text();
      expect(html).not.toContain(`/api/account/diagnostics/${diagId}/stderr`);
      expect(html).toContain(`/api/account/diagnostics/${diagId}/log?download=1`);
    });

    test('blocks rival discard IDOR, cross-site activate, or disabled diagnostics', async () => {
      openLadders(['gen1ou20261109']);
      const zero = db.getAgentBySlug('0-error')!;
      const v = db.createSubmission({
        agentId: zero.id,
        version: '3.1.0',
        package: 'bundle',
        url: 'https://github.com/pkmn/0-error-3.1.0.tar.zst',
        sha256: SHA_A,
        ladderIds: ['gen1ou20261109'],
        now: currentNow,
      });
      db.applySubmissionStatus({
        versionId: v.id,
        smokeStatus: 'staged',
        diagnostics: [{
          ladderId: 'gen1ou20261109',
          format: 'gen1ou',
          turns: 1,
          endReason: 'win',
          durationMillis: 400,
          battleLog: '|turn|1',
        }],
        now: currentNow + 5,
      });
      const diagId = db.getSmokeDiagnosticsForVersion(v.id)[0].id;

      // Rival developer cannot discard another project's staged version.
      expect((await realFetch(`${baseUrl}/api/account/versions/${v.id}/discard`, {
        method: 'POST',
        headers: {Cookie: cookieFor('pmariglia')},
      })).status).toBe(403);

      // Cross-site activate is rejected for both Sec-Fetch-Site and Origin mismatch.
      expect((await realFetch(`${baseUrl}/api/account/versions/${v.id}/activate`, {
        method: 'POST',
        headers: {Cookie: cookieFor('pre'), 'Sec-Fetch-Site': 'cross-site'},
      })).status).toBe(403);
      expect((await realFetch(`${baseUrl}/api/account/versions/${v.id}/activate`, {
        method: 'POST',
        headers: {Cookie: cookieFor('pre'), Origin: 'https://evil.example'},
      })).status).toBe(403);

      // Unregistered and disabled users receive 403 on diagnostic endpoints.
      expect((await realFetch(`${baseUrl}/api/account/diagnostics/${diagId}/log`, {
        headers: {Cookie: cookieFor('stranger')},
      })).status).toBe(403);
      db.db.prepare('UPDATE agents SET status = ? WHERE id = ?').run('disabled', zero.id);
      expect((await realFetch(`${baseUrl}/api/account/diagnostics/${diagId}/log`, {
        headers: {Cookie: cookieFor('pre')},
      })).status).toBe(403);
    });

    test('diagnostic log endpoint splits omniscient |split| blocks by perspective', async () => {
      const zero = db.getAgentBySlug('0-error')!;
      const ver = db.createSubmission({
        agentId: zero.id,
        version: '2.2.0',
        package: 'bundle',
        url: 'https://github.com/pkmn/0-error-2.2.0.tar.zst',
        sha256: SHA_B,
        ladderIds: ['gen1ou20261109'],
        now: currentNow,
      });
      const splitLog = [
        '|start',
        '|split|p1',
        '|switch|p1a: Tauros|Tauros|353/353',
        '|switch|p1a: Tauros|Tauros|100/100',
        '|split|p2',
        '|switch|p2a: Chansey|Chansey|703/703',
        '|switch|p2a: Chansey|Chansey|100/100',
        '|split|p1',
        '|-heal|p1a: Tauros|353/353',
        '',
        '|turn|1',
        '|win|0 ERROR (P1)',
      ].join('\n');
      db.applySubmissionStatus({
        versionId: ver.id,
        smokeStatus: 'staged',
        smokeDurationMillis: 1500,
        diagnostics: [{
          format: 'gen1ou',
          turns: 1,
          endReason: 'win',
          durationMillis: 1500,
          battleLog: splitLog,
          infoStatus: 'none',
        }],
        now: currentNow + 1,
      });
      const diagId = db.getSmokeDiagnosticsForVersion(ver.id)[0].id;
      const logJson = await (await realFetch(`${baseUrl}/api/account/diagnostics/${diagId}/log`, {
        headers: {Cookie: cookieFor('pre')},
      })).json() as {lines: string[]; p1Lines: string[]; p2Lines: string[]};

      expect(logJson.p1Lines).toEqual([
        '|start',
        '|switch|p1a: Tauros|Tauros|353/353',
        '|switch|p2a: Chansey|Chansey|100/100',
        '|-heal|p1a: Tauros|353/353',
        '|turn|1',
        '|win|0 ERROR (P1)',
      ]);
      expect(logJson.p2Lines).toEqual([
        '|start',
        '|switch|p1a: Tauros|Tauros|100/100',
        '|switch|p2a: Chansey|Chansey|703/703',
        '|turn|1',
        '|win|0 ERROR (P1)',
      ]);
    });

    test('diagnostic SSE delivers live frames only to the owning project', async () => {
      const liveApp = polka();
      const liveAuth = new auth.Auth({config: AUTH_CFG, db});
      const liveArena = arena.register(liveApp, {
        db,
        auth: liveAuth,
        arenaSecret: 'diag-live-secret',
        now: () => currentNow,
      });
      account.register(liveApp, {db, auth: liveAuth, arena: liveArena, now: () => currentNow});
      const liveSrv = http.createServer((req, res) => liveApp.handler(req as polka.Request, res));
      await new Promise<void>(resolve => liveSrv.listen(0, '127.0.0.1', resolve));
      const liveBase = `http://127.0.0.1:${(liveSrv.address() as {port: number}).port}`;
      const ownerAc = new AbortController();
      const rivalAc = new AbortController();
      try {
        const zero = db.getAgentBySlug('0-error')!;
        // Unauthenticated POST to /api/arena/diagnostic-live is rejected with 401.
        expect((await realFetch(`${liveBase}/api/arena/diagnostic-live`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({agentId: zero.id}),
        })).status).toBe(401);

        const [ownerRes, rivalRes] = await Promise.all([
          realFetch(`${liveBase}/api/account/diagnostic/stream`, {
            headers: {Cookie: cookieFor('pre')},
            signal: ownerAc.signal,
          }),
          realFetch(`${liveBase}/api/account/diagnostic/stream`, {
            headers: {Cookie: cookieFor('pmariglia')},
            signal: rivalAc.signal,
          }),
        ]);
        expect(ownerRes.status).toBe(200);
        expect(rivalRes.status).toBe(200);

        const ownerReader = ownerRes.body!.getReader();
        const rivalReader = rivalRes.body!.getReader();
        const dec = new TextDecoder();
        // Consume initial `event: idle` frames emitted on connect.
        expect(dec.decode((await ownerReader.read()).value)).toContain('event: idle');
        expect(dec.decode((await rivalReader.read()).value)).toContain('event: idle');

        const ownerNext = ownerReader.read();
        let rivalReceived = '';
        void rivalReader.read().then(chunk => {
          if (chunk.value) rivalReceived += dec.decode(chunk.value);
        }).catch(() => undefined);

        const pushRes = await realFetch(`${liveBase}/api/arena/diagnostic-live`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer diag-live-secret',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            versionId: 42,
            agentId: zero.id,
            agentSlug: '0-error',
            agentName: '0 ERROR',
            version: '3.2.0',
            format: 'gen1ou',
            targetName: 'RBY',
            phase: 'battle',
            turn: 2,
            activeSlot: 'p1',
            turnStartedAt: currentNow,
            turnBudgetSeconds: 60,
            incrementSeconds: 5,
            p1: {name: '0 ERROR (P1)', version: '3.2.0', bankSeconds: 120, thinking: true},
            p2: {name: '0 ERROR (P2)', version: '3.2.0', bankSeconds: 120, thinking: false},
            lines: [
              '|split|p1',
              '|switch|p1a: Tauros|Tauros|353/353',
              '|switch|p1a: Tauros|Tauros|100/100',
              '|turn|2',
            ],
          }),
        });
        expect(pushRes.status).toBe(200);

        const nextChunk = await ownerNext;
        const ownerText = dec.decode(nextChunk.value);
        expect(ownerText).toContain('event: diagnostic');
        expect(ownerText).toContain('3.2.0');
        const dataLine = ownerText.split('\n').find(l => l.startsWith('data: '))!;
        const snap = JSON.parse(dataLine.slice('data: '.length)) as {
          p1Lines: string[];
          p2Lines: string[];
        };
        expect(snap.p1Lines).toEqual(['|switch|p1a: Tauros|Tauros|353/353', '|turn|2']);
        expect(snap.p2Lines).toEqual(['|switch|p1a: Tauros|Tauros|100/100', '|turn|2']);
        expect(rivalReceived).toBe('');
      } finally {
        ownerAc.abort();
        rivalAc.abort();
        liveArena.close();
        liveSrv.closeAllConnections();
        await new Promise<void>(resolve => liveSrv.close(() => resolve()));
      }
    });
  });
});
