-- Frozen version roster, standings points, Sonneborn-Berger tiebreakers, and tournament Elo for
-- each agent entered in a tournament.
--
-- Features: Tournament standings table, crosstable headers, and trophy/final-rank badges on
--   `/arena/tournaments/<id>` and `/arena#tournaments`.
-- Relationships: Joins `tournaments`, `agents`, and `agent_versions` (`UNIQUE (tournament_id,
--   agent_id)` enforces the 1-entry-per-project tournament rule).
-- Why standalone: Unlike ladders (which allow up to 2 concurrent active versions and rolling
--   upgrades), a tournament locks exactly one `version_id` per `agent_id` at start time and ranks
--   entrants by tournament points (`1` win, `0.5` tie) and Sonneborn-Berger opponent-weighted score
--   rather than ladder LCB.
CREATE TABLE IF NOT EXISTS tournament_entrants (
  -- Tournament in which this entrant competes.
  tournament_id TEXT NOT NULL REFERENCES tournaments(id),
  -- Competing Arena agent (`UNIQUE (tournament_id, agent_id)` caps each project to one entry).
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  -- Frozen executable version locked in for the duration of the tournament.
  version_id INTEGER NOT NULL REFERENCES agent_versions(id),
  -- 1-based initial seeding number (typically derived from pre-tournament ladder conservative rating).
  seed INTEGER NOT NULL,
  -- Tournament match points (`game_wins + 0.5 * game_ties`).
  points REAL NOT NULL DEFAULT 0.0,
  -- Sonneborn-Berger tiebreak score (sum of defeated opponents' points + half of tied opponents' points).
  sonneborn_berger REAL NOT NULL DEFAULT 0.0,
  -- Individual Round Robin / Superfinal game counts.
  game_wins INTEGER NOT NULL DEFAULT 0,
  game_losses INTEGER NOT NULL DEFAULT 0,
  game_ties INTEGER NOT NULL DEFAULT 0,
  -- Event-scoped Elo estimate and standard error computed over tournament games.
  elo REAL NOT NULL DEFAULT 1500.0,
  se REAL NOT NULL DEFAULT 350.0,
  -- Official 1-based final placement set when the tournament completes, or NULL while in progress.
  final_rank INTEGER,
  PRIMARY KEY (tournament_id, version_id),
  UNIQUE (tournament_id, agent_id)
);
