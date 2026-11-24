-- Store private per-format diagnostic smoke-test replays and bounded stderr logs per version.
CREATE TABLE IF NOT EXISTS smoke_diagnostics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES agent_versions(id) ON DELETE CASCADE,
  ladder_id TEXT,
  tournament_id TEXT,
  format TEXT NOT NULL,
  turns INTEGER NOT NULL DEFAULT 0,
  end_reason TEXT NOT NULL,
  duration_millis INTEGER NOT NULL DEFAULT 0,
  battle_log TEXT NOT NULL,
  p1_stderr TEXT,
  p2_stderr TEXT,
  p1_cpu_cores REAL,
  p2_cpu_cores REAL,
  p1_peak_ram INTEGER,
  p2_peak_ram INTEGER,
  supports_info INTEGER NOT NULL DEFAULT 0 CHECK (supports_info IN (0, 1)),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_smoke_diagnostics_version
  ON smoke_diagnostics(version_id, id);
