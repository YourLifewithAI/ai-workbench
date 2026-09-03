// Search providers (D-44). Each one is a shape adapter over the same `ctx.net.fetch`: the checker decides
// whether the provider's own endpoint may be reached, and a configured provider is a declared endpoint.
//
// This lives outside `tools/` because the mock provider reads a fixture file, and `tools/` is the one place in
// the runtime that may never touch a filesystem directly. The runtime hands the fixture in.
import type { SearchHit, SearchProvider } from '../tools/builtin/web.js';

export interface SearchDeps {
  provider: 'brave' | 'searxng' | 'mock';
  searxngUrl?: string | undefined;
  braveKey?: (() => string | undefined) | undefined;
  /** `<workspace>/fixtures/search.json`, already read. `null` when there is none. */
  fixture?: (() => MockSearchFixture | null) | undefined;
}

export interface MockSearchFixture { queries?: { match: string; results: SearchHit[] }[] }

export function searchProvider(deps: SearchDeps): SearchProvider {
  if (deps.provider === 'brave') return brave(deps);
  if (deps.provider === 'searxng') return searxng(deps);
  return mock(deps);
}

function brave(deps: SearchDeps): SearchProvider {
  return {
    id: 'brave',
    async search(query, options, fetchLike) {
      const key = deps.braveKey?.();
      if (!key) throw Object.assign(new Error('The Brave search provider needs a `brave` credential.'), { hint: 'Add it to config/credentials.json, or set WORKBENCH_CRED_BRAVE.' });
      const url = new URL('https://api.search.brave.com/res/v1/web/search');
      url.searchParams.set('q', query);
      url.searchParams.set('count', String(options.count));
      if (options.freshness !== 'any') url.searchParams.set('freshness', { day: 'pd', week: 'pw', month: 'pm' }[options.freshness]);

      const response = await fetchLike(url.toString(), {
        headers: { accept: 'application/json', 'accept-encoding': 'gzip', 'x-subscription-token': key },
      });
      if (!response.ok) throw new Error(`Brave answered ${response.status}.`);
      const body = (await response.json()) as { web?: { results?: { title?: string; url?: string; description?: string; age?: string }[] } };
      return (body.web?.results ?? []).slice(0, options.count).map((r): SearchHit => ({
        title: r.title ?? '', url: r.url ?? '', snippet: stripTags(r.description ?? ''), ...(r.age ? { published: r.age } : {}),
      })).filter((r) => r.url);
    },
  };
}

function searxng(deps: SearchDeps): SearchProvider {
  return {
    id: 'searxng',
    async search(query, options, fetchLike) {
      if (!deps.searxngUrl) throw Object.assign(new Error('The SearXNG provider needs `search.searxng.url` in config.'), { hint: 'Point it at your instance, e.g. http://127.0.0.1:8888.' });
      const url = new URL('/search', deps.searxngUrl);
      url.searchParams.set('q', query);
      url.searchParams.set('format', 'json');
      if (options.freshness !== 'any') url.searchParams.set('time_range', options.freshness);

      const response = await fetchLike(url.toString(), { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`SearXNG answered ${response.status}.`);
      const body = (await response.json()) as { results?: { title?: string; url?: string; content?: string; publishedDate?: string }[] };
      return (body.results ?? []).slice(0, options.count).map((r): SearchHit => ({
        title: r.title ?? '', url: r.url ?? '', snippet: stripTags(r.content ?? ''), ...(r.publishedDate ? { published: r.publishedDate } : {}),
      })).filter((r) => r.url);
    },
  };
}

/**
 * `--provider mock` mocks every external service, search included. The fixture file is a list of substrings
 * and the results they stand for; an unmatched query returns nothing, which is a real thing search does.
 */
function mock(deps: SearchDeps): SearchProvider {
  return {
    id: 'mock',
    async search(query, options) {
      const fixture = deps.fixture?.();
      if (!fixture) return [];
      const lower = query.toLowerCase();
      const matched = (fixture.queries ?? []).find((q) => lower.includes(q.match.toLowerCase()));
      return (matched?.results ?? []).slice(0, options.count);
    },
  };
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, '').trim();
}
