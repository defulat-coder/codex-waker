import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import type {
  AgentDeleteImpact,
  AgentSummary,
  KnowledgeDocument,
  KnowledgeNotebook,
  KnowledgeSearchMode,
  KnowledgeSearchResponse,
  LocalResourcesResponse,
  WakerProject,
  WakerTask,
  WakerWorkflow,
} from '@waker/contracts';
import { ChatCircle } from '@phosphor-icons/react/dist/icons/ChatCircle';
import { CheckSquare } from '@phosphor-icons/react/dist/icons/CheckSquare';
import { FlowArrow } from '@phosphor-icons/react/dist/icons/FlowArrow';
import { GearSix } from '@phosphor-icons/react/dist/icons/GearSix';
import { Globe } from '@phosphor-icons/react/dist/icons/Globe';
import { Robot } from '@phosphor-icons/react/dist/icons/Robot';
import { BookOpenText } from '@phosphor-icons/react/dist/icons/BookOpenText';
import { Plus } from '@phosphor-icons/react/dist/icons/Plus';
import { Plugs } from '@phosphor-icons/react/dist/icons/Plugs';
import { PuzzlePiece } from '@phosphor-icons/react/dist/icons/PuzzlePiece';
import { MagnifyingGlass } from '@phosphor-icons/react/dist/icons/MagnifyingGlass';
import { UploadSimple } from '@phosphor-icons/react/dist/icons/UploadSimple';
import {
  createKnowledgeNotebook,
  createKnowledgeBinding,
  deleteKnowledgeDocument,
  fetchKnowledgeAudits,
  fetchKnowledgeBindings,
  rebuildKnowledge,
  updateKnowledgeDocument,
  createLocalResource,
  fetchKnowledgeDocuments,
  fetchKnowledgeNotebooks,
  fetchLocalResources,
  searchKnowledge,
  upsertKnowledgeDocument,
  deleteAgent,
  fetchAgentDeleteImpact,
  importAgentDefinition,
} from '../lib/api.js';
import { cx } from '../lib/cx.js';
import { AgentChip } from './AgentChip.js';
import { NewAgentDialog } from './NewAgentDialog.js';
import { useDialogFocus } from '../hooks/useDialogFocus.js';

export type LegacyView =
  | 'wakers'
  | 'chat'
  | 'im'
  | 'workflows'
  | 'tasks'
  | 'projects'
  | 'knowledge'
  | 'skills'
  | 'memory'
  | 'capabilities'
  | 'settings';

const NAV: { id: LegacyView; label: string; icon: ReactNode }[] = [
  { id: 'wakers', label: 'Waker 管理', icon: <Robot size={22} /> },
  { id: 'chat', label: 'Chat', icon: <ChatCircle size={22} /> },
  { id: 'im', label: 'IM', icon: <Plugs size={22} /> },
  { id: 'workflows', label: 'WakerFlow', icon: <FlowArrow size={22} /> },
  { id: 'tasks', label: '任务看板', icon: <CheckSquare size={22} /> },
  { id: 'projects', label: '项目', icon: <Globe size={22} /> },
  { id: 'knowledge', label: '知识库', icon: <BookOpenText size={22} /> },
  { id: 'skills', label: 'Skills', icon: <PuzzlePiece size={22} /> },
  { id: 'settings', label: '设置', icon: <GearSix size={22} /> },
];

export function LegacyRail({
  active,
  unreadCount,
  onChange,
}: {
  active: LegacyView;
  unreadCount: number;
  onChange: (view: LegacyView) => void;
}) {
  return (
    <nav className="legacy-rail" aria-label="主导航">
      <button
        type="button"
        className="legacy-logo"
        onClick={() => onChange('wakers')}
        aria-label="Waker 首页"
      >
        <img src="/legacy/qoderwake-icon-cn.svg" alt="" />
      </button>
      <div className="legacy-rail-links">
        {NAV.map((item) => (
          <button
            type="button"
            key={item.id}
            className={cx('legacy-rail-button', active === item.id && 'active')}
            aria-current={active === item.id ? 'page' : undefined}
            aria-label={item.label}
            title={item.label}
            onClick={() => onChange(item.id)}
          >
            {item.icon}
            <span>{item.label}</span>
            {item.id === 'chat' && unreadCount > 0 && (
              <b className="legacy-unread" aria-label={`${unreadCount} 个未读会话`}>
                {unreadCount}
              </b>
            )}
          </button>
        ))}
      </div>
    </nav>
  );
}

export function WakersView({
  agents,
  onChat,
  onConfigure,
  onMemory,
  onCapabilities,
  onAutomation,
  onCreated,
  onDeleted,
  notify,
  onboarding,
}: {
  agents: AgentSummary[];
  onChat: (id: string) => void;
  onConfigure: (id: string) => void;
  onMemory: (id: string) => void;
  onCapabilities: (id: string) => void;
  onAutomation: (id: string) => void;
  onCreated: (id: string) => void;
  onDeleted: (id: string) => void;
  notify: (message: string) => void;
  onboarding?: ReactNode;
}) {
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AgentSummary | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [deleteImpact, setDeleteImpact] = useState<AgentDeleteImpact | null>(null);
  const [deleteImpactError, setDeleteImpactError] = useState('');
  const deleteImpactGenerationRef = useRef(0);
  const deleteTargetIdRef = useRef<string | null>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);
  const deleteWasOpen = useRef(false);
  const importRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const closeDeleteDialog = useCallback(() => {
    deleteImpactGenerationRef.current += 1;
    deleteTargetIdRef.current = null;
    setDeleteTarget(null);
    setDeleteConfirmation('');
    setDeleteImpact(null);
    setDeleteImpactError('');
  }, []);
  const deleteDialogRef = useDialogFocus<HTMLFormElement>(Boolean(deleteTarget), closeDeleteDialog);
  useEffect(() => {
    if (deleteTarget) deleteWasOpen.current = true;
    else if (deleteWasOpen.current) {
      deleteWasOpen.current = false;
      deleteTriggerRef.current?.focus();
    }
  }, [deleteTarget]);
  const loadDeleteImpact = useCallback(async (agent: AgentSummary) => {
    const generation = ++deleteImpactGenerationRef.current;
    deleteTargetIdRef.current = agent.id;
    setDeleteImpact(null);
    setDeleteImpactError('');
    try {
      const impact = await fetchAgentDeleteImpact(agent.id);
      if (
        generation !== deleteImpactGenerationRef.current ||
        deleteTargetIdRef.current !== agent.id
      )
        return;
      setDeleteImpact(impact);
    } catch (cause) {
      if (
        generation !== deleteImpactGenerationRef.current ||
        deleteTargetIdRef.current !== agent.id
      )
        return;
      setDeleteImpactError(cause instanceof Error ? cause.message : 'Waker 删除影响暂时无法读取');
    }
  }, []);
  const visibleAgents = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return agents;
    return agents.filter((agent) =>
      [agent.name, agent.tagline, agent.description].some((value) =>
        value.toLocaleLowerCase().includes(normalized),
      ),
    );
  }, [agents, query]);
  return (
    <section className="legacy-page" aria-labelledby="wakers-title">
      <PageHeader title="Waker" detail="创建并管理运行在本机的 Codex 智能体。">
        <button type="button" className="legacy-button" onClick={() => importRef.current?.click()}>
          <UploadSimple size={15} />
          导入 Markdown
        </button>
        <input
          ref={importRef}
          className="visually-hidden"
          type="file"
          accept=".md,text/markdown"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            try {
              const created = await importAgentDefinition({
                id: file.name.replace(/\.md$/i, ''),
                content: await file.text(),
              });
              onCreated(created.id);
            } catch (cause) {
              notify(cause instanceof Error ? cause.message : '导入失败');
            } finally {
              event.target.value = '';
            }
          }}
        />
        <button type="button" className="legacy-button primary" onClick={() => setCreating(true)}>
          <Plus size={16} /> 新建 Waker
        </button>
      </PageHeader>
      {onboarding}
      {agents.length > 0 && (
        <div className="waker-toolbar">
          <MagnifyingGlass size={16} aria-hidden="true" />
          <input
            aria-label="搜索 Waker"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索 Waker 名称、角色或描述…"
          />
          <span>
            {visibleAgents.length}/{agents.length}
          </span>
        </div>
      )}
      {visibleAgents.length ? (
        <div className="waker-grid">
          {visibleAgents.map((agent) => (
            <article className="waker-card" key={agent.id}>
              <div className="waker-card-head">
                <AgentChip mark={agent.mark} className="large" />
                <span className="status-dot">本地可用</span>
              </div>
              <h2>{agent.name}</h2>
              <p>{agent.tagline || agent.description || '本地 Codex Waker'}</p>
              <div className="waker-actions">
                <button
                  type="button"
                  className="legacy-button primary"
                  onClick={() => onChat(agent.id)}
                >
                  <ChatCircle size={15} /> 创建对话
                </button>
                <button
                  type="button"
                  className="legacy-button"
                  onClick={() => onAutomation(agent.id)}
                >
                  <FlowArrow size={15} /> 管理自动任务
                </button>
                <button
                  type="button"
                  className="legacy-text-button"
                  onClick={() => onConfigure(agent.id)}
                >
                  配置
                </button>
                <button
                  type="button"
                  className="legacy-text-button"
                  onClick={() => onMemory(agent.id)}
                >
                  记忆
                </button>
                <button
                  type="button"
                  className="legacy-text-button"
                  onClick={() => onCapabilities(agent.id)}
                >
                  能力
                </button>
                <a
                  className="legacy-text-button"
                  href={`/api/v1/agents/${encodeURIComponent(agent.id)}/source`}
                  download={`${agent.id}.md`}
                >
                  导出
                </a>
                <button
                  type="button"
                  className="legacy-text-button danger"
                  onClick={(event) => {
                    event.currentTarget.focus();
                    deleteTriggerRef.current = event.currentTarget;
                    setDeleteTarget(agent);
                    void loadDeleteImpact(agent);
                  }}
                >
                  删除
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : agents.length ? (
        <EmptyState title="没有匹配的 Waker" detail="调整搜索词，或清空搜索查看全部 Waker。" />
      ) : (
        <EmptyState
          image="/legacy/waker-builtin-icon.svg"
          title="还没有 Waker"
          detail="新建一个本地 Waker，开始第一段对话。"
        />
      )}
      <NewAgentDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          onCreated(id);
        }}
      />
      {deleteTarget && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeDeleteDialog();
            }
          }}
        >
          <form
            ref={deleteDialogRef}
            tabIndex={-1}
            className="memory-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-waker-title"
            onSubmit={async (event) => {
              event.preventDefault();
              if (deleteConfirmation !== deleteTarget.name) return;
              try {
                await deleteAgent(deleteTarget.id);
                onDeleted(deleteTarget.id);
                setDeleteTarget(null);
                setDeleteConfirmation('');
              } catch (cause) {
                notify(cause instanceof Error ? cause.message : '删除失败');
              }
            }}
          >
            <h2 id="delete-waker-title">删除 {deleteTarget.name}</h2>
            {deleteImpact ? (
              <div className="modal-hint">
                <p>
                  将删除定义、{deleteImpact.sessions} 个会话、{deleteImpact.projects} 个项目和{' '}
                  {deleteImpact.connectors} 个连接器。
                </p>
                <p>
                  {deleteImpact.automations} 个 Automation、{deleteImpact.workflows} 个 Workflow、
                  {deleteImpact.tasks} 条 Task 与 {deleteImpact.humanActions} 条 Human Action
                  将保留审计数据但不再对同 ID Waker 可见。
                </p>
                <p>{deleteImpact.sharedSkills} 个工作区共享 Skill 不受影响。</p>
              </div>
            ) : deleteImpactError ? (
              <div className="legacy-error" role="alert">
                <p>{deleteImpactError}</p>
                <button
                  className="legacy-button"
                  type="button"
                  onClick={() => void loadDeleteImpact(deleteTarget)}
                >
                  重新检查
                </button>
              </div>
            ) : (
              <p role="status">正在检查 Waker 删除影响…</p>
            )}
            <p>请输入 Waker 名称确认。</p>
            <label>
              Waker 名称
              <input
                autoFocus
                value={deleteConfirmation}
                onChange={(event) => setDeleteConfirmation(event.target.value)}
              />
            </label>
            <div className="dialog-actions">
              <button
                type="button"
                className="legacy-button"
                onClick={() => {
                  closeDeleteDialog();
                }}
              >
                取消
              </button>
              <button
                className="legacy-button primary"
                disabled={!deleteImpact || deleteConfirmation !== deleteTarget.name}
              >
                确认删除
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}

export function ResourcesView({
  kind,
  wakerId,
  notify,
}: {
  kind: 'projects' | 'workflows' | 'tasks' | 'im';
  wakerId?: string;
  notify: (message: string) => void;
}) {
  const [data, setData] = useState<LocalResourcesResponse | null>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const load = useCallback(() => {
    setError('');
    if (!wakerId) {
      setData({ projects: [], automations: [], workflows: [], channels: [], tasks: [] });
      return;
    }
    fetchLocalResources(wakerId)
      .then(setData)
      .catch((cause) => setError(cause instanceof Error ? cause.message : '资源加载失败'));
  }, [wakerId]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const reload = () => load();
    window.addEventListener('waker:resources-changed', reload);
    return () => window.removeEventListener('waker:resources-changed', reload);
  }, [load]);
  const title =
    kind === 'projects'
      ? '公开项目'
      : kind === 'workflows'
        ? 'WakerFlow'
        : kind === 'tasks'
          ? '任务看板'
          : 'IM';
  const items =
    kind === 'projects'
      ? data?.projects.filter((item) => item.visibility === 'public')
      : kind === 'workflows'
        ? data?.workflows
        : kind === 'tasks'
          ? data?.tasks
          : data?.channels;
  const create = async (event: FormEvent) => {
    event.preventDefault();
    const value = name.trim();
    if (!value || kind === 'im') return;
    setSubmitting(true);
    try {
      if (!wakerId) throw new Error('请先创建或选择一个 Waker');
      if (kind === 'projects')
        await createLocalResource<WakerProject>('projects', {
          wakerId,
          name: value,
          description: '本地公开项目',
          visibility: 'public',
          source: 'filesystem',
          path: '.',
        });
      if (kind === 'workflows')
        await createLocalResource<WakerWorkflow>('workflows', {
          name: value,
          description: '本地流程',
          script: '',
          status: 'draft',
        });
      if (kind === 'tasks')
        await createLocalResource<WakerTask>('tasks', {
          wakerId,
          title: value,
          type: 'workflow',
          source: 'local',
        });
      setName('');
      load();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '创建失败');
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <section className="legacy-page">
      <PageHeader
        title={title}
        detail={
          kind === 'im'
            ? '连接外部消息渠道，或使用内置本地通道。'
            : '数据来自本地 SQLite，可离线管理。'
        }
      />
      {kind === 'im' && (
        <div className="local-notice">
          <Plugs size={18} />
          <div>
            <strong>本地演示</strong>
            <p>第三方连接器未配置。钉钉、飞书、微信、企业微信与 QQ 不会伪造连接状态。</p>
          </div>
        </div>
      )}
      {kind !== 'im' && (
        <form className="inline-create" onSubmit={create}>
          <label>
            <span>{kind === 'tasks' ? '任务标题' : '名称'}</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={`新建${title}`}
            />
          </label>
          <button className="legacy-button primary" disabled={!name.trim() || submitting}>
            {submitting ? '创建中…' : '创建'}
          </button>
        </form>
      )}
      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : !data ? (
        <LoadingRows />
      ) : items?.length ? (
        <div className="resource-table" role="table" aria-label={title}>
          {items.map((item) => (
            <div className="resource-row" role="row" key={item.id}>
              <div>
                <strong>{'title' in item ? item.title : item.name}</strong>
                <small>
                  {'provider' in item
                    ? item.provider
                    : 'description' in item
                      ? item.description || item.id
                      : item.id}
                </small>
              </div>
              <span className={cx('resource-status', item.status)}>{item.status}</span>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          image="/legacy/empty-project-icon.svg"
          title={`还没有${title}`}
          detail={kind === 'im' ? '连接器配置后会显示在这里。' : '使用上方表单创建第一条本地记录。'}
        />
      )}
    </section>
  );
}

export function KnowledgeView({
  wakerId,
  notify,
}: {
  wakerId?: string;
  notify: (message: string) => void;
}) {
  const [notebooks, setNotebooks] = useState<KnowledgeNotebook[] | null>(null);
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [selected, setSelected] = useState('');
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<KnowledgeSearchMode>('hybrid');
  const [results, setResults] = useState<KnowledgeSearchResponse | null>(null);
  const [error, setError] = useState('');
  const [notebookTitle, setNotebookTitle] = useState('');
  const [docEditor, setDocEditor] = useState<{
    id?: string;
    version?: number;
    title: string;
    content: string;
    sourceType: KnowledgeDocument['sourceType'];
    uri: string;
  } | null>(null);
  const documentTriggerRef = useRef<HTMLButtonElement>(null);
  const documentWasOpen = useRef(false);
  const [knowledgeMeta, setKnowledgeMeta] = useState<{
    bindings: Awaited<ReturnType<typeof fetchKnowledgeBindings>>;
    audits: Array<Record<string, unknown>>;
  }>({ bindings: [], audits: [] });
  const closeDocumentDialog = useCallback(() => {
    setDocEditor(null);
  }, []);
  const documentDialogRef = useDialogFocus<HTMLFormElement>(
    Boolean(docEditor),
    closeDocumentDialog,
  );
  useEffect(() => {
    if (docEditor) documentWasOpen.current = true;
    else if (documentWasOpen.current) {
      documentWasOpen.current = false;
      documentTriggerRef.current?.focus();
    }
  }, [docEditor]);
  const load = useCallback(async () => {
    try {
      if (!wakerId) {
        setNotebooks([]);
        return;
      }
      const books = await fetchKnowledgeNotebooks({ kind: 'waker', id: wakerId });
      setNotebooks(books);
      setSelected((current) => current || books[0]?.id || '');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '知识库加载失败');
    }
  }, [wakerId]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (selected && wakerId)
      void Promise.all([
        fetchKnowledgeDocuments(selected, { kind: 'waker', id: wakerId }),
        fetchKnowledgeBindings(),
        fetchKnowledgeAudits(selected),
      ])
        .then(([docs, bindings, audits]) => {
          setDocuments(docs);
          setKnowledgeMeta({
            bindings: bindings.filter((item) => item.notebookId === selected),
            audits,
          });
        })
        .catch(() => {
          setDocuments([]);
          setKnowledgeMeta({ bindings: [], audits: [] });
        });
  }, [selected, wakerId]);
  const createNotebook = async (event: FormEvent) => {
    event.preventDefault();
    const title = notebookTitle.trim();
    if (!title) return;
    if (!wakerId) {
      notify('请先创建或选择一个 Waker');
      return;
    }
    try {
      const notebook = await createKnowledgeNotebook({ title });
      await createKnowledgeBinding({
        notebookId: notebook.id,
        scope: { kind: 'waker', id: wakerId },
        access: 'read_write',
      });
      setNotebookTitle('');
      await load();
      setSelected(notebook.id);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '创建失败');
    }
  };
  const createDocument = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected || !wakerId || !docEditor) return;
    try {
      const scope = { kind: 'waker' as const, id: wakerId };
      if (docEditor.id && docEditor.version)
        await updateKnowledgeDocument(docEditor.id, {
          expectedVersion: docEditor.version,
          title: docEditor.title.trim(),
          content: docEditor.content.trim(),
          scope,
        });
      else
        await upsertKnowledgeDocument({
          notebookId: selected,
          title: docEditor.title.trim(),
          content: docEditor.content.trim(),
          sourceType: docEditor.sourceType,
          ...(docEditor.uri ? { uri: docEditor.uri } : {}),
          scope,
        });
      closeDocumentDialog();
      setDocuments(await fetchKnowledgeDocuments(selected, scope));
      await load();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '文档保存失败');
    }
  };
  const search = async (event: FormEvent) => {
    event.preventDefault();
    if (!query.trim()) return;
    if (!wakerId) {
      notify('请先创建或选择一个 Waker');
      return;
    }
    try {
      setResults(
        await searchKnowledge({
          scope: { kind: 'waker', id: wakerId },
          notebookId: selected || undefined,
          query: query.trim(),
          mode,
          limit: 12,
        }),
      );
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '检索失败');
    }
  };
  const selectedBook = useMemo(
    () => notebooks?.find((item) => item.id === selected),
    [notebooks, selected],
  );
  const canWrite = !knowledgeMeta.bindings.some(
    (binding) => binding.notebookId === selected && binding.access === 'read_only',
  );
  return (
    <section className="legacy-page">
      <PageHeader title="知识库" detail="关键词与向量混合检索，结果可追溯到本地文档。">
        <button
          type="button"
          className="legacy-button"
          onClick={() => setNotebookTitle('新知识库')}
        >
          <Plus size={15} />
          新建知识库
        </button>
        <button
          type="button"
          className="legacy-button primary"
          disabled={!selected || !canWrite}
          title={!canWrite ? '只读绑定不能修改文档' : undefined}
          onClick={(event) => {
            event.currentTarget.focus();
            documentTriggerRef.current = event.currentTarget;
            setDocEditor({ title: '', content: '', sourceType: 'text', uri: '' });
          }}
        >
          <Plus size={15} />
          新建文档
        </button>
        <button
          type="button"
          className="legacy-button"
          disabled={!selected}
          onClick={async () =>
            notify(
              '已重建 ' +
                (await rebuildKnowledge({ notebookId: selected, force: true })) +
                ' 个分块',
            )
          }
        >
          重建索引 · {knowledgeMeta.bindings.length} 绑定 / {knowledgeMeta.audits.length} 审计
        </button>
      </PageHeader>
      <form className="inline-create" onSubmit={createNotebook}>
        <label>
          <span>知识库名称</span>
          <input
            aria-label="知识库名称"
            value={notebookTitle}
            onChange={(event) => setNotebookTitle(event.target.value)}
            placeholder="新知识库"
          />
        </label>
        <button className="legacy-button" disabled={!notebookTitle.trim()}>
          创建知识库
        </button>
      </form>
      {docEditor && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeDocumentDialog();
          }}
        >
          <form
            ref={documentDialogRef}
            tabIndex={-1}
            className="memory-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="新建知识文档"
            onSubmit={createDocument}
          >
            <h2>新建知识文档</h2>
            <label>
              标题
              <input
                autoFocus
                value={docEditor.title}
                onChange={(event) => setDocEditor({ ...docEditor, title: event.target.value })}
              />
            </label>
            <label>
              类型
              <select
                value={docEditor.sourceType}
                onChange={(event) =>
                  setDocEditor({
                    ...docEditor,
                    sourceType: event.target.value as KnowledgeDocument['sourceType'],
                  })
                }
              >
                <option value="text">Text</option>
                <option value="markdown">Markdown</option>
                <option value="web">Web</option>
              </select>
            </label>
            <label>
              来源 URI
              <input
                value={docEditor.uri}
                onChange={(event) => setDocEditor({ ...docEditor, uri: event.target.value })}
              />
            </label>
            <label>
              内容
              <textarea
                rows={10}
                value={docEditor.content}
                onChange={(event) => setDocEditor({ ...docEditor, content: event.target.value })}
              />
            </label>
            <div className="dialog-actions">
              <button type="button" className="legacy-button" onClick={closeDocumentDialog}>
                取消
              </button>
              <button
                className="legacy-button primary"
                disabled={!docEditor.title.trim() || !docEditor.content.trim()}
              >
                保存
              </button>
            </div>
          </form>
        </div>
      )}
      {error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : !notebooks ? (
        <LoadingRows />
      ) : (
        <div className="knowledge-layout">
          <aside className="notebook-list">
            <h2>知识库</h2>
            {notebooks.map((book) => (
              <button
                key={book.id}
                type="button"
                className={cx(selected === book.id && 'active')}
                onClick={() => setSelected(book.id)}
              >
                <BookOpenText size={17} />
                <span>
                  {book.title}
                  <small>{book.documentCount} 篇文档</small>
                </span>
              </button>
            ))}
          </aside>
          <div className="knowledge-main">
            <form className="knowledge-search" onSubmit={search}>
              <MagnifyingGlass size={18} />
              <input
                aria-label="搜索知识库"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索本地知识…"
              />
              <select
                aria-label="检索方式"
                value={mode}
                onChange={(event) => setMode(event.target.value as KnowledgeSearchMode)}
              >
                <option value="hybrid">混合检索</option>
                <option value="keyword">关键词</option>
                <option value="vector">向量</option>
              </select>
              <button className="legacy-button primary" disabled={!query.trim()}>
                搜索
              </button>
            </form>
            {results ? (
              <div className="search-results">
                <div className="results-meta">
                  {results.total} 条结果 · {results.modeUsed}
                  {results.degraded ? ' · 已降级' : ''}
                </div>
                {results.results.map((result) => (
                  <article key={result.chunkId}>
                    <h3>{result.title}</h3>
                    <p>{result.snippet || result.content}</p>
                    <code>{result.citation}</code>
                    <span>相关度 {result.score.toFixed(3)}</span>
                  </article>
                ))}
              </div>
            ) : (
              <>
                <div className="section-heading">
                  <div>
                    <h2>{selectedBook?.title ?? '选择知识库'}</h2>
                    <p>{selectedBook?.description || '本地文档与版本记录'}</p>
                  </div>
                </div>
                {documents.length ? (
                  <div className="document-list">
                    {documents.map((doc) => (
                      <div key={doc.id}>
                        <BookOpenText size={18} />
                        <span>
                          <strong>{doc.title}</strong>
                          <small>
                            版本 {doc.version} · {doc.sourceType}
                          </small>
                        </span>
                        <button
                          className="legacy-text-button"
                          disabled={!canWrite}
                          title={!canWrite ? '只读绑定' : undefined}
                          onClick={(event) => {
                            event.currentTarget.focus();
                            documentTriggerRef.current = event.currentTarget;
                            setDocEditor({
                              id: doc.id,
                              version: doc.version,
                              title: doc.title,
                              content: doc.content,
                              sourceType: doc.sourceType,
                              uri: doc.uri ?? '',
                            });
                          }}
                        >
                          编辑
                        </button>
                        <button
                          className="legacy-text-button"
                          disabled={!canWrite}
                          title={!canWrite ? '只读绑定' : undefined}
                          onClick={async () => {
                            if (!wakerId) return;
                            await deleteKnowledgeDocument(doc.id, { kind: 'waker', id: wakerId });
                            setDocuments(
                              await fetchKnowledgeDocuments(selected, {
                                kind: 'waker',
                                id: wakerId,
                              }),
                            );
                          }}
                        >
                          删除
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    title="还没有文档"
                    detail="创建一篇文本或 Markdown 文档，随后即可检索。"
                  />
                )}
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function PageHeader({
  title,
  detail,
  children,
}: {
  title: string;
  detail: string;
  children?: ReactNode;
}) {
  return (
    <header className="legacy-page-header">
      <div>
        <h1 id={title === 'Waker' ? 'wakers-title' : undefined}>{title}</h1>
        <p>{detail}</p>
      </div>
      {children && <div className="page-actions">{children}</div>}
    </header>
  );
}
function EmptyState({ image, title, detail }: { image?: string; title: string; detail: string }) {
  return (
    <div className="legacy-empty">
      {image && <img src={image} alt="" />}
      <h2>{title}</h2>
      <p>{detail}</p>
    </div>
  );
}
function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="legacy-error" role="alert">
      <strong>加载失败</strong>
      <p>{message}</p>
      <button type="button" className="legacy-button" onClick={onRetry}>
        重试
      </button>
    </div>
  );
}
function LoadingRows() {
  return (
    <div className="loading-rows" aria-label="正在加载" aria-busy="true">
      <i />
      <i />
      <i />
    </div>
  );
}
