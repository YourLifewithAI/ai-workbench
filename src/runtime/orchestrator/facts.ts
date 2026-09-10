// What the orchestrator sees of the fleet (D-73, RUN-23): facts about runs, never their content. The same
// standing as the auditor's `permissions.facts` (D-63) — ids, states, models, costs, tool calls by name,
// approvals, reviews, the owner's ratings, taint flags, the paths of documents filed, and the D-58 summary
// lines — and for the same reason: an agent that decides from facts stays untainted, so what it then writes
// applies rather than being filed for a person. Reading an *output* is `artifact.read`, which taints (SEC-42).
import type { Db } from '../db/index.js';
import type { Workspace } from '../workspace/loader.js';
import type { RunDetail } from '../../shared/api/index.js';
import type { EventRecord } from '../../shared/events.js';
import { summarizeRun } from '../../shared/summary.js';

export interface RunFactsFilter {
  /** ISO 8601; runs started at or after this instant. */
  since?: string | undefined;
  agent?: string | undefined;
  project?: string | undefined;
  /** At most 100; default 20. */
  limit?: number | undefined;
  /** The asking agent: its own runs are facts too, but never candidates — it does not rate itself. */
  self?: string | undefined;
}

export interface RunFact {
  id: string;
  kind: string;
  state: string;
  agentId: string | null;
  workflowId: string | null;
  project: string | null;
  parentRunId: string | null;
  depth: number;
  startedAt: string;
  finishedAt: string | null;
  /** In order of first use; more than one means a fallback happened or a workflow crossed models. */
  models: string[];
  fallbacks: number;
  costUsd: number;
  modelCalls: number;
  tokensIn: number;
  tokensOut: number;
  wallClockMs: number;
  /** By name, with how many failed and how many were refused by the broker or a person. Never the arguments. */
  tools: { tool: string; calls: number; failed: number; refused: number }[];
  approvals: { asked: number; allowed: number; denied: number; expired: number };
  reviews: { stepId: string; state: string; attempt: number }[];
  /** What the person said (D-13): the number and their note. Nothing here is a model's opinion. */
  ratings: { stepId: string; value: number; note: string | null; ts: string }[];
  /** Estimates already on file — a judge's, or the orchestrator's own — so it does not rate twice. */
  scores: { evaluatorId: string; metric: string; value: number; estimate: boolean }[];
  /** A failure's code, or its first sentence; never a step's output. */
  failure: string | null;
  /** True when a document this run filed was cut short by a budget. */
  partial: boolean;
  /** `<project>/<path>` of every document version this run wrote. */
  documents: string[];
  taint: { private: boolean; external: boolean };
  /** The three lines a person sees on the run's page (D-58). */
  summary: string[];
}

export type RunCandidateKind = 'failing' | 'unrated' | 'costlier' | 'fallback' | 'partial';
export interface RunCandidate { id: string; kind: RunCandidateKind; runId: string; headline: string }

export interface RunFacts {
  generatedAt: string;
  filter: { since: string | null; agent: string | null; project: string | null; limit: number };
  /** How many runs matched before the limit, so "the last twenty" is known to be a slice. */
  matched: number;
  runs: RunFact[];
  candidates: RunCandidate[];
}

export interface RunFactsDeps {
  db: Db;
  workspace: () => Workspace;
  runDetail: (id: string) => RunDetail | null;
  events: (id: string) => EventRecord[];
  now?: (() => Date) | undefined;
}

export const MAX_RUN_FACTS = 100;
export const DEFAULT_RUN_FACTS = 20;

interface ListRow { id: string; kind: string; agent_id: string | null; workflow_id: string | null; parent_run_id: string | null; depth: number; private_tainted: number; external_tainted: number; error_json: string | null }

/** Everything the orchestrator may know about recent runs, from the database alone. */
export function gatherRunFacts(deps: RunFactsDeps, filter: RunFactsFilter = {}): RunFacts {
  const now = deps.now ? deps.now() : new Date();
  const limit = Math.max(1, Math.min(MAX_RUN_FACTS, Math.floor(filter.limit ?? DEFAULT_RUN_FACTS)));
  const clauses = ["kind != 'experiment'"];
  const params: unknown[] = [];
  if (filter.since) { clauses.push('started_at >= ?'); params.push(filter.since); }
  if (filter.agent) { clauses.push('agent_id = ?'); params.push(filter.agent); }
  if (filter.project) { clauses.push('project_id = ?'); params.push(filter.project); }
  const where = `WHERE ${clauses.join(' AND ')}`;
  const matched = (deps.db.prepare(`SELECT COUNT(*) AS n FROM runs ${where}`).get(...params) as { n: number }).n;
  const rows = deps.db.prepare(`SELECT id, kind, agent_id, workflow_id, parent_run_id, depth, private_tainted, external_tainted, error_json FROM runs ${where} ORDER BY started_at DESC LIMIT ?`)
    .all(...params, limit) as ListRow[];

  const modelsQ = deps.db.prepare('SELECT model_id, MIN(ts) AS first FROM model_calls WHERE run_id = ? GROUP BY model_id ORDER BY first');
  const tokensQ = deps.db.prepare("SELECT COALESCE(SUM(json_extract(usage_json, '$.input')), 0) AS tin, COALESCE(SUM(json_extract(usage_json, '$.output')), 0) AS tout FROM model_calls WHERE run_id = ?");
  const toolsQ = deps.db.prepare(`SELECT tool, COUNT(*) AS calls, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed,
    SUM(CASE WHEN error_code IN ('PermissionDenied', 'ApprovalDenied', 'ApprovalTimeout') THEN 1 ELSE 0 END) AS refused
    FROM tool_calls WHERE run_id = ? GROUP BY tool ORDER BY tool`);
  const approvalsQ = deps.db.prepare('SELECT state, COUNT(*) AS n FROM approvals WHERE run_id = ? GROUP BY state');
  const reviewsQ = deps.db.prepare('SELECT step_id, state, attempt FROM reviews WHERE run_id = ? ORDER BY created_at');
  const ratingsQ = deps.db.prepare('SELECT step_id, value, note, ts FROM ratings WHERE run_id = ? ORDER BY ts');
  const scoresQ = deps.db.prepare('SELECT evaluator_id, metric, value, estimate FROM scores WHERE run_id = ? ORDER BY ts');
  const documentsQ = deps.db.prepare(`SELECT p.slug AS slug, d.path AS path, v.partial AS partial FROM document_versions v
    JOIN documents d ON d.id = v.document_id JOIN projects p ON p.id = d.project_id WHERE v.run_id = ? ORDER BY v.created_at`);

  const ws = deps.workspace();
  const runs: RunFact[] = [];
  for (const row of rows) {
    const detail = deps.runDetail(row.id);
    if (!detail) continue;
    const events = deps.events(row.id);
    const who = row.agent_id ? ws.agents.get(row.agent_id)?.definition.name : row.workflow_id ? ws.workflows.get(row.workflow_id)?.definition.name : undefined;
    const summary = summarizeRun(detail, events, who);
    const tokens = tokensQ.get(row.id) as { tin: number; tout: number };
    const approvals = { asked: 0, allowed: 0, denied: 0, expired: 0 };
    for (const a of approvalsQ.all(row.id) as { state: string; n: number }[]) {
      if (a.state === 'pending') continue;
      approvals.asked += a.n;
      if (a.state === 'allowed') approvals.allowed += a.n;
      else if (a.state === 'denied') approvals.denied += a.n;
      else if (a.state === 'expired') approvals.expired += a.n;
    }
    const documents = documentsQ.all(row.id) as { slug: string; path: string; partial: number }[];
    runs.push({
      id: row.id, kind: row.kind, state: detail.state,
      agentId: row.agent_id, workflowId: row.workflow_id, project: detail.project ?? null,
      parentRunId: row.parent_run_id, depth: row.depth ?? 0,
      startedAt: detail.startedAt, finishedAt: detail.finishedAt ?? null,
      models: (modelsQ.all(row.id) as { model_id: string }[]).map((m) => m.model_id),
      fallbacks: events.filter((e) => e.type === 'fallback-selected').length,
      costUsd: detail.spent.costUsd, modelCalls: detail.spent.modelCalls,
      tokensIn: Number(tokens.tin), tokensOut: Number(tokens.tout), wallClockMs: detail.spent.wallClockMs,
      tools: (toolsQ.all(row.id) as { tool: string; calls: number; failed: number; refused: number }[]).map((t) => ({ tool: t.tool, calls: t.calls, failed: Number(t.failed), refused: Number(t.refused) })),
      approvals,
      reviews: (reviewsQ.all(row.id) as { step_id: string; state: string; attempt: number }[]).map((r) => ({ stepId: r.step_id, state: r.state, attempt: r.attempt })),
      ratings: (ratingsQ.all(row.id) as { step_id: string; value: number; note: string | null; ts: string }[]).map((r) => ({ stepId: r.step_id, value: r.value, note: r.note, ts: r.ts })),
      scores: (scoresQ.all(row.id) as { evaluator_id: string; metric: string; value: number; estimate: number }[]).map((s) => ({ evaluatorId: s.evaluator_id, metric: s.metric, value: s.value, estimate: s.estimate === 1 })),
      failure: failureOf(row.error_json),
      partial: documents.some((d) => d.partial === 1),
      documents: documents.map((d) => `${d.slug}/${d.path}`),
      taint: { private: row.private_tainted === 1, external: row.external_tainted === 1 },
      summary: [summary.headline, ...summary.lines],
    });
  }

  return {
    generatedAt: now.toISOString(),
    filter: { since: filter.since ?? null, agent: filter.agent ?? null, project: filter.project ?? null, limit },
    matched,
    runs,
    candidates: runCandidates(runs, filter.self),
  };
}

/** A failure as a code or a first sentence. The step's output, partial or not, is never here. */
function failureOf(errorJson: string | null): string | null {
  if (!errorJson) return null;
  try {
    const e = JSON.parse(errorJson) as unknown;
    if (typeof e === 'string') return e.split(/(?<=\.)\s/)[0]!.slice(0, 200);
    const o = e as { code?: unknown; reason?: unknown; message?: unknown };
    if (typeof o.code === 'string') return o.code;
    if (typeof o.reason === 'string') return o.reason;
    if (typeof o.message === 'string') return o.message.split(/(?<=\.)\s/)[0]!.slice(0, 200);
    return 'failed';
  } catch {
    return 'failed';
  }
}

/**
 * What the numbers alone point at. The orchestrator decides what to do about each; it cannot change what is
 * on the list, which is computed here, and its own runs are never on it.
 */
export function runCandidates(runs: RunFact[], self?: string | undefined): RunCandidate[] {
  const out: RunCandidate[] = [];
  const mine = runs.filter((r) => r.agentId === null || r.agentId !== self);
  const subject = (r: RunFact): string => r.agentId ?? r.workflowId ?? r.kind;

  for (const r of mine) {
    if (r.state === 'failed' || r.state === 'interrupted') {
      out.push({ id: `failing:${r.id}`, kind: 'failing', runId: r.id, headline: `${subject(r)} ${r.state}${r.failure ? `: ${r.failure}` : ''}` });
    }
  }
  for (const r of mine) {
    if (r.state === 'completed' && r.depth === 0 && !r.ratings.length && !r.scores.some((s) => s.evaluatorId === 'orchestrator')) {
      out.push({ id: `unrated:${r.id}`, kind: 'unrated', runId: r.id, headline: `${subject(r)} finished and nobody has rated it.` });
    }
  }
  // Costlier: more than twice the median of the same subject's completed runs, with at least three to compare.
  const bySubject = new Map<string, RunFact[]>();
  for (const r of mine) if (r.state === 'completed') bySubject.set(subject(r), [...(bySubject.get(subject(r)) ?? []), r]);
  for (const [name, group] of bySubject) {
    if (group.length < 3) continue;
    const sorted = group.map((r) => r.costUsd).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    if (median <= 0) continue;
    for (const r of group) {
      if (r.costUsd > 2 * median) {
        out.push({ id: `costlier:${r.id}`, kind: 'costlier', runId: r.id, headline: `${name} cost $${r.costUsd.toFixed(4)}, against a median of $${median.toFixed(4)} over ${group.length} runs.` });
      }
    }
  }
  for (const r of mine) {
    if (r.fallbacks > 0) out.push({ id: `fallback:${r.id}`, kind: 'fallback', runId: r.id, headline: `${subject(r)} fell back ${r.fallbacks} time${r.fallbacks === 1 ? '' : 's'}: ${r.models.join(' then ')}.` });
  }
  for (const r of mine) {
    if (r.partial) out.push({ id: `partial:${r.id}`, kind: 'partial', runId: r.id, headline: `${subject(r)} filed a document cut short by its budget.` });
  }
  return out;
}

/**
 * What the orchestrator is shown. A tool result is cut at `context.maxToolResultChars` (D-47), so candidates
 * come first, then one compact record per run. A long list loses its oldest runs, never a candidate.
 */
export interface RunFactsBrief {
  generatedAt: string;
  matched: number;
  shown: number;
  candidates: { id: string; headline: string }[];
  runs: {
    id: string; who: string; state: string; project: string | null; startedAt: string; depth: number;
    models: string[]; costUsd: number; calls: number; tools: string[];
    ratings: { value: number; note: string | null }[]; scores: { by: string; value: number }[];
    failure: string | null; documents: string[]; external: boolean; summary: string[];
  }[];
}

export function runFactsBrief(facts: RunFacts): RunFactsBrief {
  return {
    generatedAt: facts.generatedAt,
    matched: facts.matched,
    shown: facts.runs.length,
    candidates: facts.candidates.map((c) => ({ id: c.id, headline: c.headline })),
    runs: facts.runs.map((r) => ({
      id: r.id, who: r.agentId ?? r.workflowId ?? r.kind, state: r.state, project: r.project, startedAt: r.startedAt, depth: r.depth,
      models: r.models, costUsd: r.costUsd, calls: r.modelCalls,
      tools: r.tools.map((t) => `${t.tool}×${t.calls}${t.failed ? ` (${t.failed} failed)` : ''}${t.refused ? ` (${t.refused} refused)` : ''}`),
      ratings: r.ratings.map((x) => ({ value: x.value, note: x.note })),
      scores: r.scores.map((s) => ({ by: s.evaluatorId, value: s.value })),
      failure: r.failure, documents: r.documents, external: r.taint.external, summary: r.summary,
    })),
  };
}

/** One agent's definition and instructions, as `agents.read` returns it: everything but its grants. */
export interface AgentFacts {
  id: string;
  name: string;
  description: string;
  version: string;
  modelPolicy: { primary: string; fallbacks: string[] };
  /** Tools the file asks for. Asking grants nothing (D-26); what it holds is on the Tools screen, not here. */
  requested: string[];
  memory: { read: string[]; write: string[] };
  output: { kind: string; document: string | null };
  documents: string[];
  budgets: Record<string, number> | null;
  review: string;
  sections: { name: string; text: string }[];
}

export function agentFactsOf(ws: Workspace, id: string): AgentFacts | { error: string } {
  const agent = ws.agents.get(id);
  if (!agent) {
    const broken = ws.brokenAgents.find((b) => b.id === id);
    return { error: broken ? `Agent "${id}" failed to load: ${broken.message}` : `There is no agent called "${id}" in this workspace.` };
  }
  const d = agent.definition;
  return {
    id: d.id, name: d.name, description: d.description, version: agent.version,
    modelPolicy: { primary: d.modelPolicy.primary, fallbacks: d.modelPolicy.fallbacks },
    requested: [...new Set([...d.tools.map((t) => t.id), ...Object.keys(d.permissions.tools)])].sort(),
    memory: { read: [...d.memory.read], write: [...d.memory.write] },
    output: { kind: d.output.kind, document: d.output.document ?? null },
    documents: [...d.documents],
    budgets: d.budgets ? Object.fromEntries(Object.entries(d.budgets).filter(([, v]) => typeof v === 'number')) as Record<string, number> : null,
    review: d.review,
    sections: agent.sections.map((s) => ({ name: s.name, text: s.text })),
  };
}
