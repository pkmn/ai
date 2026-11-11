-- Registered Arena competitor identities synced from `arena:` blocks in static/projects.yml.
--
-- Features: Competitor registration & qualification gating (/account), 14-day submission cooldown
--   tracking, profile pages (/projects/<slug>), and parent identity across versions/ladders/tournaments.
-- Relationships: Parent of developers, agent_versions, agent_ladder_stats, agent_ladder_teams, and
--   tournament_entrants.
-- Why standalone: A competitor project persists across many submitted executable `agent_versions` and
--   multiple `developers`. Keeping project-level qualification status, logo metadata, and the shared
--   14-day submission cooldown on `agents` prevents team members or version uploads from bypassing
--   project-wide rate limits and links all versions into one lineage.
CREATE TABLE IF NOT EXISTS agents (
  -- Internal surrogate key referenced by child tables so slug/name edits do not cascade strings.
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- URL-safe identifier derived from project name via slugify() (e.g. '0-error', 'foul-play').
  slug TEXT NOT NULL UNIQUE,
  -- Display name from static/projects.yml (e.g. '0 ERROR', 'Foul Play').
  name TEXT NOT NULL,
  -- Optional filename in static/avatars/ (or build/public) for the project profile logo, or NULL.
  logo TEXT,
  -- Registration & Smogon standing state:
  --   'pending': awaiting staff qualification (`arena.qualified: false`) or Smogon standing check
  --   'qualified': `arena.qualified: true` and every registered owner has 'good' Smogon standing
  --   'disabled': removed from `arena:` in projects.yml or revoked due to bad Smogon standing
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'qualified', 'disabled')),
  -- Unix timestamp (seconds) up to which staff manually waived the 14-day submission cooldown via
  -- `pkmn refund-cooldown <slug>` (failed smoke tests never start the cooldown in the first place).
  cooldown_refunded_at INTEGER,
  -- Unix timestamp (seconds) when this agent row was created or last updated.
  updated_at INTEGER NOT NULL
);
