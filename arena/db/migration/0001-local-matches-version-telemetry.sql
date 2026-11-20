-- Persist ladder @pkmn/sim version plus Game 1 init and Team Preview telemetry on local_matches
-- so crash recovery after a daemon restart resumes Game 2 on the exact same sim version and
-- preserves full Game 1 telemetry.
ALTER TABLE local_matches ADD COLUMN version TEXT NOT NULL DEFAULT '0.11.0';
ALTER TABLE local_matches ADD COLUMN g1_p1_init_millis INTEGER;
ALTER TABLE local_matches ADD COLUMN g1_p2_init_millis INTEGER;
ALTER TABLE local_matches ADD COLUMN g1_p1_team_preview_millis INTEGER;
ALTER TABLE local_matches ADD COLUMN g1_p2_team_preview_millis INTEGER;
