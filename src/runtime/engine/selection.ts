// Candidate selection and capability filtering (D-06). There is no scoring and no "which model is best":
// the agent names an ordered policy, the catalog says what each model can do, and the mode says what is reachable.
import type { CatalogEntry, ContentBlock, Message, ModelsFile } from '../../shared/model.js';
import type { NetworkMode } from '../../shared/permissions.js';
import { findModel } from '../models/catalog.js';

export interface Candidate { entry: CatalogEntry; adapterId: string }
export interface Rejection { id: string; reason: string }
export interface Selection { candidates: Candidate[]; rejected: Rejection[] }

export type Requirements = Partial<Record<string, unknown>>;

/** `requires` is a partial of ModelCapabilities: numbers are minimums, enums are ordered tiers, booleans must hold. */
const TIERS: Record<string, string[]> = {
  toolCalling: ['none', 'basic', 'parallel'],
  structuredOutput: ['none', 'json', 'schema'],
  reasoning: ['none', 'opaque', 'visible'],
};

export function meetsRequirements(entry: CatalogEntry, requires: Requirements | undefined): string | null {
  if (!requires) return null;
  const caps = entry.capabilities as unknown as Record<string, unknown>;
  for (const [key, needed] of Object.entries(requires)) {
    if (needed === undefined) continue;
    const has = caps[key];
    if (typeof needed === 'number') {
      if (typeof has !== 'number' || has < needed) return `needs ${key} ≥ ${needed}, has ${String(has ?? 'none')}`;
      continue;
    }
    if (typeof needed === 'boolean') {
      if (has !== needed) return `needs ${key} = ${String(needed)}`;
      continue;
    }
    const tier = TIERS[key];
    if (tier && typeof needed === 'string' && typeof has === 'string') {
      if (tier.indexOf(has) < tier.indexOf(needed)) return `needs ${key} ≥ "${needed}", has "${has}"`;
      continue;
    }
    if (has !== needed) return `needs ${key} = ${String(needed)}, has ${String(has)}`;
  }
  return null;
}

/** Reachability by mode, decided from the catalog alone so a model is filtered out before any call is attempted. */
export function reachableInMode(entry: CatalogEntry, mode: NetworkMode): string | null {
  if (mode === 'offline') return 'network mode is offline';
  if (mode === 'local-only' && entry.locality !== 'local') return 'network mode is local-only and this model is a cloud model';
  return null;
}

export interface SelectOptions {
  catalog: ModelsFile;
  ids: string[];
  mode: NetworkMode;
  requires?: Requirements | undefined;
  hasAdapter: (id: string) => boolean;
  /** `--provider mock` serves every catalog id through the mock, so per-step model ids stay distinguishable. */
  forceAdapter?: string | undefined;
}

export function selectCandidates(opts: SelectOptions): Selection {
  const candidates: Candidate[] = [];
  const rejected: Rejection[] = [];
  for (const id of opts.ids) {
    const entry = findModel(opts.catalog, id);
    if (!entry) { rejected.push({ id, reason: 'not in this workspace\'s model catalog' }); continue; }
    if (!entry.enabled) { rejected.push({ id, reason: 'disabled in the catalog' }); continue; }
    const adapterId = opts.forceAdapter ?? entry.adapter;
    if (!opts.hasAdapter(adapterId)) { rejected.push({ id, reason: `no "${adapterId}" adapter is installed in this runtime` }); continue; }
    // The mock serves any id and opens no socket, so mode and capability gates do not apply to it.
    if (opts.forceAdapter !== 'mock') {
      const unreachable = reachableInMode(entry, opts.mode);
      if (unreachable) { rejected.push({ id, reason: unreachable }); continue; }
      const unmet = meetsRequirements(entry, opts.requires);
      if (unmet) { rejected.push({ id, reason: unmet }); continue; }
    }
    candidates.push({ entry, adapterId });
  }
  return { candidates, rejected };
}

/**
 * Reasoning blocks are opaque and only valid for the provider that produced them, so a cross-provider fallback
 * drops them and says so (D-02 leak 1, D-04). Same-provider retries keep them.
 */
export function dropForeignReasoning(messages: Message[], providerId: string): { messages: Message[]; dropped: number } {
  let dropped = 0;
  const out = messages.map((m) => {
    const kept = m.content.filter((b: ContentBlock) => {
      if (b.type !== 'reasoning') return true;
      if (b.providerId === providerId) return true;
      dropped += 1;
      return false;
    });
    return kept.length === m.content.length ? m : { ...m, content: kept };
  });
  return { messages: out, dropped };
}
