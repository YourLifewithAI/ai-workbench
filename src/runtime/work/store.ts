// The ledger the orchestrator keeps (D-75, RUN-24). A work item is a row a person can see: what is owed, to
// whom, in what state, and who said so. The orchestrator files, lists and moves items; a person files, moves
// and answers them through the same rows. Two rules carry over from elsewhere: dedupe by key (the auditor's
// facts-hash rule) so a pulse never nags twice, and trust from the writing run (memory's rule, D-17) so an item
// a tainted run wrote is shown as content, not as the orchestrator's word.
import { ulid } from 'ulid';
import type { Db } from '../db/index.js';
import type { WorkItem, WorkKind, WorkOption, WorkState } from '../../shared/api/index.js';

export const OPEN_STATES: WorkState[] = ['backlog', 'staffed', 'in-review', 'needs-you', 'decided'];

export interface FileWorkInput {
  kind: WorkKind;
  project: string | null;
  title: string;
  detail: string | null;
  state: WorkState;
  assignee: string | null;
  key: string | null;
  trust: 'trusted' | 'untrusted';
  runId: string | null;
  options?: WorkOption[] | undefined;
  lean?: string | null | undefined;
}

export interface UpdateWorkInput {
  state?: WorkState | undefined;
  assignee?: string | null | undefined;
  detail?: string | undefined;
  answer?: string | undefined;
  note?: string | undefined;
  /** The run that touched it, and how. */
  run?: { runId: string; role: 'staffed' | 'worked' | 'answered' | 'refreshed' } | undefined;
}

export interface ListWorkFilter {
  state?: WorkState | 'open' | 'all' | undefined;
  project?: string | undefined;
  kind?: WorkKind | undefined;
  assignee?: string | undefined;
  limit?: number | undefined;
}

interface Row {
  id: string; kind: WorkKind; project: string | null; title: string; detail: string | null; state: WorkState;
  assignee: string | null; key: string | null; trust: 'trusted' | 'untrusted'; run_id: string | null;
  options_json: string | null; lean: string | null; answer: string | null; note: string | null;
  created_at: string; updated_at: string; decided_at: string | null;
}

export class WorkStore {
  constructor(private readonly db: Db) {}

  /**
   * Files an item. An open item with the same key is refreshed — title, detail and the run kept current, its
   * id kept so a link to it still works — and never filed twice. Trust only lowers on a refresh: an item a
   * clean run filed that a tainted run then refreshed carries the tainted run's words.
   */
  file(input: FileWorkInput): { item: WorkItem; outcome: 'filed' | 'refreshed' } {
    const now = new Date().toISOString();
    if (input.key) {
      const open = this.db.prepare(`SELECT * FROM work_items WHERE key = ? AND state IN (${OPEN_STATES.map(() => '?').join(',')}) ORDER BY created_at LIMIT 1`)
        .get(input.key, ...OPEN_STATES) as Row | undefined;
      if (open) {
        const trust = open.trust === 'untrusted' || input.trust === 'untrusted' ? 'untrusted' : 'trusted';
        this.db.prepare('UPDATE work_items SET title = ?, detail = ?, trust = ?, run_id = COALESCE(?, run_id), updated_at = ? WHERE id = ?')
          .run(input.title, input.detail, trust, input.runId, now, open.id);
        if (input.runId) this.link(open.id, input.runId, 'refreshed', now);
        return { item: this.get(open.id)!, outcome: 'refreshed' };
      }
    }
    const id = ulid();
    this.db.prepare(`INSERT INTO work_items (id, kind, project, title, detail, state, assignee, key, trust, run_id, options_json, lean, answer, note, created_at, updated_at, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL)`)
      .run(id, input.kind, input.project, input.title, input.detail, input.state, input.assignee, input.key, input.trust, input.runId,
        input.options?.length ? JSON.stringify(input.options) : null, input.lean ?? null, now, now);
    if (input.runId) this.link(id, input.runId, 'filed', now);
    return { item: this.get(id)!, outcome: 'filed' };
  }

  get(id: string): WorkItem | null {
    const row = this.db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as Row | undefined;
    return row ? this.toItem(row) : null;
  }

  list(filter: ListWorkFilter = {}): WorkItem[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const state = filter.state ?? 'open';
    if (state === 'open') { clauses.push(`state IN (${OPEN_STATES.map(() => '?').join(',')})`); params.push(...OPEN_STATES); }
    else if (state !== 'all') { clauses.push('state = ?'); params.push(state); }
    if (filter.project) { clauses.push('project = ?'); params.push(filter.project); }
    if (filter.kind) { clauses.push('kind = ?'); params.push(filter.kind); }
    if (filter.assignee) { clauses.push('assignee = ?'); params.push(filter.assignee); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT * FROM work_items ${where} ORDER BY updated_at DESC LIMIT ?`).all(...params, Math.max(1, Math.min(200, filter.limit ?? 50))) as Row[];
    return rows.map((r) => this.toItem(r));
  }

  /** Moves an item, or answers a decision: an answer is what turns `needs-you` into `decided`. */
  update(id: string, patch: UpdateWorkInput): WorkItem | null {
    const row = this.db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as Row | undefined;
    if (!row) return null;
    const now = new Date().toISOString();
    const answered = patch.answer !== undefined;
    const state = answered && row.kind === 'decision' ? 'decided' : (patch.state ?? row.state);
    this.db.prepare(`UPDATE work_items SET state = ?, assignee = ?, detail = ?, answer = ?, note = ?, updated_at = ?, decided_at = ? WHERE id = ?`)
      .run(state, patch.assignee === undefined ? row.assignee : patch.assignee, patch.detail ?? row.detail,
        answered ? patch.answer! : row.answer, patch.note ?? row.note, now, answered ? now : row.decided_at, id);
    if (patch.run) this.link(id, patch.run.runId, patch.run.role, now);
    return this.get(id);
  }

  counts(): { open: number; needsYou: number } {
    const open = (this.db.prepare(`SELECT COUNT(*) AS n FROM work_items WHERE state IN (${OPEN_STATES.map(() => '?').join(',')})`).get(...OPEN_STATES) as { n: number }).n;
    const needsYou = (this.db.prepare("SELECT COUNT(*) AS n FROM work_items WHERE state = 'needs-you'").get() as { n: number }).n;
    return { open, needsYou };
  }

  private link(itemId: string, runId: string, role: string, at: string): void {
    this.db.prepare('INSERT OR IGNORE INTO work_runs (item_id, run_id, role, at) VALUES (?, ?, ?, ?)').run(itemId, runId, role, at);
  }

  private toItem(row: Row): WorkItem {
    const runs = this.db.prepare('SELECT run_id, role, at FROM work_runs WHERE item_id = ? ORDER BY at').all(row.id) as { run_id: string; role: string; at: string }[];
    return {
      id: row.id, kind: row.kind, project: row.project, title: row.title, detail: row.detail, state: row.state,
      assignee: row.assignee, key: row.key, trust: row.trust, runId: row.run_id,
      options: row.options_json ? (JSON.parse(row.options_json) as WorkOption[]) : [],
      lean: row.lean, answer: row.answer, note: row.note,
      runs: runs.map((r) => ({ runId: r.run_id, role: r.role, at: r.at })),
      createdAt: row.created_at, updatedAt: row.updated_at, decidedAt: row.decided_at,
    };
  }
}
