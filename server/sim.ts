import * as fs from 'fs';
import * as path from 'path';
import {Worker} from 'worker_threads';

import type {PRNGSeed} from '@pkmn/sim';

import {SIM_VERSION} from '../db/ladders';
import {root} from '../static/util';

import {TimerSettings} from './sim-ops';
import type {ParentMessage, RpcRequest, WorkerInitData, WorkerMessage} from './sim-worker';

class PushStream implements AsyncIterable<string> {
  private readonly queue: string[] = [];
  private waiter: ((result: IteratorResult<string>) => void) | undefined = undefined;
  private rejectWaiter: ((err: Error) => void) | undefined = undefined;
  private ended = false;
  private error: Error | undefined = undefined;

  push(chunk: string) {
    if (this.ended || this.error) return;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = undefined;
      this.rejectWaiter = undefined;
      resolve({value: chunk, done: false});
      return;
    }
    this.queue.push(chunk);
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = undefined;
      this.rejectWaiter = undefined;
      resolve({value: '', done: true});
    }
  }

  fail(err: Error) {
    if (this.ended || this.error) return;
    this.error = err;
    if (this.rejectWaiter) {
      const reject = this.rejectWaiter;
      this.waiter = undefined;
      this.rejectWaiter = undefined;
      reject(err);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          return Promise.resolve({value: this.queue.shift()!, done: false});
        }
        if (this.error) {
          return Promise.reject(this.error);
        }
        if (this.ended) {
          return Promise.resolve({value: undefined as unknown as string, done: true});
        }
        return new Promise<IteratorResult<string>>((resolve, reject) => {
          this.waiter = resolve;
          this.rejectWaiter = reject;
        });
      },
    };
  }
}

export interface BattleStreamsHandle {
  p1: AsyncIterable<string>;
  p2: AsyncIterable<string>;
  omniscient: AsyncIterable<string>;
}

export interface BattleHandle {
  streams: BattleStreamsHandle;
  write(chunk: string): Promise<void>;
  destroy(): Promise<void>;
  getPokemon(slot: 'p1' | 'p2'): unknown[] | undefined;
  getWaveInfo(): {waveId: number; activeSides: number};
  getLog(): string[];
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

interface ActiveBattleState {
  p1: PushStream;
  p2: PushStream;
  omniscient: PushStream;
  p1Pokemon?: unknown[];
  p2Pokemon?: unknown[];
  waveId: number;
  activeSides: number;
  pendingWrites: Map<number, () => void>;
  logLines: string[];
  finalLog?: string[];
  destroyed: boolean;
}

interface WorkerEntry {
  key: string;
  worker: Worker;
  battles: Map<string, ActiveBattleState>;
  rpcs: Map<number, PendingRpc>;
}

const workers = new Map<string, WorkerEntry>();
let nextBattleId = 1;
let nextRpcId = 1;
let nextWriteId = 1;

function resolvePendingWrites(battle: ActiveBattleState) {
  for (const resolve of battle.pendingWrites.values()) {
    resolve();
  }
  battle.pendingWrites.clear();
}

function resolveWorkerScript(): string {
  const sameDirJs = path.join(__dirname, 'sim-worker.js');
  if (fs.existsSync(sameDirJs)) return sameDirJs;
  const builtJs = root('build', 'server', 'sim-worker.js');
  if (fs.existsSync(builtJs)) return builtJs;
  return path.join(__dirname, 'sim-worker.ts');
}

function updateWorkerRef(entry: WorkerEntry) {
  if (entry.battles.size === 0 && entry.rpcs.size === 0) {
    entry.worker.unref();
  } else {
    entry.worker.ref();
  }
}

function failEntry(entry: WorkerEntry, err: Error) {
  workers.delete(entry.key);
  for (const rpc of entry.rpcs.values()) {
    rpc.reject(err);
  }
  entry.rpcs.clear();
  for (const battle of entry.battles.values()) {
    resolvePendingWrites(battle);
    battle.p1.fail(err);
    battle.p2.fail(err);
    battle.omniscient.fail(err);
  }
  entry.battles.clear();
}

function getWorker(version: string): WorkerEntry {
  const existing = workers.get(version);
  if (existing) return existing;

  const initData: WorkerInitData = {version};
  const worker = new Worker(resolveWorkerScript(), {workerData: initData});
  const entry: WorkerEntry = {
    key: version,
    worker,
    battles: new Map(),
    rpcs: new Map(),
  };
  workers.set(version, entry);
  updateWorkerRef(entry);

  worker.on('message', (msg: WorkerMessage) => {
    switch (msg.type) {
      case 'battle:chunk': {
        const b = entry.battles.get(msg.battleId);
        if (!b) return;
        if (msg.channel === 'omniscient') {
          if (msg.p1Pokemon !== undefined) b.p1Pokemon = msg.p1Pokemon;
          if (msg.p2Pokemon !== undefined) b.p2Pokemon = msg.p2Pokemon;
          b.logLines.push(msg.chunk);
        } else {
          if (msg.waveId !== undefined) b.waveId = msg.waveId;
          if (msg.activeSides !== undefined && msg.activeSides > 0) {
            b.activeSides = msg.activeSides;
          }
        }
        b[msg.channel].push(msg.chunk);
        break;
      }
      case 'battle:wrote': {
        const b = entry.battles.get(msg.battleId);
        if (!b) return;
        const resolveWrite = b.pendingWrites.get(msg.writeId);
        if (resolveWrite) {
          b.pendingWrites.delete(msg.writeId);
          resolveWrite();
        }
        break;
      }
      case 'battle:end': {
        const b = entry.battles.get(msg.battleId);
        if (!b) return;
        if (msg.log.length > 0) b.finalLog = msg.log;
        resolvePendingWrites(b);
        b.p1.end();
        b.p2.end();
        b.omniscient.end();
        entry.battles.delete(msg.battleId);
        updateWorkerRef(entry);
        break;
      }
      case 'battle:error': {
        const b = entry.battles.get(msg.battleId);
        if (!b) return;
        const err = new Error(msg.error);
        resolvePendingWrites(b);
        b.p1.fail(err);
        b.p2.fail(err);
        b.omniscient.fail(err);
        entry.battles.delete(msg.battleId);
        updateWorkerRef(entry);
        break;
      }
      case 'rpc:result': {
        const rpc = entry.rpcs.get(msg.id);
        if (!rpc) return;
        entry.rpcs.delete(msg.id);
        updateWorkerRef(entry);
        if (msg.error !== undefined) {
          rpc.reject(new Error(msg.error));
        } else {
          rpc.resolve(msg.result);
        }
        break;
      }
    }
  });

  worker.on('error', err => {
    failEntry(entry, err instanceof Error ? err : new Error(String(err)));
  });

  worker.on('exit', code => {
    if (workers.get(version) === entry) {
      failEntry(entry, new Error(`sim-worker (${version}) exited with code ${code}`));
    }
  });

  return entry;
}

function callRpc<T>(version: string, request: RpcRequest): Promise<T> {
  const entry = getWorker(version);
  const id = nextRpcId++;
  return new Promise<T>((resolve, reject) => {
    entry.rpcs.set(id, {
      resolve: value => resolve(value as T),
      reject,
    });
    updateWorkerRef(entry);
    const msg: ParentMessage = {type: 'rpc', id, ...request};
    entry.worker.postMessage(msg);
  });
}

export function createBattle(version = SIM_VERSION): BattleHandle {
  const entry = getWorker(version);
  const battleId = `b${nextBattleId++}`;
  const state: ActiveBattleState = {
    p1: new PushStream(),
    p2: new PushStream(),
    omniscient: new PushStream(),
    waveId: 0,
    activeSides: 1,
    pendingWrites: new Map(),
    logLines: [],
    destroyed: false,
  };
  entry.battles.set(battleId, state);
  updateWorkerRef(entry);
  entry.worker.postMessage({type: 'battle:start', battleId} satisfies ParentMessage);

  return {
    streams: {
      p1: state.p1,
      p2: state.p2,
      omniscient: state.omniscient,
    },
    write(chunk: string): Promise<void> {
      if (state.destroyed || !entry.battles.has(battleId)) return Promise.resolve();
      const writeId = nextWriteId++;
      return new Promise<void>(resolve => {
        state.pendingWrites.set(writeId, resolve);
        entry.worker.postMessage(
          {type: 'battle:write', battleId, chunk, writeId} satisfies ParentMessage
        );
      });
    },
    destroy(): Promise<void> {
      if (state.destroyed) return Promise.resolve();
      state.destroyed = true;
      resolvePendingWrites(state);
      state.p1.end();
      state.p2.end();
      state.omniscient.end();
      entry.battles.delete(battleId);
      updateWorkerRef(entry);
      entry.worker.postMessage({type: 'battle:destroy', battleId} satisfies ParentMessage);
      return Promise.resolve();
    },
    getPokemon(slot: 'p1' | 'p2'): unknown[] | undefined {
      return slot === 'p1' ? state.p1Pokemon : state.p2Pokemon;
    },
    getWaveInfo(): {waveId: number; activeSides: number} {
      return {waveId: state.waveId, activeSides: state.activeSides};
    },
    getLog(): string[] {
      return state.finalLog ?? state.logLines;
    },
  };
}

export function resolveArenaFormatId(
  format: string,
  version = SIM_VERSION
): Promise<string> {
  return callRpc<string>(version, {method: 'resolveArenaFormatId', format});
}

export function getTimerSettings(
  format: string,
  version = SIM_VERSION
): Promise<TimerSettings> {
  return callRpc<TimerSettings>(version, {method: 'getTimerSettings', format});
}

export function isGeneratedTeamFormat(
  format: string,
  version = SIM_VERSION
): Promise<boolean> {
  return callRpc<boolean>(version, {method: 'isGeneratedTeamFormat', format});
}

export function hasFormat(
  format: string,
  version = SIM_VERSION
): Promise<boolean> {
  return callRpc<boolean>(version, {method: 'hasFormat', format});
}

export function sampleRandomPair(
  format: string,
  seed1: PRNGSeed,
  seed2: PRNGSeed,
  version = SIM_VERSION
): Promise<{t1Packed: string; t2Packed: string}> {
  return callRpc<{t1Packed: string; t2Packed: string}>(
    version,
    {method: 'sampleRandomPair', format, seed1, seed2}
  );
}

export function validateTeam(
  format: string,
  packed: string,
  version = SIM_VERSION
): Promise<{problems?: string[]; packed?: string}> {
  return callRpc<{problems?: string[]; packed?: string}>(
    version,
    {method: 'validateTeam', format, packed}
  );
}

export function getWorkerSimVersion(version = SIM_VERSION): Promise<string> {
  return callRpc<string>(version, {method: 'getVersion'});
}

export async function closeAllWorkers(): Promise<void> {
  const entries = [...workers.values()];
  workers.clear();
  await Promise.all(
    entries.map(async entry => {
      for (const rpc of entry.rpcs.values()) {
        rpc.reject(new Error('sim workers closed'));
      }
      entry.rpcs.clear();
      for (const battle of entry.battles.values()) {
        resolvePendingWrites(battle);
        battle.p1.end();
        battle.p2.end();
        battle.omniscient.end();
      }
      entry.battles.clear();
      await entry.worker.terminate();
    })
  );
}
