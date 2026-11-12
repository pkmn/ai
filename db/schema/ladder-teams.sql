-- Server-stored validated team rosters for `team = 'harvested'` ladders.
--
-- Features: Stores canonicalized, @pkmn/sim-validated 6-Pokémon packed teams uploaded via
--   `pkmn upload-ladder-teams` or `PUT /api/arena/ladders/:id/teams`, gating activation checks and
--   serving private Arena runner pulls (`GET /api/arena/ladders/:id/teams`) symmetrically with
--   competitor `agent_ladder_teams`.
-- Relationships: Keyed by `(ladder_id, team_index)` referencing `ladders(id)`.
CREATE TABLE IF NOT EXISTS ladder_teams (
  -- Harvested ladder ID (`team = 'harvested'`).
  ladder_id TEXT NOT NULL REFERENCES ladders(id) ON DELETE CASCADE,
  -- 1-based index of this team within the ladder's uploaded pool.
  team_index INTEGER NOT NULL CHECK (team_index >= 1),
  -- Canonicalized packed Showdown team string (`Team.pack()`); kept strictly server/runner-internal.
  packed_team TEXT NOT NULL,
  -- Unix timestamp (seconds) when this pool was uploaded.
  uploaded_at INTEGER NOT NULL,
  PRIMARY KEY (ladder_id, team_index)
);
