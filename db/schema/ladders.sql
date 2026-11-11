CREATE TABLE IF NOT EXISTS ladders (
  id TEXT PRIMARY KEY,
  slot TEXT NOT NULL,
  display_name TEXT NOT NULL,
  format_id TEXT NOT NULL,
  team_mode TEXT NOT NULL,
  min_bots INTEGER NOT NULL DEFAULT 2,
  team_count INTEGER,
  discord_role TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  archived_at INTEGER
);
