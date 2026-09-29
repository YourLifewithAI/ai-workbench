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
    expect(weaver.window).toMatchObject({ runs: 3, completed: 2, failed: 1, running: 0, modelCalls: 6 });
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
  }, 120_000);

  it('a child the orchestrator directed is not a line; the exchange that directed it says how many', async () => {
    const { runId } = await say('DELEGATE-ONE: ask the echo to say it back.');
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
    expect(unread.header.finished, 'every exchange, the pulse and the child, plus the planted runs').toBeGreaterThanOrEqual(4);
    expect(unread.header.spentUsd).toBeGreaterThanOrEqual(0);
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
