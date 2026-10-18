-- Additive only: existing recipes, backups and device sessions are untouched.
CREATE TABLE IF NOT EXISTS mcp_oauth_store (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS mcp_oauth_expiry ON mcp_oauth_store(expires_at);
CREATE TABLE IF NOT EXISTS mcp_drafts (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  body_sha256 TEXT NOT NULL,
  recipe_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  received_at TEXT
);
CREATE TABLE IF NOT EXISTS mcp_rate_limits (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
