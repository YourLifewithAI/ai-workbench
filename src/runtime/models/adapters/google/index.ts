// Google Gemini (D-07). Everything generic lives in the shared base; this file is the provider's own three facts:
// how to build the model handle, which knobs it takes, and what its ids look like.
import { createGoogle } from '@ai-sdk/google';
import type { generateText, LanguageModel } from 'ai';
import type { CatalogEntry, ModelRequest } from '../../../../shared/model.js';
import type { AdapterContext } from '../../adapter.js';
import { modelError } from '../../errors.js';
import { AiSdkAdapter } from '../shared/adapter-base.js';
import { providerOptionsFor } from '../shared/aisdk.js';

export const GOOGLE_ADAPTER_ID = 'google';

export class GoogleAdapter extends AiSdkAdapter {
  readonly id = GOOGLE_ADAPTER_ID;

  protected languageModel(model: CatalogEntry, ctx: AdapterContext): LanguageModel {
    if (!ctx.apiKey) {
      throw modelError('Authentication', 'No credential named "google" is configured. Add it to config/credentials.json (mode 0600) or set WORKBENCH_CRED_GOOGLE, then restart the runtime.', { action: 'abort' });
    }
    return createGoogle({
      apiKey: ctx.apiKey,
      fetch: ctx.fetch,
      ...(model.baseUrl ? { baseURL: model.baseUrl } : {}),
    }).languageModel(this.modelName(model.id));
  }

  protected providerOptions(model: CatalogEntry, req: ModelRequest): NonNullable<Parameters<typeof generateText>[0]['providerOptions']> {
    const defaults: Record<string, unknown> = {};
    // The catalog says this model reasons; ask for the thought summaries so the trace can show them (D-02 leak 1).
    if (model.capabilities.reasoning !== 'none') defaults['thinkingConfig'] = { includeThoughts: true };
    if (req.outputSchema && model.capabilities.structuredOutput === 'schema') defaults['structuredOutputs'] = true;
    return providerOptionsFor('google', defaults, req);
  }
}
