// RUN-05 Definition of done (spec/runs/RUN-05.md). Item 5 (reattaching after a browser restart) is @run-05 in e2e.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { CLI_DIST, runCli, startRuntime, tempWorkspace, waitFor, type Started } from '../helpers/workspace.js';
import { openWorkspaceStore } from '../../src/runtime/cli/store.js';
import type { DashboardResponse, DocumentDetail, ReviewItem, RunDetail } from '../../src/shared/api/index.js';

beforeAll(() => {
  if (!fs.existsSync(CLI_DIST)) throw new Error('dist/cli.js is missing: run `npm run build` (or `npm run dod -- 05`, which builds first).');
});

const headers = (rt: Started): Record<string, string> => ({ Authorization: `Bearer ${rt.token}`, 'Content-Type': 'application/json' });

/** Makes the Weaver step a blocking gate, which is what the brief asks the run to park on. */
function blockOnWeaver(ws: string): void {
  const file = path.join(ws, 'workflows', 'story-pipeline.workflow.json');
  const definition = JSON.parse(fs.readFileSync(file, 'utf8')) as { steps: { id: string; review?: string }[] };
  definition.steps.find((s) => s.id === 'draft')!.review = 'blocking';
  fs.writeFileSync(file, JSON.stringify(definition, null, 2));
}

async function startWorkflow(rt: Started, premise = 'A dentist finds a message in a tooth.'): Promise<string> {
  const res = await fetch(`${rt.baseUrl}/api/v1/runs`, {
    method: 'POST', headers: headers(rt),
    body: JSON.stringify({ kind: 'workflow', id: 'story-pipeline', inputs: { premise } }),
  });
  expect(res.status).toBe(202);
  return ((await res.json()) as { runId: string }).runId;
}

const detailOf = async (rt: Started, runId: string): Promise<RunDetail> =>
  (await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}`, { headers: headers(rt) })).json()) as RunDetail;

const reviewsOf = async (rt: Started): Promise<ReviewItem[]> =>
  ((await (await fetch(`${rt.baseUrl}/api/v1/reviews`, { headers: headers(rt) })).json()) as { reviews: ReviewItem[] }).reviews;

describe('DoD 1: schedules fire on their cron, and an outage does not fire a backlog', () => {
  it('a minutely schedule produces one run per window under a fake clock', async () => {
    const ws = tempWorkspace('dod05-sched');
    let now = new Date('2026-09-03T12:00:00Z');
    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true, now: () => now });
    try {
      rt.runtime.scheduler.upsert({ workflowId: 'story-pipeline', cron: '* * * * *', inputs: { premise: 'Scheduled.' } });
      expect(rt.runtime.scheduler.tick().fired, 'nothing is due at the moment it is created').toHaveLength(0);

      now = new Date('2026-09-03T12:01:30Z');
      expect(rt.runtime.scheduler.tick().fired).toHaveLength(1);
      now = new Date('2026-09-03T12:02:30Z');
      expect(rt.runtime.scheduler.tick().fired).toHaveLength(1);

      await waitFor(async () => {
        const runs = (await (await fetch(`${rt.baseUrl}/api/v1/runs?kind=workflow`, { headers: headers(rt) })).json()) as { runs: RunDetail[] };
        return runs.runs.length === 2;
      });
    } finally {
      await rt.stop();
    }
  }, 120_000);

  it('catchUp "once" fires one run for a missed outage; "none" fires none', async () => {
    const ws = tempWorkspace('dod05-catchup');
    let now = new Date('2026-09-03T12:00:00Z');
    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true, now: () => now });
    try {
      const once = rt.runtime.scheduler.upsert({ workflowId: 'story-pipeline', cron: '* * * * *', inputs: { premise: 'Catch up.' }, catchUp: 'once' });
      const none = rt.runtime.scheduler.upsert({ workflowId: 'story-pipeline', cron: '* * * * *', inputs: { premise: 'Skip it.' }, catchUp: 'none' });

      // The runtime was down for two hours; both schedules are long overdue.
      now = new Date('2026-09-03T14:00:30Z');
      const { fired, skipped } = rt.runtime.scheduler.tick();
      expect(fired.map((f) => f.scheduleId), 'one run for everything missed, not one per missed minute').toEqual([once.id]);
      expect(skipped).toEqual([none.id]);

      // Both are advanced past now, so the next tick in the same window fires nothing at all.
      expect(rt.runtime.scheduler.tick().fired).toHaveLength(0);
    } finally {
      await rt.stop();
    }
  }, 120_000);
});

describe('DoD 2: a run killed mid-flight is interrupted, and resume finishes it without duplicating anything', () => {
  it('resume runs only the steps that never finished', async () => {
    const ws = tempWorkspace('dod05-resume');
    // The Cutter never answers, so the run is still in flight when the runtime goes away.
    fs.writeFileSync(path.join(ws, 'fixtures', 'aaa-hang.json'), JSON.stringify({
      match: { systemIncludes: 'The Cutter' }, respond: { text: 'A cut draft, eventually.', chunkDelayMs: 5000 },
    }));
    const first = await startRuntime(ws, { providerOverride: 'mock' });
    let runId: string;
    try {
      runId = await startWorkflow(first);
      await waitFor(async () => (await detailOf(first, runId)).steps.find((s) => s.stepId === 'final')?.state === 'running', 30_000);
    } finally {
      await first.stop(); // stands in for a SIGKILL: the process goes away with the run still going
    }

    // The rows still say `running`; the next startup is what corrects them.
    const second = await startRuntime(ws, { providerOverride: 'mock' });
    try {
      const interrupted = await detailOf(second, runId);
      expect(interrupted.state).toBe('interrupted');
      expect(interrupted.steps.find((s) => s.stepId === 'beats')!.state).toBe('completed');
      expect(interrupted.steps.find((s) => s.stepId === 'final')!.state).toBe('cancelled');

      fs.rmSync(path.join(ws, 'fixtures', 'aaa-hang.json')); // the provider is answering again
      await (await fetch(`${second.baseUrl}/api/v1/agents/reload`, { method: 'POST', headers: headers(second) })).json();

      const resumed = await fetch(`${second.baseUrl}/api/v1/runs/${runId}/resume`, { method: 'POST', headers: headers(second) });
      expect(resumed.status).toBe(202);
      await waitFor(async () => (await detailOf(second, runId)).state === 'completed', 30_000);

      const documents = (await (await fetch(`${second.baseUrl}/api/v1/projects/anthology/documents`, { headers: headers(second) })).json()) as { documents: { id: string; path: string; versions: number }[] };
      const beats = documents.documents.find((d) => d.path === 'beats.md')!;
      expect(beats.versions, 'a step that already finished is not run again, so it does not file a second version').toBe(1);
      expect(documents.documents.find((d) => d.path === 'final.md')!.versions).toBe(1);
    } finally {
      await second.stop();
    }
  }, 180_000);
});

describe('DoD 3: a blocking gate parks the run until a human decides', () => {
  it('continue lets it carry on; reject re-runs the step with the feedback appended', async () => {
    const ws = tempWorkspace('dod05-gate');
    blockOnWeaver(ws);
    const rt = await startRuntime(ws, { providerOverride: 'mock' });
    try {
      const runId = await startWorkflow(rt);
      await waitFor(async () => (await detailOf(rt, runId)).state === 'waiting_review', 30_000);

      const parked = (await reviewsOf(rt)).find((r) => r.blocking && r.runId === runId)!;
      expect(parked.stepId).toBe('draft');
      expect(parked.output, 'the human is shown what they are deciding about').toContain('Aris');

      // Reject: the step re-runs with the feedback, and parks again for the second attempt.
      const feedback = 'Cut the Hub to one line of dialogue. Less interiority.';
      const rejected = await fetch(`${rt.baseUrl}/api/v1/reviews/${parked.id}`, {
        method: 'POST', headers: headers(rt), body: JSON.stringify({ decision: 'reject', feedback }),
      });
      expect(rejected.status).toBe(202);
      await waitFor(async () => {
        const again = (await reviewsOf(rt)).find((r) => r.runId === runId && r.stepId === 'draft');
        return again?.blocking === true && again.attempt === 2;
      }, 30_000);

      // The feedback reached the model, appended to the task rather than buried in the system prompt.
      const trace = (await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}/trace.jsonl`, { headers: headers(rt) })).text())
        .trim().split('\n').map((l) => JSON.parse(l) as { type: string; stepId: string | null; payload: Record<string, unknown> });
      const draftCalls = trace.filter((e) => e.type === 'model-started' && e.stepId === 'draft');
      expect(draftCalls).toHaveLength(2);
      const second = JSON.stringify((draftCalls[1]!.payload as { request: unknown }).request);
      expect(second).toContain('Cut the Hub to one line');
      expect(JSON.stringify((draftCalls[0]!.payload as { request: unknown }).request)).not.toContain('Cut the Hub to one line');
      expect(trace.some((e) => e.type === 'review-requested')).toBe(true);
      expect(trace.some((e) => e.type === 'review-decided')).toBe(true);

      // Continue: the gate opens and the rest of the workflow runs.
      const second2 = (await reviewsOf(rt)).find((r) => r.blocking && r.runId === runId)!;
      const continued = await fetch(`${rt.baseUrl}/api/v1/reviews/${second2.id}`, {
        method: 'POST', headers: headers(rt), body: JSON.stringify({ decision: 'continue' }),
      });
      expect(continued.status).toBe(202);
      await waitFor(async () => (await detailOf(rt, runId)).state === 'completed', 30_000);

      const finished = await detailOf(rt, runId);
      expect(finished.steps.find((s) => s.stepId === 'final')!.state).toBe('completed');
      // Deciding a review twice is a conflict, not a second decision.
      const again = await fetch(`${rt.baseUrl}/api/v1/reviews/${second2.id}`, { method: 'POST', headers: headers(rt), body: JSON.stringify({ decision: 'continue' }) });
      expect(again.status).toBe(409);
    } finally {
      await rt.stop();
    }
  }, 180_000);

  it('the CLI can decide a gate, and a rejection without feedback is refused', async () => {
    const ws = tempWorkspace('dod05-gate-cli');
    blockOnWeaver(ws);
    // Not ephemeral: the CLI has to find a *live* runtime to decide a gate. Deciding against a second process
    // would leave the first one holding a waiter that never resolves, so the CLI is right to refuse.
    const rt = await startRuntime(ws, { ephemeral: false, port: 0, providerOverride: 'mock' });
    try {
      const runId = await startWorkflow(rt);
      await waitFor(async () => (await detailOf(rt, runId)).state === 'waiting_review', 30_000);
      const parked = (await reviewsOf(rt)).find((r) => r.blocking)!;
      const env = { WORKBENCH_WORKSPACE: ws };

      const noFeedback = await runCli(['review', 'reject', parked.id, '--workspace', ws], { dist: true, env });
      expect(noFeedback.code).not.toBe(0);
      expect(noFeedback.stderr).toContain('feedback');

      const listed = await runCli(['review', 'list', '--json', '--workspace', ws], { dist: true, env });
      expect(listed.code, listed.stderr).toBe(0);
      expect((JSON.parse(listed.stdout) as { reviews: ReviewItem[] }).reviews.some((r) => r.id === parked.id)).toBe(true);

      const decided = await runCli(['review', 'continue', parked.id, '--workspace', ws], { dist: true, env });
      expect(decided.code, decided.stderr).toBe(0);
      await waitFor(async () => (await detailOf(rt, runId)).state === 'completed', 30_000);
    } finally {
      await rt.stop();
    }
  }, 180_000);
});

describe('DoD 4: ratings persist and reach the Library', () => {
  it('a rating on a step shows against the version that step produced', async () => {
    const ws = tempWorkspace('dod05-rate');
    const rt = await startRuntime(ws, { providerOverride: 'mock' });
    try {
      const runId = await startWorkflow(rt);
      await waitFor(async () => (await detailOf(rt, runId)).state === 'completed', 30_000);

      const review = (await reviewsOf(rt)).find((r) => r.runId === runId && r.stepId === 'beats')!;
      expect(review.state).toBe('unreviewed');
      expect(review.versionId).not.toBeNull();

      const rated = await fetch(`${rt.baseUrl}/api/v1/ratings`, {
        method: 'POST', headers: headers(rt),
        body: JSON.stringify({ runId, stepId: 'beats', versionId: review.versionId, value: 4, note: 'Beat 7 is the one.' }),
      });
      expect(rated.status).toBe(201);
      // Out of range is a validation error, not a silently clamped number.
      const bad = await fetch(`${rt.baseUrl}/api/v1/ratings`, { method: 'POST', headers: headers(rt), body: JSON.stringify({ runId, stepId: 'beats', value: 9 }) });
      expect(bad.status).toBe(400);

      const document = (await (await fetch(`${rt.baseUrl}/api/v1/documents/${review.documentId}`, { headers: headers(rt) })).json()) as DocumentDetail;
      expect(document.ratings[review.versionId!]?.[0]?.value).toBe(4);
      expect(document.ratings[review.versionId!]?.[0]?.note).toBe('Beat 7 is the one.');

      const store = await openWorkspaceStore(ws);
      try {
        const rows = store.db.prepare('SELECT value, note FROM ratings').all() as { value: number; note: string }[];
        expect(rows).toEqual([{ value: 4, note: 'Beat 7 is the one.' }]);
      } finally {
        await store.close();
      }
    } finally {
      await rt.stop();
    }
  }, 120_000);
});

describe('The Dashboard answers "what needs me" in one request', () => {
  it('lists blocking reviews, running runs, today\'s spend, and the next scheduled run', async () => {
    const ws = tempWorkspace('dod05-dash');
    blockOnWeaver(ws);
    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true });
    try {
      rt.runtime.scheduler.upsert({ workflowId: 'story-pipeline', cron: '0 7 * * *', inputs: { premise: 'Daily.' } });
      const runId = await startWorkflow(rt);
      await waitFor(async () => (await detailOf(rt, runId)).state === 'waiting_review', 30_000);

      const dash = (await (await fetch(`${rt.baseUrl}/api/v1/dashboard`, { headers: headers(rt) })).json()) as DashboardResponse;
      expect(dash.needsYou.map((r) => r.stepId)).toEqual(['draft']);
      expect(dash.running.map((r) => r.id)).toContain(runId);
      expect(dash.unreviewed).toBeGreaterThan(0);
      expect(dash.spentTodayUsd).toBeGreaterThan(0);
      expect(dash.dailySpendCapUsd).toBeGreaterThan(0);
      expect(dash.schedules[0]!.cron).toBe('0 7 * * *');
      expect(dash.networkMode).toBe('allowlist');
    } finally {
      await rt.stop();
    }
  }, 120_000);
});
