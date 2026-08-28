import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fireEvent, render, screen } from '@testing-library/react';
import { StopTurnButton } from './StopTurnButton.js';

describe('StopTurnButton', () => {
  it('运行中可停止并提供可访问名称', () => {
    let stopped = false;
    render(
      <StopTurnButton
        running
        onStop={() => {
          stopped = true;
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '停止生成' }));
    assert.equal(stopped, true);
  });
  it('非运行状态禁用', () => {
    render(<StopTurnButton running={false} onStop={() => undefined} />);
    assert.equal(
      (screen.getByRole('button', { name: '停止生成' }) as HTMLButtonElement).disabled,
      true,
    );
  });
});
