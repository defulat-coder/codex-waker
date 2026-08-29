import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

function renderComposer(
  onSend: (
    text: string,
    attachments?: PreparedComposerAttachment[],
    onSuccess?: () => void,
  ) => boolean,
) {
  function Fixture() {
    const [attachments, setAttachments] = useState<PreparedComposerAttachment[]>([]);
    return (
      <Composer
        disabled={false}
        selectedModel={undefined}
        onSelectModel={() => undefined}
        onSend={onSend}
        attachments={attachments}
        onAttachmentsChange={setAttachments}
      />
    );
  }
  return render(
    <WorkspaceProvider
      value={{ workspace, sessionsByAgent: {}, notify: () => undefined, reloadWorkspace: () => {} }}
    >
      <Fixture />
    </WorkspaceProvider>,
  );
}

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
});
