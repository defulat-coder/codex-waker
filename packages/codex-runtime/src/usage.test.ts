import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionSummary } from '@waker/contracts';
import { summarizeUsage } from './usage.js';

const agents = [
  { id: 'pi-assistant', name: 'Pi 助手', mark: 'π' },
  { id: 'other-agent', name: '另一个', mark: '另' },
];

function session(
  partial: Partial<SessionSummary> & { id: string; agentId: string },
): SessionSummary {
  return {
    title: partial.id,
    createdAt: '2026-08-20T08:00:00.000Z',
    updatedAt: '2026-08-20T09:00:00.000Z',
    questionCount: 0,
    needsAttention: false,
    ...partial,
  };
}

describe('summarizeUsage', () => {
  it('aggregates totals and per-agent rows from session summaries', () => {
    const sessions = [
      session({
        id: 'a',
        agentId: 'pi-assistant',
        questionCount: 3,
        updatedAt: '2026-08-20T10:00:00.000Z',
      }),
      session({
        id: 'b',
        agentId: 'pi-assistant',
        questionCount: 2,
        updatedAt: '2026-08-21T06:00:00.000Z',
      }),
      session({ id: 'c', agentId: 'other-agent', questionCount: 5 }),
    ];
    const usage = summarizeUsage(sessions, agents, new Date('2026-08-21T12:00:00+08:00'));

    assert.equal(usage.totalSessions, 3);
    assert.equal(usage.totalQuestions, 10);
    assert.equal(usage.agentCount, 2);

    const piRow = usage.perAgent.find((row) => row.agentId === 'pi-assistant')!;
    assert.equal(piRow.sessionCount, 2);
    assert.equal(piRow.questionCount, 5);
    assert.equal(piRow.lastActiveAt, '2026-08-21T06:00:00.000Z');

    const otherRow = usage.perAgent.find((row) => row.agentId === 'other-agent')!;
    assert.equal(otherRow.sessionCount, 1);
    assert.equal(otherRow.questionCount, 5);
  });

  it('counts today questions from sessions created or updated on the local day', () => {
    // 本地时区 2026-08-21：a 当天更新、b 前一天、c 当天创建。
    const now = new Date(2026, 7, 21, 12, 0, 0);
    const sessions = [
      session({
        id: 'a',
        agentId: 'pi-assistant',
        questionCount: 4,
        createdAt: new Date(2026, 7, 20, 9).toISOString(),
        updatedAt: new Date(2026, 7, 21, 8).toISOString(),
      }),
      session({
        id: 'b',
        agentId: 'pi-assistant',
        questionCount: 7,
        createdAt: new Date(2026, 7, 20, 9).toISOString(),
        updatedAt: new Date(2026, 7, 20, 10).toISOString(),
      }),
      session({
        id: 'c',
        agentId: 'other-agent',
        questionCount: 1,
        createdAt: new Date(2026, 7, 21, 1).toISOString(),
        updatedAt: new Date(2026, 7, 21, 1).toISOString(),
      }),
    ];
    const usage = summarizeUsage(sessions, agents, now);
    assert.equal(usage.questionsToday, 5);
    assert.equal(usage.totalQuestions, 12);
  });

  it('keeps agents without sessions in the table with zero counts and no lastActiveAt', () => {
    const usage = summarizeUsage([], agents, new Date());
    assert.equal(usage.totalSessions, 0);
    assert.equal(usage.totalQuestions, 0);
    assert.equal(usage.questionsToday, 0);
    assert.equal(usage.perAgent.length, 2);
    assert.ok(
      usage.perAgent.every(
        (row) =>
          row.sessionCount === 0 && row.questionCount === 0 && row.lastActiveAt === undefined,
      ),
    );
  });
});
