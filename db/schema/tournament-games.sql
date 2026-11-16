-- Individual games within a tournament match (1 row for Bo1, up to N rows for BoN).
CREATE TABLE IF NOT EXISTS tournament_games (
  match_id TEXT NOT NULL REFERENCES tournament_matches(id) ON DELETE CASCADE,
  game_number INTEGER NOT NULL CHECK (game_number >= 1),
  seed TEXT NOT NULL,
  -- Outcome from P1's perspective ('W' = P1 won, 'L' = P2 won, 'T' = tie).
  outcome TEXT CHECK (outcome IN ('W', 'L', 'T')),
  turns INTEGER,
  end_reason TEXT,
  p1_bank_seconds REAL,
  p2_bank_seconds REAL,
  p1_mean_turn_millis REAL,
  p2_mean_turn_millis REAL,
  p1_peak_ram INTEGER,
  p2_peak_ram INTEGER,
  PRIMARY KEY (match_id, game_number)
);
