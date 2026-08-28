import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chatUsageFromTurnUsage, CodexEventNormalizer, type CodexThreadEvent } from './events.js';

const item = {
  agentMessage: (id: string, text: string): CodexThreadEvent => ({
    type: 'item.updated',
    item: { type: 'agent_message', id, text },
  }),
  reasoning: (id: string, text: string): CodexThreadEvent => ({
    type: 'item.updated',
    item: { type: 'reasoning', id, text },
  }),
};

describe('CodexEventNormalizer text deltas', () => {
  it('emits incremental suffixes for cumulative agent_message snapshots', () => {
    const normalizer = new CodexEventNormalizer();
    assert.deepEqual(
      normalizer.normalize({
        type: 'item.started',
        item: { type: 'agent_message', id: 'm1', text: '' },
      }),
      [],
    );
    assert.deepEqual(normalizer.normalize(item.agentMessage('m1', '你好')), [
      { type: 'text_delta', delta: '你好' },
    ]);
    assert.deepEqual(normalizer.normalize(item.agentMessage('m1', '你好，世界')), [
      { type: 'text_delta', delta: '，世界' },
    ]);
    // 完成帧补发剩余文本；快照没增长时不产出空 delta。
    assert.deepEqual(
      normalizer.normalize({
        type: 'item.completed',
        item: { type: 'agent_message', id: 'm1', text: '你好，世界！' },
      }),
      [{ type: 'text_delta', delta: '！' }],
    );
    assert.deepEqual(
      normalizer.normalize(
        item.agentMessage('m1', 'ignored after completion — new text without start'),
      ),
      [{ type: 'text_delta', delta: 'ignored after completion — new text without start' }],
    );
  });

  it('tracks reasoning items separately as thinking deltas', () => {
    const normalizer = new CodexEventNormalizer();
    assert.deepEqual(normalizer.normalize(item.reasoning('r1', '想')), [
      { type: 'thinking_delta', delta: '想' },
    ]);
    assert.deepEqual(normalizer.normalize(item.reasoning('r1', '想一下')), [
      { type: 'thinking_delta', delta: '一下' },
    ]);
    assert.deepEqual(
      normalizer.normalize({
        type: 'item.completed',
        item: { type: 'reasoning', id: 'r1', text: '想一下' },
      }),
      [],
    );
  });

  it('keeps per-item state isolated across message ids', () => {
    const normalizer = new CodexEventNormalizer();
    normalizer.normalize(item.agentMessage('m1', '甲说'));
    assert.deepEqual(normalizer.normalize(item.agentMessage('m2', '乙说')), [
      { type: 'text_delta', delta: '乙说' },
    ]);
    assert.deepEqual(normalizer.normalize(item.agentMessage('m1', '甲说完')), [
      { type: 'text_delta', delta: '完' },
    ]);
  });
});

describe('CodexEventNormalizer error privacy', () => {
  it('redacts private roots from turn, stream and item errors', () => {
    const root = '/Users/private/work';
    const normalizer = new CodexEventNormalizer([root]);
    assert.deepEqual(
      normalizer.normalize({
        type: 'turn.failed',
        error: { message: `failed at ${root}/.env` },
      }),
      [{ type: 'error', error: 'failed at ./.env' }],
    );
    assert.deepEqual(normalizer.normalize({ type: 'error', message: `${root}/stream.log` }), [
      { type: 'error', error: './stream.log' },
    ]);
    assert.deepEqual(
      normalizer.normalize({
        type: 'item.completed',
        item: { type: 'error', id: 'error-1', message: `${root}/item.log` },
      }),
      [{ type: 'error', error: './item.log' }],
    );
  });
});

describe('CodexEventNormalizer tool frames', () => {
  it('maps command_execution through start/update/end with args and result', () => {
    const normalizer = new CodexEventNormalizer();
    const started = normalizer.normalize({
      type: 'item.started',
      item: {
        type: 'command_execution',
        id: 'c1',
        command: 'ls -la',
        aggregated_output: '',
        status: 'in_progress',
      },
    });
    assert.deepEqual(started, [
      {
        type: 'tool',
        phase: 'start',
        toolCallId: 'c1',
        toolName: 'command_execution',
        args: JSON.stringify({ command: 'ls -la' }),
      },
    ]);

    const ended = normalizer.normalize({
      type: 'item.completed',
      item: {
        type: 'command_execution',
        id: 'c1',
        command: 'ls -la',
        aggregated_output: 'total 0',
        exit_code: 0,
        status: 'completed',
      },
    });
    assert.deepEqual(ended, [
      {
        type: 'tool',
        phase: 'end',
        toolCallId: 'c1',
        toolName: 'command_execution',
        args: JSON.stringify({ command: 'ls -la' }),
        result: 'total 0',
      },
    ]);
  });

  it('flags failed commands and mcp tool errors as isError', () => {
    const normalizer = new CodexEventNormalizer();
    const failed = normalizer.normalize({
      type: 'item.completed',
      item: {
        type: 'command_execution',
        id: 'c2',
        command: 'exit 1',
        aggregated_output: '',
        exit_code: 1,
        status: 'failed',
      },
    });
    assert.deepEqual(failed, [
      {
        type: 'tool',
        phase: 'end',
        toolCallId: 'c2',
        toolName: 'command_execution',
        args: JSON.stringify({ command: 'exit 1' }),
        result: '',
        isError: true,
      },
    ]);

    const mcp = normalizer.normalize({
      type: 'item.completed',
      item: {
        type: 'mcp_tool_call',
        id: 'm1',
        server: 'fs',
        tool: 'read',
        arguments: { path: '/tmp/a' },
        error: { message: 'denied' },
        status: 'failed',
      },
    });
    assert.equal(mcp[0]!.type, 'tool');
    const frame = mcp[0] as Extract<(typeof mcp)[number], { type: 'tool' }>;
    assert.equal(frame.toolName, 'fs.read');
    assert.equal(frame.isError, true);
    assert.equal(frame.args, JSON.stringify({ path: '/tmp/a' }));
    assert.equal(frame.result, JSON.stringify({ message: 'denied' }));
  });

  it('maps file_change, web_search and todo_list items', () => {
    const normalizer = new CodexEventNormalizer();
    const fileChange = normalizer.normalize({
      type: 'item.completed',
      item: {
        type: 'file_change',
        id: 'f1',
        changes: [{ path: 'a.ts', kind: 'update' }],
        status: 'completed',
      },
    });
    assert.deepEqual(fileChange, [
      {
        type: 'tool',
        phase: 'end',
        toolCallId: 'f1',
        toolName: 'file_change',
        args: JSON.stringify({ changes: [{ path: 'a.ts', kind: 'update' }] }),
        result: 'completed',
      },
    ]);

    const search = normalizer.normalize({
      type: 'item.started',
      item: { type: 'web_search', id: 'w1', query: 'codex sdk' },
    });
    assert.deepEqual(search, [
      {
        type: 'tool',
        phase: 'start',
        toolCallId: 'w1',
        toolName: 'web_search',
        args: JSON.stringify({ query: 'codex sdk' }),
      },
    ]);

    assert.deepEqual(
      normalizer.normalize({
        type: 'item.updated',
        item: {
          type: 'todo_list',
          id: 't1',
          items: [
            { text: '检查事件链路', completed: true },
            { text: '补齐状态', completed: false },
          ],
        },
      }),
      [
        {
          type: 'tool',
          phase: 'update',
          toolCallId: 't1',
          toolName: 'plan',
          args: JSON.stringify({
            items: [
              { text: '检查事件链路', completed: true },
              { text: '补齐状态', completed: false },
            ],
          }),
        },
      ],
    );
  });

  it('truncates oversized tool payloads to 4KB', () => {
    const normalizer = new CodexEventNormalizer();
    const big = 'x'.repeat(8 * 1024);
    const frames = normalizer.normalize({
      type: 'item.completed',
      item: {
        type: 'command_execution',
        id: 'big',
        command: 'cat',
        aggregated_output: big,
        status: 'completed',
      },
    });
    const frame = frames[0] as Extract<(typeof frames)[number], { type: 'tool' }>;
    assert.ok(frame.result!.length < big.length);
    assert.match(frame.result!, /\[truncated\]$/);
  });

  it('removes host workspace roots from tool arguments and results', () => {
    const root = '/Users/private/codex-waker';
    const normalizer = new CodexEventNormalizer([root]);
    const frames = normalizer.normalize({
      type: 'item.completed',
      item: {
        type: 'command_execution',
        id: 'private-path',
        command: `cat ${root}/README.md`,
        aggregated_output: `${root}/README.md`,
        status: 'completed',
      },
    });
    const frame = frames[0] as Extract<(typeof frames)[number], { type: 'tool' }>;
    assert.equal(frame.args, JSON.stringify({ command: 'cat ./README.md' }));
    assert.equal(frame.result, './README.md');
    assert.doesNotMatch(JSON.stringify(frame), /\/Users\/private/);
  });
});

describe('CodexEventNormalizer terminal/control events', () => {
  it('maps turn.failed and error events to error frames; ignores turn lifecycle events', () => {
    const normalizer = new CodexEventNormalizer();
    assert.deepEqual(
      normalizer.normalize({ type: 'turn.failed', error: { message: '模型超时' } }),
      [{ type: 'error', error: '模型超时' }],
    );
    assert.deepEqual(normalizer.normalize({ type: 'error', message: '流中断' }), [
      { type: 'error', error: '流中断' },
    ]);
    assert.deepEqual(normalizer.normalize({ type: 'thread.started', thread_id: 'thread-1' }), []);
    assert.deepEqual(normalizer.normalize({ type: 'turn.started' }), []);
    assert.deepEqual(
      normalizer.normalize({
        type: 'turn.completed',
        usage: {
          input_tokens: 3,
          cached_input_tokens: 0,
          output_tokens: 2,
          reasoning_output_tokens: 1,
        },
      }),
      [],
    );
    assert.deepEqual(
      normalizer.normalize({
        type: 'item.completed',
        item: { type: 'error', id: 'e1', message: '工具失败' },
      }),
      [{ type: 'error', error: '工具失败' }],
    );
  });

  it('folds turn usage into ChatUsage', () => {
    assert.deepEqual(
      chatUsageFromTurnUsage({
        input_tokens: 10,
        cached_input_tokens: 4,
        output_tokens: 5,
        reasoning_output_tokens: 2,
      }),
      { input: 10, output: 5, total: 15 },
    );
  });
});
