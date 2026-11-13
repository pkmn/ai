import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import polka from 'polka';

import {Database} from '../db';
import {encryptSecret} from '../server/account';
import * as arena from '../server/arena';
import * as auth from '../server/auth';
import {generateValidHarvestedTeams} from '../tools/mock';
import {parseArgs, runPkmnCli} from '../tools/pkmn';

const AUTH_CFG: auth.Config = {
  sessionSecret: 'test-arena-session-secret',
  arenaSecret: 'test-arena-bearer-secret',
};

const PROJECTS_YAML = `
- name: 0 ERROR
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
- name: Metamon
  active: 2026
  arena:
    qualified: true
    owners:
      jake: jake.77777
`;

const LADDERS_YAML = `
- name: RBY
  format: gen1ou
  id: gen1ou20261109
  team: harvested
  status: active
- name: VGC
  format: gen9championsvgc2026regmc
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
  let db: Database;
  let ctrl: ReturnType<typeof arena.register>;
  let srv: {baseUrl: string; close: () => Promise<void>};
  let events: string[];

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-arena-sub-'));
    db = new Database(':memory:');
    db.syncLaddersFromYaml(LADDERS_YAML, 1_700_000_000);
    db.syncProjectsFromYaml(PROJECTS_YAML, tmpDir, 1_700_000_000);
    events = [];
    const app = polka();
    ctrl = arena.register(app, {
      db,
      auth: new auth.Auth({db, config: AUTH_CFG}),
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
        AUTH_CFG.arenaSecret
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
      AUTH_CFG.arenaSecret,
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
      AUTH_CFG.arenaSecret,
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
    await apiJson(srv.baseUrl, 'POST', '/api/arena/submission-status', AUTH_CFG.arenaSecret, {
      versionId: sub1.id,
      smokeStatus: 'passed',
    });
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
    await apiJson(srv.baseUrl, 'POST', '/api/arena/submission-status', AUTH_CFG.arenaSecret, {
      versionId: sub2.id,
      smokeStatus: 'passed',
    });
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
      AUTH_CFG.arenaSecret,
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
    db.syncProjectsFromYaml(PROJECTS_YAML, tmpDir, 1_760_000_000);

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
      arenaSecret: AUTH_CFG.arenaSecret,
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
      AUTH_CFG.arenaSecret,
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
    await apiJson(srv.baseUrl, 'POST', '/api/arena/heartbeat', AUTH_CFG.arenaSecret, baseHeartbeat);
    fakeNow = 1_760_001_004;
    await apiJson(srv.baseUrl, 'POST', '/api/arena/heartbeat', AUTH_CFG.arenaSecret, {
      ...baseHeartbeat,
      heartbeatSeq: 2,
    });
    expect((await fetchLive()).doc.live?.turnStartedAt).toBe(1_760_001_000);

    fakeNow = 1_760_001_009;
    await apiJson(srv.baseUrl, 'POST', '/api/arena/heartbeat', AUTH_CFG.arenaSecret, {
      ...baseHeartbeat,
      heartbeatSeq: 3,
      turn: 6,
      activeSlot: 'p2',
    });
    expect((await fetchLive()).doc.live?.turnStartedAt).toBe(1_760_001_009);
  });

  test('validates optional pool team short hashes on live heartbeat slots', async () => {
    const hbOk = await apiJson(
      srv.baseUrl,
      'POST',
      '/api/arena/heartbeat',
      AUTH_CFG.arenaSecret,
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

    const hbBad = await apiJson(
      srv.baseUrl,
      'POST',
      '/api/arena/heartbeat',
      AUTH_CFG.arenaSecret,
      {
        ...baseHeartbeat,
        heartbeatSeq: 2,
        p1: {...baseHeartbeat.p1, team: 'x'.repeat(65)},
      }
    );
    expect(hbBad.status).toBe(400);
  });

  test('fires disconnect watchdog alert once heartbeat exceeds timeout', async () => {
    await apiJson(srv.baseUrl, 'POST', '/api/arena/heartbeat', AUTH_CFG.arenaSecret, baseHeartbeat);
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
        AUTH_CFG.arenaSecret,
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
            p1PeakRam: 950,
            p2PeakRam: 1120,
            p1Game1BankSeconds: 145,
            p1Game2BankSeconds: 140,
            p2Game1BankSeconds: 138,
            p2Game2BankSeconds: 120,
            p1MeanTurnMillis: 310,
            p2MeanTurnMillis: 420,
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
    expect(doc.recentMatches).toHaveLength(45);
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
        p1PeakRam: 950,
        p2PeakRam: 1120,
        p1Game1BankSeconds: 145,
        p1Game2BankSeconds: 140,
        p2Game1BankSeconds: 138,
        p2Game2BankSeconds: 120,
        p1MeanTurnMillis: 310,
        p2MeanTurnMillis: 420,
        completedAt: fakeNow,
      },
    };
    const first = await apiJson(
      srv.baseUrl,
      'POST',
      '/api/arena/match-complete',
      AUTH_CFG.arenaSecret,
      payload
    );
    expect(first.data.duplicate).toBe(false);

    const second = await apiJson(
      srv.baseUrl,
      'POST',
      '/api/arena/match-complete',
      AUTH_CFG.arenaSecret,
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
    db.syncProjectsFromYaml(PROJECTS_YAML, tmpDir, 1_760_000_000);

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
      arenaSecret: AUTH_CFG.arenaSecret,
      sessionSecret: AUTH_CFG.sessionSecret,
      publicDir: tmpDir,
      now: () => 1_760_000_500,
    });
    srv = await startTestServer(app);
    client = new arena.Client({serverUrl: srv.baseUrl, arenaSecret: AUTH_CFG.arenaSecret!});
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
          p1PeakRam: 820,
          p2PeakRam: 960,
          p1Game1BankSeconds: 145,
          p1Game2BankSeconds: 142,
          p2Game1BankSeconds: 138,
          p2Game2BankSeconds: 130,
          p1MeanTurnMillis: 260,
          p2MeanTurnMillis: 310,
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
    expect((await fetch(`${srv.baseUrl}/api/tournament-live.json`)).status).toBe(404);
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

      const liveBroadcastRes = await fetch(`${srv.baseUrl}/api/tournament-live.json`);
      expect(liveBroadcastRes.status).toBe(200);
      const bcEtag = liveBroadcastRes.headers.get('etag')!;
      expect((await fetch(`${srv.baseUrl}/api/tournament-live.json`, {
        headers: {'If-None-Match': bcEtag},
      })).status).toBe(304);

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
      expect((await fetch(`${srv.baseUrl}/api/tournament-live.json`)).status).toBe(404);
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
        log: '|gametype|singles\n|player|p1|0 ERROR|1\n|player|p2|Foul Play|2\n|win|0 ERROR\n',
        game: {
          id: 't2-rr-g1',
          stage: 'Round Robin',
          cycle: 1,
          matchupGame: 1,
          p1VersionId: vZeroId,
          p2VersionId: vFpId,
          seed: '1,2,3,4',
          outcome: 'W',
          turns: 22,
          endReason: 'normal',
          p1BankSeconds: 140,
          p2BankSeconds: 120,
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
          p1VersionId: vZeroId,
          p2VersionId: vFpId,
          seed: '1,2,3,4',
          outcome: 'W',
          turns: 22,
          endReason: 'normal',
          p1BankSeconds: 140,
          p2BankSeconds: 120,
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
          p1VersionId: vFpId,
          p2VersionId: vMetaId,
          seed: '5,6,7,8',
          outcome: 'W',
          turns: 30,
          endReason: 'normal',
          p1BankSeconds: 130,
          p2BankSeconds: 110,
          completedAt: 1_760_000_600,
        },
      });
      expect(db.getTournament('2')?.status).toBe('completed');
      expect(db.getTournamentEntrants('2')[0].finalRank).toBe(1);
    } finally {
      await tourStream.close();
    }
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
    db.syncProjectsFromYaml(PROJECTS_YAML, undefined, 1_760_000_000);

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
        p1PeakRam: 800,
        p2PeakRam: 900,
        p1Game1BankSeconds: 140,
        p1Game2BankSeconds: 140,
        p2Game1BankSeconds: 140,
        p2Game2BankSeconds: 140,
        p1MeanTurnMillis: 200,
        p2MeanTurnMillis: 200,
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

    const finalRes = db.recordCompletedMatch({
      match: {
        id: 'gen1ou-0000000002',
        ladderId: 'gen1ou20261109',
        p1VersionId: vMeta.id,
        p2VersionId: vFpId,
        seed: 'sodium,2',
        game1Outcome: 'W',
        game2Outcome: 'L',
        category: 'WL',
        game1Turns: 30,
        game2Turns: 30,
        game1EndReason: 'normal',
        game2EndReason: 'normal',
        p1PeakRam: 700,
        p2PeakRam: 900,
        p1Game1BankSeconds: 140,
        p1Game2BankSeconds: 140,
        p2Game1BankSeconds: 140,
        p2Game2BankSeconds: 140,
        p1MeanTurnMillis: 200,
        p2MeanTurnMillis: 200,
        completedAt: 1_760_000_600,
      },
      ladderStatus: 'archived',
    });
    expect(finalRes.archivedLadder).toBe(true);
    expect(db.getLadder('gen1ou20261109')!.status).toBe('archived');
  });

  test('session mints valid cookie bound to developer numeric GitHub ID', async () => {
    db.linkDeveloperGitHubId('pre', 987654, 1_760_000_605);
    await runPkmnCli(
      ['session', '--github', 'pre', '--secret', AUTH_CFG.sessionSecret],
      {db, now: 1_760_000_610, log}
    );
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
        '--starts', '2026-12-01T00:00:00Z',
      ],
      {db, now: 1_760_000_615, log}
    )).rejects.toThrow(/Invalid tournament ID/);

    await expect(runPkmnCli(
      [
        'create-tournament', '4', '--name', 'Bad Fmt', '--format', 'notarealformat99',
        '--starts', '2026-12-01T00:00:00Z',
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

    await runPkmnCli(
      ['seed-tournament', '3', '--ladder', 'gen1ou20261109'],
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
    db.syncLaddersFromYaml(LADDERS_YAML, 1_700_000_000);
    db.syncProjectsFromYaml(PROJECTS_YAML, tmpDir, 1_700_000_000);
    db.upsertTournament({
      id: '3',
      name: 'Tournament #3: VGC 2026 Reg M-C OTS BO3',
      format: 'gen9championsvgc2026regmc',
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
      Authorization: `Bearer ${AUTH_CFG.arenaSecret}`,
      'Content-Type': 'application/x-7z-compressed',
    };
    if (shaHeader) headers['X-Content-SHA256'] = shaHeader;
    const res = await fetch(`${srv.baseUrl}${route}`, {method: 'PUT', headers, body: archiveBytes});
    return {status: res.status, data: await res.json() as Record<string, unknown>};
  };

  test('gates PUT /api/arena/tournaments/:id/archive on completed status plus SHA-256',
    async () => {
      expect((await putBinary('/api/arena/tournaments/3/archive')).status).toBe(409);

      db.setTournamentStatus('3', 'completed', 1_700_000_500);
      expect((await putBinary('/api/arena/tournaments/3/archive', '0'.repeat(64))).status)
        .toBe(400);

      const okTour = await putBinary('/api/arena/tournaments/3/archive', expectedSha);
      expect(okTour.status).toBe(200);
      expect(okTour.data.archiveHref).toBe('/arena/tournaments/3/3-replays.7z');
      expect(fs.readFileSync(path.join(tmpDir, 'arena', 'tournaments', '3', '3-replays.7z')))
        .toEqual(archiveBytes);
    });

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
      '/arena/ladders/gen9championsvgc2026regmc/gen9championsvgc2026regmc-logs.7z'
    );
    expect(events).toEqual(['archive-published']);
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
    db.syncProjectsFromYaml(PROJECTS_YAML, tmpDir, 1_700_000_000);

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
          p1PeakRam: 900,
          p2PeakRam: 950,
          p1Game1BankSeconds: 140,
          p1Game2BankSeconds: 138,
          p2Game1BankSeconds: 136,
          p2Game2BankSeconds: 132,
          p1MeanTurnMillis: 300,
          p2MeanTurnMillis: 320,
          completedAt: 1_700_000_100 + i * 10,
        },
      });
    }

    const app = polka();
    handle = arena.register(app, {
      db,
      arenaSecret: AUTH_CFG.arenaSecret,
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
    db.syncProjectsFromYaml(PROJECTS_YAML, tmpDir, 1_700_000_000);
    events = [];
    const app = polka();
    ctrl = arena.register(app, {
      db,
      auth: new auth.Auth({db, config: AUTH_CFG}),
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

  test('requires Bearer authentication on GET or PUT /api/arena/ladders/:id/teams', async () => {
    const client = new arena.Client({serverUrl: srv.baseUrl, arenaSecret: AUTH_CFG.arenaSecret!});
    const pending = await client.getPendingSubmissions();
    expect(pending.ladders.map(l => `${l.id}:${l.status}`)).toContain('gen1ou20261109:upcoming');

    expect((await fetch(`${srv.baseUrl}/api/arena/ladders/gen1ou20261109/teams`)).status).toBe(401);
    expect((await fetch(`${srv.baseUrl}/api/arena/ladders/gen1ou20261109/teams`, {
      method: 'PUT',
      headers: {'content-type': 'text/plain'},
      body: rbyPaste,
    })).status).toBe(401);
  });

  test('rejects non-harvested ladders or mirror-duplicate harvested teams with 400', async () => {
    expect((await fetch(`${srv.baseUrl}/api/arena/ladders/gen1ou20261109/teams`, {
      headers: {authorization: `Bearer ${AUTH_CFG.arenaSecret}`},
    })).status).toBe(404);

    expect((await fetch(`${srv.baseUrl}/api/arena/ladders/gen9championsvgc2026regmc/teams`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${AUTH_CFG.arenaSecret}`,
        'content-type': 'text/plain',
      },
      body: rbyPaste,
    })).status).toBe(400);

    const badTeamPut = await fetch(`${srv.baseUrl}/api/arena/ladders/gen1ou20261109/teams`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${AUTH_CFG.arenaSecret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({teams: [RBY_HARVESTED_TEAMS[0], RBY_HARVESTED_TEAMS[0]]}),
    });
    expect(badTeamPut.status).toBe(400);
    expect(((await badTeamPut.json()) as {error: string}).error).toContain('non-mirror');
  });

  test('uploads harvested pastes over HTTP with SHA-256 ETag 304 caching', async () => {
    const putRes = await fetch(`${srv.baseUrl}/api/arena/ladders/gen1ou20261109/teams`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${AUTH_CFG.arenaSecret}`,
        'content-type': 'text/plain; charset=utf-8',
      },
      body: rbyPaste,
    });
    expect(putRes.status).toBe(200);
    const putJson = await putRes.json() as arena.LadderTeamsUploadResponse;
    expect(putJson.ok).toBe(true);
    expect(putJson.count).toBe(4);
    expect(events).toEqual(['ladder-teams']);

    const getRes = await fetch(`${srv.baseUrl}/api/arena/ladders/gen1ou20261109/teams`, {
      headers: {authorization: `Bearer ${AUTH_CFG.arenaSecret}`},
    });
    expect(getRes.status).toBe(200);
    const etag = getRes.headers.get('etag')!;
    expect(etag).toBe(`"${putJson.sha256}"`);
    expect(((await getRes.json()) as arena.LadderTeamsResponse).teams).toHaveLength(4);

    const cachedRes = await fetch(`${srv.baseUrl}/api/arena/ladders/gen1ou20261109/teams`, {
      headers: {
        authorization: `Bearer ${AUTH_CFG.arenaSecret}`,
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
