import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_UI_PREFERENCES,
  readUiPreferences,
  writeUiPreference,
  type UiPreferences,
} from './preferences.js';

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    map,
  };
}

describe('UI preferences', () => {
  it('falls back to defaults when storage is empty or unavailable', () => {
    assert.deepEqual(readUiPreferences(memoryStorage()), DEFAULT_UI_PREFERENCES);
    assert.deepEqual(readUiPreferences(undefined), DEFAULT_UI_PREFERENCES);
  });

  it('reads persisted values and ignores unknown ones', () => {
    const storage = memoryStorage({
      'waker.pref.compact-messages': '1',
      'waker.pref.sidebar-collapsed': 'yes',
    });
    assert.deepEqual(readUiPreferences(storage), {
      compactMessages: true,
      sidebarCollapsed: false,
    });
  });

  it('writes one preference, persists it and returns the next set', () => {
    const storage = memoryStorage();
    const current: UiPreferences = { compactMessages: false, sidebarCollapsed: false };
    const next = writeUiPreference(current, 'compactMessages', true, storage);
    assert.deepEqual(next, { compactMessages: true, sidebarCollapsed: false });
    assert.equal(storage.map.get('waker.pref.compact-messages'), '1');
    assert.deepEqual(readUiPreferences(storage), next);

    const off = writeUiPreference(next, 'compactMessages', false, storage);
    assert.equal(storage.map.get('waker.pref.compact-messages'), '0');
    assert.equal(off.compactMessages, false);
    // 输入对象不被修改。
    assert.equal(current.compactMessages, false);
  });

  it('keeps the in-memory change when storage throws', () => {
    const failing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    const next = writeUiPreference(DEFAULT_UI_PREFERENCES, 'sidebarCollapsed', true, failing);
    assert.equal(next.sidebarCollapsed, true);
    assert.deepEqual(readUiPreferences(failing), DEFAULT_UI_PREFERENCES);
  });
});
