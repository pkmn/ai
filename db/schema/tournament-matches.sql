-- Scheduled/completed tournament matches (one row per match in Round Robin or Superfinal).
-- Individual games within a match (1 for Bo1, up to N for BoN) live in tournament_games.
CREATE TABLE IF NOT EXISTS tournament_matches (
  -- Stable deterministic identifier (e.g., '<tournament_id>-rr-c001-g001' or '<tournament_id>-sf-g001').
  id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id),
  stage TEXT NOT NULL DEFAULT 'Round Robin' CHECK (stage IN ('Round Robin', 'Superfinal')),
  -- Round-robin cycle index (1..cycles) or Superfinal series game index.
  cycle INTEGER NOT NULL,
  -- 1-indexed game number within the specific ordered (p1, p2) pair across the stage.
  matchup_game INTEGER NOT NULL,
  p1_version_id INTEGER NOT NULL REFERENCES agent_versions(id),
  p2_version_id INTEGER NOT NULL REFERENCES agent_versions(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed')),
  preemptions INTEGER NOT NULL DEFAULT 0,
  -- Packed Showdown team strings used by P1 and P2 in this match.
  p1_team TEXT,
  p2_team TEXT,
  -- Outcome from P1's perspective ('W' = P1 won, 'L' = P2 won, 'T' = tie).
  outcome TEXT CHECK (outcome IN ('W', 'L', 'T')),
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tournament_matches_tournament_status
  ON tournament_matches(tournament_id, status);
CREATE INDEX IF NOT EXISTS idx_tournament_matches_completed
  ON tournament_matches(tournament_id, status, completed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_tournament_matches_p1_version
  ON tournament_matches(p1_version_id);
CREATE INDEX IF NOT EXISTS idx_tournament_matches_p2_version
  ON tournament_matches(p2_version_id);
