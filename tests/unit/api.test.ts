import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startRuntime, tempWorkspace, type Started } from '../helpers/workspace.js';

let rt: Started;
const get = (p: string, init: RequestInit = {}) => fetch(`${rt.baseUrl}/api/v1${p}`, { ...init, headers: { Authorization: `Bearer ${rt.token}`, ...(init.headers ?? {}) } });

beforeAll(async () => { rt = await startRuntime(tempWorkspace()); });
afterAll(async () => { await rt.stop(); });

describe('HTTP API (spec/api-and-cli.md)', () => {
  it('POST /runs returns 202 { runId } and the run completes on the mock', async () => {
    const res = await get('/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'agent', id: 'echo', inputs: { input: 'hi api' }, provider: 'mock' }) });
    expect(res.status).toBe(202);
    const { runId } = (await res.json()) as { runId: string };
    await rt.runtime.engine.waitFor(runId);
    const detail = (await (await get(`/runs/${runId}`)).json()) as { state: string; outputs: { output: string }; steps: unknown[] };
    expect(detail.state).toBe('completed');
    expect(detail.outputs.output).toBe('hi api');
    expect(detail.steps).toHaveLength(1);
    const list = (await (await get('/runs')).json()) as { runs: { id: string }[] };
    expect(list.runs.some((r) => r.id === runId)).toBe(true);
    const trace = await (await get(`/runs/${runId}/trace.jsonl`)).text();
    expect(trace.trim().split('\n').map((l) => (JSON.parse(l) as { type: string }).type)).toEqual(['run-started', 'step-started', 'model-started', 'model-completed', 'step-completed', 'run-completed']);
  });

  it('validates the body and names unknown agents', async () => {
    const bad = await get('/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"kind":"agent"}' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('validation');
    const missing = await get('/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'agent', id: 'nope', inputs: {} }) });
    expect(missing.status).toBe(404);
    const workflow = await get('/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'workflow', id: 'x', inputs: {} }) });
    expect(workflow.status).toBe(400);
    expect((await get('/runs/does-not-exist')).status).toBe(404);
    expect((await get('/nothing-here')).status).toBe(404);
  });

  it('GET /settings reports the workspace and GET /health needs no token', async () => {
    const settings = (await (await get('/settings')).json()) as { workspaceName: string; networkMode: string; sandbox: { deno: boolean } };
    expect(settings.workspaceName).toBe('test');
    expect(settings.networkMode).toBe('allowlist');
    expect(typeof settings.sandbox.deno).toBe('boolean');
    const health = await fetch(`${rt.baseUrl}/api/v1/health`);
    expect(health.status).toBe(200);
    expect(((await health.json()) as { startedAt: string }).startedAt).toBe(rt.runtime.startedAt);
  });
});
