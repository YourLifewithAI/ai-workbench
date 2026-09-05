// Google Gemini (D-07). Everything generic lives in the shared base; this file is the provider's own three facts:
// how to build the model handle, which knobs it takes, and what its ids look like.
import { createGoogle } from '@ai-sdk/google';
import type { generateText, LanguageModel } from 'ai';
import type { CatalogEntry, DiscoveredModel, ModelRequest } from '../../../../shared/model.js';
import type { AdapterContext } from '../../adapter.js';
import { modelError } from '../../errors.js';
import { AiSdkAdapter } from '../shared/adapter-base.js';
import { providerOptionsFor } from '../shared/aisdk.js';
import { discovered, listingError } from '../shared/listing.js';

const LIST_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

export const GOOGLE_ADAPTER_ID = 'google';

export class GoogleAdapter extends AiSdkAdapter {
  readonly id = GOOGLE_ADAPTER_ID;

  protected languageModel(model: CatalogEntry, ctx: AdapterContext): LanguageModel {
    if (!ctx.apiKey) {
      throw modelError('Authentication', 'No credential named "google" is configured. Add it in Settings → Credentials (it takes effect at once), or set WORKBENCH_CRED_GOOGLE before starting.', { action: 'abort' });
    }
    return createGoogle({
      apiKey: ctx.apiKey,
      fetch: ctx.fetch,
      ...(model.baseUrl ? { baseURL: model.baseUrl } : {}),
    }).languageModel(this.modelName(model.id));
  }

  /**
   * `GET /v1beta/models` (D-64): every model that can `generateContent`, with the provider's token limits. The
   * key rides in `x-goog-api-key`, a header the redactor already strips. Google states no prices here.
   */
  async listModels(ctx: AdapterContext): Promise<DiscoveredModel[]> {
    if (!ctx.apiKey) throw modelError('Authentication', 'No credential named "google" is configured, so google cannot be asked what it offers.', { action: 'abort' });
    const out: DiscoveredModel[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(LIST_URL);
      url.searchParams.set('pageSize', '1000');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const res = await ctx.fetch(url.toString(), { headers: { 'x-goog-api-key': ctx.apiKey } });
      if (!res.ok) throw listingError('google', res.status, await res.text());
      const body = (await res.json()) as { models?: { name?: unknown; displayName?: unknown; description?: unknown; inputTokenLimit?: unknown; outputTokenLimit?: unknown; supportedGenerationMethods?: unknown }[]; nextPageToken?: unknown };
      for (const m of body.models ?? []) {
        if (typeof m.name !== 'string' || !m.name) continue;
        if (Array.isArray(m.supportedGenerationMethods) && !m.supportedGenerationMethods.includes('generateContent')) continue;
        out.push(discovered({ id: m.name.replace(/^models\//, ''), displayName: m.displayName, description: m.description, contextTokens: m.inputTokenLimit, maxOutputTokens: m.outputTokenLimit }));
      }
      pageToken = typeof body.nextPageToken === 'string' && body.nextPageToken ? body.nextPageToken : undefined;
    } while (pageToken);
    return out;
  }

  protected providerOptions(model: CatalogEntry, req: ModelRequest): NonNullable<Parameters<typeof generateText>[0]['providerOptions']> {
    const defaults: Record<string, unknown> = {};
    // The catalog says this model reasons; ask for the thought summaries so the trace can show them (D-02 leak 1).
    if (model.capabilities.reasoning !== 'none') defaults['thinkingConfig'] = { includeThoughts: true };
    if (req.outputSchema && model.capabilities.structuredOutput === 'schema') defaults['structuredOutputs'] = true;
    return providerOptionsFor('google', defaults, req);
  }
}
