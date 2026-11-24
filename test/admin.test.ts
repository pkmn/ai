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
      expect(db.computeAgentSubmissionStatus(zero.id, now + 10).nextEligibleAt).toBeDefined();
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
      ).run(now + 10, v1.id);
      const v2 = db.createSubmission({
        agentId: zero.id,
        version: '1.1.0',
        package: 'bundle',
        url: 'https://github.com/pkmn/0-error-1.1.0.tar.zst',
        sha256: SHA_B,
        ladderIds: ['gen1ou20261109'],
        now: now + 20,
      });
      db.applySubmissionStatus({versionId: v2.id, smokeStatus: 'passed', now: now + 25});

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
            ioBytesPerSec: 2 * 1024 * 1024,
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
          rxBytesPerSec: 12000,
          txBytesPerSec: 8000,
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
});
