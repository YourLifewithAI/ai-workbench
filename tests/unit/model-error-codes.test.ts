// Turning a provider's HTTP failure into the canonical code set (D-05), which is what decides whether the
// engine retries, falls back to the next candidate, or stops.
//
// The case that made this file: a 400 whose body says the model will not take part of the request. It used to
// fall through every clause to `Unknown`, so an owner's failed run showed a bare `Unknown` badge next to
// `claude-haiku-4-5` and said nothing about why. It is not unknown — the model answered, and what it refused
// is nameable. `Unsupported` keeps the fallback behaviour (the next candidate may well accept it) and puts the
// provider's own sentence in the trace.
import { describe, it, expect } from 'vitest';
import { translateError } from '../../src/runtime/models/adapters/shared/aisdk.js';

const apiError = (statusCode: number, body: string, message = 'request failed'): unknown =>
  ({ name: 'AI_APICallError', statusCode, responseBody: body, message });

describe('provider failure → canonical code', () => {
  it('the 400 that cost a run reads as Unsupported, not Unknown', () => {
    // Verbatim shape of what Anthropic returns for a thinking mode the model is too old for.
    const err = translateError(apiError(400, JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'adaptive thinking is not supported on this model.' },
    })));
    expect(err.code).toBe('Unsupported');
    // Falls back rather than aborting: the model is there, the next candidate may accept the request.
    expect(err.action).toBe('fallback');
    // And the provider's sentence survives, because that sentence is the whole diagnosis.
    expect(err.message).toContain('adaptive thinking is not supported');
  });

  it('other 400 shapes keep the meanings they had', () => {
    const cases: [string, string][] = [
      ['prompt is too long: 300000 tokens > 200000 maximum', 'ContextLength'],
      ['Output blocked by content filtering policy', 'ContentFilter'],
    ];
    for (const [body, code] of cases) {
      expect(translateError(apiError(400, JSON.stringify({ error: { message: body } }))).code, body).toBe(code);
    }
  });

  it('a model that is not there is still ModelUnavailable, and the two are told apart', () => {
    expect(translateError(apiError(404, '{"error":{"message":"model not found"}}')).code).toBe('ModelUnavailable');
    expect(translateError(apiError(503, 'upstream unavailable')).code).toBe('ModelUnavailable');
    // Not there vs. there-and-refusing: different codes, both worth trying the next candidate.
    expect(translateError(apiError(400, '{"error":{"message":"tools are not supported"}}')).code).toBe('Unsupported');
  });

  it('the codes that stop a run and the codes that retry are unchanged', () => {
    expect(translateError(apiError(401, 'bad key')).action).toBe('abort');
    expect(translateError(apiError(429, 'slow down')).action).toBe('retry');
    expect(translateError(apiError(500, 'boom')).code).toBe('ModelUnavailable');
  });
});
