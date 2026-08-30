import { motion } from 'motion/react';
import type { UsageResponse } from '@waker/contracts';
import { ArrowClockwise } from '@phosphor-icons/react/dist/icons/ArrowClockwise';
import { ChartLine } from '@phosphor-icons/react/dist/icons/ChartLine';
import { formatRelativeTime } from '../lib/sessions.js';
import { MOTION_EASE } from '../lib/motion.js';
import { AgentChip } from './AgentChip.js';
import { MotionSpinner } from './MotionFeedback.js';

export type UsageViewProps = {
  usage: UsageResponse | null;
  loading: boolean;
  loaded: boolean;
  error: Error | null;
  onRefresh: () => void;
};

/** 用量页（§11.7）：4 列统计卡 + 按 Agent 分列的用量表；本地模式无配额概念。 */
export function UsageView({ usage, loading, loaded, error, onRefresh }: UsageViewProps) {
  const now = new Date();
  const stats = usage
    ? [
        { label: '累计会话', value: usage.totalSessions },
        { label: '累计提问', value: usage.totalQuestions },
        { label: '累计 Token', value: usage.tokens.total.toLocaleString() },
        { label: '今日提问', value: usage.questionsToday },
      ]
    : [];

  return (
    <div className="system-page">
      <div className="system-page-header">
        <div className="system-page-title">
          <ChartLine size={20} aria-hidden="true" />
          <div>
            <h3>用量</h3>
            <p>
              会话与提问来自 .codex/sessions 的持久化记录，Token 统计来自本地
              SQLite（.codex/workbench.db）。
            </p>
          </div>
        </div>
        <button
          type="button"
          className="inbox-refresh"
          onClick={onRefresh}
          aria-label="刷新用量"
          disabled={loading}
        >
          {loading ? (
            <MotionSpinner>
              <ArrowClockwise size={16} />
            </MotionSpinner>
          ) : (
            <ArrowClockwise size={16} />
          )}
        </button>
      </div>

      {error && usage ? (
        <div className="legacy-error" role="alert">
          <p>用量刷新失败，当前仍显示上次统计的数据。</p>
          <button type="button" className="legacy-button" onClick={onRefresh}>
            重试
          </button>
        </div>
      ) : null}

      {!usage && (!loaded || loading) ? (
        <p className="system-page-loading" role="status">
          正在统计…
        </p>
      ) : !usage ? (
        <div className="legacy-error" role="alert">
          <p>{error?.message || '用量数据暂时无法读取'}</p>
          <button type="button" className="legacy-button" onClick={onRefresh}>
            重试
          </button>
        </div>
      ) : (
        <>
          <motion.div
            className="usage-stats"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, ease: MOTION_EASE }}
          >
            {stats.map((stat) => (
              <div className="usage-stat" key={stat.label}>
                <span className="usage-stat-label">{stat.label}</span>
                <span className="usage-stat-value">{stat.value}</span>
              </div>
            ))}
          </motion.div>

          <h4 className="usage-table-title">按 Agent 分列</h4>
          <table className="usage-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>会话数</th>
                <th>提问数</th>
                <th>Token</th>
                <th>最近活跃</th>
              </tr>
            </thead>
            <tbody>
              {usage.perAgent.map((row) => (
                <tr key={row.agentId}>
                  <td>
                    <span className="usage-table-agent">
                      <AgentChip mark={row.mark} />
                      {row.name}
                    </span>
                  </td>
                  <td className="usage-table-number">{row.sessionCount}</td>
                  <td className="usage-table-number">{row.questionCount}</td>
                  <td className="usage-table-number">
                    {row.tokens.total > 0 ? row.tokens.total.toLocaleString() : '—'}
                  </td>
                  <td className="usage-table-time">
                    {row.lastActiveAt ? formatRelativeTime(row.lastActiveAt, now) : '从未使用'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
