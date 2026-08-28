import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { seedWorkspace } from './seed.js';
import { calculateNextRun, WorkspaceStore } from './store.js';
import type { WorkflowDefinition } from './workflow.js';

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

function basicWorkflowDefinition(prompt = 'Run'): WorkflowDefinition {
  return {
    schemaVersion: 1,
    start: 'work',
    nodes: [
      { id: 'work', kind: 'codex', prompt, next: 'done' },
      { id: 'done', kind: 'terminal', status: 'succeeded' },
    ],
  };
}

describe('WorkspaceStore migrations', () => {
  it('applies each migration once and can reopen the database', () => {
    const { store, path } = fileStore();
    assert.deepEqual(store.migrationVersions(), [
      '001',
      '002',
      '003',
      '004',
      '005',
      '006',
      '007',
      '008',
      '009',
      '010',
    ]);
    store.close();
    const reopened = new WorkspaceStore(path);
    assert.deepEqual(reopened.migrationVersions(), [
      '001',
      '002',
      '003',
      '004',
      '005',
      '006',
      '007',
      '008',
      '009',
      '010',
    ]);
    reopened.close();
  });

  it('upgrades legacy cron rows and resolves duplicate active runs deterministically', () => {
    const root = mkdtempSync(join(tmpdir(), 'waker-workspace-legacy-'));
    roots.push(root);
    const path = join(root, 'workspace.sqlite');
    const db = new Database(path);
    db.pragma('foreign_keys = ON');
    db.exec(
      'CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)',
    );
    for (const filename of ['001_workspace.sql', '002_runs.sql', '003_capabilities.sql']) {
      db.exec(
        readFileSync(
          join(dirname(fileURLToPath(import.meta.url)), '../migrations', filename),
          'utf8',
        ),
      );
      db.prepare('INSERT INTO schema_migrations VALUES (?, 0)').run(filename.slice(0, 3));
    }
    db.prepare(
      `INSERT INTO automations
       (id,waker_id,name,kind,schedule,prompt,enabled,created_at,updated_at)
       VALUES ('legacy','alpha','Legacy','schedule','0 9 * * *','run',1,1000,1000)`,
    ).run();
    for (const [id, status, createdAt] of [
      ['older', 'queued', 1_100],
      ['newer', 'running', 1_200],
    ] as const) {
      db.prepare(
        `INSERT INTO tasks
         (id,title,type,status,waker_id,source,created_at,updated_at,started_at)
         VALUES (?,?, 'automation', ?, 'alpha', 'automation:legacy', ?, ?, ?)`,
      ).run(
        `task-${id}`,
        'Legacy',
        status,
        createdAt,
        createdAt,
        status === 'running' ? createdAt : null,
      );
      db.prepare(
        `INSERT INTO automation_runs
         (id,automation_id,task_id,waker_id,status,created_at,updated_at,started_at)
         VALUES (?,'legacy',?,'alpha',?,?,?,?)`,
      ).run(
        id,
        `task-${id}`,
        status,
        createdAt,
        createdAt,
        status === 'running' ? createdAt : null,
      );
    }
    db.exec(
      readFileSync(
        join(
          dirname(fileURLToPath(import.meta.url)),
          '../migrations',
          '004_automation_scheduling.sql',
        ),
        'utf8',
      ),
    );
    db.prepare('INSERT INTO schema_migrations VALUES (?, 0)').run('004');
    db.close();

    const now = Date.parse('2026-08-28T00:00:00Z');
    const store = new WorkspaceStore(path, { now: () => now });
    assert.deepEqual(store.migrationVersions(), [
      '001',
      '002',
      '003',
      '004',
      '005',
      '006',
      '007',
      '008',
      '009',
      '010',
    ]);
    assert.equal(
      store.getAutomation('alpha', 'legacy')?.nextRun,
      Date.parse('2026-08-28T09:00:00Z'),
    );
    assert.equal(
      store.listAutomationRuns('alpha', 'legacy').filter((run) => run.status === 'running').length,
      1,
    );
    assert.equal(store.getAutomationRun('alpha', 'older')?.status, 'cancelled');
    const migratedTask = store.getTask('alpha', 'task-older')!;
    assert.equal(migratedTask.status, 'cancelled');
    assert.equal(migratedTask.origin, 'derived');
    assert.equal(migratedTask.sourceType, 'automation');
    assert.equal(migratedTask.runId, 'older');
    assert.deepEqual(
      store.listTaskEvents('alpha', migratedTask.id).map((event) => event.type),
      ['created'],
    );
    store.close();
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
      wakerId: 'alpha',
      name: 'Flow',
      description: '',
      definition: basicWorkflowDefinition(),
      status: 'draft',
    });
    assert.equal(
      store.updateWorkflow('alpha', workflow.id, { expectedVersion: 1, status: 'active' })?.status,
      'active',
    );
    assert.equal(store.deleteWorkflow('alpha', workflow.id, 2), true);

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
      store.updateTask('alpha', task.id, { expectedVersion: 1, status: 'running' })?.status,
      'running',
    );
    assert.equal(store.deleteTask('alpha', task.id, 2), true);
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
    const firstRun = store.getAutomationRunByTask('alpha', task.id)!;
    store.cancelAutomationRun('alpha', firstRun.id);
    store.updateAutomation('alpha', automation.id, { enabled: false });
    const pausedManual = store.runAutomation('alpha', automation.id);
    assert.equal(store.getAutomationRunByTask('alpha', pausedManual.id)?.trigger, 'manual');
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
    assert.equal(store.listAutomationRuns('alpha').length, 3);
    store.close();
  });

  it('computes interval, once and cron schedules', () => {
    assert.equal(calculateNextRun('interval:250', 1_000), 1_250);
    assert.equal(calculateNextRun('once:2000', 1_000), 2_000);
    assert.equal(calculateNextRun('once:500', 1_000), null);
    assert.equal(calculateNextRun('0 9 * * *', 1_000), Date.UTC(1970, 0, 1, 9));
    assert.equal(calculateNextRun('interval:250', 1_000, { startAt: 2_000 }), 2_000);
    assert.equal(calculateNextRun('interval:250', 1_000, { endAt: 1_200 }), null);
    assert.equal(calculateNextRun('once:2000', 1_000, { startAt: 2_001 }), null);
    assert.throws(() => calculateNextRun('interval:0', 1_000), /interval/);
    assert.throws(() => calculateNextRun('not cron', 1_000), /cron/);
    assert.throws(() => calculateNextRun('60 9 * * *', 1_000), /cron/);
  });

  it('handles IANA timezone DST, wildcard day semantics and leap years', () => {
    assert.equal(
      calculateNextRun('30 2 * * *', Date.parse('2024-03-09T07:30:00Z'), {
        timeZone: 'America/New_York',
      }),
      Date.parse('2024-03-11T06:30:00Z'),
    );
    assert.equal(
      calculateNextRun('30 1 * * *', Date.parse('2024-11-03T05:30:00Z'), {
        timeZone: 'America/New_York',
      }),
      Date.parse('2024-11-03T06:30:00Z'),
    );
    assert.equal(
      calculateNextRun('0 9 */1 * 1', Date.parse('2026-08-28T00:00:00Z')),
      Date.parse('2026-08-31T09:00:00Z'),
    );
    assert.equal(
      calculateNextRun('0 0 29 2 *', Date.parse('2025-01-01T00:00:00Z')),
      Date.parse('2028-02-29T00:00:00Z'),
    );
    assert.throws(
      () => calculateNextRun('0 9 * * *', 1_000, { timeZone: 'Mars/Olympus' }),
      /timezone/,
    );
  });

  it('claims scheduled slots once and enforces maxRuns and misfire policy', () => {
    let now = 1_000;
    const store = new WorkspaceStore(':memory:', { now: () => now });
    const runOnce = store.createAutomation({
      id: 'run-once',
      wakerId: 'alpha',
      name: 'Run once',
      kind: 'schedule',
      schedule: 'interval:500',
      prompt: 'go',
      maxRuns: 1,
    });
    now = 1_500;
    const claimed = store.claimDueAutomation('alpha', runOnce.id, now)!;
    assert.equal(claimed.trigger, 'scheduled');
    assert.equal(claimed.scheduledFor, 1_500);
    assert.equal(store.claimDueAutomation('alpha', runOnce.id, now), undefined);
    assert.equal(store.getAutomation('alpha', runOnce.id)?.runCount, 1);
    assert.equal(store.getAutomation('alpha', runOnce.id)?.nextRun, null);

    const skipped = store.createAutomation({
      id: 'skip',
      wakerId: 'alpha',
      name: 'Skip',
      kind: 'schedule',
      schedule: 'interval:100',
      prompt: 'skip',
      misfirePolicy: 'skip',
    });
    now = 1_650;
    const withinGrace = store.claimDueAutomation('alpha', skipped.id, now)!;
    assert.equal(withinGrace.status, 'queued');
    assert.equal(withinGrace.scheduledFor, 1_600);
    store.cancelAutomationRun('alpha', withinGrace.id);
    now = 61_701;
    const skippedRun = store.claimDueAutomation('alpha', skipped.id, now)!;
    assert.equal(skippedRun.status, 'skipped');
    assert.equal(skippedRun.scheduledFor, 1_700);
    assert.equal(store.getAutomation('alpha', skipped.id)?.runCount, 1);
    assert.equal(store.getAutomation('alpha', skipped.id)?.nextRun, 61_800);
    store.close();
  });

  it('keeps immutable run snapshots and soft-deletes automation history', () => {
    const store = new WorkspaceStore(':memory:');
    const value = store.createAutomation({
      wakerId: 'alpha',
      name: 'Snapshot',
      kind: 'api',
      prompt: 'Original prompt',
      model: 'model-a',
      thinking: 'high',
    });
    const task = store.runAutomation('alpha', value.id, { value: 1 });
    const run = store.getAutomationRunByTask('alpha', task.id)!;
    assert.equal(run.nameSnapshot, 'Snapshot');
    assert.equal(run.promptSnapshot, 'Original prompt');
    assert.equal(run.model, 'model-a');
    assert.equal(store.listRecoverableAutomationRuns('alpha')[0]?.id, run.id);
    store.startAutomationRun('alpha', run.id);
    store.attachAutomationRunSession('alpha', run.id, 'session-one');
    assert.throws(
      () => store.attachAutomationRunSession('alpha', run.id, 'session-two'),
      /immutable/,
    );
    store.failAutomationRun('alpha', run.id, 'failed');
    assert.equal(store.listRecoverableAutomationRuns('alpha').length, 0);
    const retry = store.retryAutomationRun('alpha', run.id);
    assert.equal(retry.retryOfRunId, run.id);
    assert.equal(retry.attempt, 2);
    store.cancelAutomationRun('alpha', retry.id);
    assert.deepEqual(store.getAutomationDeleteImpact('alpha', value.id), {
      automationId: value.id,
      runs: 2,
      tasks: 2,
      sessions: 1,
    });
    assert.equal(store.deleteAutomation('alpha', value.id), true);
    assert.equal(store.getAutomation('alpha', value.id), undefined);
    assert.equal(store.listAutomationRuns('alpha', value.id).length, 2);
    assert.throws(() => store.retryAutomationRun('alpha', run.id), /not found/);
    store.close();
  });

  it('bounds automation history while reporting the complete total', () => {
    const store = new WorkspaceStore(':memory:');
    const value = store.createAutomation({
      wakerId: 'alpha',
      name: 'History',
      kind: 'api',
      prompt: 'run',
    });
    for (let index = 0; index < 3; index += 1) {
      const task = store.runAutomation('alpha', value.id);
      store.cancelAutomationRun('alpha', store.getAutomationRunByTask('alpha', task.id)!.id);
    }
    assert.equal(store.listAutomationRuns('alpha', value.id, { limit: 2 }).length, 2);
    assert.equal(store.countAutomationRuns('alpha', value.id), 3);
    assert.throws(() => store.listAutomationRuns('alpha', value.id, { limit: 201 }), /limit/);
    store.close();
  });

  it('validates states, schedule, task ownership and secret-free metadata', () => {
    const store = new WorkspaceStore(':memory:');
    assert.throws(
      () => store.createAutomation({ wakerId: 'a', name: 'Bad', kind: 'schedule', prompt: 'x' }),
      /schedule/,
    );
    assert.throws(
      () =>
        store.createAutomation({
          wakerId: 'a',
          name: 'Bad API',
          kind: 'api',
          schedule: '0 9 * * *',
          prompt: 'x',
        }),
      /Only scheduled/,
    );
    assert.throws(
      () =>
        store.createWorkflow({
          wakerId: 'a',
          name: 'Bad',
          description: '',
          definition: basicWorkflowDefinition(),
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
    const manualTask = store.createTask({
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
    const automation = store.createAutomation({
      wakerId: 'alpha',
      name: 'Bound automation',
      kind: 'api',
      prompt: 'run',
      projectId: project.id,
    });
    const automationTask = store.runAutomation('alpha', automation.id);
    const automationRun = store.getAutomationRunByTask('alpha', automationTask.id)!;
    store.startAutomationRun('alpha', automationRun.id);
    store.completeAutomationRun('alpha', automationRun.id, 'done');
    // Legacy runs did not carry their task's project snapshot; the task relation must still
    // protect that audit row from the project FK cascade.
    store.db.prepare('UPDATE automation_runs SET project_id=NULL WHERE id=?').run(automationRun.id);
    assert.deepEqual(store.getProjectDeleteImpact('alpha', project.id), {
      projectId: project.id,
      sessionContexts: 1,
      tasks: 2,
      tasksPreserved: 2,
      automationDefinitions: 1,
      automationRuns: 1,
      automationTasksPreserved: 1,
      workflowDefinitions: 0,
      workflowRuns: 0,
    });
    assert.equal(store.getProjectDeleteImpact('beta', project.id), undefined);
    store.deleteProject('alpha', project.id);
    assert.equal(store.listTasks('alpha').length, 2);
    assert.equal(store.getTask('alpha', manualTask.id)?.projectId, null);
    assert.equal(store.getTask('alpha', automationTask.id)?.projectId, null);
    assert.equal(store.getAutomationRun('alpha', automationRun.id)?.result, 'done');
    assert.equal(store.getAutomation('alpha', automation.id)?.projectId, null);
    assert.equal(store.getAutomation('alpha', automation.id)?.enabled, false);
    assert.equal(store.getSessionContext('alpha', 'bound-session'), undefined);
    seedWorkspace(store);
    seedWorkspace(store);
    assert.equal(
      store.listProjects('demo-waker').filter((item) => item.id === 'demo-project').length,
      1,
    );
    store.close();
  });

  it('refuses to delete a project while an automation run uses it', () => {
    const store = new WorkspaceStore(':memory:');
    const project = store.createProject({
      visibility: 'private',
      wakerId: 'alpha',
      name: 'Active',
      description: '',
      source: 'filesystem',
      status: 'ready',
    });
    const automation = store.createAutomation({
      wakerId: 'alpha',
      name: 'Active automation',
      kind: 'api',
      prompt: 'run',
      projectId: project.id,
    });
    store.runAutomation('alpha', automation.id);
    assert.throws(() => store.deleteProject('alpha', project.id), /active automation run/);
    assert.ok(store.getOwnedProject('alpha', project.id));
    store.close();
  });

  it('normalizes updated interval schedules and anchors a cron conversion once', () => {
    let now = 1_000;
    const store = new WorkspaceStore(':memory:', { now: () => now });
    const interval = store.createAutomation({
      wakerId: 'alpha',
      name: 'Interval',
      kind: 'schedule',
      schedule: 'interval:500',
      prompt: 'run',
    });
    assert.equal(
      store.updateAutomation('alpha', interval.id, { schedule: ' interval:500 ' })?.schedule,
      'interval:500',
    );
    now = 1_500;
    assert.equal(store.claimDueAutomation('alpha', interval.id, now)?.scheduledFor, 1_500);

    const cron = store.createAutomation({
      wakerId: 'alpha',
      name: 'Cron',
      kind: 'schedule',
      schedule: '0 9 * * *',
      prompt: 'run',
    });
    now = 2_000;
    const converted = store.updateAutomation('alpha', cron.id, { schedule: 'interval:500' })!;
    assert.equal(converted.startAt, 2_000);
    assert.equal(converted.nextRun, 2_500);
    now = 2_600;
    assert.equal(store.claimDueAutomation('alpha', cron.id, now)?.scheduledFor, 2_500);
    assert.equal(store.getAutomation('alpha', cron.id)?.nextRun, 3_000);
    store.close();
  });
});

describe('WorkspaceStore workflow runs', () => {
  it('claims, checkpoints and resumes an owner-scoped Human Action atomically', () => {
    let now = 10;
    const store = new WorkspaceStore(':memory:', { now: () => now });
    const workflow = store.createWorkflow({
      wakerId: 'alpha',
      name: 'Flow',
      description: 'v1',
      definition: {
        schemaVersion: 1,
        start: 'set',
        nodes: [
          { id: 'set', kind: 'action', action: 'set', key: 'ready', value: true, next: 'ask' },
          { id: 'ask', kind: 'ask_user', prompt: 'Continue?', inputKey: 'answer', next: 'done' },
          { id: 'done', kind: 'terminal', status: 'succeeded' },
        ],
      },
      status: 'active',
    });
    const first = store.runWorkflow('alpha', workflow.id, { topic: 'one' });
    assert.equal(first.workflowVersion, 1);
    assert.equal(first.currentNodeId, 'set');
    assert.equal(first.status, 'queued');
    assert.equal(store.getWorkflowRun('beta', first.id), undefined);

    now = 20;
    store.startWorkflowRun('alpha', first.id);
    store.checkpointWorkflowRun('alpha', first.id, {
      nodeId: 'set',
      nodeKind: 'action',
      nextNodeId: 'ask',
      context: { input: { topic: 'one' }, ready: true },
    });
    store.waitForWorkflowInput(
      'alpha',
      first.id,
      {
        nodeId: 'ask',
        nextNodeId: 'done',
        context: { input: { topic: 'one' }, ready: true },
        inputKey: 'answer',
        prompt: 'Continue?',
      },
      { title: 'Flow', prompt: 'Continue?' },
    );
    assert.equal(store.listHumanActions('alpha', 'pending').length, 1);
    assert.throws(() => store.completeWorkflowRun('alpha', first.id), /transition/);
    store.resumeWorkflowRun('alpha', first.id, 'yes');
    assert.equal(store.listHumanActions('alpha', 'handled').length, 1);
    assert.equal(store.getWorkflowRun('alpha', first.id)?.currentNodeId, 'done');
    now = 30;
    const completed = store.completeWorkflowRun('alpha', first.id, { ok: true });
    assert.equal(completed.status, 'succeeded');
    assert.deepEqual(completed.output, { ok: true });
    assert.deepEqual(
      store.getWorkflowRunTrace('alpha', first.id).events.map((event) => event.type),
      [
        'queued',
        'started',
        'node_succeeded',
        'checkpoint',
        'waiting_input',
        'resumed',
        'node_succeeded',
        'checkpoint',
        'succeeded',
      ],
    );
    assert.throws(() => store.appendWorkflowRunEvent('alpha', first.id, 'late'), /transition/);
    store.close();
  });

  it('recovers timed waits and retries the pinned immutable snapshot', () => {
    let now = 100;
    const store = new WorkspaceStore(':memory:', { now: () => now });
    const workflow = store.createWorkflow({
      wakerId: 'alpha',
      name: 'Flow',
      definition: {
        schemaVersion: 1,
        start: 'wait',
        nodes: [
          { id: 'wait', kind: 'wait', durationMs: 50, next: 'done' },
          { id: 'done', kind: 'terminal', status: 'succeeded' },
        ],
      },
      status: 'active',
    });
    const run = store.runWorkflow('alpha', workflow.id);
    store.startWorkflowRun('alpha', run.id);
    store.pauseWorkflowRun('alpha', run.id, {
      nodeId: 'wait',
      nextNodeId: 'done',
      context: {},
      resumeAt: 150,
    });
    assert.equal(store.listRecoverableWorkflowRuns('alpha')[0]?.status, 'paused');
    assert.throws(() => store.resumePausedWorkflowRun('alpha', run.id), /not due/);
    now = 150;
    assert.equal(store.resumePausedWorkflowRun('alpha', run.id).currentNodeId, 'done');
    const failed = store.failWorkflowRun('alpha', run.id, 'broken');
    const retry = store.retryWorkflowRun('alpha', failed.id);
    assert.equal(retry.workflowVersion, failed.workflowVersion);
    assert.deepEqual(retry.definitionSnapshot, failed.definitionSnapshot);
    assert.equal(retry.currentNodeId, failed.currentNodeId);
    assert.deepEqual(retry.context, failed.context);
    assert.equal(retry.retryOfRunId, failed.id);
    assert.equal(retry.attempt, 2);
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
      source: 'codex',
      sourceId: 'session-1',
      sessionId: 'session-1',
      title: 'Approve',
      prompt: 'Continue?',
    });
    assert.equal(store.getHumanAction('beta', handled.id), undefined);
    assert.equal(store.updateHumanAction('beta', handled.id, 1, { title: 'Nope' }), undefined);
    assert.equal(
      store.updateHumanAction('alpha', handled.id, 1, { title: 'Choose' })?.title,
      'Choose',
    );
    now = 200;
    const resolved = store.resolveHumanAction('alpha', handled.id, 2, { approved: true });
    assert.equal(resolved.status, 'handled');
    assert.equal(resolved.resolvedAt, 200);
    assert.deepEqual(resolved.result, { approved: true });
    assert.throws(() => store.ignoreHumanAction('alpha', handled.id, 3), /conflict/);

    const ignored = store.createHumanAction({
      wakerId: 'alpha',
      source: 'codex',
      sourceId: 'turn-1',
      sessionId: 'turn-1',
      title: 'Question',
      prompt: 'Answer?',
    });
    assert.equal(store.ignoreHumanAction('alpha', ignored.id, 1).status, 'ignored');
    assert.equal(store.listHumanActions('alpha', 'pending').length, 0);
    assert.equal(store.listHumanActions('beta').length, 0);
    assert.equal(store.deleteHumanAction('beta', ignored.id, 2), false);
    assert.equal(store.deleteHumanAction('alpha', ignored.id, 2), true);
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
    reopened.bindSessionContext({
      sessionId: 'orphan-alpha',
      wakerId: 'alpha',
      projectId: null,
      workingDirectory: null,
    });
    reopened.bindSessionContext({
      sessionId: 'keep-beta',
      wakerId: 'beta',
      projectId: null,
      workingDirectory: null,
    });
    assert.equal(reopened.deleteSessionContextsForWaker('alpha'), 1);
    assert.equal(reopened.getSessionContext('alpha', 'orphan-alpha'), undefined);
    assert.ok(reopened.getSessionContext('beta', 'keep-beta'));
    reopened.close();
  });
});
