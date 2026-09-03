// Running an experiment (D-36, D-52) and running a comparison. Both are ordinary runs underneath: every trial
// has a trace, a cost and a privacy record, because an eval nobody can inspect is a number without a story.
import { ulid } from 'ulid';
import type { Db } from '../db/index.js';
import type { Logger } from '../log/index.js';
import type { EvaluationStore, ExperimentRow } from './store.js';
import { EvaluatorSpec, judgePrompt, parseJudgeAnswer, passAtK, scoreLocally, type Score } from './evaluators.js';
import type { ComparePane, ExperimentResults, ResultCell } from '../../shared/api/index.js';

export interface RunHandle { runId: string; done: Promise<void> }

export interface RunnerDeps {
  db: Db;
  log: Logger;
  store: EvaluationStore;
  /** The engine, narrowed to what an experiment needs. */
  startAgentRun: (input: { agentId: string; inputs: Record<string, unknown>; project?: string | undefined; modelOverride?: string | undefined; budget?: Record<string, unknown> | undefined }) => RunHandle;
  runDetail: (runId: string) => { state: string; output: string | null; costUsd: number; latencyMs: number; tokensIn: number; tokensOut: number; error: string | null; usedKnowledge: boolean } | null;
  /** One model call, for a judge. Absent means `model-judge` scores nothing and says why. */
  judge?: ((input: { modelId: string; prompt: string }) => Promise<string>) | undefined;
}

export class ExperimentRunner {
  private readonly cancelled = new Set<string>();

  constructor(private readonly deps: RunnerDeps) {}

  cancel(experimentId: string): void {
    this.cancelled.add(experimentId);
  }

  /**
   * Every case, on every model, `k` times. Trials are sequential on purpose: an experiment is a thing you leave
   * running, and the point of a budget is that it stops — which it cannot do reliably if fifty runs are already
   * in flight when the cap is reached.
   */
  async run(experiment: ExperimentRow, options: { project?: string | undefined } = {}): Promise<void> {
    const { store } = this.deps;
    store.setExperimentState(experiment.id, 'running');
    const cases = store.cases(experiment.dataset_id);
    const models = JSON.parse(experiment.models_json) as string[];
    const evaluators = (JSON.parse(experiment.evaluators_json) as unknown[])
      .map((raw) => EvaluatorSpec.safeParse(raw))
      .filter((p): p is { success: true; data: EvaluatorSpec } => p.success)
      .map((p) => p.data);
    const budgets = experiment.budgets_json ? (JSON.parse(experiment.budgets_json) as Record<string, unknown>) : undefined;
    const cap = typeof budgets?.['maxCostUsd'] === 'number' ? (budgets['maxCostUsd'] as number) : null;

    let spent = 0;
    try {
      for (const testCase of cases) {
        for (const modelId of models) {
          for (let trial = 1; trial <= experiment.trials; trial++) {
            if (this.cancelled.has(experiment.id)) {
              store.setExperimentState(experiment.id, 'cancelled');
              return;
            }
            // The cap is checked before each trial, so the experiment stops *at* the budget rather than after it.
            if (cap !== null && spent >= cap) {
              store.setExperimentState(experiment.id, 'failed', {
                reason: 'budget_exceeded',
                message: `This experiment reached its cost budget ($${cap.toFixed(2)}) after ${spent.toFixed(4)} dollars, and stopped.`,
                budget: 'maxCostUsd', spentUsd: spent,
              });
              return;
            }

            const row = store.addExperimentRun({ experimentId: experiment.id, caseId: testCase.id, modelId, trial });
            const inputs = JSON.parse(testCase.input_json) as Record<string, unknown>;
            const handle = this.deps.startAgentRun({
              agentId: experiment.target_id,
              inputs,
              ...(options.project ? { project: options.project } : {}),
              modelOverride: modelId,
              ...(budgets ? { budget: budgets } : {}),
            });
            store.setExperimentRun(row.id, 'running', handle.runId);
            await handle.done;

            const detail = this.deps.runDetail(handle.runId);
            store.setExperimentRun(row.id, detail?.state === 'completed' ? 'completed' : 'failed');
            spent += detail?.costUsd ?? 0;

            if (detail?.state === 'completed' && detail.output !== null) {
              const reference = testCase.reference_json ? (JSON.parse(testCase.reference_json) as unknown) : undefined;
              for (const score of await this.score(evaluators, {
                output: detail.output,
                ...(reference !== undefined ? { reference } : {}),
                usedKnowledge: detail.usedKnowledge,
              })) {
                store.addScore({ runId: handle.runId, ...score });
              }
            }
          }
        }
      }
      store.setExperimentState(experiment.id, 'completed');
    } catch (e) {
      this.deps.log.error({ err: e, experiment: experiment.id }, 'an experiment failed');
      store.setExperimentState(experiment.id, 'failed', { reason: 'error', message: (e as Error).message });
    }
  }

  /** Local evaluators first, then the ones that need a model. A judge's answer is always an estimate. */
  private async score(evaluators: EvaluatorSpec[], input: { output: string; reference?: unknown; usedKnowledge?: boolean | undefined }): Promise<Score[]> {
    const scores: Score[] = [];
    for (const spec of evaluators) {
      const local = scoreLocally(spec, input);
      if (local) { scores.push(local); continue; }

      if (spec.kind === 'human') continue; // A person's rating is not something a runner produces.

      if (spec.kind === 'grounded' && !input.usedKnowledge) {
        // Groundedness against nothing is not a low score, it is not a score: this run retrieved nothing.
        continue;
      }

      if (!this.deps.judge) {
        scores.push({ evaluatorId: spec.id, metric: spec.kind, value: 0, rationale: 'no judge model is configured', estimate: true });
        continue;
      }
      // Only the two judge-backed evaluators reach here; the rest were scored locally or skipped above.
      if (spec.kind !== 'model-judge' && spec.kind !== 'grounded') continue;
      const model = spec.model ?? '';
      const rubric = spec.kind === 'model-judge'
        ? spec.rubric
        : 'Score how much of the output is supported by the sources the run retrieved. 1 means every claim is supported.';
      try {
        const answer = await this.deps.judge({ modelId: model, prompt: judgePrompt(rubric, input.output, input.reference) });
        const parsed = parseJudgeAnswer(answer);
        scores.push(parsed
          ? { evaluatorId: spec.id, metric: spec.kind, value: parsed.value, rationale: parsed.rationale, estimate: true }
          : { evaluatorId: spec.id, metric: spec.kind, value: 0, rationale: 'the judge did not answer with a score', estimate: true });
      } catch (e) {
        scores.push({ evaluatorId: spec.id, metric: spec.kind, value: 0, rationale: `the judge failed: ${(e as Error).message}`, estimate: true });
      }
    }
    return scores;
  }

  /** The results table: case × model, with pass^k beside the mean, and totals per model (D-52). */
  results(experiment: ExperimentRow): ExperimentResults {
    const { store } = this.deps;
    const rows = store.experimentRuns(experiment.id);
    const runIds = rows.map((r) => r.run_id).filter((id): id is string => id !== null);
    const scores = store.scoresFor(runIds);

    const cells: ResultCell[] = [];
    const byCell = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = `${row.case_id}|${row.model_id}`;
      byCell.set(key, [...(byCell.get(key) ?? []), row]);
    }

    for (const [key, group] of byCell) {
      const [caseId, modelId] = key.split('|') as [string, string];
      const ids = group.map((g) => g.run_id).filter((id): id is string => id !== null);
      const details = ids.map((id) => this.deps.runDetail(id));
      const metrics: ResultCell['metrics'] = {};
      const byMetric = new Map<string, { values: number[]; estimate: boolean }>();
      for (const score of scores.filter((s) => ids.includes(s.runId))) {
        const entry = byMetric.get(score.metric) ?? { values: [], estimate: false };
        entry.values.push(score.value);
        entry.estimate = entry.estimate || score.estimate;
        byMetric.set(score.metric, entry);
      }
      for (const [metric, entry] of byMetric) {
        const { mean, passK } = passAtK(entry.values);
        metrics[metric] = { mean, passK, estimate: entry.estimate };
      }
      cells.push({
        caseId, modelId, trials: group.length, metrics,
        costUsd: details.reduce((sum, d) => sum + (d?.costUsd ?? 0), 0),
        latencyMs: details.reduce((sum, d) => sum + (d?.latencyMs ?? 0), 0),
        runIds: ids,
      });
    }

    const totals = [...new Set(rows.map((r) => r.model_id))].map((modelId) => {
      const mine = cells.filter((c) => c.modelId === modelId);
      const metrics: ResultCell['metrics'] = {};
      for (const metric of new Set(mine.flatMap((c) => Object.keys(c.metrics)))) {
        const present = mine.map((c) => c.metrics[metric]).filter((m): m is NonNullable<typeof m> => m !== undefined);
        const scored = present.filter((m): m is typeof m & { passK: number } => m.passK !== null);
        metrics[metric] = {
          mean: present.reduce((sum, m) => sum + m.mean, 0) / (present.length || 1),
          // A model "passes" a case only when every trial did; the total is the fraction of cases it passed.
          // A metric that is not pass/fail has no such fraction, and says so rather than inventing one.
          passK: scored.length === present.length && present.length
            ? scored.reduce((sum, m) => sum + m.passK, 0) / scored.length
            : null,
          estimate: present.some((m) => m.estimate),
        };
      }
      return {
        modelId, metrics,
        costUsd: mine.reduce((sum, c) => sum + c.costUsd, 0),
        latencyMs: mine.reduce((sum, c) => sum + c.latencyMs, 0),
      };
    });

    // Rows in the order the person wrote the cases. Sorting by id would sort by ULID, which is the order they
    // happened to be inserted in within a millisecond — that is, no order at all.
    const caseOrder = new Map(store.cases(experiment.dataset_id).map((c, i) => [c.id, i]));
    return {
      experiment: store.toExperimentSummary(experiment),
      cases: store.caseSummaries(experiment.dataset_id),
      cells: cells.sort((a, b) =>
        (caseOrder.get(a.caseId) ?? 0) - (caseOrder.get(b.caseId) ?? 0) || a.modelId.localeCompare(b.modelId)),
      totals: totals.sort((a, b) => a.modelId.localeCompare(b.modelId)),
    };
  }

  /** Compare: one step, N models, side by side. The panes run at once; there are at most six of them. */
  async compare(input: { agentId: string; input: string; models: string[]; project?: string | undefined }): Promise<{ compareId: string; panes: ComparePane[] }> {
    const compareId = ulid();
    const panes = await Promise.all(input.models.map(async (modelId): Promise<ComparePane> => {
      const handle = this.deps.startAgentRun({
        agentId: input.agentId, inputs: { input: input.input },
        ...(input.project ? { project: input.project } : {}),
        modelOverride: modelId,
      });
      await handle.done;
      const detail = this.deps.runDetail(handle.runId);
      return {
        modelId, runId: handle.runId,
        state: detail?.state ?? 'failed',
        output: detail?.output ?? '',
        latencyMs: detail?.latencyMs ?? 0,
        costUsd: detail?.costUsd ?? 0,
        tokensIn: detail?.tokensIn ?? 0,
        tokensOut: detail?.tokensOut ?? 0,
        error: detail?.error ?? null,
      };
    }));
    return { compareId, panes };
  }
}
