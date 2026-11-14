-- Local disk residency, execution target, and runtime fault counters for unpacked agent versions
-- on the Mac mini runner.
--
-- Features: Hot/cold LRU cache eviction (`evictColdAgentsIfNeeded`), warm-pair matchmaking bonus
--   (`computeResidencyMultipliers`), and consecutive runtime fault tracking (`CONSECUTIVE_FAULTS_QUARANTINE`).
-- Relationships: Keyed by `version_id` matching `agent_versions.id` on the central `pkmn.ai` server;
--   referenced logically by `local_matches` (`p1_version_id`, `p2_version_id`).
-- Why standalone: Hot/cold SSD residency (`/var/lib/arena/agents` vs `/var/lib/arena/cold`),
--   local target paths/tags, and consecutive process fault streaks are host-local execution state
--   owned by the Mac mini worker rather than public web metadata.
CREATE TABLE IF NOT EXISTS local_agents (
  -- Server-assigned `agent_versions.id` primary key.
  version_id INTEGER PRIMARY KEY,
  -- Owning `agents.id` from `pkmn.ai`.
  agent_id INTEGER NOT NULL,
  -- URL-safe project slug (e.g. 'foul-play').
  slug TEXT NOT NULL,
  -- Developer-chosen version label (e.g. '1.0.0').
  version TEXT NOT NULL,
  -- Local sandbox execution backend ('native' Seatbelt bundle or 'container' Podman OCI image).
  mode TEXT NOT NULL CHECK (mode IN ('native', 'container')),
  -- Relative bundle directory under `agentsDir` or local Podman image tag (`localhost/arena-...`).
  target TEXT NOT NULL,
  -- Current SSD tier ('hot' unpacked on SSD ready to spawn, or 'cold' compressed `.tar.zst`).
  residency TEXT NOT NULL DEFAULT 'hot' CHECK (residency IN ('hot', 'cold')),
  -- Uncompressed resident byte count on disk, used to enforce high/low watermarks on the 256 GB SSD.
  unpacked_bytes INTEGER NOT NULL DEFAULT 0,
  -- Consecutive games ending in a process fault ('crash', 'timeout', 'oom', 'invalid-choice').
  -- Reset to 0 after any clean game; triggers quarantine at `CONSECUTIVE_FAULTS_QUARANTINE` (3).
  consecutive_faults INTEGER NOT NULL DEFAULT 0,
  -- Cumulative games played locally by this version.
  total_games INTEGER NOT NULL DEFAULT 0,
  -- Cumulative games ending in a process fault locally by this version.
  total_faults INTEGER NOT NULL DEFAULT 0,
  -- Unix timestamp (seconds) when this version last played a game, ordering LRU cold eviction.
  last_played_at INTEGER NOT NULL,
  -- Unix timestamp (seconds) when this version was first unpacked on the runner.
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_local_agents_residency
  ON local_agents(residency, last_played_at ASC);
