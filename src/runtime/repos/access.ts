// A repository grant, from the inside (D-66). Every call decides first — the root, the deny-list, the branch
// pattern — and only then touches the checkout. The decision never depends on what the model said: it named a
// path and a branch, and the grant a person wrote answers.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PolicyError, contains, realpathOf } from '../security/broker.js';
import { checkRepoPath, repoRelative } from '../security/repoPolicy.js';
import { credentialShaped } from '../security/secretScan.js';
import { branchAllowed, type RepoGrant, type CheckResult } from '../../shared/repo.js';
import type { FsEntry, RepoAccess, ToolContext } from '../../shared/tool.js';
import { gitRepo, type GitExec } from './git.js';
import { readGate, runGate } from './gate.js';

export interface RepoAccessDeps {
  /** The effective grants: tool ceiling ∩ agent grant ∩ workflow ceiling ∩ run override, computed already. */
  grants: RepoGrant[];
  workspaceDir: string;
  /** `childEnv()`: what git and the gate see. Never `process.env` (D-33). */
  env: Record<string, string>;
  git: GitExec | null;
  agentId: string;
  runId: string;
  signal: AbortSignal;
  /** `context.maxToolResultChars`: how much of a gate's output the model is shown (D-47). */
  maxOutputChars: () => number;
  /** Writes into the run's own scratch and answers with the `scratch/…` name `artifact.read` takes. */
  writeScratch: (name: string, data: string) => Promise<string>;
  onDecision?: ((d: { repo: string; path: string; mode: 'read' | 'write' | 'list' | 'branch' | 'push'; allowed: boolean; reason: string }) => void) | undefined;
}

const MAX_READ_BYTES = 4 * 1024 * 1024;
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function repoHandle(deps: RepoAccessDeps): ToolContext['repo'] {
  return {
    grants: () => deps.grants,
    open: async (named) => open(deps, named),
  };
}

async function open(deps: RepoAccessDeps, named: string | undefined): Promise<RepoAccess> {
  const hint = 'A person writes `grants.<agent>.repos: [{ "path": "/abs/checkout", "branches": "run/*" }]` in config/workbench.json (D-66).';
  if (!deps.grants.length) throw new PolicyError('PermissionDenied', 'This agent has no repository grant.', hint);

  let grant: RepoGrant | undefined;
  if (named === undefined) {
    if (deps.grants.length > 1) {
      throw new PolicyError('PermissionDenied', `Name the repository: this agent is granted ${deps.grants.length} (${deps.grants.map((g) => g.path).join(', ')}).`);
    }
    grant = deps.grants[0];
  } else {
    const real = realpathOf(named);
    grant = deps.grants.find((g) => path.isAbsolute(g.path) && contains(realpathOf(g.path), real));
    if (!grant) {
      throw new PolicyError('PermissionDenied', `"${named}" is not a repository this agent is granted. Granted: ${deps.grants.map((g) => g.path).join(', ')}.`, hint);
    }
  }
  if (!path.isAbsolute(grant!.path)) throw new PolicyError('PermissionDenied', `The repository grant "${grant!.path}" is not an absolute path, so it grants nothing.`, hint);
  if (!fs.existsSync(grant!.path)) throw new PolicyError('ToolUnavailable', `The granted repository ${grant!.path} does not exist on this machine.`);
  return access(deps, grant!);
}

function access(deps: RepoAccessDeps, grant: RepoGrant): RepoAccess {
  const root = realpathOf(grant.path);
  const policy = { root: grant.path, workspaceDir: deps.workspaceDir };

  const decide = (candidate: string, mode: 'read' | 'write' | 'list'): string => {
    const decision = checkRepoPath(candidate, policy, mode === 'write' ? 'write' : 'read');
    deps.onDecision?.({ repo: grant.path, path: candidate, mode, allowed: decision.allowed, reason: decision.reason });
    if (!decision.allowed) throw new PolicyError('PermissionDenied', decision.reason, hintFor(decision.reason));
    return decision.realPath;
  };

  const git = () => {
    if (!deps.git) throw new PolicyError('ToolUnavailable', 'git is not installed on this machine, or is not on PATH.', 'Install git and restart the workbench.');
    return gitRepo(deps.git, root, deps.env, deps.signal);
  };

  /** The branch the checkout is on, if the grant covers it. Writes, commits and pushes all start here. */
  const onAllowedBranch = async (what: string): Promise<string> => {
    const branch = await git().currentBranch();
    if (branch === null) {
      throw new PolicyError('PermissionDenied', `The checkout is not on a branch (detached HEAD, or no commits yet), so ${what} has nowhere to go.`, 'Create a run branch first with git.branch.');
    }
    const verdict = branchAllowed(grant.branches, branch);
    deps.onDecision?.({ repo: grant.path, path: branch, mode: 'branch', allowed: verdict.allowed, reason: verdict.reason });
    if (!verdict.allowed) {
      throw new PolicyError('PermissionDenied', `The checkout is on "${branch}", which this grant does not cover (${grant.branches}), so ${what} is refused. ${verdict.reason}`, 'Create a run branch first with git.branch; the tools work there.');
    }
    return branch;
  };

  return {
    root,
    branches: grant.branches,

    async read(file) {
      const target = decide(file, 'read');
      const stat = await fsp.stat(target).catch(() => null);
      if (!stat?.isFile()) throw new PolicyError('NotFound', `There is no file at "${file}" in ${grant.path}.`);
      if (stat.size > MAX_READ_BYTES) throw new PolicyError('ToolUnavailable', `"${file}" is ${Math.round(stat.size / 1024)} KB, past the ${MAX_READ_BYTES / 1024 / 1024} MB a single read may return.`);
      return fsp.readFile(target, 'utf8');
    },

    async list(dir) {
      const target = decide(dir, 'list');
      const entries = await fsp.readdir(target, { withFileTypes: true }).catch(() => null);
      if (!entries) throw new PolicyError('NotFound', `There is no directory at "${dir}" in ${grant.path}.`);
      const out: FsEntry[] = [];
      for (const entry of entries) {
        // Every child in its own right: `.git/` and a credentials file are inside a directory the grant covers.
        const child = path.join(target, entry.name);
        if (!checkRepoPath(child, policy, 'read').allowed) continue;
        const stat = await fsp.stat(child).catch(() => null);
        out.push({ path: repoRelative(root, child), kind: entry.isDirectory() ? 'directory' : 'file', bytes: stat?.size ?? 0 });
      }
      return out.sort((a, b) => a.path.localeCompare(b.path));
    },

    async write(file, data) {
      const target = decide(file, 'write');
      await onAllowedBranch('a write');
      // On the path as given: `realpath` has already followed a link by the time a decision is made.
      const asGiven = path.isAbsolute(file) ? file : path.resolve(grant.path, file);
      const existing = await fsp.lstat(asGiven).catch(() => null);
      if (existing?.isSymbolicLink()) throw new PolicyError('PermissionDenied', `"${file}" is a symbolic link. Writing through one would land somewhere the policy never saw.`);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, data, 'utf8');
    },

    git: {
      status: () => git().status(),
      diff: (input) => git().diff({
        ...(input.staged !== undefined ? { staged: input.staged } : {}),
        ...(input.path ? { path: repoRelative(root, decide(input.path, 'read')) } : {}),
      }),
      log: (count) => git().log(count),

      async branch(name) {
        const verdict = branchAllowed(grant.branches, name);
        deps.onDecision?.({ repo: grant.path, path: name, mode: 'branch', allowed: verdict.allowed, reason: verdict.reason });
        if (!verdict.allowed) throw new PolicyError('PermissionDenied', verdict.reason, `This grant allows ${grant.branches}.`);
        const repo = git();
        const exists = await repo.branchExists(name);
        await repo.switchTo(name, !exists);
        return { branch: name, created: !exists };
      },

      async commit(message) {
        const branch = await onAllowedBranch('a commit');
        const repo = git();
        const staged = await repo.stageAll();
        // A credentials file lying in the working tree — the owner's `.env`, say — is not the agent's to ship.
        const skipped = staged.filter((f) => f.split('/').some((s) => s === '.git') || credentialShaped(path.basename(f)) !== null);
        await repo.unstage(skipped);
        const files = staged.filter((f) => !skipped.includes(f));
        if (!files.length) throw new Error(skipped.length ? `Nothing to commit: the only changes are to ${skipped.join(', ')}, which a tool may not commit (SEC-33).` : 'Nothing to commit: the working tree matches HEAD.');
        const trailer = `\n\nWorkbench-Run: ${deps.runId}\nWorkbench-Agent: ${deps.agentId}`;
        const sha = await repo.commit(`${message.trim()}${trailer}`, { name: deps.agentId, email: `${deps.agentId}@workbench.noreply` });
        return { sha, branch, files, skipped };
      },

      async push(remote = 'origin') {
        if (!REMOTE_NAME.test(remote)) throw new PolicyError('PermissionDenied', `"${remote}" is not a remote name.`);
        // Decided by name, before git is spawned: a push from `main` never reaches the network (SEC-34).
        const branch = await onAllowedBranch('a push');
        deps.onDecision?.({ repo: grant.path, path: branch, mode: 'push', allowed: true, reason: `pushing ${branch} to ${remote}` });
        const output = await git().push(remote, branch);
        return { branch, remote, output };
      },
    },

    async check(): Promise<CheckResult> {
      const gate = readGate(root);
      const result = await runGate({ root, gate, env: deps.env, signal: deps.signal });
      const limit = deps.maxOutputChars();
      const truncated = result.output.length > limit;
      let fullOutput: string | undefined;
      if (truncated) fullOutput = await deps.writeScratch(`check-${Date.now()}.log`, result.output);
      return {
        ok: result.ok,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        // The end, not the start: a gate's verdict is at the bottom of its transcript.
        output: truncated ? `…[${result.output.length - limit} earlier characters omitted]\n${result.output.slice(-limit)}` : result.output,
        truncated,
        ...(fullOutput ? { fullOutput } : {}),
        command: gate.check,
        killedBy: result.killedBy,
      };
    },
  };
}

function hintFor(reason: string): string | undefined {
  if (reason.includes('SEC-33')) return 'This is the repository deny-list. No grant opens these, and that is deliberate.';
  if (reason.includes('SEC-35')) return 'The gate is the owner\'s. Ask them to change it.';
  return undefined;
}
