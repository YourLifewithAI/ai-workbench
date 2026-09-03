// Shared CLI plumbing: workspace resolution (flag > env > cwd), output helpers, error exit codes.
import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import type { Bootstrap } from '../bootstrap.js';
import { CliError } from './client.js';

export interface GlobalOptions { workspace?: string | undefined; json?: boolean | undefined }

export function resolveWorkspace(cmd: Command, bootstrap: Bootstrap): string {
  const opts = cmd.optsWithGlobals<GlobalOptions>();
  if (opts.workspace) return path.resolve(opts.workspace);
  if (bootstrap.workspace) return path.resolve(bootstrap.workspace);
  if (fs.existsSync(path.join(process.cwd(), 'workspace.json'))) return process.cwd();
  throw new CliError('No workspace given. Pass --workspace <path>, set WORKBENCH_WORKSPACE, or run inside a workspace directory. Create one with: workbench init <path>');
}

export function wantsJson(cmd: Command): boolean {
  return cmd.optsWithGlobals<GlobalOptions>().json === true;
}

export function out(line: string): void {
  process.stdout.write(line.endsWith('\n') ? line : line + '\n');
}

export function outJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

export function err(line: string): void {
  process.stderr.write(line.endsWith('\n') ? line : line + '\n');
}

/** Runs an action, mapping thrown errors to a message on stderr and a non-zero exit. */
export async function guarded(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const code = e instanceof CliError ? e.exitCode : 1;
    err(`error: ${(e as Error).message}`);
    process.exitCode = code;
  }
}
