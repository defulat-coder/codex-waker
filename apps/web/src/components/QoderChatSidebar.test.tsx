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
});
