// `agent.delegate` (D-12) and `permission.request`. Both are write-tier: one spends the run's budget on another
// agent, the other asks a human for authority. Neither can widen anything (SEC-13).
import { z } from 'zod';
import { Permissions } from '../../../shared/permissions.js';
import { toolError, type ToolDefinition } from '../../../shared/tool.js';

const NO_PERMISSIONS = Permissions.parse({});

/** Three levels of delegation is already a chain nobody can follow; four is refused (D-12). */
export const MAX_DEPTH = 3;

export interface DelegateHost {
  /**
   * Starts a child run: permissions = child's grant ∩ the parent's effective, a budget carved from the
   * parent's remainder, depth ≤ 3. The parent's transcript is never shared — `input` is a brief the planner
   * wrote, and that is all the child sees (D-48).
   */
  delegate(input: {
    parentRunId: string; parentStepId: string; agentId: string; brief: string;
    model?: string | undefined; maxModelCalls?: number | undefined; signal: AbortSignal;
  }): Promise<{ ok: true; runId: string; output: string; costUsd: number } | { ok: false; code: 'DelegationDepthExceeded' | 'NotFound' | 'BudgetExceeded' | 'ToolError'; message: string }>;
}

export function delegateTool(host: DelegateHost): ToolDefinition {
  const tool: ToolDefinition<
    { agent: string; input: string; model?: string | undefined; maxModelCalls?: number | undefined },
    { runId: string; output: string; costUsd: number }
  > = {
    id: 'agent.delegate',
    version: '1.0.0',
    description: 'Hand a self-contained brief to another agent and wait for its answer. The child sees only the brief you write — not this conversation — so write it as if for someone who was not here.',
    input: z.object({
      agent: z.string().describe('The id of an agent in this workspace.'),
      input: z.string().min(1).max(20_000).describe('A complete brief. Everything the other agent needs, in your own words.'),
      model: z.string().optional().describe('A catalog model id to use instead of that agent\'s primary.'),
      maxModelCalls: z.number().int().positive().max(50).optional().describe('A budget carved out of what this run has left.'),
    }),
    output: z.object({ runId: z.string(), output: z.string(), costUsd: z.number() }),
    tier: 'write',
    maxPermissions: NO_PERMISSIONS,
    execute: async (input, ctx) => {
      const result = await host.delegate({
        parentRunId: ctx.runId, parentStepId: ctx.stepId, agentId: input.agent, brief: input.input,
        ...(input.model ? { model: input.model } : {}),
        ...(input.maxModelCalls ? { maxModelCalls: input.maxModelCalls } : {}),
        signal: ctx.signal,
      });
      if (!result.ok) {
        return toolError(result.code, result.message, result.code === 'DelegationDepthExceeded'
          ? `Delegation stops at ${MAX_DEPTH} levels. Do this part yourself, or ask for a shallower plan.`
          : undefined);
      }
      return { ok: true, output: { runId: result.runId, output: result.output, costUsd: result.costUsd } };
    },
  };
  return tool as ToolDefinition;
}

export interface PermissionRequestHost {
  /** Parks the run and asks. The answer is a tool result the agent reads, not an exception. */
  ask(input: { runId: string; stepId: string; what: string; why: string; signal: AbortSignal }): Promise<{ decision: 'allow' | 'deny'; reason: string }>;
}

export function permissionRequestTool(host: PermissionRequestHost): ToolDefinition {
  const tool: ToolDefinition<{ what: string; why: string }, { granted: boolean; reason: string }> = {
    id: 'permission.request',
    version: '1.0.0',
    description: 'Ask the human for something you do not have permission to do. Say plainly what you want and why. They may say no, and you should have a plan for that.',
    input: z.object({
      what: z.string().min(1).max(500).describe('The action, concretely: "write projects/anthology/notes/margins.md".'),
      why: z.string().min(1).max(1000).describe('Why it helps the task in front of you.'),
    }),
    output: z.object({ granted: z.boolean(), reason: z.string() }),
    tier: 'write',
    maxPermissions: NO_PERMISSIONS,
    // Asking for authority is exactly the thing a human must see: this never runs without a decision.
    approvalByDefault: true,
    execute: async (input, ctx) => {
      const outcome = await host.ask({ runId: ctx.runId, stepId: ctx.stepId, what: input.what, why: input.why, signal: ctx.signal });
      return { ok: true, output: { granted: outcome.decision === 'allow', reason: outcome.reason } };
    },
  };
  return tool as ToolDefinition;
}
