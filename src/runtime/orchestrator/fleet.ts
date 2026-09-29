// The fleet report (RUN-26, D-79): what every agent's card says. Counted in SQL, grouped by agent, in a handful
// of queries for the whole fleet — never `gatherRunFacts` per run, which replays each run's event list. The one
// event replay per agent is for its latest run's summary line (D-58), so the card reads the way the run's page
// does. No model is called anywhere here: the board is facts, and opening it is free.
import type { Db } from '../db/index.js';
import type { Workspace } from '../workspace/loader.js';
import type { AgentReport, AgentSummary, FleetResponse, RatingAggregate, RunDetail } from '../../shared/api/index.js';
import type { EventRecord } from '../../shared/events.js';
import { summarizeRun } from '../../shared/summary.js';
import { ORCHESTRATOR_EVALUATOR } from '../tools/builtin/orchestrator.js';

/** The orchestrator is the companion, promoted (D-73): same id, same directory. */
export const ORCHESTRATOR_AGENT = 'companion';
/** The window a card's *Lately* covers when nobody names one. */
export const DEFAULT_WINDOW_DAYS = 7;

export interface FleetDeps {
  db: Db;
  workspace: () => Workspace;
  runDetail: (id: string) => RunDetail | null;
  events: (id: string) => EventRecord[];
  /** Identity, policy, spend and heartbeat per agent id — what `GET /agents` already computes. */
  summaries: Map<string, AgentSummary>;
  /** What is waiting on a person, by the run it waits on: the board says whose it is. */
  reviews: { runId: string; blocking: boolean }[];
  approvals: { runId: string }[];
  decisions: { runId: string | null }[];
  now?: (() => Date) | undefined;
}

interface StateCount { agent_id: string; state: string; n: number; cost: number; calls: number }
interface StepCount { agent_id: string; n: number; cost: number; running: number }
interface TokenRow { agent_id: string; tin: number; tout: number }
interface Aggregate { agent_id: string; n: number; mean: number }
interface Latest { agent_id: string; why: string | null; ts: string }

export function fleetReport(deps: FleetDeps, opts: { since?: string | undefined } = {}): FleetResponse {
  const now = deps.now?.() ?? new Date();
  const since = opts.since ?? new Date(now.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000).toISOString();
  const db = deps.db;

  // The window, in six grouped queries for the whole fleet.
  const byState = db.prepare(`SELECT agent_id, state, COUNT(*) AS n,
      COALESCE(SUM(json_extract(spent_json, '$.costUsd')), 0) AS cost, COALESCE(SUM(json_extract(spent_json, '$.modelCalls')), 0) AS calls
    FROM runs WHERE kind = 'agent' AND agent_id IS NOT NULL AND started_at >= ? GROUP BY agent_id, state`).all(since) as StateCount[];
  const steps = db.prepare(`SELECT s.agent_id, COUNT(*) AS n, COALESCE(SUM(s.cost_usd), 0) AS cost,
      SUM(CASE WHEN s.state = 'running' THEN 1 ELSE 0 END) AS running
    FROM run_steps s JOIN runs r ON r.id = s.run_id
    WHERE s.agent_id IS NOT NULL AND r.kind = 'workflow' AND r.started_at >= ? GROUP BY s.agent_id`).all(since) as StepCount[];
  const tokens = db.prepare(`SELECT agent_id, SUM(tin) AS tin, SUM(tout) AS tout FROM (
      SELECT r.agent_id AS agent_id, COALESCE(json_extract(m.usage_json, '$.input'), 0) AS tin, COALESCE(json_extract(m.usage_json, '$.output'), 0) AS tout
        FROM model_calls m JOIN runs r ON r.id = m.run_id WHERE r.agent_id IS NOT NULL AND m.ts >= ?
      UNION ALL
      SELECT s.agent_id, COALESCE(json_extract(m.usage_json, '$.input'), 0), COALESCE(json_extract(m.usage_json, '$.output'), 0)
        FROM model_calls m JOIN run_steps s ON s.run_id = m.run_id AND s.step_id = m.step_id WHERE s.agent_id IS NOT NULL AND m.ts >= ?
    ) GROUP BY agent_id`).all(since, since) as TokenRow[];
  const runningNow = db.prepare(`SELECT agent_id, COUNT(*) AS n FROM runs WHERE agent_id IS NOT NULL AND state IN ('running', 'queued') GROUP BY agent_id`)
    .all() as { agent_id: string; n: number }[];

  // Ratings, all-time: the orchestrator's estimates and the owner's own, never merged (D-36, D-50).
  const estimateWhere = `s.evaluator_id = ? AND s.estimate = 1 AND (s.metric = 'rating' OR s.metric LIKE 'rating:%') AND r.agent_id IS NOT NULL`;
  const estimates = db.prepare(`SELECT r.agent_id, COUNT(*) AS n, AVG(s.value) AS mean FROM scores s JOIN runs r ON r.id = s.run_id WHERE ${estimateWhere} GROUP BY r.agent_id`)
    .all(ORCHESTRATOR_EVALUATOR) as Aggregate[];
  const estimateLatest = db.prepare(`SELECT r.agent_id, s.rationale AS why, s.ts FROM scores s JOIN runs r ON r.id = s.run_id WHERE ${estimateWhere} ORDER BY s.ts DESC`)
    .all(ORCHESTRATOR_EVALUATOR) as Latest[];
  const owner = db.prepare(`SELECT r.agent_id, COUNT(*) AS n, AVG(v.value) AS mean FROM ratings v JOIN runs r ON r.id = v.run_id WHERE r.agent_id IS NOT NULL GROUP BY r.agent_id`)
    .all() as Aggregate[];
  const ownerLatest = db.prepare(`SELECT r.agent_id, v.note AS why, v.ts FROM ratings v JOIN runs r ON r.id = v.run_id WHERE r.agent_id IS NOT NULL ORDER BY v.ts DESC`)
    .all() as Latest[];

  // What waits on a person, by whose run it is.
  const waitingIds = [...new Set([...deps.reviews.map((r) => r.runId), ...deps.approvals.map((a) => a.runId), ...deps.decisions.map((d) => d.runId).filter((id): id is string => id !== null)])];
  const agentOf = new Map<string, string>();
  if (waitingIds.length) {
    const rows = db.prepare(`SELECT id, agent_id FROM runs WHERE id IN (${waitingIds.map(() => '?').join(',')}) AND agent_id IS NOT NULL`).all(...waitingIds) as { id: string; agent_id: string }[];
    for (const row of rows) agentOf.set(row.id, row.agent_id);
  }

  const first = <T extends { agent_id: string }>(rows: T[], id: string): T | undefined => rows.find((r) => r.agent_id === id);
  const aggregate = (all: Aggregate[], latest: Latest[], id: string): RatingAggregate => {
    const a = first(all, id);
    const l = first(latest, id);
    return { count: a?.n ?? 0, mean: a ? Math.round(a.mean * 100) / 100 : null, latestWhy: l?.why ?? null, latestAt: l?.ts ?? null };
  };

  const reports: AgentReport[] = [];
  for (const [id, agent] of deps.workspace().agents) {
    const summary = deps.summaries.get(id);
    if (!summary) continue;
    const states = byState.filter((r) => r.agent_id === id);
    const step = first(steps, id);
    const tok = first(tokens, id);
    const count = (state: string): number => states.filter((r) => r.state === state).reduce((n, r) => n + r.n, 0);
    const window = {
      runs: states.reduce((n, r) => n + r.n, 0),
      steps: step?.n ?? 0,
      completed: count('completed'),
      failed: count('failed') + count('interrupted'),
      running: (first(runningNow, id)?.n ?? 0) + (step?.running ?? 0),
      costUsd: round(states.reduce((n, r) => n + r.cost, 0) + (step?.cost ?? 0)),
      modelCalls: states.reduce((n, r) => n + r.calls, 0),
      tokensIn: tok?.tin ?? 0,
      tokensOut: tok?.tout ?? 0,
    };
    const latestRow = db.prepare(`SELECT id FROM runs WHERE agent_id = ? AND kind = 'agent' ORDER BY started_at DESC LIMIT 1`).get(id) as { id: string } | undefined;
    const detail = latestRow ? deps.runDetail(latestRow.id) : null;
    const latest = detail
      ? (() => {
          const s = summarizeRun(detail, deps.events(detail.id), agent.definition.name);
          return { runId: detail.id, state: detail.state, startedAt: detail.startedAt, finishedAt: detail.finishedAt ?? null, costUsd: detail.spent.costUsd, summary: [s.headline, ...s.lines] };
        })()
      : null;
    const needsYou = {
      reviews: deps.reviews.filter((r) => r.blocking && agentOf.get(r.runId) === id).length,
      approvals: deps.approvals.filter((a) => agentOf.get(a.runId) === id).length,
      decisions: deps.decisions.filter((d) => d.runId !== null && agentOf.get(d.runId) === id).length,
    };
    const everRan = latest !== null || (step?.n ?? 0) > 0 || db.prepare(`SELECT 1 FROM run_steps WHERE agent_id = ? LIMIT 1`).get(id) !== undefined;
    const state: AgentReport['state'] = window.running > 0 ? 'running'
      : needsYou.reviews + needsYou.approvals + needsYou.decisions > 0 ? 'waiting'
      : latest && (latest.state === 'failed' || latest.state === 'interrupted') ? 'failed'
      : everRan ? 'idle' : 'never';
    reports.push({
      agent: summary, orchestrator: id === ORCHESTRATOR_AGENT, state, window, latest,
      ratings: { orchestrator: aggregate(estimates, estimateLatest, id), owner: aggregate(owner, ownerLatest, id) },
      needsYou,
    });
  }
  const orchestrator = reports.find((r) => r.orchestrator) ?? null;
  // The cards: the busiest first, then by name — the ones with something to say at the top.
  const agents = reports.filter((r) => !r.orchestrator).sort((a, b) => (b.window.runs + b.window.steps) - (a.window.runs + a.window.steps) || a.agent.name.localeCompare(b.agent.name));
  return { since, orchestrator, agents };
}

function round(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
