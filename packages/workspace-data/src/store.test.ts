import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { seedWorkspace } from './seed.js';
import { calculateNextRun, WorkspaceStore } from './store.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fileStore(now = 1_000): { store: WorkspaceStore; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'waker-workspace-'));
  roots.push(root);
  const path = join(root, 'workspace.sqlite');
  return { store: new WorkspaceStore(path, { now: () => now }), path };
}

describe('WorkspaceStore migrations', () => {
  it('applies each migration once and can reopen the database', () => {
    const { store, path } = fileStore();
    assert.deepEqual(store.migrationVersions(), ['001', '002', '003']);
    store.close();
    const reopened = new WorkspaceStore(path);
    assert.deepEqual(reopened.migrationVersions(), ['001', '002', '003']);
    reopened.close();
  });
});

describe('WorkspaceStore CRUD and isolation', () => {
  it('supports project CRUD while hiding another Waker private project', () => {
    const store = new WorkspaceStore(':memory:');
    const privateProject = store.createProject({
      visibility: 'private',
      wakerId: 'alpha',
      name: 'Secret',
      description: '',
      source: 'filesystem',
      status: 'idle',
    });
    store.createProject({
      visibility: 'public',
      wakerId: 'alpha',
      name: 'Public',
      description: '',
      source: 'filesystem',
      status: 'ready',
    });
    assert.equal(store.getProject('beta', privateProject.id), undefined);
    assert.equal(store.listProjects('beta').length, 1);
    assert.equal(store.updateProject('beta', privateProject.id, { name: 'Stolen' }), undefined);
    assert.equal(
      store.updateProject('alpha', privateProject.id, { status: 'ready' })?.status,
      'ready',
    );
    assert.equal(store.deleteProject('beta', privateProject.id), false);
    assert.equal(store.deleteProject('alpha', privateProject.id), true);
    store.close();
  });

  it('covers automation, workflow, channel and task CRUD', () => {
    const store = new WorkspaceStore(':memory:');
    const automation = store.createAutomation({
      wakerId: 'alpha',
      name: 'Hook',
      kind: 'api',
      prompt: 'Run it',
    });
    assert.equal(store.listAutomations('beta').length, 0);
    assert.equal(
      store.updateAutomation('alpha', automation.id, { enabled: false })?.enabled,
      false,
    );
    assert.equal(store.deleteAutomation('alpha', automation.id), true);

    const workflow = store.createWorkflow({
      name: 'Flow',
      description: '',
      script: 'run()',
      status: 'draft',
    });
    assert.equal(store.updateWorkflow(workflow.id, { status: 'active' })?.status, 'active');
    assert.equal(store.deleteWorkflow(workflow.id), true);

    const channel = store.createChannel({
      provider: 'slack',
      name: 'Team',
      status: 'connected',
      configMetadata: { workspace: 'demo' },
    });
    assert.deepEqual(store.getChannel(channel.id)?.configMetadata, { workspace: 'demo' });
    assert.equal(store.updateChannel(channel.id, { status: 'error' })?.status, 'error');
    assert.equal(store.deleteChannel(channel.id), true);

    const task = store.createTask({
      title: 'Do',
      type: 'manual',
      status: 'queued',
      wakerId: 'alpha',
      source: 'user',
    });
    assert.equal(store.getTask('beta', task.id), undefined);
    assert.equal(
      store.updateTask('alpha', task.id, { status: 'running', startedAt: 20 })?.status,
      'running',
    );
    assert.equal(store.deleteTask('alpha', task.id), true);
    store.close();
  });
});

describe('WorkspaceStore automation and constraints', () => {
  it('runs enabled automation atomically and records lastRun', () => {
    let now = 100;
    const store = new WorkspaceStore(':memory:', { now: () => now });
    const automation = store.createAutomation({
      wakerId: 'alpha',
      name: 'Daily',
      kind: 'schedule',
      schedule: '0 9 * * *',
      prompt: 'Summarize',
    });
    now = 200;
    const task = store.runAutomation('alpha', automation.id);
    assert.equal(task.source, `automation:${automation.id}`);
    assert.equal(task.status, 'queued');
    assert.equal(store.getAutomation('alpha', automation.id)?.lastRun, 200);
    assert.throws(() => store.runAutomation('beta', automation.id), /not found/);
    store.updateAutomation('alpha', automation.id, { enabled: false });
    assert.throws(() => store.runAutomation('alpha', automation.id), /disabled/);
    store.close();
  });

  it('pauses, resumes, computes deterministic schedules and tracks run state', () => {
    let now = 1_000;
    const store = new WorkspaceStore(':memory:', { now: () => now });
    const value = store.createAutomation({
      wakerId: 'alpha',
      name: 'Polling',
      kind: 'schedule',
      schedule: 'interval:500',
      prompt: 'Poll',
    });
    assert.equal(value.nextRun, 1_500);
    assert.equal(store.pauseAutomation('alpha', value.id)?.nextRun, null);
    now = 2_000;
    assert.equal(store.resumeAutomation('alpha', value.id)?.nextRun, 2_500);
    assert.equal(store.updateAutomation('beta', value.id, { name: 'Nope' }), undefined);

    const task = store.runAutomation('alpha', value.id, { request: 1 });
    const queued = store.getAutomationRunByTask('alpha', task.id)!;
    assert.equal(queued.status, 'queued');
    assert.deepEqual(queued.input, { request: 1 });
    assert.equal(store.getAutomationRunByTask('beta', task.id), undefined);
    now = 2_100;
    assert.equal(store.startAutomationRun('alpha', queued.id).status, 'running');
    now = 2_200;
    const completed = store.completeAutomationRun('alpha', queued.id, { answer: 42 });
    assert.equal(completed.status, 'succeeded');
    assert.deepEqual(completed.output, { answer: 42 });
    assert.equal(store.getTask('alpha', task.id)?.status, 'completed');
    assert.throws(() => store.cancelAutomationRun('alpha', queued.id), /transition/);

    const failedTask = store.runAutomation('alpha', value.id);
    const failedRun = store.getAutomationRunByTask('alpha', failedTask.id)!;
    store.startAutomationRun('alpha', failedRun.id);
    assert.equal(store.failAutomationRun('alpha', failedRun.id, 'boom').status, 'failed');
    assert.equal(store.getTask('alpha', failedTask.id)?.error, 'boom');

    const cancelledTask = store.runAutomation('alpha', value.id);
    const cancelledRun = store.getAutomationRunByTask('alpha', cancelledTask.id)!;
    assert.equal(store.cancelAutomationRun('alpha', cancelledRun.id).status, 'cancelled');
    assert.equal(store.getTask('alpha', cancelledTask.id)?.status, 'cancelled');
    assert.equal(store.listAutomationRuns('alpha', value.id).length, 3);
    store.deleteAutomation('alpha', value.id);
    assert.equal(store.listAutomationRuns('alpha').length, 0);
    store.close();
  });

  it('validates cron/interval/once schedules without pretending to schedule cron', () => {
    assert.equal(calculateNextRun('interval:250', 1_000), 1_250);
    assert.equal(calculateNextRun('once:2000', 1_000), 2_000);
    assert.equal(calculateNextRun('once:500', 1_000), null);
    assert.equal(calculateNextRun('0 9 * * *', 1_000), null);
    assert.throws(() => calculateNextRun('interval:0', 1_000), /interval/);
    assert.throws(() => calculateNextRun('not cron', 1_000), /cron/);
    assert.throws(() => calculateNextRun('60 9 * * *', 1_000), /cron/);
  });

  it('validates states, schedule, task ownership and secret-free metadata', () => {
    const store = new WorkspaceStore(':memory:');
    assert.throws(
      () => store.createAutomation({ wakerId: 'a', name: 'Bad', kind: 'schedule', prompt: 'x' }),
      /schedule/,
    );
    assert.throws(
      () =>
        store.createWorkflow({
          name: 'Bad',
          description: '',
          script: '',
          status: 'unknown' as never,
        }),
      /Invalid/,
    );
    assert.throws(
      () =>
        store.createChannel({
          provider: 'x',
          name: 'x',
          status: 'connected',
          configMetadata: { apiKey: 'nope' },
        }),
      /secrets/,
    );
    const project = store.createProject({
      visibility: 'private',
      wakerId: 'alpha',
      name: 'A',
      description: '',
      source: 'filesystem',
      status: 'ready',
    });
    assert.throws(
      () =>
        store.createTask({
          title: 'Cross tenant',
          type: 'manual',
          status: 'queued',
          wakerId: 'beta',
          projectId: project.id,
          source: 'user',
        }),
      /does not belong/,
    );
    assert.throws(
      () =>
        store.createTask({
          title: 'Incomplete',
          type: 'manual',
          status: 'completed',
          wakerId: 'alpha',
          source: 'user',
        }),
      /completedAt/,
    );
    store.close();
  });

  it('cascades project deletion to its tasks and seeds idempotently', () => {
    const store = new WorkspaceStore(':memory:');
    const project = store.createProject({
      visibility: 'private',
      wakerId: 'alpha',
      name: 'A',
      description: '',
      source: 'filesystem',
      status: 'ready',
    });
    store.createTask({
      title: 'Bound',
      type: 'manual',
      status: 'queued',
      wakerId: 'alpha',
      projectId: project.id,
      source: 'user',
    });
    store.bindSessionContext({
      sessionId: 'bound-session',
      wakerId: 'alpha',
      projectId: project.id,
      workingDirectory: '/tmp/project',
    });
    assert.deepEqual(store.getProjectDeleteImpact('alpha', project.id), {
      projectId: project.id,
      sessionContexts: 1,
      tasks: 1,
    });
    assert.equal(store.getProjectDeleteImpact('beta', project.id), undefined);
    store.deleteProject('alpha', project.id);
    assert.equal(store.listTasks('alpha').length, 0);
    assert.equal(store.getSessionContext('alpha', 'bound-session'), undefined);
    seedWorkspace(store);
    seedWorkspace(store);
    assert.equal(
      store.listProjects('demo-waker').filter((item) => item.id === 'demo-project').length,
      1,
    );
    store.close();
  });
});

describe('WorkspaceStore workflow runs', () => {
  it('snapshots workflow versions and records waiting/resume trace', () => {
    let now = 10;
    const store = new WorkspaceStore(':memory:', { now: () => now });
    const workflow = store.createWorkflow({
      name: 'Flow',
      description: 'v1',
      script: 'one()',
      status: 'active',
    });
    const first = store.runWorkflow(workflow.id, { topic: 'one' });
    assert.equal(first.workflowVersion, 1);
    assert.equal(first.scriptSnapshot, 'one()');
    assert.equal(first.status, 'queued');

    now = 20;
    store.startWorkflowRun(first.id);
    store.appendWorkflowRunEvent(first.id, 'step', { index: 1 });
    store.waitForWorkflowInput(first.id, { question: 'continue?' });
    assert.throws(() => store.completeWorkflowRun(first.id), /transition/);
    store.resumeWorkflowRun(first.id, { answer: 'yes' });
    now = 30;
    const completed = store.completeWorkflowRun(first.id, { ok: true });
    assert.equal(completed.status, 'succeeded');
    assert.deepEqual(completed.output, { ok: true });
    assert.deepEqual(
      store.getWorkflowRunTrace(first.id).events.map((event) => event.type),
      ['queued', 'started', 'step', 'waiting_input', 'resumed', 'succeeded'],
    );
    assert.throws(() => store.appendWorkflowRunEvent(first.id, 'late'), /Cannot append/);

    const updated = store.updateWorkflow(workflow.id, { script: 'two()', description: 'v2' })!;
    assert.equal(updated.version, 2);
    const second = store.runWorkflow(workflow.id);
    assert.equal(second.workflowVersion, 2);
    assert.equal(second.scriptSnapshot, 'two()');
    assert.equal(first.scriptSnapshot, 'one()');
    assert.equal(store.listWorkflowRuns(workflow.id).length, 2);
    store.close();
  });

  it('enforces workflow transitions and supports fail/cancel/delete cascade', () => {
    const store = new WorkspaceStore(':memory:');
    const workflow = store.createWorkflow({
      name: 'Flow',
      description: '',
      script: 'run()',
      status: 'active',
    });
    const failed = store.runWorkflow(workflow.id);
    assert.throws(() => store.failWorkflowRun(failed.id, 'early'), /transition/);
    store.startWorkflowRun(failed.id);
    assert.equal(store.failWorkflowRun(failed.id, 'broken').error, 'broken');

    const cancelled = store.runWorkflow(workflow.id);
    assert.equal(store.cancelWorkflowRun(cancelled.id).status, 'cancelled');
    assert.equal(store.listWorkflowRuns(workflow.id).length, 2);
    assert.equal(store.deleteWorkflow(workflow.id), true);
    assert.equal(store.listWorkflowRuns(workflow.id).length, 0);

    const draft = store.createWorkflow({
      name: 'Draft',
      description: '',
      script: '',
      status: 'draft',
    });
    assert.throws(() => store.runWorkflow(draft.id), /not active/);
    store.close();
  });
});

describe('WorkspaceStore connectors and permissions', () => {
  it('isolates connector CRUD and supports enable/disable', () => {
    const store = new WorkspaceStore(':memory:');
    const value = store.createConnector({
      wakerId: 'alpha',
      name: 'Local MCP',
      transport: 'stdio',
      command: 'node server.js',
      status: 'disabled',
      metadata: { label: 'local' },
      tools: [{ name: 'search', description: 'Search documents' }],
    });
    assert.equal(store.getConnector('beta', value.id), undefined);
    assert.equal(store.listConnectors('beta').length, 0);
    assert.equal(store.enableConnector('beta', value.id), undefined);
    assert.equal(store.enableConnector('alpha', value.id)?.status, 'ready');
    assert.equal(store.updateConnector('alpha', value.id, { name: 'Updated' })?.name, 'Updated');
    assert.equal(store.disableConnector('alpha', value.id)?.status, 'disabled');
    assert.equal(store.deleteConnector('beta', value.id), false);
    assert.equal(store.deleteConnector('alpha', value.id), true);
    store.close();
  });

  it('rejects connector secrets in metadata, commands and URLs', () => {
    const store = new WorkspaceStore(':memory:');
    assert.throws(
      () =>
        store.createConnector({
          wakerId: 'a',
          name: 'Bad',
          transport: 'stdio',
          command: 'API_KEY=secret node x.js',
          status: 'ready',
        }),
      /secrets/,
    );
    assert.throws(
      () =>
        store.createConnector({
          wakerId: 'a',
          name: 'Bad',
          transport: 'http',
          url: 'https://example.test/mcp?token=secret',
          status: 'ready',
        }),
      /secrets/,
    );
    assert.throws(
      () =>
        store.createConnector({
          wakerId: 'a',
          name: 'Bad',
          transport: 'http',
          url: 'https://user:pass@example.test/mcp',
          status: 'ready',
        }),
      /secret-free/,
    );
    assert.throws(
      () =>
        store.createConnector({
          wakerId: 'a',
          name: 'Bad',
          transport: 'http',
          url: 'https://example.test/mcp',
          status: 'ready',
          metadata: { headers: { authorizationToken: 'secret' } },
        }),
      /secrets/,
    );
    store.close();
  });

  it('stores only permission policies no broader than the host', () => {
    const store = new WorkspaceStore(':memory:');
    const host: Parameters<WorkspaceStore['setPermissionPolicy']>[2] = {
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      toolGuard: 'ask',
      fileGuard: 'allow',
      builtinTools: ['read', 'write'],
    };
    const saved = store.setPermissionPolicy(
      'alpha',
      {
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        toolGuard: 'deny',
        fileGuard: 'ask',
        builtinTools: ['read'],
      },
      host,
    );
    assert.deepEqual(saved.builtinTools, ['read']);
    assert.equal(store.getPermissionPolicy('beta'), undefined);
    assert.throws(
      () =>
        store.setPermissionPolicy('alpha', { ...saved, sandboxMode: 'danger-full-access' }, host),
      /broaden/,
    );
    assert.throws(
      () => store.setPermissionPolicy('alpha', { ...saved, builtinTools: ['shell'] }, host),
      /broaden/,
    );
    assert.throws(
      () => store.setPermissionPolicy('alpha', { ...saved, toolGuard: 'invalid' as never }, host),
      /Invalid/,
    );
    assert.equal(store.deletePermissionPolicy('alpha'), true);
    store.close();
  });
});

describe('WorkspaceStore human actions and session contexts', () => {
  it('isolates and resolves or ignores pending human actions once', () => {
    let now = 100;
    const store = new WorkspaceStore(':memory:', { now: () => now });
    const handled = store.createHumanAction({
      wakerId: 'alpha',
      source: 'workflow',
      sourceId: 'run-1',
      title: 'Approve',
      prompt: 'Continue?',
    });
    assert.equal(store.getHumanAction('beta', handled.id), undefined);
    assert.equal(store.updateHumanAction('beta', handled.id, { title: 'Nope' }), undefined);
    assert.equal(
      store.updateHumanAction('alpha', handled.id, { title: 'Choose' })?.title,
      'Choose',
    );
    now = 200;
    const resolved = store.resolveHumanAction('alpha', handled.id, { approved: true });
    assert.equal(resolved.status, 'handled');
    assert.equal(resolved.resolvedAt, 200);
    assert.deepEqual(resolved.result, { approved: true });
    assert.throws(() => store.ignoreHumanAction('alpha', handled.id), /transition/);

    const ignored = store.createHumanAction({
      wakerId: 'alpha',
      source: 'codex',
      sourceId: 'turn-1',
      title: 'Question',
      prompt: 'Answer?',
    });
    assert.equal(store.ignoreHumanAction('alpha', ignored.id).status, 'ignored');
    assert.equal(store.listHumanActions('alpha', 'pending').length, 0);
    assert.equal(store.listHumanActions('beta').length, 0);
    assert.equal(store.deleteHumanAction('beta', ignored.id), false);
    assert.equal(store.deleteHumanAction('alpha', ignored.id), true);
    store.close();
  });

  it('persists session context and prevents cross-Waker rebinding', () => {
    const { store, path } = fileStore();
    const own = store.createProject({
      visibility: 'private',
      wakerId: 'alpha',
      name: 'Own',
      description: '',
      source: 'filesystem',
      status: 'ready',
    });
    const context = store.bindSessionContext({
      sessionId: 'session-1',
      wakerId: 'alpha',
      projectId: own.id,
      workingDirectory: '/tmp/project',
    });
    assert.equal(context.projectId, own.id);
    assert.equal(store.getSessionContext('beta', 'session-1'), undefined);
    assert.throws(
      () =>
        store.bindSessionContext({
          sessionId: 'session-1',
          wakerId: 'beta',
          projectId: null,
          workingDirectory: null,
        }),
      /another Waker/,
    );
    store.close();

    const reopened = new WorkspaceStore(path);
    assert.equal(
      reopened.getSessionContext('alpha', 'session-1')?.workingDirectory,
      '/tmp/project',
    );
    const hidden = reopened.createProject({
      visibility: 'private',
      wakerId: 'beta',
      name: 'Hidden',
      description: '',
      source: 'filesystem',
      status: 'ready',
    });
    assert.throws(
      () =>
        reopened.bindSessionContext({
          sessionId: 'session-2',
          wakerId: 'alpha',
          projectId: hidden.id,
          workingDirectory: null,
        }),
      /not visible/,
    );
    assert.equal(reopened.deleteSessionContext('beta', 'session-1'), false);
    assert.equal(reopened.deleteSessionContext('alpha', 'session-1'), true);
    reopened.close();
  });
});
