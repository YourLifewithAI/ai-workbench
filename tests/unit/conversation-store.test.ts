// The room's data (D-77): a conversation is a row, a thread is a view over runs, and the history a turn carries
// is capped by turns and by characters with the oldest pair dropped whole.
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ConversationStore } from '../../src/runtime/conversations/store.js';
import { WorkStore } from '../../src/runtime/work/store.js';
import type { Db } from '../../src/runtime/db/index.js';

let db: Db;
let store: ConversationStore;
let work: WorkStore;
let clock = 0;

/** The schema, from the migrations themselves: a store test that invented its own tables would prove nothing. */
function open(): Db {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-conv-'));
  const database = new Database(path.join(dir, 'test.db'));
  const migrations = path.join(process.cwd(), 'src', 'runtime', 'db', 'migrations');
  for (const file of fs.readdirSync(migrations).sort()) database.exec(fs.readFileSync(path.join(migrations, file), 'utf8'));
  return database as unknown as Db;
}

const at = (): string => new Date(Date.UTC(2026, 8, 12, 0, 0, clock++)).toISOString();

/** An exchange, as the engine leaves one: a run with the thread's id, its input and its output. */
function exchange(conversationId: string | null, you: string, reply: string | null, opts: { agent?: string; tainted?: boolean; state?: string; kind?: string; workflow?: string } = {}): string {
  const id = `run-${clock}`;
  db.prepare(`INSERT INTO runs (id, kind, state, agent_id, workflow_id, conversation_id, depth, inputs_json, outputs_json, budgets_json, spent_json, external_tainted, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, '{}', ?, ?, ?, ?)`)
    .run(id, opts.kind ?? 'agent', opts.state ?? 'completed', opts.agent ?? 'companion', opts.workflow ?? null, conversationId,
      JSON.stringify({ input: you }), reply === null ? null : JSON.stringify({ output: reply }), JSON.stringify({ costUsd: 0.02 }),
      opts.tainted ? 1 : 0, at(), at());
  return id;
}

beforeEach(() => {
  clock = 0;
  db = open();
  work = new WorkStore(db);
  store = new ConversationStore(db, work);
});

describe('a conversation', () => {
  it('is created, named by its first message, renamed by a person, and listed newest first', () => {
    const first = store.create({ agentId: 'companion', project: 'companion' });
    expect(first.title).toBe('New conversation');
    expect(first.lastReadAt).toBeNull();
    store.touch(first.id, '  What did   the village do   today?  ');
    expect(store.get(first.id)!.title, 'the first message names it, whitespace collapsed').toBe('What did the village do today?');
    // A later message does not rename it.
    store.touch(first.id, 'And the second one?');
    expect(store.get(first.id)!.title).toBe('What did the village do today?');
    expect(store.rename(first.id, 'The village')!.title).toBe('The village');

    const second = store.create({ agentId: 'companion' });
    expect(store.list('companion').map((c) => c.id)).toEqual([second.id, first.id]);
    expect(store.list('weaver')).toEqual([]);
    expect(store.rename('nope', 'x')).toBeNull();
    expect(store.markRead('nope')).toBeNull();
  });

  it('lands the owner in the agent\'s most recent thread, and opens one the first time', () => {
    const made = store.latestOrCreate('companion', 'companion');
    expect(store.latestOrCreate('companion').id, 'the same room, not a new one every visit').toBe(made.id);
    expect(store.list('companion')).toHaveLength(1);
  });
});

describe('the thread', () => {
  it('holds the exchanges and the loop\'s runs, but never a child, and carries what each filed', () => {
    const conversation = store.create({ agentId: 'companion' });
    const one = exchange(conversation.id, 'What happened?', 'Two runs, both fine.');
    // A pulse: a workflow run with a companion step and no conversation of its own.
    const pulse = exchange(null, '', '# The pulse\n\nNothing needs you.', { kind: 'workflow', workflow: 'companion-pulse', agent: null as unknown as string });
    db.prepare("INSERT INTO run_steps (run_id, step_id, kind, state, agent_id) VALUES (?, 'pulse', 'agent', 'completed', 'companion')").run(pulse);
    // A child of the exchange: the delegation is counted on its parent, never a line of its own.
    db.prepare(`INSERT INTO runs (id, kind, state, agent_id, parent_run_id, depth, inputs_json, budgets_json, spent_json, started_at)
      VALUES ('child-1', 'agent', 'completed', 'weaver', ?, 1, '{}', '{}', '{}', ?)`).run(one, at());
    // Another agent's solo run is not this thread's business.
    exchange(null, 'unrelated', 'nope', { agent: 'weaver' });
    const item = work.file({ kind: 'task', project: null, title: 'Rate the draft', detail: null, state: 'needs-you', assignee: null, key: null, trust: 'trusted', runId: pulse });
    expect(item.outcome).toBe('filed');

    const entries = store.thread(conversation.id);
    expect(entries.map((e) => e.kind)).toEqual(['exchange', 'pulse']);
    const first = entries[0] as Extract<typeof entries[number], { kind: 'exchange' }>;
    expect(first).toMatchObject({ runId: one, you: 'What happened?', reply: 'Two runs, both fine.', children: 1, costUsd: 0.02, tainted: false });
    const second = entries[1] as Extract<typeof entries[number], { kind: 'pulse' }>;
    expect(second).toMatchObject({ runId: pulse, workflowId: 'companion-pulse', children: 0 });
    expect(second.note).toContain('The pulse');
    expect(second.filed.map((i) => i.title), 'what that run filed, under it').toEqual(['Rate the draft']);
    expect(first.filed).toEqual([]);
    expect(store.thread('nope')).toEqual([]);
  });

  it('puts an open decision in the thread, and drops it once it is answered', () => {
    const conversation = store.create({ agentId: 'companion' });
    exchange(conversation.id, 'Anything for me?', 'One question.');
    const filed = work.file({
      kind: 'decision', project: null, title: 'Which piece next?', detail: 'Part one landed well.', state: 'needs-you',
      assignee: null, key: 'next', trust: 'trusted', runId: null,
      options: [{ id: 'a', label: 'Part two', detail: null }, { id: 'b', label: 'The village', detail: null }], lean: 'a',
    });
    const withDecision = store.thread(conversation.id);
    expect(withDecision.map((e) => e.kind)).toContain('decision');
    // A decision that is not a decision of the ledger's is not in the thread: it is answered, so it is gone.
    work.update(filed.item.id, { answer: 'a' });
    expect(store.thread(conversation.id).map((e) => e.kind)).not.toContain('decision');
  });
});

describe('the history a turn carries (D-78)', () => {
  it('is the last completed pairs, oldest first, capped by turns and by characters, and never half a turn', () => {
    const conversation = store.create({ agentId: 'companion' });
    exchange(conversation.id, 'one', 'first reply');
    exchange(conversation.id, 'two', 'second reply');
    exchange(conversation.id, 'three', 'third reply');
    // A run still going, and one that failed: neither is a turn anyone said.
    exchange(conversation.id, 'four', null, { state: 'running' });
    exchange(conversation.id, 'five', 'never', { state: 'failed' });

    const all = store.history(conversation.id, { turns: 10, chars: 10_000 });
    expect(all.map((m) => m.text)).toEqual(['one', 'first reply', 'two', 'second reply', 'three', 'third reply']);
    expect(all.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);

    expect(store.history(conversation.id, { turns: 1, chars: 10_000 }).map((m) => m.text)).toEqual(['three', 'third reply']);
    // A character budget that fits one pair and not two takes the newest, whole.
    const tight = store.history(conversation.id, { turns: 10, chars: 'three'.length + 'third reply'.length });
    expect(tight.map((m) => m.text)).toEqual(['three', 'third reply']);
  });

  it('says which turns came from a run that had read the web, so the next one can be marked', () => {
    const conversation = store.create({ agentId: 'companion' });
    exchange(conversation.id, 'clean', 'clean reply');
    exchange(conversation.id, 'what did the researcher find?', 'It found this on the web.', { tainted: true });
    const history = store.history(conversation.id, { turns: 10, chars: 10_000 });
    expect(history.filter((m) => m.tainted).map((m) => m.text)).toEqual(['It found this on the web.']);
    expect(history.find((m) => m.text === 'clean reply')!.tainted).toBe(false);
  });
});
