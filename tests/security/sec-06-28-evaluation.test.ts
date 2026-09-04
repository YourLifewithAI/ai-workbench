// SEC-06 through a dataset export, and SEC-28c: what an evaluation writes down, and what it refuses to.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { exportDataset } from '../../src/runtime/evaluation/transfer.js';
import { Redactor } from '../../src/runtime/security/redaction.js';
import { startRuntime, tempWorkspace, waitFor, type Started } from '../helpers/workspace.js';
import type { DatasetSummary, ExperimentResults, ExperimentSummary } from '../../src/shared/api/index.js';

const headers = (rt: Started): Record<string, string> => ({ Authorization: `Bearer ${rt.token}`, 'Content-Type': 'application/json' });

describe('SEC-06 a dataset export carries no credential', () => {
  it('redacts every value, in inputs, references and metadata alike', () => {
    const key = `AIzaFake${randomBytes(12).toString('hex')}`;
    const redactor = new Redactor();
    redactor.register('credential:google', key);

    const file = exportDataset({ name: 'from-real-runs', version: 1 }, [
      { id: 'a', input: { input: `Use ${key} to fetch it.` }, reference: `the answer, signed with ${key}`, metadata: { note: `key was ${key}` } },
    ], redactor);

    const text = JSON.stringify(file);
    expect(text, 'a dataset made from real run inputs can hold a real key').not.toContain(key);
    // Three separate places, all of them redacted rather than only the obvious one.
    expect(text.match(/\[REDACTED:credential:google\]/g)).toHaveLength(3);
  });

  it('and the route redacts too, not just the function', async () => {
    const key = `AIzaFake${randomBytes(12).toString('hex')}`;
    const ws = tempWorkspace('sec06-export');
    fs.writeFileSync(path.join(ws, 'config', 'credentials.json'), JSON.stringify({ google: { apiKey: key } }), { mode: 0o600 });

    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true });
    try {
      const dataset = (await (await fetch(`${rt.baseUrl}/api/v1/datasets`, {
        method: 'POST', headers: headers(rt),
        body: JSON.stringify({ name: 'leaky', cases: [{ input: { input: `the key is ${key}` }, reference: 'ok' }] }),
      })).json()) as DatasetSummary;

      const exported = await (await fetch(`${rt.baseUrl}/api/v1/datasets/${dataset.id}/export`, { headers: headers(rt) })).text();
      expect(exported).not.toContain(key);
      expect(exported).toContain('[REDACTED:credential:google]');
    } finally {
      await rt.stop();
    }
  }, 60_000);
});

describe('SEC-28c an experiment is bounded like anything else that spends money', () => {
  it('stops at its cost budget rather than running the whole grid', async () => {
    const ws = tempWorkspace('sec28c');
    fs.writeFileSync(path.join(ws, 'fixtures', 'aaa.json'), JSON.stringify({
      match: { systemIncludes: 'The Weaver' }, respond: { text: 'a sentence that costs something to produce' },
    }));

    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true });
    try {
      const dataset = (await (await fetch(`${rt.baseUrl}/api/v1/datasets`, {
        method: 'POST', headers: headers(rt),
        body: JSON.stringify({ name: 'ten', cases: Array.from({ length: 10 }, (_, i) => ({ input: { input: `Write ${i}.` } })) }),
      })).json()) as DatasetSummary;

      const experiment = (await (await fetch(`${rt.baseUrl}/api/v1/experiments`, {
        method: 'POST', headers: headers(rt),
        body: JSON.stringify({
          name: 'capped', datasetId: dataset.id, target: { kind: 'agent', id: 'weaver' },
          models: ['google/gemini-3.8-flash', 'google/gemini-3.6-flash'], trials: 3,
          budgets: { maxCostUsd: 0.0005 }, project: 'anthology',
        }),
      })).json()) as ExperimentSummary;

      await waitFor(async () => {
        const r = (await (await fetch(`${rt.baseUrl}/api/v1/experiments/${experiment.id}/results`, { headers: headers(rt) })).json()) as ExperimentResults;
        return ['completed', 'failed'].includes(r.experiment.state);
      }, 180_000);

      const results = (await (await fetch(`${rt.baseUrl}/api/v1/experiments/${experiment.id}/results`, { headers: headers(rt) })).json()) as ExperimentResults;
      expect(results.experiment.state).toBe('failed');
      expect(results.experiment.error!['reason']).toBe('budget_exceeded');
      // 10 cases × 2 models × 3 trials is 60 runs; the cap stopped it long before that.
      const runs = rt.runtime.db.prepare('SELECT COUNT(*) AS n FROM experiment_runs WHERE experiment_id = ?').get(experiment.id) as { n: number };
      expect(runs.n).toBeLessThan(60);
      expect(Number(results.experiment.error!['spentUsd'])).toBeGreaterThan(0);
    } finally {
      await rt.stop();
    }
  }, 240_000);

  it('no score of any kind reaches model selection', () => {
    // The one place a model is chosen is `selectCandidates`, and it is a policy decision plus availability.
    // If a score ever became an input to it, this test is where someone would have to delete the assertion.
    const selection = fs.readFileSync(path.join(process.cwd(), 'src', 'runtime', 'models', 'catalog.ts'), 'utf8');
    for (const forbidden of ['score', 'Score', 'rating', 'Rating', 'evaluation', 'experiment']) {
      expect(selection, `model selection knows nothing about "${forbidden}" (D-06)`).not.toContain(forbidden);
    }
  });
});
