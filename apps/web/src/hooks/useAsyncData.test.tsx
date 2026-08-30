import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useAsyncData } from './useAsyncData.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('useAsyncData', () => {
  it('keeps the latest reload when an older request settles last', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const queue = [first.promise, second.promise];
    const errors: string[] = [];
    const view = renderHook(() =>
      useAsyncData(() => queue.shift()!, { onError: (error) => errors.push(error.message) }),
    );

    act(() => void view.result.current.reload());
    act(() => void view.result.current.reload());
    await act(async () => second.resolve('new'));
    await waitFor(() => assert.equal(view.result.current.data, 'new'));

    await act(async () => first.reject(new Error('stale failure')));
    assert.equal(view.result.current.data, 'new');
    assert.equal(view.result.current.loading, false);
    assert.equal(view.result.current.loaded, true);
    assert.deepEqual(errors, []);
  });

  it('ignores a request that settles after unmount', async () => {
    const request = deferred<string>();
    const errors: string[] = [];
    const view = renderHook(() =>
      useAsyncData(() => request.promise, { onError: (error) => errors.push(error.message) }),
    );

    act(() => void view.result.current.reload());
    view.unmount();
    await act(async () => request.reject(new Error('late failure')));

    assert.deepEqual(errors, []);
  });
});
