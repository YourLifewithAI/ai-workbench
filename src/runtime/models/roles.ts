// Model roles (D-68). An agent's policy may name `role:fast` instead of a catalog id; the role is an ordered
// list in config/workbench.json, chosen on the Settings screen, and the first model in it that is ready is
// the one that runs. Nothing here scores or guesses: the order is the owner's, the readiness is the catalog's.
import type { WorkbenchConfig } from '../../shared/workspace.js';

export const ROLE_PREFIX = 'role:';

export function isRole(id: string): boolean {
  return id.startsWith(ROLE_PREFIX);
}

export function roleName(id: string): string {
  return id.slice(ROLE_PREFIX.length);
}

export interface Expansion {
  /** Catalog ids in policy order, roles replaced by their ready members, duplicates dropped. */
  ids: string[];
  /** Roles that contributed nothing, with the reason a person can act on. */
  rejected: { id: string; reason: string }[];
}

/**
 * Expand a policy's ids. A plain id passes through untouched (selection judges it); a role becomes the members
 * of its list that `ready` accepts, in the list's order. `ready` is the catalog's word — a credential for the
 * provider, a local endpoint that answered, the mock — and under `--provider mock` everything is ready.
 */
export function expandPolicy(ids: string[], roles: WorkbenchConfig['models']['roles'], ready: (id: string) => boolean): Expansion {
  const out: string[] = [];
  const rejected: Expansion['rejected'] = [];
  const seen = new Set<string>();
  const push = (id: string): void => { if (!seen.has(id)) { seen.add(id); out.push(id); } };
  for (const id of ids) {
    if (!isRole(id)) { push(id); continue; }
    const name = roleName(id);
    const list = roles[name];
    if (!list) { rejected.push({ id, reason: `"${name}" is not a role. Roles are set in Settings → Which models do the work; the defaults are capable, fast and cheap` }); continue; }
    const usable = list.filter(ready);
    if (!usable.length) {
      rejected.push({ id, reason: list.length ? `none of the ${list.length} model${list.length === 1 ? '' : 's'} in the "${name}" role is ready (${list.join(', ')}). Add a key for one of them, or put a model you have in the list, in Settings → Which models do the work` : `the "${name}" role lists no models. Add one in Settings → Which models do the work` });
      continue;
    }
    for (const member of usable) push(member);
  }
  return { ids: out, rejected };
}

/** The one model a role comes to right now, or null: what Settings and doctor show beside each role. */
export function resolveRoles(roles: WorkbenchConfig['models']['roles'], ready: (id: string) => boolean): Record<string, string | null> {
  return Object.fromEntries(Object.entries(roles).map(([name, list]) => [name, list.find(ready) ?? null]));
}

/** Every role an agent policy or a workflow step pin names, so a role nobody defined can be pointed at. */
export function rolesReferenced(policies: { primary: string; fallbacks: string[] }[], stepPins: string[]): string[] {
  const names = new Set<string>();
  for (const p of policies) for (const id of [p.primary, ...p.fallbacks]) if (isRole(id)) names.add(roleName(id));
  for (const pin of stepPins) if (isRole(pin)) names.add(roleName(pin));
  return [...names].sort();
}
