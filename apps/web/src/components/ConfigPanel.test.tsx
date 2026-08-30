import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AgentDetail, AgentResources, WorkspaceResponse } from '@waker/contracts';
import { WorkspaceProvider } from '../context/WorkspaceContext.js';
import { ConfigPanel } from './ConfigPanel.js';
import type { Notify } from './Toasts.js';

const originalFetch = globalThis.fetch;

const workspace: WorkspaceResponse = {
  agents: [],
  prompts: [],
  host: { name: 'test-host' },
  models: { current: {}, available: [] },
};

const SECTIONED_BODY =
  '## 身份\n负责发散想法与方案对比。\n\n## 人设\n\n## 设定集\n- 先发散再收敛\n- 主动唱反调\n';
const FALLBACK_BODY = '你是头脑风暴伙伴，帮助用户发散与收敛想法。';

const RESOURCES: AgentResources = {
  prompts: [],
  skills: [],
  appendSystem: false,
  stats: { sessionCount: 0, questionCount: 0 },
};

function agentDetail(body: string): AgentDetail {
  return {
    id: 'brainstormer',
    name: '头脑风暴',
    mark: '想',
    tagline: '发散想法与方案对比',
    description: '围绕一个主题发散想法。',
    suggestions: ['帮我想 5 个产品点子'],
    path: '.codex/agents/brainstormer.md',
    hasAvatar: false,
    body,
  };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type Call = { url: string; method: string; body?: Record<string, unknown> };

/** 安装 API mock：GET 详情/资源 + PATCH 详情；currentBody 持有「服务端」最新 body。 */
function installApi(calls: Call[], currentBody: { value: string }) {
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    calls.push({ url, method, body });
    if (url.endsWith('/agents/brainstormer/resources')) return json(RESOURCES);
    if (url.endsWith('/agents/brainstormer') && method === 'PATCH') {
      if (typeof body?.body === 'string') currentBody.value = body.body;
      return json(agentDetail(currentBody.value));
    }
    if (url.endsWith('/agents/brainstormer')) return json(agentDetail(currentBody.value));
    return json({ error: `unexpected ${url}` }, 500);
  }) as typeof fetch;
}

function renderPanel(notify: Notify = () => undefined) {
  return render(
    <WorkspaceProvider
      value={{ workspace, sessionsByAgent: {}, notify, reloadWorkspace: () => {} }}
    >
      <ConfigPanel agentId="brainstormer" onClose={() => undefined} onUseSuggestion={() => undefined} />
    </WorkspaceProvider>,
  );
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('ConfigPanel 三上下文卡片', () => {
  it('按约定渲染 01 身份 / 02 人设 / 03 设定集三卡，空段显示暂未设置', async () => {
    const calls: Call[] = [];
    installApi(calls, { value: SECTIONED_BODY });
    renderPanel();
    assert.ok(await screen.findByText('01 身份'));
    assert.ok(screen.getByText('02 人设'));
    assert.ok(screen.getByText('03 设定集'));
    // 身份段经 Markdown 渲染预览；人设为空段；设定集列表项渲染。
    assert.ok(await screen.findByText('负责发散想法与方案对比。'));
    assert.ok(screen.getByText('暂未设置'));
    assert.ok(screen.getByText('先发散再收敛'));
    assert.ok(screen.getByRole('button', { name: '修改基本信息' }));
    assert.ok(screen.getByRole('button', { name: '修改身份' }));
    assert.ok(screen.getByRole('button', { name: '修改人设' }));
    assert.ok(screen.getByRole('button', { name: '修改设定集' }));
  });

  it('分段编辑保存只 PATCH 拼回后的 body，其余段逐字节保留', async () => {
    const calls: Call[] = [];
    const currentBody = { value: SECTIONED_BODY };
    installApi(calls, currentBody);
    const notices: Array<{ text: string; tone?: string }> = [];
    renderPanel((text, tone) => notices.push({ text, tone }));
    await screen.findByText('01 身份');

    fireEvent.click(screen.getByRole('button', { name: '修改人设' }));
    const textarea = screen.getByLabelText('人设内容');
    assert.equal(
      (textarea as HTMLTextAreaElement).placeholder,
      '描述该 Waker 的人设、沟通风格与工作原则',
    );
    fireEvent.change(textarea, { target: { value: '直接、简洁，偶尔唱反调。' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      assert.ok(calls.some((call) => call.method === 'PATCH'));
    });
    const patch = calls.find((call) => call.method === 'PATCH');
    // 只提交 body 字段，frontmatter 不经这次保存。
    assert.deepEqual(Object.keys(patch?.body ?? {}), ['body']);
    const nextBody = String(patch?.body?.body ?? '');
    assert.ok(nextBody.includes('## 人设\n直接、简洁，偶尔唱反调。\n'));
    assert.ok(nextBody.includes('## 身份\n负责发散想法与方案对比。\n\n'));
    assert.ok(nextBody.includes('## 设定集\n- 先发散再收敛\n- 主动唱反调\n'));
    await waitFor(() =>
      assert.deepEqual(notices.at(-1), { text: 'Agent 定义已保存', tone: 'success' }),
    );
    // 保存成功后退出编辑态并展示新内容。
    assert.ok(await screen.findByText('直接、简洁，偶尔唱反调。'));
  });

  it('分段保存失败时停留在编辑态并 toast 错误', async () => {
    const calls: Call[] = [];
    installApi(calls, { value: SECTIONED_BODY });
    const failingFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.endsWith('/agents/brainstormer') && (init?.method ?? 'GET') === 'PATCH') {
        return json({ error: 'body 过大' }, 400);
      }
      return failingFetch(input, init);
    }) as typeof fetch;
    const notices: Array<{ text: string; tone?: string }> = [];
    renderPanel((text, tone) => notices.push({ text, tone }));
    await screen.findByText('01 身份');

    fireEvent.click(screen.getByRole('button', { name: '修改身份' }));
    fireEvent.change(screen.getByLabelText('身份内容'), { target: { value: '新身份' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      assert.deepEqual(notices.at(-1), { text: 'body 过大', tone: 'error' }),
    );
    // 编辑态保留，可继续修改或取消。
    assert.ok(screen.getByLabelText('身份内容'));
  });

  it('body 不符合小节约定时回退整段模式：说明条 + 整段预览 + 整段编辑', async () => {
    const calls: Call[] = [];
    installApi(calls, { value: FALLBACK_BODY });
    renderPanel();
    assert.ok(await screen.findByText('该 Waker 的人设文档未按 身份/人设/设定集 分段，编辑将对整个文档生效。'));
    assert.ok(screen.getByText('你是头脑风暴伙伴，帮助用户发散与收敛想法。'));
    // 没有分段编辑入口。
    assert.equal(screen.queryByRole('button', { name: '修改人设' }), null);

    fireEvent.click(screen.getByRole('button', { name: '修改人设文档' }));
    // 进入现有整表编辑表单（frontmatter + body 大 textarea）。
    const textarea = await screen.findByLabelText('系统提示词');
    assert.equal((textarea as HTMLTextAreaElement).value, FALLBACK_BODY);
    assert.ok(screen.getByLabelText('名称'));
  });
});
