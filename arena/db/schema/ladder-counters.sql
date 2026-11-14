-- Monotonic per-format and global match sequence counters on the Mac mini runner.
--
-- Features: Deterministic match ID generation (`<format>-<seq>`) and periodic cold-eviction cadence
--   checks (`getGlobalMatchCount`).
-- Relationships: Updated atomically inside `nextMatchSequence` in `arena/db/ladder-counters.ts`.
-- Why standalone: Keeps sequence allocation independent of `local_matches` row pruning or aborts.
CREATE TABLE IF NOT EXISTS ladder_counters (
  -- `@pkmn/sim` format identifier (e.g. 'gen9ou').
  format TEXT PRIMARY KEY,
  -- Latest per-format match sequence number allocated on this runner.
  next_seq INTEGER NOT NULL DEFAULT 0,
  -- Global match sequence number across all formats at the time `next_seq` was last incremented.
  last_global_match_seq INTEGER NOT NULL DEFAULT 0
);
