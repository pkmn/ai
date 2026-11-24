-- Private per-format diagnostic smoke-test artifacts (Showdown battle log, bounded 64 KiB
-- p1/p2 stderr capture, and host resource telemetry) accessible only to the owning project's
-- authenticated developers on `/account/`.
--
-- Relationships: Many-to-one child of `agent_versions` (deleted automatically if the parent
--   version row is deleted).
CREATE TABLE IF NOT EXISTS smoke_diagnostics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES agent_versions(id) ON DELETE CASCADE,
  -- Optional ladder ID when this diagnostic ran for a ladder target.
  ladder_id TEXT,
  -- Optional tournament ID when this diagnostic ran for a scheduled tournament target.
  tournament_id TEXT,
  -- Showdown format ID exercised (e.g. 'gen1ou', 'gen9vgc2026regf').
  format TEXT NOT NULL,
  -- Number of turns completed in the self-play diagnostic game.
  turns INTEGER NOT NULL DEFAULT 0,
  -- Arbiter end reason ('win', 'tie', 'diagnostic-cap', 'timeout', 'crash', 'oom', etc.).
  end_reason TEXT NOT NULL,
  -- Wall-clock duration of the diagnostic game in milliseconds.
  duration_millis INTEGER NOT NULL DEFAULT 0,
  -- Full omniscient Showdown battle log (including `|ai|` telemetry lines) for private replay.
  battle_log TEXT NOT NULL,
  -- Bounded 64 KiB (16 KiB head + 48 KiB tail) stderr output from slot p1, or NULL if empty.
  p1_stderr TEXT,
  -- Bounded 64 KiB (16 KiB head + 48 KiB tail) stderr output from slot p2, or NULL if empty.
  p2_stderr TEXT,
  -- Host-measured effective CPU cores used by p1 during active thinking, or NULL.
  p1_cpu_cores REAL,
  -- Host-measured effective CPU cores used by p2 during active thinking, or NULL.
  p2_cpu_cores REAL,
  -- Peak physical memory footprint (MiB) observed for p1, or NULL.
  p1_peak_ram INTEGER,
  -- Peak physical memory footprint (MiB) observed for p2, or NULL.
  p2_peak_ram INTEGER,
  -- Boolean flag (0 or 1) recording whether valid displayable `/info` telemetry was emitted.
  supports_info INTEGER NOT NULL DEFAULT 0 CHECK (supports_info IN (0, 1)),
  -- Unix timestamp (seconds) when this diagnostic record was persisted.
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_smoke_diagnostics_version
  ON smoke_diagnostics(version_id, id);
