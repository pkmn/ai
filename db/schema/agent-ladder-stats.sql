-- Project-wide ("All Versions") career peaks, streaks, and reign clocks on a single ladder.
--
-- Features: Powers the default "All Versions" view on agent profile pages (`/projects/<slug>`) so
--   an agent's unbroken #1 reign or win streak continues seamlessly when its developer upgrades from
--   `v1.0` to `v1.1`.
-- Relationships: Joins `agents` and `ladders` (with optional `max_elo_version_id` pointing to the
--   `agent_versions` row that set the career Elo peak). Updated alongside `ladder_entries` after each
--   match and rating solve.
-- Why standalone: Summing or taking `MAX()` across `ladder_entries` rows cannot reconstruct project-wide
--   consecutive streaks or continuous Top-K reign durations that span version handoffs (e.g. `v1.0`
--   holding #1 for 20 days and handing #1 directly to `v1.1` for 15 days yields a 35-day unbroken
--   project reign, whereas neither version's individual `top1_max_streak_seconds` exceeds 20 days).
CREATE TABLE IF NOT EXISTS agent_ladder_stats (
  -- Arena agent whose cross-version career on `ladder_id` is summarized.
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  -- Ladder epoch on which these career stats were earned.
  ladder_id TEXT NOT NULL REFERENCES ladders(id),
  -- Best (lowest number) settled rank achieved by any version of this agent on this ladder.
  -- (`best_rank_at`, `max_lcb`, `max_elo_at`, `max_elo_version_id`, and `max_gxe_at` are retained
  -- for future `/projects/<slug>` & `/account` career peak timeline displays; do not delete.)
  best_rank INTEGER,
  best_rank_at INTEGER,
  -- Highest Conservative Rating (`elo - 1.96 * se`) achieved across versions with `matches >= 10`.
  max_lcb REAL,
  -- Highest settled MAP Elo achieved by any version of this agent, its concurrent SE, timestamp,
  -- and responsible version.
  max_elo REAL,
  max_elo_se REAL,
  max_elo_at INTEGER,
  max_elo_version_id INTEGER REFERENCES agent_versions(id),
  -- Highest settled GXE achieved by any version of this agent and timestamp.
  max_gxe REAL,
  max_gxe_at INTEGER,
  -- Cross-version consecutive outright match win/loss streaks against distinct rival agents.
  current_win_streak INTEGER NOT NULL DEFAULT 0,
  current_loss_streak INTEGER NOT NULL DEFAULT 0,
  max_win_streak INTEGER NOT NULL DEFAULT 0,
  max_loss_streak INTEGER NOT NULL DEFAULT 0,
  -- Cross-version Top-1 / Top-10 / Top-100 reign clocks (in seconds) evaluated on the agent's
  -- highest-LCB representative version at each match step.
  top1_entered_at INTEGER,
  top1_max_streak_seconds INTEGER NOT NULL DEFAULT 0,
  top1_total_seconds INTEGER NOT NULL DEFAULT 0,
  top10_entered_at INTEGER,
  top10_max_streak_seconds INTEGER NOT NULL DEFAULT 0,
  top10_total_seconds INTEGER NOT NULL DEFAULT 0,
  top100_entered_at INTEGER,
  top100_max_streak_seconds INTEGER NOT NULL DEFAULT 0,
  top100_total_seconds INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ladder_id, agent_id)
);
