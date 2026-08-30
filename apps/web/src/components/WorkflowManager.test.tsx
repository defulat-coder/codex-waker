import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  LocalResourcesResponse,
  WakerWorkflow,
  WakerWorkflowSummary,
  WorkflowRunRecord,
  WorkflowVersionRecord,
} from '@waker/contracts';
import { parseWorkflowDefinition, WorkflowManager } from './WorkflowManager.js';

const originalFetch = globalThis.fetch;

const DEFINITION = {
  schemaVersion: 1 as const,
  start: 'ask',
  nodes: [
    { id: 'ask', kind: 'ask_user' as const, prompt: '请输入主题', inputKey: 'topic', next: 'done' },
    { id: 'done', kind: 'terminal' as const, status: 'succeeded' as const, output: 'ok' },
  ],
};

const SUMMARY: WakerWorkflowSummary = {
  id: 'workflow-one',
  wakerId: 'waker-one',
  name: '人工审核流程',
  description: '等待本地输入后继续',
  status: 'active',
  version: 2,
  nodeCount: 2,
  validationErrors: [],
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T00:00:00.000Z',
};

const WORKFLOW: WakerWorkflow = {
  ...SUMMARY,
  script: JSON.stringify(DEFINITION, null, 2),
  definition: DEFINITION,
};

/** 覆盖七种节点 kind 的定义，用于画布渲染测试。 */
const FULL_DEFINITION = {
  schemaVersion: 1 as const,
  start: 'prepare',
  nodes: [
    {
      id: 'prepare',
      kind: 'action' as const,
      action: 'set' as const,
      key: 'topic',
      value: '本地优先',
      next: 'draft',
    },
    {
      id: 'draft',
      kind: 'codex' as const,
      prompt: '写一段关于 {{topic}} 的草稿，尽量简洁，保留关键事实',
      outputKey: 'draft',
      next: 'review',
    },
    {
      id: 'review',
      kind: 'decision' as const,
      key: 'verdict',
      branches: [
        { equals: 'ok', next: 'publish' },
        { equals: 'redo', next: 'draft' },
      ],
      defaultNext: 'polish',
    },
    { id: 'polish', kind: 'wait' as const, durationMs: 300_000, next: 'confirm' },
    {
      id: 'confirm',
      kind: 'ask_user' as const,
      prompt: '确认发布吗？',
      inputKey: 'verdict',
      next: 'done',
    },
    { id: 'publish', kind: 'call_workflow' as const, workflowId: 'wf-child', next: 'done' },
    { id: 'done', kind: 'terminal' as const, status: 'succeeded' as const },
  ],
};

const RUNS: WorkflowRunRecord[] = [
  {
    id: 'run-waiting',
    taskId: 'task-run-waiting',
    workflowId: SUMMARY.id,
    workflowVersion: 2,
    nameSnapshot: SUMMARY.name,
    descriptionSnapshot: SUMMARY.description ?? '',
    scriptSnapshot: WORKFLOW.script,
    definitionSnapshot: DEFINITION,
    wakerId: 'waker-one',
    depth: 0,
    attempt: 1,
    context: {},
    status: 'waiting_input',
    input: { source: 'test' },
    createdAt: '2026-08-29T00:01:00.000Z',
    updatedAt: '2026-08-29T00:02:00.000Z',
    startedAt: '2026-08-29T00:01:10.000Z',
  },
  {
    id: 'run-failed',
    taskId: 'task-run-failed',
    workflowId: SUMMARY.id,
    workflowVersion: 1,
    nameSnapshot: SUMMARY.name,
    descriptionSnapshot: '',
    scriptSnapshot: WORKFLOW.script,
    definitionSnapshot: DEFINITION,
    wakerId: 'waker-one',
    depth: 0,
    attempt: 1,
    context: {},
    status: 'failed',
    error: '模型不可用',
    createdAt: '2026-08-28T00:01:00.000Z',
    updatedAt: '2026-08-28T00:02:00.000Z',
    completedAt: '2026-08-28T00:02:00.000Z',
  },
  {
    id: 'run-succeeded',
    taskId: 'task-run-succeeded',
    workflowId: SUMMARY.id,
    workflowVersion: 2,
    nameSnapshot: SUMMARY.name,
    descriptionSnapshot: '',
    scriptSnapshot: WORKFLOW.script,
    definitionSnapshot: DEFINITION,
    wakerId: 'waker-one',
    depth: 0,
    attempt: 1,
    currentNodeId: 'done',
    context: {},
    status: 'succeeded',
    output: 'ok',
    createdAt: '2026-08-29T00:03:00.000Z',
    updatedAt: '2026-08-29T00:04:00.000Z',
    completedAt: '2026-08-29T00:04:00.000Z',
  },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function resources(): LocalResourcesResponse {
  return {
    projects: [],
    automations: [],
    workflows: [SUMMARY],
    channels: [],
    tasks: [],
  };
}

type Call = { url: string; method: string; body?: Record<string, unknown> };

function installApi(
  calls: Call[],
  options: {
    runs?: WorkflowRunRecord[];
    versions?: WorkflowVersionRecord[];
    generate?: (body: Record<string, unknown>) => Response | Promise<Response>;
  } = {},
) {
  const runs = options.runs ?? RUNS;
  const versions = options.versions ?? [
    {
      ...WORKFLOW,
      workflowId: WORKFLOW.id,
      operation: 'update' as const,
      createdAt: WORKFLOW.updatedAt,
    },
    {
      ...WORKFLOW,
      workflowId: WORKFLOW.id,
      version: 1,
      operation: 'create' as const,
      createdAt: WORKFLOW.createdAt,
    },
  ];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    calls.push({ url, method, body });
    if (url.includes('/local-resources')) return json(resources());
    if (url.includes('/workflow-runs?')) {
      const params = new URL(url, 'http://waker.test').searchParams;
      const offset = Number(params.get('offset') ?? 0);
      const limit = Number(params.get('limit') ?? 25);
      return json({ items: runs.slice(offset, offset + limit), total: runs.length });
    }
    if (url.includes('/workflow-runs/run-waiting/trace'))
      return json({
        run: { ...RUNS[0], sessionId: 'session-one' },
        events: [
          {
            id: 1,
            runId: 'run-waiting',
            sequence: 1,
            type: 'node_started',
            payload: { nodeId: 'ask' },
            createdAt: '2026-08-29T00:01:10.000Z',
          },
          {
            id: 2,
            runId: 'run-waiting',
            sequence: 2,
            type: 'waiting_input',
            payload: { nodeId: 'ask', prompt: '请输入主题' },
            createdAt: '2026-08-29T00:02:00.000Z',
          },
        ],
      });
    if (url.includes('/workflow-runs/run-failed/trace')) return json({ run: RUNS[1], events: [] });
    if (url.includes('/workflow-runs/run-succeeded/trace'))
      return json({
        run: RUNS[2],
        events: [
          {
            id: 3,
            runId: 'run-succeeded',
            sequence: 1,
            type: 'node_started',
            payload: { nodeId: 'done' },
            createdAt: '2026-08-29T00:03:30.000Z',
          },
          {
            id: 4,
            runId: 'run-succeeded',
            sequence: 2,
            type: 'succeeded',
            payload: 'ok',
            createdAt: '2026-08-29T00:04:00.000Z',
          },
        ],
      });
    if (url.includes('/workflow-runs/run-paused/trace')) {
      const paused = runs.find((run) => run.id === 'run-paused');
      return json({
        run: paused,
        events: [
          {
            id: 5,
            runId: 'run-paused',
            sequence: 1,
            type: 'node_started',
            payload: { nodeId: 'ask' },
            createdAt: '2026-08-29T00:05:00.000Z',
          },
          {
            id: 6,
            runId: 'run-paused',
            sequence: 2,
            type: 'paused',
            payload: { nodeId: 'ask' },
            createdAt: '2026-08-29T00:05:10.000Z',
          },
        ],
      });
    }
    if (url.includes('/workflow-runs/') && method === 'POST') return json(RUNS[0]);
    if (url.endsWith('/workflows/generate-definition') && method === 'POST') {
      return options.generate
        ? options.generate(body ?? {})
        : json({ definition: DEFINITION });
    }
    if (url.endsWith('/workflows/validate'))
      return json({ valid: true, definition: DEFINITION, script: WORKFLOW.script, errors: [] });
    if (url.includes('/versions')) {
      const params = new URL(url, 'http://waker.test').searchParams;
      const offset = Number(params.get('offset') ?? 0);
      const limit = Number(params.get('limit') ?? 25);
      return json({ items: versions.slice(offset, offset + limit), total: versions.length });
    }
    if (url.includes('/diff?')) return json({ diff: '--- v1\n+++ v2\n+ ask_user' });
    if (url.includes('/rollback') && method === 'POST')
      return json({ applied: true, workflow: { ...WORKFLOW, version: 3 }, diff: 'rollback' });
    if (url.includes('/delete-impact'))
      return json({
        workflowId: WORKFLOW.id,
        versions: 2,
        runs: 2,
        activeRuns: 0,
        referencedBy: [],
        behavior: { definition: 'soft-delete', versions: 'preserve', runs: 'preserve' },
      });
    if (url.includes(`/workflows/${WORKFLOW.id}?`) && method === 'GET') return json(WORKFLOW);
    if (url.includes(`/workflows/${WORKFLOW.id}`) && method === 'PATCH')
      return json({ ...WORKFLOW, version: 3 });
    if (url.includes(`/workflows/${WORKFLOW.id}`) && method === 'DELETE')
      return new Response(null, { status: 204 });
    if (url.includes(`/workflows/${WORKFLOW.id}/run`) && method === 'POST')
      return json(RUNS[0], 202);
    return json({ error: `unexpected ${method} ${url}` }, 500);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('WorkflowManager', () => {
  it('announces list failures and retries in place', async () => {
    const calls: Call[] = [];
    installApi(calls);
    const healthyFetch = globalThis.fetch;
    let failures = 1;
    globalThis.fetch = (async (input, init) => {
      if (String(input).includes('/local-resources') && failures-- > 0)
        return json({ error: '流程列表验证失败' }, 500);
      return healthyFetch(input, init);
    }) as typeof fetch;

    render(<WorkflowManager wakerId="waker-one" notify={() => {}} />);
    const alert = await screen.findByRole('alert');
    assert.match(alert.textContent ?? '', /流程列表验证失败/);

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    assert.ok(await screen.findByRole('heading', { name: WORKFLOW.name }));
  });

  it('validates the JSON definition before saving and preserves optimistic versioning', async () => {
    const calls: Call[] = [];
    const notices: Array<{ text: string; tone?: string }> = [];
    installApi(calls);
    render(
      <WorkflowManager
        wakerId="waker-one"
        notify={(text, tone) => notices.push({ text, tone })}
      />,
    );
    await screen.findByRole('heading', { name: WORKFLOW.name });
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));

    const definition = screen.getByLabelText('节点定义（JSON）');
    fireEvent.change(definition, { target: { value: '{"schemaVersion": 1' } });
    assert.ok(screen.getByText('流程定义不是有效的 JSON'));
    assert.equal(screen.getByRole('button', { name: '保存定义' }).hasAttribute('disabled'), true);
    assert.equal(
      calls.some((call) => call.url.endsWith('/workflows/validate')),
      false,
    );

    fireEvent.change(definition, { target: { value: WORKFLOW.script } });
    fireEvent.change(screen.getByLabelText('说明'), { target: { value: '新的说明' } });
    fireEvent.click(screen.getByRole('button', { name: '保存定义' }));

    await waitFor(() => assert.ok(calls.some((call) => call.url.endsWith('/workflows/validate'))));
    assert.equal(
      calls.find((call) => call.url.endsWith('/workflows/validate'))?.body?.workflowId,
      WORKFLOW.id,
    );
    const patch = calls.find((call) => call.method === 'PATCH');
    assert.equal(patch?.body?.wakerId, 'waker-one');
    assert.equal(patch?.body?.expectedVersion, 2);
    assert.deepEqual(patch?.body?.definition, DEFINITION);
    await waitFor(() =>
      assert.deepEqual(notices.at(-1), { text: '流程定义已保存', tone: 'success' }),
    );
  });

  it('shows only legal run actions, resumes waiting input, retries failures and opens trace session', async () => {
    const calls: Call[] = [];
    const sessions: string[] = [];
    installApi(calls);
    render(
      <WorkflowManager
        wakerId="waker-one"
        notify={() => {}}
        onOpenSession={(sessionId) => sessions.push(sessionId)}
      />,
    );
    await screen.findByRole('heading', { name: WORKFLOW.name });
    assert.equal(screen.queryByRole('button', { name: 'start' }), null);
    assert.equal(screen.queryByRole('button', { name: 'complete' }), null);

    const waitingSummary = screen.getByText(/run-wait/).closest('summary');
    assert.ok(waitingSummary);
    fireEvent.click(waitingSummary);
    assert.ok(await screen.findByText('#2 waiting_input'));
    fireEvent.click(screen.getByRole('button', { name: '打开会话' }));
    assert.deepEqual(sessions, ['session-one']);
    fireEvent.change(screen.getByLabelText(/继续运行的输入（JSON）/), {
      target: { value: '{"topic":"本地优先"}' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交并继续' }));
    await waitFor(() => assert.ok(calls.some((call) => call.url.endsWith('/run-waiting/resume'))));
    assert.deepEqual(calls.find((call) => call.url.endsWith('/run-waiting/resume'))?.body, {
      wakerId: 'waker-one',
      input: { topic: '本地优先' },
    });

    const failedSummary = screen.getByText(/run-fail/).closest('summary');
    assert.ok(failedSummary);
    fireEvent.click(failedSummary);
    fireEvent.click(await screen.findByRole('button', { name: '重试' }));
    await waitFor(() => assert.ok(calls.some((call) => call.url.endsWith('/run-failed/retry'))));

    const succeededSummary = screen.getByText(/run-succ/).closest('summary');
    assert.ok(succeededSummary);
    fireEvent.click(succeededSummary);
    const succeededDetails = succeededSummary.closest('details');
    assert.ok(succeededDetails);
    const progress = await within(succeededDetails).findByRole('list', { name: '节点进度' });
    assert.ok(within(progress).getByText('已完成'));
    assert.ok(within(progress).getByText('未执行'));
  });

  it('reads versions, diffs and delete impact before destructive actions', async () => {
    const calls: Call[] = [];
    installApi(calls);
    render(<WorkflowManager wakerId="waker-one" notify={() => {}} />);
    await screen.findByRole('heading', { name: WORKFLOW.name });

    fireEvent.click(screen.getByRole('button', { name: '读取版本' }));
    const versions = await screen.findByLabelText('对比版本');
    fireEvent.change(versions, { target: { value: '1' } });
    assert.ok(await screen.findByText(/ask_user/));
    fireEvent.click(screen.getByRole('button', { name: '预览回滚' }));
    fireEvent.click(await screen.findByRole('button', { name: '应用回滚到 v1' }));
    await waitFor(() =>
      assert.equal(calls.filter((call) => call.url.endsWith('/rollback')).length, 2),
    );
    assert.deepEqual(calls.filter((call) => call.url.endsWith('/rollback'))[1]?.body, {
      wakerId: 'waker-one',
      targetVersion: 1,
      expectedVersion: 2,
      apply: true,
    });

    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    const dialog = await screen.findByRole('dialog', { name: `删除“${WORKFLOW.name}”？` });
    assert.equal(within(dialog).getAllByText('2', { selector: 'dd' }).length, 2);
    fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }));
    await waitFor(() => assert.ok(calls.some((call) => call.method === 'DELETE')));
    assert.match(calls.find((call) => call.method === 'DELETE')?.url ?? '', /expectedVersion=3/);
  });

  it('queries bounded workflow-owned pages and loads more runs and versions', async () => {
    const calls: Call[] = [];
    const manyRuns = Array.from({ length: 26 }, (_, index): WorkflowRunRecord => ({
      ...RUNS[1]!,
      id: `page-run-${String(index).padStart(3, '0')}`,
      createdAt: new Date(Date.UTC(2026, 7, 29, 0, index)).toISOString(),
    }));
    const manyVersions = Array.from({ length: 26 }, (_, index): WorkflowVersionRecord => ({
      workflowId: WORKFLOW.id,
      version: 26 - index,
      wakerId: WORKFLOW.wakerId,
      name: WORKFLOW.name,
      status: 'active',
      validationErrors: [],
      operation: index === 25 ? 'create' : 'update',
      createdAt: new Date(Date.UTC(2026, 7, 29, 0, index)).toISOString(),
    }));
    installApi(calls, { runs: manyRuns, versions: manyVersions });
    render(<WorkflowManager wakerId="waker-one" notify={() => {}} />);
    await screen.findByRole('heading', { name: WORKFLOW.name });

    await waitFor(() => {
      const firstPage = calls.find((call) => call.url.includes('/workflow-runs?'));
      assert.match(firstPage?.url ?? '', /workflowId=workflow-one/);
      assert.match(firstPage?.url ?? '', /limit=25/);
      assert.match(firstPage?.url ?? '', /offset=0/);
    });
    fireEvent.click(await screen.findByRole('button', { name: '加载更多运行' }));
    await waitFor(() =>
      assert.ok(calls.some((call) => /workflow-runs\?.*offset=25/.test(call.url))),
    );
    assert.ok(await screen.findByText('已显示 26 / 26'));

    fireEvent.click(screen.getByRole('button', { name: '读取版本' }));
    fireEvent.click(await screen.findByRole('button', { name: '加载更多版本' }));
    await waitFor(() => assert.ok(calls.some((call) => /versions\?.*offset=25/.test(call.url))));
    assert.equal((await screen.findAllByText('已显示 26 / 26')).length, 2);
  });

  it('keeps resume drafts isolated by run id and maps paused events to paused node state', async () => {
    const calls: Call[] = [];
    const secondWaiting: WorkflowRunRecord = { ...RUNS[0]!, id: 'run-waiting-two' };
    const paused: WorkflowRunRecord = {
      ...RUNS[0]!,
      id: 'run-paused',
      status: 'paused',
      currentNodeId: 'ask',
    };
    installApi(calls, { runs: [RUNS[0]!, secondWaiting, paused] });
    render(<WorkflowManager wakerId="waker-one" notify={() => {}} />);
    await screen.findByRole('heading', { name: WORKFLOW.name });

    const drafts = await screen.findAllByLabelText('继续运行的输入（JSON）');
    assert.equal(drafts.length, 2);
    fireEvent.change(drafts[0]!, { target: { value: '{"answer":"one"}' } });
    fireEvent.change(drafts[1]!, { target: { value: '{"answer":"two"}' } });
    assert.equal((drafts[0] as HTMLTextAreaElement).value, '{"answer":"one"}');
    assert.equal((drafts[1] as HTMLTextAreaElement).value, '{"answer":"two"}');
    const firstDetails = drafts[0]!.closest('details');
    assert.ok(firstDetails);
    fireEvent.submit(
      within(firstDetails).getByRole('button', { name: '提交并继续' }).closest('form')!,
    );
    await waitFor(() => assert.ok(calls.some((call) => call.url.endsWith('/run-waiting/resume'))));
    assert.deepEqual(calls.find((call) => call.url.endsWith('/run-waiting/resume'))?.body?.input, {
      answer: 'one',
    });

    const pausedSummary = screen.getByText(/run-paus/).closest('summary');
    assert.ok(pausedSummary);
    fireEvent.click(pausedSummary);
    const pausedDetails = pausedSummary.closest('details');
    assert.ok(pausedDetails);
    const progress = await within(pausedDetails).findByRole('list', { name: '节点进度' });
    assert.ok(within(progress).getByText('已暂停'));
  });

  it('moves editor focus in and back to its trigger', async () => {
    const calls: Call[] = [];
    installApi(calls);
    render(<WorkflowManager wakerId="waker-one" notify={() => {}} />);
    await screen.findByRole('heading', { name: WORKFLOW.name });

    const create = screen.getByRole('button', { name: '新建 WakerFlow' });
    fireEvent.click(create);
    assert.equal(document.activeElement, screen.getByLabelText('名称'));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    assert.equal(document.activeElement, create);

    const edit = screen.getByRole('button', { name: '编辑' });
    fireEvent.click(edit);
    assert.equal(document.activeElement, screen.getByLabelText('名称'));
    fireEvent.click(screen.getByRole('button', { name: '关闭编辑器' }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    assert.equal(document.activeElement, screen.getByRole('button', { name: '编辑' }));
  });

  it('implements roving tabs, arrow navigation and a labelled tabpanel', async () => {
    const secondSummary: WakerWorkflowSummary = {
      ...SUMMARY,
      id: 'workflow-two',
      name: '第二流程',
    };
    const secondWorkflow: WakerWorkflow = { ...WORKFLOW, ...secondSummary };
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes('/local-resources'))
        return json({ ...resources(), workflows: [SUMMARY, secondSummary] });
      if (url.includes('/workflow-runs?')) return json({ items: [], total: 0 });
      if (url.includes('/workflows/workflow-one?')) return json(WORKFLOW);
      if (url.includes('/workflows/workflow-two?')) return json(secondWorkflow);
      return json({ error: 'unexpected request' }, 500);
    }) as typeof fetch;
    render(<WorkflowManager wakerId="waker-one" notify={() => {}} />);
    const firstTab = await screen.findByRole('tab', { name: /人工审核流程/ });
    const secondTab = screen.getByRole('tab', { name: /第二流程/ });
    assert.equal(firstTab.tabIndex, 0);
    assert.equal(secondTab.tabIndex, -1);

    firstTab.focus();
    fireEvent.keyDown(firstTab, { key: 'ArrowRight' });
    await screen.findByRole('heading', { name: secondWorkflow.name });
    await waitFor(() => assert.equal(document.activeElement, secondTab));
    assert.equal(secondTab.getAttribute('aria-selected'), 'true');
    assert.equal(secondTab.tabIndex, 0);
    const panel = screen.getByRole('tabpanel');
    assert.equal(panel.getAttribute('aria-labelledby'), secondTab.id);
    assert.equal(secondTab.getAttribute('aria-controls'), panel.id);
  });

  it('ignores a late detail response after the owner Waker changes', async () => {
    const otherSummary: WakerWorkflowSummary = {
      ...SUMMARY,
      id: 'workflow-two',
      wakerId: 'waker-two',
      name: '新 Waker 流程',
    };
    const otherWorkflow: WakerWorkflow = {
      ...WORKFLOW,
      ...otherSummary,
    };
    let resolveOldDetail!: (response: Response) => void;
    const oldDetail = new Promise<Response>((resolve) => {
      resolveOldDetail = resolve;
    });
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes('/workflow-runs?')) return json({ items: [], total: 0 });
      if (url.includes('/local-resources')) {
        const workflow = url.includes('wakerId=waker-two') ? otherSummary : SUMMARY;
        return json({ ...resources(), workflows: [workflow] });
      }
      if (url.includes('/workflows/workflow-one?')) return oldDetail;
      if (url.includes('/workflows/workflow-two?')) return json(otherWorkflow);
      return json({ error: 'unexpected request' }, 500);
    }) as typeof fetch;

    const view = render(<WorkflowManager wakerId="waker-one" notify={() => {}} />);
    await screen.findByRole('tab', { name: /人工审核流程/ });
    view.rerender(<WorkflowManager wakerId="waker-two" notify={() => {}} />);
    assert.ok(await screen.findByRole('heading', { name: otherWorkflow.name }));
    resolveOldDetail(json(WORKFLOW));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(screen.queryByRole('heading', { name: WORKFLOW.name }), null);
  });

  it('does not commit or notify a mutation that resolves after the owner changes', async () => {
    const otherSummary: WakerWorkflowSummary = {
      ...SUMMARY,
      id: 'workflow-two',
      wakerId: 'waker-two',
      name: '新 Waker 流程',
    };
    const otherWorkflow: WakerWorkflow = { ...WORKFLOW, ...otherSummary };
    const notices: string[] = [];
    let resolvePatch!: (response: Response) => void;
    const delayedPatch = new Promise<Response>((resolve) => {
      resolvePatch = resolve;
    });
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (url.includes('/local-resources')) {
        const value = url.includes('wakerId=waker-two') ? otherSummary : SUMMARY;
        return json({ ...resources(), workflows: [value] });
      }
      if (url.includes('/workflow-runs?')) return json({ items: [], total: 0 });
      if (url.includes('/workflows/validate'))
        return json({ valid: true, definition: DEFINITION, script: WORKFLOW.script, errors: [] });
      if (url.includes('/workflows/workflow-one') && init?.method === 'PATCH') return delayedPatch;
      if (url.includes('/workflows/workflow-one?')) return json(WORKFLOW);
      if (url.includes('/workflows/workflow-two?')) return json(otherWorkflow);
      return json({ error: `unexpected ${url} ${String(body.wakerId ?? '')}` }, 500);
    }) as typeof fetch;

    const view = render(
      <WorkflowManager wakerId="waker-one" notify={(message) => notices.push(message)} />,
    );
    await screen.findByRole('heading', { name: WORKFLOW.name });
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    const save = screen.getByRole('button', { name: '保存定义' }) as HTMLButtonElement;
    fireEvent.click(save);
    await waitFor(() => assert.ok(save.disabled));

    view.rerender(
      <WorkflowManager wakerId="waker-two" notify={(message) => notices.push(message)} />,
    );
    assert.ok(await screen.findByRole('heading', { name: otherWorkflow.name }));
    resolvePatch(json({ ...WORKFLOW, version: 3 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(screen.queryByRole('heading', { name: WORKFLOW.name }), null);
    assert.deepEqual(notices, []);
  });

  it('generates a definition with AI, shows progress and prefills the script without saving', async () => {
    const calls: Call[] = [];
    let resolveGenerate!: (response: Response) => void;
    installApi(calls, {
      generate: () =>
        new Promise<Response>((resolve) => {
          resolveGenerate = resolve;
        }),
    });
    render(<WorkflowManager wakerId="waker-one" notify={() => {}} />);
    await screen.findByRole('heading', { name: WORKFLOW.name });
    fireEvent.click(screen.getByRole('button', { name: '新建 WakerFlow' }));

    const generate = screen.getByRole('button', { name: '生成定义' }) as HTMLButtonElement;
    assert.equal(generate.disabled, true);
    fireEvent.change(screen.getByLabelText('AI 生成定义'), {
      target: { value: '先写草稿，人工确认后结束' },
    });
    assert.equal(generate.disabled, false);
    fireEvent.click(generate);
    assert.equal(screen.getByRole('button', { name: /生成中/ }).hasAttribute('disabled'), true);

    resolveGenerate(json({ definition: FULL_DEFINITION }));
    const definition = screen.getByLabelText('节点定义（JSON）') as HTMLTextAreaElement;
    await waitFor(() => assert.match(definition.value, /"kind": "codex"/));
    assert.match(definition.value, /"start": "prepare"/);
    assert.ok(await screen.findByText(/已生成，请检查脚本后手动保存/));
    const request = calls.find((call) => call.url.endsWith('/workflows/generate-definition'));
    assert.deepEqual(request?.body, { description: '先写草稿，人工确认后结束' });
    // 预填不自动提交：除 validate 外没有任何保存请求。
    assert.equal(
      calls.some((call) => call.url.endsWith('/workflows') && call.method === 'POST'),
      false,
    );
  });

  it('shows AI generation failures and retries successfully', async () => {
    const calls: Call[] = [];
    let failures = 1;
    installApi(calls, {
      generate: () =>
        failures-- > 0
          ? json({ error: 'AI 生成定义失败：模型提供方超时' }, 502)
          : json({ definition: FULL_DEFINITION }),
    });
    render(<WorkflowManager wakerId="waker-one" notify={() => {}} />);
    await screen.findByRole('heading', { name: WORKFLOW.name });
    fireEvent.click(screen.getByRole('button', { name: '新建 WakerFlow' }));
    fireEvent.change(screen.getByLabelText('AI 生成定义'), { target: { value: '两步流程' } });
    fireEvent.click(screen.getByRole('button', { name: '生成定义' }));

    assert.ok(await screen.findByRole('alert'));
    assert.match(screen.getByRole('alert').textContent ?? '', /生成失败：AI 生成定义失败/);

    fireEvent.click(screen.getByRole('button', { name: '生成定义' }));
    const definition = screen.getByLabelText('节点定义（JSON）') as HTMLTextAreaElement;
    await waitFor(() => assert.match(definition.value, /"kind": "codex"/));
    assert.equal(screen.queryByRole('alert'), null);
    assert.equal(
      calls.filter((call) => call.url.endsWith('/workflows/generate-definition')).length,
      2,
    );
  });

  it('asks before overwriting manually edited definitions with AI output', async () => {
    const calls: Call[] = [];
    installApi(calls, { generate: () => json({ definition: FULL_DEFINITION }) });
    const originalConfirm = window.confirm;
    let confirmed = false;
    window.confirm = () => confirmed;
    try {
      render(<WorkflowManager wakerId="waker-one" notify={() => {}} />);
      await screen.findByRole('heading', { name: WORKFLOW.name });
      fireEvent.click(screen.getByRole('button', { name: '编辑' }));
      const definition = screen.getByLabelText('节点定义（JSON）') as HTMLTextAreaElement;
      fireEvent.change(definition, { target: { value: `${WORKFLOW.script}\n` } });
      fireEvent.change(screen.getByLabelText('AI 生成定义'), { target: { value: '重写整个流程' } });

      fireEvent.click(screen.getByRole('button', { name: '生成定义' }));
      await screen.findByText(/已生成，请检查脚本后手动保存/);
      assert.equal(definition.value, `${WORKFLOW.script}\n`);

      confirmed = true;
      fireEvent.click(screen.getByRole('button', { name: '生成定义' }));
      await waitFor(() => assert.match(definition.value, /"start": "prepare"/));
    } finally {
      window.confirm = originalConfirm;
    }
  });

  it('switches between canvas and script tabs and renders kind cards with decision branches', async () => {
    const calls: Call[] = [];
    installApi(calls);
    render(<WorkflowManager wakerId="waker-one" notify={() => {}} />);
    await screen.findByRole('heading', { name: WORKFLOW.name });
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));

    const canvasTab = screen.getByRole('tab', { name: '画布' });
    const scriptTab = screen.getByRole('tab', { name: '脚本' });
    assert.equal(scriptTab.getAttribute('aria-selected'), 'true');
    assert.equal(scriptTab.tabIndex, 0);
    assert.equal(canvasTab.tabIndex, -1);
    fireEvent.change(screen.getByLabelText('节点定义（JSON）'), {
      target: { value: JSON.stringify(FULL_DEFINITION, null, 2) },
    });
    scriptTab.focus();
    fireEvent.keyDown(scriptTab, { key: 'ArrowLeft' });
    assert.equal(document.activeElement, canvasTab);
    assert.equal(canvasTab.getAttribute('aria-selected'), 'true');
    assert.equal(canvasTab.tabIndex, 0);

    const canvas = await screen.findByRole('list', { name: '流程画布' });
    for (const label of ['动作', 'Codex', '判断', '等待', '人工输入', '子流程', '结束']) {
      assert.ok(within(canvas).getByText(label), label);
    }
    assert.ok(within(canvas).getByText('起点'));
    assert.ok(within(canvas).getByText(/写一段关于 \{\{topic\}\} 的草稿/));
    assert.ok(within(canvas).getByText('等待 5 分钟'));
    const reviewEdges = within(canvas).getByRole('list', { name: 'review 的出边' });
    assert.ok(within(reviewEdges).getByText('verdict = "ok"'));
    assert.ok(within(reviewEdges).getByText('verdict = "redo"'));
    assert.ok(within(reviewEdges).getByText('默认'));
    assert.ok(within(reviewEdges).getByText('polish'));

    fireEvent.click(scriptTab);
    assert.ok(screen.getByLabelText('节点定义（JSON）'));
    assert.equal(screen.queryByRole('list', { name: '流程画布' }), null);
  });

  it('shows a fallback in the canvas tab when the script cannot be parsed', async () => {
    const calls: Call[] = [];
    installApi(calls);
    render(<WorkflowManager wakerId="waker-one" notify={() => {}} />);
    await screen.findByRole('heading', { name: WORKFLOW.name });
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByLabelText('节点定义（JSON）'), {
      target: { value: '{"schemaVersion": 1' },
    });
    fireEvent.click(screen.getByRole('tab', { name: '画布' }));
    assert.ok(await screen.findByText(/脚本暂无法解析为图形/));
    fireEvent.click(screen.getByRole('tab', { name: '脚本' }));
    assert.ok(screen.getByText('流程定义不是有效的 JSON'));
  });

  it('renders the read-only canvas in the detail view', async () => {
    const calls: Call[] = [];
    installApi(calls);
    render(<WorkflowManager wakerId="waker-one" notify={() => {}} />);
    await screen.findByRole('heading', { name: WORKFLOW.name });
    const section = screen.getByRole('heading', { name: '节点路径图' }).closest('section');
    assert.ok(section);
    const canvas = within(section).getByRole('list', { name: '流程画布' });
    assert.ok(within(canvas).getByText('人工输入'));
    assert.ok(within(canvas).getByText('结束'));
    assert.ok(within(canvas).getByText('起点'));
    assert.ok(within(canvas).getByText('请输入主题'));
  });
});

describe('parseWorkflowDefinition', () => {
  it('rejects duplicate and missing start nodes', () => {
    const duplicate = parseWorkflowDefinition(
      JSON.stringify({
        schemaVersion: 1,
        start: 'missing',
        nodes: [
          { id: 'same', kind: 'terminal' },
          { id: 'same', kind: 'terminal' },
        ],
      }),
    );
    assert.ok(duplicate.errors.includes('节点 id 重复：same'));
    assert.ok(duplicate.errors.includes('起始节点不存在：missing'));
  });
});
