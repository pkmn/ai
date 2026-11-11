import {
  ELO_SCALE,
  GXE_C,
  type MatchCategory,
  type PairMatchCounts,
  advanceTopKClock,
  applyMatchOutcomeToStreaks,
  applyPairwiseStreakUpdate,
  computeDavidsonRatings,
  computeGuaranteedRankBounds,
  computeLOS,
  expectedMatchScore,
  normalCdf,
  selectNextArenaMatch,
  toTernaryMatchOutcome,
} from '../server/ratings';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function logPosterior(
  theta: Float64Array,
  pairs: PairMatchCounts[],
  nu0: number,
  nu1: number,
  priorEloStd = 350
): number {
  const priorSigma = priorEloStd / ELO_SCALE;
  const priorPrec = 1 / (priorSigma * priorSigma);
  let val = 0;
  for (const t of theta) {
    val -= 0.5 * priorPrec * t * t;
  }
  for (const p of pairs) {
    const N = p.ww + p.wt + p.split + p.tl + p.ll;
    if (N === 0) continue;
    const Y = p.ww + 0.5 * p.wt - 0.5 * p.tl - p.ll;
    const d = theta[p.i] - theta[p.j];
    const Z =
      Math.exp(d) +
      nu1 * Math.exp(0.5 * d) +
      nu0 +
      nu1 * Math.exp(-0.5 * d) +
      Math.exp(-d);
    val += Y * d - N * Math.log(Z);
  }
  return val;
}

describe('Generalized Davidson MAP rating solver (server/ratings.ts)', () => {
  test('handles empty and zero-match ladders cleanly at the prior', () => {
    const empty = computeDavidsonRatings(0, []);
    expect(empty.elo).toHaveLength(0);
    expect(empty.covariance).toHaveLength(0);

    const unplayed = computeDavidsonRatings(4, [], 0, 1500);
    for (let i = 0; i < 4; i++) {
      expect(unplayed.theta[i]).toBeCloseTo(0, 10);
      expect(unplayed.elo[i]).toBeCloseTo(1500, 10);
      expect(unplayed.eloStd[i]).toBeCloseTo(350, 8);
      expect(unplayed.ci95[i]).toBeCloseTo(1.96 * 350, 6);
      expect(unplayed.gxe[i]).toBeCloseTo(50, 8);
      for (let j = i + 1; j < 4; j++) {
        expect(computeLOS(unplayed.theta, unplayed.covariance, 4, i, j)).toBeCloseTo(0.5, 10);
      }
    }
    expect(unplayed.nu0).toBe(2.0);
    expect(unplayed.nu1).toBe(0);
  });

  test('satisfies exact first-order KKT optimality (grad = 0) on asymmetric 5-cat data', () => {
    const pairs: PairMatchCounts[] = [
      {i: 0, j: 1, ww: 19, wt: 4, split: 9, tl: 2, ll: 3},
      {i: 0, j: 2, ww: 27, wt: 3, split: 6, tl: 1, ll: 1},
      {i: 0, j: 3, ww: 34, wt: 2, split: 4, tl: 0, ll: 0},
      {i: 1, j: 2, ww: 14, wt: 5, split: 12, tl: 3, ll: 6},
      {i: 1, j: 3, ww: 22, wt: 2, split: 8, tl: 1, ll: 2},
      {i: 2, j: 3, ww: 16, wt: 1, split: 11, tl: 2, ll: 5},
    ];
    const res = computeDavidsonRatings(4, pairs, 2, 1500);

    // Recover the zero-mean MAP vector before the final anchor translation
    let mean = 0;
    for (let i = 0; i < 4; i++) mean += res.theta[i];
    mean /= 4;
    const thetaZeroMean = res.theta.map(v => v - mean);

    // Finite-difference gradient of J(theta) must vanish (< 1e-7) in every coordinate
    const eps = 1e-6;
    for (let i = 0; i < 4; i++) {
      const plus = new Float64Array(thetaZeroMean);
      const minus = new Float64Array(thetaZeroMean);
      plus[i] += eps;
      minus[i] -= eps;
      const fdGrad =
        (logPosterior(plus, pairs, res.nu0, res.nu1) -
          logPosterior(minus, pairs, res.nu0, res.nu1)) /
        (2 * eps);
      expect(Math.abs(fdGrad)).toBeLessThan(1e-7);
    }

    // Verify finite-difference negative Hessian matches the pairwise Laplace covariance
    const eps2 = 1e-4;
    const Hfd = new Float64Array(16);
    const f0 = logPosterior(thetaZeroMean, pairs, res.nu0, res.nu1);
    for (let i = 0; i < 4; i++) {
      for (let j = i; j < 4; j++) {
        if (i === j) {
          const p = new Float64Array(thetaZeroMean);
          const m = new Float64Array(thetaZeroMean);
          p[i] += eps2;
          m[i] -= eps2;
          const d2 =
            (logPosterior(p, pairs, res.nu0, res.nu1) -
              2 * f0 +
              logPosterior(m, pairs, res.nu0, res.nu1)) /
            (eps2 * eps2);
          Hfd[i * 4 + i] = -d2;
        } else {
          const pp = new Float64Array(thetaZeroMean);
          const pm = new Float64Array(thetaZeroMean);
          const mp = new Float64Array(thetaZeroMean);
          const mm = new Float64Array(thetaZeroMean);
          pp[i] += eps2; pp[j] += eps2;
          pm[i] += eps2; pm[j] -= eps2;
          mp[i] -= eps2; mp[j] += eps2;
          mm[i] -= eps2; mm[j] -= eps2;
          const d2 =
            (logPosterior(pp, pairs, res.nu0, res.nu1) -
              logPosterior(pm, pairs, res.nu0, res.nu1) -
              logPosterior(mp, pairs, res.nu0, res.nu1) +
              logPosterior(mm, pairs, res.nu0, res.nu1)) /
            (4 * eps2 * eps2);
          Hfd[i * 4 + j] = -d2;
          Hfd[j * 4 + i] = -d2;
        }
      }
    }

    // On any contrast vector c with sum(c) = 0 (e.g. e_i - e_j), H_fd * Sigma * c == c
    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 4; j++) {
        // v = Sigma * (e_i - e_j), check (e_i - e_j)^T * H_fd * v == 2
        const v = new Float64Array(4);
        for (let k = 0; k < 4; k++) {
          v[k] = res.covariance[k * 4 + i] - res.covariance[k * 4 + j];
        }
        const Hv = new Float64Array(4);
        for (let r = 0; r < 4; r++) {
          let sum = 0;
          for (let c = 0; c < 4; c++) sum += Hfd[r * 4 + c] * v[c];
          Hv[r] = sum;
        }
        expect(Hv[i] - Hv[j]).toBeCloseTo(2, 4);
      }
    }
  });

  test('is invariant to bot index permutations, warm-start offsets, and anchor choice', () => {
    const pairs: PairMatchCounts[] = [
      {i: 0, j: 1, ww: 24, wt: 2, split: 8, tl: 0, ll: 2},
      {i: 1, j: 2, ww: 20, wt: 1, split: 10, tl: 1, ll: 4},
      {i: 0, j: 2, ww: 30, wt: 0, split: 4, tl: 0, ll: 0},
    ];
    const anchor0 = computeDavidsonRatings(3, pairs, 0, 1500);
    const anchor1 = computeDavidsonRatings(3, pairs, 1, 1500);
    const warmShifted = computeDavidsonRatings(
      3,
      pairs,
      1,
      1500,
      new Float64Array([4.5, -2.0, -9.0])
    );

    expect(anchor0.elo[0]).toBeCloseTo(1500, 8);
    expect(anchor1.elo[1]).toBeCloseTo(1500, 8);

    // Changing anchor shifts all Elos by a constant while preserving Elo gaps, SEs, and LOS
    const gap0 = anchor0.elo[0] - anchor0.elo[2];
    const gap1 = anchor1.elo[0] - anchor1.elo[2];
    expect(gap0).toBeCloseTo(gap1, 8);

    for (let i = 0; i < 3; i++) {
      expect(anchor0.eloStd[i]).toBeCloseTo(anchor1.eloStd[i], 8);
      expect(warmShifted.elo[i]).toBeCloseTo(anchor1.elo[i], 6);
    }
    expect(computeLOS(anchor0.theta, anchor0.covariance, 3, 0, 2)).toBeCloseTo(
      computeLOS(anchor1.theta, anchor1.covariance, 3, 0, 2),
      8
    );

    // Reverse bot indices (0 <-> 2, 1 <-> 1); note flipping (i, j) swaps ww<->ll and wt<->tl
    const reversedPairs: PairMatchCounts[] = [
      {i: 1, j: 2, ww: 2, wt: 0, split: 8, tl: 2, ll: 24},
      {i: 0, j: 1, ww: 4, wt: 1, split: 10, tl: 1, ll: 20},
      {i: 0, j: 2, ww: 0, wt: 0, split: 4, tl: 0, ll: 30},
    ];
    const rev = computeDavidsonRatings(3, reversedPairs, 1, 1500);
    expect(rev.elo[2]).toBeCloseTo(anchor1.elo[0], 6);
    expect(rev.elo[1]).toBeCloseTo(anchor1.elo[1], 6);
    expect(rev.elo[0]).toBeCloseTo(anchor1.elo[2], 6);
    expect(rev.eloStd[2]).toBeCloseTo(anchor1.eloStd[0], 6);
    expect(rev.eloStd[0]).toBeCloseTo(anchor1.eloStd[2], 6);
  });

  test('shrinks SE monotonically with matches and isolates 0-match newcomers', () => {
    const seHistory: number[] = [];
    for (const nMatches of [0, 5, 15, 30, 60, 120]) {
      const pairs: PairMatchCounts[] = nMatches === 0
        ? []
        : [{
          i: 0,
          j: 1,
          ww: Math.round(0.35 * nMatches),
          wt: 0,
          split: Math.round(0.45 * nMatches),
          tl: 0,
          ll: nMatches - Math.round(0.35 * nMatches) - Math.round(0.45 * nMatches),
        }];
      const res = computeDavidsonRatings(2, pairs, 1, 1500);
      seHistory.push(res.eloStd[0]);
    }
    for (let k = 1; k < seHistory.length; k++) {
      expect(seHistory[k]).toBeLessThan(seHistory[k - 1]);
    }
    expect(seHistory[0]).toBeCloseTo(350, 6);
    expect(seHistory[seHistory.length - 1]).toBeLessThan(20);

    // Adding 3 unplayed bots must keep them at SE=350 without perturbing settled bots
    const basePairs: PairMatchCounts[] = [{i: 0, j: 1, ww: 25, wt: 0, split: 20, tl: 0, ll: 15}];
    const twoBot = computeDavidsonRatings(2, basePairs, 1, 1500);
    const fiveBot = computeDavidsonRatings(5, basePairs, 1, 1500);
    expect(fiveBot.elo[0]).toBeCloseTo(twoBot.elo[0], 8);
    expect(fiveBot.eloStd[0]).toBeCloseTo(twoBot.eloStd[0], 5);
    for (const newcomer of [2, 3, 4]) {
      expect(fiveBot.eloStd[newcomer]).toBeCloseTo(350, 5);
    }
  });

  test('recovers ground-truth skills and calibrated 95% CIs in a 10-bot Monte Carlo league', () => {
    const rng = mulberry32(0x5eed1234);
    const M = 10;
    const anchorIdx = 5;
    const trueTheta = new Float64Array([1.8, 1.35, 0.95, 0.55, 0.2, 0.0, -0.25, -0.6, -1.05, -1.6]);
    const nu0 = 2.2;
    const nu1 = 0.15;
    const matchesPerPair = 30;
    const pairs: PairMatchCounts[] = [];

    for (let i = 0; i < M; i++) {
      for (let j = i + 1; j < M; j++) {
        const d = trueTheta[i] - trueTheta[j];
        const wWW = Math.exp(d);
        const wWT = nu1 * Math.exp(0.5 * d);
        const wSp = nu0;
        const wTL = nu1 * Math.exp(-0.5 * d);
        const wLL = Math.exp(-d);
        const Z = wWW + wWT + wSp + wTL + wLL;

        let ww = 0;
        let wt = 0;
        let split = 0;
        let tl = 0;
        let ll = 0;
        for (let m = 0; m < matchesPerPair; m++) {
          const u = rng() * Z;
          if (u < wWW) ww++;
          else if (u < wWW + wWT) wt++;
          else if (u < wWW + wWT + wSp) split++;
          else if (u < wWW + wWT + wSp + wTL) tl++;
          else ll++;
        }
        pairs.push({i, j, ww, wt, split, tl, ll});
      }
    }

    // Verify unanchored (league-mean gauge) 95% CIs match marginal SEs, and verify anchor shift
    const unanchored = computeDavidsonRatings(M, pairs, -1, 1500);
    const anchored = computeDavidsonRatings(M, pairs, anchorIdx, 1500);
    expect(anchored.elo[anchorIdx]).toBeCloseTo(1500, 8);

    let trueMean = 0;
    for (const t of trueTheta) trueMean += t;
    trueMean /= M;

    let covered = 0;
    let sumSqErr = 0;
    for (let i = 0; i < M; i++) {
      const trueCenteredElo = 1500 + ELO_SCALE * (trueTheta[i] - trueMean);
      const err = unanchored.elo[i] - trueCenteredElo;
      sumSqErr += err * err;
      if (trueCenteredElo >= unanchored.eloLcb[i] && trueCenteredElo <= unanchored.eloUcb[i]) {
        covered++;
      }
      expect(unanchored.eloStd[i]).toBeLessThan(25);
    }
    const rmse = Math.sqrt(sumSqErr / M);
    expect(rmse).toBeLessThan(25);
    expect(covered).toBeGreaterThanOrEqual(9);

    // Ranking order should match true monotonically decreasing skill
    for (let i = 0; i < M - 1; i++) {
      expect(anchored.elo[i]).toBeGreaterThan(anchored.elo[i + 1]);
    }
  });
});

describe('normalCdf, LOS, expectedMatchScore, GXE & guaranteed rank bounds', () => {
  test('verifies normalCdf quantiles, antisymmetry, and GXE/expectedMatchScore properties', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 8);
    expect(normalCdf(1.6448536)).toBeCloseTo(0.95, 6);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 6);
    expect(normalCdf(3.0)).toBeCloseTo(0.9986501, 6);
    for (const z of [0.1, 0.75, 1.5, 2.4, 4.0]) {
      expect(normalCdf(z) + normalCdf(-z)).toBeCloseTo(1.0, 7);
    }

    for (const [nu0, nu1] of [[2.0, 0], [2.8, 0.2], [4.0, 0.5]]) {
      expect(expectedMatchScore(0, nu0, nu1)).toBeCloseTo(0.5, 10);
      let prev = expectedMatchScore(-3, nu0, nu1);
      for (const d of [-1.5, -0.5, 0, 0.5, 1.5, 3.0]) {
        const cur = expectedMatchScore(d, nu0, nu1);
        expect(cur).toBeGreaterThan(prev);
        expect(cur).toBeGreaterThan(0);
        expect(cur).toBeLessThan(1);
        expect(cur + expectedMatchScore(-d, nu0, nu1)).toBeCloseTo(1.0, 10);
        prev = cur;
      }
    }

    expect(ELO_SCALE).toBeCloseTo(173.71779276, 6);
    expect(GXE_C).toBeCloseTo(1.00724e-5, 9);
  });

  test('uses off-diagonal covariance in LOS and enforces rankMin <= rank <= rankMax', () => {
    // Bot 0 and Bot 1 played 40 matches directly; Bot 2 only played Bot 3 (disconnected component)
    const pairs: PairMatchCounts[] = [
      {i: 0, j: 1, ww: 24, wt: 0, split: 10, tl: 0, ll: 6},
      {i: 2, j: 3, ww: 24, wt: 0, split: 10, tl: 0, ll: 6},
    ];
    const res = computeDavidsonRatings(4, pairs, 1, 1500);
    // Equal skill gap on (0, 1) and (2, 3), but (0, 1) played directly while (0, 3) did not
    const losDirect = computeLOS(res.theta, res.covariance, 4, 0, 1);
    const losCross = computeLOS(res.theta, res.covariance, 4, 0, 3);
    expect(losDirect).toBeGreaterThan(losCross);

    // Clear #1 (+350 Elo), tied #2/#3 (+150 Elo), clear #4 (0 Elo)
    const theta = new Float64Array([2.0, 0.85, 0.84, 0.0]);
    const cov = new Float64Array(16);
    for (let i = 0; i < 4; i++) cov[i * 4 + i] = 0.01; // SE ~= 17.4 Elo
    const eloLcb = new Float64Array(4);
    const eloUcb = new Float64Array(4);
    for (let i = 0; i < 4; i++) {
      const elo = 1500 + ELO_SCALE * theta[i];
      const ci = 1.96 * ELO_SCALE * 0.1;
      eloLcb[i] = elo - ci;
      eloUcb[i] = elo + ci;
    }

    const bounds = computeGuaranteedRankBounds([0, 1, 2, 3], theta, cov, eloLcb, eloUcb, 4, 0.95);
    // Bot 0 is unambiguously #1: [1, 1]
    expect([bounds.rankMin[0], bounds.rankMax[0]]).toEqual([1, 1]);
    // Bots 1 and 2 overlap heavily, but both clearly beat Bot 3 and lose to Bot 0: [2, 3]
    expect([bounds.rankMin[1], bounds.rankMax[1]]).toEqual([2, 3]);
    expect([bounds.rankMin[2], bounds.rankMax[2]]).toEqual([2, 3]);
    // Bot 3 is unambiguously #4: [4, 4]
    expect([bounds.rankMin[3], bounds.rankMax[3]]).toEqual([4, 4]);
  });
});

describe('incremental streak, Top-K reign clock & active matchmaker primitives', () => {
  test('maps all 9 blind-pair categories and updates version & pairwise streaks in O(1)', () => {
    const winCats: MatchCategory[] = ['WW', 'WT', 'TW'];
    const tieCats: MatchCategory[] = ['WL', 'LW', 'TT'];
    const lossCats: MatchCategory[] = ['TL', 'LT', 'LL'];
    for (const c of winCats) expect(toTernaryMatchOutcome(c)).toEqual({v1: 'W', v2: 'L'});
    for (const c of tieCats) expect(toTernaryMatchOutcome(c)).toEqual({v1: 'T', v2: 'T'});
    for (const c of lossCats) expect(toTernaryMatchOutcome(c)).toEqual({v1: 'L', v2: 'W'});

    const streaks = {curWinStreak: 0, curLossStreak: 0, maxWinStreak: 0, maxLossStreak: 0};
    for (const o of ['W', 'W', 'W', 'T', 'L', 'L', 'W'] as const) {
      applyMatchOutcomeToStreaks(streaks, o);
    }
    expect(streaks).toEqual({
      curWinStreak: 1,
      curLossStreak: 0,
      maxWinStreak: 3,
      maxLossStreak: 2,
    });

    const pair = {curStreak: 0, vLowMaxWinStreak: 0, vHighMaxWinStreak: 0};
    for (const o of ['W', 'W', 'L', 'L', 'L', 'T', 'W'] as const) {
      applyPairwiseStreakUpdate(pair, o);
    }
    expect(pair).toEqual({
      curStreak: 1,
      vLowMaxWinStreak: 2,
      vHighMaxWinStreak: 3,
    });
  });

  test('tracks Top-K reign entry, cumulative time, max streak, drop, and re-entry', () => {
    let clk = {enteredAt: null as number | null, maxStreakS: 0, totalS: 0};
    // Enter Top-1 at t=1000
    clk = advanceTopKClock(clk.enteredAt, clk.maxStreakS, clk.totalS, true, 1000, 300);
    expect(clk).toEqual({enteredAt: 1000, maxStreakS: 0, totalS: 0});

    // Hold Top-1 at t=1600 (+600s) and t=2500 (+900s -> 1500s unbroken streak)
    clk = advanceTopKClock(clk.enteredAt, clk.maxStreakS, clk.totalS, true, 1600, 600);
    clk = advanceTopKClock(clk.enteredAt, clk.maxStreakS, clk.totalS, true, 2500, 900);
    expect(clk).toEqual({enteredAt: 1000, maxStreakS: 1500, totalS: 1500});

    // Lose Top-1 at t=2800 (+300s leading up to loss -> 1800s max & total, enteredAt cleared)
    clk = advanceTopKClock(clk.enteredAt, clk.maxStreakS, clk.totalS, false, 2800, 300);
    expect(clk).toEqual({enteredAt: null, maxStreakS: 1800, totalS: 1800});

    // Stay out at t=3500 -> unchanged
    clk = advanceTopKClock(clk.enteredAt, clk.maxStreakS, clk.totalS, false, 3500, 700);
    expect(clk).toEqual({enteredAt: null, maxStreakS: 1800, totalS: 1800});

    // Re-enter at t=4000 and hold until t=4500 (+500s -> totalS=2300, maxStreakS still 1800)
    clk = advanceTopKClock(clk.enteredAt, clk.maxStreakS, clk.totalS, true, 4000, 500);
    clk = advanceTopKClock(clk.enteredAt, clk.maxStreakS, clk.totalS, true, 4500, 500);
    expect(clk).toEqual({enteredAt: 4000, maxStreakS: 1800, totalS: 2300});
  });

  test('enforces active-only selection, anti-starvation, triage, and repeat damping', () => {
    expect(() =>
      selectNextArenaMatch(
        [{
          id: 'solo',
          activeBotIndices: [0],
          theta: new Float64Array([0]),
          sigma: new Float64Array([1]),
          botMatches: new Int32Array([0]),
          pairMatches: new Int32Array([0]),
          lastMatchNumber: 0,
        }],
        0
      )).toThrow(/No ladder has >= 2 active bots/);

    // Index 3 is retired (not in activeBotIndices) despite huge sigma -> must never be selected
    const pairMatches = new Int32Array(16);
    const ladders = [
      {
        id: 'rby',
        activeBotIndices: [0, 1, 2],
        theta: new Float64Array([0.8, 0.75, 0.0, 0.8]),
        sigma: new Float64Array([0.1, 0.1, 1.8, 2.0]),
        botMatches: new Int32Array([50, 50, 0, 0]),
        pairMatches,
        lastMatchNumber: 10,
      },
      {
        id: 'sv',
        activeBotIndices: [0, 1],
        theta: new Float64Array([0.2, 0.0]),
        sigma: new Float64Array([0.15, 0.15]),
        botMatches: new Int32Array([30, 30]),
        pairMatches: new Int32Array([0, 30, 30, 0]),
        lastMatchNumber: 0,
      },
    ];

    // Starved ladder 'sv' (waited 10 >= 4 * 2 = 8) wins first
    expect(selectNextArenaMatch(ladders, 10).ladderId).toBe('sv');

    // Once 'sv' plays, 'rby' pairs triage bot 2 (never retired bot 3!)
    ladders[1].lastMatchNumber = 10;
    const triage = selectNextArenaMatch(ladders, 11);
    expect(triage.ladderId).toBe('rby');
    expect([triage.botI, triage.botJ]).toContain(2);
    expect([triage.botI, triage.botJ]).not.toContain(3);

    // Repeat damper: if (0, 2) has already played 40 times while (1, 2) has played 0, pick (1, 2)
    pairMatches[0 * 4 + 2] = 40;
    pairMatches[2 * 4 + 0] = 40;
    ladders[0].botMatches[2] = 40;
    const damped = selectNextArenaMatch(ladders, 12);
    expect([damped.botI, damped.botJ].sort()).toEqual([1, 2]);
  });
});
