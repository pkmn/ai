-- Add public host-measured CPU utilization and fixed-enum protocol error aggregates to ladder_entries.
ALTER TABLE ladder_entries ADD COLUMN mean_cpu_cores REAL NOT NULL DEFAULT 0.0;
ALTER TABLE ladder_entries ADD COLUMN cpu_matches INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ladder_entries ADD COLUMN invalid_choices INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ladder_entries ADD COLUMN invalid_cant_move INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ladder_entries ADD COLUMN invalid_cant_switch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ladder_entries ADD COLUMN invalid_target INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ladder_entries ADD COLUMN invalid_other INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ladder_entries ADD COLUMN unavailable_choices INTEGER NOT NULL DEFAULT 0;
ALTER TABLE matches ADD COLUMN p1_game1_cpu_cores REAL;
ALTER TABLE matches ADD COLUMN p1_game2_cpu_cores REAL;
ALTER TABLE matches ADD COLUMN p2_game1_cpu_cores REAL;
ALTER TABLE matches ADD COLUMN p2_game2_cpu_cores REAL;
