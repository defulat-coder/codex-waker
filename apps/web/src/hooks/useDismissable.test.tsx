import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fireEvent, renderHook } from '@testing-library/react';
import { useDismissable } from './useDismissable.js';

describe('useDismissable', () => {
  it('点击 ref 外部时触发 onDismiss', () => {
    const ref = { current: document.createElement('div') };
    let calls = 0;
    renderHook(() =>
      useDismissable(ref, () => {
        calls += 1;
      }),
    );
    fireEvent.pointerDown(document.body);
    assert.equal(calls, 1);
  });

  it('按 Escape 触发 onDismiss；点击内部不触发', () => {
    const ref = { current: document.createElement('div') };
    document.body.appendChild(ref.current);
    let calls = 0;
    const { unmount } = renderHook(() =>
      useDismissable(ref, () => {
        calls += 1;
      }),
    );
    fireEvent.pointerDown(ref.current);
    assert.equal(calls, 0);
    fireEvent.keyDown(window, { key: 'Escape' });
    assert.equal(calls, 1);
    unmount();
    ref.current.remove();
  });

  it('active 为 false 时不监听', () => {
    const ref = { current: document.createElement('div') };
    let calls = 0;
    renderHook(() =>
      useDismissable(
        ref,
        () => {
          calls += 1;
        },
        false,
      ),
    );
    fireEvent.pointerDown(document.body);
    fireEvent.keyDown(window, { key: 'Escape' });
    assert.equal(calls, 0);
  });
});
