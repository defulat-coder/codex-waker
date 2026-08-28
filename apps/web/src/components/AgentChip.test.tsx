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
    const { container } = render(<AgentChip mark="Fleet" className="agent-chip--large" />);
    const chip = container.querySelector('.agent-chip');
    assert.ok(chip);
    assert.equal(chip.textContent, 'Fl');
    assert.ok(chip.className.includes('agent-chip--large'));
  });
});
