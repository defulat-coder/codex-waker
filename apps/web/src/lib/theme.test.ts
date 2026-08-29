import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyThemePreference } from './theme.js';

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
});
