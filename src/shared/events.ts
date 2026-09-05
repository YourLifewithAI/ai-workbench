// Trace events (spec/api-and-cli.md §JSONL trace, spec/data-model.md §Event payloads).
import { z } from 'zod';

export const EVENT_TYPES = [
  'run-started', 'run-queued', 'step-started', 'step-completed', 'step-failed', 'step-skipped',
  'model-started', 'model-completed', 'model-aborted', 'fallback-selected', 'provider-meta-dropped',
  'tool-requested', 'permission-decided', 'approval-requested', 'approval-decided', 'tool-completed', 'repo-decided',
  'egress-denied', 'memory-retrieved',
  'goals-missing', 'memory-written', 'memory-redacted', 'artifact-written',
  'review-requested', 'review-decided', 'budget-warning', 'run-cancelled', 'run-completed', 'run-failed', 'run-interrupted',
] as const;
export const EventType = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventType>;

export const EventRecord = z.object({
  seq: z.number().int().nonnegative(),
  runId: z.string(),
  stepId: z.string().nullable(),
  type: EventType,
  ts: z.string(),
  schemaVersion: z.number().int().positive(),
  payload: z.record(z.string(), z.unknown()),
});
export type EventRecord = z.infer<typeof EventRecord>;

export const RunKind = z.enum(['agent', 'workflow', 'experiment']);
export type RunKind = z.infer<typeof RunKind>;
export const RunState = z.enum(['queued', 'running', 'waiting_review', 'waiting_approval', 'interrupted', 'completed', 'failed', 'cancelled']);
export type RunState = z.infer<typeof RunState>;
export const StepState = z.enum(['pending', 'running', 'skipped', 'completed', 'failed', 'cancelled']);
export type StepState = z.infer<typeof StepState>;

export const Spent = z.object({ modelCalls: z.number().int(), toolCalls: z.number().int(), costUsd: z.number(), wallClockMs: z.number().int() });
export type Spent = z.infer<typeof Spent>;
