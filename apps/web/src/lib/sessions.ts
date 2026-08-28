import type { SessionSummary } from '@waker/contracts';

export type SessionGroupKey = 'today' | 'yesterday' | 'week' | 'earlier';

export type SessionGroup = { key: SessionGroupKey; label: string; items: SessionSummary[] };

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Newest first by updatedAt, then createdAt. */
export function sortSessions(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      right.createdAt.localeCompare(left.createdAt),
  );
}

/** Groups sessions by recency: 今天 / 昨天 / 本周（近 7 天）/ 更早. Empty groups are dropped. */
export function groupSessions(sessions: SessionSummary[], now: Date): SessionGroup[] {
  const todayStart = startOfDay(now);
  const buckets: Record<SessionGroupKey, SessionSummary[]> = {
    today: [],
    yesterday: [],
    week: [],
    earlier: [],
  };
  for (const session of sortSessions(sessions)) {
    const time = new Date(session.updatedAt).getTime();
    if (Number.isNaN(time)) {
      buckets.earlier.push(session);
      continue;
    }
    if (time >= todayStart) buckets.today.push(session);
    else if (time >= todayStart - DAY_MS) buckets.yesterday.push(session);
    else if (time >= todayStart - 7 * DAY_MS) buckets.week.push(session);
    else buckets.earlier.push(session);
  }
  const labels: Record<SessionGroupKey, string> = {
    today: '今天',
    yesterday: '昨天',
    week: '本周',
    earlier: '更早',
  };
  return (Object.keys(buckets) as SessionGroupKey[])
    .filter((key) => buckets[key].length > 0)
    .map((key) => ({ key, label: labels[key], items: buckets[key] }));
}

/** Sessions whose last recorded run errored or was aborted. */
export function filterAttention(sessions: SessionSummary[]): SessionSummary[] {
  return sessions.filter((session) => session.needsAttention);
}

/** Compact relative time for inbox rows: 刚刚 / n 分钟前 / n 小时前 / 昨天 / M月d日. */
export function formatRelativeTime(iso: string, now: Date): string {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return '';
  const diffMs = now.getTime() - time;
  if (diffMs < 60_000) return '刚刚';
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)} 分钟前`;
  if (diffMs < DAY_MS && startOfDay(now) === startOfDay(new Date(time)))
    return `${Math.floor(diffMs / 3_600_000)} 小时前`;
  if (time >= startOfDay(now) - DAY_MS) return '昨天';
  const date = new Date(time);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}
