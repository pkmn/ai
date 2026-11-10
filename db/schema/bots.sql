CREATE TABLE IF NOT EXISTS bots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  logo_file TEXT,
  status TEXT NOT NULL DEFAULT 'approved',
  cooldown_refunded_at INTEGER,
  updated_at INTEGER NOT NULL
);
