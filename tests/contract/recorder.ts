// Record and replay HTTP at the adapter's injected-fetch seam, so a real adapter's whole mapping path is
// exercised in CI without a key. `--live <adapter>` records; every other run replays (model-layer.md §Contract suite).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { FetchLike } from '../../src/runtime/models/adapter.js';

export interface Exchange {
  method: string;
  url: string;
  requestHash: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

/** Marks a fixture written by hand rather than recorded from the provider; its request is not pinned. */
export const AUTHORED = 'authored';

export function hashBody(body: string): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

async function bodyOf(input: string | URL | Request, init?: RequestInit): Promise<string> {
  if (typeof init?.body === 'string') return init.body;
  if (input instanceof Request) return await input.clone().text();
  return '';
}

function urlOf(input: string | URL | Request): string {
  return input instanceof Request ? input.url : input.toString();
}

export function fixtureFile(dir: string, name: string): string {
  return path.join(dir, `${name}.json`);
}

export function readExchanges(dir: string, name: string): Exchange[] | null {
  const file = fixtureFile(dir, name);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Exchange[];
}

/** Replays recorded exchanges in order, checking that the request still matches what was recorded. */
export function replayFetch(dir: string, name: string): FetchLike {
  const exchanges = readExchanges(dir, name);
  if (!exchanges) {
    throw new Error(`No recorded exchange for "${name}". Record it with: npm run contract -- --live google`);
  }
  let index = 0;
  return async (input, init) => {
    const exchange = exchanges[index++];
    if (!exchange) throw new Error(`Fixture "${name}" ran out of recorded exchanges at call ${index}.`);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method !== exchange.method) throw new Error(`Fixture "${name}" call ${index}: recorded ${exchange.method}, got ${method}.`);
    if (!urlOf(input).endsWith(new URL(exchange.url).pathname + new URL(exchange.url).search)) {
      throw new Error(`Fixture "${name}" call ${index}: recorded ${exchange.url}, got ${urlOf(input)}.`);
    }
    // A recorded exchange also pins the request that produced it, so a change to prompt assembly cannot silently
    // keep replaying an answer to a question the adapter no longer asks. Authored fixtures carry no hash to pin.
    if (exchange.requestHash !== AUTHORED) {
      const sent = hashBody(await bodyOf(input, init));
      if (sent !== exchange.requestHash) {
        throw new Error(`Fixture "${name}" call ${index}: the request changed since it was recorded (${exchange.requestHash} → ${sent}). Re-record with: npm run contract -- --live google`);
      }
    }
    return new Response(exchange.body, { status: exchange.status, statusText: exchange.statusText, headers: exchange.headers });
  };
}

/** Calls the real network and writes what came back, with credential-bearing headers stripped. */
export function recordingFetch(dir: string, name: string, real: FetchLike): FetchLike {
  const exchanges: Exchange[] = [];
  fs.mkdirSync(dir, { recursive: true });
  return async (input, init) => {
    const requestBody = await bodyOf(input, init);
    // Request headers are never recorded: that is how `x-goog-api-key` stays out of the fixtures (SEC-20).
    const response = await real(input, init);
    const body = await response.clone().text();
    exchanges.push({
      method: (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(),
      url: urlOf(input),
      requestHash: hashBody(requestBody),
      status: response.status,
      statusText: response.statusText,
      headers: safeResponseHeaders(response),
      body,
    });
    fs.writeFileSync(fixtureFile(dir, name), JSON.stringify(exchanges, null, 2) + '\n');
    return response;
  };
}

/** Only the headers a replay needs; nothing that identifies the caller or the key. */
function safeResponseHeaders(response: Response): Record<string, string> {
  const keep = ['content-type'];
  const out: Record<string, string> = {};
  for (const k of keep) {
    const v = response.headers.get(k);
    if (v) out[k] = v;
  }
  return out;
}

/** An HTTP failure a fixture can assert against without ever having called the provider. */
export function errorFetch(status: number, body: string, statusText = ''): FetchLike {
  return async () => new Response(body, { status, statusText, headers: { 'content-type': 'application/json' } });
}
