-- Sufficient-statistics matrix of pairwise match outcomes, head-to-head streaks, and posterior
-- Likelihood of Superiority (LOS) for every unordered version pair `(low_version_id, high_version_id)`.
--
-- Features: O(M^3) Batch MAP Generalized Davidson rating solver (`recomputeLadderRatings`),
--   leaderboard matchup heatmap matrix (`/arena/<slot>#matchups`), agent profile Head-to-Head tables
--   (`/projects/<slug>#matchups`), and active-learning rematch dampening.
-- Relationships: Joins `ladders` and `agent_versions` (`low_version_id < high_version_id`). Incremented
--   atomically on each `matches` insert and updated with `low_los` after each Davidson solve.
-- Why standalone: Without materialized pairwise counts, every post-match rating solve and static page
--   render would have to `GROUP BY` the entire `matches` history (O(N_matches) I/O on a 1 vCPU
--   droplet). Storing the 5 Davidson category counts per canonical unordered pair bounds rating
--   updates to <= M*(M-1)/2 tiny rows regardless of whether a ladder has played 100 or 10,000,000 matches.
CREATE TABLE IF NOT EXISTS pair_aggregates (
  -- Ladder epoch to which this head-to-head record belongs.
  ladder_id TEXT NOT NULL REFERENCES ladders(id),
  -- Smaller `agent_versions.id` of the pair; canonical ordering prevents duplicate directional rows.
  low_version_id INTEGER NOT NULL REFERENCES agent_versions(id),
  -- Larger `agent_versions.id` of the pair (`low_version_id < high_version_id`).
  high_version_id INTEGER NOT NULL REFERENCES agent_versions(id),
  -- 5-category Generalized Davidson counts from `low_version_id`'s perspective:
  --   `ww`: 2-0 sweeps by `low_version_id`
  --   `wt`: 1.5-0.5 wins (`WT` or `TW`) by `low_version_id`
  --   `split`: 1-1 ties (`WL`, `LW`, or `TT`; game order within a split is ancillary to skill diff)
  --   `tl`: 0.5-1.5 losses (`TL` or `LT`) by `low_version_id` (1.5-0.5 wins by `high_version_id`)
  --   `ll`: 0-2 sweeps against `low_version_id` (2-0 sweeps by `high_version_id`)
  ww INTEGER NOT NULL DEFAULT 0,
  wt INTEGER NOT NULL DEFAULT 0,
  split INTEGER NOT NULL DEFAULT 0,
  tl INTEGER NOT NULL DEFAULT 0,
  ll INTEGER NOT NULL DEFAULT 0,
  -- Signed consecutive outright match streak: `+k` means `low_version_id` won the last `k` matches,
  -- `-k` means `high_version_id` won the last `k` matches, and `0` means the latest match split.
  current_streak INTEGER NOT NULL DEFAULT 0,
  -- Longest consecutive outright match win streak achieved by `low_version_id` vs `high_version_id`.
  low_max_win_streak INTEGER NOT NULL DEFAULT 0,
  -- Longest consecutive outright match win streak achieved by `high_version_id` vs `low_version_id`.
  high_max_win_streak INTEGER NOT NULL DEFAULT 0,
  -- Posterior probability P(theta_low > theta_high) in [0, 1] computed from the joint Laplace
  -- covariance matrix (`Phi((theta_low - theta_high) / sqrt(Var_low + Var_high - 2*Cov_low_high))`).
  -- Complement `1 - low_los` gives `high_version_id`'s LOS.
  low_los REAL,
  PRIMARY KEY (ladder_id, low_version_id, high_version_id),
  CHECK (low_version_id < high_version_id)
);

CREATE INDEX IF NOT EXISTS idx_pair_aggregates_high_version ON pair_aggregates(high_version_id);
