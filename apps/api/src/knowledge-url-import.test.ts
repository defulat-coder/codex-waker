import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from './app.js';
import type { AppConfig } from './config.js';
import {
  checkImportUrl,
  htmlToMarkdown,
  MAX_KNOWLEDGE_IMPORT_URLS,
} from './lib/knowledge-url-import.js';

const config: AppConfig = {
  PORT: 4310,
  HOST: '127.0.0.1',
  WEB_ORIGIN: 'http://localhost:5173',
  CODEX_AGENT_ENABLED: false,
  LOG_LEVEL: 'error',
};

const PAGE_HTML = `<!doctype html>
<html><head><title>示例页面 &amp; 指南</title><style>.a{color:red}</style></head>
<body><header>站点导航</header><main>
<h1>本地导入指南</h1>
<p>第一段，包含 &lt;代码&gt; 示例。</p>
<script>alert(1)</script>
<ul><li>要点一</li><li>要点二</li></ul>
</main><footer>页脚</footer></body></html>`;

describe('checkImportUrl', () => {
  it('只放行公网 http/https 链接', () => {
    assert.deepEqual(checkImportUrl(' https://example.com/a '), {
      ok: true,
      url: 'https://example.com/a',
    });
    for (const bad of [
      'not-a-url',
      'ftp://example.com/x',
      'file:///etc/passwd',
      'http://localhost/x',
      'http://127.0.0.1:8080/x',
      'https://10.0.0.4/internal',
      'http://192.168.1.1/',
      'http://172.16.0.1/',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/',
    ]) {
      assert.equal(checkImportUrl(bad).ok, false, bad);
    }
  });
});

describe('htmlToMarkdown', () => {
  it('提取 title 与正文，剥离脚本/样式/导航', () => {
    const { title, markdown } = htmlToMarkdown(PAGE_HTML, 'https://example.com/guide');
    assert.equal(title, '示例页面 & 指南');
    assert.match(markdown, /^# 示例页面 & 指南/);
    assert.match(markdown, /# 本地导入指南/);
    assert.match(markdown, /第一段，包含 <代码> 示例。/);
    assert.match(markdown, /- 要点一\n- 要点二/);
    assert.ok(!markdown.includes('alert'));
    assert.ok(!markdown.includes('站点导航'));
    assert.ok(!markdown.includes('页脚'));
  });

  it('没有 title 时退回 URL 末尾路径', () => {
    const { title } = htmlToMarkdown('<p>hello</p>', 'https://example.com/docs/intro');
    assert.equal(title, 'intro');
  });
});

describe('knowledge import-url API', () => {
  const root = mkdtempSync(join(tmpdir(), 'waker-api-import-url-'));
  const app = buildApp(config, { cwd: root });
  const originalFetch = globalThis.fetch;
  let notebookId = '';

  const stubFetch = (handler: (url: string) => Response) => {
    globalThis.fetch = (async (input) => handler(String(input))) as typeof fetch;
  };
  const htmlResponse = (html = PAGE_HTML, status = 200, contentType = 'text/html; charset=utf-8') =>
    new Response(status === 204 ? null : html, {
      status,
      headers: { 'content-type': contentType },
    });

  before(async () => {
    await app.ready();
    const notebook = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/notebooks',
      payload: { title: '链接导入测试库' },
    });
    notebookId = notebook.json().id as string;
    const bound = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/bindings',
      payload: {
        notebookId,
        scope: { kind: 'waker', id: 'codex-assistant' },
        access: 'read_write',
      },
    });
    assert.equal(bound.statusCode, 201);
  });
  after(async () => {
    globalThis.fetch = originalFetch;
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('混合输入逐条返回成功/失败，成功的文档走 web 管道并可检索', async () => {
    stubFetch((url) => (url.includes('ok-page') ? htmlResponse() : htmlResponse('gone', 404)));
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/documents/import-url',
      payload: {
        notebookId,
        urls: [
          'https://example.com/ok-page',
          'not-a-url',
          'ftp://example.com/x',
          'https://example.com/missing',
          'http://127.0.0.1/internal',
        ],
        scope: { kind: 'waker', id: 'codex-assistant' },
      },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.imported, 1);
    assert.equal(body.failed, 4);
    assert.equal(body.results.length, 5);

    const [ok, invalid, wrongProtocol, notFound, privateNet] = body.results;
    assert.equal(ok.ok, true);
    assert.ok(ok.documentId);
    assert.equal(ok.title, '示例页面 & 指南');
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error, '不是合法的链接');
    assert.equal(wrongProtocol.error, '仅支持 http/https 链接');
    assert.equal(notFound.error, '抓取失败（HTTP 404）');
    assert.equal(privateNet.error, '不允许导入内网地址');

    const documents = await app.inject({
      method: 'GET',
      url: `/api/v1/knowledge/documents?notebookId=${notebookId}&scopeKind=waker&scopeId=codex-assistant`,
    });
    const importedDoc = documents
      .json()
      .items.find((item: { id: string }) => item.id === ok.documentId);
    assert.equal(importedDoc.sourceType, 'web');
    assert.equal(importedDoc.uri, 'https://example.com/ok-page');

    const search = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/search',
      payload: {
        scope: { kind: 'waker', id: 'codex-assistant' },
        notebookId,
        query: '要点一 要点二',
        mode: 'keyword',
      },
    });
    assert.equal(search.statusCode, 200);
    assert.ok(search.json().results.length > 0);
    assert.match(search.json().results[0].content, /本地导入指南/);
  });

  it('拒绝不支持的内容类型，且不中断同批其他链接', async () => {
    stubFetch((url) =>
      url.includes('image')
        ? htmlResponse('png', 200, 'image/png')
        : htmlResponse('# 纯文本正文'.replace('# ', ''), 200, 'text/plain'),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/documents/import-url',
      payload: {
        notebookId,
        urls: ['https://example.com/image', 'https://example.com/notes.txt'],
      },
    });
    assert.equal(response.statusCode, 200);
    const [image, text] = response.json().results;
    assert.equal(image.ok, false);
    assert.equal(image.error, '不支持的内容类型 image/png');
    assert.equal(text.ok, true);
    assert.equal(text.title, 'notes.txt');
  });

  it('手动跟随重定向，且重定向到内网会被拦截', async () => {
    stubFetch((url) => {
      if (url.includes('good-redirect'))
        return new Response(null, {
          status: 302,
          headers: { location: '/ok-page' },
        });
      if (url.includes('evil-redirect'))
        return new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest' },
        });
      return htmlResponse();
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/documents/import-url',
      payload: {
        notebookId,
        urls: ['https://example.com/good-redirect', 'https://example.com/evil-redirect'],
      },
    });
    assert.equal(response.statusCode, 200);
    const [good, evil] = response.json().results;
    assert.equal(good.ok, true);
    assert.equal(evil.ok, false);
    assert.equal(evil.error, '不允许导入内网地址');
  });

  it('全部校验失败返回 400，全部抓取失败返回 502', async () => {
    stubFetch(() => htmlResponse());
    const allInvalid = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/documents/import-url',
      payload: { notebookId, urls: ['not-a-url', 'file:///etc/passwd'] },
    });
    assert.equal(allInvalid.statusCode, 400);
    assert.equal(allInvalid.json().imported, 0);

    stubFetch(() => {
      throw new Error('connect ECONNREFUSED');
    });
    const allFailed = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/documents/import-url',
      payload: { notebookId, urls: ['https://example.com/down'] },
    });
    assert.equal(allFailed.statusCode, 502);
    assert.equal(allFailed.json().results[0].error, '无法连接到目标站点');
  });

  it('超出单批上限与空列表被 schema 拒绝', async () => {
    stubFetch(() => htmlResponse());
    const tooMany = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/documents/import-url',
      payload: {
        notebookId,
        urls: Array.from(
          { length: MAX_KNOWLEDGE_IMPORT_URLS + 1 },
          (_, index) => `https://example.com/p${index}`,
        ),
      },
    });
    assert.equal(tooMany.statusCode, 400);
    const empty = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/documents/import-url',
      payload: { notebookId, urls: [] },
    });
    assert.equal(empty.statusCode, 400);
  });
});
