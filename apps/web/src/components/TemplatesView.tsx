import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CircleNotch } from '@phosphor-icons/react/dist/icons/CircleNotch';
import { X } from '@phosphor-icons/react/dist/icons/X';
import { createAgent, fetchAgentTemplates } from '../lib/api.js';
import { templateToCreateRequest, type AgentTemplate } from '../lib/explore.js';
import { useAsyncData } from '../hooks/useAsyncData.js';
import { MOTION_EASE } from '../lib/motion.js';
import { AgentChip } from './AgentChip.js';

export type TemplatesViewProps = {
  /** 创建成功后调用：刷新工作区并跳到 Agents 列表。 */
  onCreated: (agentId: string) => void;
};

/** Templates 页（§11.4）：后端内置模板卡片 + 「使用模板」在 .codex/agents/ 创建真实 agent 文件。 */
export function TemplatesView({ onCreated }: TemplatesViewProps) {
  const templates = useAsyncData(fetchAgentTemplates, {
    onError: (cause) => setLoadError(cause.message),
  });
  const [loadError, setLoadError] = useState('');
  const [draft, setDraft] = useState<{ template: AgentTemplate; id: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const { reload: reloadTemplates } = templates;
  useEffect(() => {
    void reloadTemplates();
  }, [reloadTemplates]);

  const submit = async () => {
    if (!draft || busy) return;
    setBusy(true);
    setError('');
    try {
      const created = await createAgent(templateToCreateRequest(draft.template, draft.id));
      setDraft(null);
      onCreated(created.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Agent 暂时无法创建');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="explore">
      <header className="explore-header">
        <h1>Templates</h1>
        <p>从内置模板创建一个新的工作区 Agent（写入 .codex/agents/）。</p>
      </header>

      {templates.data === null && (
        <p className="system-page-loading">{loadError || '正在加载模板…'}</p>
      )}
      <div className="explore-grid" role="list">
        {(templates.data ?? []).map((template, index) => (
          <motion.div
            role="listitem"
            key={template.id}
            className="agent-card template-card"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, ease: MOTION_EASE, delay: index * 0.04 }}
          >
            <span className="agent-card-head">
              <AgentChip mark={template.mark} className="medium" />
              <span className="agent-card-title">
                <strong>{template.name}</strong>
                <small>{template.tagline}</small>
              </span>
            </span>
            <span className="agent-card-desc">{template.description}</span>
            <span className="agent-card-footer">
              <span className="agent-card-stats">{template.suggestions.length} 个建议问题</span>
              <button
                type="button"
                className="header-button primary"
                onClick={() => {
                  setError('');
                  setDraft({ template, id: template.id });
                }}
              >
                使用模板
              </button>
            </span>
          </motion.div>
        ))}
      </div>

      <AnimatePresence>
        {draft && (
          <motion.div
            className="modal-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={() => {
              if (!busy) setDraft(null);
            }}
          >
            <motion.div
              className="modal-card"
              role="dialog"
              aria-modal="true"
              aria-label={`使用模板 ${draft.template.name}`}
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              transition={{ duration: 0.2, ease: MOTION_EASE }}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="modal-head">
                <strong>使用模板：{draft.template.name}</strong>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="关闭"
                  onClick={() => setDraft(null)}
                  disabled={busy}
                >
                  <X size={14} />
                </button>
              </div>
              <p className="modal-hint">
                将在 .codex/agents/ 下创建 <code>{draft.id || '<id>'}.md</code>。id
                仅限小写字母、数字和连字符。
              </p>
              <label className="modal-field">
                <span>Agent id</span>
                <input
                  value={draft.id}
                  autoFocus
                  onChange={(event) => setDraft({ ...draft, id: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void submit();
                  }}
                  placeholder="例如 translator-pro"
                  aria-label="Agent id"
                />
              </label>
              {error && (
                <p className="modal-error" role="alert">
                  {error}
                </p>
              )}
              <div className="modal-actions">
                <button
                  type="button"
                  className="header-button"
                  onClick={() => setDraft(null)}
                  disabled={busy}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="header-button primary"
                  onClick={() => void submit()}
                  disabled={busy || !draft.id.trim()}
                >
                  {busy ? <CircleNotch size={13} className="spinning" /> : null}
                  创建 Agent
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
