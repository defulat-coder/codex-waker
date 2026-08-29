import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRollout, buildSessionDebugTimeline, tracesFromAnalysis } from './diagnostics.js';

function rolloutLine(record: unknown): string {
  return JSON.stringify(record);
}

/** 一轮成功 + 一轮失败 + 一轮中断的最小 rollout 夹具。 */
function fixtureRollout(): string {
  return [
    rolloutLine({
      timestamp: '2026-08-28T13:47:58.000Z',
      type: 'session_meta',
      payload: { id: 'thread-1', cwd: '/repo', cli_version: '0.149.0', model_provider: 'openai' },
    }),
    rolloutLine({
      timestamp: '2026-08-28T13:47:58.393Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-1', model_context_window: 258400 },
    }),
    rolloutLine({
      timestamp: '2026-08-28T13:47:58.500Z',
      type: 'turn_context',
      payload: { turn_id: 'turn-1', cwd: '/repo', model: 'gpt-5.6-sol', effort: 'medium' },
    }),
    rolloutLine({
      timestamp: '2026-08-28T13:47:59.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    }),
    rolloutLine({
      timestamp: '2026-08-28T13:48:00.000Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'exec_command', call_id: 'call-1', arguments: '{}' },
    }),
    rolloutLine({
      timestamp: '2026-08-28T13:48:02.000Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call-1', output: 'ok' },
    }),
    rolloutLine({
      timestamp: '2026-08-28T13:48:02.500Z',
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: { type: 'CommandExecution', id: 'call-1', status: 'completed' },
      },
    }),
    rolloutLine({
      timestamp: '2026-08-28T13:48:03.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'yo' }] },
    }),
    rolloutLine({
      timestamp: '2026-08-28T13:48:04.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
          last_token_usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
        },
      },
    }),
    rolloutLine({
      timestamp: '2026-08-28T13:48:05.000Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-1', duration_ms: 6600, time_to_first_token_ms: 1200 },
    }),
    rolloutLine({
      timestamp: '2026-08-28T13:49:00.000Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-2' },
    }),
    rolloutLine({
      timestamp: '2026-08-28T13:49:10.000Z',
      type: 'event_msg',
      payload: { type: 'error', turn_id: 'turn-2', message: 'stream error: 429 rate limit' },
    }),
    rolloutLine({
      timestamp: '2026-08-28T13:50:00.000Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-3' },
    }),
    rolloutLine({
      timestamp: '2026-08-28T13:50:05.000Z',
      type: 'event_msg',
      payload: { type: 'turn_aborted', turn_id: 'turn-3' },
    }),
    '{broken json',
  ].join('\n');
}

describe('analyzeRollout', () => {
  it('groups records into turns with model, usage, durations and tool counts', () => {
    const analysis = analyzeRollout(fixtureRollout());
    assert.equal(analysis.meta.cliVersion, '0.149.0');
    assert.equal(analysis.meta.modelProvider, 'openai');
    assert.deepEqual(analysis.cumulativeUsage, { input: 100, output: 20, total: 120 });
    assert.equal(analysis.turns.length, 3);

    const [first, second, third] = analysis.turns;
    assert.equal(first!.turnId, 'turn-1');
    assert.equal(first!.status, 'completed');
    assert.equal(first!.model, 'gpt-5.6-sol');
    assert.equal(first!.effort, 'medium');
    assert.equal(first!.durationMs, 6600);
    assert.equal(first!.timeToFirstTokenMs, 1200);
    assert.deepEqual(first!.usage, { input: 100, output: 20, total: 120 });
    // function_call 与 item_completed 同一 id，去重后只算一次。
    assert.equal(first!.toolIds.size, 1);

    assert.equal(second!.status, 'failed');
    assert.equal(second!.errorMessage, 'stream error: 429 rate limit');
    assert.equal(third!.status, 'aborted');
  });

  it('counts every parsed record by type bucket', () => {
    const analysis = analyzeRollout(fixtureRollout());
    assert.equal(analysis.eventsByType['session_meta'], 1);
    assert.equal(analysis.eventsByType['event_msg/task_started'], 3);
    assert.equal(analysis.eventsByType['response_item/message'], 2);
    assert.equal(analysis.eventsByType['event_msg/token_count'], 1);
    // 坏行不计数。
    assert.equal(
      analysis.totalEvents,
      Object.values(analysis.eventsByType).reduce((sum, count) => sum + count, 0),
    );
  });

  it('falls back to one implicit turn when the rollout has no turn markers', () => {
    const analysis = analyzeRollout(
      rolloutLine({
        timestamp: '2026-08-28T13:47:59.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      }),
    );
    assert.equal(analysis.turns.length, 1);
    assert.equal(analysis.turns[0]!.status, 'running');
    assert.equal(analysis.turns[0]!.events[0]?.kind, 'user_message');
  });
});

describe('buildSessionDebugTimeline', () => {
  it('builds legacy-shaped rounds/nodes with a summary', () => {
    const analysis = analyzeRollout(fixtureRollout());
    const timeline = buildSessionDebugTimeline({
      sessionId: 'session_1',
      analysis,
      generatedAt: new Date('2026-08-28T14:00:00.000Z'),
    });
    assert.equal(timeline.available, true);
    assert.equal(timeline.sessionId, 'session_1');
    assert.equal(timeline.summary.status, 'failed');
    assert.equal(timeline.summary.roundCount, 3);
    assert.equal(timeline.summary.errorCount >= 1, true);
    // 6600（task_complete）+ 10000（turn-2 由节点首尾推导）+ 5000（turn-3 同理）。
    assert.equal(timeline.summary.totalDurationMs, 21600);
    assert.equal(timeline.summary.primaryDelayNodeId != null, true);

    const [round1, round2, round3] = timeline.rounds;
    assert.equal(round1!.title, 'round_initial');
    assert.equal(round1!.requestSetId, 'turn-1');
    assert.equal(round1!.status, 'completed');
    assert.equal(round1!.durationMs, 6600);
    const kinds = round1!.nodes.map((node) => node.kind);
    assert.deepEqual(kinds, [
      'turn_start',
      'user_message',
      'tool_call',
      'assistant_message',
      'token_usage',
      'turn_complete',
    ]);
    const toolNode = round1!.nodes.find((node) => node.kind === 'tool_call')!;
    assert.equal(toolNode.status, 'completed');
    assert.equal(toolNode.durationMs, 2000);

    assert.equal(round2!.status, 'failed');
    assert.equal(round2!.nodes.at(-1)?.kind, 'error');
    assert.equal(round2!.nodes.at(-1)?.severity, 'danger');
    assert.equal(round2!.nodes.at(-1)?.reasonCode, 'rate_limit');
    assert.equal(round3!.status, 'cancelled');
  });

  it('returns the insufficient_data shape when there are no turns', () => {
    const timeline = buildSessionDebugTimeline({
      sessionId: 'session_1',
      analysis: analyzeRollout(''),
    });
    assert.equal(timeline.available, false);
    assert.equal(timeline.summary.status, 'insufficient_data');
    assert.equal(timeline.summary.totalDurationMs, null);
    assert.deepEqual(timeline.rounds, []);
  });

  it('keeps only the most recent rounds when limit is set', () => {
    const timeline = buildSessionDebugTimeline({
      sessionId: 'session_1',
      analysis: analyzeRollout(fixtureRollout()),
      limit: 2,
    });
    assert.equal(timeline.rounds.length, 2);
    assert.deepEqual(
      timeline.rounds.map((round) => round.requestSetId),
      ['turn-2', 'turn-3'],
    );
    // index/title 保留完整历史编号（对齐旧版语义）。
    assert.equal(timeline.rounds[0]!.index, 2);
    assert.equal(timeline.rounds[0]!.title, 'round_followup');
  });
});

describe('tracesFromAnalysis', () => {
  it('maps turns into per-turn traces', () => {
    const traces = tracesFromAnalysis(analyzeRollout(fixtureRollout()));
    assert.equal(traces.length, 3);
    assert.deepEqual(traces[0], {
      traceId: 'turn-1',
      index: 1,
      status: 'completed',
      model: 'gpt-5.6-sol',
      thinking: 'medium',
      startedAt: '2026-08-28T13:47:58.393Z',
      finishedAt: '2026-08-28T13:48:05.000Z',
      durationMs: 6600,
      timeToFirstTokenMs: 1200,
      usage: { input: 100, output: 20, total: 120 },
      toolCallCount: 1,
    });
    assert.equal(traces[1]!.status, 'failed');
    assert.equal(traces[1]!.errorMessage, 'stream error: 429 rate limit');
    assert.equal(traces[2]!.status, 'aborted');
    assert.equal(traces[2]!.toolCallCount, 0);
  });
});
