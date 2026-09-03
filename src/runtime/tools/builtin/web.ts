// The two tools that reach the internet. Everything they send goes through `ctx.net.fetch`, which is the broker
// with the full egress checker behind it; neither of these files decides anything about where a request may go.
import { z } from 'zod';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { Permissions } from '../../../shared/permissions.js';
import { toolError, type ToolDefinition } from '../../../shared/tool.js';

const NET_ONLY = Permissions.parse({ net: { mode: 'allowlist', allow: [], allowLocalAddresses: false } });

export interface WebToolDeps {
  maxResponseBytes: () => number;
  timeoutMs: () => number;
  search: () => SearchProvider;
}

export interface SearchHit { title: string; url: string; snippet: string; published?: string | undefined }
export interface SearchProvider {
  readonly id: 'brave' | 'searxng' | 'mock';
  search(query: string, options: { count: number; freshness: 'day' | 'week' | 'month' | 'any' }, fetchLike: (url: string, init?: RequestInit) => Promise<Response>): Promise<SearchHit[]>;
}

export function webTools(deps: WebToolDeps): ToolDefinition[] {
  const fetchTool: ToolDefinition<
    { url: string; maxBytes?: number | undefined; accept?: string | undefined },
    { status: number; finalUrl: string; contentType: string; title: string | null; text: string; links: { text: string; url: string }[]; truncated: boolean; bytes: number }
  > = {
    id: 'http.fetch',
    version: '1.0.0',
    description: 'Fetch one web page and read it. Returns the article text with the navigation stripped, and the links separately. GET only.',
    input: z.object({
      url: z.string().url().describe('An http or https URL.'),
      maxBytes: z.number().int().positive().max(8_000_000).optional(),
      accept: z.string().optional().describe('An Accept header, if you need something other than a web page.'),
    }),
    output: z.object({
      status: z.number().int(),
      finalUrl: z.string(),
      contentType: z.string(),
      title: z.string().nullable(),
      text: z.string(),
      links: z.array(z.object({ text: z.string(), url: z.string() })),
      truncated: z.boolean(),
      bytes: z.number().int(),
    }),
    tier: 'read',
    maxPermissions: NET_ONLY,
    execute: async (input, ctx) => {
      let response: Response;
      try {
        response = await ctx.net.fetch(input.url, {
          method: 'GET',
          headers: { accept: input.accept ?? 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8' },
        });
      } catch (e) {
        return toolError('PermissionDenied', (e as Error).message, (e as { hint?: string }).hint);
      }

      const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      const finalUrl = response.url || input.url;
      const raw = Buffer.from(await response.arrayBuffer());
      const truncated = response.headers.get('x-workbench-truncated') === '1';

      // Structured output (D-51): extracted text and links stay apart, so a model is never asked to tell a
      // page's navigation from its argument by eye.
      if (contentType === 'application/json' || contentType.endsWith('+json')) {
        const text = raw.toString('utf8');
        return { ok: true, output: { status: response.status, finalUrl, contentType, title: null, text, links: [], truncated, bytes: raw.length } };
      }
      if (contentType === 'text/plain' || contentType === 'text/markdown' || contentType === '') {
        return { ok: true, output: { status: response.status, finalUrl, contentType: contentType || 'text/plain', title: null, text: raw.toString('utf8'), links: [], truncated, bytes: raw.length } };
      }
      if (contentType !== 'text/html' && contentType !== 'application/xhtml+xml') {
        return toolError('ToolError', `${finalUrl} is ${contentType}, which this tool cannot read. It handles HTML, JSON, and plain text.`, 'Ask for a different URL, or use `accept` to request one of those.');
      }

      const extracted = extractArticle(raw.toString('utf8'), finalUrl);
      return {
        ok: true,
        output: { status: response.status, finalUrl, contentType, ...extracted, truncated, bytes: raw.length },
      };
    },
  };

  const searchTool: ToolDefinition<
    { query: string; count?: number | undefined; freshness?: 'day' | 'week' | 'month' | 'any' | undefined },
    { results: SearchHit[]; provider: string }
  > = {
    id: 'web.search',
    version: '1.0.0',
    description: 'Search the web. Returns titles, URLs and snippets — read a page with http.fetch when a snippet is not enough.',
    input: z.object({
      query: z.string().min(1).max(400),
      count: z.number().int().min(1).max(20).default(8),
      freshness: z.enum(['day', 'week', 'month', 'any']).default('any'),
    }),
    output: z.object({
      results: z.array(z.object({ title: z.string(), url: z.string(), snippet: z.string(), published: z.string().optional() })),
      provider: z.string(),
    }),
    tier: 'read',
    maxPermissions: NET_ONLY,
    credentials: ['brave'],
    execute: async (input, ctx) => {
      const provider = deps.search();
      try {
        const results = await provider.search(
          input.query,
          { count: input.count ?? 8, freshness: input.freshness ?? 'any' },
          (url, init) => ctx.net.fetch(url, init),
        );
        return { ok: true, output: { results, provider: provider.id } };
      } catch (e) {
        return toolError('ToolError', `The ${provider.id} search provider failed: ${(e as Error).message}`, (e as { hint?: string }).hint);
      }
    },
  };

  void deps.maxResponseBytes;
  void deps.timeoutMs;
  return [fetchTool as ToolDefinition, searchTool as ToolDefinition];
}

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

/**
 * Readability strips the navigation, the cookie banner, and the eight related-articles blocks, leaving the
 * thing the page is actually about. When it cannot find an article, the whole body is the fallback: a page
 * that is a table of contents is still worth reading.
 */
export function extractArticle(html: string, url: string): { title: string | null; text: string; links: { text: string; url: string }[] } {
  const { document } = parseHTML(html);
  const links: { text: string; url: string }[] = [];
  const seen = new Set<string>();
  for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
    const href = anchor.getAttribute('href');
    if (!href) continue;
    let absolute: string;
    try {
      absolute = new URL(href, url).toString();
    } catch {
      continue;
    }
    if (!absolute.startsWith('http')) continue;
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    links.push({ text: (anchor.textContent ?? '').trim().slice(0, 200), url: absolute });
  }

  const title = document.querySelector('title')?.textContent?.trim() ?? null;
  let text: string;
  try {
    // Readability mutates the document, so links are collected first.
    const article = new Readability(document as unknown as Document).parse();
    text = article?.content ? turndown.turndown(article.content) : (document.body?.textContent ?? '').trim();
    return { title: article?.title?.trim() || title, text, links };
  } catch {
    return { title, text: (document.body?.textContent ?? '').trim(), links };
  }
}
