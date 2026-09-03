-- RUN-10: evaluation (D-36, D-52). Taste becomes data. Nothing here feeds model selection: a score is evidence
-- for a person, and the one gate in the system is still a human's decision (D-06).
CREATE TABLE IF NOT EXISTS datasets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  -- A version an experiment has referenced never changes again, so a result always names the cases it ran on.
  frozen INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(name, version)
);

CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL,
  -- The order a person wrote them in. Two cases added in the same millisecond have ULIDs that do not sort
  -- against each other, and "case 1" in a results table has to mean the first one.
  ordinal INTEGER NOT NULL DEFAULT 0,
  input_json TEXT NOT NULL,
  reference_json TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cases_dataset_idx ON cases(dataset_id, ordinal);

CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_version TEXT,
  models_json TEXT NOT NULL,
  evaluators_json TEXT NOT NULL,
  trials INTEGER NOT NULL DEFAULT 3,
  budgets_json TEXT,
  state TEXT NOT NULL,
  error_json TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS experiments_state_idx ON experiments(state, created_at);

CREATE TABLE IF NOT EXISTS experiment_runs (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  trial INTEGER NOT NULL,
  run_id TEXT,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS experiment_runs_idx ON experiment_runs(experiment_id, case_id, model_id, trial);

CREATE TABLE IF NOT EXISTS scores (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  evaluator_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  rationale TEXT,
  -- A judge model's opinion is an estimate and is shown as one, always (evaluation.md §Evaluators).
  estimate INTEGER NOT NULL DEFAULT 0,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS scores_run_idx ON scores(run_id, evaluator_id);

-- A comparison groups the ratings a person gave the panes they were shown, so a pick is preference data with
-- both sides of the choice in it (D-50), not a star on one run.
ALTER TABLE ratings ADD COLUMN model_id TEXT;
