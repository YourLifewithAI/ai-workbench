// SEC-46: a detached child cannot escape budget (D-76).
//
// Part a, the ground the rest stands on: an agent's own daily and monthly caps count every run beneath its
// runs, not only its own. Until RUN-24 a companion with a $5 day could direct $50 of research and its own cap
// never noticed — the workspace cap did, the researcher's did, the orchestrator's did not, and the orchestrator
// is the one that chose to spend it. Part b (detached dispatch) is added with the tool that makes it possible.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { RunDetail } from '../../src/shared/api/index.js';
import type { EventRecord, Spent } from '../../src/shared/events.js';
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

/**
 * Part b: a child let go (`wait: false`, D-76) is bounded the same way a waited one is, and its carve is charged
 * to the parent the moment it is let go — on the parent's live budget, so the parent's own next turn and its next
 * carve see it, and on the row, which is what anyone reading a finished parent sees. Nothing flows up at dispatch:
 * the parent has read nothing, so the child's taint is the child's.
 */
describe('SEC-46b a detached child cannot escape budget', () => {
  /** The Editor may delegate and start workflows; the Researcher may search — on the mock, offline, slowly. */
  function prepare(name: string): string {
    const ws = tempWorkspace(name);
    const file = path.join(ws, 'config', 'workbench.json');
    const config = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    config['grants'] = {
      delegator: { tools: { 'agent.delegate': 'allow', 'workflow.run': 'allow' } },
      researcher: { tools: { 'web.search': 'allow' } },
    };
    (config['search'] as Record<string, unknown>) = { provider: 'mock' };
    fs.writeFileSync(file, JSON.stringify(config, null, 2));
    fs.writeFileSync(path.join(ws, 'workflows', 'ask.workflow.json'), JSON.stringify({
      schemaVersion: 1, id: 'ask', name: 'Ask', description: 'One question to the researcher.',
      inputs: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
      steps: [{ id: 'answer', kind: 'agent', agent: 'researcher', input: '{{inputs.question}}' }],
      outputs: { answer: '{{steps.answer.output}}' },
    }, null, 2));
    return ws;
  }
  function fixtures(ws: string, entries: { name: string; match: Record<string, unknown>; respond: Record<string, unknown> }[]): void {
    for (const f of entries) fs.writeFileSync(path.join(ws, 'fixtures', `${f.name}.json`), JSON.stringify({ match: f.match, respond: f.respond }));
  }
  async function trace(started: Started, runId: string): Promise<EventRecord[]> {
    return (await (await fetch(`${started.baseUrl}/api/v1/runs/${runId}/trace.jsonl`, { headers: { Authorization: `Bearer ${started.token}` } })).text())
      .trim().split('\n').map((l) => JSON.parse(l) as EventRecord);
  }
  const row = (started: Started, id: string): { state: string; parent_run_id: string | null; depth: number; external_tainted: number; spent: Spent; budgets: { maxModelCalls: number; maxCostUsd: number } } => {
    const r = started.runtime.db.prepare('SELECT state, parent_run_id, depth, external_tainted, spent_json, budgets_json FROM runs WHERE id = ?').get(id) as
      { state: string; parent_run_id: string | null; depth: number; external_tainted: number; spent_json: string; budgets_json: string };
    return { state: r.state, parent_run_id: r.parent_run_id, depth: r.depth, external_tainted: r.external_tainted, spent: JSON.parse(r.spent_json) as Spent, budgets: JSON.parse(r.budgets_json) as { maxModelCalls: number; maxCostUsd: number } };
  };
  const finished = (started: Started, id: string): boolean => ['completed', 'failed'].includes(started.runtime.engine.getRun(id)?.state ?? '');
  /** What the mock actually charged for a run's own model calls: a few ten-thousandths, not nothing. */
  const ownCost = (started: Started, ...ids: string[]): number =>
    (started.runtime.db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM model_calls WHERE run_id IN (${ids.map(() => '?').join(',')})`).get(...ids) as { total: number }).total;

  it('let go with a size: the parent gets the run id at once, is charged the carve, finishes first, and reads nothing up', async () => {
    const ws = prepare('sec46b-agent');
    fixtures(ws, [
      { name: 'aa0-editor-done', match: { systemIncludes: 'The Editor', afterTool: 'agent.delegate' }, respond: { text: 'Let go; I will look next time.' } },
      { name: 'aa1-editor-delegate', match: { systemIncludes: 'The Editor' },
        respond: { text: 'Starting the researcher.', toolCalls: [{ name: 'agent.delegate', input: { agent: 'researcher', input: 'What is the arcology? Take your time.', wait: false, maxModelCalls: 3, maxCostUsd: 0.25 } }] } },
      { name: 'aa2-researcher-answer', match: { systemIncludes: 'The Researcher', afterTool: 'web.search' }, respond: { text: 'A city in one building (https://example.com/arcology).' } },
      // Slow on purpose: the parent must be done before the child's first call returns.
      { name: 'aa3-researcher-search', match: { systemIncludes: 'The Researcher' },
        respond: { text: 'Searching.', latencyMs: 1500, toolCalls: [{ name: 'web.search', input: { query: 'arcology' } }] } },
    ]);
    const started = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true });
    try {
      const { runId, done } = started.runtime.engine.startAgentRun({ agentId: 'delegator', inputs: { input: 'Find out about the arcology; do not wait on it.' } });
      await done;
      expect(started.runtime.engine.getRun(runId)?.state).toBe('completed');

      const events = await trace(started, runId);
      const delegated = events.find((e) => e.type === 'tool-completed' && e.payload['tool'] === 'agent.delegate')!;
      expect(delegated.payload['ok'], JSON.stringify(delegated.payload)).toBe(true);
      const out = delegated.payload['output'] as Record<string, unknown>;
      expect(out['detached']).toBe(true);
      // Nothing came back, so nothing is there to read: no output, no cost, and no taint on the parent.
      expect(out).not.toHaveProperty('output');
      expect(out).not.toHaveProperty('costUsd');
      expect(JSON.stringify(delegated.payload)).not.toContain('taint');
      const childId = String(out['runId']);
      // The parent finished while the child was still at work.
      expect(finished(started, childId), 'the child was still running when the parent finished').toBe(false);
      // The parent's trace shows the child start, marked as let go.
      const start = events.find((e) => e.type === 'run-started' && e.payload['childRunId'] === childId)!;
      expect(start).toBeDefined();
      expect(start.payload).toMatchObject({ kind: 'agent', agentId: 'researcher', depth: 1, delegated: true, detached: true });

      // The carve is what was asked for, and the parent was charged it at dispatch — two calls of its own plus
      // three reserved, and the dollars reserved though the mock spends none. The row was written at finish from
      // the live budget, so the reservation survived the parent's own bookkeeping.
      const child = row(started, childId);
      expect(child.parent_run_id).toBe(runId);
      expect(child.depth).toBe(1);
      expect(child.budgets).toMatchObject({ maxModelCalls: 3, maxCostUsd: 0.25 });
      const parent = row(started, runId);
      expect(parent.spent.modelCalls).toBe(2 + 3);
      expect(parent.spent.costUsd).toBeCloseTo(0.25 + ownCost(started, runId), 6);

      // The child runs to completion under a parent that is gone, inside its carve, and its taint stays its own.
      await waitFor(() => finished(started, childId), 20_000);
      const after = row(started, childId);
      expect(after.state).toBe('completed');
      expect(after.spent.modelCalls).toBeLessThanOrEqual(3);
      expect(after.external_tainted, 'the child read the web').toBe(1);
      expect(row(started, runId).external_tainted, 'the parent read nothing of it').toBe(0);
      // And what the child spends counts against the parent agent's own caps (part a), let go or not.
      started.runtime.db.prepare(`INSERT INTO model_calls (id, run_id, step_id, model_id, adapter, prompt_version, agent_version, usage_json, cost_usd, latency_ms, finish_reason, ts)
        VALUES ('m-b1', ?, 'main', 'anthropic/claude-sonnet-5', 'anthropic', 'p', 'a', '{}', 0.10, 1, 'stop', ?)`).run(childId, new Date().toISOString());
      expect(started.runtime.engine.spentTodayUsd('delegator')).toBeCloseTo(ownCost(started, runId, childId), 6);
      expect(started.runtime.engine.spentTodayUsd('delegator')).toBeGreaterThanOrEqual(0.10);
    } finally {
      await started.stop();
    }
  }, 60_000);

  it('let go without a size: the carve is half of what is left, so the parent can still finish its own turn (workflow.run)', async () => {
    const ws = prepare('sec46b-workflow');
    fixtures(ws, [
      { name: 'ab0-editor-done', match: { systemIncludes: 'The Editor', afterTool: 'workflow.run' }, respond: { text: 'Started; moving on.' } },
      { name: 'ab1-editor-run', match: { systemIncludes: 'The Editor' },
        respond: { text: 'Running the ask workflow.', toolCalls: [{ name: 'workflow.run', input: { workflow: 'ask', inputs: { question: 'What is the arcology?' }, wait: false } }] } },
      { name: 'ab2-researcher-answer', match: { systemIncludes: 'The Researcher' }, respond: { text: 'A city in one building.', latencyMs: 800 } },
    ]);
    const started = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true });
    try {
      const { runId, done } = started.runtime.engine.startAgentRun({ agentId: 'delegator', inputs: { input: 'Ask about the arcology; do not wait.' } });
      await done;
      expect(started.runtime.engine.getRun(runId)?.state, 'the parent had budget left for its own last turn').toBe('completed');

      const events = await trace(started, runId);
      const ran = events.find((e) => e.type === 'tool-completed' && e.payload['tool'] === 'workflow.run')!;
      expect(ran.payload['ok'], JSON.stringify(ran.payload)).toBe(true);
      const out = ran.payload['output'] as Record<string, unknown>;
      expect(out['detached']).toBe(true);
      expect(out).not.toHaveProperty('outputs');
      const childId = String(out['runId']);
      expect(events.some((e) => e.type === 'run-started' && e.payload['childRunId'] === childId && e.payload['kind'] === 'workflow' && e.payload['detached'] === true)).toBe(true);

      // Half of what was left when it was let go: the parent had made one call by then, and the live budget knew
      // both the call and what it cost.
      const parent = row(started, runId);
      const child = row(started, childId);
      const firstCall = (started.runtime.db.prepare('SELECT cost_usd FROM model_calls WHERE run_id = ? ORDER BY ts LIMIT 1').get(runId) as { cost_usd: number }).cost_usd;
      expect(child.budgets.maxModelCalls).toBe(Math.max(1, Math.floor((parent.budgets.maxModelCalls - 1) / 2)));
      expect(child.budgets.maxCostUsd).toBeCloseTo((parent.budgets.maxCostUsd - firstCall) / 2, 6);
      expect(parent.spent.modelCalls).toBe(2 + child.budgets.maxModelCalls);
      expect(parent.spent.costUsd).toBeCloseTo(child.budgets.maxCostUsd + ownCost(started, runId), 6);

      await waitFor(() => finished(started, childId), 20_000);
      expect(row(started, childId).state).toBe('completed');
    } finally {
      await started.stop();
    }
  }, 60_000);
});
