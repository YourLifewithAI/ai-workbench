// Catalog discovery (D-64, D-65). A provider's listing is compared with `config/models.json` and the differences
// become findings a person accepts one at a time. Nothing in this module writes a file or touches an agent:
// `applyFinding` returns the catalog that *would* result, and the runtime writes it only when a person said so.
import { createHash } from 'node:crypto';
import type { CatalogEntry, DiscoveredModel, ModelsFile, PriceRow } from '../../shared/model.js';
import { CatalogEntry as CatalogEntrySchema } from '../../shared/model.js';
import type { CatalogFinding, CatalogFindingPin } from '../../shared/api/index.js';
import { priceFor } from './catalog.js';
import { providerOf } from './availability.js';

/** Where a model id is pinned. Built from agent policies and workflow step overrides, never from a trace. */
export type Pins = Map<string, CatalogFindingPin[]>;

export interface PinSources {
  agents: Iterable<{ id: string; primary: string; fallbacks: string[] }>;
  workflows: Iterable<{ id: string; steps: { id: string; model?: string | undefined }[] }>;
}

export function pinsFor(sources: PinSources): Pins {
  const pins: Pins = new Map();
  const add = (modelId: string, pin: CatalogFindingPin): void => {
    const list = pins.get(modelId) ?? [];
    list.push(pin);
    pins.set(modelId, list);
  };
  for (const agent of sources.agents) {
    add(agent.primary, { agentId: agent.id, role: 'primary' });
    for (const f of agent.fallbacks) add(f, { agentId: agent.id, role: 'fallback' });
  }
  for (const wf of sources.workflows) {
    for (const step of wf.steps) if (step.model) add(step.model, { workflowId: wf.id, stepId: step.id });
  }
  return pins;
}

/** A stable, order-independent hash of the facts a finding rests on, so a dismissal lapses when they change. */
export function hashFacts(facts: unknown): string {
  const canonical = JSON.stringify(facts, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export function describePins(pins: CatalogFindingPin[]): string {
  return pins.map((p) => (p.agentId ? `${p.agentId} (${p.role})` : `${p.workflowId} › ${p.stepId}`)).join(', ');
}

export interface DiffInput {
  catalog: ModelsFile;
  provider: string;
  adapter: string;
  discovered: DiscoveredModel[];
  pins: Pins;
  now: Date;
  /** The endpoint an OpenAI-compatible provider was asked at, which a new entry has to name. */
  baseUrl?: string | undefined;
}

const CAPABILITY_KEYS = ['vision', 'audioInput', 'toolCalling', 'structuredOutput', 'streaming', 'reasoning', 'contextTokens', 'maxOutputTokens'] as const;

/** One provider's listing against the catalog entries that name that provider. Pure. */
export function diffProvider(input: DiffInput): CatalogFinding[] {
  const findings: CatalogFinding[] = [];
  const mine = input.catalog.models.filter((m) => providerOf(m.id) === input.provider);
  const offered = new Map(input.discovered.map((d) => [d.id, d]));
  const local = (id: string): string => id.slice(input.provider.length + 1);

  for (const d of input.discovered) {
    const modelId = `${input.provider}/${d.id}`;
    if (mine.some((m) => m.id === modelId)) continue;
    const proposed = compact({
      contextTokens: d.contextTokens, maxOutputTokens: d.maxOutputTokens, capabilities: d.capabilities, pricing: d.pricing,
    });
    findings.push({
      id: `new:${modelId}`, kind: 'new', modelId, adapter: input.adapter, provider: input.provider,
      factsHash: hashFacts({ kind: 'new', id: d.id, ...proposed }),
      detail: `${input.provider} offers a model the catalog does not list. Accepting adds it disabled${d.pricing?.length ? '' : ' and unpriced'}.`,
      ...(d.displayName !== undefined ? { displayName: d.displayName } : {}),
      ...(d.description !== undefined ? { description: d.description } : {}),
      pinnedBy: [],
      proposed,
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    });
  }

  for (const entry of mine) {
    const d = offered.get(local(entry.id));
    if (!d) {
      const pinnedBy = input.pins.get(entry.id) ?? [];
      findings.push({
        id: `retired:${entry.id}`, kind: 'retired', modelId: entry.id, adapter: entry.adapter, provider: input.provider,
        factsHash: hashFacts({ kind: 'retired', id: entry.id }),
        detail: pinnedBy.length
          ? `${input.provider} no longer offers this model, and it is pinned by ${describePins(pinnedBy)}. Accepting disables the entry; the pins are yours to change.`
          : `${input.provider} no longer offers this model. Accepting disables the entry.`,
        pinnedBy,
      });
      continue;
    }

    const stated = d.pricing?.length ? [...d.pricing].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0]! : undefined;
    const inEffect = priceFor(entry, input.now);
    if (stated && (!inEffect || stated.inputPerM !== inEffect.inputPerM || stated.outputPerM !== inEffect.outputPerM || (stated.cachedPerM ?? null) !== (inEffect.cachedPerM ?? null))) {
      const row: PriceRow = { ...stated, effectiveFrom: input.now.toISOString() };
      findings.push({
        id: `repriced:${entry.id}`, kind: 'repriced', modelId: entry.id, adapter: entry.adapter, provider: input.provider,
        factsHash: hashFacts({ kind: 'repriced', id: entry.id, inputPerM: stated.inputPerM, outputPerM: stated.outputPerM, cachedPerM: stated.cachedPerM ?? null }),
        detail: inEffect
          ? `${input.provider} states $${stated.inputPerM}/M in · $${stated.outputPerM}/M out; the catalog has $${inEffect.inputPerM}/M · $${inEffect.outputPerM}/M. Every budget cap depends on this number.`
          : `${input.provider} states $${stated.inputPerM}/M in · $${stated.outputPerM}/M out; the catalog has no price in effect.`,
        pinnedBy: [],
        proposed: { pricing: [row] },
      });
    }

    const changed: Record<string, { from: unknown; to: unknown }> = {};
    const caps = entry.capabilities as Record<string, unknown>;
    const statedCaps: Record<string, unknown> = { ...(d.capabilities ?? {}) };
    if (d.contextTokens !== undefined) statedCaps['contextTokens'] = d.contextTokens;
    if (d.maxOutputTokens !== undefined) statedCaps['maxOutputTokens'] = d.maxOutputTokens;
    for (const key of CAPABILITY_KEYS) {
      if (!(key in statedCaps)) continue;
      if (statedCaps[key] !== caps[key]) changed[key] = { from: caps[key], to: statedCaps[key] };
    }
    if (Object.keys(changed).length) {
      findings.push({
        id: `drift:${entry.id}`, kind: 'drift', modelId: entry.id, adapter: entry.adapter, provider: input.provider,
        factsHash: hashFacts({ kind: 'drift', id: entry.id, to: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.to])) }),
        detail: `${input.provider} states ${Object.entries(changed).map(([k, v]) => `${k} ${String(v.from ?? 'unset')} → ${String(v.to)}`).join(', ')}.`,
        pinnedBy: [],
        proposed: { capabilities: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.to])) },
      });
    }
  }
  return findings;
}

/**
 * The catalog that accepting a finding would produce. Exactly what hand-editing the file would do, and nothing
 * more: a new model arrives `enabled: false` with no price unless the provider stated one (D-64, D-65); a retired
 * one is disabled rather than deleted, so its price history survives; the provider's display name and
 * description are never written anywhere. Throws if the result would not parse, so a bad proposal cannot land.
 */
export function applyFinding(catalog: ModelsFile, finding: CatalogFinding, now: Date): ModelsFile {
  const models = catalog.models.map((m) => ({ ...m, capabilities: { ...m.capabilities }, pricing: [...m.pricing] }));
  const proposed = (finding.proposed ?? {}) as { contextTokens?: number; maxOutputTokens?: number; capabilities?: Record<string, unknown>; pricing?: PriceRow[] };
  const index = models.findIndex((m) => m.id === finding.modelId);

  if (finding.kind === 'new') {
    if (index !== -1) throw new Error(`${finding.modelId} is already in the catalog.`);
    const entry: CatalogEntry = CatalogEntrySchema.parse({
      id: finding.modelId,
      adapter: finding.adapter,
      ...(finding.baseUrl ? { baseUrl: finding.baseUrl } : {}),
      enabled: false,
      locality: 'cloud',
      capabilities: {
        text: true, vision: false, audioInput: false, toolCalling: 'basic', structuredOutput: 'json', streaming: true, reasoning: 'none',
        contextTokens: proposed.contextTokens ?? 8192,
        ...(proposed.maxOutputTokens !== undefined ? { maxOutputTokens: proposed.maxOutputTokens } : {}),
        ...(proposed.capabilities ?? {}),
      },
      pricing: proposed.pricing ?? [],
      dataPolicy: { trainsOnContent: 'unknown' },
    });
    models.push(entry);
    return { schemaVersion: 1, models };
  }

  if (index === -1) throw new Error(`${finding.modelId} is not in the catalog.`);
  const entry = models[index]!;
  if (finding.kind === 'retired') entry.enabled = false;
  if (finding.kind === 'repriced') {
    for (const row of proposed.pricing ?? []) entry.pricing.push({ ...row, effectiveFrom: row.effectiveFrom || now.toISOString() });
  }
  if (finding.kind === 'drift') {
    Object.assign(entry.capabilities, proposed.capabilities ?? {});
  }
  models[index] = CatalogEntrySchema.parse(entry);
  return { schemaVersion: 1, models };
}

function compact<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}
