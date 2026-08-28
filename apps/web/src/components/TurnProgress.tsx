import { useState } from 'react';
import { motion } from 'motion/react';
import { CaretRight } from '@phosphor-icons/react/dist/icons/CaretRight';
import { ArrowsClockwise } from '@phosphor-icons/react/dist/icons/ArrowsClockwise';
import { WarningCircle } from '@phosphor-icons/react/dist/icons/WarningCircle';
import { Check } from '@phosphor-icons/react/dist/icons/Check';
import { MinusCircle } from '@phosphor-icons/react/dist/icons/MinusCircle';
import type { LiveToolCall, LiveTurn } from '../lib/stream.js';
import { cx } from '../lib/cx.js';
import { MOTION_EASE } from '../lib/motion.js';
import { toolCardTitle } from './ProcessCards.js';

function RowStatusIcon({ tool }: { tool: LiveToolCall }) {
  if (tool.status === 'running') return <ArrowsClockwise size={12} className="running" />;
  if (tool.status === 'failed') return <WarningCircle size={12} className="fail" weight="fill" />;
  if (tool.status === 'cancelled')
    return <MinusCircle size={12} className="cancelled" weight="fill" />;
  return <Check size={12} className="ok" weight="bold" />;
}

/**
 * 工具执行进度条（Fleet 任务进度条的本地语义替换）：
 * liveTurn 存在时钉在 composer 上方，展示当前运行中的工具；点击展开列出本轮全部工具。
 */
export function TurnProgress({ turn }: { turn: LiveTurn }) {
  const [open, setOpen] = useState(false);
  const running = [...turn.tools].reverse().find((tool) => tool.status === 'running');

  return (
    <motion.div
      className="turn-progress"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: MOTION_EASE }}
    >
      <button
        type="button"
        className="turn-progress-bar"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <CaretRight
          size={12}
          className={cx('turn-progress-chevron', open && 'open')}
          aria-hidden="true"
        />
        <span className="turn-progress-spinner" aria-hidden="true">
          <ArrowsClockwise size={14} />
        </span>
        <span className="turn-progress-label">正在执行</span>
        {running && <span className="turn-progress-tool">{toolCardTitle(running)}</span>}
      </button>
      {open && turn.tools.length > 0 && (
        <div className="turn-progress-list">
          {turn.tools.map((tool) => (
            <div key={tool.id} className="turn-progress-row">
              <RowStatusIcon tool={tool} />
              <span className="turn-progress-row-name">{toolCardTitle(tool)}</span>
              <span className="turn-progress-row-status">
                {tool.status === 'running'
                  ? '运行中'
                  : tool.status === 'completed'
                    ? '已完成'
                    : tool.status === 'failed'
                      ? '失败'
                      : '已取消'}
              </span>
            </div>
          ))}
        </div>
      )}
    </motion.div>
  );
}
