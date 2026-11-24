import {ChildProcessWithoutNullStreams, execFileSync, spawn} from 'child_process';
import * as fs from 'fs';

import type {PRNGSeed} from '@pkmn/sim';

import {SIM_VERSION} from '../db/ladders';
import * as arena from '../server/arena';
import {
  PublicAgentInfo,
  filterPlayerProtocolChunk,
  injectAiLogLines,
  parseAgentStdoutLine,
} from '../server/protocol';
import {GameOutcome} from '../server/ratings';
import * as sim from '../server/sim';

import * as db from './db';
import * as engine from './engine';

export * from './engine';

type PlayerSlot = engine.PlayerSlot;

export interface AgentLaunchSpec {
  mode: db.ExecutionMode;
  target: string; // OCI image tag for 'container', or bundle directory/path for 'native'
  args?: string[];
  env?: Record<string, string>;
}

export interface TurnSlotInfo {
  bankSeconds: number;
  ram: number;
  cpuCores?: number;
  initMillis?: number;
  teamPreviewMillis?: number;
  lastTurnMillis: number;
  meanTurnMillis: number;
  pokemon?: unknown[];
  info?: PublicAgentInfo;
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
  winHistory?: arena.WinHistoryPoint[];
}

export interface GamePlayerOptions {
  spec: AgentLaunchSpec;
  teamPacked?: string;
}

export interface ArenaGameOptions {
  format: string;
  version?: string;
  seed: PRNGSeed;
  p1: GamePlayerOptions;
  p2: GamePlayerOptions;
  sendUtm?: boolean;
  recordAiLogs?: boolean;
  liveInfo?: boolean;
  maxTurns?: number;
  maxWallMillis?: number;
  smokeStopAfterTurn?: number;
  stderrCapture?: engine.StderrCaptureLimits;
  timers?: engine.GameTimerOptions;
  devMode?: boolean;
  onTurn?: (info: TurnHeartbeatInfo) => Promise<void> | void;
}

export interface PlayerGameResult {
  bankSeconds: number;
  peakRam: number;
  cpuMillis?: number;
  cpuCores?: number;
  initMillis: number;
  teamPreviewMillis?: number;
  meanTurnMillis: number;
  lastTurnMillis: number;
  pokemon?: unknown[];
  info?: PublicAgentInfo;
  errors?: engine.ProtocolErrorCounts;
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
  winHistory?: arena.WinHistoryPoint[];
}

interface SandboxedPlayer {
  slot: PlayerSlot;
  spec: AgentLaunchSpec;
  proc: ChildProcessWithoutNullStreams;
  io: engine.LineIoState & {
    pendingRequestJson: string | undefined;
    stderrBuf: engine.BoundedStderrBuffer;
  };
  turn: engine.PlayerTurnState;
  errors: engine.ProtocolErrorCounts;
  telemetry: engine.DecisionTelemetry & {
    initMillis: number;
    lastDecisionMillis: number;
  };
  lifecycle: {
    exited: boolean;
    exitCode: number | undefined;
    cleanedUp: boolean;
  };
}

const ARENA_BIN = '/opt/arena/bin/arena';

export class TimeSlicedArenaGame {
  private readonly version: string;
  private format: string;
  private readonly seed: PRNGSeed;
  private readonly p1Opts: GamePlayerOptions;
  private readonly p2Opts: GamePlayerOptions;
  private sendUtm?: boolean;
  private readonly recordAiLogs: boolean;
  private readonly liveInfo: boolean;
  private readonly maxTurns: number;
  private readonly maxWallMillis?: number;
  private readonly smokeStopAfterTurn?: number;
  private readonly stderrCapture: engine.StderrCaptureLimits;
  private readonly timerOverrides: engine.TimerOverrides;
  private timers: engine.ResolvedClockTimers;
  private readonly readyGraceMillis: number;
  private readonly devMode: boolean;
  private readonly onTurn?: (info: TurnHeartbeatInfo) => Promise<void> | void;
  private readonly infoCoalescer: engine.InfoCoalescer;

  private battle: sim.BattleHandle | undefined = undefined;
  private battleStartedAtNs: bigint | undefined = undefined;

  private p1: SandboxedPlayer | undefined = undefined;
  private p2: SandboxedPlayer | undefined = undefined;
  private currentTurn = 0;
  private activeTurnState: {
    phase: arena.LivePhase;
    activeSlot: PlayerSlot;
    turnStartedAt: number;
    turnBudgetSeconds: number;
    incrementSeconds: number;
  } | undefined = undefined;
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
    this.p1Opts = options.p1;
    this.p2Opts = options.p2;
    this.sendUtm = options.sendUtm;
    this.recordAiLogs = options.recordAiLogs ?? true;
    this.liveInfo = options.liveInfo ?? false;
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
    this.devMode = options.devMode ?? process.env.ARENA_DEV === '1';
    this.onTurn = options.onTurn;
    this.infoCoalescer = new engine.InfoCoalescer({
      onBroadcast: () => {
        if (!this.liveInfo || !this.onTurn || this.ended) return;
        if (!this.p1 || !this.p2 || !this.activeTurnState) return;
        const winHistory = this.infoCoalescer.getWinHistory();
        void Promise.resolve(this.onTurn({
          phase: this.activeTurnState.phase,
          turn: this.currentTurn,
          activeSlot: this.activeTurnState.activeSlot,
          turnStartedAt: this.activeTurnState.turnStartedAt,
          turnBudgetSeconds: this.activeTurnState.turnBudgetSeconds,
          incrementSeconds: this.activeTurnState.incrementSeconds,
          omniscientLog: this.getOmniscientLog(),
          p1: this.buildTurnSlotInfo(this.p1, 0),
          p2: this.buildTurnSlotInfo(this.p2, 1),
          ...(winHistory.length > 0 ? {winHistory} : {}),
        })).catch(() => undefined);
      },
    });
  }

  private getOmniscientLog(): string {
    const rawLog = this.battle?.getLog().join('\n') ?? '';
    return this.recordAiLogs
      ? injectAiLogLines(rawLog, this.infoCoalescer.getCommittedByTurn())
      : rawLog;
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
      io: {
        lineQueue: [],
        lineResolver: undefined,
        pendingRequestJson: undefined,
        stderrBuf: new engine.BoundedStderrBuffer(this.stderrCapture),
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
        teamPreviewCount: 0,
        totalTeamPreviewMillis: 0,
        turnDecisionCount: 0,
        totalTurnDecisionMillis: 0,
        lastDecisionMillis: 0,
      },
      lifecycle: {
        exited: false,
        exitCode: undefined,
        cleanedUp: false,
      },
    };

    const closeWaiter = (code?: number | null) => {
      player.lifecycle.exited = true;
      if (code !== undefined && code !== null) {
        player.lifecycle.exitCode = code;
      }
      engine.wakeLineResolver(player.io);
    };

    engine.attachStdoutLineFramer(
      proc,
      player.io,
      () => closeWaiter(1),
      engine.createInfoLineInterceptor(slot, this.infoCoalescer)
    );

    proc.on('exit', code => closeWaiter(code));
    proc.on('close', code => closeWaiter(code));
    proc.on('error', () => closeWaiter(1));

    // Drain stderr while retaining bounded diagnostic output for smoke-test and crash reporting
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      player.io.stderrBuf.append(chunk);
    });
    // Ignore EPIPE on stdin if child exits mid-write
    proc.stdin.on('error', () => undefined);

    this.pauseSlot(player);
    return player;
  }

  private pauseSlot(player: SandboxedPlayer) {
    if (player.lifecycle.exited) return;
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
      if (!player.lifecycle.exited) {
        this.cleanupSlot(player);
        this.forceLose(player.slot, 'crash');
      }
    }
  }

  private resumeSlot(player: SandboxedPlayer) {
    if (player.lifecycle.exited) return;
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
    if (!player || player.lifecycle.cleanedUp) return;
    if (this.devMode) {
      player.lifecycle.cleanedUp = true;
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
      player.lifecycle.cleanedUp = true;
    } catch {}
  }

  private async stopPlayerForRamRead(player: SandboxedPlayer | undefined) {
    if (!player || player.lifecycle.exited || !player.proc.pid) return;
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
    } else if (this.devMode) {
      // Queue SIGKILL before SIGCONT so a SIGSTOP-paused dev process terminates immediately
      // instead of ignoring SIGTERM until the 150 ms fallback timeout expires.
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

  private readCpuMillis(player: SandboxedPlayer): number | undefined {
    if (!this.devMode) {
      const stateFile = `/opt/arena/state/cpu_millis_${player.slot}`;
      try {
        if (fs.existsSync(stateFile)) {
          const val = Number(fs.readFileSync(stateFile, 'utf8').trim());
          if (Number.isFinite(val) && val > 0) return Math.round(val);
        }
      } catch {}
    }
    return undefined;
  }

  private readLineWithTimeout(
    player: SandboxedPlayer,
    budgetMillis: number
  ): Promise<{line: string | undefined; elapsedMillis: number; timedOut: boolean}> {
    const startNs = process.hrtime.bigint();

    if (player.io.lineQueue.length > 0) {
      const line = player.io.lineQueue.shift()!;
      const elapsedMillis = Number(process.hrtime.bigint() - startNs) / 1e6;
      return Promise.resolve({line, elapsedMillis, timedOut: false});
    }
    if (player.lifecycle.exited) {
      const elapsedMillis = Number(process.hrtime.bigint() - startNs) / 1e6;
      return Promise.resolve({line: undefined, elapsedMillis, timedOut: false});
    }

    return new Promise(resolve => {
      const timer = setTimeout(() => {
        player.io.lineResolver = undefined;
        const elapsedMillis = Number(process.hrtime.bigint() - startNs) / 1e6;
        resolve({line: undefined, elapsedMillis, timedOut: true});
      }, Math.max(1, Math.ceil(budgetMillis)));

      player.io.lineResolver = line => {
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

        const inspected = engine.inspectPlayerProtocolChunk(
          chunk,
          player.turn,
          this.ended,
          player.errors
        );
        if (inspected.actionableReqJson) {
          player.io.pendingRequestJson = inspected.actionableReqJson;
        }
        if (inspected.forfeitedInvalidChoice) {
          this.forceLose(player.slot, 'invalid-choice');
        }
        if (inspected.clearQueue) {
          player.io.lineQueue.length = 0;
        }
        if (!player.lifecycle.exited && player.proc.stdin.writable) {
          player.proc.stdin.write(`${chunk}\n`);
          if (inspected.resendLastRequest && player.turn.lastRequestJson) {
            player.proc.stdin.write(`|request|${player.turn.lastRequestJson}\n`);
          }
        }
      }
    })().catch(() => undefined);
  }

  private wakePendingLineResolvers() {
    engine.wakeLineResolver(this.p1?.io);
    engine.wakeLineResolver(this.p2?.io);
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
          this.endReason = player.lifecycle.exitCode === 137 ? 'oom' : 'crash';
          return false;
        }

        linesRead++;
        if (linesRead > engine.MAX_LINES_PER_DECISION) {
          this.ended = true;
          this.winner = player.slot === 'p1' ? 'p2' : 'p1';
          this.endReason = 'crash';
          return false;
        }

        const parsed = parseAgentStdoutLine(line);
        if (parsed?.kind === 'ready') {
          player.telemetry.initMillis = Math.max(1, Math.ceil(elapsedMillis));
          player.telemetry.lastDecisionMillis = player.telemetry.initMillis;
          this.pauseSlot(player);
          slotPaused = true;
          return !this.ended;
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
    if (!player.io.pendingRequestJson || this.ended) return false;

    const req = JSON.parse(player.io.pendingRequestJson) as {
      teamPreview?: boolean;
      active?: unknown;
      forceSwitch?: unknown;
    };
    player.io.pendingRequestJson = undefined;

    const {totalBudgetMillis, incrementMillis, inactiveLine} = engine.beginTurnClockStep(
      player.turn,
      this.currentTurn,
      this.lastRewardedTurn,
      {
        ...this.timers,
        requestCount: this.requestCount,
        activeSidesCount: this.waveActiveSidesCount,
      }
    );

    if (!player.lifecycle.exited && player.proc.stdin.writable) {
      player.proc.stdin.write(inactiveLine);
    }

    const turnStartedAt = Math.floor(Date.now() / 1000);
    const phase: arena.LivePhase = req.teamPreview ? 'preview' : 'battle';
    const turnBudgetSeconds = Math.round(totalBudgetMillis / 1000);
    const incrementSeconds = Math.round(incrementMillis / 1000);
    this.activeTurnState = {
      phase,
      activeSlot: player.slot,
      turnStartedAt,
      turnBudgetSeconds,
      incrementSeconds,
    };

    if (this.onTurn) {
      const winHistory = this.infoCoalescer.getWinHistory();
      await this.onTurn({
        phase,
        turn: this.currentTurn,
        activeSlot: player.slot,
        turnStartedAt,
        turnBudgetSeconds,
        incrementSeconds,
        omniscientLog: this.getOmniscientLog(),
        p1: this.buildTurnSlotInfo(p1, 0),
        p2: this.buildTurnSlotInfo(p2, 1),
        ...(winHistory.length > 0 ? {winHistory} : {}),
      });
    }

    let remainingBudgetMillis = totalBudgetMillis;
    let totalElapsedThisDecisionMillis: number;
    let linesReadThisDecision = 0;
    player.io.lineQueue.length = 0;
    this.resumeSlot(player);
    let slotPaused = false;
    const decisionStartNs = process.hrtime.bigint();

    try {
      while (!this.ended) {
        const wallRemaining = this.currentTurn >= 1 ? this.remainingWallCapMillis() : undefined;
        if (wallRemaining !== undefined && wallRemaining <= 0) {
          this.stopForDiagnosticCap();
          return false;
        }
        const waitMillis = wallRemaining !== undefined
          ? Math.min(remainingBudgetMillis, wallRemaining)
          : remainingBudgetMillis;
        const cappedByWall = wallRemaining !== undefined && wallRemaining < remainingBudgetMillis;
        const {line, timedOut} = waitMillis <= 0
          ? {line: undefined, timedOut: true}
          : await this.readLineWithTimeout(player, waitMillis);
        if (this.ended) return false;
        if (timedOut && cappedByWall) {
          const postWall = this.remainingWallCapMillis();
          if (postWall !== undefined && postWall <= 0) {
            this.stopForDiagnosticCap();
            return false;
          }
          totalElapsedThisDecisionMillis = Number(process.hrtime.bigint() - decisionStartNs) / 1e6;
          remainingBudgetMillis = totalBudgetMillis - totalElapsedThisDecisionMillis;
          if (remainingBudgetMillis > 0) continue;
        }
        totalElapsedThisDecisionMillis = Number(process.hrtime.bigint() - decisionStartNs) / 1e6;
        remainingBudgetMillis = totalBudgetMillis - totalElapsedThisDecisionMillis;

        if (timedOut || remainingBudgetMillis <= 0) {
          const outcome = engine.applyDecisionTimeout(
            player.turn,
            player.telemetry,
            totalBudgetMillis,
            this.timers.timeoutAutoChoose,
            req.teamPreview
          );
          if (outcome === 'auto-choose') {
            this.pauseSlot(player);
            slotPaused = true;
            if (this.ended) return false;
            await this.battle!.write(`>${player.slot} default`);
            return true;
          }
          this.forceLose(player.slot, 'timeout');
          return false;
        }
        if (line === undefined) {
          const reason = player.lifecycle.exitCode === 137 ? 'oom' : 'crash';
          this.forceLose(player.slot, reason);
          return false;
        }

        linesReadThisDecision++;
        if (linesReadThisDecision > engine.MAX_LINES_PER_DECISION) {
          this.forceLose(player.slot, 'crash');
          return false;
        }

        const parsed = parseAgentStdoutLine(line);
        if (parsed?.kind !== 'choice') continue;

        const decisionElapsedMillis = Math.max(1, Math.ceil(totalElapsedThisDecisionMillis));
        engine.chargeDecisionClock(player.turn, decisionElapsedMillis);
        engine.recordDecisionTelemetry(player.telemetry, decisionElapsedMillis, req.teamPreview);

        // Freeze the acting slot before writing into `@pkmn/sim` so it cannot compute while the
        // simulator resolves the wave or delivers the next turn's protocol lines.
        this.pauseSlot(player);
        slotPaused = true;
        if (this.ended) return false;
        this.infoCoalescer.commitTurn(player.slot, this.currentTurn);
        const choiceCmd = engine.formatChoiceCommand(parsed.choice, req.teamPreview);
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
    const resolved = await engine.resolveBattleConfig({
      format: this.format,
      version: this.version,
      sendUtm: this.sendUtm,
      timerOverrides: this.timerOverrides,
    });
    this.format = resolved.format;
    this.timers = resolved.timers;
    this.sendUtm = resolved.sendUtm;

    const p1 = this.spawnPlayer('p1', this.p1Opts.spec);
    const p2 = this.spawnPlayer('p2', this.p2Opts.spec);
    this.p1 = p1;
    this.p2 = p2;

    try {
      const p1Ready = await this.waitForPlayerReady(p1, p1, p2);
      const p2Ready = p1Ready ? await this.waitForPlayerReady(p2, p1, p2) : false;
      if (!p1Ready || !p2Ready || this.ended) {
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

      if (this.sendUtm && this.p1Opts.teamPacked && p1.proc.stdin.writable) {
        p1.proc.stdin.write(`|utm|${this.p1Opts.teamPacked}\n`);
      }
      if (this.sendUtm && this.p2Opts.teamPacked && p2.proc.stdin.writable) {
        p2.proc.stdin.write(`|utm|${this.p2Opts.teamPacked}\n`);
      }

      this.forwardStream(p1, battle.streams.p1);
      this.forwardStream(p2, battle.streams.p2);

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
      });

      this.battleStartedAtNs = process.hrtime.bigint();
      await engine.startBattleProtocol(battle, {
        format: this.format,
        seed: this.seed,
        p1Team: this.p1Opts.teamPacked,
        p2Team: this.p2Opts.teamPacked,
      });

      let idleSpins = 0;
      while (!this.ended) {
        if (this.currentTurn >= 1) {
          const wallRemaining = this.remainingWallCapMillis();
          if (wallRemaining !== undefined && wallRemaining <= 0) {
            this.stopForDiagnosticCap();
            break;
          }
        }
        if (p1.io.pendingRequestJson || p2.io.pendingRequestJson) {
          await Promise.resolve();
          const p1HasReq = Boolean(p1.io.pendingRequestJson);
          const p2HasReq = Boolean(p2.io.pendingRequestJson);
          if (!p1HasReq && !p2HasReq) continue;
          idleSpins = 0;
          if (p1HasReq && p2HasReq && p1.lifecycle.exited && p2.lifecycle.exited) {
            this.ended = true;
            this.winner = 'tie';
            this.endReason = 'crash';
            await battle.write('>forcetie').catch(() => undefined);
            break;
          }
          const isRetryWave =
            (p1HasReq && p1.turn.retryingInvalidChoice) ||
            (p2HasReq && p2.turn.retryingInvalidChoice);
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
            if (player.io.pendingRequestJson) {
              await this.stepPlayerDecision(player, p1, p2);
              await Promise.resolve();
              while (
                !this.ended &&
                player.io.pendingRequestJson &&
                player.turn.retryingInvalidChoice
              ) {
                await this.stepPlayerDecision(player, p1, p2);
                await Promise.resolve();
              }
            }
          }
        } else {
          idleSpins++;
          if (idleSpins >= 10 && (p1.lifecycle.exited || p2.lifecycle.exited)) {
            if (p1.lifecycle.exited && p2.lifecycle.exited) {
              this.ended = true;
              this.winner = 'tie';
              this.endReason = 'crash';
              await battle.write('>forcetie').catch(() => undefined);
            } else {
              const exitedPlayer = p1.lifecycle.exited ? p1 : p2;
              this.forceLose(
                exitedPlayer.slot,
                exitedPlayer.lifecycle.exitCode === 137 ? 'oom' : 'crash'
              );
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

      const winHistory = this.infoCoalescer.getWinHistory();
      return {
        winner: this.winner,
        outcome,
        turns: this.currentTurn,
        endReason: this.endReason,
        omniscientLog: this.getOmniscientLog(),
        p1: this.buildPlayerGameResult(p1, 0),
        p2: this.buildPlayerGameResult(p2, 1),
        ...(winHistory.length > 0 ? {winHistory} : {}),
      };
    } finally {
      this.infoCoalescer.dispose();
      if (this.battle) {
        void this.battle.destroy().catch(() => undefined);
      }
      this.cleanupSlot(this.p1);
      this.cleanupSlot(this.p2);
    }
  }

  private computeCpuCores(
    player: SandboxedPlayer
  ): {cpuMillis?: number; cpuCores?: number} {
    const cpuMillis = this.readCpuMillis(player);
    const activeWallMillis =
      player.telemetry.initMillis +
      player.telemetry.totalTeamPreviewMillis +
      player.telemetry.totalTurnDecisionMillis;
    const cpuCores = cpuMillis !== undefined && activeWallMillis > 0
      ? Math.min(10, Math.round((cpuMillis / activeWallMillis) * 10) / 10)
      : undefined;
    return {
      ...(cpuMillis !== undefined ? {cpuMillis} : {}),
      ...(cpuCores !== undefined && cpuCores > 0 ? {cpuCores} : {}),
    };
  }

  private buildTurnSlotInfo(player: SandboxedPlayer, sideIdx: 0 | 1): TurnSlotInfo {
    const slot = sideIdx === 0 ? 'p1' : 'p2';
    const pokemon = this.battle?.getPokemon(slot);
    const info = this.infoCoalescer.getLive(slot);
    const teamPreviewMillis = player.telemetry.teamPreviewCount > 0
      ? Math.round(player.telemetry.totalTeamPreviewMillis / player.telemetry.teamPreviewCount)
      : undefined;
    const {cpuCores} = this.computeCpuCores(player);
    return {
      bankSeconds: Math.max(
        0,
        Math.round(Math.min(player.turn.bankMillis, this.timers.startingBankMillis) / 1000)
      ),
      ram: this.readPeakRam(player),
      ...(cpuCores !== undefined ? {cpuCores} : {}),
      initMillis: Math.round(player.telemetry.initMillis),
      ...(teamPreviewMillis !== undefined ? {teamPreviewMillis} : {}),
      lastTurnMillis: Math.round(player.telemetry.lastDecisionMillis),
      meanTurnMillis: player.telemetry.turnDecisionCount > 0
        ? Math.round(player.telemetry.totalTurnDecisionMillis / player.telemetry.turnDecisionCount)
        : 0,
      ...(pokemon !== undefined ? {pokemon} : {}),
      ...(info !== undefined ? {info} : {}),
    };
  }

  private buildPlayerGameResult(player: SandboxedPlayer, sideIdx: 0 | 1): PlayerGameResult {
    const slot = sideIdx === 0 ? 'p1' : 'p2';
    const pokemon = this.battle?.getPokemon(slot);
    const info = this.infoCoalescer.getLive(slot);
    const teamPreviewMillis = player.telemetry.teamPreviewCount > 0
      ? Math.round(player.telemetry.totalTeamPreviewMillis / player.telemetry.teamPreviewCount)
      : undefined;
    const {cpuMillis, cpuCores} = this.computeCpuCores(player);
    return {
      bankSeconds: Math.max(
        0,
        Math.round(Math.min(player.turn.bankMillis, this.timers.startingBankMillis) / 1000)
      ),
      peakRam: this.readPeakRam(player),
      ...(cpuMillis !== undefined ? {cpuMillis} : {}),
      ...(cpuCores !== undefined ? {cpuCores} : {}),
      initMillis: Math.round(player.telemetry.initMillis),
      ...(teamPreviewMillis !== undefined ? {teamPreviewMillis} : {}),
      meanTurnMillis: player.telemetry.turnDecisionCount > 0
        ? Math.round(player.telemetry.totalTurnDecisionMillis / player.telemetry.turnDecisionCount)
        : 0,
      lastTurnMillis: Math.round(player.telemetry.lastDecisionMillis),
      ...(pokemon !== undefined ? {pokemon} : {}),
      ...(info !== undefined ? {info} : {}),
      errors: {...player.errors},
      ...(player.lifecycle.exitCode !== undefined ? {exitCode: player.lifecycle.exitCode} : {}),
      ...(player.io.stderrBuf.format() ? {stderr: player.io.stderrBuf.format()} : {}),
    };
  }
}
