// `.workflow.json` (D-11): a DAG of steps, each naming an agent, a tool, or a map over a list. The validator
// runs before anything executes, so a broken workflow is a message with a file and a path, never a half-run.
import { z } from 'zod';
import { Budgets, Permissions } from './permissions.js';
import { JsonSchema } from './model.js';
import { parseExpr, type Expr } from './expr.js';
import { referencesIn, type TemplateValue } from './template.js';

/** A template is any JSON whose string leaves may contain `{{ … }}`. */
export const Template: z.ZodType<TemplateValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(Template), z.record(z.string(), Template)]),
);

const StepCommon = {
  id: z.string().regex(/^[a-z0-9-]+$/, 'lowercase letters, digits and hyphens'),
  dependsOn: z.array(z.string()).default([]),
  when: z.string().optional(),
  review: z.enum(['none', 'blocking']).default('none'),
  budget: Budgets.partial().optional(),
  retries: z.number().int().min(0).max(2).default(0),
};

const AgentStep = z.object({
  ...StepCommon,
  kind: z.literal('agent'),
  agent: z.string(),
  model: z.string().optional(),
  input: Template,
  outputSchema: JsonSchema.optional(),
  /** `document: null` files nothing: the step's output is intermediate, whatever the agent's own default says. */
  output: z.object({ document: z.string().nullable().optional() }).optional(),
});

const ToolStep = z.object({ ...StepCommon, kind: z.literal('tool'), tool: z.string(), input: Template });

export interface StepCommonFields {
  id: string;
  dependsOn: string[];
  when?: string | undefined;
  review: 'none' | 'blocking';
  budget?: Partial<z.infer<typeof Budgets>> | undefined;
  retries: number;
}

export interface MapStep extends StepCommonFields {
  kind: 'map';
  over: string;
  concurrency: number;
  step: Step;
}

export type Step = z.infer<typeof AgentStep> | z.infer<typeof ToolStep> | MapStep;

/** One level of nesting: a map's inner step has its own id and no `dependsOn`. */
export const Step: z.ZodType<Step> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    AgentStep,
    ToolStep,
    z.object({ ...StepCommon, kind: z.literal('map'), over: z.string(), concurrency: z.number().int().positive().default(3), step: Step }),
  ]),
) as z.ZodType<Step>;

export const Workflow = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  description: z.string(),
  inputs: JsonSchema,
  defaultProject: z.string().optional(),
  steps: z.array(Step).min(1),
  outputs: z.record(z.string(), Template).default({}),
  budgets: Budgets.partial().optional(),
  permissions: Permissions.optional(),
  schedule: z.object({ cron: z.string(), inputs: z.record(z.string(), z.unknown()).default({}), catchUp: z.enum(['none', 'once']).default('none') }).optional(),
});
export type Workflow = z.infer<typeof Workflow>;

export interface LoadedWorkflow { definition: Workflow; version: string; file: string }

export interface ValidationIssue { path: string; message: string }
export interface Smell { stepId: string; message: string }
export interface ValidationResult {
  /** Blocking: the workflow cannot run. */
  errors: ValidationIssue[];
  /** Advisory (D-49): shown in the Workflows screen, never blocking. */
  smells: Smell[];
  /** `dependsOn` plus every edge a template reference implies. */
  edges: Map<string, Set<string>>;
  order: string[];
}

/**
 * Every name a workflow template may start with. `runId` and `agentId` are the two an `output.document` path
 * usually wants, and they are the same names an agent's own `output.document` uses, so a path written in one
 * place reads the same in the other.
 */
const ROOTS = new Set(['inputs', 'steps', 'project', 'item', 'run', 'runId', 'agentId']);

/**
 * Everything that must hold before a workflow runs: ids unique, references resolvable, edges acyclic, and the
 * features a later run adds refused by name rather than ignored.
 */
export function validateWorkflow(workflow: Workflow): ValidationResult {
  const errors: ValidationIssue[] = [];
  const smells: Smell[] = [];
  const steps = new Map<string, Step>();
  const edges = new Map<string, Set<string>>();

  for (const [index, step] of workflow.steps.entries()) {
    if (steps.has(step.id)) errors.push({ path: `steps[${index}].id`, message: `duplicate step id "${step.id}"` });
    steps.set(step.id, step);
    edges.set(step.id, new Set(step.dependsOn));
  }

  for (const [index, step] of workflow.steps.entries()) {
    const at = `steps[${index}]`;
    checkUnsupported(step, at, errors);

    for (const dependency of step.dependsOn) {
      if (!steps.has(dependency)) errors.push({ path: `${at}.dependsOn`, message: `"${dependency}" is not a step in this workflow` });
    }
    if (step.when !== undefined) checkExpr(step.when, `${at}.when`, errors);

    // A template reference to `steps.x` implies an edge, so authors do not have to repeat themselves.
    for (const template of templatesOf(step)) {
      for (const ref of referencesIn(template)) {
        if (!ROOTS.has(ref.root)) {
          errors.push({ path: `${at}`, message: `"${ref.source}" starts with "${ref.root}", which is not one of ${[...ROOTS].join(', ')}` });
          continue;
        }
        if (ref.root !== 'steps') continue;
        const target = ref.segments[1];
        if (typeof target !== 'string' || !steps.has(target)) {
          errors.push({ path: at, message: `"${ref.source}" refers to step "${String(target)}", which does not exist` });
          continue;
        }
        if (target !== step.id) edges.get(step.id)!.add(target);
      }
    }

    if (step.kind === 'map') {
      checkExpr(step.over, `${at}.over`, errors);
      if (step.step.kind === 'map') errors.push({ path: `${at}.step`, message: 'a map may not contain another map (one level of nesting)' });
      if (step.step.dependsOn.length) errors.push({ path: `${at}.step.dependsOn`, message: 'a map\'s inner step runs per item and cannot declare dependencies' });
      checkUnsupported(step.step, `${at}.step`, errors);
    }
  }

  const order = topologicalOrder(edges, errors);
  smells.push(...detectSmells(workflow, steps, edges));
  return { errors, smells, edges, order };
}

/** Features later runs add: refused by name, so a workflow file never half-works. */
function checkUnsupported(step: Step, at: string, errors: ValidationIssue[]): void {
  if (step.kind === 'tool') {
    errors.push({ path: `${at}.kind`, message: 'tool steps arrive in RUN-06, when tools exist. Use an agent step for now.' });
  }
  if (step.review === 'blocking') {
    errors.push({ path: `${at}.review`, message: 'blocking review arrives in RUN-05. Use "none" for now; every output still appears in Review.' });
  }
}

function checkExpr(source: string, at: string, errors: ValidationIssue[]): void {
  try {
    parseExpr(source);
  } catch (e) {
    errors.push({ path: at, message: (e as Error).message });
  }
}

function templatesOf(step: Step): TemplateValue[] {
  if (step.kind === 'agent') {
    return [step.input, ...(step.model ? [step.model] : []), ...(typeof step.output?.document === 'string' ? [step.output.document] : [])];
  }
  if (step.kind === 'tool') return [step.input];
  return templatesOf(step.step);
}

function topologicalOrder(edges: Map<string, Set<string>>, errors: ValidationIssue[]): string[] {
  const order: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string, trail: string[]): void => {
    const current = state.get(id);
    if (current === 'done') return;
    if (current === 'visiting') {
      errors.push({ path: 'steps', message: `these steps depend on each other in a cycle: ${[...trail, id].join(' → ')}` });
      return;
    }
    state.set(id, 'visiting');
    for (const dependency of edges.get(id) ?? []) {
      if (edges.has(dependency)) visit(dependency, [...trail, id]);
    }
    state.set(id, 'done');
    order.push(id);
  };
  for (const id of edges.keys()) visit(id, []);
  return order;
}

/** The smells that predict failure (D-49). Warnings only: the author knows things the validator does not. */
function detectSmells(workflow: Workflow, steps: Map<string, Step>, edges: Map<string, Set<string>>): Smell[] {
  const smells: Smell[] = [];

  for (const step of workflow.steps) {
    if (step.kind !== 'agent') continue;
    const refs = referencesIn(step.input);
    if (refs.length === 0) {
      smells.push({ stepId: step.id, message: 'This step declares no inputs, so it will produce the same thing every run. Did you mean to pass it something?' });
    }
  }

  // An artifact handed through more than two agents in sequence tends to drift from the original intent.
  const depth = new Map<string, number>();
  const chainOf = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!;
    depth.set(id, 0);
    const step = steps.get(id);
    const parents = [...(edges.get(id) ?? [])].filter((p) => steps.get(p)?.kind !== 'tool');
    const longest = parents.length ? Math.max(...parents.map(chainOf)) : 0;
    const value = step && step.kind !== 'tool' ? longest + 1 : longest;
    depth.set(id, value);
    return value;
  };
  for (const step of workflow.steps) {
    if (chainOf(step.id) > 3) {
      smells.push({ stepId: step.id, message: 'This is the fourth agent in a row to touch the same work. Each hand-off drifts from the original intent; consider whether a step can be dropped or merged.' });
    }
  }

  for (const step of workflow.steps) {
    if (step.kind !== 'agent') continue;
    const looksLikeReview = /review|judge|critic|verify|check/i.test(step.id) || /review|judge|critic/i.test(step.agent);
    if (!looksLikeReview) continue;
    const hasRejectPath = workflow.steps.some((other) => other.when && other.when.includes(`steps.${step.id}`));
    if (!hasRejectPath) {
      smells.push({ stepId: step.id, message: 'This step looks like a reviewer, but nothing branches on what it decides — its verdict is recorded and then ignored. Add a `when` on a later step, or drop it.' });
    }
  }

  return smells;
}

/** A map item's step id, so its row and its events are addressable: `drafts[0]`. */
export function mapItemStepId(mapId: string, index: number): string {
  return `${mapId}[${index}]`;
}

export type { Expr };
