import type { WorkspaceStore } from './store.js';

export function seedWorkspace(store: WorkspaceStore): void {
  const exists = store.db.prepare("SELECT 1 FROM projects WHERE id = 'demo-project'").get();
  if (exists) return;
  store.createProject({
    id: 'demo-project',
    visibility: 'public',
    wakerId: 'demo-waker',
    name: 'Waker 示例项目',
    description: '用于本地验证的演示项目',
    source: 'filesystem',
    status: 'ready',
  });
  store.createAutomation({
    id: 'demo-automation',
    wakerId: 'demo-waker',
    name: '每日项目摘要',
    kind: 'schedule',
    schedule: '0 9 * * *',
    prompt: '总结项目的最新进展。',
  });
  store.createWorkflow({
    id: 'demo-workflow',
    wakerId: 'demo-waker',
    projectId: 'demo-project',
    name: '项目摘要',
    description: '读取项目并生成摘要',
    definition: {
      schemaVersion: 1,
      start: 'summarize',
      nodes: [
        {
          id: 'summarize',
          kind: 'codex',
          prompt: '总结项目的最新进展。',
          next: 'done',
        },
        { id: 'done', kind: 'terminal', status: 'succeeded' },
      ],
    },
    status: 'active',
  });
  store.createChannel({
    id: 'demo-channel',
    provider: 'webhook',
    name: '本地通知',
    status: 'disconnected',
    configMetadata: { endpointLabel: 'local' },
  });
}
