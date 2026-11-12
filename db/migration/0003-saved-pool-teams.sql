-- Allow incrementally validated `'saved'` pool teams before/between submissions.
CREATE TABLE agent_ladder_teams_new (
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  ladder_id TEXT NOT NULL REFERENCES ladders(id) ON DELETE CASCADE,
  team_index INTEGER NOT NULL CHECK (team_index >= 1),
  packed_team TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('saved', 'pending', 'active')),
  submitted_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, ladder_id, status, team_index)
);

INSERT INTO agent_ladder_teams_new (
  agent_id,
  ladder_id,
  team_index,
  packed_team,
  status,
  submitted_at
)
SELECT agent_id, ladder_id, team_index, packed_team, status, submitted_at
FROM agent_ladder_teams;

DROP TABLE agent_ladder_teams;
ALTER TABLE agent_ladder_teams_new RENAME TO agent_ladder_teams;

CREATE INDEX IF NOT EXISTS idx_agent_ladder_teams_status
  ON agent_ladder_teams(ladder_id, status);
