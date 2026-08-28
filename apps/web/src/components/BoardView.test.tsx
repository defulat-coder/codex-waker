import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { HumanActionRecord } from '@waker/contracts';
import { BoardView, type BoardTaskRecord } from './BoardView.js';

const originalFetch = globalThis.fetch;

const MANUAL: BoardTaskRecord = {
  id: 'manual-one',
  wakerId: 'waker-one',
  title: '整理验收记录',
  description: '人工维护的本地任务',
  type: 'manual',
  origin: 'manual',
  status: 'queued',
  sourceType: 'manual',
  sourceId: 'manual-one',
  source: 'local',
  projectId: 'project-one',
  projectName: '本地项目',
  priority: 'normal',
  position: 0,
  version: 3,
  managed: false,
  lastActiveAt: '2026-08-29T01:00:00.000Z',
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T01:00:00.000Z',
};

const DERIVED: BoardTaskRecord = {
  ...MANUAL,
  id: 'workflow-one',
  title: 'Workflow 验收运行',
  type: 'workflow',
  origin: 'derived',
  status: 'waiting',
  sourceType: 'workflow',
  sourceId: 'flow-one',
  source: 'workflow',
  workflowId: 'flow-one',
  runId: 'run-one',
  sessionId: 'session-one',
  managed: true,
};

const ACTION: HumanActionRecord & { version: number; sessionId?: string } = {
  id: 'action-one',
  wakerId: 'waker-one',
  source: 'workflow',
  sourceId: 'run-one',
  title: '输入验收结果',
  kind: 'input',
  prompt: '请提供 JSON 结果',
  status: 'pending',
  version: 4,
  createdAt: '2026-08-29T01:00:00.000Z',
  updatedAt: '2026-08-29T01:00:00.000Z',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type Call = { url: string; method: string; body?: Record<string, unknown> };

function installApi(calls: Call[], tasks: BoardTaskRecord[] = [MANUAL, DERIVED]) {
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    calls.push({ url, method, body });
    if (calls.length > 50) throw new Error(`unexpected request loop: ${url}`);
    if (url.includes('/local-resources'))
      return json({
        projects: [{ id: 'project-one', wakerId: 'waker-one', name: '本地项目' }],
        automations: [],
        workflows: [],
        channels: [],
        tasks: [],
      });
    if (url.includes('/board/tasks?')) {
      const params = new URL(url, 'http://waker.test').searchParams;
      const offset = Number(params.get('offset') ?? 0);
      const limit = Number(params.get('limit') ?? 20);
      return json({
        items: tasks.slice(offset, offset + limit),
        total: tasks.length,
        projects: [{ id: 'project-one', name: '本地项目' }],
      });
    }
    if (url.includes('/board/tasks/manual-one/delete-impact'))
      return json({
        taskId: MANUAL.id,
        behavior: 'soft-delete',
        children: 0,
        events: 1,
        humanActions: 0,
      });
    if (url.includes('/board/tasks/manual-one') && method === 'GET')
      return json({
        task: MANUAL,
        events: [
          {
            id: 1,
            taskId: MANUAL.id,
            sequence: 1,
            type: '任务创建',
            createdAt: MANUAL.createdAt,
          },
        ],
        children: [],
        humanActions: [],
      });
    if (url.includes('/board/tasks/workflow-one') && method === 'GET')
      return json({
        task: { ...DERIVED, result: '等待人工输入' },
        events: [
          {
            id: 2,
            taskId: DERIVED.id,
            sequence: 1,
            type: '等待输入',
            status: 'waiting',
            createdAt: DERIVED.updatedAt,
          },
        ],
        children: [],
        humanActions: [],
      });
    if (url.includes('/board/human-actions?')) return json({ items: [ACTION], total: 1 });
    if (url.includes('/board/human-actions/') && method === 'POST')
      return json({ ...ACTION, status: 'handled', version: 5 });
    if (url === '/api/v1/board/tasks' && method === 'POST') return json(MANUAL, 201);
    if (url.includes('/board/tasks/manual-one') && method === 'PATCH')
      return json({ ...MANUAL, ...body, version: 4 });
    if (url.includes('/board/tasks/manual-one') && method === 'DELETE')
      return new Response(null, { status: 204 });
    return json({ error: `unexpected ${method} ${url}` }, 500);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('BoardView', () => {
  it('uses server filters, native list semantics, bounded load-more and honest lanes', async () => {
    const calls: Call[] = [];
    const tasks = Array.from({ length: 21 }, (_, index): BoardTaskRecord => ({
      ...MANUAL,
      id: `task-${index}`,
      title: `任务 ${index}`,
      status: index % 2 ? 'running' : 'queued',
    }));
    installApi(calls, tasks);
    render(<BoardView wakerId="waker-one" notify={() => {}} />);

    const table = await screen.findByRole('table', { name: /任务列表，共 21 条/ });
    assert.equal(within(table).getAllByRole('columnheader').length, 6);
    assert.equal(within(table).getAllByRole('row').length, 21);
    fireEvent.change(screen.getByLabelText('搜索任务'), { target: { value: '验收' } });
    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'running' } });
    fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'workflow' } });
    fireEvent.change(screen.getByLabelText('项目'), { target: { value: 'project-one' } });
    await waitFor(() => {
      const url = calls.at(-1)?.url ?? '';
      assert.match(url, /query=%E9%AA%8C%E6%94%B6/);
      assert.match(url, /status=running/);
      assert.match(url, /type=workflow/);
      assert.match(url, /projectId=project-one/);
    });

    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    await waitFor(() => assert.ok(calls.some((call) => /offset=20/.test(call.url))));
    fireEvent.click(screen.getByRole('button', { name: '分栏' }));
    const lanes = await screen.findByLabelText('任务状态分栏');
    assert.equal(within(lanes).getAllByRole('heading').length, 5);
    assert.match(calls.at(-1)?.url ?? '', /limit=200/);
    assert.equal(screen.queryByText(/拖拽/), null);
  });

  it('implements APG tabs and resolves Workflow input with JSON and expectedVersion', async () => {
    const calls: Call[] = [];
    installApi(calls);
    render(<BoardView wakerId="waker-one" notify={() => {}} />);
    const tasksTab = await screen.findByRole('tab', { name: '任务追踪' });
    const actionsTab = screen.getByRole('tab', { name: /人工操作/ });
    assert.equal(tasksTab.tabIndex, 0);
    assert.equal(actionsTab.tabIndex, -1);
    tasksTab.focus();
    fireEvent.keyDown(tasksTab, { key: 'ArrowRight' });
    await waitFor(() => assert.equal(document.activeElement, actionsTab));
    assert.equal(actionsTab.getAttribute('aria-selected'), 'true');
    assert.equal(actionsTab.getAttribute('aria-controls'), screen.getByRole('tabpanel').id);

    const input = await screen.findByLabelText('继续运行的输入（JSON）');
    fireEvent.change(input, { target: { value: '{"approved":true}' } });
    fireEvent.click(screen.getByRole('button', { name: '提交并继续' }));
    await waitFor(() => assert.ok(calls.some((call) => call.url.endsWith('/action-one/resolve'))));
    assert.deepEqual(calls.find((call) => call.url.endsWith('/action-one/resolve'))?.body, {
      wakerId: 'waker-one',
      expectedVersion: 4,
      result: { approved: true },
    });
  });

  it('uses a protected ignore dialog and sends optimistic action version', async () => {
    const calls: Call[] = [];
    installApi(calls);
    render(<BoardView wakerId="waker-one" notify={() => {}} />);
    fireEvent.click(await screen.findByRole('tab', { name: /人工操作/ }));
    fireEvent.click(await screen.findByRole('button', { name: '忽略并取消等待' }));
    const dialog = screen.getByRole('dialog', { name: `忽略“${ACTION.title}”？` });
    const cancel = within(dialog).getByRole('button', { name: '取消' });
    await waitFor(() => assert.ok(document.activeElement === cancel));
    assert.equal(
      calls.some((call) => call.url.endsWith('/action-one/ignore')),
      false,
    );
    fireEvent.click(within(dialog).getByRole('button', { name: '确认忽略' }));
    await waitFor(() => assert.ok(calls.some((call) => call.url.endsWith('/action-one/ignore'))));
    assert.deepEqual(calls.find((call) => call.url.endsWith('/action-one/ignore'))?.body, {
      wakerId: 'waker-one',
      expectedVersion: 4,
    });
  });

  it('shows wrapped detail data, keeps derived tasks read-only and restores row focus', async () => {
    const calls: Call[] = [];
    const sessions: string[] = [];
    const workflows: Array<string | undefined> = [];
    installApi(calls);
    render(
      <BoardView
        wakerId="waker-one"
        notify={() => {}}
        onOpenSession={(id) => sessions.push(id)}
        onOpenWorkflow={(id) => workflows.push(id)}
      />,
    );
    const row = await screen.findByRole('button', { name: /Workflow 验收运行/ });
    fireEvent.click(row);
    const detail = await screen.findByRole('complementary', { name: /Workflow 验收运行/ });
    assert.ok(within(detail).getByText('派生任务只读；状态由宿主运行更新。'));
    assert.equal(within(detail).queryByRole('button', { name: '编辑' }), null);
    assert.ok(within(detail).getByText('等待输入'));
    fireEvent.click(within(detail).getByRole('button', { name: '打开会话' }));
    fireEvent.click(within(detail).getByRole('button', { name: '打开流程' }));
    assert.deepEqual(sessions, ['session-one']);
    assert.deepEqual(workflows, ['flow-one']);
    fireEvent.click(within(detail).getByRole('button', { name: '关闭任务详情' }));
    await waitFor(() => assert.ok(document.activeElement === row));
  });

  it('keeps stale task responses from the previous Waker out of the UI', async () => {
    let resolveOld!: (response: Response) => void;
    const old = new Promise<Response>((resolve) => {
      resolveOld = resolve;
    });
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes('wakerId=waker-one')) return old;
      return json({
        items: [{ ...MANUAL, wakerId: 'waker-two', title: '新 Waker 任务' }],
        total: 1,
      });
    }) as typeof fetch;
    const view = render(<BoardView wakerId="waker-one" notify={() => {}} />);
    view.rerender(<BoardView wakerId="waker-two" notify={() => {}} />);
    assert.ok(await screen.findByText('新 Waker 任务'));
    await act(async () => {
      resolveOld(json({ items: [MANUAL], total: 1 }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assert.equal(screen.queryByText(MANUAL.title), null);
  });

  it('clears a project filter when the owner Waker changes', async () => {
    const calls: Call[] = [];
    installApi(calls);
    const view = render(<BoardView wakerId="waker-one" notify={() => {}} />);
    await screen.findByText(MANUAL.title);
    fireEvent.change(screen.getByLabelText('项目'), { target: { value: 'project-one' } });
    await waitFor(() =>
      assert.ok(calls.some((call) => call.url.includes('projectId=project-one'))),
    );
    view.rerender(<BoardView wakerId="waker-two" notify={() => {}} />);
    await waitFor(() =>
      assert.equal((screen.getByLabelText('项目') as HTMLSelectElement).value, ''),
    );
    await waitFor(() => {
      const newOwnerCalls = calls.filter((call) => call.url.includes('wakerId=waker-two'));
      assert.ok(newOwnerCalls.some((call) => !call.url.includes('projectId=')));
    });
  });
});
