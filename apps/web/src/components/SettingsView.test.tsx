import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fireEvent, render, screen } from '@testing-library/react';
import type { SettingsResponse } from '@waker/contracts';
import { DEFAULT_UI_PREFERENCES, type UiPreferences } from '../lib/preferences.js';
import { SettingsView } from './SettingsView.js';

const SETTINGS: SettingsResponse = {
  model: { provider: 'openai', model: 'gpt-5', available: [] },
  thinkingLevel: 'medium',
  resources: { agents: 1, prompts: 0, skills: 0, appendSystem: false },
  workspace: { name: 'codex-waker', sessionDir: '.codex/sessions' },
  security: {
    codexEnabled: true,
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    managedByHost: true,
  },
};

function renderSettings(preferences: UiPreferences = DEFAULT_UI_PREFERENCES) {
  const calls: Array<{ key: string; value: unknown }> = [];
  const view = render(
    <SettingsView
      settings={SETTINGS}
      loading={false}
      preferences={preferences}
      onPreferenceChange={(key, value) => calls.push({ key, value })}
    />,
  );
  return { view, calls };
}

describe('SettingsView 界面偏好', () => {
  it('主题亮暗渲染三档并高亮当前值，切换写偏好', () => {
    const { calls } = renderSettings({ ...DEFAULT_UI_PREFERENCES, theme: 'auto' });

    const group = screen.getByRole('radiogroup', { name: '主题亮暗' });
    const options = ['自动', '浅色', '深色'].map((label) =>
      screen.getByRole('radio', { name: label }),
    );
    assert.equal(options.length, 3);
    assert.ok(group.contains(options[0]!));
    assert.equal(options[0]!.getAttribute('aria-checked'), 'true');
    assert.equal(options[0]!.tabIndex, 0);
    assert.equal(options[1]!.tabIndex, -1);
    assert.equal(options[2]!.getAttribute('aria-checked'), 'false');

    fireEvent.keyDown(options[0]!, { key: 'ArrowRight' });
    assert.equal(document.activeElement, options[1]);
    fireEvent.click(options[2]!);
    assert.deepEqual(calls, [
      { key: 'theme', value: 'light' },
      { key: 'theme', value: 'dark' },
    ]);
  });

  it('AI 回复语言选择写偏好，描述对齐旧版', () => {
    const { calls } = renderSettings({
      ...DEFAULT_UI_PREFERENCES,
      agentOutputLanguage: 'zh-CN',
    });

    assert.ok(screen.getByText('设置新会话中 AI 默认使用的回复语言'));
    assert.equal(screen.getByRole('radio', { name: '中文' }).getAttribute('aria-checked'), 'true');

    fireEvent.click(screen.getByRole('radio', { name: 'English' }));
    assert.deepEqual(calls, [{ key: 'agentOutputLanguage', value: 'en-US' }]);
  });

  it('未设置语言时「不指定」为当前值', () => {
    renderSettings();
    assert.equal(
      screen.getByRole('radio', { name: '不指定' }).getAttribute('aria-checked'),
      'true',
    );
  });

  it('消息紧凑模式使用可访问开关并写入新值', () => {
    const { calls } = renderSettings();
    const toggle = screen.getByRole('switch', { name: '消息紧凑模式' });
    assert.equal(toggle.getAttribute('aria-checked'), 'false');

    fireEvent.click(toggle);

    assert.deepEqual(calls, [{ key: 'compactMessages', value: true }]);
  });
});
