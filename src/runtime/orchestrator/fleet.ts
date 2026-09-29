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

const EARLIEST_MS = Date.parse('0000-01-01T00:00:00.000Z');
const LATEST_MS = Date.parse('9999-12-31T23:59:59.999Z');

/**
 * A `since` in the shape the tables write time in: `toISOString()`, four-digit year, milliseconds. The rows are compared
 * as text, and only that shape sorts as time — "Sep 27 2026", an offset, a date with no milliseconds and a far-future
 * year all sort wrongly as they come. Null when it is not a date at all. A year outside 0000-9999 is clamped to the ends,
 * where it means the same thing ("after everything", "from the beginning") and still sorts.
 */
export function normalizeSince(raw: string): string | null {
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return null;
  return new Date(Math.min(Math.max(ms, EARLIEST_MS), LATEST_MS)).toISOString();
}

export interface FleetDeps {
  db: Db;
  workspace: () => Workspace;
  runDetail: (id: string) => RunDetail | null;
  events: (id: string) => EventRecord[];
  /** Identity, policy, spend and heartbeat per agent id — what `GET /agents` already computes. */
  summaries: Map<string, AgentSummary>;
  /**
   * What is waiting on a person, by the run it waits on: the board says whose it is. A workflow run has no agent of
   * its own, so a review or an approval may name the step it waits on and land on that step's agent; without one it
   * lands on the workflow's sole step agent, if there is exactly one, and on nobody otherwise.
   */
  reviews: { runId: string; stepId?: string | undefined; blocking: boolean }[];
  approvals: { runId: string; stepId?: string | undefined }[];
  decisions: { runId: string | null }[];
  now?: (() => Date) | undefined;
}

interface StateCount { agent_id: string; state: string; n: number }
interface StepCount { agent_id: string; n: number; running: number; failed: number }
interface CallRow { agent_id: string; calls: number; cost: number; tin: number; tout: number }
/** One agent's ratings, counted and averaged over the rows that count, with the newest of them for its why. */
interface RatingRow { agent_id: string; n: number; mean: number; why: string | null; ts: string }

export function fleetReport(deps: FleetDeps, opts: { since?: string | undefined } = {}): FleetResponse {
  const now = deps.now?.() ?? new Date();
  const since = opts.since ?? new Date(now.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000).toISOString();
  const db = deps.db;

  // The window, in a few grouped queries for the whole fleet. Runs and steps are counted by when they began; what they
  // cost, how many calls they made and how many tokens they used are one source — the model calls made inside the
  // window — so the four numbers on a card always describe the same calls. `runs.spent_json` is not that source: a
  // parent's includes the children it waited for and the budget it reserved for a detached one, and it is filtered by
  // the run's start, where a call is filtered by its own time. Each call is the agent of its own run's, or of the step
  // it was made in when the run is a workflow.
  const byState = db.prepare(`SELECT agent_id, state, COUNT(*) AS n
    FROM runs WHERE kind = 'agent' AND agent_id IS NOT NULL AND started_at >= ? GROUP BY agent_id, state`).all(since) as StateCount[];
  // A step row is seeded `pending` with its agent when the workflow starts and stamped `started_at` only when it
  // runs, so a step that never ran (skipped, cancelled behind a failure, still waiting its turn) is not activity.
  const steps = db.prepare(`SELECT s.agent_id, COUNT(*) AS n,
      SUM(CASE WHEN s.state = 'running' AND r.state = 'running' THEN 1 ELSE 0 END) AS running, -- a step parked on an approval says running; its run says waiting
      SUM(CASE WHEN s.state = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM run_steps s JOIN runs r ON r.id = s.run_id
    WHERE s.agent_id IS NOT NULL AND s.started_at IS NOT NULL AND r.kind = 'workflow' AND r.started_at >= ? GROUP BY s.agent_id`).all(since) as StepCount[];
  const calls = db.prepare(`SELECT agent_id, COUNT(*) AS calls, SUM(cost) AS cost, SUM(tin) AS tin, SUM(tout) AS tout FROM (
      SELECT r.agent_id AS agent_id, m.cost_usd AS cost, COALESCE(json_extract(m.usage_json, '$.input'), 0) AS tin, COALESCE(json_extract(m.usage_json, '$.output'), 0) AS tout
        FROM model_calls m JOIN runs r ON r.id = m.run_id WHERE r.agent_id IS NOT NULL AND m.ts >= ?
      UNION ALL
      SELECT s.agent_id, m.cost_usd, COALESCE(json_extract(m.usage_json, '$.input'), 0), COALESCE(json_extract(m.usage_json, '$.output'), 0)
        FROM model_calls m JOIN run_steps s ON s.run_id = m.run_id AND s.step_id = m.step_id WHERE s.agent_id IS NOT NULL AND m.ts >= ?
    ) GROUP BY agent_id`).all(since, since) as CallRow[];
  const runningNow = db.prepare(`SELECT agent_id, COUNT(*) AS n FROM runs WHERE agent_id IS NOT NULL AND state IN ('running', 'queued') GROUP BY agent_id`)
    .all() as { agent_id: string; n: number }[];

  // Ratings, all-time: the orchestrator's estimates and the owner's own, never merged (D-36, D-50). A workflow run
  // has no agent of its own, so a rating on one of its steps belongs to the agent that ran the step. Only the latest
  // word on each thing counts — the latest row per run for an agent run (its one step is `main` however it was
  // named), per (run, step) for the owner and per (run, metric) for the orchestrator on a workflow run —
  // so a re-rating replaces the earlier one instead of adding to it; the latest why is the newest of those, and the
  // insertion order settles rows that share a timestamp. A Compare pick is not a rating: it is a preference between
  // two runs, written on both, and would read as a "meh" on the one that lost.
  const ratingsOf = (inner: string, ...params: unknown[]): RatingRow[] => db.prepare(`WITH latest AS (${inner}),
      kept AS (SELECT agent_id, value, why, ts, rid FROM latest WHERE rn = 1 AND agent_id IS NOT NULL),
      ranked AS (SELECT agent_id, why, ts, COUNT(*) OVER (PARTITION BY agent_id) AS n, AVG(value) OVER (PARTITION BY agent_id) AS mean,
          ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY ts DESC, rid DESC) AS recent FROM kept)
    SELECT agent_id, n, mean, why, ts FROM ranked WHERE recent = 1`).all(...params) as RatingRow[];
  const estimates = ratingsOf(`SELECT COALESCE(r.agent_id, st.agent_id) AS agent_id, s.value AS value, s.rationale AS why, s.ts AS ts, s.rowid AS rid,
        ROW_NUMBER() OVER (PARTITION BY s.run_id, CASE WHEN r.agent_id IS NULL THEN s.metric END ORDER BY s.ts DESC, s.rowid DESC) AS rn
      FROM scores s JOIN runs r ON r.id = s.run_id
      LEFT JOIN run_steps st ON st.run_id = s.run_id AND st.step_id = CASE WHEN s.metric LIKE 'rating:%' THEN substr(s.metric, 8) END
      WHERE s.evaluator_id = ? AND s.estimate = 1 AND (s.metric = 'rating' OR s.metric LIKE 'rating:%')`, ORCHESTRATOR_EVALUATOR);
  const owner = ratingsOf(`SELECT COALESCE(r.agent_id, st.agent_id) AS agent_id, v.value AS value, v.note AS why, v.ts AS ts, v.rowid AS rid,
        ROW_NUMBER() OVER (PARTITION BY v.run_id, CASE WHEN r.agent_id IS NULL THEN v.step_id END ORDER BY v.ts DESC, v.rowid DESC) AS rn
      FROM ratings v JOIN runs r ON r.id = v.run_id
      LEFT JOIN run_steps st ON st.run_id = v.run_id AND st.step_id = v.step_id
      WHERE v.compare_id IS NULL`);

  // What waits on a person, by whose it is: the run's own agent, else the agent of the step it waits on, else the
  // workflow's sole step agent, else nobody (two agents share it, and the board does not guess).
  const waitingIds = [...new Set([...deps.reviews.map((r) => r.runId), ...deps.approvals.map((a) => a.runId), ...deps.decisions.map((d) => d.runId).filter((id): id is string => id !== null)])];
  const runAgent = new Map<string, string>();
  const stepAgent = new Map<string, string>();
  const soleAgent = new Map<string, string>();
  if (waitingIds.length) {
    const marks = waitingIds.map(() => '?').join(',');
    for (const row of db.prepare(`SELECT id, agent_id FROM runs WHERE id IN (${marks}) AND agent_id IS NOT NULL`).all(...waitingIds) as { id: string; agent_id: string }[]) runAgent.set(row.id, row.agent_id);
    const agentless = waitingIds.filter((id) => !runAgent.has(id));
    if (agentless.length) {
      const agents = new Map<string, Set<string>>();
      for (const row of db.prepare(`SELECT run_id, step_id, agent_id FROM run_steps WHERE run_id IN (${agentless.map(() => '?').join(',')}) AND agent_id IS NOT NULL`).all(...agentless) as { run_id: string; step_id: string; agent_id: string }[]) {
        stepAgent.set(`${row.run_id}\u0000${row.step_id}`, row.agent_id);
        (agents.get(row.run_id) ?? agents.set(row.run_id, new Set()).get(row.run_id)!).add(row.agent_id);
      }
      for (const [runId, set] of agents) if (set.size === 1) soleAgent.set(runId, [...set][0]!);
    }
  }
  const whose = (runId: string, stepId?: string | undefined): string | undefined =>
    runAgent.get(runId) ?? (stepId !== undefined ? stepAgent.get(`${runId}\u0000${stepId}`) : undefined) ?? soleAgent.get(runId);

  const first = <T extends { agent_id: string }>(rows: T[], id: string): T | undefined => rows.find((r) => r.agent_id === id);
  const aggregate = (rows: RatingRow[], id: string): RatingAggregate => {
    const a = first(rows, id);
    return { count: a?.n ?? 0, mean: a ? Math.round(a.mean * 100) / 100 : null, latestWhy: a?.why ?? null, latestAt: a?.ts ?? null };
  };

  const reports: AgentReport[] = [];
  for (const [id, agent] of deps.workspace().agents) {
    const summary = deps.summaries.get(id);
    if (!summary) continue;
    const states = byState.filter((r) => r.agent_id === id);
    const step = first(steps, id);
    const used = first(calls, id);
    const count = (state: string): number => states.filter((r) => r.state === state).reduce((n, r) => n + r.n, 0);
    const window = {
      runs: states.reduce((n, r) => n + r.n, 0),
      steps: step?.n ?? 0,
      completed: count('completed'),
      failed: count('failed') + count('interrupted') + (step?.failed ?? 0),
      running: (first(runningNow, id)?.n ?? 0) + (step?.running ?? 0),
      costUsd: round(used?.cost ?? 0),
      modelCalls: used?.calls ?? 0,
      tokensIn: used?.tin ?? 0,
      tokensOut: used?.tout ?? 0,
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
      reviews: deps.reviews.filter((r) => r.blocking && whose(r.runId, r.stepId) === id).length,
      approvals: deps.approvals.filter((a) => whose(a.runId, a.stepId) === id).length,
      decisions: deps.decisions.filter((d) => d.runId !== null && whose(d.runId) === id).length,
    };
    const everRan = latest !== null || (step?.n ?? 0) > 0 || db.prepare(`SELECT 1 FROM run_steps WHERE agent_id = ? AND started_at IS NOT NULL LIMIT 1`).get(id) !== undefined;
    const state: AgentReport['state'] = window.running > 0 ? 'running'
      : needsYou.reviews + needsYou.approvals + needsYou.decisions > 0 ? 'waiting'
      : latest && (latest.state === 'failed' || latest.state === 'interrupted') ? 'failed'
      : everRan ? 'idle' : 'never';
    reports.push({
      agent: summary, orchestrator: id === ORCHESTRATOR_AGENT, state, window, latest,
      ratings: { orchestrator: aggregate(estimates, id), owner: aggregate(owner, id) },
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
