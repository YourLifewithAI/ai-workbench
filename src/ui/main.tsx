import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App.js';
import { takeTokenFromUrl } from './lib/auth.js';
import { applyTheme, readTheme, watchSystemTheme } from './lib/theme.js';
import { registerServiceWorker } from './lib/push.js';

takeTokenFromUrl();
applyTheme(readTheme());
watchSystemTheme();
// The worker caches the application shell and nothing private, so it needs no token and gates nothing.
void registerServiceWorker();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
