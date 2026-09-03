-- RUN-04: workflow versions, so a run records exactly which definition produced it (D-10, spec/data-model.md).
CREATE TABLE IF NOT EXISTS workflow_versions (
  hash TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS workflow_versions_id_idx ON workflow_versions(workflow_id, created_at);

-- Runs became cancellable, so the reason a run ended is worth keeping next to the run.
CREATE INDEX IF NOT EXISTS run_steps_state_idx ON run_steps(run_id, state);
