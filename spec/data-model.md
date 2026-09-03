# Data model

*Prose cap: 400 words. Decisions cited: D-16 … D-19, D-35.*

One SQLite file per workspace, `data/workbench.sqlite`, WAL mode, FTS5 asserted at startup by creating a temporary virtual table (the assertion is a function that takes the connection, so a test can stub one that lacks FTS5). Events are the source of truth; `runs` and `run_steps` are maintained summaries derived from them.

## Tables

```sql
schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT);

agent_versions(hash TEXT PRIMARY KEY, agent_id TEXT, definition_json TEXT, created_at TEXT);
workflow_versions(hash TEXT PRIMARY KEY, workflow_id TEXT, definition_json TEXT, created_at TEXT);

projects(id TEXT PRIMARY KEY, slug TEXT UNIQUE, name TEXT, created_at TEXT);
documents(id TEXT PRIMARY KEY, project_id TEXT, path TEXT, type TEXT, latest_version_id TEXT, UNIQUE(project_id, path));
document_versions(id TEXT PRIMARY KEY, document_id TEXT, parent_id TEXT, hash TEXT, content TEXT,
  created_by TEXT, run_id TEXT, step_id TEXT, agent_version TEXT, model_id TEXT, partial INTEGER, created_at TEXT);
documents_fts(content, document_id UNINDEXED, version_id UNINDEXED, chunk_index UNINDEXED, offset UNINDEXED)  -- FTS5
files(id TEXT PRIMARY KEY, project_id TEXT, path TEXT, latest_version_id TEXT, UNIQUE(project_id, path));
file_versions(id TEXT PRIMARY KEY, file_id TEXT, parent_id TEXT, hash TEXT, bytes INTEGER,
  created_by TEXT, run_id TEXT, step_id TEXT, created_at TEXT);

runs(id TEXT PRIMARY KEY, kind TEXT, state TEXT, workflow_version TEXT, agent_version TEXT,
  project_id TEXT, parent_run_id TEXT, depth INTEGER, inputs_json TEXT, budgets_json TEXT,
  spent_json TEXT, private_tainted INTEGER, started_at TEXT, finished_at TEXT, error_json TEXT);
run_steps(run_id TEXT, step_id TEXT, kind TEXT, parent_step_id TEXT, map_index INTEGER, state TEXT,
  model_id TEXT, output_json TEXT, cost_usd REAL, started_at TEXT, finished_at TEXT, PRIMARY KEY(run_id, step_id));
events(seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, step_id TEXT, type TEXT,
  payload_json TEXT, schema_v INTEGER, ts TEXT);
model_calls(id TEXT PRIMARY KEY, run_id TEXT, step_id TEXT, model_id TEXT, adapter TEXT,
  prompt_version TEXT, agent_version TEXT, usage_json TEXT, cost_usd REAL, latency_ms INTEGER,
  finish_reason TEXT, error_json TEXT, ts TEXT);
egress_log(id TEXT PRIMARY KEY, run_id TEXT, step_id TEXT, purpose TEXT, host TEXT, ip TEXT, method TEXT,
  data_categories TEXT, bytes INTEGER, body_redacted TEXT, decision TEXT, reason TEXT, ts TEXT);

approvals(id TEXT PRIMARY KEY, run_id TEXT, step_id TEXT, tool TEXT, args_json TEXT,
  policy TEXT, state TEXT, decided_by TEXT, decided_at TEXT, expires_at TEXT);
reviews(id TEXT PRIMARY KEY, run_id TEXT, step_id TEXT, version_id TEXT, state TEXT,
  feedback TEXT, decided_at TEXT);
ratings(id TEXT PRIMARY KEY, run_id TEXT, step_id TEXT, version_id TEXT, value INTEGER, note TEXT, compare_id TEXT, ts TEXT);  -- a Compare pick writes one row per run sharing compare_id

memory_items(id TEXT PRIMARY KEY, scope TEXT, owner_id TEXT, content TEXT, source TEXT, trust TEXT,
  run_id TEXT, supersedes_id TEXT, created_at TEXT, expires_at TEXT);
memory_fts(content, item_id UNINDEXED);

schedules(id TEXT PRIMARY KEY, workflow_id TEXT, cron TEXT, inputs_json TEXT, enabled INTEGER,
  catch_up TEXT, last_fired_at TEXT, next_fire_at TEXT);

datasets(id TEXT PRIMARY KEY, name TEXT, version INTEGER, frozen INTEGER);
cases(id TEXT PRIMARY KEY, dataset_id TEXT, input_json TEXT, reference_json TEXT, metadata_json TEXT);
experiments(id TEXT PRIMARY KEY, dataset_id TEXT, target_version TEXT, models_json TEXT, budgets_json TEXT);
experiment_runs(id TEXT PRIMARY KEY, experiment_id TEXT, case_id TEXT, model_id TEXT, run_id TEXT);
scores(id TEXT PRIMARY KEY, run_id TEXT, evaluator_id TEXT, metric TEXT, value REAL, rationale TEXT, ts TEXT);

push_subscriptions(id TEXT PRIMARY KEY, endpoint TEXT UNIQUE, keys_json TEXT, device_label TEXT, events_json TEXT, created_at TEXT);
settings(key TEXT PRIMARY KEY, value_json TEXT);   -- UI-only state (theme, last screen); config lives in config/workbench.json, which the Settings screen edits directly
```

Vocabularies: `runs.kind ∈ agent | workflow | experiment`; `runs.state ∈ queued | running | waiting_review | waiting_approval | interrupted | completed | failed | cancelled`; `run_steps.state ∈ pending | running | skipped | completed | failed | cancelled`; `run_steps.kind ∈ agent | tool | map`; a single-agent run has one step with `step_id = 'main'`; top-level runs have `depth = 0`; `created_by ∈ run-step | human | import`; `attempt` is 1-based.

## Event payloads

| Type | Payload |
|---|---|
| `run-started` | `{ kind, agentId?, workflowId?, agentVersion?, workflowVersion?, inputs, project?, budgets, provider? }` |
| `step-started` / `step-completed` / `step-failed` / `step-skipped` | `{ stepId, kind, agentId?, modelCandidates?, output?, error?, reason? }` |
| `model-started` | `{ modelId, adapter, attempt, request: { system, messages, tools: ToolSpec[], outputSchema?, providerOptions? } }` (no `abortSignal`) |
| `model-completed` | `{ modelId, response, usage, costUsd, latencyMs, promptVersion, agentVersion }` |
| `model-aborted` / `fallback-selected` / `provider-meta-dropped` | `{ modelId, reason }` / `{ from, to, error }` / `{ droppedBlocks }` |
| `tool-requested` / `tool-completed` | `{ callId, tool, input }` / `{ callId, result }` |
| `permission-decided` / `approval-requested` / `approval-decided` / `egress-denied` | `{ tool, decision, policy, hint? }` / `{ approvalId, tool, args, policy }` / `{ approvalId, decision, by, remembered? }` / `{ host, reason }` |
| `memory-retrieved` / `memory-written` / `memory-redacted` | `{ items: [{ id, scope, trust, content }] }` / `{ item }` / `{ itemId, eventSeqs }` |
| `artifact-written` / `review-decided` / `budget-warning` | `{ documentId?, fileId?, versionId, path }` / `{ reviewId, action, feedback? }` / `{ budget, used, limit }` |
| `run-completed` / `run-failed` / `run-cancelled` / `run-interrupted` / `run-queued` | `{ outputs, spent }` / `{ reason, error, partialOutputs? }` / `{ by }` / `{}` / `{ position }` |

## Rules

> Amendment (RUN-01, 2026-09-03): streamed tokens are *shown, not stored*. The engine emits `model-delta` on the live
> bus only; nothing is written to `events`, because the `model-completed` payload already holds the whole
> response. One row per token would bloat every trace without adding a fact, and would break `after=<seq>`
> resume by advancing the cursor past rows a reconnecting client can never replay.

- **Events carry full payloads.** `model-started` stores the compiled request; `model-completed` stores the normalized response and usage. Tool events store inputs and the full result. This is what the trace viewer renders and what reproducibility means here.
- **Every persisted JSON has `schemaVersion`** (`schema_v` on events). A reader that meets a newer version refuses with a message naming both versions; an older version renders best-effort.
- **Migrations** are numbered SQL files (`0001_init.sql`, …) in `src/runtime/db/migrations/`, copied into `dist/`. When any are pending, the database is first copied with the SQLite online backup API to `data/backups/<iso-timestamp>-pre-<target-version>.sqlite` (none when the file does not yet exist; `retention.backups` kept), then all pending migrations are applied inside one transaction. A database newer than the code refuses to open. Downgrade is restoring a backup.
- **Redaction** (D-33) is applied to every persisted JSON or text column (`events`, `egress_log`, `runs.inputs_json`, `run_steps.output_json`, `model_calls.*`, `approvals.args_json`, memory and document content), to the log file, to every export, and to every API response body; the redactor (`[REDACTED:<name>]`, structural walk over strings) is the single write path for all of them. The runtime token is registered with it at startup.
- **Retention**: scratch directories after `retention.scratchDays`; events until the owner deletes a run; memory redaction rewrites event payloads in place and appends `memory-redacted`.

## Exports

| Export | Contents |
|---|---|
| project | documents at latest version, `files/`, `manifest.json` (versions, provenance, redactions) |
| agent / workflow | the definition file with permissions rewritten to requested |
| memory | JSONL of items in chosen scopes |
| runs | JSONL of events for the chosen runs, redacted, plus `manifest.json` |
| workspace | all of the above and `config/workbench.json`; never credentials, the token, or `runtime.json` |
