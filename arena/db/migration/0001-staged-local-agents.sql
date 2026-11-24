-- Expand local_agents.residency CHECK constraint to include 'staged' (passed diagnostic test on
-- the Mac mini, held on SSD until activated into cold archive or discarded).
CREATE TABLE local_agents_new (
  version_id INTEGER PRIMARY KEY,
  agent_id INTEGER NOT NULL,
  slug TEXT NOT NULL,
  version TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('native', 'container')),
  target TEXT NOT NULL,
  residency TEXT NOT NULL DEFAULT 'hot' CHECK (residency IN ('staged', 'hot', 'cold')),
  unpacked_bytes INTEGER NOT NULL DEFAULT 0,
  consecutive_faults INTEGER NOT NULL DEFAULT 0,
  total_games INTEGER NOT NULL DEFAULT 0,
  total_faults INTEGER NOT NULL DEFAULT 0,
  last_played_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

INSERT INTO local_agents_new (
  version_id, agent_id, slug, version, mode, target, residency,
  unpacked_bytes, consecutive_faults, total_games, total_faults,
  last_played_at, created_at
)
SELECT
  version_id, agent_id, slug, version, mode, target, residency,
  unpacked_bytes, consecutive_faults, total_games, total_faults,
  last_played_at, created_at
FROM local_agents;

DROP TABLE local_agents;
ALTER TABLE local_agents_new RENAME TO local_agents;

CREATE INDEX IF NOT EXISTS idx_local_agents_residency
  ON local_agents(residency, last_played_at ASC);
