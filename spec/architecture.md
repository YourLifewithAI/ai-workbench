# Architecture

*Prose cap: 550 words. Decisions cited: D-20 … D-25, D-39, D-45.*

## Process model (D-21, D-22, D-45)

One Node process is the product. It serves the HTTP API and SSE, serves the built SPA as static files, runs the execution engine and the scheduler, writes the log, and holds the single SQLite handle. Tools that touch the filesystem outside a project, the shell, or arbitrary code run in child processes (the sandbox). The browser is a client and holds no secrets, no logic, and no state that matters.

The CLI is a client too (D-45): every command except `init`, `doctor`, `start`, and `dev` talks HTTP to the runtime it finds through `<workspace>/data/runtime.json` (`{ port, pid, startedAt }`) and `data/runtime.token`. If no runtime is alive for that workspace, the command starts an ephemeral one in-process, runs, and shuts it down — so the single-handle invariant holds and `workbench run …` works on a fresh clone with nothing else running.

```
browser (SPA) ─┐
CLI (HTTP) ────┴─token─▶ runtime :8787 (127.0.0.1)
                          ├─ api/         HTTP + SSE
                          ├─ engine/      runs, steps, the agent loop, events
                          ├─ models/      canonical types, adapters over @ai-sdk/*, catalog, mock
                          ├─ security/    credentials, redaction, broker, egress, sandbox, childEnv
                          ├─ tools/       built-ins, MCP client
                          ├─ artifacts/   projects, documents, files, versions
                          ├─ memory/      memory items, knowledge, FTS
                          ├─ eval/        datasets, experiments, scores
                          ├─ scheduler/   cron, job queue
                          ├─ workspace/   loader, config precedence
                          ├─ db/          SQLite, migrations, backups
                          ├─ log/         pino → data/logs/runtime.log (+ stderr), through the redactor
                          └─ bootstrap.ts the only reader of WORKBENCH_* environment variables
```

## Repository layout (D-23)

```
ai-workbench/
├── src/
│   ├── shared/     Zod schemas + types only (no runtime imports): model.ts, agent.ts, workflow.ts, api/…
│   ├── runtime/    the folders above, plus cli/
│   └── ui/         Vite React SPA
├── defaults/       workbench.json, models.json (seed)
├── examples/workspace/   grows with the runs: echo (00), story agents (01), workflows (04), briefing (07)
├── tests/          unit/ contract/ security/ dod/RUN-nn.test.ts e2e/ (Playwright)
├── spec/           this specification (present from the first commit)
├── runlog/         handoffs written by run agents (README.md placeholder)
├── AGENTS.md  CLAUDE.md  STATUS.md  SECURITY.md  SUPPORT.md  LICENSE
└── package.json    one package; tsconfig.json (runtime, Node) and tsconfig.ui.json (browser)
```

Boundary rules, enforced by ESLint and failing the check gate:

- `src/ui` imports only `src/shared` and its own files. `src/runtime` never imports `src/ui`. `src/shared` imports nothing from `src/`.
- `ai` and `@ai-sdk/*` are importable only inside `src/runtime/models/adapters/`.
- `src/runtime/tools/**` and `src/runtime/engine/**` may not import `node:fs`, `node:net`, `node:child_process`, or use the global `fetch`; they receive broker handles (child processes, including MCP servers and the sandbox, are spawned by `security/`). Adapters use the injected `fetch` only. (`no-restricted-globals` on `fetch` in `adapters/**`, `tools/**`, and `engine/**`.)
- `process.env` is readable only in `src/runtime/bootstrap.ts` and `src/runtime/security/credentials.ts` (`no-restricted-properties`); `tests/**` and the Vite, Playwright, and Vitest config files are exempt. Bootstrap snapshots the child-environment allowlist (`PATH HOME TMPDIR LANG LC_* TZ`) once and hands it to `security/childEnv()`, which therefore never touches `process.env`.
- `node:vm`, `eval`, and `new Function` are banned everywhere.

Folders become packages only when an external consumer exists (D-23).

## Workspace contract (D-24)

The workspace is a directory outside the repository, chosen by `--workspace <path>` (accepted by every command) or `WORKBENCH_WORKSPACE`. The harness never writes outside it except to its own installation, an `init <path>` target, and an explicit `--out` directory.

```
<workspace>/
├── workspace.json          { schemaVersion: 1, name, createdAt }
├── config/
│   ├── workbench.json      settings (below)
│   ├── models.json         catalog (model-layer.md), seeded from defaults/models.json by init
│   └── credentials.json    0600; { "google": { "apiKey": "…" }, "brave": { "apiKey": "…" } }
├── agents/<id>/agent.json  (+ instructions.md)
├── workflows/*.workflow.json
├── projects/<slug>/project.json, files/
├── fixtures/*.json         mock provider scripts (model-layer.md)
├── plugins/
├── data/                   workbench.sqlite, backups/, logs/, runtime.token, runtime.json
├── runs/<runId>/scratch/   per-run scratch, deleted after retention.scratchDays
└── exports/
```

Loading: `workspace.json`, `config/workbench.json` (any subset of keys; the rest come from defaults), and `config/models.json` are required and validated against their `src/shared` schemas (`config/credentials.json` is optional); an error names the file and JSON path and the runtime refuses to start. Agents and workflows that fail validation are listed as broken in the UI with the same message, never silently skipped. Missing directories are created. `workbench init <path>` copies `examples/workspace/`, seeds `config/`, writes `workspace.json`, and refuses if one already exists.

`config/workbench.json` (shipped defaults in `defaults/workbench.json`):

```jsonc
{ "schemaVersion": 1,
  "network": { "mode": "allowlist", "allowLocalAddresses": false },   // agent egress; declared endpoints follow mode only
  "budgets":   { "maxModelCalls": 60, "maxToolCalls": 120, "maxCostUsd": 2.0, "maxWallClockMs": 1800000,
                 "toolCallTimeoutMs": 60000, "dailySpendCapUsd": 20.0 },
  "execution": { "maxParallelSteps": 4, "maxConcurrentRuns": 2, "escalation": "sensitive-only" },   // sensitive-only | everything-once | approvalRequired-only
  "retention": { "scratchDays": 7, "backups": 5 },
  "context":   { "keepRecentToolResults": 5, "maxToolResultChars": 8000, "memoryItems": 8, "knowledgeChunks": 6 },
  "search":    { "provider": "mock" },
  "tools":     { "http": { "maxResponseBytes": 2097152, "timeoutMs": 20000 } },
  "mcp":       { "servers": [] },
  "push":      { "enabled": true, "events": ["approval-requested", "review-blocking", "run-failed", "scheduled-completed"] },
  "grants":    { "<agentId>": { /* Permissions actually granted to that agent */ } },
  "remembered": [ { "tool": "http.request", "host": "api.example.com" } ] }
```

## Configuration precedence (D-20)

The four levels and the merge rule are D-20; permissions never merge (D-26) and credentials are never part of the hierarchy. Environment variables configure only bootstrap — `WORKBENCH_WORKSPACE`, `WORKBENCH_PORT`, `WORKBENCH_BIND` (host only) — and, optionally, credentials as `WORKBENCH_CRED_<NAME>` for CI. Flags beat environment variables.

## Dependency policy

| Concern | Decision | Package (pinned exact) |
|---|---|---|
| Model transport and normalization | reuse | `ai`, `@ai-sdk/google`, `@ai-sdk/openai-compatible`, `@ai-sdk/anthropic` |
| Tool protocol | reuse | `@modelcontextprotocol/sdk` |
| Database | reuse | `better-sqlite3` (FTS5 asserted at startup; its native `install` script is expected) |
| HTTP server / client | reuse | `hono`, `@hono/node-server`, `undici` (pinned connections) |
| Schemas, ids, logging, CLI | reuse | `zod`, `ulid`, `pino`, `commander` |
| Scheduling | reuse | `croner` |
| Parsing | reuse | `pdf-parse`, `linkedom`, `@mozilla/readability`, `turndown`, `marked`, `csv-parse` |
| Graph layout | reuse | `dagre` (nodes drawn as SVG) |
| Build | reuse | `vite`, `tsup` (runtime + CLI bin; `migrations/`, `defaults/`, and `examples/` copied into `dist/` so `init` works from the built bin) |
| Sandbox | reuse | Deno CLI (external, optional) |
| Canonical types, engine, broker, permissions, workflows, artifacts, memory, trace viewer, UI | build | — |

Every dependency is pinned exactly; the lockfile is committed; CI uses `npm ci`; any new dependency with an install-time script is named in the handoff.

## Deployment (D-60)

The shipped `Dockerfile` builds the runtime and SPA into one image that runs `workbench start` bound to `127.0.0.1` inside the container with the workspace as a volume; `compose.yaml` adds nothing else. `deploy.md` is the VPS recipe: Docker, the workspace volume and its backup cron, Tailscale on the host with `tailscale serve` fronting the port, `--expose <tailnet-hostname>`, and disk encryption as the host's job. Local development uses the same `workbench start` without Docker.

## Platforms (D-39)

Linux and macOS are supported and tested in CI (GitHub Actions, both OSes, `npm run check` and `npm run e2e`). Windows is best-effort via WSL2. Node ≥ 22. Deno ≥ 2 is optional and enables the execute tier of tools. Ids are ULIDs; timestamps are ISO 8601 UTC.
