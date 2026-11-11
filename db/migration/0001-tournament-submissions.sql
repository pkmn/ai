-- Add `tournaments_json` to `agent_versions` so developers can submit OCI images to scheduled
-- Championship Tournaments independently of continuous-ladder cooldown and settlement gates.
ALTER TABLE agent_versions ADD COLUMN tournaments_json TEXT NOT NULL DEFAULT '[]';
