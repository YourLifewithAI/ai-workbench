// SEC-28b: the daily cap refuses and stops scheduled runs. A schedule is the case that matters — nobody is
// watching when it fires, so the cap is the only thing between a bad loop and a month's budget.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { startRuntime, tempWorkspace, waitFor, type Started } from '../helpers/workspace.js';
import type { RunSummary } from '../../src/shared/api/index.js';

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

describe('SEC-28b the daily cap stops scheduled spending', () => {
  it('a scheduled run started past the cap fails on it without sending anything', async () => {
    const ws = tempWorkspace('sec28b');
    plantEndlessLoop(ws);
    fs.writeFileSync(path.join(ws, 'config', 'workbench.json'), JSON.stringify({
      schemaVersion: 1,
      budgets: { maxModelCalls: 200, dailySpendCapUsd: 0.02 },
    }));

    let now = new Date('2026-09-03T12:00:00Z');
    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true, now: () => now });
    try {
      rt.runtime.scheduler.upsert({ workflowId: 'story-pipeline', cron: '* * * * *', inputs: { premise: 'Spend it all.' } });

      // The first firing burns through the cap: the run fails on a budget, not on a model.
      now = new Date('2026-09-03T12:01:30Z');
      const first = rt.runtime.scheduler.tick().fired;
      expect(first).toHaveLength(1);
      await waitFor(async () => {
        const run = (await runs(rt)).find((r) => r.id === first[0]!.runId);
        return run !== undefined && run.state !== 'running' && run.state !== 'queued';
      }, 60_000);
      expect(await rt.runtime.engine.spentTodayUsd()).toBeGreaterThanOrEqual(0.02);

      // The next firing is refused before its first call: the cap is a floor under the whole workspace,
      // not a per-run budget that a new run resets.
      now = new Date('2026-09-03T12:02:30Z');
      const second = rt.runtime.scheduler.tick().fired;
      expect(second).toHaveLength(1);
      await waitFor(async () => {
        const run = (await runs(rt)).find((r) => r.id === second[0]!.runId);
        return run !== undefined && run.state === 'failed';
      }, 60_000);

      const detail = (await (await fetch(`${rt.baseUrl}/api/v1/runs/${second[0]!.runId}`, { headers: headers(rt) })).json()) as { error: { reason: string }; spent: { modelCalls: number } };
      expect(detail.error.reason).toBe('daily_cap_reached');
      expect(detail.spent.modelCalls, 'refused before the first call, not after it').toBe(0);

      // And the trace says why in words a human can act on.
      const trace = (await (await fetch(`${rt.baseUrl}/api/v1/runs/${second[0]!.runId}/trace.jsonl`, { headers: headers(rt) })).text())
        .trim().split('\n').map((l) => JSON.parse(l) as { type: string; payload: Record<string, unknown> });
      const failed = trace.find((e) => e.type === 'run-failed')!;
      expect(String(failed.payload['message'])).toMatch(/spending cap/i);
    } finally {
      await rt.stop();
    }
  }, 180_000);
});
