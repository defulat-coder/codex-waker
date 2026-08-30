import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { InboxItem, SessionSummary } from '@waker/contracts';
import App from './App.js';

/** App 级测试：全量 fetch 桩，聚焦「工作区加载 → 打开会话回放历史」的数据通路。 */

const originalFetch = globalThis.fetch;

const AGENT = {
  id: 'agent-one',
  name: 'Nova',
  mark: 'No',
  tagline: '',
  description: '',
  suggestions: [],
};

const S1: SessionSummary = {
  id: 's1',
  agentId: 'agent-one',
  title: '排查构建失败',
  createdAt: '2026-08-21T08:00:00.000Z',
  updatedAt: '2026-08-21T09:00:00.000Z',
  questionCount: 1,
  needsAttention: false,
};
const S2: SessionSummary = { ...S1, id: 's2', title: '整理文档' };

const INBOX_ITEM: InboxItem = { ...S1, read: false };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function sseChannel() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  return {
    response: new Response(
      new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
        },
      }),
    ),
    emit(event: string, data: unknown) {
      controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    },
    close() {
      controller.close();
    },
  };
}

type FetchCall = { method: string; url: string; body?: string };

function stubFetch(agents = [AGENT]): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? String(init.body) : undefined });
    if (url.includes('/messages'))
      return jsonResponse({
        items: [{ id: 'm1', role: 'user', content: '你好', timestamp: S1.createdAt }],
      });
    if (url.includes('/api/v1/inbox'))
      return jsonResponse({ items: [INBOX_ITEM], total: 1, unreadCount: 1 });
    if (url.includes('/api/v1/workspace'))
      return jsonResponse({
        agents,
        prompts: [],
        host: { name: 'test-host' },
        models: { current: {}, available: [] },
      });
    if (url.endsWith('/sessions')) return jsonResponse({ items: [S1, S2], total: 2 });
    if (url.includes('/api/v1/settings')) {
      return jsonResponse({
        model: { available: [] },
        thinkingLevel: 'medium',
        resources: { agents: 1, prompts: 0, skills: 0, appendSystem: false },
        workspace: { name: 'local-workspace', sessionDir: '.codex/sessions' },
      });
    }
    if (url.includes('/api/v1/preferences')) return jsonResponse({ items: {} });
    if (url.includes('/api/v1/local-resources'))
      return jsonResponse({
        projects: [],
        automations: [],
        workflows: [],
        channels: [],
        tasks: [],
      });
    return jsonResponse({});
  }) as typeof fetch;
  return calls;
}

async function openSession(title: string) {
  const chat = await screen.findByRole('button', { name: 'Chat' });
  if (chat.getAttribute('aria-current') !== 'page') fireEvent.click(chat);
  fireEvent.click(await screen.findByRole('button', { name: '任务列表' }));
  const row = await screen.findByRole('option', { name: new RegExp(title) });
  fireEvent.click(row);
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('App 会话视图', () => {
  it('挂载后加载工作区并拉取收件箱（未读徽标来自 unreadCount）', async () => {
    const calls = stubFetch();
    render(<App />);

    await waitFor(() =>
      assert.ok(
        calls.some((call) => call.url.includes('/api/v1/workspace')),
        '挂载后应拉取工作区',
      ),
    );
    await waitFor(() =>
      assert.ok(
        calls.some((call) => call.url.includes('/api/v1/inbox')),
        '挂载后应拉取收件箱',
      ),
    );
    assert.ok(await screen.findByRole('heading', { name: '我的Wakers' }));
    const badge = await screen.findByLabelText('1 个未读会话');
    assert.equal(badge.textContent, '1');
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    assert.ok(await screen.findByRole('complementary', { name: 'Chat 会话' }));
    assert.ok(screen.getByRole('option', { name: /Nova/ }));
  });

  it('点击会话行打开会话并回放历史消息', async () => {
    const calls = stubFetch();
    render(<App />);

    await openSession('排查构建失败');

    await waitFor(() =>
      assert.ok(
        calls.some((call) => call.url.includes('/sessions/s1/messages')),
        '打开会话应拉取历史消息',
      ),
    );
    assert.ok(await screen.findByText('你好'), '历史消息应渲染到会话区');
    await waitFor(() =>
      assert.equal(document.activeElement, screen.getByRole('combobox', { name: '消息输入框' })),
    );
    fireEvent.change(screen.getByRole('combobox', { name: '消息输入框' }), {
      target: { value: '上一会话草稿' },
    });

    await openSession('整理文档');
    await waitFor(() =>
      assert.ok(
        calls.some((call) => call.url.includes('/sessions/s2/messages')),
        '切换会话应拉取对应历史',
      ),
    );
    assert.equal(
      (screen.getByRole('combobox', { name: '消息输入框' }) as HTMLTextAreaElement).value,
      '',
    );
    fireEvent.change(screen.getByRole('combobox', { name: '消息输入框' }), {
      target: { value: '新会话前草稿' },
    });
    fireEvent.click(screen.getByRole('button', { name: '对话任务' }));
    assert.equal(
      (screen.getByRole('combobox', { name: '消息输入框' }) as HTMLTextAreaElement).value,
      '',
    );
  });

  it('切换 Waker 时清除原 Waker 的文本草稿', async () => {
    const secondAgent = { ...AGENT, id: 'agent-two', name: 'Atlas', mark: 'At' };
    stubFetch([AGENT, secondAgent]);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Chat' }));
    const input = screen.getByRole('combobox', { name: '消息输入框' });
    fireEvent.change(input, { target: { value: 'Nova 的私有草稿' } });

    fireEvent.click(screen.getByRole('option', { name: /Atlas/ }));

    assert.equal((input as HTMLTextAreaElement).value, '');
  });

  it('Waker 卡片的自动任务入口只导航，不直接创建调度', async () => {
    const calls = stubFetch();
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Waker 管理' }));
    fireEvent.click(await screen.findByRole('button', { name: '创建自动任务' }));

    assert.ok(await screen.findByRole('heading', { name: '自动任务' }));
    assert.equal(
      calls.some((call) => call.method === 'POST' && call.url.endsWith('/api/v1/automations')),
      false,
    );
  });

  it('创建 Waker 后保留管理上下文并提供三个真实下一步入口', async () => {
    const createdAgent = {
      ...AGENT,
      id: 'fresh-waker',
      name: 'Fresh Waker',
      tagline: '新建的本地 Waker',
    };
    let created = false;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/api/v1/agents') && method === 'POST') {
        created = true;
        return jsonResponse(createdAgent);
      }
      if (url.includes('/api/v1/agent-templates')) return jsonResponse({ items: [] });
      if (url.includes('/api/v1/workspace'))
        return jsonResponse({
          agents: created ? [AGENT, createdAgent] : [AGENT],
          prompts: [],
          host: { name: 'test-host' },
          models: { current: {}, available: [] },
        });
      if (url.includes('/api/v1/inbox'))
        return jsonResponse({ items: [], total: 0, unreadCount: 0 });
      if (url.includes('/api/v1/settings'))
        return jsonResponse({
          model: { available: [] },
          thinkingLevel: 'medium',
          resources: { agents: 1, prompts: 0, skills: 0, appendSystem: false },
          workspace: { name: 'waker', sessionDir: '.codex/sessions' },
        });
      if (url.includes('/api/v1/preferences')) return jsonResponse({ items: {} });
      if (url.includes('/api/v1/local-resources'))
        return jsonResponse({
          projects: [],
          automations: [],
          workflows: [],
          channels: [],
          tasks: [],
        });
      if (url.endsWith('/sessions')) return jsonResponse({ items: [], total: 0 });
      return jsonResponse({});
    }) as typeof fetch;

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Waker 管理' }));
    fireEvent.click(await screen.findByRole('button', { name: '新建Waker' }));
    fireEvent.change(screen.getByLabelText('名称 *'), {
      target: { value: 'Fresh Waker' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存并启用' }));

    assert.ok(await screen.findByRole('region', { name: 'Waker 已创建' }));
    assert.ok(screen.getByRole('button', { name: /进入 Chat/ }));
    assert.ok(screen.getByRole('button', { name: /绑定 Knowledge/ }));
    fireEvent.click(screen.getByRole('button', { name: /选择或创建 Project/ }));
    assert.ok(await screen.findByRole('heading', { name: '项目' }));
  });

  it('首轮开始后 Composer 跨 Welcome/Thread 保留附件，失败时不静默清理', async () => {
    const channel = sseChannel();
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith('/api/v1/chat')) return channel.response;
      if (url.includes('/api/v1/inbox'))
        return jsonResponse({ items: [], total: 0, unreadCount: 0 });
      if (url.includes('/api/v1/workspace'))
        return jsonResponse({
          agents: [AGENT],
          prompts: [],
          host: { name: 'test-host' },
          models: { current: {}, available: [] },
        });
      if (url.endsWith('/sessions')) return jsonResponse({ items: [], total: 0 });
      if (url.includes('/api/v1/settings'))
        return jsonResponse({
          model: { available: [] },
          thinkingLevel: 'medium',
          resources: { agents: 1, prompts: 0, skills: 0, appendSystem: false },
          workspace: { name: 'waker', sessionDir: '.codex/sessions' },
        });
      if (url.includes('/api/v1/preferences')) return jsonResponse({ items: {} });
      if (url.includes('/api/v1/local-resources'))
        return jsonResponse({
          projects: [],
          automations: [],
          workflows: [],
          channels: [],
          tasks: [],
        });
      if (url.includes('/messages')) return jsonResponse({ items: [] });
      return jsonResponse({});
    }) as typeof fetch;

    const view = render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Chat' }));
    await screen.findByText('你好，今天我能帮你什么？');
    const fileInput = view.container.querySelector(
      '.composer input[type="file"]',
    ) as HTMLInputElement;
    fireEvent.change(fileInput, {
      target: { files: [new File(['evidence'], 'first-turn.txt', { type: 'text/plain' })] },
    });
    assert.ok(await screen.findByText('first-turn.txt'));
    fireEvent.change(screen.getByLabelText('消息输入框'), { target: { value: '读取首轮附件' } });
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
    assert.ok(await screen.findByText('first-turn.txt'), '切到 Thread 分支后附件仍应存在');

    await act(async () => {
      channel.emit('start', {
        sessionId: 'first-turn-session',
        agentId: AGENT.id,
        model: { thinkingLevel: 'medium' },
      });
      channel.emit('error', { error: '模拟上游失败' });
      channel.close();
    });
    await waitFor(() => assert.ok(screen.queryAllByText('模拟上游失败').length >= 1));
    assert.ok(screen.getByText('first-turn.txt'), '失败后待发送附件必须保留以便重试');
  });
});
