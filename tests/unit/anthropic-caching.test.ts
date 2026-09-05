// Prompt caching on the Anthropic adapter (D-46): what actually goes over the wire. A fake fetch captures the
// request the SDK builds, so the breakpoints are asserted on the JSON Anthropic would receive rather than on
// anything the adapter says about itself.
import { describe, it, expect } from 'vitest';
import { AnthropicAdapter } from '../../src/runtime/models/adapters/anthropic/index.js';
import { assemblePrompt } from '../../src/runtime/engine/prompt.js';
import { computeCost } from '../../src/runtime/models/catalog.js';
import { CatalogEntry, ModelsFile } from '../../src/shared/model.js';
import type { LoadedAgent } from '../../src/shared/agent.js';
import { readJsonFile } from '../../src/runtime/workspace/config.js';
import { packagePaths } from '../../src/runtime/paths.js';
import path from 'node:path';

const catalog = ModelsFile.parse(readJsonFile(path.join(packagePaths().defaults, 'models.json')));
const entry = CatalogEntry.parse(catalog.models.find((m) => m.id === 'anthropic/claude-opus-5'));

const agent = {
  definition: { id: 'echo', name: 'The Echo', description: 'says it back', permissions: {} },
  sections: [{ name: 'task', text: 'Repeat what you are told, then stop.' }],
  version: 'sha256:test',
  dir: '/nowhere',
} as unknown as LoadedAgent;

function fakeFetch(captured: { body?: unknown }): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    captured.body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5',
      content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

describe('prompt caching on the Anthropic adapter (D-46)', () => {
  it('the assembled prompt says where the stable prefix ends: just before the harness', () => {
    const prompt = assemblePrompt(agent, 'say hi', 'Budget remaining: 59 model calls · $2.00 · 29m 59s.');
    const { system, cacheBoundary } = prompt.compiled;
    expect(cacheBoundary).toBeGreaterThan(0);
    expect(system.slice(0, cacheBoundary)).toContain('## task');
    expect(system.slice(0, cacheBoundary)).not.toContain('Budget remaining');
    expect(system.slice(cacheBoundary!)).toMatch(/^\n\n## harness\n/);
  });

  it('puts one breakpoint after the stable prefix, none on the harness, and one on the last message', async () => {
    const captured: { body?: unknown } = {};
    const prompt = assemblePrompt(agent, 'say hi', 'Budget remaining: 59 model calls.');
    const adapter = new AnthropicAdapter();
    const response = await adapter.generate(entry, {
      ...prompt.compiled,
      messages: [
        ...prompt.compiled.messages,
        { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
        { role: 'user', content: [{ type: 'text', text: 'again' }] },
      ],
      tools: [{ name: 'calc', description: 'adds', inputSchema: { type: 'object', properties: { a: { type: 'number' } } } }],
      abortSignal: new AbortController().signal,
    }, { fetch: fakeFetch(captured), apiKey: 'test-key-not-a-secret', runId: 'r1' });

    const body = captured.body as { system: { text: string; cache_control?: { type: string } }[]; messages: { role: string; content: { type: string; cache_control?: { type: string } }[] }[]; tools: unknown[] };
    expect(Array.isArray(body.system)).toBe(true);
    expect(body.system).toHaveLength(2);
    expect(body.system[0]!.text).toContain('## task');
    expect(body.system[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(body.system[1]!.text).toMatch(/^## harness/);
    expect(body.system[1]!.text).toContain('Budget remaining');
    expect(body.system[1]!.cache_control, 'the volatile part is after the breakpoint, never inside it').toBeUndefined();
    // The moving breakpoint: on the last message, and only there.
    const last = body.messages[body.messages.length - 1]!;
    expect(last.role).toBe('user');
    expect(last.content[last.content.length - 1]!.cache_control).toEqual({ type: 'ephemeral' });
    for (const m of body.messages.slice(0, -1)) for (const part of m.content) expect(part.cache_control).toBeUndefined();
    expect(body.tools.length).toBe(1);

    // What came back is priced with the cached and written tokens told apart.
    expect(response.usage).toMatchObject({ input: 115, output: 2, cachedInput: 100, cacheWriteInput: 5 });
    const cost = computeCost(entry, response.usage, new Date('2026-09-01'));
    // 10 uncached at $5/M + 100 cached at $0.50/M + 5 written at $6.25/M + 2 out at $25/M
    expect(cost).toBeCloseTo((10 * 5 + 100 * 0.5 + 5 * 6.25 + 2 * 25) / 1_000_000, 10);
  });

  it('the shipped Anthropic entries carry a cached rate, and Fable 5.1 is in the catalog', () => {
    for (const id of ['anthropic/claude-fable-5-1', 'anthropic/claude-opus-5', 'anthropic/claude-sonnet-5', 'anthropic/claude-haiku-4-5']) {
      const m = catalog.models.find((x) => x.id === id);
      expect(m, id).toBeDefined();
      expect(m!.pricing[0]!.cachedPerM, `${id} cached rate`).toBeGreaterThan(0);
      expect(m!.pricing[0]!.cachedPerM!).toBeLessThan(m!.pricing[0]!.inputPerM);
    }
  });
});
