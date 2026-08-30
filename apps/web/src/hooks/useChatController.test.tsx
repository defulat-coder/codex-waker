import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useChatController } from './useChatController.js';

/** useChatController 经 streamChat 走全局 fetch 消费 SSE；测试在 fetch 这一层打桩。 */

const originalFetch = globalThis.fetch;

const MODEL = {
  provider: 'kimi-coding',
  model: 'kimi-for-coding',
  thinkingLevel: 'minimal',
} as const;

/** 可手动推进的 SSE 响应流：emit 推事件、close 结束、fail 让 reader 拒绝。 */
function sseChannel() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(stream),
    emit(event: string, data: unknown) {
      controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    },
    close() {
      controller.close();
    },
    fail(error: Error) {
      controller.error(error);
    },
  };
}

function setup() {
  const notifications: Array<{ text: string; tone?: string }> = [];
  const settled: string[] = [];
  const view = renderHook(() =>
    useChatController({
      notify: (text, tone) => notifications.push({ text, tone }),
      onTurnSettled: (agentId) => settled.push(agentId),
    }),
  );
  return { ...view, notifications, settled };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('useChatController', () => {
  it('新会话正常流：start 迁移草稿线程，delta 依次上屏，done 落定', async () => {
    const channel = sseChannel();
    globalThis.fetch = (async () => channel.response) as typeof fetch;
    const { result, settled } = setup();

    act(() => result.current.send('你好', 'agent-one'));
    assert.ok(result.current.liveTurn, 'send 后 liveTurn 应立即存在');
    assert.deepEqual(
      result.current.threadMessages.map((message) => [message.role, message.text]),
      [
        ['user', '你好'],
        ['assistant', ''],
      ],
      '草稿线程应立即承载用户消息与流式占位',
    );

    await act(async () => {
      channel.emit('start', { sessionId: 's1', agentId: 'agent-one', model: MODEL });
    });
    assert.equal(result.current.currentSessionId, 's1', 'start 后草稿线程迁移到服务端 sessionId');

    await act(async () => {
      channel.emit('sources', {
        sources: [
          {
            index: 1,
            notebookId: 'notes',
            documentId: 'guide',
            documentVersion: 1,
            chunkId: 'guide:1:0',
            title: '指南',
            startLine: 1,
            endLine: 4,
            excerpt: '来源片段',
            matchMode: 'hybrid',
            score: 0.8,
          },
        ],
      });
      channel.emit('text_delta', { delta: '你好' });
      channel.emit('text_delta', { delta: '世界' });
    });
    assert.equal(result.current.liveTurn?.answer, '你好世界');
    assert.equal(
      result.current.threadMessages[1]!.text,
      '你好世界',
      'liveTurn 增量叠加到 assistant 消息',
    );

    await act(async () => {
      channel.emit('done', { answer: '你好世界' });
      channel.close();
    });
    assert.equal(result.current.liveTurn, null);
    const assistant = result.current.threadMessages[1]!;
    assert.equal(assistant.text, '你好世界');
    assert.equal(assistant.streaming, false);
    assert.equal(assistant.sources?.[0]?.documentId, 'guide');
    assert.equal(assistant.model?.model, 'kimi-for-coding');
    assert.deepEqual(settled, ['agent-one']);
  });

  it('新会话首轮把浏览器附件随 ChatRequest 发送，并只在 done 后确认消费', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const channel = sseChannel();
    globalThis.fetch = (async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return channel.response;
    }) as typeof fetch;
    const { result } = setup();
    let consumed = 0;

    act(() => {
      const accepted = result.current.send(
        '读取附件',
        'agent-one',
        undefined,
        undefined,
        undefined,
        () => {
          consumed += 1;
        },
        undefined,
        [{ originalName: 'guide.txt', mimeType: 'text/plain', dataBase64: 'aGVsbG8=' }],
      );
      assert.equal(accepted, true);
    });
    assert.equal(bodies[0]!.sessionId, undefined);
    assert.deepEqual(bodies[0]!.attachments, [
      { originalName: 'guide.txt', mimeType: 'text/plain', dataBase64: 'aGVsbG8=' },
    ]);
    assert.equal(consumed, 0);

    await act(async () => {
      channel.emit('start', {
        sessionId: 'attachment-session',
        agentId: 'agent-one',
        model: MODEL,
      });
      channel.emit('done', { answer: '已读取' });
      channel.close();
    });
    assert.equal(result.current.currentSessionId, 'attachment-session');
    assert.equal(consumed, 1);
  });

  it('start 之前失败：用户消息与错误留在草稿线程，并触发 notify', async () => {
    const bodies: string[] = [];
    globalThis.fetch = (async (_url, init) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ error: '模型不在可用列表中' }), { status: 400 });
    }) as typeof fetch;
    const { result, notifications, settled } = setup();

    act(() => result.current.send('保留我', 'agent-one'));
    // 先等 React 把 finalize 的错误状态渲染出来，再断言同步发生的 notify，避免轮询竞态。
    await waitFor(() =>
      assert.equal(result.current.threadMessages[1]?.error, '模型不在可用列表中'),
    );
    assert.deepEqual(notifications.at(-1), {
      text: '模型不在可用列表中',
      tone: 'error',
    });

    const [user, assistant] = result.current.threadMessages;
    assert.equal(user!.text, '保留我', '用户消息不能静默丢失');
    assert.equal(assistant!.error, '模型不在可用列表中');
    assert.equal(assistant!.streaming, false);
    assert.equal(result.current.liveTurn, null);
    assert.ok(result.current.currentSessionId, '草稿线程成为当前会话');
    assert.deepEqual(settled, ['agent-one']);

    // 从草稿线程重发：仍按新会话请求（不带 sessionId），start 后整体迁移到真实 sessionId。
    const channel = sseChannel();
    globalThis.fetch = (async (_url, init) => {
      bodies.push(String(init?.body));
      return channel.response;
    }) as typeof fetch;
    act(() => result.current.send('再来一次', 'agent-one'));
    assert.equal(JSON.parse(bodies[1]!).sessionId, undefined);

    await act(async () => {
      channel.emit('start', { sessionId: 's2', agentId: 'agent-one', model: MODEL });
      channel.emit('done', { answer: '好的' });
      channel.close();
    });
    assert.equal(result.current.currentSessionId, 's2');
    assert.deepEqual(
      result.current.threadMessages.map((message) => [
        message.role,
        message.text,
        message.error ?? '',
      ]),
      [
        ['user', '保留我', ''],
        ['assistant', '', '模型不在可用列表中'],
        ['user', '再来一次', ''],
        ['assistant', '好的', ''],
      ],
      '草稿线程的失败现场随迁移保留',
    );
  });

  it('interrupt 中止进行中的 turn：消息标记 interrupted，liveTurn 清空', async () => {
    const channel = sseChannel();
    globalThis.fetch = (async (_url, init) => {
      init?.signal?.addEventListener('abort', () =>
        channel.fail(new DOMException('The operation was aborted', 'AbortError')),
      );
      return channel.response;
    }) as typeof fetch;
    const { result } = setup();

    act(() => result.current.send('打断我', 'agent-one'));
    await act(async () => {
      channel.emit('start', { sessionId: 's3', agentId: 'agent-one', model: MODEL });
      channel.emit('text_delta', { delta: '半句' });
      channel.emit('tool', {
        phase: 'start',
        toolCallId: 'pending-command',
        toolName: 'command_execution',
      });
    });
    assert.equal(result.current.liveTurn?.answer, '半句');

    act(() => result.current.interrupt());
    await waitFor(() => {
      const assistant = result.current.threadMessages[1];
      assert.equal(assistant?.interrupted, true);
    });
    assert.equal(result.current.liveTurn, null);
    const assistant = result.current.threadMessages[1]!;
    assert.equal(assistant.text, '半句');
    assert.equal(assistant.streaming, false);
    assert.equal(assistant.tools?.[0]?.status, 'cancelled');
  });

  it('显式 targetSessionId：跳过当前会话推导，直接落到指定会话', async () => {
    const bodies: string[] = [];
    const channel = sseChannel();
    globalThis.fetch = (async (url, init) => {
      const href = String(url);
      if (href.includes('/chat')) {
        bodies.push(String(init?.body));
        return channel.response;
      }
      if (href.includes('/sessions/s1/messages')) {
        return new Response(
          JSON.stringify({
            items: [
              { id: 'm1', role: 'user', content: '历史问题', timestamp: '2026-01-01T00:00:00Z' },
              {
                id: 'm2',
                role: 'assistant',
                content: '历史回答',
                timestamp: '2026-01-01T00:00:01Z',
              },
            ],
          }),
        );
      }
      throw new Error(`unexpected fetch: ${href}`);
    }) as typeof fetch;
    const { result, settled } = setup();

    act(() => result.current.openSession('agent-one', 's1'));
    await waitFor(() => assert.equal(result.current.threadMessages.length, 2));

    // 收件箱恢复动作的调用形态：当前打开的是 s1，但本轮显式发到 s9。
    act(() => result.current.send('再试一次', 'agent-one', undefined, 's9'));
    assert.equal(
      JSON.parse(bodies[0]!).sessionId,
      's9',
      '显式 targetSessionId 直接作为请求 sessionId',
    );
    assert.equal(result.current.currentSessionId, 's1', '不改变当前会话');
    assert.deepEqual(
      result.current.threadMessages.map((message) => message.text),
      ['历史问题', '历史回答'],
      '当前线程不被追加',
    );

    await act(async () => {
      channel.emit('done', { answer: '好了' });
      channel.close();
    });
    assert.deepEqual(settled, ['agent-one']);

    // 目标会话的线程已在本地建好：打开时不回源重拉，直接呈现本轮消息。
    act(() => result.current.openSession('agent-one', 's9'));
    assert.deepEqual(
      result.current.threadMessages.map((message) => [message.role, message.text]),
      [
        ['user', '再试一次'],
        ['assistant', '好了'],
      ],
    );
  });

  it('interrupt 后同一事件循环内可立即 send，旧轮次的收尾不会清新一轮的 liveTurn', async () => {
    const channels: Array<ReturnType<typeof sseChannel>> = [];
    globalThis.fetch = (async (url, init) => {
      const href = String(url);
      if (href.includes('/chat')) {
        const channel = sseChannel();
        channels.push(channel);
        init?.signal?.addEventListener('abort', () =>
          channel.fail(new DOMException('The operation was aborted', 'AbortError')),
        );
        return channel.response;
      }
      if (href.includes('/messages')) return new Response(JSON.stringify({ items: [] }));
      throw new Error(`unexpected fetch: ${href}`);
    }) as typeof fetch;
    const { result } = setup();

    act(() => result.current.send('第一轮', 'agent-one'));
    assert.ok(result.current.liveTurn);

    // 收件箱恢复动作的调用形态：先 interrupt 清场，紧接着（同一 act）发起新一轮。
    act(() => {
      result.current.interrupt();
      result.current.send('第二轮', 'agent-one');
    });
    assert.equal(channels.length, 2, 'interrupt 后紧接着的 send 不应被 liveTurn 守卫吞掉');

    await act(async () => undefined); // 让被中断轮次的 catch/finally 跑完
    assert.ok(result.current.liveTurn, '旧轮次的 finally 不应清新一轮的 liveTurn');

    await act(async () => {
      channels[1]!.emit('done', { answer: '第二轮回答' });
      channels[1]!.close();
    });
    assert.equal(result.current.liveTurn, null);
    assert.equal(result.current.threadMessages.at(-1)!.text, '第二轮回答');
  });

  it('流中途断线后自动回放服务端已持久化的内容，补齐本地截断的回答', async () => {
    const channel = sseChannel();
    globalThis.fetch = (async (url) => {
      const href = String(url);
      if (href.includes('/chat')) return channel.response;
      if (href.includes('/sessions/s9/messages')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: 'm1',
                role: 'user',
                content: '断线前的问题',
                timestamp: '2026-01-01T00:00:00Z',
              },
              {
                id: 'm2',
                role: 'assistant',
                content: '服务端补全的完整回答',
                timestamp: '2026-01-01T00:00:01Z',
              },
            ],
          }),
        );
      }
      throw new Error(`unexpected fetch: ${href}`);
    }) as typeof fetch;
    const { result, notifications } = setup();

    act(() => result.current.send('断线前的问题', 'agent-one'));
    await act(async () => {
      channel.emit('start', { sessionId: 's9', agentId: 'agent-one', model: MODEL });
      channel.emit('text_delta', { delta: '半句' });
    });
    assert.equal(result.current.liveTurn?.answer, '半句');

    await act(async () => {
      channel.fail(new Error('network down'));
    });
    await waitFor(() =>
      assert.equal(result.current.threadMessages[1]?.text, '服务端补全的完整回答'),
    );
    const [user, assistant] = result.current.threadMessages;
    assert.equal(user!.text, '断线前的问题');
    assert.ok(!assistant!.streaming, '重放后不再是流式占位');
    assert.equal(assistant!.error, undefined, '服务端完整落盘时不保留错误标记');
    assert.deepEqual(notifications, [], '已知 sessionId 的失败走重放，不再 toast');
    assert.equal(result.current.liveTurn, null);
  });

  it('断线重放保留服务端持久化的 error 标记；重放失败时维持本地错误现场', async () => {
    const channel = sseChannel();
    globalThis.fetch = (async (url) => {
      const href = String(url);
      if (href.includes('/chat')) return channel.response;
      if (href.includes('/sessions/s10/messages')) {
        return new Response(
          JSON.stringify({
            items: [
              { id: 'm1', role: 'user', content: '问题', timestamp: '2026-01-01T00:00:00Z' },
              {
                id: 'm2',
                role: 'assistant',
                content: '写到一半的持久化内容',
                stopReason: 'error',
                errorMessage: '上游超时',
                timestamp: '2026-01-01T00:00:01Z',
              },
            ],
          }),
        );
      }
      throw new Error(`unexpected fetch: ${href}`);
    }) as typeof fetch;
    const { result } = setup();

    act(() => result.current.send('问题', 'agent-one'));
    await act(async () => {
      channel.emit('start', { sessionId: 's10', agentId: 'agent-one', model: MODEL });
    });
    await act(async () => {
      channel.fail(new Error('network down'));
    });
    await waitFor(() => assert.equal(result.current.threadMessages[1]?.error, '上游超时'));
    assert.equal(
      result.current.threadMessages[1]!.text,
      '写到一半的持久化内容',
      '服务端持久化内容覆盖流式占位',
    );

    // 重放请求本身失败：静默降级，线程维持 finalize 后的本地错误现场。
    act(() => result.current.closeSession());
    const failing = sseChannel();
    globalThis.fetch = (async (url) => {
      const href = String(url);
      if (href.includes('/chat')) return failing.response;
      if (href.includes('/sessions/s11/messages')) return new Response('boom', { status: 500 });
      throw new Error(`unexpected fetch: ${href}`);
    }) as typeof fetch;
    act(() => result.current.send('再来', 'agent-one'));
    await act(async () => {
      failing.emit('start', { sessionId: 's11', agentId: 'agent-one', model: MODEL });
      failing.emit('text_delta', { delta: '本地增量' });
    });
    await act(async () => {
      failing.fail(new Error('network down'));
    });
    await waitFor(() => assert.equal(result.current.threadMessages.at(-1)?.error, 'network down'));
    assert.equal(
      result.current.threadMessages.at(-1)!.text,
      '本地增量',
      '重放失败时保留本地已收到的增量与错误',
    );
  });

  it('openSession 回放历史，closeSession 清空当前视图状态', async () => {
    globalThis.fetch = (async (url) => {
      const href = String(url);
      if (href.includes('/sessions/s1/messages')) {
        return new Response(
          JSON.stringify({
            items: [
              { id: 'm1', role: 'user', content: '历史问题', timestamp: '2026-01-01T00:00:00Z' },
              {
                id: 'm2',
                role: 'assistant',
                content: '历史回答',
                timestamp: '2026-01-01T00:00:01Z',
              },
            ],
          }),
        );
      }
      if (href.includes('/sessions/s4/messages')) {
        return new Response(
          JSON.stringify({
            items: [
              { id: 'm3', role: 'user', content: '另一条线', timestamp: '2026-01-01T00:00:02Z' },
            ],
          }),
        );
      }
      throw new Error(`unexpected fetch: ${href}`);
    }) as typeof fetch;

    const { result } = setup();
    act(() => result.current.openSession('agent-one', 's1'));
    await waitFor(() => assert.equal(result.current.threadMessages.length, 2));
    assert.equal(result.current.threadMessages[0]!.text, '历史问题');

    act(() => result.current.openSession('agent-one', 's4'));
    assert.equal(result.current.currentSessionId, 's4');
    await waitFor(() =>
      assert.deepEqual(
        result.current.threadMessages.map((message) => message.text),
        ['另一条线'],
      ),
    );

    act(() => result.current.closeSession());
    assert.equal(result.current.currentSessionId, null);
    assert.deepEqual(result.current.threadMessages, []);
  });

  it('SSE error 帧的 kind/resetAt 落进消息，回放路径也映射 errorKind', async () => {
    const channel = sseChannel();
    globalThis.fetch = (async (url) => {
      const href = String(url);
      if (href.includes('/chat')) return channel.response;
      // 对齐重放失败：本地错误现场保留，error 帧携带的分类不落空。
      if (href.includes('/sessions/s12/messages')) return new Response('boom', { status: 500 });
      throw new Error(`unexpected fetch: ${href}`);
    }) as typeof fetch;
    const { result } = setup();

    act(() => result.current.send('问题', 'agent-one'));
    await act(async () => {
      channel.emit('start', { sessionId: 's12', agentId: 'agent-one', model: MODEL });
      channel.emit('error', {
        error: 'quota exceeded，将于 2026-09-01T00:00:00Z 重置',
        kind: 'quota',
        resetAt: '2026-09-01T00:00:00Z',
      });
      channel.close();
    });

    await waitFor(() => assert.equal(result.current.threadMessages[1]?.errorKind, 'quota'));
    assert.equal(result.current.threadMessages[1]?.errorResetAt, '2026-09-01T00:00:00Z');
    assert.equal(
      result.current.threadMessages[1]?.error,
      'quota exceeded，将于 2026-09-01T00:00:00Z 重置',
    );
  });

  it('openSession 回放把服务端 errorKind/errorResetAt 映射到消息', async () => {
    globalThis.fetch = (async (url) => {
      const href = String(url);
      if (href.includes('/sessions/s20/messages')) {
        return new Response(
          JSON.stringify({
            items: [
              { id: 'm1', role: 'user', content: '问题', timestamp: '2026-01-01T00:00:00Z' },
              {
                id: 'm2',
                role: 'assistant',
                content: '',
                stopReason: 'error',
                errorMessage: 'Request timeout after 30s',
                errorKind: 'timeout',
                timestamp: '2026-01-01T00:00:01Z',
              },
            ],
          }),
        );
      }
      throw new Error(`unexpected fetch: ${href}`);
    }) as typeof fetch;
    const { result } = setup();

    act(() => result.current.openSession('agent-one', 's20'));
    await waitFor(() => assert.equal(result.current.threadMessages.length, 2));
    const assistant = result.current.threadMessages[1]!;
    assert.equal(assistant.error, 'Request timeout after 30s');
    assert.equal(assistant.errorKind, 'timeout');
    assert.equal(assistant.errorResetAt, undefined);
  });
});
