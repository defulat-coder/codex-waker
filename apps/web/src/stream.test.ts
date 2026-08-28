import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatStreamEvent } from '@waker/contracts';
import {
  createLiveTurn,
  decodeStreamEvent,
  extractSseBlocks,
  flushSseBlocks,
  reduceStreamEvent,
} from './lib/stream.js';

/** Simulates a byte-stream consumer: feeds chunks through the block extractor and decodes events. */
function consumeChunks(chunks: string[]): ChatStreamEvent[] {
  let buffer = '';
  const events: ChatStreamEvent[] = [];
  for (const chunk of chunks) {
    buffer += chunk;
    const { blocks, rest } = extractSseBlocks(buffer);
    buffer = rest;
    for (const block of blocks) events.push(decodeStreamEvent(block));
  }
  for (const block of flushSseBlocks(buffer)) events.push(decodeStreamEvent(block));
  return events;
}

const START =
  'event: start\ndata: {"type":"start","sessionId":"session_abc","agentId":"pi-assistant","model":{"model":"gpt-5","thinkingLevel":"low"}}\n\n';
const DELTA_HELLO = 'event: text_delta\ndata: {"type":"text_delta","delta":"你好"}\n\n';
const DELTA_WORLD = 'event: text_delta\ndata: {"type":"text_delta","delta":"，世界"}\n\n';
const THINKING = 'event: thinking_delta\ndata: {"type":"thinking_delta","delta":"想一下"}\n\n';
const SOURCES =
  'event: sources\ndata: {"type":"sources","sources":[{"index":1,"notebookId":"notes","documentId":"guide","documentVersion":1,"chunkId":"guide:1:0","title":"指南","startLine":2,"endLine":5,"excerpt":"片段","matchMode":"hybrid","score":0.8}]}\n\n';
const DONE =
  'event: done\ndata: {"type":"done","answer":"你好，世界","usage":{"input":3,"output":5,"total":8}}\n\n';
const ERROR = 'event: error\ndata: {"type":"error","error":"模型超时"}\n\n';

describe('SSE 流解析', () => {
  it('解析完整的 start/text_delta/done 序列', () => {
    const events = consumeChunks([START + DELTA_HELLO + DONE]);
    assert.deepEqual(
      events.map((event) => event.type),
      ['start', 'text_delta', 'done'],
    );
    const start = events[0]!;
    assert.equal(start.type, 'start');
    if (start.type === 'start') {
      assert.equal(start.sessionId, 'session_abc');
      assert.equal(start.agentId, 'pi-assistant');
      assert.equal(start.model.model, 'gpt-5');
    }
    const done = events[2]!;
    if (done.type === 'done') assert.deepEqual(done.usage, { input: 3, output: 5, total: 8 });
  });

  it('事件跨 chunk 拆分时仍能正确重组', () => {
    // 把一个 data 行从中间切断，模拟任意字节边界。
    const payload = START + DELTA_HELLO + DELTA_WORLD + DONE;
    const chunks = [
      payload.slice(0, 17),
      payload.slice(17, 60),
      payload.slice(60, 61),
      payload.slice(61),
    ];
    const events = consumeChunks(chunks);
    assert.deepEqual(
      events.map((event) => event.type),
      ['start', 'text_delta', 'text_delta', 'done'],
    );
    const deltas = events.filter((event) => event.type === 'text_delta');
    assert.deepEqual(
      deltas.map((event) => (event as { delta: string }).delta),
      ['你好', '，世界'],
    );
  });

  it('支持 CRLF 行尾与多行 data', () => {
    const events = consumeChunks([
      'event: text_delta\r\ndata: {"type":"text_delta","delta":"a"}\r\n\r\n',
    ]);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'text_delta');
  });

  it('流末尾不完整的块在 flush 时被解析', () => {
    const events = consumeChunks([DONE.slice(0, -2)]);
    assert.deepEqual(
      events.map((event) => event.type),
      ['done'],
    );
  });

  it('未知事件名抛错', () => {
    assert.throws(() => decodeStreamEvent({ event: 'mystery', data: '{}' }), /未知的流式事件/);
  });
});

describe('reduceStreamEvent', () => {
  it('累积 thinking 与正文，done 提供最终答案', () => {
    const events = consumeChunks([START + SOURCES + THINKING + DELTA_HELLO + DELTA_WORLD + DONE]);
    let turn = createLiveTurn();
    for (const event of events) turn = reduceStreamEvent(turn, event);
    assert.equal(turn.sessionId, 'session_abc');
    assert.equal(turn.thinking, '想一下');
    assert.equal(turn.answer, '你好，世界');
    assert.equal(turn.sources[0]?.chunkId, 'guide:1:0');
    assert.deepEqual(turn.usage, { input: 3, output: 5, total: 8 });
  });

  it('done 的 answer 为空时保留已累积的正文', () => {
    const events = consumeChunks([
      DELTA_HELLO + 'event: done\ndata: {"type":"done","answer":""}\n\n',
    ]);
    let turn = createLiveTurn();
    for (const event of events) turn = reduceStreamEvent(turn, event);
    assert.equal(turn.answer, '你好');
  });

  it('error 事件不改变已累积的状态', () => {
    const events = consumeChunks([THINKING + ERROR]);
    let turn = createLiveTurn();
    for (const event of events) turn = reduceStreamEvent(turn, event);
    assert.equal(turn.thinking, '想一下');
    assert.equal(turn.answer, '');
  });

  it('tool 事件按 toolCallId 折叠为一张调用卡片', () => {
    const TOOL_START =
      'event: tool\ndata: {"type":"tool","phase":"start","toolCallId":"call_1","toolName":"subagent","args":"{\\"agent\\":\\"reviewer\\",\\"task\\":\\"看下这个 diff\\"}"}\n\n';
    const TOOL_END =
      'event: tool\ndata: {"type":"tool","phase":"end","toolCallId":"call_1","toolName":"subagent","result":"{\\"ok\\":true}","isError":false}\n\n';
    const events = consumeChunks([START + TOOL_START + TOOL_END + DONE]);
    assert.deepEqual(
      events.map((event) => event.type),
      ['start', 'tool', 'tool', 'done'],
    );
    let turn = createLiveTurn();
    for (const event of events) turn = reduceStreamEvent(turn, event);
    assert.equal(turn.tools.length, 1);
    const tool = turn.tools[0]!;
    assert.equal(tool.name, 'subagent');
    assert.equal(tool.status, 'completed');
    assert.match(tool.args ?? '', /reviewer/);
    assert.match(tool.result ?? '', /"ok"/);
  });

  it('终止帧为未结束过程补齐完成、失败和取消状态', () => {
    const started = reduceStreamEvent(createLiveTurn(), {
      type: 'tool',
      phase: 'start',
      toolCallId: 'call_1',
      toolName: 'command_execution',
    });
    assert.equal(started.tools[0]?.status, 'running');
    assert.equal(
      reduceStreamEvent(started, { type: 'done', answer: 'ok' }).tools[0]?.status,
      'completed',
    );
    assert.equal(
      reduceStreamEvent(started, { type: 'error', error: 'boom' }).tools[0]?.status,
      'failed',
    );
  });
});
