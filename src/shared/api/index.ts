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

export const ModelStatus = z.object({
  id: z.string(),
  adapter: z.string(),
  locality: z.string(),
  enabled: z.boolean(),
  availability: z.enum(['ready', 'no-credential', 'blocked-by-mode', 'unreachable', 'disabled', 'no-adapter']),
  reason: z.string().nullable(),
  capabilities: z.record(z.string(), z.unknown()),
  pricing: z.array(z.record(z.string(), z.unknown())),
  dataPolicy: z.record(z.string(), z.unknown()),
  baseUrl: z.string().optional(),
});
export type ModelStatus = z.infer<typeof ModelStatus>;

export const ModelListResponse = z.object({ models: z.array(ModelStatus), networkMode: z.string(), pulled: z.record(z.string(), z.array(z.string())) });
export type ModelListResponse = z.infer<typeof ModelListResponse>;

/** One row of the Privacy Inspector: where a run's data went, what kind it was, and what came of the attempt. */
export const EgressRecord = z.object({
  id: z.string(),
  stepId: z.string().nullable(),
  purpose: z.string(),
  host: z.string(),
  method: z.string(),
  categories: z.array(z.string()),
  bytes: z.number().int(),
  bodyRedacted: z.string().nullable(),
  decision: z.enum(['allowed', 'denied']),
  reason: z.string().nullable(),
  ts: z.string(),
});
export type EgressRecord = z.infer<typeof EgressRecord>;

export const PrivacyResponse = z.object({
  runId: z.string(),
  networkMode: z.string(),
  egress: z.array(EgressRecord),
  /** The data policy of every model this run actually called, so "who has my text" is answerable. */
  destinations: z.array(z.object({ modelId: z.string(), host: z.string().nullable(), dataPolicy: z.record(z.string(), z.unknown()).nullable(), calls: z.number().int() })),
});
export type PrivacyResponse = z.infer<typeof PrivacyResponse>;

export const SetNetworkModeRequest = z.object({ mode: z.enum(['offline', 'local-only', 'allowlist', 'unrestricted']) });
export type SetNetworkModeRequest = z.infer<typeof SetNetworkModeRequest>;

export const Project = z.object({ id: z.string(), slug: z.string(), name: z.string(), description: z.string().nullable(), createdAt: z.string(), documents: z.number().int() });
export type Project = z.infer<typeof Project>;

export const CreateProjectRequest = z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and hyphens'), name: z.string().min(1), description: z.string().optional() });
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

export const DocumentVersionSummary = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  hash: z.string(),
  createdBy: z.enum(['run-step', 'human', 'import']),
  runId: z.string().nullable(),
  stepId: z.string().nullable(),
  agentVersion: z.string().nullable(),
  modelId: z.string().nullable(),
  createdAt: z.string(),
  bytes: z.number().int(),
});
export type DocumentVersionSummary = z.infer<typeof DocumentVersionSummary>;

export const DocumentSummary = z.object({
  id: z.string(),
  projectSlug: z.string(),
  path: z.string(),
  type: z.string(),
  latestVersionId: z.string().nullable(),
  versions: z.number().int(),
  updatedAt: z.string().nullable(),
});
export type DocumentSummary = z.infer<typeof DocumentSummary>;

export const DocumentDetail = DocumentSummary.extend({
  content: z.string(),
  version: DocumentVersionSummary.nullable(),
  history: z.array(DocumentVersionSummary),
});
export type DocumentDetail = z.infer<typeof DocumentDetail>;

export const PutDocumentRequest = z.object({ content: z.string() });
export type PutDocumentRequest = z.infer<typeof PutDocumentRequest>;

/** One unified-diff-ish hunk line, computed server-side so the UI and the CLI show the same thing. */
export const DiffLine = z.object({ kind: z.enum(['same', 'added', 'removed']), text: z.string(), leftNo: z.number().int().nullable(), rightNo: z.number().int().nullable() });
export const DiffResponse = z.object({ from: z.string(), to: z.string(), lines: z.array(DiffLine), added: z.number().int(), removed: z.number().int() });
export type DiffResponse = z.infer<typeof DiffResponse>;

export const HealthResponse = z.object({ version: z.string(), bind: z.string(), port: z.number().int(), startedAt: z.string() });
export type HealthResponse = z.infer<typeof HealthResponse>;

export const RunResult = z.object({ runId: z.string(), state: RunState, outputs: z.record(z.string(), z.unknown()).optional(), costUsd: z.number() });
export type RunResult = z.infer<typeof RunResult>;

export { EventRecord };
