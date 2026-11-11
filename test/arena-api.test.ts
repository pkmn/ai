import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import polka from 'polka';

import {ArenaDB} from '../db';
import {encryptSecret} from '../server/account';
import * as arena from '../server/arena';
import {Auth, type AuthConfig} from '../server/auth';
import {runPkmnCli} from '../tools/pkmn';

const AUTH_CFG: AuthConfig = {
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
- id: gen1ou20261109
  slot: rby
  display_name: RBY
  format_id: gen1ou
  team_mode: harvested
  status: active
- id: gen9championsvgc2026regmc
  slot: vgc
  display_name: VGC
  format_id: gen9championsvgc2026regmc
  team_mode: competitor_pool
  min_bots: 3
  team_count: 20
  status: active
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
    const db = new ArenaDB(':memory:');
    db.syncLaddersFromYaml(LADDERS_YAML, 1_700_000_000);
    db.syncProjectsFromYaml(PROJECTS_YAML, tmpDir, 1_700_000_000);

    const auth = new Auth({db, config: AUTH_CFG});
    const app = polka();
    const events: string[] = [];
    const ctrl = arena.register(app, {
      db,
      auth,
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

      const zeroBot = db.getBotBySlug('0-error')!;
      const dev = db.getDeveloperByGitHub('pre')!;
      const vgcTeams = Array.from({length: 20}, (_, idx) => `packed-team-${idx + 1}`);

      const sub1 = db.createSubmission({
        botId: zeroBot.id,
        submittedByDevId: dev.id,
        versionStr: '1.0.0',
        formatType: 'bundle',
        downloadUrl: 'https://example.com/0-error-1.0.0.tar.zst',
        sha256: SHA,
        authTokenEnc: encryptSecret('ghp_private_pull_token', AUTH_CFG.sessionSecret),
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
      expect(submissions[0].version_id).toBe(sub1.id);
      expect(submissions[0].auth_token).toBe('ghp_private_pull_token');
      expect(
        (submissions[0].teams_by_ladder as Record<string, string[]>).gen9championsvgc2026regmc
      ).toHaveLength(20);

      // Verify slot_index is 1..20
      const slots = db.db.prepare(
        `SELECT MIN(slot_index) AS min_s, MAX(slot_index) AS max_s
         FROM bot_ladder_teams WHERE bot_id = ?`
      ).get(zeroBot.id) as {min_s: number; max_s: number};
      expect(slots).toEqual({min_s: 1, max_s: 20});

      // Fail smoke test on Foul Play -> wipes token, drops pending VGC teams, keeps Eligible
      const fpBot = db.getBotBySlug('foul-play')!;
      const fpSubFail = db.createSubmission({
        botId: fpBot.id,
        submittedByDevId: null,
        versionStr: '0.9.0',
        formatType: 'oci',
        downloadUrl: 'ghcr.io/pmariglia/foul-play:0.9.0',
        sha256: SHA,
        authTokenEnc: encryptSecret('ghcr_secret', AUTH_CFG.sessionSecret),
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
          version_id: fpSubFail.id,
          smoke_status: 'failed_smoke_test',
          smoke_error_log: 'Exited with code 1 during Turn 1',
        }
      );
      expect(failStatus.status).toBe(200);
      expect(db.getVersionById(fpSubFail.id)!.auth_token_enc).toBeNull();
      expect(db.getTeamsForBotLadder('gen9championsvgc2026regmc', fpBot.id)).toHaveLength(0);
      expect(db.computeBotSubmissionStatus(fpBot.id, 1_700_000_120).canSubmit).toBe(true);

      // Pass smoke test on 0 ERROR 1.0.0 -> wipes token, activates VGC teams, adds champion entry
      const pass1 = await apiJson(
        srv.baseUrl,
        'POST',
        '/api/arena/submission-status',
        AUTH_CFG.arenaSecret,
        {
          version_id: sub1.id,
          smoke_status: 'passed',
          unpacked_bytes: 210_000_000,
          smoke_duration_ms: 2100,
          smoke_turn_ms: 350,
          smoke_peak_ram_mb: 980,
        }
      );
      expect(pass1.status).toBe(200);
      expect(db.getVersionById(sub1.id)!.auth_token_enc).toBeNull();
      expect(db.hasActiveLadderTeams('gen9championsvgc2026regmc', zeroBot.id)).toBe(true);
      expect(db.getActiveEntriesForBot(zeroBot.id).map(e => e.role)).toEqual([
        'champion',
        'champion',
      ]);

      // Settle 1.0.0, advance past 14d cooldown, submit 1.1.0, settle 1.1.0 with higher rating,
      // then submit 1.2.0 -> 1.0.0 (weaker) is automatically retired!
      db.db.prepare(
        `UPDATE ladder_entries
         SET rating_elo = 1520, rating_se = 20, rating_lcb = 1480.8,
             matches_played = 30, settled_at = 1700500000
         WHERE version_id = ?`
      ).run(sub1.id);

      const sub2 = db.createSubmission({
        botId: zeroBot.id,
        submittedByDevId: dev.id,
        versionStr: '1.1.0',
        formatType: 'bundle',
        downloadUrl: 'https://example.com/0-error-1.1.0.tar.zst',
        sha256: SHA,
        authTokenEnc: null,
        ladderIds: ['gen1ou20261109'],
        now: 1_702_000_000,
      });
      await apiJson(
        srv.baseUrl,
        'POST',
        '/api/arena/submission-status',
        AUTH_CFG.arenaSecret,
        {version_id: sub2.id, smoke_status: 'passed'}
      );
      db.db.prepare(
        `UPDATE ladder_entries
         SET rating_elo = 1650, rating_se = 18, rating_lcb = 1614.7,
             matches_played = 32, settled_at = 1702500000
         WHERE version_id = ?`
      ).run(sub2.id);

      const sub3 = db.createSubmission({
        botId: zeroBot.id,
        submittedByDevId: dev.id,
        versionStr: '1.2.0',
        formatType: 'bundle',
        downloadUrl: 'https://example.com/0-error-1.2.0.tar.zst',
        sha256: SHA,
        authTokenEnc: null,
        ladderIds: ['gen1ou20261109'],
        now: 1_704_000_000,
      });
      const pass3 = await apiJson(
        srv.baseUrl,
        'POST',
        '/api/arena/submission-status',
        AUTH_CFG.arenaSecret,
        {version_id: sub3.id, smoke_status: 'passed'}
      );
      expect(pass3.status).toBe(200);
      expect(pass3.data.retired_by_ladder).toEqual({gen1ou20261109: sub1.id});

      const rbyActive = db.getActiveEntriesForBot(zeroBot.id)
        .filter(e => e.ladder_id === 'gen1ou20261109');
      expect(rbyActive.map(e => `${e.version_str}:${e.role}`)).toEqual([
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
    const db = new ArenaDB(':memory:');
    db.syncLaddersFromYaml(LADDERS_YAML, 1_760_000_000);
    db.syncProjectsFromYaml(PROJECTS_YAML, tmpDir, 1_760_000_000);

    const zeroBot = db.getBotBySlug('0-error')!;
    const fpBot = db.getBotBySlug('foul-play')!;

    const vZero = db.createSubmission({
      botId: zeroBot.id,
      submittedByDevId: null,
      versionStr: '1.0.0',
      formatType: 'bundle',
      downloadUrl: 'https://example.com/0-error-1.0.0.tar.zst',
      sha256: SHA,
      authTokenEnc: null,
      ladderIds: ['gen1ou20261109'],
      now: 1_760_000_010,
    });
    const vFp = db.createSubmission({
      botId: fpBot.id,
      submittedByDevId: null,
      versionStr: '1.0.0',
      formatType: 'bundle',
      downloadUrl: 'https://example.com/fp-1.0.0.tar.zst',
      sha256: SHA,
      authTokenEnc: null,
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
      watchdogTimeoutMs: 60,
      now: () => fakeNow,
      onWatchdogTimeout: alert => {
        watchdogAlerts.push(alert);
      },
    });
    const srv = await startTestServer(app);
    const liveFile = path.join(tmpDir, 'api', 'live.json');

    try {
      const hbPayload = {
        heartbeat_seq: 1,
        match_id: 'gen1ou-0000000001',
        ladder_id: 'gen1ou20261109',
        format_id: 'gen1ou',
        game_num: 1,
        turn: 5,
        active_slot: 'p1',
        turn_budget_s: 150,
        increment_s: 10,
        g1_summary: null,
        p1: {
          slug: '0-error',
          name: '0 ERROR',
          version: '1.0.0',
          bank_s: 148,
          last_turn_ms: 310,
          mean_turn_ms: 300,
          ram_mb: 900,
        },
        p2: {
          slug: 'foul-play',
          name: 'Foul Play',
          version: '1.0.0',
          bank_s: 150,
          last_turn_ms: 420,
          mean_turn_ms: 410,
          ram_mb: 1100,
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
      const doc1 = JSON.parse(fs.readFileSync(liveFile, 'utf8')) as arena.LiveJsonDocument;
      expect(doc1.stale).toBe(false);
      expect(doc1.live?.turn_started_at).toBe(1_760_001_000);
      expect(doc1.live?.slot).toBe('rby');

      // Same turn/slot heartbeat preserves turn_started_at; new turn updates turn_started_at
      fakeNow = 1_760_001_004;
      await apiJson(
        srv.baseUrl,
        'POST',
        '/api/arena/heartbeat',
        AUTH_CFG.arenaSecret,
        {...hbPayload, heartbeat_seq: 2}
      );
      const doc2 = JSON.parse(fs.readFileSync(liveFile, 'utf8')) as arena.LiveJsonDocument;
      expect(doc2.live?.turn_started_at).toBe(1_760_001_000);

      fakeNow = 1_760_001_009;
      await apiJson(
        srv.baseUrl,
        'POST',
        '/api/arena/heartbeat',
        AUTH_CFG.arenaSecret,
        {...hbPayload, heartbeat_seq: 3, turn: 6, active_slot: 'p2'}
      );
      const doc3 = JSON.parse(fs.readFileSync(liveFile, 'utf8')) as arena.LiveJsonDocument;
      expect(doc3.live?.turn_started_at).toBe(1_760_001_009);

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
              ladder_id: 'gen1ou20261109',
              v1_id: vZero.id,
              v2_id: vFp.id,
              seed: `sodium,${mIdx}`,
              g1_outcome: g1Outcome,
              g2_outcome: g2Outcome,
              match_category: matchCat,
              g1_turns: 28,
              g2_turns: 31,
              g1_end_reason: 'normal',
              g2_end_reason: g2Reason,
              v1_peak_ram_mb: 950,
              v2_peak_ram_mb: 1120,
              v1_g1_bank_s: 145,
              v1_g2_bank_s: 140,
              v2_g1_bank_s: 138,
              v2_g2_bank_s: 120,
              v1_avg_turn_ms: 310,
              v2_avg_turn_ms: 420,
              completed_at: fakeNow,
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
            ladder_id: 'gen1ou20261109',
            v1_id: vZero.id,
            v2_id: vFp.id,
            seed: 'sodium,45',
            g1_outcome: 'W',
            g2_outcome: 'L',
            match_category: 'WL',
            g1_turns: 28,
            g2_turns: 31,
            g1_end_reason: 'normal',
            g2_end_reason: 'normal',
            v1_peak_ram_mb: 950,
            v2_peak_ram_mb: 1120,
            v1_g1_bank_s: 145,
            v1_g2_bank_s: 140,
            v2_g1_bank_s: 138,
            v2_g2_bank_s: 120,
            v1_avg_turn_ms: 310,
            v2_avg_turn_ms: 420,
            completed_at: fakeNow,
          },
        }
      );
      expect(dupRes.status).toBe(200);
      expect(dupRes.data.duplicate).toBe(true);

      const zeroEntry = db.db.prepare(
        'SELECT * FROM ladder_entries WHERE ladder_id = ? AND version_id = ?'
      ).get('gen1ou20261109', vZero.id) as Record<string, unknown>;
      const fpEntry = db.db.prepare(
        'SELECT * FROM ladder_entries WHERE ladder_id = ? AND version_id = ?'
      ).get('gen1ou20261109', vFp.id) as Record<string, unknown>;

      expect(zeroEntry.matches_played).toBe(45);
      expect(zeroEntry.ww).toBe(34);
      expect(zeroEntry.split).toBe(9);
      expect(zeroEntry.ll).toBe(2);
      expect(zeroEntry.timeouts).toBe(1);
      expect(fpEntry.rating_elo).toBeCloseTo(1500, 4);
      expect(zeroEntry.rating_elo as number).toBeGreaterThan(1650);
      expect(zeroEntry.settled_at).not.toBeNull();
      expect(zeroEntry.rank_current).toBe(1);
      expect(zeroEntry.best_rank).toBe(1);
      expect(zeroEntry.top1_total_s as number).toBeGreaterThan(0);

      const famZero = db.db.prepare(
        'SELECT * FROM bot_ladder_stats WHERE ladder_id = ? AND bot_id = ?'
      ).get('gen1ou20261109', zeroBot.id) as Record<string, unknown>;
      expect(famZero.best_rank).toBe(1);
      expect(famZero.max_win_streak).toBe(4);
      expect(famZero.top1_total_s as number).toBeGreaterThan(0);

      const pair = db.db.prepare(
        'SELECT * FROM pair_aggregates WHERE ladder_id = ?'
      ).get('gen1ou20261109') as Record<string, unknown>;
      expect(pair.los_low as number).toBeGreaterThan(0.99);

      const snapshots = db.db.prepare(
        'SELECT COUNT(*) AS cnt FROM rating_snapshots WHERE ladder_id = ?'
      ).get('gen1ou20261109') as {cnt: number};
      expect(snapshots.cnt).toBe(2);

      const docAfterMatches = JSON.parse(
        fs.readFileSync(liveFile, 'utf8')
      ) as arena.LiveJsonDocument;
      expect(docAfterMatches.live).toBeNull();
      expect(docAfterMatches.recent_matches).toHaveLength(45);
      expect(docAfterMatches.recent_matches[0].id).toBe('gen1ou-0000000045');

      // Wait >60ms for disconnect watchdog to fire
      await new Promise(resolve => setTimeout(resolve, 110));
      expect(watchdogAlerts).toHaveLength(1);
      expect(watchdogAlerts[0].lastMatchId).toBe('gen1ou-0000000045');
      const staleDoc = JSON.parse(fs.readFileSync(liveFile, 'utf8')) as arena.LiveJsonDocument;
      expect(staleDoc.stale).toBe(true);
    } finally {
      ctrl.close();
      await srv.close();
      db.close();
    }
  });
});

describe('pkmn CLI (tools/pkmn.ts)', () => {
  test('supports quarantine, cooldown, anchor, rotate-ladder, and lookup-smogon', async () => {
    const db = new ArenaDB(':memory:');
    db.syncLaddersFromYaml(LADDERS_YAML, 1_760_000_000);
    db.syncProjectsFromYaml(PROJECTS_YAML, undefined, 1_760_000_000);

    const zeroBot = db.getBotBySlug('0-error')!;
    const fpBot = db.getBotBySlug('foul-play')!;
    const vZero = db.createSubmission({
      botId: zeroBot.id,
      submittedByDevId: null,
      versionStr: '1.0.0',
      formatType: 'bundle',
      downloadUrl: 'https://example.com/0-error-1.0.0.tar.zst',
      sha256: SHA,
      authTokenEnc: null,
      ladderIds: ['gen1ou20261109'],
      now: 1_760_000_100,
    });
    const vFp = db.createSubmission({
      botId: fpBot.id,
      submittedByDevId: null,
      versionStr: '1.0.0',
      formatType: 'bundle',
      downloadUrl: 'https://example.com/fp-1.0.0.tar.zst',
      sha256: SHA,
      authTokenEnc: null,
      ladderIds: ['gen1ou20261109'],
      now: 1_760_000_100,
    });
    db.applySubmissionStatus({versionId: vZero.id, smokeStatus: 'passed', now: 1_760_000_110});
    db.applySubmissionStatus({versionId: vFp.id, smokeStatus: 'passed', now: 1_760_000_110});

    const logs: string[] = [];
    const log = (line: string) => logs.push(line);

    try {
      // Currently on 14-day cooldown -> refund-cooldown clears it
      expect(db.computeBotSubmissionStatus(zeroBot.id, 1_760_000_200).canSubmit).toBe(false);
      db.db.prepare(
        'UPDATE ladder_entries SET rating_se = 20, matches_played = 30, settled_at = 1760000150'
      ).run();
      expect(db.computeBotSubmissionStatus(zeroBot.id, 1_760_000_200).reason)
        .toContain('14-day cooldown');

      await runPkmnCli(['refund-cooldown', '0-error'], {db, now: 1_760_000_250, log});
      expect(db.computeBotSubmissionStatus(zeroBot.id, 1_760_000_260).canSubmit).toBe(true);

      // Quarantine & unquarantine
      await runPkmnCli(
        ['quarantine', '0-error', '1.0.0', '--reason', 'OOM in match 12'],
        {db, now: 1_760_000_300, log}
      );
      expect(db.getVersionById(vZero.id)!.smoke_status).toBe('quarantined');
      expect(db.getActiveEntriesForBot(zeroBot.id)).toHaveLength(0);

      await runPkmnCli(['unquarantine', '0-error', '1.0.0'], {db, now: 1_760_000_350, log});
      expect(db.getVersionById(vZero.id)!.smoke_status).toBe('passed');
      expect(db.getActiveEntriesForBot(zeroBot.id)).toHaveLength(1);

      // Record a match and verify set-anchor shifts ratings so the chosen anchor is 1500
      db.recordCompletedMatch({
        match: {
          id: 'gen1ou-0000000001',
          ladder_id: 'gen1ou20261109',
          v1_id: vZero.id,
          v2_id: vFp.id,
          seed: 'sodium,1',
          g1_outcome: 'W',
          g2_outcome: 'W',
          match_category: 'WW',
          g1_turns: 25,
          g2_turns: 27,
          g1_end_reason: 'normal',
          g2_end_reason: 'normal',
          v1_peak_ram_mb: 800,
          v2_peak_ram_mb: 900,
          v1_g1_bank_s: 140,
          v1_g2_bank_s: 140,
          v2_g1_bank_s: 140,
          v2_g2_bank_s: 140,
          v1_avg_turn_ms: 200,
          v2_avg_turn_ms: 200,
          completed_at: 1_760_000_400,
        },
      });
      await runPkmnCli(
        ['set-anchor', 'gen1ou20261109', 'foul-play', '1.0.0'],
        {db, now: 1_760_000_410, log}
      );
      const fpRow = db.db.prepare(
        'SELECT rating_elo, is_anchor FROM ladder_entries WHERE version_id = ?'
      ).get(vFp.id) as {rating_elo: number; is_anchor: number};
      expect(fpRow.is_anchor).toBe(1);
      expect(fpRow.rating_elo).toBeCloseTo(1500, 5);

      // Rotate VGC ladder (0 unsettled entries -> immediately archived) and open Reg M-D
      await runPkmnCli(
        [
          'rotate-ladder',
          'gen9championsvgc2026regmc',
          '--display-name',
          'VGC 2026 Reg M-C',
          '--new',
          'gen9championsvgc2026regmd',
        ],
        {db, now: 1_760_000_500, log}
      );
      const oldVgc = db.getLadder('gen9championsvgc2026regmc')!;
      const newVgc = db.getLadder('gen9championsvgc2026regmd')!;
      expect(oldVgc.status).toBe('archived');
      expect(oldVgc.display_name).toBe('VGC 2026 Reg M-C');
      expect(newVgc.status).toBe('active');
      expect(newVgc.display_name).toBe('VGC');
      expect(newVgc.team_count).toBe(20);

      // Rotate RBY while unsettled entry exists -> enters 'settling', then archives on match
      const metaBot = db.getBotBySlug('metamon')!;
      const vMeta = db.createSubmission({
        botId: metaBot.id,
        submittedByDevId: null,
        versionStr: '1.0.0',
        formatType: 'bundle',
        downloadUrl: 'https://example.com/meta-1.0.0.tar.zst',
        sha256: SHA,
        authTokenEnc: null,
        ladderIds: ['gen1ou20261109'],
        now: 1_760_000_510,
      });
      db.applySubmissionStatus({versionId: vMeta.id, smokeStatus: 'passed', now: 1_760_000_520});

      await runPkmnCli(
        [
          'rotate-ladder',
          'gen1ou20261109',
          '--display-name',
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
          ladder_id: 'gen1ou20261109',
          v1_id: vMeta.id,
          v2_id: vFp.id,
          seed: 'sodium,2',
          g1_outcome: 'W',
          g2_outcome: 'L',
          match_category: 'WL',
          g1_turns: 30,
          g2_turns: 30,
          g1_end_reason: 'normal',
          g2_end_reason: 'normal',
          v1_peak_ram_mb: 700,
          v2_peak_ram_mb: 900,
          v1_g1_bank_s: 140,
          v1_g2_bank_s: 140,
          v2_g1_bank_s: 140,
          v2_g2_bank_s: 140,
          v1_avg_turn_ms: 200,
          v2_avg_turn_ms: 200,
          completed_at: 1_760_000_600,
        },
        ladderStatus: 'archived',
      });
      expect(finalRes.archivedLadder).toBe(true);
      expect(db.getLadder('gen1ou20261109')!.status).toBe('archived');

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
    } finally {
      db.close();
    }
  });
});
