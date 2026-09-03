// Light and dark themes with a manual override; `prefers-color-scheme` wins when nothing is stored (D-59).
export type Theme = 'system' | 'light' | 'dark';
const KEY = 'workbench.theme';

export function readTheme(): Theme {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(theme: Theme): void {
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

export function saveTheme(theme: Theme): void {
  try {
    if (theme === 'system') window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, theme);
  } catch {
    // storage unavailable: the choice lives for this page only
  }
  applyTheme(theme);
}

export function watchSystemTheme(): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = (): void => { if (readTheme() === 'system') applyTheme('system'); };
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}
