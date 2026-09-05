// The workflow write path (RUN-13, D-62): what a save refuses, what it writes, and what the file looks like.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { Workflow, type LoadedWorkflow } from '../../src/shared/workflow.js';
import { checkDefinition, describeIssues } from '../../src/shared/workflow-check.js';
import { compactWorkflow, createWorkflow, renderWorkflow, saveWorkflow, versionOf, type WorkflowWriteError } from '../../src/runtime/workspace/workflows.js';
import { loadWorkflow } from '../../src/runtime/workspace/loader.js';
import { editorCommand } from '../../src/runtime/cli/commands/workflows.js';
import { tempDir } from '../helpers/workspace.js';

const base = {
  schemaVersion: 1 as const,
  id: 'w',
  name: 'W',
  description: 'a workflow',
  inputs: { type: 'object', properties: { topic: { type: 'string' } } },
  steps: [
    { id: 'plan', kind: 'agent', agent: 'architect', input: '{{inputs.topic}}', retries: 0, dependsOn: [], review: 'none' },
    { id: 'write', kind: 'agent', agent: 'weaver', input: 'From: {{steps.plan.output}}' },
  ],
  outputs: {},
};

function writeFile(dir: string, definition: unknown): string {
  const file = path.join(dir, 'w.workflow.json');
  fs.writeFileSync(file, JSON.stringify(definition, null, 2) + '\n');
  return file;
}

describe('the file as written', () => {
  it('drops the schema defaults and orders keys for reading, and the hash does not move', () => {
    const parsed = Workflow.parse(base);
    const compact = compactWorkflow(parsed);
    expect(Object.keys(compact)).toEqual(['schemaVersion', 'id', 'name', 'description', 'inputs', 'steps']);
    const first = compact['steps'] as Record<string, unknown>[];
    expect(Object.keys(first[0]!)).toEqual(['id', 'kind', 'agent', 'input']);
    expect(first[0]).not.toHaveProperty('retries');
    expect(first[0]).not.toHaveProperty('dependsOn');
    expect(first[0]).not.toHaveProperty('review');
    // What the runtime hashes is the parsed form, defaults applied, so leaving them out of the file changes nothing.
    expect(versionOf(Workflow.parse(JSON.parse(renderWorkflow(parsed))))).toBe(versionOf(parsed));
  });

  it('keeps a value the author set away from the default', () => {
    const parsed = Workflow.parse({ ...base, steps: [{ ...base.steps[0], retries: 2, review: 'blocking' }] });
    const step = (compactWorkflow(parsed)['steps'] as Record<string, unknown>[])[0]!;
    expect(step['retries']).toBe(2);
    expect(step['review']).toBe('blocking');
  });
});

describe('the verdict names the step', () => {
  it('for a reference to a step that does not exist', () => {
    const checked = checkDefinition({ ...base, steps: [base.steps[0], { id: 'write', kind: 'agent', agent: 'weaver', input: '{{steps.nope.output}}' }] });
    expect(checked.definition).toBeNull();
    expect(checked.issues).toEqual([expect.objectContaining({ stepId: 'write', message: expect.stringContaining('"nope"') })]);
    expect(describeIssues(checked.issues)).toContain('step "write"');
  });

  it('for a field the schema wants', () => {
    const checked = checkDefinition({ ...base, steps: [{ id: 'plan', kind: 'agent', input: 'x' }] });
    expect(checked.definition).toBeNull();
    expect(checked.issues[0]).toMatchObject({ stepId: 'plan', path: '$.steps.0.agent' });
  });
});

describe('saveWorkflow', () => {
  const setup = (): { dir: string; file: string; loaded: LoadedWorkflow } => {
    const dir = tempDir('wf-save');
    const file = writeFile(dir, base);
    return { dir, file, loaded: loadWorkflow(file, 'w') };
  };
  const known = (loaded: LoadedWorkflow) => (hash: string) => (hash === loaded.version ? loaded.definition : null);

  it('refuses a draft that would not run and leaves the file alone', () => {
    const { dir, file, loaded } = setup();
    const before = fs.readFileSync(file, 'utf8');
    const bad = { ...base, steps: [base.steps[0], { id: 'write', kind: 'agent', agent: 'weaver', input: '{{steps.nope.output}}' }] };
    expect(() => saveWorkflow({ workflowsDir: dir, id: 'w', raw: bad, baseVersion: loaded.version, knownVersion: known(loaded) }))
      .toThrow(expect.objectContaining({ code: 'validation', message: expect.stringMatching(/step "write".*"nope"/) }));
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('refuses a file that moved since it was loaded, with the difference, and writes nothing', () => {
    const { dir, file, loaded } = setup();
    // The owner's editor changed the description after the screen loaded the file.
    writeFile(dir, { ...base, description: 'edited on disk' });
    const onDisk = fs.readFileSync(file, 'utf8');
    let caught: WorkflowWriteError | null = null;
    try {
      saveWorkflow({ workflowsDir: dir, id: 'w', raw: { ...base, name: 'Renamed in the editor' }, baseVersion: loaded.version, knownVersion: known(loaded) });
    } catch (e) {
      caught = e as WorkflowWriteError;
    }
    expect(caught?.code).toBe('conflict');
    const conflict = caught?.details?.conflict;
    expect(conflict?.against).toBe('loaded');
    expect(conflict?.baseVersion).toBe(loaded.version);
    expect(conflict?.diff.lines.filter((l) => l.kind !== 'same').map((l) => `${l.kind}:${l.text.trim()}`)).toEqual([
      'removed:"description": "a workflow",',
      'added:"description": "edited on disk",',
    ]);
    expect(fs.readFileSync(file, 'utf8')).toBe(onDisk);
  });

  it('compares against the draft when the loaded version is no longer known', () => {
    const { dir, loaded } = setup();
    writeFile(dir, { ...base, description: 'edited on disk' });
    expect(() => saveWorkflow({ workflowsDir: dir, id: 'w', raw: base, baseVersion: loaded.version, knownVersion: () => null }))
      .toThrow(expect.objectContaining({ code: 'conflict', details: expect.objectContaining({ conflict: expect.objectContaining({ against: 'draft' }) }) }));
  });

  it('writes the draft when the file still hashes to the base, and the new version is what a load reports', () => {
    const { dir, file, loaded } = setup();
    const saved = saveWorkflow({ workflowsDir: dir, id: 'w', raw: { ...base, steps: [base.steps[0], { ...base.steps[1], agent: 'cutter' }] }, baseVersion: loaded.version, knownVersion: known(loaded) });
    expect(saved.version).not.toBe(loaded.version);
    expect(loadWorkflow(file, 'w').version).toBe(saved.version);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).steps[1].agent).toBe('cutter');
  });

  it('refuses to change the id, since the id is the file name', () => {
    const { dir, loaded } = setup();
    expect(() => saveWorkflow({ workflowsDir: dir, id: 'w', raw: { ...base, id: 'other' }, baseVersion: loaded.version, knownVersion: known(loaded) }))
      .toThrow(/create a copy and delete the original/);
  });
});

describe('createWorkflow', () => {
  it('copies a workflow without its schedule, under the new id and name', () => {
    const dir = tempDir('wf-create');
    const source = Workflow.parse({ ...base, schedule: { cron: '0 7 * * *' } });
    const made = createWorkflow({ workflowsDir: dir, id: 'w-copy', name: 'The copy', copyOf: source, firstAgent: 'echo' });
    expect(made.definition.id).toBe('w-copy');
    expect(made.definition.name).toBe('The copy');
    expect(made.definition.schedule).toBeUndefined();
    expect(made.definition.steps.map((s) => s.id)).toEqual(['plan', 'write']);
    expect(fs.existsSync(path.join(dir, 'w-copy.workflow.json'))).toBe(true);
  });

  it('starts a blank one on the agent it is given, and refuses an id that exists', () => {
    const dir = tempDir('wf-create');
    const made = createWorkflow({ workflowsDir: dir, id: 'blank', name: 'Blank', firstAgent: 'echo' });
    expect(made.definition.steps).toHaveLength(1);
    expect(made.definition.steps[0]).toMatchObject({ id: 'first', kind: 'agent', agent: 'echo' });
    expect(() => createWorkflow({ workflowsDir: dir, id: 'blank', name: 'Again', firstAgent: 'echo' })).toThrow(/already a workflow called "blank"/);
  });
});

describe('editorCommand', () => {
  it('splits on spaces and honours quotes, so a path with a space and a flag both work', () => {
    expect(editorCommand('code --wait', 'linux')).toEqual({ command: 'code', args: ['--wait'] });
    expect(editorCommand('"C:\\Program Files\\Editor\\edit.exe" -n', 'win32')).toEqual({ command: 'C:\\Program Files\\Editor\\edit.exe', args: ['-n'] });
    expect(editorCommand(undefined, 'linux')).toEqual({ command: 'vi', args: [] });
    expect(editorCommand(undefined, 'win32')).toEqual({ command: 'notepad', args: [] });
  });

  it('refuses a batch file on Windows rather than starting it through a shell', () => {
    expect(() => editorCommand('C:\\tools\\edit.cmd', 'win32')).toThrow(/batch file/);
  });
});
