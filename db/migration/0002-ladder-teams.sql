-- Add `ladder_teams` for storing validated `team = 'harvested'` rosters in SQLite.
CREATE TABLE IF NOT EXISTS ladder_teams (
  ladder_id TEXT NOT NULL REFERENCES ladders(id) ON DELETE CASCADE,
  team_index INTEGER NOT NULL CHECK (team_index >= 1),
  packed_team TEXT NOT NULL,
  uploaded_at INTEGER NOT NULL,
  PRIMARY KEY (ladder_id, team_index)
);
