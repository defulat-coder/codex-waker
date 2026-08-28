import { workbenchStoreFor } from './session-store.js';

/**
 * Tiny KV over the workbench database (better-sqlite3) for UI preferences.
 * Lives in the same .codex/workbench.sqlite database as the session bindings
 * (WorkbenchStore), namespaced keys (ui.*, thinking.<agentId>); values are kept
 * as JSON-encoded text in the preferences table. Inbox read/completed state is
 * NOT here — it is a column of the session row itself (see
 * AgentSessionStore.updateInboxState).
 *
 * 底层的 WorkbenchStore 缓存统一在 session-store.ts 的 workbenchStoreFor（按 cwd
 * 共享一条 sqlite 连接），这里不再另存一份缓存。
 */

export function getPreferences(cwd: string): Record<string, unknown> {
  return workbenchStoreFor(cwd).getPreferences();
}

export function setPreference(cwd: string, key: string, value: unknown): void {
  workbenchStoreFor(cwd).setPreference(key, value);
}

export function deletePreference(cwd: string, key: string): void {
  workbenchStoreFor(cwd).deletePreference(key);
}
