ALTER TABLE automations ADD COLUMN trigger_key TEXT;

-- SQLite cannot widen a CHECK constraint in place; rebuild automation_runs so the
-- trigger column also accepts the inbound 'api' and 'event' sources.
ALTER TABLE automation_runs RENAME TO automation_runs_legacy;

CREATE TABLE automation_runs (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE RESTRICT,
  waker_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'skipped')),
  trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'scheduled', 'api', 'event')),
  scheduled_for INTEGER,
  name_snapshot TEXT NOT NULL,
  prompt_snapshot TEXT NOT NULL,
  project_id TEXT,
  session_id TEXT,
  model TEXT,
  thinking TEXT,
  input TEXT,
  output TEXT,
  result TEXT,
  usage TEXT,
  error TEXT,
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),
  retry_of_run_id TEXT REFERENCES automation_runs(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  CHECK (trigger != 'scheduled' OR scheduled_for IS NOT NULL),
  CHECK (status != 'succeeded' OR completed_at IS NOT NULL),
  CHECK (status != 'failed' OR (completed_at IS NOT NULL AND error IS NOT NULL)),
  CHECK (status NOT IN ('cancelled', 'skipped') OR completed_at IS NOT NULL)
);

INSERT INTO automation_runs (
  id, automation_id, task_id, waker_id, status, trigger, scheduled_for, name_snapshot,
  prompt_snapshot, project_id, session_id, model, thinking, input, output, result, usage, error,
  attempt, retry_of_run_id, created_at, updated_at, started_at, completed_at
)
SELECT
  id, automation_id, task_id, waker_id, status, trigger, scheduled_for, name_snapshot,
  prompt_snapshot, project_id, session_id, model, thinking, input, output, result, usage, error,
  attempt, retry_of_run_id, created_at, updated_at, started_at, completed_at
FROM automation_runs_legacy;

DROP TABLE automation_runs_legacy;

CREATE INDEX automation_runs_owner_idx
  ON automation_runs(waker_id, automation_id, created_at DESC);

CREATE UNIQUE INDEX automation_runs_scheduled_slot_idx
  ON automation_runs(automation_id, scheduled_for)
  WHERE trigger = 'scheduled';

CREATE UNIQUE INDEX automation_runs_active_idx
  ON automation_runs(automation_id)
  WHERE status IN ('queued', 'running');
