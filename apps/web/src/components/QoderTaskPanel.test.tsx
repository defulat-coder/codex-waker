import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { SessionSummary } from '@waker/contracts';
import { QoderTaskPanel } from './QoderTaskPanel.js';

const sessions: SessionSummary[] = [
  {
    id: 'session-a',
    agentId: 'agent-a',
    title: '排查构建失败',
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:00:00.000Z',
    questionCount: 3,
    needsAttention: false,
  },
  {
    id: 'session-b',
    agentId: 'agent-a',
    title: '整理发布说明',
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:00:00.000Z',
    questionCount: 1,
    needsAttention: false,
  },
];

describe('QoderTaskPanel', () => {
  it('进入焦点，暴露 tabs/listbox 语义，并支持方向键与 Escape', () => {
    const opened: string[] = [];
    let automations = 0;
    let closes = 0;
    render(
      <QoderTaskPanel
        sessions={sessions}
        currentSessionId="session-a"
        onOpenSession={(id) => opened.push(id)}
        onOpenAutomations={() => {
          automations += 1;
        }}
        onClose={() => {
          closes += 1;
        }}
      />,
    );

    const conversationTab = screen.getByRole('tab', { name: '对话任务' });
    const automationTab = screen.getByRole('tab', { name: '自动任务' });
    const panel = screen.getByRole('tabpanel');
    assert.equal(document.activeElement, conversationTab);
    assert.equal(conversationTab.tabIndex, 0);
    assert.equal(automationTab.tabIndex, -1);
    assert.equal(conversationTab.getAttribute('aria-controls'), panel.id);

    fireEvent.keyDown(conversationTab, { key: 'ArrowRight' });
    assert.equal(document.activeElement, automationTab);
    assert.equal(automations, 1);

    const listbox = screen.getByRole('listbox', { name: '对话任务' });
    const options = within(listbox).getAllByRole('option');
    assert.equal(options[0]!.getAttribute('aria-selected'), 'true');
    assert.deepEqual(
      options.map((option) => option.tabIndex),
      [0, -1],
    );
    options[0]!.focus();
    fireEvent.keyDown(options[0]!, { key: 'ArrowDown' });
    assert.equal(document.activeElement, options[1]);
    assert.deepEqual(opened, ['session-b']);

    fireEvent.keyDown(options[1]!, { key: 'Escape' });
    assert.equal(closes, 1);
  });

  it('空任务列表提供状态文案', () => {
    render(
      <QoderTaskPanel
        sessions={[]}
        currentSessionId={null}
        onOpenSession={() => {}}
        onOpenAutomations={() => {}}
        onClose={() => {}}
      />,
    );
    assert.equal(screen.getByRole('status').textContent, '暂无对话任务');
  });
});
