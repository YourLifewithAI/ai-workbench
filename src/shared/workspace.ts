// workspace.json and config/workbench.json (spec/architecture.md).
import { z } from 'zod';
import { Budgets, NetworkMode } from './permissions.js';

export const WorkspaceFile = z.object({ schemaVersion: z.literal(1), name: z.string().min(1), createdAt: z.string() });
export type WorkspaceFile = z.infer<typeof WorkspaceFile>;

export const WorkbenchConfig = z.object({
  schemaVersion: z.literal(1),
  network: z.object({
    mode: NetworkMode,
    allowLocalAddresses: z.boolean(),
    /** Hostnames, label-bounded: `example.com` also matches its subdomains, `*.example.com` only subdomains. */
    allow: z.array(z.string()).default([]),
    /** Hosts a tool may POST to without an approval once the exfiltration rule exists (RUN-07). */
    approvalExempt: z.array(z.string()).default([]),
  }),
  budgets: Budgets,
  execution: z.object({
    maxParallelSteps: z.number().int().positive(),
    maxConcurrentRuns: z.number().int().positive(),
    escalation: z.enum(['sensitive-only', 'everything-once', 'approvalRequired-only']),
  }),
  retention: z.object({ scratchDays: z.number().int().nonnegative(), backups: z.number().int().nonnegative() }),
  context: z.object({
    keepRecentToolResults: z.number().int().nonnegative(),
    maxToolResultChars: z.number().int().positive(),
    memoryItems: z.number().int().nonnegative(),
    knowledgeChunks: z.number().int().nonnegative(),
  }),
  search: z.object({ provider: z.enum(['brave', 'searxng', 'mock']), searxng: z.object({ url: z.string().url() }).optional() }),
  tools: z.object({ http: z.object({ maxResponseBytes: z.number().int().positive(), timeoutMs: z.number().int().positive() }) }),
  mcp: z.object({ servers: z.array(z.unknown()) }),
  /** `name@version` strings a human has acknowledged run with full access (D-32). Nothing loads without one. */
  plugins: z.object({ trusted: z.array(z.string()).default([]) }).prefault({ trusted: [] }),
  push: z.object({ enabled: z.boolean(), events: z.array(z.string()) }),
  /**
   * Providers discovery may ask that no catalog entry names yet (D-64). OpenAI, Qwen and Kimi all speak the
   * OpenAI shape and list at `<baseUrl>/models`; a key saved under the name is what makes one of them asked.
   */
  discovery: z.object({
    providers: z.record(z.string(), z.object({ adapter: z.string(), baseUrl: z.string().url() })).default({}),
  }).prefault({ providers: {} }),
  /**
   * Which models do the work (D-68): a role is an ordered list of catalog ids, and an agent's policy may name
   * `role:<name>` instead of an id. The first model in the list that is ready is the one that runs, so the
   * shipped agents run on whichever key the owner has, and the order is chosen on a screen rather than in
   * twelve agent files.
   */
  models: z.object({ roles: z.record(z.string(), z.array(z.string())).default({}) }).prefault({ roles: {} }),
  grants: z.record(z.string(), z.unknown()).default({}),
  remembered: z.array(z.object({ tool: z.string(), host: z.string().optional(), path: z.string().optional() })).default([]),
});
export type WorkbenchConfig = z.infer<typeof WorkbenchConfig>;

/** A workspace file may carry any subset; the rest comes from defaults (D-20). */
export const WorkbenchConfigInput = z.object({ schemaVersion: z.literal(1) }).passthrough();

export const CredentialsFile = z.record(z.string(), z.object({ apiKey: z.string().min(1) }));
export type CredentialsFile = z.infer<typeof CredentialsFile>;
