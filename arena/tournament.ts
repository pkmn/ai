import {ChildProcessWithoutNullStreams, execFileSync, spawn} from 'child_process';
import * as readline from 'readline';

import {BattleStreams, Dex, PRNGSeed, PokemonSet, TeamValidator, Teams} from '@pkmn/sim';

import * as arena from '../server/arena';
import {filterPlayerProtocolChunk, parseAgentStdoutLine} from '../server/protocol';
import {GameOutcome} from '../server/ratings';
import {ensureSimConfigured, resolveArenaFormatId} from '../server/teams';
import {toID} from '../static/util';

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
}

interface RemoteTournamentPlayer {
  slot: PlayerSlot;
  spec: TournamentAgentSpec;
  proc: ChildProcessWithoutNullStreams;
  lineQueue: string[];
  lineResolver: ((line: string | undefined) => void) | undefined;
  localTurnMsQueue: number[];
  spotPreempted: boolean;
  sshDisconnected: boolean;
  bankMs: number;
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
const MAX_CHAT_LINES_PER_DECISION = 1;
const MAX_CHAT_MESSAGE_CHARS = 500;

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

    const player: RemoteTournamentPlayer = {
      slot,
      spec,
      proc,
      lineQueue: [],
      lineResolver: undefined,
      localTurnMsQueue: [],
      spotPreempted: false,
      sshDisconnected: false,
      bankMs: this.startingBankMs,
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
        const ms = Number(errLine.slice('ARENA_TURN_MS='.length).trim());
        if (Number.isFinite(ms) && ms >= 0) {
          player.localTurnMsQueue.push(ms);
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

  private readLineWithTimeout(
    player: RemoteTournamentPlayer,
    budgetMs: number
  ): Promise<{line: string | undefined; elapsedMs: number; timedOut: boolean}> {
    const startNs = process.hrtime.bigint();

    if (player.lineQueue.length > 0) {
      const line = player.lineQueue.shift()!;
      const wallMs = Number(process.hrtime.bigint() - startNs) / 1e6;
      const localMs = line.length > 0 ? player.localTurnMsQueue.shift() : undefined;
      const elapsedMs = localMs ?? wallMs;
      return Promise.resolve({line, elapsedMs, timedOut: false});
    }
    if (player.exited) {
      return Promise.resolve({line: undefined, elapsedMs: 0, timedOut: false});
    }

    return new Promise(resolve => {
      // Allow +1500 ms network slack on the arbiter timer so local VM clock is authoritative
      const timer = setTimeout(() => {
        player.lineResolver = undefined;
        resolve({line: undefined, elapsedMs: budgetMs, timedOut: true});
      }, Math.max(1, Math.ceil(budgetMs + 1500)));

      player.lineResolver = line => {
        clearTimeout(timer);
        const wallMs = Number(process.hrtime.bigint() - startNs) / 1e6;
        const localMs = line && line.length > 0 ? player.localTurnMsQueue.shift() : undefined;
        const elapsedMs = localMs ?? wallMs;
        resolve({line, elapsedMs, timedOut: false});
      };
    });
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

  private abortForSpotPreemption(slot: PlayerSlot) {
    if (this.ended) return;
    this.ended = true;
    this.winner = 'preempted';
    this.preemptedSlot = slot;
    this.endReason = 'spot_preemption';
    Promise.resolve(this.battleStream.write('>forcetie')).catch(() => undefined);
  }

  private forfeit(losingSlot: PlayerSlot, reason: string) {
    if (this.ended) return;
    this.ended = true;
    this.winner = losingSlot === 'p1' ? 'p2' : 'p1';
    this.endReason = reason;
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
    const totalBudgetMs = graceMs + Math.min(player.bankMs, this.maxTurnMs);

    let remainingBudgetMs = totalBudgetMs;
    let totalElapsedMs = 0;
    let linesReadThisDecision = 0;
    let chatLinesThisDecision = 0;
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
          this.forfeit(player.slot, 'timeout');
          return;
        }
        if (line === undefined) {
          this.forfeit(player.slot, 'crash');
          return;
        }

        linesReadThisDecision++;
        if (linesReadThisDecision > MAX_LINES_PER_DECISION) {
          this.forfeit(player.slot, 'crash');
          return;
        }

        const parsed = parseAgentStdoutLine(line);
        if (!parsed) continue;

        if (parsed.kind === 'chat') {
          if (chatLinesThisDecision < MAX_CHAT_LINES_PER_DECISION) {
            chatLinesThisDecision++;
            const chatAuthor = this.byot
              ? player.spec.displayName
              : (player.slot === 'p1' ? 'Agent A' : 'Agent B');
            const safeMsg = parsed.message.slice(0, MAX_CHAT_MESSAGE_CHARS);
            await this.battleStream.write(`>chat ${chatAuthor}|${safeMsg}`);
          }
          continue;
        }

        const overGraceMs = Math.max(0, totalElapsedMs - graceMs);
        player.bankMs = Math.max(0, player.bankMs - overGraceMs);

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
        for (const line of chunk.split('\n')) {
          if (line.startsWith('|request|')) {
            const jsonStr = line.slice('|request|'.length).trim();
            if (jsonStr && jsonStr !== 'null') {
              try {
                const parsed = JSON.parse(jsonStr) as {wait?: boolean};
                if (!parsed.wait) {
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
              this.forfeit(player.slot, 'invalid_choice_limit');
            } else if (line.startsWith('|error|[Invalid choice]') && player.lastRequestJson) {
              actionableReqJson = player.lastRequestJson;
              if (!player.exited && player.proc.stdin.writable) {
                player.proc.stdin.write(`|request|${player.lastRequestJson}\n`);
              }
            }
          }
        }

        if (!player.exited && player.proc.stdin.writable) {
          player.proc.stdin.write(`${chunk}\n`);
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
        };
      }

      const omniTask = (async () => {
        for await (const rawChunk of this.streams.omniscient) {
          for (const line of rawChunk.split('\n')) {
            if (line.startsWith('|turn|')) {
              this.currentTurn = parseInt(line.slice('|turn|'.length), 10);
              if (this.currentTurn > this.maxTurns && !this.ended) {
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
