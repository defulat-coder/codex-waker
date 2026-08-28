import type { Task, WorkspaceStore } from '@waker/workspace-data';

export function runDueAutomations(
  store: WorkspaceStore,
  wakerIds: readonly string[],
  now = Date.now(),
): { tasks: Task[]; errors: Array<{ automationId: string; message: string }> } {
  const tasks: Task[] = [];
  const errors: Array<{ automationId: string; message: string }> = [];
  for (const wakerId of wakerIds) {
    for (const automation of store.listAutomations(wakerId)) {
      if (!automation.enabled || automation.nextRun === null || automation.nextRun > now) continue;
      try {
        tasks.push(store.runAutomation(wakerId, automation.id, { source: 'scheduler' }));
      } catch (error) {
        errors.push({
          automationId: automation.id,
          message: error instanceof Error ? error.message : 'scheduler error',
        });
      }
    }
  }
  return { tasks, errors };
}
