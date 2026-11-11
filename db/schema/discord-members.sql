CREATE TABLE IF NOT EXISTS discord_members (
  discord_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
