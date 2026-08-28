import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { renderHook } from '@testing-library/react';
import { useVisiblePolling } from './useVisiblePolling.js';

const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');

function setVisibility(state: string) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

afterEach(() => {
  mock.timers.reset();
  if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility);
});

describe('useVisiblePolling', () => {
  it('页面可见时按间隔触发回调', () => {
    mock.timers.enable({ apis: ['setInterval'] });
    setVisibility('visible');
    let calls = 0;
    renderHook(() =>
      useVisiblePolling(() => {
        calls += 1;
      }, 15_000),
    );

    mock.timers.tick(15_000);
    assert.equal(calls, 1);
    mock.timers.tick(30_000);
    assert.equal(calls, 3);
  });

  it('页面隐藏时跳过回调；卸载后清理 timer', () => {
    mock.timers.enable({ apis: ['setInterval'] });
    setVisibility('hidden');
    let calls = 0;
    const { unmount } = renderHook(() =>
      useVisiblePolling(() => {
        calls += 1;
      }, 15_000),
    );

    mock.timers.tick(45_000);
    assert.equal(calls, 0, '隐藏页签不应触发轮询');

    setVisibility('visible');
    mock.timers.tick(15_000);
    assert.equal(calls, 1, '恢复可见后继续轮询');

    unmount();
    mock.timers.tick(45_000);
    assert.equal(calls, 1, '卸载后不再触发');
  });
});
