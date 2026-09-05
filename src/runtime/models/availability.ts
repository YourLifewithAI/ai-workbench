// What the Models screen needs beyond the catalog: whether each model could actually run right now, and why not.
// Ollama is polled through its management API rather than assumed (model-layer.md §Catalog).
import type { CatalogEntry, ModelsFile } from '../../shared/model.js';
import type { NetworkMode } from '../../shared/permissions.js';
import type { FetchLike } from './adapter.js';
import { reachableInMode } from '../engine/selection.js';

export type Availability = 'ready' | 'no-credential' | 'blocked-by-mode' | 'unreachable' | 'disabled' | 'no-adapter';

export interface ModelStatus {
  id: string;
  adapter: string;
  locality: string;
  enabled: boolean;
  availability: Availability;
  reason: string | null;
  capabilities: CatalogEntry['capabilities'];
  pricing: CatalogEntry['pricing'];
  dataPolicy: CatalogEntry['dataPolicy'];
  baseUrl?: string | undefined;
}

export interface AvailabilityInput {
  catalog: ModelsFile;
  mode: NetworkMode;
  hasAdapter: (id: string) => boolean;
  hasCredential: (provider: string) => boolean;
  /** Endpoints that answered their management API on the last poll. */
  reachableEndpoints: ReadonlySet<string>;
}

export function providerOf(id: string): string {
  const slash = id.indexOf('/');
  return slash === -1 ? id : id.slice(0, slash);
}

export function statusFor(entry: CatalogEntry, input: AvailabilityInput): { availability: Availability; reason: string | null } {
  if (!entry.enabled) return { availability: 'disabled', reason: 'Disabled in config/models.json.' };
  if (!input.hasAdapter(entry.adapter)) return { availability: 'no-adapter', reason: `No "${entry.adapter}" adapter is installed in this runtime.` };
  const blocked = reachableInMode(entry, input.mode);
  if (blocked) return { availability: 'blocked-by-mode', reason: `${blocked[0]!.toUpperCase()}${blocked.slice(1)}.` };
  if (entry.adapter === 'mock') return { availability: 'ready', reason: null };
  if (entry.locality === 'local') {
    if (!entry.baseUrl) return { availability: 'unreachable', reason: 'No baseUrl configured for this local endpoint.' };
    return input.reachableEndpoints.has(entry.baseUrl)
      ? { availability: 'ready', reason: null }
      : { availability: 'unreachable', reason: `Nothing answered at ${entry.baseUrl}. Start the server, then refresh.` };
  }
  const provider = providerOf(entry.id);
  if (!input.hasCredential(provider)) {
    return { availability: 'no-credential', reason: `No credential named "${provider}". Add one in Settings → Credentials; it takes effect at once.` };
  }
  return { availability: 'ready', reason: null };
}

export function listModels(input: AvailabilityInput): ModelStatus[] {
  return input.catalog.models.map((entry) => {
    const { availability, reason } = statusFor(entry, input);
    return {
      id: entry.id,
      adapter: entry.adapter,
      locality: entry.locality,
      enabled: entry.enabled,
      availability,
      reason,
      capabilities: entry.capabilities,
      pricing: entry.pricing,
      dataPolicy: entry.dataPolicy,
      ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
    };
  });
}

/**
 * Ollama's management API lists what is actually pulled. The URL is derived from the OpenAI-compatible
 * `baseUrl` the owner configured, so nothing here guesses a host.
 */
export function managementUrl(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    url.pathname = '/api/tags';
    url.search = '';
    return url.toString();
  } catch {
    return null;
  }
}

export interface PollResult { reachable: Set<string>; pulled: Map<string, string[]> }

/** Polls every distinct local endpoint once. A refusal is data, not an error: it becomes "unreachable". */
export async function pollLocalEndpoints(catalog: ModelsFile, fetchImpl: FetchLike, timeoutMs = 1500): Promise<PollResult> {
  const endpoints = new Set(catalog.models.filter((m) => m.locality === 'local' && m.baseUrl && m.adapter !== 'mock').map((m) => m.baseUrl!));
  const reachable = new Set<string>();
  const pulled = new Map<string, string[]>();
  await Promise.all([...endpoints].map(async (baseUrl) => {
    const url = managementUrl(baseUrl);
    if (!url) return;
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return;
      const body = (await res.json()) as { models?: { name?: string }[] };
      reachable.add(baseUrl);
      pulled.set(baseUrl, (body.models ?? []).map((m) => m.name ?? '').filter(Boolean));
    } catch {
      // unreachable: the Models screen says so and offers the fix
    }
  }));
  return { reachable, pulled };
}
