// Evaluators (evaluation.md §Evaluators). Four of the five are arithmetic on what a run produced; the fifth asks
// a model, and everything it says is labelled an estimate — judge agreement with ground truth on tool-using
// traces tops out around AUROC 0.65 (research.md), so a judge is evidence for a person, never a gate.
//
// There is no hallucination metric. It needs ground truth this system does not have, and a number with nothing
// behind it is worse than no number.
import { z } from 'zod';
import type { JsonSchema } from '../../shared/model.js';
import { parseJsonOutput, validateJson } from '../../shared/jsonschema.js';

export const EvaluatorKind = z.enum(['exact', 'schema', 'rule', 'grounded', 'model-judge', 'human']);
export type EvaluatorKind = z.infer<typeof EvaluatorKind>;

export const EvaluatorSpec = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exact'), id: z.string().default('exact') }),
  z.object({ kind: z.literal('schema'), id: z.string().default('schema'), schema: z.record(z.string(), z.unknown()).optional() }),
  z.object({
    kind: z.literal('rule'),
    id: z.string().default('rule'),
    contains: z.array(z.string()).default([]),
    matches: z.string().optional(),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().positive().optional(),
  }),
  z.object({ kind: z.literal('grounded'), id: z.string().default('grounded'), model: z.string().optional() }),
  z.object({ kind: z.literal('model-judge'), id: z.string().default('model-judge'), model: z.string(), rubric: z.string().min(1) }),
  z.object({ kind: z.literal('human'), id: z.string().default('human') }),
]);
export type EvaluatorSpec = z.infer<typeof EvaluatorSpec>;

export interface ScoreInput {
  output: string;
  reference?: unknown;
  outputSchema?: JsonSchema | undefined;
  /** True when the run actually used `knowledge.search`; `grounded` scores nothing otherwise. */
  usedKnowledge?: boolean | undefined;
}

export interface Score {
  evaluatorId: string;
  metric: string;
  value: number;
  rationale?: string | undefined;
  /** A judge model's opinion. The UI says the word "estimate" wherever this is true. */
  estimate: boolean;
}

/** Everything a machine can decide on its own. `model-judge`, `grounded` and `human` are decided elsewhere. */
export function scoreLocally(spec: EvaluatorSpec, input: ScoreInput): Score | null {
  if (spec.kind === 'exact') {
    if (input.reference === undefined) return { evaluatorId: spec.id, metric: 'exact', value: 0, rationale: 'the case has no reference to compare against', estimate: false };
    const wanted = typeof input.reference === 'string' ? input.reference : JSON.stringify(input.reference);
    // JSON on both sides compares as JSON: key order is not a difference a person means.
    const parsed = parseJsonOutput(input.output);
    const got = typeof input.reference === 'string' ? input.output : parsed.ok ? JSON.stringify(parsed.value) : input.output;
    const value = normalize(got) === normalize(wanted) ? 1 : 0;
    return { evaluatorId: spec.id, metric: 'exact', value, estimate: false, ...(value ? {} : { rationale: 'the output is not the reference' }) };
  }

  if (spec.kind === 'schema') {
    const schema = (spec.schema as JsonSchema | undefined) ?? input.outputSchema;
    if (!schema) return { evaluatorId: spec.id, metric: 'schema', value: 0, rationale: 'there is no schema to validate against', estimate: false };
    const parsed = parseJsonOutput(input.output);
    if (!parsed.ok) return { evaluatorId: spec.id, metric: 'schema', value: 0, rationale: parsed.message, estimate: false };
    const problems = validateJson(parsed.value, schema);
    return {
      evaluatorId: spec.id, metric: 'schema', value: problems.length ? 0 : 1, estimate: false,
      ...(problems.length ? { rationale: problems.slice(0, 3).join('; ') } : {}),
    };
  }

  if (spec.kind === 'rule') {
    const failures: string[] = [];
    for (const needle of spec.contains) {
      if (!input.output.includes(needle)) failures.push(`does not contain ${JSON.stringify(needle)}`);
    }
    if (spec.matches) {
      // The pattern comes from a person's dataset, not from a model, and it is matched against the output only.
      let pattern: RegExp | null = null;
      try {
        pattern = new RegExp(spec.matches);
      } catch {
        failures.push(`"${spec.matches}" is not a valid regular expression`);
      }
      if (pattern && !pattern.test(input.output)) failures.push(`does not match /${spec.matches}/`);
    }
    if (spec.minLength !== undefined && input.output.length < spec.minLength) failures.push(`shorter than ${spec.minLength} characters`);
    if (spec.maxLength !== undefined && input.output.length > spec.maxLength) failures.push(`longer than ${spec.maxLength} characters`);
    return {
      evaluatorId: spec.id, metric: 'rule', value: failures.length ? 0 : 1, estimate: false,
      ...(failures.length ? { rationale: failures.join('; ') } : {}),
    };
  }

  return null;
}

/** The prompt a judge is given. It is a rubric and an output, and it is asked for one number and one sentence. */
export function judgePrompt(rubric: string, output: string, reference?: unknown): string {
  return [
    'Score the output below against the rubric. Answer with JSON only: {"score": <0 to 1>, "why": "<one sentence>"}.',
    '',
    '## rubric',
    rubric,
    ...(reference !== undefined ? ['', '## the reference answer', typeof reference === 'string' ? reference : JSON.stringify(reference, null, 2)] : []),
    '',
    '## the output to score',
    output,
  ].join('\n');
}

export function parseJudgeAnswer(text: string): { value: number; rationale: string } | null {
  const parsed = parseJsonOutput(text);
  if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) return null;
  const { score, why } = parsed.value as { score?: unknown; why?: unknown };
  const value = typeof score === 'number' ? score : Number(score);
  if (!Number.isFinite(value)) return null;
  return { value: Math.min(1, Math.max(0, value)), rationale: typeof why === 'string' ? why : '' };
}

/**
 * pass^k beside the mean (D-52). A model that passes three times out of three is a different thing from one that
 * averages the same number by passing once and failing twice, and only one of them can be relied on.
 *
 * It is only meaningful for a metric that passes or fails. A judge that answers 0.8 has not failed, and printing
 * "pass^k 0%" beside it would be a number that means nothing — so a continuous metric reports `null` and the
 * table shows the mean alone.
 */
export function passAtK(values: number[], threshold = 1): { mean: number; passK: number | null; trials: number } {
  if (!values.length) return { mean: 0, passK: null, trials: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const binary = values.every((v) => v === 0 || v === 1);
  return { mean, passK: binary ? (values.every((v) => v >= threshold) ? 1 : 0) : null, trials: values.length };
}

const normalize = (text: string): string => text.trim().replace(/\s+/g, ' ');
