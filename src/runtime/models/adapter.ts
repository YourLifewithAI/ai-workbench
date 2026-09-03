import type { CatalogEntry, ModelEvent, ModelRequest, ModelResponse } from '../../shared/model.js';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Injected into every adapter call; adapters never read env or call global fetch (D-01, D-33). */
export interface AdapterContext {
  fetch: FetchLike;
  apiKey: string | undefined;
  runId: string | undefined;
}

export interface ModelAdapter {
  readonly id: string;
  generate(model: CatalogEntry, req: ModelRequest, ctx: AdapterContext): Promise<ModelResponse>;
  stream(model: CatalogEntry, req: ModelRequest, ctx: AdapterContext): AsyncIterable<ModelEvent>;
}

export class AdapterRegistry {
  private readonly adapters = new Map<string, ModelAdapter>();
  register(adapter: ModelAdapter): void { this.adapters.set(adapter.id, adapter); }
  get(id: string): ModelAdapter | undefined { return this.adapters.get(id); }
  has(id: string): boolean { return this.adapters.has(id); }
  ids(): string[] { return [...this.adapters.keys()]; }
}
