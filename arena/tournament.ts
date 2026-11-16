import {ChildProcessWithoutNullStreams, execFileSync, spawn} from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import * as sim from '@pkmn/sim';

import {getTournamentBestOf} from '../db/tournaments';
import * as arena from '../server/arena';
import {filterPlayerProtocolChunk, parseAgentStdoutLine} from '../server/protocol';
import {GameOutcome} from '../server/ratings';
import {ensureSimConfigured, resolveArenaFormatId, sampleRandomPair} from '../server/teams';
import {toID} from '../static/util';
import * as teams from '../teams';

import * as arbiter from './arbiter';
import * as packages from './packages';

ensureSimConfigured();

type PlayerSlot = 'p1' | 'p2';

export function deriveGameSeed(baseSeed: sim.PRNGSeed, gameNumber: number): sim.PRNGSeed {
  if (gameNumber <= 1) return baseSeed;
  const digest = crypto
    .createHash('sha256')
    .update(`${baseSeed}:g${gameNumber}`)
    .digest();
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
export type TournamentAgentSpec = AgentSpec;

export interface TurnBroadcastInfo {
  turn: number;
  p1BankSeconds: number;
  p2BankSeconds: number;
  p1Thinking: boolean;
  p2Thinking: boolean;
  lines: string[];
  p1Pokemon?: unknown[];
  p2Pokemon?: unknown[];
}
export type TournamentTurnBroadcastInfo = TurnBroadcastInfo;

export interface SeriesGameSummary {
  winnerSlot?: PlayerSlot;
  turns: number;
}

export interface GamePlayerStats {
  bankSeconds: number;
  meanTurnMillis: number;
  peakRam: number;
}

export interface PlayerResult extends GamePlayerStats {
  teamPacked: string;
}

export interface SeriesGameResult {
  seed: sim.PRNGSeed;
  outcome: GameOutcome;
  turns: number;
  endReason: string;
  omniscientLog: string;
  p1: GamePlayerStats;
  p2: GamePlayerStats;
}

export interface GameOptions {
  format: string;
  customRules?: readonly string[];
  bestOf?: number;
  seed: sim.PRNGSeed;
  seeds?: readonly sim.PRNGSeed[];
  p1Spec: AgentSpec;
  p2Spec: AgentSpec;
  p1TeamPacked?: string;
  p2TeamPacked?: string;
  maxTurns?: number;
  smokeStopAfterTurn?: number;
  startingBankSeconds?: number;
  firstTurnGraceSeconds?: number;
  maxTurnSeconds?: number;
  utmTimeoutMillis?: number;
  onGameStart?: (info: {
    game: number;
    bestOf: number;
    summaries: SeriesGameSummary[];
  }) => void | Promise<void>;
  onSpectatorChunk?: (chunk: string, state: TurnBroadcastInfo) => void;
}
export type TournamentGameOptions = GameOptions;

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
export type TournamentGameResult = GameResult;

interface RemoteTournamentPlayer {
  slot: PlayerSlot;
  spec: AgentSpec;
  proc: ChildProcessWithoutNullStreams;
  usesRelay: boolean;
  reqSeq: number;
  lineQueue: string[];
  lineResolver: ((line: string | undefined) => void) | undefined;
  localTurnMillisQueue: number[];
  turnMillisWaiter: (() => void) | undefined;
  spotPreempted: boolean;
  sshDisconnected: boolean;
  launchError: string | undefined;
  bankMillis: number;
  totalTurnMillis: number;
  decisionsCount: number;
  peakRam: number;
  hasTakenFirstDecision: boolean;
  retryingInvalidChoice: boolean;
  invalidStrikes: number;
  lastRequestJson: string | undefined;
  thinking: boolean;
  exited: boolean;
}

const {MAX_STDOUT_LINE_CHARS, MAX_LINE_QUEUE, MAX_LINES_PER_DECISION, rewriteBlindPlayerNames} =
  arbiter;
export {rewriteBlindPlayerNames};

export interface TournamentTeamPair {
  p1Team: string;
  p2Team: string;
}

export function buildLockedTournamentTeamBook(
  teamPool: readonly string[],
  pairCount: number,
  format: string,
  tournamentId = '1'
): TournamentTeamPair[] {
  const uniqueTeams = [...new Set(teamPool.filter(Boolean))];
  if (uniqueTeams.length < 2 || pairCount <= 0) return [];

  const cleanFormat = toID(format);
  const dex = teams.getDex(cleanFormat);
  const defaultLevel =
    cleanFormat.includes('vgc') ||
    cleanFormat.includes('bss') ||
    cleanFormat.includes('champions')
      ? 50
      : 100;

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

  const book: TournamentTeamPair[] = pairs.map(p => ({
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
  private readonly format: string;
  private readonly bestOf: number;
  private readonly seed: sim.PRNGSeed;
  private readonly seeds?: readonly sim.PRNGSeed[];
  private readonly p1Spec: AgentSpec;
  private readonly p2Spec: AgentSpec;
  private p1TeamPacked?: string;
  private p2TeamPacked?: string;
  private readonly maxTurns: number;
  private readonly smokeStopAfterTurn?: number;
  private readonly startingBankMillis: number;
  private readonly firstTurnGraceMillis: number;
  private readonly maxTurnMillis: number;
  private readonly fullTurnIncrementMillis: number;
  private readonly midTurnIncrementMillis: number;
  private readonly accelerate: boolean;
  private readonly utmTimeoutMillis: number;
  private readonly onGameStart?: GameOptions['onGameStart'];
  private readonly onSpectatorChunk?: (
    chunk: string,
    state: TurnBroadcastInfo
  ) => void;

  private battleStream: sim.BattleStreams.BattleStream;
  private streams: ReturnType<typeof sim.BattleStreams.getPlayerStreams>;
  private readonly omniscientLog: string[] = [];

  private p1!: RemoteTournamentPlayer;
  private p2!: RemoteTournamentPlayer;
  private currentTurn = 0;
  private requestCount = 0;
  private waveActiveSidesCount = 1;
  private readonly pendingWaveSlots = new Set<PlayerSlot>();
  private lastRewardedTurn: Record<PlayerSlot, number> = {p1: -1, p2: -1};
  private ended = false;
  private winner: PlayerSlot | 'tie' | 'preempted' = 'tie';
  private preemptedSlot?: PlayerSlot;
  private endReason = 'normal';

  constructor(options: GameOptions) {
    this.format = resolveArenaFormatId(options.format, options.customRules);
    this.bestOf = options.smokeStopAfterTurn !== undefined
      ? 1
      : (options.bestOf ?? getTournamentBestOf(options.format, options.customRules));
    this.seed = options.seed;
    this.seeds = options.seeds;
    this.p1Spec = options.p1Spec;
    this.p2Spec = options.p2Spec;
    this.p1TeamPacked = options.p1TeamPacked;
    this.p2TeamPacked = options.p2TeamPacked;
    this.maxTurns = options.maxTurns ?? arena.MAX_BATTLE_TURNS;
    this.smokeStopAfterTurn = options.smokeStopAfterTurn;
    this.startingBankMillis =
      (options.startingBankSeconds ?? arena.STARTING_BANK_SECONDS) * 1000;
    this.firstTurnGraceMillis =
      (options.firstTurnGraceSeconds ?? arena.FIRST_TURN_GRACE_SECONDS) * 1000;
    this.maxTurnMillis = (options.maxTurnSeconds ?? arena.MAX_TURN_SECONDS) * 1000;
    this.fullTurnIncrementMillis = arena.turnIncrementSeconds(options.format) * 1000;
    this.midTurnIncrementMillis = arena.MID_TURN_INCREMENT_SECONDS * 1000;
    this.accelerate = !this.format.includes('vgc') && !this.format.includes('champions');
    this.utmTimeoutMillis = options.utmTimeoutMillis ?? 15_000;
    this.onGameStart = options.onGameStart;
    this.onSpectatorChunk = options.onSpectatorChunk;

    this.battleStream = new sim.BattleStreams.BattleStream();
    this.streams = sim.BattleStreams.getPlayerStreams(this.battleStream);
  }

  private lastLogIndex = 0;

  private getFullLog(): string {
    const rawLog = this.battleStream.battle
      ? this.battleStream.battle.log.join('\n')
      : this.omniscientLog.join('\n');
    return rewriteBlindPlayerNames(rawLog, this.p1Spec.displayName, this.p2Spec.displayName);
  }

  private getSpectatorLines(): string[] {
    const full = this.getFullLog();
    return full.length > 0 ? full.split('\n') : [];
  }

  private emitSpectatorChunk(rawChunk: string) {
    let chunkToEmit = rawChunk;
    if (this.battleStream.battle) {
      const battleLog = this.battleStream.battle.log;
      chunkToEmit = battleLog.slice(this.lastLogIndex).join('\n');
      this.lastLogIndex = battleLog.length;
    }
    const publicChunk = rewriteBlindPlayerNames(
      chunkToEmit,
      this.p1Spec.displayName,
      this.p2Spec.displayName
    );
    this.omniscientLog.push(publicChunk);
    const p1Pokemon = this.battleStream.battle?.sides[0]?.getRequestData().pokemon;
    const p2Pokemon = this.battleStream.battle?.sides[1]?.getRequestData().pokemon;
    this.onSpectatorChunk?.(publicChunk, {
      turn: this.currentTurn,
      p1BankSeconds: Math.max(
        0,
        Math.round((this.p1?.bankMillis ?? this.startingBankMillis) / 1000)
      ),
      p2BankSeconds: Math.max(
        0,
        Math.round((this.p2?.bankMillis ?? this.startingBankMillis) / 1000)
      ),
      p1Thinking: Boolean(this.p1?.thinking),
      p2Thinking: Boolean(this.p2?.thinking),
      lines: this.getSpectatorLines(),
      p1Pokemon,
      p2Pokemon,
    });
  }

  private spawnRemotePlayer(slot: PlayerSlot, spec: AgentSpec): RemoteTournamentPlayer {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(spec.agentId) || spec.agentId.includes('..')) {
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
      usesRelay,
      reqSeq: 0,
      lineQueue: [],
      lineResolver: undefined,
      localTurnMillisQueue: [],
      turnMillisWaiter: undefined,
      spotPreempted: false,
      sshDisconnected: false,
      launchError: undefined,
      bankMillis: this.startingBankMillis,
      totalTurnMillis: 0,
      decisionsCount: 0,
      peakRam: 1,
      hasTakenFirstDecision: false,
      retryingInvalidChoice: false,
      invalidStrikes: 0,
      lastRequestJson: undefined,
      thinking: false,
      exited: false,
    };

    const onDisconnect = (code?: number | null) => {
      player.exited = true;
      if (code === 255) {
        player.sshDisconnected = true;
      }
      if (player.turnMillisWaiter) {
        const w = player.turnMillisWaiter;
        player.turnMillisWaiter = undefined;
        w();
      }
      if (player.lineResolver) {
        const resolve = player.lineResolver;
        player.lineResolver = undefined;
        resolve(undefined);
      }
    };

    let stdoutBuf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      stdoutBuf += chunk;
      if (stdoutBuf.length > MAX_STDOUT_LINE_CHARS) {
        stdoutBuf = '';
        try {
          proc.kill('SIGKILL');
        } catch {}
        onDisconnect(1);
        return;
      }
      let nl = stdoutBuf.indexOf('\n');
      while (nl >= 0) {
        const line = stdoutBuf.slice(0, nl).replace(/\r$/, '');
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (player.lineResolver) {
          const resolve = player.lineResolver;
          player.lineResolver = undefined;
          resolve(line);
        } else if (player.lineQueue.length < MAX_LINE_QUEUE) {
          player.lineQueue.push(line);
        }
        nl = stdoutBuf.indexOf('\n');
      }
    });

    const handleStderrLine = (errLine: string) => {
      if (errLine.startsWith('ARENA_TURN_MS=')) {
        const rawVal = errLine.slice('ARENA_TURN_MS='.length).trim();
        const [millisStr, seqStr] = rawVal.split('\t');
        const millis = Number(millisStr);
        const seq = seqStr !== undefined ? Number(seqStr) : player.reqSeq;
        if (
          Number.isFinite(millis) &&
          millis >= 0 &&
          seq === player.reqSeq &&
          player.localTurnMillisQueue.length < MAX_LINE_QUEUE
        ) {
          player.localTurnMillisQueue.push(millis);
          if (player.turnMillisWaiter) {
            const w = player.turnMillisWaiter;
            player.turnMillisWaiter = undefined;
            w();
          }
        }
      } else if (errLine.startsWith('ARENA_PEAK_RAM=')) {
        const mib = Number(errLine.slice('ARENA_PEAK_RAM='.length).trim());
        if (Number.isFinite(mib) && mib >= 1) {
          player.peakRam = Math.max(player.peakRam, Math.round(mib));
        }
      } else if (errLine.includes('ARENA_SPOT_PREEMPTED')) {
        player.spotPreempted = true;
      } else if (errLine.startsWith('TOURNEY_ERROR:')) {
        player.launchError = errLine.trim();
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
      let nl = stderrBuf.indexOf('\n');
      while (nl >= 0) {
        const errLine = stderrBuf.slice(0, nl).replace(/\r$/, '');
        stderrBuf = stderrBuf.slice(nl + 1);
        handleStderrLine(errLine);
        nl = stderrBuf.indexOf('\n');
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

  private async takeLocalTurnMillis(
    player: RemoteTournamentPlayer,
    line: string | undefined,
    wallMillis: number
  ): Promise<number> {
    if (line === undefined || player.reqSeq === 0) return wallMillis;
    if (player.localTurnMillisQueue.length > 0) {
      return player.localTurnMillisQueue.shift()!;
    }
    if (player.usesRelay && !player.exited) {
      await new Promise<void>(resolve => {
        const t = setTimeout(() => {
          if (player.turnMillisWaiter === wake) player.turnMillisWaiter = undefined;
          resolve();
        }, 25);
        const wake = () => {
          clearTimeout(t);
          resolve();
        };
        player.turnMillisWaiter = wake;
      });
      if (player.localTurnMillisQueue.length > 0) {
        return player.localTurnMillisQueue.shift()!;
      }
    }
    return wallMillis;
  }

  private async readLineWithTimeout(
    player: RemoteTournamentPlayer,
    budgetMillis: number
  ): Promise<{line: string | undefined; elapsedMillis: number; timedOut: boolean}> {
    const startNs = process.hrtime.bigint();

    if (player.lineQueue.length > 0) {
      const line = player.lineQueue.shift()!;
      const wallMillis = Number(process.hrtime.bigint() - startNs) / 1e6;
      const elapsedMillis = await this.takeLocalTurnMillis(player, line, wallMillis);
      return {line, elapsedMillis, timedOut: false};
    }
    if (player.exited) {
      return {line: undefined, elapsedMillis: 0, timedOut: false};
    }

    const raw = await new Promise<{
      line: string | undefined;
      wallMillis: number;
      timedOut: boolean;
    }>(resolve => {
      // Allow +1500 ms network slack on the arbiter timer so local VM clock is authoritative
      const timer = setTimeout(() => {
        player.lineResolver = undefined;
        resolve({line: undefined, wallMillis: budgetMillis, timedOut: true});
      }, Math.max(1, Math.ceil(budgetMillis + 1500)));

      player.lineResolver = line => {
        clearTimeout(timer);
        const wallMillis = Number(process.hrtime.bigint() - startNs) / 1e6;
        resolve({line, wallMillis, timedOut: false});
      };
    });
    if (raw.timedOut) {
      return {line: undefined, elapsedMillis: budgetMillis, timedOut: true};
    }
    const elapsedMillis = await this.takeLocalTurnMillis(player, raw.line, raw.wallMillis);
    return {line: raw.line, elapsedMillis, timedOut: false};
  }

  private validatePackedTeam(rawTeam: string | undefined): string | undefined {
    if (!rawTeam) return undefined;
    const sets = sim.Teams.unpack(rawTeam.trim());
    if (!sets || sets.length === 0) return undefined;
    for (const s of sets) s.name = '';
    const validator = new sim.TeamValidator(this.format);
    if (!validator.format.team) {
      const problems = validator.validateTeam(structuredClone(sets));
      if (problems?.length) return undefined;
    }
    return sim.Teams.pack(sets);
  }

  private async resolvePlayerTeam(
    player: RemoteTournamentPlayer,
    assignedTeam: string | undefined
  ): Promise<
    {ok: true; team: string} |
    {ok: false; reason: 'spot-preemption' | 'timeout' | 'crash' | 'invalid-choice'}
  > {
    if (assignedTeam !== undefined) {
      const valid = this.validatePackedTeam(assignedTeam);
      if (!valid) {
        return {ok: false, reason: 'invalid-choice'};
      }
      if (!player.exited && player.proc.stdin.writable) {
        player.proc.stdin.write(`|utm|${valid}\n`);
      }
      return {ok: true, team: valid};
    }

    // When no team is pre-assigned by the tournament, send zero lines on stdin and require the
    // agent's very first stdout line to be `/utm <packed_team>` with a legal team for the format.
    const {line, timedOut} = await this.readLineWithTimeout(player, this.utmTimeoutMillis);
    if (player.spotPreempted || player.sshDisconnected) {
      return {ok: false, reason: 'spot-preemption'};
    }
    if (timedOut) {
      return {ok: false, reason: 'timeout'};
    }
    if (line === undefined) {
      return {ok: false, reason: 'crash'};
    }
    const trimmed = line.trim();
    if (!trimmed.startsWith('/utm ')) {
      return {ok: false, reason: 'invalid-choice'};
    }
    const valid = this.validatePackedTeam(trimmed.slice(5));
    if (!valid) {
      return {ok: false, reason: 'invalid-choice'};
    }
    return {ok: true, team: valid};
  }

  private wakePendingLineResolvers() {
    for (const p of [this.p1, this.p2]) {
      if (p?.lineResolver) {
        const resolve = p.lineResolver;
        p.lineResolver = undefined;
        resolve(undefined);
      }
    }
  }

  private abortForSpotPreemption(slot: PlayerSlot) {
    if (this.ended) return;
    this.ended = true;
    this.winner = 'preempted';
    this.preemptedSlot = slot;
    this.endReason = 'spot-preemption';
    this.wakePendingLineResolvers();
    Promise.resolve(this.battleStream.write('>forcetie')).catch(() => undefined);
  }

  private forceLose(losingSlot: PlayerSlot, reason: string) {
    if (this.ended) return;
    this.ended = true;
    this.winner = losingSlot === 'p1' ? 'p2' : 'p1';
    this.endReason = reason;
    this.wakePendingLineResolvers();
    const winnerSimName = this.winner === 'p1' ? 'Agent A' : 'Agent B';
    Promise.resolve(this.battleStream.write(`>forcewin ${winnerSimName}`)).catch(() => undefined);
  }

  private async handleDecision(player: RemoteTournamentPlayer, reqJson: string) {
    if (this.ended) return;
    if (!player.retryingInvalidChoice) {
      this.pendingWaveSlots.add(player.slot);
    }
    await Promise.resolve();
    if (this.ended) return;
    if (this.pendingWaveSlots.size > 0) {
      this.requestCount++;
      this.waveActiveSidesCount = this.pendingWaveSlots.size;
      this.pendingWaveSlots.clear();
    }
    const req = JSON.parse(reqJson) as {teamPreview?: boolean};

    const {graceMillis, totalBudgetMillis, inactiveLine} = arbiter.beginTurnClockStep(
      player,
      this.currentTurn,
      this.lastRewardedTurn,
      {
        firstTurnGraceMillis: this.firstTurnGraceMillis,
        maxTurnMillis: this.maxTurnMillis,
        fullTurnIncrementMillis: this.fullTurnIncrementMillis,
        midTurnIncrementMillis: this.midTurnIncrementMillis,
        accelerate: this.accelerate,
        requestCount: this.requestCount,
        activeSidesCount: this.waveActiveSidesCount,
      }
    );

    if (!player.exited && player.proc.stdin.writable) {
      player.proc.stdin.write(inactiveLine);
    }

    let remainingBudgetMillis = totalBudgetMillis;
    let totalElapsedMillis = 0;
    let linesReadThisDecision = 0;
    player.thinking = true;

    try {
      while (!this.ended) {
        const {line, elapsedMillis, timedOut} = await this.readLineWithTimeout(
          player,
          remainingBudgetMillis
        );
        totalElapsedMillis += elapsedMillis;
        remainingBudgetMillis = totalBudgetMillis - totalElapsedMillis;

        if (player.spotPreempted || player.sshDisconnected) {
          this.abortForSpotPreemption(player.slot);
          return;
        }
        if (this.ended) return;
        if (timedOut || remainingBudgetMillis < 0) {
          player.bankMillis = 0;
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
        if (!parsed || parsed.kind === 'chat') continue;

        const decisionElapsedMillis = Math.max(1, Math.ceil(totalElapsedMillis));
        const overGraceMillis = Math.max(0, decisionElapsedMillis - graceMillis);
        player.bankMillis = Math.max(0, player.bankMillis - overGraceMillis);
        player.totalTurnMillis += decisionElapsedMillis;
        player.decisionsCount++;

        const choiceCmd = arbiter.formatChoiceCommand(parsed.choice, req.teamPreview);
        await this.battleStream.write(`>${player.slot} ${choiceCmd}`);
        return;
      }
    } finally {
      player.thinking = false;
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

        const inspected = arbiter.inspectPlayerProtocolChunk(chunk, player, this.ended);
        if (inspected.forfeitedInvalidChoice) {
          this.forceLose(player.slot, 'invalid-choice');
        }
        if (inspected.actionableReqJson) {
          player.reqSeq++;
          player.lineQueue.length = 0;
          player.localTurnMillisQueue.length = 0;
        }
        if (!player.exited && player.proc.stdin.writable) {
          player.proc.stdin.write(`${chunk}\n`);
          if (inspected.resendLastRequest && player.lastRequestJson) {
            player.proc.stdin.write(`|request|${player.lastRequestJson}\n`);
          }
        }

        if (inspected.actionableReqJson && !this.ended) {
          await this.handleDecision(player, inspected.actionableReqJson);
        }
      }
    })();
  }

  private resetForNextSeriesGame() {
    this.battleStream = new sim.BattleStreams.BattleStream();
    this.streams = sim.BattleStreams.getPlayerStreams(this.battleStream);
    this.omniscientLog.length = 0;
    this.lastLogIndex = 0;
    this.currentTurn = 0;
    this.requestCount = 0;
    this.waveActiveSidesCount = 1;
    this.pendingWaveSlots.clear();
    this.lastRewardedTurn = {p1: -1, p2: -1};
    this.ended = false;
    this.winner = 'tie';
    this.preemptedSlot = undefined;
    this.endReason = 'normal';

    for (const p of [this.p1, this.p2]) {
      p.lineQueue.length = 0;
      p.localTurnMillisQueue.length = 0;
      p.bankMillis = this.startingBankMillis;
      p.totalTurnMillis = 0;
      p.decisionsCount = 0;
      p.hasTakenFirstDecision = false;
      p.retryingInvalidChoice = false;
      p.invalidStrikes = 0;
      p.lastRequestJson = undefined;
      p.thinking = false;
    }
  }

  private async playSingleBattle(
    gameSeed: sim.PRNGSeed,
    p1Team: string,
    p2Team: string,
    resetStream: boolean
  ) {
    if (resetStream) {
      this.resetForNextSeriesGame();
    }

    const omniTask = (async () => {
      for await (const rawChunk of this.streams.omniscient) {
        for (const line of rawChunk.split('\n')) {
          const step = arbiter.inspectOmniscientLine(line, {
            currentTurn: this.currentTurn,
            maxTurns: this.maxTurns,
            smokeStopAfterTurn: this.smokeStopAfterTurn,
            ended: this.ended,
            expectedP1Name: 'Agent A',
          });
          this.currentTurn = step.currentTurn;
          if (step.terminal) {
            this.ended = true;
            this.winner = step.terminal.winner;
            this.endReason = step.terminal.endReason;
            if (step.terminal.forceTie) {
              await this.battleStream.write('>forcetie');
            }
          }
        }
        this.emitSpectatorChunk(rawChunk);
      }
    })();

    const p1Task = this.driveConcurrentPlayer(this.p1, this.streams.p1);
    const p2Task = this.driveConcurrentPlayer(this.p2, this.streams.p2);

    await this.battleStream.write(
      `>start ${JSON.stringify({formatid: this.format, seed: gameSeed})}`
    );
    await this.battleStream.write(
      `>player p1 ${JSON.stringify({name: 'Agent A', team: p1Team})}`
    );
    await this.battleStream.write(
      `>player p2 ${JSON.stringify({name: 'Agent B', team: p2Team})}`
    );

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
      p1BankSeconds: Math.max(0, Math.round(this.p1.bankMillis / 1000)),
      p2BankSeconds: Math.max(0, Math.round(this.p2.bankMillis / 1000)),
      p1TotalTurnMillis: this.p1.totalTurnMillis,
      p1DecisionsCount: this.p1.decisionsCount,
      p2TotalTurnMillis: this.p2.totalTurnMillis,
      p2DecisionsCount: this.p2.decisionsCount,
      p1MeanTurnMillis: this.p1.decisionsCount > 0
        ? Math.max(1, Math.round(this.p1.totalTurnMillis / this.p1.decisionsCount))
        : 1,
      p2MeanTurnMillis: this.p2.decisionsCount > 0
        ? Math.max(1, Math.round(this.p2.totalTurnMillis / this.p2.decisionsCount))
        : 1,
      p1PeakRam: this.p1.peakRam,
      p2PeakRam: this.p2.peakRam,
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
      p.exited
        ? Promise.resolve()
        : new Promise<void>(resolve => {
          const t = setTimeout(resolve, p.usesRelay ? 250 : 50);
          p.proc.once('close', () => {
            clearTimeout(t);
            resolve();
          });
        })
    )));
    for (const p of [this.p1, this.p2]) {
      if (!p.exited) {
        try {
          p.proc.kill('SIGTERM');
        } catch {}
      }
    }
    if (!this.p1.exited || !this.p2.exited) {
      await Promise.all([this.p1, this.p2].map(p => (
        p.exited
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

      const startBankSec = Math.round(this.startingBankMillis / 1000);

      if (
        (!p1Res.ok && p1Res.reason === 'spot-preemption') ||
        (!p2Res.ok && p2Res.reason === 'spot-preemption') ||
        this.p1.spotPreempted || this.p1.sshDisconnected ||
        this.p2.spotPreempted || this.p2.sshDisconnected
      ) {
        const slot: PlayerSlot =
          (!p1Res.ok && p1Res.reason === 'spot-preemption') ||
          this.p1.spotPreempted ||
          this.p1.sshDisconnected
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
            bankSeconds: startBankSec,
            meanTurnMillis: 0,
            peakRam: 1,
          },
          p2: {
            teamPacked: p2Team,
            bankSeconds: startBankSec,
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
          seed: this.seeds?.[idx] ?? deriveGameSeed(this.seed, idx + 1),
          outcome,
          turns: 0,
          endReason,
          omniscientLog: '',
          p1: {bankSeconds: startBankSec, meanTurnMillis: 1, peakRam: this.p1.peakRam},
          p2: {bankSeconds: startBankSec, meanTurnMillis: 1, peakRam: this.p2.peakRam},
        }));
        return {
          winner,
          outcome,
          turns: 0,
          endReason,
          launchError: this.p1.launchError ?? this.p2.launchError,
          omniscientLog: '',
          p1: {
            teamPacked: p1Team,
            bankSeconds: startBankSec,
            meanTurnMillis: 1,
            peakRam: this.p1.peakRam,
          },
          p2: {
            teamPacked: p2Team,
            bankSeconds: startBankSec,
            meanTurnMillis: 1,
            peakRam: this.p2.peakRam,
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
      let p1PeakRam = this.p1.peakRam;
      let p2PeakRam = this.p2.peakRam;

      for (let gameNum = 1; gameNum <= this.bestOf; gameNum++) {
        const gameSeed = this.seeds?.[gameNum - 1] ?? deriveGameSeed(this.seed, gameNum);
        await this.onGameStart?.({
          game: gameNum,
          bestOf: this.bestOf,
          summaries: [...summaries],
        });
        const g = await this.playSingleBattle(gameSeed, p1Team, p2Team, gameNum > 1);
        totalTurns += g.turns;
        p1PeakRam = Math.max(p1PeakRam, g.p1PeakRam, this.p1.peakRam);
        p2PeakRam = Math.max(p2PeakRam, g.p2PeakRam, this.p2.peakRam);

        if (g.winner === 'preempted' || !g.outcome) {
          await this.closePlayers();
          p1PeakRam = Math.max(p1PeakRam, this.p1.peakRam);
          p2PeakRam = Math.max(p2PeakRam, this.p2.peakRam);
          return {
            winner: 'preempted',
            preemptedSlot: g.preemptedSlot,
            turns: totalTurns,
            endReason: 'spot-preemption',
            launchError: this.p1.launchError ?? this.p2.launchError,
            omniscientLog: g.omniscientLog,
            p1: {
              teamPacked: p1Team,
              bankSeconds: g.p1BankSeconds,
              meanTurnMillis: g.p1MeanTurnMillis,
              peakRam: p1PeakRam,
            },
            p2: {
              teamPacked: p2Team,
              bankSeconds: g.p2BankSeconds,
              meanTurnMillis: g.p2MeanTurnMillis,
              peakRam: p2PeakRam,
            },
            games,
          };
        }

        totalP1Decisions += g.p1DecisionsCount;
        totalP1Millis += g.p1TotalTurnMillis;
        totalP2Decisions += g.p2DecisionsCount;
        totalP2Millis += g.p2TotalTurnMillis;

        games.push({
          seed: gameSeed,
          outcome: g.outcome,
          turns: g.turns,
          endReason: g.endReason,
          omniscientLog: g.omniscientLog,
          p1: {
            bankSeconds: g.p1BankSeconds,
            meanTurnMillis: g.p1MeanTurnMillis,
            peakRam: g.p1PeakRam > 1 ? g.p1PeakRam : p1PeakRam,
          },
          p2: {
            bankSeconds: g.p2BankSeconds,
            meanTurnMillis: g.p2MeanTurnMillis,
            peakRam: g.p2PeakRam > 1 ? g.p2PeakRam : p2PeakRam,
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
      p1PeakRam = Math.max(p1PeakRam, this.p1.peakRam);
      p2PeakRam = Math.max(p2PeakRam, this.p2.peakRam);
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
        launchError: this.p1.launchError ?? this.p2.launchError,
        omniscientLog: games[0].omniscientLog,
        p1: {
          teamPacked: p1Team,
          bankSeconds: lastGame.p1.bankSeconds,
          meanTurnMillis: p1MeanTurnMillis,
          peakRam: p1PeakRam,
        },
        p2: {
          teamPacked: p2Team,
          bankSeconds: lastGame.p2.bankSeconds,
          meanTurnMillis: p2MeanTurnMillis,
          peakRam: p2PeakRam,
        },
        games,
      };
    } finally {
      try {
        this.p1.proc.kill('SIGTERM');
      } catch {}
      try {
        this.p2.proc.kill('SIGTERM');
      } catch {}
    }
  }
}
export {ConcurrentGame as ConcurrentTournamentGame};

export interface MatchupState {
  agentA: number;
  agentB: number;
  gamesPlayed: number;
  gamesTarget: number;
  inFlight: boolean;
}
export type TournamentMatchupState = MatchupState;

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
export {selectNextBatch as selectNextTournamentBatch};

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
      `Unpacked tournament rootfs size (${unpackedBytes} B) exceeds 500 MB cap`
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
  agentsDir?: string;
  stagingDir?: string;
}): number {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(opts.targetId) || opts.targetId.includes('..')) {
    throw new Error(`Invalid tournament agent targetId: ${opts.targetId}`);
  }
  const agentsDir = opts.agentsDir ?? '/opt/arena/agents';
  const stagingDir = opts.stagingDir ?? '/tmp';
  fs.mkdirSync(stagingDir, {recursive: true});
  fs.mkdirSync(agentsDir, {recursive: true});

  const cleanRef = opts.imageRef.replace(/^docker:\/\//, '').trim();
  const repoRef = packages.stripOciTagOrDigest(cleanRef);
  const inspected = packages.inspectRemoteOciSize(
    cleanRef,
    opts.authToken,
    opts.expectedSha256,
    {os: 'linux', arch: 'amd64'},
    stagingDir
  );
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
export {unpackOciRootfs as unpackTournamentOciRootfs};

export interface TableBinding {
  vmHostA: string;
  controlSocketA: string;
  vmHostB: string;
  controlSocketB: string;
}
export type TournamentTableBinding = TableBinding;

export interface Options {
  client: arena.Client;
  baselineSpec: AgentSpec;
  agentsDir?: string;
  stagingDir?: string;
  tourneyAgentBin?: string;
  tables?: readonly TableBinding[];
  superfinalGames?: number;
  maxTurns?: number;
  randomInt?: (max: number) => number;
  prepareSubmissionRootfs?: (
    sub: arena.PendingSubmission,
    targetId: string
  ) => Promise<number> | number;
  resolveEntrantSpec?: (
    entrant: {
      versionId: number;
      agentId: number;
      agentSlug: string;
      agentName: string;
      version: string;
    },
    vmHost: string,
    controlSocket: string
  ) => AgentSpec;
}
export type TournamentCoordinatorOptions = Options;

const TOURNAMENT_FAULT_REASONS = new Set(['crash', 'timeout', 'invalid-choice']);

// GCP-side Tournament Coordinator:
//   1. `processPendingSubmissions` pulls & smoke-tests `linux/amd64` tournament OCI submissions on
//      GCP inside `bwrap` (`tourney-agent`) so Mac minis never touch `amd64` tournament artifacts.
//   2. `runTournament` drives crash-resumable Double Round-Robin waves + Superfinal across
//      `parallelTables` with live table broadcasts and immediate `.log` replay publication.
export class Coordinator {
  readonly client: arena.Client;
  private readonly baselineSpec: AgentSpec;
  private readonly agentsDir: string;
  private readonly stagingDir: string;
  private readonly tourneyAgentBin: string;
  private readonly tables: readonly TableBinding[];
  private readonly superfinalGames: number;
  private readonly maxTurns?: number;
  private readonly randomInt: (max: number) => number;
  private readonly prepareSubmissionRootfs?: (
    sub: arena.PendingSubmission,
    targetId: string
  ) => Promise<number> | number;
  private readonly customResolveEntrantSpec?: Options['resolveEntrantSpec'];

  constructor(options: Options) {
    this.client = options.client;
    this.baselineSpec = options.baselineSpec;
    this.agentsDir = options.agentsDir ?? '/opt/arena/agents';
    this.stagingDir = options.stagingDir ?? '/tmp';
    this.tourneyAgentBin = options.tourneyAgentBin ?? '/usr/local/bin/tourney-agent';
    this.tables = options.tables ?? [];
    this.superfinalGames = options.superfinalGames ?? 100;
    this.maxTurns = options.maxTurns;
    this.randomInt = options.randomInt ?? (max => crypto.randomInt(0, max));
    this.prepareSubmissionRootfs = options.prepareSubmissionRootfs;
    this.customResolveEntrantSpec = options.resolveEntrantSpec;
  }

  private randomPrngSeed(): sim.PRNGSeed {
    const s0 = this.randomInt(0x10000);
    const s1 = this.randomInt(0x10000);
    const s2 = this.randomInt(0x10000);
    const s3 = this.randomInt(0x10000);
    return `${s0},${s1},${s2},${s3}`;
  }

  private resolveEntrantSpec(
    entrant: {
      versionId: number;
      agentId: number;
      agentSlug: string;
      agentName: string;
      version: string;
    },
    vmHost: string,
    controlSocket: string
  ): AgentSpec {
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
        localCommand: this.tourneyAgentBin,
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
      if (sub.tournaments.length === 0) continue;
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
            agentsDir: this.agentsDir,
            stagingDir: this.stagingDir,
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

      const candidateSpec = this.resolveEntrantSpec(
        {
          versionId: sub.versionId,
          agentId: sub.agentId,
          agentSlug: sub.agentSlug,
          agentName: sub.agentName,
          version: sub.version,
        },
        '127.0.0.1',
        ''
      );

      const smokeStart = Date.now();
      let maxTurnMillis = 1;
      let smokeError: string | undefined;

      for (const tid of sub.tournaments) {
        const meta = tourneyById.get(tid);
        const format = meta?.format ?? 'gen9ou';
        let customRules: string[] = [];
        if (meta?.rulesJson) {
          try {
            const parsed = JSON.parse(meta.rulesJson) as unknown;
            if (Array.isArray(parsed)) {
              customRules = parsed.filter((r): r is string => typeof r === 'string');
            }
          } catch {}
        }

        let p1TeamPacked: string | undefined;
        let p2TeamPacked: string | undefined;
        const pool = meta?.teamPool ?? [];
        if ((meta?.team === 'harvested' || meta?.team === 'pools') && pool.length >= 2) {
          p1TeamPacked = pool[0];
          p2TeamPacked = pool.find(t => t !== p1TeamPacked) ?? pool[1];
        } else if (
          meta?.team === 'random' ||
          (meta?.team === undefined && toID(format).includes('random'))
        ) {
          const pair = sampleRandomPair(format, '1,2,3,4', '5,6,7,8');
          p1TeamPacked = pair.t1Packed;
          p2TeamPacked = pair.t2Packed;
        }

        const smokeGame = new ConcurrentGame({
          format,
          customRules,
          seed: '1,2,3,4',
          p1Spec: candidateSpec,
          p2Spec: this.baselineSpec,
          p1TeamPacked,
          p2TeamPacked,
          smokeStopAfterTurn: 1,
          startingBankSeconds: 30,
          firstTurnGraceSeconds: 30,
          maxTurnSeconds: 30,
        });
        const res = await smokeGame.run();
        const p1Faulted =
          res.winner === 'preempted' ||
          (TOURNAMENT_FAULT_REASONS.has(res.endReason) && res.winner === 'p2');
        if (p1Faulted) {
          smokeError = `GCP smoke test failed in ${format}: ${res.endReason}`;
          break;
        }
        if (res.p1.meanTurnMillis > maxTurnMillis) maxTurnMillis = res.p1.meanTurnMillis;
      }

      const smokeDurationMillis = Math.max(1, Date.now() - smokeStart);
      if (smokeError) {
        fs.rmSync(path.join(this.agentsDir, targetId), {recursive: true, force: true});
        await this.client.reportSubmissionStatus({
          versionId: sub.versionId,
          smokeStatus: 'failed',
          smokeError,
        });
        continue;
      }

      await this.client.reportSubmissionStatus({
        versionId: sub.versionId,
        smokeStatus: 'passed',
        unpackedBytes,
        smokeDurationMillis,
        smokeTurnMillis: maxTurnMillis,
      });
    }

    return processed;
  }

  private samplePairForGame(
    lockedBook: readonly TournamentTeamPair[],
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
        `Tournament "${tournamentId}" requires at least 2 entrants ` +
        `(found ${state.entrants.length}).`
      );
    }

    const entrantByVersion = new Map(state.entrants.map(e => [e.versionId, e]));
    const versionIds = state.entrants.map(e => e.versionId);
    const incSeconds = arena.turnIncrementSeconds(tourney.format);
    const totalPairs = Math.max(
      1,
      Math.ceil(Math.max(tourney.gamesPerMatchup, this.superfinalGames) / 2)
    );
    let lockedBook: TournamentTeamPair[] = [];
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
      lockedBook = Array.from({length: totalPairs}, () => {
        const pair = sampleRandomPair(
          tourney.format,
          this.randomPrngSeed(),
          this.randomPrngSeed()
        );
        return {p1Team: pair.t1Packed, p2Team: pair.t2Packed};
      });
    }
    const pairSeeds: sim.PRNGSeed[] = Array.from(
      {length: totalPairs},
      () => this.randomPrngSeed()
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
    const tourneyBestOf = tourney.bestOf ??
      getTournamentBestOf(tourney.format, tourney.customRules);
    let markedRunning = tourney.status === 'running';
    let rrCompleted = 0;

    const playSingleGame = async (params: {
      tableNum: number;
      stage: 'Round Robin' | 'Superfinal';
      cycle: number;
      matchupGame: number;
      gameId: string;
      entA: (typeof state.entrants)[number];
      entB: (typeof state.entrants)[number];
      vmHostA: string;
      controlA: string;
      vmHostB: string;
      controlB: string;
      gameIndexZeroBased: number;
      finalTournamentStatus?: 'running' | 'completed';
    }): Promise<void> => {
      const sampled = this.samplePairForGame(
        lockedBook,
        params.gameIndexZeroBased
      );
      const pairIdx = Math.floor(params.gameIndexZeroBased / 2);
      const p1Ent = sampled.swappedSeats ? params.entB : params.entA;
      const p2Ent = sampled.swappedSeats ? params.entA : params.entB;
      const p1Host = sampled.swappedSeats ? params.vmHostB : params.vmHostA;
      const p1Ctrl = sampled.swappedSeats ? params.controlB : params.controlA;
      const p2Host = sampled.swappedSeats ? params.vmHostA : params.vmHostB;
      const p2Ctrl = sampled.swappedSeats ? params.controlA : params.controlB;

      let preemptions = 0;
      for (;;) {
        const seed =
          preemptions === 0
            ? pairSeeds[pairIdx % pairSeeds.length]
            : this.randomPrngSeed();
        const p1Spec = this.resolveEntrantSpec(p1Ent, p1Host, p1Ctrl);
        const p2Spec = this.resolveEntrantSpec(p2Ent, p2Host, p2Ctrl);

        const sendTableLoad = (info?: {
          game: number;
          bestOf: number;
          summaries: SeriesGameSummary[];
        }) => this.client.sendTournamentBroadcast(tournamentId, {
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
            bankSeconds: arena.STARTING_BANK_SECONDS,
            thinking: true,
            incrementSeconds: incSeconds,
          },
          p2: {
            slug: p2Ent.agentSlug,
            name: p2Ent.agentName,
            version: p2Ent.version,
            bankSeconds: arena.STARTING_BANK_SECONDS,
            thinking: true,
            incrementSeconds: incSeconds,
          },
          lines: [],
          live: true,
        }).catch(() => undefined);

        await sendTableLoad({game: 1, bestOf: tourneyBestOf, summaries: []});

        const game = new ConcurrentGame({
          format: tourney.format,
          customRules: tourney.customRules,
          bestOf: tourneyBestOf,
          seed,
          p1Spec,
          p2Spec,
          p1TeamPacked: sampled.p1Team,
          p2TeamPacked: sampled.p2Team,
          maxTurns: this.maxTurns,
          onGameStart: async info => {
            if (info.game > 1) {
              await sendTableLoad(info);
            }
          },
          onSpectatorChunk: (chunk, snap) => {
            if (!chunk) return;
            const newLines = chunk.split('\n');
            if (newLines.length === 0) return;
            void this.client.sendTournamentBroadcast(tournamentId, {
              table: params.tableNum,
              mode: 'append',
              p1: {
                slug: p1Ent.agentSlug,
                name: p1Ent.agentName,
                version: p1Ent.version,
                bankSeconds: snap.p1BankSeconds,
                thinking: snap.p1Thinking,
                incrementSeconds: incSeconds,
                ...(snap.p1Pokemon ? {pokemon: snap.p1Pokemon} : {}),
              },
              p2: {
                slug: p2Ent.agentSlug,
                name: p2Ent.agentName,
                version: p2Ent.version,
                bankSeconds: snap.p2BankSeconds,
                thinking: snap.p2Thinking,
                incrementSeconds: incSeconds,
                ...(snap.p2Pokemon ? {pokemon: snap.p2Pokemon} : {}),
              },
              lines: newLines,
              live: true,
            }).catch(() => undefined);
          },
        });

        const res = await game.run();
        if (res.winner === 'preempted' || !res.outcome) {
          preemptions++;
          if (preemptions >= 5) {
            throw new Error(`Exceeded 5 consecutive Spot preemptions on ${params.gameId}`);
          }
          continue;
        }

        const statusUpdate =
          params.finalTournamentStatus ?? (!markedRunning ? 'running' : undefined);
        markedRunning = true;
        await this.client.completeTournamentGame(tournamentId, {
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
      const binding = this.tables[tableIdx] ?? {
        vmHostA: '127.0.0.1',
        controlSocketA: '',
        vmHostB: '127.0.0.1',
        controlSocketB: '',
      };
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

        const entA = entrantByVersion.get(batch.agentOnVmA)!;
        const entB = entrantByVersion.get(batch.agentOnVmB)!;

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
              entA,
              entB,
              vmHostA: binding.vmHostA,
              controlA: binding.controlSocketA,
              vmHostB: binding.vmHostB,
              controlB: binding.controlSocketB,
              gameIndexZeroBased: gIdx,
            });
            matchup.gamesPlayed++;
            totalGamesByVersion.set(
              batch.agentOnVmA,
              (totalGamesByVersion.get(batch.agentOnVmA) ?? 0) + 1
            );
            totalGamesByVersion.set(
              batch.agentOnVmB,
              (totalGamesByVersion.get(batch.agentOnVmB) ?? 0) + 1
            );
            rrCompleted++;
          }
        } finally {
          matchup.inFlight = false;
        }
      }

      await this.client.sendTournamentBroadcast(tournamentId, {
        table: tableNum,
        idle: true,
        label: `Table ${tableNum}`,
      }).catch(() => undefined);
    };

    await Promise.all(Array.from({length: tableCount}, (_, idx) => runTableWorker(idx)));

    // Stage 2: Superfinal between top 2 Stage 1 finishers on Table 1
    let sfCompleted = 0;
    if (this.superfinalGames > 0) {
      const postRrState = await this.client.getTournamentState(tournamentId);
      const existingSf = postRrState.games.filter(
        g => g.stage === 'Superfinal' && g.outcome !== undefined
      ).length;
      if (postRrState.entrants.length >= 2 && existingSf < this.superfinalGames) {
        const finalistA = postRrState.entrants[0];
        const finalistB = postRrState.entrants[1];
        const binding = this.tables[0] ?? {
          vmHostA: '127.0.0.1',
          controlSocketA: '',
          vmHostB: '127.0.0.1',
          controlSocketB: '',
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
            entA: finalistA,
            entB: finalistB,
            vmHostA: binding.vmHostA,
            controlA: binding.controlSocketA,
            vmHostB: binding.vmHostB,
            controlB: binding.controlSocketB,
            gameIndexZeroBased: gIdx,
            finalTournamentStatus: isFinalGame ? 'completed' : undefined,
          });
          sfCompleted++;
        }
      }
    }

    await this.client.sendTournamentBroadcast(tournamentId, {off: true}).catch(() => undefined);
    return {roundRobinGames: rrCompleted, superfinalGames: sfCompleted};
  }
}
export {Coordinator as TournamentCoordinator};
