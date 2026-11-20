-- Rebuild ladders and tournaments to add required `version TEXT NOT NULL` without a schema DEFAULT
-- while backfilling pre-existing rows created under @pkmn/sim 0.11.0.

CREATE TABLE ladders_new (
  id TEXT PRIMARY KEY,
  slot TEXT NOT NULL,
  name TEXT NOT NULL,
  format TEXT NOT NULL,
  version TEXT NOT NULL,
  team TEXT NOT NULL CHECK (team IN ('harvested', 'random', 'pools')),
  min INTEGER NOT NULL,
  teams INTEGER,
  discord TEXT,
  status TEXT NOT NULL DEFAULT 'upcoming'
    CHECK (status IN ('upcoming', 'active', 'settling', 'archived')),
  created_at INTEGER NOT NULL,
  archived_at INTEGER
);
INSERT INTO ladders_new (
  id, slot, name, format, version, team, min,
  teams, discord, status, created_at, archived_at
)
SELECT
  id, slot, name, format, '0.11.0', team, min,
  teams, discord, status, created_at, archived_at
FROM ladders;
DROP TABLE ladders;
ALTER TABLE ladders_new RENAME TO ladders;

CREATE TABLE tournaments_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  format TEXT NOT NULL,
  version TEXT NOT NULL,
  team TEXT CHECK (team IN ('harvested', 'random', 'pools')),
  rules_json TEXT NOT NULL DEFAULT '[]',
  games_per_matchup INTEGER NOT NULL,
  batch_size INTEGER NOT NULL DEFAULT 10,
  parallel_tables INTEGER NOT NULL,
  hardware TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'running', 'completed')),
  starts_at INTEGER NOT NULL,
  completed_at INTEGER
);
INSERT INTO tournaments_new (
  id, name, format, version, team, rules_json, games_per_matchup,
  batch_size, parallel_tables, hardware, status, starts_at, completed_at
)
SELECT
  id, name, format, '0.11.0', team, rules_json, games_per_matchup,
  batch_size, parallel_tables, hardware, status, starts_at, completed_at
FROM tournaments;
DROP TABLE tournaments;
ALTER TABLE tournaments_new RENAME TO tournaments;
