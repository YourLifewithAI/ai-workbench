// One process, one port (D-21): wires workspace, database, adapters, engine, and the HTTP app together.
// An ephemeral runtime (D-45) is the same object with no files written and an OS-assigned port.
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { serve, type ServerType } from '@hono/node-server';
import type { Hono } from 'hono';
import { packagePaths, type PackagePaths } from './paths.js';
import type { Bootstrap } from './bootstrap.js';
import { loadWorkspace, type Workspace } from './workspace/loader.js';
import { Redactor } from './security/redaction.js';
import { loadCredentials, type Credentials } from './security/credentials.js';
import { generateToken, writeTokenFile, acceptedHosts } from './security/auth.js';
import { createLogger, type Logger, type LogHandle } from './log/index.js';
import { openDatabase, type Db } from './db/index.js';
import { EventStore } from './engine/events.js';
import { Engine } from './engine/run.js';
import { AdapterRegistry } from './models/adapter.js';
import { MockAdapter } from './models/adapters/mock/index.js';
import { createApp } from './api/app.js';
import { findExecutable } from './util/exec.js';

export const DEFAULT_PORT = 8787;

export interface RuntimeOptions {
  workspaceDir: string;
  bootstrap: Bootstrap;
  /** Flags beat env beat the default (spec/architecture.md §Config). */
  port?: number | undefined;
  bind?: string | undefined;
  /** Keeps the token in memory, writes neither runtime.json nor runtime.token, binds an OS-assigned port. */
  ephemeral?: boolean | undefined;
  /** `--provider mock`: every run this runtime starts uses the mock adapter (D-37). */
  providerOverride?: 'mock' | null | undefined;
  /** Extra accepted Host/Origin values, e.g. a tailnet hostname (D-60). */
  expose?: string[] | undefined;
  quietLog?: boolean | undefined;
  /** Injectable FTS5 assertion (RUN-00 DoD 7). */
  assertFts5?: ((db: Db) => void) | undefined;
}

export interface RuntimeFile { port: number; pid: number; startedAt: string }

export class Runtime {
  readonly token = generateToken();
  readonly startedAt = new Date().toISOString();
  readonly app: Hono;
  readonly log: Logger;
  private server: ServerType | null = null;
  private listening = false;
  private port = 0;
  private hosts = new Set<string>();
  private readonly shutdown = new AbortController();
  private stopped = false;

  private constructor(
    readonly opts: RuntimeOptions,
    readonly pkg: PackagePaths,
    readonly workspace: Workspace,
    readonly db: Db,
    readonly redactor: Redactor,
    readonly credentials: Credentials,
    private readonly logHandle: LogHandle,
    readonly events: EventStore,
    readonly registry: AdapterRegistry,
    readonly engine: Engine,
  ) {
    this.log = logHandle.logger;
    this.app = createApp({
      engine,
      events,
      workspace: () => this.workspace,
      credentials,
      redactor,
      log: this.log,
      token: () => this.token,
      hosts: () => this.hosts,
      health: () => ({ version: pkg.version, bind: this.bind, port: this.port, startedAt: this.startedAt }),
      denoAvailable: () => findExecutable('deno', opts.bootstrap.childEnvAllowlist['PATH']) !== null,
      uiDist: pkg.uiDist,
      shutdown: this.shutdown.signal,
    });
  }

  static async create(opts: RuntimeOptions): Promise<Runtime> {
    const pkg = packagePaths();
    const workspace = loadWorkspace(opts.workspaceDir, pkg.defaults);
    const redactor = new Redactor();
    const credentials = loadCredentials(workspace.paths.credentialsJson, redactor);
    const logHandle = createLogger(workspace.paths.logFile, redactor, { stderr: !opts.quietLog });
    let db: Db;
    try {
      const opened = await openDatabase({
        file: workspace.paths.db,
        migrationsDir: pkg.migrations,
        backupsDir: workspace.paths.backups,
        keepBackups: workspace.config.retention.backups,
        ...(opts.assertFts5 ? { assertFts5: opts.assertFts5 } : {}),
      });
      db = opened.db;
      if (opened.applied.length) logHandle.logger.info({ applied: opened.applied, backup: opened.backup }, 'database migrated');
    } catch (e) {
      await logHandle.close();
      throw e;
    }
    const events = new EventStore(db, redactor);
    const registry = new AdapterRegistry();
    registry.register(new MockAdapter(workspace.paths.fixtures));
    const engine = new Engine({ db, events, workspace: () => workspace, registry, credentials, redactor, log: logHandle.logger, providerOverride: opts.providerOverride ?? null });
    return new Runtime(opts, pkg, workspace, db, redactor, credentials, logHandle, events, registry, engine);
  }

  get bind(): string { return this.opts.bind ?? this.opts.bootstrap.bind; }
  get listeningPort(): number { return this.port; }
  get ephemeral(): boolean { return this.opts.ephemeral === true; }

  /** The one line `workbench start` prints: the token travels as a fragment, never a query string (SEC-02). */
  get url(): string {
    return `${this.baseUrl}/#token=${this.token}`;
  }

  get baseUrl(): string {
    const b = this.bind;
    const host = b === '0.0.0.0' || b === '::' || b === '' ? '127.0.0.1' : b.includes(':') ? `[${b}]` : b;
    return `http://${host}:${this.port}`;
  }

  async start(): Promise<{ port: number; url: string }> {
    if (this.listening) return { port: this.port, url: this.url };
    const requested = this.ephemeral ? 0 : (this.opts.port ?? this.opts.bootstrap.port ?? DEFAULT_PORT);
    const info = await new Promise<AddressInfo>((resolve, reject) => {
      const server = serve({ fetch: this.app.fetch, hostname: this.bind, port: requested }, resolve);
      server.once('error', (e: Error) => reject(new Error(`Could not listen on ${this.bind}:${requested}: ${e.message}`)));
      this.server = server;
    });
    this.listening = true;
    this.port = info.port;
    this.hosts = acceptedHosts(this.port, this.bind, this.opts.expose ?? []);
    if (!this.ephemeral) {
      writeTokenFile(this.workspace.paths.runtimeToken, this.token);
      const file: RuntimeFile = { port: this.port, pid: process.pid, startedAt: this.startedAt };
      fs.writeFileSync(this.workspace.paths.runtimeJson, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
    }
    this.log.info({ port: this.port, bind: this.bind, ephemeral: this.ephemeral, provider: this.opts.providerOverride ?? null, workspace: this.workspace.paths.dir }, 'runtime listening');
    return { port: this.port, url: this.url };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.shutdown.abort();
    if (this.server) {
      const server = this.server;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        if ('closeAllConnections' in server) (server as Server).closeAllConnections();
      });
    }
    if (this.listening && !this.ephemeral) {
      fs.rmSync(this.workspace.paths.runtimeJson, { force: true });
      fs.rmSync(this.workspace.paths.runtimeToken, { force: true });
    }
    this.log.info({ port: this.port }, 'runtime stopped');
    this.db.close();
    await this.logHandle.close();
  }
}
