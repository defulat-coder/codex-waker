import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type {
  LocalResourcesResponse,
  MemoryDocument,
  WakerProject,
} from '@waker/contracts';
import { MemoryView } from './MemoryView.js';

const originalFetch = globalThis.fetch;

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

const WAKER_MEMORY: MemoryDocument = {
  id: 'mem-waker',
  scope: { type: 'waker', id: 'waker-one' },
  source: 'manual',
  title: '个人偏好',
  content: '个人范围的记忆',
  version: 1,
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:00.000Z',
};

const PROJECT_MEMORY: MemoryDocument = {
  id: 'mem-project',
  scope: { type: 'project', id: 'project-one' },
  source: 'manual',
  title: '项目约定',
  content: '项目范围的记忆',
  version: 2,
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:00.000Z',
};

function resources(projects: WakerProject[]): LocalResourcesResponse {
  return { projects, automations: [], workflows: [], channels: [], tasks: [] };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function memoriesFor(url: string): MemoryDocument[] {
  const query = new URLSearchParams(url.slice(url.indexOf('?') + 1));
  const scope = `${query.get('scopeType')}:${query.get('scopeId')}`;
  if (scope === 'waker:waker-one') return [WAKER_MEMORY];
  if (scope === 'project:project-one') return [PROJECT_MEMORY];
  return [];
}

type Call = { method: string; url: string; body?: Record<string, unknown> };

function mockFetch(calls: Call[], projects: WakerProject[] = [PROJECT]): void {
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    calls.push({ method, url, body });
    if (url.includes('/local-resources')) return json(resources(projects));
    if (url.includes('/api/v1/memory/timeline')) return json({ items: [], total: 0 });
    if (url.endsWith('/versions') || url.endsWith('/snapshots')) return json({ items: [] });
    if (url === '/api/v1/memories' && method === 'POST')
      return json({ ...PROJECT_MEMORY, ...(body as object), id: 'mem-created' }, 201);
    if (url.includes('/api/v1/memories?'))
      return json({ items: memoriesFor(url), total: memoriesFor(url).length });
    return json({ error: `unexpected request: ${method} ${url}` }, 500);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('MemoryView 范围筛选', () => {
  it('默认个人范围，切换项目后按新 scope 拉取且列表隔离', async () => {
    const calls: Call[] = [];
    mockFetch(calls);
    render(<MemoryView wakerId="waker-one" onClose={() => {}} notify={() => {}} />);

    assert.ok(await screen.findByRole('button', { name: /个人偏好/ }));
    const scoped = (type: string, id: string, path: string) =>
      calls.some(
        (call) =>
          call.url.includes(path) &&
          call.url.includes(`scopeType=${type}`) &&
          call.url.includes(`scopeId=${id}`),
      );
    assert.ok(scoped('waker', 'waker-one', '/api/v1/memories?'));
    assert.ok(scoped('waker', 'waker-one', '/api/v1/memory/timeline'));

    fireEvent.click(screen.getByRole('tab', { name: '项目' }));
    assert.ok(await screen.findByRole('button', { name: /项目约定/ }));
    assert.equal(screen.queryByRole('button', { name: /个人偏好/ }), null);
    assert.ok(scoped('project', 'project-one', '/api/v1/memories?'));
    assert.ok(scoped('project', 'project-one', '/api/v1/memory/timeline'));
    assert.equal(
      (screen.getByLabelText('选择项目') as HTMLSelectElement).value,
      'project-one',
    );

    fireEvent.click(screen.getByRole('tab', { name: '个人' }));
    assert.ok(await screen.findByRole('button', { name: /个人偏好/ }));
    assert.equal(screen.queryByRole('button', { name: /项目约定/ }), null);
  });

  it('新建记忆提交当前选中的项目 scope', async () => {
    const calls: Call[] = [];
    const notices: Array<{ text: string; tone?: string }> = [];
    mockFetch(calls);
    render(
      <MemoryView
        wakerId="waker-one"
        onClose={() => {}}
        notify={(text, tone) => notices.push({ text, tone })}
      />,
    );
    await screen.findByRole('button', { name: /个人偏好/ });

    fireEvent.click(screen.getByRole('tab', { name: '项目' }));
    await screen.findByRole('button', { name: /项目约定/ });
    fireEvent.click(screen.getByRole('button', { name: '新建记忆' }));
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '新项目记忆' } });
    fireEvent.change(screen.getByLabelText('来源'), { target: { value: 'manual' } });
    fireEvent.change(screen.getByLabelText('内容'), { target: { value: '正文' } });
    fireEvent.click(screen.getByRole('button', { name: /保存/ }));

    const post = calls.find((call) => call.method === 'POST' && call.url === '/api/v1/memories');
    assert.ok(post);
    assert.deepEqual(post?.body?.scope, { type: 'project', id: 'project-one' });
    await waitFor(() =>
      assert.deepEqual(notices.at(-1), { text: '记忆已保存', tone: 'success' }),
    );
  });

  it('当前 Waker 没有项目时显示空态且不按项目 scope 拉取', async () => {
    const calls: Call[] = [];
    mockFetch(calls, []);
    render(<MemoryView wakerId="waker-one" onClose={() => {}} notify={() => {}} />);
    await screen.findByRole('button', { name: /个人偏好/ });

    fireEvent.click(screen.getByRole('tab', { name: '项目' }));
    assert.ok(await screen.findByText('当前 Waker 还没有项目，请先在「项目」页创建。'));
    assert.ok(screen.getByText('还没有记忆'));
    assert.equal(screen.queryByRole('button', { name: /个人偏好/ }), null);
    assert.equal(calls.some((call) => call.url.includes('scopeType=project')), false);
    assert.ok(
      (screen.getByRole('button', { name: '新建记忆' }) as HTMLButtonElement).disabled,
    );
  });

  it('项目下拉仅列当前 Waker 所有的项目', async () => {
    const foreign: WakerProject = {
      ...PROJECT,
      id: 'project-foreign',
      wakerId: 'waker-two',
      name: '其他 Waker 的公开项目',
      visibility: 'public',
    };
    const calls: Call[] = [];
    mockFetch(calls, [PROJECT, foreign]);
    render(<MemoryView wakerId="waker-one" onClose={() => {}} notify={() => {}} />);
    await screen.findByRole('button', { name: /个人偏好/ });

    fireEvent.click(screen.getByRole('tab', { name: '项目' }));
    const select = await screen.findByLabelText('选择项目');
    assert.ok(select.textContent?.includes('工作台'));
    assert.equal(select.textContent?.includes('其他 Waker 的公开项目'), false);
  });

  it('群组范围在本地模式禁用', async () => {
    const calls: Call[] = [];
    mockFetch(calls);
    render(<MemoryView wakerId="waker-one" onClose={() => {}} notify={() => {}} />);
    await screen.findByRole('button', { name: /个人偏好/ });
    const tab = screen.getByRole('tab', { name: '群组' }) as HTMLButtonElement;
    assert.ok(tab.disabled);
    assert.equal(tab.title, '云端多 Waker 群组在本地模式不可用');
  });

  it('范围 tabs 使用 roving focus 并跳过禁用群组', async () => {
    const calls: Call[] = [];
    mockFetch(calls);
    render(<MemoryView wakerId="waker-one" onClose={() => {}} notify={() => {}} />);
    await screen.findByRole('button', { name: /个人偏好/ });
    const personal = screen.getByRole('tab', { name: '个人' });
    const project = screen.getByRole('tab', { name: '项目' });
    const group = screen.getByRole('tab', { name: '群组' });
    assert.equal(personal.tabIndex, 0);
    assert.equal(project.tabIndex, -1);
    assert.equal(group.tabIndex, -1);

    personal.focus();
    fireEvent.keyDown(personal, { key: 'ArrowRight' });
    assert.equal(document.activeElement, project);
    assert.equal(project.getAttribute('aria-selected'), 'true');
    assert.ok(screen.getByRole('tabpanel', { name: '项目' }));

    fireEvent.keyDown(project, { key: 'ArrowRight' });
    assert.equal(document.activeElement, personal);
    assert.equal(personal.getAttribute('aria-selected'), 'true');
  });
});
