// git, spawned directly (D-66). Never through a shell: every argument is an array element, every name an agent
// supplies is validated before it is one, and the environment is `childEnv()` like any other child (SEC-07).
// This module knows nothing about grants; `access.ts` decides, this runs.
import { findExecutable } from '../util/exec.js';
import { runCommand } from '../sandbox/deno.js';
import { PolicyError } from '../security/broker.js';
import type { GitLogEntry, GitStatus } from '../../shared/repo.js';

export interface GitExec {
  (args: string[], opts: { cwd: string; env: Record<string, string>; signal: AbortSignal; timeoutMs?: number }): Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string }>;
}

/** 4 MiB of output is more than any diff a model should be reading; past it the call is stopped, not trimmed. */
const MAX_OUTPUT = 4 * 1024 * 1024;

/** Locates `git` once, on the explicit PATH, and runs it. `null` when this machine has none. */
export function gitExec(pathVar: string | undefined): GitExec | null {
  const git = findExecutable('git', pathVar);
  if (!git) return null;
  return async (args, opts) => {
    const result = await runCommand({
      command: git,
      args,
      cwd: opts.cwd,
      // A credential prompt would hang a headless run forever, and answering one is not a thing a model does.
      env: { ...opts.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      limits: { wallClockMs: opts.timeoutMs ?? 60_000, memoryMb: 0, maxOutputBytes: MAX_OUTPUT },
      signal: opts.signal,
    });
    if (result.killedBy === 'timeout') throw new PolicyError('ToolUnavailable', `git ${args[0]} did not finish within ${Math.round((opts.timeoutMs ?? 60_000) / 1000)}s.`);
    if (result.killedBy === 'output') throw new PolicyError('ToolUnavailable', `git ${args[0]} produced more than ${MAX_OUTPUT / 1024 / 1024} MB of output and was stopped. Ask for less.`);
    return { ok: result.ok, code: result.code, stdout: result.stdout, stderr: result.stderr };
  };
}

export interface GitRepo {
  currentBranch(): Promise<string | null>;
  status(): Promise<GitStatus>;
  diff(input: { staged?: boolean | undefined; path?: string | undefined }): Promise<string>;
  log(count: number): Promise<GitLogEntry[]>;
  branchExists(name: string): Promise<boolean>;
  switchTo(name: string, create: boolean): Promise<void>;
  stageAll(): Promise<string[]>;
  unstage(files: string[]): Promise<void>;
  commit(message: string, author: { name: string; email: string }): Promise<string>;
  head(): Promise<string>;
  push(remote: string, branch: string): Promise<string>;
}

/** One checkout. Every method is one or two git invocations with a parsed answer; failures carry git's words. */
export function gitRepo(exec: GitExec, cwd: string, env: Record<string, string>, signal: AbortSignal): GitRepo {
  const run = async (args: string[], timeoutMs?: number): Promise<string> => {
    const result = await exec(args, { cwd, env, signal, ...(timeoutMs ? { timeoutMs } : {}) });
    if (!result.ok) throw new PolicyError('ToolUnavailable', `git ${args.filter((a) => !a.startsWith('-c') && a !== '-c').slice(0, 2).join(' ')} failed: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`);
    return result.stdout;
  };

  return {
    async currentBranch() {
      const result = await exec(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd, env, signal });
      if (!result.ok) {
        if (/not a git repository/i.test(result.stderr)) throw new PolicyError('ToolUnavailable', `${cwd} is not a git checkout.`);
        return null; // detached HEAD, or no commits yet on an unborn branch
      }
      return result.stdout.trim() || null;
    },
    async status() {
      const text = await run(['status', '--porcelain=v1', '--branch', '--untracked-files=all']);
      const lines = text.split('\n').filter((l) => l.length > 0);
      const head = lines[0]?.startsWith('## ') ? lines.shift()!.slice(3) : '';
      const status: GitStatus = { branch: null, upstream: null, ahead: 0, behind: 0, clean: lines.length === 0, entries: [] };
      const m = /^(?:No commits yet on )?([^ .]+)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(head);
      if (m) {
        status.branch = m[1] === 'HEAD' ? null : m[1]!;
        status.upstream = m[2] ?? null;
        const ahead = /ahead (\d+)/.exec(m[3] ?? '');
        const behind = /behind (\d+)/.exec(m[3] ?? '');
        status.ahead = ahead ? Number(ahead[1]) : 0;
        status.behind = behind ? Number(behind[1]) : 0;
      }
      for (const line of lines) {
        const code = line.slice(0, 2).trim();
        const file = line.slice(3);
        // A rename reads `R  old -> new`; the new name is the one that exists.
        status.entries.push({ status: code, path: file.includes(' -> ') ? file.split(' -> ')[1]! : file });
      }
      return status;
    },
    async diff(input) {
      const args = ['diff', '--no-color', '--no-ext-diff'];
      if (input.staged) args.push('--cached');
      if (input.path) args.push('--', input.path);
      return run(args);
    },
    async log(count) {
      const text = await run(['log', `-n${count}`, '--no-color', '--format=%H%x1f%an%x1f%aI%x1f%s']);
      return text.split('\n').filter((l) => l.length > 0).map((line) => {
        const [sha, author, date, subject] = line.split('\x1f');
        return { sha: sha ?? '', author: author ?? '', date: date ?? '', subject: subject ?? '' };
      });
    },
    async branchExists(name) {
      const result = await exec(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { cwd, env, signal });
      return result.ok;
    },
    async switchTo(name, create) {
      await run(create ? ['switch', '-c', name] : ['switch', name]);
    },
    async stageAll() {
      await run(['add', '-A', '--', '.']);
      const text = await run(['diff', '--cached', '--name-only', '-z']);
      return text.split('\0').filter((f) => f.length > 0);
    },
    async unstage(files) {
      if (!files.length) return;
      await run(['reset', '-q', '--', ...files]);
    },
    async head() {
      return (await run(['rev-parse', 'HEAD'])).trim();
    },
    async commit(message, author) {
      await run(['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`, 'commit', '-q', '-m', message]);
      return (await run(['rev-parse', 'HEAD'])).trim();
    },
    async push(remote, branch) {
      const result = await exec(['push', '--porcelain', '-u', remote, `${branch}:${branch}`], { cwd, env, signal, timeoutMs: 180_000 });
      const output = `${result.stdout}${result.stderr}`.trim();
      if (!result.ok) throw new PolicyError('ToolUnavailable', `git push failed: ${output || `exit ${result.code}`}`);
      return output;
    },
  };
}
