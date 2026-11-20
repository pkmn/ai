import * as fs from 'fs';
import {createRequire} from 'module';
import * as path from 'path';
import {parentPort, workerData} from 'worker_threads';

import type * as simTypes from '@pkmn/sim';

import {root} from '../static/util';

import * as simOps from './sim-ops';

export interface WorkerInitData {
  version: string;
}

export type RpcRequest = {
  method: 'getVersion';
} | {
  method: 'resolveArenaFormatId';
  format: string;
} | {
  method: 'getTimerSettings';
  format: string;
} | {
  method: 'isGeneratedTeamFormat';
  format: string;
} | {
  method: 'hasFormat';
  format: string;
} | {
  method: 'sampleRandomPair';
  format: string;
  seed1: simTypes.PRNGSeed;
  seed2: simTypes.PRNGSeed;
} | {
  method: 'validateTeam';
  format: string;
  packed: string;
  options?: simOps.ValidateTeamOptions;
};

export type ParentMessage = {
  type: 'battle:start';
  battleId: string;
} | {
  type: 'battle:write';
  battleId: string;
  chunk: string;
  writeId?: number;
} | {
  type: 'battle:destroy';
  battleId: string;
} | ({
  type: 'rpc';
  id: number;
} & RpcRequest);

export type WorkerMessage = {
  type: 'battle:chunk';
  battleId: string;
  channel: 'p1' | 'p2' | 'omniscient';
  chunk: string;
  p1Pokemon?: unknown[];
  p2Pokemon?: unknown[];
  waveId?: number;
  activeSides?: number;
} | {
  type: 'battle:wrote';
  battleId: string;
  writeId: number;
} | {
  type: 'battle:end';
  battleId: string;
  log: string[];
} | {
  type: 'battle:error';
  battleId: string;
  error: string;
} | {
  type: 'rpc:result';
  id: number;
  result?: unknown;
  error?: string;
};

function tryRequire(req: NodeJS.Require, id: string): unknown {
  try {
    return req(id);
  } catch {
    return undefined;
  }
}

function resolveRequireAnchor(version: string): {
  req: NodeJS.Require;
  pkgVersion: string;
} {
  const versionDir = root('sim', version);
  const versionSimPkgPath = path.join(versionDir, 'node_modules', '@pkmn', 'sim', 'package.json');
  const versionPkgPath = path.join(versionDir, 'package.json');
  if (fs.existsSync(versionSimPkgPath)) {
    const anchor = fs.existsSync(versionPkgPath) ? versionPkgPath : versionSimPkgPath;
    const req = createRequire(anchor);
    const pkg = JSON.parse(fs.readFileSync(versionSimPkgPath, 'utf8')) as {version: string};
    return {req, pkgVersion: pkg.version};
  }

  const rootSimPkgPath = root('node_modules', '@pkmn', 'sim', 'package.json');
  if (fs.existsSync(rootSimPkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(rootSimPkgPath, 'utf8')) as {version: string};
    if (pkg.version === version) {
      return {req: createRequire(root('package.json')), pkgVersion: pkg.version};
    }
  }

  throw new Error(
    `Cannot find @pkmn/sim version "${version}" (checked ${versionSimPkgPath} and ` +
    `root ${rootSimPkgPath})`
  );
}

const init = workerData as WorkerInitData;
const {req: simRequire, pkgVersion} = resolveRequireAnchor(init.version);
const simMod = simRequire('@pkmn/sim') as typeof simTypes;

simOps.configureSimMod(simMod, {
  champions: tryRequire(simRequire, '@pkmn/mods/champions'),
  championsregmb: tryRequire(simRequire, '@pkmn/mods/championsregmb'),
  teamGenerators: (tryRequire(simRequire, '@pkmn/randoms') as {
    TeamGenerators?: unknown;
  } | undefined)?.TeamGenerators,
});

interface ActiveBattle {
  stream: simTypes.BattleStreams.BattleStream;
  writeChain: Promise<void>;
  ended: boolean;
  waveId: number;
  lastRequests: [unknown, unknown];
}

const battles = new Map<string, ActiveBattle>();
const port = parentPort;
if (!port) {
  throw new Error('server/sim-worker must be run as a worker_threads Worker');
}

function post(msg: WorkerMessage) {
  port!.postMessage(msg);
}

function startBattle(battleId: string) {
  const stream = new simMod.BattleStreams.BattleStream();
  const streams = simMod.BattleStreams.getPlayerStreams(stream);
  const active: ActiveBattle = {
    stream,
    writeChain: Promise.resolve(),
    ended: false,
    waveId: 0,
    lastRequests: [undefined, undefined],
  };
  battles.set(battleId, active);

  const pump = async (
    channel: 'p1' | 'p2' | 'omniscient',
    iterable: AsyncIterable<string>
  ) => {
    try {
      for await (const chunk of iterable) {
        if (channel === 'omniscient') {
          const p1Pokemon = stream.battle?.sides[0]?.getRequestData().pokemon;
          const p2Pokemon = stream.battle?.sides[1]?.getRequestData().pokemon;
          post({
            type: 'battle:chunk',
            battleId,
            channel,
            chunk,
            p1Pokemon,
            p2Pokemon,
          });
        } else {
          let waveId: number | undefined;
          let activeSides: number | undefined;
          if (chunk.includes('|request|') && stream.battle) {
            const s0Req = stream.battle.sides[0]?.activeRequest;
            const s1Req = stream.battle.sides[1]?.activeRequest;
            if (s0Req !== active.lastRequests[0] || s1Req !== active.lastRequests[1]) {
              active.lastRequests = [s0Req, s1Req];
              active.waveId++;
            }
            waveId = active.waveId;
            activeSides = stream.battle.sides.filter(
              s => s.activeRequest && !('wait' in s.activeRequest && s.activeRequest.wait)
            ).length;
          }
          post({
            type: 'battle:chunk',
            battleId,
            channel,
            chunk,
            ...(waveId !== undefined ? {waveId, activeSides} : {}),
          });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      post({type: 'battle:error', battleId, error: msg});
    }
  };

  void Promise.all([
    pump('p1', streams.p1),
    pump('p2', streams.p2),
    pump('omniscient', streams.omniscient),
  ]).then(() => {
    if (!active.ended) {
      active.ended = true;
      post({
        type: 'battle:end',
        battleId,
        log: stream.battle?.log ? [...stream.battle.log] : [],
      });
    }
    battles.delete(battleId);
  }).catch(() => {
    battles.delete(battleId);
  });
}

function writeBattle(battleId: string, chunk: string, writeId?: number) {
  const active = battles.get(battleId);
  if (!active) {
    if (writeId !== undefined) post({type: 'battle:wrote', battleId, writeId});
    return;
  }
  active.writeChain = active.writeChain
    .then(async () => {
      await active.stream.write(chunk);
      // Yield one macrotask so `pump` posts all resulting `battle:chunk` messages onto the FIFO
      // `MessagePort` before `battle:wrote` resolves the parent's `battle.write()` call.
      await new Promise<void>(resolve => setImmediate(resolve));
    })
    .catch(() => undefined)
    .finally(() => {
      if (writeId !== undefined) {
        post({type: 'battle:wrote', battleId, writeId});
      }
    });
}

function destroyBattle(battleId: string) {
  const active = battles.get(battleId);
  if (!active) return;
  active.ended = true;
  void Promise.resolve(active.stream.destroy()).catch(() => undefined);
  battles.delete(battleId);
}

function handleRpc(req: RpcRequest): unknown {
  switch (req.method) {
    case 'getVersion':
      return pkgVersion;
    case 'resolveArenaFormatId':
      return simOps.resolveArenaFormatIdWithSim(simMod, req.format);
    case 'getTimerSettings':
      return simOps.resolveTimerSettingsWithSim(simMod, req.format);
    case 'isGeneratedTeamFormat':
      return Boolean(simMod.Dex.formats.get(req.format).team);
    case 'hasFormat':
      return Boolean(simMod.Dex.formats.get(req.format).exists);
    case 'sampleRandomPair':
      return simOps.sampleRandomPairWithSim(simMod, req.format, req.seed1, req.seed2);
    case 'validateTeam':
      return simOps.validateTeamWithSim(simMod, req.format, req.packed, req.options);
  }
}

port.on('message', (msg: ParentMessage) => {
  switch (msg.type) {
    case 'battle:start':
      startBattle(msg.battleId);
      break;
    case 'battle:write':
      writeBattle(msg.battleId, msg.chunk, msg.writeId);
      break;
    case 'battle:destroy':
      destroyBattle(msg.battleId);
      break;
    case 'rpc':
      try {
        const result = handleRpc(msg);
        post({type: 'rpc:result', id: msg.id, result});
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        post({type: 'rpc:result', id: msg.id, error});
      }
      break;
  }
});
