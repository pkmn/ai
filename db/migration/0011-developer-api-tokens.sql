-- Add revocable per-developer API tokens for headless Submission API access
-- (`GET /account.json`, `POST /api/submissions`, `/api/account/versions/:id/{activate,discard}`,
-- and diagnostic log/stderr downloads). Only the SHA-256 hash and display prefix are stored.
ALTER TABLE developers ADD COLUMN api_token_hash TEXT;
ALTER TABLE developers ADD COLUMN api_token_prefix TEXT;
ALTER TABLE developers ADD COLUMN api_token_created_at INTEGER;
ALTER TABLE developers ADD COLUMN api_token_last_used_at INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_developers_api_token_hash ON developers(api_token_hash);
