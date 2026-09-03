import { describe, it, expect } from 'vitest';
import { Redactor } from '../../src/runtime/security/redaction.js';
import { contentHash, canonicalize } from '../../src/runtime/util/canonical.js';

describe('redaction (D-33)', () => {
  it('replaces registered values in strings, arrays, and nested objects', () => {
    const r = new Redactor();
    r.register('credential:google', 'sk-planted-1234567890');
    expect(r.redactString('key=sk-planted-1234567890 ok')).toBe('key=[REDACTED:credential:google] ok');
    expect(r.redact({ a: ['sk-planted-1234567890'], b: { c: 'x sk-planted-1234567890' }, n: 1 })).toEqual({ a: ['[REDACTED:credential:google]'], b: { c: 'x [REDACTED:credential:google]' }, n: 1 });
    expect(r.redactJson({ v: 'sk-planted-1234567890' })).toBe('{"v":"[REDACTED:credential:google]"}');
  });

  it('ignores values too short to redact safely', () => {
    const r = new Redactor();
    r.register('short', 'abc');
    expect(r.redactString('abc def')).toBe('abc def');
    expect(r.names()).toEqual([]);
  });
});

describe('canonical hashing (D-10)', () => {
  it('is independent of key order', () => {
    expect(canonicalize({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(canonicalize({ a: [{ c: 3, d: 2 }], b: 1 }));
    expect(contentHash({ x: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(contentHash({ x: 1 })).not.toBe(contentHash({ x: 2 }));
  });
});
