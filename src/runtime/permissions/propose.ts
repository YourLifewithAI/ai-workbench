// Turning what the auditor chose into rows in the queue (D-63, RUN-14). A candidate is raised on the runtime's
// evidence; an `unjustified` finding is the auditor's own, on the runtime's numbers for that grant. Anything
// else — an id that does not exist, a grant the agent does not hold — is ignored and reported back by name.
import type { FindingStore } from './store.js';
import { unjustifiedCandidate, type PermissionFacts } from './review.js';
import type { ProposedFinding } from '../tools/builtin/permissions.js';

export function proposeFindings(store: FindingStore, facts: PermissionFacts, proposed: ProposedFinding[], runId: string | null) {
  const result = { raised: 0, refreshed: 0, suppressed: 0, ignored: [] as string[], ids: [] as string[] };
  const seen = new Set<string>();
  for (const p of proposed) {
    const candidate = p.candidate
      ? facts.candidates.find((c) => c.id === p.candidate)
      : p.kind === 'unjustified' && p.agentId && p.tool ? unjustifiedCandidate(facts, p.agentId, p.tool) : null;
    if (!candidate) { result.ignored.push(p.candidate ?? `${p.kind ?? '?'}:${p.agentId ?? '?'}:${p.tool ?? '?'}`); continue; }
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    const note = typeof p.note === 'string' && p.note.trim() ? p.note.trim().slice(0, 600) : null;
    const outcome = store.raise({
      key: candidate.id, kind: candidate.kind, agentId: candidate.agentId, tool: candidate.tool,
      headline: candidate.headline, evidence: candidate.evidence, note, proposal: candidate.proposal, factsHash: candidate.factsHash,
    }, runId);
    result[outcome.outcome] += 1;
    if (outcome.id) result.ids.push(outcome.id);
  }
  return result;
}
