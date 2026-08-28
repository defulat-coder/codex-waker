import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from './app.js';
import type { AppConfig } from './config.js';

const config: AppConfig = {
  PORT: 4310,
  HOST: '127.0.0.1',
  WEB_ORIGIN: 'http://localhost:5173',
  CODEX_AGENT_ENABLED: false,
  LOG_LEVEL: 'error',
};

describe('local knowledge API', () => {
  const root = mkdtempSync(join(tmpdir(), 'waker-api-knowledge-'));
  const app = buildApp(config, { cwd: root });

  before(async () => app.ready());
  after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('creates, binds and searches a cited document in every mode', async () => {
    const notebookResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/notebooks',
      payload: { title: '本地知识库', description: '验证引用' },
    });
    assert.equal(notebookResponse.statusCode, 201);
    const notebookId = notebookResponse.json().id as string;

    const bound = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/bindings',
      payload: {
        notebookId,
        scope: { kind: 'waker', id: 'codex-assistant' },
        access: 'read_write',
      },
    });
    assert.equal(bound.statusCode, 201);

    const document = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/documents',
      payload: {
        notebookId,
        title: '架构说明',
        uri: 'docs/architecture.md',
        content: 'Waker 使用本地 SQLite。\n混合检索合并全文和向量结果。',
        scope: { kind: 'waker', id: 'codex-assistant' },
      },
    });
    assert.equal(document.statusCode, 201);
    assert.equal(document.json().version, 1);

    for (const mode of ['keyword', 'vector', 'hybrid']) {
      const search = await app.inject({
        method: 'POST',
        url: '/api/v1/knowledge/search',
        payload: {
          scope: { kind: 'waker', id: 'codex-assistant' },
          query: 'SQLite 混合检索',
          mode,
        },
      });
      assert.equal(search.statusCode, 200);
      assert.ok(search.json().results.length > 0, mode);
      assert.match(search.json().results[0].citation, /#L\d+-L\d+$/);
    }

    const isolated = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/search',
      payload: { scope: { kind: 'waker', id: 'another' }, query: 'SQLite', mode: 'hybrid' },
    });
    assert.equal(isolated.statusCode, 200);
    assert.equal(isolated.json().results.length, 0);
  });
});

describe('local workspace API', () => {
  const root = mkdtempSync(join(tmpdir(), 'waker-api-workspace-'));
  const app = buildApp(config, { cwd: root });

  before(async () => app.ready());
  after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('persists projects and turns an automation run into a task', async () => {
    mkdirSync(join(root, 'project'));
    const project = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: {
        wakerId: 'codex-assistant',
        name: '本地项目',
        visibility: 'public',
        source: 'filesystem',
        path: 'project',
      },
    });
    assert.equal(project.statusCode, 201);
    assert.equal(project.json().path, 'project');

    const impact = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.json().id}/delete-impact?wakerId=codex-assistant`,
    });
    assert.equal(impact.statusCode, 200);
    assert.deepEqual(impact.json(), {
      projectId: project.json().id,
      sessionContexts: 0,
      tasks: 0,
      behavior: { sessionContexts: 'delete', tasks: 'cascade-delete' },
    });
    const foreignImpact = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.json().id}/delete-impact?wakerId=another-waker`,
    });
    assert.equal(foreignImpact.statusCode, 404);
    const foreignUpdate = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${project.json().id}`,
      payload: { wakerId: 'another-waker', name: '越权修改' },
    });
    assert.equal(foreignUpdate.statusCode, 404);
    const foreignDelete = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${project.json().id}?wakerId=another-waker`,
    });
    assert.equal(foreignDelete.statusCode, 404);

    const invalidGit = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${project.json().id}`,
      payload: { wakerId: 'codex-assistant', source: 'git' },
    });
    assert.equal(invalidGit.statusCode, 400);
    mkdirSync(join(root, 'project', '.git'));
    const git = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${project.json().id}`,
      payload: { wakerId: 'codex-assistant', source: 'git' },
    });
    assert.equal(git.statusCode, 200);
    assert.equal(git.json().source, 'git');

    const automation = await app.inject({
      method: 'POST',
      url: '/api/v1/automations',
      payload: {
        wakerId: 'codex-assistant',
        name: '每日摘要',
        kind: 'schedule',
        schedule: '0 9 * * *',
        prompt: '总结项目进展',
      },
    });
    assert.equal(automation.statusCode, 201);
    const automationId = automation.json().id as string;

    const run = await app.inject({
      method: 'POST',
      url: `/api/v1/automations/${automationId}/run`,
      payload: { wakerId: 'codex-assistant' },
    });
    assert.equal(run.statusCode, 202);
    assert.equal(run.json().type, 'automation');
    assert.equal(run.json().status, 'pending');

    const resources = await app.inject({
      method: 'GET',
      url: '/api/v1/local-resources?wakerId=codex-assistant',
    });
    assert.equal(resources.statusCode, 200);
    assert.equal(resources.json().projects.length, 1);
    assert.equal(resources.json().automations.length, 1);
    assert.equal(resources.json().tasks.length, 1);
  });

  it('rejects project paths outside the host workspace', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: {
        wakerId: 'codex-assistant',
        name: '越界项目',
        visibility: 'private',
        source: 'filesystem',
        path: tmpdir(),
      },
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.json().error, /当前工作区内/);
  });

  it('runs a versioned workflow through wait, resume, complete and trace', async () => {
    const workflow = await app.inject({
      method: 'POST',
      url: '/api/v1/workflows',
      payload: { name: '验收流程', script: 'ask -> finish', status: 'active' },
    });
    assert.equal(workflow.statusCode, 201);
    const workflowId = workflow.json().id as string;
    const queued = await app.inject({
      method: 'POST',
      url: `/api/v1/workflows/${workflowId}/run`,
      payload: { input: { topic: 'test' } },
    });
    assert.equal(queued.statusCode, 202);
    const runId = queued.json().id as string;
    assert.equal(queued.json().status, 'queued');
    assert.equal(
      (await app.inject({ method: 'POST', url: `/api/v1/workflow-runs/${runId}/start` })).json()
        .status,
      'running',
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/workflow-runs/${runId}/events`,
          payload: { type: 'step.completed', payload: { step: 'ask' } },
        })
      ).statusCode,
      201,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/workflow-runs/${runId}/wait`,
          payload: { prompt: '继续？' },
        })
      ).json().status,
      'waiting_input',
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/workflow-runs/${runId}/resume`,
          payload: { input: '继续' },
        })
      ).json().status,
      'running',
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/workflow-runs/${runId}/complete`,
          payload: { output: '完成' },
        })
      ).json().status,
      'succeeded',
    );
    const trace = await app.inject({ method: 'GET', url: `/api/v1/workflow-runs/${runId}/trace` });
    assert.equal(trace.statusCode, 200);
    assert.equal(trace.json().run.workflowId, workflowId);
    assert.ok(
      trace.json().events.some((event: { type: string }) => event.type === 'step.completed'),
    );
  });

  it('manages connectors, restrictive permissions and human actions', async () => {
    const unsafe = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors',
      payload: {
        wakerId: 'codex-assistant',
        name: 'Unsafe',
        transport: 'http',
        url: 'https://example.com',
        metadata: { apiKey: 'nope' },
      },
    });
    assert.equal(unsafe.statusCode, 400);
    const connector = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors',
      payload: {
        wakerId: 'codex-assistant',
        name: 'Local MCP',
        transport: 'stdio',
        command: 'local-mcp',
        tools: [{ name: 'lookup' }],
      },
    });
    assert.equal(connector.statusCode, 201);
    assert.equal(connector.json().status, 'disabled');
    const enabled = await app.inject({
      method: 'POST',
      url: `/api/v1/connectors/${connector.json().id}/enable`,
      payload: { wakerId: 'codex-assistant' },
    });
    assert.equal(enabled.json().status, 'ready');

    const permission = await app.inject({
      method: 'PUT',
      url: '/api/v1/permissions/codex-assistant',
      payload: {
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        toolGuard: 'deny',
        fileGuard: 'deny',
        builtinTools: ['file_read'],
      },
    });
    assert.equal(permission.statusCode, 200);
    assert.equal(permission.json().sandboxMode, 'read-only');
    const broaden = await app.inject({
      method: 'PUT',
      url: '/api/v1/permissions/codex-assistant',
      payload: {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never',
        toolGuard: 'deny',
        fileGuard: 'deny',
        builtinTools: [],
      },
    });
    assert.equal(broaden.statusCode, 400);

    const action = await app.inject({
      method: 'POST',
      url: '/api/v1/human-actions',
      payload: {
        wakerId: 'codex-assistant',
        source: 'workflow',
        sourceId: 'run-one',
        title: '确认继续',
        prompt: '是否继续？',
      },
    });
    assert.equal(action.statusCode, 201);
    const resolved = await app.inject({
      method: 'POST',
      url: `/api/v1/human-actions/${action.json().id}/resolve`,
      payload: { wakerId: 'codex-assistant', result: { approved: true } },
    });
    assert.equal(resolved.json().status, 'handled');
  });
});

describe('memory and session output API', () => {
  const root = mkdtempSync(join(tmpdir(), 'waker-api-memory-output-'));
  mkdirSync(join(root, '.codex', 'agents'), { recursive: true });
  writeFileSync(
    join(root, '.codex', 'agents', 'test-agent.md'),
    '---\nname: Test\nmark: T\ntagline: Test\ndescription: Test\nsuggestions:\n  - Run a test\n---\n\nTest agent.\n',
  );
  const app = buildApp(config, { cwd: root });
  let sessionId = '';

  before(async () => {
    await app.ready();
    const session = await app.inject({ method: 'POST', url: '/api/v1/agents/test-agent/sessions' });
    assert.equal(session.statusCode, 200);
    sessionId = session.json().id as string;
  });
  after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('versions, diffs and rolls back scoped memory', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/memories',
      payload: {
        scope: { type: 'waker', id: 'test-agent' },
        source: 'manual',
        title: '偏好',
        content: '# 偏好\n\n简洁回答',
      },
    });
    assert.equal(created.statusCode, 201);
    const memoryId = created.json().id as string;
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/memories/${memoryId}/snapshots`,
      payload: { operation: 'before-edit' },
    });
    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/v1/memories/${memoryId}`,
      payload: {
        expectedVersion: 1,
        scope: { type: 'waker', id: 'test-agent' },
        content: '# 偏好\n\n详细回答',
      },
    });
    assert.equal(updated.json().version, 2);
    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/memories/${memoryId}/snapshots`,
      payload: { operation: 'after-edit' },
    });
    const diff = await app.inject({
      method: 'GET',
      url: `/api/v1/memory/diff?from=${first.json().id}&to=${second.json().id}`,
    });
    assert.match(diff.json().diff, /-简洁回答/);
    assert.match(diff.json().diff, /\+详细回答/);
    const rollback = await app.inject({
      method: 'POST',
      url: '/api/v1/memory/rollback',
      payload: {
        snapshotId: first.json().id,
        expectedVersion: 2,
        scope: { type: 'waker', id: 'test-agent' },
        apply: true,
      },
    });
    assert.equal(rollback.statusCode, 200);
    assert.equal(rollback.json().document.version, 3);
    assert.match(rollback.json().document.content, /简洁回答/);
    const timeline = await app.inject({
      method: 'GET',
      url: '/api/v1/memory/timeline?scopeType=waker&scopeId=test-agent',
    });
    assert.ok(timeline.json().total >= 3);
  });

  it('uploads an attachment and records artifact/file-change metadata', async () => {
    const attachment = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/attachments`,
      payload: {
        agentId: 'test-agent',
        originalName: 'notes.txt',
        mimeType: 'text/plain',
        dataBase64: Buffer.from('artifact evidence').toString('base64'),
      },
    });
    assert.equal(attachment.statusCode, 201);
    const attachmentId = attachment.json().id as string;
    assert.equal(attachment.json().storedPath, undefined);
    const artifact = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/artifacts`,
      payload: {
        agentId: 'test-agent',
        attachmentId,
        title: 'Evidence',
        kind: 'text',
        contentPreview: 'artifact evidence',
      },
    });
    assert.equal(artifact.statusCode, 201);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/sessions/${sessionId}/file-changes`,
          payload: {
            agentId: 'test-agent',
            path: 'docs/result.md',
            kind: 'add',
            summary: 'created result',
          },
        })
      ).statusCode,
      201,
    );
    const outputs = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/outputs?agentId=test-agent`,
    });
    assert.equal(outputs.statusCode, 200);
    assert.equal(outputs.json().attachments.length, 1);
    assert.equal(outputs.json().artifacts.length, 1);
    assert.equal(outputs.json().fileChanges.length, 1);
    const download = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/attachments/${attachmentId}?agentId=test-agent`,
    });
    assert.equal(download.body, 'artifact evidence');
  });
});
