// RUN-14 Definition of done (spec/runs/RUN-14.md). Items 4 and 5 are also SEC-37 in tests/security; item 6 is
// @run-14 in tests/e2e/review.spec.ts. The auditor is the mock provider here, scripted to raise a named
// candidate: what the tests prove is the plumbing — the evidence is the runtime's, the apply is a human's
// matrix write, a dismissal holds until the numbers move — not the model's judgement.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ApprovalItem, GrantCell, PermissionFinding, RunDetail, ScheduleSummary, ToolsResponse } from '../../src/shared/api/index.js';
import type { EventRecord } from '../../src/shared/events.js';
import { startRuntime, tempWorkspace, waitFor, type Started } from '../helpers/workspace.js';
import { briefOf } from '../../src/runtime/permissions/review.js';

let ws: string;
let rt: Started;
const DAY = 86_400_000;

function fixture(dir: string, name: string, body: unknown): void {
  fs.writeFileSync(path.join(dir, 'fixtures', name), JSON.stringify(body, null, 2));
}

beforeAll(async () => {
  ws = tempWorkspace('dod14');
  // The auditor, scripted: it raises the candidate named in the facts it was shown, and nothing when none is.
  fixture(ws, 'aaa-audit-fatigue.json', { match: { systemIncludes: 'The Auditor', lastUserIncludes: 'fatigue:weaver:artifact.write' }, respond: { json: { findings: [{ candidate: 'fatigue:weaver:artifact.write', note: 'You approve this every time.' }], summary: 'One fatigue.' } } });
  fixture(ws, 'aaa-audit-unused.json', { match: { systemIncludes: 'The Auditor', lastUserIncludes: 'unused:researcher:http.fetch' }, respond: { json: { findings: [{ candidate: 'unused:researcher:http.fetch', note: 'Never once.' }], summary: 'One unused grant.' } } });
  fixture(ws, 'aab-audit-none.json', { match: { systemIncludes: 'The Auditor' }, respond: { json: { findings: [], summary: 'Nothing to say.' } } });
  // The Weaver, asking to write a note: the approval the fatigue finding counts.
  fixture(ws, 'aaa-weaver-write.json', { match: { systemIncludes: 'The Weaver', callIndex: 1 }, respond: { text: 'Saving a note.', toolCalls: [{ name: 'artifact.write', input: { path: 'notes/margin.md', content: 'A note.' } }] } });
  rt = await startRuntime(ws, { providerOverride: 'mock' });
});
afterAll(async () => { await rt.stop(); });

const headers = (): Record<string, string> => ({ Authorization: `Bearer ${rt.token}`, 'Content-Type': 'application/json' });
const api = (method: string, p: string, body?: unknown): Promise<Response> =>
  fetch(`${rt.baseUrl}/api/v1${p}`, { method, headers: headers(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const detail = async (runId: string): Promise<RunDetail> => (await (await api('GET', `/runs/${runId}`)).json()) as RunDetail;
const findings = async (state = 'open'): Promise<PermissionFinding[]> => ((await (await api('GET', `/permissions/findings?state=${state}`)).json()) as { findings: PermissionFinding[] }).findings;
const cell = async (agentId: string, toolId: string): Promise<GrantCell> => {
  const tools = (await (await api('GET', '/tools')).json()) as ToolsResponse;
  return tools.matrix.find((c) => c.agentId === agentId && c.toolId === toolId)!;
};

async function review(inputs: Record<string, unknown> = {}): Promise<{ runId: string; outputs: Record<string, unknown> }> {
  const res = await api('POST', '/runs', { kind: 'workflow', id: 'permissions-review', inputs, provider: 'mock' });
  expect(res.status, await res.clone().text()).toBe(202);
  const { runId } = (await res.json()) as { runId: string };
  await waitFor(async () => ['completed', 'failed'].includes((await detail(runId)).state), 60_000);
  const run = await detail(runId);
  expect(run.state, JSON.stringify(run)).toBe('completed');
  return { runId, outputs: (run.outputs ?? {}) as Record<string, unknown> };
}

/** One Weaver run that asks to write, approved by the person. */
async function approvedWrite(): Promise<void> {
  const res = await api('POST', '/runs', { kind: 'agent', id: 'weaver', inputs: { input: 'Write a note in the margin.' }, project: 'anthology', provider: 'mock' });
  expect(res.status).toBe(202);
  const { runId } = (await res.json()) as { runId: string };
  let card: ApprovalItem | undefined;
  await waitFor(async () => {
    const pending = ((await (await api('GET', '/approvals')).json()) as { approvals: ApprovalItem[] }).approvals;
    card = pending.find((a) => a.runId === runId);
    return card !== undefined;
  }, 30_000);
  const decided = await api('POST', `/approvals/${card!.batchId}`, { decision: 'allow' });
  expect([200, 202], await decided.clone().text()).toContain(decided.status);
  await waitFor(async () => (await detail(runId)).state === 'completed', 30_000);
}

describe('the shipped workflow', () => {
  it('seeds its schedule paused: nothing nags on day one', async () => {
    const schedules = ((await (await api('GET', '/schedules')).json()) as { schedules: ScheduleSummary[] }).schedules;
    const mine = schedules.find((s) => s.workflowId === 'permissions-review');
    expect(mine?.enabled).toBe(false);
    expect(mine?.seededFromFile).toBe(true);
  });

  it('shows the auditor a brief that fits under the tool-result cut, candidates first (D-47)', () => {
    const brief = briefOf(rt.runtime.permissionFacts());
    const text = JSON.stringify(brief);
    expect(text.length).toBeLessThan(8000);
    expect(Object.keys(brief)[2]).toBe('candidates');
  });
});

describe('DoD 1: a granted-but-never-used tool produces exactly that finding', () => {
  it('names the grant, the age and the zero', async () => {
    // The Researcher was granted http.fetch forty days ago, by a person, and never called it.
    const at = new Date(Date.now() - 40 * DAY).toISOString();
    rt.runtime.db.prepare("INSERT INTO grant_log (id, agent_id, tool, field, before_json, after_json, source, at) VALUES ('seed-1', 'researcher', 'http.fetch', 'tools', 'null', '\"allow\"', 'human', ?)").run(at);

    const facts = rt.runtime.permissionFacts();
    const grant = facts.grants.find((g) => g.agentId === 'researcher' && g.tool === 'http.fetch');
    expect(grant).toMatchObject({ sinceSource: 'log', ageDays: 40, uses: 0 });
    expect(facts.candidates.map((c) => c.id)).toContain('unused:researcher:http.fetch');

    const { outputs } = await review();
    expect(outputs['raised']).toBe(1);
    const open = await findings();
    expect(open).toHaveLength(1);
    const f = open[0]!;
    expect(f.kind).toBe('unused');
    expect(f.headline).toBe('researcher holds http.fetch and has never used it.');
    expect(f.evidence[0]).toMatch(/^Granted 40 days ago, on \d{4}-\d{2}-\d{2}\.$/);
    expect(f.evidence[1]).toBe('Exercised 0 times in that time.');
    expect(f.note).toBe('Never once.');
    expect(f.proposal).toMatchObject({ agentId: 'researcher', tool: 'http.fetch', set: 'unset', label: 'Take back http.fetch from researcher' });
  }, 90_000);
});

describe('DoD 2: applying a finding flips the matrix, and the next review no longer raises it', () => {
  it('the cell reads unset, the file agrees, the log has the row, and the re-run raises nothing', async () => {
    const [f] = await findings();
    expect((await cell('researcher', 'http.fetch')).granted).toBe('allow');
    const applied = await api('POST', `/permissions/findings/${f!.id}`, { decision: 'apply' });
    expect(applied.status, await applied.clone().text()).toBe(200);
    expect(((await applied.json()) as PermissionFinding).state).toBe('applied');

    expect((await cell('researcher', 'http.fetch')).granted).toBe('unset');
    const config = JSON.parse(fs.readFileSync(path.join(ws, 'config', 'workbench.json'), 'utf8')) as { grants: Record<string, { tools: Record<string, string> }> };
    expect(config.grants['researcher']!.tools['http.fetch']).toBeUndefined();
    const log = rt.runtime.db.prepare("SELECT before_json, after_json, source FROM grant_log WHERE agent_id = 'researcher' AND tool = 'http.fetch' ORDER BY at DESC LIMIT 1").get() as { before_json: string; after_json: string; source: string };
    expect(log).toEqual({ before_json: '"allow"', after_json: 'null', source: 'human' });
    expect(await findings()).toHaveLength(0);

    const { outputs } = await review();
    expect(outputs['raised']).toBe(0);
    expect(await findings()).toHaveLength(0);
    // The grant is gone, so the candidate is gone: nothing for the auditor to point at.
    expect(rt.runtime.permissionFacts().candidates.map((c) => c.id)).not.toContain('unused:researcher:http.fetch');
  }, 90_000);
});

describe('DoD 3: dismissing a finding suppresses it until the underlying counts change', () => {
  it('approval fatigue: dismissed, quiet on the same streak, back after one more approval', async () => {
    rt.runtime.setGrant('weaver', { tools: { 'artifact.write': 'allow', 'artifact.read': 'allow' }, approvalRequired: ['artifact.write'], fs: { read: ['projects/'], write: ['projects/'] } });
    for (let i = 0; i < 3; i++) await approvedWrite();
    const facts = rt.runtime.permissionFacts({ fatigueStreak: 3 });
    expect(facts.approvals.find((a) => a.agentId === 'weaver' && a.tool === 'artifact.write')).toMatchObject({ asked: 3, allowed: 3, streak: 3 });

    const first = await review({ fatigueStreak: 3 });
    expect(first.outputs['raised']).toBe(1);
    const [f] = await findings();
    expect(f).toMatchObject({ kind: 'fatigue', headline: 'artifact.write for weaver has been approved 3 times in a row.' });
    expect(f!.proposal?.label).toBe('Stop asking before weaver uses artifact.write');

    const dismissed = await api('POST', `/permissions/findings/${f!.id}`, { decision: 'dismiss' });
    expect(dismissed.status).toBe(200);
    expect(await findings()).toHaveLength(0);

    const quiet = await review({ fatigueStreak: 3 });
    expect(quiet.outputs['raised']).toBe(0);
    expect(quiet.outputs['suppressed']).toBe(1);
    expect(await findings()).toHaveLength(0);

    await approvedWrite();
    const back = await review({ fatigueStreak: 3 });
    expect(back.outputs['raised']).toBe(1);
    const [again] = await findings();
    expect(again?.headline).toBe('artifact.write for weaver has been approved 4 times in a row.');
    expect(again?.id).not.toBe(f!.id);
  }, 180_000);
});

describe('DoD 4: the auditor reads no content', () => {
  it('its row grants nothing that reads, and its run calls only its two tools', async () => {
    const tools = (await (await api('GET', '/tools')).json()) as ToolsResponse;
    const granted = tools.matrix.filter((c) => c.agentId === 'auditor' && c.granted === 'allow').map((c) => c.toolId).sort();
    expect(granted).toEqual(['permissions.facts', 'permissions.propose']);
    const { runId } = await review();
    const trace = (await (await api('GET', `/runs/${runId}/trace.jsonl`)).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l) as EventRecord);
    const called = trace.filter((e) => e.type === 'tool-requested').map((e) => String(e.payload['tool']));
    expect(new Set(called)).toEqual(new Set(['permissions.facts', 'permissions.propose']));
    for (const forbidden of ['artifact.read', 'memory.search', 'knowledge.search', 'fs.read']) expect(called).not.toContain(forbidden);
  }, 90_000);
});

describe('DoD 5: no code path lets a run write permissions', () => {
  it('the auditor cannot propose a grant into existence, and only the human routes moved the matrix', async () => {
    const before = fs.readFileSync(path.join(ws, 'config', 'workbench.json'), 'utf8');
    await review();
    expect(fs.readFileSync(path.join(ws, 'config', 'workbench.json'), 'utf8')).toBe(before);
    // Every grant_log row so far came from a human's request: the seed, the apply, the setGrant above.
    const sources = (rt.runtime.db.prepare('SELECT DISTINCT source FROM grant_log').all() as { source: string }[]).map((r) => r.source);
    expect(sources).toEqual(['human']);
    expect(rt.runtime.engine.tools.catalog().map((t) => t.id).filter((id) => /grant/.test(id))).toEqual([]);
  }, 90_000);
});
