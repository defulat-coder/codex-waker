import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { AgentSessionStore } from '@waker/codex-runtime';
import { WorkspaceStore, type AutomationRun, type Project } from '@waker/workspace-data';
import {
  AutomationExecutor,
  automationPrompt,
  type AutomationExecutionStore,
} from './automation-executor.js';

type TestRun = AutomationRun & {
  promptSnapshot: string;
  projectId: string | null;
  sessionId: string | null;
  model: string | null;
  thinking: 'medium' | null;
  result?: string | null;
  usage?: unknown;
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function testRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'waker-automation-executor-'));
  roots.push(root);
  return root;
}

function run(overrides: Partial<TestRun> = {}): TestRun {
  return {
    id: 'run-1',
    automationId: 'automation-1',
    taskId: 'task-1',
    wakerId: 'agent-one',
    status: 'queued',
    trigger: 'manual',
    scheduledFor: null,
    nameSnapshot: 'Automation',
    input: undefined,
    output: undefined,
    result: undefined,
    usage: undefined,
    error: null,
    attempt: 1,
    retryOfRunId: null,
    createdAt: 1,
    updatedAt: 1,
    startedAt: null,
    completedAt: null,
    promptSnapshot: 'Summarize <unsafe> & finish',
    projectId: null,
    sessionId: null,
    model: null,
    thinking: null,
    ...overrides,
  };
}

class FakeStore implements AutomationExecutionStore {
  readonly runs = new Map<string, TestRun>();
  readonly projects = new Map<string, Project>();

  constructor(value: TestRun) {
    this.runs.set(value.id, value);
  }

  getAutomationRun(wakerId: string, runId: string): TestRun | undefined {
    const value = this.runs.get(runId);
    return value?.wakerId === wakerId ? value : undefined;
  }

  listAutomationRuns(wakerId: string): TestRun[] {
    return [...this.runs.values()].filter((value) => value.wakerId === wakerId);
  }

  listRecoverableAutomationRuns(wakerId: string): TestRun[] {
    return this.listAutomationRuns(wakerId).filter(
      (value) => value.status === 'queued' || value.status === 'running',
    );
  }

  getOwnedProject(wakerId: string, projectId: string): Project | undefined {
    const value = this.projects.get(projectId);
    return value?.wakerId === wakerId ? value : undefined;
  }

  attachAutomationRunSession(wakerId: string, runId: string, sessionId: string): TestRun {
    return this.patch(wakerId, runId, { sessionId });
  }

  clearAutomationRunSession(wakerId: string, runId: string, sessionId: string): TestRun {
    const current = this.getAutomationRun(wakerId, runId);
    if (current?.sessionId !== sessionId) throw new Error('session mismatch');
    return this.patch(wakerId, runId, { sessionId: null });
  }

  bindSessionContext(): void {}
  deleteSessionContext(): boolean {
    return true;
  }

  startAutomationRun(wakerId: string, runId: string): TestRun {
    return this.patch(wakerId, runId, { status: 'running', startedAt: 2 });
  }

  completeAutomationRun(wakerId: string, runId: string, result: string, usage?: unknown): TestRun {
    return this.patch(wakerId, runId, {
      status: 'succeeded',
      result,
      usage,
      output: result,
      completedAt: 3,
    });
  }

  failAutomationRun(wakerId: string, runId: string, error: string): TestRun {
    return this.patch(wakerId, runId, { status: 'failed', error, completedAt: 3 });
  }

  cancelAutomationRun(wakerId: string, runId: string): TestRun {
    return this.patch(wakerId, runId, { status: 'cancelled', completedAt: 3 });
  }

  private patch(wakerId: string, runId: string, patch: Partial<TestRun>): TestRun {
    const current = this.getAutomationRun(wakerId, runId);
    if (!current) throw new Error('Automation run not found');
    const next = { ...current, ...patch };
    this.runs.set(runId, next);
    return next;
  }
}

function sessions(deleted: string[] = []): AgentSessionStore {
  return {
    createSession: async (agentId: string) => ({ id: 'session-run-1', agentId }),
    renameSession: async () => undefined,
    deleteSession: async (sessionId: string) => {
      deleted.push(sessionId);
      return true;
    },
  } as unknown as AgentSessionStore;
}

describe('AutomationExecutor', () => {
  it('drives a durable WorkspaceStore run and its linked task to completion', async () => {
    const root = testRoot();
    const store = new WorkspaceStore(join(root, 'workspace.sqlite'));
    const automation = store.createAutomation({
      wakerId: 'agent-one',
      name: 'Nightly check',
      kind: 'api',
      prompt: 'Check status',
    });
    const queued = store.enqueueAutomationRun('agent-one', automation.id, {
      trigger: 'manual',
      thinking: 'medium',
    });
    const executor = new AutomationExecutor({
      cwd: root,
      store,
      sessions: sessions(),
      runTurn: async () => ({
        answer: 'All clear',
        thinkingText: '',
        usage: { input: 3, output: 2, total: 5 },
      }),
    });

    executor.enqueue('agent-one', queued.id);
    await executor.waitForIdle();

    const completed = store.getAutomationRun('agent-one', queued.id)!;
    assert.equal(completed.status, 'succeeded', completed.error ?? 'unexpected run state');
    assert.equal(completed.result, 'All clear');
    assert.deepEqual(completed.usage, { input: 3, output: 2, total: 5 });
    assert.equal(store.getTask('agent-one', queued.taskId)?.status, 'completed');
    store.close();
  });

  it('creates an isolated session, escapes the prompt and persists result plus usage', async () => {
    const root = testRoot();
    mkdirSync(join(root, 'project'));
    const value = run({ projectId: 'project-1', model: 'model-a', thinking: 'medium' });
    const store = new FakeStore(value);
    store.projects.set('project-1', {
      id: 'project-1',
      visibility: 'private',
      wakerId: 'agent-one',
      name: 'Project',
      description: '',
      path: 'project',
      source: 'filesystem',
      status: 'ready',
      error: null,
      createdAt: 1,
      updatedAt: 1,
    });
    const executor = new AutomationExecutor({
      cwd: root,
      store,
      sessions: sessions(),
      runTurn: async (agentId, sessionId, prompt, options) => {
        assert.equal(agentId, 'agent-one');
        assert.equal(sessionId, 'session-run-1');
        assert.equal(options?.workingDirectory, realpathSync(join(root, 'project')));
        assert.equal(options?.model, 'model-a');
        assert.equal(options?.reasoningEffort, 'medium');
        assert.match(prompt, /Summarize &lt;unsafe&gt; &amp; finish/);
        assert.doesNotMatch(prompt, /<unsafe>/);
        return {
          answer: `Finished in ${join(root, 'project')}`,
          thinkingText: '',
          usage: { input: 4, output: 2, total: 6 },
        };
      },
    });

    executor.enqueue('agent-one', value.id);
    await executor.waitForIdle();

    const completed = store.getAutomationRun('agent-one', value.id)!;
    assert.equal(completed.status, 'succeeded', completed.error ?? 'unexpected run state');
    assert.equal(completed.sessionId, 'session-run-1');
    assert.equal(completed.result, 'Finished in ./project');
    assert.equal(String(completed.result).includes(root), false);
    assert.deepEqual(completed.usage, { input: 4, output: 2, total: 6 });
  });

  it('keeps cancellation terminal when abort rejects the active Codex turn', async () => {
    const root = testRoot();
    const value = run();
    const store = new FakeStore(value);
    let rejectTurn!: (error: Error) => void;
    const executor = new AutomationExecutor({
      cwd: root,
      store,
      sessions: sessions(),
      runTurn: () =>
        new Promise((_resolve, reject) => {
          rejectTurn = reject;
        }),
      abortTurn: async () => rejectTurn(new Error('aborted')),
    });

    executor.enqueue('agent-one', value.id);
    await new Promise((resolve) => setImmediate(resolve));
    const cancelled = await executor.cancel('agent-one', value.id);
    await executor.waitForIdle();

    assert.equal(cancelled.status, 'cancelled');
    assert.equal(store.getAutomationRun('agent-one', value.id)?.status, 'cancelled');
  });

  it('fails before creating a session when project ownership is invalid', async () => {
    const root = testRoot();
    const value = run({ projectId: 'foreign-project' });
    const store = new FakeStore(value);
    let created = false;
    const executor = new AutomationExecutor({
      cwd: root,
      store,
      sessions: {
        createSession: async () => {
          created = true;
          throw new Error('must not run');
        },
        renameSession: async () => undefined,
      } as unknown as AgentSessionStore,
      runTurn: async () => ({ answer: 'no', thinkingText: '' }),
    });

    executor.enqueue('agent-one', value.id);
    await executor.waitForIdle();

    assert.equal(created, false);
    assert.equal(store.getAutomationRun('agent-one', value.id)?.status, 'failed');
    assert.match(store.getAutomationRun('agent-one', value.id)?.error ?? '', /another Waker/);
  });

  it('compensates a session when workspace context binding fails', async () => {
    const root = testRoot();
    const value = run();
    const store = new FakeStore(value);
    store.bindSessionContext = () => {
      throw new Error('context database failed');
    };
    const deleted: string[] = [];
    const executor = new AutomationExecutor({
      cwd: root,
      store,
      sessions: sessions(deleted),
      runTurn: async () => ({ answer: 'no', thinkingText: '' }),
    });

    executor.enqueue('agent-one', value.id);
    await executor.waitForIdle();

    assert.equal(store.getAutomationRun('agent-one', value.id)?.status, 'failed');
    assert.equal(store.getAutomationRun('agent-one', value.id)?.sessionId, null);
    assert.deepEqual(deleted, ['session-run-1']);
  });

  it('persists the run-to-session link before awaiting later session preparation', async () => {
    const root = testRoot();
    const value = run();
    const store = new FakeStore(value);
    let renameStarted!: () => void;
    let releaseRename!: () => void;
    const started = new Promise<void>((resolve) => {
      renameStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseRename = resolve;
    });
    const sessionStore = sessions();
    sessionStore.renameSession = async () => {
      renameStarted();
      await gate;
      return undefined;
    };
    const executor = new AutomationExecutor({
      cwd: root,
      store,
      sessions: sessionStore,
      runTurn: async () => ({ answer: 'done', thinkingText: '' }),
    });

    executor.enqueue('agent-one', value.id);
    await started;
    assert.equal(store.getAutomationRun('agent-one', value.id)?.sessionId, 'session-run-1');
    releaseRename();
    await executor.waitForIdle();
    assert.equal(store.getAutomationRun('agent-one', value.id)?.status, 'succeeded');
  });

  it('recovers durable queued runs and marks previous-process running work interrupted', async () => {
    const root = testRoot();
    const queued = run({ id: 'queued-run' });
    const store = new FakeStore(queued);
    store.runs.set(
      'stale-run',
      run({ id: 'stale-run', status: 'running', startedAt: 1, sessionId: 'stale-session' }),
    );
    const executor = new AutomationExecutor({
      cwd: root,
      store,
      sessions: sessions(),
      runTurn: async () => ({ answer: 'Recovered', thinkingText: '' }),
    });

    executor.recover(['agent-one']);
    await executor.waitForIdle();

    assert.equal(store.getAutomationRun('agent-one', 'queued-run')?.status, 'succeeded');
    assert.equal(store.getAutomationRun('agent-one', 'stale-run')?.status, 'failed');
    assert.equal(store.getAutomationRun('agent-one', 'stale-run')?.sessionId, 'stale-session');
    assert.match(store.getAutomationRun('agent-one', 'stale-run')?.error ?? '', /restart/);
  });

  it('records host shutdown as interruption instead of user cancellation', async () => {
    const root = testRoot();
    const value = run();
    const store = new FakeStore(value);
    let rejectTurn!: (error: Error) => void;
    const executor = new AutomationExecutor({
      cwd: root,
      store,
      sessions: sessions(),
      runTurn: () =>
        new Promise((_resolve, reject) => {
          rejectTurn = reject;
        }),
      abortTurn: async () => rejectTurn(new Error('aborted')),
    });

    executor.enqueue('agent-one', value.id);
    await new Promise((resolve) => setImmediate(resolve));
    await executor.close();

    assert.equal(store.getAutomationRun('agent-one', value.id)?.status, 'failed');
    assert.match(store.getAutomationRun('agent-one', value.id)?.error ?? '', /shutdown/);
  });
});

describe('automationPrompt', () => {
  it('drops control characters, escapes XML and rejects empty or oversized prompts', () => {
    assert.match(automationPrompt('go\u0000 <now>'), /go &lt;now&gt;/);
    assert.throws(() => automationPrompt('\u0000\n'), /empty/);
    assert.throws(() => automationPrompt('x'.repeat(20_001)), /20000/);
  });
});
