import {execFileSync} from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import {chromium} from 'playwright-core';
import polka from 'polka';

import {Database} from '../db';
import * as account from '../server/account';
import * as arena from '../server/arena';
import * as auth from '../server/auth';
import * as discord from '../server/discord';
import * as render from '../server/render';
import * as teams from '../server/teams';
import {root} from '../static/util';
import * as mock from '../tools/mock';

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

describe('Declarative Mock Arena scenarios, probabilistic ratings & E2E lifecycle', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    teams.clearReferencePoolCache();
  });

  test('samplePoolsPair enforces min >= 4, <= 1 of 40 active teams, and exact 2/N uniformity',
    () => {
      const agent1Teams = mock.generateValidVgcTeams(20, 0);
      const agent2Teams = mock.generateValidVgcTeams(20, 1);
      const agent3Teams = mock.generateValidVgcTeams(20, 2);
      const agent4Teams = mock.generateValidVgcTeams(20, 3);

      // With < 4 distinct agent pools (2 or 3 agents), sampling must reject
      const twoAgentPool = teams.buildCanonicalTeamPool([
        {agentId: 1, agentName: '0 ERROR', teams: agent1Teams},
        {agentId: 2, agentName: 'Foul Play', teams: agent2Teams},
      ]);
      expect(() => teams.samplePoolsPair(twoAgentPool, 1, 2, mock.createRng(1)))
        .toThrow(/min >= 4/);

      const threeAgentPool = teams.buildCanonicalTeamPool([
        {agentId: 1, agentName: '0 ERROR', teams: agent1Teams},
        {agentId: 2, agentName: 'Foul Play', teams: agent2Teams},
        {agentId: 3, agentName: 'Mew\'s Truck', teams: agent3Teams},
      ]);
      expect(() => teams.samplePoolsPair(threeAgentPool, 1, 2, mock.createRng(1)))
        .toThrow(/min >= 4/);

      // Include cross-competitor duplicates (1 & 2 share team #0; 1 & 3 share team #1)
      const fourAgentPool = teams.buildCanonicalTeamPool([
        {agentId: 1, agentName: '0 ERROR', teams: agent1Teams},
        {agentId: 2, agentName: 'Foul Play', teams: [agent1Teams[0], ...agent2Teams.slice(1)]},
        {agentId: 3, agentName: 'Mew\'s Truck', teams: [agent1Teams[1], ...agent3Teams.slice(1)]},
        {agentId: 4, agentName: 'Metamon', teams: agent4Teams},
      ]);

      const byPacked = new Map(fourAgentPool.map(e => [e.canonicalPacked, e]));
      const rng = mock.createRng(42);
      for (let trial = 0; trial < 400; trial++) {
        const pair = teams.samplePoolsPair(fourAgentPool, 1, 2, rng);
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

        expect(pair.t1Label).toMatch(/^(?:P[12]:)?[0-9a-f]{12}$/);
        expect(pair.t2Label).toMatch(/^(?:P[12]:)?[0-9a-f]{12}$/);
        expect(pair.t1Label.startsWith('P1:')).toBe(e1.owners.has(1));
        expect(pair.t1Label.startsWith('P2:')).toBe(e1.owners.has(2));
        expect(pair.t2Label.startsWith('P1:')).toBe(e2.owners.has(1));
        expect(pair.t2Label.startsWith('P2:')).toBe(e2.owners.has(2));
        const prefixedCount =
          (pair.t1Label.includes(':') ? 1 : 0) + (pair.t2Label.includes(':') ? 1 : 0);
        expect(prefixedCount).toBe(activeCount);
      }

      // Champion vs Challenger of the same project (`agentAId === agentBId`) draws two blind
      // third-party teams so neither side has shared-roster knowledge
      for (let trial = 0; trial < 100; trial++) {
        const selfPair = teams.samplePoolsPair(fourAgentPool, 1, 1, rng);
        const s1 = byPacked.get(selfPair.t1Packed)!;
        const s2 = byPacked.get(selfPair.t2Packed)!;
        expect(s1.owners.has(1)).toBe(false);
        expect(s2.owners.has(1)).toBe(false);
        expect(selfPair.t1Label).toMatch(/^[0-9a-f]{12}$/);
        expect(selfPair.t2Label).toMatch(/^[0-9a-f]{12}$/);
      }

      // Verify exact 2/N per-agent and 1/(N*K) per-slot uniformity across both N=4 and N=5
      for (const nAgents of [4, 5]) {
        const kTeams = 20;
        const syntheticPool: teams.CanonicalPoolEntry[] = [];
        for (let agentId = 1; agentId <= nAgents; agentId++) {
          for (let slot = 1; slot <= kTeams; slot++) {
            syntheticPool.push({
              canonicalPacked: `packed-agent-${agentId}-slot-${slot}`,
              speciesIds: [
                `sp-${agentId}-${slot}-1`, `sp-${agentId}-${slot}-2`, `sp-${agentId}-${slot}-3`,
                `sp-${agentId}-${slot}-4`, `sp-${agentId}-${slot}-5`, `sp-${agentId}-${slot}-6`,
              ],
              owners: new Map([[agentId, {agentName: `Agent ${agentId}`, slotIndex: slot}]]),
            });
          }
        }
        const lookup = new Map(syntheticPool.map(e => [e.canonicalPacked, e]));
        const agentCounts = new Map<number, number>();
        const t1Counts = new Map<string, number>();
        const t2Counts = new Map<string, number>();
        const unifRng = mock.createRng(1000 + nAgents);
        const trials = 40_000;
        for (let t = 0; t < trials; t++) {
          const sampled = teams.samplePoolsPair(syntheticPool, 1, 2, unifRng);
          t1Counts.set(sampled.t1Packed, (t1Counts.get(sampled.t1Packed) ?? 0) + 1);
          t2Counts.set(sampled.t2Packed, (t2Counts.get(sampled.t2Packed) ?? 0) + 1);
          for (const packed of [sampled.t1Packed, sampled.t2Packed]) {
            const ownerId = [...lookup.get(packed)!.owners.keys()][0];
            agentCounts.set(ownerId, (agentCounts.get(ownerId) ?? 0) + 1);
          }
        }
        const expectedAgentProb = 2 / nAgents;
        for (let agentId = 1; agentId <= nAgents; agentId++) {
          const observed = (agentCounts.get(agentId) ?? 0) / trials;
          expect(Math.abs(observed - expectedAgentProb)).toBeLessThan(0.01);
        }
        const expectedSlotProb = 1 / (nAgents * kTeams);
        for (const entry of syntheticPool) {
          const obs1 = (t1Counts.get(entry.canonicalPacked) ?? 0) / trials;
          const obs2 = (t2Counts.get(entry.canonicalPacked) ?? 0) / trials;
          expect(Math.abs(obs1 - expectedSlotProb)).toBeLessThan(0.003);
          expect(Math.abs(obs2 - expectedSlotProb)).toBeLessThan(0.003);
        }
      }
    });

  test('probabilistic expected ratings exhibit short-run variance and long-run convergence',
    async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-mock-conv-'));
      const db = new Database(':memory:', {now: 1_760_000_000});
      try {
        const runner = new mock.Runner({
          db,
          mockDir: tmpDir,
          now: 1_760_000_000,
          seed: 987654,
        });

        await runner.runScript(`
          reset --seed 987654
          ladder open rby,adv
          register "AlphaAgent" --logo auto
          register "AnchorAgent" --logo auto
          register "GammaAgent" --logo auto
          submit alphaagent 1.0.0 rby=1700 adv=1320
          submit anchoragent 1.0.0 rby=1500 adv=1500
          submit gammaagent 1.0.0 rby=1300 adv=1680
          ladder anchor rby,adv anchoragent@1.0.0
          play 15 --ladder rby --balanced --tie-rate 0
        `);

        // Short-run: outcomes are stochastic, not deterministically equal to expected Elo
        const shortRby = new Map(
          db.getLeaderboardEntries('gen1ou20261109').map(e => [e.agentSlug, e.elo])
        );
        expect(shortRby.get('anchoragent')).toBeCloseTo(1500, 3);
        expect(Math.round(shortRby.get('alphaagent')!)).not.toBe(1700);

        // Long-run: empirical Davidson MAP ratings converge toward declared expected ratings
        // independently on both RBY (Alpha=1700, Gamma=1300) and ADV (Alpha=1320, Gamma=1680)
        await runner.runScript(`
          play 900 --ladder rby --balanced --tie-rate 0
          play 900 --ladder adv --balanced --tie-rate 0
        `);

        const longRby = new Map(
          db.getLeaderboardEntries('gen1ou20261109').map(e => [e.agentSlug, e.elo])
        );
        expect(longRby.get('alphaagent')!).toBeGreaterThan(1665);
        expect(longRby.get('alphaagent')!).toBeLessThan(1735);
        expect(longRby.get('gammaagent')!).toBeGreaterThan(1265);
        expect(longRby.get('gammaagent')!).toBeLessThan(1335);

        const longAdv = new Map(
          db.getLeaderboardEntries('gen3ou20261109').map(e => [e.agentSlug, e.elo])
        );
        expect(longAdv.get('alphaagent')!).toBeGreaterThan(1285);
        expect(longAdv.get('alphaagent')!).toBeLessThan(1355);
        expect(longAdv.get('gammaagent')!).toBeGreaterThan(1645);
        expect(longAdv.get('gammaagent')!).toBeLessThan(1715);
      } finally {
        db.close();
        fs.rmSync(tmpDir, {recursive: true, force: true});
      }
    });

  test('persists state.json across sequential one-by-one commands and runs bounded simulate',
    async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-mock-seq-'));
      const dbPath = path.join(tmpDir, 'arena.sqlite');
      const lines = [
        'reset --seed 4242 --now 2026-10-01T00:00:00Z --open-ladders',
        'register "SoloOne" --pending',
        'qualify soloone',
        'register "SoloTwo"',
        'register "SoloThree"',
        'submit soloone 1.0.0 rby=1620',
        'submit solotwo 1.0.0 rby=1500',
        'submit solothree 1.0.0 rby=1420',
        'ladder anchor rby solotwo@1.0.0',
        'play 12 --ladder rby --over 2d',
        'simulate 8 --over 1d',
      ];

      try {
        for (const line of lines) {
          const db = new Database(dbPath);
          try {
            const runner = new mock.Runner({db, mockDir: tmpDir});
            await runner.execLine(line);
          } finally {
            db.close();
          }
        }

        const batchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-mock-batch-'));
        const batchDb = new Database(':memory:');
        try {
          const batchRunner = new mock.Runner({db: batchDb, mockDir: batchDir});
          await batchRunner.runScript(lines.join('\n'));

          const seqDb = new Database(dbPath);
          try {
            const seqEntries = seqDb.getLeaderboardEntries('gen1ou20261109')
              .map(e => ({slug: e.agentSlug, elo: Math.round(e.elo * 100), m: e.matches}));
            const batchEntries = batchDb.getLeaderboardEntries('gen1ou20261109')
              .map(e => ({slug: e.agentSlug, elo: Math.round(e.elo * 100), m: e.matches}));
            expect(seqEntries).toEqual(batchEntries);
          } finally {
            seqDb.close();
          }
        } finally {
          batchDb.close();
          fs.rmSync(batchDir, {recursive: true, force: true});
        }
      } finally {
        fs.rmSync(tmpDir, {recursive: true, force: true});
      }
    });

  test('executes tools/scenarios/e2e.mock + seed.mock against Polka HTTP + 375px Playwright',
    async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-e2e-'));
      const mockDir = path.join(tmpDir, 'mock');
      const staticDir = path.join(mockDir, 'static');
      const avatarsDir = path.join(staticDir, 'avatars');
      const publicDir = path.join(tmpDir, 'public');
      const poolDir = path.join(tmpDir, 'pool');
      const dbPath = path.join(tmpDir, 'arena.sqlite');
      fs.mkdirSync(poolDir, {recursive: true});
      fs.mkdirSync(publicDir, {recursive: true});

      let nowSeconds = 1_760_000_000;
      const db = new Database(dbPath, {now: nowSeconds});

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
        now: () => nowSeconds,
      });

      let statusQueue: Promise<unknown> = Promise.resolve();
      const arenaHandle = arena.register(app, {
        db,
        auth: authInstance,
        publicDir,
        now: () => nowSeconds,
        onSubmissionStatus: result => {
          statusQueue = statusQueue.then(async () => {
            await discord.notifySubmissionStatus(
              db, 'e2e-discord-token', DISCORD_CONFIG, result, discordState
            );
          });
          return statusQueue.then(() => undefined);
        },
      });
      render.register(app, {
        db,
        arena: arenaHandle,
        publicDir,
        staticDir,
        avatarsDir,
        now: () => nowSeconds,
      });

      const server = http.createServer((req, res) => app.handler(req as polka.Request, res));
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const addr = server.address() as {port: number};
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      const cookieFor = (githubLogin: string, githubId = 1001) => {
        const exp = Math.max(nowSeconds, Math.floor(Date.now() / 1000)) + 86400;
        const tok = auth.signToken(
          {github: {id: githubId, login: githubLogin}, exp},
          E2E_AUTH.sessionSecret
        );
        return `${auth.SESSION_COOKIE}=${encodeURIComponent(tok)}`;
      };

      const seenCheckpoints: string[] = [];
      const guildMembers: discord.GuildMember[] = [
        {user: {id: '513513270670262284', username: 'scheibo'}, roles: []},
        {user: {id: '283674461268344832', username: 'pmariglia'}, roles: []},
        {user: {id: '300000000000000001', username: 'jakegrigsby'}, roles: []},
        {user: {id: '300000000000000002', username: 'batistas_dick'}, roles: []},
        {user: {id: '300000000000000005', username: 'asterdev'}, roles: []},
      ];

      try {
        const checkpointHandlers: Record<
          string,
          (r: mock.Runner) => Promise<void> | void
        > = {
          'pre-launch': async () => {
            const preRes = await realFetch(`${baseUrl}/account/`, {
              headers: {cookie: cookieFor('scheibo')},
            });
            expect(preRes.status).toBe(200);
            const preHtml = await preRes.text();
            expect(preHtml).toContain('Qualified');
            expect(preHtml).toContain('<fieldset class="form-fieldset" disabled>');

            const pendingRes = await realFetch(`${baseUrl}/account/`, {
              headers: {cookie: cookieFor('asterdev', 1005)},
            });
            expect(await pendingRes.text()).toContain('Pending');
          },
          'ladders-open': async () => {
            const eligibleHtml = await (await realFetch(`${baseUrl}/account/`, {
              headers: {cookie: cookieFor('scheibo')},
            })).text();
            expect(eligibleHtml).toContain('Eligible');
          },
          'after-smoke-fail': async () => {
            await statusQueue;
            const failedRow = db.getVersionBySlugAndLabel('0-error', '0.1.0-bad')!;
            expect(failedRow.smokeStatus).toBe('failed');
            expect(failedRow.notified).toBe(true);
            expect(
              discordCalls.some(c => c.url.includes('/channels/dm-513513270670262284/messages'))
            ).toBe(true);
            const afterFailHtml = await (await realFetch(`${baseUrl}/account/`, {
              headers: {cookie: cookieFor('scheibo')},
            })).text();
            expect(afterFailHtml).toContain('(DM sent)');
            expect(afterFailHtml).toContain('Eligible');
          },
          'pending-auth-token': async () => {
            const pendingCheck = await realFetch(`${baseUrl}/api/arena/pending-submissions`, {
              headers: {authorization: `Bearer ${E2E_AUTH.arenaSecret}`},
            });
            const pendingData = await pendingCheck.json() as {
              submissions: Array<{agentSlug: string; authToken?: string}>;
            };
            expect(pendingData.submissions.find(s => s.agentSlug === '0-error')?.authToken)
              .toBe('Bearer private-r2-token');
          },
          'two-vgc-agents': async r => {
            expect(db.getVersionBySlugAndLabel('0-error', '1.0.0')?.authTokenEncoding)
              .toBeUndefined();
            // With only 2 agents on VGC (min = 4), VGC refuses to schedule while RBY schedules
            expect(await r.playNextScheduledMatch({
              ladders: [db.getLadder('gen9championsvgc2026regmc')!],
            })).toBeUndefined();
            const rbyStep = await r.playNextScheduledMatch({
              ladders: [db.getLadder('gen1ou20261109')!],
            });
            expect(rbyStep?.ladderId).toBe('gen1ou20261109');
          },
          'three-vgc-agents': async r => {
            // With 3 agents on VGC (min = 4), VGC still refuses to schedule
            expect(await r.playNextScheduledMatch({
              ladders: [db.getLadder('gen9championsvgc2026regmc')!],
            })).toBeUndefined();
          },
          'four-vgc-agents': () => {
            const recentVgc = db.getRecentMatches(5)
              .find(m => m.ladderId === 'gen9championsvgc2026regmc');
            expect(recentVgc).toBeDefined();
            expect(recentVgc?.p1TeamLabel).toMatch(/^(?:P[12]:)?[0-9a-f]{12}$/);
            expect(recentVgc?.p2TeamLabel).toMatch(/^(?:P[12]:)?[0-9a-f]{12}$/);
          },
          'third-version-retired': () => {
            const rbyEntries = db.getLeaderboardEntries('gen1ou20261109')
              .filter(e => e.agentSlug === '0-error');
            expect(rbyEntries.filter(e => e.role !== 'retired')).toHaveLength(2);
            expect(rbyEntries.filter(e => e.role === 'retired')).toHaveLength(1);
          },
          'discord-synced': () => {
            expect(guildMembers.find(m => m.user.username === 'scheibo')?.roles)
              .toContain('1568629775122309210');
            expect(guildMembers.find(m => m.user.username === 'asterdev')?.roles)
              .not.toContain('1568629775122309210');
            const rbyLeader = db.getArenaLadderRoleTargets().find(t => t.slot === 'rby')!;
            expect(rbyLeader.discordIds.length).toBeGreaterThan(0);
            for (const holderId of rbyLeader.discordIds) {
              expect(guildMembers.find(m => m.user.id === holderId)?.roles)
                .toContain('1563716887131459685');
            }
          },
          'vgc-rotated': () => {
            expect(db.getLadder('gen9championsvgc2026regmc')?.status).toBe('settling');
            expect(db.getLadder('gen9championsvgc2027regma')?.status).toBe('active');
            expect(db.getLadder('gen9championsvgc2027regma')?.discord)
              .toBe('1564121375558340768');
          },
          'vgc-archived': async () => {
            expect(db.getLadder('gen9championsvgc2026regmc')?.status).toBe('archived');
            const oldVgcDir = path.join(publicDir, 'arena', 'ladders', 'gen9championsvgc2026regmc');
            expect(fs.existsSync(path.join(oldVgcDir, 'gen9championsvgc2026regmc-logs.7z')))
              .toBe(true);
            const oldTeamsRes = await realFetch(
              `${baseUrl}/arena/ladders/gen9championsvgc2026regmc/teams.json`
            );
            expect(oldTeamsRes.status).toBe(200);
            const newTeamsRes = await realFetch(
              `${baseUrl}/arena/ladders/gen9championsvgc2027regma/teams.json`
            );
            expect(newTeamsRes.status).toBe(404);
          },
          quarantined: async () => {
            await statusQueue;
            const mtVer = db.getVersionBySlugAndLabel('mews-truck', '1.0.0')!;
            expect(mtVer.smokeStatus).toBe('quarantined');
            expect(mtVer.notified).toBe(true);
            expect(
              discordCalls.some(c => c.url.includes('/channels/dm-300000000000000002/messages'))
            ).toBe(true);
            expect(
              discordCalls.some(c => c.url.includes('/channels/dm-513513270670262284/messages'))
            ).toBe(true);
          },
        };

        const runner = new mock.Runner({
          db,
          mockDir,
          publicDir,
          now: nowSeconds,
          serverUrl: baseUrl,
          arenaSecret: E2E_AUTH.arenaSecret,
          sessionSecret: E2E_AUTH.sessionSecret,
          onTimeChange: nextNow => {
            nowSeconds = nextNow;
          },
          onDiscordSync: async () => {
            discordCalls.length = 0;
            await discord.syncArenaRoles(
              db, 'e2e-discord-token', DISCORD_CONFIG, discordState, guildMembers
            );
          },
          onCheckpoint: async (name, r) => {
            seenCheckpoints.push(name);
            const handler = checkpointHandlers[name];
            await handler(r);
          },
        });

        await runner.runFile(root('tools', 'scenarios', 'e2e.mock'));

        expect(seenCheckpoints).toEqual([
          'pre-launch',
          'ladders-open',
          'after-smoke-fail',
          'pending-auth-token',
          'two-vgc-agents',
          'three-vgc-agents',
          'four-vgc-agents',
          'third-version-retired',
          'discord-synced',
          'vgc-rotated',
          'vgc-archived',
          'quarantined',
        ]);

        const seedDb = new Database(':memory:', {now: nowSeconds});
        const seedMockDir = path.join(tmpDir, 'seed-mock');
        const seedStaticDir = path.join(seedMockDir, 'static');
        const seedAvatarsDir = path.join(seedStaticDir, 'avatars');
        const viewPublicDir = path.join(tmpDir, 'views-public');
        copyRootPublicAssets(render.PUBLIC_DIR, viewPublicDir);
        try {
          const seeded = await mock.seed({
            db: seedDb,
            mockDir: seedMockDir,
            staticDir: seedStaticDir,
            avatarsDir: seedAvatarsDir,
            publicDir: viewPublicDir,
            now: nowSeconds,
            render: true,
          });
          expect(
            fs.existsSync(path.join(viewPublicDir, 'arena', 'tournaments', '1', '1-replays.7z'))
          ).toBe(true);
          const sf1Log = fs.readFileSync(
            path.join(viewPublicDir, 'arena', 'tournaments', '1', 'spring26-sf1.log'),
            'utf8'
          );
          expect(sf1Log).toContain('|c|☆');

          for (const stub of ['arena', 'projects', 'account', 'chat']) {
            const stubDir = path.join(viewPublicDir, stub);
            fs.mkdirSync(stubDir, {recursive: true});
            const stubFile = path.join(stubDir, 'index.html');
            if (!fs.existsSync(stubFile)) fs.writeFileSync(stubFile, '');
          }

          const hyperlinkBin = path.join(process.cwd(), 'node_modules', '.bin', 'hyperlink');
          const linkOut = execFileSync(hyperlinkBin, [viewPublicDir, '--check-anchors'], {
            encoding: 'utf8',
          });
          expect(linkOut).toContain('Found 0 bad links');
          expect(linkOut).toContain('Found 0 bad anchors');

          const viewApp = polka();
          const viewArena = arena.register(viewApp, {
            db: seedDb,
            arenaSecret: E2E_AUTH.arenaSecret,
            sessionSecret: E2E_AUTH.sessionSecret,
            publicDir: viewPublicDir,
            now: () => nowSeconds,
          });
          viewArena.setLiveState({
            live: seeded.liveDoc.live,
            stale: seeded.liveDoc.stale,
            updatedAt: seeded.liveDoc.updatedAt,
          });
          if (seeded.tournamentBroadcast) {
            viewArena.setTournamentBroadcast(seeded.tournamentBroadcast);
          }
          render.register(viewApp, {
            db: seedDb,
            arena: viewArena,
            publicDir: viewPublicDir,
            staticDir: seedStaticDir,
            avatarsDir: seedAvatarsDir,
            now: () => nowSeconds,
          });

          const mimeByExt: Record<string, string> = {
            '.html': 'text/html; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.js': 'application/javascript; charset=utf-8',
            '.json': 'application/json; charset=utf-8',
            '.svg': 'image/svg+xml',
            '.png': 'image/png',
            '.log': 'text/plain; charset=utf-8',
            '.7z': 'application/x-7z-compressed',
          };
          const viewServer = http.createServer((req, res) => {
            const parsedUrl = new URL(req.url ?? '/', 'http://localhost');
            const pathname = decodeURIComponent(parsedUrl.pathname);
            const isStaticArenaFile = pathname.startsWith('/arena/viewer/') ||
              pathname.endsWith('.log') ||
              pathname.endsWith('.7z');
            const isSsrOrApi = pathname.startsWith('/api/') ||
              pathname === '/projects' ||
              pathname === '/projects.json' ||
              pathname.startsWith('/projects/') ||
              ((pathname === '/arena' || pathname.startsWith('/arena/')) && !isStaticArenaFile);
            if (!isSsrOrApi) {
              const candidate = path.resolve(viewPublicDir, `.${pathname}`);
              if (candidate.startsWith(viewPublicDir) && fs.existsSync(candidate)) {
                const st = fs.statSync(candidate);
                const file = st.isDirectory() ? path.join(candidate, 'index.html') : candidate;
                if (fs.existsSync(file) && fs.statSync(file).isFile()) {
                  const ext = path.extname(file).toLowerCase();
                  res.statusCode = 200;
                  res.setHeader('Content-Type', mimeByExt[ext] ?? 'application/octet-stream');
                  res.end(fs.readFileSync(file));
                  return;
                }
              }
            }
            void viewApp.handler(req as polka.Request, res);
          });
          await new Promise<void>(resolve => viewServer.listen(0, '127.0.0.1', resolve));
          const viewPort = (viewServer.address() as {port: number}).port;
          const viewBaseUrl = `http://127.0.0.1:${viewPort}`;

          try {
            const tour1Res = await realFetch(`${viewBaseUrl}/arena/tournaments/1/index.json`);
            expect(tour1Res.status).toBe(200);
            const tour1Doc = await tour1Res.json() as {
              archiveHref?: string;
              games: Array<{logHref?: string}>;
            };
            expect(tour1Doc.archiveHref).toBe('/arena/tournaments/1/1-replays.7z');
            expect(tour1Doc.games.some(g => g.logHref === '/arena/tournaments/1/spring26-sf1.log'))
              .toBe(true);
            expect((await realFetch(`${viewBaseUrl}/projects/index.json`)).status).toBe(404);
            expect(
              (await realFetch(`${viewBaseUrl}/arena/battles/${seeded.featuredBattleId}`)).status
            ).toBe(404);

            const browser = await chromium.launch({args: ['--disable-gpu']});
            try {
              const pathsToVerify = [
                '/arena/',
                '/arena/ladders/rby/',
                '/arena/ladders/vgc/',
                '/arena/tournaments/1/',
                '/arena/tournaments/2/',
                '/arena/tournaments/3/',
                '/projects/',
                '/projects/0-error/',
                '/account/',
                '/arena/battles/',
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
                  if (
                    u.pathname === '/api/battles/stream' ||
                    /^\/api\/tournaments\/[^/]+\/stream$/.test(u.pathname)
                  ) {
                    await route.fulfill({status: 204, contentType: 'text/event-stream', body: ''});
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
                  const r = await realFetch(`${viewBaseUrl}${u.pathname}${u.search}`);
                  const bodyBuf = Buffer.from(await r.arrayBuffer());
                  await route.fulfill({
                    status: r.status,
                    contentType: r.headers.get('content-type') ?? 'application/octet-stream',
                    body: bodyBuf,
                  });
                });

                const page = await context.newPage();
                const pageErrors: string[] = [];
                page.on('pageerror', err => pageErrors.push(err.message));
                page.on('console', msg => {
                  if (msg.type() === 'error') pageErrors.push(msg.text());
                });

                for (const p of pathsToVerify) {
                  await page.goto(p);
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
                await page.locator('#battles-tbody tr.battle-row td').first().click();
                expect(
                  await page.locator('#battles-tbody tr.battle-detail-row:not(.hide)').count()
                ).toBe(1);
                expect(
                  await page.evaluate<number>(
                    'document.documentElement.scrollWidth - window.innerWidth'
                  )
                ).toBeLessThanOrEqual(0);
                expect(pageErrors).toEqual([]);
                await context.close();
              }

              // Real live EventSource SSE interaction test (no SSE stubbing — direct 127.0.0.1!)
              const liveClient = new arena.Client({
                serverUrl: viewBaseUrl,
                arenaSecret: E2E_AUTH.arenaSecret!,
              });
              const liveCtx = await browser.newContext({
                viewport: {width: 375, height: 667},
                colorScheme: 'dark',
              });
              await liveCtx.route('**/*', async route => {
                const u = new URL(route.request().url());
                if (u.origin !== viewBaseUrl) {
                  await route.fulfill({status: 204, body: ''});
                  return;
                }
                await route.continue();
              });
              const livePage = await liveCtx.newPage();
              const liveErrors: string[] = [];
              livePage.on('pageerror', err => liveErrors.push(err.message));
              livePage.on('console', msg => {
                if (msg.type() === 'error') liveErrors.push(msg.text());
              });

              // Part A: `/arena/battles/` live SSE updates without refreshing
              await livePage.goto(`${viewBaseUrl}/arena/battles/`, {waitUntil: 'domcontentloaded'});
              await livePage.locator('label[for="bf-vgc"]').click();
              await livePage.waitForFunction(
                () => (document.getElementById('bf-vgc') as HTMLInputElement | undefined)?.checked
              );

              const vgcLadder = seedDb.getCurrentLadders().find(l => l.slot === 'vgc')!;
              const vgcEntries = seedDb.getLeaderboardEntries(vgcLadder.id)
                .filter(e => e.role !== 'retired');
              const p1Entry = vgcEntries[0];
              const p2Entry = vgcEntries[1];

              await liveClient.sendHeartbeat({
                heartbeatSeq: 500,
                matchId: 'vgc-sse-live-001',
                ladderId: vgcLadder.id,
                format: vgcLadder.format,
                game: 1,
                turn: 4,
                activeSlot: 'p1',
                turnStartedAt: nowSeconds - 2,
                turnBudgetSeconds: 150,
                incrementSeconds: 25,
                p1: {
                  slug: p1Entry.agentSlug,
                  name: p1Entry.agentName,
                  version: p1Entry.version,
                  bankSeconds: 148,
                  lastTurnMillis: 310,
                  meanTurnMillis: 300,
                  ram: 1024,
                  team: 'P1:aabbccddeeff',
                },
                p2: {
                  slug: p2Entry.agentSlug,
                  name: p2Entry.agentName,
                  version: p2Entry.version,
                  bankSeconds: 150,
                  lastTurnMillis: 420,
                  meanTurnMillis: 400,
                  ram: 1280,
                  team: '112233445566',
                },
              });
              await livePage.waitForFunction(
                () => document.getElementById('live-panel')?.textContent
                  ?.includes('vgc-sse-live-001')
              );
              expect(await livePage.locator('#state-p1').textContent()).toContain('RUNNING');
              expect(await livePage.locator('#state-p2').textContent()).toContain('PAUSED');

              // Swap active slot & advance to Game 2 via SSE without refreshing
              await liveClient.sendHeartbeat({
                heartbeatSeq: 501,
                matchId: 'vgc-sse-live-001',
                ladderId: vgcLadder.id,
                format: vgcLadder.format,
                game: 2,
                turn: 9,
                activeSlot: 'p2',
                turnStartedAt: nowSeconds - 1,
                turnBudgetSeconds: 145,
                incrementSeconds: 25,
                game1Summary: {winnerSlot: 'p1', turns: 11},
                p1: {
                  slug: p1Entry.agentSlug,
                  name: p1Entry.agentName,
                  version: p1Entry.version,
                  bankSeconds: 140,
                  lastTurnMillis: 315,
                  meanTurnMillis: 305,
                  ram: 1040,
                  team: 'P1:aabbccddeeff',
                },
                p2: {
                  slug: p2Entry.agentSlug,
                  name: p2Entry.agentName,
                  version: p2Entry.version,
                  bankSeconds: 145,
                  lastTurnMillis: 410,
                  meanTurnMillis: 405,
                  ram: 1290,
                  team: '112233445566',
                },
              });
              await livePage.waitForFunction(
                () => document.getElementById('live-panel')?.textContent?.includes('Game 2 / 2')
              );
              expect(await livePage.locator('#state-p1').textContent()).toContain('PAUSED');
              expect(await livePage.locator('#state-p2').textContent()).toContain('RUNNING');

              // Complete VGC match & start next RBY match -> VGC row prepends to filtered history
              // AND #live-panel transitions to the new RBY match without refreshing!
              await liveClient.completeMatch({
                match: {
                  id: 'vgc-sse-live-001',
                  ladderId: vgcLadder.id,
                  p1VersionId: p1Entry.versionId,
                  p2VersionId: p2Entry.versionId,
                  seed: '42,43,44,45',
                  p1TeamLabel: 'P1:aabbccddeeff',
                  p2TeamLabel: '112233445566',
                  game1Outcome: 'W',
                  game2Outcome: 'W',
                  category: 'WW',
                  game1Turns: 11,
                  game2Turns: 13,
                  game1EndReason: 'normal',
                  game2EndReason: 'normal',
                  p1PeakRam: 1050,
                  p2PeakRam: 1300,
                  p1Game1BankSeconds: 142,
                  p1Game2BankSeconds: 136,
                  p2Game1BankSeconds: 130,
                  p2Game2BankSeconds: 120,
                  p1MeanTurnMillis: 305,
                  p2MeanTurnMillis: 405,
                  completedAt: nowSeconds,
                },
              });
              await liveClient.sendHeartbeat({
                heartbeatSeq: 502,
                matchId: 'rby-sse-next-002',
                ladderId: 'gen1ou20261109',
                format: 'gen1ou',
                game: 1,
                turn: 2,
                activeSlot: 'p1',
                turnStartedAt: nowSeconds,
                turnBudgetSeconds: 150,
                incrementSeconds: 10,
                p1: {
                  slug: p1Entry.agentSlug,
                  name: p1Entry.agentName,
                  version: p1Entry.version,
                  bankSeconds: 150,
                  lastTurnMillis: 200,
                  meanTurnMillis: 200,
                  ram: 700,
                },
                p2: {
                  slug: p2Entry.agentSlug,
                  name: p2Entry.agentName,
                  version: p2Entry.version,
                  bankSeconds: 150,
                  lastTurnMillis: 220,
                  meanTurnMillis: 220,
                  ram: 750,
                },
              });

              await livePage.waitForSelector('#battles-tbody tr#vgc-sse-live-001');
              await livePage.waitForFunction(
                () => document.getElementById('live-panel')?.textContent
                  ?.includes('rby-sse-next-002')
              );
              await livePage.locator('#battles-tbody tr#vgc-sse-live-001 td').first().click();
              expect(
                await livePage.locator(
                  '#battles-tbody tr[data-detail-for="vgc-sse-live-001"]:not(.hide)'
                ).textContent()
              ).toContain('42,43,44,45');

              // Part B: `/arena/tournaments/2/` multi-table spectating, live game-complete & next!
              const t2Entrants = seedDb.getTournamentEntrants('2');
              const eA = t2Entrants[0];
              const eB = t2Entrants[1];
              const eC = t2Entrants[2];
              const eD = t2Entrants[3];

              await liveClient.sendTournamentBroadcast('2', {
                table: 1,
                mode: 'load',
                label: 'Table 1',
                gameId: 't2-e2e-live-1',
                stage: 'Round Robin',
                cycle: 9,
                matchupGame: 1,
                p1: {
                  slug: eA.agentSlug,
                  name: eA.agentName,
                  version: eA.version,
                  bankSeconds: 145,
                  thinking: true,
                  incrementSeconds: 10,
                },
                p2: {
                  slug: eB.agentSlug,
                  name: eB.agentName,
                  version: eB.version,
                  bankSeconds: 140,
                  thinking: false,
                  incrementSeconds: 10,
                },
                lines: ['|gametype|singles', `|player|p1|${eA.agentName}|1`, '|turn|3'],
              });
              await liveClient.sendTournamentBroadcast('2', {
                table: 2,
                idle: true,
                label: 'Table 2',
              });

              await livePage.goto(
                `${viewBaseUrl}/arena/tournaments/2/`,
                {waitUntil: 'domcontentloaded'}
              );
              await livePage.waitForSelector('#standings [data-live-table="1"]');
              expect(await livePage.locator('#clock-name-p1').textContent()).toBe(eA.agentName);

              // Wait briefly for EventSource snapshot, then start Table 2 live over SSE so the
              // `● T2` badge dynamically appears in Standings/Crosstable/Games without reload!
              await new Promise(resolve => setTimeout(resolve, 60));
              await liveClient.sendTournamentBroadcast('2', {
                table: 2,
                mode: 'load',
                label: 'Table 2',
                gameId: 't2-e2e-live-2',
                stage: 'Round Robin',
                cycle: 9,
                matchupGame: 2,
                p1: {
                  slug: eC.agentSlug,
                  name: eC.agentName,
                  version: eC.version,
                  bankSeconds: 132,
                  thinking: false,
                  incrementSeconds: 10,
                },
                p2: {
                  slug: eD.agentSlug,
                  name: eD.agentName,
                  version: eD.version,
                  bankSeconds: 128,
                  thinking: true,
                  incrementSeconds: 10,
                },
                lines: ['|gametype|singles', `|player|p1|${eC.agentName}|1`, '|turn|5'],
              });
              await livePage.waitForSelector('#standings [data-live-table="2"]');

              // Click live badge in Standings to spectate Table 2 without refreshing!
              await livePage.locator('#standings [data-live-table="2"]').first().click();
              await livePage.waitForFunction(
                expected => document.getElementById('clock-name-p1')?.textContent === expected,
                eC.agentName
              );
              expect(await livePage.locator('#clock-name-p2').textContent()).toBe(eD.agentName);

              // Append new protocol lines & clocks to Table 2 -> updates live clocks & Games row!
              await liveClient.sendTournamentBroadcast('2', {
                table: 2,
                mode: 'append',
                p1: {
                  slug: eC.agentSlug,
                  name: eC.agentName,
                  version: eC.version,
                  bankSeconds: 118,
                  thinking: true,
                  incrementSeconds: 10,
                },
                p2: {
                  slug: eD.agentSlug,
                  name: eD.agentName,
                  version: eD.version,
                  bankSeconds: 105,
                  thinking: false,
                  incrementSeconds: 10,
                },
                lines: ['|turn|12'],
              });
              await livePage.waitForFunction(
                () => document.querySelector(
                  '#games-tbody tr.live-game-row[data-live-game-table="2"]'
                )?.textContent?.includes('12')
              );

              // Complete Table 2 game -> updates Standings, Crosstable, and prepends replay row!
              const prevWins = eC.gameWins;
              await liveClient.completeTournamentGame('2', {
                table: 2,
                log: [
                  '|gametype|singles',
                  `|player|p1|${eC.agentName}|1`,
                  `|player|p2|${eD.agentName}|2`,
                  '|turn|12',
                  `|win|${eC.agentName}`,
                ].join('\n'),
                game: {
                  id: 't2-e2e-live-2',
                  stage: 'Round Robin',
                  cycle: 9,
                  matchupGame: 2,
                  p1VersionId: eC.versionId,
                  p2VersionId: eD.versionId,
                  seed: '9,8,7,6',
                  outcome: 'W',
                  turns: 12,
                  endReason: 'normal',
                  p1BankSeconds: 118,
                  p2BankSeconds: 105,
                  completedAt: nowSeconds + 10,
                },
              });

              await livePage.waitForSelector('#games-tbody tr[data-game-id="t2-e2e-live-2"]');
              expect(await livePage.locator('#standings').textContent()).toContain(
                `${prevWins + 1}–`
              );

              // Click the newly prepended game's replay link -> Replay mode + Return to Live button
              await livePage.locator(
                '#games-tbody a[data-replay-log="/arena/tournaments/2/t2-e2e-live-2.log"]'
              ).click();
              await livePage.waitForSelector('[data-return-live]');
              expect(await livePage.locator('#series-left').textContent()).toContain('Replay');

              // Return to Live (switches to active Table 1), then start the next battle on Table 1
              // -> #live immediately transitions to the new battle without refreshing!
              await livePage.locator('[data-return-live]').click();
              await livePage.waitForFunction(
                expected => document.getElementById('clock-name-p1')?.textContent === expected,
                eA.agentName
              );
              await liveClient.sendTournamentBroadcast('2', {
                table: 1,
                mode: 'load',
                label: 'Table 1',
                gameId: 't2-e2e-live-3',
                stage: 'Round Robin',
                cycle: 9,
                matchupGame: 3,
                p1: {
                  slug: eB.agentSlug,
                  name: eB.agentName,
                  version: eB.version,
                  bankSeconds: 150,
                  thinking: true,
                  incrementSeconds: 10,
                },
                p2: {
                  slug: eC.agentSlug,
                  name: eC.agentName,
                  version: eC.version,
                  bankSeconds: 150,
                  thinking: false,
                  incrementSeconds: 10,
                },
                lines: ['|gametype|singles', `|player|p1|${eB.agentName}|1`, '|turn|1'],
              });
              await livePage.waitForFunction(
                expected => document.getElementById('clock-name-p1')?.textContent === expected,
                eB.agentName
              );
              expect(await livePage.locator('#clock-name-p2').textContent()).toBe(eC.agentName);
              expect(
                await livePage.evaluate<number>(
                  'document.documentElement.scrollWidth - window.innerWidth'
                )
              ).toBeLessThanOrEqual(0);
              expect(liveErrors).toEqual([]);

              await liveCtx.close();
            } finally {
              await browser.close();
            }
          } finally {
            viewArena.close();
            viewServer.closeAllConnections();
            await new Promise<void>(resolve => viewServer.close(() => resolve()));
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
    45_000);
});
