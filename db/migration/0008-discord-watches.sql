-- Add one-shot Discord DM watches for live Arena ladder matches and tournament games.
CREATE TABLE IF NOT EXISTS discord_watches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id TEXT NOT NULL,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  opponent_id INTEGER REFERENCES agents(id) ON DELETE CASCADE,
  ladder_id TEXT REFERENCES ladders(id) ON DELETE CASCADE,
  tournament_id TEXT REFERENCES tournaments(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  CHECK (opponent_id IS NULL OR agent_id < opponent_id),
  CHECK (NOT (ladder_id IS NOT NULL AND tournament_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_discord_watches_user
  ON discord_watches(discord_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_discord_watches_agent
  ON discord_watches(agent_id, opponent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_discord_watches_unique
  ON discord_watches(
    discord_id,
    agent_id,
    COALESCE(opponent_id, 0),
    COALESCE(ladder_id, ''),
    COALESCE(tournament_id, '')
  );
