// Tool egress (D-28, D-29). Everything a tool sends goes through here: the mode and allowlist decide first,
// then DNS is resolved and one address pinned, then the socket dials *that address* with the hostname as SNI.
// Redirects are followed by hand so every hop is checked again — a 302 is a new destination, not a detail.
import { Agent, request as undiciRequest } from 'undici';
import { checkEgress, canonicalHost, type DataCategory, type EgressAttempt, type EgressDecision, type EgressPolicy } from './egress.js';
import { resolveAndPin, systemLookup, type LookupFn } from './dns.js';

/** Five hops is more than any honest page needs and fewer than a loop (tools-and-security.md §Egress). */
const MAX_REDIRECTS = 5;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

export interface NetFetchResponse {
  status: number;
  finalUrl: string;
  headers: Record<string, string>;
  body: Buffer;
  truncated: boolean;
  /** Every URL this request passed through, so the trace shows the whole chain rather than the last hop. */
  chain: string[];
}

export class NetDeniedError extends Error {
  constructor(readonly decision: EgressDecision, readonly hint?: string) {
    super(decision.reason);
    this.name = 'NetDeniedError';
  }
}

export interface NetFetchDeps {
  policy: () => EgressPolicy;
  record: (attempt: EgressAttempt, decision: EgressDecision) => void;
  /** Injectable so a test resolves `*.test` to TEST-NET-3 without a DNS server. */
  lookup?: LookupFn | undefined;
  /** Injectable so a test dials a local server while the checker still sees the pinned public address. */
  connect?: ((options: unknown, callback: unknown) => void) | undefined;
  /** Asked before a request the exfiltration rule wants a human to see (D-29). `null` means no rule is wired. */
  askApproval?: ((input: { url: string; method: string; reason: string }) => Promise<{ decision: 'allow' | 'deny'; reason: string }>) | null | undefined;
}

export interface NetFetchInput {
  url: string;
  method?: string | undefined;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
  maxBytes: number;
  timeoutMs: number;
  purpose: 'tool' | 'search';
  categories: DataCategory[];
  /** A destination the owner wrote into config: subject to the mode, not to agent allowlists. */
  declared?: boolean | undefined;
  runId?: string | undefined;
  stepId?: string | undefined;
  /** The exfiltration rule's inputs for this run (D-29). */
  taint?: { privateTainted: boolean; seenUrls: Set<string>; approvalExempt: string[] } | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * The exfiltration rule (D-29). Mode and allowlist have already said yes by the time this runs: what is left is
 * whether a *human* should see this particular request before it goes. A run that has read private content and
 * is now sending somewhere it was not pointed at is the shape of a leak, whoever wrote the prompt.
 */
export function exfiltrationReason(input: NetFetchInput, policy: EgressPolicy, url: URL): string | null {
  const taint = input.taint;
  if (!taint?.privateTainted) return null;
  const host = canonicalHost(url.hostname);
  const exempt = taint.approvalExempt.some((entry) => entry === host || host.endsWith(`.${entry}`));
  const method = (input.method ?? 'GET').toUpperCase();

  if (method !== 'GET') {
    if (exempt) return null;
    return `This run has read private content, and this is a ${method} to ${host}, which is not in net.approvalExempt. A request with a body is how private content leaves.`;
  }
  if (policy.mode === 'unrestricted') {
    const inAllow = policy.allow.some((entry) => entry === host || host.endsWith(`.${entry}`));
    if (inAllow || exempt) return null;
    // A URL the run was shown is one it may follow; a URL it invented is one a human should see first.
    if (!taint.seenUrls.has(url.toString())) {
      return `This run has read private content, the mode is unrestricted, and ${url.toString()} is not a URL it was shown. An invented destination is how a leak looks.`;
    }
  }
  return null;
}

export async function guardedFetch(deps: NetFetchDeps, input: NetFetchInput): Promise<NetFetchResponse> {
  const lookup = deps.lookup ?? systemLookup;
  const chain: string[] = [];
  let current = input.url;
  let method = (input.method ?? 'GET').toUpperCase();
  let body = input.body;
  let headers = { ...(input.headers ?? {}) };

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const policy = deps.policy();
    const attempt: EgressAttempt = {
      url: current,
      method,
      purpose: input.purpose,
      declared: input.declared ?? false,
      categories: input.categories,
      bytes: Buffer.byteLength(body ?? ''),
      bodyRedacted: body ?? '',
      runId: input.runId,
      stepId: input.stepId,
    };

    // 1. The mode and the allowlist, before any DNS query at all.
    const decision = checkEgress(attempt, policy);
    deps.record(attempt, decision);
    if (!decision.allowed) throw new NetDeniedError(decision, hintFor(policy, decision));

    const url = new URL(current);

    // 2. The exfiltration rule, on a destination the mode would otherwise allow.
    const reason = exfiltrationReason({ ...input, url: current, method }, policy, url);
    if (reason) {
      if (!deps.askApproval) {
        throw new NetDeniedError({ ...decision, allowed: false, reason }, 'No human is available to approve this, so it is refused.');
      }
      const outcome = await deps.askApproval({ url: current, method, reason });
      if (outcome.decision !== 'allow') {
        const denied = { ...decision, allowed: false, reason: `${reason} A human refused it.` };
        deps.record(attempt, denied);
        throw new NetDeniedError(denied);
      }
    }

    // 3. DNS, with every answer checked and one pinned.
    const pinned = await resolveAndPin(url.hostname, lookup, policy.allowLocalAddresses);
    if (!pinned.ok) {
      const denied: EgressDecision = { allowed: false, reason: pinned.reason, host: canonicalHost(url.hostname), port: decision.port };
      deps.record({ ...attempt, url: current }, denied);
      throw new NetDeniedError(denied, 'The name resolved to an address the policy refuses. This is checked on every answer, not just the first.');
    }

    // 4. Dial the pinned address, with the hostname as SNI and in the Host header.
    const response = await dial({ url, method, headers, body, pinned: pinned.address, family: pinned.family, timeoutMs: input.timeoutMs, maxBytes: input.maxBytes, connect: deps.connect, signal: input.signal });
    chain.push(current);

    if (!REDIRECT_CODES.has(response.status) || !response.headers['location']) {
      return { ...response, finalUrl: current, chain };
    }

    // 5. A redirect is a new destination. Re-check it from the top.
    const next = new URL(response.headers['location'], current);
    if (url.protocol === 'https:' && next.protocol === 'http:') {
      const denied: EgressDecision = { allowed: false, reason: `${current} redirected to ${next.toString()}, which downgrades https to http. That is refused.`, host: canonicalHost(next.hostname), port: null };
      deps.record({ ...attempt, url: next.toString() }, denied);
      throw new NetDeniedError(denied);
    }
    if (canonicalHost(next.hostname) !== canonicalHost(url.hostname)) {
      // Headers do not travel across hosts: an Authorization meant for one service is not for another.
      headers = {};
    }
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
    }
    current = next.toString();
  }

  throw new NetDeniedError({ allowed: false, reason: `That URL redirected more than ${MAX_REDIRECTS} times. Something is looping.`, host: canonicalHost(new URL(input.url).hostname), port: null });
}

interface DialInput {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  pinned: string;
  family: 4 | 6;
  timeoutMs: number;
  maxBytes: number;
  connect: NetFetchDeps['connect'];
  signal: AbortSignal | undefined;
}

async function dial(input: DialInput): Promise<{ status: number; headers: Record<string, string>; body: Buffer; truncated: boolean }> {
  // The agent's lookup is fixed to the address already checked, so nothing is resolved a second time between
  // the decision and the socket (SEC-17).
  const agent = new Agent({
    connect: {
      timeout: input.timeoutMs,
      // `servername` keeps SNI on the hostname while the socket dials the pinned address.
      servername: input.url.hostname,
      lookup: (_hostname: string, _options: unknown, callback: (err: Error | null, address: string, family: number) => void) => {
        callback(null, input.pinned, input.family);
      },
      ...(input.connect ? { connect: input.connect } : {}),
    },
    headersTimeout: input.timeoutMs,
    bodyTimeout: input.timeoutMs,
  });

  try {
    const response = await undiciRequest(input.url, {
      dispatcher: agent,
      method: input.method as 'GET',
      headers: { host: input.url.host, ...input.headers },
      ...(input.body !== undefined ? { body: input.body } : {}),
      // No redirect option is passed: undici does not follow them unless a RedirectHandler is added, and the
      // caller follows each hop by hand precisely so every one is re-checked.
      ...(input.signal ? { signal: input.signal } : {}),
    });

    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk as Buffer);
      if (total + buffer.length > input.maxBytes) {
        chunks.push(buffer.subarray(0, input.maxBytes - total));
        truncated = true;
        break;
      }
      chunks.push(buffer);
      total += buffer.length;
    }
    if (truncated) response.body.destroy();

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(response.headers)) {
      headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value ?? '');
    }
    return { status: response.statusCode, headers, body: Buffer.concat(chunks), truncated };
  } finally {
    await agent.close().catch(() => undefined);
  }
}

function hintFor(policy: EgressPolicy, decision: EgressDecision): string | undefined {
  if (decision.reason.includes('allowlist')) {
    return `The workspace is in ${policy.mode} mode and allows: ${policy.allow.join(', ') || '(nothing)'}. Add the host in Settings if it belongs there.`;
  }
  if (decision.reason.includes('offline')) return 'Nothing outside this machine is reachable in offline mode.';
  return undefined;
}
