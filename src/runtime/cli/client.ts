// The CLI is an HTTP client (D-45): find the live runtime through data/runtime.json, else run an ephemeral one in-process.
import fs from 'node:fs';
import type { Bootstrap } from '../bootstrap.js';
import { workspacePaths, type WorkspacePaths } from '../paths.js';
import { Runtime, type RuntimeFile } from '../runtime.js';
import type { HealthResponse, ApiError } from '../../shared/api/index.js';

export interface RuntimeHandle {
  baseUrl: string;
  token: string;
  ephemeral: boolean;
  request<T>(method: string, apiPath: string, body?: unknown): Promise<T>;
  requestText(apiPath: string): Promise<string>;
  close(): Promise<void>;
}

export class CliError extends Error {
  constructor(message: string, readonly exitCode = 1) { super(message); this.name = 'CliError'; }
}

export interface LiveRuntime { port: number; pid: number; startedAt: string; token: string }

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A runtime is alive when the file's pid runs and /health returns the same startedAt; a stale file is deleted. */
export async function findLiveRuntime(paths: WorkspacePaths): Promise<LiveRuntime | null> {
  if (!fs.existsSync(paths.runtimeJson)) return null;
  let file: RuntimeFile | null = null;
  try {
    file = JSON.parse(fs.readFileSync(paths.runtimeJson, 'utf8')) as RuntimeFile;
  } catch {
    file = null;
  }
  const stale = (): null => {
    fs.rmSync(paths.runtimeJson, { force: true });
    fs.rmSync(paths.runtimeToken, { force: true });
    return null;
  };
  if (!file || typeof file.port !== 'number' || typeof file.pid !== 'number' || typeof file.startedAt !== 'string') return stale();
  if (!pidAlive(file.pid)) return stale();
  try {
    const res = await fetch(`http://127.0.0.1:${file.port}/api/v1/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return stale();
    const health = (await res.json()) as HealthResponse;
    if (health.startedAt !== file.startedAt) return stale();
  } catch {
    return stale();
  }
  if (!fs.existsSync(paths.runtimeToken)) return stale();
  const token = fs.readFileSync(paths.runtimeToken, 'utf8').trim();
  return { port: file.port, pid: file.pid, startedAt: file.startedAt, token };
}

export interface ConnectOptions {
  workspaceDir: string;
  bootstrap: Bootstrap;
  /** Refuse to start an ephemeral runtime (`--detach` needs a live one). */
  requireLive?: boolean | undefined;
}

export async function connect(opts: ConnectOptions): Promise<RuntimeHandle> {
  const paths = workspacePaths(opts.workspaceDir);
  const live = await findLiveRuntime(paths);
  if (live) return makeHandle(`http://127.0.0.1:${live.port}`, live.token, false, async () => undefined);
  if (opts.requireLive) {
    throw new CliError(`No runtime is running for ${paths.dir}. Start one with: workbench start --workspace "${paths.dir}"`);
  }
  const runtime = await Runtime.create({ workspaceDir: opts.workspaceDir, bootstrap: opts.bootstrap, ephemeral: true, quietLog: true });
  await runtime.start();
  return makeHandle(runtime.baseUrl, runtime.token, true, () => runtime.stop());
}

function makeHandle(baseUrl: string, token: string, ephemeral: boolean, close: () => Promise<void>): RuntimeHandle {
  const headers = (): Record<string, string> => ({ Authorization: `Bearer ${token}` });
  const explain = async (res: Response): Promise<never> => {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as ApiError;
      if (body.error?.message) message = `${body.error.message} (${body.error.code})`;
    } catch {
      // not JSON
    }
    throw new CliError(message);
  };
  return {
    baseUrl,
    token,
    ephemeral,
    async request<T>(method: string, apiPath: string, body?: unknown): Promise<T> {
      const res = await fetch(`${baseUrl}/api/v1${apiPath}`, {
        method,
        headers: { ...headers(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (!res.ok) return explain(res);
      return (await res.json()) as T;
    },
    async requestText(apiPath: string): Promise<string> {
      const res = await fetch(`${baseUrl}/api/v1${apiPath}`, { headers: headers() });
      if (!res.ok) return explain(res);
      return res.text();
    },
    close,
  };
}
