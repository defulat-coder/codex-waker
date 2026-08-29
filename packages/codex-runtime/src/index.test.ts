import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentSessionStore,
  agentOutputLanguageInstruction,
  CodexTurnAbortedError,
  CodexTurnError,
  CodexThreadRegistry,
  KeyedExecutor,
  runAgentTurn,
  wrapThreadWithPersona,
  type CodexAgentSession,
  type CodexAgentSessionOptions,
} from './index.js';
import type { AgentDefinition } from './agents.js';
import type { CodexThreadEvent } from './events.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('KeyedExecutor', () => {
  it('serializes tasks per key while different keys stay parallel', async () => {
    const executor = new KeyedExecutor();
    const order: string[] = [];
    const gate = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

    await Promise.all([
      executor.run('a', async () => {
        order.push('a1:start');
        await gate();
        order.push('a1:end');
      }),
      executor.run('a', async () => {
        order.push('a2:start');
        await gate();
        order.push('a2:end');
      }),
      executor.run('b', async () => {
        order.push('b1:start');
        await gate();
        order.push('b1:end');
      }),
    ]);

    assert.ok(order.indexOf('a1:end') < order.indexOf('a2:start'), '同 key 的任务必须串行');
    assert.ok(order.indexOf('b1:start') < order.indexOf('a1:end'), '不同 key 的任务应并行');
  });

  it('propagates task errors without poisoning the queue', async () => {
    const executor = new KeyedExecutor();
    await assert.rejects(
      () =>
        executor.run('a', async () => {
          throw new Error('boom');
        }),
      /boom/,
    );
    assert.equal(await executor.run('a', async () => 'ok'), 'ok');
  });

  it('cancel() rejects tasks queued before it and spares running/later ones', async () => {
    const executor = new KeyedExecutor();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = executor.run('a', () => gate);
    // 任务体在 microtask 里才开始执行：先让 running 真正跑起来，cancel 才只覆盖排队任务。
    await new Promise((resolve) => setImmediate(resolve));
    const queued = executor.run('a', async () => 'queued');
    // 提前挂 handler，避免 reject 发生后才断言触发 unhandledRejection。
    const queuedAssertion = assert.rejects(queued, /已取消/);
    executor.cancel('a');
    // cancel 之后新排队的任务序号在标记之外，不受影响。
    const queuedAfter = executor.run('a', async () => 'queued-after');
    release();
    await running;
    await queuedAssertion;
    assert.equal(await queuedAfter, 'queued-after');
    // 空 key 的 cancel 是无操作，不应 throw。
    executor.cancel('never-queued');
  });
});

/**
 * 不触网的假会话工厂：thread.runStreamed 产出手写事件流，collectTurn 的全部依赖
 * 就是 runStreamed + store.bindThread + close。绝不构造真实 Codex 客户端。
 */
interface FakeState {
  calls: number;
  closes: string[];
  events: CodexThreadEvent[];
  gate?: Promise<void>;
  runStreamedError?: unknown;
  aborts?: number;
  store?: AgentSessionStore;
}

function abortError(): Error {
  return Object.assign(new Error('fake thread aborted'), { name: 'AbortError' });
}

function waitForGate(gate: Promise<void>, signal: AbortSignal | undefined, state: FakeState) {
  if (!signal) return gate;
  if (signal.aborted) {
    state.aborts = (state.aborts ?? 0) + 1;
    return Promise.reject(abortError());
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      state.aborts = (state.aborts ?? 0) + 1;
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void gate.then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function fakeFactory(state: FakeState) {
  return async (options: CodexAgentSessionOptions): Promise<CodexAgentSession> => {
    state.calls += 1;
    const tag = `${options.agentId}:${options.sessionId}#${state.calls}`;
    const session = {
      cwd: options.cwd ?? '',
      agentId: options.agentId,
      sessionId: options.sessionId ?? 's',
      thread: {
        id: null,
        run: () => Promise.reject(new Error('run not used in tests')),
        runStreamed: async (
          _input: Parameters<CodexAgentSession['thread']['runStreamed']>[0],
          turnOptions?: Parameters<CodexAgentSession['thread']['runStreamed']>[1],
        ) => {
          if (state.runStreamedError !== undefined) throw state.runStreamedError;
          const signal = turnOptions?.signal;
          return {
            events: (async function* (): AsyncGenerator<CodexThreadEvent> {
              if (state.gate) await waitForGate(state.gate, signal, state);
              const events = state.events.length
                ? state.events
                : [
                    {
                      type: 'item.completed' as const,
                      item: { type: 'agent_message' as const, id: 'default-message', text: 'ok' },
                    },
                  ];
              for (const event of events) yield event;
            })(),
          };
        },
      } as unknown as CodexAgentSession['thread'],
      store:
        state.store ??
        ({
          bindThread: () => Promise.reject(new Error('bindThread not expected')),
        } as unknown as AgentSessionStore),
      threadId: null,
      reasoningEffort: options.reasoningEffort ?? ('medium' as const),
      workingDirectory: options.workingDirectory ?? options.cwd ?? '',
      persistSession: Boolean(state.store),
      close: () => state.closes.push(tag),
      ...(options.model ? { model: options.model } : {}),
    };
    return session;
  };
}

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

describe('CodexThreadRegistry', () => {
  it('创建失败不缓存 rejected Promise：同 key 重试会重新创建', async () => {
    let calls = 0;
    const registry = new CodexThreadRegistry({
      createSession: (options) => {
        calls += 1;
        return Promise.reject(new Error(`Codex model not found: ${options.model}`));
      },
    });
    try {
      await assert.rejects(
        () => registry.run('agent-one', 'retry-session', '你好', {}, { model: 'no-such-model' }),
        /no-such-model/,
      );
      // 若 rejected Promise 被缓存，第二次仍会报 no-such-model；重新创建才会看到新的模型名。
      await assert.rejects(
        () => registry.run('agent-one', 'retry-session', '你好', {}, { model: 'still-missing' }),
        /still-missing/,
      );
      assert.equal(calls, 2);
      // 失败条目已摘除，abort 不应因残留的 rejected Promise 而上抛。
      await registry.abort('agent-one', 'retry-session');
    } finally {
      await registry.closeAll();
    }
  });

  it('streams a turn through the normalizer and returns answer + usage', async () => {
    const state: FakeState = {
      calls: 0,
      closes: [],
      events: [
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'turn.started' },
        { type: 'item.started', item: { type: 'agent_message', id: 'm1', text: '' } },
        { type: 'item.updated', item: { type: 'agent_message', id: 'm1', text: '你好' } },
        { type: 'item.updated', item: { type: 'reasoning', id: 'r1', text: '想' } },
        { type: 'item.completed', item: { type: 'agent_message', id: 'm1', text: '你好呀' } },
        {
          type: 'turn.completed',
          usage: { input_tokens: 3, cached_input_tokens: 0, output_tokens: 2 },
        },
      ],
    };
    const registry = new CodexThreadRegistry({ createSession: fakeFactory(state) });
    try {
      const deltas: string[] = [];
      const thinking: string[] = [];
      const result = await registry.run('agent-one', 's1', '打招呼', {
        onTextDelta: (delta) => deltas.push(delta),
        onThinkingDelta: (delta) => thinking.push(delta),
      });
      assert.equal(result.answer, '你好呀');
      assert.deepEqual(deltas, ['你好', '呀']);
      assert.deepEqual(thinking, ['想']);
      assert.deepEqual(result.usage, { input: 3, output: 2, total: 5 });
    } finally {
      await registry.closeAll();
    }
  });

  it('persists the thread.started id into the store binding on persisted sessions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-registry-'));
    roots.push(root);
    const store = new AgentSessionStore({ cwd: root });
    await store.createSession('agent-one', 'bound-session');
    const state: FakeState = {
      calls: 0,
      closes: [],
      store,
      events: [
        { type: 'thread.started', thread_id: 'thread-xyz' },
        { type: 'item.completed', item: { type: 'agent_message', id: 'm1', text: '收到' } },
        {
          type: 'turn.completed',
          usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
        },
      ],
    };
    const registry = new CodexThreadRegistry({ createSession: fakeFactory(state) });
    try {
      await registry.run('agent-one', 'bound-session', '你好', {
        sources: [
          {
            index: 1,
            notebookId: 'notes',
            documentId: 'guide',
            documentVersion: 1,
            chunkId: 'guide:1:0',
            title: 'guide.md',
            startLine: 1,
            endLine: 2,
            excerpt: '来源',
            matchMode: 'hybrid',
            score: 0.8,
          },
        ],
      });
      assert.equal(store.getEntry('bound-session')?.threadId, 'thread-xyz');
      assert.equal(store.workbench.listTurnSources('bound-session').get(1)?.[0]?.title, 'guide.md');
    } finally {
      await registry.closeAll();
    }
  });

  it('rejects a successful-looking stream that contains no assistant text', async () => {
    const state: FakeState = {
      calls: 0,
      closes: [],
      events: [
        { type: 'thread.started', thread_id: 'thread-empty' },
        {
          type: 'turn.completed',
          usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 0 },
        },
      ],
    };
    const registry = new CodexThreadRegistry({ createSession: fakeFactory(state) });
    try {
      await assert.rejects(
        () => registry.run('agent-one', 'empty-session', '你好'),
        (error: unknown) =>
          error instanceof CodexTurnError &&
          error.code === 'CODEX_STREAM_ERROR' &&
          /未返回可显示内容/.test(error.message),
      );
    } finally {
      await registry.closeAll();
    }
  });

  it('classifies runStreamed rejection, turn.failed and top-level error separately', async () => {
    const startFailure: FakeState = {
      calls: 0,
      closes: [],
      events: [],
      runStreamedError: new Error('spawn failed at /Users/private/work/.env'),
    };
    const startRegistry = new CodexThreadRegistry({ createSession: fakeFactory(startFailure) });
    await assert.rejects(
      () =>
        startRegistry.run('agent-one', 'start-fail', '你好', {}, { cwd: '/Users/private/work' }),
      (error) =>
        error instanceof CodexTurnError &&
        error.code === 'CODEX_RUN_STREAM_START_FAILED' &&
        error.message === 'spawn failed at ./.env',
    );
    await startRegistry.closeAll();

    const state: FakeState = {
      calls: 0,
      closes: [],
      events: [{ type: 'turn.failed', error: { message: '模型超时 /Users/private/work/log' } }],
    };
    const registry = new CodexThreadRegistry({ createSession: fakeFactory(state) });
    await assert.rejects(
      () => registry.run('agent-one', 's1', '你好', {}, { cwd: '/Users/private/work' }),
      (error) =>
        error instanceof CodexTurnError &&
        error.code === 'CODEX_TURN_FAILED' &&
        error.message === '模型超时 ./log',
    );
    await registry.closeAll();

    const streamFailure: FakeState = {
      calls: 0,
      closes: [],
      events: [{ type: 'error', message: 'JSONL stream broke' }],
    };
    const streamRegistry = new CodexThreadRegistry({ createSession: fakeFactory(streamFailure) });
    await assert.rejects(
      () => streamRegistry.run('agent-one', 'stream-fail', '你好'),
      (error) =>
        error instanceof CodexTurnError &&
        error.code === 'CODEX_STREAM_ERROR' &&
        error.message === 'JSONL stream broke',
    );
    await streamRegistry.closeAll();
  });

  it('删除会话：排队 turn 被取消不复活绑定，close 等进行中 turn 落定后才返回', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-registry-'));
    roots.push(root);
    const store = new AgentSessionStore({ cwd: root });
    await store.createSession('agent-one', 'doomed');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state: FakeState = {
      calls: 0,
      closes: [],
      store,
      gate,
      events: [
        { type: 'thread.started', thread_id: 'thread-doomed' },
        { type: 'item.completed', item: { type: 'agent_message', id: 'm1', text: '完成' } },
        {
          type: 'turn.completed',
          usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
        },
      ],
    };
    const registry = new CodexThreadRegistry({ createSession: fakeFactory(state) });
    try {
      const first = registry.run('agent-one', 'doomed', '进行中');
      await flushMicrotasks();
      assert.equal(state.calls, 1);
      const queued = registry.run('agent-one', 'doomed', '排队中');
      const queuedAssertion = assert.rejects(queued, /已取消/);

      // 与 DELETE 路由同序：先取消排队任务，再 close 等进行中 turn 落定，最后删绑定。
      registry.cancelQueued('agent-one', 'doomed');
      let closeReturned = false;
      const closing = registry.close('agent-one', 'doomed').then(() => {
        closeReturned = true;
      });
      await flushMicrotasks();
      assert.equal(closeReturned, false, '进行中的 turn 未 settle 前 close 不应返回');

      release();
      await first;
      await queuedAssertion;
      await closing;
      await store.deleteSession('doomed', 'agent-one');
      assert.equal(state.calls, 1, '排队 turn 不得在 getOrCreate 里重建会话');
      assert.equal(await store.getSession('doomed'), undefined, '删除后绑定不得复活');
    } finally {
      await registry.closeAll();
    }
  });

  it('abort signal stops the active fake turn, cancels queued work, and spares later turns', async () => {
    const gate = new Promise<void>(() => undefined);
    const state: FakeState = { calls: 0, closes: [], events: [], gate };
    const registry = new CodexThreadRegistry({ createSession: fakeFactory(state) });
    try {
      const first = registry.run('agent-one', 's-abort', '进行中');
      const firstAssertion = assert.rejects(
        first,
        (error) => error instanceof CodexTurnAbortedError && error.code === 'CODEX_TURN_ABORTED',
      );
      await flushMicrotasks();
      const queued = registry.run('agent-one', 's-abort', '排队中');
      const queuedAssertion = assert.rejects(queued, /已取消/);

      await registry.abort('agent-one', 's-abort');
      await firstAssertion;
      await queuedAssertion;
      assert.equal(state.aborts, 1, 'fake thread 必须实际观察到 AbortSignal');
      assert.equal(state.calls, 1, '被取消的排队 turn 不得执行任务体');

      // 断连后客户端立刻重发同一 session：新 turn 序号在 cancel 标记之外，照常执行。
      state.gate = undefined;
      await registry.run('agent-one', 's-abort', '新的 turn');
      assert.equal(state.calls, 1, '条目仍在，重发的 turn 复用同一 runtime');
    } finally {
      await registry.closeAll();
    }
  });

  it('closeAll isolates rejected session creation and still closes healthy runtimes', async () => {
    let rejectCreation!: (error: Error) => void;
    const rejectedSession = new Promise<CodexAgentSession>((_resolve, reject) => {
      rejectCreation = reject;
    });
    const healthyState: FakeState = { calls: 0, closes: [], events: [] };
    const healthyFactory = fakeFactory(healthyState);
    const registry = new CodexThreadRegistry({
      createSession: (options) =>
        options.sessionId === 'rejected' ? rejectedSession : healthyFactory(options),
    });

    const failedTurn = registry.run('agent-one', 'rejected', '不会开始');
    const failedAssertion = assert.rejects(failedTurn, /creation rejected/);
    await flushMicrotasks();
    await registry.run('agent-one', 'healthy', '正常');

    const closing = registry.closeAll();
    rejectCreation(new Error('creation rejected'));
    await failedAssertion;
    await closing;
    assert.deepEqual(healthyState.closes, ['agent-one:healthy#1']);
  });

  it('model/effort 变更时淘汰旧条目并重建 Thread（resumeThread 续上同一 session）', async () => {
    const state: FakeState = { calls: 0, closes: [], events: [] };
    const registry = new CodexThreadRegistry({ createSession: fakeFactory(state) });
    try {
      await registry.run('agent-one', 's1', '你好', {}, { reasoningEffort: 'low' });
      await registry.run('agent-one', 's1', '复读', {}, { reasoningEffort: 'low' });
      assert.equal(state.calls, 1, '配置不变的 turn 必须复用同一条目');

      await registry.run('agent-one', 's1', '换档', {}, { reasoningEffort: 'high' });
      assert.equal(state.calls, 2, 'effort 变更必须重建 Thread');
      await flushMicrotasks();
      assert.deepEqual(state.closes, ['agent-one:s1#1']);

      await registry.run(
        'agent-one',
        's1',
        '换模型',
        {},
        { reasoningEffort: 'high', model: 'other-model' },
      );
      assert.equal(state.calls, 3, 'model 变更同样重建');
      await registry.run(
        'agent-one',
        's1',
        '换工作目录',
        {},
        { reasoningEffort: 'high', model: 'other-model', workingDirectory: '/tmp/project' },
      );
      assert.equal(state.calls, 4, 'workingDirectory 变更同样重建');
    } finally {
      await registry.closeAll();
    }
  });
});

describe('runAgentTurn', () => {
  it('throws unless CODEX_AGENT_ENABLED=true', async () => {
    const saved = process.env.CODEX_AGENT_ENABLED;
    delete process.env.CODEX_AGENT_ENABLED;
    try {
      await assert.rejects(() => runAgentTurn('agent-one', 's1', '你好'), /未启用/);
    } finally {
      if (saved === undefined) delete process.env.CODEX_AGENT_ENABLED;
      else process.env.CODEX_AGENT_ENABLED = saved;
    }
  });
});

describe('首 turn 人设与 AI 回复语言注入', () => {
  const agent = { name: '测试 Waker', body: '你是测试人设。' } as AgentDefinition;

  function fakeThread() {
    const inputs: unknown[] = [];
    const thread = {
      id: null,
      run: (input: unknown) => {
        inputs.push(input);
        return Promise.resolve({});
      },
      runStreamed: (input: unknown) => {
        inputs.push(input);
        return Promise.resolve({ events: (async function* () {})() });
      },
    };
    return { thread: thread as unknown as Parameters<typeof wrapThreadWithPersona>[0], inputs };
  }

  it('agentOutputLanguageInstruction 只认 zh-CN/en-US，未设置或非法值不注入', () => {
    assert.match(agentOutputLanguageInstruction('zh-CN') ?? '', /简体中文 \(zh-CN\)/);
    assert.match(agentOutputLanguageInstruction('zh-CN') ?? '', /默认输出语言/);
    assert.match(agentOutputLanguageInstruction('en-US') ?? '', /English \(en-US\)/);
    assert.equal(agentOutputLanguageInstruction(undefined), undefined);
    assert.equal(agentOutputLanguageInstruction(''), undefined);
    assert.equal(agentOutputLanguageInstruction('fr-FR'), undefined);
  });

  it('设置语言时首 turn developer-instructions 含对应文案，后续 turn 不重复', async () => {
    const { thread, inputs } = fakeThread();
    const wrapped = wrapThreadWithPersona(
      thread,
      agent,
      true,
      agentOutputLanguageInstruction('zh-CN'),
    );
    await wrapped.run('你好');
    await wrapped.run('再说一次');
    const first = inputs[0] as string;
    assert.match(first, /<developer-instructions>/);
    assert.match(first, /# Agent: 测试 Waker/);
    assert.match(first, /你是测试人设。/);
    assert.match(first, /默认使用简体中文回复/);
    assert.match(first, /不要翻译代码、日志、命令、API 字段/);
    assert.ok(first.endsWith('你好'));
    assert.equal(inputs[1], '再说一次');
  });

  it('英文偏好注入英文文案', async () => {
    const { thread, inputs } = fakeThread();
    const wrapped = wrapThreadWithPersona(
      thread,
      agent,
      true,
      agentOutputLanguageInstruction('en-US'),
    );
    await wrapped.run('hello');
    assert.match(inputs[0] as string, /reply in English by default/);
  });

  it('未设置语言时首 turn 只注入人设，不含输出语言指令', async () => {
    const { thread, inputs } = fakeThread();
    const wrapped = wrapThreadWithPersona(thread, agent, true);
    await wrapped.run('你好');
    const first = inputs[0] as string;
    assert.match(first, /# Agent: 测试 Waker/);
    assert.doesNotMatch(first, /默认输出语言|Output Language/);
  });

  it('resume 会话（injectOnFirstTurn=false）完全不注入', async () => {
    const { thread, inputs } = fakeThread();
    const wrapped = wrapThreadWithPersona(
      thread,
      agent,
      false,
      agentOutputLanguageInstruction('zh-CN'),
    );
    await wrapped.run('继续');
    assert.equal(inputs[0], '继续');
  });
});

describe('CodexThreadRegistry 空闲淘汰', () => {
  it('空闲超过 TTL 的条目在下一次操作时被淘汰重建，未过期则复用', async () => {
    let now = 1_000_000;
    const state: FakeState = { calls: 0, closes: [], events: [] };
    const registry = new CodexThreadRegistry({
      idleTtlMs: 1000,
      now: () => now,
      createSession: fakeFactory(state),
    });
    try {
      await registry.run('agent-one', 's1', '你好');
      await registry.run('agent-one', 's1', '复读');
      assert.equal(state.calls, 1, '未过期的条目必须复用');

      now += 2000;
      await registry.run('agent-one', 's1', '换新的');
      assert.equal(state.calls, 2, '过期条目应被淘汰重建而非复用');
      await flushMicrotasks();
      assert.deepEqual(state.closes, ['agent-one:s1#1'], '被淘汰的旧会话应调用 close 释放');
    } finally {
      await registry.closeAll();
    }
  });

  it('进行中的 turn 所在的 key 不会被顺带清扫淘汰', async () => {
    let now = 1_000_000;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state: FakeState = { calls: 0, closes: [], events: [], gate };
    const registry = new CodexThreadRegistry({
      idleTtlMs: 1000,
      now: () => now,
      createSession: fakeFactory(state),
    });
    try {
      const turn = registry.run('agent-one', 'busy', '卡住');
      await flushMicrotasks();
      assert.equal(state.calls, 1);

      // 另一个 session 的操作触发 lazy sweep；busy 已过期但有 in-flight turn，不能淘汰。
      now += 2000;
      state.gate = undefined;
      await registry.run('agent-one', 'sweeper', '扫一下');
      await flushMicrotasks();
      assert.deepEqual(state.closes, [], '有进行中 turn 的条目不得被淘汰');

      release();
      await turn;
      await registry.run('agent-one', 'busy', '继续');
      assert.equal(
        state.calls,
        2,
        'busy 条目仍在（turn 结束刷新 lastUsedAt），只有 sweeper 新建了一次',
      );
    } finally {
      await registry.closeAll();
    }
  });
});
