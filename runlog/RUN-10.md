# RUN-10 handoff — Evaluation and compare

**Branch:** `run/10-evaluate` · **Head:** _(filled at push)_ · **Status:** awaiting verification

## Built
- `src/runtime/db/migrations/0011_evaluation.sql` — `datasets`, `cases`, `experiments`, `experiment_runs`, `scores`, and `ratings.model_id`.
- `src/runtime/evaluation/evaluators.ts` — `exact`, `schema` and `rule` decided locally with no model at all; `model-judge` and `grounded` decided by a model and labelled `estimate` on every path out. `passAtK()` is the arithmetic the table reports: a mean and pass^k are different claims and both are shown (D-52). There is no hallucination metric, and the file says why.
- `src/runtime/evaluation/store.ts` — a dataset version freezes the moment an experiment references it, so a result always names the cases it actually ran on.
- `src/runtime/evaluation/runner.ts` — an experiment is a grid of ordinary runs: every trial has a trace, a cost and a privacy record. Trials are sequential so the cost cap can actually stop it, and the cap is checked *before* each trial rather than after.
- `StepRunner.callOnce()` — one model call outside a step, which is what a judge is. Same adapter, same credential lookup, same egress checker; no `model_calls` row and no events, because a judge's opinion belongs to the score rather than to the run it is scoring.
- Compare: one agent, one input, N models, side by side with output, latency, tokens and stored cost. The pick writes a rating on *every* pane sharing a `compare_id` and carrying the model id, which is what makes it preference data rather than a star (D-50).
- Routes: `GET/POST /datasets`, `/datasets/:id/cases`, `/datasets/:id/export`, `/datasets/import`, `GET/POST /experiments`, `/experiments/:id/results`, `/experiments/:id/cancel`, `POST /compare`, `POST /compare/pick`. CLI: `workbench datasets list|create|export`, `workbench experiments run|results`, `workbench compare`.
- `src/ui/screens/Evaluate.tsx` — Compare first, then datasets, then experiments with a results table that shows pass^k beside every mean and the word "estimate" wherever a judge produced the number.
- promptfoo-compatible export and import. An assertion type this workbench has no evaluator for is kept in metadata rather than dropped: someone importing another suite should see what it asked for even where we cannot run it.

## Not built (deliberate)
- A hallucination metric — the brief's *Do not*, and it needs ground truth the system does not have.
- Any path from a score to model selection. A SEC case greps `models/catalog.ts` for the words: if a score ever became an input to selection, someone would have to delete that assertion to do it (D-06).
- A chart. The case × model grid with pass^k beside every mean is already the shape the eye reads; a chart over ten numbers is decoration. Amended.
- Workflow targets for experiments. The route refuses by name rather than half-working.

## Deviations from the brief
- **A case carries an explicit `ordinal`.** Two cases added in the same millisecond have ULIDs that do not sort against each other, and "case 1" in a results table has to mean the first one. This is the third time this class of bug has appeared (approvals in RUN-12, batched calls, now cases). Amended.
- **A Compare pick stores the model id on every rating.** A preference pair without the names of both sides is not usable as preference data. Amended.
- **The results table is the chart.** Amended.

## Verification transcript
```
$ npm run check
typecheck · lint · unit · security · contract · secret-scan — green
$ npm run dod -- 10
6 passed, then the e2e case tagged @run-10 passed
$ npx vitest run --project dod
every suite, 00 through 12 — green
$ npm run e2e
green, axe clean on every screen
```

## SEC tests added
`tests/security/sec-06-28-evaluation.test.ts`, 4 cases:
- **SEC-06** a dataset export redacts every value — in the input, in the reference and in the metadata, three places rather than the obvious one — and the route redacts too, not just the function.
- **SEC-28c** an experiment stops at its cost budget: 10 cases × 2 models × 3 trials is sixty runs, and the cap ended it well before that, with `budget_exceeded` and what it had spent.
- **D-06** the model-selection code contains no reference to a score, a rating, an evaluation or an experiment.

## Bugs found by the tests
- **`parseJsonOutput` returns `{ ok, value }`, not the value.** Both the `exact` and `schema` evaluators treated the wrapper as the parsed JSON, so a valid object scored zero. This is the kind of thing a type would have caught if the function returned a union rather than a shape.
- **Case order was luck.** Fixed with an ordinal, as above.
- **The model checkboxes on the Evaluate screen were 16px.** WCAG 2.2 wants 24; a checkbox a thumb misses is a checkbox nobody uses.

## Spec amendments made
- `spec/evaluation.md` — the case ordinal, the model id on a pick, and the table standing in for the chart

## For the next run (RUN-11: packaging and the rest of Settings)
- The Settings screen is still read-only: RUN-11 owns the credentials editor, the MCP server configuration, and "show the welcome path again".
- Plugins (D-32) are the other half: `plugins/<name>/plugin.json`, the "this code runs with full access" confirmation, and pinned versions with postinstall refused.
- Everything an evaluator plugin would need already exists — `EvaluatorSpec` is a discriminated union, and adding a member is the whole of it.

## Still outstanding for the owner
- The same two: no cloud adapter has spoken to its provider, and the phone has only been seen at an iPhone viewport in Chromium.
- The human script for this run: compare the Synthesizer step of yesterday's briefing across three models, pick the best, then run a five-case experiment and read the table.
