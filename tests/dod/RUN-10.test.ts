// RUN-10 Definition of done (spec/runs/RUN-10.md). Item 5 (Compare and the results table in a browser) is @run-10 in e2e.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { CLI_DIST, runCli, startRuntime, tempWorkspace, waitFor, type Started } from '../helpers/workspace.js';
import { passAtK, scoreLocally } from '../../src/runtime/evaluation/evaluators.js';
import { exportDataset, importDataset } from '../../src/runtime/evaluation/transfer.js';
import { Redactor } from '../../src/runtime/security/redaction.js';
import type { CompareResponse, DatasetSummary, ExperimentResults, ExperimentSummary } from '../../src/shared/api/index.js';

beforeAll(() => {
  if (!fs.existsSync(CLI_DIST)) throw new Error('dist/cli.js is missing: run `npm run build` (or `npm run dod -- 10`, which builds first).');
});

const headers = (rt: Started): Record<string, string> => ({ Authorization: `Bearer ${rt.token}`, 'Content-Type': 'application/json' });

function fixture(ws: string, name: string, body: unknown): void {
  fs.writeFileSync(path.join(ws, 'fixtures', name), JSON.stringify(body, null, 2));
}

describe('DoD 1: compare one step across two models, and the pick persists on both', () => {
  it('two traces from one view, and a rating on every pane sharing a compare id', async () => {
    const ws = tempWorkspace('dod10-1');
    // Each "model" answers differently, which is the whole point of looking at them side by side.
    fixture(ws, 'aaa-pro.json', { match: { modelId: '*3.8-flash', systemIncludes: 'The Weaver' }, respond: { text: 'Rain on the third ring, and the drains held.' } });
    fixture(ws, 'aab-flash.json', { match: { modelId: '*3.6-flash', systemIncludes: 'The Weaver' }, respond: { text: 'It rained.' } });

    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true });
    try {
      const response = await fetch(`${rt.baseUrl}/api/v1/compare`, {
        method: 'POST', headers: headers(rt),
        body: JSON.stringify({ agentId: 'weaver', input: 'Write one line about the rain.', models: ['google/gemini-3.8-flash', 'google/gemini-3.6-flash'], project: 'anthology' }),
      });
      expect(response.status).toBe(200);
      const comparison = (await response.json()) as CompareResponse;
      expect(comparison.panes).toHaveLength(2);

      // Each pane is a real run with a real trace, and they say different things.
      for (const pane of comparison.panes) {
        expect(pane.state).toBe('completed');
        expect(pane.runId).toMatch(/^[0-9A-Z]{26}$/);
        const trace = await (await fetch(`${rt.baseUrl}/api/v1/runs/${pane.runId}/trace.jsonl`, { headers: headers(rt) })).text();
        expect(trace).toContain('run-completed');
      }
      const outputs = comparison.panes.map((p) => p.output);
      expect(new Set(outputs).size, 'two models, two answers').toBe(2);
      expect(comparison.panes.find((p) => p.modelId.endsWith('3.8-flash'))!.output).toContain('the drains held');

      // The pick is stored on both runs, so the choice keeps both sides of itself (D-50).
      const winner = comparison.panes[0]!;
      const picked = await fetch(`${rt.baseUrl}/api/v1/compare/pick`, {
        method: 'POST', headers: headers(rt),
        body: JSON.stringify({
          compareId: comparison.compareId,
          winner: { runId: winner.runId, modelId: winner.modelId },
          panes: comparison.panes.map((p) => ({ runId: p.runId, modelId: p.modelId })),
          note: 'the second one says nothing',
        }),
      });
      expect(picked.status).toBe(201);

      const ratings = rt.runtime.db.prepare('SELECT run_id, value, compare_id, model_id, note FROM ratings ORDER BY value DESC').all() as {
        run_id: string; value: number; compare_id: string; model_id: string; note: string | null;
      }[];
      expect(ratings).toHaveLength(2);
      expect(new Set(ratings.map((r) => r.compare_id))).toEqual(new Set([comparison.compareId]));
      expect(ratings[0]!.run_id).toBe(winner.runId);
      expect(ratings[0]!.value).toBeGreaterThan(ratings[1]!.value);
      expect(ratings.map((r) => r.model_id).sort()).toEqual(comparison.panes.map((p) => p.modelId).sort());
      expect(ratings[0]!.note).toBe('the second one says nothing');
    } finally {
      await rt.stop();
    }
  }, 180_000);
});

describe('DoD 2: an experiment reports pass^k beside the mean, and stops at its budget', () => {
  it('5 cases × 2 models × k=3, and a cost cap that ends it with a clear reason', async () => {
    const ws = tempWorkspace('dod10-2');
    // One model answers every case correctly; the other gets two of the five wrong, every time. The mock is
    // deterministic per run and a trial is a run, so within-cell variance is not something it can produce —
    // `passAtK` is unit-tested for that below, and here pass^k is asserted per cell, which is where it lives.
    fixture(ws, 'aaa-good.json', { match: { modelId: '*3.8-flash', systemIncludes: 'The Weaver' }, respond: { text: 'yes' } });
    fixture(ws, 'aab-wrong-3.json', { match: { modelId: '*3.6-flash', systemIncludes: 'The Weaver', lastUserIncludes: '(3)' }, respond: { text: 'no' } });
    fixture(ws, 'aac-wrong-4.json', { match: { modelId: '*3.6-flash', systemIncludes: 'The Weaver', lastUserIncludes: '(4)' }, respond: { text: 'no' } });
    fixture(ws, 'aad-flash.json', { match: { modelId: '*3.6-flash', systemIncludes: 'The Weaver' }, respond: { text: 'yes' } });

    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true });
    try {
      const dataset = (await (await fetch(`${rt.baseUrl}/api/v1/datasets`, {
        method: 'POST', headers: headers(rt),
        body: JSON.stringify({
          name: 'yes-or-no',
          cases: Array.from({ length: 5 }, (_, i) => ({ input: { input: `Say yes. (${i})` }, reference: 'yes' })),
        }),
      })).json()) as DatasetSummary;
      expect(dataset.cases).toBe(5);
      expect(dataset.frozen, 'not frozen until an experiment references it').toBe(false);

      const started = await fetch(`${rt.baseUrl}/api/v1/experiments`, {
        method: 'POST', headers: headers(rt),
        body: JSON.stringify({
          name: 'yes across two models',
          datasetId: dataset.id,
          target: { kind: 'agent', id: 'weaver' },
          models: ['google/gemini-3.8-flash', 'google/gemini-3.6-flash'],
          trials: 3,
          evaluators: [{ kind: 'exact' }],
          project: 'anthology',
        }),
      });
      expect(started.status).toBe(202);
      const experiment = (await started.json()) as ExperimentSummary;

      await waitFor(async () => {
        const results = (await (await fetch(`${rt.baseUrl}/api/v1/experiments/${experiment.id}/results`, { headers: headers(rt) })).json()) as ExperimentResults;
        return ['completed', 'failed', 'cancelled'].includes(results.experiment.state);
      }, 180_000);

      const results = (await (await fetch(`${rt.baseUrl}/api/v1/experiments/${experiment.id}/results`, { headers: headers(rt) })).json()) as ExperimentResults;
      expect(results.experiment.state).toBe('completed');
      expect(results.cells, '5 cases × 2 models').toHaveLength(10);
      for (const cell of results.cells) expect(cell.trials, 'k = 3').toBe(3);

      // Both candidates are Flash now — Google's lineup has no GA Pro — so these are named for what the
      // fixtures make them do, which is what the assertions are actually about.
      const good = results.totals.find((t) => t.modelId.endsWith('3.8-flash'))!;
      const weaker = results.totals.find((t) => t.modelId.endsWith('3.6-flash'))!;
      expect(good.metrics['exact']!.mean).toBe(1);
      expect(good.metrics['exact']!.passK, 'every trial of every case').toBe(1);
      expect(good.metrics['exact']!.estimate, 'exact is not an estimate').toBe(false);
      // The other one got two of the five wrong: three fifths of the cases, every trial.
      expect(weaker.metrics['exact']!.mean).toBeCloseTo(0.6, 5);
      expect(weaker.metrics['exact']!.passK).toBeCloseTo(0.6, 5);

      // pass^k is a per-cell fact: a case it failed passed on no trial, and a case it answered passed on all three.
      // Both models end in "flash", so the filter has to name the version — this is the weaker one's cells.
      const failed = results.cells.filter((c) => c.modelId.endsWith('3.6-flash') && c.metrics['exact']!.passK === 0);
      const passed = results.cells.filter((c) => c.modelId.endsWith('3.6-flash') && c.metrics['exact']!.passK === 1);
      expect(failed).toHaveLength(2);
      expect(passed).toHaveLength(3);
      for (const cell of failed) expect(cell.metrics['exact']!.mean, 'wrong on every trial').toBe(0);
      for (const cell of passed) expect(cell.metrics['exact']!.mean).toBe(1);
      expect(results.cells.every((c) => c.runIds.length === 3), 'every cell links its three traces').toBe(true);

      // The dataset is frozen now, and says why when someone tries to add to it.
      const frozen = (await (await fetch(`${rt.baseUrl}/api/v1/datasets`, { headers: headers(rt) })).json()) as { datasets: DatasetSummary[] };
      expect(frozen.datasets.find((d) => d.id === dataset.id)!.frozen).toBe(true);

      // And a budget stops one: a cap below the cost of a single trial ends it at the first check.
      const capped = (await (await fetch(`${rt.baseUrl}/api/v1/experiments`, {
        method: 'POST', headers: headers(rt),
        body: JSON.stringify({
          name: 'stopped by its budget',
          datasetId: dataset.id,
          target: { kind: 'agent', id: 'weaver' },
          models: ['google/gemini-3.8-flash'],
          trials: 3,
          evaluators: [{ kind: 'exact' }],
          budgets: { maxCostUsd: 0.0000001 },
          project: 'anthology',
        }),
      })).json()) as ExperimentSummary;

      await waitFor(async () => {
        const r = (await (await fetch(`${rt.baseUrl}/api/v1/experiments/${capped.id}/results`, { headers: headers(rt) })).json()) as ExperimentResults;
        return ['completed', 'failed'].includes(r.experiment.state);
      }, 120_000);
      const stopped = (await (await fetch(`${rt.baseUrl}/api/v1/experiments/${capped.id}/results`, { headers: headers(rt) })).json()) as ExperimentResults;
      expect(stopped.experiment.state).toBe('failed');
      expect(stopped.experiment.error!['reason']).toBe('budget_exceeded');
      expect(String(stopped.experiment.error!['message'])).toContain('cost budget');
      expect(stopped.cells.length, 'it stopped rather than finishing').toBeLessThan(5);
    } finally {
      await rt.stop();
    }
  }, 300_000);
});

describe('DoD 3: a judge is an estimate and exact is not', () => {
  it('the model-judge score carries the estimate flag; exact and schema do not', async () => {
    // The three local evaluators, decided without a model at all.
    expect(scoreLocally({ kind: 'exact', id: 'exact' }, { output: 'yes', reference: 'yes' })).toMatchObject({ value: 1, estimate: false });
    expect(scoreLocally({ kind: 'exact', id: 'exact' }, { output: 'no', reference: 'yes' })).toMatchObject({ value: 0, estimate: false });
    expect(scoreLocally({ kind: 'schema', id: 'schema', schema: { type: 'object', required: ['a'] } }, { output: '{"a":1}' })).toMatchObject({ value: 1, estimate: false });
    expect(scoreLocally({ kind: 'schema', id: 'schema', schema: { type: 'object', required: ['a'] } }, { output: '{"b":1}' })).toMatchObject({ value: 0, estimate: false });
    expect(scoreLocally({ kind: 'rule', id: 'rule', contains: ['drains'], minLength: 5 }, { output: 'the drains held' })).toMatchObject({ value: 1, estimate: false });
    // A judge is decided by a model, so it is never scored locally.
    expect(scoreLocally({ kind: 'model-judge', id: 'judge', model: 'x', rubric: 'y' }, { output: 'anything' })).toBeNull();

    const ws = tempWorkspace('dod10-3');
    fixture(ws, 'aaa-weaver.json', { match: { systemIncludes: 'The Weaver' }, respond: { text: 'Rain on the third ring.' } });
    // The judge is a model call like any other, so a fixture can be the judge.
    fixture(ws, 'aab-judge.json', { match: { lastUserIncludes: 'Score the output' }, respond: { json: { score: 0.8, why: 'it is one line and it is about rain' } } });

    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true });
    try {
      const dataset = (await (await fetch(`${rt.baseUrl}/api/v1/datasets`, {
        method: 'POST', headers: headers(rt),
        body: JSON.stringify({ name: 'one case', cases: [{ input: { input: 'Write about rain.' }, reference: 'Rain on the third ring.' }] }),
      })).json()) as DatasetSummary;

      const experiment = (await (await fetch(`${rt.baseUrl}/api/v1/experiments`, {
        method: 'POST', headers: headers(rt),
        body: JSON.stringify({
          name: 'judged', datasetId: dataset.id, target: { kind: 'agent', id: 'weaver' },
          models: ['google/gemini-3.8-flash'], trials: 1,
          evaluators: [{ kind: 'exact' }, { kind: 'model-judge', model: 'google/gemini-3.6-flash', rubric: 'Is it one line about rain?' }],
          project: 'anthology',
        }),
      })).json()) as ExperimentSummary;

      await waitFor(async () => {
        const r = (await (await fetch(`${rt.baseUrl}/api/v1/experiments/${experiment.id}/results`, { headers: headers(rt) })).json()) as ExperimentResults;
        return ['completed', 'failed'].includes(r.experiment.state);
      }, 120_000);

      const results = (await (await fetch(`${rt.baseUrl}/api/v1/experiments/${experiment.id}/results`, { headers: headers(rt) })).json()) as ExperimentResults;
      expect(results.experiment.state).toBe('completed');
      const total = results.totals[0]!;
      expect(total.metrics['exact'], 'an exact match is a fact').toMatchObject({ mean: 1, estimate: false });
      expect(total.metrics['model-judge'], 'a judge is an estimate, always').toMatchObject({ estimate: true });
      expect(total.metrics['model-judge']!.mean).toBeCloseTo(0.8, 5);
      expect(total.metrics['model-judge']!.passK, 'a 0.8 has not failed, so pass^k means nothing here').toBeNull();
      expect(total.metrics['exact']!.passK, 'and an exact match either passed or did not').not.toBeNull();

      // The rationale is kept, because a number with no reason is not evidence.
      const scores = rt.runtime.db.prepare("SELECT rationale, estimate FROM scores WHERE evaluator_id = 'model-judge'").all() as { rationale: string; estimate: number }[];
      expect(scores[0]!.rationale).toContain('about rain');
      expect(scores[0]!.estimate).toBe(1);
    } finally {
      await rt.stop();
    }
  }, 240_000);
});

describe('DoD 4: a dataset exports and re-imports', () => {
  it('round-trips through the promptfoo-compatible shape, redacted on the way out', () => {
    const redactor = new Redactor();
    redactor.register('credential:google', 'AIzaTHISISSECRET');
    const exported = exportDataset(
      { name: 'yes-or-no', version: 2 },
      [
        { id: 'a', input: { input: 'Say yes.' }, reference: 'yes', metadata: { source: 'run 1' } },
        { id: 'b', input: { input: 'The key is AIzaTHISISSECRET' }, reference: null, metadata: null },
      ],
      redactor,
    );
    expect(exported.workbench).toEqual({ dataset: 'yes-or-no', version: 2 });
    expect(exported.tests).toHaveLength(2);
    expect(exported.tests[0]!.assert).toEqual([{ type: 'equals', value: 'yes' }]);
    expect(JSON.stringify(exported), 'a dataset built from real runs can hold a real key (SEC-06)').not.toContain('AIzaTHISISSECRET');
    expect(JSON.stringify(exported)).toContain('[REDACTED:credential:google]');

    const back = importDataset(exported);
    expect(back.name).toBe('yes-or-no');
    expect(back.cases).toHaveLength(2);
    expect(back.cases[0]!.input).toEqual({ input: 'Say yes.' });
    expect(back.cases[0]!.reference).toBe('yes');
    expect(back.cases[1]!.reference, 'no reference is not an empty one').toBeUndefined();

    // Someone else's file, with an assertion this workbench has no evaluator for: kept, not dropped.
    const foreign = importDataset({
      tests: [{ vars: { input: 'hello' }, assert: [{ type: 'llm-rubric', value: 'is polite' }, { type: 'equals', value: 'hi' }], description: 'greeting' }],
    });
    expect(foreign.cases[0]!.reference).toBe('hi');
    expect(JSON.stringify(foreign.cases[0]!.metadata)).toContain('llm-rubric');
    expect(foreign.cases[0]!.metadata!['description']).toBe('greeting');

    expect(() => importDataset({ nope: true })).not.toThrow(); // an empty `tests` is a valid, empty dataset
    expect(() => importDataset('not an object')).toThrow(/promptfoo/);
  });

  it('round-trips through the CLI too', async () => {
    const ws = tempWorkspace('dod10-4');
    const file = path.join(ws, 'suite.json');
    fs.writeFileSync(file, JSON.stringify({
      tests: [
        { vars: { input: 'Say yes.' }, assert: [{ type: 'equals', value: 'yes' }] },
        { vars: { input: 'Say no.' }, assert: [{ type: 'equals', value: 'no' }] },
      ],
    }));

    const created = await runCli(['datasets', 'create', 'imported', '--from', file, '--json', '--workspace', ws], { dist: true });
    expect(created.code, created.stderr).toBe(0);
    const dataset = JSON.parse(created.stdout) as DatasetSummary;
    expect(dataset.cases).toBe(2);

    const exported = await runCli(['datasets', 'export', dataset.id, '--workspace', ws], { dist: true });
    expect(exported.code, exported.stderr).toBe(0);
    const file2 = JSON.parse(exported.stdout) as { tests: { vars: Record<string, unknown>; assert: unknown[] }[] };
    expect(file2.tests).toHaveLength(2);
    expect(file2.tests[0]!.vars).toEqual({ input: 'Say yes.' });

    const listed = await runCli(['datasets', 'list', '--json', '--workspace', ws], { dist: true });
    expect((JSON.parse(listed.stdout) as { datasets: DatasetSummary[] }).datasets).toHaveLength(1);
  }, 180_000);
});

describe('pass^k is the arithmetic the table reports', () => {
  it('a mean is not a pass, and three of three is', () => {
    expect(passAtK([1, 1, 1])).toEqual({ mean: 1, passK: 1, trials: 3 });
    expect(passAtK([1, 0, 1])).toMatchObject({ passK: 0, trials: 3 });
    expect(passAtK([1, 0, 1]).mean).toBeCloseTo(2 / 3, 10);
    expect(passAtK([])).toEqual({ mean: 0, passK: null, trials: 0 });
    // A metric that is not pass/fail has no pass^k, and says null rather than 0 — which would read as a failure.
    expect(passAtK([0.8, 0.8, 0.8])).toMatchObject({ passK: null, trials: 3 });
    expect(passAtK([0.8, 0.8, 0.8]).mean).toBeCloseTo(0.8, 10);
    expect(passAtK([1, 1, 0.5]).passK).toBeNull();
  });
});
