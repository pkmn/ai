-- Rebuild local_matches to persist required ladder @pkmn/sim `version TEXT NOT NULL` (with no
-- schema DEFAULT, backfilling pre-existing rows to '0.11.0') plus Game 1 init and Team Preview
-- telemetry for crash recovery across daemon restarts.

CREATE TABLE local_matches_new (
  id TEXT PRIMARY KEY,
  ladder_id TEXT NOT NULL,
  format TEXT NOT NULL,
  team_mode TEXT NOT NULL CHECK (team_mode IN ('random', 'harvested', 'pools')),
  p1_version_id INTEGER NOT NULL,
  p1_agent_id INTEGER NOT NULL,
  p1_slug TEXT NOT NULL,
  p1_name TEXT NOT NULL,
  p1_version TEXT NOT NULL,
  p1_mode TEXT NOT NULL CHECK (p1_mode IN ('native', 'container')),
  p1_target TEXT NOT NULL,
  p2_version_id INTEGER NOT NULL,
  p2_agent_id INTEGER NOT NULL,
  p2_slug TEXT NOT NULL,
  p2_name TEXT NOT NULL,
  p2_version TEXT NOT NULL,
  p2_mode TEXT NOT NULL CHECK (p2_mode IN ('native', 'container')),
  p2_target TEXT NOT NULL,
  seed TEXT NOT NULL,
  p1_team_packed TEXT NOT NULL,
  p2_team_packed TEXT NOT NULL,
  p1_team_label TEXT,
  p2_team_label TEXT,
  status TEXT NOT NULL DEFAULT 'in-progress'
    CHECK (status IN ('in-progress', 'g1-complete', 'complete', 'aborted')),
  g1_outcome TEXT CHECK (g1_outcome IN ('W', 'L', 'T')),
  g1_turns INTEGER,
  g1_end_reason TEXT,
  g1_p1_bank_seconds INTEGER,
  g1_p2_bank_seconds INTEGER,
  g1_p1_ram INTEGER,
  g1_p2_ram INTEGER,
  g1_p1_turn_millis INTEGER,
  g1_p2_turn_millis INTEGER,
  started_at INTEGER NOT NULL,
  g1_completed_at INTEGER,
  completed_at INTEGER,
  version TEXT NOT NULL,
  g1_p1_init_millis INTEGER,
  g1_p2_init_millis INTEGER,
  g1_p1_team_preview_millis INTEGER,
  g1_p2_team_preview_millis INTEGER
);

INSERT INTO local_matches_new (
  id, ladder_id, format, team_mode,
  p1_version_id, p1_agent_id, p1_slug, p1_name, p1_version, p1_mode, p1_target,
  p2_version_id, p2_agent_id, p2_slug, p2_name, p2_version, p2_mode, p2_target,
  seed, p1_team_packed, p2_team_packed, p1_team_label, p2_team_label,
  status, g1_outcome, g1_turns, g1_end_reason,
  g1_p1_bank_seconds, g1_p2_bank_seconds, g1_p1_ram, g1_p2_ram,
  g1_p1_turn_millis, g1_p2_turn_millis,
  started_at, g1_completed_at, completed_at,
  version, g1_p1_init_millis, g1_p2_init_millis,
  g1_p1_team_preview_millis, g1_p2_team_preview_millis
)
SELECT
  id, ladder_id, format, team_mode,
  p1_version_id, p1_agent_id, p1_slug, p1_name, p1_version, p1_mode, p1_target,
  p2_version_id, p2_agent_id, p2_slug, p2_name, p2_version, p2_mode, p2_target,
  seed, p1_team_packed, p2_team_packed, p1_team_label, p2_team_label,
  status, g1_outcome, g1_turns, g1_end_reason,
  g1_p1_bank_seconds, g1_p2_bank_seconds, g1_p1_ram, g1_p2_ram,
  g1_p1_turn_millis, g1_p2_turn_millis,
  started_at, g1_completed_at, completed_at,
  '0.11.0', NULL, NULL, NULL, NULL
FROM local_matches;

DROP TABLE local_matches;
ALTER TABLE local_matches_new RENAME TO local_matches;

CREATE INDEX IF NOT EXISTS idx_local_matches_status
  ON local_matches(status, started_at ASC);
