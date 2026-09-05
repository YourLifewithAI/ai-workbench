// Repository grants (D-66). A grant names one checkout and the branches an agent may push to; the tools it
// unlocks are narrow on purpose — there is no merge, no rebase, no force, and `main` is refused by name.
import { z } from 'zod';

export const RepoGrant = z.object({
  /** An absolute path to a git checkout. */
  path: z.string().min(1),
  /** A branch glob: `*` matches within one segment, `**` across segments. The default is the run protocol's. */
  branches: z.string().min(1).default('run/*'),
});
export type RepoGrant = z.infer<typeof RepoGrant>;

/**
 * Refused whatever the pattern says. A grant of `*` is a grant to every *run* branch, not to the branch a person
 * merges into: "a coding agent edits a branch; a person merges" is the decision, and the pattern is not a way
 * around it.
 */
export const PROTECTED_BRANCHES = ['main', 'master'] as const;

/** A name git would accept and that cannot be read as an option: no leading dash, no `..`, no lock suffix. */
export function validBranchName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)
    && !name.includes('..') && !name.includes('//') && !name.endsWith('/') && !name.endsWith('.lock') && !name.endsWith('.');
}

export function branchMatches(pattern: string, name: string): boolean {
  if (pattern === '**') return true;
  const source = pattern
    .split('**').map((part) => part.split('*').map(escapeRegExp).join('[^/]*'))
    .join('.*');
  return new RegExp(`^${source}$`).test(name);
}

/** The decision, in words a refusal can quote. */
export function branchAllowed(pattern: string, name: string): { allowed: boolean; reason: string } {
  if (!validBranchName(name)) return { allowed: false, reason: `"${name}" is not a branch name git would accept.` };
  if ((PROTECTED_BRANCHES as readonly string[]).includes(name)) {
    return { allowed: false, reason: `"${name}" is the branch a person merges into. No tool may branch to it, commit on it, or push it (D-66).` };
  }
  if (!branchMatches(pattern, name)) return { allowed: false, reason: `"${name}" is outside the branches this grant allows (${pattern}).` };
  return { allowed: true, reason: `"${name}" matches ${pattern}.` };
}

/**
 * The narrower of two patterns, or null when neither implies the other — in which case no branch satisfies
 * both layers and the intersection is empty. "Implies" is tested on a sample the pattern generates.
 */
export function narrowerBranches(a: string, b: string): string | null {
  if (a === b) return a;
  const sample = (pattern: string): string => pattern.replace(/\*\*/g, 'x/x').replace(/\*/g, 'x');
  const aUnderB = branchMatches(b, sample(a));
  const bUnderA = branchMatches(a, sample(b));
  if (aUnderB && !bUnderA) return a;
  if (bUnderA && !aUnderB) return b;
  if (aUnderB && bUnderA) return a;
  return null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

// ---- what the tools return ---------------------------------------------------------------------

export interface GitStatusEntry { path: string; status: string }
export interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  clean: boolean;
  entries: GitStatusEntry[];
}
export interface GitLogEntry { sha: string; author: string; date: string; subject: string }
export interface CheckResult {
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  /** stdout and stderr as one stream in the order they were printed; the *end* of it when it was too long (D-47). */
  output: string;
  truncated: boolean;
  /** Where the whole output is, when it was cut: readable with `artifact.read`. */
  fullOutput?: string | undefined;
  /** The command that ran — the repository's own, from `.workbench/repo.json`, never the agent's (SEC-35). */
  command: string;
  killedBy: 'timeout' | 'output' | 'cancelled' | null;
}
