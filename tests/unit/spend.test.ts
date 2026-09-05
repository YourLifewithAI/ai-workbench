// Where the money went (F3): the spend view reads the same rows every cap reads.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DashboardResponse, SpendResponse } from '../../src/shared/api/index.js';
import { startRuntime, tempWorkspace, waitFor, type Started } from '../helpers/workspace.js';
import { roleFirst } from '../helpers/roles.js';

let rt: Started;
const headers = (): Record<string, string> => ({ Authorization: `Bearer ${rt.token}`, 'Content-Type': 'application/json' });

beforeAll(async () => { rt = await startRuntime(tempWorkspace('spend'), { providerOverride: 'mock' }); });
afterAll(async () => { await rt.stop(); });

describe('GET /spend', () => {
  it('starts at nothing, then shows a run by model and by what was run, and the month against its cap', async () => {
    const empty = (await (await fetch(`${rt.baseUrl}/api/v1/spend`, { headers: headers() })).json()) as SpendResponse;
    expect(empty).toMatchObject({ todayUsd: 0, thisMonthUsd: 0, projectedMonthUsd: 0, schedulesPaused: false, byModel: [], bySubject: [] });
    expect(empty.monthlySpendCapUsd).toBe(100);

    const res = await fetch(`${rt.baseUrl}/api/v1/runs`, { method: 'POST', headers: headers(), body: JSON.stringify({ kind: 'agent', id: 'architect', inputs: { input: 'Plan a scene.' }, provider: 'mock' }) });
    const { runId } = (await res.json()) as { runId: string };
    await waitFor(async () => ((await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}`, { headers: headers() })).json()) as { state: string }).state === 'completed', 30_000);

    const spend = (await (await fetch(`${rt.baseUrl}/api/v1/spend`, { headers: headers() })).json()) as SpendResponse;
    expect(spend.todayUsd).toBeGreaterThan(0);
    expect(spend.thisMonthUsd).toBe(spend.todayUsd);
    expect(spend.last7DaysUsd).toBe(spend.todayUsd);
    expect(spend.projectedMonthUsd).toBeGreaterThanOrEqual(spend.thisMonthUsd);
    expect(spend.byModel).toEqual([{ modelId: roleFirst('capable'), usd: spend.todayUsd, calls: 1 }]);
    expect(spend.bySubject).toEqual([{ subject: 'architect', kind: 'agent', usd: spend.todayUsd, runs: 1 }]);

    const dashboard = (await (await fetch(`${rt.baseUrl}/api/v1/dashboard`, { headers: headers() })).json()) as DashboardResponse;
    expect(dashboard.spentThisMonthUsd).toBe(spend.thisMonthUsd);
    expect(dashboard.monthlySpendCapUsd).toBe(100);
    expect(dashboard.schedulesPaused).toBe(false);
  }, 60_000);

  it('the caps are set on a screen: PUT /settings budgets takes the month', async () => {
    const put = await fetch(`${rt.baseUrl}/api/v1/settings`, { method: 'PUT', headers: headers(), body: JSON.stringify({ budgets: { monthlySpendCapUsd: 42, dailySpendCapUsd: 5, maxCostUsd: 1.5 } }) });
    expect(put.status).toBe(202);
    const settings = (await (await fetch(`${rt.baseUrl}/api/v1/settings`, { headers: headers() })).json()) as { budgets: Record<string, number> };
    expect(settings.budgets).toMatchObject({ monthlySpendCapUsd: 42, dailySpendCapUsd: 5, maxCostUsd: 1.5, maxModelCalls: 60 });
  });
});
