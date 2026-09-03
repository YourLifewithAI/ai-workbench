# RUN-04 — Workflows v1 and the execution lifecycle

**Goal.** The story pipeline runs unattended end to end as a workflow with a different model per step, bounded and cancellable. Agent Hub parity, plus persistence, plus everything Agent Hub never had.

**Reads.** `workflows-and-execution.md`, `agent-runtime-contract.md`, `api-and-cli.md`, `data-model.md` (run_steps, event payloads), `ui.md` (Workflows, Runs), `runlog/RUN-03.md`.

**Scope.**
- `src/shared/workflow.ts`: the schema, the `Template` and `Expr` parsers (no `eval`), the validator (DAG, implied edges, cycles, references, one level of `map` nesting). The validator refuses `kind: 'tool'`, `review: 'blocking'`, and `schedule` with a message naming the run that adds them (06, 05, 05).
- `workflow_versions` rows; the DAG executor: parallel independent steps up to `execution.maxParallelSteps`, `map` with `concurrency`, `when`/`step-skipped`, first failure aborts siblings, `retries`, `outputSchema` validation; `run_steps` populated per step and per map item; nested trace; `steps.<id>.output` addressing; `output.document` into the run's project; `defaultProject`.
- The agent step loop (model → tool calls → results → model) with `UnknownTool` results, in place even though the tool list is empty.
- Run states incl. `queued` and `interrupted` on startup; budgets with the once-per-budget 80% warning and the wrap-up turn (output committed as `partial`); daily cap with `daily_cap_reached`; cancel via `AbortSignal` across all running steps.
- The harness prompt section per `agent-runtime-contract.md` (workflow position, budget, scratch dir), placed last in the system string with the stable prefix first (D-46); tool specs serialized deterministically.
- Validator smell warnings (D-49) surfaced in the Workflows screen, never blocking.
- `examples/workspace/agents/judge/` (`outputSchema: { winner, rationale }`), `workflows/story-pipeline.workflow.json` (Architect → Weaver → Cutter, Cutter on a flash-class Gemini id, `defaultProject: anthology`), `workflows/ensemble-draft.workflow.json` (`map` over three model ids into Weaver, then judge); fixtures keyed by model id so the mock run exercises the overrides.
- Workflows screen: list with version hash, run form generated from `inputs` with a project selector, live DAG graph; Cancel button and budget bar on the Runs list and timeline. CLI `run workflow` (blocking and `--detach`), `runs cancel`.

**Do not.** Add review gates, scheduler, resume, tools, delegate, or conditionals beyond `when`.

**Definition of done** (`npm run dod -- 04`).
1. `workbench run workflow story-pipeline --inputs-file premise.json --provider mock --json` completes with three document versions (`beats.md`, `draft.md`, `final.md`) in `anthology`, each linked to its step; the trace shows a different model id per step.
2. `ensemble-draft` runs three map items concurrently (overlapping `model-started` timestamps under fixture latency); the judge step's input contains all three drafts as a JSON array; the judge's output validates against its schema.
3. A fixture that answers every call with a tool call to a nonexistent tool hits `maxModelCalls` (set to 6 by a run override): `budget-warning` once, one wrap-up call whose harness block contains the wrap-up instruction, a `partial` document version, then `run-failed { reason: 'budget_exceeded' }`.
4. With a runtime running, `workbench run workflow … --detach` then `workbench runs cancel <id>` mid-stream → `run-cancelled`; the mock's call log stops growing; no document version from the interrupted step exists.
5. A `when: "length(inputs.premise) > 10000"` step is skipped with `step-skipped` and its dependent runs with a `null` input.
6. Live (`WB_LIVE=1`): the same workflow on Gemini produces a story draft (skips with a reason otherwise).
7. e2e watches the graph update step by step and cancels a run from the Runs screen.

**SEC.** 28a (model calls, cost, and wall clock each stop a run), 29.

**Human verification.** Run the story pipeline from the UI on real models with the Cutter on a cheap model; watch the graph; cancel one mid-run; read the three versions in the Library.
