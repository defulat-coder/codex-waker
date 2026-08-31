import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ChatCitationSource } from '@waker/contracts';
import { CitationSources, safeCitationLocation } from './CitationSources.js';

const source: ChatCitationSource = {
  index: 1,
  notebookId: 'local-guide',
  documentId: 'guide',
  documentVersion: 3,
  chunkId: 'guide:3:0',
  title: '本地工作台指南',
  uri: '/Users/private/workspace/docs/local-guide.md',
  startLine: 4,
  endLine: 9,
  excerpt: '<script>不会作为 HTML 执行</script>',
  matchMode: 'hybrid',
  score: 0.827,
  keywordScore: 0.6,
  vectorScore: 0.9,
};

describe('CitationSources', () => {
  it('shows structured provenance while redacting absolute host paths and escaping excerpts', () => {
    const view = render(<CitationSources sources={[source]} />);
    fireEvent.click(screen.getByText('1 个知识来源'));

    assert.ok(screen.getByText('local-guide.md#L4-L9'));
    assert.ok(screen.getByText('混合 · 相关度 0.827 · 文档 v3'));
    assert.ok(screen.getByText('notebook local-guide · document guide · chunk guide:3:0'));
    assert.ok(screen.getByText('<script>不会作为 HTML 执行</script>'));
    assert.equal(view.container.textContent?.includes('/Users/private'), false);
    assert.equal(view.container.querySelector('script'), null);
  });

  it('only recognizes http(s) for remote display and never turns source URIs into links', () => {
    assert.equal(
      safeCitationLocation({
        ...source,
        uri: 'https://docs.example.test/private/guide.md?token=x',
      }),
      'docs.example.test/guide.md',
    );
    assert.equal(safeCitationLocation({ ...source, uri: 'javascript:alert(1)' }), source.title);
    assert.equal(safeCitationLocation({ ...source, uri: 'data:text/html,secret' }), source.title);
    const view = render(<CitationSources sources={[{ ...source, uri: 'javascript:alert(1)' }]} />);
    assert.equal(view.container.querySelector('a'), null);
    assert.equal(view.container.textContent?.includes('javascript:'), false);
  });

  it('opens the current session Outputs panel from the message footer', () => {
    let opened = 0;
    let trigger: HTMLButtonElement | undefined;
    render(
      <CitationSources
        onOpenOutputs={(value) => {
          opened += 1;
          trigger = value;
        }}
      />,
    );
    const button = screen.getByRole('button', { name: '查看附件与结果' });
    fireEvent.click(button);
    assert.equal(opened, 1);
    assert.equal(trigger, button);
  });
});
