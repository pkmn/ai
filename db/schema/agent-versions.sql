-- Immutable artifact submissions uploaded by developers for an Arena agent.
--
-- Features: Submission intake (`POST /api/submissions`), Mac mini pull queue
--   (`GET /api/arena/pending-submissions`), smoke-test status & error reporting on `/account`,
--   runtime quarantine (`pkmn quarantine`), Discord status DMs, and version lineage history.
-- Relationships: Many-to-one child of `agents` (and optionally `developers`); referenced by
--   `ladder_entries`, `matches`, `pair_aggregates`, `rating_snapshots`, `agent_ladder_stats`,
--   `tournament_entrants`, and `tournament_games`.
-- Why standalone: Separating artifact metadata and smoke-test lifecycle (`agent_versions`) from
--   per-ladder competitive standings (`ladder_entries`) allows a single bundle/OCI image submission
--   to enter multiple ladders simultaneously (e.g. RBY + ADV + SV) without duplicating artifact
--   hashes, encrypted pull credentials, or smoke-test logs.
CREATE TABLE IF NOT EXISTS agent_versions (
  -- Internal surrogate key referenced across all ladder and tournament tables.
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Owning Arena agent.
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  -- Developer who submitted this version on `/account` (NULL if seeded via CLI or developer removed).
  developer_id INTEGER REFERENCES developers(id) ON DELETE SET NULL,
  -- Competitor-chosen version label matching `^[A-Za-z0-9][A-Za-z0-9._-]{0,11}$` (max 12 chars).
  version TEXT NOT NULL CHECK (length(version) BETWEEN 1 AND 12),
  -- Execution packaging format:
  --   'bundle': native darwin/arm64 tarball (.tar.gz / .tar.xz / .tar.zst) with executable ./run
  --   'oci': OCI container image reference (linux/arm64 on ladders; linux/amd64 on tournaments)
  package TEXT NOT NULL CHECK (package IN ('bundle', 'oci')),
  -- HTTPS archive URL or OCI image reference pulled once by the Arena worker.
  url TEXT NOT NULL,
  -- Expected 64-character lowercase hex SHA-256 archive checksum or OCI manifest digest.
  sha256 TEXT NOT NULL,
  -- Optional AES-256-GCM ciphertext (`iv:tag:ciphertext` base64, keyed via HKDF-SHA256(ARENA_SECRET))
  -- for pulling private releases/registries. Scrubbed to NULL immediately when smoke testing finishes
  -- so pkmn.ai never retains competitor credentials at rest.
  auth_token_encoding TEXT,
  -- JSON array of ladder IDs selected at submission time (e.g. '["gen1ou20261109","gen9ou20261109"]').
  ladders_json TEXT NOT NULL DEFAULT '[]',
  -- JSON array of tournament IDs selected at submission time (e.g. '["3"]'). Gated independently of
  -- the 14-day ladder cooldown and unsettled-challenger checks (max 1 entry per project per event).
  tournaments_json TEXT NOT NULL DEFAULT '[]',
  -- Uncompressed resident size in bytes measured on unpack (enforced <= 500 MB), or NULL pre-pull.
  unpacked_bytes INTEGER,
  -- Smoke-test and runtime health state:
  --   'pending': queued for pull and offline 1-turn smoke test on the Mac mini
  --   'passed': unpacked and completed smoke tests across all selected ladders; live in Arena
  --   'failed': unpack/checksum/smoke test failed (14-day submission cooldown is automatically refunded)
  --   'quarantined': disabled after excessive runtime crashes/timeouts/OOMs or staff intervention
  smoke_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (smoke_status IN ('pending', 'passed', 'failed', 'quarantined')),
  -- Total wall-clock duration of the offline smoke test in milliseconds, or NULL.
  smoke_duration_millis INTEGER,
  -- Mean Turn-1 decision latency observed during the smoke test in milliseconds, or NULL.
  smoke_turn_millis INTEGER,
  -- Peak XNU physical memory footprint observed during the smoke test in MiB, or NULL.
  smoke_peak_ram INTEGER,
  -- Sanitized diagnostic log shown to the owning developer on `/account` when 'failed'/'quarantined'.
  smoke_error TEXT,
  -- Unix timestamp (seconds) when the developer submitted this version.
  submitted_at INTEGER NOT NULL,
  -- Unix timestamp (seconds) when `smoke_status` first transitioned to 'passed', or NULL.
  activated_at INTEGER,
  -- Boolean flag (0 or 1) tracking whether Discord DMs for the latest terminal status ('passed',
  -- 'failed', or 'quarantined') have been delivered, enabling retry across transient Discord outages
  -- and out-of-process `pkmn quarantine` CLI invocations.
  notified INTEGER NOT NULL DEFAULT 0 CHECK (notified IN (0, 1)),
  UNIQUE (agent_id, version)
);

CREATE INDEX IF NOT EXISTS idx_agent_versions_agent ON agent_versions(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_versions_developer ON agent_versions(developer_id);
CREATE INDEX IF NOT EXISTS idx_agent_versions_smoke ON agent_versions(smoke_status);
