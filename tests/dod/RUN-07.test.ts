// RUN-07 Definition of done (spec/runs/RUN-07.md). The whole point of the injected `lookup` and `connect` is
// that the checker believes it is reaching a public host while the socket lands on a local server.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CLI_DIST, startRuntime, tempWorkspace, waitFor, type Started } from '../helpers/workspace.js';
import type { EventRecord } from '../../src/shared/events.js';
import type { PrivacyResponse, RunDetail, ScheduleSummary } from '../../src/shared/api/index.js';

beforeAll(() => {
  if (!fs.existsSync(CLI_DIST)) throw new Error('dist/cli.js is missing: run `npm run build` (or `npm run dod -- 07`, which builds first).');
});

const headers = (rt: Started): Record<string, string> => ({ Authorization: `Bearer ${rt.token}`, 'Content-Type': 'application/json' });
/** TEST-NET-3: reserved for documentation, public as far as the checker is concerned, routable nowhere. */
const PUBLIC = '203.0.113.7';

const PAGES: Record<string, string> = {
  '/local-first': `<html><head><title>Local-first software</title></head><body><nav>Home About</nav><article>
    <h1>Local-first software</h1>
    <p>Seven principles. The one people forget is that the network is optional, not absent: sync when you can, work when you cannot.</p>
    <p>See also <a href="https://allowed.test/crdts-in-production">a year of CRDTs</a>.</p>
  </article><footer>Cookie notice</footer></body></html>`,
  '/crdts-in-production': `<html><head><title>A year of CRDTs in production</title></head><body><article>
    <h1>A year of CRDTs in production</h1>
    <p>Merge conflicts stopped being a support ticket. Storage grew nine per cent a month until we added compaction.</p>
  </article></body></html>`,
  '/sync-engines': `<html><head><title>Sync engines, compared</title></head><body><article>
    <h1>Sync engines, compared</h1><p>Six engines, three tradeoffs: ordering, storage, and who resolves a conflict.</p>
  </article></body></html>`,
};

/** The web, for the purposes of this test: three pages on `allowed.test`, served from loopback. */
let server: http.Server;
let port = 0;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const page = PAGES[url.pathname];
    if (!page) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => { server.close(); });

/** `*.test` resolves to a public address; the socket still lands on the local server. */
const lookup = async (hostname: string) => {
  if (!hostname.endsWith('.test')) throw new Error(`${hostname} does not resolve`);
  return [{ address: PUBLIC, family: 4 as const }];
};
const connect = (_options: unknown, callback: unknown): void => {
  const socket = net.connect(port, '127.0.0.1');
  socket.on('connect', () => (callback as (e: Error | null, s: unknown) => void)(null, socket));
  socket.on('error', (e) => (callback as (e: Error | null, s: unknown) => void)(e, null));
};

function fixture(ws: string, name: string, body: unknown): void {
  fs.writeFileSync(path.join(ws, 'fixtures', name), JSON.stringify(body, null, 2));
}

function config(ws: string, over: Record<string, unknown>): void {
  const file = path.join(ws, 'config', 'workbench.json');
  const current = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(file, JSON.stringify({ ...current, ...over }, null, 2));
}

const traceOf = async (rt: Started, runId: string): Promise<EventRecord[]> =>
  (await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}/trace.jsonl`, { headers: headers(rt) })).text())
    .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as EventRecord);

const detailOf = async (rt: Started, runId: string): Promise<RunDetail> =>
  (await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}`, { headers: headers(rt) })).json()) as RunDetail;

describe('DoD 1: the briefing runs end to end on the mock, citing what it actually fetched', () => {
  it('search finds URLs, the researcher reads them, and the document cites them', async () => {
    const ws = tempWorkspace('dod07-1');
    config(ws, { network: { mode: 'allowlist', allow: ['allowed.test'], allowLocalAddresses: false, approvalExempt: [] } });
    // The planner asks two questions; both researchers then run at once, each searching, fetching, and
    // answering. They are scripted by what they were asked and what they have already called rather than by
    // `callIndex`, which counts every call the *run* makes and so interleaves under a parallel map. The first
    // fixture whose match holds wins, so the later turns are listed first.
    fixture(ws, 'aaa-local-first-answer.json', {
      match: { systemIncludes: 'The Researcher', lastUserIncludes: 'local-first', afterTool: 'http.fetch' },
      respond: { text: 'The network is optional, not absent (https://allowed.test/local-first).' },
    });
    fixture(ws, 'aab-local-first-fetch.json', {
      match: { systemIncludes: 'The Researcher', lastUserIncludes: 'local-first', afterTool: 'web.search' },
      respond: { text: 'Reading the first result.', toolCalls: [{ name: 'http.fetch', input: { url: 'https://allowed.test/local-first' } }] },
    });
    fixture(ws, 'aac-local-first-search.json', {
      match: { systemIncludes: 'The Researcher', lastUserIncludes: 'local-first' },
      respond: { text: 'Searching.', toolCalls: [{ name: 'web.search', input: { query: 'local-first software' } }] },
    });
    fixture(ws, 'aad-sync-answer.json', {
      match: { systemIncludes: 'The Researcher', lastUserIncludes: 'sync engines', afterTool: 'http.fetch' },
      respond: { text: 'Ordering, storage, and who resolves a conflict (https://allowed.test/sync-engines).' },
    });
    fixture(ws, 'aae-sync-fetch.json', {
      match: { systemIncludes: 'The Researcher', lastUserIncludes: 'sync engines', afterTool: 'web.search' },
      respond: { text: 'Reading it.', toolCalls: [{ name: 'http.fetch', input: { url: 'https://allowed.test/sync-engines' } }] },
    });
    fixture(ws, 'aaf-sync-search.json', {
      match: { systemIncludes: 'The Researcher', lastUserIncludes: 'sync engines' },
      respond: { text: 'Searching.', toolCalls: [{ name: 'web.search', input: { query: 'sync engines compared' } }] },
    });
    fixture(ws, 'aag-plan.json', {
      match: { systemIncludes: 'The Planner' },
      respond: { json: { questions: ['what is local-first software', 'how do sync engines differ'] } },
    });
    fixture(ws, 'aah-synth.json', {
      match: { systemIncludes: 'The Synthesizer' },
      respond: { text: '# Local-first, this week\n\nThe network is optional, not absent (https://allowed.test/local-first).\n\n## Sync\n\nThree tradeoffs (https://allowed.test/sync-engines).' },
    });
    fixture(ws, 'aai-review.json', { match: { systemIncludes: 'The Reviewer' }, respond: { text: 'Every claim carries a source. Nothing missing.' } });

    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true, lookup, connect });
    try {
      const started = await fetch(`${rt.baseUrl}/api/v1/runs`, {
        method: 'POST', headers: headers(rt),
        body: JSON.stringify({ kind: 'workflow', id: 'research-briefing', inputs: { topic: 'local-first software' } }),
      });
      expect(started.status).toBe(202);
      const { runId } = (await started.json()) as { runId: string };
      await waitFor(async () => (await detailOf(rt, runId)).state === 'completed', 60_000);

      const trace = await traceOf(rt, runId);
      // The search really ran, and returned the fixture's URLs.
      const search = trace.find((e) => e.type === 'tool-completed' && e.payload['tool'] === 'web.search')!;
      const results = (search.payload['output'] as { results: { url: string }[] }).results;
      expect(results.map((r) => r.url)).toContain('https://allowed.test/local-first');

      // The fetch really went over a socket, and came back with the article rather than the navigation.
      // Selected by the URL it fetched, not by being first: the briefing fetches two pages concurrently, and
      // which one finishes first is the scheduler's business. Taking `find`'s first match passed on Linux and
      // macOS by luck and failed on Windows with the sync-engines page in hand.
      const fetched = trace.find((e) => e.type === 'tool-completed' && e.payload['tool'] === 'http.fetch'
        && (e.payload['output'] as { finalUrl?: string } | undefined)?.finalUrl === 'https://allowed.test/local-first')!;
      expect(fetched, 'the local-first page was fetched').toBeDefined();
      const page = fetched.payload['output'] as { title: string; text: string; links: { url: string }[]; status: number };
      expect(page.status).toBe(200);
      expect(page.title).toBe('Local-first software');
      expect(page.text).toContain('the network is optional, not absent');
      expect(page.text, 'Readability drops the navigation and the cookie notice').not.toContain('Cookie notice');
      expect(page.links.map((l) => l.url)).toContain('https://allowed.test/crdts-in-production');

      // And the document exists, citing what was fetched.
      const documents = (await (await fetch(`${rt.baseUrl}/api/v1/projects/briefings/documents`, { headers: headers(rt) })).json()) as { documents: { id: string; path: string }[] };
      const briefing = documents.documents.find((d) => d.path === 'local-first software.md');
      expect(briefing, 'filed under the topic').toBeDefined();
      const detail = (await (await fetch(`${rt.baseUrl}/api/v1/documents/${briefing!.id}`, { headers: headers(rt) })).json()) as { content: string };
      expect(detail.content).toContain('https://allowed.test/local-first');

      // Every egress is on the record, with the host the checker approved.
      const privacy = (await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}/privacy`, { headers: headers(rt) })).json()) as PrivacyResponse;
      expect(privacy.egress.some((e) => e.host === 'allowed.test' && e.decision === 'allowed')).toBe(true);
    } finally {
      await rt.stop();
    }
  }, 180_000);
});

describe('DoD 3: a host outside the allowlist is refused before any DNS query', () => {
  it('the denial names the policy, appears in the trace, and shows in the Inspector', async () => {
    const ws = tempWorkspace('dod07-3');
    config(ws, { network: { mode: 'allowlist', allow: ['*.gov'], allowLocalAddresses: false, approvalExempt: [] } });
    fixture(ws, 'aaa-1.json', {
      match: { systemIncludes: 'The Researcher', callIndex: 1 },
      respond: { text: 'Reading it.', toolCalls: [{ name: 'http.fetch', input: { url: 'https://example.com/page' } }] },
    });
    fixture(ws, 'aab-2.json', { match: { systemIncludes: 'The Researcher', callIndex: 2 }, respond: { text: 'That host is not allowed, so I could not read it.' } });

    let resolved = 0;
    const countingLookup = async (hostname: string) => { resolved += 1; return lookup(hostname); };
    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true, lookup: countingLookup, connect });
    try {
      const started = await fetch(`${rt.baseUrl}/api/v1/runs`, {
        method: 'POST', headers: headers(rt),
        body: JSON.stringify({ kind: 'agent', id: 'researcher', inputs: { input: 'What is on example.com?' }, project: 'briefings' }),
      });
      const { runId } = (await started.json()) as { runId: string };
      await waitFor(async () => (await detailOf(rt, runId)).state === 'completed', 60_000);

      expect(resolved, 'refused before the resolver was ever asked').toBe(0);

      const trace = await traceOf(rt, runId);
      const denied = trace.find((e) => e.type === 'egress-denied')!;
      expect(denied.payload['host']).toBe('example.com');
      expect(String(denied.payload['reason'])).toContain('network allowlist');

      const result = trace.find((e) => e.type === 'tool-completed' && e.payload['tool'] === 'http.fetch')!;
      const error = result.payload['error'] as { code: string; message: string; hint: string };
      expect(error.code).toBe('PermissionDenied');
      expect(error.hint, 'the hint names the policy that refused it').toContain('allowlist mode');

      const privacy = (await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}/privacy`, { headers: headers(rt) })).json()) as PrivacyResponse;
      expect(privacy.egress.some((e) => e.host === 'example.com' && e.decision === 'denied')).toBe(true);

      // The run finished anyway: a refusal is a result the agent reads, not a crash.
      expect((await detailOf(rt, runId)).state).toBe('completed');
    } finally {
      await rt.stop();
    }
  }, 180_000);
});

describe('DoD 4: the briefing schedules itself from its own file', () => {
  it('a schedule row exists after the workspace loads, and is not re-seeded on the next start', async () => {
    const ws = tempWorkspace('dod07-4');
    const first = await startRuntime(ws, { noScheduler: true });
    let schedules: ScheduleSummary[];
    try {
      schedules = ((await (await fetch(`${first.baseUrl}/api/v1/schedules`, { headers: headers(first) })).json()) as { schedules: ScheduleSummary[] }).schedules;
    } finally {
      await first.stop();
    }
    const seeded = schedules.filter((s) => s.workflowId === 'research-briefing');
    expect(seeded).toHaveLength(1);
    expect(seeded[0]!.cron).toBe('0 7 * * *');
    expect(seeded[0]!.catchUp).toBe('once');
    expect(seeded[0]!.seededFromFile).toBe(true);
    expect(seeded[0]!.nextFireAt).not.toBeNull();

    // A second start does not seed a second row: the row is the owner's to edit from then on (D-15).
    const second = await startRuntime(ws, { noScheduler: true });
    try {
      const again = ((await (await fetch(`${second.baseUrl}/api/v1/schedules`, { headers: headers(second) })).json()) as { schedules: ScheduleSummary[] }).schedules;
      expect(again.filter((s) => s.workflowId === 'research-briefing')).toHaveLength(1);
    } finally {
      await second.stop();
    }
  }, 120_000);
});

describe('DoD 2: the same briefing on real models', () => {
  it.skipIf(process.env['WB_LIVE'] !== '1')('produces a briefing under a dollar', async () => {
    const ws = tempWorkspace('dod07-2');
    config(ws, {
      network: { mode: 'allowlist', allow: ['api.search.brave.com'], allowLocalAddresses: false, approvalExempt: [] },
      search: { provider: 'brave' },
      budgets: { maxCostUsd: 1 },
    });
    const rt = await startRuntime(ws);
    try {
      const started = await fetch(`${rt.baseUrl}/api/v1/runs`, {
        method: 'POST', headers: headers(rt),
        body: JSON.stringify({ kind: 'workflow', id: 'research-briefing', inputs: { topic: 'local-first software' } }),
      });
      const { runId } = (await started.json()) as { runId: string };
      await waitFor(async () => (await detailOf(rt, runId)).state === 'completed', 300_000);
      const detail = await detailOf(rt, runId);
      expect(detail.spent.costUsd).toBeLessThan(1);
      expect(String(detail.outputs?.['briefing']).length).toBeGreaterThan(400);
    } finally {
      await rt.stop();
    }
  }, 600_000);
});
