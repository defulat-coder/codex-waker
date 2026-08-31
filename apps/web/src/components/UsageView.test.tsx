import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fireEvent, render, screen } from '@testing-library/react';
import type { UsageResponse } from '@waker/contracts';
import { UsageView } from './UsageView.js';

const usage: UsageResponse = {
  totalSessions: 3,
  totalQuestions: 7,
  agentCount: 1,
  questionsToday: 2,
  tokens: { input: 10, output: 20, total: 30 },
  perAgent: [
    {
      agentId: 'agent-a',
      name: 'Agent A',
      mark: 'A',
      sessionCount: 3,
      questionCount: 7,
      tokens: { input: 10, output: 20, total: 30 },
    },
  ],
};

describe('UsageView', () => {
  it('读取失败时提供明确的重试操作', () => {
    let retries = 0;
    render(
      <UsageView
        usage={null}
        loading={false}
        loaded
        error={new Error('统计服务不可用')}
        onRefresh={() => {
          retries += 1;
        }}
      />,
    );

    assert.ok(screen.getByRole('heading', { name: '用量', level: 1 }));
    assert.ok(screen.getByRole('alert'));
    assert.ok(screen.getByText('统计服务不可用'));
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    assert.equal(retries, 1);
  });

  it('刷新失败时保留旧统计并显示恢复操作', () => {
    render(
      <UsageView
        usage={usage}
        loading={false}
        loaded
        error={new Error('刷新失败')}
        onRefresh={() => undefined}
      />,
    );

    assert.ok(screen.getByRole('heading', { name: '按 Agent 分列', level: 2 }));
    assert.ok(screen.getByRole('alert'));
    assert.ok(screen.getByText('用量刷新失败，当前仍显示上次统计的数据。'));
    assert.equal(screen.getAllByText('30').length, 2);
    assert.ok(screen.getByText('Agent A'));
  });
});
