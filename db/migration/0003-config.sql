-- Add singleton config table for operator-tunable coordinator settings.
CREATE TABLE IF NOT EXISTS config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  smoke_tests_per_cycle INTEGER NOT NULL DEFAULT 1 CHECK (smoke_tests_per_cycle >= 0),
  smoke_test_cycle_interval INTEGER NOT NULL DEFAULT 1 CHECK (smoke_test_cycle_interval >= 1),
  updated_at INTEGER NOT NULL
);
