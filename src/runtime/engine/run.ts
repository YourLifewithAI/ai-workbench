// The engine (RUN-00 scope): one agent step, no tools, full-payload events, cost stored (spec/workflows-and-execution.md).
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
import { assemblePrompt } from './prompt.js';
import { harnessSection } from './harness.js';
import type { RunDetail, RunSummary } from '../../shared/api/index.js';
import type { RunState, Spent } from '../../shared/events.js';
import type { CatalogEntry, CompiledRequest, ContentBlock, ModelErrorShape, ModelResponse } from '../../shared/model.js';
import type { LoadedAgent } from '../../shared/agent.js';

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

/** Two retries after the first attempt, per model, when the error says `retry` (model-layer.md §Errors). */
const MAX_ATTEMPTS_PER_MODEL = 3;
const RETRY_BACKOFF_MS = 200;

function toShape(e: unknown): ModelErrorShape {
  return e instanceof ModelError ? e.toShape() : { code: 'Unknown', message: String((e as Error)?.message ?? e), retryable: false, action: 'abort' };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

export interface StartAgentRunInput { agentId: string; inputs: Record<string, unknown>; project?: string | undefined; provider?: 'mock' | undefined; modelOverride?: string | undefined }

export class NotFoundError extends Error { constructor(m: string) { super(m); this.name = 'NotFoundError'; } }
export class ValidationError extends Error { constructor(m: string) { super(m); this.name = 'ValidationError'; } }

interface RunRow { id: string; kind: string; state: RunState; agent_id: string | null; workflow_id: string | null; project_id: string | null; inputs_json: string; outputs_json: string | null; spent_json: string; started_at: string; finished_at: string | null; error_json: string | null }
interface StepRow { step_id: string; kind: string; state: string; model_id: string | null; cost_usd: number; started_at: string | null; finished_at: string | null }

export class Engine {
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(private readonly deps: EngineDeps) {}

  startAgentRun(input: StartAgentRunInput): { runId: string; done: Promise<void> } {
    const ws = this.deps.workspace();
    const agent = ws.agents.get(input.agentId);
    if (!agent) {
      const broken = ws.brokenAgents.find((b) => b.id === input.agentId);
      throw new NotFoundError(broken ? `Agent "${input.agentId}" failed to load: ${broken.message}` : `Agent "${input.agentId}" does not exist in this workspace.`);
    }
    const runId = ulid();
    const now = new Date().toISOString();
    const budgets = ws.config.budgets;
    const spent: Spent = { modelCalls: 0, toolCalls: 0, costUsd: 0, wallClockMs: 0 };
    const provider = input.provider ?? this.deps.providerOverride ?? undefined;
    this.deps.db.prepare(`INSERT INTO runs (id, kind, state, agent_version, agent_id, project_id, depth, inputs_json, budgets_json, spent_json, started_at)
      VALUES (?, 'agent', 'running', ?, ?, ?, 0, ?, ?, ?, ?)`).run(runId, agent.version, agent.definition.id, input.project ?? null, this.persist(input.inputs), this.persist(budgets), this.persist(spent), now);
    this.deps.db.prepare(`INSERT INTO run_steps (run_id, step_id, kind, state, started_at) VALUES (?, 'main', 'agent', 'running', ?)`).run(runId, now);
    this.recordAgentVersion(agent, now);
    this.deps.events.append(runId, null, 'run-started', { kind: 'agent', agentId: agent.definition.id, agentVersion: agent.version, inputs: input.inputs, project: input.project ?? null, budgets, provider: provider ?? null });

    const done = this.execute(runId, agent, input, provider, spent, Date.parse(now)).catch((e: unknown) => {
      this.deps.log.error({ err: e, runId }, 'engine failure');
    }).finally(() => this.inflight.delete(runId));
    this.inflight.set(runId, done);
    return { runId, done };
  }

  waitFor(runId: string): Promise<void> {
    return this.inflight.get(runId) ?? Promise.resolve();
  }

  private persist(value: unknown): string {
    return this.deps.redactor.redactJson(value);
  }

  private recordAgentVersion(agent: LoadedAgent, at: string): void {
    this.deps.db.prepare('INSERT OR IGNORE INTO agent_versions (hash, agent_id, definition_json, created_at) VALUES (?, ?, ?, ?)')
      .run(agent.version, agent.definition.id, this.persist({ definition: agent.definition, sections: agent.sections }), at);
  }

  /**
   * One streamed invocation. Tokens go out on the live bus as they arrive so the UI can show them; the stored
   * record is still the single `model-completed` payload, so the trace and its replay are unchanged.
   */
  /**
   * One streamed invocation. Tokens go out on the live bus as they arrive so the UI can show them; the stored
   * record is still the single `model-completed` payload, so the trace and its replay are unchanged.
   */
  private async callModel(adapter: ModelAdapter, entry: CatalogEntry, compiled: CompiledRequest, signal: AbortSignal, runId: string, stepId: string): Promise<ModelResponse> {
    const ctx: AdapterContext = {
      fetch: this.egressFetch(entry, runId, stepId),
      apiKey: this.credentialFor(entry, adapter.id),
      runId,
    };
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

  private async execute(runId: string, agent: LoadedAgent, input: StartAgentRunInput, provider: 'mock' | undefined, spent: Spent, startedMs: number): Promise<void> {
    const ws = this.deps.workspace();
    const stepId = 'main';
    const ids = input.modelOverride ? [input.modelOverride] : [agent.definition.modelPolicy.primary, ...agent.definition.modelPolicy.fallbacks];
    const { candidates, rejected } = selectCandidates({
      catalog: ws.catalog,
      ids,
      mode: ws.config.network.mode,
      requires: agent.definition.modelPolicy.requires as Record<string, unknown> | undefined,
      hasAdapter: (id) => this.deps.registry.has(id),
      ...(provider === 'mock' ? { forceAdapter: 'mock' } : {}),
    });
    this.deps.events.append(runId, stepId, 'step-started', { stepId, kind: 'agent', agentId: agent.definition.id, modelCandidates: candidates.map((c) => c.entry.id) });

    if (!candidates.length) {
      const why = rejected.map((r) => `${r.id}: ${r.reason}`).join('; ');
      // The network mode is a policy decision, not a missing model: name it, so the fix is obvious.
      const blockedByMode = rejected.length > 0 && rejected.every((r) => r.reason.startsWith('network mode is'));
      const err = blockedByMode
        ? new NetworkPolicyError(`No model for "${agent.definition.id}" is reachable in ${ws.config.network.mode} mode. ${why}. Switch the mode in Settings, or give this agent a local model.`)
        : new ModelUnavailableError(`No usable model for "${agent.definition.id}". ${why || 'The agent names no models.'}`);
      return this.fail(runId, stepId, blockedByMode ? 'network_policy' : 'model_unavailable', err.toShape(), spent, startedMs);
    }

    const task = typeof input.inputs['input'] === 'string' ? (input.inputs['input'] as string) : JSON.stringify(input.inputs);
    const harness = harnessSection({ agentId: agent.definition.id, runId, tools: [], review: agent.definition.review });
    const knowledge = this.knowledgeFor(agent, input.project);
    const prompt = assemblePrompt(agent, task, harness, { knowledge });
    const controller = new AbortController();

    let lastShape: ModelErrorShape | null = null;
    for (let index = 0; index < candidates.length; index++) {
      const { entry, adapterId } = candidates[index]!;
      const adapter = this.deps.registry.get(adapterId)!;
      // A cross-provider move drops reasoning that only its own provider can read back (D-02 leak 1).
      const { messages, dropped } = dropForeignReasoning(prompt.compiled.messages, adapterId);
      if (dropped) this.deps.events.append(runId, stepId, 'provider-meta-dropped', { modelId: entry.id, droppedBlocks: dropped });
      const compiled: CompiledRequest = { ...prompt.compiled, messages };

      for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt++) {
        this.deps.events.append(runId, stepId, 'model-started', { modelId: entry.id, adapter: adapterId, attempt, request: compiled });
        const t0 = Date.now();
        try {
          const response = await this.callModel(adapter, entry, compiled, controller.signal, runId, stepId);
          this.completeStep(runId, stepId, agent, input.project, entry, adapterId, prompt.promptVersion, response, Date.now() - t0, spent, startedMs);
          return;
        } catch (e) {
          const shape = toShape(e);
          lastShape = shape;
          this.recordFailedCall(runId, stepId, entry, adapterId, prompt.promptVersion, agent.version, shape, Date.now() - t0);
          spent.modelCalls += 1;
          this.deps.events.append(runId, stepId, 'model-aborted', { modelId: entry.id, reason: shape.code, attempt, error: shape });

          if (shape.action === 'abort') return this.fail(runId, stepId, 'model_error', shape, spent, startedMs);
          if (shape.action === 'retry' && attempt < MAX_ATTEMPTS_PER_MODEL) {
            await sleep(RETRY_BACKOFF_MS * attempt, controller.signal);
            continue;
          }
          break; // out of attempts on this model, or the error says to move on
        }
      }

      const next = candidates[index + 1];
      if (next) {
        this.deps.events.append(runId, stepId, 'fallback-selected', { from: entry.id, to: next.entry.id, error: lastShape });
      }
    }
    return this.fail(runId, stepId, 'model_error', lastShape ?? { code: 'Unknown', message: 'every candidate failed', retryable: false, action: 'abort' }, spent, startedMs);
  }

  /**
   * The documents an agent names are injected whole, as data, from the run's project. A named document that is
   * missing is a load-time-ish problem the trace should show, not a silent omission.
   */
  private knowledgeFor(agent: LoadedAgent, project: string | undefined): { source: string; text: string }[] {
    const wanted = agent.definition.documents;
    if (!wanted.length || !this.deps.artifacts || !project) return [];
    const out: { source: string; text: string }[] = [];
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

  /**
   * An agent whose output is a document files it in the run's project on step completion, with the provenance
   * that produced it. `output.document` is a template; its default is `<agentId>/<runId>.md` (D-16).
   */
  private commitDocument(runId: string, stepId: string, agent: LoadedAgent, project: string | undefined, modelId: string, output: string): void {
    if (agent.definition.output.kind !== 'document' || !this.deps.artifacts) return;
    if (!project) {
      this.deps.log.warn({ agent: agent.definition.id, runId }, 'agent writes documents but the run named no project');
      return;
    }
    const template = agent.definition.output.document ?? `${agent.definition.id}/${runId}.md`;
    const docPath = template.replace(/\{\{\s*runId\s*\}\}/g, runId).replace(/\{\{\s*agentId\s*\}\}/g, agent.definition.id);
    const version = this.deps.artifacts.writeDocument({
      projectSlug: project, path: docPath, content: output, createdBy: 'run-step',
      runId, stepId, agentVersion: agent.version, modelId,
    });
    const doc = this.deps.artifacts.findDocumentByPath(project, docPath);
    this.deps.events.append(runId, stepId, 'artifact-written', { documentId: doc?.id ?? null, versionId: version.id, path: `${project}/${docPath}` });
  }

  private recordFailedCall(runId: string, stepId: string, entry: CatalogEntry, adapterId: string, promptVersion: string, agentVersion: string, shape: ModelErrorShape, latencyMs: number): void {
    this.deps.db.prepare(`INSERT INTO model_calls (id, run_id, step_id, model_id, adapter, prompt_version, agent_version, usage_json, cost_usd, latency_ms, finish_reason, error_json, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'error', ?, ?)`)
      .run(ulid(), runId, stepId, entry.id, adapterId, promptVersion, agentVersion, this.persist({ input: 0, output: 0, raw: {} }), latencyMs, this.persist(shape), new Date().toISOString());
  }

  private completeStep(runId: string, stepId: string, agent: LoadedAgent, project: string | undefined, entry: CatalogEntry, adapterId: string, promptVersion: string, response: ModelResponse, latencyMs: number, spent: Spent, startedMs: number): void {
    const at = new Date();
    const costUsd = computeCost(entry, response.usage, at);
    spent.modelCalls += 1;
    spent.costUsd = Math.round((spent.costUsd + costUsd) * 1e8) / 1e8;
    this.deps.db.prepare(`INSERT INTO model_calls (id, run_id, step_id, model_id, adapter, prompt_version, agent_version, usage_json, cost_usd, latency_ms, finish_reason, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(ulid(), runId, stepId, entry.id, adapterId, promptVersion, agent.version, this.persist(response.usage), costUsd, latencyMs, response.finishReason, at.toISOString());
    this.deps.events.append(runId, stepId, 'model-completed', { modelId: entry.id, response, usage: response.usage, costUsd, latencyMs, promptVersion, agentVersion: agent.version });

    const output = response.content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('');
    const finishedAt = at.toISOString();
    spent.wallClockMs = Date.now() - startedMs;
    this.deps.db.prepare(`UPDATE run_steps SET state = 'completed', model_id = ?, output_json = ?, cost_usd = ?, finished_at = ? WHERE run_id = ? AND step_id = ?`).run(entry.id, this.persist(output), costUsd, finishedAt, runId, stepId);
    this.commitDocument(runId, stepId, agent, project, entry.id, output);
    this.deps.events.append(runId, stepId, 'step-completed', { stepId, kind: 'agent', output });
    const outputs = { output };
    this.deps.db.prepare(`UPDATE runs SET state = 'completed', outputs_json = ?, spent_json = ?, finished_at = ? WHERE id = ?`).run(this.persist(outputs), this.persist(spent), finishedAt, runId);
    this.deps.events.append(runId, null, 'run-completed', { outputs, spent });
  }

  private fail(runId: string, stepId: string, reason: string, error: unknown, spent: Spent, startedMs: number): void {
    const finishedAt = new Date().toISOString();
    spent.wallClockMs = Date.now() - startedMs;
    this.deps.db.prepare(`UPDATE run_steps SET state = 'failed', finished_at = ? WHERE run_id = ? AND step_id = ?`).run(finishedAt, runId, stepId);
    this.deps.events.append(runId, stepId, 'step-failed', { stepId, kind: 'agent', error, reason });
    this.deps.db.prepare(`UPDATE runs SET state = 'failed', spent_json = ?, finished_at = ?, error_json = ? WHERE id = ?`).run(this.persist(spent), finishedAt, this.persist({ reason, error }), runId);
    this.deps.events.append(runId, null, 'run-failed', { reason, error });
  }

  getRun(id: string): RunDetail | null {
    const row = this.deps.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
    if (!row) return null;
    const steps = this.deps.db.prepare('SELECT step_id, kind, state, model_id, cost_usd, started_at, finished_at FROM run_steps WHERE run_id = ? ORDER BY started_at').all(id) as StepRow[];
    return {
      ...this.summary(row),
      inputs: JSON.parse(row.inputs_json) as Record<string, unknown>,
      ...(row.outputs_json ? { outputs: JSON.parse(row.outputs_json) as Record<string, unknown> } : {}),
      ...(row.error_json ? { error: JSON.parse(row.error_json) as unknown } : {}),
      steps: steps.map((s) => ({ stepId: s.step_id, kind: s.kind, state: s.state, modelId: s.model_id, costUsd: s.cost_usd, startedAt: s.started_at, finishedAt: s.finished_at })),
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

  private summary(row: RunRow): RunSummary {
    return {
      id: row.id, kind: row.kind as RunSummary['kind'], state: row.state,
      ...(row.agent_id ? { agentId: row.agent_id } : {}), ...(row.workflow_id ? { workflowId: row.workflow_id } : {}), ...(row.project_id ? { project: row.project_id } : {}),
      startedAt: row.started_at, ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
      spent: JSON.parse(row.spent_json) as Spent,
    };
  }
}
