-- RUN-14: the standing permissions review (D-63). Three tables, none of which an agent can write.
-- Every change a human makes to the grant matrix, so "when was this granted" has an answer. One source value
-- on purpose: a change applied from a review finding is the same act as one made on the Tools screen.
CREATE TABLE IF NOT EXISTS grant_log (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  -- The tool for a tools-map change; NULL for a change to the rest of the block (net.allow, fs, repos).
  tool TEXT,
  field TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT NOT NULL,
  source TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS grant_log_agent_idx ON grant_log(agent_id, tool, at);
-- What the auditor proposed. Applying one is a human's matrix write; the row only records that it happened.
CREATE TABLE IF NOT EXISTS permission_findings (
  id TEXT PRIMARY KEY,
  -- kind:agent:tool — the same finding raised twice is one row, updated.
  key TEXT NOT NULL,
  kind TEXT NOT NULL,
  agent_id TEXT,
  tool TEXT,
  evidence_json TEXT NOT NULL,
  proposal_json TEXT,
  note TEXT,
  -- A hash of the numbers the finding rests on, so a dismissal holds until they change.
  facts_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  run_id TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS permission_findings_state_idx ON permission_findings(state, created_at);
CREATE INDEX IF NOT EXISTS permission_findings_key_idx ON permission_findings(key);
CREATE TABLE IF NOT EXISTS permission_finding_dismissals (
  key TEXT PRIMARY KEY,
  facts_hash TEXT NOT NULL,
  dismissed_at TEXT NOT NULL
);
-- When each tool first appeared in the catalogue (a new build, plugin or MCP server), so "undecided" can mean
-- "new and nobody has said" rather than "every tool nobody happens to use".
CREATE TABLE IF NOT EXISTS tool_catalog_seen (
  tool TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL
);
