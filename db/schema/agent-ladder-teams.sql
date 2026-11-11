-- Competitor-submitted packed Showdown teams for `team = 'pools'` ladders (such as VGC).
--
-- Features: Stores each agent's validated 20-team roster (`d_1NN >= 1.30`) for seasonal pool
--   sampling without exposing raw team sheets on any public page or API.
-- Relationships: Keyed by `(agent_id, ladder_id, status, team_index)` referencing `agents` and `ladders`.
-- Why standalone: Team rosters belong to an agent's presence on a specific seasonal ladder rather
--   than to a single `agent_versions` row—an agent that submits v1.1 without uploading a replacement
--   paste continues contributing its existing 'active' 20-team pool, while a new paste is staged
--   under `status = 'pending'` and atomically promoted to `'active'` only if the new version passes
--   its smoke test (or discarded on `'failed'`, leaving the live pool untouched).
CREATE TABLE IF NOT EXISTS agent_ladder_teams (
  -- Owning Arena agent.
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  -- Seasonal `pools`-mode ladder to which these teams belong.
  ladder_id TEXT NOT NULL REFERENCES ladders(id) ON DELETE CASCADE,
  -- 1-based index within the agent's submitted paste (1..teams, e.g. 1..20), used in anonymized
  -- provenance labels such as '0 ERROR Team #4'.
  team_index INTEGER NOT NULL CHECK (team_index >= 1),
  -- Canonicalized packed Showdown team string (`Team.pack()`); kept strictly server/runner-internal.
  packed_team TEXT NOT NULL,
  -- Staging state:
  --   'pending': uploaded with an in-flight `pending` version awaiting smoke test
  --   'active': currently live in the ladder's shared competitor team pool
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active')),
  -- Unix timestamp (seconds) when this team roster was submitted.
  submitted_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, ladder_id, status, team_index)
);

CREATE INDEX IF NOT EXISTS idx_agent_ladder_teams_status
  ON agent_ladder_teams(ladder_id, status);
