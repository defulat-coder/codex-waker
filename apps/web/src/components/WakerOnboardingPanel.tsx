import { useEffect, useId, useRef } from 'react';
import { BookOpenText } from '@phosphor-icons/react/dist/icons/BookOpenText';
import { ChatCircle } from '@phosphor-icons/react/dist/icons/ChatCircle';
import { FolderOpen } from '@phosphor-icons/react/dist/icons/FolderOpen';
import { X } from '@phosphor-icons/react/dist/icons/X';
import { motion, useReducedMotion } from 'motion/react';
import { MOTION_EASE } from '../lib/motion.js';

export interface WakerOnboardingPanelProps {
  onChat: () => void;
  onKnowledge: () => void;
  onProject: () => void;
  onDismiss: () => void;
}

/** 创建 Waker 后的可跳过下一步入口；完成状态由目标页面的真实数据决定。 */
export function WakerOnboardingPanel({
  onChat,
  onKnowledge,
  onProject,
  onDismiss,
}: WakerOnboardingPanelProps) {
  const titleId = useId();
  const detailId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  return (
    <motion.section
      ref={panelRef}
      className="waker-onboarding"
      role="region"
      aria-labelledby={titleId}
      aria-describedby={detailId}
      aria-live="polite"
      tabIndex={-1}
      initial={reduceMotion ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.18, ease: MOTION_EASE }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onDismiss();
        }
      }}
    >
      <div className="waker-onboarding-head">
        <div>
          <h2 id={titleId}>Waker 已创建</h2>
          <p id={detailId}>选择一个真实入口继续，也可以稍后再设置。</p>
        </div>
        <button type="button" className="icon-button" aria-label="关闭创建引导" onClick={onDismiss}>
          <X size={15} aria-hidden="true" />
        </button>
      </div>

      <div className="waker-onboarding-actions" aria-label="Waker 下一步设置">
        <button type="button" className="legacy-button primary" onClick={onChat}>
          <ChatCircle size={17} aria-hidden="true" />
          <span>
            <strong>进入 Chat</strong>
            <small>开始第一段本地对话</small>
          </span>
        </button>
        <button type="button" className="legacy-button" onClick={onKnowledge}>
          <BookOpenText size={17} aria-hidden="true" />
          <span>
            <strong>绑定 Knowledge</strong>
            <small>选择本地知识库并建立绑定</small>
          </span>
        </button>
        <button type="button" className="legacy-button" onClick={onProject}>
          <FolderOpen size={17} aria-hidden="true" />
          <span>
            <strong>选择或创建 Project</strong>
            <small>指定之后运行任务的工作目录</small>
          </span>
        </button>
      </div>
    </motion.section>
  );
}
