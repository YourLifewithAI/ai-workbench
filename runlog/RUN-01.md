# RUN-01 handoff — Gemini, workspace agents, trace viewer

**Branch:** `run/01-gemini` · **Head:** `345b371` · **Status:** awaiting verification

## Built
- `src/runtime/models/adapters/google/{index,map}.ts` — the Gemini adapter over `@ai-sdk/google`: single invocations only (never the SDK's tool loop), `maxRetries: 0` so the engine keeps ownership of retry and fallback, the injected `fetch` and `apiKey` and nothing else, reasoning captured as `opaque` blocks with `providerId`, and HTTP status mapped to the canonical error codes.
- `src/runtime/models/fetch.ts` — the single seam a model call reaches the network through. RUN-02 replaces `directFetch`'s body with the egress checker and nothing else moves.
- `src/runtime/engine/run.ts` — the engine streams. Tokens go out as transient deltas; the stored record is still one `model-completed` payload. `EngineDeps.fetch` is injectable (tests replay through it; RUN-02 passes the checker).
- `src/runtime/engine/events.ts` — `emitDelta` / `subscribeDeltas`: a live-only channel that never touches the `events` table.
- `src/runtime/db/migrations/0002_agent_versions.sql` + `Engine.recordAgentVersion` — the hash a model call names now resolves to the definition that produced it, so a trace stays readable after the file changes.
- `src/runtime/api/app.ts` — `GET /agents`, `GET /agents/:id`, `POST /agents/reload`; `GET /runs/:id/events` also carries `model-delta` frames, deliberately without an SSE `id`.
- `src/runtime/cli/commands/dev.ts` — `workbench dev`: picks Vite's port first, tells the runtime to accept that origin, starts both, prints one tokened URL.
- `src/shared/summary.ts` — the summary layer (D-58) as a pure function, so the UI and the CLI can say the same thing.
- `src/ui/screens/Agents.tsx` — list with policy and version hash, load errors as cards with the file and the fix, detail with the instruction sections, and a run form with a model override and a mock toggle.
- `src/ui/screens/RunDetail.tsx` — summary card, then steps, then each step's model calls with the compiled prompt, response, usage and cost, then the raw timeline. Live streaming text while a step is open.
- `src/ui/screens/Welcome.tsx` — the provider-key step, with the 0600 file and what the runtime does with it.
- `tests/contract/**` — one suite over every adapter, an HTTP record/replay seam, and the Google fixtures.
- `examples/workspace/agents/{architect,weaver,cutter}/` — the three Agent Hub agents as declarative files, each with the world bible as its last instruction section, and mock fixtures so they are demonstrable with no key.

## Not built (deliberate)
- Fallback between candidates: the brief says RUN-02. The engine still picks the first usable candidate and stops.
- Other adapters, tools, workflows, memory, offline mode, a Models screen — all named in the brief's *Do not*.
- Explicit prompt caching. Gemini caches implicitly and reports `cachedContentTokenCount`, which the adapter normalizes into `usage.cachedInput`; an explicit breakpoint needs the separate cachedContents API and belongs with RUN-02's cost work.

## Deviations from the brief
- **The Google adapter has never spoken to Google.** No credential exists in this environment, so the recorded fixtures are hand-authored in Gemini's documented v1beta wire format. They are not guesses in the weakest sense — the SDK's own parser validates them, and a wrong shape fails loudly — but only `npm run contract -- --live google` proves the real API agrees. That command re-records and must stay green; treat the adapter as unverified against production until someone runs it. This is the single largest known risk in the run.
- **Streamed tokens are not events.** The brief implies the UI can watch text stream; the event list in `data-model.md` has no delta type. Rather than invent one and write a row per token, deltas ride the live bus only. Amended in `data-model.md` and `api-and-cli.md`.
- **`chunkDelayMs` added to the mock's fixture schema**, so streaming is demonstrable and assertable with no key. Amended in `model-layer.md`.
- **`scripts/dod.ts` now also runs the e2e cases tagged `@run-nn`**, which `api-and-cli.md` §Gates always specified and RUN-00 did not implement.
- **`FetchLike` widened** to accept `Request`, which every real fetch does and the SDK's type requires.
- Two RUN-00 e2e assertions and one RUN-00 DoD assertion were updated where RUN-01 legitimately moved the thing they pointed at (the compiled prompt now sits under the step's model call; a fresh database now applies two migrations, asserted against the directory rather than a literal).

## Verification transcript
```
$ npm run check
typecheck · lint · 17 unit · 19 security · 27 contract · secret-scan: clean — green
$ npm run dod -- 01
7 passed, then 3 e2e cases tagged @run-01 passed
$ npm run dod -- 00
6 passed
$ npm run e2e
7 passed
$ node dist/cli.js run agent architect --input "…" --provider mock --json
{ state: "completed", costUsd: 0.003125 } — model_calls carries prompt_version and agent_version; agent_versions resolves it
```

## SEC tests added
- SEC-06 re-verified through the real adapter path → `tests/security/sec-20-model-call-headers.test.ts` (a planted credential in both `credentials.json` and the task input, run through the Google adapter on a replayed fixture)
- SEC-20 (early partial) → same file: `x-goog-api-key` is sent as a header, and appears in no event payload, no `model_calls` row, no trace, no log, and no recorded fixture
- SEC-07 (adapter half) → `tests/security/sec-07-child-env.test.ts`: lint rejects `process.env` and global `fetch` inside `models/adapters/`, and no adapter source contains either

## Spec amendments made
- `spec/data-model.md` §Rules — streamed tokens are shown, not stored, and why
- `spec/api-and-cli.md` §HTTP — the `model-delta` frame and its missing `id`
- `spec/model-layer.md` §Mock provider — `chunkDelayMs`

## Known gaps
- `src/runtime/models/adapters/google/map.ts` — `toModelMessages` maps images and files but no run produces them yet, so those branches are typed and unexercised.
- `src/runtime/engine/run.ts` — still one candidate, one attempt: `modelPolicy.fallbacks` is read for the candidate list but a failure ends the run rather than moving on (RUN-02).
- The contract suite's structured-output case asserts JSON comes back; it does not yet exercise the engine's own validation and repair turn, which has no home until an agent declares `output.kind: 'json'`.
- `workbench dev` is verified by hand, not by a test: it spawns Vite, which does not belong in the gate's runtime.

## Notes for the next run
- The egress checker replaces `directFetch` in `src/runtime/models/fetch.ts`, and reaches the engine through `EngineDeps.fetch`, which `Runtime.create` already threads from `RuntimeOptions.fetch`. Nothing else needs to change to put every model call behind it.
- `tests/contract/recorder.ts` is the pattern for any adapter RUN-02 adds: record once with `--live`, commit the exchange, and the suite covers that adapter in CI forever. Recorded fixtures pin the request that produced them, so a prompt-assembly change fails loudly instead of replaying a stale answer; hand-authored ones carry `requestHash: "authored"` and skip that check.
- `summarizeRun` takes an optional display name because the agent id reads badly in a sentence; the UI passes it from the cached agents query.
- Cost under `--provider mock` still comes from the *requested* catalog id's price rows, which is what makes budget tests possible before any real provider exists.

## Human verification script
1. `npm ci && npm run build`, then `node dist/cli.js init ~/wb-01 && node dist/cli.js start --workspace ~/wb-01`.
2. Open the printed URL, go to **Agents**. Expect four agents with their model policy and a version hash.
3. Open **The Architect**, read its instruction sections, put a premise in the task box, leave *Use the mock provider* ticked, and run it.
4. On the run page: read the three-line summary, then expand the model call and read the compiled prompt — identity, task, world, harness, and your premise as the user message.
5. Run **Echo** with the task `please be slow` and watch the text arrive in chunks before the output replaces it.
6. Edit `~/wb-01/agents/architect/instructions.md`, press **Reload from disk**, and confirm the version hash changed. Run it again and confirm the trace's `promptVersion` moved too.
7. With a Gemini key: put it in `~/wb-01/config/credentials.json` as `{ "google": { "apiKey": "…" } }`, `chmod 600`, restart, untick the mock, and run The Architect for real. Then `npm run contract -- --live google` and confirm it is green — that is the step that verifies the adapter against the real API.
