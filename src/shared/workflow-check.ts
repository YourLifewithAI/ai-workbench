// The one verdict on a draft, shared by the editor screen and the write path (RUN-13, D-62): what the screen
// shows live while typing is exactly what the runtime refuses at save, because it is the same function.
import type { ZodError } from 'zod';
import { Workflow, validateWorkflow } from './workflow.js';
import type { WorkflowIssue } from './api/index.js';

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

/** One sentence naming every refusal, so the CLI and the screen say the same thing. */
export function describeIssues(issues: WorkflowIssue[]): string {
  const lines = issues.map((issue) => (issue.stepId ? `step "${issue.stepId}": ${issue.message}` : `${issue.path}: ${issue.message}`));
  return `This workflow would not run, so it was not saved: ${lines.join('; ')}.`;
}
