// Permissions and budgets (spec/tools-and-security.md, spec/workflows-and-execution.md).
import { z } from 'zod';

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
});
export type Permissions = z.infer<typeof Permissions>;

export const Budgets = z.object({
  maxModelCalls: z.number().int().positive(),
  maxToolCalls: z.number().int().positive(),
  maxCostUsd: z.number().nonnegative(),
  maxWallClockMs: z.number().int().positive(),
  toolCallTimeoutMs: z.number().int().positive(),
  dailySpendCapUsd: z.number().nonnegative(),
});
export type Budgets = z.infer<typeof Budgets>;
