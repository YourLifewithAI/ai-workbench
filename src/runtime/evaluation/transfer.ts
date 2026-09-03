// Dataset export and import in a promptfoo-compatible shape (evaluation.md §Results). The mapping is free, so
// what leaves is a file anyone else's tools can read and what arrives can have come from anywhere.
//
// promptfoo's `tests` are `{ vars, assert }`. A case's input is its vars; a reference becomes an `equals`
// assertion, which is the one assertion both sides mean the same thing by.
import { z } from 'zod';
import type { CaseSummary } from '../../shared/api/index.js';
import type { Redactor } from '../security/redaction.js';

export const PromptfooAssertion = z.object({ type: z.string(), value: z.unknown().optional() });
export const PromptfooTest = z.object({
  vars: z.record(z.string(), z.unknown()).default({}),
  assert: z.array(PromptfooAssertion).default([]),
  description: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export const PromptfooFile = z.object({
  description: z.string().optional(),
  /** Ours, and ignored by anything that does not know it. */
  workbench: z.object({ dataset: z.string(), version: z.number().int() }).optional(),
  tests: z.array(PromptfooTest).default([]),
});
export type PromptfooFile = z.infer<typeof PromptfooFile>;

/** Every value is redacted on the way out: a dataset built from real runs can hold a real key (SEC-06). */
export function exportDataset(dataset: { name: string; version: number }, cases: CaseSummary[], redactor: Redactor): PromptfooFile {
  return {
    description: `${dataset.name} v${dataset.version}, exported from an AI Workbench workspace`,
    workbench: { dataset: dataset.name, version: dataset.version },
    tests: cases.map((c) => ({
      vars: redactor.redact(c.input),
      assert: c.reference === null || c.reference === undefined
        ? []
        : [{ type: 'equals', value: redactor.redact(c.reference) }],
      ...(c.metadata ? { metadata: redactor.redact(c.metadata) } : {}),
    })),
  };
}

export interface ImportedCase { input: Record<string, unknown>; reference?: unknown; metadata?: Record<string, unknown> }

/**
 * The reverse. An assertion type this workbench has no evaluator for is kept in metadata rather than dropped:
 * a person importing someone else's suite should be able to see what it asked for, even where we cannot run it.
 */
export function importDataset(file: unknown): { name: string | null; cases: ImportedCase[] } {
  const parsed = PromptfooFile.safeParse(file);
  if (!parsed.success) throw new Error(`That is not a promptfoo-shaped dataset: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const cases = parsed.data.tests.map((test): ImportedCase => {
    const equals = test.assert.find((a) => a.type === 'equals' || a.type === 'is-json');
    const others = test.assert.filter((a) => a !== equals);
    return {
      input: test.vars,
      ...(equals && equals.value !== undefined ? { reference: equals.value } : {}),
      ...(others.length || test.description
        ? { metadata: { ...(test.description ? { description: test.description } : {}), ...(others.length ? { assertions: others } : {}), ...(test.metadata ?? {}) } }
        : test.metadata ? { metadata: test.metadata } : {}),
    };
  });
  return { name: parsed.data.workbench?.dataset ?? null, cases };
}
