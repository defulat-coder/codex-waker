import type { ThemePreference } from './preferences.js';

/**
 * 把主题档位落到 <html data-theme>：light/dark 手动锁定，auto 移除属性回退到
 * prefers-color-scheme 媒体查询。启动时（main.tsx）先调一次避免首屏闪烁。
 */
export function applyThemePreference(
  theme: ThemePreference,
  root: HTMLElement | undefined = typeof document === 'undefined'
    ? undefined
    : document.documentElement,
): void {
  if (!root) return;
  if (theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}
