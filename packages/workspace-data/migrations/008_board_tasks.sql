ALTER TABLE tasks RENAME TO tasks_legacy;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  type TEXT NOT NULL CHECK (type IN ('manual', 'conversation', 'automation', 'workflow')),
  origin TEXT NOT NULL CHECK (origin IN ('manual', 'derived')),
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'waiting', 'running', 'completed', 'failed', 'cancelled')
  ),
  priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  event_sequence INTEGER NOT NULL DEFAULT 0 CHECK (event_sequence >= 0),
  waker_id TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  source_type TEXT NOT NULL CHECK (
    source_type IN ('manual', 'conversation', 'automation', 'workflow')
  ),
  source_id TEXT NOT NULL,
  source TEXT NOT NULL,
  run_id TEXT,
  session_id TEXT,
  parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  deleted_at INTEGER,
  CHECK (origin != 'manual' OR source_type = 'manual'),
  CHECK (origin != 'derived' OR source_type != 'manual'),
  CHECK (status != 'completed' OR completed_at IS NOT NULL),
  CHECK (status != 'failed' OR (completed_at IS NOT NULL AND error IS NOT NULL)),
  CHECK (status != 'cancelled' OR completed_at IS NOT NULL)
);

INSERT INTO tasks (
  id,title,type,origin,status,priority,position,version,event_sequence,waker_id,project_id,
  source_type,source_id,source,run_id,session_id,result,error,created_at,updated_at,
  last_active_at,started_at,completed_at
)
SELECT
  legacy.id,
  legacy.title,
  CASE
    WHEN EXISTS (SELECT 1 FROM automation_runs WHERE task_id=legacy.id) THEN 'automation'
    WHEN legacy.type IN ('manual','conversation','workflow') THEN legacy.type
    ELSE 'manual'
  END,
  CASE
    WHEN EXISTS (SELECT 1 FROM automation_runs WHERE task_id=legacy.id) THEN 'derived'
    ELSE 'manual'
  END,
  legacy.status,
  'normal',
  0,
  1,
  0,
  legacy.waker_id,
  legacy.project_id,
  CASE
    WHEN EXISTS (SELECT 1 FROM automation_runs WHERE task_id=legacy.id) THEN 'automation'
    ELSE 'manual'
  END,
  COALESCE((SELECT id FROM automation_runs WHERE task_id=legacy.id), legacy.id),
  legacy.source,
  (SELECT id FROM automation_runs WHERE task_id=legacy.id),
  (SELECT session_id FROM automation_runs WHERE task_id=legacy.id),
  legacy.result,
  legacy.error,
  legacy.created_at,
  legacy.updated_at,
  legacy.updated_at,
  legacy.started_at,
  CASE
    WHEN legacy.status='cancelled' THEN COALESCE(legacy.completed_at,legacy.updated_at)
    ELSE legacy.completed_at
  END
FROM tasks_legacy AS legacy;

CREATE TABLE automation_runs_new (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE RESTRICT,
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
  retry_of_run_id TEXT REFERENCES automation_runs_new(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  CHECK (trigger != 'scheduled' OR scheduled_for IS NOT NULL),
  CHECK (status != 'succeeded' OR completed_at IS NOT NULL),
  CHECK (status != 'failed' OR (completed_at IS NOT NULL AND error IS NOT NULL)),
  CHECK (status NOT IN ('cancelled', 'skipped') OR completed_at IS NOT NULL)
);

INSERT INTO automation_runs_new
SELECT * FROM automation_runs;

DROP TABLE automation_runs;
ALTER TABLE automation_runs_new RENAME TO automation_runs;
DROP TABLE tasks_legacy;

CREATE INDEX automation_runs_owner_idx
  ON automation_runs(waker_id, automation_id, created_at DESC);
CREATE UNIQUE INDEX automation_runs_scheduled_slot_idx
  ON automation_runs(automation_id, scheduled_for)
  WHERE trigger = 'scheduled';
CREATE UNIQUE INDEX automation_runs_active_idx
  ON automation_runs(automation_id)
  WHERE status IN ('queued', 'running');

ALTER TABLE workflow_runs ADD COLUMN task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT;

INSERT INTO tasks (
  id,title,type,origin,status,priority,position,version,event_sequence,waker_id,project_id,
  source_type,source_id,source,run_id,session_id,result,error,created_at,updated_at,
  last_active_at,started_at,completed_at
)
SELECT
  'workflow-task:' || runs.id,
  runs.name_snapshot,
  'workflow',
  'derived',
  CASE runs.status
    WHEN 'queued' THEN 'queued'
    WHEN 'running' THEN 'running'
    WHEN 'succeeded' THEN 'completed'
    WHEN 'failed' THEN 'failed'
    WHEN 'cancelled' THEN 'cancelled'
    ELSE 'waiting'
  END,
  'normal',
  0,
  1,
  0,
  runs.waker_id_snapshot,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM projects
      WHERE projects.id=runs.project_id_snapshot
        AND projects.waker_id=runs.waker_id_snapshot
    ) THEN runs.project_id_snapshot
    ELSE NULL
  END,
  'workflow',
  runs.id,
  'workflow:' || runs.workflow_id,
  runs.id,
  runs.session_id,
  COALESCE(runs.result, runs.output),
  runs.error,
  runs.created_at,
  runs.updated_at,
  runs.updated_at,
  runs.started_at,
  runs.completed_at
FROM workflow_runs AS runs;

UPDATE workflow_runs
SET task_id = 'workflow-task:' || id;

UPDATE tasks
SET parent_task_id = (
  SELECT parent.task_id
  FROM workflow_runs AS child
  JOIN workflow_runs AS parent ON parent.id=child.parent_run_id
  WHERE child.task_id=tasks.id
)
WHERE source_type='workflow'
  AND EXISTS (SELECT 1 FROM workflow_runs WHERE task_id=tasks.id AND parent_run_id IS NOT NULL);

CREATE TRIGGER workflow_runs_task_required_insert
BEFORE INSERT ON workflow_runs
WHEN NEW.task_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'workflow run task_id is required');
END;

CREATE TRIGGER workflow_runs_task_immutable
BEFORE UPDATE OF task_id ON workflow_runs
WHEN NEW.task_id IS NULL OR NEW.task_id != OLD.task_id
BEGIN
  SELECT RAISE(ABORT, 'workflow run task_id is immutable');
END;

ALTER TABLE human_actions ADD COLUMN task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;
ALTER TABLE human_actions ADD COLUMN kind TEXT NOT NULL DEFAULT 'confirm'
  CHECK (kind IN ('confirm', 'input'));
ALTER TABLE human_actions ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);
ALTER TABLE human_actions ADD COLUMN deleted_at INTEGER;

UPDATE human_actions
SET task_id = (
      SELECT task_id FROM workflow_runs
      WHERE workflow_runs.id=human_actions.source_id
        AND workflow_runs.waker_id_snapshot=human_actions.waker_id
    ),
    kind = CASE WHEN source='workflow' THEN 'input' ELSE 'confirm' END;

UPDATE human_actions AS older
SET status='ignored', resolved_at=updated_at, version=version+1
WHERE status='pending'
  AND EXISTS (
    SELECT 1 FROM human_actions AS newer
    WHERE newer.waker_id=older.waker_id
      AND newer.source=older.source
      AND newer.source_id=older.source_id
      AND newer.status='pending'
      AND (newer.created_at > older.created_at OR
           (newer.created_at=older.created_at AND newer.id > older.id))
  );

CREATE UNIQUE INDEX human_actions_pending_source_idx
  ON human_actions(waker_id,source,source_id)
  WHERE status='pending' AND deleted_at IS NULL;
CREATE INDEX human_actions_board_idx
  ON human_actions(waker_id,status,updated_at DESC,id)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX tasks_source_idx
  ON tasks(waker_id,source_type,source_id);
CREATE INDEX tasks_owner_active_idx
  ON tasks(waker_id,last_active_at DESC,id)
  WHERE deleted_at IS NULL;
CREATE INDEX tasks_owner_status_idx
  ON tasks(waker_id,status,last_active_at DESC,id)
  WHERE deleted_at IS NULL;
CREATE INDEX tasks_owner_type_idx
  ON tasks(waker_id,type,last_active_at DESC,id)
  WHERE deleted_at IS NULL;
CREATE INDEX tasks_owner_source_idx
  ON tasks(waker_id,source_type,last_active_at DESC,id)
  WHERE deleted_at IS NULL;
CREATE INDEX tasks_parent_idx
  ON tasks(waker_id,parent_task_id,position,id)
  WHERE deleted_at IS NULL;

CREATE TABLE task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  waker_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  type TEXT NOT NULL CHECK (length(trim(type)) > 0),
  status TEXT,
  payload TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(task_id,sequence)
);

INSERT INTO task_events(task_id,waker_id,sequence,type,status,payload,created_at)
SELECT id,waker_id,1,'created',status,NULL,created_at FROM tasks;
UPDATE tasks SET event_sequence=1;

CREATE INDEX task_events_owner_idx ON task_events(waker_id,task_id,sequence);
