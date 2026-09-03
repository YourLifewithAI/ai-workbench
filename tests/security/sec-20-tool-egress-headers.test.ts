// SEC-20 (completed in RUN-07): the tool-egress path stores no credential header either. The search provider
// sends the Brave key on every request; this proves it reaches the wire and nothing else — not an event, not
// the egress log, not a tool_calls row, not the trace, not the runtime log.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { describe, it, expect } from 'vitest';
import { startRuntime, tempWorkspace, waitFor } from '../helpers/workspace.js';

const PUBLIC = '203.0.113.9';

describe('SEC-20 the tool-egress path stores no credential header', () => {
  it('the search key goes over the wire and appears in no row, event, trace, or log', async () => {
    const KEY = `BSA${randomBytes(16).toString('hex')}`;
    const seen: { authorization: string | undefined; token: string | undefined }[] = [];

    const server = http.createServer((req, res) => {
      seen.push({ authorization: req.headers['authorization'] as string | undefined, token: req.headers['x-subscription-token'] as string | undefined });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        web: { results: [{ title: 'Local-first software', url: 'https://example.test/local-first', description: 'Seven principles.' }] },
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;

    const ws = tempWorkspace('sec20-tool');
    const file = path.join(ws, 'config', 'workbench.json');
    const config = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    config['network'] = { mode: 'allowlist', allow: ['api.search.brave.com'], allowLocalAddresses: false, approvalExempt: [] };
    config['search'] = { provider: 'brave' };
    fs.writeFileSync(file, JSON.stringify(config, null, 2));
    fs.writeFileSync(path.join(ws, 'config', 'credentials.json'), JSON.stringify({ brave: { apiKey: KEY } }), { mode: 0o600 });
    fs.writeFileSync(path.join(ws, 'fixtures', 'aaa-1.json'), JSON.stringify({
      match: { systemIncludes: 'The Researcher' },
      respond: { text: 'Searching.', toolCalls: [{ name: 'web.search', input: { query: 'local-first software' } }] },
    }));
    fs.writeFileSync(path.join(ws, 'fixtures', 'aab-2.json'), JSON.stringify({
      match: { systemIncludes: 'The Researcher', afterTool: 'web.search' },
      respond: { text: 'One result: https://example.test/local-first' },
    }));
    // The later turn has to be tried first: the first fixture whose match holds wins.
    fs.renameSync(path.join(ws, 'fixtures', 'aab-2.json'), path.join(ws, 'fixtures', 'aa0-2.json'));

    const rt = await startRuntime(ws, {
      providerOverride: 'mock',
      noScheduler: true,
      lookup: async (hostname: string) => {
        if (hostname !== 'api.search.brave.com') throw new Error(`${hostname} does not resolve`);
        return [{ address: PUBLIC, family: 4 as const }];
      },
      connect: (_options: unknown, callback: unknown): void => {
        const socket = net.connect(port, '127.0.0.1');
        socket.on('connect', () => (callback as (e: Error | null, s: unknown) => void)(null, socket));
        socket.on('error', (e) => (callback as (e: Error | null, s: unknown) => void)(e, null));
      },
    });

    try {
      const { runId, done } = rt.runtime.engine.startAgentRun({ agentId: 'researcher', inputs: { input: 'What is local-first software?' }, project: 'briefings' });
      await done;
      await waitFor(() => seen.length > 0, 5_000);
      expect(rt.runtime.engine.getRun(runId)?.state).toBe('completed');

      // It really went out, with the key on it: this is a test about storage, not about a request that never happened.
      expect(seen).toHaveLength(1);
      expect(seen[0]!.token, 'the provider authenticates with the key').toBe(KEY);

      const stored = [
        ...(rt.runtime.db.prepare('SELECT payload_json AS v FROM events').all() as { v: string }[]),
        ...(rt.runtime.db.prepare('SELECT json_group_array(json_object(\'a\', body_redacted, \'b\', reason, \'c\', host)) AS v FROM egress_log').all() as { v: string }[]),
        ...(rt.runtime.db.prepare('SELECT json_group_array(json_object(\'a\', args_json, \'b\', reason)) AS v FROM tool_calls').all() as { v: string }[]),
      ];
      for (const row of stored) {
        expect(row.v).not.toContain(KEY);
        expect(row.v.toLowerCase()).not.toContain('x-subscription-token');
      }

      const trace = await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}/trace.jsonl`, { headers: { Authorization: `Bearer ${rt.token}` } })).text();
      expect(trace).not.toContain(KEY);
      expect(trace.toLowerCase()).not.toContain('x-subscription-token');

      // The egress is still on the record — redaction is not the same as hiding the request.
      const log = rt.runtime.db.prepare('SELECT host, decision, purpose FROM egress_log').all() as { host: string; decision: string; purpose: string }[];
      expect(log.some((e) => e.host === 'api.search.brave.com' && e.decision === 'allowed')).toBe(true);
    } finally {
      await rt.stop();
      server.close();
    }
    const runtimeLog = path.join(ws, 'data', 'logs', 'runtime.log');
    if (fs.existsSync(runtimeLog)) expect(fs.readFileSync(runtimeLog, 'utf8')).not.toContain(KEY);
  }, 60_000);
});
