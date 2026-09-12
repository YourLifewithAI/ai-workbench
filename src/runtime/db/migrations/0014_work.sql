-- RUN-24: the ledger the orchestrator keeps (D-75). One table of work items and one of the runs that touched
-- them. Nothing here is a grant, a budget or an instruction: an item's text is content, with the trust of the
-- run that wrote it (D-17), and the orchestrator writes its own briefs.
CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  -- task | bug | decision | note
  kind TEXT NOT NULL,
  -- A project slug, or NULL for the workspace.
  project TEXT,
  title TEXT NOT NULL,
  detail TEXT,
  -- backlog | staffed | in-review | needs-you | decided | done | dropped
  state TEXT NOT NULL,
  assignee TEXT,
  -- An open item with the same key is refreshed, never filed twice: the auditor's facts-hash rule, for work.
  key TEXT,
  -- trusted | untrusted, from the writing run's taint; a person's write is trusted.
  trust TEXT NOT NULL,
  run_id TEXT,
  -- A decision's options, and the orchestrator's lean; the person's answer and note.
  options_json TEXT,
  lean TEXT,
  answer TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS work_items_state_idx ON work_items(state, updated_at);
CREATE INDEX IF NOT EXISTS work_items_key_idx ON work_items(key);

CREATE TABLE IF NOT EXISTS work_runs (
  item_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  -- filed | refreshed | staffed | worked | answered
  role TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (item_id, run_id, role)
);
