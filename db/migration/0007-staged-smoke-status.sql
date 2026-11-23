-- Expand agent_versions.smoke_status CHECK constraint to support 'staged' (passed diagnostic,
-- awaiting explicit developer activation) and 'discarded' (rejected by developer before activation).
CREATE TABLE agent_versions_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  developer_id INTEGER REFERENCES developers(id) ON DELETE SET NULL,
  version TEXT NOT NULL CHECK (length(version) BETWEEN 1 AND 12),
  package TEXT NOT NULL CHECK (package IN ('bundle', 'oci')),
  url TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  auth_token_encoding TEXT,
  ladders_json TEXT NOT NULL DEFAULT '[]',
  tournaments_json TEXT NOT NULL DEFAULT '[]',
  unpacked_bytes INTEGER,
  smoke_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (smoke_status IN ('pending', 'staged', 'passed', 'failed', 'discarded', 'quarantined')),
  smoke_duration_millis INTEGER,
  smoke_init_millis INTEGER,
  smoke_team_preview_millis INTEGER,
  smoke_turn_millis INTEGER,
  smoke_peak_ram INTEGER,
  smoke_error TEXT,
  submitted_at INTEGER NOT NULL,
  activated_at INTEGER,
  notified INTEGER NOT NULL DEFAULT 0 CHECK (notified IN (0, 1)),
  UNIQUE (agent_id, version)
);

INSERT INTO agent_versions_new (
  id, agent_id, developer_id, version, package, url, sha256, auth_token_encoding,
  ladders_json, tournaments_json, unpacked_bytes, smoke_status, smoke_duration_millis,
  smoke_init_millis, smoke_team_preview_millis, smoke_turn_millis, smoke_peak_ram,
  smoke_error, submitted_at, activated_at, notified
)
SELECT
  id, agent_id, developer_id, version, package, url, sha256, auth_token_encoding,
  ladders_json, tournaments_json, unpacked_bytes, smoke_status, smoke_duration_millis,
  smoke_init_millis, smoke_team_preview_millis, smoke_turn_millis, smoke_peak_ram,
  smoke_error, submitted_at, activated_at, notified
FROM agent_versions;

DROP TABLE agent_versions;
ALTER TABLE agent_versions_new RENAME TO agent_versions;

CREATE INDEX IF NOT EXISTS idx_agent_versions_agent ON agent_versions(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_versions_developer ON agent_versions(developer_id);
CREATE INDEX IF NOT EXISTS idx_agent_versions_smoke ON agent_versions(smoke_status);
