// The editor's write path is a human's and only a human's (RUN-13): behind the token and the origin check like
// every route (SEC-01, SEC-02), out of reach of any tool whatever its grant (SEC-11), and a draft that carries
// a credential leaves the runtime redacted like any other body (SEC-06).
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { WorkflowDetail } from '../../src/shared/api/index.js';
import { checkPath } from '../../src/runtime/security/broker.js';
import { Permissions } from '../../src/shared/permissions.js';
import { startRuntime, tempWorkspace, type Started } from '../helpers/workspace.js';

const policyFor = (dir: string, permissions: unknown) => ({ workspaceDir: dir, permissions: Permissions.parse(permissions), scratchDir: path.join(dir, 'runs', 'test-run') });

let ws: string;
let rt: Started;
const SECRET = `plantedsecret-${randomBytes(12).toString('hex')}`;

beforeAll(async () => {
  ws = tempWorkspace('sec-wf');
  fs.writeFileSync(path.join(ws, 'config', 'credentials.json'), JSON.stringify({ google: { apiKey: SECRET } }), { mode: 0o600 });
  rt = await startRuntime(ws, { ephemeral: false, port: 0 });
});
afterAll(async () => { await rt.stop(); });

const api = (method: string, p: string, init: { headers?: Record<string, string>; body?: unknown } = {}): Promise<Response> =>
  fetch(`${rt.baseUrl}/api/v1${p}`, { method, headers: { 'Content-Type': 'application/json', ...init.headers }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
const withToken = (extra: Record<string, string> = {}): Record<string, string> => ({ Authorization: `Bearer ${rt.token}`, ...extra });

describe('SEC-01/02: the write routes sit behind the floor', () => {
  it('refuses every write without the token, and with a foreign origin even with it', async () => {
    const writes: [string, string, unknown][] = [
      ['POST', '/workflows', { id: 'x', name: 'X' }],
      ['PUT', '/workflows/story-pipeline', { definition: {}, baseVersion: 'sha256:0' }],
      ['DELETE', '/workflows/story-pipeline', undefined],
    ];
    for (const [method, p, body] of writes) {
      expect((await api(method, p, { body })).status, `${method} ${p} without a token`).toBe(401);
      expect((await api(method, p, { body, headers: withToken({ Origin: 'http://evil.example' }) })).status, `${method} ${p} from a foreign origin`).toBe(403);
    }
    expect(fs.existsSync(path.join(ws, 'workflows', 'story-pipeline.workflow.json'))).toBe(true);
    expect(fs.existsSync(path.join(ws, 'workflows', 'x.workflow.json'))).toBe(false);
  });
});

describe('SEC-11: no tool writes a workflow file, whatever the grant', () => {
  it('denies a write under workflows/ through a grant covering the whole workspace', () => {
    const decision = checkPath(path.join(ws, 'workflows', 'story-pipeline.workflow.json'), ['.'], policyFor(ws, { fs: { read: ['.'], write: ['.'] } }), 'write');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('workflows');
  });
});

describe('SEC-06: a draft is redacted like any other body', () => {
  it('a credential typed into a step input never comes back out of the runtime', async () => {
    const loaded = (await (await api('GET', '/workflows/story-pipeline', { headers: withToken() })).json()) as WorkflowDetail;
    const definition = structuredClone(loaded.definition) as { steps: Record<string, unknown>[] };
    definition.steps[0]!['input'] = `{{inputs.premise}} (use key ${SECRET})`;
    const saved = await api('PUT', '/workflows/story-pipeline', { headers: withToken(), body: { definition, baseVersion: loaded.version } });
    expect(saved.status).toBe(200);
    expect(await saved.text()).not.toContain(SECRET);
    expect(await (await api('GET', '/workflows/story-pipeline', { headers: withToken() })).text()).not.toContain(SECRET);
    // The file is the owner's, written as typed: the redactor guards what leaves the runtime, not the disk.
    expect(fs.readFileSync(path.join(ws, 'workflows', 'story-pipeline.workflow.json'), 'utf8')).toContain(SECRET);
  });
});
