require('source-map-support').install();

import {parseArgs} from 'util';

import {Database} from '../db';
import {
  ELO_SCALE,
  LadderMatchState,
  PairMatchCounts,
  computeDavidsonRatings,
  computeGuaranteedRankBounds,
  selectNextArenaMatch,
} from '../server/ratings';

export interface SimulationOptions {
  numLadders?: number;
  agentsPerLadder?: number;
  totalMatches?: number;
  exploit?: number;
  agingRate?: number;
  maxWaitCycles?: number;
  seed?: number;
  nu0?: number;
  nu1?: number;
  initialLadders?: Array<{
    id: string;
    trueElo: Float64Array;
  }>;
}

export interface SimulationReport {
  exploit: number;
  agingRate: number;
  maxWaitCycles: number;
  seed: number;
  totalMatches: number;
  meanInfoGainNats: number;
  meanEloError: number;
  kendallTau: number;
  top3Accuracy: number;
  topContenderMatchShare: number;
  minAgentMatches: number;
  maxAgentMatches: number;
  minLadderShare: number;
  maxLadderShare: number;
  matchesToSettleAll?: number;
  matchesToSettleTop1?: number;
}

export interface SweepOptions {
  numLadders?: number;
  agentsPerLadder?: number;
  totalMatches?: number;
  exploits: number[];
  agingRates: number[];
  maxWaitCyclesList: number[];
  seeds: number[];
  initialLadders?: SimulationOptions['initialLadders'];
}

export interface SweepSummary {
  exploit: number;
  agingRate: number;
  maxWaitCycles: number;
  seeds: number;
  meanInfoGainNats: number;
  meanEloError: number;
  kendallTau: number;
  top3Accuracy: number;
  topContenderMatchShare: number;
  minAgentMatches: number;
  maxAgentMatches: number;
  minLadderShare: number;
  maxLadderShare: number;
  settledAllRate: number;
  settledTop1Rate: number;
  medianMatchesToSettleAll?: number;
  medianMatchesToSettleTop1?: number;
}

function createPrng(seed: number): () => number {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function computeKendallTau(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 1;
  let concordant = 0;
  let discordant = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const da = a[i] - a[j];
      const db = b[i] - b[j];
      const prod = da * db;
      if (prod > 0) concordant++;
      else if (prod < 0) discordant++;
    }
  }
  const totalPairs = (n * (n - 1)) / 2;
  return totalPairs > 0 ? (concordant - discordant) / totalPairs : 1;
}

function buildDefaultTrueElos(numLadders: number, agentsPerLadder: number): Array<{
  id: string;
  trueElo: Float64Array;
}> {
  const ladders: Array<{id: string; trueElo: Float64Array}> = [];
  for (let l = 0; l < numLadders; l++) {
    const trueElo = new Float64Array(agentsPerLadder);
    // Index 0 is the 1500 Elo anchor; remaining agents span 1200..1850 with a competitive top pack
    trueElo[0] = 1500;
    for (let i = 1; i < agentsPerLadder; i++) {
      const q = (i - 1) / Math.max(1, agentsPerLadder - 2);
      trueElo[i] = Math.round(1850 - 650 * Math.pow(q, 1.15) - l * 5);
    }
    ladders.push({id: `ladder-${l + 1}`, trueElo});
  }
  return ladders;
}

function sampleDavidsonCategory(
  delta: number,
  nu0: number,
  nu1: number,
  rng: () => number
): 'ww' | 'wt' | 'split' | 'tl' | 'll' {
  const e1 = Math.exp(delta);
  const em1 = 1 / e1;
  const eh = Math.exp(0.5 * delta);
  const emh = 1 / eh;
  const wWW = e1;
  const wWT = nu1 * eh;
  const wSplit = nu0;
  const wTL = nu1 * emh;
  const wLL = em1;
  const z = wWW + wWT + wSplit + wTL + wLL;
  const u = rng() * z;
  if (u < wWW) return 'ww';
  if (u < wWW + wWT) return 'wt';
  if (u < wWW + wWT + wSplit) return 'split';
  if (u < wWW + wWT + wSplit + wTL) return 'tl';
  return 'll';
}

export function runMatchmakingSimulation(options: SimulationOptions = {}): SimulationReport {
  const numLadders = options.numLadders ?? 3;
  const agentsPerLadder = options.agentsPerLadder ?? 10;
  const totalMatches = options.totalMatches ?? 120;
  const exploit = options.exploit ?? 0.45;
  const agingRate = options.agingRate ?? 0.50;
  const maxWaitCycles = options.maxWaitCycles ?? 4;
  const seed = options.seed ?? 1;
  const nu0 = options.nu0 ?? 2.2;
  const nu1 = options.nu1 ?? 0.04;

  const rng = createPrng(seed);
  const specs = options.initialLadders ?? buildDefaultTrueElos(numLadders, agentsPerLadder);
  const priorSigma = 350 / ELO_SCALE;

  const ladderStates = specs.map(spec => {
    const M = spec.trueElo.length;
    const activeAgentIndices = Array.from({length: M}, (_, i) => i);
    const agentIds = new Int32Array(M);
    for (let i = 0; i < M; i++) agentIds[i] = i + 1;
    const theta = new Float64Array(M);
    const sigma = new Float64Array(M).fill(priorSigma);
    const ci95 = new Float64Array(M).fill(1.96 * 350);
    const elo = new Float64Array(M).fill(1500);
    const eloLcb = new Float64Array(M).fill(1500 - 1.96 * 350);
    const eloUcb = new Float64Array(M).fill(1500 + 1.96 * 350);
    const covariance = new Float64Array(M * M);
    for (let i = 0; i < M; i++) covariance[i * M + i] = priorSigma * priorSigma;
    const agentMatches = new Int32Array(M);
    const pairMatches = new Int32Array(M * M);
    const pairMap = new Map<number, PairMatchCounts>();

    const trueOrder = Array.from({length: M}, (_, i) => i)
      .sort((a, b) => spec.trueElo[b] - spec.trueElo[a]);
    const trueTop5 = new Set(trueOrder.slice(0, Math.min(5, M)));
    const trueTop3 = new Set(trueOrder.slice(0, Math.min(3, M)));

    const matchState: LadderMatchState = {
      id: spec.id,
      activeAgentIndices,
      agentIds,
      minAgents: 2,
      theta,
      sigma,
      agentMatches,
      pairMatches,
      lastMatchNumber: 0,
    };

    return {
      spec,
      M,
      matchState,
      pairMap,
      elo,
      ci95,
      eloLcb,
      eloUcb,
      covariance,
      trueOrder,
      trueTop5,
      trueTop3,
      matchesPlayed: 0,
    };
  });

  const byId = new Map(ladderStates.map(ls => [ls.spec.id, ls]));
  let totalInfoGain = 0;
  let topContenderMatches = 0;
  let matchesToSettleAll: number | undefined;
  let matchesToSettleTop1: number | undefined;

  for (let step = 0; step < totalMatches; step++) {
    const choice = selectNextArenaMatch(
      ladderStates.map(ls => ls.matchState),
      step,
      exploit,
      agingRate,
      maxWaitCycles
    );
    const ls = byId.get(choice.ladderId)!;
    const i = Math.min(choice.agentI, choice.agentJ);
    const j = Math.max(choice.agentI, choice.agentJ);

    const diffEst = ls.matchState.theta[i] - ls.matchState.theta[j];
    const varSum =
      ls.matchState.sigma[i] * ls.matchState.sigma[i] +
      ls.matchState.sigma[j] * ls.matchState.sigma[j];
    const pEst = 1 / (1 + Math.exp(-diffEst));
    totalInfoGain += 0.5 * Math.log(1 + 4 * pEst * (1 - pEst) * varSum);

    if (ls.trueTop5.has(i) && ls.trueTop5.has(j)) {
      topContenderMatches++;
    }

    const trueDelta = (ls.spec.trueElo[i] - ls.spec.trueElo[j]) / ELO_SCALE;
    const cat = sampleDavidsonCategory(trueDelta, nu0, nu1, rng);
    const key = i * ls.M + j;
    let pair = ls.pairMap.get(key);
    if (!pair) {
      pair = {i, j, ww: 0, wt: 0, split: 0, tl: 0, ll: 0};
      ls.pairMap.set(key, pair);
    }
    pair[cat]++;

    ls.matchState.agentMatches[i]++;
    ls.matchState.agentMatches[j]++;
    ls.matchState.pairMatches[i * ls.M + j]++;
    ls.matchState.pairMatches[j * ls.M + i]++;
    ls.matchState.lastMatchNumber = step + 1;
    ls.matchesPlayed++;

    const solved = computeDavidsonRatings(
      ls.M,
      Array.from(ls.pairMap.values()),
      0,
      1500,
      ls.matchState.theta
    );
    ls.matchState.theta.set(solved.theta);
    for (let a = 0; a < ls.M; a++) {
      ls.matchState.sigma[a] = solved.eloStd[a] / ELO_SCALE;
    }
    ls.elo.set(solved.elo);
    ls.ci95.set(solved.ci95);
    ls.eloLcb.set(solved.eloLcb);
    ls.eloUcb.set(solved.eloUcb);
    ls.covariance.set(solved.covariance);

    if (matchesToSettleAll === undefined) {
      const allSettled = ladderStates.every(l => {
        for (let a = 0; a < l.M; a++) {
          if (l.ci95[a] >= 150 || l.matchState.agentMatches[a] === 0) return false;
        }
        return true;
      });
      if (allSettled) matchesToSettleAll = step + 1;
    }

    if (matchesToSettleTop1 === undefined) {
      const top1Settled = ladderStates.every(l => {
        const rep = Array.from({length: l.M}, (_, a) => a)
          .sort((a, b) => l.eloLcb[b] - l.eloLcb[a]);
        const bounds = computeGuaranteedRankBounds(
          rep,
          l.matchState.theta,
          l.covariance,
          l.eloLcb,
          l.eloUcb,
          l.M
        );
        return bounds.rankMin[0] === 1 && bounds.rankMax[0] === 1;
      });
      if (top1Settled) matchesToSettleTop1 = step + 1;
    }
  }

  let totalEloError = 0;
  let totalAgents = 0;
  let totalTau = 0;
  let totalTop3Hits = 0;
  let totalTop3Denom = 0;
  let minAgentMatches = Infinity;
  let maxAgentMatches = 0;
  let minLadderShare = Infinity;
  let maxLadderShare = 0;

  for (const ls of ladderStates) {
    const share = totalMatches > 0 ? ls.matchesPlayed / totalMatches : 0;
    if (share < minLadderShare) minLadderShare = share;
    if (share > maxLadderShare) maxLadderShare = share;

    for (let a = 0; a < ls.M; a++) {
      const m = ls.matchState.agentMatches[a];
      if (m < minAgentMatches) minAgentMatches = m;
      if (m > maxAgentMatches) maxAgentMatches = m;
      totalEloError += Math.abs(ls.elo[a] - ls.spec.trueElo[a]);
      totalAgents++;
    }
    totalTau += computeKendallTau(ls.elo, ls.spec.trueElo);

    const estOrder = Array.from({length: ls.M}, (_, a) => a)
      .sort((a, b) => ls.eloLcb[b] - ls.eloLcb[a]);
    const topK = Math.min(3, ls.M);
    for (let r = 0; r < topK; r++) {
      if (ls.trueTop3.has(estOrder[r])) totalTop3Hits++;
      totalTop3Denom++;
    }
  }

  return {
    exploit,
    agingRate,
    maxWaitCycles,
    seed,
    totalMatches,
    meanInfoGainNats: totalMatches > 0 ? totalInfoGain / totalMatches : 0,
    meanEloError: totalAgents > 0 ? totalEloError / totalAgents : 0,
    kendallTau: ladderStates.length > 0 ? totalTau / ladderStates.length : 1,
    top3Accuracy: totalTop3Denom > 0 ? totalTop3Hits / totalTop3Denom : 1,
    topContenderMatchShare: totalMatches > 0 ? topContenderMatches / totalMatches : 0,
    minAgentMatches: Number.isFinite(minAgentMatches) ? minAgentMatches : 0,
    maxAgentMatches,
    minLadderShare: Number.isFinite(minLadderShare) ? minLadderShare : 0,
    maxLadderShare,
    matchesToSettleAll,
    matchesToSettleTop1,
  };
}

function medianOf(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export function sweepMatchmakingParameters(grid: SweepOptions): SweepSummary[] {
  const summaries: SweepSummary[] = [];
  for (const exploit of grid.exploits) {
    for (const agingRate of grid.agingRates) {
      for (const maxWaitCycles of grid.maxWaitCyclesList) {
        const reports = grid.seeds.map(seed =>
          runMatchmakingSimulation({
            numLadders: grid.numLadders,
            agentsPerLadder: grid.agentsPerLadder,
            totalMatches: grid.totalMatches,
            exploit,
            agingRate,
            maxWaitCycles,
            seed,
            initialLadders: grid.initialLadders,
          }));
        const mean = (fn: (r: SimulationReport) => number) =>
          reports.reduce((acc, r) => acc + fn(r), 0) / Math.max(1, reports.length);
        const settledAll = reports
          .map(r => r.matchesToSettleAll)
          .filter((v): v is number => v !== undefined);
        const settledTop1 = reports
          .map(r => r.matchesToSettleTop1)
          .filter((v): v is number => v !== undefined);

        summaries.push({
          exploit,
          agingRate,
          maxWaitCycles,
          seeds: reports.length,
          meanInfoGainNats: mean(r => r.meanInfoGainNats),
          meanEloError: mean(r => r.meanEloError),
          kendallTau: mean(r => r.kendallTau),
          top3Accuracy: mean(r => r.top3Accuracy),
          topContenderMatchShare: mean(r => r.topContenderMatchShare),
          minAgentMatches: mean(r => r.minAgentMatches),
          maxAgentMatches: mean(r => r.maxAgentMatches),
          minLadderShare: mean(r => r.minLadderShare),
          maxLadderShare: mean(r => r.maxLadderShare),
          settledAllRate: settledAll.length / Math.max(1, reports.length),
          settledTop1Rate: settledTop1.length / Math.max(1, reports.length),
          medianMatchesToSettleAll: medianOf(settledAll),
          medianMatchesToSettleTop1: medianOf(settledTop1),
        });
      }
    }
  }
  return summaries;
}

function loadInitialLaddersFromDb(dbPath: string): SimulationOptions['initialLadders'] {
  const db = new Database(dbPath);
  try {
    const ladders = db.getPlayableLadders();
    const out: NonNullable<SimulationOptions['initialLadders']> = [];
    for (const l of ladders) {
      const entries = db.getLeaderboardEntries(l.id).filter(
        e => e.role === 'champion' || e.role === 'challenger'
      );
      if (entries.length < 2) continue;
      out.push({
        id: l.id,
        trueElo: new Float64Array(entries.map(e => e.elo)),
      });
    }
    return out.length > 0 ? out : undefined;
  } finally {
    db.close();
  }
}

function parseNumberList(raw: string): number[] {
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      const n = Number(s);
      if (!Number.isFinite(n)) throw new Error(`Invalid numeric value "${s}"`);
      return n;
    });
}

function parseSeeds(raw: string): number[] {
  if (raw.includes(',')) return parseNumberList(raw);
  const count = Math.max(1, Math.floor(Number(raw) || 1));
  return Array.from({length: count}, (_, i) => i + 1);
}

function runCli() {
  const {values} = parseArgs({
    options: {
      ladders: {type: 'string', default: '3'},
      agents: {type: 'string', default: '10'},
      matches: {type: 'string', default: '150'},
      exploit: {type: 'string', default: '0.0,0.45,0.80'},
      aging: {type: 'string', default: '0.50'},
      'max-wait': {type: 'string', default: '4'},
      seeds: {type: 'string', default: '3'},
      db: {type: 'string'},
    },
  });

  const initialLadders = values.db ? loadInitialLaddersFromDb(values.db) : undefined;
  const numLadders = initialLadders?.length ?? (Number(values.ladders) || 3);
  const agentsPerLadder = Number(values.agents) || 10;
  const totalMatches = Number(values.matches) || 150;
  const exploits = parseNumberList(values.exploit);
  const agingRates = parseNumberList(values.aging);
  const maxWaitCyclesList = parseNumberList(values['max-wait']);
  const seeds = parseSeeds(values.seeds);

  const summaries = sweepMatchmakingParameters({
    numLadders,
    agentsPerLadder,
    totalMatches,
    exploits,
    agingRates,
    maxWaitCyclesList,
    seeds,
    initialLadders,
  });

  console.log(
    `Matchmaking simulation: ${numLadders} ladder(s), ` +
    `${totalMatches} matches, ${seeds.length} seed(s)\n`
  );
  for (const s of summaries) {
    const settleAllStr = s.medianMatchesToSettleAll !== undefined
      ? `${s.medianMatchesToSettleAll} matches (${Math.round(s.settledAllRate * 100)}%)`
      : 'unsettled';
    const settleTop1Str = s.medianMatchesToSettleTop1 !== undefined
      ? `${s.medianMatchesToSettleTop1} matches (${Math.round(s.settledTop1Rate * 100)}%)`
      : 'unsettled';
    console.log(
      `exploit=${s.exploit.toFixed(2)} aging=${s.agingRate.toFixed(2)} ` +
      `maxWait=${s.maxWaitCycles} (${s.seeds} seeds)`
    );
    console.log(
      `  info gain:       ${s.meanInfoGainNats.toFixed(3)} nats/match | ` +
      `top-5 pair share: ${(s.topContenderMatchShare * 100).toFixed(1)}%`
    );
    console.log(
      `  rating accuracy: mean error ${s.meanEloError.toFixed(1)} Elo | ` +
      `Kendall tau ${s.kendallTau.toFixed(3)} | ` +
      `Top-3 ${Math.round(s.top3Accuracy * 100)}%`
    );
    console.log(
      `  balance:         agent matches ${s.minAgentMatches.toFixed(1)}..` +
      `${s.maxAgentMatches.toFixed(1)} | ` +
      `ladder share ${(s.minLadderShare * 100).toFixed(1)}%..` +
      `${(s.maxLadderShare * 100).toFixed(1)}%`
    );
    console.log(
      `  convergence:     all <150 CI95: ${settleAllStr} | #1 [1,1]: ${settleTop1Str}\n`
    );
  }
}

if (require.main === module) {
  runCli();
}
