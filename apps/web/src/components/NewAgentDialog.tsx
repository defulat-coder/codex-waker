import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CaretDown } from '@phosphor-icons/react/dist/icons/CaretDown';
import { CircleNotch } from '@phosphor-icons/react/dist/icons/CircleNotch';
import { X } from '@phosphor-icons/react/dist/icons/X';
import type { AgentTemplate, CreateAgentRequest } from '@waker/contracts';
import { createAgent, fetchAgentRoleTemplates, uploadAgentAvatar } from '../lib/api.js';
import { blankAgentRequest } from '../lib/explore.js';
import { readFileBase64 } from '../lib/composerAttachments.js';
import { cx } from '../lib/cx.js';
import { MOTION_EASE } from '../lib/motion.js';
import { useDialogFocus } from '../hooks/useDialogFocus.js';
import { AgentChip } from './AgentChip.js';

const AGENT_ID = /^[a-z][a-z0-9-]{1,63}$/;
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_MIME_TYPES = ['image/png', 'image/jpeg'];
const AVATAR_PAGE_SIZE = 20;
const AVATAR_LIBRARY = Array.from({ length: 100 }, (_, index) => {
  const number = String(index + 1).padStart(3, '0');
  return {
    id: number,
    url: `/avatars/high-quality-100/waker-avatar-hq-${number}.jpg`,
  };
});

function suggestedId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 64);
}

interface AvatarDraft {
  file: File;
  previewUrl: string;
}

export function NewAgentDialog({
  open,
  onClose,
  onCreated,
  hostName,
  onAvatarError,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (agentId: string) => void;
  /** 本机 hostname，来自 GET /api/v1/workspace 的 host.name。 */
  hostName: string;
  /** 头像在 Agent 创建成功后上传失败时调用；Agent 本身已保留。 */
  onAvatarError?: (message: string) => void;
}) {
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [templateId, setTemplateId] = useState('custom');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [id, setId] = useState('');
  const [avatar, setAvatar] = useState<AvatarDraft | null>(null);
  const [avatarLibraryOpen, setAvatarLibraryOpen] = useState(false);
  const [avatarPage, setAvatarPage] = useState(0);
  const [selectedLibraryAvatar, setSelectedLibraryAvatar] = useState('');
  const [loadingLibraryAvatar, setLoadingLibraryAvatar] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useDialogFocus<HTMLFormElement>(open, onClose);

  useEffect(() => {
    if (!open) return;
    setTemplateId('custom');
    setName('');
    setDescription('');
    setId('');
    setAvatar(null);
    setAvatarLibraryOpen(false);
    setAvatarPage(0);
    setSelectedLibraryAvatar('');
    setLoadingLibraryAvatar('');
    setAdvanced(false);
    setSaving(false);
    setError('');
    let cancelled = false;
    fetchAgentRoleTemplates()
      .then((items) => {
        if (!cancelled) setTemplates(items);
      })
      .catch(() => {
        // 模板加载失败不阻塞创建：画廊只剩「自定义角色」。
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const selectedTemplate = templates.find((template) => template.id === templateId);

  const selectTemplate = (template: AgentTemplate) => {
    setTemplateId(template.id);
    setName(template.name);
    setDescription(template.description);
    setId(template.id);
    setError('');
  };

  const selectCustom = () => {
    setTemplateId('custom');
    setName('');
    setDescription('');
    setId('');
    setError('');
  };

  const pickAvatar = async (file: File | undefined, libraryId = '') => {
    if (!file) return;
    if (!AVATAR_MIME_TYPES.includes(file.type)) {
      setError('头像仅支持 PNG / JPG 图片');
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      setError('头像文件不能超过 2 MB');
      return;
    }
    try {
      const previewUrl = `data:${file.type};base64,${await readFileBase64(file)}`;
      setAvatar({ file, previewUrl });
      setSelectedLibraryAvatar(libraryId);
      setError('');
    } catch {
      setError('浏览器无法读取头像文件');
    }
  };

  const pickLibraryAvatar = async (entry: (typeof AVATAR_LIBRARY)[number]) => {
    if (saving || loadingLibraryAvatar) return;
    setLoadingLibraryAvatar(entry.id);
    try {
      const response = await fetch(entry.url);
      if (!response.ok) throw new Error('头像资源暂时无法读取');
      const blob = await response.blob();
      await pickAvatar(
        new File([blob], `waker-avatar-${entry.id}.jpg`, { type: 'image/jpeg' }),
        entry.id,
      );
      setAvatarLibraryOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '头像资源暂时无法读取');
    } finally {
      setLoadingLibraryAvatar('');
    }
  };

  const avatarPageCount = Math.ceil(AVATAR_LIBRARY.length / AVATAR_PAGE_SIZE);
  const visibleAvatars = AVATAR_LIBRARY.slice(
    avatarPage * AVATAR_PAGE_SIZE,
    (avatarPage + 1) * AVATAR_PAGE_SIZE,
  );

  const derived = suggestedId(name);
  const effectiveId = id.trim() || derived;
  const valid = Boolean(name.trim()) && AGENT_ID.test(effectiveId);
  const markPreview =
    selectedTemplate?.mark ?? (name.trim() ? blankAgentRequest(name, description).mark : '＋');

  const submit = async () => {
    if (!valid || saving) {
      if (name.trim() && !AGENT_ID.test(effectiveId)) {
        setAdvanced(true);
        setError('中文名称或特殊字符名称需要填写合法的 Waker id。');
      }
      return;
    }
    setSaving(true);
    setError('');
    try {
      const request: CreateAgentRequest = selectedTemplate
        ? {
            id: effectiveId,
            name: name.trim(),
            mark: selectedTemplate.mark,
            tagline: selectedTemplate.tagline,
            description: description.trim() || selectedTemplate.description,
            suggestions: [...selectedTemplate.suggestions],
            body: selectedTemplate.body,
            // 关于我区块随模板带入新 Agent；没有则不传（不造数据）。
            ...(selectedTemplate.strengths
              ? { strengths: selectedTemplate.strengths.map((item) => ({ ...item })) }
              : {}),
            ...(selectedTemplate.workStyles
              ? { workStyles: selectedTemplate.workStyles.map((item) => ({ ...item })) }
              : {}),
          }
        : blankAgentRequest(name, description, effectiveId);
      const created = await createAgent(request);
      if (avatar) {
        try {
          await uploadAgentAvatar(created.id, avatar.file);
        } catch (cause) {
          // Agent 已创建成功，只报告头像失败，不回滚。
          onAvatarError?.(
            `Waker 已创建，但头像上传失败：${cause instanceof Error ? cause.message : '未知错误'}`,
          );
        }
      }
      onCreated(created.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Agent 暂时无法创建');
    } finally {
      setSaving(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="modal-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !saving) onClose();
          }}
        >
          <motion.form
            ref={dialogRef}
            tabIndex={-1}
            className="modal-card agent-create-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-agent-title"
            initial={{ opacity: 0, scale: 0.98, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 8 }}
            transition={{ duration: 0.2, ease: MOTION_EASE }}
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="modal-head">
              <strong id="new-agent-title">新建 Waker</strong>
              <button
                type="button"
                className="icon-button"
                aria-label="关闭"
                onClick={onClose}
                disabled={saving}
              >
                <X size={14} />
              </button>
            </div>
            <div className="modal-field">
              <span>选择一个角色</span>
              <div className="agent-role-gallery" role="listbox" aria-label="选择一个角色">
                <motion.button
                  type="button"
                  role="option"
                  aria-selected={!selectedTemplate}
                  className={cx('agent-role-card', !selectedTemplate && 'selected')}
                  whileTap={{ scale: 0.97 }}
                  onClick={selectCustom}
                  disabled={saving}
                >
                  <AgentChip mark="＋" className="medium" />
                  <span className="agent-role-card-title">
                    <strong>自定义角色</strong>
                    <small>从空白开始创建</small>
                  </span>
                </motion.button>
                {templates.map((template) => (
                  <motion.button
                    key={template.id}
                    type="button"
                    role="option"
                    aria-selected={templateId === template.id}
                    className={cx('agent-role-card', templateId === template.id && 'selected')}
                    whileTap={{ scale: 0.97 }}
                    onClick={() => selectTemplate(template)}
                    disabled={saving}
                  >
                    <AgentChip mark={template.mark} className="medium" />
                    <span className="agent-role-card-title">
                      <strong>{template.name}</strong>
                      <small>{template.tagline || template.description}</small>
                    </span>
                  </motion.button>
                ))}
              </div>
            </div>
            <AnimatePresence initial={false}>
              {selectedTemplate && (
                <motion.div
                  className="agent-persona-preview"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.15, ease: MOTION_EASE }}
                >
                  <span>角色设定（来自模板，创建后可编辑）</span>
                  <pre>{selectedTemplate.body}</pre>
                </motion.div>
              )}
            </AnimatePresence>
            <label className="modal-field">
              <span>名称 *</span>
              <input
                value={name}
                autoFocus
                maxLength={80}
                placeholder="请输入 Waker 名称"
                onChange={(event) => {
                  setName(event.target.value);
                  setError('');
                }}
                disabled={saving}
              />
            </label>
            <label className="modal-field">
              <span>简介</span>
              <textarea
                value={description}
                rows={3}
                maxLength={400}
                placeholder="说明它负责什么、如何工作。留空也可以稍后配置。"
                onChange={(event) => setDescription(event.target.value)}
                disabled={saving}
              />
            </label>
            <div className="modal-field">
              <span>头像</span>
              <div className="agent-avatar-row">
                {avatar ? (
                  <img className="agent-avatar-preview" src={avatar.previewUrl} alt="头像预览" />
                ) : (
                  <AgentChip mark={markPreview} className="medium" />
                )}
                <button
                  type="button"
                  className="header-button"
                  aria-expanded={avatarLibraryOpen}
                  onClick={() => setAvatarLibraryOpen((value) => !value)}
                  disabled={saving}
                >
                  选择内置头像
                </button>
                <button
                  type="button"
                  className="header-button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={saving}
                >
                  上传本地头像
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg"
                  hidden
                  aria-label="选择头像文件"
                  onChange={(event) => {
                    void pickAvatar(event.target.files?.[0], '');
                    event.target.value = '';
                  }}
                />
              </div>
              <small>内置头像已优化为 160×160；本地上传支持 PNG / JPG，最大 2 MB。</small>
              <AnimatePresence initial={false}>
                {avatarLibraryOpen && (
                  <motion.div
                    className="agent-avatar-library"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.15, ease: MOTION_EASE }}
                  >
                    <div className="agent-avatar-library-head">
                      <span>内置头像 · {AVATAR_LIBRARY.length}</span>
                      <div>
                        <button
                          type="button"
                          aria-label="上一批头像"
                          disabled={avatarPage === 0 || saving}
                          onClick={() => setAvatarPage((page) => Math.max(0, page - 1))}
                        >
                          上一批
                        </button>
                        <small>
                          {avatarPage + 1} / {avatarPageCount}
                        </small>
                        <button
                          type="button"
                          aria-label="下一批头像"
                          disabled={avatarPage === avatarPageCount - 1 || saving}
                          onClick={() =>
                            setAvatarPage((page) => Math.min(avatarPageCount - 1, page + 1))
                          }
                        >
                          下一批
                        </button>
                      </div>
                    </div>
                    <div className="agent-avatar-grid" role="listbox" aria-label="内置头像">
                      {visibleAvatars.map((entry) => (
                        <button
                          type="button"
                          role="option"
                          aria-label={`头像 ${entry.id}`}
                          aria-selected={selectedLibraryAvatar === entry.id}
                          className={cx(selectedLibraryAvatar === entry.id && 'selected')}
                          disabled={saving || Boolean(loadingLibraryAvatar)}
                          onClick={() => void pickLibraryAvatar(entry)}
                          key={entry.id}
                        >
                          <img src={entry.url} alt="" loading="lazy" />
                          {loadingLibraryAvatar === entry.id && (
                            <CircleNotch size={16} className="spinning" aria-hidden="true" />
                          )}
                        </button>
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            <div className="modal-field agent-runtime-field">
              <span>运行环境</span>
              <p className="agent-runtime-value">本机 {hostName}（当前设备）· 在线</p>
            </div>
            <button
              type="button"
              className="agent-create-advanced"
              aria-expanded={advanced}
              onClick={() => setAdvanced((value) => !value)}
            >
              高级
              <CaretDown size={13} className={advanced ? 'open' : undefined} />
            </button>
            <AnimatePresence initial={false}>
              {advanced && (
                <motion.div
                  className="agent-create-advanced-body"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.15, ease: MOTION_EASE }}
                >
                  <label className="modal-field">
                    <span>Waker id</span>
                    <input
                      value={id}
                      maxLength={64}
                      placeholder={derived || '例如 support-triage'}
                      onChange={(event) => {
                        setId(event.target.value);
                        setError('');
                      }}
                      disabled={saving}
                    />
                    <small>用于 .codex/agents/&lt;id&gt;.md，仅支持小写字母、数字和连字符。</small>
                  </label>
                </motion.div>
              )}
            </AnimatePresence>
            {error && (
              <p className="modal-error" role="alert">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <button type="button" className="header-button" onClick={onClose} disabled={saving}>
                取消
              </button>
              <button
                type="submit"
                className="header-button primary"
                disabled={saving || !name.trim()}
              >
                {saving ? <CircleNotch size={13} className="spinning" /> : null}
                保存并启用
              </button>
            </div>
          </motion.form>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
