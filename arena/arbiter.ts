import {ChildProcessWithoutNullStreams, execFileSync, spawn} from 'child_process';
import * as fs from 'fs';

import {BattleStreams, PRNGSeed} from '@pkmn/sim';

import * as arena from '../server/arena';
import {filterPlayerProtocolChunk, parseAgentStdoutLine} from '../server/protocol';
import {GameOutcome} from '../server/ratings';
import {ensureSimConfigured, resolveArenaFormatId} from '../server/teams';

import * as db from './db';

ensureSimConfigured();

type PlayerSlot = 'p1' | 'p2';

export interface AgentLaunchSpec {
  mode: db.ExecutionMode;
  target: string; // OCI image tag for 'container', or bundle directory/path for 'native'
  args?: string[];
  env?: Record<string, string>;
}

export interface TurnHeartbeatInfo {
  turn: number;
  activeSlot: PlayerSlot;
  turnStartedAt: number;
  turnBudgetSeconds: number;
  incrementSeconds: number;
  p1BankSeconds: number;
  p2BankSeconds: number;
  p1LastTurnMillis: number;
  p2LastTurnMillis: number;
  p1MeanTurnMillis: number;
  p2MeanTurnMillis: number;
}

export interface ArenaGameOptions {
  format: string;
  customRules?: readonly string[];
  seed: PRNGSeed;
  p1Spec: AgentLaunchSpec;
  p2Spec: AgentLaunchSpec;
  p1TeamPacked?: string;
  p2TeamPacked?: string;
  maxTurns?: number;
  smokeStopAfterTurn?: number;
  startingBankSeconds?: number;
  firstTurnGraceSeconds?: number;
  maxTurnSeconds?: number;
  devMode?: boolean;
  arenaBin?: string;
  onTurn?: (info: TurnHeartbeatInfo) => Promise<void> | void;
}

export interface ArenaGameResult {
  winner: PlayerSlot | 'tie';
  outcome: GameOutcome; // From P1's perspective: 'W' | 'L' | 'T'
  turns: number;
  endReason: string;
  omniscientLog: string;
  p1BankSeconds: number;
  p2BankSeconds: number;
  p1PeakRam: number;
  p2PeakRam: number;
  p1MeanTurnMillis: number;
  p2MeanTurnMillis: number;
  p1LastTurnMillis: number;
  p2LastTurnMillis: number;
}

interface SandboxedPlayer {
  slot: PlayerSlot;
  spec: AgentLaunchSpec;
  proc: ChildProcessWithoutNullStreams;
  lineQueue: string[];
  lineResolver: ((line: string | undefined) => void) | undefined;
  bankMillis: number;
  hasTakenFirstDecision: boolean;
  retryingInvalidChoice: boolean;
  invalidStrikes: number;
  pendingRequestJson: string | undefined;
  lastRequestJson: string | undefined;
  decisionCount: number;
  totalDecisionMillis: number;
  lastDecisionMillis: number;
  exited: boolean;
  exitCode: number | undefined;
}

export const MAX_INVALID_STRIKES = 3;
export const MAX_STDOUT_LINE_CHARS = 65_536;
export const MAX_LINE_QUEUE = 256;
export const MAX_LINES_PER_DECISION = 64;

export interface ProtocolStrikeState {
  retryingInvalidChoice: boolean;
  invalidStrikes: number;
  lastRequestJson: string | undefined;
}

export interface ChunkInspectionResult {
  actionableReqJson?: string;
  clearQueue: boolean;
  resendLastRequest: boolean;
  forfeitedInvalidChoice: boolean;
}

export function inspectPlayerProtocolChunk(
  chunk: string,
  state: ProtocolStrikeState,
  ended: boolean
): ChunkInspectionResult {
  const lines = chunk.split('\n');
  const chunkHasRequest = lines.some(l => l.startsWith('|request|'));
  let actionableReqJson: string | undefined;
  let clearQueue = false;
  let resendLastRequest = false;
  let forfeitedInvalidChoice = false;

  for (const line of lines) {
    if (line.startsWith('|request|')) {
      const reqJson = line.slice('|request|'.length).trim();
      if (reqJson && reqJson !== 'null') {
        try {
          const parsed = JSON.parse(reqJson) as {wait?: boolean};
          if (!parsed.wait) {
            clearQueue = true;
            if (!state.retryingInvalidChoice) {
              state.invalidStrikes = 0;
            }
            actionableReqJson = reqJson;
            state.lastRequestJson = reqJson;
          }
        } catch {}
      }
    } else if (
      (line.startsWith('|error|[Invalid choice]') ||
        line.startsWith('|error|[Unavailable choice]')) &&
      !ended
    ) {
      state.invalidStrikes++;
      state.retryingInvalidChoice = true;
      if (state.invalidStrikes >= MAX_INVALID_STRIKES) {
        forfeitedInvalidChoice = true;
      } else if (!chunkHasRequest && state.lastRequestJson) {
        clearQueue = true;
        resendLastRequest = true;
        actionableReqJson = state.lastRequestJson;
      }
    }
  }

  return {actionableReqJson, clearQueue, resendLastRequest, forfeitedInvalidChoice};
}

export interface PlayerClockState {
  slot: PlayerSlot;
  bankMillis: number;
  hasTakenFirstDecision: boolean;
  retryingInvalidChoice: boolean;
}

export function beginTurnClockStep(
  player: PlayerClockState,
  currentTurn: number,
  lastRewardedTurn: Record<PlayerSlot, number>,
  timers: {
    firstTurnGraceMillis: number;
    maxTurnMillis: number;
    fullTurnIncrementMillis: number;
    midTurnIncrementMillis: number;
  }
): {
  graceMillis: number;
  turnAllowanceMillis: number;
  totalBudgetMillis: number;
  inactiveLine: string;
} {
  const isRetry = player.retryingInvalidChoice;
  player.retryingInvalidChoice = false;

  // Credit full-turn or mid-turn increment before starting the turn clock,
  // except when retrying after an invalid/unavailable choice on the same decision.
  if (player.hasTakenFirstDecision && !isRetry) {
    const isNewTurn = currentTurn > lastRewardedTurn[player.slot];
    const incrementMillis = isNewTurn
      ? timers.fullTurnIncrementMillis
      : timers.midTurnIncrementMillis;
    player.bankMillis = Math.min(timers.maxTurnMillis, player.bankMillis + incrementMillis);
    lastRewardedTurn[player.slot] = currentTurn;
  }

  const isFirstDecision = !player.hasTakenFirstDecision;
  if (isFirstDecision) {
    player.hasTakenFirstDecision = true;
    lastRewardedTurn[player.slot] = currentTurn;
  }
  const graceMillis = isFirstDecision ? timers.firstTurnGraceMillis : 0;
  const turnAllowanceMillis = Math.min(player.bankMillis, timers.maxTurnMillis);
  const totalBudgetMillis = graceMillis + turnAllowanceMillis;
  const turnSeconds = (turnAllowanceMillis / 1000).toFixed(1);
  const totalSeconds = (player.bankMillis / 1000).toFixed(1);
  const graceSeconds = (graceMillis / 1000).toFixed(1);
  const inactiveLine =
    `|inactive|Time left: ${turnSeconds} sec this turn | ` +
    `${totalSeconds} sec total | ${graceSeconds} sec grace\n`;

  return {graceMillis, turnAllowanceMillis, totalBudgetMillis, inactiveLine};
}

export function formatChoiceCommand(choice: string, teamPreview?: boolean): string {
  return teamPreview && !choice.startsWith('team ') ? `team ${choice}` : choice;
}

export function inspectOmniscientLine(
  line: string,
  opts: {
    currentTurn: number;
    maxTurns: number;
    smokeStopAfterTurn?: number;
    ended: boolean;
    expectedP1Name: string;
  }
): {
  currentTurn: number;
  terminal?: {
    winner: PlayerSlot | 'tie';
    endReason: string;
    forceTie?: boolean;
  };
} {
  if (line.startsWith('|turn|')) {
    const nextTurn = parseInt(line.slice('|turn|'.length), 10);
    if (
      opts.smokeStopAfterTurn !== undefined &&
      nextTurn > opts.smokeStopAfterTurn &&
      !opts.ended
    ) {
      return {
        currentTurn: nextTurn,
        terminal: {winner: 'tie', endReason: 'smoke-complete', forceTie: true},
      };
    }
    if (nextTurn > opts.maxTurns && !opts.ended) {
      return {
        currentTurn: nextTurn,
        terminal: {winner: 'tie', endReason: `tie-${opts.maxTurns}-turns`, forceTie: true},
      };
    }
    return {currentTurn: nextTurn};
  }
  if (line.startsWith('|win|') && !opts.ended) {
    const wName = line.slice('|win|'.length).trim();
    return {
      currentTurn: opts.currentTurn,
      terminal: {
        winner: wName === opts.expectedP1Name ? 'p1' : 'p2',
        endReason: 'win',
      },
    };
  }
  if ((line === '|tie' || line.startsWith('|tie|')) && !opts.ended) {
    return {
      currentTurn: opts.currentTurn,
      terminal: {winner: 'tie', endReason: 'tie'},
    };
  }
  return {currentTurn: opts.currentTurn};
}

export class TimeSlicedArenaGame {
  private readonly format: string;
  private readonly seed: PRNGSeed;
  private readonly p1Spec: AgentLaunchSpec;
  private readonly p2Spec: AgentLaunchSpec;
  private readonly p1TeamPacked?: string;
  private readonly p2TeamPacked?: string;
  private readonly maxTurns: number;
  private readonly smokeStopAfterTurn?: number;
  private readonly startingBankMillis: number;
  private readonly firstTurnGraceMillis: number;
  private readonly maxTurnMillis: number;
  private readonly fullTurnIncrementMillis: number;
  private readonly midTurnIncrementMillis: number;
  private readonly devMode: boolean;
  private readonly arenaBin: string;
  private readonly onTurn?: (info: TurnHeartbeatInfo) => Promise<void> | void;

  private readonly battleStream: BattleStreams.BattleStream;
  private readonly streams: ReturnType<typeof BattleStreams.getPlayerStreams>;
  private readonly omniscientLog: string[] = [];

  private p1!: SandboxedPlayer;
  private p2!: SandboxedPlayer;
  private currentTurn = 0;
  private lastRewardedTurn: Record<PlayerSlot, number> = {p1: -1, p2: -1};
  private ended = false;
  private winner: PlayerSlot | 'tie' = 'tie';
  private endReason = 'normal';

  constructor(options: ArenaGameOptions) {
    this.format = resolveArenaFormatId(options.format, options.customRules);
    this.seed = options.seed;
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
    this.devMode = options.devMode ?? process.env.ARENA_DEV === '1';
    this.arenaBin = options.arenaBin ?? '/opt/arena/bin/arena';
    this.onTurn = options.onTurn;

    this.battleStream = new BattleStreams.BattleStream();
    this.streams = BattleStreams.getPlayerStreams(this.battleStream);
  }

  private spawnPlayer(slot: PlayerSlot, spec: AgentLaunchSpec): SandboxedPlayer {
    let proc: ChildProcessWithoutNullStreams;

    if (this.devMode) {
      if (spec.mode === 'container') {
        proc = spawn('podman', [
          'run', '--rm', '-i', '--name', `arena-dev-${slot}-${process.pid}`,
          '--network=none', ...(spec.args ?? []), spec.target,
        ], {stdio: ['pipe', 'pipe', 'pipe']});
      } else {
        proc = spawn(spec.target, spec.args ?? [], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {...process.env, ...spec.env, ARENA_SLOT: slot},
        });
      }
    } else {
      proc = spawn(this.arenaBin, ['run', slot, spec.mode, spec.target], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }

    const player: SandboxedPlayer = {
      slot,
      spec,
      proc,
      lineQueue: [],
      lineResolver: undefined,
      bankMillis: this.startingBankMillis,
      hasTakenFirstDecision: false,
      retryingInvalidChoice: false,
      invalidStrikes: 0,
      pendingRequestJson: undefined,
      lastRequestJson: undefined,
      decisionCount: 0,
      totalDecisionMillis: 0,
      lastDecisionMillis: 0,
      exited: false,
      exitCode: undefined,
    };

    const closeWaiter = (code?: number | null) => {
      player.exited = true;
      if (code !== undefined && code !== null) {
        player.exitCode = code;
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
        closeWaiter(1);
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

    proc.on('exit', code => closeWaiter(code));
    proc.on('close', code => closeWaiter(code));
    proc.on('error', () => closeWaiter(1));

    // Drain stderr without blocking the child pipe buffer
    proc.stderr.on('data', () => undefined);
    // Ignore EPIPE on stdin if child exits mid-write
    proc.stdin.on('error', () => undefined);

    this.pauseSlot(player);
    return player;
  }

  private pauseSlot(player: SandboxedPlayer) {
    if (player.exited) return;
    if (this.devMode) {
      if (player.spec.mode === 'container') {
        try {
          execFileSync('podman', ['pause', `arena-dev-${player.slot}-${process.pid}`], {
            stdio: 'ignore',
          });
        } catch {}
      } else if (player.proc.pid) {
        try {
          process.kill(player.proc.pid, 'SIGSTOP');
        } catch {}
      }
      return;
    }
    try {
      execFileSync(this.arenaBin, ['pause', player.slot, player.spec.mode], {stdio: 'ignore'});
    } catch {}
  }

  private resumeSlot(player: SandboxedPlayer) {
    if (player.exited) return;
    if (this.devMode) {
      if (player.spec.mode === 'container') {
        try {
          execFileSync('podman', ['unpause', `arena-dev-${player.slot}-${process.pid}`], {
            stdio: 'ignore',
          });
        } catch {}
      } else if (player.proc.pid) {
        try {
          process.kill(player.proc.pid, 'SIGCONT');
        } catch {}
      }
      return;
    }
    try {
      execFileSync(this.arenaBin, ['resume', player.slot, player.spec.mode], {stdio: 'ignore'});
    } catch {}
  }

  private cleanupSlot(player: SandboxedPlayer | undefined) {
    if (!player) return;
    if (this.devMode) {
      if (player.spec.mode === 'container') {
        const containerName = `arena-dev-${player.slot}-${process.pid}`;
        try {
          execFileSync('podman', ['rm', '-f', '-t', '0', containerName], {
            stdio: 'ignore',
          });
        } catch {}
      } else if (player.proc.pid) {
        // Queue SIGKILL while the process is still SIGSTOP-paused before sending SIGCONT so it
        // terminates immediately upon waking without a user-space execution window.
        try {
          process.kill(player.proc.pid, 'SIGKILL');
        } catch {}
        try {
          process.kill(player.proc.pid, 'SIGCONT');
        } catch {}
      }
      return;
    }
    try {
      execFileSync(this.arenaBin, ['cleanup', player.slot, player.spec.mode], {stdio: 'ignore'});
    } catch {}
  }

  private async stopPlayerForRamRead(player: SandboxedPlayer | undefined) {
    if (!player || player.exited || !player.proc.pid) return;
    try {
      player.proc.stdin.end();
    } catch {}
    if (!this.devMode && player.spec.mode === 'native') {
      try {
        execFileSync('sudo', ['-n', '/usr/bin/killall', '-9', '-u', player.slot], {
          stdio: 'ignore',
        });
      } catch {}
    } else if (!this.devMode && player.spec.mode === 'container') {
      try {
        const containerName = `arena-${player.slot}`;
        const raw = execFileSync(
          'podman',
          ['exec', containerName, 'cat', '/sys/fs/cgroup/memory.peak'],
          {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000}
        ).trim();
        const peakBytes = Number(raw);
        if (Number.isFinite(peakBytes) && peakBytes > 0) {
          fs.writeFileSync(
            `/opt/arena/state/peak_ram_${player.slot}`,
            `${Math.ceil(peakBytes / (1024 * 1024))}\n`
          );
        }
      } catch {}
      try {
        process.kill(player.proc.pid, 'SIGTERM');
      } catch {}
    } else {
      try {
        process.kill(player.proc.pid, 'SIGTERM');
      } catch {}
    }
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 150);
      player.proc.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private readPeakRam(player: SandboxedPlayer): number {
    if (!this.devMode) {
      const stateFile = `/opt/arena/state/peak_ram_${player.slot}`;
      try {
        if (fs.existsSync(stateFile)) {
          const val = Number(fs.readFileSync(stateFile, 'utf8').trim());
          if (Number.isFinite(val) && val > 0) return Math.round(val);
        }
      } catch {}
    }
    return 64;
  }

  private readLineWithTimeout(
    player: SandboxedPlayer,
    budgetMillis: number
  ): Promise<{line: string | undefined; elapsedMillis: number; timedOut: boolean}> {
    const startNs = process.hrtime.bigint();

    if (player.lineQueue.length > 0) {
      const line = player.lineQueue.shift()!;
      const elapsedMillis = Number(process.hrtime.bigint() - startNs) / 1e6;
      return Promise.resolve({line, elapsedMillis, timedOut: false});
    }
    if (player.exited) {
      const elapsedMillis = Number(process.hrtime.bigint() - startNs) / 1e6;
      return Promise.resolve({line: undefined, elapsedMillis, timedOut: false});
    }

    return new Promise(resolve => {
      const timer = setTimeout(() => {
        player.lineResolver = undefined;
        const elapsedMillis = Number(process.hrtime.bigint() - startNs) / 1e6;
        resolve({line: undefined, elapsedMillis, timedOut: true});
      }, Math.max(1, Math.ceil(budgetMillis)));

      player.lineResolver = line => {
        clearTimeout(timer);
        const elapsedMillis = Number(process.hrtime.bigint() - startNs) / 1e6;
        resolve({line, elapsedMillis, timedOut: false});
      };
    });
  }

  private forwardStream(player: SandboxedPlayer, stream: AsyncIterable<string>) {
    void (async () => {
      for await (const rawChunk of stream) {
        const chunk = filterPlayerProtocolChunk(rawChunk);
        if (!chunk) continue;

        const inspected = inspectPlayerProtocolChunk(chunk, player, this.ended);
        if (inspected.actionableReqJson) {
          player.pendingRequestJson = inspected.actionableReqJson;
        }
        if (inspected.forfeitedInvalidChoice) {
          this.forceLose(player.slot, 'invalid-choice');
        }
        if (inspected.clearQueue) {
          player.lineQueue.length = 0;
        }
        if (!player.exited && player.proc.stdin.writable) {
          player.proc.stdin.write(`${chunk}\n`);
          if (inspected.resendLastRequest && player.lastRequestJson) {
            player.proc.stdin.write(`|request|${player.lastRequestJson}\n`);
          }
        }
      }
    })().catch(() => undefined);
  }

  private forceLose(losingSlot: PlayerSlot, reason: string) {
    if (this.ended) return;
    this.ended = true;
    this.winner = losingSlot === 'p1' ? 'p2' : 'p1';
    this.endReason = reason;
    const winnerName = this.winner === 'p1' ? 'Agent A' : 'Agent B';
    Promise.resolve(this.battleStream.write(`>forcewin ${winnerName}`)).catch(() => undefined);
  }

  private async stepPlayerDecision(player: SandboxedPlayer): Promise<boolean> {
    if (!player.pendingRequestJson || this.ended) return false;

    const req = JSON.parse(player.pendingRequestJson) as {
      teamPreview?: boolean;
      active?: unknown;
      forceSwitch?: unknown;
    };
    player.pendingRequestJson = undefined;

    const {graceMillis, totalBudgetMillis, inactiveLine} = beginTurnClockStep(
      player,
      this.currentTurn,
      this.lastRewardedTurn,
      {
        firstTurnGraceMillis: this.firstTurnGraceMillis,
        maxTurnMillis: this.maxTurnMillis,
        fullTurnIncrementMillis: this.fullTurnIncrementMillis,
        midTurnIncrementMillis: this.midTurnIncrementMillis,
      }
    );

    if (!player.exited && player.proc.stdin.writable) {
      player.proc.stdin.write(inactiveLine);
    }

    if (this.onTurn) {
      await this.onTurn({
        turn: this.currentTurn,
        activeSlot: player.slot,
        turnStartedAt: Math.floor(Date.now() / 1000),
        turnBudgetSeconds: Math.round(totalBudgetMillis / 1000),
        incrementSeconds: Math.round(this.fullTurnIncrementMillis / 1000),
        p1BankSeconds: Math.max(0, Math.round(this.p1.bankMillis / 1000)),
        p2BankSeconds: Math.max(0, Math.round(this.p2.bankMillis / 1000)),
        p1LastTurnMillis: Math.round(this.p1.lastDecisionMillis),
        p2LastTurnMillis: Math.round(this.p2.lastDecisionMillis),
        p1MeanTurnMillis: this.p1.decisionCount > 0
          ? Math.round(this.p1.totalDecisionMillis / this.p1.decisionCount)
          : 0,
        p2MeanTurnMillis: this.p2.decisionCount > 0
          ? Math.round(this.p2.totalDecisionMillis / this.p2.decisionCount)
          : 0,
      });
    }

    let remainingBudgetMillis = totalBudgetMillis;
    let totalElapsedThisDecisionMillis: number;
    let linesReadThisDecision = 0;
    this.resumeSlot(player);
    const decisionStartNs = process.hrtime.bigint();

    try {
      while (!this.ended) {
        const {line, timedOut} = await this.readLineWithTimeout(
          player,
          remainingBudgetMillis
        );
        totalElapsedThisDecisionMillis = Number(process.hrtime.bigint() - decisionStartNs) / 1e6;
        remainingBudgetMillis = totalBudgetMillis - totalElapsedThisDecisionMillis;

        if (timedOut || remainingBudgetMillis <= 0) {
          player.bankMillis = 0;
          this.forceLose(player.slot, 'timeout');
          return false;
        }
        if (line === undefined) {
          const reason = player.exitCode === 137 ? 'oom' : 'crash';
          this.forceLose(player.slot, reason);
          return false;
        }

        linesReadThisDecision++;
        if (linesReadThisDecision > MAX_LINES_PER_DECISION) {
          this.forceLose(player.slot, 'crash');
          return false;
        }

        const parsed = parseAgentStdoutLine(line);
        if (!parsed || parsed.kind === 'chat') continue;

        const decisionElapsedMillis = Math.max(1, Math.ceil(totalElapsedThisDecisionMillis));
        const overGraceMillis = Math.max(0, decisionElapsedMillis - graceMillis);
        player.bankMillis = Math.max(0, player.bankMillis - overGraceMillis);
        player.decisionCount++;
        player.lastDecisionMillis = decisionElapsedMillis;
        player.totalDecisionMillis += decisionElapsedMillis;

        const choiceCmd = formatChoiceCommand(parsed.choice, req.teamPreview);
        await this.battleStream.write(`>${player.slot} ${choiceCmd}`);
        return true;
      }
      return false;
    } finally {
      this.pauseSlot(player);
    }
  }

  async run(): Promise<ArenaGameResult> {
    this.p1 = this.spawnPlayer('p1', this.p1Spec);
    this.p2 = this.spawnPlayer('p2', this.p2Spec);

    try {
      if (this.p1TeamPacked && this.p1.proc.stdin.writable) {
        this.p1.proc.stdin.write(`|utm|${this.p1TeamPacked}\n`);
      }
      if (this.p2TeamPacked && this.p2.proc.stdin.writable) {
        this.p2.proc.stdin.write(`|utm|${this.p2TeamPacked}\n`);
      }

      this.forwardStream(this.p1, this.streams.p1);
      this.forwardStream(this.p2, this.streams.p2);

      const omniTask = (async () => {
        for await (const chunk of this.streams.omniscient) {
          this.omniscientLog.push(chunk);
          for (const line of chunk.split('\n')) {
            const step = inspectOmniscientLine(line, {
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
        }
      })();

      const startSpec = JSON.stringify({formatid: this.format, seed: this.seed});
      const p1PlayerSpec = JSON.stringify({name: 'Agent A', team: this.p1TeamPacked});
      const p2PlayerSpec = JSON.stringify({name: 'Agent B', team: this.p2TeamPacked});

      await this.battleStream.write(`>start ${startSpec}`);
      await this.battleStream.write(`>player p1 ${p1PlayerSpec}`);
      await this.battleStream.write(`>player p2 ${p2PlayerSpec}`);

      let idleSpins = 0;
      while (!this.ended) {
        if (this.p1.pendingRequestJson) {
          idleSpins = 0;
          await this.stepPlayerDecision(this.p1);
        } else if (this.p2.pendingRequestJson) {
          idleSpins = 0;
          await this.stepPlayerDecision(this.p2);
        } else {
          idleSpins++;
          if (idleSpins > 2500) {
            this.ended = true;
            this.winner = 'tie';
            this.endReason = 'arbiter-stall';
            break;
          }
          await new Promise(r => setTimeout(r, 2));
        }
      }

      await omniTask;
      await Promise.all([
        this.stopPlayerForRamRead(this.p1),
        this.stopPlayerForRamRead(this.p2),
      ]);
      const p1PeakRam = this.readPeakRam(this.p1);
      const p2PeakRam = this.readPeakRam(this.p2);
      const outcome: GameOutcome =
        this.winner === 'p1' ? 'W' : this.winner === 'p2' ? 'L' : 'T';

      return {
        winner: this.winner,
        outcome,
        turns: this.currentTurn,
        endReason: this.endReason,
        omniscientLog: this.omniscientLog.join('\n'),
        p1BankSeconds: Math.max(0, Math.round(this.p1.bankMillis / 1000)),
        p2BankSeconds: Math.max(0, Math.round(this.p2.bankMillis / 1000)),
        p1PeakRam,
        p2PeakRam,
        p1MeanTurnMillis: this.p1.decisionCount > 0
          ? Math.round(this.p1.totalDecisionMillis / this.p1.decisionCount)
          : 0,
        p2MeanTurnMillis: this.p2.decisionCount > 0
          ? Math.round(this.p2.totalDecisionMillis / this.p2.decisionCount)
          : 0,
        p1LastTurnMillis: Math.round(this.p1.lastDecisionMillis),
        p2LastTurnMillis: Math.round(this.p2.lastDecisionMillis),
      };
    } finally {
      this.cleanupSlot(this.p1);
      this.cleanupSlot(this.p2);
    }
  }
}
