import { defaultStorage, type StorageLike } from './storage.js';

/** 界面偏好：真实生效的本地设置，持久化在 localStorage。 */
export interface UiPreferences {
  /** 消息紧凑模式：缩小会话消息的纵向间距，立即生效。 */
  compactMessages: boolean;
  /** 侧边栏默认收起：刷新页面后生效。 */
  sidebarCollapsed: boolean;
}

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  compactMessages: false,
  sidebarCollapsed: false,
};

const PREFERENCE_KEYS: Record<keyof UiPreferences, string> = {
  compactMessages: 'waker.pref.compact-messages',
  sidebarCollapsed: 'waker.pref.sidebar-collapsed',
};

/** Reads all UI preferences; unknown or missing values fall back to the defaults. */
export function readUiPreferences(
  storage: StorageLike | undefined = defaultStorage(),
): UiPreferences {
  const read = (key: keyof UiPreferences): boolean => {
    try {
      return storage?.getItem(PREFERENCE_KEYS[key]) === '1';
    } catch {
      return DEFAULT_UI_PREFERENCES[key];
    }
  };
  return { compactMessages: read('compactMessages'), sidebarCollapsed: read('sidebarCollapsed') };
}

/** Persists one preference; storage failures are non-fatal. Returns the next preference set. */
export function writeUiPreference(
  current: UiPreferences,
  key: keyof UiPreferences,
  value: boolean,
  storage: StorageLike | undefined = defaultStorage(),
): UiPreferences {
  try {
    storage?.setItem(PREFERENCE_KEYS[key], value ? '1' : '0');
  } catch {
    // 隐私模式 / 配额满时静默降级，偏好只在内存中生效。
  }
  return { ...current, [key]: value };
}

/** Server-side key (SQLite preferences table) for one UI preference. */
const SERVER_KEYS: Record<keyof UiPreferences, string> = {
  compactMessages: 'ui.compact-messages',
  sidebarCollapsed: 'ui.sidebar-collapsed',
};

export function serverKeyForPreference(key: keyof UiPreferences): string {
  return SERVER_KEYS[key];
}

/** Merges server-persisted UI preferences into the local cache; server values win. */
export function mergeServerUiPreferences(
  items: Record<string, unknown>,
  storage: StorageLike | undefined = defaultStorage(),
): UiPreferences {
  const next = readUiPreferences(storage);
  for (const key of Object.keys(SERVER_KEYS) as Array<keyof UiPreferences>) {
    const value = items[SERVER_KEYS[key]];
    if (typeof value !== 'boolean') continue;
    next[key] = value;
    try {
      storage?.setItem(PREFERENCE_KEYS[key], value ? '1' : '0');
    } catch {
      // 本地缓存失败不影响内存中的合并结果。
    }
  }
  return next;
}
