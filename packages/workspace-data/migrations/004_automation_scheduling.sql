ALTER TABLE automations ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE automations ADD COLUMN start_at INTEGER;
ALTER TABLE automations ADD COLUMN end_at INTEGER;
ALTER TABLE automations ADD COLUMN max_runs INTEGER CHECK (max_runs IS NULL OR max_runs > 0);
ALTER TABLE automations ADD COLUMN run_count INTEGER NOT NULL DEFAULT 0 CHECK (run_count >= 0);
ALTER TABLE automations ADD COLUMN misfire_policy TEXT NOT NULL DEFAULT 'run_once'
  CHECK (misfire_policy IN ('run_once', 'skip'));
ALTER TABLE automations ADD COLUMN last_scheduled_at INTEGER;
ALTER TABLE automations ADD COLUMN completed_at INTEGER;

UPDATE automations
SET start_at = created_at
WHERE schedule LIKE 'interval:%' AND start_at IS NULL;

ALTER TABLE automation_runs RENAME TO automation_runs_legacy;

CREATE TABLE automation_runs (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  waker_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'skipped')),
  trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'scheduled')),
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
  retry_of_run_id TEXT REFERENCES automation_runs(id),
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
  id, automation_id, task_id, waker_id, status, trigger, name_snapshot, prompt_snapshot,
  input, output, result, error, created_at, updated_at, started_at, completed_at
)
SELECT runs.id, runs.automation_id, runs.task_id, runs.waker_id, runs.status, 'manual',
       automations.name, automations.prompt, runs.input, runs.output, runs.output, runs.error,
       runs.created_at, runs.updated_at, runs.started_at, runs.completed_at
FROM automation_runs_legacy AS runs
JOIN automations ON automations.id = runs.automation_id;

DROP TABLE automation_runs_legacy;

CREATE INDEX automation_runs_owner_idx
  ON automation_runs(waker_id, automation_id, created_at DESC);

CREATE UNIQUE INDEX automation_runs_scheduled_slot_idx
  ON automation_runs(automation_id, scheduled_for)
  WHERE trigger = 'scheduled';

UPDATE automation_runs AS older
SET status = 'cancelled',
    error = 'Superseded during single-flight migration',
    completed_at = updated_at
WHERE status IN ('queued', 'running')
  AND EXISTS (
    SELECT 1 FROM automation_runs AS newer
    WHERE newer.automation_id = older.automation_id
      AND newer.status IN ('queued', 'running')
      AND (newer.created_at > older.created_at OR
           (newer.created_at = older.created_at AND newer.id > older.id))
  );

UPDATE tasks
SET status = 'cancelled', completed_at = updated_at,
    error = 'Superseded during single-flight migration'
WHERE id IN (
  SELECT task_id FROM automation_runs
  WHERE error = 'Superseded during single-flight migration'
);

CREATE UNIQUE INDEX automation_runs_active_idx
  ON automation_runs(automation_id)
  WHERE status IN ('queued', 'running');

CREATE INDEX automations_due_idx
  ON automations(enabled, next_run)
  WHERE enabled = 1 AND next_run IS NOT NULL;
