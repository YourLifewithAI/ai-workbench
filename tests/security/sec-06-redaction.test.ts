// SEC-06: a registered secret (planted via credentials and via --input) never appears in events, logs, or trace output.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { startRuntime, tempWorkspace, runCli } from '../helpers/workspace.js';

const secret = (): string => `plantedsecret-${randomBytes(12).toString('hex')}`;

describe('SEC-06 registered secrets never leak', () => {
  it('in-process: credentials.json value and the same value in --input are redacted everywhere', async () => {
    const ws = tempWorkspace('sec06');
    const SECRET = secret();
    const credFile = path.join(ws, 'config', 'credentials.json');
    fs.writeFileSync(credFile, JSON.stringify({ google: { apiKey: SECRET } }), { mode: 0o600 });
    const rt = await startRuntime(ws);
    try {
      expect(rt.runtime.credentials.names()).toEqual(['google']);
      const res = await fetch(`${rt.baseUrl}/api/v1/runs`, { method: 'POST', headers: { Authorization: `Bearer ${rt.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'agent', id: 'echo', inputs: { input: `please keep ${SECRET} safe` }, provider: 'mock' }) });
      const { runId } = (await res.json()) as { runId: string };
      await rt.runtime.engine.waitFor(runId);
      const h = { Authorization: `Bearer ${rt.token}` };
      const detail = await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}`, { headers: h })).text();
      const trace = await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}/trace.jsonl`, { headers: h })).text();
      const sse = await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}/events`, { headers: h })).text();
      for (const body of [detail, trace, sse]) {
        expect(body).not.toContain(SECRET);
        expect(body).toContain('[REDACTED:credential:google]');
      }
      const rows = rt.runtime.db.prepare('SELECT payload_json FROM events').all() as { payload_json: string }[];
      for (const r of rows) expect(r.payload_json).not.toContain(SECRET);
      const runs = rt.runtime.db.prepare('SELECT inputs_json, outputs_json FROM runs').all() as { inputs_json: string; outputs_json: string | null }[];
      for (const r of runs) { expect(r.inputs_json).not.toContain(SECRET); expect(r.outputs_json ?? '').not.toContain(SECRET); }
      const steps = rt.runtime.db.prepare('SELECT output_json FROM run_steps').all() as { output_json: string | null }[];
      for (const s of steps) expect(s.output_json ?? '').not.toContain(SECRET);
      rt.runtime.log.info({ note: `logging ${SECRET} on purpose` }, 'redaction probe');
    } finally {
      await rt.stop();
    }
    const log = fs.readFileSync(path.join(ws, 'data', 'logs', 'runtime.log'), 'utf8');
    expect(log).toContain('redaction probe');
    expect(log).not.toContain(SECRET);
    expect(log).toContain('[REDACTED:credential:google]');
  });

  it('CLI: a WORKBENCH_CRED_* value planted in --input is redacted in run output and trace --json', async () => {
    const ws = tempWorkspace('sec06cli');
    const SECRET = secret();
    const env = { WORKBENCH_CRED_OPENAI: SECRET };
    const run = await runCli(['run', 'agent', 'echo', '--input', `the key is ${SECRET}`, '--provider', 'mock', '--json', '--workspace', ws], { env });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).not.toContain(SECRET);
    expect(run.stdout).toContain('[REDACTED:credential:openai]');
    const { runId } = JSON.parse(run.stdout) as { runId: string };
    const trace = await runCli(['trace', runId, '--json', '--workspace', ws], { env });
    expect(trace.code, trace.stderr).toBe(0);
    expect(trace.stdout.split('\n').filter(Boolean).length).toBe(6);
    expect(trace.stdout).not.toContain(SECRET);
    expect(fs.readFileSync(path.join(ws, 'data', 'logs', 'runtime.log'), 'utf8')).not.toContain(SECRET);
  }, 60_000);
});
