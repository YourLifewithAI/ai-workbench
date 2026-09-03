// The Google adapter against the shared suite. Non-live runs replay recorded HTTP, so CI needs no key;
// `npm run contract -- --live google` re-records against the real API and must stay green (model-layer.md).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModelsFile } from '../../src/shared/model.js';
import { packagePaths } from '../../src/runtime/paths.js';
import { readJsonFile } from '../../src/runtime/workspace/config.js';
import { findModel } from '../../src/runtime/models/catalog.js';
import { GoogleAdapter } from '../../src/runtime/models/adapters/google/index.js';
import { directFetch } from '../../src/runtime/models/fetch.js';
import { liveAdapters, liveCredential } from './live.js';
import { readExchanges, recordingFetch, replayFetch } from './recorder.js';
import { runContractSuite, runErrorMappingSuite } from './suite.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures', 'google');
const catalog = ModelsFile.parse(readJsonFile(path.join(packagePaths().defaults, 'models.json')));
const model = findModel(catalog, 'google/gemini-2.5-flash')!;

const live = liveAdapters().includes('google');
const key = liveCredential('google');

runContractSuite('google', () => ({
  adapter: new GoogleAdapter(),
  model,
  apiKey: live ? key : 'replayed-fixture-key-not-a-secret',
  fetch: (name) => (live ? recordingFetch(fixtures, name, directFetch) : replayFetch(fixtures, name)),
  skip: (name) => {
    if (live) return key ? null : 'no credential named "google" (set WORKBENCH_CRED_GOOGLE)';
    return readExchanges(fixtures, name) ? null : `no recorded exchange; record with: npm run contract -- --live google`;
  },
}));

// Status codes the provider actually returns, mapped to the codes the engine's retry and fallback rules read (D-05).
runErrorMappingSuite('google', () => ({ adapter: new GoogleAdapter(), model, apiKey: 'replayed-fixture-key-not-a-secret' }), [
  { status: 401, body: '{"error":{"code":401,"message":"API key not valid. Please pass a valid API key.","status":"UNAUTHENTICATED"}}', code: 'Authentication', action: 'abort' },
  { status: 403, body: '{"error":{"code":403,"message":"Method doesn\'t allow unregistered callers.","status":"PERMISSION_DENIED"}}', code: 'Authentication', action: 'abort' },
  { status: 429, body: '{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}', code: 'RateLimit', action: 'retry' },
  { status: 404, body: '{"error":{"code":404,"message":"models/nope is not found for API version v1beta.","status":"NOT_FOUND"}}', code: 'ModelUnavailable', action: 'fallback' },
  { status: 500, body: '{"error":{"code":500,"message":"An internal error has occurred.","status":"INTERNAL"}}', code: 'ModelUnavailable', action: 'fallback' },
  { status: 400, body: '{"error":{"code":400,"message":"The input token count exceeds the maximum number of tokens allowed.","status":"INVALID_ARGUMENT"}}', code: 'ContextLength', action: 'fallback' },
  { status: 400, body: '{"error":{"code":400,"message":"Candidate was blocked due to safety.","status":"INVALID_ARGUMENT"}}', code: 'ContentFilter', action: 'fallback' },
]);
