// The repository tools (D-66). Narrower than `shell` and wider than `fs.write`: an agent granted a checkout can
// read it, edit it on a run branch, run the repository's own gate, commit and push — and cannot merge, cannot
// force, cannot touch `main`, and cannot name a command. Every tool here is one call on `ctx.repo`, where the
// grant decides; nothing in this file opens a file or spawns a process.
import { z } from 'zod';
import { Permissions } from '../../../shared/permissions.js';
import { toolError, type ToolDefinition, type ToolResult } from '../../../shared/tool.js';
import { PolicyError } from '../../security/broker.js';
import { ANY_REPO } from '../../security/permissions.js';

/** A ceiling: the grant a human writes is what these tools actually get. */
const ANY_REPOSITORY = Permissions.parse({ repos: [ANY_REPO] });

const repoArg = z.string().min(1).optional().describe('The granted repository\'s absolute path. Omit it when you are granted exactly one.');
const relPath = z.string().min(1).describe('A path relative to the repository root, with forward slashes.');

async function attempt<O>(work: () => Promise<O>): Promise<ToolResult<O>> {
  try {
    return { ok: true, output: await work() };
  } catch (e) {
    if (e instanceof PolicyError) return toolError(e.code, e.message, e.hint);
    return toolError('ToolError', (e as Error).message);
  }
}

export function repoTools(): ToolDefinition[] {
  const read: ToolDefinition<{ repo?: string | undefined; path: string }, { path: string; content: string; bytes: number }> = {
    id: 'repo.read',
    version: '1.0.0',
    description: 'Read one text file from a repository you have been granted. Never .git/ internals or a credentials-shaped file.',
    input: z.object({ repo: repoArg, path: relPath }),
    output: z.object({ path: z.string(), content: z.string(), bytes: z.number().int() }),
    tier: 'read',
    maxPermissions: ANY_REPOSITORY,
    execute: (input, ctx) => attempt(async () => {
      const repo = await ctx.repo.open(input.repo);
      const content = await repo.read(input.path);
      return { path: input.path, content, bytes: Buffer.byteLength(content) };
    }),
  };

  const list: ToolDefinition<{ repo?: string | undefined; path?: string | undefined }, { path: string; entries: { path: string; kind: string; bytes: number }[] }> = {
    id: 'repo.list',
    version: '1.0.0',
    description: 'List a directory of a repository you have been granted. Paths come back repository-relative.',
    input: z.object({ repo: repoArg, path: relPath.default('.') }),
    output: z.object({ path: z.string(), entries: z.array(z.object({ path: z.string(), kind: z.string(), bytes: z.number().int() })) }),
    tier: 'read',
    maxPermissions: ANY_REPOSITORY,
    execute: (input, ctx) => attempt(async () => {
      const repo = await ctx.repo.open(input.repo);
      const entries = await repo.list(input.path ?? '.');
      return { path: input.path ?? '.', entries };
    }),
  };

  const write: ToolDefinition<{ repo?: string | undefined; path: string; content: string }, { path: string; bytes: number; branch: string }> = {
    id: 'repo.write',
    version: '1.0.0',
    description: 'Write one text file in a repository you have been granted, replacing it if it exists. Works only while the checkout is on a branch the grant covers: create one with git.branch first.',
    input: z.object({ repo: repoArg, path: relPath, content: z.string() }),
    output: z.object({ path: z.string(), bytes: z.number().int(), branch: z.string() }),
    tier: 'write',
    maxPermissions: ANY_REPOSITORY,
    execute: (input, ctx) => attempt(async () => {
      const repo = await ctx.repo.open(input.repo);
      await repo.write(input.path, input.content);
      const status = await repo.git.status();
      return { path: input.path, bytes: Buffer.byteLength(input.content), branch: status.branch ?? '' };
    }),
  };

  const status: ToolDefinition<{ repo?: string | undefined }, { branch: string | null; upstream: string | null; ahead: number; behind: number; clean: boolean; entries: { path: string; status: string }[] }> = {
    id: 'git.status',
    version: '1.0.0',
    description: 'The branch the checkout is on and every changed, added or untracked file.',
    input: z.object({ repo: repoArg }),
    output: z.object({
      branch: z.string().nullable(), upstream: z.string().nullable(), ahead: z.number().int(), behind: z.number().int(), clean: z.boolean(),
      entries: z.array(z.object({ path: z.string(), status: z.string() })),
    }),
    tier: 'read',
    maxPermissions: ANY_REPOSITORY,
    execute: (input, ctx) => attempt(async () => (await ctx.repo.open(input.repo)).git.status()),
  };

  const diff: ToolDefinition<{ repo?: string | undefined; staged?: boolean | undefined; path?: string | undefined }, { diff: string; bytes: number }> = {
    id: 'git.diff',
    version: '1.0.0',
    description: 'The working tree\'s changes as a unified diff — what you have edited and not yet committed. `staged: true` shows what is staged instead; `path` narrows it to one file or directory.',
    input: z.object({ repo: repoArg, staged: z.boolean().optional(), path: relPath.optional() }),
    output: z.object({ diff: z.string(), bytes: z.number().int() }),
    tier: 'read',
    maxPermissions: ANY_REPOSITORY,
    execute: (input, ctx) => attempt(async () => {
      const text = await (await ctx.repo.open(input.repo)).git.diff({ staged: input.staged, path: input.path });
      return { diff: text, bytes: Buffer.byteLength(text) };
    }),
  };

  const log: ToolDefinition<{ repo?: string | undefined; count?: number | undefined }, { entries: { sha: string; author: string; date: string; subject: string }[] }> = {
    id: 'git.log',
    version: '1.0.0',
    description: 'The most recent commits on the current branch, newest first.',
    input: z.object({ repo: repoArg, count: z.number().int().min(1).max(100).default(10) }),
    output: z.object({ entries: z.array(z.object({ sha: z.string(), author: z.string(), date: z.string(), subject: z.string() })) }),
    tier: 'read',
    maxPermissions: ANY_REPOSITORY,
    execute: (input, ctx) => attempt(async () => ({ entries: await (await ctx.repo.open(input.repo)).git.log(input.count ?? 10) })),
  };

  const branch: ToolDefinition<{ repo?: string | undefined; name: string }, { branch: string; created: boolean }> = {
    id: 'git.branch',
    version: '1.0.0',
    description: 'Create a branch, or switch to one that exists. Only a name the grant\'s pattern allows (run/* by default); never main.',
    input: z.object({ repo: repoArg, name: z.string().min(1).describe('The branch name, e.g. run/16-repository-tools.') }),
    output: z.object({ branch: z.string(), created: z.boolean() }),
    tier: 'write',
    maxPermissions: ANY_REPOSITORY,
    execute: (input, ctx) => attempt(async () => (await ctx.repo.open(input.repo)).git.branch(input.name)),
  };

  const commit: ToolDefinition<{ repo?: string | undefined; message: string }, { sha: string; branch: string; files: string[]; skipped: string[] }> = {
    id: 'git.commit',
    version: '1.0.0',
    description: 'Stage every change in the working tree and commit it on the current run branch, as you, with the run id in the message. A credentials-shaped file is left unstaged and named in `skipped`.',
    input: z.object({ repo: repoArg, message: z.string().min(1).max(4000).describe('What changed and why, first line under 72 characters.') }),
    output: z.object({ sha: z.string(), branch: z.string(), files: z.array(z.string()), skipped: z.array(z.string()) }),
    tier: 'write',
    maxPermissions: ANY_REPOSITORY,
    execute: (input, ctx) => attempt(async () => (await ctx.repo.open(input.repo)).git.commit(input.message)),
  };

  const push: ToolDefinition<{ repo?: string | undefined; remote?: string | undefined }, { branch: string; remote: string; output: string }> = {
    id: 'git.push',
    version: '1.0.0',
    description: 'Push the current branch to a remote (origin by default), setting it as upstream. Refused by name for any branch outside the grant\'s pattern, main first among them. There is no force push.',
    input: z.object({ repo: repoArg, remote: z.string().min(1).optional() }),
    output: z.object({ branch: z.string(), remote: z.string(), output: z.string() }),
    tier: 'write',
    maxPermissions: ANY_REPOSITORY,
    usesNetwork: true,
    execute: (input, ctx) => attempt(async () => (await ctx.repo.open(input.repo)).git.push(input.remote)),
  };

  const check: ToolDefinition<{ repo?: string | undefined }, { ok: boolean; exitCode: number | null; durationMs: number; output: string; truncated: boolean; fullOutput?: string | undefined; command: string; killedBy: string | null }> = {
    id: 'check',
    version: '1.0.0',
    description: 'Run the repository\'s own check — the command a person declared in its .workbench/repo.json — and read the verdict. You do not choose the command. Long output is cut to its end; the whole transcript is in this run\'s scratch.',
    input: z.object({ repo: repoArg }),
    output: z.object({
      ok: z.boolean(), exitCode: z.number().int().nullable(), durationMs: z.number().int(), output: z.string(), truncated: z.boolean(),
      fullOutput: z.string().optional(), command: z.string(), killedBy: z.string().nullable(),
    }),
    tier: 'execute',
    maxPermissions: ANY_REPOSITORY,
    // Execute-tier, and on the host: the gate is the owner's own command and spawns what a sandbox cannot (D-66).
    runsOnHost: true,
    execute: (input, ctx) => attempt(async () => (await ctx.repo.open(input.repo)).check()),
  };

  return [read, list, write, status, diff, log, branch, commit, push, check];
}
