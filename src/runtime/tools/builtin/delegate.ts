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
    /** The project the child works in (RUN-23). Absent: the parent's. Its ceiling and memory list apply (D-69). */
    project?: string | undefined;
    model?: string | undefined; maxModelCalls?: number | undefined; maxCostUsd?: number | undefined;
    /** `false` lets the child go (D-76): the carve is charged now, nothing is waited for, nothing flows up. */
    wait?: boolean | undefined;
    signal: AbortSignal;
  }): Promise<
    | { ok: true; runId: string; detached: boolean; output: string; costUsd: number; taint: { private: boolean; external: boolean } }
    | { ok: false; code: 'DelegationDepthExceeded' | 'NotFound' | 'BudgetExceeded' | 'ToolError'; message: string }
  >;
}

export function delegateTool(host: DelegateHost): ToolDefinition {
  const tool: ToolDefinition<
    { agent: string; input: string; project?: string | undefined; model?: string | undefined; maxModelCalls?: number | undefined; maxCostUsd?: number | undefined; wait?: boolean | undefined },
    { runId: string; detached: boolean; output?: string | undefined; costUsd?: number | undefined }
  > = {
    id: 'agent.delegate',
    version: '1.0.0',
    description: 'Hand a self-contained brief to another agent and wait for its answer. The child sees only the brief you write — not this conversation — so write it as if for someone who was not here. Name the project the work belongs in; the child files there and works under that project\'s rules. With wait: false the child is let go: you get its run id at once, its budget is charged to you now, and you read what it did later from runs.facts and the ledger.',
    input: z.object({
      agent: z.string().describe('The id of an agent in this workspace.'),
      input: z.string().min(1).max(20_000).describe('A complete brief. Everything the other agent needs, in your own words.'),
      project: z.string().optional().describe('The project the child works in. Absent: the same project as this run.'),
      model: z.string().optional().describe('A catalog model id, or a role such as role:fast, instead of that agent\'s primary.'),
      maxModelCalls: z.number().int().positive().max(50).optional().describe('A budget carved out of what this run has left.'),
      maxCostUsd: z.number().positive().optional().describe('Dollars carved out of what this run has left. Give one when you let a child go, so the rest of your budget stays yours.'),
      wait: z.boolean().optional().describe('Default true. false: start it and come back to it next time.'),
    }),
    output: z.object({ runId: z.string(), detached: z.boolean(), output: z.string().optional(), costUsd: z.number().optional() }),
    tier: 'write',
    maxPermissions: NO_PERMISSIONS,
    execute: async (input, ctx) => {
      const result = await host.delegate({
        parentRunId: ctx.runId, parentStepId: ctx.stepId, agentId: input.agent, brief: input.input,
        ...(input.project ? { project: input.project } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.maxModelCalls ? { maxModelCalls: input.maxModelCalls } : {}),
        ...(input.maxCostUsd ? { maxCostUsd: input.maxCostUsd } : {}),
        ...(input.wait === false ? { wait: false } : {}),
        signal: ctx.signal,
      });
      if (!result.ok) {
        return toolError(result.code, result.message, result.code === 'DelegationDepthExceeded'
          ? `Delegation stops at ${MAX_DEPTH} levels. Do this part yourself, or ask for a shallower plan.`
          : undefined);
      }
      // Let go: nothing has come back, so there is nothing to read and nothing to taint.
      if (result.detached) return { ok: true, output: { runId: result.runId, detached: true } };
      // The child's taint rides on `meta`, where the executor reads it and marks this run (SEC-43). Not in
      // `output`: the model has no need of it, and a fact about trust is not something a model should be
      // able to argue with on the next turn.
      return { ok: true, output: { runId: result.runId, detached: false, output: result.output, costUsd: result.costUsd }, meta: { taint: result.taint } };
    },
  };
  return tool as ToolDefinition;
}

export interface WorkflowRunHost {
  /**
   * Starts a workflow as a child run (RUN-23, D-73): the same rules as a delegation — a budget carved from the
   * parent's remainder, depth ≤ 3, the parent's taint inherited at start and the child's reported at return —
   * with the workflow's own steps, agents and gates. What comes back is the workflow's named outputs.
   */
  run(input: {
    parentRunId: string; parentStepId: string; workflowId: string; inputs: Record<string, unknown>;
    project?: string | undefined; maxModelCalls?: number | undefined; maxCostUsd?: number | undefined; wait?: boolean | undefined; signal: AbortSignal;
  }): Promise<
    | { ok: true; runId: string; detached: boolean; outputs: Record<string, unknown>; costUsd: number; taint: { private: boolean; external: boolean } }
    | { ok: false; code: 'DelegationDepthExceeded' | 'NotFound' | 'InvalidInput' | 'BudgetExceeded' | 'ToolError'; message: string }
  >;
}

export function workflowRunTool(host: WorkflowRunHost): ToolDefinition {
  const tool: ToolDefinition<
    { workflow: string; inputs?: Record<string, unknown> | undefined; project?: string | undefined; maxModelCalls?: number | undefined; maxCostUsd?: number | undefined; wait?: boolean | undefined },
    { runId: string; detached: boolean; outputs?: Record<string, unknown> | undefined; costUsd?: number | undefined }
  > = {
    id: 'workflow.run',
    version: '1.0.0',
    description: 'Run a workflow from this workspace as a child of this run and wait for it. Its steps, agents and review gates are its own; its budget comes out of what this run has left. Returns the workflow\'s named outputs. With wait: false it is let go: you get its run id at once, its budget is charged to you now, and you read what it did later from runs.facts and the ledger.',
    input: z.object({
      workflow: z.string().describe('The id of a workflow in this workspace.'),
      inputs: z.record(z.string(), z.unknown()).optional().describe('The workflow\'s inputs, by name, as its form would ask for them.'),
      project: z.string().optional().describe('The project the run works in. Absent: the same project as this run, or the workflow\'s default.'),
      maxModelCalls: z.number().int().positive().max(200).optional().describe('A budget carved out of what this run has left.'),
      maxCostUsd: z.number().positive().optional().describe('Dollars carved out of what this run has left. Give one when you let it go.'),
      wait: z.boolean().optional().describe('Default true. false: start it and come back to it next time.'),
    }),
    output: z.object({ runId: z.string(), detached: z.boolean(), outputs: z.record(z.string(), z.unknown()).optional(), costUsd: z.number().optional() }),
    tier: 'write',
    maxPermissions: NO_PERMISSIONS,
    execute: async (input, ctx) => {
      const result = await host.run({
        parentRunId: ctx.runId, parentStepId: ctx.stepId, workflowId: input.workflow, inputs: input.inputs ?? {},
        ...(input.project ? { project: input.project } : {}),
        ...(input.maxModelCalls ? { maxModelCalls: input.maxModelCalls } : {}),
        ...(input.maxCostUsd ? { maxCostUsd: input.maxCostUsd } : {}),
        ...(input.wait === false ? { wait: false } : {}),
        signal: ctx.signal,
      });
      if (!result.ok) {
        return toolError(result.code, result.message, result.code === 'DelegationDepthExceeded'
          ? `Delegation stops at ${MAX_DEPTH} levels. Do this part yourself, or ask for a shallower plan.`
          : undefined);
      }
      if (result.detached) return { ok: true, output: { runId: result.runId, detached: true } };
      // The child's taint rides on `meta`, as a delegation's does (SEC-43).
      return { ok: true, output: { runId: result.runId, detached: false, outputs: result.outputs, costUsd: result.costUsd }, meta: { taint: result.taint } };
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
    // No `approvalByDefault`: this tool's whole execute *is* the approval request, and the card it raises says
    // what was asked and why. A generic gate in front of it would ask the human the same question twice, with
    // less information the first time.
    execute: async (input, ctx) => {
      const outcome = await host.ask({ runId: ctx.runId, stepId: ctx.stepId, what: input.what, why: input.why, signal: ctx.signal });
      return { ok: true, output: { granted: outcome.decision === 'allow', reason: outcome.reason } };
    },
  };
  return tool as ToolDefinition;
}
