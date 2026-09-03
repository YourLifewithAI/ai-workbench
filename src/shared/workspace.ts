// workspace.json and config/workbench.json (spec/architecture.md).
import { z } from 'zod';
import { Budgets, NetworkMode } from './permissions.js';

export const WorkspaceFile = z.object({ schemaVersion: z.literal(1), name: z.string().min(1), createdAt: z.string() });
export type WorkspaceFile = z.infer<typeof WorkspaceFile>;

export const WorkbenchConfig = z.object({
  schemaVersion: z.literal(1),
  network: z.object({ mode: NetworkMode, allowLocalAddresses: z.boolean() }),
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
  push: z.object({ enabled: z.boolean(), events: z.array(z.string()) }),
  grants: z.record(z.string(), z.unknown()).default({}),
  remembered: z.array(z.object({ tool: z.string(), host: z.string().optional(), path: z.string().optional() })).default([]),
});
export type WorkbenchConfig = z.infer<typeof WorkbenchConfig>;

/** A workspace file may carry any subset; the rest comes from defaults (D-20). */
export const WorkbenchConfigInput = z.object({ schemaVersion: z.literal(1) }).passthrough();

export const CredentialsFile = z.record(z.string(), z.object({ apiKey: z.string().min(1) }));
export type CredentialsFile = z.infer<typeof CredentialsFile>;
