// Running a tool call: decide, maybe park for a human, execute, record. The decision never depends on what the
// model said — the model chose the call, the broker and the grant matrix decide whether it happens (D-26).
import path from 'node:path';
import { ulid } from 'ulid';
import type { Db } from '../db/index.js';
import type { Logger } from '../log/index.js';
import type { EventStore } from '../engine/events.js';
import type { Redactor } from '../security/redaction.js';
import type { Credentials } from '../security/credentials.js';
import { Broker, PolicyError } from '../security/broker.js';
import { guardedFetch, NetDeniedError, type NetFetchDeps } from '../security/netfetch.js';
import type { RunTaint } from '../engine/taint.js';
import { PRIVATE_TOOLS } from '../engine/taint.js';
import { EMPTY_PERMISSIONS, effectivePermissions, grantFor, narrowestMode, type ToolDecision } from '../security/permissions.js';
import type { WorkbenchConfig } from '../../shared/workspace.js';
import type { Permissions } from '../../shared/permissions.js';
import { toolError, type ToolContext, type ToolDefinition, type ToolResult } from '../../shared/tool.js';
import type { GrantCell, RememberRule } from '../../shared/api/index.js';
import type { LoadedAgent } from '../../shared/agent.js';

export interface ToolCall { id: string; name: string; input: unknown }

/** Parks the run and waits for a human. Implemented by the engine, which owns the run's state row. */
export interface ApprovalHost {
  request(input: {
    runId: string; stepId: string; tool: string; args: unknown; policy: string;
    remember?: RememberRule | undefined; ordinal?: number | undefined; signal: AbortSignal;
  }): Promise<{ decision: 'allow' | 'deny'; reason: string }>;
}

export interface ExecutorDeps {
  db: Db;
  events: EventStore;
  log: Logger;
  redactor: Redactor;
  credentials: Credentials;
  config: () => WorkbenchConfig;
  workspaceDir: string;
  tools: Map<string, ToolDefinition>;
  approvals: ApprovalHost;
  /** Tool egress (RUN-07). Absent means `ctx.net.fetch` refuses, which is the safe direction to fail. */
  net?: {
    policy: NetFetchDeps['policy'];
    record: NetFetchDeps['record'];
    lookup?: NetFetchDeps['lookup'];
    connect?: NetFetchDeps['connect'];
    /** The runtime's own port, refused as a destination in every mode. */
    runtimePort?: (() => number | null) | undefined;
  } | undefined;
}

export interface ExecuteInput {
  runId: string;
  stepId: string;
  agent: LoadedAgent;
  project: string | null;
  scratchDir: string;
  workflowCeiling?: Permissions | undefined;
  signal: AbortSignal;
  timeoutMs: number;
  /** The exfiltration rule's memory of this run (D-29). */
  taint?: RunTaint | undefined;
}

/** What the transcript gets back for one call, after truncation. The trace always keeps the whole thing. */
export interface ExecutedCall {
  callId: string;
  tool: string;
  result: ToolResult;
  /** Set when the result was too long for the transcript; the full text is in scratch under this name. */
  fullResultPath?: string | undefined;
}

export class ToolExecutor {
  constructor(private readonly deps: ExecutorDeps) {}

  /** Every tool that exists, granted or not — the Tools screen shows the whole catalogue. */
  catalog(): ToolDefinition[] {
    return [...this.deps.tools.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** One cell of the grant matrix: what was asked, what was given, and what the broker would decide now. */
  grantCell(agent: LoadedAgent, tool: ToolDefinition): GrantCell {
    const granted = grantFor(this.deps.config(), agent.definition.id)?.tools[tool.id];
    const decision = this.decisionFor(agent, tool);
    return {
      agentId: agent.definition.id,
      toolId: tool.id,
      requested: agent.definition.permissions.tools[tool.id] === 'allow',
      granted: granted ?? 'unset',
      effective: decision.allowed,
      reason: decision.reason,
    };
  }

  /** Which tools this agent may actually see. A tool the model cannot call should not be in its prompt. */
  availableTo(agent: LoadedAgent, workflowCeiling?: Permissions): ToolDefinition[] {
    return [...this.deps.tools.values()].filter((tool) => this.decisionFor(agent, tool, workflowCeiling).allowed);
  }

  private decisionFor(agent: LoadedAgent, tool: ToolDefinition, workflowCeiling?: Permissions): ToolDecision {
    const config = this.deps.config();
    return effectivePermissions({
      requested: agent.definition.permissions,
      granted: grantFor(config, agent.definition.id),
      toolMax: tool.maxPermissions,
      ...(workflowCeiling ? { workflowCeiling } : {}),
    }).decide(tool.id, tool.approvalByDefault ?? false);
  }

  /**
   * Parallel tool calls in one response run concurrently: a model that asks for three lookups should wait for
   * the slowest, not the sum (workflows-and-execution.md §The agent step loop).
   */
  async run(calls: ToolCall[], input: ExecuteInput): Promise<ExecutedCall[]> {
    return Promise.all(calls.map((call, index) => this.one(call, input, index)));
  }

  private async one(call: ToolCall, input: ExecuteInput, ordinal = 0): Promise<ExecutedCall> {
    const started = Date.now();
    this.deps.events.append(input.runId, input.stepId, 'tool-requested', { callId: call.id, tool: call.name, input: call.input });

    const tool = this.deps.tools.get(call.name);
    if (!tool) {
      const result = toolError('UnknownTool', `There is no tool called "${call.name}".`, `Tools available to this agent: ${this.availableTo(input.agent, input.workflowCeiling).map((t) => t.id).join(', ') || 'none'}.`);
      return this.finish(call, input, result, started, 'unknown');
    }

    const decision = this.decisionFor(input.agent, tool, input.workflowCeiling);
    this.deps.events.append(input.runId, input.stepId, 'permission-decided', {
      callId: call.id, tool: call.name, allowed: decision.allowed, approval: decision.approval, reason: decision.reason,
    });
    if (!decision.allowed) {
      // A denial is a result the model reads and carries on from, never a crash (tools-and-security.md §Tools).
      return this.finish(call, input, toolError('PermissionDenied', decision.reason, decision.hint), started, 'denied', decision.reason);
    }

    const parsed = tool.input.safeParse(call.input);
    if (!parsed.success) {
      const problems = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      return this.finish(call, input, toolError('InvalidInput', `"${call.name}" was called with arguments it cannot use: ${problems}`), started, 'allowed');
    }

    if (decision.approval) {
      const outcome = await this.deps.approvals.request({
        runId: input.runId, stepId: input.stepId, tool: tool.id, args: parsed.data,
        policy: decision.reason, remember: rememberFor(tool.id, parsed.data), ordinal, signal: input.signal,
      });
      if (outcome.decision === 'deny') {
        const code = outcome.reason === 'timeout' ? 'ApprovalTimeout' : 'ApprovalDenied';
        return this.finish(call, input, toolError(code, outcome.reason === 'timeout'
          ? `Nobody answered the approval for "${tool.id}" in time, so it was refused.`
          : `A human refused the approval for "${tool.id}".`, 'Say what you will do instead, or ask again with a narrower request.'), started, 'denied', outcome.reason);
      }
    }

    const permissions = effectivePermissions({
      requested: input.agent.definition.permissions,
      granted: grantFor(this.deps.config(), input.agent.definition.id),
      toolMax: tool.maxPermissions,
      ...(input.workflowCeiling ? { workflowCeiling: input.workflowCeiling } : {}),
    }).permissions;

    const context = this.contextFor(tool, input, permissions);
    let result: ToolResult;
    try {
      result = await withTimeout(tool.execute(parsed.data, context), input.timeoutMs, tool.id, input.signal);
      if (result.ok) {
        const validated = tool.output.safeParse(result.output);
        // A tool that returns the wrong shape is a bug in the tool, and the model should not have to guess.
        if (!validated.success) {
          this.deps.log.error({ tool: tool.id, issues: validated.error.issues }, 'a tool returned output its own schema rejects');
          result = toolError('ToolError', `"${tool.id}" returned something that does not match its own output schema. This is a bug in the tool, not in your call.`);
        } else {
          result = { ok: true, output: validated.data, ...(result.meta ? { meta: result.meta } : {}) };
        }
      }
    } catch (e) {
      result = e instanceof PolicyError
        ? toolError(e.code, e.message, e.hint)
        : toolError('ToolError', `"${tool.id}" failed: ${(e as Error).message}`);
    }
    return this.finish(call, input, result, started, 'allowed');
  }

  private contextFor(tool: ToolDefinition, input: ExecuteInput, permissions: Permissions): ToolContext {
    const broker = new Broker(
      { workspaceDir: this.deps.workspaceDir, permissions, scratchDir: input.scratchDir },
      (d) => { if (!d.allowed) this.deps.log.info({ tool: tool.id, ...d }, 'the broker refused a path'); },
    );
    const declared = new Set(tool.credentials ?? []);
    return {
      runId: input.runId,
      stepId: input.stepId,
      agentId: input.agent.definition.id,
      scratchDir: input.scratchDir,
      project: input.project,
      fs: {
        read: (p) => broker.read(p),
        list: (p) => broker.list(p),
        write: (p, data) => broker.write(p, data),
        can: (p, mode) => broker.can(p, mode),
      },
      net: { fetch: (url, init) => this.netFetch(tool, input, permissions, url, init) },
      credentials: { get: (name) => (declared.has(name) ? this.deps.credentials.get(name) : undefined) },
      log: (message) => this.deps.log.info({ tool: tool.id, runId: input.runId }, message),
      signal: input.signal,
    };
  }

  /**
   * A tool's only way out. The mode and the allowlist decide first, then DNS is resolved with every answer
   * checked, then the socket dials the pinned address — and the exfiltration rule can park the whole thing in
   * front of a human before any of that (D-28, D-29).
   */
  private async netFetch(tool: ToolDefinition, input: ExecuteInput, permissions: Permissions, url: string | URL | Request, init?: RequestInit): Promise<Response> {
    const net = this.deps.net;
    if (!net) throw new PolicyError('ToolUnavailable', 'This runtime has no network layer wired, so no tool can reach the internet.');

    const config = this.deps.config();
    const target = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    // The effective policy is the workspace's, narrowed by whatever the agent and the workflow allow (D-26).
    const base = net.policy();
    const effective = {
      mode: narrowestMode(base.mode, permissions.net.mode),
      allow: base.allow.filter((entry) => permissions.net.allow.length === 0 || permissions.net.allow.includes(entry)),
      allowLocalAddresses: base.allowLocalAddresses && permissions.net.allowLocalAddresses,
      runtimePort: net.runtimePort?.() ?? base.runtimePort,
    };

    try {
      const response = await guardedFetch(
        {
          policy: () => effective,
          record: net.record,
          ...(net.lookup ? { lookup: net.lookup } : {}),
          ...(net.connect ? { connect: net.connect } : {}),
          askApproval: async ({ url: parked, method: parkedMethod, reason }) => this.deps.approvals.request({
            runId: input.runId, stepId: input.stepId, tool: tool.id,
            args: { url: parked, method: parkedMethod }, policy: reason,
            remember: { tool: tool.id, host: new URL(parked).hostname },
            signal: input.signal,
          }),
        },
        {
          url: target,
          method,
          ...(init?.headers ? { headers: headersToRecord(init.headers) } : {}),
          ...(typeof init?.body === 'string' ? { body: init.body } : {}),
          maxBytes: config.tools.http.maxResponseBytes,
          timeoutMs: config.tools.http.timeoutMs,
          purpose: tool.id === 'web.search' ? 'search' : 'tool',
          categories: method === 'GET' ? ['url'] : ['url', 'task'],
          // A configured search provider is an endpoint the owner wrote into config, not a model-chosen one.
          declared: tool.id === 'web.search',
          runId: input.runId,
          stepId: input.stepId,
          ...(input.taint ? { taint: { privateTainted: input.taint.privateTainted, seenUrls: input.taint.seenUrls, approvalExempt: permissions.net.approvalExempt } } : {}),
          signal: input.signal,
        },
      );
      const headers = new Headers(response.headers);
      if (response.truncated) headers.set('x-workbench-truncated', '1');
      // `Response` needs a URL for `response.url`, which the tool reports as `finalUrl`.
      const out = new Response(response.status === 204 || response.status === 304 ? null : new Uint8Array(response.body), { status: response.status, headers });
      Object.defineProperty(out, 'url', { value: response.finalUrl });
      return out;
    } catch (e) {
      if (e instanceof NetDeniedError) throw new PolicyError('PermissionDenied', e.message, e.hint);
      throw e;
    }
  }

  /**
   * Records the call, then decides what the *transcript* gets: a result past `context.maxToolResultChars` is
   * written to scratch whole and replaced with a pointer, so the model can go back for it and the trace keeps
   * everything either way (D-47).
   */
  private async finish(call: ToolCall, input: ExecuteInput, result: ToolResult, started: number, decision: string, reason?: string): Promise<ExecutedCall> {
    const latencyMs = Date.now() - started;
    this.deps.db.prepare(`INSERT INTO tool_calls (id, run_id, step_id, agent_id, tool, args_json, decision, reason, ok, error_code, latency_ms, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(ulid(), input.runId, input.stepId, input.agent.definition.id, call.name, this.deps.redactor.redactJson(call.input),
        decision, reason ?? null, result.ok ? 1 : 0, result.ok ? null : result.error.code, latencyMs, new Date().toISOString());

    // The trace keeps the whole result, always.
    this.deps.events.append(input.runId, input.stepId, 'tool-completed', {
      callId: call.id, tool: call.name, ok: result.ok, latencyMs,
      ...(result.ok ? { output: result.output } : { error: result.error }),
    });

    if (!result.ok) return { callId: call.id, tool: call.name, result };

    const limit = this.deps.config().context.maxToolResultChars;
    const text = JSON.stringify(result.output);
    // What a tool returned is content the run has now seen. Private content taints it; fetched web content
    // does not, but every URL in it becomes a URL the run may follow without asking (D-29).
    if (PRIVATE_TOOLS.has(call.name)) input.taint?.markPrivate(`${call.name} returned private content`);
    input.taint?.observe(text);
    if (text.length <= limit) return { callId: call.id, tool: call.name, result };

    // Through the broker like everything else: the scratch directory is writable because it is this run's own,
    // not because the executor is allowed to skip the door it makes tools use.
    const name = `${call.id}.json`;
    const scratch = new Broker({ workspaceDir: this.deps.workspaceDir, permissions: EMPTY_PERMISSIONS, scratchDir: input.scratchDir });
    await scratch.write(path.join(input.scratchDir, name), JSON.stringify(result.output, null, 2));
    return {
      callId: call.id,
      tool: call.name,
      fullResultPath: `scratch/${name}`,
      result: {
        ok: true,
        output: {
          truncated: true,
          preview: text.slice(0, limit),
          bytes: Buffer.byteLength(text),
          note: `This result was ${Buffer.byteLength(text)} bytes and has been cut short. The whole thing is in this run's scratch: artifact.read({ path: "scratch/${name}" }).`,
        },
        meta: { fullResult: `scratch/${name}`, originalBytes: Buffer.byteLength(text) },
      },
    };
  }
}

/** Exactly `{ tool, path }` or `{ tool, host }` — the narrowest rule, never the whole tool (SEC-12). */
function rememberFor(toolId: string, args: unknown): RememberRule | undefined {
  if (typeof args !== 'object' || args === null) return { tool: toolId };
  const record = args as Record<string, unknown>;
  if (typeof record['path'] === 'string') return { tool: toolId, path: path.dirname(record['path']) };
  if (typeof record['url'] === 'string') {
    try {
      return { tool: toolId, host: new URL(record['url']).hostname };
    } catch {
      return { tool: toolId };
    }
  }
  return { tool: toolId };
}

/** `Headers` is iterable at run time but not in this TS lib target, so the shapes are handled by hand. */
function headersToRecord(headers: HeadersInit): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[key.toLowerCase()] = value;
  } else if (typeof (headers as Headers).forEach === 'function') {
    (headers as Headers).forEach((value, key) => { out[key.toLowerCase()] = value; });
  } else {
    for (const [key, value] of Object.entries(headers as Record<string, string>)) out[key.toLowerCase()] = value;
  }
  return out;
}

function withTimeout<T>(promise: Promise<T>, ms: number, toolId: string, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`"${toolId}" did not finish within ${Math.round(ms / 1000)}s.`)), ms);
    const onAbort = (): void => { clearTimeout(timer); reject(new Error(`"${toolId}" was cancelled.`)); };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); resolve(value); },
      (e: unknown) => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(e as Error); },
    );
  });
}
