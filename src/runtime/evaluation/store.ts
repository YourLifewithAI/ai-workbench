// Datasets, cases, experiments and scores (D-36). A dataset version is frozen the moment an experiment
// references it, so a result always names exactly the cases it ran on — an eval whose inputs moved afterwards
// is not evidence of anything.
import { ulid } from 'ulid';
import type { Db } from '../db/index.js';
import type { CaseSummary, DatasetSummary, ExperimentSummary, ScoreRecord } from '../../shared/api/index.js';

export interface DatasetRow { id: string; name: string; version: number; frozen: number; created_at: string }
export interface CaseRow { id: string; dataset_id: string; ordinal: number; input_json: string; reference_json: string | null; metadata_json: string | null; created_at: string }
export interface ExperimentRow {
  id: string; name: string; dataset_id: string; target_kind: string; target_id: string; target_version: string | null;
  models_json: string; evaluators_json: string; trials: number; budgets_json: string | null;
  state: string; error_json: string | null; created_at: string; finished_at: string | null;
}
export interface ExperimentRunRow { id: string; experiment_id: string; case_id: string; model_id: string; trial: number; run_id: string | null; state: string; created_at: string }

export class FrozenDatasetError extends Error {
  constructor(name: string, version: number) {
    super(`Dataset "${name}" v${version} is frozen: an experiment has run against it, so its cases cannot change. Create the next version instead.`);
    this.name = 'FrozenDatasetError';
  }
}

export class EvaluationStore {
  constructor(private readonly db: Db) {}

  // ---- datasets and cases ---------------------------------------------------------------------------------

  createDataset(name: string): DatasetRow {
    const previous = this.db.prepare('SELECT MAX(version) AS v FROM datasets WHERE name = ?').get(name) as { v: number | null };
    const row: DatasetRow = { id: ulid(), name, version: (previous.v ?? 0) + 1, frozen: 0, created_at: new Date().toISOString() };
    this.db.prepare('INSERT INTO datasets (id, name, version, frozen, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(row.id, row.name, row.version, row.frozen, row.created_at);
    return row;
  }

  dataset(id: string): DatasetRow | null {
    return (this.db.prepare('SELECT * FROM datasets WHERE id = ?').get(id) as DatasetRow | undefined) ?? null;
  }

  listDatasets(): DatasetSummary[] {
    const rows = this.db.prepare('SELECT * FROM datasets ORDER BY name, version').all() as DatasetRow[];
    return rows.map((row) => ({
      id: row.id, name: row.name, version: row.version, frozen: row.frozen === 1, createdAt: row.created_at,
      cases: (this.db.prepare('SELECT COUNT(*) AS n FROM cases WHERE dataset_id = ?').get(row.id) as { n: number }).n,
    }));
  }

  addCase(datasetId: string, input: unknown, reference?: unknown, metadata?: Record<string, unknown>): CaseRow {
    const dataset = this.dataset(datasetId);
    if (!dataset) throw new Error(`There is no dataset with id "${datasetId}".`);
    if (dataset.frozen === 1) throw new FrozenDatasetError(dataset.name, dataset.version);
    const next = (this.db.prepare('SELECT COALESCE(MAX(ordinal), -1) AS n FROM cases WHERE dataset_id = ?').get(datasetId) as { n: number }).n + 1;
    const row: CaseRow = {
      id: ulid(), dataset_id: datasetId, ordinal: next, input_json: JSON.stringify(input),
      reference_json: reference === undefined ? null : JSON.stringify(reference),
      metadata_json: metadata ? JSON.stringify(metadata) : null,
      created_at: new Date().toISOString(),
    };
    this.db.prepare('INSERT INTO cases (id, dataset_id, ordinal, input_json, reference_json, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.dataset_id, row.ordinal, row.input_json, row.reference_json, row.metadata_json, row.created_at);
    return row;
  }

  cases(datasetId: string): CaseRow[] {
    return this.db.prepare('SELECT * FROM cases WHERE dataset_id = ? ORDER BY ordinal').all(datasetId) as CaseRow[];
  }

  caseSummaries(datasetId: string): CaseSummary[] {
    return this.cases(datasetId).map((c) => ({
      id: c.id,
      input: JSON.parse(c.input_json) as Record<string, unknown>,
      reference: c.reference_json ? (JSON.parse(c.reference_json) as unknown) : null,
      metadata: c.metadata_json ? (JSON.parse(c.metadata_json) as Record<string, unknown>) : null,
    }));
  }

  freeze(datasetId: string): void {
    this.db.prepare('UPDATE datasets SET frozen = 1 WHERE id = ?').run(datasetId);
  }

  // ---- experiments ----------------------------------------------------------------------------------------

  createExperiment(input: {
    name: string; datasetId: string; targetKind: 'agent' | 'workflow'; targetId: string; targetVersion?: string | undefined;
    models: string[]; evaluators: unknown[]; trials: number; budgets?: Record<string, unknown> | undefined;
  }): ExperimentRow {
    const row: ExperimentRow = {
      id: ulid(), name: input.name, dataset_id: input.datasetId, target_kind: input.targetKind, target_id: input.targetId,
      target_version: input.targetVersion ?? null, models_json: JSON.stringify(input.models),
      evaluators_json: JSON.stringify(input.evaluators), trials: input.trials,
      budgets_json: input.budgets ? JSON.stringify(input.budgets) : null,
      state: 'queued', error_json: null, created_at: new Date().toISOString(), finished_at: null,
    };
    this.db.prepare(`INSERT INTO experiments (id, name, dataset_id, target_kind, target_id, target_version, models_json, evaluators_json, trials, budgets_json, state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      row.id, row.name, row.dataset_id, row.target_kind, row.target_id, row.target_version,
      row.models_json, row.evaluators_json, row.trials, row.budgets_json, row.state, row.created_at,
    );
    // Referencing a dataset freezes it: from here on, this result names the cases it actually ran on.
    this.freeze(input.datasetId);
    return row;
  }

  experiment(id: string): ExperimentRow | null {
    return (this.db.prepare('SELECT * FROM experiments WHERE id = ?').get(id) as ExperimentRow | undefined) ?? null;
  }

  listExperiments(): ExperimentSummary[] {
    const rows = this.db.prepare('SELECT * FROM experiments ORDER BY created_at DESC').all() as ExperimentRow[];
    return rows.map((row) => this.toExperimentSummary(row));
  }

  toExperimentSummary(row: ExperimentRow): ExperimentSummary {
    const dataset = this.dataset(row.dataset_id);
    const runs = this.db.prepare('SELECT state, COUNT(*) AS n FROM experiment_runs WHERE experiment_id = ? GROUP BY state').all(row.id) as { state: string; n: number }[];
    return {
      id: row.id, name: row.name,
      dataset: dataset ? { id: dataset.id, name: dataset.name, version: dataset.version } : null,
      target: { kind: row.target_kind as 'agent', id: row.target_id, version: row.target_version },
      models: JSON.parse(row.models_json) as string[],
      trials: row.trials,
      state: row.state as 'queued',
      error: row.error_json ? (JSON.parse(row.error_json) as Record<string, unknown>) : null,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
      counts: Object.fromEntries(runs.map((r) => [r.state, r.n])),
    };
  }

  setExperimentState(id: string, state: string, error?: unknown): void {
    this.db.prepare('UPDATE experiments SET state = ?, error_json = ?, finished_at = ? WHERE id = ?')
      .run(state, error === undefined ? null : JSON.stringify(error), ['completed', 'failed', 'cancelled'].includes(state) ? new Date().toISOString() : null, id);
  }

  addExperimentRun(input: { experimentId: string; caseId: string; modelId: string; trial: number }): ExperimentRunRow {
    const row: ExperimentRunRow = {
      id: ulid(), experiment_id: input.experimentId, case_id: input.caseId, model_id: input.modelId,
      trial: input.trial, run_id: null, state: 'queued', created_at: new Date().toISOString(),
    };
    this.db.prepare('INSERT INTO experiment_runs (id, experiment_id, case_id, model_id, trial, run_id, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.experiment_id, row.case_id, row.model_id, row.trial, row.run_id, row.state, row.created_at);
    return row;
  }

  setExperimentRun(id: string, state: string, runId?: string | null): void {
    this.db.prepare('UPDATE experiment_runs SET state = ?, run_id = COALESCE(?, run_id) WHERE id = ?').run(state, runId ?? null, id);
  }

  experimentRuns(experimentId: string): ExperimentRunRow[] {
    return this.db.prepare('SELECT * FROM experiment_runs WHERE experiment_id = ? ORDER BY case_id, model_id, trial').all(experimentId) as ExperimentRunRow[];
  }

  // ---- scores ---------------------------------------------------------------------------------------------

  addScore(input: { runId: string; evaluatorId: string; metric: string; value: number; rationale?: string | undefined; estimate: boolean }): ScoreRecord {
    const id = ulid();
    const ts = new Date().toISOString();
    this.db.prepare('INSERT INTO scores (id, run_id, evaluator_id, metric, value, rationale, estimate, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.runId, input.evaluatorId, input.metric, input.value, input.rationale ?? null, input.estimate ? 1 : 0, ts);
    return { id, runId: input.runId, evaluatorId: input.evaluatorId, metric: input.metric, value: input.value, rationale: input.rationale ?? null, estimate: input.estimate, ts };
  }

  scoresFor(runIds: string[]): ScoreRecord[] {
    if (!runIds.length) return [];
    const rows = this.db.prepare(`SELECT * FROM scores WHERE run_id IN (${runIds.map(() => '?').join(',')}) ORDER BY ts`).all(...runIds) as {
      id: string; run_id: string; evaluator_id: string; metric: string; value: number; rationale: string | null; estimate: number; ts: string;
    }[];
    return rows.map((r) => ({ id: r.id, runId: r.run_id, evaluatorId: r.evaluator_id, metric: r.metric, value: r.value, rationale: r.rationale, estimate: r.estimate === 1, ts: r.ts }));
  }
}
