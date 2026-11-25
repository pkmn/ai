-- Replace boolean smoke_diagnostics.supports_info with 3-state info_status ('none' | 'partial' |
-- 'full'). Existing rows with supports_info = 1 become 'partial' because pre-migration diagnostics
-- did not check per-choice win + policy coverage.
CREATE TABLE smoke_diagnostics_new (
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
  info_status TEXT NOT NULL DEFAULT 'none' CHECK (info_status IN ('none', 'partial', 'full')),
  created_at INTEGER NOT NULL
);

INSERT INTO smoke_diagnostics_new (
  id, version_id, ladder_id, tournament_id, format, turns, end_reason, duration_millis,
  battle_log, p1_stderr, p2_stderr, p1_cpu_cores, p2_cpu_cores,
  p1_peak_ram, p2_peak_ram, info_status, created_at
)
SELECT
  id, version_id, ladder_id, tournament_id, format, turns, end_reason, duration_millis,
  battle_log, p1_stderr, p2_stderr, p1_cpu_cores, p2_cpu_cores,
  p1_peak_ram, p2_peak_ram,
  CASE WHEN supports_info = 1 THEN 'partial' ELSE 'none' END,
  created_at
FROM smoke_diagnostics;

DROP TABLE smoke_diagnostics;
ALTER TABLE smoke_diagnostics_new RENAME TO smoke_diagnostics;

CREATE INDEX IF NOT EXISTS idx_smoke_diagnostics_version
  ON smoke_diagnostics(version_id, id);
