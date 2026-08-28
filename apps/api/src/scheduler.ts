import type { AutomationRun, Task, WorkspaceStore } from '@waker/workspace-data';

export function runDueAutomations(
  store: WorkspaceStore,
  wakerIds: readonly string[],
  now = Date.now(),
): {
  runs: AutomationRun[];
  tasks: Task[];
  errors: Array<{ automationId: string; message: string }>;
} {
  const runs: AutomationRun[] = [];
  const tasks: Task[] = [];
  const errors: Array<{ automationId: string; message: string }> = [];
  for (const wakerId of wakerIds) {
    for (const automation of store.listAutomations(wakerId)) {
      if (!automation.enabled || automation.nextRun === null || automation.nextRun > now) continue;
      try {
        const run = store.claimDueAutomation(wakerId, automation.id, now, {
          source: 'scheduler',
        });
        if (!run) continue;
        runs.push(run);
        if (run.status === 'queued') tasks.push(store.getTask(wakerId, run.taskId)!);
      } catch (error) {
        errors.push({
          automationId: automation.id,
          message: error instanceof Error ? error.message : 'scheduler error',
        });
      }
    }
  }
  return { runs, tasks, errors };
}
