import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { ArrowsClockwise } from '@phosphor-icons/react/dist/icons/ArrowsClockwise';
import { CaretRight } from '@phosphor-icons/react/dist/icons/CaretRight';
import { Check } from '@phosphor-icons/react/dist/icons/Check';
import { Copy } from '@phosphor-icons/react/dist/icons/Copy';
import { ListChecks } from '@phosphor-icons/react/dist/icons/ListChecks';
import { MinusCircle } from '@phosphor-icons/react/dist/icons/MinusCircle';
import { Robot } from '@phosphor-icons/react/dist/icons/Robot';
import { WarningCircle } from '@phosphor-icons/react/dist/icons/WarningCircle';
import { Wrench } from '@phosphor-icons/react/dist/icons/Wrench';
import type { LiveToolCall, ProcessStatus } from '../lib/stream.js';
import { cx } from '../lib/cx.js';
import { MOTION_EASE } from '../lib/motion.js';
import { MotionSpinner } from './MotionFeedback.js';

type PlanItem = { text: string; completed: boolean };

function tryParseToolPayload(text?: string): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function planItems(tool: LiveToolCall): PlanItem[] | undefined {
  if (tool.name !== 'plan') return undefined;
  const items = tryParseToolPayload(tool.args)?.items;
  if (!Array.isArray(items)) return undefined;
  return items.filter(
    (item): item is PlanItem =>
      Boolean(item) &&
      typeof item === 'object' &&
      typeof (item as PlanItem).text === 'string' &&
      typeof (item as PlanItem).completed === 'boolean',
  );
}

export function toolCardTitle(tool: LiveToolCall): string {
  const args = tryParseToolPayload(tool.args);
  if (tool.name === 'plan') {
    const items = planItems(tool) ?? [];
    return `计划 · ${items.filter((item) => item.completed).length}/${items.length}`;
  }
  if (tool.name === 'subagent') {
    const agent = typeof args?.agent === 'string' ? args.agent : undefined;
    if (args?.action && args.action !== 'run') return `子代理管理 · ${String(args.action)}`;
    return agent ? `委派给 ${agent}` : '子代理委派';
  }
  if (
    (tool.name === 'bash' || tool.name === 'command_execution') &&
    typeof args?.command === 'string'
  )
    return `bash · ${args.command}`;
  return tool.name;
}

const STATUS_LABEL: Record<ProcessStatus, string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

function StatusIcon({ status }: { status: ProcessStatus }) {
  if (status === 'running')
    return (
      <MotionSpinner>
        <ArrowsClockwise size={13} />
      </MotionSpinner>
    );
  if (status === 'failed') return <WarningCircle size={13} weight="fill" />;
  if (status === 'cancelled') return <MinusCircle size={13} weight="fill" />;
  return <Check size={13} weight="bold" />;
}

function ProcessIcon({ name, size = 14 }: { name: string; size?: number }) {
  if (name === 'subagent') return <Robot size={size} />;
  if (name === 'plan') return <ListChecks size={size} />;
  return <Wrench size={size} />;
}

function CopyResultButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const copy = () => {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 1200);
      },
      () => undefined,
    );
  };

  return (
    <button type="button" className="tool-card-copy" onClick={copy} aria-label="复制结果">
      {copied ? <Check size={12} weight="bold" /> : <Copy size={12} />}
    </button>
  );
}

function ProcessCard({ tool }: { tool: LiveToolCall }) {
  const [open, setOpen] = useState(false);
  const items = planItems(tool);
  return (
    <details
      className="tool-card"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="tool-card-icon" aria-hidden="true">
          <ProcessIcon name={tool.name} />
        </span>
        <span className="tool-card-title">{toolCardTitle(tool)}</span>
        <span className={cx('tool-card-status', tool.status)}>
          <StatusIcon status={tool.status} />
          {STATUS_LABEL[tool.status]}
        </span>
        <CaretRight size={12} className="caret" aria-hidden="true" />
      </summary>
      <div className="tool-card-body">
        {items ? (
          <ul className="process-plan-list">
            {items.map((item, index) => (
              <li key={`${item.text}-${index}`} className={cx(item.completed && 'completed')}>
                <Check size={12} aria-hidden="true" />
                <span>{item.text}</span>
              </li>
            ))}
          </ul>
        ) : (
          tool.args && (
            <>
              <p className="tool-card-label">参数</p>
              <pre>{tool.args}</pre>
            </>
          )
        )}
        {tool.result && (
          <>
            <p className="tool-card-label">结果</p>
            <div className="tool-card-result">
              <pre>{tool.result}</pre>
              <CopyResultButton text={tool.result} />
            </div>
          </>
        )}
      </div>
    </details>
  );
}

function groupStatus(tools: LiveToolCall[]): ProcessStatus {
  if (tools.some((tool) => tool.status === 'running')) return 'running';
  if (tools.some((tool) => tool.status === 'failed')) return 'failed';
  if (tools.some((tool) => tool.status === 'cancelled')) return 'cancelled';
  return 'completed';
}

export function ProcessCards({ tools }: { tools: LiveToolCall[] }) {
  const [open, setOpen] = useState(false);
  const first = tools[0];
  if (!first) return null;
  const status = groupStatus(tools);
  return (
    <motion.div
      className="tool-group"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: MOTION_EASE }}
    >
      <button
        type="button"
        className="tool-group-summary"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="tool-group-icons" aria-hidden="true">
          {tools.slice(0, 4).map((tool) => (
            <span key={tool.id} className="tool-group-icon">
              <ProcessIcon name={tool.name} size={12} />
            </span>
          ))}
        </span>
        <span className="tool-group-title">{toolCardTitle(first)}</span>
        {tools.length > 1 && <span className="tool-group-more">+{tools.length - 1}</span>}
        <span className={cx('tool-group-count', status)} aria-live="polite">
          {tools.length} 个过程 · {STATUS_LABEL[status]}
        </span>
        <CaretRight
          size={12}
          className={cx('tool-group-chevron', open && 'open')}
          aria-hidden="true"
        />
      </button>
      {open && (
        <div className="tool-group-list">
          {tools.map((tool) => (
            <ProcessCard key={tool.id} tool={tool} />
          ))}
        </div>
      )}
    </motion.div>
  );
}
