import * as fs from 'fs';

import * as arena from '../server/arena';
import * as teams from '../server/teams';
import {isConnectivityError, root} from '../static/util';

import * as arbiter from './arbiter';
import * as coordinator from './coordinator';
import * as db from './db';
import * as packages from './packages';
import * as tournament from './tournament';
import * as unpack from './unpack';

export {arbiter, coordinator, db, packages, tournament, unpack};

const BASELINE_BIN = root('arena', 'bin', 'baseline');
const GIB = 1024 * 1024 * 1024;
const HOST_CHECK_INTERVAL_MILLIS = 10 * 60 * 1000;
const ARENA_DISK_LOW_PCT = 10;
const ARENA_DISK_RECOVER_PCT = 15;
const ARENA_DISK_LOW_BYTES = 10 * GIB;
const ARENA_DISK_RECOVER_BYTES = 15 * GIB;
const DAEMON_ERROR_ALERT_THRESHOLD = 5;

function checkArenaHostHealth(client: arena.Client, devMode: boolean) {
  if (devMode) return;
  const checkPaths = ['/'];
  if (process.platform === 'darwin') {
    let archiveMounted = true;
    try {
      packages.assertArchiveVolumeMounted(packages.PROD_DIRS.logs);
    } catch {
      archiveMounted = false;
    }
    if (!archiveMounted) {
      void client.sendAlert({
        key: 'arena-archive-mount',
        message: '/Volumes/Archive is not mounted on the Arena host.',
      }).catch(() => undefined);
    } else {
      checkPaths.push('/Volumes/Archive');
      void client.sendAlert({
        key: 'arena-archive-mount',
        message: '/Volumes/Archive is mounted again.',
        resolved: true,
      }).catch(() => undefined);
    }
  }
  for (const dir of checkPaths) {
    try {
      const st = fs.statfsSync(dir);
      const totalBytes = st.blocks * st.bsize;
      const freeBytes = st.bavail * st.bsize;
      if (totalBytes <= 0) continue;
      const freePct = Math.round((freeBytes / totalBytes) * 100);
      const freeGiB = (freeBytes / GIB).toFixed(1);
      const totalGiB = (totalBytes / GIB).toFixed(1);
      if (freePct < ARENA_DISK_LOW_PCT || freeBytes < ARENA_DISK_LOW_BYTES) {
        void client.sendAlert({
          key: `arena-disk:${dir}`,
          message:
            `Low disk space on Arena \`${dir}\`: ${freePct}% free ` +
            `(${freeGiB} / ${totalGiB} GiB).`,
        }).catch(() => undefined);
      } else if (freePct >= ARENA_DISK_RECOVER_PCT && freeBytes >= ARENA_DISK_RECOVER_BYTES) {
        void client.sendAlert({
          key: `arena-disk:${dir}`,
          message:
            `Disk space recovered on Arena \`${dir}\`: ${freePct}% free ` +
            `(${freeGiB} / ${totalGiB} GiB).`,
          resolved: true,
        }).catch(() => undefined);
      }
    } catch {}
  }
}

function createArenaClient(opts: {serverUrl?: string; arenaSecret?: string}): arena.Client {
  const serverUrl = opts.serverUrl ?? process.env.ARENA_SERVER_URL ?? 'http://127.0.0.1:1234';
  const arenaSecret = opts.arenaSecret ?? process.env.ARENA_SECRET ?? '';
  if (!arenaSecret) {
    throw new Error('ARENA_SECRET is required to run the Arena daemon');
  }
  return new arena.Client({serverUrl, arenaSecret});
}

function createWakeableSleep() {
  let wake: (() => void) | undefined;
  return {
    sleep(millis: number) {
      return new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          wake = undefined;
          resolve();
        }, millis);
        wake = () => {
          clearTimeout(timer);
          wake = undefined;
          resolve();
        };
      });
    },
    wake() {
      wake?.();
    },
  };
}

function createTournamentBaselineSpec(): tournament.AgentSpec {
  return {
    agentId: '_baseline',
    displayName: 'Baseline',
    vmHost: '127.0.0.1',
    controlSocket: '',
    localCommand: BASELINE_BIN,
    localArgs: [],
  };
}

export async function runDaemon(opts: {
  serverUrl?: string;
  arenaSecret?: string;
  stateDbPath?: string;
  rootDir?: string;
  maxTurns?: number;
  pollIntervalMillis?: number;
  once?: boolean;
} = {}) {
  const client = createArenaClient(opts);
  const stateDb = new db.Database(opts.stateDbPath);
  const isDev = process.env.ARENA_DEV === '1';
  if (isDev && process.env.NODE_ENV === 'production') {
    stateDb.close();
    throw new Error('Refusing to enable ARENA_DEV=1 in NODE_ENV=production');
  }
  const baselineSpec: arbiter.AgentLaunchSpec = isDev
    ? {mode: 'native', target: BASELINE_BIN}
    : {mode: 'native', target: '_baseline'};

  if (!isDev && !opts.once && opts.rootDir === undefined) {
    packages.tryMountArchiveVolume();
  }

  const coord = new coordinator.Coordinator({
    client,
    stateDb,
    baselineSpec,
    rootDir: opts.rootDir,
    maxTurns: opts.maxTurns,
    devMode: isDev,
  });

  const pollIntervalMillis = opts.pollIntervalMillis ?? 5000;
  const sleeper = createWakeableSleep();
  const stop = () => {
    coord.requestDrain();
    sleeper.wake();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('SIGUSR1', stop);

  try {
    await coord.recoverIncompleteMatches();
    if (!opts.once && !coord.isDraining()) {
      const pending = await client.getPendingSubmissions({target: 'ladder'}).catch(() => undefined);
      if (pending?.ladders.length) {
        await teams.preloadSampleTeamPools(
          pending.ladders.filter(l => l.team === 'harvested')
        ).catch(() => undefined);
      }
    }
    let consecutiveCycleErrors = 0;
    let lastHostCheckAt = 0;
    const smokeCadence = new coordinator.SmokeCadenceTracker();

    while (!coord.isDraining()) {
      try {
        if (!opts.once && opts.rootDir === undefined) {
          const nowMillis = Date.now();
          if (nowMillis - lastHostCheckAt >= HOST_CHECK_INTERVAL_MILLIS) {
            lastHostCheckAt = nowMillis;
            checkArenaHostHealth(client, isDev);
          }
        }
        await coord.flushOutbox();
        const initialSnap = await client.getPlayableLadders();
        let ladders = initialSnap.ladders;
        let quarantinedVersionIds = initialSnap.quarantinedVersionIds ?? [];
        if (initialSnap.unpublishedArchivedPoolsLadders?.length) {
          await coord.publishArchivedPoolsLadders(initialSnap.unpublishedArchivedPoolsLadders);
        }
        const byId = new Map(ladders.map(l => [l.id, l]));
        const smokeBudget = smokeCadence.budgetForCycle(initialSnap.smokeCadence);
        const ingested = smokeBudget > 0
          ? await coord.processPendingSubmissions(byId, smokeBudget)
          : 0;
        if (ingested > 0 && !coord.isDraining()) {
          const refreshed = await client.getPlayableLadders();
          ladders = refreshed.ladders;
          quarantinedVersionIds = refreshed.quarantinedVersionIds ?? [];
        }
        const played = await coord.playNextScheduledMatch(ladders, quarantinedVersionIds);
        smokeCadence.recordCycle(ingested, Boolean(played));
        consecutiveCycleErrors = 0;
        if (!played && ingested === 0 && !opts.once && !coord.isDraining()) {
          await client.sendHeartbeat({idle: true}).catch(() => undefined);
          await sleeper.sleep(pollIntervalMillis);
        }
      } catch (err) {
        console.error('Arena daemon cycle error:', err);
        if (opts.once) throw err;
        if (!isConnectivityError(err)) {
          consecutiveCycleErrors++;
          if (consecutiveCycleErrors >= DAEMON_ERROR_ALERT_THRESHOLD) {
            const detail = err instanceof Error ? err.message : String(err);
            void client.sendAlert({
              key: 'arena-daemon-cycle',
              message: `Arena daemon failed ${consecutiveCycleErrors} cycles in a row.`,
              detail,
            }).catch(() => undefined);
          }
        }
        if (!coord.isDraining()) {
          await sleeper.sleep(pollIntervalMillis);
        }
      }
      if (opts.once) break;
    }
    await coord.flushOutbox().catch(() => undefined);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGUSR1', stop);
    stateDb.close();
  }
}

export async function runTournamentValidationDaemon(opts: {
  serverUrl?: string;
  arenaSecret?: string;
  tournamentId?: string;
  rootDir?: string;
  pollIntervalMillis?: number;
  once?: boolean;
} = {}) {
  const client = createArenaClient(opts);
  const coord = new tournament.Coordinator({
    client,
    baselineSpec: createTournamentBaselineSpec(),
    rootDir: opts.rootDir,
  });

  const pollIntervalMillis = opts.pollIntervalMillis ?? 5000;
  let running = true;
  const isRunning = () => running;
  const sleeper = createWakeableSleep();
  const stop = () => {
    running = false;
    sleeper.wake();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    if (!opts.once && isRunning()) {
      const pending = await client.getPendingSubmissions({
        target: 'tournament',
        tournamentId: opts.tournamentId,
      }).catch(() => undefined);
      if (pending?.tournaments?.length) {
        await teams.preloadSampleTeamPools(
          pending.tournaments
            .filter(t => t.team === 'harvested')
            .map(t => ({
              format: t.customRules?.length
                ? `${t.format}${t.format.includes('@@@') ? ',' : '@@@'}${t.customRules.join(',')}`
                : t.format,
              version: t.version,
            }))
        ).catch(() => undefined);
      }
    }
    while (isRunning()) {
      try {
        const count = await coord.processPendingSubmissions(opts.tournamentId);
        if (count === 0 && !opts.once && isRunning()) {
          await sleeper.sleep(pollIntervalMillis);
        }
      } catch (err) {
        console.error('GCP tournament validation cycle error:', err);
        if (opts.once) throw err;
        if (isRunning()) {
          await sleeper.sleep(pollIntervalMillis);
        }
      }
      if (opts.once) break;
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

export async function runTournamentDaemon(
  tournamentId: string,
  opts: {
    serverUrl?: string;
    arenaSecret?: string;
    rootDir?: string;
    tables?: readonly tournament.TableBinding[];
    superfinalGames?: number;
    maxTurns?: number;
  } = {}
): Promise<{roundRobinGames: number; superfinalGames: number}> {
  const client = createArenaClient(opts);
  const coord = new tournament.Coordinator({
    client,
    baselineSpec: createTournamentBaselineSpec(),
    rootDir: opts.rootDir,
    tables: opts.tables,
    superfinalGames: opts.superfinalGames,
    maxTurns: opts.maxTurns,
  });
  return coord.runTournament(tournamentId);
}

if (require.main === module) {
  const sub = process.argv[2] ?? 'daemon';
  const onFatal = (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  };
  if (sub === 'validate-tournament') {
    const once = process.argv.includes('--once');
    const tourneyArg = process.argv.slice(3).find(a => !a.startsWith('--'));
    void runTournamentValidationDaemon({tournamentId: tourneyArg, once}).catch(onFatal);
  } else if (sub === 'tournament') {
    const rest = process.argv.slice(3);
    const tourneyId = rest.find(a => !a.startsWith('--'));
    if (!tourneyId) {
      process.stderr.write(
        'Usage: arena tournament <tournament-id> ' +
        '[--table=<vmA>,<sockA>,<vmB>,<sockB>]... [--superfinal=<N>] [--local]\n'
      );
      process.exit(2);
    }
    const tables: tournament.TableBinding[] = [];
    let superfinalGames: number | undefined;
    for (const arg of rest) {
      if (arg.startsWith('--table=')) {
        const parts = arg.slice('--table='.length).split(',');
        if (parts.length !== 4) {
          process.stderr.write(`Invalid --table binding: ${arg}\n`);
          process.exit(2);
        }
        tables.push({
          vmA: {host: parts[0], controlSocket: parts[1]},
          vmB: {host: parts[2], controlSocket: parts[3]},
        });
      } else if (arg.startsWith('--superfinal=')) {
        const parsed = Number(arg.slice('--superfinal='.length));
        if (!Number.isInteger(parsed) || parsed < 0) {
          process.stderr.write(`Invalid --superfinal count: ${arg}\n`);
          process.exit(2);
        }
        superfinalGames = parsed;
      } else if (arg === '--local') {
        tables.push({
          vmA: {host: '127.0.0.1', controlSocket: ''},
          vmB: {host: '127.0.0.1', controlSocket: ''},
        });
      }
    }
    void runTournamentDaemon(tourneyId, {
      ...(tables.length > 0 ? {tables} : {}),
      ...(superfinalGames !== undefined ? {superfinalGames} : {}),
    }).catch(onFatal);
  } else {
    void runDaemon().catch(onFatal);
  }
}
