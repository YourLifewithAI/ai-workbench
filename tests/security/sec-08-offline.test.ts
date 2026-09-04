// SEC-08: offline mode blocks cloud egress before a socket opens. The spy below is on net.Socket.connect
// itself, so "no connection attempted" means exactly that — not merely that no request completed.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { checkEgress, isLocalAddress, matchesAllowEntry, canonicalHost, type EgressAttempt, type EgressPolicy } from '../../src/runtime/security/egress.js';
import { startRuntime, tempWorkspace } from '../helpers/workspace.js';

const attempt = (url: string, declared = false): EgressAttempt => ({
  url, method: 'POST', purpose: 'model', declared, categories: ['instructions', 'task'], bytes: 10, bodyRedacted: '{}',
});
const policy = (over: Partial<EgressPolicy> = {}): EgressPolicy => ({ mode: 'allowlist', allow: [], allowLocalAddresses: false, runtimePort: null, ...over });

/** Counts real connection attempts, whatever library made them. */
function spyOnSockets(): { count: () => number; restore: () => void } {
  const original = net.Socket.prototype.connect;
  let count = 0;
  net.Socket.prototype.connect = function patched(this: net.Socket, ...args: Parameters<typeof original>) {
    count += 1;
    return original.apply(this, args);
  } as typeof original;
  return { count: () => count, restore: () => { net.Socket.prototype.connect = original; } };
}

let spy: ReturnType<typeof spyOnSockets> | null = null;
afterEach(() => { spy?.restore(); spy = null; });

describe('SEC-08 offline mode blocks cloud egress before a socket opens', () => {
  it('a cloud run in offline mode fails with NetworkPolicy and opens no socket', async () => {
    const ws = tempWorkspace('sec08');
    const config = path.join(ws, 'config', 'workbench.json');
    fs.writeFileSync(config, JSON.stringify({ schemaVersion: 1, network: { mode: 'offline' } }));
    const agent = path.join(ws, 'agents', 'echo', 'agent.json');
    const definition = JSON.parse(fs.readFileSync(agent, 'utf8')) as { modelPolicy: { primary: string; fallbacks?: string[] } };
    definition.modelPolicy = { primary: 'google/gemini-3.8-flash', fallbacks: ['anthropic/claude-opus-5'] };
    fs.writeFileSync(agent, JSON.stringify(definition));

    const rt = await startRuntime(ws);
    try {
      spy = spyOnSockets();
      const before = spy.count();
      const { runId, done } = rt.runtime.engine.startAgentRun({ agentId: 'echo', inputs: { input: 'hello' } });
      await done;
      const run = rt.runtime.engine.getRun(runId);
      expect(run?.state).toBe('failed');
      const error = run?.error as { reason: string; error: { code: string; message: string } };
      expect(error.reason).toBe('network_policy');
      expect(error.error.code).toBe('NetworkPolicy');
      expect(error.error.message).toMatch(/offline/i);
      expect(spy.count() - before, 'no socket was opened').toBe(0);
    } finally {
      await rt.stop();
    }
  }, 60_000);

  it('a local declared endpoint still runs in local-only mode', async () => {
    const ws = tempWorkspace('sec08-local');
    fs.writeFileSync(path.join(ws, 'config', 'workbench.json'), JSON.stringify({ schemaVersion: 1, network: { mode: 'local-only' } }));
    const agent = path.join(ws, 'agents', 'echo', 'agent.json');
    const definition = JSON.parse(fs.readFileSync(agent, 'utf8')) as { modelPolicy: { primary: string } };
    definition.modelPolicy = { primary: 'mock/upstream' };
    fs.writeFileSync(agent, JSON.stringify(definition));

    const rt = await startRuntime(ws, { ephemeral: false, port: 0 });
    try {
      const { runId, done } = rt.runtime.engine.startAgentRun({ agentId: 'echo', inputs: { input: 'local please' } });
      await done;
      const run = rt.runtime.engine.getRun(runId);
      expect(run?.state, JSON.stringify(run?.error)).toBe('completed');
      expect(rt.runtime.mockUpstream.received.length, 'the declared loopback endpoint was really called').toBe(1);
      const row = rt.runtime.db.prepare("SELECT decision, host FROM egress_log WHERE run_id = ?").get(runId) as { decision: string; host: string };
      expect(row.decision).toBe('allowed');
      expect(row.host).toBe('127.0.0.1');
    } finally {
      await rt.stop();
    }
  }, 60_000);
});

describe('SEC-08 the checker itself', () => {
  it('offline refuses everything; local-only refuses anything not declared and local', () => {
    expect(checkEgress(attempt('https://api.example.com/v1'), policy({ mode: 'offline' })).allowed).toBe(false);
    expect(checkEgress(attempt('http://127.0.0.1:11434/v1', true), policy({ mode: 'offline' })).allowed).toBe(false);
    expect(checkEgress(attempt('http://127.0.0.1:11434/v1', true), policy({ mode: 'local-only' })).allowed).toBe(true);
    expect(checkEgress(attempt('http://127.0.0.1:11434/v1', false), policy({ mode: 'local-only' })).allowed).toBe(false);
    expect(checkEgress(attempt('https://api.example.com/v1', true), policy({ mode: 'local-only' })).allowed).toBe(false);
  });

  it('the allowlist is label-bounded and honours a port', () => {
    expect(matchesAllowEntry('example.com', 'example.com', 443)).toBe(true);
    expect(matchesAllowEntry('example.com', 'api.example.com', 443)).toBe(true);
    expect(matchesAllowEntry('example.com', 'notexample.com', 443)).toBe(false);
    expect(matchesAllowEntry('example.com', 'example.com.evil.test', 443)).toBe(false);
    expect(matchesAllowEntry('*.example.com', 'example.com', 443)).toBe(false);
    expect(matchesAllowEntry('*.example.com', 'api.example.com', 443)).toBe(true);
    expect(matchesAllowEntry('example.com:8443', 'example.com', 443)).toBe(false);
    expect(matchesAllowEntry('example.com:8443', 'example.com', 8443)).toBe(true);
    expect(canonicalHost('API.Example.COM.')).toBe('api.example.com');
  });

  it('private and metadata addresses are refused even in unrestricted mode', () => {
    for (const host of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'localhost', 'metadata.google.internal', '[::ffff:127.0.0.1]']) {
      const url = host.startsWith('[') ? `http://${host}/x` : net.isIPv6(host) ? `http://[${host}]/x` : `http://${host}/x`;
      expect(checkEgress(attempt(url), policy({ mode: 'unrestricted' })).allowed, host).toBe(false);
    }
    expect(isLocalAddress('8.8.8.8')).toBe(false);
    expect(checkEgress(attempt('https://example.com/x'), policy({ mode: 'unrestricted' })).allowed).toBe(true);
  });

  it('the runtime\'s own address is refused in every mode', () => {
    for (const mode of ['local-only', 'allowlist', 'unrestricted'] as const) {
      const decision = checkEgress(attempt('http://127.0.0.1:8787/api/v1/runs', true), policy({ mode, runtimePort: 8787, allowLocalAddresses: true }));
      expect(decision.allowed, mode).toBe(false);
      expect(decision.reason).toMatch(/runtime itself/);
    }
  });

  it('only http and https are opened', () => {
    expect(checkEgress(attempt('file:///etc/passwd', true), policy({ mode: 'unrestricted' })).allowed).toBe(false);
    expect(checkEgress(attempt('ftp://example.com/x'), policy({ mode: 'unrestricted' })).allowed).toBe(false);
  });
});
