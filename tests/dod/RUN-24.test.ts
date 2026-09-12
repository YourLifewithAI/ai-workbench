// RUN-24 Definition of done (spec/runs/RUN-24.md). The ledger's trust and dedupe and the detached child's budget
// are the security suite's — SEC-44 and SEC-46 — and are not repeated here; this suite proves the pulse as
// shipped: the companion on a loop on the mock, filing, asking, reading the owner's answer and acting on it, and
// the two facts on its card. The browser half is `@run-24` in tests/e2e.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AgentListResponse, DashboardResponse, RunDetail, ScheduleSummary, WorkItem, WorkListResponse } from '../../src/shared/api/index.js';
import type { EventRecord } from '../../src/shared/events.js';
import { startRuntime, tempWorkspace, waitFor, type Started } from '../helpers/workspace.js';

let ws: string;
let rt: Started;
let decisionId: string;

const headers = (): Record<string, string> => ({ Authorization: `Bearer ${rt.token}`, 'Content-Type': 'application/json' });
const api = (method: string, p: string, body?: unknown): Promise<Response> =>
  fetch(`${rt.baseUrl}/api/v1${p}`, { method, headers: headers(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const detail = async (runId: string): Promise<RunDetail> => (await (await api('GET', `/runs/${runId}`)).json()) as RunDetail;
const settled = async (runId: string, ms = 60_000): Promise<RunDetail> => {
  await waitFor(async () => ['completed', 'failed'].includes((await detail(runId)).state), ms);
  return detail(runId);
};
async function trace(runId: string): Promise<EventRecord[]> {
  return (await (await api('GET', `/runs/${runId}/trace.jsonl`)).text()).trim().split('\n').map((l) => JSON.parse(l) as EventRecord);
}
const toolResults = (events: EventRecord[], tool: string): EventRecord[] => events.filter((e) => e.type === 'tool-completed' && e.payload['tool'] === tool);
const open = async (): Promise<WorkItem[]> => ((await (await api('GET', '/work?state=open')).json()) as WorkListResponse).items;
async function pulse(): Promise<{ runId: string; run: RunDetail; events: EventRecord[] }> {
  const res = await api('POST', '/runs', { kind: 'workflow', id: 'companion-pulse', inputs: {}, provider: 'mock' });
  expect(res.status, await res.clone().text()).toBe(202);
  const { runId } = (await res.json()) as { runId: string };
  const run = await settled(runId);
  expect(run.state, JSON.stringify(run.error)).toBe('completed');
  return { runId, run, events: await trace(runId) };
}

beforeAll(async () => {
  ws = tempWorkspace('dod24');
  // The shipped grants stay as shipped — the companion's are the point. The Weaver gets what a let-go child needs.
  const file = path.join(ws, 'config', 'workbench.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8')) as { grants: Record<string, unknown> };
  config.grants['weaver'] = { tools: { 'artifact.write': 'allow' }, fs: { read: ['projects/'], write: ['projects/'] } };
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true });
});
afterAll(async () => { await rt.stop(); });

describe('DoD 1: the pulse ships, seeded paused, and is the companion\'s heartbeat', () => {
  it('every two hours, off until turned on, no catch-up; the card shows it and the companion\'s spend against its caps', async () => {
    const schedules = ((await (await api('GET', '/schedules')).json()) as { schedules: ScheduleSummary[] }).schedules;
    const s = schedules.find((x) => x.workflowId === 'companion-pulse');
    expect(s, 'seeded from the workflow file').toBeDefined();
    expect(s).toMatchObject({ cron: '0 */2 * * *', enabled: false, catchUp: 'none', seededFromFile: true, project: 'companion' });

    let agents = ((await (await api('GET', '/agents')).json()) as AgentListResponse).agents;
    const companion = agents.find((a) => a.id === 'companion')!;
    // Spend: its runs and every run beneath them, against its own caps. Nothing has run yet.
    expect(companion.spend).toEqual({ todayUsd: 0, thisMonthUsd: 0, dailyCapUsd: 5, monthlyCapUsd: 40 });
    // An agent with no caps shows its spend against nothing; an agent on no loop has no heartbeat.
    const echo = agents.find((a) => a.id === 'echo')!;
    expect(echo.spend).toEqual({ todayUsd: 0, thisMonthUsd: 0, dailyCapUsd: null, monthlyCapUsd: null });
    expect(echo.heartbeat).toBeUndefined();
    // Two loops name the companion, both off; turning the pulse on makes it the one on the card, with a next time.
    expect(companion.heartbeat?.enabled).toBe(false);
    const on = await api('POST', `/schedules?id=${s!.id}`, { workflowId: 'companion-pulse', cron: s!.cron, inputs: {}, project: 'companion', enabled: true, catchUp: 'none' });
    expect(on.status, await on.clone().text()).toBeLessThan(300);
    agents = ((await (await api('GET', '/agents')).json()) as AgentListResponse).agents;
    const heartbeat = agents.find((a) => a.id === 'companion')!.heartbeat!;
    expect(heartbeat).toMatchObject({ workflowId: 'companion-pulse', workflowName: 'The pulse', cron: '0 */2 * * *', enabled: true });
    expect(heartbeat.nextFireAt, 'a next time, once on').toBeTruthy();
    // Back off: the scheduler is not running in this suite, and the shipped state is off.
    await api('POST', `/schedules?id=${s!.id}`, { workflowId: 'companion-pulse', cron: s!.cron, inputs: {}, project: 'companion', enabled: false, catchUp: 'none' });
  });
});

describe('DoD 2: the first pulse reads the facts and the ledger, then files and asks', () => {
  it('files one task under needs-you, asks one decision with its lean, notes the pulse, and the Dashboard shows both', async () => {
    const { runId, run, events } = await pulse();
    expect(run.project).toBe('companion');
    expect(toolResults(events, 'runs.facts')[0]?.payload['ok'], 'the facts step').toBe(true);
    expect(toolResults(events, 'work.list')[0]?.payload['ok'], 'the ledger step').toBe(true);
    expect(toolResults(events, 'work.file')[0]?.payload['ok'], 'the pulse filed').toBe(true);
    expect(toolResults(events, 'owner.ask')[0]?.payload['ok'], 'the pulse asked').toBe(true);

    const items = await open();
    const task = items.find((i) => i.kind === 'task')!;
    expect(task).toMatchObject({ title: 'Rate the weaver\'s last draft', state: 'needs-you', key: 'unrated:weaver', trust: 'trusted', runId });
    const decision = items.find((i) => i.kind === 'decision')!;
    expect(decision).toMatchObject({ title: 'Which piece does the weaver take next?', state: 'needs-you', key: 'next-piece', lean: 'a', answer: null });
    expect(decision.options.map((o) => o.id)).toEqual(['a', 'b']);
    expect(decision.options[0]!.label).toBe('The arcology, part two');
    decisionId = decision.id;

    const docs = ((await (await api('GET', '/projects/companion/documents')).json()) as { documents: { path: string; id: string }[] }).documents;
    const note = docs.find((d) => d.path === `pulse/${runId}.md`);
    expect(note, 'a note per pulse, by run id').toBeDefined();
    const content = (await (await api('GET', `/documents/${note!.id}`)).json()) as { content: string };
    expect(content.content).toContain('# The pulse');
    expect(content.content).toContain('**Needs you:**');

    const dash = (await (await api('GET', '/dashboard')).json()) as DashboardResponse;
    expect(dash.decisions.map((d) => d.id)).toEqual([decisionId]);
    expect(dash.work).toMatchObject({ open: 2, needsYou: 2 });
  }, 90_000);

  it('a second pulse before the owner answers refreshes what it filed and never doubles it', async () => {
    const { events } = await pulse();
    const filed = toolResults(events, 'work.file')[0]!.payload['output'] as { outcome: string };
    expect(filed.outcome).toBe('refreshed');
    const items = await open();
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.kind === 'decision')!.id, 'the same question, once').toBe(decisionId);
  }, 90_000);
});

describe('DoD 3: an answer on the Dashboard is read by the next pulse, which acts', () => {
  it('the owner picks; the next pulse staffs the weaver, lets it go, closes the question by key, and the child runs on alone', async () => {
    const answered = await api('PUT', `/work/${decisionId}`, { answer: 'a', note: 'Part two. Keep it short.' });
    expect(answered.status, await answered.clone().text()).toBe(200);
    expect(((await answered.json()) as WorkItem)).toMatchObject({ state: 'decided', answer: 'a' });

    const { runId, events } = await pulse();
    // The ledger step carried the decided item to the model; the fixture keyed on it.
    const ledger = toolResults(events, 'work.list')[0]!.payload['output'] as { items: { state: string }[] };
    expect(ledger.items.some((i) => i.state === 'decided')).toBe(true);
    // Let go: the answer came back at once, with the child's id and nothing else.
    const delegated = toolResults(events, 'agent.delegate')[0]!;
    expect(delegated.payload['ok'], JSON.stringify(delegated.payload)).toBe(true);
    const child = delegated.payload['output'] as { runId: string; detached: boolean };
    expect(child.detached).toBe(true);
    expect(events.some((e) => e.type === 'run-started' && e.payload['childRunId'] === child.runId && e.payload['detached'] === true)).toBe(true);
    // The ledger moved: a staffed item for the weaver, and the question closed — named by its key, not an id.
    expect(toolResults(events, 'work.update')[0]!.payload['ok']).toBe(true);
    const items = await open();
    expect(items.find((i) => i.key === 'staff:next-piece')).toMatchObject({ state: 'staffed', assignee: 'weaver', kind: 'task' });
    expect(items.find((i) => i.id === decisionId), 'the decision is no longer open').toBeUndefined();
    const closed = (await (await api('GET', `/work?state=all`)).json()) as WorkListResponse;
    expect(closed.items.find((i) => i.id === decisionId)).toMatchObject({ state: 'done', answer: 'a', note: 'Acted on: the weaver is on part two.' });
    // The note names the choice.
    const docs = ((await (await api('GET', '/projects/companion/documents')).json()) as { documents: { path: string; id: string }[] }).documents;
    const note = docs.find((d) => d.path === `pulse/${runId}.md`)!;
    const content = (await (await api('GET', `/documents/${note.id}`)).json()) as { content: string };
    expect(content.content).toContain('you chose the arcology, part two');
    // The child is the weaver's, under the pulse run, inside the carve it was given, and it finishes on its own.
    const weaver = await settled(child.runId);
    expect(weaver.state, JSON.stringify(weaver.error)).toBe('completed');
    expect(weaver.budgets).toMatchObject({ maxModelCalls: 4, maxCostUsd: 0.1 });
    const row = rt.runtime.db.prepare('SELECT agent_id, parent_run_id, depth FROM runs WHERE id = ?').get(child.runId) as { agent_id: string; parent_run_id: string; depth: number };
    expect(row).toEqual({ agent_id: 'weaver', parent_run_id: runId, depth: 1 });
    // And the companion's card counts it: a dime the weaver spends beneath the pulse is the companion's dime too.
    // (The mock's own charge is nothing on this model; the row is planted, as SEC-46 plants it.)
    rt.runtime.db.prepare(`INSERT INTO model_calls (id, run_id, step_id, model_id, adapter, prompt_version, agent_version, usage_json, cost_usd, latency_ms, finish_reason, ts)
      VALUES ('m-dod24', ?, 'main', 'anthropic/claude-sonnet-5', 'anthropic', 'p', 'a', '{}', 0.10, 1, 'stop', ?)`).run(child.runId, new Date().toISOString());
    const agents = ((await (await api('GET', '/agents')).json()) as AgentListResponse).agents;
    const spend = agents.find((a) => a.id === 'companion')!.spend!;
    expect(spend.todayUsd).toBeCloseTo(rt.runtime.engine.spentTodayUsd('companion'), 8);
    expect(spend.todayUsd).toBeGreaterThanOrEqual(0.10);
    expect(spend.thisMonthUsd).toBeGreaterThanOrEqual(0.10);
    expect(agents.find((a) => a.id === 'weaver')!.spend!.todayUsd).toBeGreaterThanOrEqual(0.10);
    expect(agents.find((a) => a.id === 'echo')!.spend!.todayUsd, 'nobody else pays for it').toBe(0);
  }, 120_000);
});
