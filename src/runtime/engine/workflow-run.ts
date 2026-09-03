// The DAG executor (D-11). Independent steps run in parallel up to `execution.maxParallelSteps`; a `map` runs
// its item steps up to the map's own `concurrency`; the first failure aborts its siblings and fails the run.
import type { Db } from '../db/index.js';
import type { Workspace } from '../workspace/loader.js';
import type { ArtifactStore } from '../artifacts/store.js';
import type { Logger } from '../log/index.js';
import type { EventStore } from './events.js';
import type { RunBudget } from './budget.js';
import { StepFailure, type StepOutcome, type StepRunner } from './step.js';
import { evaluate, parseExpr, ReferenceError_, truthy, type Scope } from '../../shared/expr.js';
import { renderTemplate } from '../../shared/template.js';
import { mapItemStepId, validateWorkflow, type LoadedWorkflow, type MapStep, type Step } from '../../shared/workflow.js';
import type { LoadedAgent } from '../../shared/agent.js';

export interface WorkflowDeps {
  db: Db;
  events: EventStore;
  workspace: () => Workspace;
  log: Logger;
  artifacts?: ArtifactStore | undefined;
  steps: StepRunner;
}

export interface WorkflowRunInput {
  runId: string;
  workflow: LoadedWorkflow;
  inputs: Record<string, unknown>;
  project?: string | undefined;
  provider?: 'mock' | undefined;
  budget: RunBudget;
  signal: AbortSignal;
}

export interface WorkflowResult {
  outputs: Record<string, unknown>;
}

/** A step ended the run: the reason and the step that caused it, so the run's error names both. */
export class WorkflowFailure extends Error {
  constructor(readonly stepId: string, readonly reason: string, readonly detail: unknown, message: string) {
    super(message);
    this.name = 'WorkflowFailure';
  }
}

type StepState = 'pending' | 'running' | 'skipped' | 'completed' | 'failed' | 'cancelled';

export class WorkflowExecutor {
  constructor(private readonly deps: WorkflowDeps) {}

  async run(input: WorkflowRunInput): Promise<WorkflowResult> {
    const { definition } = input.workflow;
    const { edges } = validateWorkflow(definition);
    const state = new Map<string, StepState>(definition.steps.map((s) => [s.id, 'pending']));
    const outputs = new Map<string, unknown>();

    // Every step gets its row before anything runs, so the graph is complete from the first frame.
    for (const step of definition.steps) this.seedRow(input.runId, step);

    // A step failure aborts its siblings; a cancel from outside does the same, one level up.
    const controller = new AbortController();
    const relay = () => controller.abort();
    input.signal.addEventListener('abort', relay, { once: true });

    const maxParallel = Math.max(1, this.deps.workspace().config.execution.maxParallelSteps);
    const running = new Map<string, Promise<void>>();
    let failure: WorkflowFailure | null = null;

    try {
      while (state.size > [...state.values()].filter((s) => s !== 'pending' && s !== 'running').length) {
        if (failure) break;
        const ready = definition.steps.filter((step) =>
          state.get(step.id) === 'pending' &&
          [...(edges.get(step.id) ?? [])].every((d) => settled(state.get(d))),
        );

        for (const step of ready) {
          if (running.size >= maxParallel) break;
          if (failure) break;
          // A dependency that failed means this step can never run; a cancelled sibling means the same.
          const blocked = [...(edges.get(step.id) ?? [])].find((d) => state.get(d) === 'failed' || state.get(d) === 'cancelled');
          if (blocked) { state.set(step.id, 'cancelled'); this.markRow(input.runId, step.id, 'cancelled'); continue; }

          state.set(step.id, 'running');
          running.set(step.id, this.execute(input, step, () => this.scopeFor(input, outputs), controller.signal)
            .then((result) => {
              if (result.skipped) {
                state.set(step.id, 'skipped');
                outputs.set(step.id, null);
              } else {
                state.set(step.id, 'completed');
                outputs.set(step.id, result.value);
              }
            })
            .catch((e: unknown) => {
              const wf = asWorkflowFailure(step.id, e);
              state.set(step.id, wf.reason === 'cancelled' ? 'cancelled' : 'failed');
              failure ??= wf;
              controller.abort(); // the first failure stops the siblings (workflows-and-execution.md §Semantics)
            })
            .finally(() => { running.delete(step.id); }));
        }

        if (!running.size) {
          if (ready.length === 0 && [...state.values()].some((s) => s === 'pending')) {
            // Nothing is running and nothing is ready: every remaining step depends on one that never settled.
            for (const [id, s] of state) if (s === 'pending') { state.set(id, 'cancelled'); this.markRow(input.runId, id, 'cancelled'); }
          }
          if (!failure) continue;
          break;
        }
        await Promise.race(running.values());
      }
      await Promise.allSettled(running.values());
    } finally {
      input.signal.removeEventListener('abort', relay);
    }

    if (failure) throw failure;
    if (input.signal.aborted) throw new WorkflowFailure('', 'cancelled', null, 'the run was cancelled');

    return { outputs: this.renderOutputs(input, outputs) };
  }

  // ---- one step ------------------------------------------------------------------------------------------

  private async execute(input: WorkflowRunInput, step: Step, scope: () => Scope, signal: AbortSignal): Promise<{ skipped: boolean; value: unknown }> {
    if (step.when !== undefined) {
      const keep = truthy(evaluate(parseExpr(step.when), scope()));
      if (!keep) {
        this.deps.events.append(input.runId, step.id, 'step-skipped', { stepId: step.id, kind: step.kind, when: step.when });
        this.markRow(input.runId, step.id, 'skipped');
        return { skipped: true, value: null };
      }
    }

    const attempts = step.retries + 1;
    let last: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const value = step.kind === 'map'
          ? await this.runMap(input, step, scope, signal)
          : (await this.runAgent(input, step, step.id, scope(), signal, undefined, undefined)).value;
        return { skipped: false, value };
      } catch (e) {
        last = e;
        // Retries are for a step that could plausibly go differently; a cancel or a spent budget cannot.
        if (!retryable(e) || attempt === attempts) break;
        this.deps.log.warn({ runId: input.runId, step: step.id, attempt }, 'step failed; retrying');
      }
    }
    throw last;
  }

  private async runAgent(
    input: WorkflowRunInput, step: Step, stepId: string, scope: Scope, signal: AbortSignal,
    parentStepId: string | undefined, mapIndex: number | undefined,
  ): Promise<StepOutcome> {
    if (step.kind !== 'agent') throw new WorkflowFailure(stepId, 'unsupported', null, `step "${stepId}" is a ${step.kind} step, which this runtime cannot execute yet`);
    const agent = this.requireAgent(stepId, step.agent);
    const task = asTask(renderTemplate(step.input, scope));
    const model = step.model ? String(renderTemplate(step.model, scope)) : undefined;
    const document = step.output?.document ? String(renderTemplate(step.output.document, scope)) : undefined;

    return this.deps.steps.runAgentStep({
      runId: input.runId,
      stepId,
      agent,
      task,
      ...(input.project ? { project: input.project } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(model ? { modelOverride: model } : {}),
      ...(step.outputSchema ? { outputSchema: step.outputSchema } : {}),
      ...(document ? { documentPath: document } : {}),
      budget: input.budget.child(step.budget),
      signal,
      workflow: {
        id: input.workflow.definition.id,
        stepId,
        upstream: step.dependsOn,
        downstream: input.workflow.definition.steps.filter((s) => s.dependsOn.includes(step.id)).map((s) => s.id),
      },
      ...(parentStepId ? { parentStepId } : {}),
      ...(mapIndex !== undefined ? { mapIndex } : {}),
    });
  }

  /** `map` runs its inner step once per item, `concurrency` at a time; the output is an array in item order. */
  private async runMap(input: WorkflowRunInput, step: MapStep, scope: () => Scope, signal: AbortSignal): Promise<unknown[]> {
    const over = evaluate(parseExpr(step.over), scope());
    if (!Array.isArray(over)) {
      throw new WorkflowFailure(step.id, 'template_error', { over: step.over },
        `\`over\` on step "${step.id}" is ${describe(over)}, and a map needs a list. Check what "${step.over}" produces.`);
    }
    this.deps.events.append(input.runId, step.id, 'step-started', { stepId: step.id, kind: 'map', items: over.length, concurrency: step.concurrency });
    this.markRow(input.runId, step.id, 'running', 'map');

    const results = new Array<unknown>(over.length);
    let next = 0;
    let firstError: unknown = null;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++;
        if (index >= over.length || firstError || signal.aborted) return;
        const itemId = mapItemStepId(step.id, index);
        this.seedRow(input.runId, step.step, itemId, step.id, index);
        try {
          const outcome = await this.runAgent(input, step.step, itemId, { ...scope(), item: over[index] }, signal, step.id, index);
          results[index] = outcome.value;
        } catch (e) {
          firstError ??= e;
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(step.concurrency, over.length) }, worker));
    if (firstError) { this.markRow(input.runId, step.id, 'failed'); throw firstError; }

    this.deps.db.prepare('UPDATE run_steps SET state = ?, output_json = ?, finished_at = ? WHERE run_id = ? AND step_id = ?')
      .run('completed', JSON.stringify(results), new Date().toISOString(), input.runId, step.id);
    this.deps.events.append(input.runId, step.id, 'step-completed', { stepId: step.id, kind: 'map', items: results.length });
    return results;
  }

  // ---- scope ---------------------------------------------------------------------------------------------

  /**
   * What `{{ … }}` and `when` can see. `project.documents[...]` reads through to the Library on demand, so a
   * workflow can quote a document without the executor loading every document in the project first.
   */
  private scopeFor(input: WorkflowRunInput, outputs: Map<string, unknown>): Scope {
    const steps: Record<string, { output: unknown }> = {};
    for (const [id, value] of outputs) steps[id] = { output: value };
    return {
      inputs: input.inputs,
      steps,
      project: { slug: input.project ?? null, documents: this.documentsProxy(input.project) },
      run: { id: input.runId },
    };
  }

  private documentsProxy(project: string | undefined): Record<string, string> {
    const artifacts = this.deps.artifacts;
    const read = (path: string): string | null => (artifacts && project ? artifacts.readDocument(project, path) : null);
    return new Proxy({} as Record<string, string>, {
      has: (_t, key) => typeof key === 'string' && read(key) !== null,
      get: (_t, key) => (typeof key === 'string' ? read(key) ?? undefined : undefined),
      ownKeys: () => [],
      getOwnPropertyDescriptor: () => ({ enumerable: false, configurable: true }),
    });
  }

  private renderOutputs(input: WorkflowRunInput, outputs: Map<string, unknown>): Record<string, unknown> {
    const scope = this.scopeFor(input, outputs);
    const out: Record<string, unknown> = {};
    for (const [name, template] of Object.entries(input.workflow.definition.outputs)) {
      try {
        out[name] = renderTemplate(template, scope);
      } catch (e) {
        if (!(e instanceof ReferenceError_)) throw e;
        // A skipped step's output is legitimately absent; the run should still report the rest.
        out[name] = null;
        this.deps.log.warn({ runId: input.runId, output: name, err: e }, 'a workflow output could not be rendered');
      }
    }
    return out;
  }

  private requireAgent(stepId: string, agentId: string): LoadedAgent {
    const ws = this.deps.workspace();
    const agent = ws.agents.get(agentId);
    if (agent) return agent;
    const broken = ws.brokenAgents.find((b) => b.id === agentId);
    throw new WorkflowFailure(stepId, 'agent_unavailable', { agentId },
      broken ? `Step "${stepId}" needs agent "${agentId}", which failed to load: ${broken.message}` : `Step "${stepId}" names agent "${agentId}", which does not exist in this workspace.`);
  }

  // ---- rows ----------------------------------------------------------------------------------------------

  private seedRow(runId: string, step: Step, stepId = step.id, parentStepId?: string, mapIndex?: number): void {
    this.deps.db.prepare(`INSERT INTO run_steps (run_id, step_id, kind, parent_step_id, map_index, state)
      VALUES (?, ?, ?, ?, ?, 'pending') ON CONFLICT(run_id, step_id) DO NOTHING`)
      .run(runId, stepId, step.kind, parentStepId ?? null, mapIndex ?? null);
  }

  private markRow(runId: string, stepId: string, state: StepState, kind?: string): void {
    const now = new Date().toISOString();
    if (state === 'running') {
      this.deps.db.prepare('UPDATE run_steps SET state = ?, kind = COALESCE(?, kind), started_at = ? WHERE run_id = ? AND step_id = ?')
        .run(state, kind ?? null, now, runId, stepId);
      return;
    }
    this.deps.db.prepare('UPDATE run_steps SET state = ?, finished_at = ? WHERE run_id = ? AND step_id = ?').run(state, now, runId, stepId);
  }
}

function settled(state: StepState | undefined): boolean {
  return state === 'completed' || state === 'skipped';
}

/** A step's output as the next step's first user message. Objects and arrays go as JSON, per Template rules. */
function asTask(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  return `a ${typeof value}`;
}

function retryable(e: unknown): boolean {
  if (e instanceof StepFailure) return e.reason === 'model_error' || e.reason === 'schema_validation';
  return e instanceof WorkflowFailure ? false : true;
}

function asWorkflowFailure(stepId: string, e: unknown): WorkflowFailure {
  if (e instanceof WorkflowFailure) return e;
  if (e instanceof StepFailure) return new WorkflowFailure(stepId, e.reason, e.detail, e.message);
  return new WorkflowFailure(stepId, 'step_failed', { message: String((e as Error)?.message ?? e) }, String((e as Error)?.message ?? e));
}
