-- RUN-06: the security queue (D-13). Separate from `reviews` on purpose: a rating and a permission are not the
-- same decision, and merging them would make one of them easy to click through.
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args_json TEXT NOT NULL,
  -- The rule that fired, in words the card can show: "artifact.write is in approvalRequired".
  policy TEXT NOT NULL,
  -- Everything raised by one step shares a batch, so a step asking twice is one card with two actions.
  batch_id TEXT NOT NULL,
  state TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  -- What "remember" would write, so the card can show the narrowest rule before it is agreed to.
  remember_json TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS approvals_state_idx ON approvals(state, expires_at);
CREATE INDEX IF NOT EXISTS approvals_run_idx ON approvals(run_id, batch_id);

-- Every permission decision, granted or refused, so the Tools screen can show a denial history.
CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  agent_id TEXT,
  tool TEXT NOT NULL,
  args_json TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT,
  ok INTEGER,
  error_code TEXT,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tool_calls_run_idx ON tool_calls(run_id, ts);
CREATE INDEX IF NOT EXISTS tool_calls_denied_idx ON tool_calls(decision, ts);
