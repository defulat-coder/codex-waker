import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { motion } from 'motion/react';
import type { ProjectDeleteImpact, WakerProject } from '@waker/contracts';
import { PencilSimple } from '@phosphor-icons/react/dist/icons/PencilSimple';
import { Plus } from '@phosphor-icons/react/dist/icons/Plus';
import { Trash } from '@phosphor-icons/react/dist/icons/Trash';
import { fetchLocalResources } from '../lib/api.js';
import { cx } from '../lib/cx.js';
import { readableErrorMessage } from '../lib/errors.js';
import {
  createProject,
  deleteProject,
  fetchProjectDeleteImpact,
  updateProject,
  type ProjectInput,
} from '../lib/projectApi.js';
import { useDialogFocus } from '../hooks/useDialogFocus.js';
import { MotionLoadingRows } from './MotionFeedback.js';
import type { Notify } from './Toasts.js';
import { MOTION_DIALOG_BACKDROP, MOTION_DIALOG_SURFACE, MOTION_TRANSITION } from '../lib/motion.js';

type Editor = ProjectInput & { mode: 'create' | 'edit' };

const PROJECT_STATUS_LABELS: Record<WakerProject['status'], string> = {
  ready: '就绪',
  initializing: '初始化中',
  error: '异常',
};

const blankEditor: Editor = {
  mode: 'create',
  name: '',
  description: '',
  visibility: 'private',
  source: 'filesystem',
  path: '',
};

export function ProjectManagementView({
  wakerId,
  onClose,
  notify,
  onChanged,
}: {
  wakerId: string;
  onClose?: () => void;
  notify: Notify;
  onChanged?: () => void;
}) {
  const [items, setItems] = useState<WakerProject[] | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [error, setError] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WakerProject | null>(null);
  const [impact, setImpact] = useState<ProjectDeleteImpact | null>(null);
  const [impactError, setImpactError] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const editorTriggerRef = useRef<HTMLButtonElement>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);
  const closeEditor = useCallback(() => {
    if (!busy) setEditor(null);
  }, [busy]);
  const closeDelete = useCallback(() => {
    if (!busy) setDeleteTarget(null);
  }, [busy]);
  const editorDialogRef = useDialogFocus<HTMLFormElement>(Boolean(editor), closeEditor);
  const deleteDialogRef = useDialogFocus<HTMLDivElement>(Boolean(deleteTarget), closeDelete);

  const load = useCallback(async () => {
    try {
      setError('');
      const projects = (await fetchLocalResources(wakerId)).projects;
      setItems(projects);
      setSelectedId((current) =>
        projects.some((project) => project.id === current) ? current : (projects[0]?.id ?? ''),
      );
    } catch (cause) {
      setError(readableErrorMessage(cause, '项目暂时无法读取'));
    }
  }, [wakerId]);

  useEffect(() => {
    setItems(null);
    setSelectedId('');
    void load();
  }, [load]);

  useEffect(() => {
    const reload = () => void load();
    window.addEventListener('waker:resources-changed', reload);
    return () => window.removeEventListener('waker:resources-changed', reload);
  }, [load]);

  const selected = items?.find((project) => project.id === selectedId) ?? null;
  const selectedOwned = selected?.wakerId === wakerId;

  const openEditor = (event: React.MouseEvent<HTMLButtonElement>, project?: WakerProject) => {
    if (project && project.wakerId !== wakerId) return;
    editorTriggerRef.current = event.currentTarget;
    setEditor(
      project
        ? {
            mode: 'edit',
            name: project.name,
            description: project.description ?? '',
            visibility: project.visibility,
            source: project.source,
            path: project.path,
          }
        : { ...blankEditor },
    );
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!editor) return;
    const input: ProjectInput = {
      name: editor.name.trim(),
      description: editor.description?.trim() ?? '',
      visibility: editor.visibility,
      source: editor.source,
      path: editor.path.trim(),
    };
    if (!input.name || !input.path) return;
    setBusy(true);
    try {
      const saved =
        editor.mode === 'edit' && selected
          ? await updateProject(wakerId, selected.id, input)
          : await createProject(wakerId, input);
      setEditor(null);
      await load();
      setSelectedId(saved.id);
      window.dispatchEvent(new window.Event('waker:resources-changed'));
      onChanged?.();
      notify(editor.mode === 'edit' ? '项目已更新' : '项目已创建', 'success');
    } catch (cause) {
      notify(readableErrorMessage(cause, '项目暂时无法保存'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const loadImpact = useCallback(async () => {
    if (!deleteTarget) return;
    setImpact(null);
    setImpactError('');
    try {
      setImpact(await fetchProjectDeleteImpact(wakerId, deleteTarget.id));
    } catch (cause) {
      setImpactError(readableErrorMessage(cause, '删除影响暂时无法读取'));
    }
  }, [deleteTarget, wakerId]);

  useEffect(() => {
    if (deleteTarget) void loadImpact();
  }, [deleteTarget, loadImpact]);

  const openDelete = (event: React.MouseEvent<HTMLButtonElement>, project: WakerProject) => {
    if (project.wakerId !== wakerId) return;
    deleteTriggerRef.current = event.currentTarget;
    setConfirmation('');
    setDeleteTarget(project);
  };

  const confirmDelete = async () => {
    if (!deleteTarget || !impact || confirmation !== deleteTarget.name) return;
    setBusy(true);
    try {
      await deleteProject(wakerId, deleteTarget.id);
      setDeleteTarget(null);
      await load();
      window.dispatchEvent(new window.Event('waker:resources-changed'));
      onChanged?.();
      notify('项目已删除', 'success');
    } catch (cause) {
      setImpactError(readableErrorMessage(cause, '项目暂时无法删除'));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!editor) editorTriggerRef.current?.focus();
  }, [editor]);
  useEffect(() => {
    if (!deleteTarget) deleteTriggerRef.current?.focus();
  }, [deleteTarget]);

  return (
    <section className="legacy-page">
      <header className="legacy-page-header">
        <div>
          <h1>项目</h1>
          <p>管理当前 Waker 可使用的本地目录与 Git checkout。</p>
        </div>
        <div className="page-actions">
          {onClose && (
            <button className="legacy-button" onClick={onClose}>
              返回 Waker
            </button>
          )}
          <button className="legacy-button primary" onClick={(event) => openEditor(event)}>
            <Plus size={15} />
            新建项目
          </button>
        </div>
      </header>

      {error ? (
        <div className="legacy-error" role="alert">
          <p>{error}</p>
          <button className="legacy-button" onClick={() => void load()}>
            重试
          </button>
        </div>
      ) : items === null ? (
        <MotionLoadingRows label="正在加载项目" />
      ) : items.length ? (
        <div className="memory-layout">
          <aside className="memory-list" aria-label="项目列表">
            {items.map((project) => (
              <motion.button
                className={cx(selectedId === project.id && 'active')}
                key={project.id}
                aria-pressed={selectedId === project.id}
                onClick={() => setSelectedId(project.id)}
                layout="position"
                whileTap={{ scale: 0.985 }}
              >
                <strong>{project.name}</strong>
                <small>
                  {project.visibility === 'public' ? '公开' : '私有'} ·{' '}
                  {project.source === 'git' ? 'Git' : '文件系统'}
                  {project.wakerId !== wakerId ? ' · 只读' : ''}
                </small>
              </motion.button>
            ))}
          </aside>
          <section className="memory-detail">
            {selected && (
              <motion.div
                className="master-detail-content"
                key={selected.id}
                initial={{ opacity: 0, x: 6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={MOTION_TRANSITION.routine}
              >
                <div className="memory-title">
                  <div>
                    <h2>{selected.name}</h2>
                    <p>{selected.description || '暂无描述'}</p>
                  </div>
                  <div className="page-actions">
                    <button
                      className="legacy-button"
                      disabled={!selectedOwned}
                      title={!selectedOwned ? '公开项目只有所属 Waker 可以编辑' : undefined}
                      onClick={(event) => openEditor(event, selected)}
                    >
                      <PencilSimple size={14} />
                      编辑
                    </button>
                    <button
                      className="legacy-text-button danger"
                      disabled={!selectedOwned}
                      title={!selectedOwned ? '公开项目只有所属 Waker 可以删除' : undefined}
                      onClick={(event) => openDelete(event, selected)}
                    >
                      <Trash size={14} />
                      删除
                    </button>
                  </div>
                </div>
                <section className="legacy-subsection" aria-label="项目详情">
                  <dl className="settings-rows">
                    <div className="settings-row">
                      <dt>状态</dt>
                      <dd>
                        <span className={cx('resource-status', selected.status)}>
                          {PROJECT_STATUS_LABELS[selected.status]}
                        </span>
                        {selected.error && <span>{selected.error}</span>}
                      </dd>
                    </div>
                    <div className="settings-row">
                      <dt>可见性</dt>
                      <dd>{selected.visibility === 'public' ? '公开项目' : '私有项目'}</dd>
                    </div>
                    <div className="settings-row">
                      <dt>管理权限</dt>
                      <dd>
                        {selectedOwned ? '当前 Waker 可管理' : '其他 Waker 的公开项目（只读）'}
                      </dd>
                    </div>
                    <div className="settings-row">
                      <dt>来源</dt>
                      <dd>{selected.source === 'git' ? '本地 Git checkout' : '本地文件系统'}</dd>
                    </div>
                    <div className="settings-row">
                      <dt>本地路径</dt>
                      <dd>
                        <code>{selected.path}</code>
                      </dd>
                    </div>
                    <div className="settings-row">
                      <dt>最近更新</dt>
                      <dd>{new Date(selected.updatedAt).toLocaleString()}</dd>
                    </div>
                  </dl>
                </section>
              </motion.div>
            )}
          </section>
        </div>
      ) : (
        <div className="legacy-empty">
          <img src="/legacy/empty-project-icon.svg" alt="" />
          <h2>还没有项目</h2>
          <p>添加仓库内的本地目录或 Git checkout，供当前 Waker 在会话中使用。</p>
          <button className="legacy-button primary" onClick={(event) => openEditor(event)}>
            <Plus size={15} />
            新建第一个项目
          </button>
        </div>
      )}

      {editor && (
        <motion.div
          className="modal-backdrop"
          role="presentation"
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
            aria-labelledby="project-editor-title"
            onSubmit={submit}
            {...MOTION_DIALOG_SURFACE}
          >
            <h2 id="project-editor-title">{editor.mode === 'edit' ? '编辑项目' : '新建项目'}</h2>
            <label>
              名称
              <input
                autoFocus
                required
                maxLength={160}
                value={editor.name}
                disabled={busy}
                onChange={(event) => setEditor({ ...editor, name: event.target.value })}
              />
            </label>
            <label>
              描述
              <textarea
                rows={3}
                maxLength={2000}
                value={editor.description}
                disabled={busy}
                onChange={(event) => setEditor({ ...editor, description: event.target.value })}
              />
            </label>
            <label>
              可见性
              <select
                value={editor.visibility}
                disabled={busy}
                onChange={(event) =>
                  setEditor({
                    ...editor,
                    visibility: event.target.value as WakerProject['visibility'],
                  })
                }
              >
                <option value="private">私有</option>
                <option value="public">公开</option>
              </select>
            </label>
            <label>
              来源
              <select
                value={editor.source}
                disabled={busy}
                onChange={(event) =>
                  setEditor({ ...editor, source: event.target.value as WakerProject['source'] })
                }
              >
                <option value="filesystem">本地文件系统</option>
                <option value="git">本地 Git checkout</option>
              </select>
            </label>
            <label>
              本地路径
              <input
                required
                maxLength={4000}
                value={editor.path}
                disabled={busy}
                placeholder="例如 packages/example"
                aria-describedby="project-path-hint"
                onChange={(event) => setEditor({ ...editor, path: event.target.value })}
              />
              <small id="project-path-hint">
                可输入相对或绝对路径；必须位于当前工作区内。Git 来源必须指向已有 checkout。
              </small>
            </label>
            <div className="dialog-actions">
              <button type="button" className="legacy-button" disabled={busy} onClick={closeEditor}>
                取消
              </button>
              <button
                className="legacy-button primary"
                disabled={busy || !editor.name.trim() || !editor.path.trim()}
              >
                {busy ? '保存中…' : '保存'}
              </button>
            </div>
          </motion.form>
        </motion.div>
      )}

      {deleteTarget && (
        <motion.div
          className="modal-backdrop"
          role="presentation"
          {...MOTION_DIALOG_BACKDROP}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeDelete();
          }}
        >
          <motion.div
            ref={deleteDialogRef}
            tabIndex={-1}
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="project-delete-title"
            {...MOTION_DIALOG_SURFACE}
          >
            <div className="modal-head">
              <strong id="project-delete-title">删除项目：{deleteTarget.name}</strong>
            </div>
            {!impact && !impactError && <p className="modal-hint">正在检查真实删除影响…</p>}
            {impact && (
              <div className="modal-hint">
                <p>
                  删除后会移除 {impact.sessionContexts} 条会话项目关联；{impact.tasksPreserved}{' '}
                  条任务会解除项目关联并保留历史与时间线。
                </p>
                <p>
                  {impact.automationDefinitions} 个自动任务会解除项目关联并暂停；
                  {impact.automationRuns} 条运行历史及其 {impact.automationTasksPreserved}{' '}
                  条任务记录会保留。
                </p>
                <p>
                  {impact.workflowDefinitions} 个工作流会解除项目关联并暂停；
                  {impact.workflowRuns} 条工作流运行历史会保留。
                </p>
                <p>磁盘上的目录和 Git checkout 不会被删除。</p>
              </div>
            )}
            {impactError && (
              <div className="legacy-error" role="alert">
                <p>{impactError}</p>
                <button className="legacy-button" onClick={() => void loadImpact()}>
                  重新检查
                </button>
              </div>
            )}
            <label className="modal-field">
              <span>输入项目名称以确认</span>
              <input
                autoFocus
                value={confirmation}
                disabled={busy || !impact}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </label>
            <div className="modal-actions">
              <button className="header-button" disabled={busy} onClick={closeDelete}>
                取消
              </button>
              <button
                className="header-button danger"
                disabled={busy || !impact || confirmation !== deleteTarget.name}
                onClick={() => void confirmDelete()}
              >
                {busy ? '删除中…' : '删除项目'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </section>
  );
}
