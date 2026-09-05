// RUN-13 Definition of done (spec/runs/RUN-13.md). Item 6 (edit, watch the graph, save, run, read the trace in
// the browser) is @run-13 in tests/e2e/workflows.spec.ts; item 4's graph half lives there too.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { RunDetail, ScheduleSummary, WorkflowDetail } from '../../src/shared/api/index.js';
import type { EventRecord } from '../../src/shared/events.js';
import { Workflow, validateWorkflow } from '../../src/shared/workflow.js';
import { CLI_DIST, cleanEnv, runCli, startRuntime, tempWorkspace, waitFor, type Started } from '../helpers/workspace.js';

let ws: string;
let rt: Started;

beforeAll(async () => {
  if (!fs.existsSync(CLI_DIST)) throw new Error('dist/cli.js is missing: run `npm run build` (or `npm run dod -- 13`, which builds first).');
  ws = tempWorkspace('dod13');
  rt = await startRuntime(ws);
});
afterAll(async () => { await rt.stop(); });

const headers = (): Record<string, string> => ({ Authorization: `Bearer ${rt.token}`, 'Content-Type': 'application/json' });
const api = (method: string, p: string, body?: unknown): Promise<Response> =>
  fetch(`${rt.baseUrl}/api/v1${p}`, { method, headers: headers(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const errorOf = async (res: Response): Promise<{ code: string; message: string; details?: Record<string, unknown> }> => ((await res.json()) as { error: { code: string; message: string; details?: Record<string, unknown> } }).error;
const workflow = async (id: string): Promise<WorkflowDetail> => (await (await api('GET', `/workflows/${id}`)).json()) as WorkflowDetail;
const fileOf = (id: string): string => path.join(ws, 'workflows', `${id}.workflow.json`);

async function runWorkflow(id: string, inputs: Record<string, unknown>): Promise<{ runId: string; trace: EventRecord[] }> {
  const res = await api('POST', '/runs', { kind: 'workflow', id, inputs, provider: 'mock' });
  expect(res.status).toBe(202);
  const { runId } = (await res.json()) as { runId: string };
  await waitFor(async () => ((await (await api('GET', `/runs/${runId}`)).json()) as RunDetail).state === 'completed', 60_000);
  const text = await (await api('GET', `/runs/${runId}/trace.jsonl`)).text();
  return { runId, trace: text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as EventRecord) };
}

const agentOf = (trace: EventRecord[], stepId: string): unknown => trace.find((e) => e.type === 'step-started' && e.stepId === stepId)?.payload['agentId'];
const versionOf = (trace: EventRecord[]): unknown => trace.find((e) => e.type === 'run-started')?.payload['workflowVersion'];

describe('DoD 1: editing a step\'s agent changes the next run and not the last one', () => {
  it('story-pipeline: final on the Cutter, then on the Weaver; each run keeps the version it began with', async () => {
    const before = await runWorkflow('story-pipeline', { premise: 'A dentist finds a message in a tooth.' });
    expect(agentOf(before.trace, 'final')).toBe('cutter');

    const loaded = await workflow('story-pipeline');
    const definition = structuredClone(loaded.definition) as { steps: Record<string, unknown>[] };
    const final = definition.steps.find((s) => s['id'] === 'final')!;
    final['agent'] = 'weaver';
    delete final['model'];
    const saved = await api('PUT', '/workflows/story-pipeline', { definition, baseVersion: loaded.version });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const detail = (await saved.json()) as WorkflowDetail;
    expect(detail.version).not.toBe(loaded.version);
    expect(detail.steps.find((s) => s.id === 'final')?.agent).toBe('weaver');
    // The file is the truth, and this is what it now says.
    expect((JSON.parse(fs.readFileSync(fileOf('story-pipeline'), 'utf8')) as { steps: { agent: string }[] }).steps[2]!.agent).toBe('weaver');

    const after = await runWorkflow('story-pipeline', { premise: 'A dentist finds a message in a tooth.' });
    expect(agentOf(after.trace, 'final')).toBe('weaver');
    expect(versionOf(after.trace)).toBe(detail.version);

    // Editing never rewrites history: the earlier run still names the Cutter and its own hash.
    const again = (await (await api('GET', `/runs/${before.runId}/trace.jsonl`)).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l) as EventRecord);
    expect(agentOf(again, 'final')).toBe('cutter');
    expect(versionOf(again)).toBe(loaded.version);
  }, 120_000);
});

describe('DoD 2: a save that would break a reference is refused, and the file is unchanged', () => {
  it('names the step and the reference; the bytes on disk are the same', async () => {
    const loaded = await workflow('ensemble-draft');
    const before = fs.readFileSync(fileOf('ensemble-draft'), 'utf8');
    const definition = structuredClone(loaded.definition) as { steps: Record<string, unknown>[] };
    const verdict = definition.steps[definition.steps.length - 1]!;
    verdict['input'] = 'Judge these.\n\n{{steps.nope.output}}';
    const res = await api('PUT', '/workflows/ensemble-draft', { definition, baseVersion: loaded.version });
    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect(error.code).toBe('validation');
    expect(error.message).toContain(`step "${verdict['id']}"`);
    expect(error.message).toContain('"nope"');
    expect(error.details?.['issues']).toEqual([expect.objectContaining({ stepId: verdict['id'] })]);
    expect(fs.readFileSync(fileOf('ensemble-draft'), 'utf8')).toBe(before);
    expect((await workflow('ensemble-draft')).version).toBe(loaded.version);
  });
});

describe('DoD 3: a file edited on disk after the editor loaded it cannot be saved over', () => {
  it('is refused with the difference, and the disk edit survives', async () => {
    const loaded = await workflow('research-briefing');
    // The owner's text editor, after the screen loaded the file.
    const onDisk = JSON.parse(fs.readFileSync(fileOf('research-briefing'), 'utf8')) as Record<string, unknown>;
    onDisk['description'] = 'Changed in a text editor while the screen was open.';
    fs.writeFileSync(fileOf('research-briefing'), JSON.stringify(onDisk, null, 2) + '\n');

    const definition = structuredClone(loaded.definition) as Record<string, unknown>;
    definition['name'] = 'Renamed on the screen';
    const res = await api('PUT', '/workflows/research-briefing', { definition, baseVersion: loaded.version });
    expect(res.status).toBe(409);
    const error = await errorOf(res);
    expect(error.code).toBe('conflict');
    expect(error.message).toContain('changed on disk');
    const conflict = error.details?.['conflict'] as { against: string; baseVersion: string; currentVersion: string; diff: { lines: { kind: string; text: string }[] } };
    expect(conflict.against).toBe('loaded');
    expect(conflict.baseVersion).toBe(loaded.version);
    expect(conflict.currentVersion).not.toBe(loaded.version);
    const changed = conflict.diff.lines.filter((l) => l.kind !== 'same').map((l) => `${l.kind}:${l.text.trim()}`);
    expect(changed).toContain('added:"description": "Changed in a text editor while the screen was open.",');
    expect(changed.some((c) => c.startsWith('removed:"description"'))).toBe(true);

    const still = JSON.parse(fs.readFileSync(fileOf('research-briefing'), 'utf8')) as Record<string, unknown>;
    expect(still['description']).toBe('Changed in a text editor while the screen was open.');
    expect(still['name']).not.toBe('Renamed on the screen');
  });
});

describe('DoD 4: a reference typed into a new step is an edge before anything is saved', () => {
  it('the validator the screen runs on the draft reports beats → check', () => {
    const draft = JSON.parse(fs.readFileSync(fileOf('story-pipeline'), 'utf8')) as { steps: unknown[] };
    draft.steps.push({ id: 'check', kind: 'agent', agent: 'reviewer', input: 'Check these.\n\n{{steps.beats.output}}' });
    const { edges, errors } = validateWorkflow(Workflow.parse(draft));
    expect(errors).toEqual([]);
    expect([...(edges.get('check') ?? [])]).toEqual(['beats']);
  });
});

describe('DoD 5: a workflow with a schedule is not deleted without the count being shown', () => {
  it('refuses with the number, then deletes the schedule with the workflow when told to', async () => {
    const made = await api('POST', '/workflows', { id: 'to-delete', name: 'To delete', copyOf: 'story-pipeline' });
    expect(made.status, await made.clone().text()).toBe(201);
    const schedule = await api('POST', '/schedules', { workflowId: 'to-delete', cron: '0 7 * * *', inputs: { premise: 'x' } });
    expect(schedule.status).toBe(201);
    expect((await workflow('to-delete')).schedules).toBe(1);

    const refused = await api('DELETE', '/workflows/to-delete');
    expect(refused.status).toBe(409);
    const error = await errorOf(refused);
    expect(error.message).toContain('1 schedule');
    expect(error.details?.['schedules']).toBe(1);
    expect(fs.existsSync(fileOf('to-delete'))).toBe(true);

    const deleted = await api('DELETE', '/workflows/to-delete?deleteSchedules=true');
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true, schedules: 1 });
    expect(fs.existsSync(fileOf('to-delete'))).toBe(false);
    const schedules = ((await (await api('GET', '/schedules')).json()) as { schedules: ScheduleSummary[] }).schedules;
    expect(schedules.some((s) => s.workflowId === 'to-delete')).toBe(false);
    expect((await api('GET', '/workflows/to-delete')).status).toBe(404);
  });
});

describe('create: blank or a copy', () => {
  it('a blank workflow has one step and runs; a copy leaves the schedule behind', async () => {
    const blank = await api('POST', '/workflows', { id: 'fresh', name: 'Fresh' });
    expect(blank.status).toBe(201);
    const detail = (await blank.json()) as WorkflowDetail;
    expect(detail.steps).toHaveLength(1);
    expect(detail.steps[0]?.agent).toBe('echo');
    const run = await runWorkflow('fresh', { input: 'hello from a blank workflow' });
    expect(agentOf(run.trace, 'first')).toBe('echo');

    const copy = await api('POST', '/workflows', { id: 'briefing-copy', name: 'Briefing copy', copyOf: 'research-briefing' });
    expect(copy.status).toBe(201);
    const copied = JSON.parse(fs.readFileSync(fileOf('briefing-copy'), 'utf8')) as Record<string, unknown>;
    expect(copied['schedule']).toBeUndefined();
    expect((copied['steps'] as unknown[]).length).toBe(4);
    expect((await api('POST', '/workflows', { id: 'fresh', name: 'Again' })).status).toBe(409);
  }, 60_000);
});

describe('CLI parity: workbench workflows edit <id> validates on close', () => {
  const script = (name: string, body: string): string => {
    const file = path.join(ws, `${name}.cjs`);
    fs.writeFileSync(file, `const fs = require('node:fs'); const f = process.argv[2]; const w = JSON.parse(fs.readFileSync(f, 'utf8')); ${body} fs.writeFileSync(f, JSON.stringify(w, null, 2) + '\\n');\n`);
    return file;
  };
  const editor = (file: string): string => `"${process.execPath}" "${file}"`;

  it('an edit that breaks a reference exits 1 naming it, and the file stays as the person wrote it', async () => {
    const breaker = script('break', "w.steps[1].input = 'From nowhere: {{steps.nowhere.output}}';");
    const res = await runCli(['workflows', 'edit', 'story-pipeline', '--workspace', ws], { dist: true, env: cleanEnv({ EDITOR: editor(breaker) }) });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('nowhere');
    expect(res.stderr).toContain('saved as you left it');
    expect(fs.readFileSync(fileOf('story-pipeline'), 'utf8')).toContain('steps.nowhere.output');
  }, 60_000);

  it('a good edit exits 0 with the new version', async () => {
    const fixer = script('fix', "w.steps[1].input = 'Turn these beats into prose.\\n\\n{{steps.beats.output}}';");
    const res = await runCli(['workflows', 'edit', 'story-pipeline', '--workspace', ws], { dist: true, env: cleanEnv({ EDITOR: editor(fixer) }) });
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/Valid\. story-pipeline\.workflow\.json is now [0-9a-f]{16}\./);
    const untouched = await runCli(['workflows', 'edit', 'story-pipeline', '--workspace', ws], { dist: true, env: cleanEnv({ EDITOR: editor(script('noop', '')) }) });
    expect(untouched.code, untouched.stderr).toBe(0);
    expect(untouched.stdout).toContain('Unchanged.');
  }, 60_000);
});
