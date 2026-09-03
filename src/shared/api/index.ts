// HTTP contract (spec/api-and-cli.md). The UI and the CLI share these schemas.
import { z } from 'zod';
import { RunKind, RunState, Spent, EventRecord } from '../events.js';
import { Budgets } from '../permissions.js';

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
  /** What this run may spend, after the workspace's budgets were narrowed for it — the bar's denominator. */
  budgets: Budgets,
});
export type RunSummary = z.infer<typeof RunSummary>;

export const StepSummary = z.object({
  stepId: z.string(), kind: z.string(), state: z.string(), modelId: z.string().nullable(), costUsd: z.number(),
  /** Set on a map item: the map step it belongs to and its position in the list. */
  parentStepId: z.string().nullable().default(null),
  mapIndex: z.number().int().nullable().default(null),
  startedAt: z.string().nullable(), finishedAt: z.string().nullable(),
});
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
  /** Written by a wrap-up turn rather than a finished step: the text is a summary, not the work (D-14). */
  partial: z.boolean().default(false),
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
  /** What the human thought of each version, by version id (RUN-05). Absent from the store; added by the API. */
  ratings: z.record(z.string(), z.array(z.lazy(() => RatingSummary))).default({}),
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

// ---- workflows (spec/api-and-cli.md) ------------------------------------------------------------

export const WorkflowSummary = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.string(),
  file: z.string(),
  defaultProject: z.string().nullable(),
  inputs: z.record(z.string(), z.unknown()),
  steps: z.array(z.object({
    id: z.string(), kind: z.string(), agent: z.string().nullable(), dependsOn: z.array(z.string()),
    /** A blocking gate: the run stops here until a human decides (D-13). */
    review: z.enum(['none', 'blocking']).default('none'),
  })),
  hasSchedule: z.boolean(),
});
export type WorkflowSummary = z.infer<typeof WorkflowSummary>;

export const WorkflowDetail = WorkflowSummary.extend({
  definition: z.record(z.string(), z.unknown()),
  /** Advisory only (D-49): the Workflows screen shows them, nothing blocks on them. */
  smells: z.array(z.object({ stepId: z.string(), message: z.string() })),
  order: z.array(z.string()),
});
export type WorkflowDetail = z.infer<typeof WorkflowDetail>;

export const WorkflowListResponse = z.object({
  workflows: z.array(WorkflowSummary),
  errors: z.array(z.object({ id: z.string(), file: z.string(), message: z.string() })),
});
export type WorkflowListResponse = z.infer<typeof WorkflowListResponse>;

// ---- review and ratings (spec/workflows-and-execution.md §Review, D-13) -------------------------

export const RatingSummary = z.object({
  id: z.string(), runId: z.string(), stepId: z.string(), versionId: z.string().nullable(),
  value: z.number().int().min(1).max(5), note: z.string().nullable(), ts: z.string(),
});
export type RatingSummary = z.infer<typeof RatingSummary>;

export const ReviewItem = z.object({
  id: z.string(),
  runId: z.string(),
  stepId: z.string(),
  state: z.enum(['unreviewed', 'pending', 'continued', 'rejected', 'dismissed']),
  /** True while a `review: 'blocking'` step is holding its run still. */
  blocking: z.boolean(),
  attempt: z.number().int().positive(),
  feedback: z.string().nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  runKind: z.string(),
  runState: z.string(),
  /** The workflow or agent this came from, for the queue's one-line heading. */
  subject: z.string(),
  project: z.string().nullable(),
  modelId: z.string().nullable(),
  output: z.string().nullable(),
  versionId: z.string().nullable(),
  documentId: z.string().nullable(),
  documentPath: z.string().nullable(),
  ratings: z.array(RatingSummary),
});
export type ReviewItem = z.infer<typeof ReviewItem>;

export const ReviewListResponse = z.object({ reviews: z.array(ReviewItem) });
export type ReviewListResponse = z.infer<typeof ReviewListResponse>;

export const ReviewDecisionRequest = z.object({
  decision: z.enum(['continue', 'reject', 'dismiss']),
  feedback: z.string().max(4000).optional(),
});
export type ReviewDecisionRequest = z.infer<typeof ReviewDecisionRequest>;

export const RateRequest = z.object({
  runId: z.string(),
  stepId: z.string(),
  versionId: z.string().optional(),
  value: z.number().int().min(1).max(5),
  note: z.string().max(2000).optional(),
});
export type RateRequest = z.infer<typeof RateRequest>;

// ---- schedules (spec/workflows-and-execution.md §Scheduler, D-15) -------------------------------

export const ScheduleSummary = z.object({
  id: z.string(),
  workflowId: z.string(),
  cron: z.string(),
  inputs: z.record(z.string(), z.unknown()),
  project: z.string().nullable(),
  enabled: z.boolean(),
  catchUp: z.enum(['none', 'once']),
  /** Seeded by a workflow file's `schedule` block; edits here are the owner's and the file no longer touches it. */
  seededFromFile: z.boolean(),
  lastFiredAt: z.string().nullable(),
  nextFireAt: z.string().nullable(),
});
export type ScheduleSummary = z.infer<typeof ScheduleSummary>;

export const ScheduleListResponse = z.object({ schedules: z.array(ScheduleSummary) });
export type ScheduleListResponse = z.infer<typeof ScheduleListResponse>;

export const UpsertScheduleRequest = z.object({
  workflowId: z.string(),
  cron: z.string().min(1),
  inputs: z.record(z.string(), z.unknown()).optional(),
  project: z.string().optional(),
  enabled: z.boolean().optional(),
  catchUp: z.enum(['none', 'once']).optional(),
});
export type UpsertScheduleRequest = z.infer<typeof UpsertScheduleRequest>;

// ---- approvals (spec/tools-and-security.md §Approvals, D-13, D-57) -----------------------------

/** Exactly `{ tool, path | host }` — the narrowest rule "remember" can write, and nothing wider. */
export const RememberRule = z.object({
  tool: z.string(),
  path: z.string().optional(),
  host: z.string().optional(),
});
export type RememberRule = z.infer<typeof RememberRule>;

export const ApprovalAction = z.object({
  id: z.string(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  /** The rule that fired, in the words the card shows. */
  policy: z.string(),
  state: z.enum(['pending', 'allowed', 'denied', 'expired']),
  remember: RememberRule.nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
});
export type ApprovalAction = z.infer<typeof ApprovalAction>;

export const ApprovalItem = z.object({
  /** Everything one step asked for, as one card (D-57). */
  batchId: z.string(),
  runId: z.string(),
  stepId: z.string(),
  subject: z.string(),
  project: z.string().nullable(),
  state: z.enum(['pending', 'allowed', 'denied', 'expired']),
  createdAt: z.string(),
  expiresAt: z.string(),
  actions: z.array(ApprovalAction),
});
export type ApprovalItem = z.infer<typeof ApprovalItem>;

export const ApprovalListResponse = z.object({ approvals: z.array(ApprovalItem) });
export type ApprovalListResponse = z.infer<typeof ApprovalListResponse>;

export const ApprovalDecisionRequest = z.object({
  decision: z.enum(['allow', 'allow-remember', 'deny']),
  /** Decide one action rather than the whole batch. Omit to decide every pending action in it. */
  actionId: z.string().optional(),
});
export type ApprovalDecisionRequest = z.infer<typeof ApprovalDecisionRequest>;

// ---- the Dashboard (spec/ui.md §Dashboard) ------------------------------------------------------

export const DashboardResponse = z.object({
  /** Blocking gates: a run is standing still until one of these is decided. */
  needsYou: z.array(ReviewItem),
  /** Approvals: a run is standing still until someone says whether an action may happen (D-13). */
  approvals: z.array(ApprovalItem),
  /** How many outputs are waiting for a rating. Nothing is blocked by them. */
  unreviewed: z.number().int().nonnegative(),
  failed: z.array(RunSummary),
  running: z.array(RunSummary),
  spentTodayUsd: z.number(),
  dailySpendCapUsd: z.number(),
  schedules: z.array(ScheduleSummary),
  networkMode: z.string(),
});
export type DashboardResponse = z.infer<typeof DashboardResponse>;

// ---- tools and grants (spec/ui.md §Tools) --------------------------------------------------------

export const ToolSummary = z.object({
  id: z.string(),
  version: z.string(),
  description: z.string(),
  tier: z.enum(['read', 'write', 'execute']),
  /** True when every call needs a human decision whatever the grant says. */
  approvalByDefault: z.boolean(),
  inputSchema: z.record(z.string(), z.unknown()),
});
export type ToolSummary = z.infer<typeof ToolSummary>;

/** One cell of the grant matrix: what the agent asked for, what a human actually gave it. */
export const GrantCell = z.object({
  agentId: z.string(),
  toolId: z.string(),
  requested: z.boolean(),
  granted: z.enum(['allow', 'deny', 'unset']),
  /** The decision as the broker would make it right now, with the reason it would give. */
  effective: z.boolean(),
  reason: z.string(),
});
export type GrantCell = z.infer<typeof GrantCell>;

export const ToolDenial = z.object({
  id: z.string(),
  runId: z.string(),
  stepId: z.string(),
  agentId: z.string().nullable(),
  tool: z.string(),
  decision: z.string(),
  reason: z.string().nullable(),
  errorCode: z.string().nullable(),
  ts: z.string(),
});
export type ToolDenial = z.infer<typeof ToolDenial>;

export const ToolsResponse = z.object({
  tools: z.array(ToolSummary),
  matrix: z.array(GrantCell),
  denials: z.array(ToolDenial),
  /** Approvals a human agreed to remember, so they can be seen and taken back. */
  remembered: z.array(RememberRule),
});
export type ToolsResponse = z.infer<typeof ToolsResponse>;

export const SetGrantRequest = z.object({
  agentId: z.string(),
  toolId: z.string(),
  grant: z.enum(['allow', 'deny', 'unset']),
});
export type SetGrantRequest = z.infer<typeof SetGrantRequest>;
