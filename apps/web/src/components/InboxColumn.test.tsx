import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fireEvent, render, screen } from '@testing-library/react';
import type { SessionSummary } from '@waker/contracts';
import { InboxColumn, type InboxColumnProps } from './InboxColumn.js';

const SESSION: SessionSummary = {
  id: 'session-1',
  agentId: 'agent-1',
  title: '移动端会话',
  createdAt: '2026-08-28T08:00:00.000Z',
  updatedAt: '2026-08-28T09:00:00.000Z',
  questionCount: 1,
  needsAttention: false,
};

function props(overrides: Partial<InboxColumnProps> = {}): InboxColumnProps {
  return {
    title: 'Nova',
    sessions: [SESSION],
    currentSessionId: null,
    filter: 'all',
    collapsed: false,
    onToggleCollapsed: () => undefined,
    onSelectSession: () => undefined,
    onRenameSession: () => undefined,
    onDeleteSession: () => undefined,
    onFilterChange: () => undefined,
    ...overrides,
  };
}

describe('InboxColumn mobile drawer contract', () => {
  it('折叠态只保留可达触发器，展开态恢复 drawer 内容', () => {
    let toggles = 0;
    const view = render(
      <InboxColumn {...props({ collapsed: true, onToggleCollapsed: () => void (toggles += 1) })} />,
    );

    const collapsed = screen.getByLabelText('会话列表');
    assert.equal(collapsed.getAttribute('data-mobile-presentation'), 'trigger');
    assert.equal(screen.queryByText('移动端会话'), null);
    fireEvent.click(screen.getByRole('button', { name: '展开会话列表' }));
    assert.equal(toggles, 1);

    view.rerender(<InboxColumn {...props()} />);
    assert.equal(
      screen.getByLabelText('会话列表').getAttribute('data-mobile-presentation'),
      'drawer',
    );
    assert.ok(screen.getByRole('button', { name: /移动端会话/ }));
    assert.ok(screen.getByRole('button', { name: '收起会话列表' }));
  });

  it('CSS 在 760px 下把 drawer 与 trigger 都移出 flex 布局并止于底栏', () => {
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
    const mobileRules = css.slice(css.lastIndexOf('@media (max-width: 760px)'));

    assert.match(
      mobileRules,
      /\.inbox-column\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0 auto 62px 0;[^}]*z-index:\s*19;/s,
    );
    assert.match(
      mobileRules,
      /\.inbox-column\.collapsed\s*\{[^}]*inset:\s*12px auto auto 12px;[^}]*width:\s*44px;[^}]*height:\s*44px;/s,
    );
    assert.match(
      mobileRules,
      /\.thread-header\s*\{[^}]*justify-content:\s*flex-start;[^}]*overflow-x:\s*auto;[^}]*padding-left:\s*64px;/s,
    );
  });
});
