import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyThemePreference } from './theme.js';

const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return styles.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
});

describe('applyThemePreference', () => {
  it('sets data-theme for manual themes and removes it for auto', () => {
    applyThemePreference('dark');
    assert.equal(document.documentElement.getAttribute('data-theme'), 'dark');

    applyThemePreference('light');
    assert.equal(document.documentElement.getAttribute('data-theme'), 'light');

    applyThemePreference('auto');
    assert.equal(document.documentElement.hasAttribute('data-theme'), false);
  });

  it('tolerates a missing document root', () => {
    assert.doesNotThrow(() => applyThemePreference('dark', undefined));
  });

  it('maps warning and error roles for automatic dark, manual dark and forced light themes', () => {
    for (const declaration of [
      '--warning-bg: #3a3018',
      '--warning-text: #ffd58a',
      '--error-bg: #3a211f',
      '--error-text: #ffb4ab',
      '--error-text-detail: #ffd0cc',
    ]) {
      assert.equal(styles.split(declaration).length - 1, 2, declaration);
    }
    for (const declaration of [
      '--warning-bg: #fef0c7',
      '--warning-text: #865604',
      '--error-bg: #fef3f2',
      '--error-text: #b42318',
      '--error-text-detail: #912018',
    ]) {
      assert.equal(styles.split(declaration).length - 1, 2, declaration);
    }
    assert.match(
      styles,
      /\.notebook-list button\.active small\s*\{\s*color:\s*var\(--text-brand\);\s*\}/,
    );
    assert.match(styles, /\.agent-chip\s*\{[^}]*color:\s*var\(--text-primary\);/s);
  });

  it('keeps Chat navigation, task panels and suggestions on theme tokens', () => {
    assert.match(cssRule('.qoder-chat-sidebar'), /background:\s*var\(--bg-secondary\)/);
    assert.match(cssRule('.qoder-chat-header'), /background:\s*var\(--bg-primary\)/);
    assert.match(cssRule('.qoder-chat-waker-active'), /var\(--bg-secondary-hover\)/);
    assert.match(cssRule('.qoder-task-panel'), /background:\s*var\(--bg-secondary\)/);
    assert.match(cssRule('.suggestion-button'), /background:\s*var\(--bg-secondary\)/);
    assert.match(cssRule('.suggestion-button'), /color:\s*var\(--text-primary\)/);
  });

  it('uses readable text roles for selected navigation and semantic feedback', () => {
    assert.match(cssRule('.legacy-rail-button.active'), /color:\s*var\(--text-primary\)/);
    assert.match(cssRule('.waker-detail-nav-item.active'), /color:\s*var\(--text-brand\)/);
    assert.match(cssRule('.toast-success'), /color:\s*var\(--text-brand\)/);
    assert.match(cssRule('.toast-success'), /border-color:\s*var\(--text-brand\)/);
    assert.match(cssRule('.composer.dragging-files'), /border-color:\s*var\(--text-brand\)/);
    assert.match(cssRule('.upload-box'), /border:\s*1px dashed var\(--text-brand\)/);
  });
});
