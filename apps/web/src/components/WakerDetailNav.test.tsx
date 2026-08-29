import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fireEvent, render, screen } from '@testing-library/react';
import { WakerDetailNav, type WakerDetailNavKey } from './WakerDetailNav.js';

/** legacy 实测顺序：设置经分隔线沉底。 */
const ORDERED_LABELS: Array<[WakerDetailNavKey, string]> = [
  ['home', '首页'],
  ['projects', '项目'],
  ['automations', '自动任务'],
  ['chat-tasks', '对话任务'],
  ['workflows', '工作流'],
  ['memory', '记忆'],
  ['skills', '技能'],
  ['knowledge', '知识库'],
  ['connectors', '连接器'],
  ['im', 'IM'],
  ['permissions', '权限'],
  ['settings', '设置'],
];

function renderNav(active: WakerDetailNavKey | null = 'home') {
  const calls = { back: 0, navigated: [] as WakerDetailNavKey[] };
  render(
    <WakerDetailNav
      agentName="写作助手"
      active={active}
      onBack={() => {
        calls.back += 1;
      }}
      onNavigate={(key) => {
        calls.navigated.push(key);
      }}
    />,
  );
  return calls;
}

describe('WakerDetailNav', () => {
  it('renders the nav landmark with the agent name and back button', () => {
    const calls = renderNav();
    assert.ok(screen.getByRole('navigation', { name: 'Waker 详情导航' }));
    assert.ok(screen.getByText('写作助手'));
    fireEvent.click(screen.getByRole('button', { name: '我的 Waker' }));
    assert.equal(calls.back, 1);
    assert.equal(calls.navigated.length, 0);
  });

  it('renders all items in the legacy order with a splitter before 设置', () => {
    const { container } = render(
      <WakerDetailNav agentName="写作助手" active={null} onBack={() => {}} onNavigate={() => {}} />,
    );
    const nav = screen.getByRole('navigation', { name: 'Waker 详情导航' });
    const labels = ORDERED_LABELS.map(([, label]) => label);
    const buttons = Array.from(nav.querySelectorAll('.waker-detail-nav-item'));
    assert.deepEqual(
      buttons.map((button) => button.textContent),
      labels,
    );
    // 分隔线位于「权限」与「设置」之间。
    const splitter = container.querySelector('.waker-detail-nav-splitter');
    assert.ok(splitter);
    assert.equal(splitter.previousElementSibling?.textContent, '权限');
    assert.equal(splitter.nextElementSibling?.textContent, '设置');
  });

  it('marks the active item with aria-current and the active class', () => {
    renderNav('permissions');
    const activeItem = screen.getByRole('button', { name: '权限' });
    assert.equal(activeItem.getAttribute('aria-current'), 'page');
    assert.ok(activeItem.className.includes('active'));
    assert.equal(screen.getByRole('button', { name: '首页' }).getAttribute('aria-current'), null);
  });

  it('supports no active item', () => {
    renderNav(null);
    assert.equal(document.querySelectorAll('[aria-current="page"]').length, 0);
  });

  it('emits onNavigate with the right key for every item', () => {
    const calls = renderNav(null);
    for (const [, label] of ORDERED_LABELS) {
      fireEvent.click(screen.getByRole('button', { name: label }));
    }
    assert.deepEqual(
      calls.navigated,
      ORDERED_LABELS.map(([key]) => key),
    );
  });
});
