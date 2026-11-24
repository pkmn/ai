import * as http from 'http';

import polka from 'polka';

import {ALL_SLOTS, Database} from '../db';
import * as admin from '../server/admin';
import * as arena from '../server/arena';
import * as auth from '../server/auth';
import * as system from '../server/system';
import {runPkmnCli} from '../tools/pkmn';

const AUTH_CFG: auth.Config = {
  sessionSecret: 'test-admin-session-secret',
  github: {
    clientId: 'gh-client-id',
    clientSecret: 'gh-client-secret',
  },
};

const PROJECTS_YAML = `
- name: 0 ERROR
  active: 2026
  arena:
    owners:
      scheibo: pre.10544
- name: Foul Play
  active: 2026
  arena:
    owners:
      pmariglia: pmariglia.535629
- name: Newcomer
  active: 2026
  arena:
    owners:
      rookie: rookie.999999
`;

const SHA_A = '8f4ac91e0000000000000000000000000000000000000000000000008f4ac91e';
const SHA_B = '2b1904fa0000000000000000000000000000000000000000000000002b1904fa';

describe('/admin dashboard & API', () => {
  let db: Database;
  let server: http.Server;
  let baseUrl: string;
  let now: number;
  let arenaHandle: arena.Handle;
  let adminHandle: admin.Handle;
  let traffic: system.TrafficTracker;
  const ARENA_SECRET = 'test-admin-arena-secret';

  const cookieFor = (login: string, id = 1001) => {
    const token = auth.signToken(
      {github: {id, login}, exp: Math.floor(Date.now() / 1000) + 3600},
      AUTH_CFG.sessionSecret
    );
    return `${auth.SESSION_COOKIE}=${encodeURIComponent(token)}`;
  };

  beforeEach(async () => {
    now = 1_760_000_000;
    db = new Database(':memory:');
    db.syncLadders(undefined, now);
    db.db.prepare("UPDATE ladders SET status = 'active'").run();
    db.syncProjectsFromYaml(PROJECTS_YAML, undefined, now);
    db.setAgentLadders('0-error', ['rby', 'adv'], now);
    db.setAgentLadders('foul-play', ALL_SLOTS, now);
    db.linkDeveloperDiscord('scheibo', '513513270670262284', 'scheibo', now);
    db.syncDiscordMembers([{id: '513513270670262284', username: 'scheibo'}], now);

    const authHandler = new auth.Auth({config: AUTH_CFG, db});
    const app = polka();
    traffic = new system.TrafficTracker(() => now);
    app.use(traffic.middleware());
    authHandler.register(app);
    let notifyHb = () => {};
    arenaHandle = arena.register(app, {
      db,
      auth: authHandler,
      arenaSecret: ARENA_SECRET,
      now: () => now,
      onHeartbeat: () => notifyHb(),
    });
    const vpsMonitor = new system.VpsHostMonitor({
      dbPath: db.dbPath,
      traffic,
      now: () => now,
    });
    adminHandle = admin.register(app, {
      db,
      auth: authHandler,
      arena: arenaHandle,
      vpsMonitor,
      now: () => now,
    });
    notifyHb = () => adminHandle.notifyHeartbeat();

    server = http.createServer((req, res) => app.handler(req as polka.Request, res));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as {port: number};
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    adminHandle.close();
    arenaHandle.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
  });

  test('redirects unauthenticated visitors and blocks non-admins with 403', async () => {
    const anonHtml = await fetch(`${baseUrl}/admin/`, {redirect: 'manual'});
    expect(anonHtml.status).toBe(302);
    expect(anonHtml.headers.get('location')).toBe('/auth/github?return_to=%2Fadmin%2F');

    const anonJson = await fetch(`${baseUrl}/admin.json`);
    expect(anonJson.status).toBe(401);

    const nonAdminHtml = await fetch(`${baseUrl}/admin/`, {
      headers: {Cookie: cookieFor('pmariglia', 2002)},
    });
    expect(nonAdminHtml.status).toBe(403);

    const nonAdminJson = await fetch(`${baseUrl}/admin.json`, {
      headers: {Cookie: cookieFor('pmariglia', 2002)},
    });
    expect(nonAdminJson.status).toBe(403);

    const nonAdminPost = await fetch(`${baseUrl}/api/admin/agents/newcomer/ladders`, {
      method: 'POST',
      headers: {
        Cookie: cookieFor('pmariglia', 2002),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({slot: 'rby', qualified: true}),
    });
    expect(nonAdminPost.status).toBe(403);
  });

  test('blocks cross-site admin mutation requests with 403', async () => {
    const res = await fetch(`${baseUrl}/api/admin/agents/newcomer/ladders`, {
      method: 'POST',
      headers: {
        Cookie: cookieFor('scheibo'),
        'Content-Type': 'application/json',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: JSON.stringify({slot: 'rby', qualified: true}),
    });
    expect(res.status).toBe(403);
  });

  test('renders HTML dashboard and identical /admin.json & /admin/index.json feeds', async () => {
    const htmlRes = await fetch(`${baseUrl}/admin/`, {
      headers: {Cookie: cookieFor('scheibo')},
    });
    expect(htmlRes.status).toBe(200);
    const html = await htmlRes.text();
    expect(html).toContain('Admin | pkmn.ai');
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain('0 ERROR');
    expect(html).toContain('Foul Play');
    expect(html).toContain('Newcomer');
    expect(html).toContain('https://discord.com/users/513513270670262284');
    expect(html).toContain('@scheibo');
    expect(html).toContain('No Discord linked');
    expect(html).not.toContain('Champion');
    expect(html).not.toContain('Challenger');
    expect(html).not.toContain('Needs Attention');

    const j1 = await (await fetch(`${baseUrl}/admin.json`, {
      headers: {Cookie: cookieFor('scheibo')},
    })).json() as admin.AdminSnapshot;
    const j2 = await (await fetch(`${baseUrl}/admin/index.json`, {
      headers: {Cookie: cookieFor('scheibo')},
    })).json() as admin.AdminSnapshot;
    expect({...j1, system: undefined}).toEqual({...j2, system: undefined});
    expect(j1.system.vps.hostname).toBe(j2.system.vps.hostname);
    expect(j1.system.vps.load.cpus).toBeGreaterThan(0);
    expect(j1.admin).toBe('scheibo');
    expect(j1.health.discordMemberCount).toBe(1);
    expect(j1.ladders).toHaveLength(5);
    expect(j1.agents.map(a => a.agent.slug)).toEqual(['0-error', 'foul-play', 'newcomer']);
  });

  test(
    'toggles per-ladder eligibility, refunds cooldown, quarantines, and retires entries',
    async () => {
      const adminCookie = cookieFor('scheibo');

      // 1. Toggle VGC on for Newcomer -> transitions from Pending to Eligible.
      const enableRes = await fetch(`${baseUrl}/api/admin/agents/newcomer/ladders`, {
        method: 'POST',
        headers: {Cookie: adminCookie, 'Content-Type': 'application/json'},
        body: JSON.stringify({slot: 'vgc', qualified: true}),
      });
      expect(enableRes.status).toBe(200);
      const enableData = await enableRes.json() as {
        qualifiedLadders: string[];
        submissionStatus: {label: string; canSubmit: boolean};
      };
      expect(enableData.qualifiedLadders).toEqual(['vgc']);
      expect(enableData.submissionStatus.label).toBe('Eligible');

      // 2. Submit two versions for 0 ERROR on RBY and pass smoke tests.
      const zero = db.getAgentBySlug('0-error')!;
      const v1 = db.createSubmission({
        agentId: zero.id,
        version: '1.0.0',
        package: 'bundle',
        url: 'https://github.com/pkmn/0-error-1.0.0.tar.zst',
        sha256: SHA_A,
        ladderIds: ['gen1ou20261109'],
        now,
      });
      db.applySubmissionStatus({versionId: v1.id, smokeStatus: 'passed', now: now + 5});
      db.setLadderAnchor('gen1ou20261109', '0-error', '1.0.0', now + 6);

      // Cooldown is active right after 1.0.0 passes; refund it via admin API.
      now += 10;
      expect(db.computeAgentSubmissionStatus(zero.id, now).nextEligibleAt).toBeDefined();
      const refundRes = await fetch(`${baseUrl}/api/admin/agents/0-error/refund-cooldown`, {
        method: 'POST',
        headers: {Cookie: adminCookie, 'Content-Type': 'application/json'},
        body: '{}',
      });
      expect(refundRes.status).toBe(200);
      expect(db.getAgentById(zero.id)?.cooldownRefundedAt).toBe(now);

      // Settle v1 so v2 can be submitted.
      db.db.prepare(
        'UPDATE ladder_entries SET settled_at = ?, matches = 25, se = 20 WHERE version_id = ?'
      ).run(now, v1.id);
      const v2 = db.createSubmission({
        agentId: zero.id,
        version: '1.1.0',
        package: 'bundle',
        url: 'https://github.com/pkmn/0-error-1.1.0.tar.zst',
        sha256: SHA_B,
        ladderIds: ['gen1ou20261109'],
        now: now + 10,
      });
      db.applySubmissionStatus({versionId: v2.id, smokeStatus: 'passed', now: now + 15});

      // 3. Quarantine & unquarantine v2 via admin API.
      const qRes = await fetch(`${baseUrl}/api/admin/versions/0-error/1.1.0/quarantine`, {
        method: 'POST',
        headers: {Cookie: adminCookie, 'Content-Type': 'application/json'},
        body: JSON.stringify({reason: 'Turn timeout loop'}),
      });
      expect(qRes.status).toBe(200);
      expect(db.getVersionById(v2.id)?.smokeStatus).toBe('quarantined');
      expect(db.getVersionById(v2.id)?.smokeError).toBe('Turn timeout loop');

      const uqRes = await fetch(`${baseUrl}/api/admin/versions/0-error/1.1.0/unquarantine`, {
        method: 'POST',
        headers: {Cookie: adminCookie, 'Content-Type': 'application/json'},
        body: '{}',
      });
      expect(uqRes.status).toBe(200);
      expect(db.getVersionById(v2.id)?.smokeStatus).toBe('passed');

      // 4. Retiring the 1500 Elo anchor is blocked with 400.
      const retireAnchorRes = await fetch(
        `${baseUrl}/api/admin/ladders/gen1ou20261109/entries/0-error/1.0.0/retire`,
        {method: 'POST', headers: {Cookie: adminCookie, 'Content-Type': 'application/json'}}
      );
      expect(retireAnchorRes.status).toBe(400);

      // 5. Retiring non-anchor v2 succeeds without removing RBY qualification.
      const retireRes = await fetch(
        `${baseUrl}/api/admin/ladders/gen1ou20261109/entries/0-error/1.1.0/retire`,
        {method: 'POST', headers: {Cookie: adminCookie, 'Content-Type': 'application/json'}}
      );
      expect(retireRes.status).toBe(200);
      expect(db.getAgentLadders(zero.id)).toEqual(['rby', 'adv']);
      const v2Role = db.db.prepare(
        'SELECT role FROM ladder_entries WHERE ladder_id = ? AND version_id = ?'
      ).get('gen1ou20261109', v2.id) as {role: string};
      expect(v2Role.role).toBe('retired');
    }
  );

  test('pkmn retire CLI retires an active entry on a specific ladder', async () => {
    const fp = db.getAgentBySlug('foul-play')!;
    const v1 = db.createSubmission({
      agentId: fp.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://github.com/pkmn/fp-1.0.0.tar.zst',
      sha256: SHA_A,
      ladderIds: ['gen1ou20261109', 'gen3ou20261109'],
      now,
    });
    db.applySubmissionStatus({versionId: v1.id, smokeStatus: 'passed', now: now + 5});

    const logs: string[] = [];
    await runPkmnCli(['retire', 'gen1ou20261109', 'foul-play', '1.0.0'], {
      db,
      now: now + 10,
      log: line => logs.push(line),
    });
    expect(logs[0]).toContain('Retired foul-play version 1.0.0 on gen1ou20261109');
    const active = db.getActiveEntriesForAgent(fp.id);
    expect(active.map(e => e.ladderId)).toEqual(['gen3ou20261109']);
  });

  test(
    'ingests Arena system telemetry via heartbeat without leaking to live.json and pushes SSE',
    async () => {
      const GIB = 1024 ** 3;
      const arenaSys: system.ArenaSystemInfo = {
        collectedAt: now,
        hostname: 'arena-mini',
        platform: 'Darwin 24.6.0 (arm64)',
        nodeVersion: 'v22.21.0',
        load: {
          load1: 2.1,
          load5: 1.9,
          load15: 1.7,
          cpus: 14,
          uptimeSeconds: 86400 * 5,
          processUptimeSeconds: 7200,
        },
        memory: {
          totalBytes: 64 * GIB,
          usedBytes: 18 * GIB,
          availableBytes: 46 * GIB,
          swapTotalBytes: 0,
          swapUsedBytes: 0,
          processRssBytes: 120 * 1024 * 1024,
          pressure: 'normal',
        },
        disks: [
          {
            mount: '/',
            label: 'Internal',
            mounted: true,
            totalBytes: 460 * GIB,
            usedBytes: 100 * GIB,
            availableBytes: 360 * GIB,
            ioBytesPerSecond: 2 * 1024 * 1024,
            iops: 40,
          },
          {
            mount: '/Volumes/Archive',
            label: 'Archive',
            mounted: false,
          },
        ],
        network: {
          iface: 'en0',
          rxBytesPerSecond: 12000,
          txBytesPerSecond: 8000,
          rxErrors: 0,
          txErrors: 0,
          internal: {target: 'VPS tunnel', ok: true, rttMillis: 19, checkedAt: now},
          external: {target: 'ghcr.io', ok: true, rttMillis: 38, checkedAt: now},
        },
        updates: {pending: 1, rebootRequired: true, checkedAt: now, summary: 'macOS 15.5'},
        backups: {
          lastBackupAt: now - 3600,
          lastBackupBytes: 3 * 1024 * 1024,
          backupCount: 10,
          lastArchiveUploadAt: now - 3500,
        },
        database: {dbBytes: 8 * 1024 * 1024, walBytes: 512 * 1024},
        outboxPending: 2,
        daemonErrors: 0,
        podmanState: 'running',
      };

      // Unauthenticated and non-admin SSE connections are blocked.
      expect((await fetch(`${baseUrl}/api/admin/stream`)).status).toBe(401);
      expect((await fetch(`${baseUrl}/api/admin/stream`, {
        headers: {Cookie: cookieFor('pmariglia', 2002)},
      })).status).toBe(403);

      // Connect admin SSE stream and verify live broadcast upon heartbeat.
      const ctrl = new AbortController();
      const streamRes = await fetch(`${baseUrl}/api/admin/stream`, {
        headers: {Cookie: cookieFor('scheibo')},
        signal: ctrl.signal,
      });
      expect(streamRes.status).toBe(200);
      const reader = streamRes.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const readNextEvent = async (): Promise<Record<string, unknown>> => {
        for (;;) {
          const idx = buf.indexOf('\n\n');
          if (idx !== -1) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const dataLine = chunk.split('\n').find(l => l.startsWith('data: '));
            if (dataLine) return JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
          }
          const {value, done} = await reader.read();
          if (done) throw new Error('SSE stream ended unexpectedly');
          buf += decoder.decode(value, {stream: true});
        }
      };

      const initialEvent = await readNextEvent();
      expect(initialEvent.arena).toBeUndefined();
      expect(initialEvent.vps).toBeDefined();

      // Send Arena heartbeat with system payload.
      now += 15;
      const hbRes = await fetch(`${baseUrl}/api/arena/heartbeat`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ARENA_SECRET}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({idle: true, system: arenaSys}),
      });
      expect(hbRes.status).toBe(200);

      const updatedEvent = await readNextEvent();
      expect(updatedEvent.lastHeartbeatAt).toBe(now);
      expect((updatedEvent.arena as system.ArenaSystemInfo).hostname).toBe('arena-mini');
      expect(String(updatedEvent.cardsHtml)).toContain('/Volumes/Archive');
      expect(String(updatedEvent.cardsHtml)).toContain('UNMOUNTED');
      ctrl.abort();

      // Verify /admin HTML highlights degraded Arena metrics in-place inside the System card.
      const html = await (await fetch(`${baseUrl}/admin/`, {
        headers: {Cookie: cookieFor('scheibo')},
      })).text();
      expect(html).toContain('id="system"');
      expect(html).not.toContain('sys-card-crit');
      expect(html).toContain('UNMOUNTED');
      expect(html).toContain('Outbox 2');
      expect(html).toContain('Reboot required');
      expect(html).not.toContain('Needs Attention');

      // Verify public /api/live.json does NOT leak internal Arena system metrics.
      const liveText = await (await fetch(`${baseUrl}/api/live.json`)).text();
      expect(liveText).not.toContain('arena-mini');
      expect(liveText).not.toContain('/Volumes/Archive');
    }
  );

  test(
    'surfaces diagnostics, /info dots, CPU/faults, staged discard, and admin log endpoints',
    async () => {
      const adminCookie = cookieFor('scheibo');
      const nonAdminCookie = cookieFor('pmariglia', 2002);
      const zero = db.getAgentBySlug('0-error')!;
      const fp = db.getAgentBySlug('foul-play')!;

      const v1 = db.createSubmission({
        agentId: zero.id,
        version: '1.0.0',
        package: 'bundle',
        url: 'https://github.com/pkmn/0-error-1.0.0.tar.zst',
        sha256: SHA_A,
        ladderIds: ['gen1ou20261109'],
        now,
      });
      db.applySubmissionStatus({
        versionId: v1.id,
        smokeStatus: 'passed',
        smokeDurationMillis: 12000,
        smokeInitMillis: 180,
        smokeTurnMillis: 45,
        smokePeakRam: 512,
        diagnostics: [{
          ladderId: 'gen1ou20261109',
          format: 'gen1ou',
          turns: 14,
          endReason: 'win',
          durationMillis: 12000,
          battleLog: '|turn|1\n|ai|p1|{"win":0.62}\n|win|0 ERROR',
          p1Stderr: 'p1 ok',
          p2Stderr: 'p2 ok',
          p1CpuCores: 3.2,
          p2CpuCores: 3.1,
          p1PeakRam: 512,
          p2PeakRam: 490,
          supportsInfo: true,
        }],
        now: now + 5,
      });

      const fpV1 = db.createSubmission({
        agentId: fp.id,
        version: '1.0.0',
        package: 'bundle',
        url: 'https://github.com/pmariglia/fp-1.0.0.tar.zst',
        sha256: SHA_B,
        ladderIds: ['gen1ou20261109'],
        now,
      });
      db.applySubmissionStatus({
        versionId: fpV1.id,
        smokeStatus: 'passed',
        diagnostics: [{
          ladderId: 'gen1ou20261109',
          format: 'gen1ou',
          turns: 10,
          endReason: 'win',
          durationMillis: 8000,
          battleLog: '|turn|1\n|win|Foul Play',
          p1Stderr: 'fp p1 stderr',
          supportsInfo: false,
        }],
        now: now + 5,
      });

      // Record a match with CPU + invalid-choice forfeit + protocol errors.
      db.recordCompletedMatch({
        match: {
          id: 'gen1ou-0000001',
          ladderId: 'gen1ou20261109',
          p1VersionId: v1.id,
          p2VersionId: fpV1.id,
          seed: '1,2,3,4',
          game1Outcome: 'L',
          game2Outcome: 'W',
          category: 'LW',
          game1Turns: 8,
          game2Turns: 18,
          game1EndReason: 'invalid-choice',
          game2EndReason: 'win',
          p1Game1PeakRam: 512,
          p1Game2PeakRam: 640,
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
          p1CpuCores: 4.8,
          p2CpuCores: 1.5,
          p1Errors: {
            invalidCantMove: 2,
            invalidCantSwitch: 1,
            invalidTarget: 0,
            invalidOther: 0,
            unavailableChoices: 3,
          },
          completedAt: now + 20,
        },
      });

      // Settle v1, refund cooldown, and stage v2 for 0-error.
      now += 30;
      db.refundCooldown('0-error', now);
      db.db.prepare(
        'UPDATE ladder_entries SET settled_at = ?, matches = 25, se = 20 WHERE version_id = ?'
      ).run(now, v1.id);
      const staged = db.createSubmission({
        agentId: zero.id,
        version: '1.1.0',
        package: 'bundle',
        url: 'https://github.com/pkmn/0-error-1.1.0.tar.zst',
        sha256: SHA_B,
        ladderIds: ['gen1ou20261109'],
        now: now + 5,
      });
      db.applySubmissionStatus({
        versionId: staged.id,
        smokeStatus: 'staged',
        smokeDurationMillis: 9500,
        smokeInitMillis: 140,
        smokeTurnMillis: 32,
        smokePeakRam: 420,
        diagnostics: [{
          ladderId: 'gen1ou20261109',
          format: 'gen1ou',
          turns: 12,
          endReason: 'win',
          durationMillis: 9500,
          battleLog: '|turn|1\n|ai|p1|{"win":0.58}\n|win|0 ERROR',
          p1Stderr: 'staged p1 stderr',
          p2Stderr: 'staged p2 stderr',
          p1CpuCores: 2.9,
          p2CpuCores: 2.8,
          p1PeakRam: 420,
          p2PeakRam: 410,
          supportsInfo: true,
        }],
        now: now + 10,
      });
      const stagedDiag = db.getSmokeDiagnosticsForVersion(staged.id)[0];

      // 1. HTML renders /info dots, CPU telemetry, invalid-choice + proto err, staged state, links.
      const html = await (await fetch(`${baseUrl}/admin/`, {
        headers: {Cookie: adminCookie},
      })).text();
      expect(html).toContain('class="info-dot yes"');
      expect(html).toContain('class="info-dot muted"');
      expect(html).toContain('4.8 CPU');
      expect(html).toContain('Invalid choice: 1');
      expect(html).toContain('Can&#39;t move: 2');
      expect(html).toContain('Can&#39;t switch: 1');
      expect(html).toContain('<span class="no">1</span>');
      expect(html).toContain('1.1.0 [staged]');
      expect(html).toContain('PASS</span> <span class="warn">(staged)</span>');
      expect(html).toContain('data-action="discard"');
      expect(html).toContain(`/api/admin/diagnostics/${stagedDiag.id}/stderr`);
      expect(html).toContain(`/api/admin/diagnostics/${stagedDiag.id}/log?download=1`);

      // 2. /admin.json includes stagedCount, entry CPU/faults, and version diagnostic summaries.
      const snap = await (await fetch(`${baseUrl}/admin.json`, {
        headers: {Cookie: adminCookie},
      })).json() as admin.AdminSnapshot;
      expect(snap.health.stagedCount).toBe(1);
      const zeroSnap = snap.agents.find(a => a.agent.slug === '0-error')!;
      expect(zeroSnap.entries[0].meanCpuCores).toBeCloseTo(4.8, 5);
      expect(zeroSnap.entries[0].invalidChoices).toBe(1);
      expect(zeroSnap.entries[0].invalidCantMove).toBe(2);
      expect(zeroSnap.entries[0].smokeSupportsInfo).toBe(true);
      const stagedVer = zeroSnap.versions.find(v => v.id === staged.id)!;
      expect(stagedVer.smokeStatus).toBe('staged');
      expect(stagedVer.smokeSupportsInfo).toBe(true);
      expect(stagedVer.diagnostics).toHaveLength(1);

      // 3. Diagnostic log/stderr endpoints enforce admin auth and serve JSON / attachments.
      expect((await fetch(`${baseUrl}/api/admin/diagnostics/${stagedDiag.id}/log`)).status).toBe(
        401
      );
      expect((await fetch(`${baseUrl}/api/admin/diagnostics/${stagedDiag.id}/log`, {
        headers: {Cookie: nonAdminCookie},
      })).status).toBe(403);
      expect((await fetch(`${baseUrl}/api/admin/diagnostics/${stagedDiag.id}/stderr`, {
        headers: {Cookie: nonAdminCookie},
      })).status).toBe(403);

      const logJson = await (await fetch(`${baseUrl}/api/admin/diagnostics/${stagedDiag.id}/log`, {
        headers: {Cookie: adminCookie},
      })).json() as {id: number; lines: string[]; p1CpuCores?: number};
      expect(logJson.id).toBe(stagedDiag.id);
      expect(logJson.lines).toContain('|ai|p1|{"win":0.58}');
      expect(logJson.p1CpuCores).toBe(2.9);

      const logDownload = await fetch(
        `${baseUrl}/api/admin/diagnostics/${stagedDiag.id}/log?download=1`,
        {headers: {Cookie: adminCookie}}
      );
      expect(logDownload.status).toBe(200);
      expect(logDownload.headers.get('content-disposition')).toContain('0-error-1.1.0-gen1ou.log');
      expect(await logDownload.text()).toContain('|win|0 ERROR');

      const stderrRes = await fetch(
        `${baseUrl}/api/admin/diagnostics/${stagedDiag.id}/stderr`,
        {headers: {Cookie: adminCookie}}
      );
      expect(stderrRes.status).toBe(200);
      const stderrText = await stderrRes.text();
      expect(stderrText).toContain('staged p1 stderr');
      expect(stderrText).toContain('staged p2 stderr');

      // 4. Discard endpoint enforces admin + CSRF, transitions staged -> discarded, frees label.
      expect((await fetch(`${baseUrl}/api/admin/versions/${staged.id}/discard`, {
        method: 'POST',
        headers: {Cookie: nonAdminCookie, 'Content-Type': 'application/json'},
      })).status).toBe(403);
      expect((await fetch(`${baseUrl}/api/admin/versions/${staged.id}/discard`, {
        method: 'POST',
        headers: {
          Cookie: adminCookie,
          'Content-Type': 'application/json',
          'Sec-Fetch-Site': 'cross-site',
        },
      })).status).toBe(403);

      const discardRes = await fetch(`${baseUrl}/api/admin/versions/${staged.id}/discard`, {
        method: 'POST',
        headers: {Cookie: adminCookie, 'Content-Type': 'application/json'},
      });
      expect(discardRes.status).toBe(200);
      expect(db.getVersionById(staged.id)?.smokeStatus).toBe('discarded');
      expect(db.isVersionClaimed(zero.id, '1.1.0')).toBe(false);

      // Re-discarding a non-staged version fails with 409.
      const againRes = await fetch(`${baseUrl}/api/admin/versions/${staged.id}/discard`, {
        method: 'POST',
        headers: {Cookie: adminCookie, 'Content-Type': 'application/json'},
      });
      expect(againRes.status).toBe(409);

      const afterHtml = await (await fetch(`${baseUrl}/admin/`, {
        headers: {Cookie: adminCookie},
      })).text();
      expect(afterHtml).toContain('Discarded');
      expect(afterHtml).not.toContain('1.1.0 [staged]');
    }
  );

  test('/admin SSE script invokes pkmnTime.localize instead of removed helper', async () => {
    const html = await (await fetch(`${baseUrl}/admin/`, {
      headers: {Cookie: cookieFor('scheibo')},
    })).text();
    expect(html).toContain('pkmnTime.localize(sysCards)');
    expect(html).not.toContain('localizeTimestamps(');
  });

  test('HEAD /api/admin/stream closes with private no-store without leaking client', async () => {
    const res = await fetch(`${baseUrl}/api/admin/stream`, {
      method: 'HEAD',
      headers: {Cookie: cookieFor('scheibo')},
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('private, no-store, no-transform');
    expect(adminHandle.getAdminStreamCount()).toBe(0);
  });

  test('enforces auth, admin role, or CSRF rejection across all admin routes',
    async () => {
      const nonAdminCookie = cookieFor('pmariglia', 2002);
      const adminCookie = cookieFor('scheibo');
      const postEndpoints = [
        {path: '/api/admin/agents/newcomer/ladders', body: {slot: 'rby', qualified: true}},
        {path: '/api/admin/agents/newcomer/refund-cooldown', body: {}},
        {path: '/api/admin/versions/1/discard', body: {}},
        {path: '/api/admin/versions/0-error/1.0/quarantine', body: {reason: 'test'}},
        {path: '/api/admin/versions/0-error/1.0/unquarantine', body: {}},
        {path: '/api/admin/ladders/gen1ou20261109/entries/0-error/1.0/retire', body: {}},
      ];
      for (const ep of postEndpoints) {
        const unauth = await fetch(`${baseUrl}${ep.path}`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(ep.body),
        });
        expect(unauth.status).toBe(401);

        const nonAdmin = await fetch(`${baseUrl}${ep.path}`, {
          method: 'POST',
          headers: {Cookie: nonAdminCookie, 'Content-Type': 'application/json'},
          body: JSON.stringify(ep.body),
        });
        expect(nonAdmin.status).toBe(403);

        const csrf = await fetch(`${baseUrl}${ep.path}`, {
          method: 'POST',
          headers: {
            Cookie: adminCookie,
            'Content-Type': 'application/json',
            'Sec-Fetch-Site': 'cross-site',
          },
          body: JSON.stringify(ep.body),
        });
        expect(csrf.status).toBe(403);
      }

      const getEndpoints = [
        '/admin/index.json',
        '/api/admin/stream',
        '/api/admin/diagnostics/1/log',
        '/api/admin/diagnostics/1/stderr',
      ];
      for (const ep of getEndpoints) {
        expect((await fetch(`${baseUrl}${ep}`)).status).toBe(401);
        expect((await fetch(`${baseUrl}${ep}`, {headers: {Cookie: nonAdminCookie}})).status)
          .toBe(403);
      }
    });
});
