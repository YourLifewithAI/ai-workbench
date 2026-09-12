// RUN-23 Definition of done (spec/runs/RUN-23.md). Items 1, 2, 6, 7 and 8 are the security suite's — SEC-43,
// SEC-16 (RUN-23), SEC-38b, SEC-41 and SEC-43 (RUN-23) — and are not repeated here; this suite proves the
// orchestrator as shipped: the promoted companion on the mock, directing, seeing, rating, and the board. Item 10
// is `@run-23` in tests/e2e.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { GrantCell, RunDetail, ScheduleSummary, ToolsResponse } from '../../src/shared/api/index.js';
import type { EventRecord } from '../../src/shared/events.js';
import { startRuntime, tempWorkspace, waitFor, type Started } from '../helpers/workspace.js';

let ws: string;
let rt: Started;
let weaverRun: string;
let failedRun: string;
const PLANTED = { task: 'PLANTED-TASK-8r2', output: 'PLANTED-OUTPUT-k5m', document: 'PLANTED-DOC-w9c' };
// RUN-24 added the ledger's four: work.file, work.list, work.update, owner.ask.
const ORCHESTRATOR_TOOLS = ['agent.delegate', 'workflow.run', 'runs.facts', 'agents.read', 'runs.rate', 'artifact.read', 'artifact.write', 'memory.remember', 'memory.search', 'datetime', 'work.file', 'work.list', 'work.update', 'owner.ask'];

function fixture(dir: string, name: string, body: unknown): void {
  fs.writeFileSync(path.join(dir, 'fixtures', `${name}.json`), JSON.stringify(body, null, 2));
}

beforeAll(async () => {
  ws = tempWorkspace('dod23');
  // The shipped grants stay as shipped — the companion's are the point — and two more agents get what the
  // scripts below need: the Weaver files a note, the Researcher searches.
  const file = path.join(ws, 'config', 'workbench.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8')) as { grants: Record<string, unknown>; search?: unknown };
  config.grants['weaver'] = { tools: { 'artifact.write': 'allow' }, fs: { read: ['projects/'], write: ['projects/'] } };
  config.grants['researcher'] = { tools: { 'web.search': 'allow' } };
  config.search = { provider: 'mock' };
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  // A one-step workflow the companion can start: the researcher answers a question, searching first.
  fs.writeFileSync(path.join(ws, 'workflows', 'ask.workflow.json'), JSON.stringify({
    schemaVersion: 1, id: 'ask', name: 'Ask', description: 'One question to the researcher.',
    inputs: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
    steps: [{ id: 'answer', kind: 'agent', agent: 'researcher', input: '{{inputs.question}}' }],
    outputs: { answer: '{{steps.answer.output}}' },
  }, null, 2));

  // The Weaver: files a note carrying a planted phrase, then answers with another.
  fixture(ws, 'a0-weaver-done', { match: { systemIncludes: 'The Weaver', afterTool: 'artifact.write' }, respond: { text: `Filed. ${PLANTED.output}` } });
  fixture(ws, 'a1-weaver-write', { match: { systemIncludes: 'The Weaver' }, respond: { text: 'Filing.', toolCalls: [{ name: 'artifact.write', input: { path: 'notes/planted.md', content: PLANTED.document } }] } });
  // The Researcher: searches, then answers — two model calls, which is what makes a one-call budget fail it.
  fixture(ws, 'a2-researcher-answer', { match: { systemIncludes: 'The Researcher', afterTool: 'web.search' }, respond: { text: 'A city in one building.' } });
  fixture(ws, 'a3-researcher-search', { match: { systemIncludes: 'The Researcher' }, respond: { text: 'Searching.', toolCalls: [{ name: 'web.search', input: { query: 'arcology' } }] } });
  // The Companion, after each tool, reports; what it does first depends on what it was asked.
  fixture(ws, 'b0-companion-after-facts', { match: { systemIncludes: 'Companion', afterTool: 'runs.facts' }, respond: { text: 'Looked at the fleet.' } });
  fixture(ws, 'b1-companion-after-workflow', { match: { systemIncludes: 'Companion', afterTool: 'workflow.run' }, respond: { text: 'The workflow came back.' } });
  fixture(ws, 'b2-companion-after-rate', { match: { systemIncludes: 'Companion', afterTool: 'runs.rate' }, respond: { text: 'Rated.' } });
  fixture(ws, 'b3-companion-look', { match: { systemIncludes: 'Companion', lastUserIncludes: 'Look at the last runs' }, respond: { text: 'Looking.', toolCalls: [{ name: 'runs.facts', input: {} }] } });
  fixture(ws, 'b4-companion-workflow-one-call', { match: { systemIncludes: 'Companion', lastUserIncludes: 'Run the ask workflow with one call' },
    respond: { text: 'Running it, tightly.', toolCalls: [{ name: 'workflow.run', input: { workflow: 'ask', inputs: { question: 'What is the arcology?' }, maxModelCalls: 1 } }] } });
  fixture(ws, 'b5-companion-workflow', { match: { systemIncludes: 'Companion', lastUserIncludes: 'Run the ask workflow' },
    respond: { text: 'Running it.', toolCalls: [{ name: 'workflow.run', input: { workflow: 'ask', inputs: { question: 'What is the arcology?' } } }] } });
  rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true });

  const wove = rt.runtime.engine.startAgentRun({ agentId: 'weaver', inputs: { input: `Write the ${PLANTED.task} note.` }, project: 'anthology' });
  await wove.done;
  weaverRun = wove.runId;
  expect(rt.runtime.engine.getRun(weaverRun)?.state).toBe('completed');
  // A run that fails: no time at all, so it stops before its first model call and is filed as failed.
  const failing = rt.runtime.engine.startAgentRun({ agentId: 'echo', inputs: { input: 'never sent' }, budget: { maxWallClockMs: 1 } });
  await failing.done;
  failedRun = failing.runId;
  expect(rt.runtime.engine.getRun(failedRun)?.state).toBe('failed');
}, 90_000);
afterAll(async () => { await rt.stop(); });

const headers = (): Record<string, string> => ({ Authorization: `Bearer ${rt.token}`, 'Content-Type': 'application/json' });
const api = (method: string, p: string, body?: unknown): Promise<Response> =>
  fetch(`${rt.baseUrl}/api/v1${p}`, { method, headers: headers(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const detail = async (runId: string): Promise<RunDetail> => (await (await api('GET', `/runs/${runId}`)).json()) as RunDetail;
const trace = async (runId: string): Promise<EventRecord[]> => (await (await api('GET', `/runs/${runId}/trace.jsonl`)).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l) as EventRecord);
async function companion(input: string): Promise<{ runId: string; events: EventRecord[]; run: RunDetail }> {
  const { runId, done } = rt.runtime.engine.startAgentRun({ agentId: 'companion', inputs: { input }, project: 'companion' });
  await done;
  const run = await detail(runId);
  expect(run.state, JSON.stringify(run.error)).toBe('completed');
  return { runId, events: await trace(runId), run };
}
const toolResult = (events: EventRecord[], tool: string): EventRecord => events.find((e) => e.type === 'tool-completed' && e.payload['tool'] === tool)!;

describe('the companion as shipped', () => {
  it('holds exactly the fourteen tools, none of which reads outside the workspace, and its caps are the constraint', async () => {
    const tools = (await (await api('GET', '/tools')).json()) as ToolsResponse;
    const held = tools.matrix.filter((c: GrantCell) => c.agentId === 'companion' && c.granted === 'allow').map((c) => c.toolId).sort();
    expect(held).toEqual([...ORCHESTRATOR_TOOLS].sort());
    for (const never of ['http.fetch', 'web.search', 'http.request', 'fs.read', 'fs.write', 'fs.list', 'shell', 'code.execute', 'permissions.propose']) expect(held).not.toContain(never);
    const agent = rt.runtime.workspace.agents.get('companion')!;
    expect(agent.definition.budgets).toMatchObject({ maxCostUsd: 0.5, dailySpendCapUsd: 5, monthlySpendCapUsd: 40 });
    expect(agent.sections.map((s) => s.name)).toEqual(expect.arrayContaining(['the-village', 'directing-work', 'rating', 'learning', 'the-board']));
    // Its project has no ceiling any more: a delegated researcher's search would otherwise be refused there.
    expect(rt.runtime.workspace.spaces.get('companion')?.definition.tools).toBeUndefined();
  });
});

describe('DoD 3: runs.facts describes runs without quoting them, and names the candidates', () => {
  it('a phrase planted in the task, the output and a document appears nowhere; failing: and unrated: name the right runs', async () => {
    const { events, runId } = await companion('Look at the last runs and say what you think.');
    const result = toolResult(events, 'runs.facts');
    expect(result.payload['ok'], JSON.stringify(result.payload)).toBe(true);
    const text = JSON.stringify(result.payload['output']);
    for (const [where, phrase] of Object.entries(PLANTED)) expect(text, `the ${where} leaked into the facts`).not.toContain(phrase);
    const brief = result.payload['output'] as { candidates: { id: string; headline: string }[]; runs: { id: string; who: string; state: string; documents: string[] }[] };
    expect(brief.candidates.map((c) => c.id)).toEqual(expect.arrayContaining([`unrated:${weaverRun}`, `failing:${failedRun}`]));
    expect(brief.candidates.find((c) => c.id === `failing:${failedRun}`)!.headline).toMatch(/^echo failed/);
    const mine = brief.runs.find((r) => r.id === weaverRun)!;
    expect(mine).toMatchObject({ who: 'weaver', state: 'completed' });
    expect(mine.documents).toContain('anthology/notes/planted.md');
    // The companion's own run is a fact but never a candidate: it does not rate itself.
    expect(brief.candidates.some((c) => c.id.endsWith(`:${runId}`))).toBe(false);
    // And a session that decided from facts is untainted: what it writes next would apply.
    const row = rt.runtime.db.prepare('SELECT external_tainted FROM runs WHERE id = ?').get(runId) as { external_tainted: number };
    expect(row.external_tainted).toBe(0);
  }, 60_000);
});

describe('DoD 4: runs.rate is an estimate beside the owner\'s rating', () => {
  it('adds one scores row, leaves ratings alone, and shows on the run\'s page and the Review card', async () => {
    fixture(ws, 'b6-companion-rate', { match: { systemIncludes: 'Companion', lastUserIncludes: 'Rate the weaver run' },
      respond: { text: 'Rating.', toolCalls: [{ name: 'runs.rate', input: { run: weaverRun, value: 3, why: 'Filed the note; the ending trails off.' } }] } });
    rt.runtime.reloadAgents();
    expect((await api('POST', '/ratings', { runId: weaverRun, stepId: 'main', value: 4, note: 'Fine.' })).status).toBe(201);
    const ratingsBefore = (rt.runtime.db.prepare('SELECT COUNT(*) AS n FROM ratings').get() as { n: number }).n;

    const { events } = await companion('Rate the weaver run.');
    expect(toolResult(events, 'runs.rate').payload['ok']).toBe(true);
    const scores = rt.runtime.db.prepare('SELECT evaluator_id, metric, value, estimate FROM scores WHERE run_id = ?').all(weaverRun);
    expect(scores).toEqual([{ evaluator_id: 'orchestrator', metric: 'rating', value: 3, estimate: 1 }]);
    expect((rt.runtime.db.prepare('SELECT COUNT(*) AS n FROM ratings').get() as { n: number }).n).toBe(ratingsBefore);

    const page = (await (await api('GET', `/runs/${weaverRun}/ratings`)).json()) as { ratings: { value: number }[]; estimates: { by: string; value: number; why: string | null }[] };
    expect(page.ratings.map((r) => r.value)).toEqual([4]);
    expect(page.estimates).toEqual([expect.objectContaining({ by: 'orchestrator', value: 3, why: 'Filed the note; the ending trails off.' })]);
    const reviews = ((await (await api('GET', '/reviews?state=unreviewed')).json()) as { reviews: { runId: string; estimates: { value: number }[] }[] }).reviews;
    expect(reviews.find((r) => r.runId === weaverRun)?.estimates.map((e) => e.value)).toEqual([3]);
  }, 60_000);
});

describe('DoD 5: workflow.run from the companion starts a child bounded by the companion\'s budget', () => {
  it('the child\'s budget is carved from the parent\'s and its depth counts', async () => {
    const { events, runId } = await companion('Run the ask workflow.');
    const result = toolResult(events, 'workflow.run');
    expect(result.payload['ok'], JSON.stringify(result.payload)).toBe(true);
    const out = result.payload['output'] as { runId: string; outputs: Record<string, unknown> };
    expect(String(out.outputs['answer'])).toContain('one building');
    const child = rt.runtime.db.prepare('SELECT kind, parent_run_id, depth, budgets_json FROM runs WHERE id = ?').get(out.runId) as { kind: string; parent_run_id: string; depth: number; budgets_json: string };
    expect(child).toMatchObject({ kind: 'workflow', parent_run_id: runId, depth: 1 });
    const parent = rt.runtime.db.prepare('SELECT budgets_json FROM runs WHERE id = ?').get(runId) as { budgets_json: string };
    const childBudget = JSON.parse(child.budgets_json) as { maxModelCalls: number; maxCostUsd: number };
    const parentBudget = JSON.parse(parent.budgets_json) as { maxModelCalls: number; maxCostUsd: number };
    expect(childBudget.maxModelCalls).toBeLessThanOrEqual(parentBudget.maxModelCalls);
    expect(childBudget.maxCostUsd).toBeLessThanOrEqual(parentBudget.maxCostUsd);
    // The researcher searched inside the child, so the companion's session is now external-tainted (SEC-43).
    expect((rt.runtime.db.prepare('SELECT external_tainted FROM runs WHERE id = ?').get(runId) as { external_tainted: number }).external_tainted).toBe(1);
  }, 90_000);

  it('a child that fails leaves the parent completed, with the failure as a fact in its result', async () => {
    const { events, run } = await companion('Run the ask workflow with one call.');
    const result = toolResult(events, 'workflow.run');
    expect(result.payload['ok']).toBe(false);
    const error = result.payload['error'] as { code: string; message: string };
    expect(error.code).toBe('ToolError');
    expect(error.message).toMatch(/workflow run \S+ failed/);
    expect(run.state).toBe('completed');
    expect(String(run.outputs?.['output'])).toContain('The workflow came back.');
    const children = rt.runtime.db.prepare('SELECT state FROM runs WHERE parent_run_id = ?').all(run.id) as { state: string }[];
    expect(children.map((c) => c.state)).toContain('failed');
  }, 90_000);
});

describe('DoD 9: the board', () => {
  it('ships seeded paused, runs on the mock, and files one block per agent under the companion project', async () => {
    const schedules = ((await (await api('GET', '/schedules')).json()) as { schedules: ScheduleSummary[] }).schedules;
    const board = schedules.find((s) => s.workflowId === 'companion-board');
    expect(board?.enabled, 'off until the owner turns it on').toBe(false);
    expect(board?.seededFromFile).toBe(true);

    const res = await api('POST', '/runs', { kind: 'workflow', id: 'companion-board', inputs: {}, provider: 'mock' });
    expect(res.status, await res.clone().text()).toBe(202);
    const { runId } = (await res.json()) as { runId: string };
    await waitFor(async () => ['completed', 'failed'].includes((await detail(runId)).state), 60_000);
    const run = await detail(runId);
    expect(run.state, JSON.stringify(run.error)).toBe('completed');
    expect(run.project).toBe('companion');
    const events = await trace(runId);
    expect(toolResult(events, 'runs.facts').payload['ok']).toBe(true);
    const docs = ((await (await api('GET', '/projects/companion/documents')).json()) as { documents: { path: string; id: string }[] }).documents;
    const filed = docs.find((d) => d.path === `board/${runId}.md`);
    expect(filed, 'the board is filed by run id').toBeDefined();
    const content = ((await (await api('GET', `/documents/${filed!.id}`)).json()) as { content: string; version: { createdBy: string } });
    expect(content.content).toContain('## The Weaver');
    expect(content.content).toContain('## The Researcher');
    expect(content.version.createdBy).toBe('run-step');
  }, 90_000);
});
