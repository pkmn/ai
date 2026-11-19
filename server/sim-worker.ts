import * as fs from 'fs';
import {createRequire} from 'module';
import * as path from 'path';
import {parentPort, workerData} from 'worker_threads';

import type * as simTypes from '@pkmn/sim';

import {root, toID} from '../static/util';

import {
  configureSimMod,
  resolveArenaFormatIdWithSim,
  sampleRandomPairWithSim,
} from './sim-ops';

export interface WorkerInitData {
  version: string;
}

export type RpcRequest = {
  method: 'getVersion';
} | {
  method: 'resolveArenaFormatId';
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
};

export type ParentMessage = {
  type: 'battle:start';
  battleId: string;
} | {
  type: 'battle:write';
  battleId: string;
  chunk: string;
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

configureSimMod(simMod, {
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
          post({type: 'battle:chunk', battleId, channel, chunk});
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

function writeBattle(battleId: string, chunk: string) {
  const active = battles.get(battleId);
  if (!active) return;
  active.writeChain = active.writeChain
    .then(() => active.stream.write(chunk))
    .catch(() => undefined);
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
      return resolveArenaFormatIdWithSim(simMod, req.format);
    case 'isGeneratedTeamFormat':
      return Boolean(simMod.Dex.formats.get(req.format).team);
    case 'hasFormat':
      return Boolean(simMod.Dex.formats.get(req.format).exists);
    case 'sampleRandomPair':
      return sampleRandomPairWithSim(simMod, req.format, req.seed1, req.seed2);
    case 'validateTeam': {
      const resolved = simMod.Dex.formats.get(toID(req.format));
      if (!resolved.exists) {
        throw new Error(`Unknown format '${req.format}'.`);
      }
      const validator = new simMod.TeamValidator(resolved);
      const team = simMod.Teams.unpack(req.packed) ?? simMod.Teams.import(req.packed);
      if (!team || team.length === 0) {
        return {problems: ['Empty or unparseable team.']};
      }
      for (const s of team) s.name = '';
      if (!validator.format.team) {
        const problems = validator.validateTeam(team);
        if (problems && problems.length > 0) {
          return {problems};
        }
      }
      return {
        packed: simMod.Teams.pack(team),
      };
    }
  }
}

port.on('message', (msg: ParentMessage) => {
  switch (msg.type) {
    case 'battle:start':
      startBattle(msg.battleId);
      break;
    case 'battle:write':
      writeBattle(msg.battleId, msg.chunk);
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
