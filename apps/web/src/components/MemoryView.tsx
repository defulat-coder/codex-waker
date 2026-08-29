import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type {
  MemoryDocument,
  MemoryScope,
  MemoryScopeType,
  MemorySnapshot,
  MemoryTimelineEntry,
  MemoryVersion,
  WakerProject,
} from '@waker/contracts';
import { ArrowCounterClockwise } from '@phosphor-icons/react/dist/icons/ArrowCounterClockwise';
import { ClockCounterClockwise } from '@phosphor-icons/react/dist/icons/ClockCounterClockwise';
import { DownloadSimple } from '@phosphor-icons/react/dist/icons/DownloadSimple';
import { FloppyDisk } from '@phosphor-icons/react/dist/icons/FloppyDisk';
import { Plus } from '@phosphor-icons/react/dist/icons/Plus';
import { UploadSimple } from '@phosphor-icons/react/dist/icons/UploadSimple';
import {
  createMemory,
  createMemorySnapshot,
  exportMemory,
  fetchLocalResources,
  fetchMemories,
  fetchMemoryDiff,
  fetchMemoryHistory,
  fetchMemoryTimeline,
  importMemory,
  rollbackMemory,
  updateMemory,
} from '../lib/api.js';
import { cx } from '../lib/cx.js';
import { useDialogFocus } from '../hooks/useDialogFocus.js';

type Editor = {
  mode: 'create' | 'edit' | 'import';
  title: string;
  source: string;
  content: string;
  format: 'json' | 'markdown';
};
const blank: Editor = {
  mode: 'create',
  title: '',
  source: 'manual',
  content: '',
  format: 'markdown',
};

export function MemoryView({
  wakerId,
  onClose,
  notify,
}: {
  wakerId: string;
  onClose: () => void;
  notify: (text: string) => void;
}) {
  const [scopeType, setScopeType] = useState<MemoryScopeType>('waker');
  const [projectId, setProjectId] = useState('');
  const [projects, setProjects] = useState<WakerProject[] | null>(null);
  const scope = useMemo<MemoryScope | null>(() => {
    if (scopeType === 'waker') return { type: 'waker', id: wakerId };
    if (scopeType === 'project' && projectId) return { type: 'project', id: projectId };
    return null;
  }, [scopeType, projectId, wakerId]);
  const [items, setItems] = useState<MemoryDocument[] | null>(null);
  const [selected, setSelected] = useState<MemoryDocument | null>(null);
  const [history, setHistory] = useState<{
    versions: MemoryVersion[];
    snapshots: MemorySnapshot[];
  }>({ versions: [], snapshots: [] });
  const [timeline, setTimeline] = useState<MemoryTimelineEntry[]>([]);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [diff, setDiff] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const editorTriggerRef = useRef<HTMLButtonElement>(null);
  const editorWasOpen = useRef(false);
  const closeEditorDialog = useCallback(() => {
    if (busy) return;
    setEditor(null);
  }, [busy]);
  const editorDialogRef = useDialogFocus<HTMLFormElement>(Boolean(editor), closeEditorDialog);
  useEffect(() => {
    if (editor) editorWasOpen.current = true;
    else if (editorWasOpen.current) {
      editorWasOpen.current = false;
      editorTriggerRef.current?.focus();
    }
  }, [editor]);
  const load = useCallback(async () => {
    if (!scope) {
      setItems([]);
      setSelected(null);
      setTimeline([]);
      setHistory({ versions: [], snapshots: [] });
      return;
    }
    try {
      setError('');
      const list = await fetchMemories(scope);
      setItems(list);
      setSelected((current) => list.find((item) => item.id === current?.id) ?? list[0] ?? null);
      setTimeline(await fetchMemoryTimeline(scope));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '记忆加载失败');
    }
  }, [scope]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    setDiff('');
  }, [scope]);
  useEffect(() => {
    let cancelled = false;
    fetchLocalResources(wakerId)
      .then((resources) => {
        if (!cancelled)
          setProjects(resources.projects.filter((project) => project.wakerId === wakerId));
      })
      .catch(() => {
        if (!cancelled) setProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, [wakerId]);
  useEffect(() => {
    const firstProject = projects?.[0];
    if (scopeType === 'project' && firstProject && !projectId) setProjectId(firstProject.id);
  }, [scopeType, projects, projectId]);
  useEffect(() => {
    if (selected)
      void fetchMemoryHistory(selected.id)
        .then(setHistory)
        .catch(() => setHistory({ versions: [], snapshots: [] }));
  }, [selected]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!editor || !scope) return;
    setBusy(true);
    try {
      if (editor.mode === 'import')
        await importMemory(
          editor.format === 'json'
            ? { format: 'json', content: editor.content }
            : {
                format: 'markdown',
                content: editor.content,
                scope,
                source: editor.source,
                title: editor.title,
              },
        );
      else if (editor.mode === 'edit' && selected)
        await updateMemory(selected.id, {
          expectedVersion: selected.version,
          scope,
          title: editor.title,
          source: editor.source,
          content: editor.content,
        });
      else
        await createMemory({
          scope,
          title: editor.title,
          source: editor.source,
          content: editor.content,
        });
      closeEditorDialog();
      await load();
      notify('记忆已保存');
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '记忆暂时无法保存');
    } finally {
      setBusy(false);
    }
  };
  const download = async (format: 'json' | 'markdown') => {
    if (!scope) return;
    try {
      const content = await exportMemory(
        format,
        scope,
        format === 'markdown' ? selected?.id : undefined,
      );
      const blob = new Blob([content], {
        type: format === 'json' ? 'application/json' : 'text/markdown',
      });
      const anchor = document.createElement('a');
      anchor.href = URL.createObjectURL(blob);
      anchor.download = `waker-memory.${format === 'json' ? 'json' : 'md'}`;
      anchor.click();
      URL.revokeObjectURL(anchor.href);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '导出失败');
    }
  };
  const rollback = async (snapshot: MemorySnapshot, apply: boolean) => {
    if (!selected || !scope) return;
    try {
      const result = await rollbackMemory({
        snapshotId: snapshot.id,
        expectedVersion: selected.version,
        scope,
        apply,
      });
      notify(apply ? '已应用回滚' : `预检完成：${JSON.stringify(result)}`);
      if (apply) await load();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '回滚失败');
    }
  };
  const compare = async () => {
    const [from, to] = history.snapshots.slice(-2);
    if (from && to) setDiff(await fetchMemoryDiff(from.id, to.id).catch(() => '无法生成差异'));
  };
  return (
    <section className="legacy-page memory-page">
      <header className="legacy-page-header">
        <div>
          <h1>记忆</h1>
          <p>管理个人、项目与群组范围的本地长期记忆、版本与回滚。</p>
        </div>
        <div className="page-actions">
          <button className="legacy-button" onClick={onClose}>
            返回 Waker
          </button>
          <button
            className="legacy-button"
            disabled={!scope}
            onClick={(event) => {
              event.currentTarget.focus();
              editorTriggerRef.current = event.currentTarget;
              setEditor({ ...blank, mode: 'import' });
            }}
          >
            <UploadSimple size={15} />
            导入
          </button>
          <button
            className="legacy-button primary"
            disabled={!scope}
            onClick={(event) => {
              event.currentTarget.focus();
              editorTriggerRef.current = event.currentTarget;
              setEditor(blank);
            }}
          >
            <Plus size={15} />
            新建记忆
          </button>
        </div>
      </header>
      <div className="memory-scope-bar">
        <div className="waker-tabs memory-scope-tabs" role="tablist" aria-label="记忆范围">
          <button
            type="button"
            role="tab"
            aria-selected={scopeType === 'waker'}
            className={cx('waker-tab', scopeType === 'waker' && 'active')}
            onClick={() => setScopeType('waker')}
          >
            个人
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={scopeType === 'project'}
            className={cx('waker-tab', scopeType === 'project' && 'active')}
            onClick={() => setScopeType('project')}
          >
            项目
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={scopeType === 'group'}
            className="waker-tab"
            disabled
            title="云端多 Waker 群组在本地模式不可用"
          >
            群组
          </button>
        </div>
        {scopeType === 'project' &&
          projects !== null &&
          (projects.length ? (
            <select
              className="config-select memory-scope-select"
              aria-label="选择项目"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="memory-scope-empty">
              当前 Waker 还没有项目，请先在「项目」页创建。
            </span>
          ))}
      </div>
      {error ? (
        <div className="legacy-error" role="alert">
          <p>{error}</p>
          <button className="legacy-button" onClick={() => void load()}>
            重试
          </button>
        </div>
      ) : items === null ? (
        <div className="loading-rows">
          <i />
          <i />
          <i />
        </div>
      ) : (
        <div className="memory-layout">
          <aside className="memory-list">
            {items.length ? (
              items.map((item) => (
                <button
                  className={cx(selected?.id === item.id && 'active')}
                  key={item.id}
                  onClick={() => setSelected(item)}
                >
                  <strong>{item.title}</strong>
                  <small>
                    {item.source} · v{item.version}
                  </small>
                </button>
              ))
            ) : (
              <div className="legacy-empty">
                <h2>还没有记忆</h2>
                <p>创建或导入一条本地记忆。</p>
              </div>
            )}
          </aside>
          <main className="memory-detail">
            {selected ? (
              <>
                <div className="memory-title">
                  <div>
                    <h2>{selected.title}</h2>
                    <p>
                      {selected.scope.type}:{selected.scope.id} · {selected.source} · v
                      {selected.version}
                    </p>
                  </div>
                  <div className="page-actions">
                    <button className="legacy-button" onClick={() => void download('json')}>
                      <DownloadSimple size={14} />
                      JSON
                    </button>
                    <button className="legacy-button" onClick={() => void download('markdown')}>
                      Markdown
                    </button>
                    <button
                      className="legacy-button"
                      onClick={(event) => {
                        event.currentTarget.focus();
                        editorTriggerRef.current = event.currentTarget;
                        setEditor({
                          mode: 'edit',
                          title: selected.title,
                          source: selected.source,
                          content: selected.content,
                          format: 'markdown',
                        });
                      }}
                    >
                      编辑
                    </button>
                  </div>
                </div>
                <pre className="memory-content">{selected.content}</pre>
                <div className="memory-history-head">
                  <h3>版本与快照</h3>
                  <button
                    className="legacy-button"
                    disabled={history.snapshots.length < 2}
                    onClick={() => void compare()}
                  >
                    比较最近版本
                  </button>
                  <button
                    className="legacy-button"
                    onClick={async () => {
                      await createMemorySnapshot(selected.id);
                      setHistory(await fetchMemoryHistory(selected.id));
                    }}
                  >
                    <ClockCounterClockwise size={14} />
                    创建快照
                  </button>
                </div>
                {diff && <pre className="memory-diff">{diff}</pre>}
                <div className="timeline-list">
                  {history.snapshots.map((snapshot) => (
                    <div key={snapshot.id}>
                      <span>
                        <strong>{snapshot.operation}</strong>
                        <small>{new Date(snapshot.createdAt).toLocaleString()}</small>
                      </span>
                      <button
                        className="legacy-text-button"
                        onClick={() => void rollback(snapshot, false)}
                      >
                        预检
                      </button>
                      <button
                        className="legacy-text-button"
                        onClick={() => void rollback(snapshot, true)}
                      >
                        <ArrowCounterClockwise size={13} />
                        回滚
                      </button>
                    </div>
                  ))}
                  {timeline
                    .filter((entry) => entry.documentId === selected.id)
                    .map((entry) => (
                      <div key={entry.id}>
                        <span>
                          <strong>{entry.action}</strong>
                          <small>
                            v{entry.version} · {new Date(entry.createdAt).toLocaleString()}
                          </small>
                        </span>
                        <b className="resource-status">{entry.status}</b>
                      </div>
                    ))}
                </div>
              </>
            ) : (
              <div className="legacy-empty">
                <h2>选择一条记忆</h2>
                <p>查看内容、版本和时间线。</p>
              </div>
            )}
          </main>
        </div>
      )}
      {editor && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeEditorDialog();
          }}
        >
          <form
            ref={editorDialogRef}
            tabIndex={-1}
            className="memory-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="memory-form-title"
            onSubmit={submit}
          >
            <h2 id="memory-form-title">
              {editor.mode === 'import'
                ? '导入记忆'
                : editor.mode === 'edit'
                  ? '编辑记忆'
                  : '新建记忆'}
            </h2>
            {editor.mode === 'import' && (
              <label>
                格式
                <select
                  value={editor.format}
                  onChange={(event) =>
                    setEditor({ ...editor, format: event.target.value as 'json' | 'markdown' })
                  }
                >
                  <option value="markdown">Markdown</option>
                  <option value="json">JSON</option>
                </select>
              </label>
            )}
            {editor.format === 'markdown' && (
              <>
                <label>
                  标题
                  <input
                    autoFocus
                    value={editor.title}
                    onChange={(event) => setEditor({ ...editor, title: event.target.value })}
                  />
                </label>
                <label>
                  来源
                  <input
                    value={editor.source}
                    onChange={(event) => setEditor({ ...editor, source: event.target.value })}
                  />
                </label>
              </>
            )}
            <label>
              内容
              <textarea
                autoFocus={editor.format === 'json'}
                rows={12}
                value={editor.content}
                onChange={(event) => setEditor({ ...editor, content: event.target.value })}
              />
            </label>
            <div className="dialog-actions">
              <button type="button" className="legacy-button" onClick={closeEditorDialog}>
                取消
              </button>
              <button
                className="legacy-button primary"
                disabled={
                  busy ||
                  !editor.content.trim() ||
                  (editor.format === 'markdown' && (!editor.title.trim() || !editor.source.trim()))
                }
              >
                <FloppyDisk size={14} />
                {busy ? '保存中…' : '保存'}
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
