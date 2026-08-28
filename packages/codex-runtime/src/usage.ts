import type { AgentUsageRow, SessionSummary, UsageResponse } from '@waker/contracts';

type AgentIdentity = Pick<AgentUsageRow, 'name' | 'mark'> & { id: string };

/**
 * The rollout-derived base of the Usage page. Token totals are aggregated from
 * persisted rollout sessions and overlaid by the API layer, so they are absent here.
 */
export type SessionUsageSummary = Omit<UsageResponse, 'tokens' | 'perAgent'> & {
  perAgent: Array<Omit<AgentUsageRow, 'tokens'>>;
};

function isSameLocalDay(iso: string, now: Date): boolean {
  const date = new Date(iso);
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

/**
 * Aggregates the Usage page numbers from persisted session summaries.
 * `questionsToday` counts every question of sessions created or updated on the
 * current local day — the summary has no per-question timestamps, so a session
 * spanning midnight contributes its full count to the day it was last active.
 */
export function summarizeUsage(
  sessions: SessionSummary[],
  agents: AgentIdentity[],
  now: Date = new Date(),
): SessionUsageSummary {
  const perAgent: SessionUsageSummary['perAgent'] = agents.map((agent) => {
    const owned = sessions.filter((session) => session.agentId === agent.id);
    const lastActiveAt = owned.reduce<string | undefined>(
      (latest, session) =>
        latest === undefined || session.updatedAt > latest ? session.updatedAt : latest,
      undefined,
    );
    return {
      agentId: agent.id,
      name: agent.name,
      mark: agent.mark,
      sessionCount: owned.length,
      questionCount: owned.reduce((sum, session) => sum + session.questionCount, 0),
      ...(lastActiveAt ? { lastActiveAt } : {}),
    };
  });

  return {
    totalSessions: sessions.length,
    totalQuestions: sessions.reduce((sum, session) => sum + session.questionCount, 0),
    agentCount: agents.length,
    questionsToday: sessions
      .filter(
        (session) =>
          isSameLocalDay(session.createdAt, now) || isSameLocalDay(session.updatedAt, now),
      )
      .reduce((sum, session) => sum + session.questionCount, 0),
    perAgent,
  };
}
