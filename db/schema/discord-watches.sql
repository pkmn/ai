-- One-shot Discord DM watches for live Arena ladder matches and tournament games.
--
-- Features: Guild slash command `/watch [agent] [opponent] [event]` and DM re-arm buttons in
--   `server/discord.ts`, allowing any Discord guild member (project owners or spectators) to
--   receive a one-shot DM when an agent or specific matchup goes live.
-- Relationships: References `agents(id)` (subject and optional opponent) and optionally scopes
--   the watch to a single `ladders(id)` or `tournaments(id)` via mutually exclusive foreign keys.
-- Why standalone: Persisting watches in SQLite survives VPS restarts/deploys (critical for
--   scheduled tournaments and less-frequent ladder matchups) and supports atomic single-shot
--   consumption on match start without risking double-DMs across heartbeats or multi-game batches.
CREATE TABLE IF NOT EXISTS discord_watches (
  -- Internal surrogate key referenced by per-watch cancel buttons.
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Immutable Discord user Snowflake who armed this watch.
  discord_id TEXT NOT NULL,
  -- Watched agent ID (when `opponent_id` is set, canonicalized so `agent_id < opponent_id`).
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  -- Optional second agent ID for a specific matchup watch (always `> agent_id` when non-NULL).
  opponent_id INTEGER REFERENCES agents(id) ON DELETE CASCADE,
  -- Optional ladder scope (mutually exclusive with `tournament_id`).
  ladder_id TEXT REFERENCES ladders(id) ON DELETE CASCADE,
  -- Optional tournament scope (mutually exclusive with `ladder_id`).
  tournament_id TEXT REFERENCES tournaments(id) ON DELETE CASCADE,
  -- Unix timestamp (seconds) when this watch was armed.
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
