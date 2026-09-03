// The HTTP surface (spec/api-and-cli.md): one process, one port, static SPA plus /api/v1 (D-21).
// Every JSON body leaves through the redactor (D-33). Check order: Host/Origin (403) → token (401).
import fs from 'node:fs';
import path from 'node:path';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { CreateRunRequest, type ApiError, type HealthResponse, type SettingsResponse } from '../../shared/api/index.js';
import type { EventRecord } from '../../shared/events.js';
import { NotFoundError, ValidationError, type Engine } from '../engine/run.js';
import { TERMINAL_EVENTS, type EventStore } from '../engine/events.js';
import { securityHeaders, hostOriginGuard, bearerGuard } from '../security/auth.js';
import type { Redactor } from '../security/redaction.js';
import type { Credentials } from '../security/credentials.js';
import type { Logger } from '../log/index.js';
import type { Workspace } from '../workspace/loader.js';

export interface AppDeps {
  engine: Engine;
  events: EventStore;
  workspace: () => Workspace;
  credentials: Credentials;
  redactor: Redactor;
  log: Logger;
  token: () => string;
  hosts: () => Set<string>;
  health: () => HealthResponse;
  denoAvailable: () => boolean;
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
    if (req.kind !== 'agent') return fail(c, 'validation', 'Only agent runs exist yet; workflow runs arrive in RUN-03.', 400);
    try {
      const model = req.overrides?.['model'];
      const { runId } = deps.engine.startAgentRun({ agentId: req.id, inputs: req.inputs, project: req.project, provider: req.provider, modelOverride: typeof model === 'string' ? model : undefined });
      return json(c, { runId }, 202);
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
      try {
        for (const e of deps.events.list(id, after)) send(e);
        await chain;
        if (!finished) await Promise.race([done, untilClosed(stream, deps.shutdown)]);
        await chain;
      } finally {
        unsubscribe();
      }
    });
  });

  app.get('/api/v1/runs/:id/trace.jsonl', (c) => {
    const id = c.req.param('id');
    if (!deps.engine.getRun(id)) return fail(c, 'not_found', `Run "${id}" does not exist.`, 404);
    const lines = deps.events.list(id).map(eventLine);
    return c.body(lines.join('\n') + (lines.length ? '\n' : ''), 200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
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
