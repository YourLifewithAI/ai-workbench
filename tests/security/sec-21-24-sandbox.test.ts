// SEC-21 through 24: the filesystem outside the project, the sandbox, what happens without one, and MCP.
// The sandbox cases run real Deno; where it is missing they skip rather than pretend, and SEC-23 is the case
// that has to pass on a machine *without* Deno, so it never touches one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { Sandbox, findDeno, sandboxFlags, DEFAULT_LIMITS } from '../../src/runtime/sandbox/deno.js';
import { childEnv } from '../../src/runtime/security/childEnv.js';
import { Broker } from '../../src/runtime/security/broker.js';
import { Permissions } from '../../src/shared/permissions.js';
import { startRuntime, tempWorkspace, waitFor, type Started } from '../helpers/workspace.js';
import type { ApprovalItem, ToolsResponse } from '../../src/shared/api/index.js';

const DENO = findDeno(process.env['PATH']);
const headers = (rt: Started): Record<string, string> => ({ Authorization: `Bearer ${rt.token}`, 'Content-Type': 'application/json' });

function scratch(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

/** Runs one script in the sandbox with the roots given, and returns everything it produced. */
async function runScript(source: string, roots: { read?: string[]; write?: string[] } = {}, limits = DEFAULT_LIMITS): Promise<{ ok: boolean; stdout: string; stderr: string; killedBy: string | null }> {
  const dir = scratch('sec22');
  const scriptPath = path.join(dir, 'script.ts');
  fs.writeFileSync(scriptPath, source);
  const sandbox = new Sandbox(DENO, limits);
  const result = await sandbox.run({
    scriptPath,
    policy: { scratchDir: dir, read: roots.read ?? [], write: roots.write ?? [] },
    env: childEnv({ PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' }),
    signal: new AbortController().signal,
  });
  return { ok: result.ok, stdout: result.stdout, stderr: result.stderr, killedBy: result.killedBy };
}

describe('SEC-21 a path outside the project is canonicalized before it is allowed', () => {
  it('`..` out of a granted root is denied, however it is spelled', async () => {
    const ws = tempWorkspace('sec21-dotdot');
    const allowed = path.join(ws, 'shared');
    const secret = path.join(ws, 'secret.txt');
    fs.mkdirSync(allowed, { recursive: true });
    fs.writeFileSync(secret, 'not for tools');
    const broker = new Broker({ workspaceDir: ws, permissions: Permissions.parse({ fs: { read: [allowed] } }), scratchDir: scratch('sec21') });

    await expect(broker.read(path.join(allowed, '..', 'secret.txt'))).rejects.toThrow(/not under any path/);
    await expect(broker.read(`${allowed}/../secret.txt`)).rejects.toThrow(/not under any path/);
    // And the file it was reaching for is readable when the grant actually covers it: this is a policy, not a bug.
    const wide = new Broker({ workspaceDir: ws, permissions: Permissions.parse({ fs: { read: [ws] } }), scratchDir: scratch('sec21') });
    expect(await wide.read(secret)).toBe('not for tools');
  });

  it('a symlink inside a granted root that points outside it is denied', async () => {
    const ws = tempWorkspace('sec21-symlink');
    const allowed = path.join(ws, 'shared');
    const outside = path.join(ws, 'outside');
    fs.mkdirSync(allowed, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'keys.txt'), 'a key');
    fs.symlinkSync(path.join(outside, 'keys.txt'), path.join(allowed, 'keys.txt'));

    const broker = new Broker({ workspaceDir: ws, permissions: Permissions.parse({ fs: { read: [allowed] } }), scratchDir: scratch('sec21') });
    // Lexically inside; really outside. The real path is what decides (D-27).
    await expect(broker.read(path.join(allowed, 'keys.txt'))).rejects.toThrow(/not under any path/);
  });

  it('writing through a symlink does not touch what it points at', async () => {
    const ws = tempWorkspace('sec21-write');
    const allowed = path.join(ws, 'shared');
    fs.mkdirSync(allowed, { recursive: true });
    const target = path.join(ws, 'target.txt');
    fs.writeFileSync(target, 'original');
    fs.symlinkSync(target, path.join(allowed, 'link.txt'));

    const broker = new Broker({ workspaceDir: ws, permissions: Permissions.parse({ fs: { read: [allowed], write: [allowed] } }), scratchDir: scratch('sec21') });
    await expect(broker.write(path.join(allowed, 'link.txt'), 'overwritten')).rejects.toThrow();
    expect(fs.readFileSync(target, 'utf8'), 'the file the link pointed at is untouched').toBe('original');
  });

  it('the case rule matches this platform', async () => {
    const ws = tempWorkspace('sec21-case');
    const allowed = path.join(ws, 'Shared');
    fs.mkdirSync(allowed, { recursive: true });
    fs.writeFileSync(path.join(allowed, 'note.txt'), 'hello');
    const broker = new Broker({ workspaceDir: ws, permissions: Permissions.parse({ fs: { read: [allowed] } }), scratchDir: scratch('sec21') });

    const wrongCase = path.join(ws, 'shared', 'note.txt');
    if (process.platform === 'linux') {
      // Case-sensitive: `shared` is a different directory, and there is nothing there.
      await expect(broker.read(wrongCase)).rejects.toThrow();
    } else {
      // Case-insensitive: the same file, and the grant covers it.
      expect(await broker.read(wrongCase)).toBe('hello');
    }
  });
});

describe('SEC-22 what a sandboxed script can and cannot do', () => {
  it.skipIf(!DENO)('cannot even read its own environment, let alone a credential in it', async () => {
    const key = `AIzaFake${randomBytes(12).toString('hex')}`;
    process.env['WORKBENCH_CRED_TESTONLY'] = key;
    try {
      // The sandbox generates no `--allow-env`, so this is stronger than "the credential is not there": the
      // script cannot enumerate the environment at all, and asking for one variable by name is refused too.
      const result = await runScript(`
        try { Deno.env.toObject(); console.log('read the environment'); }
        catch (e) { console.log('environment refused', e.name); }
        try { console.log('by name', Deno.env.get('WORKBENCH_CRED_TESTONLY')); }
        catch (e) { console.log('by name refused', e.name); }
      `);
      expect(result.stdout).toContain('environment refused NotCapable');
      expect(result.stdout).toContain('by name refused NotCapable');
      expect(result.stdout).not.toContain(key);

      // And what the parent would have handed it carries no credential either, which is the other half: a future
      // sandbox that did allow env would still see nothing (D-33).
      const handed = new Sandbox(DENO).spawnArgs({
        scriptPath: '/tmp/x.ts',
        policy: { scratchDir: '/tmp', read: [], write: [] },
        env: childEnv(process.env as Record<string, string>),
      }).env;
      expect(Object.keys(handed).some((k) => k.startsWith('WORKBENCH_'))).toBe(false);
      expect(JSON.stringify(handed)).not.toContain(key);
    } finally {
      delete process.env['WORKBENCH_CRED_TESTONLY'];
    }
  }, 60_000);

  it.skipIf(!DENO)('cannot open a socket of its own', async () => {
    const result = await runScript(`
      try {
        await fetch('https://example.com');
        console.log('fetched');
      } catch (e) {
        console.log('refused', e.name);
      }
      try {
        await Deno.connect({ hostname: '127.0.0.1', port: 80 });
        console.log('connected');
      } catch (e) {
        console.log('connect refused', e.name);
      }
    `);
    expect(result.stdout).toContain('refused NotCapable');
    expect(result.stdout).toContain('connect refused NotCapable');
    expect(result.stdout).not.toContain('fetched');
  }, 60_000);

  it.skipIf(!DENO)('cannot write outside the roots it was given, or read outside them', async () => {
    const allowed = scratch('sec22-allowed');
    const forbidden = scratch('sec22-forbidden');
    fs.writeFileSync(path.join(forbidden, 'secret.txt'), 'a secret');

    const result = await runScript(`
      await Deno.writeTextFile(${JSON.stringify(path.join(allowed, 'ok.txt'))}, 'fine');
      console.log('wrote inside', await Deno.readTextFile(${JSON.stringify(path.join(allowed, 'ok.txt'))}));
      try {
        await Deno.writeTextFile(${JSON.stringify(path.join(forbidden, 'nope.txt'))}, 'x');
        console.log('wrote outside');
      } catch (e) {
        console.log('write refused', e.name);
      }
      try {
        console.log('read outside', await Deno.readTextFile(${JSON.stringify(path.join(forbidden, 'secret.txt'))}));
      } catch (e) {
        console.log('read refused', e.name);
      }
    `, { read: [allowed], write: [allowed] });

    expect(result.stdout).toContain('wrote inside fine');
    expect(result.stdout).toContain('write refused NotCapable');
    expect(result.stdout).toContain('read refused NotCapable');
    expect(result.stdout).not.toContain('a secret');
    expect(fs.existsSync(path.join(forbidden, 'nope.txt'))).toBe(false);
  }, 60_000);

  it.skipIf(!DENO)('a runaway loop is killed, and says so', async () => {
    const result = await runScript('for (;;) {}', {}, { ...DEFAULT_LIMITS, wallClockMs: 1500 });
    expect(result.killedBy).toBe('timeout');
    expect(result.ok).toBe(false);
  }, 60_000);

  it.skipIf(!DENO)('a script that prints without stopping is killed too', async () => {
    const result = await runScript("for (;;) console.log('x'.repeat(1000));", {}, { ...DEFAULT_LIMITS, wallClockMs: 20_000, maxOutputBytes: 32 * 1024 });
    expect(result.killedBy).toBe('output');
  }, 60_000);

  it.skipIf(!DENO)('cannot start a subprocess, which is how it cannot escape', async () => {
    // A program that certainly exists on this platform. `echo` is a cmd builtin rather than a binary on
    // Windows, so naming it there produced NotFound — a refusal for the wrong reason, which would have passed
    // this assertion even with --allow-run granted. Only a program Deno could really have started proves the
    // permission is what stopped it.
    const WIN = process.platform === 'win32';
    const program = WIN ? 'C:\\Windows\\System32\\cmd.exe' : '/bin/sh';
    // Arguments that exit immediately, so a granted permission fails the assertion instead of hanging the suite.
    const args = WIN ? ['/c', 'exit'] : ['-c', 'exit 0'];
    const result = await runScript(`
      try {
        const command = new Deno.Command(${JSON.stringify(program)}, { args: ${JSON.stringify(args)} });
        await command.output();
        console.log('ran');
      } catch (e) {
        console.log('run refused', e.name);
      }
    `);
    expect(result.stdout, `refusing ${program}`).toContain('run refused NotCapable');
    expect(result.stdout).not.toContain('ran');
  }, 60_000);
});

describe('SEC-23 without Deno there is no execution path at all', () => {
  it('the flags a sandbox would generate never widen to net, run, ffi, or everything', () => {
    const flags = sandboxFlags({ scratchDir: '/w/scratch', read: ['/w/a'], write: ['/w/b'] });
    for (const forbidden of ['--allow-net', '--allow-run', '--allow-ffi', '--allow-all', '-A', '--allow-env', '--unstable']) {
      expect(flags.some((f) => f === forbidden || f.startsWith(`${forbidden}=`)), `${forbidden} is never generated`).toBe(false);
    }
  });

  it('a sandbox with no Deno refuses rather than falling back', async () => {
    const sandbox = new Sandbox(null);
    expect(sandbox.available).toBe(false);
    expect(() => sandbox.spawnArgs({ scriptPath: '/tmp/x.ts', policy: { scratchDir: '/tmp', read: [], write: [] }, env: {} }))
      .toThrow(/Deno is not installed/);
  });

  it('the execute tier is unavailable, by name, and the screen says which tools', async () => {
    const ws = tempWorkspace('sec23');
    const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true, denoPath: null });
    try {
      const tools = (await (await fetch(`${rt.baseUrl}/api/v1/tools`, { headers: headers(rt) })).json()) as ToolsResponse;
      expect(tools.sandbox.available).toBe(false);
      expect(tools.sandbox.disabled.sort()).toEqual(['code.execute', 'fs.write', 'shell']);
      for (const tool of tools.tools.filter((t) => t.tier === 'execute')) {
        // The one exception, by design: `check` runs a repository's own declared gate on the host, outside
        // the sandbox, because the gate spawns what a sandbox cannot (D-66, SEC-35). It takes no command
        // from the agent, so a machine without Deno keeps it — and says so rather than hiding it.
        if (tool.id === 'check') {
          expect(tool.available, 'check runs on the host and does not need the sandbox').toBe(true);
          continue;
        }
        expect(tool.available, `${tool.id} is not available without a sandbox`).toBe(false);
      }
    } finally {
      await rt.stop();
    }
  }, 60_000);
});

describe('SEC-24 an MCP server is a subprocess like any other', () => {
  const server = path.join(process.cwd(), 'node_modules', '@modelcontextprotocol', 'server-filesystem', 'dist', 'index.js');

  it.skipIf(!fs.existsSync(server))('sees no credential, and its write tools ask a human', async () => {
    const key = `AIzaFake${randomBytes(12).toString('hex')}`;
    process.env['WORKBENCH_CRED_MCPTEST'] = key;
    try {
      const ws = tempWorkspace('sec24');
      const shared = path.join(ws, 'shared');
      fs.mkdirSync(shared, { recursive: true });
      const file = path.join(ws, 'config', 'workbench.json');
      const config = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      config['mcp'] = { servers: [{ name: 'files', command: process.execPath, args: [server, shared] }] };
      config['grants'] = { weaver: { tools: { 'mcp.files.write_file': 'allow' } } };
      fs.writeFileSync(file, JSON.stringify(config, null, 2));

      // The server is asked to write a file whose content is the environment it can see. If a credential had
      // reached it, it would be in that file — and the approval is what stops the write from happening at all.
      fs.writeFileSync(path.join(ws, 'fixtures', 'aa0-done.json'), JSON.stringify({
        match: { systemIncludes: 'The Weaver', afterTool: 'mcp.files.write_file' },
        respond: { text: 'It was refused, so I did not write it.' },
      }));
      fs.writeFileSync(path.join(ws, 'fixtures', 'aa1-write.json'), JSON.stringify({
        match: { systemIncludes: 'The Weaver' },
        respond: { text: 'Writing.', toolCalls: [{ name: 'mcp.files.write_file', input: { path: path.join(shared, 'env.txt'), content: 'x' } }] },
      }));

      const rt = await startRuntime(ws, { providerOverride: 'mock', noScheduler: true });
      try {
        const tools = (await (await fetch(`${rt.baseUrl}/api/v1/tools`, { headers: headers(rt) })).json()) as ToolsResponse;
        const write = tools.tools.find((t) => t.id === 'mcp.files.write_file')!;
        expect(write.tier, 'not annotated read-only, so it is a write').toBe('write');
        expect(write.approvalByDefault, 'and a write from outside asks every time').toBe(true);

        const { runId, done } = rt.runtime.engine.startAgentRun({ agentId: 'weaver', inputs: { input: 'Write.' }, project: 'anthology' });
        await waitFor(async () => {
          const detail = (await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}`, { headers: headers(rt) })).json()) as { state: string };
          return detail.state === 'waiting_approval';
        }, 30_000);

        const approvals = ((await (await fetch(`${rt.baseUrl}/api/v1/approvals`, { headers: headers(rt) })).json()) as { approvals: ApprovalItem[] }).approvals;
        expect(approvals[0]!.actions[0]!.tool).toBe('mcp.files.write_file');
        await fetch(`${rt.baseUrl}/api/v1/approvals/${approvals[0]!.batchId}`, { method: 'POST', headers: headers(rt), body: JSON.stringify({ decision: 'deny' }) });
        await done;

        expect(fs.existsSync(path.join(shared, 'env.txt')), 'a refused write did not reach the server').toBe(false);

        // And nothing about the credential is anywhere in this run.
        const trace = (await (await fetch(`${rt.baseUrl}/api/v1/runs/${runId}/trace.jsonl`, { headers: headers(rt) })).text());
        expect(trace).not.toContain(key);
      } finally {
        await rt.stop();
      }
    } finally {
      delete process.env['WORKBENCH_CRED_MCPTEST'];
    }
  }, 120_000);

  it('childEnv refuses to hand a credential to any child, MCP servers included', () => {
    expect(() => childEnv({ PATH: '/usr/bin' }, { WORKBENCH_CRED_GOOGLE: 'AIzaSomething' })).toThrow(/refusing to pass credential/);

    // The allowlist is per-platform because the variables are: HOME and TMPDIR do not exist on Windows, and a
    // child there cannot start without SystemRoot. What does not vary is the part this case is about — an
    // unlisted name is dropped whatever it is called, and PATH survives so the child can find anything at all.
    const env = childEnv({ PATH: '/usr/bin', HOME: '/home/x', SystemRoot: 'C:\\Windows', SECRET_TOKEN: 'nope' }, { NODE_ENV: 'test' });
    expect(Object.keys(env), 'an unlisted variable is never passed through').not.toContain('SECRET_TOKEN');
    expect(Object.keys(env)).toContain('PATH');
    expect(Object.keys(env), 'extras are added after the allowlist, not filtered by it').toContain('NODE_ENV');
    expect(Object.keys(env)).toContain(process.platform === 'win32' ? 'SystemRoot' : 'HOME');
    expect(Object.keys(env), 'the other platform\'s variables are not carried along').not.toContain(process.platform === 'win32' ? 'HOME' : 'SystemRoot');
  });
});

