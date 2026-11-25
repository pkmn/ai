-- Allow staff to disable or re-enable the rolling 24h failed/discarded smoke-test rate limit
-- per project from `/admin`.
ALTER TABLE agents
  ADD COLUMN unlimited_smoke_tests INTEGER NOT NULL DEFAULT 0
  CHECK (unlimited_smoke_tests IN (0, 1));
