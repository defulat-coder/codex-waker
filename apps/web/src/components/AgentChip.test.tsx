import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen } from '@testing-library/react';
import { AgentChip } from './AgentChip.js';

describe('AgentChip', () => {
  it('渲染 mark 的前两个字符', () => {
    render(<AgentChip mark="Nova" />);
    const chip = screen.getByText('No');
    assert.equal(chip.tagName, 'SPAN');
    assert.equal(chip.className, 'agent-chip');
  });

  it('合并修饰 className', () => {
    const { container } = render(<AgentChip mark="Waker" className="agent-chip--large" />);
    const chip = container.querySelector('.agent-chip');
    assert.ok(chip);
    assert.equal(chip.textContent, 'Wa');
    assert.ok(chip.className.includes('agent-chip--large'));
  });

  it('有头像时渲染图片，否则回退到 mark', () => {
    const { container, rerender } = render(
      <AgentChip mark="译" agentId="translator-pro" hasAvatar />,
    );
    const img = container.querySelector('.agent-chip img');
    assert.ok(img);
    assert.equal(img.getAttribute('src'), '/api/v1/agents/translator-pro/avatar');
    rerender(<AgentChip mark="译" agentId="translator-pro" hasAvatar={false} />);
    assert.equal(container.querySelector('.agent-chip img'), null);
    assert.equal(container.querySelector('.agent-chip')?.textContent, '译');
  });
});
