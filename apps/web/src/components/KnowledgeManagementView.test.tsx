import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { KnowledgeBinding, KnowledgeNotebook } from '@waker/contracts';
import { KnowledgeManagementView } from './KnowledgeManagementView.js';
import {
  MAX_KNOWLEDGE_FILE_BYTES,
  MAX_KNOWLEDGE_IMPORT_FILES,
  prepareKnowledgeFiles,
} from './knowledgeFileImport.js';
import { MAX_KNOWLEDGE_IMPORT_URLS, parseKnowledgeUrls } from './knowledgeUrlImport.js';

const originalFetch = globalThis.fetch;

const NOTEBOOK: KnowledgeNotebook = {
  id: 'handbook',
  title: '产品手册',
  description: '本地产品资料',
  documentCount: 1,
  createdAt: '2026-08-28T01:00:00.000Z',
  updatedAt: '2026-08-28T01:00:00.000Z',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type FetchCall = { url: string; method: string; body?: Record<string, unknown> };

function stubKnowledgeFetch(initialBinding?: KnowledgeBinding): FetchCall[] {
  const calls: FetchCall[] = [];
  let binding = initialBinding;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    calls.push({ url, method, body });

    if (url.endsWith('/api/v1/knowledge/notebooks') && method === 'GET')
      return jsonResponse({ items: [NOTEBOOK] });
    if (url.endsWith('/api/v1/knowledge/bindings') && method === 'GET')
      return jsonResponse({ items: binding ? [binding] : [] });
    if (url.endsWith('/api/v1/knowledge/bindings') && method === 'POST') {
      binding = {
        ...(body as Omit<KnowledgeBinding, 'createdAt'>),
        createdAt: '2026-08-28T01:00:00.000Z',
      };
      return jsonResponse(binding, 201);
    }
    if (url.includes('/api/v1/knowledge/bindings/') && method === 'DELETE') {
      binding = undefined;
      return jsonResponse(null, 204);
    }
    if (url.includes('/api/v1/knowledge/documents') && method === 'GET')
      return jsonResponse({
        items: [
          {
            id: 'intro',
            notebookId: NOTEBOOK.id,
            title: '快速开始',
            mimeType: 'text/markdown',
            sourceType: 'markdown',
            content: '# 开始',
            version: 1,
            createdAt: NOTEBOOK.createdAt,
            updatedAt: NOTEBOOK.updatedAt,
          },
        ],
      });
    if (url.includes('/api/v1/knowledge/audits') && method === 'GET')
      return jsonResponse({
        items: [
          {
            id: 1,
            notebookId: NOTEBOOK.id,
            action: 'document.created',
            createdAt: NOTEBOOK.createdAt,
          },
        ],
      });
    if (url.endsWith('/api/v1/knowledge/search') && method === 'POST')
      return jsonResponse({
        results: [],
        modeUsed: body?.mode,
        degraded: false,
        total: 0,
        truncated: false,
      });
    if (url.endsWith('/api/v1/knowledge/documents/import-url') && method === 'POST') {
      const urls = (body?.urls as string[]) ?? [];
      const results = urls.map((item) =>
        item.includes('fail')
          ? { url: item, ok: false, error: '抓取失败（HTTP 404）' }
          : { url: item, ok: true, documentId: `doc-${item}`, title: '页面标题' },
      );
      const imported = results.filter((result) => result.ok).length;
      return jsonResponse(
        { results, imported, failed: results.length - imported },
        imported === results.length ? 200 : imported > 0 ? 200 : 502,
      );
    }
    if (url.endsWith('/api/v1/knowledge/documents') && method === 'POST')
      return jsonResponse({ id: 'imported', ...body }, 201);
    if (url.endsWith('/api/v1/knowledge/rebuild') && method === 'POST')
      return jsonResponse({ indexedChunks: 1 });
    return jsonResponse({});
  }) as typeof fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('prepareKnowledgeFiles', () => {
  it('只接受大小合规的 Markdown/TXT，并逐个报告坏文件', async () => {
    const file = (name: string, content: string, size = content.length) =>
      ({ name, size, text: async () => content }) as File;
    const result = await prepareKnowledgeFiles([
      file('guide.MD', '# Guide'),
      file('notes.txt', 'plain text'),
      file('empty.md', '   '),
      file('binary.txt', 'bad\0data'),
      file('image.png', 'not allowed'),
      file('large.md', 'large', MAX_KNOWLEDGE_FILE_BYTES + 1),
    ]);

    assert.deepEqual(
      result.accepted.map((item) => [item.fileName, item.sourceType, item.mimeType]),
      [
        ['guide.MD', 'markdown', 'text/markdown'],
        ['notes.txt', 'text', 'text/plain'],
      ],
    );
    assert.deepEqual(
      result.rejected.map((item) => item.fileName),
      ['empty.md', 'binary.txt', 'image.png', 'large.md'],
    );
  });

  it('限制单批文件数量，避免无界并发读取', async () => {
    const files = Array.from(
      { length: MAX_KNOWLEDGE_IMPORT_FILES + 2 },
      (_, index) => ({ name: `${index}.md`, size: 1, text: async () => 'x' }) as File,
    );
    const result = await prepareKnowledgeFiles(files);
    assert.equal(result.accepted.length, MAX_KNOWLEDGE_IMPORT_FILES);
    assert.equal(result.rejected.length, 2);
  });
});

describe('parseKnowledgeUrls', () => {
  it('按空格/换行拆分，去重并忽略非 http(s) 片段', () => {
    assert.deepEqual(
      parseKnowledgeUrls(
        'https://a.com/1 https://a.com/1\nhttp://b.com/2\tnot-a-url\nftp://c.com/x  https://a.com/1#frag',
      ),
      ['https://a.com/1', 'http://b.com/2', 'https://a.com/1#frag'],
    );
    assert.deepEqual(parseKnowledgeUrls('   \n  '), []);
  });
});

describe('KnowledgeManagementView', () => {
  it('网络中断时本地化错误并可重试恢复知识库目录', async () => {
    stubKnowledgeFetch();
    const healthyFetch = globalThis.fetch;
    let shouldFail = true;
    globalThis.fetch = (async (input, init) => {
      if (String(input).endsWith('/api/v1/knowledge/notebooks') && shouldFail) {
        shouldFail = false;
        throw new TypeError('Failed to fetch');
      }
      return healthyFetch(input, init);
    }) as typeof fetch;

    render(<KnowledgeManagementView wakerId="waker-one" notify={() => undefined} />);
    const alert = await screen.findByRole('alert');
    assert.match(alert.textContent ?? '', /知识库暂时无法读取/);
    assert.doesNotMatch(alert.textContent ?? '', /Failed to fetch/);
    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    assert.ok(await screen.findByRole('button', { name: /产品手册/ }));
  });

  it('只读绑定显示真实状态，并禁用写操作但保留审计查看', async () => {
    stubKnowledgeFetch({
      notebookId: NOTEBOOK.id,
      scope: { kind: 'waker', id: 'waker-one' },
      access: 'read_only',
      createdAt: NOTEBOOK.createdAt,
    });
    render(<KnowledgeManagementView wakerId="waker-one" notify={() => undefined} />);

    assert.ok(await screen.findByText('快速开始'));
    assert.ok(screen.getAllByText('只读').length >= 1);
    assert.equal(
      screen.getByRole('button', { name: /产品手册/ }).getAttribute('aria-pressed'),
      'true',
    );
    assert.equal(
      (screen.getByRole('button', { name: '导入 Markdown/TXT' }) as HTMLButtonElement).disabled,
      true,
    );
    assert.equal(
      (screen.getByRole('button', { name: '新建文档' }) as HTMLButtonElement).disabled,
      true,
    );
    fireEvent.click(screen.getByText(/审计记录/));
    assert.ok(screen.getByText('创建文档'));
  });

  it('可选择已有知识库并连接到当前 Waker', async () => {
    const calls = stubKnowledgeFetch();
    render(<KnowledgeManagementView wakerId="waker-one" notify={() => undefined} />);

    const connect = await screen.findByRole('button', { name: '连接到当前 Waker' });
    fireEvent.click(connect);
    await waitFor(() =>
      assert.ok(calls.some((call) => call.method === 'POST' && call.url.endsWith('/bindings'))),
    );
    assert.ok(await screen.findByText('已连接'));
    assert.ok(await screen.findByText('快速开始'));
  });

  it('将混合、关键词与向量三种检索模式原样提交给 API', async () => {
    const calls = stubKnowledgeFetch({
      notebookId: NOTEBOOK.id,
      scope: { kind: 'waker', id: 'waker-one' },
      access: 'read_write',
      createdAt: NOTEBOOK.createdAt,
    });
    render(<KnowledgeManagementView wakerId="waker-one" notify={() => undefined} />);
    const input = await screen.findByRole('textbox', { name: '搜索知识库' });
    const mode = await screen.findByRole('combobox', { name: '检索方式' });

    for (const value of ['hybrid', 'keyword', 'vector']) {
      fireEvent.change(input, { target: { value: '本地' } });
      fireEvent.change(mode, { target: { value } });
      fireEvent.click(screen.getByRole('button', { name: '搜索' }));
      await waitFor(() =>
        assert.ok(
          calls.some(
            (call) =>
              call.method === 'POST' &&
              call.url.endsWith('/knowledge/search') &&
              call.body?.mode === value,
          ),
        ),
      );
    }
  });

  it('知识检索网络失败时保留查询并显示本地化错误', async () => {
    stubKnowledgeFetch({
      notebookId: NOTEBOOK.id,
      scope: { kind: 'waker', id: 'waker-one' },
      access: 'read_write',
      createdAt: NOTEBOOK.createdAt,
    });
    const healthyFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      if (String(input).endsWith('/api/v1/knowledge/search'))
        throw new TypeError('Failed to fetch');
      return healthyFetch(input, init);
    }) as typeof fetch;
    const notices: Array<{ text: string; tone?: string }> = [];
    render(
      <KnowledgeManagementView
        wakerId="waker-one"
        notify={(text, tone) => notices.push({ text, tone })}
      />,
    );
    const input = await screen.findByRole('textbox', { name: '搜索知识库' });
    fireEvent.change(input, { target: { value: '本地架构' } });
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));

    await waitFor(() =>
      assert.deepEqual(notices.at(-1), { text: '知识检索暂时无法运行', tone: 'error' }),
    );
    assert.equal((input as HTMLInputElement).value, '本地架构');
    assert.equal(notices.some((notice) => notice.text.includes('Failed to fetch')), false);
  });

  it('批量导入时保留成功文件，并在页面报告不支持的文件', async () => {
    const calls = stubKnowledgeFetch({
      notebookId: NOTEBOOK.id,
      scope: { kind: 'waker', id: 'waker-one' },
      access: 'read_write',
      createdAt: NOTEBOOK.createdAt,
    });
    render(<KnowledgeManagementView wakerId="waker-one" notify={() => undefined} />);
    await screen.findByText('快速开始');
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const good = { name: 'local.md', size: 7, text: async () => '# Local' } as File;
    const bad = { name: 'secret.pdf', size: 7, text: async () => 'blocked' } as File;
    fireEvent.change(input, { target: { files: [good, bad] } });

    assert.ok(await screen.findByText('已导入 1 个，失败 1 个'));
    assert.ok(screen.getByText('secret.pdf：仅支持 .md、.markdown 和 .txt'));
    assert.ok(
      calls.some(
        (call) =>
          call.method === 'POST' &&
          call.url.endsWith('/knowledge/documents') &&
          call.body?.uri === 'local.md',
      ),
    );
  });

  it('只读连接读取失败时同时显示权限和检查状态，并提供重试', async () => {
    const binding: KnowledgeBinding = {
      notebookId: NOTEBOOK.id,
      scope: { kind: 'waker', id: 'waker-one' },
      access: 'read_only',
      createdAt: NOTEBOOK.createdAt,
    };
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith('/api/v1/knowledge/notebooks')) return jsonResponse({ items: [NOTEBOOK] });
      if (url.endsWith('/api/v1/knowledge/bindings')) return jsonResponse({ items: [binding] });
      if (url.includes('/api/v1/knowledge/documents'))
        return jsonResponse({ error: '文档读取失败' }, 500);
      if (url.includes('/api/v1/knowledge/audits')) return jsonResponse({ items: [] });
      return jsonResponse({});
    }) as typeof fetch;

    render(<KnowledgeManagementView wakerId="waker-one" notify={() => undefined} />);
    assert.ok(await screen.findByText('需要检查'));
    assert.ok(screen.getAllByText('只读').length >= 1);
    assert.ok(screen.getByRole('alert'));
    assert.ok(screen.getByRole('button', { name: '重新读取' }));
  });

  it('切换知识库时立即隐藏旧文档，直到新库读取完成', async () => {
    const second = { ...NOTEBOOK, id: 'second', title: '第二知识库' };
    const bindings: KnowledgeBinding[] = [NOTEBOOK, second].map((notebook) => ({
      notebookId: notebook.id,
      scope: { kind: 'waker', id: 'waker-one' },
      access: 'read_write',
      createdAt: NOTEBOOK.createdAt,
    }));
    let resolveSecond: ((response: Response) => void) | undefined;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith('/api/v1/knowledge/notebooks'))
        return jsonResponse({ items: [NOTEBOOK, second] });
      if (url.endsWith('/api/v1/knowledge/bindings')) return jsonResponse({ items: bindings });
      if (url.includes('/api/v1/knowledge/audits')) return jsonResponse({ items: [] });
      if (url.includes('/api/v1/knowledge/documents') && url.includes('notebookId=second'))
        return new Promise<Response>((resolve) => {
          resolveSecond = resolve;
        });
      if (url.includes('/api/v1/knowledge/documents'))
        return jsonResponse({
          items: [
            {
              id: 'first-doc',
              notebookId: NOTEBOOK.id,
              title: '第一库文档',
              mimeType: 'text/markdown',
              sourceType: 'markdown',
              content: '# first',
              version: 1,
              createdAt: NOTEBOOK.createdAt,
              updatedAt: NOTEBOOK.updatedAt,
            },
          ],
        });
      return jsonResponse({});
    }) as typeof fetch;

    render(<KnowledgeManagementView wakerId="waker-one" notify={() => undefined} />);
    assert.ok(await screen.findByText('第一库文档'));
    fireEvent.click(screen.getByRole('button', { name: /第二知识库/ }));
    assert.ok(await screen.findByLabelText('正在读取知识库内容'));
    assert.equal(screen.queryByText('第一库文档'), null);
    resolveSecond?.(
      jsonResponse({
        items: [
          {
            id: 'second-doc',
            notebookId: second.id,
            title: '第二库文档',
            mimeType: 'text/plain',
            sourceType: 'text',
            content: 'second',
            version: 1,
            createdAt: NOTEBOOK.createdAt,
            updatedAt: NOTEBOOK.updatedAt,
          },
        ],
      }),
    );
    assert.ok(await screen.findByText('第二库文档'));
  });

  it('链接导入实时统计有效链接，提交后逐条反馈成功/失败', async () => {
    const calls = stubKnowledgeFetch({
      notebookId: NOTEBOOK.id,
      scope: { kind: 'waker', id: 'waker-one' },
      access: 'read_write',
      createdAt: NOTEBOOK.createdAt,
    });
    const notices: Array<{ text: string; tone?: string }> = [];
    render(
      <KnowledgeManagementView
        wakerId="waker-one"
        notify={(text, tone) => notices.push({ text, tone })}
      />,
    );
    await screen.findByText('快速开始');

    const input = screen.getByRole('textbox', { name: '网页链接' });
    fireEvent.change(input, {
      target: { value: 'https://example.com/a https://example.com/fail-page\n垃圾文字' },
    });
    assert.ok(screen.getByText(`2/${MAX_KNOWLEDGE_IMPORT_URLS} 个有效链接`));
    fireEvent.click(screen.getByRole('button', { name: '导入链接' }));

    assert.ok(await screen.findByText('已导入 1 个，失败 1 个'));
    assert.ok(screen.getByText('https://example.com/fail-page：抓取失败（HTTP 404）'));
    assert.ok(
      notices.some((notice) => notice.text === '已导入 1 个，1 个失败' && notice.tone === 'error'),
    );
    const importCall = calls.find((call) => call.url.endsWith('/documents/import-url'));
    assert.deepEqual(importCall?.body?.urls, [
      'https://example.com/a',
      'https://example.com/fail-page',
    ]);
    // 有成功导入后清空输入框
    assert.equal((input as HTMLTextAreaElement).value, '');
  });

  it('超过链接上限时提示并禁用导入按钮', async () => {
    stubKnowledgeFetch({
      notebookId: NOTEBOOK.id,
      scope: { kind: 'waker', id: 'waker-one' },
      access: 'read_write',
      createdAt: NOTEBOOK.createdAt,
    });
    render(<KnowledgeManagementView wakerId="waker-one" notify={() => undefined} />);
    await screen.findByText('快速开始');

    const urls = Array.from(
      { length: MAX_KNOWLEDGE_IMPORT_URLS + 1 },
      (_, index) => `https://example.com/p${index}`,
    ).join(' ');
    fireEvent.change(screen.getByRole('textbox', { name: '网页链接' }), {
      target: { value: urls },
    });
    assert.ok(screen.getByText(`最多允许 ${MAX_KNOWLEDGE_IMPORT_URLS} 个链接`));
    assert.equal(
      (screen.getByRole('button', { name: '导入链接' }) as HTMLButtonElement).disabled,
      true,
    );
  });

  it('删除知识文档前显示影响确认对话框', async () => {
    const calls = stubKnowledgeFetch({
      notebookId: NOTEBOOK.id,
      scope: { kind: 'waker', id: 'waker-one' },
      access: 'read_write',
      createdAt: NOTEBOOK.createdAt,
    });
    render(<KnowledgeManagementView wakerId="waker-one" notify={() => undefined} />);
    await screen.findByText('快速开始');
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    assert.ok(screen.getByRole('dialog', { name: '删除知识文档：快速开始' }));
    assert.equal(
      calls.some((call) => call.method === 'DELETE'),
      false,
    );
    fireEvent.click(screen.getByRole('button', { name: '确认删除文档' }));
    await waitFor(() => assert.ok(calls.some((call) => call.method === 'DELETE')));
  });
});
