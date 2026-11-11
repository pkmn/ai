-- Scheduled, live, and archived cloud-GPU tournament events (e.g. seasonal BYOT championships).
--
-- Features: Tournament selector, event metadata banner, live multi-table broadcast shell, and
--   archived championship pages under `/arena/tournaments/<id>` (summarized on `/arena#tournaments`).
-- Relationships: Parent of `tournament_entrants` and `tournament_games`.
-- Why standalone: Tournaments differ fundamentally from continuous blind-pair ladders: they run on
--   ephemeral cloud GPU VMs over a fixed schedule, allow pondering and Bring-Your-Own-Team (BYOT)
--   open/closed sheets, score individual games with Sonneborn-Berger tiebreaks + optional Superfinals,
--   and publish full Pokémon Showdown battle replays.
CREATE TABLE IF NOT EXISTS tournaments (
  -- URL-safe event identifier (e.g. '1', '2', or 'spring-2026').
  id TEXT PRIMARY KEY,
  -- Full human-readable event title (e.g. 'Autumn 2026 VGC Championship').
  name TEXT NOT NULL,
  -- @pkmn/sim format ID played in this tournament (e.g. 'gen9championsvgc2026regmc').
  format TEXT NOT NULL,
  -- JSON array of additional @pkmn/sim custom rule strings applied on top of `format`.
  rules_json TEXT NOT NULL DEFAULT '[]',
  -- Total head-to-head games scheduled per entrant pair across the Round Robin stage.
  games_per_matchup INTEGER NOT NULL,
  -- Number of games played per head-to-head batch within each macro-cycle.
  batch_size INTEGER NOT NULL DEFAULT 10,
  -- Number of concurrent battle tables executed in parallel across tournament worker VMs.
  parallel_tables INTEGER NOT NULL,
  -- Human-readable hardware specification per entrant (e.g. 'NVIDIA L4 · 8 vCPU · 32 GiB RAM').
  hardware TEXT NOT NULL,
  -- Event lifecycle state: 'scheduled', 'running', or 'completed'.
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'running', 'completed')),
  -- Unix timestamp (seconds) when the tournament starts (or started).
  starts_at INTEGER NOT NULL,
  -- Unix timestamp (seconds) when the tournament concluded, or NULL before completion.
  completed_at INTEGER
);
