// The path rules of a repository grant (D-66, SEC-33). The same canonicalisation the workspace broker uses —
// `realpath`, the platform case rule, the Windows name rules — with a deny-list of its own: git's internals,
// anything named like a credential, and the file that declares the repository's gate.
import path from 'node:path';
import { contains, realpathOf, same, windowsName, windowsUnsafePath, workspaceDenied, type FsDecision } from './broker.js';
import { credentialShaped } from './secretScan.js';

/** The parts of `.git/` an agent could use to change what git *is*: its config, its hooks, its history, its refs. */
export const GIT_INTERNALS = ['config', 'hooks', 'objects', 'refs', 'HEAD'] as const;

export interface RepoPolicy {
  /** The granted root, as written in the grant. */
  root: string;
  /** The workspace, so a repository that happens to contain it still cannot reach its config (SEC-11). */
  workspaceDir: string;
}

/**
 * Whether the policy allows `candidate` — repository-relative, or absolute — for `mode`. The refusal names the
 * rule, because "no" with no reason teaches an agent nothing and a person less.
 */
export function checkRepoPath(candidate: string, policy: RepoPolicy, mode: 'read' | 'write'): FsDecision {
  const rootReal = realpathOf(policy.root);
  const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(policy.root, candidate);
  const real = realpathOf(absolute);

  const unsafe = windowsUnsafePath(real);
  if (unsafe) return { allowed: false, reason: unsafe, realPath: real };

  if (!contains(rootReal, real)) {
    return { allowed: false, reason: `"${candidate}" resolves outside the granted repository (${policy.root}). A repository grant covers that checkout and nothing beside it (SEC-33).`, realPath: real };
  }

  const segments = path.relative(rootReal, real).split(path.sep).filter((s) => s.length > 0);
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    if (same('.git', segment)) {
      const inner = segments[i + 1];
      const internal = inner && GIT_INTERNALS.find((name) => same(name, inner));
      return {
        allowed: false,
        reason: internal
          ? `".git/${internal}" is git's own ${describeInternal(internal)}. No repository grant opens it: changing it would change what git is, not what the code is (SEC-33).`
          : `".git/" is git's own state. No repository grant opens it; use the git tools for what git knows (SEC-33).`,
        realPath: real,
      };
    }
  }

  const base = segments.length ? segments[segments.length - 1]! : '';
  const shaped = base ? credentialShaped(process.platform === 'win32' ? windowsName(base) : base) : null;
  if (shaped) {
    return { allowed: false, reason: `"${base}" is named like a credentials file (${shaped}). A repository grant never opens one, whatever is in it (SEC-33).`, realPath: real };
  }

  if (mode === 'write' && segments[0] && same('.workbench', segments[0])) {
    return { allowed: false, reason: `".workbench/" declares this repository's own gate. A tool may not change what \`check\` runs; a person edits that file (SEC-35).`, realPath: real };
  }

  // A repository grant that covers the workspace is not a second door to the workspace's config.
  const workspace = realpathOf(policy.workspaceDir);
  if (contains(workspace, real)) {
    const denied = workspaceDenied(workspace, real);
    if (denied) return { allowed: false, reason: denied, realPath: real };
  }

  return { allowed: true, reason: `inside the granted repository ${policy.root}`, realPath: real };
}

function describeInternal(name: string): string {
  switch (name) {
    case 'config': return 'configuration: remotes, hooks path, identity';
    case 'hooks': return 'hooks, which run as you on every commit';
    case 'objects': return 'object store: the history itself';
    case 'refs': return 'refs: what every branch and tag points at';
    default: return 'HEAD: what is checked out';
  }
}

/** Repository-relative, forward slashes on every platform — what a tool result and a prompt show. */
export function repoRelative(root: string, target: string): string {
  const relative = path.relative(realpathOf(root), realpathOf(target));
  return relative.split(path.sep).join('/');
}
