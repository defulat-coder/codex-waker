import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore } from '@waker/workspace-data';
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
  mkdirSync(join(root, '.codex', 'agents'), { recursive: true });
  writeFileSync(
    join(root, '.codex', 'agents', 'codex-assistant.md'),
    '---\nname: Codex Assistant\nmark: CA\ntagline: Test\ndescription: Test\nsuggestions:\n  - Test\n---\n\nTest agent.\n',
  );
  writeFileSync(
    join(root, '.codex', 'agents', 'reviewer.md'),
    '---\nname: Reviewer\nmark: RV\ntagline: Test\ndescription: Test\nsuggestions:\n  - Test\n---\n\nReview agent.\n',
  );
  const app = buildApp(config, { cwd: root });

  before(async () => app.ready());
  after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('persists projects and refuses to queue automation while Codex is disabled', async () => {
    mkdirSync(join(root, 'project'));
    const ghostProject = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: {
        wakerId: 'future-ghost',
        name: '幽灵项目',
        visibility: 'private',
        source: 'filesystem',
        path: 'project',
      },
    });
    assert.equal(ghostProject.statusCode, 404);
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
    assert.equal(project.json().wakerId, 'codex-assistant');

    const impact = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.json().id}/delete-impact?wakerId=codex-assistant`,
    });
    assert.equal(impact.statusCode, 200);
    assert.deepEqual(impact.json(), {
      projectId: project.json().id,
      sessionContexts: 0,
      tasks: 0,
      tasksPreserved: 0,
      automationDefinitions: 0,
      automationRuns: 0,
      automationTasksPreserved: 0,
      workflowDefinitions: 0,
      workflowRuns: 0,
      behavior: {
        sessionContexts: 'delete',
        tasks: 'detach-and-preserve',
        automationDefinitions: 'detach-and-pause',
        automationTasks: 'preserve',
        workflowDefinitions: 'detach-and-pause',
        workflowRuns: 'preserve',
      },
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
        projectId: project.json().id,
      },
    });
    assert.equal(automation.statusCode, 201);
    const automationId = automation.json().id as string;

    const run = await app.inject({
      method: 'POST',
      url: `/api/v1/automations/${automationId}/run`,
      payload: { wakerId: 'codex-assistant' },
    });
    assert.equal(run.statusCode, 503);
    assert.match(run.json().error, /未启用/);

    const resources = await app.inject({
      method: 'GET',
      url: '/api/v1/local-resources?wakerId=codex-assistant',
    });
    assert.equal(resources.statusCode, 200);
    assert.equal(resources.json().projects.length, 1);
    assert.equal(resources.json().projects[0].wakerId, 'codex-assistant');
    assert.equal(resources.json().automations.length, 1);
    assert.equal(resources.json().tasks.length, 0);

    const secondConnection = new WorkspaceStore(join(root, '.codex', 'workspace.sqlite'));
    try {
      const queued = secondConnection.enqueueAutomationRun('codex-assistant', automationId, {
        trigger: 'manual',
      });
      const blockedDelete = await app.inject({
        method: 'DELETE',
        url: `/api/v1/projects/${project.json().id}?wakerId=codex-assistant`,
      });
      assert.equal(blockedDelete.statusCode, 409);
      assert.match(blockedDelete.json().error, /active automation run/);
      secondConnection.cancelAutomationRun('codex-assistant', queued.id);
    } finally {
      secondConnection.close();
    }
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

  it('runs a host-owned Workflow through Human Action while forge endpoints stay absent', async () => {
    const definition = {
      schemaVersion: 1,
      start: 'ask',
      nodes: [
        { id: 'ask', kind: 'ask_user', prompt: '继续？', inputKey: 'answer', next: 'done' },
        { id: 'done', kind: 'terminal', status: 'succeeded', output: '{{answer}}' },
      ],
    };
    const validated = await app.inject({
      method: 'POST',
      url: '/api/v1/workflows/validate',
      payload: { wakerId: 'codex-assistant', script: JSON.stringify(definition) },
    });
    assert.equal(validated.statusCode, 200);
    assert.equal(validated.json().valid, true);
    const workflow = await app.inject({
      method: 'POST',
      url: '/api/v1/workflows',
      payload: {
        wakerId: 'codex-assistant',
        name: '验收流程',
        definition,
        status: 'active',
      },
    });
    assert.equal(workflow.statusCode, 201);
    const workflowId = workflow.json().id as string;
    const foreignRun = await app.inject({
      method: 'POST',
      url: `/api/v1/workflows/${workflowId}/run`,
      payload: { wakerId: 'reviewer' },
    });
    assert.equal(foreignRun.statusCode, 404);

    const callerDefinition = {
      schemaVersion: 1,
      start: 'call',
      nodes: [
        { id: 'call', kind: 'call_workflow', workflowId, next: 'done' },
        { id: 'done', kind: 'terminal', status: 'succeeded' },
      ],
    };
    const caller = await app.inject({
      method: 'POST',
      url: '/api/v1/workflows',
      payload: { wakerId: 'codex-assistant', name: '调用流程', definition: callerDefinition },
    });
    assert.equal(caller.statusCode, 201);
    const cycleDefinition = {
      schemaVersion: 1,
      start: 'call',
      nodes: [
        {
          id: 'call',
          kind: 'call_workflow',
          workflowId: caller.json().id as string,
          next: 'done',
        },
        { id: 'done', kind: 'terminal', status: 'succeeded' },
      ],
    };
    const cycleValidation = await app.inject({
      method: 'POST',
      url: '/api/v1/workflows/validate',
      payload: { wakerId: 'codex-assistant', workflowId, script: JSON.stringify(cycleDefinition) },
    });
    assert.equal(cycleValidation.statusCode, 200);
    assert.equal(cycleValidation.json().valid, false);
    assert.match(cycleValidation.json().errors.join(' '), /cycle/);
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/workflows/${workflowId}?wakerId=codex-assistant`,
    });
    assert.equal(detail.statusCode, 200);
    assert.deepEqual(detail.json().definition, definition);
    const summaries = await app.inject({
      method: 'GET',
      url: '/api/v1/workflows?wakerId=codex-assistant',
    });
    assert.equal(summaries.statusCode, 200);
    assert.equal(summaries.json().items[0].script, undefined);
    assert.equal(summaries.json().items[0].definition, undefined);
    const versions = await app.inject({
      method: 'GET',
      url: `/api/v1/workflows/${workflowId}/versions?wakerId=codex-assistant`,
    });
    assert.equal(versions.statusCode, 200);
    assert.equal(versions.json().items[0].definition, undefined);
    assert.equal(versions.json().total, 1);
    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/v1/workflows/${workflowId}`,
      payload: {
        wakerId: 'codex-assistant',
        expectedVersion: 1,
        description: '第二版',
      },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().version, 2);
    const diff = await app.inject({
      method: 'GET',
      url: `/api/v1/workflows/${workflowId}/diff?wakerId=codex-assistant&fromVersion=1&toVersion=2`,
    });
    assert.equal(diff.statusCode, 200);
    assert.match(diff.json().diff, /第二版/);
    const dryRollback = await app.inject({
      method: 'POST',
      url: `/api/v1/workflows/${workflowId}/rollback`,
      payload: {
        wakerId: 'codex-assistant',
        targetVersion: 1,
        expectedVersion: 2,
        apply: false,
      },
    });
    assert.equal(dryRollback.statusCode, 200);
    assert.equal(dryRollback.json().applied, false);
    assert.equal(dryRollback.json().workflow.version, 2);
    const queued = await app.inject({
      method: 'POST',
      url: `/api/v1/workflows/${workflowId}/run`,
      payload: { wakerId: 'codex-assistant', input: { topic: 'test' } },
    });
    assert.equal(queued.statusCode, 202);
    const runId = queued.json().id as string;
    assert.equal(queued.json().status, 'queued');
    for (const action of ['start', 'events', 'wait', 'complete', 'fail']) {
      assert.equal(
        (await app.inject({ method: 'POST', url: `/api/v1/workflow-runs/${runId}/${action}` }))
          .statusCode,
        404,
        action,
      );
    }
    let trace = await app.inject({
      method: 'GET',
      url: `/api/v1/workflow-runs/${runId}/trace?wakerId=codex-assistant`,
    });
    for (let index = 0; index < 20 && trace.json().run.status !== 'waiting_input'; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      trace = await app.inject({
        method: 'GET',
        url: `/api/v1/workflow-runs/${runId}/trace?wakerId=codex-assistant`,
      });
    }
    assert.equal(trace.json().run.status, 'waiting_input');
    for (const action of ['resume', 'cancel', 'retry'] as const) {
      const foreignAction = await app.inject({
        method: 'POST',
        url: `/api/v1/workflow-runs/${runId}/${action}`,
        payload:
          action === 'resume'
            ? { wakerId: 'reviewer', input: '越权输入' }
            : { wakerId: 'reviewer' },
      });
      assert.equal(foreignAction.statusCode, 404, action);
    }
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/workflow-runs/${runId}/resume`,
          payload: { wakerId: 'codex-assistant', input: '继续' },
        })
      ).statusCode,
      202,
    );
    for (let index = 0; index < 20 && trace.json().run.status !== 'succeeded'; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      trace = await app.inject({
        method: 'GET',
        url: `/api/v1/workflow-runs/${runId}/trace?wakerId=codex-assistant`,
      });
    }
    assert.equal(trace.json().run.status, 'succeeded');
    assert.equal(trace.json().run.output, '继续');
    assert.ok(
      trace.json().events.some((event: { type: string }) => event.type === 'waiting_input'),
    );
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/workflow-runs/${runId}/trace?wakerId=reviewer`,
        })
      ).statusCode,
      404,
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

    const forgedAction = await app.inject({
      method: 'POST',
      url: '/api/v1/human-actions',
      payload: {
        wakerId: 'codex-assistant',
        source: 'codex',
        sourceId: 'run-one',
        title: '确认继续',
        prompt: '是否继续？',
      },
    });
    assert.equal(forgedAction.statusCode, 404);
  });
});

describe('automation execution API', () => {
  const root = mkdtempSync(join(tmpdir(), 'waker-api-automation-run-'));
  mkdirSync(join(root, '.codex', 'agents'), { recursive: true });
  mkdirSync(join(root, 'project'));
  writeFileSync(
    join(root, '.codex', 'agents', 'test-agent.md'),
    '---\nname: Test Agent\nmark: TA\ntagline: Test\ndescription: Test\nsuggestions:\n  - Test\n---\n\nTest agent.\n',
  );
  let calls = 0;
  const app = buildApp(
    { ...config, CODEX_AGENT_ENABLED: true },
    {
      cwd: root,
      schedulerIntervalMs: false,
      automationRuntime: {
        runTurn: async () => {
          calls += 1;
          if (calls === 1) throw new Error(`provider failed at ${root}/private.txt`);
          return {
            answer: `Completed in ${root}/project`,
            thinkingText: '',
            usage: { input: 7, output: 3, total: 10 },
          };
        },
        abortTurn: async () => undefined,
      },
    },
  );

  before(async () => app.ready());
  after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function runById(runId: string) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/automation-runs?wakerId=test-agent',
      });
      const run = response.json().items.find((item: { id: string }) => item.id === runId);
      if (run && !['queued', 'running'].includes(run.status)) return run;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`automation run did not settle: ${runId}`);
  }

  it('executes, persists failure, retries in a new session and preserves history on delete', async () => {
    const project = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: {
        wakerId: 'test-agent',
        name: 'Project',
        visibility: 'private',
        source: 'filesystem',
        path: 'project',
      },
    });
    assert.equal(project.statusCode, 201);
    const automation = await app.inject({
      method: 'POST',
      url: '/api/v1/automations',
      payload: {
        wakerId: 'test-agent',
        name: 'Paused check',
        kind: 'api',
        prompt: 'Read <status> & report',
        projectId: project.json().id,
        enabled: false,
        thinking: 'medium',
      },
    });
    assert.equal(automation.statusCode, 201);
    assert.equal(automation.json().lifecycle, 'paused');
    assert.equal(automation.json().projectId, project.json().id);

    const queued = await app.inject({
      method: 'POST',
      url: `/api/v1/automations/${automation.json().id}/run`,
      payload: { wakerId: 'test-agent' },
    });
    assert.equal(queued.statusCode, 202);
    assert.equal(queued.json().trigger, 'manual');
    assert.equal(queued.json().promptSnapshot, 'Read <status> & report');
    const failed = await runById(queued.json().id);
    assert.equal(failed.status, 'failed');
    assert.ok(failed.sessionId);
    assert.equal(String(failed.error).includes(root), false);

    const retryResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/automation-runs/${failed.id}/retry`,
      payload: { wakerId: 'test-agent' },
    });
    assert.equal(retryResponse.statusCode, 202);
    assert.equal(retryResponse.json().attempt, 2);
    assert.equal(retryResponse.json().retryOfRunId, failed.id);
    const succeeded = await runById(retryResponse.json().id);
    assert.equal(succeeded.status, 'succeeded');
    assert.equal(succeeded.result, 'Completed in ./project');
    assert.deepEqual(succeeded.usage, { input: 7, output: 3, total: 10 });
    assert.notEqual(succeeded.sessionId, failed.sessionId);

    const forged = await app.inject({
      method: 'POST',
      url: `/api/v1/automation-runs/${succeeded.id}/complete`,
      payload: { wakerId: 'test-agent', output: 'forged' },
    });
    assert.equal(forged.statusCode, 404);

    const impact = await app.inject({
      method: 'GET',
      url: `/api/v1/automations/${automation.json().id}/delete-impact?wakerId=test-agent`,
    });
    assert.deepEqual(impact.json(), {
      automationId: automation.json().id,
      runs: 2,
      tasks: 2,
      sessions: 2,
    });
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/automations/${automation.json().id}?wakerId=test-agent`,
    });
    assert.equal(deleted.statusCode, 204);
    const retryDeleted = await app.inject({
      method: 'POST',
      url: `/api/v1/automation-runs/${failed.id}/retry`,
      payload: { wakerId: 'test-agent' },
    });
    assert.equal(retryDeleted.statusCode, 400);
    const history = await app.inject({
      method: 'GET',
      url: `/api/v1/automation-runs?wakerId=test-agent&automationId=${automation.json().id}`,
    });
    assert.equal(history.json().total, 2);
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
