import {ChildProcessWithoutNullStreams} from 'child_process';

import type {PRNGSeed} from '@pkmn/sim';

import * as arena from '../server/arena';
import * as protocol from '../server/protocol';
import * as sim from '../server/sim';

export type PlayerSlot = 'p1' | 'p2';

export const MAX_INVALID_STRIKES = 3;
export const MAX_STDOUT_LINE_CHARS = 65_536;
export const MAX_LINE_QUEUE = 256;
export const MAX_LINES_PER_DECISION = 64;
export const INFO_BROADCAST_INTERVAL_MILLIS = 1_000;

export const FAULT_REASONS = new Set(['crash', 'oom', 'timeout', 'invalid-choice']);
export const INFRA_VOID_REASONS = new Set(['arbiter-stall', 'sim-error', 'arena-error']);

export interface TimerOverrides {
  startingBankSeconds?: number;
  graceSeconds?: number;
  maxTurnSeconds?: number;
  maxFirstTurnSeconds?: number;
}

export interface GameTimerOptions extends TimerOverrides {
  readyGraceSeconds?: number;
}

export const SMOKE_TIMERS: GameTimerOptions = {
  startingBankSeconds: 60,
  readyGraceSeconds: arena.READY_GRACE_SECONDS,
  maxTurnSeconds: 60,
};

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

export interface PlayerTurnState extends PlayerClockState, ProtocolStrikeState {}

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

export interface LineIoState {
  lineQueue: string[];
  lineResolver: ((line: string | undefined) => void) | undefined;
}

export function wakeLineResolver(io: LineIoState | undefined): void {
  if (!io?.lineResolver) return;
  const resolve = io.lineResolver;
  io.lineResolver = undefined;
  resolve(undefined);
}

export type WinHistoryPoint = arena.WinHistoryPoint;

export interface InfoCoalescerOptions {
  intervalMillis?: number;
  now?: () => number;
  onBroadcast?: (slot: PlayerSlot, info: protocol.PublicAgentInfo) => void;
}

export class InfoCoalescer {
  private readonly intervalMillis: number;
  private readonly now: () => number;
  private readonly onBroadcast?: (slot: PlayerSlot, info: protocol.PublicAgentInfo) => void;
  private readonly live: Record<PlayerSlot, protocol.PublicAgentInfo | undefined>;
  private readonly pending: Record<PlayerSlot, protocol.PublicAgentInfo | undefined>;
  private readonly committedByTurn: Map<
    number,
    {p1?: protocol.PublicAgentInfo; p2?: protocol.PublicAgentInfo}
  >;
  private readonly lastBroadcastAt: Record<PlayerSlot, number>;
  private readonly timers: Record<PlayerSlot, ReturnType<typeof setTimeout> | undefined>;

  constructor(options: InfoCoalescerOptions = {}) {
    this.intervalMillis = options.intervalMillis ?? INFO_BROADCAST_INTERVAL_MILLIS;
    this.now = options.now ?? (() => Date.now());
    this.onBroadcast = options.onBroadcast;
    this.live = {p1: undefined, p2: undefined};
    this.pending = {p1: undefined, p2: undefined};
    this.committedByTurn = new Map();
    this.lastBroadcastAt = {p1: -Infinity, p2: -Infinity};
    this.timers = {p1: undefined, p2: undefined};
  }

  ingest(slot: PlayerSlot, info: protocol.AgentInfo): void {
    const pub = protocol.toPublicAgentInfo(info);
    if (!pub) return;
    this.live[slot] = pub;
    this.pending[slot] = pub;
    if (!this.onBroadcast) return;

    const nowMillis = this.now();
    const elapsed = nowMillis - this.lastBroadcastAt[slot];
    if (elapsed >= this.intervalMillis) {
      this.clearTimer(slot);
      this.lastBroadcastAt[slot] = nowMillis;
      this.onBroadcast(slot, pub);
    } else if (!this.timers[slot]) {
      const delay = Math.max(1, this.intervalMillis - elapsed);
      const timer = setTimeout(() => {
        this.timers[slot] = undefined;
        const latest = this.live[slot];
        if (!latest || !this.onBroadcast) return;
        this.lastBroadcastAt[slot] = this.now();
        this.onBroadcast(slot, latest);
      }, delay);
      timer.unref?.();
      this.timers[slot] = timer;
    }
  }

  commitTurn(slot: PlayerSlot, turn: number): protocol.PublicAgentInfo | undefined {
    this.clearTimer(slot);
    const finalInfo = this.pending[slot];
    this.pending[slot] = undefined;
    if (!finalInfo) return undefined;
    this.live[slot] = finalInfo;
    let entry = this.committedByTurn.get(turn);
    if (!entry) {
      entry = {};
      this.committedByTurn.set(turn, entry);
    }
    entry[slot] = finalInfo;
    return finalInfo;
  }

  getLive(slot: PlayerSlot): protocol.PublicAgentInfo | undefined {
    return this.live[slot];
  }

  getCommittedByTurn(): ReadonlyMap<
    number,
    {p1?: protocol.PublicAgentInfo; p2?: protocol.PublicAgentInfo}
  > {
    return this.committedByTurn;
  }

  getWinHistory(): WinHistoryPoint[] {
    const points: WinHistoryPoint[] = [];
    for (const [turn, entry] of this.committedByTurn.entries()) {
      const p1 = entry.p1?.win;
      const p2 = entry.p2?.win;
      if (p1 === undefined && p2 === undefined) continue;
      points.push({
        turn,
        ...(p1 !== undefined ? {p1} : {}),
        ...(p2 !== undefined ? {p2} : {}),
      });
    }
    return points.sort((a, b) => a.turn - b.turn);
  }

  reset(): void {
    this.dispose();
    this.live.p1 = undefined;
    this.live.p2 = undefined;
    this.pending.p1 = undefined;
    this.pending.p2 = undefined;
    this.committedByTurn.clear();
    this.lastBroadcastAt.p1 = -Infinity;
    this.lastBroadcastAt.p2 = -Infinity;
  }

  dispose(): void {
    this.clearTimer('p1');
    this.clearTimer('p2');
  }

  private clearTimer(slot: PlayerSlot): void {
    const timer = this.timers[slot];
    if (timer) {
      clearTimeout(timer);
      this.timers[slot] = undefined;
    }
  }
}

export function createInfoLineInterceptor(
  slot: PlayerSlot,
  coalescer: InfoCoalescer
): (line: string) => boolean {
  return (line: string): boolean => {
    if (!protocol.isAgentInfoLine(line)) return false;
    const parsed = protocol.parseAgentStdoutLine(line);
    if (parsed?.kind === 'info') {
      coalescer.ingest(slot, parsed.info);
    }
    return true;
  };
}

export function attachStdoutLineFramer(
  proc: ChildProcessWithoutNullStreams,
  io: LineIoState,
  onOverflow: () => void,
  onLine?: (line: string) => boolean
): void {
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
        onOverflow();
        return;
      }
      if (onLine?.(line)) {
        nl = stdoutBuf.indexOf('\n');
        continue;
      }
      if (io.lineResolver) {
        const resolve = io.lineResolver;
        io.lineResolver = undefined;
        resolve(line);
      } else if (io.lineQueue.length < MAX_LINE_QUEUE) {
        io.lineQueue.push(line);
      }
      nl = stdoutBuf.indexOf('\n');
    }
    if (stdoutBuf.length > MAX_STDOUT_LINE_CHARS) {
      stdoutBuf = '';
      try {
        proc.kill('SIGKILL');
      } catch {}
      onOverflow();
    }
  });
}

export interface DecisionTelemetry {
  teamPreviewCount: number;
  totalTeamPreviewMillis: number;
  turnDecisionCount: number;
  totalTurnDecisionMillis: number;
  lastDecisionMillis?: number;
}

export function recordDecisionTelemetry(
  telemetry: DecisionTelemetry,
  elapsedMillis: number,
  teamPreview?: boolean
): void {
  if (telemetry.lastDecisionMillis !== undefined) {
    telemetry.lastDecisionMillis = elapsedMillis;
  }
  if (teamPreview) {
    telemetry.teamPreviewCount++;
    telemetry.totalTeamPreviewMillis += elapsedMillis;
  } else {
    telemetry.turnDecisionCount++;
    telemetry.totalTurnDecisionMillis += elapsedMillis;
  }
}

export function chargeDecisionClock(turn: PlayerTurnState, elapsedMillis: number): void {
  turn.bankMillis = Math.max(0, turn.bankMillis - elapsedMillis);
  if (turn.turnRemainingMillis !== undefined) {
    turn.turnRemainingMillis = Math.max(0, turn.turnRemainingMillis - elapsedMillis);
  }
}

export function applyDecisionTimeout(
  turn: PlayerTurnState,
  telemetry: DecisionTelemetry,
  totalBudgetMillis: number,
  timeoutAutoChoose: boolean,
  teamPreview?: boolean
): 'auto-choose' | 'timeout' {
  const chargedMillis = Math.max(0, totalBudgetMillis);
  turn.bankMillis = Math.max(0, turn.bankMillis - chargedMillis);
  turn.turnRemainingMillis = 0;
  if (timeoutAutoChoose && turn.bankMillis > 0) {
    recordDecisionTelemetry(telemetry, Math.max(1, Math.round(chargedMillis)), teamPreview);
    return 'auto-choose';
  }
  turn.bankMillis = 0;
  return 'timeout';
}

export async function resolveBattleConfig(opts: {
  format: string;
  version: string;
  sendUtm?: boolean;
  timerOverrides?: TimerOverrides;
}): Promise<{
  format: string;
  timers: ResolvedClockTimers;
  sendUtm: boolean;
}> {
  const format = await sim.resolveArenaFormatId(opts.format, opts.version);
  const timers = resolveClockTimers(
    await sim.getTimerSettings(format, opts.version),
    opts.timerOverrides
  );
  const sendUtm = opts.sendUtm ?? !(await sim.isGeneratedTeamFormat(format, opts.version));
  return {format, timers, sendUtm};
}

export function pumpOmniscientStream(opts: {
  battle: sim.BattleHandle;
  maxTurns: number;
  smokeStopAfterTurn?: number;
  expectedP1Name?: string;
  getState: () => {currentTurn: number; ended: boolean};
  onTurnUpdate: (turn: number) => void;
  onTerminal: (winner: PlayerSlot | 'tie', endReason: string) => void;
  onSimError: () => void;
  onChunk?: (rawChunk: string) => Promise<void> | void;
}): Promise<void> {
  const expectedP1Name = opts.expectedP1Name ?? 'Agent A';
  return (async () => {
    for await (const rawChunk of opts.battle.streams.omniscient) {
      for (const line of rawChunk.split('\n')) {
        const state = opts.getState();
        const step = inspectOmniscientLine(line, {
          currentTurn: state.currentTurn,
          maxTurns: opts.maxTurns,
          smokeStopAfterTurn: opts.smokeStopAfterTurn,
          ended: state.ended,
          expectedP1Name,
        });
        opts.onTurnUpdate(step.currentTurn);
        if (step.terminal) {
          opts.onTerminal(step.terminal.winner, step.terminal.endReason);
          if (step.terminal.forceTie) {
            await opts.battle.write('>forcetie');
          }
        }
      }
      if (opts.onChunk) {
        await opts.onChunk(rawChunk);
      }
    }
  })().catch(() => {
    opts.onSimError();
  });
}

export async function startBattleProtocol(
  battle: sim.BattleHandle,
  opts: {
    format: string;
    seed: PRNGSeed;
    p1Team?: string;
    p2Team?: string;
  }
): Promise<void> {
  await battle.write(`>start ${JSON.stringify({formatid: opts.format, seed: opts.seed})}`);
  await battle.write(`>player p1 ${JSON.stringify({name: 'Agent A', team: opts.p1Team})}`);
  await battle.write(`>player p2 ${JSON.stringify({name: 'Agent B', team: opts.p2Team})}`);
}

export interface SmokeTelemetry {
  maxInitMillis: number;
  maxTeamPreviewMillis?: number;
  maxTurnMillis: number;
  maxPeakRam: number;
}

export function recordSmokeTelemetry(
  acc: SmokeTelemetry,
  stats: {
    initMillis?: number;
    teamPreviewMillis?: number;
    meanTurnMillis: number;
    peakRam: number;
  }
): void {
  const initMillis = stats.initMillis ?? 0;
  if (initMillis > acc.maxInitMillis) acc.maxInitMillis = initMillis;
  if (
    stats.teamPreviewMillis !== undefined &&
    (acc.maxTeamPreviewMillis === undefined || stats.teamPreviewMillis > acc.maxTeamPreviewMillis)
  ) {
    acc.maxTeamPreviewMillis = stats.teamPreviewMillis;
  }
  if (stats.meanTurnMillis > acc.maxTurnMillis) acc.maxTurnMillis = stats.meanTurnMillis;
  if (stats.peakRam > acc.maxPeakRam) acc.maxPeakRam = stats.peakRam;
}

export function classifySmokeGame(
  res: {
    winner: PlayerSlot | 'tie' | 'preempted';
    endReason: string;
  },
  opts: {
    label: string;
    format: string;
    p1Stderr?: string;
    p2Stderr?: string;
  }
): {kind: 'ok'} | {kind: 'infra'; message: string} | {kind: 'fail'; message: string} {
  if (
    res.winner === 'preempted' ||
    INFRA_VOID_REASONS.has(res.endReason) ||
    (FAULT_REASONS.has(res.endReason) && res.winner === 'p1')
  ) {
    const stderrSnippet = opts.p2Stderr
      ? ` (${opts.p2Stderr.trim().replace(/\s+/g, ' ').slice(-240)})`
      : '';
    return {
      kind: 'infra',
      message:
        `${opts.label} baseline/infrastructure fault in ${opts.format}: ` +
        `${res.endReason}${stderrSnippet}`,
    };
  }
  if (FAULT_REASONS.has(res.endReason) && (res.winner === 'p2' || res.winner === 'tie')) {
    const stderrTail = opts.p1Stderr?.trim();
    return {
      kind: 'fail',
      message: stderrTail
        ? `${opts.label} failed in ${opts.format}: ${res.endReason}\n${stderrTail}`
        : `${opts.label} failed in ${opts.format}: ${res.endReason}`,
    };
  }
  return {kind: 'ok'};
}
