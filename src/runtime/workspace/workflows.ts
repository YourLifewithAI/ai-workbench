// Writing a workflow file (RUN-13, D-62). The file is the truth: a save validates first, refuses a file that
// changed since the editor loaded it, writes `<id>.workflow.json`, and reports the new content hash. The
// owner's text editor and the workbench are both legitimate writers, and neither silently wins.
import fs from 'node:fs';
import path from 'node:path';
import type { ZodError } from 'zod';
import { Workflow, validateWorkflow, type LoadedWorkflow, type Step } from '../../shared/workflow.js';
import type { WorkflowConflict, WorkflowIssue } from '../../shared/api/index.js';
import { contentHash } from '../util/canonical.js';
import { diffLines } from '../artifacts/diff.js';

export type WorkflowWriteCode = 'validation' | 'conflict' | 'not_found' | 'exists';

/** A refused write, with what the screen needs to say why: the issues by step, or the difference on disk. */
export class WorkflowWriteError extends Error {
  constructor(readonly code: WorkflowWriteCode, message: string, readonly details?: { issues?: WorkflowIssue[]; conflict?: WorkflowConflict; schedules?: number }) {
    super(message);
    this.name = 'WorkflowWriteError';
  }
}

export function workflowFile(workflowsDir: string, id: string): string {
  return path.join(workflowsDir, `${id}.workflow.json`);
}

/** The version a loaded workflow reports: the hash of the parsed definition, defaults applied (D-10). */
export function versionOf(definition: Workflow): string {
  return contentHash({ definition });
}

/**
 * Every problem in a draft, or the definition when there is none. Zod's issues come back with the step named
 * when they concern one, and the validator's `steps[n]` paths are joined with the step's id for the same reason:
 * the person editing knows steps by name, not by position.
 */
export function checkDefinition(raw: unknown): { definition: Workflow; issues: [] } | { definition: null; issues: WorkflowIssue[] } {
  const parsed = Workflow.safeParse(raw);
  const stepIds = stepIdsOf(raw);
  if (!parsed.success) return { definition: null, issues: zodIssues(parsed.error, stepIds) };
  const result = validateWorkflow(parsed.data);
  if (result.errors.length) {
    return {
      definition: null,
      issues: result.errors.map((issue) => {
        const m = /^steps\[(\d+)\]/.exec(issue.path);
        const stepId = m ? (parsed.data.steps[Number(m[1])]?.id ?? null) : null;
        return { path: issue.path, stepId, message: issue.message };
      }),
    };
  }
  return { definition: parsed.data, issues: [] };
}

function stepIdsOf(raw: unknown): (string | null)[] {
  const steps = (raw as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps)) return [];
  return steps.map((s) => (s && typeof s === 'object' && typeof (s as { id?: unknown }).id === 'string' ? (s as { id: string }).id : null));
}

function zodIssues(error: ZodError, stepIds: (string | null)[]): WorkflowIssue[] {
  return error.issues.map((issue) => {
    const segments = issue.path.map(String);
    const stepIndex = segments[0] === 'steps' && /^\d+$/.test(segments[1] ?? '') ? Number(segments[1]) : null;
    const stepId = stepIndex === null ? null : (stepIds[stepIndex] ?? null);
    const where = segments.length ? '$.' + segments.join('.') : '$';
    return { path: where, stepId, message: issue.message };
  });
}

/** One sentence naming every refusal, so a CLI and a screen say the same thing. */
export function describeIssues(issues: WorkflowIssue[]): string {
  const lines = issues.map((issue) => (issue.stepId ? `step "${issue.stepId}": ${issue.message}` : `${issue.path}: ${issue.message}`));
  return `This workflow would not run, so it was not saved: ${lines.join('; ')}.`;
}

// ---- rendering -------------------------------------------------------------------------------------------

const WORKFLOW_KEYS = ['schemaVersion', 'id', 'name', 'description', 'defaultProject', 'inputs', 'permissions', 'budgets', 'steps', 'outputs', 'schedule'];
const STEP_KEYS = ['id', 'kind', 'agent', 'tool', 'model', 'input', 'over', 'concurrency', 'step', 'dependsOn', 'when', 'review', 'onReject', 'retries', 'budget', 'outputSchema', 'output'];

/**
 * The definition as it is written to disk: keys in the order a person reads them, and the schema's defaults
 * left out (`dependsOn: []`, `review: "none"`, `retries: 0`, a map's `concurrency: 3`, empty `outputs`). The
 * hash is taken over the parsed form, defaults applied, so leaving them out changes nothing the runtime sees
 * and keeps a hand-written file from growing a line of boilerplate per step on its first save.
 */
export function compactWorkflow(definition: Workflow): Record<string, unknown> {
  const out: Record<string, unknown> = { ...definition, steps: definition.steps.map(compactStep) };
  if (definition.outputs && Object.keys(definition.outputs).length === 0) delete out['outputs'];
  return orderKeys(out, WORKFLOW_KEYS);
}

function compactStep(step: Step): Record<string, unknown> {
  const out: Record<string, unknown> = { ...step };
  if (step.dependsOn.length === 0) delete out['dependsOn'];
  if (step.review === 'none') delete out['review'];
  if (step.retries === 0) delete out['retries'];
  if (step.kind === 'map') {
    if (step.concurrency === 3) delete out['concurrency'];
    out['step'] = compactStep(step.step);
  }
  return orderKeys(out, STEP_KEYS);
}

function orderKeys(value: Record<string, unknown>, order: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of order) if (value[key] !== undefined) out[key] = value[key];
  for (const key of Object.keys(value)) if (!(key in out) && value[key] !== undefined) out[key] = value[key];
  return out;
}

export function renderWorkflow(definition: Workflow): string {
  return JSON.stringify(compactWorkflow(definition), null, 2) + '\n';
}

// ---- the file on disk --------------------------------------------------------------------------------------

/** What the file holds right now, or why it cannot be hashed. A file that no longer parses has still changed. */
export function diskState(file: string): { exists: false } | { exists: true; version: string; definition: Workflow | null } {
  if (!fs.existsSync(file)) return { exists: false };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { exists: true, version: 'unparseable', definition: null };
  }
  const parsed = Workflow.safeParse(raw);
  if (!parsed.success) return { exists: true, version: `invalid:${contentHash(raw)}`, definition: null };
  return { exists: true, version: versionOf(parsed.data), definition: parsed.data };
}

export interface SaveInput {
  workflowsDir: string;
  id: string;
  /** The draft, as the editor holds it. */
  raw: unknown;
  /** The hash the editor loaded; the save is refused unless the file still hashes to it. */
  baseVersion: string;
  /** The definition behind a hash the runtime still knows (in memory or in `workflow_versions`), for the diff. */
  knownVersion: (hash: string) => Workflow | null;
}

/**
 * Validate, check the file has not moved, write. The order matters: a draft that would not run is refused
 * before the file is looked at, so the message is about the draft; a file that changed is refused before it is
 * touched, so nothing of the owner's other edit is lost.
 */
export function saveWorkflow(input: SaveInput): LoadedWorkflow {
  const checked = checkDefinition(input.raw);
  if (!checked.definition) throw new WorkflowWriteError('validation', describeIssues(checked.issues), { issues: checked.issues });
  const definition = checked.definition;
  if (definition.id !== input.id) {
    const issue: WorkflowIssue = { path: '$.id', stepId: null, message: `is "${definition.id}", but this file is "${input.id}.workflow.json". A workflow's id is its file name; to rename one, create a copy and delete the original.` };
    throw new WorkflowWriteError('validation', describeIssues([issue]), { issues: [issue] });
  }

  const file = workflowFile(input.workflowsDir, input.id);
  const disk = diskState(file);
  if (!disk.exists) throw new WorkflowWriteError('not_found', `"${input.id}" was deleted from disk after you opened it. Create it again if you still want it.`);
  if (disk.version !== input.baseVersion) {
    const base = input.knownVersion(input.baseVersion);
    const against: WorkflowConflict['against'] = base ? 'loaded' : 'draft';
    const before = renderWorkflow(base ?? definition);
    const after = disk.definition ? renderWorkflow(disk.definition) : fs.readFileSync(file, 'utf8');
    const conflict: WorkflowConflict = { baseVersion: input.baseVersion, currentVersion: disk.version, against, diff: diffLines(before, after) };
    throw new WorkflowWriteError('conflict',
      `${path.basename(file)} changed on disk after you opened it (${conflict.diff.added} line${conflict.diff.added === 1 ? '' : 's'} added, ${conflict.diff.removed} removed). Nothing was written. Load what is on disk, or keep your draft and decide what to carry over.`,
      { conflict });
  }

  fs.writeFileSync(file, renderWorkflow(definition));
  return { definition, version: versionOf(definition), file };
}

export interface CreateInput {
  workflowsDir: string;
  id: string;
  name: string;
  /** Copy this definition (its schedule left behind), else start from a one-step blank. */
  copyOf?: Workflow | undefined;
  /** The agent a blank workflow's first step names: the workspace must have at least one. */
  firstAgent: string;
}

export function createWorkflow(input: CreateInput): LoadedWorkflow {
  const file = workflowFile(input.workflowsDir, input.id);
  if (fs.existsSync(file)) throw new WorkflowWriteError('exists', `There is already a workflow called "${input.id}". Pick another id.`);
  const raw: Record<string, unknown> = input.copyOf
    ? { ...input.copyOf, id: input.id, name: input.name, schedule: undefined }
    : {
        schemaVersion: 1,
        id: input.id,
        name: input.name,
        description: '',
        inputs: { type: 'object', properties: { input: { type: 'string', title: 'Input', description: 'What the first step is given.' } }, required: ['input'] },
        steps: [{ id: 'first', kind: 'agent', agent: input.firstAgent, input: '{{inputs.input}}' }],
        outputs: { result: '{{steps.first.output}}' },
      };
  const checked = checkDefinition(raw);
  if (!checked.definition) throw new WorkflowWriteError('validation', describeIssues(checked.issues), { issues: checked.issues });
  fs.mkdirSync(input.workflowsDir, { recursive: true });
  fs.writeFileSync(file, renderWorkflow(checked.definition));
  return { definition: checked.definition, version: versionOf(checked.definition), file };
}

/** Removes the file. Whether anything still points at it is the caller's question to ask first. */
export function deleteWorkflowFile(workflowsDir: string, id: string): void {
  const file = workflowFile(workflowsDir, id);
  if (!fs.existsSync(file)) throw new WorkflowWriteError('not_found', `There is no workflow called "${id}".`);
  fs.rmSync(file);
}
