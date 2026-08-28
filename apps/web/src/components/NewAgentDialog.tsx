import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CaretDown } from '@phosphor-icons/react/dist/icons/CaretDown';
import { CircleNotch } from '@phosphor-icons/react/dist/icons/CircleNotch';
import { X } from '@phosphor-icons/react/dist/icons/X';
import { createAgent } from '../lib/api.js';
import { blankAgentRequest } from '../lib/explore.js';
import { MOTION_EASE } from '../lib/motion.js';
import { useDialogFocus } from '../hooks/useDialogFocus.js';

const AGENT_ID = /^[a-z][a-z0-9-]{1,63}$/;

function suggestedId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 64);
}

export function NewAgentDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (agentId: string) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [id, setId] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dialogRef = useDialogFocus<HTMLFormElement>(open, onClose);

  useEffect(() => {
    if (!open) return;
    setName('');
    setDescription('');
    setId('');
    setAdvanced(false);
    setSaving(false);
    setError('');
  }, [open]);

  const derived = suggestedId(name);
  const effectiveId = id.trim() || derived;
  const valid = Boolean(name.trim()) && AGENT_ID.test(effectiveId);

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
      const created = await createAgent(blankAgentRequest(name, description, effectiveId));
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
            <label className="modal-field">
              <span>Waker 名称 *</span>
              <input
                value={name}
                autoFocus
                maxLength={80}
                placeholder="例如：支持工单分流"
                onChange={(event) => {
                  setName(event.target.value);
                  setError('');
                }}
                disabled={saving}
              />
            </label>
            <label className="modal-field">
              <span>描述</span>
              <textarea
                value={description}
                rows={3}
                maxLength={400}
                placeholder="说明它负责什么、如何工作。留空也可以稍后配置。"
                onChange={(event) => setDescription(event.target.value)}
                disabled={saving}
              />
            </label>
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
                创建
              </button>
            </div>
          </motion.form>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
