-- RUN-26 (D-77): the room where you talk. A conversation is a row; every exchange in it is an ordinary agent
-- run carrying its conversation_id, so the thread is a view over runs rather than a second store of what was
-- said. `last_read_at` is what the room's header counts from: what happened while you were away.
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  project TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_read_at TEXT
);

ALTER TABLE runs ADD COLUMN conversation_id TEXT;
CREATE INDEX IF NOT EXISTS runs_conversation_idx ON runs(conversation_id, started_at);

-- RUN-26 (D-79): the board counts an agent's runs in a window. Nothing indexed runs by agent before it.
CREATE INDEX IF NOT EXISTS runs_agent_idx ON runs(agent_id, started_at);
