// Effective permission = tool max ∩ agent grant ∩ workflow ceiling ∩ run overrides (D-26). Every operator here
// narrows; there is no code path that widens, which is what SEC-10 asserts. The agent's *file* asks; the
// workspace's `grants.<agentId>` answers, and the answer is what composes.
import { Permissions } from '../../shared/permissions.js';
import type { NetworkMode } from '../../shared/permissions.js';
import type { WorkbenchConfig } from '../../shared/workspace.js';

/** `offline < local-only < allowlist < unrestricted`; the effective mode is the minimum over every layer. */
const MODE_ORDER: Record<NetworkMode, number> = { offline: 0, 'local-only': 1, allowlist: 2, unrestricted: 3 };

export const EMPTY_PERMISSIONS: Permissions = Permissions.parse({});

export function narrowestMode(...modes: (NetworkMode | undefined)[]): NetworkMode {
  const present = modes.filter((m): m is NetworkMode => m !== undefined);
  if (!present.length) return 'offline';
  return present.reduce((a, b) => (MODE_ORDER[a] <= MODE_ORDER[b] ? a : b));
}

/**
 * Two layers, narrowed. Lists intersect (a host or a path must satisfy *both* layers); a tool decision is
 * `allow` only when neither layer says `deny` and at least one says `allow`; booleans are `and`.
 */
export function intersect(a: Permissions, b: Permissions): Permissions {
  return {
    fs: {
      read: intersectPaths(a.fs.read, b.fs.read),
      write: intersectPaths(a.fs.write, b.fs.write),
    },
    net: {
      ...(a.net.mode !== undefined || b.net.mode !== undefined ? { mode: narrowestMode(a.net.mode, b.net.mode) } : {}),
      // A host must match every layer's list, so the intersection is the entries each layer would also accept.
      allow: a.net.allow.filter((entry) => b.net.allow.includes(entry)),
      allowLocalAddresses: a.net.allowLocalAddresses && b.net.allowLocalAddresses,
      approvalExempt: a.net.approvalExempt.filter((entry) => b.net.approvalExempt.includes(entry)),
    },
    tools: intersectTools(a.tools, b.tools),
    // Either layer may demand an approval; neither can waive the other's.
    approvalRequired: [...new Set([...a.approvalRequired, ...b.approvalRequired])],
  };
}

export function intersectAll(...layers: (Permissions | undefined)[]): Permissions {
  const present = layers.filter((l): l is Permissions => l !== undefined);
  if (!present.length) return EMPTY_PERMISSIONS;
  return present.reduce(intersect);
}

/**
 * A path survives only if some root in the other layer contains it (or it contains one, in which case the
 * narrower of the two is what is kept). Prefix comparison is on normalised, slash-terminated strings so
 * `projects/a` never matches `projects/ab`.
 */
/**
 * A ceiling narrows only what it mentions. A workflow that writes `permissions: { tools: {...} }` has said which
 * tools its steps may use and nothing about paths; reading its silence as "no paths" would strip every grant the
 * agents already have, which is what the first shipped workflow with a `permissions` block did. The grant layer
 * is unaffected: an agent with no `fs.write` still has none, because that layer is an answer, not a ceiling.
 */
function asCeiling(ceiling: Permissions | undefined): Permissions | undefined {
  if (!ceiling) return undefined;
  return {
    ...ceiling,
    fs: {
      read: ceiling.fs.read.length ? ceiling.fs.read : ['/'],
      write: ceiling.fs.write.length ? ceiling.fs.write : ['/'],
    },
  };
}

function intersectPaths(a: string[], b: string[]): string[] {
  const out = new Set<string>();
  for (const left of a) {
    for (const right of b) {
      if (under(left, right)) out.add(left);
      else if (under(right, left)) out.add(right);
    }
  }
  return [...out].sort();
}

function under(candidate: string, root: string): boolean {
  const c = normalize(candidate);
  const r = normalize(root);
  return c === r || c.startsWith(r);
}

/**
 * Permission paths are workspace-relative. `.` and `/` both mean the workspace root and normalise to the empty
 * string, so every path is "under" them — anything outside the workspace is refused by the broker regardless.
 */
function normalize(value: string): string {
  const trimmed = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return trimmed === '' || trimmed === '.' || trimmed === '/' ? '' : `${trimmed}/`;
}

function intersectTools(a: Record<string, 'allow' | 'deny'>, b: Record<string, 'allow' | 'deny'>): Record<string, 'allow' | 'deny'> {
  const out: Record<string, 'allow' | 'deny'> = {};
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    // A `deny` anywhere wins; an `allow` needs no matching entry in the other layer, because a layer that says
    // nothing about a tool is not an objection — the composition below is what supplies the default deny.
    if (a[id] === 'deny' || b[id] === 'deny') out[id] = 'deny';
    else if (a[id] === 'allow' || b[id] === 'allow') out[id] = 'allow';
  }
  return out;
}

export interface GrantSource {
  /** The agent's own `permissions` block: what it *asks* for. Never authoritative on its own (D-26). */
  requested: Permissions;
  /** `grants.<agentId>` in `config/workbench.json`: what a human actually gave it. */
  granted: Permissions | undefined;
  /** The tool's own ceiling. */
  toolMax: Permissions;
  /** A workflow's `permissions` block, when the step came from one. */
  workflowCeiling?: Permissions | undefined;
  /** A run override. It can only narrow, which is why it is just another layer here. */
  runOverride?: Permissions | undefined;
}

export interface EffectivePermissions {
  permissions: Permissions;
  /** Why a tool is or is not allowed, in words the denial can quote. */
  decide(toolId: string, approvalRequired: boolean): ToolDecision;
}

export type ToolDecision =
  | { allowed: true; approval: boolean; reason: string }
  | { allowed: false; approval: false; reason: string; hint: string };

/**
 * Tools are denied by default (SEC-09): the composition below never invents an `allow`, so a tool with no
 * explicit grant is refused however harmless it looks.
 */
export function effectivePermissions(source: GrantSource): EffectivePermissions {
  const granted = source.granted ?? EMPTY_PERMISSIONS;
  const permissions = intersectAll(source.toolMax, granted, asCeiling(source.workflowCeiling), asCeiling(source.runOverride));

  return {
    permissions,
    decide(toolId, approvalRequired) {
      if (granted.tools[toolId] === 'deny') {
        return { allowed: false, approval: false, reason: `"${toolId}" is denied for this agent.`, hint: 'A human set that in the grant matrix. Remove the deny there if it should be allowed.' };
      }
      if (source.workflowCeiling?.tools[toolId] === 'deny') {
        return { allowed: false, approval: false, reason: `This workflow denies "${toolId}" to every step.`, hint: 'The workflow\'s `permissions.tools` block is the ceiling; edit the workflow file.' };
      }
      if (granted.tools[toolId] !== 'allow') {
        const asked = source.requested.tools[toolId] === 'allow';
        return {
          allowed: false,
          approval: false,
          reason: `"${toolId}" is not granted to this agent.`,
          hint: asked
            ? 'The agent asks for it in its own file, but nothing has granted it. Grant it in the Tools screen.'
            : 'Tools are denied until a human grants them. Grant it in the Tools screen if this agent should have it.',
        };
      }
      const needsApproval = approvalRequired || permissions.approvalRequired.includes(toolId);
      return { allowed: true, approval: needsApproval, reason: needsApproval ? `"${toolId}" is granted but every call needs a human decision.` : `"${toolId}" is granted.` };
    },
  };
}

/** `grants.<agentId>` out of workspace config, parsed. A malformed grant is no grant, never a wider one. */
export function grantFor(config: WorkbenchConfig, agentId: string): Permissions | undefined {
  const raw = config.grants[agentId];
  if (raw === undefined) return undefined;
  const parsed = Permissions.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
