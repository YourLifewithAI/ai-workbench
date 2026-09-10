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
}

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

  return [facts as ToolDefinition, read as ToolDefinition];
}
