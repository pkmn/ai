CREATE TABLE IF NOT EXISTS tournaments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  format_id TEXT NOT NULL,
  custom_rules_json TEXT NOT NULL DEFAULT '[]',
  games_per_matchup INTEGER NOT NULL,
  batch_size INTEGER NOT NULL DEFAULT 10,
  parallel_tables INTEGER NOT NULL,
  hardware_desc TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  starts_at INTEGER NOT NULL,
  completed_at INTEGER
);
