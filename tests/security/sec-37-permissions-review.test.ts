// SEC-37 (RUN-14, D-63): the auditor cannot read what it audits the access to, and no run can write the grant
// matrix. The first is a property of one agent's grant and of its two tools; the second is a property of the
// whole tool catalogue and of where `setGrant` is reachable from — behind the token, on a human's request.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { GrantCell, ToolsResponse } from '../../src/shared/api/index.js';
import type { EventRecord } from '../../src/shared/events.js';
import { startRuntime, tempWorkspace, waitFor, type Started } from '../helpers/workspace.js';

let ws: string;
let rt: Started;
const CONTENT_TOOLS = ['artifact.read', 'artifact.list', 'memory.search', 'knowledge.search', 'fs.read', 'fs.list', 'repo.read', 'http.fetch', 'web.search'];

beforeAll(async () => {
  ws = tempWorkspace('sec37');
  rt = await startRuntime(ws, { ephemeral: false, port: 0, providerOverride: 'mock' });
});
afterAll(async () => { await rt.stop(); });

const headers = (): Record<string, string> => ({ Authorization: `Bearer ${rt.token}`, 'Content-Type': 'application/json' });
const api = (method: string, p: string, body?: unknown, extra: Record<string, string> = {}): Promise<Response> =>
  fetch(`${rt.baseUrl}/api/v1${p}`, { method, headers: { ...headers(), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe('SEC-37 the auditor holds nothing that reads content', () => {
  it('its matrix row grants exactly the two metadata tools, and neither may touch a path, a host or a credential', async () => {
    const tools = (await (await api('GET', '/tools')).json()) as ToolsResponse;
    const row = tools.matrix.filter((c: GrantCell) => c.agentId === 'auditor' && c.granted !== 'unset');
    expect(row.map((c) => `${c.toolId}:${c.granted}`).sort()).toEqual(['permissions.facts:allow', 'permissions.propose:allow']);
    for (const id of ['permissions.facts', 'permissions.propose']) {
      const tool = rt.runtime.engine.tools.catalog().find((t) => t.id === id)!;
      expect(tool.maxPermissions.fs).toEqual({ read: [], write: [] });
      expect(tool.maxPermissions.net.allow).toEqual([]);
      expect(tool.credentials ?? []).toEqual([]);
      expect(tool.usesNetwork ?? false).toBe(false);
    }
  });

  it('a run of permissions-review makes no artifact, memory, knowledge, file, repository or web call', async () => {
    const res = await api('POST', '/runs', { kind: 'workflow', id: 'permissions-review', inputs: {}, provider: 'mock' });
    expect(res.status).toBe(202);
    const { runId } = (await res.json()) as { runId: string };
    await waitFor(async () => ((await (await api('GET', `/runs/${runId}`)).json()) as { state: string }).state === 'completed', 60_000);
    const trace = (await (await api('GET', `/runs/${runId}/trace.jsonl`)).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l) as EventRecord);
    const requested = trace.filter((e) => e.type === 'tool-requested').map((e) => String(e.payload['tool']));
    expect(requested.length).toBeGreaterThan(0);
    for (const tool of requested) expect(CONTENT_TOOLS, `the auditor called ${tool}`).not.toContain(tool);
    expect(new Set(requested)).toEqual(new Set(['permissions.facts', 'permissions.propose']));
    // The facts it was shown carry instructions and numbers, never a trace or a document body.
    const facts = rt.runtime.permissionFacts();
    expect(JSON.stringify(facts)).not.toMatch(/seed run from e2e|"content":/);
  }, 90_000);
});

describe('SEC-37 no run can write the grant matrix', () => {
  it('no tool in the catalogue sets a grant, and the finding routes refuse without the token', async () => {
    const catalogue = rt.runtime.engine.tools.catalog();
    for (const tool of catalogue) {
      expect(tool.id, tool.id).not.toMatch(/grant|permissions\.(set|apply|write|decide)/);
    }
    // The only writers are human requests: the Tools screen's route and a finding's apply. Both need the token.
    expect((await fetch(`${rt.baseUrl}/api/v1/permissions/findings/x`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"decision":"apply"}' })).status).toBe(401);
    expect((await fetch(`${rt.baseUrl}/api/v1/tools/grants`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect((await api('POST', '/permissions/findings/x', { decision: 'apply' }, { Origin: 'http://evil.example' })).status).toBe(403);
  });

  it('the matrix file is under the hard deny, and a review run leaves it byte-for-byte alone', async () => {
    const file = path.join(ws, 'config', 'workbench.json');
    const before = fs.readFileSync(file, 'utf8');
    const res = await api('POST', '/runs', { kind: 'workflow', id: 'permissions-review', inputs: {}, provider: 'mock' });
    const { runId } = (await res.json()) as { runId: string };
    await waitFor(async () => ((await (await api('GET', `/runs/${runId}`)).json()) as { state: string }).state === 'completed', 60_000);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    // grant_log is written by a human's request only: a review run adds no row.
    expect((rt.runtime.db.prepare('SELECT COUNT(*) AS n FROM grant_log').get() as { n: number }).n).toBe(0);
  }, 90_000);
});
