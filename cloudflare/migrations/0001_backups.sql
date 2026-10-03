-- Apply once to the dedicated NEW backup database. No reset or data removal.
CREATE TABLE IF NOT EXISTS backups (
  backup_id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL CHECK(app_id='recipe-deck'),
  schema_version INTEGER NOT NULL CHECK(schema_version=1),
  created_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  device_id TEXT,
  record_count INTEGER NOT NULL CHECK(record_count>=0),
  source_revision INTEGER NOT NULL CHECK(source_revision>=0),
  sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK(byte_length>0),
  chunk_count INTEGER NOT NULL CHECK(chunk_count BETWEEN 1 AND 42)
);
CREATE TABLE IF NOT EXISTS backup_chunks (
  backup_id TEXT NOT NULL REFERENCES backups(backup_id),
  chunk_index INTEGER NOT NULL CHECK(chunk_index>=0),
  backup_json TEXT NOT NULL,
  PRIMARY KEY(backup_id,chunk_index)
);
CREATE INDEX IF NOT EXISTS backups_history ON backups(app_id,received_at DESC,backup_id DESC);
-- History is immutable even if a future API change accidentally tries to
-- replace or prune records. Maintenance must explicitly review these rules.
CREATE TRIGGER IF NOT EXISTS backups_no_update BEFORE UPDATE ON backups BEGIN SELECT RAISE(ABORT,'immutable backup'); END;
CREATE TRIGGER IF NOT EXISTS backups_no_delete BEFORE DELETE ON backups BEGIN SELECT RAISE(ABORT,'immutable backup'); END;
CREATE TRIGGER IF NOT EXISTS chunks_no_update BEFORE UPDATE ON backup_chunks BEGIN SELECT RAISE(ABORT,'immutable backup'); END;
CREATE TRIGGER IF NOT EXISTS chunks_no_delete BEFORE DELETE ON backup_chunks BEGIN SELECT RAISE(ABORT,'immutable backup'); END;
