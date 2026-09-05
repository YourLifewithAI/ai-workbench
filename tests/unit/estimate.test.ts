// What a run will cost before it runs (F2): from the prompts it would compile and today's prices, read
// against the cap. Numbers here are the example workspace's, at the shipped prices.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { EstimateResponse } from '../../src/shared/api/index.js';
import { startRuntime, tempWorkspace, type Started } from '../helpers/workspace.js';
import { roleFirst } from '../helpers/roles.js';

let ws: string;
let rt: Started;
const headers = (): Record<string, string> => ({ Authorization: `Bearer ${rt.token}`, 'Content-Type': 'application/json' });
const estimate = async (body: unknown): Promise<Response> => fetch(`${rt.baseUrl}/api/v1/runs/estimate`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });

beforeAll(async () => {
  ws = tempWorkspace('estimate');
  // One Anthropic key: the capable role comes to Sonnet, the fast role to Haiku.
  fs.writeFileSync(path.join(ws, 'config', 'credentials.json'), JSON.stringify({ anthropic: { apiKey: 'sk-ant-not-real-for-this-test' } }), { mode: 0o600 });
  rt = await startRuntime(ws);
});
afterAll(async () => { await rt.stop(); });

describe('POST /runs/estimate', () => {
  it('prices an agent run from its compiled prompt on the model its role comes to, with a range and the cap', async () => {
    const res = await estimate({ kind: 'agent', id: 'architect', inputs: { input: 'A dentist finds a message in a tooth.' } });
    expect(res.status).toBe(200);
    const e = (await res.json()) as EstimateResponse;
    expect(e.steps).toHaveLength(1);
    const [main] = e.steps;
    expect(main!.modelId).toBe('anthropic/claude-sonnet-5');
    expect(main!.promptTokens).toBeGreaterThan(100);
    expect(main!.lowUsd).toBeGreaterThan(0);
    expect(main!.highUsd).toBeGreaterThanOrEqual(main!.lowUsd);
    expect(e.lowUsd).toBe(main!.lowUsd);
    expect(e.maxCostUsd).toBe(2);
    expect(e.caveat).toContain('$2.00');
    // Sonnet at $3/M in, $15/M out (the shipped price): a few hundred tokens in and 800 out is a cent or two.
    expect(e.lowUsd).toBeLessThan(0.05);
  });

  it('a longer task costs more, and an override changes the model', async () => {
    const short = (await (await estimate({ kind: 'agent', id: 'architect', inputs: { input: 'Go.' } })).json()) as EstimateResponse;
    const long = (await (await estimate({ kind: 'agent', id: 'architect', inputs: { input: 'Go. '.repeat(2000) } })).json()) as EstimateResponse;
    expect(long.promptTokens).toBeGreaterThan(short.promptTokens + 1500);
    expect(long.lowUsd).toBeGreaterThan(short.lowUsd);
    const haiku = (await (await estimate({ kind: 'agent', id: 'architect', inputs: { input: 'Go.' }, overrides: { model: 'anthropic/claude-haiku-4-5' } })).json()) as EstimateResponse;
    expect(haiku.steps[0]!.modelId).toBe('anthropic/claude-haiku-4-5');
    expect(haiku.lowUsd).toBeLessThan(short.lowUsd);
  });

  it('prices every agent step of a workflow, counts a reference as a typical output, and skips tool steps', async () => {
    const res = await estimate({ kind: 'workflow', id: 'story-pipeline', inputs: { premise: 'A dentist finds a message in a tooth.' } });
    expect(res.status).toBe(200);
    const e = (await res.json()) as EstimateResponse;
    expect(e.steps.map((s) => s.stepId)).toEqual(['beats', 'draft', 'final']);
    const beats = e.steps[0]!;
    const draft = e.steps[1]!;
    expect(beats.modelId).toBe('anthropic/claude-sonnet-5');
    // The draft step reads {{steps.beats.output}}: a typical output's worth of tokens more than its own text.
    expect(draft.promptTokens).toBeGreaterThan(beats.promptTokens + 500);
    // final pins role:fast → Haiku on this key.
    expect(e.steps[2]!.modelId).toBe('anthropic/claude-haiku-4-5');
    expect(e.lowUsd).toBeCloseTo(e.steps.reduce((n, s) => n + s.lowUsd, 0), 10);

    const review = (await (await estimate({ kind: 'workflow', id: 'permissions-review', inputs: {} })).json()) as EstimateResponse;
    expect(review.steps.find((s) => s.stepId === 'facts')?.note).toContain('tool step');
    expect(review.steps.find((s) => s.stepId === 'facts')?.lowUsd).toBe(0);
  });

  it('says when nothing is ready for a role, and refuses an unknown agent', async () => {
    const put = await fetch(`${rt.baseUrl}/api/v1/settings`, { method: 'PUT', headers: headers(), body: JSON.stringify({ models: { roles: { capable: ['google/gemini-3.8-flash'], fast: ['google/gemini-3.6-flash'], cheap: [] } } }) });
    expect(put.status).toBe(202);
    const e = (await (await estimate({ kind: 'agent', id: 'architect', inputs: { input: 'Go.' } })).json()) as EstimateResponse;
    expect(e.steps[0]!.modelId).toBeNull();
    expect(e.steps[0]!.note).toContain('Nothing is ready');
    expect(e.lowUsd).toBe(0);
    expect((await estimate({ kind: 'agent', id: 'nobody', inputs: {} })).status).toBe(404);
  });

  it('the mock is free: the fast role\'s first member is what the trace names, whatever the key', () => {
    expect(roleFirst('fast')).toBe('google/gemini-3.6-flash');
  });
});
