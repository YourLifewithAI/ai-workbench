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

/** A workspace where the Editor may delegate and remember, and the Researcher may search — on the mock, offline. */
function prepare(name: string): string {
  const ws = tempWorkspace(name);
  const file = path.join(ws, 'config', 'workbench.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  config['grants'] = {
    delegator: { tools: { 'agent.delegate': 'allow', 'memory.remember': 'allow' } },
    researcher: { tools: { 'web.search': 'allow' } },
  };
  (config['search'] as Record<string, unknown>) = { provider: 'mock' };
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
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
