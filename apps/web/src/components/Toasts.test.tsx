import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fireEvent, render, screen } from '@testing-library/react';
import { Toasts, type Toast } from './Toasts.js';

const toasts: Toast[] = [
  { id: 1, text: '已保存', tone: 'success' },
  { id: 2, text: '正在同步', tone: 'info' },
  { id: 3, text: '保存失败', tone: 'error' },
];

describe('Toasts', () => {
  it('按 tone 使用正确播报语义，并允许手动关闭', () => {
    const dismissed: number[] = [];
    render(<Toasts toasts={toasts} onDismiss={(id) => dismissed.push(id)} />);

    assert.equal(screen.getByText('已保存').closest('[role]')?.getAttribute('role'), 'status');
    assert.equal(screen.getByText('正在同步').closest('[role]')?.getAttribute('role'), 'status');
    const error = screen.getByRole('alert');
    assert.match(error.textContent ?? '', /保存失败/);
    assert.equal(error.getAttribute('aria-live'), 'assertive');

    fireEvent.click(screen.getByRole('button', { name: '关闭通知：保存失败' }));
    assert.deepEqual(dismissed, [3]);
  });
});
