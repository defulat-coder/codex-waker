import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type {
  AutomationRunRecord,
  LocalResourcesResponse,
  WakerAutomation,
  WakerProject,
} from '@waker/contracts';
import {
  AutomationManager,
  formatRunDuration,
  isoForLocalInput,
  localInputForIso,
} from './AutomationManager.js';

const originalFetch = globalThis.fetch;

const AUTOMATION: WakerAutomation = {
  id: 'automation-one',
  wakerId: 'waker-one',
  name: '日报整理',
  kind: 'schedule',
  schedule: '0 9 * * *',
  prompt: '整理今日进展',
  enabled: true,
  lifecycle: 'active',
  timezone: 'Asia/Shanghai',
  runCount: 0,
  misfirePolicy: 'run_once',
  nextRunAt: '2026-08-29T01:00:00.000Z',
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:00.000Z',
};

const PROJECT: WakerProject = {
  id: 'project-one',
  wakerId: 'waker-one',
  name: '工作台',
  visibility: 'private',
  source: 'filesystem',
  path: '.',
  status: 'ready',
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:00.000Z',
};

const FOREIGN_PUBLIC_PROJECT: WakerProject = {
  ...PROJECT,
  id: 'project-public-foreign',
  wakerId: 'waker-two',
  name: '其他 Waker 的公开项目',
  visibility: 'public',
};

const RUNS = [
  {
    id: 'run-failed',
    automationId: AUTOMATION.id,
    taskId: 'task-failed',
    wakerId: 'waker-one',
    status: 'failed',
    trigger: 'manual',
    nameSnapshot: AUTOMATION.name,
    promptSnapshot: AUTOMATION.prompt,
    input: { source: 'manual' },
    error: '模型暂时不可用',
    sessionId: 'session-failed',
    attempt: 1,
    createdAt: '2026-08-28T02:00:00.000Z',
    updatedAt: '2026-08-28T02:01:00.000Z',
    completedAt: '2026-08-28T02:01:00.000Z',
  },
  {
    id: 'run-queued',
    automationId: AUTOMATION.id,
    taskId: 'task-queued',
    wakerId: 'waker-one',
    status: 'queued',
    trigger: 'manual',
    nameSnapshot: AUTOMATION.name,
    promptSnapshot: AUTOMATION.prompt,
    attempt: 1,
    createdAt: '2026-08-28T03:00:00.000Z',
    updatedAt: '2026-08-28T03:00:00.000Z',
  },
  {
    id: 'run-success',
    automationId: AUTOMATION.id,
    taskId: 'task-success',
    wakerId: 'waker-one',
    status: 'succeeded',
    trigger: 'scheduled',
    scheduledFor: '2026-08-28T01:00:00.000Z',
    nameSnapshot: AUTOMATION.name,
    promptSnapshot: AUTOMATION.prompt,
    output: '自动任务执行完成',
    result: '自动任务执行完成',
    usage: { inputTokens: 12, outputTokens: 8 },
    attempt: 1,
    createdAt: '2026-08-28T01:00:00.000Z',
    updatedAt: '2026-08-28T01:01:00.000Z',
    completedAt: '2026-08-28T01:01:00.000Z',
  },
] as Array<AutomationRunRecord & { sessionId?: string }>;

function resources(
  items: WakerAutomation[],
  projects: WakerProject[] = [PROJECT],
): LocalResourcesResponse {
  return { projects, automations: items, workflows: [], channels: [], tasks: [] };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const workspace = {
  agents: [],
  prompts: [],
  models: { current: {}, available: [{ id: 'model-one', name: 'Model One' }] },
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('AutomationManager', () => {
  it('编辑自动任务并展示计划帮助', async () => {
    let items = [AUTOMATION];
    const calls: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined;
      calls.push({ method, url, body });
      if (url.endsWith('/api/v1/workspace')) return json(workspace);
      if (url.includes('/local-resources')) return json(resources(items));
      if (url.includes('/automation-runs') && method === 'GET')
        return json({ items: RUNS, total: RUNS.length });
      if (url.includes('/delete-impact'))
        return json({ automationId: AUTOMATION.id, runs: 2, tasks: 2, sessions: 1 });
      if (method === 'PATCH') {
        items = [{ ...AUTOMATION, ...body } as WakerAutomation];
        return json(items[0]);
      }
      if (method === 'DELETE') {
        items = [];
        return new Response(null, { status: 204 });
      }
      return json({ error: 'unexpected request' }, 500);
    }) as typeof fetch;

    render(<AutomationManager wakerId="waker-one" notify={() => {}} />);
    assert.ok(await screen.findByRole('heading', { name: '日报整理' }));
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    assert.ok(screen.getByText(/5 段 Cron/));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '工作日报' } });
    fireEvent.change(screen.getByLabelText('执行提示'), {
      target: { value: '读取当日进展并整理' },
    });
    fireEvent.change(screen.getByLabelText('IANA 时区'), { target: { value: 'Asia/Tokyo' } });
    fireEvent.change(screen.getByLabelText('开始时间（本地）'), {
      target: { value: '2026-09-01T00:00' },
    });
    fireEvent.change(screen.getByLabelText('最多运行次数'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('误过计划时'), { target: { value: 'skip' } });
    fireEvent.change(screen.getByLabelText('项目'), { target: { value: PROJECT.id } });
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'model-one' } });
    fireEvent.change(screen.getByLabelText('思考强度'), { target: { value: 'high' } });
    fireEvent.click(screen.getByRole('button', { name: /保存/ }));

    assert.ok(await screen.findByRole('heading', { name: '工作日报' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(document.activeElement, screen.getByRole('button', { name: '编辑' }));
    const patch = calls.find((call) => call.method === 'PATCH');
    assert.deepEqual(patch?.body, {
      wakerId: 'waker-one',
      name: '工作日报',
      prompt: '读取当日进展并整理',
      schedule: '0 9 * * *',
      timezone: 'Asia/Tokyo',
      startAt: isoForLocalInput('2026-09-01T00:00'),
      endAt: null,
      maxRuns: 5,
      misfirePolicy: 'skip',
      projectId: PROJECT.id,
      model: 'model-one',
      thinking: 'high',
    });

    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    const dialog = await screen.findByRole('dialog', { name: /删除“工作日报”/ });
    assert.equal(within(dialog).getAllByText('2', { selector: 'dd' }).length, 2);
    assert.ok(within(dialog).getByText('1', { selector: 'dd' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '删除任务' }));
    assert.ok(await screen.findByRole('heading', { name: '还没有自动任务' }));
    assert.ok(calls.some((call) => call.method === 'DELETE'));
  });

  it('项目仅列当前 Waker 所有，并诚实说明默认配置会在保存时固定', async () => {
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith('/api/v1/workspace')) return json(workspace);
      if (url.includes('/automation-runs')) return json({ items: [], total: 0 });
      return json(resources([AUTOMATION], [PROJECT, FOREIGN_PUBLIC_PROJECT]));
    }) as typeof fetch;
    render(<AutomationManager wakerId="waker-one" notify={() => {}} />);
    await screen.findByRole('heading', { name: AUTOMATION.name });
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));

    const project = screen.getByLabelText('项目');
    assert.ok(within(project).getByRole('option', { name: PROJECT.name }));
    assert.equal(
      within(project).queryByRole('option', { name: FOREIGN_PUBLIC_PROJECT.name }),
      null,
    );
    assert.ok(screen.getByRole('option', { name: '使用当前默认模型（保存时固定）' }));
    assert.ok(screen.getByRole('option', { name: '使用当前默认强度（保存时固定）' }));
  });

  it('编辑器首次打开不抢报错误，提交后关联字段错误，取消后恢复触发器焦点', async () => {
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith('/api/v1/workspace')) return json(workspace);
      if (url.includes('/automation-runs')) return json({ items: [], total: 0 });
      return json(resources([AUTOMATION]));
    }) as typeof fetch;
    render(<AutomationManager wakerId="waker-one" notify={() => {}} />);
    await screen.findByRole('heading', { name: AUTOMATION.name });
    const create = screen.getByRole('button', { name: '新建自动任务' });
    fireEvent.click(create);
    assert.equal(screen.queryByRole('alert'), null);

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    assert.ok(screen.getByRole('alert'));
    assert.equal(
      screen.getByRole('textbox', { name: /^名称/ }).getAttribute('aria-invalid'),
      'true',
    );
    assert.equal(
      screen.getByRole('textbox', { name: /^执行提示/ }).getAttribute('aria-invalid'),
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(document.activeElement, create);
  });

  it('允许取消排队运行、重试失败运行并打开会话', async () => {
    const calls: Array<{ method: string; url: string }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ method, url });
      if (url.endsWith('/api/v1/workspace')) return json(workspace);
      if (url.includes('/local-resources')) return json(resources([AUTOMATION]));
      if (url.includes('/automation-runs') && method === 'GET')
        return json({ items: RUNS, total: RUNS.length });
      if (url.endsWith('/cancel')) return json({ ...RUNS[1], status: 'cancelled' });
      if (url.endsWith('/retry'))
        return json({ ...RUNS[0], id: 'run-retry', status: 'queued' }, 202);
      return json({ error: 'unexpected request' }, 500);
    }) as typeof fetch;
    const opened: string[] = [];
    render(
      <AutomationManager
        wakerId="waker-one"
        notify={() => {}}
        onOpenSession={(sessionId) => opened.push(sessionId)}
      />,
    );

    assert.ok(await screen.findByText('模型暂时不可用'));
    const failedSummary = screen
      .getByText(
        (_, element) =>
          element?.tagName === 'SMALL' && Boolean(element.textContent?.includes('run-failed')),
      )
      .closest('summary');
    assert.ok(failedSummary);
    fireEvent.click(failedSummary);
    const failedRun = failedSummary.closest('details');
    assert.ok(failedRun);
    fireEvent.click(within(failedRun).getByRole('button', { name: '重试' }));
    assert.ok(await screen.findByText('模型暂时不可用'));
    fireEvent.click(failedSummary);
    fireEvent.click(failedSummary);
    fireEvent.click(within(failedRun).getByRole('button', { name: '打开会话' }));
    assert.deepEqual(opened, ['session-failed']);

    const successSummary = screen
      .getByText(
        (_, element) =>
          element?.tagName === 'SMALL' && Boolean(element.textContent?.includes('run-success')),
      )
      .closest('summary');
    assert.ok(successSummary);
    fireEvent.click(successSummary);
    const successRun = successSummary.closest('details');
    assert.ok(successRun);
    assert.equal(within(successRun).getAllByText('自动任务执行完成').length, 1);
    assert.ok(within(successRun).getByText(/inputTokens/));

    const queuedSummary = screen
      .getByText(
        (_, element) =>
          element?.tagName === 'SMALL' && Boolean(element.textContent?.includes('run-queued')),
      )
      .closest('summary');
    assert.ok(queuedSummary);
    fireEvent.click(queuedSummary);
    const queuedRun = queuedSummary.closest('details');
    assert.ok(queuedRun);
    fireEvent.click(within(queuedRun).getByRole('button', { name: '取消运行' }));

    assert.ok(calls.some((call) => call.url.endsWith('/automation-runs/run-failed/retry')));
    assert.ok(calls.some((call) => call.url.endsWith('/automation-runs/run-queued/cancel')));
  });

  it('加载失败后可恢复到空状态', async () => {
    let resourceAttempts = 0;
    globalThis.fetch = (async (input) => {
      if (String(input).endsWith('/api/v1/workspace')) return json(workspace);
      if (String(input).includes('/automation-runs')) return json({ items: [], total: 0 });
      resourceAttempts += 1;
      if (resourceAttempts === 1) return json({ error: 'SQLite 忙' }, 500);
      return json(resources([]));
    }) as typeof fetch;
    render(<AutomationManager wakerId="waker-one" notify={() => {}} />);
    assert.ok(await screen.findByRole('alert'));
    fireEvent.click(screen.getByRole('button', { name: /重试/ }));
    assert.ok(await screen.findByRole('heading', { name: '还没有自动任务' }));
  });

  it('忽略 Waker 切换后晚到的旧请求', async () => {
    const automationTwo: WakerAutomation = {
      ...AUTOMATION,
      id: 'automation-two',
      wakerId: 'waker-two',
      name: '第二个 Waker 的任务',
    };
    let resolveOld!: (response: Response) => void;
    const oldResources = new Promise<Response>((resolve) => {
      resolveOld = resolve;
    });
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith('/api/v1/workspace')) return json(workspace);
      if (url.includes('/automation-runs')) return json({ items: [], total: 0 });
      if (url.includes('wakerId=waker-one')) return oldResources;
      return json(resources([automationTwo], [{ ...PROJECT, wakerId: 'waker-two' }]));
    }) as typeof fetch;
    const view = render(<AutomationManager wakerId="waker-one" notify={() => {}} />);
    view.rerender(<AutomationManager wakerId="waker-two" notify={() => {}} />);
    assert.ok(await screen.findByRole('heading', { name: automationTwo.name }));

    resolveOld(json(resources([AUTOMATION])));
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(screen.getByRole('heading', { name: automationTwo.name }));
    assert.equal(screen.queryByRole('heading', { name: AUTOMATION.name }), null);
  });

  it('暂停只阻止计划触发，仍可手动运行', async () => {
    const paused = { ...AUTOMATION, enabled: false, lifecycle: 'paused' as const };
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith('/api/v1/workspace')) return json(workspace);
      if (url.includes('/automation-runs')) return json({ items: [], total: 0 });
      return json(resources([paused]));
    }) as typeof fetch;
    render(<AutomationManager wakerId="waker-one" notify={() => {}} />);
    const runNow = await screen.findByRole('button', { name: '立即运行' });
    assert.equal((runNow as HTMLButtonElement).disabled, false);
    assert.ok(screen.getByRole('button', { name: '恢复' }));
  });

  it('保存校验失败在编辑器内显示', async () => {
    const notices: Array<{ text: string; tone?: string }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/v1/workspace')) return json(workspace);
      if (url.includes('/automation-runs')) return json({ items: [], total: 0 });
      if (init?.method === 'PATCH') return json({ error: 'Cron 表达式无效' }, 400);
      return json(resources([AUTOMATION]));
    }) as typeof fetch;
    render(
      <AutomationManager
        wakerId="waker-one"
        notify={(text, tone) => notices.push({ text, tone })}
      />,
    );
    await screen.findByRole('heading', { name: AUTOMATION.name });
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.click(screen.getByRole('button', { name: /保存/ }));
    const message = await screen.findByText('Cron 表达式无效');
    assert.equal(message.getAttribute('role'), 'alert');
    assert.deepEqual(notices.at(-1), { text: 'Cron 表达式无效', tone: 'error' });
  });

  it('390px 下改为单列并保留 44px 操作目标', () => {
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
    const mobileRules = css.slice(css.lastIndexOf('@media (max-width: 760px)'));
    assert.match(
      mobileRules,
      /\.automation-workspace\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/s,
    );
    assert.match(mobileRules, /\.automation-list\s*\{[^}]*overflow-x:\s*auto;/s);
    assert.match(mobileRules, /\.legacy-button,[^}]*min-height:\s*44px;/s);
  });

  it('本地时间编辑不改变持久化时刻，并显示紧凑耗时', () => {
    const iso = '2026-08-28T02:03:00.000Z';
    assert.equal(isoForLocalInput(localInputForIso(iso)), iso);
    assert.equal(
      formatRunDuration({ ...RUNS[2]!, startedAt: iso, completedAt: '2026-08-28T02:04:09.000Z' }),
      '1m 9s',
    );
  });
});
