-- Keep the five newest verified generations. No data is removed by migration.
CREATE TABLE IF NOT EXISTS backup_retention (
  backup_id TEXT PRIMARY KEY REFERENCES backups(backup_id) ON DELETE CASCADE,
  app_id TEXT NOT NULL CHECK(app_id='recipe-deck'),
  verified_at TEXT,
  version_number INTEGER,
  UNIQUE(app_id,version_number),
  CHECK((verified_at IS NULL AND version_number IS NULL) OR (verified_at IS NOT NULL AND version_number>0))
);
-- Previously accepted backups were validated by the old Worker. Seed once in
-- receipt order; rerunning this migration never renumbers existing versions.
INSERT INTO backup_retention (backup_id,app_id,verified_at,version_number)
SELECT backup_id,app_id,received_at,ROW_NUMBER() OVER (ORDER BY received_at,backup_id)
FROM backups WHERE app_id='recipe-deck'
AND NOT EXISTS (SELECT 1 FROM backup_retention);
DROP TRIGGER IF EXISTS backups_no_delete;
DROP TRIGGER IF EXISTS chunks_no_delete;
-- Updates are still forbidden. Only generations outside the newest five
-- verified versions may be removed. Pending/unverified data stays protected.
CREATE TRIGGER backups_no_delete BEFORE DELETE ON backups
WHEN OLD.backup_id NOT IN (
  SELECT b.backup_id FROM backups b JOIN backup_retention r ON r.backup_id=b.backup_id
  WHERE b.app_id=OLD.app_id AND r.version_number IS NOT NULL
  ORDER BY r.version_number DESC LIMIT -1 OFFSET 5
) BEGIN SELECT RAISE(ABORT,'protected backup'); END;
CREATE TRIGGER chunks_no_delete BEFORE DELETE ON backup_chunks
WHEN OLD.backup_id NOT IN (
  SELECT b.backup_id FROM backups b JOIN backup_retention r ON r.backup_id=b.backup_id
  WHERE b.app_id='recipe-deck' AND r.version_number IS NOT NULL
  ORDER BY r.version_number DESC LIMIT -1 OFFSET 5
) BEGIN SELECT RAISE(ABORT,'protected backup'); END;
