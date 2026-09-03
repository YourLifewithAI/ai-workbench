const KEY = 'workbench.welcome-done';

export function welcomeDone(): boolean {
  try { return window.localStorage.getItem(KEY) === '1'; } catch { return false; }
}

export function setWelcomeDone(done: boolean): void {
  try {
    if (done) window.localStorage.setItem(KEY, '1');
    else window.localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
