import { useEffect, useState, type ReactNode } from 'react';
import type {
  AgentDetail,
  AgentResources,
  UpdateAgentRequest,
  WorkspaceResponse,
} from '@waker/contracts';
import { AGENT_THINKING_LEVELS } from '@waker/contracts';
import { AnimatePresence, motion } from 'motion/react';
import { X } from '@phosphor-icons/react/dist/icons/X';
import { CaretDown } from '@phosphor-icons/react/dist/icons/CaretDown';
import { Info } from '@phosphor-icons/react/dist/icons/Info';
import { FolderOpen } from '@phosphor-icons/react/dist/icons/FolderOpen';
import { GearSix } from '@phosphor-icons/react/dist/icons/GearSix';
import { PencilSimple } from '@phosphor-icons/react/dist/icons/PencilSimple';
import { Plus } from '@phosphor-icons/react/dist/icons/Plus';
import { CircleNotch } from '@phosphor-icons/react/dist/icons/CircleNotch';
import {
  fetchAgent,
  fetchAgentResources,
  fetchAppendSystem,
  fetchPrompt,
  savePreference,
  updateAgent,
  updateAppendSystem,
  updatePrompt,
} from '../lib/api.js';
import { useAsyncData } from '../hooks/useAsyncData.js';
import {
  DEFAULT_OPEN_SECTIONS,
  readModelPreference,
  readThinkingPreference,
  serverKeyForModel,
  serverKeyForThinking,
  THINKING_PREFERENCE_OPTIONS,
  toggleSection,
  writeModelPreference,
  writeThinkingPreference,
  type ConfigSectionId,
  type ThinkingPreference,
} from '../lib/configPanel.js';
import { cx } from '../lib/cx.js';
import { MOTION_EASE } from '../lib/motion.js';
import { useWorkspace } from '../context/WorkspaceContext.js';
import { AgentChip } from './AgentChip.js';
import { AgentBodySections } from './AgentBodySections.js';

/** 旧实现 configure 面板的通栏折叠节：48px 头 + 高度动画内容区。 */
function ConfigSection({
  icon,
  title,
  open,
  onToggle,
  children,
}: {
  icon: ReactNode;
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="config-section">
      <button
        type="button"
        className="config-section-header"
        onClick={onToggle}
        aria-expanded={open}
      >
        {icon}
        <span className="config-section-title">{title}</span>
        <CaretDown size={16} className={cx('config-section-chevron', open && 'open')} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            className="config-section-content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: MOTION_EASE }}
          >
            <div className="config-section-inner">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

function BasicSection({
  agent,
  saving,
  onUseSuggestion,
  onStartFullEdit,
  onSaveBody,
}: {
  agent: AgentDetail;
  saving: boolean;
  onUseSuggestion: (text: string) => void;
  onStartFullEdit: () => void;
  onSaveBody: (nextBody: string) => Promise<boolean>;
}) {
  return (
    <>
      <AgentBodySections
        body={agent.body}
        saving={saving}
        onSaveBody={onSaveBody}
        onStartFullEdit={onStartFullEdit}
        identityHeader={
          <>
            <div className="config-identity">
              <AgentChip
                mark={agent.mark}
                className="medium"
                agentId={agent.id}
                hasAvatar={agent.hasAvatar ?? Boolean(agent.avatar)}
              />
              <span>
                <strong>{agent.name}</strong>
                <small>{agent.tagline}</small>
              </span>
            </div>
            <div className="config-edit-actions">
              <button
                type="button"
                className="header-button"
                onClick={onStartFullEdit}
                disabled={saving}
              >
                <PencilSimple size={13} />
                修改基本信息
              </button>
            </div>
          </>
        }
      />
      {agent.description && (
        <div className="config-card">
          <p>{agent.description}</p>
        </div>
      )}
      {agent.suggestions.length > 0 && (
        <div className="config-card">
          <p className="config-card-title">建议问题</p>
          {agent.suggestions.map((suggestion) => (
            <button
              type="button"
              key={suggestion}
              className="config-suggestion"
              onClick={() => onUseSuggestion(suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}
      <div className="config-card">
        <p className="config-card-title">定义文件</p>
        <span className="config-path">{agent.path}</span>
      </div>
    </>
  );
}

/** 旧实现「Agent files」Source 编辑的本地对应：frontmatter 字段 input + suggestions 增删列表 + body 大 textarea。 */
function EditSection({
  draft,
  saving,
  onChange,
  onSave,
  onCancel,
}: {
  draft: Required<UpdateAgentRequest>;
  saving: boolean;
  onChange: (patch: Partial<UpdateAgentRequest>) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const suggestions = draft.suggestions ?? [];
  const invalid =
    !draft.name?.trim() ||
    !draft.mark?.trim() ||
    !draft.tagline?.trim() ||
    !draft.description?.trim() ||
    !draft.body?.trim() ||
    suggestions.length === 0 ||
    suggestions.some((item) => !item.trim());
  return (
    <motion.div
      className="config-edit"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15, ease: MOTION_EASE }}
    >
      <label className="config-edit-field">
        <span>名称</span>
        <input
          value={draft.name ?? ''}
          maxLength={80}
          onChange={(event) => onChange({ name: event.target.value })}
          disabled={saving}
        />
      </label>
      <label className="config-edit-field">
        <span>徽标字符</span>
        <input
          value={draft.mark ?? ''}
          maxLength={8}
          onChange={(event) => onChange({ mark: event.target.value })}
          disabled={saving}
        />
      </label>
      <label className="config-edit-field">
        <span>一句话简介</span>
        <input
          value={draft.tagline ?? ''}
          maxLength={120}
          onChange={(event) => onChange({ tagline: event.target.value })}
          disabled={saving}
        />
      </label>
      <label className="config-edit-field">
        <span>描述</span>
        <input
          value={draft.description ?? ''}
          maxLength={400}
          onChange={(event) => onChange({ description: event.target.value })}
          disabled={saving}
        />
      </label>
      <div className="config-edit-field">
        <span>建议问题</span>
        {suggestions.map((suggestion, index) => (
          <div className="config-edit-suggestion" key={index}>
            <input
              value={suggestion}
              maxLength={200}
              aria-label={`建议问题 ${index + 1}`}
              onChange={(event) =>
                onChange({
                  suggestions: suggestions.map((item, at) =>
                    at === index ? event.target.value : item,
                  ),
                })
              }
              disabled={saving}
            />
            <button
              type="button"
              className="icon-button"
              aria-label={`删除建议问题 ${index + 1}`}
              onClick={() => onChange({ suggestions: suggestions.filter((_, at) => at !== index) })}
              disabled={saving || suggestions.length <= 1}
            >
              <X size={14} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="config-edit-add"
          onClick={() => onChange({ suggestions: [...suggestions, ''] })}
          disabled={saving || suggestions.length >= 8}
        >
          <Plus size={14} />
          添加建议问题
        </button>
      </div>
      <label className="config-edit-field">
        <span>系统提示词</span>
        <textarea
          value={draft.body ?? ''}
          rows={12}
          onChange={(event) => onChange({ body: event.target.value })}
          disabled={saving}
        />
      </label>
      <div className="config-edit-actions">
        <button type="button" className="header-button" onClick={onCancel} disabled={saving}>
          取消
        </button>
        <button
          type="button"
          className="header-button primary"
          onClick={onSave}
          disabled={saving || invalid}
        >
          {saving ? <CircleNotch size={13} className="spinning" /> : null}
          保存
        </button>
      </div>
    </motion.div>
  );
}

/** 资源区行内编辑：提示词模板与 APPEND_SYSTEM.md 的就地编辑态，保存后由 onChanged 重拉清单。 */
function ResourcesSection({
  resources,
  notify,
  onChanged,
}: {
  resources: AgentResources | null;
  notify: (text: string) => void;
  onChanged: () => void;
}) {
  /** 非 null 即该模板的编辑态；content 来自 fetchPrompt 全文，保存前不回读。 */
  const [promptDraft, setPromptDraft] = useState<{
    name: string;
    content: string;
    description: string;
  } | null>(null);
  const [promptSaving, setPromptSaving] = useState(false);
  /** 非 null 即 APPEND_SYSTEM.md 的编辑态。 */
  const [appendDraft, setAppendDraft] = useState<string | null>(null);
  const [appendSaving, setAppendSaving] = useState(false);

  const startPromptEdit = async (name: string) => {
    try {
      const document = await fetchPrompt(name);
      setPromptDraft({ name, content: document.content, description: document.description ?? '' });
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '提示词暂时无法读取');
    }
  };

  const savePromptEdit = async () => {
    if (!promptDraft || promptSaving) return;
    const content = promptDraft.content.trim();
    const description = promptDraft.description.trim();
    if (!content) return;
    setPromptSaving(true);
    try {
      await updatePrompt(promptDraft.name, { content, ...(description ? { description } : {}) });
      setPromptDraft(null);
      notify('提示词模板已保存');
      onChanged();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '提示词暂时无法保存');
    } finally {
      setPromptSaving(false);
    }
  };

  const startAppendEdit = async () => {
    try {
      const { content } = await fetchAppendSystem();
      setAppendDraft(content ?? '');
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '追加系统提示暂时无法读取');
    }
  };

  const saveAppendEdit = async () => {
    if (appendDraft === null || appendSaving) return;
    setAppendSaving(true);
    try {
      const { content } = await updateAppendSystem(appendDraft);
      setAppendDraft(null);
      notify(content ? '追加系统提示已保存' : '已移除 .codex/APPEND_SYSTEM.md');
      onChanged();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '追加系统提示暂时无法保存');
    } finally {
      setAppendSaving(false);
    }
  };

  if (!resources) return <p className="config-section-note">正在读取资源清单…</p>;
  return (
    <>
      <div className="config-card">
        <p className="config-card-title">提示词模板 · {resources.prompts.length}</p>
        {resources.prompts.length === 0 && <p>暂无提示词模板。</p>}
        {resources.prompts.map((prompt) =>
          promptDraft?.name === prompt.name ? (
            <motion.div
              className="config-edit"
              key={prompt.path}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.15, ease: MOTION_EASE }}
            >
              <label className="config-edit-field">
                <span>描述</span>
                <input
                  value={promptDraft.description}
                  maxLength={200}
                  onChange={(event) =>
                    setPromptDraft((prev) =>
                      prev ? { ...prev, description: event.target.value } : prev,
                    )
                  }
                  disabled={promptSaving}
                />
              </label>
              <label className="config-edit-field">
                <span>正文</span>
                <textarea
                  value={promptDraft.content}
                  rows={8}
                  onChange={(event) =>
                    setPromptDraft((prev) =>
                      prev ? { ...prev, content: event.target.value } : prev,
                    )
                  }
                  disabled={promptSaving}
                />
              </label>
              <div className="config-edit-actions">
                <button
                  type="button"
                  className="header-button"
                  onClick={() => setPromptDraft(null)}
                  disabled={promptSaving}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="header-button primary"
                  onClick={() => void savePromptEdit()}
                  disabled={promptSaving || !promptDraft.content.trim()}
                >
                  {promptSaving ? <CircleNotch size={13} className="spinning" /> : null}
                  保存
                </button>
              </div>
            </motion.div>
          ) : (
            <div className="config-resource-row" key={prompt.path}>
              <span className="config-path">{prompt.path}</span>
              {prompt.description && <small>{prompt.description}</small>}
              <button
                type="button"
                className="icon-button"
                aria-label={`编辑提示词 ${prompt.name}`}
                onClick={() => void startPromptEdit(prompt.name)}
                disabled={promptDraft !== null}
              >
                <PencilSimple size={13} />
              </button>
            </div>
          ),
        )}
      </div>
      <div className="config-card">
        <p className="config-card-title">技能 · {resources.skills.length}</p>
        {resources.skills.length === 0 && <p>暂无项目技能。</p>}
        {resources.skills.map((skill) => (
          <div className="config-resource-row" key={skill.path}>
            <span className="config-resource-name">{skill.name}</span>
            {skill.description && <small>{skill.description}</small>}
          </div>
        ))}
      </div>
      <div className="config-card">
        <p className="config-card-title">追加系统提示</p>
        {appendDraft === null ? (
          <>
            <p>
              {resources.appendSystem
                ? '已启用：.codex/APPEND_SYSTEM.md 会追加到每个 Agent 的上下文。'
                : '未配置 .codex/APPEND_SYSTEM.md。'}
            </p>
            <div className="config-edit-actions">
              <button
                type="button"
                className="header-button"
                onClick={() => void startAppendEdit()}
              >
                <PencilSimple size={13} />
                编辑
              </button>
            </div>
          </>
        ) : (
          <motion.div
            className="config-edit"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.15, ease: MOTION_EASE }}
          >
            <label className="config-edit-field">
              <span>.codex/APPEND_SYSTEM.md</span>
              <textarea
                value={appendDraft}
                rows={8}
                onChange={(event) => setAppendDraft(event.target.value)}
                disabled={appendSaving}
              />
            </label>
            <p className="config-card-desc">
              内容会追加到每个 Agent 的上下文；清空后保存将移除该文件。
            </p>
            <div className="config-edit-actions">
              <button
                type="button"
                className="header-button"
                onClick={() => setAppendDraft(null)}
                disabled={appendSaving}
              >
                取消
              </button>
              <button
                type="button"
                className="header-button primary"
                onClick={() => void saveAppendEdit()}
                disabled={appendSaving}
              >
                {appendSaving ? <CircleNotch size={13} className="spinning" /> : null}
                保存
              </button>
            </div>
          </motion.div>
        )}
      </div>
      <p className="config-section-note">以上均为项目本地资源，该 Agent 无外部连接。</p>
    </>
  );
}

function RuntimeSection({
  models,
  resources,
  thinking,
  onThinkingChange,
  model,
  onModelChange,
}: {
  models: WorkspaceResponse['models'];
  resources: AgentResources | null;
  thinking: ThinkingPreference;
  onThinkingChange: (level: ThinkingPreference) => void;
  /** 该 Agent 的默认模型偏好；undefined 表示跟随全局默认。 */
  model: string | undefined;
  onModelChange: (model: string | undefined) => void;
}) {
  return (
    <>
      <div className="config-card">
        <p className="config-card-title">模型</p>
        <div className="config-kv">
          <span>当前模型</span>
          <strong>
            {[models.current.provider, models.current.model].filter(Boolean).join(' / ') ||
              '未配置'}
          </strong>
        </div>
        <div className="config-kv">
          <span>可用模型</span>
          <strong>{models.available.length} 个</strong>
        </div>
        <div className="config-kv">
          <span>Thinking 级别</span>
          <strong>默认跟随服务端 · 可选 {AGENT_THINKING_LEVELS.join(' / ')}</strong>
        </div>
      </div>
      <div className="config-card">
        <div className="config-kv">
          <span>会话数</span>
          <strong>{resources ? resources.stats.sessionCount : '…'}</strong>
        </div>
        <div className="config-kv">
          <span>累计提问</span>
          <strong>{resources ? resources.stats.questionCount : '…'}</strong>
        </div>
      </div>
      <div className="config-card">
        <p className="config-card-title">新会话默认模型</p>
        <p className="config-card-desc">
          作为该 Agent 发起新提问时的默认模型，仅保存在本机；输入框里手动选择的模型优先。
        </p>
        <select
          className="config-select"
          aria-label="新会话默认模型"
          value={model ?? ''}
          onChange={(event) => onModelChange(event.target.value || undefined)}
        >
          <option value="">
            跟随全局默认{models.current.model ? `（${models.current.model}）` : ''}
          </option>
          {models.available.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </div>
      <div className="config-card">
        <p className="config-card-title">新会话默认 Thinking</p>
        <p className="config-card-desc">
          作为该 Agent 发起新提问时的默认 thinking
          参数，仅保存在本机；不设置时跟随服务端默认级别（设置页可见）。
        </p>
        <select
          className="config-select"
          aria-label="新会话默认 Thinking"
          value={thinking ?? ''}
          onChange={(event) =>
            onThinkingChange((event.target.value || undefined) as ThinkingPreference)
          }
        >
          <option value="">跟随服务端默认</option>
          {THINKING_PREFERENCE_OPTIONS.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}

/** 右侧 479px 配置面板（aside，内嵌非遮罩），分节折叠对齐 旧实现 configure 结构。 */
export function ConfigPanel({
  agentId,
  onClose,
  onUseSuggestion,
}: {
  agentId: string;
  onClose: () => void;
  onUseSuggestion: (text: string) => void;
}) {
  const { workspace, notify, reloadWorkspace } = useWorkspace();
  const models = workspace.models;
  const detail = useAsyncData(() => fetchAgent(agentId), {
    onError: (cause) => setError(cause.message),
  });
  const resources = useAsyncData(() => fetchAgentResources(agentId));
  const [error, setError] = useState('');
  const [openSections, setOpenSections] = useState<ConfigSectionId[]>([...DEFAULT_OPEN_SECTIONS]);
  const [thinking, setThinking] = useState<ThinkingPreference>(() =>
    readThinkingPreference(agentId),
  );
  const [model, setModel] = useState<string | undefined>(() => readModelPreference(agentId));
  /** 非 null 即编辑态；字段来自 detail 快照，保存前不回读。 */
  const [draft, setDraft] = useState<Required<UpdateAgentRequest> | null>(null);
  const [saving, setSaving] = useState(false);

  const { reload: reloadDetail, setData: setDetailData } = detail;
  const { reload: reloadResources, setData: setResourcesData } = resources;

  useEffect(() => {
    setError('');
    setOpenSections([...DEFAULT_OPEN_SECTIONS]);
    setThinking(readThinkingPreference(agentId));
    setModel(readModelPreference(agentId));
    setDraft(null);
    setSaving(false);
    setDetailData(null);
    setResourcesData(null);
    void reloadDetail();
    void reloadResources();
    // reload/setData 身份稳定，只需跟随 agentId 重拉。
  }, [agentId, reloadDetail, setDetailData, reloadResources, setResourcesData]);

  const changeThinking = (level: ThinkingPreference) => {
    setThinking(level);
    writeThinkingPreference(agentId, level);
    // 空串语义：服务端把它当作删除该偏好（跟随服务端默认）。
    void savePreference(serverKeyForThinking(agentId), level ?? '').catch(() => {
      // 服务端写穿失败时 localStorage 仍是权威缓存。
    });
  };

  const changeModel = (next: string | undefined) => {
    setModel(next);
    writeModelPreference(agentId, next);
    // 空串语义：服务端把它当作删除该偏好（跟随全局默认）。
    void savePreference(serverKeyForModel(agentId), next ?? '').catch(() => {
      // 服务端写穿失败时 localStorage 仍是权威缓存。
    });
  };

  const startEdit = () => {
    if (!detail.data) return;
    const { name, mark, tagline, description, suggestions, body } = detail.data;
    setDraft({ name, mark, tagline, description, suggestions: [...suggestions], body });
  };

  const saveEdit = async () => {
    if (!draft || saving) return;
    setSaving(true);
    try {
      await updateAgent(agentId, draft);
      setDraft(null);
      notify('Agent 定义已保存');
      void reloadDetail();
      reloadWorkspace();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Agent 暂时无法保存');
    } finally {
      setSaving(false);
    }
  };

  /** 分段编辑保存：只 PATCH 拼回后的 body，frontmatter 字段不动；成功返回 true 让调用方退出编辑态。 */
  const saveBody = async (body: string): Promise<boolean> => {
    if (saving) return false;
    setSaving(true);
    try {
      await updateAgent(agentId, { body });
      notify('Agent 定义已保存');
      void reloadDetail();
      reloadWorkspace();
      return true;
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Agent 暂时无法保存');
      return false;
    } finally {
      setSaving(false);
    }
  };

  return (
    <motion.aside
      role="complementary"
      aria-label="Agent 配置"
      className="config-panel"
      initial={{ width: 0 }}
      animate={{ width: 479 }}
      exit={{ width: 0 }}
      transition={{ duration: 0.2, ease: MOTION_EASE }}
    >
      <div className="config-panel-frame">
        <div className="config-panel-header">
          <span className="config-title">{detail.data ? detail.data.name : 'Agent 配置'}</span>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="关闭配置面板"
            disabled={saving}
          >
            <X size={16} />
          </button>
        </div>
        {error && (
          <p className="config-panel-error" role="alert">
            {error}
          </p>
        )}
        {!error && !detail.data && <p className="config-panel-loading">正在读取配置…</p>}
        {!error && detail.data && (
          <div className="config-panel-body">
            <ConfigSection
              icon={<Info size={16} />}
              title="基本信息"
              open={openSections.includes('basic')}
              onToggle={() => setOpenSections((prev) => toggleSection(prev, 'basic'))}
            >
              {draft ? (
                <EditSection
                  draft={draft}
                  saving={saving}
                  onChange={(patch) => setDraft((prev) => (prev ? { ...prev, ...patch } : prev))}
                  onSave={() => void saveEdit()}
                  onCancel={() => setDraft(null)}
                />
              ) : (
                <BasicSection
                  agent={detail.data}
                  saving={saving}
                  onUseSuggestion={onUseSuggestion}
                  onStartFullEdit={startEdit}
                  onSaveBody={saveBody}
                />
              )}
            </ConfigSection>
            <ConfigSection
              icon={<FolderOpen size={16} />}
              title="资源"
              open={openSections.includes('resources')}
              onToggle={() => setOpenSections((prev) => toggleSection(prev, 'resources'))}
            >
              <ResourcesSection
                resources={resources.data}
                notify={notify}
                onChanged={() => {
                  void reloadResources();
                  reloadWorkspace();
                }}
              />
            </ConfigSection>
            <ConfigSection
              icon={<GearSix size={16} />}
              title="运行设置"
              open={openSections.includes('runtime')}
              onToggle={() => setOpenSections((prev) => toggleSection(prev, 'runtime'))}
            >
              <RuntimeSection
                models={models}
                resources={resources.data}
                thinking={thinking}
                onThinkingChange={changeThinking}
                model={model}
                onModelChange={changeModel}
              />
            </ConfigSection>
          </div>
        )}
      </div>
    </motion.aside>
  );
}
