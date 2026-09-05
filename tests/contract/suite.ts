// One suite, every adapter (model-layer.md §Contract suite). What an adapter's catalog entry claims, this checks:
// text, streaming order, tool round-trip, structured output, usage, cancellation, and the error-code mapping.
import { describe, it, expect } from 'vitest';
import type { CatalogEntry, ModelEvent, ModelRequest, ToolSpec } from '../../src/shared/model.js';
import type { AdapterContext, FetchLike, ModelAdapter } from '../../src/runtime/models/adapter.js';
import { ModelError } from '../../src/runtime/models/errors.js';
import type { ModelErrorCode } from '../../src/shared/model.js';

export interface ContractCase {
  /** A fetch for this case: replayed from a fixture, recorded live, or a canned HTTP failure. */
  fetch: (name: string) => FetchLike;
  adapter: ModelAdapter;
  model: CatalogEntry;
  apiKey?: string | undefined;
  /** Cases whose fixtures do not exist yet are reported as skipped with this reason instead of failing. */
  skip?: (name: string) => string | null;
}

const WEATHER: ToolSpec = {
  name: 'get_weather',
  description: 'Current weather for a city.',
  inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
};

export function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    system: 'You are a test fixture. Answer in one short sentence.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Say hello to the contract suite.' }] }],
    tools: [],
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

export function runContractSuite(name: string, make: () => ContractCase): void {
  describe(`contract: ${name}`, () => {
    const ctxFor = (c: ContractCase, fixture: string): AdapterContext => ({ fetch: c.fetch(fixture), apiKey: c.apiKey, runId: 'contract' });

    /** Marks a case skipped (with the reason printed) rather than failing when its fixture is absent. */
    const withCase = async (fixture: string, body: (c: ContractCase, ctx: AdapterContext) => Promise<void>): Promise<void> => {
      const c = make();
      const reason = c.skip?.(fixture);
      if (reason) {
        console.log(`contract: ${name}/${fixture} skipped — ${reason}`);
        return;
      }
      await body(c, ctxFor(c, fixture));
    };

    it('lists what the provider offers, when it can', async () => {
      const c = make();
      if (!c.adapter.listModels) {
        console.log(`contract: ${name}/list-models skipped — this adapter cannot list, and its models stay hand-declared (D-64)`);
        return;
      }
      await withCase('list-models', async (cc, ctx) => {
        const models = await cc.adapter.listModels!(ctx);
        expect(models.length, 'a provider that can list offers something').toBeGreaterThan(0);
        for (const m of models) {
          expect(typeof m.id, 'an id is a string').toBe('string');
          expect(m.id.length).toBeGreaterThan(0);
          expect(m.id, 'the provider prefix is stripped so the catalog id is provider/<id>').not.toMatch(/^models\//);
          if (m.contextTokens !== undefined) expect(m.contextTokens).toBeGreaterThan(0);
        }
      });
    });

    it('generates text and reports usage', async () => {
      await withCase('text', async (c, ctx) => {
        const res = await c.adapter.generate(c.model, request(), ctx);
        const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
        expect(text.length).toBeGreaterThan(0);
        expect(res.finishReason).toBe('stop');
        expect(res.usage.input).toBeGreaterThan(0);
        expect(res.usage.output).toBeGreaterThan(0);
        expect(res.usage.raw).toBeTypeOf('object');
      });
    });

    it('streams deltas and finishes with the same text', async () => {
      await withCase('stream', async (c, ctx) => {
        expect(c.model.capabilities.streaming, 'this suite assumes a streaming model').toBe(true);
        const events: ModelEvent[] = [];
        for await (const e of c.adapter.stream(c.model, request(), ctx)) events.push(e);
        const types = events.map((e) => e.type);
        expect(types.filter((t) => t === 'text-delta').length, 'at least one text delta').toBeGreaterThan(0);
        expect(types[types.length - 1], 'finish is last').toBe('finish');
        expect(types.indexOf('usage'), 'usage precedes finish').toBeLessThan(types.length - 1);
        expect(types).not.toContain('error');
        const streamed = events.filter((e): e is Extract<ModelEvent, { type: 'text-delta' }> => e.type === 'text-delta').map((e) => e.text).join('');
        const finish = events[events.length - 1] as Extract<ModelEvent, { type: 'finish' }>;
        const finalText = finish.response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
        expect(finalText).toBe(streamed);
        expect(finish.response.usage.input).toBeGreaterThan(0);
      });
    });

    it('round-trips a tool call when the catalog says it can', async () => {
      await withCase('tool-call', async (c, ctx) => {
        if (c.model.capabilities.toolCalling === 'none') {
          const res = await c.adapter.generate(c.model, request({ tools: [WEATHER] }), ctx);
          expect(res.content.some((b) => b.type === 'tool-call'), 'a model that declares no tool calling must not emit one').toBe(false);
          return;
        }
        const res = await c.adapter.generate(c.model, request({
          messages: [{ role: 'user', content: [{ type: 'text', text: 'What is the weather in Chicago? Use the tool.' }] }],
          tools: [WEATHER],
        }), ctx);
        const call = res.content.find((b) => b.type === 'tool-call');
        expect(call, 'a tool call was requested').toBeDefined();
        if (call?.type === 'tool-call') {
          expect(call.name).toBe('get_weather');
          expect(call.id.length).toBeGreaterThan(0);
          expect(call.input).toMatchObject({ city: expect.stringContaining('Chicago') as unknown as string });
        }
        expect(res.finishReason).toBe('tool-calls');
      });
    });

    it('returns JSON when a schema is requested, or declares it cannot', async () => {
      await withCase('structured', async (c, ctx) => {
        if (c.model.capabilities.structuredOutput === 'none') return;
        const res = await c.adapter.generate(c.model, request({
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Give the city and its population.' }] }],
          outputSchema: { type: 'object', properties: { city: { type: 'string' }, population: { type: 'number' } }, required: ['city', 'population'], additionalProperties: false },
        }), ctx);
        const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
        const parsed = JSON.parse(text) as { city: unknown; population: unknown };
        expect(typeof parsed.city).toBe('string');
        expect(typeof parsed.population).toBe('number');
      });
    });

    it('honours cancellation', async () => {
      await withCase('text', async (c, ctx) => {
        const controller = new AbortController();
        controller.abort();
        const events: ModelEvent[] = [];
        for await (const e of c.adapter.stream(c.model, request({ abortSignal: controller.signal }), ctx)) events.push(e);
        const last = events[events.length - 1];
        const cancelled = last?.type === 'error' || (last?.type === 'finish' && last.reason === 'cancelled');
        expect(cancelled, `an aborted call ends in error or a cancelled finish, got ${last?.type ?? 'nothing'}`).toBe(true);
      });
    });
  });
}

/** The error half: an HTTP status in, a canonical code and action out (D-05). */
export function runErrorMappingSuite(name: string, make: (fetch: FetchLike) => { adapter: ModelAdapter; model: CatalogEntry; apiKey?: string | undefined }, cases: { status: number; body: string; code: ModelErrorCode; action?: 'retry' | 'fallback' | 'abort' }[]): void {
  if (cases.length === 0) return; // an adapter whose errors do not come from HTTP tests them its own way
  describe(`contract: ${name} error mapping`, () => {
    for (const testCase of cases) {
      it(`HTTP ${testCase.status} → ${testCase.code}`, async () => {
        const { adapter, model, apiKey } = make(async () => new Response(testCase.body, { status: testCase.status, headers: { 'content-type': 'application/json' } }));
        const error = await adapter.generate(model, request(), { fetch: async () => new Response(testCase.body, { status: testCase.status, headers: { 'content-type': 'application/json' } }), apiKey, runId: 'contract' })
          .then(() => null, (e: unknown) => e);
        expect(error, 'the call rejected').toBeInstanceOf(ModelError);
        const modelError = error as ModelError;
        expect(modelError.code).toBe(testCase.code);
        if (testCase.action) expect(modelError.action).toBe(testCase.action);
        expect(modelError.message.length).toBeGreaterThan(0);
      });
    }
  });
}
