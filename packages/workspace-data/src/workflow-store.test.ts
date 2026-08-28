import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { WorkspaceStore, WorkflowConflictError } from './store.js';
import type { WorkflowDefinition } from './workflow.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function definition(prompt = 'Summarize'): WorkflowDefinition {
  return {
    schemaVersion: 1,
    start: 'codex',
    nodes: [
      { id: 'codex', kind: 'codex', prompt, outputKey: 'answer', next: 'done' },
      { id: 'done', kind: 'terminal', status: 'succeeded' },
    ],
  };
}

function databasePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'waker-workflow-'));
  roots.push(root);
  return join(root, 'workspace.sqlite');
}

describe('WorkspaceStore workflow definitions', () => {
  it('keeps owner-scoped immutable versions with optimistic preview, diff and rollback', () => {
    const path = databasePath();
    let now = 1_000;
    const options = {
      now: () => now,
      resolveWorkflowReference: (reference: { kind: string; id: string }) =>
        reference.kind !== 'waker' || reference.id === 'alpha',
    };
    const store = new WorkspaceStore(path, options);
    const workflow = store.createWorkflow({
      wakerId: 'alpha',
      name: 'Summary',
      description: 'v1',
      model: 'model-a',
      thinking: 'high',
      definition: definition('one'),
      status: 'active',
    });
    assert.equal(workflow.version, 1);
    assert.equal(store.getWorkflow('beta', workflow.id), undefined);
    assert.equal(store.listWorkflowVersions('alpha', workflow.id).length, 1);

    const dryRun = store.previewWorkflowUpdate('alpha', workflow.id, {
      expectedVersion: 1,
      description: 'v2',
      definition: definition('two'),
    })!;
    assert.equal(dryRun.applied, false);
    assert.match(dryRun.diff, /-\s+"description": "v1"/);
    assert.match(dryRun.diff, /\+\s+"description": "v2"/);
    assert.equal(store.getWorkflow('alpha', workflow.id)?.version, 1);

    now = 2_000;
    const updated = store.updateWorkflow('alpha', workflow.id, {
      expectedVersion: 1,
      description: 'v2',
      definition: definition('two'),
    })!;
    assert.equal(updated.version, 2);
    assert.equal(store.listWorkflowVersions('alpha', workflow.id)[0]?.operation, 'update');
    assert.match(store.diffWorkflowVersions('alpha', workflow.id, 1, 2)!, /Summarize|one|two/);

    const secondConnection = new WorkspaceStore(path, options);
    assert.throws(
      () =>
        secondConnection.updateWorkflow('alpha', workflow.id, {
          expectedVersion: 1,
          name: 'stale',
        }),
      WorkflowConflictError,
    );

    const rollbackPreview = store.rollbackWorkflow('alpha', workflow.id, {
      targetVersion: 1,
      expectedVersion: 2,
    })!;
    assert.equal(rollbackPreview.applied, false);
    assert.equal(store.listWorkflowVersions('alpha', workflow.id).length, 2);
    const rolledBack = store.rollbackWorkflow('alpha', workflow.id, {
      targetVersion: 1,
      expectedVersion: 2,
      apply: true,
    })!;
    assert.equal(rolledBack.workflow.version, 3);
    assert.equal(rolledBack.workflow.description, 'v1');
    assert.equal(store.listWorkflowVersions('alpha', workflow.id)[0]?.operation, 'rollback');
    assert.throws(
      () =>
        store.db
          .prepare('UPDATE workflow_versions SET name_snapshot=? WHERE workflow_id=? AND version=1')
          .run('mutated', workflow.id),
      /immutable/,
    );
    secondConnection.close();
    store.close();
  });

  it('validates same-owner project/call references and reports soft-delete impact', () => {
    const store = new WorkspaceStore(':memory:');
    const project = store.createProject({
      wakerId: 'alpha',
      visibility: 'private',
      name: 'Owned',
      description: '',
      source: 'filesystem',
      status: 'ready',
    });
    const child = store.createWorkflow({
      wakerId: 'alpha',
      projectId: project.id,
      name: 'Child',
      definition: definition(),
      status: 'active',
    });
    const parent = store.createWorkflow({
      wakerId: 'alpha',
      name: 'Parent',
      definition: {
        schemaVersion: 1,
        start: 'call',
        nodes: [
          { id: 'call', kind: 'call_workflow', workflowId: child.id, next: 'done' },
          { id: 'done', kind: 'terminal', status: 'succeeded' },
        ],
      },
    });
    assert.throws(
      () =>
        store.updateWorkflow('alpha', child.id, {
          expectedVersion: 1,
          definition: {
            schemaVersion: 1,
            start: 'call',
            nodes: [
              { id: 'call', kind: 'call_workflow', workflowId: parent.id, next: 'done' },
              { id: 'done', kind: 'terminal', status: 'succeeded' },
            ],
          },
        }),
      /cycle/,
    );
    assert.deepEqual(store.getWorkflowDeleteImpact('alpha', child.id)?.referencedBy, [parent.id]);
    assert.equal(
      store.validateWorkflow('alpha', {
        schemaVersion: 1,
        start: 'call',
        nodes: [
          { id: 'call', kind: 'call_workflow', workflowId: 'missing', next: 'done' },
          { id: 'done', kind: 'terminal', status: 'succeeded' },
        ],
      }).valid,
      false,
    );
    assert.throws(() => store.deleteWorkflow('alpha', child.id, 1), /referenced/);
    const parentVersion = store.updateWorkflow('alpha', parent.id, {
      expectedVersion: 1,
      definition: definition(),
    })!.version;
    assert.equal(store.deleteWorkflow('alpha', parent.id, parentVersion), true);
    assert.equal(store.getWorkflow('alpha', parent.id), undefined);
    assert.equal(
      (
        store.db
          .prepare('SELECT COUNT(*) AS count FROM workflow_versions WHERE workflow_id=?')
          .get(parent.id) as { count: number }
      ).count,
      2,
    );
    assert.throws(
      () =>
        store.createWorkflow({
          wakerId: 'beta',
          projectId: project.id,
          name: 'Wrong owner',
          definition: definition(),
        }),
      /owner project/,
    );
    const run = store.runWorkflow('alpha', child.id);
    assert.equal(store.getProjectDeleteImpact('alpha', project.id)?.workflowDefinitions, 1);
    assert.equal(store.getProjectDeleteImpact('alpha', project.id)?.workflowRuns, 1);
    assert.throws(() => store.deleteProject('alpha', project.id), /active workflow run/);
    store.cancelWorkflowRun('alpha', run.id);
    assert.equal(store.deleteProject('alpha', project.id), true);
    assert.equal(store.getWorkflow('alpha', child.id)?.projectId, null);
    assert.equal(store.getWorkflow('alpha', child.id)?.status, 'paused');
    assert.equal(store.getWorkflowRun('alpha', run.id)?.projectId, project.id);
    store.close();
  });

  it('keeps active run snapshot call dependencies protected from deletion', () => {
    const store = new WorkspaceStore(':memory:');
    const child = store.createWorkflow({
      wakerId: 'alpha',
      name: 'Child',
      status: 'active',
      definition: definition(),
    });
    const parent = store.createWorkflow({
      wakerId: 'alpha',
      name: 'Parent',
      status: 'active',
      definition: {
        schemaVersion: 1,
        start: 'call',
        nodes: [
          { id: 'call', kind: 'call_workflow', workflowId: child.id, next: 'done' },
          { id: 'done', kind: 'terminal', status: 'succeeded' },
        ],
      },
    });
    const parentRun = store.runWorkflow('alpha', parent.id);
    store.updateWorkflow('alpha', parent.id, {
      expectedVersion: 1,
      definition: definition('No current child reference'),
    });

    assert.deepEqual(store.getWorkflowDeleteImpact('alpha', child.id)?.referencedBy, [parent.id]);
    assert.throws(() => store.deleteWorkflow('alpha', child.id, 1), /referenced/);

    store.cancelWorkflowRun('alpha', parentRun.id);
    assert.equal(store.getWorkflowDeleteImpact('alpha', child.id)?.referencedBy.length, 0);
    assert.equal(store.deleteWorkflow('alpha', child.id, 1), true);
    store.close();
  });

  it('quarantines legacy scripts and migrates active legacy runs without broken foreign keys', () => {
    const path = databasePath();
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
    ]) {
      db.exec(readFileSync(join(migrations, filename), 'utf8'));
      db.prepare('INSERT INTO schema_migrations VALUES (?,0)').run(filename.slice(0, 3));
    }
    db.prepare(
      `INSERT INTO workflows
       (id,name,description,script,status,version,created_at,updated_at)
       VALUES ('legacy','Legacy','','run()', 'active',1,100,100)`,
    ).run();
    db.prepare(
      `INSERT INTO workflow_runs
       (id,workflow_id,workflow_version,name_snapshot,description_snapshot,script_snapshot,
        status,created_at,updated_at,started_at)
       VALUES ('legacy-run','legacy',1,'Legacy','','run()','waiting_input',110,120,110)`,
    ).run();
    db.prepare(
      `INSERT INTO workflow_run_events (run_id,sequence,type,payload,created_at)
       VALUES ('legacy-run',1,'waiting_input','{}',120)`,
    ).run();
    db.close();

    const store = new WorkspaceStore(path);
    const legacy = store.getWorkflow('__legacy_unbound__', 'legacy')!;
    assert.equal(legacy.status, 'error');
    assert.equal(legacy.definition, null);
    assert.match(legacy.validationErrors.join(' '), /not bound|not a valid/);
    assert.equal(store.getWorkflowRun('__legacy_unbound__', 'legacy-run')?.status, 'cancelled');
    assert.equal(store.listWorkflowRunEvents('__legacy_unbound__', 'legacy-run').length, 1);
    assert.deepEqual(store.db.pragma('foreign_key_check'), []);
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
  });
});
