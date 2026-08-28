import type { AgentSummary, SessionSummary } from '@waker/contracts';
import { Info } from '@phosphor-icons/react/dist/icons/Info';

/** 顶部用量条：真实统计当前 agent 的会话数与提问总数，无配额概念，不渲染进度条。 */
export function UsageBar({
  agent,
  sessions,
}: {
  agent: AgentSummary | undefined;
  sessions: SessionSummary[];
}) {
  if (!agent) return null;
  const questionTotal = sessions.reduce((sum, session) => sum + session.questionCount, 0);
  return (
    <div className="usage-bar-wrap">
      <div className="usage-bar">
        <Info size={16} />
        <span>
          {agent.name} · 累计 {sessions.length} 个会话 · {questionTotal} 次提问
        </span>
      </div>
    </div>
  );
}
