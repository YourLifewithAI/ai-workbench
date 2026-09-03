import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { packagePaths } from '../../src/runtime/paths.js';
import { readJsonFile } from '../../src/runtime/workspace/config.js';
import { findModel } from '../../src/runtime/models/catalog.js';
import { MockAdapter } from '../../src/runtime/models/adapters/mock/index.js';
import { ModelsFile, type ModelRequest, type ModelResponse } from '../../src/shared/model.js';
import { tempDir } from '../helpers/workspace.js';

const catalog = ModelsFile.parse(readJsonFile(path.join(packagePaths().defaults, 'models.json')));
const echo = findModel(catalog, 'mock/echo')!;
const ctx = { fetch: async () => { throw new Error('no network in tests'); }, apiKey: undefined, runId: 'r1' };
const req = (text: string): ModelRequest => ({ system: 'sys', messages: [{ role: 'user', content: [{ type: 'text', text }] }], tools: [], abortSignal: new AbortController().signal });
const textOf = (content: ModelResponse['content']): string => content.map((c) => (c.type === 'text' ? c.text : '')).join('');

describe('mock provider (D-37)', () => {
  it('echoes the last user text when no fixture matches', async () => {
    const mock = new MockAdapter(null);
    const res = await mock.generate(echo, req('ping'), ctx);
    expect(textOf(res.content)).toBe('ping');
    expect(res.finishReason).toBe('stop');
    expect(mock.calls).toHaveLength(1);
  });

  it('fixtures match on lastUserIncludes and can add latency or raise a normalized error', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'a-slow.json'), JSON.stringify({ match: { lastUserIncludes: 'slow' }, respond: { text: 'later', latencyMs: 120 } }));
    fs.writeFileSync(path.join(dir, 'b-boom.json'), JSON.stringify({ match: { lastUserIncludes: 'boom' }, respond: { error: 'RateLimit' } }));
    const mock = new MockAdapter(dir);
    const t0 = Date.now();
    const slow = await mock.generate(echo, req('be slow'), ctx);
    expect(textOf(slow.content)).toBe('later');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
    await expect(mock.generate(echo, req('boom'), ctx)).rejects.toMatchObject({ code: 'RateLimit', action: 'retry' });
  });

  it('streams the same answer as text deltas ending in a finish event', async () => {
    const mock = new MockAdapter(null);
    const events: string[] = [];
    let text = '';
    for await (const e of mock.stream(echo, req('stream me'), ctx)) {
      events.push(e.type);
      if (e.type === 'text-delta') text += e.text;
    }
    expect(text).toBe('stream me');
    expect(events[events.length - 1]).toBe('finish');
  });
});
