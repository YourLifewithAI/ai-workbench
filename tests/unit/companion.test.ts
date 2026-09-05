// A space of the owner's own (F6): the companion ships with its project, remembers about the person in the user
// scope, files each exchange as a note in the Library, and stops at its own caps while the workspace goes on.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { MemoryResponse, RunDetail } from '../../src/shared/api/index.js';
import { startRuntime, tempWorkspace, waitFor, type Started } from '../helpers/workspace.js';

let rt: Started;
const headers = (): Record<string, string> => ({ Authorization: `Bearer ${rt.token}`, 'Content-Type': 'application/json' });
const api = (method: string, p: string, body?: unknown): Promise<Response> =>
  fetch(`${rt.baseUrl}/api/v1${p}`, { method, headers: headers(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const detail = async (runId: string): Promise<RunDetail> => (await (await api('GET', `/runs/${runId}`)).json()) as RunDetail;
const run = async (agentId: string, input: string, project?: string): Promise<RunDetail> => {
  const res = await api('POST', '/runs', { kind: 'agent', id: agentId, inputs: { input }, provider: 'mock', ...(project ? { project } : {}) });
  expect(res.status).toBe(202);
  const { runId } = (await res.json()) as { runId: string };
  await waitFor(async () => ['completed', 'failed'].includes((await detail(runId)).state), 30_000);
  return detail(runId);
};

beforeAll(async () => { rt = await startRuntime(tempWorkspace('companion'), { providerOverride: 'mock' }); });
afterAll(async () => { await rt.stop(); });

describe('the companion', () => {
  it('ships with its project and page, and loads with its own caps', async () => {
    const projects = (await (await api('GET', '/projects')).json()) as { projects: { slug: string; documents: number }[] };
    expect(projects.projects.find((p) => p.slug === 'companion')?.documents).toBe(1);
    const agent = rt.runtime.workspace.agents.get('companion')!;
    expect(agent.definition.budgets).toMatchObject({ dailySpendCapUsd: 2, monthlySpendCapUsd: 20 });
    expect(agent.definition.documents).toEqual(['about.md']);
    expect(agent.definition.permissions.tools).toMatchObject({ 'memory.remember': 'allow', 'memory.search': 'allow' });
  });

  it('remembers about the person in the user scope and files its note in the Library', async () => {
    const d = await run('companion', 'Keep going tonight, or stop?', 'companion');
    expect(d.state).toBe('completed');
    // Its own caps do not narrow the workspace's numbers on the run.
    expect(d.budgets.dailySpendCapUsd).toBe(rt.runtime.workspace.config.budgets.dailySpendCapUsd);
    expect(d.budgets.maxCostUsd).toBe(0.5);

    const memory = (await (await api('GET', '/memory?scope=user')).json()) as MemoryResponse;
    expect(memory.items.map((i) => ({ scope: i.scope, ownerId: i.ownerId, runId: i.runId, source: i.source }))).toEqual([
      { scope: 'user', ownerId: 'owner', runId: d.id, source: 'agent-tool' },
    ]);
    const docs = (await (await api('GET', '/projects/companion/documents')).json()) as { documents: { path: string }[] };
    expect(docs.documents.map((x) => x.path)).toEqual(expect.arrayContaining(['about.md', `notes/${d.id}.md`]));
  });

  it('stops at its own monthly cap while the rest of the workspace keeps running', async () => {
    // The workspace's daily cap ($20 as shipped) would stop everything at the seed below; take it out of the way
    // so the only cap in reach is the companion's own.
    expect((await api('PUT', '/settings', { budgets: { dailySpendCapUsd: 0 } })).status).toBe(202);
    expect(rt.runtime.workspace.config.budgets.dailySpendCapUsd).toBe(0);
    // Pretend this month's companion runs already cost more than its $20: a row on one of its runs.
    const first = rt.runtime.db.prepare("SELECT id FROM runs WHERE agent_id = 'companion' ORDER BY started_at LIMIT 1").get() as { id: string };
    rt.runtime.db.prepare(`INSERT INTO model_calls (id, run_id, step_id, model_id, adapter, prompt_version, agent_version, usage_json, cost_usd, latency_ms, finish_reason, ts)
      VALUES ('seed-own-cap', ?, 'main', 'anthropic/claude-sonnet-5', 'anthropic', 'p', 'a', '{}', 25, 1, 'stop', ?)`).run(first.id, new Date().toISOString());
    expect(rt.runtime.engine.spentThisMonthUsd('companion')).toBeGreaterThanOrEqual(25);
    expect(rt.runtime.engine.spentThisMonthUsd('echo')).toBe(0);

    const stopped = await run('companion', 'Again?', 'companion');
    expect(stopped.state).toBe('failed');
    expect(stopped.error).toMatchObject({ reason: 'monthly_cap_reached', message: expect.stringContaining("companion's own monthly cap ($20.00)") });

    // The workspace's own month ($100 as shipped) is not reached, so everything else still runs.
    const echo = await run('echo', 'hello');
    expect(echo.state).toBe('completed');
    expect(echo.outputs).toMatchObject({ output: 'hello' });
  });
});
