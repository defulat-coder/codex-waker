import {
  isValidElement,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react';
import { motion } from 'motion/react';
import { CaretRight } from '@phosphor-icons/react/dist/icons/CaretRight';
import { WarningCircle } from '@phosphor-icons/react/dist/icons/WarningCircle';
import { Check } from '@phosphor-icons/react/dist/icons/Check';
import { Copy } from '@phosphor-icons/react/dist/icons/Copy';
import { DownloadSimple } from '@phosphor-icons/react/dist/icons/DownloadSimple';
import { Robot } from '@phosphor-icons/react/dist/icons/Robot';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatMessage } from '../lib/types.js';
import { cx } from '../lib/cx.js';
import { highlightCode } from '../lib/highlight.js';
import { MessageStreamingContext } from '../lib/messageStreaming.js';
import { MOTION_EASE } from '../lib/motion.js';
import { ProcessCards } from './ProcessCards.js';
import { citationSourceId, CitationSources } from './CitationSources.js';
import { MermaidBlock } from './MermaidBlock.js';
import { MotionPulseDot } from './MotionFeedback.js';

const LONG_MESSAGE_CHARACTERS = 1_600;
const LONG_MESSAGE_LINES = 24;

function isLongMessage(text: string): boolean {
  return text.length > LONG_MESSAGE_CHARACTERS || text.split('\n').length > LONG_MESSAGE_LINES;
}

function ReadableContent({
  text,
  streaming,
  className,
  children,
}: {
  text: string;
  streaming?: boolean;
  className: string;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const foldable = !streaming && isLongMessage(text);
  const folded = foldable && !expanded;
  const accessiblePreview = `${text.slice(0, 320).trimEnd()}${text.length > 320 ? '…' : ''}`;

  return (
    <>
      <div
        id={contentId}
        className={cx(className, 'readable-content', folded && 'is-folded')}
        aria-hidden={folded || undefined}
        inert={folded || undefined}
      >
        {children}
      </div>
      {folded && <p className="visually-hidden">{accessiblePreview}</p>}
      {foldable && (
        <button
          type="button"
          className="message-fold-button"
          aria-controls={contentId}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? '收起内容' : '展开完整内容'}
        </button>
      )}
    </>
  );
}

function plainText(value: ReactNode): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(plainText).join('');
  return '';
}

type MarkdownAstNode = {
  type: string;
  value?: string;
  children?: MarkdownAstNode[];
  url?: string;
  data?: { hProperties?: Record<string, unknown> };
};

const CITATION_TEXT_PATTERN = /\[(\d+)\]/g;
const CITATION_SKIP_NODES = new Set(['code', 'inlineCode', 'link', 'linkReference']);

/** Turns only ordinary Markdown text markers into links for sources attached to this message. */
function citationRemarkPlugin(indexes: ReadonlySet<number>, scope: string) {
  return () => (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode) => {
      if (!node.children || CITATION_SKIP_NODES.has(node.type)) return;
      const children: MarkdownAstNode[] = [];
      for (const child of node.children) {
        if (child.type !== 'text' || !child.value) {
          visit(child);
          children.push(child);
          continue;
        }

        let cursor = 0;
        let changed = false;
        CITATION_TEXT_PATTERN.lastIndex = 0;
        for (const match of child.value.matchAll(CITATION_TEXT_PATTERN)) {
          const index = Number(match[1]);
          if (!indexes.has(index)) continue;
          const start = match.index;
          if (start > cursor)
            children.push({ type: 'text', value: child.value.slice(cursor, start) });
          children.push({
            type: 'link',
            url: `#${citationSourceId(scope, index)}`,
            children: [{ type: 'text', value: match[0] }],
            data: {
              hProperties: {
                className: 'inline-citation-link',
                'aria-label': `查看来源 ${index}`,
              },
            },
          });
          cursor = start + match[0].length;
          changed = true;
        }
        if (!changed) children.push(child);
        else if (cursor < child.value.length)
          children.push({ type: 'text', value: child.value.slice(cursor) });
      }
      node.children = children;
    };

    visit(tree);
  };
}

function codeFileExtension(language: string): string {
  const aliases: Record<string, string> = {
    bash: 'sh',
    javascript: 'js',
    jsx: 'jsx',
    shell: 'sh',
    typescript: 'ts',
    tsx: 'tsx',
  };
  return aliases[language] ?? (language.replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'txt');
}

function CodeBlock({ children }: ComponentPropsWithoutRef<'pre'>) {
  const code = isValidElement<{ className?: string; children?: ReactNode }>(children)
    ? children
    : undefined;
  const language = code?.props.className?.match(/(?:^|\s)language-([^\s]+)/)?.[1] ?? 'text';
  const text = plainText(code?.props.children ?? children).replace(/\n$/, '');
  const streaming = useContext(MessageStreamingContext);
  const mermaid = language === 'mermaid';
  const [highlight, setHighlight] = useState<{ source: string; html: string } | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  // 流式期间保持纯文本；消息完成后异步高亮，失败回退纯文本。
  useEffect(() => {
    if (streaming || mermaid) return;
    let cancelled = false;
    highlightCode(text, language)
      .then((html) => {
        if (!cancelled) setHighlight({ source: text, html });
      })
      .catch((error: unknown) => {
        console.error('代码高亮失败，已回退为纯文本。', error);
      });
    return () => {
      cancelled = true;
    };
  }, [text, language, streaming, mermaid]);

  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopyState('idle'), 1_500);
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `snippet.${codeFileExtension(language)}`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-block-language">{language}</span>
        <div className="code-block-actions">
          <button type="button" onClick={() => void copy()} aria-label="复制代码">
            {copyState === 'copied' ? <Check size={13} weight="bold" /> : <Copy size={13} />}
            <span aria-live="polite">
              {copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败' : '复制'}
            </span>
          </button>
          <button type="button" onClick={download} aria-label="下载代码">
            <DownloadSimple size={13} />
            <span>下载</span>
          </button>
        </div>
      </div>
      {mermaid && !streaming ? (
        <MermaidBlock code={text} />
      ) : !streaming && highlight?.source === text ? (
        <div
          className="code-block-highlight"
          dangerouslySetInnerHTML={{ __html: highlight.html }}
        />
      ) : (
        <pre>{children}</pre>
      )}
    </div>
  );
}

function isSafeMarkdownHref(href?: string): href is string {
  if (!href) return false;
  const protocol = href.match(/^([a-z][a-z\d+.-]*):/i)?.[1]?.toLowerCase();
  return !protocol || protocol === 'http' || protocol === 'https' || protocol === 'mailto';
}

function SafeMarkdownLink({
  href,
  children,
  title,
  className,
  'aria-label': ariaLabel,
}: ComponentPropsWithoutRef<'a'>) {
  if (!isSafeMarkdownHref(href)) return <span>{children}</span>;
  const external = /^(?:https?:)?\/\//i.test(href);
  return (
    <a
      href={href}
      title={title}
      className={className}
      aria-label={ariaLabel}
      target={external ? '_blank' : undefined}
      rel={external ? 'noopener noreferrer' : undefined}
      onClick={(event) => {
        if (!href.startsWith('#')) return;
        const target = document.getElementById(href.slice(1));
        if (!target?.classList.contains('citation-source-item')) return;
        event.preventDefault();
        const details = target.closest('details');
        if (details) details.open = true;
        target.focus({ preventScroll: true });
        target.scrollIntoView?.({ block: 'nearest' });
      }}
    >
      {children}
    </a>
  );
}

const markdownComponents = { a: SafeMarkdownLink, pre: CodeBlock };

function ThinkingBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div className="thinking-block">
      <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          <MotionPulseDot className="thinking-dot" active={streaming} />
          {streaming ? '正在思考…' : `思考过程 · ${text.length} 字符`}
          <CaretRight size={12} className="caret" aria-hidden="true" />
        </summary>
        <pre>{text}</pre>
      </details>
    </div>
  );
}

/** 中断/出错恢复卡（旧实现 认证卡的本地语义替换）：仅最后一条 assistant 消息带中断/错误标记时渲染。 */
function RecoveryCard({ message, onRetry, onContinue }: RecoveryProps) {
  const interrupted = Boolean(message.interrupted) && !message.error;
  const action = interrupted ? onContinue : onRetry;
  if (!action) return null;
  const classified = interrupted ? undefined : recoveryCopyFor(message);
  return (
    <motion.div
      className="recovery-card"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: MOTION_EASE }}
    >
      <div className="recovery-card-head">
        <WarningCircle size={14} weight="fill" aria-hidden="true" />
        <h3>
          {interrupted ? '回复已中断' : (classified?.title ?? '本轮回复失败')}
        </h3>
      </div>
      <p className="recovery-card-desc">
        {interrupted
          ? '会话仍然保留，可以让 Agent 从中断处继续回答。'
          : (classified?.desc ?? message.error)}
      </p>
      <button type="button" className="recovery-card-action" onClick={action}>
        {interrupted ? '继续' : '重试'}
      </button>
    </motion.div>
  );
}

/**
 * QoderWake 0.4.2 红卡分类文案的本地移植：按服务端 errorKind 渲染分类标题/正文。
 * 本地没有计费/登录语义，quota 的升级订阅与 auth 的重登动作统一降级为「重试」；
 * 无 kind 的历史错误保持「本轮回复失败」+ 原文。
 */
function recoveryCopyFor(message: ChatMessage): { title: string; desc: ReactNode } | undefined {
  switch (message.errorKind) {
    case 'quota':
      return {
        title: '额度已用尽',
        desc: message.errorResetAt
          ? `当前订阅档位的 Agent 调用次数已用完，将于 ${message.errorResetAt} 重置。请稍后再试。`
          : '当前订阅档位的 Agent 调用次数已用完，将于额度周期重置。请稍后再试。',
      };
    case 'auth':
      return { title: '对话异常中断', desc: '认证已失效，请重新登录后继续。' };
    case 'rate_limit':
      return { title: '本轮回复失败', desc: '请求过于频繁或已达到调用上限，请稍后重试。' };
    case 'timeout':
      return {
        title: '本轮回复失败',
        desc: '与模型服务的连接长时间无响应，已自动中断。可能是网络不稳定或服务端临时繁忙，请稍后重试。',
      };
    case 'network':
      return { title: '本轮回复失败', desc: '无法连接到模型服务，请检查网络后重试。' };
    case 'startup':
      return {
        title: '启动失败',
        desc: (
          <>
            现象：{message.error ?? '对话进程未能启动。'}
            <br />
            原因：模型服务未能正常启动。
            <br />
            建议：请稍后重试；如多次出现请检查模型服务配置。
          </>
        ),
      };
    case 'generic':
      return {
        title: '本轮回复失败',
        desc: '对话因后台异常中断，请稍后重试；如多次出现请提交问题反馈。',
      };
    default:
      return undefined;
  }
}

type RecoveryProps = {
  message: ChatMessage;
  onRetry?: () => void;
  onContinue?: () => void;
};

function MessageItem({
  message,
  onOpenOutputs,
}: {
  message: ChatMessage;
  onOpenOutputs?: () => void;
}) {
  const citationScope = message.id;
  if (message.role === 'user') {
    return (
      <motion.div
        className="message-row user"
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: MOTION_EASE }}
      >
        <div className="user-bubble">
          <ReadableContent text={message.text} className="user-message-content">
            <p>{message.text}</p>
          </ReadableContent>
        </div>
      </motion.div>
    );
  }
  const sourceIndexes = new Set(message.sources?.map((source) => source.index));
  return (
    <motion.div
      className="message-row assistant"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: MOTION_EASE }}
    >
      <div className={cx('assistant-body', message.streaming && 'streaming')}>
        {message.thinking && (
          <ThinkingBlock text={message.thinking} streaming={message.streaming} />
        )}
        {message.tools?.length ? <ProcessCards tools={message.tools} /> : null}
        <ReadableContent text={message.text} streaming={message.streaming} className="markdown">
          <MessageStreamingContext.Provider value={Boolean(message.streaming)}>
            <Markdown
              remarkPlugins={[remarkGfm, citationRemarkPlugin(sourceIndexes, citationScope)]}
              components={markdownComponents}
            >
              {message.text || (message.streaming ? '　' : '')}
            </Markdown>
          </MessageStreamingContext.Provider>
        </ReadableContent>
        {message.streaming && <MotionPulseDot className="streaming-caret" />}
        {!message.streaming && (
          <CitationSources
            sources={message.sources}
            citationScope={citationScope}
            onOpenOutputs={onOpenOutputs}
          />
        )}
        {message.interrupted && (
          <p className="message-interrupted" role="status">
            <WarningCircle size={14} weight="fill" />
            回复已中断，可以重新提问
          </p>
        )}
        {message.error && (
          <div className="message-error-card" role="alert" title={message.error}>
            <WarningCircle size={14} weight="fill" aria-hidden="true" />
            <span className="message-error-card-text">{message.error}</span>
          </div>
        )}
      </div>
    </motion.div>
  );
}

export type ThreadViewProps = {
  messages: ChatMessage[];
  /** 界面偏好「消息紧凑模式」：缩小消息纵向间距。 */
  compact?: boolean;
  /** 会话标题：有会话时在消息流顶部渲染内容区标题。 */
  title?: string;
  /** 当前 Agent 名：与标题一起组成 agent chip。 */
  agentName?: string;
  /** 恢复卡动作：最后一条 assistant 消息出错/中断时展示（无 liveTurn 时由 App 传入）。 */
  onRetry?: () => void;
  onContinue?: () => void;
  /** Opens this session's contextual attachment/artifact/file-change panel. */
  onOpenOutputs?: () => void;
};

export function ThreadView({
  messages,
  compact = false,
  title,
  agentName,
  onRetry,
  onContinue,
  onOpenOutputs,
}: ThreadViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(true);

  useEffect(() => {
    const node = scrollRef.current;
    if (node && followLatestRef.current) node.scrollTop = node.scrollHeight;
  }, [messages]);

  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
  const recovery =
    lastAssistant && !lastAssistant.streaming && (lastAssistant.interrupted || lastAssistant.error)
      ? lastAssistant
      : null;

  return (
    <div
      className="thread-scroll"
      ref={scrollRef}
      onScroll={(event) => {
        const node = event.currentTarget;
        followLatestRef.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 80;
      }}
    >
      <div className={cx('thread-column', compact && 'compact')}>
        {title && (
          <div className="thread-intro">
            <h2 className="thread-intro-title">{title}</h2>
            {agentName && (
              <span className="thread-agent-chip">
                <Robot size={10} aria-hidden="true" />
                {agentName}
              </span>
            )}
          </div>
        )}
        {messages.map((message) => (
          <MessageItem
            key={message.id}
            message={message}
            onOpenOutputs={
              message === lastAssistant ||
              message.tools?.some((tool) => tool.name === 'file_change')
                ? onOpenOutputs
                : undefined
            }
          />
        ))}
        {recovery && <RecoveryCard message={recovery} onRetry={onRetry} onContinue={onContinue} />}
        {!messages.length && <p className="thread-empty-note">输入第一条消息，开始这段对话。</p>}
      </div>
    </div>
  );
}
