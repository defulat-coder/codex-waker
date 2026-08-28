ALTER TABLE tasks ADD COLUMN description TEXT NOT NULL DEFAULT '';

UPDATE tasks
SET description = COALESCE(
  (
    SELECT runs.description_snapshot
    FROM workflow_runs AS runs
    WHERE runs.task_id = tasks.id
  ),
  ''
)
WHERE source_type = 'workflow';
