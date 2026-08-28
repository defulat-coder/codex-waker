import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { HumanActionConflictError, TaskConflictError, WorkspaceStore } from './store.js';

describe('WorkspaceStore Board tasks', () => {
  it('upgrades cancelled legacy Tasks and Workflow snapshots whose Project was removed', () => {
    const root = mkdtempSync(join(tmpdir(), 'waker-board-migration-'));
    const path = join(root, 'workspace.sqlite');
    const db = new Database(path);
    db.pragma('foreign_keys = ON');
    db.exec(
      'CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)',
    );
    const migrations = join(dirname(fileURLToPath(import.meta.url)), '../migrations');
    for (const filename of [
      '001_workspace.sql',
      '002_runs.sql',
      '003_capabilities.sql',
      '004_automation_scheduling.sql',
      '005_automation_definition_context.sql',
      '006_workflow_definitions.sql',
      '007_workflow_recovery_index.sql',
    ]) {
      db.exec(readFileSync(join(migrations, filename), 'utf8'));
      db.prepare('INSERT INTO schema_migrations VALUES (?, 0)').run(filename.slice(0, 3));
    }
    db.prepare(
      `INSERT INTO tasks
       (id,title,type,status,waker_id,source,created_at,updated_at,completed_at)
       VALUES ('legacy-cancelled','Cancelled','workflow','cancelled','alpha','local',1,2,NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO workflows
       (id,name,description,script,status,version,created_at,updated_at,waker_id,project_id,
        definition,validation_errors)
       VALUES ('flow','Flow','Legacy snapshot','{}','active',1,1,2,'alpha','gone-project',
               '{"schemaVersion":1,"start":"done","nodes":[{"id":"done","kind":"terminal","status":"succeeded"}]}','[]')`,
    ).run();
    db.prepare(
      `INSERT INTO workflow_runs
       (id,workflow_id,workflow_version,name_snapshot,description_snapshot,script_snapshot,
        definition_snapshot,waker_id_snapshot,project_id_snapshot,depth,attempt,current_node_id,
        context,event_sequence,status,created_at,updated_at,completed_at)
       VALUES ('run','flow',1,'Flow','Legacy snapshot','{}',
               '{"schemaVersion":1,"start":"done","nodes":[{"id":"done","kind":"terminal","status":"succeeded"}]}',
               'alpha','gone-project',0,1,'done','{}',0,'succeeded',1,2,2)`,
    ).run();
    db.close();

    const store = new WorkspaceStore(path);
    assert.equal(store.getTask('alpha', 'legacy-cancelled')?.completedAt, 2);
    const migrated = store.getWorkflowRun('alpha', 'run')!;
    assert.equal(store.getTask('alpha', migrated.taskId)?.projectId, null);
    assert.equal(store.getTask('alpha', migrated.taskId)?.description, 'Legacy snapshot');
    assert.deepEqual(store.db.pragma('foreign_key_check'), []);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('filters, sorts and pages owner-scoped manual Tasks with CAS and timeline', () => {
    let now = 100;
    const store = new WorkspaceStore(':memory:', { now: () => now });
    const low = store.createTask({
      wakerId: 'alpha',
      title: 'Low task',
      description: 'searchable first',
      priority: 'low',
    });
    now = 200;
    const urgent = store.createTask({
      wakerId: 'alpha',
      title: 'Urgent task',
      description: 'searchable second',
      priority: 'urgent',
    });
    store.createTask({ wakerId: 'beta', title: 'Foreign task' });

    assert.deepEqual(
      store
        .queryTasks('alpha', { query: 'searchable', sort: 'priority_desc' })
        .items.map((task) => task.id),
      [urgent.id, low.id],
    );
    assert.equal(store.queryTasks('alpha', { limit: 1, offset: 1 }).items[0]?.id, low.id);
    assert.equal(store.queryTasks('alpha').total, 2);
    assert.equal(store.queryTasks('beta').total, 1);

    now = 300;
    const running = store.updateTask('alpha', low.id, {
      expectedVersion: 1,
      status: 'running',
      priority: 'high',
    })!;
    assert.equal(running.version, 2);
    assert.equal(running.startedAt, 300);
    assert.throws(
      () => store.updateTask('alpha', low.id, { expectedVersion: 1, title: 'stale' }),
      TaskConflictError,
    );
    now = 400;
    const completed = store.updateTask('alpha', low.id, {
      expectedVersion: 2,
      status: 'completed',
    })!;
    assert.equal(completed.completedAt, 400);
    assert.deepEqual(
      store.listTaskEvents('alpha', low.id).map((event) => event.type),
      ['created', 'updated', 'updated'],
    );
    assert.equal(store.getTaskDeleteImpact('alpha', low.id)?.events, 3);
    assert.equal(store.deleteTask('alpha', low.id, 3), true);
    assert.equal(store.getTask('alpha', low.id), undefined);
    store.close();
  });

  it('keeps Automation and Workflow projections derived and synchronized', () => {
    let now = 1_000;
    const store = new WorkspaceStore(':memory:', { now: () => now });
    const automation = store.createAutomation({
      wakerId: 'alpha',
      name: 'Automation',
      kind: 'api',
      prompt: 'Run',
    });
    const automationTask = store.runAutomation('alpha', automation.id);
    const automationRun = store.getAutomationRunByTask('alpha', automationTask.id)!;
    assert.equal(automationTask.origin, 'derived');
    assert.throws(
      () => store.updateTask('alpha', automationTask.id, { expectedVersion: 1, title: 'forged' }),
      /Derived/,
    );
    assert.throws(() => store.deleteTask('alpha', automationTask.id, 1), /Derived/);
    now = 1_100;
    store.startAutomationRun('alpha', automationRun.id);
    assert.equal(store.getTask('alpha', automationTask.id)?.status, 'running');
    now = 1_200;
    store.completeAutomationRun('alpha', automationRun.id, 'done');
    assert.equal(store.getTask('alpha', automationTask.id)?.status, 'completed');

    const workflow = store.createWorkflow({
      wakerId: 'alpha',
      name: 'Approval flow',
      status: 'active',
      definition: {
        schemaVersion: 1,
        start: 'ask',
        nodes: [
          { id: 'ask', kind: 'ask_user', prompt: 'Continue?', inputKey: 'answer', next: 'done' },
          { id: 'done', kind: 'terminal', status: 'succeeded' },
        ],
      },
    });
    const run = store.runWorkflow('alpha', workflow.id);
    assert.equal(store.getTask('alpha', run.taskId)?.status, 'queued');
    store.startWorkflowRun('alpha', run.id);
    store.waitForWorkflowInput(
      'alpha',
      run.id,
      { nodeId: 'ask', nextNodeId: 'done', context: {}, inputKey: 'answer' },
      { title: 'Approval flow', prompt: 'Continue?' },
    );
    const action = store.listHumanActions('alpha', 'pending')[0]!;
    assert.equal(action.taskId, run.taskId);
    assert.equal(action.kind, 'input');
    assert.equal(store.getTask('alpha', run.taskId)?.status, 'waiting');
    assert.throws(
      () => store.resumeWorkflowRun('alpha', run.id, 'yes', action.version + 1),
      HumanActionConflictError,
    );
    store.resumeWorkflowRun('alpha', run.id, 'yes', action.version);
    assert.equal(store.getTask('alpha', run.taskId)?.status, 'running');
    assert.equal(store.getHumanAction('alpha', action.id)?.version, 2);
    store.completeWorkflowRun('alpha', run.id, { accepted: true });
    assert.equal(store.getTask('alpha', run.taskId)?.status, 'completed');
    assert.ok(
      store
        .listTaskEvents('alpha', run.taskId)
        .some((event) => event.type === 'human_action.handled'),
    );

    const cancelledRun = store.runWorkflow('alpha', workflow.id);
    store.startWorkflowRun('alpha', cancelledRun.id);
    store.waitForWorkflowInput(
      'alpha',
      cancelledRun.id,
      { nodeId: 'ask', nextNodeId: 'done', context: {}, inputKey: 'answer' },
      { title: 'Approval flow', prompt: 'Continue?' },
    );
    const cancelledAction = store.listHumanActions('alpha', 'pending')[0]!;
    assert.throws(
      () => store.cancelWorkflowRun('alpha', cancelledRun.id, cancelledAction.version + 1),
      HumanActionConflictError,
    );
    store.cancelWorkflowRun('alpha', cancelledRun.id, cancelledAction.version);
    assert.equal(store.getHumanAction('alpha', cancelledAction.id)?.version, 2);
    assert.equal(store.getTask('alpha', cancelledRun.taskId)?.status, 'cancelled');
    store.close();
  });

  it('enforces one pending Action per source and soft-deletes all Board state for a Waker', () => {
    const store = new WorkspaceStore(':memory:');
    const task = store.createTask({ wakerId: 'alpha', title: 'Manual' });
    const action = store.createHumanAction({
      wakerId: 'alpha',
      source: 'codex',
      sourceId: 'session-one',
      sessionId: 'session-one',
      taskId: task.id,
      title: 'Confirm',
      prompt: 'Continue?',
    });
    assert.throws(
      () =>
        store.createHumanAction({
          wakerId: 'alpha',
          source: 'codex',
          sourceId: 'session-one',
          sessionId: 'session-one',
          title: 'Duplicate',
          prompt: 'Continue?',
        }),
      /UNIQUE/,
    );
    assert.throws(
      () => store.resolveHumanAction('alpha', action.id, action.version + 1, true),
      HumanActionConflictError,
    );
    const removed = store.softDeleteBoardDataForWaker('alpha');
    assert.deepEqual(removed, { tasks: 1, humanActions: 1 });
    assert.equal(store.queryTasks('alpha').total, 0);
    assert.equal(store.queryHumanActions('alpha').total, 0);
    store.close();
  });
});
