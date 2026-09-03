// SEC-28a: model calls, cost, and wall clock each stop a run. SEC-29: cancel aborts the in-flight HTTP request.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { startRuntime, tempWorkspace, waitFor } from '../helpers/workspace.js';
import type { RunDetail } from '../../src/shared/api/index.js';
import type { FetchLike } from '../../src/runtime/models/adapter.js';

/** Runs one agent to completion against the mock and returns the reason it ended, if it failed. */
async function runToEnd(ws: string, agentId = 'architect'): Promise<{ state: string; reason: string | null; calls: number }> {
  const rt = await startRuntime(ws, { providerOverride: 'mock' });
  try {
    const headers = { Authorization: `Bearer ${rt.token}`, 'Content-Type': 'application/json' };
    const created = await fetch(`${rt.baseUrl}/api/v1/runs`, {
      method: 'POST', headers,
      body: JSON.stringify({ kind: 'agent', id: agentId, inputs: { input: 'A premise.' } }),
    });
    const { runId } = (await created.json()) as { runId: string };
    await waitFor(async () => {
      const d = (await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}`, { headers })).json()) as RunDetail;
      return d.state !== 'running' && d.state !== 'queued';
    }, 30_000);
    const detail = (await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}`, { headers })).json()) as RunDetail;
    const error = detail.error as { reason?: string } | undefined;
    return { state: detail.state, reason: error?.reason ?? null, calls: detail.spent.modelCalls };
  } finally {
    await rt.stop();
  }
}

/** Every call answers with a tool call to a tool that does not exist, so only a budget can end the loop. */
function plantEndlessLoop(ws: string): void {
  fs.writeFileSync(path.join(ws, 'fixtures', 'aaa-loop.json'), JSON.stringify({
    match: {},
    respond: { text: 'Working on it.', toolCalls: [{ name: 'web.search', input: { q: 'x' } }], usage: { input: 1000, output: 1000 } },
  }));
}

function config(ws: string, budgets: Record<string, number>): void {
  fs.writeFileSync(path.join(ws, 'config', 'workbench.json'), JSON.stringify({ schemaVersion: 1, budgets }));
}

describe('SEC-28a: no run can spend past its budgets', () => {
  it('the model-call budget ends the run, and the count never exceeds it', async () => {
    const ws = tempWorkspace('sec28a-calls');
    plantEndlessLoop(ws);
    config(ws, { maxModelCalls: 4 });
    const result = await runToEnd(ws);
    expect(result.state).toBe('failed');
    expect(result.reason).toBe('budget_exceeded');
    expect(result.calls).toBeLessThanOrEqual(4);
  }, 60_000);

  it('the cost budget ends the run', async () => {
    const ws = tempWorkspace('sec28a-cost');
    plantEndlessLoop(ws);
    // Large usage on a priced model, so a handful of calls is enough to cross a small cap.
    config(ws, { maxModelCalls: 500, maxCostUsd: 0.01 });
    const result = await runToEnd(ws);
    expect(result.state).toBe('failed');
    expect(result.reason).toBe('budget_exceeded');
    expect(result.calls).toBeLessThan(500);
  }, 60_000);

  it('the wall clock ends the run, with no wrap-up turn to extend it', async () => {
    const ws = tempWorkspace('sec28a-clock');
    fs.writeFileSync(path.join(ws, 'fixtures', 'aaa-slow.json'), JSON.stringify({
      match: {}, respond: { text: 'Slowly.', toolCalls: [{ name: 'web.search', input: {} }], latencyMs: 200 },
    }));
    config(ws, { maxModelCalls: 500, maxWallClockMs: 300 });
    const result = await runToEnd(ws);
    expect(result.state).toBe('failed');
    expect(result.reason).toBe('wall_clock_exceeded');
  }, 60_000);

  it('the daily cap refuses a run whose workspace has already spent it', async () => {
    const ws = tempWorkspace('sec28a-daily');
    plantEndlessLoop(ws);
    config(ws, { dailySpendCapUsd: 0.000001 });
    // The first run spends something; the second is refused before it sends anything.
    await runToEnd(ws);
    const result = await runToEnd(ws);
    expect(result.state).toBe('failed');
    expect(result.reason).toBe('daily_cap_reached');
    expect(result.calls).toBe(0);
  }, 90_000);
});

describe('SEC-29: cancel aborts the in-flight HTTP request', () => {
  it('the signal the adapter passed to fetch fires, so the connection is not left running', async () => {
    const ws = tempWorkspace('sec29');
    fs.writeFileSync(path.join(ws, 'config', 'credentials.json'), JSON.stringify({ google: { apiKey: 'test-key-for-abort' } }), { mode: 0o600 });

    let sawSignal: AbortSignal | null = null;
    let reached = false;
    // A provider that never answers: the only way this call ends is the abort the cancel sends.
    const hangingFetch: FetchLike = (_input, init) => {
      reached = true;
      sawSignal = (init?.signal as AbortSignal | undefined) ?? null;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    };

    const rt = await startRuntime(ws, { fetch: hangingFetch });
    try {
      const headers = { Authorization: `Bearer ${rt.token}`, 'Content-Type': 'application/json' };
      const created = await fetch(`${rt.baseUrl}/api/v1/runs`, {
        method: 'POST', headers,
        body: JSON.stringify({ kind: 'agent', id: 'architect', inputs: { input: 'A premise.' } }),
      });
      const { runId } = (await created.json()) as { runId: string };
      await waitFor(() => reached, 20_000);
      expect(sawSignal, 'the adapter must hand fetch the run\'s abort signal').not.toBeNull();
      expect(sawSignal!.aborted).toBe(false);

      const cancelled = await fetch(`${rt.baseUrl}/api/v1/runs/${runId}/cancel`, { method: 'POST', headers });
      expect(cancelled.status).toBe(202);

      await waitFor(() => sawSignal!.aborted, 20_000);
      await waitFor(async () => {
        const d = (await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}`, { headers })).json()) as RunDetail;
        return d.state === 'cancelled';
      }, 20_000);
    } finally {
      await rt.stop();
    }
  }, 60_000);
});
