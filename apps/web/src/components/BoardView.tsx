import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowClockwise } from '@phosphor-icons/react/dist/icons/ArrowClockwise';
import { Kanban } from '@phosphor-icons/react/dist/icons/Kanban';
import { ListBullets } from '@phosphor-icons/react/dist/icons/ListBullets';
import { Plus } from '@phosphor-icons/react/dist/icons/Plus';
import { SlidersHorizontal } from '@phosphor-icons/react/dist/icons/SlidersHorizontal';
import { Trash } from '@phosphor-icons/react/dist/icons/Trash';
import { X } from '@phosphor-icons/react/dist/icons/X';
import type {
  BoardTaskDeleteImpactRecord,
  BoardTaskDetailResponse,
  BoardTaskListResponse,
  BoardTaskStatus,
  BoardTaskType,
  HumanActionRecord,
  WakerTask,
} from '@waker/contracts';
import { cx } from '../lib/cx.js';
import {
  MOTION_DIALOG_BACKDROP,
  MOTION_DIALOG_SURFACE,
  MOTION_EASE,
  MOTION_LAYOUT_TRANSITION,
  MOTION_TRANSITION,
} from '../lib/motion.js';
import { fetchLocalResources } from '../lib/api.js';
import { useDialogFocus } from '../hooks/useDialogFocus.js';
import { useVisiblePolling } from '../hooks/useVisiblePolling.js';
import { MotionLoadingRows } from './MotionFeedback.js';

type BoardTab = 'tasks' | 'actions';
type BoardMode = 'list' | 'lanes';
export type BoardTaskRecord = WakerTask & {
  projectName?: string;
  automationId?: string;
  workflowId?: string;
};

interface BoardTaskDetail extends BoardTaskRecord {
  timeline: Array<{ id: string; label: string; status?: string; createdAt: string }>;
}

interface BoardEditor {
  id?: string;
  version?: number;
  title: string;
  description: string;
  projectId: string;
  status: Extract<BoardTaskStatus, 'queued' | 'waiting' | 'running' | 'completed' | 'cancelled'>;
  priority: BoardTaskRecord['priority'];
}

type BoardHumanAction = HumanActionRecord & {
  version: number;
  sessionId?: string;
  category?: string;
};

const PAGE_SIZE = 20;
const MAX_TASKS = 200;
const EMPTY_EDITOR: BoardEditor = {
  title: '',
  description: '',
  projectId: '',
  status: 'queued',
  priority: 'normal',
};
const STATUS_TEXT: Record<BoardTaskStatus, string> = {
  queued: '排队中',
  running: '运行中',
  waiting: '等待中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};
const TYPE_TEXT: Record<BoardTaskType, string> = {
  conversation: '会话',
  automation: '自动任务',
  workflow: '流程',
  manual: '手工任务',
};
const LANES: Array<{ id: string; title: string; statuses: BoardTaskStatus[] }> = [
  { id: 'queued', title: '排队', statuses: ['queued'] },
  { id: 'running', title: '运行', statuses: ['running'] },
  { id: 'waiting', title: '等待', statuses: ['waiting'] },
  { id: 'completed', title: '完成', statuses: ['completed'] },
  { id: 'failed', title: '失败 / 取消', statuses: ['failed', 'cancelled'] },
];
const SOURCE_OPTIONS: Array<{ value: BoardTaskRecord['sourceType']; label: string }> = [
  { value: 'manual', label: '手工任务' },
  { value: 'conversation', label: '会话' },
  { value: 'automation', label: 'Automation' },
  { value: 'workflow', label: 'Workflow' },
];

class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) {
    let message = fallback;
    try {
      const value = (await response.json()) as { error?: string };
      if (value.error) message = value.error;
    } catch {
      // Keep the product-level fallback for non-JSON failures.
    }
    throw new RequestError(message, response.status);
  }
  return response.json() as Promise<T>;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'AbortError';
}

function isManual(task: BoardTaskRecord): boolean {
  return task.origin === 'manual' && !task.managed;
}

export function BoardView({
  wakerId,
  notify,
  onOpenSession,
  onOpenAutomation,
  onOpenWorkflow,
}: {
  wakerId: string;
  notify: (text: string) => void;
  onOpenSession?: (sessionId: string) => void;
  onOpenAutomation?: (automationId?: string) => void;
  onOpenWorkflow?: (workflowId?: string) => void;
}) {
  const [tab, setTab] = useState<BoardTab>('tasks');
  const [mode, setMode] = useState<BoardMode>('list');
  const [items, setItems] = useState<BoardTaskRecord[] | null>(null);
  const [total, setTotal] = useState(0);
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [query, setQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [source, setSource] = useState('');
  const [projectId, setProjectId] = useState('');
  const [sort, setSort] = useState('updated_desc');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<BoardTaskDetail | null>(null);
  const [detailError, setDetailError] = useState('');
  const [editor, setEditor] = useState<BoardEditor | null>(null);
  const [editorError, setEditorError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<BoardTaskRecord | null>(null);
  const [deleteImpact, setDeleteImpact] = useState<BoardTaskDeleteImpactRecord | null>(null);
  const [deleteImpactError, setDeleteImpactError] = useState('');
  const [actions, setActions] = useState<BoardHumanAction[] | null>(null);
  const [actionTotal, setActionTotal] = useState(0);
  const [actionStatus, setActionStatus] = useState<HumanActionRecord['status']>('pending');
  const [actionSource, setActionSource] = useState('');
  const [actionInput, setActionInput] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState('');
  const [ignoreTarget, setIgnoreTarget] = useState<BoardHumanAction | null>(null);
  const [busy, setBusy] = useState('');
  const ownerRef = useRef(wakerId);
  const loadGenerationRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const detailGenerationRef = useRef(0);
  const projectGenerationRef = useRef(0);
  const actionGenerationRef = useRef(0);
  const actionAbortRef = useRef<AbortController | null>(null);
  const actionStatusRef = useRef(actionStatus);
  const actionSourceRef = useRef(actionSource);
  const selectedTriggerRef = useRef<HTMLButtonElement | null>(null);
  const detailRef = useRef<HTMLElement>(null);
  const createTriggerRef = useRef<HTMLButtonElement>(null);
  const editTriggerRef = useRef<HTMLButtonElement>(null);
  const editorTriggerRef = useRef<'create' | 'edit'>('create');
  const editorTitleRef = useRef<HTMLInputElement>(null);
  const hasSnapshotRef = useRef(false);
  const tabRefs = useRef<Record<BoardTab, HTMLButtonElement | null>>({
    tasks: null,
    actions: null,
  });
  ownerRef.current = wakerId;
  actionStatusRef.current = actionStatus;
  actionSourceRef.current = actionSource;

  const closeEditor = useCallback(() => {
    setEditor(null);
    requestAnimationFrame(() =>
      (editorTriggerRef.current === 'create'
        ? createTriggerRef.current
        : editTriggerRef.current
      )?.focus(),
    );
  }, []);
  const editorDialogRef = useDialogFocus<HTMLFormElement>(Boolean(editor), closeEditor);
  const closeDelete = useCallback(() => {
    if (!busy.startsWith('delete:')) setDeleteTarget(null);
  }, [busy]);
  const deleteDialogRef = useDialogFocus<HTMLDivElement>(Boolean(deleteTarget), closeDelete);
  const closeIgnore = useCallback(() => {
    if (!busy.startsWith('ignore:')) setIgnoreTarget(null);
  }, [busy]);
  const ignoreDialogRef = useDialogFocus<HTMLDivElement>(Boolean(ignoreTarget), closeIgnore);

  useEffect(() => {
    const timer = setTimeout(() => setAppliedQuery(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const load = useCallback(
    async (offset = 0, append = false, background = false) => {
      const generation = ++loadGenerationRef.current;
      loadAbortRef.current?.abort();
      const controller = new AbortController();
      loadAbortRef.current = controller;
      if (!background) setLoading(true);
      try {
        const params = new URLSearchParams({
          wakerId,
          limit: String(mode === 'lanes' ? MAX_TASKS : PAGE_SIZE),
          offset: String(offset),
          sort,
        });
        if (appliedQuery) params.set('query', appliedQuery);
        if (status) params.set('status', status);
        if (type) params.set('type', type);
        if (source) params.set('sourceType', source);
        if (projectId) params.set('projectId', projectId);
        const result = await readJson<BoardTaskListResponse>(
          await fetch(`/api/v1/board/tasks?${params}`, { signal: controller.signal }),
          '任务看板暂时无法读取',
        );
        if (generation !== loadGenerationRef.current || ownerRef.current !== wakerId) return;
        setItems((current) => (append && current ? [...current, ...result.items] : result.items));
        setTotal(result.total);
        setError('');
        setRefreshError('');
        hasSnapshotRef.current = true;
      } catch (cause) {
        if (generation !== loadGenerationRef.current || isAbortError(cause)) return;
        const message = cause instanceof Error ? cause.message : '任务看板暂时无法读取';
        if (background && hasSnapshotRef.current) setRefreshError(message);
        else setError(message);
      } finally {
        if (generation === loadGenerationRef.current && ownerRef.current === wakerId)
          setLoading(false);
      }
    },
    [appliedQuery, mode, projectId, sort, source, status, type, wakerId],
  );

  useEffect(() => {
    setItems(null);
    setSelectedId('');
    setDetail(null);
    setActions(null);
    setProjects([]);
    setProjectId('');
    setEditor(null);
    setDeleteTarget(null);
    setDeleteImpact(null);
    setDeleteImpactError('');
    setIgnoreTarget(null);
    setActionInput({});
    setError('');
    hasSnapshotRef.current = false;
    loadGenerationRef.current += 1;
    loadAbortRef.current?.abort();
    const projectGeneration = ++projectGenerationRef.current;
    void fetchLocalResources(wakerId)
      .then((resources) => {
        if (projectGeneration !== projectGenerationRef.current || ownerRef.current !== wakerId)
          return;
        setProjects(
          resources.projects
            .filter((project) => project.wakerId === wakerId)
            .map(({ id, name }) => ({ id, name })),
        );
      })
      .catch(() => {
        if (projectGeneration === projectGenerationRef.current && ownerRef.current === wakerId)
          setProjects([]);
      });
  }, [wakerId]);
  useEffect(() => {
    if (tab === 'tasks') void load();
  }, [load, tab]);
  useEffect(
    () => () => {
      loadGenerationRef.current += 1;
      loadAbortRef.current?.abort();
      detailGenerationRef.current += 1;
      projectGenerationRef.current += 1;
      actionGenerationRef.current += 1;
      actionAbortRef.current?.abort();
    },
    [],
  );

  const loadActions = useCallback(async () => {
    const owner = wakerId;
    const generation = ++actionGenerationRef.current;
    actionAbortRef.current?.abort();
    const controller = new AbortController();
    actionAbortRef.current = controller;
    setActionError('');
    try {
      const params = new URLSearchParams({
        wakerId,
        status: actionStatusRef.current,
        limit: String(MAX_TASKS),
        offset: '0',
      });
      if (actionSourceRef.current) params.set('source', actionSourceRef.current);
      const result = await readJson<{ items: BoardHumanAction[]; total: number }>(
        await fetch(`/api/v1/board/human-actions?${params}`, { signal: controller.signal }),
        '人工操作暂时无法读取',
      );
      if (generation === actionGenerationRef.current && ownerRef.current === owner) {
        setActions(result.items);
        setActionTotal(result.total);
      }
    } catch (cause) {
      if (
        generation === actionGenerationRef.current &&
        ownerRef.current === owner &&
        !isAbortError(cause)
      )
        setActionError(cause instanceof Error ? cause.message : '人工操作暂时无法读取');
    }
  }, [wakerId]);
  useEffect(() => {
    if (tab === 'actions') void loadActions();
  }, [actionSource, actionStatus, loadActions, tab]);
  useVisiblePolling(() => {
    if (tab === 'tasks') void load(0, false, true);
    else void loadActions();
  }, 5_000);

  const openDetail = async (task: BoardTaskRecord, trigger: HTMLButtonElement) => {
    const generation = ++detailGenerationRef.current;
    const owner = wakerId;
    selectedTriggerRef.current = trigger;
    setSelectedId(task.id);
    setDetail(null);
    setDetailError('');
    try {
      const value = await readJson<BoardTaskDetailResponse>(
        await fetch(
          `/api/v1/board/tasks/${encodeURIComponent(task.id)}?${new URLSearchParams({ wakerId })}`,
        ),
        '任务详情暂时无法读取',
      );
      if (generation !== detailGenerationRef.current || ownerRef.current !== owner) return;
      setDetail({
        ...value.task,
        timeline: value.events.map((event) => ({
          id: String(event.id),
          label: event.type,
          ...(event.status ? { status: event.status } : {}),
          createdAt: event.createdAt,
        })),
      });
      requestAnimationFrame(() => detailRef.current?.focus());
    } catch (cause) {
      if (generation !== detailGenerationRef.current || ownerRef.current !== owner) return;
      setDetailError(cause instanceof Error ? cause.message : '任务详情暂时无法读取');
    }
  };

  const closeDetail = () => {
    detailGenerationRef.current += 1;
    setSelectedId('');
    setDetail(null);
    setDetailError('');
    requestAnimationFrame(() => selectedTriggerRef.current?.focus());
  };

  const selectTab = (next: BoardTab) => {
    tabRefs.current[next]?.focus();
    setTab(next);
  };
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, current: BoardTab) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    selectTab(
      event.key === 'ArrowLeft' || event.key === 'Home'
        ? 'tasks'
        : event.key === 'ArrowRight' || event.key === 'End'
          ? 'actions'
          : current,
    );
  };

  const openEditor = (next: BoardEditor, trigger: 'create' | 'edit') => {
    editorTriggerRef.current = trigger;
    setEditorError('');
    setEditor(next);
    requestAnimationFrame(() => editorTitleRef.current?.focus());
  };

  const saveManual = async (event: FormEvent) => {
    event.preventDefault();
    if (!editor?.title.trim()) return;
    const owner = wakerId;
    setBusy('save');
    setEditorError('');
    try {
      const response = await fetch(
        editor.id ? `/api/v1/board/tasks/${encodeURIComponent(editor.id)}` : '/api/v1/board/tasks',
        {
          method: editor.id ? 'PATCH' : 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            wakerId,
            title: editor.title.trim(),
            description: editor.description.trim(),
            projectId: editor.projectId || null,
            status: editor.status,
            priority: editor.priority,
            ...(editor.id ? { expectedVersion: editor.version } : {}),
          }),
        },
      );
      const saved = await readJson<BoardTaskRecord>(response, '手工任务暂时无法保存');
      if (ownerRef.current !== owner) return;
      setDetail((current) =>
        current?.id === saved.id
          ? {
              ...current,
              ...saved,
              timeline: [
                ...current.timeline,
                {
                  id: `updated:${saved.version ?? current.timeline.length + 1}`,
                  label: 'updated',
                  status: saved.status,
                  createdAt: saved.updatedAt,
                },
              ],
            }
          : current,
      );
      closeEditor();
      await load();
      notify(editor.id ? '手工任务已更新' : '手工任务已创建');
    } catch (cause) {
      if (ownerRef.current !== owner) return;
      setEditorError(
        cause instanceof RequestError && cause.status === 409
          ? '任务已由其他请求更新。请关闭编辑器并重新打开最新版本。'
          : cause instanceof Error
            ? cause.message
            : '手工任务暂时无法保存',
      );
    } finally {
      if (ownerRef.current === owner) setBusy('');
    }
  };

  const inspectDelete = async (task: BoardTaskRecord) => {
    const owner = wakerId;
    const generation = detailGenerationRef.current;
    setDeleteTarget(task);
    setDeleteImpact(null);
    setDeleteImpactError('');
    try {
      const impact = await readJson<BoardTaskDeleteImpactRecord>(
        await fetch(
          `/api/v1/board/tasks/${encodeURIComponent(task.id)}/delete-impact?${new URLSearchParams({ wakerId: owner })}`,
        ),
        '删除影响暂时无法读取',
      );
      if (generation === detailGenerationRef.current && ownerRef.current === owner)
        setDeleteImpact(impact);
    } catch (cause) {
      if (generation !== detailGenerationRef.current || ownerRef.current !== owner) return;
      setDeleteImpactError(cause instanceof Error ? cause.message : '删除影响暂时无法读取');
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setBusy(`delete:${deleteTarget.id}`);
    try {
      const response = await fetch(
        `/api/v1/board/tasks/${encodeURIComponent(deleteTarget.id)}?${new URLSearchParams({
          wakerId,
          expectedVersion: String(deleteTarget.version ?? 1),
        })}`,
        { method: 'DELETE' },
      );
      if (!response.ok) await readJson<never>(response, '手工任务暂时无法删除');
      setDeleteTarget(null);
      closeDetail();
      await load();
      notify('手工任务已删除');
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '手工任务暂时无法删除');
    } finally {
      setBusy('');
    }
  };

  const visibleItems = useMemo(() => items ?? [], [items]);
  const pendingCount = actions?.filter((action) => action.status === 'pending').length ?? 0;
  const visibleActions = actions ?? [];

  return (
    <section className="legacy-page board-page" aria-labelledby="board-title">
      <header className="legacy-page-header">
        <div>
          <h1 id="board-title">任务看板</h1>
          <p>追踪本地 Automation、Workflow、会话与手工任务；派生状态只由宿主运行时写入。</p>
        </div>
        <div className="page-actions">
          <button
            className="legacy-button"
            type="button"
            disabled={loading}
            onClick={() => (tab === 'tasks' ? void load() : void loadActions())}
          >
            <ArrowClockwise size={14} />
            刷新
          </button>
          <button className="legacy-button" type="button" onClick={() => onOpenAutomation?.()}>
            管理自动任务
          </button>
          <button
            ref={createTriggerRef}
            className="legacy-button primary"
            type="button"
            onClick={() => openEditor({ ...EMPTY_EDITOR }, 'create')}
          >
            <Plus size={15} />
            新建手工任务
          </button>
        </div>
      </header>

      <div className="board-primary-tabs" role="tablist" aria-label="任务看板区域">
        <button
          ref={(node) => {
            tabRefs.current.tasks = node;
          }}
          id="board-tab-tasks"
          role="tab"
          type="button"
          aria-selected={tab === 'tasks'}
          aria-controls="board-panel-tasks"
          tabIndex={tab === 'tasks' ? 0 : -1}
          className={cx(tab === 'tasks' && 'active')}
          onClick={() => setTab('tasks')}
          onKeyDown={(event) => onTabKeyDown(event, 'tasks')}
        >
          任务追踪
        </button>
        <button
          ref={(node) => {
            tabRefs.current.actions = node;
          }}
          id="board-tab-actions"
          role="tab"
          type="button"
          aria-selected={tab === 'actions'}
          aria-controls="board-panel-actions"
          tabIndex={tab === 'actions' ? 0 : -1}
          className={cx(tab === 'actions' && 'active')}
          onClick={() => setTab('actions')}
          onKeyDown={(event) => onTabKeyDown(event, 'actions')}
        >
          人工操作
          {pendingCount > 0 && <span aria-label={`${pendingCount} 个待处理`}>{pendingCount}</span>}
        </button>
      </div>

      {tab === 'tasks' ? (
        <div
          id="board-panel-tasks"
          role="tabpanel"
          aria-labelledby="board-tab-tasks"
          className="board-panel"
        >
          <BoardTaskSurface
            items={visibleItems}
            total={total}
            projects={projects}
            query={query}
            status={status}
            type={type}
            source={source}
            projectId={projectId}
            sort={sort}
            sources={SOURCE_OPTIONS}
            mode={mode}
            loading={loading}
            error={error}
            refreshError={refreshError}
            selectedId={selectedId}
            onQuery={setQuery}
            onStatus={setStatus}
            onType={setType}
            onSource={setSource}
            onProject={setProjectId}
            onSort={setSort}
            onMode={setMode}
            onRetry={() => void load()}
            onLoadMore={() => void load(visibleItems.length, true)}
            onOpen={(task, trigger) => void openDetail(task, trigger)}
          />
        </div>
      ) : (
        <div
          id="board-panel-actions"
          role="tabpanel"
          aria-labelledby="board-tab-actions"
          className="board-panel"
        >
          <HumanActionSurface
            actions={visibleActions}
            total={actionTotal}
            loaded={actions !== null}
            error={actionError}
            status={actionStatus}
            source={actionSource}
            inputs={actionInput}
            busy={busy}
            onStatus={setActionStatus}
            onSource={setActionSource}
            onInput={(id, value) => setActionInput((current) => ({ ...current, [id]: value }))}
            onRetry={() => void loadActions()}
            onOpenSession={onOpenSession}
            onResolve={async (action) => {
              let value: unknown;
              try {
                value = JSON.parse(actionInput[action.id] ?? '{}');
              } catch {
                setActionError('继续运行的输入必须是有效 JSON');
                return;
              }
              setBusy(`resolve:${action.id}`);
              try {
                await readJson(
                  await fetch(
                    `/api/v1/board/human-actions/${encodeURIComponent(action.id)}/resolve`,
                    {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({
                        wakerId,
                        expectedVersion: action.version,
                        result: value,
                      }),
                    },
                  ),
                  '人工输入暂时无法提交',
                );
                await loadActions();
                notify('人工输入已提交');
              } catch (cause) {
                setActionError(cause instanceof Error ? cause.message : '人工输入暂时无法提交');
              } finally {
                setBusy('');
              }
            }}
            onIgnore={setIgnoreTarget}
          />
        </div>
      )}

      <AnimatePresence>
        {selectedId && (
          <motion.aside
            ref={detailRef}
            className="board-detail"
            aria-labelledby="board-detail-title"
            tabIndex={-1}
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
            transition={{ duration: 0.18, ease: MOTION_EASE }}
          >
            <div className="board-detail-header">
              <div>
                <h2 id="board-detail-title">{detail?.title ?? '任务详情'}</h2>
                {detail && (
                  <span className={cx('resource-status', detail.status)}>
                    {STATUS_TEXT[detail.status]}
                  </span>
                )}
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="关闭任务详情"
                onClick={closeDetail}
              >
                <X size={17} />
              </button>
            </div>
            {detailError ? (
              <div className="legacy-error" role="alert">
                <p>{detailError}</p>
                <button
                  className="legacy-button"
                  type="button"
                  onClick={() => {
                    const task = items?.find((item) => item.id === selectedId);
                    if (task && selectedTriggerRef.current)
                      void openDetail(task, selectedTriggerRef.current);
                  }}
                >
                  重试
                </button>
              </div>
            ) : detail ? (
              <BoardDetailContent
                task={detail}
                editButtonRef={editTriggerRef}
                onEdit={() =>
                  openEditor(
                    {
                      id: detail.id,
                      version: detail.version,
                      title: detail.title,
                      description: detail.description,
                      projectId: detail.projectId ?? '',
                      status: ['queued', 'waiting', 'running', 'completed', 'cancelled'].includes(
                        detail.status,
                      )
                        ? (detail.status as BoardEditor['status'])
                        : 'queued',
                      priority: detail.priority,
                    },
                    'edit',
                  )
                }
                onDelete={() => void inspectDelete(detail)}
                onOpenSession={onOpenSession}
                onOpenAutomation={onOpenAutomation}
                onOpenWorkflow={onOpenWorkflow}
              />
            ) : (
              <p className="outputs-empty" role="status">
                正在读取任务详情…
              </p>
            )}
          </motion.aside>
        )}
      </AnimatePresence>

      {editor && (
        <motion.div
          className="modal-backdrop"
          onMouseDown={closeEditor}
          {...MOTION_DIALOG_BACKDROP}
        >
          <motion.form
            ref={editorDialogRef}
            className="board-editor-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="board-editor-title"
            tabIndex={-1}
            onMouseDown={(event) => event.stopPropagation()}
            onSubmit={saveManual}
            {...MOTION_DIALOG_SURFACE}
          >
            <h2 id="board-editor-title">{editor.id ? '编辑手工任务' : '新建手工任务'}</h2>
            <label>
              标题
              <input
                ref={editorTitleRef}
                value={editor.title}
                onChange={(event) => setEditor({ ...editor, title: event.target.value })}
              />
            </label>
            <label>
              说明
              <textarea
                value={editor.description}
                onChange={(event) => setEditor({ ...editor, description: event.target.value })}
              />
            </label>
            <label>
              项目
              <select
                value={editor.projectId}
                onChange={(event) => setEditor({ ...editor, projectId: event.target.value })}
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
              状态
              <select
                value={editor.status}
                onChange={(event) =>
                  setEditor({ ...editor, status: event.target.value as BoardEditor['status'] })
                }
              >
                <option value="queued">待处理</option>
                <option value="waiting">等待中</option>
                <option value="running">运行中</option>
                <option value="completed">已完成</option>
                <option value="cancelled">已取消</option>
              </select>
            </label>
            <label>
              优先级
              <select
                value={editor.priority}
                onChange={(event) =>
                  setEditor({
                    ...editor,
                    priority: event.target.value as BoardTaskRecord['priority'],
                  })
                }
              >
                <option value="low">低</option>
                <option value="normal">普通</option>
                <option value="high">高</option>
                <option value="urgent">紧急</option>
              </select>
            </label>
            {editorError && (
              <p className="automation-action-error" role="alert">
                {editorError}
              </p>
            )}
            <div className="dialog-actions">
              <button className="legacy-button" type="button" onClick={closeEditor}>
                取消
              </button>
              <button
                className="legacy-button primary"
                disabled={!editor.title.trim() || Boolean(busy)}
              >
                {busy === 'save' ? '保存中…' : '保存'}
              </button>
            </div>
          </motion.form>
        </motion.div>
      )}

      {deleteTarget && (
        <motion.div
          className="modal-backdrop"
          onMouseDown={closeDelete}
          {...MOTION_DIALOG_BACKDROP}
        >
          <motion.div
            ref={deleteDialogRef}
            className="board-delete-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="board-delete-title"
            tabIndex={-1}
            onMouseDown={(event) => event.stopPropagation()}
            {...MOTION_DIALOG_SURFACE}
          >
            <h2 id="board-delete-title">删除“{deleteTarget.title}”？</h2>
            <p>仅手工任务可删除；Automation、Workflow、Run 和 Session 记录不会被伪造或级联删除。</p>
            {deleteImpactError ? (
              <div className="legacy-error" role="alert">
                <p>{deleteImpactError}</p>
                <button
                  className="legacy-button"
                  type="button"
                  onClick={() => void inspectDelete(deleteTarget)}
                >
                  重试影响检查
                </button>
              </div>
            ) : deleteImpact ? (
              <p>
                子任务 {deleteImpact.children} · 事件 {deleteImpact.events} · 人工操作{' '}
                {deleteImpact.humanActions} · 行为：软删除任务记录
              </p>
            ) : (
              <p role="status">正在检查删除影响…</p>
            )}
            <div className="dialog-actions">
              <button className="legacy-button" type="button" onClick={closeDelete}>
                取消
              </button>
              <button
                className="legacy-button danger"
                type="button"
                disabled={!deleteImpact || Boolean(busy)}
                onClick={() => void confirmDelete()}
              >
                <Trash size={14} />
                确认删除
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}

      {ignoreTarget && (
        <motion.div
          className="modal-backdrop"
          onMouseDown={closeIgnore}
          {...MOTION_DIALOG_BACKDROP}
        >
          <motion.div
            ref={ignoreDialogRef}
            className="board-delete-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="board-ignore-title"
            tabIndex={-1}
            onMouseDown={(event) => event.stopPropagation()}
            {...MOTION_DIALOG_SURFACE}
          >
            <h2 id="board-ignore-title">忽略“{ignoreTarget.title}”？</h2>
            <p>
              {ignoreTarget.source === 'workflow'
                ? '忽略会取消对应 Workflow 的等待节点；运行不会被标记为已处理。'
                : '该 Codex 操作只读展示；忽略仅移出待处理列表，不会批准任何宿主操作。'}
            </p>
            <div className="dialog-actions">
              <button className="legacy-button" type="button" onClick={closeIgnore}>
                取消
              </button>
              <button
                className="legacy-button danger"
                type="button"
                disabled={Boolean(busy)}
                onClick={() => {
                  const action = ignoreTarget;
                  void (async () => {
                    setBusy(`ignore:${action.id}`);
                    try {
                      await readJson(
                        await fetch(
                          `/api/v1/board/human-actions/${encodeURIComponent(action.id)}/ignore`,
                          {
                            method: 'POST',
                            headers: { 'content-type': 'application/json' },
                            body: JSON.stringify({
                              wakerId,
                              expectedVersion: action.version,
                            }),
                          },
                        ),
                        '人工操作暂时无法忽略',
                      );
                      setIgnoreTarget(null);
                      await loadActions();
                      notify('人工操作已忽略');
                    } catch (cause) {
                      setActionError(
                        cause instanceof Error ? cause.message : '人工操作暂时无法忽略',
                      );
                    } finally {
                      setBusy('');
                    }
                  })();
                }}
              >
                确认忽略
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </section>
  );
}

function BoardTaskSurface({
  items,
  total,
  projects,
  query,
  status,
  type,
  source,
  projectId,
  sort,
  sources,
  mode,
  loading,
  error,
  refreshError,
  selectedId,
  onQuery,
  onStatus,
  onType,
  onSource,
  onProject,
  onSort,
  onMode,
  onRetry,
  onLoadMore,
  onOpen,
}: {
  items: BoardTaskRecord[];
  total: number;
  projects: Array<{ id: string; name: string }>;
  query: string;
  status: string;
  type: string;
  source: string;
  projectId: string;
  sort: string;
  sources: Array<{ value: BoardTaskRecord['sourceType']; label: string }>;
  mode: BoardMode;
  loading: boolean;
  error: string;
  refreshError: string;
  selectedId: string;
  onQuery: (value: string) => void;
  onStatus: (value: string) => void;
  onType: (value: string) => void;
  onSource: (value: string) => void;
  onProject: (value: string) => void;
  onSort: (value: string) => void;
  onMode: (value: BoardMode) => void;
  onRetry: () => void;
  onLoadMore: () => void;
  onOpen: (task: BoardTaskRecord, trigger: HTMLButtonElement) => void;
}) {
  return (
    <>
      <div className="board-toolbar" aria-label="任务筛选">
        <label className="board-search">
          <span className="visually-hidden">搜索任务</span>
          <input
            value={query}
            placeholder="搜索任务标题或来源…"
            onChange={(event) => onQuery(event.target.value)}
          />
        </label>
        <label>
          <span>状态</span>
          <select value={status} onChange={(event) => onStatus(event.target.value)}>
            <option value="">全部状态</option>
            {Object.entries(STATUS_TEXT).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>类型</span>
          <select value={type} onChange={(event) => onType(event.target.value)}>
            <option value="">全部类型</option>
            {Object.entries(TYPE_TEXT).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>来源</span>
          <select value={source} onChange={(event) => onSource(event.target.value)}>
            <option value="">全部来源</option>
            {sources.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>项目</span>
          <select value={projectId} onChange={(event) => onProject(event.target.value)}>
            <option value="">全部项目</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>排序</span>
          <select value={sort} onChange={(event) => onSort(event.target.value)}>
            <option value="updated_desc">最近活动优先</option>
            <option value="updated_asc">最早活动优先</option>
            <option value="priority_desc">高优先级优先</option>
            <option value="title_asc">标题 A–Z</option>
          </select>
        </label>
        <div className="board-view-switch" aria-label="任务视图">
          <button
            type="button"
            aria-pressed={mode === 'list'}
            className={cx(mode === 'list' && 'active')}
            onClick={() => onMode('list')}
          >
            <ListBullets size={15} /> 列表
          </button>
          <button
            type="button"
            aria-pressed={mode === 'lanes'}
            className={cx(mode === 'lanes' && 'active')}
            onClick={() => onMode('lanes')}
          >
            <Kanban size={15} /> 分栏
          </button>
        </div>
      </div>
      {refreshError && (
        <div className="automation-refresh-warning" role="status">
          <span>刷新失败，仍显示上次数据：{refreshError}</span>
          <button className="legacy-button" type="button" onClick={onRetry}>
            <ArrowClockwise size={14} /> 重试
          </button>
        </div>
      )}
      {error ? (
        <div className="legacy-error" role="alert">
          <p>{error}</p>
          <button className="legacy-button" type="button" onClick={onRetry}>
            重试
          </button>
        </div>
      ) : loading && !items.length ? (
        <MotionLoadingRows label="正在读取任务" />
      ) : items.length ? (
        mode === 'list' ? (
          <div className="board-table-wrap">
            <table className="board-table">
              <caption className="visually-hidden">任务列表，共 {total} 条</caption>
              <thead>
                <tr>
                  <th scope="col">任务</th>
                  <th scope="col">类型</th>
                  <th scope="col">状态</th>
                  <th scope="col">项目</th>
                  <th scope="col">最近活动</th>
                  <th scope="col">来源</th>
                </tr>
              </thead>
              <tbody>
                {items.map((task) => (
                  <motion.tr
                    key={task.id}
                    className={cx(selectedId === task.id && 'active')}
                    layout="position"
                    layoutId={`board-task-${task.id}`}
                    transition={{ layout: MOTION_LAYOUT_TRANSITION }}
                  >
                    <td>
                      <button
                        className="board-task-link"
                        type="button"
                        aria-expanded={selectedId === task.id}
                        aria-controls="board-task-detail"
                        onClick={(event) => onOpen(task, event.currentTarget)}
                      >
                        {task.title}
                        {task.managed && <small>宿主管理</small>}
                      </button>
                    </td>
                    <td>{TYPE_TEXT[task.type] ?? task.type}</td>
                    <td>
                      <span className={cx('resource-status', task.status)}>
                        {STATUS_TEXT[task.status]}
                      </span>
                    </td>
                    <td>{task.projectName ?? task.projectId ?? '—'}</td>
                    <td>{formatTime(task.lastActiveAt)}</td>
                    <td>{task.sourceType}</td>
                  </motion.tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="board-lanes" aria-label="任务状态分栏">
            {LANES.map((lane) => {
              const laneItems = items.filter((task) => lane.statuses.includes(task.status));
              return (
                <section
                  key={lane.id}
                  className="board-lane"
                  aria-labelledby={`board-lane-${lane.id}`}
                >
                  <h2 id={`board-lane-${lane.id}`}>
                    {lane.title} <span>{laneItems.length}</span>
                  </h2>
                  <div className="board-lane-items">
                    {laneItems.map((task) => (
                      <motion.button
                        key={task.id}
                        type="button"
                        className={cx('board-lane-task', selectedId === task.id && 'active')}
                        aria-expanded={selectedId === task.id}
                        aria-controls="board-task-detail"
                        onClick={(event) => onOpen(task, event.currentTarget)}
                        layout="position"
                        layoutId={`board-task-${task.id}`}
                        transition={{ layout: MOTION_LAYOUT_TRANSITION }}
                        whileTap={{ scale: 0.985 }}
                      >
                        <strong>{task.title}</strong>
                        <span>
                          {TYPE_TEXT[task.type]} · {task.projectName ?? '无项目'}
                        </span>
                        <small>{formatTime(task.lastActiveAt)}</small>
                      </motion.button>
                    ))}
                    {!laneItems.length && <p>暂无{lane.title}任务</p>}
                  </div>
                </section>
              );
            })}
          </div>
        )
      ) : (
        <div className="board-empty">
          <SlidersHorizontal size={24} aria-hidden="true" />
          <h2>
            {query || status || type || source || projectId ? '没有匹配的任务' : '还没有任务'}
          </h2>
          <p>
            {query || status || type || source || projectId
              ? '调整筛选条件后重试。'
              : '运行 Automation、Workflow、会话，或创建一条手工任务。'}
          </p>
        </div>
      )}
      {mode === 'list' && items.length < Math.min(total, MAX_TASKS) && (
        <div className="board-pagination">
          <span>
            已显示 {items.length} / {total}
            {total > MAX_TASKS ? '（最多 200 条）' : ''}
          </span>
          <button className="legacy-button" type="button" disabled={loading} onClick={onLoadMore}>
            {loading ? '加载中…' : '加载更多'}
          </button>
        </div>
      )}
      {mode === 'lanes' && total > items.length && (
        <p className="board-pagination" role="status">
          分栏仅显示最近 {items.length} / {total} 条任务（上限 {MAX_TASKS}）。
        </p>
      )}
    </>
  );
}

function BoardDetailContent({
  task,
  editButtonRef,
  onEdit,
  onDelete,
  onOpenSession,
  onOpenAutomation,
  onOpenWorkflow,
}: {
  task: BoardTaskDetail;
  editButtonRef: RefObject<HTMLButtonElement | null>;
  onEdit: () => void;
  onDelete: () => void;
  onOpenSession?: (sessionId: string) => void;
  onOpenAutomation?: (automationId?: string) => void;
  onOpenWorkflow?: (workflowId?: string) => void;
}) {
  return (
    <div className="board-detail-body" id="board-task-detail">
      <dl className="board-facts">
        <div>
          <dt>类型</dt>
          <dd>{TYPE_TEXT[task.type]}</dd>
        </div>
        <div>
          <dt>来源</dt>
          <dd>
            {task.sourceType}
            {task.sourceId ? ` · ${task.sourceId}` : ''}
          </dd>
        </div>
        <div>
          <dt>项目</dt>
          <dd>{task.projectName ?? task.projectId ?? '未绑定'}</dd>
        </div>
        <div>
          <dt>最近活动</dt>
          <dd>{formatTime(task.lastActiveAt)}</dd>
        </div>
        <div>
          <dt>优先级</dt>
          <dd>{task.priority}</dd>
        </div>
        <div>
          <dt>版本</dt>
          <dd>v{task.version}</dd>
        </div>
      </dl>
      {task.description && <p className="board-detail-description">{task.description}</p>}
      <div className="board-detail-actions">
        {isManual(task) ? (
          <>
            <button ref={editButtonRef} className="legacy-button" type="button" onClick={onEdit}>
              编辑
            </button>
            <button className="legacy-button danger" type="button" onClick={onDelete}>
              <Trash size={14} /> 删除
            </button>
          </>
        ) : (
          <span className="board-readonly-note">派生任务只读；状态由宿主运行更新。</span>
        )}
        {task.sessionId && onOpenSession && (
          <button
            className="legacy-button"
            type="button"
            onClick={() => onOpenSession(task.sessionId!)}
          >
            打开会话
          </button>
        )}
        {task.sourceType === 'automation' && (
          <button
            className="legacy-button"
            type="button"
            onClick={() => onOpenAutomation?.(task.automationId ?? task.sourceId)}
          >
            打开自动任务
          </button>
        )}
        {task.sourceType === 'workflow' && (
          <button
            className="legacy-button"
            type="button"
            onClick={() => onOpenWorkflow?.(task.workflowId ?? task.sourceId)}
          >
            打开流程
          </button>
        )}
      </div>
      {task.result && (
        <section>
          <h3>结果</h3>
          <pre>{task.result}</pre>
        </section>
      )}
      {task.error && (
        <section className="board-task-error" role="alert">
          <h3>错误</h3>
          <pre>{task.error}</pre>
        </section>
      )}
      <section>
        <h3>时间线</h3>
        {task.timeline.length ? (
          <ol className="board-timeline">
            {task.timeline.map((event) => (
              <li key={event.id}>
                <span />
                <div>
                  <strong>{event.label}</strong>
                  <small>
                    {event.status ? `${event.status} · ` : ''}
                    {formatTime(event.createdAt)}
                  </small>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="outputs-empty">暂无时间线事件</p>
        )}
      </section>
    </div>
  );
}

function HumanActionSurface({
  actions,
  total,
  loaded,
  error,
  status,
  source,
  inputs,
  busy,
  onStatus,
  onSource,
  onInput,
  onRetry,
  onOpenSession,
  onResolve,
  onIgnore,
}: {
  actions: BoardHumanAction[];
  total: number;
  loaded: boolean;
  error: string;
  status: HumanActionRecord['status'];
  source: string;
  inputs: Record<string, string>;
  busy: string;
  onStatus: (value: HumanActionRecord['status']) => void;
  onSource: (value: string) => void;
  onInput: (id: string, value: string) => void;
  onRetry: () => void;
  onOpenSession?: (sessionId: string) => void;
  onResolve: (action: BoardHumanAction) => void;
  onIgnore: (action: BoardHumanAction) => void;
}) {
  return (
    <>
      <div className="board-action-filters" aria-label="人工操作筛选">
        <label>
          状态
          <select
            value={status}
            onChange={(event) => onStatus(event.target.value as HumanActionRecord['status'])}
          >
            <option value="pending">待处理</option>
            <option value="handled">已处理</option>
            <option value="ignored">已忽略</option>
          </select>
        </label>
        <label>
          来源
          <select value={source} onChange={(event) => onSource(event.target.value)}>
            <option value="">全部来源</option>
            <option value="workflow">Workflow</option>
            <option value="codex">Codex</option>
          </select>
        </label>
        <span>
          {total} 条{total > actions.length ? `（当前显示最近 ${actions.length} 条）` : ''}
        </span>
      </div>
      {error ? (
        <div className="legacy-error" role="alert">
          <p>{error}</p>
          <button className="legacy-button" type="button" onClick={onRetry}>
            重试
          </button>
        </div>
      ) : !loaded ? (
        <MotionLoadingRows count={2} label="正在读取人工操作" />
      ) : actions.length ? (
        <motion.div className="board-actions-list" layout>
          <AnimatePresence initial={false} mode="popLayout">
          {actions.map((action) => (
            <motion.article
              key={action.id}
              layout="position"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={MOTION_TRANSITION.routine}
            >
              <header>
                <div>
                  <h2>{action.title}</h2>
                  <p>{action.prompt}</p>
                </div>
                <span className={cx('resource-status', action.status)}>
                  {action.status === 'pending'
                    ? '待处理'
                    : action.status === 'handled'
                      ? '已处理'
                      : '已忽略'}
                </span>
              </header>
              <small>
                {action.source} · {formatTime(action.createdAt)}
              </small>
              {action.source === 'workflow' && action.status === 'pending' ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    onResolve(action);
                  }}
                >
                  <label>
                    继续运行的输入（JSON）
                    <textarea
                      value={inputs[action.id] ?? '{}'}
                      onChange={(event) => onInput(action.id, event.target.value)}
                    />
                  </label>
                  <div className="dialog-actions">
                    <button
                      className="legacy-button danger"
                      type="button"
                      disabled={Boolean(busy)}
                      onClick={() => onIgnore(action)}
                    >
                      忽略并取消等待
                    </button>
                    <button className="legacy-button primary" disabled={Boolean(busy)}>
                      {busy === `resolve:${action.id}` ? '提交中…' : '提交并继续'}
                    </button>
                  </div>
                </form>
              ) : action.source === 'codex' && action.status === 'pending' ? (
                <div className="board-readonly-action">
                  <span>Codex 审批由宿主权限模型处理，此处只读。</span>
                  {action.sessionId && onOpenSession && (
                    <button
                      className="legacy-button"
                      type="button"
                      onClick={() => onOpenSession(action.sessionId!)}
                    >
                      打开会话
                    </button>
                  )}
                  <button className="legacy-button" type="button" onClick={() => onIgnore(action)}>
                    从列表忽略
                  </button>
                </div>
              ) : action.result !== undefined ? (
                <pre>{JSON.stringify(action.result, null, 2)}</pre>
              ) : null}
            </motion.article>
          ))}
          </AnimatePresence>
        </motion.div>
      ) : (
        <div className="board-empty">
          <h2>没有符合条件的人工操作</h2>
          <p>待处理的 Workflow 输入或只读 Codex 操作会显示在这里。</p>
        </div>
      )}
    </>
  );
}
