import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { motion } from 'motion/react';
import {
  AGENT_THINKING_LEVELS,
  type AutomationRunRecord,
  type WakerAutomation,
  type WakerProject,
} from '@waker/contracts';
import { ArrowClockwise } from '@phosphor-icons/react/dist/icons/ArrowClockwise';
import { CaretDown } from '@phosphor-icons/react/dist/icons/CaretDown';
import { ChatCircleDots } from '@phosphor-icons/react/dist/icons/ChatCircleDots';
import { FloppyDisk } from '@phosphor-icons/react/dist/icons/FloppyDisk';
import { Pause } from '@phosphor-icons/react/dist/icons/Pause';
import { Play } from '@phosphor-icons/react/dist/icons/Play';
import { Plus } from '@phosphor-icons/react/dist/icons/Plus';
import { Trash } from '@phosphor-icons/react/dist/icons/Trash';
import { X } from '@phosphor-icons/react/dist/icons/X';
import {
  automationAction,
  automationRunAction,
  createLocalResource,
  deleteAutomation,
  fetchAutomationRuns,
  fetchAutomationDeleteImpact,
  fetchLocalResources,
  fetchWorkspace,
  runAutomation,
  updateAutomation,
  type AutomationDeleteImpact,
} from '../lib/api.js';
import { cx } from '../lib/cx.js';
import { useVisiblePolling } from '../hooks/useVisiblePolling.js';
import { useDialogFocus } from '../hooks/useDialogFocus.js';
import { MotionLoadingRows } from './MotionFeedback.js';
import {
  MOTION_DIALOG_BACKDROP,
  MOTION_DIALOG_SURFACE,
  MOTION_TRANSITION,
} from '../lib/motion.js';

type AutomationEditor = {
  id?: string;
  name: string;
  kind: WakerAutomation['kind'];
  schedule: string;
  prompt: string;
  timezone: string;
  startAt: string;
  endAt: string;
  maxRuns: string;
  misfirePolicy: WakerAutomation['misfirePolicy'];
  repo: string;
  branch: string;
  pollIntervalSeconds: string;
  projectId: string;
  model: string;
  thinking: string;
};

const EMPTY_EDITOR: AutomationEditor = {
  name: '',
  kind: 'schedule',
  schedule: 'interval:3600000',
  prompt: '',
  timezone: 'UTC',
  startAt: '',
  endAt: '',
  maxRuns: '',
  misfirePolicy: 'run_once',
  repo: '',
  branch: '',
  pollIntervalSeconds: '60',
  projectId: '',
  model: '',
  thinking: '',
};

const RUN_STATUS: Record<AutomationRunRecord['status'], string> = {
  queued: '排队中',
  running: '运行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  skipped: '已跳过',
};

const RUN_TRIGGER: Record<AutomationRunRecord['trigger'], string> = {
  manual: '手动',
  scheduled: '计划',
  api: 'API',
  event: '事件',
  git: 'Git',
};

function editorFor(item: WakerAutomation): AutomationEditor {
  return {
    id: item.id,
    name: item.name,
    kind: item.kind,
    schedule: item.schedule ?? '',
    prompt: item.prompt,
    timezone: item.timezone,
    startAt: item.startAt ? localInputForIso(item.startAt) : '',
    endAt: item.endAt ? localInputForIso(item.endAt) : '',
    maxRuns: item.maxRuns?.toString() ?? '',
    misfirePolicy: item.misfirePolicy,
    repo: item.repo ?? '',
    branch: item.branch ?? '',
    pollIntervalSeconds: item.pollIntervalSeconds?.toString() ?? '60',
    projectId: item.projectId ?? '',
    model: item.model ?? '',
    thinking: item.thinking ?? '',
  };
}

function formatDate(value?: string): string {
  return value
    ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(value),
      )
    : '—';
}

export function localInputForIso(value: string): string {
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function isoForLocalInput(value: string): string | null {
  return value ? new Date(value).toISOString() : null;
}

export function formatRunDuration(run: AutomationRunRecord, now = Date.now()): string {
  if (!run.startedAt) return '—';
  const duration = Math.max(
    0,
    (run.completedAt ? Date.parse(run.completedAt) : now) - Date.parse(run.startedAt),
  );
  if (duration < 1_000) return `${duration}ms`;
  const seconds = Math.floor(duration / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function visibleValue(value: unknown): string {
  if (value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > 4_000 ? `${text.slice(0, 4_000)}\n…已截断` : text;
}

type EditorError = { field: keyof AutomationEditor; message: string };

function editorErrors(editor: AutomationEditor): EditorError[] {
  const errors: EditorError[] = [];
  if (!editor.name.trim()) errors.push({ field: 'name', message: '请输入任务名称' });
  if (!editor.prompt.trim()) errors.push({ field: 'prompt', message: '请输入执行提示' });
  if (editor.kind === 'schedule' && !editor.timezone.trim())
    errors.push({ field: 'timezone', message: '请输入 IANA 时区' });
  if (editor.kind === 'schedule' && !editor.schedule.trim())
    errors.push({ field: 'schedule', message: '请输入计划表达式' });
  if (editor.kind === 'schedule' && editor.maxRuns) {
    const value = Number(editor.maxRuns);
    if (!Number.isSafeInteger(value) || value <= 0)
      errors.push({ field: 'maxRuns', message: '最多运行次数必须是正整数' });
  }
  if (editor.kind === 'schedule' && editor.startAt && editor.endAt && editor.endAt < editor.startAt)
    errors.push({ field: 'endAt', message: '结束时间不能早于开始时间' });
  if (editor.kind === 'git-poll' && !editor.repo.trim())
    errors.push({ field: 'repo', message: '请输入 git 仓库（本地路径或 URL）' });
  if (editor.kind === 'git-poll' && editor.pollIntervalSeconds) {
    const value = Number(editor.pollIntervalSeconds);
    if (!Number.isSafeInteger(value) || value < 15)
      errors.push({ field: 'pollIntervalSeconds', message: '轮询间隔必须是不小于 15 的整数秒' });
  }
  return errors;
}

function runSessionId(run: AutomationRunRecord): string | undefined {
  return run.sessionId;
}

function automationState(item: WakerAutomation): string {
  return item.lifecycle === 'completed' ? '已完成' : item.enabled ? '已启用' : '已暂停';
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'AbortError';
}

export function AutomationManager({
  wakerId,
  notify,
  onOpenSession,
  initialAutomationId,
}: {
  wakerId: string;
  notify: (text: string) => void;
  onOpenSession?: (sessionId: string) => void;
  initialAutomationId?: string;
}) {
  const [items, setItems] = useState<WakerAutomation[] | null>(null);
  const [runs, setRuns] = useState<AutomationRunRecord[]>([]);
  const [runTotal, setRunTotal] = useState(0);
  const [historyLimit, setHistoryLimit] = useState(20);
  const [projects, setProjects] = useState<WakerProject[]>([]);
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedId, setSelectedId] = useState(initialAutomationId ?? '');
  const [editor, setEditor] = useState<AutomationEditor | null>(null);
  const [error, setError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [lastUpdatedAt, setLastUpdatedAt] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<WakerAutomation | null>(null);
  const [deleteImpact, setDeleteImpact] = useState<AutomationDeleteImpact | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const loadGenerationRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const hasSnapshotRef = useRef(false);
  const newButtonRef = useRef<HTMLButtonElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const editorTriggerRef = useRef<HTMLButtonElement | null>(null);
  const editorReturnTargetRef = useRef<'new' | 'edit'>('new');
  const closeDelete = useCallback(() => {
    if (!busy.startsWith('delete:')) setDeleteTarget(null);
  }, [busy]);
  const deleteDialogRef = useDialogFocus<HTMLDivElement>(Boolean(deleteTarget), closeDelete);

  const openEditor = (
    nextEditor: AutomationEditor,
    trigger: HTMLButtonElement,
    returnTarget: 'new' | 'edit',
  ) => {
    editorTriggerRef.current = trigger;
    editorReturnTargetRef.current = returnTarget;
    setActionError('');
    setEditor(nextEditor);
  };
  const closeEditor = useCallback(() => {
    setEditor(null);
    requestAnimationFrame(() => {
      if (editorReturnTargetRef.current === 'edit' && editButtonRef.current) {
        editButtonRef.current.focus();
        return;
      }
      const trigger = editorTriggerRef.current;
      if (trigger?.isConnected) trigger.focus();
      else newButtonRef.current?.focus();
    });
  }, []);

  const load = useCallback(
    async (background = false) => {
      const generation = ++loadGenerationRef.current;
      loadAbortRef.current?.abort();
      const controller = new AbortController();
      loadAbortRef.current = controller;
      if (!background) setError('');
      try {
        const [resources, workspace] = await Promise.all([
          fetchLocalResources(wakerId, controller.signal),
          fetchWorkspace(controller.signal),
        ]);
        const nextSelectedId = resources.automations.some((item) => item.id === selectedId)
          ? selectedId
          : (resources.automations[0]?.id ?? '');
        const history = nextSelectedId
          ? await fetchAutomationRuns(wakerId, nextSelectedId, historyLimit, controller.signal)
          : { items: [], total: 0 };
        if (generation !== loadGenerationRef.current) return;
        setItems(resources.automations);
        setRuns(history.items);
        setRunTotal(history.total);
        setProjects(resources.projects.filter((project) => project.wakerId === wakerId));
        setModels(workspace.models.available);
        setSelectedId(nextSelectedId);
        hasSnapshotRef.current = true;
        setError('');
        setRefreshError('');
        setLastUpdatedAt(new Date().toISOString());
      } catch (cause) {
        if (generation !== loadGenerationRef.current || isAbortError(cause)) return;
        const message = cause instanceof Error ? cause.message : '自动任务加载失败';
        if (background && hasSnapshotRef.current) setRefreshError(message);
        else setError(message);
      }
    },
    [historyLimit, selectedId, wakerId],
  );

  useEffect(() => {
    setItems(null);
    setRuns([]);
    setRunTotal(0);
    setHistoryLimit(20);
    setProjects([]);
    setModels([]);
    setSelectedId(initialAutomationId ?? '');
    setEditor(null);
    setDeleteTarget(null);
    setError('');
    setRefreshError('');
    setLastUpdatedAt('');
    hasSnapshotRef.current = false;
  }, [initialAutomationId, wakerId]);
  useEffect(
    () => () => {
      loadGenerationRef.current += 1;
      loadAbortRef.current?.abort();
    },
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useVisiblePolling(() => void load(true), 5_000);

  const selected = items?.find((item) => item.id === selectedId) ?? null;
  const selectedRuns = useMemo(
    () => runs.filter((run) => run.automationId === selectedId),
    [runs, selectedId],
  );

  const perform = async (key: string, action: () => Promise<unknown>, success: string) => {
    setBusy(key);
    setActionError('');
    try {
      await action();
      await load();
      notify(success);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '操作失败';
      setActionError(message);
      notify(message);
    } finally {
      setBusy('');
    }
  };

  const submitEditor = async (event: FormEvent) => {
    event.preventDefault();
    if (!editor) return;
    const name = editor.name.trim();
    const prompt = editor.prompt.trim();
    const maxRuns = editor.maxRuns ? Number(editor.maxRuns) : null;
    if (editorErrors(editor).length) return;
    const configuration = {
      timezone: editor.timezone.trim() || 'UTC',
      startAt: isoForLocalInput(editor.startAt),
      endAt: isoForLocalInput(editor.endAt),
      maxRuns,
      misfirePolicy: editor.misfirePolicy,
      projectId: editor.projectId || null,
      model: editor.model || null,
      thinking: (editor.thinking || null) as (typeof AGENT_THINKING_LEVELS)[number] | null,
    };
    const gitPollConfiguration: Partial<WakerAutomation> =
      editor.kind === 'git-poll'
        ? {
            repo: editor.repo.trim(),
            ...(editor.branch.trim() ? { branch: editor.branch.trim() } : {}),
            ...(editor.pollIntervalSeconds
              ? { pollIntervalSeconds: Number(editor.pollIntervalSeconds) }
              : {}),
          }
        : {};
    const createConfiguration: Partial<WakerAutomation> = {
      timezone: configuration.timezone,
      misfirePolicy: configuration.misfirePolicy,
      ...(configuration.startAt ? { startAt: configuration.startAt } : {}),
      ...(configuration.endAt ? { endAt: configuration.endAt } : {}),
      ...(configuration.maxRuns ? { maxRuns: configuration.maxRuns } : {}),
      ...(configuration.projectId ? { projectId: configuration.projectId } : {}),
      ...(configuration.model ? { model: configuration.model } : {}),
      ...(configuration.thinking ? { thinking: configuration.thinking } : {}),
    };
    let createdId = '';
    await perform(
      `save:${editor.id ?? 'new'}`,
      async () => {
        if (editor.id) {
          await updateAutomation(editor.id, wakerId, {
            name,
            prompt,
            ...configuration,
            ...gitPollConfiguration,
            ...(editor.kind === 'schedule' ? { schedule: editor.schedule.trim() } : {}),
          });
          closeEditor();
        } else {
          const created = await createLocalResource<WakerAutomation>('automations', {
            wakerId,
            name,
            kind: editor.kind,
            prompt,
            ...createConfiguration,
            ...gitPollConfiguration,
            ...(editor.kind === 'schedule' ? { schedule: editor.schedule.trim() } : {}),
          });
          createdId = created.id;
          closeEditor();
        }
      },
      editor.id ? '自动任务已保存' : '自动任务已创建',
    );
    if (createdId) setSelectedId(createdId);
  };

  const inspectDelete = async (item: WakerAutomation) => {
    setDeleteTarget(item);
    setDeleteImpact(null);
    setDeleteError('');
    try {
      setDeleteImpact(await fetchAutomationDeleteImpact(item.id, wakerId));
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : '删除影响暂时无法读取');
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget || !deleteImpact) return;
    const target = deleteTarget;
    setBusy(`delete:${target.id}`);
    setDeleteError('');
    try {
      await deleteAutomation(target.id, wakerId);
      setDeleteTarget(null);
      setSelectedId('');
      await load();
      notify('自动任务已删除，历史运行保留');
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : '自动任务暂时无法删除');
    } finally {
      setBusy('');
    }
  };

  return (
    <section className="legacy-subsection automation-manager" aria-labelledby="automations-title">
      <div className="section-heading">
        <div>
          <h2 id="automations-title">自动任务</h2>
          <p>编辑触发条件、手动运行，并检查每次本地执行的可恢复记录。</p>
        </div>
        <button
          ref={newButtonRef}
          className="legacy-button primary"
          type="button"
          onClick={(event) => openEditor({ ...EMPTY_EDITOR }, event.currentTarget, 'new')}
        >
          <Plus size={15} />
          新建自动任务
        </button>
      </div>

      {refreshError ? (
        <div className="automation-refresh-warning" role="status">
          <span>
            自动刷新失败，当前仍显示上次数据
            {lastUpdatedAt ? `（${formatDate(lastUpdatedAt)}）` : ''}：{refreshError}
          </span>
          <button className="legacy-button" type="button" onClick={() => void load(true)}>
            <ArrowClockwise size={14} />
            重试刷新
          </button>
        </div>
      ) : lastUpdatedAt ? (
        <p className="automation-refresh-meta">上次更新 {formatDate(lastUpdatedAt)}</p>
      ) : null}

      {error ? (
        <div className="legacy-error" role="alert">
          <p>{error}</p>
          <button className="legacy-button" type="button" onClick={() => void load()}>
            <ArrowClockwise size={14} />
            重试
          </button>
        </div>
      ) : items === null ? (
        <MotionLoadingRows count={2} label="正在加载自动任务" />
      ) : items.length === 0 && !editor ? (
        <div className="automation-empty">
          <h3>还没有自动任务</h3>
          <p>创建一条计划、API 或事件触发任务，所有运行记录都保存在本地。</p>
          <button
            className="legacy-button primary"
            type="button"
            onClick={(event) => openEditor({ ...EMPTY_EDITOR }, event.currentTarget, 'new')}
          >
            <Plus size={15} />
            创建第一条任务
          </button>
        </div>
      ) : (
        <div className="automation-workspace">
          <nav className="automation-list" aria-label="自动任务列表">
            {items.map((item) => (
              <motion.button
                className={cx(selectedId === item.id && 'active')}
                type="button"
                key={item.id}
                aria-current={selectedId === item.id ? 'true' : undefined}
                onClick={() => {
                  setSelectedId(item.id);
                  setHistoryLimit(20);
                  setEditor(null);
                  setActionError('');
                }}
                layout="position"
                whileTap={{ scale: 0.985 }}
              >
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.schedule || item.kind}</small>
                </span>
                <span className={cx('resource-status', item.enabled ? 'ready' : '')}>
                  {automationState(item)}
                </span>
              </motion.button>
            ))}
          </nav>

          <div className="automation-detail">
            <motion.div
              className="master-detail-content"
              key={editor ? `editor:${editor.id ?? 'new'}` : `detail:${selected?.id ?? 'none'}`}
              initial={{ opacity: 0, x: 6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={MOTION_TRANSITION.routine}
            >
            {editor ? (
              <>
                {actionError && (
                  <p className="automation-action-error" role="alert">
                    {actionError}
                  </p>
                )}
                <AutomationEditorForm
                  editor={editor}
                  busy={busy.startsWith('save:')}
                  projects={projects}
                  models={models}
                  onChange={setEditor}
                  onCancel={closeEditor}
                  onSubmit={submitEditor}
                />
              </>
            ) : selected ? (
              <>
                <header className="automation-detail-header">
                  <div>
                    <div className="automation-title-line">
                      <h3>{selected.name}</h3>
                      <span className={cx('resource-status', selected.enabled ? 'ready' : '')}>
                        {automationState(selected)}
                      </span>
                    </div>
                    <p>{selected.prompt}</p>
                  </div>
                  <div className="page-actions">
                    <button
                      ref={editButtonRef}
                      className="legacy-button"
                      type="button"
                      onClick={(event) =>
                        openEditor(editorFor(selected), event.currentTarget, 'edit')
                      }
                    >
                      编辑
                    </button>
                    <button
                      className="legacy-button danger"
                      type="button"
                      onClick={() => void inspectDelete(selected)}
                    >
                      <Trash size={14} />
                      删除
                    </button>
                  </div>
                </header>

                <dl className="automation-facts">
                  <div>
                    <dt>触发方式</dt>
                    <dd>{selected.kind}</dd>
                  </div>
                  <div>
                    <dt>计划</dt>
                    <dd>
                      {selected.schedule ||
                        (selected.kind === 'git-poll' ? '新 commit 触发' : '由外部触发')}
                    </dd>
                  </div>
                  <div>
                    <dt>下次运行</dt>
                    <dd>{selected.nextRunAt ? formatDate(selected.nextRunAt) : '未安排'}</dd>
                  </div>
                  <div>
                    <dt>最近运行</dt>
                    <dd>{selected.lastRunAt ? formatDate(selected.lastRunAt) : '尚未运行'}</dd>
                  </div>
                  <div>
                    <dt>时区</dt>
                    <dd>{selected.timezone}</dd>
                  </div>
                  <div>
                    <dt>运行次数</dt>
                    <dd>
                      {selected.runCount}
                      {selected.maxRuns ? ` / ${selected.maxRuns}` : ''}
                    </dd>
                  </div>
                  <div>
                    <dt>误过计划</dt>
                    <dd>{selected.misfirePolicy === 'skip' ? '跳过' : '补跑一次'}</dd>
                  </div>
                  <div>
                    <dt>会话配置</dt>
                    <dd>
                      {[selected.projectId, selected.model, selected.thinking]
                        .filter(Boolean)
                        .join(' · ') || '跟随 Waker 默认值'}
                    </dd>
                  </div>
                </dl>

                {(selected.kind === 'api' || selected.kind === 'event') && (
                  <div className="automation-trigger-note">
                    <p>
                      入站触发{' '}
                      <code>
                        POST /api/v1/automations/{selected.id}/
                        {selected.kind === 'api' ? 'invoke' : 'webhook'}
                      </code>
                    </p>
                    <p>
                      触发令牌 <code>{selected.triggerKey ?? '生成中…'}</code>
                      {selected.kind === 'api'
                        ? '，通过 x-api-trigger-key 头（或 Bearer）携带'
                        : '，通过 ?key= 查询参数（或 x-api-trigger-key 头）携带'}
                    </p>
                    <p>
                      <button
                        className="legacy-button"
                        type="button"
                        disabled={Boolean(busy)}
                        onClick={() =>
                          void perform(
                            `${selected.id}:rotate`,
                            () => automationAction(selected.id, 'rotate-trigger-key', wakerId),
                            '触发令牌已重新生成',
                          )
                        }
                      >
                        <ArrowClockwise size={14} />
                        {busy === `${selected.id}:rotate` ? '正在生成…' : '重新生成令牌'}
                      </button>
                    </p>
                  </div>
                )}

                {selected.kind === 'git-poll' && (
                  <div className="automation-trigger-note">
                    <p>
                      Git 轮询 <code>{selected.repo}</code> 的分支{' '}
                      <code>{selected.branch || '默认分支 / HEAD'}</code>，每{' '}
                      {selected.pollIntervalSeconds ?? 60} 秒检查一次头 commit。
                    </p>
                    <p>
                      上次观测 commit <code>{selected.lastSeenCommit ?? '尚未轮询（首次轮询只落基线）'}</code>
                    </p>
                  </div>
                )}

                {actionError && (
                  <p className="automation-action-error" role="alert">
                    {actionError}
                  </p>
                )}
                <div className="page-actions automation-primary-actions">
                  <button
                    className="legacy-button"
                    type="button"
                    disabled={Boolean(busy) || selected.lifecycle === 'completed'}
                    onClick={() =>
                      void perform(
                        `${selected.id}:toggle`,
                        () =>
                          automationAction(
                            selected.id,
                            selected.enabled ? 'pause' : 'resume',
                            wakerId,
                          ),
                        selected.enabled ? '自动任务已暂停' : '自动任务已恢复',
                      )
                    }
                  >
                    {selected.enabled ? <Pause size={14} /> : <Play size={14} />}
                    {selected.lifecycle === 'completed'
                      ? '已完成'
                      : busy === `${selected.id}:toggle`
                        ? '正在更新…'
                        : selected.enabled
                          ? '暂停'
                          : '恢复'}
                  </button>
                  <button
                    className="legacy-button primary"
                    type="button"
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void perform(
                        `${selected.id}:run`,
                        () => runAutomation(selected.id, wakerId),
                        '已提交手动运行',
                      )
                    }
                  >
                    <Play size={14} />
                    {busy === `${selected.id}:run` ? '正在提交…' : '立即运行'}
                  </button>
                </div>

                <AutomationRunHistory
                  runs={selectedRuns}
                  total={runTotal}
                  busy={busy}
                  onCancel={(run) =>
                    void perform(
                      `${run.id}:cancel`,
                      () => automationRunAction(run.id, 'cancel', wakerId),
                      '运行已取消',
                    )
                  }
                  onRetry={(run) =>
                    void perform(
                      `${run.id}:retry`,
                      () => automationRunAction(run.id, 'retry', wakerId),
                      '已创建新的重试运行',
                    )
                  }
                  onOpenSession={onOpenSession}
                  onLoadMore={() => setHistoryLimit((value) => Math.min(value + 20, 200))}
                />
              </>
            ) : null}
            </motion.div>
          </div>
        </div>
      )}
      {deleteTarget && (
        <motion.div
          className="modal-backdrop"
          onMouseDown={closeDelete}
          {...MOTION_DIALOG_BACKDROP}
        >
          <motion.div
            ref={deleteDialogRef}
            className="automation-delete-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="automation-delete-title"
            tabIndex={-1}
            onMouseDown={(event) => event.stopPropagation()}
            {...MOTION_DIALOG_SURFACE}
          >
            <h2 id="automation-delete-title">删除“{deleteTarget.name}”？</h2>
            <p>任务定义将停用并从列表移除；关联任务和会话仍可从各自入口查看。</p>
            {deleteError ? (
              <div className="automation-action-error" role="alert">
                {deleteError}
                <button
                  className="legacy-button"
                  type="button"
                  onClick={() => void inspectDelete(deleteTarget)}
                >
                  重新检查
                </button>
              </div>
            ) : deleteImpact ? (
              <dl className="automation-delete-impact">
                <div>
                  <dt>运行</dt>
                  <dd>{deleteImpact.runs}</dd>
                </div>
                <div>
                  <dt>任务</dt>
                  <dd>{deleteImpact.tasks}</dd>
                </div>
                <div>
                  <dt>会话</dt>
                  <dd>{deleteImpact.sessions}</dd>
                </div>
              </dl>
            ) : (
              <p role="status">正在检查删除影响…</p>
            )}
            <div className="dialog-actions">
              <button
                className="legacy-button"
                type="button"
                disabled={busy.startsWith('delete:')}
                onClick={closeDelete}
              >
                取消
              </button>
              <button
                className="legacy-button danger"
                type="button"
                disabled={!deleteImpact || busy.startsWith('delete:')}
                onClick={() => void confirmDelete()}
              >
                <Trash size={14} />
                {busy.startsWith('delete:') ? '正在删除…' : '删除任务'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </section>
  );
}

function AutomationEditorForm({
  editor,
  busy,
  projects,
  models,
  onChange,
  onCancel,
  onSubmit,
}: {
  editor: AutomationEditor;
  busy: boolean;
  projects: WakerProject[];
  models: Array<{ id: string; name: string }>;
  onChange: (editor: AutomationEditor) => void;
  onCancel: () => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const errors = editorErrors(editor);
  const valid = errors.length === 0;
  const [submitted, setSubmitted] = useState(false);
  const [touched, setTouched] = useState<Set<keyof AutomationEditor>>(() => new Set());
  const fieldError = (field: keyof AutomationEditor) =>
    errors.find((error) => error.field === field)?.message;
  const showFieldError = (field: keyof AutomationEditor) =>
    Boolean(fieldError(field) && (submitted || touched.has(field)));
  const touch = (field: keyof AutomationEditor) =>
    setTouched((current) => new Set(current).add(field));
  const describedBy = (field: keyof AutomationEditor, hint?: string) =>
    [hint, showFieldError(field) ? `automation-${field}-error` : undefined]
      .filter(Boolean)
      .join(' ') || undefined;
  return (
    <form
      className="automation-editor"
      noValidate
      onSubmit={(event) => {
        if (valid) onSubmit(event);
        else {
          event.preventDefault();
          setSubmitted(true);
        }
      }}
    >
      <div className="automation-editor-heading">
        <div>
          <h3>{editor.id ? '编辑自动任务' : '新建自动任务'}</h3>
          <p>配置保存后即写入当前 Waker 的本地数据库。</p>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="关闭编辑器"
          disabled={busy}
          onClick={onCancel}
        >
          <X size={16} />
        </button>
      </div>
      <label>
        名称
        <input
          autoFocus
          required
          maxLength={160}
          value={editor.name}
          aria-invalid={showFieldError('name')}
          aria-describedby={describedBy('name')}
          onBlur={() => touch('name')}
          onChange={(event) => onChange({ ...editor, name: event.target.value })}
        />
        {showFieldError('name') && (
          <small id="automation-name-error" className="automation-field-error">
            {fieldError('name')}
          </small>
        )}
      </label>
      <label>
        触发方式
        <select
          value={editor.kind}
          disabled={Boolean(editor.id)}
          aria-describedby={editor.id ? 'automation-kind-hint' : undefined}
          onChange={(event) => {
            const kind = event.target.value as WakerAutomation['kind'];
            onChange({
              ...editor,
              kind,
              ...(kind === 'schedule' ? {} : { schedule: '', startAt: '', endAt: '', maxRuns: '' }),
            });
          }}
        >
          <option value="schedule">计划</option>
          <option value="api">API</option>
          <option value="event">事件</option>
          <option value="git-poll">Git 轮询</option>
        </select>
      </label>
      {editor.id && <small id="automation-kind-hint">触发方式创建后不可更改。</small>}
      {editor.kind === 'schedule' && (
        <div className="automation-schedule-fields">
          <label>
            计划表达式
            <input
              required
              maxLength={240}
              spellCheck={false}
              value={editor.schedule}
              aria-invalid={showFieldError('schedule')}
              aria-describedby={describedBy('schedule', 'automation-schedule-hint')}
              onBlur={() => touch('schedule')}
              onChange={(event) => onChange({ ...editor, schedule: event.target.value })}
            />
            <small id="automation-schedule-hint">
              支持 5 段 Cron、interval:&lt;毫秒&gt; 或 once:&lt;epoch-ms&gt;。
            </small>
            {showFieldError('schedule') && (
              <small id="automation-schedule-error" className="automation-field-error">
                {fieldError('schedule')}
              </small>
            )}
          </label>
          <label>
            IANA 时区
            <input
              required
              maxLength={80}
              spellCheck={false}
              placeholder="Asia/Shanghai"
              value={editor.timezone}
              aria-invalid={showFieldError('timezone')}
              aria-describedby={describedBy('timezone')}
              onBlur={() => touch('timezone')}
              onChange={(event) => onChange({ ...editor, timezone: event.target.value })}
            />
            {showFieldError('timezone') && (
              <small id="automation-timezone-error" className="automation-field-error">
                {fieldError('timezone')}
              </small>
            )}
          </label>
          <label>
            开始时间（本地）
            <input
              type="datetime-local"
              value={editor.startAt}
              onChange={(event) => onChange({ ...editor, startAt: event.target.value })}
            />
          </label>
          <label>
            结束时间（本地）
            <input
              type="datetime-local"
              value={editor.endAt}
              aria-invalid={showFieldError('endAt')}
              aria-describedby={describedBy('endAt')}
              onBlur={() => touch('endAt')}
              onChange={(event) => onChange({ ...editor, endAt: event.target.value })}
            />
            {showFieldError('endAt') && (
              <small id="automation-endAt-error" className="automation-field-error">
                {fieldError('endAt')}
              </small>
            )}
          </label>
          <label>
            最多运行次数
            <input
              type="number"
              min="1"
              step="1"
              placeholder="不限"
              value={editor.maxRuns}
              aria-invalid={showFieldError('maxRuns')}
              aria-describedby={describedBy('maxRuns')}
              onBlur={() => touch('maxRuns')}
              onChange={(event) => onChange({ ...editor, maxRuns: event.target.value })}
            />
            {showFieldError('maxRuns') && (
              <small id="automation-maxRuns-error" className="automation-field-error">
                {fieldError('maxRuns')}
              </small>
            )}
          </label>
          <label>
            误过计划时
            <select
              value={editor.misfirePolicy}
              onChange={(event) =>
                onChange({
                  ...editor,
                  misfirePolicy: event.target.value as WakerAutomation['misfirePolicy'],
                })
              }
            >
              <option value="run_once">补跑一次</option>
              <option value="skip">跳过</option>
            </select>
          </label>
        </div>
      )}
      {editor.kind === 'git-poll' && (
        <div className="automation-schedule-fields">
          <label>
            Git 仓库
            <input
              required
              maxLength={4000}
              spellCheck={false}
              placeholder="/path/to/repo 或 https://github.com/org/repo.git"
              value={editor.repo}
              aria-invalid={showFieldError('repo')}
              aria-describedby={describedBy('repo', 'automation-repo-hint')}
              onBlur={() => touch('repo')}
              onChange={(event) => onChange({ ...editor, repo: event.target.value })}
            />
            <small id="automation-repo-hint">
              本地路径直接读工作区分支头；跟踪远端更新请填 git URL（ls-remote 轮询）。
            </small>
            {showFieldError('repo') && (
              <small id="automation-repo-error" className="automation-field-error">
                {fieldError('repo')}
              </small>
            )}
          </label>
          <label>
            分支
            <input
              maxLength={240}
              spellCheck={false}
              placeholder="留空跟随默认分支 / HEAD"
              value={editor.branch}
              onChange={(event) => onChange({ ...editor, branch: event.target.value })}
            />
          </label>
          <label>
            轮询间隔（秒）
            <input
              type="number"
              min="15"
              step="1"
              value={editor.pollIntervalSeconds}
              aria-invalid={showFieldError('pollIntervalSeconds')}
              aria-describedby={describedBy('pollIntervalSeconds')}
              onBlur={() => touch('pollIntervalSeconds')}
              onChange={(event) =>
                onChange({ ...editor, pollIntervalSeconds: event.target.value })
              }
            />
            {showFieldError('pollIntervalSeconds') && (
              <small id="automation-pollIntervalSeconds-error" className="automation-field-error">
                {fieldError('pollIntervalSeconds')}
              </small>
            )}
          </label>
        </div>
      )}
      <div className="automation-context-fields">
        <label>
          项目
          <select
            value={editor.projectId}
            onChange={(event) => onChange({ ...editor, projectId: event.target.value })}
          >
            <option value="">不绑定项目</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          模型
          <select
            value={editor.model}
            onChange={(event) => onChange({ ...editor, model: event.target.value })}
          >
            <option value="">使用当前默认模型（保存时固定）</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          思考强度
          <select
            value={editor.thinking}
            onChange={(event) => onChange({ ...editor, thinking: event.target.value })}
          >
            <option value="">使用当前默认强度（保存时固定）</option>
            {AGENT_THINKING_LEVELS.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        执行提示
        <textarea
          required
          maxLength={20_000}
          rows={8}
          value={editor.prompt}
          aria-invalid={showFieldError('prompt')}
          aria-describedby={describedBy('prompt')}
          onBlur={() => touch('prompt')}
          onChange={(event) => onChange({ ...editor, prompt: event.target.value })}
        />
        {showFieldError('prompt') && (
          <small id="automation-prompt-error" className="automation-field-error">
            {fieldError('prompt')}
          </small>
        )}
      </label>
      {submitted && errors.length > 0 && (
        <ul className="automation-validation" role="alert">
          {errors.map(({ field, message }) => (
            <li key={field}>{message}</li>
          ))}
        </ul>
      )}
      <div className="dialog-actions">
        <button className="legacy-button" type="button" disabled={busy} onClick={onCancel}>
          取消
        </button>
        <button className="legacy-button primary" disabled={busy}>
          <FloppyDisk size={15} />
          {busy ? '正在保存…' : '保存'}
        </button>
      </div>
    </form>
  );
}

function AutomationRunHistory({
  runs,
  total,
  busy,
  onCancel,
  onRetry,
  onOpenSession,
  onLoadMore,
}: {
  runs: AutomationRunRecord[];
  total: number;
  busy: string;
  onCancel: (run: AutomationRunRecord) => void;
  onRetry: (run: AutomationRunRecord) => void;
  onOpenSession?: (sessionId: string) => void;
  onLoadMore: () => void;
}) {
  return (
    <section className="automation-history" aria-labelledby="automation-history-title">
      <div className="automation-history-heading">
        <h3 id="automation-history-title">运行历史</h3>
        <small>
          显示 {runs.length} / {total}
        </small>
      </div>
      {runs.length ? (
        runs.map((run) => {
          const sessionId = runSessionId(run);
          const pending = busy.startsWith(`${run.id}:`);
          const output = run.output === undefined ? undefined : visibleValue(run.output);
          const result = run.result === undefined ? undefined : visibleValue(run.result);
          return (
            <details className="automation-run" key={run.id}>
              <summary>
                <span className={cx('automation-run-dot', run.status)} aria-hidden="true" />
                <span>
                  <strong>{RUN_STATUS[run.status]}</strong>
                  <small>
                    {formatDate(run.createdAt)} · {run.id}
                  </small>
                </span>
                <span className={cx('resource-status', run.status)}>{run.status}</span>
                <CaretDown className="automation-run-caret" size={14} />
              </summary>
              <div className="automation-run-detail">
                <dl>
                  <div>
                    <dt>触发</dt>
                    <dd>
                      {RUN_TRIGGER[run.trigger]}
                      {run.scheduledFor ? ` · ${formatDate(run.scheduledFor)}` : ''}
                    </dd>
                  </div>
                  <div>
                    <dt>任务 ID</dt>
                    <dd>{run.taskId}</dd>
                  </div>
                  <div>
                    <dt>开始</dt>
                    <dd>{formatDate(run.startedAt)}</dd>
                  </div>
                  <div>
                    <dt>完成</dt>
                    <dd>{formatDate(run.completedAt)}</dd>
                  </div>
                  <div>
                    <dt>耗时</dt>
                    <dd>{formatRunDuration(run)}</dd>
                  </div>
                  <div>
                    <dt>尝试</dt>
                    <dd>
                      #{run.attempt}
                      {run.retryOfRunId ? ` · 重试 ${run.retryOfRunId}` : ''}
                    </dd>
                  </div>
                  <div>
                    <dt>会话配置</dt>
                    <dd>
                      {[run.projectId, run.model, run.thinking].filter(Boolean).join(' · ') ||
                        '默认'}
                    </dd>
                  </div>
                </dl>
                {run.input !== undefined && (
                  <div>
                    <b>输入</b>
                    <pre>{visibleValue(run.input)}</pre>
                  </div>
                )}
                {output !== undefined && output !== result && (
                  <div>
                    <b>输出</b>
                    <pre>{output}</pre>
                  </div>
                )}
                {result !== undefined && (
                  <div>
                    <b>结果</b>
                    <pre>{result}</pre>
                  </div>
                )}
                {run.usage !== undefined && (
                  <div>
                    <b>用量</b>
                    <pre>{visibleValue(run.usage)}</pre>
                  </div>
                )}
                {run.error && (
                  <p className="automation-run-error" role="alert">
                    {run.error}
                  </p>
                )}
                <div className="page-actions">
                  {(run.status === 'queued' || run.status === 'running') && (
                    <button
                      className="legacy-button"
                      type="button"
                      disabled={Boolean(busy)}
                      onClick={() => onCancel(run)}
                    >
                      <X size={14} />
                      {pending ? '正在取消…' : '取消运行'}
                    </button>
                  )}
                  {['failed', 'cancelled', 'skipped'].includes(run.status) && (
                    <button
                      className="legacy-button"
                      type="button"
                      disabled={Boolean(busy)}
                      onClick={() => onRetry(run)}
                    >
                      <ArrowClockwise size={14} />
                      {busy === `${run.id}:retry` ? '正在重试…' : '重试'}
                    </button>
                  )}
                  {sessionId && onOpenSession && (
                    <button
                      className="legacy-button"
                      type="button"
                      onClick={() => onOpenSession(sessionId)}
                    >
                      <ChatCircleDots size={14} />
                      打开会话
                    </button>
                  )}
                </div>
              </div>
            </details>
          );
        })
      ) : (
        <p className="outputs-empty">尚无运行记录。点击“立即运行”创建第一次执行。</p>
      )}
      {runs.length < total && runs.length < 200 && (
        <button className="legacy-button automation-load-more" type="button" onClick={onLoadMore}>
          加载更多运行
        </button>
      )}
    </section>
  );
}
