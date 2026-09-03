# RUN-02 handoff — Adapters, fallback, offline mode, Privacy Inspector

**Branch:** `run/02-adapters` · **Head:** `d4f729d` · **Status:** awaiting verification

## Built
- `src/runtime/models/adapters/shared/adapter-base.ts` — the half of an `@ai-sdk` adapter that is the same for every provider: one streamed or single invocation, canonical mapping, `maxRetries: 0` so the engine keeps retry and fallback. Each provider file is now only its own three facts, and the Google adapter shrank from 110 lines to 34.
- `src/runtime/models/adapters/{anthropic,openai-compatible}/index.ts` — Claude, and any OpenAI-shaped endpoint (Ollama, OpenRouter, vLLM). The OpenAI-compatible adapter refuses to guess a `baseUrl`, and sends no key when none is configured, because local servers 401 on an empty one.
- `src/runtime/security/egress.ts` — the checker: the mode lattice, declared endpoints, label-bounded allowlist matching, blocked address classes, and a refusal of the runtime's own address in every mode. Every decision is made before a socket opens; every attempt is logged.
- `src/runtime/db/migrations/0003_egress_log.sql` — what the Privacy Inspector reads.
- `src/runtime/engine/selection.ts` — candidate selection by catalog, capability and reachability, plus `dropForeignReasoning`, which drops opaque reasoning blocks the next provider cannot read.
- `src/runtime/engine/run.ts` — retry twice on a retryable error, fall back to the next candidate otherwise, abort immediately on `action: 'abort'`; `model-aborted`, `fallback-selected` and `provider-meta-dropped` at every transition.
- `src/runtime/models/availability.ts` + `src/runtime/models/adapters/mock/upstream.ts` — availability with a reason for every model, Ollama's management API polled rather than assumed, and a loopback listener that makes the declared-endpoint path real with no cloud provider.
- `GET /models`, `POST /models/refresh`, `GET /runs/:id/privacy`, `PUT /settings/network`.
- `src/ui/screens/Models.tsx`, `src/ui/components/NetworkBanner.tsx`, `src/ui/components/PrivacyInspector.tsx` — the catalog with capabilities, pricing and data policy; a persistent network banner with a one-click switch; and a per-run tab showing where data went, what kind it was, and the redacted body.
- `tests/contract/{anthropic,openai-compatible}.contract.test.ts` + fixtures — four adapters now share one suite, 47 tests, no keys.

## Not built (deliberate)
- Scoring or named routing policies, tools, workflows, memory — the brief's *Do not*.
- DNS resolution with address pinning, redirect re-checking, and the exfiltration rule: RUN-07 owns tool egress, and doing half of it here would have looked like protection that is not there. Amended into `tools-and-security.md` so the gap is written down.
- The rest of `PUT /settings`: RUN-11.

## Deviations from the brief
- **Neither new adapter has spoken to its provider.** As with Google in RUN-01, the fixtures are hand-authored in each provider's documented wire format and validated by that SDK's own parser. `npm run contract -- --live anthropic` (or `--live openai-compatible`, which needs only a running Ollama) is what turns this into proof.
- **The Anthropic adapter originally sent `thinking: { type: 'enabled', budgetTokens: N }`, which every current Claude model rejects with a 400.** Checking the current API reference rather than trusting recall caught it; it now sends `{ type: 'adaptive', display: 'summarized' }`. A model old enough to need the fixed-budget form can still ask for it through `providerOptions.anthropic.thinking`. This one would have failed on the first real call.
- **`PUT /settings/network` was added**, which the brief did not name. `ui.md` §Global controls requires a one-click switch to offline, and a safety control that needs a config edit and a restart is not one. Narrowly scoped to the mode; amended into `api-and-cli.md`.
- **An enabled catalog entry counts as a declared endpoint** even without a `baseUrl`. Otherwise the shipped default (`allowlist` with an empty `allow`) would refuse every cloud model, and the owner would have to list a host they already allowed by enabling the model. Amended into `tools-and-security.md`.
- **`failAfterChars` added to the mock fixture schema**, because "streams partial text and *then* fails" is exactly the case DoD 2 requires and the schema could not express.
- **When the mode is what removed every candidate, the run fails with `NetworkPolicy`, not `ModelUnavailable`.** DoD 3 names that error, and "no usable model" would have hidden the actual cause.

## Verification transcript
```
$ npm run check
typecheck · lint · 17 unit · 26 security · 47 contract · secret-scan: clean — green
$ npm run dod -- 02
8 passed, then 3 e2e cases tagged @run-02 passed
$ npm run dod -- 00 / -- 01
6 passed / 7 passed
$ npm run e2e
10 passed
```

## SEC tests added
- SEC-08 → `tests/security/sec-08-offline.test.ts`: a cloud run in offline mode fails with `NetworkPolicy` and **opens no socket** (spy on `net.Socket.prototype.connect`, so "no connection" means no connection); a declared loopback endpoint still runs in `local-only`; allowlist matching is label-bounded and port-aware; private, metadata and IPv4-mapped addresses are refused even in `unrestricted`; the runtime's own address is refused in every mode; only http and https are opened.
- SEC-20 → extended in `tests/security/sec-20-model-call-headers.test.ts` (RUN-01's file): the egress log's stored body is redacted, and no fixture records a request header.

**A real bug that test found:** `::ffff:127.0.0.1` normalises to `::ffff:7f00:1` during URL parsing, and the original blocked-class check only decoded the dotted form — so a mapped loopback address would have passed as public. `mappedIpv4` now decodes both.

## Spec amendments made
- `spec/tools-and-security.md` §Egress — an enabled catalog entry is the declaration; the RUN-02 subset and what RUN-07 still owes
- `spec/api-and-cli.md` §HTTP — `PUT /settings/network`
- `spec/model-layer.md` §Mock provider — `failAfterChars`

## Known gaps
- `src/runtime/security/egress.ts` — host-literal checks only. A hostname resolving to a private address is not caught until RUN-07 adds resolution and pinning. Written into the spec so it is a scheduled gap, not a silent one.
- `src/runtime/models/availability.ts` — one poll per listing with a 1.5 s timeout and no caching between requests other than the runtime-held result; a slow endpoint makes the Models screen wait.
- `provider-meta-dropped` fires only when a request actually carries reasoning blocks, which a single-turn agent run never does yet. The logic is unit-covered through `dropForeignReasoning`; the event itself first fires for real in RUN-04's multi-step runs.
- The Privacy Inspector's `destinations` derives the host from the catalog `baseUrl` or the first egress row; once a run calls two different hosts, that needs the per-call host instead.

## Notes for the next run
- Adding an adapter is now three facts: `languageModel`, `providerOptions`, and an id. Everything else comes from `AiSdkAdapter`.
- `EngineDeps.fetch` is what the egress checker wraps, and `RuntimeOptions.fetch` threads it from outside; that is the seam RUN-07 extends with DNS pinning rather than a new one.
- `selectCandidates` is where reachability and capability filtering live; a workflow step's `model` override goes in as a single-element `ids` list.
- The mock upstream is the way to exercise anything egress-shaped in a test: give a catalog entry a `baseUrl`, and the mock makes a real loopback round trip through the checker.
- Costs under `--provider mock` still come from the requested catalog id's price rows, which is what makes RUN-04's budget tests possible.

## Human verification script
1. `npm ci && npm run build && node dist/cli.js init ~/wb-02 && node dist/cli.js start --workspace ~/wb-02`.
2. Open **Models**. Expect every model with a state and a reason: `mock/*` ready, the Gemini and Claude entries "no key", `ollama/qwen3:14b` disabled.
3. Click **Go offline** in the banner. Expect every cloud model to turn "blocked by network mode". Click **Go back online**.
4. Run the echo agent with the model override `mock/upstream`, open the run, and choose the **Privacy Inspector** tab. Expect one allowed POST to 127.0.0.1, categories `instructions, task`, and your input visible in the stored body.
5. With Ollama running: set `baseUrl` to `http://127.0.0.1:11434/v1` and `enabled: true` for `ollama/qwen3:14b` in `~/wb-02/config/models.json`, restart, press **Refresh local endpoints**, and expect "ready" with the models you have pulled listed.
6. With a Gemini or Anthropic key in `config/credentials.json` (mode 0600): run The Weaver on each in turn by changing only its `modelPolicy.primary`. Same agent file, different substrate — that is the claim this run exists to demonstrate.
7. `npm run contract -- --live anthropic` and `--live google`. These are the commands that verify the adapters against the real APIs.
