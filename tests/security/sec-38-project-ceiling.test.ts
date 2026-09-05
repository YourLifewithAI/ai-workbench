// SEC-38 (RUN-18, D-69): a project's tool ceiling never widens. For every agent, tool and ceiling, the decision
// with the ceiling is at most as permissive as without it; a ceiling entry for a tool the agent has no grant for
// changes nothing; a project's memory list only removes scopes. Checked as a property over the shipped grants and
// a fuzzed set of ceilings, not as a sample of hand-picked cases.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { effectivePermissions, grantFor } from '../../src/runtime/security/permissions.js';
import { scopesFor } from '../../src/runtime/engine/step.js';
import { startRuntime, tempWorkspace, type Started } from '../helpers/workspace.js';

let rt: Started;
beforeAll(async () => { rt = await startRuntime(tempWorkspace('sec38'), { providerOverride: 'mock' }); });
afterAll(async () => { await rt.stop(); });

// A small deterministic generator, so a failure names the seed that produced it.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}

describe('SEC-38 a project ceiling only narrows', () => {
  it('for every agent × tool × ceiling, allowed-with implies allowed-without, with the same approval; refusals name the project', () => {
    const ws = rt.runtime.workspace;
    const tools = rt.runtime.engine.tools.catalog();
    const ids = tools.map((t) => t.id);
    const rand = lcg(38);
    const ceilings: string[][] = [[], ids, ...Array.from({ length: 60 }, () => ids.filter(() => rand() < 0.4))];
    let compared = 0;
    for (const agent of ws.agents.values()) {
      for (const tool of tools) {
        const source = { requested: agent.definition.permissions, granted: grantFor(ws.config, agent.definition.id), toolMax: tool.maxPermissions };
        const without = effectivePermissions(source).decide(tool.id, tool.approvalByDefault ?? false);
        for (const ceiling of ceilings) {
          const withCeiling = effectivePermissions({ ...source, projectCeiling: { project: 'p', tools: ceiling } }).decide(tool.id, tool.approvalByDefault ?? false);
          compared++;
          if (withCeiling.allowed) {
            expect(without.allowed, `${agent.definition.id}/${tool.id}: the ceiling allowed what the grant refuses`).toBe(true);
            expect(withCeiling.approval, `${agent.definition.id}/${tool.id}: the ceiling changed the approval`).toBe(without.allowed && without.approval);
          }
          if (!withCeiling.allowed && without.allowed) {
            expect(ceiling.includes(tool.id)).toBe(false);
            expect(withCeiling.reason).toBe(`"${tool.id}" is not allowed in project p.`);
          }
          if (!without.allowed) {
            // Nothing granted: the ceiling's entry, present or not, changes nothing, including the words.
            expect(withCeiling).toEqual(without);
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(1000);
  });

  it('a memory list only removes scopes, keeps their order, and never invents one', () => {
    const all = scopesFor('weaver', 'anthology');
    const lists: ('agent' | 'user' | 'workspace' | 'project')[][] = [['agent'], ['user'], ['project', 'user'], ['agent', 'project', 'workspace', 'user'], ['workspace', 'agent']];
    for (const allowed of lists) {
      const narrowed = scopesFor('weaver', 'anthology', allowed);
      expect(narrowed.every((s) => all.some((a) => a.scope === s.scope && a.ownerId === s.ownerId))).toBe(true);
      expect(narrowed.map((s) => s.scope)).toEqual(all.map((s) => s.scope).filter((s) => allowed.includes(s)));
    }
    expect(scopesFor('weaver', null, ['project'])).toEqual([]);
  });

  it('nothing in project.json can lift an approval or widen maxPermissions: the schema has no such key', async () => {
    const res = await fetch(`${rt.baseUrl}/api/v1/projects/site/space`, {
      method: 'PUT', headers: { Authorization: `Bearer ${rt.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseVersion: 'none', space: { schemaVersion: 1, agents: [], memory: ['agent'], approvalRequired: [], permissions: { tools: { shell: 'allow' } } } }),
    });
    expect(res.status).toBe(400);
  });
});
