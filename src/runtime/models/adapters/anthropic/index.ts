// Anthropic (D-07). Reasoning is opaque and must be replayed verbatim to the same provider, which the shared
// mapping already does; the only provider fact here is how to ask for it.
import { createAnthropic } from '@ai-sdk/anthropic';
import type { generateText, LanguageModel } from 'ai';
import type { CatalogEntry, ModelRequest } from '../../../../shared/model.js';
import type { AdapterContext } from '../../adapter.js';
import { modelError } from '../../errors.js';
import { AiSdkAdapter } from '../shared/adapter-base.js';
import { providerOptionsFor } from '../shared/aisdk.js';

export const ANTHROPIC_ADAPTER_ID = 'anthropic';

export class AnthropicAdapter extends AiSdkAdapter {
  readonly id = ANTHROPIC_ADAPTER_ID;

  protected languageModel(model: CatalogEntry, ctx: AdapterContext): LanguageModel {
    if (!ctx.apiKey) {
      throw modelError('Authentication', 'No credential named "anthropic" is configured. Add it to config/credentials.json (mode 0600) or set WORKBENCH_CRED_ANTHROPIC, then restart the runtime.', { action: 'abort' });
    }
    return createAnthropic({
      apiKey: ctx.apiKey,
      fetch: ctx.fetch,
      ...(model.baseUrl ? { baseURL: model.baseUrl } : {}),
    }).languageModel(this.modelName(model.id));
  }

  protected providerOptions(model: CatalogEntry, req: ModelRequest): NonNullable<Parameters<typeof generateText>[0]['providerOptions']> {
    const defaults: Record<string, unknown> = {};
    if (model.capabilities.reasoning !== 'none') {
      // Adaptive thinking is the only mode current Claude models accept: a fixed `budgetTokens` is rejected
      // outright. `summarized` is what puts the reasoning in the trace; the default returns it empty.
      // A model old enough to need the fixed-budget form can say so with providerOptions.anthropic.thinking.
      defaults['thinking'] = { type: 'adaptive', display: 'summarized' };
    }
    return providerOptionsFor('anthropic', defaults, req);
  }
}
