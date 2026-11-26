import {execFileSync} from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import polka from 'polka';

import {ALL_SLOTS, Database} from '../db';
import * as admin from '../server/admin';
import * as arena from '../server/arena';
import * as auth from '../server/auth';
import * as system from '../server/system';
import * as wiki from '../server/wiki';
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
    server.keepAliveTimeout = 65_000;
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

  test('redirects unauthenticated /admin HTML requests to GitHub login', async () => {
    const anonHtml = await fetch(`${baseUrl}/admin/`, {redirect: 'manual'});
    expect(anonHtml.status).toBe(302);
    expect(anonHtml.headers.get('location')).toBe('/auth/github?return_to=%2Fadmin%2F');
  });

  test('returns 401 on unauthenticated /admin.json requests', async () => {
    const anonJson = await fetch(`${baseUrl}/admin.json`);
    expect(anonJson.status).toBe(401);
  });

  test('blocks non-admin authenticated users with 403 across /admin endpoints', async () => {
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

  test('renders noindex HTML dashboard for authenticated admins', async () => {
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
  });

  test('serves matching /admin.json alongside /admin/index.json snapshots', async () => {
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

  test('toggles per-ladder eligibility via admin API', async () => {
    const enableRes = await fetch(`${baseUrl}/api/admin/agents/newcomer/ladders`, {
      method: 'POST',
      headers: {Cookie: cookieFor('scheibo'), 'Content-Type': 'application/json'},
      body: JSON.stringify({slot: 'vgc', qualified: true}),
    });
    expect(enableRes.status).toBe(200);
    const enableData = await enableRes.json() as {
      qualifiedLadders: string[];
      submissionStatus: {label: string; canSubmit: boolean};
    };
    expect(enableData.qualifiedLadders).toEqual(['vgc']);
    expect(enableData.submissionStatus.label).toBe('Eligible');
  });

  test('refunds submission cooldown via admin API', async () => {
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
    now += 10;
    expect(db.computeAgentSubmissionStatus(zero.id, now).nextEligibleAt).toBeDefined();
    const refundRes = await fetch(`${baseUrl}/api/admin/agents/0-error/refund-cooldown`, {
      method: 'POST',
      headers: {Cookie: cookieFor('scheibo'), 'Content-Type': 'application/json'},
      body: '{}',
    });
    expect(refundRes.status).toBe(200);
    expect(db.getAgentById(zero.id)?.cooldownRefundedAt).toBe(now);
  });

  test('disables 3/24h smoke-test rate limit via admin API', async () => {
    const zero = db.getAgentBySlug('0-error')!;
    for (let i = 1; i <= 3; i++) {
      const v = db.createSubmission({
        agentId: zero.id,
        version: `0.1.${i}`,
        package: 'bundle',
        url: `https://github.com/pkmn/0-error-0.1.${i}.tar.zst`,
        sha256: SHA_A,
        ladderIds: ['gen1ou20261109'],
        now: now + i * 10,
      });
      db.applySubmissionStatus({
        versionId: v.id,
        smokeStatus: 'failed',
        smokeError: 'boom',
        now: now + i * 10 + 5,
      });
    }
    now += 100;
    expect(db.computeAgentSubmissionStatus(zero.id, now).canSubmit).toBe(false);

    const res = await fetch(`${baseUrl}/api/admin/agents/0-error/smoke-limit`, {
      method: 'POST',
      headers: {Cookie: cookieFor('scheibo'), 'Content-Type': 'application/json'},
      body: JSON.stringify({unlimited: true}),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as {
      ok: boolean;
      agent: {unlimitedSmokeTests: boolean};
      submissionStatus: {label: string; canSubmit: boolean; nextEligibleAt?: number};
    };
    expect(data.ok).toBe(true);
    expect(data.agent.unlimitedSmokeTests).toBe(true);
    expect(data.submissionStatus).toEqual({label: 'Eligible', canSubmit: true});
    expect(db.getAgentById(zero.id)?.unlimitedSmokeTests).toBe(true);
  });

  test('re-enables 3/24h smoke-test rate limit via admin API', async () => {
    const zero = db.getAgentBySlug('0-error')!;
    db.setUnlimitedSmokeTests('0-error', true, now);
    const res = await fetch(`${baseUrl}/api/admin/agents/0-error/smoke-limit`, {
      method: 'POST',
      headers: {Cookie: cookieFor('scheibo'), 'Content-Type': 'application/json'},
      body: JSON.stringify({unlimited: false}),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as {agent: {unlimitedSmokeTests: boolean}};
    expect(data.agent.unlimitedSmokeTests).toBe(false);
    expect(db.getAgentById(zero.id)?.unlimitedSmokeTests).toBe(false);
  });

  test('rejects invalid smoke-limit admin API payloads with 400 or 404', async () => {
    const adminCookie = cookieFor('scheibo');
    const badBody = await fetch(`${baseUrl}/api/admin/agents/0-error/smoke-limit`, {
      method: 'POST',
      headers: {Cookie: adminCookie, 'Content-Type': 'application/json'},
      body: JSON.stringify({unlimited: 'yes'}),
    });
    expect(badBody.status).toBe(400);

    const missingAgent = await fetch(`${baseUrl}/api/admin/agents/nope/smoke-limit`, {
      method: 'POST',
      headers: {Cookie: adminCookie, 'Content-Type': 'application/json'},
      body: JSON.stringify({unlimited: true}),
    });
    expect(missingAgent.status).toBe(404);

    db.db.prepare("UPDATE agents SET status = 'disabled' WHERE slug = 'newcomer'").run();
    const disabledAgent = await fetch(`${baseUrl}/api/admin/agents/newcomer/smoke-limit`, {
      method: 'POST',
      headers: {Cookie: adminCookie, 'Content-Type': 'application/json'},
      body: JSON.stringify({unlimited: true}),
    });
    expect(disabledAgent.status).toBe(400);
  });

  test('renders 3/24h smoke-limit toggle buttons on /admin dashboard', async () => {
    db.setUnlimitedSmokeTests('foul-play', true, now);
    const html = await (await fetch(`${baseUrl}/admin/`, {
      headers: {Cookie: cookieFor('scheibo')},
    })).text();
    expect(html).toContain('data-action="smoke-limit"');
    expect(html).toContain('>Limited</button>');
    expect(html).toContain('>Unlimited</button>');
    expect(html).toContain('3/24h limit disabled.');

    const snap = await (await fetch(`${baseUrl}/admin.json`, {
      headers: {Cookie: cookieFor('scheibo')},
    })).json() as admin.AdminSnapshot;
    const fp = snap.agents.find(a => a.agent.slug === 'foul-play')!;
    const zero = snap.agents.find(a => a.agent.slug === '0-error')!;
    expect(fp.agent.unlimitedSmokeTests).toBe(true);
    expect(zero.agent.unlimitedSmokeTests).toBe(false);
  });

  test('quarantines then unquarantines a version via admin API', async () => {
    const adminCookie = cookieFor('scheibo');
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

    const qRes = await fetch(`${baseUrl}/api/admin/versions/0-error/1.0.0/quarantine`, {
      method: 'POST',
      headers: {Cookie: adminCookie, 'Content-Type': 'application/json'},
      body: JSON.stringify({reason: 'Turn timeout loop'}),
    });
    expect(qRes.status).toBe(200);
    expect(db.getVersionById(v1.id)?.smokeStatus).toBe('quarantined');
    expect(db.getVersionById(v1.id)?.smokeError).toBe('Turn timeout loop');

    const uqRes = await fetch(`${baseUrl}/api/admin/versions/0-error/1.0.0/unquarantine`, {
      method: 'POST',
      headers: {Cookie: adminCookie, 'Content-Type': 'application/json'},
      body: '{}',
    });
    expect(uqRes.status).toBe(200);
    expect(db.getVersionById(v1.id)?.smokeStatus).toBe('passed');
  });

  test('retires a non-anchor entry while rejecting anchor retirement with 400', async () => {
    const adminCookie = cookieFor('scheibo');
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
    db.refundCooldown('0-error', now + 10);
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
      now: now + 12,
    });
    db.applySubmissionStatus({versionId: v2.id, smokeStatus: 'passed', now: now + 15});

    const retireAnchorRes = await fetch(
      `${baseUrl}/api/admin/ladders/gen1ou20261109/entries/0-error/1.0.0/retire`,
      {method: 'POST', headers: {Cookie: adminCookie, 'Content-Type': 'application/json'}}
    );
    expect(retireAnchorRes.status).toBe(400);

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
  });

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
    'streams heartbeat Arena telemetry over /api/admin/stream without leaking to /api/live.json',
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
    'exposes diagnostics, /info dots, CPU/faults, staged discard via /admin endpoints',
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
          infoStatus: 'full',
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
          infoStatus: 'none',
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
          infoStatus: 'partial',
        }],
        now: now + 10,
      });
      const stagedDiag = db.getSmokeDiagnosticsForVersion(staged.id)[0];

      // 1. HTML renders /info dots, CPU telemetry, invalid-choice + proto err, staged state, links.
      const html = await (await fetch(`${baseUrl}/admin/`, {
        headers: {Cookie: adminCookie},
      })).text();
      expect(html).toContain('class="info-dot full yes"');
      expect(html).toContain('class="info-dot partial yes"');
      expect(html).toContain('class="info-dot none muted"');
      expect(html).toContain('4.8 CPU');
      expect(html).toContain('Invalid choice: 1');
      expect(html).toContain('Can&#39;t move: 2');
      expect(html).toContain('Can&#39;t switch: 1');
      expect(html).toContain('<span class="no">1</span>');
      const stagedChip =
        '<span class="chip chip-warn" ' +
        'title="Staged version 1.1.0 awaiting owner activation or discard">1.1.0</span>';
      expect(html).toContain(stagedChip);
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
      expect(zeroSnap.entries[0].smokeInfoStatus).toBe('full');
      const stagedVer = zeroSnap.versions.find(v => v.id === staged.id)!;
      expect(stagedVer.smokeStatus).toBe('staged');
      expect(stagedVer.smokeInfoStatus).toBe('partial');
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
      })).json() as {
        id: number;
        lines: string[];
        p1Lines: string[];
        p2Lines: string[];
        p1CpuCores?: number;
      };
      expect(logJson.id).toBe(stagedDiag.id);
      expect(logJson.lines).toContain('|ai|p1|{"win":0.58}');
      expect(logJson.p1Lines).toContain('|ai|p1|{"win":0.58}');
      expect(logJson.p2Lines).toContain('|ai|p1|{"win":0.58}');
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
      expect(afterHtml).not.toContain(stagedChip);
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

  test('hides Projects pager at <= 25 rows and server-side paginates past 25', async () => {
    const cookie = cookieFor('scheibo');
    const smallHtml = await (await fetch(`${baseUrl}/admin/`, {headers: {Cookie: cookie}})).text();
    expect(smallHtml).toContain('class="pager hide" id="projects-pager"');

    // Insert 25 additional agents (28 total) so Projects spans 2 pages of 25.
    const insertAgent = db.db.prepare(
      `INSERT INTO agents (slug, name, status, updated_at)
       VALUES (?, ?, 'pending', ?)`
    );
    for (let i = 1; i <= 25; i++) {
      const num = String(i).padStart(2, '0');
      insertAgent.run(`z-agent-${num}`, `Z Agent ${num}`, now);
    }

    const html = await (await fetch(`${baseUrl}/admin/`, {headers: {Cookie: cookie}})).text();
    expect(html).toContain('Projects (<span id="projects-total">28</span>)');
    expect(html).toContain('class="pager" id="projects-pager"');
    expect(html).toContain('Page 1 of 2 (28 projects)');
    expect(html).toContain('Z Agent 22');
    expect(html).not.toContain('Z Agent 23');

    const snapshot = await (await fetch(`${baseUrl}/admin.json`, {
      headers: {Cookie: cookie},
    })).json() as admin.AdminSnapshot;
    expect(snapshot.agents).toHaveLength(25);
    expect(snapshot.totalAgents).toBe(28);

    const p2Res = await fetch(`${baseUrl}/api/admin/projects.json?page=2&limit=25`, {
      headers: {Cookie: cookie},
    });
    expect(p2Res.status).toBe(200);
    const p2 = await p2Res.json() as {
      page: number;
      pageSize: number;
      total: number;
      totalPages: number;
      hasPrev: boolean;
      hasNext: boolean;
      projects: admin.AdminAgentItem[];
      rowsHtml: string;
    };
    expect(p2.page).toBe(2);
    expect(p2.pageSize).toBe(25);
    expect(p2.total).toBe(28);
    expect(p2.totalPages).toBe(2);
    expect(p2.hasPrev).toBe(true);
    expect(p2.hasNext).toBe(false);
    expect(p2.projects.map(p => p.agent.slug)).toEqual(['z-agent-23', 'z-agent-24', 'z-agent-25']);
    expect(p2.rowsHtml).toContain('Z Agent 23');
    expect(p2.rowsHtml).toContain('Z Agent 25');
    expect(p2.rowsHtml).toContain('data-detail-for="z-agent-23"');

    const badPage = await fetch(`${baseUrl}/api/admin/projects.json?page=0`, {
      headers: {Cookie: cookie},
    });
    expect(badPage.status).toBe(400);
    const badLimit = await fetch(`${baseUrl}/api/admin/projects.json?limit=500`, {
      headers: {Cookie: cookie},
    });
    expect(badLimit.status).toBe(400);
  });

  test('enforces auth, admin role, or CSRF rejection across all admin routes',
    async () => {
      const nonAdminCookie = cookieFor('pmariglia', 2002);
      const adminCookie = cookieFor('scheibo');
      const postEndpoints = [
        {path: '/api/admin/agents/newcomer/ladders', body: {slot: 'rby', qualified: true}},
        {path: '/api/admin/agents/newcomer/refund-cooldown', body: {}},
        {path: '/api/admin/agents/newcomer/smoke-limit', body: {unlimited: true}},
        {
          path: '/api/admin/agents/foul-play/pools/gen9championsvgc2026regmc/wipe',
          body: {},
        },
        {path: '/api/admin/versions/1/discard', body: {}},
        {path: '/api/admin/versions/1/wipe', body: {}},
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
        '/api/admin/projects.json',
        '/api/admin/wiki-edits.json',
        '/api/admin/diagnostics/1/log',
        '/api/admin/diagnostics/1/stderr',
      ];
      for (const ep of getEndpoints) {
        expect((await fetch(`${baseUrl}${ep}`)).status).toBe(401);
        expect((await fetch(`${baseUrl}${ep}`, {headers: {Cookie: nonAdminCookie}})).status)
          .toBe(403);
      }
    });

  test('wipes an upcoming unplayed version via admin API while blocking live-ladder versions',
    async () => {
      const adminCookie = cookieFor('scheibo');
      db.db.prepare("UPDATE ladders SET status = 'upcoming' WHERE id = 'gen3ou20261109'").run();
      const a1 = db.getAgentBySlug('0-error')!;
      const a2 = db.getAgentBySlug('foul-play')!;
      const a3 = db.getAgentBySlug('newcomer')!;
      db.setAgentLadders('newcomer', ['rby'], now);
      const vUpcoming = db.createSubmission({
        agentId: a1.id,
        version: '0.1',
        package: 'bundle',
        url: 'https://example.com/0-error-0.1.tar.zst',
        sha256: SHA_A,
        ladderIds: ['gen3ou20261109'],
        now,
      });
      const vLiveUnplayed = db.createSubmission({
        agentId: a2.id,
        version: '1.0',
        package: 'bundle',
        url: 'https://example.com/fp-1.0.tar.zst',
        sha256: SHA_B,
        ladderIds: ['gen1ou20261109'],
        now,
      });
      const vStaged = db.createSubmission({
        agentId: a3.id,
        version: '0.2',
        package: 'bundle',
        url: 'https://example.com/newcomer-0.2.tar.zst',
        sha256: SHA_A,
        ladderIds: ['gen1ou20261109'],
        now,
      });
      db.applySubmissionStatus({versionId: vUpcoming.id, smokeStatus: 'passed', now: now + 10});
      db.applySubmissionStatus({versionId: vLiveUnplayed.id, smokeStatus: 'passed', now: now + 10});
      db.applySubmissionStatus({versionId: vStaged.id, smokeStatus: 'staged', now: now + 10});

      const htmlRes = await fetch(`${baseUrl}/admin`, {headers: {Cookie: adminCookie}});
      const html = await htmlRes.text();
      expect(html).toContain(`data-action="wipe" data-version-id="${vUpcoming.id}"`);
      expect(html).toContain(`data-action="wipe" data-version-id="${vStaged.id}"`);
      expect(html).not.toContain(`data-action="wipe" data-version-id="${vLiveUnplayed.id}"`);

      const blocked = await fetch(`${baseUrl}/api/admin/versions/${vLiveUnplayed.id}/wipe`, {
        method: 'POST',
        headers: {Cookie: adminCookie, 'Content-Type': 'application/json'},
        body: '{}',
      });
      expect(blocked.status).toBe(409);
      expect(db.getVersionById(vLiveUnplayed.id)).toBeDefined();

      const okUpcoming = await fetch(`${baseUrl}/api/admin/versions/${vUpcoming.id}/wipe`, {
        method: 'POST',
        headers: {Cookie: adminCookie, 'Content-Type': 'application/json'},
        body: '{}',
      });
      expect(okUpcoming.status).toBe(200);
      expect(db.getVersionById(vUpcoming.id)).toBeUndefined();

      const okStaged = await fetch(`${baseUrl}/api/admin/versions/${vStaged.id}/wipe`, {
        method: 'POST',
        headers: {Cookie: adminCookie, 'Content-Type': 'application/json'},
        body: '{}',
      });
      expect(okStaged.status).toBe(200);
      expect(db.getVersionById(vStaged.id)).toBeUndefined();
    });

  test('renders saved-pool Wipe button only when pools ladder is upcoming without active teams',
    async () => {
      const adminCookie = cookieFor('scheibo');
      const vgcId = 'gen9championsvgc2026regmc';
      const fp = db.getAgentBySlug('foul-play')!;
      const teams = Array.from({length: 20}, (_, i) => `Team${i + 1}|`);
      db.replaceSavedTeams(vgcId, fp.id, teams, now);

      const activeHtml = await (await fetch(`${baseUrl}/admin`, {
        headers: {Cookie: adminCookie},
      })).text();
      expect(activeHtml).toContain('VGC: 20/20 teams (saved)');
      expect(activeHtml).not.toContain('data-action="wipe-pool"');

      db.db.prepare("UPDATE ladders SET status = 'upcoming' WHERE id = ?").run(vgcId);
      const upcomingHtml = await (await fetch(`${baseUrl}/admin`, {
        headers: {Cookie: adminCookie},
      })).text();
      expect(upcomingHtml).toContain('VGC: 20/20 teams (saved)');
      expect(upcomingHtml).toContain(
        `data-action="wipe-pool" data-agent="foul-play" data-ladder="${vgcId}"`
      );
    });

  test('wipes upcoming saved pool teams via admin API', async () => {
    const adminCookie = cookieFor('scheibo');
    const vgcId = 'gen9championsvgc2026regmc';
    const fp = db.getAgentBySlug('foul-play')!;
    const teams = Array.from({length: 20}, (_, i) => `Team${i + 1}|`);
    db.db.prepare("UPDATE ladders SET status = 'upcoming' WHERE id = ?").run(vgcId);
    db.replaceSavedTeams(vgcId, fp.id, teams, now);

    const res = await fetch(`${baseUrl}/api/admin/agents/foul-play/pools/${vgcId}/wipe`, {
      method: 'POST',
      headers: {Cookie: adminCookie, 'Content-Type': 'application/json'},
      body: '{}',
    });
    expect(res.status).toBe(200);
    const data = await res.json() as {ok: boolean; wipedCount: number; ladderId: string};
    expect(data).toMatchObject({ok: true, wipedCount: 20, ladderId: vgcId});
    expect(db.getTeamsForAgentLadder(vgcId, fp.id)).toEqual([]);
  });

  test('rejects admin API pool wipe on an active ladder with 409', async () => {
    const adminCookie = cookieFor('scheibo');
    const vgcId = 'gen9championsvgc2026regmc';
    const fp = db.getAgentBySlug('foul-play')!;
    const teams = Array.from({length: 20}, (_, i) => `Team${i + 1}|`);
    db.replaceSavedTeams(vgcId, fp.id, teams, now);

    const res = await fetch(`${baseUrl}/api/admin/agents/foul-play/pools/${vgcId}/wipe`, {
      method: 'POST',
      headers: {Cookie: adminCookie, 'Content-Type': 'application/json'},
      body: '{}',
    });
    expect(res.status).toBe(409);
    expect(db.getTeamsForAgentLadder(vgcId, fp.id, 'saved')).toHaveLength(20);
  });

  test('renders aggregate 24h match total in Ladders header', async () => {
    const adminCookie = cookieFor('scheibo');
    const zero = db.getAgentBySlug('0-error')!;
    const fp = db.getAgentBySlug('foul-play')!;
    const vZero = db.createSubmission({
      agentId: zero.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://github.com/pkmn/0-error-1.0.0.tar.zst',
      sha256: SHA_A,
      ladderIds: ['gen1ou20261109', 'gen3ou20261109'],
      now: now - 48 * 3600,
    });
    db.applySubmissionStatus({versionId: vZero.id, smokeStatus: 'passed', now: now - 48 * 3600});
    const vFp = db.createSubmission({
      agentId: fp.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://github.com/pkmn/fp-1.0.0.tar.zst',
      sha256: SHA_B,
      ladderIds: ['gen1ou20261109', 'gen3ou20261109'],
      now: now - 48 * 3600,
    });
    db.applySubmissionStatus({versionId: vFp.id, smokeStatus: 'passed', now: now - 48 * 3600});

    const addMatch = (id: string, ladderId: string, completedAt: number) => {
      db.recordCompletedMatch({
        match: {
          id,
          ladderId,
          p1VersionId: vZero.id,
          p2VersionId: vFp.id,
          seed: '1,2,3,4',
          game1Outcome: 'W',
          game2Outcome: 'W',
          category: 'WW',
          game1Turns: 12,
          game2Turns: 14,
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
          p1Game1MeanTurnMillis: 40,
          p1Game2MeanTurnMillis: 40,
          p2Game1MeanTurnMillis: 40,
          p2Game2MeanTurnMillis: 40,
          completedAt,
        },
      });
    };

    addMatch('rby-old', 'gen1ou20261109', now - 36 * 3600);
    addMatch('rby-recent', 'gen1ou20261109', now - 3600);
    addMatch('adv-recent', 'gen3ou20261109', now - 1800);

    const html = await (await fetch(`${baseUrl}/admin/`, {
      headers: {Cookie: adminCookie},
    })).text();
    expect(html).toContain('>2/3</span>');

    const snap = await (await fetch(`${baseUrl}/admin.json`, {
      headers: {Cookie: adminCookie},
    })).json() as admin.AdminSnapshot;
    expect(snap.matches24h).toBe(2);
    expect(snap.totalMatches).toBe(3);
  });

  test('renders 24h diagnostic run summary in Projects header', async () => {
    const adminCookie = cookieFor('scheibo');
    const zero = db.getAgentBySlug('0-error')!;
    const fp = db.getAgentBySlug('foul-play')!;
    db.setAgentLadders('newcomer', ['rby'], now - 48 * 3600);
    const newcomer = db.getAgentBySlug('newcomer')!;

    const vFail = db.createSubmission({
      agentId: zero.id,
      version: '0.1.0-bad',
      package: 'bundle',
      url: 'https://github.com/pkmn/0-error-bad.tar.zst',
      sha256: SHA_A,
      ladderIds: ['gen1ou20261109'],
      now: now - 3 * 3600,
    });
    db.applySubmissionStatus({
      versionId: vFail.id,
      smokeStatus: 'failed',
      smokeError: 'Boot error',
      now: now - 3 * 3600 + 10,
    });

    const vPass = db.createSubmission({
      agentId: zero.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://github.com/pkmn/0-error-1.0.0.tar.zst',
      sha256: SHA_B,
      ladderIds: ['gen1ou20261109'],
      now: now - 2 * 3600,
    });
    db.applySubmissionStatus({
      versionId: vPass.id,
      smokeStatus: 'passed',
      now: now - 2 * 3600 + 10,
    });

    const vStaged = db.createSubmission({
      agentId: fp.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://github.com/pkmn/fp-1.0.0.tar.zst',
      sha256: SHA_A,
      ladderIds: ['gen1ou20261109'],
      now: now - 3600,
    });
    db.applySubmissionStatus({
      versionId: vStaged.id,
      smokeStatus: 'staged',
      now: now - 3600 + 10,
    });

    db.createSubmission({
      agentId: newcomer.id,
      version: '0.1.0',
      package: 'bundle',
      url: 'https://github.com/pkmn/newcomer-0.1.0.tar.zst',
      sha256: SHA_B,
      ladderIds: ['gen1ou20261109'],
      now: now - 600,
    });

    const html = await (await fetch(`${baseUrl}/admin/`, {
      headers: {Cookie: adminCookie},
    })).text();
    expect(html).toContain('>3 runs (1 fail) · 1 activated</span>');

    const snap = await (await fetch(`${baseUrl}/admin.json`, {
      headers: {Cookie: adminCookie},
    })).json() as admin.AdminSnapshot;
    expect(snap.submissions).toMatchObject({
      submitted24h: 4,
      smokeRuns24h: 3,
      smokePassed24h: 2,
      smokeFailed24h: 1,
      activated24h: 1,
      pendingCount: 1,
      stagedCount: 1,
      totalActivated: 1,
    });
  });

  test('omits failure count in Projects header when no diagnostic runs failed', async () => {
    const adminCookie = cookieFor('scheibo');
    const zero = db.getAgentBySlug('0-error')!;
    const vPass = db.createSubmission({
      agentId: zero.id,
      version: '1.0.0',
      package: 'bundle',
      url: 'https://github.com/pkmn/0-error-1.0.0.tar.zst',
      sha256: SHA_A,
      ladderIds: ['gen1ou20261109'],
      now: now - 3600,
    });
    db.applySubmissionStatus({versionId: vPass.id, smokeStatus: 'passed', now: now - 3500});

    const html = await (await fetch(`${baseUrl}/admin/`, {
      headers: {Cookie: adminCookie},
    })).text();
    expect(html).toContain('>1 run · 1 activated</span>');
    expect(html).not.toContain('fail)');
  });

  test('renders configured smoke cadence variants in Arena System card', async () => {
    const adminCookie = cookieFor('scheibo');

    const defaultHtml = await (await fetch(`${baseUrl}/admin/`, {
      headers: {Cookie: adminCookie},
    })).text();
    expect(defaultHtml).toContain('Smoke 1/match');

    db.setSmokeCadence({maxPerCycle: 1, everyCycles: 5}, now);
    const throttledHtml = await (await fetch(`${baseUrl}/admin/`, {
      headers: {Cookie: adminCookie},
    })).text();
    expect(throttledHtml).toContain('Smoke 1/5 matches');

    db.setSmokeCadence({maxPerCycle: 3, everyCycles: 1}, now + 1);
    const burstHtml = await (await fetch(`${baseUrl}/admin/`, {
      headers: {Cookie: adminCookie},
    })).text();
    expect(burstHtml).toContain('Smoke 3/match');

    db.setSmokeCadence({maxPerCycle: 0, everyCycles: 1}, now + 2);
    const pausedHtml = await (await fetch(`${baseUrl}/admin/`, {
      headers: {Cookie: adminCookie},
    })).text();
    expect(pausedHtml).toContain('class="warn"');
    expect(pausedHtml).toContain('Smoke paused');

    const snap = await (await fetch(`${baseUrl}/admin.json`, {
      headers: {Cookie: adminCookie},
    })).json() as admin.AdminSnapshot;
    expect(snap.health.smokeCadence).toEqual({maxPerCycle: 0, everyCycles: 1});
  });

  test('streams configured smoke cadence over /api/admin/stream', async () => {
    const adminCookie = cookieFor('scheibo');
    db.setSmokeCadence({maxPerCycle: 2, everyCycles: 5}, now);

    const ctrl = new AbortController();
    const streamRes = await fetch(`${baseUrl}/api/admin/stream`, {
      headers: {Cookie: adminCookie},
      signal: ctrl.signal,
    });
    expect(streamRes.status).toBe(200);
    const reader = streamRes.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let eventData: Record<string, unknown> | undefined;
    while (!eventData) {
      const {value, done} = await reader.read();
      if (done) break;
      buf += decoder.decode(value, {stream: true});
      const idx = buf.indexOf('\n\n');
      if (idx !== -1) {
        const dataLine = buf.slice(0, idx).split('\n').find(l => l.startsWith('data: '));
        if (dataLine) eventData = JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
      }
    }
    ctrl.abort();

    expect(eventData?.smokeCadence).toEqual({maxPerCycle: 2, everyCycles: 5});
    expect(String(eventData?.cardsHtml)).toContain('Smoke 2/5 matches');
  });

  test('renders None in System Updates row when no updates are pending', () => {
    const base = admin.buildAdminSnapshot(db, 'scheibo', arenaHandle, now);
    const snap: admin.AdminSnapshot = {
      ...base,
      system: {
        ...base.system,
        vps: {
          ...base.system.vps,
          updates: {pending: 0, security: 0, rebootRequired: false, checkedAt: now},
        },
      },
    };
    const html = admin.renderAdminPage({snapshot: snap, allLadders: db.getLadders()});
    expect(html).toContain('<dt>Updates</dt><dd><span class="yes"');
    expect(html).toContain('>None</span>');
    expect(html).not.toContain('Up to date');
  });
});

describe('/admin recent wiki edits', () => {
  let tmpDir: string;
  let db: Database;
  let server: http.Server;
  let baseUrl: string;
  let adminHandle: admin.Handle;
  let activeSha: string;
  let deleteSha: string;

  const cookieFor = (login: string) => {
    const token = auth.signToken(
      {github: {id: 1001, login}, exp: Math.floor(Date.now() / 1000) + 3600},
      AUTH_CFG.sessionSecret
    );
    return `${auth.SESSION_COOKIE}=${encodeURIComponent(token)}`;
  };

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-admin-wiki-test-'));
    const wikiDir = path.join(tmpDir, 'wiki');
    const projectsFile = path.join(tmpDir, 'projects.yml');
    fs.mkdirSync(path.join(wikiDir, 'projects'), {recursive: true});
    fs.writeFileSync(projectsFile, PROJECTS_YAML, 'utf8');

    const git = (...args: string[]) => execFileSync('git', args, {cwd: wikiDir, stdio: 'pipe'});
    git('init');
    git('config', 'user.email', 'test@pkmn.ai');
    git('config', 'user.name', 'scheibo');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'gc.auto', '0');
    git('config', 'maintenance.auto', 'false');

    fs.writeFileSync(path.join(wikiDir, 'projects', '0_ERROR.dj'), '# 0 ERROR\n', 'utf8');
    git('add', 'projects/0_ERROR.dj');
    git('commit', '-m', 'Document 0 ERROR architecture');
    activeSha = git('rev-parse', 'HEAD').toString('utf8').trim();

    fs.writeFileSync(path.join(wikiDir, 'Draft.dj'), '# Draft\n', 'utf8');
    git('add', 'Draft.dj');
    git('commit', '-m', 'Create Draft');
    fs.unlinkSync(path.join(wikiDir, 'Draft.dj'));
    git('add', '-A');
    git('commit', '-m', 'Remove Draft');
    deleteSha = git('rev-parse', 'HEAD').toString('utf8').trim();

    db = new Database(':memory:');
    db.syncLadders(undefined, 1_760_000_000);
    db.syncProjectsFromYaml(PROJECTS_YAML, undefined, 1_760_000_000);

    const authHandler = new auth.Auth({config: AUTH_CFG, db});
    const wikiInstance = new wiki.Wiki({wikiDir, projectsFile, auth: authHandler, db, push: false});
    const app = polka();
    adminHandle = admin.register(app, {
      db,
      auth: authHandler,
      wiki: wikiInstance,
      now: () => 1_760_000_000,
    });
    server = http.createServer((req, res) => app.handler(req as polka.Request, res));
    server.keepAliveTimeout = 65_000;
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  });

  afterAll(async () => {
    adminHandle.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  test('GET /admin.json exposes recent wiki edits from the wiki repo', async () => {
    const res = await fetch(`${baseUrl}/admin.json`, {headers: {Cookie: cookieFor('scheibo')}});
    expect(res.status).toBe(200);
    const body = await res.json() as admin.AdminSnapshot;
    expect(body.wikiEdits).toHaveLength(3);
    expect(body.wikiEdits[0]).toMatchObject({
      sha: deleteSha,
      slug: 'Draft',
      deleted: true,
      subject: 'Remove Draft',
      displayAuthor: 'pre',
    });
    expect(body.wikiEdits[2]).toMatchObject({
      sha: activeSha,
      slug: 'projects/0_ERROR',
      title: '0 ERROR',
      pageHref: '/wiki/projects/0_ERROR',
      revisionHref: `/wiki/projects/0_ERROR/${activeSha}`,
      diffHref: `/wiki/projects/0_ERROR/${activeSha}?diff=1`,
    });
  });

  test('GET /admin/ renders recent wiki edits with revision diff links', async () => {
    const res = await fetch(`${baseUrl}/admin`, {headers: {Cookie: cookieFor('scheibo')}});
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="#wiki" class="subtle">Wiki</a>');
    expect(html).toContain('href="/wiki/projects/0_ERROR"');
    expect(html).toContain(`href="/wiki/projects/0_ERROR/${activeSha}"`);
    expect(html).toContain(`href="/wiki/projects/0_ERROR/${activeSha}?diff=1"`);
    expect(html).toContain('Document 0 ERROR architecture');
  });

  test('GET /admin/ omits snapshot links for deleted wiki edits', async () => {
    const res = await fetch(`${baseUrl}/admin`, {headers: {Cookie: cookieFor('scheibo')}});
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/wiki/Draft/history"');
    expect(html).toContain('(deleted)');
    expect(html).not.toContain(`href="/wiki/Draft/${deleteSha}"`);
    expect(html).toContain(`href="/wiki/Draft/${deleteSha}?diff=1"`);
    expect(html).toContain('class="pager hide" id="wiki-pager"');
  });

  test('server-side paginates /admin Wiki edits past 25 rows', async () => {
    const cookie = cookieFor('scheibo');
    const wikiDir = path.join(tmpDir, 'wiki');
    const git = (...args: string[]) => execFileSync('git', args, {cwd: wikiDir, stdio: 'pipe'});
    // Add 25 more file edits across multiple commits (including a 2-file commit) -> 28 total.
    const batch1: string[] = [];
    for (let i = 1; i <= 12; i++) {
      const name = `Note_${String(i).padStart(2, '0')}.dj`;
      fs.writeFileSync(path.join(wikiDir, name), `# Note ${i}\n`, 'utf8');
      batch1.push(name);
    }
    git('add', ...batch1);
    git('commit', '-m', 'Add Notes 1-12');
    const batch2: string[] = [];
    for (let i = 13; i <= 23; i++) {
      const name = `Note_${String(i).padStart(2, '0')}.dj`;
      fs.writeFileSync(path.join(wikiDir, name), `# Note ${i}\n`, 'utf8');
      batch2.push(name);
    }
    git('add', ...batch2);
    git('commit', '-m', 'Add Notes 13-23');
    fs.writeFileSync(path.join(wikiDir, 'Pair_A.dj'), '# Pair A\n', 'utf8');
    fs.writeFileSync(path.join(wikiDir, 'Pair_B.dj'), '# Pair B\n', 'utf8');
    git('add', 'Pair_A.dj', 'Pair_B.dj');
    git('commit', '-m', 'Add Pair A and B');

    const html = await (await fetch(`${baseUrl}/admin`, {headers: {Cookie: cookie}})).text();
    expect(html).toContain('class="pager" id="wiki-pager"');
    expect(html).toContain('Page 1 of 2 (28 edits)');
    expect(html).toContain('Add Pair A and B');
    expect(html).not.toContain('Document 0 ERROR architecture');

    const snapshot = await (await fetch(`${baseUrl}/admin.json`, {
      headers: {Cookie: cookie},
    })).json() as admin.AdminSnapshot;
    expect(snapshot.wikiEdits).toHaveLength(25);
    expect(snapshot.totalWikiEdits).toBe(28);

    const p2Res = await fetch(`${baseUrl}/api/admin/wiki-edits.json?page=2&limit=25`, {
      headers: {Cookie: cookie},
    });
    expect(p2Res.status).toBe(200);
    const p2 = await p2Res.json() as {
      page: number;
      pageSize: number;
      total: number;
      totalPages: number;
      hasPrev: boolean;
      hasNext: boolean;
      edits: wiki.RecentEdit[];
      rowsHtml: string;
    };
    expect(p2.page).toBe(2);
    expect(p2.pageSize).toBe(25);
    expect(p2.total).toBe(28);
    expect(p2.totalPages).toBe(2);
    expect(p2.hasPrev).toBe(true);
    expect(p2.hasNext).toBe(false);
    expect(p2.edits).toHaveLength(3);
    expect(p2.edits[2].subject).toBe('Document 0 ERROR architecture');
    expect(p2.rowsHtml).toContain('Document 0 ERROR architecture');
    expect(p2.rowsHtml).toContain('Remove Draft');

    const badPage = await fetch(`${baseUrl}/api/admin/wiki-edits.json?page=abc`, {
      headers: {Cookie: cookie},
    });
    expect(badPage.status).toBe(400);
  });
});

describe('/admin registration issue polling', () => {
  const cookieFor = (login: string) => {
    const token = auth.signToken(
      {github: {id: 1001, login}, exp: Math.floor(Date.now() / 1000) + 3600},
      AUTH_CFG.sessionSecret
    );
    return `${auth.SESSION_COOKIE}=${encodeURIComponent(token)}`;
  };

  test('parseRegistrationIssues filters PRs, ignores untrusted URLs, and sorts by updatedAt',
    () => {
      const parsed = admin.parseRegistrationIssues([
        {
          number: 12,
          title: '[Arena] Older Entry',
          html_url: 'javascript:alert(1)',
          user: {login: 'olddev', html_url: 'javascript:alert(2)'},
          created_at: '2026-10-01T00:00:00Z',
          updated_at: '2026-10-02T00:00:00Z',
          comments: 1,
        },
        {
          number: 99,
          title: 'PR with registration label',
          pull_request: {url: 'https://api.github.com/repos/pkmn/ai/pulls/99'},
          user: {login: 'prdev'},
          created_at: '2026-10-15T00:00:00Z',
          updated_at: '2026-10-15T00:00:00Z',
          comments: 0,
        },
        {
          number: 25,
          title: '  [Arena] Newer Entry  ',
          user: {login: 'newdev'},
          created_at: '2026-10-10T00:00:00Z',
          updated_at: '2026-10-12T12:00:00Z',
          comments: 3,
        },
        {
          number: -1,
          title: 'Invalid number',
          created_at: '2026-10-10T00:00:00Z',
        },
      ]);

      expect(parsed).toEqual([
        {
          number: 25,
          title: '[Arena] Newer Entry',
          url: 'https://github.com/pkmn/ai/issues/25',
          author: 'newdev',
          authorUrl: 'https://github.com/newdev',
          createdAt: Math.floor(Date.parse('2026-10-10T00:00:00Z') / 1000),
          updatedAt: Math.floor(Date.parse('2026-10-12T12:00:00Z') / 1000),
          comments: 3,
        },
        {
          number: 12,
          title: '[Arena] Older Entry',
          url: 'https://github.com/pkmn/ai/issues/12',
          author: 'olddev',
          authorUrl: 'https://github.com/olddev',
          createdAt: Math.floor(Date.parse('2026-10-01T00:00:00Z') / 1000),
          updatedAt: Math.floor(Date.parse('2026-10-02T00:00:00Z') / 1000),
          comments: 1,
        },
      ]);
    });

  test('RegistrationIssueMonitor uses ETag/304, preserves cached issues on error, and polls',
    async () => {
      let now = 1_760_000_000;
      const seenHeaders: Array<Record<string, string>> = [];
      let call = 0;

      const fakeFetch: typeof fetch = (input, init) => {
        const reqUrl = typeof input === 'string'
          ? input
          : input instanceof URL ? input.href : input.url;
        expect(reqUrl).toBe(
          'https://api.github.com/repos/pkmn/ai/issues' +
          '?labels=registration&state=open&sort=updated&direction=desc&per_page=100'
        );
        const h = (init?.headers ?? {}) as Record<string, string>;
        seenHeaders.push({...h});
        call++;
        if (call === 1) {
          return Promise.resolve(new Response(
            JSON.stringify([
              {
                number: 41,
                title: '[Arena] Staraptor',
                user: {login: 'stardev'},
                created_at: '2026-10-19T00:00:00Z',
                updated_at: '2026-10-19T06:00:00Z',
                comments: 2,
              },
            ]),
            {status: 200, headers: {'Content-Type': 'application/json', ETag: 'W/"reg-v1"'}}
          ));
        }
        if (call === 2) {
          return Promise.resolve(new Response(null, {status: 304}));
        }
        if (call === 3) {
          return Promise.resolve(new Response(
            JSON.stringify({message: 'API rate limit exceeded'}),
            {status: 403, headers: {'x-ratelimit-remaining': '0'}}
          ));
        }
        return Promise.resolve(new Response(null, {status: 304}));
      };

      const monitor = new admin.RegistrationIssueMonitor({
        token: 'ghp_test_token',
        fetchImpl: fakeFetch,
        now: () => now,
      });

      const first = await monitor.poll();
      expect(first.issues).toHaveLength(1);
      expect(first.issues[0].number).toBe(41);
      expect(first.checkedAt).toBe(now);
      expect(first.error).toBeUndefined();
      expect(seenHeaders[0].Authorization).toBe('Bearer ghp_test_token');
      expect(seenHeaders[0]['If-None-Match']).toBeUndefined();

      now += 300;
      const second = await monitor.poll();
      expect(seenHeaders[1]['If-None-Match']).toBe('W/"reg-v1"');
      expect(second.issues).toHaveLength(1);
      expect(second.checkedAt).toBe(now);
      expect(second.error).toBeUndefined();

      // Rate limit error preserves last known issues and surfaces error.
      now += 300;
      const third = await monitor.poll();
      expect(third.issues).toHaveLength(1);
      expect(third.error).toBe('GitHub API rate limit exceeded');

      // Subsequent 304 clears the transient error.
      now += 300;
      const fourth = await monitor.poll();
      expect(fourth.issues).toHaveLength(1);
      expect(fourth.error).toBeUndefined();
    });

  test('RegistrationIssueMonitor polls periodically on start() and halts on stop()', async () => {
    let calls = 0;
    let resolveSecond!: () => void;
    const secondPollDone = new Promise<void>(resolve => {
      resolveSecond = resolve;
    });

    const fakeFetch: typeof fetch = () => {
      calls++;
      return Promise.resolve(new Response('[]', {
        status: 200,
        headers: {'Content-Type': 'application/json'},
      }));
    };

    const monitor = new admin.RegistrationIssueMonitor({
      pollIntervalMillis: 25,
      fetchImpl: fakeFetch,
      now: () => 1_760_000_000,
    });
    const unsubscribe = monitor.onUpdate(() => {
      if (calls >= 2) resolveSecond();
    });

    monitor.start();
    try {
      await secondPollDone;
      expect(calls).toBeGreaterThanOrEqual(2);
    } finally {
      unsubscribe();
      monitor.stop();
    }
    const callsAfterStop = calls;
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(calls).toBe(callsAfterStop);
  });

  test('renders polled registration issues with TablePager and streams SSE updates',
    async () => {
      let now = 1_760_000_000;
      let phase: 'initial' | 'updated' | 'many' | 'error' = 'initial';

      const fakeFetch: typeof fetch = () => {
        if (phase === 'error') {
          return Promise.resolve(new Response('boom', {status: 502}));
        }
        const payload = phase === 'initial'
          ? [
            {
              number: 47,
              title: '[Arena] Noctowl',
              user: {login: 'noctowldev'},
              created_at: '2026-10-19T12:00:00Z',
              updated_at: '2026-10-19T12:00:00Z',
              comments: 0,
            },
            {
              number: 19,
              title: '[Arena] Foul Play',
              user: {login: 'pmariglia'},
              created_at: '2026-09-01T00:00:00Z',
              updated_at: '2026-10-18T10:00:00Z',
              comments: 4,
            },
          ]
          : phase === 'updated'
            ? [
              {
                number: 48,
                title: '[Arena] Breloom',
                user: {login: 'breloomdev'},
                created_at: '2026-10-20T00:00:00Z',
                updated_at: '2026-10-20T00:00:00Z',
                comments: 1,
              },
            ]
            : Array.from({length: 27}, (_, i) => ({
              number: 100 + i,
              title: `[Arena] Project ${i + 1}`,
              user: {login: `dev${i + 1}`},
              created_at: '2026-10-19T12:00:00Z',
              updated_at: '2026-10-19T12:00:00Z',
              comments: 0,
            }));
        return Promise.resolve(new Response(JSON.stringify(payload), {
          status: 200,
          headers: {'Content-Type': 'application/json'},
        }));
      };

      const db = new Database(':memory:');
      db.syncLadders(undefined, now);
      db.syncProjectsFromYaml(PROJECTS_YAML, undefined, now);
      const authHandler = new auth.Auth({config: AUTH_CFG, db});
      const monitor = new admin.RegistrationIssueMonitor({
        fetchImpl: fakeFetch,
        now: () => now,
      });
      await monitor.poll();

      const app = polka();
      const adminHandle = admin.register(app, {
        db,
        auth: authHandler,
        registrationMonitor: monitor,
        now: () => now,
      });
      const server = http.createServer((req, res) => app.handler(req as polka.Request, res));
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const baseUrl = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
      const adminCookie = cookieFor('scheibo');

      try {
        // 1. HTML and JSON include polled registration issues, plain count, and hidden TablePager.
        const html = await (await fetch(`${baseUrl}/admin/`, {
          headers: {Cookie: adminCookie},
        })).text();
        expect(html).toContain('href="#registrations" class="subtle">Registrations (2)</a>');
        expect(html).not.toContain('data-action="refresh-registrations"');
        expect(html).not.toContain('Open registration issues on GitHub');
        expect(html).toContain('id="registrations-pager"');
        expect(html).toContain('class="pager hide"');
        expect(html).toContain('#47');
        expect(html).toContain('[Arena] Noctowl');
        expect(html).toContain('https://github.com/pkmn/ai/issues/47');
        expect(html).toContain('noctowldev');
        expect(html).toContain('#19');
        expect(html).toContain('href="/projects/foul-play/"');

        const snap = await (await fetch(`${baseUrl}/admin.json`, {
          headers: {Cookie: adminCookie},
        })).json() as admin.AdminSnapshot;
        expect(snap.registrations.issues.map(i => i.number)).toEqual([47, 19]);
        expect(snap.registrations.checkedAt).toBe(now);

        // 2. Connect SSE stream, then trigger a poll update and verify live `registrations` event.
        const ctrl = new AbortController();
        const streamRes = await fetch(`${baseUrl}/api/admin/stream`, {
          headers: {Cookie: adminCookie},
          signal: ctrl.signal,
        });
        expect(streamRes.status).toBe(200);
        const reader = streamRes.body!.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        const readNextEvent = async (): Promise<{event: string; data: Record<string, unknown>}> => {
          for (;;) {
            const idx = buf.indexOf('\n\n');
            if (idx !== -1) {
              const chunk = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              const lines = chunk.split('\n');
              const eventLine = lines.find(l => l.startsWith('event: '));
              const dataLine = lines.find(l => l.startsWith('data: '));
              if (eventLine && dataLine) {
                return {
                  event: eventLine.slice(7),
                  data: JSON.parse(dataLine.slice(6)) as Record<string, unknown>,
                };
              }
            }
            const {value, done} = await reader.read();
            if (done) throw new Error('SSE stream ended unexpectedly');
            buf += decoder.decode(value, {stream: true});
          }
        };

        const initEv = await readNextEvent();
        expect(initEv.event).toBe('system');

        phase = 'updated';
        now += 300;
        await monitor.poll();

        const regEv = await readNextEvent();
        expect(regEv.event).toBe('registrations');
        expect(String(regEv.data.innerHtml)).toContain('[Arena] Breloom');
        ctrl.abort();

        // 3. Transient error preserves last known issues and shows warning banner.
        phase = 'error';
        now += 300;
        await monitor.poll();
        const errHtml = await (await fetch(`${baseUrl}/admin/`, {
          headers: {Cookie: adminCookie},
        })).text();
        expect(errHtml).toContain('Last poll failed: GitHub API returned HTTP 502');
        expect(errHtml).toContain('[Arena] Breloom');

        // 4. >25 issues reveal TablePager and hide rows past TABLE_PAGE_SIZE.
        phase = 'many';
        now += 300;
        await monitor.poll();
        const pagedHtml = await (await fetch(`${baseUrl}/admin/`, {
          headers: {Cookie: adminCookie},
        })).text();
        expect(pagedHtml).toContain('Registrations (27)');
        expect(pagedHtml).toContain('class="pager" id="registrations-pager"');
        expect(pagedHtml).toContain('Page 1 of 2 (27 issues)');
      } finally {
        monitor.stop();
        adminHandle.close();
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        db.close();
      }
    });
});
