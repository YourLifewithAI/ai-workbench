// The summary layer (D-58): what happened, what it cost, what needs you — at most three lines, above the raw
// timeline. Shared so the UI and the CLI say the same thing, and pure so it can be tested without a runtime.
import type { EventRecord } from './events.js';
import type { RunDetail, StepSummary } from './api/index.js';

export interface Summary { headline: string; lines: string[]; tone: 'good' | 'bad' | 'busy' | 'neutral' }

interface ModelCallFacts { modelId: string; usage: { input: number; output: number; reasoning?: number }; costUsd: number; latencyMs: number }

export function modelCalls(events: EventRecord[], stepId?: string): ModelCallFacts[] {
  return events
    .filter((e) => e.type === 'model-completed' && (stepId === undefined || e.stepId === stepId))
    .map((e) => ({
      modelId: String(e.payload['modelId'] ?? 'unknown'),
      usage: (e.payload['usage'] ?? { input: 0, output: 0 }) as ModelCallFacts['usage'],
      costUsd: Number(e.payload['costUsd'] ?? 0),
      latencyMs: Number(e.payload['latencyMs'] ?? 0),
    }));
}

/** `displayName` is the agent's or workflow's human name when the caller has it; the id reads badly in a sentence. */
export function summarizeRun(run: RunDetail, events: EventRecord[], displayName?: string): Summary {
  const calls = modelCalls(events);
  const models = [...new Set(calls.map((c) => c.modelId))];
  const fallbacks = events.filter((e) => e.type === 'fallback-selected').length;
  const who = displayName ?? run.agentId ?? run.workflowId ?? run.kind;

  const lines: string[] = [];
  lines.push(whatHappened(run, who, models, events));
  lines.push(whatItCost(run, calls));
  const needs = whatNeedsYou(run, fallbacks);
  if (needs) lines.push(needs);

  return { headline: headlineFor(run, who), lines, tone: toneFor(run.state) };
}

export function summarizeStep(step: StepSummary, events: EventRecord[]): Summary {
  const calls = modelCalls(events, step.stepId);
  const failure = events.find((e) => e.type === 'step-failed' && e.stepId === step.stepId);
  const output = events.find((e) => e.type === 'step-completed' && e.stepId === step.stepId)?.payload['output'];

  const lines: string[] = [];
  if (failure) {
    lines.push(errorSentence(failure.payload['error']));
  } else if (typeof output === 'string') {
    lines.push(`Produced ${words(output)} ${words(output) === 1 ? 'word' : 'words'}${step.modelId ? ` on ${step.modelId}` : ''}.`);
  } else {
    lines.push(step.state === 'running' ? 'Running.' : `${capitalize(step.state)}.`);
  }
  if (calls.length) lines.push(callLine(calls));
  const aborted = events.filter((e) => e.type === 'model-aborted' && e.stepId === step.stepId);
  if (aborted.length) lines.push(`${aborted.length} model call${aborted.length === 1 ? '' : 's'} aborted before this one succeeded.`);

  return { headline: `Step ${step.stepId}`, lines, tone: toneFor(step.state) };
}

function headlineFor(run: RunDetail, who: string): string {
  switch (run.state) {
    case 'completed': return `${who} finished.`;
    case 'failed': return `${who} failed.`;
    case 'running': return `${who} is running.`;
    case 'cancelled': return `${who} was cancelled.`;
    case 'waiting_review': return `${who} is waiting for your review.`;
    case 'waiting_approval': return `${who} is waiting for your approval.`;
    default: return `${who} is ${run.state.replace('_', ' ')}.`;
  }
}

function whatHappened(run: RunDetail, who: string, models: string[], events: EventRecord[]): string {
  const failure = events.find((e) => e.type === 'run-failed');
  if (failure) return errorSentence((failure.payload['error'] ?? failure.payload['reason']));
  const output = run.outputs?.['output'];
  const on = models.length ? ` on ${models.join(' then ')}` : '';
  if (typeof output === 'string') return `${who} produced ${words(output)} ${words(output) === 1 ? 'word' : 'words'}${on}.`;
  if (run.state === 'running') return `${who} is working${on}.`;
  return `${who} produced no text output${on}.`;
}

function whatItCost(run: RunDetail, calls: ModelCallFacts[]): string {
  if (!calls.length) return `No model calls yet · ${seconds(run.spent.wallClockMs)}.`;
  return `${callLine(calls)} · ${seconds(run.spent.wallClockMs)}.`;
}

function callLine(calls: ModelCallFacts[]): string {
  const input = calls.reduce((n, c) => n + (c.usage.input || 0), 0);
  const output = calls.reduce((n, c) => n + (c.usage.output || 0), 0);
  const cost = calls.reduce((n, c) => n + c.costUsd, 0);
  const count = `${calls.length} model call${calls.length === 1 ? '' : 's'}`;
  return `${count} · ${input.toLocaleString()} in / ${output.toLocaleString()} out tokens · ${money(cost)}`;
}

function whatNeedsYou(run: RunDetail, fallbacks: number): string | null {
  if (run.state === 'waiting_review') return 'Needs you: rate or edit the output in Review.';
  if (run.state === 'waiting_approval') return 'Needs you: a step is asking permission.';
  if (run.state === 'failed') return 'Needs you: read the failing step below, then re-run when you have fixed the cause.';
  if (fallbacks) return `${fallbacks} model fallback${fallbacks === 1 ? '' : 's'} happened; the timeline says why.`;
  return null;
}

/** Costs are stored, never recomputed (D-08); sub-cent amounts still need to be legible. */
export function money(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function seconds(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function words(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** Errors read as one sentence: what happened, and (when the code implies it) what to do (ui.md §Errors). */
export function errorSentence(error: unknown): string {
  if (typeof error === 'string') return capitalize(error.replace(/_/g, ' ')) + '.';
  const e = error as { message?: string; code?: string; reason?: string } | undefined;
  if (e?.message) return e.message.endsWith('.') ? e.message : `${e.message}.`;
  if (e?.code) return `The model call failed with ${e.code}.`;
  if (e?.reason) return capitalize(e.reason.replace(/_/g, ' ')) + '.';
  return 'It failed without saying why; the timeline below has the raw payload.';
}

function toneFor(state: string): Summary['tone'] {
  if (state === 'completed') return 'good';
  if (state === 'failed' || state === 'cancelled' || state === 'interrupted') return 'bad';
  if (state === 'running' || state === 'queued' || state.startsWith('waiting')) return 'busy';
  return 'neutral';
}

function capitalize(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s;
}
