import type { AgentSummary } from '@waker/contracts';
import { Check } from '@phosphor-icons/react/dist/icons/Check';
import { MagnifyingGlass } from '@phosphor-icons/react/dist/icons/MagnifyingGlass';
import { Plus } from '@phosphor-icons/react/dist/icons/Plus';
import { AgentChip } from './AgentChip.js';
import { cx } from '../lib/cx.js';

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
  return (
    <aside className="qoder-chat-sidebar" aria-label="Chat 会话">
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
        <div className="qoder-chat-waker-list">
          {agents.map((agent) => (
            <button
              type="button"
              key={agent.id}
              className={cx('qoder-chat-waker', agent.id === currentAgentId && 'active')}
              aria-current={agent.id === currentAgentId ? 'true' : undefined}
              onClick={() => onSelectAgent(agent.id)}
            >
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
              <time>{agent.sessionCount ?? 0} 个会话</time>
            </button>
          ))}
        </div>
      </section>
    </aside>
  );
}
