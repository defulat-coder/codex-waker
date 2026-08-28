import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import type {
  WakerWorkflow,
  WakerWorkflowSummary,
  WorkflowDefinition,
  WorkflowDeleteImpactRecord,
  WorkflowNode,
  WorkflowRunEventRecord,
  WorkflowRunListResponse,
  WorkflowRunRecord,
  WorkflowMutationResponse,
  WorkflowValidationRequest,
  WorkflowValidationResponse,
  WorkflowVersionListResponse,
  WorkflowVersionRecord,
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
import { fetchLocalResources } from '../lib/api.js';
import { cx } from '../lib/cx.js';
import { useDialogFocus } from '../hooks/useDialogFocus.js';
import { useVisiblePolling } from '../hooks/useVisiblePolling.js';

type WorkflowStatus = WakerWorkflow['status'];
type WorkflowTrace = { run: WorkflowRunRecord; events: WorkflowRunEventRecord[] };
type EditorTrigger = 'create' | 'edit';
type WorkflowEditor = {
  id?: string;
  version?: number;
  name: string;
  description: string;
  projectId: string;
  status: WorkflowStatus;
  definitionText: string;
};

const EMPTY_DEFINITION: WorkflowDefinition = {
  schemaVersion: 1,
  start: 'prepare',
  nodes: [
    { id: 'prepare', kind: 'action', action: 'set', key: 'ready', value: true, next: 'done' },
    { id: 'done', kind: 'terminal', status: 'succeeded' },
  ],
};

const EMPTY_EDITOR: WorkflowEditor = {
  name: '',
  description: '',
  projectId: '',
  status: 'draft',
  definitionText: JSON.stringify(EMPTY_DEFINITION, null, 2),
};

const PAGE_SIZE = 25;
const MAX_VISIBLE_HISTORY = 200;

const STATUS_TEXT: Record<string, string> = {
  draft: '草稿',
  active: '已启用',
  paused: '已暂停',
  error: '定义错误',
  queued: '排队中',
  running: '运行中',
  waiting_input: '等待输入',
  waiting_child: '等待子流程',
  not_run: '未执行',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'AbortError';
}

class ApiRequestError extends Error {
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
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Keep the product-level fallback for non-JSON failures.
    }
    throw new ApiRequestError(message, response.status);
  }
  return response.json() as Promise<T>;
}

function query(wakerId: string): string {
  return new URLSearchParams({ wakerId }).toString();
}

function workflowTabId(workflowId: string): string {
  return `workflow-tab-${encodeURIComponent(workflowId)}`;
}

function workflowPanelId(workflowId: string): string {
  return `workflow-panel-${encodeURIComponent(workflowId)}`;
}

function editorFor(item: WakerWorkflow): WorkflowEditor {
  return {
    id: item.id,
    version: item.version,
    name: item.name,
    description: item.description ?? '',
    projectId: item.projectId ?? '',
    status: item.status === 'error' ? 'draft' : item.status,
    definitionText: JSON.stringify(item.definition ?? EMPTY_DEFINITION, null, 2),
  };
}

export function parseWorkflowDefinition(text: string): {
  definition?: WorkflowDefinition;
  errors: string[];
} {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { errors: ['流程定义不是有效的 JSON'] };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { errors: ['流程定义必须是 JSON 对象'] };
  const candidate = value as Partial<WorkflowDefinition>;
  const errors: string[] = [];
  if (candidate.schemaVersion !== 1) errors.push('schemaVersion 必须为 1');
  if (!candidate.start?.trim()) errors.push('必须指定起始节点 start');
  if (!Array.isArray(candidate.nodes) || candidate.nodes.length === 0)
    errors.push('nodes 至少包含一个节点');
  const ids = new Set<string>();
  for (const node of candidate.nodes ?? []) {
    if (!node || typeof node !== 'object' || !node.id?.trim() || !node.kind?.trim()) {
      errors.push('每个节点都必须包含 id 和 kind');
      continue;
    }
    if (ids.has(node.id)) errors.push(`节点 id 重复：${node.id}`);
    ids.add(node.id);
  }
  if (candidate.start && ids.size > 0 && !ids.has(candidate.start))
    errors.push(`起始节点不存在：${candidate.start}`);
  return errors.length ? { errors } : { definition: candidate as WorkflowDefinition, errors: [] };
}

function parseInput(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('运行参数必须是有效的 JSON');
  }
}

function displayValue(value: unknown): string {
  if (value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > 6_000 ? `${text.slice(0, 6_000)}\n…已截断` : text;
}

function formatTime(value?: string): string {
  return value
    ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(value),
      )
    : '—';
}

function nodeEdges(node: WorkflowNode): Array<{ label: string; target: string }> {
  if (node.kind === 'terminal') return [];
  if (node.kind === 'decision') {
    return [
      ...node.branches.map((branch) => ({
        label: `${node.key} = ${JSON.stringify(branch.equals)}`,
        target: branch.next,
      })),
      { label: '默认', target: node.defaultNext },
    ];
  }
  return [{ label: '下一步', target: node.next }];
}

function nodeStates(events: WorkflowRunEventRecord[]): Map<string, string> {
  const states = new Map<string, string>();
  for (const event of events) {
    if (!event.payload || typeof event.payload !== 'object') continue;
    const nodeId = (event.payload as { nodeId?: unknown }).nodeId;
    if (typeof nodeId !== 'string') continue;
    if (event.type === 'node_started') states.set(nodeId, 'running');
    else if (event.type === 'node_succeeded') states.set(nodeId, 'succeeded');
    else if (event.type === 'node_failed') states.set(nodeId, 'failed');
    else if (event.type === 'paused') states.set(nodeId, 'paused');
    else if (event.type === 'waiting_input') states.set(nodeId, 'waiting_input');
    else if (event.type === 'waiting_child') states.set(nodeId, 'waiting_child');
  }
  return states;
}

export function WorkflowManager({
  wakerId,
  notify,
  onOpenSession,
  initialWorkflowId,
}: {
  wakerId: string;
  notify: (text: string) => void;
  onOpenSession?: (sessionId: string) => void;
  initialWorkflowId?: string;
}) {
  const [items, setItems] = useState<WakerWorkflowSummary[] | null>(null);
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedId, setSelectedId] = useState(initialWorkflowId ?? '');
  const [selectedDetail, setSelectedDetail] = useState<WakerWorkflow | null>(null);
  const [detailError, setDetailError] = useState('');
  const [detailNonce, setDetailNonce] = useState(0);
  const [editor, setEditor] = useState<WorkflowEditor | null>(null);
  const [editorFocusNonce, setEditorFocusNonce] = useState(0);
  const [editorServerErrors, setEditorServerErrors] = useState<string[]>([]);
  const [runs, setRuns] = useState<WorkflowRunRecord[]>([]);
  const [runTotal, setRunTotal] = useState(0);
  const [runsLoading, setRunsLoading] = useState(false);
  const [traces, setTraces] = useState<Record<string, WorkflowTrace>>({});
  const [versions, setVersions] = useState<WorkflowVersionRecord[]>([]);
  const [versionTotal, setVersionTotal] = useState(0);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [diffVersion, setDiffVersion] = useState<number | null>(null);
  const [diff, setDiff] = useState('');
  const [rollbackTarget, setRollbackTarget] = useState<number | null>(null);
  const [runInput, setRunInput] = useState('{}');
  const [resumeInputs, setResumeInputs] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [actionError, setActionError] = useState('');
  const [conflictWorkflowId, setConflictWorkflowId] = useState('');
  const [busy, setBusy] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<WakerWorkflow | null>(null);
  const [deleteImpact, setDeleteImpact] = useState<WorkflowDeleteImpactRecord | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const loadGenerationRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const detailGenerationRef = useRef(0);
  const detailAbortRef = useRef<AbortController | null>(null);
  const runGenerationRef = useRef(0);
  const runAbortRef = useRef<AbortController | null>(null);
  const versionGenerationRef = useRef(0);
  const traceGenerationRef = useRef(0);
  const mutationGenerationRef = useRef(0);
  const hasSnapshotRef = useRef(false);
  const ownerRef = useRef(wakerId);
  const selectedIdRef = useRef(selectedId);
  const runsRef = useRef(runs);
  const workflowListRef = useRef<HTMLElement>(null);
  const editorNameRef = useRef<HTMLInputElement>(null);
  const createTriggerRef = useRef<HTMLButtonElement>(null);
  const editTriggerRef = useRef<HTMLButtonElement>(null);
  const editorTriggerRef = useRef<EditorTrigger | null>(null);
  ownerRef.current = wakerId;
  selectedIdRef.current = selectedId;
  runsRef.current = runs;
  const closeDelete = useCallback(() => {
    if (!busy.startsWith('delete:')) setDeleteTarget(null);
  }, [busy]);
  const deleteDialogRef = useDialogFocus<HTMLDivElement>(Boolean(deleteTarget), closeDelete);

  const openEditor = (value: WorkflowEditor, trigger: EditorTrigger) => {
    editorTriggerRef.current = trigger;
    setActionError('');
    setConflictWorkflowId('');
    setEditorServerErrors([]);
    setEditor(value);
    setEditorFocusNonce((current) => current + 1);
  };

  const closeEditor = (restoreFocus = true) => {
    const trigger = editorTriggerRef.current;
    editorTriggerRef.current = null;
    setEditor(null);
    if (!restoreFocus) return;
    requestAnimationFrame(() => {
      (trigger === 'create' ? createTriggerRef.current : editTriggerRef.current)?.focus();
    });
  };

  useEffect(() => {
    if (!editorFocusNonce) return;
    editorNameRef.current?.focus();
  }, [editorFocusNonce]);

  const load = useCallback(
    async (background = false) => {
      const generation = ++loadGenerationRef.current;
      loadAbortRef.current?.abort();
      const controller = new AbortController();
      loadAbortRef.current = controller;
      if (!background) setError('');
      try {
        const resources = await fetchLocalResources(wakerId, controller.signal);
        if (generation !== loadGenerationRef.current || ownerRef.current !== wakerId) return;
        const workflows = resources.workflows;
        setItems(workflows);
        setProjects(
          resources.projects
            .filter((project) => project.wakerId === wakerId)
            .map(({ id, name }) => ({ id, name })),
        );
        setSelectedId((current) =>
          workflows.some((item) => item.id === current) ? current : (workflows[0]?.id ?? ''),
        );
        setError('');
        setRefreshError('');
        hasSnapshotRef.current = true;
      } catch (cause) {
        if (generation !== loadGenerationRef.current || isAbortError(cause)) return;
        const message = cause instanceof Error ? cause.message : 'WakerFlow 加载失败';
        if (background && hasSnapshotRef.current) setRefreshError(message);
        else setError(message);
      }
    },
    [wakerId],
  );

  const loadRuns = useCallback(
    async (
      workflowId: string,
      offset = 0,
      append = false,
      background = false,
      limit = PAGE_SIZE,
    ) => {
      const generation = ++runGenerationRef.current;
      runAbortRef.current?.abort();
      const controller = new AbortController();
      runAbortRef.current = controller;
      if (!background) setRunsLoading(true);
      try {
        const params = new URLSearchParams({
          wakerId,
          workflowId,
          limit: String(Math.min(limit, MAX_VISIBLE_HISTORY)),
          offset: String(offset),
        });
        const result = await readJson<WorkflowRunListResponse>(
          await fetch(`/api/v1/workflow-runs?${params}`, { signal: controller.signal }),
          '运行记录暂时无法读取',
        );
        if (
          generation !== runGenerationRef.current ||
          ownerRef.current !== wakerId ||
          selectedIdRef.current !== workflowId
        )
          return;
        setRuns((current) => (append ? [...current, ...result.items] : result.items));
        setRunTotal(result.total);
      } catch (cause) {
        if (generation !== runGenerationRef.current || isAbortError(cause)) return;
        if (!background)
          setActionError(cause instanceof Error ? cause.message : '运行记录暂时无法读取');
      } finally {
        if (generation === runGenerationRef.current && ownerRef.current === wakerId)
          setRunsLoading(false);
      }
    },
    [wakerId],
  );

  useEffect(() => {
    mutationGenerationRef.current += 1;
    runGenerationRef.current += 1;
    runAbortRef.current?.abort();
    versionGenerationRef.current += 1;
    setItems(null);
    setSelectedId(initialWorkflowId ?? '');
    setSelectedDetail(null);
    setDetailError('');
    setEditor(null);
    editorTriggerRef.current = null;
    setEditorServerErrors([]);
    setRuns([]);
    setRunTotal(0);
    setRunsLoading(false);
    setTraces({});
    setVersions([]);
    setVersionTotal(0);
    setVersionsLoading(false);
    setDiff('');
    setRollbackTarget(null);
    setResumeInputs({});
    setError('');
    setActionError('');
    setConflictWorkflowId('');
    setBusy('');
    hasSnapshotRef.current = false;
  }, [initialWorkflowId, wakerId]);
  useEffect(
    () => () => {
      loadGenerationRef.current += 1;
      loadAbortRef.current?.abort();
      detailGenerationRef.current += 1;
      detailAbortRef.current?.abort();
      runGenerationRef.current += 1;
      runAbortRef.current?.abort();
      versionGenerationRef.current += 1;
      mutationGenerationRef.current += 1;
    },
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useVisiblePolling(() => {
    void load(true);
    const workflowId = selectedIdRef.current;
    if (workflowId)
      void loadRuns(workflowId, 0, false, true, Math.max(PAGE_SIZE, runsRef.current.length));
  }, 4_000);

  useEffect(() => {
    runGenerationRef.current += 1;
    runAbortRef.current?.abort();
    setRuns([]);
    setRunTotal(0);
    setResumeInputs({});
    if (selectedId) void loadRuns(selectedId);
  }, [loadRuns, selectedId]);

  useEffect(() => {
    const generation = ++detailGenerationRef.current;
    detailAbortRef.current?.abort();
    setSelectedDetail(null);
    setDetailError('');
    setTraces({});
    traceGenerationRef.current += 1;
    setVersions([]);
    setVersionTotal(0);
    versionGenerationRef.current += 1;
    setDiff('');
    setRollbackTarget(null);
    if (!selectedId) return;
    const controller = new AbortController();
    detailAbortRef.current = controller;
    void (async () => {
      try {
        const result = await readJson<WakerWorkflow>(
          await fetch(`/api/v1/workflows/${encodeURIComponent(selectedId)}?${query(wakerId)}`, {
            signal: controller.signal,
          }),
          '流程定义暂时无法读取',
        );
        if (generation === detailGenerationRef.current) {
          setSelectedDetail(result);
          setDetailError('');
        }
      } catch (cause) {
        if (generation !== detailGenerationRef.current || isAbortError(cause)) return;
        setDetailError(cause instanceof Error ? cause.message : '流程定义暂时无法读取');
      }
    })();
  }, [detailNonce, selectedId, wakerId]);

  const selected = selectedDetail;
  const selectedSummary = items?.find((item) => item.id === selectedId);
  useEffect(() => {
    if (selectedDetail && selectedSummary && selectedDetail.version !== selectedSummary.version) {
      setDetailNonce((value) => value + 1);
    }
  }, [selectedDetail, selectedSummary]);
  const definition = selected?.definition ?? EMPTY_DEFINITION;

  const perform = async <T,>(
    key: string,
    action: () => Promise<T>,
    success: string,
    commit?: (value: T) => void,
    workflowId = selectedIdRef.current,
  ) => {
    const owner = wakerId;
    if (ownerRef.current !== owner) return;
    const generation = mutationGenerationRef.current;
    const isCurrent = () =>
      ownerRef.current === owner && mutationGenerationRef.current === generation;
    setBusy(key);
    setActionError('');
    setConflictWorkflowId('');
    try {
      const value = await action();
      if (!isCurrent()) return;
      commit?.(value);
      const refreshes: Promise<void>[] = [load()];
      if (workflowId && selectedIdRef.current === workflowId)
        refreshes.push(loadRuns(workflowId, 0, false, true));
      await Promise.all(refreshes);
      if (!isCurrent()) return;
      notify(success);
    } catch (cause) {
      if (!isCurrent()) return;
      if (cause instanceof ApiRequestError && cause.status === 409 && workflowId) {
        setActionError('流程已由其他请求更新。请读取最新版本后重试。');
        setConflictWorkflowId(workflowId);
        await load();
        return;
      }
      const message = cause instanceof Error ? cause.message : '操作失败';
      setActionError(message);
      notify(message);
    } finally {
      if (isCurrent()) setBusy('');
    }
  };

  const refreshConflict = async () => {
    const workflowId = conflictWorkflowId;
    const owner = wakerId;
    if (!workflowId) return;
    try {
      const fresh = await readJson<WakerWorkflow>(
        await fetch(`/api/v1/workflows/${encodeURIComponent(workflowId)}?${query(owner)}`),
        '最新流程定义暂时无法读取',
      );
      if (ownerRef.current !== owner) return;
      setSelectedId(fresh.id);
      setSelectedDetail(fresh);
      if (editor?.id === fresh.id) openEditor(editorFor(fresh), 'edit');
      if (deleteTarget?.id === fresh.id) setDeleteTarget(fresh);
      setActionError('');
      setConflictWorkflowId('');
    } catch (cause) {
      if (ownerRef.current !== owner) return;
      setActionError(cause instanceof Error ? cause.message : '最新流程定义暂时无法读取');
    }
  };

  const submitEditor = async (event: FormEvent) => {
    event.preventDefault();
    if (!editor) return;
    const owner = wakerId;
    const parsed = parseWorkflowDefinition(editor.definitionText);
    if (!editor.name.trim() || parsed.errors.length || !parsed.definition) return;
    setEditorServerErrors([]);
    let validated: WorkflowValidationResponse;
    try {
      const validationRequest: WorkflowValidationRequest = {
        wakerId: owner,
        ...(editor.id ? { workflowId: editor.id } : {}),
        script: editor.definitionText,
      };
      validated = await readJson<WorkflowValidationResponse>(
        await fetch('/api/v1/workflows/validate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(validationRequest),
        }),
        '流程定义暂时无法验证',
      );
    } catch (cause) {
      if (ownerRef.current === owner)
        setEditorServerErrors([cause instanceof Error ? cause.message : '流程定义暂时无法验证']);
      return;
    }
    if (ownerRef.current !== owner) return;
    if (!validated.valid || !validated.definition) {
      setEditorServerErrors(validated.errors.length ? validated.errors : ['流程定义未通过验证']);
      return;
    }
    await perform(
      `save:${editor.id ?? 'new'}`,
      async () => {
        const response = await fetch(
          editor.id ? `/api/v1/workflows/${encodeURIComponent(editor.id)}` : '/api/v1/workflows',
          {
            method: editor.id ? 'PATCH' : 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              wakerId: owner,
              name: editor.name.trim(),
              description: editor.description.trim(),
              projectId: editor.projectId || null,
              status: editor.status,
              definition: validated.definition,
              ...(editor.id ? { expectedVersion: editor.version } : {}),
            }),
          },
        );
        return readJson<WakerWorkflow>(response, '流程定义暂时无法保存');
      },
      editor.id ? '流程定义已保存' : 'WakerFlow 已创建',
      (saved) => {
        setSelectedId(saved.id);
        setSelectedDetail(saved);
        closeEditor();
      },
      editor.id,
    );
  };

  const loadVersions = async (offset = 0) => {
    if (!selected) return;
    const workflowId = selected.id;
    const owner = wakerId;
    const generation = ++versionGenerationRef.current;
    setVersionsLoading(true);
    try {
      const params = new URLSearchParams({
        wakerId: owner,
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      const result = await readJson<WorkflowVersionListResponse>(
        await fetch(`/api/v1/workflows/${encodeURIComponent(workflowId)}/versions?${params}`),
        '版本记录暂时无法读取',
      );
      if (
        generation !== versionGenerationRef.current ||
        ownerRef.current !== owner ||
        selectedIdRef.current !== workflowId
      )
        return;
      setVersions((current) => (offset ? [...current, ...result.items] : result.items));
      setVersionTotal(result.total);
      if (!offset)
        setDiffVersion(
          result.items.find((item) => item.version !== selected.version)?.version ?? null,
        );
    } catch (cause) {
      if (generation !== versionGenerationRef.current || ownerRef.current !== owner) return;
      setActionError(cause instanceof Error ? cause.message : '版本记录暂时无法读取');
    } finally {
      if (generation === versionGenerationRef.current && ownerRef.current === owner)
        setVersionsLoading(false);
    }
  };

  const loadDiff = async (version: number) => {
    if (!selected) return;
    try {
      const params = new URLSearchParams({
        wakerId,
        fromVersion: String(version),
        toVersion: String(selected.version ?? version),
      });
      const result = await readJson<{ diff: string }>(
        await fetch(`/api/v1/workflows/${encodeURIComponent(selected.id)}/diff?${params}`),
        '版本差异暂时无法读取',
      );
      setDiffVersion(version);
      setDiff(result.diff);
      setRollbackTarget(null);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '版本差异暂时无法读取');
    }
  };

  const rollback = async (apply: boolean) => {
    if (!selected || diffVersion === null) return;
    await perform(
      `${apply ? 'rollback' : 'preview-rollback'}:${selected.id}`,
      async () =>
        readJson<WorkflowMutationResponse>(
          await fetch(`/api/v1/workflows/${encodeURIComponent(selected.id)}/rollback`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              wakerId,
              targetVersion: diffVersion,
              expectedVersion: selected.version,
              apply,
            }),
          }),
          apply ? '版本暂时无法回滚' : '回滚预览暂时无法生成',
        ),
      apply ? `已从 v${diffVersion} 创建回滚版本` : `已预览回滚到 v${diffVersion} 的差异`,
      (result) => {
        setDiff(result.diff);
        if (apply) {
          setSelectedDetail(result.workflow);
          setVersions([]);
          setRollbackTarget(null);
        } else {
          setRollbackTarget(diffVersion);
        }
      },
      selected.id,
    );
  };

  const loadTrace = async (runId: string) => {
    const generation = traceGenerationRef.current;
    try {
      const result = await readJson<WorkflowTrace>(
        await fetch(`/api/v1/workflow-runs/${encodeURIComponent(runId)}/trace?${query(wakerId)}`),
        '运行轨迹暂时无法读取',
      );
      if (generation === traceGenerationRef.current)
        setTraces((current) => ({ ...current, [runId]: result }));
    } catch (cause) {
      if (generation !== traceGenerationRef.current) return;
      setActionError(cause instanceof Error ? cause.message : '运行轨迹暂时无法读取');
    }
  };

  const run = async () => {
    if (!selected) return;
    let input: unknown;
    try {
      input = parseInput(runInput);
    } catch (cause) {
      setActionError((cause as Error).message);
      return;
    }
    await perform(
      `run:${selected.id}`,
      async () =>
        readJson(
          await fetch(`/api/v1/workflows/${encodeURIComponent(selected.id)}/run`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ wakerId, input }),
          }),
          'WakerFlow 暂时无法运行',
        ),
      '运行已进入队列',
      undefined,
      selected.id,
    );
  };

  const runAction = async (runId: string, action: 'resume' | 'cancel' | 'retry') => {
    let input: unknown;
    if (action === 'resume') {
      try {
        input = parseInput(resumeInputs[runId] ?? '{}');
      } catch (cause) {
        setActionError((cause as Error).message);
        return;
      }
    }
    await perform(
      `${action}:${runId}`,
      async () =>
        readJson(
          await fetch(`/api/v1/workflow-runs/${encodeURIComponent(runId)}/${action}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ wakerId, ...(action === 'resume' ? { input } : {}) }),
          }),
          action === 'retry' ? '运行暂时无法重试' : '运行状态暂时无法更新',
        ),
      action === 'resume' ? '运行已继续' : action === 'retry' ? '已创建重试运行' : '运行已取消',
      () => {
        if (action !== 'resume') return;
        setResumeInputs((current) => {
          const next = { ...current };
          delete next[runId];
          return next;
        });
      },
      selectedIdRef.current,
    );
  };

  const inspectDelete = async (item: WakerWorkflow) => {
    setDeleteTarget(item);
    setDeleteImpact(null);
    setDeleteError('');
    try {
      setDeleteImpact(
        await readJson<WorkflowDeleteImpactRecord>(
          await fetch(
            `/api/v1/workflows/${encodeURIComponent(item.id)}/delete-impact?${query(wakerId)}`,
          ),
          '删除影响暂时无法读取',
        ),
      );
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : '删除影响暂时无法读取');
    }
  };

  const parsedEditor = editor ? parseWorkflowDefinition(editor.definitionText) : null;
  const visibleRunTotal = Math.min(runTotal, MAX_VISIBLE_HISTORY);
  const visibleVersionTotal = Math.min(versionTotal, MAX_VISIBLE_HISTORY);

  const selectWorkflow = (workflowId: string) => {
    setSelectedId(workflowId);
    if (editor) closeEditor(false);
    setVersions([]);
    setVersionTotal(0);
    setDiff('');
  };

  const onWorkflowTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!items?.length) return;
    let nextIndex = index;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown')
      nextIndex = (index + 1) % items.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
      nextIndex = (index - 1 + items.length) % items.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = items.length - 1;
    else return;
    event.preventDefault();
    selectWorkflow(items[nextIndex]!.id);
    requestAnimationFrame(() => {
      const tabs = workflowListRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
      tabs?.[nextIndex]?.focus();
    });
  };

  return (
    <section className="legacy-page workflow-manager" aria-labelledby="workflows-title">
      <header className="legacy-page-header">
        <div>
          <h1 id="workflows-title">WakerFlow</h1>
          <p>用可验证的节点定义编排本地任务，并从每次运行继续、回看或重试。</p>
        </div>
        <button
          ref={createTriggerRef}
          className="legacy-button primary"
          type="button"
          onClick={() => openEditor({ ...EMPTY_EDITOR }, 'create')}
        >
          <Plus size={15} />
          新建流程
        </button>
      </header>

      {refreshError && (
        <div className="automation-refresh-warning" role="status">
          <span>自动刷新失败，仍显示上次数据：{refreshError}</span>
          <button className="legacy-button" type="button" onClick={() => void load(true)}>
            <ArrowClockwise size={14} />
            重新读取
          </button>
        </div>
      )}
      {actionError && (
        <div className="automation-action-error" role="alert">
          <span>{actionError}</span>
          {conflictWorkflowId && (
            <button className="legacy-button" type="button" onClick={() => void refreshConflict()}>
              读取最新版本
            </button>
          )}
        </div>
      )}

      {error ? (
        <div className="legacy-error">
          <p>{error}</p>
          <button className="legacy-button" type="button" onClick={() => void load()}>
            重试
          </button>
        </div>
      ) : !items ? (
        <div className="loading-rows" aria-label="正在加载 WakerFlow">
          <i />
          <i />
          <i />
        </div>
      ) : (
        <div className="workflow-workspace">
          <nav
            ref={workflowListRef}
            className="workflow-list"
            aria-label="WakerFlow 列表"
            aria-orientation="vertical"
            role="tablist"
          >
            {items.map((item, index) => (
              <button
                className={cx(selectedId === item.id && 'active')}
                type="button"
                key={item.id}
                id={workflowTabId(item.id)}
                role="tab"
                aria-selected={selectedId === item.id}
                aria-controls={workflowPanelId(item.id)}
                tabIndex={selectedId === item.id ? 0 : -1}
                onClick={() => selectWorkflow(item.id)}
                onKeyDown={(event) => onWorkflowTabKeyDown(event, index)}
              >
                <span>
                  <strong>{item.name}</strong>
                  <small>
                    v{item.version} · {item.nodeCount} 个节点
                  </small>
                </span>
                <span className={cx('resource-status', item.status)}>
                  {STATUS_TEXT[item.status] ?? item.status}
                </span>
              </button>
            ))}
            {!items.length && <p className="outputs-empty">还没有 WakerFlow</p>}
          </nav>

          <main
            className="workflow-detail"
            id={selectedId ? workflowPanelId(selectedId) : undefined}
            role={selectedId ? 'tabpanel' : undefined}
            aria-labelledby={selectedId ? workflowTabId(selectedId) : undefined}
            tabIndex={selectedId ? 0 : undefined}
          >
            {editor ? (
              <form className="workflow-editor" onSubmit={submitEditor}>
                <div className="workflow-detail-header">
                  <div>
                    <h2>{editor.id ? '编辑流程定义' : '新建 WakerFlow'}</h2>
                    <p>保存前会验证入口、节点 ID 和服务端执行约束。</p>
                  </div>
                  <button
                    className="icon-button"
                    type="button"
                    aria-label="关闭编辑器"
                    onClick={() => closeEditor()}
                  >
                    <X size={18} />
                  </button>
                </div>
                <div className="workflow-editor-grid">
                  <label>
                    名称
                    <input
                      ref={editorNameRef}
                      aria-label="名称"
                      value={editor.name}
                      aria-invalid={!editor.name.trim()}
                      onChange={(event) => setEditor({ ...editor, name: event.target.value })}
                    />
                    {!editor.name.trim() && (
                      <small className="workflow-field-error">请输入流程名称</small>
                    )}
                  </label>
                  <label>
                    状态
                    <select
                      value={editor.status}
                      onChange={(event) =>
                        setEditor({ ...editor, status: event.target.value as WorkflowStatus })
                      }
                    >
                      <option value="draft">草稿</option>
                      <option value="active">已启用</option>
                      <option value="paused">已暂停</option>
                    </select>
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
                </div>
                <label>
                  说明
                  <textarea
                    className="workflow-description-input"
                    value={editor.description}
                    onChange={(event) => setEditor({ ...editor, description: event.target.value })}
                  />
                </label>
                <label>
                  节点定义（JSON）
                  <textarea
                    className="workflow-definition-input"
                    spellCheck={false}
                    aria-invalid={Boolean(parsedEditor?.errors.length || editorServerErrors.length)}
                    value={editor.definitionText}
                    onChange={(event) => {
                      setEditorServerErrors([]);
                      setEditor({ ...editor, definitionText: event.target.value });
                    }}
                  />
                </label>
                {parsedEditor?.errors.length || editorServerErrors.length ? (
                  <ul className="workflow-validation" aria-label="定义错误">
                    {[...(parsedEditor?.errors ?? []), ...editorServerErrors].map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="workflow-definition-valid" role="status">
                    定义有效 · {parsedEditor?.definition?.nodes.length ?? 0} 个节点
                  </p>
                )}
                <div className="dialog-actions">
                  <button className="legacy-button" type="button" onClick={() => closeEditor()}>
                    取消
                  </button>
                  <button
                    className="legacy-button primary"
                    disabled={Boolean(!editor.name.trim() || parsedEditor?.errors.length || busy)}
                  >
                    <FloppyDisk size={15} />
                    {busy.startsWith('save:') ? '保存中…' : '保存定义'}
                  </button>
                </div>
              </form>
            ) : selected ? (
              <>
                <div className="workflow-detail-header">
                  <div>
                    <div className="workflow-title-line">
                      <h2>{selected.name}</h2>
                      <span className={cx('resource-status', selected.status)}>
                        {STATUS_TEXT[selected.status] ?? selected.status}
                      </span>
                    </div>
                    <p>
                      {selected.description || '没有流程说明'} · v{selected.version ?? 1}
                    </p>
                  </div>
                  <div className="page-actions">
                    <button
                      ref={editTriggerRef}
                      className="legacy-button"
                      type="button"
                      onClick={() => openEditor(editorFor(selected), 'edit')}
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
                </div>

                {Boolean(selected.validationErrors?.length) && (
                  <ul className="workflow-validation" aria-label="服务端定义错误">
                    {selected.validationErrors?.map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                )}

                <section className="workflow-section" aria-labelledby="workflow-map-title">
                  <div className="workflow-section-heading">
                    <div>
                      <h3 id="workflow-map-title">节点路径图</h3>
                      <p>每行表示一个节点；右侧明确列出下一步、条件分支与默认边。</p>
                    </div>
                  </div>
                  <ol className="workflow-node-list">
                    {definition.nodes.map((node) => (
                      <li key={node.id}>
                        <span className="workflow-node-index">
                          {node.id === definition.start ? '起' : ''}
                        </span>
                        <span>
                          <strong>{node.id}</strong>
                          <small>{node.kind}</small>
                        </span>
                        <code aria-label={`${node.id} 的路径`}>
                          {nodeEdges(node).length
                            ? nodeEdges(node)
                                .map((edge) => `${edge.label} → ${edge.target}`)
                                .join(' · ')
                            : '结束'}
                        </code>
                      </li>
                    ))}
                  </ol>
                </section>

                <section className="workflow-section" aria-labelledby="workflow-versions-title">
                  <div className="workflow-section-heading">
                    <div>
                      <h3 id="workflow-versions-title">版本</h3>
                      <p>保存会创建不可变快照；回滚也会生成新版本。</p>
                    </div>
                    <button
                      className="legacy-button"
                      type="button"
                      disabled={versionsLoading}
                      onClick={() => void loadVersions()}
                    >
                      {versionsLoading && !versions.length ? '读取中…' : '读取版本'}
                    </button>
                  </div>
                  {versions.length > 0 && (
                    <div className="workflow-version-tools">
                      <label>
                        对比版本
                        <select
                          value={diffVersion ?? ''}
                          onChange={(event) => void loadDiff(Number(event.target.value))}
                        >
                          <option value="">选择版本</option>
                          {versions
                            .filter((item) => item.version !== selected.version)
                            .map((item) => (
                              <option key={item.version} value={item.version}>
                                v{item.version} · {formatTime(item.createdAt)}
                              </option>
                            ))}
                        </select>
                      </label>
                      {diffVersion !== null && (
                        <>
                          <button
                            className="legacy-button"
                            type="button"
                            disabled={Boolean(busy)}
                            onClick={() => void rollback(false)}
                          >
                            预览回滚
                          </button>
                          {rollbackTarget === diffVersion && (
                            <button
                              className="legacy-button danger"
                              type="button"
                              disabled={Boolean(busy)}
                              onClick={() => void rollback(true)}
                            >
                              应用回滚到 v{diffVersion}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  )}
                  {diff && <pre className="workflow-diff">{diff}</pre>}
                  {versions.length > 0 && (
                    <div className="dialog-actions">
                      <small>
                        已显示 {versions.length} / {versionTotal}
                        {versionTotal > MAX_VISIBLE_HISTORY ? '（最多显示最近 200 条）' : ''}
                      </small>
                      {versions.length < visibleVersionTotal && (
                        <button
                          className="legacy-button"
                          type="button"
                          disabled={versionsLoading}
                          onClick={() => void loadVersions(versions.length)}
                        >
                          {versionsLoading ? '加载中…' : '加载更多版本'}
                        </button>
                      )}
                    </div>
                  )}
                </section>

                <section className="workflow-section" aria-labelledby="workflow-runs-title">
                  <div className="workflow-section-heading">
                    <div>
                      <h3 id="workflow-runs-title">运行</h3>
                      <p>参数随运行快照保存，刷新后仍可继续等待中的节点。</p>
                    </div>
                  </div>
                  <div className="workflow-run-create">
                    <label>
                      运行参数（JSON）
                      <textarea
                        value={runInput}
                        spellCheck={false}
                        onChange={(event) => setRunInput(event.target.value)}
                      />
                    </label>
                    <button
                      className="legacy-button primary"
                      type="button"
                      disabled={selected.status !== 'active' || Boolean(busy)}
                      onClick={() => void run()}
                    >
                      <Play size={15} />
                      {busy.startsWith('run:') ? '排队中…' : '创建运行'}
                    </button>
                  </div>
                  <div className="workflow-run-history">
                    {runs.length ? (
                      runs.map((runRecord) => (
                        <WorkflowRunDetails
                          key={runRecord.id}
                          run={runRecord}
                          trace={traces[runRecord.id]}
                          busy={busy}
                          resumeInput={resumeInputs[runRecord.id] ?? '{}'}
                          onResumeInput={(value) =>
                            setResumeInputs((current) => ({ ...current, [runRecord.id]: value }))
                          }
                          onOpen={() => void loadTrace(runRecord.id)}
                          onAction={(action) => void runAction(runRecord.id, action)}
                          onOpenSession={onOpenSession}
                        />
                      ))
                    ) : runsLoading ? (
                      <p className="outputs-empty" role="status">
                        正在读取运行记录…
                      </p>
                    ) : (
                      <p className="outputs-empty">暂无运行记录</p>
                    )}
                  </div>
                  {runs.length > 0 && (
                    <div className="dialog-actions">
                      <small>
                        已显示 {runs.length} / {runTotal}
                        {runTotal > MAX_VISIBLE_HISTORY ? '（最多显示最近 200 条）' : ''}
                      </small>
                      {runs.length < visibleRunTotal && (
                        <button
                          className="legacy-button"
                          type="button"
                          disabled={runsLoading}
                          onClick={() => void loadRuns(selected.id, runs.length, true)}
                        >
                          {runsLoading ? '加载中…' : '加载更多运行'}
                        </button>
                      )}
                    </div>
                  )}
                </section>
              </>
            ) : detailError ? (
              <div className="legacy-error">
                <p>{detailError}</p>
                <button
                  className="legacy-button"
                  type="button"
                  onClick={() => setDetailNonce((value) => value + 1)}
                >
                  重新读取定义
                </button>
              </div>
            ) : selectedId ? (
              <div className="loading-rows" aria-label="正在读取流程定义">
                <i />
                <i />
                <i />
              </div>
            ) : (
              <div className="automation-empty">
                <h2>创建第一个 WakerFlow</h2>
                <p>用 JSON 节点定义连接 Codex、判断、等待、人工输入和子流程。</p>
                <button
                  className="legacy-button primary"
                  type="button"
                  onClick={() => openEditor({ ...EMPTY_EDITOR }, 'create')}
                >
                  <Plus size={15} />
                  新建流程
                </button>
              </div>
            )}
          </main>
        </div>
      )}

      {deleteTarget && (
        <div className="modal-backdrop" onMouseDown={closeDelete}>
          <div
            ref={deleteDialogRef}
            className="workflow-delete-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="workflow-delete-title"
            tabIndex={-1}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="workflow-delete-title">删除“{deleteTarget.name}”？</h2>
            <p>流程定义会从列表移除；不可变版本、运行轨迹和会话继续保留。</p>
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
                  <dt>版本</dt>
                  <dd>{deleteImpact.versions}</dd>
                </div>
                <div>
                  <dt>运行</dt>
                  <dd>{deleteImpact.runs}</dd>
                </div>
                <div>
                  <dt>活跃运行</dt>
                  <dd>{deleteImpact.activeRuns}</dd>
                </div>
                <div>
                  <dt>引用</dt>
                  <dd>{deleteImpact.referencedBy.length}</dd>
                </div>
              </dl>
            ) : (
              <p role="status">正在检查删除影响…</p>
            )}
            {deleteImpact &&
              (deleteImpact.activeRuns > 0 || deleteImpact.referencedBy.length > 0) && (
                <p className="workflow-delete-blocked" role="alert">
                  {deleteImpact.activeRuns > 0
                    ? '请先取消所有活跃运行。'
                    : `请先移除其他流程中的引用：${deleteImpact.referencedBy.join('、')}`}
                </p>
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
                disabled={
                  Boolean(busy) ||
                  !deleteImpact ||
                  deleteImpact.activeRuns > 0 ||
                  deleteImpact.referencedBy.length > 0
                }
                onClick={() =>
                  void perform(
                    `delete:${deleteTarget.id}`,
                    async () => {
                      const response = await fetch(
                        `/api/v1/workflows/${encodeURIComponent(deleteTarget.id)}?${new URLSearchParams(
                          {
                            wakerId,
                            expectedVersion: String(deleteTarget.version ?? 1),
                          },
                        )}`,
                        { method: 'DELETE' },
                      );
                      if (!response.ok) await readJson<never>(response, 'WakerFlow 暂时无法删除');
                    },
                    'WakerFlow 已删除',
                    () => {
                      setDeleteTarget(null);
                      setSelectedId('');
                    },
                    deleteTarget.id,
                  )
                }
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function WorkflowRunDetails({
  run,
  trace,
  busy,
  resumeInput,
  onResumeInput,
  onOpen,
  onAction,
  onOpenSession,
}: {
  run: WorkflowRunRecord;
  trace?: WorkflowTrace;
  busy: string;
  resumeInput: string;
  onResumeInput: (value: string) => void;
  onOpen: () => void;
  onAction: (action: 'resume' | 'cancel' | 'retry') => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const states = nodeStates(trace?.events ?? []);
  const sessionId = trace?.run.sessionId ?? run.sessionId;
  const snapshotDefinition =
    run.definitionSnapshot ?? parseWorkflowDefinition(run.scriptSnapshot).definition;
  const waitingPrompt = [...(trace?.events ?? [])]
    .reverse()
    .find((event) => event.type === 'waiting_input')?.payload;
  const waitingPromptText =
    waitingPrompt && typeof waitingPrompt === 'object'
      ? (waitingPrompt as { prompt?: unknown }).prompt
      : undefined;
  return (
    <details
      className="workflow-run"
      onToggle={(event) => {
        if (event.currentTarget.open) onOpen();
      }}
    >
      <summary>
        <span className={cx('workflow-run-dot', run.status)} />
        <span>
          <strong>{STATUS_TEXT[run.status] ?? run.status}</strong>
          <small>
            v{run.workflowVersion} · {formatTime(run.createdAt)} · {run.id.slice(0, 8)}
          </small>
        </span>
        <span className={cx('resource-status', run.status)}>
          {STATUS_TEXT[run.status] ?? run.status}
        </span>
        <CaretDown className="workflow-run-caret" size={15} />
      </summary>
      <div className="workflow-run-detail">
        <div className="workflow-run-actions">
          <button className="legacy-button" type="button" onClick={onOpen}>
            <ArrowClockwise size={14} />
            刷新轨迹
          </button>
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
          {['queued', 'running', 'paused', 'waiting_input', 'waiting_child'].includes(
            run.status,
          ) && (
            <button
              className="legacy-button danger"
              type="button"
              disabled={Boolean(busy)}
              onClick={() => onAction('cancel')}
            >
              <Pause size={14} />
              取消
            </button>
          )}
          {['failed', 'cancelled'].includes(run.status) && (
            <button
              className="legacy-button"
              type="button"
              disabled={Boolean(busy)}
              onClick={() => onAction('retry')}
            >
              <ArrowClockwise size={14} />
              重试
            </button>
          )}
        </div>
        {run.status === 'waiting_input' && (
          <form
            className="workflow-resume-form"
            onSubmit={(event) => {
              event.preventDefault();
              onAction('resume');
            }}
          >
            <label>
              继续运行的输入（JSON）
              {typeof waitingPromptText === 'string' && <small>{waitingPromptText}</small>}
              <textarea
                aria-label="继续运行的输入（JSON）"
                value={resumeInput}
                onChange={(event) => onResumeInput(event.target.value)}
              />
            </label>
            <button className="legacy-button primary" disabled={Boolean(busy)}>
              提交并继续
            </button>
          </form>
        )}
        <dl>
          <div>
            <dt>创建</dt>
            <dd>{formatTime(run.createdAt)}</dd>
          </div>
          <div>
            <dt>开始</dt>
            <dd>{formatTime(run.startedAt)}</dd>
          </div>
          <div>
            <dt>结束</dt>
            <dd>{formatTime(run.completedAt)}</dd>
          </div>
        </dl>
        {run.error && <p className="automation-run-error">{run.error}</p>}
        {run.input !== undefined && (
          <div>
            <b>输入</b>
            <pre>{displayValue(run.input)}</pre>
          </div>
        )}
        {run.output !== undefined && (
          <div>
            <b>输出</b>
            <pre>{displayValue(run.output)}</pre>
          </div>
        )}
        {snapshotDefinition && trace && (
          <ol className="workflow-run-node-progress" aria-label="节点进度">
            {snapshotDefinition.nodes.map((node) => {
              const state =
                node.id === trace.run.currentNodeId &&
                ['succeeded', 'failed', 'cancelled'].includes(trace.run.status)
                  ? trace.run.status
                  : (states.get(node.id) ??
                    (['succeeded', 'failed', 'cancelled'].includes(trace.run.status)
                      ? 'not_run'
                      : 'queued'));
              return (
                <li key={node.id}>
                  <span className={cx('workflow-trace-dot', state)} />
                  <span>
                    <strong>{node.name || node.id}</strong>
                    <small>{node.kind}</small>
                  </span>
                  <span className={cx('resource-status', state)}>
                    {STATUS_TEXT[state] ?? state}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
        {trace ? (
          <ol className="workflow-trace">
            {trace.events.map((event) => {
              const payload =
                event.payload && typeof event.payload === 'object'
                  ? (event.payload as { nodeId?: string })
                  : {};
              return (
                <li key={event.id}>
                  <span
                    className={cx(
                      'workflow-trace-dot',
                      payload.nodeId && states.get(payload.nodeId),
                    )}
                  />
                  <span>
                    <strong>
                      #{event.sequence} {event.type}
                    </strong>
                    <small>
                      {formatTime(event.createdAt)}
                      {payload.nodeId ? ` · ${payload.nodeId}` : ''}
                    </small>
                  </span>
                  {event.payload !== undefined && <code>{displayValue(event.payload)}</code>}
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="outputs-empty">展开后读取运行轨迹</p>
        )}
      </div>
    </details>
  );
}
