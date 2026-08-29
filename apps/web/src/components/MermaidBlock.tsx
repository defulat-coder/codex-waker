import { useEffect, useRef, useState } from 'react';
import { Minus } from '@phosphor-icons/react/dist/icons/Minus';
import { Plus } from '@phosphor-icons/react/dist/icons/Plus';
import { ArrowClockwise } from '@phosphor-icons/react/dist/icons/ArrowClockwise';

type RenderState =
  | { status: 'loading' }
  | { status: 'ready'; svg: string }
  | { status: 'error'; message: string };

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.25;

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

let nextDiagramId = 0;

/** 手动主题（<html data-theme>）优先；auto（无属性）回退系统 prefers-color-scheme。 */
function readDataTheme(): 'light' | 'dark' | null {
  if (typeof document === 'undefined') return null;
  const value = document.documentElement.getAttribute('data-theme');
  return value === 'light' || value === 'dark' ? value : null;
}

function systemPrefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

function resolveDark(): boolean {
  const manual = readDataTheme();
  return manual ? manual === 'dark' : systemPrefersDark();
}

function usePrefersDark(): boolean {
  const [dark, setDark] = useState(resolveDark);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setDark(resolveDark());
    onChange();
    media.addEventListener('change', onChange);
    // 设置页切换主题只改 <html data-theme> 属性，靠 MutationObserver 感知。
    const observer = new MutationObserver(onChange);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => {
      media.removeEventListener('change', onChange);
      observer.disconnect();
    };
  }, []);
  return dark;
}

/**
 * Mermaid 图表块（消息流式结束后才挂载）：
 * parse 成功默认渲染图表并提供「查看源码」切换；parse/渲染失败回退为
 * 源码 + 错误信息 + 「渲染图表」重试按钮。主题跟随界面主题（手动 data-theme 优先，
 * 否则系统明暗；light → default，dark → dark）。
 */
export function MermaidBlock({ code }: { code: string }) {
  const dark = usePrefersDark();
  const [state, setState] = useState<RenderState>({ status: 'loading' });
  const [showSource, setShowSource] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: dark ? 'dark' : 'default',
        });
        await mermaid.parse(code);
        const { svg } = await mermaid.render(`mermaid-diagram-${(nextDiagramId += 1)}`, code);
        if (!cancelled) setState({ status: 'ready', svg });
      } catch (error) {
        if (!cancelled) {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, dark, attempt]);

  // Ctrl+滚轮缩放：React 的 onWheel 是 passive 监听，需原生事件才能 preventDefault。
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || state.status !== 'ready') return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setZoom((value) => clampZoom(value + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)));
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, [state.status]);

  if (state.status === 'error') {
    return (
      <div className="mermaid-block">
        <div className="mermaid-fallback" role="alert">
          <span>Mermaid render unavailable.</span>
          <span className="mermaid-error-message">{state.message}</span>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            渲染图表
          </button>
        </div>
        <pre className="mermaid-source">
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  if (state.status === 'loading') {
    return (
      <pre className="mermaid-source">
        <code>{code}</code>
      </pre>
    );
  }

  return (
    <div className="mermaid-block">
      <div className="mermaid-toolbar">
        <button
          type="button"
          aria-label="缩小"
          disabled={zoom <= MIN_ZOOM}
          onClick={() => setZoom((value) => clampZoom(value - ZOOM_STEP))}
        >
          <Minus size={12} aria-hidden="true" />
        </button>
        <span className="mermaid-zoom-value" aria-live="polite">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          aria-label="重置缩放"
          disabled={zoom === 1}
          onClick={() => setZoom(1)}
        >
          <ArrowClockwise size={12} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="放大"
          disabled={zoom >= MAX_ZOOM}
          onClick={() => setZoom((value) => clampZoom(value + ZOOM_STEP))}
        >
          <Plus size={12} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="mermaid-source-toggle"
          onClick={() => setShowSource((value) => !value)}
        >
          {showSource ? '查看图表' : '查看源码'}
        </button>
      </div>
      {showSource ? (
        <pre className="mermaid-source">
          <code>{code}</code>
        </pre>
      ) : (
        <div className="mermaid-viewport" ref={viewportRef}>
          <div
            className="mermaid-canvas"
            style={{ width: `${zoom * 100}%` }}
            dangerouslySetInnerHTML={{ __html: state.svg }}
          />
        </div>
      )}
    </div>
  );
}
