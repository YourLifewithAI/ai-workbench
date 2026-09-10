# RUN-23 handoff — The companion promoted

**Branch:** `run/23-companion` · **Head:** `cb19d6a` · **Status:** awaiting verification

## Built
- `src/runtime/engine/run.ts` — `delegateHost` returns the child's taint on `ToolResult.meta` (SEC-43); `agent.delegate` gains `project`; `workflow.run` host; the child rules in one place (`childOf`, `childProject`, `settleChild`); `orchestratorHost` (facts, agent, rate); `runFacts()`.
- `src/runtime/tools/executor.ts` — honours `meta.taint` from any tool, so a tool that runs something on a run's behalf reports what it read without an entry in the static sets.
- `src/runtime/engine/step.ts` — `scopesFor(…, declared)`: the agent's own `memory.read` / `memory.write` as a third narrowing layer (it was dead code); `profileFor()`, the owner's page, twin of `goalsFor()`.
- `src/runtime/tools/builtin/memory.ts` — reads narrow by `memory.read`, writes by `memory.write`; a refusal names the layer that refused.
- `src/runtime/orchestrator/facts.ts` — `gatherRunFacts`, `runCandidates` (`failing:`, `unrated:`, `costlier:`, `fallback:`, `partial:`), `runFactsBrief`, `agentFactsOf`. Ids, numbers, the D-58 lines; never a task, an output, a document or an argument.
- `src/runtime/tools/builtin/orchestrator.ts` — `runs.facts`, `agents.read` (read, admit nothing), `runs.rate` (one `scores` row under `orchestrator`, `estimate: 1`, never `ratings`).
- `src/runtime/tools/builtin/delegate.ts` — `agent.delegate { project? }`; `workflow.run { workflow, inputs, project?, maxModelCalls? }`.
- `src/runtime/tools/builtin/artifacts.ts`, `src/runtime/artifacts/store.ts` — `artifact.read` of a version written by an external-tainted run marks the reader external (`versionProvenance`); `approveDocument` (a human version of the same words — saving identical text through PUT is a no-op by design).
- `src/runtime/engine/prompt.ts` — the `profile` section before `goals`; `promptVersion` covers a trusted page and trusted goals (amending RUN-18); a fenced one is data and stays outside.
- `src/shared/workspace.ts`, `defaults/workbench.json` — `owner: { profile, maxChars }`; `src/shared/events.ts` — `profile-missing`, `profile-fenced`.
- `src/runtime/review/store.ts`, `src/shared/api/index.ts`, `src/runtime/api/app.ts` — `Estimate`, `ReviewItem.estimates`, `GET /runs/:id/ratings`, `POST /documents/:id/approve`, `owner` on `GET`/`PUT /settings`.
- `src/ui/screens/Review.tsx`, `RunDetail.tsx` — the estimate beside the rating, labelled; `Settings.tsx` — *Your page*; `Library.tsx` — "A run wrote this version" and *Approve as written*.
- `examples/workspace/agents/companion/` — promoted: ten tools requested and granted, caps $0.50 / $5 / $40, five new instruction sections; the companion project's ceiling and goals gone; `workflows/companion-board.workflow.json` daily, seeded paused; `fixtures/companion-board.json`.
- Tests: `tests/security/sec-41-owner-page.test.ts`, `sec-42-orchestrator-facts.test.ts`, `sec-43-delegation-taint.test.ts` (with the workflow-child and the tainted-output cases), `sec-38b-delegate-project.test.ts`, SEC-16 cases in `sec-14-16-memory.test.ts`; `tests/unit/prompt.test.ts`, `companion.test.ts`; `tests/dod/RUN-23.test.ts` (6); `tests/e2e/companion.spec.ts` (3, `@run-23`).

## Not built (deliberate)
- `agent.edit` — RUN-21, where the versioned save and `agent_versions` reader live.
- `memory.curate`, `memory.facts`, `project.create`, cases-from-runs, the `human` evaluator, "agrees with you N of M" — RUN-24.
- A picker over existing documents for the page: v1 is a `project/path` field that refuses a project that does not exist.

## Deviations from the brief
- *Approve as written* is `POST /documents/:id/approve`, not a PUT of the same text: the store treats an identical body as a no-op (right for a re-run that changed nothing), so approving had to be its own act — a human version of the same words.
- The memory refusal names the layer that refused (the project's list or the agent's declaration) rather than both: step 2's combined message broke a RUN-18 DoD assertion the check gate never runs.
- The tainted-output control in SEC-43 runs *before* the tainted case: once an untrusted item exists in the reader's memory, retrieval carries it into the next prompt and taints that run by the memory rule — correct, and not what the case is about.
- D-12's "permissions ⊆ parent" is amended to what the code has always enforced: the child's own grant under the project's ceiling.

## Verification transcript
```
$ npm run check
unit 141 · security 179 · contract 52 · route-drift clean (87) · secret-scan clean
$ npx vitest run --project dod
20 files, 146 passed, 2 skipped (live-only)
$ npm run dod -- 23
Tests 6 passed (6); @run-23 e2e 3 passed
$ WB_CHROME=/opt/pw-browsers/chromium npx playwright test --workers=1
52 passed (2.7m)
```

## SEC tests added
- SEC-41 → `tests/security/sec-41-owner-page.test.ts`
- SEC-42 → `tests/security/sec-42-orchestrator-facts.test.ts`
- SEC-43 → `tests/security/sec-43-delegation-taint.test.ts`; SEC-38 (RUN-23) → `sec-38b-delegate-project.test.ts`; SEC-16 (RUN-23) → cases in `sec-14-16-memory.test.ts`

## Spec amendments made
- `spec/decisions.md` D-73, D-74; D-12 amendment · `spec/sec-catalog.md` SEC-41, 42, 43 · `spec/runs/README.md` the order · `spec/runs/RUN-23.md`
- `spec/artifacts-and-memory.md` §Memory ×3 (declaration, taint up, outputs) · `spec/agents-and-prompts.md` (declaration, sections + promptVersion, the companion) · `spec/tools-and-security.md` (four tools, the `artifact.read` rule) · `spec/evaluation.md` (the `orchestrator` evaluator) · `spec/ui.md` ×2 · `spec/api-and-cli.md` (three routes) · `spec/architecture.md` (`owner`) · `spec/data-model.md` (two events)

## Known gaps
- `src/runtime/orchestrator/facts.ts` — `runs.facts` loads each run's events for the summary lines; at the 100-run ceiling that is 100 event lists. Fine on a workspace this size; index it if the board ever feels slow.
- `src/runtime/engine/step.ts` `profileFor` — a page that does not exist is an event on every run of every agent until the setting is cleared or the page written. Loud on purpose.
- The `costlier:` candidate needs three completed runs of the same subject with a non-zero median; on the mock every run costs $0, so it never fires there.

## Notes for the next run
- Every child run — a delegated agent or a workflow — goes through `childOf` → `startXRun({ parent })` → `settleChild`. Add a third kind there, not beside it.
- Any tool that runs something on a run's behalf reports on `meta.taint`; the executor merges it. That is the channel for `agent.edit`'s trust derivation in RUN-21.
- The companion's fixtures match on `lastUserIncludes` for scripted flows and `afterTool` for the turn after; `companion-remember.json` matches *any* first Companion call, so a scripted fixture must sort before it (`a…` / `b…`).
- `promptVersion` now moves when the page or a project's goals change. A test that compares versions across runs must hold both still.

## Human verification script
1. Agents → Companion, project `companion`, mock unticked. Ask it to look at the last ten runs and say what it thinks. Open its run: `runs.facts` in the trace, its reasoning in the reply, and — the first thing this run has to be right about — `external_tainted` still 0 on its row (Privacy Inspector shows no external read).
2. Rate three runs it flagged as unrated; ask it to rate the same three. Runs → each run: your rating and its estimate side by side. Do you agree with its numbers?
3. Tell it one thing you never want done. New conversation: it knows (Memory → `user` scope has the item).
4. Ask it to draft your page. Library → companion → `about.md`: "A run wrote this version" — read it, *Approve as written*. Run any other agent: `## profile` in its compiled prompt carries your page.
5. Ask it to run the research briefing on a topic. Runs: the child under its budget, depth 1, and the companion's row now external-tainted (it read what the researcher found).
6. Workflows → The board → enable. Tomorrow, Library → companion → `board/…`.
