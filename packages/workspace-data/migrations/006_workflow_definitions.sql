ALTER TABLE workflows ADD COLUMN waker_id TEXT;
ALTER TABLE workflows ADD COLUMN project_id TEXT;
ALTER TABLE workflows ADD COLUMN model TEXT;
ALTER TABLE workflows ADD COLUMN thinking TEXT CHECK (
  thinking IS NULL OR thinking IN ('minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra')
);
ALTER TABLE workflows ADD COLUMN definition TEXT;
ALTER TABLE workflows ADD COLUMN validation_errors TEXT NOT NULL DEFAULT '[]';
ALTER TABLE workflows ADD COLUMN deleted_at INTEGER;

UPDATE workflows
SET waker_id = '__legacy_unbound__',
    definition = CASE WHEN json_valid(script) THEN json(script) ELSE NULL END,
    validation_errors = CASE
      WHEN json_valid(script) THEN '[]'
      ELSE '["Legacy workflow script is not a valid declarative definition"]'
    END,
    status = CASE WHEN json_valid(script) THEN status ELSE 'error' END;

CREATE INDEX workflows_owner_idx
  ON workflows(waker_id, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE workflow_versions (
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  waker_id_snapshot TEXT,
  project_id_snapshot TEXT,
  model_snapshot TEXT,
  thinking_snapshot TEXT CHECK (
    thinking_snapshot IS NULL OR
    thinking_snapshot IN ('minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra')
  ),
  name_snapshot TEXT NOT NULL,
  description_snapshot TEXT NOT NULL,
  definition_snapshot TEXT,
  status_snapshot TEXT NOT NULL,
  validation_errors TEXT NOT NULL DEFAULT '[]',
  operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'rollback', 'legacy')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workflow_id, version)
);

INSERT INTO workflow_versions
  (workflow_id,version,waker_id_snapshot,project_id_snapshot,model_snapshot,thinking_snapshot,name_snapshot,
   description_snapshot,definition_snapshot,status_snapshot,validation_errors,operation,created_at)
SELECT id,version,waker_id,project_id,model,thinking,name,description,definition,status,validation_errors,'legacy',updated_at
FROM workflows;

CREATE TRIGGER workflow_versions_no_update
BEFORE UPDATE ON workflow_versions
BEGIN
  SELECT RAISE(ABORT, 'workflow versions are immutable');
END;

CREATE TRIGGER workflow_versions_no_delete
BEFORE DELETE ON workflow_versions
BEGIN
  SELECT RAISE(ABORT, 'workflow versions are immutable');
END;

DROP INDEX workflow_run_events_run_idx;
DROP INDEX workflow_runs_workflow_idx;

CREATE TABLE workflow_runs_new (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  workflow_version INTEGER NOT NULL CHECK (workflow_version > 0),
  name_snapshot TEXT NOT NULL,
  description_snapshot TEXT NOT NULL,
  script_snapshot TEXT NOT NULL,
  definition_snapshot TEXT,
  waker_id_snapshot TEXT NOT NULL,
  project_id_snapshot TEXT,
  model_snapshot TEXT,
  thinking_snapshot TEXT CHECK (
    thinking_snapshot IS NULL OR
    thinking_snapshot IN ('minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra')
  ),
  session_id TEXT,
  parent_run_id TEXT REFERENCES workflow_runs_new(id) ON DELETE SET NULL,
  parent_node_id TEXT,
  child_run_id TEXT REFERENCES workflow_runs_new(id) ON DELETE SET NULL,
  depth INTEGER NOT NULL DEFAULT 0 CHECK (depth >= 0 AND depth <= 8),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),
  retry_of_run_id TEXT REFERENCES workflow_runs_new(id) ON DELETE SET NULL,
  current_node_id TEXT,
  context TEXT NOT NULL DEFAULT '{}',
  wake_at INTEGER,
  waiting_action_id TEXT REFERENCES human_actions(id) ON DELETE SET NULL,
  event_sequence INTEGER NOT NULL DEFAULT 0 CHECK (event_sequence >= 0),
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'paused', 'waiting_input', 'waiting_child', 'succeeded', 'failed', 'cancelled')
  ),
  input TEXT,
  output TEXT,
  result TEXT,
  usage TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  CHECK (status != 'succeeded' OR completed_at IS NOT NULL),
  CHECK (status != 'failed' OR (completed_at IS NOT NULL AND error IS NOT NULL)),
  CHECK (status != 'cancelled' OR completed_at IS NOT NULL),
  CHECK (status != 'paused' OR wake_at IS NOT NULL),
  CHECK (status != 'waiting_input' OR waiting_action_id IS NOT NULL),
  CHECK (status != 'waiting_child' OR child_run_id IS NOT NULL)
);

INSERT INTO workflow_runs_new
  (id,workflow_id,workflow_version,name_snapshot,description_snapshot,script_snapshot,
   definition_snapshot,waker_id_snapshot,project_id_snapshot,model_snapshot,thinking_snapshot,
   status,input,output,error,
   event_sequence,created_at,updated_at,started_at,completed_at)
SELECT
  workflow_runs.id,
  workflow_runs.workflow_id,
  workflow_runs.workflow_version,
  workflow_runs.name_snapshot,
  workflow_runs.description_snapshot,
  workflow_runs.script_snapshot,
  workflow_versions.definition_snapshot,
  COALESCE(workflow_versions.waker_id_snapshot, '__legacy_unbound__'),
  workflow_versions.project_id_snapshot,
  workflow_versions.model_snapshot,
  workflow_versions.thinking_snapshot,
  CASE
    WHEN workflow_runs.status IN ('queued', 'running', 'waiting_input') THEN 'cancelled'
    ELSE workflow_runs.status
  END,
  workflow_runs.input,
  workflow_runs.output,
  workflow_runs.error,
  COALESCE(MAX(workflow_run_events.sequence), 0),
  workflow_runs.created_at,
  workflow_runs.updated_at,
  workflow_runs.started_at,
  CASE
    WHEN workflow_runs.status IN ('queued', 'running', 'waiting_input')
      THEN COALESCE(workflow_runs.completed_at, workflow_runs.updated_at)
    ELSE workflow_runs.completed_at
  END
FROM workflow_runs
LEFT JOIN workflow_versions
  ON workflow_versions.workflow_id = workflow_runs.workflow_id
 AND workflow_versions.version = workflow_runs.workflow_version
LEFT JOIN workflow_run_events ON workflow_run_events.run_id = workflow_runs.id
GROUP BY workflow_runs.id;

CREATE TABLE workflow_run_events_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES workflow_runs_new(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (length(trim(type)) > 0),
  payload TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(run_id, sequence)
);

INSERT INTO workflow_run_events_new (id,run_id,sequence,type,payload,created_at)
SELECT id,run_id,sequence,type,payload,created_at FROM workflow_run_events;

DROP TABLE workflow_run_events;
DROP TABLE workflow_runs;
ALTER TABLE workflow_runs_new RENAME TO workflow_runs;
ALTER TABLE workflow_run_events_new RENAME TO workflow_run_events;

CREATE INDEX workflow_runs_workflow_idx
  ON workflow_runs(workflow_id, created_at DESC);

CREATE INDEX workflow_run_events_run_idx
  ON workflow_run_events(run_id, sequence);

CREATE INDEX workflow_runs_recovery_idx
  ON workflow_runs(status, updated_at)
  WHERE status IN ('queued', 'running', 'paused');

CREATE UNIQUE INDEX workflow_runs_active_idx
  ON workflow_runs(workflow_id)
  WHERE status IN ('queued', 'running', 'paused', 'waiting_input', 'waiting_child');

CREATE INDEX workflow_runs_parent_idx ON workflow_runs(parent_run_id, created_at);
