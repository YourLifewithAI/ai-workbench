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
const WINDOWS = process.platform === 'win32';

/**
 * Device names Windows resolves anywhere in the tree, with or without an extension: `NUL.txt` is still NUL.
 * A write to one is silently discarded and a read from `CON` blocks on console input, so neither is a thing a
 * tool should be able to reach through a grant that only meant to cover a directory.
 */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * Windows strips trailing dots and spaces before it opens a file, so `credentials.json.` and
 * `credentials.json ` both open `credentials.json` — and a deny list that compares the string it was given
 * would let both straight through. Comparison therefore happens on the name the filesystem will actually use.
 */
export function windowsName(segment: string): string {
  return segment.replace(/[. ]+$/, '');
}

/**
 * Segments Windows would reinterpret. A colon opens an alternate data stream (`notes.md::$DATA`) or names a
 * drive, and either lets one file be addressed under a second name that no deny list is written against.
 */
export function windowsUnsafe(segment: string): string | null {
  if (segment.includes(':')) return `"${segment}" names an alternate data stream or a drive; a tool path may not contain ":".`;
  if (RESERVED.test(windowsName(segment))) return `"${segment}" is a reserved Windows device name, not a file.`;
  return null;
}

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

  // Refused before anything else, and before the path is resolved: these are names the filesystem reads
  // differently from the way this checker would, and a checker that disagrees with the filesystem is a bypass
  // rather than a policy. The drive letter is the one legitimate colon, and `path.parse` has already taken it.
  if (WINDOWS) {
    const { root, dir, base } = path.parse(real);
    for (const segment of [...dir.slice(root.length).split(path.sep), base].filter((x) => x.length > 0)) {
      const complaint = windowsUnsafe(segment);
      if (complaint) return { allowed: false, reason: complaint, realPath: real };
    }
  }

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
  // On Windows the name the filesystem opens is the name with trailing dots and spaces removed, so that is
  // the name the deny list has to be compared against — not the string the caller happened to write.
  const norm = (x: string): string => {
    const trimmed = WINDOWS ? windowsName(x) : x;
    return CASE_INSENSITIVE ? trimmed.toLowerCase() : trimmed;
  };
  return norm(a) === norm(b);
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
      out.push({ path: workspaceRelative(this.policy.workspaceDir, child), kind: entry.isDirectory() ? 'directory' : 'file', bytes: stat?.size ?? 0 });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async write(candidate: string, data: string): Promise<void> {
    const target = this.decide(candidate, 'write');
    // The check is on the path as given, not on what it resolves to: `realpath` has already followed the link,
    // so lstat-ing the resolved path would always say "not a link" and the whole check would be theatre.
    const asGiven = path.isAbsolute(candidate) ? candidate : path.resolve(this.policy.workspaceDir, candidate);
    const existing = await fsp.lstat(asGiven).catch(() => null);
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

/**
 * The path a tool result, a prompt, or the UI shows — always with forward slashes, on every platform. An
 * agent that lists `projects\\anthology\\draft.md` and a workflow that writes `projects/{runId}/draft.md`
 * are naming the same file, and a model asked to reconcile the two will sometimes decide they are not.
 * Windows accepts forward slashes everywhere, so the round trip back through `read` or `write` is unaffected.
 */
export function workspaceRelative(workspaceDir: string, target: string): string {
  const relative = path.relative(workspaceDir, target);
  return process.platform === 'win32' ? relative.split(path.sep).join('/') : relative;
}
