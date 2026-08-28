import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fireEvent, render, screen } from '@testing-library/react';
import type { LiveToolCall } from '../lib/stream.js';
import { ProcessCards, toolCardTitle } from './ProcessCards.js';

describe('ProcessCards', () => {
  it('renders a compact expandable plan with textual process states', () => {
    const tools: LiveToolCall[] = [
      {
        id: 'plan-1',
        name: 'plan',
        args: JSON.stringify({
          items: [
            { text: '检查事件链路', completed: true },
            { text: '补齐终态', completed: false },
          ],
        }),
        status: 'running',
      },
      { id: 'done-1', name: 'file_change', status: 'completed' },
      { id: 'failed-1', name: 'files.read', status: 'failed' },
      { id: 'cancelled-1', name: 'command_execution', status: 'cancelled' },
    ];

    render(<ProcessCards tools={tools} />);
    const summary = screen.getByRole('button', { name: /计划 · 1\/2.*4 个过程 · 运行中/ });
    assert.equal(summary.getAttribute('aria-expanded'), 'false');
    fireEvent.click(summary);
    assert.equal(summary.getAttribute('aria-expanded'), 'true');
    assert.ok(screen.getByText('检查事件链路'));
    assert.ok(screen.getByText('补齐终态'));
    assert.equal(screen.getAllByText('已完成').length, 1);
    assert.equal(screen.getAllByText('失败').length, 1);
    assert.equal(screen.getAllByText('已取消').length, 1);
  });

  it('uses the normalized command name for readable bash titles', () => {
    assert.equal(
      toolCardTitle({
        id: 'command-1',
        name: 'command_execution',
        args: JSON.stringify({ command: 'pnpm test' }),
        status: 'completed',
      }),
      'bash · pnpm test',
    );
  });
});
