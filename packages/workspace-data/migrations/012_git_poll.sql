-- Git polling trigger source (QoderWake script pull parity): automations can now poll a
-- configured git repository branch and fire a run when the head commit moves.
-- SQLite cannot widen a CHECK constraint in place; rebuild both tables following the
-- 011 pattern so kind accepts 'git-poll' and trigger accepts 'git'.
-- Order matters: automation_runs is renamed BEFORE automations, otherwise the rename of
-- automations would rewrite automation_runs' FK to automations_legacy and the legacy drop
-- would cascade-delete every copied run row.

ALTER TABLE automation_runs RENAME TO automation_runs_legacy;
ALTER TABLE automations RENAME TO automations_legacy;

CREATE TABLE automations (
  id TEXT PRIMARY KEY,
  waker_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('schedule', 'api', 'event', 'git-poll')),
  schedule TEXT,
  prompt TEXT NOT NULL CHECK (length(trim(prompt)) > 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_run INTEGER,
  next_run INTEGER,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  start_at INTEGER,
  end_at INTEGER,
  max_runs INTEGER CHECK (max_runs IS NULL OR max_runs > 0),
  run_count INTEGER NOT NULL DEFAULT 0 CHECK (run_count >= 0),
  misfire_policy TEXT NOT NULL DEFAULT 'run_once'
    CHECK (misfire_policy IN ('run_once', 'skip')),
  last_scheduled_at INTEGER,
  completed_at INTEGER,
  deleted_at INTEGER,
  project_id TEXT,
  model TEXT,
  thinking TEXT
    CHECK (thinking IS NULL OR thinking IN ('minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra')),
  trigger_key TEXT,
  repo TEXT,
  branch TEXT,
  poll_interval_seconds INTEGER
    CHECK (poll_interval_seconds IS NULL OR poll_interval_seconds >= 15),
  last_seen_commit TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (kind != 'schedule' OR (schedule IS NOT NULL AND length(trim(schedule)) > 0)),
  CHECK (kind != 'git-poll' OR (repo IS NOT NULL AND length(trim(repo)) > 0
    AND poll_interval_seconds IS NOT NULL))
);

INSERT INTO automations (
  id, waker_id, name, kind, schedule, prompt, enabled, last_run, next_run, timezone,
  start_at, end_at, max_runs, run_count, misfire_policy, last_scheduled_at, completed_at,
  deleted_at, project_id, model, thinking, trigger_key, created_at, updated_at
)
SELECT
  id, waker_id, name, kind, schedule, prompt, enabled, last_run, next_run, timezone,
  start_at, end_at, max_runs, run_count, misfire_policy, last_scheduled_at, completed_at,
  deleted_at, project_id, model, thinking, trigger_key, created_at, updated_at
FROM automations_legacy;

CREATE TABLE automation_runs (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE RESTRICT,
  waker_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'skipped')),
  trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'scheduled', 'api', 'event', 'git')),
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
DROP TABLE automations_legacy;

CREATE INDEX automations_waker_idx ON automations(waker_id, updated_at DESC);

CREATE INDEX automations_due_idx
  ON automations(enabled, next_run)
  WHERE enabled = 1 AND next_run IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX automations_git_poll_idx
  ON automations(kind, enabled)
  WHERE kind = 'git-poll' AND enabled = 1 AND deleted_at IS NULL;

CREATE INDEX automation_runs_owner_idx
  ON automation_runs(waker_id, automation_id, created_at DESC);

CREATE UNIQUE INDEX automation_runs_scheduled_slot_idx
  ON automation_runs(automation_id, scheduled_for)
  WHERE trigger = 'scheduled';

CREATE UNIQUE INDEX automation_runs_active_idx
  ON automation_runs(automation_id)
  WHERE status IN ('queued', 'running');
