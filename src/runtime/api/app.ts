// The HTTP surface (spec/api-and-cli.md): one process, one port, static SPA plus /api/v1 (D-21).
// Every JSON body leaves through the redactor (D-33). Check order: Host/Origin (403) → token (401).
import fs from 'node:fs';
import path from 'node:path';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  RerunRequest, ApprovalDecisionRequest, CompareRequest, CreateWorkflowRequest, EstimateRequest, FindingDecisionRequest, SaveWorkflowRequest, SetCredentialRequest, TrustPluginRequest, UpdateSettingsRequest, ComparePickRequest, CreateDatasetRequest, CreateExperimentRequest, CreateMemoryRequest, CreateProjectRequest, CreateRunRequest, MemoryScope, PutDocumentRequest, RateRequest, ReviewDecisionRequest, SetGrantRequest, SetReposRequest, SetPriceRequest, SetEnabledRequest, SetNetworkModeRequest, SubscribePushRequest, UpsertScheduleRequest, type AgentDetail, type AgentListResponse, type AgentSummary, type ApiError, type CompareResponse, type DashboardResponse, type ImportResult, type PluginStatusSummary, type DeleteMemoryResponse, type McpServerSummary, type EgressRecord, type HealthResponse, type IngestKnowledgeResponse, type KnowledgeSearchResponse, type MemoryResponse, type MemoryTracesResponse, type ModelListResponse, type PrivacyResponse, type ReloadAgentsResponse, type ApprovalListResponse, type GrantCell, type PushSubscriptionsResponse, type ReviewListResponse, type ScheduleListResponse, type SettingsResponse, type ToolDenial, type ToolsResponse, type ToolSummary, type AgentGrantSummary, type DeleteWorkflowResponse, type EstimateResponse, type SpendResponse, type PermissionFinding, type PermissionFindingsResponse, type WorkflowDetail, type WorkflowListResponse, type WorkflowSummary, SaveProjectSpaceRequest, type ProjectSpaceResponse } from '../../shared/api/index.js';
import type { ArtifactStore } from '../artifacts/store.js';
import { WorkspaceError } from '../util/errors.js';
import type { EventRecord } from '../../shared/events.js';
import { ConflictError, NotFoundError, ValidationError, type Engine } from '../engine/run.js';
import { ScheduleError, type Scheduler } from '../scheduler/index.js';
import type { PushStore } from '../push/store.js';
import { ingestKnowledge, UnsupportedKnowledgeFormat } from '../knowledge/ingest.js';
import { DEFAULT_LIMITS, type SandboxLimits } from '../sandbox/deno.js';
import { exportDataset, importDataset } from '../evaluation/transfer.js';
import { bundle, openBundle, parseWorkflowBundle, stripAgentTrust, BundleShapeError, BundleVersionError, MemoryBundle } from '../transfer/bundle.js';
import { TERMINAL_EVENTS, type EventStore } from '../engine/events.js';
import { securityHeaders, hostOriginGuard, bearerGuard } from '../security/auth.js';
import { grantFor } from '../security/permissions.js';
import type { Redactor } from '../security/redaction.js';
import type { Db } from '../db/index.js';
import type { Credentials } from '../security/credentials.js';
import type { Logger } from '../log/index.js';
import type { BrokenAgent, Workspace } from '../workspace/loader.js';
import type { LoadedAgent } from '../../shared/agent.js';
import { validateWorkflow, type LoadedWorkflow } from '../../shared/workflow.js';
import { WorkflowWriteError } from '../workspace/workflows.js';
import { toolSpec } from '../../shared/tool.js';
import { z } from 'zod';
import { PushEventKind } from '../../shared/api/index.js';
import type { BudgetOverride } from '../engine/budget.js';
import { SpaceWriteError } from '../workspace/spaces.js';

export interface AppDeps {
  engine: Engine;
  scheduler: Scheduler;
  events: EventStore;
  workspace: () => Workspace;
  credentials: Credentials;
  redactor: Redactor;
  log: Logger;
  token: () => string;
  hosts: () => Set<string>;
  health: () => HealthResponse;
  denoAvailable: () => boolean;
  /** The sandbox as the Tools screen shows it (RUN-09), and the MCP servers that came up. */
  sandbox?: (() => { available: boolean; path: string | null; limits: SandboxLimits }) | undefined;
  mcp?: { status: () => McpServerSummary[] } | undefined;
  /** What the plugin loader found at startup (RUN-11), for Settings. */
  plugins?: (() => PluginStatusSummary[]) | undefined;
  /** Writes an imported agent to disk as files, like any other agent. */
  writeAgent: (definition: unknown, sections: { name: string; text: string }[]) => { id: string };
  writeWorkflow: (workflow: unknown) => { id: string };
  /** The editor's write path (RUN-13, D-62): validate, refuse a moved file, write, record the hash. */
  saveWorkflow: (id: string, raw: unknown, baseVersion: string) => LoadedWorkflow;
  /** A project's space (D-69, RUN-18): read with its version, saved hash-pinned. */
  spaces: {
    get: (slug: string) => ProjectSpaceResponse | null;
    save: (slug: string, raw: unknown, baseVersion: string) => ProjectSpaceResponse;
  };
  createWorkflow: (body: CreateWorkflowRequest) => LoadedWorkflow;
  deleteWorkflow: (id: string, deleteSchedules: boolean) => DeleteWorkflowResponse;
  /** Records that a human accepted "this code runs with full access" for one plugin *version* (D-32). */
  trustPlugin: (key: string) => void;
  /** Writes the 0600 credentials file. `null` removes one. The value is never read back out (SEC-05). */
  setCredential: (name: string, apiKey: string | null) => void;
  updateSettings: (patch: Record<string, unknown>) => void;
  /** Re-reads agent definitions from disk; the Agents screen calls it after an edit. */
  reloadAgents: () => { loaded: number; errors: BrokenAgent[] };
  /** The catalog with availability; `refresh` re-polls local endpoints first. */
  models: (refresh: boolean) => Promise<ModelListResponse>;
  /** Null when there is no such finding on the last refresh (D-64). */
  acceptFinding: (id: string) => Promise<ModelListResponse | null>;
  dismissFinding: (id: string) => Promise<ModelListResponse | null>;
  setPrice: (id: string, price: SetPriceRequest) => Promise<ModelListResponse | null>;
  setEnabled: (id: string, enabled: boolean) => Promise<ModelListResponse | null>;
  /** The one-click network switch (ui.md §UX rules): writes the mode to config and reloads it. */
  setNetworkMode: (mode: SetNetworkModeRequest['mode']) => void;
  /** A human granting or withdrawing a tool. This is the authority; what an agent's file asks for is not. */
  setGrant: (agentId: string, permissions: unknown) => void;
  /** What a run would cost before it runs (F2): from the prompt sizes and today's prices, against the cap. */
  estimate: (req: EstimateRequest) => EstimateResponse;
  /** Where the money went (F3). */
  spend: () => SpendResponse;
  /** Model roles (D-68): what a policy comes to right now, and each role's list and resolution for Settings. */
  modelsNow: (policy: { primary: string; fallbacks: string[] }) => string[];
  modelRoles: () => { roles: Record<string, string[]>; resolved: Record<string, string | null>; undefinedRoles: string[] };
  /** The permissions review (D-63): what the auditor proposed, and the person's decision on each. */
  findings: {
    list: (state: 'open' | 'applied' | 'dismissed' | 'all') => PermissionFinding[];
    decide: (id: string, decision: 'apply' | 'dismiss') => PermissionFinding;
  };
  push: PushStore;
  vapidPublicKey: () => string;
  artifacts: ArtifactStore;
  db: Db;
  uiDist: string;
  /** Fires when the runtime stops; open SSE streams end on it. */
  shutdown: AbortSignal;
}

type ErrorCode = ApiError['error']['code'];

const KEEPALIVE_MS = 15_000;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  const json = (c: Context, value: unknown, status: ContentfulStatusCode = 200): Response =>
    c.json(deps.redactor.redact(value) as Record<string, unknown>, status);
  const fail = (c: Context, code: ErrorCode, message: string, status: ContentfulStatusCode, details?: unknown): Response =>
    json(c, { error: { code, message, ...(details !== undefined ? { details } : {}) } }, status);
  const mapError = (c: Context, e: unknown): Response => {
    if (e instanceof NotFoundError) return fail(c, 'not_found', e.message, 404);
    if (e instanceof ValidationError) return fail(c, 'validation', e.message, 400);
    if (e instanceof ConflictError) return fail(c, 'conflict', e.message, 409);
    if (e instanceof ScheduleError) return fail(c, 'validation', e.message, 400);
    if (e instanceof RangeError) return fail(c, 'validation', e.message, 400);
    if (e instanceof WorkflowWriteError) {
      const status = e.code === 'validation' ? 400 : e.code === 'not_found' ? 404 : 409;
      return fail(c, e.code === 'exists' ? 'conflict' : e.code, e.message, status, e.details);
    }
    if (e instanceof SpaceWriteError) {
      const status = e.code === 'validation' ? 400 : e.code === 'not_found' ? 404 : 409;
      return fail(c, e.code, e.message, status, e.currentVersion ? { currentVersion: e.currentVersion } : undefined);
    }
    throw e;
  };
  const eventLine = (e: EventRecord): string => deps.redactor.redactJson(e);

  app.onError((err, c) => {
    deps.log.error({ err, path: c.req.path }, 'request failed');
    return fail(c, 'internal', `Internal error: ${err.message}`, 500);
  });

  app.use('*', securityHeaders());
  app.use('*', hostOriginGuard(deps.hosts));

  // No token: liveness for the CLI's runtime discovery (D-45).
  app.get('/api/v1/health', (c) => json(c, deps.health()));

  app.use('/api/*', bearerGuard(deps.token));

  app.post('/api/v1/runs', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, 'validation', 'The request body must be JSON.', 400);
    }
    const parsed = CreateRunRequest.safeParse(body);
    if (!parsed.success) return fail(c, 'validation', 'Invalid run request.', 400, parsed.error.issues);
    const req = parsed.data;
    if (req.kind === 'experiment') return fail(c, 'validation', 'Experiment runs arrive in RUN-10.', 400);
    const budget = budgetOverride(req.overrides);
    try {
      const { runId } = req.kind === 'workflow'
        ? deps.engine.startWorkflowRun({ workflowId: req.id, inputs: req.inputs, project: req.project, provider: req.provider, budget })
        : deps.engine.startAgentRun({
            agentId: req.id, inputs: req.inputs, project: req.project, provider: req.provider, budget,
            modelOverride: typeof req.overrides?.['model'] === 'string' ? (req.overrides['model'] as string) : undefined,
          });
      return json(c, { runId }, 202);
    } catch (e) {
      return mapError(c, e);
    }
  });

  // Cancel is a button on every running run: it aborts in-flight calls and commits nothing (D-14 §Cancel).
  app.post('/api/v1/runs/:id/cancel', (c) => {
    try {
      deps.engine.cancel(c.req.param('id'));
      return json(c, { cancelled: true }, 202);
    } catch (e) {
      return mapError(c, e);
    }
  });

  app.get('/api/v1/runs', (c) => {
    const limitRaw = c.req.query('limit');
    const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) return fail(c, 'validation', '`limit` must be an integer between 1 and 1000.', 400);
    const runs = deps.engine.listRuns({ state: c.req.query('state'), kind: c.req.query('kind'), project: c.req.query('project'), limit });
    return json(c, { runs });
  });

  // Workspace-level stream of run-* events for every run; registered before /runs/:id.
  // What a run would cost, before it runs (F2). The same request shape as starting one, so the estimate is
  // about exactly what the button would do. An estimate, and it says so.
  app.post('/api/v1/runs/estimate', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, 'validation', 'The request body must be JSON.', 400);
    }
    const parsed = EstimateRequest.safeParse(body);
    if (!parsed.success) return fail(c, 'validation', 'An estimate is { kind, id, inputs, overrides? }, like a run.', 400, parsed.error.issues);
    try {
      return json(c, deps.estimate(parsed.data));
    } catch (e) {
      return mapError(c, e);
    }
  });

  app.get('/api/v1/runs/events', (c) =>
    streamSSE(c, async (stream) => {
      let chain = Promise.resolve();
      const unsubscribe = deps.events.subscribe((e) => {
        if (!e.type.startsWith('run-')) return;
        chain = chain.then(() => stream.writeSSE({ id: String(e.seq), event: e.type, data: eventLine(e) })).catch(() => undefined);
      });
      try {
        await stream.writeSSE({ event: 'ready', data: '{}' });
        await untilClosed(stream, deps.shutdown);
      } finally {
        unsubscribe();
      }
    }),
  );

  app.get('/api/v1/runs/:id', (c) => {
    const run = deps.engine.getRun(c.req.param('id'));
    return run ? json(c, run) : fail(c, 'not_found', `Run "${c.req.param('id')}" does not exist.`, 404);
  });

  // Replays stored events after `after`, then streams live ones; closes after a terminal event.
  app.get('/api/v1/runs/:id/events', (c) => {
    const id = c.req.param('id');
    if (!deps.engine.getRun(id)) return fail(c, 'not_found', `Run "${id}" does not exist.`, 404);
    const afterRaw = c.req.query('after');
    const after = afterRaw !== undefined && afterRaw !== '' ? Number(afterRaw) : 0;
    if (!Number.isInteger(after) || after < 0) return fail(c, 'validation', '`after` must be a non-negative integer sequence number.', 400);

    return streamSSE(c, async (stream) => {
      let last = after;
      let finished = false;
      let resolveDone: () => void = () => undefined;
      const done = new Promise<void>((r) => { resolveDone = r; });
      let chain = Promise.resolve();
      const send = (e: EventRecord): void => {
        if (e.seq <= last) return;
        last = e.seq;
        chain = chain.then(async () => {
          await stream.writeSSE({ id: String(e.seq), event: e.type, data: eventLine(e) });
          if (TERMINAL_EVENTS.has(e.type)) { finished = true; resolveDone(); }
        }).catch(() => { finished = true; resolveDone(); });
      };
      const unsubscribe = deps.events.subscribe((e) => { if (e.runId === id) send(e); });
      // Deltas carry no `id`: they are never stored, so they must not advance a reconnecting client's `after` cursor.
      const unsubscribeDeltas = deps.events.subscribeDeltas((d) => {
        if (d.runId !== id || finished) return;
        chain = chain.then(() => stream.writeSSE({ event: 'model-delta', data: deps.redactor.redactJson(d) })).catch(() => undefined);
      });
      try {
        for (const e of deps.events.list(id, after)) send(e);
        await chain;
        if (!finished) await Promise.race([done, untilClosed(stream, deps.shutdown)]);
        await chain;
      } finally {
        unsubscribe();
        unsubscribeDeltas();
      }
    });
  });

  app.get('/api/v1/runs/:id/trace.jsonl', (c) => {
    const id = c.req.param('id');
    if (!deps.engine.getRun(id)) return fail(c, 'not_found', `Run "${id}" does not exist.`, 404);
    const lines = deps.events.list(id).map(eventLine);
    return c.body(lines.join('\n') + (lines.length ? '\n' : ''), 200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
  });

  app.get('/api/v1/agents', (c) => {
    const ws = deps.workspace();
    const body: AgentListResponse = { agents: [...ws.agents.values()].map((a) => agentSummary(a, deps.modelsNow(a.definition.modelPolicy))), errors: ws.brokenAgents };
    return json(c, body);
  });

  app.post('/api/v1/agents/reload', (c) => {
    const { loaded, errors } = deps.reloadAgents();
    const body: ReloadAgentsResponse = { loaded, errors };
    return json(c, body);
  });

  app.get('/api/v1/agents/:id', (c) => {
    const id = c.req.param('id');
    const ws = deps.workspace();
    const agent = ws.agents.get(id);
    if (!agent) {
      const broken = ws.brokenAgents.find((b) => b.id === id);
      return fail(c, 'not_found', broken ? `Agent "${id}" failed to load: ${broken.message}` : `Agent "${id}" does not exist in this workspace.`, 404);
    }
    const body: AgentDetail = {
      ...agentSummary(agent, deps.modelsNow(agent.definition.modelPolicy)),
      sections: agent.sections,
      instructionsSource: Array.isArray(agent.definition.instructions) ? 'inline' : 'file',
      documents: agent.definition.documents,
    };
    return json(c, body);
  });

  // Run the same thing again as a new run, optionally on another model. `resume` continues a stopped run;
  // this starts a fresh one from the original's inputs so the two can be read side by side.
  app.post('/api/v1/runs/:id/rerun', async (c) => {
    let body: unknown = {};
    try { body = await c.req.json(); } catch { body = {}; }
    const parsed = RerunRequest.safeParse(body ?? {});
    if (!parsed.success) return fail(c, 'validation', 'Expected { model?, provider?: "mock" }.', 400, parsed.error.issues);
    try {
      const { runId } = deps.engine.rerun(c.req.param('id'), parsed.data);
      return json(c, { runId }, 202);
    } catch (e) {
      return mapError(c, e);
    }
  });

  app.post('/api/v1/runs/:id/resume', (c) => {
    try {
      const { runId } = deps.engine.resume(c.req.param('id'));
      return json(c, { runId }, 202);
    } catch (e) {
      return mapError(c, e);
    }
  });

  // ---- review and ratings (D-13) --------------------------------------------------------------
  app.get('/api/v1/reviews', (c) => {
    const state = c.req.query('state');
    const body: ReviewListResponse = { reviews: deps.engine.reviews.list({ state: (state ?? 'open') as 'open' }) };
    return json(c, body);
  });

  app.post('/api/v1/reviews/:id', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, 'validation', 'The request body must be JSON.', 400);
    }
    const parsed = ReviewDecisionRequest.safeParse(body);
    if (!parsed.success) return fail(c, 'validation', 'Expected { decision: "continue" | "reject" | "dismiss", feedback? }.', 400, parsed.error.issues);
    if (parsed.data.decision === 'reject' && !parsed.data.feedback?.trim()) {
      return fail(c, 'validation', 'A rejection needs feedback: the step re-runs with what you say appended, so "no" on its own would change nothing.', 400);
    }
    try {
      deps.engine.decideReview(c.req.param('id'), parsed.data.decision, parsed.data.feedback);
      return json(c, deps.engine.reviews.get(c.req.param('id')), 202);
    } catch (e) {
      return mapError(c, e);
    }
  });

  app.post('/api/v1/ratings', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, 'validation', 'The request body must be JSON.', 400);
    }
    const parsed = RateRequest.safeParse(body);
    if (!parsed.success) return fail(c, 'validation', 'A rating is { runId, stepId, value: 1-5, versionId?, note? }.', 400, parsed.error.issues);
    try {
      return json(c, deps.engine.reviews.rate(parsed.data), 201);
    } catch (e) {
      return mapError(c, e);
    }
  });

  // ---- push: the phone (D-61) -----------------------------------------------------------------
  // The public key is public by definition, but it still sits behind the token: a stranger who can read it
  // learns this workbench exists, and nothing here needs to tell them that.
  app.get('/api/v1/push/vapid-public-key', (c) => json(c, { publicKey: deps.vapidPublicKey() }));

  app.get('/api/v1/push/subscriptions', (c) => {
    const body: PushSubscriptionsResponse = { enabled: deps.workspace().config.push.enabled, subscriptions: deps.push.list() };
    return json(c, body);
  });

  app.post('/api/v1/push/subscribe', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, 'validation', 'The request body must be JSON.', 400);
    }
    const parsed = SubscribePushRequest.safeParse(body);
    if (!parsed.success) return fail(c, 'validation', 'Expected { endpoint, keys: { p256dh, auth }, deviceLabel?, events? }.', 400, parsed.error.issues);
    return json(c, deps.push.subscribe(parsed.data), 201);
  });

  app.put('/api/v1/push/subscriptions/:id', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, 'validation', 'The request body must be JSON.', 400);
    }
    const parsed = z.object({ events: z.array(PushEventKind) }).safeParse(body);
    if (!parsed.success) return fail(c, 'validation', 'Expected { events: [...] }.', 400, parsed.error.issues);
    const updated = deps.push.setEvents(c.req.param('id'), parsed.data.events);
    return updated ? json(c, updated) : fail(c, 'not_found', 'There is no subscription with that id.', 404);
  });

  app.delete('/api/v1/push/subscriptions/:id', (c) =>
    deps.push.unsubscribe(c.req.param('id'))
      ? json(c, { deleted: true })
      : fail(c, 'not_found', 'There is no subscription with that id.', 404));

  // ---- approvals: the security queue (D-13) ---------------------------------------------------
  app.get('/api/v1/approvals', (c) => {
    const state = c.req.query('state');
    const body: ApprovalListResponse = { approvals: deps.engine.approvals.list((state ?? 'pending') as 'pending') };
    return json(c, body);
  });

  app.post('/api/v1/approvals/:id', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, 'validation', 'The request body must be JSON.', 400);
    }
    const parsed = ApprovalDecisionRequest.safeParse(body);
    if (!parsed.success) return fail(c, 'validation', 'Expected { decision: "allow" | "allow-remember" | "deny", actionId? }.', 400, parsed.error.issues);
    try {
      deps.engine.decideApproval(c.req.param('id'), parsed.data.decision, parsed.data.actionId);
      return json(c, { decided: true }, 202);
    } catch (e) {
      return mapError(c, e);
    }
  });

  // ---- tools and the grant matrix (D-26) ------------------------------------------------------
  app.get('/api/v1/tools', (c) => {
    const ws = deps.workspace();
    const tools = deps.engine.tools.catalog();
    const sandbox = deps.sandbox?.() ?? { available: false, path: null, limits: DEFAULT_LIMITS };
    const matrix: GrantCell[] = [];
    for (const agent of ws.agents.values()) {
      for (const tool of tools) matrix.push(deps.engine.tools.grantCell(agent, tool));
    }
    const denials = deps.db.prepare("SELECT * FROM tool_calls WHERE decision = 'denied' ORDER BY ts DESC LIMIT 50").all() as {
      id: string; run_id: string; step_id: string; agent_id: string | null; tool: string; decision: string; reason: string | null; error_code: string | null; ts: string;
    }[];
    const body: ToolsResponse = {
      tools: tools.map((t): ToolSummary => ({
        id: t.id, version: t.version, description: t.description, tier: t.tier,
        approvalByDefault: t.approvalByDefault ?? false,
        usesNetwork: t.usesNetwork ?? false,
        origin: t.origin ?? null,
        // The execute tier needs the sandbox — except the one tool that runs on the host by design (D-66).
        available: t.tier !== 'execute' || t.runsOnHost === true || sandbox.available,
        inputSchema: toolSpec(t).inputSchema,
      })),
      matrix,
      grants: [...ws.agents.values()].map((agent): AgentGrantSummary => {
        const granted = grantFor(ws.config, agent.definition.id);
        return {
          agentId: agent.definition.id,
          fs: { read: granted?.fs.read ?? [], write: granted?.fs.write ?? [] },
          repos: (granted?.repos ?? []).map((r) => ({ path: r.path, branches: r.branches, deny: r.deny })),
        };
      }),
      denials: denials.map((d): ToolDenial => ({
        id: d.id, runId: d.run_id, stepId: d.step_id, agentId: d.agent_id, tool: d.tool,
        decision: d.decision, reason: d.reason, errorCode: d.error_code, ts: d.ts,
      })),
      remembered: ws.config.remembered,
      sandbox: {
        available: sandbox.available,
        path: sandbox.path,
        disabled: sandbox.available ? [] : tools.filter((t) => t.tier === 'execute' && !t.runsOnHost).map((t) => t.id),
        limits: sandbox.limits,
      },
      mcpServers: deps.mcp?.status() ?? [],
      network: {
        mode: ws.config.network.mode,
        allow: ws.config.network.allow,
        allowLocalAddresses: ws.config.network.allowLocalAddresses,
        approvalExempt: ws.config.network.approvalExempt,
        searchProvider: ws.config.search.provider,
        agents: [...ws.agents.values()].map((agent) => ({
          agentId: agent.definition.id,
          ...deps.engine.tools.netPolicyFor(agent),
          tools: deps.engine.tools.availableTo(agent).filter((t) => t.usesNetwork).map((t) => t.id),
        })),
      },
    };
    return json(c, body);
  });

  app.put('/api/v1/tools/grants', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, 'validation', 'The request body must be JSON.', 400);
    }
    const parsed = SetGrantRequest.safeParse(body);
    if (!parsed.success) return fail(c, 'validation', 'Expected { agentId, toolId, grant: "allow" | "deny" | "unset" }.', 400, parsed.error.issues);
    const ws = deps.workspace();
    if (!ws.agents.has(parsed.data.agentId)) return fail(c, 'not_found', `There is no agent called "${parsed.data.agentId}".`, 404);
    if (!deps.engine.tools.catalog().some((t) => t.id === parsed.data.toolId)) return fail(c, 'not_found', `There is no tool called "${parsed.data.toolId}".`, 404);

    const existing = (ws.config.grants[parsed.data.agentId] ?? {}) as { tools?: Record<string, string> };
    const tools = { ...(existing.tools ?? {}) };
    if (parsed.data.grant === 'unset') delete tools[parsed.data.toolId];
    else tools[parsed.data.toolId] = parsed.data.grant;
    deps.setGrant(parsed.data.agentId, { ...existing, tools });

    const agent = ws.agents.get(parsed.data.agentId)!;
    const tool = deps.engine.tools.catalog().find((t) => t.id === parsed.data.toolId)!;
    return json(c, deps.engine.tools.grantCell(agent, tool));
  });

  // ---- the permissions review (D-63, RUN-14) --------------------------------------------------
  // Findings are proposals. Reading them is like reading the queue; deciding one is a human's matrix write.
  app.get('/api/v1/permissions/findings', (c) => {
    const state = c.req.query('state') ?? 'open';
    if (!['open', 'applied', 'dismissed', 'all'].includes(state)) return fail(c, 'validation', 'state is one of open, applied, dismissed, all.', 400);
    const body: PermissionFindingsResponse = { findings: deps.findings.list(state as 'open' | 'applied' | 'dismissed' | 'all') };
    return json(c, body);
  });

  app.post('/api/v1/permissions/findings/:id', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, 'validation', 'The request body must be JSON.', 400);
    }
    const parsed = FindingDecisionRequest.safeParse(body);
    if (!parsed.success) return fail(c, 'validation', 'A decision is { decision: "apply" | "dismiss" }.', 400, parsed.error.issues);
    try {
      return json(c, deps.findings.decide(c.req.param('id'), parsed.data.decision));
    } catch (e) {
      return mapError(c, e);
    }
  });

  // A repository grant from the Tools screen (D-66). Still a person writing it — on a form rather than in a
  // text editor — and still the whole list for one agent, replaced, so what the screen shows is what holds.
  app.put('/api/v1/tools/repos', async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return fail(c, 'validation', 'The request body must be JSON.', 400); }
    const parsed = SetReposRequest.safeParse(body);
    if (!parsed.success) return fail(c, 'validation', 'Expected { agentId, repos: [{ path, branches }] }.', 400, parsed.error.issues);
    const ws = deps.workspace();
    if (!ws.agents.has(parsed.data.agentId)) return fail(c, 'not_found', `There is no agent called "${parsed.data.agentId}".`, 404);
    const relative = parsed.data.repos.find((r) => !path.isAbsolute(r.path));
    if (relative) return fail(c, 'validation', `"${relative.path}" is not an absolute path. A repository grant names the whole path to a checkout, like C:/Users/you/project or /home/you/project.`, 400);
    const existing = (ws.config.grants[parsed.data.agentId] ?? {}) as Record<string, unknown>;
    deps.setGrant(parsed.data.agentId, { ...existing, repos: parsed.data.repos });
    const granted = grantFor(ws.config, parsed.data.agentId);
    const summary: AgentGrantSummary = {
      agentId: parsed.data.agentId,
      fs: { read: granted?.fs.read ?? [], write: granted?.fs.write ?? [] },
      repos: (granted?.repos ?? []).map((r) => ({ path: r.path, branches: r.branches, deny: r.deny })),
    };
    return json(c, summary);
  });

  // ---- schedules (D-15) -----------------------------------------------------------------------
  app.get('/api/v1/schedules', (c) => {
    const body: ScheduleListResponse = { schedules: deps.scheduler.list() };
    return json(c, body);
  });

  app.post('/api/v1/schedules', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, 'validation', 'The request body must be JSON.', 400);
    }
    const parsed = UpsertScheduleRequest.safeParse(body);
    if (!parsed.success) return fail(c, 'validation', 'A schedule is { workflowId, cron, inputs?, project?, enabled?, catchUp? }.', 400, parsed.error.issues);
    if (!deps.workspace().workflows.has(parsed.data.workflowId)) {
      return fail(c, 'not_found', `Workflow "${parsed.data.workflowId}" does not exist in this workspace.`, 404);
    }
    try {
      return json(c, deps.scheduler.upsert(parsed.data, false, c.req.query('id')), 201);
    } catch (e) {
      return mapError(c, e);
    }
  });

  app.delete('/api/v1/schedules/:id', (c) =>
    deps.scheduler.remove(c.req.param('id'))
      ? json(c, { deleted: true })
      : fail(c, 'not_found', `There is no schedule with id "${c.req.param('id')}".`, 404));

  // What needs you, what is running, and what today cost (ui.md §Dashboard).
  app.get('/api/v1/dashboard', (c) => {
    const runs = deps.engine.listRuns({ limit: 200 });
    const reviews = deps.engine.reviews.list({ state: 'open' });
    const budgets = deps.workspace().config.budgets;
    const spend = deps.spend();
    const body: DashboardResponse = {
      needsYou: reviews.filter((r) => r.blocking),
      approvals: deps.engine.approvals.list('pending'),
      unreviewed: reviews.filter((r) => !r.blocking).length,
      failed: runs.filter((r) => r.state === 'failed' || r.state === 'interrupted').slice(0, 10),
      running: runs.filter((r) => r.state === 'running' || r.state === 'queued' || r.state === 'waiting_review'),
      spentTodayUsd: deps.engine.spentTodayUsd(),
      dailySpendCapUsd: budgets.dailySpendCapUsd,
      spentThisMonthUsd: spend.thisMonthUsd,
      monthlySpendCapUsd: spend.monthlySpendCapUsd,
      projectedMonthUsd: spend.projectedMonthUsd,
      schedulesPaused: spend.schedulesPaused,
      schedules: deps.scheduler.list().filter((s) => s.enabled).slice(0, 10),
      networkMode: deps.workspace().config.network.mode,
      findings: deps.findings.list('open').length,
    };
    return json(c, body);
  });

  // Where the money went (F3): the month against its cap, and the last thirty days by model and by subject.
  app.get('/api/v1/spend', (c) => json(c, deps.spend()));

  // ---- workflows (D-11) -----------------------------------------------------------------------
  app.get('/api/v1/workflows', (c) => {
    const ws = deps.workspace();
    const body: WorkflowListResponse = { workflows: [...ws.workflows.values()].map(workflowSummary), errors: ws.brokenWorkflows };
    return json(c, body);
  });

  /** Only the keys the author wrote: `Budgets.partial()` leaves the rest `undefined`, which JSON drops anyway. */
  const compactBudget = (budget: Record<string, number | undefined>): Record<string, number> =>
    Object.fromEntries(Object.entries(budget).filter((entry): entry is [string, number] => typeof entry[1] === 'number'));

  const workflowDetail = (workflow: LoadedWorkflow): WorkflowDetail => {
    const validation = validateWorkflow(workflow.definition);
    return {
      ...workflowSummary(workflow),
      definition: workflow.definition as unknown as Record<string, unknown>,
      smells: validation.smells,
      order: validation.order,
      budgets: {
        workflow: workflow.definition.budgets ? compactBudget(workflow.definition.budgets) : null,
        steps: workflow.definition.steps.filter((s) => s.budget).map((s) => ({ stepId: s.id, budget: compactBudget(s.budget!) })),
      },
      schedules: deps.scheduler.list().filter((s) => s.workflowId === workflow.definition.id).length,
    };
  };

  app.get('/api/v1/workflows/:id', (c) => {
    const id = c.req.param('id');
    const ws = deps.workspace();
    const workflow = ws.workflows.get(id);
    if (!workflow) {
      const broken = ws.brokenWorkflows.find((b) => b.id === id);
      return fail(c, 'not_found', broken ? `Workflow "${id}" failed to load: ${broken.message}` : `Workflow "${id}" does not exist in this workspace.`, 404);
    }
    return json(c, workflowDetail(workflow));
  });

  // The editor's write path (RUN-13, D-62). Only a human reaches these: they sit behind the token like every
  // other route, and no tool can write under `workflows/` whatever its grant (SEC-11).
  app.post('/api/v1/workflows', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, 'validation', 'The request body must be JSON.', 400);
    }
    const parsed = CreateWorkflowRequest.safeParse(body);
    if (!parsed.success) return fail(c, 'validation', 'A new workflow is { id, name, copyOf? }: the id is lowercase letters, digits and hyphens.', 400, parsed.error.issues);
    try {
      return json(c, workflowDetail(deps.createWorkflow(parsed.data)), 201);
    } catch (e) {
      return mapError(c, e);
    }
  });

  app.put('/api/v1/workflows/:id', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, 'validation', 'The request body must be JSON.', 400);
    }
    const parsed = SaveWorkflowRequest.safeParse(body);
    if (!parsed.success) return fail(c, 'validation', 'A save is { definition, baseVersion }: the whole definition, and the version it was loaded at.', 400, parsed.error.issues);
    try {
      return json(c, workflowDetail(deps.saveWorkflow(c.req.param('id'), parsed.data.definition, parsed.data.baseVersion)));
    } catch (e) {
      return mapError(c, e);
    }
  });

  app.delete('/api/v1/workflows/:id', (c) => {
    try {
      return json(c, deps.deleteWorkflow(c.req.param('id'), c.req.query('deleteSchedules') === 'true'));
    } catch (e) {
      return mapError(c, e);
    }
  });

  // ---- the Library (D-16) ---------------------------------------------------------------------
  app.get('/api/v1/projects', (c) => json(c, { projects: deps.artifacts.listProjects() }));

  app.get('/api/v1/projects/:slug', (c) => {
    const project = deps.artifacts.findProject(c.req.param('slug'));
    if (!project) return fail(c, 'not_found', `Project "${c.req.param('slug')}" does not exist.`, 404);
    return json(c, { project });
  });

  app.post('/api/v1/projects', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, 'validation', 'The request body must be JSON.', 400);
    }
    const parsed = CreateProjectRequest.safeParse(body);
    if (!parsed.success) return fail(c, 'validation', 'A project needs a slug (lowercase letters, digits and hyphens) and a name.', 400, parsed.error.issues);
    try {
      return json(c, deps.artifacts.createProject(parsed.data.slug, parsed.data.name, parsed.data.description), 201);
    } catch (e) {
      if (e instanceof WorkspaceError) return fail(c, 'conflict', e.message, 409);
      throw e;
    }
  });

  // A project's space (D-69): what it reads as, and the hash-pinned save from its Library page.
  app.get('/api/v1/projects/:slug/space', (c) => {
    const body = deps.spaces.get(c.req.param('slug'));
    return body ? json(c, body) : fail(c, 'not_found', `Project "${c.req.param('slug')}" does not exist.`, 404);
  });

  app.put('/api/v1/projects/:slug/space', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, 'validation', 'The request body must be JSON.', 400);
    }
    const parsed = SaveProjectSpaceRequest.safeParse(body);
    if (!parsed.success) return fail(c, 'validation', 'A save is { space, baseVersion }: the whole space, and the version it was loaded at ("none" for a project with no file yet).', 400, parsed.error.issues);
    try {
      return json(c, deps.spaces.save(c.req.param('slug'), parsed.data.space, parsed.data.baseVersion));
    } catch (e) {
      return mapError(c, e);
    }
  });

  app.get('/api/v1/projects/:slug/documents', (c) => {
    try {
      return json(c, { documents: deps.artifacts.listDocuments(c.req.param('slug')) });
    } catch (e) {
      if (e instanceof WorkspaceError) return fail(c, 'not_found', e.message, 404);
      throw e;
    }
  });

  app.get('/api/v1/documents/:id', (c) => {
    const version = c.req.query('version');
    const doc = deps.artifacts.getDocument(c.req.param('id'), version);
    if (!doc) return fail(c, 'not_found', `No document with id "${c.req.param('id')}".`, 404);
    // Ratings live in the review store, not the Library's tables: a rating is a judgement about a version,
    // not part of it. The Library shows them, so the API joins them here rather than in two round trips.
    const ratings = deps.engine.reviews.ratingsForVersions(doc.history.map((h) => h.id));
    return json(c, { ...doc, ratings: Object.fromEntries(ratings) });
  });

  app.get('/api/v1/documents/:id/versions', (c) => {
    const doc = deps.artifacts.getDocument(c.req.param('id'));
    return doc ? json(c, { versions: doc.history }) : fail(c, 'not_found', `No document with id "${c.req.param('id')}".`, 404);
  });

  app.get('/api/v1/documents/:id/diff', (c) => {
    const from = c.req.query('from');
    const to = c.req.query('to');
    if (!from || !to) return fail(c, 'validation', 'A diff needs `from` and `to` version ids.', 400);
    const diff = deps.artifacts.diff(c.req.param('id'), from, to);
    return diff ? json(c, diff) : fail(c, 'not_found', 'One of those versions does not belong to this document.', 404);
  });

  // A human edit is a new version, never an overwrite: nothing in the Library is destructive (ui.md §UX rules).
  app.put('/api/v1/documents/:id', async (c) => {
    const existing = deps.artifacts.getDocument(c.req.param('id'));
    if (!existing) return fail(c, 'not_found', `No document with id "${c.req.param('id')}".`, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, 'validation', 'The request body must be JSON.', 400);
    }
    const parsed = PutDocumentRequest.safeParse(body);
    if (!parsed.success) return fail(c, 'validation', 'Expected { content: string }.', 400, parsed.error.issues);
    const version = deps.artifacts.writeDocument({ projectSlug: existing.projectSlug, path: existing.path, content: parsed.data.content, createdBy: 'human' });
    return json(c, version);
  });

  app.get('/api/v1/models', async (c) => json(c, await deps.models(false)));
  app.post('/api/v1/models/refresh', async (c) => json(c, await deps.models(true)));
  // A finding is a proposal; these two are the only ways it becomes anything else, and both are a person's click.
  app.post('/api/v1/models/findings/:id/accept', async (c) => {
    const id = c.req.param('id');
    try {
      const result = await deps.acceptFinding(id);
      return result ? json(c, result) : fail(c, 'not_found', `No finding "${id}" on the last refresh. Check for changes again.`, 404);
    } catch (e) {
      return fail(c, 'validation', `Accepting "${id}" would leave config/models.json invalid: ${(e as Error).message}`, 400);
    }
  });
  app.post('/api/v1/models/findings/:id/dismiss', async (c) => {
    const id = c.req.param('id');
    const result = await deps.dismissFinding(id);
    return result ? json(c, result) : fail(c, 'not_found', `No finding "${id}" on the last refresh. Check for changes again.`, 404);
  });
  // The two edits a person makes to a catalog entry by hand, as buttons: a price (D-65) and the enabled flag.
  app.put('/api/v1/models/:id/price', async (c) => {
    const id = c.req.param('id');
    let body: unknown;
    try { body = await c.req.json(); } catch { return fail(c, 'validation', 'The request body must be JSON.', 400); }
    const parsed = SetPriceRequest.safeParse(body);
    if (!parsed.success) return fail(c, 'validation', 'Expected { inputPerM, outputPerM } in dollars per million tokens, and optionally cachedPerM.', 400, parsed.error.issues);
    try {
      const result = await deps.setPrice(id, parsed.data);
      return result ? json(c, result) : fail(c, 'not_found', `There is no catalog entry "${id}".`, 404);
    } catch (e) {
      return fail(c, 'validation', `That price would leave config/models.json invalid: ${(e as Error).message}`, 400);
    }
  });
  app.put('/api/v1/models/:id/enabled', async (c) => {
    const id = c.req.param('id');
    let body: unknown;
    try { body = await c.req.json(); } catch { return fail(c, 'validation', 'The request body must be JSON.', 400); }
    const parsed = SetEnabledRequest.safeParse(body);
    if (!parsed.success) return fail(c, 'validation', 'Expected { enabled: true | false }.', 400, parsed.error.issues);
    const result = await deps.setEnabled(id, parsed.data.enabled);
    return result ? json(c, result) : fail(c, 'not_found', `There is no catalog entry "${id}".`, 404);
  });

  // The Privacy Inspector's data: every attempt this run made to leave the machine, and who holds the result.
  app.get('/api/v1/runs/:id/privacy', (c) => {
    const id = c.req.param('id');
    if (!deps.engine.getRun(id)) return fail(c, 'not_found', `Run "${id}" does not exist.`, 404);
    const rows = deps.db.prepare('SELECT * FROM egress_log WHERE run_id = ? ORDER BY ts, id').all(id) as EgressRow[];
    const calls = deps.db.prepare('SELECT model_id, COUNT(*) AS n FROM model_calls WHERE run_id = ? GROUP BY model_id').all(id) as { model_id: string; n: number }[];
    const catalog = deps.workspace().catalog;
    const body: PrivacyResponse = {
      runId: id,
      networkMode: deps.workspace().config.network.mode,
      egress: rows.map(toEgressRecord),
      destinations: calls.map((call) => {
        const entry = catalog.models.find((m) => m.id === call.model_id);
        // Only a model's own egress can name a model's host. Falling back to the first row of any kind made a
        // researcher's fetch look like the model had received the page.
        const modelHosts = [...new Set(rows.filter((r) => r.purpose === 'model' && r.host).map((r) => r.host))];
        const host = modelHosts.length === 1 ? modelHosts[0]! : null;
        return {
          modelId: call.model_id,
          host: entry?.baseUrl ? safeHost(entry.baseUrl) : host,
          dataPolicy: (entry?.dataPolicy ?? null) as Record<string, unknown> | null,
          calls: call.n,
        };
      }),
    };
    return json(c, body);
  });

  // Cutting the network is a safety control, so it is one click rather than a config edit and a restart.
  app.put('/api/v1/settings/network', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail(c, 'validation', 'The request body must be JSON.', 400);
    }
    const parsed = SetNetworkModeRequest.safeParse(body);
    if (!parsed.success) return fail(c, 'validation', 'Expected { mode: "offline" | "local-only" | "allowlist" | "unrestricted" }.', 400, parsed.error.issues);
    deps.setNetworkMode(parsed.data.mode);
    deps.log.info({ mode: parsed.data.mode }, 'network mode changed');
    return json(c, { networkMode: parsed.data.mode });
  });

  // ---- evaluation (D-36, D-50, D-52) -------------------------------------------------------------------

  app.get('/api/v1/datasets', (c) => json(c, { datasets: deps.engine.evaluation.listDatasets() }));

  app.post('/api/v1/datasets', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return fail(c, 'validation', 'The request body must be JSON.', 400);
    }
    const parsed = CreateDatasetRequest.safeParse(raw);
    if (!parsed.success) return fail(c, 'validation', 'Expected { name, cases?: [{ input, reference?, metadata? }] }.', 400, parsed.error.issues);
    const dataset = deps.engine.evaluation.createDataset(parsed.data.name);
    for (const item of parsed.data.cases) deps.engine.evaluation.addCase(dataset.id, item.input, item.reference, item.metadata);
    return json(c, deps.engine.evaluation.listDatasets().find((d) => d.id === dataset.id), 201);
  });

  app.get('/api/v1/datasets/:id/cases', (c) => {
    const dataset = deps.engine.evaluation.dataset(c.req.param('id'));
    if (!dataset) return fail(c, 'not_found', `There is no dataset with id "${c.req.param('id')}".`, 404);
    return json(c, { cases: deps.engine.evaluation.caseSummaries(dataset.id) });
  });

  app.get('/api/v1/datasets/:id/export', (c) => {
    const dataset = deps.engine.evaluation.dataset(c.req.param('id'));
    if (!dataset) return fail(c, 'not_found', `There is no dataset with id "${c.req.param('id')}".`, 404);
    // Redacted on the way out: a dataset built from real run inputs can hold a real credential (SEC-06).
    return json(c, exportDataset(dataset, deps.engine.evaluation.caseSummaries(dataset.id), deps.redactor));
  });

  app.post('/api/v1/datasets/import', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return fail(c, 'validation', 'The request body must be JSON.', 400);
    }
    const name = c.req.query('name');
    try {
      const imported = importDataset(raw);
      const dataset = deps.engine.evaluation.createDataset(name ?? imported.name ?? 'imported');
      for (const item of imported.cases) deps.engine.evaluation.addCase(dataset.id, item.input, item.reference, item.metadata);
      return json(c, deps.engine.evaluation.listDatasets().find((d) => d.id === dataset.id), 201);
    } catch (e) {
      return fail(c, 'validation', (e as Error).message, 400);
    }
  });

  app.get('/api/v1/experiments', (c) => json(c, { experiments: deps.engine.evaluation.listExperiments() }));

  app.post('/api/v1/experiments', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return fail(c, 'validation', 'The request body must be JSON.', 400);
    }
    const parsed = CreateExperimentRequest.safeParse(raw);
    if (!parsed.success) return fail(c, 'validation', 'Expected { name, datasetId, target: { kind, id }, models, trials?, evaluators?, budgets? }.', 400, parsed.error.issues);
    const body = parsed.data;
    if (!deps.engine.evaluation.dataset(body.datasetId)) return fail(c, 'not_found', `There is no dataset with id "${body.datasetId}".`, 404);
    if (body.target.kind === 'workflow') return fail(c, 'validation', 'Experiments run an agent for now; a workflow target arrives with the run that needs it.', 400);
    if (!deps.workspace().agents.has(body.target.id)) return fail(c, 'not_found', `There is no agent called "${body.target.id}".`, 404);

    const experiment = deps.engine.evaluation.createExperiment({
      name: body.name, datasetId: body.datasetId, targetKind: body.target.kind, targetId: body.target.id,
      models: body.models, evaluators: body.evaluators, trials: body.trials,
      ...(body.budgets ? { budgets: body.budgets } : {}),
    });
    // 202 and then it runs: an experiment is a thing you leave going, and the results route is how you look.
    void deps.engine.experiments.run(experiment, { ...(body.project ? { project: body.project } : {}) })
      .catch((e: unknown) => deps.log.error({ err: e, experiment: experiment.id }, 'an experiment failed outside its own error handling'));
    return json(c, deps.engine.evaluation.toExperimentSummary(experiment), 202);
  });

  app.get('/api/v1/experiments/:id/results', (c) => {
    const experiment = deps.engine.evaluation.experiment(c.req.param('id'));
    if (!experiment) return fail(c, 'not_found', `There is no experiment with id "${c.req.param('id')}".`, 404);
    return json(c, deps.engine.experiments.results(experiment));
  });

  app.post('/api/v1/experiments/:id/cancel', (c) => {
    const experiment = deps.engine.evaluation.experiment(c.req.param('id'));
    if (!experiment) return fail(c, 'not_found', `There is no experiment with id "${c.req.param('id')}".`, 404);
    deps.engine.experiments.cancel(experiment.id);
    return json(c, { id: experiment.id, cancelling: true }, 202);
  });

  app.post('/api/v1/compare', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return fail(c, 'validation', 'The request body must be JSON.', 400);
    }
    const parsed = CompareRequest.safeParse(raw);
    if (!parsed.success) return fail(c, 'validation', 'Expected { agentId, input, models: [at least two], project? }.', 400, parsed.error.issues);
    if (!deps.workspace().agents.has(parsed.data.agentId)) return fail(c, 'not_found', `There is no agent called "${parsed.data.agentId}".`, 404);
    const result = await deps.engine.experiments.compare(parsed.data);
    const body: CompareResponse = result;
    return json(c, body);
  });

  app.post('/api/v1/compare/pick', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return fail(c, 'validation', 'The request body must be JSON.', 400);
    }
    const parsed = ComparePickRequest.safeParse(raw);
    if (!parsed.success) return fail(c, 'validation', 'Expected { compareId, winner: { runId, modelId }, panes: [{ runId, modelId }] }.', 400, parsed.error.issues);
    const { compareId, winner, panes, note } = parsed.data;
    // One row per pane, sharing the compare id: the choice keeps both sides of itself, which is what makes it
    // preference data rather than a star (D-50).
    for (const pane of panes) {
      deps.engine.reviews.rate({
        runId: pane.runId, stepId: 'main', value: pane.runId === winner.runId ? 5 : 1,
        compareId, modelId: pane.modelId,
        ...(note ? { note } : {}),
      });
    }
    return json(c, { compareId, ratings: panes.length }, 201);
  });

  // ---- memory and knowledge (D-17, D-35) ---------------------------------------------------------------

  app.get('/api/v1/memory', (c) => {
    const scope = c.req.query('scope');
    const parsedScope = scope ? MemoryScope.safeParse(scope) : null;
    if (parsedScope && !parsedScope.success) return fail(c, 'validation', 'scope must be one of agent, user, workspace, project.', 400);
    const body: MemoryResponse = {
      items: deps.engine.memory.search({
        ...(c.req.query('q') ? { query: c.req.query('q')! } : {}),
        ...(parsedScope?.success ? { scope: parsedScope.data } : {}),
      }),
    };
    return json(c, body);
  });

  app.post('/api/v1/memory', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return fail(c, 'validation', 'The request body must be JSON.', 400);
    }
    const parsed = CreateMemoryRequest.safeParse(raw);
    if (!parsed.success) return fail(c, 'validation', 'Expected { content, scope?, ownerId?, supersedesId?, expiresAt? }.', 400, parsed.error.issues);
    const { content, scope, ownerId, supersedesId, expiresAt } = parsed.data;
    const owner = ownerId ?? (scope === 'workspace' ? 'workspace' : scope === 'user' ? 'owner' : null);
    if (!owner) return fail(c, 'validation', `A "${scope}" item needs an ownerId: the agent it belongs to, or the project.`, 400);
    // A human writing in the Memory screen is the trusted path by definition: nothing external wrote this.
    const item = deps.engine.memory.remember({
      scope, ownerId: owner, content, source: 'user', trust: 'trusted',
      ...(supersedesId ? { supersedesId } : {}), ...(expiresAt ? { expiresAt } : {}),
    });
    return json(c, item, 201);
  });

  app.get('/api/v1/memory/:id/traces', (c) => {
    const id = c.req.param('id');
    if (!deps.engine.memory.byId(id)) return fail(c, 'not_found', `There is no memory item with id "${id}".`, 404);
    const body: MemoryTracesResponse = { itemId: id, runIds: deps.engine.memory.tracesContaining(id) };
    return json(c, body);
  });

  app.delete('/api/v1/memory/:id', (c) => {
    const redact = c.req.query('redactTraces') === 'true';
    const result = deps.engine.memory.delete(c.req.param('id'), redact);
    if (!result.deleted) return fail(c, 'not_found', `There is no memory item with id "${c.req.param('id')}".`, 404);
    const body: DeleteMemoryResponse = result;
    return json(c, body);
  });

  app.get('/api/v1/knowledge/search', (c) => {
    const q = c.req.query('q');
    if (!q) return fail(c, 'validation', 'A search needs a `q`.', 400);
    const body: KnowledgeSearchResponse = {
      chunks: deps.artifacts.searchChunks(q, {
        ...(c.req.query('project') ? { projectSlug: c.req.query('project')! } : {}),
        ...(c.req.query('limit') ? { limit: Number(c.req.query('limit')) } : {}),
      }),
    };
    return json(c, body);
  });

  app.post('/api/v1/projects/:slug/knowledge', async (c) => {
    const slug = c.req.param('slug');
    const filename = c.req.query('filename');
    if (!filename) return fail(c, 'validation', 'Name the file with `?filename=`: the extension is how its format is read.', 400);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (!bytes.length) return fail(c, 'validation', 'The request body is the file, and it was empty.', 400);
    try {
      const result = await ingestKnowledge(deps.artifacts, { projectSlug: slug, filename, bytes });
      const document = deps.artifacts.findDocumentByPath(slug, result.path);
      const body: IngestKnowledgeResponse = {
        path: result.path, format: result.format, characters: result.characters,
        documentId: document?.id ?? '', versionId: result.version.id,
      };
      return json(c, body, 201);
    } catch (e) {
      if (e instanceof UnsupportedKnowledgeFormat) return fail(c, 'validation', e.message, 400);
      return mapError(c, e);
    }
  });

  // ---- export, import, plugins and settings (D-32, D-34, SEC-25/26/27) ---------------------------------

  app.get('/api/v1/export/agent/:id', (c) => {
    const agent = deps.workspace().agents.get(c.req.param('id'));
    if (!agent) return fail(c, 'not_found', `There is no agent called "${c.req.param('id')}".`, 404);
    return json(c, bundle('agent', { definition: agent.definition, sections: agent.sections, version: agent.version }, deps.redactor));
  });

  app.get('/api/v1/export/workflow/:id', (c) => {
    const workflow = deps.workspace().workflows.get(c.req.param('id'));
    if (!workflow) return fail(c, 'not_found', `There is no workflow called "${c.req.param('id')}".`, 404);
    return json(c, bundle('workflow', workflow.definition, deps.redactor));
  });

  app.get('/api/v1/export/memory', (c) => {
    const scope = c.req.query('scope');
    const items = deps.engine.memory.search({ ...(scope ? { scope: scope as 'workspace' } : {}), limit: 1000 });
    // Trust does not travel: what another workspace trusted is not something this one knows anything about.
    return json(c, bundle('memory', {
      items: items.map((i) => ({ scope: i.scope, ownerId: i.ownerId, content: i.content, createdAt: i.createdAt, expiresAt: i.expiresAt })),
    }, deps.redactor));
  });

  app.get('/api/v1/export/runs', (c) => {
    const ids = (c.req.query('ids') ?? '').split(',').map((id) => id.trim()).filter(Boolean);
    if (!ids.length) return fail(c, 'validation', 'Name the runs with `?ids=a,b,c`.', 400);
    const runs = ids.map((id) => ({ run: deps.engine.getRun(id), events: deps.events.list(id) })).filter((r) => r.run !== null);
    if (!runs.length) return fail(c, 'not_found', 'None of those runs exist.', 404);
    return json(c, bundle('runs', { runs }, deps.redactor));
  });

  app.post('/api/v1/import/agent', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return fail(c, 'validation', 'The request body must be JSON.', 400);
    }
    try {
      const envelope = openBundle(raw, 'agent');
      const payload = envelope.payload as { definition?: unknown; sections?: { name: string; text: string }[] };
      const { definition, stripped } = stripAgentTrust(payload.definition);
      // Written to disk as files, like every other agent: an imported agent is not a special kind of agent.
      const written = deps.writeAgent(definition, payload.sections ?? []);
      const body: ImportResult = { kind: 'agent', id: written.id, stripped, redactions: envelope.redactions };
      return json(c, body, 201);
    } catch (e) {
      if (e instanceof BundleVersionError || e instanceof BundleShapeError) return fail(c, 'validation', e.message, 400);
      return mapError(c, e);
    }
  });

  app.post('/api/v1/import/workflow', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return fail(c, 'validation', 'The request body must be JSON.', 400);
    }
    try {
      const envelope = openBundle(raw, 'workflow');
      const workflow = parseWorkflowBundle(envelope.payload);
      const written = deps.writeWorkflow(workflow);
      // A workflow's `permissions` block is a ceiling, and a ceiling from a file is still only a ceiling: it
      // cannot grant anything its steps' agents were not already granted.
      const body: ImportResult = {
        kind: 'workflow', id: written.id,
        stripped: workflow.permissions ? ['its permissions block, which is a ceiling and grants nothing'] : [],
        redactions: envelope.redactions,
      };
      return json(c, body, 201);
    } catch (e) {
      if (e instanceof BundleVersionError || e instanceof BundleShapeError) return fail(c, 'validation', e.message, 400);
      return mapError(c, e);
    }
  });

  app.post('/api/v1/import/memory', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return fail(c, 'validation', 'The request body must be JSON.', 400);
    }
    try {
      const envelope = openBundle(raw, 'memory');
      const parsed = MemoryBundle.safeParse(envelope.payload);
      if (!parsed.success) return fail(c, 'validation', 'A memory bundle is `{ items: [{ scope, ownerId, content }] }`.', 400);
      for (const item of parsed.data.items) {
        // Imported memory is `untrusted` by construction: it came from outside this workspace (D-17).
        deps.engine.memory.remember({
          scope: item.scope, ownerId: item.ownerId, content: item.content, source: 'import', trust: 'untrusted',
          ...(item.expiresAt ? { expiresAt: item.expiresAt } : {}),
        });
      }
      const body: ImportResult = {
        kind: 'memory', id: `${parsed.data.items.length} item(s)`,
        stripped: ['their trust: imported memory is untrusted, because it came from another workspace'],
        redactions: envelope.redactions,
      };
      return json(c, body, 201);
    } catch (e) {
      if (e instanceof BundleVersionError || e instanceof BundleShapeError) return fail(c, 'validation', e.message, 400);
      return mapError(c, e);
    }
  });

  app.post('/api/v1/plugins/trust', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return fail(c, 'validation', 'The request body must be JSON.', 400);
    }
    const parsed = TrustPluginRequest.safeParse(raw);
    if (!parsed.success) return fail(c, 'validation', 'Expected { name, version }.', 400, parsed.error.issues);
    // Per name *and* version: a new version of a plugin is new code, and asks again (D-32).
    deps.trustPlugin(`${parsed.data.name}@${parsed.data.version}`);
    return json(c, { trusted: `${parsed.data.name}@${parsed.data.version}`, restartRequired: true }, 202);
  });

  app.put('/api/v1/settings/credentials', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return fail(c, 'validation', 'The request body must be JSON.', 400);
    }
    const parsed = SetCredentialRequest.safeParse(raw);
    if (!parsed.success) {
      const nameIssue = parsed.error.issues.some((i) => i.path[0] === 'name');
      return fail(c, 'validation', nameIssue
        ? 'A provider name is lowercase letters, digits and hyphens — openai, not OpenAI. It is the prefix of the catalog ids the key unlocks.'
        : 'Expected { name, apiKey } — or { name, apiKey: null } to remove one.', 400, parsed.error.issues);
    }
    try {
      deps.setCredential(parsed.data.name, parsed.data.apiKey);
      // The names, never the values: a credential this workbench holds is not readable back out of it (SEC-05).
      return json(c, { providersConfigured: deps.credentials.names(), restartRequired: true }, 202);
    } catch (e) {
      return mapError(c, e);
    }
  });

  app.put('/api/v1/settings', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return fail(c, 'validation', 'The request body must be JSON.', 400);
    }
    const parsed = UpdateSettingsRequest.safeParse(raw);
    if (!parsed.success) return fail(c, 'validation', 'Expected some of { budgets, retention, execution, mcp, push, models: { roles } }.', 400, parsed.error.issues);
    try {
      deps.updateSettings(parsed.data);
      return json(c, { ok: true, restartRequired: parsed.data.mcp !== undefined }, 202);
    } catch (e) {
      return mapError(c, e);
    }
  });

  app.get('/api/v1/settings', (c) => {
    const ws = deps.workspace();
    const body: SettingsResponse = {
      workspacePath: ws.paths.dir,
      workspaceName: ws.file.name,
      networkMode: ws.config.network.mode,
      budgets: ws.config.budgets,
      execution: ws.config.execution,
      retention: ws.config.retention,
      providersConfigured: deps.credentials.names(),
      sandbox: { deno: deps.denoAvailable() },
      mcpServers: ws.config.mcp.servers,
      push: ws.config.push,
      plugins: deps.plugins?.() ?? [],
      models: deps.modelRoles(),
    };
    return json(c, body);
  });

  app.all('/api/*', (c) => fail(c, 'not_found', `No route for ${c.req.method} ${c.req.path}.`, 404));

  // Everything else is the SPA (D-22): a file under dist/ui, or index.html for client-side routes.
  app.get('*', (c) => serveSpa(c, deps.uiDist));
  app.notFound((c) => fail(c, 'not_found', `No route for ${c.req.method} ${c.req.path}.`, 404));

  return app;
}

/** Resolves when the client goes away or the runtime stops; sends SSE comments meanwhile so proxies keep the socket. */
function untilClosed(stream: { onAbort(l: () => void): void; write(s: string): Promise<unknown>; aborted: boolean; closed: boolean }, shutdown: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      shutdown.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setInterval(() => {
      if (stream.aborted || stream.closed) { finish(); return; }
      void stream.write(': keepalive\n\n').catch(finish);
    }, KEEPALIVE_MS);
    stream.onAbort(finish);
    shutdown.addEventListener('abort', finish, { once: true });
    if (shutdown.aborted || stream.aborted || stream.closed) finish();
  });
}

interface EgressRow { id: string; step_id: string | null; purpose: string; host: string; method: string; data_categories: string; bytes: number; body_redacted: string | null; decision: string; reason: string | null; ts: string }

function toEgressRecord(row: EgressRow): EgressRecord {
  return {
    id: row.id,
    stepId: row.step_id,
    purpose: row.purpose,
    host: row.host,
    method: row.method,
    categories: row.data_categories ? row.data_categories.split(',') : [],
    bytes: row.bytes,
    bodyRedacted: row.body_redacted,
    decision: row.decision === 'allowed' ? 'allowed' : 'denied',
    reason: row.reason,
    ts: row.ts,
  };
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function workflowSummary(workflow: LoadedWorkflow): WorkflowSummary {
  const d = workflow.definition;
  // The effective edges, not just the declared ones: a template reference implies a dependency, and a graph
  // drawn from `dependsOn` alone would show three independent steps where there is a pipeline.
  const { edges } = validateWorkflow(d);
  return {
    id: d.id,
    name: d.name,
    description: d.description,
    version: workflow.version,
    file: path.basename(workflow.file),
    defaultProject: d.defaultProject ?? null,
    inputs: d.inputs,
    steps: d.steps.map((s) => ({ id: s.id, kind: s.kind, agent: s.kind === 'agent' ? s.agent : null, dependsOn: [...(edges.get(s.id) ?? [])], review: s.review })),
    hasSchedule: d.schedule !== undefined,
  };
}

/** A run may only narrow the workspace's budgets (D-20); the engine enforces that, this just picks the numbers. */
function budgetOverride(overrides: Record<string, unknown> | undefined): BudgetOverride | undefined {
  const raw = overrides?.['budget'];
  if (typeof raw !== 'object' || raw === null) return undefined;
  const out: BudgetOverride = {};
  for (const key of ['maxModelCalls', 'maxToolCalls', 'maxCostUsd', 'maxWallClockMs', 'toolCallTimeoutMs', 'dailySpendCapUsd'] as const) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

function agentSummary(agent: LoadedAgent, now: string[]): AgentSummary {
  const d = agent.definition;
  return {
    id: d.id,
    name: d.name,
    description: d.description,
    version: agent.version,
    modelPolicy: { primary: d.modelPolicy.primary, fallbacks: d.modelPolicy.fallbacks, now, ...(d.modelPolicy.requires ? { requires: d.modelPolicy.requires as Record<string, unknown> } : {}) },
    tools: d.tools.map((t) => t.id),
    outputKind: d.output.kind,
    review: d.review,
  };
}

function serveSpa(c: Context, uiDist: string): Response {
  const root = path.resolve(uiDist);
  const index = path.join(root, 'index.html');
  if (!fs.existsSync(index)) {
    return c.text('The workbench UI is not built. Run `npm run build:ui`, or use the packaged `workbench` bin.', 503);
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(c.req.url).pathname);
  } catch {
    return c.text('Bad request path.', 400);
  }
  const target = path.resolve(root, `.${pathname}`);
  if (target !== root && target.startsWith(root + path.sep)) {
    try {
      if (fs.statSync(target).isFile()) {
        const type = MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream';
        return c.body(fs.readFileSync(target), 200, { 'Content-Type': type });
      }
    } catch {
      // fall through to the SPA shell
    }
  }
  return c.html(fs.readFileSync(index, 'utf8'));
}
