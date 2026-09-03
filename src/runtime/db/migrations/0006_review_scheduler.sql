-- RUN-05: the two human queues that are not the same queue (D-13), and the schedules that fill them (D-15).
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  version_id TEXT,
  -- unreviewed: every completed step lands here. pending: a blocking gate, with the run parked behind it.
  state TEXT NOT NULL,
  feedback TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  UNIQUE (run_id, step_id)
);
CREATE INDEX IF NOT EXISTS reviews_state_idx ON reviews(state, created_at);

CREATE TABLE IF NOT EXISTS ratings (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  version_id TEXT,
  value INTEGER NOT NULL,
  note TEXT,
  -- A Compare pick writes one row per run sharing compare_id (RUN-10).
  compare_id TEXT,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ratings_target_idx ON ratings(run_id, step_id);
CREATE INDEX IF NOT EXISTS ratings_version_idx ON ratings(version_id);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  cron TEXT NOT NULL,
  inputs_json TEXT NOT NULL,
  project TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  catch_up TEXT NOT NULL DEFAULT 'none',
  -- Set when a workflow file's `schedule` block seeded this row, so the seed happens once and edits stick (D-15).
  seeded_from_file INTEGER NOT NULL DEFAULT 0,
  last_fired_at TEXT,
  next_fire_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS schedules_next_idx ON schedules(enabled, next_fire_at);
