import {execFileSync} from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import {chromium} from 'playwright-core';
import polka from 'polka';

import {COOLDOWN_SECONDS, Database, LADDERS_FILE} from '../db';
import * as account from '../server/account';
import * as arena from '../server/arena';
import * as auth from '../server/auth';
import * as discord from '../server/discord';
import {PUBLIC_DIR, renderArenaPages} from '../server/render';
import {clearReferencePoolCache} from '../server/teams';
import * as mock from '../tools/mock';
import {runPkmnCli} from '../tools/pkmn';

const E2E_AUTH: auth.Config = {
  sessionSecret: 'e2e-session-secret-32-bytes-minimum',
  arenaSecret: 'e2e-arena-hmac-secret-32-bytes-min',
  github: {
    clientId: 'e2e-github-client-id',
    clientSecret: 'e2e-github-client-secret',
  },
  discord: {
    clientId: '689315793569447954',
    clientSecret: 'e2e-discord-client-secret',
  },
};

const DISCORD_CONFIG: discord.Config = {
  guild: '689316505560809576',
  competitor: '1568629775122309210',
  staff: ['513513270670262284'],
  ladders: {},
};

const SHA_1 = '1'.repeat(64);
const SHA_2 = '2'.repeat(64);
const SHA_3 = '3'.repeat(64);
const SHA_4 = '4'.repeat(64);

function copyRootPublicAssets(srcPublic: string, dstPublic: string) {
  fs.mkdirSync(dstPublic, {recursive: true});
  if (!fs.existsSync(srcPublic)) return;
  for (const entry of fs.readdirSync(srcPublic, {withFileTypes: true})) {
    const srcPath = path.join(srcPublic, entry.name);
    const dstPath = path.join(dstPublic, entry.name);
    if (entry.isFile()) {
      fs.copyFileSync(srcPath, dstPath);
    } else if (
      entry.isDirectory() &&
      entry.name !== 'arena' &&
      entry.name !== 'projects' &&
      entry.name !== 'api'
    ) {
      fs.cpSync(srcPath, dstPath, {recursive: true});
    }
  }
  const viewerSrc = path.join(srcPublic, 'arena', 'viewer', 'index.html');
  if (fs.existsSync(viewerSrc)) {
    const viewerDst = path.join(dstPublic, 'arena', 'viewer', 'index.html');
    fs.mkdirSync(path.dirname(viewerDst), {recursive: true});
    fs.copyFileSync(viewerSrc, viewerDst);
  }
}

describe('Mock Arena VGC pseudo-blind-pair sampler & end-to-end lifecycle', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    clearReferencePoolCache();
  });

  test('samplePoolsPair enforces min >= 3, disjoint owners, and <= 1 of 40 teams',
    () => {
      const agent1Teams = mock.generateValidVgcTeams(20, 0);
      const agent2Teams = mock.generateValidVgcTeams(20, 1);
      const agent3Teams = mock.generateValidVgcTeams(20, 2);

      // With only 2 agents, sampling must reject when activeOwnsT1 is true (no 3rd-party team)
      const twoAgentPool = mock.buildCanonicalTeamPool([
        {agentId: 1, agentName: '0 ERROR', teams: agent1Teams},
        {agentId: 2, agentName: 'Foul Play', teams: agent2Teams},
      ]);
      expect(() => mock.samplePoolsPair(twoAgentPool, 1, 2, mock.createRng(1)))
        .toThrow(/Insufficient third-party teams in pool/);

      // Include a shared duplicate team between Agent 1 and Agent 2 + Agent 3's 20 teams
      const sharedTeam = agent1Teams[0];
      const threeAgentPool = mock.buildCanonicalTeamPool([
        {agentId: 1, agentName: '0 ERROR', teams: agent1Teams},
        {agentId: 2, agentName: 'Foul Play', teams: [sharedTeam, ...agent2Teams.slice(1)]},
        {agentId: 3, agentName: "Mew's Truck", teams: agent3Teams},
      ]);

      const byPacked = new Map(threeAgentPool.map(e => [e.canonicalPacked, e]));
      const rng = mock.createRng(42);
      for (let trial = 0; trial < 200; trial++) {
        const pair = mock.samplePoolsPair(threeAgentPool, 1, 2, rng);
        expect(pair.t1Packed).not.toBe(pair.t2Packed);

        const e1 = byPacked.get(pair.t1Packed)!;
        const e2 = byPacked.get(pair.t2Packed)!;
        expect(e1.speciesIds).not.toEqual(e2.speciesIds);

        // Neither team may be jointly owned by both active agents (1 & 2)
        expect(e1.owners.has(1) && e1.owners.has(2)).toBe(false);
        expect(e2.owners.has(1) && e2.owners.has(2)).toBe(false);

        // Disjoint owners between T1 and T2
        for (const owner of e1.owners.keys()) {
          expect(e2.owners.has(owner)).toBe(false);
        }

        // At most 1 of {T1, T2} belongs to the 40 teams submitted by Agent 1 and Agent 2 combined
        const activeCount =
          (e1.owners.has(1) || e1.owners.has(2) ? 1 : 0) +
          (e2.owners.has(1) || e2.owners.has(2) ? 1 : 0);
        expect(activeCount).toBeLessThanOrEqual(1);
      }
    });

  test('runs full server + MockArenaClient + Discord + rotation + 375px Playwright E2E flow',
    async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-e2e-'));
      const staticDir = path.join(tmpDir, 'static');
      const avatarsDir = path.join(staticDir, 'avatars');
      const publicDir = path.join(tmpDir, 'public');
      const poolDir = path.join(tmpDir, 'pool');
      const dbPath = path.join(tmpDir, 'arena.sqlite');
      fs.mkdirSync(poolDir, {recursive: true});
      copyRootPublicAssets(PUBLIC_DIR, publicDir);

      const projectsFile = mock.prepareMockStaticDir(staticDir, avatarsDir);
      let nowSec = 1_760_000_000;
      const db = new Database(dbPath, {now: nowSec});

      const discordCalls: Array<{method: string; url: string; body?: string}> = [];
      globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
        if (url.startsWith('https://discord.com/api/v10')) {
          const method = init?.method ?? 'GET';
          const body = typeof init?.body === 'string' ? init.body : undefined;
          discordCalls.push({method, url, ...(body ? {body} : {})});
          if (method === 'POST' && url.endsWith('/users/@me/channels')) {
            const parsed = JSON.parse(body ?? '{}') as {recipient_id?: string};
            return Promise.resolve(new Response(
              JSON.stringify({id: `dm-${parsed.recipient_id ?? 'unknown'}`}),
              {status: 200, headers: {'content-type': 'application/json'}}
            ));
          }
          if (method === 'POST' && url.endsWith('/messages')) {
            return Promise.resolve(new Response(
              JSON.stringify({id: `msg-${discordCalls.length}`}),
              {status: 200, headers: {'content-type': 'application/json'}}
            ));
          }
          return Promise.resolve(new Response(undefined, {status: 204}));
        }
        return realFetch(input, init);
      };

      db.syncLadders(LADDERS_FILE, nowSec);
      db.syncProjects(projectsFile, avatarsDir, nowSec);
      db.linkDeveloperDiscord('scheibo', '513513270670262284', 'scheibo', nowSec);
      db.linkDeveloperDiscord('pmariglia', '283674461268344832', 'pmariglia', nowSec);
      db.linkDeveloperDiscord('pkmnbotguy', '300000000000000002', 'batistas_dick', nowSec);
      db.linkDeveloperDiscord('asterdev', '300000000000000005', 'asterdev', nowSec);

      // Seed completed Tournament #1 + live Tournament #2 for static render coverage
      db.upsertTournament({
        id: '1',
        name: 'Spring ’26',
        format: 'gen9ou',
        gamesPerMatchup: 8,
        parallelTables: 2,
        hardware: 'GCP L4 Spot',
        status: 'completed',
        startsAt: nowSec - 86400,
        completedAt: nowSec - 3600,
      });
      db.upsertTournament({
        id: '2',
        name: 'Autumn ’26',
        format: 'gen9championsvgc2026regmc',
        gamesPerMatchup: 8,
        parallelTables: 2,
        hardware: 'GCP L4 Spot',
        status: 'running',
        startsAt: nowSec - 1800,
      });

      const app = polka();
      const authInstance = new auth.Auth({
        config: E2E_AUTH,
        db,
        isAuthorizedGitHub: login => db.getDeveloperByGitHub(login) !== undefined,
      });
      authInstance.register(app);

      const discordState = new Map<string, string | undefined>();
      const poolsByLadder = new Map<string, string[]>([
        ['gen9championsvgc2026regmc', [poolDir]],
        ['gen9championsvgc2027regma', [poolDir]],
      ]);

      account.register(app, {
        db,
        auth: authInstance,
        poolsByLadder,
        rateLimitMaxAttempts: 50,
        now: () => nowSec,
      });

      let statusQueue: Promise<unknown> = Promise.resolve();
      let autoRender = true;
      const arenaHandle = arena.register(app, {
        db,
        auth: authInstance,
        publicDir,
        now: () => nowSec,
        onSubmissionStatus: result => {
          statusQueue = statusQueue.then(async () => {
            await discord.notifySubmissionStatus(
              db, 'e2e-discord-token', DISCORD_CONFIG, result, discordState
            );
          });
          return statusQueue.then(() => undefined);
        },
        onUpdate: () => {
          if (autoRender) {
            renderArenaPages({db, publicDir, staticDir, avatarsDir, now: nowSec});
          }
        },
      });

      renderArenaPages({db, publicDir, staticDir, avatarsDir, now: nowSec});

      const server = http.createServer((req, res) => app.handler(req as polka.Request, res));
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const addr = server.address() as {port: number};
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      const githubIds: Record<string, number> = {
        scheibo: 1001,
        coauthor: 1002,
        pmariglia: 1003,
        pkmnbotguy: 1004,
        asterdev: 1005,
      };
      const cookieFor = (githubLogin: string, githubId?: number) => {
        const exp = Math.floor(Date.now() / 1000) + 3600;
        const id = githubId ?? githubIds[githubLogin] ?? 9999;
        const tok = auth.signToken(
          {github: {id, login: githubLogin}, exp},
          E2E_AUTH.sessionSecret
        );
        return `${auth.SESSION_COOKIE}=${encodeURIComponent(tok)}`;
      };

      try {
        // 1. Pre-launch: Qualified ('0 ERROR') & Pending ('AsterAI') have #submission disabled
        const preAccountRes = await realFetch(`${baseUrl}/account/`, {
          headers: {cookie: cookieFor('scheibo')},
        });
        expect(preAccountRes.status).toBe(200);
        const preAccountHtml = await preAccountRes.text();
        expect(preAccountHtml).toContain('Qualified');
        expect(preAccountHtml).toContain('<fieldset class="form-fieldset" disabled>');

        const pendingRes = await realFetch(`${baseUrl}/account/`, {
          headers: {cookie: cookieFor('asterdev')},
        });
        expect(await pendingRes.text()).toContain('Pending');

        // 2. Open RBY and VGC ladders via `pkmn` CLI -> Qualified transitions to Eligible
        await runPkmnCli(
          ['set-ladder-status', 'gen1ou20261109', 'active'],
          {db, publicDir, now: nowSec, log: () => undefined}
        );
        await runPkmnCli(
          ['set-ladder-status', 'gen9championsvgc2026regmc', 'active'],
          {db, publicDir, now: nowSec, log: () => undefined}
        );

        const eligibleHtml = await (await realFetch(`${baseUrl}/account/`, {
          headers: {cookie: cookieFor('scheibo')},
        })).text();
        expect(eligibleHtml).toContain('Eligible');

        // 3. Submit a smoke-failing version -> MockArenaClient fails it -> Discord DM sent ->
        //    cooldown is NOT triggered so 0 ERROR can immediately submit 1.0.0!
        const submitJson = async (login: string, payload: object) =>
          realFetch(`${baseUrl}/api/submissions`, {
            method: 'POST',
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
              cookie: cookieFor(login),
            },
            body: JSON.stringify(payload),
          });

        const badSubRes = await submitJson('scheibo', {
          version: '0.1.0-bad',
          package: 'bundle',
          url: 'https://r2.example.com/0-error-bad.tar.zst',
          sha256: SHA_1,
          ladders: ['gen1ou20261109'],
        });
        expect(badSubRes.status).toBe(201);

        let nextSmokeMode: 'passed' | 'failed' = 'failed';
        const mockArena = new mock.MockArenaClient({
          serverUrl: baseUrl,
          arenaSecret: E2E_AUTH.arenaSecret!,
          now: () => nowSec,
          decideSmoke: sub => ({
            smokeStatus: nextSmokeMode,
            smokeError: nextSmokeMode === 'failed'
              ? `Boot failure in ${sub.version}`
              : undefined,
          }),
        });

        expect(await mockArena.syncPendingSubmissions()).toBe(1);
        await statusQueue;

        const failedRow = db.getVersionBySlugAndLabel('0-error', '0.1.0-bad')!;
        expect(failedRow.smokeStatus).toBe('failed');
        expect(failedRow.notified).toBe(true);
        expect(discordCalls.some(c => c.url.includes('/channels/dm-513513270670262284/messages')))
          .toBe(true);

        const afterFailHtml = await (await realFetch(`${baseUrl}/account/`, {
          headers: {cookie: cookieFor('scheibo')},
        })).text();
        expect(afterFailHtml).toContain('(DM sent)');
        expect(afterFailHtml).toContain('Eligible');

        // 4. Submit 0 ERROR 1.0.0 + Foul Play 1.0.0 with 20 valid VGC teams + encrypted token
        nextSmokeMode = 'passed';
        const subZero100 = await submitJson('scheibo', {
          version: '1.0.0',
          package: 'bundle',
          url: 'https://r2.example.com/0-error-1.0.0.tar.zst',
          sha256: SHA_1,
          authToken: 'Bearer private-r2-token',
          ladders: ['gen1ou20261109', 'gen9championsvgc2026regmc'],
          teams: mock.generateValidVgcTeams(20, 0),
        });
        expect(subZero100.status).toBe(201);

        const subFp100 = await submitJson('pmariglia', {
          version: '1.0.0',
          package: 'bundle',
          url: 'https://r2.example.com/foul-play-1.0.0.tar.zst',
          sha256: SHA_2,
          ladders: ['gen1ou20261109', 'gen9championsvgc2026regmc'],
          teams: mock.generateValidVgcTeams(20, 1),
        });
        expect(subFp100.status).toBe(201);

        // Verify pending-submissions decrypts authToken once, then submission-status wipes it
        const pendingCheck = await realFetch(`${baseUrl}/api/arena/pending-submissions`, {
          headers: {authorization: `Bearer ${E2E_AUTH.arenaSecret}`},
        });
        const pendingData = await pendingCheck.json() as {
          submissions: Array<{agentSlug: string; authToken?: string}>;
        };
        expect(pendingData.submissions.find(s => s.agentSlug === '0-error')?.authToken)
          .toBe('Bearer private-r2-token');

        expect(await mockArena.syncPendingSubmissions()).toBe(2);
        expect(db.getVersionBySlugAndLabel('0-error', '1.0.0')?.authTokenEncoding).toBeUndefined();

        // With only 2 agents on VGC (min = 3), VGC refuses to schedule while RBY schedules!
        expect(await mockArena.playMatchStep({ladderId: 'gen9championsvgc2026regmc'}))
          .toBeUndefined();
        const rbyStep = await mockArena.playMatchStep({ladderId: 'gen1ou20261109'});
        expect(rbyStep?.ladderId).toBe('gen1ou20261109');

        // 5. Submit 3rd VGC agent (Mew's Truck 1.0.0) -> VGC min=3 satisfied -> matches run!
        const subMt100 = await submitJson('pkmnbotguy', {
          version: '1.0.0',
          package: 'bundle',
          url: 'https://r2.example.com/mews-truck-1.0.0.tar.zst',
          sha256: SHA_3,
          ladders: ['gen9championsvgc2026regmc'],
          teams: mock.generateValidVgcTeams(20, 2),
        });
        expect(subMt100.status).toBe(201);
        expect(await mockArena.syncPendingSubmissions()).toBe(1);

        const vgcStep = await mockArena.playMatchStep({ladderId: 'gen9championsvgc2026regmc'});
        expect(vgcStep?.ladderId).toBe('gen9championsvgc2026regmc');
        expect(vgcStep?.p1TeamLabel).toMatch(/Team #\d+/);
        expect(vgcStep?.p2TeamLabel).toMatch(/Team #\d+/);

        // 6. Set anchor on RBY & VGC, settle all entries, upgrade 0 ERROR -> 1.1.0 -> 1.2.0
        await runPkmnCli(
          ['set-anchor', 'gen1ou20261109', 'foul-play', '1.0.0'],
          {db, publicDir, now: nowSec, log: () => undefined}
        );
        await runPkmnCli(
          ['set-anchor', 'gen9championsvgc2026regmc', 'foul-play', '1.0.0'],
          {db, publicDir, now: nowSec, log: () => undefined}
        );
        mockArena.setAnchor('gen1ou20261109', 'foul-play', '1.0.0');
        mockArena.setAnchor('gen9championsvgc2026regmc', 'foul-play', '1.0.0');

        const settleLadder = async (ladderId: string, emitFinalHeartbeat = false) => {
          autoRender = false;
          for (let step = 0; step < 250; step++) {
            const unsettled = db.getLeaderboardEntries(ladderId)
              .filter(e => e.role !== 'retired' && e.settledAt === undefined);
            if (unsettled.length === 0) break;
            nowSec += 600;
            await mockArena.playMatchStep({ladderId, emitHeartbeats: false});
          }
          if (emitFinalHeartbeat) {
            autoRender = true;
            nowSec += 600;
            await mockArena.playMatchStep({ladderId, emitHeartbeats: true});
          }
          autoRender = true;
        };

        await settleLadder('gen1ou20261109', true);
        await settleLadder('gen9championsvgc2026regmc', false);

        // Advance past 14-day cooldown -> submit 1.1.0 WITHOUT resending VGC teams!
        nowSec += COOLDOWN_SECONDS + 3600;
        const subZero110 = await submitJson('scheibo', {
          version: '1.1.0',
          package: 'bundle',
          url: 'https://r2.example.com/0-error-1.1.0.tar.zst',
          sha256: SHA_2,
          ladders: ['gen1ou20261109', 'gen9championsvgc2026regmc'],
        });
        expect(subZero110.status).toBe(201);
        expect(await mockArena.syncPendingSubmissions()).toBe(1);

        await settleLadder('gen1ou20261109', false);
        await settleLadder('gen9championsvgc2026regmc', false);

        // Advance past 14-day cooldown -> submit 1.2.0 on RBY -> retires weaker of {1.0.0, 1.1.0}
        nowSec += COOLDOWN_SECONDS + 3600;
        const subZero120 = await submitJson('scheibo', {
          version: '1.2.0',
          package: 'bundle',
          url: 'https://r2.example.com/0-error-1.2.0.tar.zst',
          sha256: SHA_4,
          ladders: ['gen1ou20261109'],
        });
        expect(subZero120.status).toBe(201);
        expect(await mockArena.syncPendingSubmissions()).toBe(1);

        const rbyEntries = db.getLeaderboardEntries('gen1ou20261109')
          .filter(e => e.agentSlug === '0-error');
        expect(rbyEntries.filter(e => e.role !== 'retired')).toHaveLength(2);
        expect(rbyEntries.filter(e => e.role === 'retired')).toHaveLength(1);

        // Settle 1.2.0 on RBY and verify Discord Competitor + settled #1 RBY role sync
        await settleLadder('gen1ou20261109', false);
        renderArenaPages({db, publicDir, staticDir, avatarsDir, now: nowSec});

        const guildMembers: discord.GuildMember[] = [
          {user: {id: '513513270670262284', username: 'scheibo'}, roles: []},
          {user: {id: '283674461268344832', username: 'pmariglia'}, roles: []},
          {user: {id: '300000000000000002', username: 'batistas_dick'}, roles: []},
          {user: {id: '300000000000000005', username: 'asterdev'}, roles: []},
        ];
        discordCalls.length = 0;
        await discord.syncArenaRoles(
          db, 'e2e-discord-token', DISCORD_CONFIG, discordState, guildMembers
        );

        // Qualified devs get Competitor; Pending dev ('asterdev') does NOT
        expect(guildMembers.find(m => m.user.username === 'scheibo')?.roles)
          .toContain('1568629775122309210');
        expect(guildMembers.find(m => m.user.username === 'asterdev')?.roles)
          .not.toContain('1568629775122309210');
        // Settled #1 on RBY receives RBY role 1563716887131459685
        const rbyLeader = db.getArenaLadderRoleTargets().find(t => t.slot === 'rby')!;
        expect(rbyLeader.discordIds.length).toBeGreaterThan(0);
        for (const holderId of rbyLeader.discordIds) {
          expect(guildMembers.find(m => m.user.id === holderId)?.roles)
            .toContain('1563716887131459685');
        }

        // 7. Seasonal VGC rotation: submit unsettled Foul Play 1.1.0 on VGC -> rotate-ladder ->
        //    old VGC enters 'settling', new VGC becomes 'active' -> settle -> auto-'archived'!
        const subFp110 = await submitJson('pmariglia', {
          version: '1.1.0',
          package: 'bundle',
          url: 'https://r2.example.com/foul-play-1.1.0.tar.zst',
          sha256: SHA_4,
          ladders: ['gen9championsvgc2026regmc'],
        });
        expect(subFp110.status).toBe(201);
        expect(await mockArena.syncPendingSubmissions()).toBe(1);

        await runPkmnCli(
          [
            'rotate-ladder',
            'gen9championsvgc2026regmc',
            '--name',
            'VGC 2026 Reg M-C',
            '--new',
            'gen9championsvgc2027regma',
            '--new-name',
            'VGC',
            '--format',
            'gen9championsvgc2026regmc',
          ],
          {db, publicDir, now: nowSec, log: () => undefined}
        );

        expect(db.getLadder('gen9championsvgc2026regmc')?.status).toBe('settling');
        expect(db.getLadder('gen9championsvgc2027regma')?.status).toBe('active');
        expect(db.getLadder('gen9championsvgc2027regma')?.discord)
          .toBe('1564121375558340768');

        // Refresh MockArenaClient ladder metadata, then play settling VGC matches until archived
        await mockArena.syncPendingSubmissions();
        let archived = false;
        autoRender = false;
        for (let i = 0; i < 200 && !archived; i++) {
          nowSec += 600;
          const step = await mockArena.playMatchStep({
            ladderId: 'gen9championsvgc2026regmc',
            emitHeartbeats: false,
          });
          if (step?.archivedLadder) archived = true;
        }
        autoRender = true;
        renderArenaPages({db, publicDir, staticDir, avatarsDir, now: nowSec});
        expect(archived).toBe(true);
        expect(db.getLadder('gen9championsvgc2026regmc')?.status).toBe('archived');

        // 8. Auto-quarantine Mew's Truck 1.0.0 -> DMs owner & staff
        const mtVer = db.getVersionBySlugAndLabel('mews-truck', '1.0.0')!;
        discordCalls.length = 0;
        await mockArena.quarantineVersion(mtVer.id, 'Crashed in 5 consecutive games');
        await statusQueue;
        expect(db.getVersionById(mtVer.id)?.smokeStatus).toBe('quarantined');
        expect(db.getVersionById(mtVer.id)?.notified).toBe(true);
        expect(discordCalls.some(c => c.url.includes('/channels/dm-300000000000000002/messages')))
          .toBe(true);
        expect(discordCalls.some(c => c.url.includes('/channels/dm-513513270670262284/messages')))
          .toBe(true);

        // 9. Seed full mock fixture + run `hyperlink --check-anchors` + 375px Playwright checks
        const seedDb = new Database(':memory:', {now: nowSec});
        const viewPublicDir = path.join(tmpDir, 'views-public');
        copyRootPublicAssets(PUBLIC_DIR, viewPublicDir);
        try {
          mock.seedMockArena({
            db: seedDb,
            publicDir: viewPublicDir,
            staticDir,
            avatarsDir,
            now: nowSec,
            render: true,
          });
          // Stub /account/index.html strictly for static hyperlink anchor check
          fs.mkdirSync(path.join(viewPublicDir, 'account'), {recursive: true});
          fs.writeFileSync(path.join(viewPublicDir, 'account', 'index.html'), '');

          const hyperlinkBin = path.join(process.cwd(), 'node_modules', '.bin', 'hyperlink');
          const linkOut = execFileSync(hyperlinkBin, [viewPublicDir, '--check-anchors'], {
            encoding: 'utf8',
          });
          expect(linkOut).toContain('Found 0 bad links');
          expect(linkOut).toContain('Found 0 bad anchors');

          const browser = await chromium.launch({args: ['--disable-gpu']});
          try {
            const pathsToVerify = [
              '/arena/',
              '/arena/ladders/rby/',
              '/arena/ladders/vgc/',
              '/arena/tournaments/1/',
              '/arena/tournaments/2/',
              '/arena/battles/',
              '/projects/',
              '/projects/0-error/',
              '/account/',
            ];

            for (const theme of ['light', 'dark'] as const) {
              const context = await browser.newContext({
                viewport: {width: 375, height: 667},
                colorScheme: theme,
                baseURL: 'http://pkmn.test',
              });
              await context.route('**/*', async route => {
                const u = new URL(route.request().url());
                if (u.origin !== 'http://pkmn.test') {
                  await route.fulfill({status: 204, body: ''});
                  return;
                }
                if (u.pathname === '/account' || u.pathname.startsWith('/account/')) {
                  const r = await realFetch(`${baseUrl}${u.pathname}${u.search}`, {
                    headers: {cookie: cookieFor('scheibo')},
                  });
                  await route.fulfill({
                    status: r.status,
                    contentType: 'text/html; charset=utf-8',
                    body: await r.text(),
                  });
                  return;
                }
                const clean = decodeURIComponent(u.pathname);
                const candidate = path.resolve(viewPublicDir, `.${clean}`);
                if (fs.existsSync(candidate)) {
                  const st = fs.statSync(candidate);
                  const file = st.isDirectory() ? path.join(candidate, 'index.html') : candidate;
                  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
                    await route.fulfill({path: file});
                    return;
                  }
                }
                await route.fulfill({status: 404, body: 'Not Found'});
              });

              const page = await context.newPage();
              const pageErrors: string[] = [];
              page.on('pageerror', err => pageErrors.push(err.message));
              page.on('console', msg => {
                if (msg.type() === 'error') pageErrors.push(msg.text());
              });

              for (const p of pathsToVerify) {
                await page.goto(p);
                await page.waitForLoadState('networkidle');
                const overflow = await page.evaluate<number>(
                  'document.documentElement.scrollWidth - window.innerWidth'
                );
                expect({path: p, theme, overflow}).toEqual({
                  path: p,
                  theme,
                  overflow: expect.any(Number),
                });
                expect(overflow).toBeLessThanOrEqual(0);
              }
              expect(pageErrors).toEqual([]);
              await context.close();
            }
          } finally {
            await browser.close();
          }
        } finally {
          seedDb.close();
        }
      } finally {
        arenaHandle.close();
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        db.close();
        fs.rmSync(tmpDir, {recursive: true, force: true});
      }
    },
    30_000);
});
