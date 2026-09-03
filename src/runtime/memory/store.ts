// Memory (D-17, artifacts-and-memory.md). One table, four scopes, three write paths — the `memory.remember`
// tool, the Memory screen, and import. There is no automatic end-of-run extraction: a thing is remembered
// because someone or something decided to remember it, and the trace says which.
//
// `trust` is derived, never declared. A run that has consumed external content writes `untrusted` items, and an
// untrusted item reaches a prompt fenced as data. That is the whole of the defence in SEC-14: a poisoned memory
// is still retrieved and still readable, but it is never an instruction.
import { ulid } from 'ulid';
import type { Db } from '../db/index.js';
import type { EventStore } from '../engine/events.js';

export type MemoryScope = 'agent' | 'user' | 'workspace' | 'project';
export type MemorySource = 'user' | 'agent-tool' | 'import';
export type MemoryTrust = 'trusted' | 'untrusted';

export interface MemoryRow {
  id: string; scope: MemoryScope; owner_id: string; content: string; source: MemorySource; trust: MemoryTrust;
  run_id: string | null; supersedes_id: string | null; created_at: string; expires_at: string | null;
}

export interface RememberInput {
  scope: MemoryScope;
  ownerId: string;
  content: string;
  source: MemorySource;
  trust: MemoryTrust;
  runId?: string | undefined;
  supersedesId?: string | undefined;
  expiresAt?: string | undefined;
}

export interface RetrieveInput {
  /** The scopes this agent may read, each with its owner: `agent:planner`, `project:briefings`, and so on. */
  scopes: { scope: MemoryScope; ownerId: string }[];
  /** FTS query text. Empty means recency only, which is what a step with no task text gets. */
  query: string;
  limit: number;
  now?: Date | undefined;
}

/** What a search or a retrieval hands back: the row's own fields, in the shape the API and the prompt want. */
export interface MemoryHit {
  id: string; scope: MemoryScope; ownerId: string; content: string; source: MemorySource; trust: MemoryTrust;
  runId: string | null; supersedesId: string | null; createdAt: string; expiresAt: string | null;
}

const toHit = (row: MemoryRow): MemoryHit => ({
  id: row.id, scope: row.scope, ownerId: row.owner_id, content: row.content, source: row.source, trust: row.trust,
  runId: row.run_id, supersedesId: row.supersedes_id, createdAt: row.created_at, expiresAt: row.expires_at,
});

/**
 * FTS5 treats a good deal of punctuation as syntax, and a model's search string is prose. Every run of word
 * characters becomes one quoted token, so `ignore your instructions!` searches for those words rather than
 * raising `fts5: syntax error`.
 */
export function ftsQuery(text: string): string | null {
  const terms = text.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!terms?.length) return null;
  return terms.slice(0, 24).map((t) => `"${t}"`).join(' OR ');
}

export class MemoryStore {
  constructor(private readonly db: Db, private readonly events?: EventStore) {}

  remember(input: RememberInput): MemoryHit {
    const row: MemoryRow = {
      id: ulid(), scope: input.scope, owner_id: input.ownerId, content: input.content.trim(),
      source: input.source, trust: input.trust, run_id: input.runId ?? null,
      supersedes_id: input.supersedesId ?? null, created_at: new Date().toISOString(), expires_at: input.expiresAt ?? null,
    };
    this.db.prepare(`INSERT INTO memory_items (id, scope, owner_id, content, source, trust, run_id, supersedes_id, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      row.id, row.scope, row.owner_id, row.content, row.source, row.trust, row.run_id, row.supersedes_id, row.created_at, row.expires_at,
    );
    this.db.prepare('INSERT INTO memory_fts (content, item_id) VALUES (?, ?)').run(row.content, row.id);
    if (input.runId && this.events) {
      this.events.append(input.runId, null, 'memory-written', {
        itemId: row.id, scope: row.scope, ownerId: row.owner_id, trust: row.trust,
        ...(row.supersedes_id ? { supersedesId: row.supersedes_id } : {}),
      });
    }
    return toHit(row);
  }

  byId(id: string): MemoryHit | null {
    const row = this.db.prepare('SELECT * FROM memory_items WHERE id = ?').get(id) as MemoryRow | undefined;
    return row ? toHit(row) : null;
  }

  /**
   * FTS5 plus recency within the scopes the agent may read. Superseded and expired items are never returned: a
   * correction is a new item, and the thing it corrected stops being retrievable the moment it lands.
   */
  retrieve(input: RetrieveInput): MemoryHit[] {
    if (!input.scopes.length || input.limit <= 0) return [];
    const now = (input.now ?? new Date()).toISOString();
    const scopeClause = input.scopes.map(() => '(scope = ? AND owner_id = ?)').join(' OR ');
    const scopeArgs = input.scopes.flatMap((s) => [s.scope, s.ownerId]);
    const live = `(${scopeClause})
      AND id NOT IN (SELECT supersedes_id FROM memory_items WHERE supersedes_id IS NOT NULL)
      AND (expires_at IS NULL OR expires_at > ?)`;

    const matched: MemoryRow[] = [];
    const query = ftsQuery(input.query);
    if (query) {
      matched.push(...(this.db.prepare(`SELECT m.* FROM memory_fts f JOIN memory_items m ON m.id = f.item_id
        WHERE memory_fts MATCH ? AND ${live} ORDER BY rank LIMIT ?`)
        .all(query, ...scopeArgs, now, input.limit) as MemoryRow[]));
    }
    // Recency fills whatever the search did not: a memory nobody phrased the task in the words of is still the
    // most recent thing this agent was told.
    if (matched.length < input.limit) {
      const seen = new Set(matched.map((m) => m.id));
      const recent = this.db.prepare(`SELECT * FROM memory_items WHERE ${live} ORDER BY created_at DESC LIMIT ?`)
        .all(...scopeArgs, now, input.limit) as MemoryRow[];
      for (const row of recent) {
        if (matched.length >= input.limit) break;
        if (!seen.has(row.id)) matched.push(row);
      }
    }
    return matched.slice(0, input.limit).map(toHit);
  }

  search(options: { query?: string | undefined; scope?: MemoryScope | undefined; limit?: number | undefined } = {}): MemoryHit[] {
    const limit = options.limit ?? 50;
    const where: string[] = [];
    const args: unknown[] = [];
    if (options.scope) { where.push('scope = ?'); args.push(options.scope); }
    const query = options.query ? ftsQuery(options.query) : null;
    if (query) {
      return this.db.prepare(`SELECT m.* FROM memory_fts f JOIN memory_items m ON m.id = f.item_id
        WHERE memory_fts MATCH ?${where.length ? ` AND ${where.join(' AND ')}` : ''} ORDER BY rank LIMIT ?`)
        .all(query, ...args, limit).map((r) => toHit(r as MemoryRow));
    }
    return this.db.prepare(`SELECT * FROM memory_items${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`)
      .all(...args, limit).map((r) => toHit(r as MemoryRow));
  }

  /** Which traces hold this item's content, so the delete dialog can say "and the N traces that quoted it". */
  tracesContaining(id: string): string[] {
    const item = this.byId(id);
    if (!item) return [];
    const rows = this.db.prepare('SELECT DISTINCT run_id FROM events WHERE instr(payload_json, ?) > 0 ORDER BY run_id')
      .all(item.content) as { run_id: string }[];
    return rows.map((r) => r.run_id);
  }

  /**
   * Delete, and optionally take the content out of the traces that quoted it (D-35). Redaction rewrites the
   * event payloads in place and appends a `memory-redacted` event to each run, because a trace that changed
   * silently is worse than one that never held the item.
   */
  delete(id: string, redactTraces: boolean): { deleted: boolean; redactedRuns: string[] } {
    const item = this.byId(id);
    if (!item) return { deleted: false, redactedRuns: [] };
    const runs = redactTraces ? this.tracesContaining(id) : [];

    this.db.transaction(() => {
      for (const runId of runs) {
        const rows = this.db.prepare('SELECT seq, payload_json FROM events WHERE run_id = ?').all(runId) as { seq: number; payload_json: string }[];
        for (const row of rows) {
          if (!row.payload_json.includes(item.content)) continue;
          this.db.prepare('UPDATE events SET payload_json = ? WHERE seq = ?')
            .run(row.payload_json.split(item.content).join(`[REDACTED:memory:${id}]`), row.seq);
        }
      }
      this.db.prepare('DELETE FROM memory_fts WHERE item_id = ?').run(id);
      this.db.prepare('DELETE FROM memory_items WHERE id = ?').run(id);
    })();

    for (const runId of runs) {
      this.events?.append(runId, null, 'memory-redacted', { itemId: id, scope: item.scope, ownerId: item.ownerId });
    }
    return { deleted: true, redactedRuns: runs };
  }
}
