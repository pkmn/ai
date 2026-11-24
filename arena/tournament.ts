import {ChildProcessWithoutNullStreams, execFileSync, spawn} from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type {PRNGSeed} from '@pkmn/sim';

import {SIM_VERSION} from '../db/ladders';
import {
  Input as SmokeDiagnosticInput,
  battleLogHasAiTelemetry,
} from '../db/smoke-diagnostics';
import {getTournamentBestOf} from '../db/tournaments';
import * as arena from '../server/arena';
import {
  PublicAgentInfo,
  filterPlayerProtocolChunk,
  injectAiLogLines,
  parseAgentStdoutLine,
} from '../server/protocol';
import {GameOutcome} from '../server/ratings';
import * as sim from '../server/sim';
import * as simOps from '../server/sim-ops';
import {toID} from '../static/util';
import * as teams from '../teams';

import * as engine from './engine';
import * as packages from './packages';

type PlayerSlot = engine.PlayerSlot;

export function deriveGameSeed(baseSeed: PRNGSeed, gameNumber: number): PRNGSeed {
  if (gameNumber <= 1) return baseSeed;
  const digest = crypto
    .createHash('sha256')
    .update(`${baseSeed}:g${gameNumber}`)
    .digest();
  if (baseSeed.startsWith('sodium,')) {
    return `sodium,${digest.toString('hex')}`;
  }
  const s0 = digest.readUInt16BE(0);
  const s1 = digest.readUInt16BE(2);
  const s2 = digest.readUInt16BE(4);
  const s3 = digest.readUInt16BE(6);
  return `${s0},${s1},${s2},${s3}`;
}

export function computeSeriesOutcome(
  outcomes: readonly GameOutcome[]
): {outcome: GameOutcome; p1Score: number; p2Score: number} {
  let p1Score = 0;
  for (const o of outcomes) {
    p1Score += o === 'W' ? 1 : o === 'T' ? 0.5 : 0;
  }
  const p2Score = outcomes.length - p1Score;
  const outcome: GameOutcome = p1Score > p2Score ? 'W' : p2Score > p1Score ? 'L' : 'T';
  return {outcome, p1Score, p2Score};
}

export interface AgentSpec {
  agentId: string;
  displayName: string;
  vmHost: string;
  controlSocket: string;
  // Optional local override for dev/testing without SSH to a GCE VM
  localCommand?: string;
  localArgs?: string[];
}

export interface TurnSlotBroadcast {
  bankSeconds: number;
  thinking: boolean;
  pokemon?: unknown[];
  info?: PublicAgentInfo;
}

export interface TurnBroadcastInfo {
  turn: number;
  p1: TurnSlotBroadcast;
  p2: TurnSlotBroadcast;
  winHistory?: arena.WinHistoryPoint[];
}

export type SeriesGameSummary = arena.SeriesGameSummary;

export interface GamePlayerStats {
  bankSeconds: number;
  initMillis?: number;
  teamPreviewMillis?: number;
  meanTurnMillis: number;
  peakRam: number;
  errors?: engine.ProtocolErrorCounts;
  stderr?: string;
}

export interface PlayerResult extends GamePlayerStats {
  teamPacked: string;
}

export interface SeriesGameResult {
  seed: PRNGSeed;
  outcome: GameOutcome;
  turns: number;
  endReason: string;
  omniscientLog: string;
  p1: GamePlayerStats;
  p2: GamePlayerStats;
}

export interface GamePlayerOptions {
  spec: AgentSpec;
  teamPacked?: string;
}

export interface GameCallbacks {
  onGameStart?: (info: {
    game: number;
    bestOf: number;
    summaries: SeriesGameSummary[];
  }) => void | Promise<void>;
  onSpectatorChunk?: (chunk: string, state: TurnBroadcastInfo) => void;
  onClockChange?: (state: TurnBroadcastInfo) => void;
}

export interface GameOptions {
  format: string;
  version?: string;
  bestOf?: number;
  seed: PRNGSeed;
  p1: GamePlayerOptions;
  p2: GamePlayerOptions;
  sendUtm?: boolean;
  maxTurns?: number;
  maxWallMillis?: number;
  smokeStopAfterTurn?: number;
  stderrCapture?: engine.StderrCaptureLimits;
  timers?: engine.GameTimerOptions;
  callbacks?: GameCallbacks;
}

export interface GameResult {
  winner: PlayerSlot | 'tie' | 'preempted';
  outcome?: GameOutcome;
  preemptedSlot?: PlayerSlot;
  turns: number;
  endReason: string;
  launchError?: string;
  omniscientLog: string;
  p1: PlayerResult;
  p2: PlayerResult;
  games: SeriesGameResult[];
}

interface RemoteTournamentPlayer {
  slot: PlayerSlot;
  spec: AgentSpec;
  proc: ChildProcessWithoutNullStreams;
  io: engine.LineIoState & {
    stderrBuf: engine.BoundedStderrBuffer;
  };
  relay: {
    usesRelay: boolean;
    reqSeq: number;
    turnMillisByLine: Map<number, number>;
    turnMillisWaiter: {lineSeq: number; wake: () => void} | undefined;
  };
  turn: engine.PlayerTurnState;
  errors: engine.ProtocolErrorCounts;
  telemetry: engine.DecisionTelemetry & {
    initMillis: number;
    peakRam: number;
  };
  state: {
    spotPreempted: boolean;
    sshDisconnected: boolean;
    launchError: string | undefined;
    thinking: boolean;
    exited: boolean;
  };
}

const {MAX_STDOUT_LINE_CHARS, MAX_LINE_QUEUE, MAX_LINES_PER_DECISION, rewriteBlindPlayerNames} =
  engine;
const TOURNEY_AGENT_BIN = '/usr/local/bin/tourney-agent';
export {rewriteBlindPlayerNames};

export interface TeamPair {
  p1Team: string;
  p2Team: string;
}

export function buildLockedTournamentTeamBook(
  teamPool: readonly string[],
  pairCount: number,
  format: string,
  tournamentId = '1'
): TeamPair[] {
  const uniqueTeams = [...new Set(teamPool.filter(Boolean))];
  if (uniqueTeams.length < 2 || pairCount <= 0) return [];

  const cleanFormat = toID(format);
  const dex = teams.getDex(cleanFormat);
  const defaultLevel = teams.defaultLevelForFormat(cleanFormat);

  // Deterministically order teams by SHA-256(tournamentId:packed) so every Coordinator restart
  // reconstructs the identical locked 2M-team book from the tournament's teamPool.
  const annotated = uniqueTeams
    .map(packed => {
      const sets = teams.parseTeam(dex, packed);
      const sortHash = crypto
        .createHash('sha256')
        .update(`${tournamentId}:${packed}`)
        .digest('hex');
      return {packed, sets, sortHash};
    })
    .sort((a, b) => a.sortHash.localeCompare(b.sortHash));

  const targetTeams = pairCount * 2;
  const selected: typeof annotated = [];
  const usedPacked = new Set<string>();

  // Pass 1: Select up to 2M pairwise-distinct teams (teamDistance >= THRESHOLD)
  for (const item of annotated) {
    if (selected.length >= targetTeams) break;
    const isDistinctFromSelected = selected.every(
      prev => teams.teamDistance(dex, item.sets, prev.sets, defaultLevel) >= teams.THRESHOLD
    );
    if (!isDistinctFromSelected) continue;
    usedPacked.add(item.packed);
    selected.push(item);
  }

  // Fallback if the pool has fewer than 2M pairwise-distinct teams: fill from remaining teams
  if (selected.length < targetTeams) {
    for (const item of annotated) {
      if (selected.length >= targetTeams) break;
      if (usedPacked.has(item.packed)) continue;
      usedPacked.add(item.packed);
      selected.push(item);
    }
  }

  // Pair the selected teams into M match pairs with teamDistance >= THRESHOLD
  const remaining = [...selected];
  const pairs: Array<{a: (typeof annotated)[number]; b: (typeof annotated)[number]}> = [];

  while (remaining.length >= 2) {
    const a = remaining.shift()!;
    let partnerIdx = remaining.findIndex(
      cand => teams.teamDistance(dex, a.sets, cand.sets, defaultLevel) >= teams.THRESHOLD
    );
    if (partnerIdx < 0) partnerIdx = 0;
    const [b] = remaining.splice(partnerIdx, 1);
    pairs.push({a, b});
  }

  // 2-opt repair if any fallback pair at the tail ended up below THRESHOLD
  for (let i = 0; i < pairs.length; i++) {
    if (
      teams.teamDistance(dex, pairs[i].a.sets, pairs[i].b.sets, defaultLevel) >=
      teams.THRESHOLD
    ) {
      continue;
    }
    for (let j = 0; j < pairs.length; j++) {
      if (i === j) continue;
      if (
        teams.teamDistance(dex, pairs[i].a.sets, pairs[j].b.sets, defaultLevel) >=
          teams.THRESHOLD &&
        teams.teamDistance(dex, pairs[j].a.sets, pairs[i].b.sets, defaultLevel) >=
          teams.THRESHOLD
      ) {
        const tmp = pairs[i].b;
        pairs[i].b = pairs[j].b;
        pairs[j].b = tmp;
        break;
      }
    }
  }

  const book: TeamPair[] = pairs.map(p => ({
    p1Team: p.a.packed,
    p2Team: p.b.packed,
  }));

  while (book.length > 0 && book.length < pairCount) {
    const base = book[book.length % pairs.length];
    book.push({p1Team: base.p1Team, p2Team: base.p2Team});
  }

  return book;
}

export class ConcurrentGame {
  private readonly version: string;
  private format: string;
  private readonly bestOf: number;
  private readonly seed: PRNGSeed;
  private readonly p1Spec: AgentSpec;
  private readonly p2Spec: AgentSpec;
  private p1TeamPacked?: string;
  private p2TeamPacked?: string;
  private sendUtm?: boolean;
  private readonly maxTurns: number;
  private readonly maxWallMillis?: number;
  private readonly smokeStopAfterTurn?: number;
  private readonly stderrCapture: engine.StderrCaptureLimits;
  private readonly timerOverrides: engine.TimerOverrides;
  private timers: engine.ResolvedClockTimers;
  private readonly readyGraceMillis: number;
  private readonly callbacks?: GameCallbacks;
  private readonly infoCoalescer: engine.InfoCoalescer;

  private battle: sim.BattleHandle | undefined = undefined;
  private battleStartedAtNs: bigint | undefined = undefined;

  private p1!: RemoteTournamentPlayer;
  private p2!: RemoteTournamentPlayer;
  private currentTurn = 0;
  private requestCount = 0;
  private lastWaveId = 0;
  private waveActiveSidesCount = 1;
  private lastRewardedTurn: Record<PlayerSlot, number> = {p1: -1, p2: -1};
  private ended = false;
  private winner: PlayerSlot | 'tie' | 'preempted' = 'tie';
  private preemptedSlot?: PlayerSlot;
  private endReason = 'normal';

  constructor(options: GameOptions) {
    this.version = options.version ?? SIM_VERSION;
    this.format = options.format;
    this.bestOf = options.smokeStopAfterTurn !== undefined
      ? 1
      : (options.bestOf ?? getTournamentBestOf(options.format));
    this.seed = options.seed;
    this.p1Spec = options.p1.spec;
    this.p2Spec = options.p2.spec;
    this.p1TeamPacked = options.p1.teamPacked;
    this.p2TeamPacked = options.p2.teamPacked;
    this.sendUtm = options.sendUtm;
    this.maxTurns = options.maxTurns ?? arena.MAX_BATTLE_TURNS;
    this.maxWallMillis = options.maxWallMillis;
    this.smokeStopAfterTurn = options.smokeStopAfterTurn;
    this.stderrCapture = options.stderrCapture ?? {
      headBytes: 0,
      tailBytes: engine.STDERR_TAIL_BYTES,
    };
    this.timerOverrides = {
      startingBankSeconds: options.timers?.startingBankSeconds,
      graceSeconds: options.timers?.graceSeconds,
      maxTurnSeconds: options.timers?.maxTurnSeconds,
      maxFirstTurnSeconds: options.timers?.maxFirstTurnSeconds,
    };
    this.timers = engine.resolveClockTimers(
      arena.timerSettingsForFormat(options.format),
      this.timerOverrides
    );
    this.readyGraceMillis =
      (options.timers?.readyGraceSeconds ?? arena.READY_GRACE_SECONDS) * 1000;
    this.callbacks = options.callbacks;
    this.infoCoalescer = new engine.InfoCoalescer({
      onBroadcast: () => {
        if (!this.ended && this.battle) {
          this.callbacks?.onClockChange?.(this.buildBroadcastState());
        }
      },
    });
  }

  private getFullLog(): string {
    const rawLog = this.battle?.getLog().join('\n') ?? '';
    const withAi = injectAiLogLines(rawLog, this.infoCoalescer.getCommittedByTurn());
    return rewriteBlindPlayerNames(withAi, this.p1Spec.displayName, this.p2Spec.displayName);
  }

  private buildBroadcastState(): TurnBroadcastInfo {
    const p1Pokemon = this.battle?.getPokemon('p1');
    const p2Pokemon = this.battle?.getPokemon('p2');
    const winHistory = this.infoCoalescer.getWinHistory();
    return {
      turn: this.currentTurn,
      p1: this.buildSlotBroadcast(this.p1, p1Pokemon),
      p2: this.buildSlotBroadcast(this.p2, p2Pokemon),
      ...(winHistory.length > 0 ? {winHistory} : {}),
    };
  }

  private emitSpectatorChunk(rawChunk: string) {
    if (!rawChunk) return;
    const publicChunk = rewriteBlindPlayerNames(
      rawChunk,
      this.p1Spec.displayName,
      this.p2Spec.displayName
    );
    this.callbacks?.onSpectatorChunk?.(publicChunk, this.buildBroadcastState());
  }

  private buildSlotBroadcast(
    player: RemoteTournamentPlayer | undefined,
    pokemon: unknown[] | undefined
  ): TurnSlotBroadcast {
    const bankMillis = player
      ? Math.min(player.turn.bankMillis, this.timers.startingBankMillis)
      : this.timers.startingBankMillis;
    const info = player ? this.infoCoalescer.getLive(player.slot) : undefined;
    return {
      bankSeconds: Math.max(0, Math.round(bankMillis / 1000)),
      thinking: Boolean(player?.state.thinking),
      ...(pokemon !== undefined ? {pokemon} : {}),
      ...(info !== undefined ? {info} : {}),
    };
  }

  private spawnRemotePlayer(slot: PlayerSlot, spec: AgentSpec): RemoteTournamentPlayer {
    if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(spec.agentId) || spec.agentId.includes('..')) {
      throw new Error(`Invalid tournament agentId: ${spec.agentId}`);
    }
    const proc = spec.localCommand
      ? spawn(spec.localCommand, spec.localArgs ?? [], {stdio: ['pipe', 'pipe', 'pipe']})
      : spawn(
        'ssh',
        [
          '-T',
          '-o', 'BatchMode=yes',
          '-o', 'ServerAliveInterval=5',
          '-o', 'ServerAliveCountMax=2',
          '-S', spec.controlSocket,
          `pkmn@${spec.vmHost}`,
          `/usr/local/bin/tourney-agent ${spec.agentId}`,
        ],
        {stdio: ['pipe', 'pipe', 'pipe']}
      );

    const localBase = spec.localCommand ? path.basename(spec.localCommand) : '';
    const usesRelay =
      !spec.localCommand || localBase === 'tourney-relay' || localBase === 'tourney-agent';
    const player: RemoteTournamentPlayer = {
      slot,
      spec,
      proc,
      io: {
        lineQueue: [],
        lineSeqQueue: [],
        lineResolver: undefined,
        stderrBuf: new engine.BoundedStderrBuffer(this.stderrCapture),
      },
      relay: {
        usesRelay,
        reqSeq: 0,
        turnMillisByLine: new Map(),
        turnMillisWaiter: undefined,
      },
      turn: {
        slot,
        bankMillis: this.timers.startingBankMillis + this.timers.graceMillis,
        turnRemainingMillis: undefined,
        hasTakenFirstDecision: false,
        retryingInvalidChoice: false,
        invalidStrikes: 0,
        lastRequestJson: undefined,
      },
      errors: engine.emptyProtocolErrorCounts(),
      telemetry: {
        initMillis: 0,
        totalTeamPreviewMillis: 0,
        teamPreviewCount: 0,
        totalTurnDecisionMillis: 0,
        turnDecisionCount: 0,
        peakRam: 1,
      },
      state: {
        spotPreempted: false,
        sshDisconnected: false,
        launchError: undefined,
        thinking: false,
        exited: false,
      },
    };

    const onDisconnect = (code?: number | null) => {
      player.state.exited = true;
      if (code === 255) {
        player.state.sshDisconnected = true;
      }
      if (player.relay.turnMillisWaiter) {
        const w = player.relay.turnMillisWaiter;
        player.relay.turnMillisWaiter = undefined;
        w.wake();
      }
      engine.wakeLineResolver(player.io);
    };

    engine.attachStdoutLineFramer(
      proc,
      player.io,
      () => onDisconnect(1),
      engine.createInfoLineInterceptor(slot, this.infoCoalescer)
    );

    const handleStderrLine = (errLine: string) => {
      if (errLine.startsWith('ARENA_TURN_MS=')) {
        const rawVal = errLine.slice('ARENA_TURN_MS='.length).trim();
        const [millisStr, seqStr, lineSeqStr] = rawVal.split('\t');
        const millis = Number(millisStr);
        const seq = seqStr !== undefined ? Number(seqStr) : player.relay.reqSeq;
        const lineSeq = lineSeqStr !== undefined ? Number(lineSeqStr) : NaN;
        if (
          Number.isFinite(millis) &&
          millis >= 0 &&
          seq === player.relay.reqSeq &&
          Number.isSafeInteger(lineSeq) &&
          lineSeq > 0
        ) {
          if (
            player.relay.turnMillisByLine.size >= MAX_LINE_QUEUE &&
            !player.relay.turnMillisByLine.has(lineSeq)
          ) {
            const oldestKey = player.relay.turnMillisByLine.keys().next().value;
            if (oldestKey !== undefined) player.relay.turnMillisByLine.delete(oldestKey);
          }
          player.relay.turnMillisByLine.set(lineSeq, millis);
          if (player.relay.turnMillisWaiter?.lineSeq === lineSeq) {
            const w = player.relay.turnMillisWaiter;
            player.relay.turnMillisWaiter = undefined;
            w.wake();
          }
        }
      } else if (errLine.startsWith('ARENA_PEAK_RAM=')) {
        const mib = Number(errLine.slice('ARENA_PEAK_RAM='.length).trim());
        if (Number.isFinite(mib) && mib >= 1) {
          player.telemetry.peakRam = Math.max(player.telemetry.peakRam, Math.round(mib));
        }
      } else if (errLine.includes('ARENA_SPOT_PREEMPTED')) {
        player.state.spotPreempted = true;
      } else if (errLine.startsWith('TOURNEY_ERROR:')) {
        player.state.launchError = errLine.trim();
      } else {
        player.io.stderrBuf.append(`${errLine}\n`);
      }
    };

    let stderrBuf = '';
    let stderrOverflow = false;
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      let data = chunk;
      if (stderrOverflow) {
        const nl = data.indexOf('\n');
        if (nl < 0) return;
        data = data.slice(nl + 1);
        stderrOverflow = false;
      }
      stderrBuf += data;
      let start = 0;
      let nl = stderrBuf.indexOf('\n', start);
      while (nl >= 0) {
        const end = nl > start && stderrBuf.charCodeAt(nl - 1) === 0x0d ? nl - 1 : nl;
        const errLine = stderrBuf.slice(start, end);
        start = nl + 1;
        handleStderrLine(errLine);
        nl = stderrBuf.indexOf('\n', start);
      }
      if (start > 0) {
        stderrBuf = stderrBuf.slice(start);
      }
      if (stderrBuf.length > MAX_STDOUT_LINE_CHARS) {
        stderrBuf = '';
        stderrOverflow = true;
      }
    });

    proc.on('exit', code => onDisconnect(code));
    proc.on('close', code => {
      if (stderrBuf.length > 0 && !stderrOverflow) {
        handleStderrLine(stderrBuf.replace(/\r$/, ''));
        stderrBuf = '';
      }
      onDisconnect(code);
    });
    proc.on('error', () => onDisconnect(255));
    proc.stdin.on('error', () => undefined);

    return player;
  }

  private consumeTurnMillisForLine(
    player: RemoteTournamentPlayer,
    lineSeq: number
  ): number | undefined {
    const val = player.relay.turnMillisByLine.get(lineSeq);
    if (val === undefined) return undefined;
    for (const key of player.relay.turnMillisByLine.keys()) {
      if (key <= lineSeq) player.relay.turnMillisByLine.delete(key);
    }
    return val;
  }

  private async takeLocalTurnMillis(
    player: RemoteTournamentPlayer,
    line: string | undefined,
    lineSeq: number | undefined,
    wallMillis: number
  ): Promise<number> {
    if (line === undefined || lineSeq === undefined || player.relay.reqSeq === 0) return wallMillis;
    const immediate = this.consumeTurnMillisForLine(player, lineSeq);
    if (immediate !== undefined) return immediate;
    if (player.relay.usesRelay && !player.state.exited) {
      await new Promise<void>(resolve => {
        const waiter = {
          lineSeq,
          wake: () => {
            clearTimeout(t);
            resolve();
          },
        };
        const t = setTimeout(() => {
          if (player.relay.turnMillisWaiter === waiter) player.relay.turnMillisWaiter = undefined;
          resolve();
        }, 25);
        player.relay.turnMillisWaiter = waiter;
      });
      const delayed = this.consumeTurnMillisForLine(player, lineSeq);
      if (delayed !== undefined) return delayed;
    }
    return wallMillis;
  }

  private async readLineWithTimeout(
    player: RemoteTournamentPlayer,
    budgetMillis: number,
    decisionStartNs: bigint = process.hrtime.bigint(),
    omitSlack = false
  ): Promise<{line: string | undefined; elapsedMillis: number; timedOut: boolean}> {
    if (player.io.lineQueue.length > 0) {
      const line = player.io.lineQueue.shift()!;
      const lineSeq = player.io.lineSeqQueue?.shift();
      const wallMillis = Number(process.hrtime.bigint() - decisionStartNs) / 1e6;
      const elapsedMillis = await this.takeLocalTurnMillis(player, line, lineSeq, wallMillis);
      return {line, elapsedMillis, timedOut: false};
    }
    if (player.state.exited) {
      return {line: undefined, elapsedMillis: 0, timedOut: false};
    }

    const raw = await new Promise<{
      line: string | undefined;
      lineSeq: number | undefined;
      wallMillis: number;
      timedOut: boolean;
    }>(resolve => {
      // Allow +1500 ms network slack over SSH (100 ms locally) so local VM clock is authoritative
      const slackMillis = omitSlack ? 0 : (player.spec.localCommand ? 100 : 1500);
      const timer = setTimeout(() => {
        player.io.lineResolver = undefined;
        const wallMillis = Math.max(
          budgetMillis,
          Number(process.hrtime.bigint() - decisionStartNs) / 1e6
        );
        resolve({line: undefined, lineSeq: undefined, wallMillis, timedOut: true});
      }, Math.max(1, Math.ceil(budgetMillis + slackMillis)));

      player.io.lineResolver = (line, lineSeq) => {
        clearTimeout(timer);
        const wallMillis = Number(process.hrtime.bigint() - decisionStartNs) / 1e6;
        resolve({line, lineSeq, wallMillis, timedOut: false});
      };
    });
    if (raw.timedOut) {
      return {line: undefined, elapsedMillis: raw.wallMillis, timedOut: true};
    }
    const elapsedMillis = await this.takeLocalTurnMillis(
      player,
      raw.line,
      raw.lineSeq,
      raw.wallMillis
    );
    return {line: raw.line, elapsedMillis, timedOut: false};
  }

  private async validatePackedTeam(rawTeam: string | undefined): Promise<string | undefined> {
    if (!rawTeam) return undefined;
    const res = await sim.validateTeam(
      this.format,
      rawTeam.trim(),
      this.version
    );
    if (res.problems && res.problems.length > 0) return undefined;
    return res.packed;
  }

  private async waitForPlayerReady(
    player: RemoteTournamentPlayer
  ): Promise<{ok: true} | {ok: false; reason: 'spot-preemption' | 'timeout' | 'crash'}> {
    let remaining = this.readyGraceMillis;
    const startNs = process.hrtime.bigint();
    let linesRead = 0;
    while (true) {
      const {line, timedOut} = await this.readLineWithTimeout(player, remaining);
      const elapsedMillis = Number(process.hrtime.bigint() - startNs) / 1e6;
      remaining = this.readyGraceMillis - elapsedMillis;
      if (player.state.spotPreempted || player.state.sshDisconnected) {
        return {ok: false, reason: 'spot-preemption'};
      }
      if (timedOut || remaining <= 0) {
        return {ok: false, reason: 'timeout'};
      }
      if (line === undefined) {
        return {ok: false, reason: 'crash'};
      }
      linesRead++;
      if (linesRead > MAX_LINES_PER_DECISION) {
        return {ok: false, reason: 'crash'};
      }
      if (parseAgentStdoutLine(line)?.kind === 'ready') {
        player.telemetry.initMillis = Math.max(1, Math.ceil(elapsedMillis));
        return {ok: true};
      }
    }
  }

  private async waitForPlayerUtm(
    player: RemoteTournamentPlayer
  ): Promise<
    {ok: true; team: string} |
    {ok: false; reason: 'spot-preemption' | 'timeout' | 'crash' | 'invalid-choice'}
  > {
    let remaining = this.readyGraceMillis;
    const startNs = process.hrtime.bigint();
    let linesRead = 0;
    while (true) {
      const {line, timedOut} = await this.readLineWithTimeout(player, remaining);
      const elapsedMillis = Number(process.hrtime.bigint() - startNs) / 1e6;
      remaining = this.readyGraceMillis - elapsedMillis;
      if (player.state.spotPreempted || player.state.sshDisconnected) {
        return {ok: false, reason: 'spot-preemption'};
      }
      if (timedOut || remaining <= 0) {
        return {ok: false, reason: 'timeout'};
      }
      if (line === undefined) {
        return {ok: false, reason: 'crash'};
      }
      linesRead++;
      if (linesRead > MAX_LINES_PER_DECISION) {
        return {ok: false, reason: 'crash'};
      }
      const trimmed = line.trim();
      if (trimmed === '/utm' || trimmed.startsWith('/utm ')) {
        const valid = await this.validatePackedTeam(trimmed.slice(5));
        if (!valid) {
          return {ok: false, reason: 'invalid-choice'};
        }
        player.telemetry.initMillis = Math.max(1, Math.ceil(elapsedMillis));
        return {ok: true, team: valid};
      }
    }
  }

  private async resolvePlayerTeam(
    player: RemoteTournamentPlayer,
    assignedTeam: string | undefined
  ): Promise<
    {ok: true; team: string} |
    {ok: false; reason: 'spot-preemption' | 'timeout' | 'crash' | 'invalid-choice'}
  > {
    if (assignedTeam === undefined) {
      // In BYOT tournaments, `/utm <packed_team>` directly signals readiness within the
      // `readyGraceMillis` startup period (no separate `/ready` line).
      return this.waitForPlayerUtm(player);
    }

    const readyRes = await this.waitForPlayerReady(player);
    if (!readyRes.ok) return readyRes;

    // Pre-assigned teams come from `pkmn.ai` after server-side validation (`server/teams.ts` /
    // `server/sim.ts`); only untrusted `/utm` agent stdout above runs `validatePackedTeam`.
    const team = assignedTeam.trim();
    if (this.sendUtm && !player.state.exited && player.proc.stdin.writable) {
      player.proc.stdin.write(`|utm|${team}\n`);
    }
    return {ok: true, team};
  }

  private wakePendingLineResolvers() {
    engine.wakeLineResolver(this.p1?.io);
    engine.wakeLineResolver(this.p2?.io);
  }

  private abortForSpotPreemption(slot: PlayerSlot) {
    if (this.ended) return;
    this.ended = true;
    this.winner = 'preempted';
    this.preemptedSlot = slot;
    this.endReason = 'spot-preemption';
    this.wakePendingLineResolvers();
    if (this.battle) {
      void this.battle.write('>forcetie').catch(() => undefined);
    }
  }

  private forceLose(losingSlot: PlayerSlot, reason: string) {
    if (this.ended) return;
    this.ended = true;
    this.winner = losingSlot === 'p1' ? 'p2' : 'p1';
    this.endReason = reason;
    this.wakePendingLineResolvers();
    if (this.battle) {
      void this.battle.write(`>forcewin ${this.winner}`).catch(() => undefined);
    }
  }

  private remainingWallCapMillis(): number | undefined {
    if (this.maxWallMillis === undefined || this.battleStartedAtNs === undefined) {
      return undefined;
    }
    const elapsedMillis = Number(process.hrtime.bigint() - this.battleStartedAtNs) / 1e6;
    return Math.max(0, this.maxWallMillis - elapsedMillis);
  }

  private stopForDiagnosticCap() {
    if (this.ended) return;
    this.ended = true;
    this.winner = 'tie';
    this.endReason = 'diagnostic-cap';
    this.wakePendingLineResolvers();
    if (this.battle) {
      void this.battle.write('>forcetie').catch(() => undefined);
    }
  }

  private async handleDecision(player: RemoteTournamentPlayer, reqJson: string) {
    if (this.ended) return;
    const req = JSON.parse(reqJson) as {teamPreview?: boolean};
    const wasRetry = player.turn.retryingInvalidChoice;
    if (!wasRetry) {
      const wave = this.battle?.getWaveInfo() ?? {waveId: 0, activeSides: 1};
      if (wave.waveId === 0 || wave.waveId !== this.lastWaveId) {
        this.requestCount++;
        this.lastWaveId = wave.waveId;
      }
      this.waveActiveSidesCount = wave.activeSides || 1;
    }

    const {totalBudgetMillis, inactiveLine} = engine.beginTurnClockStep(
      player.turn,
      this.currentTurn,
      this.lastRewardedTurn,
      {
        ...this.timers,
        requestCount: this.requestCount,
        activeSidesCount: this.waveActiveSidesCount,
      }
    );

    if (!player.state.exited && player.proc.stdin.writable) {
      player.proc.stdin.write(inactiveLine);
    }

    let remainingBudgetMillis = totalBudgetMillis;
    let totalElapsedMillis = 0;
    let linesReadThisDecision = 0;
    const decisionStartNs = process.hrtime.bigint();
    player.state.thinking = true;
    if (wasRetry && !this.ended) {
      this.callbacks?.onClockChange?.(this.buildBroadcastState());
    }

    try {
      while (!this.ended) {
        const wallRemaining = this.currentTurn >= 1 ? this.remainingWallCapMillis() : undefined;
        if (wallRemaining !== undefined && wallRemaining <= 0) {
          this.stopForDiagnosticCap();
          return;
        }
        const waitMillis = wallRemaining !== undefined
          ? Math.min(remainingBudgetMillis, wallRemaining)
          : remainingBudgetMillis;
        const cappedByWall = wallRemaining !== undefined && wallRemaining < remainingBudgetMillis;
        const {line, elapsedMillis, timedOut} = waitMillis <= 0
          ? {line: undefined, elapsedMillis: 0, timedOut: true}
          : await this.readLineWithTimeout(player, waitMillis, decisionStartNs, cappedByWall);
        if (player.state.spotPreempted || player.state.sshDisconnected) {
          this.abortForSpotPreemption(player.slot);
          return;
        }
        if (this.ended) return;
        if (timedOut && cappedByWall) {
          const postWall = this.remainingWallCapMillis();
          if (postWall !== undefined && postWall <= 0) {
            this.stopForDiagnosticCap();
            return;
          }
          totalElapsedMillis = Math.max(
            totalElapsedMillis,
            Number(process.hrtime.bigint() - decisionStartNs) / 1e6
          );
          remainingBudgetMillis = totalBudgetMillis - totalElapsedMillis;
          if (remainingBudgetMillis > 0) continue;
        }
        totalElapsedMillis = Math.max(totalElapsedMillis, elapsedMillis);
        remainingBudgetMillis = totalBudgetMillis - totalElapsedMillis;
        if (timedOut || remainingBudgetMillis <= 0) {
          const outcome = engine.applyDecisionTimeout(
            player.turn,
            player.telemetry,
            totalBudgetMillis,
            this.timers.timeoutAutoChoose,
            req.teamPreview
          );
          if (outcome === 'auto-choose') {
            player.state.thinking = false;
            await this.battle!.write(`>${player.slot} default`);
            return;
          }
          this.forceLose(player.slot, 'timeout');
          return;
        }
        if (line === undefined) {
          this.forceLose(player.slot, 'crash');
          return;
        }

        linesReadThisDecision++;
        if (linesReadThisDecision > MAX_LINES_PER_DECISION) {
          this.forceLose(player.slot, 'crash');
          return;
        }

        const parsed = parseAgentStdoutLine(line);
        if (parsed?.kind !== 'choice') continue;

        const decisionElapsedMillis = Math.max(1, Math.ceil(totalElapsedMillis));
        engine.chargeDecisionClock(player.turn, decisionElapsedMillis);
        engine.recordDecisionTelemetry(player.telemetry, decisionElapsedMillis, req.teamPreview);
        player.state.thinking = false;
        this.infoCoalescer.commitTurn(player.slot, this.currentTurn);

        const choiceCmd = engine.formatChoiceCommand(parsed.choice, req.teamPreview);
        await this.battle!.write(`>${player.slot} ${choiceCmd}`);
        return;
      }
    } finally {
      player.state.thinking = false;
    }
  }

  private driveConcurrentPlayer(
    player: RemoteTournamentPlayer,
    stream: AsyncIterable<string>
  ): Promise<void> {
    return (async () => {
      for await (const rawChunk of stream) {
        const chunk = filterPlayerProtocolChunk(rawChunk);
        if (!chunk) continue;

        const inspected = engine.inspectPlayerProtocolChunk(
          chunk,
          player.turn,
          this.ended,
          player.errors
        );
        if (inspected.forfeitedInvalidChoice) {
          this.forceLose(player.slot, 'invalid-choice');
        }
        if (inspected.actionableReqJson) {
          player.relay.reqSeq++;
          player.io.lineQueue.length = 0;
          player.io.lineSeqQueue!.length = 0;
          player.relay.turnMillisByLine.clear();
        }
        if (!player.state.exited && player.proc.stdin.writable) {
          player.proc.stdin.write(`${chunk}\n`);
          if (inspected.resendLastRequest && player.turn.lastRequestJson) {
            player.proc.stdin.write(`|request|${player.turn.lastRequestJson}\n`);
          }
        }

        if (inspected.actionableReqJson && !this.ended) {
          await this.handleDecision(player, inspected.actionableReqJson);
          const other = player.slot === 'p1' ? this.p2 : this.p1;
          if (!this.ended && other?.state.thinking) {
            setImmediate(() => {
              if (
                !this.ended &&
                !player.state.thinking &&
                !player.turn.retryingInvalidChoice &&
                other.state.thinking
              ) {
                this.callbacks?.onClockChange?.(this.buildBroadcastState());
              }
            });
          }
        }
      }
    })();
  }

  private resetForNextSeriesGame() {
    this.currentTurn = 0;
    this.requestCount = 0;
    this.lastWaveId = 0;
    this.waveActiveSidesCount = 1;
    this.lastRewardedTurn = {p1: -1, p2: -1};
    this.ended = false;
    this.winner = 'tie';
    this.preemptedSlot = undefined;
    this.endReason = 'normal';
    this.infoCoalescer.reset();

    for (const p of [this.p1, this.p2]) {
      p.io.lineQueue.length = 0;
      p.io.lineSeqQueue!.length = 0;
      p.relay.turnMillisByLine.clear();
      p.turn.bankMillis = this.timers.startingBankMillis + this.timers.graceMillis;
      p.turn.turnRemainingMillis = undefined;
      p.telemetry.totalTeamPreviewMillis = 0;
      p.telemetry.teamPreviewCount = 0;
      p.telemetry.totalTurnDecisionMillis = 0;
      p.telemetry.turnDecisionCount = 0;
      p.turn.hasTakenFirstDecision = false;
      p.turn.retryingInvalidChoice = false;
      p.turn.invalidStrikes = 0;
      p.turn.lastRequestJson = undefined;
      p.state.thinking = false;
    }
  }

  private async playSingleBattle(
    gameSeed: PRNGSeed,
    p1Team: string,
    p2Team: string,
    resetStream: boolean
  ) {
    if (resetStream) {
      this.resetForNextSeriesGame();
    }
    if (this.battle) {
      void this.battle.destroy().catch(() => undefined);
    }
    const battle = sim.createBattle(this.version);
    this.battle = battle;

    const omniTask = engine.pumpOmniscientStream({
      battle,
      maxTurns: this.maxTurns,
      smokeStopAfterTurn: this.smokeStopAfterTurn,
      getState: () => ({currentTurn: this.currentTurn, ended: this.ended}),
      onTurnUpdate: turn => {
        this.currentTurn = turn;
      },
      onTerminal: (winner, endReason) => {
        this.ended = true;
        this.winner = winner;
        this.endReason = endReason;
        this.wakePendingLineResolvers();
      },
      onSimError: () => {
        if (!this.ended) {
          this.ended = true;
          this.winner = 'tie';
          this.endReason = 'sim-error';
          this.wakePendingLineResolvers();
        }
      },
      onChunk: async rawChunk => {
        if (!this.ended) {
          // Drain all microtasks so concurrent player tasks enter `handleDecision`
          // (`beginTurnClockStep` + `thinking = true`) before snapshotting spectator clocks.
          await new Promise<void>(resolve => setImmediate(resolve));
        }
        this.emitSpectatorChunk(rawChunk);
      },
    });

    const p1Task = this.driveConcurrentPlayer(this.p1, battle.streams.p1);
    const p2Task = this.driveConcurrentPlayer(this.p2, battle.streams.p2);

    this.battleStartedAtNs = process.hrtime.bigint();
    await engine.startBattleProtocol(battle, {
      format: this.format,
      seed: gameSeed,
      p1Team,
      p2Team,
    });

    await Promise.all([omniTask, p1Task, p2Task]);

    const outcome: GameOutcome | undefined =
      this.winner === 'p1'
        ? 'W'
        : this.winner === 'p2'
          ? 'L'
          : this.winner === 'tie'
            ? 'T'
            : undefined;

    return {
      winner: this.winner,
      outcome,
      preemptedSlot: this.preemptedSlot,
      turns: this.currentTurn,
      endReason: this.endReason,
      omniscientLog: this.getFullLog(),
      p1: this.buildSingleBattleStats(this.p1),
      p2: this.buildSingleBattleStats(this.p2),
    };
  }

  private buildSingleBattleStats(player: RemoteTournamentPlayer) {
    const teamPreviewMillis = player.telemetry.teamPreviewCount > 0
      ? Math.max(
        1,
        Math.round(player.telemetry.totalTeamPreviewMillis / player.telemetry.teamPreviewCount)
      )
      : undefined;
    return {
      bankSeconds: Math.max(
        0,
        Math.round(Math.min(player.turn.bankMillis, this.timers.startingBankMillis) / 1000)
      ),
      initMillis: player.telemetry.initMillis,
      ...(teamPreviewMillis !== undefined ? {teamPreviewMillis} : {}),
      totalTurnMillis: player.telemetry.totalTurnDecisionMillis,
      decisionsCount: player.telemetry.turnDecisionCount,
      meanTurnMillis: player.telemetry.turnDecisionCount > 0
        ? Math.max(
          1,
          Math.round(player.telemetry.totalTurnDecisionMillis / player.telemetry.turnDecisionCount)
        )
        : 1,
      peakRam: player.telemetry.peakRam,
    };
  }

  private async closePlayers() {
    for (const p of [this.p1, this.p2]) {
      try {
        p.proc.stdin.end();
      } catch {}
    }
    // Let `tourney-relay` observe stdin EOF (100ms deadline), reap its child, and flush
    // `ARENA_PEAK_RAM=<mib>` on stderr before sending SIGTERM to the local transport/process.
    await Promise.all([this.p1, this.p2].map(p => (
      p.state.exited
        ? Promise.resolve()
        : new Promise<void>(resolve => {
          const t = setTimeout(resolve, p.relay.usesRelay ? 250 : 50);
          p.proc.once('close', () => {
            clearTimeout(t);
            resolve();
          });
        })
    )));
    for (const p of [this.p1, this.p2]) {
      if (!p.state.exited) {
        try {
          p.proc.kill('SIGTERM');
        } catch {}
      }
    }
    if (!this.p1.state.exited || !this.p2.state.exited) {
      await Promise.all([this.p1, this.p2].map(p => (
        p.state.exited
          ? Promise.resolve()
          : new Promise<void>(resolve => {
            const t = setTimeout(resolve, 100);
            p.proc.once('close', () => {
              clearTimeout(t);
              resolve();
            });
          })
      )));
    }
  }

  async run(): Promise<GameResult> {
    const resolved = await engine.resolveBattleConfig({
      format: this.format,
      version: this.version,
      sendUtm: this.sendUtm,
      timerOverrides: this.timerOverrides,
    });
    this.format = resolved.format;
    this.timers = resolved.timers;
    this.sendUtm = resolved.sendUtm;

    this.p1 = this.spawnRemotePlayer('p1', this.p1Spec);
    this.p2 = this.spawnRemotePlayer('p2', this.p2Spec);

    try {
      let p1Res: Awaited<ReturnType<typeof this.resolvePlayerTeam>>;
      let p2Res: Awaited<ReturnType<typeof this.resolvePlayerTeam>>;

      if (
        this.p1TeamPacked === undefined &&
        this.p2TeamPacked === undefined &&
        this.p2Spec.agentId === '_baseline'
      ) {
        p1Res = await this.resolvePlayerTeam(this.p1, undefined);
        p2Res = p1Res.ok
          ? await this.resolvePlayerTeam(this.p2, p1Res.team)
          : {ok: true, team: ''};
      } else {
        [p1Res, p2Res] = await Promise.all([
          this.resolvePlayerTeam(this.p1, this.p1TeamPacked),
          this.resolvePlayerTeam(this.p2, this.p2TeamPacked),
        ]);
      }

      const p1Team = p1Res.ok ? p1Res.team : '';
      const p2Team = p2Res.ok ? p2Res.team : '';
      this.p1TeamPacked = p1Team;
      this.p2TeamPacked = p2Team;

      const startingBankSeconds = Math.round(this.timers.startingBankMillis / 1000);

      if (
        (!p1Res.ok && p1Res.reason === 'spot-preemption') ||
        (!p2Res.ok && p2Res.reason === 'spot-preemption') ||
        this.p1.state.spotPreempted || this.p1.state.sshDisconnected ||
        this.p2.state.spotPreempted || this.p2.state.sshDisconnected
      ) {
        const slot: PlayerSlot =
          (!p1Res.ok && p1Res.reason === 'spot-preemption') ||
          this.p1.state.spotPreempted ||
          this.p1.state.sshDisconnected
            ? 'p1'
            : 'p2';
        return {
          winner: 'preempted',
          preemptedSlot: slot,
          turns: 0,
          endReason: 'spot-preemption',
          omniscientLog: '',
          p1: {
            teamPacked: p1Team,
            bankSeconds: startingBankSeconds,
            meanTurnMillis: 0,
            peakRam: 1,
          },
          p2: {
            teamPacked: p2Team,
            bankSeconds: startingBankSeconds,
            meanTurnMillis: 0,
            peakRam: 1,
          },
          games: [],
        };
      }

      if (!p1Res.ok || !p2Res.ok) {
        const winner: PlayerSlot | 'tie' = !p1Res.ok && !p2Res.ok
          ? 'tie'
          : !p1Res.ok
            ? 'p2'
            : 'p1';
        const endReason = !p1Res.ok ? p1Res.reason : (p2Res as {ok: false; reason: string}).reason;
        const outcome: GameOutcome = winner === 'p1' ? 'W' : winner === 'p2' ? 'L' : 'T';
        await this.closePlayers();
        const gamesNeeded = Math.floor(this.bestOf / 2) + 1;
        const games: SeriesGameResult[] = Array.from({length: gamesNeeded}, (_, idx) => ({
          seed: deriveGameSeed(this.seed, idx + 1),
          outcome,
          turns: 0,
          endReason,
          omniscientLog: '',
          p1: {
            bankSeconds: startingBankSeconds,
            meanTurnMillis: 1,
            peakRam: this.p1.telemetry.peakRam,
          },
          p2: {
            bankSeconds: startingBankSeconds,
            meanTurnMillis: 1,
            peakRam: this.p2.telemetry.peakRam,
          },
        }));
        return {
          winner,
          outcome,
          turns: 0,
          endReason,
          launchError: this.p1.state.launchError ?? this.p2.state.launchError,
          omniscientLog: '',
          p1: {
            teamPacked: p1Team,
            bankSeconds: startingBankSeconds,
            meanTurnMillis: 1,
            peakRam: this.p1.telemetry.peakRam,
          },
          p2: {
            teamPacked: p2Team,
            bankSeconds: startingBankSeconds,
            meanTurnMillis: 1,
            peakRam: this.p2.telemetry.peakRam,
          },
          games,
        };
      }

      // Play up to `bestOf` games in the same running agent processes so `/tmp` state
      // persists across games of a series (matching Showdown & real-life VGC Bo3).
      const games: SeriesGameResult[] = [];
      const summaries: SeriesGameSummary[] = [];
      let totalTurns = 0;
      let totalP1Decisions = 0;
      let totalP1Millis = 0;
      let totalP2Decisions = 0;
      let totalP2Millis = 0;
      let p1PeakRam = this.p1.telemetry.peakRam;
      let p2PeakRam = this.p2.telemetry.peakRam;

      for (let gameNum = 1; gameNum <= this.bestOf; gameNum++) {
        const gameSeed = deriveGameSeed(this.seed, gameNum);
        await this.callbacks?.onGameStart?.({
          game: gameNum,
          bestOf: this.bestOf,
          summaries: [...summaries],
        });
        const g = await this.playSingleBattle(gameSeed, p1Team, p2Team, gameNum > 1);
        totalTurns += g.turns;
        p1PeakRam = Math.max(p1PeakRam, g.p1.peakRam, this.p1.telemetry.peakRam);
        p2PeakRam = Math.max(p2PeakRam, g.p2.peakRam, this.p2.telemetry.peakRam);

        if (g.winner === 'preempted' || !g.outcome) {
          await this.closePlayers();
          p1PeakRam = Math.max(p1PeakRam, this.p1.telemetry.peakRam);
          p2PeakRam = Math.max(p2PeakRam, this.p2.telemetry.peakRam);
          return {
            winner: 'preempted',
            preemptedSlot: g.preemptedSlot,
            turns: totalTurns,
            endReason: 'spot-preemption',
            launchError: this.p1.state.launchError ?? this.p2.state.launchError,
            omniscientLog: g.omniscientLog,
            p1: {
              teamPacked: p1Team,
              bankSeconds: g.p1.bankSeconds,
              meanTurnMillis: g.p1.meanTurnMillis,
              peakRam: p1PeakRam,
            },
            p2: {
              teamPacked: p2Team,
              bankSeconds: g.p2.bankSeconds,
              meanTurnMillis: g.p2.meanTurnMillis,
              peakRam: p2PeakRam,
            },
            games,
          };
        }

        totalP1Decisions += g.p1.decisionsCount;
        totalP1Millis += g.p1.totalTurnMillis;
        totalP2Decisions += g.p2.decisionsCount;
        totalP2Millis += g.p2.totalTurnMillis;

        games.push({
          seed: gameSeed,
          outcome: g.outcome,
          turns: g.turns,
          endReason: g.endReason,
          omniscientLog: g.omniscientLog,
          p1: {
            bankSeconds: g.p1.bankSeconds,
            initMillis: g.p1.initMillis,
            ...(g.p1.teamPreviewMillis !== undefined
              ? {teamPreviewMillis: g.p1.teamPreviewMillis}
              : {}),
            meanTurnMillis: g.p1.meanTurnMillis,
            peakRam: g.p1.peakRam > 1 ? g.p1.peakRam : p1PeakRam,
          },
          p2: {
            bankSeconds: g.p2.bankSeconds,
            initMillis: g.p2.initMillis,
            ...(g.p2.teamPreviewMillis !== undefined
              ? {teamPreviewMillis: g.p2.teamPreviewMillis}
              : {}),
            meanTurnMillis: g.p2.meanTurnMillis,
            peakRam: g.p2.peakRam > 1 ? g.p2.peakRam : p2PeakRam,
          },
        });
        summaries.push({
          winnerSlot: g.winner === 'p1' || g.winner === 'p2' ? g.winner : undefined,
          turns: g.turns,
        });

        const {p1Score, p2Score} = computeSeriesOutcome(games.map(x => x.outcome));
        if (p1Score > this.bestOf / 2 || p2Score > this.bestOf / 2) break;
      }

      await this.closePlayers();
      p1PeakRam = Math.max(p1PeakRam, this.p1.telemetry.peakRam);
      p2PeakRam = Math.max(p2PeakRam, this.p2.telemetry.peakRam);
      for (const gameEntry of games) {
        if (gameEntry.p1.peakRam <= 1 && p1PeakRam > 1) gameEntry.p1.peakRam = p1PeakRam;
        if (gameEntry.p2.peakRam <= 1 && p2PeakRam > 1) gameEntry.p2.peakRam = p2PeakRam;
      }

      const {outcome: matchOutcome} = computeSeriesOutcome(games.map(x => x.outcome));
      const matchWinner: PlayerSlot | 'tie' =
        matchOutcome === 'W' ? 'p1' : matchOutcome === 'L' ? 'p2' : 'tie';
      const lastGame = games[games.length - 1];
      let matchEndReason = 'normal';
      for (let i = games.length - 1; i >= 0; i--) {
        if (games[i].endReason !== 'normal') {
          matchEndReason = games[i].endReason;
          break;
        }
      }

      const p1MeanTurnMillis = totalP1Decisions > 0
        ? Math.max(1, Math.round(totalP1Millis / totalP1Decisions))
        : 1;
      const p2MeanTurnMillis = totalP2Decisions > 0
        ? Math.max(1, Math.round(totalP2Millis / totalP2Decisions))
        : 1;

      return {
        winner: matchWinner,
        outcome: matchOutcome,
        turns: totalTurns,
        endReason: matchEndReason,
        launchError: this.p1.state.launchError ?? this.p2.state.launchError,
        omniscientLog: games[0].omniscientLog,
        p1: {
          teamPacked: p1Team,
          bankSeconds: lastGame.p1.bankSeconds,
          initMillis: this.p1.telemetry.initMillis,
          ...(lastGame.p1.teamPreviewMillis !== undefined
            ? {teamPreviewMillis: lastGame.p1.teamPreviewMillis}
            : {}),
          meanTurnMillis: p1MeanTurnMillis,
          peakRam: p1PeakRam,
          errors: {...this.p1.errors},
          ...(this.p1.io.stderrBuf.format() ? {stderr: this.p1.io.stderrBuf.format()} : {}),
        },
        p2: {
          teamPacked: p2Team,
          bankSeconds: lastGame.p2.bankSeconds,
          initMillis: this.p2.telemetry.initMillis,
          ...(lastGame.p2.teamPreviewMillis !== undefined
            ? {teamPreviewMillis: lastGame.p2.teamPreviewMillis}
            : {}),
          meanTurnMillis: p2MeanTurnMillis,
          peakRam: p2PeakRam,
          errors: {...this.p2.errors},
          ...(this.p2.io.stderrBuf.format() ? {stderr: this.p2.io.stderrBuf.format()} : {}),
        },
        games,
      };
    } finally {
      this.infoCoalescer.dispose();
      if (this.battle) {
        void this.battle.destroy().catch(() => undefined);
      }
      try {
        this.p1.proc.kill('SIGTERM');
      } catch {}
      try {
        this.p2.proc.kill('SIGTERM');
      } catch {}
    }
  }
}

export interface MatchupState {
  agentA: number;
  agentB: number;
  gamesPlayed: number;
  gamesTarget: number;
  inFlight: boolean;
}

export interface TableResidentPair {
  vmAAgent: number | undefined;
  vmBAgent: number | undefined;
}

export interface ScheduledBatch {
  agentOnVmA: number;
  agentOnVmB: number;
  gamesToPlay: number;
  startingGameIndex: number;
}

// Sticky-VM pivot + macro-cycle wave + anti-starvation tournament batch scheduler:
//   1. Macro-cycle wave: only considers pairs at the global minimum `min(gamesPlayed)`.
//   2. Anti-starvation cap: prefers entrants within `2 * batchSize` of the least-played entrant.
//   3. Sticky-VM pivot: maximizes `residentCount` in {2, 1, 0} on the table's two Worker VMs
//      so at most one agent process switches at a batch boundary.
export function selectNextBatch(
  matchups: readonly MatchupState[],
  totalGamesByAgent: ReadonlyMap<number, number>,
  tableResidents: TableResidentPair,
  batchSize = 10
): ScheduledBatch | undefined {
  const eligible = matchups.filter(m => !m.inFlight && m.gamesPlayed < m.gamesTarget);
  if (eligible.length === 0) return undefined;

  const minPairGames = Math.min(...eligible.map(m => m.gamesPlayed));
  const currentWave = eligible.filter(m => m.gamesPlayed === minPairGames);

  const minAgentGames = totalGamesByAgent.size > 0
    ? Math.min(...totalGamesByAgent.values())
    : 0;
  const maxAllowedAgentGames = minAgentGames + 2 * batchSize;

  const nonStarving = currentWave.filter(m => {
    const gA = totalGamesByAgent.get(m.agentA) ?? 0;
    const gB = totalGamesByAgent.get(m.agentB) ?? 0;
    return Math.max(gA, gB) <= maxAllowedAgentGames;
  });
  const candidates = nonStarving.length > 0 ? nonStarving : currentWave;

  let best: MatchupState | undefined;
  let bestResidency = -1;
  let bestSumGames = Infinity;

  for (const m of candidates) {
    const aResident =
      m.agentA === tableResidents.vmAAgent || m.agentA === tableResidents.vmBAgent ? 1 : 0;
    const bResident =
      m.agentB === tableResidents.vmAAgent || m.agentB === tableResidents.vmBAgent ? 1 : 0;
    const residency = aResident + bResident;
    const sumGames =
      (totalGamesByAgent.get(m.agentA) ?? 0) + (totalGamesByAgent.get(m.agentB) ?? 0);

    if (
      residency > bestResidency ||
      (residency === bestResidency && sumGames < bestSumGames)
    ) {
      best = m;
      bestResidency = residency;
      bestSumGames = sumGames;
    }
  }

  if (!best) return undefined;

  let agentOnVmA = best.agentA;
  let agentOnVmB = best.agentB;
  if (
    best.agentB === tableResidents.vmAAgent ||
    best.agentA === tableResidents.vmBAgent
  ) {
    agentOnVmA = best.agentB;
    agentOnVmB = best.agentA;
  }

  const remaining = best.gamesTarget - best.gamesPlayed;
  return {
    agentOnVmA,
    agentOnVmB,
    gamesToPlay: Math.min(batchSize, remaining),
    startingGameIndex: best.gamesPlayed,
  };
}

// Forward-looking GCP L4 Spot worker VM provisioning helpers — do not delete.
export const L4_CANDIDATE_ZONES = [
  'us-central1-a',
  'us-central1-b',
  'us-central1-c',
  'us-east4-a',
  'us-east4-c',
  'us-west1-b',
] as const;

export interface ProvisionedWorkerVM {
  vmName: string;
  zone: string;
  ip: string;
  provisioningModel: 'SPOT' | 'STANDARD';
}

export function provisionSpotWorkerVM(
  vmName: string,
  imageName: string,
  consecutiveSpotFailures = 0
): ProvisionedWorkerVM {
  const provisioningModel: 'SPOT' | 'STANDARD' =
    consecutiveSpotFailures >= 3 ? 'STANDARD' : 'SPOT';

  for (const zone of L4_CANDIDATE_ZONES) {
    try {
      const args = [
        'compute', 'instances', 'create', vmName,
        `--zone=${zone}`,
        '--machine-type=g2-custom-24-49152',
        '--accelerator=type=nvidia-l4,count=1',
        `--provisioning-model=${provisioningModel}`,
        ...(provisioningModel === 'SPOT' ? ['--instance-termination-action=DELETE'] : []),
        '--maintenance-policy=TERMINATE',
        `--image=${imageName}`,
        '--boot-disk-size=300GB',
        '--boot-disk-type=pd-ssd',
        '--format=value(networkInterfaces[0].networkIP)',
      ];
      const ip = execFileSync('gcloud', args, {
        encoding: 'utf8',
        timeout: 120_000,
      }).trim();
      if (ip) {
        return {vmName, zone, ip, provisioningModel};
      }
    } catch {
      // Zone exhausted or capacity unavailable; try next candidate zone
    }
  }
  throw new Error(
    `All L4 zones exhausted while provisioning ${vmName} (${provisioningModel})`
  );
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

const RESERVED_TOURNEY_ENV_PREFIXES = [
  'HOME=',
  'TMPDIR=',
  'XDG_CACHE_HOME=',
  'PKMN_STATS_DIR=',
  'ARENA_PONDER=',
];

function lstatIfExists(targetPath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(targetPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

function ensureSafeRootfsDir(rootfsDir: string, relDir: string) {
  let cur = rootfsDir;
  for (const part of relDir.split('/')) {
    if (!part) continue;
    cur = path.join(cur, part);
    const st = lstatIfExists(cur);
    if (!st) {
      fs.mkdirSync(cur, {mode: 0o755});
    } else if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`OCI rootfs contains unsafe symlink or non-directory at /${relDir}`);
    }
  }
}

function ensureSafeEmptyRootfsFile(rootfsDir: string, relFile: string) {
  const dirRel = path.posix.dirname(relFile);
  if (dirRel && dirRel !== '.') {
    ensureSafeRootfsDir(rootfsDir, dirRel);
  }
  const fullPath = path.join(rootfsDir, relFile);
  const st = lstatIfExists(fullPath);
  if (!st) {
    const fd = fs.openSync(
      fullPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o644
    );
    fs.closeSync(fd);
    return;
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`OCI rootfs contains unsafe symlink or non-regular file at /${relFile}`);
  }
}

export function finalizeUnpackedOciRootfs(bundleDir: string): number {
  const rootfsDir = path.join(bundleDir, 'rootfs');
  const rootStat = lstatIfExists(rootfsDir);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('Unpacked OCI bundle rootfs is missing or not a directory');
  }

  const runPath = path.join(rootfsDir, 'run');
  const runStat = lstatIfExists(runPath);
  let hasRegularRun = false;
  if (runStat && !runStat.isSymbolicLink() && runStat.isFile()) {
    fs.chmodSync(runPath, 0o755);
    hasRegularRun = true;
  }

  const arenaRunPath = path.join(rootfsDir, '.arena-run');
  if (!hasRegularRun) {
    if (lstatIfExists(arenaRunPath)) {
      throw new Error('OCI rootfs contains colliding /.arena-run entry');
    }
    const cfgPath = path.join(bundleDir, 'config.json');
    const cfgStat = lstatIfExists(cfgPath);
    if (cfgStat && !cfgStat.isSymbolicLink() && cfgStat.isFile()) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as {
        process?: {cwd?: string; env?: string[]; args?: string[]};
      };
      const procArgs = cfg.process?.args ?? [];
      if (procArgs.length > 0) {
        const lines = ['#!/bin/sh'];
        for (const envEntry of cfg.process?.env ?? []) {
          if (RESERVED_TOURNEY_ENV_PREFIXES.some(prefix => envEntry.startsWith(prefix))) {
            continue;
          }
          lines.push(`export ${shellQuote(envEntry)}`);
        }
        lines.push(`cd ${shellQuote(cfg.process?.cwd || '/')}`);
        lines.push(`exec ${procArgs.map(shellQuote).join(' ')} "$@"`);
        const fd = fs.openSync(
          arenaRunPath,
          fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW,
          0o755
        );
        try {
          fs.writeFileSync(fd, `${lines.join('\n')}\n`, 'utf8');
        } finally {
          fs.closeSync(fd);
        }
      }
    }
  }

  const arenaRunStat = lstatIfExists(arenaRunPath);
  const hasLauncher = Boolean(
    arenaRunStat && !arenaRunStat.isSymbolicLink() && arenaRunStat.isFile()
  );
  if (!hasRegularRun && !hasLauncher) {
    throw new Error('OCI rootfs is missing executable /run and has no OCI Entrypoint/Cmd');
  }

  const duKb = Number(
    execFileSync('du', ['-sk', rootfsDir], {encoding: 'utf8', timeout: 30_000})
      .trim()
      .split(/\s+/)[0]
  );
  const unpackedBytes = Number.isFinite(duKb) ? duKb * 1024 : 0;
  if (unpackedBytes <= 0 || unpackedBytes > packages.MAX_IMAGE_BYTES) {
    throw new Error(
      `Unpacked tournament rootfs size (${unpackedBytes} B) exceeds 500 MiB cap`
    );
  }

  for (const subDir of ['tmp', 'scratch', 'proc', 'dev', 'usr/lib/x86_64-linux-gnu']) {
    ensureSafeRootfsDir(rootfsDir, subDir);
  }
  for (const nvLib of [
    'libcuda.so.1',
    'libnvidia-ml.so.1',
    'libnvidia-ptxjitcompiler.so.1',
  ]) {
    ensureSafeEmptyRootfsFile(rootfsDir, `usr/lib/x86_64-linux-gnu/${nvLib}`);
  }

  return unpackedBytes;
}

// Unpacks and verifies a `linux/amd64` tournament OCI image into `/opt/arena/agents/<targetId>` on
// GCP using `skopeo` + `umoci` (without requiring a rootful container daemon).
export function unpackOciRootfs(opts: {
  imageRef: string;
  targetId: string;
  expectedSha256: string;
  authToken?: string;
  rootDir?: string;
}): number {
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(opts.targetId) || opts.targetId.includes('..')) {
    throw new Error(`Invalid tournament agent targetId: ${opts.targetId}`);
  }
  const agentsDir = opts.rootDir ? path.join(opts.rootDir, 'agents') : '/opt/arena/agents';
  const stagingDir = opts.rootDir ? path.join(opts.rootDir, 'staging') : '/tmp';
  fs.mkdirSync(stagingDir, {recursive: true});
  fs.mkdirSync(agentsDir, {recursive: true});

  const cleanRef = opts.imageRef.replace(/^docker:\/\//, '').trim();
  const repoRef = packages.stripOciTagOrDigest(cleanRef);
  const inspected = packages.inspectRemoteOciSize({
    imageRef: cleanRef,
    creds: opts.authToken,
    expectedSha256: opts.expectedSha256,
    platform: {os: 'linux', arch: 'amd64'},
    stagingDir,
  });
  const workDir = fs.mkdtempSync(path.join(stagingDir, `tourney-oci-${opts.targetId}-`));
  fs.chmodSync(workDir, 0o700);

  try {
    const skopeoAuthArgs: string[] = [];
    if (opts.authToken) {
      const authFile = packages.writePrivateSkopeoAuthfile(workDir, cleanRef, opts.authToken);
      skopeoAuthArgs.push('--authfile', authFile);
    }

    const layoutRef = `oci:${path.join(workDir, 'layout')}:latest`;
    execFileSync(
      'skopeo',
      [
        'copy',
        '--override-os', 'linux',
        '--override-arch', 'amd64',
        ...skopeoAuthArgs,
        `docker://${repoRef}@sha256:${inspected.manifestSha256}`,
        layoutRef,
      ],
      {timeout: 180_000}
    );

    const bundleDir = path.join(workDir, 'bundle');
    execFileSync(
      'umoci',
      ['unpack', '--rootless', '--image', `${path.join(workDir, 'layout')}:latest`, bundleDir],
      {timeout: 180_000}
    );

    const unpackedBytes = finalizeUnpackedOciRootfs(bundleDir);
    const rootfsDir = path.join(bundleDir, 'rootfs');
    const destDir = path.join(agentsDir, opts.targetId);
    fs.rmSync(destDir, {recursive: true, force: true});
    fs.renameSync(rootfsDir, destDir);
    return unpackedBytes;
  } catch (err) {
    throw packages.scrubError(err, opts.authToken);
  } finally {
    fs.rmSync(workDir, {recursive: true, force: true});
  }
}

export interface WorkerVmBinding {
  host: string;
  controlSocket: string;
}

export interface TableBinding {
  vmA: WorkerVmBinding;
  vmB: WorkerVmBinding;
}

const LOCAL_TABLE_BINDING: TableBinding = {
  vmA: {host: '127.0.0.1', controlSocket: ''},
  vmB: {host: '127.0.0.1', controlSocket: ''},
};

export interface EntrantInfo {
  versionId: number;
  agentId: number;
  agentSlug: string;
  agentName: string;
  version: string;
}

export interface MountedEntrant {
  entrant: EntrantInfo;
  vmHost: string;
  controlSocket: string;
}

export interface Options {
  client: arena.Client;
  baselineSpec: AgentSpec;
  rootDir?: string;
  tables?: readonly TableBinding[];
  superfinalGames?: number;
  maxTurns?: number;
  diagnosticWallCapMillis?: number;
  prepareSubmissionRootfs?: (
    sub: arena.PendingSubmission,
    targetId: string
  ) => Promise<number> | number;
  resolveEntrantSpec?: (
    entrant: EntrantInfo,
    vmHost: string,
    controlSocket: string
  ) => AgentSpec;
}

// GCP-side Tournament Coordinator:
//   1. `processPendingSubmissions` pulls & smoke-tests `linux/amd64` tournament OCI submissions on
//      GCP inside `bwrap` (`tourney-agent`) so Mac minis never touch `amd64` tournament artifacts.
//   2. `runTournament` drives crash-resumable Double Round-Robin waves + Superfinal across
//      `parallelTables` with live table broadcasts and immediate `.log` replay publication.
export class Coordinator {
  readonly client: arena.Client;
  private readonly baselineSpec: AgentSpec;
  private readonly rootDir?: string;
  private readonly agentsDir: string;
  private readonly tables: readonly TableBinding[];
  private readonly superfinalGames: number;
  private readonly maxTurns?: number;
  private readonly diagnosticWallCapMillis?: number;
  private readonly seedSecret: string;
  private readonly prepareSubmissionRootfs?: (
    sub: arena.PendingSubmission,
    targetId: string
  ) => Promise<number> | number;
  private readonly customResolveEntrantSpec?: Options['resolveEntrantSpec'];

  constructor(options: Options) {
    this.client = options.client;
    this.baselineSpec = options.baselineSpec;
    this.rootDir = options.rootDir;
    this.agentsDir = options.rootDir ? path.join(options.rootDir, 'agents') : '/opt/arena/agents';
    this.tables = options.tables ?? [];
    this.superfinalGames = options.superfinalGames ?? 100;
    this.maxTurns = options.maxTurns;
    this.diagnosticWallCapMillis = options.diagnosticWallCapMillis;
    this.seedSecret = process.env.ARENA_SECRET ?? 'tournament-seed';
    this.prepareSubmissionRootfs = options.prepareSubmissionRootfs;
    this.customResolveEntrantSpec = options.resolveEntrantSpec;
  }

  private notifyAlert(alert: arena.StaffAlertPayload) {
    Promise.resolve(this.client.sendAlert?.(alert)).catch(() => undefined);
  }

  private resolveEntrantSpec(mounted: MountedEntrant): AgentSpec {
    const {entrant, vmHost, controlSocket} = mounted;
    if (this.customResolveEntrantSpec) {
      return this.customResolveEntrantSpec(entrant, vmHost, controlSocket);
    }
    const targetId = packages.formatAgentTargetId(
      entrant.agentSlug,
      entrant.version,
      entrant.versionId
    );
    if (!vmHost || vmHost === 'localhost' || vmHost === '127.0.0.1') {
      return {
        agentId: targetId,
        displayName: entrant.agentName,
        vmHost: '127.0.0.1',
        controlSocket: '',
        localCommand: TOURNEY_AGENT_BIN,
        localArgs: [targetId],
      };
    }
    return {
      agentId: targetId,
      displayName: entrant.agentName,
      vmHost,
      controlSocket,
    };
  }

  async processPendingSubmissions(tournamentId?: string): Promise<number> {
    const {tournaments = [], submissions} = await this.client.getPendingSubmissions({
      target: 'tournament',
      tournamentId,
    });
    const tourneyById = new Map(tournaments.map(t => [t.id, t]));
    let processed = 0;

    for (const sub of submissions) {
      processed++;
      const targetId = packages.formatAgentTargetId(sub.agentSlug, sub.version, sub.versionId);

      let unpackedBytes: number;
      try {
        unpackedBytes = this.prepareSubmissionRootfs
          ? await this.prepareSubmissionRootfs(sub, targetId)
          : unpackOciRootfs({
            imageRef: sub.url,
            targetId,
            expectedSha256: sub.sha256,
            authToken: sub.authToken,
            rootDir: this.rootDir,
          });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.client.reportSubmissionStatus({
          versionId: sub.versionId,
          smokeStatus: 'failed',
          smokeError: `GCP OCI unpack/verification failed: ${msg}`,
        });
        continue;
      }

      const candidateSpec = this.resolveEntrantSpec({
        entrant: {
          versionId: sub.versionId,
          agentId: sub.agentId,
          agentSlug: sub.agentSlug,
          agentName: sub.agentName,
          version: sub.version,
        },
        vmHost: '127.0.0.1',
        controlSocket: '',
      });

      const smokeStart = Date.now();
      const smokeTelemetry: engine.SmokeTelemetry = {
        maxInitMillis: 1,
        maxTurnMillis: 1,
        maxPeakRam: 0,
      };
      const diagnostics: SmokeDiagnosticInput[] = [];
      let smokeError: string | undefined;

      try {
        for (const tid of sub.tournaments) {
          const meta = tourneyById.get(tid);
          const format = meta?.format ?? 'gen9ou';
          const smokeFormat = simOps.formatWithCustomRules(format, meta?.customRules);

          let p1TeamPacked: string | undefined;
          let p2TeamPacked: string | undefined;
          const pool = meta?.teamPool ?? [];
          try {
            if (meta?.team === 'harvested') {
              // Never fall back to harvested tournament pools in diagnostic tests so private
              // harvested teams cannot leak into exposed diagnostic logs.
              if (!meta.smokeTeams || meta.smokeTeams.length < 2) {
                throw new Error(
                  `missing sample team pool for ${smokeFormat} (requires >= 2 teams)`
                );
              }
              [p1TeamPacked, p2TeamPacked] = meta.smokeTeams;
            } else if (meta?.team === 'pools' && pool.length >= 2) {
              p1TeamPacked = pool[0];
              p2TeamPacked = pool.find(t => t !== p1TeamPacked) ?? pool[1];
            } else if (
              meta?.team === 'random' ||
              (meta?.team === undefined && toID(format).includes('random'))
            ) {
              const pair = await sim.sampleRandomPair(format, '1,2,3,4', '5,6,7,8', meta?.version);
              p1TeamPacked = pair.t1Packed;
              p2TeamPacked = pair.t2Packed;
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const detail = `GCP diagnostic test setup fault in ${format}: ${msg}`;
            this.notifyAlert({
              key: 'tourney-smoke-infra',
              message:
                'Tournament diagnostic test infrastructure error for ' +
                `${sub.agentSlug} ${sub.version}`,
              detail,
            });
            throw err;
          }

          const gameStartMillis = Date.now();
          const liveLines: string[] = [];
          const timerSettings = arena.timerSettingsForFormat(smokeFormat);
          let lastPushMillis = 0;
          let lastPushTurn = -1;
          const pushLive = (state: TurnBroadcastInfo, force = false) => {
            if (!this.client.sendDiagnosticLive) return;
            const nowMillis = Date.now();
            if (!force && state.turn === lastPushTurn && nowMillis - lastPushMillis < 250) return;
            lastPushMillis = nowMillis;
            lastPushTurn = state.turn;
            const activeSlot: 'p1' | 'p2' | undefined = state.p1.thinking
              ? 'p1'
              : state.p2.thinking
                ? 'p2'
                : undefined;
            void this.client.sendDiagnosticLive({
              versionId: sub.versionId,
              agentId: sub.agentId,
              agentSlug: sub.agentSlug,
              agentName: sub.agentName,
              version: sub.version,
              format: smokeFormat,
              targetName: meta?.name ?? `Tournament #${tid}`,
              phase: state.turn === 0 ? 'preview' : 'battle',
              turn: state.turn,
              ...(activeSlot ? {activeSlot} : {}),
              turnStartedAt: Math.floor(nowMillis / 1000),
              turnBudgetSeconds: timerSettings.maxPerTurnSeconds,
              incrementSeconds: timerSettings.addPerTurnSeconds,
              p1: {
                name: `${sub.agentName} (P1)`,
                version: sub.version,
                bankSeconds: state.p1.bankSeconds,
                thinking: state.p1.thinking,
                ...(state.p1.info !== undefined ? {info: state.p1.info} : {}),
              },
              p2: {
                name: `${sub.agentName} (P2)`,
                version: sub.version,
                bankSeconds: state.p2.bankSeconds,
                thinking: state.p2.thinking,
                ...(state.p2.info !== undefined ? {info: state.p2.info} : {}),
              },
              lines: [...liveLines],
              ...(state.winHistory?.length ? {winHistory: state.winHistory} : {}),
            }).catch(() => undefined);
          };

          const smokeGame = new ConcurrentGame({
            format: smokeFormat,
            version: meta?.version,
            bestOf: 1,
            seed: '1,2,3,4',
            p1: {spec: candidateSpec, teamPacked: p1TeamPacked},
            p2: {spec: candidateSpec, teamPacked: p2TeamPacked},
            sendUtm: meta?.team !== undefined ? meta.team !== 'random' : undefined,
            maxTurns: this.maxTurns,
            maxWallMillis:
              this.diagnosticWallCapMillis ?? engine.diagnosticWallCapMillis(smokeFormat),
            stderrCapture: engine.DIAGNOSTIC_STDERR_LIMITS,
            callbacks: {
              onSpectatorChunk: (chunk, state) => {
                for (const line of chunk.split('\n')) {
                  if (line.length > 0) liveLines.push(line);
                }
                pushLive(state, true);
              },
              onClockChange: state => pushLive(state, false),
            },
          });
          const res = await smokeGame.run();
          const gameDurationMillis = Math.max(1, Date.now() - gameStartMillis);
          diagnostics.push({
            tournamentId: tid,
            format: smokeFormat,
            turns: res.turns,
            endReason: res.endReason,
            durationMillis: gameDurationMillis,
            battleLog: engine.truncateDiagnosticLog(res.omniscientLog),
            supportsInfo: battleLogHasAiTelemetry(res.omniscientLog),
            ...(res.p1.stderr ? {p1Stderr: res.p1.stderr} : {}),
            ...(res.p2.stderr ? {p2Stderr: res.p2.stderr} : {}),
            ...(res.p1.peakRam > 0 ? {p1PeakRam: Math.round(res.p1.peakRam)} : {}),
            ...(res.p2.peakRam > 0 ? {p2PeakRam: Math.round(res.p2.peakRam)} : {}),
          });

          const verdict = engine.classifySmokeGame(res, {
            label: 'GCP diagnostic test',
            format,
            selfPlay: true,
            p1Stderr: res.p1.stderr,
            p2Stderr: res.p2.stderr,
          });
          if (verdict.kind === 'infra') {
            this.notifyAlert({
              key: 'tourney-smoke-infra',
              message:
                'Tournament diagnostic test infrastructure error for ' +
                `${sub.agentSlug} ${sub.version}`,
              detail: verdict.message,
            });
            throw new Error(verdict.message);
          }
          if (verdict.kind === 'fail') {
            smokeError = verdict.message;
            break;
          }
          engine.recordSmokeTelemetry(smokeTelemetry, res.p1);
          engine.recordSmokeTelemetry(smokeTelemetry, res.p2);
        }
      } finally {
        // Never retain unactivated tournament rootfs images on disk; activated entrants are pulled
        // cleanly when the tournament starts.
        fs.rmSync(path.join(this.agentsDir, targetId), {recursive: true, force: true});
        if (this.client.sendDiagnosticLive) {
          await this.client.sendDiagnosticLive({
            done: true,
            agentId: sub.agentId,
            versionId: sub.versionId,
          }).catch(() => undefined);
        }
      }

      const smokeDurationMillis = Math.max(1, Date.now() - smokeStart);
      if (smokeError) {
        await this.reportSubmissionStatus({
          versionId: sub.versionId,
          smokeStatus: 'failed',
          smokeError,
          ...(diagnostics.length ? {diagnostics} : {}),
        });
        continue;
      }

      await this.reportSubmissionStatus({
        versionId: sub.versionId,
        smokeStatus: 'staged',
        unpackedBytes,
        smokeDurationMillis,
        ...(smokeTelemetry.maxPeakRam > 0 ? {smokePeakRam: smokeTelemetry.maxPeakRam} : {}),
        smokeInitMillis: smokeTelemetry.maxInitMillis,
        ...(smokeTelemetry.maxTeamPreviewMillis !== undefined
          ? {smokeTeamPreviewMillis: smokeTelemetry.maxTeamPreviewMillis}
          : {}),
        smokeTurnMillis: smokeTelemetry.maxTurnMillis,
        ...(diagnostics.length ? {diagnostics} : {}),
      });
    }

    return processed;
  }

  private async reportSubmissionStatus(payload: arena.SubmissionStatusPayload): Promise<void> {
    try {
      await this.client.reportSubmissionStatus(payload);
    } catch (err) {
      const status = (err as {status?: unknown} | undefined)?.status;
      if (status === 413 && payload.diagnostics?.length) {
        const stripped = {...payload};
        delete stripped.diagnostics;
        await this.client.reportSubmissionStatus(stripped);
        return;
      }
      throw err;
    }
  }

  private samplePairForGame(
    lockedBook: readonly TeamPair[],
    gameIndexZeroBased: number
  ): {p1Team: string | undefined; p2Team: string | undefined; swappedSeats: boolean} {
    const pairIdx = Math.floor(gameIndexZeroBased / 2);
    const swappedSeats = gameIndexZeroBased % 2 === 1;
    if (lockedBook.length > 0) {
      const pair = lockedBook[pairIdx % lockedBook.length];
      return {p1Team: pair.p1Team, p2Team: pair.p2Team, swappedSeats};
    }
    return {p1Team: undefined, p2Team: undefined, swappedSeats};
  }

  private derivePairSeed(tournamentId: string, pairIdx: number): PRNGSeed {
    const hex = crypto
      .createHmac('sha256', this.seedSecret)
      .update(`${tournamentId}:pair:${pairIdx}`)
      .digest('hex');
    return `sodium,${hex}`;
  }

  async completeGameWithRetry(
    tournamentId: string,
    payload: arena.TournamentGameCompletePayload
  ): Promise<arena.TournamentGameCompleteResponse> {
    let lastErr: unknown;
    let currentPayload = payload;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await this.client.completeTournamentGame(tournamentId, currentPayload);
      } catch (err) {
        lastErr = err;
        const status = (err as {status?: unknown} | undefined)?.status;
        if (status === 413 && currentPayload.logs !== undefined) {
          // Retry once with oversized replay logs stripped so authoritative match standings are
          // never lost when a long Best-of-N series exceeds a server or proxy payload cap.
          currentPayload = {...currentPayload, logs: undefined};
          continue;
        }
        if (status === 400 || status === 404 || status === 413 || status === 422) {
          throw err;
        }
        await new Promise(r => setTimeout(r, 250 * 2 ** attempt));
      }
    }
    throw lastErr;
  }

  async runTournament(
    tournamentId: string
  ): Promise<{roundRobinGames: number; superfinalGames: number}> {
    const state = await this.client.getTournamentState(tournamentId);
    const tourney = state.tournament;
    if (tourney.status === 'completed') {
      return {roundRobinGames: 0, superfinalGames: 0};
    }
    if (state.entrants.length < 2) {
      throw new Error(
        `Tournament '${tournamentId}' requires at least 2 entrants ` +
        `(found ${state.entrants.length}).`
      );
    }

    const entrantByVersion = new Map(state.entrants.map(e => [e.versionId, e]));
    const versionIds = state.entrants.map(e => e.versionId);
    const matchFormat = simOps.formatWithCustomRules(tourney.format, tourney.customRules);
    const timerSettings = await sim.getTimerSettings(matchFormat, tourney.version);
    const incSeconds = timerSettings.addPerTurnSeconds;
    const rrPairs = Math.ceil(tourney.gamesPerMatchup / 2);
    const sfPairs = Math.ceil(Math.max(0, this.superfinalGames) / 2);
    const totalPairs = Math.max(1, rrPairs + sfPairs);
    let lockedBook: TeamPair[] = [];
    if (
      tourney.team === 'harvested' ||
      tourney.team === 'pools' ||
      (tourney.team === undefined && state.teamPool.length >= 2)
    ) {
      lockedBook = buildLockedTournamentTeamBook(
        state.teamPool,
        totalPairs,
        tourney.format,
        tourney.id
      );
    } else if (
      tourney.team === 'random' ||
      (tourney.team === undefined && toID(tourney.format).includes('random'))
    ) {
      lockedBook = await Promise.all(Array.from({length: totalPairs}, async (_, idx) => {
        const s1 = this.derivePairSeed(`${tourney.id}:team1`, idx);
        const s2 = this.derivePairSeed(`${tourney.id}:team2`, idx);
        const pair = await sim.sampleRandomPair(tourney.format, s1, s2, tourney.version);
        return {p1Team: pair.t1Packed, p2Team: pair.t2Packed};
      }));
    }
    const pairSeeds: PRNGSeed[] = Array.from(
      {length: totalPairs},
      (_, idx) => this.derivePairSeed(tourney.id, idx)
    );

    const rrPlayedByPair = new Map<string, number>();
    const totalGamesByVersion = new Map<number, number>(versionIds.map(v => [v, 0]));
    for (const g of state.games) {
      if (g.stage !== 'Round Robin' || g.outcome === undefined) continue;
      const low = Math.min(g.p1.versionId, g.p2.versionId);
      const high = Math.max(g.p1.versionId, g.p2.versionId);
      const key = `${low}:${high}`;
      rrPlayedByPair.set(key, (rrPlayedByPair.get(key) ?? 0) + 1);
      totalGamesByVersion.set(
        g.p1.versionId,
        (totalGamesByVersion.get(g.p1.versionId) ?? 0) + 1
      );
      totalGamesByVersion.set(
        g.p2.versionId,
        (totalGamesByVersion.get(g.p2.versionId) ?? 0) + 1
      );
    }

    const matchups: MatchupState[] = [];
    for (let i = 0; i < versionIds.length; i++) {
      for (let j = i + 1; j < versionIds.length; j++) {
        const low = Math.min(versionIds[i], versionIds[j]);
        const high = Math.max(versionIds[i], versionIds[j]);
        matchups.push({
          agentA: low,
          agentB: high,
          gamesPlayed: rrPlayedByPair.get(`${low}:${high}`) ?? 0,
          gamesTarget: tourney.gamesPerMatchup,
          inFlight: false,
        });
      }
    }

    const tableCount = Math.max(
      1,
      Math.min(tourney.parallelTables, Math.floor(versionIds.length / 2))
    );
    const tourneyBestOf = tourney.bestOf;
    let markedRunning = tourney.status === 'running';
    let rrCompleted = 0;

    const broadcastChains = new Map<number, Promise<void>>();
    const queueTableBroadcast = (
      tableNum: number,
      payload: arena.TournamentBroadcastPayload
    ): Promise<void> => {
      const prev = broadcastChains.get(tableNum) ?? Promise.resolve();
      const next = prev
        .then(() => this.client.sendTournamentBroadcast(tournamentId, payload))
        .then(() => undefined, () => undefined);
      broadcastChains.set(tableNum, next);
      return next;
    };

    const playSingleGame = async (params: {
      tableNum: number;
      stage: 'Round Robin' | 'Superfinal';
      cycle: number;
      matchupGame: number;
      gameId: string;
      sideA: MountedEntrant;
      sideB: MountedEntrant;
      gameIndexZeroBased: number;
      finalTournamentStatus?: 'running' | 'completed';
    }): Promise<void> => {
      const sampled = this.samplePairForGame(
        lockedBook,
        params.gameIndexZeroBased
      );
      const pairIdx = Math.floor(params.gameIndexZeroBased / 2);
      const pairSeed = pairSeeds[pairIdx % pairSeeds.length];
      const [p1Side, p2Side] = sampled.swappedSeats
        ? [params.sideB, params.sideA]
        : [params.sideA, params.sideB];
      const p1Ent = p1Side.entrant;
      const p2Ent = p2Side.entrant;

      let preemptions = 0;
      for (;;) {
        const p1Spec = this.resolveEntrantSpec(p1Side);
        const p2Spec = this.resolveEntrantSpec(p2Side);

        const sendTableLoad = (info?: {
          game: number;
          bestOf: number;
          summaries: SeriesGameSummary[];
        }) => queueTableBroadcast(params.tableNum, {
          table: params.tableNum,
          mode: 'load',
          label: `Table ${params.tableNum}`,
          gameId: params.gameId,
          stage: params.stage,
          cycle: params.cycle,
          matchupGame: params.matchupGame,
          ...(tourneyBestOf > 1 || (info && info.bestOf > 1)
            ? {
              bestOf: info?.bestOf ?? tourneyBestOf,
              game: info?.game ?? 1,
              ...(info?.summaries.length ? {summaries: info.summaries} : {}),
            }
            : {}),
          p1: {
            slug: p1Ent.agentSlug,
            name: p1Ent.agentName,
            version: p1Ent.version,
            bankSeconds: timerSettings.startingSeconds,
            thinking: true,
            incrementSeconds: incSeconds,
          },
          p2: {
            slug: p2Ent.agentSlug,
            name: p2Ent.agentName,
            version: p2Ent.version,
            bankSeconds: timerSettings.startingSeconds,
            thinking: true,
            incrementSeconds: incSeconds,
          },
          lines: [],
          live: true,
        });

        await sendTableLoad({game: 1, bestOf: tourneyBestOf, summaries: []});

        const sendTableAppend = (lines: string[], snap: TurnBroadcastInfo) => {
          queueTableBroadcast(params.tableNum, {
            table: params.tableNum,
            mode: 'append',
            p1: {
              slug: p1Ent.agentSlug,
              name: p1Ent.agentName,
              version: p1Ent.version,
              bankSeconds: snap.p1.bankSeconds,
              thinking: snap.p1.thinking,
              incrementSeconds: incSeconds,
              ...(snap.p1.pokemon ? {pokemon: snap.p1.pokemon} : {}),
              ...(snap.p1.info ? {info: snap.p1.info} : {}),
            },
            p2: {
              slug: p2Ent.agentSlug,
              name: p2Ent.agentName,
              version: p2Ent.version,
              bankSeconds: snap.p2.bankSeconds,
              thinking: snap.p2.thinking,
              incrementSeconds: incSeconds,
              ...(snap.p2.pokemon ? {pokemon: snap.p2.pokemon} : {}),
              ...(snap.p2.info ? {info: snap.p2.info} : {}),
            },
            lines,
            ...(snap.winHistory && snap.winHistory.length > 0
              ? {winHistory: snap.winHistory}
              : {}),
            live: true,
          }).catch(() => undefined);
        };

        const game = new ConcurrentGame({
          format: matchFormat,
          version: tourney.version,
          bestOf: tourneyBestOf,
          seed: pairSeed,
          p1: {spec: p1Spec, teamPacked: sampled.p1Team},
          p2: {spec: p2Spec, teamPacked: sampled.p2Team},
          sendUtm: tourney.team !== undefined ? tourney.team !== 'random' : undefined,
          maxTurns: this.maxTurns,
          callbacks: {
            onGameStart: async info => {
              if (info.game > 1) {
                await sendTableLoad(info);
              }
            },
            onSpectatorChunk: (chunk, snap) => {
              if (!chunk) return;
              const newLines = chunk.split('\n');
              if (newLines.length === 0) return;
              sendTableAppend(newLines, snap);
            },
            onClockChange: snap => {
              sendTableAppend([], snap);
            },
          },
        });

        const res = await game.run();
        if (res.launchError) {
          const errMsg = `Worker launch failed on ${params.gameId}: ${res.launchError}`;
          this.notifyAlert({
            key: `tourney-worker:${tournamentId}`,
            message: `Tournament ${tournamentId} worker launch failed on ${params.gameId}`,
            detail: res.launchError,
          });
          throw new Error(errMsg);
        }
        if (res.winner === 'preempted' || !res.outcome) {
          preemptions++;
          if (preemptions >= 5) {
            const errMsg = `Exceeded 5 consecutive Spot preemptions on ${params.gameId}`;
            this.notifyAlert({
              key: `tourney-worker:${tournamentId}`,
              message: `Tournament ${tournamentId} hit 5 consecutive Spot preemptions`,
              detail: errMsg,
            });
            throw new Error(errMsg);
          }
          if (!p1Spec.localCommand && !p2Spec.localCommand) {
            await new Promise(r => setTimeout(r, Math.min(5000, 250 * 2 ** (preemptions - 1))));
          }
          continue;
        }

        await (broadcastChains.get(params.tableNum) ?? Promise.resolve());
        const statusUpdate =
          params.finalTournamentStatus ?? (!markedRunning ? 'running' : undefined);
        markedRunning = true;
        await this.completeGameWithRetry(tournamentId, {
          table: params.tableNum,
          logs: res.games.map(gm => gm.omniscientLog),
          ...(statusUpdate ? {tournamentStatus: statusUpdate} : {}),
          game: {
            id: params.gameId,
            stage: params.stage,
            cycle: params.cycle,
            matchupGame: params.matchupGame,
            preemptions,
            outcome: res.outcome,
            p1: {
              versionId: p1Ent.versionId,
              team: res.p1.teamPacked,
            },
            p2: {
              versionId: p2Ent.versionId,
              team: res.p2.teamPacked,
            },
            games: res.games.map((gm, idx) => ({
              gameNumber: idx + 1,
              seed: gm.seed,
              outcome: gm.outcome,
              turns: gm.turns,
              endReason: gm.endReason,
              p1: gm.p1,
              p2: gm.p2,
            })),
            completedAt: Math.floor(Date.now() / 1000),
          },
        });
        return;
      }
    };

    const runTableWorker = async (tableIdx: number) => {
      const tableNum = tableIdx + 1;
      const binding = this.tables[tableIdx] ?? LOCAL_TABLE_BINDING;
      const residents: TableResidentPair = {vmAAgent: undefined, vmBAgent: undefined};

      for (;;) {
        const batch = selectNextBatch(
          matchups,
          totalGamesByVersion,
          residents,
          tourney.batchSize
        );
        if (!batch) break;

        const low = Math.min(batch.agentOnVmA, batch.agentOnVmB);
        const high = Math.max(batch.agentOnVmA, batch.agentOnVmB);
        const matchup = matchups.find(m => m.agentA === low && m.agentB === high)!;
        matchup.inFlight = true;
        residents.vmAAgent = batch.agentOnVmA;
        residents.vmBAgent = batch.agentOnVmB;

        // Order `(sideLow, sideHigh)` canonically by `(low, high)` so Game 1 and Game 2 mirror
        // seat/team swaps remain identical across mid-batch restarts regardless of VM residency.
        const lowOnVmB = batch.agentOnVmB === low;
        const lowVm = lowOnVmB ? binding.vmB : binding.vmA;
        const highVm = lowOnVmB ? binding.vmA : binding.vmB;
        const sideLow: MountedEntrant = {
          entrant: entrantByVersion.get(low)!,
          vmHost: lowVm.host,
          controlSocket: lowVm.controlSocket,
        };
        const sideHigh: MountedEntrant = {
          entrant: entrantByVersion.get(high)!,
          vmHost: highVm.host,
          controlSocket: highVm.controlSocket,
        };

        try {
          for (let offset = 0; offset < batch.gamesToPlay; offset++) {
            const gIdx = batch.startingGameIndex + offset;
            const matchupGame = gIdx + 1;
            const cycle = Math.floor(gIdx / Math.max(1, tourney.batchSize)) + 1;
            const gameId =
              `t${tourney.id}-rr-${low}-${high}-g${String(matchupGame).padStart(3, '0')}`;
            await playSingleGame({
              tableNum,
              stage: 'Round Robin',
              cycle,
              matchupGame,
              gameId,
              sideA: sideLow,
              sideB: sideHigh,
              gameIndexZeroBased: gIdx,
            });
            matchup.gamesPlayed++;
            totalGamesByVersion.set(
              low,
              (totalGamesByVersion.get(low) ?? 0) + 1
            );
            totalGamesByVersion.set(
              high,
              (totalGamesByVersion.get(high) ?? 0) + 1
            );
            rrCompleted++;
          }
        } finally {
          matchup.inFlight = false;
        }
      }

      await queueTableBroadcast(tableNum, {
        table: tableNum,
        idle: true,
        label: `Table ${tableNum}`,
      });
    };

    await Promise.all(Array.from({length: tableCount}, (_, idx) => runTableWorker(idx)));

    // Stage 2: Superfinal between top 2 Stage 1 finishers on Table 1
    let sfCompleted = 0;
    if (this.superfinalGames > 0) {
      const postRrState = await this.client.getTournamentState(tournamentId);
      const completedSfGames = postRrState.games
        .filter(g => g.stage === 'Superfinal' && g.outcome !== undefined)
        .sort((a, b) => a.matchupGame - b.matchupGame);
      const existingSf = completedSfGames.length;
      if (postRrState.entrants.length >= 2 && existingSf < this.superfinalGames) {
        const postEntrantByVer = new Map(postRrState.entrants.map(e => [e.versionId, e]));
        // If resuming mid-Superfinal, lock the exact two finalists from Game 1 (`matchupGame = 1`,
        // where `rrPairs * 2 + 0` is even so `p1` = `finalistA` and `p2` = `finalistB`).
        const g1Sf = completedSfGames.find(g => g.matchupGame === 1) ?? completedSfGames[0];
        const finalistA = g1Sf
          ? (g1Sf.matchupGame % 2 === 1
            ? postEntrantByVer.get(g1Sf.p1.versionId)
            : postEntrantByVer.get(g1Sf.p2.versionId)) ?? postRrState.entrants[0]
          : postRrState.entrants[0];
        const finalistB = g1Sf
          ? (g1Sf.matchupGame % 2 === 1
            ? postEntrantByVer.get(g1Sf.p2.versionId)
            : postEntrantByVer.get(g1Sf.p1.versionId)) ?? postRrState.entrants[1]
          : postRrState.entrants[1];
        const binding = this.tables[0] ?? LOCAL_TABLE_BINDING;
        const sfSideA: MountedEntrant = {
          entrant: finalistA,
          vmHost: binding.vmA.host,
          controlSocket: binding.vmA.controlSocket,
        };
        const sfSideB: MountedEntrant = {
          entrant: finalistB,
          vmHost: binding.vmB.host,
          controlSocket: binding.vmB.controlSocket,
        };
        for (let gIdx = existingSf; gIdx < this.superfinalGames; gIdx++) {
          const matchupGame = gIdx + 1;
          const isFinalGame = matchupGame === this.superfinalGames;
          const gameId = `t${tourney.id}-sf-g${String(matchupGame).padStart(3, '0')}`;
          await playSingleGame({
            tableNum: 1,
            stage: 'Superfinal',
            cycle: 1,
            matchupGame,
            gameId,
            sideA: sfSideA,
            sideB: sfSideB,
            gameIndexZeroBased: rrPairs * 2 + gIdx,
            finalTournamentStatus: isFinalGame ? 'completed' : undefined,
          });
          sfCompleted++;
        }
      }
    }

    await this.client
      .sendTournamentBroadcast(tournamentId, {off: true, tournamentStatus: 'completed'})
      .catch(() => undefined);
    return {roundRobinGames: rrCompleted, superfinalGames: sfCompleted};
  }
}
