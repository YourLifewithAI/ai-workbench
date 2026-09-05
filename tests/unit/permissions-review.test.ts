// The permissions review's arithmetic (D-63, RUN-14): which findings the numbers support, and what applying
// one writes. Pure functions over facts, so a wrong threshold or a wrong proposal is caught without a model.
import { describe, it, expect } from 'vitest';
import { applyProposal, candidateFindings, hostMatches, type PermissionFacts } from '../../src/runtime/permissions/review.js';
import { Permissions } from '../../src/shared/permissions.js';

const facts = (over: Partial<PermissionFacts>): PermissionFacts => ({
  generatedAt: '2026-09-05T00:00:00.000Z', thresholds: { unusedDays: 30, fatigueStreak: 30 },
  agents: [], tools: [], grants: [], approvals: [], hosts: [], undecided: [], candidates: [], ...over,
});

describe('candidate findings', () => {
  it('raises a grant never used once it is old enough, with the age and the zero as evidence', () => {
    const out = candidateFindings(facts({ grants: [
      { agentId: 'researcher', tool: 'http.fetch', decision: 'allow', since: '2026-07-27T00:00:00.000Z', sinceSource: 'log', ageDays: 40, uses: 0, lastUsedAt: null },
      { agentId: 'researcher', tool: 'web.search', decision: 'allow', since: '2026-07-27T00:00:00.000Z', sinceSource: 'log', ageDays: 40, uses: 12, lastUsedAt: '2026-09-01T00:00:00.000Z' },
      { agentId: 'weaver', tool: 'calc', decision: 'allow', since: '2026-09-01T00:00:00.000Z', sinceSource: 'workspace', ageDays: 4, uses: 0, lastUsedAt: null },
    ] }));
    expect(out.map((c) => c.id)).toEqual(['unused:researcher:http.fetch']);
    expect(out[0]!.headline).toBe('researcher holds http.fetch and has never used it.');
    expect(out[0]!.evidence[0]).toBe('Granted 40 days ago, on 2026-07-27.');
    expect(out[0]!.evidence[1]).toContain('0 times');
    expect(out[0]!.proposal).toMatchObject({ agentId: 'researcher', tool: 'http.fetch', set: 'unset' });
  });

  it('raises approval fatigue at the streak, proposing an outright grant only when the matrix can give one', () => {
    const base = { agentId: 'weaver', tool: 'artifact.write', asked: 31, allowed: 31, denied: 0, expired: 0, streak: 31, lastAt: '2026-09-04T00:00:00.000Z', byDefault: false, byAgentFile: false };
    const grantable = candidateFindings(facts({ approvals: [base] }));
    expect(grantable[0]).toMatchObject({ kind: 'fatigue', proposal: { set: 'allow' } });
    const byDefault = candidateFindings(facts({ approvals: [{ ...base, tool: 'shell', byDefault: true }] }));
    expect(byDefault[0]!.proposal).toBeNull();
    expect(byDefault[0]!.evidence.join(' ')).toContain('asks every time by design');
    const short = candidateFindings(facts({ approvals: [{ ...base, streak: 29 }] }));
    expect(short).toEqual([]);
  });

  it('raises reach only when some allowed host was never reached and at least one was', () => {
    const out = candidateFindings(facts({ hosts: [
      { agentId: 'researcher', allowed: ['api.example.com', 'docs.example.com'], used: ['api.example.com'], unused: ['docs.example.com'] },
      { agentId: 'builder', allowed: ['x.example.com'], used: [], unused: ['x.example.com'] },
    ] }));
    expect(out.map((c) => c.id)).toEqual(['reach:researcher:net']);
    expect(out[0]!.proposal).toMatchObject({ netAllow: ['api.example.com'] });
  });

  it('raises undecided per agent that asks, and stays quiet about tools nobody asks for', () => {
    const out = candidateFindings(facts({ undecided: [
      { tool: 'fs.read', tier: 'read', firstSeenAt: '2026-09-01T00:00:00.000Z', requestedBy: ['builder'] },
      { tool: 'calc', tier: 'read', firstSeenAt: null, requestedBy: [] },
    ] }));
    expect(out.map((c) => c.id)).toEqual(['undecided:builder:fs.read']);
    expect(out[0]!.proposal).toMatchObject({ set: 'deny' });
  });

  it('hashes the facts, so the same numbers give the same hash and a change gives another', () => {
    const grant = { agentId: 'a', tool: 't', decision: 'allow' as const, since: '2026-07-01T00:00:00.000Z', sinceSource: 'log' as const, ageDays: 66, uses: 0, lastUsedAt: null };
    const one = candidateFindings(facts({ grants: [grant] }))[0]!.factsHash;
    const same = candidateFindings(facts({ grants: [{ ...grant, ageDays: 67 }] }))[0]!.factsHash;
    const moved = candidateFindings(facts({ grants: [{ ...grant, since: '2026-08-01T00:00:00.000Z' }] }))[0]!.factsHash;
    expect(same).toBe(one);
    expect(moved).not.toBe(one);
  });
});

describe('applying a proposal', () => {
  it('sets, unsets, and narrows hosts, and an outright grant stops the grant asking', () => {
    const current = Permissions.parse({ tools: { 'http.fetch': 'allow', 'web.search': 'allow' }, approvalRequired: ['web.search'], net: { mode: 'allowlist', allow: ['a.example.com', 'b.example.com'] } });
    expect(applyProposal(current, { agentId: 'r', tool: 'http.fetch', set: 'unset', label: '' })['tools']).toEqual({ 'web.search': 'allow' });
    expect(applyProposal(current, { agentId: 'r', tool: 'web.search', set: 'allow', label: '' })['approvalRequired']).toEqual([]);
    expect(applyProposal(current, { agentId: 'r', netAllow: ['a.example.com'], label: '' })['net']).toMatchObject({ mode: 'allowlist', allow: ['a.example.com'] });
    expect(applyProposal(undefined, { agentId: 'r', tool: 'calc', set: 'deny', label: '' })).toEqual({ tools: { calc: 'deny' } });
  });
});

describe('hostMatches', () => {
  it('reads a wildcard the way the egress checker does', () => {
    expect(hostMatches('*.example.com', 'api.example.com')).toBe(true);
    expect(hostMatches('*.example.com', 'example.com')).toBe(true);
    expect(hostMatches('api.example.com', 'API.example.com')).toBe(true);
    expect(hostMatches('api.example.com', 'docs.example.com')).toBe(false);
  });
});
