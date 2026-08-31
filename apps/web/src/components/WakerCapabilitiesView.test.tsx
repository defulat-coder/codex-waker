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
      screen.getByRole('tab', { name: '连接器' }).getAttribute('aria-selected'),
      'true',
    );
    assert.ok(screen.getByLabelText('连接器名称'));
  });

  it('opens on the permissions tab when initialTab="permissions"', async () => {
    mockFetch();
    renderCapabilities('permissions');
    await settle();
    assert.equal(
      screen.getByRole('tab', { name: '权限' }).getAttribute('aria-selected'),
      'true',
    );
    assert.equal(
      screen.getByRole('tab', { name: '连接器' }).getAttribute('aria-selected'),
      'false',
    );
    assert.ok(screen.getByRole('heading', { name: 'Host 上限' }));
  });

  it('uses roving focus and arrow keys across capability tabs', async () => {
    mockFetch();
    renderCapabilities();
    await settle();
    const connectors = screen.getByRole('tab', { name: '连接器' });
    const permissionsTab = screen.getByRole('tab', { name: '权限' });
    const actionsTab = screen.getByRole('tab', { name: '人工操作' });
    assert.equal(connectors.tabIndex, 0);
    assert.equal(permissionsTab.tabIndex, -1);

    connectors.focus();
    fireEvent.keyDown(connectors, { key: 'ArrowRight' });
    assert.equal(document.activeElement, permissionsTab);
    assert.equal(permissionsTab.getAttribute('aria-selected'), 'true');
    assert.ok(screen.getByRole('tabpanel', { name: '权限' }));

    fireEvent.keyDown(permissionsTab, { key: 'End' });
    assert.equal(document.activeElement, actionsTab);
    assert.equal(actionsTab.getAttribute('aria-selected'), 'true');
  });

  it('网络中断时本地化错误并可重试恢复能力配置', async () => {
    mockFetch();
    const healthyFetch = globalThis.fetch;
    let shouldFail = true;
    globalThis.fetch = (async (input, init) => {
      if (String(input).includes('/connectors') && shouldFail) {
        shouldFail = false;
        throw new TypeError('Failed to fetch');
      }
      return healthyFetch(input, init);
    }) as typeof fetch;

    renderCapabilities();
    const alert = await screen.findByRole('alert');
    assert.match(alert.textContent ?? '', /能力暂时无法读取/);
    assert.doesNotMatch(alert.textContent ?? '', /Failed to fetch/);
    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    assert.ok(await screen.findByText('还没有连接器。'));
  });

  it('本地化连接器与人工操作状态', async () => {
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes('/connectors'))
        return Response.json({
          items: [
            {
              id: 'connector-one',
              wakerId: 'agent-a',
              name: '本地工具',
              transport: 'stdio',
              command: 'tool-server',
              metadata: {},
              status: 'disabled',
              tools: [],
              createdAt: '2026-08-31T00:00:00.000Z',
              updatedAt: '2026-08-31T00:00:00.000Z',
            },
          ],
        });
      if (url.includes('/permissions')) return Response.json(permissions);
      if (url.includes('/human-actions'))
        return Response.json({
          items: [
            {
              id: 'action-one',
              wakerId: 'agent-a',
              source: 'workflow',
              sourceId: 'workflow-one',
              kind: 'confirm',
              title: '确认发布',
              prompt: '是否继续？',
              status: 'pending',
              version: 1,
              createdAt: '2026-08-31T00:00:00.000Z',
              updatedAt: '2026-08-31T00:00:00.000Z',
            },
          ],
        });
      throw new Error(`未 mock 的请求：${url}`);
    }) as typeof fetch;

    renderCapabilities();
    assert.ok(await screen.findByText('本地工具'));
    assert.ok(screen.getByText('已禁用'));
    fireEvent.click(screen.getByRole('tab', { name: '人工操作 (1)' }));
    assert.ok(screen.getByText('待处理'));
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

  it('locks permission updates while the request is pending', async () => {
    let updates = 0;
    let resolveUpdate!: (response: Response) => void;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes('/permissions') && init?.method === 'PUT') {
        updates += 1;
        return new Promise<Response>((resolve) => {
          resolveUpdate = resolve;
        });
      }
      if (url.includes('/connectors')) return Response.json({ items: [] });
      if (url.includes('/permissions')) return Response.json(permissions);
      if (url.includes('/human-actions')) return Response.json({ items: [] });
      throw new Error(`未 mock 的请求：${url}`);
    }) as typeof fetch;
    renderCapabilities('permissions');
    await settle();

    const save = screen.getByRole('button', { name: '收紧为只读并禁用工具' });
    act(() => {
      save.click();
      save.click();
    });
    assert.equal((save as HTMLButtonElement).disabled, true);
    assert.equal(save.textContent, '正在保存…');
    assert.equal(updates, 1);

    resolveUpdate(Response.json(permissions));
    await waitFor(() =>
      assert.ok(screen.getByRole('button', { name: '收紧为只读并禁用工具' })),
    );
  });
});
