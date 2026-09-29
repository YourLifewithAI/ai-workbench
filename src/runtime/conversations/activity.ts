// What happened while you were away (D-77): the thread header's four numbers, counted in SQL over the tables and
// never by reading a page of runs back — a list capped at some number of runs would stop counting there without saying so.
//
// The header is about the owner's own work, so a run is counted once: the runs nobody's parent started, and the
// children that outlived theirs. A child an agent waited for is inside its parent (its cost is in the parent's
// total, its outcome in the parent's reply), and counting it again would say two things happened where the thread
// shows one; a child the parent let go (D-76) finished on its own, after the parent, and nothing came back up, so
// its outcome is news the header must carry — a pulse's research failing overnight is exactly that. Money is the one thing counted from the
// model calls themselves rather than from the runs: a call has one price and one time, so the sum is what was spent
// since `since` whichever run made the call and whatever state that run is in now, and no child is counted twice.
import type { Db } from '../db/index.js';

export interface ThreadActivity {
  /** Top-level runs that completed after `since`. */
  finished: number;
  /** Top-level runs that failed or were interrupted after `since`. */
  failed: number;
  /** Top-level runs that are not over: queued, running, or parked on a review or an approval. Not bound by `since`. */
  running: number;
  /** What the model calls made after `since` cost, to the cent. */
  spentUsd: number;
}

/** A run that has not reached an end: what the header means by "running". */
export const UNFINISHED_STATES = ['queued', 'running', 'waiting_review', 'waiting_approval'] as const;

/** `since` null means from the beginning: everything counts. Times are compared as the ISO text the tables hold. */
export function threadActivity(db: Db, since: string | null): ThreadActivity {
  const marks = UNFINISHED_STATES.map(() => '?').join(', ');
  const runs = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN r.state = 'completed' AND (? IS NULL OR r.finished_at > ?) THEN 1 ELSE 0 END), 0) AS finished,
      COALESCE(SUM(CASE WHEN r.state IN ('failed', 'interrupted') AND (? IS NULL OR r.finished_at > ?) THEN 1 ELSE 0 END), 0) AS failed,
      COALESCE(SUM(CASE WHEN r.state IN (${marks}) THEN 1 ELSE 0 END), 0) AS running
    FROM runs r LEFT JOIN runs p ON p.id = r.parent_run_id
    WHERE r.parent_run_id IS NULL
       OR (p.finished_at IS NOT NULL AND (r.finished_at IS NULL OR r.finished_at > p.finished_at))`).get(since, since, since, since, ...UNFINISHED_STATES) as { finished: number; failed: number; running: number };
  // Two statements rather than `(? IS NULL OR ts > ?)`, which an index on `ts` cannot serve.
  const spent = (since === null
    ? db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM model_calls').get()
    : db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM model_calls WHERE ts > ?').get(since)) as { usd: number };
  return { finished: runs.finished, failed: runs.failed, running: runs.running, spentUsd: Math.round(spent.usd * 100) / 100 };
}
