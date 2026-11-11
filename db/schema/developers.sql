-- Authorized human developers associated with registered Arena agents.
--
-- Features: GitHub OAuth login authorization (/account, /wiki/<project>), Smogon account standing
--   verification, self-service Discord linking for submission/quarantine DMs, and automatic Discord
--   @Arena Competitor + #1 ladder role assignment.
-- Relationships: Many-to-one child of `agents` (a team project can list multiple co-authors under
--   `arena.owners` in static/projects.yml); optionally referenced by `agent_versions.developer_id`
--   for audit provenance.
-- Why standalone: Projects may have multiple co-authors, while every external identity (`github_id`,
--   `github_login`, `smogon_id`, `discord_id`) carries a table-wide UNIQUE constraint so a single
--   person cannot register under two Arena projects to circumvent the 14-day cooldown or 2-version cap.
--   Immutable numeric IDs (`github_id`, `smogon_id`, `discord_id`) are stored alongside display
--   handles because GitHub, Smogon, and Discord usernames can all be renamed.
CREATE TABLE IF NOT EXISTS developers (
  -- Internal surrogate key referenced by `agent_versions.developer_id`.
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Owning Arena agent; deleting an agent cascades its developer mappings.
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  -- Immutable numeric GitHub user ID, populated upon first GitHub OAuth sign-in.
  github_id INTEGER UNIQUE,
  -- Case-insensitive GitHub username from `arena.owners` in static/projects.yml.
  github_login TEXT NOT NULL COLLATE NOCASE UNIQUE,
  -- Immutable numeric Smogon XenForo user ID resolved from `arena.owners` via server/smogon.ts.
  smogon_id INTEGER UNIQUE,
  -- Resolved Smogon forum username for display and audit purposes.
  smogon_username TEXT,
  -- Cached Smogon account standing:
  --   'good': verified account with zero ban/disciplinary banners
  --   'bad': banned/restricted on Smogon (automatically demotes parent agent out of 'qualified')
  --   'missing': Smogon user could not be found
  --   'unknown': not yet checked or transient network error during lookup
  smogon_standing TEXT NOT NULL DEFAULT 'unknown'
    CHECK (smogon_standing IN ('good', 'bad', 'missing', 'unknown')),
  -- Immutable Discord user Snowflake linked by the developer via OAuth on /account, or NULL.
  discord_id TEXT UNIQUE,
  -- Discord username captured at link time for display on /account.
  discord_username TEXT,
  -- Unix timestamp (seconds) when external standing/identity was last verified, or NULL.
  verified_at INTEGER,
  -- Unix timestamp (seconds) when this developer row was created.
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_developers_agent ON developers(agent_id);
