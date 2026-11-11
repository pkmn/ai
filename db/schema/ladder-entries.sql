-- Per-version competitive state, MAP Generalized Davidson ratings, streaks, reign clocks, and
-- runtime telemetry on a single ladder.
--
-- Features: Leaderboard standings (`/arena`, `/arena/<slot>`), Active/Best/All version filtering,
--   2-version Champion + Challenger retention, 1500-Elo rating anchor, settlement gating, and
--   active-learning matchmaking inputs.
-- Relationships: Joins `ladders` and `agent_versions`; updated transactionally alongside `matches`,
--   `pair_aggregates`, `agent_ladder_stats`, and `rating_snapshots` on every completed match.
-- Why standalone: An `agent_version` can compete on multiple ladders with completely independent
--   ratings, roles ('champion'/'challenger'/'retired'/'quarantined'), match counts, and telemetry.
--   Materializing per-version sufficient statistics here ensures `recomputeLadderRatings` runs in
--   O(M^3) over the M <= ~50 entries on a ladder (< 5 ms on 1 vCPU) without scanning `matches`.
CREATE TABLE IF NOT EXISTS ladder_entries (
  -- Ladder epoch on which this version competes.
  ladder_id TEXT NOT NULL REFERENCES ladders(id),
  -- Competing executable agent version.
  version_id INTEGER NOT NULL REFERENCES agent_versions(id),
  -- Matchmaking & leaderboard visibility role ('Champion + Challenger' 2-version retention):
  --   'champion': highest-LCB active version for this agent on this ladder
  --   'challenger': second active version (up to 2 concurrent active versions per agent per ladder)
  --   'retired': superseded when a 3rd version passed smoke test (retiring argmin lcb) or when the
  --     season archived; excluded from new matchmaking but kept in the Davidson graph to preserve
  --     cross-version rating calibration (including retired 1500-Elo anchors)
  --   'quarantined': temporarily suspended due to runtime faults; remembers active membership so
  --     `pkmn unquarantine` can restore its active role without reviving previously retired entries
  role TEXT NOT NULL DEFAULT 'champion'
    CHECK (role IN ('champion', 'challenger', 'retired', 'quarantined')),
  -- 1 if this version pins the ladder's 1500.0 Elo translation gauge (theta = 0, SE = 0), else 0.
  -- Orthogonal to `role`: a retired anchor stays in the Davidson solve at exact 1500 Elo forever.
  is_anchor INTEGER NOT NULL DEFAULT 0 CHECK (is_anchor IN (0, 1)),
  -- Posterior mode (MAP) Generalized Davidson rating on the standard Elo scale (anchor = 1500).
  elo REAL NOT NULL DEFAULT 1500.0,
  -- Posterior standard error SE(R) in Elo points from the inverse Hessian of the MAP objective.
  se REAL NOT NULL DEFAULT 350.0,
  -- Conservative Lower Confidence Bound (elo - 1.96 * se) used as the primary leaderboard sort key
  -- so lucky unsettled newcomers with wide SE cannot usurp proven veterans ('Challenger Usurpation').
  lcb REAL NOT NULL DEFAULT 814.0,
  -- Expected win percentage (0..100) against the prior population N(1500, 350^2), marginalizing SE.
  gxe REAL NOT NULL DEFAULT 50.0,
  -- Peak Conservative Rating achieved once `matches >= 10` (LCB already penalizes wide SE), or NULL.
  max_lcb REAL,
  -- Peak settled MAP Elo (`settled_at IS NOT NULL`), its concurrent SE, and timestamp when achieved.
  max_elo REAL,
  max_elo_se REAL,
  max_elo_at INTEGER,
  -- Peak settled GXE (`settled_at IS NOT NULL`) and Unix timestamp (seconds) when achieved.
  max_gxe REAL,
  max_gxe_at INTEGER,
  -- Total 2-game blind-pair matches completed on this ladder (`ww + wt + split + tl + ll`).
  matches INTEGER NOT NULL DEFAULT 0,
  -- 5-category Generalized Davidson blind-pair match counts (`wins = ww + wt`, `losses = ll + tl`,
  -- `ties = split`):
  ww INTEGER NOT NULL DEFAULT 0,
  wt INTEGER NOT NULL DEFAULT 0,
  split INTEGER NOT NULL DEFAULT 0,
  tl INTEGER NOT NULL DEFAULT 0,
  ll INTEGER NOT NULL DEFAULT 0,
  -- Consecutive outright match wins/losses; a 1-1 split resets both current streaks to 0.
  current_win_streak INTEGER NOT NULL DEFAULT 0,
  current_loss_streak INTEGER NOT NULL DEFAULT 0,
  max_win_streak INTEGER NOT NULL DEFAULT 0,
  max_loss_streak INTEGER NOT NULL DEFAULT 0,
  -- Official 1-based rank among non-provisional active agents (`matches >= 10 && se <= 60`), or NULL.
  rank_current INTEGER,
  -- Best (lowest number) plausible rank at 95% confidence (optimistic UCB vs rivals' LCB).
  rank_min INTEGER,
  -- Worst (highest number) guaranteed rank at 95% confidence (LCB vs rivals' optimistic UCB).
  rank_max INTEGER,
  -- Highest (lowest number) official settled rank achieved (`settled_at IS NOT NULL`) and timestamp.
  best_rank INTEGER,
  best_rank_at INTEGER,
  -- Unix timestamp (seconds) when this entry first met both settlement criteria (`matches >= 25` and
  -- `se <= 30.0`), unlocking new submissions (after 14d cooldown), peak stats, and #1 crown eligibility.
  settled_at INTEGER,
  -- Cumulative and longest continuous wall-clock reign durations (in seconds, capped at 3600s per
  -- match interval so runner downtime never inflates reigns). Top-1 requires `settled_at IS NOT NULL`
  -- and `rank_current = 1`; Top-10 / Top-100 require guaranteed 95% confidence (`rank_max <= K`).
  top1_entered_at INTEGER,
  top1_max_streak_seconds INTEGER NOT NULL DEFAULT 0,
  top1_total_seconds INTEGER NOT NULL DEFAULT 0,
  top10_entered_at INTEGER,
  top10_max_streak_seconds INTEGER NOT NULL DEFAULT 0,
  top10_total_seconds INTEGER NOT NULL DEFAULT 0,
  top100_entered_at INTEGER,
  top100_max_streak_seconds INTEGER NOT NULL DEFAULT 0,
  top100_total_seconds INTEGER NOT NULL DEFAULT 0,
  -- Running mean decision time per turn in milliseconds across all games played on this ladder.
  mean_turn_millis REAL NOT NULL DEFAULT 0.0,
  -- Maximum XNU physical memory footprint (MiB) observed in any match on this ladder.
  peak_ram REAL NOT NULL DEFAULT 0.0,
  -- Cumulative fault counters from match end reasons, surfaced for health monitoring.
  crashes INTEGER NOT NULL DEFAULT 0,
  timeouts INTEGER NOT NULL DEFAULT 0,
  ooms INTEGER NOT NULL DEFAULT 0,
  -- Unix timestamp (seconds) when this version entered the ladder (defaults to 0 if unspecified).
  started_at INTEGER NOT NULL DEFAULT 0,
  -- Unix timestamp (seconds) when this version transitioned to `role = 'retired'`, or NULL while active.
  retired_at INTEGER,
  PRIMARY KEY (ladder_id, version_id)
);

CREATE INDEX IF NOT EXISTS idx_ladder_entries_ladder_role
  ON ladder_entries(ladder_id, role);
