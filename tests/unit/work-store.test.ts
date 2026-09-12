// The ledger (D-75, RUN-24): dedupe by key, trust that only lowers, the open set, and the one way a decision
// gets an answer. Pure store, on a fresh database.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startRuntime, tempWorkspace, type Started } from '../helpers/workspace.js';
import type { WorkStore } from '../../src/runtime/work/store.js';

let rt: Started;
let store: WorkStore;
beforeAll(async () => { rt = await startRuntime(tempWorkspace('work-store'), { providerOverride: 'mock', noScheduler: true }); store = rt.runtime.engine.work; });
afterAll(async () => { await rt.stop(); });

const base = { kind: 'task' as const, project: 'anthology', detail: null, state: 'backlog' as const, assignee: null, key: null, trust: 'trusted' as const, runId: null };

describe('the ledger', () => {
  it('files once per key and refreshes after, keeping the id', () => {
    const first = store.file({ ...base, title: 'The ending trails off', key: 'bug:weaver:ending', runId: 'r1', trust: 'trusted' });
    expect(first.outcome).toBe('filed');
    const again = store.file({ ...base, title: 'The ending still trails off', key: 'bug:weaver:ending', runId: 'r2', trust: 'trusted' });
    expect(again.outcome).toBe('refreshed');
    expect(again.item.id).toBe(first.item.id);
    expect(again.item.title).toBe('The ending still trails off');
    expect(again.item.runs.map((r) => r.role)).toEqual(['filed', 'refreshed']);
    expect(store.list({ state: 'open' }).filter((i) => i.key === 'bug:weaver:ending')).toHaveLength(1);
  });

  it('a settled item does not swallow a new one with the same key', () => {
    const first = store.file({ ...base, title: 'Rename the draft', key: 'task:rename' });
    store.update(first.item.id, { state: 'done' });
    const next = store.file({ ...base, title: 'Rename the draft again', key: 'task:rename' });
    expect(next.outcome).toBe('filed');
    expect(next.item.id).not.toBe(first.item.id);
  });

  it('trust only lowers: a clean item refreshed by a tainted run carries the tainted run\'s words', () => {
    const clean = store.file({ ...base, title: 'Check the bible', key: 'task:bible', trust: 'trusted' });
    expect(clean.item.trust).toBe('trusted');
    const refreshed = store.file({ ...base, title: 'Check the bible (from the web)', key: 'task:bible', trust: 'untrusted' });
    expect(refreshed.item.trust).toBe('untrusted');
    const again = store.file({ ...base, title: 'Check the bible', key: 'task:bible', trust: 'trusted' });
    expect(again.item.trust, 'once untrusted, a refresh by a clean run does not launder it').toBe('untrusted');
  });

  it('open means everything not done or dropped — a decided decision is still open for the pulse to act on', () => {
    const decision = store.file({ ...base, kind: 'decision', title: 'Which draft?', state: 'needs-you', options: [{ id: 'a', label: 'First', detail: null }, { id: 'b', label: 'Second', detail: null }], lean: 'b' });
    expect(store.counts().needsYou).toBeGreaterThanOrEqual(1);
    const answered = store.update(decision.item.id, { answer: 'a', note: 'The first reads better.' })!;
    expect(answered.state).toBe('decided');
    expect(answered.answer).toBe('a');
    expect(answered.decidedAt).not.toBeNull();
    expect(store.list({ state: 'open' }).some((i) => i.id === decision.item.id)).toBe(true);
    expect(store.list({ state: 'decided', kind: 'decision' }).map((i) => i.id)).toContain(decision.item.id);
    store.update(decision.item.id, { state: 'done' });
    expect(store.list({ state: 'open' }).some((i) => i.id === decision.item.id)).toBe(false);
  });

  it('an answer on a task is a note, not a state change', () => {
    const task = store.file({ ...base, title: 'A task', key: null });
    const after = store.update(task.item.id, { answer: 'noted' })!;
    expect(after.state).toBe('backlog');
    expect(after.answer).toBe('noted');
  });
});
