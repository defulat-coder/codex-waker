import type { SessionSummary } from '@waker/contracts';
import { motion } from 'motion/react';
import { ChatCircle } from '@phosphor-icons/react/dist/icons/ChatCircle';
import { ClockCounterClockwise } from '@phosphor-icons/react/dist/icons/ClockCounterClockwise';
import { DotsThree } from '@phosphor-icons/react/dist/icons/DotsThree';
import { cx } from '../lib/cx.js';
import { MOTION_TRANSITION } from '../lib/motion.js';

export function QoderTaskPanel({
  sessions,
  currentSessionId,
  onOpenSession,
  onOpenAutomations,
}: {
  sessions: SessionSummary[];
  currentSessionId: string | null;
  onOpenSession: (sessionId: string) => void;
  onOpenAutomations: () => void;
}) {
  return (
    <motion.aside
      className="qoder-task-panel"
      aria-label="任务列表"
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 16 }}
      transition={MOTION_TRANSITION.panel}
    >
      <div className="qoder-task-tabs" role="tablist" aria-label="任务类型">
        <button type="button" role="tab" aria-selected="true" className="active">
          <ChatCircle size={14} /> 对话任务
        </button>
        <button type="button" role="tab" aria-selected="false" onClick={onOpenAutomations}>
          <ClockCounterClockwise size={14} /> 自动任务
        </button>
      </div>
      <div className="qoder-task-list">
        {sessions.map((session) => (
          <button
            type="button"
            key={session.id}
            className={cx('qoder-task-row', session.id === currentSessionId && 'active')}
            onClick={() => onOpenSession(session.id)}
          >
            <i aria-hidden="true" />
            <span>
              <strong>{session.title}</strong>
              <small>{session.questionCount} 次提问</small>
            </span>
            <DotsThree size={14} aria-hidden="true" />
          </button>
        ))}
        {!sessions.length && <p className="qoder-task-empty">暂无对话任务</p>}
      </div>
    </motion.aside>
  );
}
