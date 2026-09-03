-- RUN-12: one row per device that asked to be told (D-61). Payloads carry ids and kinds only, so this table is
-- the whole of what leaves the machine about a notification (SEC-32).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  keys_json TEXT NOT NULL,
  device_label TEXT,
  -- Which kinds this device wants. A device is not a person: the phone and the laptop can differ.
  events_json TEXT NOT NULL,
  last_sent_at TEXT,
  -- Set when the push service says this endpoint is gone, so a dead phone stops being retried forever.
  gone_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS push_live_idx ON push_subscriptions(gone_at);
