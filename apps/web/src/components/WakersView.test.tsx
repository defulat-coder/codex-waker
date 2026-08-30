import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { AgentDeleteImpact, AgentSummary } from '@waker/contracts';
import { WakersView } from './LegacyWorkbench.js';

const originalFetch = globalThis.fetch;
const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return styles.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const HOST = 'test-host';

function makeAgents(count: number, patch?: Partial<AgentSummary>): AgentSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `agent-${index}`,
    name: `Agent ${index}`,
    mark: `A${index}`,
    tagline: `角色 ${index}`,
    description: `描述 ${index}`,
    suggestions: [],
    ...patch,
  }));
}

const agents: AgentSummary[] = [
  {
    id: 'agent-a',
    name: 'Agent A',
    mark: 'AA',
    tagline: 'A',
    description: 'A',
    suggestions: [],
  },
  {
    id: 'agent-b',
    name: 'Agent B',
    mark: 'BB',
    tagline: 'B',
    description: 'B',
    suggestions: [],
  },
];

function impact(agentId: string, sessions: number): AgentDeleteImpact {
  return {
    agentId,
    sessions,
    projects: 0,
    automations: 0,
    workflows: 0,
    tasks: 0,
    humanActions: 0,
    connectors: 0,
    memories: 1,
    knowledgeBindings: 2,
    sharedSkills: 1,
    behavior: {
      definition: 'delete',
      sessions: 'delete',
      projects: 'delete-record-only',
      board: 'soft-delete-history',
      connectors: 'delete',
      memories: 'soft-delete',
      knowledgeBindings: 'delete',
      skills: 'shared-preserve',
    },
  };
}

function renderWakers(
  props: Partial<Parameters<typeof WakersView>[0]> = {},
  agentList: AgentSummary[] = agents,
) {
  const calls = {
    onChat: [] as string[],
    onConfigure: [] as string[],
    onOpenHome: [] as string[],
    onReadAll: 0,
  };
  const view = render(
    <WakersView
      agents={agentList}
      hostName={HOST}
      onChat={(id) => calls.onChat.push(id)}
      onConfigure={(id) => calls.onConfigure.push(id)}
      onMemory={() => {}}
      onCapabilities={() => {}}
      onAutomation={() => {}}
      onOpenHome={(id) => calls.onOpenHome.push(id)}
      onCreated={() => {}}
      onDeleted={() => {}}
      onReadAll={() => {
        calls.onReadAll += 1;
      }}
      notify={() => {}}
      {...props}
    />,
  );
  return { ...view, calls };
}

/** 打开某张卡片的「更多操作」菜单并点击其中一个菜单项。 */
function clickMoreAction(card: HTMLElement, agentName: string, action: string) {
  fireEvent.click(within(card).getByRole('button', { name: `${agentName} 的更多操作` }));
  fireEvent.click(
    within(screen.getByRole('menu', { name: `${agentName} 的更多操作` })).getByRole('menuitem', {
      name: action,
    }),
  );
}

describe('WakersView delete impact', () => {
  it('discards a late impact response from a previously selected Waker', async () => {
    const a = deferred<Response>();
    const b = deferred<Response>();
    globalThis.fetch = (async (input) =>
      String(input).includes('agent-a') ? a.promise : b.promise) as typeof fetch;
    renderWakers();

    const cardA = screen.getByRole('heading', { name: /Agent A/ }).closest('article')!;
    clickMoreAction(cardA, 'Agent A', '删除');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    const cardB = screen.getByRole('heading', { name: /Agent B/ }).closest('article')!;
    clickMoreAction(cardB, 'Agent B', '删除');

    await act(async () => {
      a.resolve(Response.json(impact('agent-a', 99)));
      await Promise.resolve();
    });
    const dialog = screen.getByRole('dialog', { name: '删除 Agent B' });
    assert.match(dialog.textContent ?? '', /正在检查/);
    assert.doesNotMatch(dialog.textContent ?? '', /99 个会话/);

    await act(async () => {
      b.resolve(Response.json(impact('agent-b', 2)));
      await Promise.resolve();
    });
    assert.match(dialog.textContent ?? '', /2 个会话/);
  });
});

describe('WakersView 管理视图', () => {
  it('renders the legacy header copy and the management tabs', () => {
    renderWakers();
    assert.ok(screen.getByRole('heading', { name: '我的Wakers' }));
    assert.ok(
      screen.getByText('跨云端、本地与其他设备管理你的 Waker，快速发起对话任务和自动任务。'),
    );
    const tablist = screen.getByRole('tablist', { name: '管理分类' });
    const wakers = within(tablist).getByRole('tab', { name: '我的Waker' });
    const groups = within(tablist).getByRole('tab', { name: '我的群组' });
    assert.ok(wakers);
    assert.ok(groups);
    assert.equal(
      wakers.getAttribute('aria-selected'),
      'true',
    );
    assert.equal(wakers.tabIndex, 0);
    assert.equal(groups.tabIndex, -1);
    wakers.focus();
    fireEvent.keyDown(wakers, { key: 'ArrowRight' });
    assert.equal(document.activeElement, groups);
    assert.equal(groups.getAttribute('aria-selected'), 'true');
    assert.ok(screen.getByRole('tabpanel', { name: '我的群组' }));
    fireEvent.keyDown(groups, { key: 'ArrowRight' });
    assert.equal(document.activeElement, wakers);
  });

  it('shows an explicit degraded notice on the groups tab without any create action', () => {
    renderWakers();
    fireEvent.click(screen.getByRole('tab', { name: '我的群组' }));
    assert.ok(screen.getByText('云端多 Waker 群组在本地模式不可用'));
    assert.ok(screen.getByText(/本地聊天以单个 Waker 为单位/));
    assert.equal(screen.queryByRole('button', { name: /新建Waker/ }), null);
    assert.equal(screen.queryByRole('button', { name: /新建群组/ }), null);
    assert.equal(screen.queryByRole('article'), null);
    // 切回「我的Waker」恢复卡片与头部操作。
    fireEvent.click(screen.getByRole('tab', { name: '我的Waker' }));
    assert.ok(screen.getByRole('button', { name: /新建Waker/ }));
    assert.ok(screen.getByRole('heading', { name: /Agent A/ }));
  });

  it('filters with the 仅在线 toggle (all local Wakers are online)', () => {
    renderWakers();
    const toggle = screen.getByRole('button', { name: /仅在线/ });
    assert.equal(toggle.getAttribute('aria-pressed'), 'false');
    fireEvent.click(toggle);
    assert.equal(toggle.getAttribute('aria-pressed'), 'true');
    // 本地所有 Waker 都在线：开启过滤后列表不缩小。
    assert.ok(screen.getByRole('heading', { name: /Agent A/ }));
    assert.ok(screen.getByRole('heading', { name: /Agent B/ }));
  });

  it('lists the real host in the environment dropdown and applies the selection', () => {
    renderWakers();
    fireEvent.click(screen.getByRole('button', { name: /环境 \/ 全部环境/ }));
    const menu = screen.getByRole('menu', { name: '环境' });
    assert.ok(within(menu).getByText(HOST));
    assert.ok(within(menu).getByText('当前机器'));
    assert.ok(within(menu).getByText(`在线 ${agents.length} 名`));
    assert.ok(within(menu).getByText('本地'));
    assert.ok(within(menu).getByText(`${agents.length} 名员工`));
    const items = within(menu).getAllByRole('menuitemradio');
    assert.equal(document.activeElement, items[0]);
    assert.deepEqual(
      items.map((item) => item.tabIndex),
      [-1, -1],
    );
    fireEvent.keyDown(items[0]!, { key: 'ArrowDown' });
    assert.equal(document.activeElement, items[1]);
    fireEvent.keyDown(items[1]!, { key: 'Escape' });
    assert.equal(screen.queryByRole('menu', { name: '环境' }), null);
    assert.equal(document.activeElement, screen.getByRole('button', { name: /环境 \/ 全部环境/ }));

    fireEvent.click(screen.getByRole('button', { name: /环境 \/ 全部环境/ }));
    const reopened = screen.getByRole('menu', { name: '环境' });
    fireEvent.click(within(reopened).getByRole('menuitemradio', { name: new RegExp(HOST) }));
    const selectedEnvironment = screen.getByRole('button', { name: new RegExp(`环境 / ${HOST}`) });
    assert.ok(selectedEnvironment);
    assert.equal(document.activeElement, selectedEnvironment);
    // 本地只有一台机器：选中本机环境后列表仍是全部 Waker。
    assert.ok(screen.getByRole('heading', { name: /Agent A/ }));
    assert.ok(screen.getByRole('heading', { name: /Agent B/ }));
  });

  it('uses the legacy search placeholder and keeps client-side search', () => {
    renderWakers();
    const input = screen.getByLabelText('搜索 Waker');
    assert.equal(input.getAttribute('placeholder'), '搜索员工或者设备...');
    assert.equal(input.closest('label')?.className, 'waker-toolbar-search');
    fireEvent.change(input, { target: { value: 'Agent B' } });
    assert.equal(screen.queryByRole('heading', { name: /Agent A/ }), null);
    assert.ok(screen.getByRole('heading', { name: /Agent B/ }));
  });

  it('keeps the Waker search surface on light and dark theme tokens', () => {
    const rule = cssRule('.waker-toolbar-search');
    assert.match(rule, /background:\s*var\(--bg-primary\)/);
    assert.match(rule, /border:\s*1px solid var\(--border-default\)/);
  });

  it('keeps the Waker management canvas, tabs and cards on theme tokens', () => {
    assert.match(cssRule('.legacy-page'), /background:\s*var\(--bg-secondary\)/);
    assert.match(cssRule('.waker-tabs'), /background:\s*var\(--bg-tertiary\)/);
    assert.match(cssRule('.waker-tab.active'), /background:\s*var\(--bg-primary\)/);
    assert.match(cssRule('.waker-card'), /background:\s*var\(--bg-primary\)/);
    assert.match(cssRule('.waker-card'), /border:\s*1px solid var\(--border-subtle\)/);
    assert.match(cssRule('.waker-actions'), /border-top:\s*1px solid var\(--border-subtle\)/);
  });

  it('shows online status and the real device line on each card', () => {
    renderWakers();
    const card = screen.getByRole('heading', { name: /Agent A/ }).closest('article')!;
    assert.ok(within(card).getByText('在线'));
    assert.ok(within(card).getByText('本机'));
    assert.ok(within(card).getByRole('button', { name: /创建对话任务/ }));
    assert.ok(within(card).getByRole('button', { name: /创建自动任务/ }));
  });

  it('links the card upper area to the Waker home view', () => {
    const { calls } = renderWakers();
    const card = screen.getByRole('heading', { name: /Agent A/ }).closest('article')!;
    const openLink = within(card).getByRole('button', { name: '查看 Agent A 的角色详情' });
    // 详情入口包住头像、名称、设备与描述，不影响既有操作按钮。
    assert.ok(openLink.contains(within(card).getByText('本机')));
    fireEvent.click(openLink);
    assert.deepEqual(calls.onOpenHome, ['agent-a']);
    assert.deepEqual(calls.onChat, [], '详情入口不应触发对话');
  });

  it('groups 配置/记忆/能力/导出/删除 into the 更多操作 menu', () => {
    const { calls } = renderWakers();
    const card = screen.getByRole('heading', { name: /Agent A/ }).closest('article')!;
    fireEvent.click(within(card).getByRole('button', { name: 'Agent A 的更多操作' }));
    const menu = screen.getByRole('menu', { name: 'Agent A 的更多操作' });
    for (const action of ['配置', '记忆', '能力', '导出', '删除']) {
      assert.ok(within(menu).getByRole('menuitem', { name: action }), `缺少菜单项 ${action}`);
    }
    const trigger = within(card).getByRole('button', { name: 'Agent A 的更多操作' });
    const menuItems = within(menu).getAllByRole('menuitem');
    assert.equal(document.activeElement, menuItems[0]);
    fireEvent.keyDown(menuItems[0]!, { key: 'End' });
    assert.equal(document.activeElement, menuItems.at(-1));
    fireEvent.keyDown(menuItems.at(-1)!, { key: 'Escape' });
    assert.equal(screen.queryByRole('menu', { name: 'Agent A 的更多操作' }), null);
    assert.equal(document.activeElement, trigger);

    fireEvent.click(trigger);
    const reopened = screen.getByRole('menu', { name: 'Agent A 的更多操作' });
    const exportLink = within(reopened).getByRole('menuitem', { name: '导出' });
    assert.equal(exportLink.getAttribute('href'), '/api/v1/agents/agent-a/source');
    fireEvent.click(within(reopened).getByRole('menuitem', { name: '配置' }));
    assert.deepEqual(calls.onConfigure, ['agent-a']);
    assert.equal(document.activeElement, trigger);
  });

  it('paginates client-side with a page size of 12', () => {
    const many = makeAgents(13);
    const { container } = renderWakers({}, many);
    assert.equal(container.querySelectorAll('.waker-card').length, 12);
    const pager = screen.getByRole('navigation', { name: 'Waker 分页' });
    assert.ok(within(pager).getByText('1 / 2'));
    fireEvent.click(within(pager).getByRole('button', { name: '下一页' }));
    assert.equal(container.querySelectorAll('.waker-card').length, 1);
    assert.ok(within(pager).getByText('2 / 2'));
    fireEvent.click(within(pager).getByRole('button', { name: '上一页' }));
    assert.equal(container.querySelectorAll('.waker-card').length, 12);
  });

  it('hides the pager when everything fits on one page', () => {
    renderWakers();
    assert.equal(screen.queryByRole('navigation', { name: 'Waker 分页' }), null);
  });

  it('shows per-agent unread badges and marks everything read via the API', async () => {
    const requests: { url: string; method: string }[] = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({ url: String(input), method: init?.method ?? 'GET' });
      return Response.json({ updated: 2 });
    }) as typeof fetch;
    const unreadAgents: AgentSummary[] = [
      { ...agents[0]!, unreadCount: 2 },
      { ...agents[1]!, unreadCount: 0 },
    ];
    const { calls } = renderWakers({}, unreadAgents);

    const cardA = screen.getByRole('heading', { name: /Agent A/ }).closest('article')!;
    assert.equal(within(cardA).getByLabelText('2 个未读会话').textContent, '2');
    const cardB = screen.getByRole('heading', { name: /Agent B/ }).closest('article')!;
    assert.equal(within(cardB).queryByLabelText(/个未读会话/), null);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '全部标为已读' }));
      await Promise.resolve();
    });
    assert.ok(
      requests.some(
        (request) => request.method === 'POST' && request.url === '/api/v1/inbox/read-all',
      ),
      '应调用 POST /api/v1/inbox/read-all',
    );
    assert.equal(calls.onReadAll, 1);
  });

  it('hides 全部标为已读 when there is nothing unread', () => {
    renderWakers();
    assert.equal(screen.queryByRole('button', { name: '全部标为已读' }), null);
  });
});
