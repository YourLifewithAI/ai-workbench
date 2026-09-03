-- RUN-03: the Library. A project groups the work of a purpose; documents and files are its artifacts, and both
-- keep every version with the provenance that produced it (D-16). Nothing an agent writes is overwritten.
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  path TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'markdown',
  latest_version_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, path)
);
CREATE INDEX IF NOT EXISTS documents_project_idx ON documents(project_id, path);

CREATE TABLE IF NOT EXISTS document_versions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  parent_id TEXT,
  hash TEXT NOT NULL,
  content TEXT NOT NULL,
  created_by TEXT NOT NULL,
  run_id TEXT,
  step_id TEXT,
  agent_version TEXT,
  model_id TEXT,
  partial INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS document_versions_doc_idx ON document_versions(document_id, created_at);
CREATE INDEX IF NOT EXISTS document_versions_run_idx ON document_versions(run_id);

-- Chunked full text, so search can name a document, a version, and where in it the hit was.
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  content,
  document_id UNINDEXED,
  version_id UNINDEXED,
  chunk_index UNINDEXED,
  offset UNINDEXED
);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  path TEXT NOT NULL,
  latest_version_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, path)
);

CREATE TABLE IF NOT EXISTS file_versions (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  parent_id TEXT,
  hash TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  run_id TEXT,
  step_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS file_versions_file_idx ON file_versions(file_id, created_at);
