import {ChildProcessWithoutNullStreams, execFileSync, spawn} from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

import {BattleStreams, Dex, PRNGSeed, PokemonSet, TeamValidator, Teams} from '@pkmn/sim';

import * as arena from '../server/arena';
import {filterPlayerProtocolChunk, parseAgentStdoutLine} from '../server/protocol';
import {GameOutcome} from '../server/ratings';
import {ensureSimConfigured, resolveArenaFormatId, sampleRandomPair} from '../server/teams';
import {toID} from '../static/util';

import * as packages from './packages';

ensureSimConfigured();

type PlayerSlot = 'p1' | 'p2';

export function synthesizeFallbackPackedTeam(formatId: string, offset = 0): string {
  const dex = Dex.forFormat(formatId);
  const sets: PokemonSet[] = [];
  for (const sp of dex.species.all()) {
    if (!sp.exists || sp.isNonstandard || sp.gen > dex.gen || sp.nfe || sp.forme) continue;
    const learnset = dex.species.getLearnsetData(sp.id).learnset ?? {};
    const moves: string[] = [];
    for (const moveId of Object.keys(learnset)) {
      const mv = dex.moves.get(moveId);
      if (mv.exists && !mv.isNonstandard && mv.gen <= dex.gen && mv.category !== 'Status') {
        moves.push(mv.name);
        if (moves.length === 4) break;
      }
    }
    if (moves.length === 0) continue;
    sets.push({
      name: '',
      species: sp.name,
      item: '',
      ability: dex.gen >= 3 ? sp.abilities['0'] : '',
      moves,
      nature: dex.gen >= 3 ? 'Serious' : '',
      gender: '',
      evs: {hp: 252, atk: 0, def: 4, spa: 0, spd: 0, spe: 252},
      ivs: {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31},
      level: 100,
    });
    if (sets.length >= 18) break;
  }
  const chosen: PokemonSet[] = [];
  for (let i = 0; i < 6 && sets.length > 0; i++) {
    chosen.push(sets[(offset * 6 + i) % sets.length]);
  }
  return Teams.pack(chosen);
}

export interface TournamentAgentSpec {
  agentId: string;
  displayName: string;
  vmHost: string;
  controlSocket: string;
  staticTeam?: string;
  // Optional local override for dev/testing without SSH to a GCE VM
  localCommand?: string;
  localArgs?: string[];
}

export interface TournamentTurnBroadcastInfo {
  turn: number;
  p1BankSeconds: number;
  p2BankSeconds: number;
  p1Thinking: boolean;
  p2Thinking: boolean;
  lines: string[];
}

export interface TournamentGameOptions {
  format: string;
  customRules?: readonly string[];
  seed: PRNGSeed;
  p1Spec: TournamentAgentSpec;
  p2Spec: TournamentAgentSpec;
  byot: boolean;
  p1TeamPacked?: string;
  p2TeamPacked?: string;
  maxTurns?: number;
  smokeStopAfterTurn?: number;
  startingBankSeconds?: number;
  firstTurnGraceSeconds?: number;
  maxTurnSeconds?: number;
  byotBudgetMs?: number;
  onSpectatorChunk?: (chunk: string, state: TournamentTurnBroadcastInfo) => void;
}

export interface TournamentGameResult {
  winner: PlayerSlot | 'tie' | 'preempted';
  outcome?: GameOutcome;
  preemptedSlot?: PlayerSlot;
  turns: number;
  endReason: string;
  omniscientLog: string;
  p1TeamPacked: string;
  p2TeamPacked: string;
  p1BankSeconds: number;
  p2BankSeconds: number;
  p1MeanTurnMillis: number;
  p2MeanTurnMillis: number;
}

interface RemoteTournamentPlayer {
  slot: PlayerSlot;
  spec: TournamentAgentSpec;
  proc: ChildProcessWithoutNullStreams;
  usesRelay: boolean;
  reqSeq: number;
  lineQueue: string[];
  lineResolver: ((line: string | undefined) => void) | undefined;
  localTurnMsQueue: number[];
  turnMsWaiter: (() => void) | undefined;
  spotPreempted: boolean;
  sshDisconnected: boolean;
  bankMs: number;
  totalTurnMs: number;
  decisionsCount: number;
  hasTakenFirstDecision: boolean;
  retryingInvalidChoice: boolean;
  invalidStrikes: number;
  lastRequestJson: string | undefined;
  thinking: boolean;
  exited: boolean;
}

const MAX_INVALID_STRIKES = 3;
const MAX_STDOUT_LINE_CHARS = 65_536;
const MAX_LINE_QUEUE = 256;
const MAX_LINES_PER_DECISION = 64;

export function rewriteBlindPlayerNames(
  chunk: string,
  p1DisplayName: string,
  p2DisplayName: string
): string {
  return chunk
    .replaceAll('|player|p1|Agent A|', `|player|p1|${p1DisplayName}|`)
    .replaceAll('|player|p2|Agent B|', `|player|p2|${p2DisplayName}|`)
    .replaceAll('|win|Agent A', `|win|${p1DisplayName}`)
    .replaceAll('|win|Agent B', `|win|${p2DisplayName}`)
    .replaceAll('☆Agent A|', `☆${p1DisplayName}|`)
    .replaceAll('☆Agent B|', `☆${p2DisplayName}|`);
}

export class ConcurrentTournamentGame {
  private readonly format: string;
  private readonly seed: PRNGSeed;
  private readonly p1Spec: TournamentAgentSpec;
  private readonly p2Spec: TournamentAgentSpec;
  private readonly byot: boolean;
  private p1TeamPacked?: string;
  private p2TeamPacked?: string;
  private readonly maxTurns: number;
  private readonly smokeStopAfterTurn?: number;
  private readonly startingBankMs: number;
  private readonly firstTurnGraceMs: number;
  private readonly maxTurnMs: number;
  private readonly fullTurnIncrementMs: number;
  private readonly midTurnIncrementMs: number;
  private readonly byotBudgetMs: number;
  private readonly onSpectatorChunk?: (
    chunk: string,
    state: TournamentTurnBroadcastInfo
  ) => void;

  private readonly battleStream: BattleStreams.BattleStream;
  private readonly streams: ReturnType<typeof BattleStreams.getPlayerStreams>;
  private readonly omniscientLog: string[] = [];

  private p1!: RemoteTournamentPlayer;
  private p2!: RemoteTournamentPlayer;
  private currentTurn = 0;
  private lastRewardedTurn: Record<PlayerSlot, number> = {p1: -1, p2: -1};
  private ended = false;
  private winner: PlayerSlot | 'tie' | 'preempted' = 'tie';
  private preemptedSlot?: PlayerSlot;
  private endReason = 'normal';

  constructor(options: TournamentGameOptions) {
    this.format = resolveArenaFormatId(options.format, options.customRules);
    this.seed = options.seed;
    this.p1Spec = options.p1Spec;
    this.p2Spec = options.p2Spec;
    this.byot = options.byot;
    this.p1TeamPacked = options.p1TeamPacked;
    this.p2TeamPacked = options.p2TeamPacked;
    this.maxTurns = options.maxTurns ?? arena.MAX_BATTLE_TURNS;
    this.smokeStopAfterTurn = options.smokeStopAfterTurn;
    this.startingBankMs =
      (options.startingBankSeconds ?? arena.STARTING_BANK_SECONDS) * 1000;
    this.firstTurnGraceMs =
      (options.firstTurnGraceSeconds ?? arena.FIRST_TURN_GRACE_SECONDS) * 1000;
    this.maxTurnMs = (options.maxTurnSeconds ?? arena.MAX_TURN_SECONDS) * 1000;
    this.fullTurnIncrementMs = arena.turnIncrementSeconds(options.format) * 1000;
    this.midTurnIncrementMs = arena.MID_TURN_INCREMENT_SECONDS * 1000;
    this.byotBudgetMs = options.byotBudgetMs ?? 15_000;
    this.onSpectatorChunk = options.onSpectatorChunk;

    this.battleStream = new BattleStreams.BattleStream();
    this.streams = BattleStreams.getPlayerStreams(this.battleStream);
  }

  private getSpectatorLines(): string[] {
    return this.omniscientLog.join('\n').split('\n').filter(Boolean);
  }

  private emitSpectatorChunk(rawChunk: string) {
    const publicChunk = this.byot
      ? rawChunk
      : rewriteBlindPlayerNames(rawChunk, this.p1Spec.displayName, this.p2Spec.displayName);
    this.omniscientLog.push(publicChunk);
    this.onSpectatorChunk?.(publicChunk, {
      turn: this.currentTurn,
      p1BankSeconds: Math.max(0, Math.round((this.p1?.bankMs ?? this.startingBankMs) / 1000)),
      p2BankSeconds: Math.max(0, Math.round((this.p2?.bankMs ?? this.startingBankMs) / 1000)),
      p1Thinking: Boolean(this.p1?.thinking),
      p2Thinking: Boolean(this.p2?.thinking),
      lines: this.getSpectatorLines(),
    });
  }

  private spawnRemotePlayer(slot: PlayerSlot, spec: TournamentAgentSpec): RemoteTournamentPlayer {
    if (!/^[A-Za-z0-9._-]+$/.test(spec.agentId)) {
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

    const usesRelay = !spec.localCommand || path.basename(spec.localCommand) === 'tourney-relay';
    const player: RemoteTournamentPlayer = {
      slot,
      spec,
      proc,
      usesRelay,
      reqSeq: 0,
      lineQueue: [],
      lineResolver: undefined,
      localTurnMsQueue: [],
      turnMsWaiter: undefined,
      spotPreempted: false,
      sshDisconnected: false,
      bankMs: this.startingBankMs,
      totalTurnMs: 0,
      decisionsCount: 0,
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
      if (player.turnMsWaiter) {
        const w = player.turnMsWaiter;
        player.turnMsWaiter = undefined;
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

    const errRl = readline.createInterface({input: proc.stderr, crlfDelay: Infinity});
    errRl.on('line', errLine => {
      if (errLine.startsWith('ARENA_TURN_MS=')) {
        const rawVal = errLine.slice('ARENA_TURN_MS='.length).trim();
        const [msStr, seqStr] = rawVal.split('\t');
        const ms = Number(msStr);
        const seq = seqStr !== undefined ? Number(seqStr) : player.reqSeq;
        if (
          Number.isFinite(ms) &&
          ms >= 0 &&
          seq === player.reqSeq &&
          player.localTurnMsQueue.length < MAX_LINE_QUEUE
        ) {
          player.localTurnMsQueue.push(ms);
          if (player.turnMsWaiter) {
            const w = player.turnMsWaiter;
            player.turnMsWaiter = undefined;
            w();
          }
        }
      } else if (errLine.includes('ARENA_SPOT_PREEMPTED')) {
        player.spotPreempted = true;
      }
    });

    proc.on('exit', code => onDisconnect(code));
    proc.on('close', code => onDisconnect(code));
    proc.on('error', () => onDisconnect(255));
    proc.stdin.on('error', () => undefined);

    return player;
  }

  private async takeLocalTurnMs(
    player: RemoteTournamentPlayer,
    line: string | undefined,
    wallMs: number
  ): Promise<number> {
    if (!line || line.length === 0) return wallMs;
    if (player.localTurnMsQueue.length > 0) {
      return player.localTurnMsQueue.shift()!;
    }
    if (player.usesRelay && !player.exited) {
      await new Promise<void>(resolve => {
        const t = setTimeout(() => {
          if (player.turnMsWaiter === wake) player.turnMsWaiter = undefined;
          resolve();
        }, 25);
        const wake = () => {
          clearTimeout(t);
          resolve();
        };
        player.turnMsWaiter = wake;
      });
      if (player.localTurnMsQueue.length > 0) {
        return player.localTurnMsQueue.shift()!;
      }
    }
    return wallMs;
  }

  private async readLineWithTimeout(
    player: RemoteTournamentPlayer,
    budgetMs: number
  ): Promise<{line: string | undefined; elapsedMs: number; timedOut: boolean}> {
    const startNs = process.hrtime.bigint();

    if (player.lineQueue.length > 0) {
      const line = player.lineQueue.shift()!;
      const wallMs = Number(process.hrtime.bigint() - startNs) / 1e6;
      const elapsedMs = await this.takeLocalTurnMs(player, line, wallMs);
      return {line, elapsedMs, timedOut: false};
    }
    if (player.exited) {
      return {line: undefined, elapsedMs: 0, timedOut: false};
    }

    const raw = await new Promise<{line: string | undefined; wallMs: number; timedOut: boolean}>(
      resolve => {
        // Allow +1500 ms network slack on the arbiter timer so local VM clock is authoritative
        const timer = setTimeout(() => {
          player.lineResolver = undefined;
          resolve({line: undefined, wallMs: budgetMs, timedOut: true});
        }, Math.max(1, Math.ceil(budgetMs + 1500)));

        player.lineResolver = line => {
          clearTimeout(timer);
          const wallMs = Number(process.hrtime.bigint() - startNs) / 1e6;
          resolve({line, wallMs, timedOut: false});
        };
      }
    );
    if (raw.timedOut) {
      return {line: undefined, elapsedMs: budgetMs, timedOut: true};
    }
    const elapsedMs = await this.takeLocalTurnMs(player, raw.line, raw.wallMs);
    return {line: raw.line, elapsedMs, timedOut: false};
  }

  private validateOrFallbackTeam(rawTeam: string | undefined, staticFallback?: string): string {
    const validator = new TeamValidator(this.format);
    for (const candidate of [rawTeam, staticFallback]) {
      if (!candidate) continue;
      const sets = Teams.unpack(candidate.trim());
      if (sets && sets.length > 0 && !validator.validateTeam(sets)) {
        return Teams.pack(sets);
      }
    }
    try {
      return Teams.pack(Teams.generate(this.format));
    } catch {
      return synthesizeFallbackPackedTeam(this.format, 0);
    }
  }

  private async negotiateByot(
    player: RemoteTournamentPlayer,
    opponentName: string
  ): Promise<string> {
    player.reqSeq++;
    player.lineQueue.length = 0;
    player.localTurnMsQueue.length = 0;
    if (!player.exited && player.proc.stdin.writable) {
      player.proc.stdin.write(`|tournament|byot|${this.format}|${opponentName}\n`);
    }
    const {line, timedOut} = await this.readLineWithTimeout(player, this.byotBudgetMs);
    if (!timedOut && line?.trim().startsWith('/utm ')) {
      const customTeam = line.trim().slice(5).trim();
      return this.validateOrFallbackTeam(customTeam, player.spec.staticTeam);
    }
    return this.validateOrFallbackTeam(undefined, player.spec.staticTeam);
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
    this.endReason = 'spot_preemption';
    this.wakePendingLineResolvers();
    Promise.resolve(this.battleStream.write('>forcetie')).catch(() => undefined);
  }

  private forceLose(losingSlot: PlayerSlot, reason: string) {
    if (this.ended) return;
    this.ended = true;
    this.winner = losingSlot === 'p1' ? 'p2' : 'p1';
    this.endReason = reason;
    this.wakePendingLineResolvers();
    const winnerSimName = this.byot
      ? (this.winner === 'p1' ? this.p1Spec.displayName : this.p2Spec.displayName)
      : (this.winner === 'p1' ? 'Agent A' : 'Agent B');
    Promise.resolve(this.battleStream.write(`>forcewin ${winnerSimName}`)).catch(() => undefined);
  }

  private async handleDecision(player: RemoteTournamentPlayer, reqJson: string) {
    if (this.ended) return;
    const req = JSON.parse(reqJson) as {teamPreview?: boolean};

    const isRetry = player.retryingInvalidChoice;
    player.retryingInvalidChoice = false;

    if (player.hasTakenFirstDecision && !isRetry) {
      const isNewTurn = this.currentTurn > this.lastRewardedTurn[player.slot];
      const incrementMs = isNewTurn ? this.fullTurnIncrementMs : this.midTurnIncrementMs;
      player.bankMs = Math.min(this.maxTurnMs, player.bankMs + incrementMs);
      this.lastRewardedTurn[player.slot] = this.currentTurn;
    }

    const isFirstDecision = !player.hasTakenFirstDecision;
    if (isFirstDecision) {
      player.hasTakenFirstDecision = true;
      this.lastRewardedTurn[player.slot] = this.currentTurn;
    }
    const graceMs = isFirstDecision ? this.firstTurnGraceMs : 0;
    const turnAllowanceMs = Math.min(player.bankMs, this.maxTurnMs);
    const totalBudgetMs = graceMs + turnAllowanceMs;

    if (!player.exited && player.proc.stdin.writable) {
      const turnSec = (turnAllowanceMs / 1000).toFixed(1);
      const totalSec = (player.bankMs / 1000).toFixed(1);
      const graceSec = (graceMs / 1000).toFixed(1);
      player.proc.stdin.write(
        `|inactive|Time left: ${turnSec} sec this turn | ` +
        `${totalSec} sec total | ${graceSec} sec grace\n`
      );
    }

    let remainingBudgetMs = totalBudgetMs;
    let totalElapsedMs = 0;
    let linesReadThisDecision = 0;
    player.thinking = true;

    try {
      while (!this.ended) {
        const {line, elapsedMs, timedOut} = await this.readLineWithTimeout(
          player,
          remainingBudgetMs
        );
        totalElapsedMs += elapsedMs;
        remainingBudgetMs = totalBudgetMs - totalElapsedMs;

        if (player.spotPreempted || player.sshDisconnected) {
          this.abortForSpotPreemption(player.slot);
          return;
        }
        if (timedOut || remainingBudgetMs < 0) {
          player.bankMs = 0;
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

        const decisionElapsedMs = Math.max(1, Math.ceil(totalElapsedMs));
        const overGraceMs = Math.max(0, decisionElapsedMs - graceMs);
        player.bankMs = Math.max(0, player.bankMs - overGraceMs);
        player.totalTurnMs += decisionElapsedMs;
        player.decisionsCount++;

        const choiceCmd = req.teamPreview && !parsed.choice.startsWith('team ')
          ? `team ${parsed.choice}`
          : parsed.choice;
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

        let actionableReqJson: string | undefined;
        let resendLastRequest = false;
        const lines = chunk.split('\n');
        const chunkHasRequest = lines.some(l => l.startsWith('|request|'));
        for (const line of lines) {
          if (line.startsWith('|request|')) {
            const jsonStr = line.slice('|request|'.length).trim();
            if (jsonStr && jsonStr !== 'null') {
              try {
                const parsed = JSON.parse(jsonStr) as {wait?: boolean};
                if (!parsed.wait) {
                  if (!player.retryingInvalidChoice) {
                    player.invalidStrikes = 0;
                  }
                  actionableReqJson = jsonStr;
                  player.lastRequestJson = jsonStr;
                }
              } catch {}
            }
          } else if (
            (line.startsWith('|error|[Invalid choice]') ||
              line.startsWith('|error|[Unavailable choice]')) &&
            !this.ended
          ) {
            player.invalidStrikes++;
            player.retryingInvalidChoice = true;
            if (player.invalidStrikes >= MAX_INVALID_STRIKES) {
              this.forceLose(player.slot, 'invalid_choice_3x');
            } else if (!chunkHasRequest && player.lastRequestJson) {
              actionableReqJson = player.lastRequestJson;
              resendLastRequest = true;
            }
          }
        }

        if (actionableReqJson) {
          player.reqSeq++;
          player.lineQueue.length = 0;
          player.localTurnMsQueue.length = 0;
        }
        if (!player.exited && player.proc.stdin.writable) {
          player.proc.stdin.write(`${chunk}\n`);
          if (resendLastRequest && player.lastRequestJson) {
            player.proc.stdin.write(`|request|${player.lastRequestJson}\n`);
          }
        }

        if (actionableReqJson && !this.ended) {
          await this.handleDecision(player, actionableReqJson);
        }
      }
    })();
  }

  async run(): Promise<TournamentGameResult> {
    this.p1 = this.spawnRemotePlayer('p1', this.p1Spec);
    this.p2 = this.spawnRemotePlayer('p2', this.p2Spec);

    try {
      let p1Team: string;
      let p2Team: string;

      if (this.byot) {
        [p1Team, p2Team] = await Promise.all([
          this.negotiateByot(this.p1, this.p2Spec.displayName),
          this.negotiateByot(this.p2, this.p1Spec.displayName),
        ]);
      } else {
        p1Team = this.p1TeamPacked ?? this.validateOrFallbackTeam(undefined);
        p2Team = this.p2TeamPacked ?? this.validateOrFallbackTeam(undefined);
        if (!this.p1.exited && this.p1.proc.stdin.writable) {
          this.p1.proc.stdin.write(`|utm|${p1Team}\n`);
        }
        if (!this.p2.exited && this.p2.proc.stdin.writable) {
          this.p2.proc.stdin.write(`|utm|${p2Team}\n`);
        }
      }

      this.p1TeamPacked = p1Team;
      this.p2TeamPacked = p2Team;

      if (
        this.p1.spotPreempted || this.p1.sshDisconnected ||
        this.p2.spotPreempted || this.p2.sshDisconnected
      ) {
        const slot = (this.p1.spotPreempted || this.p1.sshDisconnected) ? 'p1' : 'p2';
        return {
          winner: 'preempted',
          preemptedSlot: slot,
          turns: 0,
          endReason: 'spot_preemption',
          omniscientLog: '',
          p1TeamPacked: p1Team,
          p2TeamPacked: p2Team,
          p1BankSeconds: Math.round(this.startingBankMs / 1000),
          p2BankSeconds: Math.round(this.startingBankMs / 1000),
          p1MeanTurnMillis: 0,
          p2MeanTurnMillis: 0,
        };
      }

      const omniTask = (async () => {
        for await (const rawChunk of this.streams.omniscient) {
          for (const line of rawChunk.split('\n')) {
            if (line.startsWith('|turn|')) {
              this.currentTurn = parseInt(line.slice('|turn|'.length), 10);
              if (
                this.smokeStopAfterTurn !== undefined &&
                this.currentTurn > this.smokeStopAfterTurn &&
                !this.ended
              ) {
                this.ended = true;
                this.winner = 'tie';
                this.endReason = 'smoke_complete';
                await this.battleStream.write('>forcetie');
              } else if (this.currentTurn > this.maxTurns && !this.ended) {
                this.ended = true;
                this.winner = 'tie';
                this.endReason = `tie_${this.maxTurns}_turns`;
                await this.battleStream.write('>forcetie');
              }
            } else if (line.startsWith('|win|')) {
              if (!this.ended) {
                const wName = line.slice('|win|'.length).trim();
                const expectedP1Name = this.byot ? this.p1Spec.displayName : 'Agent A';
                this.winner = wName === expectedP1Name ? 'p1' : 'p2';
                this.endReason = 'win';
                this.ended = true;
              }
            } else if (line === '|tie' || line.startsWith('|tie|')) {
              if (!this.ended) {
                this.winner = 'tie';
                this.endReason = 'tie';
                this.ended = true;
              }
            }
          }
          this.emitSpectatorChunk(rawChunk);
        }
      })();

      const p1Task = this.driveConcurrentPlayer(this.p1, this.streams.p1);
      const p2Task = this.driveConcurrentPlayer(this.p2, this.streams.p2);

      const p1SimName = this.byot ? this.p1Spec.displayName : 'Agent A';
      const p2SimName = this.byot ? this.p2Spec.displayName : 'Agent B';

      await this.battleStream.write(
        `>start ${JSON.stringify({formatid: this.format, seed: this.seed})}`
      );
      await this.battleStream.write(
        `>player p1 ${JSON.stringify({name: p1SimName, team: p1Team})}`
      );
      await this.battleStream.write(
        `>player p2 ${JSON.stringify({name: p2SimName, team: p2Team})}`
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
        omniscientLog: this.omniscientLog.join('\n'),
        p1TeamPacked: p1Team,
        p2TeamPacked: p2Team,
        p1BankSeconds: Math.max(0, Math.round(this.p1.bankMs / 1000)),
        p2BankSeconds: Math.max(0, Math.round(this.p2.bankMs / 1000)),
        p1MeanTurnMillis: this.p1.decisionsCount > 0
          ? Math.max(1, Math.round(this.p1.totalTurnMs / this.p1.decisionsCount))
          : 1,
        p2MeanTurnMillis: this.p2.decisionsCount > 0
          ? Math.max(1, Math.round(this.p2.totalTurnMs / this.p2.decisionsCount))
          : 1,
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

export interface BlindPairTeamEntry {
  team1Packed: string;
  team2Packed: string;
}

function getPackedTeamFourMonCores(packed: string): string[] {
  const sets = Teams.unpack(packed) ?? [];
  const species = sets.map(s => toID(s.species || s.name)).filter(Boolean).sort();
  if (species.length < 4) return [];
  const cores: string[] = [];
  for (let a = 0; a < species.length; a++) {
    for (let b = a + 1; b < species.length; b++) {
      for (let c = b + 1; c < species.length; c++) {
        for (let d = c + 1; d < species.length; d++) {
          cores.push(`${species[a]}|${species[b]}|${species[c]}|${species[d]}`);
        }
      }
    }
  }
  return cores;
}

// Builds a stratified 2M-team blind-pair tournament book (M = Math.floor(gamesPerMatchup / 2))
// from a harvested or canonical packed team pool:
//   - Draws M pairs (T_{2m-1}, T_{2m}) with T_{2m-1} !== T_{2m}
//   - Enforces that no 4-Pokemon species core appears in more than ceil(0.15 * 2M) teams
//     when the pool is large enough, falling back gracefully on small pools.
export function buildStratifiedTournamentBook(
  pool: readonly string[],
  gamesPerMatchup: number,
  randomInt: (max: number) => number
): BlindPairTeamEntry[] {
  if (pool.length < 2) {
    throw new Error('Blind-pair tournament book requires at least 2 teams in the pool');
  }
  const pairCount = Math.max(1, Math.floor(gamesPerMatchup / 2));
  const totalTeamsNeeded = pairCount * 2;
  const maxCoreAllowance = Math.max(1, Math.ceil(0.15 * totalTeamsNeeded));

  const indices = pool.map((_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const tmp = indices[i];
    indices[i] = indices[j];
    indices[j] = tmp;
  }

  const coreCounts = new Map<string, number>();
  const chosen: string[] = [];

  for (const idx of indices) {
    if (chosen.length >= totalTeamsNeeded) break;
    const team = pool[idx];
    const cores = getPackedTeamFourMonCores(team);
    if (cores.some(c => (coreCounts.get(c) ?? 0) >= maxCoreAllowance)) {
      continue;
    }
    chosen.push(team);
    for (const c of cores) {
      coreCounts.set(c, (coreCounts.get(c) ?? 0) + 1);
    }
  }

  // Top up from the shuffled pool if the core cap filtered too aggressively on a small pool
  let cursor = 0;
  while (chosen.length < totalTeamsNeeded) {
    const candidate = pool[indices[cursor % indices.length]];
    cursor++;
    if (chosen.length % 2 === 1 && chosen[chosen.length - 1] === candidate && pool.length >= 2) {
      continue;
    }
    chosen.push(candidate);
  }

  const pairs: BlindPairTeamEntry[] = [];
  for (let m = 0; m < pairCount; m++) {
    const t1 = chosen[2 * m];
    let t2 = chosen[2 * m + 1];
    if (t1 === t2) {
      const alt = pool.find(t => t !== t1);
      if (alt) t2 = alt;
    }
    pairs.push({team1Packed: t1, team2Packed: t2});
  }
  return pairs;
}

export interface TournamentMatchupState {
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
export function selectNextTournamentBatch(
  matchups: readonly TournamentMatchupState[],
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

  let best: TournamentMatchupState | undefined;
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

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

// Unpacks and verifies a `linux/amd64` tournament OCI image into `/opt/arena/agents/<targetId>` on
// GCP using `skopeo` + `umoci` (without requiring a rootful container daemon).
export function unpackTournamentOciRootfs(opts: {
  imageRef: string;
  targetId: string;
  expectedSha256: string;
  authToken?: string;
  agentsDir?: string;
  stagingDir?: string;
}): number {
  if (!/^[A-Za-z0-9._-]+$/.test(opts.targetId)) {
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

    const rootfsDir = path.join(bundleDir, 'rootfs');
    const runPath = path.join(rootfsDir, 'run');
    if (!fs.existsSync(runPath)) {
      const cfgPath = path.join(bundleDir, 'config.json');
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as {
          process?: {cwd?: string; env?: string[]; args?: string[]};
        };
        const procArgs = cfg.process?.args ?? [];
        if (procArgs.length > 0) {
          const lines = ['#!/bin/sh'];
          for (const envEntry of cfg.process?.env ?? []) {
            lines.push(`export ${shellQuote(envEntry)}`);
          }
          lines.push(`cd ${shellQuote(cfg.process?.cwd || '/')}`);
          lines.push(`exec ${procArgs.map(shellQuote).join(' ')} "$@"`);
          fs.writeFileSync(runPath, `${lines.join('\n')}\n`, {mode: 0o755});
        }
      }
    }

    if (!fs.existsSync(runPath)) {
      throw new Error('OCI rootfs is missing executable /run and has no OCI Entrypoint/Cmd');
    }
    fs.chmodSync(runPath, 0o755);

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
      fs.mkdirSync(path.join(rootfsDir, subDir), {recursive: true});
    }
    for (const nvLib of [
      'libcuda.so.1',
      'libnvidia-ml.so.1',
      'libnvidia-ptxjitcompiler.so.1',
    ]) {
      const targetFile = path.join(rootfsDir, 'usr/lib/x86_64-linux-gnu', nvLib);
      if (!fs.existsSync(targetFile)) fs.writeFileSync(targetFile, '');
    }

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

export interface TournamentTableBinding {
  vmHostA: string;
  controlSocketA: string;
  vmHostB: string;
  controlSocketB: string;
}

export interface TournamentCoordinatorOptions {
  client: arena.Client;
  baselineSpec: TournamentAgentSpec;
  agentsDir?: string;
  stagingDir?: string;
  tourneyAgentBin?: string;
  tables?: readonly TournamentTableBinding[];
  superfinalGames?: number;
  maxTurns?: number;
  byot?: boolean;
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
  ) => TournamentAgentSpec;
}

const TOURNAMENT_FAULT_REASONS = new Set(['crash', 'timeout', 'invalid_choice_3x']);

// GCP-side Tournament Coordinator:
//   1. `processPendingSubmissions` pulls & smoke-tests `linux/amd64` tournament OCI submissions on
//      GCP inside `bwrap` (`tourney-agent`) so Mac minis never touch `amd64` tournament artifacts.
//   2. `runTournament` drives crash-resumable Double Round-Robin waves + Superfinal across
//      `parallelTables` with live table broadcasts and immediate `.log` replay publication.
export class TournamentCoordinator {
  readonly client: arena.Client;
  private readonly baselineSpec: TournamentAgentSpec;
  private readonly agentsDir: string;
  private readonly stagingDir: string;
  private readonly tourneyAgentBin: string;
  private readonly tables: readonly TournamentTableBinding[];
  private readonly superfinalGames: number;
  private readonly maxTurns?: number;
  private readonly byot: boolean;
  private readonly randomInt: (max: number) => number;
  private readonly prepareSubmissionRootfs?: (
    sub: arena.PendingSubmission,
    targetId: string
  ) => Promise<number> | number;
  private readonly customResolveEntrantSpec?: TournamentCoordinatorOptions['resolveEntrantSpec'];

  constructor(options: TournamentCoordinatorOptions) {
    this.client = options.client;
    this.baselineSpec = options.baselineSpec;
    this.agentsDir = options.agentsDir ?? '/opt/arena/agents';
    this.stagingDir = options.stagingDir ?? '/tmp';
    this.tourneyAgentBin = options.tourneyAgentBin ?? '/usr/local/bin/tourney-agent';
    this.tables = options.tables ?? [];
    this.superfinalGames = options.superfinalGames ?? 100;
    this.maxTurns = options.maxTurns;
    this.byot = options.byot ?? false;
    this.randomInt = options.randomInt ?? (max => crypto.randomInt(0, max));
    this.prepareSubmissionRootfs = options.prepareSubmissionRootfs;
    this.customResolveEntrantSpec = options.resolveEntrantSpec;
  }

  private randomPrngSeed(): PRNGSeed {
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
  ): TournamentAgentSpec {
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
          : unpackTournamentOciRootfs({
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

        let p1TeamPacked: string;
        let p2TeamPacked: string;
        try {
          const pair = sampleRandomPair(format, '1,2,3,4', '5,6,7,8');
          p1TeamPacked = pair.t1Packed;
          p2TeamPacked = pair.t2Packed;
        } catch {
          p1TeamPacked = synthesizeFallbackPackedTeam(format, 0);
          p2TeamPacked = synthesizeFallbackPackedTeam(format, 1);
        }

        const smokeGame = new ConcurrentTournamentGame({
          format,
          customRules,
          seed: '1,2,3,4',
          p1Spec: candidateSpec,
          p2Spec: this.baselineSpec,
          byot: this.byot,
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
        if (res.p1MeanTurnMillis > maxTurnMillis) maxTurnMillis = res.p1MeanTurnMillis;
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
    book: readonly BlindPairTeamEntry[] | undefined,
    format: string,
    gameIndexZeroBased: number
  ): {p1Team: string; p2Team: string; swappedSeats: boolean} {
    const pairIdx = Math.floor(gameIndexZeroBased / 2);
    const swappedSeats = gameIndexZeroBased % 2 === 1;
    if (book && book.length > 0) {
      const entry = book[pairIdx % book.length];
      return {
        p1Team: entry.team1Packed,
        p2Team: entry.team2Packed,
        swappedSeats,
      };
    }
    try {
      const pair = sampleRandomPair(format, this.randomPrngSeed(), this.randomPrngSeed());
      return {p1Team: pair.t1Packed, p2Team: pair.t2Packed, swappedSeats};
    } catch {
      return {
        p1Team: synthesizeFallbackPackedTeam(format, pairIdx * 2),
        p2Team: synthesizeFallbackPackedTeam(format, pairIdx * 2 + 1),
        swappedSeats,
      };
    }
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
    const totalNeededForBook = Math.max(tourney.gamesPerMatchup, this.superfinalGames);
    const book = state.teamPool.length >= 2
      ? buildStratifiedTournamentBook(state.teamPool, totalNeededForBook, this.randomInt)
      : undefined;
    const incSec = arena.turnIncrementSeconds(tourney.format);

    const rrPlayedByPair = new Map<string, number>();
    const totalGamesByVersion = new Map<number, number>(versionIds.map(v => [v, 0]));
    for (const g of state.games) {
      if (g.stage !== 'Round Robin' || g.outcome === undefined) continue;
      const low = Math.min(g.p1VersionId, g.p2VersionId);
      const high = Math.max(g.p1VersionId, g.p2VersionId);
      const key = `${low}:${high}`;
      rrPlayedByPair.set(key, (rrPlayedByPair.get(key) ?? 0) + 1);
      totalGamesByVersion.set(g.p1VersionId, (totalGamesByVersion.get(g.p1VersionId) ?? 0) + 1);
      totalGamesByVersion.set(g.p2VersionId, (totalGamesByVersion.get(g.p2VersionId) ?? 0) + 1);
    }

    const matchups: TournamentMatchupState[] = [];
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
      const sampled = this.samplePairForGame(book, tourney.format, params.gameIndexZeroBased);
      const p1Ent = sampled.swappedSeats ? params.entB : params.entA;
      const p2Ent = sampled.swappedSeats ? params.entA : params.entB;
      const p1Host = sampled.swappedSeats ? params.vmHostB : params.vmHostA;
      const p1Ctrl = sampled.swappedSeats ? params.controlB : params.controlA;
      const p2Host = sampled.swappedSeats ? params.vmHostA : params.vmHostB;
      const p2Ctrl = sampled.swappedSeats ? params.controlA : params.controlB;

      let preemptions = 0;
      for (;;) {
        const seed = this.randomPrngSeed();
        const p1Spec = this.resolveEntrantSpec(p1Ent, p1Host, p1Ctrl);
        const p2Spec = this.resolveEntrantSpec(p2Ent, p2Host, p2Ctrl);

        await this.client.sendTournamentBroadcast(tournamentId, {
          table: params.tableNum,
          mode: 'load',
          label: `Table ${params.tableNum}`,
          gameId: params.gameId,
          stage: params.stage,
          cycle: params.cycle,
          matchupGame: params.matchupGame,
          p1: {
            slug: p1Ent.agentSlug,
            name: p1Ent.agentName,
            version: p1Ent.version,
            bankSeconds: arena.STARTING_BANK_SECONDS,
            thinking: true,
            incrementSeconds: incSec,
          },
          p2: {
            slug: p2Ent.agentSlug,
            name: p2Ent.agentName,
            version: p2Ent.version,
            bankSeconds: arena.STARTING_BANK_SECONDS,
            thinking: true,
            incrementSeconds: incSec,
          },
          lines: [],
          live: true,
        }).catch(() => undefined);

        const game = new ConcurrentTournamentGame({
          format: tourney.format,
          customRules: tourney.customRules,
          seed,
          p1Spec,
          p2Spec,
          byot: this.byot,
          p1TeamPacked: sampled.p1Team,
          p2TeamPacked: sampled.p2Team,
          maxTurns: this.maxTurns,
          onSpectatorChunk: (chunk, snap) => {
            const newLines = chunk.split('\n').filter(Boolean);
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
                incrementSeconds: incSec,
              },
              p2: {
                slug: p2Ent.agentSlug,
                name: p2Ent.agentName,
                version: p2Ent.version,
                bankSeconds: snap.p2BankSeconds,
                thinking: snap.p2Thinking,
                incrementSeconds: incSec,
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
          log: res.omniscientLog,
          ...(statusUpdate ? {tournamentStatus: statusUpdate} : {}),
          game: {
            id: params.gameId,
            stage: params.stage,
            cycle: params.cycle,
            matchupGame: params.matchupGame,
            p1VersionId: p1Ent.versionId,
            p2VersionId: p2Ent.versionId,
            seed,
            preemptions,
            p1Team: res.p1TeamPacked,
            p2Team: res.p2TeamPacked,
            outcome: res.outcome,
            turns: res.turns,
            endReason: res.endReason,
            p1BankSeconds: res.p1BankSeconds,
            p2BankSeconds: res.p2BankSeconds,
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
        const batch = selectNextTournamentBatch(
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
