import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { WorkspaceResponse } from '@waker/contracts';
import { motion, useReducedMotion } from 'motion/react';
import { ArrowUp } from '@phosphor-icons/react/dist/icons/ArrowUp';
import { CaretDown } from '@phosphor-icons/react/dist/icons/CaretDown';
import { Check } from '@phosphor-icons/react/dist/icons/Check';
import { CircleNotch } from '@phosphor-icons/react/dist/icons/CircleNotch';
import { Cpu } from '@phosphor-icons/react/dist/icons/Cpu';
import { FileImage } from '@phosphor-icons/react/dist/icons/FileImage';
import { FileText } from '@phosphor-icons/react/dist/icons/FileText';
import { Paperclip } from '@phosphor-icons/react/dist/icons/Paperclip';
import { Plus } from '@phosphor-icons/react/dist/icons/Plus';
import { Terminal } from '@phosphor-icons/react/dist/icons/Terminal';
import { X } from '@phosphor-icons/react/dist/icons/X';
import { fetchPrompt } from '../lib/api.js';
import { cx } from '../lib/cx.js';
import { readableErrorMessage } from '../lib/errors.js';
import { MOTION_EASE, MOTION_LAYOUT_TRANSITION, MOTION_TRANSITION } from '../lib/motion.js';
import { filterPrompts, movePromptSelection, promptQueryFromInput } from '../lib/prompts.js';
import { handleCompositeKeyDown, useDismissable } from '../hooks/useDismissable.js';
import { useWorkspace } from '../context/WorkspaceContext.js';
import {
  formatAttachmentBytes,
  MAX_TURN_ATTACHMENTS,
  prepareComposerAttachments,
  type DraftComposerAttachment,
  type RejectedComposerAttachment,
} from '../lib/composerAttachments.js';
import { MotionSpinner } from './MotionFeedback.js';

type ModelCatalog = WorkspaceResponse['models'];

export type ComposerProps = {
  disabled: boolean;
  selectedModel: string | undefined;
  onSelectModel: (model: string | undefined) => void;
  onSend: (
    text: string,
    attachments?: DraftComposerAttachment[],
    onSuccess?: () => void,
  ) => boolean;
  attachments: DraftComposerAttachment[];
  onAttachmentsChange: (attachments: DraftComposerAttachment[]) => void;
  maxAttachments?: number;
  /** Explicit context reset; does not change during the first Welcome → Thread transition. */
  resetSignal?: number;
};

function ModelMenu({
  models,
  selectedModel,
  onSelect,
  onClose,
  onEscape,
}: {
  models: ModelCatalog;
  selectedModel: string | undefined;
  onSelect: (model: string | undefined) => void;
  onClose: () => void;
  onEscape: () => void;
}) {
  // workspace 拉取异常时 models 可能是数组/undefined：防御性归一，不让 Composer 白屏。
  const available = Array.isArray(models?.available) ? models.available : [];
  const currentName = models?.current?.model ?? '默认';
  return (
    <motion.div
      className="model-menu"
      role="listbox"
      aria-label="选择模型"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15, ease: MOTION_EASE }}
      onKeyDown={(event) => handleCompositeKeyDown(event, onEscape)}
    >
      <span className="model-menu-label">模型</span>
      <button
        type="button"
        role="option"
        tabIndex={-1}
        autoFocus={selectedModel === undefined}
        aria-selected={selectedModel === undefined}
        className={cx('model-option', selectedModel === undefined && 'selected')}
        onClick={() => {
          onSelect(undefined);
          onClose();
        }}
      >
        <span className="model-option-name">默认（{currentName}）</span>
        <Check size={14} weight="bold" />
      </button>
      {available.map((model) => (
        <button
          type="button"
          role="option"
          tabIndex={-1}
          autoFocus={selectedModel === model.id}
          key={model.id}
          aria-selected={selectedModel === model.id}
          className={cx('model-option', selectedModel === model.id && 'selected')}
          onClick={() => {
            onSelect(model.id);
            onClose();
          }}
        >
          <span className="model-option-name">{model.name}</span>
          <Check size={14} weight="bold" />
        </button>
      ))}
      {!available.length && <p className="model-menu-empty">暂无更多可用模型</p>}
    </motion.div>
  );
}

export function Composer({
  disabled,
  selectedModel,
  onSelectModel,
  onSend,
  attachments,
  onAttachmentsChange,
  maxAttachments = MAX_TURN_ATTACHMENTS,
  resetSignal = 0,
}: ComposerProps) {
  const { workspace } = useWorkspace();
  const reducedMotion = useReducedMotion();
  const prompts = workspace.prompts;
  const models = workspace.models;
  const [text, setText] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [activePrompt, setActivePrompt] = useState(0);
  const [panelDismissed, setPanelDismissed] = useState(false);
  const [loadingPrompt, setLoadingPrompt] = useState(false);
  const [promptError, setPromptError] = useState('');
  const [attachmentErrors, setAttachmentErrors] = useState<RejectedComposerAttachment[]>([]);
  const [preparingAttachments, setPreparingAttachments] = useState(false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const loadingPromptRef = useRef(false);
  const promptGenerationRef = useRef(0);
  const attachmentGenerationRef = useRef(0);
  const attachmentsRef = useRef<DraftComposerAttachment[]>([]);
  const promptListId = useId();
  attachmentsRef.current = attachments;
  const closeModelMenu = useCallback(() => setMenuOpen(false), []);
  useDismissable(modelMenuRef, closeModelMenu, menuOpen);

  useEffect(() => {
    promptGenerationRef.current += 1;
    attachmentGenerationRef.current += 1;
    loadingPromptRef.current = false;
    setText('');
    setMenuOpen(false);
    setActivePrompt(0);
    setPanelDismissed(false);
    setLoadingPrompt(false);
    setPromptError('');
    setAttachmentErrors([]);
    setPreparingAttachments(false);
    setDraggingFiles(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [resetSignal]);

  const promptQuery = promptQueryFromInput(text);
  const panelOpen = promptQuery !== null && !panelDismissed;
  const filtered = useMemo(
    () => (panelOpen ? filterPrompts(prompts, promptQuery) : []),
    [panelOpen, prompts, promptQuery],
  );

  useEffect(() => {
    setActivePrompt(0);
  }, [promptQuery]);

  const availableModels = Array.isArray(models?.available) ? models.available : [];
  const modelLabel = selectedModel
    ? (availableModels.find((model) => model.id === selectedModel)?.name ?? selectedModel)
    : (models?.current?.model ?? '默认');

  const applyPrompt = async (name: string) => {
    if (loadingPromptRef.current) return;
    loadingPromptRef.current = true;
    const generation = ++promptGenerationRef.current;
    setLoadingPrompt(true);
    setPromptError('');
    try {
      const document = await fetchPrompt(name);
      if (generation !== promptGenerationRef.current) return;
      setText(document.content.trim());
      textareaRef.current?.focus();
    } catch (cause) {
      if (generation !== promptGenerationRef.current) return;
      setPromptError(readableErrorMessage(cause, '提示词暂时无法读取'));
      textareaRef.current?.focus();
    } finally {
      if (generation === promptGenerationRef.current) {
        loadingPromptRef.current = false;
        setLoadingPrompt(false);
      }
    }
  };

  const clearAttachments = () => {
    for (const attachment of attachmentsRef.current)
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    attachmentsRef.current = [];
    onAttachmentsChange([]);
    setAttachmentErrors([]);
  };

  const addFiles = async (files: File[]) => {
    if (!files.length || disabled || preparingAttachments) return;
    const generation = ++attachmentGenerationRef.current;
    setPreparingAttachments(true);
    try {
      const prepared = await prepareComposerAttachments(
        files,
        attachmentsRef.current,
        maxAttachments,
      );
      if (generation !== attachmentGenerationRef.current) return;
      const next = prepared.accepted.map<DraftComposerAttachment>((attachment) => ({
        ...attachment,
        ...(attachment.mimeType.startsWith('image/')
          ? { previewUrl: URL.createObjectURL(attachment.file) }
          : {}),
      }));
      if (next.length) {
        const combined = [...attachmentsRef.current, ...next];
        attachmentsRef.current = combined;
        onAttachmentsChange(combined);
      }
      setAttachmentErrors(prepared.rejected);
    } finally {
      if (generation === attachmentGenerationRef.current) setPreparingAttachments(false);
    }
  };

  const removeAttachment = (id: string) => {
    const target = attachmentsRef.current.find((attachment) => attachment.id === id);
    if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
    const next = attachmentsRef.current.filter((attachment) => attachment.id !== id);
    attachmentsRef.current = next;
    onAttachmentsChange(next);
  };

  const send = () => {
    const value = text.trim();
    if (!value || disabled || loadingPrompt || preparingAttachments || panelOpen) return;
    const accepted = onSend(value, attachmentsRef.current, clearAttachments);
    if (accepted) setText('');
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (panelOpen && filtered.length) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActivePrompt((index) => movePromptSelection(index, 1, filtered.length));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActivePrompt((index) => movePromptSelection(index, -1, filtered.length));
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const target = filtered[activePrompt] ?? filtered[0];
        if (target) void applyPrompt(target.name);
        return;
      }
    }
    if (event.key === 'Escape' && panelOpen) {
      event.preventDefault();
      setPanelDismissed(true);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  return (
    <div
      className={cx('composer', draggingFiles && 'dragging-files')}
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes('Files')) setDraggingFiles(true);
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setDraggingFiles(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDraggingFiles(false);
        void addFiles(Array.from(event.dataTransfer.files));
      }}
    >
      {panelOpen && (
        <motion.div
          className="prompt-panel"
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: MOTION_EASE }}
        >
        <p className="prompt-panel-label">
          <span>提示词</span>
          {loadingPrompt && (
            <span className="prompt-panel-loading" role="status">
              <MotionSpinner>
                <CircleNotch size={12} />
              </MotionSpinner>
              正在读取…
            </span>
          )}
        </p>
        <div
          className="prompt-panel-list"
          id={promptListId}
          role="listbox"
          aria-label="提示词列表"
          aria-busy={loadingPrompt}
        >
          {filtered.map((prompt, index) => (
            <button
              type="button"
              role="option"
              id={`${promptListId}-option-${index}`}
              tabIndex={-1}
              aria-selected={index === activePrompt}
              disabled={loadingPrompt}
              key={prompt.name}
              className={cx('prompt-row', index === activePrompt && 'active')}
              onMouseEnter={() => setActivePrompt(index)}
              onClick={() => void applyPrompt(prompt.name)}
            >
              {index === activePrompt && (
                <motion.span
                  className="prompt-row-active"
                  layoutId={reducedMotion ? undefined : `prompt-row-active-${promptListId}`}
                  transition={MOTION_LAYOUT_TRANSITION}
                  aria-hidden="true"
                />
              )}
              <Terminal size={16} />
              <span className="prompt-row-copy">
                <span className="prompt-row-name">/{prompt.name}</span>
                {prompt.description && (
                  <span className="prompt-row-desc">{prompt.description}</span>
                )}
              </span>
            </button>
          ))}
          {!filtered.length && (
            <p className="prompt-panel-empty">没有匹配的提示词，按 Esc 关闭后可按原文发送</p>
          )}
        </div>
        {promptError && (
          <motion.p
            className="prompt-panel-error"
            role="alert"
            initial={{ opacity: 0, y: -3 }}
            animate={{ opacity: 1, y: 0 }}
            transition={MOTION_TRANSITION.feedback}
          >
            {promptError}，请重试。
          </motion.p>
        )}
        </motion.div>
      )}

      {attachments.length > 0 && (
        <div className="composer-attachments" aria-label="待发送附件">
          {attachments.map((attachment) => (
            <div className="composer-attachment" key={attachment.id}>
              {attachment.previewUrl ? (
                <img src={attachment.previewUrl} alt={`${attachment.originalName} 缩略图`} />
              ) : (
                <span className="composer-attachment-icon" aria-hidden="true">
                  {attachment.mimeType.startsWith('image/') ? (
                    <FileImage size={17} />
                  ) : (
                    <FileText size={17} />
                  )}
                </span>
              )}
              <span>
                <strong>{attachment.originalName}</strong>
                <small>{formatAttachmentBytes(attachment.size)} · 已就绪</small>
              </span>
              <button
                type="button"
                aria-label={`移除附件 ${attachment.originalName}`}
                disabled={disabled}
                onClick={() => removeAttachment(attachment.id)}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {attachmentErrors.length > 0 && (
        <motion.div
          className="composer-attachment-errors"
          role="status"
          aria-live="polite"
          initial={{ opacity: 0, y: -3 }}
          animate={{ opacity: 1, y: 0 }}
          transition={MOTION_TRANSITION.feedback}
        >
          {attachmentErrors.map((error, index) => (
            <span key={`${error.originalName}-${index}`}>
              {error.originalName}：{error.reason}
            </span>
          ))}
        </motion.div>
      )}

      <textarea
        ref={textareaRef}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setPanelDismissed(false);
          setPromptError('');
        }}
        onKeyDown={onKeyDown}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files);
          if (!files.length) return;
          event.preventDefault();
          void addFiles(files);
        }}
        placeholder="输入消息，@ 选择当前工作区上下文..."
        aria-label="消息输入框"
        role="combobox"
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-expanded={panelOpen}
        aria-controls={promptListId}
        aria-activedescendant={
          panelOpen && filtered.length ? `${promptListId}-option-${activePrompt}` : undefined
        }
        rows={1}
      />

      <div className="composer-toolbar">
        <div className="composer-toolbar-left">
          {/* 加号打开本地提示词列表。 */}
          <button
            type="button"
            className="composer-actions"
            aria-label="操作"
            onClick={() => {
              setText('/');
              setPanelDismissed(false);
              setPromptError('');
              textareaRef.current?.focus();
            }}
          >
            <Plus size={16} />
          </button>
          <button
            type="button"
            className="composer-actions"
            aria-label={preparingAttachments ? '正在读取附件' : '添加附件'}
            disabled={disabled || preparingAttachments || attachments.length >= maxAttachments}
            onClick={() => fileInputRef.current?.click()}
          >
            {preparingAttachments ? (
              <MotionSpinner>
                <CircleNotch size={16} />
              </MotionSpinner>
            ) : (
              <Paperclip size={16} />
            )}
          </button>
          <input
            ref={fileInputRef}
            hidden
            type="file"
            multiple
            accept="image/*,text/*,.json,.xml"
            disabled={disabled || preparingAttachments}
            onChange={(event) => {
              void addFiles(Array.from(event.target.files ?? []));
              event.target.value = '';
            }}
          />
          <div
            className="model-menu-wrap"
            ref={modelMenuRef}
            onBlur={(event) => {
              if (menuOpen && !event.currentTarget.contains(event.relatedTarget)) closeModelMenu();
            }}
          >
            <button
              ref={modelTriggerRef}
              type="button"
              className="model-button"
              onClick={() => setMenuOpen((open) => !open)}
              aria-haspopup="listbox"
              aria-expanded={menuOpen}
              aria-label="选择模型"
            >
              <Cpu size={16} />
              <span className="model-name">{modelLabel}</span>
              <CaretDown size={14} className="chevron" />
            </button>
            {menuOpen && (
              <ModelMenu
                models={models}
                selectedModel={selectedModel}
                onSelect={onSelectModel}
                onClose={closeModelMenu}
                onEscape={() => {
                  closeModelMenu();
                  modelTriggerRef.current?.focus();
                }}
              />
            )}
          </div>
        </div>
        <button
          type="button"
          className="send-button"
          onClick={send}
          disabled={!text.trim() || disabled || loadingPrompt || preparingAttachments || panelOpen}
          aria-label="发送消息"
        >
          <ArrowUp size={16} weight="bold" />
        </button>
      </div>
    </div>
  );
}
