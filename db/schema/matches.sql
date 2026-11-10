CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  ladder_id TEXT NOT NULL REFERENCES ladders(id),
  v1_id INTEGER NOT NULL REFERENCES bot_versions(id),
  v2_id INTEGER NOT NULL REFERENCES bot_versions(id),
  seed TEXT NOT NULL,
  team1_label TEXT,
  team2_label TEXT,
  g1_outcome TEXT NOT NULL,
  g2_outcome TEXT NOT NULL,
  match_category TEXT NOT NULL,
  g1_turns INTEGER NOT NULL,
  g2_turns INTEGER NOT NULL,
  g1_end_reason TEXT NOT NULL,
  g2_end_reason TEXT NOT NULL,
  v1_peak_ram_mb INTEGER NOT NULL,
  v2_peak_ram_mb INTEGER NOT NULL,
  v1_g1_bank_s REAL NOT NULL,
  v1_g2_bank_s REAL NOT NULL,
  v2_g1_bank_s REAL NOT NULL,
  v2_g2_bank_s REAL NOT NULL,
  v1_avg_turn_ms INTEGER NOT NULL,
  v2_avg_turn_ms INTEGER NOT NULL,
  completed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_matches_ladder_completed ON matches(ladder_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_matches_v1 ON matches(v1_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_matches_v2 ON matches(v2_id, completed_at DESC);
