-- Add per-ladder slot qualification grants and backfill existing live Arena projects.
CREATE TABLE IF NOT EXISTS agent_ladders (
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  slot TEXT NOT NULL CHECK (slot IN ('rby', 'adv', 'sv', 'rand', 'vgc')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, slot)
);

INSERT OR IGNORE INTO agent_ladders (agent_id, slot, updated_at)
SELECT id, 'rby', CAST(strftime('%s', 'now') AS INTEGER)
FROM agents
WHERE slug = 'magpie' AND status != 'disabled';

INSERT OR IGNORE INTO agent_ladders (agent_id, slot, updated_at)
SELECT id, 'adv', CAST(strftime('%s', 'now') AS INTEGER)
FROM agents
WHERE slug = 'magpie' AND status != 'disabled';

INSERT OR IGNORE INTO agent_ladders (agent_id, slot, updated_at)
SELECT id, 'vgc', CAST(strftime('%s', 'now') AS INTEGER)
FROM agents
WHERE slug = 'mocca' AND status != 'disabled';

INSERT OR IGNORE INTO agent_ladders (agent_id, slot, updated_at)
SELECT id, 'rand', CAST(strftime('%s', 'now') AS INTEGER)
FROM agents
WHERE slug = 'missingnozero' AND status != 'disabled';
