import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type {
  AutomationRunRecord,
  WakerAutomation,
  WakerWorkflow,
  WorkflowRunEventRecord,
  WorkflowRunRecord,
} from '@waker/contracts';
import { Play } from '@phosphor-icons/react/dist/icons/Play';
import {
  automationAction,
  appendWorkflowEvent,
  fetchAutomationRuns,
  fetchLocalResources,
  fetchWorkflowRuns,
  fetchWorkflowTrace,
  runAutomation,
  runWorkflow,
  workflowRunAction,
} from '../lib/api.js';
import { cx } from '../lib/cx.js';

export function AutomationManager({
  wakerId,
  notify,
}: {
  wakerId: string;
  notify: (text: string) => void;
}) {
  const [items, setItems] = useState<WakerAutomation[] | null>(null);
  const [runs, setRuns] = useState<AutomationRunRecord[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const load = useCallback(async () => {
    try {
      const [resources, history] = await Promise.all([
        fetchLocalResources(wakerId),
        fetchAutomationRuns(wakerId),
      ]);
      setItems(resources.automations);
      setRuns(history);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '自动任务加载失败');
    }
  }, [wakerId]);
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (item: WakerAutomation, action: 'pause' | 'resume' | 'run') => {
    setBusy(`${item.id}:${action}`);
    try {
      if (action === 'run') await runAutomation(item.id, wakerId);
      else await automationAction(item.id, action, wakerId);
      await load();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '操作失败');
    } finally {
      setBusy('');
    }
  };
  return (
    <section className="legacy-subsection">
      <div className="section-heading">
        <div>
          <h2>自动任务</h2>
          <p>暂停、恢复、立即运行并检查本地执行历史。</p>
        </div>
      </div>
      {error ? (
        <div className="legacy-error">
          <p>{error}</p>
          <button className="legacy-button" onClick={() => void load()}>
            重试
          </button>
        </div>
      ) : !items ? (
        <div className="loading-rows">
          <i />
          <i />
        </div>
      ) : items.length ? (
        <div className="automation-grid">
          {items.map((item) => (
            <article className="automation-card" key={item.id}>
              <div>
                <h3>{item.name}</h3>
                <span className={cx('resource-status', item.enabled ? 'ready' : '')}>
                  {item.enabled ? 'enabled' : 'paused'}
                </span>
              </div>
              <p>
                {item.kind}
                {item.schedule ? ` · ${item.schedule}` : ''}
              </p>
              <dl>
                <dt>下次运行</dt>
                <dd>{item.nextRunAt ? new Date(item.nextRunAt).toLocaleString() : '未安排'}</dd>
                <dt>最近运行</dt>
                <dd>{item.lastRunAt ? new Date(item.lastRunAt).toLocaleString() : '尚未运行'}</dd>
              </dl>
              <div className="page-actions">
                <button
                  className="legacy-button"
                  disabled={Boolean(busy)}
                  onClick={() => void act(item, item.enabled ? 'pause' : 'resume')}
                >
                  {item.enabled ? '暂停' : '恢复'}
                </button>
                <button
                  className="legacy-button primary"
                  disabled={Boolean(busy) || !item.enabled}
                  onClick={() => void act(item, 'run')}
                >
                  <Play size={14} />
                  运行
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="outputs-empty">还没有自动任务，可从 Waker 卡片创建。</p>
      )}
      <RunTable title="运行历史" runs={runs} />
    </section>
  );
}

export function WorkflowManager({
  wakerId,
  notify,
}: {
  wakerId: string;
  notify: (text: string) => void;
}) {
  const [items, setItems] = useState<WakerWorkflow[] | null>(null);
  const [selected, setSelected] = useState('');
  const [runs, setRuns] = useState<WorkflowRunRecord[]>([]);
  const [trace, setTrace] = useState<WorkflowRunEventRecord[]>([]);
  const [name, setName] = useState('');
  const [script, setScript] = useState('');
  const [eventType, setEventType] = useState('note');
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const resources = await fetchLocalResources(wakerId);
      setItems(resources.workflows);
      setSelected((current) => current || resources.workflows[0]?.id || '');
      setRuns(await fetchWorkflowRuns());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '工作流加载失败');
    }
  }, [wakerId]);
  useEffect(() => {
    void load();
  }, [load]);
  const activeRun = runs.find(
    (run) =>
      run.workflowId === selected && !['succeeded', 'failed', 'cancelled'].includes(run.status),
  );
  const runAct = async (action: 'start' | 'wait' | 'resume' | 'complete' | 'cancel') => {
    if (!activeRun) return;
    try {
      await workflowRunAction(
        activeRun.id,
        action,
        action === 'wait'
          ? { prompt: '等待本地输入' }
          : action === 'resume'
            ? { input: '继续' }
            : {},
      );
      await load();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '状态更新失败');
    }
  };
  const create = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const response = await fetch('/api/v1/workflows', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, script, status: 'active' }),
      });
      if (!response.ok) throw new Error('创建失败');
      const item = (await response.json()) as WakerWorkflow;
      setName('');
      setScript('');
      await load();
      setSelected(item.id);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '创建失败');
    }
  };
  return (
    <section className="legacy-page">
      <header className="legacy-page-header">
        <div>
          <h1>WakerFlow</h1>
          <p>创建可版本化流程并控制每次本地运行。</p>
        </div>
      </header>
      <form className="workflow-create" onSubmit={create}>
        <input
          aria-label="工作流名称"
          placeholder="工作流名称"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <textarea
          aria-label="工作流脚本"
          placeholder="流程脚本"
          value={script}
          onChange={(event) => setScript(event.target.value)}
        />
        <button className="legacy-button primary" disabled={!name.trim()}>
          创建 Active Workflow
        </button>
      </form>
      {error ? (
        <div className="legacy-error">
          <p>{error}</p>
          <button className="legacy-button" onClick={() => void load()}>
            重试
          </button>
        </div>
      ) : !items ? (
        <div className="loading-rows">
          <i />
          <i />
        </div>
      ) : (
        <>
          <div className="workflow-tabs">
            {items.map((item) => (
              <button
                className={cx(selected === item.id && 'active')}
                key={item.id}
                onClick={() => setSelected(item.id)}
              >
                {item.name}
                <small>{item.status}</small>
              </button>
            ))}
          </div>
          {selected && (
            <div className="workflow-console">
              <div className="page-actions">
                <button
                  className="legacy-button primary"
                  onClick={async () => {
                    await runWorkflow(selected);
                    await load();
                  }}
                >
                  <Play size={14} />
                  创建运行
                </button>
                {(['start', 'wait', 'resume', 'complete', 'cancel'] as const).map((action) => (
                  <button
                    key={action}
                    className="legacy-button"
                    disabled={!activeRun}
                    onClick={() => void runAct(action)}
                  >
                    {action}
                  </button>
                ))}
              </div>
              {activeRun && (
                <form
                  className="event-form"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    await appendWorkflowEvent(activeRun.id, eventType);
                    const result = await fetchWorkflowTrace(activeRun.id);
                    setTrace(result.events);
                  }}
                >
                  <input
                    aria-label="事件类型"
                    value={eventType}
                    onChange={(event) => setEventType(event.target.value)}
                  />
                  <button className="legacy-button">追加事件</button>
                  <button
                    type="button"
                    className="legacy-button"
                    onClick={async () => setTrace((await fetchWorkflowTrace(activeRun.id)).events)}
                  >
                    刷新 Trace
                  </button>
                </form>
              )}
              <RunTable title="运行记录" runs={runs.filter((run) => run.workflowId === selected)} />
              {trace.length > 0 && (
                <div className="trace-list">
                  <h3>Trace</h3>
                  {trace.map((event) => (
                    <div key={event.id}>
                      <b>
                        #{event.sequence} {event.type}
                      </b>
                      <code>{JSON.stringify(event.payload ?? null)}</code>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function RunTable({
  title,
  runs,
}: {
  title: string;
  runs: Array<AutomationRunRecord | WorkflowRunRecord>;
}) {
  return (
    <div className="run-history">
      <h3>{title}</h3>
      {runs.length ? (
        runs.map((run) => (
          <div className="resource-row" key={run.id}>
            <div>
              <strong>{run.id}</strong>
              <small>
                {new Date(run.createdAt).toLocaleString()}
                {'workflowVersion' in run ? ` · workflow v${run.workflowVersion}` : ''}
              </small>
            </div>
            <span className={cx('resource-status', run.status)}>{run.status}</span>
          </div>
        ))
      ) : (
        <p className="outputs-empty">暂无运行记录</p>
      )}
    </div>
  );
}
