import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fireEvent, render, screen } from '@testing-library/react';
import type { LocalResourcesResponse } from '@waker/contracts';
import { ResourcesView } from './LegacyWorkbench.js';

const originalFetch = globalThis.fetch;

const resources: LocalResourcesResponse = {
  projects: [],
  automations: [],
  workflows: [],
  channels: [
    {
      id: 'channel-one',
      provider: 'local',
      name: '本地通知',
      status: 'stopped',
      config: {},
      createdAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:00.000Z',
    },
  ],
  tasks: [],
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('ResourcesView', () => {
  it('本地化 IM 渠道来源与状态', async () => {
    globalThis.fetch = (async () => Response.json(resources)) as typeof fetch;
    render(<ResourcesView kind="im" wakerId="waker-one" notify={() => {}} />);

    assert.ok(await screen.findByText('本地通知'));
    assert.ok(screen.getByText('本地'));
    assert.ok(screen.getByText('已停止'));
    assert.equal(screen.queryByText('stopped'), null);
  });

  it('网络中断时本地化错误并可重试恢复渠道', async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError('Failed to fetch');
      return Response.json(resources);
    }) as typeof fetch;
    render(<ResourcesView kind="im" wakerId="waker-one" notify={() => {}} />);

    const alert = await screen.findByRole('alert');
    assert.match(alert.textContent ?? '', /资源暂时无法读取/);
    assert.doesNotMatch(alert.textContent ?? '', /Failed to fetch/);
    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    assert.ok(await screen.findByText('本地通知'));
    assert.equal(attempts, 2);
  });
});
