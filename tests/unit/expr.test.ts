// The expression language is a security boundary as much as a convenience: a workflow file is data, and
// nothing in it may become code. These tests pin both halves — what it can do, and what it must refuse.
import { describe, it, expect } from 'vitest';
import { evaluate, parseExpr, ExprError } from '../../src/shared/expr.js';
import { referencesIn, renderTemplate, renderTemplateString } from '../../src/shared/template.js';

const scope = {
  inputs: { premise: 'a dentist finds binary', count: 3, tags: ['sci-fi', 'noir'] },
  steps: { plan: { output: { questions: ['who', 'why'], ok: true } }, drafts: { output: ['one', 'two', 'three'] } },
  project: { documents: { 'bible.md': '# world' } },
  item: 'google/gemini-3.6-flash',
};
const run = (source: string) => evaluate(parseExpr(source), scope);

describe('Expr', () => {
  it('resolves paths, indexes and quoted keys', () => {
    expect(run('inputs.premise')).toBe('a dentist finds binary');
    expect(run('steps.plan.output.questions')).toEqual(['who', 'why']);
    expect(run('steps.drafts.output[0]')).toBe('one');
    expect(run('project.documents["bible.md"]')).toBe('# world');
    expect(run('item')).toBe('google/gemini-3.6-flash');
  });

  it('reads literals, arrays, comparisons and boolean logic', () => {
    expect(run('42')).toBe(42);
    expect(run('"text"')).toBe('text');
    expect(run('true')).toBe(true);
    expect(run('null')).toBeNull();
    expect(run('["a", "b"]')).toEqual(['a', 'b']);
    expect(run('inputs.count > 2')).toBe(true);
    expect(run('inputs.count >= 4')).toBe(false);
    expect(run('inputs.premise == "a dentist finds binary"')).toBe(true);
    expect(run('inputs.count != 3')).toBe(false);
    expect(run('not steps.plan.output.ok')).toBe(false);
    expect(run('inputs.count > 2 and steps.plan.output.ok')).toBe(true);
    expect(run('inputs.count > 5 or steps.plan.output.ok')).toBe(true);
    expect(run('length(inputs.premise) > 10')).toBe(true);
    expect(run('length(inputs.tags)')).toBe(2);
    expect(run('length(steps.plan.output)')).toBe(2);
  });

  it('short-circuits `and`, so a guarded path is safe to write', () => {
    expect(() => run('steps.missing.output')).toThrow(/not available/);
    expect(run('false and steps.missing.output')).toBe(false);
  });

  it('names the reference that could not resolve', () => {
    expect(() => run('steps.plan.output.nope')).toThrow('"steps.plan.output.nope" is not available here');
    expect(() => run('inputs.premise.deeper')).toThrow(/inputs\.premise\.deeper/);
  });

  it('refuses anything that is not this small language', () => {
    for (const source of [
      'process.exit(1)',                       // resolves nothing: `process` is not a root
      'constructor.constructor("return 1")()',
      'inputs.premise; drop table',
      'inputs.premise = "x"',
      'require("fs")',
      '1 + 1',
      '`${x}`',
    ]) {
      expect(() => run(source), source).toThrow();
    }
  });

  it('rejects malformed expressions with the position', () => {
    expect(() => parseExpr('inputs.')).toThrow(ExprError);
    expect(() => parseExpr('length(')).toThrow(ExprError);
    expect(() => parseExpr('"unterminated')).toThrow(/unterminated string/);
    expect(() => parseExpr('inputs.a inputs.b')).toThrow(/trailing input/);
  });
});

describe('Template', () => {
  it('passes a whole-string placeholder through with its type', () => {
    expect(renderTemplateString('{{ steps.plan.output.questions }}', scope)).toEqual(['who', 'why']);
    expect(renderTemplateString('{{inputs.count}}', scope)).toBe(3);
  });

  it('interpolates anything else as text, objects as JSON', () => {
    expect(renderTemplateString('Premise: {{inputs.premise}}', scope)).toBe('Premise: a dentist finds binary');
    expect(renderTemplateString('{{inputs.count}} of {{length(inputs.tags)}}', scope)).toBe('3 of 2');
    expect(renderTemplateString('tags: {{inputs.tags}}', scope)).toContain('"sci-fi"');
  });

  it('treats a backslash-escaped brace pair as a literal', () => {
    expect(renderTemplateString('literally \\{{not a hole}}', scope)).toBe('literally {{not a hole}}');
  });

  it('renders nested structures leaf by leaf', () => {
    expect(renderTemplate({ title: 'Draft of {{inputs.premise}}', drafts: ['{{steps.drafts.output}}'] }, scope))
      .toEqual({ title: 'Draft of a dentist finds binary', drafts: [['one', 'two', 'three']] });
  });

  it('reports every reference for the validator', () => {
    const refs = referencesIn({ a: '{{steps.plan.output}} and {{inputs.premise}}', b: ['{{item}}'] });
    expect(refs.map((r) => r.root).sort()).toEqual(['inputs', 'item', 'steps']);
  });
});
