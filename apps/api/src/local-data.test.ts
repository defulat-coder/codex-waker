import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

  it('creates git-poll automations with repo reachability validation', async () => {
    const repoDir = join(root, 'watched-repo');
    mkdirSync(repoDir, { recursive: true });
    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/automations',
      payload: {
        wakerId: 'codex-assistant',
        name: 'Git 轮询',
        kind: 'git-poll',
        prompt: '处理新提交',
        repo: join(root, 'no-such-repo'),
      },
    });
    assert.equal(missing.statusCode, 400);
    assert.match(missing.json().error, /路径不存在/);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/automations',
      payload: {
        wakerId: 'codex-assistant',
        name: 'Git 轮询',
        kind: 'git-poll',
        prompt: '处理新提交',
        repo: repoDir,
        branch: 'main',
        pollIntervalSeconds: 30,
      },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().kind, 'git-poll');
    assert.equal(created.json().repo, repoDir);
    assert.equal(created.json().branch, 'main');
    assert.equal(created.json().pollIntervalSeconds, 30);
    assert.equal(created.json().triggerKey, undefined);
    assert.equal(created.json().lastSeenCommit, undefined);

    // URL 形式的仓库不做本地存在性校验；缺省 pollIntervalSeconds=60。
    const remote = await app.inject({
      method: 'POST',
      url: '/api/v1/automations',
      payload: {
        wakerId: 'codex-assistant',
        name: '远端轮询',
        kind: 'git-poll',
        prompt: '处理新提交',
        repo: 'https://github.com/org/repo.git',
      },
    });
    assert.equal(remote.statusCode, 201);
    assert.equal(remote.json().pollIntervalSeconds, 60);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/automations/${created.json().id}`,
      payload: { wakerId: 'codex-assistant', pollIntervalSeconds: 45, branch: null },
    });
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.json().pollIntervalSeconds, 45);
    assert.equal(patched.json().branch, undefined);

    const tooFrequent = await app.inject({
      method: 'PATCH',
      url: `/api/v1/automations/${created.json().id}`,
      payload: { wakerId: 'codex-assistant', pollIntervalSeconds: 5 },
    });
    assert.equal(tooFrequent.statusCode, 400);
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
    const fixtureServer = fileURLToPath(
      new URL('../test/fixtures/dummy-mcp-server.mjs', import.meta.url),
    );
    const connector = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors',
      payload: {
        wakerId: 'codex-assistant',
        name: 'Local MCP',
        transport: 'stdio',
        command: `${process.execPath} ${fixtureServer}`,
      },
    });
    assert.equal(connector.statusCode, 201);
    assert.equal(connector.json().status, 'disabled');

    // enable：写入 Codex CLI 配置面并探测真实工具列表。
    const enabled = await app.inject({
      method: 'POST',
      url: `/api/v1/connectors/${connector.json().id}/enable`,
      payload: { wakerId: 'codex-assistant' },
    });
    assert.equal(enabled.statusCode, 200);
    assert.equal(enabled.json().status, 'ready');
    assert.deepEqual(enabled.json().tools, [
      { name: 'fixture_echo', description: 'Echo back the input text' },
      { name: 'fixture_count' },
    ]);
    const serverName = `waker_${connector.json().id}`;
    const configToml = () => readFileSync(join(root, '.codex', 'config.toml'), 'utf8');
    assert.match(configToml(), new RegExp(`\\[mcp_servers\\.${serverName}\\]`));

    // 显式 probe：再次探测并刷新工具列表。
    const probed = await app.inject({
      method: 'POST',
      url: `/api/v1/connectors/${connector.json().id}/probe`,
      payload: { wakerId: 'codex-assistant' },
    });
    assert.equal(probed.statusCode, 200);
    assert.equal(probed.json().status, 'ready');
    assert.equal(probed.json().tools.length, 2);

    // enable 一个无法启动的 connector：status='error' + 错误消息。
    const broken = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors',
      payload: {
        wakerId: 'codex-assistant',
        name: 'Broken MCP',
        transport: 'stdio',
        command: 'definitely-not-a-real-command-xyz',
      },
    });
    assert.equal(broken.statusCode, 201);
    const brokenEnabled = await app.inject({
      method: 'POST',
      url: `/api/v1/connectors/${broken.json().id}/enable`,
      payload: { wakerId: 'codex-assistant' },
    });
    assert.equal(brokenEnabled.statusCode, 200);
    assert.equal(brokenEnabled.json().status, 'error');
    assert.ok(brokenEnabled.json().error);

    // probe 失败同样落 error；disable 后条目从配置面移除。
    const brokenProbe = await app.inject({
      method: 'POST',
      url: `/api/v1/connectors/${broken.json().id}/probe`,
      payload: { wakerId: 'codex-assistant' },
    });
    assert.equal(brokenProbe.json().status, 'error');

    const disabled = await app.inject({
      method: 'POST',
      url: `/api/v1/connectors/${connector.json().id}/disable`,
      payload: { wakerId: 'codex-assistant' },
    });
    assert.equal(disabled.statusCode, 200);
    assert.equal(disabled.json().status, 'disabled');
    assert.doesNotMatch(configToml(), new RegExp(serverName));

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

describe('automation inbound trigger API', () => {
  const root = mkdtempSync(join(tmpdir(), 'waker-api-trigger-'));
  mkdirSync(join(root, '.codex', 'agents'), { recursive: true });
  writeFileSync(
    join(root, '.codex', 'agents', 'trigger-agent.md'),
    '---\nname: Trigger Agent\nmark: TG\ntagline: Test\ndescription: Test\nsuggestions:\n  - Test\n---\n\nTrigger agent.\n',
  );
  const app = buildApp(
    { ...config, CODEX_AGENT_ENABLED: true },
    {
      cwd: root,
      schedulerIntervalMs: false,
      automationRuntime: {
        runTurn: async () => ({
          answer: 'done',
          thinkingText: '',
          usage: { input: 1, output: 1, total: 2 },
        }),
        abortTurn: async () => undefined,
      },
    },
  );

  before(async () => app.ready());
  after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function settle(runId: string) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/automation-runs?wakerId=trigger-agent',
      });
      const run = response.json().items.find((item: { id: string }) => item.id === runId);
      if (run && !['queued', 'running'].includes(run.status)) return run;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`automation run did not settle: ${runId}`);
  }

  it('invokes api automations with trigger key auth and rotates the key', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/automations',
      payload: { wakerId: 'trigger-agent', name: 'API hook', kind: 'api', prompt: 'Handle it' },
    });
    assert.equal(created.statusCode, 201);
    const automationId = created.json().id as string;
    const key = created.json().triggerKey as string;
    assert.match(key, /^wak_/);

    const missing = await app.inject({
      method: 'POST',
      url: `/api/v1/automations/${automationId}/invoke`,
      payload: { hello: 1 },
    });
    assert.equal(missing.statusCode, 401);
    const wrong = await app.inject({
      method: 'POST',
      url: `/api/v1/automations/${automationId}/invoke`,
      headers: { 'x-api-trigger-key': 'wak_wrong' },
      payload: { hello: 1 },
    });
    assert.equal(wrong.statusCode, 401);

    const invoked = await app.inject({
      method: 'POST',
      url: `/api/v1/automations/${automationId}/invoke`,
      headers: { 'x-api-trigger-key': key },
      payload: { issue: 42 },
    });
    assert.equal(invoked.statusCode, 202);
    assert.equal(invoked.json().trigger, 'api');
    assert.deepEqual(invoked.json().input, { payload: { issue: 42 } });
    assert.equal((await settle(invoked.json().id)).status, 'succeeded');

    const bearer = await app.inject({
      method: 'POST',
      url: `/api/v1/automations/${automationId}/invoke`,
      headers: { authorization: `Bearer ${key}` },
      payload: { issue: 43 },
    });
    assert.equal(bearer.statusCode, 202);
    await settle(bearer.json().id);

    const rotated = await app.inject({
      method: 'POST',
      url: `/api/v1/automations/${automationId}/rotate-trigger-key`,
      payload: { wakerId: 'trigger-agent' },
    });
    assert.equal(rotated.statusCode, 200);
    const newKey = rotated.json().triggerKey as string;
    assert.match(newKey, /^wak_/);
    assert.notEqual(newKey, key);
    const stale = await app.inject({
      method: 'POST',
      url: `/api/v1/automations/${automationId}/invoke`,
      headers: { 'x-api-trigger-key': key },
      payload: { issue: 44 },
    });
    assert.equal(stale.statusCode, 401);
    const fresh = await app.inject({
      method: 'POST',
      url: `/api/v1/automations/${automationId}/invoke`,
      headers: { 'x-api-trigger-key': newKey },
      payload: { issue: 44 },
    });
    assert.equal(fresh.statusCode, 202);
    await settle(fresh.json().id);
  });

  it('accepts event webhooks with a query key and rejects kind mismatches', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/automations',
      payload: { wakerId: 'trigger-agent', name: 'Event sink', kind: 'event', prompt: 'Handle it' },
    });
    assert.equal(created.statusCode, 201);
    const automationId = created.json().id as string;
    const key = created.json().triggerKey as string;
    assert.match(key, /^wak_/);

    const mismatch = await app.inject({
      method: 'POST',
      url: `/api/v1/automations/${automationId}/invoke`,
      headers: { 'x-api-trigger-key': key },
      payload: { action: 'opened' },
    });
    assert.equal(mismatch.statusCode, 409);

    const wrong = await app.inject({
      method: 'POST',
      url: `/api/v1/automations/${automationId}/webhook?key=nope`,
      payload: { action: 'opened' },
    });
    assert.equal(wrong.statusCode, 401);

    const delivered = await app.inject({
      method: 'POST',
      url: `/api/v1/automations/${automationId}/webhook?key=${key}`,
      payload: { action: 'opened' },
    });
    assert.equal(delivered.statusCode, 202);
    assert.equal(delivered.json().trigger, 'event');
    assert.deepEqual(delivered.json().input, { payload: { action: 'opened' } });
    assert.equal((await settle(delivered.json().id)).status, 'succeeded');
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

describe('automation stats and calendar API', () => {
  const root = mkdtempSync(join(tmpdir(), 'waker-api-automation-stats-'));
  mkdirSync(join(root, '.codex', 'agents'), { recursive: true });
  for (const [agentId, name] of [
    ['stats-agent', 'Stats Agent'],
    ['calendar-agent', 'Calendar Agent'],
  ]) {
    writeFileSync(
      join(root, '.codex', 'agents', `${agentId}.md`),
      `---\nname: ${name}\nmark: SA\ntagline: Test\ndescription: Test\nsuggestions:\n  - Test\n---\n\nTest agent.\n`,
    );
  }
  const app = buildApp(config, { cwd: root });

  before(async () => app.ready());
  after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function createAutomation(payload: Record<string, unknown>): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/automations',
      payload,
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json().id as string;
  }

  it('aggregates run stats per automation and in totals', async () => {
    const scheduleId = await createAutomation({
      wakerId: 'stats-agent',
      name: '定时汇总',
      kind: 'schedule',
      schedule: '0 9 * * *',
      timezone: 'UTC',
      prompt: '汇总进展',
    });
    const apiId = await createAutomation({
      wakerId: 'stats-agent',
      name: 'API 任务',
      kind: 'api',
      prompt: '处理调用',
    });
    const emptyId = await createAutomation({
      wakerId: 'stats-agent',
      name: '未运行',
      kind: 'event',
      prompt: '等待事件',
      enabled: false,
    });

    const store = new WorkspaceStore(join(root, '.codex', 'workspace.sqlite'));
    try {
      const setTrigger = (runId: string, trigger: string) =>
        store.db
          .prepare(
            `UPDATE automation_runs SET trigger=?,
             scheduled_for=CASE WHEN ?='scheduled' THEN COALESCE(scheduled_for, created_at)
                                ELSE scheduled_for END
             WHERE id=?`,
          )
          .run(trigger, trigger, runId);
      // Schedule automation: succeeded(scheduled), failed(scheduled), cancelled(manual), running(api).
      const r1 = store.enqueueAutomationRun('stats-agent', scheduleId, { trigger: 'manual' });
      store.startAutomationRun('stats-agent', r1.id);
      store.completeAutomationRun('stats-agent', r1.id, 'done');
      setTrigger(r1.id, 'scheduled');
      const r2 = store.enqueueAutomationRun('stats-agent', scheduleId, { trigger: 'manual' });
      store.startAutomationRun('stats-agent', r2.id);
      store.failAutomationRun('stats-agent', r2.id, 'boom');
      setTrigger(r2.id, 'scheduled');
      const r3 = store.enqueueAutomationRun('stats-agent', scheduleId, { trigger: 'manual' });
      store.cancelAutomationRun('stats-agent', r3.id);
      const r4 = store.enqueueAutomationRun('stats-agent', scheduleId, { trigger: 'manual' });
      store.startAutomationRun('stats-agent', r4.id);
      setTrigger(r4.id, 'api');
      // API automation: succeeded(event), skipped(manual), queued(manual).
      const r5 = store.enqueueAutomationRun('stats-agent', apiId, { trigger: 'api' });
      store.startAutomationRun('stats-agent', r5.id);
      store.completeAutomationRun('stats-agent', r5.id, 'done');
      setTrigger(r5.id, 'event');
      const r6 = store.enqueueAutomationRun('stats-agent', apiId, { trigger: 'manual' });
      store.skipAutomationRun('stats-agent', r6.id, 'not needed');
      const r7 = store.enqueueAutomationRun('stats-agent', apiId, { trigger: 'manual' });
      // Pin created_at so last-run ordering is deterministic.
      const base = Date.parse('2026-08-20T00:00:00Z');
      [r1, r2, r3, r4, r5, r6, r7].forEach((run, index) =>
        store.db
          .prepare('UPDATE automation_runs SET created_at=? WHERE id=?')
          .run(base + index, run.id),
      );
    } finally {
      store.close();
    }

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/automation-stats?wakerId=stats-agent',
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.wakerId, 'stats-agent');
    assert.deepEqual(body.totals.byStatus, {
      queued: 1,
      running: 1,
      succeeded: 2,
      failed: 1,
      cancelled: 1,
      skipped: 1,
    });
    assert.deepEqual(body.totals.byTrigger, { manual: 3, scheduled: 2, api: 1, event: 1, git: 0 });
    assert.equal(body.totals.total, 7);
    assert.equal(body.totals.successRate, 0.5);
    assert.equal(body.totals.lastRunStatus, 'queued');
    assert.ok(body.totals.lastRunAt);

    assert.equal(body.automations.length, 3);
    const byId = new Map(
      body.automations.map((entry: { automationId: string }) => [entry.automationId, entry]),
    );
    const schedule = byId.get(scheduleId) as Record<string, unknown>;
    assert.equal(schedule.total, 4);
    assert.deepEqual(schedule.byTrigger, { manual: 1, scheduled: 2, api: 1, event: 0, git: 0 });
    assert.equal(schedule.successRate, 1 / 3);
    assert.equal(schedule.lastRunStatus, 'running');
    const api = byId.get(apiId) as Record<string, unknown>;
    assert.equal(api.total, 3);
    assert.deepEqual(api.byStatus, {
      queued: 1,
      running: 0,
      succeeded: 1,
      failed: 0,
      cancelled: 0,
      skipped: 1,
    });
    assert.equal(api.successRate, 1);
    const empty = byId.get(emptyId) as Record<string, unknown>;
    assert.equal(empty.total, 0);
    assert.equal(empty.successRate, null);
    assert.equal('lastRunAt' in empty, false);
    assert.equal('lastRunStatus' in empty, false);
  });

  it('buckets historical runs and expands enabled schedules per day', async () => {
    const scheduleId = await createAutomation({
      wakerId: 'calendar-agent',
      name: '每日晨报',
      kind: 'schedule',
      schedule: '30 8 * * *',
      timezone: 'UTC',
      prompt: '生成晨报',
    });
    await createAutomation({
      wakerId: 'calendar-agent',
      name: '暂停的计划',
      kind: 'schedule',
      schedule: '0 12 * * *',
      timezone: 'UTC',
      prompt: '不应计入',
      enabled: false,
    });

    const today = new Date().toISOString().slice(0, 10);
    const dayMs = 86_400_000;
    const shift = (key: string, days: number) =>
      new Date(Date.parse(`${key}T00:00:00Z`) + days * dayMs).toISOString().slice(0, 10);
    const store = new WorkspaceStore(join(root, '.codex', 'workspace.sqlite'));
    try {
      const first = store.enqueueAutomationRun('calendar-agent', scheduleId, { trigger: 'manual' });
      store.startAutomationRun('calendar-agent', first.id);
      store.completeAutomationRun('calendar-agent', first.id, 'done');
      const second = store.enqueueAutomationRun('calendar-agent', scheduleId, {
        trigger: 'manual',
      });
      store.cancelAutomationRun('calendar-agent', second.id);
      const createdAt = Date.parse(`${today}T02:00:00Z`);
      store.db
        .prepare('UPDATE automation_runs SET created_at=? WHERE waker_id=?')
        .run(createdAt, 'calendar-agent');
    } finally {
      store.close();
    }

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/automation-calendar?wakerId=calendar-agent&timezone=UTC&from=${shift(today, -1)}&to=${shift(today, 1)}`,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.timezone, 'UTC');
    assert.deepEqual(body.days, [
      { date: shift(today, -1), runs: 0, scheduled: 1 },
      { date: today, runs: 2, scheduled: 1 },
      { date: shift(today, 1), runs: 0, scheduled: 1 },
    ]);
  });

  it('returns zero-filled stats and calendar for unknown wakers', async () => {
    const stats = await app.inject({
      method: 'GET',
      url: '/api/v1/automation-stats?wakerId=ghost-agent',
    });
    assert.equal(stats.statusCode, 200);
    assert.deepEqual(stats.json().totals, {
      total: 0,
      byStatus: { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0, skipped: 0 },
      byTrigger: { manual: 0, scheduled: 0, api: 0, event: 0, git: 0 },
      successRate: null,
    });
    assert.deepEqual(stats.json().automations, []);

    const calendar = await app.inject({
      method: 'GET',
      url: '/api/v1/automation-calendar?wakerId=ghost-agent&from=2026-08-01&to=2026-08-03&timezone=UTC',
    });
    assert.equal(calendar.statusCode, 200);
    assert.deepEqual(calendar.json().days, [
      { date: '2026-08-01', runs: 0, scheduled: 0 },
      { date: '2026-08-02', runs: 0, scheduled: 0 },
      { date: '2026-08-03', runs: 0, scheduled: 0 },
    ]);
  });

  it('rejects invalid calendar parameters with 400', async () => {
    const cases = [
      '/api/v1/automation-calendar?from=2026-08-01&to=2026-08-02',
      '/api/v1/automation-calendar?wakerId=stats-agent&from=2026-13-40',
      '/api/v1/automation-calendar?wakerId=stats-agent&to=not-a-date',
      '/api/v1/automation-calendar?wakerId=stats-agent&from=2026-08-10&to=2026-08-01',
      '/api/v1/automation-calendar?wakerId=stats-agent&from=2026-08-01&to=2026-09-15',
      '/api/v1/automation-calendar?wakerId=stats-agent&timezone=Not/AZone',
    ];
    for (const url of cases) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 400, url);
    }
    const missingWaker = await app.inject({ method: 'GET', url: '/api/v1/automation-stats' });
    assert.equal(missingWaker.statusCode, 400);
  });
});
