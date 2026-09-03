// A deliberately small JSON Schema checker for agent and step `outputSchema` (D-12).
//
// Why not a library: the schemas here are authored by the workspace owner and handed to providers that already
// enforce most of them; what this adds is the *local* check, so a provider that ignores the schema (or a model
// that returns prose) fails as `SchemaValidation` rather than flowing downstream as a string. The supported
// subset is exactly what that job needs and is listed in `UNSUPPORTED_NOTE`; anything outside it is ignored
// rather than guessed at, so a schema never silently means something other than what the provider read.
import type { JsonSchema } from './model.js';

export interface SchemaProblem { path: string; message: string }

export const UNSUPPORTED_NOTE =
  'Supported: type, properties, required, additionalProperties, items, enum, const, minimum, maximum, ' +
  'minLength, maxLength, minItems, maxItems, anyOf, oneOf, nullable. Other keywords are not checked locally.';

/** `[]` when the value conforms. Paths read like `winner`, `beats[2].who`. */
export function validateJson(value: unknown, schema: JsonSchema, path = ''): SchemaProblem[] {
  const problems: SchemaProblem[] = [];
  check(value, schema, path || '$', problems);
  return problems;
}

function check(value: unknown, schema: JsonSchema, path: string, out: SchemaProblem[]): void {
  if ('const' in schema && !deepEqual(value, schema['const'])) {
    out.push({ path, message: `must be ${JSON.stringify(schema['const'])}` });
  }
  const enumValues = schema['enum'];
  if (Array.isArray(enumValues) && !enumValues.some((e) => deepEqual(value, e))) {
    out.push({ path, message: `must be one of ${enumValues.map((e) => JSON.stringify(e)).join(', ')}` });
  }

  const branches = schema['anyOf'] ?? schema['oneOf'];
  if (Array.isArray(branches)) {
    const matched = branches.some((branch) => isSchema(branch) && validateJson(value, branch, path).length === 0);
    if (!matched) out.push({ path, message: `does not match any of the ${branches.length} allowed shapes` });
  }

  const declared = schema['type'];
  const types = typeof declared === 'string' ? [declared] : Array.isArray(declared) ? declared.filter((t): t is string => typeof t === 'string') : [];
  if (schema['nullable'] === true) types.push('null');
  if (types.length && !types.some((t) => matchesType(value, t))) {
    out.push({ path, message: `must be ${types.join(' or ')}, not ${describe(value)}` });
    return; // the type is wrong, so the keywords below would only repeat the same complaint
  }

  if (isRecord(value)) checkObject(value, schema, path, out);
  if (Array.isArray(value)) checkArray(value, schema, path, out);
  if (typeof value === 'string') {
    if (typeof schema['minLength'] === 'number' && value.length < schema['minLength']) out.push({ path, message: `must be at least ${schema['minLength']} characters` });
    if (typeof schema['maxLength'] === 'number' && value.length > schema['maxLength']) out.push({ path, message: `must be at most ${schema['maxLength']} characters` });
  }
  if (typeof value === 'number') {
    if (typeof schema['minimum'] === 'number' && value < schema['minimum']) out.push({ path, message: `must be at least ${schema['minimum']}` });
    if (typeof schema['maximum'] === 'number' && value > schema['maximum']) out.push({ path, message: `must be at most ${schema['maximum']}` });
  }
}

function checkObject(value: Record<string, unknown>, schema: JsonSchema, path: string, out: SchemaProblem[]): void {
  const properties = isRecord(schema['properties']) ? schema['properties'] : {};
  const required = Array.isArray(schema['required']) ? schema['required'].filter((r): r is string => typeof r === 'string') : [];
  for (const key of required) {
    if (!(key in value)) out.push({ path: join(path, key), message: 'is required and missing' });
  }
  for (const [key, child] of Object.entries(value)) {
    const childSchema = properties[key];
    if (isSchema(childSchema)) {
      check(child, childSchema, join(path, key), out);
    } else if (schema['additionalProperties'] === false) {
      out.push({ path: join(path, key), message: 'is not allowed by the schema' });
    } else if (isSchema(schema['additionalProperties'])) {
      check(child, schema['additionalProperties'], join(path, key), out);
    }
  }
}

function checkArray(value: unknown[], schema: JsonSchema, path: string, out: SchemaProblem[]): void {
  if (typeof schema['minItems'] === 'number' && value.length < schema['minItems']) out.push({ path, message: `must have at least ${schema['minItems']} items` });
  if (typeof schema['maxItems'] === 'number' && value.length > schema['maxItems']) out.push({ path, message: `must have at most ${schema['maxItems']} items` });
  const items = schema['items'];
  if (!isSchema(items)) return;
  for (const [index, entry] of value.entries()) check(entry, items, `${path}[${index}]`, out);
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object': return isRecord(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return true; // an unknown type keyword is not a licence to reject
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value}`;
}

function join(path: string, key: string): string {
  return path === '$' ? key : `${path}.${key}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSchema(value: unknown): value is JsonSchema {
  return isRecord(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((entry, i) => deepEqual(entry, b[i]));
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/** The text a model returned, read as JSON. Models fence JSON often enough that unwrapping it is not a hack. */
export function parseJsonOutput(text: string): { ok: true; value: unknown } | { ok: false; message: string } {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(text);
  const source = (fenced?.[1] ?? text).trim();
  if (!source) return { ok: false, message: 'the model returned nothing to parse as JSON' };
  try {
    return { ok: true, value: JSON.parse(source) };
  } catch (e) {
    return { ok: false, message: `the model's output is not valid JSON: ${(e as Error).message}` };
  }
}
