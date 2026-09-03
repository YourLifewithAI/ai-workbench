// Any OpenAI-shaped endpoint through the shared suite. The recorded exchanges came from the shape Ollama and
// every other OpenAI-compatible server speaks, so one adapter covers all of them.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModelsFile } from '../../src/shared/model.js';
import { packagePaths } from '../../src/runtime/paths.js';
import { readJsonFile } from '../../src/runtime/workspace/config.js';
import { findModel } from '../../src/runtime/models/catalog.js';
import { OpenAiCompatibleAdapter } from '../../src/runtime/models/adapters/openai-compatible/index.js';
import { directFetch } from '../../src/runtime/models/fetch.js';
import { liveAdapters, liveCredential } from './live.js';
import { readExchanges, recordingFetch, replayFetch } from './recorder.js';
import { runContractSuite, runErrorMappingSuite } from './suite.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'openai-compatible');
const catalog = ModelsFile.parse(readJsonFile(path.join(packagePaths().defaults, 'models.json')));
const model = findModel(catalog, 'ollama/qwen3:14b')!;

const live = liveAdapters().includes('openai-compatible') || liveAdapters().includes('ollama');

runContractSuite('openai-compatible', () => ({
  adapter: new OpenAiCompatibleAdapter(),
  model,
  apiKey: liveCredential('ollama'),
  fetch: (name) => (live ? recordingFetch(fixtures, name, directFetch) : replayFetch(fixtures, name)),
  skip: (name) => (live || readExchanges(fixtures, name) ? null : 'no recorded exchange; record with: npm run contract -- --live openai-compatible'),
}));

runErrorMappingSuite('openai-compatible', () => ({ adapter: new OpenAiCompatibleAdapter(), model }), [
  { status: 401, body: '{"error":{"message":"Incorrect API key provided.","type":"invalid_request_error","code":"invalid_api_key"}}', code: 'Authentication', action: 'abort' },
  { status: 429, body: '{"error":{"message":"Rate limit reached for requests","type":"requests","code":"rate_limit_exceeded"}}', code: 'RateLimit', action: 'retry' },
  { status: 404, body: '{"error":{"message":"model \\"nope\\" not found, try pulling it first","type":"api_error"}}', code: 'ModelUnavailable', action: 'fallback' },
  { status: 500, body: '{"error":{"message":"internal server error","type":"api_error"}}', code: 'ModelUnavailable', action: 'fallback' },
  { status: 400, body: '{"error":{"message":"This model\'s maximum context length is 40960 tokens.","type":"invalid_request_error","code":"context_length_exceeded"}}', code: 'ContextLength', action: 'fallback' },
]);
