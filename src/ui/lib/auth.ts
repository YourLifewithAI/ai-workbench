// Token handshake (spec/tools-and-security.md §Security floor): read `#token=` once, keep it in memory only.
type AuthState = 'ok' | 'required';

let token: string | null = null;
let state: AuthState = 'required';
const listeners = new Set<(s: AuthState) => void>();

function emit(): void {
  for (const l of listeners) l(state);
}

/** Consumes a `#token=…` fragment from the address bar and scrubs it from history. */
export function takeTokenFromUrl(): void {
  const hash = window.location.hash;
  const m = /^#token=([A-Za-z0-9_-]+)$/.exec(hash);
  if (m?.[1]) {
    token = m[1];
    state = 'ok';
    const clean = window.location.pathname + window.location.search;
    window.history.replaceState(null, '', clean === '' ? '/' : clean);
  }
}

export function getToken(): string | null { return token; }
export function getAuthState(): AuthState { return state; }

export function markUnauthorized(): void {
  if (state === 'required') return;
  state = 'required';
  emit();
}

export function setToken(value: string): void {
  token = value.trim();
  state = token ? 'ok' : 'required';
  emit();
}

export function onAuthChange(listener: (s: AuthState) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
