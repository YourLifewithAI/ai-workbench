// SEC-01..05: the HTTP half of the security floor (spec/sec-catalog.md).
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { workspacePaths } from '../../src/runtime/paths.js';
import { startRuntime, tempWorkspace, type Started } from '../helpers/workspace.js';
import { expectRestricted } from '../helpers/secretFile.js';

let ws: string;
let rt: Started;

beforeAll(async () => {
  ws = tempWorkspace('sec');
  rt = await startRuntime(ws, { ephemeral: false, port: 0 });
});
afterAll(async () => { await rt.stop(); });

const api = (p: string, init: RequestInit = {}) => fetch(`${rt.baseUrl}/api/v1${p}`, init);
const withToken = (extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${rt.token}`, ...extra });

describe('SEC-01 request without token → 401 (health exempt)', () => {
  it('rejects every /api route but /health', async () => {
    for (const p of ['/runs', '/settings', '/runs/x', '/runs/x/events', '/runs/x/trace.jsonl']) {
      const res = await api(p);
      expect(res.status, p).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unauthorized');
    }
    expect((await api('/runs', { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await api('/health')).status).toBe(200);
    expect((await api('/runs', { headers: { Authorization: 'Bearer wrong-token' } })).status).toBe(401);
    expect((await api('/runs', { headers: withToken() })).status).toBe(200);
  });
});

describe('SEC-02 wrong Origin → 403', () => {
  it('refuses foreign and null origins even with a valid token, and checks Origin before the token', async () => {
    expect((await api('/runs', { headers: withToken({ Origin: 'http://evil.example' }) })).status).toBe(403);
    expect((await api('/runs', { headers: withToken({ Origin: 'null' }) })).status).toBe(403);
    expect((await api('/runs', { headers: withToken({ Origin: `http://127.0.0.1:${rt.port + 1}` }) })).status).toBe(403);
    expect((await api('/runs', { headers: { Origin: 'http://evil.example' } })).status).toBe(403);
    expect((await api('/runs', { headers: withToken({ Origin: `http://127.0.0.1:${rt.port}` }) })).status).toBe(200);
    expect((await api('/runs', { headers: withToken({ Origin: `http://localhost:${rt.port}` }) })).status).toBe(200);
  });
});

describe('SEC-03 wrong Host → 403', () => {
  const rawGet = (p: string, host: string): Promise<{ status: number; body: string }> => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: rt.port, path: p, method: 'GET', headers: { Host: host, ...withToken() } }, (res) => {
      let body = '';
      res.on('data', (d: Buffer) => { body += d.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
  it('refuses a rebinding Host on API and static routes, health included (fetch cannot forge Host, so raw HTTP is used)', async () => {
    for (const p of ['/api/v1/health', '/api/v1/runs', '/']) {
      const bad = await rawGet(p, `evil.example:${rt.port}`);
      expect(bad.status, p).toBe(403);
      expect(bad.body).toContain('forbidden');
      const noPort = await rawGet(p, '127.0.0.1');
      expect(noPort.status, `${p} without port`).toBe(403);
      expect((await rawGet(p, `localhost:${rt.port}`)).status, `${p} localhost`).not.toBe(403);
    }
  });
});

describe('SEC-04 listener bound to 127.0.0.1 only', () => {
  const refused = (host: string): Promise<boolean> => new Promise((resolve) => {
    const s = net.connect({ host, port: rt.port });
    s.once('connect', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(true));
  });
  it('refuses ::1 and every non-loopback interface', async () => {
    expect(await refused('::1')).toBe(true);
    for (const list of Object.values(os.networkInterfaces())) {
      for (const iface of list ?? []) if (iface.family === 'IPv4' && !iface.internal) expect(await refused(iface.address), iface.address).toBe(true);
    }
    expect(await refused('127.0.0.1')).toBe(false);
    expect(((await (await api('/health')).json()) as { bind: string }).bind).toBe('127.0.0.1');
  });
});

describe('SEC-05 token file 0600; token only ever in the one URL line', () => {
  it('writes runtime.token readable only by this account, and keeps the token out of runtime.json', () => {
    const paths = workspacePaths(ws);
    expectRestricted(paths.runtimeToken);
    expect(fs.readFileSync(paths.runtimeToken, 'utf8').trim()).toBe(rt.token);
    expect(fs.readFileSync(paths.runtimeJson, 'utf8')).not.toContain(rt.token);
  });
  it('never returns the token in a response body and never logs it', async () => {
    const create = await api('/runs', { method: 'POST', headers: withToken({ 'Content-Type': 'application/json' }), body: JSON.stringify({ kind: 'agent', id: 'echo', inputs: { input: 'hello' }, provider: 'mock' }) });
    const { runId } = (await create.json()) as { runId: string };
    await rt.runtime.engine.waitFor(runId);
    const bodies = await Promise.all([
      fetch(`${rt.baseUrl}/`).then((r) => r.text()),
      api('/health').then((r) => r.text()),
      api('/runs').then((r) => r.text()),
      api('/runs', { headers: withToken() }).then((r) => r.text()),
      api('/settings', { headers: withToken() }).then((r) => r.text()),
      api(`/runs/${runId}`, { headers: withToken() }).then((r) => r.text()),
      api(`/runs/${runId}/trace.jsonl`, { headers: withToken() }).then((r) => r.text()),
      api(`/runs/${runId}/events`, { headers: withToken() }).then((r) => r.text()),
      api('/runs/missing', { headers: withToken() }).then((r) => r.text()),
      api('/nope', { headers: withToken() }).then((r) => r.text()),
      api('/runs', { method: 'POST', headers: withToken({ 'Content-Type': 'application/json' }), body: 'not json' }).then((r) => r.text()),
    ]);
    for (const body of bodies) expect(body).not.toContain(rt.token);
    const log = fs.readFileSync(path.join(ws, 'data', 'logs', 'runtime.log'), 'utf8');
    expect(log.length).toBeGreaterThan(0);
    expect(log).not.toContain(rt.token);
  });
});
