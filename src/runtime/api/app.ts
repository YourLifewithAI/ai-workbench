// The HTTP surface (spec/api-and-cli.md): one process, one port, static SPA plus /api/v1 (D-21).
// Every JSON body leaves through the redactor (D-33). Check order: Host/Origin (403) → token (401).
import fs from 'node:fs';
import path from 'node:path';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ApprovalDecisionRequest, CreateProjectRequest, CreateRunRequest, PutDocumentRequest, RateRequest, ReviewDecisionRequest, SetGrantRequest, SetNetworkModeRequest, SubscribePushRequest, UpsertScheduleRequest, type AgentDetail, type AgentListResponse, type AgentSummary, type ApiError, type DashboardResponse, type EgressRecord, type HealthResponse, type ModelListResponse, type PrivacyResponse, type ReloadAgentsResponse, type ApprovalListResponse, type GrantCell, type PushSubscriptionsResponse, type ReviewListResponse, type ScheduleListResponse, type SettingsResponse, type ToolDenial, type ToolsResponse, type ToolSummary, type WorkflowDetail, type WorkflowListResponse, type WorkflowSummary } from '../../shared/api/index.js';
import type { ArtifactStore } from '../artifacts/store.js';
import { WorkspaceError } from '../util/errors.js';
import type { EventRecord } from '../../shared/events.js';
import { ConflictError, NotFoundError, ValidationError, type Engine } from '../engine/run.js';
import { ScheduleError, type Scheduler } from '../scheduler/index.js';
import type { PushStore } from '../push/store.js';
import { TERMINAL_EVENTS, type EventStore } from '../engine/events.js';
import { securityHeaders, hostOriginGuard, bearerGuard } from '../security/auth.js';
import type { Redactor } from '../security/redaction.js';
import type { Db } from '../db/index.js';
import type { Credentials } from '../security/credentials.js';
import type { Logger } from '../log/index.js';
import type { BrokenAgent, Workspace } from '../workspace/loader.js';
import type { LoadedAgent } from '../../shared/agent.js';
import { validateWorkflow, type LoadedWorkflow } from '../../shared/workflow.js';
import { toolSpec } from '../../shared/tool.js';
import { z } from 'zod';
import { PushEventKind } from '../../shared/api/index.js';
import type { BudgetOverride } from '../engine/budget.js';

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
  /** Re-reads agent definitions from disk; the Agents screen calls it after an edit. */
  reloadAgents: () => { loaded: number; errors: BrokenAgent[] };
  /** The catalog with availability; `refresh` re-polls local endpoints first. */
  models: (refresh: boolean) => Promise<ModelListResponse>;
  /** The one-click network switch (ui.md §UX rules): writes the mode to config and reloads it. */
  setNetworkMode: (mode: SetNetworkModeRequest['mode']) => void;
  /** A human granting or withdrawing a tool. This is the authority; what an agent's file asks for is not. */
  setGrant: (agentId: string, permissions: unknown) => void;
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
    const body: AgentListResponse = { agents: [...ws.agents.values()].map(agentSummary), errors: ws.brokenAgents };
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
      ...agentSummary(agent),
      sections: agent.sections,
      instructionsSource: Array.isArray(agent.definition.instructions) ? 'inline' : 'file',
      documents: agent.definition.documents,
    };
    return json(c, body);
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
        inputSchema: toolSpec(t).inputSchema,
      })),
      matrix,
      denials: denials.map((d): ToolDenial => ({
        id: d.id, runId: d.run_id, stepId: d.step_id, agentId: d.agent_id, tool: d.tool,
        decision: d.decision, reason: d.reason, errorCode: d.error_code, ts: d.ts,
      })),
      remembered: ws.config.remembered,
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
    const body: DashboardResponse = {
      needsYou: reviews.filter((r) => r.blocking),
      approvals: deps.engine.approvals.list('pending'),
      unreviewed: reviews.filter((r) => !r.blocking).length,
      failed: runs.filter((r) => r.state === 'failed' || r.state === 'interrupted').slice(0, 10),
      running: runs.filter((r) => r.state === 'running' || r.state === 'queued' || r.state === 'waiting_review'),
      spentTodayUsd: deps.engine.spentTodayUsd(),
      dailySpendCapUsd: budgets.dailySpendCapUsd,
      schedules: deps.scheduler.list().filter((s) => s.enabled).slice(0, 10),
      networkMode: deps.workspace().config.network.mode,
    };
    return json(c, body);
  });

  // ---- workflows (D-11) -----------------------------------------------------------------------
  app.get('/api/v1/workflows', (c) => {
    const ws = deps.workspace();
    const body: WorkflowListResponse = { workflows: [...ws.workflows.values()].map(workflowSummary), errors: ws.brokenWorkflows };
    return json(c, body);
  });

  app.get('/api/v1/workflows/:id', (c) => {
    const id = c.req.param('id');
    const ws = deps.workspace();
    const workflow = ws.workflows.get(id);
    if (!workflow) {
      const broken = ws.brokenWorkflows.find((b) => b.id === id);
      return fail(c, 'not_found', broken ? `Workflow "${id}" failed to load: ${broken.message}` : `Workflow "${id}" does not exist in this workspace.`, 404);
    }
    const validation = validateWorkflow(workflow.definition);
    const body: WorkflowDetail = {
      ...workflowSummary(workflow),
      definition: workflow.definition as unknown as Record<string, unknown>,
      smells: validation.smells,
      order: validation.order,
    };
    return json(c, body);
  });

  // ---- the Library (D-16) ---------------------------------------------------------------------
  app.get('/api/v1/projects', (c) => json(c, { projects: deps.artifacts.listProjects() }));

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
        const host = rows.find((r) => r.host)?.host ?? null;
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

function agentSummary(agent: LoadedAgent): AgentSummary {
  const d = agent.definition;
  return {
    id: d.id,
    name: d.name,
    description: d.description,
    version: agent.version,
    modelPolicy: { primary: d.modelPolicy.primary, fallbacks: d.modelPolicy.fallbacks, ...(d.modelPolicy.requires ? { requires: d.modelPolicy.requires as Record<string, unknown> } : {}) },
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
