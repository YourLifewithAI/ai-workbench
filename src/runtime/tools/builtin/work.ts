// The ledger's tools (D-75, RUN-24). `work.file`, `work.list`, `work.update` and `owner.ask` read and write the
// orchestrator's ledger and nothing else: no path, no host, no credential, no instruction. An item's trust is
// the writing run's, the way a memory item's is (D-17), and a decision's answer is the person's alone — no tool
// can give one.
import { z } from 'zod';
import { Permissions } from '../../../shared/permissions.js';
import { toolError, type ToolDefinition } from '../../../shared/tool.js';
import type { WorkItem, WorkKind, WorkOption, WorkState } from '../../../shared/api/index.js';
import type { FileWorkInput, ListWorkFilter, UpdateWorkInput } from '../../work/store.js';

const NOTHING = Permissions.parse({});
const FILE_KINDS = ['task', 'bug', 'note'] as const;
const SET_STATES = ['backlog', 'staffed', 'in-review', 'needs-you', 'done', 'dropped'] as const;

export interface WorkToolDeps {
  file: (input: FileWorkInput) => { item: WorkItem; outcome: 'filed' | 'refreshed' };
  list: (filter: ListWorkFilter) => WorkItem[];
  update: (id: string, patch: UpdateWorkInput) => WorkItem | null;
  /** The open item under a key, so the pulse can move what it filed by key without carrying ids between runs. */
  openByKey: (key: string) => WorkItem | null;
  /** `untrusted` once the run has consumed external content (D-17): the item is shown as content, not as the orchestrator's word. */
  trustFor: (runId: string) => 'trusted' | 'untrusted';
}

/** What the model sees of an item: the row, without the run links it does not need. */
function brief(item: WorkItem): Record<string, unknown> {
  return {
    id: item.id, kind: item.kind, project: item.project, title: item.title, detail: item.detail, state: item.state,
    assignee: item.assignee, key: item.key, trust: item.trust,
    ...(item.options.length ? { options: item.options, lean: item.lean } : {}),
    ...(item.answer !== null ? { answer: item.answer, note: item.note } : {}),
    updatedAt: item.updatedAt,
  };
}

export function workTools(deps: WorkToolDeps): ToolDefinition[] {
  const file: ToolDefinition<{ title: string; detail?: string | undefined; kind?: WorkKind | undefined; project?: string | undefined; assignee?: string | undefined; key?: string | undefined; state?: WorkState | undefined }, { id: string; outcome: 'filed' | 'refreshed'; state: string }> = {
    id: 'work.file',
    version: '1.0.0',
    description: 'File a task, a bug or a note in the ledger. Give it a key — "bug:weaver:ending", say — and filing it again refreshes the same item rather than making a second one. Name the agent it is for with assignee, and mark it needs-you when only the owner can move it.',
    input: z.object({
      title: z.string().min(1).max(200).describe('One line, the way it would read on a board.'),
      detail: z.string().max(4000).optional().describe('What you saw and what should happen. The owner reads this.'),
      kind: z.enum(FILE_KINDS).optional().describe('task (default), bug, or note.'),
      project: z.string().optional().describe('The project it belongs to. Defaults to this run\'s.'),
      assignee: z.string().optional().describe('The agent that should do it, by id.'),
      key: z.string().max(200).optional().describe('A stable key so the same finding is one item, refreshed, never two.'),
      state: z.enum(['backlog', 'staffed', 'needs-you']).optional().describe('backlog (default), staffed when you have already dispatched it, needs-you when only the owner can move it.'),
    }),
    output: z.object({ id: z.string(), outcome: z.enum(['filed', 'refreshed']), state: z.string() }),
    tier: 'write',
    maxPermissions: NOTHING,
    execute: async (input, ctx) => {
      const { item, outcome } = deps.file({
        kind: input.kind ?? 'task', project: input.project ?? ctx.project, title: input.title, detail: input.detail ?? null,
        state: input.state ?? 'backlog', assignee: input.assignee ?? null, key: input.key ?? null,
        trust: deps.trustFor(ctx.runId), runId: ctx.runId,
      });
      return { ok: true, output: { id: item.id, outcome, state: item.state } };
    },
  };

  const list: ToolDefinition<{ state?: WorkState | 'open' | 'all' | undefined; project?: string | undefined; kind?: WorkKind | undefined; assignee?: string | undefined; limit?: number | undefined }, { items: Record<string, unknown>[] }> = {
    id: 'work.list',
    version: '1.0.0',
    description: 'The ledger: what is owed, to whom, in what state. Open by default — backlog, staffed, in review, needs the owner, and decisions the owner has answered that you have not yet acted on. Each item says whose words it carries (trust).',
    input: z.object({
      state: z.enum(['open', 'all', 'backlog', 'staffed', 'in-review', 'needs-you', 'decided', 'done', 'dropped']).optional().describe('Default open.'),
      project: z.string().optional(),
      kind: z.enum(['task', 'bug', 'decision', 'note']).optional(),
      assignee: z.string().optional(),
      limit: z.number().int().positive().max(100).optional().describe('Default 50.'),
    }),
    output: z.object({ items: z.array(z.record(z.string(), z.unknown())) }),
    tier: 'read',
    maxPermissions: NOTHING,
    execute: async (input) => ({ ok: true, output: { items: deps.list({ ...input }).map(brief) } }),
  };

  const update: ToolDefinition<{ id?: string | undefined; key?: string | undefined; state?: (typeof SET_STATES)[number] | undefined; assignee?: string | undefined; detail?: string | undefined; note?: string | undefined }, Record<string, unknown>> = {
    id: 'work.update',
    version: '1.0.0',
    description: 'Move an item: staffed when you dispatched it, in-review when the work came back, done or dropped when it is settled, needs-you when only the owner can move it. Add a note about what happened. A decision is answered by the owner, never here.',
    input: z.object({
      id: z.string().optional().describe('The item, by id.'),
      key: z.string().max(200).optional().describe('Or the open item filed under this key.'),
      state: z.enum(SET_STATES).optional(),
      assignee: z.string().optional(),
      detail: z.string().max(4000).optional(),
      note: z.string().max(2000).optional().describe('What happened, for the owner.'),
    }),
    output: z.record(z.string(), z.unknown()),
    tier: 'write',
    maxPermissions: NOTHING,
    execute: async (input, ctx) => {
      if (!input.id && !input.key) return toolError('ToolError', 'Name the item: its id, or the key it was filed under.');
      const id = input.id ?? deps.openByKey(input.key!)?.id;
      if (!id) return toolError('NotFound', `There is no open work item under the key "${input.key}".`);
      const item = deps.update(id, {
        ...(input.state ? { state: input.state } : {}), ...(input.assignee ? { assignee: input.assignee } : {}),
        ...(input.detail ? { detail: input.detail } : {}), ...(input.note ? { note: input.note } : {}),
        run: { runId: ctx.runId, role: input.state === 'staffed' ? 'staffed' : 'worked' },
      });
      if (!item) return toolError('NotFound', `There is no work item "${id}".`);
      return { ok: true, output: brief(item) };
    },
  };

  const ask: ToolDefinition<{ question: string; options: { label: string; detail?: string | undefined }[]; lean?: number | undefined; why: string; project?: string | undefined; key?: string | undefined }, { id: string; state: string }> = {
    id: 'owner.ask',
    version: '1.0.0',
    description: 'Put a decision to the owner as options, with your lean and why. It waits under Needs you on the Dashboard; the owner answers with one click and your next work.list shows it decided, with the answer. Ask only what the owner must decide; batch what belongs together into one question.',
    input: z.object({
      question: z.string().min(1).max(300),
      options: z.array(z.object({ label: z.string().min(1).max(120), detail: z.string().max(600).optional() })).min(2).max(4),
      lean: z.number().int().min(0).max(3).optional().describe('The index of the option you would pick.'),
      why: z.string().min(1).max(2000).describe('The case, concretely. The owner reads this before choosing.'),
      project: z.string().optional(),
      key: z.string().max(200).optional().describe('A stable key so the same question is asked once.'),
    }),
    output: z.object({ id: z.string(), state: z.string() }),
    tier: 'write',
    maxPermissions: NOTHING,
    execute: async (input, ctx) => {
      if (input.lean !== undefined && input.lean >= input.options.length) return toolError('InvalidInput', `lean ${input.lean} names no option; there are ${input.options.length}.`);
      const options: WorkOption[] = input.options.map((o, i) => ({ id: String.fromCharCode(97 + i), label: o.label, detail: o.detail ?? null }));
      const { item } = deps.file({
        kind: 'decision', project: input.project ?? ctx.project, title: input.question, detail: input.why, state: 'needs-you',
        assignee: null, key: input.key ?? null, trust: deps.trustFor(ctx.runId), runId: ctx.runId,
        options, lean: input.lean !== undefined ? options[input.lean]!.id : null,
      });
      return { ok: true, output: { id: item.id, state: item.state } };
    },
  };

  return [file as ToolDefinition, list as ToolDefinition, update as ToolDefinition, ask as ToolDefinition];
}
