-- Crash-recovery checkpoints for in-flight 2-game mirror matches on the Mac mini runner.
--
-- Features: Power-loss / daemon-restart recovery (`recoverIncompleteMatches`): matches interrupted
--   during Game 1 ('in-progress') are cleanly aborted, while matches that finished Game 1
--   ('g1-complete') resume directly at Game 2 using the persisted PRNG seed, packed teams, and
--   Game 1 telemetry.
-- Relationships: References local agent versions (`p1_version_id`, `p2_version_id`) and produces a
--   `match-complete` payload enqueued in `outbox` upon Game 2 completion.
-- Why standalone: The central `pkmn.ai` `matches` table only records completed 2-game mirror pairs;
--   half-completed match state after Game 1 is transient worker state on the Mac mini.
CREATE TABLE IF NOT EXISTS local_matches (
  -- Globally unique match identifier (`<format>-<zero_padded_seq>`, e.g. 'gen9ou-0000042').
  id TEXT PRIMARY KEY,
  -- Target ladder identifier on `pkmn.ai` (e.g. 'gen9ou202611').
  ladder_id TEXT NOT NULL,
  -- `@pkmn/sim` format ID (e.g. 'gen9ou').
  format TEXT NOT NULL,
  -- Ladder team assignment mode ('random', 'harvested', or 'pools').
  team_mode TEXT NOT NULL CHECK (team_mode IN ('random', 'harvested', 'pools')),
  -- Player 1 version, agent metadata, and local execution target for Game 1 (swapped to P2 in Game 2).
  p1_version_id INTEGER NOT NULL,
  p1_agent_id INTEGER NOT NULL,
  p1_slug TEXT NOT NULL,
  p1_name TEXT NOT NULL,
  p1_version TEXT NOT NULL,
  p1_mode TEXT NOT NULL CHECK (p1_mode IN ('native', 'container')),
  p1_target TEXT NOT NULL,
  -- Player 2 version, agent metadata, and local execution target for Game 1 (swapped to P1 in Game 2).
  p2_version_id INTEGER NOT NULL,
  p2_agent_id INTEGER NOT NULL,
  p2_slug TEXT NOT NULL,
  p2_name TEXT NOT NULL,
  p2_version TEXT NOT NULL,
  p2_mode TEXT NOT NULL CHECK (p2_mode IN ('native', 'container')),
  p2_target TEXT NOT NULL,
  -- Shared 4-uint16 PRNG seed (`s1,s2,s3,s4`) replayed identically across Game 1 and Game 2.
  seed TEXT NOT NULL,
  -- Canonical packed team assigned to Player 1 in Game 1 (and Player 2 in Game 2).
  p1_team_packed TEXT NOT NULL,
  -- Canonical packed team assigned to Player 2 in Game 1 (and Player 1 in Game 2).
  p2_team_packed TEXT NOT NULL,
  -- Optional 12-hex-char SHA-256 team fingerprint (prefixed with `P1:`/`P2:` for self-piloted pools).
  p1_team_label TEXT,
  p2_team_label TEXT,
  -- Lifecycle state:
  --   'in-progress': Game 1 is currently running (aborted on daemon restart)
  --   'g1-complete': Game 1 finished and its log/telemetry are persisted (resumed at Game 2 on restart)
  --   'complete': both games finished and match payload was committed to outbox
  --   'aborted': interrupted during Game 1 and discarded on restart
  status TEXT NOT NULL DEFAULT 'in-progress'
    CHECK (status IN ('in-progress', 'g1-complete', 'complete', 'aborted')),
  -- Game 1 result from `p1_version_id`'s perspective ('W', 'L', or 'T'), populated at 'g1-complete'.
  g1_outcome TEXT CHECK (g1_outcome IN ('W', 'L', 'T')),
  -- Turn count and terminal reason ('win', 'tie', 'timeout', 'crash', 'oom', 'invalid-choice', 'max-turns') for Game 1.
  g1_turns INTEGER,
  g1_end_reason TEXT,
  -- Remaining chess-clock bank in seconds at the end of Game 1.
  g1_p1_bank_seconds INTEGER,
  g1_p2_bank_seconds INTEGER,
  -- Peak memory footprint in MiB and mean per-decision latency in milliseconds from Game 1.
  g1_p1_ram INTEGER,
  g1_p2_ram INTEGER,
  g1_p1_turn_millis INTEGER,
  g1_p2_turn_millis INTEGER,
  -- Unix timestamps (seconds) for match start, Game 1 checkpoint, and match completion.
  started_at INTEGER NOT NULL,
  g1_completed_at INTEGER,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_local_matches_status
  ON local_matches(status, started_at ASC);
