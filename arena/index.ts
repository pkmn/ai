import * as readline from 'readline';

import * as arena from '../server/arena';

import * as arbiter from './arbiter';
import * as coordinator from './coordinator';
import * as db from './db';
import * as packages from './packages';
import * as tournament from './tournament';

export {arbiter, coordinator, db, packages, tournament};

// Built-in deterministic baseline stdio agent used as the opponent during Turn-1 smoke tests
// when invoked via `node build/arena baseline`.
export function runBaselineStdioAgent(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout
) {
  const rl = readline.createInterface({input, crlfDelay: Infinity});
  rl.on('line', line => {
    if (line.startsWith('|tournament|byot|')) {
      output.write('/utm default\n');
      return;
    }
    if (!line.startsWith('|request|')) return;
    const raw = line.slice('|request|'.length).trim();
    if (!raw || raw === 'null') return;
    try {
      const req = JSON.parse(raw) as {
        wait?: boolean;
        teamPreview?: boolean;
        maxChosenTeamSize?: number;
        maxTeamSize?: number;
      };
      if (req.wait) return;
      if (req.teamPreview) {
        const size = req.maxChosenTeamSize ?? req.maxTeamSize ?? 6;
        const order = Array.from({length: size}, (_, i) => i + 1).join('');
        output.write(`/team ${order}\n`);
      } else {
        output.write('default\n');
      }
    } catch {}
  });
}

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
  pollIntervalMs?: number;
  once?: boolean;
} = {}) {
  const serverUrl = opts.serverUrl ?? process.env.ARENA_SERVER_URL ?? 'http://127.0.0.1:1234';
  const arenaSecret = opts.arenaSecret ?? process.env.ARENA_SECRET ?? '';
  if (!arenaSecret) {
    throw new Error('ARENA_SECRET is required to run the Arena coordinator daemon');
  }

  const client = new arena.Client({serverUrl, arenaSecret});
  const stateDb = new db.StateDatabase(opts.stateDbPath);
  const isDev = process.env.ARENA_DEV === '1';
  const baselineSpec: arbiter.AgentLaunchSpec = isDev
    ? {mode: 'native', target: process.execPath, args: [__filename, 'baseline']}
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

  const pollIntervalMs = opts.pollIntervalMs ?? 5000;
  const status = {running: true};
  const stop = () => {
    status.running = false;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    await coord.recoverIncompleteMatches();

    while (status.running) {
      try {
        await coord.flushOutbox();
        const ladders = await fetchPlayableLadderSnapshots(client);
        const byId = new Map(ladders.map(l => [l.id, l]));
        await coord.processPendingSubmissions(byId);
        const played = await coord.playNextScheduledMatch(ladders);
        if (!played && !opts.once) {
          await client.sendHeartbeat({idle: true}).catch(() => undefined);
          await new Promise(r => setTimeout(r, pollIntervalMs));
        }
      } catch (err) {
        console.error('Arena daemon cycle error:', err);
        if (opts.once) throw err;
        await new Promise(r => setTimeout(r, pollIntervalMs));
      }
      if (opts.once) break;
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    stateDb.close();
  }
}

if (require.main === module) {
  const sub = process.argv[2] ?? 'daemon';
  if (sub === 'baseline') {
    runBaselineStdioAgent();
  } else {
    void runDaemon().catch(err => {
      process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exit(1);
    });
  }
}
