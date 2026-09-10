// The orchestrator's tools (D-73, RUN-23). `runs.facts` and `agents.read` are read tools in the auditor's
// mould: metadata and instructions, never a task, an output, a document or a tool's arguments, so a session
// that decides from them stays untainted (SEC-42). Their `maxPermissions` admit nothing — no path, no host,
// no credential — and the grant matrix decides who holds them, which is meant to be exactly one agent.
import { z } from 'zod';
import { Permissions } from '../../../shared/permissions.js';
import { toolError, type ToolDefinition } from '../../../shared/tool.js';
import { MAX_RUN_FACTS, runFactsBrief, type AgentFacts, type RunFacts, type RunFactsBrief, type RunFactsFilter } from '../../orchestrator/facts.js';

const NOTHING = Permissions.parse({});

export interface OrchestratorToolDeps {
  runFacts: (filter: RunFactsFilter) => RunFacts;
  agent: (id: string) => AgentFacts | { error: string };
  /**
   * Writes one `scores` row under the `orchestrator` evaluator, `estimate: true` — never a `ratings` row, which
   * is the person's and future router data (D-50). Refuses a run or step that does not exist.
   */
  rate: (input: { runId: string; stepId?: string | undefined; value: number; why: string }) => { ok: true; id: string } | { ok: false; code: 'NotFound'; message: string };
}

export const ORCHESTRATOR_EVALUATOR = 'orchestrator';

export function orchestratorTools(deps: OrchestratorToolDeps): ToolDefinition[] {
  const facts: ToolDefinition<{ since?: string | undefined; agent?: string | undefined; project?: string | undefined; limit?: number | undefined }, RunFactsBrief> = {
    id: 'runs.facts',
    version: '1.0.0',
    description: 'What the fleet has been doing: the candidate runs the numbers point at (failing, unrated, costlier than usual, fell back, cut short), then one record per recent run — who ran, state, models, cost, tool calls by name, the owner\'s ratings, documents filed by path, and the three summary lines a person sees. Facts only: never a task, an output or a document. Read one of those with artifact.read when you must, knowing it marks this session as having read content.',
    input: z.object({
      since: z.string().datetime({ offset: true }).optional().describe('Only runs started at or after this ISO 8601 instant.'),
      agent: z.string().optional().describe('Only runs of this agent.'),
      project: z.string().optional().describe('Only runs in this project.'),
      limit: z.number().int().positive().max(MAX_RUN_FACTS).optional().describe('At most this many runs, newest first. Default 20, ceiling 100.'),
    }),
    output: z.custom<RunFactsBrief>((v) => typeof v === 'object' && v !== null),
    tier: 'read',
    maxPermissions: NOTHING,
    execute: async (input, ctx) => ({
      ok: true,
      output: runFactsBrief(deps.runFacts({
        ...(input.since ? { since: input.since } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.project ? { project: input.project } : {}),
        ...(input.limit ? { limit: input.limit } : {}),
        self: ctx.agentId,
      })),
    }),
  };

  const read: ToolDefinition<{ agent: string }, AgentFacts> = {
    id: 'agents.read',
    version: '1.0.0',
    description: 'One agent\'s definition and instruction sections: its model policy, the tools its file asks for, its memory scopes, output, documents, budgets and review setting. Not its grants — what it may actually do is decided on the Tools screen by a person, and no tool reads or writes that.',
    input: z.object({ agent: z.string().describe('The id of an agent in this workspace.') }),
    output: z.custom<AgentFacts>((v) => typeof v === 'object' && v !== null),
    tier: 'read',
    maxPermissions: NOTHING,
    execute: async (input) => {
      const result = deps.agent(input.agent);
      if ('error' in result) return toolError('NotFound', result.error);
      return { ok: true, output: result };
    },
  };

  const rate: ToolDefinition<{ run: string; step?: string | undefined; value: number; why: string }, { id: string; run: string; value: number; estimate: true }> = {
    id: 'runs.rate',
    version: '1.0.0',
    description: 'Rate a run, or one step of it, 1 to 5, with why. Your number is an estimate, shown beside the owner\'s rating and never in its place; the why is what they will read. Rate what they have not rated yet; do not rate your own runs.',
    input: z.object({
      run: z.string().describe('The run id.'),
      step: z.string().optional().describe('A step id, to rate one step rather than the whole run.'),
      value: z.number().int().min(1).max(5).describe('1 (poor) to 5 (excellent).'),
      why: z.string().min(1).max(1000).describe('One to three sentences: what was good or wrong, concretely. The owner reads this.'),
    }),
    output: z.object({ id: z.string(), run: z.string(), value: z.number(), estimate: z.literal(true) }),
    tier: 'write',
    maxPermissions: NOTHING,
    execute: async (input) => {
      const result = deps.rate({ runId: input.run, ...(input.step ? { stepId: input.step } : {}), value: input.value, why: input.why });
      if (!result.ok) return toolError(result.code, result.message);
      return { ok: true, output: { id: result.id, run: input.run, value: input.value, estimate: true } };
    },
  };

  return [facts as ToolDefinition, read as ToolDefinition, rate as ToolDefinition];
}
