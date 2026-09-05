// The auditor's two tools (D-63, RUN-14). `permissions.facts` returns metadata about grants and their use —
// never a trace, a memory, a document or a credential — and `permissions.propose` files findings into the
// Review queue for a person to apply or dismiss. Neither can write the grant matrix: there is no tool that can.
import { z } from 'zod';
import { Permissions } from '../../../shared/permissions.js';
import { toolError, type ToolDefinition } from '../../../shared/tool.js';
import { briefOf, type FactsBrief, type PermissionFacts, type ReviewThresholds } from '../../permissions/review.js';

const NOTHING = Permissions.parse({});

export interface PermissionsToolDeps {
  /** Keyed by run, so `propose` sees the same candidate ids the auditor was shown, whatever thresholds it asked for. */
  facts: (thresholds: Partial<ReviewThresholds>, runId: string) => PermissionFacts;
  /** Files findings; the runtime computes the evidence, the auditor only chooses and annotates. */
  propose: (findings: ProposedFinding[], runId: string) => { raised: number; refreshed: number; suppressed: number; ignored: string[]; ids: string[] };
}

export interface ProposedFinding {
  /** A candidate id from `permissions.facts` — the evidence is the runtime's. */
  candidate?: string | undefined;
  /** The one finding the auditor may raise on its own reading: a grant the instructions no longer justify. */
  kind?: 'unjustified' | undefined;
  agentId?: string | undefined;
  tool?: string | undefined;
  note?: string | undefined;
}

const Proposed = z.object({
  candidate: z.string().optional().describe('The id of a candidate from permissions.facts, e.g. "unused:researcher:http.fetch".'),
  kind: z.literal('unjustified').optional().describe('Only for a finding of your own: the agent\'s instructions no longer justify a tool it holds.'),
  agentId: z.string().optional(),
  tool: z.string().optional(),
  note: z.string().max(600).optional().describe('One or two sentences for the person: what you saw and why it matters. Quote the instructions when you can.'),
});

export function permissionsTools(deps: PermissionsToolDeps): ToolDefinition[] {
  const facts: ToolDefinition<{ unusedDays?: number | undefined; fatigueStreak?: number | undefined }, FactsBrief> = {
    id: 'permissions.facts',
    version: '1.0.0',
    description: 'How the grant matrix has been used: the candidate findings the numbers support (each with an id you can raise), then every grant with its age and use count, approvals and their streaks, hosts allowed against hosts reached, tools nobody has decided about, and a slice of each agent\'s instructions. Metadata only.',
    input: z.object({
      unusedDays: z.number().int().positive().optional().describe('A grant older than this that was never used is a candidate. Default 30.'),
      fatigueStreak: z.number().int().positive().optional().describe('This many approvals in a row without a rejection is a candidate. Default 30.'),
    }),
    output: z.custom<FactsBrief>((v) => typeof v === 'object' && v !== null),
    tier: 'read',
    maxPermissions: NOTHING,
    execute: async (input, ctx) => ({ ok: true, output: briefOf(deps.facts({ ...(input.unusedDays ? { unusedDays: input.unusedDays } : {}), ...(input.fatigueStreak ? { fatigueStreak: input.fatigueStreak } : {}) }, ctx.runId)) }),
  };

  const propose: ToolDefinition<{ findings: ProposedFinding[] }, { raised: number; refreshed: number; suppressed: number; ignored: string[]; ids: string[] }> = {
    id: 'permissions.propose',
    version: '1.0.0',
    description: 'File findings into the Review queue for the person to apply or dismiss. Raise a candidate by id, or an "unjustified" finding of your own with the agent, the tool and a note. Nothing here changes a grant.',
    input: z.object({ findings: z.array(Proposed).max(50) }),
    output: z.object({ raised: z.number(), refreshed: z.number(), suppressed: z.number(), ignored: z.array(z.string()), ids: z.array(z.string()) }),
    tier: 'write',
    maxPermissions: NOTHING,
    execute: async (input, ctx) => {
      for (const f of input.findings) {
        if (!f.candidate && !(f.kind === 'unjustified' && f.agentId && f.tool)) {
          return toolError('InvalidInput', 'Each finding is either { candidate } or { kind: "unjustified", agentId, tool, note }.');
        }
      }
      return { ok: true, output: deps.propose(input.findings, ctx.runId) };
    },
  };

  return [facts as ToolDefinition, propose as ToolDefinition];
}
