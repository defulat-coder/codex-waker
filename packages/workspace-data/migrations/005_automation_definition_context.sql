ALTER TABLE automations ADD COLUMN deleted_at INTEGER;
ALTER TABLE automations ADD COLUMN project_id TEXT;
ALTER TABLE automations ADD COLUMN model TEXT;
ALTER TABLE automations ADD COLUMN thinking TEXT
  CHECK (thinking IS NULL OR thinking IN ('minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'));

DROP INDEX automations_due_idx;

CREATE INDEX automations_due_idx
  ON automations(enabled, next_run)
  WHERE enabled = 1 AND next_run IS NOT NULL AND deleted_at IS NULL;
