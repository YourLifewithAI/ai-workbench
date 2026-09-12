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
  external_tainted: number; started_at: string; finished_at: string | null; children: number;
}

/** What a title takes from the first thing said, until someone renames the thread. */
const TITLE_CHARS = 60;
const UNTITLED = 'New conversation';

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
      ? this.db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC').all()
      : this.db.prepare('SELECT * FROM conversations WHERE agent_id = ? ORDER BY updated_at DESC').all(agentId)) as Row[];
    return rows.map(shape);
  }

  /** The room the owner lands in: this agent's most recent thread, or a new one the first time. */
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
    const runs = this.db.prepare(`
      SELECT r.id, r.kind, r.state, r.agent_id, r.workflow_id, r.conversation_id, r.inputs_json, r.outputs_json,
             r.spent_json, r.external_tainted, r.started_at, r.finished_at,
             (SELECT COUNT(*) FROM runs c WHERE c.parent_run_id = r.id) AS children
      FROM runs r
      WHERE r.parent_run_id IS NULL AND (
        r.conversation_id = ?
        OR (r.conversation_id IS NULL AND r.kind = 'workflow' AND EXISTS (
              SELECT 1 FROM run_steps s WHERE s.run_id = r.id AND s.agent_id = ?))
      )
      ORDER BY r.started_at DESC LIMIT ?`).all(id, conversation.agentId, limit) as RunRow[];

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
        });
      } else {
        entries.push({ kind: 'pulse', ...common, workflowId: row.workflow_id ?? '', note: outputText(row.outputs_json) });
      }
    }
    // What only a person can answer, where the person already is: the open decisions, when they were asked.
    for (const item of this.work.list({ state: 'needs-you', kind: 'decision', limit: 20 })) {
      entries.push({ kind: 'decision', at: item.createdAt, item });
    }
    return entries.sort((a, b) => a.at.localeCompare(b.at));
  }

  /** The last turns of a thread, oldest first: what the next run carries to the model as messages (D-78). */
  history(id: string, opts: { turns: number; chars: number }): { role: 'user' | 'assistant'; text: string; runId: string; tainted: boolean }[] {
    const rows = this.db.prepare(`
      SELECT id, inputs_json, outputs_json, external_tainted, state FROM runs
      WHERE conversation_id = ? AND state = 'completed' ORDER BY started_at DESC LIMIT ?`)
      .all(id, opts.turns) as { id: string; inputs_json: string; outputs_json: string | null; external_tainted: number; state: string }[];
    const out: { role: 'user' | 'assistant'; text: string; runId: string; tainted: boolean }[] = [];
    let budget = opts.chars;
    for (const row of rows) {
      const you = String((JSON.parse(row.inputs_json) as { input?: unknown }).input ?? '').trim();
      const reply = (outputText(row.outputs_json) ?? '').trim();
      if (!you || !reply) continue;
      // Oldest dropped: the pair is added whole or not at all, so a turn is never half-remembered.
      if (you.length + reply.length > budget) break;
      budget -= you.length + reply.length;
      out.unshift({ role: 'assistant', text: reply, runId: row.id, tainted: row.external_tainted === 1 });
      out.unshift({ role: 'user', text: you, runId: row.id, tainted: false });
    }
    return out;
  }
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
