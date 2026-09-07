// Tool names on the wire, and the run that made this necessary.
//
// Our tools are named with a dot — `web.search`, `memory.search`, `fs.read` — and that name is what the grants
// file, the Tools screen, every agent definition and every trace use. Anthropic requires
// `^[a-zA-Z0-9_-]{1,128}$` and OpenAI the same to 64 characters, so a request carrying one is rejected whole:
//
//     tools.0.custom.name: String should match pattern '^[a-zA-Z0-9_-]{1,128}$'
//
// Google allows the dot, which is why this stayed hidden until an Anthropic call got far enough to carry a
// tool at all — the owner's research briefing, the moment the thinking-capability fix let Haiku answer.
//
// The dot is translated at the boundary and nowhere else. These tests assert on the JSON that would actually
// reach the provider, because the bug was invisible in every layer above it.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { AnthropicAdapter } from '../../src/runtime/models/adapters/anthropic/index.js';
import { wireSafeNaming } from '../../src/runtime/models/adapters/shared/aisdk.js';
import { CatalogEntry, ModelsFile, type ToolSpec } from '../../src/shared/model.js';
import { readJsonFile } from '../../src/runtime/workspace/config.js';
import { packagePaths } from '../../src/runtime/paths.js';

const catalog = ModelsFile.parse(readJsonFile(path.join(packagePaths().defaults, 'models.json')));
const entry = CatalogEntry.parse(catalog.models.find((m) => m.id === 'anthropic/claude-haiku-4-5'));

const ANTHROPIC_TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/;
const TOOLS: ToolSpec[] = [
  { name: 'web.search', description: 'search the web', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
  { name: 'memory.search', description: 'search memory', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
  { name: 'fs.read', description: 'read a file', inputSchema: { type: 'object', properties: { p: { type: 'string' } } } },
];

interface WireBody { tools?: { name: string }[]; messages?: { role: string; content: { type: string; name?: string; id?: string; tool_use_id?: string }[] }[] }

async function wire(messages: Parameters<AnthropicAdapter['generate']>[1]['messages']): Promise<WireBody> {
  const captured: { body?: unknown } = {};
  const fetchImpl = (async (_i: string | URL | Request, init?: RequestInit) => {
    captured.body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      id: 'msg', type: 'message', role: 'assistant', model: 'claude-haiku-4-5',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'web_search', input: { q: 'hi' } }],
      stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const res = await new AnthropicAdapter().generate(entry, {
    system: 'be brief', messages, tools: TOOLS, abortSignal: new AbortController().signal,
  }, { fetch: fetchImpl, apiKey: 'test-key-not-a-secret', runId: 'r1' });
  return { ...(captured.body as WireBody), ...({ _res: res } as object) } as WireBody;
}

describe('a dotted tool name never reaches a provider that refuses one', () => {
  it('every declared tool matches the pattern Anthropic states', async () => {
    const body = await wire([{ role: 'user', content: [{ type: 'text', text: 'find something' }] }]);
    expect(body.tools?.length).toBe(3);
    for (const t of body.tools!) expect(t.name, `${t.name} is a name Anthropic accepts`).toMatch(ANTHROPIC_TOOL_NAME);
    expect(body.tools!.map((t) => t.name).sort()).toEqual(['fs_read', 'memory_search', 'web_search']);
  });

  it('a tool call comes back under its canonical, dotted name — the engine never learns of the rename', async () => {
    const captured: { body?: unknown } = {};
    const fetchImpl = (async (_i: string | URL | Request, init?: RequestInit) => {
      captured.body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: 'msg', type: 'message', role: 'assistant', model: 'claude-haiku-4-5',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'web_search', input: { q: 'hi' } }],
        stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const res = await new AnthropicAdapter().generate(entry, {
      system: 'be brief', messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      tools: TOOLS, abortSignal: new AbortController().signal,
    }, { fetch: fetchImpl, apiKey: 'test-key-not-a-secret', runId: 'r1' });

    const call = res.content.find((b) => b.type === 'tool-call');
    expect(call, 'the model asked for a tool').toBeDefined();
    // This is the assertion the permission check depends on: a grant is written against `web.search`.
    expect((call as { name: string }).name).toBe('web.search');
  });

  it('turn two: a replayed tool call and its result go out renamed as well', async () => {
    // The hole a declarations-only fix would have left — it fails on the second turn and nowhere else.
    const body = await wire([
      { role: 'user', content: [{ type: 'text', text: 'find something' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'tu_1', name: 'web.search', input: { q: 'x' } }] },
      { role: 'tool', content: [{ type: 'tool-result', callId: 'tu_1', ok: true, output: { hits: [] }, providerMeta: { toolName: 'web.search' } }] },
      { role: 'user', content: [{ type: 'text', text: 'and now?' }] },
    ]);
    const names: string[] = [];
    for (const m of body.messages ?? []) for (const part of m.content) if (part.name) names.push(part.name);
    expect(names.length, 'the replayed call names itself on the wire').toBeGreaterThan(0);
    for (const n of names) expect(n, `${n} in the replayed transcript`).toMatch(ANTHROPIC_TOOL_NAME);
    expect(names).toContain('web_search');
  });
});

describe('the naming is total and reversible', () => {
  it('round-trips every tool it was built from', () => {
    const naming = wireSafeNaming(TOOLS);
    for (const t of TOOLS) {
      expect(naming.toWire(t.name)).toMatch(ANTHROPIC_TOOL_NAME);
      expect(naming.toCanonical(naming.toWire(t.name))).toBe(t.name);
    }
  });

  it('two names that would flatten together are told apart rather than merged', () => {
    const naming = wireSafeNaming([
      { name: 'web.search', description: '', inputSchema: {} },
      { name: 'web_search', description: '', inputSchema: {} },
    ]);
    const a = naming.toWire('web.search');
    const b = naming.toWire('web_search');
    expect(a).not.toBe(b);
    expect(naming.toCanonical(a)).toBe('web.search');
    expect(naming.toCanonical(b)).toBe('web_search');
  });

  it('a name it never offered comes back untouched, so an invented tool is refused by its real name', () => {
    const naming = wireSafeNaming(TOOLS);
    expect(naming.toCanonical('something_invented')).toBe('something_invented');
  });

  it('is stable for the same tool set, so a cached prefix stays cached', () => {
    expect(wireSafeNaming(TOOLS).toWire('memory.search')).toBe(wireSafeNaming(TOOLS).toWire('memory.search'));
  });
});
