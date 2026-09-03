// The workflow expression language (workflows-and-execution.md §Expr). Deliberately tiny, and a real parser:
// paths, literals, comparisons, and/or/not, and `length`. No calls beyond `length`, no assignment, no `eval`.
// This is a security boundary as much as a convenience — a workflow file is data, and it stays data.

export type Expr =
  | { kind: 'literal'; value: unknown }
  | { kind: 'path'; segments: (string | number)[] }
  | { kind: 'not'; operand: Expr }
  | { kind: 'binary'; op: BinaryOp; left: Expr; right: Expr }
  | { kind: 'length'; operand: Expr }
  | { kind: 'array'; items: Expr[] };

export type BinaryOp = '==' | '!=' | '<' | '<=' | '>' | '>=' | 'and' | 'or';

export class ExprError extends Error {
  constructor(message: string, readonly source: string, readonly position: number) {
    super(`${message} in \`${source}\` at character ${position + 1}`);
    this.name = 'ExprError';
  }
}

type Token =
  | { type: 'name'; value: string; at: number }
  | { type: 'number'; value: number; at: number }
  | { type: 'string'; value: string; at: number }
  | { type: 'punct'; value: string; at: number }
  | { type: 'end'; at: number };

const PUNCTUATION = ['==', '!=', '<=', '>=', '<', '>', '(', ')', '[', ']', '.', ','];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i]!;
    if (/\s/.test(char)) { i++; continue; }
    if (char === '"' || char === "'") {
      const quote = char;
      let value = '';
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\' && i + 1 < source.length) { value += source[i + 1]; i += 2; continue; }
        value += source[i];
        i++;
      }
      if (i >= source.length) throw new ExprError('unterminated string', source, i);
      tokens.push({ type: 'string', value, at: i });
      i++;
      continue;
    }
    if (/[0-9]/.test(char) || (char === '-' && /[0-9]/.test(source[i + 1] ?? ''))) {
      const start = i;
      i++;
      while (i < source.length && /[0-9.]/.test(source[i]!)) i++;
      const value = Number(source.slice(start, i));
      if (Number.isNaN(value)) throw new ExprError(`"${source.slice(start, i)}" is not a number`, source, start);
      tokens.push({ type: 'number', value, at: start });
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      const start = i;
      while (i < source.length && /[A-Za-z0-9_$-]/.test(source[i]!)) i++;
      tokens.push({ type: 'name', value: source.slice(start, i), at: start });
      continue;
    }
    const punct = PUNCTUATION.find((p) => source.startsWith(p, i));
    if (!punct) throw new ExprError(`unexpected character "${char}"`, source, i);
    tokens.push({ type: 'punct', value: punct, at: i });
    i += punct.length;
  }
  tokens.push({ type: 'end', at: source.length });
  return tokens;
}

/** Recursive descent, lowest precedence first: or → and → not → comparison → primary. */
export function parseExpr(source: string): Expr {
  const tokens = tokenize(source);
  let pos = 0;
  const peek = (): Token => tokens[pos]!;
  const next = (): Token => tokens[pos++]!;
  const expectPunct = (value: string): void => {
    const token = next();
    if (token.type !== 'punct' || token.value !== value) throw new ExprError(`expected "${value}"`, source, token.at);
  };

  function parseOr(): Expr {
    let left = parseAnd();
    while (peek().type === 'name' && (peek() as { value: string }).value === 'or') {
      next();
      left = { kind: 'binary', op: 'or', left, right: parseAnd() };
    }
    return left;
  }

  function parseAnd(): Expr {
    let left = parseNot();
    while (peek().type === 'name' && (peek() as { value: string }).value === 'and') {
      next();
      left = { kind: 'binary', op: 'and', left, right: parseNot() };
    }
    return left;
  }

  function parseNot(): Expr {
    if (peek().type === 'name' && (peek() as { value: string }).value === 'not') {
      next();
      return { kind: 'not', operand: parseNot() };
    }
    return parseComparison();
  }

  function parseComparison(): Expr {
    const left = parsePrimary();
    const token = peek();
    if (token.type === 'punct' && ['==', '!=', '<', '<=', '>', '>='].includes(token.value)) {
      next();
      return { kind: 'binary', op: token.value as BinaryOp, left, right: parsePrimary() };
    }
    return left;
  }

  function parsePrimary(): Expr {
    const token = next();
    if (token.type === 'string') return { kind: 'literal', value: token.value };
    if (token.type === 'number') return { kind: 'literal', value: token.value };
    if (token.type === 'punct' && token.value === '(') {
      const inner = parseOr();
      expectPunct(')');
      return inner;
    }
    if (token.type === 'punct' && token.value === '[') {
      const items: Expr[] = [];
      if (!(peek().type === 'punct' && (peek() as { value: string }).value === ']')) {
        for (;;) {
          items.push(parseOr());
          const separator = peek();
          if (separator.type === 'punct' && separator.value === ',') { next(); continue; }
          break;
        }
      }
      expectPunct(']');
      return { kind: 'array', items };
    }
    if (token.type === 'name') {
      if (token.value === 'true') return { kind: 'literal', value: true };
      if (token.value === 'false') return { kind: 'literal', value: false };
      if (token.value === 'null') return { kind: 'literal', value: null };
      if (token.value === 'length') {
        expectPunct('(');
        const operand = parseOr();
        expectPunct(')');
        return { kind: 'length', operand };
      }
      return parsePath(token.value, token.at);
    }
    throw new ExprError('expected a value', source, token.at);
  }

  function parsePath(head: string, at: number): Expr {
    const segments: (string | number)[] = [head];
    for (;;) {
      const token = peek();
      if (token.type === 'punct' && token.value === '.') {
        next();
        const name = next();
        if (name.type !== 'name') throw new ExprError('expected a property name after "."', source, name.at);
        segments.push(name.value);
        continue;
      }
      if (token.type === 'punct' && token.value === '[') {
        next();
        const index = next();
        if (index.type === 'number') segments.push(index.value);
        else if (index.type === 'string') segments.push(index.value);
        else throw new ExprError('an index must be a number or a quoted string', source, index.at);
        expectPunct(']');
        continue;
      }
      break;
    }
    if (segments.length === 0) throw new ExprError('empty path', source, at);
    return { kind: 'path', segments };
  }

  const parsed = parseOr();
  const trailing = peek();
  if (trailing.type !== 'end') throw new ExprError('unexpected trailing input', source, trailing.at);
  return parsed;
}

export class ReferenceError_ extends Error {
  constructor(readonly path: string) {
    super(`"${path}" is not available here`);
    this.name = 'TemplateError';
  }
}

export type Scope = Record<string, unknown>;

/** JavaScript truthiness, as the spec says, so `0` and `""` are falsy. */
export function truthy(value: unknown): boolean {
  return Boolean(value);
}

export function evaluate(expr: Expr, scope: Scope): unknown {
  switch (expr.kind) {
    case 'literal':
      return expr.value;
    case 'array':
      return expr.items.map((item) => evaluate(item, scope));
    case 'not':
      return !truthy(evaluate(expr.operand, scope));
    case 'length': {
      const value = evaluate(expr.operand, scope);
      if (typeof value === 'string' || Array.isArray(value)) return value.length;
      if (value && typeof value === 'object') return Object.keys(value).length;
      return 0;
    }
    case 'binary':
      return evaluateBinary(expr, scope);
    case 'path':
      return resolvePath(expr.segments, scope);
  }
}

function evaluateBinary(expr: Extract<Expr, { kind: 'binary' }>, scope: Scope): unknown {
  // Short-circuit, so `steps.x.output and steps.x.output.title` is safe to write.
  if (expr.op === 'and') return truthy(evaluate(expr.left, scope)) ? evaluate(expr.right, scope) : evaluate(expr.left, scope);
  if (expr.op === 'or') {
    const left = evaluate(expr.left, scope);
    return truthy(left) ? left : evaluate(expr.right, scope);
  }
  const left = evaluate(expr.left, scope);
  const right = evaluate(expr.right, scope);
  switch (expr.op) {
    case '==': return deepEqual(left, right);
    case '!=': return !deepEqual(left, right);
    case '<': return compare(left, right) < 0;
    case '<=': return compare(left, right) <= 0;
    case '>': return compare(left, right) > 0;
    case '>=': return compare(left, right) >= 0;
  }
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A reference that cannot resolve is an error, not `undefined`: a silent empty prompt is worse than a failure. */
export function resolvePath(segments: (string | number)[], scope: Scope): unknown {
  let current: unknown = scope;
  const walked: (string | number)[] = [];
  for (const segment of segments) {
    walked.push(segment);
    if (current === null || current === undefined) throw new ReferenceError_(formatPath(walked));
    if (typeof current !== 'object') throw new ReferenceError_(formatPath(walked));
    const container = current as Record<string | number, unknown>;
    if (!(segment in container)) throw new ReferenceError_(formatPath(walked));
    current = container[segment];
  }
  return current;
}

export function formatPath(segments: (string | number)[]): string {
  return segments.map((s, i) => (typeof s === 'number' ? `[${s}]` : i === 0 ? s : /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s) ? `.${s}` : `[${JSON.stringify(s)}]`)).join('');
}

/** Every root a workflow expression touches, for the validator's reference check. */
export function rootsOf(expr: Expr): { root: string; segments: (string | number)[] }[] {
  switch (expr.kind) {
    case 'path':
      return [{ root: String(expr.segments[0]), segments: expr.segments }];
    case 'not':
    case 'length':
      return rootsOf(expr.operand);
    case 'binary':
      return [...rootsOf(expr.left), ...rootsOf(expr.right)];
    case 'array':
      return expr.items.flatMap(rootsOf);
    default:
      return [];
  }
}
