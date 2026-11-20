import {ChildProcessWithoutNullStreams, execFileSync, spawn} from 'child_process';
import * as fs from 'fs';

import type {PRNGSeed} from '@pkmn/sim';

import {SIM_VERSION} from '../db/ladders';
import * as arena from '../server/arena';
import {filterPlayerProtocolChunk, parseAgentStdoutLine} from '../server/protocol';
import {GameOutcome} from '../server/ratings';
import * as sim from '../server/sim';

import * as db from './db';

type PlayerSlot = 'p1' | 'p2';

export interface AgentLaunchSpec {
  mode: db.ExecutionMode;
  target: string; // OCI image tag for 'container', or bundle directory/path for 'native'
  args?: string[];
  env?: Record<string, string>;
}

export interface TurnSlotInfo {
  bankSeconds: number;
  ram: number;
  initMillis?: number;
  teamPreviewMillis?: number;
  lastTurnMillis: number;
  meanTurnMillis: number;
  pokemon?: unknown[];
}

export interface TurnHeartbeatInfo {
  phase?: arena.LivePhase;
  turn: number;
  activeSlot: PlayerSlot;
  turnStartedAt: number;
  turnBudgetSeconds: number;
  incrementSeconds: number;
  omniscientLog: string;
  p1: TurnSlotInfo;
  p2: TurnSlotInfo;
}

export interface TimerOverrides {
  startingBankSeconds?: number;
  graceSeconds?: number;
  maxTurnSeconds?: number;
  maxFirstTurnSeconds?: number;
}

export interface ResolvedClockTimers {
  startingBankMillis: number;
  graceMillis: number;
  maxTurnMillis: number;
  maxFirstTurnMillis: number;
  fullTurnIncrementMillis: number;
  midTurnIncrementMillis: number;
  timeoutAutoChoose: boolean;
  accelerate: boolean;
}

export function resolveClockTimers(
  settings: arena.TimerSettings,
  overrides?: TimerOverrides
): ResolvedClockTimers {
  const startingSeconds = overrides?.startingBankSeconds ?? settings.startingSeconds;
  const graceSeconds = overrides?.graceSeconds ??
    (overrides?.startingBankSeconds !== undefined ? 0 : settings.graceSeconds);
  const maxTurnSeconds = overrides?.maxTurnSeconds ?? settings.maxPerTurnSeconds;
  const maxFirstTurnSeconds = overrides?.maxFirstTurnSeconds ?? (
    overrides?.maxTurnSeconds !== undefined
      ? Math.min(overrides.maxTurnSeconds, settings.maxFirstTurnSeconds)
      : settings.maxFirstTurnSeconds
  );
  return {
    startingBankMillis: startingSeconds * 1000,
    graceMillis: graceSeconds * 1000,
    maxTurnMillis: maxTurnSeconds * 1000,
    maxFirstTurnMillis: maxFirstTurnSeconds * 1000,
    fullTurnIncrementMillis: settings.addPerTurnSeconds * 1000,
    midTurnIncrementMillis: settings.midTurnIncrementSeconds * 1000,
    timeoutAutoChoose: settings.timeoutAutoChoose,
    accelerate: settings.accelerate,
  };
}

export interface ArenaGameOptions {
  format: string;
  version?: string;
  seed: PRNGSeed;
  p1Spec: AgentLaunchSpec;
  p2Spec: AgentLaunchSpec;
  p1TeamPacked?: string;
  p2TeamPacked?: string;
  sendUtm?: boolean;
  maxTurns?: number;
  smokeStopAfterTurn?: number;
  startingBankSeconds?: number;
  graceSeconds?: number;
  readyGraceSeconds?: number;
  maxTurnSeconds?: number;
  maxFirstTurnSeconds?: number;
  devMode?: boolean;
  onTurn?: (info: TurnHeartbeatInfo) => Promise<void> | void;
}

export interface PlayerGameResult {
  bankSeconds: number;
  peakRam: number;
  initMillis: number;
  teamPreviewMillis?: number;
  meanTurnMillis: number;
  lastTurnMillis: number;
  pokemon?: unknown[];
  exitCode?: number;
  stderr?: string;
}

export interface ArenaGameResult {
  winner: PlayerSlot | 'tie';
  outcome: GameOutcome; // From P1's perspective: 'W' | 'L' | 'T'
  turns: number;
  endReason: string;
  omniscientLog: string;
  p1: PlayerGameResult;
  p2: PlayerGameResult;
}

interface SandboxedPlayer {
  slot: PlayerSlot;
  spec: AgentLaunchSpec;
  proc: ChildProcessWithoutNullStreams;
  lineQueue: string[];
  lineResolver: ((line: string | undefined) => void) | undefined;
  bankMillis: number;
  turnRemainingMillis: number | undefined;
  hasTakenFirstDecision: boolean;
  retryingInvalidChoice: boolean;
  invalidStrikes: number;
  pendingRequestJson: string | undefined;
  lastRequestJson: string | undefined;
  initMillis: number;
  teamPreviewCount: number;
  totalTeamPreviewMillis: number;
  turnDecisionCount: number;
  totalTurnDecisionMillis: number;
  lastDecisionMillis: number;
  stderrTail: string;
  exited: boolean;
  exitCode: number | undefined;
  cleanedUp: boolean;
}

export const MAX_INVALID_STRIKES = 3;
export const MAX_STDOUT_LINE_CHARS = 65_536;
export const MAX_LINE_QUEUE = 256;
export const MAX_LINES_PER_DECISION = 64;
const MAX_STDERR_TAIL_CHARS = 4_096;
const ARENA_BIN = '/opt/arena/bin/arena';

const BLIND_NAME_RE = new RegExp(
  '(\\|player\\|p1\\|Agent A\\||\\|player\\|p2\\|Agent B\\||' +
    '\\|win\\|Agent A\\b|\\|win\\|Agent B\\b|☆Agent A\\||☆Agent B\\|)',
  'g'
);

export function rewriteBlindPlayerNames(
  chunk: string,
  p1DisplayName: string,
  p2DisplayName: string
): string {
  return chunk.replace(BLIND_NAME_RE, token => {
    switch (token) {
      case '|player|p1|Agent A|':
        return `|player|p1|${p1DisplayName}|`;
      case '|player|p2|Agent B|':
        return `|player|p2|${p2DisplayName}|`;
      case '|win|Agent A':
        return `|win|${p1DisplayName}`;
      case '|win|Agent B':
        return `|win|${p2DisplayName}`;
      case '☆Agent A|':
        return `☆${p1DisplayName}|`;
      case '☆Agent B|':
        return `☆${p2DisplayName}|`;
      default:
        return token;
    }
  });
}

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
    } else if (line.startsWith('|error|[Unavailable choice]') && !ended) {
      // `[Unavailable choice]` reveals hidden battle state (e.g. Encore/Disable/Arena Trap) and
      // `@pkmn/sim` always follows immediately with an updated `|request|` — withhold extra bank
      // increments on the retry, but never count a protocol strike or resend the stale request.
      state.retryingInvalidChoice = true;
      clearQueue = true;
    } else if (line.startsWith('|error|[Invalid choice]') && !ended) {
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
  turnRemainingMillis?: number;
}

export function beginTurnClockStep(
  player: PlayerClockState,
  currentTurn: number,
  lastRewardedTurn: Record<PlayerSlot, number>,
  timers: {
    startingBankMillis?: number;
    maxTurnMillis: number;
    maxFirstTurnMillis?: number;
    fullTurnIncrementMillis: number;
    midTurnIncrementMillis: number;
    accelerate?: boolean;
    requestCount?: number;
    activeSidesCount?: number;
  }
): {
  turnAllowanceMillis: number;
  totalBudgetMillis: number;
  incrementMillis: number;
  inactiveLine: string;
} {
  const isRetry = player.retryingInvalidChoice;
  player.retryingInvalidChoice = false;
  let incrementMillis = 0;
  const startingCapMillis = timers.startingBankMillis ?? timers.maxTurnMillis;
  let isFirstDecision = false;

  // Credit full-turn or mid-turn increment before starting the turn clock,
  // except when retrying after an invalid/unavailable choice on the same decision.
  // Matches Showdown `RoomBattleTimer`: `bankMillis` begins at `starting + grace`, and
  // clamping to `startingCapMillis` on subsequent requests drops unused first-request grace.
  if (player.hasTakenFirstDecision && !isRetry) {
    const isNewTurn = currentTurn > lastRewardedTurn[player.slot];
    if (isNewTurn) {
      incrementMillis = timers.fullTurnIncrementMillis;
      if (timers.accelerate && incrementMillis > 0) {
        if (currentTurn > 100 && incrementMillis > 5_000) {
          incrementMillis -= 5_000;
        }
        if (currentTurn > 200 && Math.floor((timers.requestCount ?? 0) / 2) % 2 === 1) {
          incrementMillis = 0;
        }
      }
    } else {
      incrementMillis = (timers.activeSidesCount ?? 1) <= 1 ? timers.midTurnIncrementMillis : 0;
    }
    player.bankMillis = Math.min(startingCapMillis, player.bankMillis + incrementMillis);
    lastRewardedTurn[player.slot] = currentTurn;
  } else if (!player.hasTakenFirstDecision) {
    isFirstDecision = true;
    player.hasTakenFirstDecision = true;
    lastRewardedTurn[player.slot] = currentTurn;
  }

  const maxTurnMillis = isFirstDecision
    ? (timers.maxFirstTurnMillis ?? timers.maxTurnMillis)
    : timers.maxTurnMillis;
  const turnAllowanceMillis = isRetry && player.turnRemainingMillis !== undefined
    ? Math.max(0, Math.min(player.bankMillis, player.turnRemainingMillis))
    : Math.min(player.bankMillis, maxTurnMillis);
  player.turnRemainingMillis = turnAllowanceMillis;
  const totalBudgetMillis = turnAllowanceMillis;
  const graceMillis = Math.max(0, player.bankMillis - startingCapMillis);
  const totalBankMillis = player.bankMillis - graceMillis;
  const turnSeconds = (turnAllowanceMillis / 1000).toFixed(1);
  const totalSeconds = (totalBankMillis / 1000).toFixed(1);
  const graceSeconds = (graceMillis / 1000).toFixed(1);
  const inactiveLine =
    `|inactive|Time left: ${turnSeconds} sec this turn | ` +
    `${totalSeconds} sec total | ${graceSeconds} sec grace\n`;

  return {turnAllowanceMillis, totalBudgetMillis, incrementMillis, inactiveLine};
}

export function formatChoiceCommand(choice: string, teamPreview?: boolean): string {
  return teamPreview && /^[1-9][0-9,\s]*$/.test(choice) ? `team ${choice}` : choice;
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
  private readonly version: string;
  private format: string;
  private readonly seed: PRNGSeed;
  private readonly p1Spec: AgentLaunchSpec;
  private readonly p2Spec: AgentLaunchSpec;
  private readonly p1TeamPacked?: string;
  private readonly p2TeamPacked?: string;
  private sendUtm?: boolean;
  private readonly maxTurns: number;
  private readonly smokeStopAfterTurn?: number;
  private readonly timerOverrides: TimerOverrides;
  private timers: ResolvedClockTimers;
  private readonly readyGraceMillis: number;
  private readonly devMode: boolean;
  private readonly onTurn?: (info: TurnHeartbeatInfo) => Promise<void> | void;

  private battle: sim.BattleHandle | undefined = undefined;

  private p1: SandboxedPlayer | undefined = undefined;
  private p2: SandboxedPlayer | undefined = undefined;
  private battleStarted = false;
  private currentTurn = 0;
  private requestCount = 0;
  private lastWaveId = 0;
  private waveActiveSidesCount = 1;
  private lastRewardedTurn: Record<PlayerSlot, number> = {p1: -1, p2: -1};
  private ended = false;
  private winner: PlayerSlot | 'tie' = 'tie';
  private endReason = 'normal';

  constructor(options: ArenaGameOptions) {
    this.version = options.version ?? SIM_VERSION;
    this.format = options.format;
    this.seed = options.seed;
    this.p1Spec = options.p1Spec;
    this.p2Spec = options.p2Spec;
    this.p1TeamPacked = options.p1TeamPacked;
    this.p2TeamPacked = options.p2TeamPacked;
    this.sendUtm = options.sendUtm;
    this.maxTurns = options.maxTurns ?? arena.MAX_BATTLE_TURNS;
    this.smokeStopAfterTurn = options.smokeStopAfterTurn;
    this.timerOverrides = {
      startingBankSeconds: options.startingBankSeconds,
      graceSeconds: options.graceSeconds,
      maxTurnSeconds: options.maxTurnSeconds,
      maxFirstTurnSeconds: options.maxFirstTurnSeconds,
    };
    this.timers = resolveClockTimers(
      arena.timerSettingsForFormat(options.format),
      this.timerOverrides
    );
    this.readyGraceMillis =
      (options.readyGraceSeconds ?? arena.READY_GRACE_SECONDS) * 1000;
    this.devMode = options.devMode ?? process.env.ARENA_DEV === '1';
    this.onTurn = options.onTurn;
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
          env: {...process.env, ...spec.env},
        });
      }
    } else {
      proc = spawn(ARENA_BIN, ['run', slot, spec.mode, spec.target], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }

    const player: SandboxedPlayer = {
      slot,
      spec,
      proc,
      lineQueue: [],
      lineResolver: undefined,
      bankMillis: this.timers.startingBankMillis + this.timers.graceMillis,
      turnRemainingMillis: undefined,
      hasTakenFirstDecision: false,
      retryingInvalidChoice: false,
      invalidStrikes: 0,
      pendingRequestJson: undefined,
      lastRequestJson: undefined,
      initMillis: 0,
      teamPreviewCount: 0,
      totalTeamPreviewMillis: 0,
      turnDecisionCount: 0,
      totalTurnDecisionMillis: 0,
      lastDecisionMillis: 0,
      stderrTail: '',
      exited: false,
      exitCode: undefined,
      cleanedUp: false,
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
      let nl = stdoutBuf.indexOf('\n');
      while (nl >= 0) {
        const line = stdoutBuf.slice(0, nl).replace(/\r$/, '');
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line.length > MAX_STDOUT_LINE_CHARS) {
          stdoutBuf = '';
          try {
            proc.kill('SIGKILL');
          } catch {}
          closeWaiter(1);
          return;
        }
        if (player.lineResolver) {
          const resolve = player.lineResolver;
          player.lineResolver = undefined;
          resolve(line);
        } else if (player.lineQueue.length < MAX_LINE_QUEUE) {
          player.lineQueue.push(line);
        }
        nl = stdoutBuf.indexOf('\n');
      }
      if (stdoutBuf.length > MAX_STDOUT_LINE_CHARS) {
        stdoutBuf = '';
        try {
          proc.kill('SIGKILL');
        } catch {}
        closeWaiter(1);
      }
    });

    proc.on('exit', code => closeWaiter(code));
    proc.on('close', code => closeWaiter(code));
    proc.on('error', () => closeWaiter(1));

    // Drain stderr while retaining a bounded diagnostic tail for smoke-test and crash reporting
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      const combined = player.stderrTail + chunk;
      player.stderrTail = combined.length > MAX_STDERR_TAIL_CHARS
        ? combined.slice(-MAX_STDERR_TAIL_CHARS)
        : combined;
    });
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
            timeout: 10_000,
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
      execFileSync(ARENA_BIN, ['pause', player.slot, player.spec.mode], {
        stdio: 'ignore',
        timeout: 10_000,
      });
    } catch {
      if (!player.exited) {
        this.cleanupSlot(player);
        if (this.battleStarted) {
          this.forceLose(player.slot, 'crash');
        }
      }
    }
  }

  private resumeSlot(player: SandboxedPlayer) {
    if (player.exited) return;
    if (this.devMode) {
      if (player.spec.mode === 'container') {
        try {
          execFileSync('podman', ['unpause', `arena-dev-${player.slot}-${process.pid}`], {
            stdio: 'ignore',
            timeout: 10_000,
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
      execFileSync(ARENA_BIN, ['resume', player.slot, player.spec.mode], {
        stdio: 'ignore',
        timeout: 10_000,
      });
    } catch {}
  }

  private cleanupSlot(player: SandboxedPlayer | undefined) {
    if (!player || player.cleanedUp) return;
    if (this.devMode) {
      player.cleanedUp = true;
      if (player.spec.mode === 'container') {
        const containerName = `arena-dev-${player.slot}-${process.pid}`;
        try {
          execFileSync('podman', ['rm', '-f', '-t', '0', containerName], {
            stdio: 'ignore',
            timeout: 10_000,
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
      execFileSync(ARENA_BIN, ['cleanup', player.slot, player.spec.mode], {
        stdio: 'ignore',
        timeout: 10_000,
      });
      player.cleanedUp = true;
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
          timeout: 5_000,
        });
      } catch {}
    } else if (!this.devMode && player.spec.mode === 'container') {
      this.cleanupSlot(player);
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

  private wakePendingLineResolvers() {
    for (const p of [this.p1, this.p2]) {
      if (p?.lineResolver) {
        const resolve = p.lineResolver;
        p.lineResolver = undefined;
        resolve(undefined);
      }
    }
  }

  private forceLose(losingSlot: PlayerSlot, reason: string) {
    if (this.ended) return;
    this.ended = true;
    this.winner = losingSlot === 'p1' ? 'p2' : 'p1';
    this.endReason = reason;
    this.wakePendingLineResolvers();
    // `@pkmn/sim` Battle#win resolves SideID ('p1' / 'p2'), not player display names
    if (this.battle) {
      void this.battle.write(`>forcewin ${this.winner}`).catch(() => undefined);
    }
  }

  private async waitForPlayerReady(
    player: SandboxedPlayer,
    p1: SandboxedPlayer,
    p2: SandboxedPlayer
  ): Promise<boolean> {
    if (this.ended) return false;
    if (this.onTurn) {
      await this.onTurn({
        phase: 'init',
        turn: 0,
        activeSlot: player.slot,
        turnStartedAt: Math.floor(Date.now() / 1000),
        turnBudgetSeconds: Math.round(this.readyGraceMillis / 1000),
        incrementSeconds: Math.round(this.timers.fullTurnIncrementMillis / 1000),
        omniscientLog: '',
        p1: this.buildTurnSlotInfo(p1, 0),
        p2: this.buildTurnSlotInfo(p2, 1),
      });
    }

    let remainingBudgetMillis = this.readyGraceMillis;
    let linesRead = 0;
    this.resumeSlot(player);
    let slotPaused = false;
    const readyStartNs = process.hrtime.bigint();

    try {
      while (!this.ended) {
        const {line, timedOut} = await this.readLineWithTimeout(player, remainingBudgetMillis);
        const elapsedMillis = Number(process.hrtime.bigint() - readyStartNs) / 1e6;
        remainingBudgetMillis = this.readyGraceMillis - elapsedMillis;

        if (timedOut || remainingBudgetMillis <= 0) {
          this.ended = true;
          this.winner = player.slot === 'p1' ? 'p2' : 'p1';
          this.endReason = 'timeout';
          return false;
        }
        if (line === undefined) {
          this.ended = true;
          this.winner = player.slot === 'p1' ? 'p2' : 'p1';
          this.endReason = player.exitCode === 137 ? 'oom' : 'crash';
          return false;
        }

        linesRead++;
        if (linesRead > MAX_LINES_PER_DECISION) {
          this.ended = true;
          this.winner = player.slot === 'p1' ? 'p2' : 'p1';
          this.endReason = 'crash';
          return false;
        }

        const parsed = parseAgentStdoutLine(line);
        if (parsed?.kind === 'ready') {
          player.initMillis = Math.max(1, Math.ceil(elapsedMillis));
          player.lastDecisionMillis = player.initMillis;
          this.pauseSlot(player);
          slotPaused = true;
          return true;
        }
      }
      return false;
    } finally {
      if (!slotPaused) {
        this.pauseSlot(player);
      }
    }
  }

  private async stepPlayerDecision(
    player: SandboxedPlayer,
    p1: SandboxedPlayer,
    p2: SandboxedPlayer
  ): Promise<boolean> {
    if (!player.pendingRequestJson || this.ended) return false;

    const req = JSON.parse(player.pendingRequestJson) as {
      teamPreview?: boolean;
      active?: unknown;
      forceSwitch?: unknown;
    };
    player.pendingRequestJson = undefined;

    const {totalBudgetMillis, incrementMillis, inactiveLine} = beginTurnClockStep(
      player,
      this.currentTurn,
      this.lastRewardedTurn,
      {
        ...this.timers,
        requestCount: this.requestCount,
        activeSidesCount: this.waveActiveSidesCount,
      }
    );

    if (!player.exited && player.proc.stdin.writable) {
      player.proc.stdin.write(inactiveLine);
    }

    if (this.onTurn) {
      await this.onTurn({
        phase: req.teamPreview ? 'preview' : 'battle',
        turn: this.currentTurn,
        activeSlot: player.slot,
        turnStartedAt: Math.floor(Date.now() / 1000),
        turnBudgetSeconds: Math.round(totalBudgetMillis / 1000),
        incrementSeconds: Math.round(incrementMillis / 1000),
        omniscientLog: this.battle?.getLog().join('\n') ?? '',
        p1: this.buildTurnSlotInfo(p1, 0),
        p2: this.buildTurnSlotInfo(p2, 1),
      });
    }

    let remainingBudgetMillis = totalBudgetMillis;
    let totalElapsedThisDecisionMillis: number;
    let linesReadThisDecision = 0;
    player.lineQueue.length = 0;
    this.resumeSlot(player);
    let slotPaused = false;
    const decisionStartNs = process.hrtime.bigint();

    try {
      while (!this.ended) {
        const {line, timedOut} = remainingBudgetMillis <= 0
          ? {line: undefined, timedOut: true}
          : await this.readLineWithTimeout(player, remainingBudgetMillis);
        if (this.ended) return false;
        totalElapsedThisDecisionMillis = Number(process.hrtime.bigint() - decisionStartNs) / 1e6;
        remainingBudgetMillis = totalBudgetMillis - totalElapsedThisDecisionMillis;

        if (timedOut || remainingBudgetMillis <= 0) {
          const chargedMillis = Math.max(0, totalBudgetMillis);
          player.bankMillis = Math.max(0, player.bankMillis - chargedMillis);
          player.turnRemainingMillis = 0;
          if (this.timers.timeoutAutoChoose && player.bankMillis > 0) {
            const elapsedMillis = Math.max(1, Math.round(chargedMillis));
            player.lastDecisionMillis = elapsedMillis;
            if (req.teamPreview) {
              player.teamPreviewCount++;
              player.totalTeamPreviewMillis += elapsedMillis;
            } else {
              player.turnDecisionCount++;
              player.totalTurnDecisionMillis += elapsedMillis;
            }
            this.pauseSlot(player);
            slotPaused = true;
            if (this.ended) return false;
            await this.battle!.write(`>${player.slot} default`);
            return true;
          }
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
        if (!parsed || parsed.kind === 'chat' || parsed.kind === 'ready') continue;

        const decisionElapsedMillis = Math.max(1, Math.ceil(totalElapsedThisDecisionMillis));
        player.bankMillis = Math.max(0, player.bankMillis - decisionElapsedMillis);
        if (player.turnRemainingMillis !== undefined) {
          player.turnRemainingMillis = Math.max(
            0,
            player.turnRemainingMillis - decisionElapsedMillis
          );
        }
        player.lastDecisionMillis = decisionElapsedMillis;
        if (req.teamPreview) {
          player.teamPreviewCount++;
          player.totalTeamPreviewMillis += decisionElapsedMillis;
        } else {
          player.turnDecisionCount++;
          player.totalTurnDecisionMillis += decisionElapsedMillis;
        }

        // Freeze the acting slot before writing into `@pkmn/sim` so it cannot compute while the
        // simulator resolves the wave or delivers the next turn's protocol lines.
        this.pauseSlot(player);
        slotPaused = true;
        if (this.ended) return false;
        const choiceCmd = formatChoiceCommand(parsed.choice, req.teamPreview);
        await this.battle!.write(`>${player.slot} ${choiceCmd}`);
        return true;
      }
      return false;
    } finally {
      if (!slotPaused) {
        this.pauseSlot(player);
      }
    }
  }

  async run(): Promise<ArenaGameResult> {
    this.format = await sim.resolveArenaFormatId(this.format, this.version);
    this.timers = resolveClockTimers(
      await sim.getTimerSettings(this.format, this.version),
      this.timerOverrides
    );
    this.sendUtm = this.sendUtm ?? !(await sim.isGeneratedTeamFormat(
      this.format,
      this.version
    ));

    const p1 = this.spawnPlayer('p1', this.p1Spec);
    const p2 = this.spawnPlayer('p2', this.p2Spec);
    this.p1 = p1;
    this.p2 = p2;

    try {
      const p1Ready = await this.waitForPlayerReady(p1, p1, p2);
      const p2Ready = p1Ready ? await this.waitForPlayerReady(p2, p1, p2) : false;
      if (!p1Ready || !p2Ready) {
        await Promise.all([
          this.stopPlayerForRamRead(p1),
          this.stopPlayerForRamRead(p2),
        ]);
        const outcome: GameOutcome =
          this.winner === 'p1' ? 'W' : this.winner === 'p2' ? 'L' : 'T';
        return {
          winner: this.winner,
          outcome,
          turns: 0,
          endReason: this.endReason,
          omniscientLog: '',
          p1: this.buildPlayerGameResult(p1, 0),
          p2: this.buildPlayerGameResult(p2, 1),
        };
      }

      const battle = sim.createBattle(this.version);
      this.battle = battle;

      if (this.sendUtm && this.p1TeamPacked && p1.proc.stdin.writable) {
        p1.proc.stdin.write(`|utm|${this.p1TeamPacked}\n`);
      }
      if (this.sendUtm && this.p2TeamPacked && p2.proc.stdin.writable) {
        p2.proc.stdin.write(`|utm|${this.p2TeamPacked}\n`);
      }

      this.forwardStream(p1, battle.streams.p1);
      this.forwardStream(p2, battle.streams.p2);

      const omniTask = (async () => {
        for await (const chunk of battle.streams.omniscient) {
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
              this.wakePendingLineResolvers();
              if (step.terminal.forceTie) {
                await battle.write('>forcetie');
              }
            }
          }
        }
      })().catch(() => {
        if (!this.ended) {
          this.ended = true;
          this.winner = 'tie';
          this.endReason = 'sim-error';
        }
      });

      const startSpec = JSON.stringify({formatid: this.format, seed: this.seed});
      const p1PlayerSpec = JSON.stringify({name: 'Agent A', team: this.p1TeamPacked});
      const p2PlayerSpec = JSON.stringify({name: 'Agent B', team: this.p2TeamPacked});

      this.battleStarted = true;
      await battle.write(`>start ${startSpec}`);
      await battle.write(`>player p1 ${p1PlayerSpec}`);
      await battle.write(`>player p2 ${p2PlayerSpec}`);

      let idleSpins = 0;
      while (!this.ended) {
        if (p1.pendingRequestJson || p2.pendingRequestJson) {
          await Promise.resolve();
          const p1HasReq = Boolean(p1.pendingRequestJson);
          const p2HasReq = Boolean(p2.pendingRequestJson);
          if (!p1HasReq && !p2HasReq) continue;
          idleSpins = 0;
          if (p1HasReq && p2HasReq && p1.exited && p2.exited) {
            this.ended = true;
            this.winner = 'tie';
            this.endReason = 'crash';
            await battle.write('>forcetie').catch(() => undefined);
            break;
          }
          const isRetryWave =
            (p1HasReq && p1.retryingInvalidChoice) ||
            (p2HasReq && p2.retryingInvalidChoice);
          if (!isRetryWave) {
            const wave = battle.getWaveInfo();
            if (wave.waveId === 0 || wave.waveId !== this.lastWaveId) {
              this.requestCount++;
              this.lastWaveId = wave.waveId;
            }
            this.waveActiveSidesCount =
              wave.activeSides || ((p1HasReq ? 1 : 0) + (p2HasReq ? 1 : 0));
          }
          // Alternate which slot receives the first CPU slice across decision waves
          const ordered = this.requestCount % 2 === 1
            ? [p1, p2]
            : [p2, p1];
          for (const player of ordered) {
            if (this.ended) break;
            if (player.pendingRequestJson) {
              await this.stepPlayerDecision(player, p1, p2);
              await Promise.resolve();
              while (!this.ended && player.pendingRequestJson && player.retryingInvalidChoice) {
                await this.stepPlayerDecision(player, p1, p2);
                await Promise.resolve();
              }
            }
          }
        } else {
          idleSpins++;
          if (idleSpins >= 10 && (p1.exited || p2.exited)) {
            if (p1.exited && p2.exited) {
              this.ended = true;
              this.winner = 'tie';
              this.endReason = 'crash';
              await battle.write('>forcetie').catch(() => undefined);
            } else {
              const exitedPlayer = p1.exited ? p1 : p2;
              this.forceLose(exitedPlayer.slot, exitedPlayer.exitCode === 137 ? 'oom' : 'crash');
            }
            break;
          }
          if (idleSpins > 2500) {
            this.ended = true;
            this.winner = 'tie';
            this.endReason = 'arbiter-stall';
            await battle.write('>forcetie').catch(() => undefined);
            void battle.destroy().catch(() => undefined);
            break;
          }
          await new Promise(r => setTimeout(r, 2));
        }
      }

      await omniTask;
      await Promise.all([
        this.stopPlayerForRamRead(p1),
        this.stopPlayerForRamRead(p2),
      ]);
      const outcome: GameOutcome =
        this.winner === 'p1' ? 'W' : this.winner === 'p2' ? 'L' : 'T';

      return {
        winner: this.winner,
        outcome,
        turns: this.currentTurn,
        endReason: this.endReason,
        omniscientLog: battle.getLog().join('\n'),
        p1: this.buildPlayerGameResult(p1, 0),
        p2: this.buildPlayerGameResult(p2, 1),
      };
    } finally {
      if (this.battle) {
        void this.battle.destroy().catch(() => undefined);
      }
      this.cleanupSlot(this.p1);
      this.cleanupSlot(this.p2);
    }
  }

  private buildTurnSlotInfo(player: SandboxedPlayer, sideIdx: 0 | 1): TurnSlotInfo {
    const slot = sideIdx === 0 ? 'p1' : 'p2';
    const pokemon = this.battle?.getPokemon(slot);
    const teamPreviewMillis = player.teamPreviewCount > 0
      ? Math.round(player.totalTeamPreviewMillis / player.teamPreviewCount)
      : undefined;
    return {
      bankSeconds: Math.max(
        0,
        Math.round(Math.min(player.bankMillis, this.timers.startingBankMillis) / 1000)
      ),
      ram: this.readPeakRam(player),
      initMillis: Math.round(player.initMillis),
      ...(teamPreviewMillis !== undefined ? {teamPreviewMillis} : {}),
      lastTurnMillis: Math.round(player.lastDecisionMillis),
      meanTurnMillis: player.turnDecisionCount > 0
        ? Math.round(player.totalTurnDecisionMillis / player.turnDecisionCount)
        : 0,
      ...(pokemon !== undefined ? {pokemon} : {}),
    };
  }

  private buildPlayerGameResult(player: SandboxedPlayer, sideIdx: 0 | 1): PlayerGameResult {
    const slot = sideIdx === 0 ? 'p1' : 'p2';
    const pokemon = this.battle?.getPokemon(slot);
    const teamPreviewMillis = player.teamPreviewCount > 0
      ? Math.round(player.totalTeamPreviewMillis / player.teamPreviewCount)
      : undefined;
    return {
      bankSeconds: Math.max(
        0,
        Math.round(Math.min(player.bankMillis, this.timers.startingBankMillis) / 1000)
      ),
      peakRam: this.readPeakRam(player),
      initMillis: Math.round(player.initMillis),
      ...(teamPreviewMillis !== undefined ? {teamPreviewMillis} : {}),
      meanTurnMillis: player.turnDecisionCount > 0
        ? Math.round(player.totalTurnDecisionMillis / player.turnDecisionCount)
        : 0,
      lastTurnMillis: Math.round(player.lastDecisionMillis),
      ...(pokemon !== undefined ? {pokemon} : {}),
      ...(player.exitCode !== undefined ? {exitCode: player.exitCode} : {}),
      ...(player.stderrTail ? {stderr: player.stderrTail} : {}),
    };
  }
}
