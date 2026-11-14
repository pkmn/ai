-- Durable store-and-forward queue for completed matches, smoke-test results, and quarantine events
-- awaiting HTTP delivery to `pkmn.ai`.
--
-- Features: Guarantees zero lost matches across `pkmn.ai` deploys or transient WAN outages
--   (`flushOutbox`); permanently rejected `4xx` payloads are evicted while `5xx`/network errors
--   retry in FIFO order.
-- Relationships: Populated atomically alongside `local_matches` completion or smoke/quarantine
--   transitions in `arena/coordinator.ts`.
-- Why standalone: Decouples local match execution on the Mac mini from remote HTTP availability.
CREATE TABLE IF NOT EXISTS outbox (
  -- Monotonically increasing FIFO queue ID.
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Target `pkmn.ai` API endpoint category.
  endpoint TEXT NOT NULL
    CHECK (endpoint IN ('match-complete', 'submission-status', 'quarantine')),
  -- Serialized JSON request body for the target endpoint.
  payload_json TEXT NOT NULL,
  -- Number of failed delivery attempts so far.
  attempts INTEGER NOT NULL DEFAULT 0,
  -- Most recent HTTP/network error message, or NULL if never attempted.
  last_error TEXT,
  -- Unix timestamp (seconds) when the item was enqueued.
  created_at INTEGER NOT NULL,
  -- Unix timestamp (seconds) of the most recent delivery attempt, or NULL.
  updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_outbox_created
  ON outbox(id ASC);
