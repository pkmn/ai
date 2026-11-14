import {execFileSync} from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import {Teams} from '@pkmn/sim';
import polka from 'polka';

import {Database} from '../db';
import type * as db from '../db';
import * as arena from '../server/arena';
import * as ratings from '../server/ratings';
import * as render from '../server/render';
import {formatPoolTeamLabel} from '../server/teams';
import * as tournaments from '../server/tournaments';
import {syncStaticLiveBanner} from '../static/build';
import {renderTemplate, root} from '../static/util';
import {hashTeam} from '../teams';
import {generateValidVgcTeams} from '../tools/mock';
import {runPkmnCli} from '../tools/pkmn';
import {
  compareShots,
  decodePng,
  diffPngImages,
  encodePng,
  standInSprite,
} from '../tools/shots';

function forceLadderActive(database: Database, id: string) {
  database.db.prepare("UPDATE ladders SET status = 'active' WHERE id = ?").run(id);
}

const NOW = 1_762_800_000;
const DAY_1 = 1_761_800_000;
const DAY_2 = 1_762_664_000;
const DAY_3 = 1_762_750_400;
const ARENA_SECRET = 'test-arena-render-secret';
const HYPERLINK_BIN = root('node_modules', '.bin', 'hyperlink');

const VGC_PASTES_FP = generateValidVgcTeams(20, 0);
const VGC_PASTES_JAX = generateValidVgcTeams(20, 1);

const TEST_PROJECTS_YAML = `
- name: Foul Play
  active: 2019
  license: GPL-3.0
  source: https://github.com/pmariglia/showdown
  arena:
    qualified: true
    owners:
      pmariglia: pmariglia.535629
- name: Metamon
  active: 2024
  license: MIT
  source: https://github.com/UT-Austin-RPL/metamon
  arena:
    qualified: true
    owners:
      jake: jake.20001
- name: Jaxcalibur
  active: 2026
  arena:
    qualified: true
    owners:
      jaxdev: jaxdev.30001
- name: Athena
  active: [2020, 2023]
  arena:
    qualified: true
    owners:
      athenadev: athenadev.40001
- name: Technical Machine
  active: 2010
  license: BSL-1.0
  source: https://github.com/davidstone/technical-machine
  arena:
    owners:
      davidstone: davidstone.50001
`;

function createVersionAndPassSmoke(
  database: db.Database,
  agentSlug: string,
  version: string,
  ladders: string[],
  createdAt: number
): number {
  const agent = database.getAgentBySlug(agentSlug);
  if (!agent) throw new Error(`Missing agent ${agentSlug}`);
  const dev = database.getDevelopersForAgent(agent.id)[0];
  if (!dev) throw new Error(`Missing developer for ${agentSlug}`);
  const ver = database.createSubmission({
    agentId: agent.id,
    developerId: dev.id,
    version,
    package: 'bundle',
    url: `https://github.com/pkmn/${agentSlug}-${version}.tar.zst`,
    sha256: version.padEnd(64, 'a').slice(0, 64),
    ladderIds: ladders,
    now: createdAt,
  });
  database.applySubmissionStatus({
    versionId: ver.id,
    smokeStatus: 'passed',
    unpackedBytes: 20_000_000,
    smokeDurationMillis: 1200,
    smokeTurnMillis: 250,
    smokePeakRam: 512,
    now: createdAt + 5,
  });
  return ver.id;
}

let matchSeq = 0;
function playMatch(
  database: db.Database,
  ladderId: string,
  p1VersionId: number,
  p2VersionId: number,
  g1: ratings.GameOutcome,
  g2: ratings.GameOutcome,
  completedAt: number
) {
  matchSeq++;
  const hex = matchSeq.toString(16).padStart(10, '0');
  const formatPrefix = ladderId.startsWith('gen3ou') ? 'gen3ou' : 'gen1ou';
  const cat = `${g1}${g2}` as ratings.MatchCategory;
  database.recordCompletedMatch({
    match: {
      id: `${formatPrefix}-${hex}`,
      ladderId,
      p1VersionId,
      p2VersionId,
      seed: `1,2,3,${matchSeq}`,
      game1Outcome: g1,
      game2Outcome: g2,
      category: cat,
      game1Turns: 28,
      game2Turns: 32,
      game1EndReason: 'normal',
      game2EndReason: 'normal',
      p1PeakRam: 1180,
      p2PeakRam: 1420,
      p1Game1BankSeconds: 150,
      p1Game2BankSeconds: 142,
      p2Game1BankSeconds: 148,
      p2Game2BankSeconds: 136,
      p1MeanTurnMillis: 390,
      p2MeanTurnMillis: 480,
      completedAt,
    },
  });
}

function seedStaticPublicAssets(tmpPublic: string) {
  fs.mkdirSync(tmpPublic, {recursive: true});
  const realPublic = root('public');
  for (const name of ['index.html', 'favicon.svg', 'cc.svg', 'by.svg', 'sa.svg']) {
    const src = path.join(realPublic, name);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmpPublic, name));
  }
  for (const name of fs.readdirSync(realPublic)) {
    if (name.endsWith('.png') && name.startsWith('favicon')) {
      fs.copyFileSync(path.join(realPublic, name), path.join(tmpPublic, name));
    }
  }
  for (const dir of [
    'glossary', 'research', 'concepts', 'rules', 'release', 'background', 'chat', 'account',
  ]) {
    const srcDir = path.join(realPublic, dir);
    if (fs.existsSync(srcDir)) {
      fs.cpSync(srcDir, path.join(tmpPublic, dir), {recursive: true});
    }
  }
  for (const stub of ['arena', 'projects', 'chat', 'account']) {
    const stubDir = path.join(tmpPublic, stub);
    fs.mkdirSync(stubDir, {recursive: true});
    const stubIdx = path.join(stubDir, 'index.html');
    if (!fs.existsSync(stubIdx)) fs.writeFileSync(stubIdx, '');
  }
}

interface RenderHarnessOptions {
  db: db.Database;
  publicDir: string;
  staticDir?: string;
  avatarsDir?: string;
  liveDoc?: arena.LiveDocument;
  tournamentBroadcast?: tournaments.LiveBroadcast;
  recentMatchesLimit?: number;
  now?: number | (() => number);
}

type RenderHarness = Awaited<ReturnType<typeof startRenderHarness>>;

async function startRenderHarness(opts: RenderHarnessOptions) {
  const nowOpt = opts.now;
  const getNow: () => number = typeof nowOpt === 'function'
    ? nowOpt
    : () => nowOpt ?? NOW;

  tournaments.renderBattleViewerPage(opts.publicDir);
  syncStaticLiveBanner(opts.publicDir, opts.db.getRunningTournament());

  const app = polka();
  const arenaHandle = arena.register(app, {
    db: opts.db,
    arenaSecret: ARENA_SECRET,
    sessionSecret: 'test-session-secret',
    publicDir: opts.publicDir,
    recentMatchesLimit: opts.recentMatchesLimit,
    now: getNow,
    onUpdate: reason => {
      if (reason === 'tournament-status') {
        syncStaticLiveBanner(opts.publicDir, opts.db.getRunningTournament());
      }
    },
  });
  if (opts.liveDoc) {
    arenaHandle.setLiveState({
      live: opts.liveDoc.live,
      stale: opts.liveDoc.stale,
      updatedAt: opts.liveDoc.updatedAt,
    });
  }
  if (opts.tournamentBroadcast) {
    arenaHandle.setTournamentBroadcast(opts.tournamentBroadcast);
  }

  render.register(app, {
    db: opts.db,
    arena: arenaHandle,
    publicDir: opts.publicDir,
    staticDir: opts.staticDir,
    avatarsDir: opts.avatarsDir,
    recentMatchesLimit: opts.recentMatchesLimit,
    now: getNow,
  });

  const server = http.createServer((req, res) => {
    void app.handler(req as polka.Request, res);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as {port: number}).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    arenaHandle,
    getRaw: (route: string, init?: RequestInit) => fetch(`${baseUrl}${route}`, init),
    getText: async (route: string) => {
      const res = await fetch(`${baseUrl}${route}`);
      expect({route, status: res.status}).toEqual({route, status: 200});
      return res.text();
    },
    getJson: async <T>(route: string): Promise<T> => {
      const res = await fetch(`${baseUrl}${route}`);
      expect({route, status: res.status}).toEqual({route, status: 200});
      return res.json() as Promise<T>;
    },
    close: async () => {
      arenaHandle.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

describe('renderTemplate', () => {
  test('substitutes raw or HTML-escaped placeholders in a single pass', () => {
    expect(
      renderTemplate('{{{raw}}}|{{esc}}', {
        raw: '<span>{{esc}}</span>',
        esc: '<script>',
      })
    ).toBe('<span>{{esc}}</span>|&lt;script&gt;');
  });
});

describe('SSR response headers', () => {
  let tmpDir: string;
  let tmpPublic: string;
  let db: db.Database;
  let h: RenderHarness;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-render-hdr-'));
    tmpPublic = path.join(tmpDir, 'public');
    seedStaticPublicAssets(tmpPublic);
    const avatarsDir = path.join(tmpDir, 'svg-avatars');
    fs.mkdirSync(avatarsDir, {recursive: true});
    fs.writeFileSync(
      path.join(avatarsDir, 'foul-play.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>',
      'utf8'
    );

    db = new Database(':memory:', {now: DAY_1});
    db.syncLadders(undefined, DAY_1);
    db.syncProjectsFromYaml(`
- name: Foul Play
  active: 2019
  arena:
    qualified: true
    logo: foul-play.svg
    owners:
      pmariglia: pmariglia.535629
`, avatarsDir, NOW);
    createVersionAndPassSmoke(db, 'foul-play', '1.0.0', ['gen1ou20261109'], DAY_1);
    h = await startRenderHarness({db, publicDir: tmpPublic, avatarsDir});
  });

  afterAll(async () => {
    await h.close();
    db.close();
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  test('serves ETag revalidation with 304 Not Modified on SSR routes', async () => {
    for (const route of ['/arena/', '/arena/index.json', '/arena/ladders/rby/', '/projects/']) {
      const res = await h.getRaw(route);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-cache');
      const etag = res.headers.get('etag');
      expect(etag).toBeTruthy();
      const reval = await h.getRaw(route, {headers: {'If-None-Match': etag!}});
      expect(reval.status).toBe(304);
    }
  });

  test('serves SVG project logos with strict CSP sandbox headers', async () => {
    const svgRes = await h.getRaw('/projects/foul-play.svg');
    expect(svgRes.status).toBe(200);
    expect(svgRes.headers.get('content-type')).toBe('image/svg+xml');
    expect(svgRes.headers.get('content-security-policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; sandbox"
    );
    expect(svgRes.headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('supports HTTP HEAD requests with matching Content-Length or 304', async () => {
    const getArena = await h.getRaw('/arena.json');
    const etag = getArena.headers.get('etag')!;
    const fullText = await getArena.text();

    const headArena = await h.getRaw('/arena.json', {method: 'HEAD'});
    expect(headArena.status).toBe(200);
    expect(headArena.headers.get('etag')).toBe(etag);
    expect(Number(headArena.headers.get('content-length'))).toBe(Buffer.byteLength(fullText));
    expect(await headArena.text()).toBe('');

    const head304 = await h.getRaw('/arena.json', {
      method: 'HEAD',
      headers: {'If-None-Match': etag},
    });
    expect(head304.status).toBe(304);
  });

  test('supports HTTP HEAD on SSE stream endpoints with empty body', async () => {
    const headStream = await h.getRaw('/api/battles/stream', {method: 'HEAD'});
    expect(headStream.status).toBe(200);
    expect(await headStream.text()).toBe('');
  });
});

describe('empty Arena SSR views', () => {
  let tmpDir: string;
  let tmpPublic: string;
  let db: db.Database;
  let h: RenderHarness;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-render-empty-'));
    tmpPublic = path.join(tmpDir, 'public');
    seedStaticPublicAssets(tmpPublic);
    db = new Database(':memory:', {now: DAY_1});
    db.syncLadders(undefined, DAY_1);
    db.syncProjectsFromYaml(TEST_PROJECTS_YAML, path.join(tmpDir, 'avatars'), DAY_1);
    h = await startRenderHarness({db, publicDir: tmpPublic, now: NOW});
  });

  afterAll(async () => {
    await h.close();
    db.close();
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  test('renders empty state without writing static files under ladders or projects', async () => {
    await h.getText('/arena/ladders/rby/');
    await h.getText('/projects/foul-play/');
    expect(fs.existsSync(path.join(tmpPublic, 'arena', 'ladders'))).toBe(false);
    expect(fs.existsSync(path.join(tmpPublic, 'projects', 'foul-play'))).toBe(false);
  });

  test('renders /arena hub with upcoming ladder placeholders', async () => {
    const arenaHtml = await h.getText('/arena/');
    expect(arenaHtml).toContain('<h2>Arena</h2>');
    expect(arenaHtml).toContain('href="/rules/"');
    expect(arenaHtml).toContain('href="/arena/battles/"');
    expect(arenaHtml).toContain('href="/arena/ladders/rby/"');
    expect(arenaHtml).toContain('Upcoming');
    expect(arenaHtml).toContain('No championship tournaments scheduled yet.');
  });

  test('renders upcoming status notice on /arena/ladders/rby/', async () => {
    const rbyLadderHtml = await h.getText('/arena/ladders/rby/');
    expect(rbyLadderHtml).toContain(
      'RBY ladder is upcoming — accepting initial entries before matchmaking begins.'
    );
    expect(rbyLadderHtml).toMatch(/<section[^>]*id="history"[^>]*class="hide"/);
    expect(rbyLadderHtml).toMatch(/<section[^>]*id="matchups"[^>]*class="hide"/);
  });

  test('renders empty standings array on /arena/index.json', async () => {
    const standingsJson = await h.getJson<render.StandingsDocument>('/arena/index.json');
    expect(standingsJson.updatedAt).toBe(NOW);
    expect(Object.keys(standingsJson.ladders)).toEqual(['rby', 'adv', 'sv', 'rand', 'vgc']);
    expect(standingsJson.ladders.rby.standings).toEqual([]);
  });

  test('renders idle live tracker on /arena/battles/', async () => {
    const battlesHtml = await h.getText('/arena/battles/');
    expect(battlesHtml).toContain('No battle currently running — Arena is idle.');
    expect(battlesHtml).toContain('No completed battles yet.');
  });
});

describe('populated Arena leaderboard views', () => {
  let tmpDir: string;
  let tmpPublic: string;
  let db: db.Database;
  let h: RenderHarness;
  const png1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk' +
    '+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  );

  beforeAll(async () => {
    matchSeq = 0;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-render-pop-'));
    tmpPublic = path.join(tmpDir, 'public');
    seedStaticPublicAssets(tmpPublic);
    db = new Database(':memory:', {now: DAY_1});
    db.syncLadders(undefined, DAY_1);
    db.syncProjectsFromYaml(TEST_PROJECTS_YAML, path.join(tmpDir, 'avatars'), DAY_1);

    forceLadderActive(db, 'gen1ou20261109');
    forceLadderActive(db, 'gen3ou20261109');

    const jaxV1 = createVersionAndPassSmoke(db, 'jaxcalibur', '1.0.0', ['gen1ou20261109'], DAY_1);
    const metaAnchor = createVersionAndPassSmoke(db, 'metamon', '1.0.0', ['gen1ou20261109'], DAY_1);
    const foulV1 = createVersionAndPassSmoke(
      db, 'foul-play', '1.4.0', ['gen1ou20261109', 'gen3ou20261109'], DAY_1
    );
    db.setLadderAnchor('gen1ou20261109', 'metamon', '1.0.0', DAY_1 + 10);

    for (let i = 0; i < 36; i++) {
      const g2: ratings.GameOutcome = i % 4 === 0 ? 'L' : 'W';
      playMatch(db, 'gen1ou20261109', jaxV1, metaAnchor, 'W', g2, DAY_1 + 100 + i * 5);
      playMatch(db, 'gen1ou20261109', jaxV1, foulV1, 'W', g2, DAY_1 + 400 + i * 5);
      playMatch(db, 'gen1ou20261109', metaAnchor, foulV1, 'W', 'L', DAY_1 + 700 + i * 5);
    }

    db.refundCooldown('metamon', DAY_2);
    const metaV2 = createVersionAndPassSmoke(
      db, 'metamon', '1.2.0', ['gen1ou20261109', 'gen3ou20261109'], DAY_2
    );
    db.refundCooldown('jaxcalibur', DAY_2);
    const jaxV2 = createVersionAndPassSmoke(db, 'jaxcalibur', '1.1.0', ['gen1ou20261109'], DAY_2);
    db.applySubmissionStatus({
      versionId: jaxV2,
      smokeStatus: 'passed',
      retiredVersionIdsByLadder: {gen1ou20261109: jaxV1},
      now: DAY_2 + 20,
    });

    for (let i = 0; i < 28; i++) {
      const g2: ratings.GameOutcome = i % 6 === 0 ? 'L' : 'W';
      playMatch(db, 'gen1ou20261109', metaV2, foulV1, 'W', g2, DAY_2 + 100 + i * 5);
      playMatch(db, 'gen1ou20261109', metaV2, metaAnchor, 'W', g2, DAY_2 + 300 + i * 5);
      playMatch(db, 'gen3ou20261109', metaV2, foulV1, 'W', g2, DAY_2 + 500 + i * 5);
    }

    for (let i = 0; i < 32; i++) {
      const g1: ratings.GameOutcome = i < 2 ? 'L' : 'W';
      const g2: ratings.GameOutcome = i < 2 ? 'L' : (i < 28 && i % 4 === 0 ? 'L' : 'W');
      playMatch(db, 'gen1ou20261109', jaxV2, metaV2, g1, g2, DAY_3 + 100 + i * 5);
      playMatch(db, 'gen1ou20261109', jaxV2, foulV1, 'W', g2, DAY_3 + 300 + i * 5);
    }

    const athenaV1 = createVersionAndPassSmoke(db, 'athena', '0.9.0', ['gen1ou20261109'], DAY_3);
    for (let i = 0; i < 3; i++) {
      playMatch(db, 'gen1ou20261109', athenaV1, foulV1, 'W', 'W', DAY_3 + 700 + i * 10);
    }

    const avatarsDir = path.join(tmpDir, 'avatars');
    fs.mkdirSync(avatarsDir, {recursive: true});
    fs.writeFileSync(path.join(avatarsDir, 'metamon.png'), png1x1);
    db.syncProjectsFromYaml(TEST_PROJECTS_YAML, avatarsDir, DAY_3 + 800);

    const liveDoc: arena.LiveDocument = {
      updatedAt: NOW - 2,
      stale: false,
      live: {
        heartbeatSeq: 142,
        matchId: 'gen1ou-0000000999',
        ladderId: 'gen1ou20261109',
        slot: 'rby',
        format: 'gen1ou',
        game: 2,
        turn: 27,
        activeSlot: 'p2',
        turnStartedAt: NOW - 3,
        turnBudgetSeconds: 135,
        incrementSeconds: 10,
        game1Summary: {winnerSlot: 'p1', turns: 31},
        p1: {
          slug: 'jaxcalibur',
          name: 'Jaxcalibur',
          version: '1.1.0',
          bankSeconds: 150,
          lastTurnMillis: 380,
          meanTurnMillis: 405,
          ram: 1180,
        },
        p2: {
          slug: 'foul-play',
          name: 'Foul Play',
          version: '1.4.0',
          bankSeconds: 135,
          lastTurnMillis: 520,
          meanTurnMillis: 495,
          ram: 1420,
        },
      },
      recentMatches: db.getRecentMatches(50).map(m => arena.enrichMatchView(tmpPublic, m)),
    };

    h = await startRenderHarness({
      db,
      publicDir: tmpPublic,
      avatarsDir,
      liveDoc,
      recentMatchesLimit: 25,
      now: NOW,
    });
  });

  afterAll(async () => {
    await h.close();
    db.close();
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  test('renders #1 ladder leaders on the /arena hub', async () => {
    const arenaHubHtml = await h.getText('/arena/');
    expect(arenaHubHtml).toContain('href="/arena/ladders/rby/"');
    expect(arenaHubHtml).toContain('href="/arena/ladders/adv/"');
    expect(arenaHubHtml).toContain('href="/projects/jaxcalibur/"');
    expect(arenaHubHtml).toContain('href="/projects/metamon/"');
  });

  test('ranks settled entries with LOS-next probabilities while unranking anchors', async () => {
    const lbHtml = await h.getText('/arena/ladders/rby/');
    const standings = await h.getJson<render.StandingsDocument>('/arena/index.json');
    const rbyRows = standings.ladders.rby.standings;
    const rankedRby = rbyRows.filter(r => r.rank !== undefined);

    expect(rankedRby.map(r => r.rank)).toEqual([1, 2, 3]);
    expect(rankedRby.map(r => r.slug)).toEqual(['jaxcalibur', 'metamon', 'foul-play']);
    expect(rankedRby[0].losNext!).toBeGreaterThan(90);
    expect(rankedRby[1].losNext).toBeDefined();
    expect(rankedRby[2].losNext).toBeUndefined();

    const anchorRow = rbyRows.find(r => r.slug === 'metamon' && r.version === '1.0.0')!;
    expect(anchorRow.isAnchor).toBe(true);
    expect(anchorRow.elo).toBe(1500);
    expect(anchorRow.ci95).toBe(0);
    expect(anchorRow.rank).toBeUndefined();
    expect(lbHtml).toContain('±0');
  });

  test('marks unsettled entries provisional while hiding retired entries by default', async () => {
    const lbHtml = await h.getText('/arena/ladders/rby/');
    const standings = await h.getJson<render.StandingsDocument>('/arena/index.json');
    const rbyRows = standings.ladders.rby.standings;

    const athenaRow = rbyRows.find(r => r.slug === 'athena');
    expect(athenaRow?.provisional).toBe(true);
    expect(athenaRow?.rank).toBeUndefined();
    expect(athenaRow?.streak).toBe('W3');
    expect(lbHtml).toContain('class="provisional"');

    const retiredRow = rbyRows.find(r => r.slug === 'jaxcalibur' && r.version === '1.0.0');
    expect(retiredRow?.role).toBe('retired');
    expect(lbHtml).toContain('data-retired="true"');
  });

  test('spaces rating history SVG polyline points proportionally by UTC day', async () => {
    const lbHtml = await h.getText('/arena/ladders/rby/');
    expect(lbHtml).toContain('viewBox="0 0 760 245"');
    expect(lbHtml).toContain('<polygon ');
    expect(lbHtml).toContain('title="1.1.0"');
    const polylines = Array.from(
      lbHtml.matchAll(/<polyline[^>]*points="([^"]+)"/g),
      m => m[1].trim().split(/\s+/).map(pt => Number(pt.split(',')[0]))
    );
    const threePoint = polylines.find(xs => xs.length >= 3);
    expect(threePoint).toBeDefined();
    expect(threePoint![1] - threePoint![0]).toBeGreaterThan((threePoint![2] - threePoint![1]) * 5);
  });

  test('renders head-to-head matchup matrix across active entries', async () => {
    const lbHtml = await h.getText('/arena/ladders/rby/');
    const matrixHeadMatch =
      /<table class="matrix">\s*<thead>\s*<tr>([\s\S]*?)<\/tr>\s*<\/thead>/.exec(lbHtml);
    expect(matrixHeadMatch).not.toBeNull();
    expect(matrixHeadMatch![1].match(/<th\b/g) ?? []).toHaveLength(4);
    expect(lbHtml).toContain('<td class="diag">—</td>');
    expect(lbHtml).toContain('hm-w4');
    expect(lbHtml).toContain('hm-l4');
  });

  test('renders live battle tracker with turn clocks on /arena/battles/', async () => {
    const batHtml = await h.getText('/arena/battles/');
    expect(batHtml).toContain('gen1ou-0000000999');
    expect(batHtml).toContain('[Gen 1] OU');
    expect(batHtml).toContain('Game 2 / 2');
    expect(batHtml).toContain('PAUSED');
    expect(batHtml).toContain('RUNNING');
    expect(batHtml).toContain('>3s<');
    expect(batHtml).toContain('>132s<');
    expect(batHtml).toContain('8.2%');
    expect(batHtml).toContain('9.9%');
    expect(batHtml).not.toContain('minisprites');
  });

  test('orders Arena entries ahead of alphabetical entries on /projects/', async () => {
    const projHtml = await h.getText('/projects/');
    expect(projHtml).toContain('data-arena="true"');
    expect(projHtml).toContain('<em>(provisional)</em>');
    const posMetamon = projHtml.indexOf('id="Metamon"');
    const posFoulPlay = projHtml.indexOf('id="FoulPlay"');
    const posEevenator = projHtml.indexOf('id="eevenator"');
    const posAthena = projHtml.indexOf('id="Athena"');
    const posAbra = projHtml.indexOf('id="IHTFPAbra"');
    expect(posMetamon).toBeGreaterThan(0);
    expect(posMetamon).toBeLessThan(posEevenator);
    expect(posFoulPlay).toBeLessThan(posEevenator);
    expect(posAbra).toBeLessThan(posAthena);
  });

  test('serves PNG project avatars on /projects/:slug.png', async () => {
    const logoRes = await h.getRaw('/projects/metamon.png');
    expect(logoRes.status).toBe(200);
    expect(logoRes.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await logoRes.arrayBuffer())).toEqual(png1x1);
  });

  test('renders /projects/:slug statistical profile with version selector', async () => {
    const metaProfileHtml = await h.getText('/projects/metamon/');
    expect(metaProfileHtml).toContain('id="agent-profile"');
    expect(metaProfileHtml).toContain('src="/projects/metamon.png"');
    expect(metaProfileHtml).toContain('UT-Austin-RPL/metamon');
    expect(metaProfileHtml).toContain('id="ver-select"');
    expect(metaProfileHtml).toContain('1.2.0 (active)');
    expect(metaProfileHtml).toContain('1.0.0 (active)');
    expect(metaProfileHtml).toContain('class="h2h-table"');
    expect(metaProfileHtml).toContain('Top 10');
  });

  test('gates profile Best Matchup or Nemesis callouts on at least 10 matches', async () => {
    const foulProfileHtml = await h.getText('/projects/foul-play/');
    expect(foulProfileHtml).not.toMatch(/Athena[\s\S]{0,80}Nemesis/);
  });

  test('renders profile pages for Pending projects without ladder entries', async () => {
    const tmProfileHtml = await h.getText('/projects/technical-machine/');
    expect(tmProfileHtml).toContain('davidstone/technical-machine');
    expect(tmProfileHtml).toContain('No Arena ladder entries yet.');
  });

  test('redirects non-Arena project slugs to /projects/#<id>', async () => {
    const res = await h.getRaw('/projects/eevenator', {redirect: 'manual'});
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/projects/#eevenator');
  });

  test('passes hyperlink anchor checks across rendered static pages', () => {
    const hlOut = execFileSync(HYPERLINK_BIN, [tmpPublic, '--check-anchors'], {encoding: 'utf8'});
    expect(hlOut).toContain('Found 0 bad links');
    expect(hlOut).toContain('Found 0 bad anchors');
  });
});

describe('project de-registration', () => {
  test('demotes removed Arena projects to /projects/#<id> redirects', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-render-dereg-'));
    const tmpPublic = path.join(tmpDir, 'public');
    seedStaticPublicAssets(tmpPublic);
    const db = new Database(':memory:', {now: DAY_1});
    db.syncLadders(undefined, DAY_1);
    db.syncProjectsFromYaml(TEST_PROJECTS_YAML, path.join(tmpDir, 'avatars'), DAY_1);
    const h = await startRenderHarness({db, publicDir: tmpPublic, now: NOW});
    try {
      const withoutAthena = TEST_PROJECTS_YAML.replace(/- name: Athena[\s\S]*?40001\n/, '');
      db.syncProjectsFromYaml(withoutAthena, path.join(tmpDir, 'avatars'), NOW + 5);
      const athenaAfter = await h.getRaw('/projects/athena', {redirect: 'manual'});
      expect(athenaAfter.status).toBe(302);
      expect(athenaAfter.headers.get('location')).toBe('/projects/#athena');
      expect((await h.getRaw('/projects/athena.json')).status).toBe(404);
    } finally {
      await h.close();
      db.close();
      fs.rmSync(tmpDir, {recursive: true, force: true});
    }
  });
});

describe('tournament SSR views', () => {
  let tmpDir: string;
  let tmpPublic: string;
  let db: db.Database;
  let h: RenderHarness;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-render-tour-'));
    tmpPublic = path.join(tmpDir, 'public');
    seedStaticPublicAssets(tmpPublic);
    db = new Database(':memory:', {now: DAY_1});
    db.syncLadders(undefined, DAY_1);
    db.syncProjectsFromYaml(TEST_PROJECTS_YAML, path.join(tmpDir, 'avatars'), DAY_1);
    forceLadderActive(db, 'gen9ou20261109');

    const vMeta = createVersionAndPassSmoke(db, 'metamon', '1.3.0', ['gen9ou20261109'], DAY_1);
    const vFoul = createVersionAndPassSmoke(db, 'foul-play', '1.4.0', ['gen9ou20261109'], DAY_1);
    const vJax = createVersionAndPassSmoke(db, 'jaxcalibur', '2.1.0', ['gen9ou20261109'], DAY_1);

    const agentMeta = db.getAgentBySlug('metamon')!;
    const agentFoul = db.getAgentBySlug('foul-play')!;
    const agentJax = db.getAgentBySlug('jaxcalibur')!;

    db.upsertTournament({
      id: '2',
      name: 'Autumn ’26 — [Gen 9] OU (BYOT)',
      format: 'gen9ou',
      gamesPerMatchup: 50,
      parallelTables: 4,
      hardware: 'Isolated GCP g2-custom-24-49152 VMs (1× NVIDIA L4 24GB)',
      status: 'running',
      startsAt: DAY_2,
    });
    db.upsertTournament({
      id: '1',
      name: 'Spring ’26 — [Gen 1] OU',
      format: 'gen1ou',
      gamesPerMatchup: 50,
      parallelTables: 2,
      hardware: 'Isolated GCP c3-standard-22 VMs',
      status: 'completed',
      startsAt: DAY_1,
      completedAt: DAY_1 + 86400,
    });
    db.upsertTournament({
      id: '3',
      name: 'Summer ’26 — VGC Reg M-D (Scheduled)',
      format: 'gen9championsvgc2026regmc',
      gamesPerMatchup: 8,
      parallelTables: 2,
      hardware: 'GCP L4 Spot · 24 vCPU · 48 GB RAM',
      status: 'scheduled',
      startsAt: NOW + 14 * 86400,
    });

    db.upsertTournamentEntrant({
      tournamentId: '1',
      agentId: agentJax.id,
      versionId: vJax,
      seed: 1,
      points: 72.0,
      sonnebornBerger: 2400,
      gameWins: 70,
      gameLosses: 26,
      gameTies: 4,
      elo: 1740,
      se: 15,
      finalRank: 1,
    });
    db.upsertTournamentEntrant({
      tournamentId: '1',
      agentId: agentMeta.id,
      versionId: vMeta,
      seed: 2,
      points: 55.0,
      sonnebornBerger: 1800,
      gameWins: 54,
      gameLosses: 44,
      gameTies: 2,
      elo: 1650,
      se: 15,
      finalRank: 2,
    });
    db.upsertTournamentEntrant({
      tournamentId: '2',
      agentId: agentMeta.id,
      versionId: vMeta,
      seed: 1,
      points: 65.5,
      sonnebornBerger: 2150,
      gameWins: 64,
      gameLosses: 33,
      gameTies: 3,
      elo: 1710,
      se: 16,
      finalRank: 1,
    });
    db.upsertTournamentEntrant({
      tournamentId: '2',
      agentId: agentFoul.id,
      versionId: vFoul,
      seed: 2,
      points: 54.0,
      sonnebornBerger: 1820,
      gameWins: 52,
      gameLosses: 44,
      gameTies: 4,
      elo: 1645,
      se: 16,
      finalRank: 2,
    });
    db.upsertTournamentEntrant({
      tournamentId: '2',
      agentId: agentJax.id,
      versionId: vJax,
      seed: 3,
      points: 30.5,
      sonnebornBerger: 980,
      gameWins: 30,
      gameLosses: 69,
      gameTies: 1,
      elo: 1490,
      se: 18,
      finalRank: 3,
    });

    const teamA = [
      '|Dragapult|Choice Specs',
      '|Great Tusk|Booster Energy',
      '|Gholdengo|Air Balloon',
      '|Kingambit|Leftovers',
      '|Glimmora|Focus Sash',
      '|Ogerpon-Wellspring|Wellspring Mask',
    ].join(']');
    const teamB = [
      '|Ting-Lu|Leftovers',
      '|Zamazenta|Heavy-Duty Boots',
      '|Slowking-Galar|Heavy-Duty Boots',
      '|Raging Bolt|Booster Energy',
      '|Darkrai|Focus Sash',
      '|Corviknight|Rocky Helmet',
    ].join(']');

    db.upsertTournamentGame({
      id: 'gen9ou-0000000101',
      tournamentId: '2',
      stage: 'Round Robin',
      cycle: 1,
      matchupGame: 1,
      p1VersionId: vMeta,
      p2VersionId: vFoul,
      seed: '1,2,3,101',
      status: 'completed',
      p1Team: teamA,
      p2Team: teamB,
      outcome: 'W',
      turns: 34,
      endReason: 'normal',
      p1BankSeconds: 145,
      p2BankSeconds: 112,
      completedAt: DAY_3,
    });
    db.upsertTournamentGame({
      id: 'gen9ou-0000000102',
      tournamentId: '2',
      stage: 'Round Robin',
      cycle: 2,
      matchupGame: 1,
      p1VersionId: vMeta,
      p2VersionId: vJax,
      seed: '1,2,3,102',
      status: 'completed',
      p1Team: teamA,
      p2Team: '|Pikachu|Light Ball',
      outcome: 'T',
      turns: 100,
      endReason: 'tie-100-turns',
      p1BankSeconds: 90,
      p2BankSeconds: 80,
      completedAt: DAY_3 + 60,
    });
    db.upsertTournamentGame({
      id: 'gen9ou-0000000201',
      tournamentId: '2',
      stage: 'Superfinal',
      cycle: 1,
      matchupGame: 63,
      p1VersionId: vFoul,
      p2VersionId: vMeta,
      seed: '1,2,3,201',
      status: 'completed',
      p1Team: teamB,
      p2Team: teamA,
      outcome: 'L',
      turns: 29,
      endReason: 'normal',
      p1BankSeconds: 115,
      p2BankSeconds: 150,
      completedAt: DAY_3 + 120,
    });

    const lines = [
      '|gametype|singles',
      '|player|p1|Metamon|1',
      '|player|p2|Foul Play|2',
      '|gen|9',
      '|tier|[Gen 9] OU',
      '|start',
      '|switch|p1a: Kingambit|Kingambit, M|100/100',
      '|switch|p2a: Zamazenta|Zamazenta|100/100',
      '|turn|22',
    ];
    const broadcast: tournaments.LiveBroadcast = {
      tournamentId: '2',
      tables: [
        {
          table: 1,
          label: 'Table 1 (Superfinal)',
          stage: 'Superfinal',
          matchupGame: 64,
          p1: {
            slug: 'metamon',
            name: 'Metamon',
            version: '1.3.0',
            bankSeconds: 145,
            thinking: false,
            incrementSeconds: 10,
          },
          p2: {
            slug: 'foul-play',
            name: 'Foul Play',
            version: '1.4.0',
            bankSeconds: 112,
            thinking: true,
            incrementSeconds: 10,
          },
          lines,
        },
        {table: 2, label: 'Table 2', idle: true},
      ],
      seriesLeftHtml: '<strong>Superfinal</strong> · Game 64 / 100',
      seriesRightHtml:
        '<strong>Metamon</strong> <strong>35.5</strong> — <strong>27.5</strong> ' +
        '<strong>Foul Play</strong> <span class="muted">(+65 Elo)</span>',
      p1: {name: 'Metamon', bankSeconds: 145, thinking: false, incrementSeconds: 10},
      p2: {name: 'Foul Play', bankSeconds: 112, thinking: true, incrementSeconds: 10},
      lines,
    };

    h = await startRenderHarness({
      db,
      publicDir: tmpPublic,
      tournamentBroadcast: broadcast,
      now: NOW,
    });
  });

  afterAll(async () => {
    await h.close();
    db.close();
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  test('renders Showdown replay viewer shell at /arena/viewer/', () => {
    const viewerHtml = fs.readFileSync(
      path.join(tmpPublic, 'arena', 'viewer', 'index.html'),
      'utf8'
    );
    expect(viewerHtml).toContain('.trainersprite');
    expect(viewerHtml).toContain('play.pokemonshowdown.com');
  });

  test('renders ongoing or completed tournament summaries on /arena/', async () => {
    const arenaHubHtml = await h.getText('/arena/');
    expect(arenaHubHtml).toContain('href="/arena/tournaments/2/"');
    expect(arenaHubHtml).toContain('href="/arena/tournaments/1/"');
    expect(arenaHubHtml).toContain('href="/arena/tournaments/3/"');
    expect(arenaHubHtml).toContain('Live');
    expect(arenaHubHtml).toContain('70–26–4');
    expect(arenaHubHtml).toContain('href="/projects/jaxcalibur/"');
  });

  test('renders tournament pages with event switcher or per-event rules', async () => {
    const tourney2Html = await h.getText('/arena/tournaments/2/');
    const tourney1Html = await h.getText('/arena/tournaments/1/');
    const tourney3Html = await h.getText('/arena/tournaments/3/');
    expect(tourney2Html).toContain('id="event-select"');
    expect(tourney2Html).toContain('value="/arena/tournaments/1/"');
    expect(tourney1Html).toMatch(/<section[^>]*id="live"[^>]*class="hide"/);
    expect(tourney1Html).toContain('Tournament #1');
    expect(tourney2Html).toContain('Tournament #2');
    expect(tourney3Html).toContain('Tournament #3');
  });

  test('renders multi-table live clocks with sandboxed viewer iframe', async () => {
    const tourney2Html = await h.getText('/arena/tournaments/2/');
    expect(tourney2Html).toContain('class="clock-bar"');
    expect(tourney2Html).toContain('02:25');
    expect(tourney2Html).toContain('01:52');
    expect(tourney2Html).toContain('thinking…');
    expect(tourney2Html).toContain('src="/arena/viewer/"');
    expect(tourney2Html).toContain('sandbox="allow-scripts"');
    expect(tourney2Html).toContain('data-live-table="1"');
  });

  test('renders Superfinal badges with team minisprites in tournament games', async () => {
    const tourney2Html = await h.getText('/arena/tournaments/2/');
    expect(tourney2Html).toContain('<span class="muted">SF</span>');
    expect(tourney2Html).toContain('<code>SF63</code>');
    expect(tourney2Html).toContain('<code>RR1</code>');
    expect(tourney2Html).toContain('½–½');
    expect(tourney2Html).toContain(
      'https://www.smogon.com/forums/media/minisprites/dragapult.png'
    );
    expect(tourney2Html).toContain(
      'https://www.smogon.com/forums/media/minisprites/pikachu.png'
    );
  });

  test('omits static rules prose from /arena/tournaments/:id/index.json', async () => {
    const tourney2Json = await h.getJson<{
      id: string;
      standings: Array<{slug: string; sonnebornBerger: number}>;
    }>('/arena/tournaments/2/index.json');
    expect(tourney2Json.id).toBe('2');
    expect(tourney2Json).not.toHaveProperty('rulesHtml');
    expect(tourney2Json.standings[0].slug).toBe('metamon');
    expect(tourney2Json.standings[0].sonnebornBerger).toBe(2150);
    expect((await h.getRaw('/tours/1.json')).status).toBe(404);
    expect((await h.getRaw('/arena/tournaments/1/rules.json')).status).toBe(404);
  });
});

describe('SSR cache invalidation', () => {
  let tmpDir: string;
  let tmpPublic: string;
  let db: db.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-render-inv-'));
    tmpPublic = path.join(tmpDir, 'public');
    seedStaticPublicAssets(tmpPublic);
    db = new Database(':memory:', {now: DAY_1});
    db.syncLadders(undefined, DAY_1);
    db.syncProjectsFromYaml(TEST_PROJECTS_YAML, path.join(tmpDir, 'avatars'), DAY_1);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  test('invalidates /arena/battles/ ETag immediately on POST /api/arena/match-complete',
    async () => {
      forceLadderActive(db, 'gen1ou20261109');
      const v1 = createVersionAndPassSmoke(db, 'metamon', '1.0.0', ['gen1ou20261109'], DAY_1);
      const v2 = createVersionAndPassSmoke(db, 'foul-play', '1.4.0', ['gen1ou20261109'], DAY_1);
      const h = await startRenderHarness({db, publicDir: tmpPublic, now: NOW});

      try {
        const initialRes = await h.getRaw('/arena/battles/');
        const initialEtag = initialRes.headers.get('etag')!;
        expect(
          (await h.getRaw('/arena/battles/', {headers: {'If-None-Match': initialEtag}})).status
        ).toBe(304);

        const res = await fetch(`${h.baseUrl}/api/arena/match-complete`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${ARENA_SECRET}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            match: {
              id: 'gen1ou-0000000abc',
              ladderId: 'gen1ou20261109',
              p1VersionId: v1,
              p2VersionId: v2,
              seed: '1,2,3,4',
              game1Outcome: 'W',
              game2Outcome: 'W',
              category: 'WW',
              game1Turns: 25,
              game2Turns: 30,
              game1EndReason: 'normal',
              game2EndReason: 'normal',
              p1PeakRam: 900,
              p2PeakRam: 1100,
              p1Game1BankSeconds: 150,
              p1Game2BankSeconds: 150,
              p2Game1BankSeconds: 140,
              p2Game2BankSeconds: 135,
              p1MeanTurnMillis: 300,
              p2MeanTurnMillis: 420,
              completedAt: NOW,
            },
          }),
        });
        expect(res.status).toBe(200);

        const afterRes = await h.getRaw('/arena/battles/', {
          headers: {'If-None-Match': initialEtag},
        });
        expect(afterRes.status).toBe(200);
        expect(afterRes.headers.get('etag')).not.toBe(initialEtag);
        expect(await afterRes.text()).toContain('gen1ou-0000000abc');
      } finally {
        await h.close();
      }
    });

  test('updates /arena/index.json anchor rating immediately after pkmn set-anchor', async () => {
    forceLadderActive(db, 'gen1ou20261109');
    const v1 = createVersionAndPassSmoke(db, 'metamon', '1.0.0', ['gen1ou20261109'], DAY_1);
    const v2 = createVersionAndPassSmoke(db, 'foul-play', '1.4.0', ['gen1ou20261109'], DAY_1);
    playMatch(db, 'gen1ou20261109', v1, v2, 'W', 'W', NOW);

    const h = await startRenderHarness({db, publicDir: tmpPublic, now: NOW});
    try {
      await h.getJson<render.StandingsDocument>('/arena/index.json');
      await runPkmnCli(['set-anchor', 'gen1ou20261109', 'foul-play', '1.4.0'], {
        db,
        publicDir: tmpPublic,
        now: NOW + 10,
        log: () => undefined,
      });
      const updated = await h.getJson<render.StandingsDocument>('/arena/index.json');
      const foulAnchor = updated.ladders.rby.standings.find(s => s.slug === 'foul-play');
      expect(foulAnchor?.isAnchor).toBe(true);
      expect(foulAnchor?.elo).toBe(1500);
      expect(foulAnchor?.ci95).toBe(0);
    } finally {
      await h.close();
    }
  });

  function seedInlineVgcBattleFixture() {
    forceLadderActive(db, 'gen9championsvgc2026regmc');
    const vFoul = createVersionAndPassSmoke(
      db, 'foul-play', '1.4.0', ['gen9championsvgc2026regmc'], DAY_1
    );
    const vJax = createVersionAndPassSmoke(
      db, 'jaxcalibur', '1.1.0', ['gen9championsvgc2026regmc'], DAY_1
    );

    const unknownHash = hashTeam('|Incineroar|Sitrus Berry]Rillaboom|Assault Vest');
    const p1OwnedHash = formatPoolTeamLabel('|Archaludon|Power Herb]Pelipper|Focus Sash', 'P1');

    db.recordCompletedMatch({
      match: {
        id: 'vgc-0000001',
        ladderId: 'gen9championsvgc2026regmc',
        p1VersionId: vFoul,
        p2VersionId: vJax,
        seed: '99,88,77,66',
        p1TeamLabel: unknownHash,
        p2TeamLabel: p1OwnedHash,
        game1Outcome: 'W',
        game2Outcome: 'L',
        category: 'WL',
        game1Turns: 11,
        game2Turns: 14,
        game1EndReason: 'normal',
        game2EndReason: 'timeout',
        p1PeakRam: 1240,
        p2PeakRam: 2150,
        p1Game1BankSeconds: 132,
        p1Game2BankSeconds: 118,
        p2Game1BankSeconds: 104,
        p2Game2BankSeconds: 0,
        p1MeanTurnMillis: 310,
        p2MeanTurnMillis: 640,
        completedAt: NOW - 60,
      },
    });

    const liveDoc: arena.LiveDocument = {
      updatedAt: NOW,
      stale: false,
      live: {
        heartbeatSeq: 9,
        matchId: 'vgc-0000002',
        ladderId: 'gen9championsvgc2026regmc',
        slot: 'vgc',
        format: 'gen9championsvgc2026regmc',
        game: 1,
        turn: 4,
        activeSlot: 'p1',
        turnStartedAt: NOW - 2,
        turnBudgetSeconds: 148,
        incrementSeconds: 25,
        p1: {
          slug: 'foul-play',
          name: 'Foul Play',
          version: '1.4.0',
          bankSeconds: 148,
          lastTurnMillis: 290,
          meanTurnMillis: 300,
          ram: 1200,
          team: unknownHash,
        },
        p2: {
          slug: 'jaxcalibur',
          name: 'Jaxcalibur',
          version: '1.1.0',
          bankSeconds: 145,
          lastTurnMillis: 410,
          meanTurnMillis: 405,
          ram: 2100,
          team: p1OwnedHash,
        },
      },
      recentMatches: db.getRecentMatches(50).map(m => arena.enrichMatchView(tmpPublic, m)),
    };

    return {unknownHash, p1OwnedHash, liveDoc};
  }

  test('renders inline expandable battle details with pool team hashes', async () => {
    const {unknownHash, p1OwnedHash, liveDoc} = seedInlineVgcBattleFixture();
    const h = await startRenderHarness({db, publicDir: tmpPublic, liveDoc, now: NOW});
    try {
      const battlesIndex = await h.getText('/arena/battles/');
      expect(battlesIndex).toContain(`Team: <code>${unknownHash}</code>`);
      expect(battlesIndex).toContain(`Team: <code>${p1OwnedHash}</code>`);
      expect(battlesIndex).toContain('data-detail-for="vgc-0000001"');
      expect(battlesIndex).toContain('99,88,77,66');
      expect(battlesIndex).toContain('Timeout');
      expect(battlesIndex).toContain('id="battles-pager"');

      const fpProfile = await h.getText('/projects/foul-play/');
      expect(fpProfile).toContain('data-detail-for="vgc-0000001"');
      expect(fpProfile).toContain('99,88,77,66');
    } finally {
      await h.close();
    }
  });

  test('returns 404 on per-battle subroutes while redirecting /battles', async () => {
    const {liveDoc} = seedInlineVgcBattleFixture();
    const h = await startRenderHarness({db, publicDir: tmpPublic, liveDoc, now: NOW});
    try {
      expect((await h.getRaw('/arena/battles/vgc-0000001')).status).toBe(404);
      expect((await h.getRaw('/arena/battles/vgc-0000001.json')).status).toBe(404);
      const aliasRedirect = await h.getRaw('/battles', {redirect: 'manual'});
      expect(aliasRedirect.status).toBe(302);
      expect(aliasRedirect.headers.get('location')).toBe('/arena/battles/');
    } finally {
      await h.close();
    }
  });

  test('syncs [LIVE] #topbar banner onto non-placeholder static pages until completed',
    async () => {
      db.upsertTournament({
        id: '2',
        name: 'Tournament #2: VGC 2026 Reg M-C OTS BO3',
        format: 'gen9championsvgc2026regmc',
        gamesPerMatchup: 8,
        parallelTables: 2,
        hardware: 'GCP L4 Spot',
        status: 'running',
        startsAt: NOW - 1800,
      });
      const h = await startRenderHarness({db, publicDir: tmpPublic, now: NOW});
      try {
        expect(fs.readFileSync(path.join(tmpPublic, 'index.html'), 'utf8'))
          .toContain('[LIVE] Tournament #2: VGC 2026 Reg M-C OTS BO3');
        expect(fs.readFileSync(path.join(tmpPublic, 'rules', 'index.html'), 'utf8'))
          .toContain('[LIVE] Tournament #2: VGC 2026 Reg M-C OTS BO3');
        expect(fs.readFileSync(path.join(tmpPublic, 'background', 'index.html'), 'utf8'))
          .not.toContain('[LIVE]');

        await runPkmnCli(
          ['set-tournament-status', '2', 'completed'],
          {db, publicDir: tmpPublic, now: NOW + 60, log: () => undefined}
        );
        expect(fs.readFileSync(path.join(tmpPublic, 'index.html'), 'utf8')).not.toContain('[LIVE]');
        expect(await h.getText('/arena/battles/')).not.toContain('[LIVE]');
      } finally {
        await h.close();
      }
    });
});

describe('JSON route parity & retired pool archives', () => {
  let tmpDir: string;
  let tmpPublic: string;
  let db: db.Database;

  const packAll = (pastes: string[]) => pastes.map(p => Teams.pack(Teams.import(p)));

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-render-archive-'));
    tmpPublic = path.join(tmpDir, 'public');
    seedStaticPublicAssets(tmpPublic);
    db = new Database(':memory:', {now: DAY_1});
    db.syncLadders(undefined, DAY_1);
    db.syncProjectsFromYaml(TEST_PROJECTS_YAML, path.join(tmpDir, 'avatars'), DAY_1);
    forceLadderActive(db, 'gen1ou20261109');
    forceLadderActive(db, 'gen9championsvgc2026regmc');

    const fpAgent = db.getAgentBySlug('foul-play')!;
    const jaxAgent = db.getAgentBySlug('jaxcalibur')!;
    const fpSub = db.createSubmission({
      agentId: fpAgent.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://github.com/pkmn/fp.tar.zst',
      sha256: 'a'.repeat(64),
      ladderIds: ['gen1ou20261109', 'gen9championsvgc2026regmc'],
      teamsByLadder: {gen9championsvgc2026regmc: packAll(VGC_PASTES_FP)},
      now: DAY_1,
    });
    const jaxSub = db.createSubmission({
      agentId: jaxAgent.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://github.com/pkmn/jax.tar.zst',
      sha256: 'b'.repeat(64),
      ladderIds: ['gen1ou20261109', 'gen9championsvgc2026regmc'],
      teamsByLadder: {gen9championsvgc2026regmc: packAll(VGC_PASTES_JAX)},
      now: DAY_1,
    });
    db.applySubmissionStatus({versionId: fpSub.id, smokeStatus: 'passed', now: DAY_1 + 5});
    db.applySubmissionStatus({versionId: jaxSub.id, smokeStatus: 'passed', now: DAY_1 + 5});

    db.recordCompletedMatch({
      match: {
        id: 'vgc-retire-01',
        ladderId: 'gen9championsvgc2026regmc',
        p1VersionId: fpSub.id,
        p2VersionId: jaxSub.id,
        seed: '1,2,3,4',
        game1Outcome: 'W',
        game2Outcome: 'W',
        category: 'WW',
        game1Turns: 12,
        game2Turns: 14,
        game1EndReason: 'normal',
        game2EndReason: 'normal',
        p1PeakRam: 900,
        p2PeakRam: 950,
        p1Game1BankSeconds: 150,
        p1Game2BankSeconds: 148,
        p2Game1BankSeconds: 144,
        p2Game2BankSeconds: 140,
        p1MeanTurnMillis: 300,
        p2MeanTurnMillis: 340,
        p1TeamLabel: formatPoolTeamLabel(packAll(VGC_PASTES_FP)[0], 'P1'),
        p2TeamLabel: formatPoolTeamLabel(packAll(VGC_PASTES_JAX)[0], undefined),
        completedAt: DAY_2,
      },
    });

    db.upsertTournament({
      id: '1',
      name: 'Tournament #1: VGC 2026 Reg M-C OTS BO3',
      format: 'gen9championsvgc2026regmc',
      gamesPerMatchup: 18,
      parallelTables: 4,
      hardware: 'GCP L4 Spot',
      status: 'completed',
      startsAt: DAY_1,
      completedAt: DAY_2,
    });
    db.upsertTournamentEntrant({
      tournamentId: '1',
      agentId: fpAgent.id,
      versionId: fpSub.id,
      seed: 1,
      elo: 1620,
      se: 30,
      points: 12,
      gameWins: 12,
      gameLosses: 6,
      gameTies: 0,
      finalRank: 1,
    });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  test('serves identical payloads on <route>.json or <route>/index.json for DB pages', async () => {
    const h = await startRenderHarness({db, publicDir: tmpPublic, now: NOW});
    try {
      for (const stem of [
        '/arena',
        '/arena/ladders/rby',
        '/arena/ladders/vgc',
        '/arena/battles',
        '/arena/tournaments/1',
        '/projects/foul-play',
      ]) {
        const dotJson = await h.getText(`${stem}.json`);
        const indexJson = await h.getText(`${stem}/index.json`);
        expect(dotJson).toBe(indexJson);
        expect(typeof JSON.parse(dotJson)).toBe('object');
      }
    } finally {
      await h.close();
    }
  });

  test('returns 404 for .json or /index.json on static non-DB pages', async () => {
    const h = await startRenderHarness({db, publicDir: tmpPublic, now: NOW});
    try {
      for (const nonDbStem of [
        '/projects',
        '/glossary',
        '/research',
        '/rules',
        '/background',
        '/arena/battles/vgc-retire-01',
      ]) {
        expect(fs.existsSync(path.join(tmpPublic, nonDbStem.slice(1), 'index.json'))).toBe(false);
        expect((await h.getRaw(`${nonDbStem}.json`)).status).toBe(404);
        expect((await h.getRaw(`${nonDbStem}/index.json`)).status).toBe(404);
      }
    } finally {
      await h.close();
    }
  });

  test('blocks teams.json or archive publication while pools ladder is active or settling',
    async () => {
      const h = await startRenderHarness({db, publicDir: tmpPublic, now: NOW});
      try {
        expect((await h.getRaw('/arena/ladders/gen9championsvgc2026regmc/teams.json')).status)
          .toBe(404);
        const dummyArchive = path.join(tmpDir, 'source-archive.7z');
        fs.writeFileSync(dummyArchive, 'mock-7z-full-battle-logs', 'utf8');

        await expect(runPkmnCli(
          ['publish-ladder-archive', 'gen9championsvgc2026regmc', dummyArchive],
          {db, publicDir: tmpPublic, now: NOW, log: () => undefined}
        )).rejects.toThrow(/must be retired \("archived"\)/);

        db.setLadderStatus('gen9championsvgc2026regmc', 'settling', DAY_3);
        expect((await h.getRaw('/arena/ladders/gen9championsvgc2026regmc/teams.json')).status)
          .toBe(404);
      } finally {
        await h.close();
      }
    });

  test('rejects full log archive publication on non-pools ladders even after retirement',
    async () => {
      const h = await startRenderHarness({db, publicDir: tmpPublic, now: NOW});
      try {
        db.setLadderStatus('gen1ou20261109', 'archived', NOW);
        const dummyArchive = path.join(tmpDir, 'source-archive.7z');
        fs.writeFileSync(dummyArchive, 'mock-7z-full-battle-logs', 'utf8');

        await expect(runPkmnCli(
          ['publish-ladder-archive', 'gen1ou20261109', dummyArchive],
          {db, publicDir: tmpPublic, now: NOW, log: () => undefined}
        )).rejects.toThrow(/team-pool \(pools\)/);
        expect((await h.getRaw('/arena/ladders/gen1ou20261109/teams.json')).status).toBe(404);
      } finally {
        await h.close();
      }
    });

  test('publishes teams.json plus log archives once a pools ladder is archived', async () => {
    const h = await startRenderHarness({db, publicDir: tmpPublic, now: NOW});
    try {
      db.setLadderStatus('gen9championsvgc2026regmc', 'archived', NOW);
      const dummyArchive = path.join(tmpDir, 'source-archive.7z');
      fs.writeFileSync(dummyArchive, 'mock-7z-full-battle-logs', 'utf8');

      await runPkmnCli(
        ['publish-tournament-archive', '1', dummyArchive],
        {db, publicDir: tmpPublic, now: NOW, log: () => undefined}
      );
      await runPkmnCli(
        ['publish-ladder-archive', 'gen9championsvgc2026regmc', dummyArchive],
        {db, publicDir: tmpPublic, now: NOW, log: () => undefined}
      );

      const teamsDoc = await h.getJson<{
        ladderId: string;
        entrants: Array<{
          slug: string;
          teams: Array<{index: number; hash: string; packed: string; paste: string}>;
        }>;
      }>('/arena/ladders/gen9championsvgc2026regmc/teams.json');
      expect(teamsDoc.ladderId).toBe('gen9championsvgc2026regmc');
      expect(teamsDoc.entrants.map(r => r.slug)).toEqual(['foul-play', 'jaxcalibur']);
      expect(teamsDoc.entrants[0].teams).toHaveLength(20);
      expect(teamsDoc.entrants[0].teams[0].hash).toBe(hashTeam(packAll(VGC_PASTES_FP)[0]));

      const vgcLadderJson = await h.getJson<{archiveHref?: string; teamsHref?: string}>(
        '/arena/ladders/gen9championsvgc2026regmc/index.json'
      );
      expect(vgcLadderJson.archiveHref).toBe(
        '/arena/ladders/gen9championsvgc2026regmc/gen9championsvgc2026regmc-logs.7z'
      );
      expect(vgcLadderJson.teamsHref).toBe(
        '/arena/ladders/gen9championsvgc2026regmc/teams.json'
      );

      const tour1Json = await h.getJson<{archiveHref?: string}>(
        '/arena/tournaments/1/index.json'
      );
      expect(tour1Json.archiveHref).toBe('/arena/tournaments/1/1-replays.7z');
    } finally {
      await h.close();
    }
  });

  test('standInSprite generates deterministic non-transparent species minisprites', () => {
    const pikachu = standInSprite('/forums/media/minisprites/pikachu.png');
    const charizard = standInSprite('/forums/media/minisprites/charizard.png');
    expect(pikachu.equals(standInSprite('/forums/media/minisprites/pikachu.png'))).toBe(true);
    expect(pikachu.equals(charizard)).toBe(false);

    const decoded = decodePng(pikachu);
    expect(decoded.width).toBe(40);
    expect(decoded.height).toBe(30);
    let opaquePixels = 0;
    for (let i = 3; i < decoded.data.length; i += 4) {
      if (decoded.data[i] === 255) opaquePixels++;
    }
    expect(opaquePixels).toBeGreaterThan(20);
  });

  test('diffPngImages highlights modified pixels in red over a faded backdrop', () => {
    const baseData = Buffer.alloc(4 * 4 * 4, 200);
    const nextData = Buffer.from(baseData);
    nextData[0] = 10;
    nextData[1] = 20;
    nextData[2] = 30;
    nextData[3] = 255;

    const {image, count} = diffPngImages(
      {width: 4, height: 4, data: baseData},
      {width: 4, height: 4, data: nextData}
    );
    expect(count).toBe(1);
    expect([image.data[0], image.data[1], image.data[2], image.data[3]]).toEqual([255, 0, 0, 255]);
  });

  test('compareShots writes diff images with an HTML summary report when pixels differ',
    async () => {
      const beforeDir = path.join(tmpDir, 'shots-before');
      const afterDir = path.join(tmpDir, 'shots-after');
      const diffDir = path.join(tmpDir, 'shots-diff');
      fs.mkdirSync(path.join(beforeDir, 'small', 'light'), {recursive: true});
      fs.mkdirSync(path.join(afterDir, 'small', 'light'), {recursive: true});

      const imgA = encodePng({width: 2, height: 2, data: Buffer.alloc(16, 120)});
      const dataB = Buffer.alloc(16, 120);
      dataB[0] = 250;
      const imgB = encodePng({width: 2, height: 2, data: dataB});

      fs.writeFileSync(path.join(beforeDir, 'small', 'light', 'home.png'), imgA);
      fs.writeFileSync(path.join(afterDir, 'small', 'light', 'home.png'), imgB);

      const res = await compareShots(beforeDir, afterDir, diffDir, 0);
      expect(res.same).toBe(false);
      expect(res.changes).toHaveLength(1);
      expect(fs.existsSync(path.join(diffDir, 'small', 'light', 'home.png'))).toBe(true);
      expect(fs.readFileSync(path.join(diffDir, 'index.html'), 'utf8')).toContain('home.png');
    });
});
