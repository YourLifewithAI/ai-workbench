-- RUN-01: an agent's definition is content-addressed (D-10). Every model call and artifact names a hash;
-- this table is what that hash resolves to, so a trace stays readable after the file on disk has changed.
CREATE TABLE IF NOT EXISTS agent_versions (
  hash TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_versions_agent_idx ON agent_versions(agent_id, created_at);
