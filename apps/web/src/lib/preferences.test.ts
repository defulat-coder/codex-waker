import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_UI_PREFERENCES,
  mergeServerUiPreferences,
  readUiPreferences,
  serverKeyForPreference,
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
      'waker.pref.theme': 'dark',
      'waker.pref.agent-output-language': 'fr-FR',
    });
    assert.deepEqual(readUiPreferences(storage), {
      compactMessages: true,
      theme: 'dark',
      agentOutputLanguage: '',
    });
  });

  it('writes one preference, persists it and returns the next set', () => {
    const storage = memoryStorage();
    const current: UiPreferences = { ...DEFAULT_UI_PREFERENCES };
    const next = writeUiPreference(current, 'compactMessages', true, storage);
    assert.deepEqual(next, { ...DEFAULT_UI_PREFERENCES, compactMessages: true });
    assert.equal(storage.map.get('waker.pref.compact-messages'), '1');
    assert.deepEqual(readUiPreferences(storage), next);

    const off = writeUiPreference(next, 'compactMessages', false, storage);
    assert.equal(storage.map.get('waker.pref.compact-messages'), '0');
    assert.equal(off.compactMessages, false);
    // 输入对象不被修改。
    assert.equal(current.compactMessages, false);
  });

  it('writes theme and agent output language as raw strings', () => {
    const storage = memoryStorage();
    const dark = writeUiPreference(DEFAULT_UI_PREFERENCES, 'theme', 'dark', storage);
    assert.equal(storage.map.get('waker.pref.theme'), 'dark');
    assert.deepEqual(readUiPreferences(storage), dark);

    const chinese = writeUiPreference(dark, 'agentOutputLanguage', 'zh-CN', storage);
    assert.equal(storage.map.get('waker.pref.agent-output-language'), 'zh-CN');
    assert.deepEqual(readUiPreferences(storage), chinese);

    const auto = writeUiPreference(chinese, 'theme', 'auto', storage);
    assert.equal(storage.map.get('waker.pref.theme'), 'auto');
    assert.deepEqual(readUiPreferences(storage), auto);
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
    const next = writeUiPreference(DEFAULT_UI_PREFERENCES, 'compactMessages', true, failing);
    assert.equal(next.compactMessages, true);
    assert.deepEqual(readUiPreferences(failing), DEFAULT_UI_PREFERENCES);
  });

  it('maps every preference to its server key', () => {
    assert.equal(serverKeyForPreference('theme'), 'ui.theme');
    assert.equal(serverKeyForPreference('agentOutputLanguage'), 'ui.agent-output-language');
    assert.equal(serverKeyForPreference('compactMessages'), 'ui.compact-messages');
  });

  it('merges server values with domain validation; server wins', () => {
    const storage = memoryStorage({ 'waker.pref.theme': 'dark' });
    const merged = mergeServerUiPreferences(
      {
        'ui.theme': 'light',
        'ui.agent-output-language': 'en-US',
        'ui.compact-messages': 'yes',
      },
      storage,
    );
    assert.deepEqual(merged, {
      ...DEFAULT_UI_PREFERENCES,
      theme: 'light',
      agentOutputLanguage: 'en-US',
    });
    assert.equal(storage.map.get('waker.pref.theme'), 'light');
    assert.equal(storage.map.get('waker.pref.agent-output-language'), 'en-US');

    // 非法主题值不覆盖本地缓存。
    const kept = mergeServerUiPreferences({ 'ui.theme': 'neon' }, storage);
    assert.equal(kept.theme, 'light');
  });
});
