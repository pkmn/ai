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

describe('submission helpers, SSRF guards, & secret encryption', () => {
  test('deducePackageFormat distinguishes native archive bundles from OCI refs', () => {
    expect(account.deducePackageFormat('https://example.com/agent.tar.gz?sig=1')).toBe('bundle');
    expect(account.deducePackageFormat('https://example.com/agent.tgz')).toBe('bundle');
    expect(account.deducePackageFormat('https://example.com/agent.tar.xz')).toBe('bundle');
    expect(account.deducePackageFormat('https://example.com/agent.txz')).toBe('bundle');
    expect(account.deducePackageFormat('https://example.com/agent.tar.zst')).toBe('bundle');
    expect(account.deducePackageFormat('https://example.com/agent.tar.zst#v1')).toBe('bundle');
    expect(account.deducePackageFormat('https://example.com/agent.tzst')).toBe('bundle');
    expect(account.deducePackageFormat('ghcr.io/pkmn/0-error:1.2.0')).toBe('oci');
    expect(account.deducePackageFormat('docker.io/library/agent@sha256:' + SHA_A)).toBe('oci');
  });

  test('validateArtifactUrl blocks loopback, RFC1918, link-local, and ULA SSRF targets', () => {
    expect(account.validateArtifactUrl('https://github.com/pkmn/0-error.tar.zst', 'bundle'))
      .toBeUndefined();
    expect(account.validateArtifactUrl('ghcr.io/pkmn/0-error:1.2.0', 'oci')).toBeUndefined();
    expect(account.validateArtifactUrl('pkmn/0-error:1.2.0', 'oci')).toBeUndefined();

    const blockedBundles = [
      'https://127.0.0.1/agent.tar.zst',
      'https://2130706433/agent.tar.zst',
      'https://0.0.0.0/agent.tar.zst',
      'https://100.64.0.5/agent.tar.zst',
      'https://198.18.0.1/agent.tar.zst',
      'https://localhost/agent.tar.zst',
      'https://sub.internal/agent.tar.zst',
      'https://[::1]/agent.tar.zst',
      'https://[::ffff:127.0.0.1]/agent.tar.zst',
      'https://[::ffff:7f00:1]/agent.tar.zst',
      'https://[::127.0.0.1]/agent.tar.zst',
      'https://[64:ff9b::a00:1]/agent.tar.zst',
      'https://[2002:7f00:1::1]/agent.tar.zst',
      'https://[2001::1]/agent.tar.zst',
      'https://[ff02::1]/agent.tar.zst',
      'https://10.0.0.5/agent.tar.zst',
      'https://192.168.1.10/agent.tar.zst',
      'https://172.16.0.1/agent.tar.zst',
      'https://169.254.169.254/latest/agent.tar.zst',
      'https://[fd00::1]/agent.tar.zst',
      'https://[fe80::1]/agent.tar.zst',
    ];
    for (const url of blockedBundles) {
      expect(account.validateArtifactUrl(url, 'bundle')).toContain('public host');
    }
    expect(account.validateArtifactUrl('127.0.0.1:5000/pkmn/agent:1.0.0', 'oci'))
      .toContain('public host');
    expect(account.validateArtifactUrl('2130706433:5000/pkmn/agent:1.0.0', 'oci'))
      .toContain('public host');
    expect(account.validateArtifactUrl('intranet:5000/pkmn/agent:1.0.0', 'oci'))
      .toContain('public host');
    expect(account.validateArtifactUrl('http://127.0.0.1:8080/agent.tar.zst', 'bundle', true))
      .toBeUndefined();
  });

  test('encryptSecret and decryptSecret roundtrip and reject tampering', () => {
    const enc = account.encryptSecret('Bearer ghp_secret123', 'session-secret-1');
    expect(enc).not.toContain('ghp_secret123');
    expect(account.decryptSecret(enc, 'session-secret-1')).toBe('Bearer ghp_secret123');
    expect(() => account.decryptSecret(enc, 'wrong-secret')).toThrow();
    expect(() => account.decryptSecret(`${enc}x`, 'session-secret-1')).toThrow();
  });

  test('splitSubmittedTeams supports === headers, arrays, and 6-block pastes', () => {
    const twoTeams = generateValidVgcTeams(2);
    const withHeaders =
      `=== [gen9championsvgc2026regmc] Team 1 ===\n${twoTeams[0]}\n\n` +
      `=== [gen9championsvgc2026regmc] Team 2 ===\n${twoTeams[1]}`;
    expect(splitSubmittedTeams(withHeaders)).toHaveLength(2);
    expect(splitSubmittedTeams(twoTeams)).toHaveLength(2);
    expect(splitSubmittedTeams(`${twoTeams[0]}\n\n${twoTeams[1]}`)).toHaveLength(2);
  });
});

describe('/account/ portal, Pending/Qualified/Eligible/Ineligible lifecycle, and VGC teams', () => {
  let tmpDir: string;
  let poolDir: string;
  let wikiDir: string;
  let projectsFile: string;
  let db: db.Database;
  let server: http.Server;
  let baseUrl: string;
  let currentNow: number;
  const realFetch = globalThis.fetch;

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
    fs.mkdirSync(wikiDir, {recursive: true});
    fs.writeFileSync(projectsFile, PROJECTS_YAML, 'utf8');

    execFileSync('git', ['init', '-b', 'main'], {cwd: wikiDir});
    execFileSync('git', ['config', 'user.name', 'test'], {cwd: wikiDir});
    execFileSync('git', ['config', 'user.email', 'test@pkmn.ai'], {cwd: wikiDir});
    fs.writeFileSync(path.join(wikiDir, 'index.dj'), '# Home\n');
    execFileSync('git', ['add', 'index.dj'], {cwd: wikiDir});
    execFileSync('git', ['commit', '-m', 'Init'], {cwd: wikiDir});

    const twentyOne = generateValidVgcTeams(21);
    fs.writeFileSync(path.join(poolDir, 'public000001'), twentyOne[20], 'utf8');

    currentNow = 1_760_000_000;
    db = new Database(':memory:');
    db.syncLadders(); // starts all 5 ladders in 'upcoming' status
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
    wiki.register(app, {
      wiki: wikiInstance,
      db,
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

  test('models Pending -> Qualified -> Eligible lifecycle & wiki access for Pending', async () => {
    db.linkDeveloperGitHubId('pre', githubIdFor('pre'), currentNow);
    const mismatchedId = await realFetch(`${baseUrl}/account`, {
      headers: {Cookie: cookieFor('pre', 999_999)},
      redirect: 'manual',
    });
    expect(mismatchedId.status).toBe(302);
    const renamedHandle = await realFetch(`${baseUrl}/account`, {
      headers: {Cookie: cookieFor('pre-renamed', githubIdFor('pre'))},
    });
    expect(renamedHandle.status).toBe(200);

    const unauth = await realFetch(`${baseUrl}/account`, {redirect: 'manual'});
    expect(unauth.status).toBe(302);
    expect(unauth.headers.get('location')).toBe('/auth/github?return_to=%2Faccount%2F');

    const stranger = await realFetch(`${baseUrl}/account`, {
      headers: {Cookie: cookieFor('stranger')},
    });
    expect(stranger.status).toBe(403);
    expect(await stranger.text()).toContain('template=register.yml');

    // 1. Pre-launch (all ladders 'upcoming'):
    //    - 'rookie' (qualified omitted) sees Status: Pending + disabled fieldset
    //    - 'pre' (qualified: true) sees Status: Eligible + (upcoming) checkboxes + enabled fieldset
    const rookiePreLaunch = await realFetch(`${baseUrl}/account`, {
      headers: {Cookie: cookieFor('rookie')},
    });
    expect(rookiePreLaunch.status).toBe(200);
    const rookieHtml = await rookiePreLaunch.text();
    expect(rookieHtml).toContain('>Pending<');
    expect(rookieHtml).toContain('<fieldset class="form-fieldset" disabled>');

    const prePreLaunch = await realFetch(`${baseUrl}/account`, {
      headers: {Cookie: cookieFor('pre')},
    });
    expect(prePreLaunch.status).toBe(200);
    const preUpcomingHtml = await prePreLaunch.text();
    expect(preUpcomingHtml).toContain('>Eligible<');
    expect(preUpcomingHtml).toContain('(upcoming)');
    expect(preUpcomingHtml).toContain('value="gen3ou20261109"');
    expect(preUpcomingHtml).not.toContain('<fieldset class="form-fieldset" disabled>');

    // Pending developer ('rookie') still receives 403 on ladder submissions
    const rookieBlockedSub = await realFetch(`${baseUrl}/api/submissions`, {
      method: 'POST',
      headers: {
        Cookie: cookieFor('rookie'),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        version: '0.1.0',
        package: 'bundle',
        url: 'https://example.com/newcomer.tar.zst',
        sha256: SHA_A,
        ladders: ['RBY'],
      }),
    });
    expect(rookieBlockedSub.status).toBe(403);

    // Pending developer ('rookie') CAN edit the wiki even before qualification!
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

    // Approved developer ('pre') CAN submit to an 'upcoming' ladder (ADV) -> 201!
    const upcomingLadderSub = await realFetch(`${baseUrl}/api/submissions`, {
      method: 'POST',
      headers: {
        Cookie: cookieFor('pre'),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        version: '0.9.0',
        package: 'bundle',
        url: 'https://example.com/0-error-0.9.0.tar.zst',
        sha256: SHA_A,
        ladders: ['ADV'],
      }),
    });
    expect(upcomingLadderSub.status).toBe(201);
    const advVer = (await upcomingLadderSub.json() as {versionId: number});
    db.applySubmissionStatus({versionId: advVer.versionId, smokeStatus: 'passed', now: currentNow});

    // Entry on 'upcoming' ADV has matches=0 & se=350, yet after cooldown refund 'pre' remains
    // Eligible (upcoming ladders do not require settlement before matchmaking starts).
    db.refundCooldown('0-error');
    expect(db.computeAgentSubmissionStatus(db.getAgentBySlug('0-error')!.id, currentNow)).toEqual({
      label: 'Eligible',
      canSubmit: true,
    });

    // Clean up test submission before checking closed/settled/open transitions
    db.db.prepare('DELETE FROM ladder_entries WHERE version_id = ?').run(advVer.versionId);
    db.db.prepare('DELETE FROM agent_ladder_stats').run();
    db.db.prepare('DELETE FROM agent_versions WHERE id = ?').run(advVer.versionId);

    // 2. When no ladders are 'upcoming' or 'active' (all 'settling'), 'pre' shows Qualified
    db.db.prepare("UPDATE ladders SET status = 'settling'").run();
    const preClosed = await realFetch(`${baseUrl}/account`, {
      headers: {Cookie: cookieFor('pre')},
    });
    const preClosedHtml = await preClosed.text();
    expect(preClosedHtml).toContain('>Qualified<');
    expect(preClosedHtml).toContain('<fieldset class="form-fieldset" disabled>');

    const closedSub = await realFetch(`${baseUrl}/api/submissions`, {
      method: 'POST',
      headers: {
        Cookie: cookieFor('pre'),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        version: '1.0.0',
        package: 'bundle',
        url: 'https://example.com/0-error-1.0.0.tar.zst',
        sha256: SHA_A,
        ladders: ['RBY'],
      }),
    });
    expect(closedSub.status).toBe(403);

    // Submitting to a 'settling' ladder once RBY/SV open returns 400
    openLadders(['gen1ou20261109', 'gen9ou20261109']);
    const preOpen = await realFetch(`${baseUrl}/account`, {
      headers: {Cookie: cookieFor('pre')},
    });
    const preOpenHtml = await preOpen.text();
    expect(preOpenHtml).toContain('>Eligible<');
    expect(preOpenHtml).not.toContain('<fieldset class="form-fieldset" disabled>');
    expect(preOpenHtml).not.toContain('value="gen3ou20261109"');

    const settlingSub = await realFetch(`${baseUrl}/api/submissions`, {
      method: 'POST',
      headers: {
        Cookie: cookieFor('pre'),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        version: '1.0.0',
        package: 'bundle',
        url: 'https://example.com/0-error.tar.zst',
        sha256: SHA_A,
        ladders: ['ADV'],
      }),
    });
    expect(settlingSub.status).toBe(400);
  });

  test('scopes Discord per developer while sharing Active and History tables', async () => {
    openLadders(['gen1ou20261109', 'gen3ou20261109']);
    const agent = db.getAgentBySlug('0-error')!;

    const v1 = db.createSubmission({
      agentId: agent.id,
      developerId: db.getDeveloperByGitHub('pre')!.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://example.com/0-error-1.0.0.tar.zst',
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
      url: 'https://example.com/0-error-1.1.0-rc1.tar.zst',
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
      url: 'https://example.com/0-error-1.1.0.tar.zst',
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
    expect(preHtml).toContain('>change<');
    expect(preHtml).toContain('>Eligible<');
    expect(preHtml).toContain('118–24–38');
    expect(preHtml).toContain('±28');
    expect(preHtml).toContain('Seatbelt EPERM');
    expect(preHtml).toContain('(DM sent)');
    expect(preHtml).toContain('Active <span class="muted">(RBY)</span>');
    expect(preHtml).toContain('>Retired<');

    const coHtml = await (await realFetch(`${baseUrl}/account`, {
      headers: {Cookie: cookieFor('coauthor')},
    })).text();
    expect(coHtml).toContain('<strong>coauthor</strong>');
    expect(coHtml).not.toContain('@scheibo');
    expect(coHtml).toContain('>None<');
    expect(coHtml).toContain('>link<');
    expect(coHtml).toContain('118–24–38');
    expect(coHtml).toContain('1.1.0-rc1');
  });

  test('enforces submission format rules, 14-day cooldown, and settlement gates', async () => {
    openLadders(['gen1ou20261109', 'gen9ou20261109']);
    const agent = db.getAgentBySlug('foul-play')!;
    expect(db.computeAgentSubmissionStatus(agent.id, currentNow).label).toBe('Eligible');

    const badVer = await realFetch(`${baseUrl}/api/submissions`, {
      method: 'POST',
      headers: {
        Cookie: cookieFor('pmariglia'),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        version: 'bad version string!!',
        package: 'bundle',
        url: 'https://example.com/fp.tar.xz',
        sha256: SHA_A,
        ladders: ['RBY'],
      }),
    });
    expect(badVer.status).toBe(400);

    const badType = await realFetch(`${baseUrl}/api/submissions`, {
      method: 'POST',
      headers: {
        Cookie: cookieFor('pmariglia'),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        version: '1.0.0',
        package: 'oci',
        url: 'https://example.com/fp.tar.xz',
        sha256: SHA_A,
        ladders: ['RBY'],
      }),
    });
    expect(badType.status).toBe(400);

    const okSub = await realFetch(`${baseUrl}/api/submissions`, {
      method: 'POST',
      headers: {
        Cookie: cookieFor('pmariglia'),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        version: '1.0.0',
        package: 'oci',
        url: 'ghcr.io/pmariglia/foul-play:1.0.0',
        sha256: SHA_A.toUpperCase(),
        authToken: 'Bearer ghcr_pat_123',
        ladders: ['RBY', 'SV'],
      }),
    });
    expect(okSub.status).toBe(201);
    const createdJson = await okSub.json() as {versionId: number; smokeStatus: string};
    expect(createdJson.smokeStatus).toBe('pending');

    const stored = db.getVersionsForAgent(agent.id)[0];
    expect(stored.sha256).toBe(SHA_A);
    expect(JSON.parse(stored.laddersJson)).toEqual(['gen1ou20261109', 'gen9ou20261109']);
    expect(account.decryptSecret(stored.authTokenEncoding!, AUTH_CFG.sessionSecret)).toBe(
      'Bearer ghcr_pat_123'
    );

    // While pending -> status is Ineligible (429 on second submit)
    expect(db.computeAgentSubmissionStatus(agent.id, currentNow).label).toBe('Ineligible');
    const blockedPending = await realFetch(`${baseUrl}/api/submissions`, {
      method: 'POST',
      headers: {
        Cookie: cookieFor('pmariglia'),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        version: '1.0.1',
        package: 'oci',
        url: 'ghcr.io/pmariglia/foul-play:1.0.1',
        sha256: SHA_B,
        ladders: ['RBY'],
      }),
    });
    expect(blockedPending.status).toBe(429);

    // Failed smoke test automatically refunds cooldown -> Eligible again immediately!
    db.db.prepare("UPDATE agent_versions SET smoke_status = 'failed' WHERE id = ?")
      .run(stored.id);
    expect(db.computeAgentSubmissionStatus(agent.id, currentNow).label).toBe('Eligible');

    // Passed smoke test -> triggers 14-day cooldown + unsettled gate
    db.db.prepare("UPDATE agent_versions SET smoke_status = 'passed' WHERE id = ?")
      .run(stored.id);
    db.db.prepare(
      `INSERT INTO ladder_entries (
         ladder_id, version_id, role, elo, se, matches
       ) VALUES ('gen1ou20261109', ?, 'champion', 1550, 85, 10)`
    ).run(stored.id);

    expect(db.computeAgentSubmissionStatus(agent.id, currentNow + 86400).label).toBe('Ineligible');

    currentNow += COOLDOWN_SECONDS + 60;
    const unsettledStatus = db.computeAgentSubmissionStatus(agent.id, currentNow);
    expect(unsettledStatus.canSubmit).toBe(false);
    expect(unsettledStatus.reason).toContain('has not settled');

    db.db.prepare(
      'UPDATE ladder_entries SET se = 24, matches = 30 WHERE version_id = ?'
    ).run(stored.id);
    expect(db.computeAgentSubmissionStatus(agent.id, currentNow)).toEqual({
      label: 'Eligible',
      canSubmit: true,
    });
  });

  test('validates VGC 20-team submissions sequentially and locks seasonal pools', async () => {
    openLadders(['gen9championsvgc2026regmc']);
    const twentyOne = generateValidVgcTeams(21);
    const validTwenty = twentyOne.slice(0, 20);
    const publicClone = twentyOne[20];

    const postVgc = (version: string, teams?: string | string[]) =>
      realFetch(`${baseUrl}/api/submissions`, {
        method: 'POST',
        headers: {
          Cookie: cookieFor('pre'),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          version,
          package: 'bundle',
          url: `https://example.com/0-error-${version}.tar.zst`,
          sha256: SHA_A,
          ladders: ['VGC'],
          ...(teams !== undefined ? {teams} : {}),
        }),
      });

    const clearSavedVgc = () =>
      realFetch(`${baseUrl}/api/account/teams/clear`, {
        method: 'POST',
        headers: {
          Cookie: cookieFor('pre'),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ladderId: 'gen9championsvgc2026regmc'}),
      });

    const missingRes = await postVgc('1.0.0');
    expect(missingRes.status).toBe(400);
    expect((await missingRes.json() as {error: string}).error).toContain('requires 20 valid teams');

    const wrongCount = await postVgc('1.0.0', validTwenty.slice(0, 19));
    expect(wrongCount.status).toBe(400);
    const wrongJson = await wrongCount.json() as {
      error: string;
      savedCount: number;
      remainingCount: number;
    };
    expect(wrongJson.error).toContain(
      'Expected 20 teams for gen9championsvgc2026regmc, received 19'
    );
    expect(wrongJson.savedCount).toBe(19);
    expect(wrongJson.remainingCount).toBe(1);
    expect((await clearSavedVgc()).status).toBe(200);

    const withIllegal = [...validTwenty];
    withIllegal[4] = validTwenty[4].replace(/^[A-Za-z-]+ @/, 'Mewtwo @');
    const illegalRes = await postVgc('1.0.0', withIllegal);
    expect(illegalRes.status).toBe(400);
    const illegalJson = await illegalRes.json() as {error: string; savedCount: number};
    expect(illegalJson.error).toContain('Team #5');
    expect(illegalJson.savedCount).toBe(19);
    expect((await clearSavedVgc()).status).toBe(200);

    const withPublicClone = [...validTwenty];
    withPublicClone[2] = publicClone;
    const pubCloneRes = await postVgc('1.0.0', withPublicClone);
    expect(pubCloneRes.status).toBe(400);
    const pubJson = await pubCloneRes.json() as {error: string; savedCount: number};
    expect(pubJson.error).toContain('Team #3 failed uniqueness check');
    expect(pubJson.error).toContain('closest=public000001');
    expect(pubJson.savedCount).toBe(19);
    expect((await clearSavedVgc()).status).toBe(200);

    const withSelfClone = [...validTwenty];
    withSelfClone[7] = validTwenty[1];
    const selfCloneRes = await postVgc('1.0.0', withSelfClone);
    expect(selfCloneRes.status).toBe(400);
    const selfJson = await selfCloneRes.json() as {error: string; savedCount: number};
    expect(selfJson.error).toContain('Team #8 failed uniqueness check');
    expect(selfJson.error).toContain('closest=submitted-team-2');
    expect(selfJson.savedCount).toBe(19);
    expect((await clearSavedVgc()).status).toBe(200);

    // 6th rapid submission attempt within 60s is throttled with 429 + Retry-After before CPU work!
    const throttledRes = await postVgc('1.0.0', validTwenty);
    expect(throttledRes.status).toBe(429);
    expect(throttledRes.headers.get('retry-after')).toBe('60');

    // Advance past 60s submission rate-limit window -> valid 20-team submission succeeds!
    currentNow += 61;

    const backupPaste = validTwenty
      .map((t, i) => `=== [gen9championsvgc2026regmc] Team ${i + 1} ===\n${t}`)
      .join('\n\n');
    const okRes = await postVgc('1.0.0', backupPaste);
    expect(okRes.status).toBe(201);

    const agent = db.getAgentBySlug('0-error')!;
    const pendingTeams =
      db.getTeamsForAgentLadder('gen9championsvgc2026regmc', agent.id, 'pending');
    expect(pendingTeams).toHaveLength(20);

    const v1 = db.getVersionsForAgent(agent.id)[0];
    db.db.prepare("UPDATE agent_versions SET smoke_status = 'passed' WHERE id = ?").run(v1.id);
    db.db.prepare(
      `UPDATE agent_ladder_teams SET status = 'active'
       WHERE ladder_id = 'gen9championsvgc2026regmc' AND agent_id = ?`
    ).run(agent.id);
    db.db.prepare(
      `INSERT INTO ladder_entries (
         ladder_id, version_id, role, elo, se, matches, settled_at
       ) VALUES ('gen9championsvgc2026regmc', ?, 'champion', 1620, 20, 35, ?)`
    ).run(v1.id, currentNow + 86400);
    currentNow += COOLDOWN_SECONDS + 3600;

    const overwriteAttempt = await postVgc('1.1.0', backupPaste);
    expect(overwriteAttempt.status).toBe(400);
    expect((await overwriteAttempt.json() as {error: string}).error).toContain('already locked');

    const reuseOk = await postVgc('1.1.0');
    expect(reuseOk.status).toBe(201);
    expect(db.getTeamsForAgentLadder('gen9championsvgc2026regmc', agent.id, 'active'))
      .toHaveLength(20);
  });

  test(
    'incrementally saves valid pool teams (14/20 -> 20/20), renders /account progress, and clears',
    async () => {
      openLadders(['gen9championsvgc2026regmc']);
      const twentyOne = generateValidVgcTeams(21);
      const validTwenty = twentyOne.slice(0, 20);
      const publicClone = twentyOne[20];
      const illegalTeam = validTwenty[4].replace(/^[A-Za-z-]+ @/, 'Mewtwo @');

      const postTeams = (endpoint: string, body: Record<string, unknown>) =>
        realFetch(`${baseUrl}${endpoint}`, {
          method: 'POST',
          headers: {
            Cookie: cookieFor('pre'),
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(body),
        });

      // Batch 1: 14 distinct valid + 2 illegal + 2 public clones + 2 duplicates of saved teams
      const batchOne = [
        ...validTwenty.slice(0, 14),
        illegalTeam,
        illegalTeam,
        publicClone,
        publicClone,
        validTwenty[0],
        validTwenty[1],
      ];
      const res1 = await postTeams('/api/account/teams', {
        ladderId: 'gen9championsvgc2026regmc',
        teams: batchOne,
      });
      expect(res1.status).toBe(200);
      const j1 = await res1.json() as {
        savedCount: number;
        newlySavedCount: number;
        requiredCount: number;
        remainingCount: number;
        complete: boolean;
        rejections: Array<{index: number; reason: string}>;
      };
      expect(j1.savedCount).toBe(14);
      expect(j1.newlySavedCount).toBe(14);
      expect(j1.requiredCount).toBe(20);
      expect(j1.remainingCount).toBe(6);
      expect(j1.complete).toBe(false);
      expect(j1.rejections).toHaveLength(6);

      // Verify /account HTML and /account.json reflect 14/20 saved & 6 remaining
      const acctHtml = await (await realFetch(`${baseUrl}/account`, {
        headers: {Cookie: cookieFor('pre')},
      })).text();
      expect(acctHtml).toContain(
        '<strong>14 / 20</strong> distinct teams saved — 6 more needed'
      );
      expect(acctHtml).toContain('14/20 saved');
      expect(acctHtml).toContain('data-saved-teams="14"');

      const acctJson = await (await realFetch(`${baseUrl}/account.json`, {
        headers: {Cookie: cookieFor('pre')},
      })).json() as {
        savedTeams: Record<string, {
          savedCount: number;
          requiredCount: number;
          remainingCount: number;
          complete: boolean;
          locked: boolean;
        }>;
      };
      expect(acctJson.savedTeams.gen9championsvgc2026regmc).toEqual({
        savedCount: 14,
        requiredCount: 20,
        remainingCount: 6,
        complete: false,
        locked: false,
      });

      // Submitting without teams while at 14/20 explains 6 more needed
      const incompleteSub = await realFetch(`${baseUrl}/api/submissions`, {
        method: 'POST',
        headers: {
          Cookie: cookieFor('pre'),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          version: '1.0.0',
          package: 'bundle',
          url: 'https://example.com/0-error-1.0.0.tar.zst',
          sha256: SHA_A,
          ladders: ['VGC'],
        }),
      });
      expect(incompleteSub.status).toBe(400);
      expect((await incompleteSub.json() as {error: string}).error)
        .toContain('14/20 distinct teams saved — 6 more needed');

      // Batch 2: re-upload all 20 with 3 fixed slots; first 14 saved are preserved idempotently
      const batchTwo = [
        ...validTwenty.slice(0, 17),
        illegalTeam,
        publicClone,
        validTwenty[2],
      ];
      const res2 = await postTeams('/api/account/teams', {
        ladderId: 'gen9championsvgc2026regmc',
        teams: batchTwo,
      });
      expect(res2.status).toBe(200);
      const j2 = await res2.json() as {
        savedCount: number;
        newlySavedCount: number;
        remainingCount: number;
        complete: boolean;
        rejections: Array<{index: number; reason: string}>;
      };
      expect(j2.savedCount).toBe(17);
      expect(j2.newlySavedCount).toBe(3);
      expect(j2.remainingCount).toBe(3);
      expect(j2.complete).toBe(false);
      expect(j2.rejections).toHaveLength(3);

      // Batch 3: upload only the remaining 3 distinct teams -> 20/20 complete
      const res3 = await postTeams('/api/account/teams', {
        ladderId: 'gen9championsvgc2026regmc',
        teams: validTwenty.slice(17, 20),
      });
      expect(res3.status).toBe(200);
      const j3 = await res3.json() as {
        savedCount: number;
        newlySavedCount: number;
        remainingCount: number;
        complete: boolean;
        rejections: unknown[];
      };
      expect(j3.savedCount).toBe(20);
      expect(j3.newlySavedCount).toBe(3);
      expect(j3.remainingCount).toBe(0);
      expect(j3.complete).toBe(true);
      expect(j3.rejections).toEqual([]);

      // Clear resets back to 0/20
      const clr = await postTeams('/api/account/teams/clear', {
        ladderId: 'gen9championsvgc2026regmc',
      });
      expect(clr.status).toBe(200);
      const agent = db.getAgentBySlug('0-error')!;
      expect(db.getTeamsForAgentLadder('gen9championsvgc2026regmc', agent.id, 'saved'))
        .toHaveLength(0);

      // Save all 20 again then submit WITHOUT `teams` -> reuses saved 20/20 and promotes to pending
      const resAll = await postTeams('/api/account/teams', {
        ladderId: 'gen9championsvgc2026regmc',
        teams: validTwenty,
      });
      expect((await resAll.json() as {complete: boolean}).complete).toBe(true);

      // 5th call to /api/account/teams succeeds; 6th call within window is rate-limited (429)
      const resFifth = await postTeams('/api/account/teams', {
        ladderId: 'gen9championsvgc2026regmc',
        teams: validTwenty.slice(0, 1),
      });
      expect(resFifth.status).toBe(200);
      const resSixth = await postTeams('/api/account/teams', {
        ladderId: 'gen9championsvgc2026regmc',
        teams: validTwenty.slice(0, 1),
      });
      expect(resSixth.status).toBe(429);
      expect(resSixth.headers.get('retry-after')).toBeTruthy();

      const finalSub = await realFetch(`${baseUrl}/api/submissions`, {
        method: 'POST',
        headers: {
          Cookie: cookieFor('pre'),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          version: '1.0.0',
          package: 'bundle',
          url: 'https://example.com/0-error-1.0.0.tar.zst',
          sha256: SHA_A,
          ladders: ['VGC'],
        }),
      });
      expect(finalSub.status).toBe(201);
      expect(db.getTeamsForAgentLadder('gen9championsvgc2026regmc', agent.id, 'saved'))
        .toHaveLength(0);
      expect(db.getTeamsForAgentLadder('gen9championsvgc2026regmc', agent.id, 'pending'))
        .toHaveLength(20);
    }
  );

  test('gates tournament OCI submissions independently of ladder cooldowns & injects #topbar',
    async () => {
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

      // Even with all ladders 'upcoming', Qualified agent ('pre') has #submission enabled for T#3,
      // and both /account and /wiki display the site-wide [LIVE] Tournament #2 #topbar banner!
      const acctHtml = await (await realFetch(`${baseUrl}/account`, {
        headers: {Cookie: cookieFor('pre')},
      })).text();
      expect(acctHtml).toContain(
        '<div id="topbar"><a href="/arena/tournaments/2/" class="subtle">' +
        '[LIVE] Tournament #2: VGC 2026 Reg M-C OTS BO3</a></div>'
      );
      expect(acctHtml).not.toContain('<fieldset class="form-fieldset" disabled>');
      expect(acctHtml).toContain('name="tournaments" type="checkbox" value="3"');
      expect(acctHtml).toContain('OCI image required (linux/amd64)');

      const wikiHtml = await (await realFetch(`${baseUrl}/wiki`)).text();
      expect(wikiHtml).toContain(
        '<div id="topbar"><a href="/arena/tournaments/2/" class="subtle">' +
        '[LIVE] Tournament #2: VGC 2026 Reg M-C OTS BO3</a></div>'
      );

      // Pending (registered, not yet qualified for ladders) project CAN submit OCI to scheduled
      // tournaments, while still remaining blocked (403) from entering ladders.
      const pendingAcctHtml = await (await realFetch(`${baseUrl}/account`, {
        headers: {Cookie: cookieFor('rookie')},
      })).text();
      expect(pendingAcctHtml).not.toContain('<fieldset class="form-fieldset" disabled>');
      expect(pendingAcctHtml).toContain('name="tournaments" type="checkbox" value="3"');

      const pendingBundleBlocked = await realFetch(`${baseUrl}/api/submissions`, {
        method: 'POST',
        headers: {
          Cookie: cookieFor('rookie'),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          version: '0.1.0-b',
          package: 'bundle',
          url: 'https://example.com/newcomer.tar.zst',
          sha256: SHA_A,
          tournaments: ['3'],
        }),
      });
      expect(pendingBundleBlocked.status).toBe(400);

      const pendingTourneyOk = await realFetch(`${baseUrl}/api/submissions`, {
        method: 'POST',
        headers: {
          Cookie: cookieFor('rookie'),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          version: '0.1.0-t3',
          package: 'oci',
          url: 'ghcr.io/rookie/newcomer:0.1.0-t3',
          sha256: SHA_A,
          tournaments: ['3'],
        }),
      });
      expect(pendingTourneyOk.status).toBe(201);

      // Even after ladders become active, Pending account still cannot become Eligible or submit
      openLadders(['gen1ou20261109']);
      const pendingLadderBlocked = await realFetch(`${baseUrl}/api/submissions`, {
        method: 'POST',
        headers: {
          Cookie: cookieFor('rookie'),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          version: '0.1.1-rby',
          package: 'oci',
          url: 'ghcr.io/rookie/newcomer:0.1.1-rby',
          sha256: SHA_B,
          ladders: ['gen1ou20261109'],
        }),
      });
      expect(pendingLadderBlocked.status).toBe(403);
      expect((await pendingLadderBlocked.json() as {error: string}).error).toContain('pending');

      // Archive bundle is rejected for tournament submissions (must be self-contained OCI image)
      const bundleRejected = await realFetch(`${baseUrl}/api/submissions`, {
        method: 'POST',
        headers: {
          Cookie: cookieFor('pre'),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          version: '1.0.0-t3',
          package: 'bundle',
          url: 'https://example.com/0-error-t3.tar.zst',
          sha256: SHA_A,
          tournaments: ['3'],
        }),
      });
      expect(bundleRejected.status).toBe(400);
      expect((await bundleRejected.json() as {error: string}).error).toContain('OCI image');

      // Valid OCI tournament submission succeeds
      const tourneySub = await realFetch(`${baseUrl}/api/submissions`, {
        method: 'POST',
        headers: {
          Cookie: cookieFor('pre'),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          version: '1.0.0-t3',
          package: 'oci',
          url: 'ghcr.io/pkmn/0-error:1.0.0-t3',
          sha256: SHA_A,
          tournaments: ['3'],
        }),
      });
      expect(tourneySub.status).toBe(201);
      const {versionId} = await tourneySub.json() as {versionId: number};

      // Duplicate submission to the same tournament is blocked (403/409)
      openLadders(['gen1ou20261109']);
      const dupTourneySub = await realFetch(`${baseUrl}/api/submissions`, {
        method: 'POST',
        headers: {
          Cookie: cookieFor('pre'),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          version: '1.0.1-t3',
          package: 'oci',
          url: 'ghcr.io/pkmn/0-error:1.0.1-t3',
          sha256: SHA_B,
          tournaments: ['3'],
        }),
      });
      expect(dupTourneySub.status).toBe(409);

      // Failed smoke test unlocks tournament slot immediately
      db.applySubmissionStatus({versionId, smokeStatus: 'failed', now: currentNow + 5});
      const mixedSub = await realFetch(`${baseUrl}/api/submissions`, {
        method: 'POST',
        headers: {
          Cookie: cookieFor('pre'),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          version: '1.0.1-mix',
          package: 'oci',
          url: 'ghcr.io/pkmn/0-error:1.0.1-mix',
          sha256: SHA_B,
          ladders: ['gen1ou20261109'],
          tournaments: ['3'],
        }),
      });
      expect(mixedSub.status).toBe(400);
      const retrySub = await realFetch(`${baseUrl}/api/submissions`, {
        method: 'POST',
        headers: {
          Cookie: cookieFor('pre'),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          version: '1.0.2-t3',
          package: 'oci',
          url: 'ghcr.io/pkmn/0-error:1.0.2-t3',
          sha256: SHA_B,
          tournaments: ['3'],
        }),
      });
      expect(retrySub.status).toBe(201);
      const retryData = await retrySub.json() as {versionId: number};

      // Passing tournament smoke test enrolls entrant AND leaves ladder eligibility open!
      db.applySubmissionStatus({
        versionId: retryData.versionId,
        smokeStatus: 'passed',
        now: currentNow + 10,
      });
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
      expect(afterEnteredHtml).toContain('>Eligible<');

      // Submitting to RBY ladder still works right after tournament submission, then puts ladders
      // on 14-day cooldown while STILL allowing Foul Play (on ladder cooldown) to enter T#3!
      currentNow += 65;
      const ladderSub = await realFetch(`${baseUrl}/api/submissions`, {
        method: 'POST',
        headers: {
          Cookie: cookieFor('pre'),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          version: '1.1.0',
          package: 'bundle',
          url: 'https://example.com/0-error-1.1.0.tar.zst',
          sha256: SHA_A,
          ladders: ['RBY'],
        }),
      });
      expect(ladderSub.status).toBe(201);
      const ladderData = await ladderSub.json() as {versionId: number};
      db.applySubmissionStatus({
        versionId: ladderData.versionId,
        smokeStatus: 'passed',
        now: currentNow + 5,
      });
      expect(db.computeAgentSubmissionStatus(zeroAgent.id, currentNow + 10).canSubmit).toBe(false);

      // Schedule Tournament #4: 0 ERROR is on 14-day ladder cooldown, yet CAN submit to T#4!
      db.upsertTournament({
        id: '4',
        name: 'Tournament #4: Gen 9 OU',
        format: 'gen9ou',
        gamesPerMatchup: 8,
        parallelTables: 2,
        hardware: 'GCP L4 Spot',
        status: 'scheduled',
        startsAt: currentNow + 86400 * 14,
      });
      const t4WhileOnCooldown = await realFetch(`${baseUrl}/api/submissions`, {
        method: 'POST',
        headers: {
          Cookie: cookieFor('pre'),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          version: '1.1.0-t4',
          package: 'oci',
          url: 'ghcr.io/pkmn/0-error:1.1.0-t4',
          sha256: SHA_B,
          tournaments: ['4'],
        }),
      });
      expect(t4WhileOnCooldown.status).toBe(201);

      // Tournament #5 starting 18:00 UTC tomorrow closes at 00:00 UTC strictly before start
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

      // 1 second before midnight UTC cutoff -> allowed (checkbox open + POST 201)
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

      const beforeCutoffSub = await realFetch(`${baseUrl}/api/submissions`, {
        method: 'POST',
        headers: {
          Cookie: cookieFor('pmariglia'),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          version: '1.0.0-t5',
          package: 'oci',
          url: 'ghcr.io/pmariglia/foul-play:1.0.0-t5',
          sha256: SHA_A,
          tournaments: ['5'],
        }),
      });
      expect(beforeCutoffSub.status).toBe(201);

      // At exact midnight UTC cutoff -> closed even while status === 'scheduled' & now < startsAt
      currentNow = t5ClosesAt;
      const afterCutoffHtml = await (await realFetch(`${baseUrl}/account`, {
        headers: {Cookie: cookieFor('pre')},
      })).text();
      expect(afterCutoffHtml).toContain('(entries closed)');

      const afterCutoffSub = await realFetch(`${baseUrl}/api/submissions`, {
        method: 'POST',
        headers: {
          Cookie: cookieFor('pre'),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          version: '1.1.0-t5',
          package: 'oci',
          url: 'ghcr.io/pkmn/0-error:1.1.0-t5',
          sha256: SHA_B,
          tournaments: ['5'],
        }),
      });
      expect(afterCutoffSub.status).toBe(400);
      expect((await afterCutoffSub.json() as {error: string}).error).toContain('closed at');
    });

  test('reassigns developer A -> B -> A with wiki ACL & comment preservation', async () => {
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

    // Seed an active ladder entry on 0 ERROR before pre leaves 0 ERROR
    const zeroAgent = db.getAgentBySlug('0-error')!;
    const vZero = db.createSubmission({
      agentId: zeroAgent.id,
      developerId: db.getDeveloperByGitHub('pre')!.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://example.com/0-error-1.0.0.tar.zst',
      sha256: SHA_A,
      ladderIds: ['gen1ou20261109'],
      now: currentNow,
    });
    db.applySubmissionStatus({versionId: vZero.id, smokeStatus: 'passed', now: currentNow + 5});

    // Create private project wiki pages for both 0 ERROR and Foul Play
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
      (await postWiki('Foul_Play', 'pmariglia', '{% visibility: project %}\n# Foul Play\n')).status
    ).toBe(303);

    // 1. Reassign pre from 0 ERROR -> Foul Play via `pkmn reassign-developer`
    await runPkmnCli(
      ['reassign-developer', 'pre', 'Foul Play', '--projects', projectsFile],
      {db, now: currentNow + 20, log: () => undefined}
    );

    const updatedYaml = fs.readFileSync(projectsFile, 'utf8');
    expect(updatedYaml).toContain('# Arena projects registry');
    expect(updatedYaml).toContain('# flagship search agent');

    // 0 ERROR remains active on RBY with 0 owners
    expect(db.getActiveEntriesForAgent(zeroAgent.id)).toHaveLength(1);
    expect(db.getDevelopersForAgent(zeroAgent.id)).toEqual([]);

    // /account for pre now manages Foul Play, can edit Foul_Play wiki, blocked from 0_ERROR wiki
    const movedAccount = await (await realFetch(`${baseUrl}/account`, {
      headers: {Cookie: cookieFor('pre')},
    })).text();
    expect(movedAccount).toContain('href="/projects/foul-play/"');

    expect((await postWiki('0_ERROR', 'pre', '{% visibility: project %}\n# Nope\n')).status)
      .toBe(403);
    expect((await postWiki('Foul_Play', 'pre', '{% visibility: project %}\n# Joined!\n')).status)
      .toBe(303);

    // 2. Reassign pre back Foul Play -> 0 ERROR
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

  test('serves machine-consumable /account.json === /account/index.json and rejects >12c version',
    async () => {
      openLadders(['gen1ou20261109']);

      // Unauthenticated -> 401 JSON (never HTML redirect)
      const unauthJson = await realFetch(`${baseUrl}/account.json`, {redirect: 'manual'});
      expect(unauthJson.status).toBe(401);
      expect(unauthJson.headers.get('content-type')).toContain('application/json');

      // Unregistered GitHub user -> 403 JSON
      const outsiderToken = auth.signToken(
        {github: {id: 777, login: 'outsider'}, exp: Math.floor(Date.now() / 1000) + 3600},
        AUTH_CFG.sessionSecret
      );
      const forbiddenJson = await realFetch(`${baseUrl}/account.json`, {
        headers: {Cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(outsiderToken)}`},
      });
      expect(forbiddenJson.status).toBe(403);

      // Registered developer -> identical 200 JSON across /account.json & /account/index.json
      const preToken = auth.signToken(
        {github: {id: 1, login: 'pre'}, exp: Math.floor(Date.now() / 1000) + 3600},
        AUTH_CFG.sessionSecret
      );
      const cookie = `${auth.SESSION_COOKIE}=${encodeURIComponent(preToken)}`;

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

      // >12 character version rejected at POST /api/submissions
      const tooLong = await realFetch(`${baseUrl}/api/submissions`, {
        method: 'POST',
        headers: {Cookie: cookie, 'Content-Type': 'application/json'},
        body: JSON.stringify({
          version: '1.2.3-toolong',
          url: 'https://github.com/pkmn/0-error.tar.zst',
          sha256: SHA_A,
          ladders: ['gen1ou20261109'],
        }),
      });
      expect(tooLong.status).toBe(400);
      const errBody = await tooLong.json() as {error: string};
      expect(errBody.error).toMatch(/1[–-]12 chars/);

      // Oversized > 512 KB submission returns 413 cleanly without EPIPE
      const oversized = await realFetch(`${baseUrl}/api/submissions`, {
        method: 'POST',
        headers: {Cookie: cookie, 'Content-Type': 'application/json'},
        body: JSON.stringify({
          version: '1.0.0',
          url: 'https://github.com/pkmn/0-error.tar.zst',
          sha256: SHA_A,
          ladders: ['gen1ou20261109'],
          padding: 'x'.repeat(600_000),
        }),
      });
      expect(oversized.status).toBe(413);

      // Submit valid pending version with private authToken + presigned URL and verify
      // /account.json omits authTokenEncoding, url, developerId, and notified, and supports HEAD
      const validSub = await realFetch(`${baseUrl}/api/submissions`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          version: '1.0.0',
          package: 'bundle',
          url: 'https://releases.example.com/0-error.tar.zst?X-Amz-Signature=topsecret',
          sha256: SHA_A,
          authToken: 'ghp_supersecret_token',
          ladders: ['gen1ou20261109'],
        }),
      });
      expect(validSub.status).toBe(201);

      const afterSubJson = await (await realFetch(`${baseUrl}/account.json`, {
        headers: {Cookie: cookie},
      })).json() as {versions: Array<Record<string, unknown>>};
      expect(afterSubJson.versions).toHaveLength(1);
      expect(afterSubJson.versions[0].version).toBe('1.0.0');
      expect(afterSubJson.versions[0].authTokenEncoding).toBeUndefined();
      expect(afterSubJson.versions[0].url).toBeUndefined();
      expect(afterSubJson.versions[0].developerId).toBeUndefined();
      expect(afterSubJson.versions[0].notified).toBeUndefined();

      const headJson = await realFetch(`${baseUrl}/account.json`, {
        method: 'HEAD',
        headers: {Cookie: cookie},
      });
      expect(headJson.status).toBe(200);
      expect(await headJson.text()).toBe('');
    });
});
