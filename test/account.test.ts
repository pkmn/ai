import {execFileSync} from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import polka from 'polka';

import {ArenaDB, COOLDOWN_S} from '../db';
import * as account from '../server/account';
import {decryptSecret, deduceFormatType, encryptSecret} from '../server/account';
import {Auth, type AuthConfig, SESSION_COOKIE, signToken} from '../server/auth';
import {clearReferencePoolCache, splitSubmittedTeams} from '../server/teams';
import * as wiki from '../server/wiki';
import {getDex} from '../teams';

const AUTH_CFG: AuthConfig = {
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

const LEGAL_VGC_SPECIES = [
  'Archaludon', 'Farigiraf', 'Garchomp', 'Golisopod', 'Incineroar', 'Politoed',
  'Indeedee-F', 'Annihilape', 'Arcanine-Hisui', 'Meowstic-F', 'Torkoal', 'Raichu',
  'Basculegion', 'Gholdengo', 'Rillaboom', 'Staraptor', 'Volcarona', 'Salamence',
  'Kingambit', 'Sneasler', 'Sylveon', 'Delphox', 'Metagross', 'Gengar',
  'Altaria', 'Milotic', 'Tsareena', 'Sableye',
];

const LEGAL_ITEMS = [
  'Leftovers', 'Sitrus Berry', 'Choice Scarf', 'Focus Sash',
  'Life Orb', 'Lum Berry',
];

function makeSetPaste(speciesName: string, item: string): string {
  const dex = getDex('gen9championsvgc2026regmc');
  const sp = dex.species.get(speciesName);
  const ability = sp.abilities['0'];
  const moves = ['Protect', 'Substitute', 'Rest', 'Sleep Talk'];
  return [
    `${sp.name} @ ${item}`,
    `Ability: ${ability}`,
    'Level: 50',
    'EVs: 252 HP / 4 Def / 252 Spe',
    'Timid Nature',
    ...moves.map(m => `- ${m}`),
  ].join('\n');
}

function makeSixMonPaste(indices: number[]): string {
  return indices
    .map((spIdx, slot) => makeSetPaste(LEGAL_VGC_SPECIES[spIdx], LEGAL_ITEMS[slot]))
    .join('\n\n');
}

function generateDistinctVgcTeams(count: number): string[] {
  const offsets = [0, 1, 3, 7, 13, 19];
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const idxs = offsets.map(off => (i + off) % LEGAL_VGC_SPECIES.length);
    out.push(makeSixMonPaste(idxs));
  }
  return out;
}

describe('submission helpers & secret encryption', () => {
  test('deduceFormatType distinguishes native archive bundles from OCI refs', () => {
    expect(deduceFormatType('https://example.com/bot.tar.gz?sig=1')).toBe('bundle');
    expect(deduceFormatType('https://example.com/bot.tgz')).toBe('bundle');
    expect(deduceFormatType('https://example.com/bot.tar.xz')).toBe('bundle');
    expect(deduceFormatType('https://example.com/bot.txz')).toBe('bundle');
    expect(deduceFormatType('https://example.com/bot.tar.zst')).toBe('bundle');
    expect(deduceFormatType('https://example.com/bot.tzst')).toBe('bundle');
    expect(deduceFormatType('ghcr.io/pkmn/0-error:1.2.0')).toBe('oci');
    expect(deduceFormatType('docker.io/library/bot@sha256:' + SHA_A)).toBe('oci');
  });

  test('encryptSecret and decryptSecret roundtrip and reject tampering', () => {
    const enc = encryptSecret('Bearer ghp_secret123', 'session-secret-1');
    expect(enc).not.toContain('ghp_secret123');
    expect(decryptSecret(enc, 'session-secret-1')).toBe('Bearer ghp_secret123');
    expect(() => decryptSecret(enc, 'wrong-secret')).toThrow();
    expect(() => decryptSecret(`${enc}x`, 'session-secret-1')).toThrow();
  });

  test('splitSubmittedTeams supports === headers, arrays, and 6-block pastes', () => {
    const twoTeams = generateDistinctVgcTeams(2);
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
  let db: ArenaDB;
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

    const twentyOne = generateDistinctVgcTeams(21);
    fs.writeFileSync(path.join(poolDir, 'public000001'), twentyOne[20], 'utf8');

    currentNow = 1_760_000_000;
    db = new ArenaDB(':memory:');
    db.syncLadders(); // starts all 5 ladders in 'upcoming' status
    db.syncProjectsFromYaml(PROJECTS_YAML, path.join(tmpDir, 'avatars'), currentNow);
    db.linkDeveloperDiscord('pre', '513513270670262284', 'scheibo', currentNow);

    const wikiInstance = new wiki.Wiki({
      wikiDir,
      projectsFile,
      db,
      auth: new Auth({
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
      poolDirsByLadder: new Map([['gen9championsvgc2026regmc', [poolDir]]]),
      now: () => currentNow,
    });
    wiki.register(app, {
      wikiDir,
      projectsFile,
      auth: wikiInstance.auth,
      db,
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
    db.close();
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  const cookieFor = (login: string) => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const tok = signToken({github: {id: 1, login}, exp}, AUTH_CFG.sessionSecret);
    return `${SESSION_COOKIE}=${encodeURIComponent(tok)}`;
  };

  test('models Pending -> Qualified -> Eligible lifecycle & wiki access for Pending', async () => {
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
    //    - 'pre' (qualified: true) sees Status: Qualified + disabled fieldset
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
    const preClosedHtml = await prePreLaunch.text();
    expect(preClosedHtml).toContain('>Qualified<');
    expect(preClosedHtml).toContain('<fieldset class="form-fieldset" disabled>');

    // Submitting while Qualified (before ladders open) returns 403
    const prematureSub = await realFetch(`${baseUrl}/api/submissions`, {
      method: 'POST',
      headers: {
        Cookie: cookieFor('pre'),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        version: '1.0.0',
        format_type: 'bundle',
        download_url: 'https://example.com/0-error-1.0.0.tar.zst',
        sha256: SHA_A,
        ladders: ['RBY'],
      }),
    });
    expect(prematureSub.status).toBe(403);

    // Pending developer ('rookie') CAN edit the wiki even before qualification!
    const wikiSave = await realFetch(`${baseUrl}/wiki/Newcomer`, {
      method: 'POST',
      headers: {
        Cookie: cookieFor('rookie'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        content: '# Newcomer\n\nWork in progress.',
        message: 'Initial bot notes',
        action: 'save',
      }).toString(),
      redirect: 'manual',
    });
    expect(wikiSave.status).toBe(303);

    // 2. Bring RBY and SV online while ADV/RAND/VGC stay 'upcoming':
    //    - 'rookie' stays Pending (still disabled, 403 on submit)
    //    - 'pre' becomes Eligible (fieldset enabled; ADV checkbox remains disabled!)
    openLadders(['gen1ou20261109', 'gen9ou20261109']);

    const rookieAfterOpen = await realFetch(`${baseUrl}/account`, {
      headers: {Cookie: cookieFor('rookie')},
    });
    const rookieOpenHtml = await rookieAfterOpen.text();
    expect(rookieOpenHtml).toContain('>Pending<');
    expect(rookieOpenHtml).toContain('<fieldset class="form-fieldset" disabled>');

    const rookieBlockedSub = await realFetch(`${baseUrl}/api/submissions`, {
      method: 'POST',
      headers: {
        Cookie: cookieFor('rookie'),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        version: '0.1.0',
        format_type: 'bundle',
        download_url: 'https://example.com/newcomer.tar.zst',
        sha256: SHA_A,
        ladders: ['RBY'],
      }),
    });
    expect(rookieBlockedSub.status).toBe(403);

    const preOpen = await realFetch(`${baseUrl}/account`, {
      headers: {Cookie: cookieFor('pre')},
    });
    const preOpenHtml = await preOpen.text();
    expect(preOpenHtml).toContain('>Eligible<');
    expect(preOpenHtml).not.toContain('<fieldset class="form-fieldset" disabled>');
    expect(preOpenHtml).toContain('value="gen3ou20261109" disabled');

    // Submitting to an 'upcoming' ladder (ADV) is rejected with 400
    const upcomingLadderSub = await realFetch(`${baseUrl}/api/submissions`, {
      method: 'POST',
      headers: {
        Cookie: cookieFor('pre'),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        version: '1.0.0',
        format_type: 'bundle',
        download_url: 'https://example.com/0-error.tar.zst',
        sha256: SHA_A,
        ladders: ['ADV'],
      }),
    });
    expect(upcomingLadderSub.status).toBe(400);
  });

  test('scopes Discord per developer while sharing Active and History tables', async () => {
    openLadders(['gen1ou20261109', 'gen3ou20261109']);
    const bot = db.getBotBySlug('0-error')!;

    const v1 = db.createSubmission({
      botId: bot.id,
      submittedByDevId: db.getDeveloperByGitHub('pre')!.id,
      versionStr: '1.0.0',
      formatType: 'bundle',
      downloadUrl: 'https://example.com/0-error-1.0.0.tar.zst',
      sha256: SHA_A,
      authTokenEnc: null,
      ladderIds: ['gen1ou20261109', 'gen3ou20261109'],
      now: currentNow - 40 * 86400,
    });
    db.db.prepare(
      `UPDATE bot_versions
       SET smoke_status = 'passed', unpacked_bytes = 276824064,
           smoke_duration_ms = 3800, smoke_turn_ms = 375, smoke_peak_ram_mb = 930
       WHERE id = ?`
    ).run(v1.id);
    db.db.prepare(
      `INSERT INTO ladder_entries (
         ladder_id, version_id, role, rating_elo, rating_se, rank_current,
         matches_played, ww, wt, split, tl, ll, settled_at
       ) VALUES (?, ?, 'retired', 1650, 22, NULL, 60, 30, 0, 15, 0, 15, ?)`
    ).run('gen1ou20261109', v1.id, currentNow - 30 * 86400);

    const vFail = db.createSubmission({
      botId: bot.id,
      submittedByDevId: db.getDeveloperByGitHub('pre')!.id,
      versionStr: '1.1.0-rc1',
      formatType: 'bundle',
      downloadUrl: 'https://example.com/0-error-1.1.0-rc1.tar.zst',
      sha256: SHA_B,
      authTokenEnc: null,
      ladderIds: ['gen1ou20261109'],
      now: currentNow - 20 * 86400,
    });
    db.db.prepare(
      `UPDATE bot_versions
       SET smoke_status = 'failed_smoke_test', dm_sent = 1,
           smoke_error_log = 'Seatbelt EPERM: denied read outside $BOT_DIR'
       WHERE id = ?`
    ).run(vFail.id);

    const v2 = db.createSubmission({
      botId: bot.id,
      submittedByDevId: db.getDeveloperByGitHub('coauthor')!.id,
      versionStr: '1.1.0',
      formatType: 'bundle',
      downloadUrl: 'https://example.com/0-error-1.1.0.tar.zst',
      sha256: SHA_A,
      authTokenEnc: null,
      ladderIds: ['gen1ou20261109', 'gen3ou20261109'],
      now: currentNow - 16 * 86400,
    });
    db.db.prepare(
      `UPDATE bot_versions
       SET smoke_status = 'passed', unpacked_bytes = 312475648,
           smoke_duration_ms = 4100, smoke_turn_ms = 402, smoke_peak_ram_mb = 1140
       WHERE id = ?`
    ).run(v2.id);
    db.db.prepare(
      `INSERT INTO ladder_entries (
         ladder_id, version_id, role, rating_elo, rating_se, rank_current,
         matches_played, ww, wt, split, tl, ll, settled_at
       ) VALUES (?, ?, 'champion', 1748, 14.3, 1, 180, 118, 0, 38, 0, 24, ?)`
    ).run('gen1ou20261109', v2.id, currentNow - 10 * 86400);

    const preHtml = await (await realFetch(`${baseUrl}/account`, {
      headers: {Cookie: cookieFor('pre')},
    })).text();
    expect(preHtml).toContain('<strong>pre</strong>');
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
    const bot = db.getBotBySlug('foul-play')!;
    expect(db.computeBotSubmissionStatus(bot.id, currentNow).label).toBe('Eligible');

    const badVer = await realFetch(`${baseUrl}/api/submissions`, {
      method: 'POST',
      headers: {
        Cookie: cookieFor('pmariglia'),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        version: 'bad version string!!',
        format_type: 'bundle',
        download_url: 'https://example.com/fp.tar.xz',
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
        format_type: 'oci',
        download_url: 'https://example.com/fp.tar.xz',
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
        format_type: 'oci',
        download_url: 'ghcr.io/pmariglia/foul-play:1.0.0',
        sha256: SHA_A.toUpperCase(),
        auth_token: 'Bearer ghcr_pat_123',
        ladders: ['RBY', 'SV'],
      }),
    });
    expect(okSub.status).toBe(201);
    const createdJson = await okSub.json() as {version_id: number; smoke_status: string};
    expect(createdJson.smoke_status).toBe('pending_pull');

    const stored = db.getVersionsForBot(bot.id)[0];
    expect(stored.sha256).toBe(SHA_A);
    expect(JSON.parse(stored.ladders_json)).toEqual(['gen1ou20261109', 'gen9ou20261109']);
    expect(decryptSecret(stored.auth_token_enc!, AUTH_CFG.sessionSecret)).toBe(
      'Bearer ghcr_pat_123'
    );

    // While pending_pull -> status is Ineligible (429 on second submit)
    expect(db.computeBotSubmissionStatus(bot.id, currentNow).label).toBe('Ineligible');
    const blockedPending = await realFetch(`${baseUrl}/api/submissions`, {
      method: 'POST',
      headers: {
        Cookie: cookieFor('pmariglia'),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        version: '1.0.1',
        format_type: 'oci',
        download_url: 'ghcr.io/pmariglia/foul-play:1.0.1',
        sha256: SHA_B,
        ladders: ['RBY'],
      }),
    });
    expect(blockedPending.status).toBe(429);

    // Failed smoke test automatically refunds cooldown -> Eligible again immediately!
    db.db.prepare("UPDATE bot_versions SET smoke_status = 'failed_smoke_test' WHERE id = ?")
      .run(stored.id);
    expect(db.computeBotSubmissionStatus(bot.id, currentNow).label).toBe('Eligible');

    // Passed smoke test -> triggers 14-day cooldown + unsettled gate
    db.db.prepare("UPDATE bot_versions SET smoke_status = 'passed' WHERE id = ?")
      .run(stored.id);
    db.db.prepare(
      `INSERT INTO ladder_entries (
         ladder_id, version_id, role, rating_elo, rating_se, matches_played
       ) VALUES ('gen1ou20261109', ?, 'champion', 1550, 85, 10)`
    ).run(stored.id);

    expect(db.computeBotSubmissionStatus(bot.id, currentNow + 86400).label).toBe('Ineligible');

    currentNow += COOLDOWN_S + 60;
    const unsettledStatus = db.computeBotSubmissionStatus(bot.id, currentNow);
    expect(unsettledStatus.canSubmit).toBe(false);
    expect(unsettledStatus.reason).toContain('has not settled');

    db.db.prepare(
      'UPDATE ladder_entries SET rating_se = 24, matches_played = 30 WHERE version_id = ?'
    ).run(stored.id);
    expect(db.computeBotSubmissionStatus(bot.id, currentNow)).toEqual({
      label: 'Eligible',
      canSubmit: true,
    });
  });

  test('validates VGC 20-team submissions sequentially and locks seasonal pools', async () => {
    openLadders(['gen9championsvgc2026regmc']);
    const twentyOne = generateDistinctVgcTeams(21);
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
          format_type: 'bundle',
          download_url: `https://example.com/0-error-${version}.tar.zst`,
          sha256: SHA_A,
          ladders: ['VGC'],
          ...(teams !== undefined ? {teams} : {}),
        }),
      });

    const missingRes = await postVgc('1.0.0');
    expect(missingRes.status).toBe(400);
    expect((await missingRes.json() as {error: string}).error).toContain('requires 20 valid teams');

    const wrongCount = await postVgc('1.0.0', validTwenty.slice(0, 19));
    expect(wrongCount.status).toBe(400);
    expect((await wrongCount.json() as {error: string}).error).toContain(
      'Expected 20 teams for gen9championsvgc2026regmc, received 19'
    );

    const withIllegal = [...validTwenty];
    withIllegal[4] = validTwenty[4].replace(/^[A-Za-z-]+ @/, 'Mewtwo @');
    const illegalRes = await postVgc('1.0.0', withIllegal);
    expect(illegalRes.status).toBe(400);
    expect((await illegalRes.json() as {error: string}).error).toContain('Team #5');

    const withPublicClone = [...validTwenty];
    withPublicClone[2] = publicClone;
    const pubCloneRes = await postVgc('1.0.0', withPublicClone);
    expect(pubCloneRes.status).toBe(400);
    const pubErr = (await pubCloneRes.json() as {error: string}).error;
    expect(pubErr).toContain('Team #3 failed uniqueness check');
    expect(pubErr).toContain('closest=public000001');

    const withSelfClone = [...validTwenty];
    withSelfClone[7] = validTwenty[1];
    const selfCloneRes = await postVgc('1.0.0', withSelfClone);
    expect(selfCloneRes.status).toBe(400);
    const selfErr = (await selfCloneRes.json() as {error: string}).error;
    expect(selfErr).toContain('Team #8 failed uniqueness check');
    expect(selfErr).toContain('closest=submitted-team-2');

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

    const bot = db.getBotBySlug('0-error')!;
    const pendingTeams = db.getTeamsForBotLadder('gen9championsvgc2026regmc', bot.id, 'pending');
    expect(pendingTeams).toHaveLength(20);

    const v1 = db.getVersionsForBot(bot.id)[0];
    db.db.prepare("UPDATE bot_versions SET smoke_status = 'passed' WHERE id = ?").run(v1.id);
    db.db.prepare(
      `UPDATE bot_ladder_teams SET status = 'active'
       WHERE ladder_id = 'gen9championsvgc2026regmc' AND bot_id = ?`
    ).run(bot.id);
    db.db.prepare(
      `INSERT INTO ladder_entries (
         ladder_id, version_id, role, rating_elo, rating_se, matches_played, settled_at
       ) VALUES ('gen9championsvgc2026regmc', ?, 'champion', 1620, 20, 35, ?)`
    ).run(v1.id, currentNow + 86400);
    currentNow += COOLDOWN_S + 3600;

    const overwriteAttempt = await postVgc('1.1.0', backupPaste);
    expect(overwriteAttempt.status).toBe(400);
    expect((await overwriteAttempt.json() as {error: string}).error).toContain('already locked');

    const reuseOk = await postVgc('1.1.0');
    expect(reuseOk.status).toBe(201);
    expect(db.getTeamsForBotLadder('gen9championsvgc2026regmc', bot.id, 'active')).toHaveLength(20);
  });
});
