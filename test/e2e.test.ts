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
          'vgc-archived': () => {
            expect(db.getLadder('gen9championsvgc2026regmc')?.status).toBe('archived');
            const oldVgcDir = path.join(publicDir, 'arena', 'ladders', 'gen9championsvgc2026regmc');
            const newVgcDir = path.join(publicDir, 'arena', 'ladders', 'gen9championsvgc2027regma');
            expect(fs.existsSync(path.join(oldVgcDir, 'teams.json'))).toBe(true);
            expect(fs.existsSync(path.join(oldVgcDir, 'gen9championsvgc2026regmc-logs.7z')))
              .toBe(true);
            expect(fs.existsSync(path.join(newVgcDir, 'teams.json'))).toBe(false);
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
        render.renderArenaPages({db, publicDir, staticDir, avatarsDir, now: nowSeconds});

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
        const viewPublicDir = path.join(tmpDir, 'views-public');
        copyRootPublicAssets(render.PUBLIC_DIR, viewPublicDir);
        try {
          const seeded = await mock.seed({
            db: seedDb,
            mockDir: seedMockDir,
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
          const tour1JsonPath = path.join(viewPublicDir, 'arena', 'tournaments', '1', 'index.json');
          const tour1Doc = JSON.parse(fs.readFileSync(tour1JsonPath, 'utf8')) as {
            archiveHref?: string;
            games: Array<{logHref?: string}>;
          };
          expect(tour1Doc.archiveHref).toBe('/arena/tournaments/1/1-replays.7z');
          expect(tour1Doc.games.some(g => g.logHref === '/arena/tournaments/1/spring26-sf1.log'))
            .toBe(true);
          expect(fs.existsSync(path.join(viewPublicDir, 'projects', 'index.json'))).toBe(false);
          expect(
            fs.existsSync(
              path.join(viewPublicDir, 'arena', 'battles', seeded.featuredBattleId, 'index.html')
            )
          ).toBe(false);

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
    45_000);
});
