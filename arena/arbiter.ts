import {ChildProcessWithoutNullStreams, execFileSync, spawn} from 'child_process';
import * as fs from 'fs';

import {BattleStreams, PRNGSeed} from '@pkmn/sim';

import * as arena from '../server/arena';
import {filterPlayerProtocolChunk, parseAgentStdoutLine} from '../server/protocol';
import {GameOutcome} from '../server/ratings';
import {ensureSimConfigured, resolveArenaFormatId} from '../server/teams';

import {AgentMode} from './db';

ensureSimConfigured();

type PlayerSlot = 'p1' | 'p2';

export interface AgentLaunchSpec {
  mode: AgentMode;
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
  bankMs: number;
  hasTakenFirstDecision: boolean;
  retryingInvalidChoice: boolean;
  invalidStrikes: number;
  pendingRequestJson: string | undefined;
  lastRequestJson: string | undefined;
  decisionCount: number;
  totalDecisionMs: number;
  lastDecisionMs: number;
  exited: boolean;
  exitCode: number | undefined;
}

const MAX_INVALID_STRIKES = 3;
const MAX_STDOUT_LINE_CHARS = 65_536;
const MAX_LINE_QUEUE = 256;
const MAX_LINES_PER_DECISION = 64;
const MAX_CHAT_LINES_PER_DECISION = 1;
const MAX_CHAT_MESSAGE_CHARS = 500;

export class TimeSlicedArenaGame {
  private readonly format: string;
  private readonly seed: PRNGSeed;
  private readonly p1Spec: AgentLaunchSpec;
  private readonly p2Spec: AgentLaunchSpec;
  private readonly p1TeamPacked?: string;
  private readonly p2TeamPacked?: string;
  private readonly maxTurns: number;
  private readonly smokeStopAfterTurn?: number;
  private readonly startingBankMs: number;
  private readonly firstTurnGraceMs: number;
  private readonly maxTurnMs: number;
  private readonly fullTurnIncrementMs: number;
  private readonly midTurnIncrementMs: number;
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
    this.startingBankMs =
      (options.startingBankSeconds ?? arena.STARTING_BANK_SECONDS) * 1000;
    this.firstTurnGraceMs =
      (options.firstTurnGraceSeconds ?? arena.FIRST_TURN_GRACE_SECONDS) * 1000;
    this.maxTurnMs = (options.maxTurnSeconds ?? arena.MAX_TURN_SECONDS) * 1000;
    this.fullTurnIncrementMs = arena.turnIncrementSeconds(options.format) * 1000;
    this.midTurnIncrementMs = arena.MID_TURN_INCREMENT_SECONDS * 1000;
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
      bankMs: this.startingBankMs,
      hasTakenFirstDecision: false,
      retryingInvalidChoice: false,
      invalidStrikes: 0,
      pendingRequestJson: undefined,
      lastRequestJson: undefined,
      decisionCount: 0,
      totalDecisionMs: 0,
      lastDecisionMs: 0,
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
      process.kill(player.proc.pid, 'SIGTERM');
    } catch {}
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 100);
      player.proc.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private readPeakRamMib(player: SandboxedPlayer): number {
    if (!this.devMode && player.spec.mode === 'native') {
      const candidates = [
        `/opt/arena/state/peak_ram_${player.slot}`,
        player.slot === 'p1' ? '/Volumes/P1/.peak_ram' : '/Volumes/P2/.peak_ram',
      ];
      for (const file of candidates) {
        try {
          if (fs.existsSync(file)) {
            const val = Number(fs.readFileSync(file, 'utf8').trim());
            if (Number.isFinite(val) && val > 0) return Math.round(val);
          }
        } catch {}
      }
    }
    return 64;
  }

  private readLineWithTimeout(
    player: SandboxedPlayer,
    budgetMs: number
  ): Promise<{line: string | undefined; elapsedMs: number; timedOut: boolean}> {
    const startNs = process.hrtime.bigint();

    if (player.lineQueue.length > 0) {
      const line = player.lineQueue.shift()!;
      const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
      return Promise.resolve({line, elapsedMs, timedOut: false});
    }
    if (player.exited) {
      const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
      return Promise.resolve({line: undefined, elapsedMs, timedOut: false});
    }

    return new Promise(resolve => {
      const timer = setTimeout(() => {
        player.lineResolver = undefined;
        const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
        resolve({line: undefined, elapsedMs, timedOut: true});
      }, Math.max(1, Math.ceil(budgetMs)));

      player.lineResolver = line => {
        clearTimeout(timer);
        const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
        resolve({line, elapsedMs, timedOut: false});
      };
    });
  }

  private forwardStream(player: SandboxedPlayer, stream: AsyncIterable<string>) {
    void (async () => {
      for await (const rawChunk of stream) {
        const chunk = filterPlayerProtocolChunk(rawChunk);
        if (!chunk) continue;

        if (!player.exited && player.proc.stdin.writable) {
          player.proc.stdin.write(`${chunk}\n`);
        }

        const lines = chunk.split('\n');
        const chunkHasRequest = lines.some(l => l.startsWith('|request|'));
        for (const line of lines) {
          if (line.startsWith('|request|')) {
            const reqJson = line.slice('|request|'.length).trim();
            if (reqJson && reqJson !== 'null') {
              try {
                const parsed = JSON.parse(reqJson) as {wait?: boolean};
                if (!parsed.wait) {
                  if (!player.retryingInvalidChoice) {
                    player.invalidStrikes = 0;
                  }
                  player.pendingRequestJson = reqJson;
                  player.lastRequestJson = reqJson;
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
              this.forceLose(player.slot, 'invalid_choice_limit');
            } else if (!chunkHasRequest && player.lastRequestJson) {
              player.pendingRequestJson = player.lastRequestJson;
              if (!player.exited && player.proc.stdin.writable) {
                player.proc.stdin.write(`|request|${player.lastRequestJson}\n`);
              }
            }
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

    const isRetry = player.retryingInvalidChoice;
    player.retryingInvalidChoice = false;

    // Credit full-turn or mid-turn increment before starting the turn clock,
    // except when retrying after an invalid/unavailable choice on the same decision.
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

    if (this.onTurn) {
      await this.onTurn({
        turn: this.currentTurn,
        activeSlot: player.slot,
        turnStartedAt: Math.floor(Date.now() / 1000),
        turnBudgetSeconds: Math.round(totalBudgetMs / 1000),
        incrementSeconds: Math.round(this.fullTurnIncrementMs / 1000),
        p1BankSeconds: Math.max(0, Math.round(this.p1.bankMs / 1000)),
        p2BankSeconds: Math.max(0, Math.round(this.p2.bankMs / 1000)),
        p1LastTurnMillis: Math.round(this.p1.lastDecisionMs),
        p2LastTurnMillis: Math.round(this.p2.lastDecisionMs),
        p1MeanTurnMillis: this.p1.decisionCount > 0
          ? Math.round(this.p1.totalDecisionMs / this.p1.decisionCount)
          : 0,
        p2MeanTurnMillis: this.p2.decisionCount > 0
          ? Math.round(this.p2.totalDecisionMs / this.p2.decisionCount)
          : 0,
      });
    }

    let remainingBudgetMs = totalBudgetMs;
    let totalElapsedThisDecisionMs: number;
    let linesReadThisDecision = 0;
    let chatLinesThisDecision = 0;
    this.resumeSlot(player);
    const decisionStartNs = process.hrtime.bigint();

    try {
      while (!this.ended) {
        const {line, timedOut} = await this.readLineWithTimeout(
          player,
          remainingBudgetMs
        );
        totalElapsedThisDecisionMs = Number(process.hrtime.bigint() - decisionStartNs) / 1e6;
        remainingBudgetMs = totalBudgetMs - totalElapsedThisDecisionMs;

        if (timedOut || remainingBudgetMs <= 0) {
          player.bankMs = 0;
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
        if (!parsed) continue;

        if (parsed.kind === 'chat') {
          if (chatLinesThisDecision < MAX_CHAT_LINES_PER_DECISION) {
            chatLinesThisDecision++;
            const displayName = player.slot === 'p1' ? 'Agent A' : 'Agent B';
            const safeMsg = parsed.message.slice(0, MAX_CHAT_MESSAGE_CHARS);
            await this.battleStream.write(`>chat ${displayName}|${safeMsg}`);
          }
          continue;
        }

        const decisionElapsedMs = Math.max(1, Math.ceil(totalElapsedThisDecisionMs));
        const overGraceMs = Math.max(0, decisionElapsedMs - graceMs);
        player.bankMs = Math.max(0, player.bankMs - overGraceMs);
        player.decisionCount++;
        player.lastDecisionMs = decisionElapsedMs;
        player.totalDecisionMs += decisionElapsedMs;

        const choiceCmd = req.teamPreview && !parsed.choice.startsWith('team ')
          ? `team ${parsed.choice}`
          : parsed.choice;
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
                const winnerName = line.slice('|win|'.length).trim();
                this.winner = winnerName === 'Agent A' ? 'p1' : 'p2';
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
            this.endReason = 'arbiter_stall';
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
      const p1PeakRam = this.readPeakRamMib(this.p1);
      const p2PeakRam = this.readPeakRamMib(this.p2);
      const outcome: GameOutcome =
        this.winner === 'p1' ? 'W' : this.winner === 'p2' ? 'L' : 'T';

      return {
        winner: this.winner,
        outcome,
        turns: this.currentTurn,
        endReason: this.endReason,
        omniscientLog: this.omniscientLog.join('\n'),
        p1BankSeconds: Math.max(0, Math.round(this.p1.bankMs / 1000)),
        p2BankSeconds: Math.max(0, Math.round(this.p2.bankMs / 1000)),
        p1PeakRam,
        p2PeakRam,
        p1MeanTurnMillis: this.p1.decisionCount > 0
          ? Math.round(this.p1.totalDecisionMs / this.p1.decisionCount)
          : 0,
        p2MeanTurnMillis: this.p2.decisionCount > 0
          ? Math.round(this.p2.totalDecisionMs / this.p2.decisionCount)
          : 0,
        p1LastTurnMillis: Math.round(this.p1.lastDecisionMs),
        p2LastTurnMillis: Math.round(this.p2.lastDecisionMs),
      };
    } finally {
      this.cleanupSlot(this.p1);
      this.cleanupSlot(this.p2);
    }
  }
}
