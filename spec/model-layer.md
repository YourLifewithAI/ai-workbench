# Model layer

*Prose cap: 800 words. Decisions cited: D-01 … D-08, D-37.*

The harness talks to exactly one interface. Adapters translate at the boundary and nothing provider-shaped leaks past them (D-01). The types below live in `src/shared/model.ts` and are the contract the suite tests.

## Canonical types

```ts
type Role = 'system' | 'user' | 'assistant' | 'tool';

type ContentBlock =
  | { type: 'text'; text: string; providerMeta?: Meta }
  | { type: 'image'; mimeType: string; data: Uint8Array | { url: string }; providerMeta?: Meta }
  | { type: 'file'; mimeType: string; name: string; data: Uint8Array; providerMeta?: Meta }
  | { type: 'tool-call'; id: string; name: string; input: unknown; providerMeta?: Meta }
  | { type: 'tool-result'; callId: string; ok: boolean; output: unknown; providerMeta?: Meta }
  | { type: 'reasoning'; text?: string; opaque: true; providerId: string; providerMeta?: Meta };

interface Message { role: Role; content: ContentBlock[]; providerMeta?: Meta }
type Meta = Record<string, unknown>;

interface ModelRequest {
  system: string;                      // rendered prompt sections (agents-and-prompts.md)
  messages: Message[];
  tools?: ToolSpec[];                  // { name, description, inputSchema: JsonSchema } derived from tool definitions
  outputSchema?: JsonSchema;           // structured output request
  maxOutputTokens?: number; temperature?: number;
  providerOptions?: Meta;              // adapter-specific knobs, never read by the engine
  abortSignal: AbortSignal;
}

interface Usage { input: number; output: number; cachedInput?: number; reasoning?: number; raw: Meta }
type FinishReason = 'stop' | 'length' | 'tool-calls' | 'content-filter' | 'error' | 'cancelled';

interface ModelResponse { content: ContentBlock[]; finishReason: FinishReason; usage: Usage; providerMeta?: Meta }

type ModelEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call-start'; id: string; name: string }
  | { type: 'tool-call-delta'; id: string; inputText: string }
  | { type: 'tool-call-end'; id: string; input: unknown }
  | { type: 'usage'; usage: Usage }
  | { type: 'finish'; reason: FinishReason; response: ModelResponse }
  | { type: 'error'; error: ModelError };

interface ModelAdapter {
  id: string;                          // 'google' | 'openai-compatible' | 'anthropic' | 'mock'
  generate(model: CatalogEntry, req: ModelRequest, ctx: AdapterContext): Promise<ModelResponse>;
  stream(model: CatalogEntry, req: ModelRequest, ctx: AdapterContext): AsyncIterable<ModelEvent>;
}
interface AdapterContext { fetch: typeof fetch; apiKey?: string }   // injected; adapters never read env or call global fetch
type CatalogEntry = z.infer<typeof CatalogEntrySchema>;              // one element of models.json below
type JsonSchema = Record<string, unknown>;                            // JSON Schema draft 2020-12 object
```

## Known abstraction leaks and the rule for each (D-02)

1. **Reasoning signatures.** Providers return thinking blocks that must be replayed verbatim on the next turn, and only to the same provider. They are stored as `reasoning` blocks with `opaque: true` and `providerId`. On a cross-provider fallback they are dropped and a `provider-meta-dropped` event records it (D-04).
2. **Structured output dialects.** `structuredOutput` is a capability enum, not a boolean. The engine always validates the response against `outputSchema` itself and performs one repair turn on failure, whatever the provider claims.
3. **Cache control.** Cache breakpoints are `providerMeta` on blocks; adapters that support caching apply them, others ignore them. `usage.cachedInput` is normalized when reported.
4. **Streaming deltas.** The event set is fixed (D-03). An adapter that cannot produce tool-call deltas emits `tool-call-start` and `tool-call-end` only.

## Capabilities

```ts
interface ModelCapabilities {
  text: true; vision: boolean; audioInput: boolean;
  toolCalling: 'none' | 'basic' | 'parallel';
  structuredOutput: 'none' | 'json' | 'schema';
  streaming: boolean; reasoning: 'none' | 'opaque' | 'visible';
  contextTokens: number; maxOutputTokens?: number;
}
```

Capabilities are catalog data, declared per model and verified by the contract suite. The engine filters candidates by the agent's requirements and never asks "which model is best".

## Errors and fallback (D-04, D-05)

```ts
type ModelErrorCode = 'Authentication' | 'RateLimit' | 'ContextLength' | 'ModelUnavailable'
  | 'ContentFilter' | 'Network' | 'Timeout' | 'NetworkPolicy' | 'SchemaValidation' | 'Unknown';
interface ModelError { code: ModelErrorCode; message: string; retryable: boolean;
  action: 'retry' | 'fallback' | 'abort'; providerError?: Meta }
```

Errors are raised as `<Code>Error` classes (`RateLimitError`, `NetworkPolicyError`, …) carrying this shape. Default `code → action`: `RateLimit`, `Timeout`, `Network` → `retry`; `ModelUnavailable`, `ContentFilter`, `ContextLength`, `Unknown` → `fallback`; `Authentication`, `NetworkPolicy` → `abort`; `SchemaValidation` → one repair turn then `retry`. A fixture's `error` field uses the code; adapters may override the action per provider. Selection (D-06): candidates = the step's `model` override if present, else the agent's `modelPolicy.primary`, followed by the agent's `fallbacks[]`; each is filtered by the agent's `modelPolicy.requires` and the current network mode. A call retries the same model up to twice with backoff when `action = 'retry'`, then moves to the next candidate when `action = 'fallback'`, only between steps or before the first token of a step. A step that already streamed output is aborted (`model-aborted`) and rerun on the next candidate from its start. Every transition is an event.

## Catalog (D-08)

```jsonc
// <workspace>/config/models.json — user data, seeded from defaults/models.json
{ "schemaVersion": 1, "models": [{
  "id": "google/gemini-2.5-pro", "adapter": "google", "enabled": true, "locality": "cloud",
  "capabilities": { /* ModelCapabilities */ },
  "pricing": [{ "effectiveFrom": "2026-01-01", "inputPerM": 1.25, "outputPerM": 10, "cachedPerM": 0.31 }],
  "dataPolicy": { "trainsOnContent": "no", "retentionDays": 30, "policyUrl": "…" }
}, { "id": "ollama/qwen3:14b", "adapter": "openai-compatible", "baseUrl": "http://127.0.0.1:11434/v1",
  "locality": "local", "capabilities": { /* … */ }, "pricing": [], "dataPolicy": { "trainsOnContent": "no" } },
 { "id": "mock/echo", "adapter": "mock", "locality": "local", "capabilities": { /* everything */ },
  "pricing": [], "dataPolicy": { "trainsOnContent": "no" } }]}
```

Cost is computed at call time from the price row in effect (0 when `pricing` is empty) and stored on the model call; the UI never recomputes history. Ollama availability is polled through its management API and shown, not assumed. `defaults/models.json` ships `mock/echo` plus a starter set of cloud and Ollama entries; `init` copies it.

## Adapters (D-01, D-07)

One file per adapter over the matching `@ai-sdk/*` package. Rules: the SDK is used for single invocations (`generateText`/`streamText` without its tool loop); a custom `fetch` is injected so every call passes the egress checker and is logged; the adapter maps SDK output to canonical types and never exports an SDK type; unsupported capabilities are declared, never faked; where the provider supports explicit caching, the adapter places one breakpoint after the stable prefix (D-46) and reports `usage.cachedInput`.

## Contract suite

One suite, run against every adapter: text generation, streaming event order, tool call round-trip, structured output (or declared unsupported), each error code mapped, usage reported, capabilities declared truthfully, cancellation honored. It runs against the mock provider in CI and against a live provider with `npm run contract -- --live <adapter>` when a key is present (explicit skip with reason otherwise). Recorded fixtures must back non-live runs of real adapters so the suite is green in CI for every adapter.

## Mock provider (D-37)

Native, no SDK. It serves any catalog id (so `--provider mock` keeps per-step model ids distinguishable) and is scripted by JSON files in `<workspace>/fixtures/` — one object per file, tried in filename order, first match wins; `callIndex` counts that model id's calls within the run, 1-based:

```jsonc
{ "match":   { "modelId": "google/*", "systemIncludes": "Ruthless editor", "lastUserIncludes": "premise", "callIndex": 2 },  // all optional, all must hold
  "respond": { "text": "…", "toolCalls": [{ "name": "calc", "input": { "expr": "1+1" } }], "json": { },
               "error": "RateLimit", "finishReason": "stop", "latencyMs": 50, "usage": { "input": 10, "output": 5 } } }
```

> Amendment (RUN-02, 2026-09-03): `respond.failAfterChars` streams that many characters and then raises `error`, which
> is the mid-stream failure a fallback has to recover from — the case the engine handles by aborting the step and
> rerunning it from the start on the next candidate.

> Amendment (RUN-01, 2026-09-03): `respond.chunkDelayMs` paces the streamed chunks, so the example workspace can
> demonstrate streaming — and an e2e case can assert it — with no provider key. `latencyMs` still delays the
> whole call.

With no matching fixture the mock echoes the last user text. It streams when asked, honors cancellation, and records every call in memory so tests can assert call counts. When its catalog entry has a `baseUrl`, the mock performs a real HTTP round trip to it through the injected `fetch`; the mock adapter itself starts a tiny loopback listener ("mock upstream") on an OS-assigned port at runtime start and the catalog entry's `baseUrl` is rewritten to it, so egress logging, redaction, the declared-endpoint path, and the Privacy Inspector are exercised end to end without a cloud provider and without touching the runtime's own port. Under `--provider mock`, cost is still computed from the *requested* catalog id's price rows, so budget tests work; `mock/echo` has no pricing and costs 0. Every DoD, e2e test, and example runs on it with zero keys and zero cost.
