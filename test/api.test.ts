import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import polka from 'polka';
import serveStatic from 'serve-static';

import {ALL_SLOTS, Database} from '../db';
import {HEADERS_TIMEOUT_MILLIS, KEEP_ALIVE_TIMEOUT_MILLIS, createServerApp} from '../server';
import {encryptSecret} from '../server/account';
import * as arena from '../server/arena';
import * as auth from '../server/auth';
import * as sim from '../server/sim';
import {root} from '../static/util';
import {generateValidHarvestedTeams} from '../tools/mock';
import {parseArgs, runPkmnCli} from '../tools/pkmn';

import {RBY_TEAM_ONE, RBY_TEAM_TWO, seedSampleTeams} from './arena-helpers';

const ARENA_SECRET = 'test-arena-bearer-secret';
const AUTH_CFG: auth.Config = {
  sessionSecret: 'test-arena-session-secret',
};

const PROJECTS_YAML = `
- name: 0 ERROR
  active: 2026
  arena:
    owners:
      pre: pre.10544
- name: Foul Play
  active: 2026
  arena:
    owners:
      pmariglia: pmariglia.535629
- name: Metamon
  active: 2026
  arena:
    owners:
      jake: jake.77777
`;

function syncQualifiedProjects(
  database: Database,
  avatarsDir?: string,
  now?: number,
  extraYaml = ''
) {
  database.syncProjectsFromYaml(
    extraYaml ? `${PROJECTS_YAML}\n${extraYaml}` : PROJECTS_YAML,
    avatarsDir,
    now
  );
  for (const agent of database.getAllActiveAgents()) {
    database.setAgentLadders(agent.slug, ALL_SLOTS, now);
  }
}

const LADDERS_YAML = `
- name: RBY
  format: gen1ou
  version: '0.11.0'
  id: gen1ou20261109
  team: harvested
  status: active
- name: VGC
  format: gen9championsvgc2026regmc
  version: '0.11.0'
  id: gen9championsvgc2026regmc
  discord: '1564121375558340768'
  team: pools
  status: active
  min: 4
  teams: 20
`;

const SHA = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
const RBY_HARVESTED_TEAMS = generateValidHarvestedTeams('gen1ou', 4);

async function startTestServer(app: polka.Polka): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer((req, res) => {
    void (app.handler as http.RequestListener)(req, res);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as {port: number};
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()));
      });
    },
  };
}

async function apiJson(
  baseUrl: string,
  method: 'GET' | 'POST',
  route: string,
  secret?: string,
  body?: unknown
): Promise<{status: number; data: Record<string, unknown>}> {
  const headers: Record<string, string> = {};
  if (secret !== undefined) headers.Authorization = `Bearer ${secret}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json()) as Record<string, unknown>;
  return {status: res.status, data};
}

function parseSseChunks(raw: string): Array<{event: string; data: unknown}> {
  const out: Array<{event: string; data: unknown}> = [];
  for (const block of raw.split('\n\n')) {
    const lines = block.split('\n');
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length > 0) {
      out.push({event, data: JSON.parse(dataLines.join('\n')) as unknown});
    }
  }
  return out;
}

async function openPersistentSse(baseUrl: string, route: string) {
  const abort = new AbortController();
  const res = await fetch(`${baseUrl}${route}`, {signal: abort.signal});
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const received: Array<{event: string; data: Record<string, unknown>}> = [];
  const pump = (async () => {
    try {
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, {stream: true});
        let sep = buffer.indexOf('\n\n');
        while (sep >= 0) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          for (const item of parseSseChunks(`${block}\n\n`)) {
            received.push({event: item.event, data: item.data as Record<string, unknown>});
          }
          sep = buffer.indexOf('\n\n');
        }
      }
    } catch {}
  })();
  const waitForEvent = async (eventName: string, minCount = 1) => {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const matches = received.filter(e => e.event === eventName);
      if (matches.length >= minCount) return matches[minCount - 1];
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for SSE event "${eventName}"`);
  };
  return {
    received,
    waitForEvent,
    close: async () => {
      abort.abort();
      await pump;
    },
  };
}

describe('Arena Control API submissions', () => {
  let tmpDir: string;
  let samplesDir: string;
  let db: Database;
  let ctrl: ReturnType<typeof arena.register>;
  let srv: {baseUrl: string; close: () => Promise<void>};
  let events: string[];

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-arena-sub-'));
    samplesDir = path.join(tmpDir, 'samples');
    db = new Database(':memory:');
    db.syncLaddersFromYaml(LADDERS_YAML, 1_700_000_000);
    syncQualifiedProjects(db, tmpDir, 1_700_000_000);
    events = [];
    const app = polka();
    ctrl = arena.register(app, {
      db,
      auth: new auth.Auth({db, config: AUTH_CFG}),
      arenaSecret: ARENA_SECRET,
      publicDir: tmpDir,
      samplesDir,
      onUpdate: reason => {
        events.push(reason);
      },
    });
    srv = await startTestServer(app);
  });

  afterEach(async () => {
    ctrl.close();
    await srv.close();
    db.close();
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  afterAll(async () => {
    await sim.closeAllWorkers();
  });

  test('rejects missing or invalid Bearer tokens on /api/arena/* with 401', async () => {
    const unauth = await apiJson(srv.baseUrl, 'GET', '/api/arena/pending-submissions');
    expect(unauth.status).toBe(401);

    const wrong = await apiJson(
      srv.baseUrl,
      'GET',
      '/api/arena/pending-submissions',
      'wrong-secret'
    );
    expect(wrong.status).toBe(401);
  });

  test('returns decrypted pull tokens plus 1-indexed team slots on pending-submissions',
    async () => {
      const zeroAgent = db.getAgentBySlug('0-error')!;
      const dev = db.getDeveloperByGitHub('pre')!;
      const vgcTeams = Array.from({length: 20}, (_, idx) => `packed-team-${idx + 1}`);
      const sub1 = db.createSubmission({
        agentId: zeroAgent.id,
        developerId: dev.id,
        version: '1.0.0',
        package: 'bundle',
        url: 'https://github.com/pkmn/0-error-1.0.0.tar.zst',
        sha256: SHA,
        authTokenEncoding: encryptSecret('ghp_private_pull_token', AUTH_CFG.sessionSecret),
        ladderIds: ['gen1ou20261109', 'gen9championsvgc2026regmc'],
        teamsByLadder: {gen9championsvgc2026regmc: vgcTeams},
        now: 1_700_000_100,
      });

      const pendingRes = await apiJson(
        srv.baseUrl,
        'GET',
        '/api/arena/pending-submissions',
        ARENA_SECRET
      );
      expect(pendingRes.status).toBe(200);
      const submissions = pendingRes.data.submissions as Array<Record<string, unknown>>;
      expect(submissions).toHaveLength(1);
      expect(submissions[0].versionId).toBe(sub1.id);
      expect(submissions[0].authToken).toBe('ghp_private_pull_token');
      expect(
        (submissions[0].teamsByLadder as Record<string, string[]>).gen9championsvgc2026regmc
      ).toHaveLength(20);

      const slots = db.db.prepare(
        `SELECT MIN(team_index) AS minSlot, MAX(team_index) AS maxSlot
         FROM agent_ladder_teams WHERE agent_id = ?`
      ).get(zeroAgent.id) as {minSlot: number; maxSlot: number};
      expect(slots).toEqual({minSlot: 1, maxSlot: 20});
    });

  test('samples smokeTeams on pending-submissions only for referenced harvested targets',
    async () => {
      seedSampleTeams(samplesDir, 'gen1ou', [RBY_TEAM_ONE, RBY_TEAM_TWO]);
      db.replaceLadderTeams('gen1ou20261109', ['harvested-team-a', 'harvested-team-b']);
      db.upsertTournament({
        id: '98',
        name: 'Tournament #98: RBY Harvested',
        format: 'gen1ou',
        version: '0.11.0',
        team: 'harvested',
        gamesPerMatchup: 4,
        parallelTables: 1,
        hardware: 'GCP L4',
        status: 'scheduled',
        startsAt: 1_900_000_000,
      });

      // Idle poll: no pending submissions -> omit smokeTeams and harvested tournament teamPool.
      const idleRes = await apiJson(
        srv.baseUrl,
        'GET',
        '/api/arena/pending-submissions',
        ARENA_SECRET
      );
      expect(idleRes.status).toBe(200);
      const idleLadders = idleRes.data.ladders as Array<{id: string; smokeTeams?: string[]}>;
      const idleTours = idleRes.data.tournaments as Array<{
        id: string;
        teamPool?: string[];
        smokeTeams?: string[];
      }>;
      expect(idleLadders.find(l => l.id === 'gen1ou20261109')?.smokeTeams).toBeUndefined();
      expect(idleTours.find(t => t.id === '98')?.teamPool).toBeUndefined();
      expect(idleTours.find(t => t.id === '98')?.smokeTeams).toBeUndefined();

      // Pending harvested tournament submission: supply sample smokeTeams without teamPool.
      const zeroAgent = db.getAgentBySlug('0-error')!;
      db.createSubmission({
        agentId: zeroAgent.id,
        version: '1.0.0-t98',
        package: 'oci',
        url: 'ghcr.io/pkmn/0-error:1.0.0-t98',
        sha256: SHA,
        ladderIds: [],
        tournamentIds: ['98'],
        now: 1_700_000_200,
      });
      const tourRes = await apiJson(
        srv.baseUrl,
        'GET',
        '/api/arena/pending-submissions?target=tournament',
        ARENA_SECRET
      );
      expect(tourRes.status).toBe(200);
      const tourLadders = tourRes.data.ladders as Array<{id: string; smokeTeams?: string[]}>;
      const tourTours = tourRes.data.tournaments as Array<{
        id: string;
        teamPool?: string[];
        smokeTeams?: string[];
      }>;
      expect(tourLadders.find(l => l.id === 'gen1ou20261109')?.smokeTeams).toBeUndefined();
      const harvestedTour = tourTours.find(t => t.id === '98');
      expect(harvestedTour?.teamPool).toBeUndefined();
      expect(harvestedTour?.smokeTeams).toHaveLength(2);
      expect(harvestedTour?.smokeTeams?.[0]).not.toBe(harvestedTour?.smokeTeams?.[1]);
      expect(harvestedTour?.smokeTeams).not.toContain('harvested-team-a');
    });

  test('wipes auth tokens plus pending pool teams when smoke test fails', async () => {
    const fpAgent = db.getAgentBySlug('foul-play')!;
    const vgcTeams = Array.from({length: 20}, (_, idx) => `packed-team-${idx + 1}`);
    const fpSubFail = db.createSubmission({
      agentId: fpAgent.id,
      version: '0.9.0',
      package: 'oci',
      url: 'ghcr.io/pmariglia/foul-play:0.9.0',
      sha256: SHA,
      authTokenEncoding: encryptSecret('ghcr_secret', AUTH_CFG.sessionSecret),
      ladderIds: ['gen9championsvgc2026regmc'],
      teamsByLadder: {gen9championsvgc2026regmc: vgcTeams},
      now: 1_700_000_110,
    });

    const failStatus = await apiJson(
      srv.baseUrl,
      'POST',
      '/api/arena/submission-status',
      ARENA_SECRET,
      {
        versionId: fpSubFail.id,
        smokeStatus: 'failed',
        smokeError: 'Exited with code 1 during Turn 1',
      }
    );
    expect(failStatus.status).toBe(200);
    expect(db.getVersionById(fpSubFail.id)!.authTokenEncoding).toBeUndefined();
    expect(db.getTeamsForAgentLadder('gen9championsvgc2026regmc', fpAgent.id)).toHaveLength(0);
    expect(db.computeAgentSubmissionStatus(fpAgent.id, 1_700_000_120).canSubmit).toBe(true);
  });

  test('activates pool teams plus champion entries when smoke test passes', async () => {
    const zeroAgent = db.getAgentBySlug('0-error')!;
    const vgcTeams = Array.from({length: 20}, (_, idx) => `packed-team-${idx + 1}`);
    const sub1 = db.createSubmission({
      agentId: zeroAgent.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://github.com/pkmn/0-error-1.0.0.tar.zst',
      sha256: SHA,
      authTokenEncoding: encryptSecret('ghp_private_pull_token', AUTH_CFG.sessionSecret),
      ladderIds: ['gen1ou20261109', 'gen9championsvgc2026regmc'],
      teamsByLadder: {gen9championsvgc2026regmc: vgcTeams},
      now: 1_700_000_100,
    });

    const pass1 = await apiJson(
      srv.baseUrl,
      'POST',
      '/api/arena/submission-status',
      ARENA_SECRET,
      {
        versionId: sub1.id,
        smokeStatus: 'passed',
        unpackedBytes: 210_000_000,
        smokeDurationMillis: 2100,
        smokeTurnMillis: 350,
        smokePeakRam: 980,
      }
    );
    expect(pass1.status).toBe(200);
    expect(db.getVersionById(sub1.id)!.authTokenEncoding).toBeUndefined();
    expect(db.hasActiveLadderTeams('gen9championsvgc2026regmc', zeroAgent.id)).toBe(true);
    expect(db.getActiveEntriesForAgent(zeroAgent.id).map(e => e.role)).toEqual([
      'champion',
      'champion',
    ]);
    expect(events).toContain('submission-status');
  });

  test('retires the weaker active version automatically when a 3rd version passes', async () => {
    const zeroAgent = db.getAgentBySlug('0-error')!;
    const sub1 = db.createSubmission({
      agentId: zeroAgent.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://github.com/pkmn/0-error-1.0.0.tar.zst',
      sha256: SHA,
      ladderIds: ['gen1ou20261109'],
      now: 1_700_000_100,
    });
    await apiJson(srv.baseUrl, 'POST', '/api/arena/submission-status', ARENA_SECRET, {
      versionId: sub1.id,
      smokeStatus: 'passed',
    });
    db.db.prepare('UPDATE agent_versions SET activated_at = 1700000100 WHERE id = ?').run(sub1.id);
    db.db.prepare(
      `UPDATE ladder_entries
       SET elo = 1520, se = 20, lcb = 1480.8, matches = 30, settled_at = 1700500000
       WHERE version_id = ?`
    ).run(sub1.id);

    const sub2 = db.createSubmission({
      agentId: zeroAgent.id,
      version: '1.1.0',
      package: 'bundle',
      url: 'https://github.com/pkmn/0-error-1.1.0.tar.zst',
      sha256: SHA,
      ladderIds: ['gen1ou20261109'],
      now: 1_702_000_000,
    });
    await apiJson(srv.baseUrl, 'POST', '/api/arena/submission-status', ARENA_SECRET, {
      versionId: sub2.id,
      smokeStatus: 'passed',
    });
    db.db.prepare('UPDATE agent_versions SET activated_at = 1702000000 WHERE id = ?').run(sub2.id);
    db.db.prepare(
      `UPDATE ladder_entries
       SET elo = 1650, se = 18, lcb = 1614.7, matches = 32, settled_at = 1702500000
       WHERE version_id = ?`
    ).run(sub2.id);

    const sub3 = db.createSubmission({
      agentId: zeroAgent.id,
      version: '1.2.0',
      package: 'bundle',
      url: 'https://github.com/pkmn/0-error-1.2.0.tar.zst',
      sha256: SHA,
      ladderIds: ['gen1ou20261109'],
      now: 1_704_000_000,
    });
    const pass3 = await apiJson(
      srv.baseUrl,
      'POST',
      '/api/arena/submission-status',
      ARENA_SECRET,
      {versionId: sub3.id, smokeStatus: 'passed'}
    );
    expect(pass3.status).toBe(200);
    expect(pass3.data.retiredByLadder).toEqual({gen1ou20261109: sub1.id});

    const rbyActive = db.getActiveEntriesForAgent(zeroAgent.id)
      .filter(e => e.ladderId === 'gen1ou20261109');
    expect(rbyActive.map(e => `${e.version}:${e.role}`)).toEqual([
      '1.1.0:champion',
      '1.2.0:challenger',
    ]);
  });
});

describe('Arena live heartbeats & match completion', () => {
  let tmpDir: string;
  let db: Database;
  let ctrl: ReturnType<typeof arena.register>;
  let srv: {baseUrl: string; close: () => Promise<void>};
  let fakeNow: number;
  let watchdogAlerts: arena.WatchdogAlert[];
  let vZeroId: number;
  let vFpId: number;

  const baseHeartbeat = {
    heartbeatSeq: 1,
    matchId: 'gen1ou-0000000001',
    ladderId: 'gen1ou20261109',
    format: 'gen1ou',
    game: 1,
    turn: 5,
    activeSlot: 'p1',
    turnBudgetSeconds: 150,
    incrementSeconds: 10,
    p1: {
      slug: '0-error',
      name: '0 ERROR',
      version: '1.0.0',
      bankSeconds: 148,
      lastTurnMillis: 310,
      meanTurnMillis: 300,
      ram: 900,
    },
    p2: {
      slug: 'foul-play',
      name: 'Foul Play',
      version: '1.0.0',
      bankSeconds: 150,
      lastTurnMillis: 420,
      meanTurnMillis: 410,
      ram: 1100,
    },
  };

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-arena-live-'));
    db = new Database(':memory:');
    db.syncLaddersFromYaml(LADDERS_YAML, 1_760_000_000);
    syncQualifiedProjects(db, tmpDir, 1_760_000_000);

    const zeroAgent = db.getAgentBySlug('0-error')!;
    const fpAgent = db.getAgentBySlug('foul-play')!;
    const vZero = db.createSubmission({
      agentId: zeroAgent.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://github.com/pkmn/0-error-1.0.0.tar.zst',
      sha256: SHA,
      ladderIds: ['gen1ou20261109'],
      now: 1_760_000_010,
    });
    const vFp = db.createSubmission({
      agentId: fpAgent.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://github.com/pkmn/fp-1.0.0.tar.zst',
      sha256: SHA,
      ladderIds: ['gen1ou20261109'],
      now: 1_760_000_020,
    });
    db.applySubmissionStatus({versionId: vZero.id, smokeStatus: 'passed', now: 1_760_000_030});
    db.applySubmissionStatus({versionId: vFp.id, smokeStatus: 'passed', now: 1_760_000_030});
    db.setLadderAnchor('gen1ou20261109', 'foul-play', '1.0.0', 1_760_000_035);
    vZeroId = vZero.id;
    vFpId = vFp.id;

    fakeNow = 1_760_001_000;
    watchdogAlerts = [];
    const app = polka();
    ctrl = arena.register(app, {
      db,
      arenaSecret: ARENA_SECRET,
      sessionSecret: AUTH_CFG.sessionSecret,
      publicDir: tmpDir,
      watchdogTimeoutMillis: 120,
      now: () => fakeNow,
      onWatchdogTimeout: alert => {
        watchdogAlerts.push(alert);
      },
    });
    srv = await startTestServer(app);
  });

  afterEach(async () => {
    ctrl.close();
    await srv.close();
    db.close();
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  const fetchLive = async () => {
    const res = await fetch(`${srv.baseUrl}/api/live.json`);
    expect(res.status).toBe(200);
    return {etag: res.headers.get('etag'), doc: await res.json() as arena.LiveDocument};
  };

  test('serves /api/live.json with ETag 304 caching on heartbeat', async () => {
    const hb1 = await apiJson(
      srv.baseUrl,
      'POST',
      '/api/arena/heartbeat',
      ARENA_SECRET,
      baseHeartbeat
    );
    expect(hb1.status).toBe(200);
    const {doc, etag} = await fetchLive();
    expect(doc.stale).toBe(false);
    expect(doc.live?.slot).toBe('rby');
    expect(etag).toBeTruthy();

    const notMod = await fetch(`${srv.baseUrl}/api/live.json`, {
      headers: {'If-None-Match': etag!},
    });
    expect(notMod.status).toBe(304);
  });

  test('preserves turnStartedAt within the same turn while advancing on turn change', async () => {
    await apiJson(srv.baseUrl, 'POST', '/api/arena/heartbeat', ARENA_SECRET, baseHeartbeat);
    fakeNow = 1_760_001_004;
    await apiJson(srv.baseUrl, 'POST', '/api/arena/heartbeat', ARENA_SECRET, {
      ...baseHeartbeat,
      heartbeatSeq: 2,
    });
    expect((await fetchLive()).doc.live?.turnStartedAt).toBe(1_760_001_000);

    fakeNow = 1_760_001_009;
    await apiJson(srv.baseUrl, 'POST', '/api/arena/heartbeat', ARENA_SECRET, {
      ...baseHeartbeat,
      heartbeatSeq: 3,
      turn: 6,
      activeSlot: 'p2',
    });
    expect((await fetchLive()).doc.live?.turnStartedAt).toBe(1_760_001_009);
  });

  test('preserves optional pool team short hashes on live heartbeat slots', async () => {
    const hbOk = await apiJson(
      srv.baseUrl,
      'POST',
      '/api/arena/heartbeat',
      ARENA_SECRET,
      {
        ...baseHeartbeat,
        p1: {...baseHeartbeat.p1, team: 'b7b8bb1cbc73'},
        p2: {...baseHeartbeat.p2, team: 'P1:16d479804e3d'},
      }
    );
    expect(hbOk.status).toBe(200);
    const {doc} = await fetchLive();
    expect(doc.live?.p1.team).toBe('b7b8bb1cbc73');
    expect(doc.live?.p2.team).toBe('P1:16d479804e3d');
  });

  test('extracts p1Lines or p2Lines via extractChannelMessages on random ladder heartbeats',
    async () => {
      db.syncLaddersFromYaml(
        `${LADDERS_YAML}\n- name: RAND\n  format: gen9randombattle\n  version: '0.11.0'\n` +
        '  id: gen9randombattle20261109\n  team: random\n  status: active\n',
        1_760_000_000
      );
      const hbRand = await apiJson(
        srv.baseUrl,
        'POST',
        '/api/arena/heartbeat',
        ARENA_SECRET,
        {
          ...baseHeartbeat,
          matchId: 'gen9randombattle-0000001',
          ladderId: 'gen9randombattle20261109',
          format: 'gen9randombattle',
          viewer: {
            lines: [
              '|player|p1|0 ERROR|1',
              '|player|p2|Foul Play|2',
              '|split|p1',
              '|switch|p1a: Pikachu|Pikachu, L80|210/210',
              '|switch|p1a: Pikachu|Pikachu, L80|100/100',
              '|split|p2',
              '|switch|p2a: Charizard|Charizard, L80|250/250',
              '|switch|p2a: Charizard|Charizard, L80|100/100',
              '|turn|1',
            ],
            p1: {pokemon: [{ident: 'p1: Pikachu', details: 'Pikachu, L80', condition: '210/210'}]},
            p2: {
              pokemon: [{ident: 'p2: Charizard', details: 'Charizard, L80', condition: '250/250'}],
            },
          },
        }
      );
      expect(hbRand.status).toBe(200);
      const {doc} = await fetchLive();
      expect(doc.live?.slot).toBe('rand');
      expect(doc.live?.viewer?.p1.lines).toContain('|switch|p1a: Pikachu|Pikachu, L80|210/210');
      expect(doc.live?.viewer?.p1.lines).toContain('|switch|p2a: Charizard|Charizard, L80|100/100');
      expect(doc.live?.viewer?.p2.lines).toContain('|switch|p1a: Pikachu|Pikachu, L80|100/100');
      expect(doc.live?.viewer?.p2.lines).toContain('|switch|p2a: Charizard|Charizard, L80|250/250');
      expect(doc.live?.viewer?.p1.pokemon).toHaveLength(1);
      expect(doc.live?.viewer?.p2.pokemon).toHaveLength(1);
    });

  test('fires disconnect watchdog alert once heartbeat exceeds timeout', async () => {
    await apiJson(srv.baseUrl, 'POST', '/api/arena/heartbeat', ARENA_SECRET, baseHeartbeat);
    await new Promise(resolve => setTimeout(resolve, 180));
    expect(watchdogAlerts).toHaveLength(1);
    expect(watchdogAlerts[0].lastMatchId).toBe('gen1ou-0000000001');
    expect((await fetchLive()).doc.stale).toBe(true);
  });

  test('settles ratings, Top-1 reign time, streaks, or snapshots across 45 matches', async () => {
    for (let mIdx = 1; mIdx <= 45; mIdx++) {
      fakeNow = 1_760_001_000 + mIdx * 300;
      const isLoss = mIdx === 14 || mIdx === 28;
      const isSplit = !isLoss && mIdx % 5 === 0;
      const mc = await apiJson(
        srv.baseUrl,
        'POST',
        '/api/arena/match-complete',
        ARENA_SECRET,
        {
          match: {
            id: `gen1ou-${String(mIdx).padStart(10, '0')}`,
            ladderId: 'gen1ou20261109',
            p1VersionId: vZeroId,
            p2VersionId: vFpId,
            seed: `sodium,${mIdx}`,
            game1Outcome: isLoss ? 'L' : 'W',
            game2Outcome: isLoss || isSplit ? 'L' : 'W',
            category: isLoss ? 'LL' : isSplit ? 'WL' : 'WW',
            game1Turns: 28,
            game2Turns: 31,
            game1EndReason: 'normal',
            game2EndReason: mIdx === 5 ? 'timeout' : 'normal',
            p1Game1PeakRam: 950,
            p1Game2PeakRam: 950,
            p2Game1PeakRam: 1120,
            p2Game2PeakRam: 1120,
            p1Game1BankSeconds: 145,
            p1Game2BankSeconds: 140,
            p2Game1BankSeconds: 138,
            p2Game2BankSeconds: 120,
            p1Game1MeanTurnMillis: 310,
            p1Game2MeanTurnMillis: 310,
            p2Game1MeanTurnMillis: 420,
            p2Game2MeanTurnMillis: 420,
            completedAt: fakeNow,
          },
        }
      );
      expect(mc.status).toBe(200);
      expect(mc.data.duplicate).toBe(false);
    }

    const entries = db.getLeaderboardEntries('gen1ou20261109');
    const zeroEntry = entries.find(e => e.versionId === vZeroId)!;
    const fpEntry = entries.find(e => e.versionId === vFpId)!;
    const zeroRaw = db.db.prepare(
      'SELECT * FROM ladder_entries WHERE ladder_id = ? AND version_id = ?'
    ).get('gen1ou20261109', vZeroId) as Record<string, unknown>;

    expect(zeroEntry.matches).toBe(45);
    expect(zeroEntry.ww).toBe(34);
    expect(zeroEntry.split).toBe(9);
    expect(zeroEntry.ll).toBe(2);
    expect(zeroRaw.timeouts).toBe(1);
    expect(fpEntry.elo).toBeCloseTo(1500, 4);
    expect(zeroEntry.elo).toBeGreaterThan(1650);
    expect(zeroEntry.settledAt).toBeDefined();
    expect(zeroEntry.rankCurrent).toBe(1);
    expect(zeroRaw.top1_total_seconds as number).toBeGreaterThan(0);

    const zeroAgent = db.getAgentBySlug('0-error')!;
    const famZero = db.db.prepare(
      'SELECT * FROM agent_ladder_stats WHERE ladder_id = ? AND agent_id = ?'
    ).get('gen1ou20261109', zeroAgent.id) as Record<string, unknown>;
    expect(famZero.best_rank).toBe(1);
    expect(famZero.max_win_streak).toBe(4);

    const snapshots = db.db.prepare(
      'SELECT COUNT(*) AS cnt FROM rating_snapshots WHERE ladder_id = ?'
    ).get('gen1ou20261109') as {cnt: number};
    expect(snapshots.cnt).toBe(2);

    const {doc} = await fetchLive();
    expect(doc.live).toBeUndefined();
    expect(doc.recentMatches).toHaveLength(25);
    expect(doc.totalMatches).toBe(45);
    expect(doc.pageSize).toBe(25);
  });

  test('ignores duplicate match-complete deliveries idempotently', async () => {
    const payload = {
      match: {
        id: 'gen1ou-0000000001',
        ladderId: 'gen1ou20261109',
        p1VersionId: vZeroId,
        p2VersionId: vFpId,
        seed: 'sodium,1',
        game1Outcome: 'W',
        game2Outcome: 'L',
        category: 'WL',
        game1Turns: 28,
        game2Turns: 31,
        game1EndReason: 'normal',
        game2EndReason: 'normal',
        p1Game1PeakRam: 950,
        p1Game2PeakRam: 950,
        p2Game1PeakRam: 1120,
        p2Game2PeakRam: 1120,
        p1Game1BankSeconds: 145,
        p1Game2BankSeconds: 140,
        p2Game1BankSeconds: 138,
        p2Game2BankSeconds: 120,
        p1Game1MeanTurnMillis: 310,
        p1Game2MeanTurnMillis: 310,
        p2Game1MeanTurnMillis: 420,
        p2Game2MeanTurnMillis: 420,
        completedAt: fakeNow,
      },
    };
    const first = await apiJson(
      srv.baseUrl,
      'POST',
      '/api/arena/match-complete',
      ARENA_SECRET,
      payload
    );
    expect(first.data.duplicate).toBe(false);

    const second = await apiJson(
      srv.baseUrl,
      'POST',
      '/api/arena/match-complete',
      ARENA_SECRET,
      payload
    );
    expect(second.status).toBe(200);
    expect(second.data.duplicate).toBe(true);
  });
});

describe('Arena SSE streams', () => {
  let tmpDir: string;
  let db: Database;
  let ctrl: ReturnType<typeof arena.register>;
  let srv: {baseUrl: string; close: () => Promise<void>};
  let client: arena.Client;
  let vZeroId: number;
  let vFpId: number;
  let vMetaId: number;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-arena-sse-'));
    db = new Database(':memory:');
    db.syncLaddersFromYaml(LADDERS_YAML, 1_760_000_000);
    syncQualifiedProjects(db, tmpDir, 1_760_000_000);

    const zeroAgent = db.getAgentBySlug('0-error')!;
    const fpAgent = db.getAgentBySlug('foul-play')!;
    const metaAgent = db.getAgentBySlug('metamon')!;

    vZeroId = db.createSubmission({
      agentId: zeroAgent.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://github.com/pkmn/0-error.tar.zst',
      sha256: SHA,
      ladderIds: ['gen1ou20261109'],
      now: 1_760_000_010,
    }).id;
    vFpId = db.createSubmission({
      agentId: fpAgent.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://github.com/pkmn/fp.tar.zst',
      sha256: SHA,
      ladderIds: ['gen1ou20261109'],
      now: 1_760_000_015,
    }).id;
    vMetaId = db.createSubmission({
      agentId: metaAgent.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://github.com/pkmn/meta.tar.zst',
      sha256: SHA,
      ladderIds: ['gen1ou20261109'],
      now: 1_760_000_020,
    }).id;
    db.applySubmissionStatus({versionId: vZeroId, smokeStatus: 'passed', now: 1_760_000_030});
    db.applySubmissionStatus({versionId: vFpId, smokeStatus: 'passed', now: 1_760_000_030});
    db.applySubmissionStatus({versionId: vMetaId, smokeStatus: 'passed', now: 1_760_000_030});

    db.upsertTournament({
      id: '2',
      name: 'Tournament #2: Gen 1 OU',
      format: 'gen1ou',
      version: '0.11.0',
      gamesPerMatchup: 10,
      parallelTables: 2,
      hardware: 'GCP L4 Spot',
      status: 'running',
      startsAt: 1_760_000_100,
    });
    db.upsertTournamentEntrant({
      tournamentId: '2',
      agentId: zeroAgent.id,
      versionId: vZeroId,
      seed: 1,
    });
    db.upsertTournamentEntrant({
      tournamentId: '2',
      agentId: fpAgent.id,
      versionId: vFpId,
      seed: 2,
    });
    db.upsertTournamentEntrant({
      tournamentId: '2',
      agentId: metaAgent.id,
      versionId: vMetaId,
      seed: 3,
    });

    const app = polka();
    ctrl = arena.register(app, {
      db,
      arenaSecret: ARENA_SECRET,
      sessionSecret: AUTH_CFG.sessionSecret,
      publicDir: tmpDir,
      now: () => 1_760_000_500,
    });
    srv = await startTestServer(app);
    client = new arena.Client({serverUrl: srv.baseUrl, arenaSecret: ARENA_SECRET});
  });

  afterEach(async () => {
    ctrl.close();
    await srv.close();
    db.close();
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  test('emits single snapshot event on /api/battles/stream?once=1', async () => {
    const onceBattles = await fetch(`${srv.baseUrl}/api/battles/stream?once=1`);
    expect(onceBattles.status).toBe(200);
    const onceEvents = parseSseChunks(await onceBattles.text());
    expect(onceEvents).toHaveLength(1);
    expect(onceEvents[0].event).toBe('snapshot');
  });

  test('streams live heartbeats then match completions over /api/battles/stream', async () => {
    const battleStream = await openPersistentSse(srv.baseUrl, '/api/battles/stream');
    try {
      const snap = await battleStream.waitForEvent('snapshot');
      expect((snap.data.runningTournament as {id: string}).id).toBe('2');

      await client.sendHeartbeat({
        heartbeatSeq: 1,
        matchId: 'gen1ou-live-sse-1',
        ladderId: 'gen1ou20261109',
        format: 'gen1ou',
        game: 1,
        turn: 3,
        activeSlot: 'p1',
        turnStartedAt: 1_760_000_498,
        turnBudgetSeconds: 150,
        incrementSeconds: 10,
        p1: {
          slug: '0-error',
          name: '0 ERROR',
          version: '1.0.0',
          bankSeconds: 149,
          lastTurnMillis: 250,
          meanTurnMillis: 250,
          ram: 800,
        },
        p2: {
          slug: 'foul-play',
          name: 'Foul Play',
          version: '1.0.0',
          bankSeconds: 150,
          lastTurnMillis: 300,
          meanTurnMillis: 300,
          ram: 950,
        },
      });
      const liveEvt = await battleStream.waitForEvent('live');
      expect((liveEvt.data.live as {matchId: string}).matchId).toBe('gen1ou-live-sse-1');

      await client.completeMatch({
        match: {
          id: 'gen1ou-live-sse-1',
          ladderId: 'gen1ou20261109',
          p1VersionId: vZeroId,
          p2VersionId: vFpId,
          seed: '1,2,3,4',
          game1Outcome: 'W',
          game2Outcome: 'W',
          category: 'WW',
          game1Turns: 20,
          game2Turns: 24,
          game1EndReason: 'normal',
          game2EndReason: 'normal',
          p1Game1PeakRam: 820,
          p1Game2PeakRam: 820,
          p2Game1PeakRam: 960,
          p2Game2PeakRam: 960,
          p1Game1BankSeconds: 145,
          p1Game2BankSeconds: 142,
          p2Game1BankSeconds: 138,
          p2Game2BankSeconds: 130,
          p1Game1MeanTurnMillis: 260,
          p1Game2MeanTurnMillis: 260,
          p2Game1MeanTurnMillis: 310,
          p2Game2MeanTurnMillis: 310,
          completedAt: 1_760_000_500,
        },
      });
      const matchEvt = await battleStream.waitForEvent('match');
      expect((matchEvt.data.match as {id: string}).id).toBe('gen1ou-live-sse-1');
      expect(matchEvt.data.live).toBeUndefined();
    } finally {
      await battleStream.close();
    }
  });

  test('streams multi-table tournament broadcasts over /api/tournaments/:id/stream', async () => {
    expect((await fetch(`${srv.baseUrl}/api/tournaments/999/stream?once=1`)).status).toBe(404);

    const tourStream = await openPersistentSse(srv.baseUrl, '/api/tournaments/2/stream');
    try {
      await tourStream.waitForEvent('snapshot');
      await client.sendTournamentBroadcast('2', {
        table: 1,
        mode: 'load',
        gameId: 't2-rr-g1',
        stage: 'Round Robin',
        cycle: 1,
        matchupGame: 1,
        p1: {
          slug: '0-error',
          name: '0 ERROR',
          version: '1.0.0',
          bankSeconds: 150,
          thinking: true,
          incrementSeconds: 10,
        },
        p2: {
          slug: 'foul-play',
          name: 'Foul Play',
          version: '1.0.0',
          bankSeconds: 150,
          thinking: false,
          incrementSeconds: 10,
        },
        lines: ['|gametype|singles', '|player|p1|0 ERROR|1', '|player|p2|Foul Play|2', '|turn|1'],
      });
      const loadEvt = await tourStream.waitForEvent('table-load');
      expect((loadEvt.data.table as {gameId: string}).gameId).toBe('t2-rr-g1');

      await client.sendTournamentBroadcast('2', {
        table: 1,
        mode: 'append',
        p1: {
          slug: '0-error',
          name: '0 ERROR',
          version: '1.0.0',
          bankSeconds: 142,
          thinking: false,
          incrementSeconds: 10,
        },
        p2: {
          slug: 'foul-play',
          name: 'Foul Play',
          version: '1.0.0',
          bankSeconds: 148,
          thinking: true,
          incrementSeconds: 10,
        },
        lines: ['|move|p1a: Tauros|Body Slam|p2a: Chansey', '|turn|2'],
      });
      const appendEvt = await tourStream.waitForEvent('table-append');
      expect(appendEvt.data.lines as string[]).toContain('|turn|2');

      await client.sendTournamentBroadcast('2', {table: 2, idle: true, label: 'Table 2'});
      await tourStream.waitForEvent('table-idle');

      await client.sendTournamentBroadcast('2', {off: true});
      await tourStream.waitForEvent('broadcast-end');
    } finally {
      await tourStream.close();
    }
  });

  test('writes game .log files while streaming live tournament standings updates', async () => {
    const tourStream = await openPersistentSse(srv.baseUrl, '/api/tournaments/2/stream');
    try {
      await tourStream.waitForEvent('snapshot');
      const gc1 = await client.completeTournamentGame('2', {
        table: 1,
        logs: ['|gametype|singles\n|player|p1|0 ERROR|1\n|player|p2|Foul Play|2\n|win|0 ERROR\n'],
        game: {
          id: 't2-rr-g1',
          stage: 'Round Robin',
          cycle: 1,
          matchupGame: 1,
          outcome: 'W',
          p1: {versionId: vZeroId},
          p2: {versionId: vFpId},
          games: [
            {
              gameNumber: 1,
              seed: '1,2,3,4',
              outcome: 'W',
              turns: 22,
              endReason: 'normal',
              p1: {bankSeconds: 140},
              p2: {bankSeconds: 120},
            },
          ],
          completedAt: 1_760_000_520,
        },
      });
      expect(gc1.duplicate).toBe(false);
      expect(gc1.logHref).toBe('/arena/tournaments/2/t2-rr-g1.log');
      expect(fs.existsSync(path.join(tmpDir, 'arena', 'tournaments', '2', 't2-rr-g1.log')))
        .toBe(true);

      const gcEvt = await tourStream.waitForEvent('game-complete');
      expect(gcEvt.data.completedGames).toBe(1);
      const standingsAfter1 = gcEvt.data.standings as Array<{
        slug: string;
        points: number;
        elo: number;
      }>;
      expect(standingsAfter1[0].slug).toBe('0-error');
      expect(standingsAfter1[0].points).toBe(1);
      expect(standingsAfter1[0].elo).toBeGreaterThan(1500);

      const gcDup = await client.completeTournamentGame('2', {
        game: {
          id: 't2-rr-g1',
          stage: 'Round Robin',
          cycle: 1,
          matchupGame: 1,
          outcome: 'W',
          p1: {versionId: vZeroId},
          p2: {versionId: vFpId},
          games: [
            {
              gameNumber: 1,
              seed: '1,2,3,4',
              outcome: 'W',
              turns: 22,
              endReason: 'normal',
              p1: {bankSeconds: 140},
              p2: {bankSeconds: 120},
            },
          ],
          completedAt: 1_760_000_520,
        },
      });
      expect(gcDup.duplicate).toBe(true);

      await client.completeTournamentGame('2', {
        tournamentStatus: 'completed',
        game: {
          id: 't2-rr-g2',
          stage: 'Round Robin',
          cycle: 1,
          matchupGame: 2,
          outcome: 'W',
          p1: {versionId: vFpId},
          p2: {versionId: vMetaId},
          games: [
            {
              gameNumber: 1,
              seed: '5,6,7,8',
              outcome: 'W',
              turns: 30,
              endReason: 'normal',
              p1: {bankSeconds: 130},
              p2: {bankSeconds: 110},
            },
          ],
          completedAt: 1_760_000_600,
        },
      });
      expect(db.getTournament('2')?.status).toBe('completed');
      expect(db.getTournamentEntrants('2')[0].finalRank).toBe(1);
    } finally {
      await tourStream.close();
    }
  });

  test('writes per-game replay logs for Best-of-N tournament matches', async () => {
    db.upsertTournament({
      id: '2',
      name: 'Tournament #2: VGC 2026 Reg M-C OTS BO3',
      format: 'gen9championsvgc2026regmc',
      version: '0.11.0',
      rulesJson: JSON.stringify(['Open Team Sheets', 'Best of = 3']),
      gamesPerMatchup: 10,
      parallelTables: 2,
      hardware: 'GCP L4 Spot',
      status: 'running',
      startsAt: 1_760_000_100,
    });
    const tourStream = await openPersistentSse(srv.baseUrl, '/api/tournaments/2/stream');
    try {
      await tourStream.waitForEvent('snapshot');
      await client.sendTournamentBroadcast('2', {
        table: 1,
        mode: 'load',
        gameId: 't2-bo3-m1',
        stage: 'Round Robin',
        cycle: 1,
        matchupGame: 1,
        bestOf: 3,
        game: 2,
        summaries: [{winnerSlot: 'p1', turns: 8}],
        p1: {
          slug: '0-error',
          name: '0 ERROR',
          version: '1.0.0',
          bankSeconds: 150,
          thinking: true,
          incrementSeconds: 15,
        },
        p2: {
          slug: 'foul-play',
          name: 'Foul Play',
          version: '1.0.0',
          bankSeconds: 150,
          thinking: false,
          incrementSeconds: 15,
        },
        lines: ['|gametype|doubles', '|player|p1|0 ERROR|1', '|player|p2|Foul Play|2', '|turn|1'],
      });
      const loadEvt = await tourStream.waitForEvent('table-load');
      const loadedTable = loadEvt.data.table as {
        seriesLeftHtml?: string;
        seriesRightHtml?: string;
      };
      expect(loadedTable.seriesLeftHtml).toContain('0 ERROR');
      expect(loadedTable.seriesRightHtml).toContain('Match 1');
      expect(loadedTable.seriesRightHtml).toContain('Game 2 / 3');
      expect(loadedTable.seriesRightHtml).toContain('G1');
      expect(loadedTable.seriesRightHtml).toContain('0 ERROR (8t)');

      const gc = await client.completeTournamentGame('2', {
        table: 1,
        logs: [
          '|gametype|doubles\n|win|0 ERROR\n',
          '|gametype|doubles\n|win|Foul Play\n',
          '|gametype|doubles\n|win|0 ERROR\n',
        ],
        game: {
          id: 't2-bo3-m1',
          stage: 'Round Robin',
          cycle: 1,
          matchupGame: 1,
          outcome: 'W',
          p1: {versionId: vZeroId},
          p2: {versionId: vFpId},
          games: [
            {
              gameNumber: 1,
              seed: '1,2,3,4',
              outcome: 'W',
              turns: 8,
              endReason: 'normal',
              p1: {bankSeconds: 140},
              p2: {bankSeconds: 125},
            },
            {
              gameNumber: 2,
              seed: '5,6,7,8',
              outcome: 'L',
              turns: 9,
              endReason: 'normal',
              p1: {bankSeconds: 130},
              p2: {bankSeconds: 136},
            },
            {
              gameNumber: 3,
              seed: '9,10,11,12',
              outcome: 'W',
              turns: 8,
              endReason: 'normal',
              p1: {bankSeconds: 132},
              p2: {bankSeconds: 118},
            },
          ],
          completedAt: 1_760_000_540,
        },
      });
      expect(gc.duplicate).toBe(false);
      expect(gc.gameLogHrefs).toEqual([
        '/arena/tournaments/2/t2-bo3-m1-g1.log',
        '/arena/tournaments/2/t2-bo3-m1-g2.log',
        '/arena/tournaments/2/t2-bo3-m1-g3.log',
      ]);
      expect(fs.existsSync(path.join(tmpDir, 'arena', 'tournaments', '2', 't2-bo3-m1-g1.log')))
        .toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'arena', 'tournaments', '2', 't2-bo3-m1-g2.log')))
        .toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'arena', 'tournaments', '2', 't2-bo3-m1-g3.log')))
        .toBe(true);
    } finally {
      await tourStream.close();
    }
  });

  test('paginates tournament games over /api/tournaments/:id/games.json', async () => {
    for (let i = 1; i <= 30; i++) {
      db.upsertTournamentGame({
        id: `t2-pg-${String(i).padStart(2, '0')}`,
        tournamentId: '2',
        stage: 'Round Robin',
        cycle: i,
        matchupGame: i,
        status: 'completed',
        outcome: 'W',
        p1: {versionId: vZeroId},
        p2: {versionId: vFpId},
        games: [{gameNumber: 1, seed: `1,2,3,${i}`, outcome: 'W', turns: 15}],
        completedAt: 1_760_000_000 + i * 10,
      });
    }

    const p1Res = await fetch(`${srv.baseUrl}/api/tournaments/2/games.json?page=1&limit=25`);
    expect(p1Res.status).toBe(200);
    expect(p1Res.headers.get('cache-control')).toBe('no-cache');
    const etag = p1Res.headers.get('etag');
    expect(etag).toBeTruthy();
    const p1 = await p1Res.json() as {
      total: number;
      totalPages: number;
      page: number;
      hasPrev: boolean;
      hasNext: boolean;
      games: Array<{id: string}>;
    };
    expect(p1.total).toBe(30);
    expect(p1.totalPages).toBe(2);
    expect(p1.page).toBe(1);
    expect(p1.hasPrev).toBe(false);
    expect(p1.hasNext).toBe(true);
    expect(p1.games).toHaveLength(25);
    expect(p1.games[0].id).toBe('t2-pg-30');

    const cached = await fetch(`${srv.baseUrl}/api/tournaments/2/games.json?page=1&limit=25`, {
      headers: {'if-none-match': etag!},
    });
    expect(cached.status).toBe(304);

    const p2Res = await fetch(`${srv.baseUrl}/api/tournaments/2/games.json?page=2&limit=25`);
    const p2 = await p2Res.json() as {
      hasPrev: boolean;
      hasNext: boolean;
      games: Array<{id: string}>;
    };
    expect(p2.hasPrev).toBe(true);
    expect(p2.hasNext).toBe(false);
    expect(p2.games).toHaveLength(5);
    expect(p2.games[0].id).toBe('t2-pg-05');

    const offRes = await fetch(`${srv.baseUrl}/api/tournaments/2/games.json?offset=23&limit=4`);
    const off = await offRes.json() as {
      offset: number;
      hasPrev: boolean;
      hasNext: boolean;
      games: Array<{id: string}>;
    };
    expect(off.offset).toBe(23);
    expect(off.hasPrev).toBe(true);
    expect(off.hasNext).toBe(true);
    expect(off.games.map(g => g.id)).toEqual(['t2-pg-07', 't2-pg-06', 't2-pg-05', 't2-pg-04']);

    expect((await fetch(`${srv.baseUrl}/api/tournaments/999/games.json`)).status).toBe(404);
    expect((await fetch(`${srv.baseUrl}/api/tournaments/2/games.json?page=0`)).status).toBe(400);
    expect((await fetch(`${srv.baseUrl}/api/tournaments/2/games.json?limit=999`)).status).toBe(400);
    expect((await fetch(`${srv.baseUrl}/api/tournaments/2/games.json?offset=-1`)).status).toBe(400);
  });
});

describe('pkmn CLI commands', () => {
  let db: Database;
  let logs: string[];
  let vZeroId: number;
  let vFpId: number;
  const log = (line: string) => logs.push(line);

  beforeEach(() => {
    logs = [];
    db = new Database(':memory:');
    db.syncLaddersFromYaml(LADDERS_YAML, 1_760_000_000);
    syncQualifiedProjects(db, undefined, 1_760_000_000);

    const zeroAgent = db.getAgentBySlug('0-error')!;
    const fpAgent = db.getAgentBySlug('foul-play')!;
    vZeroId = db.createSubmission({
      agentId: zeroAgent.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://github.com/pkmn/0-error-1.0.0.tar.zst',
      sha256: SHA,
      ladderIds: ['gen1ou20261109'],
      now: 1_760_000_100,
    }).id;
    vFpId = db.createSubmission({
      agentId: fpAgent.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://github.com/pkmn/fp-1.0.0.tar.zst',
      sha256: SHA,
      ladderIds: ['gen1ou20261109'],
      now: 1_760_000_100,
    }).id;
    db.applySubmissionStatus({versionId: vZeroId, smokeStatus: 'passed', now: 1_760_000_110});
    db.applySubmissionStatus({versionId: vFpId, smokeStatus: 'passed', now: 1_760_000_110});
  });

  afterEach(() => {
    db.close();
  });

  test('refund-cooldown clears active 14-day submission cooldown', async () => {
    const zeroAgent = db.getAgentBySlug('0-error')!;
    db.db.prepare(
      'UPDATE ladder_entries SET se = 20, matches = 30, settled_at = 1760000150'
    ).run();
    expect(db.computeAgentSubmissionStatus(zeroAgent.id, 1_760_000_200).reason)
      .toContain('14-day cooldown');

    await runPkmnCli(['refund-cooldown', '0-error'], {db, now: 1_760_000_250, log});
    expect(db.computeAgentSubmissionStatus(zeroAgent.id, 1_760_000_260).canSubmit).toBe(true);
  });

  test('set-smoke-cadence persists custom per-cycle, interval, or pause settings', async () => {
    expect(db.getSmokeCadence()).toEqual({maxPerCycle: 1, everyCycles: 1});

    await runPkmnCli(['set-smoke-cadence', '1', '--every', '5'], {db, now: 1_760_000_250, log});
    expect(db.getSmokeCadence()).toEqual({maxPerCycle: 1, everyCycles: 5});
    expect(logs[logs.length - 1]).toContain('max 1 every 5 cycles');

    await runPkmnCli(['set-smoke-cadence', '3'], {db, now: 1_760_000_260, log});
    expect(db.getSmokeCadence()).toEqual({maxPerCycle: 3, everyCycles: 1});
    expect(logs[logs.length - 1]).toContain('max 3 per cycle');

    await runPkmnCli(['set-smoke-cadence', '0'], {db, now: 1_760_000_270, log});
    expect(db.getSmokeCadence()).toEqual({maxPerCycle: 0, everyCycles: 1});
    expect(logs[logs.length - 1]).toContain('Paused ladder smoke tests');
  });

  test('set-smoke-cadence rejects negative counts or non-positive intervals', async () => {
    await expect(runPkmnCli(['set-smoke-cadence', '-1'], {db, log})).rejects.toThrow(
      /Invalid <per-cycle>/
    );
    await expect(runPkmnCli(['set-smoke-cadence', '1', '--every', '0'], {db, log})).rejects.toThrow(
      /Invalid --every/
    );
  });

  test('quarantine or unquarantine toggles version active entries', async () => {
    const zeroAgent = db.getAgentBySlug('0-error')!;
    await runPkmnCli(
      ['quarantine', '0-error', '1.0.0', '--reason', 'OOM in match 12'],
      {db, now: 1_760_000_300, log}
    );
    expect(db.getVersionById(vZeroId)!.smokeStatus).toBe('quarantined');
    expect(db.getActiveEntriesForAgent(zeroAgent.id)).toHaveLength(0);

    await runPkmnCli(['unquarantine', '0-error', '1.0.0'], {db, now: 1_760_000_350, log});
    expect(db.getVersionById(vZeroId)!.smokeStatus).toBe('passed');
    expect(db.getActiveEntriesForAgent(zeroAgent.id)).toHaveLength(1);
  });

  test('set-anchor pins chosen entry to 1500 Elo', async () => {
    db.recordCompletedMatch({
      match: {
        id: 'gen1ou-0000000001',
        ladderId: 'gen1ou20261109',
        p1VersionId: vZeroId,
        p2VersionId: vFpId,
        seed: 'sodium,1',
        game1Outcome: 'W',
        game2Outcome: 'W',
        category: 'WW',
        game1Turns: 25,
        game2Turns: 27,
        game1EndReason: 'normal',
        game2EndReason: 'normal',
        p1Game1PeakRam: 800,
        p1Game2PeakRam: 800,
        p2Game1PeakRam: 900,
        p2Game2PeakRam: 900,
        p1Game1BankSeconds: 140,
        p1Game2BankSeconds: 140,
        p2Game1BankSeconds: 140,
        p2Game2BankSeconds: 140,
        p1Game1MeanTurnMillis: 200,
        p1Game2MeanTurnMillis: 200,
        p2Game1MeanTurnMillis: 200,
        p2Game2MeanTurnMillis: 200,
        completedAt: 1_760_000_400,
      },
    });
    await runPkmnCli(
      ['set-anchor', 'gen1ou20261109', 'foul-play', '1.0.0'],
      {db, now: 1_760_000_410, log}
    );
    const fpRow = db.db.prepare(
      'SELECT elo, is_anchor FROM ladder_entries WHERE version_id = ?'
    ).get(vFpId) as {elo: number; is_anchor: number};
    expect(fpRow.is_anchor).toBe(1);
    expect(fpRow.elo).toBeCloseTo(1500, 5);
  });

  test('rotate-ladder archives settled seasons immediately while staging successor', async () => {
    await runPkmnCli(
      [
        'rotate-ladder',
        'gen9championsvgc2026regmc',
        '--name',
        'VGC 2026 Reg M-C',
        '--new',
        'gen9championsvgc2026regmd',
      ],
      {db, now: 1_760_000_500, log}
    );
    const oldVgc = db.getLadder('gen9championsvgc2026regmc')!;
    const newVgc = db.getLadder('gen9championsvgc2026regmd')!;
    expect(oldVgc.status).toBe('archived');
    expect(oldVgc.name).toBe('VGC 2026 Reg M-C');
    expect(oldVgc.slot).toBe('vgc');
    expect(newVgc.status).toBe('upcoming');
    expect(newVgc.name).toBe('VGC');
    expect(newVgc.teams).toBe(20);
  });

  test('rotate-ladder transitions unsettled seasons to settling until final match', async () => {
    const metaAgent = db.getAgentBySlug('metamon')!;
    const vMeta = db.createSubmission({
      agentId: metaAgent.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://github.com/pkmn/meta-1.0.0.tar.zst',
      sha256: SHA,
      ladderIds: ['gen1ou20261109'],
      now: 1_760_000_510,
    });
    db.applySubmissionStatus({versionId: vMeta.id, smokeStatus: 'passed', now: 1_760_000_520});
    db.setLadderAnchor('gen1ou20261109', 'foul-play', '1.0.0', 1_760_000_525);

    await runPkmnCli(
      [
        'rotate-ladder',
        'gen1ou20261109',
        '--name',
        'RBY (Nov 2026)',
        '--new',
        'gen1ou20270101',
      ],
      {db, now: 1_760_000_530, log}
    );
    expect(db.getLadder('gen1ou20261109')!.status).toBe('settling');
    expect(db.getLadder('gen1ou20270101')!.status).toBe('upcoming');

    let archived = false;
    for (let i = 1; i <= 90 && !archived; i++) {
      const pairs: Array<[number, number]> = [
        [vMeta.id, vFpId],
        [vZeroId, vFpId],
        [vMeta.id, vZeroId],
      ];
      const [p1VersionId, p2VersionId] = pairs[(i - 1) % pairs.length];
      const win = i % 2 === 0;
      const res = db.recordCompletedMatch({
        match: {
          id: `gen1ou-settle-${String(i).padStart(4, '0')}`,
          ladderId: 'gen1ou20261109',
          p1VersionId,
          p2VersionId,
          seed: `sodium,${i}`,
          game1Outcome: win ? 'W' : 'L',
          game2Outcome: win ? 'W' : 'L',
          category: win ? 'WW' : 'LL',
          game1Turns: 30,
          game2Turns: 30,
          game1EndReason: 'normal',
          game2EndReason: 'normal',
          p1Game1PeakRam: 700,
          p1Game2PeakRam: 700,
          p2Game1PeakRam: 900,
          p2Game2PeakRam: 900,
          p1Game1BankSeconds: 140,
          p1Game2BankSeconds: 140,
          p2Game1BankSeconds: 140,
          p2Game2BankSeconds: 140,
          p1Game1MeanTurnMillis: 200,
          p1Game2MeanTurnMillis: 200,
          p2Game1MeanTurnMillis: 200,
          p2Game2MeanTurnMillis: 200,
          completedAt: 1_760_000_600 + i,
        },
      });
      archived = res.archivedLadder;
    }
    expect(archived).toBe(true);
    expect(db.getLadder('gen1ou20261109')!.status).toBe('archived');
  });

  test('session mints valid cookie bound to developer numeric GitHub ID', async () => {
    db.linkDeveloperGitHubId('pre', 987654, 1_760_000_605);
    const prevSecret = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = AUTH_CFG.sessionSecret;
    try {
      await runPkmnCli(
        ['session', '--github', 'pre'],
        {db, now: 1_760_000_610, log}
      );
    } finally {
      if (prevSecret === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = prevSecret;
    }
    const sessionLine = logs[logs.length - 1];
    expect(sessionLine).toContain('pkmn_session=');
    const rawTok = decodeURIComponent(sessionLine.slice('pkmn_session='.length));
    const verified = auth.verifyToken<auth.Session>(rawTok, AUTH_CFG.sessionSecret, 1_760_000_610);
    expect(verified?.github).toEqual({id: 987654, login: 'pre'});
  });

  test('parseArgs keeps positional arguments after boolean flags', () => {
    const parsedCli = parseArgs(['reassign-developer', '--offline', 'pre', '--none']);
    expect(parsedCli.positional).toEqual(['reassign-developer', 'pre']);
    expect(parsedCli.flags.get('offline')).toBe('true');
    expect(parsedCli.flags.get('none')).toBe('true');
  });

  test('create-tournament rejects unsafe IDs or unknown Showdown formats', async () => {
    await expect(runPkmnCli(
      [
        'create-tournament', '../bad', '--name', 'Bad', '--format', 'gen1ou',
        '--version', '0.11.0', '--starts', '2026-12-01T00:00:00Z',
      ],
      {db, now: 1_760_000_615, log}
    )).rejects.toThrow(/Invalid tournament ID/);

    await expect(runPkmnCli(
      [
        'create-tournament', '4', '--name', 'Bad Fmt', '--format', 'notarealformat99',
        '--version', '0.11.0', '--starts', '2026-12-01T00:00:00Z',
      ],
      {db, now: 1_760_000_615, log}
    )).rejects.toThrow(/Unknown Pokémon Showdown format/);
  });

  test('lookup-smogon prints resolved canonical <slug>.<id>', async () => {
    await runPkmnCli(['lookup-smogon', 'pre'], {
      log,
      lookupSmogon: () => Promise.resolve({
        id: 10544,
        username: 'pre',
        slug: 'pre.10544',
        url: 'https://www.smogon.com/forums/members/pre.10544/',
        banned: false,
      }),
    });
    expect(logs[logs.length - 1]).toContain('pre.10544');
  });

  test('manages tournament creation, seeding, running, or completion lifecycle', async () => {
    const zeroAgent = db.getAgentBySlug('0-error')!;
    await runPkmnCli(
      [
        'create-tournament',
        '3',
        '--name',
        'Tournament #3: Gen 1 OU',
        '--format',
        'gen1ou',
        '--version',
        '0.11.0',
        '--games',
        '8',
        '--tables',
        '2',
        '--starts',
        '2026-12-01T00:00:00Z',
      ],
      {db, now: 1_760_000_620, log}
    );
    expect(db.getTournament('3')?.status).toBe('scheduled');

    const tSub = db.createSubmission({
      agentId: zeroAgent.id,
      version: '1.0.0-t3',
      package: 'oci',
      url: 'ghcr.io/pkmn/0-error:1.0.0-t3',
      sha256: SHA,
      ladderIds: [],
      tournamentIds: ['3'],
      now: 1_760_000_630,
    });
    expect(db.getPendingSubmissions().find(s => s.versionId === tSub.id)?.tournaments)
      .toEqual(['3']);
    db.applySubmissionStatus({versionId: tSub.id, smokeStatus: 'passed', now: 1_760_000_635});
    expect(db.getTournamentEntrants('3').map(e => e.agentSlug)).toEqual(['0-error']);

    await expect(
      runPkmnCli(
        ['seed-tournament', '3', '--ladder', 'gen1ou20261109'],
        {db, now: 1_760_000_640, log}
      )
    ).rejects.toThrow(/Unknown flag "--ladder"/);

    await runPkmnCli(
      ['seed-tournament', '3'],
      {db, now: 1_760_000_640, log}
    );
    expect(db.getTournamentEntrants('3')[0].seed).toBe(1);

    await runPkmnCli(['set-tournament-status', '3', 'running'], {db, now: 1_760_000_650, log});
    expect(db.getRunningTournament()?.id).toBe('3');

    await runPkmnCli(['set-tournament-status', '3', 'completed'], {db, now: 1_760_000_700, log});
    expect(db.getRunningTournament()).toBeUndefined();
    expect(db.getTournament('3')?.completedAt).toBe(1_760_000_700);
  });
});

describe('Arena binary archive uploads', () => {
  let tmpDir: string;
  let db: Database;
  let ctrl: ReturnType<typeof arena.register>;
  let srv: {baseUrl: string; close: () => Promise<void>};
  let events: string[];
  const archiveBytes = Buffer.from('377abcaf271c-mock-7z-archive-payload', 'utf8');
  const expectedSha = crypto.createHash('sha256').update(archiveBytes).digest('hex');

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-arena-archive-'));
    db = new Database(':memory:');
    db.syncLaddersFromYaml(
      `${LADDERS_YAML}\n- name: RAND\n  format: gen9randombattle\n  version: '0.11.0'\n` +
        '  id: gen9randombattle20261109\n  team: random\n  status: active\n',
      1_700_000_000
    );
    syncQualifiedProjects(db, tmpDir, 1_700_000_000);
    db.upsertTournament({
      id: '3',
      name: 'Tournament #3: VGC 2026 Reg M-C OTS BO3',
      format: 'gen9championsvgc2026regmc',
      version: '0.11.0',
      gamesPerMatchup: 18,
      parallelTables: 4,
      hardware: 'GCP L4 Spot',
      status: 'running',
      startsAt: 1_700_000_100,
    });
    events = [];
    const app = polka();
    ctrl = arena.register(app, {
      db,
      auth: new auth.Auth({db, config: AUTH_CFG}),
      arenaSecret: ARENA_SECRET,
      publicDir: tmpDir,
      onUpdate: reason => {
        events.push(reason);
      },
    });
    srv = await startTestServer(app);
  });

  afterEach(async () => {
    ctrl.close();
    await srv.close();
    db.close();
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  const putBinary = async (route: string, shaHeader?: string) => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${ARENA_SECRET}`,
      'Content-Type': 'application/x-7z-compressed',
    };
    if (shaHeader) headers['X-Content-SHA256'] = shaHeader;
    const res = await fetch(`${srv.baseUrl}${route}`, {method: 'PUT', headers, body: archiveBytes});
    return {status: res.status, data: await res.json() as Record<string, unknown>};
  };

  test('rejects PUT /api/arena/ladders/:id/archive on non-pools ladders', async () => {
    db.setLadderStatus('gen1ou20261109', 'archived', 1_700_000_600);
    const badHarvested = await putBinary('/api/arena/ladders/gen1ou20261109/archive');
    expect(badHarvested.status).toBe(400);
    expect(String(badHarvested.data.error)).toMatch(/team-pool \(pools\)/);
  });

  test('gates PUT /api/arena/ladders/:id/archive on archived pools status', async () => {
    expect((await putBinary('/api/arena/ladders/gen9championsvgc2026regmc/archive')).status)
      .toBe(409);
    db.setLadderStatus('gen9championsvgc2026regmc', 'settling', 1_700_000_700);
    expect((await putBinary('/api/arena/ladders/gen9championsvgc2026regmc/archive')).status)
      .toBe(409);

    db.setLadderStatus('gen9championsvgc2026regmc', 'archived', 1_700_000_800);
    const okLadder = await putBinary(
      '/api/arena/ladders/gen9championsvgc2026regmc/archive',
      expectedSha
    );
    expect(okLadder.status).toBe(200);
    expect(okLadder.data.archiveHref).toBe(
      '/arena/ladders/gen9championsvgc2026regmc/gen9championsvgc2026regmc-logs.tar'
    );
    expect(events).toEqual(['archive-published']);
  });

  test('stages pools match logs privately until the ladder is archived', async () => {
    const fp = db.getAgentBySlug('foul-play')!;
    const zero = db.getAgentBySlug('0-error')!;
    const vFp = db.createSubmission({
      agentId: fp.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://github.com/pkmn/fp-vgc.tar.zst',
      sha256: 'c'.repeat(64),
      ladderIds: ['gen9randombattle20261109'],
      now: 1_700_000_010,
    });
    const vZero = db.createSubmission({
      agentId: zero.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://github.com/pkmn/zero-vgc.tar.zst',
      sha256: 'd'.repeat(64),
      ladderIds: ['gen9randombattle20261109'],
      now: 1_700_000_010,
    });
    db.applySubmissionStatus({versionId: vFp.id, smokeStatus: 'passed', now: 1_700_000_020});
    db.applySubmissionStatus({versionId: vZero.id, smokeStatus: 'passed', now: 1_700_000_020});

    const client = new arena.Client({serverUrl: srv.baseUrl, arenaSecret: ARENA_SECRET});
    await client.completeMatch({
      match: {
        id: 'vgc-0000077',
        ladderId: 'gen9championsvgc2026regmc',
        p1VersionId: vFp.id,
        p2VersionId: vZero.id,
        seed: '1,2,3,77',
        p1TeamLabel: 'P1:aabbccddeeff',
        p2TeamLabel: '112233445566',
        game1Outcome: 'W',
        game2Outcome: 'L',
        category: 'WL',
        game1Turns: 8,
        game2Turns: 10,
        game1EndReason: 'win',
        game2EndReason: 'win',
        p1Game1PeakRam: 900,
        p1Game2PeakRam: 900,
        p2Game1PeakRam: 920,
        p2Game2PeakRam: 920,
        p1Game1BankSeconds: 140,
        p1Game2BankSeconds: 138,
        p2Game1BankSeconds: 135,
        p2Game2BankSeconds: 130,
        p1Game1MeanTurnMillis: 210,
        p1Game2MeanTurnMillis: 210,
        p2Game1MeanTurnMillis: 220,
        p2Game2MeanTurnMillis: 220,
        completedAt: 1_700_000_750,
      },
      game1Log: '|player|p1|Foul Play|1\n|player|p2|0 ERROR|2\n|win|Foul Play\n',
      game2Log: '|player|p1|0 ERROR|1\n|player|p2|Foul Play|2\n|win|0 ERROR\n',
    });

    const pubDir = path.join(tmpDir, 'arena', 'ladders', 'gen9championsvgc2026regmc');
    const privDir = path.join(tmpDir, 'arena', 'ladders', '.private', 'gen9championsvgc2026regmc');
    expect(fs.existsSync(pubDir)).toBe(false);
    expect(fs.existsSync(path.join(privDir, 'vgc-0000077a.log'))).toBe(true);
    expect(fs.existsSync(path.join(privDir, 'vgc-0000077b.log'))).toBe(true);
    expect(ctrl.getLiveDocument(1_700_000_760).recentMatches[0].games[0].logHref).toBeUndefined();

    db.setLadderStatus('gen9championsvgc2026regmc', 'archived', 1_700_000_800);
    const doc = ctrl.getLiveDocument(1_700_000_810);
    expect(doc.recentMatches[0].games[0].logHref).toBe(
      '/arena/ladders/gen9championsvgc2026regmc/vgc-0000077a.log'
    );
    expect(doc.recentMatches[0].games[1].logHref).toBe(
      '/arena/ladders/gen9championsvgc2026regmc/vgc-0000077b.log'
    );
    expect(fs.existsSync(privDir)).toBe(false);
    expect(fs.existsSync(path.join(pubDir, 'vgc-0000077a.log'))).toBe(true);
  });

  test('reports unpublished archived pools ladders on GET /api/arena/ladders', async () => {
    const client = new arena.Client({serverUrl: srv.baseUrl, arenaSecret: ARENA_SECRET});
    expect((await client.getPlayableLadders()).unpublishedArchivedPoolsLadders).toEqual([]);

    db.setLadderStatus('gen9championsvgc2026regmc', 'archived', 1_700_000_800);
    expect((await client.getPlayableLadders()).unpublishedArchivedPoolsLadders).toEqual([
      'gen9championsvgc2026regmc',
    ]);

    await putBinary('/api/arena/ladders/gen9championsvgc2026regmc/archive', expectedSha);
    expect((await client.getPlayableLadders()).unpublishedArchivedPoolsLadders).toEqual([]);
  });

  test('accepts PUT /api/arena/ladders/:id/archive on active random ladders', async () => {
    const okRand = await putBinary(
      '/api/arena/ladders/gen9randombattle20261109/archive',
      expectedSha
    );
    expect(okRand.status).toBe(200);
    expect(okRand.data.archiveHref).toBe(
      '/arena/ladders/gen9randombattle20261109/gen9randombattle20261109-logs.tar'
    );
    expect(okRand.data.teamsHref).toBeUndefined();
    expect(
      fs.readFileSync(
        path.join(
          tmpDir,
          'arena',
          'ladders',
          'gen9randombattle20261109',
          'gen9randombattle20261109-logs.tar'
        )
      )
    ).toEqual(archiveBytes);
  });

  test('streams live lines on random ladder heartbeats while omitting harvested lines',
    async () => {
      const client = new arena.Client({serverUrl: srv.baseUrl, arenaSecret: ARENA_SECRET});
      await client.sendHeartbeat({
        heartbeatSeq: 1,
        matchId: 'gen9randombattle-0000001',
        ladderId: 'gen9randombattle20261109',
        format: 'gen9randombattle',
        game: 1,
        turn: 3,
        activeSlot: 'p1',
        turnStartedAt: 1_700_000_900,
        turnBudgetSeconds: 140,
        incrementSeconds: 5,
        viewer: {lines: ['|player|p1|0 ERROR|1', '|player|p2|Foul Play|2', '|turn|3']},
        p1: {
          slug: '0-error',
          name: '0 ERROR',
          version: '1.0.0',
          bankSeconds: 140,
          lastTurnMillis: 200,
          meanTurnMillis: 200,
          ram: 800,
        },
        p2: {
          slug: 'foul-play',
          name: 'Foul Play',
          version: '1.0.0',
          bankSeconds: 140,
          lastTurnMillis: 200,
          meanTurnMillis: 200,
          ram: 800,
        },
      });
      expect(ctrl.getLiveDocument(1_700_000_905).live?.viewer?.lines).toEqual([
        '|player|p1|0 ERROR|1',
        '|player|p2|Foul Play|2',
        '|turn|3',
      ]);

      await client.sendHeartbeat({
        heartbeatSeq: 2,
        matchId: 'gen1ou-0000002',
        ladderId: 'gen1ou20261109',
        format: 'gen1ou',
        game: 1,
        turn: 2,
        activeSlot: 'p1',
        turnStartedAt: 1_700_000_906,
        turnBudgetSeconds: 140,
        incrementSeconds: 5,
        viewer: {lines: ['|player|p1|0 ERROR|1']},
        p1: {
          slug: '0-error',
          name: '0 ERROR',
          version: '1.0.0',
          bankSeconds: 140,
          lastTurnMillis: 200,
          meanTurnMillis: 200,
          ram: 800,
        },
        p2: {
          slug: 'foul-play',
          name: 'Foul Play',
          version: '1.0.0',
          bankSeconds: 140,
          lastTurnMillis: 200,
          meanTurnMillis: 200,
          ram: 800,
        },
      });
      expect(ctrl.getLiveDocument(1_700_000_907).live?.viewer).toBeUndefined();
    });

  test('writes per-game replay logs on random ladder match-complete', async () => {
    const fp = db.getAgentBySlug('foul-play')!;
    const zero = db.getAgentBySlug('0-error')!;
    const vFp = db.createSubmission({
      agentId: fp.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://github.com/pkmn/fp.tar.zst',
      sha256: 'a'.repeat(64),
      ladderIds: ['gen9randombattle20261109'],
      now: 1_700_000_010,
    });
    const vZero = db.createSubmission({
      agentId: zero.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://github.com/pkmn/zero.tar.zst',
      sha256: 'b'.repeat(64),
      ladderIds: ['gen9randombattle20261109'],
      now: 1_700_000_010,
    });
    db.applySubmissionStatus({versionId: vFp.id, smokeStatus: 'passed', now: 1_700_000_020});
    db.applySubmissionStatus({versionId: vZero.id, smokeStatus: 'passed', now: 1_700_000_020});

    const client = new arena.Client({serverUrl: srv.baseUrl, arenaSecret: ARENA_SECRET});
    await client.completeMatch({
      match: {
        id: 'gen9randombattle-0000042',
        ladderId: 'gen9randombattle20261109',
        p1VersionId: vFp.id,
        p2VersionId: vZero.id,
        seed: '1,2,3,42',
        game1Outcome: 'W',
        game2Outcome: 'L',
        category: 'WL',
        game1Turns: 18,
        game2Turns: 21,
        game1EndReason: 'win',
        game2EndReason: 'win',
        p1Game1PeakRam: 800,
        p1Game2PeakRam: 800,
        p2Game1PeakRam: 820,
        p2Game2PeakRam: 820,
        p1Game1BankSeconds: 130,
        p1Game2BankSeconds: 128,
        p2Game1BankSeconds: 125,
        p2Game2BankSeconds: 120,
        p1Game1MeanTurnMillis: 240,
        p1Game2MeanTurnMillis: 240,
        p2Game1MeanTurnMillis: 250,
        p2Game2MeanTurnMillis: 250,
        completedAt: 1_700_000_950,
      },
      game1Log: '|player|p1|Foul Play|1\n|player|p2|0 ERROR|2\n|win|Foul Play\n',
      game2Log: '|player|p1|0 ERROR|1\n|player|p2|Foul Play|2\n|win|0 ERROR\n',
    });

    const doc = ctrl.getLiveDocument(1_700_000_960);
    expect(doc.recentMatches[0].games[0].logHref).toBe(
      '/arena/ladders/gen9randombattle20261109/gen9randombattle-0000042a.log'
    );
    expect(doc.recentMatches[0].games[1].logHref).toBe(
      '/arena/ladders/gen9randombattle20261109/gen9randombattle-0000042b.log'
    );
  });
});

describe('GET /api/battles.json pagination', () => {
  let tmpDir: string;
  let db: Database;
  let handle: ReturnType<typeof arena.register>;
  let srv: {baseUrl: string; close: () => Promise<void>};

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-arena-battles-page-'));
    db = new Database(':memory:');
    db.syncLaddersFromYaml(LADDERS_YAML, 1_700_000_000);
    syncQualifiedProjects(db, tmpDir, 1_700_000_000);

    const fp = db.getAgentBySlug('foul-play')!;
    const zero = db.getAgentBySlug('0-error')!;
    const vFp = db.createSubmission({
      agentId: fp.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://github.com/pkmn/fp.tar.zst',
      sha256: 'a'.repeat(64),
      ladderIds: ['gen1ou20261109'],
      now: 1_700_000_010,
    });
    const vZero = db.createSubmission({
      agentId: zero.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://github.com/pkmn/zero.tar.zst',
      sha256: 'b'.repeat(64),
      ladderIds: ['gen1ou20261109'],
      now: 1_700_000_010,
    });
    db.applySubmissionStatus({versionId: vFp.id, smokeStatus: 'passed', now: 1_700_000_020});
    db.applySubmissionStatus({versionId: vZero.id, smokeStatus: 'passed', now: 1_700_000_020});

    for (let i = 1; i <= 5; i++) {
      db.recordCompletedMatch({
        match: {
          id: `m-00${i}`,
          ladderId: i % 2 === 0 ? 'gen9championsvgc2026regmc' : 'gen1ou20261109',
          p1VersionId: vFp.id,
          p2VersionId: vZero.id,
          seed: `1,2,3,${i}`,
          game1Outcome: 'W',
          game2Outcome: 'L',
          category: 'WL',
          game1Turns: 20 + i,
          game2Turns: 22 + i,
          game1EndReason: 'normal',
          game2EndReason: 'normal',
          p1Game1PeakRam: 900,
          p1Game2PeakRam: 900,
          p2Game1PeakRam: 950,
          p2Game2PeakRam: 950,
          p1Game1BankSeconds: 140,
          p1Game2BankSeconds: 138,
          p2Game1BankSeconds: 136,
          p2Game2BankSeconds: 132,
          p1Game1MeanTurnMillis: 300,
          p1Game2MeanTurnMillis: 300,
          p2Game1MeanTurnMillis: 320,
          p2Game2MeanTurnMillis: 320,
          completedAt: 1_700_000_100 + i * 10,
        },
      });
    }

    const app = polka();
    handle = arena.register(app, {
      db,
      arenaSecret: ARENA_SECRET,
      publicDir: tmpDir,
      now: () => 1_700_000_999,
    });
    srv = await startTestServer(app);
  });

  afterAll(async () => {
    handle.close();
    await srv.close();
    db.close();
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  test('paginates completed matches with per-slot counts', async () => {
    const p1 = await (await fetch(`${srv.baseUrl}/api/battles.json?page=1&limit=2`)).json() as {
      page: number;
      total: number;
      totalPages: number;
      hasPrev: boolean;
      hasNext: boolean;
      countsBySlot: Record<string, number>;
      matches: Array<{id: string}>;
    };
    expect(p1.page).toBe(1);
    expect(p1.total).toBe(5);
    expect(p1.totalPages).toBe(3);
    expect(p1.hasPrev).toBe(false);
    expect(p1.hasNext).toBe(true);
    expect(p1.countsBySlot).toEqual({all: 5, rby: 3, vgc: 2});
    expect(p1.matches.map(m => m.id)).toEqual(['m-005', 'm-004']);

    const p3 = await (await fetch(`${srv.baseUrl}/api/battles.json?page=3&limit=2`)).json() as {
      hasPrev: boolean;
      hasNext: boolean;
      matches: Array<{id: string}>;
    };
    expect(p3.hasPrev).toBe(true);
    expect(p3.hasNext).toBe(false);
    expect(p3.matches.map(m => m.id)).toEqual(['m-001']);
  });

  test('filters /api/battles.json by ladder slot or single match ID', async () => {
    const vgcOnly = await (
      await fetch(`${srv.baseUrl}/api/battles.json?slot=vgc&page=1&limit=10`)
    ).json() as {total: number; matches: Array<{id: string}>};
    expect(vgcOnly.total).toBe(2);
    expect(vgcOnly.matches.map(m => m.id)).toEqual(['m-004', 'm-002']);

    const byId = await fetch(`${srv.baseUrl}/api/battles.json?id=m-003`);
    expect(byId.status).toBe(200);
    expect(((await byId.json()) as {match: {id: string}}).match.id).toBe('m-003');
  });

  test('returns 404 or 400 on missing match IDs or invalid query parameters', async () => {
    expect((await fetch(`${srv.baseUrl}/api/battles.json?id=missing`)).status).toBe(404);
    expect((await fetch(`${srv.baseUrl}/api/battles.json?slot=bogus`)).status).toBe(400);
    expect((await fetch(`${srv.baseUrl}/api/battles.json?page=0`)).status).toBe(400);
  });

  test('filters GET /api/battles.json head-to-head pairings via vs query parameter', async () => {
    const vsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-arena-battles-vs-'));
    const vsDb = new Database(':memory:');
    vsDb.syncLaddersFromYaml(LADDERS_YAML, 1_700_000_000);
    syncQualifiedProjects(vsDb, vsDir, 1_700_000_000);
    vsDb.db.prepare("UPDATE ladders SET status = 'active' WHERE id = ?").run('gen1ou20261109');

    const fp = vsDb.getAgentBySlug('foul-play')!;
    const zero = vsDb.getAgentBySlug('0-error')!;
    const meta = vsDb.getAgentBySlug('metamon')!;
    const mkSub = (agentId: number, tag: string) => {
      const sub = vsDb.createSubmission({
        agentId,
        version: '1.0.0',
        package: 'bundle',
        url: `https://example.com/${tag}.tar.zst`,
        sha256: SHA,
        ladderIds: ['gen1ou20261109'],
        now: 1_700_000_010,
      });
      vsDb.applySubmissionStatus({versionId: sub.id, smokeStatus: 'passed', now: 1_700_000_020});
      return sub.id;
    };
    const vFp = mkSub(fp.id, 'fp');
    const vZero = mkSub(zero.id, 'zero');
    const vMeta = mkSub(meta.id, 'meta');

    const record = (id: string, p1VersionId: number, p2VersionId: number, ts: number) => {
      vsDb.recordCompletedMatch({
        match: {
          id,
          ladderId: 'gen1ou20261109',
          p1VersionId,
          p2VersionId,
          seed: `1,2,3,${ts}`,
          game1Outcome: 'W',
          game2Outcome: 'L',
          category: 'WL',
          game1Turns: 20,
          game2Turns: 22,
          game1EndReason: 'normal',
          game2EndReason: 'normal',
          p1Game1PeakRam: 900,
          p1Game2PeakRam: 900,
          p2Game1PeakRam: 900,
          p2Game2PeakRam: 900,
          p1Game1BankSeconds: 140,
          p1Game2BankSeconds: 140,
          p2Game1BankSeconds: 140,
          p2Game2BankSeconds: 140,
          p1Game1MeanTurnMillis: 250,
          p1Game2MeanTurnMillis: 250,
          p2Game1MeanTurnMillis: 250,
          p2Game2MeanTurnMillis: 250,
          completedAt: ts,
        },
      });
    };

    record('m-fp-zero', vFp, vZero, 1_700_000_110);
    record('m-fp-meta', vFp, vMeta, 1_700_000_120);
    record('m-zero-meta', vZero, vMeta, 1_700_000_130);

    const vsApp = polka();
    const vsHandle = arena.register(vsApp, {
      db: vsDb,
      arenaSecret: ARENA_SECRET,
      publicDir: vsDir,
      now: () => 1_700_000_999,
    });
    const vsSrv = await startTestServer(vsApp);

    try {
      const h2h = await (
        await fetch(`${vsSrv.baseUrl}/api/battles.json?agent=foul-play&vs=0-error`)
      ).json() as {
        total: number;
        agentSlug: string;
        opponentSlug: string;
        matches: Array<{id: string}>;
      };
      expect(h2h.total).toBe(1);
      expect(h2h.agentSlug).toBe('foul-play');
      expect(h2h.opponentSlug).toBe('0-error');
      expect(h2h.matches.map(m => m.id)).toEqual(['m-fp-zero']);
    } finally {
      vsHandle.close();
      await vsSrv.close();
      vsDb.close();
      fs.rmSync(vsDir, {recursive: true, force: true});
    }
  });

  test('returns 304 Not Modified on /api/battles.json when If-None-Match matches', async () => {
    const first = await fetch(`${srv.baseUrl}/api/battles.json?slot=rby&page=1`);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-cache');
    const etag = first.headers.get('etag')!;
    expect(etag).toMatch(/^"[0-9a-f]{40}"$/);
    const second = await fetch(`${srv.baseUrl}/api/battles.json?slot=rby&page=1`, {
      headers: {'If-None-Match': etag},
    });
    expect(second.status).toBe(304);
  });

  test('returns 304 Not Modified on /api/battles.json for weak gzip If-None-Match', async () => {
    const first = await fetch(`${srv.baseUrl}/api/battles.json?slot=rby&page=1`);
    const etag = first.headers.get('etag')!;
    const weak = await fetch(`${srv.baseUrl}/api/battles.json?slot=rby&page=1`, {
      headers: {'If-None-Match': `W/${etag}`},
    });
    expect(weak.status).toBe(304);
  });

  test('invalidates /api/battles.json ETag after a new match completes', async () => {
    const first = await fetch(`${srv.baseUrl}/api/battles.json?page=1&limit=2`);
    const etag = first.headers.get('etag')!;
    const fp = db.getAgentBySlug('foul-play')!;
    const zero = db.getAgentBySlug('0-error')!;
    const vFp = db.getVersionsForAgent(fp.id)[0];
    const vZero = db.getVersionsForAgent(zero.id)[0];
    db.recordCompletedMatch({
      match: {
        id: 'm-006-fresh',
        ladderId: 'gen1ou20261109',
        p1VersionId: vFp.id,
        p2VersionId: vZero.id,
        seed: '9,9,9,9',
        game1Outcome: 'W',
        game2Outcome: 'W',
        category: 'WW',
        game1Turns: 18,
        game2Turns: 19,
        game1EndReason: 'normal',
        game2EndReason: 'normal',
        p1Game1PeakRam: 900,
        p1Game2PeakRam: 900,
        p2Game1PeakRam: 950,
        p2Game2PeakRam: 950,
        p1Game1BankSeconds: 140,
        p1Game2BankSeconds: 140,
        p2Game1BankSeconds: 140,
        p2Game2BankSeconds: 140,
        p1Game1MeanTurnMillis: 250,
        p1Game2MeanTurnMillis: 250,
        p2Game1MeanTurnMillis: 250,
        p2Game2MeanTurnMillis: 250,
        completedAt: 1_700_000_200,
      },
    });
    const second = await fetch(`${srv.baseUrl}/api/battles.json?page=1&limit=2`, {
      headers: {'If-None-Match': etag},
    });
    expect(second.status).toBe(200);
    expect(second.headers.get('etag')).not.toBe(etag);
    const body = await second.json() as {total: number; matches: Array<{id: string}>};
    expect(body.total).toBe(6);
    expect(body.matches[0]?.id).toBe('m-006-fresh');
  });
});

describe('harvested ladder teams API', () => {
  let tmpDir: string;
  let db: Database;
  let ctrl: ReturnType<typeof arena.register>;
  let srv: {baseUrl: string; close: () => Promise<void>};
  let events: string[];
  const rbyPaste = RBY_HARVESTED_TEAMS
    .map((t, i) => `=== [gen1ou] Team ${i + 1} ===\n${t}`)
    .join('\n\n');

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-arena-teams-'));
    db = new Database(':memory:');
    db.syncLaddersFromYaml(LADDERS_YAML.replace(/status: active/g, 'status: upcoming'),
      1_700_000_000);
    syncQualifiedProjects(db, tmpDir, 1_700_000_000);
    events = [];
    const app = polka();
    ctrl = arena.register(app, {
      db,
      auth: new auth.Auth({db, config: AUTH_CFG}),
      arenaSecret: ARENA_SECRET,
      publicDir: tmpDir,
      onUpdate: reason => {
        events.push(reason);
      },
    });
    srv = await startTestServer(app);
  });

  afterEach(async () => {
    ctrl.close();
    await srv.close();
    db.close();
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  test('requires Bearer authentication on GET /api/arena/ladders/:id/teams', async () => {
    const client = new arena.Client({serverUrl: srv.baseUrl, arenaSecret: ARENA_SECRET});
    const pending = await client.getPendingSubmissions();
    expect(pending.ladders.map(l => `${l.id}:${l.status}`)).toContain('gen1ou20261109:upcoming');

    expect((await fetch(`${srv.baseUrl}/api/arena/ladders/gen1ou20261109/teams`)).status).toBe(401);
  });

  test('returns 404 before harvested teams are uploaded', async () => {
    expect((await fetch(`${srv.baseUrl}/api/arena/ladders/gen1ou20261109/teams`, {
      headers: {authorization: `Bearer ${ARENA_SECRET}`},
    })).status).toBe(404);
  });

  test('rejects CLI upload-ladder-teams targeting a non-harvested ladder', async () => {
    const rbyFile = path.join(tmpDir, 'rby.txt');
    fs.writeFileSync(rbyFile, rbyPaste, 'utf8');
    await expect(
      runPkmnCli(['upload-ladder-teams', 'gen9championsvgc2026regmc', rbyFile], {
        db,
        now: 1_700_000_005,
        log: () => undefined,
      })
    ).rejects.toThrow(/harvested/);
  });

  test('rejects CLI upload-ladder-teams containing fewer than 2 distinct teams', async () => {
    const dupFile = path.join(tmpDir, 'dup.txt');
    fs.writeFileSync(
      dupFile,
      [RBY_HARVESTED_TEAMS[0], RBY_HARVESTED_TEAMS[0]]
        .map((t, i) => `=== [gen1ou] Dup ${i + 1} ===\n${t}`)
        .join('\n\n'),
      'utf8'
    );
    await expect(
      runPkmnCli(['upload-ladder-teams', 'gen1ou20261109', dupFile], {
        db,
        now: 1_700_000_006,
        log: () => undefined,
      })
    ).rejects.toThrow(/non-mirror/);
  });

  test('serves uploaded harvested teams with SHA-256 ETag 304 caching', async () => {
    const rbyFile = path.join(tmpDir, 'rby-upload.txt');
    fs.writeFileSync(rbyFile, rbyPaste, 'utf8');
    await runPkmnCli(['upload-ladder-teams', 'gen1ou20261109', rbyFile], {
      db,
      now: 1_700_000_010,
      log: () => undefined,
    });
    expect(db.countLadderTeams('gen1ou20261109')).toBe(4);
    expect(events).toEqual([]);

    const getRes = await fetch(`${srv.baseUrl}/api/arena/ladders/gen1ou20261109/teams`, {
      headers: {authorization: `Bearer ${ARENA_SECRET}`},
    });
    expect(getRes.status).toBe(200);
    const etag = getRes.headers.get('etag')!;
    const body = await getRes.json() as arena.LadderTeamsResponse;
    expect(etag).toBe(`"${body.sha256}"`);
    expect(body.teams).toHaveLength(4);

    const cachedRes = await fetch(`${srv.baseUrl}/api/arena/ladders/gen1ou20261109/teams`, {
      headers: {
        authorization: `Bearer ${ARENA_SECRET}`,
        'if-none-match': etag,
      },
    });
    expect(cachedRes.status).toBe(304);
  });

  test('enforces harvested teams, minimum entries, plus anchor in pkmn set-ladder-status',
    async () => {
      const rbyFile = path.join(tmpDir, 'rby-teams.txt');
      fs.writeFileSync(
        rbyFile,
        RBY_HARVESTED_TEAMS.slice(0, 3)
          .map((t, i) => `=== [gen1ou] Team ${i + 1} ===\n${t}`)
          .join('\n\n'),
        'utf8'
      );
      await runPkmnCli(
        ['upload-ladder-teams', 'gen1ou20261109', rbyFile],
        {db, now: 1_700_000_010, log: () => undefined}
      );
      expect(db.countLadderTeams('gen1ou20261109')).toBe(3);

      await expect(
        runPkmnCli(['set-ladder-status', 'gen1ou20261109', 'active'], {db, now: 1_700_000_020})
      ).rejects.toThrow(/requires at least 2 distinct active entries/);

      const zero = db.getAgentBySlug('0-error')!;
      const fp = db.getAgentBySlug('foul-play')!;
      const vZ = db.createSubmission({
        agentId: zero.id,
        version: '1.0.0',
        package: 'bundle',
        url: 'https://github.com/pkmn/zero-rby.tar.zst',
        sha256: SHA,
        ladderIds: ['gen1ou20261109'],
        now: 1_700_000_030,
      });
      const vF = db.createSubmission({
        agentId: fp.id,
        version: '1.0.0',
        package: 'bundle',
        url: 'https://github.com/pkmn/fp-rby.tar.zst',
        sha256: 'b'.repeat(64),
        ladderIds: ['gen1ou20261109'],
        now: 1_700_000_030,
      });
      db.applySubmissionStatus({versionId: vZ.id, smokeStatus: 'passed', now: 1_700_000_040});
      db.applySubmissionStatus({versionId: vF.id, smokeStatus: 'passed', now: 1_700_000_040});

      await expect(
        runPkmnCli(['set-ladder-status', 'gen1ou20261109', 'active'], {db, now: 1_700_000_050})
      ).rejects.toThrow(/no active 1500-Elo anchor/);

      await runPkmnCli(
        ['set-anchor', 'gen1ou20261109', 'foul-play', '1.0.0'],
        {db, now: 1_700_000_060, log: () => undefined}
      );
      await runPkmnCli(
        ['set-ladder-status', 'gen1ou20261109', 'active'],
        {db, now: 1_700_000_070, log: () => undefined}
      );
      expect(db.getLadder('gen1ou20261109')!.status).toBe('active');
    });
});

describe('createServerApp production HTTP hardening', () => {
  let tmpDir: string;
  let db: Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-server-app-test-'));
    db = new Database(':memory:');
    db.syncLaddersFromYaml(LADDERS_YAML, 1_760_000_000);
    syncQualifiedProjects(db, tmpDir, 1_760_000_000);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  test('converts thrown string-code errors into safe 500 responses without crashing', async () => {
    const handle = createServerApp({db, publicDir: tmpDir, enableDiscord: false});
    handle.app.get('/api/boom', () => {
      throw Object.assign(new Error('SQLITE_SECRET_DETAIL'), {code: 'ERR_SQLITE_ERROR'});
    });
    const srv = await startTestServer(handle.app);
    const origError = console.error;
    console.error = () => undefined;
    try {
      const res = await fetch(`${srv.baseUrl}/api/boom`);
      expect(res.status).toBe(500);
      const body = (await res.json()) as {error: string};
      expect(body.error).toBe('Internal Server Error');
      expect(body.error).not.toContain('SQLITE_SECRET_DETAIL');
    } finally {
      console.error = origError;
      handle.close();
      await srv.close();
    }
  });

  test('blocks unarchived pools ladder log files from static serving', async () => {
    const logDir = path.join(tmpDir, 'arena', 'ladders', 'gen9championsvgc2026regmc');
    fs.mkdirSync(logDir, {recursive: true});
    fs.writeFileSync(path.join(logDir, 'vgc-001a.log'), '|player|p1|SecretSet\n', 'utf8');

    const handle = createServerApp({db, publicDir: tmpDir, enableDiscord: false});
    const srv = await startTestServer(handle.app);
    try {
      const activeRes = await fetch(
        `${srv.baseUrl}/arena/ladders/gen9championsvgc2026regmc/vgc-001a.log`
      );
      expect(activeRes.status).toBe(404);

      db.setLadderStatus('gen9championsvgc2026regmc', 'archived', 1_760_000_500);
      const archivedRes = await fetch(
        `${srv.baseUrl}/arena/ladders/gen9championsvgc2026regmc/vgc-001a.log`
      );
      expect(archivedRes.status).toBe(200);
    } finally {
      handle.close();
      await srv.close();
    }
  });

  test('replaces pre-mounted static middleware on an existing Polka app', async () => {
    fs.mkdirSync(path.join(tmpDir, 'arena'), {recursive: true});
    fs.writeFileSync(path.join(tmpDir, 'arena', 'index.html'), '', 'utf8');

    const logged: string[] = [];
    const preApp = polka();
    preApp.use((req, _res, next) => {
      logged.push(req.url ?? '');
      next();
    });
    preApp.use(serveStatic(tmpDir) as unknown as polka.Middleware);

    const handle = createServerApp({
      app: preApp,
      db,
      publicDir: tmpDir,
      enableDiscord: false,
    });
    const srv = await startTestServer(handle.app);
    try {
      const res = await fetch(`${srv.baseUrl}/arena/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('Arena');
      expect(logged).toEqual(['/arena/']);
    } finally {
      handle.close();
      await srv.close();
    }
  });

  test('serves /llms.txt as plain text from publicDir', async () => {
    fs.writeFileSync(path.join(tmpDir, 'llms.txt'), '# pkmn.ai\n', 'utf8');
    const handle = createServerApp({db, publicDir: tmpDir, enableDiscord: false});
    const srv = await startTestServer(handle.app);
    try {
      const res = await fetch(`${srv.baseUrl}/llms.txt`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^text\/plain\b/);
      expect(await res.text()).toBe('# pkmn.ai\n');
    } finally {
      handle.close();
      await srv.close();
    }
  });

  test('redirects static HTML directories without trailing slash', async () => {
    fs.mkdirSync(path.join(tmpDir, 'rules'), {recursive: true});
    fs.writeFileSync(path.join(tmpDir, 'rules', 'index.html'), '<html></html>', 'utf8');
    const handle = createServerApp({db, publicDir: tmpDir, enableDiscord: false});
    const srv = await startTestServer(handle.app);
    try {
      const res = await fetch(`${srv.baseUrl}/rules?v=1`, {redirect: 'manual'});
      expect(res.status).toBe(301);
      expect(res.headers.get('location')).toBe('/rules/?v=1');
    } finally {
      handle.close();
      await srv.close();
    }
  });

  test('serves pre-built HTML with SSR account avatar and ETag 304', async () => {
    const prevSecret = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = 'test-static-html-session-secret';
    const sampleHtml =
      '<!doctype html><html><head></head><body>' +
      '<a href="/account/" class="subtle" aria-label="Account" id="account-link" title="Account">' +
      '<svg class="account-icon"></svg></a></body></html>';
    fs.writeFileSync(path.join(tmpDir, 'index.html'), sampleHtml, 'utf8');
    const handle = createServerApp({db, publicDir: tmpDir, enableDiscord: false});
    const srv = await startTestServer(handle.app);
    try {
      const token = auth.signToken(
        {github: {id: 117249, login: 'scheibo'}, exp: Math.floor(Date.now() / 1000) + 3600},
        process.env.SESSION_SECRET
      );
      const res = await fetch(`${srv.baseUrl}/`, {
        headers: {Cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(token)}`},
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('private, no-cache');
      expect(res.headers.get('vary')).toBe('Cookie');
      const etag = res.headers.get('etag');
      expect(etag).toBeTruthy();
      const body = await res.text();
      expect(body).toContain('class="subtle has-avatar"');
      expect(body).toContain('https://avatars.githubusercontent.com/u/117249?s=64');

      const cached = await fetch(`${srv.baseUrl}/`, {
        headers: {
          Cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(token)}`,
          'If-None-Match': etag!,
        },
      });
      expect(cached.status).toBe(304);
    } finally {
      handle.close();
      await srv.close();
      if (prevSecret === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = prevSecret;
    }
  });

  test('canonicalizes protocol-relative directory redirects in static HTML', async () => {
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html>home</html>', 'utf8');
    fs.mkdirSync(path.join(tmpDir, 'rules'), {recursive: true});
    fs.writeFileSync(path.join(tmpDir, 'rules', 'index.html'), '<html>rules</html>', 'utf8');
    const handle = createServerApp({db, publicDir: tmpDir, enableDiscord: false});
    const srv = await startTestServer(handle.app);
    const port = Number(new URL(srv.baseUrl).port);
    const rawGet = (reqPath: string) => new Promise<{status?: number; location?: string}>(
      (resolve, reject) => {
        const req = http.request({host: '127.0.0.1', port, path: reqPath, method: 'GET'}, res => {
          res.resume();
          res.on('end', () => resolve({status: res.statusCode, location: res.headers.location}));
        });
        req.on('error', reject);
        req.end();
      }
    );
    try {
      expect(await rawGet('//evil.com/..')).toEqual({status: 301, location: '/'});
      expect(await rawGet('//evil.com/../rules?v=1')).toEqual({
        status: 301,
        location: '/rules/?v=1',
      });
      expect(await rawGet('//rules')).toEqual({status: 301, location: '/rules/'});
    } finally {
      handle.close();
      await srv.close();
    }
  });

  test('blocks percent-encoded skip prefixes in static HTML middleware', async () => {
    fs.mkdirSync(path.join(tmpDir, 'private'), {recursive: true});
    fs.writeFileSync(path.join(tmpDir, 'private', 'index.html'), '<html>secret</html>', 'utf8');
    fs.mkdirSync(path.join(tmpDir, 'rules'), {recursive: true});
    fs.writeFileSync(path.join(tmpDir, 'rules', 'index.html'), '<html>rules</html>', 'utf8');
    const handle = createServerApp({db, publicDir: tmpDir, enableDiscord: false});
    const srv = await startTestServer(handle.app);
    const port = Number(new URL(srv.baseUrl).port);
    const rawStatus = (reqPath: string) => new Promise<number>((resolve, reject) => {
      const req = http.request({host: '127.0.0.1', port, path: reqPath, method: 'GET'}, res => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end();
    });
    try {
      expect(await rawStatus('/%70rivate/')).toBe(404);
      expect(await rawStatus('/rules/../private/')).toBe(404);
      expect(await rawStatus('/PRIVATE/')).toBe(404);
    } finally {
      handle.close();
      await srv.close();
    }
  });

  test('blocks dot-segment internal error HTML files in static HTML middleware', async () => {
    fs.writeFileSync(path.join(tmpDir, '404.html'), '<html>static 404</html>', 'utf8');
    fs.mkdirSync(path.join(tmpDir, 'rules'), {recursive: true});
    const handle = createServerApp({db, publicDir: tmpDir, enableDiscord: false});
    const srv = await startTestServer(handle.app);
    const port = Number(new URL(srv.baseUrl).port);
    const rawStatus = (reqPath: string) => new Promise<number>((resolve, reject) => {
      const req = http.request({host: '127.0.0.1', port, path: reqPath, method: 'GET'}, res => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end();
    });
    try {
      expect(await rawStatus('/./404.html')).toBe(404);
      expect(await rawStatus('/rules/../404.html')).toBe(404);
    } finally {
      handle.close();
      await srv.close();
    }
  });

  test('sets private no-cache on authenticated dynamic HTML responses', async () => {
    const prevSecret = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = 'test-dynamic-html-session-secret';
    const handle = createServerApp({db, publicDir: tmpDir, enableDiscord: false});
    const srv = await startTestServer(handle.app);
    try {
      const token = auth.signToken(
        {github: {id: 117249, login: 'scheibo'}, exp: Math.floor(Date.now() / 1000) + 3600},
        process.env.SESSION_SECRET
      );
      const signedIn = await fetch(`${srv.baseUrl}/arena/`, {
        headers: {Cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(token)}`},
      });
      expect(signedIn.status).toBe(200);
      expect(signedIn.headers.get('cache-control')).toBe('private, no-cache');
      expect(signedIn.headers.get('vary')).toBe('Cookie');

      const signedOut = await fetch(`${srv.baseUrl}/arena/`);
      expect(signedOut.status).toBe(200);
      expect(signedOut.headers.get('cache-control')).toBe('no-cache');
      expect(signedOut.headers.get('vary')).toBe('Cookie');
    } finally {
      handle.close();
      await srv.close();
      if (prevSecret === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = prevSecret;
    }
  });

  test('does not serve internal error HTML files directly from publicDir', async () => {
    fs.writeFileSync(path.join(tmpDir, '404.html'), '<html>static 404</html>', 'utf8');
    const handle = createServerApp({db, publicDir: tmpDir, enableDiscord: false});
    const srv = await startTestServer(handle.app);
    try {
      const res = await fetch(`${srv.baseUrl}/404.html`);
      expect(res.status).toBe(404);
    } finally {
      handle.close();
      await srv.close();
    }
  });

  test('rejects astronomical page query parameters on /api/battles.json', async () => {
    const handle = createServerApp({db, publicDir: tmpDir, enableDiscord: false});
    const srv = await startTestServer(handle.app);
    try {
      const res = await fetch(`${srv.baseUrl}/api/battles.json?page=1e300`);
      expect(res.status).toBe(400);
    } finally {
      handle.close();
      await srv.close();
    }
  });

  test('rejects non-loopback cleartext http:// URLs in arena.Client', () => {
    const prevDev = process.env.ARENA_DEV;
    delete process.env.ARENA_DEV;
    try {
      expect(() => new arena.Client({
        serverUrl: 'http://pkmn.ai',
        arenaSecret: 'secret',
      })).toThrow(/Refusing cleartext HTTP/);
      expect(() => new arena.Client({
        serverUrl: 'https://pkmn.ai',
        arenaSecret: 'secret',
      })).not.toThrow();
    } finally {
      if (prevDev !== undefined) process.env.ARENA_DEV = prevDev;
    }
  });

  test('rejects match-complete submissions targeting upcoming ladders', async () => {
    db.syncLaddersFromYaml(
      `${LADDERS_YAML}\n- name: ADV\n  format: gen3ou\n  version: '0.11.0'\n` +
      '  id: gen3ou20261109\n  team: harvested\n  status: upcoming\n',
      1_760_000_010
    );
    const zero = db.getAgentBySlug('0-error')!;
    const fp = db.getAgentBySlug('foul-play')!;
    const v1 = db.createSubmission({
      agentId: zero.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://github.com/pkmn/z.tar.zst',
      sha256: SHA,
      ladderIds: ['gen1ou20261109'],
      now: 1_760_000_020,
    });
    const v2 = db.createSubmission({
      agentId: fp.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://github.com/pkmn/f.tar.zst',
      sha256: 'b'.repeat(64),
      ladderIds: ['gen1ou20261109'],
      now: 1_760_000_020,
    });
    db.applySubmissionStatus({versionId: v1.id, smokeStatus: 'passed', now: 1_760_000_030});
    db.applySubmissionStatus({versionId: v2.id, smokeStatus: 'passed', now: 1_760_000_030});

    const app = polka();
    const ctrl = arena.register(app, {
      db,
      arenaSecret: ARENA_SECRET,
      publicDir: tmpDir,
    });
    const srv = await startTestServer(app);
    try {
      const res = await apiJson(
        srv.baseUrl,
        'POST',
        '/api/arena/match-complete',
        ARENA_SECRET,
        {
          match: {
            id: 'gen3ou-000001',
            ladderId: 'gen3ou20261109',
            p1VersionId: v1.id,
            p2VersionId: v2.id,
            seed: 'sodium,1',
            game1Outcome: 'W',
            game2Outcome: 'W',
            category: 'WW',
            game1Turns: 10,
            game2Turns: 10,
            game1EndReason: 'win',
            game2EndReason: 'win',
            p1Game1PeakRam: 256,
            p1Game2PeakRam: 256,
            p2Game1PeakRam: 256,
            p2Game2PeakRam: 256,
            p1Game1BankSeconds: 120,
            p1Game2BankSeconds: 120,
            p2Game1BankSeconds: 120,
            p2Game2BankSeconds: 120,
            p1Game1MeanTurnMillis: 100,
            p1Game2MeanTurnMillis: 100,
            p2Game1MeanTurnMillis: 100,
            p2Game2MeanTurnMillis: 100,
            completedAt: 1_760_000_100,
          },
        }
      );
      expect(res.status).toBe(409);
    } finally {
      ctrl.close();
      await srv.close();
    }
  });

  test('ignores raw wire seriesLeftHtml on tournament broadcast updates', async () => {
    db.upsertTournament({
      id: '1',
      name: 'Tour 1',
      format: 'gen9ou',
      version: '0.11.0',
      startsAt: 1_760_000_000,
      status: 'running',
      gamesPerMatchup: 4,
      parallelTables: 2,
      hardware: 'L4',
    });
    const app = polka();
    const ctrl = arena.register(app, {
      db,
      arenaSecret: ARENA_SECRET,
      publicDir: tmpDir,
    });
    const srv = await startTestServer(app);
    try {
      const res = await apiJson(
        srv.baseUrl,
        'POST',
        '/api/arena/tournaments/1/broadcast',
        ARENA_SECRET,
        {
          table: 1,
          mode: 'load',
          seriesLeftHtml: '<img src=x onerror=alert(1)>',
          p1: {name: '0 ERROR', bankSeconds: 150, thinking: true, incrementSeconds: 10},
          p2: {name: 'Foul Play', bankSeconds: 150, thinking: false, incrementSeconds: 10},
          lines: ['|turn|1'],
        }
      );
      expect(res.status).toBe(200);
      const bcast = ctrl.getTournamentBroadcast('1');
      expect(bcast?.seriesLeftHtml).not.toContain('<img');
      expect(bcast?.seriesLeftHtml).toContain('0 ERROR');
    } finally {
      ctrl.close();
      await srv.close();
    }
  });

  test('computes Showdown HP percentages with boundary color rounding across generations', () => {
    const vgcFmt = 'gen9championsvgc2026regmc';
    expect(arena.computePokemonHealth(101, 201, vgcFmt)).toEqual({percent: 50, color: 'green'});
    expect(arena.computePokemonHealth(100, 200, vgcFmt)).toEqual({percent: 50, color: 'yellow'});
    expect(arena.computePokemonHealth(41, 201, vgcFmt)).toEqual({percent: 20, color: 'yellow'});
    expect(arena.computePokemonHealth(40, 200, vgcFmt)).toEqual({percent: 20, color: 'red'});
    expect(arena.computePokemonHealth(200, 201, vgcFmt)).toEqual({percent: 99, color: 'green'});
    expect(arena.computePokemonHealth(1, 201, vgcFmt)).toEqual({percent: 1, color: 'red'});

    expect(arena.computePokemonHealth(200, 201, 'gen9ou')).toEqual({percent: 99, color: 'green'});
    expect(arena.computePokemonHealth(100, 201, 'gen9ou')).toEqual({percent: 50, color: 'yellow'});
    expect(arena.computePokemonHealth(101, 201, 'gen9ou')).toEqual({percent: 51, color: 'green'});
    expect(arena.computePokemonHealth(40, 201, 'gen9ou')).toEqual({percent: 20, color: 'red'});

    expect(arena.computePokemonHealth(101, 201, 'gen1ou')).toEqual({percent: 50, color: 'green'});
    expect(arena.computePokemonHealth(100, 201, 'gen1ou')).toEqual({percent: 50, color: 'yellow'});
    expect(arena.computePokemonHealth(0, 200, 'gen1ou')).toEqual({percent: 0, color: 'fainted'});
  });

  test('shrinks VGC HP indicators from 6 in Team Preview to 4 after selection', () => {
    const previewP1 = [
      {ident: 'p1: Incineroar', condition: '200/200'},
      {ident: 'p1: Flutter Mane', condition: '130/130'},
      {ident: 'p1: Rillaboom', condition: '207/207'},
      {ident: 'p1: Urshifu', condition: '175/175'},
      {ident: 'p1: Raging Bolt', condition: '231/231'},
      {ident: 'p1: Amoonguss', condition: '221/221'},
    ];
    const previewP2 = [
      {ident: 'p2: Calyrex', condition: '175/175'},
      {ident: 'p2: Zamazenta', condition: '199/199'},
      {ident: 'p2: Chien-Pao', condition: '155/155'},
      {ident: 'p2: Ogerpon', condition: '187/187'},
      {ident: 'p2: Tornadus', condition: '186/186'},
      {ident: 'p2: Landorus', condition: '165/165'},
    ];
    const preview = arena.extractBattlePokemonHealth({
      format: 'gen9championsvgc2026regmc',
      lines: [
        `|request|${JSON.stringify({teamPreview: true, side: {id: 'p1', pokemon: previewP1}})}`,
        `|request|${JSON.stringify({teamPreview: true, side: {id: 'p2', pokemon: previewP2}})}`,
      ],
    });
    expect(preview.p1).toHaveLength(6);
    expect(preview.p2).toHaveLength(6);
    expect(preview.p1.every(m => m.percent === 100 && m.color === 'green')).toBe(true);

    const started = arena.extractBattlePokemonHealth({
      format: 'gen9championsvgc2026regmc',
      p1Pokemon: [
        {ident: 'p1: Incineroar', condition: '200/200', active: true},
        {ident: 'p1: Flutter Mane', condition: '39/130', active: true},
        {ident: 'p1: Rillaboom', condition: '207/207', active: false},
        {ident: 'p1: Amoonguss', condition: '221/221', active: false},
      ],
      p2Pokemon: [
        {ident: 'p2: Calyrex', condition: '175/175', active: true},
        {ident: 'p2: Chien-Pao', condition: '0 fnt', active: false},
        {ident: 'p2: Ogerpon', condition: '187/187', active: true},
        {ident: 'p2: Tornadus', condition: '186/186', active: false},
      ],
    });
    expect(started.p1).toEqual([
      {percent: 100, color: 'green'},
      {percent: 30, color: 'yellow'},
      {percent: 100, color: 'green'},
      {percent: 100, color: 'green'},
    ]);
    expect(started.p2).toEqual([
      {percent: 100, color: 'green'},
      {percent: 100, color: 'green'},
      {percent: 100, color: 'green'},
      {percent: 0, color: 'fainted'},
    ]);
  });

  test('swaps HP indicator positions when players switch Pokémon', () => {
    const beforeSwitch = arena.extractBattlePokemonHealth({
      format: 'gen9ou',
      p1Pokemon: [
        {ident: 'p1: Zoroark', condition: '36/240', active: true},
        {ident: 'p1: Kingambit', condition: '340/340', active: false},
        {ident: 'p1: Great Tusk', condition: '370/370', active: false},
        {ident: 'p1: Dragapult', condition: '317/317', active: false},
        {ident: 'p1: Gholdengo', condition: '315/315', active: false},
        {ident: 'p1: Ting-Lu', condition: '514/514', active: false},
      ],
    });
    expect(beforeSwitch.p1[0]).toEqual({percent: 15, color: 'red'});
    expect(beforeSwitch.p1[1]).toEqual({percent: 100, color: 'green'});

    // `@pkmn/sim` swaps `side.pokemon[0]` with `side.pokemon[1]` when Kingambit switches in
    const afterSwitch = arena.extractBattlePokemonHealth({
      format: 'gen9ou',
      p1Pokemon: [
        {ident: 'p1: Kingambit', condition: '340/340', active: true},
        {ident: 'p1: Zoroark', condition: '36/240', active: false},
        {ident: 'p1: Great Tusk', condition: '370/370', active: false},
        {ident: 'p1: Dragapult', condition: '317/317', active: false},
        {ident: 'p1: Gholdengo', condition: '315/315', active: false},
        {ident: 'p1: Ting-Lu', condition: '514/514', active: false},
      ],
    });
    expect(afterSwitch.p1).toEqual([
      {percent: 100, color: 'green'},
      {percent: 15, color: 'red'},
      {percent: 100, color: 'green'},
      {percent: 100, color: 'green'},
      {percent: 100, color: 'green'},
      {percent: 100, color: 'green'},
    ]);
  });

  test('moves fainted Pokémon right after replacement while keeping forceSwitch grey', () => {
    // 1. Active M3 faints (`forceSwitch` pending while bench has alive Pokémon): grey stays in 0
    const onForceSwitch = arena.extractBattlePokemonHealth({
      format: 'gen9ou',
      p1Pokemon: [
        {ident: 'p1: M3', condition: '0 fnt', active: true},
        {ident: 'p1: M2', condition: '40/100', active: false},
        {ident: 'p1: M1', condition: '80/100', active: false},
        {ident: 'p1: M4', condition: '100/100', active: false},
        {ident: 'p1: M5', condition: '30/100', active: false},
        {ident: 'p1: M6', condition: '15/100', active: false},
      ],
    });
    expect(onForceSwitch.p1.map(m => m.percent)).toEqual([0, 40, 80, 100, 30, 15]);

    // 2. Slot 2 (M2) switches in (`@pkmn/sim` swaps index 0 <-> 1): M2 -> slot 1, M3 -> slot 6
    const afterReplacement = arena.extractBattlePokemonHealth({
      format: 'gen9ou',
      p1Pokemon: [
        {ident: 'p1: M2', condition: '40/100', active: true},
        {ident: 'p1: M3', condition: '0 fnt', active: false},
        {ident: 'p1: M1', condition: '80/100', active: false},
        {ident: 'p1: M4', condition: '100/100', active: false},
        {ident: 'p1: M5', condition: '30/100', active: false},
        {ident: 'p1: M6', condition: '15/100', active: false},
      ],
    });
    expect(afterReplacement.p1.map(m => m.percent)).toEqual([40, 80, 100, 30, 15, 0]);

    // 3. Subsequent switch between active M2 and UI slot 4 (M5, at `@pkmn/sim` index 4):
    //    swaps UI slot 1 <-> UI slot 4 in-place while fainted M3 stays pinned at slot 6!
    const afterNextSwitch = arena.extractBattlePokemonHealth({
      format: 'gen9ou',
      p1Pokemon: [
        {ident: 'p1: M5', condition: '30/100', active: true},
        {ident: 'p1: M3', condition: '0 fnt', active: false},
        {ident: 'p1: M1', condition: '80/100', active: false},
        {ident: 'p1: M4', condition: '100/100', active: false},
        {ident: 'p1: M2', condition: '40/100', active: false},
        {ident: 'p1: M6', condition: '15/100', active: false},
      ],
    });
    expect(afterNextSwitch.p1.map(m => m.percent)).toEqual([30, 80, 100, 40, 15, 0]);
  });

  test('compacts unreplaceable fainted active slots on empty bench or finished summary', () => {
    // VGC 1v2 endgame: `p1a` fainted, `p1b` alive at 70%, bench empty -> `[70%, 0%, 0%, 0%]`
    const vgcSolo = arena.extractBattlePokemonHealth({
      format: 'gen9championsvgc2026regmc',
      p1Pokemon: [
        {ident: 'p1: Incineroar', condition: '0 fnt', active: true},
        {ident: 'p1: Flutter Mane', condition: '70/100', active: true},
        {ident: 'p1: Rillaboom', condition: '0 fnt', active: false},
        {ident: 'p1: Amoonguss', condition: '0 fnt', active: false},
      ],
    });
    expect(vgcSolo.p1.map(m => m.percent)).toEqual([70, 0, 0, 0]);

    // Finished Game 1 summary after timeout during `forceSwitch`: alive bench slides to front
    const finishedTimeout = arena.extractBattlePokemonHealth({
      format: 'gen9ou',
      finished: true,
      p1Pokemon: [
        {ident: 'p1: M1', condition: '0 fnt', active: true},
        {ident: 'p1: M2', condition: '62/100', active: false},
        {ident: 'p1: M3', condition: '0 fnt', active: false},
        {ident: 'p1: M4', condition: '29/100', active: false},
        {ident: 'p1: M5', condition: '0 fnt', active: false},
        {ident: 'p1: M6', condition: '0 fnt', active: false},
      ],
    });
    expect(finishedTimeout.p1.map(m => m.percent)).toEqual([62, 29, 0, 0, 0, 0]);
  });

  test('exposes sanitized HP indicators on pools heartbeats without leaking logs', async () => {
    const app = polka();
    const ctrl = arena.register(app, {
      db,
      arenaSecret: ARENA_SECRET,
      publicDir: tmpDir,
    });
    const srv = await startTestServer(app);
    try {
      const client = new arena.Client({
        serverUrl: srv.baseUrl,
        arenaSecret: ARENA_SECRET,
      });
      await client.sendHeartbeat({
        heartbeatSeq: 10,
        matchId: 'vgc-0000123',
        ladderId: 'gen9championsvgc2026regmc20261109',
        format: 'gen9championsvgc2026regmc',
        game: 2,
        turn: 4,
        activeSlot: 'p2',
        turnStartedAt: 1_760_000_200,
        turnBudgetSeconds: 140,
        incrementSeconds: 25,
        game1Summary: {
          winnerSlot: 'p1',
          turns: 9,
          endReason: 'win',
          p1: {bankSeconds: 144, meanTurnMillis: 260, ram: 810, team: 'P1:aabbccddeeff'},
          p2: {bankSeconds: 132, meanTurnMillis: 295, ram: 920, team: '112233445566'},
          viewer: {
            p1: {
              pokemon: [
                {ident: 'p1: Incineroar', condition: '200/200'},
                {ident: 'p1: Flutter Mane', condition: '98/100'},
                {ident: 'p1: Rillaboom', condition: '207/207'},
                {ident: 'p1: Amoonguss', condition: '221/221'},
              ],
            },
            p2: {
              pokemon: [
                {ident: 'p2: Calyrex', condition: '0 fnt'},
                {ident: 'p2: Chien-Pao', condition: '0 fnt'},
                {ident: 'p2: Ogerpon', condition: '0 fnt'},
                {ident: 'p2: Tornadus', condition: '0 fnt'},
              ],
            },
          },
        },
        // Game 2 swaps seats: Showdown p1 is Foul Play (Match P2), p2 is 0 ERROR (Match P1)
        viewer: {
          p1: {
            pokemon: [
              {ident: 'p1: Incineroar', condition: '40/200'},
              {ident: 'p1: Flutter Mane', condition: '130/130'},
              {ident: 'p1: Rillaboom', condition: '207/207'},
              {ident: 'p1: Amoonguss', condition: '221/221'},
            ],
          },
          p2: {
            pokemon: [
              {ident: 'p2: Calyrex', condition: '196/200'},
              {ident: 'p2: Chien-Pao', condition: '155/155'},
              {ident: 'p2: Ogerpon', condition: '187/187'},
              {ident: 'p2: Tornadus', condition: '186/186'},
            ],
          },
        },
        p1: {
          slug: '0-error',
          name: '0 ERROR',
          version: '1.0.0',
          bankSeconds: 138,
          lastTurnMillis: 250,
          meanTurnMillis: 255,
          ram: 820,
          team: '112233445566',
        },
        p2: {
          slug: 'foul-play',
          name: 'Foul Play',
          version: '1.0.0',
          bankSeconds: 136,
          lastTurnMillis: 280,
          meanTurnMillis: 290,
          ram: 940,
          team: 'P1:aabbccddeeff',
        },
      });

      const doc = ctrl.getLiveDocument(1_760_000_202);
      const serialized = JSON.stringify(doc);
      expect(doc.live?.viewer).toBeUndefined();
      expect(serialized).not.toContain('Incineroar');
      expect(serialized).not.toContain('Flutter Mane');
      expect(serialized).not.toContain('Calyrex');
      expect((doc.live?.game1Summary as Record<string, unknown> | undefined)?.viewer)
        .toBeUndefined();

      // Match P1 (0 ERROR) was Showdown p2 in Game 2 (`196/200` -> 98% green)
      expect(doc.live?.p1.pokemon?.[0]).toEqual({percent: 98, color: 'green'});
      expect(doc.live?.p1.pokemon).toHaveLength(4);
      // Match P2 (Foul Play) was Showdown p1 in Game 2 (`40/200` -> 20% red)
      expect(doc.live?.p2.pokemon?.[0]).toEqual({percent: 20, color: 'red'});
      expect(doc.live?.p2.pokemon).toHaveLength(4);
      // Game 1 summary retains Game 1 stats and sanitized final HP orbs
      expect(doc.live?.game1Summary?.p1?.pokemon).toEqual([
        {percent: 100, color: 'green'},
        {percent: 98, color: 'green'},
        {percent: 100, color: 'green'},
        {percent: 100, color: 'green'},
      ]);
      expect(doc.live?.game1Summary?.p2?.pokemon?.[0]).toEqual({percent: 0, color: 'fainted'});
    } finally {
      ctrl.close();
      await srv.close();
    }
  });

  test('nginx upstream keepalive_timeout stays below Node keepAliveTimeout', () => {
    const conf = fs.readFileSync(root('config', 'nginx.conf'), 'utf8');
    const upstreamIdx = conf.indexOf('upstream pkmn_node {');
    expect(upstreamIdx).toBeGreaterThanOrEqual(0);
    const upstreamBlock = conf.slice(upstreamIdx, conf.indexOf('}', upstreamIdx) + 1);
    const match = /\bkeepalive_timeout\s+(\d+)s;/.exec(upstreamBlock);
    expect(match).not.toBeNull();
    const nginxTimeoutMillis = Number(match![1]) * 1000;
    expect(nginxTimeoutMillis).toBeGreaterThan(0);
    expect(nginxTimeoutMillis).toBeLessThan(KEEP_ALIVE_TIMEOUT_MILLIS);
    expect(HEADERS_TIMEOUT_MILLIS).toBeGreaterThan(KEEP_ALIVE_TIMEOUT_MILLIS);
  });

  test('nginx nests 512m ladder archive location inside ^~ /api/arena/', () => {
    const conf = fs.readFileSync(root('config', 'nginx.conf'), 'utf8');
    const apiArenaIdx = conf.indexOf('location ^~ /api/arena/ {');
    const archiveIdx = conf.indexOf('location ~ ^/api/arena/ladders/[^/]+/archive$ {');
    expect(apiArenaIdx).toBeGreaterThan(0);
    expect(archiveIdx).toBeGreaterThan(apiArenaIdx);
    const between = conf.slice(apiArenaIdx, archiveIdx);
    const openBraces = (between.match(/\{/g) ?? []).length;
    const closeBraces = (between.match(/\}/g) ?? []).length;
    expect(openBraces - closeBraces).toBe(1);
    const archiveBlock = conf.slice(archiveIdx, conf.indexOf('}', archiveIdx) + 1);
    expect(archiveBlock).toContain('client_max_body_size 512m;');
    expect(archiveBlock).toContain('proxy_request_buffering off;');
  });

  test('nginx nests SSE tournament stream inside buffered ^~ /api/tournaments/', () => {
    const conf = fs.readFileSync(root('config', 'nginx.conf'), 'utf8');
    const apiToursIdx = conf.indexOf('location ^~ /api/tournaments/ {');
    const streamMatch = /location ~ (\^\/api\/tournaments\/[^ ]+) \{/.exec(
      conf.slice(apiToursIdx)
    );
    expect(apiToursIdx).toBeGreaterThan(0);
    expect(streamMatch).not.toBeNull();
    const streamRe = new RegExp(streamMatch![1]);
    expect(streamRe.test('/api/tournaments/1/stream')).toBe(true);
    expect(streamRe.test('/api/tournaments/1/stream/')).toBe(true);
    expect(streamRe.test('/api/tournaments/1/games.json')).toBe(false);
    const streamIdx = apiToursIdx + streamMatch!.index;
    const parentPrefix = conf.slice(apiToursIdx, streamIdx);
    expect(parentPrefix).not.toContain('gzip off;');
    expect(parentPrefix).not.toContain('proxy_buffering off;');
    expect(parentPrefix).not.toContain('limit_conn sse_conn');
    const openBraces = (parentPrefix.match(/\{/g) ?? []).length;
    const closeBraces = (parentPrefix.match(/\}/g) ?? []).length;
    expect(openBraces - closeBraces).toBe(1);
    const streamBlock = conf.slice(streamIdx, conf.indexOf('}', streamIdx) + 1);
    expect(streamBlock).toContain('gzip off;');
    expect(streamBlock).toContain('proxy_buffering off;');
    expect(streamBlock).toContain('limit_conn sse_conn 8;');
  });

  test('nginx repeats HSTS in every location block declaring add_header', () => {
    const conf = fs.readFileSync(root('config', 'nginx.conf'), 'utf8');
    const locRe = /\blocation\b[^{]*\{/g;
    let match: RegExpExecArray | null;
    let checked = 0;
    const missingHsts: string[] = [];
    while ((match = locRe.exec(conf)) !== null) {
      let depth = 1;
      let i = match.index + match[0].length;
      while (i < conf.length && depth > 0) {
        if (conf[i] === '{') depth++;
        else if (conf[i] === '}') depth--;
        i++;
      }
      const block = conf.slice(match.index, i);
      if (/\badd_header\b/.test(block)) {
        checked++;
        if (!block.includes('add_header Strict-Transport-Security "max-age=63072000" always;')) {
          missingHsts.push(match[0].trim());
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(5);
    expect(missingHsts).toEqual([]);
  });

  test('nginx disables 30d caching on daily-overwritten .tar archives', () => {
    const conf = fs.readFileSync(root('config', 'nginx.conf'), 'utf8');
    const tarIdx = conf.indexOf('location ~* \\.tar$ {');
    const sevenZIdx = conf.indexOf('location ~* \\.7z$ {');
    expect(tarIdx).toBeGreaterThan(0);
    expect(sevenZIdx).toBeGreaterThan(0);
    const tarBlock = conf.slice(tarIdx, conf.indexOf('}', tarIdx) + 1);
    const sevenZBlock = conf.slice(sevenZIdx, conf.indexOf('}', sevenZIdx) + 1);
    expect(tarBlock).toContain('expires -1;');
    expect(tarBlock).not.toContain('add_header');
    expect(sevenZBlock).toContain('expires 30d;');
  });

  test('nginx hardens /arena/viewer/ CSP directives', () => {
    const conf = fs.readFileSync(root('config', 'nginx.conf'), 'utf8');
    const viewerIdx = conf.indexOf('location ^~ /arena/viewer/ {');
    expect(viewerIdx).toBeGreaterThan(0);
    const viewerBlock = conf.slice(viewerIdx, conf.indexOf('}', viewerIdx) + 1);
    expect(viewerBlock).toContain('sandbox allow-scripts;');
    expect(viewerBlock).toContain("frame-ancestors 'self';");
    expect(viewerBlock).toContain("base-uri 'none';");
    expect(viewerBlock).toContain("form-action 'none';");
  });

  test('nginx serves content-hashed base stylesheet as immutable before generic css/js', () => {
    const conf = fs.readFileSync(root('config', 'nginx.conf'), 'utf8');
    const hashedIdx = conf.indexOf('location ~ ^/index\\.[0-9a-f]+\\.css$ {');
    const genericIdx = conf.indexOf('location ~* \\.(css|js)$ {');
    expect(hashedIdx).toBeGreaterThan(0);
    expect(genericIdx).toBeGreaterThan(hashedIdx);
    const hashedBlock = conf.slice(hashedIdx, conf.indexOf('}', hashedIdx) + 1);
    expect(hashedBlock).toContain('Cache-Control "public, max-age=31536000, immutable"');
  });

  test('nginx serves project logos statically inside ^~ /projects/ with immutable cache', () => {
    const conf = fs.readFileSync(root('config', 'nginx.conf'), 'utf8');
    expect(conf).toContain('map $arg_v $logo_cache_control {');
    expect(conf).toContain('"~^[0-9a-f]{8}$" "public, max-age=31536000, immutable";');
    const projectsIdx = conf.indexOf('location ^~ /projects/ {');
    const rasterIdx = conf.indexOf('location ~ ^/projects/[^/]+\\.(?:png|webp|gif|jpe?g)$ {');
    const svgIdx = conf.indexOf('location ~ ^/projects/[^/]+\\.svg$ {');
    expect(projectsIdx).toBeGreaterThan(0);
    expect(rasterIdx).toBeGreaterThan(projectsIdx);
    expect(svgIdx).toBeGreaterThan(rasterIdx);
    const rasterBlock = conf.slice(rasterIdx, conf.indexOf('}', rasterIdx) + 1);
    const svgBlock = conf.slice(svgIdx, conf.indexOf('}', svgIdx) + 1);
    expect(rasterBlock).toContain('add_header Cache-Control $logo_cache_control always;');
    expect(rasterBlock).toContain('try_files $uri =404;');
    expect(svgBlock).toContain('add_header Cache-Control $logo_cache_control always;');
    expect(svgBlock).toContain(
      'add_header Content-Security-Policy ' +
      '"default-src \'none\'; style-src \'unsafe-inline\'; sandbox" always;'
    );
    expect(svgBlock).toContain('try_files $uri =404;');
  });

  test('retains locked seasonal rosters on settling pools ladders', async () => {
    const vgcId = 'gen9championsvgc2026regmc';
    const slugs = ['0-error', 'foul-play', 'pokechamp', 'metamon'];
    syncQualifiedProjects(
      db,
      undefined,
      1_760_000_000,
      `- name: PokeChamp
  active: 2026
  arena:
    owners:
      champ: champ.1003
`
    );

    const versionIds: number[] = [];
    for (let i = 0; i < slugs.length; i++) {
      const agent = db.getAgentBySlug(slugs[i])!;
      const packed = Array.from({length: 20}, (_, j) => `Team${i}_${j}||leftovers||tackle|||||||`);
      const v = db.createSubmission({
        agentId: agent.id,
        version: '1.0.0',
        package: 'bundle',
        url: `https://github.com/pkmn/${slugs[i]}.tar.zst`,
        sha256: String(i + 1).repeat(64),
        ladderIds: [vgcId],
        teamsByLadder: {[vgcId]: packed},
        now: 1_760_000_010 + i,
      });
      db.applySubmissionStatus({versionId: v.id, smokeStatus: 'passed', now: 1_760_000_020 + i});
      versionIds.push(v.id);
    }

    db.setLadderAnchor(vgcId, '0-error', '1.0.0', 1_760_000_030);
    db.rotateLadder({
      oldLadderId: vgcId,
      archivedName: 'VGC Reg M-C',
      next: {id: 'gen9championsvgc2026regmd', format: 'gen9championsvgc2026regmd'},
      now: 1_760_000_050,
    });
    expect(db.getLadder(vgcId)?.status).toBe('settling');

    // Quarantine 2 of the 4 agents, leaving 2 active agents with 4 locked seasonal rosters.
    db.quarantineVersion('pokechamp', '1.0.0', 'crash', 1_760_000_060);
    db.quarantineVersion('metamon', '1.0.0', 'crash', 1_760_000_061);
    expect(db.getLadder(vgcId)?.status).toBe('settling');

    const app = polka();
    const ctrl = arena.register(app, {db, arenaSecret: ARENA_SECRET, publicDir: tmpDir});
    const srv = await startTestServer(app);
    try {
      const res = await apiJson(srv.baseUrl, 'GET', '/api/arena/ladders', ARENA_SECRET);
      expect(res.status).toBe(200);
      const body = res.data as {
        ladders: Array<{
          id: string;
          status: string;
          min: number;
          entries: arena.LadderMatchStateInput['entries'];
          pairAggregates: arena.LadderMatchStateInput['pairs'];
          roster?: Array<{agentId: number; agentName: string; teams: string[]}>;
        }>;
      };
      const vgc = body.ladders.find(l => l.id === vgcId)!;
      expect(vgc).toBeDefined();
      expect(vgc.status).toBe('settling');
      expect(vgc.roster).toHaveLength(4);

      const state = arena.buildLadderMatchState({
        ladder: {id: vgc.id, status: 'settling', min: vgc.min},
        entries: vgc.entries,
        pairs: vgc.pairAggregates,
        rosterAgentIds: new Set(vgc.roster!.map(r => r.agentId)),
      });
      expect(state).toBeDefined();
      expect(state!.activeAgentIndices).toHaveLength(2);
      expect(versionIds).toHaveLength(4);
    } finally {
      ctrl.close();
      await srv.close();
    }
  });

  test('exposes quarantinedVersionIds on GET /api/arena/ladders', async () => {
    const a1 = db.getAgentBySlug('0-error')!;
    const v1 = db.createSubmission({
      agentId: a1.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://github.com/pkmn/z.tar.zst',
      sha256: SHA,
      ladderIds: ['gen1ou20261109'],
      now: 1_760_000_010,
    });
    db.applySubmissionStatus({versionId: v1.id, smokeStatus: 'passed', now: 1_760_000_020});
    db.quarantineVersion('0-error', '1.0.0', 'crash loop', 1_760_000_030);

    const app = polka();
    const ctrl = arena.register(app, {db, arenaSecret: ARENA_SECRET, publicDir: tmpDir});
    const srv = await startTestServer(app);
    try {
      const before = await apiJson(srv.baseUrl, 'GET', '/api/arena/ladders', ARENA_SECRET);
      expect(before.status).toBe(200);
      expect(before.data.quarantinedVersionIds).toContain(v1.id);
      expect(before.data.smokeCadence).toEqual({maxPerCycle: 1, everyCycles: 1});

      db.setSmokeCadence({maxPerCycle: 2, everyCycles: 4}, 1_760_000_035);
      db.unquarantineVersion('0-error', '1.0.0', 1_760_000_040);
      const after = await apiJson(srv.baseUrl, 'GET', '/api/arena/ladders', ARENA_SECRET);
      expect(after.status).toBe(200);
      expect(after.data.quarantinedVersionIds).not.toContain(v1.id);
      expect(after.data.activatedVersionIds).toContain(v1.id);
      expect(after.data.smokeCadence).toEqual({maxPerCycle: 2, everyCycles: 4});
    } finally {
      ctrl.close();
      await srv.close();
    }
  });

  test('exposes stagedVersionIds while scrubbing ladder authToken on staged',
    async () => {
      const a1 = db.getAgentBySlug('0-error')!;
      const v1 = db.createSubmission({
        agentId: a1.id,
        version: '2.0.0',
        package: 'bundle',
        url: 'https://github.com/pkmn/z-2.0.0.tar.zst',
        sha256: SHA,
        authTokenEncoding: encryptSecret('ghp_ladder_secret', AUTH_CFG.sessionSecret),
        ladderIds: ['gen1ou20261109'],
        now: 1_760_000_010,
      });
      db.applySubmissionStatus({versionId: v1.id, smokeStatus: 'staged', now: 1_760_000_020});
      // Ladder auth token is scrubbed immediately once diagnostic fetch completes.
      expect(db.getVersionById(v1.id)?.authTokenEncoding).toBeUndefined();

      const app = polka();
      const ctrl = arena.register(app, {
        db,
        arenaSecret: ARENA_SECRET,
        publicDir: tmpDir,
        auth: new auth.Auth({db, config: AUTH_CFG}),
      });
      const srv = await startTestServer(app);
      try {
        // Staged versions appear in stagedVersionIds (not activatedVersionIds) and return 409.
        const beforeSnap = await apiJson(srv.baseUrl, 'GET', '/api/arena/ladders', ARENA_SECRET);
        expect(beforeSnap.data.stagedVersionIds).toContain(v1.id);
        expect(beforeSnap.data.activatedVersionIds).not.toContain(v1.id);
        const stagedRes = await apiJson(
          srv.baseUrl, 'GET', `/api/arena/artifacts/${v1.id}`, ARENA_SECRET
        );
        expect(stagedRes.status).toBe(409);

        // Once activated, artifact metadata moves to activatedVersionIds without any authToken.
        db.activateStagedVersion({versionId: v1.id, agentId: a1.id, now: 1_760_000_030});
        const client = new arena.Client({serverUrl: srv.baseUrl, arenaSecret: ARENA_SECRET});
        const snap = await client.getPlayableLadders();
        expect(snap.activatedVersionIds).toContain(v1.id);
        expect(snap.stagedVersionIds).not.toContain(v1.id);

        const artifact = await client.getActivatedArtifact(v1.id);
        expect(artifact).toMatchObject({
          versionId: v1.id,
          agentSlug: '0-error',
          version: '2.0.0',
          package: 'bundle',
          sha256: SHA,
        });
        expect(artifact.authToken).toBeUndefined();
      } finally {
        ctrl.close();
        await srv.close();
      }
    });

  test('serves activated tournament OCI authToken until scrubbed by archived callback',
    async () => {
      db.upsertTournament({
        id: 't-art',
        name: 'Artifact Cup',
        format: 'gen9ou',
        version: '0.11.0',
        startsAt: 1_760_200_000,
        status: 'scheduled',
        gamesPerMatchup: 2,
        parallelTables: 1,
        hardware: 'L4',
      });
      const a1 = db.getAgentBySlug('0-error')!;
      const v1 = db.createSubmission({
        agentId: a1.id,
        version: '2.0.1',
        package: 'oci',
        url: 'ghcr.io/pkmn/z:2.0.1',
        sha256: SHA,
        authTokenEncoding: encryptSecret('ghp_tourney_secret', AUTH_CFG.sessionSecret),
        ladderIds: [],
        tournamentIds: ['t-art'],
        now: 1_760_000_010,
      });
      db.applySubmissionStatus({versionId: v1.id, smokeStatus: 'staged', now: 1_760_000_020});
      db.activateStagedVersion({versionId: v1.id, agentId: a1.id, now: 1_760_000_030});

      const app = polka();
      const ctrl = arena.register(app, {
        db,
        arenaSecret: ARENA_SECRET,
        publicDir: tmpDir,
        auth: new auth.Auth({db, config: AUTH_CFG}),
      });
      const srv = await startTestServer(app);
      try {
        const client = new arena.Client({serverUrl: srv.baseUrl, arenaSecret: ARENA_SECRET});
        const artifact = await client.getActivatedArtifact(v1.id);
        expect(artifact.authToken).toBe('ghp_tourney_secret');

        await client.markArtifactArchived(v1.id);
        expect(db.getVersionById(v1.id)?.authTokenEncoding).toBeUndefined();
        const afterArchive = await client.getActivatedArtifact(v1.id);
        expect(afterArchive.authToken).toBeUndefined();
      } finally {
        ctrl.close();
        await srv.close();
      }
    });

  test('GET /api/arena/artifacts/:id falls back to SESSION_SECRET without options.auth',
    async () => {
      const prevSecret = process.env.SESSION_SECRET;
      process.env.SESSION_SECRET = AUTH_CFG.sessionSecret;
      try {
        db.upsertTournament({
          id: 't-env',
          name: 'Env Cup',
          format: 'gen9ou',
          version: '0.11.0',
          startsAt: 1_760_200_000,
          status: 'scheduled',
          gamesPerMatchup: 2,
          parallelTables: 1,
          hardware: 'L4',
        });
        const a1 = db.getAgentBySlug('0-error')!;
        const v1 = db.createSubmission({
          agentId: a1.id,
          version: '2.1.0',
          package: 'oci',
          url: 'ghcr.io/pkmn/z:2.1.0',
          sha256: SHA,
          authTokenEncoding: encryptSecret('ghp_env_fallback', AUTH_CFG.sessionSecret),
          ladderIds: [],
          tournamentIds: ['t-env'],
          now: 1_760_000_010,
        });
        db.applySubmissionStatus({versionId: v1.id, smokeStatus: 'staged', now: 1_760_000_020});
        db.activateStagedVersion({versionId: v1.id, agentId: a1.id, now: 1_760_000_030});

        const app = polka();
        const ctrl = arena.register(app, {db, arenaSecret: ARENA_SECRET, publicDir: tmpDir});
        const srv = await startTestServer(app);
        try {
          const client = new arena.Client({serverUrl: srv.baseUrl, arenaSecret: ARENA_SECRET});
          const artifact = await client.getActivatedArtifact(v1.id);
          expect(artifact.authToken).toBe('ghp_env_fallback');
        } finally {
          ctrl.close();
          await srv.close();
        }
      } finally {
        if (prevSecret === undefined) delete process.env.SESSION_SECRET;
        else process.env.SESSION_SECRET = prevSecret;
      }
    });

  test('broadcast off completion triggers onUpdate plus live battle stream', async () => {
    db.upsertTournament({
      id: '2',
      name: 'Tour 2',
      format: 'gen9ou',
      version: '0.11.0',
      startsAt: 1_760_000_000,
      status: 'running',
      gamesPerMatchup: 2,
      parallelTables: 1,
      hardware: 'L4',
    });
    const updates: string[] = [];
    const app = polka();
    const ctrl = arena.register(app, {
      db,
      arenaSecret: ARENA_SECRET,
      publicDir: tmpDir,
      onUpdate: kind => {
        updates.push(kind);
      },
    });
    const srv = await startTestServer(app);
    const sse = await openPersistentSse(srv.baseUrl, '/api/battles/stream');
    try {
      const snap = await sse.waitForEvent('snapshot');
      expect(snap.data.runningTournament).toBeDefined();

      const res = await apiJson(
        srv.baseUrl,
        'POST',
        '/api/arena/tournaments/2/broadcast',
        ARENA_SECRET,
        {off: true, tournamentStatus: 'completed'}
      );
      expect(res.status).toBe(200);
      expect(updates).toContain('tournament-status');

      const liveEvt = await sse.waitForEvent('live');
      expect(liveEvt.data.runningTournament).toBeUndefined();
    } finally {
      await sse.close();
      ctrl.close();
      await srv.close();
    }
  });

  test('accepts multi-game tournament game-complete payloads exceeding 1 MiB', async () => {
    const a1 = db.getAgentBySlug('0-error')!;
    const a2 = db.getAgentBySlug('foul-play')!;
    const v1 = db.createSubmission({
      agentId: a1.id,
      version: '1.0.0',
      package: 'oci',
      url: 'ghcr.io/pkmn/a:1',
      sha256: 'a'.repeat(64),
      ladderIds: ['gen1ou20261109'],
      now: 1_760_000_000,
    });
    const v2 = db.createSubmission({
      agentId: a2.id,
      version: '1.0.0',
      package: 'oci',
      url: 'ghcr.io/pkmn/b:1',
      sha256: 'b'.repeat(64),
      ladderIds: ['gen1ou20261109'],
      now: 1_760_000_000,
    });
    db.upsertTournament({
      id: '3',
      name: 'Bo3 Tour',
      format: 'gen9ou@@@Best of = 3',
      version: '0.11.0',
      startsAt: 1_760_000_000,
      status: 'running',
      gamesPerMatchup: 2,
      parallelTables: 1,
      hardware: 'L4',
    });
    db.upsertTournamentEntrant({tournamentId: '3', agentId: a1.id, versionId: v1.id, seed: 1});
    db.upsertTournamentEntrant({tournamentId: '3', agentId: a2.id, versionId: v2.id, seed: 2});
    const app = polka();
    const ctrl = arena.register(app, {db, arenaSecret: ARENA_SECRET, publicDir: tmpDir});
    const srv = await startTestServer(app);
    try {
      const logChunk = `${'|turn|1\n'.repeat(50_000)}`; // ~400 KiB each -> ~1.2 MiB total
      const res = await apiJson(
        srv.baseUrl,
        'POST',
        '/api/arena/tournaments/3/game-complete',
        ARENA_SECRET,
        {
          game: {
            id: 'tour3-g0001',
            stage: 'Round Robin',
            cycle: 1,
            matchupGame: 1,
            outcome: 'W',
            p1: {versionId: v1.id},
            p2: {versionId: v2.id},
            games: [1, 2, 3].map(gameNumber => ({
              gameNumber,
              seed: `1,2,3,${gameNumber}`,
              outcome: gameNumber === 2 ? 'L' : 'W',
              turns: 20,
              endReason: 'win',
              p1: {bankSeconds: 120, meanTurnMillis: 100, peakRam: 128},
              p2: {bankSeconds: 120, meanTurnMillis: 100, peakRam: 128},
            })),
            completedAt: 1_760_000_100,
          },
          logs: [logChunk, logChunk, logChunk],
        }
      );
      expect(res.status).toBe(200);
      expect(
        fs.existsSync(path.join(tmpDir, 'arena', 'tournaments', '3', 'tour3-g0001-g3.log'))
      ).toBe(true);
    } finally {
      ctrl.close();
      await srv.close();
    }
  });

  test('POST /api/arena/alert dispatches Bearer-authenticated alerts via Client.sendAlert',
    async () => {
      const received: arena.StaffAlertPayload[] = [];
      const app = polka();
      const ctrl = arena.register(app, {
        db,
        arenaSecret: ARENA_SECRET,
        publicDir: tmpDir,
        now: () => 1_760_005_000,
        onStaffAlert: alert => {
          received.push(alert);
        },
      });
      const srv = await startTestServer(app);
      try {
        const unauth = await fetch(`${srv.baseUrl}/api/arena/alert`, {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({key: 'test', message: 'nope'}),
        });
        expect(unauth.status).toBe(401);

        const client = new arena.Client({serverUrl: srv.baseUrl, arenaSecret: ARENA_SECRET});
        const res = await client.sendAlert({
          key: 'arena-archive',
          message: 'Nightly arena archive failed (exit 1)',
          detail: 'Operation not permitted',
        });
        expect(res).toEqual({ok: true});
        expect(received).toEqual([{
          key: 'arena-archive',
          message: 'Nightly arena archive failed (exit 1)',
          detail: 'Operation not permitted',
        }]);
        expect(ctrl.getState().lastContactAt).toBe(1_760_005_000);
      } finally {
        ctrl.close();
        await srv.close();
      }
    });

  test('fires live match/tournament callbacks once per active game while exposing active state',
    async () => {
      const liveMatches: string[] = [];
      const liveTourneyGames: arena.LiveTournamentGame[] = [];
      db.upsertTournament({
        id: 't-watch',
        name: 'Watch Cup',
        format: 'gen9championsvgc2026regmc',
        version: '0.11.0',
        gamesPerMatchup: 2,
        parallelTables: 2,
        hardware: 'L4',
        status: 'running',
        startsAt: 1_760_000_000,
      });

      const app = polka();
      const ctrl = arena.register(app, {
        db,
        arenaSecret: ARENA_SECRET,
        publicDir: tmpDir,
        now: () => 1_760_006_000,
        onLiveMatch: match => {
          liveMatches.push(match.matchId);
        },
        onLiveTournamentGame: game => {
          liveTourneyGames.push(game);
        },
      });
      const srv = await startTestServer(app);
      try {
        const client = new arena.Client({serverUrl: srv.baseUrl, arenaSecret: ARENA_SECRET});
        const baseSlot = (slug: string, name: string) => ({
          slug,
          name,
          version: '1.0',
          bankSeconds: 150,
          lastTurnMillis: 100,
          meanTurnMillis: 100,
          ram: 256,
        });

        // Match 1: Turn 1, Turn 2, Game 2 -> fires onLiveMatch once.
        await client.sendHeartbeat({
          heartbeatSeq: 1,
          matchId: 'm-watch-1',
          ladderId: 'gen1ou20261109',
          format: 'gen1ou',
          game: 1,
          turn: 1,
          turnStartedAt: 1_760_006_000,
          turnBudgetSeconds: 150,
          incrementSeconds: 10,
          p1: baseSlot('0-error', '0 ERROR'),
          p2: baseSlot('foul-play', 'Foul Play'),
        });
        await client.sendHeartbeat({
          heartbeatSeq: 2,
          matchId: 'm-watch-1',
          ladderId: 'gen1ou20261109',
          format: 'gen1ou',
          game: 2,
          turn: 1,
          turnStartedAt: 1_760_006_010,
          turnBudgetSeconds: 150,
          incrementSeconds: 10,
          p1: baseSlot('0-error', '0 ERROR'),
          p2: baseSlot('foul-play', 'Foul Play'),
        });
        // Match 2 -> fires again.
        await client.sendHeartbeat({
          heartbeatSeq: 3,
          matchId: 'm-watch-2',
          ladderId: 'gen1ou20261109',
          format: 'gen1ou',
          game: 1,
          turn: 1,
          turnStartedAt: 1_760_006_020,
          turnBudgetSeconds: 150,
          incrementSeconds: 10,
          p1: baseSlot('0-error', '0 ERROR'),
          p2: baseSlot('foul-play', 'Foul Play'),
        });
        expect(liveMatches).toEqual(['m-watch-1', 'm-watch-2']);

        // Tournament broadcast: load g1, append g1, load g1 game 2 (same gameId) -> fires once.
        const tPlayer = (slug: string, name: string) => ({
          slug,
          name,
          version: '1.0',
          bankSeconds: 150,
          thinking: true,
          incrementSeconds: 10,
        });
        await client.sendTournamentBroadcast('t-watch', {
          table: 2,
          mode: 'load',
          label: 'Table 2',
          gameId: 'tw-g1',
          stage: 'Round Robin',
          game: 1,
          bestOf: 3,
          p1: tPlayer('0-error', '0 ERROR'),
          p2: tPlayer('foul-play', 'Foul Play'),
          lines: ['|turn|1'],
        });
        await client.sendTournamentBroadcast('t-watch', {
          table: 2,
          mode: 'append',
          lines: ['|turn|2'],
        });
        await client.sendTournamentBroadcast('t-watch', {
          table: 2,
          mode: 'load',
          label: 'Table 2',
          gameId: 'tw-g1',
          stage: 'Round Robin',
          game: 2,
          bestOf: 3,
          p1: tPlayer('0-error', '0 ERROR'),
          p2: tPlayer('foul-play', 'Foul Play'),
          lines: ['|turn|1'],
        });
        expect(liveTourneyGames).toHaveLength(1);
        expect(liveTourneyGames[0]).toMatchObject({
          tournamentId: 't-watch',
          tournamentName: 'Watch Cup',
          table: 2,
          gameId: 'tw-g1',
          stage: 'Round Robin',
        });
        expect(ctrl.getActiveTournamentGames()).toHaveLength(1);

        // Next game on Table 2 fires again; going idle clears active games.
        await client.sendTournamentBroadcast('t-watch', {
          table: 2,
          mode: 'load',
          label: 'Table 2',
          gameId: 'tw-g2',
          stage: 'Superfinal',
          p1: tPlayer('foul-play', 'Foul Play'),
          p2: tPlayer('0-error', '0 ERROR'),
          lines: ['|turn|1'],
        });
        expect(liveTourneyGames.map(g => g.gameId)).toEqual(['tw-g1', 'tw-g2']);

        await client.sendTournamentBroadcast('t-watch', {table: 2, idle: true});
        expect(ctrl.getActiveTournamentGames()).toEqual([]);
      } finally {
        ctrl.close();
        await srv.close();
      }
    });
});
