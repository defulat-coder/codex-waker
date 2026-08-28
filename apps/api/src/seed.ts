import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getCodexProjectRoot, loadAgents } from '@waker/codex-runtime';
import { KnowledgeStore } from '@waker/knowledge';
import { MemoryStore } from '@waker/memory';
import { WorkspaceStore } from '@waker/workspace-data';

const cwd = getCodexProjectRoot();
const codexDir = join(cwd, '.codex');
mkdirSync(codexDir, { recursive: true });

const waker = loadAgents(cwd)[0];
if (!waker) throw new Error('请先在 .codex/agents 中创建至少一个 Waker');

const knowledge = new KnowledgeStore(join(codexDir, 'knowledge.sqlite'));
const memory = new MemoryStore(join(codexDir, 'memory.sqlite'));
const workspace = new WorkspaceStore(join(codexDir, 'workspace.sqlite'));

try {
  let notebook = knowledge.listNotebooks().find((item) => item.id === 'local-guide');
  if (!notebook) {
    notebook = knowledge.createNotebook({
      id: 'local-guide',
      name: 'Waker 本地指南',
      description: '用于验证关键词、向量和混合检索的本地资料。',
    });
    knowledge.bindNotebook(notebook.id, { scopeType: 'waker', scopeId: waker.id }, true);
    await knowledge.createDocument({
      id: 'local-guide-architecture',
      notebookId: notebook.id,
      title: '本地架构说明',
      sourceUri: 'docs/local-guide.md',
      content: [
        '# Waker 本地架构',
        '',
        'Waker 的浏览器只访问本地 Fastify API，不直接接触 Codex SDK 或模型密钥。',
        '会话由 Codex TypeScript SDK 的 Thread API 创建和恢复，并通过 SSE 流式展示。',
        '知识文档保存在 SQLite，FTS5 提供关键词召回，本地向量提供语义召回，混合检索合并并返回行号引用。',
      ].join('\n'),
      metadata: { mimeType: 'text/markdown', sourceType: 'markdown' },
    });
  }

  if (!workspace.getProject(waker.id, 'local-project')) {
    workspace.createProject({
      id: 'local-project',
      visibility: 'private',
      wakerId: waker.id,
      name: 'Waker 本地项目',
      description: '当前仓库的本地验证项目。',
      path: cwd,
      source: 'filesystem',
      status: 'ready',
    });
  }
  if (!memory.list({ scope: { type: 'waker', id: waker.id } }).length) {
    memory.create({
      id: 'local-memory-preferences',
      scope: { type: 'waker', id: waker.id },
      source: 'seed',
      title: '协作偏好',
      content: '# 协作偏好\n\n- 回答先给结论，再给证据。\n- 本地知识引用必须包含来源与行号。',
    });
  }
  if (!workspace.getAutomation(waker.id, 'daily-summary')) {
    workspace.createAutomation({
      id: 'daily-summary',
      wakerId: waker.id,
      name: '每日项目摘要',
      kind: 'schedule',
      schedule: '0 9 * * *',
      prompt: '读取项目变化并生成一份简短摘要。',
    });
  }
  if (!workspace.getWorkflow(waker.id, 'review-flow')) {
    workspace.createWorkflow({
      id: 'review-flow',
      wakerId: waker.id,
      name: '本地评审流',
      description: '分析 → 检查 → 总结的本地 WakerFlow 示例。',
      definition: {
        schemaVersion: 1,
        start: 'review',
        nodes: [
          {
            id: 'review',
            kind: 'codex',
            prompt: '分析当前项目变化，检查风险并给出简短总结。',
            outputKey: 'summary',
            next: 'done',
          },
          { id: 'done', kind: 'terminal', status: 'succeeded', output: '{{summary}}' },
        ],
      },
      status: 'active',
    });
  }
  if (!workspace.getChannel('local-channel')) {
    workspace.createChannel({
      id: 'local-channel',
      provider: 'local',
      name: '本地通知',
      status: 'disconnected',
      configMetadata: { mode: 'local-demo' },
    });
  }

  process.stdout.write(`已为 Waker ${waker.name} (${waker.id}) 准备本地演示数据。\n`);
} finally {
  knowledge.close();
  memory.close();
  workspace.close();
}
