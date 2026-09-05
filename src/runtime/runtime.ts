// One process, one port (D-21): wires workspace, database, adapters, engine, and the HTTP app together.
// An ephemeral runtime (D-45) is the same object with no files written and an OS-assigned port.
import fs from 'node:fs';
import path from 'node:path';
import { ulid } from 'ulid';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { serve, type ServerType } from '@hono/node-server';
import type { Hono } from 'hono';
import { packagePaths, type PackagePaths } from './paths.js';
import type { Bootstrap } from './bootstrap.js';
import { loadAgents, loadWorkflows, loadWorkspace, type BrokenAgent, type Workspace } from './workspace/loader.js';
import { createWorkflow, deleteWorkflowFile, saveWorkflow, WorkflowWriteError } from './workspace/workflows.js';
import { FindingStore, logGrantChange } from './permissions/store.js';
import { applyProposal, DEFAULT_THRESHOLDS, gatherFacts, recordCatalogSeen, type PermissionFacts, type ReviewThresholds } from './permissions/review.js';
import { proposeFindings } from './permissions/propose.js';
import { grantFor } from './security/permissions.js';
import { Redactor } from './security/redaction.js';
import { writeSecretFile } from './security/secretFile.js';
import { loadCredentials, type Credentials } from './security/credentials.js';
import { generateToken, writeTokenFile, acceptedHosts } from './security/auth.js';
import { createLogger, type Logger, type LogHandle } from './log/index.js';
import { openDatabase, type Db } from './db/index.js';
import { EventStore } from './engine/events.js';
import { Scheduler } from './scheduler/index.js';
import { PushStore, type PushSender } from './push/store.js';
import { ensureVapidKeys, type VapidKeys } from './push/vapid.js';
import type { MockSearchFixture } from './search/index.js';
import { DEFAULT_LIMITS, findDeno, Sandbox } from './sandbox/deno.js';
import { McpHost } from './mcp/host.js';
import { PluginLoader, type PluginStatus } from './plugins/loader.js';
import { WorkspaceError } from './util/errors.js';
import type { LookupFn } from './security/dns.js';
import type { NetConnector } from './security/netfetch.js';
import type { EgressAttempt, EgressDecision } from './security/egress.js';
import { Engine, ConflictError, NotFoundError, ValidationError } from './engine/run.js';
import { AdapterRegistry, type FetchLike } from './models/adapter.js';
import { MockAdapter } from './models/adapters/mock/index.js';
import { MockUpstream } from './models/adapters/mock/upstream.js';
import { GoogleAdapter } from './models/adapters/google/index.js';
import { AnthropicAdapter } from './models/adapters/anthropic/index.js';
import { OpenAiCompatibleAdapter } from './models/adapters/openai-compatible/index.js';
import { createApp } from './api/app.js';
import { ArtifactStore } from './artifacts/store.js';
import { listModels, pollLocalEndpoints, providerOf, type PollResult } from './models/availability.js';
import { applyFinding, diffProvider, pinsFor } from './models/discovery.js';
import type { CatalogFinding, CreateWorkflowRequest, DeleteWorkflowResponse, DiscoveryReport, PermissionFinding } from '../shared/api/index.js';
import { Workflow, type LoadedWorkflow } from '../shared/workflow.js';
import { ModelsFile, type CatalogEntry } from '../shared/model.js';
import { EgressDeniedError } from './security/egress.js';
import { ModelError } from './models/errors.js';
import { createEgressFetch } from './security/egress.js';
import { directFetch } from './models/fetch.js';
import type { ModelListResponse } from '../shared/api/index.js';
import type { WorkbenchConfig } from '../shared/workspace.js';

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
  /** The fetch every adapter call receives; RUN-02 passes the egress checker, tests pass a replay. */
  fetch?: FetchLike | undefined;
  /** The scheduler's clock. A test drives it forward; production leaves it alone (D-15). */
  now?: (() => Date) | undefined;
  /** Leaves the scheduler's loop stopped, so a test can call `tick()` when it means to. */
  noScheduler?: boolean | undefined;
  /** Injected so a test can see what a notification would carry without a push service (SEC-32). */
  sendPush?: PushSender | undefined;
  /** Injected so a test resolves `*.test` to a TEST-NET-3 address with no DNS server (SEC-17). */
  lookup?: LookupFn | undefined;
  /** Pins the sandbox's Deno for a test — or removes it, with `null`, to see what happens when it is missing. */
  denoPath?: string | null | undefined;
  /** Injected so a test dials a local server while the checker still sees the pinned public address. */
  connect?: NetConnector | undefined;
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
  readonly mockUpstream = new MockUpstream();
  private polled: PollResult | null = null;
  /** The last refresh's findings, minus what a person has accepted or dismissed since (D-64). */
  private findings: CatalogFinding[] | null = null;
  private stopped = false;
  readonly scheduler: Scheduler;
  readonly push: PushStore;
  private readonly vapid: VapidKeys;

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
    private readonly portRef: { current: number | null },
    readonly artifacts: ArtifactStore,
    readonly mcp: McpHost,
    readonly sandbox: Sandbox,
    /** What the plugin loader found at startup: loaded, refused, or waiting to be acknowledged (D-32). */
    readonly plugins: PluginStatus[],
    /** What the permissions review proposed and what the person did with it (D-63). */
    readonly reviewFindings: FindingStore,
  ) {
    this.log = logHandle.logger;
    // Generated once per workspace and kept at 0600 next to the runtime token: whoever holds these can send
    // notifications as this workbench.
    this.vapid = ensureVapidKeys(workspace.paths.dir, redactor);
    this.push = new PushStore({
      db,
      log: this.log,
      keys: () => this.vapid,
      enabled: () => this.workspace.config.push.enabled,
      ...(opts.sendPush ? { send: opts.sendPush } : {}),
    });
    engine.attachPush(this.push);
    this.scheduler = new Scheduler({
      db,
      log: this.log,
      start: (input) => {
        const started = engine.startWorkflowRun(input);
        engine.markScheduled(started.runId);
        return started;
      },
      ...(opts.now ? { now: opts.now } : {}),
    });
    this.app = createApp({
      engine,
      scheduler: this.scheduler,
      events,
      workspace: () => this.workspace,
      credentials,
      redactor,
      log: this.log,
      token: () => this.token,
      hosts: () => this.hosts,
      health: () => ({ version: pkg.version, bind: this.bind, port: this.port, startedAt: this.startedAt }),
      denoAvailable: () => this.sandbox.available,
      plugins: () => this.plugins.map((p) => ({ ...p })),
      writeAgent: (definition, sections) => this.writeAgent(definition, sections),
      writeWorkflow: (workflow) => this.writeWorkflow(workflow),
      saveWorkflow: (id, raw, baseVersion) => this.saveWorkflow(id, raw, baseVersion),
      createWorkflow: (body) => this.createWorkflow(body),
      deleteWorkflow: (id, deleteSchedules) => this.deleteWorkflow(id, deleteSchedules),
      trustPlugin: (key) => this.trustPlugin(key),
      setCredential: (name, apiKey) => this.setCredential(name, apiKey),
      updateSettings: (patch) => this.updateSettings(patch),
      sandbox: () => ({ available: this.sandbox.available, path: this.sandbox.path, limits: DEFAULT_LIMITS }),
      mcp: { status: () => this.mcp.status() },
      reloadAgents: () => this.reloadAgents(),
      models: (refresh) => this.models(refresh),
      acceptFinding: (id) => this.acceptFinding(id),
      dismissFinding: (id) => this.dismissFinding(id),
      setPrice: (id, price) => this.setPrice(id, price),
      setEnabled: (id, enabled) => this.setEnabled(id, enabled),
      artifacts,
      setNetworkMode: (mode) => this.setNetworkMode(mode),
      setGrant: (agentId, permissions) => this.setGrant(agentId, permissions),
      findings: { list: (state) => this.reviewFindings.list(state), decide: (id, decision) => this.decideFinding(id, decision) },
      push: this.push,
      vapidPublicKey: () => this.vapid.publicKey,
      db,
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
    registry.register(new GoogleAdapter());
    registry.register(new AnthropicAdapter());
    registry.register(new OpenAiCompatibleAdapter());
    const artifacts = new ArtifactStore(db, workspace.paths.projects, redactor);
    // A project directory shipped by `init` (or copied in) becomes a real project on first start.
    artifacts.adoptProjectDirectories();

    // The port is only known after listen(), and the checker needs it to refuse calls back into the runtime.
    const portRef: { current: number | null } = { current: null };
    // Deno is found once, at startup: a workbench that gains an execute tier halfway through a run because
    // something appeared on PATH would be harder to reason about than one that needs a restart.
    const sandbox = new Sandbox(opts.denoPath === null ? null : findDeno(opts.bootstrap.childEnvAllowlist['PATH'], opts.denoPath ?? undefined));
    const mcpHost = new McpHost({
      servers: () => workspace.config.mcp.servers,
      childEnvAllowlist: opts.bootstrap.childEnvAllowlist,
      log: logHandle.logger,
    });
    const factsByRun = new Map<string, PermissionFacts>();
    const engine: Engine = new Engine({
      db, events, workspace: () => workspace, registry, credentials, redactor,
      log: logHandle.logger, providerOverride: opts.providerOverride ?? null,
      runtimePort: () => portRef.current,
      artifacts,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.now ? { now: opts.now } : {}),
      persistConfig: (config) => runtime.persistConfig(config),
      sandbox,
      childEnvAllowlist: opts.bootstrap.childEnvAllowlist,
      mcp: mcpHost,
      // The auditor's tools (RUN-14). The facts a run was shown are kept by run id, so what it proposes is
      // judged against the candidates it saw, at the thresholds it asked for.
      permissionsReview: {
        facts: (thresholds, runId) => { const facts: PermissionFacts = runtime.permissionFacts(thresholds); factsByRun.set(runId, facts); return facts; },
        propose: (findings, runId) => {
          const facts: PermissionFacts = factsByRun.get(runId) ?? runtime.permissionFacts();
          factsByRun.delete(runId);
          return proposeFindings(runtime.reviewFindings, facts, findings, runId);
        },
      },
      // Tool egress writes the same egress_log rows a model call does, so the Privacy Inspector shows one story.
      net: {
        record: (attempt, decision) => runtime.recordEgress(attempt, decision),
        ...(opts.lookup ? { lookup: opts.lookup } : {}),
        ...(opts.connect ? { connect: opts.connect } : {}),
      },
      searchFixture: () => {
        const file = path.join(workspace.paths.fixtures, 'search', 'results.json');
        if (!fs.existsSync(file)) return null;
        try {
          return JSON.parse(fs.readFileSync(file, 'utf8')) as MockSearchFixture;
        } catch (e) {
          logHandle.logger.warn({ err: e, file }, 'fixtures/search/results.json is not valid JSON');
          return null;
        }
      },
    });
    // Plugins are trusted code with this process's authority, so they load once, at startup, after a human has
    // acknowledged the exact version — and never as a side effect of a request (D-32).
    const loader = new PluginLoader({
      pluginsDir: workspace.paths.plugins,
      log: logHandle.logger,
      acknowledged: () => workspace.config.plugins.trusted,
    });
    const plugins = await loader.load();
    for (const adapter of plugins.adapters) registry.register(adapter);

    const runtime: Runtime = new Runtime(opts, pkg, workspace, db, redactor, credentials, logHandle, events, registry, engine, portRef, artifacts, mcpHost, sandbox, plugins.statuses, new FindingStore(db));
    // Configured MCP servers are spawned once, here, and their tools join the catalogue before anything runs.
    // A server that fails to start is on the Tools screen and in `doctor`; it does not stop the runtime.
    engine.tools.add(await mcpHost.start());
    engine.tools.add(plugins.tools);
    // Every tool now in the catalogue gets a first-seen date, once, so "undecided" can mean "new" (RUN-14).
    recordCatalogSeen(db, engine.tools.catalog());
    return runtime;
  }

  /**
   * The catalog with live availability. Local endpoints are polled rather than assumed, through the same egress
   * checker a model call uses, so a poll in offline mode is refused like any other call.
   */
  async models(refresh: boolean): Promise<ModelListResponse> {
    if (refresh || this.polled === null) {
      const config = this.workspace.config;
      const fetchImpl = createEgressFetch({
        real: this.opts.fetch ?? directFetch,
        policy: () => ({ mode: config.network.mode, allow: config.network.allow, allowLocalAddresses: config.network.allowLocalAddresses, runtimePort: this.portRef.current }),
        record: () => undefined, // a listing carries none of the workspace's data, so it is not an egress the Inspector shows
      }, { purpose: 'model', declared: true, categories: [] });
      this.polled = await pollLocalEndpoints(this.workspace.catalog, fetchImpl);
    }
    const discovery = refresh ? await this.discover() : undefined;
    const models = listModels({
      catalog: this.workspace.catalog,
      mode: this.workspace.config.network.mode,
      hasAdapter: (id) => this.registry.has(id),
      hasCredential: (provider) => this.credentials.get(provider) !== undefined,
      reachableEndpoints: this.polled.reachable,
    });
    return {
      models, networkMode: this.workspace.config.network.mode, pulled: Object.fromEntries(this.polled.pulled),
      findings: this.findings ?? [],
      ...(discovery ? { discovery } : {}),
    };
  }

  /**
   * Ask every provider that can be asked what it offers, and turn the differences into findings (D-64).
   * Nothing here writes: a finding is a proposal until `acceptFinding`. In offline mode nothing is asked and
   * no socket opens — the refusal is reported per provider as `NetworkPolicy`, the same code a model call gets.
   */
  private async discover(): Promise<DiscoveryReport> {
    const report: DiscoveryReport = { checked: [], errors: [] };
    const mock = this.opts.providerOverride === 'mock';
    // provider → adapter. From the catalog first; then any adapter that can list speaks for a provider of its
    // own name, so a workspace with no google entries at all can still learn what google offers.
    const config = this.workspace.config;
    const providers = new Map<string, string>();
    if (mock) {
      for (const p of this.mockAdapter.discoveryProviders()) providers.set(p, 'mock');
    } else {
      for (const entry of this.workspace.catalog.models) if (entry.adapter !== 'mock') providers.set(providerOf(entry.id), entry.adapter);
      for (const id of this.registry.ids()) if (this.registry.get(id)?.listModels && !providers.has(id)) providers.set(id, id);
      // Providers config names that no entry does yet — OpenAI, Qwen, Kimi — so a key alone is enough to ask.
      for (const [name, cfg] of Object.entries(config.discovery.providers)) if (!providers.has(name)) providers.set(name, cfg.adapter);
    }
    // Where an OpenAI-compatible provider is asked: the configured endpoint, or the one its entries already name.
    const baseUrls = new Map<string, string>();
    for (const [name, cfg] of Object.entries(config.discovery.providers)) baseUrls.set(name, cfg.baseUrl);
    for (const entry of this.workspace.catalog.models) if (entry.baseUrl && !baseUrls.has(providerOf(entry.id))) baseUrls.set(providerOf(entry.id), entry.baseUrl);
    const realAdapter = (provider: string): string =>
      this.workspace.catalog.models.find((m) => providerOf(m.id) === provider)?.adapter ?? config.discovery.providers[provider]?.adapter ?? provider;

    const pins = pinsFor({
      agents: [...this.workspace.agents.values()].map((a) => ({ id: a.definition.id, primary: a.definition.modelPolicy.primary, fallbacks: a.definition.modelPolicy.fallbacks })),
      workflows: [...this.workspace.workflows.values()].map((w) => ({ id: w.definition.id, steps: w.definition.steps.map((s) => ({ id: s.id, model: (s as { model?: string | undefined }).model })) })),
    });
    const dismissed = new Map((this.db.prepare('SELECT finding_id, facts_hash FROM catalog_finding_dismissals').all() as { finding_id: string; facts_hash: string }[]).map((r) => [r.finding_id, r.facts_hash]));
    const found: CatalogFinding[] = [];
    const now = new Date();

    for (const [provider, adapterId] of providers) {
      const adapter = this.registry.get(adapterId);
      if (!adapter?.listModels) continue; // cannot list: its models stay hand-declared, and that is not an error
      const apiKey = mock ? 'mock' : this.credentials.get(provider);
      if (!apiKey) continue; // not asked: a provider with no key has nothing to compare against
      if (config.network.mode === 'offline') {
        report.errors.push({ provider, code: 'NetworkPolicy', message: 'Network mode is offline, so nothing was asked and no socket was opened.' });
        continue;
      }
      report.checked.push(provider);
      const fetchImpl = createEgressFetch({
        real: this.opts.fetch ?? directFetch,
        policy: () => ({ mode: config.network.mode, allow: config.network.allow, allowLocalAddresses: config.network.allowLocalAddresses, runtimePort: this.portRef.current }),
        record: () => undefined, // a listing carries none of the workspace's data
      }, { purpose: 'model', declared: true, categories: [] });
      try {
        const baseUrl = baseUrls.get(provider);
        const discovered = await adapter.listModels({ fetch: fetchImpl, apiKey, runId: undefined, provider, ...(baseUrl ? { baseUrl } : {}) });
        const adapterFor = mock ? realAdapter(provider) : adapterId;
        found.push(...diffProvider({
          catalog: this.workspace.catalog, provider, adapter: adapterFor, discovered, pins, now,
          ...(adapterFor === 'openai-compatible' && baseUrl ? { baseUrl } : {}),
        }));
      } catch (e) {
        const code = e instanceof EgressDeniedError ? 'NetworkPolicy' : e instanceof ModelError ? e.code : 'Unknown';
        report.errors.push({ provider, code, message: (e as Error).message });
      }
    }
    this.findings = found.filter((f) => dismissed.get(f.id) !== f.factsHash);
    return report;
  }

  /** Accepts one finding: the catalog is rewritten exactly as a hand edit would, validated first (D-64). */
  async acceptFinding(id: string): Promise<ModelListResponse | null> {
    const finding = this.findings?.find((f) => f.id === id);
    if (!finding) return null;
    const next = ModelsFile.parse(applyFinding(this.workspace.catalog, finding, new Date()));
    fs.writeFileSync(this.workspace.paths.modelsJson, JSON.stringify(next, null, 2) + '\n');
    // In place: the engine and the tools hold a reference to this catalog, the same way they hold the config.
    this.workspace.catalog.models.splice(0, this.workspace.catalog.models.length, ...next.models);
    this.findings = this.findings!.filter((f) => f.id !== id);
    this.polled = null;
    this.log.info({ finding: id, kind: finding.kind, model: finding.modelId }, 'catalog finding accepted');
    return this.models(false);
  }

  /** A price typed in on the Models screen: one more row, in effect from now, the way a hand edit adds one (D-65). */
  async setPrice(id: string, price: { inputPerM: number; outputPerM: number; cachedPerM?: number | undefined }): Promise<ModelListResponse | null> {
    return this.editCatalog(id, (entry) => ({
      ...entry,
      pricing: [...entry.pricing, { effectiveFrom: new Date().toISOString(), inputPerM: price.inputPerM, outputPerM: price.outputPerM, ...(price.cachedPerM !== undefined ? { cachedPerM: price.cachedPerM } : {}) }],
    }));
  }

  /** Enable or disable one entry from the Models screen: the `enabled` flag a hand edit would flip. */
  async setEnabled(id: string, enabled: boolean): Promise<ModelListResponse | null> {
    return this.editCatalog(id, (entry) => ({ ...entry, enabled }));
  }

  private async editCatalog(id: string, edit: (entry: CatalogEntry) => CatalogEntry): Promise<ModelListResponse | null> {
    const index = this.workspace.catalog.models.findIndex((m) => m.id === id);
    if (index === -1) return null;
    const models = this.workspace.catalog.models.map((m, i) => (i === index ? edit(m) : m));
    const next = ModelsFile.parse({ schemaVersion: 1, models });
    fs.writeFileSync(this.workspace.paths.modelsJson, JSON.stringify(next, null, 2) + '\n');
    this.workspace.catalog.models.splice(0, this.workspace.catalog.models.length, ...next.models);
    this.polled = null;
    this.log.info({ model: id }, 'catalog entry edited from the Models screen');
    return this.models(false);
  }

  /** Dismisses one finding until the provider's facts behind it change (D-64). */
  async dismissFinding(id: string): Promise<ModelListResponse | null> {
    const finding = this.findings?.find((f) => f.id === id);
    if (!finding) return null;
    this.db.prepare('INSERT INTO catalog_finding_dismissals (finding_id, facts_hash, dismissed_at) VALUES (?, ?, ?) ON CONFLICT(finding_id) DO UPDATE SET facts_hash = excluded.facts_hash, dismissed_at = excluded.dismissed_at')
      .run(id, finding.factsHash, new Date().toISOString());
    this.findings = this.findings!.filter((f) => f.id !== id);
    return this.models(false);
  }

  /** Writes the mode into config/workbench.json so it survives a restart, then applies it in place. */
  setNetworkMode(mode: WorkbenchConfig['network']['mode']): void {
    const file = this.workspace.paths.workbenchJson;
    const current = JSON.parse(fs.readFileSync(file, 'utf8')) as { network?: Record<string, unknown> };
    current.network = { ...(current.network ?? {}), mode };
    fs.writeFileSync(file, JSON.stringify(current, null, 2) + '\n');
    this.workspace.config.network.mode = mode;
    this.polled = null; // availability depends on the mode, so the next listing re-polls
  }

  /**
   * Writes back only the keys the runtime edits — grants, remembered approvals, network mode — so a hand-edited
   * `workbench.json` keeps its comments-adjacent shape and its unset keys stay unset (defaults still apply).
   */
  /**
   * An imported agent, written to disk as files like any other (D-34). Its permissions arrive as *requests* —
   * `stripAgentTrust` has already made sure of that — and the grant matrix in `config/workbench.json` is
   * untouched, because a file someone sent you is not an authorization.
   */
  writeAgent(definition: unknown, sections: { name: string; text: string }[]): { id: string } {
    const agent = definition as { id: string; instructions?: unknown };
    const dir = path.join(this.workspace.paths.agents, agent.id);
    if (fs.existsSync(dir)) throw new WorkspaceError(dir, `There is already an agent called "${agent.id}". Rename one of them.`);
    fs.mkdirSync(dir, { recursive: true });
    const file = { ...agent, instructions: { file: 'instructions.md' } };
    fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify(file, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'instructions.md'), sections.map((s) => `## ${s.name}\n\n${s.text.trim()}\n`).join('\n'));
    this.reloadAgents();
    return { id: agent.id };
  }

  writeWorkflow(workflow: unknown): { id: string } {
    const definition = workflow as { id: string };
    const file = path.join(this.workspace.paths.workflows, `${definition.id}.workflow.json`);
    if (fs.existsSync(file)) throw new WorkspaceError(file, `There is already a workflow called "${definition.id}". Rename one of them.`);
    fs.writeFileSync(file, JSON.stringify(definition, null, 2) + '\n');
    this.reloadAgents();
    return { id: definition.id };
  }

  /**
   * The editor's save (RUN-13, D-62): validate, refuse a file that moved, write, record the hash. The base
   * the conflict diff is drawn against is whatever this runtime still knows for that hash — the copy in
   * memory when nothing reloaded in between, else the row a run pinned — and the draft when it knows neither.
   */
  saveWorkflow(id: string, raw: unknown, baseVersion: string): LoadedWorkflow {
    const loaded = saveWorkflow({
      workflowsDir: this.workspace.paths.workflows, id, raw, baseVersion,
      knownVersion: (hash) => {
        const inMemory = this.workspace.workflows.get(id);
        if (inMemory?.version === hash) return inMemory.definition;
        const row = this.db.prepare('SELECT definition_json FROM workflow_versions WHERE hash = ?').get(hash) as { definition_json: string } | undefined;
        if (!row) return null;
        const parsed = Workflow.safeParse(JSON.parse(row.definition_json));
        return parsed.success ? parsed.data : null;
      },
    });
    this.recordWorkflowVersion(loaded);
    this.reloadAgents();
    this.log.info({ workflowId: id, version: loaded.version }, 'a workflow was saved from the editor');
    return loaded;
  }

  createWorkflow(body: CreateWorkflowRequest): LoadedWorkflow {
    let copyOf: Workflow | undefined;
    if (body.copyOf !== undefined) {
      const source = this.workspace.workflows.get(body.copyOf);
      if (!source) throw new WorkflowWriteError('not_found', `There is no workflow called "${body.copyOf}" to copy.`);
      copyOf = source.definition;
    }
    // A blank workflow's one step has to name an agent; the echo agent when the workspace has it, else the
    // first by name. It is a placeholder the editor opens on, not a recommendation.
    const agents = [...this.workspace.agents.keys()].sort();
    const firstAgent = agents.includes('echo') ? 'echo' : agents[0];
    if (!firstAgent) throw new WorkflowWriteError('validation', 'A workflow step names an agent, and this workspace has none yet. Add an agent first.');
    const loaded = createWorkflow({ workflowsDir: this.workspace.paths.workflows, id: body.id, name: body.name, copyOf, firstAgent });
    this.recordWorkflowVersion(loaded);
    this.reloadAgents();
    this.log.info({ workflowId: body.id, copyOf: body.copyOf ?? null }, 'a workflow was created');
    return loaded;
  }

  /** Deleting a workflow that a schedule points at is refused until the count has been shown and accepted. */
  deleteWorkflow(id: string, deleteSchedules: boolean): DeleteWorkflowResponse {
    const file = path.join(this.workspace.paths.workflows, `${id}.workflow.json`);
    if (!fs.existsSync(file)) throw new WorkflowWriteError('not_found', `There is no workflow called "${id}".`);
    const schedules = this.scheduler.list().filter((s) => s.workflowId === id);
    if (schedules.length && !deleteSchedules) {
      throw new WorkflowWriteError('conflict',
        `"${id}" has ${schedules.length} schedule${schedules.length === 1 ? '' : 's'} pointing at it. Deleting the workflow deletes ${schedules.length === 1 ? 'that schedule' : 'them'} too; say so to go ahead.`,
        { schedules: schedules.length });
    }
    for (const s of schedules) this.scheduler.remove(s.id);
    deleteWorkflowFile(this.workspace.paths.workflows, id);
    this.reloadAgents();
    this.log.info({ workflowId: id, schedules: schedules.length }, 'a workflow was deleted');
    return { deleted: true, schedules: schedules.length };
  }

  /** The same row a run records at start, so a hash the editor produced is one the diff can be drawn against. */
  private recordWorkflowVersion(workflow: LoadedWorkflow): void {
    this.db.prepare('INSERT OR IGNORE INTO workflow_versions (hash, workflow_id, definition_json, created_at) VALUES (?, ?, ?, ?)')
      .run(workflow.version, workflow.definition.id, JSON.stringify(workflow.definition), new Date().toISOString());
  }

  /** A human accepting "this code runs with full access", for one plugin and one version (D-32). */
  trustPlugin(key: string): void {
    const file = this.workspace.paths.workbenchJson;
    const current = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const trusted = new Set([...((current['plugins'] as { trusted?: string[] } | undefined)?.trusted ?? []), key]);
    current['plugins'] = { trusted: [...trusted].sort() };
    fs.writeFileSync(file, JSON.stringify(current, null, 2) + '\n');
  }

  /**
   * The credentials editor (SEC-05). The value goes into the 0600 file and is never read back out of it: the
   * API answers with the *names* that are configured, and nothing this runtime serves can show a key.
   */
  setCredential(name: string, apiKey: string | null): void {
    const file = this.workspace.paths.credentialsJson;
    const current = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, { apiKey: string }>) : {};
    if (apiKey === null) delete current[name];
    else current[name] = { apiKey };
    const written = writeSecretFile(file, JSON.stringify(current, null, 2) + '\n');
    if (!written.protected) {
      throw new Error(`The credential was written but could not be restricted to your account (${written.detail}).` +
        `${written.fix ? ` Run: ${written.fix}` : ''}`);
    }
    if (!written.verified) {
      // Applied but not readable back. Refusing would strand an owner over a locale; saying nothing would let
      // "the workbench protected it" stand on a claim it did not check.
      this.log.warn({ file }, `${file}: the protection was applied but could not be confirmed (${written.detail}).`);
    }
    // Immediately, not on the next start: until this runs the runtime does not know the key exists and does not
    // redact it, so a key saved mid-session could land in the next trace in full.
    this.credentials.reload();
  }

  /** The parts of `config/workbench.json` Settings may edit. Grants are not among them: those are the matrix. */
  updateSettings(patch: Record<string, unknown>): void {
    const file = this.workspace.paths.workbenchJson;
    const current = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    for (const key of ['budgets', 'retention', 'execution', 'mcp', 'push'] as const) {
      const value = patch[key];
      if (value === undefined) continue;
      current[key] = typeof current[key] === 'object' && current[key] !== null && !Array.isArray(current[key])
        ? { ...(current[key] as Record<string, unknown>), ...(value as Record<string, unknown>) }
        : value;
    }
    fs.writeFileSync(file, JSON.stringify(current, null, 2) + '\n');
    // The in-memory config is mutated in place rather than replaced, the same way the network mode is: the
    // engine and the tools hold a reference to this object, and swapping it would leave them on the old one.
    const reloaded = loadWorkspace(this.workspace.paths.dir, this.pkg.defaults);
    Object.assign(this.workspace.config, reloaded.config);
  }

  persistConfig(config: WorkbenchConfig): void {
    const file = this.workspace.paths.workbenchJson;
    const current = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    current['grants'] = config.grants;
    current['remembered'] = config.remembered;
    fs.writeFileSync(file, JSON.stringify(current, null, 2) + '\n');
  }

  /** One egress row, whether it was a model call or a tool's fetch. The Inspector reads them together (D-28). */
  recordEgress(attempt: EgressAttempt, decision: EgressDecision): void {
    this.db.prepare(`INSERT INTO egress_log (id, run_id, step_id, purpose, host, ip, method, data_categories, bytes, body_redacted, decision, reason, ts)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`).run(
      ulid(), attempt.runId ?? null, attempt.stepId ?? null, attempt.purpose, decision.host, attempt.method,
      attempt.categories.join(','), attempt.bytes, this.redactor.redactJson(attempt.bodyRedacted),
      decision.allowed ? 'allowed' : 'denied', decision.reason, new Date().toISOString(),
    );
    if (!decision.allowed && attempt.runId) {
      this.events.append(attempt.runId, attempt.stepId ?? null, 'egress-denied', { host: decision.host, reason: decision.reason, url: attempt.url, purpose: attempt.purpose });
    }
  }

  /** A human granting or withdrawing a tool. This is the authority; what an agent's own file asks for is not. */
  setGrant(agentId: string, permissions: unknown): void {
    const before = grantFor(this.workspace.config, agentId);
    this.workspace.config.grants[agentId] = permissions;
    this.persistConfig(this.workspace.config);
    // The audit log the review reads for "since when": one row per field that moved, always by a human.
    const rows = logGrantChange(this.db, agentId, before, grantFor(this.workspace.config, agentId));
    this.log.info({ agentId, changed: rows }, 'a grant changed');
  }

  /** What the auditor sees (D-63): grant metadata and how it was used, never a trace, a memory or a document. */
  permissionFacts(thresholds: Partial<ReviewThresholds> = {}): PermissionFacts {
    return gatherFacts({ db: this.db, workspace: () => this.workspace, tools: () => this.engine.tools.catalog() }, { ...DEFAULT_THRESHOLDS, ...thresholds });
  }

  /**
   * The person deciding a finding. Apply is a matrix write by the human — through `setGrant`, the same door the
   * Tools screen uses, and logged the same way. Dismiss remembers the facts, so the finding stays quiet until
   * they change. No agent reaches this: it sits behind the token like every other route.
   */
  decideFinding(id: string, decision: 'apply' | 'dismiss'): PermissionFinding {
    const finding = this.reviewFindings.get(id);
    if (!finding) throw new NotFoundError(`There is no finding with id "${id}".`);
    if (finding.state !== 'open') throw new ConflictError(`That finding was already ${finding.state}.`);
    if (decision === 'dismiss') return this.reviewFindings.decide(id, 'dismissed')!;
    if (!finding.proposal) throw new ValidationError('This finding has nothing to apply: it is worth reading, and the change, if any, is yours to make on the Tools screen. Dismiss it when you have.');
    if (!this.workspace.agents.has(finding.proposal.agentId)) throw new NotFoundError(`Agent "${finding.proposal.agentId}" is no longer in this workspace.`);
    this.setGrant(finding.proposal.agentId, applyProposal(grantFor(this.workspace.config, finding.proposal.agentId), finding.proposal));
    this.log.info({ finding: id, agentId: finding.proposal.agentId, tool: finding.proposal.tool ?? null }, 'a permissions finding was applied');
    return this.reviewFindings.decide(id, 'applied')!;
  }

  /** Picks up edits to agent.json and instructions.md without a restart; a broken file becomes a listed error. */
  /** The scripted provider, for tests that need to see exactly which calls were made (D-37). */
  get mockAdapter(): MockAdapter {
    return this.registry.get('mock') as MockAdapter;
  }

  /** Agents and workflows reload together: a workflow names agents, so half a reload is a confusing workspace. */
  reloadAgents(): { loaded: number; errors: BrokenAgent[] } {
    const { agents, broken } = loadAgents(this.workspace.paths.agents);
    this.workspace.agents = agents;
    this.workspace.brokenAgents = broken;
    const workflows = loadWorkflows(this.workspace.paths.workflows);
    this.workspace.workflows = workflows.workflows;
    this.workspace.brokenWorkflows = workflows.broken;
    (this.registry.get('mock') as MockAdapter | undefined)?.reload();
    this.log.info({ loaded: agents.size, errors: broken.length, workflows: workflows.workflows.size }, 'agents and workflows reloaded');
    return { loaded: agents.size, errors: broken };
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
    this.portRef.current = info.port;
    // Anything the last process left `running` never finished (D-14 §Resume). Correct it before serving.
    this.engine.markInterrupted();
    // A workflow file's `schedule` block seeds a row once; after that the row is the owner's to edit (D-15).
    this.scheduler.seedFromWorkflows(this.workspace.workflows.values());
    if (!this.opts.noScheduler) this.scheduler.start();
    // Silence is not consent: a pending approval nobody answers has to become a denial on its own (SEC-12).
    // Deliberately outside the `noScheduler` guard. That flag means "do not fire scheduled workflow runs",
    // which tests set for determinism — and while expiry lived inside it, 39 test workspaces were also
    // switching off a security property, in the one configuration every test runs in. A safety net that
    // disappears whenever the thing being tested is made deterministic is a safety net with no test.
    this.engine.startApprovalExpiry();
    await this.startMockUpstream();
    this.hosts = acceptedHosts(this.port, this.bind, this.opts.expose ?? []);
    if (!this.ephemeral) {
      // The token is what a browser or the CLI presents instead of a password. Starting anyway when it cannot
      // be locked down is the right trade — a workbench nobody can reach is not safer — but it is said out
      // loud, in the log and on stderr, because the owner is the only one who can fix it.
      const token = writeTokenFile(this.workspace.paths.runtimeToken, this.token);
      if (token.protected && !token.verified) {
        this.log.warn({ file: this.workspace.paths.runtimeToken },
          `${this.workspace.paths.runtimeToken}: the protection was applied but could not be confirmed (${token.detail}).`);
      }
      if (!token.protected) {
        const message = `${this.workspace.paths.runtimeToken} could not be restricted to your account (${token.detail}). ` +
          `Anyone who can read it can use this runtime.${token.fix ? ` Run: ${token.fix}` : ''}`;
        this.log.warn({ file: this.workspace.paths.runtimeToken }, message);
        process.stderr.write(`workbench: ${message}\n`);
      }
      // Not a secret — port, pid and start time — but it says where the runtime is, so it gets the same 0600.
      const file: RuntimeFile = { port: this.port, pid: process.pid, startedAt: this.startedAt };
      fs.writeFileSync(this.workspace.paths.runtimeJson, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
    }
    this.log.info({ port: this.port, bind: this.bind, ephemeral: this.ephemeral, provider: this.opts.providerOverride ?? null, workspace: this.workspace.paths.dir }, 'runtime listening');
    return { port: this.port, url: this.url };
  }

  /**
   * Any catalog entry served by the mock that declares a `baseUrl` is repointed at a loopback listener started
   * here, so the declared-endpoint path is real in tests and demos rather than mocked away (D-37).
   */
  private async startMockUpstream(): Promise<void> {
    const needsUpstream = this.workspace.catalog.models.some((m) => m.adapter === 'mock' && m.baseUrl);
    if (!needsUpstream) return;
    await this.mockUpstream.start();
    for (const model of this.workspace.catalog.models) {
      if (model.adapter === 'mock' && model.baseUrl) model.baseUrl = this.mockUpstream.baseUrl;
    }
    this.log.info({ port: this.mockUpstream.port }, 'mock upstream listening');
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.scheduler.stop();
    this.engine.stopApprovalExpiry();
    await this.mcp.stop();
    this.shutdown.abort();
    await this.mockUpstream.stop();
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
