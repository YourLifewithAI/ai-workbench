// Any OpenAI-shaped endpoint (D-07): Ollama, OpenRouter, vLLM, or a hosted OpenAI-compatible gateway. The catalog
// entry's `baseUrl` is what makes them different, so this adapter refuses to guess one.
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { generateText, LanguageModel } from 'ai';
import type { CatalogEntry, ModelRequest } from '../../../../shared/model.js';
import type { AdapterContext } from '../../adapter.js';
import { modelError } from '../../errors.js';
import { AiSdkAdapter } from '../shared/adapter-base.js';
import { providerOptionsFor } from '../shared/aisdk.js';

export const OPENAI_COMPATIBLE_ADAPTER_ID = 'openai-compatible';

export class OpenAiCompatibleAdapter extends AiSdkAdapter {
  readonly id = OPENAI_COMPATIBLE_ADAPTER_ID;

  protected languageModel(model: CatalogEntry, ctx: AdapterContext): LanguageModel {
    if (!model.baseUrl) {
      throw modelError('ModelUnavailable', `"${model.id}" uses the openai-compatible adapter but names no baseUrl. Add one to config/models.json — for Ollama that is http://127.0.0.1:11434/v1.`, { action: 'fallback' });
    }
    return createOpenAICompatible({
      name: providerOf(model.id),
      baseURL: model.baseUrl,
      // Local servers usually want no key at all; sending an empty one makes some of them 401.
      ...(ctx.apiKey ? { apiKey: ctx.apiKey } : {}),
      fetch: ctx.fetch,
    }).languageModel(this.modelName(model.id));
  }

  protected providerOptions(_model: CatalogEntry, req: ModelRequest): NonNullable<Parameters<typeof generateText>[0]['providerOptions']> {
    // The provider key is the endpoint's name, so `providerOptions` in an agent file can target one endpoint.
    return providerOptionsFor(providerOf(_model.id), {}, req);
  }
}

/** `ollama/qwen3:14b` → `ollama`; the prefix names the endpoint, not a vendor SDK. */
export function providerOf(catalogId: string): string {
  const slash = catalogId.indexOf('/');
  return slash === -1 ? OPENAI_COMPATIBLE_ADAPTER_ID : catalogId.slice(0, slash);
}
