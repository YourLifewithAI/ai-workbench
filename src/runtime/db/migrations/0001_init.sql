-- RUN-00 tables (spec/data-model.md). Later runs add theirs in later migrations.
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  workflow_version TEXT,
  agent_version TEXT,
  agent_id TEXT,
  workflow_id TEXT,
  project_id TEXT,
  parent_run_id TEXT,
  depth INTEGER NOT NULL DEFAULT 0,
  inputs_json TEXT NOT NULL,
  outputs_json TEXT,
  budgets_json TEXT NOT NULL,
  spent_json TEXT NOT NULL,
  private_tainted INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error_json TEXT
);
CREATE INDEX IF NOT EXISTS runs_state_idx ON runs(state, started_at);

CREATE TABLE IF NOT EXISTS run_steps (
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  parent_step_id TEXT,
  map_index INTEGER,
  state TEXT NOT NULL,
  model_id TEXT,
  output_json TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  started_at TEXT,
  finished_at TEXT,
  PRIMARY KEY (run_id, step_id)
);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  step_id TEXT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  schema_v INTEGER NOT NULL,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_run_idx ON events(run_id, seq);

CREATE TABLE IF NOT EXISTS model_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  adapter TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  agent_version TEXT,
  usage_json TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL,
  finish_reason TEXT,
  error_json TEXT,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS model_calls_run_idx ON model_calls(run_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
