// The broker (D-26, D-27). Every byte a tool reads or writes goes through here, and the answer does not depend
// on what the model said — that is the whole design goal. Tools receive `ctx.fs` and `ctx.net`; they never
// import `node:fs` and never call `fetch`, and lint enforces that.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Permissions } from '../../shared/permissions.js';
import type { FsEntry } from '../../shared/tool.js';

export class PolicyError extends Error {
  constructor(readonly code: 'PermissionDenied' | 'NotFound' | 'ToolUnavailable', message: string, readonly hint?: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

/**
 * Paths that never open, whatever any grant says (tools-and-security.md §Permissions). An agent that could
 * write these could rewrite its own permissions, another agent's instructions, or the token that guards the
 * API — so this list wins over every intersection, including a grant the owner wrote by hand.
 */
export const HARD_DENY = ['config', 'agents', 'workflows', 'plugins', 'data', '.git'] as const;
const DENIED_FILES = ['runtime.token', 'runtime.json', 'credentials.json'] as const;

/** macOS and Windows compare paths case-insensitively; Linux does not. Getting this backwards is a bypass. */
const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';

export interface BrokerPolicy {
  /** The workspace root. Every root and candidate is resolved under it. */
  workspaceDir: string;
  /** The effective permissions: tool max ∩ agent grant ∩ workflow ceiling ∩ run overrides, computed already. */
  permissions: Permissions;
  /** The run's own scratch directory, readable and writable without a grant so truncated results are recoverable. */
  scratchDir: string;
}

export interface FsDecision { allowed: boolean; reason: string; realPath: string }

/**
 * Canonicalises a candidate and answers whether the policy allows it. Both roots and candidate are resolved
 * with `realpath` where they exist, so a symlink pointing out of a granted root is denied even though its
 * lexical path is inside — the lexical check alone is the classic escape.
 */
export function checkPath(candidate: string, roots: string[], policy: BrokerPolicy, mode: 'read' | 'write'): FsDecision {
  const workspace = realpathOf(policy.workspaceDir);
  const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(policy.workspaceDir, candidate);
  const real = realpathOf(absolute);

  if (!contains(workspace, real)) {
    return { allowed: false, reason: `"${candidate}" is outside this workspace. Tools work inside the workspace only.`, realPath: real };
  }

  // The scratch directory is the tool's own: `artifact.read('scratch/…')` must always recover a masked result.
  const scratch = realpathOf(policy.scratchDir);
  if (contains(scratch, real)) return { allowed: true, reason: 'the run\'s own scratch directory', realPath: real };

  const relative = path.relative(workspace, real);
  const segments = relative.split(path.sep).filter((s) => s.length > 0);
  const first = segments[0];
  // The deny-list is checked on the *canonical* path, so a grant whose root lexically contains `agents/` cannot
  // reach an agent's own definition through a symlink or a `..` that resolves back inside (SEC-11).
  if (first && HARD_DENY.some((d) => same(d, first))) {
    return { allowed: false, reason: `"${first}/" is never readable or writable by a tool: it holds the definitions and secrets that decide what tools may do.`, realPath: real };
  }
  if (segments.some((s) => DENIED_FILES.some((d) => same(d, s)))) {
    return { allowed: false, reason: `"${path.basename(real)}" is never readable or writable by a tool.`, realPath: real };
  }

  for (const root of roots) {
    const rootReal = realpathOf(path.isAbsolute(root) ? root : path.resolve(policy.workspaceDir, root));
    if (contains(rootReal, real)) return { allowed: true, reason: `granted by ${root}`, realPath: real };
  }
  return {
    allowed: false,
    reason: roots.length
      ? `"${candidate}" is not under any path this agent may ${mode}: ${roots.join(', ')}.`
      : `This agent has no ${mode} permission for any path. Grant one in the Tools screen if it should.`,
    realPath: real,
  };
}

/** Resolves as far as the path exists, so a write to a file that is not there yet is still checked properly. */
function realpathOf(target: string): string {
  let current = path.resolve(target);
  const trailing: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...trailing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      trailing.push(path.basename(current));
      current = parent;
    }
  }
}

function contains(root: string, candidate: string): boolean {
  if (same(root, candidate)) return true;
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function same(a: string, b: string): boolean {
  return CASE_INSENSITIVE ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** How big a single tool read may be before it is refused outright rather than truncated. */
const MAX_READ_BYTES = 4 * 1024 * 1024;

export class Broker {
  constructor(private readonly policy: BrokerPolicy, private readonly onDecision?: (d: { path: string; mode: 'read' | 'write' | 'list'; allowed: boolean; reason: string }) => void) {}

  async read(candidate: string): Promise<string> {
    const target = this.decide(candidate, 'read');
    const stat = await fsp.stat(target).catch(() => null);
    if (!stat?.isFile()) throw new PolicyError('NotFound', `There is no file at "${candidate}".`);
    if (stat.size > MAX_READ_BYTES) {
      throw new PolicyError('ToolUnavailable', `"${candidate}" is ${Math.round(stat.size / 1024)} KB, past the ${MAX_READ_BYTES / 1024 / 1024} MB a single read may return.`);
    }
    return fsp.readFile(target, 'utf8');
  }

  async list(candidate: string): Promise<FsEntry[]> {
    const target = this.decide(candidate, 'list');
    const entries = await fsp.readdir(target, { withFileTypes: true }).catch(() => null);
    if (!entries) throw new PolicyError('NotFound', `There is no directory at "${candidate}".`);
    const out: FsEntry[] = [];
    for (const entry of entries) {
      // Every child is checked in its own right: a directory a grant covers can still hold a denied path.
      const child = path.join(target, entry.name);
      const decision = checkPath(child, this.roots('read'), this.policy, 'read');
      if (!decision.allowed) continue;
      const stat = await fsp.stat(child).catch(() => null);
      out.push({ path: path.relative(this.policy.workspaceDir, child), kind: entry.isDirectory() ? 'directory' : 'file', bytes: stat?.size ?? 0 });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async write(candidate: string, data: string): Promise<void> {
    const target = this.decide(candidate, 'write');
    // A symlink at the destination would write through to wherever it points, past every check above.
    const existing = await fsp.lstat(target).catch(() => null);
    if (existing?.isSymbolicLink()) {
      throw new PolicyError('PermissionDenied', `"${candidate}" is a symbolic link. Writing through one would land somewhere the policy never saw.`);
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, data, 'utf8');
  }

  /** The decision on its own, for a tool whose storage is not the filesystem. No I/O, same answer. */
  can(candidate: string, mode: 'read' | 'write'): { allowed: boolean; reason: string; hint?: string | undefined } {
    const decision = checkPath(candidate, this.roots(mode), this.policy, mode);
    this.onDecision?.({ path: candidate, mode, allowed: decision.allowed, reason: decision.reason });
    return { allowed: decision.allowed, reason: decision.reason, hint: hintFor(decision.reason) };
  }

  private roots(mode: 'read' | 'write'): string[] {
    return mode === 'write' ? this.policy.permissions.fs.write : [...this.policy.permissions.fs.read, ...this.policy.permissions.fs.write];
  }

  private decide(candidate: string, mode: 'read' | 'write' | 'list'): string {
    const check = mode === 'write' ? 'write' : 'read';
    const decision = checkPath(candidate, this.roots(check), this.policy, check);
    this.onDecision?.({ path: candidate, mode, allowed: decision.allowed, reason: decision.reason });
    if (!decision.allowed) throw new PolicyError('PermissionDenied', decision.reason, hintFor(decision.reason));
    return decision.realPath;
  }
}

function hintFor(reason: string): string | undefined {
  if (reason.includes('never readable')) return 'This is the hard deny-list. No grant can open it, and that is deliberate.';
  if (reason.includes('no ') && reason.includes('permission')) return 'A human grants paths per agent in the Tools screen.';
  return undefined;
}
