// The facts a permissions review rests on, and the candidate findings the runtime can see on its own (D-63,
// RUN-14). Everything here is metadata: which grants exist and since when, how often each was exercised, how
// approvals were answered, which hosts were reached. No trace content, no memory, no document, no credential.
// The auditor agent reads this and decides what to raise; the evidence on a finding is these numbers, never
// the model's words, so a finding cannot be argued into existence.
import type { Db } from '../db/index.js';
import type { ToolDefinition } from '../../shared/tool.js';
import type { FindingKind, FindingProposal } from '../../shared/api/index.js';
import type { Workspace } from '../workspace/loader.js';
import type { Permissions } from '../../shared/permissions.js';
import { grantFor } from '../security/permissions.js';
import { contentHash } from '../util/canonical.js';

export interface ReviewThresholds {
  /** A grant this old that was never exercised is a candidate. */
  unusedDays: number;
  /** This many approvals in a row without a rejection is a candidate. */
  fatigueStreak: number;
}
export const DEFAULT_THRESHOLDS: ReviewThresholds = { unusedDays: 30, fatigueStreak: 30 };

export interface AgentFact {
  id: string;
  name: string;
  version: string;
  /** The agent's own instructions, so "the instructions no longer justify this" can be judged. Not a trace. */
  instructions: string;
  /** Tools the agent's file asks for. Asking grants nothing (D-26). */
  requested: string[];
  /** The grant matrix row a human wrote. */
  granted: Record<string, 'allow' | 'deny'>;
  approvalRequired: string[];
  net: { mode: string | null; allow: string[] };
}
export interface ToolFact { id: string; tier: string; description: string; usesNetwork: boolean; approvalByDefault: boolean; firstSeenAt: string | null }
export interface GrantFact {
  agentId: string; tool: string; decision: 'allow' | 'deny';
  since: string; sinceSource: 'log' | 'workspace'; ageDays: number;
  uses: number; lastUsedAt: string | null;
}
export interface ApprovalFact {
  agentId: string | null; tool: string; asked: number; allowed: number; denied: number; expired: number;
  /** Consecutive approvals since the last denial or timeout. */
  streak: number; lastAt: string | null;
  /** True when the tool asks whatever the grant says (shell, a non-GET fetch): nothing in the matrix can waive it. */
  byDefault: boolean;
  /** True when the agent's own file demands the approval, which the matrix cannot waive either. */
  byAgentFile: boolean;
}
export interface HostFact { agentId: string; allowed: string[]; used: string[]; unused: string[] }
/** A project's space (D-69): its agents, its tool ceiling (null: none), the memory scopes it uses. */
export interface ProjectFact { slug: string; agents: string[]; tools: string[] | null; memory: string[] }
export interface UndecidedFact { tool: string; tier: string; firstSeenAt: string | null; requestedBy: string[] }
export interface Candidate {
  id: string; kind: FindingKind; agentId: string | null; tool: string | null;
  headline: string; evidence: string[]; proposal: FindingProposal | null; factsHash: string;
}
export interface PermissionFacts {
  generatedAt: string;
  thresholds: ReviewThresholds;
  agents: AgentFact[];
  tools: ToolFact[];
  grants: GrantFact[];
  approvals: ApprovalFact[];
  hosts: HostFact[];
  undecided: UndecidedFact[];
  projects: ProjectFact[];
  candidates: Candidate[];
}

export interface FactsDeps {
  db: Db;
  workspace: () => Workspace;
  tools: () => ToolDefinition[];
  now?: (() => Date) | undefined;
}

const DAY = 86_400_000;
const day = (iso: string): string => iso.slice(0, 10);

/** Everything the review can know, from the database and the workspace. */
export function gatherFacts(deps: FactsDeps, thresholds: ReviewThresholds = DEFAULT_THRESHOLDS): PermissionFacts {
  const now = deps.now ? deps.now() : new Date();
  const ws = deps.workspace();
  const tools = deps.tools();
  const firstSeen = new Map((deps.db.prepare('SELECT tool, first_seen_at FROM tool_catalog_seen').all() as { tool: string; first_seen_at: string }[]).map((r) => [r.tool, r.first_seen_at]));

  const agents: AgentFact[] = [...ws.agents.values()].map((agent) => {
    const granted = grantFor(ws.config, agent.definition.id);
    return {
      id: agent.definition.id,
      name: agent.definition.name,
      version: agent.version,
      instructions: agent.sections.map((s) => `## ${s.name}\n${s.text}`).join('\n\n').slice(0, 4000),
      requested: [...new Set([...agent.definition.tools.map((t) => t.id), ...Object.keys(agent.definition.permissions.tools)])].sort(),
      granted: granted?.tools ?? {},
      approvalRequired: granted?.approvalRequired ?? [],
      net: { mode: granted?.net.mode ?? null, allow: granted?.net.allow ?? [] },
    };
  }).sort((a, b) => a.id.localeCompare(b.id));

  const projects: ProjectFact[] = [...ws.spaces.values()].map((sp) => ({
    slug: sp.slug, agents: [...sp.definition.agents].sort(), tools: sp.definition.tools ? [...sp.definition.tools].sort() : null, memory: [...sp.definition.memory],
  })).sort((a, b) => a.slug.localeCompare(b.slug));

  const toolFacts: ToolFact[] = tools.map((t) => ({
    id: t.id, tier: t.tier, description: t.description, usesNetwork: t.usesNetwork === true, approvalByDefault: t.approvalByDefault === true,
    firstSeenAt: firstSeen.get(t.id) ?? null,
  })).sort((a, b) => a.id.localeCompare(b.id));

  const useRow = deps.db.prepare('SELECT COUNT(*) AS uses, MAX(ts) AS last FROM tool_calls WHERE agent_id = ? AND tool = ? AND ok = 1');
  const sinceRow = deps.db.prepare('SELECT after_json, at FROM grant_log WHERE agent_id = ? AND tool = ? ORDER BY at DESC LIMIT 1');
  const grants: GrantFact[] = [];
  for (const agent of agents) {
    for (const [tool, decision] of Object.entries(agent.granted)) {
      const latest = sinceRow.get(agent.id, tool) as { after_json: string; at: string } | undefined;
      const fromLog = latest && JSON.parse(latest.after_json) === decision;
      const since = fromLog ? latest.at : ws.file.createdAt;
      const uses = useRow.get(agent.id, tool) as { uses: number; last: string | null };
      grants.push({
        agentId: agent.id, tool, decision, since, sinceSource: fromLog ? 'log' : 'workspace',
        ageDays: Math.max(0, Math.floor((now.getTime() - Date.parse(since)) / DAY)),
        uses: uses.uses, lastUsedAt: uses.last,
      });
    }
  }

  // Approvals, attributed to the agent that asked through the call the executor recorded for that step.
  const approvalRows = deps.db.prepare(`
    SELECT a.tool, a.state, a.created_at,
      COALESCE((SELECT t.agent_id FROM tool_calls t WHERE t.run_id = a.run_id AND t.step_id = a.step_id AND t.tool = a.tool ORDER BY t.ts DESC LIMIT 1),
               (SELECT r.agent_id FROM runs r WHERE r.id = a.run_id)) AS agent_id
    FROM approvals a WHERE a.state != 'pending' ORDER BY a.created_at`).all() as { tool: string; state: string; created_at: string; agent_id: string | null }[];
  const byPair = new Map<string, typeof approvalRows>();
  for (const row of approvalRows) {
    const k = `${row.agent_id ?? '-'}|${row.tool}`;
    byPair.set(k, [...(byPair.get(k) ?? []), row]);
  }
  const approvals: ApprovalFact[] = [...byPair.values()].map((rows) => {
    const first = rows[0]!;
    let streak = 0;
    for (let i = rows.length - 1; i >= 0 && rows[i]!.state === 'allowed'; i--) streak++;
    const tool = tools.find((t) => t.id === first.tool);
    const agent = agents.find((a) => a.id === first.agent_id);
    const agentFile = first.agent_id ? ws.agents.get(first.agent_id)?.definition.permissions.approvalRequired ?? [] : [];
    return {
      agentId: first.agent_id, tool: first.tool, asked: rows.length,
      allowed: rows.filter((r) => r.state === 'allowed').length, denied: rows.filter((r) => r.state === 'denied').length,
      expired: rows.filter((r) => r.state === 'expired').length, streak, lastAt: rows[rows.length - 1]!.created_at,
      byDefault: tool?.approvalByDefault === true,
      byAgentFile: agentFile.includes(first.tool) && !(agent?.approvalRequired ?? []).includes(first.tool),
    };
  }).sort((a, b) => `${a.agentId}|${a.tool}`.localeCompare(`${b.agentId}|${b.tool}`));

  // Hosts: what the grant admits against what the agent's tools ever reached (model calls are not the agent's reach).
  const hostRows = deps.db.prepare(`
    SELECT DISTINCT t.agent_id AS agent_id, e.host AS host FROM egress_log e
    JOIN tool_calls t ON t.run_id = e.run_id AND t.step_id = e.step_id
    WHERE e.purpose != 'model' AND e.decision = 'allowed' AND t.agent_id IS NOT NULL`).all() as { agent_id: string; host: string }[];
  const hosts: HostFact[] = agents.filter((a) => a.net.allow.length).map((a) => {
    const used = [...new Set(hostRows.filter((r) => r.agent_id === a.id).map((r) => r.host))].sort();
    const unused = a.net.allow.filter((pattern) => !used.some((h) => hostMatches(pattern, h)));
    return { agentId: a.id, allowed: [...a.net.allow].sort(), used, unused };
  });

  const decided = new Set(agents.flatMap((a) => Object.keys(a.granted)));
  const undecided: UndecidedFact[] = toolFacts.filter((t) => !decided.has(t.id)).map((t) => ({
    tool: t.id, tier: t.tier, firstSeenAt: t.firstSeenAt, requestedBy: agents.filter((a) => a.requested.includes(t.id)).map((a) => a.id),
  }));

  const facts: PermissionFacts = { generatedAt: now.toISOString(), thresholds, agents, tools: toolFacts, grants, approvals, hosts, undecided,
    projects, candidates: [] };
  facts.candidates = candidateFindings(facts);
  return facts;
}

/** `*.example.com` admits a subdomain; a plain host admits itself. The egress checker's rule, at the review's altitude. */
export function hostMatches(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase();
  const h = host.toLowerCase();
  if (p.startsWith('*.')) return h === p.slice(2) || h.endsWith(p.slice(1));
  return p === h;
}

/**
 * The findings the numbers alone support. The auditor may raise any of these by id and may add an
 * `unjustified` finding of its own; it cannot change the evidence on one, which is computed here.
 */
export function candidateFindings(facts: PermissionFacts): Candidate[] {
  const out: Candidate[] = [];
  const t = facts.thresholds;

  // Nowhere (D-69): an agent's grant that no project it belongs to allows. Every project it is an agent of has
  // a ceiling, and none of them lists the tool, so the grant is real and nowhere usable.
  for (const g of facts.grants) {
    if (g.decision !== 'allow') continue;
    const mine = facts.projects.filter((p) => p.agents.includes(g.agentId));
    if (!mine.length || mine.some((p) => p.tools === null || p.tools.includes(g.tool))) continue;
    out.push({
      id: `nowhere:${g.agentId}:${g.tool}`, kind: 'nowhere', agentId: g.agentId, tool: g.tool,
      headline: `${g.agentId} holds ${g.tool}, and no project it works in allows it.`,
      evidence: [
        `${g.agentId} is an agent of ${mine.map((p) => p.slug).join(', ')}.`,
        ...mine.map((p) => `${p.slug} allows: ${p.tools!.join(', ') || 'nothing'}.`),
        `Exercised ${g.uses} time${g.uses === 1 ? '' : 's'}.`,
      ],
      proposal: { agentId: g.agentId, tool: g.tool, set: 'unset', label: `Take back ${g.tool} from ${g.agentId}` },
      factsHash: contentHash({ kind: 'nowhere', agentId: g.agentId, tool: g.tool, projects: mine.map((p) => [p.slug, p.tools]) }),
    });
  }

  for (const g of facts.grants) {
    if (g.decision !== 'allow' || g.uses !== 0 || g.ageDays < t.unusedDays) continue;
    out.push({
      id: `unused:${g.agentId}:${g.tool}`, kind: 'unused', agentId: g.agentId, tool: g.tool,
      headline: `${g.agentId} holds ${g.tool} and has never used it.`,
      evidence: [
        g.sinceSource === 'log' ? `Granted ${g.ageDays} days ago, on ${day(g.since)}.` : `Held for ${g.ageDays} days, since the workspace was created on ${day(g.since)}.`,
        'Exercised 0 times in that time.',
        'The safest grant is the one you take back; the agent can ask again with permission.request.',
      ],
      proposal: { agentId: g.agentId, tool: g.tool, set: 'unset', label: `Take back ${g.tool} from ${g.agentId}` },
      factsHash: contentHash({ kind: 'unused', agentId: g.agentId, tool: g.tool, since: g.since, uses: 0 }),
    });
  }

  for (const h of facts.hosts) {
    if (!h.unused.length || !h.used.length) continue;
    out.push({
      id: `reach:${h.agentId}:net`, kind: 'reach', agentId: h.agentId, tool: null,
      headline: `${h.agentId} may reach hosts it has never asked for.`,
      evidence: [
        `Allowed: ${h.allowed.join(', ')}.`,
        `Reached: ${h.used.join(', ')}.`,
        `Never asked for: ${h.unused.join(', ')}.`,
      ],
      proposal: { agentId: h.agentId, netAllow: h.used, label: `Narrow ${h.agentId}'s hosts to ${h.used.join(', ')}` },
      factsHash: contentHash({ kind: 'reach', agentId: h.agentId, allowed: h.allowed, used: h.used }),
    });
  }

  for (const a of facts.approvals) {
    if (a.streak < t.fatigueStreak || !a.agentId) continue;
    const grant = facts.grants.find((g) => g.agentId === a.agentId && g.tool === a.tool);
    const agent = facts.agents.find((x) => x.id === a.agentId);
    const evidence = [
      `Approved ${a.streak} times in a row without a rejection; ${a.asked} asked in all, last on ${day(a.lastAt ?? facts.generatedAt)}.`,
    ];
    let proposal: FindingProposal | null = null;
    if (a.byDefault) {
      evidence.push(`${a.tool} asks every time by design; nothing in the matrix can grant it outright. If the agent needs it this often, the question is whether it should hold it at all.`);
    } else if (a.byAgentFile) {
      evidence.push(`The agent's own file lists ${a.tool} under approvalRequired, which the matrix cannot waive. Edit the agent if this should stop asking.`);
    } else if (grant?.decision !== 'allow') {
      evidence.push('Either it should be granted outright, or you have stopped reading the card. Both are worth saying out loud.');
      proposal = { agentId: a.agentId, tool: a.tool, set: 'allow', label: `Grant ${a.tool} to ${a.agentId} outright` };
    } else if ((agent?.approvalRequired ?? []).includes(a.tool)) {
      evidence.push('It is granted, and the grant still asks each time. Either stop asking, or you have stopped reading the card.');
      proposal = { agentId: a.agentId, tool: a.tool, set: 'allow', label: `Stop asking before ${a.agentId} uses ${a.tool}` };
    } else {
      evidence.push('Approved each time under a policy the matrix does not set (a network mode, or a remembered rule that no longer matches).');
    }
    out.push({
      id: `fatigue:${a.agentId}:${a.tool}`, kind: 'fatigue', agentId: a.agentId, tool: a.tool,
      headline: `${a.tool} for ${a.agentId} has been approved ${a.streak} times in a row.`,
      evidence, proposal,
      factsHash: contentHash({ kind: 'fatigue', agentId: a.agentId, tool: a.tool, streak: a.streak, asked: a.asked }),
    });
  }

  for (const u of facts.undecided) {
    for (const agentId of u.requestedBy) {
      out.push({
        id: `undecided:${agentId}:${u.tool}`, kind: 'undecided', agentId, tool: u.tool,
        headline: `${u.tool} has never been granted or denied to anyone, and ${agentId} asks for it.`,
        evidence: [
          u.firstSeenAt ? `In the catalogue since ${day(u.firstSeenAt)}.` : 'In the catalogue since before this workbench kept track.',
          `${agentId}'s file asks for it; asking grants nothing, and no person has said yes or no.`,
        ],
        proposal: { agentId, tool: u.tool, set: 'deny', label: `Deny ${u.tool} to ${agentId}` },
        factsHash: contentHash({ kind: 'undecided', agentId, tool: u.tool, requestedBy: u.requestedBy }),
      });
    }
  }

  return out;
}

/** What the auditor may raise on its own: a grant its reading of the instructions no longer supports. */
export function unjustifiedCandidate(facts: PermissionFacts, agentId: string, tool: string): Candidate | null {
  const grant = facts.grants.find((g) => g.agentId === agentId && g.tool === tool && g.decision === 'allow');
  const agent = facts.agents.find((a) => a.id === agentId);
  if (!grant || !agent) return null;
  return {
    id: `unjustified:${agentId}:${tool}`, kind: 'unjustified', agentId, tool,
    headline: `${agentId} holds ${tool}; the auditor reads its instructions as no longer needing it.`,
    evidence: [
      grant.sinceSource === 'log' ? `Granted ${grant.ageDays} days ago, on ${day(grant.since)}.` : `Held since the workspace was created on ${day(grant.since)}.`,
      `Exercised ${grant.uses} time${grant.uses === 1 ? '' : 's'}${grant.lastUsedAt ? `, last on ${day(grant.lastUsedAt)}` : ''}.`,
      `The agent's instructions are at version ${agent.version.replace('sha256:', '').slice(0, 12)}; this returns if they change.`,
    ],
    proposal: { agentId, tool, set: 'unset', label: `Take back ${tool} from ${agentId}` },
    factsHash: contentHash({ kind: 'unjustified', agentId, tool, agentVersion: agent.version, since: grant.since }),
  };
}

/** Marks every tool in the catalogue as seen, once. Called at start, so "new" has a date. */
export function recordCatalogSeen(db: Db, tools: ToolDefinition[], now = new Date()): void {
  const insert = db.prepare('INSERT OR IGNORE INTO tool_catalog_seen (tool, first_seen_at) VALUES (?, ?)');
  for (const t of tools) insert.run(t.id, now.toISOString());
}

/**
 * Apply a proposal to a grant block, returning the new block. Pure: the caller (a human's request, only ever)
 * writes it through the same `setGrant` the Tools screen uses.
 */
export function applyProposal(current: Permissions | undefined, proposal: FindingProposal): Record<string, unknown> {
  const base: Record<string, unknown> = current ? { ...current } : {};
  if (proposal.tool && proposal.set) {
    const tools = { ...(current?.tools ?? {}) };
    if (proposal.set === 'unset') delete tools[proposal.tool];
    else tools[proposal.tool] = proposal.set;
    base['tools'] = tools;
    if (proposal.set === 'allow') base['approvalRequired'] = (current?.approvalRequired ?? []).filter((t) => t !== proposal.tool);
  }
  if (proposal.netAllow) base['net'] = { ...(current?.net ?? { allow: [], allowLocalAddresses: false, approvalExempt: [] }), allow: proposal.netAllow };
  return base;
}

/**
 * What the auditor is actually shown. A tool result is cut at `context.maxToolResultChars` (D-47), so the
 * brief puts what matters first — the candidates, then the numbers, then a short slice of each agent's
 * instructions — and leaves out what the runtime keeps for itself (the evidence text, tool descriptions).
 * A workspace with many agents loses the tail of the instructions, never a candidate.
 */
export interface FactsBrief {
  generatedAt: string;
  thresholds: ReviewThresholds;
  candidates: { id: string; headline: string; proposal: string | null }[];
  undecided: { tool: string; requestedBy: string[] }[];
  approvals: { agentId: string | null; tool: string; asked: number; streak: number }[];
  hosts: { agentId: string; allowed: string[]; used: string[] }[];
  projects: { slug: string; agents: string[]; tools: string[] | null }[];
  grants: { agentId: string; tool: string; decision: 'allow' | 'deny'; ageDays: number; uses: number }[];
  agents: { id: string; holds: string[]; instructions: string }[];
}

export function briefOf(facts: PermissionFacts, instructionChars = 260): FactsBrief {
  return {
    generatedAt: facts.generatedAt,
    thresholds: facts.thresholds,
    candidates: facts.candidates.map((c) => ({ id: c.id, headline: c.headline, proposal: c.proposal?.label ?? null })),
    undecided: facts.undecided.filter((u) => u.requestedBy.length).map((u) => ({ tool: u.tool, requestedBy: u.requestedBy })),
    approvals: facts.approvals.map((a) => ({ agentId: a.agentId, tool: a.tool, asked: a.asked, streak: a.streak })),
    hosts: facts.hosts.map((h) => ({ agentId: h.agentId, allowed: h.allowed, used: h.used })),
    projects: facts.projects.map((p) => ({ slug: p.slug, agents: p.agents, tools: p.tools })),
    grants: facts.grants.map((g) => ({ agentId: g.agentId, tool: g.tool, decision: g.decision, ageDays: g.ageDays, uses: g.uses })),
    agents: facts.agents
      .filter((a) => Object.keys(a.granted).length)
      .map((a) => ({ id: a.id, holds: Object.keys(a.granted).sort(), instructions: a.instructions.replace(/^## \S+\n/gm, '').replace(/\s+/g, ' ').trim().slice(0, instructionChars) })),
  };
}
