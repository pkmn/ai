-- Add `/ready` initialization, team preview, and mean RAM telemetry columns.

ALTER TABLE matches ADD COLUMN p1_game1_init_millis REAL NOT NULL DEFAULT 0.0;
ALTER TABLE matches ADD COLUMN p1_game2_init_millis REAL NOT NULL DEFAULT 0.0;
ALTER TABLE matches ADD COLUMN p2_game1_init_millis REAL NOT NULL DEFAULT 0.0;
ALTER TABLE matches ADD COLUMN p2_game2_init_millis REAL NOT NULL DEFAULT 0.0;

ALTER TABLE matches ADD COLUMN p1_game1_team_preview_millis REAL;
ALTER TABLE matches ADD COLUMN p1_game2_team_preview_millis REAL;
ALTER TABLE matches ADD COLUMN p2_game1_team_preview_millis REAL;
ALTER TABLE matches ADD COLUMN p2_game2_team_preview_millis REAL;

ALTER TABLE ladder_entries ADD COLUMN mean_init_millis REAL NOT NULL DEFAULT 0.0;
ALTER TABLE ladder_entries ADD COLUMN mean_team_preview_millis REAL;
ALTER TABLE ladder_entries ADD COLUMN team_preview_matches INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ladder_entries ADD COLUMN mean_ram REAL NOT NULL DEFAULT 0.0;

ALTER TABLE agent_versions ADD COLUMN smoke_init_millis INTEGER;
ALTER TABLE agent_versions ADD COLUMN smoke_team_preview_millis INTEGER;

ALTER TABLE tournament_games ADD COLUMN p1_init_millis REAL;
ALTER TABLE tournament_games ADD COLUMN p2_init_millis REAL;
ALTER TABLE tournament_games ADD COLUMN p1_team_preview_millis REAL;
ALTER TABLE tournament_games ADD COLUMN p2_team_preview_millis REAL;
