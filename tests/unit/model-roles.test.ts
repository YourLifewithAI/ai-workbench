// Model roles (D-68): a policy may name a role; the role's list is the owner's order; the first ready member runs.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { expandPolicy, resolveRoles, rolesReferenced } from '../../src/runtime/models/roles.js';
import type { AgentDetail, SettingsResponse } from '../../src/shared/api/index.js';
import { startRuntime, tempWorkspace, waitFor, type Started } from '../helpers/workspace.js';

const roles = { fast: ['google/gemini-3.6-flash', 'anthropic/claude-haiku-4-5', 'ollama/qwen3:14b'], capable: ['anthropic/claude-sonnet-5'], empty: [] };

describe('expandPolicy', () => {
  it('replaces a role with the members that are ready, in the list\'s order, and passes plain ids through', () => {
    const ready = (id: string): boolean => id.startsWith('anthropic/') || id.startsWith('ollama/');
    const out = expandPolicy(['role:fast', 'google/gemini-2.5-pro'], roles, ready);
    expect(out.ids).toEqual(['anthropic/claude-haiku-4-5', 'ollama/qwen3:14b', 'google/gemini-2.5-pro']);
    expect(out.rejected).toEqual([]);
  });

  it('says why a role contributed nothing: not a role, no members, or none ready', () => {
    const none = (): boolean => false;
    const out = expandPolicy(['role:fast', 'role:empty', 'role:nope'], roles, none);
    expect(out.ids).toEqual([]);
    expect(out.rejected.map((r) => r.id)).toEqual(['role:fast', 'role:empty', 'role:nope']);
    expect(out.rejected[0]!.reason).toContain('none of the 3 models in the "fast" role is ready');
    expect(out.rejected[0]!.reason).toContain('Settings');
    expect(out.rejected[1]!.reason).toContain('lists no models');
    expect(out.rejected[2]!.reason).toContain('not a role');
  });

  it('drops a duplicate that a role and a pin both name', () => {
    const out = expandPolicy(['anthropic/claude-sonnet-5', 'role:capable'], roles, () => true);
    expect(out.ids).toEqual(['anthropic/claude-sonnet-5']);
  });

  it('resolves each role to its first ready member, and lists the roles agents name', () => {
    expect(resolveRoles(roles, (id) => id === 'ollama/qwen3:14b')).toEqual({ fast: 'ollama/qwen3:14b', capable: null, empty: null });
    expect(rolesReferenced([{ primary: 'role:fast', fallbacks: ['role:capable'] }, { primary: 'mock/echo', fallbacks: [] }], ['role:cheap'])).toEqual(['capable', 'cheap', 'fast']);
  });
});

describe('a workspace on one key', () => {
  let ws: string;
  let rt: Started;
  const headers = (): Record<string, string> => ({ Authorization: `Bearer ${rt.token}`, 'Content-Type': 'application/json' });

  beforeAll(async () => {
    ws = tempWorkspace('roles');
    // An agent that names roles rather than models, like the shipped ones will.
    const dir = path.join(ws, 'agents', 'roled');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({
      schemaVersion: 1, id: 'roled', name: 'Roled', description: 'Names a role.',
      instructions: [{ name: 'task', text: 'Reply with the task text.' }],
      modelPolicy: { primary: 'role:fast', fallbacks: ['role:capable'] },
    }));
    // Only an Anthropic key: with the shipped defaults, `fast` should come to Haiku and `capable` to Sonnet.
    fs.writeFileSync(path.join(ws, 'config', 'credentials.json'), JSON.stringify({ anthropic: { apiKey: 'sk-ant-not-real-for-this-test' } }), { mode: 0o600 });
    rt = await startRuntime(ws);
  });
  afterAll(async () => { await rt.stop(); });

  it('resolves the shipped roles to the models the one key can run, and says so on the agent', async () => {
    const settings = (await (await fetch(`${rt.baseUrl}/api/v1/settings`, { headers: headers() })).json()) as SettingsResponse;
    expect(settings.models?.resolved).toMatchObject({ fast: 'anthropic/claude-haiku-4-5', capable: 'anthropic/claude-sonnet-5', cheap: 'anthropic/claude-haiku-4-5' });
    expect(settings.models?.undefinedRoles).toEqual([]);
    const agent = (await (await fetch(`${rt.baseUrl}/api/v1/agents/roled`, { headers: headers() })).json()) as AgentDetail;
    // fast → Haiku (the Gemini entries have no key, the local entry is disabled as shipped); capable → Sonnet, then Opus.
    expect(agent.modelPolicy.now).toEqual(['anthropic/claude-haiku-4-5', 'anthropic/claude-sonnet-5', 'anthropic/claude-opus-5']);
  });

  it('runs the agent on the role\'s first member under the mock, and names the expansion in the trace', async () => {
    const res = await fetch(`${rt.baseUrl}/api/v1/runs`, { method: 'POST', headers: headers(), body: JSON.stringify({ kind: 'agent', id: 'roled', inputs: { input: 'hello' }, provider: 'mock' }) });
    expect(res.status).toBe(202);
    const { runId } = (await res.json()) as { runId: string };
    await waitFor(async () => ((await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}`, { headers: headers() })).json()) as { state: string }).state === 'completed', 30_000);
    const trace = (await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}/trace.jsonl`, { headers: headers() })).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; payload: Record<string, unknown> });
    const started = trace.find((e) => e.type === 'step-started')!;
    // Under the mock every member is servable, so the whole list is the candidate list, in the owner's order.
    expect((started.payload['modelCandidates'] as string[])[0]).toBe('google/gemini-3.6-flash');
    expect(trace.find((e) => e.type === 'model-completed')?.payload['modelId']).toBe('google/gemini-3.6-flash');
  }, 60_000);

  it('a role with nothing ready fails the step with the reason and the screen to fix it on', async () => {
    const put = await fetch(`${rt.baseUrl}/api/v1/settings`, { method: 'PUT', headers: headers(), body: JSON.stringify({ models: { roles: { fast: ['google/gemini-3.6-flash'], capable: ['google/gemini-3.8-flash'], cheap: [] } } }) });
    expect(put.status).toBe(202);
    const settings = (await (await fetch(`${rt.baseUrl}/api/v1/settings`, { headers: headers() })).json()) as SettingsResponse;
    expect(settings.models?.roles['fast']).toEqual(['google/gemini-3.6-flash']);
    expect(settings.models?.resolved['fast']).toBeNull();
    const file = JSON.parse(fs.readFileSync(path.join(ws, 'config', 'workbench.json'), 'utf8')) as { models: { roles: Record<string, string[]> } };
    expect(file.models.roles['cheap']).toEqual([]);

    const res = await fetch(`${rt.baseUrl}/api/v1/runs`, { method: 'POST', headers: headers(), body: JSON.stringify({ kind: 'agent', id: 'roled', inputs: { input: 'hello' } }) });
    const { runId } = (await res.json()) as { runId: string };
    await waitFor(async () => ((await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}`, { headers: headers() })).json()) as { state: string }).state === 'failed', 30_000);
    const trace = (await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}/trace.jsonl`, { headers: headers() })).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; payload: { message?: string } });
    const failed = trace.find((e) => e.type === 'run-failed')!;
    expect(failed.payload.message).toContain('none of the 1 model in the "fast" role is ready (google/gemini-3.6-flash)');
    expect(failed.payload.message).toContain('Settings → Which models do the work');
  }, 60_000);

  it('refuses a role name that is not lowercase letters, digits and hyphens', async () => {
    const put = await fetch(`${rt.baseUrl}/api/v1/settings`, { method: 'PUT', headers: headers(), body: JSON.stringify({ models: { roles: { 'Not Ok': ['x'] } } }) });
    expect(put.status).toBe(400);
  });
});
