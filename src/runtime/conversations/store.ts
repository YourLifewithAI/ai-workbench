// Conversations (D-77): the room's data. A conversation is a row and a thread is a view over runs — the
// exchanges that carry its id, and the loop's own runs for the same agent, which nobody started by hand.
// Nothing here stores what was said: the words live in the runs' inputs and outputs, where the trace can be
// read beside them and the cost is already counted.
import type { Db } from '../db/index.js';
import type { ThreadEntry } from '../../shared/api/index.js';
import type { WorkStore } from '../work/store.js';
import { ulid } from 'ulid';

export interface Conversation {
  id: string;
  title: string;
  agentId: string;
  project: string | null;
  createdAt: string;
  updatedAt: string;
  lastReadAt: string | null;
}

interface Row {
  id: string; title: string; agent_id: string; project: string | null;
  created_at: string; updated_at: string; last_read_at: string | null;
}

interface RunRow {
  id: string; kind: string; state: string; agent_id: string | null; workflow_id: string | null;
  conversation_id: string | null; inputs_json: string; outputs_json: string | null; spent_json: string;
  external_tainted: number; started_at: string; finished_at: string | null; error_json: string | null; children: number;
}

/** One message a thread hands the next turn, with where it came from and what the run that wrote it had read. */
export interface HistoryMessage {
  role: 'user' | 'assistant';
  text: string;
  /** The exchange this message belongs to: what the trace names when it says where a taint came from. */
  runId: string;
  /** The reply came from a run that had read the web (or something a run that had read it wrote). */
  tainted: boolean;
  /** The reply came from a run that had read private content, so the turn that quotes it has too (D-29). */
  privateTainted: boolean;
}

/** What a title takes from the first thing said, until someone renames the thread. */
const TITLE_CHARS = 60;
const UNTITLED = 'New conversation';
/** What is left where a turn was cut to fit the budget, so nothing reads as if it had ended there. */
const CLIPPED = '[…clipped]';
/** The most a failed exchange says about itself in the thread: the run page holds the rest. */
const REASON_CHARS = 200;
const FAILED = 'The run failed.';

export class ConversationStore {
  constructor(private readonly db: Db, private readonly work: WorkStore) {}

  create(input: { agentId: string; project?: string | null | undefined; title?: string | undefined }): Conversation {
    const now = new Date().toISOString();
    const id = ulid();
    this.db.prepare('INSERT INTO conversations (id, title, agent_id, project, created_at, updated_at, last_read_at) VALUES (?, ?, ?, ?, ?, ?, NULL)')
      .run(id, input.title?.trim() || UNTITLED, input.agentId, input.project ?? null, now, now);
    return this.get(id)!;
  }

  get(id: string): Conversation | null {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Row | undefined;
    return row ? shape(row) : null;
  }

  list(agentId?: string): Conversation[] {
    const rows = (agentId === undefined
      ? this.db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC, rowid DESC').all()
      : this.db.prepare('SELECT * FROM conversations WHERE agent_id = ? ORDER BY updated_at DESC, rowid DESC').all(agentId)) as Row[];
    return rows.map(shape);
  }

  /**
   * The room the owner lands in: this agent's most recent thread, or a new one the first time. Two threads
   * touched in one millisecond are ordered by when they were made (`rowid`, not the id: a ulid is not monotonic
   * inside a millisecond), so the newer of them is the one he lands in.
   */
  latestOrCreate(agentId: string, project?: string | null | undefined): Conversation {
    return this.list(agentId)[0] ?? this.create({ agentId, project: project ?? null });
  }

  /** A thread's first message names it, until someone renames it. */
  touch(id: string, firstMessage?: string | undefined): void {
    const current = this.get(id);
    if (!current) return;
    const named = current.title === UNTITLED && firstMessage
      ? firstMessage.trim().replace(/\s+/g, ' ').slice(0, TITLE_CHARS)
      : current.title;
    this.db.prepare('UPDATE conversations SET updated_at = ?, title = ? WHERE id = ?')
      .run(new Date().toISOString(), named || current.title, id);
  }

  rename(id: string, title: string): Conversation | null {
    if (!this.get(id)) return null;
    this.db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
      .run(title.trim().slice(0, 200) || UNTITLED, new Date().toISOString(), id);
    return this.get(id);
  }

  /** Reading the room is what makes the header's "since you were last here" mean anything. */
  markRead(id: string, at = new Date().toISOString()): Conversation | null {
    if (!this.get(id)) return null;
    this.db.prepare('UPDATE conversations SET last_read_at = ? WHERE id = ?').run(at, id);
    return this.get(id);
  }

  /**
   * The thread, oldest last read first: the exchanges of this conversation, and the loop's own runs for the
   * same agent — a pulse is something the agent did, and the owner should find it where he talks to it (D-77).
   * A child run is never a line of its own: the exchange that started one says how many it directed.
   */
  thread(id: string, limit = 100): ThreadEntry[] {
    const conversation = this.get(id);
    if (!conversation) return [];
    // A pulse belongs to its agent, not to a conversation, so the first conversation shows every one (that is where
    // what happened overnight is read). One the person started later begins where he started it: the pulses since.
    const earliest = this.db.prepare('SELECT MIN(created_at) AS at FROM conversations WHERE agent_id = ?').get(conversation.agentId) as { at: string | null };
    const horizon = earliest.at === conversation.createdAt ? null : conversation.createdAt;
    const runs = this.db.prepare(`
      SELECT r.id, r.kind, r.state, r.agent_id, r.workflow_id, r.conversation_id, r.inputs_json, r.outputs_json,
             r.spent_json, r.external_tainted, r.started_at, r.finished_at, r.error_json,
             (SELECT COUNT(*) FROM runs c WHERE c.parent_run_id = r.id) AS children
      FROM runs r
      WHERE r.parent_run_id IS NULL AND (
        r.conversation_id = ?
        OR (r.conversation_id IS NULL AND r.kind = 'workflow' AND (? IS NULL OR r.started_at >= ?) AND EXISTS (
              SELECT 1 FROM run_steps s WHERE s.run_id = r.id AND s.agent_id = ?))
      )
      ORDER BY r.started_at DESC, r.rowid DESC LIMIT ?`).all(id, horizon, horizon, conversation.agentId, limit) as RunRow[];

    const entries: ThreadEntry[] = [];
    for (const row of runs.reverse()) {
      const filed = this.work.list({ state: 'all', run: row.id, limit: 20 }).filter((i) => i.kind !== 'decision');
      const spent = JSON.parse(row.spent_json) as { costUsd?: number };
      const common = { runId: row.id, at: row.started_at, state: row.state, costUsd: spent.costUsd ?? 0, children: row.children, filed };
      if (row.conversation_id === id) {
        const inputs = JSON.parse(row.inputs_json) as { input?: unknown };
        entries.push({
          kind: 'exchange', ...common,
          you: String(inputs.input ?? ''),
          reply: outputText(row.outputs_json),
          tainted: row.external_tainted === 1,
          error: row.state === 'failed' ? plainReason(row.error_json) : null,
        });
      } else {
        entries.push({
          kind: 'pulse', ...common, workflowId: row.workflow_id ?? '', note: outputText(row.outputs_json),
          tainted: row.external_tainted === 1,
        });
      }
    }
    // What only a person can answer, where the person already is: the open decisions, when they were asked.
    for (const item of this.work.list({ state: 'needs-you', kind: 'decision', limit: 20 })) {
      entries.push({ kind: 'decision', at: item.createdAt, item });
    }
    return entries.sort((a, b) => a.at.localeCompare(b.at));
  }

  /**
   * The last turns of a thread, oldest first: what the next run carries to the model as messages (D-78).
   * A pair (what he said, what it answered) is the unit. The newest pair is always carried, cut to fit the
   * budget if it is bigger than it — one long message must never leave a thread with no memory at all — and an
   * older pair is added whole while it fits, so the oldest go first and a turn is never half-remembered. A cut
   * pair keeps its taint: what was clipped off does not wash the rest clean. `before` is a run: only the turns
   * that began before it are carried, which is what resuming an earlier turn is owed.
   */
  history(id: string, opts: { turns: number; chars: number; before?: string | undefined }): HistoryMessage[] {
    if (opts.turns <= 0 || opts.chars <= 0) return [];
    const rows = this.db.prepare(`
      SELECT r.id, r.inputs_json, r.outputs_json, r.external_tainted, r.private_tainted FROM runs r
      WHERE r.conversation_id = ? AND r.state = 'completed'
        AND (? IS NULL OR (r.started_at, r.rowid) < (SELECT p.started_at, p.rowid FROM runs p WHERE p.id = ?))
      ORDER BY r.started_at DESC, r.rowid DESC LIMIT ?`)
      .all(id, opts.before ?? null, opts.before ?? null, opts.turns) as
      { id: string; inputs_json: string; outputs_json: string | null; external_tainted: number; private_tainted: number }[];
    const out: HistoryMessage[] = [];
    let budget = opts.chars;
    let newest = true;
    for (const row of rows) {
      let you = String((JSON.parse(row.inputs_json) as { input?: unknown }).input ?? '').trim();
      let reply = (outputText(row.outputs_json) ?? '').trim();
      if (!you || !reply) continue;
      if (newest) {
        ({ you, reply } = clipPair(you, reply, budget));
        newest = false;
      } else if (you.length + reply.length > budget) {
        break;
      }
      budget -= you.length + reply.length;
      out.unshift({ role: 'assistant', text: reply, runId: row.id, tainted: row.external_tainted === 1, privateTainted: row.private_tainted === 1 });
      out.unshift({ role: 'user', text: you, runId: row.id, tainted: false, privateTainted: false });
    }
    return out;
  }
}

/**
 * Cut a pair to a budget, keeping the head of each. The shorter side keeps all it has up to half the budget, so
 * a one-line reply beside a very long message is not cut to nothing; the longer side gets the rest. Only the
 * side that is cut carries the mark, and the mark counts against the budget.
 */
function clipPair(you: string, reply: string, budget: number): { you: string; reply: string } {
  if (you.length + reply.length <= budget) return { you, reply };
  const half = Math.floor(budget / 2);
  let youMax: number;
  let replyMax: number;
  if (reply.length <= half) { replyMax = reply.length; youMax = budget - reply.length; }
  else if (you.length <= budget - half) { youMax = you.length; replyMax = budget - you.length; }
  else { youMax = half; replyMax = budget - half; }
  return { you: clip(you, youMax), reply: clip(reply, replyMax) };
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let head = text.slice(0, Math.max(0, max - CLIPPED.length - 1));
  // Never leave half of a surrogate pair at the cut: a provider would reject the request as malformed.
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  head = head.trimEnd();
  return head ? `${head} ${CLIPPED}` : CLIPPED;
}

/**
 * A failed exchange's reason in a sentence a person can read in the thread: the run's own message, one line, no
 * stack, nothing that looks like a key, at most REASON_CHARS. The run page holds the full error (D-58).
 */
function plainReason(errorJson: string | null): string {
  if (!errorJson) return FAILED;
  let text: string;
  try {
    const e = JSON.parse(errorJson) as unknown;
    const o = (typeof e === 'object' && e !== null ? e : {}) as { message?: unknown; reason?: unknown; code?: unknown };
    const picked = [o.message, o.reason, o.code, typeof e === 'string' ? e : undefined].find((v) => typeof v === 'string' && v.trim() !== '');
    text = typeof picked === 'string' ? picked : FAILED;
  } catch {
    text = FAILED;
  }
  // A stack frame is `at fn (file:line:col)` or `at file:line:col`; a sentence that happens to start with "at" is not.
  const frame = /^at\s+(?:.+\(.*:\d+:\d+\)|\S+:\d+:\d+)$/;
  const line = text.split('\n').map((l) => l.trim()).find((l) => l !== '' && !frame.test(l)) ?? FAILED;
  const scrubbed = line
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, (m) => `${m.split(/\s/)[0]} [redacted]`)
    .replace(/\bcookie:.*$/i, 'Cookie: [redacted]')
    .replace(/([?&](?:api[_-]?key|key|token|access[_-]?token|secret|password)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[a-z]|AKIA|AIza)[-_A-Za-z0-9]{8,}/g, '[redacted]')
    .replace(/\b[A-Za-z0-9_\-+/=]{32,}\b/g, '[redacted]')
    .replace(/\s+/g, ' ');
  if (scrubbed.length <= REASON_CHARS) return scrubbed;
  let cut = scrubbed.slice(0, REASON_CHARS - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1); // never leave half an emoji
  return `${cut.trimEnd()}…`;
}

function outputText(outputs: string | null): string | null {
  if (!outputs) return null;
  const parsed = JSON.parse(outputs) as Record<string, unknown>;
  const value = parsed['output'] ?? Object.values(parsed)[0];
  return value === undefined || value === null ? null : String(value);
}

function shape(row: Row): Conversation {
  return {
    id: row.id, title: row.title, agentId: row.agent_id, project: row.project,
    createdAt: row.created_at, updatedAt: row.updated_at, lastReadAt: row.last_read_at,
  };
}
