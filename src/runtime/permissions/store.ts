// What the auditor proposed and what the person did with it (D-63, RUN-14). Nothing here touches the grant
// matrix: applying a finding is the runtime's `setGrant`, called from a human's request, and this store only
// records that it happened. A dismissal holds until the facts the finding rested on change.
import { ulid } from 'ulid';
import type { Db } from '../db/index.js';
import type { FindingKind, FindingProposal, PermissionFinding } from '../../shared/api/index.js';
import type { Permissions } from '../../shared/permissions.js';

export interface FindingInput {
  key: string;
  kind: FindingKind;
  agentId: string | null;
  tool: string | null;
  headline: string;
  evidence: string[];
  note: string | null;
  proposal: FindingProposal | null;
  factsHash: string;
}

interface Row {
  id: string; key: string; kind: FindingKind; agent_id: string | null; tool: string | null; evidence_json: string;
  proposal_json: string | null; note: string | null; facts_hash: string; state: 'open' | 'applied' | 'dismissed';
  run_id: string | null; created_at: string; decided_at: string | null;
}

export class FindingStore {
  constructor(private readonly db: Db) {}

  /**
   * Raise one finding. Suppressed when the person dismissed this key on the same facts; merged into the open
   * row when one exists (the evidence is refreshed, the id kept, so a link to it still works).
   */
  raise(input: FindingInput, runId: string | null): { id: string | null; outcome: 'raised' | 'refreshed' | 'suppressed' } {
    const dismissed = this.db.prepare('SELECT facts_hash FROM permission_finding_dismissals WHERE key = ?').get(input.key) as { facts_hash: string } | undefined;
    if (dismissed && dismissed.facts_hash === input.factsHash) return { id: null, outcome: 'suppressed' };
    const now = new Date().toISOString();
    const evidence = JSON.stringify({ headline: input.headline, evidence: input.evidence });
    const proposal = input.proposal ? JSON.stringify(input.proposal) : null;
    const open = this.db.prepare("SELECT id FROM permission_findings WHERE key = ? AND state = 'open'").get(input.key) as { id: string } | undefined;
    if (open) {
      this.db.prepare('UPDATE permission_findings SET evidence_json = ?, proposal_json = ?, note = ?, facts_hash = ?, run_id = ?, created_at = ? WHERE id = ?')
        .run(evidence, proposal, input.note, input.factsHash, runId, now, open.id);
      return { id: open.id, outcome: 'refreshed' };
    }
    const id = ulid();
    this.db.prepare(`INSERT INTO permission_findings (id, key, kind, agent_id, tool, evidence_json, proposal_json, note, facts_hash, state, run_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`)
      .run(id, input.key, input.kind, input.agentId, input.tool, evidence, proposal, input.note, input.factsHash, runId, now);
    return { id, outcome: 'raised' };
  }

  list(state: 'open' | 'applied' | 'dismissed' | 'all' = 'open'): PermissionFinding[] {
    const rows = (state === 'all'
      ? this.db.prepare('SELECT * FROM permission_findings ORDER BY created_at DESC').all()
      : this.db.prepare('SELECT * FROM permission_findings WHERE state = ? ORDER BY created_at DESC').all(state)) as Row[];
    return rows.map(toFinding);
  }

  get(id: string): PermissionFinding | null {
    const row = this.db.prepare('SELECT * FROM permission_findings WHERE id = ?').get(id) as Row | undefined;
    return row ? toFinding(row) : null;
  }

  /** The person's decision. A dismissal remembers the facts, so the same finding on the same numbers stays quiet. */
  decide(id: string, decision: 'applied' | 'dismissed'): PermissionFinding | null {
    const row = this.db.prepare('SELECT * FROM permission_findings WHERE id = ?').get(id) as Row | undefined;
    if (!row) return null;
    const now = new Date().toISOString();
    this.db.prepare('UPDATE permission_findings SET state = ?, decided_at = ? WHERE id = ?').run(decision, now, id);
    if (decision === 'dismissed') {
      this.db.prepare('INSERT INTO permission_finding_dismissals (key, facts_hash, dismissed_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET facts_hash = excluded.facts_hash, dismissed_at = excluded.dismissed_at')
        .run(row.key, row.facts_hash, now);
    } else {
      // Applied: whatever was dismissed before on this key is moot, the matrix has moved.
      this.db.prepare('DELETE FROM permission_finding_dismissals WHERE key = ?').run(row.key);
    }
    return this.get(id);
  }
}

function toFinding(row: Row): PermissionFinding {
  const evidence = JSON.parse(row.evidence_json) as { headline: string; evidence: string[] };
  return {
    id: row.id, key: row.key, kind: row.kind, agentId: row.agent_id, tool: row.tool,
    headline: evidence.headline, evidence: evidence.evidence, note: row.note,
    proposal: row.proposal_json ? (JSON.parse(row.proposal_json) as FindingProposal) : null,
    state: row.state, runId: row.run_id, createdAt: row.created_at, decidedAt: row.decided_at,
  };
}

/**
 * Every change a human makes to one agent's grant block, one row per field that moved. The source is always
 * the same word: a change applied from a finding is the same act as one made on the Tools screen (D-63).
 */
export function logGrantChange(db: Db, agentId: string, before: Permissions | undefined, after: Permissions | undefined): number {
  const now = new Date().toISOString();
  const insert = db.prepare('INSERT INTO grant_log (id, agent_id, tool, field, before_json, after_json, source, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  let rows = 0;
  const tools = new Set([...Object.keys(before?.tools ?? {}), ...Object.keys(after?.tools ?? {})]);
  for (const tool of [...tools].sort()) {
    const was = before?.tools[tool] ?? null;
    const now_ = after?.tools[tool] ?? null;
    if (was === now_) continue;
    insert.run(ulid(), agentId, tool, 'tools', JSON.stringify(was), JSON.stringify(now_), 'human', now);
    rows++;
  }
  for (const field of ['net', 'fs', 'approvalRequired', 'repos'] as const) {
    const was = JSON.stringify(before?.[field] ?? null);
    const now_ = JSON.stringify(after?.[field] ?? null);
    if (was === now_) continue;
    insert.run(ulid(), agentId, null, field, was, now_, 'human', now);
    rows++;
  }
  return rows;
}
