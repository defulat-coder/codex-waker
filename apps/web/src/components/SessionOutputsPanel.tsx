import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import type { SessionAttachment, SessionOutputsResponse } from '@waker/contracts';
import { DownloadSimple } from '@phosphor-icons/react/dist/icons/DownloadSimple';
import { Eye } from '@phosphor-icons/react/dist/icons/Eye';
import { FileArrowUp } from '@phosphor-icons/react/dist/icons/FileArrowUp';
import { Trash } from '@phosphor-icons/react/dist/icons/Trash';
import { X } from '@phosphor-icons/react/dist/icons/X';
import { useDialogFocus } from '../hooks/useDialogFocus.js';
import { usePanelFocus } from '../hooks/usePanelFocus.js';
import { selectSessionUploadBatch, type SessionUploadReport } from '../lib/sessionUpload.js';
import {
  createSessionArtifact,
  createSessionFileChange,
  deleteSessionAttachment,
  fetchSessionAttachmentBlob,
  fetchSessionOutputs,
  sessionAttachmentUrl,
  uploadSessionAttachment,
} from '../lib/api.js';
import { MotionLoadingRows } from './MotionFeedback.js';
import type { Notify } from './Toasts.js';
import { MOTION_DIALOG_BACKDROP, MOTION_DIALOG_SURFACE, MOTION_TRANSITION } from '../lib/motion.js';

const MAX_SELECTED_ATTACHMENTS = 8;
const MAX_TEXT_PREVIEW_BYTES = 64 * 1024;
const IMAGE_MIME_TYPES = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

type PreviewContent =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'image'; url: string }
  | { status: 'text'; text: string; truncated: boolean };

function readableFailure(cause: unknown, fallback: string): string {
  return cause instanceof TypeError
    ? fallback
    : cause instanceof Error
      ? cause.message
      : fallback;
}

function previewType(item: SessionAttachment): 'image' | 'text' | undefined {
  const mimeType = item.mimeType.toLowerCase().split(';')[0]?.trim();
  if (mimeType && IMAGE_MIME_TYPES.has(mimeType)) return 'image';
  if (
    mimeType === 'text/plain' ||
    mimeType === 'text/markdown' ||
    mimeType === 'application/json' ||
    /\.(?:md|markdown|txt|json)$/i.test(item.originalName)
  )
    return 'text';
  return undefined;
}

async function textPreview(blob: Blob, item: SessionAttachment) {
  const truncated = blob.size > MAX_TEXT_PREVIEW_BYTES;
  let text = await blob.slice(0, MAX_TEXT_PREVIEW_BYTES).text();
  if (!truncated && (item.mimeType === 'application/json' || /\.json$/i.test(item.originalName))) {
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      // Invalid JSON is still safe and useful when shown as plain text.
    }
  }
  return { text, truncated };
}

export function SessionOutputsPanel({
  agentId,
  sessionId,
  selectedIds,
  onToggle,
  onClose,
  returnFocusId,
  notify,
  maxSelected = MAX_SELECTED_ATTACHMENTS,
}: {
  agentId: string;
  sessionId: string;
  selectedIds: string[];
  onToggle: (id: string) => void;
  onClose: () => void;
  returnFocusId?: string;
  notify: Notify;
  maxSelected?: number;
}) {
  const panelRef = usePanelFocus<HTMLElement>(onClose, returnFocusId);
  const [data, setData] = useState<SessionOutputsResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploadReport, setUploadReport] = useState<SessionUploadReport[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [previewTarget, setPreviewTarget] = useState<SessionAttachment | null>(null);
  const [previewContent, setPreviewContent] = useState<PreviewContent>({ status: 'loading' });
  const [previewNonce, setPreviewNonce] = useState(0);
  const previewCloseRef = useRef<HTMLButtonElement>(null);
  const [deleteTarget, setDeleteTarget] = useState<SessionAttachment | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [change, setChange] = useState<{
    path: string;
    kind: 'add' | 'update' | 'delete';
    summary: string;
  }>({ path: '', kind: 'update', summary: '' });

  const load = useCallback(async () => {
    setError('');
    try {
      setData(await fetchSessionOutputs(agentId, sessionId));
    } catch (cause) {
      setError(readableFailure(cause, '附件与结果暂时无法读取'));
    }
  }, [agentId, sessionId]);

  const closePreview = useCallback(() => setPreviewTarget(null), []);
  const closeDelete = useCallback(() => {
    if (!deleting) setDeleteTarget(null);
  }, [deleting]);
  const previewDialogRef = useDialogFocus<HTMLDivElement>(Boolean(previewTarget), closePreview);
  const deleteDialogRef = useDialogFocus<HTMLDivElement>(Boolean(deleteTarget), closeDelete);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!previewTarget) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setPreviewContent({ status: 'loading' });
    void fetchSessionAttachmentBlob(agentId, sessionId, previewTarget.id, controller.signal)
      .then(async (blob) => {
        if (controller.signal.aborted) return;
        if (previewType(previewTarget) === 'image') {
          objectUrl = URL.createObjectURL(blob);
          setPreviewContent({ status: 'image', url: objectUrl });
          return;
        }
        setPreviewContent({ status: 'text', ...(await textPreview(blob, previewTarget)) });
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setPreviewContent({
            status: 'error',
            message: readableFailure(cause, '附件预览暂时无法读取'),
          });
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [agentId, previewNonce, previewTarget, sessionId]);

  const uploadFiles = async (files: File[]) => {
    if (!files.length || busy) return;
    setBusy(true);
    setUploadReport([]);
    try {
      const batch = selectSessionUploadBatch(files);
      const settled = await Promise.allSettled(
        batch.accepted.map((file) => uploadSessionAttachment(agentId, sessionId, file)),
      );
      const report = [
        ...settled.map<SessionUploadReport>((result, index) =>
          result.status === 'fulfilled'
            ? { fileName: batch.accepted[index]!.name, status: 'success', message: '已上传' }
            : {
                fileName: batch.accepted[index]!.name,
                status: 'error',
                message: result.reason instanceof Error ? result.reason.message : '上传失败',
              },
        ),
        ...batch.rejected,
      ];
      setUploadReport(report);
      const succeeded = report.filter((item) => item.status === 'success').length;
      const failed = report.length - succeeded;
      notify(
        failed ? `${succeeded} 个成功，${failed} 个失败` : `已上传 ${succeeded} 个附件`,
        failed ? 'error' : 'success',
      );
      await load();
    } finally {
      setBusy(false);
    }
  };

  const selectAll = () => {
    if (!data) return;
    const remaining = Math.max(0, maxSelected - selectedIds.length);
    const additions = data.attachments
      .filter((item) => !selectedIds.includes(item.id))
      .slice(0, remaining);
    additions.forEach((item) => onToggle(item.id));
    if (data.attachments.some((item) => !selectedIds.includes(item.id)) && additions.length === 0)
      notify(`当前轮次最多还能选择 ${maxSelected} 个已有附件`, 'info');
  };

  return (
    <motion.aside
      ref={panelRef}
      className="outputs-panel"
      role="complementary"
      aria-label="附件与结果"
      tabIndex={-1}
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      transition={MOTION_TRANSITION.panel}
    >
      <header>
        <div>
          <h2>附件与结果</h2>
          <p>会话输出保存在本地工作区。</p>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="关闭附件与结果"
          data-panel-close
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>
      <div className="outputs-body">
        <label
          className={`upload-box${dragActive ? ' drag-active' : ''}`}
          onDragEnter={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragActive(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragActive(false);
            void uploadFiles([...event.dataTransfer.files]);
          }}
        >
          <FileArrowUp size={20} />
          <span>{busy ? '批量上传中…' : '选择或拖入多个附件'}</span>
          <input
            type="file"
            multiple
            disabled={busy}
            aria-label="上传附件"
            onChange={(event) => {
              void uploadFiles([...(event.target.files ?? [])]);
              event.target.value = '';
            }}
          />
        </label>
        {uploadReport.length > 0 && (
          <ul className="upload-report" aria-label="附件上传结果" aria-live="polite">
            {uploadReport.map((item, index) => (
              <li className={item.status} key={`${item.fileName}-${index}`}>
                <strong>{item.fileName}</strong>
                <span>{item.message}</span>
              </li>
            ))}
          </ul>
        )}
        {error ? (
          <div className="legacy-error" role="alert">
            <p>{error}</p>
            <button className="legacy-button" onClick={() => void load()}>
              重试
            </button>
          </div>
        ) : !data ? (
          <MotionLoadingRows count={2} label="正在加载会话输出" />
        ) : (
          <>
            <OutputSection
              title="附件"
              actions={
                <>
                  <small>
                    {selectedIds.length}/{maxSelected} 已选
                  </small>
                  <span className="output-batch-actions">
                    <button
                      className="legacy-text-button"
                      disabled={!data.attachments.length || selectedIds.length >= maxSelected}
                      onClick={selectAll}
                    >
                      全选（最多 8 个）
                    </button>
                    <button
                      className="legacy-text-button"
                      disabled={!selectedIds.length}
                      onClick={() => selectedIds.forEach(onToggle)}
                    >
                      全不选
                    </button>
                  </span>
                </>
              }
            >
              {data.attachments.length ? (
                data.attachments.map((item) => {
                  const type = previewType(item);
                  return (
                    <div className="output-row attachment-row" key={item.id}>
                      <label className="attachment-select">
                        <input
                          type="checkbox"
                          aria-label={`下次对话使用 ${item.originalName}`}
                          checked={selectedIds.includes(item.id)}
                          disabled={
                            !selectedIds.includes(item.id) && selectedIds.length >= maxSelected
                          }
                          onChange={() => onToggle(item.id)}
                        />
                      </label>
                      {type === 'image' && (
                        <button
                          className="attachment-thumbnail"
                          aria-label={`预览 ${item.originalName}`}
                          onClick={() => setPreviewTarget(item)}
                        >
                          <img
                            src={sessionAttachmentUrl(agentId, sessionId, item.id)}
                            alt=""
                            loading="lazy"
                          />
                        </button>
                      )}
                      <span className="attachment-metadata">
                        <strong title={item.originalName}>{item.originalName}</strong>
                        <small>
                          {Math.ceil(item.size / 1024)} KB · {item.mimeType}
                        </small>
                      </span>
                      <span className="output-row-actions">
                        {type && type !== 'image' && (
                          <button
                            className="legacy-text-button"
                            onClick={() => setPreviewTarget(item)}
                          >
                            <Eye size={14} />
                            预览
                          </button>
                        )}
                        <a
                          className="legacy-text-button"
                          href={sessionAttachmentUrl(agentId, sessionId, item.id)}
                          download
                        >
                          <DownloadSimple size={14} />
                          下载
                        </a>
                        <button
                          className="legacy-text-button"
                          onClick={async () => {
                            try {
                              await createSessionArtifact(
                                agentId,
                                sessionId,
                                item.id,
                                item.originalName,
                              );
                              notify('结果已登记', 'success');
                              await load();
                            } catch (cause) {
                              notify(cause instanceof Error ? cause.message : '登记失败', 'error');
                            }
                          }}
                        >
                          登记结果
                        </button>
                        <button
                          className="legacy-text-button danger"
                          aria-label={`删除 ${item.originalName}`}
                          onClick={() => setDeleteTarget(item)}
                        >
                          <Trash size={14} />
                          删除
                        </button>
                      </span>
                    </div>
                  );
                })
              ) : (
                <p className="outputs-empty">尚未上传附件</p>
              )}
            </OutputSection>
            <OutputSection title="结果">
              {data.artifacts.length ? (
                data.artifacts.map((item) => (
                  <article className="output-row output-detail-row" key={item.id}>
                    <span>
                      <strong>{item.title}</strong>
                      <small>
                        {item.kind} · {new Date(item.createdAt).toLocaleString()}
                      </small>
                      <code title={item.path}>{item.path}</code>
                      {item.contentPreview && <pre>{item.contentPreview}</pre>}
                    </span>
                  </article>
                ))
              ) : (
                <p className="outputs-empty">尚未登记结果</p>
              )}
            </OutputSection>
            <OutputSection title="文件变更">
              {data.fileChanges.length ? (
                data.fileChanges.map((item) => (
                  <article className="output-row output-detail-row" key={item.id}>
                    <span>
                      <strong>{item.path}</strong>
                      <small>
                        {item.kind} · {new Date(item.createdAt).toLocaleString()}
                      </small>
                      <p>{item.summary || '未填写变更摘要'}</p>
                    </span>
                  </article>
                ))
              ) : (
                <p className="outputs-empty">尚未登记文件变更</p>
              )}
              <form
                className="file-change-form"
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (!change.path.trim()) return;
                  try {
                    await createSessionFileChange(agentId, sessionId, change);
                    setChange({ path: '', kind: 'update', summary: '' });
                    notify('文件变更已登记', 'success');
                    await load();
                  } catch (cause) {
                    notify(cause instanceof Error ? cause.message : '登记失败', 'error');
                  }
                }}
              >
                <input
                  aria-label="变更文件路径"
                  placeholder="相对路径，如 src/app.ts"
                  value={change.path}
                  onChange={(event) => setChange({ ...change, path: event.target.value })}
                />
                <select
                  aria-label="变更类型"
                  value={change.kind}
                  onChange={(event) =>
                    setChange({
                      ...change,
                      kind: event.target.value as 'add' | 'update' | 'delete',
                    })
                  }
                >
                  <option value="add">新增</option>
                  <option value="update">修改</option>
                  <option value="delete">删除</option>
                </select>
                <input
                  aria-label="变更摘要"
                  placeholder="摘要（可选）"
                  value={change.summary}
                  onChange={(event) => setChange({ ...change, summary: event.target.value })}
                />
                <button className="legacy-button" disabled={!change.path.trim()}>
                  登记
                </button>
              </form>
            </OutputSection>
          </>
        )}
      </div>

      {previewTarget && (
        <motion.div
          className="modal-backdrop"
          role="presentation"
          {...MOTION_DIALOG_BACKDROP}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closePreview();
          }}
        >
          <motion.div
            ref={previewDialogRef}
            className="memory-dialog attachment-preview-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="attachment-preview-title"
            tabIndex={-1}
            {...MOTION_DIALOG_SURFACE}
          >
            <div className="modal-head">
              <h2 id="attachment-preview-title">{previewTarget.originalName}</h2>
              <button
                ref={previewCloseRef}
                className="icon-button"
                type="button"
                aria-label="关闭预览"
                autoFocus
                onClick={closePreview}
              >
                <X size={18} />
              </button>
            </div>
            <div className="attachment-preview-content">
              {previewContent.status === 'loading' && (
                <p role="status" aria-busy="true">
                  正在读取本地附件…
                </p>
              )}
              {previewContent.status === 'error' && (
                <div className="legacy-error" role="alert">
                  <p>{previewContent.message}</p>
                  <button
                    type="button"
                    className="legacy-button"
                    onClick={() => {
                      previewCloseRef.current?.focus();
                      setPreviewNonce((value) => value + 1);
                    }}
                  >
                    重新读取
                  </button>
                </div>
              )}
              {previewContent.status === 'image' && (
                <img src={previewContent.url} alt={`${previewTarget.originalName} 预览`} />
              )}
              {previewContent.status === 'text' && (
                <>
                  <pre>{previewContent.text}</pre>
                  {previewContent.truncated && (
                    <p className="attachment-preview-note">
                      预览已在 64 KB 处截断，下载可查看完整内容。
                    </p>
                  )}
                </>
              )}
            </div>
            <div className="dialog-actions">
              <a
                className="legacy-button"
                href={sessionAttachmentUrl(agentId, sessionId, previewTarget.id)}
                download
              >
                <DownloadSimple size={14} />
                下载原文件
              </a>
              <button className="legacy-button" onClick={closePreview}>
                关闭
              </button>
            </div>
          </motion.div>
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
            className="memory-dialog attachment-delete-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="attachment-delete-title"
            tabIndex={-1}
            {...MOTION_DIALOG_SURFACE}
          >
            <h2 id="attachment-delete-title">删除附件</h2>
            <p>
              将永久删除 <strong>{deleteTarget.originalName}</strong>。已登记的结果记录仍会保留，
              但不能再通过此附件下载原文件。
            </p>
            <div className="dialog-actions">
              <button className="legacy-button" autoFocus disabled={deleting} onClick={closeDelete}>
                取消
              </button>
              <button
                className="legacy-text-button danger"
                disabled={deleting}
                onClick={async () => {
                  setDeleting(true);
                  try {
                    await deleteSessionAttachment(agentId, sessionId, deleteTarget.id);
                    if (selectedIds.includes(deleteTarget.id)) onToggle(deleteTarget.id);
                    setDeleteTarget(null);
                    notify('附件已删除', 'success');
                    await load();
                  } catch (cause) {
                    notify(cause instanceof Error ? cause.message : '附件删除失败', 'error');
                  } finally {
                    setDeleting(false);
                  }
                }}
              >
                {deleting ? '删除中…' : '永久删除'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </motion.aside>
  );
}

function OutputSection({
  title,
  actions,
  children,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="output-section">
      <div className="output-section-heading">
        <h3>{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}
