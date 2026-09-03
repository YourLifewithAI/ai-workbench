// HTTP contract (spec/api-and-cli.md). The UI and the CLI share these schemas.
import { z } from 'zod';
import { RunKind, RunState, Spent, EventRecord } from '../events.js';

export const ApiErrorCode = z.enum(['unauthorized', 'forbidden', 'not_found', 'validation', 'conflict', 'budget', 'unavailable', 'internal']);
export const ApiError = z.object({ error: z.object({ code: ApiErrorCode, message: z.string(), details: z.unknown().optional() }) });
export type ApiError = z.infer<typeof ApiError>;

export const CreateRunRequest = z.object({
  kind: RunKind,
  id: z.string(),
  inputs: z.record(z.string(), z.unknown()),
  project: z.string().optional(),
  overrides: z.record(z.string(), z.unknown()).optional(),
  provider: z.literal('mock').optional(),
});
export type CreateRunRequest = z.infer<typeof CreateRunRequest>;
export const CreateRunResponse = z.object({ runId: z.string() });

export const RunSummary = z.object({
  id: z.string(), kind: RunKind, state: RunState,
  agentId: z.string().optional(), workflowId: z.string().optional(), project: z.string().optional(),
  startedAt: z.string(), finishedAt: z.string().optional(), spent: Spent,
});
export type RunSummary = z.infer<typeof RunSummary>;

export const StepSummary = z.object({ stepId: z.string(), kind: z.string(), state: z.string(), modelId: z.string().nullable(), costUsd: z.number(), startedAt: z.string().nullable(), finishedAt: z.string().nullable() });
export type StepSummary = z.infer<typeof StepSummary>;

export const RunDetail = RunSummary.extend({
  inputs: z.record(z.string(), z.unknown()),
  outputs: z.record(z.string(), z.unknown()).optional(),
  error: z.unknown().optional(),
  steps: z.array(StepSummary),
});
export type RunDetail = z.infer<typeof RunDetail>;

export const RunListResponse = z.object({ runs: z.array(RunSummary) });

export const SettingsResponse = z.object({
  workspacePath: z.string(),
  workspaceName: z.string(),
  networkMode: z.string(),
  budgets: z.record(z.string(), z.number()),
  execution: z.record(z.string(), z.unknown()),
  retention: z.record(z.string(), z.number()),
  providersConfigured: z.array(z.string()),
  sandbox: z.object({ deno: z.boolean() }),
});
export type SettingsResponse = z.infer<typeof SettingsResponse>;

export const AgentModelPolicy = z.object({ primary: z.string(), fallbacks: z.array(z.string()), requires: z.record(z.string(), z.unknown()).optional() });

export const AgentSummary = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.string(),
  modelPolicy: AgentModelPolicy,
  tools: z.array(z.string()),
  outputKind: z.string(),
  review: z.string(),
});
export type AgentSummary = z.infer<typeof AgentSummary>;

/** A definition that failed to load is data, not a crash: the Agents screen shows it with the file and the reason. */
export const AgentLoadError = z.object({ id: z.string(), file: z.string(), message: z.string() });
export type AgentLoadError = z.infer<typeof AgentLoadError>;

export const AgentListResponse = z.object({ agents: z.array(AgentSummary), errors: z.array(AgentLoadError) });
export type AgentListResponse = z.infer<typeof AgentListResponse>;

export const AgentDetail = AgentSummary.extend({
  sections: z.array(z.object({ name: z.string(), text: z.string() })),
  instructionsSource: z.enum(['inline', 'file']),
  documents: z.array(z.string()),
});
export type AgentDetail = z.infer<typeof AgentDetail>;

export const ReloadAgentsResponse = z.object({ loaded: z.number().int(), errors: z.array(AgentLoadError) });
export type ReloadAgentsResponse = z.infer<typeof ReloadAgentsResponse>;

export const HealthResponse = z.object({ version: z.string(), bind: z.string(), port: z.number().int(), startedAt: z.string() });
export type HealthResponse = z.infer<typeof HealthResponse>;

export const RunResult = z.object({ runId: z.string(), state: RunState, outputs: z.record(z.string(), z.unknown()).optional(), costUsd: z.number() });
export type RunResult = z.infer<typeof RunResult>;

export { EventRecord };
