// RUN-09 Definition of done (spec/runs/RUN-09.md). The sandbox is the point: these cases assert on the flags the
// runner generates and on what a script can actually reach, not on a behaviour that could pass for another reason.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { CLI_DIST, REPO, runCli, startRuntime, tempWorkspace, waitFor, type Started } from '../helpers/workspace.js';
import { sandboxFlags, findDeno, DEFAULT_LIMITS } from '../../src/runtime/sandbox/deno.js';
import type { EventRecord } from '../../src/shared/events.js';
import type { ApprovalItem, RunDetail, ToolsResponse } from '../../src/shared/api/index.js';

beforeAll(() => {
  if (!fs.existsSync(CLI_DIST)) throw new Error('dist/cli.js is missing: run `npm run build` (or `npm run dod -- 09`, which builds first).');
});

const DENO = findDeno(process.env['PATH']);
const headers = (rt: Started): Record<string, string> => ({ Authorization: `Bearer ${rt.token}`, 'Content-Type': 'application/json' });

function grant(ws: string, agentId: string, permissions: Record<string, unknown>): void {
  const file = path.join(ws, 'config', 'workbench.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8')) as { grants?: Record<string, unknown> };
  config.grants = { ...(config.grants ?? {}), [agentId]: permissions };
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
}

function fixture(ws: string, name: string, body: unknown): void {
  fs.writeFileSync(path.join(ws, 'fixtures', name), JSON.stringify(body, null, 2));
}

const traceOf = async (rt: Started, runId: string): Promise<EventRecord[]> =>
  (await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}/trace.jsonl`, { headers: headers(rt) })).text())
    .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as EventRecord);

const detailOf = async (rt: Started, runId: string): Promise<RunDetail> =>
  (await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}`, { headers: headers(rt) })).json()) as RunDetail;

async function runAgent(rt: Started, agentId: string, input: string, project: string): Promise<string> {
  const res = await fetch(`${rt.baseUrl}/api/v1/runs`, {
    method: 'POST', headers: headers(rt), body: JSON.stringify({ kind: 'agent', id: agentId, inputs: { input }, project }),
  });
  expect(res.status).toBe(202);
  const { runId } = (await res.json()) as { runId: string };
  await waitFor(async () => ['completed', 'failed'].includes((await detailOf(rt, runId)).state), 60_000);
  return runId;
}

describe('DoD 1: the site workflow writes files, and the check step really runs in Deno', () => {
  it.skipIf(!DENO)('the spawn arguments are the policy, and the script reads back what was written', async () => {
    const ws = tempWorkspace('dod09-1');
    // The plan, the build (two writes and one sandboxed check), the critique.
    fixture(ws, 'aaa-plan.json', { match: { systemIncludes: 'The Architect' }, respond: { text: 'One page: index.html, linking to nothing. A stylesheet: style.css.' } });
    // `callIndex` counts every call the *run* makes, and this workflow has three agents: the turns are keyed on
    // what the conversation has already called instead, latest first.
    fixture(ws, 'aad-build-1.json', {
      match: { systemIncludes: 'The Builder' },
      respond: {
        text: 'Writing the files.',
        toolCalls: [
          { name: 'artifact.write', input: { path: 'site/index.html', content: '<!doctype html><html lang="en"><head><title>A small site</title><link rel="stylesheet" href="style.css"></head><body><h1>A small site</h1></body></html>' } },
          { name: 'artifact.write', input: { path: 'site/style.css', content: 'body { color: #111; background: #fff; }' } },
        ],
      },
    });
    fixture(ws, 'aab-build-2.json', {
      match: { systemIncludes: 'The Builder', afterTool: 'artifact.write' },
      respond: {
        text: 'Checking it.',
        toolCalls: [{
          name: 'code.execute',
          input: {
            source: [
              "const page = await tools['artifact.read']({ path: 'site/index.html' });",
              "const css = await tools['artifact.read']({ path: 'site/style.css' });",
              "console.log('title ok', page.content.includes('<title>A small site</title>'));",
              "console.log('stylesheet referenced', page.content.includes('style.css') && css.bytes > 0);",
            ].join('\n'),
          },
        }],
      },
    });
    fixture(ws, 'aaa-build-3.json', { match: { systemIncludes: 'The Builder', afterTool: 'code.execute' }, respond: { text: 'One page and a stylesheet, both read back and checked.' } });
    fixture(ws, 'aae-review.json', { match: { systemIncludes: 'The Reviewer' }, respond: { text: 'A visitor sees a heading and nothing else. That is the brief.' } });

    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true });
    try {
      const started = await fetch(`${rt.baseUrl}/api/v1/runs`, {
        method: 'POST', headers: headers(rt),
        body: JSON.stringify({ kind: 'workflow', id: 'build-site', inputs: { brief: 'A one-page site about a dentist in an arcology.' } }),
      });
      expect(started.status).toBe(202);
      const { runId } = (await started.json()) as { runId: string };
      await waitFor(async () => (await detailOf(rt, runId)).state === 'completed', 120_000);

      // The files are in the project.
      const documents = (await (await fetch(`${rt.baseUrl}/api/v1/projects/site/documents`, { headers: headers(rt) })).json()) as { documents: { path: string }[] };
      expect(documents.documents.map((d) => d.path)).toEqual(expect.arrayContaining(['site/index.html', 'site/style.css']));

      // The check ran inside Deno and read them back through the bridge.
      const trace = await traceOf(rt, runId);
      const executed = trace.find((e) => e.type === 'tool-completed' && e.payload['tool'] === 'code.execute')!;
      const output = executed.payload['output'] as { stdout: string; ok: boolean; toolCalls: string[] };
      expect(output.ok).toBe(true);
      expect(output.stdout).toContain('title ok true');
      expect(output.stdout).toContain('stylesheet referenced true');
      expect(output.toolCalls, 'the bridged reads are named in the result').toEqual(['artifact.read', 'artifact.read']);

      // And each bridged call is in the trace in its own right, decided by the grant matrix like any other.
      const bridged = trace.filter((e) => e.type === 'tool-completed' && e.payload['tool'] === 'artifact.read');
      expect(bridged).toHaveLength(2);
      expect(trace.filter((e) => e.type === 'permission-decided' && e.payload['tool'] === 'artifact.read')).toHaveLength(2);
    } finally {
      await rt.stop();
    }
  }, 240_000);

  it('the flags come from the policy, and never include net or run', () => {
    const flags = sandboxFlags({ scratchDir: '/w/runs/r1', read: ['/w/projects'], write: ['/w/projects/site'] }, DEFAULT_LIMITS);
    expect(flags[0]).toBe('run');
    expect(flags).toContain('--no-prompt');
    expect(flags).toContain('--deny-net');
    expect(flags).toContain('--deny-run');
    expect(flags).toContain('--deny-ffi');
    expect(flags.find((f) => f.startsWith('--allow-read='))).toBe('--allow-read=/w/runs/r1,/w/projects');
    expect(flags.find((f) => f.startsWith('--allow-write='))).toBe('--allow-write=/w/runs/r1,/w/projects/site');
    expect(flags.some((f) => f.startsWith('--allow-net'))).toBe(false);
    expect(flags.some((f) => f.startsWith('--allow-run'))).toBe(false);
    expect(flags.some((f) => f === '--allow-all' || f === '-A')).toBe(false);
    expect(flags).toContain(`--v8-flags=--max-old-space-size=${DEFAULT_LIMITS.memoryMb}`);
  });
});

describe('DoD 2: without Deno there is no execution at all', () => {
  it('doctor lists what is disabled, the tools refuse by name, and no in-process path exists', async () => {
    const ws = tempWorkspace('dod09-2');
    grant(ws, 'weaver', { tools: { 'code.execute': 'allow', 'fs.write': 'allow' }, fs: { read: ['/'], write: ['/'] } });
    fixture(ws, 'aa0-done.json', { match: { systemIncludes: 'The Weaver', afterTool: 'code.execute' }, respond: { text: 'I could not run it.' } });
    fixture(ws, 'aa1-code.json', { match: { systemIncludes: 'The Weaver' }, respond: { text: 'Running.', toolCalls: [{ name: 'code.execute', input: { source: 'console.log(1)' } }] } });

    // `denoPath: null` is the simulation the brief asks for: the runtime believes Deno is not installed.
    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true, denoPath: null });
    try {
      const runId = await runAgent(rt, 'weaver', 'Run something.', 'anthology');
      const trace = await traceOf(rt, runId);
      const completed = trace.find((e) => e.type === 'tool-completed' && e.payload['tool'] === 'code.execute')!;
      const error = completed.payload['error'] as { code: string; message: string; hint: string };
      expect(error.code).toBe('ToolUnavailable');
      expect(error.message).toContain('Deno is not installed');
      expect(error.hint, 'and it says there is no fallback').toContain('no unsandboxed fallback');

      // The Tools screen says the same thing, by name.
      const tools = (await (await fetch(`${rt.baseUrl}/api/v1/tools`, { headers: headers(rt) })).json()) as ToolsResponse;
      expect(tools.sandbox.available).toBe(false);
      expect(tools.sandbox.disabled).toEqual(expect.arrayContaining(['code.execute', 'shell', 'fs.write']));
      expect(tools.tools.find((t) => t.id === 'code.execute')?.available).toBe(false);
    } finally {
      await rt.stop();
    }
  }, 120_000);

  it('doctor names the disabled tools when Deno is missing', async () => {
    const result = await runCli(['doctor', '--json', '--workspace', tempWorkspace('dod09-doctor')], {
      dist: true,
      // An empty PATH is a machine with no Deno on it, whatever this one has installed.
      env: { PATH: '' },
    });
    const report = JSON.parse(result.stdout) as { checks: { name: string; detail: string }[] };
    const deno = report.checks.find((c) => c.name === 'deno')!;
    expect(deno.detail).toContain('unavailable');
    expect(deno.detail).toContain('code.execute');
    expect(deno.detail).toContain('shell');
  }, 120_000);

  it('there is no in-process execution path in the source', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
        const source = fs.readFileSync(full, 'utf8');
        // `eval(`, `new Function(`, and node:vm are the three ways to run a string in this process.
        if (/\beval\s*\(/.test(source) || /new\s+Function\s*\(/.test(source) || /from\s+'node:vm'/.test(source)) {
          offenders.push(path.relative(REPO, full));
        }
      }
    };
    walk(path.join(REPO, 'src'));
    expect(offenders, 'nothing in src/ runs a string in this process (D-30)').toEqual([]);
  });
});

describe('DoD 4: a script that calls two tools, and one it was never granted', () => {
  it.skipIf(!DENO)('completes in one model turn, and the denial reads like every other denial', async () => {
    const ws = tempWorkspace('dod09-4');
    // `calc` and `datetime` are granted; `artifact.write` is not.
    grant(ws, 'weaver', { tools: { 'code.execute': 'allow', calc: 'allow', datetime: 'allow' } });
    fixture(ws, 'aa0-done.json', { match: { systemIncludes: 'The Weaver', afterTool: 'code.execute' }, respond: { text: 'Done in one turn.' } });
    fixture(ws, 'aa1-code.json', {
      match: { systemIncludes: 'The Weaver' },
      respond: {
        text: 'Working it out.',
        toolCalls: [{
          name: 'code.execute',
          input: {
            source: [
              "const sum = await tools['calc']({ expression: '(12 * 250) + 400' });",
              "const now = await tools['datetime']({});",
              "console.log('sum', sum.value, 'weekday', typeof now.weekday === 'string');",
              "try {",
              "  await tools['artifact.write']({ path: 'notes/x.md', content: 'x' });",
              "  console.log('write allowed?!');",
              "} catch (e) {",
              "  console.log('write refused', e.code, e.message);",
              "}",
            ].join('\n'),
          },
        }],
      },
    });

    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true });
    try {
      const runId = await runAgent(rt, 'weaver', 'Add it up.', 'anthology');
      expect((await detailOf(rt, runId)).state).toBe('completed');

      const trace = await traceOf(rt, runId);
      const executed = trace.find((e) => e.type === 'tool-completed' && e.payload['tool'] === 'code.execute')!;
      const output = executed.payload['output'] as { stdout: string; toolCalls: string[]; ok: boolean };
      expect(output.stdout).toContain('sum 3400 weekday true');
      expect(output.stdout, 'the script reads the denial as an error it can act on').toContain('write refused PermissionDenied');
      expect(output.toolCalls).toEqual(['calc', 'datetime', 'artifact.write']);

      // One model turn for all of it: the script did the work, not three round trips.
      expect(trace.filter((e) => e.type === 'model-started')).toHaveLength(2);

      // The denial is in the trace like any other, with the same decision event in front of it.
      const denied = trace.find((e) => e.type === 'tool-completed' && e.payload['tool'] === 'artifact.write')!;
      expect((denied.payload['error'] as { code: string }).code).toBe('PermissionDenied');
      const decision = trace.find((e) => e.type === 'permission-decided' && e.payload['tool'] === 'artifact.write')!;
      expect(decision.payload['allowed']).toBe(false);
    } finally {
      await rt.stop();
    }
  }, 240_000);
});

describe('DoD 3: the reference MCP filesystem server', () => {
  const server = path.join(REPO, 'node_modules', '@modelcontextprotocol', 'server-filesystem', 'dist', 'index.js');
  it.skipIf(!fs.existsSync(server))('connects, its read tools run with a grant, and its write tool parks', async () => {
    const ws = tempWorkspace('dod09-3');
    const shared = path.join(ws, 'shared');
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, 'note.txt'), 'The molar is drilled from the lingual side.');

    const file = path.join(ws, 'config', 'workbench.json');
    const config = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    config['mcp'] = { servers: [{ name: 'files', command: process.execPath, args: [server, shared] }] };
    config['grants'] = {
      weaver: { tools: { 'mcp.files.read_text_file': 'allow', 'mcp.files.write_file': 'allow' } },
    };
    fs.writeFileSync(file, JSON.stringify(config, null, 2));

    // Both behaviours are scripted up front: the mock reads its fixtures once, at startup, so a test that
    // rewrites one mid-run is writing to a file nobody will read again.
    fixture(ws, 'aa0-read-done.json', { match: { systemIncludes: 'The Weaver', afterTool: 'mcp.files.read_text_file' }, respond: { text: 'Read it.' } });
    fixture(ws, 'aa1-write-done.json', { match: { systemIncludes: 'The Weaver', afterTool: 'mcp.files.write_file' }, respond: { text: 'That did not happen.' } });
    fixture(ws, 'aa2-read.json', {
      match: { systemIncludes: 'The Weaver', lastUserIncludes: 'Read the note' },
      respond: { text: 'Reading.', toolCalls: [{ name: 'mcp.files.read_text_file', input: { path: path.join(shared, 'note.txt') } }] },
    });
    fixture(ws, 'aa3-write.json', {
      match: { systemIncludes: 'The Weaver', lastUserIncludes: 'Write a note' },
      respond: { text: 'Writing.', toolCalls: [{ name: 'mcp.files.write_file', input: { path: path.join(shared, 'new.txt'), content: 'x' } }] },
    });

    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true });
    try {
      // The server came up and published its tools.
      const tools = (await (await fetch(`${rt.baseUrl}/api/v1/tools`, { headers: headers(rt) })).json()) as ToolsResponse;
      const status = tools.mcpServers.find((s) => s.name === 'files')!;
      expect(status.running, status.error ?? 'no error reported').toBe(true);
      expect(status.tools).toEqual(expect.arrayContaining(['read_text_file', 'write_file']));

      const read = tools.tools.find((t) => t.id === 'mcp.files.read_text_file')!;
      expect(read.origin).toEqual({ kind: 'mcp', server: 'files' });
      expect(read.tier, 'the server annotates it read-only').toBe('read');
      const write = tools.tools.find((t) => t.id === 'mcp.files.write_file')!;
      expect(write.tier).toBe('write');
      expect(write.approvalByDefault, 'a write from outside asks a human every time').toBe(true);

      // A granted read runs.
      const runId = await runAgent(rt, 'weaver', 'Read the note.', 'anthology');
      const trace = await traceOf(rt, runId);
      const completed = trace.find((e) => e.type === 'tool-completed' && e.payload['tool'] === 'mcp.files.read_text_file')!;
      expect(JSON.stringify(completed.payload['output'])).toContain('lingual side');

      // And its write tool parks the run in front of a human.
      const second = await fetch(`${rt.baseUrl}/api/v1/runs`, {
        method: 'POST', headers: headers(rt), body: JSON.stringify({ kind: 'agent', id: 'weaver', inputs: { input: 'Write a note.' }, project: 'anthology' }),
      });
      const { runId: writeRun } = (await second.json()) as { runId: string };
      await waitFor(async () => (await detailOf(rt, writeRun)).state === 'waiting_approval', 60_000);
      const approvals = ((await (await fetch(`${rt.baseUrl}/api/v1/approvals`, { headers: headers(rt) })).json()) as { approvals: ApprovalItem[] }).approvals;
      expect(approvals[0]!.actions[0]!.tool).toBe('mcp.files.write_file');

      await fetch(`${rt.baseUrl}/api/v1/approvals/${approvals[0]!.batchId}`, { method: 'POST', headers: headers(rt), body: JSON.stringify({ decision: 'deny' }) });
      await waitFor(async () => (await detailOf(rt, writeRun)).state === 'completed', 60_000);
      expect(fs.existsSync(path.join(shared, 'new.txt')), 'a refused write did not happen').toBe(false);
    } finally {
      await rt.stop();
    }
  }, 240_000);
});
