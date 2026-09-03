// RUN-00 Definition of done (spec/runs/RUN-00.md). Items 1 (check/build), 5 (e2e), and 6 (docker) run as their own gates.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { packagePaths, workspacePaths } from '../../src/runtime/paths.js';
import { openDatabase, DatabaseNewerError } from '../../src/runtime/db/index.js';
import { readBootstrap } from '../../src/runtime/bootstrap.js';
import { Runtime } from '../../src/runtime/runtime.js';
import { CLI_DIST, collectSse, runCli, startCli, tempDir, tempWorkspace, waitFor } from '../helpers/workspace.js';

beforeAll(() => {
  if (!fs.existsSync(CLI_DIST)) throw new Error('dist/cli.js is missing: run `npm run build` (or `npm run dod -- 00`, which builds first).');
});

const refused = (host: string, port: number): Promise<boolean> => new Promise((resolve) => {
  const s = net.connect({ host, port });
  s.once('connect', () => { s.destroy(); resolve(false); });
  s.once('error', () => resolve(true));
});

describe('DoD 2: workbench init + start --port 0', () => {
  it('prints exactly one stdout line with #token=, binds 127.0.0.1 only, and cleans up on SIGTERM', async () => {
    const ws = tempDir('dod2');
    const init = await runCli(['init', ws], { dist: true });
    expect(init.code, init.stderr).toBe(0);
    const started = await startCli(['--workspace', ws, '--port', '0'], { dist: true });
    const paths = workspacePaths(ws);
    expect(started.url).toContain('#token=');
    expect(fs.existsSync(paths.runtimeJson)).toBe(true);
    expect(fs.existsSync(paths.runtimeToken)).toBe(true);
    expect(await refused('::1', started.port)).toBe(true);
    expect(await refused('127.0.0.1', started.port)).toBe(false);
    const code = await started.stop();
    expect(code).toBe(0);
    expect(started.stdout().split('\n').filter(Boolean)).toHaveLength(1);
    expect(fs.existsSync(paths.runtimeJson)).toBe(false);
    expect(fs.existsSync(paths.runtimeToken)).toBe(false);
    expect(fs.existsSync(`${paths.db}-wal`), 'WAL checkpointed: database closed cleanly').toBe(false);
  }, 60_000);
});

describe('DoD 3: headless run with no runtime running', () => {
  it('run agent echo --provider mock --json completes; trace --json has the six events with the compiled request', async () => {
    const ws = tempWorkspace('dod3');
    const run = await runCli(['run', 'agent', 'echo', '--input', 'hi', '--provider', 'mock', '--json', '--workspace', ws], { dist: true });
    expect(run.code, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout) as { runId: string; state: string; outputs: { output: string }; costUsd: number };
    expect(result).toMatchObject({ state: 'completed', outputs: { output: 'hi' }, costUsd: 0 });
    expect(result.runId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(fs.existsSync(workspacePaths(ws).runtimeJson), 'ephemeral runtime wrote no runtime.json').toBe(false);
    const trace = await runCli(['trace', result.runId, '--json', '--workspace', ws], { dist: true });
    expect(trace.code, trace.stderr).toBe(0);
    const events = trace.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; payload: Record<string, unknown> });
    expect(events.map((e) => e.type)).toEqual(['run-started', 'step-started', 'model-started', 'model-completed', 'step-completed', 'run-completed']);
    const request = events[2]!.payload['request'] as { system: unknown; messages: unknown[]; tools: unknown[] };
    expect(typeof request.system).toBe('string');
    expect(Array.isArray(request.messages) && request.messages.length === 1).toBe(true);
    expect(request.tools).toEqual([]);
  }, 60_000);
});

describe('DoD 4: with a runtime running, run goes through HTTP and shows up on the workspace stream', () => {
  it('the run is created in the live runtime and GET /runs/events announces it', async () => {
    const ws = tempWorkspace('dod4');
    const started = await startCli(['--workspace', ws, '--port', '0'], { dist: true });
    try {
      const controller = new AbortController();
      const stream = collectSse(`http://127.0.0.1:${started.port}/api/v1/runs/events`, started.token, controller.signal);
      await waitFor(() => stream.events.includes('ready'));
      const run = await runCli(['run', 'agent', 'echo', '--input', 'over http', '--provider', 'mock', '--json', '--workspace', ws], { dist: true });
      expect(run.code, run.stderr).toBe(0);
      const { runId } = JSON.parse(run.stdout) as { runId: string };
      const list = (await (await fetch(`http://127.0.0.1:${started.port}/api/v1/runs`, { headers: { Authorization: `Bearer ${started.token}` } })).json()) as { runs: { id: string; state: string }[] };
      expect(list.runs.find((r) => r.id === runId)?.state).toBe('completed');
      await waitFor(() => stream.events.includes('run-completed'));
      expect(stream.events).toContain('run-started');
      controller.abort();
      await stream.done;
      const detach = await runCli(['run', 'agent', 'echo', '--input', 'detached', '--detach', '--json', '--workspace', ws], { dist: true });
      expect(detach.code, detach.stderr).toBe(0);
      expect(JSON.parse(detach.stdout)).toHaveProperty('runId');
    } finally {
      expect(await started.stop()).toBe(0);
    }
  }, 60_000);
});

describe('DoD 7: database features and migrations', () => {
  it('startup fails clearly when the injected FTS5 assertion reports absence', async () => {
    const ws = tempWorkspace('dod7a');
    await expect(Runtime.create({ workspaceDir: ws, bootstrap: readBootstrap(), ephemeral: true, quietLog: true, assertFts5: () => { throw new Error('This SQLite build lacks FTS5 (simulated).'); } }))
      .rejects.toThrow(/lacks FTS5/);
  });

  it('migrates a fresh workspace without a backup, is idempotent, and refuses a newer database', async () => {
    const ws = tempWorkspace('dod7b');
    const paths = workspacePaths(ws);
    const pkg = packagePaths();
    const opts = { file: paths.db, migrationsDir: pkg.migrations, backupsDir: paths.backups, keepBackups: 5 };
    const first = await openDatabase(opts);
    expect(first.applied).toEqual([1]);
    expect(first.backup).toBeNull();
    first.db.close();
    const second = await openDatabase(opts);
    expect(second.applied).toEqual([]);
    expect(second.backup).toBeNull();
    expect(fs.readdirSync(paths.backups)).toEqual([]);
    second.db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (999, ?)').run(new Date().toISOString());
    second.db.close();
    await expect(openDatabase(opts)).rejects.toBeInstanceOf(DatabaseNewerError);
    await expect(openDatabase(opts)).rejects.toThrow(/newer than this runtime/);
  });

  it('backs up an existing database before applying a pending migration', async () => {
    const ws = tempWorkspace('dod7c');
    const paths = workspacePaths(ws);
    const pkg = packagePaths();
    const migrations = tempDir('migrations');
    fs.copyFileSync(path.join(pkg.migrations, '0001_init.sql'), path.join(migrations, '0001_init.sql'));
    const opts = { file: paths.db, migrationsDir: migrations, backupsDir: paths.backups, keepBackups: 2 };
    (await openDatabase(opts)).db.close();
    fs.writeFileSync(path.join(migrations, '0002_probe.sql'), 'CREATE TABLE probe (id INTEGER PRIMARY KEY);');
    const upgraded = await openDatabase(opts);
    expect(upgraded.applied).toEqual([2]);
    expect(upgraded.backup).toMatch(/-pre-2\.sqlite$/);
    expect(fs.existsSync(upgraded.backup!)).toBe(true);
    upgraded.db.close();
  });
});
