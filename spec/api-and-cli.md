# API and CLI

*Prose cap: 550 words. Decisions cited: D-21, D-14, D-37, D-45.*

Every request and response body is a Zod schema in `src/shared/api/`; the UI and the CLI share one hand-written typed client built on those schemas. Errors are `{ error: { code, message, details? } }` with `code ∈ unauthorized | forbidden | not_found | validation | conflict | budget | unavailable | internal` and conventional status codes.

## HTTP (`/api/v1`, bearer token required)

Order of checks: `Host`/`Origin` (403) before token (401). Requests without an `Origin` header (the CLI) pass the origin check; when present it must be `http://127.0.0.1:<port>` or `http://localhost:<port>`. Static files and `/api/v1/health` need no token but still get the Host check and CSP.

| Resource | Routes |
|---|---|
| runs | `POST /runs` `{ kind: 'agent'|'workflow', id, inputs, project?, overrides?, provider?: 'mock' }` → `{ runId }` · `GET /runs?state=&kind=&project=` · `GET /runs/:id` (summary, steps, spent) · `POST /runs/:id/cancel` · `POST /runs/:id/resume` · `GET /runs/:id/events?after=<seq>` (replays stored events after `seq`, then streams live ones; SSE `id` = seq, `event` = type, `data` = the JSONL line; the stream closes after a terminal event) · `GET /runs/events` (workspace-level SSE of `run-*` events for every run, feeding lists and the Dashboard) · `GET /runs/:id/trace.jsonl` · `GET /runs/:id/privacy` |
| agents | `GET /agents` (incl. load errors) · `GET /agents/:id` · `POST /agents/reload` |
| workflows | `GET /workflows` · `GET /workflows/:id` · `POST /workflows` (new: blank or a copy, RUN-13) · `PUT /workflows/:id` `{ definition, baseVersion }` (the editor's save: validated, refused with a diff if the file moved, D-62) · `DELETE /workflows/:id?deleteSchedules=true` (refused with the count until the schedules are accepted) |
| projects | `GET /projects` · `POST /projects` · `GET /projects/:slug` |
| evaluation | `GET /datasets` · `POST /datasets` · `GET /datasets/:id/cases` · `GET /datasets/:id/export` · `POST /datasets/import` · `GET /experiments` · `POST /experiments` · `GET /experiments/:id/results` · `POST /experiments/:id/cancel` · `POST /compare` · `POST /compare/pick` |
| documents | `GET /projects/:slug/documents` · `GET /documents/:id` · `GET /documents/:id/versions` · `PUT /documents/:id` (human edit → version) · `POST /runs/:id/rerun` `{ model? }` |
| review | `GET /reviews?state=open` · `POST /reviews/:id` (`rate | edit | reject | continue`) |
| approvals | `GET /approvals?state=pending` · `POST /approvals/:id` (`allow | deny`, `remember?`) |
| models | `GET /models` (catalog + availability + data policy) · `POST /models/refresh` (polls local endpoints and, from RUN-15, asks every provider with a credential what it offers; answers with `findings`, D-64) · `POST /models/findings/:id/accept` (writes the catalog as a hand edit would; a new model lands disabled) · `POST /models/findings/:id/dismiss` (suppressed until the provider's facts change) · `PUT /models/:id/price` (a price row in effect from now, typed in on the Models screen, D-65) · `PUT /models/:id/enabled` (the flag a hand edit would flip) |
| memory | `GET /memory?q=&scope=` · `POST /memory` · `DELETE /memory/:id?redactTraces=true` |
| memory (RUN-08) | also `GET /memory/:id/traces` → `{ itemId, runIds }`, so the delete dialog can say how many traces quoted it before it offers to rewrite them |
| knowledge (RUN-08) | `POST /projects/:slug/knowledge?filename=<name>` takes the file as the raw request body (`application/octet-stream`); the extension decides the format |
| knowledge | `POST /projects/:slug/knowledge` (ingest) · `GET /knowledge/search?q=` |
| schedules | `GET /schedules` · `POST /schedules` (upsert; pass an id to replace) |
| permissions review | `GET /permissions/findings?state=open` (what the auditor proposed, with the runtime's evidence, D-63) · `POST /permissions/findings/:id` `{ decision: 'apply' | 'dismiss' }` (apply is the human's matrix write, the same as the Tools screen's; dismiss holds until the facts change) |
| tools | `GET /tools` (built-ins, MCP, sandbox status, grant matrix) · `PUT /tools/grants` · `PUT /tools/repos` (a repository grant from the Tools screen: the whole list for one agent, replaced; paths must be absolute, D-66) |
| experiments | `GET/POST /datasets` · `GET /datasets/:id/export` · `POST /datasets/import` · `GET/POST /experiments` · `GET /experiments/:id/results` · `POST /compare` |
| export / import | `GET /export/agent/:id` · `GET /export/workflow/:id` · `GET /export/memory?scope=` · `GET /export/runs?ids=` · `POST /import/agent` · `POST /import/workflow` · `POST /import/memory` (project export/import are under projects) |
| settings | `GET /settings` → `{ workspacePath, networkMode, budgets, execution, retention, providersConfigured: string[], sandbox: { deno: boolean } }` · `PUT /settings` (rewrites `config/workbench.json`) · `PUT /settings/credentials` |
| settings (RUN-11) | `PUT /settings` takes some of `{ budgets, retention, execution, mcp, push }` and merges each into the file — grants are **not** among them, because the matrix is the Tools screen. `PUT /settings/credentials` `{ name, apiKey }` writes the 0600 file (`apiKey: null` removes one) and answers with the configured *names*; the value is never read back out, and the runtime re-reads its credentials immediately so a key saved mid-session is redacted from the next trace. `POST /plugins/trust` `{ name, version }` records an acknowledgement (D-32). |
| push | `GET /push/vapid-public-key` · `POST /push/subscribe` `{ endpoint, keys, deviceLabel, events }` · `DELETE /push/subscriptions/:id` (D-61) |
> Amendment (RUN-03, 2026-09-03): `GET /documents/:id/diff?from=&to=` returns the line diff the Library renders, so the
> UI and the CLI show the same comparison. `export` and `import` act on the workspace directly rather than over
> HTTP, like `init` and `doctor`: they move whole folders, and an ephemeral runtime is the wrong shape for that.

> Amendment (RUN-02, 2026-09-03): `PUT /settings/network` `{ mode }` writes just the network mode to
> `config/workbench.json` and applies it in place. Cutting the network is a safety control, so it is one click
> (ui.md §Global controls) rather than a config edit and a restart; the rest of `PUT /settings` still waits for
> RUN-11.

| health | `GET /health` → `{ version, bind, port, startedAt }` (no token) |

Shapes used everywhere: `inputs` is an object (`run agent --input <text>` sends `{ input: <text> }`; workflows take their `inputs` schema); a single-agent run's `outputs` is `{ output: <text | validated JSON> }`, a workflow's is its `outputs` record; `spent` is `{ modelCalls, toolCalls, costUsd, wallClockMs }`. `POST /runs` returns 202. `GET /runs` items are `{ id, kind, state, agentId?, workflowId?, project?, startedAt, finishedAt?, spent }`.

> Amendment (RUN-01, 2026-09-03): `GET /runs/:id/events` also carries transient `model-delta` frames
> (`{ runId, stepId, modelId, kind: 'text' | 'reasoning', text }`) so a client can watch tokens arrive. They
> carry no SSE `id`, are never stored, and never appear in `trace.jsonl` — a reconnecting client's `after=<seq>`
> cursor is therefore unaffected by them.

Long-running runs are observable from any client: a reconnecting client passes the last `seq`, and a closed tab loses nothing.

## CLI (`workbench`, alias `wb`) — D-45

Parity with the UI, `--json` everywhere, exit 0 on success, `--workspace <path>` on every command (else `WORKBENCH_WORKSPACE`). Commands other than `init`, `doctor`, `start`, and `dev` are HTTP clients that locate the runtime via `data/runtime.json` and `data/runtime.token`. A runtime is *alive* when the file's `pid` is running and `GET /health` on its port returns the same `startedAt`; a stale file is deleted. If none is alive the command starts an ephemeral in-process runtime for its own duration: it binds an OS-assigned port, keeps its token in memory, writes neither `runtime.json` nor `runtime.token`, and logs to the same log file. `--detach` without a live runtime is refused with a message saying to `start` one. This is how agents operate the workbench headlessly, including the agents that test their own work.

```
workbench init <path>                      copy examples/workspace, seed config/, write workspace.json; refuses if one exists
workbench start [--open] [--port n|0] [--bind host] [--provider mock] [--expose <origin>]     blocks; prints the tokened URL once; SIGTERM closes cleanly; --provider mock mocks every run the runtime starts (UI, schedules, e2e); --expose adds <origin> to the accepted Host/Origin sets
workbench dev                              start + Vite dev server with proxy (CSP relaxed for HMR) — from RUN-01
workbench doctor                           workspace validity, FTS5, Deno, credentials present per provider, disabled tools, granted repositories (path, checkout, gate, branch pattern) — whichever checks exist at the current run; exit 1 on invalid workspace
workbench run agent <id> --input <text> [--project slug] [--provider mock] [--model id] [--detach] [--json]
workbench run workflow <id> --inputs-file f.json [--project slug] [--provider mock] [--detach] [--json]
workbench runs list|show|cancel|resume|rerun <id>
workbench trace <runId> [--json]           JSONL to stdout (a readable timeline without --json)
workbench review list|rate|edit|reject|continue
workbench projects list|create|show      workbench documents list|show|versions
workbench schedules list|set|enable|disable    workbench tools list|grant|revoke
workbench settings get|set               workbench datasets list|create|export|import
workbench experiments run|results        workbench compare --step <id> --models a,b,c
workbench approvals list|allow|deny <id> [--remember]
workbench models list|refresh|accept|dismiss
workbench memory search|add|delete
workbench export project|agent|workflow|memory|runs|workspace <…> --out <dir>
workbench import project|agent|workflow|memory|knowledge <path>
```

`run` blocks until the run finishes and prints `{ runId, state, outputs, costUsd }` with `--json`; `--detach` prints `{ runId }` immediately. `--provider mock` forces every model policy onto the mock adapter (which serves any catalog id, so per-step overrides stay distinguishable in fixtures) and switches every other external service (search) to its mock (D-37).

## Gates (`package.json`)

```
npm run check      typecheck (both tsconfigs) · lint (boundaries, banned globals) · unit · security (tests/security) · secret scan
npm run e2e        Playwright (chromium) against a temp workspace started by global setup on --port 0
npm run contract   adapter contract suite [-- --live <adapter>]   (WB_LIVE=1 is the same switch for dod/e2e live cases)
npm run dod -- 05  builds, then tests/dod/RUN-05.test.ts + the e2e tagged @run-05
npm run build      SPA + runtime + CLI bin to dist/
```

The secret scan is a small in-repo scanner over tracked files plus `dist/` (excluding `node_modules`, `.git`, and `spec/`), with length-bounded patterns — `AIza[0-9A-Za-z_-]{30,}`, `sk-ant-[0-9A-Za-z_-]{40,}`, `sk-[0-9A-Za-z]{40,}`, `ghp_[0-9A-Za-z]{36,}`, `xox[abp]-[0-9A-Za-z-]{20,}`, `WORKBENCH_CRED_[A-Z]+=\S{16,}` — exposed as a function so SEC-31 can run it against a planted file whose key is assembled at test time.

## JSONL trace

One event per line: `{ seq, runId, stepId, type, ts, schemaVersion, payload }` — the `events` row with `payload` parsed. Types: `run-started, run-queued, step-started, step-completed, step-failed, step-skipped, model-started, model-completed, model-aborted, fallback-selected, provider-meta-dropped, tool-requested, permission-decided, approval-requested, approval-decided, tool-completed, repo-decided, egress-denied, memory-retrieved, memory-written, memory-redacted, artifact-written, review-decided, budget-warning, run-cancelled, run-completed, run-failed, run-interrupted`. Payloads are in `data-model.md`. Debugging a run is reading this file.


> Amendment (RUN-04, 2026-09-03): the workflow surface.
>
> - `POST /api/v1/runs` accepts `kind: 'workflow'`; `overrides.budget` narrows the run's budgets (narrowing only, D-20).
> - `POST /api/v1/runs/:id/cancel` → 202, 404 for an unknown run, 409 for one that already finished.
> - `GET /api/v1/workflows` → `{ workflows, errors }`; `GET /api/v1/workflows/:id` adds the definition, the validator's advisory smells, and the topological order. A workflow's `steps[].dependsOn` in these responses is the *effective* set — declared dependencies plus every edge a template reference implies — because a graph drawn from the declared set alone shows independent steps where the file describes a pipeline.
> - `RunSummary` carries `budgets` (what the run may spend) alongside `spent`, so a list can draw the bar without a second request. `StepSummary` carries `parentStepId` and `mapIndex`, set on a map item.
> - CLI: `workbench run workflow <id>` (`--inputs-file`, repeatable `--input k=value`, `--project`, `--provider`, `--max-model-calls`, `--max-cost-usd`, `--detach`) and `workbench runs cancel <runId>`.

> Amendment (RUN-05, 2026-09-03): the review, rating, schedule and dashboard surfaces.
>
> - `GET /api/v1/reviews?state=open|unreviewed|pending|…`; `POST /api/v1/reviews/:id` with `{ decision, feedback? }` (a rejection without feedback is a 400 — the step re-runs with what you say, so "no" on its own would change nothing); deciding an already-decided review is a 409.
> - `POST /api/v1/ratings` with `{ runId, stepId, versionId?, value: 1-5, note? }`. `GET /documents/:id` joins ratings by version id.
> - `GET/POST /api/v1/schedules`, `DELETE /api/v1/schedules/:id`. `POST` with `?id=` edits an existing one.
> - `POST /api/v1/runs/:id/resume`.
> - `GET /api/v1/dashboard` answers "what needs me" in one request: blocking reviews, failed and interrupted runs, running runs with their budgets, today's spend against the cap, and the next scheduled runs.
> - `runs.spent_json` is updated after every model call, not only when the run ends: a budget bar that moves only at the end is not a budget bar.
> - CLI: `workbench review list|show|continue|reject|dismiss|rate`, `workbench runs resume`, `workbench schedules list|add|remove`.
> - A blocking CLI run (`run workflow` without `--detach`) stops when the run parks and prints the review id: no amount of polling produces a human, and the ephemeral runtime the CLI started is the only thing that could have decided it. Deciding a gate from the CLI requires a *live* runtime, because deciding it from a second process would leave the first holding a waiter that never resolves.

> Amendment (RUN-06, 2026-09-03): the tool, grant and approval surfaces.
>
> - `GET /api/v1/approvals?state=pending|allowed|denied|expired|all` returns batched cards; `POST /api/v1/approvals/:batchOrId` with `{ decision: 'allow' | 'allow-remember' | 'deny', actionId? }` decides the batch or one action of it.
> - `GET /api/v1/tools` returns the catalogue, the tool × agent grant matrix (requested vs granted vs effective, with the reason the broker would give), the last 50 refusals, and the remembered rules. `PUT /api/v1/tools/grants` with `{ agentId, toolId, grant: 'allow' | 'deny' | 'unset' }` writes to `grants.<agentId>` in `config/workbench.json`.
> - `GET /api/v1/dashboard` gained `approvals`, listed above blocking reviews: a review waits as long as you like, an approval is refused on a timer.
> - CLI: `workbench approvals list|allow|deny` (`--remember`, `--action`) and `workbench tools list|grants|grant` (`--deny`, `--unset`).
> - The trace summary leads with `DENIED` or the tool error code. A denial is the line a human opens a trace to find.

> Amendment (RUN-12, 2026-09-03): the push surface.
>
> - `GET /api/v1/push/vapid-public-key`, `GET /api/v1/push/subscriptions`, `POST /api/v1/push/subscribe`, `PUT /api/v1/push/subscriptions/:id` (which events this device wants), `DELETE /api/v1/push/subscriptions/:id`. All behind the bearer token, including the public key: a stranger who can read it learns this workbench exists, and nothing needs to tell them that.
> - A subscription is returned with its push service's **host only**. The full endpoint is a capability URL and would end up in a screenshot.
> - `data/vapid.json` is written at `init` at 0600 and never rotated: rotating would silently deafen every device that had subscribed. The private half is registered with the redactor.
> - The payload is `{ kind, id, runId, title, url }` — five keys, always. `title` comes from a fixed table of four strings in the runtime, and the service worker's body text is a constant, so a compromised push service cannot put words on a lock screen (SEC-32).
> - `push.enabled` defaults to true, because it does nothing at all until a device subscribes.

> Amendment (owner review, 2026-09-04): the rerun-downstream route on a document is removed from the table
> rather than built. It needs a record of which runs *read* which document version, and no such record
> exists — `document_versions.run_id` says who wrote a version, never who consumed one. Building it means
> recording the read where the knowledge section is assembled, which is a change to the prompt path and
> belongs in a run of its own. Project and workspace export/import are CLI operations, not routes: they
> write directories, which is why they were never implemented as HTTP and should not have been listed.
> `npm run route-drift` now fails the check gate whenever this table and `app.ts` disagree.

> Amendment (RUN-16, 2026-09-05): `GET /api/v1/tools` also returns `grants`, one entry per agent —
> `{ agentId, fs: { read, write }, repos: [{ path, branches }] }` — the half of a grant that is not a tool,
> as a person wrote it in `config/workbench.json`. Read-only: `PUT /tools/grants` edits tools, and a
> repository grant is written by hand on purpose (D-66). `workbench doctor` gains a `repositories` check.
> The trace gains `repo-decided`.

> Amendment (RUN-17, 2026-09-05): `GET /api/v1/workflows/:id` also returns `budgets` — `{ workflow, steps:
> [{ stepId, budget }] }`, only the caps the author wrote — so the run form can show what a workflow and each
> of its steps cap themselves at before a run starts. Nothing new in the CLI: `workbench run workflow
> coding-run --input brief=spec/runs/RUN-13.md --input repo=/abs/checkout` starts a coding run, and the parked
> review is decided in Review or with `workbench review continue|reject`.

> Amendment (RUN-13, 2026-09-05): the workflow write path. `GET /workflows/:id` also returns `schedules`, the
> number of schedule rows pointing at it. `PUT /workflows/:id` takes `{ definition, baseVersion }` and answers
> the detail; a draft that would not run is `400 validation` with `details.issues: [{ path, stepId, message }]`
> (the same verdict the editor shows live — `src/shared/workflow-check.ts` is one function for both); a file
> whose hash moved since `baseVersion` is `409 conflict` with `details.conflict: { baseVersion, currentVersion,
> against: 'loaded' | 'draft', diff }`, the diff drawn against the opened version when the runtime still knows
> it (in memory, or a `workflow_versions` row) and against the draft otherwise; nothing is written in either
> case. `POST /workflows` `{ id, name, copyOf? }` writes a blank one-step file or a copy without its schedule
> block. `DELETE /workflows/:id` is `409 conflict` with `details.schedules` while schedules point at it;
> `?deleteSchedules=true` removes them with the file. The file is written compacted: keys in reading order,
> schema defaults left out; the hash is over the parsed form, so that changes nothing a run sees. CLI:
> `workbench workflows list | show <id> | new <id> --name <name> [--copy-of <id>] | edit <id> | delete <id>
> [--with-schedules]`. `edit` opens the file in `$VISUAL`, else `$EDITOR`, else `notepad` or `vi`, with the
> child allowlist plus the terminal and display variables; when the editor closes the file is validated exactly
> as the loader validates it, left as written either way, exit 1 with the reason when it would not load, and a
> running workbench is told to reload when it is valid. A batch-file `EDITOR` is refused on Windows by name.

> Amendment (RUN-14, 2026-09-05): the permissions review. `GET /permissions/findings?state=open|applied|dismissed|all`
> answers `{ findings: [{ id, key, kind, agentId, tool, headline, evidence[], note, proposal, state, runId,
> createdAt, decidedAt }] }`, where `kind` is one of `unused`, `unjustified`, `reach`, `fatigue`, `undecided`,
> and `proposal` is `{ agentId, tool?, set?: allow|deny|unset, netAllow?, label }` or null. `POST
> /permissions/findings/:id` `{ decision: 'apply' | 'dismiss' }`: apply performs the proposal through the same
> `setGrant` the Tools screen uses and is logged the same way (`grant_log`, source `human`); dismiss records the
> finding's facts hash so the same finding on the same numbers stays quiet; `409` when already decided, `400`
> when there is nothing to apply. Two tools join the catalogue, granted to the auditor only: `permissions.facts`
> (read tier; a brief of grant metadata with the candidate findings first, cut to fit under the tool-result
> limit) and `permissions.propose` (write tier; files candidates by id, or an `unjustified` finding of the
> auditor's own with the agent, the tool and a note). Neither can touch a path, a host or a credential, and no
> tool anywhere sets a grant. CLI: `workbench review findings list | apply <id> | dismiss <id>`. A workflow's
> `schedule` block may say `enabled: false`; the row is seeded paused.

> Amendment (D-68, 2026-09-05): `GET /settings` also returns `models: { roles, resolved, undefinedRoles }` — each
> role's list, the model it comes to right now (or null), and the roles an agent or a step names that no list
> defines. `PUT /settings` takes `models: { roles }`, the whole map, replaced; a role name is lowercase letters,
> digits and hyphens. `GET /agents` and `GET /agents/:id` carry `modelPolicy.now`: the ids the policy comes to
> right now, roles expanded, only what is ready. `workbench doctor` gains a `model roles` check that names what
> each role resolves to and any role an agent names that is not defined.
