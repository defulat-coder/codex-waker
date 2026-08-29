import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import type {
  AgentDetail,
  AgentHomeResponse,
  AgentSummary,
  AutomationRunRecord,
  SessionSummary,
} from '@waker/contracts';
import { SlidersHorizontal } from '@phosphor-icons/react/dist/icons/SlidersHorizontal';
import {
  fetchAgent,
  fetchAgentHome,
  fetchAutomationRuns,
  fetchSessions,
} from '../lib/api.js';
import { cx } from '../lib/cx.js';
import { MOTION_EASE } from '../lib/motion.js';
import { formatRelativeTime } from '../lib/sessions.js';
import { AgentChip } from './AgentChip.js';

type RecordsTab = 'timeline' | 'sessions' | 'automations';

interface HomeData {
  detail: AgentDetail;
  home: AgentHomeResponse;
  sessions: SessionSummary[];
  runs: AutomationRunRecord[];
}

const DAY_MS = 86_400_000;
/** 热度图列数：trailing 52 周，周为列、周一到周日为行。 */
const HEATMAP_WEEKS = 52;

function dayKey(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/** 活跃度按 UTC 日期对齐（与服务端 date(updated_at) 的键一致），未来日期渲染为占位空格。 */
function buildHeatmap(activity: AgentHomeResponse['activity'], now: Date) {
  const counts = new Map(activity.map((item) => [item.date, item.count]));
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const sinceMonday = (now.getUTCDay() + 6) % 7;
  const firstMonday = today - sinceMonday * DAY_MS - (HEATMAP_WEEKS - 1) * 7 * DAY_MS;
  const weeks: Array<Array<{ date: string; count: number } | null>> = [];
  const months: Array<{ index: number; label: string }> = [];
  let lastMonth = -1;
  for (let week = 0; week < HEATMAP_WEEKS; week += 1) {
    const days: Array<{ date: string; count: number } | null> = [];
    for (let day = 0; day < 7; day += 1) {
      const time = firstMonday + (week * 7 + day) * DAY_MS;
      if (time > today) {
        days.push(null);
        continue;
      }
      const month = new Date(time).getUTCMonth();
      if (day === 0 && month !== lastMonth) {
        months.push({ index: week, label: `${month + 1}月` });
        lastMonth = month;
      }
      const date = dayKey(time);
      days.push({ date, count: counts.get(date) ?? 0 });
    }
    weeks.push(days);
  }
  return { weeks, months };
}

/** 热度分桶：0 为空，1-10+ 映射到 4 个品牌色阶。 */
function activityLevel(count: number): number {
  if (count <= 0) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 2;
  if (count <= 9) return 3;
  return 4;
}

/** 入职天数：按本地日历日计算，入职当天为第 1 天；无创建时间时返回 null。 */
function tenureDays(createdAt: string | null, now: Date): number | null {
  if (!createdAt) return null;
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return null;
  const start = new Date(created.getFullYear(), created.getMonth(), created.getDate()).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.max(1, Math.floor((today - start) / DAY_MS) + 1);
}

function formatHireDate(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

const RUN_STATUS_LABELS: Record<AutomationRunRecord['status'], string> = {
  queued: '排队中',
  running: '运行中',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
  skipped: '已跳过',
};

interface TimelineEvent {
  id: string;
  time: string;
  title: string;
  detail: string;
}

/** 时间线 = 会话创建/更新事件 + 自动任务运行事件，按时间倒序合并。 */
function buildTimeline(sessions: SessionSummary[], runs: AutomationRunRecord[]): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const session of sessions) {
    events.push({
      id: `session-created-${session.id}`,
      time: session.createdAt,
      title: `创建对话任务「${session.title}」`,
      detail: `${session.questionCount} 个问题`,
    });
    if (session.updatedAt > session.createdAt) {
      events.push({
        id: `session-updated-${session.id}`,
        time: session.updatedAt,
        title: `更新对话任务「${session.title}」`,
        detail: `${session.questionCount} 个问题`,
      });
    }
  }
  for (const run of runs) {
    events.push({
      id: `run-${run.id}`,
      time: run.createdAt,
      title: `自动任务「${run.nameSnapshot}」${RUN_STATUS_LABELS[run.status]}`,
      detail: run.trigger === 'manual' ? '手动触发' : '计划触发',
    });
  }
  return events.sort((left, right) => right.time.localeCompare(left.time));
}

/**
 * Waker Home（角色详情）：管理卡片「查看角色详情」进入。
 * 数据全部来自本地真实来源：/agents/:id（定义）、/agents/:id/home（统计与活跃度）、
 * 会话列表与自动任务运行记录；没有任何模拟数据。
 * 返回「我的 Waker」由 WakerDetailNav 统一提供，视图内不再渲染返回按钮。
 */
export function WakerHomeView({ agent, onEdit }: { agent: AgentSummary; onEdit: () => void }) {
  const [data, setData] = useState<HomeData | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<RecordsTab>('timeline');
  /** 相对时间与热力图的「现在」：随每次成功加载刷新，避免常驻定时器。 */
  const [now, setNow] = useState(() => new Date());
  const load = useCallback(async () => {
    setError('');
    try {
      const [detail, home, sessions, runs] = await Promise.all([
        fetchAgent(agent.id),
        fetchAgentHome(agent.id),
        fetchSessions(agent.id),
        fetchAutomationRuns(agent.id),
      ]);
      setData({ detail, home, sessions, runs: runs.items });
      setNow(new Date());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Waker 主页数据暂时无法读取');
    }
  }, [agent.id]);
  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  const heatmap = useMemo(
    () => (data ? buildHeatmap(data.home.activity, now) : null),
    [data, now],
  );
  const timeline = useMemo(
    () => (data ? buildTimeline(data.sessions, data.runs) : []),
    [data],
  );
  const sessionsByRecency = useMemo(
    () =>
      data
        ? [...data.sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        : [],
    [data],
  );
  const tenure = tenureDays(data?.home.createdAt ?? null, now);

  return (
    <section className="legacy-page waker-home" aria-labelledby="waker-home-title">
      <motion.div
        className="waker-home-body"
        initial={{ opacity: 0, y: 2 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.15, ease: MOTION_EASE }}
      >
        <section className="waker-home-profile" aria-label="角色资料">
          <AgentChip
            mark={agent.mark}
            className="large"
            agentId={agent.id}
            hasAvatar={agent.hasAvatar}
          />
          <div className="waker-home-profile-main">
            <h1 id="waker-home-title">
              {agent.name}
              {agent.tagline && <span className="waker-card-role">{agent.tagline}</span>}
            </h1>
            <p className="waker-home-meta">
              <span className="status-dot">在线</span>
              <span>ID: {agent.id}</span>
              {data?.home.createdAt && <span>入职时间：{formatHireDate(data.home.createdAt)}</span>}
            </p>
            <p className="waker-home-description">{agent.description}</p>
          </div>
          <button type="button" className="legacy-button" onClick={onEdit}>
            <SlidersHorizontal size={14} aria-hidden="true" />
            编辑
          </button>
        </section>

        {error ? (
          <div className="legacy-error" role="alert">
            <strong>加载失败</strong>
            <p>{error}</p>
            <button type="button" className="legacy-button" onClick={() => void load()}>
              重试
            </button>
          </div>
        ) : !data || !heatmap ? (
          <div className="loading-rows" aria-label="正在加载" aria-busy="true">
            <i />
            <i />
            <i />
          </div>
        ) : (
          <>
            <section className="waker-home-section" aria-labelledby="waker-home-records-title">
              <div className="waker-home-records-head">
                <h2 id="waker-home-records-title">工作记录</h2>
                <div className="waker-home-record-toggles" role="group" aria-label="工作记录视图">
                  <button
                    type="button"
                    aria-pressed={tab === 'timeline'}
                    onClick={() => setTab('timeline')}
                  >
                    时间线视图
                  </button>
                  <button
                    type="button"
                    aria-pressed={tab === 'sessions'}
                    onClick={() => setTab('sessions')}
                  >
                    对话任务
                  </button>
                  <button
                    type="button"
                    aria-pressed={tab === 'automations'}
                    onClick={() => setTab('automations')}
                  >
                    自动任务
                  </button>
                </div>
              </div>
              <dl className="waker-home-stats">
                <div>
                  <dt>入职天数</dt>
                  <dd>{tenure === null ? '—' : `${tenure} 天`}</dd>
                </div>
                <div>
                  <dt>对话任务</dt>
                  <dd>{data.home.counts.sessions}</dd>
                </div>
                <div>
                  <dt>自动任务</dt>
                  <dd>{data.home.counts.automations}</dd>
                </div>
                <div>
                  <dt>已创建的项目</dt>
                  <dd>{data.home.counts.projects}</dd>
                </div>
              </dl>
              {tab === 'timeline' ? (
                timeline.length ? (
                  <div className="timeline-list">
                    {timeline.map((event) => (
                      <div key={event.id}>
                        <span>
                          <strong>{event.title}</strong>
                          <small>{event.detail}</small>
                        </span>
                        <small>{formatRelativeTime(event.time, now)}</small>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="legacy-empty">
                    <h2>暂无工作记录</h2>
                    <p>发起对话任务或自动任务后，动态会显示在这里。</p>
                  </div>
                )
              ) : tab === 'sessions' ? (
                sessionsByRecency.length ? (
                  <div className="waker-home-task-list">
                    {sessionsByRecency.map((session) => (
                      <div className="waker-home-task-row" key={session.id}>
                        <strong>{session.title}</strong>
                        <small>
                          {formatRelativeTime(session.updatedAt, now)} · {session.questionCount}{' '}
                          个问题
                        </small>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="legacy-empty">
                    <h2>暂无对话任务</h2>
                    <p>与该 Waker 发起一轮对话后即会出现在这里。</p>
                  </div>
                )
              ) : data.runs.length ? (
                <div className="waker-home-task-list">
                  {data.runs.map((run) => (
                    <div className="waker-home-task-row" key={run.id}>
                      <strong>{run.nameSnapshot}</strong>
                      <small>
                        {run.trigger === 'manual' ? '手动触发' : '计划触发'} ·{' '}
                        {RUN_STATUS_LABELS[run.status]} · {formatRelativeTime(run.createdAt, now)}
                      </small>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="legacy-empty">
                  <h2>暂无自动任务</h2>
                  <p>创建自动任务并运行后，记录会显示在这里。</p>
                </div>
              )}
            </section>

            <section className="waker-home-section" aria-labelledby="waker-home-heatmap-title">
              <h2 id="waker-home-heatmap-title">活跃度热力图</h2>
              <div className="waker-home-heatmap">
                <div
                  className="waker-home-heatmap-months"
                  style={{ gridTemplateColumns: `repeat(${heatmap.weeks.length}, 1fr)` }}
                >
                  {heatmap.months.map((month) => (
                    <span key={month.index} style={{ gridColumnStart: month.index + 1 }}>
                      {month.label}
                    </span>
                  ))}
                </div>
                <div className="waker-home-heatmap-body">
                  <div className="waker-home-heatmap-weekdays" aria-hidden="true">
                    <span>周一</span>
                    <span />
                    <span>周三</span>
                    <span />
                    <span>周五</span>
                    <span />
                    <span />
                  </div>
                  <div className="waker-home-heatmap-grid" role="group" aria-label="每日工作量">
                    {heatmap.weeks.flatMap((week, weekIndex) =>
                      week.map((day, dayIndex) =>
                        day ? (
                          <span
                            key={day.date}
                            className={cx(
                              'waker-home-heatmap-cell',
                              `level-${activityLevel(day.count)}`,
                            )}
                            aria-label={`${day.date}, 每日工作量：${day.count}`}
                            title={`${day.date}, 每日工作量：${day.count}`}
                          />
                        ) : (
                          <span
                            key={`future-${weekIndex}-${dayIndex}`}
                            className="waker-home-heatmap-cell placeholder"
                            aria-hidden="true"
                          />
                        ),
                      ),
                    )}
                  </div>
                </div>
              </div>
            </section>

            <section className="waker-home-section" aria-labelledby="waker-home-about-title">
              <h2 id="waker-home-about-title">关于我</h2>
              <div className="waker-home-about-block">
                <h3>简介</h3>
                <p>{data.detail.description}</p>
              </div>
              {data.detail.strengths?.length ? (
                <div className="waker-home-about-block">
                  <h3>我最擅长</h3>
                  <div className="waker-home-about-items">
                    {data.detail.strengths.map((item) => (
                      <div key={item.title}>
                        <strong>{item.title}</strong>
                        <p>{item.text}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {data.detail.workStyles?.length ? (
                <div className="waker-home-about-block">
                  <h3>工作风格</h3>
                  <div className="waker-home-about-items">
                    {data.detail.workStyles.map((item) => (
                      <div key={item.title}>
                        <strong>{item.title}</strong>
                        <p>{item.text}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {data.detail.suggestions.length ? (
                <div className="waker-home-about-block">
                  <h3>建议问题</h3>
                  <div className="waker-home-suggestions">
                    {data.detail.suggestions.map((suggestion) => (
                      <span key={suggestion}>{suggestion}</span>
                    ))}
                  </div>
                </div>
              ) : null}
            </section>
          </>
        )}
      </motion.div>
    </section>
  );
}
