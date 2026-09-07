// Anthropic (D-07). Reasoning is opaque and must be replayed verbatim to the same provider, which the shared
// mapping already does; the only provider fact here is how to ask for it.
import { createAnthropic } from '@ai-sdk/anthropic';
import type { generateText, LanguageModel, ModelMessage, SystemModelMessage } from 'ai';
import type { CatalogEntry, DiscoveredModel, ModelRequest } from '../../../../shared/model.js';
import type { AdapterContext } from '../../adapter.js';
import { modelError } from '../../errors.js';
import { AiSdkAdapter } from '../shared/adapter-base.js';
import { IDENTITY_NAMING, providerOptionsFor, toModelMessages, type ToolNaming } from '../shared/aisdk.js';
import { discovered, listingError } from '../shared/listing.js';

const LIST_URL = 'https://api.anthropic.com/v1/models';
const API_VERSION = '2023-06-01';

export const ANTHROPIC_ADAPTER_ID = 'anthropic';

/** Anthropic's older thinking form takes a fixed budget: at least 1024 tokens, and it must leave room to answer. */
const MIN_THINKING_BUDGET = 1024;
const DEFAULT_THINKING_BUDGET = 4096;
function budgetFor(model: CatalogEntry): number {
  const ceiling = model.capabilities.maxOutputTokens;
  if (ceiling === undefined) return DEFAULT_THINKING_BUDGET;
  return Math.max(MIN_THINKING_BUDGET, Math.min(DEFAULT_THINKING_BUDGET, Math.floor(ceiling / 2)));
}

export class AnthropicAdapter extends AiSdkAdapter {
  readonly id = ANTHROPIC_ADAPTER_ID;

  protected languageModel(model: CatalogEntry, ctx: AdapterContext): LanguageModel {
    if (!ctx.apiKey) {
      throw modelError('Authentication', 'No credential named "anthropic" is configured. Add it in Settings → Credentials (it takes effect at once), or set WORKBENCH_CRED_ANTHROPIC before starting.', { action: 'abort' });
    }
    return createAnthropic({
      apiKey: ctx.apiKey,
      fetch: ctx.fetch,
      ...(model.baseUrl ? { baseURL: model.baseUrl } : {}),
    }).languageModel(this.modelName(model.id));
  }

  /**
   * Prompt caching (D-46). Two breakpoints: one after the stable prefix — tools, identity, instructions, the
   * retrieved sections — so every call of a step reads it back at a tenth of the price, and one on the last
   * message, so the transcript up to the previous turn is read back too. The harness sits after the first
   * breakpoint, which is what lets its budget line change on every call without costing the cache.
   */
  protected override promptFor(req: ModelRequest, naming: ToolNaming = IDENTITY_NAMING): { instructions: string | SystemModelMessage[]; messages: ModelMessage[] } {
    const breakpoint = { anthropic: { cacheControl: { type: 'ephemeral' as const } } };
    const boundary = req.cacheBoundary !== undefined && req.cacheBoundary > 0 && req.cacheBoundary < req.system.length ? req.cacheBoundary : null;
    const stable = boundary === null ? req.system : req.system.slice(0, boundary);
    const volatile = boundary === null ? '' : req.system.slice(boundary).replace(/^\n+/, '');
    const instructions: SystemModelMessage[] = [
      ...(stable ? [{ role: 'system' as const, content: stable, providerOptions: breakpoint }] : []),
      ...(volatile ? [{ role: 'system' as const, content: volatile }] : []),
    ];
    // The naming has to reach here too: a replayed tool call carries its name to the provider on every turn
    // after the first, so sanitising only the declarations would fail on turn two and nowhere else.
    const transcript = toModelMessages(req.messages, naming);
    const last = transcript[transcript.length - 1];
    if (last) transcript[transcript.length - 1] = { ...last, providerOptions: breakpoint } as ModelMessage;
    return { instructions, messages: transcript };
  }

  /** `GET /v1/models` (D-64): ids and display names, paged. Anthropic states neither limits nor prices here. */
  async listModels(ctx: AdapterContext): Promise<DiscoveredModel[]> {
    if (!ctx.apiKey) throw modelError('Authentication', 'No credential named "anthropic" is configured, so anthropic cannot be asked what it offers.', { action: 'abort' });
    const out: DiscoveredModel[] = [];
    let after: string | undefined;
    do {
      const url = new URL(LIST_URL);
      url.searchParams.set('limit', '1000');
      if (after) url.searchParams.set('after_id', after);
      const res = await ctx.fetch(url.toString(), { headers: { 'x-api-key': ctx.apiKey, 'anthropic-version': API_VERSION } });
      if (!res.ok) throw listingError('anthropic', res.status, await res.text());
      const body = (await res.json()) as { data?: { id?: unknown; display_name?: unknown }[]; has_more?: unknown; last_id?: unknown };
      for (const m of body.data ?? []) {
        if (typeof m.id !== 'string' || !m.id) continue;
        out.push(discovered({ id: m.id, displayName: m.display_name }));
      }
      after = body.has_more === true && typeof body.last_id === 'string' ? body.last_id : undefined;
    } while (after);
    return out;
  }

  /**
   * How to ask for thinking, which Anthropic changed at Claude 4.6: from there on a model takes
   * `{ type: 'adaptive' }` and rejects a fixed budget, while an older one — Haiku 4.5, say — takes
   * `budgetTokens` and rejects `adaptive` with a 400 that kills the step. The catalog says which
   * (`capabilities.thinking`), because only the catalog knows: `reasoning` describes what comes *back*, and
   * both generations answer the same way. **An entry that does not say gets no thinking parameter at all** —
   * a plain call still works, a wrongly-shaped one does not, and this whole field exists because guessing the
   * generation from `reasoning !== 'none'` took the fast and cheap roles down for every Anthropic fallback.
   * `providerOptions.anthropic.thinking` still overrides, so a model the catalog has wrong is one field away
   * from working.
   */
  protected providerOptions(model: CatalogEntry, req: ModelRequest): NonNullable<Parameters<typeof generateText>[0]['providerOptions']> {
    const defaults: Record<string, unknown> = {};
    if (model.capabilities.reasoning !== 'none') {
      // `summarized` is what puts the reasoning in the trace; the default returns it empty. The budget form
      // takes neither that nor anything else beyond its size — keep it to what the older API accepts.
      if (model.capabilities.thinking === 'adaptive') defaults['thinking'] = { type: 'adaptive', display: 'summarized' };
      else if (model.capabilities.thinking === 'budget') defaults['thinking'] = { type: 'enabled', budgetTokens: budgetFor(model) };
    }
    return providerOptionsFor('anthropic', defaults, req);
  }
}
