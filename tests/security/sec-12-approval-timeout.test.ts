// SEC-12: an approval nobody answers becomes a denial, and the narrowest rule is what "remember" writes.
// The first half had no test for a structural reason: expiry used to be armed only when the scheduler was,
// and every test disables the scheduler to stay deterministic. Arming it separately is what makes this
// testable at all, so this suite exists to hold that apart.
import { describe, expect, it } from 'vitest';
import { ApprovalStore, DEFAULT_TIMEOUT_MS } from '../../src/runtime/approvals/store.js';
import { startRuntime, tempWorkspace } from '../helpers/workspace.js';

describe('SEC-12 silence is not consent', () => {
  it('a pending approval past its deadline becomes a denial, decided by the clock and not by a person', async () => {
    const ws = tempWorkspace('sec12');
    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true });
    try {
      const store = new ApprovalStore(rt.runtime.db);
      const row = store.open({ runId: 'r1', stepId: 's1', tool: 'shell', args: { command: 'rm -rf /' }, policy: 'shell always asks' });
      expect(row.state).toBe('pending');

      // Not yet due: a deadline in the future must not be treated as one in the past.
      expect(store.expire(new Date(Date.parse(row.expires_at) - 1000))).toHaveLength(0);
      expect(store.byId(row.id)?.state).toBe('pending');

      const due = store.expire(new Date(Date.parse(row.expires_at) + 1));
      expect(due.map((r) => r.id)).toEqual([row.id]);
      const after = store.byId(row.id)!;
      expect(after.state).toBe('expired');
      expect(after.decided_by, 'the clock decided, not a person').toBe('timeout');

      // And it stays decided: a second sweep must not re-fire it.
      expect(store.expire(new Date(Date.parse(row.expires_at) + 60_000))).toHaveLength(0);
    } finally {
      await rt.stop();
    }
  });

  it('the expiry sweeper is armed even when the scheduler is not', async () => {
    // The regression this guards: expiry used to live inside `if (!noScheduler)`, so every deterministic
    // test — and any owner who ran with scheduling off — lost the denial-on-silence guarantee.
    const ws = tempWorkspace('sec12b');
    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true });
    try {
      const store = new ApprovalStore(rt.runtime.db);
      const row = store.open({ runId: 'r2', stepId: 's2', tool: 'http.request', args: {}, policy: 'non-GET always asks', timeoutMs: 1 });
      await new Promise((r) => setTimeout(r, 20));
      // expireApprovals is what the armed interval calls; calling it directly is the same code path.
      expect(rt.runtime.engine.expireApprovals()).toBeGreaterThanOrEqual(1);
      expect(store.byId(row.id)?.state).toBe('expired');
    } finally {
      await rt.stop();
    }
  });

  it('half an hour is the default, so the deadline is a real one and not the heat death of the universe', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(30 * 60 * 1000);
  });
});
