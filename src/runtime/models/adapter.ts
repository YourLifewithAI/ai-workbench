import type { CatalogEntry, DiscoveredModel, ModelEvent, ModelRequest, ModelResponse } from '../../shared/model.js';

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Injected into every adapter call; adapters never read env or call global fetch (D-01, D-33). */
export interface AdapterContext {
  fetch: FetchLike;
  apiKey: string | undefined;
  runId: string | undefined;
  /** For a listing under `--provider mock`: which provider's scripted listing to serve (D-37, D-64). */
  provider?: string | undefined;
  /** For a listing by an OpenAI-compatible adapter: the endpoint to ask, since the adapter never guesses one. */
  baseUrl?: string | undefined;
}

export interface ModelAdapter {
  readonly id: string;
  generate(model: CatalogEntry, req: ModelRequest, ctx: AdapterContext): Promise<ModelResponse>;
  stream(model: CatalogEntry, req: ModelRequest, ctx: AdapterContext): AsyncIterable<ModelEvent>;
  /**
   * What the provider offers (D-64). Optional on purpose: an OpenAI-compatible endpoint may have no such
   * route and the mock has nothing real to list. An adapter without it is not broken — its models simply
   * stay hand-declared. The answer is untrusted data fetched through the injected, egress-checked fetch.
   */
  listModels?(ctx: AdapterContext): Promise<DiscoveredModel[]>;
}

export class AdapterRegistry {
  private readonly adapters = new Map<string, ModelAdapter>();
  register(adapter: ModelAdapter): void { this.adapters.set(adapter.id, adapter); }
  get(id: string): ModelAdapter | undefined { return this.adapters.get(id); }
  has(id: string): boolean { return this.adapters.has(id); }
  ids(): string[] { return [...this.adapters.keys()]; }
}
