// How the adapter asks for thinking, and the bug that made this file exist.
//
// Anthropic changed the shape of the request at Claude 4.6. From there on a model takes `{ type: 'adaptive' }`
// and refuses a fixed budget; an older one — Haiku 4.5 — takes `budget_tokens` and refuses `adaptive` with a
// 400. The adapter used to send `adaptive` to every model whose `capabilities.reasoning !== 'none'`, which is
// all four of them, so every Anthropic fallback died: an owner's research briefing failed with "adaptive
// thinking is not supported on this model" after Gemini was unavailable and Haiku was the next candidate, and
// because `fast` and `cheap` both lead with those two, no cheap step could complete at all.
//
// The assertions are on the JSON that would reach Anthropic, captured by a fake fetch, because what the
// adapter believes about itself is exactly what was wrong.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { AnthropicAdapter } from '../../src/runtime/models/adapters/anthropic/index.js';
import { assemblePrompt } from '../../src/runtime/engine/prompt.js';
import { CatalogEntry, ModelsFile } from '../../src/shared/model.js';
import type { LoadedAgent } from '../../src/shared/agent.js';
import { readJsonFile } from '../../src/runtime/workspace/config.js';
import { packagePaths } from '../../src/runtime/paths.js';

const catalog = ModelsFile.parse(readJsonFile(path.join(packagePaths().defaults, 'models.json')));
const entryFor = (id: string): CatalogEntry => CatalogEntry.parse(catalog.models.find((m) => m.id === id));

const agent = {
  definition: { id: 'echo', name: 'The Echo', description: 'says it back', permissions: {} },
  sections: [{ name: 'task', text: 'Repeat what you are told, then stop.' }],
  version: 'sha256:test',
  dir: '/nowhere',
} as unknown as LoadedAgent;

interface Body { thinking?: { type?: string; budget_tokens?: number }; max_tokens?: number }

async function bodyFor(id: string): Promise<Body> {
  const captured: { body?: unknown } = {};
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    captured.body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      id: 'msg_test', type: 'message', role: 'assistant', model: id,
      content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const prompt = assemblePrompt(agent, 'say hi', 'Budget remaining: 59 model calls.');
  await new AnthropicAdapter().generate(entryFor(id), {
    ...prompt.compiled,
    abortSignal: new AbortController().signal,
  }, { fetch: fetchImpl, apiKey: 'test-key-not-a-secret', runId: 'r1' });
  return captured.body as Body;
}

describe('asking Anthropic for thinking in the shape the model accepts', () => {
  it('a 4.6-and-newer model is asked with adaptive thinking', async () => {
    for (const id of ['anthropic/claude-opus-5', 'anthropic/claude-sonnet-5', 'anthropic/claude-fable-5-1']) {
      const body = await bodyFor(id);
      expect(body.thinking?.type, `${id} takes adaptive`).toBe('adaptive');
      expect(body.thinking?.budget_tokens, `${id} must not be given a fixed budget`).toBeUndefined();
    }
  });

  it('Haiku 4.5 is asked with a fixed budget and never with adaptive — the exact regression', async () => {
    const body = await bodyFor('anthropic/claude-haiku-4-5');
    expect(body.thinking?.type, 'the older form is `enabled` with a budget').not.toBe('adaptive');
    expect(body.thinking?.budget_tokens, 'and the budget is a real number of tokens').toBeGreaterThanOrEqual(1024);
    // A budget that does not leave room to answer is rejected as surely as the wrong mode.
    if (body.max_tokens !== undefined) expect(body.thinking!.budget_tokens!).toBeLessThan(body.max_tokens);
  });

  it('every shipped Anthropic entry says which form it takes, so none of them is guessed at', () => {
    const anthropic = catalog.models.filter((m) => m.adapter === 'anthropic');
    expect(anthropic.length).toBeGreaterThan(0);
    for (const m of anthropic) {
      expect(m.capabilities.thinking, `${m.id} declares how to ask for thinking`).toBeDefined();
      expect(['adaptive', 'budget', 'none']).toContain(m.capabilities.thinking);
    }
  });

  it('a model that does not say is asked for no thinking at all, rather than guessed at', async () => {
    // The whole point of the field: silence degrades to a plain call, a guess is a 400 that kills the step.
    const silent = { ...entryFor('anthropic/claude-haiku-4-5') };
    silent.capabilities = { ...silent.capabilities };
    delete (silent.capabilities as { thinking?: unknown }).thinking;

    const captured: { body?: unknown } = {};
    const fetchImpl = (async (_i: string | URL | Request, init?: RequestInit) => {
      captured.body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: 'm', type: 'message', role: 'assistant', model: 'x', content: [{ type: 'text', text: 'hi' }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const prompt = assemblePrompt(agent, 'say hi', 'Budget remaining: 59 model calls.');
    await new AnthropicAdapter().generate(silent, { ...prompt.compiled, abortSignal: new AbortController().signal },
      { fetch: fetchImpl, apiKey: 'test-key-not-a-secret', runId: 'r1' });
    expect((captured.body as Body).thinking, 'no thinking parameter at all').toBeUndefined();
  });
});
