// The mock adapter against the shared suite. It touches no network, which the throwing fetch below proves.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModelsFile } from '../../src/shared/model.js';
import { packagePaths } from '../../src/runtime/paths.js';
import { readJsonFile } from '../../src/runtime/workspace/config.js';
import { findModel } from '../../src/runtime/models/catalog.js';
import { MockAdapter } from '../../src/runtime/models/adapters/mock/index.js';
import type { FetchLike } from '../../src/runtime/models/adapter.js';
import { describe, it, expect } from 'vitest';
import { ModelError } from '../../src/runtime/models/errors.js';
import { ModelErrorCode } from '../../src/shared/model.js';
import { request, runContractSuite } from './suite.js';

const catalog = ModelsFile.parse(readJsonFile(path.join(packagePaths().defaults, 'models.json')));
const model = findModel(catalog, 'mock/echo')!;

const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-mock-'));
fs.writeFileSync(path.join(fixtures, '1-tool.json'), JSON.stringify({
  match: { lastUserIncludes: 'weather' },
  respond: { text: '', toolCalls: [{ name: 'get_weather', input: { city: 'Chicago' } }], usage: { input: 20, output: 12 } },
}));
fs.writeFileSync(path.join(fixtures, '2-structured.json'), JSON.stringify({
  match: { lastUserIncludes: 'population' },
  respond: { json: { city: 'Chicago', population: 2_721_000 }, usage: { input: 20, output: 16 } },
}));

const noNetwork: FetchLike = () => { throw new Error('the mock adapter must never open a socket'); };

runContractSuite('mock', () => ({ fetch: () => noNetwork, adapter: new MockAdapter(fixtures), model }));

// The mock's errors come from a fixture rather than from HTTP, so every code is reachable and each keeps the
// default action the engine's retry and fallback rules read (D-05).
describe('contract: mock error mapping', () => {
  const errorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-mock-err-'));
  for (const code of ModelErrorCode.options) {
    it(`fixture error "${code}" raises ${code} with its default action`, async () => {
      fs.writeFileSync(path.join(errorDir, 'error.json'), JSON.stringify({ match: {}, respond: { error: code } }));
      const adapter = new MockAdapter(errorDir);
      const error = await adapter.generate(model, request(), { fetch: noNetwork, apiKey: undefined, runId: 'contract' }).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(ModelError);
      expect((error as ModelError).code).toBe(code);
      expect((error as ModelError).name).toBe(`${code}Error`);
    });
  }
});
