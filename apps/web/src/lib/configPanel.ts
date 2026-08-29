import { AGENT_THINKING_LEVELS, type AgentThinkingLevel } from '@waker/contracts';
import { defaultStorage, type StorageLike } from './storage.js';

export type ConfigSectionId = 'basic' | 'resources' | 'runtime';

/** 默认展开前两节（基本信息、资源），对应 旧实现 面板的首屏重点。 */
export const DEFAULT_OPEN_SECTIONS: readonly ConfigSectionId[] = ['basic', 'resources'];

/** Toggles one section id in the open-section list. */
export function toggleSection(
  open: readonly ConfigSectionId[],
  id: ConfigSectionId,
): ConfigSectionId[] {
  return open.includes(id) ? open.filter((item) => item !== id) : [...open, id];
}

/** 每个 Agent 的默认 thinking 级别；undefined 表示「跟随服务端默认」（不下发显式 thinking 参数）。 */
export type ThinkingPreference = AgentThinkingLevel | undefined;
/** 本地可选择的级别即契约全集；「跟随服务端默认」由 UI 单独提供（对应 undefined）。 */
export const THINKING_PREFERENCE_OPTIONS: readonly AgentThinkingLevel[] = AGENT_THINKING_LEVELS;

const THINKING_KEY_PREFIX = 'waker.thinking.';

/** Reads the per-agent default thinking level; anything unknown falls back to undefined（跟随服务端默认）. */
export function readThinkingPreference(
  agentId: string,
  storage: StorageLike | undefined = defaultStorage(),
): ThinkingPreference {
  try {
    const value = storage?.getItem(THINKING_KEY_PREFIX + agentId);
    return (AGENT_THINKING_LEVELS as readonly string[]).includes(value ?? '')
      ? (value as AgentThinkingLevel)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Persists the per-agent default thinking level; undefined stores ''（跟随服务端默认，读取时等价于未设置）。storage failures are non-fatal. */
export function writeThinkingPreference(
  agentId: string,
  level: ThinkingPreference,
  storage: StorageLike | undefined = defaultStorage(),
): void {
  try {
    storage?.setItem(THINKING_KEY_PREFIX + agentId, level ?? '');
  } catch {
    // 隐私模式 / 配额满时静默降级，偏好只在内存中生效。
  }
}

/** Server-side key (SQLite preferences table) for one agent's thinking preference. */
export function serverKeyForThinking(agentId: string): string {
  return `thinking.${agentId}`;
}

/** Merges server-persisted thinking preferences into the local cache; server values win. */
export function mergeServerThinkingPreferences(
  items: Record<string, unknown>,
  storage: StorageLike | undefined = defaultStorage(),
): void {
  for (const [key, value] of Object.entries(items)) {
    if (!key.startsWith('thinking.') || typeof value !== 'string') continue;
    // 空串语义：服务端把它当作删除该偏好（跟随服务端默认）。
    if (value !== '' && !(AGENT_THINKING_LEVELS as readonly string[]).includes(value)) continue;
    try {
      storage?.setItem(THINKING_KEY_PREFIX + key.slice('thinking.'.length), value);
    } catch {
      // 本地缓存失败时下次启动再合并。
    }
  }
}

const MODEL_KEY_PREFIX = 'waker.model.';

/** Reads the per-agent default model; undefined means「跟随全局默认」（服务端缺省模型）。 */
export function readModelPreference(
  agentId: string,
  storage: StorageLike | undefined = defaultStorage(),
): string | undefined {
  try {
    return storage?.getItem(MODEL_KEY_PREFIX + agentId) || undefined;
  } catch {
    return undefined;
  }
}

/** Persists the per-agent default model; undefined stores ''（跟随全局默认，读取时等价于未设置）。 */
export function writeModelPreference(
  agentId: string,
  model: string | undefined,
  storage: StorageLike | undefined = defaultStorage(),
): void {
  try {
    storage?.setItem(MODEL_KEY_PREFIX + agentId, model ?? '');
  } catch {
    // 隐私模式 / 配额满时静默降级，偏好只在内存中生效。
  }
}

/** Server-side key (SQLite preferences table) for one agent's model preference. */
export function serverKeyForModel(agentId: string): string {
  return `model.${agentId}`;
}

/** Merges server-persisted model preferences into the local cache; server values win. */
export function mergeServerModelPreferences(
  items: Record<string, unknown>,
  storage: StorageLike | undefined = defaultStorage(),
): void {
  for (const [key, value] of Object.entries(items)) {
    if (!key.startsWith('model.') || typeof value !== 'string' || !value) continue;
    try {
      storage?.setItem(MODEL_KEY_PREFIX + key.slice('model.'.length), value);
    } catch {
      // 本地缓存失败时下次启动再合并。
    }
  }
}
