// RUN-02 Definition of done (spec/runs/RUN-02.md). Item 4 (Models screen, Privacy Inspector) is @run-02 in e2e.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import type { EventRecord } from '../../src/shared/events.js';
import { REPO, startRuntime, tempWorkspace } from '../helpers/workspace.js';
import { readExchanges } from '../contract/recorder.js';

const fixtureDir = (name: string) => path.join(REPO, 'tests', 'contract', 'fixtures', name);

/** Writes one mock fixture into a temp workspace, in filename order. */
function fixture(ws: string, name: string, body: unknown): void {
  fs.writeFileSync(path.join(ws, 'fixtures', `${name}.json`), JSON.stringify(body, null, 2));
}

function repointEcho(ws: string, primary: string, fallbacks: string[]): void {
  const file = path.join(ws, 'agents', 'echo', 'agent.json');
  const definition = JSON.parse(fs.readFileSync(file, 'utf8')) as { modelPolicy: unknown };
  definition.modelPolicy = { primary, fallbacks };
  fs.writeFileSync(file, JSON.stringify(definition));
}

const typesOf = (events: EventRecord[]): string[] => events.map((e) => e.type);

describe('DoD 1: the contract suite covers every adapter without a key', () => {
  it('mock, google, anthropic and openai-compatible all have committed fixtures or need none', () => {
    for (const adapter of ['google', 'anthropic', 'openai-compatible']) {
      for (const name of ['text', 'stream', 'tool-call', 'structured']) {
        expect(readExchanges(fixtureDir(adapter), name), `${adapter}/${name}`).toBeTruthy();
      }
    }
    // The mock opens no socket, so it has nothing to record.
    expect(fs.existsSync(fixtureDir('mock'))).toBe(false);
  });
});

describe('DoD 2: retry and fallback', () => {
  it('a mid-stream failure aborts the step and reruns it on the next candidate', async () => {
    const ws = tempWorkspace('dod02-fallback');
    repointEcho(ws, 'google/gemini-3.8-flash', ['google/gemini-3.6-flash']);
    // ModelUnavailable's default action is `fallback`, and the text streams before it fires.
    fixture(ws, '1-primary-fails', { match: { modelId: 'google/gemini-3.8-flash' }, respond: { text: 'partial answer that never finishes', error: 'ModelUnavailable', failAfterChars: 8 } });
    fixture(ws, '2-secondary-works', { match: { modelId: 'google/gemini-3.6-flash' }, respond: { text: 'the secondary answered' } });

    const rt = await startRuntime(ws, { providerOverride: 'mock' });
    try {
      const deltas: string[] = [];
      const stop = rt.runtime.events.subscribeDeltas((d) => deltas.push(d.text));
      const { runId, done } = rt.runtime.engine.startAgentRun({ agentId: 'echo', inputs: { input: 'go' } });
      await done;
      stop();

      const run = rt.runtime.engine.getRun(runId);
      expect(run?.state, JSON.stringify(run?.error)).toBe('completed');
      expect(run?.outputs?.['output']).toBe('the secondary answered');

      const events = rt.runtime.events.list(runId);
      expect(typesOf(events)).toEqual([
        'run-started', 'step-started',
        'model-started', 'model-aborted', 'fallback-selected',
        'model-started', 'model-completed',
        'step-completed', 'run-completed',
      ]);
      const fallback = events.find((e) => e.type === 'fallback-selected')!;
      expect(fallback.payload['from']).toBe('google/gemini-3.8-flash');
      expect(fallback.payload['to']).toBe('google/gemini-3.6-flash');
      expect(deltas.length, 'the primary really did stream before it failed').toBeGreaterThan(0);
      expect(rt.runtime.db.prepare('SELECT COUNT(*) AS n FROM model_calls WHERE run_id = ?').get(runId)).toEqual({ n: 2 });
    } finally {
      await rt.stop();
    }
  }, 60_000);

  it('a retryable error is retried twice on the same model before the fallback', async () => {
    const ws = tempWorkspace('dod02-retry');
    repointEcho(ws, 'google/gemini-3.8-flash', ['google/gemini-3.6-flash']);
    fixture(ws, '1-primary-rate-limited', { match: { modelId: 'google/gemini-3.8-flash' }, respond: { error: 'RateLimit' } });
    fixture(ws, '2-secondary-works', { match: { modelId: 'google/gemini-3.6-flash' }, respond: { text: 'the secondary answered' } });

    const rt = await startRuntime(ws, { providerOverride: 'mock' });
    try {
      const { runId, done } = rt.runtime.engine.startAgentRun({ agentId: 'echo', inputs: { input: 'go' } });
      await done;
      expect(rt.runtime.engine.getRun(runId)?.state).toBe('completed');

      const events = rt.runtime.events.list(runId);
      expect(typesOf(events)).toEqual([
        'run-started', 'step-started',
        'model-started', 'model-aborted',
        'model-started', 'model-aborted',
        'model-started', 'model-aborted',
        'fallback-selected',
        'model-started', 'model-completed',
        'step-completed', 'run-completed',
      ]);
      const attempts = events.filter((e) => e.type === 'model-started' && e.payload['modelId'] === 'google/gemini-3.8-flash').map((e) => e.payload['attempt']);
      expect(attempts, 'three attempts on the primary: the first plus two retries').toEqual([1, 2, 3]);
    } finally {
      await rt.stop();
    }
  }, 60_000);

  it('an abort-action error stops the run without trying the fallback', async () => {
    const ws = tempWorkspace('dod02-abort');
    repointEcho(ws, 'google/gemini-3.8-flash', ['google/gemini-3.6-flash']);
    fixture(ws, '1-primary-auth', { match: { modelId: 'google/gemini-3.8-flash' }, respond: { error: 'Authentication' } });

    const rt = await startRuntime(ws, { providerOverride: 'mock' });
    try {
      const { runId, done } = rt.runtime.engine.startAgentRun({ agentId: 'echo', inputs: { input: 'go' } });
      await done;
      expect(rt.runtime.engine.getRun(runId)?.state).toBe('failed');
      const events = rt.runtime.events.list(runId);
      expect(typesOf(events)).toEqual(['run-started', 'step-started', 'model-started', 'model-aborted', 'step-failed', 'run-failed']);
      expect(events.some((e) => e.type === 'fallback-selected'), 'a bad key is not something a second model fixes').toBe(false);
    } finally {
      await rt.stop();
    }
  }, 60_000);

  it('a candidate whose capabilities fall short is skipped before it is called', async () => {
    const ws = tempWorkspace('dod02-caps');
    const file = path.join(ws, 'agents', 'echo', 'agent.json');
    const definition = JSON.parse(fs.readFileSync(file, 'utf8')) as { modelPolicy: unknown };
    // qwen3 declares toolCalling "basic"; the requirement asks for "parallel", so only the second candidate qualifies.
    definition.modelPolicy = { primary: 'ollama/qwen3:14b', fallbacks: ['google/gemini-3.6-flash'], requires: { toolCalling: 'parallel' } };
    fs.writeFileSync(file, JSON.stringify(definition));

    const rt = await startRuntime(ws, { providerOverride: 'mock' });
    try {
      const { runId, done } = rt.runtime.engine.startAgentRun({ agentId: 'echo', inputs: { input: 'go' } });
      await done;
      expect(rt.runtime.engine.getRun(runId)?.state).toBe('completed');
      const started = rt.runtime.events.list(runId).find((e) => e.type === 'step-started')!;
      expect(started.payload['modelCandidates'], 'the unqualified model never became a candidate').toEqual(['google/gemini-3.6-flash']);
    } finally {
      await rt.stop();
    }
  }, 60_000);
});

describe('DoD 3: network modes', () => {
  it('offline refuses a cloud model with NetworkPolicy; local-only lets a declared loopback endpoint through', async () => {
    const ws = tempWorkspace('dod02-modes');
    const config = path.join(ws, 'config', 'workbench.json');
    fs.writeFileSync(config, JSON.stringify({ schemaVersion: 1, network: { mode: 'offline' } }));
    repointEcho(ws, 'google/gemini-3.8-flash', []);

    const offline = await startRuntime(ws);
    try {
      const { runId, done } = offline.runtime.engine.startAgentRun({ agentId: 'echo', inputs: { input: 'go' } });
      await done;
      const error = offline.runtime.engine.getRun(runId)?.error as { error: { code: string } };
      expect(error.error.code).toBe('NetworkPolicy');
    } finally {
      await offline.stop();
    }

    fs.writeFileSync(config, JSON.stringify({ schemaVersion: 1, network: { mode: 'local-only' } }));
    repointEcho(ws, 'mock/upstream', []);
    const local = await startRuntime(ws);
    try {
      const { runId, done } = local.runtime.engine.startAgentRun({ agentId: 'echo', inputs: { input: 'go' } });
      await done;
      expect(local.runtime.engine.getRun(runId)?.state).toBe('completed');
      const row = local.runtime.db.prepare('SELECT purpose, decision, data_categories, bytes FROM egress_log WHERE run_id = ?').get(runId) as { purpose: string; decision: string; data_categories: string; bytes: number };
      expect(row).toMatchObject({ purpose: 'model', decision: 'allowed', data_categories: 'instructions,task' });
      expect(row.bytes).toBeGreaterThan(0);
    } finally {
      await local.stop();
    }
  }, 90_000);

  it('the one-click switch writes the mode to config so it survives a restart', async () => {
    const ws = tempWorkspace('dod02-switch');
    const rt = await startRuntime(ws);
    try {
      const res = await fetch(`${rt.baseUrl}/api/v1/settings/network`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${rt.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'offline' }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ networkMode: 'offline' });
      const written = JSON.parse(fs.readFileSync(path.join(ws, 'config', 'workbench.json'), 'utf8')) as { network: { mode: string } };
      expect(written.network.mode).toBe('offline');
      const settings = (await (await fetch(`${rt.baseUrl}/api/v1/settings`, { headers: { Authorization: `Bearer ${rt.token}` } })).json()) as { networkMode: string };
      expect(settings.networkMode).toBe('offline');
    } finally {
      await rt.stop();
    }
  }, 60_000);
});

describe('RUN-02 surface: models and privacy', () => {
  it('GET /models reports availability with a reason, and the Privacy Inspector shows a routed call', async () => {
    const ws = tempWorkspace('dod02-models');
    repointEcho(ws, 'mock/upstream', []);
    const rt = await startRuntime(ws);
    try {
      const h = { Authorization: `Bearer ${rt.token}` };
      const list = (await (await fetch(`${rt.baseUrl}/api/v1/models`, { headers: h })).json()) as { models: { id: string; availability: string; reason: string | null }[]; networkMode: string };
      const byId = new Map(list.models.map((m) => [m.id, m]));
      expect(byId.get('mock/echo')?.availability).toBe('ready');
      expect(byId.get('google/gemini-3.8-flash')?.availability, 'no key is configured in a fresh workspace').toBe('no-credential');
      expect(byId.get('google/gemini-3.8-flash')?.reason).toMatch(/credential named "google"/);
      expect(byId.get('ollama/qwen3:14b')?.availability, 'disabled in the shipped catalog').toBe('disabled');

      const { runId, done } = rt.runtime.engine.startAgentRun({ agentId: 'echo', inputs: { input: 'privacy please' } });
      await done;
      const privacy = (await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}/privacy`, { headers: h })).json()) as {
        egress: { host: string; method: string; categories: string[]; decision: string; bodyRedacted: string | null }[];
        destinations: { modelId: string; calls: number }[];
      };
      expect(privacy.egress).toHaveLength(1);
      expect(privacy.egress[0]).toMatchObject({ host: '127.0.0.1', method: 'POST', decision: 'allowed', categories: ['instructions', 'task'] });
      expect(privacy.egress[0]!.bodyRedacted).toContain('privacy please');
      expect(privacy.destinations).toEqual([{ modelId: 'mock/upstream', host: expect.stringContaining('127.0.0.1') as unknown as string, dataPolicy: expect.any(Object) as unknown as object, calls: 1 }]);
    } finally {
      await rt.stop();
    }
  }, 60_000);
});
