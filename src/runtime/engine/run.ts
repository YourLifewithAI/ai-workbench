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
import type { RunDetail, RunSummary } from '../../shared/api/index.js';
import type { RunState, Spent } from '../../shared/events.js';
import type { LoadedAgent } from '../../shared/agent.js';
import type { LoadedWorkflow } from '../../shared/workflow.js';
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
}

/** One human decision, handed to whichever run is parked behind it. */
interface GateDecision { decision: ReviewDecision; feedback?: string | undefined }

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
  readonly reviews: ReviewStore;

  constructor(private readonly deps: EngineDeps) {
    this.reviews = new ReviewStore(deps.db);
    this.steps = new StepRunner({
      db: deps.db, events: deps.events, workspace: deps.workspace, registry: deps.registry,
      credentials: deps.credentials, redactor: deps.redactor, log: deps.log,
      fetch: deps.fetch, runtimePort: deps.runtimePort, artifacts: deps.artifacts,
    });
    this.workflows = new WorkflowExecutor({
      db: deps.db, events: deps.events, workspace: deps.workspace, log: deps.log,
      artifacts: deps.artifacts, steps: this.steps, review: this.reviewHost(),
    });
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

        const decision = await this.waitForReview(row.id, signal);
        this.deps.db.prepare("UPDATE runs SET state = 'running' WHERE id = ?").run(runId);
        this.deps.events.append(runId, stepId, 'review-decided', {
          reviewId: row.id, decision: decision.decision, feedback: decision.feedback ?? null, attempt: row.attempt,
        });

        // A third rejection would be a conversation, not a gate: the run carries on with what it has.
        if (decision.decision === 'reject' && row.attempt <= MAX_REJECTIONS) return { redo: decision.feedback ?? '' };
        return null;
      },
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
    this.deps.db.prepare(`INSERT INTO runs (id, kind, state, agent_version, agent_id, project_id, depth, inputs_json, budgets_json, spent_json, started_at)
      VALUES (?, 'agent', 'running', ?, ?, ?, 0, ?, ?, ?, ?)`)
      .run(runId, agent.version, agent.definition.id, input.project ?? null, this.persist(input.inputs), this.persist(budgets), this.persist(EMPTY_SPENT), now);
    this.recordAgentVersion(agent, now);
    this.deps.events.append(runId, null, 'run-started', {
      kind: 'agent', agentId: agent.definition.id, agentVersion: agent.version, inputs: input.inputs,
      project: input.project ?? null, budgets, provider: input.provider ?? this.deps.providerOverride ?? null,
    });

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
          budget, signal,
        });
        const again = await host.afterStep({
          runId, stepId: 'main', blocking: agent.definition.review === 'blocking',
          ...(outcome.versionId ? { versionId: outcome.versionId } : {}), signal,
        });
        if (!again) return { output: outcome.output };
        feedback = again.redo;
      }
    });
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

    return this.schedule(runId, budgets, now, async (budget, signal) => {
      const result = await this.workflows.run({
        runId, workflow, inputs,
        ...(project ? { project } : {}),
        ...(input.provider ?? this.deps.providerOverride ? { provider: (input.provider ?? this.deps.providerOverride) as 'mock' } : {}),
        budget, signal,
      });
      return result.outputs;
    });
  }

  // ---- the queue -----------------------------------------------------------------------------------------

  /**
   * `execution.maxConcurrentRuns` runs at a time; the rest sit in `queued` until a slot frees. The promise a
   * caller gets back covers the whole wait, so a blocking CLI run behaves the same queued or not.
   */
  private schedule(runId: string, budgets: ReturnType<typeof narrowBudgets>, startedAt: string, body: (budget: RunBudget, signal: AbortSignal) => Promise<Record<string, unknown>>): { runId: string; done: Promise<void> } {
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
    const queued = runningNow >= limit;

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
      .finally(() => { this.inflight.delete(runId); this.drain(); });

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
    return new Map(rows.map((r) => [r.step_id, { state: r.state, value: r.output_json ? (JSON.parse(r.output_json) as unknown) : null }]));
  }

  waitFor(runId: string): Promise<void> {
    return this.inflight.get(runId)?.done ?? Promise.resolve();
  }

  // ---- finishing -----------------------------------------------------------------------------------------

  private finish(runId: string, state: 'completed' | 'cancelled', spent: Spent, extra: { outputs?: Record<string, unknown> }): void {
    const at = new Date().toISOString();
    this.deps.db.prepare('UPDATE runs SET state = ?, outputs_json = ?, spent_json = ?, finished_at = ? WHERE id = ?')
      .run(state, extra.outputs ? this.persist(extra.outputs) : null, this.persist(spent), at, runId);
    if (state === 'completed') this.deps.events.append(runId, null, 'run-completed', { outputs: extra.outputs ?? {}, spent });
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
  }

  // ---- reads ---------------------------------------------------------------------------------------------

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

function reasonOf(e: unknown): string {
  if (e instanceof StepFailure) return e.reason;
  if (e instanceof WorkflowFailure) return e.reason;
  return 'error';
}
