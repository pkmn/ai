import * as fs from 'fs';
import * as readline from 'readline';

import * as arena from '../server/arena';

import * as arbiter from './arbiter';
import * as coordinator from './coordinator';
import * as db from './db';
import * as harvest from './harvest';
import * as packages from './packages';
import * as tournament from './tournament';

export {arbiter, coordinator, db, harvest, packages, tournament};

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
        maxTeamSize?: number;
      };
      if (req.wait) return;
      if (req.teamPreview) {
        const size = req.maxTeamSize ?? 6;
        const order = Array.from({length: size}, (_, i) => i + 1).join('');
        output.write(`/team ${order}\n`);
      } else {
        output.write('default\n');
      }
    } catch {}
  });
}

async function fetchPlayableLadderSnapshots(
  serverUrl: string,
  arenaSecret?: string
): Promise<coordinator.LadderSnapshot[]> {
  const base = serverUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = {accept: 'application/json'};
  if (arenaSecret) {
    headers.authorization = `Bearer ${arenaSecret}`;
  }
  const snapRes = await fetch(`${base}/api/arena/ladders`, {headers});
  if (snapRes.ok) {
    const snap = await snapRes.json() as {ladders?: coordinator.LadderSnapshot[]};
    return snap.ladders ?? [];
  }
  const hubRes = await fetch(`${base}/arena.json`, {
    headers: {accept: 'application/json'},
  });
  if (!hubRes.ok) return [];
  const hub = await hubRes.json() as {
    ladders?: Array<{
      id: string;
      slot: string;
      format: string;
      team: 'random' | 'harvested' | 'pools';
      status: 'upcoming' | 'active' | 'settling' | 'archived';
      min: number;
    }>;
  };

  const out: coordinator.LadderSnapshot[] = [];
  for (const l of hub.ladders ?? []) {
    if (l.status !== 'active' && l.status !== 'settling') continue;
    const ladRes = await fetch(`${base}/arena/ladders/${encodeURIComponent(l.id)}.json`, {
      headers: {accept: 'application/json'},
    });
    if (!ladRes.ok) continue;
    const detail = await ladRes.json() as {
      entries?: coordinator.LadderSnapshot['entries'];
      pairAggregates?: coordinator.LadderSnapshot['pairAggregates'];
      roster?: coordinator.ActiveRosterEntry[];
    };
    out.push({
      id: l.id,
      slot: l.slot,
      format: l.format,
      team: l.team,
      status: l.status,
      min: l.min,
      entries: detail.entries ?? [],
      pairAggregates: detail.pairAggregates ?? [],
      roster: detail.roster,
    });
  }
  return out;
}

export async function runDaemon(opts: {
  serverUrl?: string;
  arenaSecret?: string;
  stateDbPath?: string;
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
  const baselineSpec: arbiter.AgentLaunchSpec = {
    mode: 'native',
    target: process.execPath,
    args: [__filename, 'baseline'],
  };

  const coord = new coordinator.Coordinator({
    client,
    stateDb,
    baselineSpec,
    devMode: process.env.ARENA_DEV === '1',
  });

  await coord.recoverIncompleteMatches();

  const pollIntervalMs = opts.pollIntervalMs ?? 5000;
  const status = {running: true};
  const stop = () => {
    status.running = false;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  while (status.running) {
    try {
      await coord.flushOutbox();
      const ladders = await fetchPlayableLadderSnapshots(serverUrl, arenaSecret);
      const byId = new Map(ladders.map(l => [l.id, l]));
      await coord.processPendingSubmissions(byId);
      const played = await coord.playNextScheduledMatch(ladders);
      if (!played && !opts.once) {
        await client.sendHeartbeat({idle: true}).catch(() => undefined);
        await new Promise(r => setTimeout(r, pollIntervalMs));
      }
    } catch {
      if (!opts.once) {
        await new Promise(r => setTimeout(r, pollIntervalMs));
      }
    }
    if (opts.once) break;
  }

  stateDb.close();
}

if (require.main === module) {
  const sub = process.argv[2] ?? 'daemon';
  if (sub === 'baseline') {
    runBaselineStdioAgent();
  } else if (sub === 'harvest') {
    const formatId = process.argv[3];
    const logDir = process.argv[4];
    const outFile = process.argv[5];
    if (!formatId || !logDir || !outFile) {
      process.stderr.write('Usage: arena harvest <format> <log-dir> <out-file>\n');
      process.exit(2);
    }
    const gen = Number(/^gen(\d)/i.exec(formatId)?.[1] ?? 9);
    const candidates: harvest.HarvestedSideCandidate[] = [];
    for (const entry of fs.readdirSync(logDir)) {
      if (!entry.endsWith('.log')) continue;
      const text = fs.readFileSync(`${logDir}/${entry}`, 'utf8');
      candidates.push(...harvest.extractRevealedTeamsFromLog(text, formatId));
    }
    const pool = harvest.filterAndRankHarvestedTeams(candidates, {formatId, gen});
    harvest.writeHarvestedPoolFile(outFile, pool);
  } else {
    void runDaemon().catch(err => {
      process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exit(1);
    });
  }
}
