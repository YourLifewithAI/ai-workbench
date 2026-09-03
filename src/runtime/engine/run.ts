// The engine (RUN-00 scope): one agent step, no tools, full-payload events, cost stored (spec/workflows-and-execution.md).
import { ulid } from 'ulid';
import type { Db } from '../db/index.js';
import type { Workspace } from '../workspace/loader.js';
import type { AdapterRegistry, FetchLike } from '../models/adapter.js';
import { findModel, computeCost } from '../models/catalog.js';
import { ModelError, NetworkPolicyError, ModelUnavailableError } from '../models/errors.js';
import type { Credentials } from '../security/credentials.js';
import type { Redactor } from '../security/redaction.js';
import type { Logger } from '../log/index.js';
import type { EventStore } from './events.js';
import { assemblePrompt } from './prompt.js';
import { harnessSection } from './harness.js';
import type { RunDetail, RunSummary } from '../../shared/api/index.js';
import type { RunState, Spent } from '../../shared/events.js';
import type { ContentBlock, ModelResponse } from '../../shared/model.js';
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
}

export interface StartAgentRunInput { agentId: string; inputs: Record<string, unknown>; project?: string | undefined; provider?: 'mock' | undefined; modelOverride?: string | undefined }

export class NotFoundError extends Error { constructor(m: string) { super(m); this.name = 'NotFoundError'; } }
export class ValidationError extends Error { constructor(m: string) { super(m); this.name = 'ValidationError'; } }

interface RunRow { id: string; kind: string; state: RunState; agent_id: string | null; workflow_id: string | null; project_id: string | null; inputs_json: string; outputs_json: string | null; spent_json: string; started_at: string; finished_at: string | null; error_json: string | null }
interface StepRow { step_id: string; kind: string; state: string; model_id: string | null; cost_usd: number; started_at: string | null; finished_at: string | null }

/** Until the egress checker exists (RUN-02), no adapter call may open a socket. */
const noNetwork: FetchLike = async () => { throw new NetworkPolicyError('Outbound network is not available in this runtime yet (egress checker arrives in RUN-02).'); };

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

  private async execute(runId: string, agent: LoadedAgent, input: StartAgentRunInput, provider: 'mock' | undefined, spent: Spent, startedMs: number): Promise<void> {
    const ws = this.deps.workspace();
    const stepId = 'main';
    const candidates = input.modelOverride ? [input.modelOverride] : [agent.definition.modelPolicy.primary, ...agent.definition.modelPolicy.fallbacks];
    this.deps.events.append(runId, stepId, 'step-started', { stepId, kind: 'agent', agentId: agent.definition.id, modelCandidates: candidates });

    const notes: string[] = [];
    let chosen: { entry: ReturnType<typeof findModel>; adapterId: string } | null = null;
    for (const id of candidates) {
      const entry = findModel(ws.catalog, id);
      if (!entry) { notes.push(`${id}: not in catalog`); continue; }
      if (!entry.enabled) { notes.push(`${id}: disabled`); continue; }
      const adapterId = provider === 'mock' ? 'mock' : entry.adapter;
      if (!this.deps.registry.has(adapterId)) { notes.push(`${id}: adapter "${adapterId}" is not installed in this runtime`); continue; }
      chosen = { entry, adapterId };
      break;
    }
    if (!chosen || !chosen.entry) {
      const err = new ModelUnavailableError(`No usable model for agent "${agent.definition.id}": ${notes.join('; ')}`);
      return this.fail(runId, stepId, 'model_unavailable', err.toShape(), spent, startedMs);
    }
    const entry = chosen.entry;
    const adapter = this.deps.registry.get(chosen.adapterId)!;

    const task = typeof input.inputs['input'] === 'string' ? (input.inputs['input'] as string) : JSON.stringify(input.inputs);
    const harness = harnessSection({ agentId: agent.definition.id, runId, tools: [], review: agent.definition.review });
    const prompt = assemblePrompt(agent, task, harness);
    const controller = new AbortController();
    const attempt = 1;
    this.deps.events.append(runId, stepId, 'model-started', { modelId: entry.id, adapter: chosen.adapterId, attempt, request: prompt.compiled });
    const t0 = Date.now();
    const providerName = entry.adapter === 'mock' ? undefined : entry.id.split('/')[0];
    let response: ModelResponse;
    try {
      response = await adapter.generate(entry, { ...prompt.compiled, abortSignal: controller.signal }, { fetch: noNetwork, apiKey: providerName ? this.deps.credentials.get(providerName) : undefined, runId });
    } catch (e) {
      const shape = e instanceof ModelError ? e.toShape() : { code: 'Unknown' as const, message: String((e as Error).message ?? e), retryable: false, action: 'abort' as const };
      const latency = Date.now() - t0;
      this.deps.db.prepare(`INSERT INTO model_calls (id, run_id, step_id, model_id, adapter, prompt_version, agent_version, usage_json, cost_usd, latency_ms, finish_reason, error_json, ts)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'error', ?, ?)`).run(ulid(), runId, stepId, entry.id, chosen.adapterId, prompt.promptVersion, agent.version, this.persist({ input: 0, output: 0, raw: {} }), latency, this.persist(shape), new Date().toISOString());
      spent.modelCalls += 1;
      this.deps.events.append(runId, stepId, 'model-aborted', { modelId: entry.id, reason: shape.code, error: shape });
      return this.fail(runId, stepId, 'model_error', shape, spent, startedMs);
    }
    const latencyMs = Date.now() - t0;
    const at = new Date();
    const costUsd = computeCost(entry, response.usage, at);
    spent.modelCalls += 1;
    spent.costUsd = Math.round((spent.costUsd + costUsd) * 1e8) / 1e8;
    this.deps.db.prepare(`INSERT INTO model_calls (id, run_id, step_id, model_id, adapter, prompt_version, agent_version, usage_json, cost_usd, latency_ms, finish_reason, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(ulid(), runId, stepId, entry.id, chosen.adapterId, prompt.promptVersion, agent.version, this.persist(response.usage), costUsd, latencyMs, response.finishReason, at.toISOString());
    this.deps.events.append(runId, stepId, 'model-completed', { modelId: entry.id, response, usage: response.usage, costUsd, latencyMs, promptVersion: prompt.promptVersion, agentVersion: agent.version });

    const output = response.content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('');
    const finishedAt = new Date().toISOString();
    spent.wallClockMs = Date.now() - startedMs;
    this.deps.db.prepare(`UPDATE run_steps SET state = 'completed', model_id = ?, output_json = ?, cost_usd = ?, finished_at = ? WHERE run_id = ? AND step_id = ?`).run(entry.id, this.persist(output), costUsd, finishedAt, runId, stepId);
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
