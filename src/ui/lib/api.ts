// Every call carries the bearer token; SSE is fetch-based (never EventSource) so it can too.
import type { AgentDetail, AgentListResponse, CreateRunRequest, ReloadAgentsResponse, RunDetail, RunSummary, SettingsResponse } from '../../shared/api/index.js';
import type { EventRecord } from '../../shared/events.js';
import { getToken, markUnauthorized } from './auth.js';

export class ApiRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(`/api/v1${path}`, { ...init, headers });
  if (res.status === 401) {
    markUnauthorized();
    throw new ApiRequestError(401, 'unauthorized', 'The runtime token is missing or wrong.');
  }
  if (!res.ok) {
    let code = 'internal';
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      if (body.error?.message) { message = body.error.message; code = body.error.code ?? code; }
    } catch {
      // not JSON
    }
    throw new ApiRequestError(res.status, code, message);
  }
  return res;
}

export const api = {
  settings: (): Promise<SettingsResponse> => apiFetch('/settings').then((r) => r.json() as Promise<SettingsResponse>),
  runs: (): Promise<RunSummary[]> => apiFetch('/runs').then((r) => r.json() as Promise<{ runs: RunSummary[] }>).then((b) => b.runs),
  run: (id: string): Promise<RunDetail> => apiFetch(`/runs/${encodeURIComponent(id)}`).then((r) => r.json() as Promise<RunDetail>),
  agents: (): Promise<AgentListResponse> => apiFetch('/agents').then((r) => r.json() as Promise<AgentListResponse>),
  agent: (id: string): Promise<AgentDetail> => apiFetch(`/agents/${encodeURIComponent(id)}`).then((r) => r.json() as Promise<AgentDetail>),
  reloadAgents: (): Promise<ReloadAgentsResponse> => apiFetch('/agents/reload', { method: 'POST' }).then((r) => r.json() as Promise<ReloadAgentsResponse>),
  trace: (id: string): Promise<string> => apiFetch(`/runs/${encodeURIComponent(id)}/trace.jsonl`).then((r) => r.text()),
  createRun: (body: CreateRunRequest): Promise<{ runId: string }> =>
    apiFetch('/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<{ runId: string }>),
};

export interface SseMessage { id?: string; event?: string; data: string }

/** Reads a text/event-stream response until the server closes it or `signal` aborts. */
export async function subscribeSse(path: string, onMessage: (m: SseMessage) => void, signal: AbortSignal): Promise<void> {
  const res = await apiFetch(path, { headers: { Accept: 'text/event-stream' }, signal });
  const body = res.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf('\n\n');
      while (idx !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const message = parseChunk(chunk);
        if (message) onMessage(message);
        idx = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseChunk(chunk: string): SseMessage | null {
  const out: SseMessage = { data: '' };
  const data: string[] = [];
  for (const line of chunk.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') out.event = value;
    else if (field === 'id') out.id = value;
    else if (field === 'data') data.push(value);
  }
  if (!out.event && data.length === 0) return null;
  out.data = data.join('\n');
  return out;
}

export function parseEvent(m: SseMessage): EventRecord | null {
  try {
    return JSON.parse(m.data) as EventRecord;
  } catch {
    return null;
  }
}
