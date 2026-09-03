// One agent step, from candidate selection to a committed output. Shared by single-agent runs and by every
// step of a workflow, so both get the same retries, fallback, budgets, wrap-up turn and trace shape.
import { ulid } from 'ulid';
import type { Db } from '../db/index.js';
import type { Workspace } from '../workspace/loader.js';
import type { AdapterContext, AdapterRegistry, FetchLike, ModelAdapter } from '../models/adapter.js';
import { createEgressFetch, type EgressAttempt, type EgressDecision } from '../security/egress.js';
import { computeCost } from '../models/catalog.js';
import { dropForeignReasoning, selectCandidates } from './selection.js';
import type { ArtifactStore } from '../artifacts/store.js';
import { directFetch } from '../models/fetch.js';
import { ModelError, ModelUnavailableError, NetworkPolicyError, modelError } from '../models/errors.js';
import type { Credentials } from '../security/credentials.js';
import type { Redactor } from '../security/redaction.js';
import type { Logger } from '../log/index.js';
import type { EventStore } from './events.js';
import { assemblePrompt, type KnowledgeDocument } from './prompt.js';
import { harnessSection } from './harness.js';
import { WRAP_UP_INSTRUCTION } from './budget.js';
import type { RunBudget } from './budget.js';
import { parseJsonOutput, validateJson } from '../../shared/jsonschema.js';
import type { CatalogEntry, CompiledRequest, ContentBlock, JsonSchema, Message, ModelErrorShape, ModelResponse } from '../../shared/model.js';
import type { LoadedAgent } from '../../shared/agent.js';

/** Two retries after the first attempt, per model, when the error says `retry` (model-layer.md §Errors). */
export const MAX_ATTEMPTS_PER_MODEL = 3;
const RETRY_BACKOFF_MS = 200;
/** One repair turn for a schema violation before `retries` re-runs the whole step (workflows-and-execution.md). */
const MAX_REPAIR_TURNS = 1;

export type StepFailureReason =
  | 'model_unavailable' | 'network_policy' | 'model_error' | 'schema_validation'
  | 'budget_exceeded' | 'wall_clock_exceeded' | 'daily_cap_reached' | 'cancelled';

/** A step that ended without an output. `outcome` is set when a wrap-up turn produced a partial one. */
export class StepFailure extends Error {
  constructor(readonly reason: StepFailureReason, readonly detail: unknown, message: string, readonly outcome?: StepOutcome) {
    super(message);
    this.name = 'StepFailure';
  }
}

export interface StepDeps {
  db: Db;
  events: EventStore;
  workspace: () => Workspace;
  registry: AdapterRegistry;
  credentials: Credentials;
  redactor: Redactor;
  log: Logger;
  /** The fetch the egress checker wraps. Tests pass a replay; production passes the real one. */
  fetch?: FetchLike | undefined;
  /** The runtime's own port, refused as a destination in every mode. */
  runtimePort?: (() => number | null) | undefined;
  artifacts?: ArtifactStore | undefined;
}

export interface AgentStepInput {
  runId: string;
  stepId: string;
  agent: LoadedAgent;
  /** The first user message: an agent run's input, or a workflow step's rendered `input` template. */
  task: string;
  project?: string | undefined;
  provider?: 'mock' | undefined;
  /** Replaces the agent's primary and keeps its fallbacks (workflows-and-execution.md §Names). */
  modelOverride?: string | undefined;
  /** The step's schema, else the agent's `output.schema`. */
  outputSchema?: JsonSchema | undefined;
  /** Where the output is filed. Omitted means the agent's default; `null` means file nothing. */
  documentPath?: string | null | undefined;
  budget: RunBudget;
  signal: AbortSignal;
  workflow?: { id: string; stepId: string; upstream: string[]; downstream: string[] } | undefined;
  parentStepId?: string | undefined;
  mapIndex?: number | undefined;
}

export interface StepOutcome {
  /** The final text. */
  output: string;
  /** The parsed, validated JSON when a schema applies — what `steps.<id>.output` resolves to (D-11). */
  value: unknown;
  modelId: string;
  costUsd: number;
  /** True when the output came from a wrap-up turn rather than the agent finishing (D-14). */
  partial: boolean;
}

export class StepRunner {
  constructor(private readonly deps: StepDeps) {}

  async runAgentStep(input: AgentStepInput): Promise<StepOutcome> {
    const { runId, stepId, agent } = input;
    this.beginStepRow(input);

    const candidates = this.candidatesFor(input);
    this.deps.events.append(runId, stepId, 'step-started', {
      stepId, kind: 'agent', agentId: agent.definition.id, agentVersion: agent.version,
      modelCandidates: candidates.map((c) => c.entry.id),
      ...(input.parentStepId ? { parentStepId: input.parentStepId, mapIndex: input.mapIndex ?? null } : {}),
    });

    try {
      const outcome = await this.loop(input, candidates);
      this.completeStepRow(input, outcome, 'completed');
      return outcome;
    } catch (e) {
      if (e instanceof StepFailure) {
        // A wrap-up turn still produced something; file it as partial before the step is called failed.
        if (e.outcome) this.commitDocument(input, e.outcome, true);
        this.failStepRow(input, e);
        throw e;
      }
      const failure = new StepFailure('model_error', toShape(e), (e as Error).message);
      this.failStepRow(input, failure);
      throw failure;
    }
  }

  // ---- the loop ------------------------------------------------------------------------------------------

  private async loop(input: AgentStepInput, candidates: Candidate[]): Promise<StepOutcome> {
    const { agent, budget, signal } = input;
    const schema = input.outputSchema ?? agent.definition.output.schema;
    const knowledge = this.knowledgeFor(agent, input.project);
    const transcript: Message[] = [{ role: 'user', content: [{ type: 'text', text: input.task }] }];
    let repairs = 0;
    let wrapUp = false;

    for (;;) {
      if (signal.aborted) throw new StepFailure('cancelled', null, 'the run was cancelled');

      if (!wrapUp) {
        const stop = budget.checkBeforeModelCall();
        if (stop) {
          // Soft budgets buy one last turn: no tools, summarise. Hard stops (time, daily cap) end it here.
          if (!stop.allowWrapUp || !budget.takeWrapUp()) {
            throw new StepFailure(stop.reason, { budget: stop.budget }, stop.message);
          }
          this.deps.events.append(input.runId, input.stepId, 'budget-warning', { budget: stop.budget, wrapUp: true, message: stop.message });
          wrapUp = true;
        }
      }

      const prompt = assemblePrompt(agent, input.task, this.harnessFor(input, wrapUp), { knowledge });
      const request: CompiledRequest = {
        ...prompt.compiled,
        messages: transcript,
        tools: [], // RUN-06 fills this from the agent's grant; the wrap-up turn always sends none.
        ...(schema ? { outputSchema: schema } : {}),
      };
      const { response, entry } = await this.callWithFallback(input, candidates, request, prompt.promptVersion);

      for (const warning of budget.newWarnings()) {
        this.deps.events.append(input.runId, input.stepId, 'budget-warning', {
          budget: warning.budget, used: warning.used, limit: warning.limit,
          message: `This run has used ${warning.used} of its ${warning.limit} ${warning.budget}.`,
        });
      }

      transcript.push({ role: 'assistant', content: response.content });
      const calls = response.content.filter((b): b is Extract<ContentBlock, { type: 'tool-call' }> => b.type === 'tool-call');

      // The tool loop is in place before tools exist (RUN-06): a call to a tool the agent does not have comes
      // back as a failed result the model can read, never as a crash.
      if (calls.length && !wrapUp) {
        transcript.push({ role: 'tool', content: calls.map((call) => this.refuseTool(input, call)) });
        continue;
      }

      const text = textOf(response.content);
      if (!schema) return { output: text, value: text, modelId: entry.id, costUsd: 0, partial: wrapUp };

      const problems = validateAgainst(text, schema);
      if (!problems) {
        const parsed = parseJsonOutput(text);
        return { output: text, value: parsed.ok ? parsed.value : text, modelId: entry.id, costUsd: 0, partial: wrapUp };
      }
      if (wrapUp || repairs >= MAX_REPAIR_TURNS) {
        const failure = new StepFailure('schema_validation', { problems }, `The output does not match this step's schema: ${problems.join('; ')}.`,
          wrapUp ? { output: text, value: text, modelId: entry.id, costUsd: 0, partial: true } : undefined);
        throw failure;
      }
      repairs += 1;
      transcript.push({ role: 'user', content: [{ type: 'text', text: repairInstruction(problems) }] });
    }
  }

  private refuseTool(input: AgentStepInput, call: Extract<ContentBlock, { type: 'tool-call' }>): ContentBlock {
    input.budget.recordToolCall();
    this.deps.events.append(input.runId, input.stepId, 'tool-requested', { callId: call.id, tool: call.name, input: call.input });
    const output = { error: { code: 'UnknownTool', message: `There is no tool called "${call.name}". Continue without it, and say so if it matters.` } };
    this.deps.events.append(input.runId, input.stepId, 'tool-completed', { callId: call.id, tool: call.name, ok: false, output });
    return { type: 'tool-result', callId: call.id, ok: false, output };
  }

  private harnessFor(input: AgentStepInput, wrapUp: boolean): string {
    const ws = this.deps.workspace();
    return harnessSection({
      agentId: input.agent.definition.id,
      runId: input.runId,
      ...(input.workflow ? { workflow: input.workflow } : {}),
      tools: [],
      budgetLine: input.budget.remainingLine(),
      scratchDir: `runs/${input.runId}`,
      retentionDays: ws.config.retention.scratchDays,
      review: input.agent.definition.review,
      ...(this.documentPathFor(input) ? { documentPath: this.documentPathFor(input)! } : {}),
      ...(wrapUp ? { wrapUp: WRAP_UP_INSTRUCTION } : {}),
    });
  }

  // ---- model calls ---------------------------------------------------------------------------------------

  /** Walks the candidates: retries on the same model while the error says so, then falls back to the next. */
  private async callWithFallback(input: AgentStepInput, candidates: Candidate[], request: CompiledRequest, promptVersion: string): Promise<{ response: ModelResponse; entry: CatalogEntry }> {
    const { runId, stepId, agent, budget, signal } = input;
    let lastShape: ModelErrorShape | null = null;

    for (let index = 0; index < candidates.length; index++) {
      const { entry, adapterId } = candidates[index]!;
      const adapter = this.deps.registry.get(adapterId)!;
      // A cross-provider move drops reasoning that only its own provider can read back (D-02 leak 1).
      const { messages, dropped } = dropForeignReasoning(request.messages, adapterId);
      if (dropped) this.deps.events.append(runId, stepId, 'provider-meta-dropped', { modelId: entry.id, droppedBlocks: dropped });
      const compiled: CompiledRequest = { ...request, messages };

      for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt++) {
        if (signal.aborted) throw new StepFailure('cancelled', null, 'the run was cancelled');
        this.deps.events.append(runId, stepId, 'model-started', { modelId: entry.id, adapter: adapterId, attempt, request: compiled });
        const t0 = Date.now();
        try {
          const response = await this.callModel(adapter, entry, compiled, signal, runId, stepId);
          const at = new Date();
          const costUsd = computeCost(entry, response.usage, at);
          budget.recordModelCall(costUsd);
          this.recordCall(runId, stepId, entry, adapterId, promptVersion, agent.version, response, costUsd, Date.now() - t0, at);
          this.deps.events.append(runId, stepId, 'model-completed', {
            modelId: entry.id, response, usage: response.usage, costUsd, latencyMs: Date.now() - t0,
            promptVersion, agentVersion: agent.version, spent: budget.snapshot(),
          });
          return { response, entry };
        } catch (e) {
          if (e instanceof StepFailure) throw e;
          if (signal.aborted) throw new StepFailure('cancelled', null, 'the run was cancelled');
          const shape = toShape(e);
          lastShape = shape;
          budget.recordModelCall(0);
          this.recordFailedCall(runId, stepId, entry, adapterId, promptVersion, agent.version, shape, Date.now() - t0);
          this.deps.events.append(runId, stepId, 'model-aborted', { modelId: entry.id, reason: shape.code, attempt, error: shape });

          if (shape.action === 'abort') throw new StepFailure('model_error', shape, shape.message);
          if (shape.action === 'retry' && attempt < MAX_ATTEMPTS_PER_MODEL) {
            await sleep(RETRY_BACKOFF_MS * attempt, signal);
            continue;
          }
          break; // out of attempts on this model, or the error says to move on
        }
      }

      const next = candidates[index + 1];
      if (next) this.deps.events.append(runId, stepId, 'fallback-selected', { from: entry.id, to: next.entry.id, error: lastShape });
    }

    throw new StepFailure('model_error', lastShape ?? { code: 'Unknown', message: 'every candidate failed', retryable: false, action: 'abort' },
      lastShape?.message ?? 'Every model this step could use failed.');
  }

  /**
   * One streamed invocation. Tokens go out on the live bus as they arrive so the UI can show them; the stored
   * record is still the single `model-completed` payload, so the trace and its replay are unchanged.
   */
  private async callModel(adapter: ModelAdapter, entry: CatalogEntry, compiled: CompiledRequest, signal: AbortSignal, runId: string, stepId: string): Promise<ModelResponse> {
    const ctx: AdapterContext = { fetch: this.egressFetch(entry, runId, stepId), apiKey: this.credentialFor(entry, adapter.id), runId };
    let finished: ModelResponse | null = null;
    for await (const ev of adapter.stream(entry, { ...compiled, abortSignal: signal }, ctx)) {
      if (ev.type === 'text-delta' || ev.type === 'reasoning-delta') {
        this.deps.events.emitDelta({ runId, stepId, modelId: entry.id, kind: ev.type === 'text-delta' ? 'text' : 'reasoning', text: ev.text });
      } else if (ev.type === 'finish') {
        finished = ev.response;
      } else if (ev.type === 'error') {
        throw modelError(ev.error.code, ev.error.message, { action: ev.error.action, retryable: ev.error.retryable, ...(ev.error.providerError ? { providerError: ev.error.providerError } : {}) });
      }
    }
    if (!finished) throw modelError('Unknown', `The ${adapter.id} adapter's stream ended without a finish event.`);
    return finished;
  }

  private candidatesFor(input: AgentStepInput): Candidate[] {
    const ws = this.deps.workspace();
    const policy = input.agent.definition.modelPolicy;
    // A step's `model` replaces the primary and keeps the agent's fallbacks, so an ensemble stays resilient.
    const ids = input.modelOverride ? [input.modelOverride, ...policy.fallbacks] : [policy.primary, ...policy.fallbacks];
    const { candidates, rejected } = selectCandidates({
      catalog: ws.catalog,
      ids,
      mode: ws.config.network.mode,
      requires: policy.requires as Record<string, unknown> | undefined,
      hasAdapter: (id) => this.deps.registry.has(id),
      ...(input.provider === 'mock' ? { forceAdapter: 'mock' } : {}),
    });
    if (candidates.length) return candidates;

    const why = rejected.map((r) => `${r.id}: ${r.reason}`).join('; ');
    // The network mode is a policy decision, not a missing model: name it, so the fix is obvious.
    const blockedByMode = rejected.length > 0 && rejected.every((r) => r.reason.startsWith('network mode is'));
    const err = blockedByMode
      ? new NetworkPolicyError(`No model for "${input.agent.definition.id}" is reachable in ${ws.config.network.mode} mode. ${why}. Switch the mode in Settings, or give this agent a local model.`)
      : new ModelUnavailableError(`No usable model for "${input.agent.definition.id}". ${why || 'The agent names no models.'}`);
    throw new StepFailure(blockedByMode ? 'network_policy' : 'model_unavailable', err.toShape(), err.message);
  }

  /** The credential a provider needs, named by the catalog id's prefix; the mock and local endpoints need none. */
  private credentialFor(entry: CatalogEntry, adapterId: string): string | undefined {
    if (adapterId === 'mock') return undefined;
    const provider = entry.id.split('/')[0];
    return provider ? this.deps.credentials.get(provider) : undefined;
  }

  /**
   * Every model call goes through the checker (D-28). An enabled catalog entry *is* the owner's declaration that
   * this endpoint may be reached, so model calls are declared endpoints: subject to the mode, not to tool
   * allowlists. The mode is still what stops a cloud call in `offline` or `local-only`.
   */
  private egressFetch(entry: CatalogEntry, runId: string, stepId: string): FetchLike {
    const real = this.deps.fetch ?? directFetch;
    const config = this.deps.workspace().config;
    return createEgressFetch({
      real,
      policy: () => ({
        mode: config.network.mode,
        allow: config.network.allow,
        allowLocalAddresses: config.network.allowLocalAddresses,
        runtimePort: this.deps.runtimePort?.() ?? null,
      }),
      record: (attempt, decision) => this.recordEgress(attempt, decision),
    }, { purpose: 'model', declared: true, categories: ['instructions', 'task'], runId, stepId });
  }

  private recordEgress(attempt: EgressAttempt, decision: EgressDecision): void {
    this.deps.db.prepare(`INSERT INTO egress_log (id, run_id, step_id, purpose, host, ip, method, data_categories, bytes, body_redacted, decision, reason, ts)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`).run(
      ulid(), attempt.runId ?? null, attempt.stepId ?? null, attempt.purpose, decision.host, attempt.method,
      attempt.categories.join(','), attempt.bytes, this.persist(attempt.bodyRedacted), decision.allowed ? 'allowed' : 'denied', decision.reason, new Date().toISOString(),
    );
    if (!decision.allowed && attempt.runId) {
      this.deps.events.append(attempt.runId, attempt.stepId ?? null, 'egress-denied', { host: decision.host, reason: decision.reason });
    }
  }

  // ---- persistence ---------------------------------------------------------------------------------------

  private persist(value: unknown): string {
    return this.deps.redactor.redactJson(value);
  }

  private beginStepRow(input: AgentStepInput): void {
    this.deps.db.prepare(`INSERT INTO run_steps (run_id, step_id, kind, parent_step_id, map_index, state, started_at)
      VALUES (?, ?, 'agent', ?, ?, 'running', ?)
      ON CONFLICT(run_id, step_id) DO UPDATE SET state = 'running', started_at = excluded.started_at, finished_at = NULL`)
      .run(input.runId, input.stepId, input.parentStepId ?? null, input.mapIndex ?? null, new Date().toISOString());
  }

  private completeStepRow(input: AgentStepInput, outcome: StepOutcome, state: 'completed'): void {
    this.commitDocument(input, outcome, false);
    this.deps.db.prepare(`UPDATE run_steps SET state = ?, model_id = ?, output_json = ?, cost_usd = ?, finished_at = ? WHERE run_id = ? AND step_id = ?`)
      .run(state, outcome.modelId, this.persist(outcome.value), outcome.costUsd, new Date().toISOString(), input.runId, input.stepId);
    this.deps.events.append(input.runId, input.stepId, 'step-completed', { stepId: input.stepId, kind: 'agent', output: outcome.output, partial: outcome.partial });
  }

  private failStepRow(input: AgentStepInput, failure: StepFailure): void {
    const state = failure.reason === 'cancelled' ? 'cancelled' : 'failed';
    this.deps.db.prepare(`UPDATE run_steps SET state = ?, finished_at = ? WHERE run_id = ? AND step_id = ?`)
      .run(state, new Date().toISOString(), input.runId, input.stepId);
    if (state === 'failed') {
      this.deps.events.append(input.runId, input.stepId, 'step-failed', { stepId: input.stepId, kind: 'agent', reason: failure.reason, error: failure.detail, message: failure.message });
    }
  }

  private recordCall(runId: string, stepId: string, entry: CatalogEntry, adapterId: string, promptVersion: string, agentVersion: string, response: ModelResponse, costUsd: number, latencyMs: number, at: Date): void {
    this.deps.db.prepare(`INSERT INTO model_calls (id, run_id, step_id, model_id, adapter, prompt_version, agent_version, usage_json, cost_usd, latency_ms, finish_reason, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(ulid(), runId, stepId, entry.id, adapterId, promptVersion, agentVersion, this.persist(response.usage), costUsd, latencyMs, response.finishReason, at.toISOString());
  }

  private recordFailedCall(runId: string, stepId: string, entry: CatalogEntry, adapterId: string, promptVersion: string, agentVersion: string, shape: ModelErrorShape, latencyMs: number): void {
    this.deps.db.prepare(`INSERT INTO model_calls (id, run_id, step_id, model_id, adapter, prompt_version, agent_version, usage_json, cost_usd, latency_ms, finish_reason, error_json, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'error', ?, ?)`)
      .run(ulid(), runId, stepId, entry.id, adapterId, promptVersion, agentVersion, this.persist({ input: 0, output: 0, raw: {} }), latencyMs, this.persist(shape), new Date().toISOString());
  }

  /**
   * The documents an agent names are injected whole, as data, from the run's project. A named document that is
   * missing is a load-time-ish problem the trace should show, not a silent omission.
   */
  private knowledgeFor(agent: LoadedAgent, project: string | undefined): KnowledgeDocument[] {
    const wanted = agent.definition.documents;
    if (!wanted.length || !this.deps.artifacts || !project) return [];
    const out: KnowledgeDocument[] = [];
    for (const docPath of wanted) {
      const text = this.deps.artifacts.readDocument(project, docPath);
      if (text === null) {
        this.deps.log.warn({ agent: agent.definition.id, project, document: docPath }, 'agent names a project document that does not exist');
        continue;
      }
      out.push({ source: `${project}/${docPath}`, text });
    }
    return out;
  }

  /** The step's `output.document`, else the agent's, else nothing. `{{runId}}` and `{{agentId}}` resolve here. */
  private documentPathFor(input: AgentStepInput): string | null {
    if (input.documentPath === null) return null;
    const template = input.documentPath
      ?? (input.agent.definition.output.kind === 'document'
        ? input.agent.definition.output.document ?? `${input.agent.definition.id}/${input.runId}.md`
        : null);
    if (!template) return null;
    return template.replace(/\{\{\s*runId\s*\}\}/g, input.runId).replace(/\{\{\s*agentId\s*\}\}/g, input.agent.definition.id);
  }

  private commitDocument(input: AgentStepInput, outcome: StepOutcome, partial: boolean): void {
    const docPath = this.documentPathFor(input);
    if (!docPath || !this.deps.artifacts) return;
    if (!input.project) {
      this.deps.log.warn({ agent: input.agent.definition.id, runId: input.runId }, 'this step writes a document but the run named no project');
      return;
    }
    const version = this.deps.artifacts.writeDocument({
      projectSlug: input.project, path: docPath, content: outcome.output, createdBy: 'run-step',
      runId: input.runId, stepId: input.stepId, agentVersion: input.agent.version, modelId: outcome.modelId,
      partial: partial || outcome.partial,
    });
    const doc = this.deps.artifacts.findDocumentByPath(input.project, docPath);
    this.deps.events.append(input.runId, input.stepId, 'artifact-written', {
      documentId: doc?.id ?? null, versionId: version.id, path: `${input.project}/${docPath}`, partial: partial || outcome.partial,
    });
  }
}

interface Candidate { entry: CatalogEntry; adapterId: string }

function textOf(content: ContentBlock[]): string {
  return content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('');
}

/** `null` when the text conforms; otherwise the complaints, in the model's own terms. */
function validateAgainst(text: string, schema: JsonSchema): string[] | null {
  const parsed = parseJsonOutput(text);
  if (!parsed.ok) return [parsed.message];
  const problems = validateJson(parsed.value, schema);
  return problems.length ? problems.map((p) => `${p.path} ${p.message}`) : null;
}

function repairInstruction(problems: string[]): string {
  return [
    'Your last message did not match the required output schema:',
    ...problems.map((p) => `- ${p}`),
    'Reply with the corrected JSON and nothing else. No explanation, no code fence.',
  ].join('\n');
}

export function toShape(e: unknown): ModelErrorShape {
  return e instanceof ModelError ? e.toShape() : { code: 'Unknown', message: String((e as Error)?.message ?? e), retryable: false, action: 'abort' };
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
