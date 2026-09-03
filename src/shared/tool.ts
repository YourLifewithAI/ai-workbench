// Tools (D-25). A definition is data plus one `execute`; everything a tool is allowed to touch arrives through
// its context, so a tool never imports `node:fs` and never calls `fetch` — the broker is the only door.
import { z } from 'zod';
import type { Permissions } from './permissions.js';
import type { JsonSchema, ToolSpec } from './model.js';

export const ToolTier = z.enum(['read', 'write', 'execute']);
export type ToolTier = z.infer<typeof ToolTier>;

/** The failure codes a model can read and act on. Anything else is a bug, not a result. */
export const ToolErrorCode = z.enum([
  'UnknownTool', 'PermissionDenied', 'ApprovalDenied', 'ApprovalTimeout', 'InvalidInput',
  'NotFound', 'Timeout', 'ToolUnavailable', 'DelegationDepthExceeded', 'BudgetExceeded', 'ToolError',
]);
export type ToolErrorCode = z.infer<typeof ToolErrorCode>;

export interface ToolError {
  code: ToolErrorCode;
  message: string;
  /** What the human or the agent could do about it — the policy that fired, the grant that is missing. */
  hint?: string | undefined;
}

export type ToolResult<O = unknown> =
  | { ok: true; output: O; meta?: Record<string, unknown> | undefined }
  | { ok: false; error: ToolError };

export interface FsEntry { path: string; kind: 'file' | 'directory'; bytes: number }

/** Everything a tool may touch. Each handle checks policy on every call (tools-and-security.md §Permissions). */
export interface ToolContext {
  runId: string;
  stepId: string;
  agentId: string;
  /** `<workspace>/runs/<runId>` — the tool's own scratch, always readable and writable by that tool. */
  scratchDir: string;
  /** The project this run files things in, when it has one. */
  project: string | null;
  fs: {
    read(path: string): Promise<string>;
    list(path: string): Promise<FsEntry[]>;
    write(path: string, data: string): Promise<void>;
    /**
     * The policy decision on its own, with no I/O. A tool whose storage is not the filesystem — the Library
     * keeps documents in the database — still has to ask, and asking by attempting a write would be worse
     * than asking directly.
     */
    can(path: string, mode: 'read' | 'write'): { allowed: boolean; reason: string; hint?: string | undefined };
  };
  net: { fetch(url: string, init?: RequestInit): Promise<Response> };
  credentials: { get(name: string): string | undefined };
  log(message: string): void;
  /** Aborts when the run is cancelled or the tool call times out. */
  signal: AbortSignal;
}

export interface ToolDefinition<I = unknown, O = unknown> {
  id: string;
  version: string;
  description: string;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  tier: ToolTier;
  /** The most this tool can ever be granted; the effective permission is an intersection, never a union (D-26). */
  maxPermissions: Permissions;
  /** Credential names it may receive. Anything not named here is invisible to it. */
  credentials?: string[] | undefined;
  /** Approval is required whatever the grant says. `shell` and non-GET HTTP are the cases this exists for. */
  approvalByDefault?: boolean | undefined;
  /** This tool leaves the machine. The network policy applies on top of the grant, and the Tools screen says so. */
  usesNetwork?: boolean | undefined;
  /**
   * The schema the model is shown, when the tool's own is not derived from `input`. An MCP server publishes JSON
   * Schema and the workbench does not get to rewrite it: what the server said is what the model sees (D-31).
   */
  inputSchemaOverride?: JsonSchema | undefined;
  /** Where the tool came from, for the Tools screen. Absent means a built-in. */
  origin?: { kind: 'mcp'; server: string } | undefined;
  execute(input: I, ctx: ToolContext): Promise<ToolResult<O>>;
}

/**
 * What the model sees. Derived at the provider boundary and serialised deterministically, so the same tool set
 * produces the same bytes on every call and a prompt cache is not invalidated by key order (D-46).
 */
export function toolSpec(tool: ToolDefinition): ToolSpec {
  const schema = tool.inputSchemaOverride ?? (z.toJSONSchema(tool.input, { io: 'input' }) as JsonSchema);
  return { name: tool.id, description: tool.description, inputSchema: sortKeys(schema) as JsonSchema };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

/** A tool failed, in the shape the model reads back. `ok: false` is a result, never a thrown error. */
export function toolError(code: ToolErrorCode, message: string, hint?: string): ToolResult<never> {
  return { ok: false, error: { code, message, ...(hint ? { hint } : {}) } };
}
