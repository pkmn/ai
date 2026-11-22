-- Singleton runtime configuration for the Mac mini Arena coordinator.
--
-- Features: Operator-tunable smoke-test ingestion cadence (`pkmn set-smoke-cadence`) surfaced to
--   the Arena worker via `GET /api/arena/ladders` so smoke-test throughput can be dialed up during
--   launch bursts or throttled/paused without restarting the coordinator.
-- Relationships: Standalone singleton row (`id = 1`) read on every coordinator tick and updated by
--   admin CLI commands.
-- Why standalone: Keeps mutable operational knobs in SQLite WAL alongside live ladder state rather
--   than coupling runtime throttling to git-tracked `config/*.yml` deploys.
CREATE TABLE IF NOT EXISTS config (
  -- Enforced singleton primary key (`id = 1`).
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- Maximum pending ladder submissions smoke-tested in a single coordinator cycle (`0` pauses).
  smoke_tests_per_cycle INTEGER NOT NULL DEFAULT 1 CHECK (smoke_tests_per_cycle >= 0),
  -- Coordinator match cycles required between smoke-test batches (`1` = every cycle, `N` = 1 every N).
  smoke_test_cycle_interval INTEGER NOT NULL DEFAULT 1 CHECK (smoke_test_cycle_interval >= 1),
  -- Unix timestamp (seconds) when the configuration was last updated.
  updated_at INTEGER NOT NULL
);
