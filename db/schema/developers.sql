CREATE TABLE IF NOT EXISTS developers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  github_login TEXT NOT NULL UNIQUE,
  github_id INTEGER UNIQUE,
  smogon_id INTEGER NOT NULL UNIQUE,
  smogon_username TEXT NOT NULL,
  discord_id TEXT UNIQUE,
  discord_username TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_developers_bot ON developers(bot_id);
