# RUN-04 handoff — Workflows v1 and the execution lifecycle

**Branch:** `run/04-workflows` · **Head:** `d0a941f` · **Status:** awaiting verification

## Built
- `src/shared/expr.ts` — the expression language: paths, literals, comparisons, `and`/`or`/`not`, `length`. A hand-written tokenizer and recursive-descent parser; there is no `eval` and no call form other than `length`, and `tests/unit/expr.test.ts` asserts that `process.exit(1)`, `constructor.constructor("return 1")()`, `require("fs")` and a backtick template are all syntax errors rather than calls.
- `src/shared/template.ts` — `{{ … }}` rendering. A whole-string placeholder passes its value through with its type; anything else interpolates, objects and arrays as JSON. `\{{` is a literal.
- `src/shared/workflow.ts` — the `.workflow.json` schema and its validator: duplicate ids, unresolvable references, implied edges from template references, cycles named by the steps in them, one level of `map` nesting, and the D-49 smells as warnings. Features later runs add (`kind: 'tool'`, `review: 'blocking'`) are refused by name and by the run that adds them.
- `src/shared/jsonschema.ts` — a small draft-2020-12 subset checker for `outputSchema`, plus `parseJsonOutput` (which unwraps a fenced reply) and `applyDefaults`. Its purpose is the *local* check: a provider that ignores a schema then fails as `SchemaValidation` instead of flowing downstream as prose. The supported keywords are listed in `UNSUPPORTED_NOTE`; anything outside the subset is ignored rather than guessed at.
- `src/runtime/engine/budget.ts` — `RunBudget`: counters, the once-per-budget 80% warning, one wrap-up turn, and `child()` for a step budget that narrows the run's without escaping it (spending counts in both).
- `src/runtime/engine/step.ts` — one agent step, shared by single-agent runs and every workflow step: candidate selection, retries per model, fallback across models, the model → tool-call → result loop, one schema repair turn, the wrap-up turn, and the document commit.
- `src/runtime/engine/workflow-run.ts` — the DAG executor: ready steps in parallel up to `execution.maxParallelSteps`, `map` at its own `concurrency` with `<id>[n]` item steps, `when`/`step-skipped`, `retries`, and first-failure-aborts-siblings via a chained `AbortController`.
- `src/runtime/engine/run.ts` — now a facade over both: run rows, workflow and agent version records, the queue that honours `maxConcurrentRuns` (`run-queued`), `cancel`, and `markInterrupted()` on startup.
- `src/runtime/db/migrations/0005_workflows.sql` — `workflow_versions`.
- `src/runtime/workspace/loader.ts` — `loadWorkflows`: a `.workflow.json` that does not parse or does not validate is listed as broken rather than thrown, so one bad file cannot stop the workspace loading. Agents and workflows reload together.
- Routes: `POST /runs` for `kind: 'workflow'`, `POST /runs/:id/cancel`, `GET /workflows`, `GET /workflows/:id`.
- CLI: `run workflow` (`--inputs-file`, repeatable `--input k=value`, `--detach`, budget narrowing) and `runs cancel`.
- `src/ui/screens/Workflows.tsx`, `components/RunGraph.tsx`, `components/BudgetBar.tsx` — the Workflows screen, an SVG graph with an `sr-only` list carrying the same facts, a run form generated from the workflow's `inputs` schema, Cancel on Runs and on the timeline, and budget bars in both places.
- `examples/workspace/agents/judge/`, `workflows/story-pipeline.workflow.json`, `workflows/ensemble-draft.workflow.json`, and fixtures keyed by model id so the mock run really exercises the per-step model override.

## Not built (deliberate)
- Review gates, the scheduler, resume, tools, delegate, and conditionals beyond `when` — the brief's *Do not*. `review: 'blocking'` and `kind: 'tool'` are refused by the validator with the run that adds them.
- Context discipline (D-47: truncating and masking tool results) — there are no tool results yet to truncate. It belongs with RUN-06, where tools produce them.

## Deviations from the brief
- **`output: { document: null }` was added to the step schema.** A `map`'s parallel items all resolve to the same agent-default document path and overwrite each other; without a way to say "this output is intermediate", the ensemble files three versions of one document instead of three drafts. Amended into `workflows-and-execution.md`.
- **`runId` and `agentId` are template roots.** An `output.document` written in a workflow should read the same as one written in an agent, and agents already use `{{runId}}`. Amended.
- **The wrap-up turn is held back from `maxModelCalls` rather than added past it.** A budget of six means five productive calls and a sixth that summarises. Cost cannot be reserved the same way; the amendment says so.
- **`RunSummary` carries `budgets`.** The budget bar on the Runs list needs a denominator, and a second request per row to get it would be worse. Amended into `api-and-cli.md`.
- **Workflow responses report *effective* edges**, not just declared `dependsOn`. The story pipeline declares no dependencies at all — its order comes entirely from template references — so a graph drawn from the declared set showed three independent steps. Amended.
- **Workflow inputs are validated and defaulted against the workflow's own `inputs` schema** at run start. The spec says the run form is generated from `inputs` and that `inputs.*` is "the run's validated input"; this is what makes both true, and it is what lets `ensemble-draft` ship a default list of model ids.

## Verification transcript
```
$ npm run check
typecheck · lint · 52 unit · 34 security · 47 contract · secret-scan: clean — green
$ npm run dod -- 04
6 passed, 1 skipped (live), then 3 e2e cases tagged @run-04 passed
$ npm run dod -- 00 / 01 / 02 / 03
6 / 7 / 8 / 7 passed, all tagged e2e passed
$ npm run e2e
17 passed
$ node dist/cli.js run workflow story-pipeline --inputs-file premise.json --provider mock
beats  completed  google/gemini-2.5-pro
draft  completed  google/gemini-2.5-pro
final  completed  google/gemini-2.5-flash
→ beats.md, draft.md, final.md in anthology, each linked to its step
$ node dist/cli.js run workflow ensemble-draft --input premise="…" --provider mock
drafts[0..2] on three different model ids, concurrently; verdict validated against its schema
```

## SEC tests added
- SEC-28a → `tests/security/sec-28-29-budgets-cancel.test.ts`: model calls, cost, wall clock and the daily cap each end a run, and the count never exceeds the budget. The wall clock and the daily cap take no wrap-up turn.
- SEC-29 → same file: a run whose provider never answers is cancelled, and the test asserts that the `AbortSignal` the adapter handed `fetch` actually fires — not merely that the loop around the call stopped.

## Bugs found by the tests
- `document_versions.partial` was a hard-coded `0` in the INSERT, so a wrap-up summary would have been filed as if it were finished work. The column had existed since RUN-03 with nothing to write a 1 to it.
- The mock adapter's declared-endpoint round trip never passed the run's abort signal to `fetch`, so a cancel stopped the loop but left the connection running. That is exactly what SEC-29 is about.
- `startAgentRun` stopped passing `modelOverride` through during the engine refactor; the RUN-02 Privacy Inspector e2e caught it.
- The RUN-01 DoD hard-coded four agent ids and the architect's two instruction sections. RUN-03 moved `## world` into a project document, so it failed for a reason unrelated to what RUN-01 promised. It now reads both from the example workspace.

## Spec amendments made
- `spec/workflows-and-execution.md` — `output.document: null`; the `runId`/`agentId` roots; the wrap-up turn held back from `maxModelCalls`, and one `budget-warning` per budget
- `spec/api-and-cli.md` — the workflow and cancel routes, `RunSummary.budgets`, `StepSummary.parentStepId`/`mapIndex`, effective edges, and the two CLI commands
- `spec/data-model.md` — `document_versions.partial` is now written

## For the next run (RUN-05: scheduling, the dashboard, the review queue)
- The validator already refuses `review: 'blocking'` and `schedule` by name. Both messages say "RUN-05"; change them there.
- `run-queued` is emitted and `maxConcurrentRuns` is honoured, but nothing surfaces the queue yet — the Dashboard is where it belongs.
- `markInterrupted()` marks runs on startup; the resume command that acts on them is RUN-05's.
- `RunBudget.child()` exists for step budgets and is unexercised by the shipped examples; a scheduled run with a tighter budget than the workspace's is the natural first user.
- `WorkflowExecutor.documentsProxy` reads `project.documents["path"]` lazily. Nothing in the shipped workflows uses it yet; the briefing workflow in RUN-07 will.

## Still outstanding for the owner
No cloud adapter has yet spoken to its provider. `npm run contract -- --live google` (and `--live anthropic`) will verify them against the real APIs, and `WB_LIVE=1 npm run dod -- 04` will run the story pipeline on Gemini — both need a credential in the workspace or in the environment.

## Human verification script
1. `npm run build && node dist/cli.js init ~/wb-04 && node dist/cli.js start --workspace ~/wb-04`.
2. Open **Workflows**. Expect `story-pipeline` and `ensemble-draft`, each drawn as a graph. Tab through the
   graph with the keyboard only: every step should be reachable and announced, because the picture has a text
   alternative carrying the same facts rather than a caption.
3. Run `story-pipeline`. The form is generated from the workflow's own `inputs` — you did not write it. Fill it
   in and run. Expect the graph to fill in step by step, not all at the end.
4. While it runs, watch the budget bar. Then press **Cancel**. Expect the run to stop, the graph to stop
   advancing, and the run to end `cancelled` rather than `failed`.
5. Run `ensemble-draft`. It is a `map`: expect several `<id>[n]` item steps side by side, up to the workflow's
   own concurrency, and one downstream step that waits for all of them.
6. Open a completed run's trace. Find a step whose agent named a different model, and confirm the trace names
   that model rather than the run's default — the per-step override is real, not decoration.
7. Break a workflow on purpose: open `~/wb-04/workflows/story-pipeline.workflow.json`, point one step's
   reference at a step id that does not exist, and reload the Workflows screen. Expect the file listed as
   broken with the reason, the *other* workflow still listed and runnable, and the runtime still up. One bad
   file must not take the workspace down.
8. Undo that, then introduce a cycle (two steps referencing each other). Expect the error to name the steps in
   the cycle, not just "invalid workflow".
