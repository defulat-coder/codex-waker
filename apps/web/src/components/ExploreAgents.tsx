import { motion } from 'motion/react';
import { agentCardStats } from '../lib/explore.js';
import { MOTION_EASE } from '../lib/motion.js';
import { useWorkspace } from '../context/WorkspaceContext.js';
import { AgentChip } from './AgentChip.js';

export type ExploreAgentsProps = {
  onOpenChat: (agentId: string) => void;
};

/** 工作区 Agents 页：卡片样式类推 §11.4（原页是付费墙，无真实列表可抓）。 */
export function ExploreAgents({ onOpenChat }: ExploreAgentsProps) {
  const { workspace } = useWorkspace();
  const agents = workspace.agents;
  return (
    <div className="explore">
      <header className="explore-header">
        <h1>Agents</h1>
        <p>工作区里的全部 Agent，共 {agents.length} 个。点击卡片开始聊天。</p>
      </header>

      <div className="explore-grid" role="list">
        {agents.map((agent, index) => {
          const stats = agentCardStats(agent);
          return (
            <motion.button
              type="button"
              role="listitem"
              key={agent.id}
              className="agent-card"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              whileTap={{ scale: 0.97 }}
              transition={{ duration: 0.25, ease: MOTION_EASE, delay: index * 0.04 }}
              onClick={() => onOpenChat(agent.id)}
            >
              <span className="agent-card-head">
                <AgentChip
                  mark={agent.mark}
                  className="medium"
                  agentId={agent.id}
                  hasAvatar={agent.hasAvatar}
                />
                <span className="agent-card-title">
                  <strong>{agent.name}</strong>
                  <small>{agent.tagline}</small>
                </span>
              </span>
              <span className="agent-card-desc">{agent.description}</span>
              <span className="agent-card-stats">
                {stats.suggestionCount} 个建议问题 · {stats.sessionCount} 个会话
              </span>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
