// The room's data (D-77): a conversation is a row, a thread is a view over runs, and the history a turn carries
// is capped by turns and by characters: the oldest pair is dropped whole, and the newest is never dropped at all —
// it is cut to fit instead, so one long message cannot leave a thread with no memory (D-78).
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { ConversationStore } from '../../src/runtime/conversations/store.js';
import { WorkStore } from '../../src/runtime/work/store.js';
import { PostMessageRequest, ThreadEntry } from '../../src/shared/api/index.js';
import type { Db } from '../../src/runtime/db/index.js';

let db: Db;
let store: ConversationStore;
let work: WorkStore;
let clock = 0;

/**
 * The schema, from the migrations themselves: a store test that invented its own tables would prove nothing. In
 * memory and inside one transaction, so a slow disk (a CI runner's) cannot be what a test waits for.
 */
function open(): Db {
  const database = new Database(':memory:');
  const migrations = path.join(process.cwd(), 'src', 'runtime', 'db', 'migrations');
  database.exec('BEGIN');
  for (const file of fs.readdirSync(migrations).sort()) database.exec(fs.readFileSync(path.join(migrations, file), 'utf8'));
  database.exec('COMMIT');
  return database as unknown as Db;
}

const at = (): string => new Date(Date.UTC(2026, 8, 12, 0, 0, clock++)).toISOString();

/** An exchange, as the engine leaves one: a run with the thread's id, its input and its output. */
function exchange(conversationId: string | null, you: string, reply: string | null, opts: {
  agent?: string; tainted?: boolean; privateTainted?: boolean; state?: string; kind?: string; workflow?: string; error?: unknown; startedAt?: string;
} = {}): string {
  const id = `run-${clock}`;
  db.prepare(`INSERT INTO runs (id, kind, state, agent_id, workflow_id, conversation_id, depth, inputs_json, outputs_json, budgets_json, spent_json, external_tainted, private_tainted, started_at, finished_at, error_json)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, '{}', ?, ?, ?, ?, ?, ?)`)
    .run(id, opts.kind ?? 'agent', opts.state ?? 'completed', opts.agent ?? 'companion', opts.workflow ?? null, conversationId,
      JSON.stringify({ input: you }), reply === null ? null : JSON.stringify({ output: reply }), JSON.stringify({ costUsd: 0.02 }),
      opts.tainted ? 1 : 0, opts.privateTainted ? 1 : 0, opts.startedAt ?? at(), at(), opts.error === undefined ? null : JSON.stringify(opts.error));
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

  it('puts the newer of two threads touched in the same millisecond first, and lands the owner in it', () => {
    // A tie is what a fast disk makes of "created, then created again": the second must not come back second.
    const stamp = '2026-09-12T00:00:00.000Z';
    const older = store.create({ agentId: 'companion' });
    const newer = store.create({ agentId: 'companion' });
    const other = store.create({ agentId: 'weaver' });
    db.prepare('UPDATE conversations SET updated_at = ?').run(stamp);
    expect(store.list('companion').map((c) => c.id)).toEqual([newer.id, older.id]);
    expect(store.list().map((c) => c.id), 'every agent\'s, newest first').toEqual([other.id, newer.id, older.id]);
    expect(store.latestOrCreate('companion').id).toBe(newer.id);
    // A later touch still beats any tie.
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run('2026-09-12T00:00:01.000Z', older.id);
    expect(store.latestOrCreate('companion').id).toBe(older.id);
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
    expect(first).toMatchObject({ runId: one, you: 'What happened?', reply: 'Two runs, both fine.', children: 1, costUsd: 0.02, tainted: false, error: null });
    const second = entries[1] as Extract<typeof entries[number], { kind: 'pulse' }>;
    expect(second).toMatchObject({ runId: pulse, workflowId: 'companion-pulse', children: 0, tainted: false });
    expect(second.note).toContain('The pulse');
    expect(second.filed.map((i) => i.title), 'what that run filed, under it').toEqual(['Rate the draft']);
    expect(first.filed).toEqual([]);
    expect(store.thread('nope')).toEqual([]);
  });

  it('keeps exchanges that began in the same millisecond in the order they were made', () => {
    const conversation = store.create({ agentId: 'companion' });
    const stamp = '2026-09-12T00:00:00.000Z';
    const a = exchange(conversation.id, 'first', 'one', { startedAt: stamp });
    const b = exchange(conversation.id, 'second', 'two', { startedAt: stamp });
    const c = exchange(conversation.id, 'third', 'three', { startedAt: stamp });
    expect(store.thread(conversation.id).map((e) => (e as { runId: string }).runId)).toEqual([a, b, c]);
    // With room for two, it is the last two that stay, not the first two.
    expect(store.thread(conversation.id, 2).map((e) => (e as { runId: string }).runId)).toEqual([b, c]);
    expect(store.history(conversation.id, { turns: 2, chars: 10_000 }).map((m) => m.text)).toEqual(['second', 'two', 'third', 'three']);
  });

  it('says whether a pulse read something from outside, and why an exchange failed in a short plain sentence', () => {
    const conversation = store.create({ agentId: 'companion' });
    const ok = exchange(conversation.id, 'How did it go?', 'Well.');
    // Assembled at run time: a key-shaped literal in the source would (rightly) trip the secret scanner.
    const key = ['sk', 'ant', 'api03', 'AbCdEf0123456789AbCdEf0123456789AbCdEf'].join('-');
    const failed = exchange(conversation.id, 'Try the provider.', null, {
      state: 'failed',
      error: {
        reason: 'model-failed', message: `The model provider refused the key ${key}.\n    at Adapter.call (/srv/workbench/dist/adapter.js:10:5)`,
        error: { stack: 'Error: refused\n    at Adapter.call (/srv/workbench/dist/adapter.js:10:5)' },
      },
    });
    const long = exchange(conversation.id, 'Say it all.', null, { state: 'failed', error: { reason: 'error', message: 'Word '.repeat(200) } });
    const bare = exchange(conversation.id, 'Nothing recorded.', null, { state: 'failed' });
    const cancelled = exchange(conversation.id, 'Stop.', null, { state: 'cancelled', error: { reason: 'cancelled', message: 'cancelled' } });
    const pulse = exchange(null, '', 'A page of notes.', { kind: 'workflow', workflow: 'companion-pulse', agent: null as unknown as string, tainted: true });
    db.prepare("INSERT INTO run_steps (run_id, step_id, kind, state, agent_id) VALUES (?, 'pulse', 'agent', 'completed', 'companion')").run(pulse);

    const entries = store.thread(conversation.id);
    const byRun = (id: string) => entries.find((e) => e.kind !== 'decision' && e.runId === id)!;
    expect(byRun(ok)).toMatchObject({ kind: 'exchange', error: null });
    const reason = (byRun(failed) as Extract<ThreadEntry, { kind: 'exchange' }>).error!;
    expect(reason).toContain('The model provider refused the key');
    expect(reason, 'no key').not.toContain('sk-ant');
    expect(reason, 'no stack').not.toMatch(/\bat\s|adapter\.js|\n/);
    expect((byRun(long) as Extract<ThreadEntry, { kind: 'exchange' }>).error!.length, 'cut short').toBeLessThanOrEqual(200);
    expect((byRun(long) as Extract<ThreadEntry, { kind: 'exchange' }>).error).toMatch(/^Word Word/);
    expect((byRun(bare) as Extract<ThreadEntry, { kind: 'exchange' }>).error, 'failed with nothing written down').toBe('The run failed.');
    expect((byRun(cancelled) as Extract<ThreadEntry, { kind: 'exchange' }>).error, 'a stop is not a failure').toBeNull();
    expect(byRun(pulse)).toMatchObject({ kind: 'pulse', tainted: true });
    // Whatever the store hands the API is what the API's schema accepts.
    for (const entry of entries) expect(ThreadEntry.safeParse(entry).success, JSON.stringify(entry).slice(0, 200)).toBe(true);
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

  it('says which turns came from a run that had read private content, so the next one can be marked (D-29)', () => {
    const conversation = store.create({ agentId: 'companion' });
    exchange(conversation.id, 'clean', 'clean reply');
    exchange(conversation.id, 'what is in my notes?', 'Your notes say the plan is next.', { privateTainted: true });
    exchange(conversation.id, 'and the web?', 'The web says so too.', { tainted: true, privateTainted: true });
    const history = store.history(conversation.id, { turns: 10, chars: 10_000 });
    expect(history.filter((m) => m.privateTainted).map((m) => m.text)).toEqual(['Your notes say the plan is next.', 'The web says so too.']);
    expect(history.filter((m) => m.tainted).map((m) => m.text), 'the two marks are separate').toEqual(['The web says so too.']);
    // What he said is his own words, whatever the reply to it had read.
    expect(history.filter((m) => m.role === 'user').every((m) => !m.tainted && !m.privateTainted)).toBe(true);
    expect(history.find((m) => m.text === 'clean reply')).toMatchObject({ tainted: false, privateTainted: false });
  });

  it('carries only the turns that came before a given run, which is what resuming an earlier turn is owed', () => {
    const conversation = store.create({ agentId: 'companion' });
    const one = exchange(conversation.id, 'one', 'first reply');
    const stopped = exchange(conversation.id, 'two', null, { state: 'failed' });
    exchange(conversation.id, 'three', 'third reply');
    expect(store.history(conversation.id, { turns: 10, chars: 10_000, before: stopped }).map((m) => m.runId)).toEqual([one, one]);
    expect(store.history(conversation.id, { turns: 10, chars: 10_000, before: one })).toEqual([]);
    expect(store.history(conversation.id, { turns: 10, chars: 10_000, before: 'no-such-run' }), 'a run that is not there has no before').toEqual([]);
  });

  it('carries nothing when it is allowed no turns or no characters', () => {
    const conversation = store.create({ agentId: 'companion' });
    exchange(conversation.id, 'one', 'first reply');
    expect(store.history(conversation.id, { turns: 0, chars: 10_000 })).toEqual([]);
    expect(store.history(conversation.id, { turns: 8, chars: 0 })).toEqual([]);
  });
});

describe('one long turn does not wipe the thread (D-78)', () => {
  const CLIP = '[…clipped]';
  const size = (messages: { text: string }[]): number => messages.reduce((n, m) => n + m.text.length, 0);

  it('carries a newest pair that is bigger than the budget, cut to fit, and then only what still fits', () => {
    const conversation = store.create({ agentId: 'companion' });
    const older = exchange(conversation.id, 'a small question', 'a small answer');
    const newest = exchange(conversation.id, `Q${'q'.repeat(8_999)}`, `A${'a'.repeat(3_999)}`);
    const history = store.history(conversation.id, { turns: 8, chars: 12_000 });
    // The newest turn is there: cut, and within the budget, with the head of each side kept and the cut marked.
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(history.every((m) => m.runId === newest)).toBe(true);
    expect(size(history)).toBeLessThanOrEqual(12_000);
    expect(history[0]!.text.startsWith('Qqqq')).toBe(true);
    expect(history[0]!.text.endsWith(CLIP)).toBe(true);
    expect(history[1]!.text.startsWith('Aaaa')).toBe(true);
    expect(history[0]!.text.length, 'the longer side gives up the room').toBeLessThan(9_000);
    // The older pair did not fit beside it, and it goes: whole or not at all.
    expect(history.some((m) => m.runId === older)).toBe(false);
  });

  it('keeps the older pair when it fits beside the newest one, and stops at the first that does not', () => {
    const conversation = store.create({ agentId: 'companion' });
    const oldest = exchange(conversation.id, 'oldest question', 'oldest answer');
    const middle = exchange(conversation.id, 'm'.repeat(6_000), 'M'.repeat(3_000));
    const newest = exchange(conversation.id, 'n'.repeat(1_500), 'N'.repeat(1_500));
    const history = store.history(conversation.id, { turns: 8, chars: 10_000 });
    // 3,000 for the newest leaves 7,000; the middle's 9,000 does not fit, and the walk ends there — the oldest is
    // small enough to fit, but a thread with a hole in the middle is not a thread.
    expect(history.map((m) => m.runId)).toEqual([newest, newest]);
    expect(history.some((m) => m.runId === middle || m.runId === oldest)).toBe(false);
    const roomy = store.history(conversation.id, { turns: 8, chars: 12_100 });
    expect(roomy.map((m) => m.runId), 'with room for the middle it comes, and the oldest with it').toEqual([oldest, oldest, middle, middle, newest, newest]);
    expect(roomy.some((m) => m.text.endsWith(CLIP)), 'nothing is cut that fits').toBe(false);
  });

  it('carries a 20,000-character message and a five-character reply: the reply whole, the message cut', () => {
    const conversation = store.create({ agentId: 'companion' });
    exchange(conversation.id, 'earlier', 'earlier reply');
    exchange(conversation.id, `S${'s'.repeat(19_999)}`, 'Sure.');
    const history = store.history(conversation.id, { turns: 8, chars: 12_000 });
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(history[1]!.text, 'a short reply is not cut to nothing').toBe('Sure.');
    expect(history[0]!.text.startsWith('Sss')).toBe(true);
    expect(history[0]!.text.endsWith(CLIP)).toBe(true);
    expect(size(history)).toBeLessThanOrEqual(12_000);
  });

  it('cuts a reply that is the long side, and a pair where both are long, each in its share', () => {
    const conversation = store.create({ agentId: 'companion' });
    exchange(conversation.id, 'Tell me everything.', `R${'r'.repeat(29_999)}`);
    const tall = store.history(conversation.id, { turns: 8, chars: 12_000 });
    expect(tall[0]!.text, 'a short question is kept whole').toBe('Tell me everything.');
    expect(tall[1]!.text.endsWith(CLIP)).toBe(true);
    expect(size(tall)).toBeLessThanOrEqual(12_000);

    const both = store.create({ agentId: 'companion' });
    exchange(both.id, `U${'u'.repeat(9_999)}`, `R${'r'.repeat(9_999)}`);
    const halves = store.history(both.id, { turns: 8, chars: 12_000 });
    expect(halves.map((m) => m.text.length)).toEqual([6_000, 6_000]);
    expect(halves.every((m) => m.text.endsWith(CLIP))).toBe(true);
  });

  it('keeps the mark of a pair that was cut: what was clipped off does not wash the rest clean', () => {
    const conversation = store.create({ agentId: 'companion' });
    const newest = exchange(conversation.id, 'Read it all.', `W${'w'.repeat(19_999)}`, { tainted: true, privateTainted: true });
    const history = store.history(conversation.id, { turns: 8, chars: 12_000 });
    expect(history.map((m) => m.runId)).toEqual([newest, newest]);
    expect(history[1]).toMatchObject({ tainted: true, privateTainted: true });
    expect(history[1]!.text.endsWith(CLIP)).toBe(true);
  });

  it('does not split a character in two at the cut', () => {
    const conversation = store.create({ agentId: 'companion' });
    // An emoji is two UTF-16 units: a cut through the middle would leave half of one, which a provider refuses.
    exchange(conversation.id, '😀'.repeat(10_000), 'ok');
    const [you] = store.history(conversation.id, { turns: 8, chars: 12_000 });
    const body = you!.text.slice(0, -(CLIP.length + 1));
    expect(body.length % 2, 'whole emoji only').toBe(0);
    expect(body).toMatch(/^(?:😀)+$/u);
  });

  it('is the ordinary case when nothing is too big: every pair whole, nothing marked', () => {
    const conversation = store.create({ agentId: 'companion' });
    exchange(conversation.id, 'one', 'first reply');
    exchange(conversation.id, 'two', 'second reply');
    const history = store.history(conversation.id, { turns: 8, chars: 12_000 });
    expect(history.map((m) => m.text)).toEqual(['one', 'first reply', 'two', 'second reply']);
  });
});

describe('what a person may post', () => {
  it('is trimmed before it is counted, so a message of nothing but whitespace is refused like an empty one', () => {
    for (const blank of ['', '   ', '\n\t ', '\u00a0\u00a0', '\u2003']) {
      expect(PostMessageRequest.safeParse({ message: blank }).success, JSON.stringify(blank)).toBe(false);
    }
    const padded = PostMessageRequest.parse({ message: '  hello there \n' });
    expect(padded.message, 'the words, without the padding').toBe('hello there');
    expect(PostMessageRequest.safeParse({ message: 'x'.repeat(20_000) }).success).toBe(true);
    expect(PostMessageRequest.safeParse({ message: 'x'.repeat(20_001) }).success).toBe(false);
    expect(PostMessageRequest.parse({ message: 'hi', provider: 'mock' }).provider).toBe('mock');
  });
});
