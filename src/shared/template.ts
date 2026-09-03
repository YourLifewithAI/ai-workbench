// Templates (workflows-and-execution.md §Template): a string with `{{ … }}` holes, or a JSON structure whose
// string leaves are such strings. One whole-string placeholder passes its value through with its type; anything
// else interpolates as text. `\{{` is a literal brace pair.
import { evaluate, parseExpr, rootsOf, type Expr, type Scope } from './expr.js';

export type TemplateValue = string | number | boolean | null | TemplateValue[] | { [key: string]: TemplateValue };

interface Hole { expr: Expr; source: string }
type Part = { literal: string } | { hole: Hole };

const PLACEHOLDER = /\\?\{\{([\s\S]*?)\}\}/g;

/** Splits a string into literals and holes. An escaped `\{{` becomes a literal `{{`. */
export function parseTemplateString(input: string): Part[] {
  const parts: Part[] = [];
  let last = 0;
  for (const match of input.matchAll(PLACEHOLDER)) {
    const at = match.index;
    if (at > last) parts.push({ literal: input.slice(last, at) });
    if (match[0].startsWith('\\')) {
      parts.push({ literal: match[0].slice(1) });
    } else {
      const source = match[1]!.trim();
      parts.push({ hole: { expr: parseExpr(source), source } });
    }
    last = at + match[0].length;
  }
  if (last < input.length) parts.push({ literal: input.slice(last) });
  return parts;
}

export function renderTemplateString(input: string, scope: Scope): unknown {
  const parts = parseTemplateString(input);
  const only = parts.length === 1 ? parts[0] : null;
  // Exactly one placeholder and nothing else: pass the value through with its type.
  if (only && 'hole' in only) return evaluate(only.hole.expr, scope);
  return parts.map((part) => ('literal' in part ? part.literal : asText(evaluate(part.hole.expr, scope)))).join('');
}

export function renderTemplate(template: TemplateValue, scope: Scope): unknown {
  if (typeof template === 'string') return renderTemplateString(template, scope);
  if (Array.isArray(template)) return template.map((item) => renderTemplate(item, scope));
  if (template && typeof template === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(template)) out[key] = renderTemplate(value, scope);
    return out;
  }
  return template;
}

/** Objects and arrays interpolate as JSON, so a template never renders `[object Object]`. */
function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

/** Every reference in a template, so the validator can add implied edges and reject unknown names. */
export function referencesIn(template: TemplateValue): { root: string; segments: (string | number)[]; source: string }[] {
  if (typeof template === 'string') {
    return parseTemplateString(template).flatMap((part) =>
      'hole' in part ? rootsOf(part.hole.expr).map((r) => ({ ...r, source: part.hole.source })) : [],
    );
  }
  if (Array.isArray(template)) return template.flatMap(referencesIn);
  if (template && typeof template === 'object') return Object.values(template).flatMap(referencesIn);
  return [];
}
