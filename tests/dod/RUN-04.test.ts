// RUN-04 Definition of done (spec/runs/RUN-04.md). Item 7 (the live graph and cancel from the UI) is @run-04 in e2e.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { CLI_DIST, runCli, startRuntime, tempWorkspace, waitFor } from '../helpers/workspace.js';
import { openWorkspaceStore } from '../../src/runtime/cli/store.js';
import type { EventRecord } from '../../src/shared/events.js';
import type { RunDetail } from '../../src/shared/api/index.js';

beforeAll(() => {
  if (!fs.existsSync(CLI_DIST)) throw new Error('dist/cli.js is missing: run `npm run build` (or `npm run dod -- 04`, which builds first).');
});

function writeInputs(ws: string, inputs: Record<string, unknown>): string {
  const file = path.join(ws, 'inputs.json');
  fs.writeFileSync(file, JSON.stringify(inputs));
  return file;
}

/** The whole stored trace for a run, read straight from the workspace database. */
async function traceOf(ws: string, runId: string): Promise<EventRecord[]> {
  const opened = await openWorkspaceStore(ws);
  try {
    return opened.events.list(runId);
  } finally {
    await opened.close();
  }
}

describe('DoD 1: the story pipeline runs end to end, a different model per step', () => {
  it('files beats.md, draft.md and final.md in anthology, each linked to its step', async () => {
    const ws = tempWorkspace('dod04-1');
    const file = writeInputs(ws, { premise: 'A dentist in an arcology finds a message encoded in a patient\'s tooth decay.' });
    const run = await runCli(['run', 'workflow', 'story-pipeline', '--inputs-file', file, '--provider', 'mock', '--json', '--workspace', ws], { dist: true });
    expect(run.code, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout) as { runId: string; state: string; outputs: Record<string, unknown> };
    expect(result.state).toBe('completed');
    expect(String(result.outputs['story'])).toContain('Aris');

    const opened = await openWorkspaceStore(ws);
    try {
      const documents = opened.store.listDocuments('anthology');
      const paths = documents.map((d) => d.path);
      expect(paths).toEqual(expect.arrayContaining(['beats.md', 'draft.md', 'final.md']));

      // Each document names the step that produced it, so the Library can walk back into the trace.
      const byStep = new Map<string, string>();
      for (const wanted of ['beats.md', 'draft.md', 'final.md']) {
        const detail = opened.store.getDocument(documents.find((d) => d.path === wanted)!.id)!;
        expect(detail.version!.runId).toBe(result.runId);
        expect(detail.version!.partial).toBe(false);
        byStep.set(detail.version!.stepId!, detail.version!.modelId!);
      }
      expect([...byStep.keys()].sort()).toEqual(['beats', 'draft', 'final']);
      // The Cutter is pinned to a flash-class id by the workflow, so the trace is not one model three times.
      expect(byStep.get('final')).toBe('google/gemini-3.6-flash');
      expect(new Set(byStep.values()).size).toBeGreaterThan(1);
    } finally {
      await opened.close();
    }
  }, 120_000);
});

describe('DoD 2: map runs its items concurrently and the judge validates against its schema', () => {
  it('three drafts overlap in time, arrive as a JSON array, and the verdict matches the schema', async () => {
    const ws = tempWorkspace('dod04-2');
    // Latency on every draft call, so overlapping timestamps mean concurrency rather than a fast serial run.
    fs.writeFileSync(path.join(ws, 'fixtures', 'aaa-slow-drafts.json'), JSON.stringify({
      match: { systemIncludes: 'The Weaver', lastUserIncludes: 'in your own voice' },
      respond: { text: 'A draft, written slowly.', latencyMs: 400 },
    }));
    const file = writeInputs(ws, { premise: 'A dentist finds a message in a tooth.' });
    const run = await runCli(['run', 'workflow', 'ensemble-draft', '--inputs-file', file, '--provider', 'mock', '--json', '--workspace', ws], { dist: true });
    expect(run.code, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout) as { runId: string; state: string; outputs: Record<string, unknown>; steps: { stepId: string; modelId: string | null }[] };
    expect(result.state).toBe('completed');

    const trace = await traceOf(ws, result.runId);
    const started = trace.filter((e) => e.type === 'model-started' && e.stepId?.startsWith('drafts['));
    expect(started).toHaveLength(3);
    // Three 400ms calls run in sequence take 1200ms; concurrently they all start inside the first one's window.
    const times = started.map((e) => Date.parse(e.ts)).sort((a, b) => a - b);
    expect(times[2]! - times[0]!).toBeLessThan(400);

    // Each item ran on its own model id: that is what `model: "{{item}}"` is for.
    const models = result.steps.filter((s) => s.stepId.startsWith('drafts[')).map((s) => s.modelId);
    expect(new Set(models).size).toBe(3);

    // The judge's input is the array, not three separate calls.
    const judgeCall = trace.find((e) => e.type === 'model-started' && e.stepId === 'verdict')!;
    const request = (judgeCall.payload as { request: { messages: { content: { text?: string }[] }[] } }).request;
    const task = request.messages[0]!.content.map((c) => c.text ?? '').join('');
    expect(JSON.parse(task)).toHaveLength(3);

    const verdict = result.outputs['verdict'] as { winner: number; rationale: string };
    expect(Number.isInteger(verdict.winner)).toBe(true);
    expect(verdict.rationale.length).toBeGreaterThan(0);
  }, 120_000);
});

describe('DoD 3: a run that spends its budget wraps up, files a partial, and fails', () => {
  it('warns once, takes one wrap-up turn, commits a partial version, then run-failed budget_exceeded', async () => {
    const ws = tempWorkspace('dod04-3');
    // Every call asks for a tool that does not exist, so the loop can only ever end on the budget.
    fs.writeFileSync(path.join(ws, 'fixtures', 'aaa-tool-loop.json'), JSON.stringify({
      match: { systemIncludes: 'The Architect' },
      respond: { text: 'Let me look that up.', toolCalls: [{ name: 'oracle.consult', input: { q: 'arcology dentistry' } }] },
    }));
    const file = writeInputs(ws, { premise: 'A dentist finds a message in a tooth.' });
    const run = await runCli(['run', 'workflow', 'story-pipeline', '--inputs-file', file, '--provider', 'mock', '--max-model-calls', '6', '--json', '--workspace', ws], { dist: true });
    expect(run.code).not.toBe(0); // the run failed, and the CLI says so

    const opened = await openWorkspaceStore(ws);
    try {
      const row = opened.db.prepare('SELECT id FROM runs ORDER BY started_at DESC LIMIT 1').get() as { id: string };
      const trace = opened.events.list(row.id);

      const warnings = trace.filter((e) => e.type === 'budget-warning');
      expect(warnings, 'one warning per budget, not one per call').toHaveLength(1);
      expect(warnings[0]!.payload['budget']).toBe('maxModelCalls');

      const calls = trace.filter((e) => e.type === 'model-started');
      expect(calls, 'five productive calls and the wrap-up, never more than the budget').toHaveLength(6);
      const systems = calls.map((e) => (e.payload as { request: { system: string } }).request.system);
      const wrapUps = systems.filter((s) => s.includes('This is your last turn'));
      expect(wrapUps, 'exactly one wrap-up turn, and it is the last call').toHaveLength(1);
      expect(systems[systems.length - 1]).toContain('This is your last turn');
      expect(systems[systems.length - 1]).toContain('do not call tools');

      // The tool the model asked for does not exist — and never will, which is the point of the name — and it
      // was told so rather than crashed.
      const toolResults = trace.filter((e) => e.type === 'tool-completed');
      expect(toolResults.length).toBeGreaterThan(0);
      expect(JSON.stringify(toolResults[0]!.payload)).toContain('UnknownTool');

      const failed = trace.find((e) => e.type === 'run-failed')!;
      expect(failed.payload['reason']).toBe('budget_exceeded');

      // What the wrap-up produced is kept, and marked as a summary rather than the work.
      const beats = opened.store.listDocuments('anthology').find((d) => d.path === 'beats.md')!;
      const version = opened.store.getDocument(beats.id)!.version!;
      expect(version.partial).toBe(true);
    } finally {
      await opened.close();
    }
  }, 120_000);
});

describe('DoD 4: cancel stops a run mid-stream and commits nothing from the interrupted step', () => {
  it('run-cancelled, the mock stops being called, and no document version comes from the cancelled step', async () => {
    const ws = tempWorkspace('dod04-4');
    fs.writeFileSync(path.join(ws, 'fixtures', 'aaa-slow-architect.json'), JSON.stringify({
      match: { systemIncludes: 'The Architect' },
      respond: { text: 'Beats, delivered very slowly indeed, one chunk at a time.', chunkDelayMs: 300 },
    }));
    const rt = await startRuntime(ws, { providerOverride: 'mock' });
    try {
      const headers = { Authorization: `Bearer ${rt.token}`, 'Content-Type': 'application/json' };
      const created = await fetch(`${rt.baseUrl}/api/v1/runs`, {
        method: 'POST', headers,
        body: JSON.stringify({ kind: 'workflow', id: 'story-pipeline', inputs: { premise: 'A dentist finds a message in a tooth.' } }),
      });
      expect(created.status).toBe(202);
      const { runId } = (await created.json()) as { runId: string };

      // Wait until the first model call is actually streaming before pulling the plug.
      await waitFor(async () => {
        const detail = (await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}`, { headers })).json()) as RunDetail;
        return detail.steps.some((s) => s.stepId === 'beats' && s.state === 'running');
      });

      const cancelled = await fetch(`${rt.baseUrl}/api/v1/runs/${runId}/cancel`, { method: 'POST', headers });
      expect(cancelled.status).toBe(202);
      await waitFor(async () => {
        const detail = (await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}`, { headers })).json()) as RunDetail;
        return detail.state === 'cancelled';
      });

      const mock = rt.runtime.mockAdapter;
      const before = mock.calls.length;
      await new Promise((r) => setTimeout(r, 500));
      expect(mock.calls.length, 'nothing carried on after the cancel').toBe(before);

      const detail = (await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}`, { headers })).json()) as RunDetail;
      expect(detail.state).toBe('cancelled');
      expect(detail.steps.find((s) => s.stepId === 'beats')!.state).toBe('cancelled');

      // Cancelling commits nothing: the step that was interrupted left no version behind.
      const documents = (await (await fetch(`${rt.baseUrl}/api/v1/projects/anthology/documents`, { headers })).json()) as { documents: { path: string }[] };
      expect(documents.documents.map((d) => d.path)).not.toContain('beats.md');

      // Cancelling a finished run is a conflict, not a second cancel.
      const again = await fetch(`${rt.baseUrl}/api/v1/runs/${runId}/cancel`, { method: 'POST', headers });
      expect(again.status).toBe(409);
    } finally {
      await rt.stop();
    }
  }, 120_000);
});

describe('DoD 5: a falsy `when` skips the step and its dependent still runs', () => {
  it('emits step-skipped and the dependent sees a null input', async () => {
    const ws = tempWorkspace('dod04-5');
    fs.writeFileSync(path.join(ws, 'workflows', 'skip-check.workflow.json'), JSON.stringify({
      schemaVersion: 1,
      id: 'skip-check',
      name: 'Skip check',
      description: 'A step that only runs for a very long premise, and one that runs either way.',
      defaultProject: 'anthology',
      inputs: { type: 'object', properties: { premise: { type: 'string' } }, required: ['premise'] },
      steps: [
        { id: 'beats', kind: 'agent', agent: 'architect', when: 'length(inputs.premise) > 10000', input: '{{inputs.premise}}', output: { document: null } },
        { id: 'draft', kind: 'agent', agent: 'weaver', input: '{{steps.beats.output}}', output: { document: null } },
      ],
      outputs: { draft: '{{steps.draft.output}}' },
    }));
    const file = writeInputs(ws, { premise: 'Too short to bother planning.' });
    const run = await runCli(['run', 'workflow', 'skip-check', '--inputs-file', file, '--provider', 'mock', '--json', '--workspace', ws], { dist: true });
    expect(run.code, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout) as { runId: string; state: string; steps: { stepId: string; state: string }[] };
    expect(result.state).toBe('completed');
    expect(result.steps.find((s) => s.stepId === 'beats')!.state).toBe('skipped');
    expect(result.steps.find((s) => s.stepId === 'draft')!.state).toBe('completed');

    const trace = await traceOf(ws, result.runId);
    const skipped = trace.find((e) => e.type === 'step-skipped')!;
    expect(skipped.stepId).toBe('beats');
    expect(skipped.payload['when']).toBe('length(inputs.premise) > 10000');

    // The dependent ran, and the skipped step's output reached it as `null` rather than as an error.
    const draftCall = trace.find((e) => e.type === 'model-started' && e.stepId === 'draft')!;
    const task = (draftCall.payload as { request: { messages: { content: { text?: string }[] }[] } }).request.messages[0]!.content.map((c) => c.text ?? '').join('');
    expect(task).toBe('null');
  }, 120_000);
});

describe('DoD 6: the same workflow on a real provider', () => {
  it.skipIf(process.env['WB_LIVE'] !== '1')('produces a story draft on Gemini', async () => {
    const ws = tempWorkspace('dod04-6');
    const file = writeInputs(ws, { premise: 'A dentist in an arcology finds a message encoded in a patient\'s tooth decay.' });
    const run = await runCli(['run', 'workflow', 'story-pipeline', '--inputs-file', file, '--json', '--workspace', ws], { dist: true });
    expect(run.code, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout) as { state: string; outputs: Record<string, unknown> };
    expect(result.state).toBe('completed');
    expect(String(result.outputs['story']).length).toBeGreaterThan(200);
  }, 300_000);
});

describe('Run states: a restart never silently loses a run', () => {
  it('a run left running by a restart becomes interrupted, not silently lost', async () => {
    const ws = tempWorkspace('dod04-sec29');
    const opened = await openWorkspaceStore(ws);
    try {
      const now = new Date().toISOString();
      opened.db.prepare(`INSERT INTO runs (id, kind, state, agent_id, depth, inputs_json, budgets_json, spent_json, started_at)
        VALUES ('ghost', 'agent', 'running', 'echo', 0, '{}', '{}', '{}', ?)`).run(now);
      opened.db.prepare("INSERT INTO run_steps (run_id, step_id, kind, state, started_at) VALUES ('ghost', 'main', 'agent', 'running', ?)").run(now);
    } finally {
      await opened.close();
    }

    const rt = await startRuntime(ws);
    try {
      const headers = { Authorization: `Bearer ${rt.token}` };
      const detail = (await (await fetch(`${rt.baseUrl}/api/v1/runs/ghost`, { headers })).json()) as RunDetail;
      expect(detail.state).toBe('interrupted');
      expect(detail.steps[0]!.state).toBe('cancelled');
      const events = (await (await fetch(`${rt.baseUrl}/api/v1/runs/ghost/trace.jsonl`, { headers })).text()).trim().split('\n');
      expect(events.some((line) => (JSON.parse(line) as EventRecord).type === 'run-interrupted')).toBe(true);
    } finally {
      await rt.stop();
    }
  }, 120_000);
});
