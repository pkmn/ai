-- Individual scheduled, live, and completed tournament games with public team sheets and replay metadata.
--
-- Features: Tournament game log table, 6-Pokémon party minisprite rendering, embedded Pokémon
--   Showdown replay viewer links, and live/completed crosstable aggregation on `/arena/tournaments/<id>`.
-- Relationships: Joins `tournaments` and the two competing `agent_versions` (`p1_version_id`,
--   `p2_version_id`).
-- Why standalone: Tournament games are single-battle scheduled units (with Round Robin macro-cycles,
--   spot-VM preemption tracking, public packed team sheets, and public `.log` replay files on disk),
--   completely distinct from anonymized 2-game blind-pair ladder `matches`.
CREATE TABLE IF NOT EXISTS tournament_games (
  -- Unique game identifier, matching the public replay filename `<id>.log` when completed.
  id TEXT PRIMARY KEY,
  -- Parent tournament event.
  tournament_id TEXT NOT NULL REFERENCES tournaments(id),
  -- Competition phase: 'Round Robin' or championship 'Superfinal'.
  stage TEXT NOT NULL DEFAULT 'Round Robin' CHECK (stage IN ('Round Robin', 'Superfinal')),
  -- 1-based Round Robin macro-cycle index (ensures balanced progress across all pairs).
  cycle INTEGER NOT NULL,
  -- 1-based game number within this specific head-to-head matchup.
  matchup_game INTEGER NOT NULL,
  -- Agent version occupying Player 1 (`outcome` is recorded from `p1_version_id`'s perspective).
  p1_version_id INTEGER NOT NULL REFERENCES agent_versions(id),
  -- Agent version occupying Player 2.
  p2_version_id INTEGER NOT NULL REFERENCES agent_versions(id),
  -- Deterministic @pkmn/sim PRNG seed for this game.
  seed TEXT NOT NULL,
  -- Execution state: 'pending', 'running', or 'completed'.
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed')),
  -- Number of cloud spot-VM preemptions encountered before this game completed (for infra auditing).
  preemptions INTEGER NOT NULL DEFAULT 0,
  -- Packed Showdown teams brought by P1 and P2 (publicly rendered as 6-Pokémon minisprites once done).
  p1_team TEXT,
  p2_team TEXT,
  -- Outcome from `p1_version_id`'s perspective ('W', 'L', or 'T'), or NULL until completed.
  outcome TEXT CHECK (outcome IN ('W', 'L', 'T')),
  -- Total battle turns elapsed, or NULL until completed.
  turns INTEGER,
  -- Game termination reason ('win', 'tie', 'timeout', 'crash', 'oom', etc.), or NULL until completed.
  end_reason TEXT,
  -- Remaining clock bank (in seconds) for P1 and P2 at game end, or NULL until completed.
  p1_bank_seconds REAL,
  p2_bank_seconds REAL,
  -- Unix timestamp (seconds) when the game finished, or NULL until completed.
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tournament_games_tournament_status
  ON tournament_games(tournament_id, status, completed_at DESC);
