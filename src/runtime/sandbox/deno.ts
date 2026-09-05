// The sandbox (D-30). Nothing the workbench executes runs in this process: `node:vm` is not a sandbox, and the
// lint config bans it so nobody can quietly decide otherwise. Code runs in Deno, with permissions generated from
// the same effective policy the broker uses — read roots it may read, write roots it may write, and nothing else.
// No `--allow-net` and no `--allow-run` are ever generated: a sandboxed script reaches the network through the
// tool bridge, where the egress checker sees it, or it does not reach the network at all.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { findExecutable, hasUnspawnableShim } from '../util/exec.js';

export interface SandboxLimits {
  /** Wall clock. The process is killed at this, and the kill is the result, not an error to retry. */
  wallClockMs: number;
  /** V8 heap ceiling, in megabytes. */
  memoryMb: number;
  /** Bytes of stdout+stderr kept. Past this the process is killed: a loop that prints is still a loop. */
  maxOutputBytes: number;
}

export const DEFAULT_LIMITS: SandboxLimits = { wallClockMs: 30_000, memoryMb: 256, maxOutputBytes: 256 * 1024 };

export interface SandboxPolicy {
  /** Absolute paths the script may read. Empty means it may read nothing but its own scratch. */
  read: string[];
  /** Absolute paths the script may write. The scratch directory is always one of them. */
  write: string[];
  /** Where the script runs, and the one directory it can always use. */
  scratchDir: string;
}

export interface SandboxSpawn {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/**
 * The flags, from the policy. Deno's own defaults are deny; every flag here widens, so this function is the
 * whole of what a script can do, and it is the thing the DoD asserts on rather than on a behaviour that might
 * pass for the wrong reason.
 */
export function sandboxFlags(policy: SandboxPolicy, limits: SandboxLimits = DEFAULT_LIMITS): string[] {
  const read = unique([policy.scratchDir, ...policy.read]);
  const write = unique([policy.scratchDir, ...policy.write]);
  return [
    'run',
    '--quiet',
    // A prompt would hang a headless run forever, and answering one is not a decision a model gets to make.
    '--no-prompt',
    `--allow-read=${read.join(',')}`,
    `--allow-write=${write.join(',')}`,
    // Everything else is denied by omission. These three are named anyway, because a future Deno that widens a
    // default would otherwise widen this sandbox silently.
    '--deny-net',
    '--deny-run',
    '--deny-ffi',
    `--v8-flags=--max-old-space-size=${limits.memoryMb}`,
  ];
}

export class SandboxUnavailable extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'SandboxUnavailable';
  }
}

export interface SandboxResult {
  ok: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Why it stopped, when it did not stop on its own. */
  killedBy: 'timeout' | 'output' | 'cancelled' | null;
  durationMs: number;
}

export interface RunScriptInput {
  scriptPath: string;
  policy: SandboxPolicy;
  limits?: SandboxLimits | undefined;
  /** The environment the child sees. Built by `childEnv`; never `process.env` (D-33). */
  env: Record<string, string>;
  signal?: AbortSignal | undefined;
  /** Called with each complete line the script writes on stdout — where the tool bridge lives (D-55). */
  onStdoutLine?: ((line: string) => void) | undefined;
  /** Handed the child so the bridge can write its replies back on stdin. */
  onSpawn?: ((child: ChildProcessWithoutNullStreams) => void) | undefined;
}

export class Sandbox {
  constructor(private readonly denoPath: string | null, private readonly limits: SandboxLimits = DEFAULT_LIMITS) {}

  /** `null` when Deno is not installed. Every execute-tier tool refuses by name rather than falling back. */
  get available(): boolean {
    return this.denoPath !== null;
  }

  get path(): string | null {
    return this.denoPath;
  }

  spawnArgs(input: { scriptPath: string; policy: SandboxPolicy; env: Record<string, string>; limits?: SandboxLimits | undefined }): SandboxSpawn {
    if (!this.denoPath) throw new SandboxUnavailable('Deno is not installed, so nothing can be executed.');
    return {
      command: this.denoPath,
      args: [...sandboxFlags(input.policy, input.limits ?? this.limits), input.scriptPath],
      cwd: input.policy.scratchDir,
      env: input.env,
    };
  }

  async run(input: RunScriptInput): Promise<SandboxResult> {
    const limits = input.limits ?? this.limits;
    const spawnArgs = this.spawnArgs({ scriptPath: input.scriptPath, policy: input.policy, env: input.env, limits });
    const started = Date.now();

    return new Promise<SandboxResult>((resolve) => {
      const child = spawn(spawnArgs.command, spawnArgs.args, {
        cwd: spawnArgs.cwd,
        env: spawnArgs.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;
      input.onSpawn?.(child);

      let stdout = '';
      let stderr = '';
      let lineBuffer = '';
      let killedBy: SandboxResult['killedBy'] = null;
      let settled = false;

      const kill = (why: NonNullable<SandboxResult['killedBy']>): void => {
        if (settled) return;
        killedBy = why;
        child.kill('SIGKILL');
      };

      const timer = setTimeout(() => kill('timeout'), limits.wallClockMs);
      const onAbort = (): void => kill('cancelled');
      input.signal?.addEventListener('abort', onAbort, { once: true });

      const collect = (which: 'out' | 'err') => (chunk: Buffer): void => {
        if (which === 'out') {
          stdout += chunk.toString();
          // Whole lines only: a bridge call is one line, and half of one is not a call yet.
          lineBuffer += chunk.toString();
          for (;;) {
            const nl = lineBuffer.indexOf('\n');
            if (nl === -1) break;
            const line = lineBuffer.slice(0, nl);
            lineBuffer = lineBuffer.slice(nl + 1);
            input.onStdoutLine?.(line);
          }
        } else {
          stderr += chunk.toString();
        }
        if (stdout.length + stderr.length > limits.maxOutputBytes) {
          stdout = stdout.slice(0, limits.maxOutputBytes);
          stderr = stderr.slice(0, limits.maxOutputBytes);
          kill('output');
        }
      };
      child.stdout.on('data', collect('out'));
      child.stderr.on('data', collect('err'));

      const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) return;
        settled = true;
        // A last line with no newline after it is still a line.
        if (lineBuffer.trim()) { input.onStdoutLine?.(lineBuffer); lineBuffer = ''; }
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', onAbort);
        resolve({
          ok: killedBy === null && code === 0,
          code, signal, stdout, stderr, killedBy,
          durationMs: Date.now() - started,
        });
      };
      child.on('error', (e) => { stderr += `\n${e.message}`; finish(null, null); });
      child.on('close', (code, signal) => finish(code, signal));
    });
  }
}

/**
 * Where Deno is, on an explicit PATH (D-33). A workspace can pin one; otherwise it is whatever is installed,
 * including the copy `npm ci` puts in `node_modules/.bin`, which is how CI has one without a separate step.
 */
export function findDeno(pathVar: string | undefined, configured?: string | undefined): string | null {
  if (configured) return configured;
  const onPath = findExecutable('deno', pathVar);
  if (onPath) return onPath;
  // Then the copy npm installed with this workbench, whether PATH offered its shim or nothing at all: an owner
  // who runs `node dist/cli.js start` has no `node_modules/.bin` on PATH and still has a real Deno. A machine
  // with none anywhere still has no sandbox, which the execute tier reports rather than works around (D-30).
  void hasUnspawnableShim;
  return vendoredDeno();
}

/**
 * The `deno` npm package keeps its real binary inside its own directory and puts only a shim on PATH. On
 * Windows that shim is a `.cmd`, which cannot be spawned directly, so PATH alone reports no sandbox on a
 * machine that has one — and the execute tier would go quietly missing rather than loudly.
 */
function vendoredDeno(): string | null {
  const exe = process.platform === 'win32' ? 'deno.exe' : 'deno';
  const require_ = createRequire(import.meta.url);
  // Two places, because deno's own installer uses two. It normally hard-links the binary from the
  // platform package into its own directory; when that copy fails — a read-only or full disk — it keeps
  // running from the platform package instead. Looking in only the first would report "no sandbox" on a
  // machine that has one, which is the failure this function exists to prevent.
  const packages = ['deno', ...platformPackages()];
  for (const pkg of packages) {
    try {
      const candidate = path.join(path.dirname(require_.resolve(`${pkg}/package.json`)), exe);
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // not installed, which is a normal state: the tier is simply unavailable.
    }
  }
  return null;
}

/** The `@deno/<target>` package for this machine, named the way deno's installer names them. */
function platformPackages(): string[] {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'win32') return [`@deno/win32-${arch}`];
  if (process.platform === 'darwin') return [`@deno/darwin-${arch}`];
  if (process.platform === 'linux') return [`@deno/linux-${arch}-glibc`, `@deno/linux-${arch}-musl`];
  return [];
}

function unique(paths: string[]): string[] {
  return [...new Set(paths.map((p) => path.resolve(p)))];
}

export interface CommandInput {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  limits: SandboxLimits;
  signal: AbortSignal;
  /**
   * Run `command` as one line through the platform shell. Off for everything an agent chooses — `shell`'s
   * command and arguments are an array so there is nothing to quote wrong — and on for exactly one caller: a
   * repository's own gate, a line a person wrote into `.workbench/repo.json` that no tool can edit (SEC-35).
   * `npm run check` is that line, and on Windows `npm` is a `.cmd` that only a shell can start.
   */
  shell?: boolean | undefined;
}

/**
 * `shell`: one command as a direct child process, with the same scrubbed environment and limits the sandbox
 * gets — and, unavoidably, with whatever network the operating system gives it. That is why the tool asks a
 * human every time (tools-and-security.md §Sandbox); a container sandbox is the unlock, not this function.
 */
export function runCommand(input: CommandInput): Promise<Omit<SandboxResult, 'ok'> & { ok: boolean }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(input.shell ? { shell: true } : {}),
    });
    let stdout = '';
    let stderr = '';
    let killedBy: SandboxResult['killedBy'] = null;
    let settled = false;

    const kill = (why: NonNullable<SandboxResult['killedBy']>): void => {
      if (settled) return;
      killedBy = why;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => kill('timeout'), input.limits.wallClockMs);
    const onAbort = (): void => kill('cancelled');
    input.signal.addEventListener('abort', onAbort, { once: true });

    const collect = (which: 'out' | 'err') => (chunk: Buffer): void => {
      if (which === 'out') stdout += chunk.toString(); else stderr += chunk.toString();
      if (stdout.length + stderr.length > input.limits.maxOutputBytes) {
        stdout = stdout.slice(0, input.limits.maxOutputBytes);
        stderr = stderr.slice(0, input.limits.maxOutputBytes);
        kill('output');
      }
    };
    child.stdout?.on('data', collect('out'));
    child.stderr?.on('data', collect('err'));

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal.removeEventListener('abort', onAbort);
      resolve({ ok: killedBy === null && code === 0, code, signal, stdout, stderr, killedBy, durationMs: Date.now() - started });
    };
    child.on('error', (e) => { stderr += `\n${e.message}`; finish(null, null); });
    child.on('close', (code, signal) => finish(code, signal));
  });
}
