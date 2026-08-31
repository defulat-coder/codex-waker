import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type {
  AgentDetail,
  AgentHomeResponse,
  AgentSummary,
  AutomationRunRecord,
  SessionSummary,
} from '@waker/contracts';
import { WakerHomeView } from './WakerHomeView.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const agent: AgentSummary = {
  id: 'agent-a',
  name: '写作助手',
  mark: '写',
  tagline: '起草与改写',
  description: '帮助起草与改写中文内容。',
  suggestions: ['帮我写一段介绍'],
};

const detail: AgentDetail = {
  ...agent,
  body: '你是写作助手。',
  path: '.codex/agents/agent-a.md',
  strengths: [{ title: '起草成文', text: '从要点起草邮件与介绍。' }],
  workStyles: [{ title: '结构优先', text: '结论在前，段落短。' }],
};

const HIRE_DATE = '2026-06-15T12:00:00.000Z';
/** 与服务端 date(updated_at) 一致的 UTC 日期键。 */
const todayKey = new Date().toISOString().slice(0, 10);

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

const home: AgentHomeResponse = {
  createdAt: HIRE_DATE,
  counts: { sessions: 2, questions: 5, automations: 1, projects: 3, workflows: 0, tasks: 4 },
  activity: [{ date: todayKey, count: 3 }],
};

const sessions: SessionSummary[] = [
  {
    id: 'session-1',
    agentId: 'agent-a',
    title: '周报起草',
    createdAt: daysAgoIso(2),
    updatedAt: daysAgoIso(1),
    questionCount: 4,
    needsAttention: false,
  },
  {
    id: 'session-2',
    agentId: 'agent-a',
    title: '邮件润色',
    createdAt: daysAgoIso(3),
    updatedAt: daysAgoIso(3),
    questionCount: 1,
    needsAttention: false,
  },
];

const runs: AutomationRunRecord[] = [
  {
    id: 'run-1',
    automationId: 'auto-1',
    taskId: 'task-1',
    wakerId: 'agent-a',
    status: 'succeeded',
    trigger: 'scheduled',
    nameSnapshot: '每日摘要',
    promptSnapshot: '生成每日摘要',
    attempt: 1,
    createdAt: daysAgoIso(1),
    updatedAt: daysAgoIso(1),
  },
];

function mockFetch(overrides: {
  detail?: AgentDetail;
  home?: AgentHomeResponse;
  sessions?: SessionSummary[];
  runs?: AutomationRunRecord[];
} = {}) {
  const payload = {
    detail: overrides.detail ?? detail,
    home: overrides.home ?? home,
    sessions: overrides.sessions ?? sessions,
    runs: overrides.runs ?? runs,
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/home')) return Response.json(payload.home);
    if (url.includes('/sessions')) {
      return Response.json({ items: payload.sessions, total: payload.sessions.length });
    }
    if (url.includes('/automation-runs')) {
      return Response.json({ items: payload.runs, total: payload.runs.length });
    }
    return Response.json(payload.detail);
  }) as typeof fetch;
}

function renderHome(props: Partial<Parameters<typeof WakerHomeView>[0]> = {}) {
  const calls = { edit: 0 };
  const view = render(
    <WakerHomeView
      agent={agent}
      onEdit={() => {
        calls.edit += 1;
      }}
      {...props}
    />,
  );
  return { ...view, calls };
}

/** 等待四个接口数据落到组件状态。 */
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('WakerHomeView', () => {
  it('shows the loading state before data arrives', () => {
    globalThis.fetch = (async () => new Promise<Response>(() => {})) as typeof fetch;
    renderHome();
    assert.ok(screen.getByLabelText('正在加载'));
    // 资料卡不依赖接口数据，加载中也应渲染。
    assert.ok(screen.getByRole('heading', { name: /写作助手/ }));
  });

  it('renders the profile card with real hire date and the edit action', async () => {
    mockFetch();
    const { calls } = renderHome();
    await settle();
    assert.ok(screen.getByText('在线'));
    assert.ok(screen.getByText('ID: agent-a'));
    assert.ok(screen.getByText('入职时间：2026年6月15日'));
    // 描述同时渲染在资料卡与「关于我 · 简介」中。
    assert.ok(screen.getAllByText('帮助起草与改写中文内容。').length >= 1);
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    assert.equal(calls.edit, 1);
    // 返回「我的 Waker」由 WakerDetailNav 提供，视图内不再渲染返回按钮。
    assert.equal(screen.queryByRole('button', { name: '我的 Waker' }), null);
  });

  it('renders the legacy stats labels with values from the home payload', async () => {
    mockFetch();
    renderHome();
    await settle();
    const created = new Date(HIRE_DATE);
    const start = new Date(created.getFullYear(), created.getMonth(), created.getDate()).getTime();
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const tenure = Math.max(1, Math.floor((today - start) / 86_400_000) + 1);
    for (const label of ['入职天数', '对话任务', '自动任务', '已创建的项目']) {
      // 与工作记录切换按钮同名，限定在统计行的 dt 上。
      assert.ok(screen.getByText(label, { selector: 'dt' }), `缺少统计项 ${label}`);
    }
    assert.ok(screen.getByText(`${tenure} 天`));
    assert.ok(screen.getByText('2', { selector: 'dd' }));
    assert.ok(screen.getByText('1', { selector: 'dd' }));
    assert.ok(screen.getByText('3', { selector: 'dd' }));
  });

  it('renders a 52-week heatmap with per-day aria-labels and counts', async () => {
    mockFetch();
    const { container } = renderHome();
    await settle();
    assert.ok(screen.getByRole('heading', { name: '活跃度热力图' }));
    // 52 列 × 7 行：有数据的日期带 aria-label，未来日期是占位格。
    assert.equal(container.querySelectorAll('.waker-home-heatmap-cell').length, 52 * 7);
    const labeled = container.querySelectorAll('[aria-label*="每日工作量"]');
    assert.ok(labeled.length > 52 * 7 - 7);
    const cell = screen.getByLabelText(`${todayKey}, 每日工作量：3`);
    assert.equal(cell.getAttribute('title'), `${todayKey}, 每日工作量：3`);
    assert.ok(cell.className.includes('level-2'));
    // 周一/周三/周五 行标签与月份标签（月初边界时当前月可能落在下周列，只断言标签存在）。
    for (const weekday of ['周一', '周三', '周五']) assert.ok(screen.getByText(weekday));
    const months = container.querySelector('.waker-home-heatmap-months');
    assert.ok(months && months.children.length > 0, '应渲染月份标签');
  });

  it('merges session and automation events into the timeline view by default', async () => {
    mockFetch();
    renderHome();
    await settle();
    assert.ok(screen.getByText('创建对话任务「周报起草」'));
    assert.ok(screen.getByText('更新对话任务「周报起草」'));
    // 创建后未更新的会话只产生创建事件。
    assert.ok(screen.getByText('创建对话任务「邮件润色」'));
    assert.equal(screen.queryByText('更新对话任务「邮件润色」'), null);
    assert.ok(screen.getByText('自动任务「每日摘要」成功'));
    assert.ok(screen.getByText('计划触发'));
  });

  it('switches between the timeline, sessions and automation lists', async () => {
    mockFetch();
    renderHome();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: '对话任务' }));
    assert.ok(screen.getByText('周报起草'));
    assert.ok(screen.getByText(/4 个问题/));
    assert.equal(screen.queryByText('创建对话任务「周报起草」'), null);
    fireEvent.click(screen.getByRole('button', { name: '自动任务' }));
    assert.ok(screen.getByText('每日摘要'));
    assert.ok(screen.getByText(/计划触发 · 成功/));
    fireEvent.click(screen.getByRole('button', { name: '时间线视图' }));
    assert.ok(screen.getByText('创建对话任务「周报起草」'));
  });

  it('renders 关于我 sections only when the definition provides them', async () => {
    mockFetch();
    renderHome();
    await settle();
    assert.ok(screen.getByRole('heading', { name: '关于我' }));
    assert.ok(screen.getByRole('heading', { name: '我最擅长' }));
    assert.ok(screen.getByText('起草成文'));
    assert.ok(screen.getByRole('heading', { name: '工作风格' }));
    assert.ok(screen.getByText('结构优先'));
    assert.ok(screen.getByRole('heading', { name: '建议问题' }));
    assert.ok(screen.getByText('帮我写一段介绍'));
  });

  it('omits 我最擅长/工作风格 for definitions without sections', async () => {
    const plain: AgentDetail = { ...detail };
    delete plain.strengths;
    delete plain.workStyles;
    mockFetch({ detail: plain });
    renderHome();
    await settle();
    assert.ok(screen.getByRole('heading', { name: '关于我' }));
    assert.equal(screen.queryByRole('heading', { name: '我最擅长' }), null);
    assert.equal(screen.queryByRole('heading', { name: '工作风格' }), null);
    // 建议问题仍在（来自 suggestions）。
    assert.ok(screen.getByRole('heading', { name: '建议问题' }));
  });

  it('derives the profile via the API and refreshes 关于我 sections', async () => {
    let current: AgentDetail = { ...detail };
    delete current.strengths;
    delete current.workStyles;
    const requests: Array<{ url: string; body: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/summarize-profile')) {
        requests.push({ url, body: String(init?.body ?? '') });
        current = {
          ...current,
          strengths: [{ title: '派生能力', text: '模型派生的能力描述。' }],
          workStyles: [{ title: '派生风格', text: '模型派生的风格描述。' }],
        };
        return Response.json({
          agentId: agent.id,
          profile: {
            coreCapabilities: current.strengths,
            workStyles: current.workStyles,
            suggestedUseCases: [],
          },
          applied: true,
        });
      }
      if (url.includes('/home')) return Response.json(home);
      if (url.includes('/sessions')) {
        return Response.json({ items: sessions, total: sessions.length });
      }
      if (url.includes('/automation-runs')) {
        return Response.json({ items: runs, total: runs.length });
      }
      return Response.json(current);
    }) as typeof fetch;
    renderHome();
    await settle();
    // 初始定义没有区块，派生按钮仍在「关于我」标题旁。
    assert.equal(screen.queryByRole('heading', { name: '我最擅长' }), null);
    fireEvent.click(screen.getByRole('button', { name: /重新派生/ }));
    await settle();
    assert.equal(requests.length, 1);
    assert.match(requests[0]!.url, /\/api\/v1\/agents\/agent-a\/summarize-profile$/);
    assert.deepEqual(JSON.parse(requests[0]!.body), { apply: true });
    // apply 成功后整体重载，新区块渲染出来。
    assert.ok(screen.getByRole('heading', { name: '我最擅长' }));
    assert.ok(screen.getByText('派生能力'));
    assert.ok(screen.getByText('派生风格'));
  });

  it('shows an inline error when profile derivation fails', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/summarize-profile')) {
        return Response.json({ error: '画像派生失败：模型提供方超时' }, { status: 502 });
      }
      if (url.includes('/home')) return Response.json(home);
      if (url.includes('/sessions')) {
        return Response.json({ items: sessions, total: sessions.length });
      }
      if (url.includes('/automation-runs')) {
        return Response.json({ items: runs, total: runs.length });
      }
      return Response.json(detail);
    }) as typeof fetch;
    renderHome();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /重新派生/ }));
    await settle();
    assert.ok(screen.getByText('画像派生失败：模型提供方超时'));
  });

  it('shows empty states when there are no records', async () => {
    mockFetch({
      sessions: [],
      runs: [],
      home: { ...home, counts: { ...home.counts, sessions: 0, automations: 0 } },
    });
    renderHome();
    await settle();
    assert.ok(screen.getByText('暂无工作记录'));
    fireEvent.click(screen.getByRole('button', { name: '对话任务' }));
    assert.ok(screen.getByText('暂无对话任务'));
    fireEvent.click(screen.getByRole('button', { name: '自动任务' }));
    assert.ok(screen.getByText('暂无自动任务'));
  });

  it('shows an error state with a working retry', async () => {
    let failures = 1;
    globalThis.fetch = (async () => {
      if (failures > 0) {
        failures -= 1;
        throw new TypeError('Failed to fetch');
      }
      return Response.json({});
    }) as typeof fetch;
    renderHome();
    await settle();
    const alert = screen.getByRole('alert');
    assert.match(alert.textContent ?? '', /Waker 主页数据暂时无法读取/);
    assert.doesNotMatch(alert.textContent ?? '', /Failed to fetch/);
    mockFetch();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await settle();
    assert.ok(screen.getByText('入职时间：2026年6月15日'));
  });
});
