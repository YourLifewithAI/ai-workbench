// RUN-06 Definition of done (spec/runs/RUN-06.md). Item 7 (granting a tool and approving from the Dashboard) is @run-06 in e2e.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { CLI_DIST, runCli, startRuntime, tempWorkspace, waitFor, type Started } from '../helpers/workspace.js';
import type { ApprovalItem, RunDetail, ToolsResponse } from '../../src/shared/api/index.js';
import type { EventRecord } from '../../src/shared/events.js';

beforeAll(() => {
  if (!fs.existsSync(CLI_DIST)) throw new Error('dist/cli.js is missing: run `npm run build` (or `npm run dod -- 06`, which builds first).');
});

const headers = (rt: Started): Record<string, string> => ({ Authorization: `Bearer ${rt.token}`, 'Content-Type': 'application/json' });

function grant(ws: string, agentId: string, permissions: Record<string, unknown>): void {
  const file = path.join(ws, 'config', 'workbench.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8')) as { grants?: Record<string, unknown> };
  config.grants = { ...(config.grants ?? {}), [agentId]: permissions };
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
}

function fixture(ws: string, name: string, body: unknown): void {
  fs.writeFileSync(path.join(ws, 'fixtures', name), JSON.stringify(body, null, 2));
}

async function startAgent(rt: Started, agentId: string, input: string, project = 'anthology'): Promise<string> {
  const res = await fetch(`${rt.baseUrl}/api/v1/runs`, {
    method: 'POST', headers: headers(rt), body: JSON.stringify({ kind: 'agent', id: agentId, inputs: { input }, project }),
  });
  expect(res.status).toBe(202);
  return ((await res.json()) as { runId: string }).runId;
}

const detailOf = async (rt: Started, runId: string): Promise<RunDetail> =>
  (await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}`, { headers: headers(rt) })).json()) as RunDetail;

const traceOf = async (rt: Started, runId: string): Promise<EventRecord[]> =>
  (await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}/trace.jsonl`, { headers: headers(rt) })).text())
    .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as EventRecord);

describe('DoD 1: a granted tool runs, and the trace carries the call and the result', () => {
  it('tool-requested, permission-decided and tool-completed each say what happened', async () => {
    const ws = tempWorkspace('dod06-1');
    grant(ws, 'architect', { tools: { calc: 'allow' } });
    fixture(ws, 'aaa-1.json', { match: { systemIncludes: 'The Architect', callIndex: 1 }, respond: { text: 'Working it out.', toolCalls: [{ name: 'calc', input: { expression: '(12 * 250) + 400' } }] } });
    fixture(ws, 'aab-2.json', { match: { systemIncludes: 'The Architect', callIndex: 2 }, respond: { text: '3400 words. 1. Aris drills a molar.' } });

    const rt = await startRuntime(ws, { providerOverride: 'mock' });
    try {
      const runId = await startAgent(rt, 'architect', 'Plan a scene.');
      await waitFor(async () => (await detailOf(rt, runId)).state === 'completed', 30_000);
      const trace = await traceOf(rt, runId);

      const requested = trace.find((e) => e.type === 'tool-requested')!;
      expect(requested.payload['tool']).toBe('calc');
      expect(requested.payload['input']).toEqual({ expression: '(12 * 250) + 400' });

      const decided = trace.find((e) => e.type === 'permission-decided')!;
      expect(decided.payload).toMatchObject({ tool: 'calc', allowed: true, approval: false });

      const completed = trace.find((e) => e.type === 'tool-completed')!;
      expect(completed.payload).toMatchObject({ tool: 'calc', ok: true });
      expect(completed.payload['output']).toEqual({ value: 3400, expression: '(12 * 250) + 400' });
    } finally {
      await rt.stop();
    }
  }, 120_000);
});

describe('DoD 2: an ungranted call is refused and the run carries on', () => {
  it('the model gets PermissionDenied with the policy named, and finishes anyway', async () => {
    const ws = tempWorkspace('dod06-2');
    // No grant at all: the tool is denied before the broker is even asked about a path.
    fixture(ws, 'aaa-1.json', { match: { systemIncludes: 'The Weaver', callIndex: 1 }, respond: { text: 'Saving a note.', toolCalls: [{ name: 'artifact.write', input: { path: 'notes/margins.md', content: 'A note.' } }] } });
    fixture(ws, 'aab-2.json', { match: { systemIncludes: 'The Weaver', callIndex: 2 }, respond: { text: 'I could not save the note. The drill was old.' } });

    const rt = await startRuntime(ws, { providerOverride: 'mock' });
    try {
      const runId = await startAgent(rt, 'weaver', 'Draft a scene.');
      await waitFor(async () => (await detailOf(rt, runId)).state === 'completed', 30_000);

      const trace = await traceOf(rt, runId);
      const completed = trace.find((e) => e.type === 'tool-completed')!;
      const error = completed.payload['error'] as { code: string; message: string; hint: string };
      expect(error.code).toBe('PermissionDenied');
      expect(error.message).toContain('not granted');
      expect(error.hint).toContain('Tools screen');

      // The run finished, and nothing was written.
      const detail = await detailOf(rt, runId);
      expect(detail.state).toBe('completed');
      const documents = (await (await fetch(`${rt.baseUrl}/api/v1/projects/anthology/documents`, { headers: headers(rt) })).json()) as { documents: { path: string }[] };
      expect(documents.documents.map((d) => d.path)).not.toContain('notes/margins.md');

      // And the denial is on the record for the Tools screen to show.
      const tools = (await (await fetch(`${rt.baseUrl}/api/v1/tools`, { headers: headers(rt) })).json()) as ToolsResponse;
      expect(tools.denials.some((d) => d.tool === 'artifact.write' && d.agentId === 'weaver')).toBe(true);
    } finally {
      await rt.stop();
    }
  }, 120_000);

  it('a granted tool with no granted path is still refused, and the message says which one failed', async () => {
    const ws = tempWorkspace('dod06-2b');
    grant(ws, 'weaver', { tools: { 'artifact.write': 'allow' } });
    fixture(ws, 'aaa-1.json', { match: { systemIncludes: 'The Weaver', callIndex: 1 }, respond: { text: 'Saving.', toolCalls: [{ name: 'artifact.write', input: { path: 'notes/a.md', content: 'x' } }] } });
    fixture(ws, 'aab-2.json', { match: { systemIncludes: 'The Weaver', callIndex: 2 }, respond: { text: 'Not saved; here is the draft.' } });

    const rt = await startRuntime(ws, { providerOverride: 'mock' });
    try {
      const runId = await startAgent(rt, 'weaver', 'Draft.');
      await waitFor(async () => (await detailOf(rt, runId)).state === 'completed', 30_000);
      const trace = await traceOf(rt, runId);
      expect(trace.find((e) => e.type === 'permission-decided')!.payload['allowed'], 'the tool is granted').toBe(true);
      const error = trace.find((e) => e.type === 'tool-completed')!.payload['error'] as { code: string; message: string };
      expect(error.code).toBe('PermissionDenied');
      expect(error.message, 'the path is what failed, and it says so').toContain('write permission for any path');
    } finally {
      await rt.stop();
    }
  }, 120_000);

  it('a path grant makes the same call succeed', async () => {
    const ws = tempWorkspace('dod06-2c');
    grant(ws, 'weaver', { tools: { 'artifact.write': 'allow' }, fs: { write: ['projects/anthology/'] } });
    fixture(ws, 'aaa-1.json', { match: { systemIncludes: 'The Weaver', callIndex: 1 }, respond: { text: 'Saving.', toolCalls: [{ name: 'artifact.write', input: { path: 'notes/margins.md', content: 'A note in the margin.' } }] } });
    fixture(ws, 'aab-2.json', { match: { systemIncludes: 'The Weaver', callIndex: 2 }, respond: { text: 'Saved. Here is the draft.' } });

    const rt = await startRuntime(ws, { providerOverride: 'mock' });
    try {
      const runId = await startAgent(rt, 'weaver', 'Draft.');
      await waitFor(async () => (await detailOf(rt, runId)).state === 'completed', 30_000);
      const documents = (await (await fetch(`${rt.baseUrl}/api/v1/projects/anthology/documents`, { headers: headers(rt) })).json()) as { documents: { path: string }[] };
      expect(documents.documents.map((d) => d.path)).toContain('notes/margins.md');
    } finally {
      await rt.stop();
    }
  }, 120_000);
});

describe('DoD 3: permission.request parks the run, and a timeout denies', () => {
  it('approving lets the agent carry on', async () => {
    const ws = tempWorkspace('dod06-3');
    grant(ws, 'weaver', { tools: { 'permission.request': 'allow' } });
    fixture(ws, 'aaa-1.json', { match: { systemIncludes: 'The Weaver', callIndex: 1 }, respond: { text: 'May I?', toolCalls: [{ name: 'permission.request', input: { what: 'write projects/anthology/notes/margins.md', why: 'the margin note belongs with the draft' } }] } });
    fixture(ws, 'aab-2.json', { match: { systemIncludes: 'The Weaver', callIndex: 2 }, respond: { text: 'Thank you. Here is the draft.' } });

    const rt = await startRuntime(ws, { providerOverride: 'mock' });
    try {
      const runId = await startAgent(rt, 'weaver', 'Draft.');
      await waitFor(async () => (await detailOf(rt, runId)).state === 'waiting_approval', 30_000);

      const pending = ((await (await fetch(`${rt.baseUrl}/api/v1/approvals`, { headers: headers(rt) })).json()) as { approvals: ApprovalItem[] }).approvals;
      expect(pending).toHaveLength(1);
      const card = pending[0]!;
      expect(card.actions[0]!.tool).toBe('permission.request');
      // The what and the why are the args, which is what the card's risk line is built from; the policy line
      // says which rule fired, without repeating them.
      expect(card.actions[0]!.args).toEqual({ what: 'write projects/anthology/notes/margins.md', why: 'the margin note belongs with the draft' });
      expect(card.actions[0]!.policy).toContain('not granted');

      // Nothing to remember: what was asked for is prose, not a path or a host, so the card offers no rule.
      expect(card.actions[0]!.remember).toBeNull();

      const decided = await fetch(`${rt.baseUrl}/api/v1/approvals/${card.batchId}`, {
        method: 'POST', headers: headers(rt), body: JSON.stringify({ decision: 'allow' }),
      });
      expect(decided.status).toBe(202);
      await waitFor(async () => (await detailOf(rt, runId)).state === 'completed', 30_000);

      const trace = await traceOf(rt, runId);
      expect(trace.some((e) => e.type === 'approval-requested')).toBe(true);
      expect(trace.find((e) => e.type === 'approval-decided')!.payload['decision']).toBe('allow');
      const completed = trace.find((e) => e.type === 'tool-completed')!;
      expect((completed.payload['output'] as { granted: boolean }).granted).toBe(true);
    } finally {
      await rt.stop();
    }
  }, 120_000);

  it('"remember" writes exactly one narrow rule, naming the path rather than the tool', async () => {
    const ws = tempWorkspace('dod06-3c');
    // The owner wants every write seen once, so `artifact.write` needs an approval however it is granted.
    grant(ws, 'weaver', { tools: { 'artifact.write': 'allow' }, fs: { write: ['projects/anthology/'] }, approvalRequired: ['artifact.write'] });
    fixture(ws, 'aaa-1.json', { match: { systemIncludes: 'The Weaver', callIndex: 1 }, respond: { text: 'Saving.', toolCalls: [{ name: 'artifact.write', input: { path: 'notes/margins.md', content: 'A note.' } }] } });
    fixture(ws, 'aab-2.json', { match: { systemIncludes: 'The Weaver', callIndex: 2 }, respond: { text: 'Saved. Here is the draft.' } });

    const rt = await startRuntime(ws, { providerOverride: 'mock' });
    try {
      const runId = await startAgent(rt, 'weaver', 'Draft.');
      await waitFor(async () => (await detailOf(rt, runId)).state === 'waiting_approval', 30_000);

      const card = ((await (await fetch(`${rt.baseUrl}/api/v1/approvals`, { headers: headers(rt) })).json()) as { approvals: ApprovalItem[] }).approvals[0]!;
      expect(card.actions[0]!.policy, 'the card names the rule that fired').toContain('every call needs a human decision');
      // The narrowest rule: this directory, for this tool. Not the tool, and not the project.
      expect(card.actions[0]!.remember).toEqual({ tool: 'artifact.write', path: 'notes' });

      await fetch(`${rt.baseUrl}/api/v1/approvals/${card.batchId}`, { method: 'POST', headers: headers(rt), body: JSON.stringify({ decision: 'allow-remember' }) });
      await waitFor(async () => (await detailOf(rt, runId)).state === 'completed', 30_000);

      const config = JSON.parse(fs.readFileSync(path.join(ws, 'config', 'workbench.json'), 'utf8')) as { remembered: { tool: string; path?: string }[] };
      expect(config.remembered, 'exactly one rule, no more').toHaveLength(1);
      expect(config.remembered[0]).toEqual({ tool: 'artifact.write', path: 'notes' });
    } finally {
      await rt.stop();
    }
  }, 120_000);

  it('nobody answering is a refusal, not an open door', async () => {
    const ws = tempWorkspace('dod06-3b');
    grant(ws, 'weaver', { tools: { 'permission.request': 'allow' } });
    fixture(ws, 'aaa-1.json', { match: { systemIncludes: 'The Weaver', callIndex: 1 }, respond: { text: 'May I?', toolCalls: [{ name: 'permission.request', input: { what: 'write anywhere', why: 'convenience' } }] } });
    fixture(ws, 'aab-2.json', { match: { systemIncludes: 'The Weaver', callIndex: 2 }, respond: { text: 'Understood. Here is the draft without it.' } });

    let now = new Date('2026-09-03T12:00:00Z');
    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true, now: () => now });
    try {
      const runId = await startAgent(rt, 'weaver', 'Draft.');
      await waitFor(async () => (await detailOf(rt, runId)).state === 'waiting_approval', 30_000);

      // Half an hour later, with nobody having looked at it.
      now = new Date('2026-09-03T12:31:00Z');
      expect(rt.runtime.engine.expireApprovals(now)).toBe(1);
      await waitFor(async () => (await detailOf(rt, runId)).state === 'completed', 30_000);

      const trace = await traceOf(rt, runId);
      const decided = trace.find((e) => e.type === 'approval-decided')!;
      expect(decided.payload).toMatchObject({ decision: 'deny', reason: 'timeout' });
      const completed = trace.find((e) => e.type === 'tool-completed' && e.payload['tool'] === 'permission.request')!;
      expect((completed.payload['output'] as { granted: boolean }).granted).toBe(false);
      // A timeout writes no rule.
      const config = JSON.parse(fs.readFileSync(path.join(ws, 'config', 'workbench.json'), 'utf8')) as { remembered?: unknown[] };
      expect(config.remembered ?? []).toHaveLength(0);
    } finally {
      await rt.stop();
    }
  }, 120_000);
});

describe('DoD 4: agent.delegate nests a child run it cannot escape', () => {
  it('the child has a parent, depth 1, a smaller budget, and appears in the parent\'s trace', async () => {
    const ws = tempWorkspace('dod06-4');
    grant(ws, 'delegator', { tools: { 'agent.delegate': 'allow' } });
    fixture(ws, 'aaa-1.json', { match: { systemIncludes: 'The Editor', callIndex: 1 }, respond: { text: 'The Architect should plan this.', toolCalls: [{ name: 'agent.delegate', input: { agent: 'architect', input: 'Turn this premise into beats: a dentist finds a message in a tooth.', maxModelCalls: 2 } }] } });
    fixture(ws, 'aab-2.json', { match: { systemIncludes: 'The Editor', callIndex: 2 }, respond: { text: 'I asked for beats and got ten. I would cut the fourth.' } });

    const rt = await startRuntime(ws, { providerOverride: 'mock' });
    try {
      const runId = await startAgent(rt, 'delegator', 'Plan a story.');
      await waitFor(async () => (await detailOf(rt, runId)).state === 'completed', 30_000);

      const runs = ((await (await fetch(`${rt.baseUrl}/api/v1/runs`, { headers: headers(rt) })).json()) as { runs: { id: string; agentId?: string }[] }).runs;
      const child = runs.find((r) => r.agentId === 'architect')!;
      expect(child, 'the delegation started a run of its own').toBeDefined();

      const row = rt.runtime.db.prepare('SELECT parent_run_id, depth, budgets_json FROM runs WHERE id = ?').get(child.id) as { parent_run_id: string; depth: number; budgets_json: string };
      expect(row.parent_run_id).toBe(runId);
      expect(row.depth).toBe(1);
      const childBudget = JSON.parse(row.budgets_json) as { maxModelCalls: number };
      const parentBudget = (await detailOf(rt, runId)).budgets;
      expect(childBudget.maxModelCalls, 'carved from the parent\'s remainder, never wider').toBeLessThanOrEqual(parentBudget.maxModelCalls);
      expect(childBudget.maxModelCalls).toBe(2);

      // The parent's trace shows the delegation, so the story has no gap in it.
      const trace = await traceOf(rt, runId);
      expect(trace.some((e) => e.type === 'run-started' && e.payload['delegated'] === true && e.payload['childRunId'] === child.id)).toBe(true);

      // The child saw the brief and nothing else: the parent's task is not in its prompt.
      const childTrace = await traceOf(rt, child.id);
      const firstCall = childTrace.find((e) => e.type === 'model-started')!;
      const request = JSON.stringify((firstCall.payload as { request: unknown }).request);
      expect(request).toContain('Turn this premise into beats');
      expect(request, 'the parent transcript is never shared (D-48)').not.toContain('Plan a story.');
    } finally {
      await rt.stop();
    }
  }, 180_000);

  it('depth 4 is refused by name', async () => {
    const ws = tempWorkspace('dod06-4b');
    grant(ws, 'delegator', { tools: { 'agent.delegate': 'allow' } });
    // Every call delegates to itself, so the chain would be infinite if the depth limit were not real.
    fixture(ws, 'aaa-loop.json', { match: { systemIncludes: 'The Editor' }, respond: { text: 'Passing it down.', toolCalls: [{ name: 'agent.delegate', input: { agent: 'delegator', input: 'Keep going.' } }] } });

    const rt = await startRuntime(ws, { providerOverride: 'mock' });
    try {
      const runId = await startAgent(rt, 'delegator', 'Start the chain.');
      await waitFor(async () => (await detailOf(rt, runId)).state !== 'running', 60_000);

      const depths = rt.runtime.db.prepare('SELECT MAX(depth) AS deepest FROM runs').get() as { deepest: number };
      expect(depths.deepest, 'three levels of delegation, and no fourth').toBe(3);

      const deepest = rt.runtime.db.prepare('SELECT id FROM runs WHERE depth = 3').get() as { id: string };
      const trace = await traceOf(rt, deepest.id);
      const refused = trace.find((e) => e.type === 'tool-completed' && (e.payload['error'] as { code?: string } | undefined)?.code === 'DelegationDepthExceeded');
      expect(refused, 'the fourth level is refused by name').toBeDefined();
    } finally {
      await rt.stop();
    }
  }, 180_000);
});

describe('DoD 5: two approvals from one step are one card', () => {
  it('the batch lists both actions', async () => {
    const ws = tempWorkspace('dod06-5');
    grant(ws, 'weaver', { tools: { 'permission.request': 'allow' } });
    fixture(ws, 'aaa-1.json', {
      match: { systemIncludes: 'The Weaver', callIndex: 1 },
      respond: {
        text: 'Two things, please.',
        toolCalls: [
          { name: 'permission.request', input: { what: 'write notes/margins.md', why: 'the note belongs with the draft' } },
          { name: 'permission.request', input: { what: 'read bible.md', why: 'to keep the names right' } },
        ],
      },
    });
    fixture(ws, 'aab-2.json', { match: { systemIncludes: 'The Weaver', callIndex: 2 }, respond: { text: 'Thank you. The draft follows.' } });

    const rt = await startRuntime(ws, { providerOverride: 'mock' });
    try {
      const runId = await startAgent(rt, 'weaver', 'Draft.');
      await waitFor(async () => {
        const pending = ((await (await fetch(`${rt.baseUrl}/api/v1/approvals`, { headers: headers(rt) })).json()) as { approvals: ApprovalItem[] }).approvals;
        return pending[0]?.actions.length === 2;
      }, 30_000);

      const pending = ((await (await fetch(`${rt.baseUrl}/api/v1/approvals`, { headers: headers(rt) })).json()) as { approvals: ApprovalItem[] }).approvals;
      expect(pending, 'one card, not two').toHaveLength(1);
      expect(pending[0]!.actions.map((a) => a.args['what'])).toEqual(['write notes/margins.md', 'read bible.md']);

      // Deciding the batch decides both.
      await fetch(`${rt.baseUrl}/api/v1/approvals/${pending[0]!.batchId}`, { method: 'POST', headers: headers(rt), body: JSON.stringify({ decision: 'allow' }) });
      await waitFor(async () => (await detailOf(rt, runId)).state === 'completed', 30_000);
    } finally {
      await rt.stop();
    }
  }, 120_000);
});

describe('DoD 6: long results are truncated and old rounds are masked; parallel calls overlap', () => {
  it('a big result goes to scratch with a pointer, and stays whole in the trace', async () => {
    const ws = tempWorkspace('dod06-6');
    grant(ws, 'weaver', { tools: { 'artifact.read': 'allow', calc: 'allow' }, fs: { read: ['projects/'] } });
    // A 50 KB document, well past the default maxToolResultChars.
    fs.mkdirSync(path.join(ws, 'projects', 'anthology'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'projects', 'anthology', 'long.md'), 'The drill was old. '.repeat(2700));
    fixture(ws, 'aaa-1.json', { match: { systemIncludes: 'The Weaver', callIndex: 1 }, respond: { text: 'Reading it.', toolCalls: [{ name: 'artifact.read', input: { path: 'long.md' } }] } });
    fixture(ws, 'aab-2.json', { match: { systemIncludes: 'The Weaver', callIndex: 2 }, respond: { text: 'That was long. Here is the draft.' } });

    const rt = await startRuntime(ws, { providerOverride: 'mock' });
    try {
      const runId = await startAgent(rt, 'weaver', 'Draft from the long one.');
      await waitFor(async () => (await detailOf(rt, runId)).state === 'completed', 30_000);

      const trace = await traceOf(rt, runId);
      const completed = trace.find((e) => e.type === 'tool-completed')!;
      const output = completed.payload['output'] as { content: string };
      expect(output.content.length, 'the trace keeps the whole thing').toBeGreaterThan(40_000);

      // What the model saw is the pointer, not the document.
      const second = trace.filter((e) => e.type === 'model-started')[1]!;
      const request = JSON.stringify((second.payload as { request: unknown }).request);
      expect(request).toContain('scratch/');
      expect(request).toContain('artifact.read');
      expect(request.length, 'the prompt is not 50 KB of document').toBeLessThan(20_000);

      // And the pointer resolves: the whole result is in this run's scratch.
      const scratch = fs.readdirSync(path.join(ws, 'runs', runId));
      expect(scratch.length).toBeGreaterThan(0);
      expect(fs.readFileSync(path.join(ws, 'runs', runId, scratch[0]!), 'utf8').length).toBeGreaterThan(40_000);
    } finally {
      await rt.stop();
    }
  }, 120_000);

  it('two calls in one response run at the same time, not one after the other', async () => {
    const ws = tempWorkspace('dod06-6b');
    grant(ws, 'weaver', { tools: { datetime: 'allow', calc: 'allow' } });
    fixture(ws, 'aaa-1.json', {
      match: { systemIncludes: 'The Weaver', callIndex: 1 },
      respond: { text: 'Both, please.', toolCalls: [{ name: 'calc', input: { expression: '2 + 2' } }, { name: 'datetime', input: {} }] },
    });
    fixture(ws, 'aab-2.json', { match: { systemIncludes: 'The Weaver', callIndex: 2 }, respond: { text: 'Four, and today. Here is the draft.' } });

    const rt = await startRuntime(ws, { providerOverride: 'mock' });
    try {
      const runId = await startAgent(rt, 'weaver', 'Draft.');
      await waitFor(async () => (await detailOf(rt, runId)).state === 'completed', 30_000);

      const trace = await traceOf(rt, runId);
      const requested = trace.filter((e) => e.type === 'tool-requested');
      const completed = trace.filter((e) => e.type === 'tool-completed');
      expect(requested).toHaveLength(2);
      // Both were asked for before either came back: that is what concurrent means here.
      expect(Date.parse(requested[1]!.ts)).toBeLessThanOrEqual(Date.parse(completed[0]!.ts));
    } finally {
      await rt.stop();
    }
  }, 120_000);

  it('after `keepRecentToolResults` rounds the oldest result is masked in the prompt but whole in the trace', async () => {
    const ws = tempWorkspace('dod06-6c');
    // Config first, then the grant: `grant` merges into whatever is on disk, so writing config after it would
    // wipe the grant it had just made.
    fs.writeFileSync(path.join(ws, 'config', 'workbench.json'), JSON.stringify({ schemaVersion: 1, context: { keepRecentToolResults: 2 } }));
    grant(ws, 'weaver', { tools: { calc: 'allow' } });
    // Six rounds of tool calls, then an answer.
    for (let i = 1; i <= 6; i++) {
      fixture(ws, `aa${i}.json`, { match: { systemIncludes: 'The Weaver', callIndex: i }, respond: { text: `Round ${i}.`, toolCalls: [{ name: 'calc', input: { expression: `${i} * 1111111` } }] } });
    }
    fixture(ws, 'ab7.json', { match: { systemIncludes: 'The Weaver', callIndex: 7 }, respond: { text: 'Done. Here is the draft.' } });

    const rt = await startRuntime(ws, { providerOverride: 'mock' });
    try {
      const runId = await startAgent(rt, 'weaver', 'Draft.');
      await waitFor(async () => (await detailOf(rt, runId)).state === 'completed', 30_000);

      const trace = await traceOf(rt, runId);
      const calls = trace.filter((e) => e.type === 'model-started');
      const last = JSON.stringify((calls[calls.length - 1]!.payload as { request: unknown }).request);
      expect(last, 'the oldest rounds are masked').toContain('masked');
      // The call the model made is still in its own message; what is gone is the *result* it got back.
      expect(last, 'the first result is not in the prompt any more').not.toContain('"value":1111111');
      expect(last, 'the most recent results still are').toContain('"value":6666666');

      // The trace kept every result whole.
      const results = trace.filter((e) => e.type === 'tool-completed');
      expect(results).toHaveLength(6);
      expect((results[0]!.payload['output'] as { value: number }).value).toBe(1111111);
    } finally {
      await rt.stop();
    }
  }, 120_000);
});

describe('The grant matrix is what a human edits', () => {
  it('granting through the API changes what the agent may do, and the CLI agrees', async () => {
    const ws = tempWorkspace('dod06-grants');
    const rt = await startRuntime(ws, { ephemeral: false, port: 0, providerOverride: 'mock' });
    try {
      const before = (await (await fetch(`${rt.baseUrl}/api/v1/tools`, { headers: headers(rt) })).json()) as ToolsResponse;
      const cell = before.matrix.find((m) => m.agentId === 'weaver' && m.toolId === 'calc')!;
      expect(cell.effective).toBe(false);
      expect(cell.granted).toBe('unset');

      const granted = await fetch(`${rt.baseUrl}/api/v1/tools/grants`, {
        method: 'PUT', headers: headers(rt), body: JSON.stringify({ agentId: 'weaver', toolId: 'calc', grant: 'allow' }),
      });
      expect(granted.status).toBe(200);
      expect((await granted.json()) as { effective: boolean }).toMatchObject({ effective: true });

      // It is written to the workspace, not held in memory, so it survives the runtime.
      const config = JSON.parse(fs.readFileSync(path.join(ws, 'config', 'workbench.json'), 'utf8')) as { grants: Record<string, { tools: Record<string, string> }> };
      expect(config.grants['weaver']!.tools['calc']).toBe('allow');

      const listed = await runCli(['tools', 'grants', '--agent', 'weaver', '--json', '--workspace', ws], { dist: true });
      expect(listed.code, listed.stderr).toBe(0);
      const matrix = (JSON.parse(listed.stdout) as ToolsResponse).matrix;
      expect(matrix.find((m) => m.toolId === 'calc')!.effective).toBe(true);
    } finally {
      await rt.stop();
    }
  }, 120_000);
});
