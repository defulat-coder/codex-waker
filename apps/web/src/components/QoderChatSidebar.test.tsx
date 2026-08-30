import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { AgentSummary } from '@waker/contracts';
import { QoderChatSidebar } from './QoderChatSidebar.js';

const agents: AgentSummary[] = [
  {
    id: 'agent-a',
    name: 'Agent A',
    mark: 'AA',
    tagline: 'A',
    description: '第一个 Waker',
    suggestions: [],
    sessionCount: 12,
    unreadCount: 2,
  },
  {
    id: 'agent-b',
    name: 'Agent B',
    mark: 'BB',
    tagline: 'B',
    description: '第二个 Waker',
    suggestions: [],
    sessionCount: 3,
  },
];

describe('QoderChatSidebar', () => {
  it('使用单选列表语义、roving tabindex 与方向键切换 Waker', () => {
    const selections: string[] = [];
    function Fixture() {
      const [current, setCurrent] = useState('agent-a');
      return (
        <QoderChatSidebar
          agents={agents}
          currentAgentId={current}
          onSelectAgent={(id) => {
            selections.push(id);
            setCurrent(id);
          }}
          onMarkAllRead={() => {}}
          markingAllRead={false}
        />
      );
    }
    render(<Fixture />);
    const listbox = screen.getByRole('listbox', { name: 'Waker' });
    const options = within(listbox).getAllByRole('option');
    assert.equal(options[0]!.getAttribute('aria-selected'), 'true');
    assert.deepEqual(
      options.map((option) => option.tabIndex),
      [0, -1],
    );
    assert.equal(options[0]!.querySelector('time'), null);
    assert.ok(within(options[0]!).getByText('12 个会话'));

    options[0]!.focus();
    fireEvent.keyDown(options[0]!, { key: 'ArrowDown' });

    assert.equal(document.activeElement, options[1]);
    assert.deepEqual(selections, ['agent-b']);
    assert.equal(options[1]!.getAttribute('aria-selected'), 'true');
    assert.deepEqual(
      options.map((option) => option.tabIndex),
      [-1, 0],
    );
  });

  it('一键已读按未读数和提交状态禁用并给出准确名称', () => {
    let calls = 0;
    const props = {
      agents,
      currentAgentId: 'agent-a',
      onSelectAgent: () => {},
      onMarkAllRead: () => {
        calls += 1;
      },
    };
    const view = render(<QoderChatSidebar {...props} markingAllRead={false} />);
    const action = screen.getByRole('button', { name: '一键已读，2 个未读会话' });
    assert.equal(action.hasAttribute('disabled'), false);
    fireEvent.click(action);
    assert.equal(calls, 1);

    view.rerender(<QoderChatSidebar {...props} markingAllRead />);
    const busy = screen.getByRole('button', { name: '正在将全部会话标为已读' });
    assert.equal(busy.getAttribute('aria-busy'), 'true');
    assert.equal(busy.hasAttribute('disabled'), true);
    assert.match(busy.textContent ?? '', /正在标记/);

    view.rerender(
      <QoderChatSidebar
        {...props}
        agents={agents.map((agent) => ({ ...agent, unreadCount: 0 }))}
        markingAllRead={false}
      />,
    );
    assert.equal(
      screen.getByRole('button', { name: '没有未读会话' }).hasAttribute('disabled'),
      true,
    );
  });
});
