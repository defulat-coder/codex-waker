import { defaultStorage, type StorageLike } from './storage.js';

/** 主题档位：auto 跟随系统 prefers-color-scheme，light/dark 手动锁定。 */
export type ThemePreference = 'auto' | 'light' | 'dark';
/** AI 回复语言：注入新会话首 turn 的 developer-instructions。 */
export type AgentOutputLanguage = 'zh-CN' | 'en-US';
/** 空串表示「不指定」，不注入输出语言指令（保持现有行为）。 */
export type AgentOutputLanguagePreference = AgentOutputLanguage | '';

const THEME_VALUES: readonly ThemePreference[] = ['auto', 'light', 'dark'];
const AGENT_OUTPUT_LANGUAGE_VALUES: readonly AgentOutputLanguage[] = ['zh-CN', 'en-US'];

/** 界面偏好：真实生效的本地设置，持久化在 localStorage。 */
export interface UiPreferences {
  /** 消息紧凑模式：缩小会话消息的纵向间距，立即生效。 */
  compactMessages: boolean;
  /** 侧边栏默认收起：刷新页面后生效。 */
  sidebarCollapsed: boolean;
  /** 主题亮暗：立即生效，auto 时跟随系统。 */
  theme: ThemePreference;
  /** AI 回复语言：只影响新建会话。 */
  agentOutputLanguage: AgentOutputLanguagePreference;
}

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  compactMessages: false,
  sidebarCollapsed: false,
  theme: 'auto',
  agentOutputLanguage: '',
};

const PREFERENCE_KEYS: Record<keyof UiPreferences, string> = {
  compactMessages: 'waker.pref.compact-messages',
  sidebarCollapsed: 'waker.pref.sidebar-collapsed',
  theme: 'waker.pref.theme',
  agentOutputLanguage: 'waker.pref.agent-output-language',
};

/** Parses one persisted raw value; unknown or missing values fall back to the default. */
function parsePreference<K extends keyof UiPreferences>(
  key: K,
  raw: string | null,
): UiPreferences[K] {
  const fallback = DEFAULT_UI_PREFERENCES[key];
  if (typeof fallback === 'boolean') return (raw === '1') as UiPreferences[K];
  if (key === 'theme')
    return (
      THEME_VALUES.includes(raw as ThemePreference) ? raw : fallback
    ) as UiPreferences[K];
  return (AGENT_OUTPUT_LANGUAGE_VALUES.includes(raw as AgentOutputLanguage)
    ? raw
    : fallback) as UiPreferences[K];
}

function serializePreference(value: UiPreferences[keyof UiPreferences]): string {
  return typeof value === 'boolean' ? (value ? '1' : '0') : value;
}

/** Reads all UI preferences; unknown or missing values fall back to the defaults. */
export function readUiPreferences(
  storage: StorageLike | undefined = defaultStorage(),
): UiPreferences {
  const read = <K extends keyof UiPreferences>(key: K): UiPreferences[K] => {
    try {
      return parsePreference(key, storage?.getItem(PREFERENCE_KEYS[key]) ?? null);
    } catch {
      return DEFAULT_UI_PREFERENCES[key];
    }
  };
  return {
    compactMessages: read('compactMessages'),
    sidebarCollapsed: read('sidebarCollapsed'),
    theme: read('theme'),
    agentOutputLanguage: read('agentOutputLanguage'),
  };
}

/** Persists one preference; storage failures are non-fatal. Returns the next preference set. */
export function writeUiPreference<K extends keyof UiPreferences>(
  current: UiPreferences,
  key: K,
  value: UiPreferences[K],
  storage: StorageLike | undefined = defaultStorage(),
): UiPreferences {
  try {
    storage?.setItem(PREFERENCE_KEYS[key], serializePreference(value));
  } catch {
    // 隐私模式 / 配额满时静默降级，偏好只在内存中生效。
  }
  return { ...current, [key]: value };
}

/** Server-side key (SQLite preferences table) for one UI preference. */
const SERVER_KEYS: Record<keyof UiPreferences, string> = {
  compactMessages: 'ui.compact-messages',
  sidebarCollapsed: 'ui.sidebar-collapsed',
  theme: 'ui.theme',
  agentOutputLanguage: 'ui.agent-output-language',
};

export function serverKeyForPreference(key: keyof UiPreferences): string {
  return SERVER_KEYS[key];
}

/** Validates one server-persisted value against the preference's value domain. */
function isValidServerValue<K extends keyof UiPreferences>(
  key: K,
  value: unknown,
): value is UiPreferences[K] {
  const fallback = DEFAULT_UI_PREFERENCES[key];
  if (typeof fallback === 'boolean') return typeof value === 'boolean';
  if (key === 'theme') return THEME_VALUES.includes(value as ThemePreference);
  return AGENT_OUTPUT_LANGUAGE_VALUES.includes(value as AgentOutputLanguage);
}

/** Merges server-persisted UI preferences into the local cache; server values win. */
export function mergeServerUiPreferences(
  items: Record<string, unknown>,
  storage: StorageLike | undefined = defaultStorage(),
): UiPreferences {
  const next = readUiPreferences(storage);
  for (const key of Object.keys(SERVER_KEYS) as Array<keyof UiPreferences>) {
    const value = items[SERVER_KEYS[key]];
    if (!isValidServerValue(key, value)) continue;
    // 联合 key 下 TS 无法把 value 收窄到 next[K]，这里按 Record 写入。
    (next as Record<keyof UiPreferences, unknown>)[key] = value;
    try {
      storage?.setItem(PREFERENCE_KEYS[key], serializePreference(value));
    } catch {
      // 本地缓存失败不影响内存中的合并结果。
    }
  }
  return next;
}
