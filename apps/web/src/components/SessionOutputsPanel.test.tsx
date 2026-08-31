import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SessionAttachment, SessionOutputsResponse } from '@waker/contracts';
import { selectSessionUploadBatch } from '../lib/sessionUpload.js';
import { SessionOutputsPanel } from './SessionOutputsPanel.js';
import type { Notify } from './Toasts.js';

const originalFetch = globalThis.fetch;

const attachment = (index: number, input: Partial<SessionAttachment> = {}): SessionAttachment => ({
  id: `attachment-${index}`,
  sessionId: 'session-one',
  originalName: `file-${index}.bin`,
  mimeType: 'application/octet-stream',
  size: 100,
  sha256: `sha-${index}`,
  status: 'ready',
  createdAt: '2026-08-28T01:00:00.000Z',
  ...input,
});

function outputs(attachments: SessionAttachment[] = []): SessionOutputsResponse {
  return { attachments, artifacts: [], fileChanges: [] };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderPanel(
  input: {
    selectedIds?: string[];
    onToggle?: (id: string) => void;
    notify?: Notify;
  } = {},
) {
  return render(
    <SessionOutputsPanel
      agentId="agent-one"
      sessionId="session-one"
      selectedIds={input.selectedIds ?? []}
      onToggle={input.onToggle ?? (() => undefined)}
      onClose={() => undefined}
      notify={input.notify ?? (() => undefined)}
    />,
  );
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('SessionOutputsPanel', () => {
  it('网络中断时显示可行动的本地化提示并可重试恢复', async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError('Failed to fetch');
      return jsonResponse(outputs());
    }) as typeof fetch;

    renderPanel();
    const alert = await screen.findByRole('alert');
    assert.match(alert.textContent ?? '', /附件与结果暂时无法读取/);
    assert.doesNotMatch(alert.textContent ?? '', /Failed to fetch/);
    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    assert.ok(await screen.findByText('尚未上传附件'));
    assert.equal(attempts, 2);
  });

  it('限制单批文件数量并保留上限内文件', () => {
    const files = Array.from(
      { length: 22 },
      (_, index) => new File(['x'], `${index}.txt`, { type: 'text/plain' }),
    );
    const batch = selectSessionUploadBatch(files);
    assert.equal(batch.accepted.length, 20);
    assert.equal(batch.rejected.length, 2);
    assert.match(batch.rejected[0]!.message, /最多 20/);
    const oversized = selectSessionUploadBatch([
      { name: 'large.bin', size: 101 * 1024 * 1024 } as File,
    ]);
    assert.equal(oversized.accepted.length, 0);
    assert.match(oversized.rejected[0]!.message, /100 MB/);
  });

  it('批量上传通过 allSettled 保留成功项并逐文件报告失败', async () => {
    const posts: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes('/outputs?')) return jsonResponse(outputs());
      if (init?.method === 'POST' && url.includes('/attachments')) {
        const body = JSON.parse(String(init.body)) as { originalName: string };
        posts.push(body.originalName);
        return body.originalName === 'bad.txt'
          ? jsonResponse({ error: '文件校验失败' }, 400)
          : jsonResponse(attachment(1, { originalName: body.originalName }), 201);
      }
      return jsonResponse({ error: 'unexpected request' }, 500);
    }) as typeof fetch;

    const notices: Array<{ text: string; tone?: string }> = [];
    renderPanel({ notify: (text, tone) => notices.push({ text, tone }) });
    await screen.findByText('尚未上传附件');
    fireEvent.change(screen.getByLabelText('上传附件'), {
      target: {
        files: [
          new File(['ok'], 'good.txt', { type: 'text/plain' }),
          new File(['bad'], 'bad.txt', { type: 'text/plain' }),
        ],
      },
    });

    assert.ok(await screen.findByRole('list', { name: '附件上传结果' }));
    assert.ok(screen.getByText('good.txt'));
    assert.ok(screen.getByText('bad.txt'));
    assert.ok(screen.getByText('已上传'));
    assert.ok(screen.getByText('文件校验失败'));
    assert.deepEqual(posts.sort(), ['bad.txt', 'good.txt']);
    assert.deepEqual(notices, [{ text: '1 个成功，1 个失败', tone: 'error' }]);
  });

  it('安全截断文本预览，展示结果路径与文件变更详情，并用 Escape 恢复焦点', async () => {
    const textAttachment = attachment(1, {
      originalName: 'notes.md',
      mimeType: 'text/markdown',
      size: 70 * 1024,
    });
    const result: SessionOutputsResponse = {
      attachments: [textAttachment],
      artifacts: [
        {
          id: 'artifact-one',
          sessionId: 'session-one',
          title: '本地报告',
          kind: 'attachment',
          path: 'session-one/report.md',
          contentPreview: '报告摘要',
          createdAt: '2026-08-28T01:00:00.000Z',
        },
      ],
      fileChanges: [
        {
          id: 'change-one',
          sessionId: 'session-one',
          path: 'src/app.ts',
          kind: 'update',
          summary: '更新会话输出',
          createdAt: '2026-08-28T01:00:00.000Z',
        },
      ],
    };
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes('/outputs?')) return jsonResponse(result);
      if (url.includes('/attachments/'))
        return new Response(`<script>not markup</script>${'x'.repeat(70 * 1024)}`, {
          headers: { 'content-type': 'text/markdown' },
        });
      return jsonResponse({ error: 'unexpected request' }, 500);
    }) as typeof fetch;

    const view = renderPanel();
    assert.ok(await screen.findByText('报告摘要'));
    assert.ok(screen.getByText('session-one/report.md'));
    assert.ok(screen.getByText('更新会话输出'));

    const trigger = screen.getByRole('button', { name: '预览' });
    trigger.focus();
    fireEvent.click(trigger);
    assert.ok(await screen.findByText('预览已在 64 KB 处截断，下载可查看完整内容。'));
    assert.equal(document.activeElement, screen.getByRole('button', { name: '关闭预览' }));
    assert.equal(view.container.querySelector('.attachment-preview-content script'), null);
    assert.match(screen.getByRole('dialog', { name: 'notes.md' }).textContent ?? '', /not markup/);
    fireEvent.keyDown(document, { key: 'Escape' });
    assert.equal(screen.queryByRole('dialog'), null);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    assert.equal(document.activeElement, trigger);
  });

  it('图片附件提供缩略图，并用可回收的 object URL 打开大图预览', async () => {
    const image = attachment(1, {
      originalName: 'screen.png',
      mimeType: 'image/png',
    });
    globalThis.fetch = (async (input) =>
      String(input).includes('/outputs?')
        ? jsonResponse(outputs([image]))
        : new Response('image bytes', {
            headers: { 'content-type': 'image/png' },
          })) as typeof fetch;
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const revoked: string[] = [];
    URL.createObjectURL = () => 'blob:attachment-preview';
    URL.revokeObjectURL = (url) => revoked.push(url);

    try {
      renderPanel();
      fireEvent.click(await screen.findByRole('button', { name: '预览 screen.png' }));
      const preview = await screen.findByRole('img', { name: 'screen.png 预览' });
      assert.equal(preview.getAttribute('src'), 'blob:attachment-preview');
      fireEvent.click(screen.getByRole('button', { name: '关闭预览' }));
      assert.deepEqual(revoked, ['blob:attachment-preview']);
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });

  it('预览失败后可原地重试并保持安全焦点', async () => {
    const target = attachment(1, { originalName: 'retry.txt', mimeType: 'text/plain' });
    let attempts = 0;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes('/outputs?')) return jsonResponse(outputs([target]));
      if (url.includes('/attachments/')) {
        attempts += 1;
        return attempts === 1
          ? jsonResponse({ error: '附件读取验证失败' }, 500)
          : new Response('恢复后的正文', { headers: { 'content-type': 'text/plain' } });
      }
      return jsonResponse({ error: 'unexpected request' }, 500);
    }) as typeof fetch;

    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: '预览' }));
    assert.ok(await screen.findByRole('alert'));
    fireEvent.click(screen.getByRole('button', { name: '重新读取' }));

    assert.equal(document.activeElement, screen.getByRole('button', { name: '关闭预览' }));
    assert.ok(await screen.findByText('恢复后的正文'));
    assert.equal(attempts, 2);
  });

  it('确认后删除附件并清除其下次对话选择', async () => {
    const target = attachment(1, { originalName: 'remove.txt', mimeType: 'text/plain' });
    let current = outputs([target]);
    const methods: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      methods.push(method);
      if (url.includes('/outputs?')) return jsonResponse(current);
      if (method === 'DELETE' && url.includes('/attachments/')) {
        current = outputs();
        return jsonResponse(null, 204);
      }
      return jsonResponse({ error: 'unexpected request' }, 500);
    }) as typeof fetch;

    const toggled: string[] = [];
    const notices: string[] = [];
    renderPanel({
      selectedIds: [target.id],
      onToggle: (id) => toggled.push(id),
      notify: (text) => notices.push(text),
    });
    await screen.findByText('remove.txt');
    fireEvent.click(screen.getByRole('button', { name: '删除 remove.txt' }));
    assert.ok(screen.getByRole('dialog', { name: '删除附件' }));
    assert.match(screen.getByRole('dialog').textContent ?? '', /不能再通过此附件下载原文件/);
    fireEvent.click(screen.getByRole('button', { name: '永久删除' }));

    assert.ok(await screen.findByText('尚未上传附件'));
    assert.ok(methods.includes('DELETE'));
    assert.deepEqual(toggled, [target.id]);
    assert.deepEqual(notices, ['附件已删除']);
  });

  it('批量选择最多八个附件，并可一次全不选', async () => {
    const items = Array.from({ length: 10 }, (_, index) => attachment(index));
    globalThis.fetch = (async (input) =>
      String(input).includes('/outputs?')
        ? jsonResponse(outputs(items))
        : jsonResponse({ error: 'unexpected request' }, 500)) as typeof fetch;

    function SelectionFixture() {
      const [selected, setSelected] = useState<string[]>([]);
      return (
        <SessionOutputsPanel
          agentId="agent-one"
          sessionId="session-one"
          selectedIds={selected}
          onToggle={(id) =>
            setSelected((current) =>
              current.includes(id)
                ? current.filter((item) => item !== id)
                : current.length < 8
                  ? [...current, id]
                  : current,
            )
          }
          onClose={() => undefined}
          notify={() => undefined}
        />
      );
    }

    render(<SelectionFixture />);
    fireEvent.click(await screen.findByRole('button', { name: '全选（最多 8 个）' }));
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    assert.ok(checkboxes.every((item) => item.closest('label')?.className === 'attachment-select'));
    await waitFor(() => assert.equal(checkboxes.filter((item) => item.checked).length, 8));
    assert.equal(checkboxes.filter((item) => item.disabled).length, 2);
    fireEvent.click(screen.getByRole('button', { name: '全不选' }));
    await waitFor(() => assert.equal(checkboxes.filter((item) => item.checked).length, 0));
  });
});
