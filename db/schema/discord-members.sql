-- Snapshot cache of current pkmn.ai Discord guild members, refreshed every sync cycle by server/discord.ts.
--
-- Features: Fast sub-millisecond guild-membership verification for Nginx `auth_request`
--   (`/auth/discord/validate` protecting `/chat/logs/*`) and Discord OAuth login checks.
-- Relationships: Populated independently of `developers` from Discord REST `GET /guilds/:id/members`
--   so any Discord community member—not just registered Arena competitors—can read `/chat/logs/`.
-- Why standalone: Querying Discord's REST API on every Nginx `auth_request` subrequest would add
--   hundreds of milliseconds of latency and quickly exhaust Discord rate limits; caching the member
--   roster in SQLite turns `/auth/discord/validate` into an instant primary-key lookup and lets
--   revoked/departed guild members lose `/chat/logs/` access within one sync cycle even while their
--   `pkmn_session` cookie is still unexpired.
CREATE TABLE IF NOT EXISTS discord_members (
  -- Immutable Discord user Snowflake.
  id TEXT PRIMARY KEY,
  -- Current Discord username as of the latest guild member sync.
  username TEXT NOT NULL,
  -- Unix timestamp (seconds) when this member list snapshot was written.
  updated_at INTEGER NOT NULL
);
