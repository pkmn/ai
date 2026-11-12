-- Defines every competitive ladder epoch (both permanent generational ladders and rotating seasonal
-- formats such as VGC regulations).
--
-- Features: Leaderboard tabs (/arena/<slot>), matchmaking pool eligibility, seasonal format rotation
--   (pkmn rotate-ladder), VGC competitor team-pool sizing, and #1 Discord crown role assignment.
-- Relationships: Referenced by ladder_entries, matches, pair_aggregates, rating_snapshots,
--   agent_ladder_stats, and agent_ladder_teams. Synced at startup from config/ladders.yml.
-- Why standalone: Decoupling the immutable primary key `id` (e.g. 'gen9championsvgc2026regmc') from
--   the URL `slot` ('vgc') allows rotating a seasonal regulation without deleting or overwriting
--   prior seasons' matches, ratings, or daily snapshots: old rows transition to status = 'archived'
--   under an archived display name while the new epoch takes over the active `slot`.
CREATE TABLE IF NOT EXISTS ladders (
  -- Immutable season/epoch identifier (e.g. 'gen1ou20261109', 'gen9championsvgc2026regmc').
  id TEXT PRIMARY KEY,
  -- Canonical URL slug ('rby', 'adv', 'sv', 'rand', 'vgc'), inferred from `name` on initial sync
  -- and preserved across seasonal rotations so archived seasons remain grouped with their slot.
  slot TEXT NOT NULL,
  -- Short UI label ('RBY', 'ADV', 'SV', 'RAND', 'VGC', or an archived season title like 'VGC Reg M-C').
  name TEXT NOT NULL,
  -- @pkmn/sim format ID used for battle simulation and TeamValidator legality checks (e.g. 'gen1ou').
  format TEXT NOT NULL,
  -- How teams are supplied before each blind-pair match:
  --   'harvested': sampled from curated public tournament/high-ladder pools on the Arena runner
  --   'random': generated per seed by @pkmn/sim (e.g. gen9randombattle)
  --   'pools': sampled from competitor-submitted team rosters (e.g. 20 unique VGC teams per agent)
  team TEXT NOT NULL CHECK (team IN ('harvested', 'random', 'pools')),
  -- Minimum distinct active agents required before the matchmaker schedules games on this ladder
  -- (2 for 'harvested'/'random'; >= 4 for 'pools' so every agent's roster has uniform 2/N weight
  -- while enforcing at most one active-player team per match).
  min INTEGER NOT NULL,
  -- Required number of unique teams each competitor must submit when `team = 'pools'` (e.g. 20);
  -- NULL for 'harvested' and 'random' ladders.
  teams INTEGER,
  -- Discord role Snowflake granted to owners of the settled #1-ranked agent on this ladder, or NULL.
  discord TEXT,
  -- Lifecycle state:
  --   'upcoming': visible as disabled on /account, not yet open for submissions or matchmaking
  --   'active': open for submissions and active-learning matchmaking
  --   'settling': closed to new submissions before archiving; runs until all active entries settle
  --   'archived': frozen historical leaderboard retained for profile/archive browsing
  status TEXT NOT NULL DEFAULT 'upcoming'
    CHECK (status IN ('upcoming', 'active', 'settling', 'archived')),
  -- Unix timestamp (seconds) when this ladder epoch was first registered.
  created_at INTEGER NOT NULL,
  -- Unix timestamp (seconds) when this ladder transitioned to 'archived', or NULL while live/upcoming.
  archived_at INTEGER
);
