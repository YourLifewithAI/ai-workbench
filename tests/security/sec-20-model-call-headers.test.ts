// SEC-20 (early partial, RUN-01): the credential header on the model-call path is never stored — not in the
// compiled request an event holds, not in a model_calls row, not in a recorded contract fixture.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { GoogleAdapter } from '../../src/runtime/models/adapters/google/index.js';
import { ModelsFile } from '../../src/shared/model.js';
import { packagePaths } from '../../src/runtime/paths.js';
import { readJsonFile } from '../../src/runtime/workspace/config.js';
import { findModel } from '../../src/runtime/models/catalog.js';
import { replayFetch } from '../contract/recorder.js';
import { startRuntime, tempWorkspace } from '../helpers/workspace.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '..', 'contract', 'fixtures', 'google');
const catalog = ModelsFile.parse(readJsonFile(path.join(packagePaths().defaults, 'models.json')));
const model = findModel(catalog, 'google/gemini-2.5-flash')!;

describe('SEC-20 the model-call path stores no credential header (and SEC-06 through the real adapter)', () => {
  it('a run through the real adapter leaves the key nowhere in the trace, the rows, or the log', async () => {
    const ws = tempWorkspace('sec20');
    const KEY = `AIzaFake${randomBytes(16).toString('hex')}`;
    fs.writeFileSync(path.join(ws, 'config', 'credentials.json'), JSON.stringify({ google: { apiKey: KEY } }), { mode: 0o600 });
    // The echo agent is repointed at Gemini so the run goes through the Google adapter, replaying recorded HTTP.
    const agent = path.join(ws, 'agents', 'echo', 'agent.json');
    const definition = JSON.parse(fs.readFileSync(agent, 'utf8')) as { modelPolicy: { primary: string } };
    definition.modelPolicy.primary = 'google/gemini-2.5-flash';
    fs.writeFileSync(agent, JSON.stringify(definition));

    const rt = await startRuntime(ws, { fetch: replayFetch(fixtures, 'stream') });
    try {
      // The key is also planted in the task, so this run re-verifies SEC-06 through the Google adapter's path.
      const { runId, done } = rt.runtime.engine.startAgentRun({ agentId: 'echo', inputs: { input: `Say hello to the contract suite. My key is ${KEY}.` } });
      await done;
      const run = rt.runtime.engine.getRun(runId);
      expect(run?.state, JSON.stringify(run?.error)).toBe('completed');

      const events = rt.runtime.db.prepare('SELECT payload_json FROM events').all() as { payload_json: string }[];
      for (const e of events) {
        expect(e.payload_json).not.toContain(KEY);
        expect(e.payload_json.toLowerCase()).not.toContain('x-goog-api-key');
        expect(e.payload_json.toLowerCase()).not.toContain('authorization');
      }
      const calls = rt.runtime.db.prepare('SELECT * FROM model_calls').all() as Record<string, unknown>[];
      expect(calls).toHaveLength(1);
      expect(JSON.stringify(calls)).not.toContain(KEY);
      expect(JSON.stringify(calls).toLowerCase()).not.toContain('x-goog-api-key');

      const trace = await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}/trace.jsonl`, { headers: { Authorization: `Bearer ${rt.token}` } })).text();
      expect(trace).not.toContain(KEY);
      expect(trace).toContain('[REDACTED:credential:google]');
    } finally {
      await rt.stop();
    }
    expect(fs.readFileSync(path.join(ws, 'data', 'logs', 'runtime.log'), 'utf8')).not.toContain(KEY);
  }, 60_000);

  it('the adapter sends the key as a header and it never reaches a recorded fixture', async () => {
    const KEY = `AIzaFake${randomBytes(16).toString('hex')}`;
    const seen: Record<string, string>[] = [];
    const adapter = new GoogleAdapter();
    await adapter.generate(model, {
      system: 'test', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [], abortSignal: new AbortController().signal,
    }, {
      apiKey: KEY,
      runId: 'sec20',
      fetch: async (input, init) => {
        const headers: Record<string, string> = {};
        new Headers((init?.headers ?? (input instanceof Request ? input.headers : {})) as HeadersInit).forEach((v, k) => { headers[k] = v; });
        seen.push(headers);
        return replayFetch(fixtures, 'text')(input, init);
      },
    });
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0]!).map((k) => k.toLowerCase()), 'the adapter authenticates with a header').toContain('x-goog-api-key');
    expect(seen[0]!['x-goog-api-key']).toBe(KEY);

    for (const file of fs.readdirSync(fixtures)) {
      const text = fs.readFileSync(path.join(fixtures, file), 'utf8');
      expect(text.toLowerCase(), `${file} records no request headers`).not.toContain('x-goog-api-key');
      expect(text.toLowerCase(), `${file} records no authorization header`).not.toContain('"authorization"');
    }
  });
});
