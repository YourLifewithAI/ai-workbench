// RUN-26 Definition of done (spec/runs/RUN-26.md). What the thread may and may not carry to the model is the
// security suite's — SEC-47 — and is not repeated here beyond one look; this suite proves the board as shipped:
// the fleet report against a hand count with no model call, the village gone from the tree, a message that is a
// run in the orchestrator's thread, the earlier turns carried as messages, a pulse in the thread and a delegation
// not, a decision answered and read back, and the header that counts from the last read. The browser half is
// `@run-26` in tests/e2e.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ConversationResponse, ConversationSummary, DashboardResponse, FleetResponse, RunDetail, WorkItem, WorkListResponse } from '../../src/shared/api/index.js';
import type { EventRecord } from '../../src/shared/events.js';
import { collectSse, startRuntime, tempWorkspace, waitFor, type Started } from '../helpers/workspace.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let ws: string;
let rt: Started;
let room: ConversationSummary;
let firstRunId: string;
let decisionId: string;

const headers = (): Record<string, string> => ({ Authorization: `Bearer ${rt.token}`, 'Content-Type': 'application/json' });
const api = (method: string, p: string, body?: unknown): Promise<Response> =>
  fetch(`${rt.baseUrl}/api/v1${p}`, { method, headers: headers(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const detail = async (runId: string): Promise<RunDetail> => (await (await api('GET', `/runs/${runId}`)).json()) as RunDetail;
const settled = async (runId: string, ms = 60_000): Promise<RunDetail> => {
  await waitFor(async () => ['completed', 'failed'].includes((await detail(runId)).state), ms);
  return detail(runId);
};
const trace = async (runId: string): Promise<EventRecord[]> =>
  (await (await api('GET', `/runs/${runId}/trace.jsonl`)).text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as EventRecord);
const thread = async (): Promise<ConversationResponse> => (await (await api('GET', `/conversations/${room.id}`)).json()) as ConversationResponse;
const fleet = async (): Promise<FleetResponse> => (await (await api('GET', '/fleet')).json()) as FleetResponse;
const modelCalls = (): number => (rt.runtime.db.prepare('SELECT COUNT(*) AS n FROM model_calls').get() as { n: number }).n;

/** Says something in the orchestrator's thread and waits for the exchange to settle. */
async function say(message: string): Promise<{ runId: string; run: RunDetail }> {
  const res = await api('POST', `/conversations/${room.id}/messages`, { message, provider: 'mock' });
  expect(res.status, await res.clone().text()).toBe(202);
  const { runId, conversationId } = (await res.json()) as { runId: string; conversationId: string };
  expect(conversationId).toBe(room.id);
  const run = await settled(runId);
  expect(run.state, JSON.stringify(run.error)).toBe('completed');
  return { runId, run };
}

const NOW = Date.now();
const daysAgo = (n: number, hours = 0): string => new Date(NOW - n * 86_400_000 + hours * 3_600_000).toISOString();

beforeAll(async () => {
  ws = tempWorkspace('dod26');
  const fixture = (name: string, body: unknown): void => fs.writeFileSync(path.join(ws, 'fixtures', `${name}.json`), JSON.stringify(body, null, 2));
  // The companion answers a plain message plainly and, told to, asks the echo one thing. The shipped pulse
  // fixtures keep the pulse; these sort first and match only their own phrases.
  fixture('aa0-dod26-delegated', { match: { systemIncludes: 'Companion', afterTool: 'agent.delegate' }, respond: { text: 'The echo said it back, as it does.', usage: { input: 500, output: 20 } } });
  fixture('aa1-dod26-delegate', { match: { systemIncludes: 'Companion', lastUserIncludes: 'DELEGATE-ONE' },
    respond: { text: 'Asking the echo.', toolCalls: [{ name: 'agent.delegate', input: { agent: 'echo', input: 'Say this back: the board is up.' } }] } });
  // Slow enough to be followed: the deltas are live, not replayed, so a follower has to arrive while it talks.
  fixture('aa2-dod26-say', { match: { systemIncludes: 'Companion', lastUserIncludes: 'SAY:' }, respond: { text: 'Heard. Nothing of the others has moved since you asked.', chunkDelayMs: 80, usage: { input: 400, output: 30 } } });
  // Slow enough to be answering for a few seconds, so a second message can arrive while it is (DoD 8).
  fixture('aa3-dod26-slow', { match: { systemIncludes: 'Companion', lastUserIncludes: 'SLOW:' }, respond: { text: 'Slowly, so that there is time to interrupt it.', chunkDelayMs: 400, usage: { input: 300, output: 20 } } });
  rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true });
});
afterAll(async () => { await rt.stop(); });

describe('DoD 1: the fleet report says what every card says, from planted rows, with no model call', () => {
  it('names every agent with its spend against its caps, its window by state with the latest summary line, and both rating means with the last why', async () => {
    // The Weaver: two done and one failed this week, one from last month that the window leaves out.
    const run = rt.runtime.db.prepare(`INSERT INTO runs (id, kind, state, agent_id, depth, inputs_json, outputs_json, budgets_json, spent_json, started_at, finished_at)
      VALUES (?, 'agent', ?, 'weaver', 0, '{"input":"planted"}', '{"output":"A scene."}', '{}', ?, ?, ?)`);
    const spent = (cost: number, calls: number): string => JSON.stringify({ costUsd: cost, modelCalls: calls, toolCalls: 0, wallClockMs: 1000 });
    run.run('dod26-w1', 'completed', spent(0.30, 3), daysAgo(1), daysAgo(1, 1));
    run.run('dod26-w2', 'completed', spent(0.20, 2), daysAgo(2), daysAgo(2, 1));
    run.run('dod26-w3', 'failed', spent(0.05, 1), daysAgo(3), daysAgo(3, 1));
    run.run('dod26-w-old', 'completed', spent(9.99, 50), daysAgo(40), daysAgo(40, 1));
    // What a card says it cost, how many calls it made and how many tokens it used are counted from the model calls
    // themselves, inside the window: six calls and 0.55 this week, and the old run's one call is out of it.
    const call = rt.runtime.db.prepare(`INSERT INTO model_calls (id, run_id, step_id, model_id, adapter, prompt_version, usage_json, cost_usd, latency_ms, ts)
      VALUES (?, ?, 'agent', 'anthropic/claude-sonnet-5', 'mock', 'p1', '{"input":100,"output":10}', ?, 1, ?)`);
    for (let i = 0; i < 3; i++) call.run(`dod26-mc-w1-${i}`, 'dod26-w1', 0.10, daysAgo(1));
    for (let i = 0; i < 2; i++) call.run(`dod26-mc-w2-${i}`, 'dod26-w2', 0.10, daysAgo(2));
    call.run('dod26-mc-w3', 'dod26-w3', 0.05, daysAgo(3));
    call.run('dod26-mc-old', 'dod26-w-old', 9.99, daysAgo(40));
    const score = rt.runtime.db.prepare(`INSERT INTO scores (id, run_id, evaluator_id, metric, value, rationale, estimate, ts) VALUES (?, ?, 'orchestrator', 'rating', ?, ?, 1, ?)`);
    score.run('dod26-s1', 'dod26-w1', 4, 'Tight, one flat beat.', daysAgo(1, 2));
    score.run('dod26-s2', 'dod26-w2', 3, 'Lost the premise by the middle.', daysAgo(2, 2));
    rt.runtime.db.prepare(`INSERT INTO ratings (id, run_id, step_id, value, note, ts) VALUES ('dod26-r1', 'dod26-w1', 'main', 5, 'Loved it.', ?)`).run(daysAgo(1, 3));

    const before = modelCalls();
    const report = await fleet();
    expect(modelCalls(), 'the board is facts: no model call to draw it').toBe(before);

    const agents = ((await (await api('GET', '/agents')).json()) as { agents: { id: string }[] }).agents.map((a) => a.id).sort();
    expect([report.orchestrator!.agent.id, ...report.agents.map((a) => a.agent.id)].sort(), 'every agent, once').toEqual(agents);
    expect(report.orchestrator).toMatchObject({ orchestrator: true, agent: { id: 'companion', spend: { dailyCapUsd: 5, monthlyCapUsd: 40 } }, state: 'never' });

    const weaver = report.agents.find((a) => a.agent.id === 'weaver')!;
    // The hand count: three runs in the window, two done, one failed; 0.55 spent over six calls; the old one out.
    expect(weaver.window).toMatchObject({ runs: 3, completed: 2, failed: 1, running: 0, modelCalls: 6, tokensIn: 600, tokensOut: 60 });
    expect(weaver.window.costUsd).toBeCloseTo(0.55, 6);
    expect(weaver.latest).toMatchObject({ runId: 'dod26-w1', state: 'completed', costUsd: 0.30 });
    expect(weaver.latest!.summary[0], 'the run page\'s headline, by the agent\'s name').toMatch(/Weaver/);
    expect(weaver.state, 'its last run finished').toBe('idle');
    expect(weaver.agent.spend, 'no caps of its own').toMatchObject({ dailyCapUsd: null, monthlyCapUsd: null });
    // Two numbers, each saying whose it is, never one (D-06, D-36, D-50): the orchestrator's mean of 4 and 3
    // with the latest why, and the owner's own beside it.
    expect(weaver.ratings.orchestrator).toEqual({ count: 2, mean: 3.5, latestWhy: 'Tight, one flat beat.', latestAt: daysAgo(1, 2) });
    expect(weaver.ratings.owner).toEqual({ count: 1, mean: 5, latestWhy: 'Loved it.', latestAt: daysAgo(1, 3) });
    const echo = report.agents.find((a) => a.agent.id === 'echo')!;
    expect(echo.ratings).toEqual({ orchestrator: { count: 0, mean: null, latestWhy: null, latestAt: null }, owner: { count: 0, mean: null, latestWhy: null, latestAt: null } });
    expect(echo.latest).toBeNull();

    // The window moves with `since`; a bad one is refused.
    const wide = (await (await api('GET', `/fleet?since=${encodeURIComponent(daysAgo(60))}`)).json()) as FleetResponse;
    expect(wide.agents.find((a) => a.agent.id === 'weaver')!.window.runs).toBe(4);
    expect((await api('GET', '/fleet?since=yesterday')).status).toBe(400);
  });
});

describe('DoD 2: the village has left the tree', () => {
  it('no village directory, screen, schema, route, token or test remains', () => {
    for (const gone of ['src/ui/village', 'src/ui/screens/Village.tsx', 'src/shared/village.ts', 'docs/village.md', 'tests/e2e/village.spec.ts', 'tests/unit/village.test.ts', 'tests/dod/RUN-19.test.ts']) {
      expect(fs.existsSync(path.join(REPO, gone)), `${gone} is gone`).toBe(false);
    }
    expect(fs.readFileSync(path.join(REPO, 'src', 'ui', 'styles.css'), 'utf8')).not.toContain('--color-village');
    const app = fs.readFileSync(path.join(REPO, 'src', 'ui', 'App.tsx'), 'utf8');
    expect(app).not.toContain('/village');
    expect(app, 'one door, no breakpoint').toContain("welcomeDone() ? '/dashboard' : '/welcome'");
    // The shell is the shape it had before the village: the screens list is the sidebar at every width.
    const shell = fs.readFileSync(path.join(REPO, 'src', 'ui', 'components', 'Shell.tsx'), 'utf8');
    expect(shell).not.toMatch(/Village|Interior|useLocation/);
    // And the built app carries none of it.
    const assets = path.join(REPO, 'dist', 'ui', 'assets');
    for (const f of fs.readdirSync(assets).filter((f) => f.endsWith('.css'))) {
      expect(fs.readFileSync(path.join(assets, f), 'utf8'), `${f} carries no village token`).not.toContain('color-village');
    }
  });
});

describe('DoD 3: a message posted to the band is a run in the orchestrator\'s thread, and its reply streams', () => {
  it('lands in the orchestrator\'s latest thread, opened the first time; the run carries the thread\'s id; the exchange shows its cost and its run', async () => {
    room = (await (await api('GET', '/conversations/latest')).json()) as ConversationSummary;
    expect(room).toMatchObject({ agentId: 'companion', project: 'companion', lastReadAt: null });
    expect(((await (await api('GET', '/conversations/latest')).json()) as ConversationSummary).id, 'the same thread next time').toBe(room.id);

    const res = await api('POST', `/conversations/${room.id}/messages`, { message: 'SAY: what have the others been doing?', provider: 'mock' });
    expect(res.status, await res.clone().text()).toBe(202);
    const { runId } = (await res.json()) as { runId: string };
    firstRunId = runId;
    // Followed the way the run's page follows it: the same stream, the text as deltas, then the end.
    const controller = new AbortController();
    const sse = collectSse(`${rt.baseUrl}/api/v1/runs/${runId}/events`, rt.token, controller.signal);
    await waitFor(() => sse.events.some((e) => e === 'run-completed' || e === 'run-failed'), 60_000);
    controller.abort();
    expect(sse.events).toContain('model-delta');
    expect(sse.events).toContain('run-completed');

    const row = rt.runtime.db.prepare('SELECT conversation_id, agent_id, project_id, parent_run_id FROM runs WHERE id = ?').get(runId) as { conversation_id: string; agent_id: string; project_id: string; parent_run_id: string | null };
    expect(row).toEqual({ conversation_id: room.id, agent_id: 'companion', project_id: 'companion', parent_run_id: null });
    const t = await thread();
    expect(t.conversation.title, 'titled by the first message').toBe('SAY: what have the others been doing?');
    const exchange = t.entries.find((e) => e.kind === 'exchange' && e.runId === runId);
    expect(exchange).toMatchObject({ kind: 'exchange', state: 'completed', you: 'SAY: what have the others been doing?', reply: 'Heard. Nothing of the others has moved since you asked.', children: 0, tainted: false });
    expect(typeof (exchange as { costUsd: number }).costUsd).toBe('number');
    // Nothing about the run changed: its trace is there, and its own page reads as any run's.
    expect((await trace(runId)).some((e) => e.type === 'run-completed')).toBe(true);
    expect((await detail(runId)).kind).toBe('agent');
  }, 90_000);
});

describe('DoD 4: the next message carries the earlier turns as messages, capped, and none of it as an instruction', () => {
  it('the second turn sees the first as user and assistant messages before its own, and the system string has no word of it', async () => {
    const { runId } = await say('SAY: and the second one?');
    const events = await trace(runId);
    const request = events.find((e) => e.type === 'model-started')!.payload['request'] as { system: string; messages: { role: string; content: unknown }[] };
    expect(request.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(JSON.stringify(request.messages[0])).toContain('what have the others been doing?');
    expect(JSON.stringify(request.messages[1])).toContain('Heard. Nothing of the others has moved');
    expect(JSON.stringify(request.messages[2])).toContain('and the second one?');
    expect(request.system).not.toContain('what have the others been doing?');
    expect(request.system).not.toContain('Heard. Nothing of the others');
    expect(request.system.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(3))).not.toContain('conversation');
    // The cap is the workspace's: eight pairs and twelve thousand characters by default (SEC-47 walks the drop).
    expect(rt.runtime.workspace.config.context).toMatchObject({ conversationTurns: 8, conversationChars: 12_000 });
  }, 90_000);
});

describe('DoD 5: a pulse joins the thread unasked, and a delegation does not', () => {
  it('the pulse is a line in the thread with its note and what it filed; the decision it asked sits there too', async () => {
    const res = await api('POST', '/runs', { kind: 'workflow', id: 'companion-pulse', inputs: {}, provider: 'mock' });
    expect(res.status, await res.clone().text()).toBe(202);
    const { runId } = (await res.json()) as { runId: string };
    const run = await settled(runId, 90_000);
    expect(run.state, JSON.stringify(run.error)).toBe('completed');
    const t = await thread();
    const pulse = t.entries.find((e) => e.kind === 'pulse' && e.runId === runId);
    expect(pulse, 'nobody posted it; it is the companion\'s, so it is here').toMatchObject({ kind: 'pulse', workflowId: 'companion-pulse', state: 'completed' });
    expect((pulse as { note: string }).note).toContain('# The pulse');
    expect((pulse as { filed: WorkItem[] }).filed.map((w) => w.title)).toEqual(['Rate the weaver\'s last draft']);
    const decision = t.entries.find((e) => e.kind === 'decision');
    expect(decision).toBeDefined();
    decisionId = (decision as { item: WorkItem }).item.id;
    expect((decision as { item: WorkItem }).item).toMatchObject({ title: 'Which piece does the weaver take next?', state: 'needs-you', lean: 'a' });
    // By time: the two exchanges, then the pulse, then the question it left.
    expect(t.entries.map((e) => e.kind)).toEqual(['exchange', 'exchange', 'pulse', 'decision']);

    // And the board says whose question it is. The pulse is a workflow run, which has no agent of its own; every
    // step in it is the companion's, so the question waiting on you is on the companion's card, not on nobody's.
    expect(rt.runtime.db.prepare('SELECT agent_id FROM runs WHERE id = ?').get(runId), 'a workflow run has no agent').toEqual({ agent_id: null });
    expect((rt.runtime.db.prepare('SELECT DISTINCT agent_id FROM run_steps WHERE run_id = ? AND agent_id IS NOT NULL').all(runId) as { agent_id: string }[]).map((r) => r.agent_id)).toEqual(['companion']);
    const board = await fleet();
    expect(board.orchestrator).toMatchObject({ orchestrator: true, state: 'waiting', needsYou: { decisions: 1, reviews: 0, approvals: 0 } });
    expect(board.agents.every((a) => a.needsYou.decisions === 0), 'and on nobody else\'s').toBe(true);
    expect(((await (await api('GET', '/dashboard')).json()) as DashboardResponse).decisions, 'the Dashboard counts the same one').toHaveLength(1);
  }, 120_000);

  it('a child the orchestrator directed is not a line; the exchange that directed it says how many', async () => {
    const before = (await thread()).header;
    const { runId } = await say('DELEGATE-ONE: ask the echo to say it back.');
    // One exchange happened, though two runs ran: the header counts the exchange, and its money once.
    const after = (await thread()).header;
    expect(after.finished - before.finished, 'one exchange, not the exchange and its child').toBe(1);
    expect(after.running).toBe(0);
    const child = rt.runtime.db.prepare('SELECT id, agent_id FROM runs WHERE parent_run_id = ?').all(runId) as { id: string; agent_id: string }[];
    expect(child).toHaveLength(1);
    expect(child[0]!.agent_id).toBe('echo');
    const t = await thread();
    expect(t.entries.find((e) => e.kind === 'exchange' && e.runId === runId)).toMatchObject({ children: 1, reply: 'The echo said it back, as it does.' });
    expect(t.entries.some((e) => e.kind !== 'decision' && e.runId === child[0]!.id), 'the child is the parent\'s to name, not a line').toBe(false);
  }, 90_000);
});

describe('DoD 6: a decision answered on the board reads back decided, on the card and in the band alike', () => {
  it('the Dashboard\'s card and the thread\'s entry are the same item; answered once, both read decided', async () => {
    const dash = (await (await api('GET', '/dashboard')).json()) as DashboardResponse;
    expect(dash.decisions.map((d) => d.id)).toEqual([decisionId]);
    expect((await thread()).entries.some((e) => e.kind === 'decision' && e.item.id === decisionId)).toBe(true);

    const answered = await api('PUT', `/work/${decisionId}`, { answer: 'a' });
    expect(answered.status, await answered.clone().text()).toBe(200);
    expect((await answered.json()) as WorkItem).toMatchObject({ state: 'decided', answer: 'a' });

    expect(((await (await api('GET', '/dashboard')).json()) as DashboardResponse).decisions, 'off the card').toEqual([]);
    expect((await thread()).entries.some((e) => e.kind === 'decision'), 'and out of the band').toBe(false);
    const all = ((await (await api('GET', '/work?state=all')).json()) as WorkListResponse).items;
    expect(all.find((i) => i.id === decisionId)).toMatchObject({ state: 'decided', answer: 'a' });
  });
});

describe('DoD 7: the header counts from the last read, and opening the board is the read', () => {
  it('unread, everything counts; read, nothing does until something happens; the runs and the queues are its numbers', async () => {
    const unread = await thread();
    expect(unread.conversation.lastReadAt).toBeNull();
    expect(unread.header.since).toBeNull();
    // The header counts top-level runs: the three exchanges, the pulse and the three planted completed runs. The
    // echo the companion asked is inside its exchange, so it is not a fourth thing that happened.
    expect(unread.header.finished, 'three exchanges, the pulse, three planted runs; not the child').toBe(7);
    expect(rt.runtime.db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE state = 'completed'`).get(), 'the child is in the database, and finished too').toEqual({ n: 8 });
    expect(unread.header.failed, 'the planted one').toBe(1);
    expect(unread.header.running).toBe(0);
    // Money is what the model calls cost, once each: the parent's own and the child's own, not the parent's total
    // (which has the child in it) plus the child's again.
    const calls0 = rt.runtime.db.prepare('SELECT SUM(cost_usd) AS usd FROM model_calls').get() as { usd: number };
    expect(unread.header.spentUsd).toBe(Math.round(calls0.usd * 100) / 100);
    expect(unread.header.needsYou.decisions, 'the question was answered').toBe(0);

    const calls = modelCalls();
    expect((await api('POST', `/conversations/${room.id}/read`, {})).status).toBe(200);
    const read = await thread();
    expect(read.conversation.lastReadAt).not.toBeNull();
    expect(read.header.since).toBe(read.conversation.lastReadAt);
    expect(read.header.finished).toBe(0);
    expect(read.header.failed).toBe(0);
    expect(modelCalls(), 'reading the room costs nothing').toBe(calls);

    // Something happens: one more exchange, and the header says so, counted from the read.
    await say('SAY: anything since?');
    const after = await thread();
    expect(after.header.since).toBe(read.conversation.lastReadAt);
    expect(after.header.finished).toBe(1);
    expect(after.entries.filter((e) => e.kind === 'exchange')).toHaveLength(4);
    expect(after.entries.find((e) => e.kind === 'exchange' && e.runId === firstRunId), 'the first exchange is still the first').toBeDefined();
  }, 90_000);
});

describe('DoD 8: a second message while the first is still being answered is refused, so no turn is answered without the one before it', () => {
  const converse = async (): Promise<string> => ((await (await api('POST', '/conversations', { agent: 'companion' })).json()) as ConversationSummary).id;
  const post = (conversation: string, message: string): Promise<Response> => api('POST', `/conversations/${conversation}/messages`, { message, provider: 'mock' });
  const runsIn = (conversation: string): number => (rt.runtime.db.prepare('SELECT COUNT(*) AS n FROM runs WHERE conversation_id = ?').get(conversation) as { n: number }).n;

  it('answers 409 naming the run that is still going, starts nothing, and takes the next message once that run has completed', async () => {
    const thread8 = await converse();
    const first = await post(thread8, 'SAY: first, and slowly enough to be caught.');
    expect(first.status, await first.clone().text()).toBe(202);
    const { runId } = (await first.json()) as { runId: string };
    expect(['queued', 'running']).toContain((await detail(runId)).state);

    const second = await post(thread8, 'SAY: and the second, at once.');
    expect(second.status).toBe(409);
    const refused = (await second.json()) as { error: { code: string; message: string; details?: { runId: string } } };
    expect(refused.error).toMatchObject({ code: 'conflict', message: 'It is still answering your last message. Wait for it, or cancel that run.', details: { runId } });
    expect(runsIn(thread8), 'the refused message started nothing').toBe(1);
    expect(((await (await api('GET', `/conversations/${thread8}`)).json()) as ConversationResponse).conversation.title, 'nor did it retitle the thread').toBe('SAY: first, and slowly enough to be caught.');

    // Another thread is not held by this one, and a run parked on an approval is waiting for you, not answering: it holds nothing.
    const other = await converse();
    rt.runtime.db.prepare(`INSERT INTO runs (id, kind, state, agent_id, conversation_id, depth, inputs_json, budgets_json, spent_json, started_at)
      VALUES ('dod26-parked', 'agent', 'waiting_approval', 'companion', ?, 0, '{}', '{}', '{"costUsd":0,"modelCalls":0,"toolCalls":0,"wallClockMs":0}', ?)`).run(other, daysAgo(0));
    const elsewhere = await post(other, 'SAY: a different thread, with a run parked on an approval.');
    expect(elsewhere.status, await elsewhere.clone().text()).toBe(202);
    await settled(((await elsewhere.json()) as { runId: string }).runId);

    expect((await settled(runId)).state).toBe('completed');
    const third = await post(thread8, 'SAY: and now the second, once the first is done.');
    expect(third.status, await third.clone().text()).toBe(202);
    const thirdId = ((await third.json()) as { runId: string }).runId;
    await settled(thirdId);
    // The point of the refusal: the turn that was let in carries the reply the first one gave.
    const request = (await trace(thirdId)).find((e) => e.type === 'model-started')!.payload['request'] as { messages: { role: string; content: unknown }[] };
    expect(request.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(JSON.stringify(request.messages[1])).toContain('Heard. Nothing of the others has moved');
  }, 90_000);

  it('lets the next message in once the run that held the thread has been cancelled', async () => {
    const thread8 = await converse();
    const first = await post(thread8, 'SLOW: take your time.');
    expect(first.status, await first.clone().text()).toBe(202);
    const { runId } = (await first.json()) as { runId: string };
    const refused = await post(thread8, 'SAY: while it is still talking.');
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { details: { runId: string } } }).error.details.runId).toBe(runId);
    expect((await api('POST', `/runs/${runId}/cancel`)).status).toBe(202);
    await waitFor(async () => (await detail(runId)).state === 'cancelled', 30_000);
    const after = await post(thread8, 'SAY: after cancelling.');
    expect(after.status, await after.clone().text()).toBe(202);
    await settled(((await after.json()) as { runId: string }).runId);
  }, 90_000);
});

describe('DoD 9: the board is right about workflow steps, the window is a window, and a rating goes to the agent that was rated', () => {
  it('a rating on a step of story-pipeline is the weaver\'s, and its card counts what the weaver\'s own step cost', async () => {
    const before = (await fleet()).agents.find((a) => a.agent.id === 'weaver')!;
    const res = await api('POST', '/runs', { kind: 'workflow', id: 'story-pipeline', inputs: { premise: 'A dentist finds a pattern in a tooth.' }, provider: 'mock' });
    expect(res.status, await res.clone().text()).toBe(202);
    const { runId } = (await res.json()) as { runId: string };
    const run = await settled(runId, 90_000);
    expect(run.state, JSON.stringify(run.error)).toBe('completed');
    expect(rt.runtime.db.prepare('SELECT agent_id FROM runs WHERE id = ?').get(runId), 'the workflow run belongs to no agent').toEqual({ agent_id: null });
    const stepAgents = rt.runtime.db.prepare('SELECT step_id, agent_id FROM run_steps WHERE run_id = ?').all(runId) as { step_id: string; agent_id: string }[];
    expect(stepAgents.find((s) => s.step_id === 'draft')?.agent_id).toBe('weaver');

    // The owner rates the weaver's step; the orchestrator's estimate of it, as its tool would leave it, is beside it.
    const rated = await api('POST', '/ratings', { runId, stepId: 'draft', value: 5, note: 'Loved the drill.' });
    expect(rated.status, await rated.clone().text()).toBe(201);
    rt.runtime.db.prepare(`INSERT INTO scores (id, run_id, evaluator_id, metric, value, rationale, estimate, ts) VALUES ('dod26-est-draft', ?, 'orchestrator', 'rating:draft', 4, 'Tight, one flat beat.', 1, ?)`).run(runId, new Date().toISOString());

    const after = await fleet();
    const weaver = after.agents.find((a) => a.agent.id === 'weaver')!;
    expect(weaver.ratings.owner, 'the planted 5 of DoD 1 and this one, two runs').toMatchObject({ count: 2, mean: 5 });
    expect(weaver.ratings.owner.latestWhy).toBe('Loved the drill.');
    expect(weaver.ratings.orchestrator).toMatchObject({ count: 3, latestWhy: 'Tight, one flat beat.' });
    expect(weaver.ratings.owner.count + weaver.ratings.orchestrator.count, 'two numbers, never one').toBe(5);
    for (const other of ['architect', 'cutter']) expect(after.agents.find((a) => a.agent.id === other)!.ratings.owner.count, `${other} was not rated`).toBe(0);

    // What its step cost is the model calls made inside it, counted once, in dollars and in tokens together.
    const draft = rt.runtime.db.prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(cost_usd), 0) AS usd, COALESCE(SUM(json_extract(usage_json, '$.input')), 0) AS tin
      FROM model_calls WHERE run_id = ? AND step_id = 'draft'`).get(runId) as { calls: number; usd: number; tin: number };
    expect(draft.calls).toBeGreaterThan(0);
    expect(weaver.window.steps - before.window.steps, 'one step of its own started').toBe(1);
    expect(weaver.window.modelCalls - before.window.modelCalls).toBe(draft.calls);
    expect(weaver.window.tokensIn - before.window.tokensIn).toBe(draft.tin);
    expect(weaver.window.costUsd - before.window.costUsd).toBeCloseTo(draft.usd, 6);
    // Every card together is what the model calls cost: nobody's spend is counted twice, or left off.
    const everything = (await (await api('GET', `/fleet?since=${encodeURIComponent(daysAgo(60))}`)).json()) as FleetResponse;
    const total = [everything.orchestrator!, ...everything.agents].reduce((n, a) => n + a.window.costUsd, 0);
    const spent = rt.runtime.db.prepare('SELECT SUM(cost_usd) AS usd FROM model_calls').get() as { usd: number };
    expect(total).toBeCloseTo(spent.usd, 6);
  }, 120_000);

  it('reads `since` however it is written, compares it as time, and says what it used', async () => {
    // The mechanic's runs, planted at noon UTC on days well apart so that no zone changes which side of them a date falls.
    const times = ['2025-03-01T12:00:00.000Z', '2025-03-05T12:00:00.000Z', '2025-03-10T12:00:00.000Z', '2025-03-20T12:00:00.000Z'];
    const run = rt.runtime.db.prepare(`INSERT INTO runs (id, kind, state, agent_id, depth, inputs_json, outputs_json, budgets_json, spent_json, started_at, finished_at)
      VALUES (?, 'agent', 'completed', 'mechanic', 0, '{}', '{"output":"x"}', '{}', '{"costUsd":0.01,"modelCalls":1,"toolCalls":0,"wallClockMs":1}', ?, ?)`);
    const call = rt.runtime.db.prepare(`INSERT INTO model_calls (id, run_id, step_id, model_id, adapter, prompt_version, usage_json, cost_usd, latency_ms, ts)
      VALUES (?, ?, 'agent', 'anthropic/claude-sonnet-5', 'mock', 'p1', '{"input":100,"output":10}', 0.01, 1, ?)`);
    times.forEach((t, i) => { run.run(`dod26-m${i}`, t, t); call.run(`dod26-mc${i}`, `dod26-m${i}`, t); });
    const window = async (since: string): Promise<{ runs: number; tokens: number; calls: number; since: string }> => {
      const res = await api('GET', `/fleet?since=${encodeURIComponent(since)}`);
      expect(res.status, since).toBe(200);
      const body = (await res.json()) as FleetResponse;
      const w = body.agents.find((a) => a.agent.id === 'mechanic')!.window;
      return { runs: w.runs, tokens: w.tokensIn / 100, calls: w.modelCalls, since: body.since };
    };
    // Three ways to write the tenth of March: a date in words (the server's own midnight, still before the tenth's
    // noon and after the fifth's), an offset that is the same noon as the tenth's run (inside: the window is closed),
    // and an ISO time with no milliseconds, which as text sorts after the ones that have them.
    expect(await window('Mar 8 2025')).toMatchObject({ runs: 2, tokens: 2, calls: 2 });
    expect(await window('2025-03-10T14:00:00+02:00')).toEqual({ runs: 2, tokens: 2, calls: 2, since: '2025-03-10T12:00:00.000Z' });
    expect(await window('2025-03-10T12:00:00Z')).toEqual({ runs: 2, tokens: 2, calls: 2, since: '2025-03-10T12:00:00.000Z' });
    // A date far ahead is an empty window and not, as text, every one.
    expect(await window('12/01/2099')).toMatchObject({ runs: 0, tokens: 0, calls: 0 });
    // Not a date, or nothing, is refused.
    expect((await api('GET', '/fleet?since=')).status).toBe(400);
    expect((await api('GET', '/fleet?since=yesterday')).status).toBe(400);
  });
});
