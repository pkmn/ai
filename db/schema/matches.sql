-- Append-only ledger of completed 2-game blind-pair ladder matches and per-match runtime telemetry.
--
-- Features: Recent match feeds (`/arena/battles`, `/api/live.json`, `/projects/<slug>#matches`),
--   idempotent match ingestion (`POST /api/arena/match-complete` deduplicates on `id`), and audit
--   verification of sufficient statistics in `ladder_entries` and `pair_aggregates`.
-- Relationships: References `ladders` and the two competing `agent_versions` (`p1_version_id`,
--   `p2_version_id`).
-- Why standalone: Every ladder match consists of two games played on the same PRNG seed with swapped
--   teams (`(T1, T2)` in Game 1, `(T2, T1)` in Game 2) to cancel team matchup bias to first order.
--   Storing the 2-game blind pair as a single atomic row reflects the atomic statistical observation
--   modeled by Generalized Davidson ratings while intentionally omitting full battle logs or team
--   sheets so competitors cannot harvest ladder replays to counter-style opponents.
CREATE TABLE IF NOT EXISTS matches (
  -- Globally unique match identifier assigned by the Arena runner (e.g. 'gen1ou-0000999').
  id TEXT PRIMARY KEY,
  -- Ladder epoch on which this match was played.
  ladder_id TEXT NOT NULL REFERENCES ladders(id),
  -- Agent version assigned to slot P1 in Game 1 (and P2 in Game 2). All `game1_outcome` / `game2_outcome`
  -- and `category` values are recorded from `p1_version_id`'s perspective.
  p1_version_id INTEGER NOT NULL REFERENCES agent_versions(id),
  -- Agent version assigned to slot P2 in Game 1 (and P1 in Game 2).
  p2_version_id INTEGER NOT NULL REFERENCES agent_versions(id),
  -- Deterministic @pkmn/sim PRNG seed shared across both games of the blind pair.
  seed TEXT NOT NULL,
  -- Optional anonymized team short-hash labels on `pools` ladders (e.g. 'b7b8bb1cbc73' when drawn
  -- from a third-party competitor's pool, or 'P1:16d479804e3d' / 'P2:16d479804e3d' when drawn from
  -- Match Player 1's or Match Player 2's submitted pool; at most one team in a match can belong to
  -- either active player), or NULL on `random` / `harvested` ladders. Never reveals species/sets.
  p1_team_label TEXT,
  p2_team_label TEXT,
  -- Individual game outcomes from `p1_version_id`'s perspective ('W', 'L', or 'T').
  game1_outcome TEXT NOT NULL CHECK (game1_outcome IN ('W', 'L', 'T')),
  game2_outcome TEXT NOT NULL CHECK (game2_outcome IN ('W', 'L', 'T')),
  -- Combined 2-game category from `p1_version_id`'s perspective:
  --   'WW' (2-0), 'WT'/'TW' (1.5-0.5), 'WL'/'LW'/'TT' (1-1 split), 'TL'/'LT' (0.5-1.5), 'LL' (0-2).
  category TEXT NOT NULL
    CHECK (category IN ('WW', 'WT', 'TW', 'WL', 'LW', 'TT', 'TL', 'LT', 'LL')),
  -- Turn counts for Game 1 and Game 2.
  game1_turns INTEGER NOT NULL,
  game2_turns INTEGER NOT NULL,
  -- Termination reason for each game (e.g. 'win', 'tie', 'turn_limit', 'timeout', 'crash', 'oom',
  -- 'invalid_choice_3x').
  game1_end_reason TEXT NOT NULL,
  game2_end_reason TEXT NOT NULL,
  -- Peak XNU physical memory footprint (MiB) observed for each agent across the 2-game match.
  p1_peak_ram REAL NOT NULL,
  p2_peak_ram REAL NOT NULL,
  -- Remaining Showdown chess-clock bank (in seconds) at the end of Game 1 and Game 2 for each agent.
  p1_game1_bank_seconds REAL NOT NULL,
  p1_game2_bank_seconds REAL NOT NULL,
  p2_game1_bank_seconds REAL NOT NULL,
  p2_game2_bank_seconds REAL NOT NULL,
  -- Mean decision latency per turn (in milliseconds) across both games for each agent.
  p1_mean_turn_millis REAL NOT NULL,
  p2_mean_turn_millis REAL NOT NULL,
  -- Unix timestamp (seconds) when Game 2 finished.
  completed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_matches_ladder_completed
  ON matches(ladder_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_matches_completed
  ON matches(completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_matches_p1_completed
  ON matches(ladder_id, p1_version_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_matches_p2_completed
  ON matches(ladder_id, p2_version_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_matches_p1_version ON matches(p1_version_id);
CREATE INDEX IF NOT EXISTS idx_matches_p2_version ON matches(p2_version_id);
