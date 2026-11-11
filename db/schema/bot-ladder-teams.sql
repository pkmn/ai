CREATE TABLE IF NOT EXISTS bot_ladder_teams (
  ladder_id TEXT NOT NULL REFERENCES ladders(id),
  bot_id INTEGER NOT NULL REFERENCES bots(id),
  slot_index INTEGER NOT NULL,
  canonical_packed TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (ladder_id, bot_id, slot_index)
);
