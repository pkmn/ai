CREATE TABLE IF NOT EXISTS rating_snapshots (
  ladder_id TEXT NOT NULL REFERENCES ladders(id),
  version_id INTEGER NOT NULL REFERENCES bot_versions(id),
  day_utc TEXT NOT NULL,
  matches_played INTEGER NOT NULL DEFAULT 0,
  rating_elo REAL NOT NULL,
  rating_se REAL NOT NULL,
  rating_lcb REAL NOT NULL,
  gxe REAL NOT NULL,
  rank_current INTEGER,
  rank_min INTEGER,
  rank_max INTEGER,
  rank_best INTEGER,
  PRIMARY KEY (ladder_id, version_id, day_utc)
);
