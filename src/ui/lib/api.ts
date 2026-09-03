// Every call carries the bearer token; SSE is fetch-based (never EventSource) so it can too.
import type { AgentDetail, AgentListResponse, ApprovalItem, ApprovalListResponse, CompareRequest, ComparePickRequest, CompareResponse, CreateDatasetRequest, CreateExperimentRequest, CreateMemoryRequest, CreateProjectRequest, CreateRunRequest, DashboardResponse, DatasetSummary, DeleteMemoryResponse, ExperimentResults, ExperimentSummary, DiffResponse, DocumentDetail, DocumentSummary, GrantCell, KnowledgeSearchResponse, MemoryItem, MemoryResponse, MemoryTracesResponse, ModelListResponse, PrivacyResponse, Project, PushEventKind, PushSubscription, PushSubscriptionsResponse, RateRequest, RatingSummary, ReloadAgentsResponse, ReviewItem, RunDetail, RunSummary, ScheduleListResponse, ScheduleSummary, SetGrantRequest, SettingsResponse, UpdateSettingsRequest, SubscribePushRequest, ToolsResponse, UpsertScheduleRequest, WorkflowDetail, WorkflowListResponse } from '../../shared/api/index.js';
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
  models: (): Promise<ModelListResponse> => apiFetch('/models').then((r) => r.json() as Promise<ModelListResponse>),
  refreshModels: (): Promise<ModelListResponse> => apiFetch('/models/refresh', { method: 'POST' }).then((r) => r.json() as Promise<ModelListResponse>),
  privacy: (id: string): Promise<PrivacyResponse> => apiFetch(`/runs/${encodeURIComponent(id)}/privacy`).then((r) => r.json() as Promise<PrivacyResponse>),
  setNetworkMode: (mode: string): Promise<{ networkMode: string }> =>
    apiFetch('/settings/network', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) }).then((r) => r.json() as Promise<{ networkMode: string }>),
  projects: (): Promise<Project[]> => apiFetch('/projects').then((r) => r.json() as Promise<{ projects: Project[] }>).then((b) => b.projects),
  createProject: (body: CreateProjectRequest): Promise<Project> =>
    apiFetch('/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<Project>),
  documents: (slug: string): Promise<DocumentSummary[]> =>
    apiFetch(`/projects/${encodeURIComponent(slug)}/documents`).then((r) => r.json() as Promise<{ documents: DocumentSummary[] }>).then((b) => b.documents),
  document: (id: string, version?: string): Promise<DocumentDetail> =>
    apiFetch(`/documents/${encodeURIComponent(id)}${version ? `?version=${encodeURIComponent(version)}` : ''}`).then((r) => r.json() as Promise<DocumentDetail>),
  saveDocument: (id: string, content: string): Promise<DocumentDetail['history'][number]> =>
    apiFetch(`/documents/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) }).then((r) => r.json() as Promise<DocumentDetail['history'][number]>),
  diff: (id: string, from: string, to: string): Promise<DiffResponse> =>
    apiFetch(`/documents/${encodeURIComponent(id)}/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`).then((r) => r.json() as Promise<DiffResponse>),
  memory: (params: { q?: string; scope?: string } = {}): Promise<MemoryItem[]> => {
    const query = new URLSearchParams();
    if (params.q) query.set('q', params.q);
    if (params.scope) query.set('scope', params.scope);
    return apiFetch(`/memory${query.size ? `?${query}` : ''}`).then((r) => r.json() as Promise<MemoryResponse>).then((b) => b.items);
  },
  addMemory: (body: CreateMemoryRequest): Promise<MemoryItem> =>
    apiFetch('/memory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<MemoryItem>),
  memoryTraces: (id: string): Promise<MemoryTracesResponse> =>
    apiFetch(`/memory/${encodeURIComponent(id)}/traces`).then((r) => r.json() as Promise<MemoryTracesResponse>),
  deleteMemory: (id: string, redactTraces: boolean): Promise<DeleteMemoryResponse> =>
    apiFetch(`/memory/${encodeURIComponent(id)}?redactTraces=${redactTraces}`, { method: 'DELETE' }).then((r) => r.json() as Promise<DeleteMemoryResponse>),
  searchKnowledge: (q: string, project?: string): Promise<KnowledgeSearchResponse> =>
    apiFetch(`/knowledge/search?q=${encodeURIComponent(q)}${project ? `&project=${encodeURIComponent(project)}` : ''}`).then((r) => r.json() as Promise<KnowledgeSearchResponse>),
  datasets: (): Promise<DatasetSummary[]> => apiFetch('/datasets').then((r) => r.json() as Promise<{ datasets: DatasetSummary[] }>).then((b) => b.datasets),
  createDataset: (body: CreateDatasetRequest): Promise<DatasetSummary> =>
    apiFetch('/datasets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<DatasetSummary>),
  experiments: (): Promise<ExperimentSummary[]> => apiFetch('/experiments').then((r) => r.json() as Promise<{ experiments: ExperimentSummary[] }>).then((b) => b.experiments),
  createExperiment: (body: CreateExperimentRequest): Promise<ExperimentSummary> =>
    apiFetch('/experiments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<ExperimentSummary>),
  experimentResults: (id: string): Promise<ExperimentResults> =>
    apiFetch(`/experiments/${encodeURIComponent(id)}/results`).then((r) => r.json() as Promise<ExperimentResults>),
  compare: (body: CompareRequest): Promise<CompareResponse> =>
    apiFetch('/compare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<CompareResponse>),
  comparePick: (body: ComparePickRequest): Promise<{ compareId: string; ratings: number }> =>
    apiFetch('/compare/pick', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<{ compareId: string; ratings: number }>),
  setCredential: (name: string, apiKey: string | null): Promise<{ providersConfigured: string[] }> =>
    apiFetch('/settings/credentials', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, apiKey }) })
      .then((r) => r.json() as Promise<{ providersConfigured: string[] }>),
  updateSettings: (patch: UpdateSettingsRequest): Promise<{ ok: boolean; restartRequired: boolean }> =>
    apiFetch('/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
      .then((r) => r.json() as Promise<{ ok: boolean; restartRequired: boolean }>),
  trustPlugin: (name: string, version: string): Promise<{ trusted: string }> =>
    apiFetch('/plugins/trust', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, version }) })
      .then((r) => r.json() as Promise<{ trusted: string }>),
  trace: (id: string): Promise<string> => apiFetch(`/runs/${encodeURIComponent(id)}/trace.jsonl`).then((r) => r.text()),
  createRun: (body: CreateRunRequest): Promise<{ runId: string }> =>
    apiFetch('/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<{ runId: string }>),
  cancelRun: (id: string): Promise<{ cancelled: boolean }> =>
    apiFetch(`/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }).then((r) => r.json() as Promise<{ cancelled: boolean }>),
  workflows: (): Promise<WorkflowListResponse> => apiFetch('/workflows').then((r) => r.json() as Promise<WorkflowListResponse>),
  workflow: (id: string): Promise<WorkflowDetail> => apiFetch(`/workflows/${encodeURIComponent(id)}`).then((r) => r.json() as Promise<WorkflowDetail>),
  resumeRun: (id: string): Promise<{ runId: string }> =>
    apiFetch(`/runs/${encodeURIComponent(id)}/resume`, { method: 'POST' }).then((r) => r.json() as Promise<{ runId: string }>),
  dashboard: (): Promise<DashboardResponse> => apiFetch('/dashboard').then((r) => r.json() as Promise<DashboardResponse>),
  reviews: (state = 'open'): Promise<ReviewItem[]> =>
    apiFetch(`/reviews?state=${encodeURIComponent(state)}`).then((r) => r.json() as Promise<{ reviews: ReviewItem[] }>).then((b) => b.reviews),
  decideReview: (id: string, decision: 'continue' | 'reject' | 'dismiss', feedback?: string): Promise<ReviewItem> =>
    apiFetch(`/reviews/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision, ...(feedback ? { feedback } : {}) }) })
      .then((r) => r.json() as Promise<ReviewItem>),
  rate: (body: RateRequest): Promise<RatingSummary> =>
    apiFetch('/ratings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<RatingSummary>),
  schedules: (): Promise<ScheduleSummary[]> =>
    apiFetch('/schedules').then((r) => r.json() as Promise<ScheduleListResponse>).then((b) => b.schedules),
  upsertSchedule: (body: UpsertScheduleRequest, id?: string): Promise<ScheduleSummary> =>
    apiFetch(`/schedules${id ? `?id=${encodeURIComponent(id)}` : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then((r) => r.json() as Promise<ScheduleSummary>),
  removeSchedule: (id: string): Promise<{ deleted: boolean }> =>
    apiFetch(`/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' }).then((r) => r.json() as Promise<{ deleted: boolean }>),
  approvals: (state = 'pending'): Promise<ApprovalItem[]> =>
    apiFetch(`/approvals?state=${encodeURIComponent(state)}`).then((r) => r.json() as Promise<ApprovalListResponse>).then((b) => b.approvals),
  decideApproval: (id: string, decision: 'allow' | 'allow-remember' | 'deny', actionId?: string): Promise<{ decided: boolean }> =>
    apiFetch(`/approvals/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision, ...(actionId ? { actionId } : {}) }) })
      .then((r) => r.json() as Promise<{ decided: boolean }>),
  tools: (): Promise<ToolsResponse> => apiFetch('/tools').then((r) => r.json() as Promise<ToolsResponse>),
  setGrant: (body: SetGrantRequest): Promise<GrantCell> =>
    apiFetch('/tools/grants', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<GrantCell>),
  vapidPublicKey: (): Promise<{ publicKey: string }> => apiFetch('/push/vapid-public-key').then((r) => r.json() as Promise<{ publicKey: string }>),
  pushSubscriptions: (): Promise<PushSubscriptionsResponse> => apiFetch('/push/subscriptions').then((r) => r.json() as Promise<PushSubscriptionsResponse>),
  subscribePush: (body: SubscribePushRequest): Promise<PushSubscription> =>
    apiFetch('/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<PushSubscription>),
  setPushEvents: (id: string, events: PushEventKind[]): Promise<PushSubscription> =>
    apiFetch(`/push/subscriptions/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ events }) }).then((r) => r.json() as Promise<PushSubscription>),
  unsubscribePush: (id: string): Promise<{ deleted: boolean }> =>
    apiFetch(`/push/subscriptions/${encodeURIComponent(id)}`, { method: 'DELETE' }).then((r) => r.json() as Promise<{ deleted: boolean }>),
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
