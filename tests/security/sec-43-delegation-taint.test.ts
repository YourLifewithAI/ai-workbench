// SEC-43: taint flows up at return.
//
// A child run has always inherited its parent's taint — what the parent had read, the child could quote. The
// reverse was missing until RUN-23: the child's answer lands in front of the parent, and if the child read the
// web, that answer is a web page's words one step removed. Before this test, a run that delegated to the
// researcher and then called `memory.remember` wrote the item as *trusted* — a hole in D-17 shaped exactly like
// an orchestrator, which is the agent whose whole job is to delegate and then decide.
//
// Three cases: the hole, closed; the control, where the child read nothing and the parent stays trusted; and
// a delegation that failed, which carries nothing because nothing arrived.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { startRuntime, tempWorkspace, type Started } from '../helpers/workspace.js';
import type { MemoryResponse } from '../../src/shared/api/index.js';
import type { EventRecord } from '../../src/shared/events.js';

const headers = (rt: Started): Record<string, string> => ({ Authorization: `Bearer ${rt.token}`, 'Content-Type': 'application/json' });

/** A workspace where the Editor may delegate, start a workflow and remember, and the Researcher may search — on the mock, offline. */
function prepare(name: string): string {
  const ws = tempWorkspace(name);
  const file = path.join(ws, 'config', 'workbench.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  config['grants'] = {
    delegator: { tools: { 'agent.delegate': 'allow', 'workflow.run': 'allow', 'memory.remember': 'allow' } },
    researcher: { tools: { 'web.search': 'allow' } },
  };
  (config['search'] as Record<string, unknown>) = { provider: 'mock' };
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  // A one-step workflow: the researcher answers a question. What `workflow.run` starts as a child.
  fs.writeFileSync(path.join(ws, 'workflows', 'ask.workflow.json'), JSON.stringify({
    schemaVersion: 1, id: 'ask', name: 'Ask', description: 'One question to the researcher.',
    inputs: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
    steps: [{ id: 'answer', kind: 'agent', agent: 'researcher', input: '{{inputs.question}}' }],
    outputs: { answer: '{{steps.answer.output}}' },
  }, null, 2));
  return ws;
}

/** Later turns first: the first fixture whose match holds wins. */
function fixtures(ws: string, entries: { name: string; match: Record<string, unknown>; respond: Record<string, unknown> }[]): void {
  for (const f of entries) fs.writeFileSync(path.join(ws, 'fixtures', `${f.name}.json`), JSON.stringify({ match: f.match, respond: f.respond }));
}

async function memoryItems(rt: Started): Promise<MemoryResponse['items']> {
  return ((await (await fetch(`${rt.baseUrl}/api/v1/memory`, { headers: headers(rt) })).json()) as MemoryResponse).items;
}

async function trace(rt: Started, runId: string): Promise<EventRecord[]> {
  return (await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}/trace.jsonl`, { headers: headers(rt) })).text())
    .trim().split('\n').map((l) => JSON.parse(l) as EventRecord);
}

describe('SEC-43 taint flows up at return', () => {
  it('the hole, closed: a parent that delegated to a child which read the web remembers as untrusted', async () => {
    const ws = prepare('sec43-up');
    fixtures(ws, [
      { name: 'ab0-editor-done', match: { systemIncludes: 'The Editor', afterTool: 'memory.remember' }, respond: { text: 'Filed.' } },
      { name: 'ab1-editor-remember', match: { systemIncludes: 'The Editor', afterTool: 'agent.delegate' },
        respond: { text: 'Noting that.', toolCalls: [{ name: 'memory.remember', input: { content: 'The client likes the researcher\'s framing.', scope: 'workspace' } }] } },
      { name: 'ab2-editor-delegate', match: { systemIncludes: 'The Editor' },
        respond: { text: 'Asking the researcher.', toolCalls: [{ name: 'agent.delegate', input: { agent: 'researcher', input: 'What is the arcology? One paragraph.' } }] } },
      { name: 'ab3-researcher-answer', match: { systemIncludes: 'The Researcher', afterTool: 'web.search' }, respond: { text: 'The arcology is a city in one building (https://example.com/arcology).' } },
      { name: 'ab4-researcher-search', match: { systemIncludes: 'The Researcher' },
        respond: { text: 'Searching.', toolCalls: [{ name: 'web.search', input: { query: 'arcology' } }] } },
    ]);

    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true });
    try {
      const { runId, done } = rt.runtime.engine.startAgentRun({ agentId: 'delegator', inputs: { input: 'Plan a piece about the arcology.' } });
      await done;
      expect(rt.runtime.engine.getRun(runId)?.state).toBe('completed');

      const items = await memoryItems(rt);
      expect(items).toHaveLength(1);
      expect(items[0]!.runId, 'the parent wrote it').toBe(runId);
      // This is the assertion that was false before RUN-23.
      expect(items[0]!.trust, 'the parent had read, through its child, content from outside the workspace').toBe('untrusted');

      const events = await trace(rt, runId);
      const delegated = events.find((e) => e.type === 'tool-completed' && e.payload['tool'] === 'agent.delegate')!;
      expect(delegated, 'the delegation happened and succeeded').toBeDefined();
      expect(delegated.payload['ok']).toBe(true);
      // The child's taint is a fact about the run, not a line the model reads: it is not in the tool output.
      expect(JSON.stringify(delegated.payload['output'])).not.toContain('taint');
      const written = events.find((e) => e.type === 'memory-written')!;
      expect(written.payload['trust']).toBe('untrusted');
    } finally {
      await rt.stop();
    }
  }, 60_000);

  it('the control: a child that read nothing leaves the parent trusted', async () => {
    const ws = prepare('sec43-clean');
    fixtures(ws, [
      { name: 'ac0-editor-done', match: { systemIncludes: 'The Editor', afterTool: 'memory.remember' }, respond: { text: 'Filed.' } },
      { name: 'ac1-editor-remember', match: { systemIncludes: 'The Editor', afterTool: 'agent.delegate' },
        respond: { text: 'Noting that.', toolCalls: [{ name: 'memory.remember', input: { content: 'The researcher answers from what it knows when asked to.', scope: 'workspace' } }] } },
      { name: 'ac2-editor-delegate', match: { systemIncludes: 'The Editor' },
        respond: { text: 'Asking the researcher.', toolCalls: [{ name: 'agent.delegate', input: { agent: 'researcher', input: 'Without searching: what is an arcology, in a sentence?' } }] } },
      // The researcher answers without a tool call — nothing external enters the chain.
      { name: 'ac3-researcher-answer', match: { systemIncludes: 'The Researcher' }, respond: { text: 'A city in one building.' } },
    ]);

    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true });
    try {
      const { runId, done } = rt.runtime.engine.startAgentRun({ agentId: 'delegator', inputs: { input: 'Plan a piece.' } });
      await done;
      expect(rt.runtime.engine.getRun(runId)?.state).toBe('completed');
      const items = await memoryItems(rt);
      expect(items).toHaveLength(1);
      expect(items[0]!.trust, 'nothing external entered the chain, so trust is unchanged').toBe('trusted');
    } finally {
      await rt.stop();
    }
  }, 60_000);

  it('a workflow started as a child is a child: what its steps read, the parent has read (workflow.run)', async () => {
    const ws = prepare('sec43-workflow');
    fixtures(ws, [
      { name: 'ae0-editor-done', match: { systemIncludes: 'The Editor', afterTool: 'memory.remember' }, respond: { text: 'Filed.' } },
      { name: 'ae1-editor-remember', match: { systemIncludes: 'The Editor', afterTool: 'workflow.run' },
        respond: { text: 'Noting that.', toolCalls: [{ name: 'memory.remember', input: { content: 'The arcology answer is filed.', scope: 'workspace' } }] } },
      { name: 'ae2-editor-run', match: { systemIncludes: 'The Editor' },
        respond: { text: 'Running the ask workflow.', toolCalls: [{ name: 'workflow.run', input: { workflow: 'ask', inputs: { question: 'What is the arcology?' } } }] } },
      { name: 'ae3-researcher-answer', match: { systemIncludes: 'The Researcher', afterTool: 'web.search' }, respond: { text: 'A city in one building (https://example.com/arcology).' } },
      { name: 'ae4-researcher-search', match: { systemIncludes: 'The Researcher' },
        respond: { text: 'Searching.', toolCalls: [{ name: 'web.search', input: { query: 'arcology' } }] } },
    ]);

    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true });
    try {
      const { runId, done } = rt.runtime.engine.startAgentRun({ agentId: 'delegator', inputs: { input: 'Find out about the arcology and note it.' } });
      await done;
      expect(rt.runtime.engine.getRun(runId)?.state).toBe('completed');

      const events = await trace(rt, runId);
      const ran = events.find((e) => e.type === 'tool-completed' && e.payload['tool'] === 'workflow.run')!;
      expect(ran.payload['ok'], JSON.stringify(ran.payload)).toBe(true);
      const out = ran.payload['output'] as { runId: string; outputs: Record<string, unknown> };
      expect(String(out.outputs['answer'])).toContain('one building');
      // The child is a workflow run, nested under the parent at depth one, bounded by the parent's budget.
      const child = rt.runtime.db.prepare('SELECT kind, parent_run_id, depth, external_tainted FROM runs WHERE id = ?').get(out.runId) as { kind: string; parent_run_id: string; depth: number; external_tainted: number };
      expect(child).toEqual({ kind: 'workflow', parent_run_id: runId, depth: 1, external_tainted: 1 });
      const budgets = JSON.parse((rt.runtime.db.prepare('SELECT budgets_json FROM runs WHERE id = ?').get(out.runId) as { budgets_json: string }).budgets_json) as { maxModelCalls: number };
      const parentBudgets = JSON.parse((rt.runtime.db.prepare('SELECT budgets_json FROM runs WHERE id = ?').get(runId) as { budgets_json: string }).budgets_json) as { maxModelCalls: number };
      expect(budgets.maxModelCalls).toBeLessThanOrEqual(parentBudgets.maxModelCalls);
      // And the parent's trace shows the child start, as it would a delegated agent's.
      expect(events.some((e) => e.type === 'run-started' && e.payload['childRunId'] === out.runId && e.payload['kind'] === 'workflow')).toBe(true);

      const items = await memoryItems(rt);
      expect(items).toHaveLength(1);
      expect(items[0]!.trust, 'the researcher step read the web; the parent has, through it').toBe('untrusted');
    } finally {
      await rt.stop();
    }
  }, 60_000);

  it('a delegation that failed carries nothing: no child ran, so nothing was read', async () => {
    const ws = prepare('sec43-failed');
    fixtures(ws, [
      { name: 'ad0-editor-done', match: { systemIncludes: 'The Editor', afterTool: 'memory.remember' }, respond: { text: 'Filed.' } },
      { name: 'ad1-editor-remember', match: { systemIncludes: 'The Editor', afterTool: 'agent.delegate' },
        respond: { text: 'No such agent; noting the gap.', toolCalls: [{ name: 'memory.remember', input: { content: 'There is no cartographer here.', scope: 'workspace' } }] } },
      { name: 'ad2-editor-delegate', match: { systemIncludes: 'The Editor' },
        respond: { text: 'Asking the cartographer.', toolCalls: [{ name: 'agent.delegate', input: { agent: 'cartographer', input: 'Map it.' } }] } },
    ]);

    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true });
    try {
      const { runId, done } = rt.runtime.engine.startAgentRun({ agentId: 'delegator', inputs: { input: 'Plan a piece.' } });
      await done;
      expect(rt.runtime.engine.getRun(runId)?.state).toBe('completed');
      const events = await trace(rt, runId);
      const delegated = events.find((e) => e.type === 'tool-completed' && e.payload['tool'] === 'agent.delegate')!;
      expect(delegated.payload['ok'], 'the delegation was refused by name').toBe(false);
      const items = await memoryItems(rt);
      expect(items).toHaveLength(1);
      expect(items[0]!.trust, 'a failed call consumed nothing').toBe('trusted');
    } finally {
      await rt.stop();
    }
  }, 60_000);
});

/**
 * The same rule through a document (RUN-23, D-73): an output written by a run that read the web is that web
 * page one step removed, so reading it with `artifact.read` marks the reader external. The orchestrator is the
 * agent this matters for — it is the one whose job is to read what the others made and then decide.
 */
describe('SEC-43 (RUN-23) reading an output written by a tainted run taints the reader', () => {
  function prepareReads(name: string): string {
    const ws = tempWorkspace(name);
    const file = path.join(ws, 'config', 'workbench.json');
    const config = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    config['grants'] = {
      researcher: { tools: { 'web.search': 'allow', 'artifact.write': 'allow' }, fs: { read: ['projects/'], write: ['projects/'] } },
      reviewer: { tools: { 'artifact.read': 'allow', 'memory.remember': 'allow' }, fs: { read: ['projects/'] } },
    };
    (config['search'] as Record<string, unknown>) = { provider: 'mock' };
    fs.writeFileSync(file, JSON.stringify(config, null, 2));
    fs.mkdirSync(path.join(ws, 'projects', 'reads'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'projects', 'reads', 'project.json'), JSON.stringify({ schemaVersion: 1, name: 'Reads', agents: [], memory: ['agent', 'project', 'workspace', 'user'] }));
    fixtures(ws, [
      // The Researcher searches, files what it found, and stops.
      { name: 'ba0-researcher-filed', match: { systemIncludes: 'The Researcher', afterTool: 'artifact.write' }, respond: { text: 'Filed.' } },
      { name: 'ba1-researcher-file', match: { systemIncludes: 'The Researcher', afterTool: 'web.search' },
        respond: { text: 'Filing.', toolCalls: [{ name: 'artifact.write', input: { path: 'notes/web.md', content: 'The arcology is a city in one building (https://example.com/arcology).' } }] } },
      { name: 'ba2-researcher-search', match: { systemIncludes: 'The Researcher' },
        respond: { text: 'Searching.', toolCalls: [{ name: 'web.search', input: { query: 'arcology' } }] } },
      // The Reviewer reads one note — which one the task names — and remembers a line.
      { name: 'bb0-reviewer-noted', match: { systemIncludes: 'The Reviewer', afterTool: 'memory.remember' }, respond: { text: 'Noted.' } },
      { name: 'bb1-reviewer-remember', match: { systemIncludes: 'The Reviewer', afterTool: 'artifact.read' },
        respond: { text: 'Remembering.', toolCalls: [{ name: 'memory.remember', input: { content: 'The note says the arcology is one building.', scope: 'agent' } }] } },
      { name: 'bb2-reviewer-read-web', match: { systemIncludes: 'The Reviewer', lastUserIncludes: 'read the web note' },
        respond: { text: 'Reading.', toolCalls: [{ name: 'artifact.read', input: { path: 'notes/web.md' } }] } },
      { name: 'bb3-reviewer-read-human', match: { systemIncludes: 'The Reviewer', lastUserIncludes: 'read the human note' },
        respond: { text: 'Reading.', toolCalls: [{ name: 'artifact.read', input: { path: 'notes/human.md' } }] } },
    ]);
    return ws;
  }

  it('a note the researcher wrote after searching taints whoever reads it; a note a person wrote does not', async () => {
    const ws = prepareReads('sec43-reads');
    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true });
    try {
      const wrote = rt.runtime.engine.startAgentRun({ agentId: 'researcher', inputs: { input: 'Find out about the arcology and note it.' }, project: 'reads' });
      await wrote.done;
      expect(rt.runtime.engine.getRun(wrote.runId)?.state).toBe('completed');
      expect(rt.runtime.artifacts.versionProvenance('reads', 'notes/web.md')).toMatchObject({ createdBy: 'run-step', runId: wrote.runId, externalTainted: true });
      rt.runtime.artifacts.writeDocument({ projectSlug: 'reads', path: 'notes/human.md', content: 'The arcology is a city in one building.', createdBy: 'human' });

      // The control first: once an untrusted item exists in the reviewer's memory, retrieval would carry it into
      // the next prompt and taint that run by the memory rule (D-17) — correct, and not what this case is about.
      const human = rt.runtime.engine.startAgentRun({ agentId: 'reviewer', inputs: { input: 'Please read the human note and remember the gist.' }, project: 'reads' });
      await human.done;
      expect(rt.runtime.engine.getRun(human.runId)?.state).toBe('completed');
      const humanRow = rt.runtime.db.prepare('SELECT private_tainted, external_tainted FROM runs WHERE id = ?').get(human.runId) as { private_tainted: number; external_tainted: number };
      expect(humanRow, 'reading is private content; a version a person wrote is not external').toEqual({ private_tainted: 1, external_tainted: 0 });

      const web = rt.runtime.engine.startAgentRun({ agentId: 'reviewer', inputs: { input: 'Please read the web note and remember the gist.' }, project: 'reads' });
      await web.done;
      expect(rt.runtime.engine.getRun(web.runId)?.state).toBe('completed');
      const read = (await trace(rt, web.runId)).find((e) => e.type === 'tool-completed' && e.payload['tool'] === 'artifact.read')!;
      expect(read.payload['ok'], JSON.stringify(read.payload)).toBe(true);
      expect(JSON.stringify(read.payload['output']), 'the fact rides on meta, not in what the model reads').not.toContain('taint');
      const webRow = rt.runtime.db.prepare('SELECT private_tainted, external_tainted FROM runs WHERE id = ?').get(web.runId) as { private_tainted: number; external_tainted: number };
      expect(webRow, 'this version is external content one step removed').toEqual({ private_tainted: 1, external_tainted: 1 });

      const items = await memoryItems(rt);
      expect(items.map((i) => [i.runId, i.trust])).toEqual(expect.arrayContaining([[web.runId, 'untrusted'], [human.runId, 'trusted']]));
    } finally {
      await rt.stop();
    }
  }, 60_000);
});
