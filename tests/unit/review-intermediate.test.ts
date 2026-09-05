// Intermediate outputs stay out of Review (F4): `output: { document: null }` opens no row unless the step blocks.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ReviewItem, RunDetail } from '../../src/shared/api/index.js';
import { startRuntime, tempWorkspace, waitFor, type Started } from '../helpers/workspace.js';

let rt: Started;
const headers = (): Record<string, string> => ({ Authorization: `Bearer ${rt.token}`, 'Content-Type': 'application/json' });
const reviews = async (): Promise<ReviewItem[]> => ((await (await fetch(`${rt.baseUrl}/api/v1/reviews?state=open`, { headers: headers() })).json()) as { reviews: ReviewItem[] }).reviews;
async function run(kind: 'agent' | 'workflow', id: string, inputs: Record<string, unknown>, until: string[] = ['completed']): Promise<string> {
  const res = await fetch(`${rt.baseUrl}/api/v1/runs`, { method: 'POST', headers: headers(), body: JSON.stringify({ kind, id, inputs, provider: 'mock' }) });
  expect(res.status).toBe(202);
  const { runId } = (await res.json()) as { runId: string };
  await waitFor(async () => until.includes(((await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}`, { headers: headers() })).json()) as RunDetail).state), 60_000);
  return runId;
}

beforeAll(async () => { rt = await startRuntime(tempWorkspace('review-int'), { providerOverride: 'mock' }); });
afterAll(async () => { await rt.stop(); });

describe('what lands in Review', () => {
  it('a document step lands; an intermediate step does not', async () => {
    const story = await run('workflow', 'story-pipeline', { premise: 'A dentist finds a message in a tooth.' });
    const review = await run('workflow', 'permissions-review', {});
    const open = await reviews();
    expect(open.filter((r) => r.runId === story).map((r) => r.stepId).sort()).toEqual(['beats', 'draft', 'final']);
    // The auditor's JSON was `output: { document: null }`: nothing to rate, nothing in the queue.
    expect(open.filter((r) => r.runId === review)).toEqual([]);
  }, 120_000);

  it('a blocking step with an intermediate output still parks the run and lands in the queue', async () => {
    const made = await fetch(`${rt.baseUrl}/api/v1/workflows`, { method: 'POST', headers: headers(), body: JSON.stringify({ id: 'gate-int', name: 'Gate on an intermediate', copyOf: 'story-pipeline' }) });
    expect(made.status).toBe(201);
    const detail = (await made.json()) as { version: string; definition: { steps: Record<string, unknown>[] } };
    const definition = structuredClone(detail.definition);
    const beats = definition.steps.find((s) => s['id'] === 'beats')!;
    beats['output'] = { document: null };
    beats['review'] = 'blocking';
    const saved = await fetch(`${rt.baseUrl}/api/v1/workflows/gate-int`, { method: 'PUT', headers: headers(), body: JSON.stringify({ definition, baseVersion: detail.version }) });
    expect(saved.status, await saved.clone().text()).toBe(200);

    const runId = await run('workflow', 'gate-int', { premise: 'x' }, ['waiting_review']);
    const gate = (await reviews()).find((r) => r.runId === runId && r.stepId === 'beats');
    expect(gate?.blocking).toBe(true);
  }, 120_000);
});
