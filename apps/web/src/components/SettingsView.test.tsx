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
      loaded
      error={null}
      preferences={preferences}
      onPreferenceChange={(key, value) => calls.push({ key, value })}
      onRetry={() => undefined}
    />,
  );
  return { view, calls };
}

describe('SettingsView 界面偏好', () => {
  it('主题亮暗渲染三档并高亮当前值，切换写偏好', () => {
    const { calls } = renderSettings({ ...DEFAULT_UI_PREFERENCES, theme: 'auto' });
    assert.ok(screen.getByRole('heading', { name: '设置', level: 1 }));
    assert.ok(screen.getByRole('heading', { name: '界面偏好', level: 2 }));

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

  it('读取失败时提供明确的重试操作', () => {
    let retries = 0;
    render(
      <SettingsView
        settings={null}
        loading={false}
        loaded
        error={new Error('本地 API 不可用')}
        preferences={DEFAULT_UI_PREFERENCES}
        onPreferenceChange={() => undefined}
        onRetry={() => {
          retries += 1;
        }}
      />,
    );

    assert.ok(screen.getByRole('alert'));
    assert.ok(screen.getByText('本地 API 不可用'));
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    assert.equal(retries, 1);
  });

  it('刷新失败时保留旧设置并显示可重试提示', () => {
    render(
      <SettingsView
        settings={SETTINGS}
        loading={false}
        loaded
        error={new Error('刷新失败')}
        preferences={DEFAULT_UI_PREFERENCES}
        onPreferenceChange={() => undefined}
        onRetry={() => undefined}
      />,
    );

    assert.ok(screen.getByRole('alert'));
    assert.ok(screen.getByText('设置刷新失败，当前仍显示上次读取的数据。'));
    assert.ok(screen.getByText('openai'));
  });
});
