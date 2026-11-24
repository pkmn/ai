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
import * as tournaments from '../server/tournaments';
import {root} from '../static/util';
import * as teamMetric from '../teams';
import * as mock from '../tools/mock';

const RUN_SLOW_TESTS = Boolean(process.env.CI || process.env.RUN_SLOW_TESTS);

const E2E_ARENA_SECRET = 'e2e-arena-hmac-secret-32-bytes-min';
const E2E_AUTH: auth.Config = {
  sessionSecret: 'e2e-session-secret-32-bytes-minimum',
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

describe('pools team sampling', () => {
  const agent1Teams = mock.generateValidVgcTeams(20, 0);
  const agent2Teams = mock.generateValidVgcTeams(20, 1);
  const agent3Teams = mock.generateValidVgcTeams(20, 2);
  const agent4Teams = mock.generateValidVgcTeams(20, 3);

  afterEach(() => {
    teams.clearReferencePoolCache();
  });

  test('samplePoolsPair rejects pools with fewer than 4 distinct agents', () => {
    const twoAgentPool = teams.buildCanonicalTeamPool([
      {agentId: 1, agentName: '0 ERROR', teams: agent1Teams},
      {agentId: 2, agentName: 'Foul Play', teams: agent2Teams},
    ]);
    expect(() => teams.samplePoolsPair(twoAgentPool, 1, 2, mock.createRng(1)))
      .toThrow(/min >= 4/);

    const threeAgentPool = teams.buildCanonicalTeamPool([
      {agentId: 1, agentName: '0 ERROR', teams: agent1Teams},
      {agentId: 2, agentName: 'Foul Play', teams: agent2Teams},
      {agentId: 3, agentName: "Mew's Truck", teams: agent3Teams},
    ]);
    expect(() => teams.samplePoolsPair(threeAgentPool, 1, 2, mock.createRng(1)))
      .toThrow(/min >= 4/);
  });

  test('samplePoolsPair deals at most 1 team from active competitors per match', () => {
    const fourAgentPool = teams.buildCanonicalTeamPool([
      {agentId: 1, agentName: '0 ERROR', teams: agent1Teams},
      {agentId: 2, agentName: 'Foul Play', teams: [agent1Teams[0], ...agent2Teams.slice(1)]},
      {agentId: 3, agentName: "Mew's Truck", teams: [agent1Teams[1], ...agent3Teams.slice(1)]},
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
      expect(e1.owners.has(1) && e1.owners.has(2)).toBe(false);
      expect(e2.owners.has(1) && e2.owners.has(2)).toBe(false);
      for (const owner of e1.owners.keys()) {
        expect(e2.owners.has(owner)).toBe(false);
      }

      const activeCount =
        (e1.owners.has(1) || e1.owners.has(2) ? 1 : 0) +
        (e2.owners.has(1) || e2.owners.has(2) ? 1 : 0);
      expect(activeCount).toBeLessThanOrEqual(1);
      expect(pair.t1Label.startsWith('P1:')).toBe(e1.owners.has(1));
      expect(pair.t1Label.startsWith('P2:')).toBe(e1.owners.has(2));
      expect(pair.t2Label.startsWith('P1:')).toBe(e2.owners.has(1));
      expect(pair.t2Label.startsWith('P2:')).toBe(e2.owners.has(2));
    }
  });

  test('samplePoolsPair deals two third-party teams on intra-project matches', () => {
    const fourAgentPool = teams.buildCanonicalTeamPool([
      {agentId: 1, agentName: '0 ERROR', teams: agent1Teams},
      {agentId: 2, agentName: 'Foul Play', teams: agent2Teams},
      {agentId: 3, agentName: "Mew's Truck", teams: agent3Teams},
      {agentId: 4, agentName: 'Metamon', teams: agent4Teams},
    ]);
    const byPacked = new Map(fourAgentPool.map(e => [e.canonicalPacked, e]));
    const rng = mock.createRng(77);

    for (let trial = 0; trial < 100; trial++) {
      const selfPair = teams.samplePoolsPair(fourAgentPool, 1, 1, rng);
      expect(byPacked.get(selfPair.t1Packed)!.owners.has(1)).toBe(false);
      expect(byPacked.get(selfPair.t2Packed)!.owners.has(1)).toBe(false);
      expect(selfPair.t1Label).toMatch(/^[0-9a-f]{12}$/);
      expect(selfPair.t2Label).toMatch(/^[0-9a-f]{12}$/);
    }
  });

  test('buildCanonicalTeamPool deduplicates cosmetic forme, shiny, gender, or Lv100 sets', () => {
    const gastroWest =
      'Gastrodon|gastrodon|leftovers|stormdrain|earthpower,icebeam,protect,recover|' +
      'Calm|252,,,4,252,|M||||';
    const gastroEast =
      'Gastrodon-East||leftovers|stormdrain|earthpower,icebeam,protect,recover|' +
      'Calm|252,,,4,252,|F||S||';
    const cosmeticPool = teams.buildCanonicalTeamPool([
      {agentId: 1, agentName: 'A1', teams: [gastroWest]},
      {agentId: 2, agentName: 'A2', teams: [gastroEast]},
    ], 'gen9ou');
    expect(cosmeticPool).toHaveLength(1);
    expect([...cosmeticPool[0].owners.keys()]).toEqual([1, 2]);

    const vgcL50 = agent1Teams[0];
    const vgcL100ShinyF = vgcL50
      .replace(/Level: 50/g, 'Level: 100\nShiny: Yes')
      .replace(/^([A-Za-z0-9-]+) @/gm, '$1 (F) @');
    const vgcDedupePool = teams.buildCanonicalTeamPool([
      {agentId: 1, agentName: 'A1', teams: [vgcL50]},
      {agentId: 2, agentName: 'A2', teams: [vgcL100ShinyF]},
    ], 'gen9championsvgc2026regmc');
    expect(vgcDedupePool).toHaveLength(1);
    expect([...vgcDedupePool[0].owners.keys()]).toEqual([1, 2]);
  });

  test('canonSpecies collapses cosmetic formes while preserving distinct ability formes', () => {
    const gen9Dex = teamMetric.getDex('gen9ou');
    expect(teamMetric.canonSpecies(gen9Dex, 'Gastrodon-East')).toBe('gastrodon');
    expect(teamMetric.canonSpecies(gen9Dex, 'Sinistcha-Masterpiece')).toBe('sinistcha');
    expect(teamMetric.canonSpecies(gen9Dex, 'Maushold-Four')).toBe('maushold');
    expect(teamMetric.canonSpecies(gen9Dex, 'Meowstic-F')).toBe('meowsticf');
    expect(teamMetric.canonSpecies(gen9Dex, 'Toxtricity-Low-Key')).toBe('toxtricitylowkey');
    expect(teamMetric.canonSpecies(gen9Dex, 'Squawkabilly-Yellow')).toBe('squawkabillyyellow');
    expect(teamMetric.canonSpecies(gen9Dex, 'Basculin-White-Striped'))
      .toBe('basculinwhitestriped');
    expect(teamMetric.canonSpecies(gen9Dex, 'Greninja-Bond')).toBe('greninjabond');
    expect(teamMetric.canonSpecies(gen9Dex, 'Rockruff-Dusk')).toBe('rockruffdusk');
  });

  test('validateCompetitorTeamsIncremental requires 4 moves only when learnset >= 4', () => {
    const vgcL50 = agent1Teams[0];
    const threeMovePaste = vgcL50.replace(/\n- [^\n]+/, '');
    const threeMoveRes = teams.validateCompetitorTeamsIncremental(
      [threeMovePaste],
      {format: 'gen9championsvgc2026regmc', pools: [], teams: 1}
    );
    expect(threeMoveRes.newlySavedCount).toBe(0);
    expect(threeMoveRes.rejections[0]?.reason).toMatch(/must have 4 moves \(found 3\)/);

    const shinyPaste = vgcL50.replace('Level: 50', 'Level: 50\nShiny: Yes');
    const shinyRes = teams.validateCompetitorTeamsIncremental(
      [shinyPaste],
      {format: 'gen9championsvgc2026regmc', pools: [], teams: 1}
    );
    expect(shinyRes.complete).toBe(true);
    expect(shinyRes.allSaved[0]).toContain('|S|');

    const dittoOuPaste = [
      'Ditto @ Choice Scarf\nAbility: Imposter\nEVs: 252 HP / 4 Atk / 252 Def\n' +
      'Relaxed Nature\nIVs: 0 Spe\n- Transform',
      'Great Tusk @ Heavy-Duty Boots\nAbility: Protosynthesis\nEVs: 252 Atk / 4 SpD / 252 Spe\n' +
      'Jolly Nature\n- Headlong Rush\n- Ice Spinner\n- Rapid Spin\n- Close Combat',
      'Kingambit @ Leftovers\nAbility: Supreme Overlord\nEVs: 252 HP / 252 Atk / 4 SpD\n' +
      'Adamant Nature\n- Kowtow Cleave\n- Sucker Punch\n- Swords Dance\n- Iron Head',
      'Gholdengo @ Air Balloon\nAbility: Good as Gold\nEVs: 252 SpA / 4 SpD / 252 Spe\n' +
      'Timid Nature\nIVs: 0 Atk\n- Make It Rain\n- Shadow Ball\n- Nasty Plot\n- Recover',
      'Dragapult @ Choice Specs\nAbility: Infiltrator\nEVs: 252 SpA / 4 SpD / 252 Spe\n' +
      'Timid Nature\n- Draco Meteor\n- Shadow Ball\n- Flamethrower\n- U-turn',
      'Gliscor @ Toxic Orb\nAbility: Poison Heal\nEVs: 244 HP / 252 SpD / 12 Spe\n' +
      'Careful Nature\n- Earthquake\n- Protect\n- Spikes\n- Toxic',
    ].join('\n\n');
    const dittoRes = teams.validateCompetitorTeamsIncremental(
      [dittoOuPaste],
      {format: 'gen9ou', pools: [], teams: 1}
    );
    expect(dittoRes.complete).toBe(true);
  });

  test('validateCompetitorTeamsIncremental clamps Level 100 to 50 on Champions VGC teams', () => {
    const level100Paste = agent1Teams[0].replace(/Level: 50/g, 'Level: 100');
    const res = teams.validateCompetitorTeamsIncremental(
      [level100Paste],
      {format: 'gen9championsvgc2026regmc', pools: [], teams: 1}
    );
    expect(res.complete).toBe(true);
    expect(res.allSaved[0]).not.toContain('|100|');
    expect(res.allSaved[0]).toContain('|50|');
  });

  test('teamDistance stays symmetric across unequal team sizes or double-Protect movesets', () => {
    const dex = teamMetric.getDex('gen9ou');
    const sixSets = teamMetric.parseTeam(dex, agent1Teams[0]);
    const fourSets = sixSets.slice(0, 4);
    expect(teamMetric.teamDistance(dex, fourSets, sixSets, 50)).toBe(2);
    expect(teamMetric.teamDistance(dex, sixSets, fourSets, 50)).toBe(2);

    const setA = {
      species: 'incineroar',
      item: 'sitrusberry',
      ability: 'intimidate',
      moves: ['Protect', 'Detect', 'Fake Out', 'Flare Blitz'],
    };
    const setB = {
      species: 'incineroar',
      item: 'sitrusberry',
      ability: 'intimidate',
      moves: ['Protect', 'Spiky Shield', 'Fake Out', 'Parting Shot'],
    };
    expect(teamMetric.setDistance(dex, setA, setA, 50)).toBe(0);
    expect(teamMetric.setDistance(dex, setA, setB, 50)).toBeCloseTo(
      ((0.50 * 0.25) / 1.10) * teamMetric.sameSpeciesCap(dex),
      6
    );
  });

  test('resolveTournamentTeamPool withholds unarchived pools ladder rosters', () => {
    const memDb = new Database(':memory:');
    try {
      memDb.syncLaddersFromYaml([
        '- id: vgc-live',
        '  slot: vgc',
        '  name: VGC Live',
        '  format: gen9championsvgc2026regmc',
        '  version: 0.11.0',
        '  team: pools',
        '  min: 4',
        '  teams: 1',
      ].join('\n'), 1000);
      memDb.syncProjectsFromYaml([
        '- name: Secret VGC',
        '  arena:',
        '    owners: [alice]',
      ].join('\n'), undefined, 1000);
      memDb.setAgentLadders('secret-vgc', ['vgc'], 1000);
      const ag = memDb.getAgentBySlug('secret-vgc')!;
      const sub = memDb.createSubmission({
        agentId: ag.id,
        version: '1.0.0',
        package: 'bundle',
        url: 'https://example.com/secret.tar.zst',
        sha256: 'a'.repeat(64),
        ladderIds: ['vgc-live'],
        teamsByLadder: {'vgc-live': [agent1Teams[0]]},
        now: 1000,
      });
      memDb.applySubmissionStatus({versionId: sub.id, smokeStatus: 'passed', now: 1001});

      expect(
        arena.resolveTournamentTeamPool(memDb, {
          format: 'gen9championsvgc2026regmc',
          team: 'pools',
        })
      ).toEqual([]);

      memDb.setLadderStatus('vgc-live', 'archived', 2000);
      expect(
        arena.resolveTournamentTeamPool(memDb, {
          format: 'gen9championsvgc2026regmc',
          team: 'pools',
        })
      ).toEqual([agent1Teams[0]]);
    } finally {
      memDb.close();
    }
  });

  test('samplePoolsPair achieves 2/N per-agent plus 1/(N*K) per-slot uniformity', () => {
    for (const nAgents of [4, 5]) {
      const kTeams = 4;
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
      const trials = 8_000;
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
        expect(Math.abs(observed - expectedAgentProb)).toBeLessThan(0.02);
      }
      const expectedSlotProb = 1 / (nAgents * kTeams);
      for (const entry of syntheticPool) {
        const obs1 = (t1Counts.get(entry.canonicalPacked) ?? 0) / trials;
        const obs2 = (t2Counts.get(entry.canonicalPacked) ?? 0) / trials;
        expect(Math.abs(obs1 - expectedSlotProb)).toBeLessThan(0.01);
        expect(Math.abs(obs2 - expectedSlotProb)).toBeLessThan(0.01);
      }
    }
  });
});

describe('mock scenarios & E2E lifecycle', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    teams.clearReferencePoolCache();
  });

  if (RUN_SLOW_TESTS) {
    test('exhibits short-run variance before converging to expected Elo over 900 matches',
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
            ladder teams rby,adv
            register "AlphaAgent" --logo auto
            register "AnchorAgent" --logo auto
            register "GammaAgent" --logo auto
            submit alphaagent 1.0.0 rby=1700 adv=1320
            submit anchoragent 1.0.0 rby=1500 adv=1500
            submit gammaagent 1.0.0 rby=1300 adv=1680
            ladder anchor rby,adv anchoragent@1.0.0
            ladder open rby,adv
            play 15 --ladder rby --balanced --tie-rate 0
          `);

          const shortRby = new Map(
            db.getLeaderboardEntries('gen1ou20261109').map(e => [e.agentSlug, e.elo])
          );
          expect(shortRby.get('anchoragent')).toBeCloseTo(1500, 3);
          expect(Math.round(shortRby.get('alphaagent')!)).not.toBe(1700);

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
      },
      20_000);
  }

  test('persists mock state.json identically across sequential single-line runs',
    async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-mock-seq-'));
      const lines = [
        'reset --seed 4242 --now 2026-10-01T00:00:00Z',
        'ladder teams rby',
        'register "SoloOne" --pending',
        'qualify soloone',
        'register "SoloTwo"',
        'register "SoloThree"',
        'submit soloone 1.0.0 rby=1620',
        'submit solotwo 1.0.0 rby=1500',
        'submit solothree 1.0.0 rby=1420',
        'ladder anchor rby solotwo@1.0.0',
        'ladder open rby',
        'play 4 --ladder rby --over 2d',
        'simulate 3 --over 1d',
      ];

      const seqDb = new Database(':memory:');
      const batchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-mock-batch-'));
      const batchDb = new Database(':memory:');
      try {
        for (const line of lines) {
          const runner = new mock.Runner({db: seqDb, mockDir: tmpDir});
          await runner.execLine(line);
        }

        const batchRunner = new mock.Runner({db: batchDb, mockDir: batchDir});
        await batchRunner.runScript(lines.join('\n'));

        const seqEntries = seqDb.getLeaderboardEntries('gen1ou20261109')
          .map(e => ({slug: e.agentSlug, elo: Math.round(e.elo * 100), m: e.matches}));
        const batchEntries = batchDb.getLeaderboardEntries('gen1ou20261109')
          .map(e => ({slug: e.agentSlug, elo: Math.round(e.elo * 100), m: e.matches}));
        expect(seqEntries).toEqual(batchEntries);
      } finally {
        seqDb.close();
        batchDb.close();
        fs.rmSync(batchDir, {recursive: true, force: true});
        fs.rmSync(tmpDir, {recursive: true, force: true});
      }
    });

  test('executes tools/scenarios/e2e.mock against Polka HTTP',
    async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-e2e-'));
      const mockDir = path.join(tmpDir, 'mock');
      const staticDir = path.join(mockDir, 'static');
      const avatarsDir = path.join(staticDir, 'avatars');
      const publicDir = path.join(tmpDir, 'public');
      const poolDir = path.join(tmpDir, 'pool');
      fs.mkdirSync(poolDir, {recursive: true});
      fs.mkdirSync(publicDir, {recursive: true});

      let nowSeconds = 1_760_000_000;
      const db = new Database(':memory:', {now: nowSeconds});

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
        arenaSecret: E2E_ARENA_SECRET,
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
            expect(preHtml).toContain('Eligible');
            expect(preHtml).toContain('(upcoming)');
            expect(preHtml).not.toContain('<fieldset class="form-fieldset" disabled>');

            const pendingRes = await realFetch(`${baseUrl}/account/`, {
              headers: {cookie: cookieFor('asterdev', 1005)},
            });
            const pendingHtml = await pendingRes.text();
            expect(pendingHtml).toContain('Pending');
            expect(pendingHtml).toContain('<fieldset class="form-fieldset" disabled>');

            expect(() => db.setLadderStatus('gen1ou20261109', 'active')).toThrow(/harvested teams/);
          },
          'teams-uploaded': async () => {
            const client = new arena.Client({
              serverUrl: baseUrl,
              arenaSecret: E2E_ARENA_SECRET,
            });
            const fetched = await client.getLadderTeams('gen1ou20261109');
            expect(fetched.ladderId).toBe('gen1ou20261109');
            expect(fetched.count).toBe(4);
            expect(fetched.teams).toHaveLength(4);

            const etagRes = await realFetch(`${baseUrl}/api/arena/ladders/gen1ou20261109/teams`, {
              headers: {
                authorization: `Bearer ${E2E_ARENA_SECRET}`,
                'if-none-match': `"${fetched.sha256}"`,
              },
            });
            expect(etagRes.status).toBe(304);

            expect(() => db.setLadderStatus('gen1ou20261109', 'active')).toThrow(
              /requires at least 2 distinct active entries/
            );
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
              headers: {authorization: `Bearer ${E2E_ARENA_SECRET}`},
            });
            const pendingData = await pendingCheck.json() as {
              submissions: Array<{agentSlug: string; authToken?: string}>;
            };
            expect(pendingData.submissions.find(s => s.agentSlug === '0-error')?.authToken)
              .toBe('Bearer private-r2-token');
          },
          'pre-anchor-rby': () => {
            expect(() => db.setLadderStatus('gen1ou20261109', 'active')).toThrow(
              /no active 1500-Elo anchor/
            );
          },
          'two-vgc-agents': async r => {
            expect(db.getVersionBySlugAndLabel('0-error', '1.0.0')?.authTokenEncoding)
              .toBeUndefined();
            // With only 2 agents on VGC (min = 4), VGC refuses activation and scheduling
            expect(() => db.setLadderStatus('gen9championsvgc2026regmc', 'active')).toThrow(
              /requires at least 4 distinct active entries/
            );
            expect(await r.playNextScheduledMatch({
              ladders: [db.getLadder('gen9championsvgc2026regmc')!],
            })).toBeUndefined();
            const rbyStep = await r.playNextScheduledMatch({
              ladders: [db.getLadder('gen1ou20261109')!],
            });
            expect(rbyStep?.ladderId).toBe('gen1ou20261109');
          },
          'three-vgc-agents': async r => {
            // With 3 agents on VGC (min = 4), VGC still refuses activation and scheduling
            expect(() => db.setLadderStatus('gen9championsvgc2026regmc', 'active')).toThrow(
              /requires at least 4 distinct active entries/
            );
            expect(await r.playNextScheduledMatch({
              ladders: [db.getLadder('gen9championsvgc2026regmc')!],
            })).toBeUndefined();
          },
          'four-vgc-agents': () => {
            const recentVgc = db.getRecentMatches(5)
              .find(m => m.ladderId === 'gen9championsvgc2026regmc');
            expect(recentVgc).toBeDefined();
            expect(recentVgc?.p1.teamLabel).toMatch(/^(?:P[12]:)?[0-9a-f]{12}$/);
            expect(recentVgc?.p2.teamLabel).toMatch(/^(?:P[12]:)?[0-9a-f]{12}$/);
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
          'vgc-rotated': async () => {
            expect(db.getLadder('gen9championsvgc2026regmc')?.status).toBe('settling');
            expect(db.getLadder('gen9championsvgc2027regma')?.status).toBe('upcoming');
            expect(db.getLadder('gen9championsvgc2027regma')?.discord)
              .toBe('1564121375558340768');
            const settlingBattlesRes = await realFetch(
              `${baseUrl}/api/battles.json?ladder=gen9championsvgc2026regmc&limit=5`
            );
            const settlingBattles = await settlingBattlesRes.json() as {
              matches: Array<{games: Array<{logHref?: string}>}>;
            };
            expect(settlingBattles.matches.length).toBeGreaterThan(0);
            expect(settlingBattles.matches[0].games[0].logHref).toBeUndefined();
          },
          'vgc-archived': async () => {
            expect(db.getLadder('gen9championsvgc2026regmc')?.status).toBe('archived');
            const oldVgcDir = path.join(publicDir, 'arena', 'ladders', 'gen9championsvgc2026regmc');
            expect(fs.existsSync(path.join(oldVgcDir, 'gen9championsvgc2026regmc-logs.tar')))
              .toBe(true);
            const archivedBattlesRes = await realFetch(
              `${baseUrl}/api/battles.json?ladder=gen9championsvgc2026regmc&limit=5`
            );
            const archivedBattles = await archivedBattlesRes.json() as {
              matches: Array<{id: string; games: Array<{logHref?: string}>}>;
            };
            expect(archivedBattles.matches.length).toBeGreaterThan(0);
            const firstArchived = archivedBattles.matches[0];
            expect(firstArchived.games[0].logHref).toBe(
              `/arena/ladders/gen9championsvgc2026regmc/${firstArchived.id}a.log`
            );
            expect(firstArchived.games[1].logHref).toBe(
              `/arena/ladders/gen9championsvgc2026regmc/${firstArchived.id}b.log`
            );
            const replayBothRes = await realFetch(
              `${baseUrl}${firstArchived.games[0].logHref}?side=both`
            );
            expect(replayBothRes.status).toBe(200);
            const replayBoth = await replayBothRes.json() as {lines: string[]};
            expect(replayBoth.lines.some(l => l.startsWith('|player|p1|'))).toBe(true);
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
            const mtVer = db.getVersionBySlugAndLabel('mewstruck', '1.0.0')!;
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
          arenaSecret: E2E_ARENA_SECRET,
          sessionSecret: E2E_AUTH.sessionSecret,
          onTimeChange: nextNow => {
            nowSeconds = nextNow;
          },
          onDiscordSync: async () => {
            discordCalls.length = 0;
            const origLog = console.log;
            console.log = () => undefined;
            try {
              await discord.syncArenaRoles(
                db, 'e2e-discord-token', DISCORD_CONFIG, discordState, guildMembers
              );
            } finally {
              console.log = origLog;
            }
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
          'teams-uploaded',
          'after-smoke-fail',
          'pending-auth-token',
          'pre-anchor-rby',
          'two-vgc-agents',
          'three-vgc-agents',
          'four-vgc-agents',
          'third-version-retired',
          'discord-synced',
          'vgc-rotated',
          'vgc-archived',
          'quarantined',
        ]);
      } finally {
        arenaHandle.close();
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        db.close();
        fs.rmSync(tmpDir, {recursive: true, force: true});
      }
    },
    30_000);

  test('streams live battle and tournament SSE updates in Playwright', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-e2e-sse-'));
    const viewPublicDir = path.join(tmpDir, 'public');
    fs.mkdirSync(viewPublicDir, {recursive: true});
    const nowSeconds = 1_760_000_000;
    const sseDb = new Database(':memory:', {now: nowSeconds});

    try {
      sseDb.syncLadders(undefined, nowSeconds);
      sseDb.syncProjectsFromYaml(
        [
          '- name: 0 ERROR',
          '  active: 2026',
          '  arena: {owners: {scheibo: pre.10544}}',
          '- name: Foul Play',
          '  active: 2026',
          '  arena: {owners: {pmariglia: pmariglia.535629}}',
          '- name: Metamon',
          '  active: 2026',
          '  arena: {owners: {metadev: metadev.30001}}',
          '- name: Jaxcalibur',
          '  active: 2026',
          '  arena: {owners: {jaxdev: jaxdev.40001}}',
        ].join('\n'),
        path.join(tmpDir, 'avatars'),
        nowSeconds
      );
      sseDb.db.prepare(
        "UPDATE ladders SET status = 'active' " +
          "WHERE id IN ('gen1ou20261109', 'gen9championsvgc2026regmc')"
      ).run();

      const slugs = ['0-error', 'foul-play', 'metamon', 'jaxcalibur'];
      const vgcLadder = sseDb.getCurrentLadders().find(l => l.slot === 'vgc')!;
      const versions: number[] = [];
      for (let i = 0; i < slugs.length; i++) {
        const agent = sseDb.getAgentBySlug(slugs[i])!;
        sseDb.setAgentLadders(slugs[i], ['rby', 'vgc'], nowSeconds);
        const sub = sseDb.createSubmission({
          agentId: agent.id,
          version: '1.0.0',
          package: 'bundle',
          url: `https://github.com/pkmn/${slugs[i]}.tar.zst`,
          sha256: String(i + 1).repeat(64),
          ladderIds: ['gen1ou20261109', vgcLadder.id],
          now: nowSeconds,
        });
        sseDb.applySubmissionStatus({
          versionId: sub.id,
          smokeStatus: 'passed',
          now: nowSeconds + 1,
        });
        versions.push(sub.id);
      }

      sseDb.upsertTournament({
        id: '2',
        name: 'Tournament #2: Live SV OU',
        format: 'gen9ou',
        version: '0.11.0',
        gamesPerMatchup: 4,
        parallelTables: 2,
        hardware: 'GCP L4 Spot',
        status: 'running',
        startsAt: nowSeconds - 1800,
      });
      for (let i = 0; i < slugs.length; i++) {
        const agent = sseDb.getAgentBySlug(slugs[i])!;
        sseDb.upsertTournamentEntrant({
          tournamentId: '2',
          agentId: agent.id,
          versionId: versions[i],
          seed: i + 1,
          elo: 1600 - i * 40,
          se: 30,
          points: 0,
          gameWins: 0,
          gameLosses: 0,
          gameTies: 0,
        });
      }

      tournaments.renderBattleViewerPage(viewPublicDir);
      const viewApp = polka();
      new auth.Auth({db: sseDb, config: E2E_AUTH}).register(viewApp);
      const viewArena = arena.register(viewApp, {
        db: sseDb,
        arenaSecret: E2E_ARENA_SECRET,
        sessionSecret: E2E_AUTH.sessionSecret,
        publicDir: viewPublicDir,
        now: () => nowSeconds,
      });
      render.register(viewApp, {
        db: sseDb,
        arena: viewArena,
        publicDir: viewPublicDir,
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
      };
      const viewServer = http.createServer((req, res) => {
        const parsedUrl = new URL(req.url ?? '/', 'http://localhost');
        const pathname = decodeURIComponent(parsedUrl.pathname);
        const isStaticArenaFile = pathname.startsWith('/arena/viewer/') ||
          (pathname.endsWith('.log') && !parsedUrl.search);
        const isSsrOrApi = pathname.startsWith('/api/') ||
          pathname === '/projects' ||
          pathname.startsWith('/projects/') ||
          ((pathname === '/arena' || pathname.startsWith('/arena/')) && !isStaticArenaFile);
        if (!isSsrOrApi) {
          for (const rootDir of [viewPublicDir, render.PUBLIC_DIR]) {
            const candidate = path.resolve(rootDir, `.${pathname}`);
            if (candidate.startsWith(rootDir) && fs.existsSync(candidate)) {
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
        }
        void viewApp.handler(req as polka.Request, res);
      });
      await new Promise<void>(resolve => viewServer.listen(0, '127.0.0.1', resolve));
      const viewBaseUrl = `http://127.0.0.1:${(viewServer.address() as {port: number}).port}`;

      const browser = await chromium.launch({args: ['--disable-gpu']});
      try {
        // Real live EventSource SSE interaction test (no SSE stubbing — direct 127.0.0.1!)
        const liveClient = new arena.Client({
          serverUrl: viewBaseUrl,
          arenaSecret: E2E_ARENA_SECRET,
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
        await livePage.clock.install();
        const liveErrors: string[] = [];
        livePage.on('pageerror', err => liveErrors.push(err.message));
        livePage.on('console', msg => {
          if (msg.type() === 'error') liveErrors.push(msg.text());
        });

        // Part A: `/arena/battles/` live SSE updates without refreshing
        await livePage.goto(`${viewBaseUrl}/arena/battles/`, {waitUntil: 'domcontentloaded'});

        // Verify top-right controls & manual theme switcher (`system -> light -> dark -> system`)
        expect(await livePage.evaluate(() => ({
          theme: document.documentElement.getAttribute('data-theme'),
          mode: document.documentElement.getAttribute('data-theme-mode'),
          saved: localStorage.getItem('theme'),
          hasControls: Boolean(
            document.getElementById('theme-toggle') && document.getElementById('account-link')
          ),
        }))).toEqual({theme: 'dark', mode: 'system', saved: null, hasControls: true});

        await livePage.locator('#theme-toggle').click();
        expect(await livePage.evaluate(() => ({
          theme: document.documentElement.getAttribute('data-theme'),
          mode: document.documentElement.getAttribute('data-theme-mode'),
          saved: localStorage.getItem('theme'),
        }))).toEqual({theme: 'light', mode: 'light', saved: 'light'});

        await livePage.reload({waitUntil: 'domcontentloaded'});
        expect(await livePage.evaluate(() => ({
          theme: document.documentElement.getAttribute('data-theme'),
          mode: document.documentElement.getAttribute('data-theme-mode'),
          saved: localStorage.getItem('theme'),
        }))).toEqual({theme: 'light', mode: 'light', saved: 'light'});

        await livePage.locator('#theme-toggle').click();
        expect(await livePage.evaluate(() => ({
          theme: document.documentElement.getAttribute('data-theme'),
          mode: document.documentElement.getAttribute('data-theme-mode'),
          saved: localStorage.getItem('theme'),
        }))).toEqual({theme: 'dark', mode: 'dark', saved: 'dark'});

        await livePage.locator('#theme-toggle').click();
        expect(await livePage.evaluate(() => ({
          theme: document.documentElement.getAttribute('data-theme'),
          mode: document.documentElement.getAttribute('data-theme-mode'),
          saved: localStorage.getItem('theme'),
        }))).toEqual({theme: 'dark', mode: 'system', saved: null});

        // Under light OS, clicking starts opposite (`system -> dark -> light -> system`)
        await livePage.emulateMedia({colorScheme: 'light'});
        await livePage.waitForFunction(
          () => document.documentElement.getAttribute('data-theme') === 'light'
        );
        expect(await livePage.evaluate(() => ({
          theme: document.documentElement.getAttribute('data-theme'),
          mode: document.documentElement.getAttribute('data-theme-mode'),
        }))).toEqual({theme: 'light', mode: 'system'});
        await livePage.locator('#theme-toggle').click();
        expect(await livePage.evaluate(() => ({
          theme: document.documentElement.getAttribute('data-theme'),
          mode: document.documentElement.getAttribute('data-theme-mode'),
          saved: localStorage.getItem('theme'),
        }))).toEqual({theme: 'dark', mode: 'dark', saved: 'dark'});
        await livePage.locator('#theme-toggle').click();
        expect(await livePage.evaluate(() => ({
          theme: document.documentElement.getAttribute('data-theme'),
          mode: document.documentElement.getAttribute('data-theme-mode'),
          saved: localStorage.getItem('theme'),
        }))).toEqual({theme: 'light', mode: 'light', saved: 'light'});
        await livePage.locator('#theme-toggle').click();
        expect(await livePage.evaluate(() => ({
          theme: document.documentElement.getAttribute('data-theme'),
          mode: document.documentElement.getAttribute('data-theme-mode'),
          saved: localStorage.getItem('theme'),
        }))).toEqual({theme: 'light', mode: 'system', saved: null});
        await livePage.emulateMedia({colorScheme: 'dark'});

        await livePage.locator('label[for="bf-vgc"]').click();
        await livePage.waitForFunction(
          () => (document.getElementById('bf-vgc') as HTMLInputElement | undefined)?.checked
        );

        const vgcEntries = sseDb.getLeaderboardEntries(vgcLadder.id)
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
            p1Game1PeakRam: 1050,
            p1Game2PeakRam: 1050,
            p2Game1PeakRam: 1300,
            p2Game2PeakRam: 1300,
            p1Game1BankSeconds: 142,
            p1Game2BankSeconds: 136,
            p2Game1BankSeconds: 130,
            p2Game2BankSeconds: 120,
            p1Game1MeanTurnMillis: 305,
            p1Game2MeanTurnMillis: 305,
            p2Game1MeanTurnMillis: 405,
            p2Game2MeanTurnMillis: 405,
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
        const t2Entrants = sseDb.getTournamentEntrants('2');
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

        // Start Table 2 live over SSE with BOTH players thinking simultaneously!
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
            thinking: true,
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
        expect(await livePage.locator('#clock-sub-p1').textContent()).toBe('thinking…');
        expect(await livePage.locator('#clock-sub-p2').textContent()).toBe('thinking…');

        // Verify BOTH sides' timers decrement simultaneously via Playwright virtual clock!
        await livePage.clock.fastForward(1500);
        const c1After = await livePage.locator('#clock-p1').textContent();
        const c2After = await livePage.locator('#clock-p2').textContent();
        expect(c1After).toBe('02:11');
        expect(c2After).toBe('02:07');

        // P1 commits its decision mid-turn (empty lines) -> P1 is committed, while P2 keeps
        // its elapsed countdown without jumping back to its 128s start-of-turn bank!
        await liveClient.sendTournamentBroadcast('2', {
          table: 2,
          mode: 'append',
          p1: {
            slug: eC.agentSlug,
            name: eC.agentName,
            version: eC.version,
            bankSeconds: 130,
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
          lines: [],
        });
        await livePage.waitForFunction(
          () => document.getElementById('clock-sub-p1')?.textContent === 'committed'
        );
        expect(await livePage.locator('#clock-p1').textContent()).toBe('02:10');
        expect(await livePage.locator('#clock-sub-p2').textContent()).toBe('thinking…');
        expect(await livePage.locator('#clock-p2').textContent()).not.toBe('02:08');

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
            thinking: true,
            incrementSeconds: 10,
          },
          lines: ['|turn|12'],
        });
        await livePage.waitForFunction(
          () => document.querySelector(
            '#games-tbody tr.live-game-row[data-live-game-table="2"] [data-live-table="2"]'
          )?.getAttribute('title')?.includes('Turn 12')
        );

        // Complete Table 2 game -> updates Standings, Crosstable, and prepends replay row!
        const prevWins = eC.gameWins;
        await liveClient.completeTournamentGame('2', {
          table: 2,
          logs: [[
            '|gametype|singles',
            `|player|p1|${eC.agentName}|1`,
            `|player|p2|${eD.agentName}|2`,
            '|turn|12',
            `|win|${eC.agentName}`,
          ].join('\n')],
          game: {
            id: 't2-e2e-live-2',
            stage: 'Round Robin',
            cycle: 9,
            matchupGame: 2,
            outcome: 'W',
            p1: {versionId: eC.versionId},
            p2: {versionId: eD.versionId},
            games: [
              {
                gameNumber: 1,
                seed: '9,8,7,6',
                outcome: 'W',
                turns: 12,
                endReason: 'normal',
                p1: {bankSeconds: 118, meanTurnMillis: 310, peakRam: 4096},
                p2: {bankSeconds: 105, meanTurnMillis: 420, peakRam: 3072},
              },
            ],
            completedAt: nowSeconds + 10,
          },
        });

        await livePage.waitForSelector('#games-tbody tr[data-game-id="t2-e2e-live-2"]');
        expect(await livePage.locator('#standings').textContent()).toContain(
          `${prevWins + 1}–`
        );

        // Click the newly prepended game row -> expands telemetry + inline replay viewer!
        await livePage.locator(
          '#games-tbody tr[data-game-id="t2-e2e-live-2"] td'
        ).first().click();
        const expandedGameDetail = livePage.locator(
          '#games-tbody tr[data-detail-for="t2-e2e-live-2"]:not(.hide)'
        );
        const detailText = await expandedGameDetail.textContent();
        expect(detailText).toContain('9,8,7,6');
        expect(detailText).toContain('12 turns');
        expect(detailText).toContain('310 ms/turn');
        expect(detailText).toContain('4,096 MiB');
        await livePage.waitForSelector(
          '#games-tbody tr[data-detail-for="t2-e2e-live-2"] iframe.replay-viewer-frame'
        );

        // Switch #live back to active Table 1, then start the next battle on Table 1
        // -> #live immediately transitions to the new battle without refreshing!
        await livePage.locator('#series-right [data-live-table="1"]').click();
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
        viewArena.close();
        viewServer.closeAllConnections();
        await new Promise<void>(resolve => viewServer.close(() => resolve()));
      }
    } finally {
      sseDb.close();
      fs.rmSync(tmpDir, {recursive: true, force: true});
    }
  }, 30_000);
});
