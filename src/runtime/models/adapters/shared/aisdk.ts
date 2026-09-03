// Translation at the boundary, shared by every adapter built on an @ai-sdk provider: canonical types in, SDK
// shapes out, and back. Nothing here escapes the adapters folder. Provider-specific knobs live in each adapter.
import type { ModelMessage, ToolSet, generateText } from 'ai';
import { tool as defineTool, jsonSchema } from 'ai';
import type { ContentBlock, FinishReason, Message, ToolSpec, Usage, ModelRequest } from '../../../../shared/model.js';
import { ModelError, modelError } from '../../errors.js';
import type { ModelErrorCode } from '../../../../shared/model.js';

type SdkContent = Awaited<ReturnType<typeof generateText>>['content'];
type SdkUsage = Awaited<ReturnType<typeof generateText>>['usage'];
type SdkFinishReason = Awaited<ReturnType<typeof generateText>>['finishReason'];
/** The SDK insists provider options are JSON; workspace config is JSON, so the cast at this boundary is sound. */
type SdkProviderOptions = NonNullable<Parameters<typeof generateText>[0]['providerOptions']>;
type AssistantMessage = Extract<ModelMessage, { role: 'assistant' }>;
type UserMessage = Extract<ModelMessage, { role: 'user' }>;
type AssistantPart = Exclude<AssistantMessage['content'], string>[number];
type UserPart = Exclude<UserMessage['content'], string>[number];

/** One adapter's defaults for its own provider key, with anything the request asked for layered on top. */
export function providerOptionsFor(providerKey: string, defaults: Record<string, unknown>, req: ModelRequest): SdkProviderOptions {
  const requested = (req.providerOptions?.[providerKey] ?? {}) as Record<string, unknown>;
  const rest = { ...(req.providerOptions ?? {}) } as Record<string, Record<string, unknown>>;
  delete rest[providerKey];
  return { ...rest, [providerKey]: { ...defaults, ...requested } } as SdkProviderOptions;
}

export function toModelMessages(messages: Message[]): ModelMessage[] {
  return messages.map((m): ModelMessage => {
    switch (m.role) {
      case 'system':
        return { role: 'system', content: m.content.map(textOf).join('') };
      case 'tool':
        return {
          role: 'tool',
          content: m.content.filter((b) => b.type === 'tool-result').map((b) => ({
            type: 'tool-result' as const,
            toolCallId: b.callId,
            toolName: (b.providerMeta?.['toolName'] as string | undefined) ?? 'tool',
            output: b.ok ? { type: 'json' as const, value: b.output as never } : { type: 'error-json' as const, value: b.output as never },
          })),
        };
      case 'assistant':
        return {
          role: 'assistant',
          content: m.content.flatMap((b): AssistantPart[] => {
            if (b.type === 'text') return [{ type: 'text', text: b.text }];
            if (b.type === 'reasoning') return b.text ? [{ type: 'reasoning', text: b.text, ...(b.providerMeta ? { providerOptions: b.providerMeta as SdkProviderOptions } : {}) }] : [];
            if (b.type === 'tool-call') return [{ type: 'tool-call', toolCallId: b.id, toolName: b.name, input: b.input }];
            return [];
          }),
        };
      default:
        return {
          role: 'user',
          content: m.content.flatMap((b): UserPart[] => {
            if (b.type === 'text') return [{ type: 'text', text: b.text }];
            if (b.type === 'image') return [{ type: 'image', image: 'url' in b.data ? new URL(b.data.url) : b.data, mediaType: b.mimeType }];
            if (b.type === 'file') return [{ type: 'file', data: b.data, mediaType: b.mimeType, filename: b.name }];
            return [];
          }),
        };
    }
  });
}

/** Tool specs only: the SDK's own execute loop is never used, so no tool here has an implementation (model-layer.md). */
export function toSdkTools(specs: ToolSpec[]): ToolSet {
  const out: ToolSet = {};
  for (const spec of [...specs].sort((a, b) => a.name.localeCompare(b.name))) {
    out[spec.name] = defineTool({ description: spec.description, inputSchema: jsonSchema(spec.inputSchema as never) });
  }
  return out;
}

export function mapContent(content: SdkContent, providerId: string): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const part of content) {
    switch (part.type) {
      case 'text':
        out.push({ type: 'text', text: part.text, ...(part.providerMetadata ? { providerMeta: part.providerMetadata as Record<string, unknown> } : {}) });
        break;
      case 'reasoning':
        // Opaque by contract: replayed verbatim to the same provider, dropped on cross-provider fallback (D-02).
        out.push({ type: 'reasoning', text: part.text, opaque: true, providerId, ...(part.providerMetadata ? { providerMeta: part.providerMetadata as Record<string, unknown> } : {}) });
        break;
      case 'tool-call':
        out.push({ type: 'tool-call', id: part.toolCallId, name: part.toolName, input: part.input });
        break;
      case 'tool-result':
        out.push({ type: 'tool-result', callId: part.toolCallId, ok: true, output: part.output, providerMeta: { toolName: part.toolName } });
        break;
      case 'file':
        out.push({ type: 'file', mimeType: part.file.mediaType, name: 'output', data: new Uint8Array(part.file.uint8Array) });
        break;
      default:
        break; // sources and custom parts have no canonical block; providerMeta on the response carries them
    }
  }
  return out;
}

export function mapUsage(usage: SdkUsage): Usage {
  const cached = usage.inputTokenDetails?.cacheReadTokens;
  const reasoning = usage.outputTokenDetails?.reasoningTokens;
  return {
    input: usage.inputTokens ?? 0,
    output: usage.outputTokens ?? 0,
    ...(cached !== undefined ? { cachedInput: cached } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    raw: JSON.parse(JSON.stringify(usage)) as Record<string, unknown>,
  };
}

export function mapFinishReason(reason: SdkFinishReason, signal?: AbortSignal): FinishReason {
  if (signal?.aborted) return 'cancelled';
  switch (reason) {
    case 'stop': return 'stop';
    case 'length': return 'length';
    case 'tool-calls': return 'tool-calls';
    case 'content-filter': return 'content-filter';
    case 'error': return 'error';
    default: return 'stop';
  }
}

interface ApiCallErrorish { name?: string; statusCode?: number; responseBody?: string; message?: string; isRetryable?: boolean; data?: unknown; cause?: unknown }

/** HTTP status and provider message → the canonical code set, so the engine's retry and fallback rules apply (D-05). */
export function translateError(e: unknown, signal?: AbortSignal): ModelError {
  if (e instanceof ModelError) return e;
  const err = e as ApiCallErrorish;
  const message = err?.message ?? String(e);
  if (signal?.aborted || err?.name === 'AbortError' || /aborted/i.test(message)) {
    return modelError('Unknown', 'The model call was cancelled.', { action: 'abort', retryable: false });
  }
  const status = err?.statusCode;
  const body = err?.responseBody;
  const providerError: Record<string, unknown> = {
    ...(err?.name ? { name: err.name } : {}),
    ...(status !== undefined ? { statusCode: status } : {}),
    ...(body ? { responseBody: body.slice(0, 2000) } : {}),
  };
  const code = codeFor(status, message, body);
  return modelError(code, `${providerMessage(body) ?? message}`, { providerError });
}

function codeFor(status: number | undefined, message: string, body: string | undefined): ModelErrorCode {
  const haystack = `${message} ${body ?? ''}`;
  if (status === 401 || status === 403) return 'Authentication';
  if (status === 429) return 'RateLimit';
  if (status === 404) return 'ModelUnavailable';
  if (status === 400 && /token count|too long|exceeds the maximum|context length/i.test(haystack)) return 'ContextLength';
  if (status === 400 && /safety|blocked/i.test(haystack)) return 'ContentFilter';
  if (status !== undefined && status >= 500) return 'ModelUnavailable';
  if (/timed? ?out|ETIMEDOUT/i.test(haystack)) return 'Timeout';
  if (/blocked by the egress|network is not available|NetworkPolicy/i.test(haystack)) return 'NetworkPolicy';
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|socket hang up|network/i.test(haystack)) return 'Network';
  return 'Unknown';
}

/** Gemini errors arrive as `{ error: { message } }`; that sentence is more useful than the SDK's wrapper text. */
function providerMessage(body: string | undefined): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return parsed.error?.message ?? null;
  } catch {
    return null;
  }
}

function textOf(b: ContentBlock): string {
  return b.type === 'text' ? b.text : '';
}
