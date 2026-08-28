ALTER TABLE human_actions ADD COLUMN session_id TEXT;

UPDATE human_actions
SET session_id = (
  SELECT tasks.session_id
  FROM tasks
  JOIN workflow_runs ON workflow_runs.task_id = tasks.id
  WHERE workflow_runs.id = human_actions.source_id
    AND workflow_runs.waker_id_snapshot = human_actions.waker_id
)
WHERE source = 'workflow';
