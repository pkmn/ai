-- Per-ladder slot qualification grants for registered Arena agents.
--
-- Features: Granular ladder submission gating on `/account` and `POST /api/submissions`, `/admin`
--   eligibility toggles, `pkmn set-ladders` CLI, and derived `agents.status` ('qualified' iff >= 1
--   slot is granted, else 'pending' for non-disabled agents).
-- Relationships: Child of `agents` (`ON DELETE CASCADE`). Keyed by ladder `slot` rather than
--   `ladder_id` so seasonal format rotations (e.g. VGC Reg M-C -> Reg M-D) preserve qualification.
-- Why standalone: Keeping mutable qualification grants in SQLite rather than git-tracked
--   `static/projects.yml` ensures runtime changes survive deploys and `sync-projects` boots.
CREATE TABLE IF NOT EXISTS agent_ladders (
  -- Owning Arena agent; deleting an agent cascades its ladder qualification grants.
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  -- Ladder slot the agent is qualified to enter ('rby', 'adv', 'sv', 'rand', 'vgc').
  slot TEXT NOT NULL CHECK (slot IN ('rby', 'adv', 'sv', 'rand', 'vgc')),
  -- Unix timestamp (seconds) when this slot grant was recorded.
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, slot)
);
