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
import {runPkmnCli} from '../tools/pkmn';

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
  min: 3
  teams: 20
`;

const SHA = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

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
    close: () => new Promise<void>((resolve, reject) => {
      server.close(err => (err ? reject(err) : resolve()));
    }),
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

describe('Arena Control API, live.json, watchdog & ratings pipeline', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-arena-api-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  test('enforces Bearer secret, submission lifecycle, and 3rd-version retirement', async () => {
    const db = new Database(':memory:');
    db.syncLaddersFromYaml(LADDERS_YAML, 1_700_000_000);
    db.syncProjectsFromYaml(PROJECTS_YAML, tmpDir, 1_700_000_000);

    const authInstance = new auth.Auth({db, config: AUTH_CFG});
    const app = polka();
    const events: string[] = [];
    const ctrl = arena.register(app, {
      db,
      auth: authInstance,
      publicDir: tmpDir,
      onUpdate: reason => {
        events.push(reason);
      },
    });
    const srv = await startTestServer(app);

    try {
      const unauth = await apiJson(srv.baseUrl, 'GET', '/api/arena/pending-submissions');
      expect(unauth.status).toBe(401);

      const wrong = await apiJson(
        srv.baseUrl,
        'GET',
        '/api/arena/pending-submissions',
        'wrong-secret'
      );
      expect(wrong.status).toBe(401);

      const zeroAgent = db.getAgentBySlug('0-error')!;
      const dev = db.getDeveloperByGitHub('pre')!;
      const vgcTeams = Array.from({length: 20}, (_, idx) => `packed-team-${idx + 1}`);

      const sub1 = db.createSubmission({
        agentId: zeroAgent.id,
        developerId: dev.id,
        version: '1.0.0',
        package: 'bundle',
        url: 'https://example.com/0-error-1.0.0.tar.zst',
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

      // Verify team_index is 1..20
      const slots = db.db.prepare(
        `SELECT MIN(team_index) AS minSlot, MAX(team_index) AS maxSlot
         FROM agent_ladder_teams WHERE agent_id = ?`
      ).get(zeroAgent.id) as {minSlot: number; maxSlot: number};
      expect(slots).toEqual({minSlot: 1, maxSlot: 20});

      // Fail smoke test on Foul Play -> wipes token, drops pending VGC teams, keeps Eligible
      const fpAgent = db.getAgentBySlug('foul-play')!;
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

      // Pass smoke test on 0 ERROR 1.0.0 -> wipes token, activates VGC teams, adds champion entry
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

      // Settle 1.0.0, advance past 14d cooldown, submit 1.1.0, settle 1.1.0 with higher rating,
      // then submit 1.2.0 -> 1.0.0 (weaker) is automatically retired!
      db.db.prepare(
        `UPDATE ladder_entries
         SET elo = 1520, se = 20, lcb = 1480.8, matches = 30, settled_at = 1700500000
         WHERE version_id = ?`
      ).run(sub1.id);

      const sub2 = db.createSubmission({
        agentId: zeroAgent.id,
        developerId: dev.id,
        version: '1.1.0',
        package: 'bundle',
        url: 'https://example.com/0-error-1.1.0.tar.zst',
        sha256: SHA,
        ladderIds: ['gen1ou20261109'],
        now: 1_702_000_000,
      });
      await apiJson(
        srv.baseUrl,
        'POST',
        '/api/arena/submission-status',
        AUTH_CFG.arenaSecret,
        {versionId: sub2.id, smokeStatus: 'passed'}
      );
      db.db.prepare(
        `UPDATE ladder_entries
         SET elo = 1650, se = 18, lcb = 1614.7, matches = 32, settled_at = 1702500000
         WHERE version_id = ?`
      ).run(sub2.id);

      const sub3 = db.createSubmission({
        agentId: zeroAgent.id,
        developerId: dev.id,
        version: '1.2.0',
        package: 'bundle',
        url: 'https://example.com/0-error-1.2.0.tar.zst',
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
      expect(events.length).toBeGreaterThanOrEqual(4);
    } finally {
      ctrl.close();
      await srv.close();
      db.close();
    }
  });

  test('streams live.json, fires watchdog, and settles ratings + reigns', async () => {
    const db = new Database(':memory:');
    db.syncLaddersFromYaml(LADDERS_YAML, 1_760_000_000);
    db.syncProjectsFromYaml(PROJECTS_YAML, tmpDir, 1_760_000_000);

    const zeroAgent = db.getAgentBySlug('0-error')!;
    const fpAgent = db.getAgentBySlug('foul-play')!;

    const vZero = db.createSubmission({
      agentId: zeroAgent.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://example.com/0-error-1.0.0.tar.zst',
      sha256: SHA,
      ladderIds: ['gen1ou20261109'],
      now: 1_760_000_010,
    });
    const vFp = db.createSubmission({
      agentId: fpAgent.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://example.com/fp-1.0.0.tar.zst',
      sha256: SHA,
      ladderIds: ['gen1ou20261109'],
      now: 1_760_000_020,
    });
    db.applySubmissionStatus({versionId: vZero.id, smokeStatus: 'passed', now: 1_760_000_030});
    db.applySubmissionStatus({versionId: vFp.id, smokeStatus: 'passed', now: 1_760_000_030});
    db.setLadderAnchor('gen1ou20261109', 'foul-play', '1.0.0', 1_760_000_035);

    let fakeNow = 1_760_001_000;
    const watchdogAlerts: arena.WatchdogAlert[] = [];
    const app = polka();
    const ctrl = arena.register(app, {
      db,
      arenaSecret: AUTH_CFG.arenaSecret,
      sessionSecret: AUTH_CFG.sessionSecret,
      publicDir: tmpDir,
      watchdogTimeoutMillis: 250,
      now: () => fakeNow,
      onWatchdogTimeout: alert => {
        watchdogAlerts.push(alert);
      },
    });
    const srv = await startTestServer(app);
    const liveFile = path.join(tmpDir, 'api', 'live.json');

    try {
      const hbPayload = {
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

      const hb1 = await apiJson(
        srv.baseUrl,
        'POST',
        '/api/arena/heartbeat',
        AUTH_CFG.arenaSecret,
        hbPayload
      );
      expect(hb1.status).toBe(200);
      const doc1 = JSON.parse(fs.readFileSync(liveFile, 'utf8')) as arena.LiveDocument;
      expect(doc1.stale).toBe(false);
      expect(doc1.live?.turnStartedAt).toBe(1_760_001_000);
      expect(doc1.live?.slot).toBe('rby');

      // Same turn/slot heartbeat preserves turnStartedAt; new turn updates turnStartedAt
      fakeNow = 1_760_001_004;
      await apiJson(
        srv.baseUrl,
        'POST',
        '/api/arena/heartbeat',
        AUTH_CFG.arenaSecret,
        {...hbPayload, heartbeatSeq: 2}
      );
      const doc2 = JSON.parse(fs.readFileSync(liveFile, 'utf8')) as arena.LiveDocument;
      expect(doc2.live?.turnStartedAt).toBe(1_760_001_000);

      fakeNow = 1_760_001_009;
      await apiJson(
        srv.baseUrl,
        'POST',
        '/api/arena/heartbeat',
        AUTH_CFG.arenaSecret,
        {...hbPayload, heartbeatSeq: 3, turn: 6, activeSlot: 'p2'}
      );
      const doc3 = JSON.parse(fs.readFileSync(liveFile, 'utf8')) as arena.LiveDocument;
      expect(doc3.live?.turnStartedAt).toBe(1_760_001_009);

      // LiveSlot accepts optional pool team short hashes and rejects >64-char team strings
      const hbTeamOk = await apiJson(
        srv.baseUrl,
        'POST',
        '/api/arena/heartbeat',
        AUTH_CFG.arenaSecret,
        {
          ...hbPayload,
          heartbeatSeq: 4,
          p1: {...hbPayload.p1, team: 'b7b8bb1cbc73'},
          p2: {...hbPayload.p2, team: 'P1:16d479804e3d'},
        }
      );
      expect(hbTeamOk.status).toBe(200);
      const docTeam = JSON.parse(fs.readFileSync(liveFile, 'utf8')) as arena.LiveDocument;
      expect(docTeam.live?.p1.team).toBe('b7b8bb1cbc73');
      expect(docTeam.live?.p2.team).toBe('P1:16d479804e3d');

      const hbTeamBad = await apiJson(
        srv.baseUrl,
        'POST',
        '/api/arena/heartbeat',
        AUTH_CFG.arenaSecret,
        {
          ...hbPayload,
          heartbeatSeq: 5,
          p1: {...hbPayload.p1, team: 'x'.repeat(65)},
        }
      );
      expect(hbTeamBad.status).toBe(400);

      // Play 45 blind-pair matches so SE <= 30 and matches >= 25 (settlement + Top-1 reign!)
      for (let mIdx = 1; mIdx <= 45; mIdx++) {
        fakeNow = 1_760_001_000 + mIdx * 300;
        const matchId = `gen1ou-${String(mIdx).padStart(10, '0')}`;
        const isLoss = mIdx === 14 || mIdx === 28;
        const isSplit = !isLoss && mIdx % 5 === 0;
        const g1Outcome = isLoss ? 'L' : 'W';
        const g2Outcome = isLoss || isSplit ? 'L' : 'W';
        const matchCat = isLoss ? 'LL' : isSplit ? 'WL' : 'WW';
        const g2Reason = mIdx === 5 ? 'timeout' : 'normal';

        const mc = await apiJson(
          srv.baseUrl,
          'POST',
          '/api/arena/match-complete',
          AUTH_CFG.arenaSecret,
          {
            match: {
              id: matchId,
              ladderId: 'gen1ou20261109',
              p1VersionId: vZero.id,
              p2VersionId: vFp.id,
              seed: `sodium,${mIdx}`,
              game1Outcome: g1Outcome,
              game2Outcome: g2Outcome,
              category: matchCat,
              game1Turns: 28,
              game2Turns: 31,
              game1EndReason: 'normal',
              game2EndReason: g2Reason,
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

      // Duplicate submission of match #45 must be idempotent
      const dupRes = await apiJson(
        srv.baseUrl,
        'POST',
        '/api/arena/match-complete',
        AUTH_CFG.arenaSecret,
        {
          match: {
            id: 'gen1ou-0000000045',
            ladderId: 'gen1ou20261109',
            p1VersionId: vZero.id,
            p2VersionId: vFp.id,
            seed: 'sodium,45',
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
        }
      );
      expect(dupRes.status).toBe(200);
      expect(dupRes.data.duplicate).toBe(true);

      const entries = db.getLeaderboardEntries('gen1ou20261109');
      const zeroEntry = entries.find(e => e.versionId === vZero.id)!;
      const fpEntry = entries.find(e => e.versionId === vFp.id)!;
      const zeroRaw = db.db.prepare(
        'SELECT * FROM ladder_entries WHERE ladder_id = ? AND version_id = ?'
      ).get('gen1ou20261109', vZero.id) as Record<string, unknown>;

      expect(zeroEntry.matches).toBe(45);
      expect(zeroEntry.ww).toBe(34);
      expect(zeroEntry.split).toBe(9);
      expect(zeroEntry.ll).toBe(2);
      expect(zeroRaw.timeouts).toBe(1);
      expect(fpEntry.elo).toBeCloseTo(1500, 4);
      expect(zeroEntry.elo).toBeGreaterThan(1650);
      expect(zeroEntry.settledAt).toBeDefined();
      expect(zeroEntry.rankCurrent).toBe(1);
      expect(zeroRaw.best_rank).toBe(1);
      expect(zeroRaw.top1_total_seconds as number).toBeGreaterThan(0);

      const famZero = db.db.prepare(
        'SELECT * FROM agent_ladder_stats WHERE ladder_id = ? AND agent_id = ?'
      ).get('gen1ou20261109', zeroAgent.id) as Record<string, unknown>;
      expect(famZero.best_rank).toBe(1);
      expect(famZero.max_win_streak).toBe(4);
      expect(famZero.top1_total_seconds as number).toBeGreaterThan(0);

      const pair = db.db.prepare(
        'SELECT * FROM pair_aggregates WHERE ladder_id = ?'
      ).get('gen1ou20261109') as Record<string, unknown>;
      expect(pair.low_los as number).toBeGreaterThan(0.99);

      const snapshots = db.db.prepare(
        'SELECT COUNT(*) AS cnt FROM rating_snapshots WHERE ladder_id = ?'
      ).get('gen1ou20261109') as {cnt: number};
      expect(snapshots.cnt).toBe(2);

      const docAfterMatches = JSON.parse(
        fs.readFileSync(liveFile, 'utf8')
      ) as arena.LiveDocument;
      expect(docAfterMatches.live).toBeUndefined();
      expect(docAfterMatches.recentMatches).toHaveLength(45);
      expect(docAfterMatches.recentMatches[0].id).toBe('gen1ou-0000000045');

      // Wait >250ms for disconnect watchdog to fire
      await new Promise(resolve => setTimeout(resolve, 320));
      expect(watchdogAlerts).toHaveLength(1);
      expect(watchdogAlerts[0].lastMatchId).toBe('gen1ou-0000000045');
      const staleDoc = JSON.parse(fs.readFileSync(liveFile, 'utf8')) as arena.LiveDocument;
      expect(staleDoc.stale).toBe(true);
    } finally {
      ctrl.close();
      await srv.close();
      db.close();
    }
  });
});

describe('pkmn CLI (tools/pkmn.ts)', () => {
  test('supports quarantine, cooldown, anchor, rotate-ladder, session, and lookup-smogon',
    async () => {
      const db = new Database(':memory:');
      db.syncLaddersFromYaml(LADDERS_YAML, 1_760_000_000);
      db.syncProjectsFromYaml(PROJECTS_YAML, undefined, 1_760_000_000);

      const zeroAgent = db.getAgentBySlug('0-error')!;
      const fpAgent = db.getAgentBySlug('foul-play')!;
      const vZero = db.createSubmission({
        agentId: zeroAgent.id,
        version: '1.0.0',
        package: 'bundle',
        url: 'https://example.com/0-error-1.0.0.tar.zst',
        sha256: SHA,
        ladderIds: ['gen1ou20261109'],
        now: 1_760_000_100,
      });
      const vFp = db.createSubmission({
        agentId: fpAgent.id,
        version: '1.0.0',
        package: 'bundle',
        url: 'https://example.com/fp-1.0.0.tar.zst',
        sha256: SHA,
        ladderIds: ['gen1ou20261109'],
        now: 1_760_000_100,
      });
      db.applySubmissionStatus({versionId: vZero.id, smokeStatus: 'passed', now: 1_760_000_110});
      db.applySubmissionStatus({versionId: vFp.id, smokeStatus: 'passed', now: 1_760_000_110});

      const logs: string[] = [];
      const log = (line: string) => logs.push(line);

      try {
        // Currently on 14-day cooldown -> refund-cooldown clears it
        expect(db.computeAgentSubmissionStatus(zeroAgent.id, 1_760_000_200).canSubmit).toBe(false);
        db.db.prepare(
          'UPDATE ladder_entries SET se = 20, matches = 30, settled_at = 1760000150'
        ).run();
        expect(db.computeAgentSubmissionStatus(zeroAgent.id, 1_760_000_200).reason)
          .toContain('14-day cooldown');

        await runPkmnCli(['refund-cooldown', '0-error'], {db, now: 1_760_000_250, log});
        expect(db.computeAgentSubmissionStatus(zeroAgent.id, 1_760_000_260).canSubmit).toBe(true);

        // Quarantine & unquarantine
        await runPkmnCli(
          ['quarantine', '0-error', '1.0.0', '--reason', 'OOM in match 12'],
          {db, now: 1_760_000_300, log}
        );
        expect(db.getVersionById(vZero.id)!.smokeStatus).toBe('quarantined');
        expect(db.getActiveEntriesForAgent(zeroAgent.id)).toHaveLength(0);

        await runPkmnCli(['unquarantine', '0-error', '1.0.0'], {db, now: 1_760_000_350, log});
        expect(db.getVersionById(vZero.id)!.smokeStatus).toBe('passed');
        expect(db.getActiveEntriesForAgent(zeroAgent.id)).toHaveLength(1);

        // Record a match and verify set-anchor shifts ratings so the chosen anchor is 1500
        db.recordCompletedMatch({
          match: {
            id: 'gen1ou-0000000001',
            ladderId: 'gen1ou20261109',
            p1VersionId: vZero.id,
            p2VersionId: vFp.id,
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
        ).get(vFp.id) as {elo: number; is_anchor: number};
        expect(fpRow.is_anchor).toBe(1);
        expect(fpRow.elo).toBeCloseTo(1500, 5);

        // Rotate VGC ladder (0 unsettled entries -> immediately archived) and open Reg M-D
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
        expect(newVgc.status).toBe('active');
        expect(newVgc.name).toBe('VGC');
        expect(newVgc.teams).toBe(20);

        // Rotate RBY while unsettled entry exists -> enters 'settling', then archives on match
        const metaAgent = db.getAgentBySlug('metamon')!;
        const vMeta = db.createSubmission({
          agentId: metaAgent.id,
          version: '1.0.0',
          package: 'bundle',
          url: 'https://example.com/meta-1.0.0.tar.zst',
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
        expect(db.getLadder('gen1ou20270101')!.status).toBe('active');

        // Force settle remaining entry via ladderStatus: 'archived' on match-complete
        const finalRes = db.recordCompletedMatch({
          match: {
            id: 'gen1ou-0000000002',
            ladderId: 'gen1ou20261109',
            p1VersionId: vMeta.id,
            p2VersionId: vFp.id,
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

        // Mint session token via `pkmn session`
        await runPkmnCli(
          ['session', '--github', 'pre', '--secret', AUTH_CFG.sessionSecret],
          {db, now: 1_760_000_610, log}
        );
        expect(logs[logs.length - 1]).toContain('pkmn_session=');

        // lookup-smogon
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

        // Tournament management CLI (`create-tournament`, `seed-tournament`,
        // `set-tournament-status`) + pending-submissions `tournaments` enrollment
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
        db.applySubmissionStatus({
          versionId: tSub.id,
          smokeStatus: 'passed',
          now: 1_760_000_635,
        });
        expect(db.getTournamentEntrants('3').map(e => e.agentSlug)).toEqual(['0-error']);

        await runPkmnCli(
          ['seed-tournament', '3', '--ladder', 'gen1ou20261109'],
          {db, now: 1_760_000_640, log}
        );
        expect(db.getTournamentEntrants('3')[0].seed).toBe(1);

        await runPkmnCli(
          ['set-tournament-status', '3', 'running'],
          {db, now: 1_760_000_650, log}
        );
        expect(db.getRunningTournament()?.id).toBe('3');

        await runPkmnCli(
          ['set-tournament-status', '3', 'completed'],
          {db, now: 1_760_000_700, log}
        );
        expect(db.getRunningTournament()).toBeUndefined();
        expect(db.getTournament('3')?.completedAt).toBe(1_760_000_700);
      } finally {
        db.close();
      }
    });

  test('gates PUT /api/arena/{tournaments,ladders}/:id/archive on completion & pools retirement',
    async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-arena-archive-'));
      const db = new Database(':memory:');
      db.syncLaddersFromYaml(LADDERS_YAML, 1_700_000_000);
      db.syncProjectsFromYaml(PROJECTS_YAML, tmpDir, 1_700_000_000);
      db.upsertTournament({
        id: '3',
        name: 'Tournament #3: VGC 2026 Reg M-C OTS BO3',
        format: 'gen9championsvgc2026regmc',
        gamesPerMatchup: 18,
        parallelTables: 4,
        hardware: 'M6 Mac mini',
        status: 'running',
        startsAt: 1_700_000_100,
      });

      const authInstance = new auth.Auth({db, config: AUTH_CFG});
      const app = polka();
      const events: string[] = [];
      arena.register(app, {
        db,
        auth: authInstance,
        publicDir: tmpDir,
        onUpdate: reason => {
          events.push(reason);
        },
      });
      const srv = await startTestServer(app);

      try {
        const archiveBytes = Buffer.from('377abcaf271c-mock-7z-archive-payload', 'utf8');
        const expectedSha = crypto.createHash('sha256').update(archiveBytes).digest('hex');

        const putBinary = async (route: string, shaHeader?: string) => {
          const headers: Record<string, string> = {
            Authorization: `Bearer ${AUTH_CFG.arenaSecret}`,
            'Content-Type': 'application/x-7z-compressed',
          };
          if (shaHeader) headers['X-Content-SHA256'] = shaHeader;
          const res = await fetch(`${srv.baseUrl}${route}`, {
            method: 'PUT',
            headers,
            body: archiveBytes,
          });
          return {status: res.status, data: await res.json() as Record<string, unknown>};
        };

        // 1. Tournament archive rejected while running (409), SHA mismatch rejected (400),
        //    accepted once completed (200)
        expect((await putBinary('/api/arena/tournaments/3/archive')).status).toBe(409);

        db.setTournamentStatus('3', 'completed', 1_700_000_500);
        expect((await putBinary('/api/arena/tournaments/3/archive', '0'.repeat(64))).status)
          .toBe(400);

        const okTour = await putBinary('/api/arena/tournaments/3/archive', expectedSha);
        expect(okTour.status).toBe(200);
        expect(okTour.data.archiveHref).toBe('/arena/tournaments/3/3-replays.7z');
        expect(fs.readFileSync(path.join(tmpDir, 'arena', 'tournaments', '3', '3-replays.7z')))
          .toEqual(archiveBytes);

        // 2. Ladder archive rejected for non-pools ladders even if archived (400)
        db.setLadderStatus('gen1ou20261109', 'archived', 1_700_000_600);
        const badHarvested = await putBinary('/api/arena/ladders/gen1ou20261109/archive');
        expect(badHarvested.status).toBe(400);
        expect(String(badHarvested.data.error)).toMatch(/team-pool \(pools\)/);

        // 3. Pools ladder archive rejected while active or settling (409), accepted once archived
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
        expect(
          fs.readFileSync(path.join(
            tmpDir,
            'arena',
            'ladders',
            'gen9championsvgc2026regmc',
            'gen9championsvgc2026regmc-logs.7z'
          ))
        ).toEqual(archiveBytes);
        expect(events).toEqual(['archive-published', 'archive-published']);
      } finally {
        await srv.close();
        db.close();
        fs.rmSync(tmpDir, {recursive: true, force: true});
      }
    });

  test('paginates and filters GET /api/battles.json by slot, agent, and match id', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-arena-battles-page-'));
    const db = new Database(':memory:');
    db.syncLaddersFromYaml(LADDERS_YAML, 1_700_000_000);
    db.syncProjectsFromYaml(PROJECTS_YAML, tmpDir, 1_700_000_000);
    db.setLadderStatus('gen1ou20261109', 'active', 1_700_000_000);
    db.setLadderStatus('gen9championsvgc2026regmc', 'active', 1_700_000_000);

    const fp = db.getAgentBySlug('foul-play')!;
    const zero = db.getAgentBySlug('0-error')!;
    const vFp = db.createSubmission({
      agentId: fp.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://example.com/fp.tar.zst',
      sha256: 'a'.repeat(64),
      ladderIds: ['gen1ou20261109'],
      now: 1_700_000_010,
    });
    const vZero = db.createSubmission({
      agentId: zero.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://example.com/zero.tar.zst',
      sha256: 'b'.repeat(64),
      ladderIds: ['gen1ou20261109'],
      now: 1_700_000_010,
    });
    db.applySubmissionStatus({versionId: vFp.id, smokeStatus: 'passed', now: 1_700_000_020});
    db.applySubmissionStatus({versionId: vZero.id, smokeStatus: 'passed', now: 1_700_000_020});

    for (let i = 1; i <= 5; i++) {
      const isVgc = i % 2 === 0;
      db.recordCompletedMatch({
        match: {
          id: `m-00${i}`,
          ladderId: isVgc ? 'gen9championsvgc2026regmc' : 'gen1ou20261109',
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
    const handle = arena.register(app, {
      db,
      arenaSecret: AUTH_CFG.arenaSecret,
      publicDir: tmpDir,
      now: () => 1_700_000_999,
    });
    const srv = await startTestServer(app);

    try {
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

      const vgcOnly = await (
        await fetch(`${srv.baseUrl}/api/battles.json?slot=vgc&page=1&limit=10`)
      ).json() as {total: number; matches: Array<{id: string}>};
      expect(vgcOnly.total).toBe(2);
      expect(vgcOnly.matches.map(m => m.id)).toEqual(['m-004', 'm-002']);

      const byId = await fetch(`${srv.baseUrl}/api/battles.json?id=m-003`);
      expect(byId.status).toBe(200);
      expect(((await byId.json()) as {match: {id: string}}).match.id).toBe('m-003');

      expect((await fetch(`${srv.baseUrl}/api/battles.json?id=missing`)).status).toBe(404);
      expect((await fetch(`${srv.baseUrl}/api/battles.json?slot=bogus`)).status).toBe(400);
      expect((await fetch(`${srv.baseUrl}/api/battles.json?page=0`)).status).toBe(400);
    } finally {
      handle.close();
      await srv.close();
      db.close();
      fs.rmSync(tmpDir, {recursive: true, force: true});
    }
  });
});
