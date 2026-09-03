// The workflow schema, its validator, templates, and the small JSON Schema checker (spec/workflows-and-execution.md).
import { describe, it, expect } from 'vitest';
import { Workflow, validateWorkflow, mapItemStepId } from '../../src/shared/workflow.js';
import { renderTemplate, renderTemplateString, referencesIn } from '../../src/shared/template.js';
import { validateJson, parseJsonOutput, applyDefaults } from '../../src/shared/jsonschema.js';
import { RunBudget, narrowBudgets, WRAP_UP_INSTRUCTION } from '../../src/runtime/engine/budget.js';
import type { Budgets } from '../../src/shared/permissions.js';

const base = {
  schemaVersion: 1 as const,
  id: 'w',
  name: 'W',
  description: 'a workflow',
  inputs: { type: 'object', properties: { topic: { type: 'string' } } },
  outputs: {},
};

const parse = (steps: unknown[], extra: Record<string, unknown> = {}) => Workflow.parse({ ...base, ...extra, steps });

describe('the validator', () => {
  it('adds the edge a template reference implies, so authors need not repeat dependsOn', () => {
    const wf = parse([
      { id: 'plan', kind: 'agent', agent: 'architect', input: '{{inputs.topic}}' },
      { id: 'write', kind: 'agent', agent: 'weaver', input: 'From: {{steps.plan.output}}' },
    ]);
    const result = validateWorkflow(wf);
    expect(result.errors).toEqual([]);
    expect([...result.edges.get('write')!]).toEqual(['plan']);
    expect(result.order).toEqual(['plan', 'write']);
  });

  it('names a cycle by the steps in it rather than hanging or overflowing', () => {
    const wf = parse([
      { id: 'a', kind: 'agent', agent: 'x', input: '{{steps.b.output}}' },
      { id: 'b', kind: 'agent', agent: 'x', input: '{{steps.a.output}}' },
    ]);
    const errors = validateWorkflow(wf).errors.map((e) => e.message);
    expect(errors.some((m) => m.includes('cycle') && m.includes('a') && m.includes('b'))).toBe(true);
  });

  it('rejects references to steps and roots that do not exist', () => {
    const wf = parse([
      { id: 'a', kind: 'agent', agent: 'x', input: '{{steps.ghost.output}} {{nonsense.thing}}' },
    ]);
    const messages = validateWorkflow(wf).errors.map((e) => e.message);
    expect(messages.some((m) => m.includes('"ghost"'))).toBe(true);
    expect(messages.some((m) => m.includes('nonsense'))).toBe(true);
  });

  it('refuses the features later runs add, naming the run that adds each', () => {
    const wf = parse([{ id: 'a', kind: 'tool', tool: 'web.search', input: '{{inputs.topic}}' }]);
    const messages = validateWorkflow(wf).errors.map((e) => e.message);
    expect(messages.some((m) => m.includes('RUN-06'))).toBe(true);
  });

  it('accepts a blocking review gate, which RUN-05 implements', () => {
    const wf = parse([{ id: 'b', kind: 'agent', agent: 'x', input: '{{inputs.topic}}', review: 'blocking' }]);
    expect(validateWorkflow(wf).errors).toEqual([]);
  });

  it('allows one level of map nesting and no more', () => {
    const inner = { id: 'one', kind: 'agent', agent: 'x', input: '{{item}}' };
    const ok = parse([{ id: 'many', kind: 'map', over: 'inputs.topic', step: inner }]);
    expect(validateWorkflow(ok).errors).toEqual([]);

    const nested = parse([{ id: 'many', kind: 'map', over: 'inputs.topic', step: { id: 'inner', kind: 'map', over: 'item', step: inner } }]);
    expect(validateWorkflow(nested).errors.map((e) => e.message).some((m) => m.includes('one level of nesting'))).toBe(true);
  });

  it('names a map item step so its row and its events are addressable', () => {
    expect(mapItemStepId('drafts', 2)).toBe('drafts[2]');
  });
});

describe('the smells (D-49) warn without blocking', () => {
  it('flags a step with no declared inputs', () => {
    const wf = parse([{ id: 'a', kind: 'agent', agent: 'x', input: 'Write something nice.' }]);
    const result = validateWorkflow(wf);
    expect(result.errors).toEqual([]);
    expect(result.smells.map((s) => s.message).some((m) => m.includes('no inputs'))).toBe(true);
  });

  it('flags a reviewer whose verdict nothing branches on', () => {
    const wf = parse([
      { id: 'draft', kind: 'agent', agent: 'weaver', input: '{{inputs.topic}}' },
      { id: 'review', kind: 'agent', agent: 'judge', input: '{{steps.draft.output}}' },
    ]);
    const result = validateWorkflow(wf);
    expect(result.errors).toEqual([]);
    expect(result.smells.some((s) => s.stepId === 'review' && s.message.includes('nothing branches'))).toBe(true);
  });

  it('stays quiet when the reviewer has a reject path', () => {
    const wf = parse([
      { id: 'draft', kind: 'agent', agent: 'weaver', input: '{{inputs.topic}}' },
      { id: 'review', kind: 'agent', agent: 'judge', input: '{{steps.draft.output}}' },
      { id: 'redo', kind: 'agent', agent: 'weaver', when: 'steps.review.output.ok == false', input: '{{steps.draft.output}}' },
    ]);
    expect(validateWorkflow(wf).smells.some((s) => s.stepId === 'review')).toBe(false);
  });

  it('flags the fourth agent in a row to touch the same work', () => {
    const chain = ['a', 'b', 'c', 'd'].map((id, i) => ({
      id, kind: 'agent' as const, agent: 'x',
      input: i === 0 ? '{{inputs.topic}}' : `{{steps.${['a', 'b', 'c'][i - 1]!}.output}}`,
    }));
    const result = validateWorkflow(parse(chain));
    expect(result.errors).toEqual([]);
    expect(result.smells.some((s) => s.stepId === 'd' && s.message.includes('fourth agent'))).toBe(true);
  });
});

describe('templates', () => {
  const scope = { inputs: { topic: 'tooth', list: [1, 2, 3] }, steps: { a: { output: { winner: 1 } } } };

  it('passes a whole-string placeholder through with its type', () => {
    expect(renderTemplateString('{{inputs.list}}', scope)).toEqual([1, 2, 3]);
    expect(renderTemplateString('{{steps.a.output}}', scope)).toEqual({ winner: 1 });
  });

  it('interpolates anything else as text, with objects as JSON', () => {
    expect(renderTemplateString('about {{inputs.topic}}', scope)).toBe('about tooth');
    expect(String(renderTemplateString('picked {{steps.a.output}}', scope))).toContain('"winner": 1');
  });

  it('treats a backslash-escaped brace as a literal', () => {
    expect(renderTemplateString('literal \\{{inputs.topic}}', scope)).toBe('literal {{inputs.topic}}');
  });

  it('walks into objects and arrays', () => {
    expect(renderTemplate({ a: ['{{inputs.topic}}', 2], b: { c: '{{inputs.list}}' } }, scope)).toEqual({ a: ['tooth', 2], b: { c: [1, 2, 3] } });
  });

  it('reports every reference it holds, for the validator', () => {
    expect(referencesIn({ x: 'a {{inputs.topic}} b {{steps.a.output}}' }).map((r) => r.root)).toEqual(['inputs', 'steps']);
  });
});

describe('the JSON Schema subset', () => {
  const schema = {
    type: 'object',
    properties: { winner: { type: 'integer', minimum: 0 }, rationale: { type: 'string', minLength: 1 } },
    required: ['winner', 'rationale'],
    additionalProperties: false,
  };

  it('accepts a conforming object', () => {
    expect(validateJson({ winner: 0, rationale: 'because' }, schema)).toEqual([]);
  });

  it('names the field and what is wrong with it', () => {
    const problems = validateJson({ winner: 'first', extra: 1 }, schema);
    expect(problems.map((p) => `${p.path} ${p.message}`)).toEqual(expect.arrayContaining([
      expect.stringContaining('winner must be integer'),
      expect.stringContaining('rationale is required'),
      expect.stringContaining('extra is not allowed'),
    ]));
  });

  it('unwraps a fenced JSON reply, which models produce often enough to expect', () => {
    const parsed = parseJsonOutput('```json\n{"winner": 1}\n```');
    expect(parsed).toEqual({ ok: true, value: { winner: 1 } });
    expect(parseJsonOutput('not json at all').ok).toBe(false);
  });

  it('fills in top-level defaults the caller left out', () => {
    expect(applyDefaults({ a: 1 }, { properties: { a: { default: 9 }, b: { default: 2 } } })).toEqual({ a: 1, b: 2 });
  });
});

describe('budgets (D-14)', () => {
  const limits: Budgets = { maxModelCalls: 6, maxToolCalls: 10, maxCostUsd: 1, maxWallClockMs: 60_000, toolCallTimeoutMs: 1000, dailySpendCapUsd: 100 };

  it('holds one call back so a bounded run can still say what it produced', () => {
    const budget = new RunBudget(limits, Date.now(), () => 0);
    for (let i = 0; i < 5; i++) { expect(budget.checkBeforeModelCall(), `call ${i + 1} of 6 is still productive`).toBeNull(); budget.recordModelCall(0); }
    const stop = budget.checkBeforeModelCall();
    expect(stop?.budget).toBe('maxModelCalls');
    expect(stop?.allowWrapUp).toBe(true);
    expect(budget.takeWrapUp()).toBe(true);
    expect(budget.takeWrapUp(), 'one wrap-up per run, not one per step').toBe(false);
    expect(WRAP_UP_INSTRUCTION).toContain('last turn');
  });

  it('warns once per budget at 80%, never again', () => {
    const budget = new RunBudget(limits, Date.now(), () => 0);
    for (let i = 0; i < 5; i++) budget.recordModelCall(0);
    expect(budget.newWarnings().map((w) => w.budget)).toEqual(['maxModelCalls']);
    budget.recordModelCall(0);
    expect(budget.newWarnings()).toEqual([]);
  });

  it('treats the wall clock and the daily cap as hard stops with no wrap-up', () => {
    const expired = new RunBudget(limits, Date.now() - 120_000, () => 0);
    expect(expired.checkBeforeModelCall()).toMatchObject({ reason: 'wall_clock_exceeded', allowWrapUp: false });
    const capped = new RunBudget(limits, Date.now(), () => 1000);
    expect(capped.checkBeforeModelCall()).toMatchObject({ reason: 'daily_cap_reached', allowWrapUp: false });
  });

  it('narrows and never widens', () => {
    expect(narrowBudgets(limits, { maxModelCalls: 2, maxCostUsd: 99 })).toMatchObject({ maxModelCalls: 2, maxCostUsd: 1 });
  });

  it('counts a step budget in the run budget too, so a step cannot escape the run', () => {
    const run = new RunBudget(limits, Date.now(), () => 0);
    const step = run.child({ maxModelCalls: 2 });
    step.recordModelCall(0.5);
    expect(run.spent.modelCalls).toBe(1);
    expect(run.spent.costUsd).toBe(0.5);
    expect(step.checkBeforeModelCall()?.budget).toBe('maxModelCalls');
  });
});
