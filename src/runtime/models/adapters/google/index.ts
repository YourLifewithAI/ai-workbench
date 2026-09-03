// The Google adapter (D-01, D-07): @ai-sdk/google behind our canonical types. No SDK type crosses this boundary,
// the SDK's own tool loop is never used (single invocations only), and the only fetch and key are the injected ones.
import { generateText, streamText } from 'ai';
import { createGoogle } from '@ai-sdk/google';
import type { CatalogEntry, ContentBlock, Message, ModelEvent, ModelRequest, ModelResponse, Usage } from '../../../../shared/model.js';
import type { AdapterContext, ModelAdapter } from '../../adapter.js';
import { ModelError, modelError } from '../../errors.js';
import { toModelMessages, toSdkTools, mapFinishReason, mapUsage, mapContent, translateError, providerOptionsFor } from './map.js';

export const GOOGLE_ADAPTER_ID = 'google';

/** `google/gemini-2.5-pro` → `gemini-2.5-pro`; a catalog id without a prefix is passed through. */
export function modelName(catalogId: string): string {
  const slash = catalogId.indexOf('/');
  return slash === -1 ? catalogId : catalogId.slice(slash + 1);
}

export class GoogleAdapter implements ModelAdapter {
  readonly id = GOOGLE_ADAPTER_ID;

  private languageModel(model: CatalogEntry, ctx: AdapterContext) {
    if (!ctx.apiKey) {
      throw modelError('Authentication', 'No credential named "google" is configured. Add it to config/credentials.json (mode 0600) or set WORKBENCH_CRED_GOOGLE, then restart the runtime.', { action: 'abort' });
    }
    const provider = createGoogle({
      apiKey: ctx.apiKey,
      fetch: ctx.fetch,
      ...(model.baseUrl ? { baseURL: model.baseUrl } : {}),
    });
    return provider.languageModel(modelName(model.id));
  }

  private callOptions(model: CatalogEntry, req: ModelRequest, ctx: AdapterContext) {
    return {
      model: this.languageModel(model, ctx),
      system: req.system,
      messages: toModelMessages(req.messages),
      ...(req.tools && req.tools.length ? { tools: toSdkTools(req.tools) } : {}),
      ...(req.maxOutputTokens !== undefined ? { maxOutputTokens: req.maxOutputTokens } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      providerOptions: providerOptionsFor(model, req),
      abortSignal: req.abortSignal,
      maxRetries: 0, // the engine owns retry and fallback (D-04); the SDK must not retry behind its back
    };
  }

  async generate(model: CatalogEntry, req: ModelRequest, ctx: AdapterContext): Promise<ModelResponse> {
    try {
      const result = await generateText(this.callOptions(model, req, ctx));
      return {
        content: mapContent(result.content),
        finishReason: mapFinishReason(result.finishReason, req.abortSignal),
        usage: mapUsage(result.usage),
        ...(result.providerMetadata ? { providerMeta: result.providerMetadata as Record<string, unknown> } : {}),
      };
    } catch (e) {
      throw translateError(e, req.abortSignal);
    }
  }

  async *stream(model: CatalogEntry, req: ModelRequest, ctx: AdapterContext): AsyncIterable<ModelEvent> {
    let usage: Usage = { input: 0, output: 0, raw: {} };
    const content: ContentBlock[] = [];
    let text = '';
    let reasoning = '';
    let reasoningMeta: Record<string, unknown> | undefined;
    try {
      const result = streamText(this.callOptions(model, req, ctx));
      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-delta':
            text += part.text;
            yield { type: 'text-delta', text: part.text };
            break;
          case 'reasoning-delta':
            reasoning += part.text;
            if (part.providerMetadata) reasoningMeta = part.providerMetadata as Record<string, unknown>;
            yield { type: 'reasoning-delta', text: part.text };
            break;
          case 'tool-input-start':
            yield { type: 'tool-call-start', id: part.id, name: part.toolName };
            break;
          case 'tool-input-delta':
            yield { type: 'tool-call-delta', id: part.id, inputText: part.delta };
            break;
          case 'tool-call':
            content.push({ type: 'tool-call', id: part.toolCallId, name: part.toolName, input: part.input });
            yield { type: 'tool-call-end', id: part.toolCallId, input: part.input };
            break;
          case 'error':
            throw part.error;
          default:
            break; // start/finish-step/raw/source/file parts carry nothing the canonical set names
        }
      }
      usage = mapUsage(await result.usage);
      const finishReason = mapFinishReason(await result.finishReason, req.abortSignal);
      const providerMetadata = await result.providerMetadata;
      if (reasoning) {
        content.unshift({ type: 'reasoning', text: reasoning, opaque: true, providerId: GOOGLE_ADAPTER_ID, ...(reasoningMeta ? { providerMeta: reasoningMeta } : {}) });
      }
      if (text) content.push({ type: 'text', text });
      const response: ModelResponse = {
        content,
        finishReason,
        usage,
        ...(providerMetadata ? { providerMeta: providerMetadata as Record<string, unknown> } : {}),
      };
      yield { type: 'usage', usage };
      yield { type: 'finish', reason: finishReason, response };
    } catch (e) {
      const err = translateError(e, req.abortSignal);
      yield { type: 'error', error: err instanceof ModelError ? err.toShape() : modelError('Unknown', String(e)).toShape() };
    }
  }
}

export type { Message };
