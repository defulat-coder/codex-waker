import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MermaidBlock } from './MermaidBlock.js';

const behavior = {
  parseError: null as Error | null,
  renderError: null as Error | null,
  renderCalls: 0,
  initializeThemes: [] as string[],
};

mock.module('mermaid', {
  exports: {
    default: {
      initialize: (config: { theme?: string }) => {
        behavior.initializeThemes.push(config.theme ?? '');
      },
      parse: async () => {
        if (behavior.parseError) throw behavior.parseError;
        return true;
      },
      render: async () => {
        behavior.renderCalls += 1;
        if (behavior.renderError) throw behavior.renderError;
        return { svg: '<svg class="fake-diagram" viewBox="0 0 100 40"><text>fake</text></svg>' };
      },
    },
  },
});

const CODE = 'graph TD; A-->B';

beforeEach(() => {
  behavior.parseError = null;
  behavior.renderError = null;
  behavior.renderCalls = 0;
  behavior.initializeThemes = [];
  document.documentElement.removeAttribute('data-theme');
});

describe('MermaidBlock', () => {
  it('parse 成功后默认渲染图表，并可切换查看源码', async () => {
    const view = render(<MermaidBlock code={CODE} />);

    await waitFor(() => assert.ok(view.container.querySelector('svg.fake-diagram')));
    assert.equal(behavior.renderCalls, 1);
    assert.ok(screen.getByRole('button', { name: '查看源码' }));

    fireEvent.click(screen.getByRole('button', { name: '查看源码' }));
    assert.equal(view.container.querySelector('svg.fake-diagram'), null);
    assert.ok(view.container.querySelector('.mermaid-source')?.textContent?.includes(CODE));

    fireEvent.click(screen.getByRole('button', { name: '查看图表' }));
    assert.ok(view.container.querySelector('svg.fake-diagram'));
  });

  it('parse 失败时显示源码、错误信息和「渲染图表」重试按钮', async () => {
    behavior.parseError = new Error('Syntax error in text');
    const view = render(<MermaidBlock code={CODE} />);

    const alert = await screen.findByRole('alert');
    assert.ok(alert.textContent?.includes('Mermaid render unavailable.'));
    assert.ok(alert.textContent?.includes('Syntax error in text'));
    assert.ok(view.container.querySelector('.mermaid-source')?.textContent?.includes(CODE));
    assert.equal(view.container.querySelector('svg.fake-diagram'), null);

    behavior.parseError = null;
    fireEvent.click(screen.getByRole('button', { name: '渲染图表' }));
    await waitFor(() => assert.ok(view.container.querySelector('svg.fake-diagram')));
  });

  it('渲染失败时同样回退到源码 + 错误兜底', async () => {
    behavior.renderError = new Error('boom');
    const view = render(<MermaidBlock code={CODE} />);

    const alert = await screen.findByRole('alert');
    assert.ok(alert.textContent?.includes('Mermaid render unavailable.'));
    assert.ok(alert.textContent?.includes('boom'));
    assert.ok(view.container.querySelector('.mermaid-source')?.textContent?.includes(CODE));
  });

  it('缩放控件在 0.5–3 范围内步进并可重置', async () => {
    const view = render(<MermaidBlock code={CODE} />);
    await waitFor(() => assert.ok(view.container.querySelector('svg.fake-diagram')));

    const canvas = () => view.container.querySelector<HTMLDivElement>('.mermaid-canvas')!;
    assert.ok(screen.getByText('100%'));
    assert.equal(canvas().style.width, '100%');

    fireEvent.click(screen.getByRole('button', { name: '放大' }));
    assert.ok(screen.getByText('125%'));
    assert.equal(canvas().style.width, '125%');

    fireEvent.click(screen.getByRole('button', { name: '重置缩放' }));
    assert.ok(screen.getByText('100%'));
    assert.equal(canvas().style.width, '100%');

    const zoomOut = screen.getByRole('button', { name: '缩小' });
    for (let i = 0; i < 5; i += 1) fireEvent.click(zoomOut);
    assert.ok(screen.getByText('50%'));
    assert.equal(canvas().style.width, '50%');
    assert.equal((zoomOut as HTMLButtonElement).disabled, true);
  });

  it('手动 data-theme 优先于系统明暗，属性变化时按新主题重渲染', async () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    const view = render(<MermaidBlock code={CODE} />);
    await waitFor(() => assert.ok(view.container.querySelector('svg.fake-diagram')));
    assert.deepEqual(behavior.initializeThemes, ['dark']);

    // 切到手动浅色：MutationObserver 感知属性变化后按 light 主题重新初始化。
    document.documentElement.setAttribute('data-theme', 'light');
    await waitFor(() => assert.deepEqual(behavior.initializeThemes, ['dark', 'default']));

    // 移除属性（auto）：回退系统明暗。测试环境 matchMedia 为 light，主题值不变，
    // 不应触发多余的重渲染。
    document.documentElement.removeAttribute('data-theme');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(behavior.initializeThemes, ['dark', 'default']);
  });
});
