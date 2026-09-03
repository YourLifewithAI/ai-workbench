import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App.js';
import { takeTokenFromUrl } from './lib/auth.js';
import { applyTheme, readTheme, watchSystemTheme } from './lib/theme.js';

takeTokenFromUrl();
applyTheme(readTheme());
watchSystemTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
