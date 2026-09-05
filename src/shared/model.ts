// Canonical model types (spec/model-layer.md). Nothing provider-shaped crosses this boundary (D-01).
import { z } from 'zod';

export const Meta = z.record(z.string(), z.unknown());
export type Meta = z.infer<typeof Meta>;

export const Role = z.enum(['system', 'user', 'assistant', 'tool']);
export type Role = z.infer<typeof Role>;

export const ContentBlock = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string(), providerMeta: Meta.optional() }),
  z.object({
    type: z.literal('image'),
    mimeType: z.string(),
    data: z.union([z.instanceof(Uint8Array), z.object({ url: z.string() })]),
    providerMeta: Meta.optional(),
  }),
  z.object({ type: z.literal('file'), mimeType: z.string(), name: z.string(), data: z.instanceof(Uint8Array), providerMeta: Meta.optional() }),
  z.object({ type: z.literal('tool-call'), id: z.string(), name: z.string(), input: z.unknown(), providerMeta: Meta.optional() }),
  z.object({ type: z.literal('tool-result'), callId: z.string(), ok: z.boolean(), output: z.unknown(), providerMeta: Meta.optional() }),
  z.object({ type: z.literal('reasoning'), text: z.string().optional(), opaque: z.literal(true), providerId: z.string(), providerMeta: Meta.optional() }),
]);
export type ContentBlock = z.infer<typeof ContentBlock>;

export const Message = z.object({ role: Role, content: z.array(ContentBlock), providerMeta: Meta.optional() });
export type Message = z.infer<typeof Message>;

export type JsonSchema = Record<string, unknown>;
export const JsonSchema = z.record(z.string(), z.unknown());

/** What the model sees for a tool: derived from a ToolDefinition at the provider boundary. */
export const ToolSpec = z.object({ name: z.string(), description: z.string(), inputSchema: JsonSchema });
export type ToolSpec = z.infer<typeof ToolSpec>;

/** The persisted form of a request (no AbortSignal). Stored whole in `model-started` events. */
export const CompiledRequest = z.object({
  system: z.string(),
  /**
   * Where the stable part of `system` ends (D-46): everything before it — identity, instructions, retrieved
   * sections — is the same on every call of a step; the harness after it changes per call. An adapter whose
   * provider caches prefixes puts its breakpoint here and reports `usage.cachedInput`.
   */
  cacheBoundary: z.number().int().nonnegative().optional(),
  messages: z.array(Message),
  tools: z.array(ToolSpec).default([]),
  outputSchema: JsonSchema.optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  providerOptions: Meta.optional(),
});
export type CompiledRequest = z.infer<typeof CompiledRequest>;

export interface ModelRequest extends CompiledRequest {
  abortSignal: AbortSignal;
}

export const Usage = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cachedInput: z.number().int().nonnegative().optional(),
  /** Tokens written to the provider's cache this call; Anthropic bills them at 1.25× the input rate. */
  cacheWriteInput: z.number().int().nonnegative().optional(),
  reasoning: z.number().int().nonnegative().optional(),
  raw: Meta.default({}),
});
export type Usage = z.infer<typeof Usage>;

export const FinishReason = z.enum(['stop', 'length', 'tool-calls', 'content-filter', 'error', 'cancelled']);
export type FinishReason = z.infer<typeof FinishReason>;

export const ModelResponse = z.object({
  content: z.array(ContentBlock),
  finishReason: FinishReason,
  usage: Usage,
  providerMeta: Meta.optional(),
});
export type ModelResponse = z.infer<typeof ModelResponse>;

export const ModelErrorCode = z.enum([
  'Authentication', 'RateLimit', 'ContextLength', 'ModelUnavailable', 'ContentFilter',
  'Network', 'Timeout', 'NetworkPolicy', 'SchemaValidation', 'Unknown',
]);
export type ModelErrorCode = z.infer<typeof ModelErrorCode>;
export type ModelErrorAction = 'retry' | 'fallback' | 'abort';

export const ModelErrorShape = z.object({
  code: ModelErrorCode,
  message: z.string(),
  retryable: z.boolean(),
  action: z.enum(['retry', 'fallback', 'abort']),
  providerError: Meta.optional(),
});
export type ModelErrorShape = z.infer<typeof ModelErrorShape>;

/** Default code → action mapping (spec/model-layer.md). Adapters may override per provider. */
export const DEFAULT_ERROR_ACTION: Record<ModelErrorCode, ModelErrorAction> = {
  RateLimit: 'retry', Timeout: 'retry', Network: 'retry',
  ModelUnavailable: 'fallback', ContentFilter: 'fallback', ContextLength: 'fallback', Unknown: 'fallback',
  Authentication: 'abort', NetworkPolicy: 'abort',
  SchemaValidation: 'retry',
};

/** The fixed stream event set (D-03). */
export type ModelEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call-start'; id: string; name: string }
  | { type: 'tool-call-delta'; id: string; inputText: string }
  | { type: 'tool-call-end'; id: string; input: unknown }
  | { type: 'usage'; usage: Usage }
  | { type: 'finish'; reason: FinishReason; response: ModelResponse }
  | { type: 'error'; error: ModelErrorShape };

export const ModelCapabilities = z.object({
  text: z.literal(true),
  vision: z.boolean(),
  audioInput: z.boolean(),
  toolCalling: z.enum(['none', 'basic', 'parallel']),
  structuredOutput: z.enum(['none', 'json', 'schema']),
  streaming: z.boolean(),
  reasoning: z.enum(['none', 'opaque', 'visible']),
  contextTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive().optional(),
});
export type ModelCapabilities = z.infer<typeof ModelCapabilities>;

export const PriceRow = z.object({
  effectiveFrom: z.string(),
  inputPerM: z.number().nonnegative(),
  outputPerM: z.number().nonnegative(),
  cachedPerM: z.number().nonnegative().optional(),
});
export type PriceRow = z.infer<typeof PriceRow>;

/**
 * What a provider says it offers, as an adapter reports it (D-64). `id` is the provider's own name for the
 * model, without any `models/` prefix. Every text field is untrusted: it is shown as text, it is never written
 * into the catalog, and it reaches no prompt. Pricing is present only when the provider states it — most
 * list endpoints do not, and absent beats guessed (D-65).
 */
export const DiscoveredModel = z.object({
  id: z.string().min(1),
  displayName: z.string().optional(),
  description: z.string().optional(),
  contextTokens: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  capabilities: ModelCapabilities.partial().optional(),
  pricing: z.array(PriceRow).optional(),
});
export type DiscoveredModel = z.infer<typeof DiscoveredModel>;

export const DataPolicy = z.object({
  trainsOnContent: z.enum(['yes', 'no', 'unknown']),
  retentionDays: z.number().int().nonnegative().optional(),
  policyUrl: z.string().optional(),
});

export const CatalogEntry = z.object({
  id: z.string().regex(/^[a-z0-9-]+\/[A-Za-z0-9._:-]+$/, 'catalog ids look like provider/model'),
  adapter: z.string(),
  baseUrl: z.string().url().optional(),
  enabled: z.boolean().default(true),
  locality: z.enum(['local', 'cloud']),
  capabilities: ModelCapabilities,
  pricing: z.array(PriceRow).default([]),
  dataPolicy: DataPolicy,
});
export type CatalogEntry = z.infer<typeof CatalogEntry>;

export const ModelsFile = z.object({ schemaVersion: z.literal(1), models: z.array(CatalogEntry) });
export type ModelsFile = z.infer<typeof ModelsFile>;
