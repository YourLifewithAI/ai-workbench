-- RUN-15: catalog discovery (D-64). Nothing here changes what can run. The catalog is a file a person edits;
-- a dismissal only says "do not raise this finding again while the provider's answer is the same as it was".
CREATE TABLE IF NOT EXISTS catalog_finding_dismissals (
  finding_id TEXT PRIMARY KEY,
  -- A hash of the provider's facts behind the finding. When those facts change, the dismissal lapses.
  facts_hash TEXT NOT NULL,
  dismissed_at TEXT NOT NULL
);
