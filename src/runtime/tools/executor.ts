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
import { EMPTY_PERMISSIONS, effectivePermissions, grantFor, type ToolDecision } from '../security/permissions.js';
import type { WorkbenchConfig } from '../../shared/workspace.js';
import type { Permissions } from '../../shared/permissions.js';
import { toolError, type ToolContext, type ToolDefinition, type ToolResult } from '../../shared/tool.js';
import type { RememberRule } from '../../shared/api/index.js';
import type { LoadedAgent } from '../../shared/agent.js';

export interface ToolCall { id: string; name: string; input: unknown }

/** Parks the run and waits for a human. Implemented by the engine, which owns the run's state row. */
export interface ApprovalHost {
  request(input: {
    runId: string; stepId: string; tool: string; args: unknown; policy: string;
    remember?: RememberRule | undefined; signal: AbortSignal;
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
    return Promise.all(calls.map((call) => this.one(call, input)));
  }

  private async one(call: ToolCall, input: ExecuteInput): Promise<ExecutedCall> {
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
        policy: decision.reason, remember: rememberFor(tool.id, parsed.data), signal: input.signal,
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
      // Tool egress arrives in RUN-07 with the exfiltration rule. Until then this refuses rather than pretends.
      net: {
        fetch: () => Promise.reject(new PolicyError('ToolUnavailable', 'Tools cannot reach the network yet; that arrives with the fetch and search tools.')),
      },
      credentials: { get: (name) => (declared.has(name) ? this.deps.credentials.get(name) : undefined) },
      log: (message) => this.deps.log.info({ tool: tool.id, runId: input.runId }, message),
      signal: input.signal,
    };
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
