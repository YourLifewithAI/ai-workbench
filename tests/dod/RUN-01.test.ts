// RUN-01 Definition of done (spec/runs/RUN-01.md). Item 4 (watch it stream in the UI) is the @run-01 e2e case.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import { workspacePaths } from '../../src/runtime/paths.js';
import { CLI_DIST, REPO, runCli, tempWorkspace } from '../helpers/workspace.js';
import { liveAdapters } from '../contract/live.js';
import { readExchanges } from '../contract/recorder.js';

beforeAll(() => {
  if (!fs.existsSync(CLI_DIST)) throw new Error('dist/cli.js is missing: run `npm run build` (or `npm run dod -- 01`, which builds first).');
});

const readDb = (ws: string) => new Database(workspacePaths(ws).db, { readonly: true });

describe('DoD 1: the contract suite is green without a key, and says so about the live half', () => {
  it('every recorded adapter has its fixtures committed', () => {
    const fixtures = path.join(REPO, 'tests', 'contract', 'fixtures', 'google');
    for (const name of ['text', 'stream', 'tool-call', 'structured']) {
      expect(readExchanges(fixtures, name), `${name} is recorded`).toBeTruthy();
    }
  });

  it('the live switch is off unless asked for, so CI never needs a credential', () => {
    expect(liveAdapters()).toEqual([]);
  });

  it('`npm run contract` runs the contract project', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['contract']).toContain('contract.ts');
    expect(pkg.scripts['check'], 'the check gate runs it').toContain('contract');
  });
});

describe('DoD 2: a workspace agent runs and its provenance is stored', () => {
  it('run agent architect --provider mock --json returns text and cost, with both versions on the model call', async () => {
    const ws = tempWorkspace('dod01-2');
    const run = await runCli(['run', 'agent', 'architect', '--input', 'A dentist finds binary in his patients\' tooth decay.', '--provider', 'mock', '--json', '--workspace', ws], { dist: true });
    expect(run.code, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout) as { runId: string; state: string; outputs: { output: string }; costUsd: number };
    expect(result.state).toBe('completed');
    expect(result.outputs.output.length).toBeGreaterThan(100);
    // The mock serves any catalog id, so cost still comes from the requested model's price rows (D-37).
    expect(result.costUsd).toBeGreaterThan(0);

    const db = readDb(ws);
    try {
      const call = db.prepare('SELECT * FROM model_calls WHERE run_id = ?').get(result.runId) as { model_id: string; adapter: string; prompt_version: string; agent_version: string; cost_usd: number };
      expect(call.model_id).toBe('google/gemini-2.5-pro');
      expect(call.adapter).toBe('mock');
      expect(call.prompt_version).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(call.agent_version).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(call.cost_usd).toBeCloseTo(result.costUsd, 8);

      const version = db.prepare('SELECT * FROM agent_versions WHERE hash = ?').get(call.agent_version) as { agent_id: string; definition_json: string } | undefined;
      expect(version, 'agent_versions resolves the hash the model call names').toBeDefined();
      expect(version!.agent_id).toBe('architect');
      expect(JSON.parse(version!.definition_json)).toHaveProperty('definition.modelPolicy.primary', 'google/gemini-2.5-pro');
    } finally {
      db.close();
    }
  }, 90_000);
});

describe('DoD 3: versions move with the definition, not with the task', () => {
  it('editing instructions.md changes both hashes; changing only the input changes neither', async () => {
    const ws = tempWorkspace('dod01-3');
    const args = (input: string) => ['run', 'agent', 'architect', '--input', input, '--provider', 'mock', '--json', '--workspace', ws];

    const first = JSON.parse((await runCli(args('premise one'), { dist: true })).stdout) as { runId: string };
    const second = JSON.parse((await runCli(args('a completely different premise'), { dist: true })).stdout) as { runId: string };

    fs.appendFileSync(path.join(ws, 'agents', 'architect', 'instructions.md'), '\n\n## extra\nNever open on the weather.\n');
    const third = JSON.parse((await runCli(args('premise one'), { dist: true })).stdout) as { runId: string };

    const db = readDb(ws);
    try {
      const versionsOf = (runId: string) => db.prepare('SELECT prompt_version, agent_version FROM model_calls WHERE run_id = ?').get(runId) as { prompt_version: string; agent_version: string };
      const a = versionsOf(first.runId);
      const b = versionsOf(second.runId);
      const c = versionsOf(third.runId);
      expect(b, 'a different task leaves both hashes alone').toEqual(a);
      expect(c.agent_version).not.toBe(a.agent_version);
      expect(c.prompt_version).not.toBe(a.prompt_version);
      expect(db.prepare('SELECT COUNT(*) AS n FROM agent_versions WHERE agent_id = ?').get('architect')).toEqual({ n: 2 });
    } finally {
      db.close();
    }
  }, 120_000);
});

describe('RUN-01 surface: agents API and the streamed trace', () => {
  it('GET /agents lists the ported agents and surfaces a broken one as an error, not a crash', async () => {
    const { startRuntime } = await import('../helpers/workspace.js');
    const ws = tempWorkspace('dod01-agents');
    fs.mkdirSync(path.join(ws, 'agents', 'broken'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'agents', 'broken', 'agent.json'), '{ "schemaVersion": 1, "id": "broken" }');
    const rt = await startRuntime(ws);
    try {
      const h = { Authorization: `Bearer ${rt.token}` };
      const list = (await (await fetch(`${rt.baseUrl}/api/v1/agents`, { headers: h })).json()) as { agents: { id: string; version: string }[]; errors: { id: string; message: string }[] };
      expect(list.agents.map((a) => a.id).sort()).toEqual(['architect', 'cutter', 'echo', 'weaver']);
      expect(list.errors.map((e) => e.id)).toEqual(['broken']);
      expect(list.errors[0]!.message).toMatch(/name|description|instructions|modelPolicy/);

      const detail = (await (await fetch(`${rt.baseUrl}/api/v1/agents/architect`, { headers: h })).json()) as { sections: { name: string }[]; instructionsSource: string };
      expect(detail.instructionsSource).toBe('file');
      expect(detail.sections.map((s) => s.name)).toEqual(['task', 'world']);

      // A fixed definition becomes loadable without a restart.
      fs.writeFileSync(path.join(ws, 'agents', 'broken', 'agent.json'), JSON.stringify({
        schemaVersion: 1, id: 'broken', name: 'Fixed', description: 'now valid',
        instructions: [{ name: 'task', text: 'Reply.' }], modelPolicy: { primary: 'mock/echo' },
      }));
      const reloaded = (await (await fetch(`${rt.baseUrl}/api/v1/agents/reload`, { method: 'POST', headers: h })).json()) as { loaded: number; errors: unknown[] };
      expect(reloaded).toEqual({ loaded: 5, errors: [] });
    } finally {
      await rt.stop();
    }
  }, 60_000);

  it('a streamed run emits deltas that never enter the stored trace', async () => {
    const { startRuntime } = await import('../helpers/workspace.js');
    const ws = tempWorkspace('dod01-stream');
    const rt = await startRuntime(ws);
    try {
      const deltas: string[] = [];
      const stop = rt.runtime.events.subscribeDeltas((d) => deltas.push(d.text));
      const { runId, done } = rt.runtime.engine.startAgentRun({ agentId: 'echo', inputs: { input: 'please be slow' }, provider: 'mock' });
      await done;
      stop();
      expect(deltas.length, 'the fixture paces its chunks, so several deltas arrive').toBeGreaterThan(1);
      expect(deltas.join('')).toBe('…slowly.');

      const trace = await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}/trace.jsonl`, { headers: { Authorization: `Bearer ${rt.token}` } })).text();
      const types = trace.trim().split('\n').map((l) => (JSON.parse(l) as { type: string }).type);
      expect(types, 'deltas are shown, never stored').toEqual(['run-started', 'step-started', 'model-started', 'model-completed', 'step-completed', 'run-completed']);
    } finally {
      await rt.stop();
    }
  }, 60_000);
});
