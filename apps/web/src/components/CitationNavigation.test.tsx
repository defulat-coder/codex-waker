import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fireEvent, render, screen } from '@testing-library/react';
import { ThreadView } from './ThreadView.js';

describe('ThreadView Outputs navigation', () => {
  it('offers one contextual Outputs action on the latest completed assistant message', () => {
    let opened = 0;
    render(
      <ThreadView
        messages={[
          { id: 'assistant-1', role: 'assistant', text: '较早回答' },
          { id: 'user-1', role: 'user', text: '继续' },
          { id: 'assistant-2', role: 'assistant', text: '最新回答' },
        ]}
        onOpenOutputs={() => (opened += 1)}
      />,
    );
    const actions = screen.getAllByRole('button', { name: '查看附件与结果' });
    assert.equal(actions.length, 1);
    fireEvent.click(actions[0]!);
    assert.equal(opened, 1);
  });

  it('keeps an Outputs action on an earlier message that recorded file changes', () => {
    let opened = 0;
    render(
      <ThreadView
        messages={[
          {
            id: 'assistant-with-change',
            role: 'assistant',
            text: '修改完成',
            tools: [{ id: 'change-1', name: 'file_change', status: 'completed' }],
          },
          { id: 'user-2', role: 'user', text: '总结一下' },
          { id: 'assistant-latest', role: 'assistant', text: '已总结' },
        ]}
        onOpenOutputs={() => (opened += 1)}
      />,
    );
    const actions = screen.getAllByRole('button', { name: '查看附件与结果' });
    assert.equal(actions.length, 2);
    fireEvent.click(actions[0]!);
    assert.equal(opened, 1);
  });
});
