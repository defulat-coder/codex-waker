import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ChatMessage } from '../lib/types.js';
import { ThreadView } from './ThreadView.js';

// Shiki 高亮在 CodeBlockHighlight.test.tsx 专项覆盖；这里用透传 mock，
// 避免真实 shiki 异步加载干扰现有断言。
mock.module('shiki', {
  exports: {
    createHighlighter: async () => ({
      loadLanguage: async () => {},
      codeToHtml: (code: string) => `<pre class="shiki"><code>${code}</code></pre>`,
    }),
  },
});

function message(text: string, role: ChatMessage['role'] = 'assistant'): ChatMessage {
  return { id: `${role}-1`, role, text };
}

describe('ThreadView readable messages', () => {
  it('为代码块标注语言，并支持复制和下载', async () => {
    let copied = '';
    let downloaded = '';
    let revoked = '';
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const originalClick = window.HTMLAnchorElement.prototype.click;
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => void (copied = text) },
    });
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: () => 'blob:code',
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: (url: string) => void (revoked = url),
    });
    window.HTMLAnchorElement.prototype.click = function click() {
      downloaded = this.download;
    };

    try {
      render(<ThreadView messages={[message('```typescript\nconst answer = 42;\n```')]} />);
      assert.ok(screen.getByText('typescript'));
      fireEvent.click(screen.getByRole('button', { name: '复制代码' }));
      await waitFor(() => assert.equal(copied, 'const answer = 42;'));
      assert.ok(await screen.findByText('已复制'));

      fireEvent.click(screen.getByRole('button', { name: '下载代码' }));
      assert.equal(downloaded, 'snippet.ts');
      assert.equal(revoked, 'blob:code');
    } finally {
      window.HTMLAnchorElement.prototype.click = originalClick;
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: originalCreateObjectUrl,
      });
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        value: originalRevokeObjectUrl,
      });
      if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('剪贴板不可用时给出可见失败反馈', async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => Promise.reject(new Error('denied')) },
    });
    try {
      render(<ThreadView messages={[message('```text\n不能复制\n```')]} />);
      fireEvent.click(screen.getByRole('button', { name: '复制代码' }));
      assert.ok(await screen.findByText('复制失败'));
    } finally {
      if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('折叠长消息并通过带状态的按钮完整展开', () => {
    const text = Array.from({ length: 30 }, (_, index) => `第 ${index + 1} 行`).join('\n');
    const view = render(<ThreadView messages={[message(text)]} />);
    const content = view.container.querySelector('.readable-content');
    assert.ok(content?.classList.contains('is-folded'));

    const toggle = screen.getByRole('button', { name: '展开完整内容' });
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    fireEvent.click(toggle);
    assert.ok(!content?.classList.contains('is-folded'));
    assert.equal(
      screen.getByRole('button', { name: '收起内容' }).getAttribute('aria-expanded'),
      'true',
    );
  });

  it('折叠区退出可访问与顺序焦点树，同时保留可读摘要', () => {
    const text = `${'摘要内容'.repeat(500)}\n\n[折叠区链接](https://example.com/hidden)`;
    const view = render(<ThreadView messages={[message(text)]} />);
    const content = view.container.querySelector('.readable-content')!;

    assert.equal(content.getAttribute('inert'), '');
    assert.equal(content.getAttribute('aria-hidden'), 'true');
    assert.equal(screen.queryByRole('link', { name: '折叠区链接' }), null);
    const preview = view.container.querySelector('.visually-hidden');
    assert.ok(preview?.textContent?.startsWith('摘要内容'));
    assert.ok(preview?.textContent?.endsWith('…'));

    fireEvent.click(screen.getByRole('button', { name: '展开完整内容' }));
    assert.equal(content.hasAttribute('inert'), false);
    assert.equal(content.hasAttribute('aria-hidden'), false);
    assert.ok(screen.getByRole('link', { name: '折叠区链接' }));
  });

  it('安全打开外链并把危险协议降级为普通文本', () => {
    const view = render(
      <ThreadView
        messages={[
          message(
            '[外部文档](https://example.com/docs)\n\n[危险链接](javascript:alert(1))\n\n<script>alert(1)</script>',
          ),
        ]}
      />,
    );
    const external = screen.getByRole('link', { name: '外部文档' });
    assert.equal(external.getAttribute('target'), '_blank');
    assert.equal(external.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(screen.queryByRole('link', { name: '危险链接' }), null);
    assert.equal(view.container.querySelector('script'), null);
  });

  it('正文引用可展开并定位到对应来源，但不改写 fenced code', () => {
    const view = render(
      <ThreadView
        messages={[
          {
            ...message('正文依据 [1]\n\n```text\n[1]\n```'),
            sources: [
              {
                index: 1,
                notebookId: 'local',
                documentId: 'guide',
                documentVersion: 2,
                chunkId: 'guide:2:0',
                title: '本地指南',
                uri: 'docs/guide.md',
                startLine: 4,
                endLine: 7,
                excerpt: '来源正文',
                matchMode: 'hybrid',
                score: 0.8,
              },
            ],
          },
        ]}
      />,
    );

    const link = screen.getByRole('link', { name: '查看来源 1' });
    const code = view.container.querySelector('.code-block code');
    const target = view.container.querySelector('.citation-source-item') as HTMLElement;
    const details = target.closest('details') as HTMLDetailsElement;
    let scrolled = 0;
    target.scrollIntoView = () => void (scrolled += 1);

    assert.equal(code?.textContent, '[1]\n');
    assert.equal(view.container.querySelector('.code-block a'), null);
    assert.equal(details.open, false);

    fireEvent.click(link);
    assert.equal(details.open, true);
    assert.equal(document.activeElement, target);
    assert.equal(scrolled, 1);
  });

  it('流式消息保持展开，完成后才启用折叠', () => {
    const text = '内容'.repeat(900);
    const view = render(<ThreadView messages={[{ ...message(text), streaming: true }]} />);
    assert.equal(screen.queryByRole('button', { name: '展开完整内容' }), null);
    view.rerender(<ThreadView messages={[message(text)]} />);
    assert.ok(screen.getByRole('button', { name: '展开完整内容' }));
  });

  it('用户向上阅读时不被新 delta 强制拉回底部', () => {
    const view = render(<ThreadView messages={[message('第一段')]} />);
    const scroll = view.container.querySelector('.thread-scroll') as HTMLDivElement;
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1_000 },
    });
    scroll.scrollTop = 120;
    fireEvent.scroll(scroll);

    view.rerender(<ThreadView messages={[message('第一段，继续输出')]} />);
    assert.equal(scroll.scrollTop, 120);

    scroll.scrollTop = 560;
    fireEvent.scroll(scroll);
    view.rerender(<ThreadView messages={[message('第一段，继续输出更多')]} />);
    assert.equal(scroll.scrollTop, 1_000);
  });
});

describe('ThreadView recovery card', () => {
  function renderRecovery(overrides: Partial<ChatMessage>) {
    const onRetry = mock.fn();
    const view = render(
      <ThreadView
        messages={[
          { id: 'a1', role: 'assistant', text: '', error: 'raw provider error', ...overrides },
        ]}
        onRetry={() => onRetry()}
      />,
    );
    return { view, onRetry };
  }

  it('quota 类渲染「额度已用尽」并带重置时间；动作保留为重试', () => {
    const { onRetry } = renderRecovery({
      errorKind: 'quota',
      errorResetAt: '2026-09-01T00:00:00Z',
    });
    assert.ok(screen.getByText('额度已用尽'));
    assert.ok(screen.getByText(/将于 2026-09-01T00:00:00Z 重置。请稍后再试。/));
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    assert.equal(onRetry.mock.callCount(), 1);
  });

  it('quota 类无 resetAt 时用无时间版正文', () => {
    renderRecovery({ errorKind: 'quota' });
    assert.ok(screen.getByText('额度已用尽'));
    assert.ok(screen.getByText(/将于额度周期重置。请稍后再试。/));
  });

  it('auth 类渲染「对话异常中断」与重登提示', () => {
    renderRecovery({ errorKind: 'auth' });
    assert.ok(screen.getByText('对话异常中断'));
    assert.ok(screen.getByText('认证已失效，请重新登录后继续。'));
  });

  it('rate_limit / timeout / network / generic 渲染分类正文', () => {
    const rateLimit = renderRecovery({ errorKind: 'rate_limit' });
    assert.ok(screen.getByText('请求过于频繁或已达到调用上限，请稍后重试。'));
    rateLimit.view.unmount();

    const timeout = renderRecovery({ errorKind: 'timeout' });
    assert.ok(screen.getByText(/与模型服务的连接长时间无响应，已自动中断/));
    timeout.view.unmount();

    const network = renderRecovery({ errorKind: 'network' });
    assert.ok(screen.getByText('无法连接到模型服务，请检查网络后重试。'));
    network.view.unmount();

    renderRecovery({ errorKind: 'generic' });
    assert.ok(screen.getByText(/对话因后台异常中断，请稍后重试/));
  });

  it('startup 类渲染「启动失败」现象/原因/建议三段', () => {
    renderRecovery({ errorKind: 'startup', error: 'stream unavailable' });
    assert.ok(screen.getByText('启动失败'));
    assert.ok(screen.getByText(/现象：stream unavailable/));
    assert.ok(screen.getByText(/原因：模型服务未能正常启动。/));
    assert.ok(screen.getByText(/建议：请稍后重试/));
  });

  it('无 kind 的历史错误保持「本轮回复失败」+ 原文', () => {
    const { view } = renderRecovery({});
    // message-error-card 与恢复卡都会展示原文，断言收敛到恢复卡内部。
    const card = view.container.querySelector('.recovery-card') as HTMLElement;
    assert.ok(card.textContent?.includes('本轮回复失败'));
    assert.equal(
      card.querySelector('.recovery-card-desc')?.textContent,
      'raw provider error',
    );
  });
});
