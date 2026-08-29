import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import { readUiPreferences } from './lib/preferences.js';
import { applyThemePreference } from './lib/theme.js';
import './styles.css';

// 首屏渲染前先落 data-theme，避免手动主题在启动时闪烁。
applyThemePreference(readUiPreferences().theme);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
