// The egress checker (D-28). One checker serves adapters now and tools from RUN-07. Every decision is made
// before a socket is opened, and every attempt — allowed or denied — is logged for the Privacy Inspector.
//
// RUN-02 scope: the mode lattice, declared endpoints, blocked address classes for literal hosts, and the log.
// DNS resolution with address pinning, redirect re-checking, and the exfiltration rule arrive with RUN-07's
// tool egress (SEC-17, SEC-18, SEC-19); until then a hostname that resolves to a private address is only
// caught when the host is written as a literal.
import net from 'node:net';
import type { NetworkMode } from '../../shared/permissions.js';
import type { FetchLike } from '../models/adapter.js';

export type EgressPurpose = 'model' | 'tool' | 'search' | 'mcp';
export type DataCategory = 'instructions' | 'task' | 'memory' | 'document' | 'tool-output' | 'url';

export interface EgressPolicy {
  mode: NetworkMode;
  allow: string[];
  allowLocalAddresses: boolean;
  /** The runtime's own port; loopback on it is refused in every mode, so an agent cannot call the workbench. */
  runtimePort: number | null;
}

export interface EgressAttempt {
  url: string;
  method: string;
  purpose: EgressPurpose;
  /** True for a `baseUrl` or other endpoint the owner wrote into config: subject to the mode, not to allowlists. */
  declared: boolean;
  categories: DataCategory[];
  bytes: number;
  bodyRedacted: string;
  runId?: string | undefined;
  stepId?: string | undefined;
}

export interface EgressDecision { allowed: boolean; reason: string; host: string; port: number | null }

export class EgressDeniedError extends Error {
  constructor(readonly decision: EgressDecision) {
    super(decision.reason);
    this.name = 'EgressDeniedError';
  }
}

const BLOCKED_NAMES = new Set(['localhost', 'metadata', 'metadata.google.internal', 'metadata.goog']);

/** Trailing dot stripped, lowercased, punycode; `[::1]` unwrapped. Anything unparseable stays as given. */
export function canonicalHost(hostname: string): string {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  while (host.endsWith('.')) host = host.slice(0, -1);
  try {
    return new URL(`http://${host.includes(':') && net.isIPv6(host) ? `[${host}]` : host}`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return host;
  }
}

/** Loopback, private, link-local, CGNAT, multicast, broadcast, and the names that resolve to a metadata service. */
export function isLocalAddress(host: string): boolean {
  if (BLOCKED_NAMES.has(host)) return true;
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (net.isIPv4(host)) {
    const [a, b] = host.split('.').map(Number) as [number, number, number, number];
    if (a === 0 || a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true; // multicast and reserved, including 255.255.255.255
    return false;
  }
  if (net.isIPv6(host)) {
    const v6 = host.toLowerCase();
    if (v6 === '::' || v6 === '::1') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(v6)) return true;       // unique local fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(v6)) return true;        // link local fe80::/10
    const mapped = mappedIpv4(v6);                         // IPv4-mapped forms, dotted or hex
    if (mapped) return isLocalAddress(mapped);
    return false;
  }
  return false;
}

/**
 * `::ffff:127.0.0.1` and `::ffff:7f00:1` are the same address; URL parsing normalises the first into the second,
 * so both forms have to decode or a mapped loopback slips through.
 */
function mappedIpv4(v6: string): string | null {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (dotted?.[1] && net.isIPv4(dotted[1])) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
  if (!hex) return null;
  const high = parseInt(hex[1]!, 16);
  const low = parseInt(hex[2]!, 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

export function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || (net.isIPv4(host) && host.startsWith('127.'));
}

/**
 * `example.com` matches the host and its subdomains, label-bounded; `*.example.com` matches subdomains only;
 * an optional `:port` restricts the port. So `notexample.com` never matches `example.com`.
 */
export function matchesAllowEntry(entry: string, host: string, port: number | null): boolean {
  const [rawPattern, rawPort] = splitPort(entry.trim().toLowerCase());
  if (rawPort !== null && rawPort !== port) return false;
  const pattern = canonicalHost(rawPattern);
  if (pattern.startsWith('*.')) {
    const base = pattern.slice(2);
    return host.endsWith(`.${base}`);
  }
  return host === pattern || host.endsWith(`.${pattern}`);
}

function splitPort(entry: string): [string, number | null] {
  if (entry.startsWith('[')) {
    const close = entry.indexOf(']');
    const port = entry.slice(close + 1).startsWith(':') ? Number(entry.slice(close + 2)) : null;
    return [entry.slice(1, close), Number.isInteger(port) ? port : null];
  }
  const colon = entry.lastIndexOf(':');
  if (colon === -1 || net.isIPv6(entry)) return [entry, null];
  const port = Number(entry.slice(colon + 1));
  return Number.isInteger(port) ? [entry.slice(0, colon), port] : [entry, null];
}

function defaultPort(protocol: string): number {
  return protocol === 'https:' ? 443 : 80;
}

/** The whole decision, made before any socket is opened. */
export function checkEgress(attempt: EgressAttempt, policy: EgressPolicy): EgressDecision {
  let url: URL;
  try {
    url = new URL(attempt.url);
  } catch {
    return { allowed: false, reason: `"${attempt.url}" is not a URL the workbench can reach.`, host: '', port: null };
  }
  const host = canonicalHost(url.hostname);
  const port = url.port ? Number(url.port) : defaultPort(url.protocol);
  const deny = (reason: string): EgressDecision => ({ allowed: false, reason, host, port });

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return deny(`${url.protocol} is not a protocol the workbench opens; only http and https are.`);
  }
  // The runtime's own address is never reachable from a run, in any mode: an agent cannot drive the workbench.
  if (policy.runtimePort !== null && isLoopback(host) && port === policy.runtimePort) {
    return deny('That address is the workbench runtime itself, which no run may call.');
  }

  if (policy.mode === 'offline') {
    return deny(`Network mode is offline, so nothing outside this machine is reachable. Switch the mode in Settings, or use a local model.`);
  }

  const local = isLocalAddress(host);

  if (policy.mode === 'local-only') {
    if (!local) return deny(`Network mode is local-only, and ${host} is not on this machine. Use a local model, or widen the mode in Settings.`);
    if (!attempt.declared) return deny(`Network mode is local-only, which allows only endpoints configured in this workspace; ${host} was not one of them.`);
    return { allowed: true, reason: 'a declared local endpoint in local-only mode', host, port };
  }

  // allowlist and unrestricted: a private address is refused unless the owner declared it or allowed the class.
  if (local && !attempt.declared && !policy.allowLocalAddresses) {
    return deny(`${host} is a private or loopback address. Set network.allowLocalAddresses if you meant to reach it.`);
  }
  if (policy.mode === 'allowlist' && !attempt.declared) {
    const matched = policy.allow.some((entry) => matchesAllowEntry(entry, host, port));
    if (!matched) return deny(`${host} is not in the network allowlist. Add it to network.allow in config/workbench.json, or switch the mode.`);
    return { allowed: true, reason: 'matched the allowlist', host, port };
  }
  return { allowed: true, reason: attempt.declared ? 'a declared endpoint' : `allowed by ${policy.mode} mode`, host, port };
}

export interface EgressDeps {
  policy: () => EgressPolicy;
  /** Called for every attempt, allowed or denied; the caller writes the row and redacts. */
  record: (attempt: EgressAttempt, decision: EgressDecision) => void;
  real: FetchLike;
}

export interface EgressContext {
  purpose: EgressPurpose;
  declared: boolean;
  categories: DataCategory[];
  runId?: string | undefined;
  stepId?: string | undefined;
}

/** Wraps a real fetch: check, log, then connect — or refuse without connecting at all. */
export function createEgressFetch(deps: EgressDeps, context: EgressContext): FetchLike {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : '';
    const attempt: EgressAttempt = {
      url,
      method,
      purpose: context.purpose,
      declared: context.declared,
      categories: context.categories,
      bytes: Buffer.byteLength(body),
      bodyRedacted: body,
      runId: context.runId,
      stepId: context.stepId,
    };
    const decision = checkEgress(attempt, deps.policy());
    deps.record(attempt, decision);
    if (!decision.allowed) throw new EgressDeniedError(decision);
    return deps.real(input, init);
  };
}
