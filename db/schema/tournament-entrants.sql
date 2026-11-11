CREATE TABLE IF NOT EXISTS tournament_entrants (
  tournament_id TEXT NOT NULL REFERENCES tournaments(id),
  bot_id INTEGER NOT NULL REFERENCES bots(id),
  version_id INTEGER NOT NULL REFERENCES bot_versions(id),
  seed_number INTEGER NOT NULL,
  points REAL NOT NULL DEFAULT 0,
  sb_score REAL NOT NULL DEFAULT 0,
  game_wins INTEGER NOT NULL DEFAULT 0,
  game_losses INTEGER NOT NULL DEFAULT 0,
  game_ties INTEGER NOT NULL DEFAULT 0,
  tourney_elo REAL NOT NULL DEFAULT 1500,
  tourney_se REAL NOT NULL DEFAULT 350,
  final_rank INTEGER,
  PRIMARY KEY (tournament_id, version_id),
  UNIQUE (tournament_id, bot_id)
);
