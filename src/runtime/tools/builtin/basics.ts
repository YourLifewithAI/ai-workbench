// The tools that cannot hurt anything (RUN-06 scope). They ship first on purpose: the permission machinery is
// exercised in full before it guards anything that could do damage.
import { z } from 'zod';
import { Permissions } from '../../../shared/permissions.js';
import { toolError, type ToolDefinition } from '../../../shared/tool.js';

const NO_PERMISSIONS = Permissions.parse({});

/**
 * Arithmetic on a small, explicit grammar. There is no `eval` here for the same reason there is none in the
 * workflow expression language: a calculator that can call `require` is not a calculator.
 */
export const calc: ToolDefinition<{ expression: string }, { value: number; expression: string }> = {
  id: 'calc',
  version: '1.0.0',
  description: 'Evaluate an arithmetic expression. Supports + - * / % ^, parentheses, and the functions abs, min, max, round, floor, ceil, sqrt.',
  input: z.object({ expression: z.string().min(1).max(500).describe('e.g. "(1200 * 0.15) + 40"') }),
  output: z.object({ value: z.number(), expression: z.string() }),
  tier: 'read',
  maxPermissions: NO_PERMISSIONS,
  execute: async ({ expression }) => {
    try {
      return { ok: true, output: { value: evaluateArithmetic(expression), expression } };
    } catch (e) {
      return toolError('InvalidInput', (e as Error).message, 'Use numbers, + - * / % ^, parentheses, and abs/min/max/round/floor/ceil/sqrt.');
    }
  },
};

export const datetime: ToolDefinition<{ format?: 'iso' | 'date' | 'time' | undefined; timeZone?: string | undefined }, { now: string; timeZone: string; weekday: string }> = {
  id: 'datetime',
  version: '1.0.0',
  description: 'The current date and time. An agent has no clock of its own; its training data ends somewhere in the past.',
  input: z.object({
    format: z.enum(['iso', 'date', 'time']).default('iso'),
    timeZone: z.string().optional().describe('An IANA zone such as "America/New_York". Defaults to this machine\'s.'),
  }),
  output: z.object({ now: z.string(), timeZone: z.string(), weekday: z.string() }),
  tier: 'read',
  maxPermissions: NO_PERMISSIONS,
  execute: async ({ format = 'iso', timeZone }) => {
    const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const at = new Date();
    try {
      const now = format === 'iso'
        ? at.toISOString()
        : new Intl.DateTimeFormat('en-CA', format === 'date' ? { timeZone: zone, dateStyle: 'short' } : { timeZone: zone, timeStyle: 'medium' }).format(at);
      const weekday = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'long' }).format(at);
      return { ok: true, output: { now, timeZone: zone, weekday } };
    } catch {
      return toolError('InvalidInput', `"${zone}" is not a time zone this machine knows.`, 'Use an IANA name like "Europe/London".');
    }
  },
};

export const json: ToolDefinition<{ text: string; path?: string | undefined }, { value: unknown }> = {
  id: 'json',
  version: '1.0.0',
  description: 'Parse JSON text, optionally reading one path out of it (dotted, e.g. "results.0.title"). Use it rather than reasoning about brackets.',
  input: z.object({
    text: z.string().max(200_000),
    path: z.string().optional().describe('Dotted path into the parsed value; omit for the whole thing.'),
  }),
  output: z.object({ value: z.unknown() }),
  tier: 'read',
  maxPermissions: NO_PERMISSIONS,
  execute: async ({ text, path: dotted }) => {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (e) {
      return toolError('InvalidInput', `That is not valid JSON: ${(e as Error).message}`);
    }
    if (!dotted) return { ok: true, output: { value } };
    let cursor: unknown = value;
    for (const segment of dotted.split('.')) {
      if (cursor === null || typeof cursor !== 'object') return toolError('NotFound', `"${dotted}" stops at "${segment}": there is nothing there.`);
      cursor = (cursor as Record<string, unknown>)[segment];
      if (cursor === undefined) return toolError('NotFound', `"${dotted}" stops at "${segment}": there is nothing there.`);
    }
    return { ok: true, output: { value: cursor } };
  },
};

// ---- the arithmetic grammar ------------------------------------------------------------------------------

type Token = { kind: 'number'; value: number } | { kind: 'op'; value: string } | { kind: 'name'; value: string };

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  abs: Math.abs, sqrt: Math.sqrt, round: Math.round, floor: Math.floor, ceil: Math.ceil,
  min: (...a) => Math.min(...a), max: (...a) => Math.max(...a),
};

export function evaluateArithmetic(source: string): number {
  const tokens = tokenize(source);
  let at = 0;
  const peek = (): Token | undefined => tokens[at];
  const eat = (value: string): boolean => {
    const token = peek();
    if (token && token.kind === 'op' && token.value === value) { at += 1; return true; }
    return false;
  };

  const primary = (): number => {
    const token = peek();
    if (!token) throw new Error('The expression ends where a number should be.');
    if (token.kind === 'number') { at += 1; return token.value; }
    if (token.kind === 'op' && token.value === '-') { at += 1; return -primary(); }
    if (token.kind === 'op' && token.value === '+') { at += 1; return primary(); }
    if (token.kind === 'op' && token.value === '(') {
      at += 1;
      const value = expression();
      if (!eat(')')) throw new Error('A "(" is never closed.');
      return value;
    }
    if (token.kind === 'name') {
      const fn = FUNCTIONS[token.value];
      if (!fn) throw new Error(`"${token.value}" is not a function this calculator has.`);
      at += 1;
      if (!eat('(')) throw new Error(`"${token.value}" needs parentheses: ${token.value}(…).`);
      const args: number[] = [expression()];
      while (eat(',')) args.push(expression());
      if (!eat(')')) throw new Error(`"${token.value}(" is never closed.`);
      return fn(...args);
    }
    throw new Error(`"${token.value}" cannot start a value.`);
  };

  // Right-associative, so 2^3^2 is 512 rather than 64.
  const power = (): number => {
    const base = primary();
    return eat('^') ? base ** power() : base;
  };

  const term = (): number => {
    let value = power();
    for (;;) {
      if (eat('*')) value *= power();
      else if (eat('/')) { const d = power(); if (d === 0) throw new Error('Division by zero.'); value /= d; }
      else if (eat('%')) { const d = power(); if (d === 0) throw new Error('Division by zero.'); value %= d; }
      else return value;
    }
  };

  const expression = (): number => {
    let value = term();
    for (;;) {
      if (eat('+')) value += term();
      else if (eat('-')) value -= term();
      else return value;
    }
  };

  const result = expression();
  if (at !== tokens.length) throw new Error(`Unexpected "${String((peek() as Token).value)}" after the expression.`);
  if (!Number.isFinite(result)) throw new Error('That does not come out to a finite number.');
  return result;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (/\s/.test(c)) { i += 1; continue; }
    if (/[0-9.]/.test(c)) {
      const match = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?/.exec(source.slice(i));
      if (!match) throw new Error(`"${source.slice(i, i + 8)}" is not a number.`);
      tokens.push({ kind: 'number', value: Number(match[0]) });
      i += match[0].length;
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      const match = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(source.slice(i))!;
      tokens.push({ kind: 'name', value: match[0].toLowerCase() });
      i += match[0].length;
      continue;
    }
    if ('+-*/%^(),'.includes(c)) { tokens.push({ kind: 'op', value: c }); i += 1; continue; }
    throw new Error(`"${c}" is not something this calculator understands.`);
  }
  if (!tokens.length) throw new Error('There is nothing to calculate.');
  return tokens;
}
