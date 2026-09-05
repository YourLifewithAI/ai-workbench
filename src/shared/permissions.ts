// Permissions and budgets (spec/tools-and-security.md, spec/workflows-and-execution.md).
import { z } from 'zod';
import { RepoGrant } from './repo.js';

export const NetworkMode = z.enum(['offline', 'local-only', 'allowlist', 'unrestricted']);
export type NetworkMode = z.infer<typeof NetworkMode>;

export const Permissions = z.object({
  fs: z.object({ read: z.array(z.string()).default([]), write: z.array(z.string()).default([]) }).default({ read: [], write: [] }),
  net: z.object({
    mode: NetworkMode.optional(),
    allow: z.array(z.string()).default([]),
    allowLocalAddresses: z.boolean().default(false),
    approvalExempt: z.array(z.string()).default([]),
  }).default({ allow: [], allowLocalAddresses: false, approvalExempt: [] }),
  tools: z.record(z.string(), z.enum(['allow', 'deny'])).default({}),
  approvalRequired: z.array(z.string()).default([]),
  /** Repositories outside the workspace this agent may edit on a branch (D-66). Only a human writes one. */
  repos: z.array(RepoGrant).default([]),
});
export type Permissions = z.infer<typeof Permissions>;

export const Budgets = z.object({
  maxModelCalls: z.number().int().positive(),
  maxToolCalls: z.number().int().positive(),
  maxCostUsd: z.number().nonnegative(),
  maxWallClockMs: z.number().int().positive(),
  toolCallTimeoutMs: z.number().int().positive(),
  dailySpendCapUsd: z.number().nonnegative(),
  /** The month's ceiling (F3): a run past it fails before its first call, and schedules pause until the month turns. 0 means no cap; the shipped default is 100. */
  monthlySpendCapUsd: z.number().nonnegative(),
});
export type Budgets = z.infer<typeof Budgets>;
