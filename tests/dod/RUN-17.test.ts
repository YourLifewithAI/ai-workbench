// RUN-17 Definition of done (spec/runs/RUN-17.md). The run protocol, executed by a workbench agent against a
// fixture repository with a bare remote: a brief in, a pushed branch and a handoff out, a person in the loop.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { CLI_DIST, startRuntime, tempWorkspace, waitFor, type Started } from '../helpers/workspace.js';
import { ALL_REPO_TOOLS, HANDOFF_UNMET, IMPLEMENT_GREEN, MECHANIC, git, grant, hasRef, protocolRepo, protocolScripts, script } from '../helpers/repo.js';
import type { EventRecord } from '../../src/shared/events.js';
import type { ReviewItem, RunDetail, WorkflowDetail } from '../../src/shared/api/index.js';

beforeAll(() => {
  if (!fs.existsSync(CLI_DIST)) throw new Error('dist/cli.js is missing: run `npm run build` (or `npm run dod -- 17`, which builds first).');
});

const headers = (rt: Started): Record<string, string> => ({ Authorization: `Bearer ${rt.token}`, 'Content-Type': 'application/json' });

const traceOf = async (rt: Started, runId: string): Promise<EventRecord[]> =>
  (await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}/trace.jsonl`, { headers: headers(rt) })).text())
    .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as EventRecord);
const detailOf = async (rt: Started, runId: string): Promise<RunDetail> =>
  (await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}`, { headers: headers(rt) })).json()) as RunDetail;
const reviewsOf = async (rt: Started): Promise<ReviewItem[]> =>
  ((await (await fetch(`${rt.baseUrl}/api/v1/reviews`, { headers: headers(rt) })).json()) as { reviews: ReviewItem[] }).reviews;

async function startCodingRun(rt: Started, root: string): Promise<string> {
  const res = await fetch(`${rt.baseUrl}/api/v1/runs`, {
    method: 'POST', headers: headers(rt), body: JSON.stringify({ kind: 'workflow', id: 'coding-run', inputs: { brief: 'spec/runs/RUN-99.md', repo: root } }),
  });
  const text = await res.text();
  expect(res.status, text).toBe(202);
  return (JSON.parse(text) as { runId: string }).runId;
}

function setImplementBudget(ws: string, budget: Record<string, number>): void {
  const file = path.join(ws, 'workflows', 'coding-run.workflow.json');
  const workflow = JSON.parse(fs.readFileSync(file, 'utf8')) as { steps: { id: string; budget?: Record<string, number> }[] };
  workflow.steps.find((s) => s.id === 'implement')!.budget = budget;
  fs.writeFileSync(file, JSON.stringify(workflow, null, 2));
}

describe('DoD 1: the coding run on a gate that fails once and passes after the edit', () => {
  it('produces a plan, a branch, two commits, a pushed branch, a handoff with the real check output, and a parked review naming the branch', async () => {
    const ws = tempWorkspace('dod17-1');
    const { root, remote } = protocolRepo('dod17-1');
    grant(ws, 'mechanic', { tools: ALL_REPO_TOOLS, repos: [{ path: root, branches: 'run/*' }] });
    protocolScripts(ws);
    script(ws, MECHANIC, 'IMPLEMENT', IMPLEMENT_GREEN);

    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true });
    try {
      const runId = await startCodingRun(rt, root);
      await waitFor(async () => ['waiting_review', 'failed', 'completed'].includes((await detailOf(rt, runId)).state), 120_000);
      const detail = await detailOf(rt, runId);
      const trace = await traceOf(rt, runId);
      expect(detail.state, JSON.stringify(detail.error) + JSON.stringify(trace.filter((e) => e.type === 'step-failed'))).toBe('waiting_review');

      // The plan is a document in the coding project.
      const documents = (await (await fetch(`${rt.baseUrl}/api/v1/projects/coding/documents`, { headers: headers(rt) })).json()) as { documents: { path: string }[] };
      expect(documents.documents.map((d) => d.path)).toEqual(expect.arrayContaining([`${runId}/plan.json`, `${runId}/RUN-99.md`]));

      // The branch, with two commits of the agent's on top of the fixture, pushed to the bare remote.
      expect(git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('run/99-fixture');
      const log = git(root, 'log', '--format=%an|%s', 'main..run/99-fixture').split('\n');
      expect(log).toEqual(['mechanic|RUN-99 handoff and STATUS', 'mechanic|Fix the app state']);
      expect(hasRef(remote, 'refs/heads/run/99-fixture')).toBe(true);
      expect(git(remote, 'rev-parse', 'refs/heads/run/99-fixture')).toBe(git(root, 'rev-parse', 'HEAD'));
      expect(hasRef(remote, 'refs/heads/main'), 'main was never pushed').toBe(false);

      // The handoff in the repository holds the gate's own words, put there by the workflow, not by the model.
      const handoff = fs.readFileSync(path.join(root, 'runlog', 'RUN-99.md'), 'utf8');
      expect(handoff).toContain('# RUN-99 handoff');
      expect(handoff).toContain('## Verification transcript (recorded by the workflow)');
      expect(handoff).toContain('PASS: app is fixed');
      expect(handoff).toContain('ok: true · exit 0');
      expect(fs.readFileSync(path.join(root, 'STATUS.md'), 'utf8')).toContain('RUN-99: awaiting verification');
      // And the brief is untouched (DoD 4).
      expect(fs.readFileSync(path.join(root, 'spec', 'runs', 'RUN-99.md'), 'utf8')).toContain('# RUN-99 — Fix the state');
      const refused = trace.filter((e) => e.type === 'repo-decided' && e.payload['allowed'] === false);
      expect(refused.some((e) => String(e.payload['reason']).includes('spec/runs'))).toBe(true);
      const denied = trace.find((e) => e.type === 'tool-completed' && e.payload['tool'] === 'repo.write' && e.payload['ok'] === false)!;
      expect((denied.payload['error'] as { code: string; message: string }).message).toContain('spec/runs/');

      // The parked review names the branch.
      const parked = (await reviewsOf(rt)).find((r) => r.blocking && r.runId === runId)!;
      expect(parked.stepId).toBe('hand-to-human');
      expect(parked.output).toContain('Branch: run/99-fixture');
      expect(trace.some((e) => e.type === 'review-requested')).toBe(true);
    } finally {
      await rt.stop();
    }
  }, 240_000);
});

describe('DoD 2: a gate that never passes ends within budget, with a wrap-up commit and an honest handoff', () => {
  it('parks at the same review rather than failing', async () => {
    const ws = tempWorkspace('dod17-2');
    const { root, remote } = protocolRepo('dod17-2', 'console.log("checking"); console.error("FAIL: never"); process.exit(1);');
    grant(ws, 'mechanic', { tools: ALL_REPO_TOOLS, repos: [{ path: root, branches: 'run/*' }] });
    protocolScripts(ws, HANDOFF_UNMET);
    // Six calls: five productive, the sixth the wrap-up. The scripted agent would check forever otherwise.
    setImplementBudget(ws, { maxModelCalls: 6, maxToolCalls: 40 });
    script(ws, MECHANIC, 'IMPLEMENT', [
      { when: 'Implement the brief', text: 'Branching.', calls: [{ name: 'git.branch', input: { name: 'run/99-fixture' } }] },
      { when: 'Implement the brief', after: 'git.branch', text: 'Trying.', calls: [{ name: 'repo.write', input: { path: 'src/app.js', content: 'export const state = "an attempt";\n' } }] },
      { when: 'Implement the brief', after: 'repo.write', text: 'Checking again.', calls: [{ name: 'check', input: {} }] },
      // The wrap-up turn announces itself in the system prompt; this is the only fixture that matches it.
      { system: 'This is your last turn', text: 'Out of budget. Not met: 1, 2. The state is not fixed and the gate fails.' },
    ]);

    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true });
    try {
      const runId = await startCodingRun(rt, root);
      await waitFor(async () => ['waiting_review', 'failed', 'completed'].includes((await detailOf(rt, runId)).state), 120_000);
      const detail = await detailOf(rt, runId);
      const trace = await traceOf(rt, runId);
      expect(detail.state, JSON.stringify(detail.error)).toBe('waiting_review');

      // The step ended on its own budget, with its wrap-up as a partial output, and the workflow went on.
      const implemented = trace.find((e) => e.type === 'step-completed' && e.payload['stepId'] === 'implement')!;
      const lifecycle = JSON.stringify(trace.filter((e) => ['step-completed', 'step-failed', 'budget-warning', 'model-started'].includes(e.type)).map((e) => ({ type: e.type, step: e.stepId, partial: e.payload['partial'], budget: e.payload['budget'], wrapUp: e.payload['wrapUp'], tools: (e.payload['request'] as { tools?: unknown[] } | undefined)?.tools?.length })));
      expect(implemented.payload['partial'], lifecycle).toBe(true);
      expect(String(implemented.payload['output'])).toContain('Not met: 1, 2');
      // One warning per budget (D-14): the 80% warning fired at call five, so the wrap-up does not repeat it.
      expect(trace.some((e) => e.type === 'budget-warning' && e.stepId === 'implement' && e.payload['budget'] === 'maxModelCalls')).toBe(true);
      expect(trace.filter((e) => e.type === 'tool-completed' && e.payload['tool'] === 'check').length).toBeGreaterThanOrEqual(3);
      expect(trace.some((e) => e.type === 'step-failed')).toBe(false);

      // One commit — the wrap-up commit made by the workflow — carrying the attempt, the handoff and STATUS.
      const log = git(root, 'log', '--format=%s', 'main..run/99-fixture').split('\n');
      expect(log).toEqual(['RUN-99 handoff and STATUS']);
      expect(git(root, 'show', '--stat', '--format=', 'HEAD')).toMatch(/src\/app\.js/);
      expect(hasRef(remote, 'refs/heads/run/99-fixture')).toBe(true);
      const handoff = fs.readFileSync(path.join(root, 'runlog', 'RUN-99.md'), 'utf8');
      expect(handoff).toContain('## Known gaps\n- 1. the state is still not fixed\n- 2. check does not pass');
      expect(handoff).toContain('FAIL: never');
      expect(handoff).toContain('ok: false · exit 1');
      const parked = (await reviewsOf(rt)).find((r) => r.blocking && r.runId === runId)!;
      expect(parked.stepId).toBe('hand-to-human');
    } finally {
      await rt.stop();
    }
  }, 240_000);
});

describe('DoD 3: rejecting the review re-runs implement with the feedback; continuing completes the run', () => {
  it('carries the feedback into the task, re-pushes, parks again, and then finishes', async () => {
    const ws = tempWorkspace('dod17-3');
    const { root, remote } = protocolRepo('dod17-3');
    grant(ws, 'mechanic', { tools: ALL_REPO_TOOLS, repos: [{ path: root, branches: 'run/*' }] });
    protocolScripts(ws);
    script(ws, MECHANIC, 'IMPLEMENT', IMPLEMENT_GREEN);
    const feedback = 'Add a comment above the constant saying why it is fixed.';
    // Sorts before the plain implement script, and matches only a task carrying the feedback.
    script(ws, MECHANIC, 'AGAIN', [
      { when: feedback, text: 'Adding the comment.', calls: [{ name: 'repo.write', input: { path: 'src/app.js', content: '// fixed because the gate reads it\nexport const state = "fixed";\n' } }] },
      { when: feedback, after: 'repo.write', text: 'Committing the comment.', calls: [{ name: 'git.commit', input: { message: 'Explain the fixed state' } }] },
      { when: feedback, after: 'git.commit', text: 'Added the comment the reviewer asked for. Every item met.' },
    ], '0-');

    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true });
    try {
      const runId = await startCodingRun(rt, root);
      await waitFor(async () => (await detailOf(rt, runId)).state === 'waiting_review', 120_000);
      const first = (await reviewsOf(rt)).find((r) => r.blocking && r.runId === runId)!;
      expect(first.attempt).toBe(1);

      const rejected = await fetch(`${rt.baseUrl}/api/v1/reviews/${first.id}`, { method: 'POST', headers: headers(rt), body: JSON.stringify({ decision: 'reject', feedback }) });
      expect(rejected.status).toBe(202);
      await waitFor(async () => {
        const again = (await reviewsOf(rt)).find((r) => r.runId === runId && r.stepId === 'hand-to-human');
        return again?.blocking === true && again.attempt === 2;
      }, 120_000);

      // implement ran twice, and the second time its task carried the person's words.
      const trace = await traceOf(rt, runId);
      const implementStarts = trace.filter((e) => e.type === 'model-started' && e.stepId === 'implement');
      const tasks = implementStarts.map((e) => JSON.stringify((e.payload['request'] as { messages: unknown[] }).messages[0]));
      expect(tasks.some((t) => t.includes(feedback))).toBe(true);
      expect(tasks[0]).not.toContain(feedback);
      expect(trace.filter((e) => e.type === 'step-completed' && e.payload['stepId'] === 'implement')).toHaveLength(2);
      expect(trace.filter((e) => e.type === 'review-requested')).toHaveLength(2);
      // The second push carried the extra commit and a re-recorded handoff; nothing between re-runs failed.
      expect(git(root, 'log', '--format=%s', 'main..run/99-fixture').split('\n')).toEqual(['RUN-99 handoff and STATUS', 'Explain the fixed state', 'RUN-99 handoff and STATUS', 'Fix the app state']);
      expect(git(remote, 'rev-parse', 'refs/heads/run/99-fixture')).toBe(git(root, 'rev-parse', 'HEAD'));
      expect(trace.some((e) => e.type === 'step-failed')).toBe(false);

      const second = (await reviewsOf(rt)).find((r) => r.blocking && r.runId === runId)!;
      const continued = await fetch(`${rt.baseUrl}/api/v1/reviews/${second.id}`, { method: 'POST', headers: headers(rt), body: JSON.stringify({ decision: 'continue' }) });
      expect(continued.status).toBe(202);
      await waitFor(async () => (await detailOf(rt, runId)).state === 'completed', 60_000);
      const done = await detailOf(rt, runId);
      expect((done.outputs as { branch: string })['branch']).toBe('run/99-fixture');
      expect(String((done.outputs as { summary: string })['summary'])).toContain('Branch: run/99-fixture');
    } finally {
      await rt.stop();
    }
  }, 300_000);
});

describe('DoD 5: the workflow validates cleanly, and its budgets are on the detail', () => {
  it('has no D-49 smells and says what implement is capped at', async () => {
    const ws = tempWorkspace('dod17-5');
    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true });
    try {
      const detail = (await (await fetch(`${rt.baseUrl}/api/v1/workflows/coding-run`, { headers: headers(rt) })).json()) as WorkflowDetail;
      expect(detail.smells).toEqual([]);
      expect(detail.steps.map((s) => s.id)).toEqual(['read', 'implement', 'verify', 'handoff', 'file-handoff', 'commit', 'push', 'hand-to-human']);
      expect(detail.steps.find((s) => s.id === 'hand-to-human')?.review).toBe('blocking');
      const implement = detail.budgets.steps.find((s) => s.stepId === 'implement')!;
      expect(implement.budget).toEqual({ maxModelCalls: 120, maxToolCalls: 400, maxCostUsd: 10, maxWallClockMs: 5400000 });
      expect(detail.hasSchedule, 'never unattended').toBe(false);
      const listed = (await (await fetch(`${rt.baseUrl}/api/v1/workflows`, { headers: headers(rt) })).json()) as { errors: unknown[] };
      expect(listed.errors).toEqual([]);
    } finally {
      await rt.stop();
    }
  }, 60_000);
});
