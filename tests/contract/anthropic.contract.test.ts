// The Anthropic adapter against the shared suite, replaying recorded HTTP so CI needs no key.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModelsFile } from '../../src/shared/model.js';
import { packagePaths } from '../../src/runtime/paths.js';
import { readJsonFile } from '../../src/runtime/workspace/config.js';
import { findModel } from '../../src/runtime/models/catalog.js';
import { AnthropicAdapter } from '../../src/runtime/models/adapters/anthropic/index.js';
import { directFetch } from '../../src/runtime/models/fetch.js';
import { liveAdapters, liveCredential } from './live.js';
import { readExchanges, recordingFetch, replayFetch } from './recorder.js';
import { runContractSuite, runErrorMappingSuite } from './suite.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'anthropic');
const catalog = ModelsFile.parse(readJsonFile(path.join(packagePaths().defaults, 'models.json')));
const model = findModel(catalog, 'anthropic/claude-haiku-4-5')!;

const live = liveAdapters().includes('anthropic');
const key = liveCredential('anthropic');

runContractSuite('anthropic', () => ({
  adapter: new AnthropicAdapter(),
  model,
  apiKey: live ? key : 'replayed-fixture-key-not-a-secret',
  fetch: (name) => (live ? recordingFetch(fixtures, name, directFetch) : replayFetch(fixtures, name)),
  skip: (name) => {
    if (live) return key ? null : 'no credential named "anthropic" (set WORKBENCH_CRED_ANTHROPIC)';
    return readExchanges(fixtures, name) ? null : 'no recorded exchange; record with: npm run contract -- --live anthropic';
  },
}));

runErrorMappingSuite('anthropic', () => ({ adapter: new AnthropicAdapter(), model, apiKey: 'replayed-fixture-key-not-a-secret' }), [
  { status: 401, body: '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', code: 'Authentication', action: 'abort' },
  { status: 429, body: '{"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your rate limit."}}', code: 'RateLimit', action: 'retry' },
  { status: 404, body: '{"type":"error","error":{"type":"not_found_error","message":"model: nope"}}', code: 'ModelUnavailable', action: 'fallback' },
  { status: 529, body: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', code: 'ModelUnavailable', action: 'fallback' },
  { status: 400, body: '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 250000 tokens > 200000 maximum"}}', code: 'ContextLength', action: 'fallback' },
]);
