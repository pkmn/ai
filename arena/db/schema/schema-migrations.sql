-- Tracks applied incremental SQL migrations from arena/db/migration/NNNN-description.sql.
--
-- Features: Zero-downtime schema evolution on the Mac mini runner SQLite database
--   (/var/lib/arena/state.sqlite).
-- Relationships: Standalone bookkeeping table read and updated exclusively by SqliteDatabase
--   during initialization before the Arena coordinator loop starts.
-- Why standalone: SQLite PRAGMA user_version only stores a single integer and cannot record
--   per-script audit timestamps or detect out-of-order / duplicate sequence prefixes.
CREATE TABLE IF NOT EXISTS schema_migrations (
  -- Migration filename (e.g. '0001-add-column.sql'), matching /^\d{4}-[a-z0-9-]+\.sql$/.
  version TEXT PRIMARY KEY,
  -- Unix timestamp (seconds) when the migration transaction committed.
  applied_at INTEGER NOT NULL
);
