// The half of an @ai-sdk adapter that is the same for every provider: one streamed or single invocation,
// canonical mapping in and out, and the engine keeping ownership of retry and fallback (D-04, D-07).
import { generateText, streamText, type LanguageModel, type ModelMessage, type SystemModelMessage } from 'ai';
import type { CatalogEntry, ContentBlock, ModelEvent, ModelRequest, ModelResponse, Usage } from '../../../../shared/model.js';
import type { AdapterContext, ModelAdapter } from '../../adapter.js';
import { ModelError, modelError } from '../../errors.js';
import { mapContent, mapFinishReason, mapUsage, toModelMessages, toSdkTools, translateError } from './aisdk.js';

export abstract class AiSdkAdapter implements ModelAdapter {
  abstract readonly id: string;

  /** Build the SDK model handle from the catalog entry and the injected credential; throw if the key is missing. */
  protected abstract languageModel(model: CatalogEntry, ctx: AdapterContext): LanguageModel;

  /** Provider-specific request knobs, already merged with whatever the request asked for. */
  protected abstract providerOptions(model: CatalogEntry, req: ModelRequest): NonNullable<Parameters<typeof generateText>[0]['providerOptions']>;

  /** `google/gemini-2.5-pro` → `gemini-2.5-pro`; a catalog id without a prefix is passed through. */
  protected modelName(catalogId: string): string {
    const slash = catalogId.indexOf('/');
    return slash === -1 ? catalogId : catalogId.slice(slash + 1);
  }

  /**
   * The system prompt and the transcript as the SDK wants them. A provider that caches prefixes overrides this
   * to split the system at `req.cacheBoundary` and mark its breakpoints; the default sends one system string.
   */
  protected promptFor(req: ModelRequest): { instructions: string | SystemModelMessage[]; messages: ModelMessage[] } {
    return { instructions: req.system, messages: toModelMessages(req.messages) };
  }

  private callOptions(model: CatalogEntry, req: ModelRequest, ctx: AdapterContext) {
    const prompt = this.promptFor(req);
    return {
      model: this.languageModel(model, ctx),
      instructions: prompt.instructions,
      messages: prompt.messages,
      ...(req.tools && req.tools.length ? { tools: toSdkTools(req.tools) } : {}),
      ...(req.maxOutputTokens !== undefined ? { maxOutputTokens: req.maxOutputTokens } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      providerOptions: this.providerOptions(model, req),
      abortSignal: req.abortSignal,
      maxRetries: 0, // the engine owns retry and fallback (D-04); the SDK must not retry behind its back
    };
  }

  async generate(model: CatalogEntry, req: ModelRequest, ctx: AdapterContext): Promise<ModelResponse> {
    try {
      const result = await generateText(this.callOptions(model, req, ctx));
      return {
        content: mapContent(result.content, this.id),
        finishReason: mapFinishReason(result.finishReason, req.abortSignal),
        usage: mapUsage(result.usage),
        ...(result.providerMetadata ? { providerMeta: result.providerMetadata as Record<string, unknown> } : {}),
      };
    } catch (e) {
      throw translateError(e, req.abortSignal);
    }
  }

  async *stream(model: CatalogEntry, req: ModelRequest, ctx: AdapterContext): AsyncIterable<ModelEvent> {
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
            break; // start / finish-step / raw / source parts carry nothing the canonical event set names
        }
      }
      const usage: Usage = mapUsage(await result.usage);
      const finishReason = mapFinishReason(await result.finishReason, req.abortSignal);
      const providerMetadata = await result.providerMetadata;
      if (reasoning) {
        content.unshift({ type: 'reasoning', text: reasoning, opaque: true, providerId: this.id, ...(reasoningMeta ? { providerMeta: reasoningMeta } : {}) });
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
