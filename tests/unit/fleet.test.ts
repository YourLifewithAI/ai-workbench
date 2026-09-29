// The fleet report (D-79): what a card says, counted from planted rows and checked against a hand count.
// Counting is grouped by agent in SQL; the only event replay is the latest run's summary line; no model call.
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fleetReport, type FleetDeps } from '../../src/runtime/orchestrator/fleet.js';
import type { AgentSummary, RunDetail } from '../../src/shared/api/index.js';
import type { Db } from '../../src/runtime/db/index.js';
import type { Workspace } from '../../src/runtime/workspace/loader.js';

let db: Db;
const NOW = new Date('2026-09-29T12:00:00Z');
const at = (daysAgo: number, hour = 0): string => new Date(NOW.getTime() - daysAgo * 86_400_000 + hour * 3_600_000).toISOString();

function open(): Db {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-fleet-'));
  const database = new Database(path.join(dir, 'test.db'));
  const migrations = path.join(process.cwd(), 'src', 'runtime', 'db', 'migrations');
  for (const file of fs.readdirSync(migrations).sort()) database.exec(fs.readFileSync(path.join(migrations, file), 'utf8'));
  return database as unknown as Db;
}

function run(id: string, agent: string | null, state: string, started: string, cost: number, calls: number, opts: { kind?: string; workflow?: string; finished?: string | null } = {}): void {
  db.prepare(`INSERT INTO runs (id, kind, state, agent_id, workflow_id, depth, inputs_json, outputs_json, budgets_json, spent_json, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, 0, '{}', '{"output":"done"}', '{}', ?, ?, ?)`)
    .run(id, opts.kind ?? 'agent', state, agent, opts.workflow ?? null, JSON.stringify({ costUsd: cost, modelCalls: calls, toolCalls: 0, wallClockMs: 1000 }), started, opts.finished === undefined ? started : opts.finished);
}
function call(id: string, runId: string, step: string, tin: number, tout: number, ts: string, cost = 0.01): void {
  db.prepare(`INSERT INTO model_calls (id, run_id, step_id, model_id, adapter, prompt_version, agent_version, usage_json, cost_usd, latency_ms, finish_reason, ts)
    VALUES (?, ?, ?, 'anthropic/claude-sonnet-5', 'anthropic', 'p', 'a', ?, ?, 1, 'stop', ?)`).run(id, runId, step, JSON.stringify({ input: tin, output: tout }), cost, ts);
}
function step(runId: string, stepId: string, agent: string, state: string, cost: number): void {
  db.prepare(`INSERT INTO run_steps (run_id, step_id, kind, state, agent_id, cost_usd) VALUES (?, ?, 'agent', ?, ?, ?)`).run(runId, stepId, state, agent, cost);
}
function score(runId: string, value: number, why: string, ts: string, by = 'orchestrator'): void {
  db.prepare(`INSERT INTO scores (id, run_id, evaluator_id, metric, value, rationale, estimate, ts) VALUES (?, ?, ?, 'rating', ?, ?, 1, ?)`).run(`s-${runId}-${ts}`, runId, by, value, why, ts);
}
function rating(runId: string, value: number, note: string | null, ts: string): void {
  db.prepare(`INSERT INTO ratings (id, run_id, step_id, value, note, ts) VALUES (?, ?, 'main', ?, ?, ?)`).run(`r-${runId}-${ts}`, runId, value, note, ts);
}

const AGENTS = ['companion', 'weaver', 'researcher', 'echo'];
function summary(id: string): AgentSummary {
  return { id, name: id[0]!.toUpperCase() + id.slice(1), description: '', version: 'sha256:x', modelPolicy: { primary: 'role:fast', fallbacks: [], now: [] }, tools: [], outputKind: 'text', review: 'none',
    spend: { todayUsd: 0, thisMonthUsd: 0, dailyCapUsd: id === 'companion' ? 5 : null, monthlyCapUsd: id === 'companion' ? 40 : null } };
}
function deps(): FleetDeps {
  const workspace = { agents: new Map(AGENTS.map((id) => [id, { definition: { id, name: summary(id).name } }])) } as unknown as Workspace;
  return {
    db, workspace: () => workspace, now: () => NOW,
    summaries: new Map(AGENTS.map((id) => [id, summary(id)])),
    runDetail: (id) => {
      const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as { id: string; state: string; agent_id: string; started_at: string; finished_at: string | null; spent_json: string } | undefined;
      if (!row) return null;
      return { id: row.id, kind: 'agent', state: row.state, agentId: row.agent_id, startedAt: row.started_at, ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
        spent: JSON.parse(row.spent_json), budgets: {}, inputs: {}, steps: [] } as unknown as RunDetail;
    },
    events: () => [],
    reviews: [], approvals: [], decisions: [],
  };
}

beforeEach(() => { db = open(); });

describe('the fleet report', () => {
  it('counts each agent\'s window from its own runs and its steps inside workflows, and nothing of anyone else\'s', () => {
    // The weaver: three runs this week (two done, one failed), one last month; a step inside a workflow run.
    run('w1', 'weaver', 'completed', at(1), 0.30, 3);
    run('w2', 'weaver', 'completed', at(2), 0.20, 2);
    run('w3', 'weaver', 'failed', at(3), 0.05, 1);
    run('w-old', 'weaver', 'completed', at(40), 9.99, 50);
    run('wf1', null, 'completed', at(1), 0.50, 5, { kind: 'workflow', workflow: 'story-pipeline' });
    step('wf1', 'draft', 'weaver', 'completed', 0.40);
    step('wf1', 'cut', 'echo', 'completed', 0.10);
    call('m1', 'w1', 'main', 1000, 200, at(1));
    call('m2', 'w2', 'main', 500, 100, at(2));
    call('m3', 'wf1', 'draft', 2000, 400, at(1));
    call('m4', 'wf1', 'cut', 10, 5, at(1));
    call('m-old', 'w-old', 'main', 99_999, 99_999, at(40));
    // The researcher is running right now.
    run('r1', 'researcher', 'running', at(0), 0.01, 1, { finished: null });

    const report = fleetReport(deps());
    const weaver = report.agents.find((a) => a.agent.id === 'weaver')!;
    expect(weaver.window).toEqual({ runs: 3, steps: 1, completed: 2, failed: 1, running: 0, costUsd: 0.95, modelCalls: 6, tokensIn: 3500, tokensOut: 700 });
    expect(weaver.latest).toMatchObject({ runId: 'w1', state: 'completed', costUsd: 0.30 });
    expect(weaver.latest!.summary[0], 'the run page\'s headline, by name').toMatch(/^Weaver/);
    expect(weaver.state).toBe('idle');
    const echo = report.agents.find((a) => a.agent.id === 'echo')!;
    expect(echo.window).toMatchObject({ runs: 0, steps: 1, costUsd: 0.10, tokensIn: 10, tokensOut: 5 });
    expect(echo.latest, 'no run of its own, only a step').toBeNull();
    expect(echo.state, 'it has done something, once').toBe('idle');
    const researcher = report.agents.find((a) => a.agent.id === 'researcher')!;
    expect(researcher.state).toBe('running');
    expect(researcher.window.running).toBe(1);
    expect(report.orchestrator!.agent.id).toBe('companion');
    expect(report.orchestrator!.state, 'never ran').toBe('never');
    expect(report.agents.map((a) => a.agent.id), 'busiest first, then by name').toEqual(['weaver', 'echo', 'researcher']);
    expect(report.since).toBe(at(7));
  });

  it('keeps the orchestrator\'s estimates and the owner\'s ratings as two numbers, each with its last word', () => {
    run('w1', 'weaver', 'completed', at(1), 0.1, 1);
    run('w2', 'weaver', 'completed', at(2), 0.1, 1);
    run('w3', 'weaver', 'completed', at(3), 0.1, 1);
    score('w1', 4, 'Tight, one flat beat.', at(1, 1));
    score('w2', 2, 'Lost the premise by the middle.', at(2, 1));
    // A judge's score on the same run is not the orchestrator's, and is not counted as its estimate.
    score('w3', 5, 'judge says fine', at(3, 1), 'judge');
    rating('w1', 5, 'Loved it.', at(1, 2));
    rating('w3', 3, null, at(3, 2));

    const weaver = fleetReport(deps()).agents.find((a) => a.agent.id === 'weaver')!;
    expect(weaver.ratings.orchestrator).toEqual({ count: 2, mean: 3, latestWhy: 'Tight, one flat beat.', latestAt: at(1, 1) });
    expect(weaver.ratings.owner).toEqual({ count: 2, mean: 4, latestWhy: 'Loved it.', latestAt: at(1, 2) });
    const echo = fleetReport(deps()).agents.find((a) => a.agent.id === 'echo')!;
    expect(echo.ratings.orchestrator).toEqual({ count: 0, mean: null, latestWhy: null, latestAt: null });
  });

  it('says whose run waits on a person, and that a failed last run is a failed card', () => {
    run('w1', 'weaver', 'failed', at(1), 0.1, 1);
    run('r1', 'researcher', 'waiting_review', at(1), 0.1, 1, { finished: null });
    run('e1', 'echo', 'waiting_approval', at(1), 0.1, 1, { finished: null });
    const d = deps();
    d.reviews = [{ runId: 'r1', blocking: true }];
    d.approvals = [{ runId: 'e1' }];
    d.decisions = [{ runId: 'w1' }, { runId: null }];
    const report = fleetReport(d);
    const by = (id: string) => report.agents.find((a) => a.agent.id === id)!;
    expect(by('researcher')).toMatchObject({ state: 'waiting', needsYou: { reviews: 1, approvals: 0, decisions: 0 } });
    expect(by('echo')).toMatchObject({ state: 'waiting', needsYou: { reviews: 0, approvals: 1, decisions: 0 } });
    // A decision it asked counts as waiting; so does a failed last run once nothing waits.
    expect(by('weaver')).toMatchObject({ state: 'waiting', needsYou: { decisions: 1 } });
    d.decisions = [];
    expect(fleetReport(d).agents.find((a) => a.agent.id === 'weaver')!.state).toBe('failed');
  });

  it('honours the window it is given', () => {
    run('w1', 'weaver', 'completed', at(1), 0.1, 1);
    run('w2', 'weaver', 'completed', at(10), 0.2, 2);
    const wide = fleetReport(deps(), { since: at(30) }).agents.find((a) => a.agent.id === 'weaver')!;
    expect(wide.window.runs).toBe(2);
    expect(wide.window.costUsd).toBeCloseTo(0.3, 6);
    const narrow = fleetReport(deps(), { since: at(2) }).agents.find((a) => a.agent.id === 'weaver')!;
    expect(narrow.window.runs).toBe(1);
  });
});
