export const ELO_SCALE = 400 / Math.LN10;
export const GXE_C = (3 * Math.LN10 * Math.LN10) / (400 * 400 * Math.PI * Math.PI);

export type GameOutcome = 'W' | 'L' | 'T';
export type MatchCategory = 'WW' | 'WT' | 'TW' | 'WL' | 'LW' | 'TT' | 'TL' | 'LT' | 'LL';
export type TernaryMatchOutcome = 'W' | 'L' | 'T';

export interface PairMatchCounts {
  i: number;
  j: number;
  ww: number;
  wt: number;
  split: number;
  tl: number;
  ll: number;
}

export interface RatingResult {
  theta: Float64Array;
  elo: Float64Array;
  eloStd: Float64Array;
  ci95: Float64Array;
  eloLcb: Float64Array;
  eloUcb: Float64Array;
  gxe: Float64Array;
  covariance: Float64Array;
  nu0: number;
  nu1: number;
}

export interface LadderMatchState {
  id: string;
  activeBotIndices: number[];
  theta: Float64Array;
  sigma: Float64Array;
  botMatches: Int32Array;
  pairMatches: Int32Array;
  lastMatchNumber: number;
}

export interface NextMatchChoice {
  ladderId: string;
  botI: number;
  botJ: number;
  priorityScore: number;
}

function choleskyDecompose(A: Float64Array, M: number, L: Float64Array): void {
  L.fill(0);
  for (let i = 0; i < M; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i * M + j];
      for (let k = 0; k < j; k++) sum -= L[i * M + k] * L[j * M + k];
      L[i * M + j] = i === j ? Math.sqrt(Math.max(sum, 1e-12)) : sum / L[j * M + j];
    }
  }
}

function solveCholesky(
  L: Float64Array,
  b: Float64Array,
  M: number,
  out: Float64Array,
  scratch: Float64Array
): void {
  for (let i = 0; i < M; i++) {
    let sum = b[i];
    for (let k = 0; k < i; k++) sum -= L[i * M + k] * scratch[k];
    scratch[i] = sum / L[i * M + i];
  }
  for (let i = M - 1; i >= 0; i--) {
    let sum = scratch[i];
    for (let k = i + 1; k < M; k++) sum -= L[k * M + i] * out[k];
    out[i] = sum / L[i * M + i];
  }
}

function invertSPDMatrix(A: Float64Array, M: number): Float64Array {
  const L = new Float64Array(M * M);
  choleskyDecompose(A, M, L);
  const Linv = new Float64Array(M * M);
  for (let i = 0; i < M; i++) {
    Linv[i * M + i] = 1 / L[i * M + i];
    for (let j = 0; j < i; j++) {
      let sum = 0;
      for (let k = j; k < i; k++) sum -= L[i * M + k] * Linv[k * M + j];
      Linv[i * M + j] = sum / L[i * M + i];
    }
  }
  const inv = new Float64Array(M * M);
  for (let i = 0; i < M; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = 0;
      for (let k = i; k < M; k++) sum += Linv[k * M + i] * Linv[k * M + j];
      inv[i * M + j] = sum;
      inv[j * M + i] = sum;
    }
  }
  return inv;
}

export function computeDavidsonRatings(
  numBots: number,
  pairs: PairMatchCounts[],
  anchorIndex = -1,
  anchorElo = 1500,
  warmStartTheta?: Float64Array,
  priorEloStd = 350
): RatingResult {
  const M = numBots;
  if (M === 0) {
    return {
      theta: new Float64Array(0),
      elo: new Float64Array(0),
      eloStd: new Float64Array(0),
      ci95: new Float64Array(0),
      eloLcb: new Float64Array(0),
      eloUcb: new Float64Array(0),
      gxe: new Float64Array(0),
      covariance: new Float64Array(0),
      nu0: 2.0,
      nu1: 0,
    };
  }

  const theta = warmStartTheta?.length === M
    ? new Float64Array(warmStartTheta)
    : new Float64Array(M);
  let initSum = 0;
  for (let i = 0; i < M; i++) initSum += theta[i];
  const initMean = initSum / M;
  for (let i = 0; i < M; i++) theta[i] -= initMean;

  const priorSigma = priorEloStd / ELO_SCALE;
  const priorPrecision = 1 / (priorSigma * priorSigma);

  let totalSweeps = 0;
  let totalHalf = 0;
  let totalSplits = 0;
  for (const p of pairs) {
    totalSweeps += p.ww + p.ll;
    totalHalf += p.wt + p.tl;
    totalSplits += p.split;
  }
  const nu0 = Math.max(2.0, (2 * (totalSplits + 1)) / (totalSweeps + 1));
  const nu1 = totalHalf / (totalSweeps + 1);

  const nPairs = pairs.length;
  const pairN = new Float64Array(nPairs);
  const pairY = new Float64Array(nPairs);
  for (let k = 0; k < nPairs; k++) {
    const p = pairs[k];
    pairN[k] = p.ww + p.wt + p.split + p.tl + p.ll;
    pairY[k] = p.ww + 0.5 * p.wt - 0.5 * p.tl - p.ll;
  }

  const evalLogPosterior = (x: Float64Array): number => {
    let val = 0;
    for (let i = 0; i < M; i++) val -= 0.5 * priorPrecision * x[i] * x[i];
    for (let k = 0; k < nPairs; k++) {
      const N = pairN[k];
      if (N === 0) continue;
      const {i, j} = pairs[k];
      const delta = x[i] - x[j];
      const e1 = Math.exp(delta);
      const em1 = 1 / e1;
      const eh = Math.exp(0.5 * delta);
      const emh = 1 / eh;
      const Z = e1 + nu1 * eh + nu0 + nu1 * emh + em1;
      val += pairY[k] * delta - N * Math.log(Z);
    }
    return val;
  };

  const grad = new Float64Array(M);
  const H = new Float64Array(M * M);
  const L = new Float64Array(M * M);
  const step = new Float64Array(M);
  const scratch = new Float64Array(M);
  const cand = new Float64Array(M);

  // Full-matrix Cholesky Newton method with backtracking line search.
  // Unlike diagonal Jacobi updates (which oscillate on bipartite match graphs where
  // lambda_max(D^{-1} H) ~= 2), exact Newton converges quadratically to < 1e-12 in 4-6 steps.
  for (let iter = 0; iter < 25; iter++) {
    H.fill(0);
    let obj = 0;
    for (let i = 0; i < M; i++) {
      grad[i] = -priorPrecision * theta[i];
      H[i * M + i] = priorPrecision;
      obj -= 0.5 * priorPrecision * theta[i] * theta[i];
    }

    for (let k = 0; k < nPairs; k++) {
      const N = pairN[k];
      if (N === 0) continue;
      const {i, j} = pairs[k];
      const delta = theta[i] - theta[j];

      const e1 = Math.exp(delta);
      const em1 = 1 / e1;
      const eh = Math.exp(0.5 * delta);
      const emh = 1 / eh;
      const Z = e1 + nu1 * eh + nu0 + nu1 * emh + em1;
      obj += pairY[k] * delta - N * Math.log(Z);

      const p1 = e1 / Z;
      const pm1 = em1 / Z;
      const ph = (nu1 * eh) / Z;
      const pmh = (nu1 * emh) / Z;
      const mu = (p1 - pm1) + 0.5 * (ph - pmh);
      const v = (p1 + pm1) + 0.25 * (ph + pmh) - mu * mu;

      const g = pairY[k] - N * mu;
      const w = N * v;
      grad[i] += g;
      grad[j] -= g;
      H[i * M + i] += w;
      H[j * M + j] += w;
      H[i * M + j] -= w;
      H[j * M + i] -= w;
    }

    let maxGrad = 0;
    for (let i = 0; i < M; i++) {
      const ag = Math.abs(grad[i]);
      if (ag > maxGrad) maxGrad = ag;
    }
    if (maxGrad < 1e-12) break;

    choleskyDecompose(H, M, L);
    solveCholesky(L, grad, M, step, scratch);

    let alpha = 1.0;
    while (alpha > 1e-6) {
      for (let i = 0; i < M; i++) cand[i] = theta[i] + alpha * step[i];
      if (evalLogPosterior(cand) >= obj - 1e-12) break;
      alpha *= 0.5;
    }

    let maxStep = 0;
    for (let i = 0; i < M; i++) {
      const d = alpha * step[i];
      theta[i] += d;
      if (Math.abs(d) > maxStep) maxStep = Math.abs(d);
    }
    if (maxStep < 1e-12) break;
  }

  // Assemble the exact negative Hessian at the converged MAP optimum for Laplace covariance.
  H.fill(0);
  const hasPlayed = new Uint8Array(M);
  for (let i = 0; i < M; i++) H[i * M + i] = priorPrecision;

  for (let k = 0; k < nPairs; k++) {
    const N = pairN[k];
    if (N === 0) continue;
    const {i, j} = pairs[k];
    const delta = theta[i] - theta[j];
    const e1 = Math.exp(delta);
    const em1 = 1 / e1;
    const eh = Math.exp(0.5 * delta);
    const emh = 1 / eh;
    const Z = e1 + nu1 * eh + nu0 + nu1 * emh + em1;
    const p1 = e1 / Z;
    const pm1 = em1 / Z;
    const ph = (nu1 * eh) / Z;
    const pmh = (nu1 * emh) / Z;
    const mu = (p1 - pm1) + 0.5 * (ph - pmh);
    const w = N * ((p1 + pm1) + 0.25 * (ph + pmh) - mu * mu);

    H[i * M + i] += w;
    H[j * M + j] += w;
    H[i * M + j] -= w;
    H[j * M + i] -= w;
    hasPlayed[i] = 1;
    hasPlayed[j] = 1;
  }

  // Pairwise match outcomes depend only on `theta_i - theta_j`, so the indicator vector `u`
  // (`u_i = 1/K` on the `K` bots with >0 matches, `0` on 0-match bots) is an exact eigenvector
  // of `H` (`H u = priorPrecision * u`). Pinning `u^T theta = 0` removes ONLY that global shift
  // eigenvalue while keeping 0-match bots at `priorEloStd` (350 Elo) and leaving every orthogonal
  // subspace — and therefore every pairwise variance `Var(theta_i - theta_j)` — 100% exact.
  let playedCount = 0;
  for (let i = 0; i < M; i++) playedCount += hasPlayed[i];
  if (playedCount > 0) {
    const gaugeTerm = 1e6 / (playedCount * playedCount);
    for (let i = 0; i < M; i++) {
      if (!hasPlayed[i]) continue;
      for (let j = 0; j < M; j++) {
        if (!hasPlayed[j]) continue;
        H[i * M + j] += gaugeTerm;
      }
    }
  }

  const covariance = invertSPDMatrix(H, M);
  const anchorOffset = anchorIndex >= 0 && anchorIndex < M ? theta[anchorIndex] : 0;

  const elo = new Float64Array(M);
  const eloStd = new Float64Array(M);
  const ci95 = new Float64Array(M);
  const eloLcb = new Float64Array(M);
  const eloUcb = new Float64Array(M);
  const gxe = new Float64Array(M);

  for (let i = 0; i < M; i++) {
    const centeredTheta = theta[i] - anchorOffset;
    theta[i] = centeredTheta;
    elo[i] = anchorElo + ELO_SCALE * centeredTheta;
    eloStd[i] = ELO_SCALE * Math.sqrt(Math.max(0, covariance[i * M + i]));
    ci95[i] = 1.96 * eloStd[i];
    eloLcb[i] = elo[i] - ci95[i];
    eloUcb[i] = elo[i] + ci95[i];
    const denom = 400 * Math.sqrt(1 + GXE_C * (eloStd[i] * eloStd[i] + priorEloStd * priorEloStd));
    gxe[i] = 100 / (1 + Math.pow(10, -(elo[i] - anchorElo) / denom));
  }

  return {theta, elo, eloStd, ci95, eloLcb, eloUcb, gxe, covariance, nu0, nu1};
}

export function expectedMatchScore(delta: number, nu0 = 2.0, nu1 = 0): number {
  const e1 = Math.exp(delta);
  const em1 = 1 / e1;
  const eh = Math.exp(0.5 * delta);
  const emh = 1 / eh;
  const Z = e1 + nu1 * eh + nu0 + nu1 * emh + em1;
  const mu = ((e1 - em1) + 0.5 * nu1 * (eh - emh)) / Z;
  return 0.5 + 0.5 * mu;
}

export function normalCdf(z: number): number {
  if (z === 0) return 0.5;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-0.5 * z * z);
  const poly = 0.31938153 + t * (
    -0.356563782 + t * (1.781477937 + t * (-1.821255978 + 1.330274429 * t))
  );
  const p = d * t * poly;
  return z > 0 ? 1 - p : p;
}

export function computeLOS(
  theta: Float64Array,
  cov: Float64Array,
  M: number,
  i: number,
  j: number
): number {
  if (i === j) return 0.5;
  const varDiff = Math.max(1e-12, cov[i * M + i] + cov[j * M + j] - 2 * cov[i * M + j]);
  return normalCdf((theta[i] - theta[j]) / Math.sqrt(varDiff));
}

export function computeGuaranteedRankBounds(
  repIndices: number[],
  theta: Float64Array,
  cov: Float64Array,
  eloLcb: Float64Array,
  eloUcb: Float64Array,
  M: number,
  losThreshold = 0.95
): {rankMin: Int32Array; rankMax: Int32Array} {
  const B = repIndices.length;
  const rankMin = new Int32Array(B);
  const rankMax = new Int32Array(B);

  for (let a = 0; a < B; a++) {
    const i = repIndices[a];
    let definitelyAbove = 0;
    let plausiblyAbove = 0;
    for (let b = 0; b < B; b++) {
      if (a === b) continue;
      const j = repIndices[b];
      const losIJ = computeLOS(theta, cov, M, i, j);
      if (1 - losIJ >= losThreshold && eloLcb[j] > eloUcb[i]) {
        definitelyAbove++;
      }
      if (b < a || (losIJ < losThreshold && eloUcb[j] > eloLcb[i])) {
        plausiblyAbove++;
      }
    }
    rankMin[a] = 1 + definitelyAbove;
    rankMax[a] = 1 + plausiblyAbove;
  }
  return {rankMin, rankMax};
}

export function toTernaryMatchOutcome(
  matchCategory: MatchCategory
): {v1: TernaryMatchOutcome; v2: TernaryMatchOutcome} {
  if (matchCategory === 'WW' || matchCategory === 'WT' || matchCategory === 'TW') {
    return {v1: 'W', v2: 'L'};
  }
  if (matchCategory === 'LL' || matchCategory === 'LT' || matchCategory === 'TL') {
    return {v1: 'L', v2: 'W'};
  }
  return {v1: 'T', v2: 'T'};
}

export function applyMatchOutcomeToStreaks(
  row: {
    curWinStreak: number;
    curLossStreak: number;
    maxWinStreak: number;
    maxLossStreak: number;
  },
  outcome: TernaryMatchOutcome
): void {
  if (outcome === 'W') {
    row.curWinStreak += 1;
    row.curLossStreak = 0;
    if (row.curWinStreak > row.maxWinStreak) row.maxWinStreak = row.curWinStreak;
  } else if (outcome === 'L') {
    row.curLossStreak += 1;
    row.curWinStreak = 0;
    if (row.curLossStreak > row.maxLossStreak) row.maxLossStreak = row.curLossStreak;
  } else {
    row.curWinStreak = 0;
    row.curLossStreak = 0;
  }
}

export function applyPairwiseStreakUpdate(
  pairRow: {curStreak: number; vLowMaxWinStreak: number; vHighMaxWinStreak: number},
  vLowOutcome: TernaryMatchOutcome
): void {
  if (vLowOutcome === 'W') {
    pairRow.curStreak = pairRow.curStreak > 0 ? pairRow.curStreak + 1 : 1;
    if (pairRow.curStreak > pairRow.vLowMaxWinStreak) {
      pairRow.vLowMaxWinStreak = pairRow.curStreak;
    }
  } else if (vLowOutcome === 'L') {
    pairRow.curStreak = pairRow.curStreak < 0 ? pairRow.curStreak - 1 : -1;
    const highStreak = -pairRow.curStreak;
    if (highStreak > pairRow.vHighMaxWinStreak) {
      pairRow.vHighMaxWinStreak = highStreak;
    }
  } else {
    pairRow.curStreak = 0;
  }
}

export function advanceTopKClock(
  enteredAt: number | null,
  maxStreakS: number,
  totalS: number,
  qualifiesNow: boolean,
  nowSec: number,
  deltaSec: number
): {enteredAt: number | null; maxStreakS: number; totalS: number} {
  let nextEntered = enteredAt;
  let nextMax = maxStreakS;
  let nextTotal = totalS;

  if (enteredAt !== null) {
    nextTotal += deltaSec;
    const currentRunS = Math.max(0, nowSec - enteredAt);
    if (currentRunS > nextMax) nextMax = currentRunS;
    if (!qualifiesNow) nextEntered = null;
  } else if (qualifiesNow) {
    nextEntered = nowSec;
  }

  return {enteredAt: nextEntered, maxStreakS: nextMax, totalS: nextTotal};
}

export function selectNextArenaMatch(
  ladders: LadderMatchState[],
  globalMatchCount: number,
  exploit = 0.45,
  agingRate = 0.50,
  maxWaitCycles = 4
): NextMatchChoice {
  const activeLadders = ladders.filter(l => l.activeBotIndices.length >= 2);
  if (activeLadders.length === 0) throw new Error('No ladder has >= 2 active bots');
  const K = activeLadders.length;

  const starved = activeLadders.filter(
    l => globalMatchCount - l.lastMatchNumber >= maxWaitCycles * K
  );
  const candidates = starved.length > 0 ? starved : activeLadders;

  let best: NextMatchChoice | null = null;

  for (const ladder of candidates) {
    const M = ladder.theta.length;
    const act = ladder.activeBotIndices;
    const k = act.length;
    const {theta, sigma, botMatches, pairMatches} = ladder;

    const byTheta = act.slice().sort((a, b) => theta[b] - theta[a]);
    const byUCB = act.slice().sort(
      (a, b) => (theta[b] + 1.5 * sigma[b]) - (theta[a] + 1.5 * sigma[a])
    );
    const rank = new Int32Array(M);
    const ucbRank = new Int32Array(M);
    for (let r = 0; r < k; r++) {
      rank[byTheta[r]] = r;
      ucbRank[byUCB[r]] = r;
    }

    const topWeight = new Float64Array(M);
    for (const i of act) {
      const q = Math.min(rank[i], ucbRank[i]) / Math.max(1, k - 1);
      topWeight[i] = (1 - exploit) + exploit * 20.0 * Math.exp(-5.5 * q);
    }

    const thetaTop10 = theta[byTheta[Math.min(k - 1, 9)]];
    const thetaTop5 = theta[byTheta[Math.min(k - 1, 4)]];
    const inTriage = new Uint8Array(M);
    for (const i of act) {
      const ucb90 = theta[i] + 1.28 * sigma[i];
      if (botMatches[i] < 2 || (exploit > 0 && sigma[i] > 0.36 && ucb90 >= thetaTop10)) {
        inTriage[i] = 1;
      }
    }

    const matchesWaiting = Math.max(0, globalMatchCount - ladder.lastMatchNumber);
    const agingBoost = 1 + agingRate * (matchesWaiting / K);

    for (let a = 0; a < k; a++) {
      const i = act[a];
      for (let b = a + 1; b < k; b++) {
        const j = act[b];
        const diff = theta[i] - theta[j];
        const varSum = sigma[i] * sigma[i] + sigma[j] * sigma[j];

        const p = 1 / (1 + Math.exp(-diff));
        const infoGain = 0.5 * Math.log(1 + 4 * p * (1 - p) * varSum);
        const overlap = 0.20 + 3.5 * Math.exp(-(diff * diff) / (2 * (varSum + 0.04)));

        let triageBonus = 1.0;
        if (inTriage[i] || inTriage[j]) {
          const newBot = inTriage[i] ? i : j;
          const anchor = inTriage[i] ? j : i;
          const target =
            botMatches[newBot] === 0 ? thetaTop5
            : botMatches[newBot] === 1 ? thetaTop10
            : Math.max(thetaTop10, theta[newBot]);
          triageBonus = 1.0 + 2.0 * Math.exp(-Math.abs(theta[anchor] - target));
        }

        const mij = pairMatches[i * M + j];
        const withinWeight = Math.sqrt(topWeight[i] * topWeight[j]) * overlap * triageBonus;
        const repeatDamper = 1 / (1 + 0.25 * mij);
        const score = infoGain * withinWeight * repeatDamper * agingBoost;

        if (!best || score > best.priorityScore) {
          best = {ladderId: ladder.id, botI: i, botJ: j, priorityScore: score};
        }
      }
    }
  }
  return best!;
}
