import type { CatalogEntry, ModelsFile, PriceRow, Usage } from '../../shared/model.js';

export function findModel(catalog: ModelsFile, id: string): CatalogEntry | undefined {
  return catalog.models.find((m) => m.id === id);
}

/** The latest price row whose effectiveFrom is not after `at`. */
export function priceFor(entry: CatalogEntry, at: Date): PriceRow | undefined {
  const ts = at.toISOString();
  const rows = entry.pricing.filter((p) => p.effectiveFrom <= ts).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  return rows[0];
}

/** Cost in USD computed at call time from the price row in effect; 0 when the entry has no pricing (D-08). */
export function computeCost(entry: CatalogEntry, usage: Usage, at: Date): number {
  const price = priceFor(entry, at);
  if (!price) return 0;
  const cached = usage.cachedInput ?? 0;
  const written = usage.cacheWriteInput ?? 0;
  const uncachedInput = Math.max(0, usage.input - cached - written);
  const cachedRate = price.cachedPerM ?? price.inputPerM;
  // A cache write is billed at 1.25× the input rate (Anthropic's five-minute cache); a provider that reports
  // no writes pays nothing extra here, and one with no cached rate on record pays full price for reads.
  const output = usage.output + (usage.reasoning ?? 0);
  const cost = (uncachedInput * price.inputPerM + cached * cachedRate + written * price.inputPerM * 1.25 + output * price.outputPerM) / 1_000_000;
  return Math.round(cost * 1e8) / 1e8;
}
