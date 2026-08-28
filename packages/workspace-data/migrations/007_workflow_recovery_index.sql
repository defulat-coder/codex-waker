DROP INDEX workflow_runs_recovery_idx;

CREATE INDEX workflow_runs_recovery_idx
  ON workflow_runs(status, updated_at)
  WHERE status IN ('queued', 'running', 'paused', 'waiting_child');
