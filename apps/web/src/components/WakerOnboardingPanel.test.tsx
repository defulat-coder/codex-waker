import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fireEvent, render, screen } from '@testing-library/react';
import { WakerOnboardingPanel } from './WakerOnboardingPanel.js';

function renderPanel() {
  const calls: string[] = [];
  render(
    <WakerOnboardingPanel
      onChat={() => calls.push('chat')}
      onKnowledge={() => calls.push('knowledge')}
      onProject={() => calls.push('project')}
      onDismiss={() => calls.push('dismiss')}
    />,
  );
  return calls;
}

describe('WakerOnboardingPanel', () => {
  it('提供三个真实下一步入口，不声称尚未完成的配置', () => {
    const calls = renderPanel();

    fireEvent.click(screen.getByRole('button', { name: /进入 Chat/ }));
    fireEvent.click(screen.getByRole('button', { name: /绑定 Knowledge/ }));
    fireEvent.click(screen.getByRole('button', { name: /选择或创建 Project/ }));

    assert.deepEqual(calls, ['chat', 'knowledge', 'project']);
    assert.equal(screen.queryByText(/已绑定|已选择|配置完成/), null);
  });

  it('以可访问区域获得焦点，并支持 Escape 关闭', () => {
    const calls = renderPanel();
    const panel = screen.getByRole('region', { name: 'Waker 已创建' });

    assert.equal(document.activeElement, panel);
    fireEvent.keyDown(panel, { key: 'Escape' });
    assert.deepEqual(calls, ['dismiss']);
  });

  it('提供有明确名称的关闭按钮', () => {
    const calls = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '关闭创建引导' }));
    assert.deepEqual(calls, ['dismiss']);
  });
});
