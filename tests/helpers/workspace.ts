// Shared test plumbing: temp workspaces, in-process runtimes, and CLI subprocesses.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packagePaths } from '../../src/runtime/paths.js';
import { initWorkspace } from '../../src/runtime/workspace/loader.js';
import { readBootstrap } from '../../src/runtime/bootstrap.js';
import { Runtime, type RuntimeOptions } from '../../src/runtime/runtime.js';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/**
 * tsx's own JS entry, not the `.bin` shim. Since CVE-2024-27980 Node refuses to spawn a `.cmd` or `.bat`
 * without `shell: true`, and on Windows the shim *is* a `.cmd` — spawnSync returns `status: null` and the
 * failure reads as "the assertion is wrong" rather than "the process never started". Running the entry with
 * this Node avoids the shell, the quoting that comes with it, and the platform branch altogether.
 */
export const TSX_ENTRY = path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
export const TSX = process.execPath;
export const CLI_SRC = path.join(REPO, 'src', 'runtime', 'cli', 'main.ts');
export const CLI_DIST = path.join(REPO, 'dist', 'cli.js');

export function tempDir(prefix = 'wb'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

export function tempWorkspace(prefix = 'wb-ws'): string {
  const dir = tempDir(prefix);
  const pkg = packagePaths();
  initWorkspace(dir, pkg.examplesWorkspace, pkg.defaults, 'test');
  return dir;
}

export interface Started { runtime: Runtime; port: number; baseUrl: string; token: string; url: string; stop(): Promise<void> }

export async function startRuntime(workspaceDir: string, opts: Partial<RuntimeOptions> = {}): Promise<Started> {
  const runtime = await Runtime.create({ workspaceDir, bootstrap: readBootstrap(), ephemeral: true, quietLog: true, bind: '127.0.0.1', ...opts });
  const { port, url } = await runtime.start();
  return { runtime, port, baseUrl: runtime.baseUrl, token: runtime.token, url, stop: () => runtime.stop() };
}

export function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('WORKBENCH_')) env[k] = v;
  return { ...env, ...extra };
}

export interface CliResult { code: number | null; stdout: string; stderr: string }

/** Runs the CLI from source (tsx) or from dist, to completion. */
export function runCli(args: string[], opts: { dist?: boolean; env?: Record<string, string>; cwd?: string } = {}): Promise<CliResult> {
  const cmd = process.execPath;
  const argv = opts.dist ? [CLI_DIST, ...args] : [TSX_ENTRY, CLI_SRC, ...args];
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { cwd: opts.cwd ?? REPO, env: cleanEnv(opts.env), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * What `stop()` can promise, per platform. On POSIX it sends SIGTERM, the runtime's handler runs, and the
 * process chooses exit code 0. Windows has no SIGTERM at all: `child.kill()` there is TerminateProcess, so no
 * handler runs, the process never chooses a code, and Node reports the exit as a signal with `code: null`.
 * That is the platform, not a defect — but it means "cleans up on SIGTERM" is a POSIX claim, and a test that
 * asserts it everywhere is asserting the platform instead of the promise.
 */
export const GRACEFUL_EXIT: number | null = process.platform === 'win32' ? null : 0;

/** Whether this platform can ask a child to shut itself down at all. See `GRACEFUL_EXIT`. */
export const CAN_SIGNAL_CHILD = process.platform !== 'win32';

export interface StartedCli { child: ChildProcess; url: string; port: number; token: string; stdout(): string; stderr(): string; stop(): Promise<number | null> }

/** Starts `workbench start` and resolves once it prints its URL line. */
export function startCli(args: string[], opts: { dist?: boolean; env?: Record<string, string> } = {}): Promise<StartedCli> {
  const cmd = process.execPath;
  const argv = opts.dist ? [CLI_DIST, 'start', ...args] : [TSX_ENTRY, CLI_SRC, 'start', ...args];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { cwd: REPO, env: cleanEnv(opts.env), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let resolved = false;
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      const nl = out.indexOf('\n');
      if (!resolved && nl !== -1) {
        resolved = true;
        const url = out.slice(0, nl);
        const m = /^http:\/\/127\.0\.0\.1:(\d+)\/#token=([A-Za-z0-9_-]+)$/.exec(url);
        if (!m) { reject(new Error(`unexpected first stdout line: ${url}`)); return; }
        resolve({
          child,
          url,
          port: Number(m[1]),
          token: m[2]!,
          stdout: () => out,
          stderr: () => err,
          stop: () => new Promise<number | null>((r) => { child.once('exit', (code) => r(code)); child.kill('SIGTERM'); }),
        });
      }
    });
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('exit', (code) => { if (!resolved) reject(new Error(`start exited early (${code}): ${err}`)); });
  });
}

export async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 10_000, everyMs = 50): Promise<void> {
  const t0 = Date.now();
  while (!(await pred())) {
    if (Date.now() - t0 > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** Collects SSE `event:` names from a fetch-based stream until aborted. */
export function collectSse(url: string, token: string, signal: AbortSignal): { events: string[]; done: Promise<void> } {
  const events: string[] = [];
  const done = (async () => {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' }, signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        buf += decoder.decode(value, { stream: true });
        for (const m of buf.matchAll(/^event: (.+)$/gm)) events.push(m[1]!);
        buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
      }
    } catch {
      // aborted
    }
  })();
  return { events, done };
}
