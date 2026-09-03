-- RUN-02: every attempt to leave this machine, allowed or denied, with a redacted body. This is what the
-- Privacy Inspector reads, and what makes "what did it send, and where" answerable after the fact.
CREATE TABLE IF NOT EXISTS egress_log (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  step_id TEXT,
  purpose TEXT NOT NULL,
  host TEXT NOT NULL,
  ip TEXT,
  method TEXT NOT NULL,
  data_categories TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  body_redacted TEXT,
  decision TEXT NOT NULL,
  reason TEXT,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS egress_log_run_idx ON egress_log(run_id, ts);
