import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { agentSessionStoreFor } from '@waker/codex-runtime';
import { buildApp } from '../app.js';
import type { AppConfig } from '../config.js';

const config: AppConfig = {
  PORT: 4310,
  HOST: '127.0.0.1',
  WEB_ORIGIN: 'http://localhost:5173',
  CODEX_AGENT_ENABLED: false,
  LOG_LEVEL: 'error',
};

const THREAD_ID = 'diag-thread-0001';

function rolloutFixture(): string {
  const line = (record: unknown) => JSON.stringify(record);
  return [
    line({
      timestamp: '2026-08-28T13:47:58.000Z',
      type: 'session_meta',
      payload: { id: THREAD_ID, cwd: '/repo', cli_version: '0.149.0', model_provider: 'openai' },
    }),
    line({
      timestamp: '2026-08-28T13:47:58.393Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-1' },
    }),
    line({
      timestamp: '2026-08-28T13:47:58.500Z',
      type: 'turn_context',
      payload: { turn_id: 'turn-1', cwd: '/repo', model: 'gpt-5.6-sol', effort: 'medium' },
    }),
    line({
      timestamp: '2026-08-28T13:47:59.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    }),
    line({
      timestamp: '2026-08-28T13:48:03.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'yo' }],
      },
    }),
    line({
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
    line({
      timestamp: '2026-08-28T13:48:05.000Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-1', duration_ms: 6600 },
    }),
    line({
      timestamp: '2026-08-28T13:49:00.000Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-2' },
    }),
    line({
      timestamp: '2026-08-28T13:49:10.000Z',
      type: 'event_msg',
      payload: { type: 'error', turn_id: 'turn-2', message: 'stream error: 429 rate limit' },
    }),
    line({
      timestamp: '2026-08-28T13:50:00.000Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-3' },
    }),
    line({
      timestamp: '2026-08-28T13:50:05.000Z',
      type: 'event_msg',
      payload: { type: 'turn_aborted', turn_id: 'turn-3' },
    }),
  ].join('\n');
}

describe('Session diagnostics API', () => {
  const root = mkdtempSync(join(tmpdir(), 'waker-session-diagnostics-api-'));
  mkdirSync(join(root, '.codex', 'agents'), { recursive: true });
  writeFileSync(
    join(root, '.codex', 'agents', 'alpha.md'),
    `---\nname: alpha\nmark: a\ntagline: Test\ndescription: Test\nsuggestions:\n  - Test\n---\n\nTest agent.\n`,
  );
  const app = buildApp(config, { cwd: root, schedulerIntervalMs: false });
  const sessions = agentSessionStoreFor({ cwd: root });

  before(async () => app.ready());
  after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function createSession(): Promise<string> {
    const response = await app.inject({ method: 'POST', url: '/api/v1/agents/alpha/sessions' });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().id as string;
  }

  /** 绑定一个带三轮 rollout（成功/失败/中断）+ 一条本地失败补记的会话。 */
  async function createSessionWithRollout(): Promise<string> {
    const sessionId = await createSession();
    await sessions.bindThread(sessionId, 'alpha', THREAD_ID);
    const rolloutDir = join(root, '.codex', 'sessions', '2026', '08', '28');
    mkdirSync(rolloutDir, { recursive: true });
    writeFileSync(
      join(rolloutDir, `rollout-2026-08-28T13-47-58-${THREAD_ID}.jsonl`),
      rolloutFixture(),
    );
    sessions.recordTurnFailure(sessionId, 'alpha', {
      timestamp: '2026-08-28T13:55:00.000Z',
      errorMessage: 'provider rejected the stream',
      kind: 'network',
    });
    return sessionId;
  }

  it('404s all three endpoints for an unknown session', async () => {
    for (const suffix of ['runtime-diagnostics', 'debug-timeline', 'traces']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/sessions/session_ghost/${suffix}`,
      });
      assert.equal(response.statusCode, 404, `${suffix}: ${response.body}`);
    }
  });

  it('reports an empty diagnostics shape for a session without a bound thread', async () => {
    const sessionId = await createSession();
    const diagnostics = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/runtime-diagnostics`,
    });
    assert.equal(diagnostics.statusCode, 200, diagnostics.body);
    const body = diagnostics.json();
    assert.equal(body.sessionId, sessionId);
    assert.equal(body.agentId, 'alpha');
    assert.equal(body.threadId, null);
    assert.equal(body.status, 'idle');
    assert.equal(body.rollout, null);
    assert.deepEqual(body.events, { total: 0, byType: {} });
    assert.deepEqual(body.turns, { total: 0, completed: 0, failed: 0, aborted: 0, running: 0 });
    assert.equal(body.usage, undefined);
    assert.deepEqual(body.failures, []);

    const timeline = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/debug-timeline`,
    });
    assert.equal(timeline.statusCode, 200, timeline.body);
    assert.equal(timeline.json().available, false);
    assert.equal(timeline.json().summary.status, 'insufficient_data');
    assert.deepEqual(timeline.json().rounds, []);

    const traces = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/traces`,
    });
    assert.equal(traces.statusCode, 200, traces.body);
    assert.deepEqual(traces.json().items, []);
    assert.equal(traces.json().total, 0);
  });

  it('serves runtime diagnostics from the binding, rollout and failure records', async () => {
    const sessionId = await createSessionWithRollout();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/runtime-diagnostics`,
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.sessionId, sessionId);
    assert.equal(body.agentId, 'alpha');
    assert.equal(body.threadId, THREAD_ID);
    // 最后一轮是 turn_aborted → needs_attention。
    assert.equal(body.status, 'needs_attention');
    assert.ok(body.rollout.path.endsWith(`rollout-2026-08-28T13-47-58-${THREAD_ID}.jsonl`));
    assert.equal(typeof body.rollout.sizeBytes, 'number');
    assert.ok(body.rollout.sizeBytes > 0);
    assert.equal(body.runtime.cliVersion, '0.149.0');
    assert.equal(body.runtime.modelProvider, 'openai');
    assert.equal(body.events.byType['event_msg/task_started'], 3);
    assert.deepEqual(body.turns, { total: 3, completed: 1, failed: 1, aborted: 1, running: 0 });
    assert.deepEqual(body.usage, { input: 100, output: 20, total: 120 });
    assert.deepEqual(body.failures, [
      {
        timestamp: '2026-08-28T13:55:00.000Z',
        errorMessage: 'provider rejected the stream',
        kind: 'network',
      },
    ]);
  });

  it('serves a legacy-shaped debug timeline grouped by turn', async () => {
    const sessionId = await createSessionWithRollout();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/debug-timeline`,
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.available, true);
    assert.equal(body.summary.roundCount, 3);
    assert.equal(body.summary.status, 'failed');
    // 6600（task_complete）+ 10000（turn-2 节点首尾推导）+ 5000（turn-3 同理）。
    assert.equal(body.summary.totalDurationMs, 21600);
    assert.equal(body.rounds.length, 3);
    assert.equal(body.rounds[0].title, 'round_initial');
    assert.equal(body.rounds[0].requestSetId, 'turn-1');
    assert.equal(body.rounds[0].status, 'completed');
    assert.ok(body.rounds[0].nodes.some((node: { kind: string }) => node.kind === 'turn_start'));
    assert.equal(body.rounds[1].status, 'failed');
    assert.equal(body.rounds[2].status, 'cancelled');
  });

  it('serves per-turn traces and honors limit', async () => {
    const sessionId = await createSessionWithRollout();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/traces`,
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.sessionId, sessionId);
    assert.equal(body.agentId, 'alpha');
    assert.equal(body.total, 3);
    assert.deepEqual(body.items[0], {
      traceId: 'turn-1',
      index: 1,
      status: 'completed',
      model: 'gpt-5.6-sol',
      thinking: 'medium',
      startedAt: '2026-08-28T13:47:58.393Z',
      finishedAt: '2026-08-28T13:48:05.000Z',
      durationMs: 6600,
      usage: { input: 100, output: 20, total: 120 },
      toolCallCount: 0,
    });
    assert.equal(body.items[1].status, 'failed');
    assert.equal(body.items[1].errorMessage, 'stream error: 429 rate limit');
    assert.equal(body.items[2].status, 'aborted');

    const limited = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/traces?limit=2`,
    });
    assert.equal(limited.statusCode, 200, limited.body);
    assert.deepEqual(
      limited.json().items.map((item: { traceId: string }) => item.traceId),
      ['turn-2', 'turn-3'],
    );

    const limitedTimeline = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/debug-timeline?limit=1`,
    });
    assert.equal(limitedTimeline.statusCode, 200, limitedTimeline.body);
    assert.equal(limitedTimeline.json().rounds.length, 1);
    assert.equal(limitedTimeline.json().rounds[0].requestSetId, 'turn-3');
  });
});
