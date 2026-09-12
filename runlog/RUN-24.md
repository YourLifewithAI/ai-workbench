# RUN-24 handoff — The pulse

**Branch:** `run/24-pulse` · **Head:** `525313f` · **Status:** awaiting verification

## Built
- `src/runtime/engine/run.ts` — `spentSinceUsd(since, agentId)` walks `runs.parent_run_id` (a recursive CTE, a run counted once however many paths reach it), seeds from the agent's runs *and* from the children its steps inside workflow runs let go, and adds the calls those steps made themselves: an agent's own daily and monthly caps now count everything it directed. `childOf` reads the live budget and takes a `detached` size (unsized: half of what is left); `reserve()` charges a let-go child's carve at dispatch; `settleChild` charges the live budget too, so the row written at finish agrees with it (before, `finish()` overwrote it). `budgets` map of live budgets; `parent.detached` on start inputs and the child `run-started` event; `work: WorkStore` wired into the tool deps; `ownCaps` handed to the workflow executor.
- `src/runtime/engine/budget.ts` — `RunBudget.charge()`; `child(override, own?)` so a workflow step's budget carries its agent's caps.
- `src/runtime/engine/workflow-run.ts` — the step's agent on its `run_steps` row; the step budget checks the agent's own caps.
- `src/runtime/db/migrations/0014_work.sql` — `work_items`, `work_runs`; `run_steps.agent_id`, `runs.parent_step_id`.
- `src/runtime/work/store.ts` — `WorkStore`: `file` (dedupe by `key` among open items: the id kept, trust only lowers, the run linked as `refreshed`), `get`, `openByKey`, `list`, `update` (an `answer` on a decision sets `decided`), `counts`.
- `src/runtime/tools/builtin/work.ts` — `work.file`, `work.list`, `work.update` (by id or by key), `owner.ask`; all `maxPermissions` nothing; trust from the run's taint.
- `src/runtime/tools/builtin/delegate.ts` — `agent.delegate` and `workflow.run` gain `wait` and `maxCostUsd`; outputs carry `detached`; a let-go child's result carries no `meta.taint`, since nothing came back.
- `src/runtime/api/app.ts` — `GET /work`, `POST /work`, `PUT /work/:id`; the dashboard's `decisions` and `work`; `AgentSummary.spend` and `.heartbeat` (`onTheCard`).
- `src/shared/api/index.ts` — `WorkItem`, `WorkKind`, `WorkState`, `WorkOption`, the three request shapes, `AgentHeartbeat`, `AgentSpend`.
- `src/shared/workflow.ts` — two D-49 refinements: a reviewer is not a link in the hand-off chain; a blocking review is a branch on its verdict.
- `src/ui/screens/Dashboard.tsx` — decision cards under *Needs you* (`decision-<id>`; the options as buttons, the lean marked, one click answers); the *Work* list; `src/ui/screens/Agents.tsx` — *Spent* and *Pulse* on the card.
- `examples/workspace/workflows/companion-pulse.workflow.json` — every two hours, seeded paused, no catch-up: facts → the open ledger → the companion acts and files `pulse/<runId>.md`. `agents/companion/instructions.md` — *the pulse*; `agent.json` and `config/workbench.json` — the four ledger tools. `fixtures/companion-pulse*.json` — a first pulse files and asks; a pulse after an answer staffs the weaver, lets it go, closes the question by key.
- `examples/workspace/workflows/coding-run.workflow.json` — `review` (the Reviewer on `role:capable`, `{ verdict, issues }` under an `outputSchema`, filed as `plan-review.json`) and `plan-check` (`when` the verdict is `revise`: a blocking review of the Mechanic's note, `onReject: read`); `implement` carries the verdict and the issues.
- Tests: `tests/security/sec-44-work-ledger.test.ts` (5), `sec-46-detached-budget.test.ts` (6: caps count descendants, workflow steps and their children, the cap fires; a let-go child with a size, and the half-remainder default through `workflow.run`); `tests/unit/work-store.test.ts` (5), `workflow.test.ts` (+1); `tests/dod/RUN-24.test.ts` (5: the pulse seeded and the card, the first pulse, the second pulse refreshes, an answer read and acted on, plan review parks the run); `tests/e2e/pulse.spec.ts` (2, `@run-24`); `tests/helpers/repo.ts` — the mock reviewer says proceed, `PLAN_REVISE` for the other path; RUN-17's step list and RUN-23's tool list updated.

## Not built (deliberate)
- `memory.curate`, `memory.facts`, `project.create`, cases from runs, the `human` evaluator, "agrees with you N of M" — RUN-25.
- A person filing a `decision` through `POST /work`: a person answers decisions; only the orchestrator asks them.
- `runs.facts` listing a let-go child "under the parent" as its own line: the child appears as a run with its `parentRunId`, which is what the facts already carry.

## Deviations from the brief
- The coding run's review step is `review`, not `review-plan`: the D-49 reviewer rule matches `steps.<id>` in a `when` by dot notation, and a hyphen would have needed bracket notation there. With it came `plan-check`, which the brief did not name: the reviewer rule (rightly) wants something to branch on a verdict, and the honest branch is the person — a blocking review before a line is written, rather than the Mechanic quietly taking or ignoring the issues.
- Two D-49 smell refinements were needed for that shape (a reviewer is not a link in the hand-off chain; a blocking review is a branch). Both are stated in `spec/workflows-and-execution.md` and proven in `tests/unit/workflow.test.ts`.
- `work.update` takes a `key` as well as an id: a pulse cannot carry ids from one run to the next, and the fixture that closes a decided question needed a name that survives.
- A let-go child without a size gets half of what the parent has left, not all of it: charging the whole remainder at dispatch would leave the parent nothing to finish its own turn with. Stated in D-76 and SEC-46.
- Own caps count an agent's steps inside workflow runs, and the children those steps let go. The brief said "walks `runs.parent_run_id`"; the pulse is a workflow, so a companion step's spend and its let-go children had to count too, or the loop would run outside the cap. `run_steps.agent_id` and `runs.parent_step_id` carry it; a workflow step's budget now checks its agent's caps.

## Verification transcript
```
$ npm run check
unit 147 · security 190 · contract 52 · route-drift clean (90) · secret-scan clean
$ npm run build && npx vitest run --project dod
22 files, 157 passed, 2 skipped (live-only)
$ WB_CHROME=/opt/pw-browsers/chromium npx playwright test --workers=1
54 passed
$ WB_CHROME=/opt/pw-browsers/chromium npm run dod -- 24
Tests 5 passed (5); @run-24 e2e 2 passed
$ WB_CHROME=/opt/pw-browsers/chromium npm run dod -- 17   # the reviewed coding run
Tests 4 passed (4); @run-17 e2e 1 passed
$ WB_CHROME=/opt/pw-browsers/chromium npm run dod -- 23
Tests 6 passed (6); @run-23 e2e 3 passed
```
The DoD suites must run against a fresh `dist/` (`npm run build` first, or `npm run dod -- NN`, which builds): RUN-11's
DoD spawns the built CLI, and a `dist/` from before migration 0014 refuses a workspace the source runtime has
migrated to 14 — which is the runtime doing its job, not a failure of the run.

## SEC tests added
- SEC-44 → `tests/security/sec-44-work-ledger.test.ts`
- SEC-46 → `tests/security/sec-46-detached-budget.test.ts`

## Spec amendments made
- `spec/decisions.md` D-75, D-76 · `spec/sec-catalog.md` SEC-44, SEC-46 · `spec/runs/README.md` (RUN-24 ahead, RUN-25 named) · `spec/runs/FINISH.md` O2 · `spec/runs/RUN-24.md`
- `spec/data-model.md` (0014) · `spec/tools-and-security.md` (the four tools; `wait`, `maxCostUsd`) · `spec/workflows-and-execution.md` ×2 (a child let go; the coding run's review) · `spec/agents-and-prompts.md` (the pulse) · `spec/api-and-cli.md` (three routes; `spend`, `heartbeat`; `detached`) · `spec/ui.md` (Dashboard decisions and work; the agent card)

## Known gaps
- The reservation is charged and never refunded. A let-go child that spends less than its carve leaves the difference on the parent's row as money committed, not spent; the caps count the actual, so nothing is lost at the day or the month, only on that run's bar.
- The heartbeat picks one schedule per agent: enabled first, then the soonest to fire. Two enabled loops on one agent show the sooner; the other is on Workflows.
- On the mock, the companion's own runs cost nothing, so *Spent* on its card reads $0.00 until a real model runs — the DoD plants a charge on a let-go child to prove the counting.

## Notes for the next run
- A pulse fixture keys on the ledger's rendered JSON (`"decided"`): the ledger step's output is stringified into the companion's task, so a fixture can match on a state word that only appears once an item is in that state.
- A fixture's `lastUserIncludes` must not share a phrase with another agent's script for the same agent: the coding run's `plan-check` task originally said "Write the note the person reads", which the hand-to-human script matches on, and the mock answered with the wrong note.
- `childOf` takes a `size` object now (`maxModelCalls`, `maxCostUsd`, `detached`); a third child kind adds its size there.
- The dashboard's `decisions` are `needs-you` decisions only; `decided` ones stay open on the ledger until the pulse marks them done, which is what "read by the next pulse" depends on.

## Human verification script
1. Workflows → The pulse → enable. Two hours later, Library → companion → `pulse/…`: what it saw, what it staffed, what it filed. Dashboard: the ledger under *Work*.
2. Dashboard → a decision card: click an option. Library, after the next pulse: the note names your choice; Dashboard: the question is gone from *Needs you* and the item it staffed is under *Work*.
3. Agents → Companion: *Spent* today against $5 and *Pulse* with the next time. Run the research briefing through the companion ("without waiting"), then Agents again: the researcher's spend is counted in the companion's.
4. Ask the companion to run the research briefing without waiting. Runs: the companion's run finished, the child still running, its budget the carve the companion gave it.
5. Workflows → Coding run on a brief: Runs → the run → `review` in the trace with a verdict; if `revise`, Review holds the run at `plan-check` with the issues before anything is built.
