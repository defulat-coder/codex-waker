import type { AgentSummary } from '@waker/contracts';
import { motion, type Variants } from 'motion/react';
import { Sparkle } from '@phosphor-icons/react/dist/icons/Sparkle';
import { MOTION_EASE } from '../lib/motion.js';
import { AgentChip } from './AgentChip.js';

const group: Variants = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } };
const item: Variants = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: { duration: 0.18, ease: MOTION_EASE } },
};

/** 无会话 / 新会话的欢迎区：agent chip + 大标题 + 建议问题。 */
export function Welcome({
  agent,
  onSuggestion,
}: {
  agent: AgentSummary;
  onSuggestion: (text: string) => void;
}) {
  return (
    <motion.div className="welcome" variants={group} initial="hidden" animate="show">
      <motion.div className="welcome-head" variants={item}>
        <AgentChip
          mark={agent.mark}
          className="qoder-welcome-avatar"
          agentId={agent.id}
          hasAvatar={agent.hasAvatar}
        />
        <h1 className="welcome-title">你好，今天我能帮你什么？</h1>
        <p className="welcome-tagline">
          我是 {agent.name}，{agent.description || '可以完成你指派的各种任务。'}
        </p>
      </motion.div>
      {agent.suggestions.length > 0 && (
        <motion.div className="welcome-suggestions" variants={item}>
          {agent.suggestions.map((suggestion) => (
            <button
              type="button"
              key={suggestion}
              className="suggestion-button"
              onClick={() => onSuggestion(suggestion)}
            >
              <Sparkle size={22} weight="fill" aria-hidden="true" />
              {suggestion}
            </button>
          ))}
        </motion.div>
      )}
    </motion.div>
  );
}
