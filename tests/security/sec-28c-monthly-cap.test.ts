// SEC-28c (F3): the month's cap refuses a run before its first call and pauses every schedule until the month
// turns or the cap is raised. Like the daily cap, the schedule is the case that matters: nobody is watching.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { startRuntime, tempWorkspace, waitFor, type Started } from '../helpers/workspace.js';
import type { RunSummary, SpendResponse } from '../../src/shared/api/index.js';

const headers = (rt: Started): Record<string, string> => ({ Authorization: `Bearer ${rt.token}`, 'Content-Type': 'application/json' });

/** Every call answers with a tool call to a tool that does not exist, so only a budget can end the loop. */
function plantEndlessLoop(ws: string): void {
  fs.writeFileSync(path.join(ws, 'fixtures', 'aaa-loop.json'), JSON.stringify({
    match: {},
    respond: { text: 'Working on it.', toolCalls: [{ name: 'web.search', input: { q: 'x' } }], usage: { input: 2000, output: 2000 } },
  }));
}

const runs = async (rt: Started): Promise<RunSummary[]> =>
  ((await (await fetch(`${rt.baseUrl}/api/v1/runs`, { headers: headers(rt) })).json()) as { runs: RunSummary[] }).runs;

describe('SEC-28c the monthly cap stops spending and pauses schedules', () => {
  it('a run past the cap fails before its first call, schedules pause, and the next month lifts both', async () => {
    const ws = tempWorkspace('sec28c');
    plantEndlessLoop(ws);
    fs.writeFileSync(path.join(ws, 'config', 'workbench.json'), JSON.stringify({
      schemaVersion: 1,
      budgets: { maxModelCalls: 200, dailySpendCapUsd: 0, monthlySpendCapUsd: 0.02 },
    }));

    let now = new Date('2026-09-03T12:00:00Z');
    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true, now: () => now });
    try {
      rt.runtime.scheduler.upsert({ workflowId: 'story-pipeline', cron: '* * * * *', inputs: { premise: 'Spend it all.' } });

      // The first firing burns through the cap: the run fails on the monthly budget, not on a model.
      now = new Date('2026-09-03T12:01:30Z');
      const first = rt.runtime.scheduler.tick();
      expect(first.fired).toHaveLength(1);
      await waitFor(async () => (await runs(rt)).some((r) => r.id === first.fired[0]!.runId && r.state === 'failed'), 60_000);
      const spend = (await (await fetch(`${rt.baseUrl}/api/v1/spend`, { headers: headers(rt) })).json()) as SpendResponse;
      expect(spend.thisMonthUsd).toBeGreaterThanOrEqual(0.02);
      expect(spend.schedulesPaused).toBe(true);
      expect(spend.monthlySpendCapUsd).toBe(0.02);

      // Nothing scheduled fires while the month is used up, and the schedule keeps its time rather than being missed.
      now = new Date('2026-09-03T12:03:30Z');
      const paused = rt.runtime.scheduler.tick();
      expect(paused.fired).toHaveLength(0);
      expect(paused.paused).toContain("this month's spending cap");

      // A run started by hand is refused before its first call, by name.
      const res = await fetch(`${rt.baseUrl}/api/v1/runs`, { method: 'POST', headers: headers(rt), body: JSON.stringify({ kind: 'agent', id: 'architect', inputs: { input: 'Try anyway.' }, provider: 'mock' }) });
      const { runId } = (await res.json()) as { runId: string };
      await waitFor(async () => (await runs(rt)).some((r) => r.id === runId && r.state === 'failed'), 30_000);
      const trace = await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}/trace.jsonl`, { headers: headers(rt) })).text();
      expect(trace).toContain('monthly_cap_reached');
      expect(trace).not.toContain('model-started');

      // The month turns: the cap is behind us, schedules fire again. The window is the *local* calendar
      // month (D-70), so cross the boundary in local time: `2026-10-01T00:00:30Z` is still September for
      // every owner west of Greenwich, and this assertion then fails on their machine while passing in CI,
      // which runs in UTC. Constructed from parts, it is the first minute of October in any zone.
      now = new Date(2026, 9, 1, 0, 0, 30);
      const after = (await (await fetch(`${rt.baseUrl}/api/v1/spend`, { headers: headers(rt) })).json()) as SpendResponse;
      expect(after.thisMonthUsd).toBe(0);
      expect(after.schedulesPaused).toBe(false);
      const resumed = rt.runtime.scheduler.tick();
      expect(resumed.paused).toBeUndefined();
      expect(resumed.fired.length + resumed.skipped.length).toBeGreaterThan(0);
    } finally {
      await rt.stop();
    }
  }, 120_000);
});
