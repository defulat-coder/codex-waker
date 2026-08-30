import type { SessionSummary } from '@waker/contracts';
import { motion, useReducedMotion } from 'motion/react';
import { ChatCircle } from '@phosphor-icons/react/dist/icons/ChatCircle';
import { ClockCounterClockwise } from '@phosphor-icons/react/dist/icons/ClockCounterClockwise';
import { DotsThree } from '@phosphor-icons/react/dist/icons/DotsThree';
import { cx } from '../lib/cx.js';
import { MOTION_TRANSITION } from '../lib/motion.js';
import { handleCompositeKeyDown } from '../hooks/useDismissable.js';

export function QoderTaskPanel({
  sessions,
  currentSessionId,
  onOpenSession,
  onOpenAutomations,
  onClose,
}: {
  sessions: SessionSummary[];
  currentSessionId: string | null;
  onOpenSession: (sessionId: string) => void;
  onOpenAutomations: () => void;
  onClose: () => void;
}) {
  const reducedMotion = useReducedMotion();
  const selectedSessionId = sessions.some((session) => session.id === currentSessionId)
    ? currentSessionId
    : null;
  const focusSessionId = selectedSessionId ?? sessions[0]?.id;

  return (
    <motion.aside
      id="qoder-task-panel"
      className="qoder-task-panel"
      aria-label="任务列表"
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      transition={MOTION_TRANSITION.panel}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <nav className="qoder-task-tabs" aria-label="任务类型">
        <button
          autoFocus
          type="button"
          aria-current="page"
          className="active"
        >
          <ChatCircle size={14} /> 对话任务
        </button>
        <button
          type="button"
          onClick={onOpenAutomations}
        >
          <ClockCounterClockwise size={14} /> 自动任务
        </button>
      </nav>
      <div
        className="qoder-task-list"
        role="region"
        aria-label="对话任务"
      >
        {sessions.length ? (
          <div
            className="qoder-task-options"
            role="listbox"
            aria-label="对话任务"
            onKeyDown={(event) => handleCompositeKeyDown(event)?.click()}
          >
            {sessions.map((session) => {
              const selected = session.id === selectedSessionId;
              return (
                <button
                  type="button"
                  key={session.id}
                  role="option"
                  aria-selected={selected}
                  tabIndex={session.id === focusSessionId ? 0 : -1}
                  className={cx('qoder-task-row', selected && 'active')}
                  onClick={() => onOpenSession(session.id)}
                >
                  {selected && (
                    <motion.span
                      className="qoder-task-row-active"
                      layoutId={reducedMotion ? undefined : 'qoder-task-row-active'}
                      transition={MOTION_TRANSITION.routine}
                      aria-hidden="true"
                    />
                  )}
                  <i aria-hidden="true" />
                  <span>
                    <strong>{session.title}</strong>
                    <small>{session.questionCount} 次提问</small>
                  </span>
                  <DotsThree size={14} aria-hidden="true" />
                </button>
              );
            })}
          </div>
        ) : (
          <p className="qoder-task-empty" role="status">
            暂无对话任务
          </p>
        )}
      </div>
    </motion.aside>
  );
}
