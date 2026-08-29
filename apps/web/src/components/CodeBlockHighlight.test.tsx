import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';
import { render, screen, waitFor } from '@testing-library/react';
import type { ChatMessage } from '../lib/types.js';
import { ThreadView } from './ThreadView.js';

const behavior = {
  fail: null as Error | null,
  calls: 0,
};

mock.module('shiki', {
  exports: {
    createHighlighter: async () => ({
      loadLanguage: async () => {},
      codeToHtml: (code: string) => {
        behavior.calls += 1;
        if (behavior.fail) throw behavior.fail;
        return `<pre class="shiki"><code><span class="line">${code}</span></code></pre>`;
      },
    }),
  },
});

function message(text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'assistant-1', role: 'assistant', text, ...extra };
}

beforeEach(() => {
  behavior.fail = null;
  behavior.calls = 0;
});

describe('CodeBlock Shiki 高亮', () => {
  it('消息完成后注入高亮 html 替换纯文本 pre', async () => {
    const view = render(<ThreadView messages={[message('```typescript\nconst answer = 42;\n```')]} />);

    await waitFor(() => assert.ok(view.container.querySelector('pre.shiki')));
    assert.ok(view.container.querySelector('pre.shiki')?.textContent?.includes('const answer = 42;'));
    assert.ok(behavior.calls > 0);
    // 语言标签保留。
    assert.ok(screen.getByText('typescript'));
  });

  it('高亮失败时 console.error 并回退为纯文本', async () => {
    behavior.fail = new Error('unknown language');
    const errorMock = mock.method(console, 'error', () => {});
    try {
      const view = render(<ThreadView messages={[message('```text\n纯文本内容\n```')]} />);

      await waitFor(() => assert.ok(errorMock.mock.calls.length > 0));
      assert.equal(view.container.querySelector('pre.shiki'), null);
      const fallback = view.container.querySelector('.code-block > pre');
      assert.ok(fallback?.textContent?.includes('纯文本内容'));
    } finally {
      errorMock.mock.restore();
    }
  });

  it('流式期间保持纯文本，不做高亮', () => {
    const view = render(
      <ThreadView
        messages={[message('```typescript\nconst answer = 42;\n```', { streaming: true })]}
      />,
    );

    assert.equal(view.container.querySelector('pre.shiki'), null);
    assert.ok(
      view.container.querySelector('.code-block > pre')?.textContent?.includes('const answer = 42;'),
    );
    assert.equal(behavior.calls, 0);
  });

  it('流式期间 mermaid 代码块渲染为普通源码块', () => {
    const view = render(
      <ThreadView messages={[message('```mermaid\ngraph TD; A-->B\n```', { streaming: true })]} />,
    );

    assert.equal(view.container.querySelector('.mermaid-block'), null);
    assert.ok(
      view.container.querySelector('.code-block > pre')?.textContent?.includes('graph TD; A-->B'),
    );
    assert.ok(screen.getByText('mermaid'));
  });
});
