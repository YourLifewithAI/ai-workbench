// Approvals: the security queue (D-13). A review is about whether the work is good; an approval is about
// whether an action may happen at all. They are different tables and different screens so that neither becomes
// the thing you click through on the way to the other.
import { ulid } from 'ulid';
import type { Db } from '../db/index.js';
import type { ApprovalItem, RememberRule } from '../../shared/api/index.js';

export type ApprovalState = 'pending' | 'allowed' | 'denied' | 'expired';
export type ApprovalDecision = 'allow' | 'allow-remember' | 'deny';

/** A human who has not answered in half an hour is not going to; the safe answer is no. */
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export interface ApprovalRow {
  id: string; run_id: string; step_id: string; tool: string; args_json: string; policy: string;
  batch_id: string; state: ApprovalState; decided_by: string | null; decided_at: string | null;
  remember_json: string | null; expires_at: string; created_at: string; ordinal: number;
}

export interface OpenApprovalInput {
  runId: string;
  stepId: string;
  tool: string;
  args: unknown;
  /** The rule that fired, in the words the card shows. */
  policy: string;
  /** The narrowest rule "remember" would write: exactly `{ tool, path? , host? }` and nothing wider. */
  remember?: RememberRule | undefined;
  /** Where this call sat in the response that asked for it, so the card lists them in the order asked. */
  ordinal?: number | undefined;
  timeoutMs?: number | undefined;
  now?: (() => Date) | undefined;
}

export class ApprovalStore {
  constructor(private readonly db: Db, private readonly now: () => Date = () => new Date()) {}

  /** One batch per step: a step that asks twice produces one card listing both actions (RUN-06 DoD 5). */
  open(input: OpenApprovalInput): ApprovalRow {
    const at = (input.now ?? this.now)();
    const row: ApprovalRow = {
      id: ulid(),
      run_id: input.runId,
      step_id: input.stepId,
      tool: input.tool,
      args_json: JSON.stringify(input.args ?? {}),
      policy: input.policy,
      batch_id: `${input.runId}:${input.stepId}`,
      state: 'pending',
      decided_by: null,
      decided_at: null,
      remember_json: input.remember ? JSON.stringify(input.remember) : null,
      expires_at: new Date(at.getTime() + (input.timeoutMs ?? DEFAULT_TIMEOUT_MS)).toISOString(),
      created_at: at.toISOString(),
      ordinal: input.ordinal ?? 0,
    };
    this.db.prepare(`INSERT INTO approvals (id, run_id, step_id, tool, args_json, policy, batch_id, state, remember_json, expires_at, created_at, ordinal)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`)
      .run(row.id, row.run_id, row.step_id, row.tool, row.args_json, row.policy, row.batch_id, row.remember_json, row.expires_at, row.created_at, row.ordinal);
    return row;
  }

  decide(id: string, decision: ApprovalDecision, by = 'human'): ApprovalRow | null {
    const row = this.byId(id);
    if (!row || row.state !== 'pending') return null;
    const state: ApprovalState = decision === 'deny' ? 'denied' : 'allowed';
    this.db.prepare('UPDATE approvals SET state = ?, decided_by = ?, decided_at = ? WHERE id = ?')
      .run(state, by, this.now().toISOString(), id);
    return this.byId(id);
  }

  /** Anything past its deadline becomes a denial. Silence is not consent (SEC-12). */
  expire(now = this.now()): ApprovalRow[] {
    const due = this.db.prepare("SELECT * FROM approvals WHERE state = 'pending' AND expires_at <= ?").all(now.toISOString()) as ApprovalRow[];
    for (const row of due) {
      this.db.prepare("UPDATE approvals SET state = 'expired', decided_by = 'timeout', decided_at = ? WHERE id = ?").run(now.toISOString(), row.id);
    }
    return due;
  }

  byId(id: string): ApprovalRow | null {
    return (this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as ApprovalRow | undefined) ?? null;
  }

  pendingFor(runId: string): ApprovalRow[] {
    return this.db.prepare("SELECT * FROM approvals WHERE run_id = ? AND state = 'pending' ORDER BY created_at").all(runId) as ApprovalRow[];
  }

  /** The queue, batched: one entry per step that is waiting, with every action it wants listed on it. */
  list(state: ApprovalState | 'all' = 'pending'): ApprovalItem[] {
    const rows = (state === 'all'
      ? this.db.prepare('SELECT * FROM approvals ORDER BY created_at DESC LIMIT 200').all()
      : this.db.prepare('SELECT * FROM approvals WHERE state = ? ORDER BY created_at DESC LIMIT 200').all(state)) as ApprovalRow[];

    const batches = new Map<string, ApprovalRow[]>();
    for (const row of rows) batches.set(row.batch_id, [...(batches.get(row.batch_id) ?? []), row]);

    return [...batches.values()].map((unordered) => {
      // `ordinal` is the position in the response that asked, which is the order to show them. Ids will not do:
      // ULIDs are only monotonic within a millisecond when a monotonic factory makes them, and two parallel
      // tool calls land in the same millisecond.
      const group = [...unordered].sort((a, b) => a.ordinal - b.ordinal || a.created_at.localeCompare(b.created_at));
      const first = group[0]!;
      const run = this.db.prepare('SELECT agent_id, workflow_id, project_id FROM runs WHERE id = ?')
        .get(first.run_id) as { agent_id: string | null; workflow_id: string | null; project_id: string | null } | undefined;
      return {
        batchId: first.batch_id,
        runId: first.run_id,
        stepId: first.step_id,
        subject: run?.workflow_id ?? run?.agent_id ?? first.run_id,
        project: run?.project_id ?? null,
        state: first.state,
        createdAt: first.created_at,
        expiresAt: first.expires_at,
        actions: group.map((row) => ({
          id: row.id,
          tool: row.tool,
          args: JSON.parse(row.args_json) as Record<string, unknown>,
          policy: row.policy,
          state: row.state,
          remember: row.remember_json ? (JSON.parse(row.remember_json) as RememberRule) : null,
          decidedBy: row.decided_by,
          decidedAt: row.decided_at,
        })),
      };
    });
  }
}
