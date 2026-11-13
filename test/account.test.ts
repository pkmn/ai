import {execFileSync} from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import polka from 'polka';

import {COOLDOWN_SECONDS, Database} from '../db';
import type * as db from '../db';
import * as account from '../server/account';
import * as auth from '../server/auth';
import {clearReferencePoolCache, splitSubmittedTeams} from '../server/teams';
import * as wiki from '../server/wiki';
import {generateValidVgcTeams} from '../tools/mock';
import {runPkmnCli} from '../tools/pkmn';

const AUTH_CFG: auth.Config = {
  sessionSecret: 'test-account-session-secret',
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
    qualified: true
    owners:
      pre: pre.10544
      coauthor: coauthor.20001
- name: Foul Play
  active: 2026
  arena:
    qualified: true
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

  test('splitSubmittedTeams parses Showdown === headers, arrays, or 6-block pastes', () => {
    const twoTeams = VALID_TWENTY_VGC.slice(0, 2);
    const withHeaders =
      `=== [gen9championsvgc2026regmc] Team 1 ===\n${twoTeams[0]}\n\n` +
      `=== [gen9championsvgc2026regmc] Team 2 ===\n${twoTeams[1]}`;
    expect(splitSubmittedTeams(withHeaders)).toHaveLength(2);
    expect(splitSubmittedTeams(twoTeams)).toHaveLength(2);
    expect(splitSubmittedTeams(`${twoTeams[0]}\n\n${twoTeams[1]}`)).toHaveLength(2);
  });
});

describe('account routes', () => {
  let suiteTmpDir: string;
  let templateWikiDir: string;
  let tmpDir: string;
  let poolDir: string;
  let wikiDir: string;
  let projectsFile: string;
  let db: db.Database;
  let server: http.Server;
  let baseUrl: string;
  let currentNow: number;
  const realFetch = globalThis.fetch;

  beforeAll(() => {
    suiteTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-account-suite-'));
    templateWikiDir = path.join(suiteTmpDir, 'wiki-template');
    fs.mkdirSync(templateWikiDir, {recursive: true});
    execFileSync('git', ['init', '-b', 'main'], {cwd: templateWikiDir});
    execFileSync('git', ['config', 'user.name', 'test'], {cwd: templateWikiDir});
    execFileSync('git', ['config', 'user.email', 'test@pkmn.ai'], {cwd: templateWikiDir});
    fs.writeFileSync(path.join(templateWikiDir, 'index.dj'), '# Home\n');
    execFileSync('git', ['add', 'index.dj'], {cwd: templateWikiDir});
    execFileSync('git', ['commit', '-m', 'Init'], {cwd: templateWikiDir});
  });

  afterAll(() => {
    fs.rmSync(suiteTmpDir, {recursive: true, force: true});
  });

  const openLadders = (ids: string[]) => {
    const stmt = db.db.prepare("UPDATE ladders SET status = 'active' WHERE id = ?");
    for (const id of ids) stmt.run(id);
  };

  beforeEach(async () => {
    clearReferencePoolCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-account-test-'));
    poolDir = path.join(tmpDir, 'vgc-pool');
    wikiDir = path.join(tmpDir, 'wiki');
    projectsFile = path.join(tmpDir, 'projects.yml');
    fs.mkdirSync(poolDir, {recursive: true});
    fs.cpSync(templateWikiDir, wikiDir, {recursive: true});
    fs.writeFileSync(projectsFile, PROJECTS_YAML, 'utf8');
    fs.writeFileSync(path.join(poolDir, 'public000001'), PUBLIC_CLONE_VGC, 'utf8');

    currentNow = 1_760_000_000;
    db = new Database(':memory:');
    db.syncLadders();
    db.syncProjectsFromYaml(PROJECTS_YAML, path.join(tmpDir, 'avatars'), currentNow);
    db.linkDeveloperDiscord('pre', '513513270670262284', 'scheibo', currentNow);

    const wikiInstance = new wiki.Wiki({
      wikiDir,
      projectsFile,
      db,
      auth: new auth.Auth({
        config: AUTH_CFG,
        db,
        isAuthorizedGitHub: (login): boolean => wikiInstance.isDeveloper(login),
      }),
      push: false,
    });
    const app = polka();
    wikiInstance.auth.register(app);
    account.register(app, {
      db,
      auth: wikiInstance.auth,
      poolsByLadder: new Map([['gen9championsvgc2026regmc', [poolDir]]]),
      now: () => currentNow,
    });
    wiki.register(app, {wiki: wikiInstance, db});

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
    fs.rmSync(tmpDir, {recursive: true, force: true});
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

  const postDraftTeams = (endpoint: string, body: Record<string, unknown>, login = 'pre') =>
    realFetch(`${baseUrl}${endpoint}`, {
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

    test('rejects unregistered GitHub users on /account with 403', async () => {
      const stranger = await realFetch(`${baseUrl}/account`, {
        headers: {Cookie: cookieFor('stranger')},
      });
      expect(stranger.status).toBe(403);
      expect(await stranger.text()).toContain('template=register.yml');
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

    test('updates project ownership across /account or wiki on developer reassignment',
      async () => {
        openLadders(['gen1ou20261109']);
        const commentedYaml = `# Arena projects registry
- name: 0 ERROR # flagship search agent
  active: 2026
  arena:
    qualified: true
    owners:
      pre: pre.10544
- name: Foul Play
  active: 2026
  arena:
    qualified: true
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

        expect((await postWiki('0_ERROR', 'pre', '{% visibility: project %}\n# 0 ERROR\n')).status)
          .toBe(303);
        expect(
          (await postWiki('Foul_Play', 'pmariglia', '{% visibility: project %}\n# Foul Play\n'))
            .status
        ).toBe(303);

        await runPkmnCli(
          ['reassign-developer', 'pre', 'Foul Play', '--projects', projectsFile],
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
        expect((await postWiki('0_ERROR', 'pre', '{% visibility: project %}\n# Nope\n')).status)
          .toBe(403);
        expect(
          (await postWiki('Foul_Play', 'pre', '{% visibility: project %}\n# Joined!\n')).status
        ).toBe(303);

        await runPkmnCli(
          ['reassign-developer', 'pre', '0 ERROR', '--projects', projectsFile],
          {db, now: currentNow + 40, log: () => undefined}
        );

        const returnedAccount = await (await realFetch(`${baseUrl}/account`, {
          headers: {Cookie: cookieFor('pre')},
        })).text();
        expect(returnedAccount).toContain('href="/projects/0-error/"');
        expect((await postWiki('Foul_Play', 'pre', '{% visibility: project %}\n# Nope\n')).status)
          .toBe(403);
        expect((await postWiki('0_ERROR', 'pre', '{% visibility: project %}\n# Back!\n')).status)
          .toBe(303);
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
      expect(JSON.parse(stored.laddersJson)).toEqual(['gen1ou20261109', 'gen9ou20261109']);
      expect(account.decryptSecret(stored.authTokenEncoding!, AUTH_CFG.sessionSecret)).toBe(
        'Bearer ghcr_pat_123'
      );
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
      const res1 = await postDraftTeams('/api/account/teams', {
        ladderId: 'gen9championsvgc2026regmc',
        teams: batchOne,
      });
      expect(res1.status).toBe(200);
      expect(await res1.json()).toMatchObject({
        savedCount: 14,
        newlySavedCount: 14,
        requiredCount: 20,
        remainingCount: 6,
        complete: false,
      });

      const acctHtml = await (await realFetch(`${baseUrl}/account`, {
        headers: {Cookie: cookieFor('pre')},
      })).text();
      expect(acctHtml).toContain('<strong>14 / 20</strong> distinct teams saved — 6 more needed');
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
      expect((await incompleteSub.json() as {error: string}).error)
        .toContain('14/20 distinct teams saved — 6 more needed');

      const res2 = await postDraftTeams('/api/account/teams', {
        ladderId: 'gen9championsvgc2026regmc',
        teams: [...VALID_TWENTY_VGC.slice(0, 17), illegalTeam, PUBLIC_CLONE_VGC,
          VALID_TWENTY_VGC[2]],
      });
      expect(await res2.json()).toMatchObject({
        savedCount: 17,
        newlySavedCount: 3,
        remainingCount: 3,
        complete: false,
      });

      const res3 = await postDraftTeams('/api/account/teams', {
        ladderId: 'gen9championsvgc2026regmc',
        teams: VALID_TWENTY_VGC.slice(17, 20),
      });
      expect(await res3.json()).toMatchObject({
        savedCount: 20,
        newlySavedCount: 3,
        remainingCount: 0,
        complete: true,
        rejections: [],
      });
    });

    test('clears saved draft teams via POST /api/account/teams/clear', async () => {
      await postDraftTeams('/api/account/teams', {
        ladderId: 'gen9championsvgc2026regmc',
        teams: VALID_TWENTY_VGC.slice(0, 5),
      });
      const clr = await postDraftTeams('/api/account/teams/clear', {
        ladderId: 'gen9championsvgc2026regmc',
      });
      expect(clr.status).toBe(200);
      const agent = db.getAgentBySlug('0-error')!;
      expect(db.getTeamsForAgentLadder('gen9championsvgc2026regmc', agent.id, 'saved'))
        .toHaveLength(0);
    });

    test('rate-limits /api/account/teams after 5 attempts per minute', async () => {
      for (let i = 0; i < 5; i++) {
        const res = await postDraftTeams('/api/account/teams', {
          ladderId: 'gen9championsvgc2026regmc',
          teams: VALID_TWENTY_VGC.slice(0, 1),
        });
        expect(res.status).toBe(200);
      }
      const sixth = await postDraftTeams('/api/account/teams', {
        ladderId: 'gen9championsvgc2026regmc',
        teams: VALID_TWENTY_VGC.slice(0, 1),
      });
      expect(sixth.status).toBe(429);
      expect(sixth.headers.get('retry-after')).toBeTruthy();
    });

    test('promotes saved 20/20 draft teams to pending when submitting without teams', async () => {
      await postDraftTeams('/api/account/teams', {
        ladderId: 'gen9championsvgc2026regmc',
        teams: VALID_TWENTY_VGC,
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
        '[LIVE] Tournament #2: VGC 2026 Reg M-C OTS BO3</a></div>';

      const acctHtml = await (await realFetch(`${baseUrl}/account`, {
        headers: {Cookie: cookieFor('pre')},
      })).text();
      expect(acctHtml).toContain(expectedBanner);
      expect(acctHtml).toContain('name="tournaments" type="checkbox" value="3"');
      expect(acctHtml).toContain('OCI image required (linux/amd64)');

      const wikiHtml = await (await realFetch(`${baseUrl}/wiki`)).text();
      expect(wikiHtml).toContain(expectedBanner);
    });

    test('allows Pending projects to submit OCI images to scheduled tournaments', async () => {
      const pendingAcctHtml = await (await realFetch(`${baseUrl}/account`, {
        headers: {Cookie: cookieFor('rookie')},
      })).text();
      expect(pendingAcctHtml).not.toContain('<fieldset class="form-fieldset" disabled>');
      expect(pendingAcctHtml).toContain('name="tournaments" type="checkbox" value="3"');

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
  });
});
