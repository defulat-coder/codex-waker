import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Notify } from './Toasts.js';
import type { PermissionEnvelope } from '../lib/api.js';
import { WakerCapabilitiesView } from './WakerCapabilitiesView.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const permissions: PermissionEnvelope = {
  host: {
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    toolGuard: 'deny',
    fileGuard: 'deny',
    builtinTools: [],
  },
  policy: null,
  enforcedBy: 'codex-host',
};

function mockFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/connectors')) return Response.json({ items: [] });
    if (url.includes('/permissions')) return Response.json(permissions);
    if (url.includes('/human-actions')) return Response.json({ items: [] });
    throw new Error(`未 mock 的请求：${url}`);
  }) as typeof fetch;
}

function renderCapabilities(
  initialTab?: 'connectors' | 'permissions',
  notify: Notify = () => undefined,
) {
  return render(
    <WakerCapabilitiesView
      wakerId="agent-a"
      initialTab={initialTab}
      onClose={() => {}}
      notify={notify}
    />,
  );
}

/** 等待三个接口数据落到组件状态。 */
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('WakerCapabilitiesView', () => {
  it('defaults to the connectors tab when initialTab is not provided', async () => {
    mockFetch();
    renderCapabilities();
    await settle();
    assert.equal(
      screen.getByRole('tab', { name: 'Connectors' }).getAttribute('aria-selected'),
      'true',
    );
    assert.ok(screen.getByLabelText('连接器名称'));
  });

  it('opens on the permissions tab when initialTab="permissions"', async () => {
    mockFetch();
    renderCapabilities('permissions');
    await settle();
    assert.equal(
      screen.getByRole('tab', { name: 'Permissions' }).getAttribute('aria-selected'),
      'true',
    );
    assert.equal(
      screen.getByRole('tab', { name: 'Connectors' }).getAttribute('aria-selected'),
      'false',
    );
    assert.ok(screen.getByRole('heading', { name: 'Host 上限' }));
  });

  it('announces a successful permission update with success semantics', async () => {
    const notices: Array<{ text: string; tone?: string }> = [];
    mockFetch();
    renderCapabilities('permissions', (text, tone) => notices.push({ text, tone }));
    await settle();

    fireEvent.click(screen.getByRole('button', { name: '收紧为只读并禁用工具' }));

    await waitFor(() =>
      assert.deepEqual(notices.at(-1), {
        text: '权限已收紧，由 codex-host 执行',
        tone: 'success',
      }),
    );
  });
});
