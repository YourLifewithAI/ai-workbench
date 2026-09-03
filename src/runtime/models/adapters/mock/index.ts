// The mock provider (D-37): native, scripted by <workspace>/fixtures/*.json, serves any catalog id.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { CatalogEntry, ContentBlock, ModelEvent, ModelRequest, ModelResponse, Usage } from '../../../../shared/model.js';
import { FinishReason, ModelErrorCode } from '../../../../shared/model.js';
import type { ModelErrorCode as ModelErrorCodeType } from '../../../../shared/model.js';
import type { AdapterContext, ModelAdapter } from '../../adapter.js';
import { ModelError, modelError } from '../../errors.js';

// Strict on purpose: an empty `match` matches every call, so a JSON file in `fixtures/` that is not a model
// fixture would silently become a catch-all. Unknown keys are a loud load-time error instead. Anything else
// that wants to live under `fixtures/` puts itself in a subdirectory, which this loader does not read.
const Fixture = z.strictObject({
  match: z.strictObject({
    modelId: z.string().optional(),
    systemIncludes: z.string().optional(),
    lastUserIncludes: z.string().optional(),
    /** Matches once the transcript already contains a call to this tool: the turn *after* the tool ran. */
    afterTool: z.string().optional(),
    /**
     * Which call of the run this is. It counts every call the run makes to this model, across steps, so a
     * workflow whose steps run in parallel cannot use it to script one step: use `afterTool` there instead.
     */
    callIndex: z.number().int().positive().optional(),
  }).prefault({}),
  respond: z.strictObject({
    text: z.string().optional(),
    json: z.unknown().optional(),
    toolCalls: z.array(z.object({ name: z.string(), input: z.unknown() })).optional(),
    error: ModelErrorCode.optional(),
    finishReason: FinishReason.optional(),
    latencyMs: z.number().int().nonnegative().optional(),
    /** Pause between streamed chunks, so a fixture can demonstrate streaming rather than arriving all at once. */
    chunkDelayMs: z.number().int().nonnegative().optional(),
    /** Stream this many characters, then raise `error`: the mid-stream failure a fallback has to recover from. */
    failAfterChars: z.number().int().nonnegative().optional(),
    usage: z.strictObject({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative() }).optional(),
  }).prefault({}),
});
export type Fixture = z.infer<typeof Fixture>;

export interface MockCall { modelId: string; runId: string | undefined; fixture: string | null; request: Omit<ModelRequest, 'abortSignal'>; ts: string }

export class MockAdapter implements ModelAdapter {
  readonly id = 'mock';
  readonly calls: MockCall[] = [];
  private fixtures: { name: string; fixture: Fixture }[] = [];
  private readonly counts = new Map<string, number>();

  constructor(private readonly fixturesDir: string | null) {
    this.reload();
  }

  reload(): void {
    this.fixtures = [];
    if (!this.fixturesDir || !fs.existsSync(this.fixturesDir)) return;
    for (const name of fs.readdirSync(this.fixturesDir).filter((f) => f.endsWith('.json')).sort()) {
      const raw = JSON.parse(fs.readFileSync(path.join(this.fixturesDir, name), 'utf8'));
      const parsed = Fixture.safeParse(raw);
      if (!parsed.success) throw new Error(`${path.join(this.fixturesDir, name)}: invalid fixture: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
      this.fixtures.push({ name, fixture: parsed.data });
    }
  }

  private modelName(catalogId: string): string {
    const slash = catalogId.indexOf('/');
    return slash === -1 ? catalogId : catalogId.slice(slash + 1);
  }

  private lastUserText(req: ModelRequest): string {
    for (let i = req.messages.length - 1; i >= 0; i--) {
      const m = req.messages[i]!;
      if (m.role === 'user') return m.content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('\n');
    }
    return '';
  }

  private select(model: CatalogEntry, req: ModelRequest, ctx: AdapterContext): { name: string; fixture: Fixture } | null {
    const key = `${ctx.runId ?? '-'}|${model.id}`;
    const index = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, index);
    const lastUser = this.lastUserText(req);
    const called = calledTools(req);
    for (const f of this.fixtures) {
      const m = f.fixture.match;
      if (m.modelId && !globMatch(m.modelId, model.id)) continue;
      if (m.systemIncludes && !req.system.includes(m.systemIncludes)) continue;
      if (m.lastUserIncludes && !lastUser.includes(m.lastUserIncludes)) continue;
      if (m.afterTool && !called.has(m.afterTool)) continue;
      if (m.callIndex && m.callIndex !== index) continue;
      return f;
    }
    return null;
  }

  /** One selection per call: `select` advances the per-run callIndex, so it must not be called twice. */
  private async respond(model: CatalogEntry, req: ModelRequest, ctx: AdapterContext): Promise<{ response: ModelResponse; chunkDelayMs: number; failAfter?: { chars: number; code: ModelErrorCodeType; fixture: string | null } }> {
    // A catalog entry with a baseUrl makes the mock do one real round trip through the injected fetch, so the
    // egress checker, the egress log, and the Privacy Inspector are exercised without a cloud provider (D-37).
    if (model.baseUrl) {
      await ctx.fetch(`${model.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.modelName(model.id), messages: req.messages, stream: false }),
        // A cancel must reach the wire, not just the loop around it (SEC-29).
        signal: req.abortSignal,
      });
    }
    const chosen = this.select(model, req, ctx);
    const { abortSignal } = req;
    const record: MockCall = { modelId: model.id, runId: ctx.runId, fixture: chosen?.name ?? null, request: stripSignal(req), ts: new Date().toISOString() };
    this.calls.push(record);
    const r = chosen?.fixture.respond ?? {};
    if (r.latencyMs) await sleep(r.latencyMs, abortSignal);
    if (abortSignal.aborted) throw modelError('Unknown', 'cancelled', { action: 'abort', retryable: false });
    if (r.error && r.failAfterChars === undefined) throw modelError(r.error, `mock fixture ${chosen?.name} raised ${r.error}`);
    const text = r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : this.lastUserText(req));
    const content: ContentBlock[] = [];
    if (text) content.push({ type: 'text', text });
    (r.toolCalls ?? []).forEach((tc, i) => content.push({ type: 'tool-call', id: `call_${this.calls.length}_${i + 1}`, name: tc.name, input: tc.input }));
    const usage: Usage = {
      input: r.usage?.input ?? Math.ceil((req.system.length + JSON.stringify(req.messages).length) / 4),
      output: r.usage?.output ?? Math.ceil(text.length / 4),
      raw: { mock: true, fixture: chosen?.name ?? null },
    };
    const finishReason = r.finishReason ?? (r.toolCalls?.length ? 'tool-calls' : 'stop');
    return { response: { content, finishReason, usage }, chunkDelayMs: r.chunkDelayMs ?? 0, ...(r.error ? { failAfter: { chars: r.failAfterChars ?? 0, code: r.error, fixture: chosen?.name ?? null } } : {}) };
  }

  async generate(model: CatalogEntry, req: ModelRequest, ctx: AdapterContext): Promise<ModelResponse> {
    return (await this.respond(model, req, ctx)).response;
  }

  async *stream(model: CatalogEntry, req: ModelRequest, ctx: AdapterContext): AsyncIterable<ModelEvent> {
    try {
      const { response, chunkDelayMs, failAfter } = await this.respond(model, req, ctx);
      const text = response.content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('');
      const chunkSize = Math.max(1, Math.ceil(text.length / (chunkDelayMs ? 12 : 4)));
      for (let i = 0; i < text.length; i += chunkSize) {
        if (req.abortSignal.aborted) { yield { type: 'error', error: modelError('Unknown', 'cancelled', { action: 'abort', retryable: false }).toShape() }; return; }
        if (chunkDelayMs && i > 0) await sleep(chunkDelayMs, req.abortSignal);
        // A mid-stream failure: the step has already shown text, so the engine must abort it and start over
        // on the next candidate rather than resume (D-04).
        if (failAfter && i >= failAfter.chars) {
          throw modelError(failAfter.code, `mock fixture ${failAfter.fixture} raised ${failAfter.code} after ${i} characters`);
        }
        yield { type: 'text-delta', text: text.slice(i, i + chunkSize) };
      }
      if (failAfter) throw modelError(failAfter.code, `mock fixture ${failAfter.fixture} raised ${failAfter.code}`);
      for (const b of response.content) {
        if (b.type === 'tool-call') { yield { type: 'tool-call-start', id: b.id, name: b.name }; yield { type: 'tool-call-end', id: b.id, input: b.input }; }
      }
      yield { type: 'usage', usage: response.usage };
      yield { type: 'finish', reason: response.finishReason, response };
    } catch (e) {
      const err = e instanceof ModelError ? e.toShape() : modelError('Unknown', String(e)).toShape();
      yield { type: 'error', error: err };
    }
  }
}

/** Every tool this conversation has already called, so a fixture can script the turn after a tool ran. */
function calledTools(req: ModelRequest): Set<string> {
  const names = new Set<string>();
  for (const message of req.messages) {
    for (const block of message.content) if (block.type === 'tool-call') names.add(block.name);
  }
  return names;
}

function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(value);
}

function stripSignal(req: ModelRequest): Omit<ModelRequest, 'abortSignal'> {
  const { abortSignal: _ignored, ...rest } = req;
  void _ignored;
  return rest;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); resolve(); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
