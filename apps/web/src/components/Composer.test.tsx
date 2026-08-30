import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { WorkspaceResponse } from '@waker/contracts';
import type { PreparedComposerAttachment } from '../lib/composerAttachments.js';
import { WorkspaceProvider } from '../context/WorkspaceContext.js';
import { Composer } from './Composer.js';

const workspace: WorkspaceResponse = {
  agents: [],
  prompts: [],
  host: { name: 'test-host' },
  models: { current: {}, available: [] },
};
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function renderComposer(
  onSend: (
    text: string,
    attachments?: PreparedComposerAttachment[],
    onSuccess?: () => void,
  ) => boolean,
  workspaceOverride: Partial<WorkspaceResponse> = {},
  resettable = false,
) {
  function Fixture() {
    const [attachments, setAttachments] = useState<PreparedComposerAttachment[]>([]);
    const [resetSignal, setResetSignal] = useState(0);
    return (
      <>
        {resettable && (
          <button type="button" onClick={() => setResetSignal((value) => value + 1)}>
            重置 Composer
          </button>
        )}
        <Composer
          resetSignal={resetSignal}
          disabled={false}
          selectedModel={undefined}
          onSelectModel={() => undefined}
          onSend={onSend}
          attachments={attachments}
          onAttachmentsChange={setAttachments}
        />
      </>
    );
  }
  return render(
    <WorkspaceProvider
      value={{
        workspace: { ...workspace, ...workspaceOverride },
        sessionsByAgent: {},
        notify: () => undefined,
        reloadWorkspace: () => {},
      }}
    >
      <Fixture />
    </WorkspaceProvider>,
  );
}

describe('Composer prompt panel', () => {
  const prompts = [
    { name: 'explain', path: '.codex/prompts/explain.md', description: '解释概念' },
    { name: 'review', path: '.codex/prompts/review.md', description: '评审代码' },
  ];

  it('通过 combobox 关联选项，并阻止无匹配时的 Enter 绕过禁用发送按钮', () => {
    let sends = 0;
    renderComposer(
      () => {
        sends += 1;
        return true;
      },
      { prompts },
    );
    const input = screen.getByRole('combobox', { name: '消息输入框' });
    fireEvent.change(input, { target: { value: '/' } });
    const listbox = screen.getByRole('listbox', { name: '提示词列表' });
    const options = within(listbox).getAllByRole('option');
    assert.equal(input.getAttribute('aria-expanded'), 'true');
    assert.equal(input.getAttribute('aria-controls'), listbox.id);
    assert.equal(input.getAttribute('aria-activedescendant'), options[0]!.id);
    assert.ok(options.every((option) => option.tabIndex === -1));

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    assert.equal(input.getAttribute('aria-activedescendant'), options[1]!.id);
    fireEvent.change(input, { target: { value: '/missing' } });
    assert.equal(screen.getByRole('button', { name: '发送消息' }).hasAttribute('disabled'), true);
    fireEvent.keyDown(input, { key: 'Enter' });
    assert.equal(sends, 0);
    assert.ok(screen.getByText(/按 Esc 关闭后可按原文发送/));
  });

  it('提示词读取失败时保留输入并显示可重试错误', async () => {
    globalThis.fetch = (async () =>
      Response.json({ error: '提示词暂时无法读取' }, { status: 500 })) as typeof fetch;
    renderComposer(() => true, { prompts });
    const input = screen.getByRole('combobox', { name: '消息输入框' });
    fireEvent.change(input, { target: { value: '/' } });
    fireEvent.click(screen.getByRole('option', { name: /explain/ }));

    assert.ok(await screen.findByRole('alert'));
    assert.equal((input as HTMLTextAreaElement).value, '/');
    assert.match(screen.getByRole('alert').textContent ?? '', /提示词暂时无法读取.*请重试/);
  });

  it('上下文重置会清空草稿，并忽略旧提示词请求的晚到结果', async () => {
    let resolvePrompt!: (response: Response) => void;
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        resolvePrompt = resolve;
      })) as typeof fetch;
    renderComposer(() => true, { prompts }, true);
    const input = screen.getByRole('combobox', { name: '消息输入框' });
    fireEvent.change(input, { target: { value: '/' } });
    fireEvent.click(screen.getByRole('option', { name: /explain/ }));
    fireEvent.click(screen.getByRole('button', { name: '重置 Composer' }));

    assert.equal((input as HTMLTextAreaElement).value, '');
    assert.equal(input.getAttribute('aria-expanded'), 'false');

    await act(async () => {
      resolvePrompt(
        Response.json({
          name: 'explain',
          path: '.codex/prompts/explain.md',
          content: '旧上下文的提示词内容',
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal((input as HTMLTextAreaElement).value, '');
  });
});

describe('Composer attachments', () => {
  it('批量选择保留成功文件、逐项报告失败，并只在 turn 成功后清理', async () => {
    let success: (() => void) | undefined;
    let sent: PreparedComposerAttachment[] = [];
    const view = renderComposer((_text, attachments, onSuccess) => {
      sent = attachments ?? [];
      success = onSuccess;
      return true;
    });
    const input = view.container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: {
        files: [
          new File(['hello'], 'guide.md', { type: 'text/markdown' }),
          new File(['secret'], '.env', { type: 'text/plain' }),
        ],
      },
    });

    assert.ok(await screen.findByText('guide.md'));
    assert.ok(screen.getByText(/\.env：文件名可能包含敏感信息/));
    fireEvent.change(screen.getByLabelText('消息输入框'), { target: { value: '读取附件' } });
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.dataBase64, 'aGVsbG8=');
    assert.ok(screen.getByText('guide.md'), '流结束前不能丢失附件');
    act(() => success?.());
    await waitFor(() => assert.equal(screen.queryByText('guide.md'), null));
  });

  it('拖放与粘贴文件都有键盘等价的待发送列表和移除操作', async () => {
    const view = renderComposer(() => true);
    const composer = view.container.querySelector('.composer') as HTMLElement;
    fireEvent.drop(composer, {
      dataTransfer: {
        types: ['Files'],
        files: [new File(['drop'], 'drop.txt', { type: 'text/plain' })],
      },
    });
    assert.ok(await screen.findByText('drop.txt'));

    fireEvent.paste(screen.getByLabelText('消息输入框'), {
      clipboardData: {
        files: [new File(['paste'], 'paste.json', { type: 'application/json' })],
      },
    });
    assert.ok(await screen.findByText('paste.json'));
    fireEvent.click(screen.getByRole('button', { name: '移除附件 drop.txt' }));
    assert.equal(screen.queryByText('drop.txt'), null);
    assert.ok(screen.getByRole('button', { name: '添加附件' }));
  });

  it('快速移除后立即发送不会带上刚移除的附件', async () => {
    let sent: PreparedComposerAttachment[] = [];
    const view = renderComposer((_text, attachments) => {
      sent = attachments ?? [];
      return true;
    });
    const input = view.container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: {
        files: [
          new File(['a'], 'a.txt', { type: 'text/plain' }),
          new File(['b'], 'b.txt', { type: 'text/plain' }),
        ],
      },
    });
    assert.ok(await screen.findByText('a.txt'));
    fireEvent.click(screen.getByRole('button', { name: '移除附件 a.txt' }));
    fireEvent.change(screen.getByLabelText('消息输入框'), { target: { value: '立即发送' } });
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
    assert.deepEqual(
      sent.map((item) => item.originalName),
      ['b.txt'],
    );
  });
});

describe('Composer model menu', () => {
  function renderComposerWithModels(models: WorkspaceResponse['models']) {
    return render(
      <WorkspaceProvider
        value={{
          workspace: { ...workspace, models },
          sessionsByAgent: {},
          notify: () => undefined,
          reloadWorkspace: () => {},
        }}
      >
        <Composer
          disabled={false}
          selectedModel={undefined}
          onSelectModel={() => undefined}
          onSend={() => true}
          attachments={[]}
          onAttachmentsChange={() => undefined}
        />
      </WorkspaceProvider>,
    );
  }

  it('available 为空时模型菜单显示空态文案且不崩', () => {
    renderComposerWithModels({ current: {}, available: [] });
    assert.ok(screen.getByLabelText('消息输入框'), 'Composer 应正常渲染');
    fireEvent.click(screen.getByRole('button', { name: '选择模型' }));
    assert.ok(screen.getByText('默认（默认）'));
    assert.ok(screen.getByText('暂无更多可用模型'));
  });

  it('models 为数组等异常形状时 Composer 不白屏', () => {
    // 工作区响应异常（如旧缓存/接口降级返回数组）时也不能让整棵 Composer 抛 TypeError。
    renderComposerWithModels([] as unknown as WorkspaceResponse['models']);
    assert.ok(screen.getByLabelText('消息输入框'));
    assert.ok(screen.getByText('默认'), '模型按钮回退到默认文案');
    fireEvent.click(screen.getByRole('button', { name: '选择模型' }));
    assert.ok(screen.getByText('默认（默认）'));
    assert.ok(screen.getByText('暂无更多可用模型'));
  });

  it('模型菜单进入焦点、支持方向键并由 Escape 立即关闭', () => {
    renderComposerWithModels({
      current: { model: 'gpt-5.6-sol' },
      available: [
        { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
        { id: 'kimi-k2.7', name: 'Kimi K2.7' },
      ],
    });
    const trigger = screen.getByRole('button', { name: '选择模型' });
    fireEvent.click(trigger);
    const menu = screen.getByRole('listbox', { name: '选择模型' });
    const options = within(menu).getAllByRole('option');
    assert.equal(document.activeElement, options[0]);
    assert.ok(options.every((option) => option.tabIndex === -1));

    fireEvent.keyDown(options[0]!, { key: 'ArrowDown' });
    assert.equal(document.activeElement, options[1]);
    fireEvent.keyDown(options[1]!, { key: 'Escape' });

    assert.equal(screen.queryByRole('listbox', { name: '选择模型' }), null);
    assert.equal(document.activeElement, trigger);

    fireEvent.click(trigger);
    assert.ok(screen.getByRole('listbox', { name: '选择模型' }));
    trigger.focus();
    fireEvent.click(trigger);
    assert.equal(screen.queryByRole('listbox', { name: '选择模型' }), null);
  });
});
