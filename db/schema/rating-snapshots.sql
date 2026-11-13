-- End-of-day UTC rating and rank time-series snapshots for every version on a ladder.
--
-- Features: Multi-agent rating history SVG charts on ladder pages (`/arena/<slot>#history`) and
--   version lineage trajectories on agent profile pages (`/projects/<slug>#versions`).
-- Relationships: Joins `ladders` and `agent_versions`; upserted idempotently per `(ladder_id,
--   version_id, day_utc)` whenever `recomputeLadderRatings` runs.
-- Why standalone: `ladder_entries` only stores the latest posterior rating (retroactively updated
--   across the entire connected graph as opponents recalibrate). Recording one compact daily row per
--   active version preserves historical Elo/SE/LCB/rank trajectories for charts without bloating the
--   database with a per-match rating log.
CREATE TABLE IF NOT EXISTS rating_snapshots (
  -- Ladder epoch for this snapshot.
  ladder_id TEXT NOT NULL REFERENCES ladders(id),
  -- Agent version whose end-of-day rating is recorded.
  version_id INTEGER NOT NULL REFERENCES agent_versions(id),
  -- ISO-8601 UTC calendar date ('YYYY-MM-DD'). Multiple matches on the same UTC day overwrite that
  -- day's row so storage grows at most 365 rows/version/year.
  day_utc TEXT NOT NULL,
  -- Cumulative 2-game matches completed by `version_id` on `ladder_id` as of this snapshot.
  matches INTEGER NOT NULL,
  -- Snapshot MAP Generalized Davidson Elo, Standard Error, Conservative LCB, and GXE.
  elo REAL NOT NULL,
  se REAL NOT NULL,
  lcb REAL NOT NULL,
  gxe REAL NOT NULL,
  -- Snapshot official rank, 95% confidence rank interval `[rank_min, rank_max]`, and career best rank
  -- (retained for future historical rank-band visualizations; do not delete).
  rank_current INTEGER,
  rank_min INTEGER,
  rank_max INTEGER,
  rank_best INTEGER,
  PRIMARY KEY (ladder_id, version_id, day_utc)
);

CREATE INDEX IF NOT EXISTS idx_rating_snapshots_version ON rating_snapshots(version_id);
