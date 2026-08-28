import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { AgentSessionStore } from '@waker/codex-runtime';
import { WorkspaceStore } from '@waker/workspace-data';
import { WorkflowExecutor, workflowPrompt } from './workflow-executor.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'waker-workflow-executor-'));
  roots.push(value);
  return value;
}

function sessions(created: string[] = []): AgentSessionStore {
  return {
    createSession: async (agentId: string) => {
      const id = `session-${created.length + 1}`;
      created.push(id);
      return { id, agentId };
    },
    renameSession: async () => undefined,
    deleteSession: async () => true,
  } as unknown as AgentSessionStore;
}

describe('WorkflowExecutor', () => {
  it('uses one persistent Session across Codex nodes, snapshots defaults and redacts output', async () => {
    const cwd = root();
    const store = new WorkspaceStore(join(cwd, 'workspace.sqlite'));
    const workflow = store.createWorkflow({
      wakerId: 'agent-one',
      name: 'Review',
      model: 'snapshot-model',
      thinking: 'high',
      status: 'active',
      definition: {
        schemaVersion: 1,
        start: 'set',
        nodes: [
          { id: 'set', kind: 'action', action: 'set', key: 'mode', value: 'go', next: 'branch' },
          {
            id: 'branch',
            kind: 'decision',
            key: 'mode',
            branches: [{ equals: 'go', next: 'first' }],
            defaultNext: 'failed',
          },
          {
            id: 'first',
            kind: 'codex',
            prompt: 'Inspect <unsafe> {{input.topic}}',
            outputKey: 'first',
            next: 'second',
          },
          {
            id: 'second',
            kind: 'codex',
            prompt: 'Continue from {{first}}',
            outputKey: 'answer',
            next: 'done',
          },
          { id: 'failed', kind: 'terminal', status: 'failed', output: 'wrong branch' },
          { id: 'done', kind: 'terminal', status: 'succeeded', output: '{{answer}}' },
        ],
      },
    });
    const run = store.runWorkflow('agent-one', workflow.id, { topic: 'security' });
    const created: string[] = [];
    const calls: string[] = [];
    const executor = new WorkflowExecutor({
      cwd,
      store,
      sessions: sessions(created),
      runTurn: async (agentId, sessionId, prompt, options) => {
        assert.equal(agentId, 'agent-one');
        assert.equal(sessionId, 'session-1');
        assert.equal(options?.model, 'snapshot-model');
        assert.equal(options?.reasoningEffort, 'high');
        assert.doesNotMatch(prompt, /<unsafe>/);
        calls.push(prompt);
        return {
          answer: calls.length === 1 ? 'first answer' : `finished at ${cwd}/private`,
          thinkingText: '',
          usage: { input: 2, output: 3, total: 5 },
        };
      },
    });

    executor.enqueue('agent-one', run.id);
    await executor.waitForIdle();

    const completed = store.getWorkflowRun('agent-one', run.id)!;
    assert.equal(completed.status, 'succeeded', completed.error ?? 'unexpected run state');
    assert.equal(String(completed.output).includes(cwd), false);
    assert.deepEqual(completed.usage, { input: 4, output: 6, total: 10 });
    assert.deepEqual(created, ['session-1']);
    assert.equal(calls.length, 2);
    const events = store.getWorkflowRunTrace('agent-one', run.id).events;
    assert.deepEqual(
      events.map((event) => event.sequence),
      events.map((_event, index) => index + 1),
    );
    assert.equal(events.filter((event) => event.type === 'checkpoint').length, 4);
    store.close();
  });

  it('parks ask_user as one Human Action and resumes it exactly once', async () => {
    const cwd = root();
    const store = new WorkspaceStore(join(cwd, 'workspace.sqlite'));
    const workflow = store.createWorkflow({
      wakerId: 'agent-one',
      name: 'Approval',
      status: 'active',
      definition: {
        schemaVersion: 1,
        start: 'ask',
        nodes: [
          { id: 'ask', kind: 'ask_user', prompt: 'Approve?', inputKey: 'answer', next: 'done' },
          { id: 'done', kind: 'terminal', status: 'succeeded', output: '{{answer}}' },
        ],
      },
    });
    const run = store.runWorkflow('agent-one', workflow.id);
    const executor = new WorkflowExecutor({ cwd, store, sessions: sessions() });
    executor.enqueue('agent-one', run.id);
    await executor.waitForIdle();
    assert.equal(store.getWorkflowRun('agent-one', run.id)?.status, 'waiting_input');
    assert.equal(store.listHumanActions('agent-one', 'pending').length, 1);

    const action = store.listHumanActions('agent-one', 'pending')[0]!;
    await assert.rejects(
      () => executor.resume('agent-one', run.id, { approved: false }, action.version + 1),
      /version conflict/,
    );
    await executor.resume('agent-one', run.id, { approved: true }, action.version);
    await executor.waitForIdle();
    assert.deepEqual(store.getWorkflowRun('agent-one', run.id)?.output, { approved: true });
    assert.equal(store.listHumanActions('agent-one', 'handled').length, 1);
    await assert.rejects(() => executor.resume('agent-one', run.id, false), /not asking/);
    store.close();
  });

  it('recovers a due timed pause and finishes without browser-driven state changes', async () => {
    const cwd = root();
    let now = 100;
    let wake: (() => void) | undefined;
    const store = new WorkspaceStore(join(cwd, 'workspace.sqlite'), { now: () => now });
    const workflow = store.createWorkflow({
      wakerId: 'agent-one',
      name: 'Delay',
      status: 'active',
      definition: {
        schemaVersion: 1,
        start: 'wait',
        nodes: [
          { id: 'wait', kind: 'wait', durationMs: 50, next: 'done' },
          { id: 'done', kind: 'terminal', status: 'succeeded', output: 'awake' },
        ],
      },
    });
    const run = store.runWorkflow('agent-one', workflow.id);
    const executor = new WorkflowExecutor({
      cwd,
      store,
      sessions: sessions(),
      now: () => now,
      setTimer: (callback) => {
        wake = callback;
        return {} as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => undefined,
    });
    executor.enqueue('agent-one', run.id);
    await executor.waitForIdle();
    assert.equal(store.getWorkflowRun('agent-one', run.id)?.status, 'paused');
    now = 150;
    wake?.();
    await executor.waitForIdle();
    assert.equal(store.getWorkflowRun('agent-one', run.id)?.status, 'succeeded');
    store.close();
  });

  it('runs call_workflow as an isolated child and atomically resumes its parent', async () => {
    const cwd = root();
    const store = new WorkspaceStore(join(cwd, 'workspace.sqlite'));
    const child = store.createWorkflow({
      wakerId: 'agent-one',
      name: 'Child',
      status: 'active',
      definition: {
        schemaVersion: 1,
        start: 'set',
        nodes: [
          {
            id: 'set',
            kind: 'action',
            action: 'set',
            key: 'value',
            value: 'child-result',
            next: 'done',
          },
          { id: 'done', kind: 'terminal', status: 'succeeded', output: '{{value}}' },
        ],
      },
    });
    const parent = store.createWorkflow({
      wakerId: 'agent-one',
      name: 'Parent',
      status: 'active',
      definition: {
        schemaVersion: 1,
        start: 'call',
        nodes: [
          {
            id: 'call',
            kind: 'call_workflow',
            workflowId: child.id,
            outputKey: 'child',
            next: 'done',
          },
          { id: 'done', kind: 'terminal', status: 'succeeded', output: '{{child}}' },
        ],
      },
    });
    const run = store.runWorkflow('agent-one', parent.id);
    const created: string[] = [];
    const executor = new WorkflowExecutor({ cwd, store, sessions: sessions(created) });
    executor.enqueue('agent-one', run.id);
    await executor.waitForIdle();

    const completed = store.getWorkflowRun('agent-one', run.id)!;
    const childRun = store.listWorkflowRuns('agent-one', child.id)[0]!;
    assert.equal(completed.status, 'succeeded', completed.error ?? 'parent failed');
    assert.equal(completed.output, 'child-result');
    assert.equal(childRun.parentRunId, run.id);
    assert.equal(childRun.parentNodeId, 'call');
    assert.equal(childRun.depth, 1);
    assert.equal(childRun.status, 'succeeded');
    assert.equal(created.length, 2);
    assert.ok(
      store
        .getWorkflowRunTrace('agent-one', run.id)
        .events.some((event) => event.type === 'waiting_child'),
    );
    store.close();
  });

  it('keeps cancellation terminal when an active Codex turn rejects during abort', async () => {
    const cwd = root();
    const store = new WorkspaceStore(join(cwd, 'workspace.sqlite'));
    const workflow = store.createWorkflow({
      wakerId: 'agent-one',
      name: 'Cancelable',
      status: 'active',
      definition: {
        schemaVersion: 1,
        start: 'work',
        nodes: [
          { id: 'work', kind: 'codex', prompt: 'Wait', next: 'done' },
          { id: 'done', kind: 'terminal', status: 'succeeded' },
        ],
      },
    });
    const run = store.runWorkflow('agent-one', workflow.id);
    let started!: () => void;
    let rejectTurn!: (error: Error) => void;
    const turnStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const executor = new WorkflowExecutor({
      cwd,
      store,
      sessions: sessions(),
      runTurn: () =>
        new Promise((_resolve, reject) => {
          rejectTurn = reject;
          started();
        }),
      abortTurn: async () => rejectTurn(new Error('aborted')),
    });
    executor.enqueue('agent-one', run.id);
    await turnStarted;
    assert.equal((await executor.cancel('agent-one', run.id)).status, 'cancelled');
    await executor.waitForIdle();
    assert.equal(store.getWorkflowRun('agent-one', run.id)?.status, 'cancelled');
    assert.equal(store.getWorkflowRun('agent-one', run.id)?.error, null);
    store.close();
  });

  it('recovers queued work but fails an ambiguous running node explicitly', async () => {
    const cwd = root();
    const store = new WorkspaceStore(join(cwd, 'workspace.sqlite'));
    const workflow = store.createWorkflow({
      wakerId: 'agent-one',
      name: 'Recovery',
      status: 'active',
      definition: {
        schemaVersion: 1,
        start: 'done',
        nodes: [{ id: 'done', kind: 'terminal', status: 'succeeded', output: 'ok' }],
      },
    });
    const queued = store.runWorkflow('agent-one', workflow.id);
    store.cancelWorkflowRun('agent-one', queued.id);
    const retry = store.retryWorkflowRun('agent-one', queued.id);
    const staleDefinition = store.createWorkflow({
      wakerId: 'agent-one',
      name: 'Stale',
      status: 'active',
      definition: {
        schemaVersion: 1,
        start: 'done',
        nodes: [{ id: 'done', kind: 'terminal', status: 'succeeded' }],
      },
    });
    const stale = store.runWorkflow('agent-one', staleDefinition.id);
    store.startWorkflowRun('agent-one', stale.id);
    const executor = new WorkflowExecutor({ cwd, store, sessions: sessions() });
    executor.recover(['agent-one']);
    await executor.waitForIdle();
    assert.equal(store.getWorkflowRun('agent-one', retry.id)?.status, 'succeeded');
    assert.equal(store.getWorkflowRun('agent-one', stale.id)?.status, 'failed');
    assert.match(store.getWorkflowRun('agent-one', stale.id)?.error ?? '', /host restart/);
    store.close();
  });

  it('does not execute a row already claimed by another executor', async () => {
    const cwd = root();
    const store = new WorkspaceStore(join(cwd, 'workspace.sqlite'));
    const workflow = store.createWorkflow({
      wakerId: 'agent-one',
      name: 'Single claim',
      status: 'active',
      definition: {
        schemaVersion: 1,
        start: 'done',
        nodes: [{ id: 'done', kind: 'terminal', status: 'succeeded' }],
      },
    });
    const run = store.runWorkflow('agent-one', workflow.id);
    const created: string[] = [];
    const first = new WorkflowExecutor({ cwd, store, sessions: sessions(created) });
    const second = new WorkflowExecutor({ cwd, store, sessions: sessions(created) });
    first.enqueue('agent-one', run.id);
    second.enqueue('agent-one', run.id);
    await Promise.all([first.waitForIdle(), second.waitForIdle()]);
    assert.equal(store.getWorkflowRun('agent-one', run.id)?.status, 'succeeded');
    assert.deepEqual(created, ['session-1']);
    store.close();
  });

  it('escapes workflow prompt framing', () => {
    const prompt = workflowPrompt('Use <tag> & {{input.value}}', { input: { value: 'safe' } });
    assert.match(prompt, /data-waker-host="workflow-v1"/);
    assert.match(prompt, /Use &lt;tag&gt; &amp; safe/);
    assert.doesNotMatch(prompt, /<tag>/);
  });
});
