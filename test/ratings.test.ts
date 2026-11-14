import * as ratings from '../server/ratings';
import {
  computeKendallTau,
  runMatchmakingSimulation,
  sweepMatchmakingParameters,
} from '../tools/simulate';

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
  pairs: ratings.PairMatchCounts[],
  nu0: number,
  nu1: number,
  priorEloStd = 350
): number {
  const priorSigma = priorEloStd / ratings.ELO_SCALE;
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

const ASYMMETRIC_PAIRS: ratings.PairMatchCounts[] = [
  {i: 0, j: 1, ww: 19, wt: 4, split: 9, tl: 2, ll: 3},
  {i: 0, j: 2, ww: 27, wt: 3, split: 6, tl: 1, ll: 1},
  {i: 0, j: 3, ww: 34, wt: 2, split: 4, tl: 0, ll: 0},
  {i: 1, j: 2, ww: 14, wt: 5, split: 12, tl: 3, ll: 6},
  {i: 1, j: 3, ww: 22, wt: 2, split: 8, tl: 1, ll: 2},
  {i: 2, j: 3, ww: 16, wt: 1, split: 11, tl: 2, ll: 5},
];

describe('Generalized Davidson MAP rating solver', () => {
  test('handles empty zero-entry ladders', () => {
    const empty = ratings.computeDavidsonRatings(0, []);
    expect(empty.elo).toHaveLength(0);
    expect(empty.covariance).toHaveLength(0);
  });

  test('keeps zero-match entrants at the N(1500, 350^2) prior', () => {
    const unplayed = ratings.computeDavidsonRatings(4, [], 0, 1500);
    for (let i = 0; i < 4; i++) {
      expect(unplayed.theta[i]).toBeCloseTo(0, 10);
      expect(unplayed.elo[i]).toBeCloseTo(1500, 10);
      expect(unplayed.eloStd[i]).toBeCloseTo(350, 8);
      expect(unplayed.ci95[i]).toBeCloseTo(1.96 * 350, 6);
      expect(unplayed.gxe[i]).toBeCloseTo(50, 8);
      for (let j = i + 1; j < 4; j++) {
        expect(ratings.computeLOS(unplayed.theta, unplayed.covariance, 4, i, j))
          .toBeCloseTo(0.5, 10);
      }
    }
    expect(unplayed.nu0).toBe(2.0);
    expect(unplayed.nu1).toBe(0);
  });

  test('satisfies first-order KKT optimality (grad = 0) on asymmetric 5-category data', () => {
    const res = ratings.computeDavidsonRatings(4, ASYMMETRIC_PAIRS, 2, 1500);

    let mean = 0;
    for (let i = 0; i < 4; i++) mean += res.theta[i];
    mean /= 4;
    const thetaZeroMean = res.theta.map(v => v - mean);

    const eps = 1e-6;
    for (let i = 0; i < 4; i++) {
      const plus = new Float64Array(thetaZeroMean);
      const minus = new Float64Array(thetaZeroMean);
      plus[i] += eps;
      minus[i] -= eps;
      const fdGrad =
        (logPosterior(plus, ASYMMETRIC_PAIRS, res.nu0, res.nu1) -
          logPosterior(minus, ASYMMETRIC_PAIRS, res.nu0, res.nu1)) /
        (2 * eps);
      expect(Math.abs(fdGrad)).toBeLessThan(1e-7);
    }
  });

  test('matches finite-difference inverse Hessian on zero-sum contrast vectors', () => {
    const res = ratings.computeDavidsonRatings(4, ASYMMETRIC_PAIRS, 2, 1500);

    let mean = 0;
    for (let i = 0; i < 4; i++) mean += res.theta[i];
    mean /= 4;
    const thetaZeroMean = res.theta.map(v => v - mean);

    const eps2 = 1e-4;
    const Hfd = new Float64Array(16);
    const f0 = logPosterior(thetaZeroMean, ASYMMETRIC_PAIRS, res.nu0, res.nu1);
    for (let i = 0; i < 4; i++) {
      for (let j = i; j < 4; j++) {
        if (i === j) {
          const p = new Float64Array(thetaZeroMean);
          const m = new Float64Array(thetaZeroMean);
          p[i] += eps2;
          m[i] -= eps2;
          const d2 =
            (logPosterior(p, ASYMMETRIC_PAIRS, res.nu0, res.nu1) -
              2 * f0 +
              logPosterior(m, ASYMMETRIC_PAIRS, res.nu0, res.nu1)) /
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
            (logPosterior(pp, ASYMMETRIC_PAIRS, res.nu0, res.nu1) -
              logPosterior(pm, ASYMMETRIC_PAIRS, res.nu0, res.nu1) -
              logPosterior(mp, ASYMMETRIC_PAIRS, res.nu0, res.nu1) +
              logPosterior(mm, ASYMMETRIC_PAIRS, res.nu0, res.nu1)) /
            (4 * eps2 * eps2);
          Hfd[i * 4 + j] = -d2;
          Hfd[j * 4 + i] = -d2;
        }
      }
    }

    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 4; j++) {
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

  test('preserves relative ratings under anchor or warm-start shifts', () => {
    const pairs: ratings.PairMatchCounts[] = [
      {i: 0, j: 1, ww: 24, wt: 2, split: 8, tl: 0, ll: 2},
      {i: 1, j: 2, ww: 20, wt: 1, split: 10, tl: 1, ll: 4},
      {i: 0, j: 2, ww: 30, wt: 0, split: 4, tl: 0, ll: 0},
    ];
    const anchor0 = ratings.computeDavidsonRatings(3, pairs, 0, 1500);
    const anchor1 = ratings.computeDavidsonRatings(3, pairs, 1, 1500);
    const warmShifted = ratings.computeDavidsonRatings(
      3,
      pairs,
      1,
      1500,
      new Float64Array([4.5, -2.0, -9.0])
    );

    expect(anchor0.elo[0]).toBeCloseTo(1500, 8);
    expect(anchor1.elo[1]).toBeCloseTo(1500, 8);
    expect(anchor0.elo[0] - anchor0.elo[2]).toBeCloseTo(anchor1.elo[0] - anchor1.elo[2], 8);

    for (let i = 0; i < 3; i++) {
      expect(anchor0.eloStd[i]).toBeCloseTo(anchor1.eloStd[i], 8);
      expect(warmShifted.elo[i]).toBeCloseTo(anchor1.elo[i], 6);
    }
    expect(ratings.computeLOS(anchor0.theta, anchor0.covariance, 3, 0, 2)).toBeCloseTo(
      ratings.computeLOS(anchor1.theta, anchor1.covariance, 3, 0, 2),
      8
    );
  });

  test('is invariant to agent index permutations', () => {
    const pairs: ratings.PairMatchCounts[] = [
      {i: 0, j: 1, ww: 24, wt: 2, split: 8, tl: 0, ll: 2},
      {i: 1, j: 2, ww: 20, wt: 1, split: 10, tl: 1, ll: 4},
      {i: 0, j: 2, ww: 30, wt: 0, split: 4, tl: 0, ll: 0},
    ];
    const forward = ratings.computeDavidsonRatings(3, pairs, 1, 1500);
    const reversedPairs: ratings.PairMatchCounts[] = [
      {i: 1, j: 2, ww: 2, wt: 0, split: 8, tl: 2, ll: 24},
      {i: 0, j: 1, ww: 4, wt: 1, split: 10, tl: 1, ll: 20},
      {i: 0, j: 2, ww: 0, wt: 0, split: 4, tl: 0, ll: 30},
    ];
    const rev = ratings.computeDavidsonRatings(3, reversedPairs, 1, 1500);
    expect(rev.elo[2]).toBeCloseTo(forward.elo[0], 6);
    expect(rev.elo[1]).toBeCloseTo(forward.elo[1], 6);
    expect(rev.elo[0]).toBeCloseTo(forward.elo[2], 6);
    expect(rev.eloStd[2]).toBeCloseTo(forward.eloStd[0], 6);
    expect(rev.eloStd[0]).toBeCloseTo(forward.eloStd[2], 6);
  });

  test('shrinks posterior SE monotonically with match count', () => {
    const seHistory: number[] = [];
    for (const nMatches of [0, 5, 15, 30, 60, 120]) {
      const pairs: ratings.PairMatchCounts[] = nMatches === 0
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
      const res = ratings.computeDavidsonRatings(2, pairs, 1, 1500);
      seHistory.push(res.eloStd[0]);
    }
    for (let k = 1; k < seHistory.length; k++) {
      expect(seHistory[k]).toBeLessThan(seHistory[k - 1]);
    }
    expect(seHistory[0]).toBeCloseTo(350, 6);
    expect(seHistory[seHistory.length - 1]).toBeLessThan(20);
  });

  test('isolates zero-match newcomers from settled ratings', () => {
    const basePairs: ratings.PairMatchCounts[] = [
      {i: 0, j: 1, ww: 25, wt: 0, split: 20, tl: 0, ll: 15},
    ];
    const twoAgent = ratings.computeDavidsonRatings(2, basePairs, 1, 1500);
    const fiveAgent = ratings.computeDavidsonRatings(5, basePairs, 1, 1500);
    expect(fiveAgent.elo[0]).toBeCloseTo(twoAgent.elo[0], 8);
    expect(fiveAgent.eloStd[0]).toBeCloseTo(twoAgent.eloStd[0], 5);
    for (const newcomer of [2, 3, 4]) {
      expect(fiveAgent.eloStd[newcomer]).toBeCloseTo(350, 5);
    }
  });

  test('recovers ground-truth skills with calibrated 95% CIs in a 10-agent league', () => {
    const rng = mulberry32(0x5eed1234);
    const M = 10;
    const anchorIdx = 5;
    const trueTheta = new Float64Array([1.8, 1.35, 0.95, 0.55, 0.2, 0.0, -0.25, -0.6, -1.05, -1.6]);
    const nu0 = 2.2;
    const nu1 = 0.15;
    const matchesPerPair = 30;
    const pairs: ratings.PairMatchCounts[] = [];

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

    const unanchored = ratings.computeDavidsonRatings(M, pairs, -1, 1500);
    const anchored = ratings.computeDavidsonRatings(M, pairs, anchorIdx, 1500);
    expect(anchored.elo[anchorIdx]).toBeCloseTo(1500, 8);

    let trueMean = 0;
    for (const t of trueTheta) trueMean += t;
    trueMean /= M;

    let covered = 0;
    let sumSqErr = 0;
    for (let i = 0; i < M; i++) {
      const trueCenteredElo = 1500 + ratings.ELO_SCALE * (trueTheta[i] - trueMean);
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

    for (let i = 0; i < M - 1; i++) {
      expect(anchored.elo[i]).toBeGreaterThan(anchored.elo[i + 1]);
    }
  });
});

describe('normalCdf, LOS, expectedMatchScore, and rank bounds', () => {
  test('computes accurate normalCdf quantiles with antisymmetry', () => {
    expect(ratings.normalCdf(0)).toBeCloseTo(0.5, 8);
    expect(ratings.normalCdf(1.6448536)).toBeCloseTo(0.95, 6);
    expect(ratings.normalCdf(1.959964)).toBeCloseTo(0.975, 6);
    expect(ratings.normalCdf(3.0)).toBeCloseTo(0.9986501, 6);
    for (const z of [0.1, 0.75, 1.5, 2.4, 4.0]) {
      expect(ratings.normalCdf(z) + ratings.normalCdf(-z)).toBeCloseTo(1.0, 7);
    }
  });

  test('computes monotonic antisymmetric expectedMatchScore values', () => {
    for (const [nu0, nu1] of [[2.0, 0], [2.8, 0.2], [4.0, 0.5]]) {
      expect(ratings.expectedMatchScore(0, nu0, nu1)).toBeCloseTo(0.5, 10);
      let prev = ratings.expectedMatchScore(-3, nu0, nu1);
      for (const d of [-1.5, -0.5, 0, 0.5, 1.5, 3.0]) {
        const cur = ratings.expectedMatchScore(d, nu0, nu1);
        expect(cur).toBeGreaterThan(prev);
        expect(cur).toBeGreaterThan(0);
        expect(cur).toBeLessThan(1);
        expect(cur + ratings.expectedMatchScore(-d, nu0, nu1)).toBeCloseTo(1.0, 10);
        prev = cur;
      }
    }
    expect(ratings.ELO_SCALE).toBeCloseTo(173.71779276, 6);
    expect(ratings.GXE_C).toBeCloseTo(1.00724e-5, 9);
  });

  test('incorporates off-diagonal covariance in pairwise LOS', () => {
    const pairs: ratings.PairMatchCounts[] = [
      {i: 0, j: 1, ww: 24, wt: 0, split: 10, tl: 0, ll: 6},
      {i: 2, j: 3, ww: 24, wt: 0, split: 10, tl: 0, ll: 6},
    ];
    const res = ratings.computeDavidsonRatings(4, pairs, 1, 1500);
    const losDirect = ratings.computeLOS(res.theta, res.covariance, 4, 0, 1);
    const losCross = ratings.computeLOS(res.theta, res.covariance, 4, 0, 3);
    expect(losDirect).toBeGreaterThan(losCross);
  });

  test('computes guaranteed 95% confidence rank intervals', () => {
    const theta = new Float64Array([2.0, 0.85, 0.84, 0.0]);
    const cov = new Float64Array(16);
    for (let i = 0; i < 4; i++) cov[i * 4 + i] = 0.01;
    const eloLcb = new Float64Array(4);
    const eloUcb = new Float64Array(4);
    for (let i = 0; i < 4; i++) {
      const elo = 1500 + ratings.ELO_SCALE * theta[i];
      const ci = 1.96 * ratings.ELO_SCALE * 0.1;
      eloLcb[i] = elo - ci;
      eloUcb[i] = elo + ci;
    }

    const bounds = ratings.computeGuaranteedRankBounds(
      [0, 1, 2, 3], theta, cov, eloLcb, eloUcb, 4, 0.95
    );
    expect([bounds.rankMin[0], bounds.rankMax[0]]).toEqual([1, 1]);
    expect([bounds.rankMin[1], bounds.rankMax[1]]).toEqual([2, 3]);
    expect([bounds.rankMin[2], bounds.rankMax[2]]).toEqual([2, 3]);
    expect([bounds.rankMin[3], bounds.rankMax[3]]).toEqual([4, 4]);
  });
});

describe('streaks, Top-K reign clocks, and active matchmaker', () => {
  test('maps all 9 blind-pair categories to ternary match outcomes', () => {
    for (const c of ['WW', 'WT', 'TW'] as const) {
      expect(ratings.toTernaryMatchOutcome(c)).toEqual({p1: 'W', p2: 'L'});
    }
    for (const c of ['WL', 'LW', 'TT'] as const) {
      expect(ratings.toTernaryMatchOutcome(c)).toEqual({p1: 'T', p2: 'T'});
    }
    for (const c of ['TL', 'LT', 'LL'] as const) {
      expect(ratings.toTernaryMatchOutcome(c)).toEqual({p1: 'L', p2: 'W'});
    }
  });

  test('updates version consecutive win or loss streaks in O(1)', () => {
    const streaks: ratings.StreakState = {
      currentWinStreak: 0,
      currentLossStreak: 0,
      maxWinStreak: 0,
      maxLossStreak: 0,
    };
    for (const o of ['W', 'W', 'W', 'T', 'L', 'L', 'W'] as const) {
      ratings.applyMatchOutcomeToStreaks(streaks, o);
    }
    expect(streaks).toEqual({
      currentWinStreak: 1,
      currentLossStreak: 0,
      maxWinStreak: 3,
      maxLossStreak: 2,
    });
  });

  test('updates signed pairwise head-to-head streaks in O(1)', () => {
    const pair: ratings.PairwiseStreakState = {
      currentStreak: 0,
      lowMaxWinStreak: 0,
      highMaxWinStreak: 0,
    };
    for (const o of ['W', 'W', 'L', 'L', 'L', 'T', 'W'] as const) {
      ratings.applyPairwiseStreakUpdate(pair, o);
    }
    expect(pair).toEqual({
      currentStreak: 1,
      lowMaxWinStreak: 2,
      highMaxWinStreak: 3,
    });
  });

  test('tracks cumulative Top-K reign clocks across drop-out cycles', () => {
    let clk: {enteredAt?: number; maxStreakSeconds: number; totalSeconds: number} = {
      enteredAt: undefined,
      maxStreakSeconds: 0,
      totalSeconds: 0,
    };
    clk = ratings.advanceTopKClock(
      clk.enteredAt, clk.maxStreakSeconds, clk.totalSeconds, true, 1000, 300
    );
    expect(clk).toEqual({enteredAt: 1000, maxStreakSeconds: 0, totalSeconds: 0});

    clk = ratings.advanceTopKClock(
      clk.enteredAt, clk.maxStreakSeconds, clk.totalSeconds, true, 1600, 600
    );
    clk = ratings.advanceTopKClock(
      clk.enteredAt, clk.maxStreakSeconds, clk.totalSeconds, true, 2500, 900
    );
    expect(clk).toEqual({enteredAt: 1000, maxStreakSeconds: 1500, totalSeconds: 1500});

    clk = ratings.advanceTopKClock(
      clk.enteredAt, clk.maxStreakSeconds, clk.totalSeconds, false, 2800, 300
    );
    expect(clk).toEqual({enteredAt: undefined, maxStreakSeconds: 1800, totalSeconds: 1800});

    clk = ratings.advanceTopKClock(
      clk.enteredAt, clk.maxStreakSeconds, clk.totalSeconds, false, 3500, 700
    );
    expect(clk).toEqual({enteredAt: undefined, maxStreakSeconds: 1800, totalSeconds: 1800});

    clk = ratings.advanceTopKClock(
      clk.enteredAt, clk.maxStreakSeconds, clk.totalSeconds, true, 4000, 500
    );
    clk = ratings.advanceTopKClock(
      clk.enteredAt, clk.maxStreakSeconds, clk.totalSeconds, true, 4500, 500
    );
    expect(clk).toEqual({enteredAt: 4000, maxStreakSeconds: 1800, totalSeconds: 2300});
  });

  test('throws when no ladder meets minAgents', () => {
    expect(() =>
      ratings.selectNextArenaMatch(
        [{
          id: 'solo',
          activeAgentIndices: [0],
          agentIds: new Int32Array([1]),
          minAgents: 2,
          theta: new Float64Array([0]),
          sigma: new Float64Array([1]),
          agentMatches: new Int32Array([0]),
          pairMatches: new Int32Array([0]),
          lastMatchNumber: 0,
        }],
        0
      )).toThrow(/No ladder meets its minimum distinct active agents/);
  });

  test('prioritizes starved ladders before active-learning triage', () => {
    const ladders: ratings.LadderMatchState[] = [
      {
        id: 'rby',
        activeAgentIndices: [0, 1, 2],
        agentIds: new Int32Array([1, 2, 3, 4]),
        minAgents: 2,
        theta: new Float64Array([0.8, 0.75, 0.0, 0.8]),
        sigma: new Float64Array([0.1, 0.1, 1.8, 2.0]),
        agentMatches: new Int32Array([50, 50, 0, 0]),
        pairMatches: new Int32Array(16),
        lastMatchNumber: 10,
      },
      {
        id: 'sv',
        activeAgentIndices: [0, 1],
        agentIds: new Int32Array([1, 2]),
        minAgents: 2,
        theta: new Float64Array([0.2, 0.0]),
        sigma: new Float64Array([0.15, 0.15]),
        agentMatches: new Int32Array([30, 30]),
        pairMatches: new Int32Array([0, 30, 30, 0]),
        lastMatchNumber: 0,
      },
    ];
    expect(ratings.selectNextArenaMatch(ladders, 10).ladderId).toBe('sv');
  });

  test('excludes retired versions while damping saturated repeat pairings', () => {
    const pairMatches = new Int32Array(16);
    const ladders: ratings.LadderMatchState[] = [{
      id: 'rby',
      activeAgentIndices: [0, 1, 2], // index 3 is retired despite sigma = 2.0
      agentIds: new Int32Array([1, 2, 3, 4]),
      minAgents: 2,
      theta: new Float64Array([0.8, 0.75, 0.0, 0.8]),
      sigma: new Float64Array([0.1, 0.1, 1.8, 2.0]),
      agentMatches: new Int32Array([50, 50, 0, 0]),
      pairMatches,
      lastMatchNumber: 10,
    }];

    const triage = ratings.selectNextArenaMatch(ladders, 11);
    expect([triage.agentI, triage.agentJ]).toContain(2);
    expect([triage.agentI, triage.agentJ]).not.toContain(3);

    pairMatches[0 * 4 + 2] = 40;
    pairMatches[2 * 4 + 0] = 40;
    ladders[0].agentMatches[2] = 40;
    const damped = ratings.selectNextArenaMatch(ladders, 12);
    expect([damped.agentI, damped.agentJ].sort()).toEqual([1, 2]);
  });

  test('gates minAgents strictly on distinct active projects rather than version count', () => {
    expect(() =>
      ratings.selectNextArenaMatch(
        [
          {
            id: 'self-only',
            activeAgentIndices: [0, 1],
            agentIds: new Int32Array([7, 7]),
            minAgents: 2,
            theta: new Float64Array([0, 0]),
            sigma: new Float64Array([2, 2]),
            agentMatches: new Int32Array([0, 0]),
            pairMatches: new Int32Array(4),
            lastMatchNumber: 0,
          },
          {
            id: 'vgc-two-projects-four-versions',
            activeAgentIndices: [0, 1, 2, 3],
            agentIds: new Int32Array([1, 1, 2, 2]),
            minAgents: 4,
            theta: new Float64Array([0, 0, 0, 0]),
            sigma: new Float64Array([2, 2, 2, 2]),
            agentMatches: new Int32Array([0, 0, 0, 0]),
            pairMatches: new Int32Array(16),
            lastMatchNumber: 0,
          },
          {
            id: 'vgc-three-projects-four-versions',
            activeAgentIndices: [0, 1, 2, 3],
            agentIds: new Int32Array([1, 1, 2, 3]),
            minAgents: 4,
            theta: new Float64Array([0, 0, 0, 0]),
            sigma: new Float64Array([2, 2, 2, 2]),
            agentMatches: new Int32Array([0, 0, 0, 0]),
            pairMatches: new Int32Array(16),
            lastMatchNumber: 0,
          },
        ],
        1
      )).toThrow(/No ladder meets its minimum distinct active agents/);
  });

  test('schedules intra-project Champion vs Challenger calibration matches', () => {
    const mixedLadders: ratings.LadderMatchState[] = [
      {
        id: 'vgc-under-min',
        activeAgentIndices: [0, 1, 2],
        agentIds: new Int32Array([1, 2, 3]),
        minAgents: 4,
        theta: new Float64Array([0, 0, 0]),
        sigma: new Float64Array([2, 2, 2]),
        agentMatches: new Int32Array([0, 0, 0]),
        pairMatches: new Int32Array(9),
        lastMatchNumber: 0,
      },
      {
        id: 'rby-family',
        activeAgentIndices: [0, 1, 2],
        agentIds: new Int32Array([10, 10, 20]),
        minAgents: 2,
        theta: new Float64Array([1.2, 1.2, 0.0]),
        sigma: new Float64Array([2.0, 2.0, 0.2]),
        agentMatches: new Int32Array([0, 0, 30]),
        pairMatches: new Int32Array(9),
        lastMatchNumber: 0,
      },
    ];
    const familyChoice = ratings.selectNextArenaMatch(mixedLadders, 5);
    expect(familyChoice.ladderId).toBe('rby-family');
    expect([familyChoice.agentI, familyChoice.agentJ].sort()).toEqual([0, 1]);
  });

  test('computeTournamentRatings solves single-game MAP while preserving unplayed priors', () => {
    expect(ratings.computeTournamentRatings(0, []).elo).toHaveLength(0);

    const games: ratings.TournamentGameInput[] = [
      {i: 0, j: 1, outcome: 'W'},
      {i: 0, j: 1, outcome: 'W'},
      {i: 1, j: 0, outcome: 'L'},
      {i: 0, j: 2, outcome: 'W'},
      {i: 2, j: 0, outcome: 'T'},
      {i: 1, j: 2, outcome: 'W'},
    ];
    const res = ratings.computeTournamentRatings(4, games, -1, 1500, 350);
    expect(res.elo[0]).toBeGreaterThan(res.elo[1]);
    expect(res.elo[1]).toBeGreaterThan(res.elo[2]);
    expect(res.elo[3]).toBeCloseTo(1500, 6);
    expect(res.eloStd[3]).toBeCloseTo(350, 4);
  });

  test('computeTournamentRatings is invariant to game order or seat reversal', () => {
    const games: ratings.TournamentGameInput[] = [
      {i: 0, j: 1, outcome: 'W'},
      {i: 0, j: 1, outcome: 'W'},
      {i: 1, j: 0, outcome: 'L'},
      {i: 0, j: 2, outcome: 'W'},
      {i: 2, j: 0, outcome: 'T'},
      {i: 1, j: 2, outcome: 'W'},
    ];
    const res = ratings.computeTournamentRatings(4, games, -1, 1500, 350);
    const reversed: ratings.TournamentGameInput[] = games.slice().reverse().map(g => ({
      i: g.j,
      j: g.i,
      outcome: g.outcome === 'W' ? 'L' : g.outcome === 'L' ? 'W' : 'T',
    }));
    const revRes = ratings.computeTournamentRatings(4, reversed, -1, 1500, 350);
    for (let k = 0; k < 4; k++) {
      expect(revRes.elo[k]).toBeCloseTo(res.elo[k], 8);
      expect(revRes.eloStd[k]).toBeCloseTo(res.eloStd[k], 8);
    }
  });

  test('computes Kendall tau rank correlation across concordant or discordant rankings', () => {
    expect(computeKendallTau([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 8);
    expect(computeKendallTau([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 8);
    expect(computeKendallTau([1], [1])).toBe(1);
  });

  test('reproduces identical matchmaking simulation trajectories for a fixed seed', () => {
    const a = runMatchmakingSimulation({
      numLadders: 2,
      agentsPerLadder: 5,
      totalMatches: 40,
      exploit: 0.45,
      seed: 42,
    });
    const b = runMatchmakingSimulation({
      numLadders: 2,
      agentsPerLadder: 5,
      totalMatches: 40,
      exploit: 0.45,
      seed: 42,
    });
    expect(a).toEqual(b);
    expect(a.kendallTau).toBeGreaterThan(0.5);
    expect(a.minAgentMatches).toBeGreaterThan(0);
  });

  test('sweeps matchmaking parameter grids across multiple seeds', () => {
    const summaries = sweepMatchmakingParameters({
      numLadders: 2,
      agentsPerLadder: 5,
      totalMatches: 30,
      exploits: [0, 0.75],
      agingRates: [0.5],
      maxWaitCyclesList: [4],
      seeds: [1, 2],
    });
    expect(summaries).toHaveLength(2);
    expect(summaries[0].exploit).toBe(0);
    expect(summaries[1].exploit).toBe(0.75);
    expect(summaries[1].topContenderMatchShare).toBeGreaterThanOrEqual(
      summaries[0].topContenderMatchShare
    );
  });
});
