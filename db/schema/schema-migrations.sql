-- Tracks applied incremental SQL migrations from db/migration/NNNN-description.sql.
--
-- Features: Zero-downtime schema evolution on the production SQLite database (/var/lib/pkmn/arena.sqlite).
-- Relationships: Standalone bookkeeping table read and updated exclusively by Database.initializeSchema
--   in db/index.ts before serving traffic.
-- Why standalone: SQLite PRAGMA user_version only stores a single integer and cannot record per-script
--   audit timestamps or detect out-of-order / duplicate sequence prefixes across branches.
CREATE TABLE IF NOT EXISTS schema_migrations (
  -- Migration filename (e.g. '0001-add-column.sql'), matching /^\d{4}-[a-z0-9-]+\.sql$/.
  version TEXT PRIMARY KEY,
  -- Unix timestamp (seconds) when the migration transaction committed.
  applied_at INTEGER NOT NULL
);
