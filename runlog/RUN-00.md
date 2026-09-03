# RUN-00 handoff — Foundation and security floor

**Branch:** `run/00-foundation` · **Head:** `58758fe` · **Status:** awaiting verification

## Built
- `package.json`, `tsconfig*.json`, `eslint.config.js`, `vitest.config.ts`, `vite.config.ts`, `tsup.config.ts`, `playwright.config.ts`, `.github/workflows/ci.yml` — single package, two TypeScript programs (runtime, browser), the boundary and banned-global lint rules, CI on Linux and macOS plus a Docker job.
- `src/shared/{model,agent,permissions,workspace,events,api/index}.ts` — the canonical Zod schemas the runtime, CLI, and UI share (model types with `providerMeta`, `ToolSpec`, `CatalogEntry`, agent definition, config, event record, HTTP contract).
- `src/runtime/bootstrap.ts` — the only `WORKBENCH_*` reader; snapshots the child-env allowlist once.
- `src/runtime/db/` — `better-sqlite3` with WAL, injectable FTS5 assertion, numbered migrations (`0001_init.sql`: runs, run_steps, events, model_calls, settings), online backup before a pending migration, refuse-if-newer.
- `src/runtime/workspace/` — loader with file-and-path errors, `initWorkspace`, defaults < workspace config precedence.
- `src/runtime/security/` — token generation and 0600 file, Host/Origin guard before the bearer guard, CSP and hardening headers, credentials loader (0600 file or `WORKBENCH_CRED_*`), redactor, `childEnv()`, secret scanner.
- `src/runtime/log/` — pino to `data/logs/runtime.log` (and stderr) through the redactor.
- `src/runtime/models/` — normalized error classes, adapter registry, catalog lookup and pricing, the scripted mock adapter with fixture matching and an in-memory call log.
- `src/runtime/engine/` — prompt assembly (identity, instructions, harness last; task as first user message; `promptVersion` over stable sections), append-only event store with a live bus, single-step engine writing full-payload events and `model_calls` rows.
- `src/runtime/api/app.ts` — Hono app: `/api/v1` health (no token), runs create/list/show, per-run and workspace SSE, JSONL trace, settings; SPA serving with a canonicalized static handler and index fallback; every JSON body through the redactor.
- `src/runtime/runtime.ts`, `foreground.ts`, `server.ts` — the runtime object (create/start/stop, `runtime.json` + `runtime.token` unless ephemeral), the foreground runner shared by `workbench start` and the container entry.
- `src/runtime/cli/` — `workbench init | start | doctor | run agent | runs list|show | trace` as HTTP clients with runtime discovery and the ephemeral in-process fallback (D-45).
- `src/ui/` — Vite + React 19 + Tailwind 4 + react-router + TanStack Query: token handshake, navigation skeleton with every screen as a route, Welcome first-run path, Runs list (live over SSE) with its empty state, raw per-run timeline with the compiled prompt readable, read-only Settings, light/dark/system themes, reduced motion, 3:1 focus ring.
- `defaults/`, `examples/workspace/` — default config and catalog (`mock/echo`), the echo agent, `fixtures/README.md`, `slow.json`.
- `scripts/secret-scan.ts`, `scripts/dod.ts`, `scripts/docker-smoke.sh`, `scripts/docker-entrypoint.sh` — the check-gate scanner, the DoD runner (builds `dist/` first if missing), the CI Docker smoke, the container entry that creates the workspace on first start.
- `Dockerfile`, `compose.yaml`, `.dockerignore`, `deploy.md` — multi-stage image bound to 127.0.0.1, host-network compose, VPS + Tailscale recipe (D-60).
- `tests/helpers/workspace.ts`, `tests/unit/*`, `tests/security/*`, `tests/dod/RUN-00.test.ts`, `tests/e2e/*` — see the transcript.

## Not built (deliberate)
- shadcn/ui via its CLI and Radix primitives — no screen needs a primitive yet; `Button`, `Card`, `Badge` follow the shadcn pattern with the ring raised, so shadcn components drop in unchanged when RUN-01 needs a Dialog or Select.
- `workbench dev` — RUN-01 (the command exists and says so).
- Web manifest, service worker, push — RUN-12.
- Summary layer over the timeline, Privacy Inspector, cancel — RUN-01/02/04 as the brief says.

## Deviations from the brief
- **Docker verified in CI only.** The build sandbox has a Docker CLI but no daemon, so the image, `compose.yaml`, and `scripts/docker-smoke.sh` are shell-parsed and reviewed here, and DoD item 6 is proven by the `docker` job in `.github/workflows/ci.yml` on the first PR.
- `playwright.config.ts` honours `WB_CHROME=<path>` so a sandbox with a preinstalled Chromium can run e2e without downloading the pinned build; CI still installs the matching browser.
- Static files are served by a small path-canonicalizing handler in `app.ts` rather than `@hono/node-server`'s `serveStatic`, which resolves relative to the process cwd and would break a globally installed bin.
- `run agent` (blocking) polls `GET /runs/:id` every 150 ms instead of holding an SSE stream; simpler client, same observable result. The per-run SSE is exercised by the UI and by tests.
- Tests use `os.tmpdir()` workspaces; nothing in the repository is touched by a test.

## Verification transcript
```
$ npm run check
> ai-workbench@0.0.0 check
> npm run typecheck && npm run lint && npm run test:unit && npm run test:security && npm run secret-scan
> ai-workbench@0.0.0 typecheck
> tsc -p tsconfig.json --noEmit && tsc -p tsconfig.ui.json --noEmit
> ai-workbench@0.0.0 lint
> eslint .
> ai-workbench@0.0.0 test:unit
> vitest run --project unit
 Test Files  5 passed (5)
      Tests  17 passed (17)
> ai-workbench@0.0.0 test:security
> vitest run --project security
 Test Files  5 passed (5)
      Tests  15 passed (15)
> ai-workbench@0.0.0 secret-scan
> tsx scripts/secret-scan.ts
secret-scan: clean (/tmp/claude-0/-home-user-agent-hub/09044b71-e09a-52db-9c79-27f98447d1a8/scratchpad/ai-workbench)
$ npm run dod -- 00
> ai-workbench@0.0.0 dod
> tsx scripts/dod.ts 00
 Test Files  1 passed (1)
      Tests  6 passed (6)
$ WB_CHROME=/opt/pw-browsers/chromium npm run e2e
Running 4 tests using 1 worker
  ✓  1 [chromium] › tests/e2e/shell.spec.ts:17:1 › token handshake: the fragment is consumed and scrubbed; a reload without it asks for the token (983ms)
  ✓  2 [chromium] › tests/e2e/shell.spec.ts:29:1 › Runs lists the seeded run, updates live when the CLI starts another, and opens its timeline (2.1s)
  ✓  3 [chromium] › tests/e2e/shell.spec.ts:52:1 › Welcome runs the example and reaches its trace; Settings is read-only and reachable (1.5s)
  ✓  4 [chromium] › tests/e2e/shell.spec.ts:66:1 › keyboard-only navigation reaches every route; both themes and reduced motion apply (1.1s)
  4 passed (9.0s)
$ node dist/cli.js init /tmp/ws && node dist/cli.js start --workspace /tmp/ws --port 0
http://127.0.0.1:37179/#token=…            (exactly one stdout line; [::1] refused; SIGTERM → exit 0, runtime.json and runtime.token removed)
$ node dist/cli.js run agent echo --input hi --provider mock --json --workspace /tmp/ws
{ "runId": "01M1KH…", "state": "completed", "outputs": { "output": "hi" }, "costUsd": 0 }
$ node dist/cli.js trace 01M1KH… --json --workspace /tmp/ws
run-started, step-started, model-started (request: system string, 1 message, tools []), model-completed, step-completed, run-completed
$ bash scripts/docker-smoke.sh ai-workbench:ci
not run here (no Docker daemon in the build sandbox) — CI's docker job runs it
```

## SEC tests added
- SEC-01, 02, 03, 04, 05 → `tests/security/sec-01-05-floor.test.ts`
- SEC-06 → `tests/security/sec-06-redaction.test.ts` (in-process via credentials.json + `--input`; CLI via `WORKBENCH_CRED_*` + `trace --json`)
- SEC-07 → `tests/security/sec-07-child-env.test.ts` (unit half and the ESLint half through the ESLint API)
- SEC-30 → `tests/security/sec-30-csp.test.ts` (headers on HTML, API, and error responses; `dist/ui` scanned for cross-origin loads)
- SEC-31 → `tests/security/sec-31-secret-scan.test.ts` (key assembled at test time; `scripts/secret-scan.ts` exits 1 on it)

## Spec amendments made
- none

## Known gaps
- `src/runtime/api/app.ts` — `Cache-Control: no-store` applies to hashed assets too because `securityHeaders()` runs on every response; harmless now, worth a per-route override when the bundle grows.
- `src/ui/screens/Runs.tsx` — a `run-*` event refetches the whole list; fine at this scale, replace with row patches when lists get long.
- `src/runtime/engine/run.ts` — budgets are recorded on the run but not enforced (one call per run today); enforcement is RUN-04's job as the brief sequences it.
- `Dockerfile` — unverified outside CI (see Deviations).

## Notes for the next run
- `Runtime.create(...)` in `src/runtime/runtime.ts` is the one composition root; tests get a live one from `startRuntime()` in `tests/helpers/workspace.ts`, and CLI subprocesses from `runCli()` / `startCli()`.
- The engine gets its adapter fetch injected; today it is `noNetwork` (throws `NetworkPolicy`). RUN-02's egress checker replaces that single value.
- Events are redacted on write (`EventStore.append`) and again on read (API `json()` helper), so a later leak in one path is still caught by the other.
- The UI keeps the token in module state (`src/ui/lib/auth.ts`); every screen that needs data goes through `api` in `src/ui/lib/api.ts`, and SSE is fetch-based so it carries the header.
- `tests/e2e/global-setup.ts` starts one runtime with `--provider mock` and seeds a run; specs read `WB_E2E_URL`, `WB_E2E_RUN_ID`, `WB_E2E_WS`, `WB_E2E_CLI` from the environment.
- Proposed for the RUN-01 brief: `workbench dev` should run Vite's dev server with `/api` proxied to the runtime and print the tokened dev URL, so UI work does not need a rebuild per change.

## Human verification script
1. `npm ci && npm run build` on a fresh clone; expect no errors and `dist/cli.js`.
2. `node dist/cli.js init ~/wb-test`, then `node dist/cli.js start --workspace ~/wb-test`. Expect exactly one line: `http://127.0.0.1:8787/#token=…`.
3. Open that URL. Expect the Welcome path. Click *Try it with the mock*, *Run the echo agent*, *Open the trace*. Expect six events; expand *model-started* and read the compiled prompt (identity, task, harness; the user message is the input).
4. Open the same URL without the `#token=` part in a private window. Expect the *Runtime token required* screen; paste the token and expect Runs.
5. In a second terminal: `node dist/cli.js run agent echo --input "hello from the CLI" --workspace ~/wb-test`. Expect the run to appear in the Runs screen without a reload.
6. `node dist/cli.js trace <runId> --workspace ~/wb-test` and `node dist/cli.js doctor --workspace ~/wb-test`. Expect a readable timeline and all checks `ok`.
7. Press Ctrl-C in the runtime terminal. Expect `ls ~/wb-test/data` to show no `runtime.json` or `runtime.token`.
8. Phone (optional now, first-class after RUN-12): on a Mac or the VPS on your tailnet, follow `deploy.md` §3 (`tailscale serve` + `--expose <hostname>`), open the URL on the phone, and repeat step 3.
