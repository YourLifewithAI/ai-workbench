// The fleet report (D-79): what a card says, counted from planted rows and checked against a hand count.
// Counting is grouped by agent in SQL; the only event replay is the latest run's summary line; no model call.
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fleetReport, normalizeSince, type FleetDeps } from '../../src/runtime/orchestrator/fleet.js';
import { threadActivity } from '../../src/runtime/conversations/activity.js';
import type { AgentSummary, RunDetail } from '../../src/shared/api/index.js';
import type { Db } from '../../src/runtime/db/index.js';
import type { Workspace } from '../../src/runtime/workspace/loader.js';

let db: Db;
const NOW = new Date('2026-09-29T12:00:00Z');
const at = (daysAgo: number, hour = 0): string => new Date(NOW.getTime() - daysAgo * 86_400_000 + hour * 3_600_000).toISOString();

/** In memory and in one transaction: a file-backed database committing fifteen migrations to disk one by one is what timed the hook out on Windows. */
function open(): Db {
  const database = new Database(':memory:');
  const migrations = path.join(process.cwd(), 'src', 'runtime', 'db', 'migrations');
  database.exec('BEGIN');
  for (const file of fs.readdirSync(migrations).sort()) database.exec(fs.readFileSync(path.join(migrations, file), 'utf8'));
  database.exec('COMMIT');
  return database as unknown as Db;
}

function run(id: string, agent: string | null, state: string, started: string, cost: number, calls: number, opts: { kind?: string; workflow?: string; finished?: string | null; parent?: string } = {}): void {
  db.prepare(`INSERT INTO runs (id, kind, state, agent_id, workflow_id, parent_run_id, depth, inputs_json, outputs_json, budgets_json, spent_json, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, '{}', '{"output":"done"}', '{}', ?, ?, ?)`)
    .run(id, opts.kind ?? 'agent', state, agent, opts.workflow ?? null, opts.parent ?? null, JSON.stringify({ costUsd: cost, modelCalls: calls, toolCalls: 0, wallClockMs: 1000 }), started, opts.finished === undefined ? started : opts.finished);
}
function call(id: string, runId: string, step: string, tin: number, tout: number, ts: string, cost = 0.01): void {
  db.prepare(`INSERT INTO model_calls (id, run_id, step_id, model_id, adapter, prompt_version, agent_version, usage_json, cost_usd, latency_ms, finish_reason, ts)
    VALUES (?, ?, ?, 'anthropic/claude-sonnet-5', 'anthropic', 'p', 'a', ?, ?, 1, 'stop', ?)`).run(id, runId, step, JSON.stringify({ input: tin, output: tout }), cost, ts);
}
/** A step row as the workflow runner leaves it: seeded `pending`, stamped `started_at` only once it runs. */
function step(runId: string, stepId: string, agent: string, state: string, cost = 0, started: string | null | undefined = undefined): void {
  const startedAt = started !== undefined ? started : state === 'pending' || state === 'cancelled' ? null : at(1);
  db.prepare(`INSERT INTO run_steps (run_id, step_id, kind, state, agent_id, cost_usd, started_at) VALUES (?, ?, 'agent', ?, ?, ?, ?)`).run(runId, stepId, state, agent, cost, startedAt);
}
let seq = 0;
function score(runId: string, value: number, why: string, ts: string, by = 'orchestrator', metric = 'rating'): void {
  db.prepare(`INSERT INTO scores (id, run_id, evaluator_id, metric, value, rationale, estimate, ts) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`).run(`s-${++seq}`, runId, by, metric, value, why, ts);
}
function rating(runId: string, value: number, note: string | null, ts: string, stepId = 'main', compareId: string | null = null): void {
  db.prepare(`INSERT INTO ratings (id, run_id, step_id, value, note, compare_id, ts) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(`r-${++seq}`, runId, stepId, value, note, compareId, ts);
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
    call('m1', 'w1', 'main', 1000, 200, at(1), 0.30);
    call('m2', 'w2', 'main', 500, 100, at(2), 0.20);
    call('m3', 'wf1', 'draft', 2000, 400, at(1), 0.40);
    call('m4', 'wf1', 'cut', 10, 5, at(1), 0.10);
    call('m-old', 'w-old', 'main', 99_999, 99_999, at(40), 9.99);
    // The researcher is running right now.
    run('r1', 'researcher', 'running', at(0), 0.01, 1, { finished: null });

    const report = fleetReport(deps());
    const weaver = report.agents.find((a) => a.agent.id === 'weaver')!;
    expect(weaver.window).toEqual({ runs: 3, steps: 1, completed: 2, failed: 1, running: 0, costUsd: 0.9, modelCalls: 3, tokensIn: 3500, tokensOut: 700 });
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

  it('leaves a Compare pick out of the owner\'s numbers, and lets a re-rating replace the rating it follows', () => {
    run('w1', 'weaver', 'completed', at(3), 0.1, 1);
    run('w2', 'weaver', 'completed', at(3), 0.1, 1);
    run('e1', 'echo', 'completed', at(3), 0.1, 1);
    run('e2', 'echo', 'completed', at(3), 0.1, 1);
    rating('w1', 5, 'Loved it.', at(2));
    // A pick between the weaver's two runs, with its note on both rows: a preference, not a 5 and a 1.
    rating('w1', 5, 'first is warmer', at(1, 1), 'main', 'cmp1');
    rating('w2', 1, 'first is warmer', at(1, 1), 'main', 'cmp1');
    // The echo has only ever been in a pick: it has no rating of its own.
    rating('e1', 5, 'this one', at(1), 'main', 'cmp2');
    rating('e2', 1, 'this one', at(1), 'main', 'cmp2');

    let report = fleetReport(deps());
    const by = (id: string) => report.agents.find((a) => a.agent.id === id)!;
    expect(by('weaver').ratings.owner, 'the pick moved nothing').toEqual({ count: 1, mean: 5, latestWhy: 'Loved it.', latestAt: at(2) });
    expect(by('echo').ratings.owner).toEqual({ count: 0, mean: null, latestWhy: null, latestAt: null });

    // Re-rated: 2, then 4, on one run. It is one rating, the newer, and its note is the why.
    rating('w2', 2, 'flat', at(2, 1));
    rating('w2', 4, 'better on the second read', at(1, 2));
    report = fleetReport(deps());
    expect(by('weaver').ratings.owner).toEqual({ count: 2, mean: 4.5, latestWhy: 'better on the second read', latestAt: at(1, 2) });
    // The same for the orchestrator: its re-estimate of one thing replaces; a step of a workflow is another thing
    // (an agent run has the one step, however the estimate was named — that is the next test).
    score('w1', 2, 'first look', at(2, 2));
    score('w1', 4, 'second look', at(1, 3));
    run('wfx', null, 'completed', at(1), 0, 0, { kind: 'workflow', workflow: 'story-pipeline' });
    step('wfx', 'draft', 'weaver', 'completed', 0, at(1));
    score('wfx', 3, 'the draft step', at(1, 4), 'orchestrator', 'rating:draft');
    report = fleetReport(deps());
    expect(by('weaver').ratings.orchestrator).toEqual({ count: 2, mean: 3.5, latestWhy: 'the draft step', latestAt: at(1, 4) });
    // A judge's estimate on the same metric does not replace the orchestrator's.
    score('w1', 1, 'judge', at(0, -1), 'judge');
    expect(fleetReport(deps()).agents.find((a) => a.agent.id === 'weaver')!.ratings.orchestrator).toMatchObject({ count: 2, mean: 3.5 });
  });

  it('settles two ratings written in the same instant by which came last, whatever order they are read in', () => {
    run('w1', 'weaver', 'completed', at(1), 0.1, 1);
    run('w2', 'weaver', 'completed', at(1), 0.1, 1);
    run('e1', 'echo', 'completed', at(1), 0.1, 1);
    const same = at(1, 1);
    // Different runs, one timestamp: the second written is the latest.
    rating('w1', 2, 'written first', same);
    rating('w2', 5, 'written second', same);
    score('w1', 2, 'estimate first', same);
    score('w2', 4, 'estimate second', same);
    // One run and step re-rated inside the same millisecond: the second replaces the first, the count stays one.
    rating('e1', 5, 'echo, written first', same);
    rating('e1', 2, 'echo, written second', same);
    const report = fleetReport(deps());
    const by = (id: string) => report.agents.find((a) => a.agent.id === id)!;
    expect(by('weaver').ratings.owner).toEqual({ count: 2, mean: 3.5, latestWhy: 'written second', latestAt: same });
    expect(by('weaver').ratings.orchestrator).toEqual({ count: 2, mean: 3, latestWhy: 'estimate second', latestAt: same });
    expect(by('echo').ratings.owner, 'the last one written wins the tie').toEqual({ count: 1, mean: 2, latestWhy: 'echo, written second', latestAt: same });
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

  it('attributes a rating, an estimate and what waits on you through the step that was rated, because a workflow run has no agent', () => {
    // story-pipeline: the run belongs to nobody, its steps to the weaver and the echo.
    run('wf1', null, 'completed', at(1), 0, 0, { kind: 'workflow', workflow: 'story-pipeline' });
    step('wf1', 'draft', 'weaver', 'completed');
    step('wf1', 'cut', 'echo', 'completed');
    rating('wf1', 5, 'The drill scene.', at(1, 1), 'draft');
    score('wf1', 4, 'Tight, one flat beat.', at(1, 2), 'orchestrator', 'rating:draft');
    score('wf1', 2, 'Cut too hard.', at(1, 3), 'orchestrator', 'rating:cut');
    // A rating of the whole workflow run, or a step nobody ran, is nobody's card.
    score('wf1', 1, 'the whole run', at(1, 4));
    rating('wf1', 1, 'no such step', at(1, 5), 'ghost');
    const report = fleetReport(deps());
    const by = (id: string) => report.agents.find((a) => a.agent.id === id)!;
    expect(by('weaver').ratings.owner).toEqual({ count: 1, mean: 5, latestWhy: 'The drill scene.', latestAt: at(1, 1) });
    expect(by('weaver').ratings.orchestrator).toEqual({ count: 1, mean: 4, latestWhy: 'Tight, one flat beat.', latestAt: at(1, 2) });
    expect(by('echo').ratings.owner.count).toBe(0);
    expect(by('echo').ratings.orchestrator).toEqual({ count: 1, mean: 2, latestWhy: 'Cut too hard.', latestAt: at(1, 3) });

    // What waits: a review and an approval name their step; a workflow with two agents and no step is nobody's.
    const d = deps();
    d.reviews = [{ runId: 'wf1', stepId: 'draft', blocking: true }, { runId: 'wf1', blocking: true }, { runId: 'wf1', stepId: 'draft', blocking: false }];
    d.approvals = [{ runId: 'wf1', stepId: 'cut' }, { runId: 'wf1' }];
    let waiting = fleetReport(d);
    expect(waiting.agents.find((a) => a.agent.id === 'weaver')).toMatchObject({ state: 'waiting', needsYou: { reviews: 1, approvals: 0, decisions: 0 } });
    expect(waiting.agents.find((a) => a.agent.id === 'echo')).toMatchObject({ state: 'waiting', needsYou: { reviews: 0, approvals: 1, decisions: 0 } });
    expect(waiting.orchestrator!.needsYou, 'the two-agent workflow\'s stepless review and approval are nobody\'s').toEqual({ reviews: 0, approvals: 0, decisions: 0 });

    // The pulse: every step is the companion's, so its decision lands on the companion, and the card says waiting.
    run('pulse1', null, 'completed', at(0), 0, 0, { kind: 'workflow', workflow: 'companion-pulse' });
    step('pulse1', 'sense', 'companion', 'completed');
    step('pulse1', 'decide', 'companion', 'completed');
    d.reviews = [{ runId: 'pulse1', blocking: true }];
    d.approvals = [{ runId: 'pulse1' }];
    d.decisions = [{ runId: 'pulse1' }];
    waiting = fleetReport(d);
    expect(waiting.orchestrator).toMatchObject({ state: 'waiting', needsYou: { reviews: 1, approvals: 1, decisions: 1 } });
    // A run's own agent beats everything: an agent run with a stray step id is still that agent's.
    run('w1', 'weaver', 'waiting_review', at(1), 0, 0, { finished: null });
    d.reviews = [{ runId: 'w1', stepId: 'nope', blocking: true }];
    d.approvals = [];
    d.decisions = [];
    expect(fleetReport(d).agents.find((a) => a.agent.id === 'weaver')!.needsYou.reviews).toBe(1);
  });

  it('counts only the steps that started: a workflow that never got to an agent leaves it at never, and a step that failed is a failure', () => {
    // A workflow live right now: the architect is running, the weaver's and the echo's steps are seeded and waiting.
    run('wf1', null, 'running', at(0), 0, 0, { kind: 'workflow', workflow: 'story-pipeline', finished: null });
    step('wf1', 'plan', 'researcher', 'running');
    step('wf1', 'draft', 'weaver', 'pending');
    // One that failed on its first step: the later steps were cancelled without ever starting.
    run('wf2', null, 'failed', at(1), 0, 0, { kind: 'workflow', workflow: 'story-pipeline' });
    step('wf2', 'plan', 'researcher', 'failed');
    step('wf2', 'draft', 'weaver', 'cancelled');
    step('wf2', 'cut', 'echo', 'cancelled');
    // And a step that started and ended in failure for the echo, in a third.
    run('wf3', null, 'failed', at(2), 0, 0, { kind: 'workflow', workflow: 'story-pipeline' });
    step('wf3', 'cut', 'echo', 'completed');
    step('wf3', 'cut2', 'echo', 'failed');

    const report = fleetReport(deps());
    const by = (id: string) => report.agents.find((a) => a.agent.id === id)!;
    expect(by('weaver').window).toMatchObject({ steps: 0, running: 0, failed: 0 });
    expect(by('weaver').state, 'a step that never ran is not something it did').toBe('never');
    expect(by('researcher').window).toMatchObject({ steps: 2, running: 1, failed: 1 });
    expect(by('researcher').state).toBe('running');
    expect(by('echo').window).toMatchObject({ steps: 2, failed: 1 });
    expect(by('echo').state).toBe('idle');
    expect(report.agents.map((a) => a.agent.id), 'ranked by what they did, not by what was seeded for them').toEqual(['echo', 'researcher', 'weaver']);
  });

  it('takes cost, calls and tokens from the same model calls, so a parent\'s card is not charged for its child, nor for a budget it only reserved', () => {
    // A: the companion's run waited for a child. Its spent_json (0.03, three calls) has the child's 0.01 inside it;
    // its own calls are two at 0.01 each.
    run('A-parent', 'companion', 'completed', at(1), 0.03, 3);
    run('A-child', 'echo', 'completed', at(1), 0.01, 1);
    db.prepare('UPDATE runs SET parent_run_id = ? WHERE id = ?').run('A-parent', 'A-child');
    call('a1', 'A-parent', 'agent', 1000, 100, at(1));
    call('a2', 'A-parent', 'agent', 1000, 100, at(1));
    call('a3', 'A-child', 'agent', 500, 50, at(1));
    // B: a detached child. The researcher's spent_json (0.51, six calls) carries the 0.50 it reserved for it; it made
    // one call of its own, and the weaver's child made one.
    run('B-parent', 'researcher', 'completed', at(1), 0.51, 6);
    run('B-child', 'weaver', 'completed', at(1), 0.02, 1);
    db.prepare('UPDATE runs SET parent_run_id = ? WHERE id = ?').run('B-parent', 'B-child');
    call('b1', 'B-parent', 'agent', 1000, 100, at(1), 0.01);
    call('b2', 'B-child', 'agent', 800, 80, at(1), 0.02);
    // C: a run that began eight days ago and made a call today. The window is about what was spent in it.
    run('C-old', 'echo', 'completed', at(8), 0.04, 1);
    call('c1', 'C-old', 'agent', 2000, 200, at(0, -1), 0.04);

    const report = fleetReport(deps());
    const by = (id: string) => [report.orchestrator!, ...report.agents].find((a) => a.agent.id === id)!;
    expect(by('companion').window).toMatchObject({ runs: 1, costUsd: 0.02, modelCalls: 2, tokensIn: 2000, tokensOut: 200 });
    expect(by('echo').window).toMatchObject({ runs: 1, costUsd: 0.05, modelCalls: 2, tokensIn: 2500, tokensOut: 250 });
    expect(by('researcher').window).toMatchObject({ costUsd: 0.01, modelCalls: 1, tokensIn: 1000 });
    expect(by('weaver').window).toMatchObject({ costUsd: 0.02, modelCalls: 1, tokensIn: 800 });
    const total = [report.orchestrator!, ...report.agents].reduce((n, a) => n + a.window.costUsd, 0);
    const truth = (db.prepare('SELECT SUM(cost_usd) AS c FROM model_calls').get() as { c: number }).c;
    expect(total, 'the cards add up to what the model calls cost').toBeCloseTo(truth, 6);
    // The old spent_json is still what the run's own line says.
    expect(by('companion').latest).toMatchObject({ runId: 'A-parent', costUsd: 0.03 });
    // The same calls, a window that begins after the first three: the numbers move together.
    const narrow = fleetReport(deps(), { since: at(0, -6) }).agents.find((a) => a.agent.id === 'echo')!;
    expect(narrow.window).toMatchObject({ runs: 0, costUsd: 0.04, modelCalls: 1, tokensIn: 2000 });
  });

  it('reads a since in any way a date can be written, and compares it as time, not as text', () => {
    const times = ['2026-09-26T12:00:00.000Z', '2026-09-27T12:00:00.000Z', '2026-09-28T10:00:00.000Z', '2026-09-28T12:00:00.000Z', '2026-09-28T13:00:00.000Z', '2026-09-29T09:00:00.000Z'];
    times.forEach((t, i) => { run(`w${i}`, 'weaver', 'completed', t, 0.01, 1); call(`m${i}`, `w${i}`, 'agent', 100, 10, t); });
    const runs = (raw: string): { runs: number; tokens: number; since: string } => {
      const since = normalizeSince(raw);
      expect(since, raw).not.toBeNull();
      const report = fleetReport(deps(), { since: since! });
      const w = report.agents.find((a) => a.agent.id === 'weaver')!.window;
      return { runs: w.runs, tokens: w.tokensIn / 100, since: report.since };
    };
    // The zone-free ones by hand, against the six planted times.
    expect(runs('2026-09-28T12:00:00.000Z').runs).toBe(3);
    expect(runs('2026-09-28T12:00:00Z'), 'no milliseconds: a run at the boundary is inside').toMatchObject({ runs: 3, since: '2026-09-28T12:00:00.000Z' });
    expect(runs('2026-09-28T14:00:00+02:00'), 'an offset is the same instant').toMatchObject({ runs: 3, since: '2026-09-28T12:00:00.000Z' });
    expect(runs('Mon, 28 Sep 2026 12:00:00 GMT').runs).toBe(3);
    expect(runs('2026-09-28').runs).toBe(4);
    expect(runs('2027-12-01'), 'far in the future: nothing, and the tokens agree').toMatchObject({ runs: 0, tokens: 0 });
    expect(runs('12/01/2099').runs).toBe(0);
    expect(runs('+010000-01-01T00:00:00Z'), 'a year the text order cannot hold').toMatchObject({ runs: 0, tokens: 0, since: '9999-12-31T23:59:59.999Z' });
    expect(runs('-000100-01-01T00:00:00Z'), 'nor a year before the tables began').toMatchObject({ runs: 6, tokens: 6, since: '0000-01-01T00:00:00.000Z' });
    // Written without a zone, "Sep 27 2026" is the server's own midnight: whatever that is, it is that instant.
    const local = Date.parse('Sep 27 2026');
    expect(runs('Sep 27 2026')).toMatchObject({ runs: times.filter((t) => Date.parse(t) >= local).length, since: new Date(local).toISOString() });
    expect(normalizeSince(''), 'empty is not a date').toBeNull();
    expect(normalizeSince('yesterday')).toBeNull();
  });

  it('honours the window it is given', () => {
    run('w1', 'weaver', 'completed', at(1), 0.1, 1);
    run('w2', 'weaver', 'completed', at(10), 0.2, 2);
    call('w1-m', 'w1', 'main', 10, 1, at(1), 0.1);
    call('w2-m', 'w2', 'main', 10, 1, at(10), 0.2);
    const wide = fleetReport(deps(), { since: at(30) }).agents.find((a) => a.agent.id === 'weaver')!;
    expect(wide.window.runs).toBe(2);
    expect(wide.window.costUsd).toBeCloseTo(0.3, 6);
    const narrow = fleetReport(deps(), { since: at(2) }).agents.find((a) => a.agent.id === 'weaver')!;
    expect(narrow.window.runs).toBe(1);
  });
});

describe('the thread header\'s counts', () => {
  it('counts a run once: a child the parent waited for is inside the parent, in what happened and in what it cost', () => {
    run('p', 'companion', 'completed', at(1), 0.03, 3);
    run('c', 'echo', 'completed', at(1), 0.01, 1, { parent: 'p' });
    call('p1', 'p', 'agent', 1, 1, at(1));
    call('p2', 'p', 'agent', 1, 1, at(1));
    call('c1', 'c', 'agent', 1, 1, at(1));
    // The parent's spent_json says 0.03 with the child inside it; the header must say 0.03, not 0.04.
    expect(threadActivity(db, null)).toEqual({ finished: 1, failed: 0, running: 0, spentUsd: 0.03 });
    expect(threadActivity(db, at(2))).toEqual({ finished: 1, failed: 0, running: 0, spentUsd: 0.03 });
    expect(threadActivity(db, at(0)), 'nothing since').toEqual({ finished: 0, failed: 0, running: 0, spentUsd: 0 });
  });

  it('is not capped: more than two hundred runs are all counted, with their money', () => {
    const plant = db.transaction(() => {
      for (let i = 0; i < 250; i++) {
        const t = new Date(NOW.getTime() - (250 - i) * 1000).toISOString();
        run(`bulk-${i}`, 'weaver', i % 10 === 0 ? 'failed' : 'completed', t, 0.01, 1, { finished: t });
        call(`bulk-m${i}`, `bulk-${i}`, 'agent', 1, 1, t, 0.01);
      }
    });
    plant();
    expect(threadActivity(db, null)).toEqual({ finished: 225, failed: 25, running: 0, spentUsd: 2.5 });
    // Since the 101st run: the last hundred and fifty, by the times they finished.
    const since = new Date(NOW.getTime() - 150 * 1000).toISOString();
    const late = threadActivity(db, since);
    expect(late.finished + late.failed, 'strictly after: the run at the boundary is before it').toBe(149);
    expect(late.spentUsd).toBe(1.49);
  });

  it('counts a run waiting on an approval as running, with the ones that queue, run and wait on a review, and leaves a child out', () => {
    run('q', 'weaver', 'queued', at(0), 0, 0, { finished: null });
    run('r', 'weaver', 'running', at(0), 0, 0, { finished: null });
    run('wr', 'weaver', 'waiting_review', at(0), 0, 0, { finished: null });
    run('wa', 'weaver', 'waiting_approval', at(0), 0, 0, { finished: null });
    run('done', 'weaver', 'completed', at(0), 0, 0);
    run('cancelled', 'weaver', 'cancelled', at(0), 0, 0);
    run('kid', 'echo', 'running', at(0), 0, 0, { finished: null, parent: 'r' });
    // Still running is still running, whatever the window: it is not a thing that happened at a time.
    expect(threadActivity(db, null).running).toBe(4);
    expect(threadActivity(db, at(-1)).running).toBe(4);
  });

  it('counts what a running run has spent so far the same way whether the window is open or bounded', () => {
    run('live', 'weaver', 'running', at(1), 0.5, 3, { finished: null });
    call('l1', 'live', 'agent', 1, 1, at(1), 0.20);
    call('l2', 'live', 'agent', 1, 1, at(0, -1), 0.30);
    run('old', 'weaver', 'completed', at(3), 0.1, 1, { finished: at(3) });
    call('o1', 'old', 'agent', 1, 1, at(3), 0.10);
    // Money is what the calls cost after `since`, from whichever run: a call is a call before its run is over.
    expect(threadActivity(db, null)).toEqual({ finished: 1, failed: 0, running: 1, spentUsd: 0.6 });
    expect(threadActivity(db, at(2))).toEqual({ finished: 0, failed: 0, running: 1, spentUsd: 0.5 });
    expect(threadActivity(db, at(0, -2)).spentUsd, 'only the call after the read').toBe(0.3);
    // And an interrupted run is a failure, counted at its own time.
    run('cut', 'weaver', 'interrupted', at(1), 0, 0, { finished: at(1) });
    expect(threadActivity(db, at(2)).failed).toBe(1);
    expect(threadActivity(db, at(0, -2)).failed).toBe(0);
  });
});

describe('after the cross-check', () => {
  it('counts a child that outlived its parent — a let-go run failing overnight is news — and not one the parent waited for', () => {
    run('p', 'companion', 'completed', at(1, 0), 0.1, 1, { finished: at(1, 1) });
    run('waited', 'weaver', 'completed', at(1, 0.2), 0.1, 1, { parent: 'p', finished: at(1, 0.8) });
    run('gone', 'researcher', 'failed', at(1, 0.5), 0.1, 1, { parent: 'p', finished: at(1, 5) });
    run('still', 'researcher', 'running', at(1, 0.6), 0.1, 1, { parent: 'p', finished: null });
    // Everything: the parent, and the two children that were still going when it ended.
    expect(threadActivity(db, null)).toMatchObject({ finished: 1, failed: 1, running: 1 });
    // Since after the parent's own end: only what happened to the ones it let go.
    expect(threadActivity(db, at(1, 2))).toMatchObject({ finished: 0, failed: 1, running: 1 });
  });

  it('counts an agent run once however its rating was named, and a step of it as the same run', () => {
    run('w1', 'weaver', 'completed', at(1), 0.1, 1);
    db.prepare(`INSERT INTO scores (id, run_id, evaluator_id, metric, value, rationale, estimate, ts) VALUES ('s-a', 'w1', 'orchestrator', 'rating', 4, 'first', 1, ?), ('s-b', 'w1', 'orchestrator', 'rating:main', 2, 'second', 1, ?)`).run(at(1, 1), at(1, 2));
    db.prepare(`INSERT INTO ratings (id, run_id, step_id, value, note, ts) VALUES ('r-a', 'w1', 'main', 5, 'a', ?), ('r-b', 'w1', 'other', 3, 'b', ?)`).run(at(1, 1), at(1, 2));
    const weaver = fleetReport(deps()).agents.find((a) => a.agent.id === 'weaver')!;
    expect(weaver.ratings.orchestrator).toMatchObject({ count: 1, mean: 2, latestWhy: 'second' });
    expect(weaver.ratings.owner).toMatchObject({ count: 1, mean: 3, latestWhy: 'b' });
  });

  it('reads a workflow step parked on an approval as waiting on you, not as running', () => {
    run('wf', null, 'waiting_approval', at(1), 0, 0, { kind: 'workflow', workflow: 'story-pipeline', finished: null });
    step('wf', 'draft', 'weaver', 'running', 0, at(1));
    const d = deps();
    d.approvals = [{ runId: 'wf', stepId: 'draft' }];
    const weaver = fleetReport(d).agents.find((a) => a.agent.id === 'weaver')!;
    expect(weaver.needsYou.approvals).toBe(1);
    expect(weaver.window.running).toBe(0);
    expect(weaver.state).toBe('waiting');
  });
});
