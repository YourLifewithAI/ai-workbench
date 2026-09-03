-- RUN-08: memory (D-17). One table, four scopes, and a trust that is derived from what the writing run had
-- consumed rather than declared by the writer. An untrusted item is still retrieved — it is fenced as data when
-- it reaches the prompt, never placed in an instruction section.
CREATE TABLE IF NOT EXISTS memory_items (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL,
  trust TEXT NOT NULL,
  run_id TEXT,
  supersedes_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS memory_scope_idx ON memory_items(scope, owner_id, created_at);
CREATE INDEX IF NOT EXISTS memory_supersedes_idx ON memory_items(supersedes_id);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(content, item_id UNINDEXED);

-- Whether this run has consumed *external* content, which is a different question from whether it has consumed
-- *private* content: private decides whether a send needs a human (D-29), external decides whether what the run
-- remembers is trusted (D-17). A run can be either, both, or neither.
ALTER TABLE runs ADD COLUMN external_tainted INTEGER NOT NULL DEFAULT 0;
