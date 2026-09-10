// SEC-38 (RUN-23): a delegation names the project. `agent.delegate` gained `project`, and the child runs under
// *that* project's tool ceiling and memory list, exactly as a run started there from the screen would (D-69).
// The ceiling is the project's, not the parent's: it does not travel with the brief, and it still only narrows
// the child's own grant. A project that does not exist is refused before anything starts; a call with no
// project keeps the old behaviour, the parent's.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { startRuntime, tempWorkspace, type Started } from '../helpers/workspace.js';
import type { EventRecord } from '../../src/shared/events.js';

const headers = (rt: Started): Record<string, string> => ({ Authorization: `Bearer ${rt.token}`, 'Content-Type': 'application/json' });

function prepare(name: string): string {
  const ws = tempWorkspace(name);
  const file = path.join(ws, 'config', 'workbench.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  config['grants'] = {
    delegator: { tools: { 'agent.delegate': 'allow' } },
    researcher: { tools: { 'web.search': 'allow', datetime: 'allow' } },
  };
  (config['search'] as Record<string, unknown>) = { provider: 'mock' };
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  // A project whose ceiling admits the clock and nothing else.
  fs.mkdirSync(path.join(ws, 'projects', 'tight'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'projects', 'tight', 'project.json'), JSON.stringify({
    schemaVersion: 1, name: 'Tight', description: 'No web here.', agents: ['researcher'], tools: ['datetime'], memory: ['agent'],
  }, null, 2));
  return ws;
}

function fixtures(ws: string, entries: { name: string; match: Record<string, unknown>; respond: Record<string, unknown> }[]): void {
  for (const f of entries) fs.writeFileSync(path.join(ws, 'fixtures', `${f.name}.json`), JSON.stringify({ match: f.match, respond: f.respond }));
}

async function trace(rt: Started, runId: string): Promise<EventRecord[]> {
  return (await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}/trace.jsonl`, { headers: headers(rt) })).text())
    .trim().split('\n').map((l) => JSON.parse(l) as EventRecord);
}

/** The Editor delegates once, with the given extra fields, and reports; the Researcher searches, then answers. */
function script(ws: string, extra: Record<string, unknown>): void {
  fixtures(ws, [
    { name: 'a0-editor-done', match: { systemIncludes: 'The Editor', afterTool: 'agent.delegate' }, respond: { text: 'Reported.' } },
    { name: 'a1-editor-delegate', match: { systemIncludes: 'The Editor' },
      respond: { text: 'Asking.', toolCalls: [{ name: 'agent.delegate', input: { agent: 'researcher', input: 'What is the arcology? One line.', ...extra } }] } },
    { name: 'a2-researcher-answer', match: { systemIncludes: 'The Researcher', afterTool: 'web.search' }, respond: { text: 'A city in one building.' } },
    { name: 'a3-researcher-search', match: { systemIncludes: 'The Researcher' },
      respond: { text: 'Searching.', toolCalls: [{ name: 'web.search', input: { query: 'arcology' } }] } },
  ]);
}

async function delegate(rt: Started): Promise<{ parent: string; events: EventRecord[]; call: EventRecord }> {
  const { runId, done } = rt.runtime.engine.startAgentRun({ agentId: 'delegator', inputs: { input: 'Find out about the arcology.' } });
  await done;
  expect(rt.runtime.engine.getRun(runId)?.state).toBe('completed');
  const events = await trace(rt, runId);
  const call = events.find((e) => e.type === 'tool-completed' && e.payload['tool'] === 'agent.delegate')!;
  expect(call).toBeDefined();
  return { parent: runId, events, call };
}

describe('SEC-38 (RUN-23) a delegation into a project runs under that project', () => {
  it('the named project\'s ceiling refuses the child\'s web search by name, though the child\'s grant allows it', async () => {
    const ws = prepare('sec38b-tight');
    script(ws, { project: 'tight' });
    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true });
    try {
      const { call } = await delegate(rt);
      expect(call.payload['ok'], JSON.stringify(call.payload)).toBe(true);
      const childId = (call.payload['output'] as { runId: string }).runId;
      const child = rt.runtime.db.prepare('SELECT project_id, parent_run_id FROM runs WHERE id = ?').get(childId) as { project_id: string; parent_run_id: string };
      expect(child.project_id).toBe('tight');

      const decided = (await trace(rt, childId)).filter((e) => e.type === 'permission-decided' && e.payload['tool'] === 'web.search');
      expect(decided).toHaveLength(1);
      expect(decided[0]!.payload['allowed']).toBe(false);
      expect(decided[0]!.payload['reason']).toBe('"web.search" is not allowed in project tight.');
      // Nothing was searched, so nothing external entered the chain: the parent stays clean.
      const parentRow = rt.runtime.db.prepare('SELECT external_tainted FROM runs WHERE id = ?').get(child.parent_run_id) as { external_tainted: number };
      expect(parentRow.external_tainted).toBe(0);
    } finally {
      await rt.stop();
    }
  }, 60_000);

  it('with no project named, the child works where the parent does, and the same search goes through', async () => {
    const ws = prepare('sec38b-same');
    script(ws, {});
    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true });
    try {
      const { call } = await delegate(rt);
      expect(call.payload['ok'], JSON.stringify(call.payload)).toBe(true);
      const childId = (call.payload['output'] as { runId: string }).runId;
      const child = rt.runtime.db.prepare('SELECT project_id FROM runs WHERE id = ?').get(childId) as { project_id: string | null };
      expect(child.project_id).toBeNull();
      const searched = (await trace(rt, childId)).find((e) => e.type === 'tool-completed' && e.payload['tool'] === 'web.search')!;
      expect(searched.payload['ok']).toBe(true);
    } finally {
      await rt.stop();
    }
  }, 60_000);

  it('a project that does not exist is refused before any child starts', async () => {
    const ws = prepare('sec38b-missing');
    script(ws, { project: 'no-such-project' });
    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true });
    try {
      const { parent, call } = await delegate(rt);
      expect(call.payload['ok']).toBe(false);
      expect((call.payload['error'] as { code: string; message: string }).code).toBe('NotFound');
      expect((call.payload['error'] as { message: string }).message).toContain('no-such-project');
      const children = rt.runtime.db.prepare('SELECT COUNT(*) AS n FROM runs WHERE parent_run_id = ?').get(parent) as { n: number };
      expect(children.n).toBe(0);
    } finally {
      await rt.stop();
    }
  }, 60_000);
});
