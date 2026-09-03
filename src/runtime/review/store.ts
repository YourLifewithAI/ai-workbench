// The review queue (D-13). Review is about quality and is non-blocking by default: every completed step lands
// here as unreviewed, and the human rates, edits, rejects, or ignores it. A step declared `review: 'blocking'`
// parks its run instead. Approval — the security queue — is a different table and a different screen (RUN-06).
import { ulid } from 'ulid';
import type { Db } from '../db/index.js';
import type { RatingSummary, ReviewItem } from '../../shared/api/index.js';

export type ReviewState = 'unreviewed' | 'pending' | 'continued' | 'rejected' | 'dismissed';
export type ReviewDecision = 'continue' | 'reject' | 'dismiss';

/** Two rejections is the limit (workflows-and-execution.md §Review); a third would be a conversation, not a gate. */
export const MAX_REJECTIONS = 2;

export interface ReviewRow {
  id: string; run_id: string; step_id: string; version_id: string | null;
  state: ReviewState; feedback: string | null; attempt: number; created_at: string; decided_at: string | null;
}
interface RatingRow { id: string; run_id: string; step_id: string; version_id: string | null; value: number; note: string | null; compare_id: string | null; ts: string }

export interface OpenReviewInput {
  runId: string;
  stepId: string;
  versionId?: string | undefined;
  /** A blocking gate parks the run; anything else is filed for the human to look at when they feel like it. */
  blocking: boolean;
}

export class ReviewStore {
  constructor(private readonly db: Db) {}

  /** Called when a step completes. A re-run of the same step reopens its row rather than adding a second one. */
  open(input: OpenReviewInput): ReviewRow {
    const now = new Date().toISOString();
    const existing = this.find(input.runId, input.stepId);
    const state: ReviewState = input.blocking ? 'pending' : 'unreviewed';
    if (existing) {
      // Reopening consumes the feedback: the step has just re-run with it, so it is history, not an instruction.
      this.db.prepare('UPDATE reviews SET state = ?, version_id = ?, feedback = NULL, attempt = attempt + 1, decided_at = NULL WHERE id = ?')
        .run(state, input.versionId ?? null, existing.id);
      return this.byId(existing.id)!;
    }
    const row: ReviewRow = {
      id: ulid(), run_id: input.runId, step_id: input.stepId, version_id: input.versionId ?? null,
      state, feedback: null, attempt: 1, created_at: now, decided_at: null,
    };
    this.db.prepare('INSERT INTO reviews (id, run_id, step_id, version_id, state, feedback, attempt, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)')
      .run(row.id, row.run_id, row.step_id, row.version_id, row.state, row.attempt, row.created_at);
    return row;
  }

  decide(id: string, decision: ReviewDecision, feedback?: string): ReviewRow | null {
    const row = this.byId(id);
    if (!row) return null;
    const state: ReviewState = decision === 'continue' ? 'continued' : decision === 'reject' ? 'rejected' : 'dismissed';
    this.db.prepare('UPDATE reviews SET state = ?, feedback = ?, decided_at = ? WHERE id = ?')
      .run(state, feedback ?? null, new Date().toISOString(), id);
    return this.byId(id);
  }

  byId(id: string): ReviewRow | null {
    return (this.db.prepare('SELECT * FROM reviews WHERE id = ?').get(id) as ReviewRow | undefined) ?? null;
  }

  find(runId: string, stepId: string): ReviewRow | null {
    return (this.db.prepare('SELECT * FROM reviews WHERE run_id = ? AND step_id = ?').get(runId, stepId) as ReviewRow | undefined) ?? null;
  }

  /** Everything still pending for a run, so a restart can tell whether it is parked or merely stale. */
  pendingFor(runId: string): ReviewRow[] {
    return this.db.prepare("SELECT * FROM reviews WHERE run_id = ? AND state = 'pending' ORDER BY created_at").all(runId) as ReviewRow[];
  }

  /** Steps a human rejected and that have not re-run yet: a resume must redo these, not skip them. */
  rejectedFor(runId: string): ReviewRow[] {
    return this.db.prepare("SELECT * FROM reviews WHERE run_id = ? AND state = 'rejected' ORDER BY created_at").all(runId) as ReviewRow[];
  }

  /** What the human asked for instead, for the step that is about to re-run. */
  feedbackFor(runId: string, stepId: string): string | null {
    const row = this.find(runId, stepId);
    return row && row.state === 'rejected' ? row.feedback : null;
  }

  /** The queue: blocking gates first, because those are the ones holding a run still. */
  list(filter: { state?: ReviewState | 'open' | undefined; limit?: number | undefined } = {}): ReviewItem[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.state === 'open') clauses.push("state IN ('pending', 'unreviewed')");
    else if (filter.state) { clauses.push('state = ?'); params.push(filter.state); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT * FROM reviews ${where} ORDER BY state = 'pending' DESC, created_at DESC LIMIT ?`)
      .all(...params, filter.limit ?? 100) as ReviewRow[];
    return rows.map((r) => this.toItem(r));
  }

  get(id: string): ReviewItem | null {
    const row = this.byId(id);
    return row ? this.toItem(row) : null;
  }

  rate(input: { runId: string; stepId: string; versionId?: string | undefined; value: number; note?: string | undefined; compareId?: string | undefined }): RatingSummary {
    if (!Number.isInteger(input.value) || input.value < 1 || input.value > 5) {
      throw new RangeError(`A rating is 1 to 5 (got ${input.value}).`);
    }
    const row: RatingRow = {
      id: ulid(), run_id: input.runId, step_id: input.stepId, version_id: input.versionId ?? null,
      value: input.value, note: input.note ?? null, compare_id: input.compareId ?? null, ts: new Date().toISOString(),
    };
    this.db.prepare('INSERT INTO ratings (id, run_id, step_id, version_id, value, note, compare_id, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.run_id, row.step_id, row.version_id, row.value, row.note, row.compare_id, row.ts);
    return toRating(row);
  }

  /** Ratings on the versions of one document, so the Library can show what the human thought of each. */
  ratingsForVersions(versionIds: string[]): Map<string, RatingSummary[]> {
    const out = new Map<string, RatingSummary[]>();
    if (!versionIds.length) return out;
    const placeholders = versionIds.map(() => '?').join(', ');
    const rows = this.db.prepare(`SELECT * FROM ratings WHERE version_id IN (${placeholders}) ORDER BY ts`).all(...versionIds) as RatingRow[];
    for (const row of rows) {
      const key = row.version_id!;
      out.set(key, [...(out.get(key) ?? []), toRating(row)]);
    }
    return out;
  }

  private toItem(row: ReviewRow): ReviewItem {
    const step = this.db.prepare('SELECT kind, state, model_id, output_json FROM run_steps WHERE run_id = ? AND step_id = ?')
      .get(row.run_id, row.step_id) as { kind: string; state: string; model_id: string | null; output_json: string | null } | undefined;
    const run = this.db.prepare('SELECT kind, agent_id, workflow_id, project_id, state FROM runs WHERE id = ?')
      .get(row.run_id) as { kind: string; agent_id: string | null; workflow_id: string | null; project_id: string | null; state: string } | undefined;
    const document = row.version_id
      ? this.db.prepare('SELECT d.id AS document_id, d.path AS path FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE v.id = ?')
        .get(row.version_id) as { document_id: string; path: string } | undefined
      : undefined;
    const output = step?.output_json ? (JSON.parse(step.output_json) as unknown) : null;
    return {
      id: row.id,
      runId: row.run_id,
      stepId: row.step_id,
      state: row.state,
      blocking: row.state === 'pending',
      attempt: row.attempt,
      feedback: row.feedback,
      createdAt: row.created_at,
      decidedAt: row.decided_at,
      runKind: run?.kind ?? 'agent',
      runState: run?.state ?? 'completed',
      subject: run?.workflow_id ?? run?.agent_id ?? row.run_id,
      project: run?.project_id ?? null,
      modelId: step?.model_id ?? null,
      output: typeof output === 'string' ? output : output === null ? null : JSON.stringify(output, null, 2),
      versionId: row.version_id,
      documentId: document?.document_id ?? null,
      documentPath: document?.path ?? null,
      ratings: (this.db.prepare('SELECT * FROM ratings WHERE run_id = ? AND step_id = ? ORDER BY ts').all(row.run_id, row.step_id) as RatingRow[]).map(toRating),
    };
  }
}

function toRating(row: RatingRow): RatingSummary {
  return { id: row.id, runId: row.run_id, stepId: row.step_id, versionId: row.version_id, value: row.value, note: row.note, ts: row.ts };
}
