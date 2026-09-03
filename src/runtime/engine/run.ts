// The engine: it owns run rows, the run queue, budgets and cancellation, and hands the actual work to the
// step runner (one agent step) or the workflow executor (a DAG of them). Spec: workflows-and-execution.md.
import { ulid } from 'ulid';
import type { Db } from '../db/index.js';
import type { Workspace } from '../workspace/loader.js';
import type { AdapterRegistry, FetchLike } from '../models/adapter.js';
import type { ArtifactStore } from '../artifacts/store.js';
import type { Credentials } from '../security/credentials.js';
import type { Redactor } from '../security/redaction.js';
import type { Logger } from '../log/index.js';
import type { EventStore } from './events.js';
import { RunBudget, narrowBudgets, type BudgetOverride } from './budget.js';
import { StepFailure, StepRunner } from './step.js';
import { WorkflowExecutor, WorkflowFailure, type ReviewHost } from './workflow-run.js';
import { MAX_REJECTIONS, ReviewStore, type ReviewDecision } from '../review/store.js';
import { ApprovalStore, type ApprovalDecision } from '../approvals/store.js';
import { ToolExecutor, type ApprovalHost } from '../tools/executor.js';
import { builtinTools } from '../tools/registry.js';
import { searchProvider, type MockSearchFixture } from '../search/index.js';
import { RunTaint } from './taint.js';
import { MemoryStore } from '../memory/store.js';
import { EvaluationStore } from '../evaluation/store.js';
import { ExperimentRunner } from '../evaluation/runner.js';
import { DEFAULT_LIMITS, type Sandbox } from '../sandbox/deno.js';
import type { McpHost } from '../mcp/host.js';
import { scopesFor } from './step.js';
import { MAX_DEPTH, type DelegateHost, type PermissionRequestHost } from '../tools/builtin/delegate.js';
import type { PushEventKind, RememberRule } from '../../shared/api/index.js';
import type { RunDetail, RunSummary } from '../../shared/api/index.js';
import type { RunState, Spent } from '../../shared/events.js';
import type { LoadedAgent } from '../../shared/agent.js';
import type { LoadedWorkflow } from '../../shared/workflow.js';
import type { WorkbenchConfig } from '../../shared/workspace.js';
import type { EgressAttempt, EgressDecision } from '../security/egress.js';
import type { LookupFn } from '../security/dns.js';
import type { NetConnector } from '../security/netfetch.js';
import { applyDefaults, validateJson } from '../../shared/jsonschema.js';

export interface EngineDeps {
  db: Db;
  events: EventStore;
  workspace: () => Workspace;
  registry: AdapterRegistry;
  credentials: Credentials;
  redactor: Redactor;
  log: Logger;
  providerOverride: 'mock' | null;
  /** The fetch the egress checker wraps. Tests pass a replay; production passes the real one. */
  fetch?: FetchLike | undefined;
  /** The runtime's own port, refused as a destination in every mode. */
  runtimePort?: (() => number | null) | undefined;
  /** The Library. Present from RUN-03; a run without a project still runs, it just has nowhere to file output. */
  artifacts?: ArtifactStore | undefined;
  /** The clock approvals expire against. A test drives it; production leaves it alone. */
  now?: (() => Date) | undefined;
  /** Writes `config/workbench.json` back, for a remembered approval and an edited grant. */
  persistConfig?: ((config: WorkbenchConfig) => void) | undefined;
  /** Tool egress (RUN-07). The runtime supplies the checker's policy, the log, and the injectable seams. */
  net?: {
    record: (attempt: EgressAttempt, decision: EgressDecision) => void;
    lookup?: LookupFn | undefined;
    connect?: NetConnector | undefined;
  } | undefined;
  /** The sandbox (RUN-09). The runtime finds Deno once and hands it in; absent disables the execute tier. */
  sandbox?: Sandbox | undefined;
  /** MCP servers (RUN-09). Their tools join the catalogue after `start()`, through `Engine.addTools`. */
  mcp?: McpHost | undefined;
  /** PATH HOME TMPDIR LANG LC_* TZ — the only variables a child of this runtime inherits (D-33). */
  childEnvAllowlist?: Record<string, string> | undefined;
  /** `<workspace>/fixtures/search/results.json`, read by the runtime for the mock provider. */
  searchFixture?: (() => MockSearchFixture | null) | undefined;
}

/** One human decision, handed to whichever run is parked behind it. */
interface GateDecision { decision: ReviewDecision; feedback?: string | undefined }
interface ApprovalGateDecision { decision: 'allow' | 'deny'; reason: string }

export class NotFoundError extends Error { constructor(m: string) { super(m); this.name = 'NotFoundError'; } }
export class ValidationError extends Error { constructor(m: string) { super(m); this.name = 'ValidationError'; } }
export class ConflictError extends Error { constructor(m: string) { super(m); this.name = 'ConflictError'; } }

export interface StartAgentRunInput {
  agentId: string;
  inputs: Record<string, unknown>;
  project?: string | undefined;
  provider?: 'mock' | undefined;
  modelOverride?: string | undefined;
  budget?: BudgetOverride | undefined;
  /** Set when this run is a delegation: it nests in the parent's trace and counts against the parent (D-12). */
  parent?: { runId: string; stepId: string; depth: number } | undefined;
}

export interface StartWorkflowRunInput {
  workflowId: string;
  inputs: Record<string, unknown>;
  project?: string | undefined;
  provider?: 'mock' | undefined;
  budget?: BudgetOverride | undefined;
}

interface RunRow {
  id: string; kind: string; state: RunState; agent_id: string | null; workflow_id: string | null; workflow_version: string | null; project_id: string | null;
  inputs_json: string; outputs_json: string | null; budgets_json: string; spent_json: string;
  started_at: string; finished_at: string | null; error_json: string | null;
}
interface StepRow { step_id: string; kind: string; state: string; model_id: string | null; parent_step_id: string | null; map_index: number | null; cost_usd: number; started_at: string | null; finished_at: string | null }

/** A run in flight: what cancel aborts and what `waitFor` waits on. */
interface Inflight { controller: AbortController; done: Promise<void>; queued: boolean }

export class Engine {
  private readonly inflight = new Map<string, Inflight>();
  private readonly queue: string[] = [];
  private readonly pending = new Map<string, () => Promise<void>>();
  private readonly steps: StepRunner;
  private readonly workflows: WorkflowExecutor;
  private readonly gates = new Map<string, (d: GateDecision) => void>();
  /** The live taint of each running run, so a tool can ask what its own run has already consumed (D-17, D-29). */
  private readonly taints = new Map<string, RunTaint>();
  private readonly approvalGates = new Map<string, (d: ApprovalGateDecision) => void>();
  private expiry: NodeJS.Timeout | null = null;
  readonly reviews: ReviewStore;
  readonly approvals: ApprovalStore;
  readonly tools: ToolExecutor;
  readonly memory: MemoryStore;
  readonly evaluation: EvaluationStore;
  readonly experiments: ExperimentRunner;
  private push: { notify: (kind: PushEventKind, ids: { id: string; runId: string }) => Promise<unknown> } | null = null;

  /** The live taint of a run, or what the database remembers of one that is no longer in flight. */
  private taintFor(runId: string): RunTaint {
    return this.taints.get(runId) ?? RunTaint.load(this.deps.db, runId);
  }

  private trackTaint(runId: string, taint: RunTaint): RunTaint {
    this.taints.set(runId, taint);
    return taint;
  }

  constructor(private readonly deps: EngineDeps) {
    if (!deps.artifacts) throw new Error('The engine needs the Library: tools file their output there, and the broker checks paths against it.');
    const artifacts = deps.artifacts;
    this.reviews = new ReviewStore(deps.db);
    this.approvals = new ApprovalStore(deps.db, () => deps.now?.() ?? new Date());
    this.memory = new MemoryStore(deps.db, deps.events);
    this.evaluation = new EvaluationStore(deps.db);
    // Closes over `this` like the tool hosts: an experiment starts ordinary runs, so every trial has a trace.
    this.experiments = new ExperimentRunner({
      db: deps.db, log: deps.log, store: this.evaluation,
      startAgentRun: (input) => this.startAgentRun({
        agentId: input.agentId, inputs: input.inputs,
        ...(input.project ? { project: input.project } : {}),
        ...(input.modelOverride ? { modelOverride: input.modelOverride } : {}),
        ...(input.budget ? { budget: input.budget as BudgetOverride } : {}),
      }),
      runDetail: (runId) => this.evaluationDetail(runId),
      // A judge is a model call like any other, through the same adapter and the same egress checker.
      judge: (input) => this.steps.callOnce({
        modelId: input.modelId, prompt: input.prompt, runId: 'judge',
        ...(deps.providerOverride === 'mock' ? { provider: 'mock' as const } : {}),
      }),
    });
    this.steps = new StepRunner({
      db: deps.db, events: deps.events, workspace: deps.workspace, registry: deps.registry,
      credentials: deps.credentials, redactor: deps.redactor, log: deps.log,
      fetch: deps.fetch, runtimePort: deps.runtimePort, artifacts, memory: this.memory,
    });
    // The hosts below close over `this`; nothing calls them during construction, so the cycle between the
    // engine (which starts child runs) and the tools (which ask it to) never has to be broken by a null.
    this.tools = new ToolExecutor({
      db: deps.db, events: deps.events, log: deps.log, redactor: deps.redactor, credentials: deps.credentials,
      config: () => deps.workspace().config,
      workspaceDir: deps.workspace().paths.dir,
      tools: builtinTools({
        artifacts,
        workspaceDir: deps.workspace().paths.dir,
        delegate: this.delegateHost(),
        permissions: this.permissionRequestHost(),
        files: {
          sandboxAvailable: () => deps.sandbox?.available ?? false,
          maxBytes: () => deps.workspace().config.context.maxToolResultChars,
        },
        code: {
          available: () => deps.sandbox?.available ?? false,
          limits: () => DEFAULT_LIMITS,
          // Closes over `this`, like the delegate and permission hosts above: nothing calls it during construction.
          runScript: (input) => this.tools.runScriptFor(input),
          runShell: (input) => this.tools.runShellFor(input),
        },
        memory: {
          memory: this.memory,
          artifacts,
          scopesFor: (agentId, project) => scopesFor(agentId, project),
          // A run that has read the web remembers untrustingly, whatever it says about what it read (D-17).
          trustFor: (runId) => (this.taintFor(runId).externalTainted ? 'untrusted' : 'trusted'),
          markPrivate: (runId) => this.taintFor(runId).markPrivate('a memory or knowledge search returned private content'),
          knowledgeChunks: () => deps.workspace().config.context.knowledgeChunks,
        },
        web: {
          maxResponseBytes: () => deps.workspace().config.tools.http.maxResponseBytes,
          timeoutMs: () => deps.workspace().config.tools.http.timeoutMs,
          search: () => {
            const config = deps.workspace().config.search;
            return searchProvider({
              provider: config.provider,
              ...(config.searxng?.url ? { searxngUrl: config.searxng.url } : {}),
              braveKey: () => deps.credentials.get('brave'),
              ...(deps.searchFixture ? { fixture: deps.searchFixture } : {}),
            });
          },
        },
      }),
      approvals: this.approvalHost(),
      ...(deps.sandbox ? { sandbox: deps.sandbox } : {}),
      ...(deps.childEnvAllowlist ? { childEnvAllowlist: deps.childEnvAllowlist } : {}),
      ...(deps.net ? {
        net: {
          policy: () => {
            const config = deps.workspace().config;
            return {
              mode: config.network.mode,
              allow: config.network.allow,
              allowLocalAddresses: config.network.allowLocalAddresses,
              runtimePort: deps.runtimePort?.() ?? null,
            };
          },
          record: deps.net.record,
          ...(deps.net.lookup ? { lookup: deps.net.lookup } : {}),
          ...(deps.net.connect ? { connect: deps.net.connect } : {}),
          ...(deps.runtimePort ? { runtimePort: deps.runtimePort } : {}),
        },
      } : {}),
    });
    this.steps.attachTools(this.tools);
    this.workflows = new WorkflowExecutor({
      db: deps.db, events: deps.events, workspace: deps.workspace, log: deps.log,
      artifacts, steps: this.steps, review: this.reviewHost(), tools: this.tools,
    });
  }

  /** Push is attached after construction, like tools: the runtime owns the keys and this owns the moments. */
  attachPush(push: { notify: (kind: PushEventKind, ids: { id: string; runId: string }) => Promise<unknown> }): void {
    this.push = push;
  }

  /** A notification is a nudge, not a transaction: a push that fails must never fail the run it is about. */
  private nudge(kind: PushEventKind, ids: { id: string; runId: string }): void {
    void this.push?.notify(kind, ids).catch((e: unknown) => this.deps.log.warn({ err: e, kind }, 'a push notification could not be sent'));
  }

  // ---- approvals (D-13) ----------------------------------------------------------------------------------

  /**
   * A tool call that policy marks sensitive parks the run in `waiting_approval` and waits. The decision comes
   * back as a tool result the agent reads — an approval is a fact about the world, not an exception.
   */
  private approvalHost(): ApprovalHost {
    return {
      request: async ({ runId, stepId, tool, args, policy, remember, ordinal, signal }) => {
        const row = this.approvals.open({ runId, stepId, tool, args, policy, ...(remember ? { remember } : {}), ...(ordinal !== undefined ? { ordinal } : {}) });
        this.deps.db.prepare("UPDATE runs SET state = 'waiting_approval' WHERE id = ?").run(runId);
        this.deps.events.append(runId, stepId, 'approval-requested', {
          approvalId: row.id, batchId: row.batch_id, tool, args, policy, expiresAt: row.expires_at,
        });
        this.nudge('approval-requested', { id: row.batch_id, runId });

        const outcome = await this.waitForApproval(row.id, signal);
        this.deps.db.prepare("UPDATE runs SET state = 'running' WHERE id = ?").run(runId);
        this.deps.events.append(runId, stepId, 'approval-decided', {
          approvalId: row.id, tool, decision: outcome.decision, reason: outcome.reason,
        });
        return outcome;
      },
    };
  }

  private waitForApproval(approvalId: string, signal: AbortSignal): Promise<ApprovalGateDecision> {
    return new Promise<ApprovalGateDecision>((resolve) => {
      const settle = (d: ApprovalGateDecision): void => {
        signal.removeEventListener('abort', onAbort);
        this.approvalGates.delete(approvalId);
        resolve(d);
      };
      // A cancelled run does not get its approval: the safe answer when nobody is deciding is no.
      const onAbort = (): void => settle({ decision: 'deny', reason: 'the run was cancelled' });
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
      this.approvalGates.set(approvalId, settle);
    });
  }

  /** The human decided. `allow-remember` also writes the narrowest rule to workspace config (SEC-12). */
  decideApproval(idOrBatch: string, decision: ApprovalDecision, actionId?: string): void {
    const rows = actionId
      ? [this.approvals.byId(actionId)].filter((r): r is NonNullable<typeof r> => r !== null)
      : this.approvals.list('pending').find((b) => b.batchId === idOrBatch)?.actions.map((a) => this.approvals.byId(a.id)).filter((r): r is NonNullable<typeof r> => r !== null)
        ?? [this.approvals.byId(idOrBatch)].filter((r): r is NonNullable<typeof r> => r !== null);
    if (!rows.length) throw new NotFoundError(`There is no pending approval for "${actionId ?? idOrBatch}".`);

    for (const row of rows) {
      if (row.state !== 'pending') continue;
      this.approvals.decide(row.id, decision);
      if (decision === 'allow-remember' && row.remember_json) {
        this.remember(JSON.parse(row.remember_json) as RememberRule);
      }
      const waiting = this.approvalGates.get(row.id);
      waiting?.({
        decision: decision === 'deny' ? 'deny' : 'allow',
        reason: decision === 'deny' ? 'a human refused it' : 'a human allowed it',
      });
    }
  }

  /** Writes exactly one narrow rule. Never the whole tool, never a wildcard, never more than was asked. */
  private remember(rule: RememberRule): void {
    const ws = this.deps.workspace();
    const already = ws.config.remembered.some((r) => r.tool === rule.tool && r.host === rule.host && r.path === rule.path);
    if (already) return;
    ws.config.remembered.push({ tool: rule.tool, ...(rule.host ? { host: rule.host } : {}), ...(rule.path ? { path: rule.path } : {}) });
    this.deps.persistConfig?.(ws.config);
    this.deps.log.info({ rule }, 'remembered an approval');
  }

  /** Anything past its deadline becomes a denial, and whatever was waiting on it is told (SEC-12). */
  expireApprovals(now?: Date): number {
    const expired = this.approvals.expire(now ?? this.deps.now?.() ?? new Date());
    for (const row of expired) {
      this.deps.events.append(row.run_id, row.step_id, 'approval-decided', { approvalId: row.id, tool: row.tool, decision: 'deny', reason: 'timeout' });
      this.approvalGates.get(row.id)?.({ decision: 'deny', reason: 'timeout' });
    }
    return expired.length;
  }

  /** Production wakes on a timer; a test calls `expireApprovals` with the clock it controls. */
  startApprovalExpiry(everyMs = 30_000): void {
    if (this.expiry) return;
    this.expiry = setInterval(() => { this.expireApprovals(); }, everyMs);
    this.expiry.unref?.();
  }

  stopApprovalExpiry(): void {
    if (this.expiry) clearInterval(this.expiry);
    this.expiry = null;
  }

  // ---- delegation (D-12) ---------------------------------------------------------------------------------

  /**
   * A child run: `parent_run_id`, `depth = parent + 1`, a budget carved from the parent's remainder, and
   * permissions that are the child's grant ∩ the parent's effective. It cannot do anything the parent could
   * not, and it never sees the parent's transcript — only the brief the planner wrote (D-48, SEC-13).
   */
  private delegateHost(): DelegateHost {
    return {
      delegate: async ({ parentRunId, parentStepId, agentId, brief, model, maxModelCalls, signal }) => {
        const parent = this.deps.db.prepare('SELECT * FROM runs WHERE id = ?').get(parentRunId) as (RunRow & { depth: number }) | undefined;
        if (!parent) return { ok: false, code: 'ToolError', message: `Run "${parentRunId}" is gone.` };
        const depth = (parent.depth ?? 0) + 1;
        if (depth > MAX_DEPTH) {
          return { ok: false, code: 'DelegationDepthExceeded', message: `This is delegation level ${depth}; ${MAX_DEPTH} is the limit.` };
        }

        const ws = this.deps.workspace();
        const agent = ws.agents.get(agentId);
        if (!agent) {
          const broken = ws.brokenAgents.find((b) => b.id === agentId);
          return { ok: false, code: 'NotFound', message: broken ? `Agent "${agentId}" failed to load: ${broken.message}` : `There is no agent called "${agentId}" in this workspace.` };
        }

        // The child's budget comes out of what the parent has left, so a chain cannot spend more than one run.
        const parentBudgets = JSON.parse(parent.budgets_json) as ReturnType<typeof narrowBudgets>;
        const parentSpent = JSON.parse(parent.spent_json) as Spent;
        const remainingCalls = Math.max(0, parentBudgets.maxModelCalls - parentSpent.modelCalls);
        const remainingCost = Math.max(0, parentBudgets.maxCostUsd - parentSpent.costUsd);
        if (remainingCalls < 1 || remainingCost <= 0) {
          return { ok: false, code: 'BudgetExceeded', message: 'This run has no budget left to give a child. Finish with what you have.' };
        }
        const childBudget = {
          maxModelCalls: Math.max(1, Math.min(maxModelCalls ?? remainingCalls, remainingCalls)),
          maxCostUsd: remainingCost,
        };

        const child = this.startAgentRun({
          agentId,
          inputs: { input: brief },
          ...(parent.project_id ? { project: parent.project_id } : {}),
          ...(model ? { modelOverride: model } : {}),
          budget: childBudget,
          parent: { runId: parentRunId, stepId: parentStepId, depth },
        });
        const onAbort = (): void => { try { this.cancel(child.runId); } catch { /* already finished */ } };
        signal.addEventListener('abort', onAbort, { once: true });
        try {
          await child.done;
        } finally {
          signal.removeEventListener('abort', onAbort);
        }

        const detail = this.getRun(child.runId);
        if (!detail || detail.state !== 'completed') {
          const error = detail?.error as { message?: string } | undefined;
          return { ok: false, code: 'ToolError', message: `The delegated run ${child.runId} ${detail?.state ?? 'vanished'}: ${error?.message ?? 'no details'}` };
        }
        // The parent pays for the child, so a chain shows up in one place.
        this.deps.db.prepare('UPDATE runs SET spent_json = ? WHERE id = ?')
          .run(this.persist({ ...parentSpent, costUsd: round(parentSpent.costUsd + detail.spent.costUsd), modelCalls: parentSpent.modelCalls + detail.spent.modelCalls }), parentRunId);
        return { ok: true, runId: child.runId, output: String(detail.outputs?.['output'] ?? ''), costUsd: detail.spent.costUsd };
      },
    };
  }

  private permissionRequestHost(): PermissionRequestHost {
    return {
      ask: async ({ runId, stepId, what, why, signal }) => this.approvalHost().request({
        runId, stepId, tool: 'permission.request', args: { what, why },
        // The card's risk line already carries the what and the why from the args; the policy line says which
        // rule put this in front of a human, and saying the same thing twice makes both lines skimmable noise.
        policy: 'The agent asked for something it is not granted.', signal,
      }),
    };
  }

  // ---- review (D-13) -------------------------------------------------------------------------------------

  /**
   * Every completed step is filed for review. Non-blocking is the default and returns immediately; a blocking
   * gate parks the run in `waiting_review` with no timeout, and the human's decision is what starts it again.
   */
  private reviewHost(): ReviewHost {
    return {
      afterStep: async ({ runId, stepId, blocking, versionId, signal }) => {
        const row = this.reviews.open({ runId, stepId, blocking, ...(versionId ? { versionId } : {}) });
        if (!blocking) return null;

        this.deps.db.prepare("UPDATE runs SET state = 'waiting_review' WHERE id = ?").run(runId);
        this.deps.events.append(runId, stepId, 'review-requested', { reviewId: row.id, stepId, attempt: row.attempt, versionId: versionId ?? null });
        this.nudge('review-blocking', { id: row.id, runId });

        const decision = await this.waitForReview(row.id, signal);
        this.deps.db.prepare("UPDATE runs SET state = 'running' WHERE id = ?").run(runId);
        this.deps.events.append(runId, stepId, 'review-decided', {
          reviewId: row.id, decision: decision.decision, feedback: decision.feedback ?? null, attempt: row.attempt,
        });

        // A third rejection would be a conversation, not a gate: the run carries on with what it has.
        if (decision.decision === 'reject' && row.attempt <= MAX_REJECTIONS) return { redo: decision.feedback ?? '' };
        return null;
      },
      pendingFeedback: (runId, stepId) => this.reviews.feedbackFor(runId, stepId),
    };
  }

  private waitForReview(reviewId: string, signal: AbortSignal): Promise<GateDecision> {
    return new Promise<GateDecision>((resolve, reject) => {
      const onAbort = (): void => { this.gates.delete(reviewId); reject(new StepFailure('cancelled', null, 'the run was cancelled while waiting for a review')); };
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
      this.gates.set(reviewId, (d) => {
        signal.removeEventListener('abort', onAbort);
        this.gates.delete(reviewId);
        resolve(d);
      });
    });
  }

  /**
   * The human decided. A run parked in this process is released; one whose process has since restarted is
   * resumed instead, so a decision made after a restart is not a decision that goes nowhere.
   */
  decideReview(reviewId: string, decision: ReviewDecision, feedback?: string): void {
    const row = this.reviews.byId(reviewId);
    if (!row) throw new NotFoundError(`There is no review with id "${reviewId}".`);
    if (row.state !== 'pending' && row.state !== 'unreviewed') {
      throw new ConflictError(`That review was already ${row.state}.`);
    }
    const wasBlocking = row.state === 'pending';
    this.reviews.decide(reviewId, decision, feedback);

    const waiting = this.gates.get(reviewId);
    if (waiting) { waiting({ decision, ...(feedback !== undefined ? { feedback } : {}) }); return; }
    if (!wasBlocking) return;

    const run = this.deps.db.prepare('SELECT state FROM runs WHERE id = ?').get(row.run_id) as { state: RunState } | undefined;
    if (run && (run.state === 'waiting_review' || run.state === 'interrupted')) {
      this.deps.log.info({ runId: row.run_id, reviewId }, 'a review decided after a restart; resuming the run');
      this.resume(row.run_id);
    }
  }

  /**
   * Anything the database still calls `running` or `queued` was killed by a restart, not finished. Events are
   * the source of truth (D-14), so the row is corrected on startup and the resume command arrives in RUN-05.
   */
  markInterrupted(): number {
    // `waiting_review` is durable state, not lost work: the review row still holds the decision the run waits
    // for, and deciding it resumes the run. Only work that was actually in flight becomes `interrupted`.
    const rows = this.deps.db.prepare("SELECT id FROM runs WHERE state IN ('running', 'queued')").all() as { id: string }[];
    const at = new Date().toISOString();
    for (const row of rows) {
      this.deps.db.prepare("UPDATE runs SET state = 'interrupted', finished_at = ? WHERE id = ?").run(at, row.id);
      this.deps.db.prepare("UPDATE run_steps SET state = 'cancelled', finished_at = ? WHERE run_id = ? AND state IN ('running', 'pending')").run(at, row.id);
      this.deps.events.append(row.id, null, 'run-interrupted', { reason: 'the runtime restarted while this run was in flight' });
    }
    if (rows.length) this.deps.log.warn({ count: rows.length }, 'runs were interrupted by a restart');
    return rows.length;
  }

  // ---- starting ------------------------------------------------------------------------------------------

  startAgentRun(input: StartAgentRunInput): { runId: string; done: Promise<void> } {
    const ws = this.deps.workspace();
    const agent = ws.agents.get(input.agentId);
    if (!agent) {
      const broken = ws.brokenAgents.find((b) => b.id === input.agentId);
      throw new NotFoundError(broken ? `Agent "${input.agentId}" failed to load: ${broken.message}` : `Agent "${input.agentId}" does not exist in this workspace.`);
    }
    const runId = ulid();
    const budgets = narrowBudgets(narrowBudgets(ws.config.budgets, agent.definition.budgets), input.budget);
    const now = new Date().toISOString();
    this.deps.db.prepare(`INSERT INTO runs (id, kind, state, agent_version, agent_id, project_id, parent_run_id, depth, inputs_json, budgets_json, spent_json, started_at)
      VALUES (?, 'agent', 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(runId, agent.version, agent.definition.id, input.project ?? null, input.parent?.runId ?? null, input.parent?.depth ?? 0,
        this.persist(input.inputs), this.persist(budgets), this.persist(EMPTY_SPENT), now);
    this.recordAgentVersion(agent, now);
    this.deps.events.append(runId, null, 'run-started', {
      kind: 'agent', agentId: agent.definition.id, agentVersion: agent.version, inputs: input.inputs,
      project: input.project ?? null, budgets, provider: input.provider ?? this.deps.providerOverride ?? null,
      ...(input.parent ? { parentRunId: input.parent.runId, parentStepId: input.parent.stepId, depth: input.parent.depth } : {}),
    });
    // The parent's trace shows the child as an event of its own, so a delegation is not a gap in the story.
    if (input.parent) {
      this.deps.events.append(input.parent.runId, input.parent.stepId, 'run-started', {
        kind: 'agent', childRunId: runId, agentId: agent.definition.id, depth: input.parent.depth, delegated: true,
      });
    }

    const taint = this.trackTaint(runId, new RunTaint(this.deps.db, runId));
    // A child inherits its parent's taint: what the parent read, the child could be quoting to it (D-29).
    if (input.parent) taint.inherit(RunTaint.load(this.deps.db, input.parent.runId));

    return this.schedule(runId, budgets, now, async (budget, signal) => {
      const task = typeof input.inputs['input'] === 'string' ? (input.inputs['input'] as string) : JSON.stringify(input.inputs);
      const host = this.reviewHost();
      let feedback: string | undefined;
      for (;;) {
        const outcome = await this.steps.runAgentStep({
          runId, stepId: 'main', agent, task,
          ...(input.project ? { project: input.project } : {}),
          ...(input.provider ?? this.deps.providerOverride ? { provider: (input.provider ?? this.deps.providerOverride) as 'mock' } : {}),
          ...(input.modelOverride ? { modelOverride: input.modelOverride } : {}),
          ...(feedback ? { feedback } : {}),
          scratchDir: `${ws.paths.runs}/${runId}`,
          taint, budget, signal,
        });
        const again = await host.afterStep({
          runId, stepId: 'main', blocking: agent.definition.review === 'blocking',
          ...(outcome.versionId ? { versionId: outcome.versionId } : {}), signal,
        });
        if (!again) return { output: outcome.output };
        feedback = again.redo;
      }
    }, input.parent !== undefined);
  }

  startWorkflowRun(input: StartWorkflowRunInput): { runId: string; done: Promise<void> } {
    const ws = this.deps.workspace();
    const workflow = ws.workflows.get(input.workflowId);
    if (!workflow) {
      const broken = ws.brokenWorkflows.find((b) => b.id === input.workflowId);
      throw new NotFoundError(broken ? `Workflow "${input.workflowId}" failed to load: ${broken.message}` : `Workflow "${input.workflowId}" does not exist in this workspace.`);
    }
    const project = input.project ?? workflow.definition.defaultProject;
    if (project && this.deps.artifacts && !this.deps.artifacts.findProject(project)) {
      throw new ValidationError(`Project "${project}" does not exist. Create it first, or name another with --project.`);
    }
    // The run form is generated from `inputs`, so the same schema is what a run is held to (D-11).
    const inputs = applyDefaults(input.inputs, workflow.definition.inputs);
    const problems = validateJson(inputs, workflow.definition.inputs);
    if (problems.length) {
      throw new ValidationError(`These inputs do not match what "${workflow.definition.id}" asks for: ${problems.map((p) => `${p.path} ${p.message}`).join('; ')}.`);
    }

    const runId = ulid();
    const budgets = narrowBudgets(narrowBudgets(ws.config.budgets, workflow.definition.budgets), input.budget);
    const now = new Date().toISOString();
    this.recordWorkflowVersion(workflow, now);
    this.deps.db.prepare(`INSERT INTO runs (id, kind, state, workflow_version, workflow_id, project_id, depth, inputs_json, budgets_json, spent_json, started_at)
      VALUES (?, 'workflow', 'running', ?, ?, ?, 0, ?, ?, ?, ?)`)
      .run(runId, workflow.version, workflow.definition.id, project ?? null, this.persist(inputs), this.persist(budgets), this.persist(EMPTY_SPENT), now);
    for (const agent of this.agentsOf(workflow)) this.recordAgentVersion(agent, now);
    this.deps.events.append(runId, null, 'run-started', {
      kind: 'workflow', workflowId: workflow.definition.id, workflowVersion: workflow.version, inputs,
      project: project ?? null, budgets, provider: input.provider ?? this.deps.providerOverride ?? null,
      steps: workflow.definition.steps.map((s) => ({ id: s.id, kind: s.kind, dependsOn: s.dependsOn })),
    });

    const taint = this.trackTaint(runId, new RunTaint(this.deps.db, runId));
    return this.schedule(runId, budgets, now, async (budget, signal) => {
      const result = await this.workflows.run({
        runId, workflow, inputs,
        ...(project ? { project } : {}),
        ...(input.provider ?? this.deps.providerOverride ? { provider: (input.provider ?? this.deps.providerOverride) as 'mock' } : {}),
        taint, budget, signal,
      });
      return result.outputs;
    });
  }

  // ---- the queue -----------------------------------------------------------------------------------------

  /**
   * `execution.maxConcurrentRuns` runs at a time; the rest sit in `queued` until a slot frees. The promise a
   * caller gets back covers the whole wait, so a blocking CLI run behaves the same queued or not.
   */
  private schedule(
    runId: string,
    budgets: ReturnType<typeof narrowBudgets>,
    startedAt: string,
    body: (budget: RunBudget, signal: AbortSignal) => Promise<Record<string, unknown>>,
    /** A delegated run never queues: its parent is holding a slot and waiting for it, so queueing would deadlock. */
    bypassQueue = false,
  ): { runId: string; done: Promise<void> } {
    const controller = new AbortController();
    const startedMs = Date.parse(startedAt);

    const work = async (): Promise<void> => {
      const budget = new RunBudget(budgets, startedMs, () => this.spentTodayUsd());
      try {
        if (controller.signal.aborted) throw new StepFailure('cancelled', null, 'the run was cancelled');
        const outputs = await body(budget, controller.signal);
        this.finish(runId, 'completed', budget.snapshot(), { outputs });
      } catch (e) {
        this.fail(runId, e, budget.snapshot(), controller.signal.aborted);
      }
    };

    const limit = Math.max(1, this.deps.workspace().config.execution.maxConcurrentRuns);
    const runningNow = [...this.inflight.values()].filter((i) => !i.queued).length;
    const queued = !bypassQueue && runningNow >= limit;

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    if (queued) {
      this.deps.db.prepare("UPDATE runs SET state = 'queued' WHERE id = ?").run(runId);
      this.deps.events.append(runId, null, 'run-queued', { ahead: this.queue.length, message: `${limit} runs are already going; this one starts when one finishes.` });
      this.queue.push(runId);
      this.pending.set(runId, async () => { release(); });
    } else {
      release();
    }

    const done = gate
      .then(() => {
        if (this.inflight.get(runId)?.queued) {
          this.inflight.set(runId, { ...this.inflight.get(runId)!, queued: false });
          this.deps.db.prepare("UPDATE runs SET state = 'running' WHERE id = ?").run(runId);
        }
        return work();
      })
      .catch((e: unknown) => { this.deps.log.error({ err: e, runId }, 'engine failure'); })
      .finally(() => { this.inflight.delete(runId); this.taints.delete(runId); this.drain(); });

    this.inflight.set(runId, { controller, done, queued });
    return { runId, done };
  }

  private drain(): void {
    const limit = Math.max(1, this.deps.workspace().config.execution.maxConcurrentRuns);
    while (this.queue.length && [...this.inflight.values()].filter((i) => !i.queued).length < limit) {
      const next = this.queue.shift()!;
      const start = this.pending.get(next);
      this.pending.delete(next);
      if (!start) continue;
      void start();
    }
  }

  // ---- cancel --------------------------------------------------------------------------------------------

  /** Aborts every in-flight model call and commits nothing from the interrupted steps (D-14 §Cancel). */
  cancel(runId: string): void {
    const row = this.deps.db.prepare('SELECT state FROM runs WHERE id = ?').get(runId) as { state: RunState } | undefined;
    if (!row) throw new NotFoundError(`Run "${runId}" does not exist.`);
    if (!ACTIVE_STATES.has(row.state)) throw new ConflictError(`Run "${runId}" is already ${row.state}; there is nothing to cancel.`);

    const entry = this.inflight.get(runId);
    entry?.controller.abort();
    if (entry?.queued) {
      // Never started, so nothing is in flight to unwind: release the gate and let `work` see the abort.
      const start = this.pending.get(runId);
      this.pending.delete(runId);
      const at = this.queue.indexOf(runId);
      if (at >= 0) this.queue.splice(at, 1);
      void start?.();
    }
    if (!entry) {
      // A run this process is not carrying (a restart left it marked running): correct the row directly.
      this.finish(runId, 'cancelled', EMPTY_SPENT, {});
      this.deps.events.append(runId, null, 'run-cancelled', { by: 'human' });
    }
  }

  /**
   * Restarts an interrupted run from its last finished step (workflows-and-execution.md §Resume). Events are
   * the source of truth, so the completed steps come from the rows they wrote: they are not re-run, and their
   * artifact versions are not written twice.
   */
  resume(runId: string): { runId: string; done: Promise<void> } {
    const row = this.deps.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow | undefined;
    if (!row) throw new NotFoundError(`Run "${runId}" does not exist.`);
    if (this.inflight.has(runId)) throw new ConflictError(`Run "${runId}" is already going.`);
    if (!RESUMABLE_STATES.has(row.state)) throw new ConflictError(`Run "${runId}" is ${row.state}; only an interrupted or parked run can be resumed.`);
    // A run held by an undecided gate is not stuck, it is waiting: resuming past it would ignore the human.
    const pending = this.reviews.pendingFor(runId);
    if (pending.length) {
      throw new ConflictError(`Run "${runId}" is waiting for a review of step "${pending[0]!.step_id}". Decide it (workbench review continue ${pending[0]!.id}) and the run carries on by itself.`);
    }
    if (row.kind !== 'workflow') return this.resumeAgentRun(row);

    const ws = this.deps.workspace();
    const workflow = ws.workflows.get(row.workflow_id ?? '');
    if (!workflow) throw new NotFoundError(`Workflow "${row.workflow_id}" is no longer in this workspace, so this run cannot be resumed.`);
    if (workflow.version !== row.workflow_version) {
      this.deps.log.warn({ runId, was: row.workflow_version, now: workflow.version }, 'the workflow changed since this run started; resuming against the current definition');
    }

    const completed = this.finishedSteps(runId);
    const budgets = JSON.parse(row.budgets_json) as ReturnType<typeof narrowBudgets>;
    const spent = JSON.parse(row.spent_json) as Spent;
    this.deps.db.prepare("UPDATE runs SET state = 'running', finished_at = NULL, error_json = NULL WHERE id = ?").run(runId);
    this.deps.events.append(runId, null, 'run-started', {
      kind: 'workflow', workflowId: workflow.definition.id, workflowVersion: workflow.version,
      resumed: true, from: [...completed.keys()], spent,
    });

    return this.schedule(runId, budgets, new Date().toISOString(), async (budget, signal) => {
      const result = await this.workflows.run({
        runId, workflow, inputs: JSON.parse(row.inputs_json) as Record<string, unknown>,
        ...(row.project_id ? { project: row.project_id } : {}),
        ...(this.deps.providerOverride ? { provider: this.deps.providerOverride } : {}),
        // A resumed run is the same run: whatever tainted it is still true.
        taint: this.trackTaint(runId, RunTaint.load(this.deps.db, runId)),
        budget, signal, completed,
      });
      return result.outputs;
    });
  }

  /** A single-agent run has one step, so resuming it is running it again from the top. */
  private resumeAgentRun(row: RunRow): { runId: string; done: Promise<void> } {
    if (!row.agent_id) throw new ConflictError(`Run "${row.id}" names no agent, so there is nothing to resume.`);
    const budgets = JSON.parse(row.budgets_json) as ReturnType<typeof narrowBudgets>;
    const agent = this.deps.workspace().agents.get(row.agent_id);
    if (!agent) throw new NotFoundError(`Agent "${row.agent_id}" is no longer in this workspace, so this run cannot be resumed.`);
    const inputs = JSON.parse(row.inputs_json) as Record<string, unknown>;
    this.deps.db.prepare("UPDATE runs SET state = 'running', finished_at = NULL, error_json = NULL WHERE id = ?").run(row.id);
    this.deps.events.append(row.id, null, 'run-started', { kind: 'agent', agentId: agent.definition.id, agentVersion: agent.version, resumed: true });

    return this.schedule(row.id, budgets, new Date().toISOString(), async (budget, signal) => {
      const task = typeof inputs['input'] === 'string' ? (inputs['input'] as string) : JSON.stringify(inputs);
      const outcome = await this.steps.runAgentStep({
        runId: row.id, stepId: 'main', agent, task,
        ...(row.project_id ? { project: row.project_id } : {}),
        ...(this.deps.providerOverride ? { provider: this.deps.providerOverride } : {}),
        budget, signal,
      });
      return { output: outcome.output };
    });
  }

  /** What a previous attempt finished: the map is what the executor skips rather than re-running. */
  private finishedSteps(runId: string): Map<string, { state: 'completed' | 'skipped'; value: unknown }> {
    const rows = this.deps.db.prepare("SELECT step_id, state, output_json FROM run_steps WHERE run_id = ? AND state IN ('completed', 'skipped') AND parent_step_id IS NULL")
      .all(runId) as { step_id: string; state: 'completed' | 'skipped'; output_json: string | null }[];
    // A step the human rejected is finished only in the database's opinion: it re-runs with their feedback.
    const rejected = new Set(this.reviews.rejectedFor(runId).map((r) => r.step_id));
    return new Map(rows.filter((r) => !rejected.has(r.step_id)).map((r) => [r.step_id, { state: r.state, value: r.output_json ? (JSON.parse(r.output_json) as unknown) : null }]));
  }

  waitFor(runId: string): Promise<void> {
    return this.inflight.get(runId)?.done ?? Promise.resolve();
  }

  // ---- finishing -----------------------------------------------------------------------------------------

  private finish(runId: string, state: 'completed' | 'cancelled', spent: Spent, extra: { outputs?: Record<string, unknown> }): void {
    const at = new Date().toISOString();
    this.deps.db.prepare('UPDATE runs SET state = ?, outputs_json = ?, spent_json = ?, finished_at = ? WHERE id = ?')
      .run(state, extra.outputs ? this.persist(extra.outputs) : null, this.persist(spent), at, runId);
    if (state !== 'completed') return;
    this.deps.events.append(runId, null, 'run-completed', { outputs: extra.outputs ?? {}, spent });
    // Only a scheduled run is worth a buzz on completion: a run you started yourself, you are already watching.
    if (this.scheduled.delete(runId)) this.nudge('scheduled-run-completed', { id: runId, runId });
  }

  /** Runs the scheduler started, so completion can be told apart from a run the human is sitting in front of. */
  private readonly scheduled = new Set<string>();

  markScheduled(runId: string): void {
    this.scheduled.add(runId);
  }

  private fail(runId: string, e: unknown, spent: Spent, cancelled: boolean): void {
    const at = new Date().toISOString();
    const reason = reasonOf(e);
    if (cancelled || reason === 'cancelled') {
      this.deps.db.prepare("UPDATE runs SET state = 'cancelled', spent_json = ?, finished_at = ? WHERE id = ?").run(this.persist(spent), at, runId);
      this.deps.db.prepare("UPDATE run_steps SET state = 'cancelled', finished_at = ? WHERE run_id = ? AND state IN ('running', 'pending')").run(at, runId);
      this.deps.events.append(runId, null, 'run-cancelled', { by: 'human', spent });
      return;
    }
    const error = e instanceof StepFailure || e instanceof WorkflowFailure ? e.detail : { message: String((e as Error)?.message ?? e) };
    const payload = {
      reason,
      message: (e as Error)?.message ?? String(e),
      ...(e instanceof WorkflowFailure && e.stepId ? { stepId: e.stepId } : {}),
      error,
    };
    this.deps.db.prepare("UPDATE runs SET state = 'failed', spent_json = ?, finished_at = ?, error_json = ? WHERE id = ?")
      .run(this.persist(spent), at, this.persist(payload), runId);
    this.deps.db.prepare("UPDATE run_steps SET state = 'cancelled', finished_at = ? WHERE run_id = ? AND state IN ('running', 'pending')").run(at, runId);
    this.deps.events.append(runId, null, 'run-failed', payload);
    this.nudge('run-failed', { id: runId, runId });
  }

  // ---- reads ---------------------------------------------------------------------------------------------

  /** What an evaluator needs from a finished run: its output, what it cost, and whether it retrieved anything. */
  private evaluationDetail(runId: string): { state: string; output: string | null; costUsd: number; latencyMs: number; tokensIn: number; tokensOut: number; error: string | null; usedKnowledge: boolean } | null {
    const run = this.getRun(runId);
    if (!run) return null;
    // Tokens live inside `usage_json`; SQLite reads them out with json_extract rather than the runtime parsing
    // every row to add two numbers.
    const usage = this.deps.db.prepare(`SELECT
        COALESCE(SUM(json_extract(usage_json, '$.input')), 0) AS tin,
        COALESCE(SUM(json_extract(usage_json, '$.output')), 0) AS tout,
        COALESCE(SUM(latency_ms), 0) AS ms
      FROM model_calls WHERE run_id = ?`).get(runId) as { tin: number; tout: number; ms: number };
    const knowledge = this.deps.db.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE run_id = ? AND tool = 'knowledge.search' AND ok = 1").get(runId) as { n: number };
    const output = run.outputs?.['output'];
    return {
      state: run.state,
      output: typeof output === 'string' ? output : run.outputs ? JSON.stringify(run.outputs) : null,
      costUsd: run.spent.costUsd,
      latencyMs: usage.ms,
      tokensIn: usage.tin,
      tokensOut: usage.tout,
      error: run.error ? (typeof run.error === 'string' ? run.error : JSON.stringify(run.error)) : null,
      usedKnowledge: knowledge.n > 0,
    };
  }

  getRun(id: string): RunDetail | null {
    const row = this.deps.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
    if (!row) return null;
    const steps = this.deps.db.prepare('SELECT step_id, kind, state, model_id, parent_step_id, map_index, cost_usd, started_at, finished_at FROM run_steps WHERE run_id = ? ORDER BY COALESCE(started_at, \'~\'), step_id').all(id) as StepRow[];
    return {
      ...this.summary(row),
      inputs: JSON.parse(row.inputs_json) as Record<string, unknown>,
      ...(row.outputs_json ? { outputs: JSON.parse(row.outputs_json) as Record<string, unknown> } : {}),
      ...(row.error_json ? { error: JSON.parse(row.error_json) as unknown } : {}),
      steps: steps.map((s) => ({
        stepId: s.step_id, kind: s.kind, state: s.state, modelId: s.model_id, costUsd: s.cost_usd,
        parentStepId: s.parent_step_id, mapIndex: s.map_index, startedAt: s.started_at, finishedAt: s.finished_at,
      })),
    };
  }

  listRuns(filter: { state?: string | undefined; kind?: string | undefined; project?: string | undefined; limit?: number | undefined } = {}): RunSummary[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.state) { clauses.push('state = ?'); params.push(filter.state); }
    if (filter.kind) { clauses.push('kind = ?'); params.push(filter.kind); }
    if (filter.project) { clauses.push('project_id = ?'); params.push(filter.project); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.deps.db.prepare(`SELECT * FROM runs ${where} ORDER BY started_at DESC LIMIT ?`).all(...params, filter.limit ?? 100) as RunRow[];
    return rows.map((r) => this.summary(r));
  }

  /** What every model call has cost since local midnight, for the daily cap (D-14). */
  spentTodayUsd(): number {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const row = this.deps.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM model_calls WHERE ts >= ?').get(midnight.toISOString()) as { total: number };
    return row.total;
  }

  private summary(row: RunRow): RunSummary {
    return {
      id: row.id, kind: row.kind as RunSummary['kind'], state: row.state,
      ...(row.agent_id ? { agentId: row.agent_id } : {}), ...(row.workflow_id ? { workflowId: row.workflow_id } : {}), ...(row.project_id ? { project: row.project_id } : {}),
      startedAt: row.started_at, ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
      spent: JSON.parse(row.spent_json) as Spent,
      budgets: JSON.parse(row.budgets_json) as RunSummary['budgets'],
    };
  }

  // ---- versions ------------------------------------------------------------------------------------------

  private persist(value: unknown): string {
    return this.deps.redactor.redactJson(value);
  }

  private recordAgentVersion(agent: LoadedAgent, at: string): void {
    this.deps.db.prepare('INSERT OR IGNORE INTO agent_versions (hash, agent_id, definition_json, created_at) VALUES (?, ?, ?, ?)')
      .run(agent.version, agent.definition.id, this.persist({ definition: agent.definition, sections: agent.sections }), at);
  }

  private recordWorkflowVersion(workflow: LoadedWorkflow, at: string): void {
    this.deps.db.prepare('INSERT OR IGNORE INTO workflow_versions (hash, workflow_id, definition_json, created_at) VALUES (?, ?, ?, ?)')
      .run(workflow.version, workflow.definition.id, this.persist(workflow.definition), at);
  }

  /** Every agent a workflow could reach, so the run's provenance holds their versions even if a step is skipped. */
  private agentsOf(workflow: LoadedWorkflow): LoadedAgent[] {
    const ws = this.deps.workspace();
    const ids = new Set<string>();
    const walk = (step: { kind: string; agent?: string; step?: unknown }): void => {
      if (step.kind === 'agent' && step.agent) ids.add(step.agent);
      if (step.kind === 'map' && step.step) walk(step.step as { kind: string; agent?: string });
    };
    for (const step of workflow.definition.steps) walk(step);
    return [...ids].map((id) => ws.agents.get(id)).filter((a): a is LoadedAgent => a !== undefined);
  }
}

const EMPTY_SPENT: Spent = { modelCalls: 0, toolCalls: 0, costUsd: 0, wallClockMs: 0 };
const ACTIVE_STATES = new Set<RunState>(['queued', 'running', 'waiting_review', 'waiting_approval']);
const RESUMABLE_STATES = new Set<RunState>(['interrupted', 'waiting_review', 'failed']);

function round(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

function reasonOf(e: unknown): string {
  if (e instanceof StepFailure) return e.reason;
  if (e instanceof WorkflowFailure) return e.reason;
  return 'error';
}
