import * as fs from 'fs';

import * as arena from '../server/arena';
import {root} from '../static/util';

import * as arbiter from './arbiter';
import * as coordinator from './coordinator';
import * as db from './db';
import * as packages from './packages';
import * as tournament from './tournament';

export {arbiter, coordinator, db, packages, tournament};

const BASELINE_BIN = fs.existsSync('/opt/arena/bin/baseline')
  ? '/opt/arena/bin/baseline'
  : root('arena', 'bin', 'baseline');

export async function fetchPlayableLadderSnapshots(
  client: arena.Client
): Promise<coordinator.LadderSnapshot[]> {
  const {ladders} = await client.getPlayableLadders();
  return ladders;
}

export async function runDaemon(opts: {
  serverUrl?: string;
  arenaSecret?: string;
  stateDbPath?: string;
  agentsDir?: string;
  stagingDir?: string;
  coldDir?: string;
  teamsDir?: string;
  archiveLogsDir?: string;
  maxTurns?: number;
  pollIntervalMillis?: number;
  once?: boolean;
} = {}) {
  const serverUrl = opts.serverUrl ?? process.env.ARENA_SERVER_URL ?? 'http://127.0.0.1:1234';
  const arenaSecret = opts.arenaSecret ?? process.env.ARENA_SECRET ?? '';
  if (!arenaSecret) {
    throw new Error('ARENA_SECRET is required to run the Arena coordinator daemon');
  }

  const client = new arena.Client({serverUrl, arenaSecret});
  const stateDb = new db.Database(opts.stateDbPath);
  const isDev = process.env.ARENA_DEV === '1';
  const baselineSpec: arbiter.AgentLaunchSpec = isDev
    ? {mode: 'native', target: BASELINE_BIN}
    : {mode: 'native', target: '_baseline'};

  const coord = new coordinator.Coordinator({
    client,
    stateDb,
    baselineSpec,
    agentsDir: opts.agentsDir,
    stagingDir: opts.stagingDir,
    coldDir: opts.coldDir,
    teamsDir: opts.teamsDir,
    archiveLogsDir: opts.archiveLogsDir,
    maxTurns: opts.maxTurns,
    devMode: isDev,
  });

  const pollIntervalMillis = opts.pollIntervalMillis ?? 5000;
  const status = {running: true};
  const stop = () => {
    status.running = false;
    coord.requestDrain();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.once('SIGUSR1', stop);

  try {
    await coord.recoverIncompleteMatches();

    while (status.running && !coord.isDraining()) {
      try {
        await coord.flushOutbox();
        const ladders = await fetchPlayableLadderSnapshots(client);
        const byId = new Map(ladders.map(l => [l.id, l]));
        await coord.processPendingSubmissions(byId);
        const played = await coord.playNextScheduledMatch(ladders);
        if (!played && !opts.once && status.running && !coord.isDraining()) {
          await client.sendHeartbeat({idle: true}).catch(() => undefined);
          await new Promise(r => setTimeout(r, pollIntervalMillis));
        }
      } catch (err) {
        console.error('Arena daemon cycle error:', err);
        if (opts.once) throw err;
        await new Promise(r => setTimeout(r, pollIntervalMillis));
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
  agentsDir?: string;
  stagingDir?: string;
  tourneyAgentBin?: string;
  pollIntervalMillis?: number;
  once?: boolean;
} = {}) {
  const serverUrl = opts.serverUrl ?? process.env.ARENA_SERVER_URL ?? 'http://127.0.0.1:1234';
  const arenaSecret = opts.arenaSecret ?? process.env.ARENA_SECRET ?? '';
  if (!arenaSecret) {
    throw new Error('ARENA_SECRET is required to run the GCP tournament validation daemon');
  }

  const client = new arena.Client({serverUrl, arenaSecret});
  const baselineSpec: tournament.AgentSpec = {
    agentId: '_baseline',
    displayName: 'Baseline',
    vmHost: '127.0.0.1',
    controlSocket: '',
    localCommand: BASELINE_BIN,
    localArgs: [],
  };
  const coord = new tournament.Coordinator({
    client,
    baselineSpec,
    agentsDir: opts.agentsDir,
    stagingDir: opts.stagingDir,
    tourneyAgentBin: opts.tourneyAgentBin,
  });

  const pollIntervalMillis = opts.pollIntervalMillis ?? 5000;
  const status = {running: true};
  const stop = () => {
    status.running = false;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    while (status.running) {
      try {
        const count = await coord.processPendingSubmissions(opts.tournamentId);
        if (count === 0 && !opts.once) {
          await new Promise(r => setTimeout(r, pollIntervalMillis));
        }
      } catch (err) {
        console.error('GCP tournament validation cycle error:', err);
        if (opts.once) throw err;
        await new Promise(r => setTimeout(r, pollIntervalMillis));
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
    agentsDir?: string;
    stagingDir?: string;
    tourneyAgentBin?: string;
    tables?: readonly tournament.TableBinding[];
    superfinalGames?: number;
    maxTurns?: number;
  } = {}
): Promise<{roundRobinGames: number; superfinalGames: number}> {
  const serverUrl = opts.serverUrl ?? process.env.ARENA_SERVER_URL ?? 'http://127.0.0.1:1234';
  const arenaSecret = opts.arenaSecret ?? process.env.ARENA_SECRET ?? '';
  if (!arenaSecret) {
    throw new Error('ARENA_SECRET is required to run the GCP tournament coordinator');
  }

  const client = new arena.Client({serverUrl, arenaSecret});
  const baselineSpec: tournament.AgentSpec = {
    agentId: '_baseline',
    displayName: 'Baseline',
    vmHost: '127.0.0.1',
    controlSocket: '',
    localCommand: BASELINE_BIN,
    localArgs: [],
  };
  const coord = new tournament.Coordinator({
    client,
    baselineSpec,
    agentsDir: opts.agentsDir,
    stagingDir: opts.stagingDir,
    tourneyAgentBin: opts.tourneyAgentBin,
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
    const tourneyId = process.argv[3];
    if (!tourneyId) {
      process.stderr.write('Usage: arena tournament <tournament-id>\n');
      process.exit(2);
    }
    void runTournamentDaemon(tourneyId).catch(onFatal);
  } else {
    void runDaemon().catch(onFatal);
  }
}
