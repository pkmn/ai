CREATE TABLE IF NOT EXISTS pair_aggregates (
  ladder_id TEXT NOT NULL REFERENCES ladders(id),
  v_low_id INTEGER NOT NULL REFERENCES bot_versions(id),
  v_high_id INTEGER NOT NULL REFERENCES bot_versions(id),
  ww INTEGER NOT NULL DEFAULT 0,
  wt INTEGER NOT NULL DEFAULT 0,
  split INTEGER NOT NULL DEFAULT 0,
  tl INTEGER NOT NULL DEFAULT 0,
  ll INTEGER NOT NULL DEFAULT 0,
  cur_streak INTEGER NOT NULL DEFAULT 0,
  v_low_max_win_streak INTEGER NOT NULL DEFAULT 0,
  v_high_max_win_streak INTEGER NOT NULL DEFAULT 0,
  los_low REAL,
  PRIMARY KEY (ladder_id, v_low_id, v_high_id),
  CHECK (v_low_id < v_high_id)
);
