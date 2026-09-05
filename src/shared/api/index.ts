// HTTP contract (spec/api-and-cli.md). The UI and the CLI share these schemas.
import { z } from 'zod';
import { RunKind, RunState, Spent, EventRecord } from '../events.js';
import { Budgets, NetworkMode } from '../permissions.js';

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

// ---- what a run will cost, before it runs (F2) ---------------------------------------------------

/** The same shape as a run request: what would be started, so the estimate is about that and nothing else. */
export const EstimateRequest = z.object({
  kind: RunKind,
  id: z.string(),
  inputs: z.record(z.string(), z.unknown()).default({}),
  overrides: z.record(z.string(), z.unknown()).optional(),
});
export type EstimateRequest = z.infer<typeof EstimateRequest>;

export const StepEstimate = z.object({
  stepId: z.string(),
  agentId: z.string().nullable(),
  /** The model the step would run on right now, or null when nothing is ready (then the step costs nothing here and fails there). */
  modelId: z.string().nullable(),
  /** Tokens the compiled prompt comes to, from its size; a reference to an upstream step counts as a typical output. */
  promptTokens: z.number().int(),
  outputTokens: z.number().int(),
  /** One clean call, and a run with a few tool rounds or retries. */
  lowUsd: z.number(),
  highUsd: z.number(),
  note: z.string().nullable(),
});
export type StepEstimate = z.infer<typeof StepEstimate>;

export const EstimateResponse = z.object({
  steps: z.array(StepEstimate),
  promptTokens: z.number().int(),
  lowUsd: z.number(),
  highUsd: z.number(),
  /** The cap the run would actually stop at, so the estimate is read against it. */
  maxCostUsd: z.number(),
  caveat: z.string(),
});
export type EstimateResponse = z.infer<typeof EstimateResponse>;

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

/** A plugin, as Settings shows it: what it says it is, whether it ran, and whether anyone said it could. */
export const PluginStatusSummary = z.object({
  name: z.string(),
  version: z.string(),
  kind: z.enum(['adapter', 'tool', 'evaluator']),
  capabilities: z.array(z.string()),
  description: z.string().nullable(),
  loaded: z.boolean(),
  error: z.string().nullable(),
  /** False until a human has been shown the warning for this exact version and said yes (D-32). */
  acknowledged: z.boolean(),
  /** The words shown before it runs, from the runtime, so the screen and the CLI say the same thing. */
  warning: z.string(),
});
export type PluginStatusSummary = z.infer<typeof PluginStatusSummary>;

export const SettingsResponse = z.object({
  workspacePath: z.string(),
  workspaceName: z.string(),
  networkMode: z.string(),
  budgets: z.record(z.string(), z.number()),
  execution: z.record(z.string(), z.unknown()),
  retention: z.record(z.string(), z.number()),
  providersConfigured: z.array(z.string()),
  sandbox: z.object({ deno: z.boolean() }),
  /** What is configured, and what a person can change here (RUN-11). */
  mcpServers: z.array(z.unknown()).default([]),
  push: z.object({ enabled: z.boolean(), events: z.array(z.string()) }).optional(),
  plugins: z.array(PluginStatusSummary).default([]),
  /** Which models do the work (D-68): each role's ordered list, and the model each resolves to right now. */
  models: z.object({
    roles: z.record(z.string(), z.array(z.string())),
    resolved: z.record(z.string(), z.string().nullable()),
    /** Roles an agent or a workflow step names that no list defines. */
    undefinedRoles: z.array(z.string()),
  }).optional(),
});
export type SettingsResponse = z.infer<typeof SettingsResponse>;

export const AgentModelPolicy = z.object({
  primary: z.string(), fallbacks: z.array(z.string()), requires: z.record(z.string(), z.unknown()).optional(),
  /** The ids the policy comes to right now, roles expanded to what is ready (D-68). Empty means nothing would run. */
  now: z.array(z.string()).default([]),
});

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
  availability: z.enum(['ready', 'no-credential', 'blocked-by-mode', 'unreachable', 'disabled', 'no-adapter', 'price-unknown']),
  reason: z.string().nullable(),
  capabilities: z.record(z.string(), z.unknown()),
  pricing: z.array(z.record(z.string(), z.unknown())),
  dataPolicy: z.record(z.string(), z.unknown()),
  baseUrl: z.string().optional(),
});
export type ModelStatus = z.infer<typeof ModelStatus>;

/** Who pins a model: an agent's policy, or a workflow step's override. Carried on a `retired` finding (D-64). */
export const CatalogFindingPin = z.object({
  agentId: z.string().optional(),
  role: z.enum(['primary', 'fallback']).optional(),
  workflowId: z.string().optional(),
  stepId: z.string().optional(),
});
export type CatalogFindingPin = z.infer<typeof CatalogFindingPin>;

/**
 * One thing a provider's listing says that the catalog does not (D-64). `displayName` and `description` are
 * the provider's text and are data: shown as text, never written to the catalog, never in a prompt.
 * `proposed` is exactly what accepting would write, so the screen can show it before a person agrees.
 */
export const CatalogFinding = z.object({
  id: z.string(),
  kind: z.enum(['new', 'retired', 'repriced', 'drift']),
  modelId: z.string(),
  adapter: z.string(),
  provider: z.string(),
  factsHash: z.string(),
  detail: z.string(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  pinnedBy: z.array(CatalogFindingPin),
  proposed: z.record(z.string(), z.unknown()).optional(),
  /** For a new entry on an OpenAI-compatible provider: the endpoint the entry will name. */
  baseUrl: z.string().optional(),
});
export type CatalogFinding = z.infer<typeof CatalogFinding>;

export const DiscoveryReport = z.object({
  /** Providers that were actually asked. A provider with no credential or an adapter that cannot list is not here. */
  checked: z.array(z.string()),
  errors: z.array(z.object({ provider: z.string(), code: z.string(), message: z.string() })),
});
export type DiscoveryReport = z.infer<typeof DiscoveryReport>;

export const ModelListResponse = z.object({
  models: z.array(ModelStatus),
  networkMode: z.string(),
  pulled: z.record(z.string(), z.array(z.string())),
  findings: z.array(CatalogFinding).default([]),
  discovery: DiscoveryReport.optional(),
});
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

/** A budget block as written: only the keys the author set. */
export const BudgetLines = z.object({
  maxModelCalls: z.number().optional(), maxToolCalls: z.number().optional(), maxCostUsd: z.number().optional(),
  maxWallClockMs: z.number().optional(), toolCallTimeoutMs: z.number().optional(), dailySpendCapUsd: z.number().optional(), monthlySpendCapUsd: z.number().optional(),
});
export type BudgetLines = z.infer<typeof BudgetLines>;

export const WorkflowDetail = WorkflowSummary.extend({
  definition: z.record(z.string(), z.unknown()),
  /** Advisory only (D-49): the Workflows screen shows them, nothing blocks on them. */
  smells: z.array(z.object({ stepId: z.string(), message: z.string() })),
  order: z.array(z.string()),
  /** What the workflow and its steps cap themselves at, so the run form can say so before a run starts (RUN-17). */
  budgets: z.object({ workflow: BudgetLines.nullable(), steps: z.array(z.object({ stepId: z.string(), budget: BudgetLines })) }),
  /** How many schedule rows point at this workflow, so a delete can say what goes with it (RUN-13). */
  schedules: z.number().int(),
});
export type WorkflowDetail = z.infer<typeof WorkflowDetail>;

/** The editor's save (D-62): the whole definition, and the content hash it was loaded at. */
export const SaveWorkflowRequest = z.object({
  definition: z.record(z.string(), z.unknown()),
  baseVersion: z.string().min(1),
});
export type SaveWorkflowRequest = z.infer<typeof SaveWorkflowRequest>;

/** A new workflow file: blank, or a copy of one that exists (its schedule block is not copied). */
export const CreateWorkflowRequest = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'lowercase letters, digits and hyphens'),
  name: z.string().min(1),
  copyOf: z.string().optional(),
});
export type CreateWorkflowRequest = z.infer<typeof CreateWorkflowRequest>;

/** One problem a save was refused for: a JSON path and, when it concerns a step, the step's id. */
export const WorkflowIssue = z.object({ path: z.string(), stepId: z.string().nullable(), message: z.string() });
export type WorkflowIssue = z.infer<typeof WorkflowIssue>;

/**
 * Why a save was refused because the file moved underneath the editor: what is on disk now, against the
 * version the editor started from when the runtime still knows it, else against the draft being saved.
 */
export const WorkflowConflict = z.object({
  baseVersion: z.string(),
  currentVersion: z.string(),
  against: z.enum(['loaded', 'draft']),
  diff: DiffResponse,
});
export type WorkflowConflict = z.infer<typeof WorkflowConflict>;

export const DeleteWorkflowResponse = z.object({ deleted: z.literal(true), schedules: z.number().int() });
export type DeleteWorkflowResponse = z.infer<typeof DeleteWorkflowResponse>;

// ---- the permissions review (D-63, RUN-14) -------------------------------------------------------

export const FindingKind = z.enum(['unused', 'unjustified', 'reach', 'fatigue', 'undecided']);
export type FindingKind = z.infer<typeof FindingKind>;

/**
 * The one change a finding proposes, in the matrix's own terms. `set` is a tool decision; `netAllow` replaces
 * the agent's allowed hosts. Absent means the finding is worth reading and has nothing to flip.
 */
export const FindingProposal = z.object({
  agentId: z.string(),
  tool: z.string().optional(),
  set: z.enum(['allow', 'deny', 'unset']).optional(),
  netAllow: z.array(z.string()).optional(),
  /** The proposal in words, exactly what the Apply button says. */
  label: z.string(),
});
export type FindingProposal = z.infer<typeof FindingProposal>;

export const PermissionFinding = z.object({
  id: z.string(),
  key: z.string(),
  kind: FindingKind,
  agentId: z.string().nullable(),
  tool: z.string().nullable(),
  /** One sentence naming what is wrong, from the runtime's numbers, never the model's. */
  headline: z.string(),
  /** The facts the finding rests on, one line each. */
  evidence: z.array(z.string()),
  /** What the auditor added, if anything. Untrusted text: rendered, never executed or templated. */
  note: z.string().nullable(),
  proposal: FindingProposal.nullable(),
  state: z.enum(['open', 'applied', 'dismissed']),
  runId: z.string().nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
});
export type PermissionFinding = z.infer<typeof PermissionFinding>;

export const PermissionFindingsResponse = z.object({ findings: z.array(PermissionFinding) });
export type PermissionFindingsResponse = z.infer<typeof PermissionFindingsResponse>;

/** The person deciding: apply is an ordinary matrix write by the human; dismiss holds until the facts change. */
export const FindingDecisionRequest = z.object({ decision: z.enum(['apply', 'dismiss']) });
export type FindingDecisionRequest = z.infer<typeof FindingDecisionRequest>;

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

/** Where the money went (F3): the same rows every cap reads, so the screen and the stop agree to the cent. */
export const SpendResponse = z.object({
  todayUsd: z.number(),
  last7DaysUsd: z.number(),
  last30DaysUsd: z.number(),
  thisMonthUsd: z.number(),
  monthlySpendCapUsd: z.number(),
  dailySpendCapUsd: z.number(),
  /** This month's spend at the rate so far, carried to the end of the month. */
  projectedMonthUsd: z.number(),
  daysLeftInMonth: z.number().int(),
  /** True while the month's cap is used up: nothing scheduled fires until the month turns or the cap is raised. */
  schedulesPaused: z.boolean(),
  byModel: z.array(z.object({ modelId: z.string(), usd: z.number(), calls: z.number().int() })),
  bySubject: z.array(z.object({ subject: z.string(), kind: z.string(), usd: z.number(), runs: z.number().int() })),
});
export type SpendResponse = z.infer<typeof SpendResponse>;

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
  /** This month against its cap, and where the month is heading (F3). */
  spentThisMonthUsd: z.number().default(0),
  monthlySpendCapUsd: z.number().default(0),
  projectedMonthUsd: z.number().default(0),
  schedulesPaused: z.boolean().default(false),
  schedules: z.array(ScheduleSummary),
  networkMode: z.string(),
  /** How many of the permissions review's findings are open (F8). Nothing is blocked by them; Review decides each. */
  findings: z.number().int().nonnegative().default(0),
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
  /** True when the tool leaves the machine, so the network policy applies on top of the grant. */
  usesNetwork: z.boolean(),
  /** Absent for a built-in; otherwise the MCP server this tool came from. */
  origin: z.object({ kind: z.literal('mcp'), server: z.string() }).nullable(),
  /** False when the tool exists but cannot run right now — the execute tier without a sandbox (D-30). */
  available: z.boolean(),
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

/** Where an agent may actually go: the workspace policy already narrowed by that agent's grant (D-26). */
export const AgentNetPolicy = z.object({
  agentId: z.string(),
  mode: NetworkMode,
  allow: z.array(z.string()),
  allowLocalAddresses: z.boolean(),
  /** The network tools this agent may actually use. Empty means the policy is moot: it has no way out. */
  tools: z.array(z.string()),
});
export type AgentNetPolicy = z.infer<typeof AgentNetPolicy>;

export const NetworkSummary = z.object({
  mode: NetworkMode,
  allow: z.array(z.string()),
  allowLocalAddresses: z.boolean(),
  /** Hosts a tool may POST to without asking a human first. */
  approvalExempt: z.array(z.string()),
  searchProvider: z.string(),
  agents: z.array(AgentNetPolicy),
});
export type NetworkSummary = z.infer<typeof NetworkSummary>;

/** The sandbox, as the Tools screen shows it: whether it exists, and what is switched off when it does not. */
export const SandboxStatus = z.object({
  available: z.boolean(),
  path: z.string().nullable(),
  /** Tool ids that need the sandbox and are therefore unavailable right now. */
  disabled: z.array(z.string()),
  limits: z.object({ wallClockMs: z.number().int(), memoryMb: z.number().int(), maxOutputBytes: z.number().int() }),
});
export type SandboxStatus = z.infer<typeof SandboxStatus>;

export const McpServerSummary = z.object({
  name: z.string(),
  running: z.boolean(),
  tools: z.array(z.string()),
  error: z.string().nullable(),
  serverInfo: z.object({ name: z.string().optional(), version: z.string().optional() }).nullable(),
});
export type McpServerSummary = z.infer<typeof McpServerSummary>;

/**
 * The half of an agent's grant that is not a tool: the paths it may read and write, and the repositories it may
 * edit on a branch (D-66). Shown beside the matrix; written only by a person, in `config/workbench.json`.
 */
export const AgentGrantSummary = z.object({
  agentId: z.string(),
  fs: z.object({ read: z.array(z.string()), write: z.array(z.string()) }),
  repos: z.array(z.object({ path: z.string(), branches: z.string(), deny: z.array(z.string()).default([]) })),
});
export type AgentGrantSummary = z.infer<typeof AgentGrantSummary>;

export const ToolsResponse = z.object({
  tools: z.array(ToolSummary),
  matrix: z.array(GrantCell),
  /** Per agent: paths and repositories, from `grants.<agentId>` as a person wrote it. */
  grants: z.array(AgentGrantSummary),
  denials: z.array(ToolDenial),
  /** Approvals a human agreed to remember, so they can be seen and taken back. */
  remembered: z.array(RememberRule),
  /** The effective network policy, per agent: the half of a tool grant that is not in the matrix. */
  network: NetworkSummary,
  /** The sandbox and the MCP servers (RUN-09): where the execute tier and the outside tools come from. */
  sandbox: SandboxStatus,
  mcpServers: z.array(McpServerSummary),
});
export type ToolsResponse = z.infer<typeof ToolsResponse>;

/** A person granting a repository from the Tools screen (D-66): the whole list for one agent, replaced. */
export const SetReposRequest = z.object({
  agentId: z.string(),
  repos: z.array(z.object({ path: z.string().min(1), branches: z.string().min(1).default('run/*'), deny: z.array(z.string()).default([]) })),
});
export type SetReposRequest = z.infer<typeof SetReposRequest>;

/** A price typed in on the Models screen: a new row in effect from now (D-65). */
export const SetPriceRequest = z.object({
  inputPerM: z.number().nonnegative(),
  outputPerM: z.number().nonnegative(),
  cachedPerM: z.number().nonnegative().optional(),
});
export type SetPriceRequest = z.infer<typeof SetPriceRequest>;

export const SetEnabledRequest = z.object({ enabled: z.boolean() });
export type SetEnabledRequest = z.infer<typeof SetEnabledRequest>;

export const SetGrantRequest = z.object({
  agentId: z.string(),
  toolId: z.string(),
  grant: z.enum(['allow', 'deny', 'unset']),
});
export type SetGrantRequest = z.infer<typeof SetGrantRequest>;

// ---- transfer, plugins and settings (spec/tools-and-security.md, D-32, D-34) ----------------------


export const TrustPluginRequest = z.object({ name: z.string(), version: z.string() });
export type TrustPluginRequest = z.infer<typeof TrustPluginRequest>;

export const ImportResult = z.object({
  kind: z.enum(['agent', 'workflow', 'memory']),
  id: z.string(),
  /** What the import refused to carry over: permissions arrive as requests, never as grants (D-34). */
  stripped: z.array(z.string()),
  /** What the *export* had already redacted, echoed so the person importing knows (SEC-26). */
  redactions: z.array(z.string()),
});
export type ImportResult = z.infer<typeof ImportResult>;

/** Writing a credential: the value goes to the 0600 file and is never read back out (SEC-05). */
export const SetCredentialRequest = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/, 'lowercase letters, digits and hyphens'),
  apiKey: z.string().min(1).nullable(),
});
export type SetCredentialRequest = z.infer<typeof SetCredentialRequest>;

export const UpdateSettingsRequest = z.object({
  budgets: z.record(z.string(), z.unknown()).optional(),
  retention: z.record(z.string(), z.unknown()).optional(),
  execution: z.record(z.string(), z.unknown()).optional(),
  mcp: z.object({ servers: z.array(z.unknown()) }).optional(),
  push: z.object({ enabled: z.boolean(), events: z.array(z.string()) }).optional(),
  /** The whole roles map, replaced (D-68). A role name is lowercase letters, digits and hyphens. */
  models: z.object({ roles: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), z.array(z.string().min(1))) }).optional(),
});
export type UpdateSettingsRequest = z.infer<typeof UpdateSettingsRequest>;

// ---- evaluation (spec/evaluation.md, D-36, D-50, D-52) --------------------------------------------

export const DatasetSummary = z.object({
  id: z.string(), name: z.string(), version: z.number().int(),
  /** Frozen the moment an experiment references it: a result always names the cases it actually ran on. */
  frozen: z.boolean(),
  cases: z.number().int(),
  createdAt: z.string(),
});
export type DatasetSummary = z.infer<typeof DatasetSummary>;

export const CaseSummary = z.object({
  id: z.string(),
  input: z.record(z.string(), z.unknown()),
  reference: z.unknown().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
});
export type CaseSummary = z.infer<typeof CaseSummary>;

export const ScoreRecord = z.object({
  id: z.string(), runId: z.string(), evaluatorId: z.string(), metric: z.string(), value: z.number(),
  rationale: z.string().nullable(),
  /** A judge model's opinion. The word "estimate" appears wherever this is true, and it never gates anything. */
  estimate: z.boolean(),
  ts: z.string(),
});
export type ScoreRecord = z.infer<typeof ScoreRecord>;

export const ExperimentState = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']);
export type ExperimentState = z.infer<typeof ExperimentState>;

export const ExperimentSummary = z.object({
  id: z.string(), name: z.string(),
  dataset: z.object({ id: z.string(), name: z.string(), version: z.number().int() }).nullable(),
  target: z.object({ kind: z.enum(['agent', 'workflow']), id: z.string(), version: z.string().nullable() }),
  models: z.array(z.string()),
  trials: z.number().int(),
  state: ExperimentState,
  error: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  counts: z.record(z.string(), z.number()),
});
export type ExperimentSummary = z.infer<typeof ExperimentSummary>;

/** One cell of the results table: a case on a model, over `k` trials (D-52). */
export const ResultCell = z.object({
  caseId: z.string(),
  modelId: z.string(),
  trials: z.number().int(),
  /**
   * Per metric: the mean over trials, and pass^k — every trial passing, which is a different claim. `passK` is
   * null for a metric that is not pass/fail: a judge answering 0.8 has not failed, so "pass^k 0%" would lie.
   */
  metrics: z.record(z.string(), z.object({ mean: z.number(), passK: z.number().nullable(), estimate: z.boolean() })),
  costUsd: z.number(),
  latencyMs: z.number(),
  runIds: z.array(z.string()),
});
export type ResultCell = z.infer<typeof ResultCell>;

export const ExperimentResults = z.object({
  experiment: ExperimentSummary,
  cases: z.array(CaseSummary),
  cells: z.array(ResultCell),
  /** Per model, over every case: what a person reads first. */
  totals: z.array(z.object({
    modelId: z.string(),
    metrics: z.record(z.string(), z.object({ mean: z.number(), passK: z.number().nullable(), estimate: z.boolean() })),
    costUsd: z.number(),
    latencyMs: z.number(),
  })),
});
export type ExperimentResults = z.infer<typeof ExperimentResults>;

export const CreateDatasetRequest = z.object({
  name: z.string().min(1),
  cases: z.array(z.object({
    input: z.record(z.string(), z.unknown()),
    reference: z.unknown().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })).default([]),
});
export type CreateDatasetRequest = z.infer<typeof CreateDatasetRequest>;

export const CreateExperimentRequest = z.object({
  name: z.string().min(1),
  datasetId: z.string(),
  target: z.object({ kind: z.enum(['agent', 'workflow']), id: z.string() }),
  models: z.array(z.string()).min(1),
  trials: z.number().int().min(1).max(10).default(3),
  evaluators: z.array(z.record(z.string(), z.unknown())).default([]),
  budgets: z.record(z.string(), z.unknown()).optional(),
  project: z.string().optional(),
});
export type CreateExperimentRequest = z.infer<typeof CreateExperimentRequest>;

/** Re-run a finished run as a new one. `model` swaps the substrate; a workflow refuses it (its steps choose). */
export const RerunRequest = z.object({
  model: z.string().min(1).optional(),
  provider: z.literal('mock').optional(),
});
export type RerunRequest = z.infer<typeof RerunRequest>;

/** One step, N models, side by side. The cheapest eval there is, and the one most owners actually use. */
export const CompareRequest = z.object({
  agentId: z.string(),
  input: z.string().min(1),
  models: z.array(z.string()).min(2).max(6),
  project: z.string().optional(),
});
export type CompareRequest = z.infer<typeof CompareRequest>;

export const ComparePane = z.object({
  modelId: z.string(),
  runId: z.string(),
  state: z.string(),
  output: z.string(),
  latencyMs: z.number(),
  costUsd: z.number(),
  tokensIn: z.number().int(),
  tokensOut: z.number().int(),
  error: z.string().nullable(),
});
export type ComparePane = z.infer<typeof ComparePane>;

export const CompareResponse = z.object({ compareId: z.string(), panes: z.array(ComparePane) });
export type CompareResponse = z.infer<typeof CompareResponse>;

/** The pick, stored as a rating on every pane so the choice keeps both sides of itself (D-50). */
export const ComparePickRequest = z.object({
  compareId: z.string(),
  winner: z.object({ runId: z.string(), modelId: z.string() }),
  panes: z.array(z.object({ runId: z.string(), modelId: z.string() })).min(2),
  note: z.string().optional(),
});
export type ComparePickRequest = z.infer<typeof ComparePickRequest>;

// ---- memory and knowledge (spec/artifacts-and-memory.md, D-17, D-35) ------------------------------

export const MemoryScope = z.enum(['agent', 'user', 'workspace', 'project']);
export type MemoryScope = z.infer<typeof MemoryScope>;

export const MemoryItem = z.object({
  id: z.string(),
  scope: MemoryScope,
  ownerId: z.string(),
  content: z.string(),
  source: z.enum(['user', 'agent-tool', 'import']),
  /** Derived from what the writing run had consumed, never declared by the writer. */
  trust: z.enum(['trusted', 'untrusted']),
  runId: z.string().nullable(),
  supersedesId: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
});
export type MemoryItem = z.infer<typeof MemoryItem>;

export const MemoryResponse = z.object({ items: z.array(MemoryItem) });
export type MemoryResponse = z.infer<typeof MemoryResponse>;

export const CreateMemoryRequest = z.object({
  content: z.string().min(1),
  scope: MemoryScope.default('workspace'),
  ownerId: z.string().optional(),
  supersedesId: z.string().optional(),
  expiresAt: z.string().optional(),
});
export type CreateMemoryRequest = z.infer<typeof CreateMemoryRequest>;

/** What the delete dialog needs before it asks: how many traces quoted this item. */
export const MemoryTracesResponse = z.object({ itemId: z.string(), runIds: z.array(z.string()) });
export type MemoryTracesResponse = z.infer<typeof MemoryTracesResponse>;

export const DeleteMemoryResponse = z.object({ deleted: z.boolean(), redactedRuns: z.array(z.string()) });
export type DeleteMemoryResponse = z.infer<typeof DeleteMemoryResponse>;

export const KnowledgeChunk = z.object({
  documentId: z.string(),
  project: z.string(),
  path: z.string(),
  versionId: z.string(),
  chunkIndex: z.number().int(),
  offset: z.number().int(),
  content: z.string(),
});
export type KnowledgeChunk = z.infer<typeof KnowledgeChunk>;

export const KnowledgeSearchResponse = z.object({ chunks: z.array(KnowledgeChunk) });
export type KnowledgeSearchResponse = z.infer<typeof KnowledgeSearchResponse>;

export const IngestKnowledgeResponse = z.object({
  path: z.string(),
  format: z.enum(['markdown', 'text', 'json', 'csv', 'html', 'pdf']),
  characters: z.number().int(),
  documentId: z.string(),
  versionId: z.string(),
});
export type IngestKnowledgeResponse = z.infer<typeof IngestKnowledgeResponse>;

// ---- push (spec/ui.md §Phone, D-61) --------------------------------------------------------------

/** The four moments worth interrupting someone for. */
export const PushEventKind = z.enum(['approval-requested', 'review-blocking', 'run-failed', 'scheduled-run-completed']);
export type PushEventKind = z.infer<typeof PushEventKind>;

export const PushSubscription = z.object({
  id: z.string(),
  /** The push service's host only. The full endpoint is a capability URL and is never shown. */
  endpoint: z.string(),
  deviceLabel: z.string().nullable(),
  events: z.array(PushEventKind),
  lastSentAt: z.string().nullable(),
  createdAt: z.string(),
});
export type PushSubscription = z.infer<typeof PushSubscription>;

export const SubscribePushRequest = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
  deviceLabel: z.string().max(120).optional(),
  events: z.array(PushEventKind).optional(),
});
export type SubscribePushRequest = z.infer<typeof SubscribePushRequest>;

export const PushSubscriptionsResponse = z.object({
  enabled: z.boolean(),
  subscriptions: z.array(PushSubscription),
});
export type PushSubscriptionsResponse = z.infer<typeof PushSubscriptionsResponse>;
