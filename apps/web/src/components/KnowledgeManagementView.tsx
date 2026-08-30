import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import { motion } from 'motion/react';
import type {
  KnowledgeBinding,
  KnowledgeDocument,
  KnowledgeNotebook,
  KnowledgeSearchMode,
  KnowledgeSearchResponse,
} from '@waker/contracts';
import { BookOpenText } from '@phosphor-icons/react/dist/icons/BookOpenText';
import { MagnifyingGlass } from '@phosphor-icons/react/dist/icons/MagnifyingGlass';
import { Plus } from '@phosphor-icons/react/dist/icons/Plus';
import { UploadSimple } from '@phosphor-icons/react/dist/icons/UploadSimple';
import {
  createKnowledgeBinding,
  createKnowledgeNotebook,
  deleteKnowledgeBinding,
  deleteKnowledgeDocument,
  fetchKnowledgeAudits,
  fetchKnowledgeBindings,
  fetchKnowledgeDocuments,
  fetchKnowledgeNotebooks,
  importKnowledgeUrls,
  rebuildKnowledge,
  searchKnowledge,
  updateKnowledgeDocument,
  upsertKnowledgeDocument,
} from '../lib/api.js';
import { cx } from '../lib/cx.js';
import { useDialogFocus } from '../hooks/useDialogFocus.js';
import { prepareKnowledgeFiles, type RejectedKnowledgeFile } from './knowledgeFileImport.js';
import { MAX_KNOWLEDGE_IMPORT_URLS, parseKnowledgeUrls } from './knowledgeUrlImport.js';
import { MotionLoadingRows } from './MotionFeedback.js';
import type { Notify } from './Toasts.js';
import { MOTION_DIALOG_BACKDROP, MOTION_DIALOG_SURFACE, MOTION_TRANSITION } from '../lib/motion.js';

type AuditEntry = {
  id?: number;
  action?: string;
  createdAt?: string;
  documentId?: string;
};

type DocumentEditor = {
  id?: string;
  version?: number;
  title: string;
  content: string;
  sourceType: 'text' | 'markdown';
};

type ImportReport = {
  imported: string[];
  rejected: RejectedKnowledgeFile[];
};

const scopeFor = (wakerId: string) => ({ kind: 'waker' as const, id: wakerId });

function formatAuditTime(value?: string): string {
  if (!value) return '时间未知';
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? '时间未知'
    : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

function auditLabel(action?: string): string {
  const labels: Record<string, string> = {
    'notebook.created': '创建知识库',
    'notebook.updated': '更新知识库',
    'binding.updated': '更新绑定',
    'binding.removed': '解除绑定',
    'document.created': '创建文档',
    'document.updated': '更新文档',
    'document.deleted': '删除文档',
    'index.rebuilt': '重建索引',
  };
  return action ? (labels[action] ?? action) : '未知操作';
}

export function KnowledgeManagementView({ wakerId, notify }: { wakerId?: string; notify: Notify }) {
  const [notebooks, setNotebooks] = useState<KnowledgeNotebook[] | null>(null);
  const [bindings, setBindings] = useState<KnowledgeBinding[]>([]);
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [audits, setAudits] = useState<AuditEntry[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [notebookTitle, setNotebookTitle] = useState('');
  const [notebookDescription, setNotebookDescription] = useState('');
  const [bindAccess, setBindAccess] = useState<KnowledgeBinding['access']>('read_write');
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<KnowledgeSearchMode>('hybrid');
  const [results, setResults] = useState<KnowledgeSearchResponse | null>(null);
  const [editor, setEditor] = useState<DocumentEditor | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailReload, setDetailReload] = useState(0);
  const [needsCheck, setNeedsCheck] = useState(false);
  const [importReport, setImportReport] = useState<ImportReport | null>(null);
  const [urlInput, setUrlInput] = useState('');
  const [deleteDocumentTarget, setDeleteDocumentTarget] = useState<KnowledgeDocument | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editorTriggerRef = useRef<HTMLButtonElement>(null);
  const closeEditor = useCallback(() => {
    if (!busy) setEditor(null);
  }, [busy]);
  const editorDialogRef = useDialogFocus<HTMLFormElement>(Boolean(editor), closeEditor);
  const closeDeleteDocument = useCallback(() => {
    if (!busy) setDeleteDocumentTarget(null);
  }, [busy]);
  const deleteDocumentDialogRef = useDialogFocus<HTMLDivElement>(
    Boolean(deleteDocumentTarget),
    closeDeleteDocument,
  );

  const selectedNotebook = useMemo(
    () => notebooks?.find((item) => item.id === selectedId),
    [notebooks, selectedId],
  );
  const selectedBinding = useMemo(
    () =>
      wakerId
        ? bindings.find(
            (item) =>
              item.notebookId === selectedId &&
              item.scope.kind === 'waker' &&
              item.scope.id === wakerId,
          )
        : undefined,
    [bindings, selectedId, wakerId],
  );
  const selectedBindingAccess = selectedBinding?.access;
  const canWrite = selectedBindingAccess === 'read_write';

  const loadCatalog = useCallback(async () => {
    if (!wakerId) {
      setNotebooks([]);
      setBindings([]);
      setSelectedId('');
      return;
    }
    try {
      setError('');
      const [nextNotebooks, nextBindings] = await Promise.all([
        fetchKnowledgeNotebooks(),
        fetchKnowledgeBindings(),
      ]);
      setNotebooks(nextNotebooks);
      setBindings(nextBindings);
      setSelectedId((current) =>
        nextNotebooks.some((item) => item.id === current)
          ? current
          : (nextNotebooks.find((item) =>
              nextBindings.some(
                (binding) =>
                  binding.notebookId === item.id &&
                  binding.scope.kind === 'waker' &&
                  binding.scope.id === wakerId,
              ),
            )?.id ??
            nextNotebooks[0]?.id ??
            ''),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '知识库加载失败');
      setNotebooks([]);
    }
  }, [wakerId]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  useEffect(() => {
    setResults(null);
    setImportReport(null);
    setUrlInput('');
    setNeedsCheck(false);
    setDocuments([]);
    setAudits([]);
    if (!selectedId || !wakerId || !selectedBindingAccess) {
      setDetailLoading(false);
      return;
    }
    setDetailLoading(true);
    let active = true;
    const scope = scopeFor(wakerId);
    void Promise.allSettled([
      fetchKnowledgeDocuments(selectedId, scope),
      fetchKnowledgeAudits(selectedId),
    ]).then(([documentResult, auditResult]) => {
      if (!active) return;
      if (documentResult.status === 'fulfilled') setDocuments(documentResult.value);
      else {
        setNeedsCheck(true);
      }
      if (auditResult.status === 'fulfilled') setAudits(auditResult.value as AuditEntry[]);
      else {
        setNeedsCheck(true);
      }
      setDetailLoading(false);
    });
    return () => {
      active = false;
    };
  }, [detailReload, selectedBindingAccess, selectedId, wakerId]);

  const refreshSelected = useCallback(async () => {
    if (!selectedId || !wakerId || !selectedBindingAccess) return;
    const scope = scopeFor(wakerId);
    const [nextDocuments, nextAudits] = await Promise.all([
      fetchKnowledgeDocuments(selectedId, scope),
      fetchKnowledgeAudits(selectedId),
    ]);
    setDocuments(nextDocuments);
    setAudits(nextAudits as AuditEntry[]);
    setNeedsCheck(false);
  }, [selectedBindingAccess, selectedId, wakerId]);

  const createNotebook = async (event: FormEvent) => {
    event.preventDefault();
    if (!wakerId || !notebookTitle.trim() || busy) return;
    setBusy(true);
    try {
      const notebook = await createKnowledgeNotebook({
        title: notebookTitle.trim(),
        ...(notebookDescription.trim() ? { description: notebookDescription.trim() } : {}),
      });
      await createKnowledgeBinding({
        notebookId: notebook.id,
        scope: scopeFor(wakerId),
        access: bindAccess,
      });
      setNotebookTitle('');
      setNotebookDescription('');
      await loadCatalog();
      setSelectedId(notebook.id);
      notify('知识库已创建并连接到当前 Waker', 'success');
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '知识库创建失败', 'error');
      await loadCatalog();
    } finally {
      setBusy(false);
    }
  };

  const toggleBinding = async () => {
    if (!wakerId || !selectedNotebook || busy) return;
    setBusy(true);
    try {
      if (selectedBinding) {
        await deleteKnowledgeBinding(selectedBinding);
        notify('已解除当前 Waker 的知识库连接', 'success');
      } else {
        await createKnowledgeBinding({
          notebookId: selectedNotebook.id,
          scope: scopeFor(wakerId),
          access: bindAccess,
        });
        notify(bindAccess === 'read_only' ? '知识库已以只读方式连接' : '知识库已连接', 'success');
      }
      await loadCatalog();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '知识库连接更新失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const saveDocument = async (event: FormEvent) => {
    event.preventDefault();
    if (!editor || !selectedId || !wakerId || !canWrite || busy) return;
    setBusy(true);
    try {
      const scope = scopeFor(wakerId);
      if (editor.id && editor.version) {
        await updateKnowledgeDocument(editor.id, {
          expectedVersion: editor.version,
          title: editor.title.trim(),
          content: editor.content,
          scope,
        });
      } else {
        await upsertKnowledgeDocument({
          notebookId: selectedId,
          title: editor.title.trim(),
          content: editor.content,
          sourceType: editor.sourceType,
          mimeType: editor.sourceType === 'markdown' ? 'text/markdown' : 'text/plain',
          scope,
        });
      }
      setEditor(null);
      await refreshSelected();
      await loadCatalog();
      notify('知识文档已保存', 'success');
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '知识文档保存失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const removeDocument = async (document: KnowledgeDocument) => {
    if (!wakerId || !canWrite || busy) return;
    setBusy(true);
    try {
      await deleteKnowledgeDocument(document.id, scopeFor(wakerId));
      setDeleteDocumentTarget(null);
      await refreshSelected();
      await loadCatalog();
      notify(`已删除“${document.title}”`, 'success');
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '知识文档删除失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const importFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!files.length || !wakerId || !selectedId || !canWrite || busy) return;
    setBusy(true);
    try {
      const prepared = await prepareKnowledgeFiles(files);
      const scope = scopeFor(wakerId);
      const uploads = await Promise.allSettled(
        prepared.accepted.map((file) =>
          upsertKnowledgeDocument({
            notebookId: selectedId,
            title: file.title,
            content: file.content,
            uri: file.fileName,
            mimeType: file.mimeType,
            sourceType: file.sourceType,
            scope,
          }),
        ),
      );
      const imported: string[] = [];
      const rejected = [...prepared.rejected];
      uploads.forEach((result, index) => {
        const file = prepared.accepted[index]!;
        if (result.status === 'fulfilled') imported.push(file.fileName);
        else
          rejected.push({
            fileName: file.fileName,
            reason: result.reason instanceof Error ? result.reason.message : '保存失败',
          });
      });
      setImportReport({ imported, rejected });
      if (imported.length) {
        try {
          await refreshSelected();
          await loadCatalog();
        } catch {
          rejected.push({ fileName: '索引状态', reason: '导入成功，但刷新结果失败' });
          setImportReport({ imported, rejected });
        }
      }
      setNeedsCheck(rejected.length > 0);
      notify(
        rejected.length
          ? `已导入 ${imported.length} 个，${rejected.length} 个失败`
          : `已导入 ${imported.length} 个文件`,
        rejected.length ? 'error' : 'success',
      );
    } finally {
      setBusy(false);
    }
  };

  const validUrls = useMemo(() => parseKnowledgeUrls(urlInput), [urlInput]);
  const urlOverLimit = validUrls.length > MAX_KNOWLEDGE_IMPORT_URLS;

  const importUrls = async (event: FormEvent) => {
    event.preventDefault();
    if (!wakerId || !selectedId || !canWrite || busy || !validUrls.length || urlOverLimit) return;
    setBusy(true);
    try {
      const response = await importKnowledgeUrls({
        notebookId: selectedId,
        urls: validUrls,
        scope: scopeFor(wakerId),
      });
      const imported: string[] = [];
      const rejected: RejectedKnowledgeFile[] = [];
      for (const result of response.results) {
        if (result.ok) imported.push(result.url);
        else rejected.push({ fileName: result.url, reason: result.error ?? '抓取失败' });
      }
      setImportReport({ imported, rejected });
      if (imported.length) {
        setUrlInput('');
        try {
          await refreshSelected();
          await loadCatalog();
        } catch {
          rejected.push({ fileName: '索引状态', reason: '导入成功，但刷新结果失败' });
          setImportReport({ imported, rejected });
        }
      }
      setNeedsCheck(rejected.length > 0);
      notify(
        imported.length
          ? rejected.length
            ? `已导入 ${imported.length} 个，${rejected.length} 个失败`
            : '网页链接已导入'
          : '无法导入网页链接，请稍后重试。',
        imported.length && !rejected.length ? 'success' : 'error',
      );
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '无法导入网页链接，请稍后重试。', 'error');
    } finally {
      setBusy(false);
    }
  };

  const runSearch = async (event: FormEvent) => {
    event.preventDefault();
    if (!query.trim() || !wakerId || !selectedBinding || busy) return;
    setBusy(true);
    try {
      const response = await searchKnowledge({
        scope: scopeFor(wakerId),
        notebookId: selectedId,
        query: query.trim(),
        mode,
        limit: 12,
      });
      setResults(response);
      if (response.degraded) setNeedsCheck(true);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '知识检索失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const rebuild = async () => {
    if (!selectedId || !canWrite || busy) return;
    setBusy(true);
    try {
      const chunks = await rebuildKnowledge({ notebookId: selectedId, force: true });
      setNeedsCheck(false);
      await refreshSelected();
      notify(`已重建 ${chunks} 个分块`, 'success');
    } catch (cause) {
      setNeedsCheck(true);
      notify(cause instanceof Error ? cause.message : '索引重建失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const connectionStatus = !selectedBinding
    ? { label: '未连接', className: '' }
    : selectedBinding.access === 'read_only'
      ? { label: '只读', className: 'initializing' }
      : { label: 'Connected', className: 'connected' };

  return (
    <section className="legacy-page knowledge-management-page">
      <header className="legacy-page-header">
        <div>
          <h1>知识库</h1>
          <p>选择或创建本地知识库，连接到当前 Waker 后导入、检索并审计内容。</p>
        </div>
        <div className="page-actions">
          <input
            ref={fileInputRef}
            hidden
            multiple
            type="file"
            accept=".md,.markdown,.txt,text/markdown,text/plain"
            onChange={(event) => void importFiles(event)}
          />
          <button
            type="button"
            className="legacy-button"
            disabled={!canWrite || busy}
            title={!canWrite ? '需要可写连接才能导入文件' : undefined}
            onClick={() => fileInputRef.current?.click()}
          >
            <UploadSimple size={15} />
            导入 Markdown/TXT
          </button>
          <button
            type="button"
            className="legacy-button primary"
            disabled={!canWrite || busy}
            title={!canWrite ? '需要可写连接才能新建文档' : undefined}
            onClick={(event) => {
              editorTriggerRef.current = event.currentTarget;
              setEditor({ title: '', content: '', sourceType: 'markdown' });
            }}
          >
            <Plus size={15} />
            新建文档
          </button>
          <button
            type="button"
            className="legacy-button"
            disabled={!canWrite || busy}
            onClick={() => void rebuild()}
          >
            {busy ? '处理中…' : '重建索引'}
          </button>
        </div>
      </header>

      {!wakerId && (
        <div className="legacy-error" role="status">
          <p>请先创建或选择一个 Waker，再管理它的知识连接。</p>
        </div>
      )}

      {wakerId && (
        <form className="inline-create knowledge-create" onSubmit={createNotebook}>
          <label>
            <span>知识库名称</span>
            <input
              maxLength={160}
              value={notebookTitle}
              onChange={(event) => setNotebookTitle(event.target.value)}
              placeholder="例如：产品手册"
            />
          </label>
          <label>
            <span>说明（可选）</span>
            <input
              maxLength={2000}
              value={notebookDescription}
              onChange={(event) => setNotebookDescription(event.target.value)}
              placeholder="记录资料范围与用途"
            />
          </label>
          <label className="knowledge-access-field">
            <span>连接权限</span>
            <select
              value={bindAccess}
              onChange={(event) => setBindAccess(event.target.value as KnowledgeBinding['access'])}
            >
              <option value="read_write">可读写</option>
              <option value="read_only">只读</option>
            </select>
          </label>
          <button className="legacy-button" disabled={!notebookTitle.trim() || busy}>
            创建并连接
          </button>
        </form>
      )}

      {error ? (
        <div className="legacy-error" role="alert">
          <p>{error}</p>
          <button className="legacy-button" type="button" onClick={() => void loadCatalog()}>
            重试
          </button>
        </div>
      ) : notebooks === null ? (
        <MotionLoadingRows label="正在加载知识库" />
      ) : wakerId && notebooks.length === 0 ? (
        <div className="legacy-empty">
          <h2>还没有知识库</h2>
          <p>输入名称创建第一个本地知识库，它会自动连接到当前 Waker。</p>
        </div>
      ) : wakerId ? (
        <div className="knowledge-layout knowledge-management-layout">
          <aside className="notebook-list" aria-label="可用知识库">
            <h2>本地知识库</h2>
            {notebooks.map((notebook) => {
              const binding = bindings.find(
                (item) =>
                  item.notebookId === notebook.id &&
                  item.scope.kind === 'waker' &&
                  item.scope.id === wakerId,
              );
              return (
                <motion.button
                  key={notebook.id}
                  type="button"
                  className={cx(selectedId === notebook.id && 'active')}
                  aria-pressed={selectedId === notebook.id}
                  onClick={() => setSelectedId(notebook.id)}
                  layout="position"
                  whileTap={{ scale: 0.985 }}
                >
                  <BookOpenText size={17} />
                  <span>
                    {notebook.title}
                    <small>
                      {binding?.access === 'read_only' ? '只读' : binding ? 'Connected' : '未连接'}{' '}
                      · {notebook.documentCount} 篇
                    </small>
                  </span>
                </motion.button>
              );
            })}
          </aside>

          <div className="knowledge-main">
            <motion.div
              className="master-detail-content"
              key={selectedId || 'none'}
              initial={{ opacity: 0, x: 6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={MOTION_TRANSITION.routine}
            >
              {selectedNotebook && (
                <section
                  className="knowledge-connection"
                  aria-labelledby="knowledge-selected-title"
                >
                  <div>
                    <div className="knowledge-title-line">
                      <h2 id="knowledge-selected-title">{selectedNotebook.title}</h2>
                      <span className={cx('resource-status', connectionStatus.className)}>
                        {connectionStatus.label}
                      </span>
                      {selectedBinding && needsCheck && (
                        <span className="resource-status error">Needs check</span>
                      )}
                    </div>
                    <p>{selectedNotebook.description || '这个知识库没有说明。'}</p>
                  </div>
                  <div className="knowledge-connection-actions">
                    {!selectedBinding && (
                      <select
                        aria-label="连接权限"
                        value={bindAccess}
                        onChange={(event) =>
                          setBindAccess(event.target.value as KnowledgeBinding['access'])
                        }
                      >
                        <option value="read_write">可读写</option>
                        <option value="read_only">只读</option>
                      </select>
                    )}
                    <button
                      type="button"
                      className="legacy-button"
                      disabled={busy}
                      onClick={() => void toggleBinding()}
                    >
                      {selectedBinding ? '解除连接' : '连接到当前 Waker'}
                    </button>
                  </div>
                </section>
              )}

              {!selectedBinding ? (
                <div className="legacy-empty knowledge-unbound">
                  <h2>选择已有知识库并连接</h2>
                  <p>连接只作用于当前 Waker；未连接前不会读取或修改其中的文档。</p>
                </div>
              ) : (
                <>
                  {needsCheck && (
                    <div className="knowledge-health-notice" role="alert">
                      <span>
                        知识内容或索引状态不完整，请重新读取；只读连接不会因此获得写权限。
                      </span>
                      <button
                        type="button"
                        className="legacy-button"
                        disabled={detailLoading}
                        onClick={() => setDetailReload((value) => value + 1)}
                      >
                        重新读取
                      </button>
                    </div>
                  )}
                  {detailLoading ? (
                    <MotionLoadingRows label="正在读取知识库内容" />
                  ) : (
                    <>
                      <form className="knowledge-url-import" onSubmit={importUrls}>
                        <label htmlFor="knowledge-url-input">网页链接</label>
                        <textarea
                          id="knowledge-url-input"
                          rows={3}
                          value={urlInput}
                          disabled={!canWrite || busy}
                          placeholder="粘贴网页链接，多个链接可用空格或换行分隔"
                          onChange={(event) => setUrlInput(event.target.value)}
                        />
                        <div className="knowledge-url-import-meta">
                          <span aria-live="polite">
                            {validUrls.length}/{MAX_KNOWLEDGE_IMPORT_URLS} 个有效链接
                          </span>
                          {urlOverLimit && (
                            <span className="over-limit" role="alert">
                              最多允许 {MAX_KNOWLEDGE_IMPORT_URLS} 个链接
                            </span>
                          )}
                          <button
                            className="legacy-button"
                            disabled={!canWrite || busy || !validUrls.length || urlOverLimit}
                            title={!canWrite ? '需要可写连接才能导入链接' : undefined}
                          >
                            {busy ? '导入中…' : '导入链接'}
                          </button>
                        </div>
                      </form>

                      <form className="knowledge-search" onSubmit={runSearch}>
                        <MagnifyingGlass size={18} aria-hidden="true" />
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
                        <button className="legacy-button primary" disabled={!query.trim() || busy}>
                          搜索
                        </button>
                      </form>

                      {importReport && (
                        <div
                          className={cx(
                            'knowledge-import-report',
                            importReport.rejected.length > 0 && 'has-errors',
                          )}
                          role="status"
                          aria-live="polite"
                        >
                          <strong>
                            已导入 {importReport.imported.length} 个，失败{' '}
                            {importReport.rejected.length} 个
                          </strong>
                          {importReport.rejected.length > 0 && (
                            <ul>
                              {importReport.rejected.map((item, index) => (
                                <li key={`${item.fileName}-${index}`}>
                                  {item.fileName}：{item.reason}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}

                      {results ? (
                        <div className="search-results">
                          <div className="results-meta">
                            {results.total} 条结果 · {results.modeUsed}
                            {results.degraded
                              ? ` · 已降级${results.reason ? `：${results.reason}` : ''}`
                              : ''}
                            <button
                              type="button"
                              className="legacy-text-button"
                              onClick={() => setResults(null)}
                            >
                              返回文档
                            </button>
                          </div>
                          {results.results.length ? (
                            results.results.map((result) => (
                              <article key={result.chunkId}>
                                <h3>{result.title}</h3>
                                <p>{result.snippet || result.content}</p>
                                <code>{result.citation}</code>
                                <span>相关度 {result.score.toFixed(3)}</span>
                              </article>
                            ))
                          ) : (
                            <div className="legacy-empty knowledge-search-empty">
                              <h2>没有匹配结果</h2>
                              <p>尝试更短的关键词，或切换检索方式。</p>
                            </div>
                          )}
                        </div>
                      ) : (
                        <>
                          {documents.length ? (
                            <div className="document-list">
                              {documents.map((document) => (
                                <div key={document.id}>
                                  <BookOpenText size={18} />
                                  <span>
                                    <strong>{document.title}</strong>
                                    <small>
                                      版本 {document.version} · {document.sourceType}
                                    </small>
                                  </span>
                                  <button
                                    type="button"
                                    className="legacy-text-button"
                                    disabled={!canWrite || busy}
                                    title={!canWrite ? '当前连接为只读' : undefined}
                                    onClick={(event) => {
                                      editorTriggerRef.current = event.currentTarget;
                                      setEditor({
                                        id: document.id,
                                        version: document.version,
                                        title: document.title,
                                        content: document.content,
                                        sourceType:
                                          document.sourceType === 'text' ? 'text' : 'markdown',
                                      });
                                    }}
                                  >
                                    编辑
                                  </button>
                                  <button
                                    type="button"
                                    className="legacy-text-button danger"
                                    disabled={!canWrite || busy}
                                    title={!canWrite ? '当前连接为只读' : undefined}
                                    onClick={() => setDeleteDocumentTarget(document)}
                                  >
                                    删除
                                  </button>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="legacy-empty knowledge-documents-empty">
                              <h2>还没有文档</h2>
                              <p>
                                {canWrite
                                  ? '新建或导入 Markdown/TXT 文档后即可检索。'
                                  : '这是只读连接，当前知识库还没有文档。'}
                              </p>
                            </div>
                          )}

                          <details className="knowledge-audit">
                            <summary>审计记录 · {audits.length}</summary>
                            {audits.length ? (
                              <ol>
                                {[...audits]
                                  .reverse()
                                  .slice(0, 12)
                                  .map((audit, index) => (
                                    <li key={audit.id ?? `${audit.action}-${index}`}>
                                      <span>{auditLabel(audit.action)}</span>
                                      <time dateTime={audit.createdAt}>
                                        {formatAuditTime(audit.createdAt)}
                                      </time>
                                    </li>
                                  ))}
                              </ol>
                            ) : (
                              <p>暂无可显示的审计记录。</p>
                            )}
                          </details>
                        </>
                      )}
                    </>
                  )}
                </>
              )}
            </motion.div>
          </div>
        </div>
      ) : null}

      {editor && (
        <motion.div
          className="modal-backdrop"
          {...MOTION_DIALOG_BACKDROP}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeEditor();
          }}
        >
          <motion.form
            ref={editorDialogRef}
            tabIndex={-1}
            className="memory-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="knowledge-document-dialog-title"
            onSubmit={saveDocument}
            {...MOTION_DIALOG_SURFACE}
          >
            <h2 id="knowledge-document-dialog-title">
              {editor.id ? '编辑知识文档' : '新建知识文档'}
            </h2>
            <label>
              标题
              <input
                autoFocus
                required
                maxLength={240}
                value={editor.title}
                onChange={(event) => setEditor({ ...editor, title: event.target.value })}
              />
            </label>
            {!editor.id && (
              <label>
                类型
                <select
                  value={editor.sourceType}
                  onChange={(event) =>
                    setEditor({ ...editor, sourceType: event.target.value as 'text' | 'markdown' })
                  }
                >
                  <option value="markdown">Markdown</option>
                  <option value="text">Text</option>
                </select>
              </label>
            )}
            <label>
              内容
              <textarea
                required
                rows={12}
                value={editor.content}
                onChange={(event) => setEditor({ ...editor, content: event.target.value })}
              />
            </label>
            <div className="dialog-actions">
              <button type="button" className="legacy-button" disabled={busy} onClick={closeEditor}>
                取消
              </button>
              <button
                className="legacy-button primary"
                disabled={!editor.title.trim() || !editor.content.trim() || busy}
              >
                {busy ? '保存中…' : '保存'}
              </button>
            </div>
          </motion.form>
        </motion.div>
      )}
      {deleteDocumentTarget && (
        <motion.div
          className="modal-backdrop"
          {...MOTION_DIALOG_BACKDROP}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeDeleteDocument();
          }}
        >
          <motion.div
            ref={deleteDocumentDialogRef}
            tabIndex={-1}
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="knowledge-delete-document-title"
            {...MOTION_DIALOG_SURFACE}
          >
            <div className="modal-head">
              <strong id="knowledge-delete-document-title">
                删除知识文档：{deleteDocumentTarget.title}
              </strong>
            </div>
            <p className="modal-hint">
              这会删除该文档的版本、分块和向量索引；知识库及其他文档不受影响。
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="header-button"
                disabled={busy}
                onClick={closeDeleteDocument}
              >
                取消
              </button>
              <button
                type="button"
                className="header-button danger"
                disabled={busy}
                onClick={() => void removeDocument(deleteDocumentTarget)}
              >
                {busy ? '删除中…' : '确认删除文档'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </section>
  );
}
