// The two provider facts a listing needs that `generate` does not: how a list request fails, and how to keep
// the optional fields of a `DiscoveredModel` optional under exactOptionalPropertyTypes.
import type { DiscoveredModel } from '../../../../shared/model.js';
import { modelError, type ModelError } from '../../errors.js';

/** Maps a list endpoint's HTTP failure onto the normalized codes, so the Models screen can say "no key" or "rate limited". */
export function listingError(provider: string, status: number, text: string): ModelError {
  const snippet = text.slice(0, 200);
  if (status === 401 || status === 403) return modelError('Authentication', `${provider} refused the credential when listing models (${status}).`, { action: 'abort', providerError: { status, body: snippet } });
  if (status === 429) return modelError('RateLimit', `${provider} rate-limited the model listing.`, { providerError: { status, body: snippet } });
  if (status >= 500) return modelError('ModelUnavailable', `${provider}'s model listing answered ${status}.`, { providerError: { status, body: snippet } });
  return modelError('Unknown', `${provider}'s model listing answered ${status}.`, { providerError: { status, body: snippet } });
}

/** Builds a DiscoveredModel with only the fields that are actually present. */
export function discovered(fields: { id: string; displayName?: unknown; description?: unknown; contextTokens?: unknown; maxOutputTokens?: unknown }): DiscoveredModel {
  const out: DiscoveredModel = { id: fields.id };
  if (typeof fields.displayName === 'string' && fields.displayName) out.displayName = fields.displayName;
  if (typeof fields.description === 'string' && fields.description) out.description = fields.description;
  if (typeof fields.contextTokens === 'number' && Number.isInteger(fields.contextTokens) && fields.contextTokens > 0) out.contextTokens = fields.contextTokens;
  if (typeof fields.maxOutputTokens === 'number' && Number.isInteger(fields.maxOutputTokens) && fields.maxOutputTokens > 0) out.maxOutputTokens = fields.maxOutputTokens;
  return out;
}
