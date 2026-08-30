import type { AgentSummary } from '@waker/contracts';
import { motion, useReducedMotion } from 'motion/react';
import { Check } from '@phosphor-icons/react/dist/icons/Check';
import { MagnifyingGlass } from '@phosphor-icons/react/dist/icons/MagnifyingGlass';
import { Plus } from '@phosphor-icons/react/dist/icons/Plus';
import { AgentChip } from './AgentChip.js';
import { cx } from '../lib/cx.js';
import { MOTION_TRANSITION } from '../lib/motion.js';
import { handleCompositeKeyDown } from '../hooks/useDismissable.js';

export function QoderChatSidebar({
  agents,
  currentAgentId,
  onSelectAgent,
  onMarkAllRead,
}: {
  agents: AgentSummary[];
  currentAgentId?: string;
  onSelectAgent: (agentId: string) => void;
  onMarkAllRead: () => void;
}) {
  const reducedMotion = useReducedMotion();
  const selectedAgentId = agents.some((agent) => agent.id === currentAgentId)
    ? currentAgentId
    : agents[0]?.id;

  return (
    <motion.aside
      className="qoder-chat-sidebar"
      aria-label="Chat 会话"
      initial={{ opacity: 0, x: -12 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -12 }}
      transition={MOTION_TRANSITION.panel}
    >
      <header className="qoder-chat-sidebar-header">
        <strong>Chat</strong>
        <button type="button" aria-label="一键已读" onClick={onMarkAllRead}>
          <Check size={14} /> 一键已读
        </button>
      </header>

      <section className="qoder-chat-groups" aria-labelledby="qoder-chat-groups-title">
        <div className="qoder-chat-section-title" id="qoder-chat-groups-title">
          <span>群组</span>
          <small>Beta</small>
        </div>
        <div className="qoder-chat-group-actions">
          <button type="button" disabled title="本地模式不提供云端群组">
            <Plus size={14} /> 新建群组
          </button>
          <MagnifyingGlass size={16} aria-hidden="true" />
        </div>
      </section>

      <section className="qoder-chat-wakers" aria-labelledby="qoder-chat-wakers-title">
        <h2 id="qoder-chat-wakers-title">Waker</h2>
        <div
          className="qoder-chat-waker-list"
          role="listbox"
          aria-labelledby="qoder-chat-wakers-title"
          onKeyDown={(event) => {
            const target = handleCompositeKeyDown(event);
            target?.click();
          }}
        >
          {agents.map((agent) => {
            const selected = agent.id === selectedAgentId;
            return (
              <button
                type="button"
                key={agent.id}
                role="option"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                className={cx('qoder-chat-waker', selected && 'active')}
                onClick={() => onSelectAgent(agent.id)}
              >
                {selected && (
                  <motion.span
                    className="qoder-chat-waker-active"
                    layoutId={reducedMotion ? undefined : 'qoder-chat-waker-active'}
                    transition={MOTION_TRANSITION.routine}
                    aria-hidden="true"
                  />
                )}
                <AgentChip
                  mark={agent.mark}
                  className="qoder-chat-avatar"
                  agentId={agent.id}
                  hasAvatar={agent.hasAvatar}
                />
                <span className="qoder-chat-waker-copy">
                  <strong>{agent.name}</strong>
                  <small>{agent.description || agent.tagline}</small>
                </span>
                <span className="qoder-chat-waker-count">{agent.sessionCount ?? 0} 个会话</span>
              </button>
            );
          })}
        </div>
      </section>
    </motion.aside>
  );
}
