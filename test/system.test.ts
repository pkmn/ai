import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import polka from 'polka';

import {Database} from '../db';
import * as arena from '../server/arena';
import * as auth from '../server/auth';
import * as system from '../server/system';

describe('system telemetry parsers & TrafficTracker', () => {
  test('parses Linux /proc and Ubuntu update-notifier outputs', () => {
    const mem = system.parseProcMeminfo(
      'MemTotal:       8192000 kB\nMemFree:        1000000 kB\n' +
      'MemAvailable:   6000000 kB\nSwapTotal:      2048000 kB\nSwapFree:       1536000 kB\n'
    );
    expect(mem).toEqual({
      totalBytes: 8192000 * 1024,
      availableBytes: 6000000 * 1024,
      usedBytes: 2192000 * 1024,
      swapTotalBytes: 2048000 * 1024,
      swapUsedBytes: 512000 * 1024,
    });

    const dstats = system.parseProcDiskstats(
      '   7       0 loop0 0 0 0 0 0 0 0 0 0 0 0\n' +
      ' 252       0 vda 100 0 2000 10 50 0 1000 5 0 250 15\n'
    );
    expect(dstats.has('loop0')).toBe(false);
    expect(system.pickRootLinuxDisk(dstats, '/dev/vda1 / ext4 rw 0 0\n')).toBe('vda');
    expect(dstats.get('vda')?.ioTicksMillis).toBe(250);

    const net = system.parseProcNetDev(
      'Inter-|   Receive\n' +
      '    lo: 999999 100 0 0 0 0 0 0 999999 100 0 0 0 0 0 0\n' +
      '  eth0: 123456 10 1 2 0 0 0 0 654321 20 0 3 0 0 0 0\n'
    );
    expect(net).toEqual({
      iface: 'eth0',
      rxBytes: 123456,
      rxErrors: 3,
      txBytes: 654321,
      txErrors: 3,
    });

    expect(system.parseProcNetTcpListening(
      '  sl  local_address rem_address   st\n   0: 0100007F:08AE 00000000:0000 0A\n',
      2222
    )).toBe(true);
    expect(system.parseProcNetTcpListening(
      '  sl  local_address rem_address   st\n   0: 0100007F:04D2 00000000:0000 0A\n',
      2222
    )).toBe(false);

    expect(system.parseUbuntuUpdates(
      '12 updates can be applied immediately.\n3 of these updates are standard security updates.\n',
      true,
      1000
    )).toEqual({pending: 12, security: 3, rebootRequired: true, checkedAt: 1000});
  });

  test('parses macOS vm_stat, swapusage, sysctl, iostat, netstat, diskutil, softwareupdate', () => {
    const vm = system.parseMacVmStat(
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)\n' +
      'Pages wired down: 100.\nPages purgeable: 10.\n' +
      'Anonymous pages: 210.\nPages occupied by compressor: 50.\n'
    );
    expect(vm).toEqual({pageSize: 16384, usedBytes: 350 * 16384});

    const swap = system.parseMacSwapUsage(
      'total = 4096.00M  used = 1024.00M  free = 3072.00M  (encrypted)'
    );
    expect(swap).toEqual({
      swapTotalBytes: 4096 * 1024 * 1024,
      swapUsedBytes: 1024 * 1024 * 1024,
    });

    expect(system.parseMacSysctlMemory(
      'total = 3072.00M  used = 512.00M  free = 2560.00M  (encrypted)\n2\n'
    )).toEqual({
      swapTotalBytes: 3072 * 1024 * 1024,
      swapUsedBytes: 512 * 1024 * 1024,
      pressure: 'warning',
    });

    const io = system.parseMacIostat(
      '              disk0               disk4 \n' +
      '    KB/t xfrs   MB     KB/t xfrs   MB \n' +
      '   25.94 1000 25.50    64.00 200 12.25 \n'
    );
    expect(io.get('disk0')).toEqual({disk: 'disk0', transfers: 1000, megabytes: 25.5});
    expect(io.get('disk4')).toEqual({disk: 'disk4', transfers: 200, megabytes: 12.25});

    expect(system.parseDiskutilPhysicalDisk('   APFS Physical Store:       disk4s2\n')).toBe(
      'disk4'
    );

    const net = system.parseMacNetstat(
      'Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll\n' +
      'lo0 16384 <Link#1> 100 0 99999 100 0 99999 0\n' +
      'en0 1500 <Link#6> aa:bb:cc:dd:ee:ff 50 1 4000 60 2 5000 0\n',
      'en0'
    );
    expect(net).toEqual({
      iface: 'en0',
      rxBytes: 4000,
      txBytes: 5000,
      rxErrors: 1,
      txErrors: 2,
    });

    const updates = system.parseMacSoftwareUpdate(
      'Software Update found the following new or updated software:\n' +
      '* Label: macOS Sequoia 15.5-24F74\n\tTitle: macOS Sequoia 15.5, Action: restart\n',
      2000
    );
    expect(updates).toEqual({
      pending: 1,
      rebootRequired: true,
      checkedAt: 2000,
      summary: 'macOS Sequoia 15.5-24F74',
    });
  });

  test('TrafficTracker aggregates visitors, requests, error rates, and latency', () => {
    let t = 1_760_000_000;
    const tracker = new system.TrafficTracker(() => t);
    tracker.record({status: 200, durationMillis: 10, ip: '1.1.1.1', pathname: '/arena/'});
    tracker.record({status: 200, durationMillis: 30, ip: '2.2.2.2', pathname: '/arena/'});
    tracker.record({status: 429, durationMillis: 5, ip: '2.2.2.2', pathname: '/api/battles.json'});
    tracker.record({status: 500, durationMillis: 50, ip: '3.3.3.3', pathname: '/projects/foo/'});
    // Internal Arena heartbeats & SSE latency should not skew site traffic stats.
    tracker.record({
      status: 200,
      durationMillis: 9999,
      ip: '127.0.0.1',
      pathname: '/api/arena/heartbeat',
      isInternalArena: true,
    });
    tracker.record({
      status: 200,
      durationMillis: 60000,
      ip: '4.4.4.4',
      pathname: '/api/battles/stream',
      isStream: true,
    });

    const snap = tracker.snapshot({battles: 3, tournaments: 1, admin: 1}, t);
    expect(snap.activeVisitors5m).toBe(3);
    expect(snap.requests1m).toBe(5);
    expect(snap.requests1h).toBe(5);
    expect(snap.errors4xx1h).toBe(1);
    expect(snap.rateLimited4291h).toBe(1);
    expect(snap.errors5xx1h).toBe(1);
    expect(snap.meanLatencyMillis).toBe(24);
    expect(snap.p95LatencyMillis).toBe(50);
    expect(snap.last5xx).toEqual({at: t, path: '/projects/foo/', status: 500});

    // Advance 6 minutes: 5m active visitors prune to 0, 1h totals stay intact.
    t += 360;
    const later = tracker.snapshot({battles: 0, tournaments: 0, admin: 0}, t);
    expect(later.activeVisitors5m).toBe(0);
    expect(later.requests1m).toBe(0);
    expect(later.requests1h).toBe(5);
  });

  test('schedule-aware backup scanning stops once good and resumes at next window', async () => {
    const before = Math.floor(Date.UTC(2026, 10, 22, 9, 55, 0) / 1000);
    const windowPrev = Math.floor(Date.UTC(2026, 10, 21, 10, 0, 0) / 1000);
    const windowToday = Math.floor(Date.UTC(2026, 10, 22, 10, 0, 0) / 1000);
    const after = Math.floor(Date.UTC(2026, 10, 22, 10, 1, 0) / 1000);
    expect(system.latestScheduledWindowStart(before, 10, 0, true)).toBe(windowPrev);
    expect(system.latestScheduledWindowStart(after, 10, 0, true)).toBe(windowToday);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkmn-sys-test-'));
    try {
      const backupDir = path.join(tmpDir, 'backups');
      fs.mkdirSync(backupDir, {recursive: true});
      const b1 = path.join(backupDir, 'arena-20261122T100100Z.sqlite.zst');
      fs.writeFileSync(b1, 'backup-1');
      fs.utimesSync(b1, after, after);

      let nowSec = after + 60;
      const vps = new system.VpsHostMonitor({
        dbPath: ':memory:',
        backupDir,
        now: () => nowSec,
      });
      const s1 = vps.sampleNow({
        sse: {battles: 0, tournaments: 0, admin: 0},
        arenaFaults24h: {matches: 0, faults: 0},
      });
      expect(s1.backups.lastBackupAt).toBe(after);
      expect(s1.backups.checkedAt).toBe(nowSec);

      // Even hours later (still before next day's 10:00 UTC), known-good backup skips rescanning.
      nowSec += 6 * 3600;
      const s2 = vps.sampleNow({
        sse: {battles: 0, tournaments: 0, admin: 0},
        arenaFaults24h: {matches: 0, faults: 0},
      });
      expect(s2.backups.checkedAt).toBe(s1.backups.checkedAt);

      // Cross tomorrow's 10:00 UTC window -> rescans because today's backup hasn't landed yet.
      nowSec = windowToday + 86400 + 60;
      const s3 = vps.sampleNow({
        sse: {battles: 0, tournaments: 0, admin: 0},
        arenaFaults24h: {matches: 0, faults: 0},
      });
      expect(s3.backups.checkedAt).toBe(nowSec);

      // ArenaHostMonitor reads separate archive-status.json + updates-status.json & suppresses
      // duplicate per-turn sends.
      const statusFile = path.join(tmpDir, 'archive-status.json');
      const updatesFile = path.join(tmpDir, 'updates-status.json');
      fs.writeFileSync(statusFile, JSON.stringify({
        completedAt: after,
        backupAt: after,
        backupBytes: 1234,
        gcsSyncedAt: after + 30,
      }));
      fs.writeFileSync(updatesFile, JSON.stringify({
        pending: 1,
        rebootRequired: true,
        checkedAt: after + 40,
        summary: 'macOS 15.5',
      }));
      let arenaNow = after + 120;
      const monitor = new system.ArenaHostMonitor({
        stateDbPath: ':memory:',
        getOutboxCount: () => 0,
        isArchiveMounted: () => false,
        archiveStatusPath: statusFile,
        updatesStatusPath: updatesFile,
        requireGcsSync: true,
        now: () => arenaNow,
      });
      await monitor.refreshFast();
      const first = monitor.takePendingSnapshot();
      expect(first?.updates?.pending).toBe(1);
      expect(first?.backups.lastArchiveUploadAt).toBe(after + 30);

      // Failed heartbeat does not mark revision sent -> retries on next takePendingSnapshot.
      monitor.recordHeartbeatRtt(50, false, 'timeout');
      expect(monitor.takePendingSnapshot()).toBeDefined();

      // Recovery (false -> true) triggers one follow-up send with the recovered RTT, then settles.
      monitor.recordHeartbeatRtt(22, true);
      expect(monitor.takePendingSnapshot()?.network.internal?.rttMillis).toBe(22);

      // Subsequent steady-state heartbeat (true -> true) omits redundant system blob.
      monitor.recordHeartbeatRtt(20, true);
      expect(monitor.takePendingSnapshot()).toBeUndefined();

      // After 60s during a long match, takePendingSnapshot runs sub-ms instant refresh in-process.
      arenaNow += 65;
      const refreshed = monitor.takePendingSnapshot();
      expect(refreshed?.collectedAt).toBe(arenaNow);
      monitor.recordHeartbeatRtt(21, true);
      expect(monitor.takePendingSnapshot()).toBeUndefined();

      // New error state marks revision dirty again.
      arenaNow += 5;
      monitor.recordDaemonErrors(1);
      expect(monitor.takePendingSnapshot()?.daemonErrors).toBe(1);
    } finally {
      fs.rmSync(tmpDir, {recursive: true, force: true});
    }
  });

  test('Database.getRecentFaultSummary counts faulted matches within the 24h window', () => {
    const now = 1_760_000_000;
    const db = new Database(':memory:');
    try {
      db.syncLadders(undefined, now);
      db.db.prepare("UPDATE ladders SET status = 'active'").run();
      expect(db.getRecentFaultSummary(now)).toEqual({matches: 0, faults: 0});
    } finally {
      db.close();
    }
  });

  test('arena heartbeat ingests system telemetry without leaking to /api/live.json', async () => {
    const now = 1_760_000_000;
    const db = new Database(':memory:');
    db.syncLadders(undefined, now);
    const authHandler = new auth.Auth({
      config: {sessionSecret: 'test-system-secret'},
      db,
    });
    const app = polka();
    let hbSeen = 0;
    const arenaHandle = arena.register(app, {
      db,
      auth: authHandler,
      arenaSecret: 'test-arena-secret',
      now: () => now,
      onHeartbeat: () => {
        hbSeen++;
      },
    });
    const server = http.createServer((req, res) => app.handler(req as polka.Request, res));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as {port: number};
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const GIB = 1024 ** 3;
      const arenaSys: system.ArenaSystemInfo = {
        collectedAt: now,
        hostname: 'arena-mini',
        platform: 'Darwin 24.6.0 (arm64)',
        nodeVersion: 'v22.21.0',
        load: {
          load1: 1.5,
          load5: 1.4,
          load15: 1.2,
          cpus: 14,
          uptimeSeconds: 86400,
          processUptimeSeconds: 3600,
        },
        memory: {
          totalBytes: 64 * GIB,
          usedBytes: 16 * GIB,
          availableBytes: 48 * GIB,
          swapTotalBytes: 0,
          swapUsedBytes: 0,
          processRssBytes: 96 * 1024 * 1024,
          pressure: 'normal',
        },
        disks: [{mount: '/Volumes/Archive', label: 'Archive', mounted: true}],
        network: {
          internal: {target: 'VPS tunnel', ok: true, rttMillis: 15, checkedAt: now},
        },
        backups: {lastBackupAt: now - 3600, checkedAt: now},
        outboxPending: 0,
        daemonErrors: 0,
      };

      const res = await fetch(`${baseUrl}/api/arena/heartbeat`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-arena-secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({idle: true, system: arenaSys}),
      });
      expect(res.status).toBe(200);
      expect(hbSeen).toBe(1);
      expect(arenaHandle.getState().lastHeartbeatAt).toBe(now);
      expect(arenaHandle.getState().arenaSystem?.hostname).toBe('arena-mini');

      const liveText = await (await fetch(`${baseUrl}/api/live.json`)).text();
      expect(liveText).not.toContain('arena-mini');
      expect(liveText).not.toContain('/Volumes/Archive');
    } finally {
      arenaHandle.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      db.close();
    }
  });
});
