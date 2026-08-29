import { motion } from 'motion/react';
import type { SettingsResponse } from '@waker/contracts';
import { GearSix } from '@phosphor-icons/react/dist/icons/GearSix';
import type {
  AgentOutputLanguagePreference,
  ThemePreference,
  UiPreferences,
} from '../lib/preferences.js';
import { cx } from '../lib/cx.js';
import { MOTION_EASE } from '../lib/motion.js';

const THINKING_LABELS: Record<string, string> = {
  minimal: '极简',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最大',
  ultra: '极限',
};

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: 'auto', label: '自动' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];

const AGENT_OUTPUT_LANGUAGE_OPTIONS: Array<{
  value: AgentOutputLanguagePreference;
  label: string;
}> = [
  { value: '', label: '不指定' },
  { value: 'zh-CN', label: '中文' },
  { value: 'en-US', label: 'English' },
];

export type SettingsViewProps = {
  settings: SettingsResponse | null;
  loading: boolean;
  preferences: UiPreferences;
  onPreferenceChange: <K extends keyof UiPreferences>(key: K, value: UiPreferences[K]) => void;
};

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={cx('toggle', checked && 'active')}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-thumb" aria-hidden="true" />
    </button>
  );
}

function OptionGroup<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="settings-options" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value || 'unset'}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          className={cx('settings-option', value === option.value && 'active')}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** 设置页（§11.8 分组表单）：模型 / Thinking / 资源只读展示 + 本地界面偏好。 */
export function SettingsView({
  settings,
  loading,
  preferences,
  onPreferenceChange,
}: SettingsViewProps) {
  return (
    <div className="system-page">
      <div className="system-page-header">
        <div className="system-page-title">
          <GearSix size={20} aria-hidden="true" />
          <div>
            <h3>设置</h3>
            <p>当前运行配置与本地界面偏好；配置在 API 进程中管理，这里只读展示。</p>
          </div>
        </div>
      </div>

      {!settings ? (
        <p className="system-page-loading">{loading ? '正在读取…' : '设置信息暂时无法读取'}</p>
      ) : (
        <motion.div
          className="settings-groups"
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: MOTION_EASE }}
        >
          <section className="settings-card">
            <h4>模型</h4>
            <dl className="settings-rows">
              <div className="settings-row">
                <dt>Provider</dt>
                <dd>{settings.model.provider ?? '未配置'}</dd>
              </div>
              <div className="settings-row">
                <dt>当前模型</dt>
                <dd>{settings.model.model ?? '未配置'}</dd>
              </div>
              <div className="settings-row">
                <dt>可用模型</dt>
                <dd>
                  <span className="settings-model-list">
                    {settings.model.available.length
                      ? settings.model.available.map((model) => (
                          <span className="settings-model-chip" key={model.id}>
                            {model.name}
                          </span>
                        ))
                      : '无'}
                  </span>
                </dd>
              </div>
            </dl>
          </section>

          <section className="settings-card">
            <h4>Thinking</h4>
            <dl className="settings-rows">
              <div className="settings-row">
                <dt>默认级别</dt>
                <dd>
                  {THINKING_LABELS[settings.thinkingLevel] ?? settings.thinkingLevel}
                  <span className="settings-row-hint">
                    {settings.thinkingLevel} · 来自 CODEX_REASONING_EFFORT，配置面板可按 Agent 覆盖
                  </span>
                </dd>
              </div>
            </dl>
          </section>

          <section className="settings-card">
            <h4>资源</h4>
            <dl className="settings-rows">
              <div className="settings-row">
                <dt>.codex/agents</dt>
                <dd>{settings.resources.agents} 个 Agent</dd>
              </div>
              <div className="settings-row">
                <dt>.codex/prompts</dt>
                <dd>{settings.resources.prompts} 个提示词模板</dd>
              </div>
              <div className="settings-row">
                <dt>.codex/skills</dt>
                <dd>{settings.resources.skills} 个技能</dd>
              </div>
              <div className="settings-row">
                <dt>APPEND_SYSTEM.md</dt>
                <dd>{settings.resources.appendSystem ? '已启用' : '未配置'}</dd>
              </div>
              <div className="settings-row">
                <dt>会话存储</dt>
                <dd>
                  <code>{settings.workspace.sessionDir}</code>
                </dd>
              </div>
            </dl>
          </section>

          <section className="settings-card">
            <h4>权限与沙箱</h4>
            <dl className="settings-rows">
              <div className="settings-row">
                <dt>Codex 运行时</dt>
                <dd>{settings.security.codexEnabled ? '已启用' : '未启用'}</dd>
              </div>
              <div className="settings-row">
                <dt>文件系统沙箱</dt>
                <dd>
                  <code>{settings.security.sandboxMode}</code>
                </dd>
              </div>
              <div className="settings-row">
                <dt>审批策略</dt>
                <dd>
                  <code>{settings.security.approvalPolicy}</code>
                  <span className="settings-row-hint">
                    由 API 宿主管理；Waker 定义和浏览器不能扩大权限
                  </span>
                </dd>
              </div>
            </dl>
          </section>

          <section className="settings-card">
            <h4>界面偏好</h4>
            <dl className="settings-rows">
              <div className="settings-row">
                <dt>主题亮暗</dt>
                <dd className="settings-row-toggle">
                  <span className="settings-row-hint">自动跟随系统亮暗，立即生效</span>
                  <OptionGroup
                    label="主题亮暗"
                    value={preferences.theme}
                    options={THEME_OPTIONS}
                    onChange={(value) => onPreferenceChange('theme', value)}
                  />
                </dd>
              </div>
              <div className="settings-row">
                <dt>AI 回复语言</dt>
                <dd className="settings-row-toggle">
                  <span className="settings-row-hint">设置新会话中 AI 默认使用的回复语言</span>
                  <OptionGroup
                    label="AI 回复语言"
                    value={preferences.agentOutputLanguage}
                    options={AGENT_OUTPUT_LANGUAGE_OPTIONS}
                    onChange={(value) => onPreferenceChange('agentOutputLanguage', value)}
                  />
                </dd>
              </div>
              <div className="settings-row">
                <dt>消息紧凑模式</dt>
                <dd className="settings-row-toggle">
                  <span className="settings-row-hint">缩小会话消息的纵向间距，立即生效</span>
                  <Toggle
                    label="消息紧凑模式"
                    checked={preferences.compactMessages}
                    onChange={(value) => onPreferenceChange('compactMessages', value)}
                  />
                </dd>
              </div>
            </dl>
          </section>
        </motion.div>
      )}
    </div>
  );
}
