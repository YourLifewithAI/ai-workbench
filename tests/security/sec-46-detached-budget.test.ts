// SEC-46: a detached child cannot escape budget (D-76).
//
// Part a, the ground the rest stands on: an agent's own daily and monthly caps count every run beneath its
// runs, not only its own. Until RUN-24 a companion with a $5 day could direct $50 of research and its own cap
// never noticed — the workspace cap did, the researcher's did, the orchestrator's did not, and the orchestrator
// is the one that chose to spend it. Part b (detached dispatch) is added with the tool that makes it possible.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { RunDetail } from '../../src/shared/api/index.js';
import { startRuntime, tempWorkspace, waitFor, type Started } from '../helpers/workspace.js';

let rt: Started;
const headers = (): Record<string, string> => ({ Authorization: `Bearer ${rt.token}`, 'Content-Type': 'application/json' });
const api = (method: string, p: string, body?: unknown): Promise<Response> =>
  fetch(`${rt.baseUrl}/api/v1${p}`, { method, headers: headers(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const detail = async (runId: string): Promise<RunDetail> => (await (await api('GET', `/runs/${runId}`)).json()) as RunDetail;

/** A model call that cost `usd`, on a run: what the caps read. The mock spends nothing, so the row is planted. */
function spent(runId: string, usd: number, id: string): void {
  rt.runtime.db.prepare(`INSERT INTO model_calls (id, run_id, step_id, model_id, adapter, prompt_version, agent_version, usage_json, cost_usd, latency_ms, finish_reason, ts)
    VALUES (?, ?, 'main', 'anthropic/claude-sonnet-5', 'anthropic', 'p', 'a', '{}', ?, 1, 'stop', ?)`).run(id, runId, usd, new Date().toISOString());
}
/** A run row with a parent, the way a delegation leaves one: enough for the caps to walk. */
function run(id: string, agentId: string, parent: string | null, depth: number): void {
  rt.runtime.db.prepare(`INSERT INTO runs (id, kind, state, agent_id, parent_run_id, depth, inputs_json, budgets_json, spent_json, started_at)
    VALUES (?, 'agent', 'completed', ?, ?, ?, '{}', '{}', '{}', ?)`).run(id, agentId, parent, depth, new Date().toISOString());
}

beforeAll(async () => { rt = await startRuntime(tempWorkspace('sec46'), { providerOverride: 'mock', noScheduler: true }); });
afterAll(async () => { await rt.stop(); });

describe('SEC-46a an agent\'s own caps count every run beneath its runs', () => {
  it('a child\'s spend counts against the parent agent and the child agent, and against nobody else', () => {
    run('p1', 'companion', null, 0);
    run('c1', 'researcher', 'p1', 1);
    run('g1', 'synthesizer', 'c1', 2);
    spent('p1', 0.10, 'm-p1');
    spent('c1', 1.00, 'm-c1');
    spent('g1', 0.50, 'm-g1');
    // The orchestrator pays for the chain it started; each agent beneath it pays for its own.
    expect(rt.runtime.engine.spentTodayUsd('companion')).toBeCloseTo(1.60, 6);
    expect(rt.runtime.engine.spentTodayUsd('researcher')).toBeCloseTo(1.50, 6);
    expect(rt.runtime.engine.spentTodayUsd('synthesizer')).toBeCloseTo(0.50, 6);
    expect(rt.runtime.engine.spentTodayUsd('echo')).toBe(0);
    // And the workspace total is the sum, counted once.
    expect(rt.runtime.engine.spentTodayUsd()).toBeCloseTo(1.60, 6);
  });

  it('a run reachable by two paths is counted once, and a parent that is not the agent\'s does not leak', () => {
    // A researcher run that is a child of a researcher run: both are the researcher's, one row, one count.
    run('r1', 'researcher', null, 0);
    run('r2', 'researcher', 'r1', 1);
    spent('r2', 2.00, 'm-r2');
    expect(rt.runtime.engine.spentTodayUsd('researcher')).toBeCloseTo(3.50, 6);
    // The companion's number is unchanged: r1 is not beneath any companion run.
    expect(rt.runtime.engine.spentTodayUsd('companion')).toBeCloseTo(1.60, 6);
  });

  it('the cap itself stops the orchestrator when its children have spent its month', async () => {
    // The workspace's daily cap would fire first; move it aside so the only cap in reach is the companion's own.
    expect((await api('PUT', '/settings', { budgets: { dailySpendCapUsd: 0 } })).status).toBe(202);
    run('p2', 'companion', null, 0);
    run('c2', 'researcher', 'p2', 1);
    spent('c2', 45, 'm-c2'); // past the companion's $40 month, spent by its child
    expect(rt.runtime.engine.spentThisMonthUsd('companion')).toBeGreaterThanOrEqual(45);

    const res = await api('POST', '/runs', { kind: 'agent', id: 'companion', inputs: { input: 'Anything.' }, project: 'companion', provider: 'mock' });
    expect(res.status).toBe(202);
    const { runId } = (await res.json()) as { runId: string };
    await waitFor(async () => ['completed', 'failed'].includes((await detail(runId)).state), 30_000);
    const stopped = await detail(runId);
    expect(stopped.state).toBe('failed');
    expect(stopped.error).toMatchObject({ reason: 'monthly_cap_reached', message: expect.stringContaining("companion's own monthly cap ($40.00)") });

    // Everyone else still runs: the workspace's month is not reached.
    const echo = await api('POST', '/runs', { kind: 'agent', id: 'echo', inputs: { input: 'hello' }, provider: 'mock' });
    const echoId = ((await echo.json()) as { runId: string }).runId;
    await waitFor(async () => ['completed', 'failed'].includes((await detail(echoId)).state), 30_000);
    expect((await detail(echoId)).state).toBe('completed');
  }, 60_000);
});
