import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import {Teams} from '@pkmn/sim';
import polka from 'polka';

import {ALL_SLOTS, Database} from '../db';
import type * as db from '../db';
import * as arena from '../server/arena';
import * as ratings from '../server/ratings';
import * as render from '../server/render';
import {formatPoolTeamLabel} from '../server/teams';
import * as tournaments from '../server/tournaments';
import {syncStaticLiveBanner} from '../static/build';
import * as util from '../static/util';
import {Fragment, h as jsx, raw, root} from '../static/util';
import {hashTeam} from '../teams';
import {generateValidVgcTeams} from '../tools/mock';
import {runPkmnCli} from '../tools/pkmn';
import * as shots from '../tools/shots';

function forceLadderActive(database: Database, id: string) {
  database.db.prepare("UPDATE ladders SET status = 'active' WHERE id = ?").run(id);
}

const NOW = 1_762_800_000;
const DAY_1 = 1_761_800_000;
const DAY_2 = 1_762_664_000;
const DAY_3 = 1_762_750_400;
const ARENA_SECRET = 'test-arena-render-secret';

const VGC_PASTES_FP = generateValidVgcTeams(20, 0);
const VGC_PASTES_JAX = generateValidVgcTeams(20, 1);

const TEST_PROJECTS_YAML = `
- name: Foul Play
  active: 2019
  license: GPL-3.0
  source: https://github.com/pmariglia/showdown
  arena:
    owners:
      pmariglia: pmariglia.535629
- name: Metamon
  active: 2024
  license: MIT
  source: https://github.com/UT-Austin-RPL/metamon
  arena:
    owners:
      jake: jake.20001
- name: Jaxcalibur
  active: 2026
  arena:
    owners:
      jaxdev: jaxdev.30001
- name: Athena
  active: [2020, 2023]
  arena:
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

function syncTestProjects(database: Database, avatarsDir?: string, now?: number) {
  database.syncProjectsFromYaml(TEST_PROJECTS_YAML, avatarsDir, now);
  for (const slug of ['foul-play', 'metamon', 'jaxcalibur', 'athena']) {
    database.setAgentLadders(slug, ALL_SLOTS, now);
  }
}

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
      p1Game1PeakRam: 1180,
      p1Game2PeakRam: 1180,
      p2Game1PeakRam: 1420,
      p2Game2PeakRam: 1420,
      p1Game1BankSeconds: 150,
      p1Game2BankSeconds: 142,
      p2Game1BankSeconds: 148,
      p2Game2BankSeconds: 136,
      p1Game1MeanTurnMillis: 390,
      p1Game2MeanTurnMillis: 390,
      p2Game1MeanTurnMillis: 480,
      p2Game2MeanTurnMillis: 480,
      completedAt,
    },
  });
}

function seedStaticPublicAssets(tmpPublic: string) {
  fs.mkdirSync(tmpPublic, {recursive: true});
  const realPublic = root('public');
  for (const name of ['index.html', 'favicon.svg', 'cc.svg', 'by.svg', 'sa.svg', 'llms.txt']) {
    const src = path.join(realPublic, name);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmpPublic, name));
  }
  for (const name of fs.readdirSync(realPublic)) {
    if (
      (name.endsWith('.png') && name.startsWith('favicon')) ||
      (name.startsWith('index.') && name.endsWith('.css'))
    ) {
      fs.copyFileSync(path.join(realPublic, name), path.join(tmpPublic, name));
    }
  }
  for (const dir of [
    'glossary', 'research', 'concepts', 'rules', 'release', 'background', 'chat', 'account', 'wiki',
  ]) {
    const srcDir = path.join(realPublic, dir);
    if (fs.existsSync(srcDir)) {
      fs.cpSync(srcDir, path.join(tmpPublic, dir), {recursive: true});
    }
  }
  for (const stub of ['arena', 'projects', 'chat', 'account', 'wiki']) {
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
  now?: number | (() => number);
  withViewer?: boolean;
  syncBanner?: boolean;
}

type RenderHarness = Awaited<ReturnType<typeof startRenderHarness>>;
type RequestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

// Reuse a single listening TCP socket across sequential `startRenderHarness` calls so rapid
// ephemeral-port churn + `closeAllConnections()` never trips macOS loopback TIME_WAIT ETIMEDOUT.
let sharedServer: http.Server | undefined;
let sharedBaseUrl: string | undefined;
let sharedHandler: RequestHandler | undefined;

async function ensureSharedServer(): Promise<string> {
  if (sharedServer && sharedBaseUrl) return sharedBaseUrl;
  sharedServer = http.createServer((req, res) => {
    if (!sharedHandler) {
      res.statusCode = 503;
      res.end('No active test handler');
      return;
    }
    sharedHandler(req, res);
  });
  await new Promise<void>(resolve => sharedServer!.listen(0, '127.0.0.1', resolve));
  const port = (sharedServer.address() as {port: number}).port;
  sharedBaseUrl = `http://127.0.0.1:${port}`;
  return sharedBaseUrl;
}

afterAll(async () => {
  if (!sharedServer) return;
  const srv = sharedServer;
  sharedServer = undefined;
  sharedBaseUrl = undefined;
  sharedHandler = undefined;
  const closed = new Promise<void>(resolve => srv.close(() => resolve()));
  srv.closeAllConnections();
  await closed;
});

async function startRenderHarness(opts: RenderHarnessOptions) {
  const nowOpt = opts.now;
  const getNow: () => number = typeof nowOpt === 'function'
    ? nowOpt
    : () => nowOpt ?? NOW;

  if (opts.withViewer) tournaments.renderBattleViewerPage(opts.publicDir);
  if (opts.syncBanner) syncStaticLiveBanner(opts.publicDir, opts.db.getRunningTournament());

  const app = polka();
  const arenaHandle = arena.register(app, {
    db: opts.db,
    arenaSecret: ARENA_SECRET,
    sessionSecret: 'test-session-secret',
    publicDir: opts.publicDir,
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
      restarting: opts.liveDoc.restarting,
      smokeTesting: opts.liveDoc.smokeTesting,
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
    now: getNow,
  });

  const handler: RequestHandler = (req, res) => {
    void app.handler(req as polka.Request, res);
  };
  let baseUrl: string;
  let dedicatedServer: http.Server | undefined;
  if (!sharedHandler) {
    sharedHandler = handler;
    baseUrl = await ensureSharedServer();
  } else {
    dedicatedServer = http.createServer(handler);
    await new Promise<void>(resolve => dedicatedServer!.listen(0, '127.0.0.1', resolve));
    const port = (dedicatedServer.address() as {port: number}).port;
    baseUrl = `http://127.0.0.1:${port}`;
  }

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
      if (dedicatedServer) {
        const closed = new Promise<void>(resolve => dedicatedServer.close(() => resolve()));
        dedicatedServer.closeAllConnections();
        await closed;
      } else if (sharedHandler === handler) {
        sharedHandler = undefined;
      }
    },
  };
}

describe('dom TSX renderer', () => {
  test('escapes string children while preserving raw Html fragments', () => {
    const out = String(jsx('div', undefined, raw('<span>ok</span>'), '|', '<script>'));
    expect(out).toBe('<div><span>ok</span>|&lt;script&gt;</div>');
  });

  test('maps JSX attributes with void element support', () => {
    const out = String(
      jsx(
        'label',
        {
          className: 'pill',
          htmlFor: 'chk',
          hidden: false,
          draggable: false,
          'aria-expanded': false,
        },
        jsx('input', {id: 'chk', type: 'checkbox', checked: true, required: true})
      )
    );
    expect(out).toBe(
      '<label class="pill" for="chk" draggable="false" aria-expanded="false">' +
      '<input id="chk" type="checkbox" checked required></label>'
    );
  });

  test('serializes camelCase inline style properties to kebab-case', () => {
    const out = String(
      jsx('div', {style: {width: '320px', opacity: 0.5, backgroundColor: 'red'}})
    );
    expect(out).toBe('<div style="width:320px;opacity:0.5;background-color:red"></div>');
  });

  test('preserves CSS custom properties in inline style objects', () => {
    const out = String(jsx('div', {style: {'--accent': '#fff'}}));
    expect(out).toBe('<div style="--accent:#fff"></div>');
  });

  test('renders Fragment nodes alongside function components', () => {
    const Badge = (props: {label: string; children?: unknown}) =>
      jsx('span', {className: 'badge'}, props.label, ':', props.children as string);
    const out = String(jsx(Fragment, undefined, jsx(Badge, {label: 'v'}, '1.0')));
    expect(out).toBe('<span class="badge">v:1.0</span>');
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
    logo: foul-play.svg
    owners:
      pmariglia: pmariglia.535629
`, avatarsDir, NOW);
    db.setAgentLadders('foul-play', ALL_SLOTS, NOW);
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

  test('returns 304 Not Modified on SSR routes for weak gzip If-None-Match tags', async () => {
    const res = await h.getRaw('/arena/');
    const etag = res.headers.get('etag')!;
    expect(
      (await h.getRaw('/arena/', {headers: {'If-None-Match': `W/${etag}`}})).status
    ).toBe(304);
    expect(
      (await h.getRaw('/arena/', {headers: {'If-None-Match': `"stale", W/${etag}`}})).status
    ).toBe(304);
    expect(
      (await h.getRaw('/arena/', {headers: {'If-None-Match': `w/${etag}`}})).status
    ).toBe(200);
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
    db.db.prepare("UPDATE ladders SET status = 'upcoming'").run();
    syncTestProjects(db, path.join(tmpDir, 'avatars'), DAY_1);
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
    expect(arenaHtml).toContain('No tournaments scheduled yet.');
  });

  test('renders upcoming status notice on /arena/ladders/rby/', async () => {
    const rbyLadderHtml = await h.getText('/arena/ladders/rby/');
    expect(rbyLadderHtml).toContain(
      'The RBY ladder is upcoming — accepting initial entries before matchmaking begins.'
    );
    expect(rbyLadderHtml).toMatch(/<section[^>]*id="history"[^>]*class="hide"/);
    expect(rbyLadderHtml).toMatch(/<section[^>]*id="matchups"[^>]*class="hide"/);
  });

  test('renders empty archived status notice on /arena/ladders/:id/', async () => {
    db.setLadderStatus('gen9ou20261109', 'archived', NOW);
    try {
      const svLadderHtml = await h.getText('/arena/ladders/gen9ou20261109/');
      expect(svLadderHtml).toContain('The SV ladder was archived with no completed entries.');
    } finally {
      db.db.prepare(
        "UPDATE ladders SET status = 'upcoming', archived_at = NULL WHERE id = ?"
      ).run('gen9ou20261109');
    }
  });

  test('omits live indicator on archived ladder when another season is live', async () => {
    db.setLadderStatus('gen9ou20261109', 'archived', NOW);
    h.arenaHandle.setLiveState({
      stale: false,
      updatedAt: NOW,
      live: {
        heartbeatSeq: 1,
        matchId: 'gen9ou-0000099',
        ladderId: 'gen9ou20270101',
        slot: 'sv',
        format: 'gen9ou',
        game: 1,
        turn: 4,
        activeSlot: 'p1',
        turnStartedAt: NOW - 2,
        turnBudgetSeconds: 60,
        incrementSeconds: 15,
        p1: {
          slug: 'alpha',
          name: 'Alpha',
          version: '1.0.0',
          bankSeconds: 150,
          lastTurnMillis: 100,
          meanTurnMillis: 100,
          ram: 256,
        },
        p2: {
          slug: 'beta',
          name: 'Beta',
          version: '1.0.0',
          bankSeconds: 150,
          lastTurnMillis: 100,
          meanTurnMillis: 100,
          ram: 256,
        },
      },
    });
    try {
      const svLadderHtml = await h.getText('/arena/ladders/gen9ou20261109/');
      expect(svLadderHtml).not.toContain('class="ladder-live"');
      expect(svLadderHtml).not.toContain('Alpha vs. Beta');
    } finally {
      h.arenaHandle.setLiveState({stale: false, updatedAt: NOW, live: undefined});
      db.db.prepare(
        "UPDATE ladders SET status = 'upcoming', archived_at = NULL WHERE id = ?"
      ).run('gen9ou20261109');
    }
  });

  test('renders empty active status notice on /arena/ladders/sv/', async () => {
    db.db.prepare("UPDATE ladders SET status = 'active' WHERE id = ?").run('gen9ou20261109');
    try {
      const svLadderHtml = await h.getText('/arena/ladders/sv/');
      expect(svLadderHtml).toContain('No active entries on the SV ladder yet.');
    } finally {
      db.db.prepare("UPDATE ladders SET status = 'upcoming' WHERE id = ?").run('gen9ou20261109');
    }
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
    expect(battlesHtml).toContain(
      '<link rel="preconnect" href="https://play.pokemonshowdown.com">'
    );
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
    db.db.prepare("UPDATE ladders SET status = 'upcoming'").run();
    syncTestProjects(db, path.join(tmpDir, 'avatars'), DAY_1);

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
    db.db.prepare(
      "UPDATE ladder_entries SET role = 'retired', retired_at = ? " +
      'WHERE ladder_id = ? AND version_id = ?'
    ).run(DAY_2 + 20, 'gen1ou20261109', jaxV1);

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
    syncTestProjects(db, avatarsDir, DAY_3 + 800);

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
    expect(arenaHubHtml).toContain('<th>Leader</th>');
    expect(arenaHubHtml).toContain('<th class="num">Entrants</th>');
    expect(arenaHubHtml).toContain('<th class="num">Matches</th>');
    expect(arenaHubHtml).toContain('<th class="num">Last</th>');
    expect(arenaHubHtml).toContain('href="/arena/ladders/rby/"');
    expect(arenaHubHtml).toContain('href="/arena/ladders/adv/"');
    expect(arenaHubHtml).toContain('href="/projects/jaxcalibur/"');
    expect(arenaHubHtml).toContain('href="/projects/metamon/"');
    expect(arenaHubHtml).toContain('<a href="/arena/battles/" class="live-pill">');
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
    expect(lbHtml).toContain('<td class="num">1500 <span class="muted">±0</span></td>');
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
    expect(batHtml).not.toContain('[Gen 1] OU');
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
    expect(projHtml).toContain('<tt>RBY #1</tt>');
    expect(projHtml).toContain('<tt>RBY</tt>');
    expect(projHtml).not.toContain('(provisional)');
    const posMetamon = projHtml.indexOf('id="Metamon"');
    const posFoulPlay = projHtml.indexOf('id="FoulPlay"');
    const posEevenator = projHtml.indexOf('id="Eevenator"');
    const posAthena = projHtml.indexOf('id="Athena"');
    const posAbra = projHtml.indexOf('id="IHTFPAbra"');
    expect(posMetamon).toBeGreaterThan(0);
    expect(posMetamon).toBeLessThan(posEevenator);
    expect(posFoulPlay).toBeLessThan(posEevenator);
    expect(posAbra).toBeLessThan(posAthena);
  });

  test('serves PNG project avatars on /projects/:slug.png with cache headers', async () => {
    const logoRes = await h.getRaw('/projects/metamon.png');
    expect(logoRes.status).toBe(200);
    expect(logoRes.headers.get('content-type')).toBe('image/png');
    expect(logoRes.headers.get('cache-control')).toBe('public, max-age=604800');
    expect(Buffer.from(await logoRes.arrayBuffer())).toEqual(png1x1);

    const hash = crypto.createHash('sha256').update(png1x1).digest('hex').slice(0, 8);
    const versionedRes = await h.getRaw(`/projects/metamon.png?v=${hash}`);
    expect(versionedRes.status).toBe(200);
    expect(versionedRes.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

    const staleRes = await h.getRaw('/projects/metamon.png?v=deadbeef');
    expect(staleRes.status).toBe(200);
    expect(staleRes.headers.get('cache-control')).toBe('public, max-age=604800');
  });

  test('renders /projects/:slug statistical profile with version selector', async () => {
    const metaProfileHtml = await h.getText('/projects/metamon/');
    const hash = crypto.createHash('sha256').update(png1x1).digest('hex').slice(0, 8);
    const expectedLogoHref = `/projects/metamon.png?v=${hash}`;
    expect(metaProfileHtml).toContain('id="agent-profile"');
    expect(metaProfileHtml).toContain(
      `<link rel="preload" as="image" href="${expectedLogoHref}" fetchpriority="high">`
    );
    expect(metaProfileHtml).toContain(
      `<img class="project-logo" src="${expectedLogoHref}" alt="Metamon" ` +
      'width="412" height="335" style="--logo-w:412;--logo-h:335" ' +
      'fetchpriority="high" decoding="async">'
    );
    expect(metaProfileHtml).toContain('UT-Austin-RPL/metamon');
    expect(metaProfileHtml).toContain('id="ver-picker" class="ver-picker"');
    expect(metaProfileHtml).toContain('id="ver-select"');
    expect(metaProfileHtml).toContain('1.2.0 (active)');
    expect(metaProfileHtml).toContain('1.0.0 (active)');
    expect(metaProfileHtml).toContain('1.0.0 (1500 ±0)');
    expect(metaProfileHtml).toContain('<td class="num">1500 <span class="muted">±0</span></td>');
    expect(metaProfileHtml).toContain('class="h2h-table"');
    expect(metaProfileHtml).toContain('Top 10');
    expect(metaProfileHtml).toContain(
      '<link rel="preconnect" href="https://play.pokemonshowdown.com">'
    );

    const athenaProfileHtml = await h.getText('/projects/athena/');
    expect(athenaProfileHtml).toContain('class="table-wrap reign hide"');
    expect(athenaProfileHtml).toContain('id="ver-picker" class="ver-picker hide"');
  });

  test('gates profile Best Matchup or Nemesis callouts on at least 10 matches', async () => {
    const foulProfileHtml = await h.getText('/projects/foul-play/');
    expect(foulProfileHtml).not.toMatch(/Athena[\s\S]{0,80}Nemesis/);
    expect(foulProfileHtml).toContain('Page 1 of 6 (135 matches)');
    expect(foulProfileHtml).not.toContain('Page 1 of 2 (28 matches)');
    expect((foulProfileHtml.match(/class="battle-row" data-ver=/g) ?? [])).toHaveLength(25);

    const advPane = await h.getJson<{
      ladderKey: string;
      matchesPaneHtml: string;
    }>('/projects/foul-play/ladders/adv.json');
    expect(advPane.ladderKey).toBe('adv');
    expect(advPane.matchesPaneHtml).toContain('Page 1 of 2 (28 matches)');
    expect((advPane.matchesPaneHtml.match(/class="battle-row"/g) ?? [])).toHaveLength(25);

    const page6 = await h.getJson<{
      total: number;
      page: number;
      matches: Array<{id: string}>;
    }>('/api/battles.json?ladder=gen1ou20261109&agent=foul-play&page=6&limit=25');
    expect(page6.total).toBe(135);
    expect(page6.page).toBe(6);
    expect(page6.matches).toHaveLength(10);

    const metaV120 = await h.getJson<{
      total: number;
      agentVersion?: string;
      matches: Array<{p1: {slug: string; version: string}; p2: {slug: string; version: string}}>;
    }>('/api/battles.json?ladder=gen1ou20261109&agent=metamon&version=1.2.0&limit=25');
    expect(metaV120.agentVersion).toBe('1.2.0');
    expect(metaV120.total).toBe(88);
    for (const m of metaV120.matches) {
      expect(
        (m.p1.slug === 'metamon' && m.p1.version === '1.2.0') ||
        (m.p2.slug === 'metamon' && m.p2.version === '1.2.0')
      ).toBe(true);
    }
  });

  test('serves lazy profile ladder payload with ETag revalidation', async () => {
    const first = await h.getRaw('/projects/foul-play/ladders/adv.json');
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-cache');
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    const payload = await first.json() as {
      ladderKey: string;
      clientData: {ladderId: string};
      versionsPaneHtml: string;
      matchupsPaneHtml: string;
      matchesPaneHtml: string;
    };
    expect(payload.ladderKey).toBe('adv');
    expect(payload.clientData.ladderId).toBe('gen3ou20261109');
    expect(payload.versionsPaneHtml).toContain('data-ladder="adv"');
    expect(payload.matchupsPaneHtml).toContain('data-ladder="adv"');
    expect(payload.matchesPaneHtml).toContain('data-ladder="adv"');

    const second = await h.getRaw('/projects/foul-play/ladders/adv.json', {
      headers: {'if-none-match': etag!},
    });
    expect(second.status).toBe(304);

    expect((await h.getRaw('/projects/foul-play/ladders/nonexistent.json')).status).toBe(404);
    expect((await h.getRaw('/projects/no-such-agent/ladders/rby.json')).status).toBe(404);
    expect((await h.getRaw('/projects/foul-play/ladders/adv')).status).toBe(404);
  });

  test('renders profile pages for Pending projects without ladder entries', async () => {
    const tmProfileHtml = await h.getText('/projects/technical-machine/');
    expect(tmProfileHtml).toContain('davidstone/technical-machine');
    expect(tmProfileHtml).toContain('No <a href="/arena/">Arena</a> ladder entries yet.');
  });

  test('redirects non-Arena project slugs to /projects/#<id>', async () => {
    const res = await h.getRaw('/projects/eevenator', {redirect: 'manual'});
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/projects/#eevenator');
  });

  test('emits /llms.txt and links to it without a trailing slash on /rules/', () => {
    const llmsTxt = fs.readFileSync(path.join(tmpPublic, 'llms.txt'), 'utf8');
    expect(llmsTxt).toContain('# pkmn.ai');

    const rulesHtml = fs.readFileSync(path.join(tmpPublic, 'rules', 'index.html'), 'utf8');
    expect(rulesHtml).toContain('href="/llms.txt"');
    expect(rulesHtml).not.toContain('href="/llms.txt/"');
  });
});

describe('project de-registration', () => {
  test('demotes removed Arena projects to /projects/#<id> redirects', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-render-dereg-'));
    const tmpPublic = path.join(tmpDir, 'public');
    seedStaticPublicAssets(tmpPublic);
    const db = new Database(':memory:', {now: DAY_1});
    db.syncLadders(undefined, DAY_1);
    syncTestProjects(db, path.join(tmpDir, 'avatars'), DAY_1);
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

  test('renders CPU utilization with protocol faults on project profiles', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-render-cpu-'));
    const tmpPublic = path.join(tmpDir, 'public');
    seedStaticPublicAssets(tmpPublic);
    const db = new Database(':memory:', {now: DAY_1});
    db.syncLadders(undefined, DAY_1);
    syncTestProjects(db, path.join(tmpDir, 'avatars'), DAY_1);
    forceLadderActive(db, 'gen1ou20261109');
    const meta = db.getAgentBySlug('metamon')!;
    const fp = db.getAgentBySlug('foul-play')!;
    const sha = 'a'.repeat(64);
    const v1 = db.createSubmission({
      agentId: meta.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://example.com/meta-1.0.0.tar.gz',
      sha256: sha,
      ladderIds: ['gen1ou20261109'],
      now: DAY_1,
    });
    const v2 = db.createSubmission({
      agentId: fp.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://example.com/fp-1.0.0.tar.gz',
      sha256: sha,
      ladderIds: ['gen1ou20261109'],
      now: DAY_1,
    });
    db.applySubmissionStatus({
      versionId: v1.id,
      smokeStatus: 'passed',
      diagnostics: [{
        ladderId: 'gen1ou20261109',
        format: 'gen1ou',
        turns: 10,
        endReason: 'win',
        durationMillis: 1500,
        battleLog: '|turn|1\n|ai|p1|{"win":0.5}\n|win|Metamon',
        infoStatus: 'full',
      }],
      now: DAY_1 + 10,
    });
    db.applySubmissionStatus({
      versionId: v2.id,
      smokeStatus: 'passed',
      diagnostics: [{
        ladderId: 'gen1ou20261109',
        format: 'gen1ou',
        turns: 10,
        endReason: 'win',
        durationMillis: 1500,
        battleLog: '|turn|1\n|win|Foul Play',
        infoStatus: 'none',
      }],
      now: DAY_1 + 10,
    });
    db.recordCompletedMatch({
      match: {
        id: 'gen1ou-0000001',
        ladderId: 'gen1ou20261109',
        p1VersionId: v1.id,
        p2VersionId: v2.id,
        seed: '1,2,3,4',
        game1Outcome: 'L',
        game2Outcome: 'W',
        category: 'LW',
        game1Turns: 5,
        game2Turns: 25,
        game1EndReason: 'invalid-choice',
        game2EndReason: 'win',
        p1Game1PeakRam: 512,
        p1Game2PeakRam: 768,
        p2Game1PeakRam: 256,
        p2Game2PeakRam: 300,
        p1Game1BankSeconds: 100,
        p1Game2BankSeconds: 110,
        p2Game1BankSeconds: 120,
        p2Game2BankSeconds: 130,
        p1Game1MeanTurnMillis: 50,
        p1Game2MeanTurnMillis: 60,
        p2Game1MeanTurnMillis: 40,
        p2Game2MeanTurnMillis: 45,
        p1CpuCores: 6.4,
        p2CpuCores: 1.2,
        p1Game1CpuCores: 6.1,
        p1Game2CpuCores: 6.7,
        p2Game1CpuCores: 1.1,
        p2Game2CpuCores: 1.3,
        p1Errors: {
          invalidCantMove: 2,
          invalidCantSwitch: 1,
          invalidTarget: 0,
          invalidOther: 0,
          unavailableChoices: 4,
        },
        completedAt: DAY_1 + 100,
      },
    });
    db.db.prepare(
      'UPDATE ladder_entries SET rank_current = 1, matches = 10, se = 40, settled_at = ? ' +
      'WHERE version_id = ?'
    ).run(DAY_1 + 100, v1.id);
    const h = await startRenderHarness({db, publicDir: tmpPublic, now: NOW});
    try {
      const html = await h.getText('/projects/metamon/');
      expect(html).toContain('>CPU<');
      expect(html).not.toContain('>Faults<');
      expect(html).toContain('6.4 CPU');
      expect(html).toContain('>6.4<');
      expect(html).not.toContain('6.4c');
      expect(html).toContain('>Game Faults<');
      expect(html).toContain('>Protocol Errors<');
      expect(html).toContain('>Invalid choice<');
      expect(html).not.toContain('>Invalid-choice forfeits<');
      expect(html).toContain('>Can&#39;t move<');
      expect(html).toContain('>Unavailable choices (info)<');
      expect(html).toContain('class="info-dot full yes"');
      expect(html).not.toContain('class="info-dot none muted"');
      expect(html).toContain('<tt>6.1</tt> CPU');
      expect(html).toContain('<tt>6.7</tt> CPU');

      const fpHtml = await h.getText('/projects/foul-play/');
      expect(fpHtml).toContain('class="info-dot none muted"');
      expect(fpHtml).not.toContain('class="info-dot full yes"');

      const ladderHtml = await h.getText('/arena/ladders/rby/');
      expect(ladderHtml).not.toContain('class="info-dot');

      const hubHtml = await h.getText('/arena/');
      expect(hubHtml).not.toContain('class="info-dot');

      h.arenaHandle.setLiveState({
        stale: false,
        updatedAt: NOW,
        live: {
          heartbeatSeq: 1,
          matchId: 'gen1ou-0000002',
          ladderId: 'gen1ou20261109',
          slot: 'rby',
          format: 'gen1ou',
          game: 2,
          turn: 12,
          activeSlot: 'p1',
          turnStartedAt: NOW - 2,
          turnBudgetSeconds: 60,
          incrementSeconds: 10,
          game1Summary: {
            winnerSlot: 'p1',
            turns: 20,
            endReason: 'win',
            p1: {bankSeconds: 110, meanTurnMillis: 55, ram: 512, cpuCores: 3.1},
            p2: {bankSeconds: 120, meanTurnMillis: 42, ram: 256, cpuCores: 1.4},
          },
          p1: {
            slug: 'metamon',
            name: 'Metamon',
            version: '1.0.0',
            bankSeconds: 105,
            lastTurnMillis: 48,
            meanTurnMillis: 50,
            ram: 600,
            cpuCores: 2.9,
          },
          p2: {
            slug: 'foul-play',
            name: 'Foul Play',
            version: '1.0.0',
            bankSeconds: 115,
            lastTurnMillis: 40,
            meanTurnMillis: 42,
            ram: 280,
            cpuCores: 1.5,
          },
        },
      });
      const battlesHtml = await h.getText('/arena/battles/');
      expect(battlesHtml).toContain('<tt>2.9</tt> CPU');
      expect(battlesHtml).toContain('<tt>3.1</tt> CPU');
      expect(battlesHtml).toContain('<tt>6.1</tt> CPU');
      expect(battlesHtml).not.toContain('class="info-dot');

      const json = await h.getJson<{
        ladders: Array<{
          versions: Array<{
            meanCpuCores?: number;
            faults: {
              invalidChoices: number;
              invalidCantMove: number;
              invalidCantSwitch: number;
              unavailableChoices: number;
            };
          }>;
        }>;
      }>('/projects/metamon.json');
      expect(json.ladders[0].versions[0].meanCpuCores).toBe(6.4);
      expect(json.ladders[0].versions[0].faults.invalidChoices).toBe(1);
      expect(json.ladders[0].versions[0].faults.invalidCantMove).toBe(2);
      expect(json.ladders[0].versions[0].faults.invalidCantSwitch).toBe(1);
      expect(json.ladders[0].versions[0].faults.unavailableChoices).toBe(4);
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
    db.db.prepare("UPDATE ladders SET status = 'upcoming'").run();
    syncTestProjects(db, path.join(tmpDir, 'avatars'), DAY_1);
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
      version: '0.11.0',
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
      version: '0.11.0',
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
      version: '0.11.0',
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
      status: 'completed',
      outcome: 'W',
      p1: {versionId: vMeta, team: teamA},
      p2: {versionId: vFoul, team: teamB},
      games: [
        {
          gameNumber: 1,
          seed: '1,2,3,101',
          outcome: 'W',
          turns: 34,
          endReason: 'normal',
          p1: {bankSeconds: 145, meanTurnMillis: 260, peakRam: 4096},
          p2: {bankSeconds: 112, meanTurnMillis: 310, peakRam: 2048},
        },
      ],
      completedAt: DAY_3,
    });
    db.upsertTournamentGame({
      id: 'gen9ou-0000000102',
      tournamentId: '2',
      stage: 'Round Robin',
      cycle: 2,
      matchupGame: 1,
      status: 'completed',
      outcome: 'T',
      p1: {versionId: vMeta, team: teamA},
      p2: {versionId: vJax, team: '|Pikachu|Light Ball'},
      games: [
        {
          gameNumber: 1,
          seed: '1,2,3,102',
          outcome: 'T',
          turns: 100,
          endReason: 'tie-100-turns',
          p1: {bankSeconds: 90},
          p2: {bankSeconds: 80},
        },
      ],
      completedAt: DAY_3 + 60,
    });
    db.upsertTournamentGame({
      id: 'gen9ou-0000000201',
      tournamentId: '2',
      stage: 'Superfinal',
      cycle: 1,
      matchupGame: 63,
      status: 'completed',
      outcome: 'L',
      p1: {versionId: vFoul, team: teamB},
      p2: {versionId: vMeta, team: teamA},
      games: [
        {
          gameNumber: 1,
          seed: '1,2,3,201',
          outcome: 'L',
          turns: 29,
          endReason: 'normal',
          p1: {bankSeconds: 115},
          p2: {bankSeconds: 150},
        },
      ],
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
      withViewer: true,
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
    expect(viewerHtml).toContain('const ownPokemon = requested => {');
    expect(viewerHtml).toContain('list.map(ownPokemon)');
    expect(viewerHtml).toContain('battle.setViewpoint(currentSide)');
    expect(viewerHtml).toContain('state: playbackState()');
    expect(viewerHtml).toContain('class="icon-play"');
    expect(viewerHtml).toContain('class="icon-pause"');
    expect(viewerHtml).toContain('id="toggle" aria-label="Play" title="Play" data-playing="false"');
    expect(viewerHtml).toContain('class="icon-muted"');
    expect(viewerHtml).toContain('class="icon-sound"');
    expect(viewerHtml).toContain('id="sound" aria-label="Sound" aria-pressed="false"');
    expect(viewerHtml).not.toMatch(/&#9208;|&#9654;|[\u23f8\u25b6\u25c0]/);

    const metaMatch =
      /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(viewerHtml);
    expect(metaMatch).not.toBeNull();
    const metaCsp = metaMatch![1].replace(/&#39;/g, "'");
    const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(viewerHtml);
    expect(scriptMatch).not.toBeNull();
    const expectedHash =
      `'sha256-${crypto.createHash('sha256').update(scriptMatch![1], 'utf8').digest('base64')}'`;
    expect(metaCsp).toContain(`script-src ${expectedHash} https://play.pokemonshowdown.com`);
    expect(metaCsp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(metaCsp).toContain("base-uri 'none'");
    expect(metaCsp).toContain("form-action 'none'");
    expect(metaCsp).not.toContain('frame-ancestors');
    expect(metaCsp).not.toContain('sandbox');
    expect(viewerHtml).toContain('<link rel="preconnect" href="https://play.pokemonshowdown.com">');
  });

  test('renders ongoing or completed tournament summaries on /arena/', async () => {
    const arenaHubHtml = await h.getText('/arena/');
    expect(arenaHubHtml).toContain('href="/arena/tournaments/2/"');
    expect(arenaHubHtml).toContain('href="/arena/tournaments/1/"');
    expect(arenaHubHtml).toContain('href="/arena/tournaments/3/"');
    expect(arenaHubHtml).toContain('class="live-pill"');
    expect(arenaHubHtml).toContain('LIVE');
    expect(arenaHubHtml).toContain('href="/projects/jaxcalibur/"');
    expect(arenaHubHtml).toContain('<td class="muted">-</td>');
    expect(arenaHubHtml).not.toContain('rel="preconnect"');
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
    expect(tourney2Html).toContain('<tt>P1</tt>');
    expect(tourney2Html).toContain('<tt>P2</tt>');
    expect(tourney2Html).not.toContain('<tt>p1</tt>');
    expect(tourney2Html).not.toContain('<tt>p2</tt>');
    expect(tourney2Html).toContain('02:25');
    expect(tourney2Html).toContain('01:52');
    expect(tourney2Html).toContain('class="clock-pill committed" id="clock-pill-p1"');
    expect(tourney2Html).toContain('id="clock-sub-p1">committed<');
    expect(tourney2Html).toContain('class="clock-pill thinking" id="clock-pill-p2"');
    expect(tourney2Html).toContain('id="clock-sub-p2">thinking…<');
    expect(tourney2Html).toContain('src="/arena/viewer/"');
    expect(tourney2Html).toContain('sandbox="allow-scripts"');
    expect(tourney2Html).not.toContain('allow-same-origin');
    expect(tourney2Html).toContain('data-live-table="1"');
    expect(tourney2Html).toContain(
      '<link rel="preconnect" href="https://play.pokemonshowdown.com">'
    );
  });

  test('renders simultaneous thinking clocks on live tournament pages', async () => {
    const prev = h.arenaHandle.getTournamentBroadcast('2');
    try {
      const next = structuredClone(prev!);
      next.tables[0].p1!.thinking = true;
      next.tables[0].p2!.thinking = true;
      next.p1.thinking = true;
      next.p2.thinking = true;
      h.arenaHandle.setTournamentBroadcast(next);

      const html = await h.getText('/arena/tournaments/2/');
      expect(html).toContain('class="clock-pill thinking" id="clock-pill-p1"');
      expect(html).toContain('id="clock-sub-p1">thinking…<');
      expect(html).toContain('class="clock-pill thinking" id="clock-pill-p2"');
      expect(html).toContain('id="clock-sub-p2">thinking…<');
      expect(html).not.toContain('>committed<');
    } finally {
      h.arenaHandle.setTournamentBroadcast(prev, '2');
    }
  });

  test('renders turn increments on non-thinking completed table clocks', async () => {
    const prev = h.arenaHandle.getTournamentBroadcast('2');
    try {
      const next = structuredClone(prev!);
      next.tables[0].live = false;
      next.tables[0].p1!.thinking = false;
      next.tables[0].p2!.thinking = false;
      next.live = false;
      next.p1.thinking = false;
      next.p2.thinking = false;
      h.arenaHandle.setTournamentBroadcast(next);

      const html = await h.getText('/arena/tournaments/2/');
      expect(html).toContain('id="clock-sub-p1">+10s/turn<');
      expect(html).toContain('id="clock-sub-p2">+10s/turn<');
      expect(html).not.toContain('>committed<');
    } finally {
      h.arenaHandle.setTournamentBroadcast(prev, '2');
    }
  });

  test('renders VGC Your Time clock metadata on tournament pages', async () => {
    const html = await h.getText('/arena/tournaments/3/');
    expect(html).toContain('<tt>420s</tt> Your Time (<tt>90s</tt> preview, <tt>55s/turn</tt>)');
  });

  test('renders Superfinal badges with team minisprites in tournament games', async () => {
    const tourney2Html = await h.getText('/arena/tournaments/2/');
    expect(tourney2Html).toContain('<span class="muted">SF</span>');
    expect(tourney2Html).toContain('<code title="gen9ou-0000000201">SF63</code>');
    expect(tourney2Html).toContain('<code title="gen9ou-0000000101">RR1</code>');
    expect(tourney2Html).toContain('data-detail-for="gen9ou-0000000201"');
    expect(tourney2Html).toContain('<tt>29 turns</tt>');
    expect(tourney2Html).toContain('RAM <tt>4,096 MiB</tt>');
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

  test('renders Matches headers, series scores, or 3-card details on Best-of-3 tournaments',
    async () => {
      db.upsertTournament({
        id: '4',
        name: 'Winter ’26 — VGC 2026 Reg M-C OTS BO3',
        format: 'gen9championsvgc2026regmc',
        version: '0.11.0',
        rulesJson: JSON.stringify(['Open Team Sheets', 'Best of = 3']),
        gamesPerMatchup: 8,
        parallelTables: 2,
        hardware: 'GCP L4 Spot',
        status: 'running',
        startsAt: DAY_2,
      });
      const ent2 = db.getTournamentEntrants('2');
      for (const e of ent2) {
        db.upsertTournamentEntrant({
          tournamentId: '4',
          agentId: e.agentId,
          versionId: e.versionId,
          seed: e.seed,
          points: e.points,
          sonnebornBerger: e.sonnebornBerger,
          gameWins: e.gameWins,
          gameLosses: e.gameLosses,
          gameTies: e.gameTies,
          elo: e.elo,
          se: e.se,
          finalRank: e.finalRank,
        });
      }
      db.upsertTournamentGame({
        id: 'vgc-bo3-0001',
        tournamentId: '4',
        stage: 'Round Robin',
        cycle: 1,
        matchupGame: 1,
        status: 'completed',
        outcome: 'W',
        p1: {
          versionId: ent2[0].versionId,
          team: '|Incineroar|Sitrus Berry]Rillaboom|Assault Vest',
        },
        p2: {
          versionId: ent2[1].versionId,
          team: '|Flutter Mane|Booster Energy]Urshifu-Rapid-Strike|Focus Sash',
        },
        games: [
          {
            gameNumber: 1,
            seed: '1,2,3,4',
            outcome: 'W',
            turns: 8,
            endReason: 'normal',
            p1: {bankSeconds: 140},
            p2: {bankSeconds: 130},
          },
          {
            gameNumber: 2,
            seed: '5,6,7,8',
            outcome: 'L',
            turns: 10,
            endReason: 'normal',
            p1: {bankSeconds: 125},
            p2: {bankSeconds: 135},
          },
          {
            gameNumber: 3,
            seed: '9,10,11,12',
            outcome: 'W',
            turns: 8,
            endReason: 'timeout',
            p1: {bankSeconds: 120},
            p2: {bankSeconds: 0},
          },
        ],
        completedAt: DAY_3,
      });
      const t4Dir = path.join(tmpPublic, 'arena', 'tournaments', '4');
      fs.mkdirSync(t4Dir, {recursive: true});
      fs.writeFileSync(path.join(t4Dir, 'vgc-bo3-0001-g1.log'), '|win|Metamon\n', 'utf8');
      fs.writeFileSync(path.join(t4Dir, 'vgc-bo3-0001-g2.log'), '|win|Foul Play\n', 'utf8');
      fs.writeFileSync(path.join(t4Dir, 'vgc-bo3-0001-g3.log'), '|win|Metamon\n', 'utf8');

      const tourney4Html = await h.getText('/arena/tournaments/4/');
      expect(tourney4Html).toContain('<h3><a href="#games" class="subtle">Matches</a></h3>');
      expect(tourney4Html).toContain('<th>Match</th>');
      expect(tourney4Html).toContain('<strong>2</strong>–1');
      expect(tourney4Html).toContain('class="battle-detail-grid bo3-grid"');
      expect(tourney4Html).toContain('<span>Game 3</span>');
      expect(tourney4Html).toContain(
        '<span class="muted">Seeds:</span> <code>1,2,3,4</code> · ' +
        '<code>5,6,7,8</code> · <code>9,10,11,12</code>'
      );
      expect(tourney4Html).toContain('/arena/tournaments/4/vgc-bo3-0001-g1.log');
      expect(tourney4Html).toContain('/arena/tournaments/4/vgc-bo3-0001-g2.log');
      expect(tourney4Html).toContain('/arena/tournaments/4/vgc-bo3-0001-g3.log');
      expect(tourney4Html).toContain('data-total-games="3"');
      expect(tourney4Html).toContain('data-same-seats="1"');
    });
});

describe('SSR cache invalidation', () => {
  let tmpDir: string;
  let tmpPublic: string;
  let db: db.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-render-inv-'));
    tmpPublic = path.join(tmpDir, 'public');
    fs.mkdirSync(tmpPublic, {recursive: true});
    db = new Database(':memory:', {now: DAY_1});
    db.syncLadders(undefined, DAY_1);
    db.db.prepare("UPDATE ladders SET status = 'upcoming'").run();
    syncTestProjects(db, path.join(tmpDir, 'avatars'), DAY_1);
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
              p1Game1PeakRam: 900,
              p1Game2PeakRam: 900,
              p2Game1PeakRam: 1100,
              p2Game2PeakRam: 1100,
              p1Game1BankSeconds: 150,
              p1Game2BankSeconds: 150,
              p2Game1BankSeconds: 140,
              p2Game2BankSeconds: 135,
              p1Game1MeanTurnMillis: 300,
              p1Game2MeanTurnMillis: 300,
              p2Game1MeanTurnMillis: 420,
              p2Game2MeanTurnMillis: 420,
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

  const setupAnchorBase = () => {
    forceLadderActive(db, 'gen1ou20261109');
    const vFoul = createVersionAndPassSmoke(db, 'foul-play', '1.4.0', ['gen1ou20261109'], DAY_1);
    const vAnchor = createVersionAndPassSmoke(db, 'metamon', '1.0.0', ['gen1ou20261109'], DAY_1);
    db.setLadderAnchor('gen1ou20261109', 'metamon', '1.0.0', DAY_1 + 10);

    for (let i = 0; i < 65; i++) {
      const g2: ratings.GameOutcome = i % 3 === 0 ? 'L' : 'W';
      playMatch(db, 'gen1ou20261109', vAnchor, vFoul, 'W', g2, DAY_1 + 50 + i);
    }
    return {vFoul, vAnchor};
  };

  const addTwoStrongerVersions = (vFoul: number, vAnchor: number) => {
    db.refundCooldown('metamon', DAY_2);
    const v15 = createVersionAndPassSmoke(db, 'metamon', '1.5.0', ['gen1ou20261109'], DAY_2);
    for (let i = 0; i < 42; i++) {
      const g2: ratings.GameOutcome = i % 4 === 0 ? 'L' : 'W';
      playMatch(db, 'gen1ou20261109', v15, vAnchor, 'W', g2, DAY_2 + 50 + i);
      playMatch(db, 'gen1ou20261109', v15, vFoul, 'W', g2, DAY_2 + 200 + i);
    }

    db.refundCooldown('metamon', DAY_3);
    const metaAgent = db.getAgentBySlug('metamon')!;
    const v20Sub = db.createSubmission({
      agentId: metaAgent.id,
      version: '2.0.0',
      package: 'bundle',
      url: 'https://example.com/metamon-2.0.0.tar.zst',
      sha256: 'a'.repeat(64),
      ladderIds: ['gen1ou20261109'],
      now: DAY_3,
    });
    const v20Res = db.applySubmissionStatus({
      versionId: v20Sub.id,
      smokeStatus: 'passed',
      now: DAY_3 + 5,
    });

    for (let i = 0; i < 55; i++) {
      const g2: ratings.GameOutcome = i % 4 === 0 ? 'L' : 'W';
      playMatch(db, 'gen1ou20261109', v20Sub.id, v15, 'W', g2, DAY_3 + 50 + i);
      playMatch(db, 'gen1ou20261109', v20Sub.id, vAnchor, 'W', g2, DAY_3 + 200 + i);
    }
    return {metaAgent, v15, v20Res};
  };

  test('renders solo anchor version as bold primary 1500 ±0', async () => {
    setupAnchorBase();
    const h = await startRenderHarness({db, publicDir: tmpPublic, now: NOW});
    try {
      const initialHtml = await h.getText('/arena/ladders/rby/');
      expect(initialHtml).toContain(
        '<td class="num"><strong>1500</strong> <span class="muted">±0</span></td>'
      );
    } finally {
      await h.close();
    }
  });

  test('dims anchor outside Best filter alongside two stronger active versions', async () => {
    const {vFoul, vAnchor} = setupAnchorBase();
    const {v20Res} = addTwoStrongerVersions(vFoul, vAnchor);
    expect(v20Res.retiredByLadder).toEqual({});

    const h = await startRenderHarness({db, publicDir: tmpPublic, now: NOW});
    try {
      const lbHtml = await h.getText('/arena/ladders/rby/');
      const doc = await h.getJson<render.StandingsDocument>('/arena/index.json');
      const metaRows = doc.ladders.rby.standings.filter(r => r.slug === 'metamon');
      expect(metaRows.map(r => `${r.version}:${r.role}:${r.rank ?? 'unranked'}`)).toEqual([
        '2.0.0:champion:1',
        '1.5.0:challenger:unranked',
        '1.0.0:challenger:unranked',
      ]);

      const tbodyRe = /<table class="standings-table">[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/;
      const tbodyMatch = tbodyRe.exec(lbHtml);
      expect(tbodyMatch).not.toBeNull();
      const trs = Array.from(tbodyMatch![1].matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/g), m => m[0]);
      const tr20 = trs.find(r => r.includes('<code class="muted">2.0.0</code>'))!;
      const tr15 = trs.find(r => r.includes('<code class="muted">1.5.0</code>'))!;
      const tr10 = trs.find(r => r.includes('<code class="muted">1.0.0</code>'))!;

      expect(tr20).not.toContain('class="secondary"');
      expect(tr20).toContain('data-active="true"');
      expect(tr20).toContain('data-best="true"');

      expect(tr15).toContain('class="secondary"');
      expect(tr15).toContain('data-active="true"');
      expect(tr15).not.toContain('data-best="true"');

      expect(tr10).toContain('class="secondary"');
      expect(tr10).toContain('data-active="true"');
      expect(tr10).not.toContain('data-best="true"');
      expect(tr10).not.toContain('data-retired="true"');
      expect(tr10).toContain('<td class="num">1500 <span class="muted">±0</span></td>');
    } finally {
      await h.close();
    }
  });

  test('retires weakest non-anchor version when submitting a fourth version', () => {
    const {vFoul, vAnchor} = setupAnchorBase();
    const {metaAgent, v15} = addTwoStrongerVersions(vFoul, vAnchor);

    db.refundCooldown('metamon', DAY_3 + 500);
    const v25Sub = db.createSubmission({
      agentId: metaAgent.id,
      version: '2.5.0',
      package: 'bundle',
      url: 'https://example.com/metamon-2.5.0.tar.zst',
      sha256: 'b'.repeat(64),
      ladderIds: ['gen1ou20261109'],
      now: DAY_3 + 510,
    });
    const v25Res = db.applySubmissionStatus({
      versionId: v25Sub.id,
      smokeStatus: 'passed',
      now: DAY_3 + 520,
    });
    expect(v25Res.retiredByLadder).toEqual({gen1ou20261109: v15});

    const after4th = db.getLeaderboardEntries('gen1ou20261109')
      .filter(e => e.agentSlug === 'metamon');
    const byVer = new Map(after4th.map(e => [e.version, e.role]));
    expect(byVer.get('2.0.0')).toBe('champion');
    expect(byVer.get('2.5.0')).toBe('challenger');
    expect(byVer.get('1.0.0')).toBe('challenger');
    expect(byVer.get('1.5.0')).toBe('retired');
  });

  test('refreshes /arena/ relative timestamps across 15-second idle buckets', async () => {
    forceLadderActive(db, 'gen1ou20261109');
    const v1 = createVersionAndPassSmoke(db, 'metamon', '1.0.0', ['gen1ou20261109'], DAY_1);
    const v2 = createVersionAndPassSmoke(db, 'foul-play', '1.4.0', ['gen1ou20261109'], DAY_1);
    playMatch(db, 'gen1ou20261109', v1, v2, 'W', 'W', NOW - 10);

    let currentNow = NOW;
    const h = await startRenderHarness({db, publicDir: tmpPublic, now: () => currentNow});
    try {
      const initialHtml = await h.getText('/arena/');
      expect(initialHtml).toContain('>10s ago<');

      currentNow = NOW + 120;
      const refreshedHtml = await h.getText('/arena/');
      expect(refreshedHtml).toContain('>2m ago<');
    } finally {
      await h.close();
    }
  });

  test('refreshes /arena/tournaments/:id/ relative timestamps across 15-second idle buckets',
    async () => {
      const vMeta = createVersionAndPassSmoke(db, 'metamon', '1.0.0', ['gen1ou20261109'], DAY_1);
      const vFoul = createVersionAndPassSmoke(db, 'foul-play', '1.4.0', ['gen1ou20261109'], DAY_1);
      const agentMeta = db.getAgentBySlug('metamon')!;
      const agentFoul = db.getAgentBySlug('foul-play')!;

      db.upsertTournament({
        id: '1',
        name: 'Spring ’26 — [Gen 1] OU',
        format: 'gen1ou',
        version: '0.11.0',
        gamesPerMatchup: 2,
        parallelTables: 1,
        hardware: 'Isolated GCP c3-standard-22 VMs',
        status: 'completed',
        startsAt: DAY_1,
        completedAt: NOW - 10,
      });
      db.upsertTournamentEntrant({
        tournamentId: '1',
        agentId: agentMeta.id,
        versionId: vMeta,
        seed: 1,
        points: 1,
        sonnebornBerger: 0,
        gameWins: 1,
        gameLosses: 0,
        gameTies: 0,
        elo: 1520,
        se: 30,
        finalRank: 1,
      });
      db.upsertTournamentEntrant({
        tournamentId: '1',
        agentId: agentFoul.id,
        versionId: vFoul,
        seed: 2,
        points: 0,
        sonnebornBerger: 0,
        gameWins: 0,
        gameLosses: 1,
        gameTies: 0,
        elo: 1480,
        se: 30,
        finalRank: 2,
      });
      db.upsertTournamentGame({
        id: 'gen1ou-0000000001',
        tournamentId: '1',
        stage: 'Round Robin',
        cycle: 1,
        matchupGame: 1,
        status: 'completed',
        outcome: 'W',
        p1: {versionId: vMeta, team: '|Tauros|'},
        p2: {versionId: vFoul, team: '|Snorlax|'},
        games: [
          {
            gameNumber: 1,
            seed: '1,2,3,4',
            outcome: 'W',
            turns: 20,
            endReason: 'normal',
            p1: {bankSeconds: 140},
            p2: {bankSeconds: 130},
          },
        ],
        completedAt: NOW - 10,
      });

      let currentNow = NOW;
      const h = await startRenderHarness({db, publicDir: tmpPublic, now: () => currentNow});
      try {
        const initialHtml = await h.getText('/arena/tournaments/1/');
        expect(initialHtml).toContain('>10s ago<');

        currentNow = NOW + 120;
        const refreshedHtml = await h.getText('/arena/tournaments/1/');
        expect(refreshedHtml).toContain('>2m ago<');
      } finally {
        await h.close();
      }
    });

  test('invalidates /projects/ ETag when projects.dj changes on disk', async () => {
    const tmpStatic = path.join(tmpDir, 'static');
    fs.mkdirSync(tmpStatic, {recursive: true});
    for (const file of ['projects.dj', 'projects.yml', 'projects.bib']) {
      fs.copyFileSync(root('static', file), path.join(tmpStatic, file));
    }
    fs.symlinkSync(root('static', 'style'), path.join(tmpStatic, 'style'));

    const h = await startRenderHarness({
      db,
      publicDir: tmpPublic,
      staticDir: tmpStatic,
      now: NOW,
    });
    try {
      const initialRes = await h.getRaw('/projects/');
      const initialEtag = initialRes.headers.get('etag')!;
      expect(
        (await h.getRaw('/projects/', {headers: {'If-None-Match': initialEtag}})).status
      ).toBe(304);

      const djPath = path.join(tmpStatic, 'projects.dj');
      fs.appendFileSync(djPath, '\nUpdated catalog intro blurb.\n');
      const bumpedTime = new Date(Date.now() + 5000);
      fs.utimesSync(djPath, bumpedTime, bumpedTime);

      const updatedRes = await h.getRaw('/projects/', {
        headers: {'If-None-Match': initialEtag},
      });
      expect(updatedRes.status).toBe(200);
      expect(updatedRes.headers.get('etag')).not.toBe(initialEtag);
      expect(await updatedRes.text()).toContain('Updated catalog intro blurb.');
    } finally {
      await h.close();
    }
  });

  async function withCompanyProjectsHarness<T>(
    projectsYaml: string,
    fn: (h: Awaited<ReturnType<typeof startRenderHarness>>) => Promise<T>
  ): Promise<T> {
    const tmpStatic = path.join(tmpDir, 'company-static');
    fs.mkdirSync(tmpStatic, {recursive: true});
    for (const file of ['projects.dj', 'projects.bib']) {
      fs.copyFileSync(root('static', file), path.join(tmpStatic, file));
    }
    fs.writeFileSync(path.join(tmpStatic, 'projects.yml'), projectsYaml, 'utf8');
    fs.symlinkSync(root('static', 'style'), path.join(tmpStatic, 'style'));

    db.syncProjectsFromYaml(projectsYaml, undefined, NOW);
    const h = await startRenderHarness({
      db,
      publicDir: tmpPublic,
      staticDir: tmpStatic,
      now: NOW,
    });
    try {
      return await fn(h);
    } finally {
      await h.close();
    }
  }

  const COMPANY_PROJECTS_YAML = [
    '- name: Foul Play',
    '  company:',
    '    name: Silph Co.',
    '    url: https://silph.example',
    '  active: 2019',
    '  license: GPL-3.0',
    '  source: https://github.com/pmariglia/showdown',
    '  arena:',
    '    owners:',
    '      pmariglia: pmariglia.535629',
    '- name: Technical Machine',
    '  company:',
    '    name: Devon Corp',
    '    url: https://devon.example',
    '  active: 2010',
    '  arena:',
    '    owners:',
    '      davidstone: davidstone.50001',
    '- name: Plain Org Agent',
    '  company: Macro Cosmos',
    '  active: 2026',
    '- name: Indie Agent',
    '  active: 2026',
    '',
  ].join('\n');

  test('renders linked company row on /projects/', async () => {
    await withCompanyProjectsHarness(COMPANY_PROJECTS_YAML, async h => {
      const html = await h.getText('/projects/');
      expect(html).toContain(
        '<tr><td><strong>Company</strong></td>' +
        '<td><a href="https://silph.example" class="subtle">Silph Co.</a></td></tr>'
      );
      expect(html).not.toMatch(/id="IndieAgent"[\s\S]*?<strong>Company<\/strong>/);
    });
  });

  test('renders plain company name without URL on /projects/', async () => {
    await withCompanyProjectsHarness(COMPANY_PROJECTS_YAML, async h => {
      const html = await h.getText('/projects/');
      expect(html).toContain(
        '<tr><td><strong>Company</strong></td><td>Macro Cosmos</td></tr>'
      );
    });
  });

  test('renders linked company row on active /projects/:slug/ profile', async () => {
    await withCompanyProjectsHarness(COMPANY_PROJECTS_YAML, async h => {
      db.setAgentLadders('foul-play', ALL_SLOTS, NOW);
      const ladder = db.getLadders().find(l => l.slot === 'rby')!;
      forceLadderActive(db, ladder.id);
      createVersionAndPassSmoke(db, 'foul-play', '1.0.0', [ladder.id], DAY_1);

      const html = await h.getText('/projects/foul-play/');
      expect(html).toContain(
        '<tr><td><strong>Company</strong></td>' +
        '<td><a href="https://silph.example" class="subtle">Silph Co.</a></td></tr>'
      );
      expect(html.indexOf('<strong>Author</strong>')).toBeLessThan(
        html.indexOf('<strong>Company</strong>')
      );
      expect(html.indexOf('<strong>Company</strong>')).toBeLessThan(
        html.indexOf('<strong>Active</strong>')
      );
    });
  });

  test('renders linked company row on zero-entry /projects/:slug/ profile', async () => {
    await withCompanyProjectsHarness(COMPANY_PROJECTS_YAML, async h => {
      const html = await h.getText('/projects/technical-machine/');
      expect(html).toContain(
        '<tr><td><strong>Company</strong></td>' +
        '<td><a href="https://devon.example" class="subtle">Devon Corp</a></td></tr>'
      );
    });
  });

  test('exposes company metadata in /projects/:slug.json', async () => {
    await withCompanyProjectsHarness(COMPANY_PROJECTS_YAML, async h => {
      const doc = await h.getJson<{
        metadata?: {company?: {name: string; url: string}};
      }>('/projects/foul-play.json');
      expect(doc.metadata?.company).toEqual({
        name: 'Silph Co.',
        url: 'https://silph.example',
      });
    });
  });

  const SMOGON_AUTHOR_PROJECTS_YAML = [
    '- name: Smogon Linked',
    '  active: 2026',
    '  arena:',
    '    owners:',
    '      gh-alice: AliceSmogon.12345',
    '- name: Coauthored Agent',
    '  active: 2026',
    '  arena:',
    '    owners:',
    '      gh-bob: BobSmogon.23456',
    '      gh-carol: carol.ai.34567',
    '',
  ].join('\n');

  test('links active /projects/:slug/ author to Smogon profile', async () => {
    await withCompanyProjectsHarness(SMOGON_AUTHOR_PROJECTS_YAML, async h => {
      db.setAgentLadders('smogon-linked', ALL_SLOTS, NOW);
      const ladder = db.getLadders().find(l => l.slot === 'rby')!;
      forceLadderActive(db, ladder.id);
      createVersionAndPassSmoke(db, 'smogon-linked', '1.0.0', [ladder.id], DAY_1);

      const html = await h.getText('/projects/smogon-linked/');
      expect(html).toContain(
        '<tr><td><strong>Author</strong></td>' +
        '<td><a href="https://www.smogon.com/forums/members/12345/" class="subtle">' +
        'AliceSmogon</a></td></tr>'
      );
      expect(html).not.toContain('https://github.com/gh-alice');
    });
  });

  test('links zero-entry /projects/:slug/ co-authors to Smogon profiles', async () => {
    await withCompanyProjectsHarness(SMOGON_AUTHOR_PROJECTS_YAML, async h => {
      const html = await h.getText('/projects/coauthored-agent/');
      expect(html).toContain(
        '<tr><td><strong>Author</strong></td>' +
        '<td><a href="https://www.smogon.com/forums/members/23456/" class="subtle">' +
        'BobSmogon</a>, ' +
        '<a href="https://www.smogon.com/forums/members/34567/" class="subtle">' +
        'carol.ai</a></td></tr>'
      );
      expect(html).not.toContain('https://github.com/gh-bob');
      expect(html).not.toContain('https://github.com/gh-carol');
    });
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
        p1Game1PeakRam: 1180,
        p1Game2PeakRam: 1240,
        p2Game1PeakRam: 2050,
        p2Game2PeakRam: 2150,
        p1Game1BankSeconds: 132,
        p1Game2BankSeconds: 118,
        p2Game1BankSeconds: 104,
        p2Game2BankSeconds: 0,
        p1Game1MeanTurnMillis: 295,
        p1Game2MeanTurnMillis: 325,
        p2Game1MeanTurnMillis: 590,
        p2Game2MeanTurnMillis: 690,
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
      expect(battlesIndex).toContain('<span>Game 1</span>');
      expect(battlesIndex).toContain('<span>Game 2</span>');
      expect(battlesIndex).not.toContain('Client Telemetry');
      expect(battlesIndex).not.toContain('Outcome:</span>');
      expect(battlesIndex).toContain('99,88,77,66');
      expect(battlesIndex).toContain('295 ms/turn');
      expect(battlesIndex).toContain('1,180 MiB');
      expect(battlesIndex).toContain('Timeout');
      expect(battlesIndex).toContain('id="battles-pager"');

      // Game 2 keeps P1 = Match Player 1 (with swapped Team 2 & Match P1 telemetry) and
      // P2 = Match Player 2 (with swapped Team 1 & Match P2 telemetry).
      const g2Start = battlesIndex.indexOf('<span>Game 2</span>');
      const g2End = battlesIndex.indexOf('</div></div></div></td>', g2Start);
      const g2Html = battlesIndex.slice(g2Start, g2End);
      expect(g2Html).toMatch(
        new RegExp(`<tt>P1</tt> <code[^>]*>${p1OwnedHash}</code></span><span><tt>325 ms/turn</tt>`)
      );
      expect(g2Html).toMatch(
        new RegExp(`<tt>P2</tt> <code[^>]*>${unknownHash}</code></span><span><tt>690 ms/turn</tt>`)
      );

      const fpProfile = await h.getText('/projects/foul-play/');
      expect(fpProfile).toContain('<th>Version</th>');
      expect(fpProfile).not.toContain('<th>Ver.</th>');
      expect(fpProfile).toContain('data-detail-for="vgc-0000001"');
      expect(fpProfile).toContain('<span>Game 1</span>');
      expect(fpProfile).toContain('<span>Game 2</span>');
      expect(fpProfile.match(/<tt>\(P1\)<\/tt>/g)).toHaveLength(2);
      expect(fpProfile).not.toContain('<tt>(P2)</tt>');
      expect(fpProfile).not.toContain('Client Telemetry');
      expect(fpProfile).toContain('99,88,77,66');

      const jaxProfile = await h.getText('/projects/jaxcalibur/');
      expect(jaxProfile.match(/<tt>\(P2\)<\/tt>/g)).toHaveLength(2);
      expect(jaxProfile).not.toContain('<tt>(P1)</tt>');
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

  test('syncs LIVE #topbar banner onto non-placeholder static pages until completed',
    async () => {
      seedStaticPublicAssets(tmpPublic);
      db.upsertTournament({
        id: '2',
        name: 'Tournament #2: VGC 2026 Reg M-C OTS BO3',
        format: 'gen9championsvgc2026regmc',
        version: '0.11.0',
        gamesPerMatchup: 8,
        parallelTables: 2,
        hardware: 'GCP L4 Spot',
        status: 'running',
        startsAt: NOW - 1800,
      });
      const h = await startRenderHarness({db, publicDir: tmpPublic, now: NOW, syncBanner: true});
      try {
        expect(fs.readFileSync(path.join(tmpPublic, 'index.html'), 'utf8'))
          .toContain('<span>\u25cf LIVE</span> Tournament #2: VGC 2026 Reg M-C OTS BO3');
        expect(fs.readFileSync(path.join(tmpPublic, 'rules', 'index.html'), 'utf8'))
          .toContain('<span>\u25cf LIVE</span> Tournament #2: VGC 2026 Reg M-C OTS BO3');
        expect(fs.readFileSync(path.join(tmpPublic, 'background', 'index.html'), 'utf8'))
          .not.toContain('\u25cf LIVE');

        await runPkmnCli(
          ['set-tournament-status', '2', 'completed'],
          {db, publicDir: tmpPublic, now: NOW + 60, log: () => undefined}
        );
        expect(fs.readFileSync(path.join(tmpPublic, 'index.html'), 'utf8'))
          .not.toContain('\u25cf LIVE');
        expect(await h.getText('/arena/battles/')).not.toContain('\u25cf LIVE');
      } finally {
        await h.close();
      }
    });
});

const PACKED_VGC_FP = VGC_PASTES_FP.map(p => Teams.pack(Teams.import(p)));
const PACKED_VGC_JAX = VGC_PASTES_JAX.map(p => Teams.pack(Teams.import(p)));
const VGC_FP_LABEL = formatPoolTeamLabel(PACKED_VGC_FP[0], 'P1');
const VGC_JAX_LABEL = formatPoolTeamLabel(PACKED_VGC_JAX[0], undefined);

describe('JSON route parity & retired pool archives', () => {
  let tmpDir: string;
  let tmpPublic: string;
  let db: db.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-render-archive-'));
    tmpPublic = path.join(tmpDir, 'public');
    fs.mkdirSync(tmpPublic, {recursive: true});
    db = new Database(':memory:', {now: DAY_1});
    db.syncLadders(undefined, DAY_1);
    db.db.prepare("UPDATE ladders SET status = 'upcoming'").run();
    syncTestProjects(db, path.join(tmpDir, 'avatars'), DAY_1);
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
      teamsByLadder: {gen9championsvgc2026regmc: PACKED_VGC_FP},
      now: DAY_1,
    });
    const jaxSub = db.createSubmission({
      agentId: jaxAgent.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://github.com/pkmn/jax.tar.zst',
      sha256: 'b'.repeat(64),
      ladderIds: ['gen1ou20261109', 'gen9championsvgc2026regmc'],
      teamsByLadder: {gen9championsvgc2026regmc: PACKED_VGC_JAX},
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
        p1Game1PeakRam: 900,
        p1Game2PeakRam: 900,
        p2Game1PeakRam: 950,
        p2Game2PeakRam: 950,
        p1Game1BankSeconds: 150,
        p1Game2BankSeconds: 148,
        p2Game1BankSeconds: 144,
        p2Game2BankSeconds: 140,
        p1Game1MeanTurnMillis: 300,
        p1Game2MeanTurnMillis: 300,
        p2Game1MeanTurnMillis: 340,
        p2Game2MeanTurnMillis: 340,
        p1TeamLabel: VGC_FP_LABEL,
        p2TeamLabel: VGC_JAX_LABEL,
        completedAt: DAY_2,
      },
    });

    db.upsertTournament({
      id: '1',
      name: 'Tournament #1: VGC 2026 Reg M-C OTS BO3',
      format: 'gen9championsvgc2026regmc',
      version: '0.11.0',
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
      expect(teamsDoc.entrants[0].teams[0].hash).toBe(hashTeam(PACKED_VGC_FP[0]));

      const vgcLadderJson = await h.getJson<{archiveHref?: string; teamsHref?: string}>(
        '/arena/ladders/gen9championsvgc2026regmc/index.json'
      );
      expect(vgcLadderJson.archiveHref).toBe(
        '/arena/ladders/gen9championsvgc2026regmc/gen9championsvgc2026regmc-logs.tar'
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

  test('publishes log archives on active random ladders via publish-ladder-archive', async () => {
    const h = await startRenderHarness({db, publicDir: tmpPublic, now: NOW});
    try {
      const dummyArchive = path.join(tmpDir, 'rand-archive.7z');
      fs.writeFileSync(dummyArchive, 'mock-7z-rand-battle-logs', 'utf8');

      await runPkmnCli(
        ['publish-ladder-archive', 'gen9randombattle20261109', dummyArchive],
        {db, publicDir: tmpPublic, now: NOW, log: () => undefined}
      );

      const randJson = await h.getJson<{archiveHref?: string; teamsHref?: string}>(
        '/arena/ladders/rand/index.json'
      );
      expect(randJson.archiveHref).toBe(
        '/arena/ladders/gen9randombattle20261109/gen9randombattle20261109-logs.tar'
      );
      expect(randJson.teamsHref).toBeUndefined();

      const randHtml = await h.getText('/arena/ladders/rand/');
      expect(randHtml).toContain('Data:');
      expect(randHtml).toContain('gen9randombattle20261109-logs.tar');
      expect(randHtml).not.toContain('index.json');
    } finally {
      await h.close();
    }
  });

  test('renders live battle viewer on /arena/battles/ during a random ladder match', async () => {
    const h = await startRenderHarness({db, publicDir: tmpPublic, now: NOW});
    try {
      h.arenaHandle.setLiveState({
        stale: false,
        updatedAt: NOW,
        live: {
          heartbeatSeq: 9,
          matchId: 'gen9randombattle-0000100',
          ladderId: 'gen9randombattle20261109',
          slot: 'rand',
          format: 'gen9randombattle',
          game: 1,
          turn: 4,
          activeSlot: 'p1',
          turnStartedAt: NOW - 2,
          turnBudgetSeconds: 140,
          incrementSeconds: 5,
          viewer: {
            lines: [
              '|player|p1|Foul Play|1',
              '|player|p2|Jaxcalibur|2',
              '|gametype|singles',
              '|gen|9',
              '|tier|[Gen 9] Random Battle',
              '|start',
              '|turn|4',
            ],
          },
          p1: {
            slug: 'foul-play',
            name: 'Foul Play',
            version: '1.0.0',
            bankSeconds: 140,
            lastTurnMillis: 220,
            meanTurnMillis: 215,
            ram: 640,
          },
          p2: {
            slug: 'jaxcalibur',
            name: 'Jaxcalibur',
            version: '1.0.0',
            bankSeconds: 138,
            lastTurnMillis: 250,
            meanTurnMillis: 245,
            ram: 900,
          },
        },
      });

      const html = await h.getText('/arena/battles/');
      expect(html).toContain('class="battle-viewer-wrap" id="battle-viewer-wrap"');
      expect(html).toContain('id="ps-viewer-frame"');
      expect(html).not.toContain('battle-viewer-bar');
      expect(html).toContain('gen9randombattle-0000100');
    } finally {
      await h.close();
    }
  });

  test('renders inline replay slot for completed random ladder battles', async () => {
    const fpVer = db.getAgentLadderProfileEntries(
      db.getAgentBySlug('foul-play')!.id,
      'gen1ou20261109'
    )[0].versionId;
    const jaxVer = db.getAgentLadderProfileEntries(
      db.getAgentBySlug('jaxcalibur')!.id,
      'gen1ou20261109'
    )[0].versionId;
    playMatch(db, 'gen9randombattle20261109', fpVer, jaxVer, 'W', 'L', NOW + 50);
    const recent = db.getRecentMatches(1)[0];
    const randDir = path.join(tmpPublic, 'arena', 'ladders', 'gen9randombattle20261109');
    fs.mkdirSync(randDir, {recursive: true});
    fs.writeFileSync(
      path.join(randDir, `${recent.id}a.log`),
      [
        '|player|p1|Foul Play|1',
        '|player|p2|Jaxcalibur|2',
        '|split|p1',
        '|switch|p1a: Pikachu|Pikachu, L80|210/210',
        '|switch|p1a: Pikachu|Pikachu, L80|100/100',
        '|split|p2',
        '|switch|p2a: Charizard|Charizard, L80|250/250',
        '|switch|p2a: Charizard|Charizard, L80|100/100',
        '|win|Foul Play',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(path.join(randDir, `${recent.id}b.log`), '|win|Jaxcalibur\n', 'utf8');
    fs.writeFileSync(
      path.join(randDir, 'gen9randombattle20261109-logs.tar'),
      Buffer.from('tar'),
      'utf8'
    );

    const h = await startRenderHarness({db, publicDir: tmpPublic, now: NOW + 60});
    try {
      const html = await h.getText('/arena/battles/');
      expect(html).toContain(`data-match-id="${recent.id}"`);
      expect(html).toContain(
        `data-g1-log="/arena/ladders/gen9randombattle20261109/${recent.id}a.log"`
      );
      expect(html).toContain(
        `data-g2-log="/arena/ladders/gen9randombattle20261109/${recent.id}b.log"`
      );
      expect(html).not.toContain('&#9654; Replay');
      expect(html).not.toContain('<code>.log</code>');
      const bothJson = await h.getJson<{
        lines: string[];
        p1Lines: string[];
        p2Lines: string[];
      }>(`/arena/ladders/gen9randombattle20261109/${recent.id}a.log?side=both`);
      expect(bothJson.p1Lines).toContain('|switch|p1a: Pikachu|Pikachu, L80|210/210');
      expect(bothJson.p1Lines).toContain('|switch|p2a: Charizard|Charizard, L80|100/100');
      expect(bothJson.p2Lines).toContain('|switch|p1a: Pikachu|Pikachu, L80|100/100');
      expect(bothJson.p2Lines).toContain('|switch|p2a: Charizard|Charizard, L80|250/250');

      const p1Text = await h.getText(
        `/arena/ladders/gen9randombattle20261109/${recent.id}a.log?side=p1`
      );
      expect(p1Text).toContain('210/210');
      expect(p1Text).not.toContain('250/250');
      const randLadderHtml = await h.getText('/arena/ladders/rand/');
      const matchupsIdx = randLadderHtml.indexOf('<section id="matchups"');
      const archiveIdx = randLadderHtml.indexOf('gen9randombattle20261109-logs.tar');
      expect(matchupsIdx).toBeGreaterThan(0);
      expect(archiveIdx).toBeGreaterThan(matchupsIdx);
    } finally {
      await h.close();
    }
  });

  test('withholds inline replay log attributes while a pools ladder is active', async () => {
    const vgcMatches = db.getMatchesPage({ladderId: 'gen9championsvgc2026regmc', limit: 5}).matches;
    expect(vgcMatches.length).toBeGreaterThan(0);
    const vgcMatch = vgcMatches[0];
    const vgcDir = path.join(tmpPublic, 'arena', 'ladders', 'gen9championsvgc2026regmc');
    fs.mkdirSync(vgcDir, {recursive: true});
    fs.writeFileSync(path.join(vgcDir, `${vgcMatch.id}a.log`), '|win|Foul Play\n', 'utf8');
    fs.writeFileSync(path.join(vgcDir, `${vgcMatch.id}b.log`), '|win|Jaxcalibur\n', 'utf8');

    const h = await startRenderHarness({db, publicDir: tmpPublic, now: NOW + 60});
    try {
      const html = await h.getText('/arena/battles/');
      expect(html).not.toContain(
        `/arena/ladders/gen9championsvgc2026regmc/${vgcMatch.id}a.log`
      );
      expect(
        (await h.getRaw(`/arena/ladders/gen9championsvgc2026regmc/${vgcMatch.id}a.log?side=both`))
          .status
      ).toBe(404);
    } finally {
      await h.close();
    }
  });

  test('renders inline replay slot for archived pools ladder battles on battles page', async () => {
    const vgcMatch = db.getMatchesPage({
      ladderId: 'gen9championsvgc2026regmc',
      limit: 1,
    }).matches[0];
    const stagedDir = path.join(
      tmpPublic,
      'arena',
      'ladders',
      '.private',
      'gen9championsvgc2026regmc'
    );
    fs.mkdirSync(stagedDir, {recursive: true});
    fs.writeFileSync(
      path.join(stagedDir, `${vgcMatch.id}a.log`),
      [
        '|player|p1|Foul Play|1',
        '|player|p2|Jaxcalibur|2',
        '|gametype|doubles',
        '|gen|9',
        '|tier|[Gen 9 Champions] VGC 2026 Reg M-C',
        '|split|p1',
        '|switch|p1a: Incineroar|Incineroar|202/202',
        '|switch|p1a: Incineroar|Incineroar|100/100',
        '|win|Foul Play',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(path.join(stagedDir, `${vgcMatch.id}b.log`), '|win|Jaxcalibur\n', 'utf8');

    await runPkmnCli(
      ['set-ladder-status', 'gen9championsvgc2026regmc', 'archived'],
      {db, publicDir: tmpPublic, now: NOW + 10, log: () => undefined}
    );

    const h = await startRenderHarness({db, publicDir: tmpPublic, now: NOW + 60});
    try {
      const html = await h.getText('/arena/battles/');
      expect(html).toContain(`data-match-id="${vgcMatch.id}"`);
      expect(html).toContain(
        `data-g1-log="/arena/ladders/gen9championsvgc2026regmc/${vgcMatch.id}a.log"`
      );
      expect(html).toContain(
        `data-g2-log="/arena/ladders/gen9championsvgc2026regmc/${vgcMatch.id}b.log"`
      );
      const bothJson = await h.getJson<{lines: string[]; p1Lines: string[]; p2Lines: string[]}>(
        `/arena/ladders/gen9championsvgc2026regmc/${vgcMatch.id}a.log?side=both`
      );
      expect(bothJson.p1Lines).toContain('|switch|p1a: Incineroar|Incineroar|202/202');
      expect(bothJson.p2Lines).toContain('|switch|p1a: Incineroar|Incineroar|100/100');
    } finally {
      await h.close();
    }
  });

  test('renders inline replay slot for archived pools ladder battles on agent profiles',
    async () => {
      const vgcMatch = db.getMatchesPage({
        ladderId: 'gen9championsvgc2026regmc',
        limit: 1,
      }).matches[0];
      db.setLadderStatus('gen9championsvgc2026regmc', 'archived', NOW + 10);
      const vgcDir = path.join(tmpPublic, 'arena', 'ladders', 'gen9championsvgc2026regmc');
      fs.mkdirSync(vgcDir, {recursive: true});
      fs.writeFileSync(path.join(vgcDir, `${vgcMatch.id}a.log`), '|win|Foul Play\n', 'utf8');
      fs.writeFileSync(path.join(vgcDir, `${vgcMatch.id}b.log`), '|win|Jaxcalibur\n', 'utf8');

      const h = await startRenderHarness({db, publicDir: tmpPublic, now: NOW + 60});
      try {
        const vgcPane = await h.getJson<{matchesPaneHtml: string}>(
          `/projects/${vgcMatch.p1.slug}/ladders/gen9championsvgc2026regmc.json`
        );
        expect(vgcPane.matchesPaneHtml).toContain(
          `data-g1-log="/arena/ladders/gen9championsvgc2026regmc/${vgcMatch.id}a.log"`
        );
      } finally {
        await h.close();
      }
    });

  test('retains slot filter on battles page when all ladders in a slot are archived', async () => {
    db.setLadderStatus('gen9championsvgc2026regmc', 'archived', NOW + 10);
    const h = await startRenderHarness({db, publicDir: tmpPublic, now: NOW + 60});
    try {
      const html = await h.getText('/arena/battles/');
      expect(html).toContain('id="bf-vgc"');
    } finally {
      await h.close();
    }
  });

  test('fetchExternalAsset serves cached assets from disk', async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-shots-cache-'));
    try {
      const spriteFile = path.join(
        cacheDir,
        'www.smogon.com',
        'forums',
        'media',
        'minisprites',
        'pikachu.png'
      );
      fs.mkdirSync(path.dirname(spriteFile), {recursive: true});
      const expected = shots.encodePng({width: 4, height: 4, data: Buffer.alloc(4 * 4 * 4, 255)});
      fs.writeFileSync(spriteFile, expected);

      const hit = await shots.fetchExternalAsset(
        new URL('https://www.smogon.com/forums/media/minisprites/pikachu.png'),
        cacheDir
      );
      expect(hit?.contentType).toBe('image/png');
      expect(hit?.body.equals(expected)).toBe(true);

      const blocked = await shots.fetchExternalAsset(
        new URL('https://example.com/forums/media/minisprites/pikachu.png'),
        cacheDir
      );
      expect(blocked).toBeUndefined();
    } finally {
      fs.rmSync(cacheDir, {recursive: true, force: true});
    }
  });

  test('fetchExternalAsset rejects captive-portal HTML responses without caching', async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-shots-captive-'));
    const origFetch = globalThis.fetch;
    shots.resetExternalAssetCache();
    try {
      globalThis.fetch = () => Promise.resolve(
        new Response('<!doctype html><html><body>Inflight Portal</body></html>', {
          status: 200,
          headers: {'content-type': 'text/html; charset=utf-8'},
        })
      );
      const res = await shots.fetchExternalAsset(
        new URL('https://play.pokemonshowdown.com/js/battle.js?a7'),
        cacheDir
      );
      expect(res).toBeUndefined();
      expect(
        fs.existsSync(path.join(cacheDir, 'play.pokemonshowdown.com', 'js', 'battle.js'))
      ).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
      shots.resetExternalAssetCache();
      fs.rmSync(cacheDir, {recursive: true, force: true});
    }
  });

  test('fetchExternalAsset purges corrupted HTML files from disk cache', async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-shots-poison-'));
    const origFetch = globalThis.fetch;
    shots.resetExternalAssetCache();
    try {
      const poisoned = path.join(cacheDir, 'play.pokemonshowdown.com', 'js', 'battle.js');
      fs.mkdirSync(path.dirname(poisoned), {recursive: true});
      fs.writeFileSync(poisoned, '<html>Captive Portal</html>', 'utf8');
      globalThis.fetch = () => Promise.reject(new TypeError('fetch failed'));

      const res = await shots.fetchExternalAsset(
        new URL('https://play.pokemonshowdown.com/js/battle.js'),
        cacheDir
      );
      expect(res).toBeUndefined();
      expect(fs.existsSync(poisoned)).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
      shots.resetExternalAssetCache();
      fs.rmSync(cacheDir, {recursive: true, force: true});
    }
  });

  test('fetchExternalAsset short-circuits subsequent requests to unreachable hosts', async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-shots-offline-'));
    const origFetch = globalThis.fetch;
    shots.resetExternalAssetCache();
    try {
      let calls = 0;
      globalThis.fetch = () => {
        calls++;
        return Promise.reject(new TypeError('fetch failed'));
      };
      await shots.fetchExternalAsset(
        new URL('https://www.smogon.com/forums/media/minisprites/tauros.png'),
        cacheDir
      );
      await shots.fetchExternalAsset(
        new URL('https://www.smogon.com/forums/media/minisprites/chansey.png'),
        cacheDir
      );
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = origFetch;
      shots.resetExternalAssetCache();
      fs.rmSync(cacheDir, {recursive: true, force: true});
    }
  });

  test('diffPngImages highlights modified pixels in red over a faded backdrop', () => {
    const baseData = Buffer.alloc(4 * 4 * 4, 200);
    const nextData = Buffer.from(baseData);
    nextData[0] = 10;
    nextData[1] = 20;
    nextData[2] = 30;
    nextData[3] = 255;

    const {image, count} = shots.diffPngImages(
      {width: 4, height: 4, data: baseData},
      {width: 4, height: 4, data: nextData}
    );
    expect(count).toBe(1);
    expect([image.data[0], image.data[1], image.data[2], image.data[3]]).toEqual([255, 0, 0, 255]);
  });

  const createModifiedShotPair = (prefix: string) => {
    const beforeDir = path.join(tmpDir, `${prefix}-before`);
    const afterDir = path.join(tmpDir, `${prefix}-after`);
    const diffDir = path.join(tmpDir, `${prefix}-diff`);
    fs.mkdirSync(path.join(beforeDir, 'small', 'light'), {recursive: true});
    fs.mkdirSync(path.join(afterDir, 'small', 'light'), {recursive: true});

    const imgA = shots.encodePng({width: 2, height: 2, data: Buffer.alloc(16, 120)});
    const dataB = Buffer.alloc(16, 120);
    dataB[0] = 250;
    const imgB = shots.encodePng({width: 2, height: 2, data: dataB});

    fs.writeFileSync(path.join(beforeDir, 'small', 'light', 'home.png'), imgA);
    fs.writeFileSync(path.join(afterDir, 'small', 'light', 'home.png'), imgB);
    return {beforeDir, afterDir, diffDir};
  };

  test('compareShots returns structured pixel-diff metadata for modified images', async () => {
    const {beforeDir, afterDir, diffDir} = createModifiedShotPair('shots-meta');
    const res = await shots.compareShots(beforeDir, afterDir, diffDir, 0);
    expect(res.same).toBe(false);
    expect(res.changes).toHaveLength(1);
    expect(res.changes[0]).toMatchObject({
      name: 'small/light/home.png',
      status: 'modified',
      pixels: 1,
      percent: 25,
    });
  });

  test('compareShots writes diff PNGs without emitting index.html inside diffDir', async () => {
    const {beforeDir, afterDir, diffDir} = createModifiedShotPair('shots-files');
    await shots.compareShots(beforeDir, afterDir, diffDir, 0);
    expect(fs.existsSync(path.join(diffDir, 'small', 'light', 'home.png'))).toBe(true);
    expect(fs.existsSync(path.join(diffDir, 'index.html'))).toBe(false);
  });

  test('compareShots scopes sprite-animation tolerance strictly to viewer regions', async () => {
    const beforeDir = path.join(tmpDir, 'viewer-before');
    const afterDir = path.join(tmpDir, 'viewer-after');
    const diffDir = path.join(tmpDir, 'viewer-diff');
    fs.mkdirSync(path.join(beforeDir, 'desktop', 'light'), {recursive: true});
    fs.mkdirSync(path.join(afterDir, 'desktop', 'light'), {recursive: true});

    const width = 10;
    const height = 10;
    const slot = 'desktop/light/replay.png';
    const viewerRect = {x: 2, y: 2, width: 5, height: 4}; // 20 px viewer area
    const setPixel = (
      buf: Buffer,
      x: number,
      y: number,
      rgba: [number, number, number, number]
    ) => {
      const off = (y * width + x) * 4;
      buf[off] = rgba[0];
      buf[off + 1] = rgba[1];
      buf[off + 2] = rgba[2];
      buf[off + 3] = rgba[3];
    };

    const baseRaw = Buffer.alloc(width * height * 4, 120);
    for (let i = 3; i < baseRaw.length; i += 4) baseRaw[i] = 255;
    fs.writeFileSync(path.join(beforeDir, slot), shots.encodePng({width, height, data: baseRaw}));
    fs.writeFileSync(
      path.join(beforeDir, 'regions.json'),
      JSON.stringify({[slot]: [viewerRect]})
    );

    // 1. Subpixel AA (<= 16 delta) + 3 moving sprite pixels (3/20 = 15% <= 25%) inside viewer pass.
    const spriteRaw = Buffer.from(baseRaw);
    setPixel(spriteRaw, 2, 2, [128, 120, 120, 255]);
    setPixel(spriteRaw, 3, 3, [250, 20, 20, 255]);
    setPixel(spriteRaw, 4, 3, [250, 20, 20, 255]);
    setPixel(spriteRaw, 5, 3, [250, 20, 20, 255]);
    fs.writeFileSync(path.join(afterDir, slot), shots.encodePng({width, height, data: spriteRaw}));
    fs.writeFileSync(
      path.join(afterDir, 'regions.json'),
      JSON.stringify({[slot]: [viewerRect]})
    );

    const okRes = await shots.compareShots(beforeDir, afterDir, diffDir, 0);
    expect(okRes.same).toBe(true);
    expect(okRes.changes).toEqual([]);

    // 2. A single 1px change outside the viewer rect still fails strictly without viewer noise.
    const outsideRaw = Buffer.from(spriteRaw);
    setPixel(outsideRaw, 0, 0, [10, 10, 10, 255]);
    fs.writeFileSync(path.join(afterDir, slot), shots.encodePng({width, height, data: outsideRaw}));

    const outRes = await shots.compareShots(beforeDir, afterDir, diffDir, 0);
    expect(outRes.same).toBe(false);
    expect(outRes.changes[0]).toMatchObject({name: slot, pixels: 1});

    // 3. Viewer rect geometry shift (e.g. layout pushed viewer down by 4px) fails strictly.
    fs.writeFileSync(path.join(afterDir, slot), shots.encodePng({width, height, data: spriteRaw}));
    fs.writeFileSync(
      path.join(afterDir, 'regions.json'),
      JSON.stringify({[slot]: [{...viewerRect, y: viewerRect.y + 4}]})
    );
    const shiftRes = await shots.compareShots(beforeDir, afterDir, diffDir, 0);
    expect(shiftRes.same).toBe(false);
    expect(shiftRes.changes[0]?.pixels).toBe(4);

    // 4. Large change inside viewer (> 25%, e.g. 10/20 = 50% broken viewer/backdrop) fails.
    const brokenRaw = Buffer.from(baseRaw);
    for (let y = 2; y <= 3; y++) {
      for (let x = 2; x < 7; x++) {
        setPixel(brokenRaw, x, y, [255, 255, 255, 255]);
      }
    }
    fs.writeFileSync(path.join(afterDir, slot), shots.encodePng({width, height, data: brokenRaw}));
    fs.writeFileSync(
      path.join(afterDir, 'regions.json'),
      JSON.stringify({[slot]: [viewerRect]})
    );
    const brokenRes = await shots.compareShots(beforeDir, afterDir, diffDir, 0);
    expect(brokenRes.same).toBe(false);
    expect(brokenRes.changes[0]?.pixels).toBe(10);
  });

  test('renderGalleryHtml covers all 7 Visual Atlas sections with unique state names', () => {
    const scenarios = shots.buildScenarios('deadbeef1234');
    expect(scenarios.length).toBeGreaterThanOrEqual(80);
    expect(shots.SECTIONS.map(s => s.title)).toEqual([
      'Static',
      'Projects',
      'Ladders',
      'Battles',
      'Tournaments',
      'Account',
      'Wiki',
    ]);
    const names = new Set(scenarios.map(s => s.name));
    expect(names.size).toBe(scenarios.length);
    for (const section of shots.SECTIONS) {
      expect(scenarios.some(s => s.section === section.id)).toBe(true);
      const titles = scenarios.filter(s => s.section === section.id).map(s => s.title);
      expect(new Set(titles).size).toBe(titles.length);
    }

    const gallery = shots.renderGalleryHtml(scenarios, {
      hasBaseline: true,
      changes: [
        {
          name: 'desktop/light/account-teams-invalid.png',
          note: '420 px (0.36%)',
          diffPath: '.shots/diff/desktop/light/account-teams-invalid.png',
          status: 'modified',
          pixels: 420,
          percent: 0.36,
        },
      ],
    });
    expect(gallery).toContain('pkmn.ai Visual Atlas');
    expect(gallery).toContain("'All (' + totalVisible + ')'");
    expect(gallery).not.toContain('search-input');
    expect(gallery).not.toContain('carousel-desc');
    expect(gallery).not.toContain('grid-item-desc');
    expect(gallery).toContain('data-vp="desktop" class="active"');
    expect(gallery).toContain('data-theme="light" class="active"');
    expect(gallery).toContain('data-compare="split"');
    expect(gallery).toContain('desktop/light/account-teams-invalid.png');
    expect(gallery).toContain('account-ineligible-smogon-banned');
  });

  test('filterScenarios returns all scenarios when given no filters', () => {
    const scenarios = shots.buildScenarios('deadbeef1234');
    expect(shots.filterScenarios(scenarios)).toHaveLength(scenarios.length);
    expect(shots.filterScenarios(scenarios, ['  ,  '])).toHaveLength(scenarios.length);
  });

  test('filterScenarios matches comma-separated section names', () => {
    const scenarios = shots.buildScenarios('deadbeef1234');
    const filtered = shots.filterScenarios(scenarios, ['ladders,tournaments']);
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every(s => s.section === 'ladders' || s.section === 'tournaments')).toBe(true);
    expect(filtered.some(s => s.section === 'ladders')).toBe(true);
    expect(filtered.some(s => s.section === 'tournaments')).toBe(true);
  });

  test('filterScenarios matches repeatable filter entries case-insensitively', () => {
    const scenarios = shots.buildScenarios('deadbeef1234');
    const filtered = shots.filterScenarios(scenarios, ['HOME', 'account-teams-complete']);
    expect(filtered.map(s => s.name)).toEqual([
      'home',
      'home-signed-out',
      'home-theme-light',
      'home-theme-dark',
      'home-live-banner',
      'home-menu-open',
      'account-teams-complete',
    ]);
  });

  test('emits canonical URLs with ETag caching headers across dynamic SSR routes', async () => {
    const h = await startRenderHarness({db, publicDir: tmpPublic});
    try {
      const routes = [
        {path: '/arena/', canonical: 'https://pkmn.ai/arena/', title: 'Arena | pkmn.ai'},
        {
          path: '/arena/ladders/rby/',
          canonical: 'https://pkmn.ai/arena/ladders/rby/',
          title: 'Arena — RBY | pkmn.ai',
        },
        {
          path: '/arena/battles/',
          canonical: 'https://pkmn.ai/arena/battles/',
          title: 'Arena — Battles | pkmn.ai',
        },
        {
          path: '/projects/foul-play/',
          canonical: 'https://pkmn.ai/projects/foul-play/',
          title: 'Foul Play | pkmn.ai',
        },
      ];
      for (const route of routes) {
        const res = await fetch(`${h.baseUrl}${route.path}`);
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('no-cache');
        expect(res.headers.get('etag')).toBeTruthy();
        const html = await res.text();
        expect(html).toContain(`<title>${route.title}</title>`);
        expect(html).toContain(`<link rel="canonical" href="${route.canonical}">`);
      }
    } finally {
      await h.close();
    }
  });

  test('renders opponent filter controls on agent profile pages', async () => {
    const h = await startRenderHarness({db, publicDir: tmpPublic});
    try {
      const html = await h.getText('/projects/foul-play/');
      expect(html).toContain('id="opp-select"');
      const vgcPane = await h.getJson<{
        clientData: {oppOptionsHtml: string};
        matchupsPaneHtml: string;
        matchesPaneHtml: string;
      }>('/projects/foul-play/ladders/vgc.json');
      expect(vgcPane.clientData.oppOptionsHtml).toContain('Jaxcalibur (1)</option>');
      expect(vgcPane.matchupsPaneHtml).toContain('class="opp-row" data-opp="jaxcalibur"');
      expect(vgcPane.matchesPaneHtml).toContain(
        'class="battle-row" data-ver="1.0.0" data-opp="jaxcalibur" ' +
          'tabindex="0" aria-expanded="false"'
      );
    } finally {
      await h.close();
    }
  });

  test('persists tournament viewer playback speed in localStorage', () => {
    const renderSrc = fs.readFileSync(root('server', 'render.tsx'), 'utf8');
    const tourSrc = fs.readFileSync(root('server', 'tournaments.tsx'), 'utf8');
    expect(renderSrc).toContain('pkmn-viewer-speed');
    expect(renderSrc).toContain("postToFrame(frameEl, {type: 'speed', speed: saved})");
    expect(renderSrc).toContain('localStorage.setItem(SPEED_KEY, data.speed)');
    expect(tourSrc).toContain('render.buildBattleDetailClientJs()');
    expect(tourSrc).toContain('syncFramePrefs(frame)');
  });

  const seedPaginatedHistory = () => {
    const jaxId = db.getAgentBySlug('jaxcalibur')!.id;
    const jaxVer = db.getAgentLadderProfileEntries(jaxId, 'gen1ou20261109')[0].versionId;
    for (let i = 1; i <= 28; i++) {
      db.db.prepare("UPDATE ladder_entries SET role = 'retired'").run();
      db.refundCooldown('foul-play', DAY_1 + i * 10);
      const vId = createVersionAndPassSmoke(
        db,
        'foul-play',
        `2.0.${i}`,
        ['gen1ou20261109'],
        DAY_1 + i * 10
      );
      playMatch(db, 'gen1ou20261109', vId, jaxVer, 'W', 'L', NOW + i);
    }
    db.db.prepare(
      "UPDATE ladder_entries SET role = 'challenger' WHERE ladder_id = 'gen1ou20261109'"
    ).run();
  };

  test('paginates ladder standings, battles, and profile version/match tables at 25 rows',
    async () => {
      seedPaginatedHistory();
      const h = await startRenderHarness({db, publicDir: tmpPublic, now: NOW + 100});
      try {
        const ladderHtml = await h.getText('/arena/ladders/rby/');
        expect(ladderHtml).toContain('id="standings-pager"');
        expect(ladderHtml).toContain('Page 1 of 2 (');

        const battlesHtml = await h.getText('/arena/battles/');
        expect(battlesHtml).toContain('id="battles-pager"');
        expect(battlesHtml).toContain('Page 1 of 2 (');

        const profileHtml = await h.getText('/projects/foul-play/');
        expect(profileHtml).toContain('aria-label="Versions pagination"');
        expect(profileHtml).toContain('Page 1 of 2 (29 versions)');
        expect(profileHtml).toContain('aria-label="Matches pagination"');
        expect(profileHtml).toContain('Page 1 of 2 (28 matches)');
      } finally {
        await h.close();
      }
    });

  test('omits tournament winner in /arena.json while status is running', async () => {
    const fpVer = db.getVersionBySlugAndLabel('foul-play', '1.0.0')!;
    db.upsertTournament({
      id: '2',
      name: 'Tournament #2: Live SV OU',
      format: 'gen9ou',
      version: '0.11.0',
      gamesPerMatchup: 10,
      parallelTables: 2,
      hardware: 'GCP L4 Spot',
      status: 'running',
      startsAt: DAY_2,
    });
    db.upsertTournamentEntrant({
      tournamentId: '2',
      agentId: fpVer.agentId,
      versionId: fpVer.id,
      seed: 1,
      elo: 1610,
      se: 40,
      points: 4,
      gameWins: 4,
      gameLosses: 0,
      gameTies: 0,
    });
    const h = await startRenderHarness({db, publicDir: tmpPublic, now: NOW});
    try {
      const doc = JSON.parse(await h.getText('/arena.json')) as {
        tournaments: Array<{id: string; status: string; winner?: unknown}>;
      };
      const completed = doc.tournaments.find(t => t.id === '1')!;
      const running = doc.tournaments.find(t => t.id === '2')!;
      expect(completed.status).toBe('completed');
      expect(completed.winner).toBeDefined();
      expect(running.status).toBe('running');
      expect(running.winner).toBeUndefined();
    } finally {
      await h.close();
    }
  });

  test('preserves quarantined opponent matches in profile oppCounts', async () => {
    db.quarantineVersion('jaxcalibur', '1.0.0', 'crash', NOW + 5);

    const h = await startRenderHarness({db, publicDir: tmpPublic, now: NOW + 10});
    try {
      const vgcPane = await h.getJson<{
        clientData: {oppOptionsHtml: string; oppCounts: Record<string, Record<string, number>>};
      }>('/projects/foul-play/ladders/vgc.json');
      expect(vgcPane.clientData.oppOptionsHtml).toContain('Jaxcalibur (1)');
      expect(vgcPane.clientData.oppCounts.all.jaxcalibur).toBe(1);
    } finally {
      await h.close();
    }
  });

  test('caps initial tournament SSR games table at 25 rows with full pager total', async () => {
    const fpVer = db.getVersionsForAgent(db.getAgentBySlug('foul-play')!.id)[0];
    const jaxVer = db.getVersionsForAgent(db.getAgentBySlug('jaxcalibur')!.id)[0];
    db.upsertTournamentEntrant({
      tournamentId: '1',
      agentId: jaxVer.agentId,
      versionId: jaxVer.id,
      seed: 2,
      elo: 1480,
      se: 30,
      points: 10,
      gameWins: 10,
      gameLosses: 20,
      gameTies: 0,
      finalRank: 2,
    });
    for (let i = 1; i <= 30; i++) {
      db.recordCompletedTournamentGame({
        id: `t1-page-${String(i).padStart(2, '0')}`,
        tournamentId: '1',
        stage: 'Round Robin',
        cycle: i,
        matchupGame: i,
        outcome: i % 2 === 0 ? 'W' : 'L',
        p1: {versionId: fpVer.id},
        p2: {versionId: jaxVer.id},
        games: [{gameNumber: 1, seed: `1,2,3,${i}`, outcome: i % 2 === 0 ? 'W' : 'L', turns: 10}],
        completedAt: DAY_2 + i * 60,
      });
    }

    const h = await startRenderHarness({db, publicDir: tmpPublic, now: NOW});
    try {
      const html = await h.getText('/arena/tournaments/1/');
      expect((html.match(/data-game-id="/g) ?? [])).toHaveLength(25);
      expect(html).toContain('data-game-id="t1-page-30"');
      expect(html).not.toContain('data-game-id="t1-page-01"');
      expect(html).toContain('Page 1 of 2 (30 games)');
    } finally {
      await h.close();
    }
  });

  test('emits nested substructs across ladder, tournament, battles, or profile JSON', async () => {
    const fpVer = db.getVersionsForAgent(db.getAgentBySlug('foul-play')!.id)[0];
    const jaxVer = db.getVersionsForAgent(db.getAgentBySlug('jaxcalibur')!.id)[0];
    db.upsertTournamentEntrant({
      tournamentId: '1',
      agentId: jaxVer.agentId,
      versionId: jaxVer.id,
      seed: 2,
      elo: 1480,
      se: 30,
      points: 6,
      gameWins: 6,
      gameLosses: 12,
      gameTies: 0,
      finalRank: 2,
    });
    db.recordCompletedTournamentGame({
      id: 't1-rr-01',
      tournamentId: '1',
      stage: 'Round Robin',
      cycle: 1,
      matchupGame: 1,
      outcome: 'W',
      p1: {versionId: fpVer.id},
      p2: {versionId: jaxVer.id},
      games: [{gameNumber: 1, seed: '1,2,3,4', outcome: 'W', turns: 9, endReason: 'normal'}],
      completedAt: DAY_2,
    });

    const h = await startRenderHarness({db, publicDir: tmpPublic, now: NOW});
    try {
      const ladderDoc = await h.getJson<render.LadderDocument>('/arena/ladders/vgc/index.json');
      expect(ladderDoc.pairings[0].low.slug).toBe('foul-play');
      expect(ladderDoc.pairings[0].high.slug).toBe('jaxcalibur');

      const tourDoc = await h.getJson<arena.TournamentDocument>('/arena/tournaments/1/index.json');
      expect(tourDoc.crosstable[0].low).toMatchObject({slug: 'foul-play', wins: 1});
      expect(tourDoc.crosstable[0].high).toMatchObject({slug: 'jaxcalibur', wins: 0});

      const battlesDoc = await h.getJson<arena.LiveDocument>('/arena/battles.json');
      expect(battlesDoc.recentMatches[0].p1.meanTurnMillis).toBe(300);
      expect(battlesDoc.recentMatches[0].games).toHaveLength(2);
      expect(battlesDoc.recentMatches[0].games[0].gameNumber).toBe(1);
      expect(battlesDoc.recentMatches[0].games[1].gameNumber).toBe(2);

      const profileDoc = await h.getJson<{
        ladders: Array<{
          slot: string;
          stats?: {reign: {top1: {totalSeconds: number}}};
          recentMatches: arena.BattleHistoryEntry[];
        }>;
      }>('/projects/foul-play.json');
      const vgcProfile = profileDoc.ladders.find(l => l.slot === 'vgc')!;
      expect(vgcProfile.stats?.reign.top1.totalSeconds).toBeGreaterThanOrEqual(0);
      expect(vgcProfile.recentMatches[0].games).toHaveLength(2);
    } finally {
      await h.close();
    }
  });

  test('renders HP circle indicators with percentage tooltips on /arena/battles/', async () => {
    const h = await startRenderHarness({db, publicDir: tmpPublic, now: NOW});
    try {
      h.arenaHandle.setLiveState({
        stale: false,
        updatedAt: NOW,
        live: {
          heartbeatSeq: 19,
          matchId: 'vgc-0000444',
          ladderId: 'gen9championsvgc2026regmc20261109',
          slot: 'vgc',
          format: 'gen9championsvgc2026regmc',
          game: 2,
          turn: 7,
          activeSlot: 'p1',
          turnStartedAt: NOW - 2,
          turnBudgetSeconds: 140,
          incrementSeconds: 25,
          game1Summary: {
            winnerSlot: 'p2',
            turns: 12,
            endReason: 'timeout',
            p1: {
              bankSeconds: 0,
              meanTurnMillis: 1950,
              ram: 840,
              team: 'P1:aabbccddeeff',
              pokemon: [
                {percent: 64, color: 'green'},
                {percent: 0, color: 'fainted'},
                {percent: 0, color: 'fainted'},
                {percent: 0, color: 'fainted'},
              ],
            },
            p2: {
              bankSeconds: 132,
              meanTurnMillis: 290,
              ram: 960,
              team: '112233445566',
              pokemon: [
                {percent: 91, color: 'green'},
                {percent: 42, color: 'yellow'},
                {percent: 0, color: 'fainted'},
                {percent: 0, color: 'fainted'},
              ],
            },
          },
          p1: {
            slug: 'foul-play',
            name: 'Foul Play',
            version: '1.0.0',
            bankSeconds: 142,
            lastTurnMillis: 250,
            meanTurnMillis: 245,
            ram: 860,
            team: '112233445566',
            pokemon: [
              {percent: 98, color: 'green'},
              {percent: 50, color: 'yellow'},
              {percent: 18, color: 'red'},
              {percent: 0, color: 'fainted'},
            ],
          },
          p2: {
            slug: 'jaxcalibur',
            name: 'Jaxcalibur',
            version: '1.0.0',
            bankSeconds: 136,
            lastTurnMillis: 280,
            meanTurnMillis: 275,
            ram: 990,
            team: 'P1:aabbccddeeff',
            pokemon: [
              {percent: 100, color: 'green'},
              {percent: 73, color: 'green'},
              {percent: 0, color: 'fainted'},
              {percent: 0, color: 'fainted'},
            ],
          },
        },
      });

      const html = await h.getText('/arena/battles/');
      const g1Pos = html.indexOf('id="live-g1"');
      const g2Pos = html.indexOf('id="slot-p1"');
      expect(g1Pos).toBeGreaterThan(0);
      expect(g1Pos).toBeLessThan(g2Pos);
      expect(html).toContain('12 turns');
      expect(html).toContain('Timeout');
      expect(html).toContain('1950 ms/turn');
      expect(html).toContain('<tt>P1</tt>');
      expect(html).toContain('<tt>P2</tt>');
      expect(html).toContain('Frozen by kernel SIGSTOP while P1 computes');
      expect(html).not.toContain('<tt>p1</tt>');
      expect(html).not.toContain('<tt>p2</tt>');
      expect(html).toMatch(
        /<span[^>]*class="(?:green hp-orb|hp-orb green)"[^>]*title="98%"[^>]*>\u25cf<\/span>/
      );
      expect(html).toMatch(/<span[^>]*class="hp-orb yellow"[^>]*title="50%"[^>]*>\u25cf<\/span>/);
      expect(html).toMatch(/<span[^>]*class="hp-orb red"[^>]*title="18%"[^>]*>\u25cf<\/span>/);
      expect(html).toMatch(
        /<span[^>]*class="(?:fainted hp-orb|hp-orb fainted)"[^>]*title="0%"[^>]*>\u25cf<\/span>/
      );
      expect(html).toContain('id="live-hp-pct"');
      expect(html).toContain('id="live-panel-wrap"');
      expect(html).toContain('Show HP %');
      expect(html).toContain('pkmn-live-hp-percent');
      expect(html).toContain('<span class="hp-pct" aria-hidden="true">98%</span>');
      expect(html).toContain('<span class="hp-pct" aria-hidden="true">0%</span>');
      expect(html).not.toContain('orb-svg');
    } finally {
      await h.close();
    }
  });

  test('renders Team Preview label on Turn 0 live battles', async () => {
    const h = await startRenderHarness({db, publicDir: tmpPublic, now: NOW});
    try {
      const sixFull: arena.PokemonHealth[] = Array.from(
        {length: 6},
        () => ({percent: 100, color: 'green'})
      );
      h.arenaHandle.setLiveState({
        stale: false,
        updatedAt: NOW,
        live: {
          heartbeatSeq: 1,
          matchId: 'vgc-0000445',
          ladderId: 'gen9championsvgc2026regmc20261109',
          slot: 'vgc',
          format: 'gen9championsvgc2026regmc',
          game: 1,
          turn: 0,
          activeSlot: 'p1',
          turnStartedAt: NOW - 1,
          turnBudgetSeconds: 150,
          incrementSeconds: 25,
          p1: {
            slug: 'foul-play',
            name: 'Foul Play',
            version: '1.0.0',
            bankSeconds: 150,
            lastTurnMillis: 0,
            meanTurnMillis: 0,
            ram: 780,
            pokemon: sixFull,
          },
          p2: {
            slug: 'jaxcalibur',
            name: 'Jaxcalibur',
            version: '1.0.0',
            bankSeconds: 150,
            lastTurnMillis: 0,
            meanTurnMillis: 0,
            ram: 820,
            pokemon: sixFull,
          },
        },
      });
      const html = await h.getText('/arena/battles/');
      expect(html).toContain('Team Preview');
      expect(
        html.match(/<span[^>]*class="(?:green hp-orb|hp-orb green)"[^>]*title="100%"/g) ?? []
      ).toHaveLength(12);
    } finally {
      await h.close();
    }
  });

  test('rejects encoded parent-traversal tournament log paths with 404', async () => {
    const escapedPath = path.join(tmpPublic, 'arena', 'escaped.log');
    fs.mkdirSync(path.dirname(escapedPath), {recursive: true});
    fs.writeFileSync(escapedPath, '|turn|1\n');
    const h = await startRenderHarness({db, publicDir: tmpPublic, now: NOW});
    try {
      const res = await fetch(`${h.baseUrl}/arena/tournaments/%2e%2e/escaped.log`);
      expect(res.status).toBe(404);
    } finally {
      await h.close();
    }
  });

  test('rejects tournament log requests for nonexistent tournament ids with 404', async () => {
    const roguePath = path.join(tmpPublic, 'arena', 'tournaments', '999', 'game1.log');
    fs.mkdirSync(path.dirname(roguePath), {recursive: true});
    fs.writeFileSync(roguePath, '|turn|1\n');
    const h = await startRenderHarness({db, publicDir: tmpPublic, now: NOW});
    try {
      const res = await fetch(`${h.baseUrl}/arena/tournaments/999/game1.log`);
      expect(res.status).toBe(404);
    } finally {
      await h.close();
    }
  });

  test('omits stale BYOT copy from tournament client standings tooltip', async () => {
    const fp = db.getAgentBySlug('foul-play')!;
    const jax = db.getAgentBySlug('jaxcalibur')!;
    const v1 = db.getVersionsForAgent(fp.id)[0].id;
    const v2 = db.getVersionsForAgent(jax.id)[0].id;
    db.upsertTournament({
      id: '31',
      name: 'Scheduled Tour',
      format: 'gen9ou',
      version: '0.11.0',
      gamesPerMatchup: 2,
      parallelTables: 1,
      hardware: 'GCP L4 Spot',
      status: 'scheduled',
      startsAt: NOW + 86_400,
    });
    db.upsertTournamentEntrant({tournamentId: '31', agentId: fp.id, versionId: v1, seed: 1});
    db.upsertTournamentEntrant({tournamentId: '31', agentId: jax.id, versionId: v2, seed: 2});
    const h = await startRenderHarness({db, publicDir: tmpPublic, now: NOW});
    try {
      const html = await h.getText('/arena/tournaments/31/');
      expect(html).not.toContain('BYOT');
      expect(html).toContain('Entrants pagination');
      expect(html).toContain('table-nav-wrap');
      expect(html).toContain('clock-bar');
      expect(html).toContain('scheduled');
    } finally {
      await h.close();
    }
  });

  test('marks upcoming ladder entrant rows with data-active for pagination', async () => {
    const meta = db.getAgentBySlug('metamon')!;
    const sub = db.createSubmission({
      agentId: meta.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://github.com/pkmn/meta-1.tar.zst',
      sha256: 'c'.repeat(64),
      ladderIds: ['gen3ou20261109'],
      now: DAY_1,
    });
    db.applySubmissionStatus({
      versionId: sub.id,
      smokeStatus: 'passed',
      now: DAY_1 + 60,
    });
    const h = await startRenderHarness({db, publicDir: tmpPublic, now: NOW});
    try {
      const html = await h.getText('/arena/ladders/adv/');
      expect(html).toContain('data-active="true"');
    } finally {
      await h.close();
    }
  });

  test('recreates stripped reign tbody inside .table-wrap.reign on profile pages', async () => {
    const h = await startRenderHarness({db, publicDir: tmpPublic, now: NOW});
    try {
      const html = await h.getText('/projects/foul-play/');
      expect(html).toContain('.table-wrap.reign');
      expect(html).toContain("createElement('tbody')");
    } finally {
      await h.close();
    }
  });

  test('guards profile hash lookups with hasOwnProperty', async () => {
    const h = await startRenderHarness({db, publicDir: tmpPublic, now: NOW});
    try {
      const html = await h.getText('/projects/foul-play/');
      expect(html).toContain('hasOwnProperty');
    } finally {
      await h.close();
    }
  });

  test('tournament page pauses VGC bank countdown during Team Preview', async () => {
    db.upsertTournament({
      id: '32',
      name: 'VGC Preview Clock Test',
      format: 'gen9doublesou',
      version: '0.11.0',
      rulesJson: JSON.stringify(['VGC Timer']),
      team: 'pools',
      gamesPerMatchup: 2,
      parallelTables: 1,
      hardware: 'Isolated GCP L4 VMs',
      status: 'running',
      startsAt: NOW - 60,
    });
    const h = await startRenderHarness({db, publicDir: tmpPublic, now: NOW});
    try {
      const html = await h.getText('/arena/tournaments/32/');
      expect(html).toContain('<tt>420s</tt> Your Time (<tt>90s</tt> preview, <tt>55s/turn</tt>)');
      expect(html).toContain('"isVgcTimer":true');
      expect(html).toContain('pageInit.isVgcTimer');
      expect(html).toContain('isVgcTimer && (turn === undefined || turn === 0)');
    } finally {
      await h.close();
    }
  });

  test('omits redundant inline Account link on /arena/ hub', async () => {
    const h = await startRenderHarness({db, publicDir: tmpPublic, now: NOW});
    try {
      const html = await h.getText('/arena/');
      expect(html).not.toContain('<nav aria-label="Arena">');
      expect(html).not.toContain('<a href="/account/">Account</a>');
      expect(html).toContain('id="account-link"');
    } finally {
      await h.close();
    }
  });

  test('omits viewer iframe src on idle /arena/battles/', async () => {
    const h = await startRenderHarness({db, publicDir: tmpPublic, now: NOW});
    try {
      const html = await h.getText('/arena/battles/');
      expect(html).toContain('id="ps-viewer-frame"');
      expect(html).not.toMatch(/<iframe[^>]*id="ps-viewer-frame"[^>]*\bsrc=/);
    } finally {
      await h.close();
    }
  });

  test('omits viewer iframe src on scheduled /arena/tournaments/:id/', async () => {
    db.upsertTournament({
      id: '33',
      name: 'Idle Viewer Tour',
      format: 'gen9ou',
      version: '0.11.0',
      gamesPerMatchup: 2,
      parallelTables: 1,
      hardware: 'GCP L4 Spot',
      status: 'scheduled',
      startsAt: NOW + 86_400,
    });
    const h = await startRenderHarness({db, publicDir: tmpPublic, now: NOW});
    try {
      const html = await h.getText('/arena/tournaments/33/');
      expect(html).toContain('id="ps-viewer-frame"');
      expect(html).not.toMatch(/<iframe[^>]*id="ps-viewer-frame"[^>]*\bsrc=/);
    } finally {
      await h.close();
    }
  });

  test('preserves /arena/battles/ ETag across idle ticks with zero matches', async () => {
    const emptyDb = new Database(':memory:', {now: NOW});
    emptyDb.syncLadders();
    emptyDb.syncProjects();
    let currentNow = NOW;
    const h = await startRenderHarness({
      db: emptyDb,
      publicDir: tmpPublic,
      now: () => currentNow,
    });
    try {
      const first = await h.getRaw('/arena/battles/');
      expect(first.status).toBe(200);
      const etag = first.headers.get('etag')!;
      currentNow = NOW + 30;
      const second = await h.getRaw('/arena/battles/', {headers: {'If-None-Match': etag}});
      expect(second.status).toBe(304);
    } finally {
      await h.close();
      emptyDb.close();
    }
  });

  test('reuses unaffected ladder ETag when another ladder records a match', async () => {
    const h = await startRenderHarness({db, publicDir: tmpPublic, now: NOW});
    try {
      const rby1 = await h.getRaw('/arena/ladders/rby/');
      const vgc1 = await h.getRaw('/arena/ladders/vgc/');
      expect(rby1.status).toBe(200);
      expect(vgc1.status).toBe(200);
      const rbyEtag = rby1.headers.get('etag')!;
      const vgcEtag = vgc1.headers.get('etag')!;

      const fp = db.getAgentBySlug('foul-play')!;
      const jax = db.getAgentBySlug('jaxcalibur')!;
      const fpVer = db.getVersionsForAgent(fp.id)[0];
      const jaxVer = db.getVersionsForAgent(jax.id)[0];
      db.recordCompletedMatch({
        match: {
          id: 'vgc-cache-02',
          ladderId: 'gen9championsvgc2026regmc',
          p1VersionId: fpVer.id,
          p2VersionId: jaxVer.id,
          seed: '5,6,7,8',
          game1Outcome: 'L',
          game2Outcome: 'L',
          category: 'LL',
          game1Turns: 10,
          game2Turns: 11,
          game1EndReason: 'normal',
          game2EndReason: 'normal',
          p1Game1PeakRam: 900,
          p1Game2PeakRam: 900,
          p2Game1PeakRam: 950,
          p2Game2PeakRam: 950,
          p1Game1BankSeconds: 150,
          p1Game2BankSeconds: 150,
          p2Game1BankSeconds: 140,
          p2Game2BankSeconds: 140,
          p1Game1MeanTurnMillis: 120,
          p1Game2MeanTurnMillis: 120,
          p2Game1MeanTurnMillis: 130,
          p2Game2MeanTurnMillis: 130,
          completedAt: NOW - 10,
        },
      });

      const rby2 = await h.getRaw('/arena/ladders/rby/', {headers: {'If-None-Match': rbyEtag}});
      const vgc2 = await h.getRaw('/arena/ladders/vgc/', {headers: {'If-None-Match': vgcEtag}});
      expect(rby2.status).toBe(304);
      expect(vgc2.status).toBe(200);
      expect(vgc2.headers.get('etag')).not.toBe(vgcEtag);
    } finally {
      await h.close();
    }
  });

  test('reuses agent profile ETag when an unrelated ladder records a match', async () => {
    forceLadderActive(db, 'gen9ou20261109');
    const soloDb = new Database(':memory:', {now: DAY_1});
    soloDb.syncLadders(undefined, DAY_1);
    soloDb.syncProjectsFromYaml(
      `${TEST_PROJECTS_YAML}
- name: Solo Agent
  active: 2026
  arena:
    owners:
      solo: solo.777
`,
      path.join(tmpDir, 'avatars'),
      DAY_1
    );
    for (const slug of ['foul-play', 'jaxcalibur', 'solo-agent']) {
      soloDb.setAgentLadders(slug, ALL_SLOTS, DAY_1);
    }
    forceLadderActive(soloDb, 'gen1ou20261109');
    forceLadderActive(soloDb, 'gen9ou20261109');
    const fp = soloDb.getAgentBySlug('foul-play')!;
    const jax = soloDb.getAgentBySlug('jaxcalibur')!;
    const solo = soloDb.getAgentBySlug('solo-agent')!;
    const fpSub = soloDb.createSubmission({
      agentId: fp.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://github.com/pkmn/fp.tar.zst',
      sha256: 'a'.repeat(64),
      ladderIds: ['gen1ou20261109', 'gen9ou20261109'],
      now: DAY_1,
    });
    const jaxSub = soloDb.createSubmission({
      agentId: jax.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://github.com/pkmn/jax.tar.zst',
      sha256: 'b'.repeat(64),
      ladderIds: ['gen9ou20261109'],
      now: DAY_1,
    });
    const soloSub = soloDb.createSubmission({
      agentId: solo.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://github.com/pkmn/solo.tar.zst',
      sha256: 'c'.repeat(64),
      ladderIds: ['gen1ou20261109'],
      now: DAY_1,
    });
    soloDb.applySubmissionStatus({versionId: fpSub.id, smokeStatus: 'passed', now: DAY_1 + 5});
    soloDb.applySubmissionStatus({versionId: jaxSub.id, smokeStatus: 'passed', now: DAY_1 + 5});
    soloDb.applySubmissionStatus({versionId: soloSub.id, smokeStatus: 'passed', now: DAY_1 + 5});
    const h = await startRenderHarness({db: soloDb, publicDir: tmpPublic, now: NOW});
    try {
      const first = await h.getRaw('/projects/solo-agent/');
      expect(first.status).toBe(200);
      const etag = first.headers.get('etag')!;
      soloDb.recordCompletedMatch({
        match: {
          id: 'sv-unrelated-01',
          ladderId: 'gen9ou20261109',
          p1VersionId: fpSub.id,
          p2VersionId: jaxSub.id,
          seed: '1,2,3,4',
          game1Outcome: 'W',
          game2Outcome: 'W',
          category: 'WW',
          game1Turns: 15,
          game2Turns: 15,
          game1EndReason: 'normal',
          game2EndReason: 'normal',
          p1Game1PeakRam: 400,
          p1Game2PeakRam: 400,
          p2Game1PeakRam: 400,
          p2Game2PeakRam: 400,
          p1Game1BankSeconds: 140,
          p1Game2BankSeconds: 140,
          p2Game1BankSeconds: 140,
          p2Game2BankSeconds: 140,
          p1Game1MeanTurnMillis: 90,
          p1Game2MeanTurnMillis: 90,
          p2Game1MeanTurnMillis: 90,
          p2Game2MeanTurnMillis: 90,
          completedAt: DAY_1 + 60,
        },
      });
      const second = await h.getRaw('/projects/solo-agent/', {headers: {'If-None-Match': etag}});
      expect(second.status).toBe(304);
    } finally {
      await h.close();
      soloDb.close();
    }
  });

  test('omits profile interactive script when an agent has no participated ladders', async () => {
    const emptyDb = new Database(':memory:', {now: NOW});
    emptyDb.syncLadders(undefined, NOW);
    emptyDb.syncProjectsFromYaml(TEST_PROJECTS_YAML, path.join(tmpDir, 'avatars'), NOW);
    const h = await startRenderHarness({db: emptyDb, publicDir: tmpPublic, now: NOW});
    try {
      const html = await h.getText('/projects/foul-play/');
      expect(html).not.toContain('profileDataMap');
      expect(html).not.toContain('applyStats');
    } finally {
      await h.close();
      emptyDb.close();
    }
  });

  test('matches ladder adjacent LOS on profile when top two agents have zero direct games',
    async () => {
      const losDb = new Database(':memory:', {now: NOW});
      losDb.syncLadders(undefined, NOW);
      syncTestProjects(losDb, path.join(tmpDir, 'avatars'), NOW);
      forceLadderActive(losDb, 'gen1ou20261109');
      const vFp = createVersionAndPassSmoke(losDb, 'foul-play', '1.0.0', ['gen1ou20261109'], DAY_1);
      const vMeta = createVersionAndPassSmoke(losDb, 'metamon', '1.0.0', ['gen1ou20261109'], DAY_1);
      const vJax = createVersionAndPassSmoke(
        losDb, 'jaxcalibur', '1.0.0', ['gen1ou20261109'], DAY_1
      );
      const vAth = createVersionAndPassSmoke(losDb, 'athena', '1.0.0', ['gen1ou20261109'], DAY_1);
      losDb.setLadderAnchor('gen1ou20261109', 'athena', '1.0.0', DAY_1 + 10);

      let ts = DAY_1 + 100;
      for (let i = 0; i < 20; i++) {
        playMatch(losDb, 'gen1ou20261109', vFp, vJax, 'W', i < 4 ? 'L' : 'W', ts++);
        playMatch(losDb, 'gen1ou20261109', vFp, vAth, 'W', i < 2 ? 'L' : 'W', ts++);
        playMatch(losDb, 'gen1ou20261109', vMeta, vJax, 'W', i < 6 ? 'L' : 'W', ts++);
        playMatch(losDb, 'gen1ou20261109', vMeta, vAth, 'W', i < 4 ? 'L' : 'W', ts++);
        playMatch(
          losDb,
          'gen1ou20261109',
          vJax,
          vAth,
          i < 4 ? 'L' : 'W',
          i < 8 ? 'L' : 'W',
          ts++
        );
      }

      const allEntries = losDb.getLeaderboardEntries('gen1ou20261109');
      const allPairs = losDb.getPairAggregatesForLadder('gen1ou20261109');
      const fpAgent = losDb.getAgentBySlug('foul-play')!;
      const partialPairs = losDb.getPairAggregatesForAgentOnLadder('gen1ou20261109', fpAgent.id);
      const trueLos = render.computeAdjacentLosMap(allEntries, allPairs, 'active').get(vFp)!;
      const partialLos = render.computeAdjacentLosMap(allEntries, partialPairs, 'active').get(vFp)!;
      expect(Math.abs(trueLos - partialLos)).toBeGreaterThan(0.01);

      const h = await startRenderHarness({db: losDb, publicDir: tmpPublic, now: ts + 60});
      try {
        const profileHtml = await h.getText('/projects/foul-play/');
        expect(profileHtml).toContain(`LOS ${(trueLos * 100).toFixed(1)}% vs. #2`);
      } finally {
        await h.close();
        losDb.close();
      }
    });

  test('skips loadAllPairs in computeAdjacentLosMap when target agent has direct lowLos', () => {
    const losDb = new Database(':memory:', {now: NOW});
    try {
      losDb.syncLadders(undefined, NOW);
      syncTestProjects(losDb, path.join(tmpDir, 'avatars'), NOW);
      forceLadderActive(losDb, 'gen1ou20261109');
      const vFp = createVersionAndPassSmoke(losDb, 'foul-play', '1.0.0', ['gen1ou20261109'], DAY_1);
      const vMeta = createVersionAndPassSmoke(losDb, 'metamon', '1.0.0', ['gen1ou20261109'], DAY_1);
      const vJax = createVersionAndPassSmoke(
        losDb, 'jaxcalibur', '1.0.0', ['gen1ou20261109'], DAY_1
      );
      const vAth = createVersionAndPassSmoke(losDb, 'athena', '1.0.0', ['gen1ou20261109'], DAY_1);
      losDb.setLadderAnchor('gen1ou20261109', 'athena', '1.0.0', DAY_1 + 10);

      let ts = DAY_1 + 100;
      for (let i = 0; i < 20; i++) {
        playMatch(losDb, 'gen1ou20261109', vFp, vMeta, 'W', i < 8 ? 'L' : 'W', ts++);
        playMatch(losDb, 'gen1ou20261109', vFp, vJax, 'W', i < 5 ? 'L' : 'W', ts++);
        playMatch(losDb, 'gen1ou20261109', vMeta, vJax, 'W', i < 8 ? 'L' : 'W', ts++);
        playMatch(losDb, 'gen1ou20261109', vMeta, vAth, 'W', i < 4 ? 'L' : 'W', ts++);
        playMatch(losDb, 'gen1ou20261109', vJax, vAth, 'W', i < 6 ? 'L' : 'W', ts++);
      }

      const allEntries = losDb.getLeaderboardEntries('gen1ou20261109');
      const fpAgent = losDb.getAgentBySlug('foul-play')!;
      const fpPairs = losDb.getPairAggregatesForAgentOnLadder('gen1ou20261109', fpAgent.id);
      const fullLos = render.computeAdjacentLosMap(
        allEntries,
        losDb.getPairAggregatesForLadder('gen1ou20261109'),
        'active'
      ).get(vFp)!;

      let loadCalls = 0;
      const result = render.computeAdjacentLosMap(allEntries, fpPairs, 'active', {
        targetVersionIds: new Set([vFp]),
        loadAllPairs: () => {
          loadCalls++;
          return losDb.getPairAggregatesForLadder('gen1ou20261109');
        },
      });
      expect(loadCalls).toBe(0);
      expect(result.get(vFp)).toBeCloseTo(fullLos, 6);
    } finally {
      losDb.close();
    }
  });

  test('orders /arena/ladders/:key.json snapshots chronologically across versions', async () => {
    const snapDb = new Database(':memory:', {now: NOW});
    snapDb.syncLadders(undefined, NOW);
    syncTestProjects(snapDb, path.join(tmpDir, 'avatars'), NOW);
    forceLadderActive(snapDb, 'gen1ou20261109');
    const vFp = createVersionAndPassSmoke(snapDb, 'foul-play', '1.0.0', ['gen1ou20261109'], DAY_1);
    const vMeta = createVersionAndPassSmoke(snapDb, 'metamon', '1.0.0', ['gen1ou20261109'], DAY_1);
    const ins = snapDb.db.prepare(`
      INSERT INTO rating_snapshots (ladder_id, version_id, day_utc, matches, elo, se, lcb, gxe)
      VALUES ('gen1ou20261109', ?, ?, 20, 1500, 30, 1441, 50)
    `);
    ins.run(vFp, '2026-11-10');
    ins.run(vFp, '2026-11-12');
    ins.run(vMeta, '2026-11-10');
    ins.run(vMeta, '2026-11-11');

    const h = await startRenderHarness({db: snapDb, publicDir: tmpPublic, now: NOW});
    try {
      const doc = JSON.parse(await h.getText('/arena/ladders/rby.json')) as {
        snapshots: Array<{dayUtc: string; slug: string}>;
      };
      expect(doc.snapshots.map(s => `${s.dayUtc}:${s.slug}`)).toEqual([
        '2026-11-10:foul-play',
        '2026-11-10:metamon',
        '2026-11-11:metamon',
        '2026-11-12:foul-play',
      ]);
    } finally {
      await h.close();
      snapDb.close();
    }
  });

  test('renders agent /info telemetry panels across both, one-sided, silent games', () => {
    expect(
      render.renderAiPanelHtml('Hydra', 'Vertex', undefined, undefined, undefined)
    ).toBe('');

    const oneSided = render.renderAiPanelHtml(
      'Hydra',
      'Vertex',
      {win: 0.64, depth: 7, seldepth: 17, nodes: 205000, nps: 99000},
      undefined,
      [{turn: 1, p1: 0.52}, {turn: 2, p1: 0.64}],
      {activeTurn: 2, interactive: true}
    );
    expect(oneSided).toContain('64.0%');
    expect(oneSided).toContain('7/17');
    expect(oneSided).toContain('205.0k');
    expect(oneSided).toContain('99.0k');
    expect(oneSided).toContain('no /info telemetry');
    expect(oneSided).toContain('data-seek-turn="1"');
    expect(oneSided).toContain('data-seek-turn="2"');
    expect(oneSided).toContain('<span>Win probability</span>');
    expect(oneSided).not.toContain('ai-winbar-labels');
    expect(oneSided).not.toContain('ai-swatch-p2');

    const both = render.renderAiPanelHtml(
      'Hydra',
      'Vertex',
      {win: 0.64, depth: 7, nodes: 205000, nps: 99000},
      {win: 0.41, nodes: 38900, nps: 54000},
      [{turn: 1, p1: 0.52, p2: 0.49}, {turn: 2, p1: 0.64, p2: 0.41}],
      {interactive: true}
    );
    expect(both).toContain('ai-winbar-mark');
    expect(both).toContain('ai-swatch-p1');
    expect(both).toContain('ai-swatch-p2');
    expect(both).toContain('<span class="ai-slot-tag">P1</span>');
    expect(both).toContain('<span class="ai-slot-tag">P2</span>');
    expect(both).toContain('Hydra (P1): 64.0%');
    expect(both).toContain('Vertex (P2): 41.0%');
    expect(both).toContain('P1 win%');
    expect(both).toContain('1−P2 win%');
    expect(both).toContain('Turn 1 · P1 52.0% · P2 49.0%');
    expect(both).not.toContain('no /info telemetry');

    const clientAiJs = render.buildAiPanelClientJs();
    expect(clientAiJs).toContain('<span class="ai-slot-tag">P1</span>');
    expect(clientAiJs).toContain('<span class="ai-slot-tag">P2</span>');
    expect(clientAiJs).toContain('P1 win%');
    expect(clientAiJs).toContain('1−P2 win%');
    expect(clientAiJs).not.toContain('>p1<');
    expect(clientAiJs).not.toContain('>p2<');
    expect(clientAiJs).not.toContain('p1 win%');
    expect(clientAiJs).not.toContain('1−p2 win%');

    const withoutStrip = render.renderAiPanelHtml(
      'Hydra',
      'Vertex',
      {win: 0.64, nodes: 205000},
      {win: 0.41, nodes: 38900},
      [{turn: 1, p1: 0.64, p2: 0.41}],
      {showStrip: false}
    );
    expect(withoutStrip).not.toContain('ai-strip');
    expect(withoutStrip).toContain('ai-winbar-track');
    expect(withoutStrip).toContain('ai-chart');
  });

  test('battle viewer strips |ai| lines while supporting turn sync / seek messages', () => {
    const viewerDir = path.join(tmpDir, 'viewer-check');
    tournaments.renderBattleViewerPage(viewerDir);
    const html = fs.readFileSync(
      path.join(viewerDir, 'arena', 'viewer', 'index.html'),
      'utf8'
    );
    expect(html).toContain("!line.startsWith('|ai|')");
    expect(html).toContain("msg.type === 'seek'");
    expect(html).toContain('turn: battle.turn');
  });

  test('Time component emits date-only UTC fallback with localized full-timestamp title', () => {
    const epoch = Date.UTC(2026, 3, 1, 0, 30, 15) / 1000;
    const html = String(util.Time({epoch, format: 'date'}));
    expect(html).toContain(`data-epoch="${epoch}"`);
    expect(html).toContain('data-fmt="date"');
    expect(html).toContain('datetime="2026-04-01T00:30:15.000Z"');
    expect(html).toContain('data-title-tmpl="{0}"');
    expect(html).toContain(`data-title-epochs="${epoch}"`);
    expect(html).toContain('title="2026-04-01 00:30:15 UTC"');
    expect(html).toContain('>2026-04-01</time>');
  });

  test('Time component emits datetime UTC fallback without seconds', () => {
    const epoch = Date.UTC(2026, 3, 1, 0, 30, 15) / 1000;
    const html = String(util.Time({epoch, format: 'datetime'}));
    expect(html).toContain(`data-epoch="${epoch}"`);
    expect(html).toContain('data-fmt="datetime"');
    expect(html).toContain('>2026-04-01 00:30 UTC</time>');
  });

  test('localizedTitle encodes mixed format tokens into data-title attributes', () => {
    const start = Date.UTC(2026, 3, 2, 18, 0, 0) / 1000;
    const close = Date.UTC(2026, 3, 2, 0, 0, 0) / 1000;
    const attrs = util.localizedTitle([
      {prefix: 'starts ', epoch: start, format: 'date'},
      {prefix: 'closes ', epoch: close, format: 'datetime'},
    ]);
    expect(attrs).toEqual({
      title: 'starts 2026-04-02 · closes 2026-04-02 00:00 UTC',
      'data-title-tmpl': 'starts {0:date} · closes {1:datetime}',
      'data-title-epochs': `${start},${close}`,
    });
  });

  test('renderLocalizedText wraps inline UTC timestamps in Time elements', () => {
    const close = Date.UTC(2026, 3, 2, 0, 0, 0) / 1000;
    const html = String(jsx(Fragment, undefined, util.renderLocalizedText(
      'Entries closed at 2026-04-02 00:00 UTC.'
    )));
    expect(html).toContain('Entries closed at <time ');
    expect(html).toContain(`data-epoch="${close}"`);
    expect(html).toContain('data-fmt="datetime"');
    expect(html).toContain('>2026-04-02 00:00 UTC</time>.');
  });

  test('localizedTitleFromText converts inline UTC timestamps to title templates', () => {
    const retry = Date.UTC(2026, 3, 2, 12, 30, 0) / 1000;
    const attrs = util.localizedTitleFromText(
      'Failed smoke test limit reached; retry after 2026-04-02 12:30 UTC.'
    );
    expect(attrs).toEqual({
      title: 'Failed smoke test limit reached; retry after 2026-04-02 12:30 UTC.',
      'data-title-tmpl': 'Failed smoke test limit reached; retry after {0:datetime}.',
      'data-title-epochs': String(retry),
    });
  });

  test('profile JSON exposes infoStatus on version entries while HTML syncs ?v=', async () => {
    const testDb = new Database(':memory:', {now: 1_760_000_000});
    const app = polka();
    const arenaHandle = arena.register(app, {db: testDb, arenaSecret: 'test-render-secret'});
    render.register(app, {db: testDb, arena: arenaHandle, now: () => 1_760_000_020});
    const srv = http.createServer((req, res) => app.handler(req as polka.Request, res));
    await new Promise<void>(resolve => srv.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(srv.address() as {port: number}).port}`;
    try {
      testDb.syncLadders(undefined, 1_760_000_000);
      testDb.db.prepare("UPDATE ladders SET status = 'active'").run();
      testDb.syncProjectsFromYaml(
        '- name: Alpha\n  slug: alpha\n  arena:\n    owner: {github: a1, smogon: a1}\n',
        undefined,
        1_760_000_000
      );
      const alpha = testDb.getAgentBySlug('alpha')!;
      testDb.setAgentLadders(alpha.id, ['rby'], 1_760_000_000);
      const v1 = testDb.createSubmission({
        agentId: alpha.id,
        version: '1.0',
        package: 'bundle',
        url: 'https://example.com/alpha-1.0.tar.zst',
        sha256: 'a'.repeat(64),
        ladderIds: ['gen1ou20261109'],
        now: 1_760_000_000,
      });
      testDb.applySubmissionStatus({
        versionId: v1.id,
        smokeStatus: 'passed',
        diagnostics: [{
          ladderId: 'gen1ou20261109',
          format: 'gen1ou',
          turns: 4,
          endReason: 'win',
          durationMillis: 500,
          battleLog: '|turn|1\n|ai|p1|{"win":0.55}',
          infoStatus: 'partial',
        }],
        now: 1_760_000_010,
      });
      const doc = await (await fetch(`${base}/projects/alpha.json`)).json() as {
        ladders: Array<{versions: Array<{infoStatus?: string}>}>;
      };
      expect(doc.ladders[0].versions[0].infoStatus).toBe('partial');
      const html = await (await fetch(`${base}/projects/alpha/`)).text();
      expect(html).toContain('class="info-dot partial yes"');
      expect(html).toContain("url.searchParams.set('v', curVer)");
      expect(html).toContain('tabindex="0"');
    } finally {
      arenaHandle.close();
      srv.closeAllConnections();
      await new Promise<void>(resolve => srv.close(() => resolve()));
      testDb.close();
    }
  });

  test('mutes version code when preceded by project name', async () => {
    const testDb = new Database(':memory:', {now: 1_760_000_000});
    testDb.syncLadders(undefined, 1_760_000_000);
    testDb.db.prepare("UPDATE ladders SET status = 'active'").run();
    testDb.syncProjectsFromYaml(
      '- name: Alpha\n  slug: alpha\n  arena:\n    owner: {github: a1, smogon: a1}\n' +
      '- name: Beta\n  slug: beta\n  arena:\n    owner: {github: b1, smogon: b1}\n',
      undefined,
      1_760_000_000
    );
    const alpha = testDb.getAgentBySlug('alpha')!;
    const beta = testDb.getAgentBySlug('beta')!;
    testDb.setAgentLadders(alpha.id, ['rby'], 1_760_000_000);
    testDb.setAgentLadders(beta.id, ['rby'], 1_760_000_000);
    const vA = testDb.createSubmission({
      agentId: alpha.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://example.com/alpha-1.0.0.tar.zst',
      sha256: 'a'.repeat(64),
      ladderIds: ['gen1ou20261109'],
      now: 1_760_000_000,
    });
    const vB = testDb.createSubmission({
      agentId: beta.id,
      version: '2.0.0',
      package: 'bundle',
      url: 'https://example.com/beta-2.0.0.tar.zst',
      sha256: 'b'.repeat(64),
      ladderIds: ['gen1ou20261109'],
      now: 1_760_000_000,
    });
    testDb.applySubmissionStatus({versionId: vA.id, smokeStatus: 'passed', now: 1_760_000_010});
    testDb.applySubmissionStatus({versionId: vB.id, smokeStatus: 'passed', now: 1_760_000_010});
    playMatch(testDb, 'gen1ou20261109', vA.id, vB.id, 'W', 'W', 1_760_000_030);

    const h = await startRenderHarness({db: testDb, publicDir: tmpPublic, now: 1_760_000_050});
    try {
      const ladderHtml = await h.getText('/arena/ladders/rby/');
      expect(ladderHtml).toContain('Alpha</a> <code class="muted">1.0.0</code>');
      expect(ladderHtml).toContain('Beta</a> <code class="muted">2.0.0</code>');

      const battlesHtml = await h.getText('/arena/battles/');
      expect(battlesHtml).toContain('<strong>Alpha</strong></a> <code class="muted">1.0.0</code>');
      expect(battlesHtml).toContain('Beta</a> <code class="muted">2.0.0</code>');

      const profileHtml = await h.getText('/projects/alpha/');
      expect(profileHtml).toContain('<strong>Beta</strong></a> <code class="muted">2.0.0</code>');
      expect(profileHtml).toContain('Beta</a> <code class="muted">2.0.0</code>');
      expect(profileHtml).toContain('<code><strong>1.0.0</strong></code>');
      expect(profileHtml).toContain('<td><code>1.0.0</code></td>');
    } finally {
      await h.close();
      testDb.close();
    }
  });

  test('renders restarting banner across all /arena/* pages only', async () => {
    const testDb = new Database(':memory:', {now: 1_760_000_000});
    testDb.syncLadders(undefined, 1_760_000_000);
    testDb.db.prepare("UPDATE ladders SET status = 'active'").run();
    testDb.upsertTournament({
      id: '1',
      name: 'Winter Cup',
      format: 'gen9vgc2026regf',
      version: '0.11.0',
      gamesPerMatchup: 10,
      parallelTables: 1,
      hardware: '1x L4',
      startsAt: 1_760_100_000,
    });
    const h = await startRenderHarness({db: testDb, publicDir: tmpPublic, now: 1_760_000_050});
    try {
      const hbRes = await h.getRaw('/api/arena/heartbeat', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ARENA_SECRET}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({idle: true, restarting: true}),
      });
      expect(hbRes.status).toBe(200);
      expect(h.arenaHandle.getState().restarting).toBe(true);

      const bannerTag = '<div id="topbar" class="restarting">';
      const arenaRoutes = [
        '/arena/',
        '/arena/ladders/rby/',
        '/arena/battles/',
        '/arena/tournaments/1/',
      ];
      for (const route of arenaRoutes) {
        expect(await h.getText(route)).toContain(bannerTag);
      }

      expect(await h.getText('/projects/')).not.toContain(bannerTag);

      const liveJson = await h.getJson<{restarting?: boolean}>('/api/live.json');
      expect(liveJson.restarting).toBe(true);
    } finally {
      await h.close();
      testDb.close();
    }
  });

  test('suppresses restarting banner when arena heartbeat is stale', async () => {
    const testDb = new Database(':memory:', {now: 1_760_000_000});
    testDb.syncLadders(undefined, 1_760_000_000);
    const h = await startRenderHarness({
      db: testDb,
      publicDir: tmpPublic,
      now: 1_760_000_050,
      liveDoc: {
        updatedAt: 1_760_000_050,
        stale: true,
        restarting: true,
        recentMatches: [],
      },
    });
    try {
      expect(await h.getText('/arena/')).not.toContain('class="restarting"');
      const liveJson = await h.getJson<{restarting?: boolean}>('/api/live.json');
      expect(liveJson.restarting).toBeUndefined();
    } finally {
      await h.close();
      testDb.close();
    }
  });

  test('clears restarting banner after a normal arena heartbeat', async () => {
    const testDb = new Database(':memory:', {now: 1_760_000_000});
    testDb.syncLadders(undefined, 1_760_000_000);
    const h = await startRenderHarness({
      db: testDb,
      publicDir: tmpPublic,
      now: 1_760_000_050,
      liveDoc: {
        updatedAt: 1_760_000_050,
        stale: false,
        restarting: true,
        recentMatches: [],
      },
    });
    try {
      expect(await h.getText('/arena/')).toContain('class="restarting"');

      const hbRes = await h.getRaw('/api/arena/heartbeat', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ARENA_SECRET}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({idle: true}),
      });
      expect(hbRes.status).toBe(200);
      expect(h.arenaHandle.getState().restarting).toBe(false);
      expect(await h.getText('/arena/')).not.toContain('class="restarting"');
    } finally {
      await h.close();
      testDb.close();
    }
  });

  test('prefers live tournament banner over restarting banner on /arena/* pages', async () => {
    const testDb = new Database(':memory:', {now: 1_760_000_000});
    testDb.syncLadders(undefined, 1_760_000_000);
    testDb.upsertTournament({
      id: '1',
      name: 'Winter Cup',
      format: 'gen9vgc2026regf',
      version: '0.11.0',
      gamesPerMatchup: 10,
      parallelTables: 1,
      hardware: '1x L4',
      startsAt: 1_760_000_000,
      status: 'running',
    });
    const h = await startRenderHarness({
      db: testDb,
      publicDir: tmpPublic,
      now: 1_760_000_050,
      liveDoc: {
        updatedAt: 1_760_000_050,
        stale: false,
        restarting: true,
        recentMatches: [],
      },
    });
    try {
      for (const route of ['/arena/', '/arena/battles/', '/arena/tournaments/1/']) {
        const html = await h.getText(route);
        expect(html).toContain('<span>\u25cf LIVE</span> Winter Cup');
        expect(html).not.toContain('class="restarting"');
      }
    } finally {
      await h.close();
      testDb.close();
    }
  });
});

describe('navigation cross-links', () => {
  let tmpDir: string;
  let tmpPublic: string;
  let testDb: Database;
  let h: Awaited<ReturnType<typeof startRenderHarness>>;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-render-nav-'));
    tmpPublic = path.join(tmpDir, 'public');
    fs.mkdirSync(tmpPublic, {recursive: true});
    testDb = new Database(':memory:', {now: 1_760_000_000});
    testDb.syncLadders(undefined, 1_760_000_000);
    testDb.db.prepare("UPDATE ladders SET status = 'active'").run();
    testDb.syncProjectsFromYaml(
      [
        '- name: Alpha',
        '  arena:',
        '    owners:',
        '      alice: alice.101',
        '- name: Beta',
        '  arena:',
        '    owners:',
        '      bob: bob.102',
      ].join('\n'),
      undefined,
      1_760_000_000
    );
    const alpha = testDb.getAgentBySlug('alpha')!;
    const beta = testDb.getAgentBySlug('beta')!;
    testDb.setAgentLadders(alpha.id, ['rby'], 1_760_000_000);
    testDb.setAgentLadders(beta.id, ['rby'], 1_760_000_000);
    const aVer = testDb.createSubmission({
      agentId: alpha.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://example.com/a.tar.zst',
      sha256: 'a'.repeat(64),
      ladderIds: ['gen1ou20261109'],
      now: 1_760_000_000,
    });
    const bVer = testDb.createSubmission({
      agentId: beta.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://example.com/b.tar.zst',
      sha256: 'b'.repeat(64),
      ladderIds: ['gen1ou20261109'],
      now: 1_760_000_000,
    });
    testDb.applySubmissionStatus({versionId: aVer.id, smokeStatus: 'passed', now: 1_760_000_001});
    testDb.applySubmissionStatus({versionId: bVer.id, smokeStatus: 'passed', now: 1_760_000_001});
    testDb.upsertTournament({
      id: '1',
      name: 'Tournament #1: RBY',
      format: 'gen1ou',
      version: '0.11.0',
      gamesPerMatchup: 2,
      parallelTables: 1,
      hardware: 'Test Host',
      status: 'completed',
      startsAt: 1_760_000_000,
      completedAt: 1_760_000_010,
    });
    testDb.upsertTournamentEntrant({
      tournamentId: '1',
      agentId: alpha.id,
      versionId: aVer.id,
      seed: 1,
    });
    testDb.db.prepare(
      "UPDATE tournament_entrants SET final_rank = 1 WHERE tournament_id = '1' AND agent_id = ?"
    ).run(alpha.id);
    playMatch(testDb, 'gen1ou20261109', aVer.id, bVer.id, 'W', 'W', 1_760_000_020);

    h = await startRenderHarness({db: testDb, publicDir: tmpPublic, now: 1_760_000_050});
    h.arenaHandle.setLiveState({
      stale: false,
      updatedAt: 1_760_000_045,
      live: {
        heartbeatSeq: 5,
        matchId: 'gen1ou-0000010',
        ladderId: 'gen1ou20261109',
        slot: 'rby',
        format: 'gen1ou',
        game: 1,
        turn: 7,
        activeSlot: 'p1',
        turnStartedAt: 1_760_000_044,
        turnBudgetSeconds: 60,
        incrementSeconds: 15,
        p1: {
          slug: 'alpha',
          name: 'Alpha',
          version: '1.0.0',
          bankSeconds: 150,
          lastTurnMillis: 120,
          meanTurnMillis: 120,
          ram: 512,
        },
        p2: {
          slug: 'beta',
          name: 'Beta',
          version: '1.0.0',
          bankSeconds: 150,
          lastTurnMillis: 110,
          meanTurnMillis: 110,
          ram: 512,
        },
      },
    });
  });

  afterAll(async () => {
    await h.close();
    testDb.close();
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  test('renders live match indicator on /arena/ladders/:slot/', async () => {
    const ladderHtml = await h.getText('/arena/ladders/rby/');
    expect(ladderHtml).toContain('class="ladder-live"');
    expect(ladderHtml).toContain('Alpha vs. Beta');
  });

  test('links ladder Battles heading above history to /arena/battles/#:slot', async () => {
    const ladderHtml = await h.getText('/arena/ladders/rby/');
    expect(ladderHtml).toContain(
      '<h3 id="battles"><a href="/arena/battles/#rby" class="subtle">Battles<svg'
    );
    expect(ladderHtml).toContain('class="heading-arrow"');
    expect(ladderHtml.indexOf('id="battles"')).toBeGreaterThan(
      ladderHtml.indexOf('id="standings"')
    );
    expect(ladderHtml.indexOf('id="battles"')).toBeLessThan(
      ladderHtml.indexOf('id="history"')
    );
  });

  test('links live battle header to the active ladder on /arena/battles/', async () => {
    const battlesHtml = await h.getText('/arena/battles/');
    expect(battlesHtml).toContain(
      '<a href="/arena/ladders/rby/" class="subtle"><tt><strong>RBY</strong></tt></a> · ' +
      '<code>gen1ou-0000010</code>'
    );
  });

  test('links expanded battle history metadata to the ladder on /arena/battles/', async () => {
    const battlesHtml = await h.getText('/arena/battles/');
    expect(battlesHtml).toContain(
      '<a href="/arena/ladders/rby/" class="subtle"><tt><strong>RBY</strong></tt></a> · <time'
    );
  });

  test('links ladder rank to the ladder page on /projects/:slug/', async () => {
    const profileHtml = await h.getText('/projects/alpha/');
    expect(profileHtml).toContain('<a href="/arena/ladders/rby/" title="View RBY ladder">');
  });

  test('renders tournament placements row on /projects/:slug/', async () => {
    const profileHtml = await h.getText('/projects/alpha/');
    expect(profileHtml).toContain('<strong>Tournaments</strong>');
    expect(profileHtml).toContain('href="/arena/tournaments/1/"');
    expect(profileHtml).toContain('<tt>T#1 #1</tt>');
  });

  test('renders plain section headings without Arena links across subpages', async () => {
    const ladderHtml = await h.getText('/arena/ladders/rby/');
    expect(ladderHtml).toContain('<h2>Ladders</h2>');
    expect(ladderHtml).not.toContain('<h2><a href="/arena/"');

    const battlesHtml = await h.getText('/arena/battles/');
    expect(battlesHtml).toContain('<h2>Battles</h2>');
    expect(battlesHtml).not.toContain('<h2><a href="/arena/"');

    const tourHtml = await h.getText('/arena/tournaments/1/');
    expect(tourHtml).toContain('<h2>Tournaments</h2>');
    expect(tourHtml).not.toContain('<h2><a href="/arena/"');
  });
});

describe('battles smoke-testing status', () => {
  let tmpDir: string;
  let tmpPublic: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-render-smoke-'));
    tmpPublic = path.join(tmpDir, 'public');
    fs.mkdirSync(tmpPublic, {recursive: true});
  });

  afterAll(() => {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  const extractLivePanel = (html: string) =>
    /<div id="live-panel">([\s\S]*?)<\/div>\s*<div class="battle-viewer-wrap/.exec(html)?.[1] ??
    '';

  const postArena = (
    h: Awaited<ReturnType<typeof startRenderHarness>>,
    endpoint: string,
    payload: unknown
  ) => h.getRaw(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ARENA_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const sampleDiagnosticPayload = {
    versionId: 99,
    agentId: 7,
    agentSlug: 'secret-agent',
    agentName: 'Secret Agent',
    version: '9.9.9-private',
    format: 'gen9ou',
    targetName: 'Gen 9 OU',
    phase: 'battle',
    turn: 1,
    turnStartedAt: 1_760_000_050,
    turnBudgetSeconds: 150,
    incrementSeconds: 15,
    p1: {
      name: 'Secret Agent (P1)',
      version: '9.9.9-private',
      bankSeconds: 150,
      thinking: true,
    },
    p2: {
      name: 'Secret Agent (P2)',
      version: '9.9.9-private',
      bankSeconds: 150,
      thinking: false,
    },
    lines: ['|turn|1'],
  };

  async function withHarness(
    liveDoc: arena.LiveDocument | undefined,
    fn: (h: Awaited<ReturnType<typeof startRenderHarness>>) => Promise<void>
  ) {
    const testDb = new Database(':memory:', {now: 1_760_000_000});
    testDb.syncLadders(undefined, 1_760_000_000);
    const h = await startRenderHarness({
      db: testDb,
      publicDir: tmpPublic,
      now: 1_760_000_050,
      liveDoc,
    });
    try {
      await fn(h);
    } finally {
      await h.close();
      testDb.close();
    }
  }

  test('renders smoke-testing agent from idle heartbeat on /arena/battles/', async () => {
    await withHarness(undefined, async h => {
      const res = await postArena(h, '/api/arena/heartbeat', {
        idle: true,
        smokeTesting: {slug: '0-error', name: '0 ERROR'},
      });
      expect(res.status).toBe(200);
      expect(h.arenaHandle.getState().smokeTesting).toEqual({slug: '0-error', name: '0 ERROR'});

      const panelHtml = extractLivePanel(await h.getText('/arena/battles/'));
      expect(panelHtml).toContain('Testing a submission for');
      expect(panelHtml).toContain('<strong>0 ERROR</strong>');
      expect(panelHtml).toContain('ladder battles will resume shortly.');
      expect(panelHtml).not.toContain('No battle currently running — Arena is idle.');

      const liveJson = await h.getJson<{smokeTesting?: arena.LiveSmokeTest}>('/api/live.json');
      expect(liveJson.smokeTesting).toEqual({slug: '0-error', name: '0 ERROR'});
    });
  });

  test('clears smoke-testing status on plain idle heartbeat', async () => {
    await withHarness(undefined, async h => {
      await postArena(h, '/api/arena/heartbeat', {
        idle: true,
        smokeTesting: {slug: '0-error', name: '0 ERROR'},
      });
      const idleRes = await postArena(h, '/api/arena/heartbeat', {idle: true});
      expect(idleRes.status).toBe(200);
      expect(h.arenaHandle.getState().smokeTesting).toBeUndefined();
      expect(extractLivePanel(await h.getText('/arena/battles/'))).toContain(
        'No battle currently running — Arena is idle.'
      );
      expect((await h.getJson<{smokeTesting?: arena.LiveSmokeTest}>('/api/live.json')).smokeTesting)
        .toBeUndefined();
    });
  });

  test('renders smoke-testing agent from diagnostic-live without exposing version', async () => {
    await withHarness(undefined, async h => {
      const diagRes = await postArena(h, '/api/arena/diagnostic-live', sampleDiagnosticPayload);
      expect(diagRes.status).toBe(200);

      const diagHtml = await h.getText('/arena/battles/');
      const diagPanel = extractLivePanel(diagHtml);
      expect(diagPanel).toContain('Testing a submission for');
      expect(diagPanel).toContain('<strong>Secret Agent</strong>');
      expect(diagHtml).not.toContain('9.9.9-private');
    });
  });

  test('suppresses smoke-testing status when arena heartbeat is stale', async () => {
    await withHarness(
      {
        updatedAt: 1_760_000_050,
        stale: true,
        smokeTesting: {slug: '0-error', name: '0 ERROR'},
        recentMatches: [],
      },
      async h => {
        const panelHtml = extractLivePanel(await h.getText('/arena/battles/'));
        expect(panelHtml).toContain('No active heartbeat — Arena is offline or idle.');
        expect(panelHtml).not.toContain('Testing a submission');
        const liveJson = await h.getJson<{smokeTesting?: arena.LiveSmokeTest}>('/api/live.json');
        expect(liveJson.smokeTesting).toBeUndefined();
      }
    );
  });
});
