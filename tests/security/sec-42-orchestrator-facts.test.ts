// SEC-42: the orchestrator sees facts, not content.
//
// `runs.facts` and `agents.read` are what the companion decides from (D-73). If either carried a task, an
// output, a document or a tool's arguments, then every orchestrator session would be reading content it did
// not write — a web page's words laundered through a run's output — and the taint governor would have a hole
// where its eyes are. So: a phrase planted in each of those four places appears nowhere in either tool's
// result, the tools' `maxPermissions` admit no path, host or credential, `agents.read` returns no grant, and a
// run that called only these two tools ends untainted, which is the property the whole design rests on.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startRuntime, tempWorkspace, type Started } from '../helpers/workspace.js';
import type { EventRecord } from '../../src/shared/events.js';

const PLANTED = { task: 'PLANTED-TASK-v4t', output: 'PLANTED-OUTPUT-z9p', document: 'PLANTED-DOC-xq7', argument: 'PLANTED-ARG-m3k' };

let ws: string;
let rt: Started;
let weaverRun: string;

function fixtures(dir: string, entries: { name: string; match: Record<string, unknown>; respond: Record<string, unknown> }[]): void {
  for (const f of entries) fs.writeFileSync(path.join(dir, 'fixtures', `${f.name}.json`), JSON.stringify({ match: f.match, respond: f.respond }));
}

beforeAll(async () => {
  ws = tempWorkspace('sec42');
  const file = path.join(ws, 'config', 'workbench.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  config['grants'] = {
    weaver: { tools: { 'artifact.write': 'allow', 'memory.remember': 'allow' }, fs: { read: ['projects/'], write: ['projects/'] } },
    companion: { tools: { 'runs.facts': 'allow', 'agents.read': 'allow' } },
  };
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  fixtures(ws, [
    // The Weaver: files a document, remembers a line, answers — each carrying a planted phrase.
    { name: 'a0-weaver-done', match: { systemIncludes: 'The Weaver', afterTool: 'memory.remember' }, respond: { text: `Done. ${PLANTED.output}` } },
    { name: 'a1-weaver-remember', match: { systemIncludes: 'The Weaver', afterTool: 'artifact.write' },
      respond: { text: 'Noting.', toolCalls: [{ name: 'memory.remember', input: { content: PLANTED.argument, scope: 'agent' } }] } },
    { name: 'a2-weaver-write', match: { systemIncludes: 'The Weaver' },
      respond: { text: 'Filing.', toolCalls: [{ name: 'artifact.write', input: { path: 'notes/planted.md', content: PLANTED.document } }] } },
    // The Companion: reads the facts, then one agent, then speaks.
    { name: 'b0-companion-done', match: { systemIncludes: 'Companion', afterTool: 'agents.read' }, respond: { text: 'Looked at the fleet.' } },
    { name: 'b1-companion-agent', match: { systemIncludes: 'Companion', afterTool: 'runs.facts' },
      respond: { text: 'And the weaver.', toolCalls: [{ name: 'agents.read', input: { agent: 'weaver' } }] } },
    { name: 'b2-companion-facts', match: { systemIncludes: 'Companion' },
      respond: { text: 'Looking.', toolCalls: [{ name: 'runs.facts', input: {} }] } },
  ]);
  rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true });

  const { runId, done } = rt.runtime.engine.startAgentRun({ agentId: 'weaver', inputs: { input: `Write the ${PLANTED.task} note.` }, project: 'anthology' });
  await done;
  weaverRun = runId;
  expect(rt.runtime.engine.getRun(runId)?.state).toBe('completed');
}, 60_000);
afterAll(async () => { await rt.stop(); });

const headers = (): Record<string, string> => ({ Authorization: `Bearer ${rt.token}`, 'Content-Type': 'application/json' });
const api = (method: string, p: string, body?: unknown): Promise<Response> =>
  fetch(`${rt.baseUrl}/api/v1${p}`, { method, headers: headers(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
async function trace(runId: string): Promise<EventRecord[]> {
  return (await (await api('GET', `/runs/${runId}/trace.jsonl`)).text()).trim().split('\n').map((l) => JSON.parse(l) as EventRecord);
}

describe('SEC-42 the two read tools admit nothing and reach nothing', () => {
  it('their maxPermissions name no path, no host and no credential, and they leave the machine for nothing', () => {
    for (const id of ['runs.facts', 'agents.read']) {
      const tool = rt.runtime.engine.tools.catalog().find((t) => t.id === id);
      expect(tool, id).toBeDefined();
      expect(tool!.tier).toBe('read');
      expect(tool!.maxPermissions.fs).toEqual({ read: [], write: [] });
      expect(tool!.maxPermissions.net.allow).toEqual([]);
      expect(tool!.credentials ?? []).toEqual([]);
      expect(tool!.usesNetwork ?? false).toBe(false);
    }
  });
});

describe('SEC-42 a phrase planted in content is nowhere in the facts', () => {
  it('the run that carried it is described — by id, state, tools, document path — and quoted nowhere', async () => {
    // The four places content lives: the task, the output, a document, a tool's arguments. All four were planted.
    const run = rt.runtime.engine.getRun(weaverRun)!;
    expect(JSON.stringify(run.inputs)).toContain(PLANTED.task);
    expect(String(run.outputs?.['output'])).toContain(PLANTED.output);

    const facts = rt.runtime.engine.runFacts();
    const text = JSON.stringify(facts);
    for (const [where, phrase] of Object.entries(PLANTED)) expect(text, `the ${where} leaked`).not.toContain(phrase);

    const mine = facts.runs.find((r) => r.id === weaverRun);
    expect(mine, 'the run is there').toBeDefined();
    expect(mine!.state).toBe('completed');
    expect(mine!.agentId).toBe('weaver');
    expect(mine!.project).toBe('anthology');
    expect(mine!.tools.map((t) => `${t.tool}×${t.calls}`)).toEqual(['artifact.write×1', 'memory.remember×1']);
    // The note it filed by hand and the draft its output became: paths, never a line of either.
    expect(mine!.documents).toEqual(['anthology/notes/planted.md', `anthology/drafts/${weaverRun}.md`]);
    expect(mine!.taint.external, 'it read nothing from outside the workspace').toBe(false);
    expect(mine!.summary.length).toBeGreaterThanOrEqual(2);
    // It is unrated, and the facts say so by id; the owner's rating, once given, is the fact that changes.
    expect(facts.candidates.map((c) => c.id)).toContain(`unrated:${weaverRun}`);
  });

  it('the owner\'s rating and note are facts; a rating removes the run from the unrated list', async () => {
    const rated = await api('POST', '/ratings', { runId: weaverRun, stepId: 'main', value: 4, note: 'Good bones, weak ending.' });
    expect(rated.status, await rated.clone().text()).toBe(201);
    const facts = rt.runtime.engine.runFacts();
    const mine = facts.runs.find((r) => r.id === weaverRun)!;
    expect(mine.ratings).toEqual([expect.objectContaining({ stepId: 'main', value: 4, note: 'Good bones, weak ending.' })]);
    expect(facts.candidates.map((c) => c.id)).not.toContain(`unrated:${weaverRun}`);
  });
});

describe('SEC-42 a session that only read facts ends untainted', () => {
  it('the companion calls the two tools, sees no planted phrase, sees no grant, and its run is clean', async () => {
    const { runId, done } = rt.runtime.engine.startAgentRun({ agentId: 'companion', inputs: { input: 'Look at the last runs and say what you think.' } });
    await done;
    expect(rt.runtime.engine.getRun(runId)?.state).toBe('completed');

    const events = await trace(runId);
    const completed = events.filter((e) => e.type === 'tool-completed');
    expect(completed.map((e) => e.payload['tool'])).toEqual(['runs.facts', 'agents.read']);
    for (const e of completed) {
      expect(e.payload['ok'], String(e.payload['tool'])).toBe(true);
      const out = JSON.stringify(e.payload['output']);
      for (const [where, phrase] of Object.entries(PLANTED)) expect(out, `${String(e.payload['tool'])} leaked the ${where}`).not.toContain(phrase);
    }
    const facts = completed[0]!.payload['output'] as { candidates: { id: string }[]; runs: { id: string }[] };
    expect(facts.runs.some((r) => r.id === weaverRun), 'the weaver\'s run was in the brief').toBe(true);
    const agent = completed[1]!.payload['output'] as Record<string, unknown>;
    expect(agent['id']).toBe('weaver');
    expect(agent['sections']).toEqual(expect.any(Array));
    expect(agent, 'no grant, no permissions block').not.toHaveProperty('permissions');
    expect(agent).not.toHaveProperty('granted');
    expect(JSON.stringify(agent)).not.toContain('"allow"');

    // The property everything rests on: facts do not taint. What this session writes next would apply.
    const row = rt.runtime.db.prepare('SELECT private_tainted, external_tainted FROM runs WHERE id = ?').get(runId) as { private_tainted: number; external_tainted: number };
    expect(row).toEqual({ private_tainted: 0, external_tainted: 0 });
  }, 60_000);
});
